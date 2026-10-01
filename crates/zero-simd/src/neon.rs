//! The AArch64 kernels over NEON, 16 bytes per step.
//!
//! Each kernel classifies a chunk with unsigned compares, narrows the lane
//! mask to four bits per lane with a shift-and-narrow, and takes the first
//! set nibble as the first matching byte, falling back to the SWAR kernel for
//! the bytes after the last full chunk. The unsafe operations are the loads
//! and stores through a chunk's pointer, each preceded by the bounds the
//! chunk iterator guarantees, and the calls into the kernels, which require
//! NEON; the dispatch functions at this module's root call them only on a
//! target compiled with NEON, which every AArch64 target of this workspace
//! is.

/// Returns the position of the first excluded byte of `tail` as the SWAR
/// kernel reports it, or `None` when every byte belongs to the class.
#[inline]
fn tail_position(tail: &[u8], prefix: usize) -> Option<usize> {
    (prefix < tail.len()).then_some(prefix)
}

/// Returns the length of the ASCII prefix of `bytes`.
#[allow(unsafe_code)]
#[must_use]
pub fn scan_ascii(bytes: &[u8]) -> usize {
    // SAFETY: NEON is enabled at compile time for every AArch64 target this
    // crate builds for, which the kernel requires.
    unsafe { kernels::scan_ascii(bytes) }
}

/// Returns the length of the request-target prefix of `bytes`.
#[allow(unsafe_code)]
#[must_use]
pub fn scan_target(bytes: &[u8]) -> usize {
    // SAFETY: NEON is enabled at compile time for every AArch64 target this
    // crate builds for, which the kernel requires.
    unsafe { kernels::scan_target(bytes) }
}

/// Returns the length of the token prefix of `bytes`.
#[allow(unsafe_code)]
#[must_use]
pub fn scan_header_name(bytes: &[u8]) -> usize {
    // SAFETY: NEON is enabled at compile time for every AArch64 target this
    // crate builds for, which the kernel requires.
    unsafe { kernels::scan_header_name(bytes) }
}

/// Returns the length of the field-value prefix of `bytes`.
#[allow(unsafe_code)]
#[must_use]
pub fn scan_header_value(bytes: &[u8]) -> usize {
    // SAFETY: NEON is enabled at compile time for every AArch64 target this
    // crate builds for, which the kernel requires.
    unsafe { kernels::scan_header_value(bytes) }
}

/// Returns the index of the first `needle` in `haystack`.
#[allow(unsafe_code)]
#[must_use]
pub fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
    // SAFETY: NEON is enabled at compile time for every AArch64 target this
    // crate builds for, which the kernel requires.
    unsafe { kernels::find_byte(haystack, needle) }
}

/// Returns the index of the first CR or LF in `haystack`.
#[allow(unsafe_code)]
#[must_use]
pub fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
    // SAFETY: NEON is enabled at compile time for every AArch64 target this
    // crate builds for, which the kernel requires.
    unsafe { kernels::find_cr_or_lf(haystack) }
}

/// XORs every byte of `payload` with the masking key, in place.
#[allow(unsafe_code)]
pub fn unmask(payload: &mut [u8], key: [u8; 4]) {
    // SAFETY: NEON is enabled at compile time for every AArch64 target this
    // crate builds for, which the kernel requires.
    unsafe { kernels::unmask(payload, key) }
}

/// The kernels. Every function requires NEON.
mod kernels {
    use core::arch::aarch64::{
        uint8x16_t, vandq_u8, vceqq_u8, vcgeq_u8, vcleq_u8, vcltq_u8, vdupq_n_u8, veorq_u8,
        vget_lane_u64, vld1q_u8, vmvnq_u8, vorrq_u8, vreinterpret_u64_u8, vreinterpretq_u16_u8,
        vshrn_n_u16, vst1q_u8, vsubq_u8,
    };

    use super::tail_position;
    use crate::swar;

    const LANES: usize = 16;

    /// Loads a chunk of exactly sixteen bytes.
    #[inline]
    #[allow(unsafe_code)]
    #[target_feature(enable = "neon")]
    fn load(chunk: &[u8]) -> uint8x16_t {
        // SAFETY: the caller hands over a chunk of `chunks_exact(16)`, so sixteen
        // bytes are readable from its pointer, and the load has no alignment
        // requirement.
        unsafe { vld1q_u8(chunk.as_ptr()) }
    }

