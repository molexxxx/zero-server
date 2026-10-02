//! String literals (RFC 7541 Section 5.2) with the N-bit prefix of RFC 9204
//! Section 4.1.2.
//!
//! RFC 9204 Section 4.1.2:
//!
//! > An "N-bit prefix string literal" begins mid-byte, with the first (8-N)
//! > bits allocated to a previous field. The string uses one bit for the
//! > Huffman flag, followed by the length of the encoded string as a (N-1)-bit
//! > prefix integer. The prefix size, N, can have a value between 2 and 8,
//! > inclusive.
//!
//! The length is "the size of the string after encoding". QPACK uses N = 8 for
//! every value, N = 6 for the name of an Insert with Literal Name and N = 4 for
//! the name of a Literal Field Line with Literal Name.
//!
//! A length is compared with the octets present in the `u64` domain and never
//! cast, so a 62-bit length behaves the same on 32-bit and 64-bit targets, and
//! nothing is allocated before the octets are known to be there.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.1.2>
//! @see <https://www.rfc-editor.org/rfc/rfc7541.html#section-5.2>

use alloc::borrow::Cow;
use alloc::vec::Vec;

use crate::huffman::{self, HuffmanError};
use crate::integer::{self, IntegerError, PrefixBits};

/// A string literal as held on the wire: the H flag and the encoded octets.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.1.2>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StringLiteral<'a> {
    /// Whether `data` is Huffman encoded.
    pub huffman: bool,
    /// The encoded octets, raw or Huffman coded as `huffman` says.
    pub data: &'a [u8],
}

/// A string literal prefix size N from 2 to 8.
///
/// RFC 9204 Section 4.1.2: "The prefix size, N, can have a value between 2 and
/// 8, inclusive."; N = 1, which would leave no bit for the length, is
/// unrepresentable.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.1.2>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StringPrefixBits {
    /// A 2-bit prefix: H and a 1-bit length prefix.
    P2,
    /// A 3-bit prefix: H and a 2-bit length prefix.
    P3,
    /// A 4-bit prefix: H and a 3-bit length prefix.
    P4,
    /// A 5-bit prefix: H and a 4-bit length prefix.
    P5,
    /// A 6-bit prefix: H and a 5-bit length prefix.
    P6,
    /// A 7-bit prefix: H and a 6-bit length prefix.
    P7,
    /// An 8-bit prefix: the RFC 7541 string literal, H and a 7-bit length prefix.
    P8,
}

