//! The file layer: a root directory served over `zero-http`'s handler ABI.
//!
//! Every request path goes through the policy of RFC 9110 Section 17.3 segment by
//! segment: the path is normalized (dot segments removed, unreserved octets
//! decoded), the remaining percent-escapes are decoded strictly, and a segment
//! that is empty, `.` or `..`, or that holds a separator, a NUL or a control
//! character, or on Windows a colon (an alternate data stream) or a tilde followed
//! by a digit (an 8.3 short name), makes the request a miss, as does a segment
//! that begins with a dot unless [`Options::dotfiles`] is [`Dotfiles::Allow`],
//! or [`Dotfiles::Deny`], which answers it with 403. The file is then opened
//! without following a symbolic link in its final component (`O_NOFOLLOW` on
//! Unix), its resolved path is compared against the resolved root, and on Unix
//! the opened file's identity is compared with the resolved path's, so a link
//! swapped in between the two cannot hand out a file from outside the root. A
//! path that names no file is tried again with each of [`Options::extensions`].
//!
//! [`Files::serve_path`] answers a miss with 404; [`Files::try_serve_path`]
//! writes nothing for one and returns [`Served::Miss`], so a host can fall
//! through to its next route. [`Files::try_serve_path_keeping_status`] serves a
//! file under the status an earlier layer set, such as a host's own 404 page, and
//! evaluates the preconditions and `Range` only where that status lets them apply
//! (RFC 9110 Sections 13.2.1 and 14.2).
//!
//! A file no larger than [`Options::small_file_limit`] stays in a per-core cache
//! with its validators and its prebuilt field values, revalidated by one `stat`
//! per hit; the cache holds at most [`Options::cache_budget`] bytes.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use zero_core::Error;
use zero_date::imf_fixdate;
use zero_http::{Call, Response};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_uri::{normalize_path, percent_decode};

use crate::cond::{evaluate, EntityTag, Outcome, Preconditions, Validators};
use crate::headers::{last_modified_for, write_attachment, CachePolicy};
use crate::range::{
    resolve, write_content_range, write_multipart, write_unsatisfied_range, Ranges,
};

/// The media type of a file whose extension names none.
const OCTET_STREAM: &str = "application/octet-stream";

/// How a request path with a segment that begins with `.`, such as `.env`,
/// `.git/config` or `/.well-known/`, is answered.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Dotfiles {
    /// As a miss, whether or not the file exists: [`Files::serve_path`] answers
    /// 404 and [`Files::try_serve_path`] returns [`Served::Miss`], so a host can
    /// fall through to its next route.
    #[default]
    Ignore,
    /// With `403 Forbidden` and no content, whether or not the file exists. RFC
    /// 9110 Section 15.5.4 lets an origin server that wishes to "hide" the
    /// existence of a forbidden target resource answer 404 instead, which is
    /// why [`Dotfiles::Ignore`] is the default.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4>
    Deny,
    /// Served like any other path, as a root that serves `/.well-known/` (RFC
    /// 8615) needs.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc8615.html#section-3>
    Allow,
}

/// How a root is served.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    /// The file served for a directory path, such as `index.html`; `None` answers a
    /// directory with 404.
    pub index: Option<String>,
    /// The `Cache-Control` of every response.
    pub cache: CachePolicy,
    /// Whether byte ranges are honored and advertised.
    pub ranges: bool,
    /// Whether responses carry `Content-Disposition: attachment` with the file's
    /// name, for a download route.
    pub attachment: bool,
    /// The largest file the per-core cache keeps, in bytes.
    pub small_file_limit: usize,
    /// How many bytes of files the per-core cache holds at most.
    pub cache_budget: usize,
    /// How a path segment that begins with `.`, such as `.env` or `.git`, is
    /// answered; [`Dotfiles::Ignore`] by default.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
    pub dotfiles: Dotfiles,
    /// The extensions tried in order, such as `html`, when a path that does not
    /// end in `/` names no file: with `html`, `/about` serves `about.html`. An
    /// entry may begin with `.`, which is dropped. Each candidate goes through
    /// the same path policy and root checks as the path itself. Empty by default.
    pub extensions: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            index: Some("index.html".to_owned()),
            cache: CachePolicy::default(),
            ranges: true,
            attachment: false,
            small_file_limit: 256 * 1024,
            cache_budget: 8 * 1024 * 1024,
            dotfiles: Dotfiles::Ignore,
            extensions: Vec::new(),
        }
    }
}

