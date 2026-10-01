//! The x86-64 kernels: SSE2, which every x86-64 target guarantees, and AVX2
//! behind the detection token.
//!
//! Each kernel classifies 16 or 32 bytes per step with compares and a
//! movemask, so the first flagged lane is the first matching byte, and falls
//! back to the SWAR kernel for the bytes after the last full chunk. The
//! unsafe operations are the unaligned loads and stores through a chunk's
//! pointer, each preceded by the bounds the chunk iterator guarantees, and
//! the calls into the kernels, which require their instruction set: SSE2 is
//! part of the x86-64 baseline, and AVX2 is called only after the token has
//! reported it. The dispatch functions at this module's root are the only
//! callers of the kernels.

use crate::detect::Features;

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
    if Features::detect().has_avx2() {
        // SAFETY: the token reported AVX2 on this machine, which the kernel
        // requires.
        unsafe { avx2::scan_ascii(bytes) }
    } else {
        // SAFETY: SSE2 is part of the x86-64 baseline, so every x86-64 machine
        // has the instructions the kernel requires.
        unsafe { sse2::scan_ascii(bytes) }
    }
}

/// Returns the length of the request-target prefix of `bytes`.
#[allow(unsafe_code)]
#[must_use]
pub fn scan_target(bytes: &[u8]) -> usize {
    if Features::detect().has_avx2() {
        // SAFETY: the token reported AVX2 on this machine, which the kernel
        // requires.
        unsafe { avx2::scan_target(bytes) }
    } else {
        // SAFETY: SSE2 is part of the x86-64 baseline, so every x86-64 machine
        // has the instructions the kernel requires.
        unsafe { sse2::scan_target(bytes) }
    }
}

/// Returns the length of the token prefix of `bytes`.
#[allow(unsafe_code)]
#[must_use]
pub fn scan_header_name(bytes: &[u8]) -> usize {
    if Features::detect().has_avx2() {
        // SAFETY: the token reported AVX2 on this machine, which the kernel
        // requires.
        unsafe { avx2::scan_header_name(bytes) }
    } else {
        // SAFETY: SSE2 is part of the x86-64 baseline, so every x86-64 machine
        // has the instructions the kernel requires.
        unsafe { sse2::scan_header_name(bytes) }
    }
}

/// Returns the length of the field-value prefix of `bytes`.
#[allow(unsafe_code)]
#[must_use]
pub fn scan_header_value(bytes: &[u8]) -> usize {
    if Features::detect().has_avx2() {
        // SAFETY: the token reported AVX2 on this machine, which the kernel
        // requires.
        unsafe { avx2::scan_header_value(bytes) }
    } else {
        // SAFETY: SSE2 is part of the x86-64 baseline, so every x86-64 machine
        // has the instructions the kernel requires.
        unsafe { sse2::scan_header_value(bytes) }
    }
}

/// Returns the index of the first `needle` in `haystack`.
#[allow(unsafe_code)]
#[must_use]
pub fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
    if Features::detect().has_avx2() {
        // SAFETY: the token reported AVX2 on this machine, which the kernel
        // requires.
        unsafe { avx2::find_byte(haystack, needle) }
    } else {
        // SAFETY: SSE2 is part of the x86-64 baseline, so every x86-64 machine
        // has the instructions the kernel requires.
        unsafe { sse2::find_byte(haystack, needle) }
    }
}

/// Returns the index of the first CR or LF in `haystack`.
#[allow(unsafe_code)]
#[must_use]
pub fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
    if Features::detect().has_avx2() {
        // SAFETY: the token reported AVX2 on this machine, which the kernel
        // requires.
        unsafe { avx2::find_cr_or_lf(haystack) }
    } else {
        // SAFETY: SSE2 is part of the x86-64 baseline, so every x86-64 machine
        // has the instructions the kernel requires.
        unsafe { sse2::find_cr_or_lf(haystack) }
    }
}

/// XORs every byte of `payload` with the masking key, in place.
#[allow(unsafe_code)]
pub fn unmask(payload: &mut [u8], key: [u8; 4]) {
    if Features::detect().has_avx2() {
        // SAFETY: the token reported AVX2 on this machine, which the kernel
        // requires.
        unsafe { avx2::unmask(payload, key) }
    } else {
        // SAFETY: SSE2 is part of the x86-64 baseline, so every x86-64 machine
        // has the instructions the kernel requires.
        unsafe { sse2::unmask(payload, key) }
    }
}

