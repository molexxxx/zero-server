//! QUIC variable-length integers, the integer encoding of every HTTP/3 frame
//! type, length, setting, stream type, push ID and capsule field.
//!
//! The two most significant bits of the first octet give the encoded length
//! as a base-2 logarithm, so "integers are encoded on 1, 2, 4, or 8 bytes and
//! can encode 6-, 14-, 30-, or 62-bit values" (RFC 9000 Section 16). The
//! decoder accepts any encoding length for a value: "Values do not need to be
//! encoded on the minimum number of bytes necessary, with the sole exception
//! of the Frame Type field; see Section 12.4", and Section 12.4 is about QUIC
//! frames, not HTTP/3 frames. The encoder always writes the shortest form
//! unless a length is asked for, and refuses values above 2^62-1.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9000.html#section-16>
//! @see <https://www.rfc-editor.org/rfc/rfc9000.html#section-a.1>

use alloc::vec::Vec;

/// The largest value: 2^62-1.
pub const MAX: u64 = 0x3FFF_FFFF_FFFF_FFFF;

/// The longest encoding, in octets.
pub const MAX_LEN: usize = 8;

/// The encoded length the first octet announces.
///
/// # Arguments
///
/// * `first` - the first octet of an encoded integer.
///
/// # Returns
///
/// 1, 2, 4 or 8, from the two most significant bits of `first`.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9000.html#section-16>
#[must_use]
pub const fn len_from_first(first: u8) -> usize {
    match first >> 6 {
        0 => 1,
        1 => 2,
        2 => 4,
        _ => 8,
    }
}

/// Decodes one integer at the start of `input`, as the algorithm of RFC 9000
/// Appendix A.1 does. Non-minimal encodings are accepted.
///
/// # Arguments
///
/// * `input` - the octets from the start of the integer; octets after it are
///   left alone.
///
/// # Returns
///
/// The value and the octets it took, or `None` when `input` holds fewer
/// octets than the first one announces. Every octet string is otherwise a
/// valid encoding, so decoding never fails.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9000.html#section-a.1>
#[must_use]
pub fn decode(input: &[u8]) -> Option<(u64, usize)> {
    let first = *input.first()?;
    match len_from_first(first) {
        1 => Some((u64::from(first), 1)),
        2 => {
            let bytes = input.first_chunk::<2>()?;
            Some((u64::from(u16::from_be_bytes(*bytes) & 0x3FFF), 2))
        }
        4 => {
            let bytes = input.first_chunk::<4>()?;
            Some((u64::from(u32::from_be_bytes(*bytes) & 0x3FFF_FFFF), 4))
        }
        _ => {
            let bytes = input.first_chunk::<8>()?;
            Some((u64::from_be_bytes(*bytes) & MAX, 8))
        }
    }
}

/// The shortest encoded length of `value`.
///
/// # Arguments
///
/// * `value` - the integer to measure.
///
/// # Returns
///
/// 1, 2, 4 or 8, or `None` above [`MAX`].
#[must_use]
pub const fn encoded_len(value: u64) -> Option<usize> {
    match value {
        0..=0x3F => Some(1),
        0x40..=0x3FFF => Some(2),
        0x4000..=0x3FFF_FFFF => Some(4),
        0x4000_0000..=MAX => Some(8),
        _ => None,
    }
}

/// Writes the shortest encoding of `value` at the start of `out`.
///
/// # Arguments
///
/// * `value` - the integer, at most [`MAX`].
/// * `out` - the buffer to write at the start of; [`MAX_LEN`] octets always
///   suffice.
///
/// # Returns
///
/// The octets written, or `None` above [`MAX`] or when `out` is too short, in
/// which case nothing was written.
pub fn encode(value: u64, out: &mut [u8]) -> Option<usize> {
    encode_with_len(value, encoded_len(value)?, out)
}

