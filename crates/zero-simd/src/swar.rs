//! The SWAR kernels: eight bytes per step in a `u64`, safe code only.
//!
//! Every byte test below produces an exact per-byte mask, with the high bit
//! of a lane set when and only when that lane's byte matches, so masks can be
//! combined with `&`, `|` and `!` and the first flagged lane is the first
//! matching byte. The classic "has zero byte" formula is not used because its
//! borrow can set the high bit of lanes after the first match.
//!
//! These kernels are the reference every SIMD kernel is tested against, and
//! the path every target without a SIMD kernel runs.

use crate::scalar;

const LO: u64 = 0x0101_0101_0101_0101;
const HI: u64 = 0x8080_8080_8080_8080;
const LO7: u64 = 0x7F7F_7F7F_7F7F_7F7F;
const LANES: usize = 8;

/// Repeats a byte into every lane.
#[inline]
const fn repeat(byte: u8) -> u64 {
    (byte as u64).wrapping_mul(LO)
}

/// Returns the lanes whose byte equals `byte`.
#[inline]
const fn eq_mask(word: u64, byte: u8) -> u64 {
    let diff = word ^ repeat(byte);
    !(((diff & LO7).wrapping_add(LO7)) | diff | LO7)
}

/// Returns the lanes whose byte is below `bound`, for a bound of at most
/// 0x80; a lane at or above 0x80 is never flagged.
#[inline]
const fn lt_mask(word: u64, bound: u8) -> u64 {
    let offset = repeat(0x80u8.wrapping_sub(bound));
    !(((word & LO7).wrapping_add(offset)) | word) & HI
}

/// Returns the index of the first flagged lane, reading the word as
/// little-endian so lane 0 is the first byte of the chunk.
#[inline]
const fn first_lane(mask: u64) -> Option<usize> {
    if mask == 0 {
        None
    } else {
        Some((mask.trailing_zeros() as usize).wrapping_shr(3))
    }
}

/// Loads a chunk of exactly eight bytes as a little-endian word.
#[inline]
fn load(chunk: &[u8]) -> u64 {
    u64::from_le_bytes(<[u8; LANES]>::try_from(chunk).unwrap_or_default())
}

/// Runs `flag` over every eight-byte chunk and returns the index of the
/// first flagged byte, falling back to `tail` for the remainder.
#[inline]
fn position(
    bytes: &[u8],
    flag: impl Fn(u64) -> u64,
    tail: impl Fn(&[u8]) -> Option<usize>,
) -> Option<usize> {
    let mut chunks = bytes.chunks_exact(LANES);
    let mut offset = 0usize;
    for chunk in &mut chunks {
        if let Some(lane) = first_lane(flag(load(chunk))) {
            return Some(offset.saturating_add(lane));
        }
        offset = offset.saturating_add(LANES);
    }
    tail(chunks.remainder()).map(|index| offset.saturating_add(index))
}

/// Returns the length of the ASCII prefix of `bytes`: every byte below 0x80.
#[must_use]
pub fn scan_ascii(bytes: &[u8]) -> usize {
    position(bytes, non_ascii_mask, |tail| {
        tail.iter().position(|byte| *byte >= 0x80)
    })
    .unwrap_or(bytes.len())
}

/// Returns the length of the request-target prefix of `bytes`: every byte
/// 0x21 to 0x7E.
#[must_use]
pub fn scan_target(bytes: &[u8]) -> usize {
    position(
        bytes,
        |word| lt_mask(word, 0x21) | eq_mask(word, 0x7F) | (word & HI),
        |tail| tail.iter().position(|byte| !scalar::is_target_byte(*byte)),
    )
    .unwrap_or(bytes.len())
}

/// Returns the length of the token prefix of `bytes`.
///
/// The token class is irregular, so this path tests one byte at a time; the
/// SIMD kernels classify it with nibble lookups.
#[must_use]
pub fn scan_header_name(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .position(|byte| !scalar::is_tchar(*byte))
        .unwrap_or(bytes.len())
}

/// Returns the length of the field-value prefix of `bytes`: every byte that
/// is 0x09, 0x20 to 0x7E or 0x80 to 0xFF.
#[must_use]
pub fn scan_header_value(bytes: &[u8]) -> usize {
    position(
        bytes,
        |word| (lt_mask(word, 0x20) & !eq_mask(word, 0x09)) | eq_mask(word, 0x7F),
        |tail| tail.iter().position(|byte| !scalar::is_value_byte(*byte)),
    )
    .unwrap_or(bytes.len())
}

/// Returns the index of the first `needle` in `haystack`.
#[must_use]
pub fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
    position(
        haystack,
        |word| eq_mask(word, needle),
        |tail| scalar::find_byte(tail, needle),
    )
}

/// Returns the index of the first CR or LF in `haystack`.
#[must_use]
pub fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
    position(
        haystack,
        |word| eq_mask(word, b'\r') | eq_mask(word, b'\n'),
        scalar::find_cr_or_lf,
    )
}

/// Returns the lanes whose byte has its high bit set; zero means the word is
/// pure ASCII.
#[inline]
#[must_use]
pub const fn non_ascii_mask(word: u64) -> u64 {
    word & HI
}

/// XORs every byte of `payload` with the masking key, eight bytes per step.
///
/// # Arguments
///
/// * `payload` - the masked bytes, unmasked in place.
/// * `key` - the four-byte masking key, applied from the first byte.
pub fn unmask(payload: &mut [u8], key: [u8; 4]) {
    let [k0, k1, k2, k3] = key;
    let key_word = u64::from_ne_bytes([k0, k1, k2, k3, k0, k1, k2, k3]);
    let mut chunks = payload.chunks_exact_mut(LANES);
    for chunk in &mut chunks {
        let word = u64::from_ne_bytes(<[u8; LANES]>::try_from(&*chunk).unwrap_or_default());
        chunk.copy_from_slice(&(word ^ key_word).to_ne_bytes());
    }
    scalar::unmask(chunks.into_remainder(), key);
}