/// Runs a flag function over every full chunk and returns the index of the
/// first flagged byte, falling back to the tail expression for the rest.
macro_rules! position {
    ($bytes:expr, $lanes:expr, $load:ident, |$v:ident| $flag:expr, |$tail:ident| $rest:expr) => {{
        let bytes: &[u8] = $bytes;
        let mut chunks = bytes.chunks_exact($lanes);
        let mut offset = 0usize;
        let mut found = None;
        for chunk in &mut chunks {
            let $v = $load(chunk);
            let mask: i32 = $flag;
            if mask != 0 {
                found = Some(offset.saturating_add(mask.trailing_zeros() as usize));
                break;
            }
            offset = offset.saturating_add($lanes);
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

/// The SSE2 kernels, 16 bytes per step. Every function requires SSE2.
mod sse2 {
    use core::arch::x86_64::{
        __m128i, _mm_cmpeq_epi8, _mm_loadu_si128, _mm_max_epu8, _mm_movemask_epi8, _mm_or_si128,
        _mm_set1_epi32, _mm_set1_epi8, _mm_storeu_si128, _mm_sub_epi8, _mm_xor_si128,
    };

    use super::tail_position;
    use crate::swar;

    const LANES: usize = 16;

    /// Loads a chunk of exactly sixteen bytes.
    #[inline]
    #[allow(unsafe_code)]
    #[target_feature(enable = "sse2")]
    fn load(chunk: &[u8]) -> __m128i {
        // SAFETY: the caller hands over a chunk of `chunks_exact(16)`, so sixteen
        // bytes are readable from its pointer, and the unaligned load has no
        // alignment requirement.
        unsafe { _mm_loadu_si128(chunk.as_ptr().cast::<__m128i>()) }
    }

    /// Returns the lanes with the high bit set.
    #[inline]
    #[target_feature(enable = "sse2")]
    fn high(v: __m128i) -> i32 {
        _mm_movemask_epi8(v)
    }

    /// Returns the lanes below `bound`, for a bound of at least one.
    #[inline]
    #[target_feature(enable = "sse2")]
    fn lt(v: __m128i, bound: u8) -> __m128i {
        let limit = _mm_set1_epi8(bound.wrapping_sub(1) as i8);
        _mm_cmpeq_epi8(_mm_max_epu8(v, limit), limit)
    }

    /// Returns the lanes equal to `byte`.
    #[inline]
    #[target_feature(enable = "sse2")]
    fn eq(v: __m128i, byte: u8) -> __m128i {
        _mm_cmpeq_epi8(v, _mm_set1_epi8(byte as i8))
    }

    /// Returns the lanes from `low` to `high` inclusive.
    #[inline]
    #[target_feature(enable = "sse2")]
    fn between(v: __m128i, low: u8, high: u8) -> __m128i {
        let shifted = _mm_sub_epi8(v, _mm_set1_epi8(low as i8));
        let span = _mm_set1_epi8(high.wrapping_sub(low) as i8);
        _mm_cmpeq_epi8(_mm_max_epu8(shifted, span), span)
    }

    /// Returns the lanes outside the token class.
    #[inline]
    #[target_feature(enable = "sse2")]
    fn not_tchar(v: __m128i) -> i32 {
        let bad = _mm_or_si128(
            _mm_or_si128(lt(v, 0x21), eq(v, 0x7F)),
            _mm_or_si128(
                _mm_or_si128(between(v, 0x3A, 0x40), between(v, 0x5B, 0x5D)),
                _mm_or_si128(
                    _mm_or_si128(eq(v, 0x7B), eq(v, 0x7D)),
                    _mm_or_si128(
                        _mm_or_si128(between(v, 0x28, 0x29), eq(v, 0x2C)),
                        _mm_or_si128(eq(v, 0x2F), eq(v, 0x22)),
                    ),
                ),
            ),
        );
        high(bad) | high(v)
    }

    /// Returns the length of the ASCII prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "sse2")]
    pub(super) fn scan_ascii(bytes: &[u8]) -> usize {
        position!(bytes, LANES, load, |v| high(v), |tail| tail_position(
            tail,
            swar::scan_ascii(tail)
        ))
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the request-target prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "sse2")]
    pub(super) fn scan_target(bytes: &[u8]) -> usize {
        position!(
            bytes,
            LANES,
            load,
            |v| high(_mm_or_si128(lt(v, 0x21), eq(v, 0x7F))) | high(v),
            |tail| tail_position(tail, swar::scan_target(tail))
        )
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the token prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "sse2")]
    pub(super) fn scan_header_name(bytes: &[u8]) -> usize {
        position!(bytes, LANES, load, |v| not_tchar(v), |tail| tail_position(
            tail,
            swar::scan_header_name(tail)
        ))
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the field-value prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "sse2")]
    pub(super) fn scan_header_value(bytes: &[u8]) -> usize {
        position!(
            bytes,
            LANES,
            load,
            |v| (high(lt(v, 0x20)) & !high(eq(v, 0x09))) | high(eq(v, 0x7F)),
            |tail| tail_position(tail, swar::scan_header_value(tail))
        )
        .unwrap_or(bytes.len())
    }

    /// Returns the index of the first `needle` in `haystack`.
    #[must_use]
    #[target_feature(enable = "sse2")]
    pub(super) fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
        position!(haystack, LANES, load, |v| high(eq(v, needle)), |tail| {
            swar::find_byte(tail, needle)
        })
    }

    /// Returns the index of the first CR or LF in `haystack`.
    #[must_use]
    #[target_feature(enable = "sse2")]
    pub(super) fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
        position!(
            haystack,
            LANES,
            load,
            |v| high(_mm_or_si128(eq(v, b'\r'), eq(v, b'\n'))),
            |tail| swar::find_cr_or_lf(tail)
        )
    }

    /// XORs every byte of `payload` with the masking key, sixteen bytes per
    /// step.
    #[allow(unsafe_code)]
    #[target_feature(enable = "sse2")]
    pub(super) fn unmask(payload: &mut [u8], key: [u8; 4]) {
        let key_vec = _mm_set1_epi32(i32::from_ne_bytes(key));
        let mut chunks = payload.chunks_exact_mut(LANES);
        for chunk in &mut chunks {
            let unmasked = _mm_xor_si128(load(chunk), key_vec);
            // SAFETY: the chunk comes from `chunks_exact_mut(16)`, so sixteen
            // bytes are writable at its pointer, and the unaligned store has no
            // alignment requirement.
            unsafe { _mm_storeu_si128(chunk.as_mut_ptr().cast::<__m128i>(), unmasked) };
        }
        swar::unmask(chunks.into_remainder(), key);
    }
}