/// Writes `value` on exactly `len` octets, which may be longer than the
/// shortest form; HTTP/3 accepts such encodings, so tests and intermediaries
/// that preserve them use this.
///
/// # Arguments
///
/// * `value` - the integer.
/// * `len` - the encoded length: 1, 2, 4 or 8.
/// * `out` - the buffer to write at the start of.
///
/// # Returns
///
/// `len`, or `None` when `len` is not 1, 2, 4 or 8, `value` does not fit in
/// `len` octets, or `out` is too short, in which case nothing was written.
pub fn encode_with_len(value: u64, len: usize, out: &mut [u8]) -> Option<usize> {
    let mut bytes = [0u8; MAX_LEN];
    match len {
        1 => {
            let byte = u8::try_from(value).ok().filter(|byte| *byte <= 0x3F)?;
            *bytes.first_mut()? = byte;
        }
        2 => {
            let short = u16::try_from(value).ok().filter(|short| *short <= 0x3FFF)?;
            bytes
                .first_chunk_mut::<2>()?
                .copy_from_slice(&(short | 0x4000).to_be_bytes());
        }
        4 => {
            let word = u32::try_from(value)
                .ok()
                .filter(|word| *word <= 0x3FFF_FFFF)?;
            bytes
                .first_chunk_mut::<4>()?
                .copy_from_slice(&(word | 0x8000_0000).to_be_bytes());
        }
        8 => {
            if value > MAX {
                return None;
            }
            bytes = (value | 0xC000_0000_0000_0000).to_be_bytes();
        }
        _ => return None,
    }
    out.get_mut(..len)?.copy_from_slice(bytes.get(..len)?);
    Some(len)
}

