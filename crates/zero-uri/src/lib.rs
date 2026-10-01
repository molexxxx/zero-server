//! The RFC 3986 URI parser of zero-server.
//!
//! One parser and nothing else: [`parse`] splits a URI reference into its
//! components as byte ranges over the caller's input (Section 3), [`split_query`]
//! separates a request target's path from its query at the first `?` (Section
//! 3.4), [`percent_decode`] resolves `pct-encoded` triplets and refuses a `%` that
//! is not one (Section 2.1), and [`normalize_path`] applies the normalizations of
//! Section 6.2.2 that keep a path's meaning: unreserved octets decoded (Section
//! 2.3), the hexadecimal digits of the remaining triplets uppercased (Section
//! 2.1), and dot-segments removed with `remove_dot_segments` (Section 5.2.4).
//! Reserved characters stay encoded, because a URI that encodes one means
//! something else than the URI that does not (Section 2.2), which is what keeps an
//! encoded `%2F` from acting as a path separator.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::vec::Vec;
use core::fmt;
use core::ops::Range;

use zero_core::Error;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Why input was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UriError {
    /// A `%` not followed by two hexadecimal digits, at this offset.
    InvalidPercent(usize),
    /// A byte the grammar does not allow in this component, at this offset:
    /// a control, a space, a byte past ASCII, or a delimiter out of place.
    InvalidByte(usize),
    /// The scheme does not start with a letter or holds a byte outside
    /// `ALPHA / DIGIT / "+" / "-" / "."`.
    InvalidScheme,
    /// A path that begins with `//` while the reference has no authority.
    InvalidPath,
}

impl fmt::Display for UriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPercent(at) => write!(f, "invalid percent-encoding at offset {at}"),
            Self::InvalidByte(at) => write!(f, "invalid byte at offset {at}"),
            Self::InvalidScheme => f.write_str("invalid scheme"),
            Self::InvalidPath => f.write_str("a path without authority cannot begin with //"),
        }
    }
}

impl From<UriError> for Error {
    fn from(error: UriError) -> Self {
        Error::Protocol(alloc::format!("uri: {error}"))
    }
}

/// The components of a URI reference as ranges into the input (RFC 3986 Section
/// 3); every present component excludes its delimiter.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Components {
    /// The scheme, without the `:`.
    pub scheme: Option<Range<usize>>,
    /// The authority, without the `//`.
    pub authority: Option<Range<usize>>,
    /// The path; always present, possibly empty.
    pub path: Range<usize>,
    /// The query, without the `?`.
    pub query: Option<Range<usize>>,
    /// The fragment, without the `#`.
    pub fragment: Option<Range<usize>>,
}

/// Whether a byte is `unreserved` (RFC 3986 Section 2.3).
#[must_use]
pub const fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

/// Whether a byte is a `sub-delims` (RFC 3986 Section 2.2).
#[must_use]
pub const fn is_sub_delim(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'='
    )
}

/// Whether a byte is a `gen-delims` (RFC 3986 Section 2.2).
#[must_use]
pub const fn is_gen_delim(byte: u8) -> bool {
    matches!(byte, b':' | b'/' | b'?' | b'#' | b'[' | b']' | b'@')
}

/// Whether a byte may appear in a path segment outside a percent-encoding:
/// `pchar` less `pct-encoded` (RFC 3986 Section 3.3).
#[must_use]
pub const fn is_pchar(byte: u8) -> bool {
    is_unreserved(byte) || is_sub_delim(byte) || matches!(byte, b':' | b'@')
}

/// Whether a byte may appear in a query or fragment outside a percent-encoding
/// (RFC 3986 Sections 3.4 and 3.5).
#[must_use]
pub const fn is_query_byte(byte: u8) -> bool {
    is_pchar(byte) || matches!(byte, b'/' | b'?')
}

/// The value of a hexadecimal digit, in either case (RFC 3986 Section 2.1).
#[must_use]
pub const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte.wrapping_sub(b'0')),
        b'A'..=b'F' => Some(byte.wrapping_sub(b'A').wrapping_add(10)),
        b'a'..=b'f' => Some(byte.wrapping_sub(b'a').wrapping_add(10)),
        _ => None,
    }
}

