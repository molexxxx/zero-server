//! The small value grammars the head parser evaluates: optional whitespace,
//! comma-separated lists, `Content-Length`, and the bytes a `Host` value may
//! hold.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.3>
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

/// Returns `true` when every byte could belong to `uri-host [ ":" port ]`:
/// the unreserved, sub-delimiter, percent, colon and bracket characters.
///
/// A byte outside that set, including whitespace, a slash, a query or
/// fragment delimiter, an `@` or a control character, cannot be part of a
/// `Host` value, so the field is invalid. The full `uri-host` grammar is
/// applied where the authority is resolved.
///
/// # Arguments
///
/// * `value` - the `Host` value after `OWS` was stripped; empty is valid.
#[must_use]
pub fn is_host_value(value: &[u8]) -> bool {
    value.iter().all(|byte| {
        matches!(
            byte,
            b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'.'
                | b'_'
                | b'~'
                | b'%'
                | b'!'
                | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b':'
                | b'['
                | b']'
        )
    })
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
    fn host_values_hold_only_authority_characters() {
        assert!(is_host_value(b"www.example.org"));
        assert!(is_host_value(b"www.example.org:8080"));
        assert!(is_host_value(b"[::1]:443"));
        assert!(is_host_value(b"xn--nxasmq6b.example"));
        assert!(is_host_value(b""));
        assert!(!is_host_value(b"example.org/path"));
        assert!(!is_host_value(b"a b"));
        assert!(!is_host_value(b"user@example.org"));
        assert!(!is_host_value(b"example.org?x"));
        assert!(!is_host_value(b"example.org#f"));
        assert!(!is_host_value(b"ex\x00ample"));
        assert!(!is_host_value("bücher.example".as_bytes()));
    }
}
