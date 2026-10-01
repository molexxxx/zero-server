//! The media type table of zero-server.
//!
//! [`from_extension`] and [`from_path`] name the media type a file is served as,
//! from the table `scripts/mime_table.py` writes out of mime-db (itself compiled
//! from the IANA registry, Apache's and nginx's tables). [`parse`] reads a
//! `media-type` value (RFC 9110 Section 8.3.1): `type "/" subtype parameters`,
//! the type and subtype case-insensitive, the parameters as `name=value` or
//! `name="quoted"` after semicolons. [`is_text`] says when a type is served with a
//! `charset` parameter. [`negotiate`] picks the representation an `Accept` field
//! asks for (RFC 9110 Section 12.5.1).

#![cfg_attr(not(feature = "std"), no_std)]

pub mod accept;
mod table;

pub use accept::{negotiate, VARY_ACCEPT};
pub use table::{EXTENSIONS, SOURCE_VERSION};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The media type of data the server knows nothing about.
pub const OCTET_STREAM: &str = "application/octet-stream";

/// The media type of a file extension, without its dot and in any case.
///
/// # Arguments
///
/// * `extension` - the extension, such as `html` or `PNG`.
///
/// # Returns
///
/// The lowercase media type, or `None` when the table has no row.
#[must_use]
pub fn from_extension(extension: &[u8]) -> Option<&'static str> {
    if extension.is_empty() || extension.len() > 16 {
        return None;
    }
    let mut lower = [0u8; 16];
    for (slot, byte) in lower.iter_mut().zip(extension) {
        *slot = byte.to_ascii_lowercase();
    }
    let wanted = lower.get(..extension.len()).unwrap_or(&[]);
    EXTENSIONS
        .binary_search_by(|(known, _)| known.as_bytes().cmp(wanted))
        .ok()
        .and_then(|index| EXTENSIONS.get(index))
        .map(|(_, media_type)| *media_type)
}

/// The media type of a path, from the extension of its last segment.
///
/// # Arguments
///
/// * `path` - the path; the extension is what follows the last `.` of the last
///   segment, and a segment that starts with `.` and has no other dot has none.
///
/// # Returns
///
/// The media type, or `None` when the path has no extension the table knows.
#[must_use]
pub fn from_path(path: &[u8]) -> Option<&'static str> {
    let start = path
        .iter()
        .rposition(|&byte| byte == b'/' || byte == b'\\')
        .map_or(0, |at| at.saturating_add(1));
    let name = path.get(start..).unwrap_or(&[]);
    let dot = name.iter().rposition(|&byte| byte == b'.')?;
    if dot == 0 {
        return None;
    }
    from_extension(name.get(dot.saturating_add(1)..).unwrap_or(&[]))
}

/// Whether a media type is text, so that a `charset` parameter belongs on it:
/// `text/*`, and the `+json`, `+xml` structured syntaxes along with
/// `application/json`, `application/xml`, `application/javascript` and
/// `application/manifest+json`.
///
/// # Arguments
///
/// * `media_type` - the type, in any case, parameters excluded.
#[must_use]
pub fn is_text(media_type: &[u8]) -> bool {
    if media_type.len() >= 5
        && media_type
            .get(..5)
            .is_some_and(|t| t.eq_ignore_ascii_case(b"text/"))
    {
        return true;
    }
    let lower_ends = |suffix: &[u8]| {
        media_type.len() >= suffix.len()
            && media_type
                .get(media_type.len().saturating_sub(suffix.len())..)
                .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
    };
    lower_ends(b"+json")
        || lower_ends(b"+xml")
        || media_type.eq_ignore_ascii_case(b"application/json")
        || media_type.eq_ignore_ascii_case(b"application/xml")
        || media_type.eq_ignore_ascii_case(b"application/javascript")
}

/// A parsed `media-type` value: the essence and the parameters as received.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaType<'a> {
    /// The `type` token as received.
    pub kind: &'a [u8],
    /// The `subtype` token as received.
    pub subtype: &'a [u8],
    /// Everything after the subtype: the parameters with their semicolons, or
    /// empty.
    pub parameters: &'a [u8],
}

