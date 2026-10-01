//! The IMF-fixdate formatter: the one HTTP-date format a sender generates.
//!
//! RFC 9110 Section 5.6.7 defines three HTTP-date formats and requires that
//! "when a sender generates a field that contains one or more timestamps
//! defined as HTTP-date, the sender MUST generate those timestamps in the
//! IMF-fixdate format". The format is fixed length, 29 bytes, always in GMT:
//!
//! ```text
//! IMF-fixdate  = day-name "," SP date1 SP time-of-day SP GMT
//! date1        = day SP month SP year
//! time-of-day  = hour ":" minute ":" second
//! ```
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7>

use core::fmt;

use crate::civil::{civil_from_days, weekday_from_days};

/// The length of every IMF-fixdate value.
pub const IMF_FIXDATE_LEN: usize = 29;

/// The last unix timestamp with a four-digit year: 9999-12-31 23:59:59.
pub const MAX_UNIX_SECONDS: u64 = 253_402_300_799;

const SECONDS_PER_DAY: u64 = 86_400;
const SECONDS_PER_HOUR: u64 = 3_600;
const SECONDS_PER_MINUTE: u64 = 60;

/// The `day-name` tokens of the grammar, indexed from Sunday.
const DAY_NAMES: [&[u8; 3]; 7] = [b"Sun", b"Mon", b"Tue", b"Wed", b"Thu", b"Fri", b"Sat"];

/// The `month` tokens of the grammar, indexed from January.
const MONTH_NAMES: [&[u8; 3]; 12] = [
    b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun", b"Jul", b"Aug", b"Sep", b"Oct", b"Nov", b"Dec",
];

/// An HTTP-date in the IMF-fixdate format, such as
/// `Sun, 06 Nov 1994 08:49:37 GMT`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ImfFixdate([u8; IMF_FIXDATE_LEN]);

impl ImfFixdate {
    /// Formats a unix timestamp.
    ///
    /// # Arguments
    ///
    /// * `unix_seconds` - seconds since 1970-01-01 00:00:00 UTC, with no leap
    ///   seconds, as every operating system clock reports them.
    ///
    /// # Returns
    ///
    /// The formatted date, or `None` when the year would need more than four
    /// digits, that is when `unix_seconds` exceeds [`MAX_UNIX_SECONDS`].
    #[must_use]
    pub fn from_unix(unix_seconds: u64) -> Option<Self> {
        if unix_seconds > MAX_UNIX_SECONDS {
            return None;
        }
        let days = i64::try_from(unix_seconds.div_euclid(SECONDS_PER_DAY)).ok()?;
        let second_of_day = unix_seconds.rem_euclid(SECONDS_PER_DAY);
        let date = civil_from_days(days)?;
        let weekday = weekday_from_days(days);
        let hour = second_of_day.div_euclid(SECONDS_PER_HOUR);
        let minute = second_of_day
            .rem_euclid(SECONDS_PER_HOUR)
            .div_euclid(SECONDS_PER_MINUTE);
        let second = second_of_day.rem_euclid(SECONDS_PER_MINUTE);

        let mut out = *b"Sun, 00 Jan 0000 00:00:00 GMT";
        put(&mut out, 0, **DAY_NAMES.get(usize::from(weekday))?);
        put_two_digits(&mut out, 5, date.day);
        let month = usize::from(date.month).checked_sub(1)?;
        put(&mut out, 8, **MONTH_NAMES.get(month)?);
        put_four_digits(&mut out, 12, u16::try_from(date.year).ok()?);
        put_two_digits(&mut out, 17, u8::try_from(hour).ok()?);
        put_two_digits(&mut out, 20, u8::try_from(minute).ok()?);
        put_two_digits(&mut out, 23, u8::try_from(second).ok()?);
        Some(Self(out))
    }

    /// Returns the 29 ASCII bytes of the date.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; IMF_FIXDATE_LEN] {
        &self.0
    }

    /// Returns the date as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        // Every byte is ASCII by construction, so the conversion cannot fail.
        core::str::from_utf8(&self.0).unwrap_or("")
    }
}

impl AsRef<[u8]> for ImfFixdate {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Display for ImfFixdate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl fmt::Debug for ImfFixdate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ImfFixdate({:?})", self.as_str())
    }
}

/// Formats a unix timestamp as an IMF-fixdate.
///
/// # Arguments
///
/// * `unix_seconds` - seconds since 1970-01-01 00:00:00 UTC.
///
/// # Returns
///
/// The formatted date, or `None` past [`MAX_UNIX_SECONDS`].
#[must_use]
pub fn imf_fixdate(unix_seconds: u64) -> Option<ImfFixdate> {
    ImfFixdate::from_unix(unix_seconds)
}

