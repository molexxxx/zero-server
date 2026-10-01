//! Cached CPU feature detection and the SIMD and SWAR kernels of zero-server.
//!
//! The kernels are the request-target scan, the header-name and header-value
//! scans, CR and LF search, byte search, the WebSocket XOR unmask, and a
//! streaming UTF-8 validator that resumes across WebSocket fragments. The
//! plain per-byte loops of [`scalar`] define each kernel; the SWAR kernels of
//! [`swar`] are property-tested against them and are the reference every
//! SIMD kernel is property-tested against in turn. The functions at the crate
//! root dispatch on the cached [`Features`] token.
//!
//! This is the one no_std crate allowed `unsafe`: the dispatch call site and
//! every pointer-taking load and store inside a SIMD kernel carry a
//! `// SAFETY:` comment stating the bounds check that precedes them. The SWAR
//! kernels, the validator and the detection token are safe code.
//!
//! The primary items are:
//!
//! - [`scan_target`], [`scan_header_name`], [`scan_header_value`] - the
//!   length of the prefix in a byte class.
//! - [`find_byte`] and [`find_cr_or_lf`] - byte search.
//! - [`unmask`] - the WebSocket masking XOR.
//! - [`Utf8Validator`], [`validate_utf8`] and [`Utf8Error`] - UTF-8.
//! - [`Features`] - the cached detection token.
//! - [`VERSION`] - the version of the crate.
//!
//! # Examples
//!
//! ```
//! use zero_simd::{find_cr_or_lf, scan_header_name, validate_utf8, Utf8Validator};
//!
//! let line = b"Content-Length: 12\r\n";
//! assert_eq!(scan_header_name(line), 14);
//! assert_eq!(find_cr_or_lf(line), Some(18));
//!
//! assert!(validate_utf8("κόσμε".as_bytes()).is_ok());
//! let mut validator = Utf8Validator::new();
//! assert!(validator.feed(&[0xCE]).is_ok());
//! assert!(validator.feed(&[0xBA]).is_ok());
//! assert!(validator.finish(1).is_ok());
//! ```

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod detect;
pub mod scalar;
pub mod swar;
pub mod utf8;

#[cfg(test)]
pub(crate) mod test_support;

pub use detect::Features;
pub use utf8::{validate_utf8, Utf8Error, Utf8Validator};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Returns the length of the request-target prefix of `bytes`: every byte
/// 0x21 to 0x7E.
///
/// # Arguments
///
/// * `bytes` - the input, starting at the request target.
#[must_use]
pub fn scan_target(bytes: &[u8]) -> usize {
    swar::scan_target(bytes)
}

/// Returns the length of the token prefix of `bytes`: every `tchar`.
///
/// # Arguments
///
/// * `bytes` - the input, starting at a field name or method.
#[must_use]
pub fn scan_header_name(bytes: &[u8]) -> usize {
    swar::scan_header_name(bytes)
}

/// Returns the length of the field-value prefix of `bytes`: every byte that
/// is HTAB, SP, visible US-ASCII or obs-text.
///
/// # Arguments
///
/// * `bytes` - the input, starting at a field value.
#[must_use]
pub fn scan_header_value(bytes: &[u8]) -> usize {
    swar::scan_header_value(bytes)
}

/// Returns the index of the first `needle` in `haystack`.
///
/// # Arguments
///
/// * `haystack` - the bytes to search.
/// * `needle` - the byte to find.
#[must_use]
pub fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
    swar::find_byte(haystack, needle)
}

/// Returns the index of the first CR or LF in `haystack`.
///
/// # Arguments
///
/// * `haystack` - the bytes to search.
#[must_use]
pub fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
    swar::find_cr_or_lf(haystack)
}

/// XORs every byte of `payload` with the masking key, in place.
///
/// # Arguments
///
/// * `payload` - the masked bytes.
/// * `key` - the four-byte masking key, applied from the first byte; use
///   [`rotate_key`] when `payload` starts in the middle of a message.
pub fn unmask(payload: &mut [u8], key: [u8; 4]) {
    swar::unmask(payload, key);
}

/// Returns the masking key as it applies from byte `offset` of a message, so
/// a fragment can be unmasked on its own.
///
/// # Arguments
///
/// * `key` - the message's masking key.
/// * `offset` - the number of message bytes before the fragment.
#[must_use]
pub const fn rotate_key(key: [u8; 4], offset: usize) -> [u8; 4] {
    let [k0, k1, k2, k3] = key;
    match offset & 3 {
        0 => [k0, k1, k2, k3],
        1 => [k1, k2, k3, k0],
        2 => [k2, k3, k0, k1],
        _ => [k3, k0, k1, k2],
    }
}

#[cfg(test)]
mod tests {
    use super::{rotate_key, scalar, unmask};
    use crate::test_support::Rng;

    #[test]
    fn a_rotated_key_unmasks_a_fragment_in_place() {
        let mut rng = Rng::new(0x5EED_0020);
        for _ in 0..2_000 {
            let message = rng.bytes(0..=64);
            let key = [rng.byte(), rng.byte(), rng.byte(), rng.byte()];
            let split = rng.len(0..=message.len());
            let mut whole = message.clone();
            scalar::unmask(&mut whole, key);
            let (head, tail) = message.split_at(split);
            let mut head = head.to_vec();
            let mut tail = tail.to_vec();
            unmask(&mut head, key);
            unmask(&mut tail, rotate_key(key, split));
            head.extend_from_slice(&tail);
            assert_eq!(head, whole);
        }
        assert_eq!(rotate_key([1, 2, 3, 4], 5), [2, 3, 4, 1]);
    }
}