/// One file as the cache holds it.
struct Entry {
    bytes: Rc<[u8]>,
    modified: Modified,
    etag: Vec<u8>,
    content_type: &'static str,
}

/// A file's modification time, as a unix timestamp with its fraction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Modified {
    seconds: u64,
    nanos: u32,
}

impl Modified {
    fn of(metadata: &fs::Metadata) -> Self {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok());
        Modified {
            seconds: modified.map_or(0, |duration| duration.as_secs()),
            nanos: modified.map_or(0, |duration| duration.subsec_nanos()),
        }
    }
}

/// The per-core cache: files by relative path, in insertion order for eviction.
struct Cache {
    entries: HashMap<Vec<u8>, Entry>,
    order: VecDeque<Vec<u8>>,
    used: usize,
}

impl Cache {
    fn evict_to(&mut self, budget: usize) {
        while self.used > budget {
            let Some(oldest) = self.order.pop_front() else {
                return;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.used = self.used.saturating_sub(entry.bytes.len());
            }
        }
    }
}

/// A root directory served as static files.
pub struct Files {
    root: PathBuf,
    canonical_root: PathBuf,
    options: Options,
    cache: RefCell<Cache>,
    scratch: RefCell<Vec<u8>>,
}

impl std::fmt::Debug for Files {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Files")
            .field("root", &self.root)
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

/// Why a request path does not name a file under the root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A segment the policy refuses, or an escape the grammar refuses.
    Policy,
    /// A directory path with no index file configured.
    Directory,
}

/// What [`Files::try_serve_path`] did with a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use]
pub enum Served {
    /// A response was written: the file, 304, 412, 416, 405, or 403 for a
    /// dotfile under [`Dotfiles::Deny`].
    Written,
    /// The path names no file the root serves. Nothing was written, so the
    /// caller answers it, with 404 or by falling through to another route.
    Miss,
}

/// Which conditional fields of the request a file answer evaluates, by the status
/// its response would have without them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Evaluated {
    /// The preconditions and `Range`: the response would be 200.
    All,
    /// The preconditions alone: the response would be a 2xx other than 200.
    Preconditions,
    /// Neither: the response would not be a 2xx.
    Neither,
}

/// Why a request path is not served, before anything is opened.
#[derive(Clone, Copy)]
enum Unserved {
    /// A miss, for the reason given.
    Refused(Refusal),
    /// A dotfile segment that [`Dotfiles::Deny`] answers with 403.
    Forbidden,
}

/// A request path resolved under the root.
struct Located {
    /// The relative path of policy-checked segments.
    relative: PathBuf,
    /// Whether the request named a directory, so the index file was appended.
    directory: bool,
}

/// Whether one decoded segment may name a path component.
fn segment_allowed(segment: &[u8]) -> bool {
    if segment.is_empty() || segment == b"." || segment == b".." {
        return false;
    }
    if segment
        .iter()
        .any(|&byte| byte == b'/' || byte == b'\\' || byte == 0 || byte.is_ascii_control())
    {
        return false;
    }
    if cfg!(windows) {
        if segment.contains(&b':') {
            return false;
        }
        if segment
            .windows(2)
            .any(|pair| pair.first() == Some(&b'~') && pair.get(1).is_some_and(u8::is_ascii_digit))
        {
            return false;
        }
    }
    true
}