/// The AVX2 kernels, 32 bytes per step. Every function requires AVX2.
mod avx2 {
    use core::arch::x86_64::{
        __m256i, _mm256_cmpeq_epi8, _mm256_loadu_si256, _mm256_max_epu8, _mm256_movemask_epi8,
        _mm256_or_si256, _mm256_set1_epi32, _mm256_set1_epi8, _mm256_storeu_si256, _mm256_sub_epi8,
        _mm256_xor_si256,
    };

    use super::tail_position;
    use crate::swar;

    const LANES: usize = 32;

    /// Loads a chunk of exactly thirty-two bytes.
    #[inline]
    #[allow(unsafe_code)]
    #[target_feature(enable = "avx2")]
    fn load(chunk: &[u8]) -> __m256i {
        // SAFETY: the caller hands over a chunk of `chunks_exact(32)`, so
        // thirty-two bytes are readable from its pointer, and the unaligned load
        // has no alignment requirement.
        unsafe { _mm256_loadu_si256(chunk.as_ptr().cast::<__m256i>()) }
    }

    /// Returns the lanes with the high bit set.
    #[inline]
    #[target_feature(enable = "avx2")]
    fn high(v: __m256i) -> i32 {
        _mm256_movemask_epi8(v)
    }

    /// Returns the lanes below `bound`, for a bound of at least one.
    #[inline]
    #[target_feature(enable = "avx2")]
    fn lt(v: __m256i, bound: u8) -> __m256i {
        let limit = _mm256_set1_epi8(bound.wrapping_sub(1) as i8);
        _mm256_cmpeq_epi8(_mm256_max_epu8(v, limit), limit)
    }