/// Split a request target into its path and query at the first `?` (RFC 3986
/// Section 3.4); a fragment is not part of a request target.
///
/// # Arguments
///
/// * `target` - the origin-form target, or any path with an optional query.
///
/// # Returns
///
/// The path, and the query without its `?` when there is one.
#[must_use]
pub fn split_query(target: &[u8]) -> (&[u8], Option<&[u8]>) {
    match target.iter().position(|&byte| byte == b'?') {
        Some(at) => (
            target.get(..at).unwrap_or(&[]),
            target.get(at.saturating_add(1)..),
        ),
        None => (target, None),
    }
}

/// The octet a `pct-encoded` triplet at `at` stands for.
///
/// # Arguments
///
/// * `input` - the bytes.
/// * `at` - the offset of the `%`.
///
/// # Errors
///
/// [`UriError::InvalidPercent`] when the two bytes after the `%` are not
/// hexadecimal digits.
pub fn percent_octet(input: &[u8], at: usize) -> Result<u8, UriError> {
    let high = input
        .get(at.saturating_add(1))
        .copied()
        .and_then(hex_value)
        .ok_or(UriError::InvalidPercent(at))?;
    let low = input
        .get(at.saturating_add(2))
        .copied()
        .and_then(hex_value)
        .ok_or(UriError::InvalidPercent(at))?;
    Ok(high.wrapping_shl(4) | low)
}

/// Percent-decode into `out`, appending.
///
/// # Arguments
///
/// * `input` - the bytes, with every `%` starting a `pct-encoded` triplet.
/// * `out` - where the decoded bytes go.
///
/// # Errors
///
/// [`UriError::InvalidPercent`] for a `%` not followed by two hexadecimal digits;
/// `out` may hold a prefix then.
pub fn percent_decode(input: &[u8], out: &mut Vec<u8>) -> Result<(), UriError> {
    let mut at = 0usize;
    while let Some(&byte) = input.get(at) {
        if byte == b'%' {
            out.push(percent_octet(input, at)?);
            at = at.saturating_add(3);
        } else {
            out.push(byte);
            at = at.saturating_add(1);
        }
    }
    Ok(())
}

/// Whether a path is already in the form [`normalize_path`] produces: every
/// percent-encoding valid, no triplet for an unreserved octet, uppercase
/// hexadecimal digits, no dot-segment, and every byte allowed in a path.
fn is_normal_path(path: &[u8]) -> Result<bool, UriError> {
    let mut at = 0usize;
    let mut segment_start = 0usize;
    while let Some(&byte) = path.get(at) {
        match byte {
            b'%' => {
                let octet = percent_octet(path, at)?;
                if is_unreserved(octet) {
                    return Ok(false);
                }
                let digits = path.get(at.saturating_add(1)..at.saturating_add(3));
                if digits.is_some_and(|pair| pair.iter().any(u8::is_ascii_lowercase)) {
                    return Ok(false);
                }
                at = at.saturating_add(3);
            }
            b'/' => {
                if is_dot_segment(path.get(segment_start..at).unwrap_or(&[])) {
                    return Ok(false);
                }
                at = at.saturating_add(1);
                segment_start = at;
            }
            _ if is_pchar(byte) => at = at.saturating_add(1),
            _ => return Err(UriError::InvalidByte(at)),
        }
    }
    Ok(!is_dot_segment(path.get(segment_start..).unwrap_or(&[])))
}

const fn is_dot_segment(segment: &[u8]) -> bool {
    matches!(segment, b"." | b"..")
}

