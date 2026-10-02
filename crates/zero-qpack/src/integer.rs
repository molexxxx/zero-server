//! Prefixed integers (RFC 7541 Section 5.1), which RFC 9204 Section 4.1.1 uses
//! unmodified.
//!
//! An integer starts in the low N bits of an octet, N from 1 to 8; a value below
//! 2^N-1 fits there, and a larger one sets every prefix bit and continues in
//! octets of seven bits each, least significant group first, the high bit of each
//! octet flagging another. The top 8-N bits of the first octet belong to the
//! enclosing representation and are ignored here.
//!
//! The decoder reads values up to and including 62 bits, which "QPACK
//! implementations MUST be able to decode" (RFC 9204 Section 4.1.1), within at
//! most nine continuation octets; a longer encoding or a larger value is a
//! decoding error, as "Integer encodings that exceed implementation limits -- in
//! value or octet length -- MUST be treated as decoding errors" (RFC 7541
//! Section 5.1). Non-minimal encodings within that length are accepted, as the
//! RFC 7541 pseudocode accepts them. Nothing here is specific to QPACK, so an
//! HPACK codec can reuse it; no HPACK codec exists yet.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc7541.html#section-5.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.1.1>

use alloc::vec::Vec;

/// The largest value: 2^62-1, the 62-bit bound of RFC 9204 Section 4.1.1.
pub const MAX_VALUE: u64 = (1 << 62) - 1;

/// The longest encoding: the prefix octet and 9 continuation octets.
pub const MAX_LEN: usize = 10;

/// The most continuation octets accepted: a 62-bit value needs at most
/// ceil(62 / 7) = 9.
pub const MAX_CONTINUATION: usize = 9;

/// A prefix size N: the integer starts in the low N bits of its first octet.
///
/// Only the eight sizes RFC 7541 Section 5.1 allows exist ("The prefix size, N,
/// is always between 1 and 8 bits."), so no call can name an invalid one.
///
/// @see <https://www.rfc-editor.org/rfc/rfc7541.html#section-5.1>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrefixBits {
    /// A 1-bit prefix.
    P1,
    /// A 2-bit prefix.
    P2,
    /// A 3-bit prefix.
    P3,
    /// A 4-bit prefix.
    P4,
    /// A 5-bit prefix.
    P5,
    /// A 6-bit prefix.
    P6,
    /// A 7-bit prefix.
    P7,
    /// An 8-bit prefix: the integer starts on an octet boundary.
    P8,
}

impl PrefixBits {
    /// Every prefix size, from 1 to 8 bits.
    pub const ALL: [Self; 8] = [
        Self::P1,
        Self::P2,
        Self::P3,
        Self::P4,
        Self::P5,
        Self::P6,
        Self::P7,
        Self::P8,
    ];

    /// The prefix size of `bits` bits.
    ///
    /// # Arguments
    ///
    /// * `bits` - the prefix size N.
    ///
    /// # Returns
    ///
    /// The size, or `None` outside 1 to 8.
    #[must_use]
    pub const fn new(bits: u8) -> Option<Self> {
        match bits {
            1 => Some(Self::P1),
            2 => Some(Self::P2),
            3 => Some(Self::P3),
            4 => Some(Self::P4),
            5 => Some(Self::P5),
            6 => Some(Self::P6),
            7 => Some(Self::P7),
            8 => Some(Self::P8),
            _ => None,
        }
    }

    /// N, from 1 to 8.
    #[must_use]
    pub const fn bits(self) -> u8 {
        match self {
            Self::P1 => 1,
            Self::P2 => 2,
            Self::P3 => 3,
            Self::P4 => 4,
            Self::P5 => 5,
            Self::P6 => 6,
            Self::P7 => 7,
            Self::P8 => 8,
        }
    }

    /// 2^N - 1, the prefix bits of the first octet (0x01 to 0xff).
    #[must_use]
    pub const fn mask(self) -> u8 {
        match self {
            Self::P1 => 0x01,
            Self::P2 => 0x03,
            Self::P3 => 0x07,
            Self::P4 => 0x0f,
            Self::P5 => 0x1f,
            Self::P6 => 0x3f,
            Self::P7 => 0x7f,
            Self::P8 => 0xff,
        }
    }

    /// 2^N - 1 as a `u64`, the value at which continuation octets start.
    const fn limit(self) -> u64 {
        match self {
            Self::P1 => 0x01,
            Self::P2 => 0x03,
            Self::P3 => 0x07,
            Self::P4 => 0x0f,
            Self::P5 => 0x1f,
            Self::P6 => 0x3f,
            Self::P7 => 0x7f,
            Self::P8 => 0xff,
        }
    }
}

