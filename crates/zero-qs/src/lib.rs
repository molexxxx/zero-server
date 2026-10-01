//! The query string parser of zero-server: `application/x-www-form-urlencoded`
//! as the URL Standard defines it, for query components and form bodies.
//!
//! The parser splits the input on `&`, skips empty sequences, splits each
//! sequence at its first `=` (a sequence without one is a name with an empty
//! value), turns `+` into a space in names and values, percent-decodes with a `%`
//! that is not followed by two hexadecimal digits kept as it is, and decodes the
//! bytes as UTF-8 without a byte order mark, replacing invalid sequences with
//! U+FFFD. Pairs come out as the caller iterates, so the input bounds the work and
//! nothing is kept beyond the pair in hand.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::borrow::Cow;
use alloc::string::String;
use alloc::vec::Vec;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The pairs of a query string, in order.
#[derive(Clone, Debug)]
pub struct Pairs<'a> {
    rest: Option<&'a [u8]>,
}

impl<'a> Pairs<'a> {
    /// The next name and value, decoded.
    ///
    /// # Returns
    ///
    /// The pair, or `None` at the end of the input.
    pub fn next_pair(&mut self) -> Option<(String, String)> {
        let (name, value) = self.next_raw()?;
        Some((decode(name), decode(value)))
    }

    /// The next name and value as the bytes between the delimiters, with `+` and
    /// percent-encoding untouched.
    pub fn next_raw(&mut self) -> Option<(&'a [u8], &'a [u8])> {
        loop {
            let rest = self.rest?;
            let (sequence, after) = match rest.iter().position(|&byte| byte == b'&') {
                Some(at) => (
                    rest.get(..at).unwrap_or(&[]),
                    rest.get(at.saturating_add(1)..),
                ),
                None => (rest, None),
            };
            self.rest = after;
            if sequence.is_empty() {
                continue;
            }
            return Some(match sequence.iter().position(|&byte| byte == b'=') {
                Some(at) => (
                    sequence.get(..at).unwrap_or(&[]),
                    sequence.get(at.saturating_add(1)..).unwrap_or(&[]),
                ),
                None => (sequence, &[][..]),
            });
        }
    }
}

impl Iterator for Pairs<'_> {
    type Item = (String, String);

    fn next(&mut self) -> Option<Self::Item> {
        self.next_pair()
    }
}

/// Parse a query string or form body.
///
/// # Arguments
///
/// * `input` - the bytes, without the leading `?` of a query component.
///
/// # Returns
///
/// The pairs, decoded as the caller iterates.
#[must_use]
pub fn parse(input: &[u8]) -> Pairs<'_> {
    Pairs { rest: Some(input) }
}

/// Parse a query string into a list of pairs.
///
/// # Arguments
///
/// * `input` - the bytes.
/// * `max_pairs` - the most pairs to keep; the rest of the input is left unread.
#[must_use]
pub fn parse_all(input: &[u8], max_pairs: usize) -> Vec<(String, String)> {
    parse(input).take(max_pairs).collect()
}

/// The first value for `name`, decoded.
///
/// # Arguments
///
/// * `input` - the query string.
/// * `name` - the name to look for, compared after decoding.
#[must_use]
pub fn get(input: &[u8], name: &str) -> Option<String> {
    parse(input)
        .find(|(found, _)| found == name)
        .map(|(_, value)| value)
}

/// Decode one name or value: `+` to a space, percent-decoding with a bare `%`
/// kept, then UTF-8 without a byte order mark and with U+FFFD for invalid
/// sequences.
///
/// # Arguments
///
/// * `input` - the bytes between the delimiters.
#[must_use]
pub fn decode(input: &[u8]) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut at = 0usize;
    while let Some(&byte) = input.get(at) {
        match byte {
            b'+' => {
                bytes.push(b' ');
                at = at.saturating_add(1);
            }
            b'%' => {
                let pair = (
                    input.get(at.saturating_add(1)).copied().and_then(hex_value),
                    input.get(at.saturating_add(2)).copied().and_then(hex_value),
                );
                if let (Some(high), Some(low)) = pair {
                    bytes.push(high.wrapping_shl(4) | low);
                    at = at.saturating_add(3);
                } else {
                    bytes.push(b'%');
                    at = at.saturating_add(1);
                }
            }
            _ => {
                bytes.push(byte);
                at = at.saturating_add(1);
            }
        }
    }
    match String::from_utf8_lossy(&bytes) {
        Cow::Borrowed(_) => String::from_utf8(bytes).unwrap_or_default(),
        Cow::Owned(replaced) => replaced,
    }
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte.wrapping_sub(b'0')),
        b'A'..=b'F' => Some(byte.wrapping_sub(b'A').wrapping_add(10)),
        b'a'..=b'f' => Some(byte.wrapping_sub(b'a').wrapping_add(10)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::{String, ToString};
    use alloc::vec::Vec;

    use super::{decode, get, parse, parse_all};

    fn pairs(input: &[u8]) -> Vec<(String, String)> {
        parse(input).collect()
    }

    /// Standards row `body-08`: the URL Standard's parser steps.
    #[test]
    fn url_encoded_bodies_are_split_on_empty_sequences_are_skipped_each_sequence_is_split_on_the_first_equals(
    ) {
        assert_eq!(
            pairs(b"a=1&&b=2=3&c&=d&"),
            [
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "2=3".to_string()),
                ("c".to_string(), String::new()),
                (String::new(), "d".to_string()),
            ]
        );
        assert!(pairs(b"").is_empty());
        assert!(pairs(b"&&").is_empty());
    }

    /// Standards row `body-09`.
    #[test]
    fn becomes_a_space_in_both_names_and_values_before_percent_decoding() {
        assert_eq!(
            pairs(b"first+name=Ada+Lovelace&p=%2B"),
            [
                ("first name".to_string(), "Ada Lovelace".to_string()),
                ("p".to_string(), "+".to_string()),
            ]
        );
    }

    /// Standards row `body-10`.
    #[test]
    fn a_not_followed_by_two_hex_digits_is_kept_literally_instead_of() {
        assert_eq!(decode(b"100%"), "100%");
        assert_eq!(decode(b"%zz%2"), "%zz%2");
        assert_eq!(decode(b"%41%4a"), "AJ");
        assert_eq!(get(b"q=%", "q"), Some("%".to_string()));
    }

    /// Standards row `body-11`.
    #[test]
    fn decoded_bytes_are_interpreted_as_utf_8_without_bom_with_invalid_sequences_replaced_by_u_fffd(
    ) {
        assert_eq!(decode(b"%E2%82%AC"), "\u{20ac}");
        assert_eq!(decode(b"%FF%FE"), "\u{fffd}\u{fffd}");
        assert_eq!(
            decode(b"%EF%BB%BFx"),
            "\u{feff}x",
            "a byte order mark is a character here, not a signature"
        );
        assert_eq!(get(b"a=1&b=%C3%A9", "b"), Some("\u{e9}".to_string()));
        assert_eq!(parse_all(b"a=1&b=2&c=3", 2).len(), 2);
    }
}
