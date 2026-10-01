//! The byte classes and the plain per-byte loops that define every kernel.
//!
//! These functions are the specification: one byte at a time, no tricks. The
//! SWAR kernels are property-tested against them and the SIMD kernels against
//! the SWAR kernels, so a kernel is correct exactly when it agrees with this
//! module on every input.
//!
//! The byte classes are those of RFC 9110: `tchar` from Section 5.6.2 and the
//! field-value octets (`field-vchar`, SP and HTAB) from Section 5.5; the
//! request-target class is the visible US-ASCII range the request line of RFC
//! 9112 Section 3 allows between its single spaces.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>

/// Returns `true` for a byte a request-target may hold: visible US-ASCII,
/// 0x21 to 0x7E.
#[must_use]
pub const fn is_target_byte(byte: u8) -> bool {
    matches!(byte, 0x21..=0x7E)
}

/// Returns `true` for a `tchar`, the bytes a field name or method token may
/// hold.
#[must_use]
pub const fn is_tchar(byte: u8) -> bool {
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

/// Returns `true` for a byte a field value may hold: `field-vchar` (visible
/// US-ASCII and obs-text) plus the interior SP and HTAB.
#[must_use]
pub const fn is_value_byte(byte: u8) -> bool {
    matches!(byte, 0x09 | 0x20..=0x7E | 0x80..=0xFF)
}

/// Returns the length of the longest prefix of `bytes` whose every byte
/// satisfies `allowed`.
///
/// # Arguments
///
/// * `bytes` - the input.
/// * `allowed` - the byte class.
#[must_use]
pub fn scan(bytes: &[u8], allowed: fn(u8) -> bool) -> usize {
    bytes
        .iter()
        .position(|byte| !allowed(*byte))
        .unwrap_or(bytes.len())
}

/// Returns the length of the request-target prefix of `bytes`.
#[must_use]
pub fn scan_target(bytes: &[u8]) -> usize {
    scan(bytes, is_target_byte)
}

/// Returns the length of the token prefix of `bytes`.
#[must_use]
pub fn scan_header_name(bytes: &[u8]) -> usize {
    scan(bytes, is_tchar)
}

/// Returns the length of the field-value prefix of `bytes`.
#[must_use]
pub fn scan_header_value(bytes: &[u8]) -> usize {
    scan(bytes, is_value_byte)
}

/// Returns the index of the first `needle` in `haystack`.
#[must_use]
pub fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
    haystack.iter().position(|byte| *byte == needle)
}

/// Returns the index of the first CR or LF in `haystack`.
#[must_use]
pub fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
    haystack
        .iter()
        .position(|byte| matches!(byte, b'\r' | b'\n'))
}

/// XORs every byte of `payload` with the masking key, the byte at index `i`
/// with `key[i mod 4]`.
///
/// # Arguments
///
/// * `payload` - the masked bytes, unmasked in place.
/// * `key` - the four-byte masking key.
pub fn unmask(payload: &mut [u8], key: [u8; 4]) {
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= key.get(index & 3).copied().unwrap_or_default();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        find_byte, find_cr_or_lf, is_target_byte, is_tchar, is_value_byte, scan_header_name,
        scan_header_value, scan_target, unmask,
    };

    #[test]
    fn the_byte_classes_are_the_rfc_9110_sets() {
        let delimiters = b"\"(),/:;<=>?@[\\]{}";
        for byte in 0u8..=255 {
            let visible = (0x21..=0x7E).contains(&byte);
            assert_eq!(is_target_byte(byte), visible, "{byte:#04x}");
            assert_eq!(
                is_tchar(byte),
                visible && !delimiters.contains(&byte),
                "{byte:#04x}"
            );
            assert_eq!(
                is_value_byte(byte),
                byte == 0x09 || (0x20..=0x7E).contains(&byte) || byte >= 0x80,
                "{byte:#04x}"
            );
        }
    }

    #[test]
    fn scans_stop_at_the_first_excluded_byte() {
        assert_eq!(scan_target(b"/index.html HTTP/1.1"), 11);
        assert_eq!(scan_target(b""), 0);
        assert_eq!(scan_target(b"/a"), 2);
        assert_eq!(scan_header_name(b"Host: x"), 4);
        assert_eq!(scan_header_value(b"text/html\r\n"), 9);
        assert_eq!(scan_header_value(b"a\tb\x7F"), 3);
        assert_eq!(find_byte(b"abc", b'c'), Some(2));
        assert_eq!(find_byte(b"abc", b'd'), None);
        assert_eq!(find_cr_or_lf(b"ab\ncd\r\n"), Some(2));
        assert_eq!(find_cr_or_lf(b"abcd"), None);
    }

    #[test]
    fn unmask_cycles_the_key() {
        let mut payload = [0u8; 6];
        unmask(&mut payload, [1, 2, 3, 4]);
        assert_eq!(payload, [1, 2, 3, 4, 1, 2]);
        unmask(&mut payload, [1, 2, 3, 4]);
        assert_eq!(payload, [0; 6]);
    }
}