impl Files {
    /// Serve `root` as `options` say.
    ///
    /// # Arguments
    ///
    /// * `root` - the directory; it must exist.
    /// * `options` - the settings.
    ///
    /// # Errors
    ///
    /// [`io::ErrorKind::InvalidInput`] when an entry of [`Options::extensions`] is
    /// empty, `.` or `..` once its leading `.` is dropped, or holds a character a
    /// path segment may not; otherwise the operating system's error when the root
    /// cannot be resolved.
    pub fn new(root: impl Into<PathBuf>, options: Options) -> io::Result<Self> {
        if let Some(bad) = options
            .extensions
            .iter()
            .find(|extension| !segment_allowed(bare_extension(extension).as_bytes()))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("the extension {bad:?} cannot end a path segment"),
            ));
        }
        let root = root.into();
        let canonical_root = fs::canonicalize(&root)?;
        Ok(Files {
            root,
            canonical_root,
            options,
            cache: RefCell::new(Cache {
                entries: HashMap::new(),
                order: VecDeque::new(),
                used: 0,
            }),
            scratch: RefCell::new(Vec::with_capacity(256)),
        })
    }

    /// The root as given.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The root as it resolved when these files were built, symbolic links
    /// followed; every file served resolves under it.
    ///
    /// # Returns
    ///
    /// The canonical path.
    #[must_use]
    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    /// The settings.
    #[must_use]
    pub fn options(&self) -> &Options {
        &self.options
    }

    /// The file a request path names under the root, as a relative path of
    /// policy-checked segments, before anything is opened.
    ///
    /// # Arguments
    ///
    /// * `path` - the request path, as received (a leading slash is optional).
    ///
    /// # Returns
    ///
    /// The relative path, with the index file appended for a directory path.
    ///
    /// # Errors
    ///
    /// [`Refusal`] when the path names nothing under the root; a dotfile segment
    /// is [`Refusal::Policy`] under both [`Dotfiles::Ignore`] and
    /// [`Dotfiles::Deny`].
    pub fn locate(&self, path: &[u8]) -> Result<PathBuf, Refusal> {
        self.resolve(path)
            .map(|located| located.relative)
            .map_err(|unserved| match unserved {
                Unserved::Refused(refusal) => refusal,
                Unserved::Forbidden => Refusal::Policy,
            })
    }

    /// The file a request path names under the root, with whether the request
    /// named a directory.
    fn resolve(&self, path: &[u8]) -> Result<Located, Unserved> {
        let policy = Unserved::Refused(Refusal::Policy);
        let mut scratch = self.scratch.borrow_mut();
        scratch.clear();
        let normalized = normalize_path(path, &mut scratch).map_err(|_| policy)?;
        let mut relative = PathBuf::new();
        let mut decoded = Vec::new();
        let mut directory = normalized.is_empty();
        for segment in normalized.split(|&byte| byte == b'/') {
            decoded.clear();
            percent_decode(segment, &mut decoded).map_err(|_| policy)?;
            if decoded.is_empty() {
                // The leading slash and a trailing slash both split off an empty
                // segment; a trailing one names a directory.
                directory = true;
                continue;
            }
            directory = false;
            if !segment_allowed(&decoded) {
                return Err(policy);
            }
            if decoded.first() == Some(&b'.') {
                match self.options.dotfiles {
                    Dotfiles::Allow => {}
                    Dotfiles::Ignore => return Err(policy),
                    Dotfiles::Deny => return Err(Unserved::Forbidden),
                }
            }
            let text = std::str::from_utf8(&decoded).map_err(|_| policy)?;
            relative.push(text);
        }
        if directory {
            match &self.options.index {
                Some(index) => relative.push(index),
                None => return Err(Unserved::Refused(Refusal::Directory)),
            }
        }
        Ok(Located {
            relative,
            directory,
        })
    }

    /// Open and read the file at `relative`, refusing a path that resolves outside
    /// the root.
    fn load(&self, relative: &Path) -> io::Result<(Vec<u8>, fs::Metadata)> {
        let full = self.root.join(relative);
        let file = zero_sys::fs::open_nofollow(&full)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "not a file"));
        }
        let resolved = fs::canonicalize(&full)?;
        if !resolved.starts_with(&self.canonical_root) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "the path resolves outside the root",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let at_path = fs::metadata(&resolved)?;
            if at_path.dev() != metadata.dev() || at_path.ino() != metadata.ino() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "the file changed under its path",
                ));
            }
        }
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
        let mut file = file;
        file.read_to_end(&mut bytes)?;
        Ok((bytes, metadata))
    }

    /// The cached entry for `relative`, revalidated, or a fresh one.
    fn entry(&self, relative: &Path, key: &[u8]) -> io::Result<Entry> {
        let cached = {
            let cache = self.cache.borrow();
            cache.entries.get(key).map(|entry| Entry {
                bytes: Rc::clone(&entry.bytes),
                modified: entry.modified,
                etag: entry.etag.clone(),
                content_type: entry.content_type,
            })
        };
        if let Some(entry) = cached {
            let current = fs::metadata(self.root.join(relative))?;
            let unchanged = current.is_file()
                && current.len() == entry.bytes.len() as u64
                && Modified::of(&current) == entry.modified;
            if unchanged {
                return Ok(entry);
            }
            let mut cache = self.cache.borrow_mut();
            if let Some(stale) = cache.entries.remove(key) {
                cache.used = cache.used.saturating_sub(stale.bytes.len());
            }
        }
        let (bytes, metadata) = self.load(relative)?;
        let modified = Modified::of(&metadata);
        let entry = Entry {
            bytes: Rc::from(bytes),
            modified,
            etag: etag_of(modified, metadata.len()),
            content_type: zero_mime::from_path(key).unwrap_or(OCTET_STREAM),
        };
        if entry.bytes.len() <= self.options.small_file_limit {
            let mut cache = self.cache.borrow_mut();
            cache.used = cache.used.saturating_add(entry.bytes.len());
            cache.order.push_back(key.to_vec());
            cache.entries.insert(
                key.to_vec(),
                Entry {
                    bytes: Rc::clone(&entry.bytes),
                    modified: entry.modified,
                    etag: entry.etag.clone(),
                    content_type: entry.content_type,
                },
            );
            let budget = self.options.cache_budget;
            cache.evict_to(budget);
        }
        Ok(entry)
    }

    /// The entry a located path serves: the file itself, or else the first of
    /// [`Options::extensions`] appended to its name that names one, with the
    /// relative path served.
    fn find(&self, located: Located) -> Option<(PathBuf, Entry)> {
        let key = path_key(&located.relative);
        if let Ok(entry) = self.entry(&located.relative, &key) {
            return Some((located.relative, entry));
        }
        if located.directory {
            return None;
        }
        let name = located.relative.file_name()?.to_str()?;
        self.options.extensions.iter().find_map(|extension| {
            let candidate = format!("{name}.{}", bare_extension(extension));
            if !segment_allowed(candidate.as_bytes()) {
                return None;
            }
            let relative = located.relative.with_file_name(candidate);
            let key = path_key(&relative);
            let entry = self.entry(&relative, &key).ok()?;
            Some((relative, entry))
        })
    }

    /// Serve the request at its own path, answering a miss with 404.
    ///
    /// # Arguments
    ///
    /// * `call` - the request and its response.
    ///
    /// # Errors
    ///
    /// [`Error`] from the response builder, which refuses nothing this writes.
    pub fn serve(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let path = call.request().path().to_vec();
        self.serve_path(call, &path)
    }

    /// Serve the request for `path` under the root, which a mounted route passes as
    /// the part of the request path after its prefix, answering a miss with 404.
    ///
    /// # Arguments
    ///
    /// * `call` - the request and its response.
    /// * `path` - the path under the root, as received.
    ///
    /// # Errors
    ///
    /// [`Error`] from the response builder, which refuses nothing this writes.
    pub fn serve_path(&self, call: &mut Call<'_>, path: &[u8]) -> Result<(), Error> {
        if self.try_serve_path(call, path)? == Served::Miss {
            call.response().status(StatusCode::NOT_FOUND);
        }
        Ok(())
    }

    /// Serve the request at its own path, or report a miss without writing.
    ///
    /// # Arguments
    ///
    /// * `call` - the request and its response.
    ///
    /// # Returns
    ///
    /// Whether a response was written; see [`Files::try_serve_path`].
    ///
    /// # Errors
    ///
    /// [`Error`] from the response builder, which refuses nothing this writes.
    pub fn try_serve(&self, call: &mut Call<'_>) -> Result<Served, Error> {
        let path = call.request().path().to_vec();
        self.try_serve_path(call, &path)
    }

    /// Serve the request for `path` under the root, or report a miss without
    /// writing anything, so a host can fall through to its next route. A method
    /// other than GET and HEAD is answered 405 with `Allow: GET, HEAD`, and a
    /// dotfile under [`Dotfiles::Deny`] is answered 403 with no content, whether
    /// or not the file exists.
    ///
    /// # Arguments
    ///
    /// * `call` - the request and its response.
    /// * `path` - the path under the root, as received.
    ///
    /// # Returns
    ///
    /// [`Served::Written`] when a response was written, [`Served::Miss`] when the
    /// path names no file the root serves and the response is untouched.
    ///
    /// # Errors
    ///
    /// [`Error`] from the response builder, which refuses nothing this writes.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
    pub fn try_serve_path(&self, call: &mut Call<'_>, path: &[u8]) -> Result<Served, Error> {
        self.answer(call, path, Evaluated::All)
    }

    /// Serve the file `path` names under the root as the content of a response
    /// whose status an earlier layer set, such as a host that answers a missing page
    /// with a page of its own, or report a miss without writing anything. With no
    /// status set, or 200, this is [`Files::try_serve_path`]. Another 2xx stays and
    /// keeps the preconditions, but `Range` is ignored, since it "is evaluated after
    /// evaluating the precondition header fields ... and only if the result in
    /// absence of the Range header field would be a 200 (OK) response" (RFC 9110
    /// Section 14.2). Any other status stays and both are ignored, since "A server
    /// MUST ignore all received preconditions if its response to the same request
    /// without those conditions ... would have been a status code other than a 2xx
    /// (Successful) or 412 (Precondition Failed)" (Section 13.2.1); no validator is
    /// sent then, since that content is no representation of the target resource
    /// (Section 6.4.2). A method other than GET and HEAD is answered 405, and a
    /// dotfile under [`Dotfiles::Deny`] 403, as by [`Files::try_serve_path`].
    ///
    /// # Arguments
    ///
    /// * `call` - the request and its response, with the status set so far.
    /// * `path` - the path under the root, as received.
    ///
    /// # Returns
    ///
    /// [`Served::Written`] when a response was written, [`Served::Miss`] when the
    /// path names no file the root serves and the response is untouched.
    ///
    /// # Errors
    ///
    /// [`Error`] from the response builder, which refuses nothing this writes.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-6.4.2>
    pub fn try_serve_path_keeping_status(
        &self,
        call: &mut Call<'_>,
        path: &[u8],
    ) -> Result<Served, Error> {
        let evaluated = match call.response().current_status() {
            None => Evaluated::All,
            Some(status) if status.as_u16() == 200 => Evaluated::All,
            Some(status) if status.is_successful() => Evaluated::Preconditions,
            Some(_) => Evaluated::Neither,
        };
        self.answer(call, path, evaluated)
    }

    /// Write `Content-Disposition: attachment` with the file's name, for a download
    /// root.
    fn disposition(&self, response: &mut Response<'_>, relative: &Path) -> Result<(), Error> {
        if !self.options.attachment {
            return Ok(());
        }
        let name = relative
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut value = Vec::new();
        write_attachment(&mut value, &name);
        response.header(b"Content-Disposition", &value)?;
        Ok(())
    }

    /// The file answer, evaluating the conditional fields `evaluated` lets apply.
    fn answer(
        &self,
        call: &mut Call<'_>,
        path: &[u8],
        evaluated: Evaluated,
    ) -> Result<Served, Error> {
        let method = call.request().method();
        if !matches!(method, Some(Method::Get | Method::Head)) {
            let mut response = call.response();
            response.status(StatusCode::METHOD_NOT_ALLOWED);
            response.header_id(HeaderName::Allow, b"GET, HEAD")?;
            return Ok(Served::Written);
        }
        let located = match self.resolve(path) {
            Ok(located) => located,
            Err(Unserved::Forbidden) => {
                call.response().status(StatusCode::FORBIDDEN);
                return Ok(Served::Written);
            }
            Err(Unserved::Refused(_)) => return Ok(Served::Miss),
        };
        let Some((relative, entry)) = self.find(located) else {
            return Ok(Served::Miss);
        };
        if evaluated == Evaluated::Neither {
            let mut response = call.response();
            self.disposition(&mut response, &relative)?;
            response.content_type(entry.content_type.as_bytes())?;
            response.body(&entry.bytes);
            return Ok(Served::Written);
        }
        let ranged = self.options.ranges && evaluated == Evaluated::All;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs());
        let last_modified = last_modified_for(entry.modified.seconds, now);
        let (request, mut response) = call.parts();
        let preconditions = Preconditions {
            if_match: request.header_id(HeaderName::IfMatch),
            if_none_match: request.header_id(HeaderName::IfNoneMatch),
            if_modified_since: request.header_id(HeaderName::IfModifiedSince),
            if_unmodified_since: request.header_id(HeaderName::IfUnmodifiedSince),
            if_range: request.header_id(HeaderName::IfRange),
            range: if ranged {
                request.header_id(HeaderName::Range)
            } else {
                None
            },
        };
        let current = Validators {
            etag: EntityTag::parse(&entry.etag),
            last_modified: Some(last_modified),
        };
        let mut cache_control = Vec::new();
        self.options.cache.write(&mut cache_control);
        // The fields a 200 and a 304 share (Section 15.4.5): ETag and Cache-Control
        // here, Date from the driver.
        response.header_id(HeaderName::ETag, &entry.etag)?;
        if !cache_control.is_empty() {
            response.header_id(HeaderName::CacheControl, &cache_control)?;
        }
        match evaluate(method, preconditions, current, now) {
            Outcome::NotModified => {
                response.status(StatusCode::NOT_MODIFIED);
                return Ok(Served::Written);
            }
            Outcome::PreconditionFailed => {
                response.status(StatusCode::PRECONDITION_FAILED);
                return Ok(Served::Written);
            }
            Outcome::Proceed { range } => {
                let mut value = Vec::new();
                if let Some(date) = imf_fixdate(last_modified) {
                    response.header_id(HeaderName::LastModified, date.as_bytes())?;
                }
                if ranged {
                    response.header_id(HeaderName::AcceptRanges, b"bytes")?;
                }
                self.disposition(&mut response, &relative)?;
                let length = entry.bytes.len() as u64;
                let ranges = range.map(|range| resolve(range, length));
                match ranges {
                    None | Some(Ranges::Ignore) => {
                        response.content_type(entry.content_type.as_bytes())?;
                        response.body(&entry.bytes);
                    }
                    Some(Ranges::Unsatisfiable | Ranges::Refused) => {
                        response.status(StatusCode::RANGE_NOT_SATISFIABLE);
                        write_unsatisfied_range(&mut value, length);
                        response.header_id(HeaderName::ContentRange, &value)?;
                    }
                    Some(Ranges::Satisfiable(ranges)) => {
                        response.status(StatusCode::PARTIAL_CONTENT);
                        if let [single] = ranges.as_slice() {
                            write_content_range(&mut value, *single, length);
                            response.header_id(HeaderName::ContentRange, &value)?;
                            response.content_type(entry.content_type.as_bytes())?;
                            let part = usize::try_from(single.0)
                                .ok()
                                .zip(usize::try_from(single.1).ok())
                                .and_then(|(first, last)| entry.bytes.get(first..=last))
                                .unwrap_or(&[]);
                            response.body(part);
                        } else {
                            let mut boundary = Vec::with_capacity(48);
                            boundary.extend_from_slice(b"zero-");
                            boundary.extend(
                                entry.etag.iter().copied().filter(u8::is_ascii_alphanumeric),
                            );
                            value.extend_from_slice(b"multipart/byteranges; boundary=");
                            value.extend_from_slice(&boundary);
                            response.content_type(&value)?;
                            write_multipart(
                                response.body_mut(),
                                &entry.bytes,
                                &ranges,
                                entry.content_type.as_bytes(),
                                &boundary,
                            );
                        }
                    }
                }
            }
        }
        Ok(Served::Written)
    }
}