/// Normalize a path for matching: unreserved octets decoded (RFC 3986 Section
/// 2.3 and 6.2.2.2), the hexadecimal digits of the remaining triplets uppercased
/// (Section 2.1 and 6.2.2.1), and dot-segments removed (Section 5.2.4 and
/// 6.2.2.3). Reserved characters stay encoded (Section 2.2).
///
/// # Arguments
///
/// * `path` - the path component, without a query.
/// * `scratch` - space for the result when the path is not already normal; it
///   is cleared first.
///
/// # Returns
///
/// The normalized path: `path` itself when it was already normal, else the
/// contents of `scratch`.
///
/// # Errors
///
/// [`UriError::InvalidPercent`] for a bad triplet, [`UriError::InvalidByte`] for
/// a byte a path cannot hold.
pub fn normalize_path<'a>(path: &'a [u8], scratch: &'a mut Vec<u8>) -> Result<&'a [u8], UriError> {
    if is_normal_path(path)? {
        return Ok(path);
    }
    scratch.clear();
    // First the percent-encoding normalizations into the scratch buffer.
    let mut at = 0usize;
    while let Some(&byte) = path.get(at) {
        if byte == b'%' {
            let octet = percent_octet(path, at)?;
            if is_unreserved(octet) {
                scratch.push(octet);
            } else {
                scratch.push(b'%');
                scratch.push(upper_hex(octet.wrapping_shr(4)));
                scratch.push(upper_hex(octet & 0x0F));
            }
            at = at.saturating_add(3);
        } else {
            scratch.push(byte);
            at = at.saturating_add(1);
        }
    }
    remove_dot_segments(scratch);
    Ok(scratch.as_slice())
}

const fn upper_hex(nibble: u8) -> u8 {
    match nibble & 0x0F {
        0..=9 => b'0'.wrapping_add(nibble & 0x0F),
        other => b'A'.wrapping_add(other.wrapping_sub(10)),
    }
}

/// `remove_dot_segments` (RFC 3986 Section 5.2.4), in place.
///
/// # Arguments
///
/// * `path` - the path; on return it holds the result.
pub fn remove_dot_segments(path: &mut Vec<u8>) {
    let input = core::mem::take(path);
    let mut rest = input.as_slice();
    let output = path;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix(b"../") {
            // A: a leading "../" or "./" is removed.
            rest = after;
        } else if let Some(after) = rest.strip_prefix(b"./") {
            rest = after;
        } else if let Some(after) = rest.strip_prefix(b"/./") {
            // B: "/./" or a final "/." becomes "/".
            rest = after;
            if rest.is_empty() {
                output.push(b'/');
            } else {
                // The "/" is kept in front of the next segment, which E moves.
                rest = complete_with_slash(after, &input);
            }
        } else if rest == b"/." {
            rest = b"/";
        } else if let Some(after) = rest.strip_prefix(b"/../") {
            // C: "/../" or a final "/.." becomes "/" and the last output segment
            // goes.
            pop_segment(output);
            rest = complete_with_slash(after, &input);
        } else if rest == b"/.." {
            pop_segment(output);
            rest = b"/";
        } else if rest == b"." || rest == b".." {
            // D: a bare "." or ".." is removed.
            rest = &[];
        } else {
            // E: the first segment, with its leading "/", moves to the output.
            let start = usize::from(rest.first() == Some(&b'/'));
            let end = rest
                .get(start..)
                .and_then(|tail| tail.iter().position(|&byte| byte == b'/'))
                .map_or(rest.len(), |at| at.saturating_add(start));
            output.extend_from_slice(rest.get(..end).unwrap_or(&[]));
            rest = rest.get(end..).unwrap_or(&[]);
        }
    }
}

/// The input tail beginning at the "/" that step B or C keeps: `after` starts
/// right after that slash, so the slice one byte earlier is what the step leaves
/// in the input buffer.
fn complete_with_slash<'a>(after: &'a [u8], input: &'a [u8]) -> &'a [u8] {
    let offset = input.len().saturating_sub(after.len()).saturating_sub(1);
    input.get(offset..).unwrap_or(&[])
}

fn pop_segment(output: &mut Vec<u8>) {
    match output.iter().rposition(|&byte| byte == b'/') {
        Some(at) => output.truncate(at),
        None => output.clear(),
    }
}