/// Why a prefixed integer was refused (RFC 7541 Section 5.1).
///
/// @see <https://www.rfc-editor.org/rfc/rfc7541.html#section-5.1>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntegerError {
    /// More than [`MAX_CONTINUATION`] continuation octets.
    TooLong,
    /// Above [`MAX_VALUE`] or above the caller's cap.
    TooLarge,
}

impl IntegerError {
    /// The name used in conformance vectors.
    ///
    /// # Returns
    ///
    /// `"tooLong"` or `"tooLarge"`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::TooLong => "tooLong",
            Self::TooLarge => "tooLarge",
        }
    }
}

/// The low seven bits of `value` as an octet.
fn low7(value: u64) -> u8 {
    let [low, ..] = (value & 0x7f).to_le_bytes();
    low
}

/// Decodes an integer with an N-bit prefix at the start of `input`.
///
/// The top 8-N bits of the first octet belong to the caller and are ignored.
///
/// @see <https://www.rfc-editor.org/rfc/rfc7541.html#section-5.1>
///
/// # Arguments
///
/// * `input` - the octets from the start of the integer.
/// * `prefix` - the prefix size N.
/// * `cap` - the largest value accepted: [`MAX_VALUE`] for every QPACK use
///   except a string literal length.
///
/// # Returns
///
/// `Ok(None)` when `input` ends before the last octet (or is empty), otherwise
/// `Ok(Some((value, octets)))`.
///
/// # Errors
///
/// [`IntegerError::TooLong`] as soon as continuation octet
/// [`MAX_CONTINUATION`] still flags another; [`IntegerError::TooLarge`] as soon
/// as the value exceeds [`MAX_VALUE`] or `cap`, since later octets can only add
/// to it. A verdict therefore never waits for more than [`MAX_LEN`] octets.
pub fn decode(
    input: &[u8],
    prefix: PrefixBits,
    cap: u64,
) -> Result<Option<(u64, usize)>, IntegerError> {
    let cap = cap.min(MAX_VALUE);
    let Some((&first, rest)) = input.split_first() else {
        return Ok(None);
    };
    let mut value = u64::from(first & prefix.mask());
    if value > cap {
        return Err(IntegerError::TooLarge);
    }
    if value < prefix.limit() {
        return Ok(Some((value, 1)));
    }
    let mut shift = 0u32;
    for (count, &octet) in rest.iter().enumerate() {
        let group = u64::from(octet & 0x7f)
            .checked_shl(shift)
            .ok_or(IntegerError::TooLarge)?;
        value = value.checked_add(group).ok_or(IntegerError::TooLarge)?;
        if value > cap {
            return Err(IntegerError::TooLarge);
        }
        if octet & 0x80 == 0 {
            return Ok(Some((value, count.saturating_add(2))));
        }
        if count.saturating_add(1) >= MAX_CONTINUATION {
            return Err(IntegerError::TooLong);
        }
        shift = shift.saturating_add(7);
    }
    Ok(None)
}

/// The length [`encode`] writes for `value`.
///
/// # Arguments
///
/// * `value` - the integer.
/// * `prefix` - the prefix size N.
///
/// # Returns
///
/// The length in octets, from 1 to [`MAX_LEN`], or `None` above [`MAX_VALUE`].
#[must_use]
pub const fn encoded_len(value: u64, prefix: PrefixBits) -> Option<usize> {
    if value > MAX_VALUE {
        return None;
    }
    let limit = prefix.limit();
    if value < limit {
        return Some(1);
    }
    let mut rest = value.saturating_sub(limit);
    let mut len = 2usize;
    while rest >= 0x80 {
        rest = match rest.checked_shr(7) {
            Some(rest) => rest,
            None => 0,
        };
        len = len.saturating_add(1);
    }
    Some(len)
}

/// Encodes `value` with an N-bit prefix into `out`.
///
/// `flags` is OR-ed into the top 8-N bits of the first octet; bits of `flags`
/// inside the prefix are ignored.
///
/// @see <https://www.rfc-editor.org/rfc/rfc7541.html#section-5.1>
///
/// # Arguments
///
/// * `value` - the integer, at most [`MAX_VALUE`].
/// * `prefix` - the prefix size N.
/// * `flags` - the bits of the enclosing representation.
/// * `out` - receives the encoding from its start.
///
/// # Returns
///
/// The octets written, or `None` when `value` exceeds [`MAX_VALUE`] or `out` is
/// too short; nothing is written then.
pub fn encode(value: u64, prefix: PrefixBits, flags: u8, out: &mut [u8]) -> Option<usize> {
    let len = encoded_len(value, prefix)?;
    let mut slots = out.get_mut(..len)?.iter_mut();
    let mask = prefix.mask();
    let flags = flags & !mask;
    let first = slots.next()?;
    let limit = prefix.limit();
    if value < limit {
        let [low, ..] = value.to_le_bytes();
        *first = flags | low;
        return Some(1);
    }
    *first = flags | mask;
    let mut rest = value.saturating_sub(limit);
    for slot in slots {
        if rest >= 0x80 {
            *slot = 0x80 | low7(rest);
            rest = rest.checked_shr(7).unwrap_or(0);
        } else {
            *slot = low7(rest);
        }
    }
    Some(len)
}

