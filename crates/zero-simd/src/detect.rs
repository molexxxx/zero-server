//! The cached feature token that selects a kernel.
//!
//! Detection runs once per process and is remembered in an atomic, so a
//! dispatch costs one relaxed load. With the `std` feature the x86 features
//! come from the standard library's runtime detection; without it, only the
//! features the target was compiled with are used, so a `no_std` build never
//! executes an instruction its target does not guarantee.

use core::sync::atomic::{AtomicU8, Ordering};

const DETECTED: u8 = 0b0001;
const SSE42: u8 = 0b0010;
const AVX2: u8 = 0b0100;
const NEON: u8 = 0b1000;

static CACHE: AtomicU8 = AtomicU8::new(0);

/// The instruction-set features the kernels may use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Features(u8);

impl Features {
    /// No feature: the SWAR kernels run everywhere.
    pub const NONE: Self = Self(DETECTED);

    /// Returns the features of this machine, detecting them on the first
    /// call.
    #[must_use]
    pub fn detect() -> Self {
        let cached = CACHE.load(Ordering::Relaxed);
        if cached & DETECTED != 0 {
            return Self(cached);
        }
        let features = Self::probe();
        CACHE.store(features.0, Ordering::Relaxed);
        features
    }

    /// Returns `true` when SSE4.2 (and so SSE2) may be used.
    #[must_use]
    pub const fn has_sse42(self) -> bool {
        self.0 & SSE42 != 0
    }

    /// Returns `true` when AVX2 may be used.
    #[must_use]
    pub const fn has_avx2(self) -> bool {
        self.0 & AVX2 != 0
    }

    /// Returns `true` when NEON may be used.
    #[must_use]
    pub const fn has_neon(self) -> bool {
        self.0 & NEON != 0
    }

    fn probe() -> Self {
        let mut bits = DETECTED;
        if x86_sse42() {
            bits |= SSE42;
        }
        if x86_avx2() {
            bits |= AVX2;
        }
        if cfg!(all(target_arch = "aarch64", target_feature = "neon")) {
            bits |= NEON;
        }
        Self(bits)
    }
}

#[cfg(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64")))]
fn x86_sse42() -> bool {
    std::arch::is_x86_feature_detected!("sse4.2")
}

#[cfg(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64")))]
fn x86_avx2() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
}

#[cfg(not(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64"))))]
fn x86_sse42() -> bool {
    cfg!(all(
        any(target_arch = "x86", target_arch = "x86_64"),
        target_feature = "sse4.2"
    ))
}

#[cfg(not(all(feature = "std", any(target_arch = "x86", target_arch = "x86_64"))))]
fn x86_avx2() -> bool {
    cfg!(all(
        any(target_arch = "x86", target_arch = "x86_64"),
        target_feature = "avx2"
    ))
}

#[cfg(test)]
mod tests {
    use super::Features;

    #[test]
    fn detection_is_stable_and_consistent() {
        let first = Features::detect();
        let second = Features::detect();
        assert_eq!(first, second);
        if first.has_avx2() {
            assert!(
                first.has_sse42(),
                "AVX2 without SSE4.2 is not a real machine"
            );
        }
        assert!(!Features::NONE.has_sse42());
        assert!(!Features::NONE.has_avx2());
        assert!(!Features::NONE.has_neon());
        #[cfg(target_arch = "aarch64")]
        assert!(first.has_neon());
        #[cfg(not(target_arch = "aarch64"))]
        assert!(!first.has_neon());
    }
}