    /// Returns the lanes equal to `byte`.
    #[inline]
    #[target_feature(enable = "avx2")]
    fn eq(v: __m256i, byte: u8) -> __m256i {
        _mm256_cmpeq_epi8(v, _mm256_set1_epi8(byte as i8))
    }

    /// Returns the lanes from `low` to `high` inclusive.
    #[inline]
    #[target_feature(enable = "avx2")]
    fn between(v: __m256i, low: u8, high: u8) -> __m256i {
        let shifted = _mm256_sub_epi8(v, _mm256_set1_epi8(low as i8));
        let span = _mm256_set1_epi8(high.wrapping_sub(low) as i8);
        _mm256_cmpeq_epi8(_mm256_max_epu8(shifted, span), span)
    }

    /// Returns the lanes outside the token class.
    #[inline]
    #[target_feature(enable = "avx2")]
    fn not_tchar(v: __m256i) -> i32 {
        let bad = _mm256_or_si256(
            _mm256_or_si256(lt(v, 0x21), eq(v, 0x7F)),
            _mm256_or_si256(
                _mm256_or_si256(between(v, 0x3A, 0x40), between(v, 0x5B, 0x5D)),
                _mm256_or_si256(
                    _mm256_or_si256(eq(v, 0x7B), eq(v, 0x7D)),
                    _mm256_or_si256(
                        _mm256_or_si256(between(v, 0x28, 0x29), eq(v, 0x2C)),
                        _mm256_or_si256(eq(v, 0x2F), eq(v, 0x22)),
                    ),
                ),
            ),
        );
        high(bad) | high(v)
    }