    /// Narrows a lane mask to four bits per lane; the result is nonzero when
    /// any lane is set, and the first set lane is the trailing-zero count
    /// divided by four.
    #[inline]
    #[target_feature(enable = "neon")]
    fn bits(mask: uint8x16_t) -> u64 {
        let narrowed = vshrn_n_u16::<4>(vreinterpretq_u16_u8(mask));
        vget_lane_u64::<0>(vreinterpret_u64_u8(narrowed))
    }

    /// Returns the lanes with the high bit set.
    #[inline]
    #[target_feature(enable = "neon")]
    fn high(v: uint8x16_t) -> uint8x16_t {
        vcgeq_u8(v, vdupq_n_u8(0x80))
    }

    /// Returns the lanes below `bound`.
    #[inline]
    #[target_feature(enable = "neon")]
    fn lt(v: uint8x16_t, bound: u8) -> uint8x16_t {
        vcltq_u8(v, vdupq_n_u8(bound))
    }

    /// Returns the lanes equal to `byte`.
    #[inline]
    #[target_feature(enable = "neon")]
    fn eq(v: uint8x16_t, byte: u8) -> uint8x16_t {
        vceqq_u8(v, vdupq_n_u8(byte))
    }

    /// Returns the lanes from `low` to `high` inclusive.
    #[inline]
    #[target_feature(enable = "neon")]
    fn between(v: uint8x16_t, low: u8, high: u8) -> uint8x16_t {
        let shifted = vsubq_u8(v, vdupq_n_u8(low));
        vcleq_u8(shifted, vdupq_n_u8(high.wrapping_sub(low)))
    }

    /// Returns the lanes outside the token class.
    #[inline]
    #[target_feature(enable = "neon")]
    fn not_tchar(v: uint8x16_t) -> uint8x16_t {
        vorrq_u8(
            vorrq_u8(
                vorrq_u8(lt(v, 0x21), vcgeq_u8(v, vdupq_n_u8(0x7F))),
                vorrq_u8(between(v, 0x3A, 0x40), between(v, 0x5B, 0x5D)),
            ),
            vorrq_u8(
                vorrq_u8(eq(v, 0x7B), eq(v, 0x7D)),
                vorrq_u8(
                    vorrq_u8(between(v, 0x28, 0x29), eq(v, 0x2C)),
                    vorrq_u8(eq(v, 0x2F), eq(v, 0x22)),
                ),
            ),
        )
    }

    macro_rules! position {
        ($bytes:expr, |$v:ident| $flag:expr, |$tail:ident| $rest:expr) => {{
            let bytes: &[u8] = $bytes;
            let mut chunks = bytes.chunks_exact(LANES);
            let mut offset = 0usize;
            let mut found = None;
            for chunk in &mut chunks {
                let $v = load(chunk);
                let mask: u64 = bits($flag);
                if mask != 0 {
                    let lane = (mask.trailing_zeros() as usize).wrapping_shr(2);
                    found = Some(offset.saturating_add(lane));
                    break;
                }
                offset = offset.saturating_add(LANES);
            }
            match found {
                Some(index) => Some(index),
                None => {
                    let $tail: &[u8] = chunks.remainder();
                    let rest: Option<usize> = $rest;
                    rest.map(|index| offset.saturating_add(index))
                }
            }
        }};
    }

