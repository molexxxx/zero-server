//! The HTTP-date parser: the three formats a recipient must accept.
//!
//! RFC 9110 Section 5.6.7: "A recipient that parses a timestamp value in an HTTP
//! field MUST accept all three HTTP-date formats", the IMF-fixdate
//! (`Sun, 06 Nov 1994 08:49:37 GMT`), the obsolete RFC 850 format
//! (`Sunday, 06-Nov-94 08:49:37 GMT`) and ANSI C's `asctime()` format
//! (`Sun Nov  6 08:49:37 1994`). The first two carry `GMT`; the third "is assumed
//! to be in UTC". A two-digit year "that appears to be more than 50 years in the
//! future" is read as "the most recent year in the past that had the same last two
//! digits". The grammar is case-sensitive.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7>

use crate::civil::{civil_from_days, days_from_civil, CivilDate};

const SECONDS_PER_DAY: u64 = 86_400;
const SECONDS_PER_HOUR: u64 = 3_600;
const SECONDS_PER_MINUTE: u64 = 60;

/// The `day-name` tokens, indexed from Sunday.
const DAY_NAMES: [&[u8]; 7] = [b"Sun", b"Mon", b"Tue", b"Wed", b"Thu", b"Fri", b"Sat"];

/// The `day-name-l` tokens of the RFC 850 format, indexed from Sunday.
const LONG_DAY_NAMES: [&[u8]; 7] = [
    b"Sunday",
    b"Monday",
    b"Tuesday",
    b"Wednesday",
    b"Thursday",
    b"Friday",
    b"Saturday",
];

/// The `month` tokens, indexed from January.
const MONTH_NAMES: [&[u8]; 12] = [
    b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun", b"Jul", b"Aug", b"Sep", b"Oct", b"Nov", b"Dec",
];

/// The clock fields of one timestamp, before the calendar is applied.
struct Fields {
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
}

/// A cursor over the input that consumes what the grammar names.
struct Cursor<'a> {
    rest: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn literal(&mut self, expected: &[u8]) -> Option<()> {
        let rest = self.rest.strip_prefix(expected)?;
        self.rest = rest;
        Some(())
    }

    /// One of `names`, returning its index.
    fn one_of(&mut self, names: &[&[u8]]) -> Option<usize> {
        for (index, name) in names.iter().enumerate() {
            if let Some(rest) = self.rest.strip_prefix(*name) {
                self.rest = rest;
                return Some(index);
            }
        }
        None
    }

    /// Exactly `count` digits.
    fn digits(&mut self, count: usize) -> Option<u32> {
        let (taken, rest) = self.rest.split_at_checked(count)?;
        let mut value: u32 = 0;
        for byte in taken {
            if !byte.is_ascii_digit() {
                return None;
            }
            value = value
                .checked_mul(10)?
                .checked_add(u32::from(byte.wrapping_sub(b'0')))?;
        }
        self.rest = rest;
        Some(value)
    }

    /// `hour ":" minute ":" second`.
    fn time_of_day(&mut self) -> Option<(u8, u8, u8)> {
        let hour = self.digits(2)?;
        self.literal(b":")?;
        let minute = self.digits(2)?;
        self.literal(b":")?;
        let second = self.digits(2)?;
        Some((
            u8::try_from(hour).ok()?,
            u8::try_from(minute).ok()?,
            u8::try_from(second).ok()?,
        ))
    }

    fn month(&mut self) -> Option<u8> {
        let index = self.one_of(&MONTH_NAMES)?;
        u8::try_from(index.checked_add(1)?).ok()
    }

    fn done(&self) -> bool {
        self.rest.is_empty()
    }
}

/// `IMF-fixdate = day-name "," SP date1 SP time-of-day SP GMT`.
fn imf_fixdate(input: &[u8]) -> Option<Fields> {
    let mut cursor = Cursor { rest: input };
    cursor.one_of(&DAY_NAMES)?;
    cursor.literal(b", ")?;
    let day = u8::try_from(cursor.digits(2)?).ok()?;
    cursor.literal(b" ")?;
    let month = cursor.month()?;
    cursor.literal(b" ")?;
    let year = i32::try_from(cursor.digits(4)?).ok()?;
    cursor.literal(b" ")?;
    let (hour, minute, second) = cursor.time_of_day()?;
    cursor.literal(b" GMT")?;
    cursor.done().then_some(Fields {
        year,
        month,
        day,
        hour,
        minute,
        second,
    })
}

/// `rfc850-date = day-name-l "," SP date2 SP time-of-day SP GMT`, with the
/// two-digit year read against `now`.
fn rfc850_date(input: &[u8], now_year: i32) -> Option<Fields> {
    let mut cursor = Cursor { rest: input };
    cursor.one_of(&LONG_DAY_NAMES)?;
    cursor.literal(b", ")?;
    let day = u8::try_from(cursor.digits(2)?).ok()?;
    cursor.literal(b"-")?;
    let month = cursor.month()?;
    cursor.literal(b"-")?;
    let two_digits = i32::try_from(cursor.digits(2)?).ok()?;
    cursor.literal(b" ")?;
    let (hour, minute, second) = cursor.time_of_day()?;
    cursor.literal(b" GMT")?;
    if !cursor.done() {
        return None;
    }
    // The year in the current century with those two digits, moved back a century
    // when it would be more than 50 years in the future.
    let century = now_year.checked_div(100)?.checked_mul(100)?;
    let mut year = century.checked_add(two_digits)?;
    if year.checked_sub(now_year)? > 50 {
        year = year.checked_sub(100)?;
    }
    Some(Fields {
        year,
        month,
        day,
        hour,
        minute,
        second,
    })
}

