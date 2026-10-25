//! JavaScript numbers as ids, indexes, counts and codes.
//!
//! An id or a count arrives as a JavaScript number and is accepted only when it is
//! finite, whole and inside the range its argument allows; anything else is refused
//! with `ZERO_INVALID_ARGUMENT` instead of being truncated, so `1.5`, `-1`, `NaN` or
//! `2 ** 53` never name a slot, a server or a status. Ids are below 2^53, so they
//! cross back to JavaScript as numbers without loss.

use crate::guard::Fail;

/// The largest id: 2^53 - 1, the largest integer a JavaScript number holds exactly.
pub(crate) const ID_MAX: u64 = (1 << 53) - 1;

/// The worker indexes a process holds.
const WORKERS: u64 = 128;

/// A number as a whole value from 0 to `max`, or `None`. `max` is at most
/// [`ID_MAX`], where every integer is an exact double, so the comparison is exact.
///
/// # Arguments
///
/// * `value` - the number.
/// * `max` - the largest accepted value.
///
/// # Returns
///
/// The value, or `None` for a number that is not finite, not whole, negative or
/// above `max`.
pub(crate) fn whole_in(value: f64, max: u64) -> Option<u64> {
    let limit = max.min(ID_MAX) as f64;
    let accepted = value.is_finite() && value >= 0.0 && value.trunc() == value && value <= limit;
    accepted.then_some(value as u64)
}

/// A number as a whole value from 0 to `max`.
///
/// # Arguments
///
/// * `value` - the number.
/// * `max` - the largest accepted value.
/// * `what` - the argument's name, for the message.
///
/// # Returns
///
/// The value.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` naming the argument and its range.
pub(crate) fn whole(value: f64, max: u64, what: &str) -> Result<u64, Fail> {
    whole_in(value, max)
        .ok_or_else(|| Fail::invalid(format!("{what} must be a whole number from 0 to {max}")))
}

/// A number as an id: a whole value from 0 to 2^53 - 1.
///
/// # Arguments
///
/// * `value` - the number.
/// * `what` - the argument's name, for the message.
///
/// # Returns
///
/// The id.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for any other number.
pub(crate) fn id(value: f64, what: &str) -> Result<u64, Fail> {
    whole(value, ID_MAX, what)
}

/// A number as a 16-bit value, such as a status or a close code.
///
/// # Arguments
///
/// * `value` - the number.
/// * `what` - the argument's name, for the message.
///
/// # Returns
///
/// The value.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a number that is not a whole value from 0 to 65535.
pub(crate) fn u16_of(value: f64, what: &str) -> Result<u16, Fail> {
    let value = whole(value, u64::from(u16::MAX), what)?;
    u16::try_from(value).map_err(|_| Fail::invalid(format!("{what} is out of range")))
}

/// A number as a 32-bit value, such as a route kind, a count or a duration.
///
/// # Arguments
///
/// * `value` - the number.
/// * `what` - the argument's name, for the message.
///
/// # Returns
///
/// The value.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a number that is not a whole value from 0 to
/// 2^32 - 1.
pub(crate) fn u32_of(value: f64, what: &str) -> Result<u32, Fail> {
    let value = whole(value, u64::from(u32::MAX), what)?;
    u32::try_from(value).map_err(|_| Fail::invalid(format!("{what} is out of range")))
}

/// A number as an 8-bit code, such as a method id or an opcode.
///
/// # Arguments
///
/// * `value` - the number.
/// * `what` - the argument's name, for the message.
///
/// # Returns
///
/// The code.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a number that is not a whole value from 0 to 255.
pub(crate) fn u8_of(value: f64, what: &str) -> Result<u8, Fail> {
    let value = whole(value, u64::from(u8::MAX), what)?;
    u8::try_from(value).map_err(|_| Fail::invalid(format!("{what} is out of range")))
}

/// A number as a worker index: a whole value from 0 to 127.
///
/// # Arguments
///
/// * `value` - the number.
///
/// # Returns
///
/// The index.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for any other number.
pub(crate) fn worker(value: f64) -> Result<u8, Fail> {
    let index = whole(value, WORKERS - 1, "the worker index")?;
    u8::try_from(index).map_err(|_| Fail::invalid("the worker index is out of range"))
}

/// A number as a length in octets.
///
/// # Arguments
///
/// * `value` - the number.
/// * `what` - the argument's name, for the message.
///
/// # Returns
///
/// The length.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a number that is not a whole value this platform can
/// address.
pub(crate) fn length(value: f64, what: &str) -> Result<usize, Fail> {
    let max = u64::try_from(usize::MAX).unwrap_or(u64::MAX);
    let value = whole(value, max, what)?;
    usize::try_from(value).map_err(|_| Fail::invalid(format!("{what} is out of range")))
}

/// An id as the JavaScript number that names it.
///
/// # Arguments
///
/// * `id` - the id, at most 2^53 - 1.
///
/// # Returns
///
/// The number, exact for every id.
pub(crate) fn number(id: u64) -> f64 {
    id.min(ID_MAX) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::Code;

    #[test]
    fn an_id_is_a_whole_number_from_zero_to_two_to_the_fifty_three_minus_one() {
        assert_eq!(id(0.0, "id").ok(), Some(0));
        assert_eq!(id(-0.0, "id").ok(), Some(0));
        assert_eq!(id(42.0, "id").ok(), Some(42));
        assert_eq!(id(9_007_199_254_740_991.0, "id").ok(), Some(ID_MAX));
        for refused in [
            -1.0,
            0.5,
            1.5,
            9_007_199_254_740_992.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::MAX,
            -f64::MIN_POSITIVE,
        ] {
            let fail = id(refused, "the slot id").err();
            assert_eq!(
                fail.as_ref().map(Fail::code),
                Some(Code::INVALID_ARGUMENT),
                "{refused} was accepted as an id"
            );
        }
    }

    #[test]
    fn narrow_values_are_refused_outside_their_range_instead_of_truncated() {
        assert_eq!(u16_of(65_535.0, "status").ok(), Some(u16::MAX));
        assert!(u16_of(65_536.0, "status").is_err());
        assert!(u16_of(200.5, "status").is_err());
        assert_eq!(u8_of(255.0, "opcode").ok(), Some(u8::MAX));
        assert!(u8_of(256.0, "opcode").is_err());
        assert_eq!(u32_of(4_294_967_295.0, "count").ok(), Some(u32::MAX));
        assert!(u32_of(4_294_967_296.0, "count").is_err());
        assert_eq!(worker(127.0).ok(), Some(127));
        assert!(worker(128.0).is_err());
        assert!(worker(-1.0).is_err());
        assert_eq!(length(65_536.0, "length").ok(), Some(65_536));
        assert!(length(f64::NAN, "length").is_err());
    }

    #[test]
    fn an_id_crosses_back_to_javascript_without_loss() {
        for value in [0, 1, 4_096, (1 << 32) + 7, ID_MAX] {
            assert_eq!(id(number(value), "id").ok(), Some(value));
        }
    }
}