    /// Returns the length of the ASCII prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "avx2")]
    pub(super) fn scan_ascii(bytes: &[u8]) -> usize {
        position!(bytes, LANES, load, |v| high(v), |tail| tail_position(
            tail,
            swar::scan_ascii(tail)
        ))
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the request-target prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "avx2")]
    pub(super) fn scan_target(bytes: &[u8]) -> usize {
        position!(
            bytes,
            LANES,
            load,
            |v| high(_mm256_or_si256(lt(v, 0x21), eq(v, 0x7F))) | high(v),
            |tail| tail_position(tail, swar::scan_target(tail))
        )
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the token prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "avx2")]
    pub(super) fn scan_header_name(bytes: &[u8]) -> usize {
        position!(bytes, LANES, load, |v| not_tchar(v), |tail| tail_position(
            tail,
            swar::scan_header_name(tail)
        ))
        .unwrap_or(bytes.len())
    }

    /// Returns the length of the field-value prefix of `bytes`.
    #[must_use]
    #[target_feature(enable = "avx2")]
    pub(super) fn scan_header_value(bytes: &[u8]) -> usize {
        position!(
            bytes,
            LANES,
            load,
            |v| (high(lt(v, 0x20)) & !high(eq(v, 0x09))) | high(eq(v, 0x7F)),
            |tail| tail_position(tail, swar::scan_header_value(tail))
        )
        .unwrap_or(bytes.len())
    }

    /// Returns the index of the first `needle` in `haystack`.
    #[must_use]
    #[target_feature(enable = "avx2")]
    pub(super) fn find_byte(haystack: &[u8], needle: u8) -> Option<usize> {
        position!(haystack, LANES, load, |v| high(eq(v, needle)), |tail| {
            swar::find_byte(tail, needle)
        })
    }

    /// Returns the index of the first CR or LF in `haystack`.
    #[must_use]
    #[target_feature(enable = "avx2")]
    pub(super) fn find_cr_or_lf(haystack: &[u8]) -> Option<usize> {
        position!(
            haystack,
            LANES,
            load,
            |v| high(_mm256_or_si256(eq(v, b'\r'), eq(v, b'\n'))),
            |tail| swar::find_cr_or_lf(tail)
        )
    }

    /// XORs every byte of `payload` with the masking key, thirty-two bytes
    /// per step.
    #[allow(unsafe_code)]
    #[target_feature(enable = "avx2")]
    pub(super) fn unmask(payload: &mut [u8], key: [u8; 4]) {
        let key_vec = _mm256_set1_epi32(i32::from_ne_bytes(key));
        let mut chunks = payload.chunks_exact_mut(LANES);
        for chunk in &mut chunks {
            let unmasked = _mm256_xor_si256(load(chunk), key_vec);
            // SAFETY: the chunk comes from `chunks_exact_mut(32)`, so thirty-two
            // bytes are writable at its pointer, and the unaligned store has no
            // alignment requirement.
            unsafe { _mm256_storeu_si256(chunk.as_mut_ptr().cast::<__m256i>(), unmasked) };
        }
        swar::unmask(chunks.into_remainder(), key);
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{avx2, sse2};
    use crate::detect::Features;
    use crate::swar;
    use crate::test_support::{grid_bytes, iterations, Rng};

    /// Every kernel's answer for one input.
    #[derive(Debug, PartialEq, Eq)]
    struct Results {
        ascii: usize,
        target: usize,
        name: usize,
        value: usize,
        byte: Option<usize>,
        line: Option<usize>,
    }

    fn swar_results(bytes: &[u8], needle: u8) -> Results {
        Results {
            ascii: swar::scan_ascii(bytes),
            target: swar::scan_target(bytes),
            name: swar::scan_header_name(bytes),
            value: swar::scan_header_value(bytes),
            byte: swar::find_byte(bytes, needle),
            line: swar::find_cr_or_lf(bytes),
        }
    }

    #[target_feature(enable = "sse2")]
    fn sse2_results(bytes: &[u8], needle: u8) -> Results {
        Results {
            ascii: sse2::scan_ascii(bytes),
            target: sse2::scan_target(bytes),
            name: sse2::scan_header_name(bytes),
            value: sse2::scan_header_value(bytes),
            byte: sse2::find_byte(bytes, needle),
            line: sse2::find_cr_or_lf(bytes),
        }
    }

    #[target_feature(enable = "avx2")]
    fn avx2_results(bytes: &[u8], needle: u8) -> Results {
        Results {
            ascii: avx2::scan_ascii(bytes),
            target: avx2::scan_target(bytes),
            name: avx2::scan_header_name(bytes),
            value: avx2::scan_header_value(bytes),
            byte: avx2::find_byte(bytes, needle),
            line: avx2::find_cr_or_lf(bytes),
        }
    }

    #[allow(unsafe_code)]
    fn check(bytes: &[u8], needle: u8) {
        let expected = swar_results(bytes, needle);
        // SAFETY: SSE2 is part of the x86-64 baseline.
        let sse = unsafe { sse2_results(bytes, needle) };
        assert_eq!(sse, expected, "sse2 {bytes:?} needle {needle:#04x}");
        if Features::detect().has_avx2() {
            // SAFETY: the token reported AVX2 on this machine.
            let avx = unsafe { avx2_results(bytes, needle) };
            assert_eq!(avx, expected, "avx2 {bytes:?} needle {needle:#04x}");
        }
    }

    #[allow(unsafe_code)]
    fn check_unmask(original: &[u8], key: [u8; 4]) {
        let mut expected: Vec<u8> = original.to_vec();
        swar::unmask(&mut expected, key);
        let mut sse: Vec<u8> = original.to_vec();
        // SAFETY: SSE2 is part of the x86-64 baseline.
        unsafe { sse2::unmask(&mut sse, key) };
        assert_eq!(sse, expected);
        if Features::detect().has_avx2() {
            let mut avx: Vec<u8> = original.to_vec();
            // SAFETY: the token reported AVX2 on this machine.
            unsafe { avx2::unmask(&mut avx, key) };
            assert_eq!(avx, expected);
        }
    }

    #[test]
    fn every_byte_at_every_position_agrees_with_swar() {
        for byte in grid_bytes() {
            for position in 0..72usize {
                let mut buffer = [b'a'; 72];
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
        let mut rng = Rng::new(0x5EED_0030);
        for _ in 0..iterations(20_000) {
            let bytes = rng.bytes(0..=100);
            let needle = rng.byte();
            check(&bytes, needle);
        }
    }

    #[test]
    fn unmask_agrees_with_swar() {
        let mut rng = Rng::new(0x5EED_0031);
        for _ in 0..iterations(5_000) {
            let original = rng.bytes(0..=100);
            let key = [rng.byte(), rng.byte(), rng.byte(), rng.byte()];
            check_unmask(&original, key);
        }
    }
}