#[cfg(test)]
mod tests {
    use super::{
        eq_mask, find_byte, find_cr_or_lf, first_lane, lt_mask, non_ascii_mask, scan_ascii,
        scan_header_name, scan_header_value, scan_target, unmask, HI,
    };
    use crate::scalar;
    use crate::test_support::{grid_bytes, iterations, Rng};

    #[test]
    fn masks_are_exact_per_lane() {
        for byte in grid_bytes() {
            for lane in 0..8usize {
                let mut chunk = [b'a'; 8];
                if let Some(slot) = chunk.get_mut(lane) {
                    *slot = byte;
                }
                let word = u64::from_le_bytes(chunk);
                let expected = |flag: bool| {
                    if flag {
                        HI & (0x80u64 << lane.wrapping_mul(8))
                    } else {
                        0
                    }
                };
                let a_flag = |flag: bool| {
                    if flag {
                        HI & !(0xFFu64 << lane.wrapping_mul(8))
                    } else {
                        0
                    }
                };
                assert_eq!(
                    eq_mask(word, byte) & !a_flag(byte == b'a'),
                    expected(true),
                    "eq {byte:#04x} lane {lane}"
                );
                assert_eq!(
                    eq_mask(word, 0x7F) & !a_flag(false),
                    expected(byte == 0x7F),
                    "eq7f {byte:#04x} lane {lane}"
                );
                assert_eq!(
                    lt_mask(word, 0x20),
                    expected(byte < 0x20),
                    "lt20 {byte:#04x} lane {lane}"
                );
                assert_eq!(
                    lt_mask(word, 0x21),
                    expected(byte < 0x21),
                    "lt21 {byte:#04x} lane {lane}"
                );
                assert_eq!(
                    lt_mask(word, 0x80),
                    expected(byte < 0x80) | a_flag(true),
                    "lt80 {byte:#04x} lane {lane}"
                );
                assert_eq!(
                    non_ascii_mask(word),
                    expected(byte >= 0x80),
                    "hi {byte:#04x} lane {lane}"
                );
                assert_eq!(first_lane(expected(true)), Some(lane));
            }
        }
        assert_eq!(first_lane(0), None);
    }

    #[test]
    fn every_byte_at_every_position_agrees_with_the_scalar_reference() {
        for byte in grid_bytes() {
            for position in 0..24usize {
                let mut buffer = [b'a'; 24];
                if let Some(slot) = buffer.get_mut(position) {
                    *slot = byte;
                }
                assert_eq!(
                    scan_ascii(&buffer),
                    scalar::scan_ascii(&buffer),
                    "{byte:#04x}@{position}"
                );
                assert_eq!(
                    scan_target(&buffer),
                    scalar::scan_target(&buffer),
                    "{byte:#04x}@{position}"
                );
                assert_eq!(
                    scan_header_name(&buffer),
                    scalar::scan_header_name(&buffer),
                    "{byte:#04x}@{position}"
                );
                assert_eq!(
                    scan_header_value(&buffer),
                    scalar::scan_header_value(&buffer),
                    "{byte:#04x}@{position}"
                );
                assert_eq!(
                    find_byte(&buffer, byte),
                    scalar::find_byte(&buffer, byte),
                    "{byte:#04x}@{position}"
                );
                assert_eq!(
                    find_byte(&buffer, b'z'),
                    scalar::find_byte(&buffer, b'z'),
                    "{byte:#04x}@{position}"
                );
                assert_eq!(
                    find_cr_or_lf(&buffer),
                    scalar::find_cr_or_lf(&buffer),
                    "{byte:#04x}@{position}"
                );
            }
        }
    }

    #[test]
    fn random_inputs_agree_with_the_scalar_reference() {
        let mut rng = Rng::new(0x5EED_0001);
        for _ in 0..iterations(20_000) {
            let bytes = rng.bytes(0..=80);
            assert_eq!(scan_ascii(&bytes), scalar::scan_ascii(&bytes), "{bytes:?}");
            assert_eq!(
                scan_target(&bytes),
                scalar::scan_target(&bytes),
                "{bytes:?}"
            );
            assert_eq!(
                scan_header_name(&bytes),
                scalar::scan_header_name(&bytes),
                "{bytes:?}"
            );
            assert_eq!(
                scan_header_value(&bytes),
                scalar::scan_header_value(&bytes),
                "{bytes:?}"
            );
            let needle = rng.byte();
            assert_eq!(
                find_byte(&bytes, needle),
                scalar::find_byte(&bytes, needle),
                "{bytes:?}"
            );
            assert_eq!(
                find_cr_or_lf(&bytes),
                scalar::find_cr_or_lf(&bytes),
                "{bytes:?}"
            );
        }
    }

    #[test]
    fn unmask_agrees_with_the_scalar_reference_and_inverts_itself() {
        let mut rng = Rng::new(0x5EED_0002);
        for _ in 0..iterations(5_000) {
            let original = rng.bytes(0..=70);
            let key = [rng.byte(), rng.byte(), rng.byte(), rng.byte()];
            let mut swar = original.clone();
            let mut reference = original.clone();
            unmask(&mut swar, key);
            scalar::unmask(&mut reference, key);
            assert_eq!(swar, reference);
            unmask(&mut swar, key);
            assert_eq!(swar, original);
        }
    }
}
