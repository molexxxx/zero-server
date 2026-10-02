//! The proleptic Gregorian calendar: days since 1970-01-01 to and from a civil
//! date, for every four-digit year.
//!
//! The conversions are the era-based algorithms that work on 400-year cycles,
//! so no loop over years or months runs on the hot path.

/// A date in the proleptic Gregorian calendar, at UTC.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CivilDate {
    /// The year, 0 to 9999.
    pub year: i32,
    /// The month, 1 to 12.
    pub month: u8,
    /// The day of the month, 1 to 31.
    pub day: u8,
}

/// Days from 1970-01-01 to 0000-01-01, the earliest supported date.
pub const MIN_DAYS: i64 = -719_528;
/// Days from 1970-01-01 to 9999-12-31, the latest supported date.
pub const MAX_DAYS: i64 = 2_932_896;

const DAYS_PER_ERA: i64 = 146_097;
const DAYS_TO_ERA_START: i64 = 719_468;

/// Returns `true` when `year` has a 29th of February.
///
/// # Arguments
///
/// * `year` - the year in the proleptic Gregorian calendar.
#[must_use]
pub const fn is_leap_year(year: i32) -> bool {
    year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
}

/// Returns the number of days in a month.
///
/// # Arguments
///
/// * `year` - the year, which decides the length of February.
/// * `month` - the month, 1 to 12.
///
/// # Returns
///
/// The day count, or `None` when `month` is not 1 to 12.
#[must_use]
pub const fn days_in_month(year: i32, month: u8) -> Option<u8> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 => Some(if is_leap_year(year) { 29 } else { 28 }),
        _ => None,
    }
}

/// Converts a day count since 1970-01-01 to a civil date.
///
/// # Arguments
///
/// * `days` - days since 1970-01-01; negative values are earlier dates.
///
/// # Returns
///
/// The date, or `None` when `days` is outside [`MIN_DAYS`] to [`MAX_DAYS`].
#[must_use]
pub fn civil_from_days(days: i64) -> Option<CivilDate> {
    if !(MIN_DAYS..=MAX_DAYS).contains(&days) {
        return None;
    }
    let shifted = days.checked_add(DAYS_TO_ERA_START)?;
    let era = shifted.div_euclid(DAYS_PER_ERA);
    let day_of_era = shifted.rem_euclid(DAYS_PER_ERA);
    let year_of_era = day_of_era
        .checked_sub(day_of_era.div_euclid(1_460))?
        .checked_add(day_of_era.div_euclid(36_524))?
        .checked_sub(day_of_era.div_euclid(146_096))?
        .div_euclid(365);
    let year = year_of_era.checked_add(era.checked_mul(400)?)?;
    let days_before_year = year_of_era
        .checked_mul(365)?
        .checked_add(year_of_era.div_euclid(4))?
        .checked_sub(year_of_era.div_euclid(100))?;
    let day_of_year = day_of_era.checked_sub(days_before_year)?;
    let shifted_month = day_of_year.checked_mul(5)?.checked_add(2)?.div_euclid(153);
    let days_before_month = shifted_month
        .checked_mul(153)?
        .checked_add(2)?
        .div_euclid(5);
    let day = day_of_year.checked_sub(days_before_month)?.checked_add(1)?;
    let month = if shifted_month < 10 {
        shifted_month.checked_add(3)?
    } else {
        shifted_month.checked_sub(9)?
    };
    let year = if month <= 2 {
        year.checked_add(1)?
    } else {
        year
    };
    Some(CivilDate {
        year: i32::try_from(year).ok()?,
        month: u8::try_from(month).ok()?,
        day: u8::try_from(day).ok()?,
    })
}

/// Converts a civil date to a day count since 1970-01-01.
///
/// # Arguments
///
/// * `date` - the date; its year must be 0 to 9999 and its day must exist in
///   its month.
///
/// # Returns
///
/// The day count, or `None` when the date is not a real date in the supported
/// range.
#[must_use]
pub fn days_from_civil(date: CivilDate) -> Option<i64> {
    if date.day == 0 || date.day > days_in_month(date.year, date.month)? {
        return None;
    }
    let year = i64::from(date.year);
    let month = i64::from(date.month);
    let day = i64::from(date.day);
    let year = if month <= 2 {
        year.checked_sub(1)?
    } else {
        year
    };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted_month = if month > 2 {
        month.checked_sub(3)?
    } else {
        month.checked_add(9)?
    };
    let day_of_year = shifted_month
        .checked_mul(153)?
        .checked_add(2)?
        .div_euclid(5)
        .checked_add(day)?
        .checked_sub(1)?;
    let day_of_era = year_of_era
        .checked_mul(365)?
        .checked_add(year_of_era.div_euclid(4))?
        .checked_sub(year_of_era.div_euclid(100))?
        .checked_add(day_of_year)?;
    let days = era
        .checked_mul(DAYS_PER_ERA)?
        .checked_add(day_of_era)?
        .checked_sub(DAYS_TO_ERA_START)?;
    if (MIN_DAYS..=MAX_DAYS).contains(&days) {
        Some(days)
    } else {
        None
    }
}

