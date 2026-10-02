//! The encoded field section prefix (RFC 9204 Section 4.5.1): the Required
//! Insert Count as an 8-bit prefix integer, then the Sign bit and the Delta Base
//! as a 7-bit prefix integer.
//!
//! Both integers are read up to 2^62-1 (Section 4.1.1), so each value meets its
//! own rule. [`required_insert_count`] is the reconstruction algorithm of Section
//! 4.5.1.1 with checked arithmetic, and [`base`] the Section 4.5.1.2 rule; the
//! static-only decoder runs both with a maximum table capacity of zero, and a
//! dynamic table can be added without changing either.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5.1>

use alloc::vec::Vec;

use crate::error::Fault;
use crate::integer::{self, IntegerError, PrefixBits, MAX_VALUE};

/// The Sign bit of the second integer.
const SIGN: u8 = 0x80;

/// The two integers that start every encoded field section.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5.1>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prefix {
    /// The Required Insert Count as encoded (Section 4.5.1.1).
    pub encoded_insert_count: u64,
    /// The Sign bit: set when the Base is below the Required Insert Count.
    pub sign: bool,
    /// The Delta Base (Section 4.5.1.2).
    pub delta_base: u64,
}

impl Prefix {
    /// Required Insert Count 0 and Delta Base 0: the prefix of every static-only
    /// section, `00 00`.
    pub const STATIC: Self = Self {
        encoded_insert_count: 0,
        sign: false,
        delta_base: 0,
    };

    /// Parses the prefix at the start of a complete field section.
    ///
    /// # Arguments
    ///
    /// * `input` - the encoded field section.
    ///
    /// # Returns
    ///
    /// The prefix and the octets it spans.
    ///
    /// # Errors
    ///
    /// [`Fault::Truncated`] when `input` holds fewer than two complete
    /// integers; [`Fault::Integer`] only for an integer beyond 62 bits or 9
    /// continuation octets.
    pub fn parse(input: &[u8]) -> Result<(Self, usize), Fault> {
        let (encoded_insert_count, first) = complete(input, PrefixBits::P8)?;
        let rest = input.get(first..).unwrap_or(&[]);
        let sign = rest.first().is_some_and(|octet| octet & SIGN != 0);
        let (delta_base, second) = complete(rest, PrefixBits::P7)?;
        let prefix = Self {
            encoded_insert_count,
            sign,
            delta_base,
        };
        Ok((prefix, first.saturating_add(second)))
    }

    /// Appends the prefix to `out`.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer the prefix is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when a field exceeds 2^62-1.
    pub fn encode(&self, out: &mut Vec<u8>) -> Option<()> {
        let start = out.len();
        integer::push(self.encoded_insert_count, PrefixBits::P8, 0, out)?;
        let sign = if self.sign { SIGN } else { 0 };
        if integer::push(self.delta_base, PrefixBits::P7, sign, out).is_none() {
            out.truncate(start);
            return None;
        }
        Some(())
    }
}

/// A complete integer of a field section: an incomplete one is truncation.
fn complete(input: &[u8], prefix: PrefixBits) -> Result<(u64, usize), Fault> {
    integer::decode(input, prefix, MAX_VALUE)
        .map_err(Fault::Integer)?
        .ok_or(Fault::Truncated)
}

/// MaxEntries = floor(MaxTableCapacity / 32) (RFC 9204 Section 4.5.1.1).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5.1.1>
///
/// # Arguments
///
/// * `max_table_capacity` - the maximum capacity of the dynamic table the
///   decoder specified.
///
/// # Returns
///
/// The most entries the dynamic table can hold.
#[must_use]
pub const fn max_entries(max_table_capacity: u64) -> u64 {
    match max_table_capacity.checked_div(32) {
        Some(entries) => entries,
        None => 0,
    }
}

/// The Section 4.5.1.1 reconstruction of the Required Insert Count.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5.1.1>
///
/// # Arguments
///
/// * `encoded` - the EncodedInsertCount from the prefix.
/// * `max_entries` - [`max_entries`] of the decoder's maximum table capacity.
/// * `total_inserts` - the total number of inserts into the decoder's dynamic
///   table.
///
/// # Returns
///
/// The Required Insert Count.
///
/// # Errors
///
/// [`Fault::RequiredInsertCount`] for each `Error` branch of the algorithm,
/// which marks a value "that could not have been produced by a conformant
/// encoder", and for an arithmetic overflow.
pub fn required_insert_count(
    encoded: u64,
    max_entries: u64,
    total_inserts: u64,
) -> Result<u64, Fault> {
    const ERROR: Fault = Fault::RequiredInsertCount;
    let full_range = max_entries.checked_mul(2).ok_or(ERROR)?;
    if encoded == 0 {
        return Ok(0);
    }
    if encoded > full_range {
        return Err(ERROR);
    }
    let max_value = total_inserts.checked_add(max_entries).ok_or(ERROR)?;
    let max_wrapped = max_value
        .checked_div(full_range)
        .and_then(|wraps| wraps.checked_mul(full_range))
        .ok_or(ERROR)?;
    let mut count = max_wrapped
        .checked_add(encoded)
        .and_then(|count| count.checked_sub(1))
        .ok_or(ERROR)?;
    if count > max_value {
        if count <= full_range {
            return Err(ERROR);
        }
        count = count.checked_sub(full_range).ok_or(ERROR)?;
    }
    if count == 0 {
        return Err(ERROR);
    }
    Ok(count)
}

