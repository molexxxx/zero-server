//! The file layer: a root directory served over `zero-http`'s handler ABI.
//!
//! Every request path goes through the policy of RFC 9110 Section 17.3 segment by
//! segment: the path is normalized (dot segments removed, unreserved octets
//! decoded), the remaining percent-escapes are decoded strictly, and a segment
//! that is empty, `.` or `..`, or that holds a separator, a NUL or a control
//! character, or on Windows a colon (an alternate data stream) or a tilde followed
//! by a digit (an 8.3 short name), ends the request with 404, as does a segment
//! that begins with a dot unless [`Options::dotfiles`] allows it. The file is then
//! opened without following a symbolic link in its final component (`O_NOFOLLOW`
//! on Unix), its resolved path is compared against the resolved root, and on Unix
//! the opened file's identity is compared with the resolved path's, so a link
//! swapped in between the two cannot hand out a file from outside the root.
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
use zero_http::Call;
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_uri::{normalize_path, percent_decode};

use crate::cond::{evaluate, EntityTag, Outcome, Preconditions, Validators};
use crate::headers::{last_modified_for, write_attachment, CachePolicy};
use crate::range::{
    resolve, write_content_range, write_multipart, write_unsatisfied_range, Ranges,
};

/// The media type of a file whose extension names none.
const OCTET_STREAM: &str = "application/octet-stream";

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
    /// Whether a path segment that begins with `.`, such as `.env` or `.git`, may be
    /// served. Off by default, which answers such a path with 404; a root that
    /// serves `/.well-known/` (RFC 8615) turns it on.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
    /// @see <https://www.rfc-editor.org/rfc/rfc8615.html#section-3>
    pub dotfiles: bool,
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
            dotfiles: false,
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
    /// The operating system's error when the root cannot be resolved.
    pub fn new(root: impl Into<PathBuf>, options: Options) -> io::Result<Self> {
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
    /// [`Refusal`] when the path names nothing under the root.
    pub fn locate(&self, path: &[u8]) -> Result<PathBuf, Refusal> {
        let mut scratch = self.scratch.borrow_mut();
        scratch.clear();
        let normalized = normalize_path(path, &mut scratch).map_err(|_| Refusal::Policy)?;
        let mut relative = PathBuf::new();
        let mut decoded = Vec::new();
        let mut directory = normalized.is_empty();
        for segment in normalized.split(|&byte| byte == b'/') {
            decoded.clear();
            percent_decode(segment, &mut decoded).map_err(|_| Refusal::Policy)?;
            if decoded.is_empty() {
                // The leading slash and a trailing slash both split off an empty
                // segment; a trailing one names a directory.
                directory = true;
                continue;
            }
            directory = false;
            if !segment_allowed(&decoded)
                || (!self.options.dotfiles && decoded.first() == Some(&b'.'))
            {
                return Err(Refusal::Policy);
            }
            let text = std::str::from_utf8(&decoded).map_err(|_| Refusal::Policy)?;
            relative.push(text);
        }
        if directory {
            match &self.options.index {
                Some(index) => relative.push(index),
                None => return Err(Refusal::Directory),
            }
        }
        Ok(relative)
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

    /// Serve the request at its own path.
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
    /// the part of the request path after its prefix.
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
        let method = call.request().method();
        if !matches!(method, Some(Method::Get | Method::Head)) {
            let mut response = call.response();
            response.status(StatusCode::METHOD_NOT_ALLOWED);
            response.header_id(HeaderName::Allow, b"GET, HEAD")?;
            return Ok(());
        }
        let Ok(relative) = self.locate(path) else {
            call.response().status(StatusCode::NOT_FOUND);
            return Ok(());
        };
        let key = relative.to_string_lossy().into_owned().into_bytes();
        let Ok(entry) = self.entry(&relative, &key) else {
            call.response().status(StatusCode::NOT_FOUND);
            return Ok(());
        };
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
            range: if self.options.ranges {
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
                return Ok(());
            }
            Outcome::PreconditionFailed => {
                response.status(StatusCode::PRECONDITION_FAILED);
                return Ok(());
            }
            Outcome::Proceed { range } => {
                let mut value = Vec::new();
                if let Some(date) = imf_fixdate(last_modified) {
                    response.header_id(HeaderName::LastModified, date.as_bytes())?;
                }
                if self.options.ranges {
                    response.header_id(HeaderName::AcceptRanges, b"bytes")?;
                }
                if self.options.attachment {
                    let name = relative
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    write_attachment(&mut value, &name);
                    response.header(b"Content-Disposition", &value)?;
                    value.clear();
                }
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
        Ok(())
    }
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
