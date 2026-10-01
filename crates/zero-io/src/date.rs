//! The per-core `Date` header block.
//!
//! Every response carries `Date` (the TechEmpower requirements and RFC 9110 section
//! 6.6.1 both ask for it), and formatting a date per response is wasted work: one
//! service per core formats the block once a second and every response copies it.
//! The block is `Date: <IMF-fixdate>\r\n`, 37 bytes, with the date from `zero-date`.

use std::cell::Cell;
use std::time::{SystemTime, UNIX_EPOCH};

use zero_date::{ImfFixdate, IMF_FIXDATE_LEN};

/// The length of the block: `Date: ` (6), the date (29), `\r\n` (2).
pub const DATE_BLOCK_LEN: usize = 6 + IMF_FIXDATE_LEN + 2;

/// A `Date` block refreshed on demand, read by every response on its core.
#[derive(Debug)]
pub struct Date {
    block: Cell<[u8; DATE_BLOCK_LEN]>,
    unix: Cell<u64>,
}

impl Date {
    /// A block holding the current time.
    #[must_use]
    pub fn now() -> Self {
        let date = Date {
            block: Cell::new([0; DATE_BLOCK_LEN]),
            unix: Cell::new(0),
        };
        date.refresh();
        date
    }

    /// Reformat the block from the clock; cheap when the second has not changed.
    pub fn refresh(&self) {
        let unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        if unix == self.unix.get() && self.block.get() != [0; DATE_BLOCK_LEN] {
            return;
        }
        self.set_unix(unix);
    }

    /// Format the block for a given time.
    ///
    /// # Arguments
    ///
    /// * `unix` - seconds since the Unix epoch; a time past the year 9999 formats
    ///   as the last representable second.
    pub fn set_unix(&self, unix: u64) {
        let date = ImfFixdate::from_unix(unix)
            .or_else(|| ImfFixdate::from_unix(zero_date::MAX_UNIX_SECONDS))
            .unwrap_or_else(|| {
                ImfFixdate::from_unix(0).unwrap_or_else(|| unreachable!("the epoch formats"))
            });
        let mut block = [0; DATE_BLOCK_LEN];
        block[..6].copy_from_slice(b"Date: ");
        block[6..6 + IMF_FIXDATE_LEN].copy_from_slice(date.as_bytes());
        block[6 + IMF_FIXDATE_LEN..].copy_from_slice(b"\r\n");
        self.block.set(block);
        self.unix.set(unix);
    }

    /// The block, `Date: <IMF-fixdate>\r\n`.
    #[must_use]
    pub fn block(&self) -> [u8; DATE_BLOCK_LEN] {
        self.block.get()
    }

    /// The seconds since the Unix epoch the block was formatted for.
    #[must_use]
    pub fn unix(&self) -> u64 {
        self.unix.get()
    }
}

impl Default for Date {
    fn default() -> Self {
        Self::now()
    }
}

#[cfg(test)]
mod tests {
    use super::{Date, DATE_BLOCK_LEN};

    #[test]
    fn the_block_is_a_date_field_line() {
        let date = Date::now();
        date.set_unix(784_111_777);
        assert_eq!(DATE_BLOCK_LEN, 37);
        assert_eq!(
            &date.block()[..],
            &b"Date: Sun, 06 Nov 1994 08:49:37 GMT\r\n"[..],
            "the RFC 9110 section 5.6.7 example"
        );
        assert_eq!(date.unix(), 784_111_777);
    }

    #[test]
    fn refresh_tracks_the_clock() {
        let date = Date::now();
        let first = date.unix();
        assert!(first > 1_700_000_000, "{first}");
        assert!(date.block().starts_with(b"Date: "));
        assert!(date.block().ends_with(b" GMT\r\n"));
        date.set_unix(0);
        date.refresh();
        assert!(date.unix() >= first);
    }

    #[test]
    fn a_time_past_the_calendar_clamps() {
        let date = Date::now();
        date.set_unix(u64::MAX);
        assert_eq!(
            &date.block()[..],
            &b"Date: Fri, 31 Dec 9999 23:59:59 GMT\r\n"[..]
        );
    }
}