/// Returns the day of the week of a day count, 0 for Sunday through 6 for
/// Saturday.
///
/// # Arguments
///
/// * `days` - days since 1970-01-01, which was a Thursday.
#[must_use]
pub fn weekday_from_days(days: i64) -> u8 {
    let weekday = days.rem_euclid(7).wrapping_add(4).rem_euclid(7);
    u8::try_from(weekday).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        civil_from_days, days_from_civil, days_in_month, is_leap_year, weekday_from_days,
        CivilDate, MAX_DAYS, MIN_DAYS,
    };

    const fn date(year: i32, month: u8, day: u8) -> CivilDate {
        CivilDate { year, month, day }
    }

    #[test]
    fn the_epoch_and_its_neighbors() {
        assert_eq!(civil_from_days(0), Some(date(1970, 1, 1)));
        assert_eq!(civil_from_days(-1), Some(date(1969, 12, 31)));
        assert_eq!(civil_from_days(1), Some(date(1970, 1, 2)));
        assert_eq!(weekday_from_days(0), 4);
        assert_eq!(weekday_from_days(-1), 3);
        assert_eq!(weekday_from_days(3), 0);
        assert_eq!(weekday_from_days(-4), 0);
    }

    #[test]
    fn leap_years_follow_the_gregorian_rule() {
        assert!(is_leap_year(2000));
        assert!(is_leap_year(2024));
        assert!(!is_leap_year(1900));
        assert!(!is_leap_year(2100));
        assert!(!is_leap_year(2023));
        assert!(is_leap_year(0));
        assert_eq!(days_in_month(2000, 2), Some(29));
        assert_eq!(days_in_month(1900, 2), Some(28));
        assert_eq!(days_in_month(2023, 4), Some(30));
        assert_eq!(days_in_month(2023, 13), None);
        assert_eq!(days_in_month(2023, 0), None);
    }

    #[test]
    fn century_boundaries() {
        assert_eq!(civil_from_days(-25_509), Some(date(1900, 2, 28)));
        assert_eq!(civil_from_days(-25_508), Some(date(1900, 3, 1)));
        assert_eq!(civil_from_days(11_016), Some(date(2000, 2, 29)));
        assert_eq!(civil_from_days(47_482), Some(date(2100, 1, 1)));
        assert_eq!(weekday_from_days(47_482), 5);
    }

    #[test]
    fn the_supported_range_is_every_four_digit_year() {
        assert_eq!(civil_from_days(MIN_DAYS), Some(date(0, 1, 1)));
        assert_eq!(civil_from_days(MAX_DAYS), Some(date(9999, 12, 31)));
        assert_eq!(civil_from_days(MIN_DAYS - 1), None);
        assert_eq!(civil_from_days(MAX_DAYS + 1), None);
        assert_eq!(civil_from_days(i64::MIN), None);
        assert_eq!(civil_from_days(i64::MAX), None);
        assert_eq!(days_from_civil(date(-1, 12, 31)), None);
        assert_eq!(days_from_civil(date(10_000, 1, 1)), None);
    }

    #[test]
    fn impossible_dates_are_refused() {
        assert_eq!(days_from_civil(date(2023, 2, 29)), None);
        assert_eq!(days_from_civil(date(2024, 2, 30)), None);
        assert_eq!(days_from_civil(date(2024, 4, 31)), None);
        assert_eq!(days_from_civil(date(2024, 13, 1)), None);
        assert_eq!(days_from_civil(date(2024, 0, 1)), None);
        assert_eq!(days_from_civil(date(2024, 1, 0)), None);
    }

    #[test]
    fn every_day_of_the_range_round_trips_and_advances_by_one() {
        // Miri interprets every step, so under it the walk covers a year and a half
        // from each era boundary instead of all 3.65 million days.
        let walks: &[(CivilDate, usize)] = if cfg!(miri) {
            &[
                (date(0, 1, 1), 550),
                (date(1599, 12, 1), 550),
                (date(1899, 12, 1), 550),
                (date(1969, 12, 1), 550),
                (date(1999, 12, 1), 550),
                (date(9998, 12, 1), 550),
            ]
        } else {
            &[(date(0, 1, 1), usize::MAX)]
        };
        for &(start, count) in walks {
            let mut expected = start;
            let mut days = days_from_civil(start);
            for _ in 0..count {
                let Some(current) = days.filter(|days| *days <= MAX_DAYS) else {
                    break;
                };
                assert_eq!(civil_from_days(current), Some(expected), "day {current}");
                assert_eq!(days_from_civil(expected), Some(current), "day {current}");
                expected = next_day(expected);
                days = current.checked_add(1);
            }
            assert!(days.is_some(), "{start:?}");
        }
        assert_eq!(days_from_civil(date(0, 1, 1)), Some(MIN_DAYS));
    }

    fn next_day(date: CivilDate) -> CivilDate {
        let last = days_in_month(date.year, date.month).unwrap_or(31);
        if date.day < last {
            CivilDate {
                day: date.day.wrapping_add(1),
                ..date
            }
        } else if date.month < 12 {
            CivilDate {
                month: date.month.wrapping_add(1),
                day: 1,
                ..date
            }
        } else {
            CivilDate {
                year: date.year.wrapping_add(1),
                month: 1,
                day: 1,
            }
        }
    }
}