/// The Section 4.5.1.2 Base.
///
/// "An endpoint MUST treat a field block with a Sign bit of 1 as invalid if the
/// value of Required Insert Count is less than or equal to the value of Delta
/// Base." The section names no error code; QPACK_DECOMPRESSION_FAILED follows
/// from the Section 6 definition, a field section the decoder failed to
/// interpret.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5.1.2>
///
/// # Arguments
///
/// * `required_insert_count` - the reconstructed Required Insert Count.
/// * `sign` - the Sign bit.
/// * `delta_base` - the Delta Base.
///
/// # Returns
///
/// `required_insert_count + delta_base` when the sign is clear, otherwise
/// `required_insert_count - delta_base - 1`.
///
/// # Errors
///
/// [`Fault::NegativeBase`] when `sign` is set and `required_insert_count <=
/// delta_base`; [`Fault::Integer`] when a sum exceeds `u64`, which no pair of
/// 62-bit values reaches.
pub fn base(required_insert_count: u64, sign: bool, delta_base: u64) -> Result<u64, Fault> {
    if !sign {
        return required_insert_count
            .checked_add(delta_base)
            .ok_or(Fault::Integer(IntegerError::TooLarge));
    }
    if required_insert_count <= delta_base {
        return Err(Fault::NegativeBase);
    }
    required_insert_count
        .checked_sub(delta_base)
        .and_then(|base| base.checked_sub(1))
        .ok_or(Fault::NegativeBase)
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use zero_limits::Http3Limits;

    use super::{base, max_entries, required_insert_count, Prefix};
    use crate::decoder::Decoder;
    use crate::error::{Error, Fault, Place, QPACK_DECOMPRESSION_FAILED};
    use crate::integer::{IntegerError, MAX_VALUE};
    use crate::unhex;
    use crate::xorshift::XorShift;

    /// RFC 9204 Section 4.5.1.1: "For example, if the dynamic table is 100
    /// bytes, then the Required Insert Count will be encoded modulo 6. If a
    /// decoder has received 10 inserts, then an encoded value of 4 indicates
    /// that the Required Insert Count is 9 for the field section."
    #[test]
    fn the_required_insert_count_is_reconstructed_as_in_the_section_4_5_1_1_example() {
        assert_eq!(max_entries(100), 3);
        assert_eq!(required_insert_count(4, max_entries(100), 10), Ok(9));
        assert_eq!(max_entries(220), 6);
        let stream_4 = Prefix::parse(&unhex("0381"));
        assert_eq!(
            stream_4,
            Ok((
                Prefix {
                    encoded_insert_count: 3,
                    sign: true,
                    delta_base: 1
                },
                2
            ))
        );
        assert_eq!(required_insert_count(3, max_entries(220), 2), Ok(2));
        assert_eq!(base(2, true, 1), Ok(0));
        let stream_8 = Prefix::parse(&unhex("0500"));
        assert_eq!(
            stream_8,
            Ok((
                Prefix {
                    encoded_insert_count: 5,
                    sign: false,
                    delta_base: 0
                },
                2
            ))
        );
        assert_eq!(required_insert_count(5, max_entries(220), 3), Ok(4));
        assert_eq!(base(4, false, 0), Ok(4));
        assert_eq!(required_insert_count(0, 0, 0), Ok(0));
    }

    /// RFC 9204 Section 4.5.1.1: "If the decoder encounters a value of
    /// EncodedInsertCount that could not have been produced by a conformant
    /// encoder, it MUST treat this as a connection error of type
    /// QPACK_DECOMPRESSION_FAILED."
    #[test]
    fn an_encoded_insert_count_no_conformant_encoder_could_produce_is_decompression_failed() {
        for encoded in [1, 2, 1 << 31, MAX_VALUE] {
            assert_eq!(
                required_insert_count(encoded, max_entries(0), 0),
                Err(Fault::RequiredInsertCount),
                "{encoded}"
            );
        }
        assert_eq!(
            required_insert_count(13, 6, 0),
            Err(Fault::RequiredInsertCount)
        );
        assert_eq!(
            required_insert_count(12, 6, 0),
            Err(Fault::RequiredInsertCount)
        );
        assert_eq!(
            required_insert_count(1, 6, 0),
            Err(Fault::RequiredInsertCount)
        );
        assert_eq!(required_insert_count(1, 6, 12), Ok(12));
        assert_eq!(
            required_insert_count(1, u64::MAX, 0),
            Err(Fault::RequiredInsertCount)
        );
        let wide = Prefix::parse(&unhex("ff81feffff0700"));
        assert_eq!(
            wide,
            Ok((
                Prefix {
                    encoded_insert_count: 1 << 31,
                    sign: false,
                    delta_base: 0
                },
                7
            ))
        );
        let tiny = Prefix::parse(&unhex("0100"));
        assert_eq!(tiny.map(|(prefix, _)| prefix.encoded_insert_count), Ok(1));
        let decoder = Decoder::new(&Http3Limits::DEFAULT).ok();
        assert!(decoder.is_some());
        for hex in ["0100", "ff81feffff0700"] {
            let error = decoder.and_then(|decoder| decoder.decode(&unhex(hex)).err());
            assert_eq!(
                error,
                Some(Error::new(Place::FieldSection, Fault::RequiredInsertCount)),
                "{hex}"
            );
            assert!(error
                .is_some_and(|error| error.code() == QPACK_DECOMPRESSION_FAILED
                    && error.is_connection_error()));
        }
    }

    /// RFC 9204 Section 4.5.1.2: "An endpoint MUST treat a field block with a
    /// Sign bit of 1 as invalid if the value of Required Insert Count is less
    /// than or equal to the value of Delta Base." and "with a Required Insert
    /// Count of 9, a decoder receives a Sign bit of 1 and a Delta Base of 2.
    /// This sets the Base to 6".
    #[test]
    fn a_sign_bit_of_1_with_required_insert_count_at_most_delta_base_is_invalid() {
        assert_eq!(base(9, true, 2), Ok(6));
        assert_eq!(base(9, true, 8), Ok(0));
        assert_eq!(base(9, true, 9), Err(Fault::NegativeBase));
        assert_eq!(base(9, true, 10), Err(Fault::NegativeBase));
        assert_eq!(base(0, true, 0), Err(Fault::NegativeBase));
        assert_eq!(base(0, false, 0), Ok(0));
        assert_eq!(base(0, false, 1 << 31), Ok(1 << 31));
        assert_eq!(
            base(MAX_VALUE, false, MAX_VALUE),
            Ok(MAX_VALUE.saturating_mul(2))
        );
        assert_eq!(
            base(u64::MAX, false, 1),
            Err(Fault::Integer(IntegerError::TooLarge))
        );
        assert_eq!(
            Prefix::parse(&unhex("0080")).map(|(prefix, _)| prefix.sign),
            Ok(true)
        );
    }

    /// RFC 9204 Section 4.5.1: "Each encoded field section is prefixed with
    /// two integers.", so a section that ends before both are complete is
    /// truncated, and RFC 7541 Section 5.1: "Integer encodings that exceed
    /// implementation limits ... MUST be treated as decoding errors."
    #[test]
    fn a_prefix_shorter_than_two_integers_is_truncated() {
        assert_eq!(Prefix::parse(&[]), Err(Fault::Truncated));
        assert_eq!(Prefix::parse(&unhex("00")), Err(Fault::Truncated));
        assert_eq!(Prefix::parse(&unhex("ff")), Err(Fault::Truncated));
        assert_eq!(Prefix::parse(&unhex("007f")), Err(Fault::Truncated));
        assert_eq!(
            Prefix::parse(&unhex("ff80808080808080808000")),
            Err(Fault::Integer(IntegerError::TooLong))
        );
    }

    /// RFC 9204 Section 4.5.1: the Required Insert Count with an 8-bit prefix
    /// and the Sign bit with a 7-bit prefix Delta Base round trip at every
    /// value up to 2^62-1, the bound of Section 4.1.1, and the static prefix is
    /// `0000`: "setting Delta Base to zero is one of the most efficient
    /// encodings" (Section 4.5.1.2).
    #[test]
    fn prefixes_round_trip_and_refuse_a_field_above_2_62_minus_1() {
        let mut out = Vec::new();
        assert_eq!(Prefix::STATIC.encode(&mut out), Some(()));
        assert_eq!(out, unhex("0000"));
        let mut rng = XorShift::new(0x5052_0001);
        for _ in 0..crate::xorshift::iterations(2_000) {
            let prefix = Prefix {
                encoded_insert_count: rng.value62(),
                sign: rng.flag(),
                delta_base: rng.value62(),
            };
            let mut out = Vec::new();
            assert_eq!(prefix.encode(&mut out), Some(()));
            assert_eq!(Prefix::parse(&out), Ok((prefix, out.len())));
        }
        let mut out = alloc::vec![7];
        let above = Prefix {
            encoded_insert_count: 1,
            sign: true,
            delta_base: MAX_VALUE.saturating_add(1),
        };
        assert_eq!(above.encode(&mut out), None);
        assert_eq!(out, alloc::vec![7]);
        let above = Prefix {
            encoded_insert_count: MAX_VALUE.saturating_add(1),
            ..Prefix::STATIC
        };
        assert_eq!(above.encode(&mut out), None);
        assert_eq!(out, alloc::vec![7]);
    }
}