/// Split a URI reference into its components (RFC 3986 Section 3 and 4.1).
///
/// # Arguments
///
/// * `input` - the reference.
///
/// # Returns
///
/// The ranges of the components present.
///
/// # Errors
///
/// [`UriError`] for a byte a component cannot hold, a bad percent-encoding, a
/// scheme outside its grammar, or a path that begins with `//` without an
/// authority.
pub fn parse(input: &[u8]) -> Result<Components, UriError> {
    let mut components = Components::default();
    let mut at = 0usize;
    // A scheme ends at the first ":" that comes before any "/", "?" or "#".
    if let Some(colon) = input
        .iter()
        .position(|&byte| matches!(byte, b':' | b'/' | b'?' | b'#'))
        .filter(|&colon| input.get(colon) == Some(&b':'))
    {
        let scheme = input.get(..colon).unwrap_or(&[]);
        let valid = scheme.first().is_some_and(u8::is_ascii_alphabetic)
            && scheme
                .iter()
                .all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'));
        if !valid {
            return Err(UriError::InvalidScheme);
        }
        components.scheme = Some(0..colon);
        at = colon.saturating_add(1);
    }
    if input.get(at..at.saturating_add(2)) == Some(b"//") {
        let start = at.saturating_add(2);
        let end = input
            .get(start..)
            .and_then(|tail| {
                tail.iter()
                    .position(|&byte| matches!(byte, b'/' | b'?' | b'#'))
            })
            .map_or(input.len(), |len| start.saturating_add(len));
        check_bytes(input, start..end, |byte| {
            is_unreserved(byte) || is_sub_delim(byte) || matches!(byte, b':' | b'@' | b'[' | b']')
        })?;
        components.authority = Some(start..end);
        at = end;
    }
    let path_start = at;
    let path_end = input
        .get(at..)
        .and_then(|tail| tail.iter().position(|&byte| matches!(byte, b'?' | b'#')))
        .map_or(input.len(), |len| at.saturating_add(len));
    check_bytes(input, path_start..path_end, |byte| {
        is_pchar(byte) || byte == b'/'
    })?;
    if components.authority.is_none()
        && input.get(path_start..path_start.saturating_add(2)) == Some(b"//")
    {
        return Err(UriError::InvalidPath);
    }
    components.path = path_start..path_end;
    at = path_end;
    if input.get(at) == Some(&b'?') {
        let start = at.saturating_add(1);
        let end = input
            .get(start..)
            .and_then(|tail| tail.iter().position(|&byte| byte == b'#'))
            .map_or(input.len(), |len| start.saturating_add(len));
        check_bytes(input, start..end, is_query_byte)?;
        components.query = Some(start..end);
        at = end;
    }
    if input.get(at) == Some(&b'#') {
        let start = at.saturating_add(1);
        check_bytes(input, start..input.len(), is_query_byte)?;
        components.fragment = Some(start..input.len());
    }
    Ok(components)
}