    /// Returns the length of the ASCII prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "neon")]
    pub(super) fn scan_ascii(bytes: &[u8]) -> usize {
        position!(bytes, |v| high(v), |tail| tail_position(
            tail,
            swar::scan_ascii(tail)
        ))
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the request-target prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "neon")]
    pub(super) fn scan_target(bytes: &[u8]) -> usize {
        position!(
            bytes,
            |v| vorrq_u8(lt(v, 0x21), vcgeq_u8(v, vdupq_n_u8(0x7F))),
            |tail| tail_position(tail, swar::scan_target(tail))
        )
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the token prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "neon")]
    pub(super) fn scan_header_name(bytes: &[u8]) -> usize {
        position!(bytes, |v| not_tchar(v), |tail| tail_position(
            tail,
            swar::scan_header_name(tail)
        ))
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the field-value prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "neon")]
    pub(super) fn scan_header_value(bytes: &[u8]) -> usize {
        position!(
            bytes,
            |v| vorrq_u8(vandq_u8(lt(v, 0x20), vmvnq_u8(eq(v, 0x09))), eq(v, 0x7F)),
            |tail| tail_position(tail, swar::scan_header_value(tail))
        )
        .unwrap_or(bytes.len())
    }

    /// Returns the index of the first `needle` in `haystack`.
    #[must_use]
    #[target_feature(enable = "neon")]
    pub(super) fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
        position!(haystack, |v| eq(v, needle), |tail| swar::find_byte(
            tail, needle
        ))
    }

    /// Returns the index of the first CR or LF in `haystack`.
    #[must_use]
    #[target_feature(enable = "neon")]
    pub(super) fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
        position!(haystack, |v| vorrq_u8(eq(v, b'\r'), eq(v, b'\n')), |tail| {
            swar::find_cr_or_lf(tail)
        })
    }

    /// XORs every byte of `payload` with the masking key, sixteen bytes per
    /// step.
    #[allow(unsafe_code)]
    #[target_feature(enable = "neon")]
    pub(super) fn unmask(payload: &mut [u8], key: [u8; 4]) {
        let [k0, k1, k2, k3] = key;
        let pattern = [
            k0, k1, k2, k3, k0, k1, k2, k3, k0, k1, k2, k3, k0, k1, k2, k3,
        ];
        let key_vec = load(&pattern);
        let mut chunks = payload.chunks_exact_mut(LANES);
        for chunk in &mut chunks {
            let unmasked = veorq_u8(load(chunk), key_vec);
            // SAFETY: the chunk comes from `chunks_exact_mut(16)`, so sixteen
            // bytes are writable at its pointer, and the store has no alignment
            // requirement.
            unsafe { vst1q_u8(chunk.as_mut_ptr(), unmasked) };
        }
        swar::unmask(chunks.into_remainder(), key);
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        find_byte, find_cr_or_lf, scan_ascii, scan_header_name, scan_header_value, scan_target,
        unmask,
    };
    use crate::swar;
    use crate::test_support::{grid_bytes, iterations, Rng};

    fn check(bytes: &[u8], needle: u8) {
        assert_eq!(scan_ascii(bytes), swar::scan_ascii(bytes), "{bytes:?}");
        assert_eq!(scan_target(bytes), swar::scan_target(bytes), "{bytes:?}");
        assert_eq!(
            scan_header_name(bytes),
            swar::scan_header_name(bytes),
            "{bytes:?}"
        );
        assert_eq!(
            scan_header_value(bytes),
            swar::scan_header_value(bytes),
            "{bytes:?}"
        );
        assert_eq!(
            find_byte(bytes, needle),
            swar::find_byte(bytes, needle),
            "{bytes:?} needle {needle:#04x}"
        );
        assert_eq!(
            find_cr_or_lf(bytes),
            swar::find_cr_or_lf(bytes),
            "{bytes:?}"
        );
    }

    #[test]
    fn every_byte_at_every_position_agrees_with_swar() {
        for byte in grid_bytes() {
            for position in 0..40usize {
                let mut buffer = [b'a'; 40];
                if let Some(slot) = buffer.get_mut(position) {
                    *slot = byte;
                }
                check(&buffer, byte);
                check(&buffer, b'a');
                check(buffer.get(..position).unwrap_or(&[]), byte);
            }
        }
    }

    #[test]
    fn random_inputs_agree_with_swar() {
        let mut rng = Rng::new(0x5EED_0040);
        for _ in 0..iterations(20_000) {
            let bytes = rng.bytes(0..=100);
            check(&bytes, rng.byte());
        }
    }

    #[test]
    fn unmask_agrees_with_swar() {
        let mut rng = Rng::new(0x5EED_0041);
        for _ in 0..iterations(5_000) {
            let original = rng.bytes(0..=100);
            let key = [rng.byte(), rng.byte(), rng.byte(), rng.byte()];
            let mut expected: Vec<u8> = original.clone();
            swar::unmask(&mut expected, key);
            let mut actual: Vec<u8> = original.clone();
            unmask(&mut actual, key);
            assert_eq!(actual, expected);
        }
    }
}
