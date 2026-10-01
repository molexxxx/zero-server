//! Date formatting for zero-server.
//!
//! The IMF-fixdate formatter from a unix timestamp, the proleptic Gregorian
//! calendar conversions it rests on, and the fixed-width decimal formatter the
//! response serializer uses for `Content-Length` and the status line. Nothing
//! here reads a clock: the caller supplies the timestamp, so the crate is
//! `no_std` and the runtime refreshes one formatted value per second.
//!
//! The primary items are:
//!
//! - [`ImfFixdate`] and [`imf_fixdate`] - the HTTP-date format a sender
//!   generates (RFC 9110 Section 5.6.7).
//! - [`CivilDate`], [`civil_from_days`] and [`days_from_civil`] - days since
//!   1970-01-01 to and from a calendar date.
//! - [`Decimal`] - an unsigned integer as decimal digits in a stack buffer.
//! - [`VERSION`] - the version of the crate.
//!
//! # Examples
//!
//! ```
//! use zero_date::{imf_fixdate, Decimal};
//!
//! let date = imf_fixdate(784_111_777).expect("a four-digit year");
//! assert_eq!(date.as_str(), "Sun, 06 Nov 1994 08:49:37 GMT");
//! assert_eq!(Decimal::new(1_024).as_str(), "1024");
//! ```

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod civil;
pub mod decimal;
pub mod imf;
pub mod parse;

pub use civil::{
    civil_from_days, days_from_civil, days_in_month, is_leap_year, weekday_from_days, CivilDate,
    MAX_DAYS, MIN_DAYS,
};
pub use decimal::{Decimal, MAX_DECIMAL_LEN};
pub use imf::{imf_fixdate, ImfFixdate, IMF_FIXDATE_LEN, MAX_UNIX_SECONDS};
pub use parse::parse_http_date;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
