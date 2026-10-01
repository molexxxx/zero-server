//! The small value grammars the head parser evaluates: optional whitespace,
//! comma-separated lists, `Content-Length`, and `Host`.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.3>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-7.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6>

/// Returns `true` for SP or HTAB, the octets of `OWS`.
#[must_use]
pub const fn is_ows(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t')
}

/// Strips `OWS` from both ends.
///
/// # Arguments
///
/// * `bytes` - the value.
#[must_use]
pub fn trim_ows(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !is_ows(*byte))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !is_ows(*byte))
        .map_or(start, |last| last.saturating_add(1));
    bytes.get(start..end).unwrap_or(&[])
}

/// Splits a list-based field value on commas, strips `OWS` from each member
/// and drops the empty members Section 5.6.1 has a recipient ignore.
///
/// # Arguments
///
/// * `value` - the field value.
pub fn list_elements(value: &[u8]) -> impl Iterator<Item = &[u8]> {
    value
        .split(|byte| *byte == b',')
        .map(trim_ows)
        .filter(|element| !element.is_empty())
}

/// Parses a `Content-Length` value: `1*DIGIT`, nothing else, with the
/// decimal value held exactly.
///
/// # Arguments
///
/// * `value` - the field value after `OWS` was stripped.
///
/// # Returns
///
/// The length, or `None` when the value is not `1*DIGIT` or exceeds a
/// `u64`, which Section 8.6 has a recipient treat as an error rather than
/// let overflow.
#[must_use]
pub fn parse_content_length(value: &[u8]) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    let mut length = 0u64;
    for byte in value {
        let digit = match byte {
            b'0'..=b'9' => u64::from(byte.wrapping_sub(b'0')),
            _ => return None,
        };
        length = length.checked_mul(10)?.checked_add(digit)?;
    }
    Some(length)
}

/// Returns `true` when `value` is `uri-host [ ":" port ]` (RFC 9110 Section 7.2):
/// an `IP-literal` in brackets holding an IPv6 address or an `IPvFuture`, or a
/// `reg-name` or IPv4 address of unreserved, percent-encoded and sub-delimiter
/// characters, then optionally a colon and a port of digits (RFC 3986 Sections
/// 3.2.2 and 3.2.3).
///
/// Anything else, such as whitespace, a slash, an `@`, a port that is not digits,
/// bytes after an `IP-literal`, or an IPv6 address without its brackets, makes the
/// `Host` field invalid.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-7.2>
/// @see <https://www.rfc-editor.org/rfc/rfc3986.html#section-3.2.2>
///
/// # Arguments
///
/// * `value` - the `Host` value after `OWS` was stripped; empty is valid.
#[must_use]
pub fn is_host_value(value: &[u8]) -> bool {
    let port = if value.first() == Some(&b'[') {
        let Some(close) = value.iter().position(|byte| *byte == b']') else {
            return false;
        };
        let (literal, port) = value.split_at(close.saturating_add(1));
        if !is_ip_literal(literal) {
            return false;
        }
        port
    } else {
        let (host, port) = match value.iter().position(|byte| *byte == b':') {
            Some(colon) => value.split_at(colon),
            None => (value, &[][..]),
        };
        if !is_reg_name(host) {
            return false;
        }
        port
    };
    match port.split_first() {
        None => true,
        Some((b':', digits)) => digits.iter().all(u8::is_ascii_digit),
        Some(_) => false,
    }
}

/// `reg-name`, which covers `IPv4address`: unreserved, percent-encoded and
/// sub-delimiter characters.
fn is_reg_name(bytes: &[u8]) -> bool {
    let mut rest = bytes;
    while let Some((&byte, after)) = rest.split_first() {
        if byte == b'%' {
            match after {
                [high, low, tail @ ..] if high.is_ascii_hexdigit() && low.is_ascii_hexdigit() => {
                    rest = tail;
                }
                _ => return false,
            }
        } else if is_unreserved(byte) || is_sub_delim(byte) {
            rest = after;
        } else {
            return false;
        }
    }
    true
}

