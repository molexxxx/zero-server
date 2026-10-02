//! The reserved values 0x1f * N + 0x21 that four HTTP/3 registries share.
//!
//! Frame types (RFC 9114 Section 7.2.8), settings (Section 7.2.4.1), error
//! codes (Section 8.1) and stream types (Section 6.2.3) of the form
//! 0x1f * N + 0x21 "for non-negative integer values of N" are reserved to
//! exercise the requirement that unknown values be ignored: the values 0x21,
//! 0x40, and so on through 0x3ffffffffffffffe, the largest such value a
//! variable-length integer can carry.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.8>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-11.2>

use crate::varint;

/// The largest N with 0x1f * N + 0x21 at most 2^62-1.
pub const MAX_N: u64 = 148_764_065_110_560_899;

/// The first reserved value, N = 0.
const FIRST: u64 = 0x21;

/// The distance between reserved values.
const STEP: u64 = 0x1F;

/// Whether `value` has the form 0x1f * N + 0x21 and fits a variable-length
/// integer: a reserved frame type, setting, error code or stream type.
///
/// # Arguments
///
/// * `value` - the received value.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.8>
#[must_use]
pub const fn is_reserved(value: u64) -> bool {
    if value > varint::MAX {
        return false;
    }
    match value.checked_sub(FIRST) {
        Some(offset) => matches!(offset.checked_rem(STEP), Some(0)),
        None => false,
    }
}

/// The reserved value 0x1f * n + 0x21.
///
/// # Arguments
///
/// * `n` - the index of the reserved value, at most [`MAX_N`].
///
/// # Returns
///
/// The value, or `None` when `n` is above [`MAX_N`].
#[must_use]
pub const fn reserved(n: u64) -> Option<u64> {
    if n > MAX_N {
        return None;
    }
    match n.checked_mul(STEP) {
        Some(product) => product.checked_add(FIRST),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{is_reserved, reserved, MAX_N};
    use crate::varint;
    use crate::xorshift::{iterations, Rng};

    /// RFC 9114 Section 7.2.8: "Frame types of the format 0x1f * N + 0x21 for
    /// non-negative integer values of N are reserved to exercise the requirement
    /// that unknown types be ignored (Section 9)."
    #[test]
    fn reserved_values_are_0x1f_times_n_plus_0x21_through_0x3ffffffffffffffe() {
        let first: [u64; 6] = [33, 64, 95, 126, 157, 188];
        for (n, value) in (0u64..).zip(first) {
            assert_eq!(reserved(n), Some(value), "{n}");
            assert!(is_reserved(value), "{value}");
        }
        assert_eq!(reserved(MAX_N), Some(0x3FFF_FFFF_FFFF_FFFE));
        assert_eq!(reserved(MAX_N), Some(4_611_686_018_427_387_902));
        assert_eq!(reserved(MAX_N.saturating_add(1)), None);
        assert_eq!(reserved(u64::MAX), None);
        assert!(is_reserved(0x3FFF_FFFF_FFFF_FFFE));
        for value in [0u64, 1, 32, 34, 63, varint::MAX, 0x33, 0x0100] {
            assert!(!is_reserved(value), "{value}");
        }
        let beyond = 0x3FFF_FFFF_FFFF_FFFEu64.saturating_add(0x1F);
        assert!(!is_reserved(beyond));
        assert!(!is_reserved(u64::MAX));
    }

    /// RFC 9114 Sections 6.2.3, 7.2.4.1, 7.2.8 and 8.1: the reserved values
    /// are of "the format 0x1f * N + 0x21", so the value of every N is
    /// reserved and none of the 30 values after it is.
    #[test]
    fn random_reserved_indexes_round_trip_and_their_neighbors_are_not_reserved() {
        let mut rng = Rng::new(0x5EED_0003);
        for _ in 0..iterations(10_000) {
            let n = rng.below(MAX_N.saturating_add(1));
            let value = reserved(n).unwrap_or(0);
            assert!(is_reserved(value), "{n}");
            for offset in 1..0x1Fu64 {
                assert!(!is_reserved(value.saturating_add(offset)), "{n} + {offset}");
            }
        }
    }
}
