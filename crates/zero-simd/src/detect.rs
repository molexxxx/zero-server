//! The cached feature token that selects a kernel.
//!
//! Detection runs once per process and is remembered in an atomic, so a
//! dispatch costs one relaxed load. On x86-64 the probe asks the CPU directly
//! with `cpuid` and `xgetbv`, which `core` exposes, so a `no_std` build
//! detects the same features a hosted build does: SSE4.2 from leaf 1, and
//! AVX2 from leaf 7 only when the CPU reports XSAVE and AVX, the operating
//! system has enabled XSAVE, and the extended control register says the OS
//! saves the SSE and AVX register state. On AArch64, NEON is a compile-time
//! feature of the target. Under Miri, which interprets no `cpuid`, the probe
//! reports the target's compile-time features.
//!
//! The leaf and bit positions are those the standard library's detection
//! uses (`std_detect`, `detect/os/x86.rs`): leaf 1 ECX bit 20 for SSE4.2,
//! bits 26, 27 and 28 for XSAVE, OSXSAVE and AVX, XCR0 bits 1 and 2 for the
//! SSE and AVX state, and leaf 7 subleaf 0 EBX bit 5 for AVX2.
//!
//! @see <https://raw.githubusercontent.com/rust-lang/rust/master/library/std_detect/src/detect/os/x86.rs>

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
        let (sse42, avx2) = x86_features();
        if sse42 {
            bits |= SSE42;
        }
        if avx2 {
            bits |= AVX2;
        }
        if cfg!(all(target_arch = "aarch64", target_feature = "neon")) {
            bits |= NEON;
        }
        Self(bits)
    }
}

/// Leaf 1 ECX bit 20: SSE4.2.
#[cfg(all(target_arch = "x86_64", not(miri)))]
const LEAF1_ECX_SSE42: u32 = 0x0010_0000;
/// Leaf 1 ECX bit 26: the CPU supports XSAVE.
#[cfg(all(target_arch = "x86_64", not(miri)))]
const LEAF1_ECX_XSAVE: u32 = 0x0400_0000;
/// Leaf 1 ECX bit 27: the operating system has enabled XSAVE.
#[cfg(all(target_arch = "x86_64", not(miri)))]
const LEAF1_ECX_OSXSAVE: u32 = 0x0800_0000;
/// Leaf 1 ECX bit 28: AVX.
#[cfg(all(target_arch = "x86_64", not(miri)))]
const LEAF1_ECX_AVX: u32 = 0x1000_0000;
/// XCR0 bits 1 and 2: the operating system saves the SSE and AVX state.
#[cfg(all(target_arch = "x86_64", not(miri)))]
const XCR0_SSE_AVX: u64 = 0b110;
/// Leaf 7 subleaf 0 EBX bit 5: AVX2.
#[cfg(all(target_arch = "x86_64", not(miri)))]
const LEAF7_EBX_AVX2: u32 = 0x0000_0020;

/// Asks the CPU for SSE4.2 and usable AVX2.
#[cfg(all(target_arch = "x86_64", not(miri)))]
#[allow(unsafe_code)]
fn x86_features() -> (bool, bool) {
    use core::arch::x86_64::{__cpuid, __cpuid_count};

    // `__cpuid` is an unsafe function on the minimum supported toolchain (1.89) and a
    // safe one on newer releases, so the blocks stay and the lint for them is allowed.
    // SAFETY: CPUID has no preconditions on x86-64; the leaf is read, nothing is written.
    #[allow(unused_unsafe)]
    let max_leaf = unsafe { __cpuid(0).eax };
    if max_leaf < 1 {
        return (false, false);
    }
    // SAFETY: as above.
    #[allow(unused_unsafe)]
    let leaf1 = unsafe { __cpuid(1).ecx };
    let sse42 = leaf1 & LEAF1_ECX_SSE42 != 0;
    let xsave = leaf1 & LEAF1_ECX_XSAVE != 0;
    let osxsave = leaf1 & LEAF1_ECX_OSXSAVE != 0;
    let avx = leaf1 & LEAF1_ECX_AVX != 0;
    if max_leaf < 7 || !(xsave && osxsave && avx) {
        return (sse42, false);
    }
    // SAFETY: the CPU reports XSAVE and the operating system has set OSXSAVE,
    // so the XGETBV instruction is enabled.
    let xcr0 = unsafe { extended_control_register() };
    let os_saves_avx_state = xcr0 & XCR0_SSE_AVX == XCR0_SSE_AVX;
    // SAFETY: as above; leaf 7 exists because `max_leaf` is at least 7.
    #[allow(unused_unsafe)]
    let leaf7 = unsafe { __cpuid_count(7, 0).ebx };
    let avx2 = os_saves_avx_state && leaf7 & LEAF7_EBX_AVX2 != 0;
    (sse42, avx2)
}

/// Reads XCR0.
///
/// The caller must have confirmed XSAVE and OSXSAVE in CPUID leaf 1, or the
/// instruction faults.
#[cfg(all(target_arch = "x86_64", not(miri)))]
#[allow(unsafe_code)]
#[target_feature(enable = "xsave")]
unsafe fn extended_control_register() -> u64 {
    // SAFETY: the caller confirmed XSAVE and OSXSAVE, under which XGETBV with
    // register 0 is defined.
    unsafe { core::arch::x86_64::_xgetbv(0) }
}

/// Reports the x86 features the target was compiled with, on targets and
/// interpreters where the CPU cannot be asked.
#[cfg(not(all(target_arch = "x86_64", not(miri))))]
fn x86_features() -> (bool, bool) {
    (
        cfg!(all(
            any(target_arch = "x86", target_arch = "x86_64"),
            target_feature = "sse4.2"
        )),
        cfg!(all(
            any(target_arch = "x86", target_arch = "x86_64"),
            target_feature = "avx2"
        )),
    )
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

    #[cfg(all(feature = "std", target_arch = "x86_64", not(miri)))]
    #[test]
    fn the_probe_agrees_with_the_standard_library() {
        let features = Features::detect();
        assert_eq!(
            features.has_sse42(),
            std::arch::is_x86_feature_detected!("sse4.2")
        );
        assert_eq!(
            features.has_avx2(),
            std::arch::is_x86_feature_detected!("avx2")
        );
    }
}