/// `IP-literal`: `"[" ( IPv6address / IPvFuture ) "]"`.
fn is_ip_literal(literal: &[u8]) -> bool {
    let Some(inner) = literal
        .strip_prefix(b"[")
        .and_then(|rest| rest.strip_suffix(b"]"))
    else {
        return false;
    };
    match inner.split_first() {
        Some((b'v' | b'V', future)) => {
            let Some(dot) = future.iter().position(|byte| *byte == b'.') else {
                return false;
            };
            let (version, rest) = future.split_at(dot);
            let tail = rest.get(1..).unwrap_or(&[]);
            !version.is_empty()
                && version.iter().all(u8::is_ascii_hexdigit)
                && !tail.is_empty()
                && tail
                    .iter()
                    .all(|&byte| is_unreserved(byte) || is_sub_delim(byte) || byte == b':')
        }
        _ => core::str::from_utf8(inner)
            .ok()
            .and_then(|text| text.parse::<core::net::Ipv6Addr>().ok())
            .is_some(),
    }
}

/// `unreserved`: letters, digits, `-`, `.`, `_` and `~`.
const fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

/// `sub-delims`.
const fn is_sub_delim(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'='
    )
}

/// Returns `true` when `value` is `1*DIGIT`.
#[must_use]
pub fn is_digits(value: &[u8]) -> bool {
    !value.is_empty() && value.iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{is_digits, is_host_value, list_elements, parse_content_length, trim_ows};

    #[test]
    fn optional_whitespace_is_stripped_from_both_ends() {
        assert_eq!(trim_ows(b"  a b\t "), b"a b");
        assert_eq!(trim_ows(b""), b"");
        assert_eq!(trim_ows(b" \t "), b"");
        assert_eq!(trim_ows(b"x"), b"x");
    }

    #[test]
    fn lists_split_on_commas_and_drop_empty_members() {
        let members: Vec<&[u8]> = list_elements(b"foo , ,bar,charlie,").collect();
        assert_eq!(members, [&b"foo"[..], b"bar", b"charlie"]);
        assert_eq!(list_elements(b", ,").count(), 0);
        assert_eq!(list_elements(b"").count(), 0);
    }

    #[test]
    fn content_length_is_digits_only_and_never_overflows() {
        assert_eq!(parse_content_length(b"0"), Some(0));
        assert_eq!(parse_content_length(b"3495"), Some(3495));
        assert_eq!(parse_content_length(b"007"), Some(7));
        assert_eq!(
            parse_content_length(b"18446744073709551615"),
            Some(u64::MAX)
        );
        assert_eq!(parse_content_length(b"18446744073709551616"), None);
        assert_eq!(parse_content_length(b""), None);
        assert_eq!(parse_content_length(b"-1"), None);
        assert_eq!(parse_content_length(b"+1"), None);
        assert_eq!(parse_content_length(b"3 "), None);
        assert_eq!(parse_content_length(b"3,3"), None);
        assert_eq!(parse_content_length(b"0x10"), None);
        assert!(is_digits(b"42"));
        assert!(!is_digits(b""));
        assert!(!is_digits(b"4a"));
    }

    #[test]
    fn host_values_follow_the_uri_host_and_port_grammar() {
        assert!(is_host_value(b"www.example.org"));
        assert!(is_host_value(b"www.example.org:8080"));
        assert!(is_host_value(b"www.example.org:"));
        assert!(is_host_value(b"[::1]:443"));
        assert!(is_host_value(b"[::1]"));
        assert!(is_host_value(b"[::ffff:192.0.2.1]"));
        assert!(is_host_value(b"[v1.fe80::a+en1]"));
        assert!(is_host_value(b"192.0.2.1:80"));
        assert!(is_host_value(b"ex%41mple.org"));
        assert!(is_host_value(b"xn--nxasmq6b.example"));
        assert!(is_host_value(b""));
        assert!(!is_host_value(b"[::1]:abc"));
        assert!(!is_host_value(b"[::1]x"));
        assert!(!is_host_value(b"[::1].evil.example"));
        assert!(!is_host_value(b"[::1"));
        assert!(!is_host_value(b"[example.org]"));
        assert!(!is_host_value(b"[fe80::1%25en1]"));
        assert!(!is_host_value(b"[v.x]"));
        assert!(!is_host_value(b"::1"));
        assert!(!is_host_value(b"a.example:abc"));
        assert!(!is_host_value(b"a.example:80:80"));
        assert!(!is_host_value(b"ex%4mple.org"));
        assert!(!is_host_value(b"a]b"));
        assert!(!is_host_value(b"example.org/path"));
        assert!(!is_host_value(b"a b"));
        assert!(!is_host_value(b"user@example.org"));
        assert!(!is_host_value(b"example.org?x"));
        assert!(!is_host_value(b"example.org#f"));
        assert!(!is_host_value(b"ex\x00ample"));
        assert!(!is_host_value("bücher.example".as_bytes()));
    }
}