/// Check every byte of a component: allowed outright, or a valid triplet.
fn check_bytes(
    input: &[u8],
    range: Range<usize>,
    allowed: impl Fn(u8) -> bool,
) -> Result<(), UriError> {
    let mut at = range.start;
    while at < range.end {
        let Some(&byte) = input.get(at) else {
            break;
        };
        if byte == b'%' {
            percent_octet(input, at)?;
            if at.saturating_add(3) > range.end {
                return Err(UriError::InvalidPercent(at));
            }
            at = at.saturating_add(3);
        } else if allowed(byte) {
            at = at.saturating_add(1);
        } else {
            return Err(UriError::InvalidByte(at));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        normalize_path, parse, percent_decode, remove_dot_segments, split_query, Components,
        UriError,
    };

    fn dots(path: &str) -> alloc::string::String {
        let mut buffer = path.as_bytes().to_vec();
        remove_dot_segments(&mut buffer);
        alloc::string::String::from_utf8(buffer).unwrap_or_default()
    }

    #[test]
    fn remove_dot_segments_follows_the_two_examples_of_section_5_2_4() {
        assert_eq!(dots("/a/b/c/./../../g"), "/a/g");
        assert_eq!(dots("mid/content=5/../6"), "mid/6");
        assert_eq!(dots("/a/../admin"), "/admin");
        assert_eq!(dots("/../a"), "/a");
        assert_eq!(dots("/a/."), "/a/");
        assert_eq!(dots("/a/.."), "/");
        assert_eq!(dots("."), "");
        assert_eq!(dots("./a"), "a");
        assert_eq!(dots("/a/b/../../.."), "/");
        assert_eq!(dots("/a//b/./c"), "/a//b/c");
    }

    #[test]
    fn normalization_decodes_unreserved_octets_uppercases_the_rest_and_keeps_reserved_ones() {
        let mut scratch = Vec::new();
        assert_eq!(
            normalize_path(b"/users/%41%62c", &mut scratch),
            Ok(&b"/users/Abc"[..])
        );
        assert_eq!(
            normalize_path(b"/a%2fb/%2F", &mut scratch),
            Ok(&b"/a%2Fb/%2F"[..]),
            "an encoded slash is data and its digits are uppercased"
        );
        assert_eq!(
            normalize_path(b"/x/%2e%2E/admin", &mut scratch),
            Ok(&b"/admin"[..]),
            "encoded dots are dot-segments once decoded"
        );
        let plain = b"/already/normal%2F";
        let normalized = normalize_path(plain, &mut scratch);
        assert_eq!(normalized, Ok(&plain[..]));
        assert_eq!(
            normalize_path(b"/bad%2", &mut scratch),
            Err(UriError::InvalidPercent(4))
        );
        assert_eq!(
            normalize_path(b"/bad%zz", &mut scratch),
            Err(UriError::InvalidPercent(4))
        );
        assert_eq!(
            normalize_path(b"/sp ace", &mut scratch),
            Err(UriError::InvalidByte(3))
        );
        assert_eq!(
            normalize_path("/caf\u{e9}".as_bytes(), &mut scratch),
            Err(UriError::InvalidByte(4))
        );
    }

    #[test]
    fn percent_decoding_resolves_triplets_and_refuses_a_bare_percent() {
        let mut out = Vec::new();
        assert_eq!(
            percent_decode(b"a%20b%2Fc%zz", &mut out),
            Err(UriError::InvalidPercent(9))
        );
        out.clear();
        assert_eq!(percent_decode(b"a%20b%2Fc%E2%82%AC", &mut out), Ok(()));
        assert_eq!(out, "a b/c\u{20ac}".as_bytes());
    }

    #[test]
    fn the_query_is_split_at_the_first_question_mark() {
        assert_eq!(split_query(b"/a?b=1?c"), (&b"/a"[..], Some(&b"b=1?c"[..])));
        assert_eq!(split_query(b"/a"), (&b"/a"[..], None));
        assert_eq!(split_query(b"/a?"), (&b"/a"[..], Some(&b""[..])));
    }

    #[test]
    fn references_split_into_their_components() {
        let input = b"https://user@host:8080/p/a%20th?q=1#frag";
        assert_eq!(
            parse(input),
            Ok(Components {
                scheme: Some(0..5),
                authority: Some(8..22),
                path: 22..31,
                query: Some(32..35),
                fragment: Some(36..40),
            })
        );
        assert_eq!(
            parse(b"/only/path"),
            Ok(Components {
                path: 0..10,
                ..Components::default()
            })
        );
        assert_eq!(
            parse(b"//host/p"),
            Ok(Components {
                authority: Some(2..6),
                path: 6..8,
                ..Components::default()
            })
        );
        assert_eq!(parse(b"1http://x"), Err(UriError::InvalidScheme));
        assert_eq!(parse(b"mailto:fred@example.com").map(|c| c.path), Ok(7..23));
        assert_eq!(parse(b"/a b"), Err(UriError::InvalidByte(2)));
        assert_eq!(parse(b"/a%2"), Err(UriError::InvalidPercent(2)));
        assert_eq!(
            parse(b"http:////x"),
            Ok(parse(b"http:////x").unwrap_or_default())
        );
        assert_eq!(
            parse(b"/p?q#f#g").map(|c| c.fragment),
            Err(UriError::InvalidByte(6))
        );
    }
}
