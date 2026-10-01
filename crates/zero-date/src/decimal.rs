//! The fixed-width decimal formatter: an unsigned integer rendered into a
//! 20-byte stack buffer, with no allocation and no `core::fmt` machinery.

use core::fmt;

/// The length of the longest decimal a `u64` produces.
pub const MAX_DECIMAL_LEN: usize = 20;

/// An unsigned integer rendered as decimal digits.
#[derive(Clone, Copy)]
pub struct Decimal {
    buf: [u8; MAX_DECIMAL_LEN],
    start: usize,
}

impl Decimal {
    /// Renders a value.
    ///
    /// # Arguments
    ///
    /// * `value` - the integer to render.
    #[must_use]
    pub fn new(mut value: u64) -> Self {
        let mut buf = [b'0'; MAX_DECIMAL_LEN];
        let mut start = MAX_DECIMAL_LEN;
        loop {
            start = start.saturating_sub(1);
            if let Some(slot) = buf.get_mut(start) {
                *slot = b'0'.wrapping_add(u8::try_from(value.rem_euclid(10)).unwrap_or_default());
            }
            value = value.div_euclid(10);
            if value == 0 {
                break;
            }
        }
        Self { buf, start }
    }

    /// Returns the digits.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        self.buf.get(self.start..).unwrap_or(&[])
    }

    /// Returns the digits as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        // Every byte is an ASCII digit by construction, so this cannot fail.
        core::str::from_utf8(self.as_bytes()).unwrap_or("")
    }

    /// Returns the number of digits.
    #[must_use]
    pub fn len(&self) -> usize {
        MAX_DECIMAL_LEN.saturating_sub(self.start)
    }

    /// Returns `false`: every value renders at least one digit.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl From<u64> for Decimal {
    fn from(value: u64) -> Self {
        Self::new(value)
    }
}

impl From<u32> for Decimal {
    fn from(value: u32) -> Self {
        Self::new(value.into())
    }
}

impl From<u16> for Decimal {
    fn from(value: u16) -> Self {
        Self::new(value.into())
    }
}

impl From<usize> for Decimal {
    fn from(value: usize) -> Self {
        Self::new(value as u64)
    }
}

impl AsRef<[u8]> for Decimal {
    fn as_ref(&self) -> &[u8] {
        self.as_bytes()
    }
}

impl fmt::Display for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Debug for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Decimal({})", self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::{Decimal, MAX_DECIMAL_LEN};

    #[test]
    fn small_values() {
        assert_eq!(Decimal::new(0).as_str(), "0");
        assert_eq!(Decimal::new(7).as_str(), "7");
        assert_eq!(Decimal::new(10).as_str(), "10");
        assert_eq!(Decimal::new(1_000_000).as_str(), "1000000");
        assert_eq!(Decimal::new(0).len(), 1);
        assert!(!Decimal::new(0).is_empty());
    }

    #[test]
    fn the_largest_value_fills_the_buffer() {
        let largest = Decimal::new(u64::MAX);
        assert_eq!(largest.as_str(), "18446744073709551615");
        assert_eq!(largest.len(), MAX_DECIMAL_LEN);
        assert_eq!(largest.as_bytes().len(), MAX_DECIMAL_LEN);
    }

    #[test]
    fn matches_the_core_formatter_across_magnitudes() {
        let mut value = 1u64;
        for _ in 0..20 {
            for candidate in [value.wrapping_sub(1), value, value.wrapping_add(1)] {
                assert_eq!(
                    Decimal::new(candidate).as_str(),
                    alloc::format!("{candidate}")
                );
            }
            value = value.saturating_mul(10);
        }
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..10_000 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let candidate = state.wrapping_shr(u32::try_from(state.rem_euclid(64)).unwrap_or(0));
            assert_eq!(
                Decimal::new(candidate).as_str(),
                alloc::format!("{candidate}")
            );
        }
    }

    #[test]
    fn conversions_and_formatting() {
        assert_eq!(Decimal::from(42u32).as_str(), "42");
        assert_eq!(Decimal::from(42u16).as_str(), "42");
        assert_eq!(Decimal::from(42usize).as_str(), "42");
        assert_eq!(alloc::format!("{}", Decimal::from(42u64)), "42");
        assert_eq!(alloc::format!("{:?}", Decimal::from(42u64)), "Decimal(42)");
        assert_eq!(Decimal::from(42u64).as_ref(), b"42");
    }
}