fn put(out: &mut [u8; IMF_FIXDATE_LEN], at: usize, bytes: [u8; 3]) {
    if let Some(slot) = at.checked_add(3).and_then(|end| out.get_mut(at..end)) {
        slot.copy_from_slice(&bytes);
    }
}

const fn digit(value: u8) -> u8 {
    b'0'.wrapping_add(value.rem_euclid(10))
}

fn put_two_digits(out: &mut [u8; IMF_FIXDATE_LEN], at: usize, value: u8) {
    let digits = [digit(value.div_euclid(10)), digit(value)];
    if let Some(slot) = at.checked_add(2).and_then(|end| out.get_mut(at..end)) {
        slot.copy_from_slice(&digits);
    }
}

fn put_four_digits(out: &mut [u8; IMF_FIXDATE_LEN], at: usize, value: u16) {
    let digits = [
        digit(u8::try_from(value.div_euclid(1_000)).unwrap_or_default()),
        digit(u8::try_from(value.div_euclid(100).rem_euclid(10)).unwrap_or_default()),
        digit(u8::try_from(value.div_euclid(10).rem_euclid(10)).unwrap_or_default()),
        digit(u8::try_from(value.rem_euclid(10)).unwrap_or_default()),
    ];
    if let Some(slot) = at.checked_add(4).and_then(|end| out.get_mut(at..end)) {
        slot.copy_from_slice(&digits);
    }
}

#[cfg(test)]
mod tests {
    use super::{imf_fixdate, ImfFixdate, IMF_FIXDATE_LEN, MAX_UNIX_SECONDS};

    fn text(unix_seconds: u64) -> alloc::string::String {
        imf_fixdate(unix_seconds).map_or_else(alloc::string::String::new, |date| {
            alloc::string::String::from(date.as_str())
        })
    }

    /// RFC 9110 Section 5.6.7: the IMF-fixdate example, and the rule that a
    /// sender generates every HTTP-date in this format with no whitespace beyond
    /// the grammar's own.
    #[test]
    fn generated_http_date_values_date_last_modified_expires_cookie_expiry_use_imf() {
        let date = ImfFixdate::from_unix(784_111_777);
        assert_eq!(
            date.map(|date| *date.as_bytes()),
            Some(*b"Sun, 06 Nov 1994 08:49:37 GMT")
        );
        assert_eq!(text(784_111_777), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(IMF_FIXDATE_LEN, "Sun, 06 Nov 1994 08:49:37 GMT".len());
        assert!(!text(784_111_777).contains("  "));
    }

    #[test]
    fn the_epoch_and_zero_padding() {
        assert_eq!(text(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(text(1), "Thu, 01 Jan 1970 00:00:01 GMT");
        assert_eq!(text(86_399), "Thu, 01 Jan 1970 23:59:59 GMT");
        assert_eq!(text(86_400), "Fri, 02 Jan 1970 00:00:00 GMT");
    }

    #[test]
    fn leap_days_and_century_rules() {
        assert_eq!(text(951_782_400), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(text(1_709_164_800), "Thu, 29 Feb 2024 00:00:00 GMT");
        assert_eq!(text(4_102_444_800), "Fri, 01 Jan 2100 00:00:00 GMT");
    }

    #[test]
    fn every_month_and_weekday_name_appears() {
        let mut months = alloc::vec::Vec::new();
        let mut weekdays = alloc::vec::Vec::new();
        for day in 0..366u64 {
            let formatted = text(day.wrapping_mul(86_400));
            months.push(formatted.get(8..11).map(alloc::string::String::from));
            weekdays.push(formatted.get(0..3).map(alloc::string::String::from));
        }
        for name in [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ] {
            assert!(months.contains(&Some(name.into())), "{name}");
        }
        for name in ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] {
            assert!(weekdays.contains(&Some(name.into())), "{name}");
        }
    }

    #[test]
    fn four_digit_years_are_the_limit() {
        assert_eq!(text(MAX_UNIX_SECONDS), "Fri, 31 Dec 9999 23:59:59 GMT");
        assert_eq!(imf_fixdate(MAX_UNIX_SECONDS + 1), None);
        assert_eq!(imf_fixdate(u64::MAX), None);
    }

    #[test]
    fn display_and_debug_show_the_text() {
        let date = imf_fixdate(784_111_777);
        assert_eq!(
            date.map(|date| alloc::format!("{date}")),
            Some("Sun, 06 Nov 1994 08:49:37 GMT".into())
        );
        assert_eq!(
            date.map(|date| alloc::format!("{date:?}")),
            Some("ImfFixdate(\"Sun, 06 Nov 1994 08:49:37 GMT\")".into())
        );
        assert_eq!(date.map(|date| date.as_ref().len()), Some(29));
    }
}