/// Appends the encoding of `value` with an N-bit prefix to `out`.
///
/// # Arguments
///
/// * `value` - the integer, at most [`MAX_VALUE`].
/// * `prefix` - the prefix size N.
/// * `flags` - the bits of the enclosing representation, OR-ed into the top
///   8-N bits of the first octet.
/// * `out` - the buffer the encoding is appended to.
///
/// # Returns
///
/// `None`, with `out` unchanged, when `value` exceeds [`MAX_VALUE`].
pub fn push(value: u64, prefix: PrefixBits, flags: u8, out: &mut Vec<u8>) -> Option<()> {
    let mut buffer = [0u8; MAX_LEN];
    let len = encode(value, prefix, flags, &mut buffer)?;
    out.extend_from_slice(buffer.get(..len)?);
    Some(())
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        decode, encode, encoded_len, push, IntegerError, PrefixBits, MAX_CONTINUATION, MAX_LEN,
        MAX_VALUE,
    };
    use crate::unhex;
    use crate::xorshift::XorShift;

    /// RFC 7541 Appendix C.1: "The value 10 is to be encoded with a 5-bit
    /// prefix.", "The value I=1337 is to be encoded with a 5-bit prefix." and
    /// "The value 42 is to be encoded starting at an octet boundary."
    #[test]
    fn prefixed_integers_match_the_rfc_7541_appendix_c_1_examples() {
        let cases: [(u64, PrefixBits, &str); 3] = [
            (10, PrefixBits::P5, "0a"),
            (1337, PrefixBits::P5, "1f9a0a"),
            (42, PrefixBits::P8, "2a"),
        ];
        for (value, prefix, hex) in cases {
            let expected = unhex(hex);
            let mut out = Vec::new();
            assert_eq!(push(value, prefix, 0, &mut out), Some(()));
            assert_eq!(out, expected, "{value}");
            assert_eq!(
                decode(&expected, prefix, MAX_VALUE),
                Ok(Some((value, expected.len())))
            );
            assert_eq!(encoded_len(value, prefix), Some(expected.len()));
        }
        assert_eq!(
            decode(&unhex("ea"), PrefixBits::P5, MAX_VALUE),
            Ok(Some((10, 1)))
        );
        assert_eq!(
            decode(&unhex("ff9a0a"), PrefixBits::P5, MAX_VALUE),
            Ok(Some((1337, 3)))
        );
        let mut out = Vec::new();
        assert_eq!(push(10, PrefixBits::P5, 0xe0, &mut out), Some(()));
        assert_eq!(out, unhex("ea"));
    }

    /// RFC 7541 Section 5.1: "Integer encodings that exceed implementation
    /// limits -- in value or octet length -- MUST be treated as decoding
    /// errors."
    #[test]
    fn integer_encodings_that_exceed_the_limits_in_value_or_octet_length_are_decoding_errors() {
        assert_eq!(
            decode(&unhex("1f80808080808080808000"), PrefixBits::P5, MAX_VALUE),
            Err(IntegerError::TooLong)
        );
        assert_eq!(
            decode(&unhex("1f808080808080808000"), PrefixBits::P5, MAX_VALUE),
            Ok(Some((31, 10)))
        );
        let mut max = Vec::new();
        assert_eq!(push(MAX_VALUE, PrefixBits::P5, 0, &mut max), Some(()));
        assert_eq!(
            decode(&max, PrefixBits::P5, MAX_VALUE),
            Ok(Some((MAX_VALUE, max.len())))
        );
        let mut above = max.clone();
        if let Some(last) = above.last_mut() {
            *last = last.saturating_add(1);
        }
        assert_eq!(
            decode(&above, PrefixBits::P5, MAX_VALUE),
            Err(IntegerError::TooLarge)
        );
        let cap = zero_limits::transport::QPACK_INTEGER_CAP;
        let mut length = Vec::new();
        assert_eq!(
            push(cap.saturating_add(1), PrefixBits::P7, 0, &mut length),
            Some(())
        );
        assert_eq!(
            decode(&length, PrefixBits::P7, cap),
            Err(IntegerError::TooLarge)
        );
        let mut at_cap = Vec::new();
        assert_eq!(push(cap, PrefixBits::P7, 0, &mut at_cap), Some(()));
        assert_eq!(
            decode(&at_cap, PrefixBits::P7, cap),
            Ok(Some((cap, at_cap.len())))
        );
        assert_eq!(
            decode(&unhex("0a"), PrefixBits::P8, 9),
            Err(IntegerError::TooLarge)
        );
        assert_eq!(
            decode(&unhex("ffffffff7f"), PrefixBits::P8, 1000),
            Err(IntegerError::TooLarge)
        );
    }

    /// RFC 7541 Section 5.1: "The prefix size, N, is always between 1 and 8
    /// bits."
    #[test]
    fn prefix_sizes_outside_1_to_8_are_unrepresentable() {
        assert_eq!(PrefixBits::new(0), None);
        assert_eq!(PrefixBits::new(9), None);
        assert_eq!(PrefixBits::new(255), None);
        for (bits, prefix) in (1u8..=8).zip(PrefixBits::ALL) {
            assert_eq!(PrefixBits::new(bits), Some(prefix));
            assert_eq!(prefix.bits(), bits);
            assert_eq!(
                u32::from(prefix.mask()),
                1u32.wrapping_shl(u32::from(bits)).wrapping_sub(1)
            );
        }
    }

    /// RFC 7541 Section 5.1: "The most significant bit of each octet is used
    /// as a continuation flag", so an integer whose prefix is full or whose
    /// last octet flags another is incomplete until more octets arrive.
    #[test]
    fn an_incomplete_integer_waits_for_more_octets() {
        assert_eq!(decode(&[], PrefixBits::P8, MAX_VALUE), Ok(None));
        assert_eq!(decode(&unhex("1f"), PrefixBits::P5, MAX_VALUE), Ok(None));
        assert_eq!(decode(&unhex("1f9a"), PrefixBits::P5, MAX_VALUE), Ok(None));
        let mut max = Vec::new();
        assert_eq!(push(MAX_VALUE, PrefixBits::P1, 0, &mut max), Some(()));
        assert_eq!(max.len(), MAX_LEN);
        for end in 0..max.len() {
            let head = max.get(..end).unwrap_or_default();
            assert_eq!(decode(head, PrefixBits::P1, MAX_VALUE), Ok(None), "{end}");
        }
    }

    /// RFC 9204 Section 4.1.1: "QPACK implementations MUST be able to decode
    /// integers up to and including 62 bits long.", so no larger value is
    /// written, and a slice too short for the encoding is left unchanged.
    #[test]
    fn encoders_refuse_a_value_above_2_62_minus_1_and_leave_the_buffer_unchanged() {
        let above = MAX_VALUE.saturating_add(1);
        let mut out = alloc::vec![0xaa];
        assert_eq!(push(above, PrefixBits::P6, 0x80, &mut out), None);
        assert_eq!(out, alloc::vec![0xaa]);
        let mut slice = [0u8; MAX_LEN];
        assert_eq!(encode(above, PrefixBits::P6, 0, &mut slice), None);
        assert_eq!(slice, [0u8; MAX_LEN]);
        assert_eq!(encoded_len(above, PrefixBits::P6), None);
        let mut short = [0u8; 2];
        assert_eq!(encode(1337, PrefixBits::P5, 0, &mut short), None);
        assert_eq!(short, [0u8; 2]);
    }

    /// RFC 7541 Section 5.1: "a prefix that fills the current octet and an
    /// optional list of octets that are used if the integer value does not fit
    /// within the prefix"; every value up to 2^62-1 round trips at every prefix
    /// size with the bits above the prefix kept for the enclosing field.
    #[test]
    fn integers_round_trip_at_every_prefix_size_with_the_flag_bits_kept() {
        let mut rng = XorShift::new(0x5151_0001);
        for _ in 0..crate::xorshift::iterations(4_000) {
            let value = rng.value62();
            let flags = rng.byte();
            for prefix in PrefixBits::ALL {
                let mut out = Vec::new();
                assert_eq!(push(value, prefix, flags, &mut out), Some(()));
                assert_eq!(Some(out.len()), encoded_len(value, prefix));
                assert!(out.len() <= MAX_CONTINUATION.saturating_add(1));
                assert_eq!(
                    decode(&out, prefix, MAX_VALUE),
                    Ok(Some((value, out.len())))
                );
                let first = out.first().copied().unwrap_or_default();
                assert_eq!(first & !prefix.mask(), flags & !prefix.mask());
            }
        }
    }

    /// RFC 7541 Section 5.1: arbitrary octets read as a prefixed integer never
    /// panic the decoder, and every value it accepts is within 2^62-1 and 10
    /// octets.
    #[test]
    fn arbitrary_octets_never_panic_the_integer_decoder() {
        let mut rng = XorShift::new(0x5151_0002);
        for _ in 0..crate::xorshift::iterations(20_000) {
            let input = rng.bytes(0, 14);
            for prefix in PrefixBits::ALL {
                if let Ok(Some((value, used))) = decode(&input, prefix, MAX_VALUE) {
                    assert!(value <= MAX_VALUE);
                    assert!(used <= input.len() && used <= MAX_LEN);
                }
            }
        }
    }
}