impl<'a> MediaType<'a> {
    /// Whether the essence (type and subtype, compared without regard to case)
    /// is `essence`.
    ///
    /// # Arguments
    ///
    /// * `essence` - the `type/subtype` to compare with.
    #[must_use]
    pub fn is(&self, essence: &[u8]) -> bool {
        let Some(slash) = essence.iter().position(|&byte| byte == b'/') else {
            return false;
        };
        let (kind, rest) = essence.split_at(slash);
        let subtype = rest.get(1..).unwrap_or(&[]);
        self.kind.eq_ignore_ascii_case(kind) && self.subtype.eq_ignore_ascii_case(subtype)
    }

    /// The parameters in order, each a name and its value with the quotes of a
    /// quoted-string removed and its quoted-pairs resolved into `scratch` when the
    /// value had any; a parameter whose value is a bare token borrows the input.
    ///
    /// # Arguments
    ///
    /// * `scratch` - space for an unquoted value; cleared at each parameter.
    pub fn parameters<'s>(&self, scratch: &'s mut [u8]) -> Parameters<'a, 's> {
        Parameters {
            rest: self.parameters,
            scratch,
        }
    }

    /// The value of the parameter called `name`, compared without regard to case,
    /// when it is a bare token or a quoted string without quoted-pairs.
    ///
    /// # Arguments
    ///
    /// * `name` - the parameter name.
    #[must_use]
    pub fn parameter(&self, name: &[u8]) -> Option<&'a [u8]> {
        let mut rest = self.parameters;
        while let Some(parameter) = next_parameter(rest) {
            if parameter.name.eq_ignore_ascii_case(name)
                && (!parameter.quoted || !parameter.value.contains(&b'\\'))
            {
                return Some(parameter.value);
            }
            rest = parameter.rest;
        }
        None
    }
}

/// The parameters of a media type, in order.
#[derive(Debug)]
pub struct Parameters<'a, 's> {
    rest: &'a [u8],
    scratch: &'s mut [u8],
}

impl<'a, 's> Parameters<'a, 's> {
    /// The next parameter: its name and value, the value unquoted into the scratch
    /// buffer when it was a quoted-string with quoted-pairs.
    ///
    /// # Returns
    ///
    /// The name, the value, and whether the value sits in the scratch buffer;
    /// `None` at the end or at a parameter the grammar refuses.
    pub fn next_parameter(&mut self) -> Option<(&'a [u8], Unquoted<'a, '_>)> {
        let parameter = next_parameter(self.rest)?;
        self.rest = parameter.rest;
        let (name, value) = (parameter.name, parameter.value);
        if !parameter.quoted || !value.contains(&b'\\') {
            return Some((name, Unquoted::Borrowed(value)));
        }
        let mut written = 0usize;
        let mut escaped = false;
        for &byte in value {
            if escaped || byte != b'\\' {
                let slot = self.scratch.get_mut(written)?;
                *slot = byte;
                written = written.saturating_add(1);
                escaped = false;
            } else {
                escaped = true;
            }
        }
        let unquoted = self.scratch.get(..written)?;
        Some((name, Unquoted::Scratch(unquoted)))
    }
}

/// A parameter value, borrowed from the input or unquoted into the scratch
/// buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unquoted<'a, 's> {
    /// The value as received, a token or a quoted-string without quoted-pairs.
    Borrowed(&'a [u8]),
    /// The value with its quoted-pairs resolved.
    Scratch(&'s [u8]),
}

impl Unquoted<'_, '_> {
    /// The value bytes.
    #[must_use]
    pub const fn bytes(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Scratch(bytes) => bytes,
        }
    }
}

/// Parse a `media-type` value (RFC 9110 Section 8.3.1).
///
/// # Arguments
///
/// * `value` - the field value, with its surrounding whitespace already removed.
///
/// # Returns
///
/// The type, subtype and parameter section, or `None` when the type or subtype is
/// not a token or a parameter does not follow the grammar.
#[must_use]
pub fn parse(value: &[u8]) -> Option<MediaType<'_>> {
    let slash = value.iter().position(|&byte| byte == b'/')?;
    let kind = value.get(..slash)?;
    let rest = value.get(slash.saturating_add(1)..)?;
    let subtype_len = rest.iter().take_while(|&&byte| is_tchar(byte)).count();
    let subtype = rest.get(..subtype_len)?;
    if kind.is_empty() || subtype.is_empty() || !kind.iter().all(|&byte| is_tchar(byte)) {
        return None;
    }
    let parameters = rest.get(subtype_len..)?;
    let mut check = parameters;
    while !check.is_empty() {
        let parameter = next_parameter(check)?;
        if parameter.rest.len() == check.len() {
            return None;
        }
        check = parameter.rest;
    }
    Some(MediaType {
        kind,
        subtype,
        parameters,
    })
}