/// Appends the shortest encoding of `value`.
///
/// # Arguments
///
/// * `value` - the integer, at most [`MAX`].
/// * `out` - the buffer the encoding is appended to.
///
/// # Returns
///
/// `None` above [`MAX`], in which case `out` is unchanged.
pub fn push(value: u64, out: &mut Vec<u8>) -> Option<()> {
    let mut bytes = [0u8; MAX_LEN];
    let len = encode(value, &mut bytes)?;
    out.extend_from_slice(bytes.get(..len)?);
    Some(())
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{decode, encode, encode_with_len, encoded_len, len_from_first, push, MAX, MAX_LEN};
    use crate::xorshift::{iterations, unhex, Rng};

    /// RFC 9000 Appendix A.1: "For example, the eight-byte sequence
    /// 0xc2197c5eff14e88c decodes to the decimal value 151,288,809,941,952,652;
    /// the four-byte sequence 0x9d7f3e7d decodes to 494,878,333; the two-byte
    /// sequence 0x7bbd decodes to 15,293; and the single byte 0x25 decodes to 37
    /// (as does the two-byte sequence 0x4025)."
    #[test]
    fn varints_decode_as_the_rfc_9000_appendix_a_1_examples() {
        let cases: [(&str, u64); 5] = [
            ("c2197c5eff14e88c", 151_288_809_941_952_652),
            ("9d7f3e7d", 494_878_333),
            ("7bbd", 15_293),
            ("25", 37),
            ("4025", 37),
        ];
        for (encoded, value) in cases {
            let bytes = unhex(encoded);
            assert_eq!(decode(&bytes), Some((value, bytes.len())), "{encoded}");
            let mut longer = bytes.clone();
            longer.extend_from_slice(&[0xAB, 0xCD]);
            assert_eq!(decode(&longer), Some((value, bytes.len())), "{encoded}");
            assert_eq!(
                decode(bytes.get(..bytes.len().saturating_sub(1)).unwrap_or(&[])),
                None,
                "{encoded}"
            );
        }
        for (encoded, value) in cases.iter().take(4) {
            let mut out = Vec::new();
            assert_eq!(push(*value, &mut out), Some(()));
            assert_eq!(out, unhex(encoded), "the shortest form of {value}");
        }
        let mut out = [0u8; 2];
        assert_eq!(encode_with_len(37, 2, &mut out), Some(2));
        assert_eq!(out, [0x40, 0x25]);
    }

    /// RFC 9000 Section 16: "This means that integers are encoded on 1, 2, 4, or
    /// 8 bytes and can encode 6-, 14-, 30-, or 62-bit values, respectively."
    #[test]
    fn varints_use_1_2_4_or_8_bytes_for_6_14_30_or_62_bit_values() {
        let cases: [(u64, &str); 8] = [
            (0, "00"),
            (63, "3f"),
            (64, "4040"),
            (16_383, "7fff"),
            (16_384, "80004000"),
            (1_073_741_823, "bfffffff"),
            (1_073_741_824, "c000000040000000"),
            (4_611_686_018_427_387_903, "ffffffffffffffff"),
        ];
        for (value, encoded) in cases {
            let bytes = unhex(encoded);
            let mut out = [0u8; MAX_LEN];
            assert_eq!(encode(value, &mut out), Some(bytes.len()), "{value}");
            assert_eq!(out.get(..bytes.len()), Some(bytes.as_slice()), "{value}");
            assert_eq!(encoded_len(value), Some(bytes.len()), "{value}");
            assert_eq!(decode(&bytes), Some((value, bytes.len())), "{value}");
            assert_eq!(
                len_from_first(bytes.first().copied().unwrap_or(0)),
                bytes.len()
            );
        }
        assert_eq!(MAX, 4_611_686_018_427_387_903);
        for refused in [4_611_686_018_427_387_904, u64::MAX] {
            let mut out = [0u8; MAX_LEN];
            assert_eq!(encoded_len(refused), None);
            assert_eq!(encode(refused, &mut out), None);
            assert_eq!(out, [0u8; MAX_LEN]);
            let mut buffer = alloc::vec![7u8];
            assert_eq!(push(refused, &mut buffer), None);
            assert_eq!(buffer, [7u8]);
            assert_eq!(encode_with_len(refused, 8, &mut out), None);
        }
    }

    /// RFC 9000 Section 16: "integers are encoded on 1, 2, 4, or 8 bytes and
    /// can encode 6-, 14-, 30-, or 62-bit values, respectively", so any other
    /// length, or a value too large for the length asked, is refused.
    #[test]
    fn encode_with_len_refuses_values_that_do_not_fit_and_lengths_that_are_not_1_2_4_or_8() {
        let mut out = [0u8; MAX_LEN];
        assert_eq!(encode_with_len(64, 1, &mut out), None);
        assert_eq!(encode_with_len(16_384, 2, &mut out), None);
        assert_eq!(encode_with_len(1_073_741_824, 4, &mut out), None);
        for len in [0usize, 3, 5, 6, 7, 9, 16] {
            assert_eq!(encode_with_len(1, len, &mut out), None, "{len}");
        }
        assert_eq!(out, [0u8; MAX_LEN]);
        assert_eq!(encode_with_len(0, 8, &mut out), Some(8));
        assert_eq!(out, [0xC0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(decode(&out), Some((0, 8)));
        let mut short = [0u8; 3];
        assert_eq!(encode(16_384, &mut short), None);
        assert_eq!(short, [0u8; 3]);
        assert_eq!(decode(&[]), None);
    }

    /// RFC 9000 Section 16: "Values do not need to be encoded on the minimum
    /// number of bytes necessary", so every value round trips at each length
    /// from its shortest up to 8 bytes.
    #[test]
    fn random_varints_round_trip_at_every_encoded_length() {
        let mut rng = Rng::new(0x5EED_0001);
        for _ in 0..iterations(20_000) {
            let value = rng.varint();
            let shortest = encoded_len(value).unwrap_or(0);
            for len in [1usize, 2, 4, 8] {
                let mut out = [0u8; MAX_LEN];
                match encode_with_len(value, len, &mut out) {
                    Some(written) => {
                        assert!(len >= shortest, "{value} on {len}");
                        assert_eq!(written, len);
                        assert_eq!(decode(&out), Some((value, len)), "{value} on {len}");
                    }
                    None => assert!(len < shortest, "{value} on {len}"),
                }
            }
        }
    }

    /// RFC 9000 Section 16: the two most significant bits of the first byte
    /// give "the base-2 logarithm of the integer encoding length in bytes";
    /// arbitrary octets decode without panicking to that length, or to
    /// nothing while fewer octets are present.
    #[test]
    fn arbitrary_octets_decode_without_panicking_and_within_the_input() {
        let mut rng = Rng::new(0x5EED_0002);
        for _ in 0..iterations(20_000) {
            let input = rng.bytes(12);
            if let Some((value, len)) = decode(&input) {
                assert!(value <= MAX);
                assert!(len <= input.len());
                assert_eq!(len, len_from_first(input.first().copied().unwrap_or(0)));
            } else {
                let needed = input.first().map_or(1, |first| len_from_first(*first));
                assert!(input.len() < needed);
            }
        }
    }
}