impl StringPrefixBits {
    /// Every string literal prefix size, from 2 to 8 bits.
    pub const ALL: [Self; 7] = [
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
    /// The size, or `None` outside 2 to 8.
    #[must_use]
    pub const fn new(bits: u8) -> Option<Self> {
        match bits {
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

    /// The H flag: bit N-1 of the first octet (0x02 to 0x80).
    #[must_use]
    pub const fn huffman_flag(self) -> u8 {
        match self {
            Self::P2 => 0x02,
            Self::P3 => 0x04,
            Self::P4 => 0x08,
            Self::P5 => 0x10,
            Self::P6 => 0x20,
            Self::P7 => 0x40,
            Self::P8 => 0x80,
        }
    }

    /// The (N-1)-bit prefix of the length.
    #[must_use]
    pub const fn length_prefix(self) -> PrefixBits {
        match self {
            Self::P2 => PrefixBits::P1,
            Self::P3 => PrefixBits::P2,
            Self::P4 => PrefixBits::P3,
            Self::P5 => PrefixBits::P4,
            Self::P6 => PrefixBits::P5,
            Self::P7 => PrefixBits::P6,
            Self::P8 => PrefixBits::P7,
        }
    }

    /// The N low bits of the first octet: the H flag and the length prefix.
    const fn mask(self) -> u8 {
        self.huffman_flag() | self.length_prefix().mask()
    }

    /// The first-octet bits of the literal: `flags` outside the N-bit prefix and
    /// H when `huffman` is set.
    const fn flags(self, flags: u8, huffman: bool) -> u8 {
        let flags = flags & !self.mask();
        if huffman {
            flags | self.huffman_flag()
        } else {
            flags
        }
    }
}

impl<'a> StringLiteral<'a> {
    /// Parses an N-bit prefix string literal at the start of `input`.
    ///
    /// H is [`StringPrefixBits::huffman_flag`] of the first octet, the length an
    /// (N-1)-bit prefix integer, then that many octets. A length above `cap` is
    /// refused as soon as its integer is complete, before any string octet is
    /// awaited, so a peer on an unframed stream cannot make the receiver wait for
    /// octets it would refuse.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.1.2>
    ///
    /// # Arguments
    ///
    /// * `input` - the octets from the start of the literal; the top 8-N bits of
    ///   the first octet belong to the caller.
    /// * `prefix` - the prefix size N.
    /// * `cap` - the longest length accepted.
    ///
    /// # Returns
    ///
    /// `Ok(None)` when `input` ends inside the literal, otherwise the literal
    /// and the octets it spans.
    ///
    /// # Errors
    ///
    /// The [`IntegerError`] of the length, which is capped at `cap`.
    pub fn parse(
        input: &'a [u8],
        prefix: StringPrefixBits,
        cap: u64,
    ) -> Result<Option<(Self, usize)>, IntegerError> {
        let Some(&first) = input.first() else {
            return Ok(None);
        };
        let huffman = first & prefix.huffman_flag() != 0;
        let Some((len, used)) = integer::decode(input, prefix.length_prefix(), cap)? else {
            return Ok(None);
        };
        let rest = input.get(used..).unwrap_or(&[]);
        if len > u64::try_from(rest.len()).unwrap_or(u64::MAX) {
            return Ok(None);
        }
        let len = usize::try_from(len).map_or(rest.len(), |len| len.min(rest.len()));
        let data = rest.get(..len).unwrap_or(&[]);
        Ok(Some((Self { huffman, data }, used.saturating_add(len))))
    }

    /// The decoded octets.
    ///
    /// # Returns
    ///
    /// The octets, borrowed when raw and Huffman decoded otherwise.
    ///
    /// # Errors
    ///
    /// The [`HuffmanError`] of a Huffman string that breaks RFC 7541 Section 5.2.
    pub fn decode(&self) -> Result<Cow<'a, [u8]>, HuffmanError> {
        if !self.huffman {
            return Ok(Cow::Borrowed(self.data));
        }
        let mut out = Vec::new();
        huffman::decode_to_vec(self.data, &mut out)?;
        Ok(Cow::Owned(out))
    }

    /// Appends the literal as held: the H flag, the length and the octets.
    ///
    /// # Arguments
    ///
    /// * `prefix` - the prefix size N.
    /// * `flags` - the bits of the enclosing representation, placed in the top
    ///   8-N bits of the first octet.
    /// * `out` - the buffer the literal is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when the length exceeds 2^62-1.
    pub fn encode(&self, prefix: StringPrefixBits, flags: u8, out: &mut Vec<u8>) -> Option<()> {
        let len = u64::try_from(self.data.len()).ok()?;
        integer::push(
            len,
            prefix.length_prefix(),
            prefix.flags(flags, self.huffman),
            out,
        )?;
        out.extend_from_slice(self.data);
        Some(())
    }

    /// Appends `text` as an N-bit prefix literal.
    ///
    /// # Arguments
    ///
    /// * `text` - the octets of the string.
    /// * `huffman` - whether to Huffman code them.
    /// * `prefix` - the prefix size N.
    /// * `flags` - the bits of the enclosing representation, placed in the top
    ///   8-N bits of the first octet.
    /// * `out` - the buffer the literal is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when the encoded length exceeds 2^62-1.
    pub fn encode_text(
        text: &[u8],
        huffman: bool,
        prefix: StringPrefixBits,
        flags: u8,
        out: &mut Vec<u8>,
    ) -> Option<()> {
        if !huffman {
            let raw = StringLiteral {
                huffman: false,
                data: text,
            };
            return raw.encode(prefix, flags, out);
        }
        integer::push(
            huffman::encoded_len(text),
            prefix.length_prefix(),
            prefix.flags(flags, true),
            out,
        )?;
        huffman::encode(text, out);
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{StringLiteral, StringPrefixBits};
    use crate::integer::{self, IntegerError, PrefixBits, MAX_VALUE};
    use crate::unhex;
    use crate::xorshift::XorShift;

    /// RFC 9204 Section 4.1.2: "The string uses one bit for the Huffman flag,
    /// followed by the length of the encoded string as a (N-1)-bit prefix
    /// integer. The prefix size, N, can have a value between 2 and 8,
    /// inclusive."
    #[test]
    fn an_n_bit_prefix_string_literal_carries_h_and_an_n_minus_1_bit_length() {
        let value = unhex("0c637573746f6d2d76616c7565");
        assert_eq!(
            StringLiteral::parse(&value, StringPrefixBits::P8, MAX_VALUE),
            Ok(Some((
                StringLiteral {
                    huffman: false,
                    data: b"custom-value"
                },
                13
            )))
        );
        let name = unhex("4a637573746f6d2d6b6579");
        assert_eq!(
            StringLiteral::parse(&name, StringPrefixBits::P6, MAX_VALUE),
            Ok(Some((
                StringLiteral {
                    huffman: false,
                    data: b"custom-key"
                },
                11
            )))
        );
        let huffman = unhex("8cf1e3c2e5f23a6ba0ab90f4ff");
        let parsed = StringLiteral::parse(&huffman, StringPrefixBits::P8, MAX_VALUE);
        let Ok(Some((literal, 13))) = parsed else {
            unreachable!("the C.4.1 literal parses: {parsed:?}");
        };
        assert!(literal.huffman);
        assert_eq!(
            literal.decode().as_deref(),
            Ok(b"www.example.com".as_slice())
        );
        let mut out = Vec::new();
        assert_eq!(
            StringLiteral::encode_text(b"abc", false, StringPrefixBits::P4, 0x20, &mut out),
            Some(())
        );
        assert_eq!(out, unhex("23616263"));
        out.clear();
        assert_eq!(
            StringLiteral::encode_text(b"a", true, StringPrefixBits::P4, 0x20, &mut out),
            Some(())
        );
        assert_eq!(out, unhex("291f"));
        for prefix in StringPrefixBits::ALL {
            for huffman in [false, true] {
                let mut out = Vec::new();
                let text = b"custom-value-with-a-longer-text-to-need-continuation-octets";
                assert_eq!(
                    StringLiteral::encode_text(text, huffman, prefix, 0xff, &mut out),
                    Some(())
                );
                let first = out.first().copied().unwrap_or_default();
                let n_bits = prefix.huffman_flag() | prefix.length_prefix().mask();
                assert_eq!(first & !n_bits, !n_bits);
                assert_eq!(first & prefix.huffman_flag() != 0, huffman);
                let encoded_len = if huffman {
                    crate::huffman::encoded_len(text)
                } else {
                    u64::try_from(text.len()).unwrap_or_default()
                };
                assert_eq!(
                    integer::decode(&out, prefix.length_prefix(), MAX_VALUE)
                        .ok()
                        .flatten()
                        .map(|(len, _)| len),
                    Some(encoded_len)
                );
                let parsed = StringLiteral::parse(&out, prefix, MAX_VALUE);
                let Ok(Some((literal, used))) = parsed else {
                    unreachable!("the literal parses: {parsed:?}");
                };
                assert_eq!(used, out.len());
                assert_eq!(literal.huffman, huffman);
                assert_eq!(literal.decode().as_deref(), Ok(text.as_slice()));
            }
        }
        assert_eq!(StringPrefixBits::new(1), None);
        assert_eq!(StringPrefixBits::new(9), None);
        for (bits, prefix) in (2u8..=8).zip(StringPrefixBits::ALL) {
            assert_eq!(StringPrefixBits::new(bits), Some(prefix));
            assert_eq!(
                prefix.length_prefix().bits().saturating_add(1),
                bits,
                "{prefix:?}"
            );
        }
    }

    /// RFC 9204 Section 4.1.2: the string length is followed by "the
    /// indicated number of bytes of data", so a length above u32::MAX, which
    /// Section 4.1.1 requires the decoder to read, waits for its octets.
    #[test]
    fn a_string_length_above_u32_max_waits_for_its_octets() {
        let len = (1u64 << 32).saturating_add(5);
        let mut input = Vec::new();
        assert_eq!(integer::push(len, PrefixBits::P7, 0, &mut input), Some(()));
        input.extend_from_slice(b"abcde");
        assert_eq!(
            StringLiteral::parse(&input, StringPrefixBits::P8, MAX_VALUE),
            Ok(None)
        );
    }

    /// RFC 9204 Section 7.4: an implementation "has to set a limit to the
    /// length it accepts for string literals", and a stream parser decides a
    /// length above it before the octets arrive.
    #[test]
    fn a_length_above_the_cap_is_refused_before_its_octets_arrive() {
        let mut input = Vec::new();
        assert_eq!(
            integer::push(1 << 30, PrefixBits::P5, 0x40, &mut input),
            Some(())
        );
        assert_eq!(
            StringLiteral::parse(&input, StringPrefixBits::P6, (1 << 30) - 1),
            Err(IntegerError::TooLarge)
        );
        assert_eq!(
            StringLiteral::parse(&input, StringPrefixBits::P6, 1 << 30),
            Ok(None)
        );
        assert_eq!(StringLiteral::parse(&[], StringPrefixBits::P8, 0), Ok(None));
        assert_eq!(
            StringLiteral::parse(&unhex("0361"), StringPrefixBits::P8, MAX_VALUE),
            Ok(None)
        );
    }

    /// RFC 9204 Section 4.1.2: "The prefix size, N, can have a value between
    /// 2 and 8, inclusive."; raw and Huffman literals round trip at each size
    /// with the bits of the previous field kept.
    #[test]
    fn random_literals_round_trip_at_every_prefix_size() {
        let mut rng = XorShift::new(0x5354_0001);
        for _ in 0..crate::xorshift::iterations(2_000) {
            let text = rng.bytes(0, 160);
            let flags = rng.byte();
            let huffman = rng.flag();
            for prefix in StringPrefixBits::ALL {
                let mut out = alloc::vec![0xee];
                assert_eq!(
                    StringLiteral::encode_text(&text, huffman, prefix, flags, &mut out),
                    Some(())
                );
                let body = out.get(1..).unwrap_or_default();
                let parsed = StringLiteral::parse(body, prefix, MAX_VALUE);
                let Ok(Some((literal, used))) = parsed else {
                    unreachable!("the literal parses: {parsed:?}");
                };
                assert_eq!(used, body.len());
                assert_eq!(literal.decode().as_deref(), Ok(text.as_slice()));
                let mut again = Vec::new();
                assert_eq!(literal.encode(prefix, flags, &mut again), Some(()));
                assert_eq!(again.as_slice(), body);
            }
        }
    }

    /// RFC 9204 Section 4.1.2: arbitrary octets read as an N-bit prefix string
    /// literal never panic the parser, and a parsed literal stays inside its
    /// input.
    #[test]
    fn arbitrary_octets_never_panic_the_string_parser() {
        let mut rng = XorShift::new(0x5354_0002);
        for _ in 0..crate::xorshift::iterations(10_000) {
            let input = rng.bytes(0, 24);
            for prefix in StringPrefixBits::ALL {
                if let Ok(Some((literal, used))) = StringLiteral::parse(&input, prefix, MAX_VALUE) {
                    assert!(used <= input.len());
                    assert!(literal.data.len() < used.max(1));
                    let _ = literal.decode();
                }
            }
        }
    }
}