/// One parameter read off the front of a parameter section.
struct Parameter<'a> {
    name: &'a [u8],
    /// The value without its quotes.
    value: &'a [u8],
    quoted: bool,
    rest: &'a [u8],
}

/// Read one `OWS ";" OWS name "=" ( token / quoted-string )` from the front.
fn next_parameter(input: &[u8]) -> Option<Parameter<'_>> {
    let mut pos = skip_ows(input, 0);
    if input.get(pos) != Some(&b';') {
        return None;
    }
    pos = skip_ows(input, pos.saturating_add(1));
    let name_len = input
        .get(pos..)?
        .iter()
        .take_while(|&&byte| is_tchar(byte))
        .count();
    if name_len == 0 {
        return None;
    }
    let name = input.get(pos..pos.saturating_add(name_len))?;
    pos = pos.saturating_add(name_len);
    if input.get(pos) != Some(&b'=') {
        return None;
    }
    pos = pos.saturating_add(1);
    if input.get(pos) == Some(&b'"') {
        let start = pos.saturating_add(1);
        let mut at = start;
        loop {
            match input.get(at) {
                Some(b'"') => break,
                Some(b'\\') => {
                    let next = input.get(at.saturating_add(1))?;
                    if !is_quoted_pair_byte(*next) {
                        return None;
                    }
                    at = at.saturating_add(2);
                }
                Some(&byte) if is_qdtext(byte) => at = at.saturating_add(1),
                _ => return None,
            }
        }
        let value = input.get(start..at)?;
        let rest = input.get(at.saturating_add(1)..)?;
        return Some(Parameter {
            name,
            value,
            quoted: true,
            rest,
        });
    }
    let value_len = input
        .get(pos..)?
        .iter()
        .take_while(|&&byte| is_tchar(byte))
        .count();
    if value_len == 0 {
        return None;
    }
    let value = input.get(pos..pos.saturating_add(value_len))?;
    let rest = input.get(pos.saturating_add(value_len)..)?;
    Some(Parameter {
        name,
        value,
        quoted: false,
        rest,
    })
}

fn skip_ows(input: &[u8], mut pos: usize) -> usize {
    while matches!(input.get(pos), Some(b' ' | b'\t')) {
        pos = pos.saturating_add(1);
    }
    pos
}

/// RFC 9110 Section 5.6.2 `tchar`.
const fn is_tchar(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'#'
            | b'$'
            | b'%'
            | b'&'
            | b'\''
            | b'*'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~'
            | b'0'..=b'9'
            | b'A'..=b'Z'
            | b'a'..=b'z'
    )
}

/// RFC 9110 Section 5.6.4 `qdtext`: HTAB, SP, `!`, `#`-`[`, `]`-`~`, obs-text.
const fn is_qdtext(byte: u8) -> bool {
    matches!(byte, b'\t' | b' ' | b'!' | 0x23..=0x5B | 0x5D..=0x7E | 0x80..=0xFF)
}

/// RFC 9110 Section 5.6.4 `quoted-pair`: `\` followed by HTAB, SP, VCHAR or obs-text.
const fn is_quoted_pair_byte(byte: u8) -> bool {
    matches!(byte, b'\t' | b' ' | 0x21..=0x7E | 0x80..=0xFF)
}

#[cfg(test)]
mod tests {
    use super::{from_extension, from_path, is_text, parse, Unquoted, EXTENSIONS};