/// The cache key and media type source of a relative path.
fn path_key(relative: &Path) -> Vec<u8> {
    relative.to_string_lossy().into_owned().into_bytes()
}

/// An entry of [`Options::extensions`] without its leading `.`, if any.
fn bare_extension(extension: &str) -> &str {
    extension.strip_prefix('.').unwrap_or(extension)
}

/// A strong entity tag from the modification time and the length: a change to the
/// data that keeps both is one the file system did not record either.
fn etag_of(modified: Modified, length: u64) -> Vec<u8> {
    let mut tag = Vec::with_capacity(48);
    tag.push(b'"');
    push_hex(&mut tag, modified.seconds);
    tag.push(b'-');
    push_hex(&mut tag, u64::from(modified.nanos));
    tag.push(b'-');
    push_hex(&mut tag, length);
    tag.push(b'"');
    tag
}

fn push_hex(out: &mut Vec<u8>, value: u64) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    if value == 0 {
        out.push(b'0');
        return;
    }
    let mut digits = [0u8; 16];
    let mut count = 0usize;
    let mut rest = value;
    while rest != 0 {
        if let Some(slot) = digits.get_mut(count) {
            *slot = HEX[usize::try_from(rest & 0xF).unwrap_or(0)];
        }
        count = count.saturating_add(1);
        rest >>= 4;
    }
    out.extend(digits.get(..count).unwrap_or(&[]).iter().rev());
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::sync::Arc;
    use std::time::Duration;

    use zero_core::Error;
    use zero_http::{serve, Call, Config, Handler};
    use zero_http_types::StatusCode;

    use super::{Files, Options};

    /// Serves `page.txt` under the status the request path names, as a layer that
    /// set a status before the file does.
    struct Keeping {
        files: Files,
    }

    impl Handler for Keeping {
        async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
            let path = call.request().path();
            let status = if path == b"/404" {
                Some(StatusCode::NOT_FOUND)
            } else if path == b"/201" {
                Some(StatusCode::CREATED)
            } else {
                None
            };
            if let Some(status) = status {
                call.response().status(status);
            }
            self.files
                .try_serve_path_keeping_status(call, b"/page.txt")
                .map(drop)
        }
    }

    /// One request on a fresh connection: the status, the lowercased field names
    /// and the body.
    fn fetch(addr: SocketAddr, request: &str) -> (u16, Vec<String>, Vec<u8>) {
        let mut conn = TcpStream::connect(addr).expect("connect");
        conn.set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        conn.write_all(request.as_bytes()).expect("write");
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(conn.read(&mut byte).expect("read"), 1, "the head ends");
            head.push(byte[0]);
        }
        let text = String::from_utf8(head).expect("ascii");
        let mut lines = text.trim_end().split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split(' ').nth(1))
            .and_then(|code| code.parse().ok())
            .expect("a status line");
        let fields: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        let length = fields
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        conn.read_exact(&mut body).expect("the body");
        (
            status,
            fields.into_iter().map(|(name, _)| name).collect(),
            body,
        )
    }

    #[test]
    fn a_status_set_first_keeps_preconditions_for_a_2xx_and_range_for_a_200_9110_13_2_1_and_14_2() {
        let root = std::env::temp_dir().join(format!("zero-static-keeping-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a scratch directory");
        std::fs::write(root.join("page.txt"), b"0123456789").expect("write");
        let mut config = Config::default();
        config.runtime.io.threads = 1;
        config.runtime.io.drain = Duration::from_secs(1);
        let served = root.clone();
        let workers = serve(
            "127.0.0.1:0".parse().expect("an address"),
            config,
            Arc::new(|_| {}),
            move |_| Keeping {
                files: Files::new(served.clone(), Options::default()).expect("the root exists"),
            },
        )
        .expect("the server starts");
        let addr = workers.local_addr();
        let get = |path: &str, fields: &str| {
            fetch(
                addr,
                &format!("GET {path} HTTP/1.1\r\nHost: t\r\n{fields}\r\n"),
            )
        };

        let (status, names, body) = get("/404", "Range: bytes=0-1\r\nIf-None-Match: *\r\n");
        assert_eq!((status, body.as_slice()), (404, b"0123456789".as_slice()));
        for name in ["etag", "last-modified", "accept-ranges", "content-range"] {
            assert!(!names.iter().any(|seen| seen == name), "{name}: {names:?}");
        }
        assert!(names.iter().any(|seen| seen == "content-type"));

        assert_eq!(get("/201", "If-None-Match: *\r\n").0, 304);
        let (status, names, body) = get("/201", "Range: bytes=0-1\r\n");
        assert_eq!((status, body.as_slice()), (201, b"0123456789".as_slice()));
        assert!(names.iter().any(|seen| seen == "etag"));
        assert!(!names.iter().any(|seen| seen == "content-range"));

        let (status, _, body) = get("/200", "Range: bytes=0-1\r\n");
        assert_eq!((status, body.as_slice()), (206, b"01".as_slice()));
        workers.stop().expect("the server stops");
        let _ = std::fs::remove_dir_all(&root);
    }
}