/// `asctime-date = day-name SP date3 SP time-of-day SP year`, where `date3` is
/// the month and a day of two digits or a space and one digit.
fn asctime_date(input: &[u8]) -> Option<Fields> {
    let mut cursor = Cursor { rest: input };
    cursor.one_of(&DAY_NAMES)?;
    cursor.literal(b" ")?;
    let month = cursor.month()?;
    cursor.literal(b" ")?;
    let day = if cursor.literal(b" ").is_some() {
        cursor.digits(1)?
    } else {
        cursor.digits(2)?
    };
    let day = u8::try_from(day).ok()?;
    cursor.literal(b" ")?;
    let (hour, minute, second) = cursor.time_of_day()?;
    cursor.literal(b" ")?;
    let year = i32::try_from(cursor.digits(4)?).ok()?;
    cursor.done().then_some(Fields {
        year,
        month,
        day,
        hour,
        minute,
        second,
    })
}

/// The unix timestamp of the fields; a leap second (`:60`) counts as the next
/// minute, and a date before 1970 is 0.
fn unix_of(fields: Fields) -> Option<u64> {
    if fields.hour > 23 || fields.minute > 59 || fields.second > 60 {
        return None;
    }
    let days = days_from_civil(CivilDate {
        year: fields.year,
        month: fields.month,
        day: fields.day,
    })?;
    let Ok(days) = u64::try_from(days) else {
        return Some(0);
    };
    let seconds = u64::from(fields.hour)
        .checked_mul(SECONDS_PER_HOUR)?
        .checked_add(u64::from(fields.minute).checked_mul(SECONDS_PER_MINUTE)?)?
        .checked_add(u64::from(fields.second))?;
    days.checked_mul(SECONDS_PER_DAY)?.checked_add(seconds)
}

/// Parses an HTTP-date in any of the three formats of RFC 9110 Section 5.6.7.
///
/// # Arguments
///
/// * `value` - the field value, with no surrounding whitespace.
/// * `now` - the current unix timestamp, which decides the century of an RFC 850
///   two-digit year.
///
/// # Returns
///
/// The unix timestamp, or `None` when the value is none of the three formats or
/// names a day that does not exist; a date before 1970 is 0.
#[must_use]
pub fn parse_http_date(value: &[u8], now: u64) -> Option<u64> {
    let fields = match value.first()? {
        _ if value.get(3) == Some(&b',') => imf_fixdate(value)?,
        _ if value.get(3) == Some(&b' ') => asctime_date(value)?,
        _ => {
            let now_days = i64::try_from(now.div_euclid(SECONDS_PER_DAY)).ok()?;
            let now_year = civil_from_days(now_days)?.year;
            rfc850_date(value, now_year)?
        }
    };
    unix_of(fields)
}

#[cfg(test)]
mod tests {
    use super::parse_http_date;

    /// RFC 9110 Section 5.6.7's three examples name the same instant.
    const EXAMPLE: u64 = 784_111_777;
    /// A clock in 2026, for the two-digit year.
    const NOW: u64 = 1_780_000_000;

    #[test]
    fn a_recipient_that_parses_a_timestamp_value_in_an_http_field_must_accept_all_three_http_date_formats(
    ) {
        assert_eq!(
            parse_http_date(b"Sun, 06 Nov 1994 08:49:37 GMT", NOW),
            Some(EXAMPLE)
        );
        assert_eq!(
            parse_http_date(b"Sunday, 06-Nov-94 08:49:37 GMT", NOW),
            Some(EXAMPLE)
        );
        assert_eq!(
            parse_http_date(b"Sun Nov  6 08:49:37 1994", NOW),
            Some(EXAMPLE)
        );
        assert_eq!(
            parse_http_date(b"Tue, 15 Nov 1994 12:45:26 GMT", NOW),
            Some(784_903_526)
        );
    }

    #[test]
    fn a_two_digit_year_more_than_fifty_years_ahead_is_the_past_century() {
        // 94 against a clock in 2026 is 1994, not 2094.
        assert_eq!(
            parse_http_date(b"Sunday, 06-Nov-94 08:49:37 GMT", NOW),
            Some(EXAMPLE)
        );
        // 30 against the same clock is 2030, four years ahead.
        assert_eq!(
            parse_http_date(b"Friday, 01-Nov-30 00:00:00 GMT", NOW),
            parse_http_date(b"Fri, 01 Nov 2030 00:00:00 GMT", NOW)
        );
    }

    #[test]
    fn the_grammar_is_case_sensitive_and_exact() {
        assert_eq!(parse_http_date(b"sun, 06 Nov 1994 08:49:37 GMT", NOW), None);
        assert_eq!(parse_http_date(b"Sun, 06 Nov 1994 08:49:37 UTC", NOW), None);
        assert_eq!(parse_http_date(b"Sun, 6 Nov 1994 08:49:37 GMT", NOW), None);
        assert_eq!(
            parse_http_date(b"Sun, 06 Nov 1994 08:49:37 GMT ", NOW),
            None
        );
        assert_eq!(parse_http_date(b"Sun, 31 Nov 1994 08:49:37 GMT", NOW), None);
        assert_eq!(parse_http_date(b"Sun, 06 Nov 1994 24:00:00 GMT", NOW), None);
        assert_eq!(parse_http_date(b"", NOW), None);
    }

    #[test]
    fn a_leap_second_and_a_date_before_1970_stay_in_range() {
        assert_eq!(
            parse_http_date(b"Sat, 31 Dec 2016 23:59:60 GMT", NOW),
            Some(1_483_228_800)
        );
        assert_eq!(
            parse_http_date(b"Thu, 01 Jan 1970 00:00:00 GMT", NOW),
            Some(0)
        );
        assert_eq!(
            parse_http_date(b"Wed, 31 Dec 1969 23:59:59 GMT", NOW),
            Some(0)
        );
    }
}