    #[test]
    fn the_table_is_sorted_lowercase_and_names_the_web_types() {
        assert!(EXTENSIONS
            .windows(2)
            .all(|pair| pair.first().map(|row| row.0) < pair.get(1).map(|row| row.0)));
        assert!(EXTENSIONS
            .iter()
            .all(|(ext, mt)| ext.bytes().all(|b| b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || b == b'-'
                || b == b'_'
                || b == b'.'
                || b == b'+')
                && mt.contains('/')));
        assert_eq!(from_extension(b"html"), Some("text/html"));
        assert_eq!(from_extension(b"CSS"), Some("text/css"));
        assert_eq!(from_extension(b"js"), Some("text/javascript"));
        assert_eq!(from_extension(b"mjs"), Some("text/javascript"));
        assert_eq!(from_extension(b"json"), Some("application/json"));
        assert_eq!(from_extension(b"svg"), Some("image/svg+xml"));
        assert_eq!(from_extension(b"wasm"), Some("application/wasm"));
        assert_eq!(from_extension(b"woff2"), Some("font/woff2"));
        assert_eq!(from_extension(b"mp4"), Some("video/mp4"));
        assert_eq!(from_extension(b"png"), Some("image/png"));
        assert_eq!(from_extension(b"nope-not-a-type"), None);
        assert_eq!(from_extension(b""), None);
    }

    #[test]
    fn a_path_contributes_the_extension_of_its_last_segment() {
        assert_eq!(from_path(b"/static/app.min.js"), Some("text/javascript"));
        assert_eq!(from_path(b"C:\\site\\index.HTML"), Some("text/html"));
        assert_eq!(from_path(b"/a.b/c"), None);
        assert_eq!(from_path(b"/.gitignore"), None);
        assert_eq!(from_path(b"README"), None);
        assert_eq!(from_path(b"/dir/archive.tar.gz"), Some("application/gzip"));
    }

    #[test]
    fn text_types_and_the_structured_syntaxes_take_a_charset() {
        assert!(is_text(b"text/plain"));
        assert!(is_text(b"Text/HTML"));
        assert!(is_text(b"application/json"));
        assert!(is_text(b"application/ld+json"));
        assert!(is_text(b"image/svg+xml"));
        assert!(!is_text(b"image/png"));
        assert!(!is_text(b"application/octet-stream"));
    }

    #[test]
    fn media_type_values_parse_with_their_parameters() {
        let empty = super::MediaType {
            kind: b"",
            subtype: b"",
            parameters: b"",
        };
        let media = parse(b"Text/HTML;Charset=\"utf-8\"; q=0.5").unwrap_or(empty);
        assert_eq!(media.kind, b"Text");
        assert!(media.is(b"text/html"));
        assert!(!media.is(b"text/plain"));
        assert_eq!(media.parameter(b"q"), Some(&b"0.5"[..]));
        assert_eq!(media.parameter(b"charset"), Some(&b"utf-8"[..]));
        let mut scratch = [0u8; 32];
        let mut parameters = media.parameters(&mut scratch);
        assert_eq!(
            parameters.next_parameter(),
            Some((&b"Charset"[..], Unquoted::Borrowed(&b"utf-8"[..])))
        );
        assert_eq!(
            parameters.next_parameter(),
            Some((&b"q"[..], Unquoted::Borrowed(&b"0.5"[..])))
        );
        assert_eq!(parameters.next_parameter(), None);

        let quoted = parse(b"text/plain; title=\"a \\\"b\\\" c\"").unwrap_or(empty);
        assert_eq!(quoted.subtype, b"plain", "quoted pairs are allowed");
        let mut scratch = [0u8; 32];
        let mut parameters = quoted.parameters(&mut scratch);
        let first = parameters.next_parameter();
        assert_eq!(first.map(|(name, _)| name), Some(&b"title"[..]));
        assert_eq!(
            first.map(|(_, value)| value.bytes().to_vec()),
            Some(b"a \"b\" c".to_vec())
        );
        assert_eq!(
            quoted.parameter(b"title"),
            None,
            "quoted pairs need the scratch form"
        );

        assert_eq!(parse(b"text"), None);
        assert_eq!(parse(b"/html"), None);
        assert_eq!(parse(b"text/html; charset"), None);
        assert_eq!(parse(b"text/html; charset=\"open"), None);
        assert_eq!(parse(b"text/html; =x"), None);
        assert_eq!(parse(b"text/html junk"), None);
        assert_eq!(parse(b"text/html;charset=utf-8;"), None);
    }
}
