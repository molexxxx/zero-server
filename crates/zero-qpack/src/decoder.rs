//! The static-only decoder: a maximum dynamic table capacity of zero and zero
//! blocked streams.
//!
//! With capacity zero the Section 4.5.1.1 algorithm has `FullRange = 0`, so the
//! only Required Insert Count a field section can carry is zero; any other is
//! QPACK_DECOMPRESSION_FAILED, which also makes blocking impossible. A Sign bit
//! of 1 is then always a negative Base (Section 4.5.1.2), and every reference to
//! the dynamic table names an entry at or beyond the Required Insert Count, "a
//! connection error of type QPACK_DECOMPRESSION_FAILED" (Section 2.2.3). Static
//! references resolve against the Appendix A table, and an index above 98 is "a
//! connection error of type QPACK_DECOMPRESSION_FAILED" (Section 3.1). "The
//! decoder MUST emit field lines in the order their representations appear in
//! the encoded field section." (Section 2.2), and [`FieldLines`] yields them one
//! at a time, so a whole section is never held decoded.
//!
//! Each representation is parsed completely before the dynamic-table check, so
//! a dynamic table can be added later by changing only the resolver here.
//!
//! The string literal limit of Section 7.4 is applied after the static index
//! and the dynamic reference are checked and before any Huffman decoding. A
//! representation that breaks Section 3.1 or 2.2.3 is then the connection
//! error those sections require whatever the length of its value: Section 7.4
//! makes an over-limit string a stream error, RFC 9114 Section 8 lets "An
//! endpoint MAY choose to treat a stream error as a connection error", and the
//! connection error is the one outcome that meets both rules.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.2.3>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-7.4>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-8>

use alloc::borrow::Cow;

use zero_limits::Http3Limits;

use crate::error::{Error, Fault, Place};
use crate::integer::IntegerError;
use crate::prefix::{base, max_entries, required_insert_count, Prefix};
use crate::representation::Representation;
use crate::string::StringLiteral;
use crate::table;
use crate::ENTRY_OVERHEAD;

/// A decoded field line. Names and values borrow the static table or the input
/// unless they were Huffman coded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldLine<'a> {
    /// The field name.
    pub name: Cow<'a, [u8]>,
    /// The field value.
    pub value: Cow<'a, [u8]>,
    /// The N bit of a literal representation: an intermediary must re-encode it
    /// as a literal with N set (RFC 9204 Sections 4.5.4 and 7.1.3). Always false
    /// for indexed lines.
    pub never_indexed: bool,
}

impl<'a> FieldLine<'a> {
    /// A field line that may be indexed.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name, lowercase as RFC 9114 Section 4.2 requires.
    /// * `value` - the field value.
    #[must_use]
    pub const fn new(name: &'a [u8], value: &'a [u8]) -> Self {
        Self {
            name: Cow::Borrowed(name),
            value: Cow::Borrowed(value),
            never_indexed: false,
        }
    }

    /// A field line that must be sent as a literal with the N bit set on every
    /// hop.
    ///
    /// # Arguments
    ///
    /// * `name` - the field name, lowercase as RFC 9114 Section 4.2 requires.
    /// * `value` - the field value.
    #[must_use]
    pub const fn sensitive(name: &'a [u8], value: &'a [u8]) -> Self {
        Self {
            name: Cow::Borrowed(name),
            value: Cow::Borrowed(value),
            never_indexed: true,
        }
    }

    /// The size of the line: name, value and 32 octets, saturating.
    ///
    /// This is the entry size of RFC 9204 Section 3.2.1 and the per-field size
    /// of RFC 9114 Section 4.2.2, which the HTTP/3 layer sums against
    /// SETTINGS_MAX_FIELD_SECTION_SIZE.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.2.2>
    ///
    /// # Returns
    ///
    /// The size in octets.
    #[must_use]
    pub fn size(&self) -> u64 {
        let name = u64::try_from(self.name.len()).unwrap_or(u64::MAX);
        let value = u64::try_from(self.value.len()).unwrap_or(u64::MAX);
        name.saturating_add(value).saturating_add(ENTRY_OVERHEAD)
    }
}

/// A decoder with no dynamic table: maximum capacity zero, zero blocked
/// streams.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.2.3>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decoder {
    max_string_len: u64,
}

impl Decoder {
    /// Creates a decoder from the HTTP/3 limits.
    ///
    /// The string literal limit is `limits.qpack_integer_cap`. RFC 9204 Section
    /// 7.4 says that limit "SHOULD be large enough to process the largest
    /// individual field the HTTP implementation can be configured to accept",
    /// and a name or value within the field section limit can Huffman-encode to
    /// 3.75 octets per octet (the longest code is 30 bits), so the limit must be
    /// at least four times `limits.max_field_section_size`.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-7.4>
    ///
    /// # Arguments
    ///
    /// * `limits` - the QUIC and HTTP/3 limits.
    ///
    /// # Errors
    ///
    /// `zero_core::Error::Unsupported("qpack dynamic table")` when
    /// `limits.qpack_max_table_capacity` or `limits.qpack_blocked_streams` is
    /// not zero: this build has no dynamic table, and advertising a capacity it
    /// cannot honor would break the peer's encoder.
    /// `zero_core::Error::Limit` when `limits.qpack_integer_cap` is below four
    /// times `limits.max_field_section_size`.
    pub fn new(limits: &Http3Limits) -> zero_core::Result<Self> {
        if limits.qpack_max_table_capacity != 0 || limits.qpack_blocked_streams != 0 {
            return Err(zero_core::Error::Unsupported("qpack dynamic table"));
        }
        let needed = limits.max_field_section_size.saturating_mul(4);
        if limits.qpack_integer_cap < needed {
            return Err(zero_core::Error::Limit(alloc::format!(
                "qpack_integer_cap {} is below four times max_field_section_size ({needed})",
                limits.qpack_integer_cap
            )));
        }
        Ok(Self {
            max_string_len: limits.qpack_integer_cap,
        })
    }

    /// The SETTINGS_QPACK_MAX_TABLE_CAPACITY this decoder advertises.
    ///
    /// # Returns
    ///
    /// Zero.
    #[must_use]
    pub const fn max_table_capacity(&self) -> u64 {
        0
    }

    /// The SETTINGS_QPACK_BLOCKED_STREAMS this decoder advertises.
    ///
    /// # Returns
    ///
    /// Zero.
    #[must_use]
    pub const fn blocked_streams(&self) -> u64 {
        0
    }

    /// The longest string literal this decoder accepts, in octets.
    #[must_use]
    pub const fn max_string_len(&self) -> u64 {
        self.max_string_len
    }

    /// Parses the prefix of an encoded field section and returns its field
    /// lines, decoded one at a time.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5.1>
    ///
    /// # Arguments
    ///
    /// * `section` - one complete encoded field section.
    ///
    /// # Returns
    ///
    /// The field lines, in order.
    ///
    /// # Errors
    ///
    /// An [`Error`] with [`Place::FieldSection`] for a bad prefix: a non-zero
    /// Required Insert Count, a Sign bit of 1, or a truncated or oversized
    /// integer.
    pub fn decode<'a>(&self, section: &'a [u8]) -> Result<FieldLines<'a>, Error> {
        let field_section = |fault| Error::new(Place::FieldSection, fault);
        let (prefix, used) = Prefix::parse(section).map_err(field_section)?;
        let count = required_insert_count(prefix.encoded_insert_count, max_entries(0), 0)
            .map_err(field_section)?;
        base(count, prefix.sign, prefix.delta_base).map_err(field_section)?;
        Ok(FieldLines {
            rest: section.get(used..).unwrap_or(&[]),
            max_string_len: self.max_string_len,
            done: false,
        })
    }
}

/// The field lines of one section, in order.
///
/// Fused: after the first error it yields `None`.
#[derive(Clone, Debug)]
pub struct FieldLines<'a> {
    rest: &'a [u8],
    max_string_len: u64,
    done: bool,
}

impl<'a> FieldLines<'a> {
    /// Checks a string literal against the limit of RFC 9204 Section 7.4.
    fn within_limit(&self, literal: &StringLiteral<'_>) -> Result<(), Fault> {
        if u64::try_from(literal.data.len()).unwrap_or(u64::MAX) > self.max_string_len {
            return Err(Fault::Integer(IntegerError::TooLarge));
        }
        Ok(())
    }

    /// Parses and resolves the next representation.
    fn line(&self) -> Result<(FieldLine<'a>, usize), Fault> {
        let (representation, used) = Representation::parse(self.rest)?;
        let line = match representation {
            Representation::Indexed {
                static_table: true,
                index,
            } => {
                let entry = table::get(index).ok_or(Fault::InvalidStaticIndex)?;
                FieldLine {
                    name: Cow::Borrowed(entry.name),
                    value: Cow::Borrowed(entry.value),
                    never_indexed: false,
                }
            }
            Representation::LiteralNameReference {
                never_indexed,
                static_table: true,
                index,
                value,
            } => {
                let entry = table::get(index).ok_or(Fault::InvalidStaticIndex)?;
                self.within_limit(&value)?;
                FieldLine {
                    name: Cow::Borrowed(entry.name),
                    value: value.decode().map_err(Fault::Huffman)?,
                    never_indexed,
                }
            }
            Representation::LiteralName {
                never_indexed,
                name,
                value,
            } => {
                self.within_limit(&name)?;
                self.within_limit(&value)?;
                FieldLine {
                    name: name.decode().map_err(Fault::Huffman)?,
                    value: value.decode().map_err(Fault::Huffman)?,
                    never_indexed,
                }
            }
            Representation::Indexed { .. }
            | Representation::IndexedPostBase { .. }
            | Representation::LiteralNameReference { .. }
            | Representation::LiteralPostBaseNameReference { .. } => {
                return Err(Fault::DynamicReference)
            }
        };
        Ok((line, used))
    }
}

impl<'a> Iterator for FieldLines<'a> {
    type Item = Result<FieldLine<'a>, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done || self.rest.is_empty() {
            return None;
        }
        match self.line() {
            Ok((line, used)) => {
                self.rest = self.rest.get(used..).unwrap_or(&[]);
                Some(Ok(line))
            }
            Err(fault) => {
                self.done = true;
                Some(Err(Error::new(Place::FieldSection, fault)))
            }
        }
    }
}

impl core::iter::FusedIterator for FieldLines<'_> {}

#[cfg(test)]
mod tests {
    use alloc::borrow::Cow;
    use alloc::vec::Vec;

    use zero_limits::Http3Limits;

    use super::{Decoder, FieldLine};
    use crate::error::{Error, Fault, Place, QPACK_DECOMPRESSION_FAILED};
    use crate::integer::IntegerError;
    use crate::prefix::Prefix;
    use crate::representation::Representation;
    use crate::string::StringLiteral;
    use crate::xorshift::XorShift;
    use crate::{
        unhex, DEFAULT_BLOCKED_STREAMS, DEFAULT_MAX_TABLE_CAPACITY, SETTINGS_QPACK_BLOCKED_STREAMS,
        SETTINGS_QPACK_MAX_TABLE_CAPACITY,
    };

    /// A raw string literal holding `data`.
    const fn raw(data: &[u8]) -> StringLiteral<'_> {
        StringLiteral {
            huffman: false,
            data,
        }
    }

    /// The decoder of the default limits.
    fn decoder() -> Decoder {
        Decoder::new(&Http3Limits::DEFAULT).unwrap_or(Decoder { max_string_len: 0 })
    }

    /// Decodes a whole section, stopping at the first error.
    fn decode(section: &[u8]) -> Result<Vec<FieldLine<'_>>, Error> {
        decoder().decode(section)?.collect()
    }

    /// RFC 9204 Section 5: "SETTINGS_QPACK_MAX_TABLE_CAPACITY (0x01): The
    /// default value is zero." and "SETTINGS_QPACK_BLOCKED_STREAMS (0x07): The
    /// default value is zero."
    #[test]
    fn qpack_settings_default_to_zero_and_the_decoder_uses_zero_for_both() {
        assert_eq!(SETTINGS_QPACK_MAX_TABLE_CAPACITY, 0x01);
        assert_eq!(SETTINGS_QPACK_BLOCKED_STREAMS, 0x07);
        assert_eq!(DEFAULT_MAX_TABLE_CAPACITY, 0);
        assert_eq!(DEFAULT_BLOCKED_STREAMS, 0);
        assert_eq!(
            zero_limits::transport::QPACK_MAX_TABLE_CAPACITY,
            DEFAULT_MAX_TABLE_CAPACITY
        );
        assert_eq!(
            zero_limits::transport::QPACK_BLOCKED_STREAMS,
            DEFAULT_BLOCKED_STREAMS
        );
        let decoder = Decoder::new(&Http3Limits::DEFAULT);
        assert!(matches!(
            decoder,
            Ok(ref decoder) if decoder.max_table_capacity() == 0
                && decoder.blocked_streams() == 0
                && decoder.max_string_len() == zero_limits::transport::QPACK_INTEGER_CAP
        ));
        let capacity = Http3Limits {
            qpack_max_table_capacity: 4_096,
            ..Http3Limits::DEFAULT
        };
        assert!(matches!(
            Decoder::new(&capacity),
            Err(zero_core::Error::Unsupported("qpack dynamic table"))
        ));
        let blocked = Http3Limits {
            qpack_blocked_streams: 1,
            ..Http3Limits::DEFAULT
        };
        assert!(matches!(
            Decoder::new(&blocked),
            Err(zero_core::Error::Unsupported("qpack dynamic table"))
        ));
    }

    /// RFC 9204 Section 7.4: the string literal limits "SHOULD be large enough
    /// to process the largest individual field the HTTP implementation can be
    /// configured to accept".
    #[test]
    fn decoder_new_refuses_a_string_limit_below_four_times_the_field_section_size() {
        let below = Http3Limits {
            max_field_section_size: 1_000,
            qpack_integer_cap: 3_999,
            ..Http3Limits::DEFAULT
        };
        assert!(matches!(
            Decoder::new(&below),
            Err(zero_core::Error::Limit(_))
        ));
        let exact = Http3Limits {
            qpack_integer_cap: 4_000,
            ..below
        };
        assert!(matches!(Decoder::new(&exact), Ok(decoder) if decoder.max_string_len() == 4_000));
        let huge = Http3Limits {
            max_field_section_size: u64::MAX,
            qpack_integer_cap: u64::MAX,
            ..Http3Limits::DEFAULT
        };
        assert!(Decoder::new(&huge).is_ok());
    }

    /// RFC 9204 Section 2.2.3: "If the decoder encounters a reference in a field
    /// line representation to a dynamic table entry that has already been
    /// evicted or that has an absolute index greater than or equal to the
    /// declared Required Insert Count (Section 4.5.1), it MUST treat this as a
    /// connection error of type QPACK_DECOMPRESSION_FAILED."
    #[test]
    fn a_dynamic_reference_at_or_beyond_the_required_insert_count_is_decompression_failed() {
        let value = StringLiteral {
            huffman: false,
            data: b"v",
        };
        let dynamic = [
            Representation::Indexed {
                static_table: false,
                index: 0,
            },
            Representation::Indexed {
                static_table: false,
                index: 1 << 31,
            },
            Representation::IndexedPostBase { index: 0 },
            Representation::LiteralNameReference {
                never_indexed: false,
                static_table: false,
                index: 0,
                value,
            },
            Representation::LiteralPostBaseNameReference {
                never_indexed: true,
                index: 0,
                value,
            },
        ];
        for representation in dynamic {
            assert!(representation.is_dynamic());
            for prefix in [
                Prefix::STATIC,
                Prefix {
                    delta_base: 5,
                    ..Prefix::STATIC
                },
            ] {
                let mut section = Vec::new();
                assert_eq!(prefix.encode(&mut section), Some(()));
                assert_eq!(representation.encode(&mut section), Some(()));
                let error = decode(&section).err();
                assert_eq!(
                    error,
                    Some(Error::new(Place::FieldSection, Fault::DynamicReference)),
                    "{representation:?}"
                );
                assert!(error.is_some_and(|error| error.is_connection_error()
                    && error.code() == QPACK_DECOMPRESSION_FAILED));
            }
        }
        assert_eq!(unhex("000080").get(2), Some(&0x80));
        assert_eq!(
            decode(&unhex("000080")).err().map(|error| error.fault),
            Some(Fault::DynamicReference)
        );
        assert_eq!(
            decode(&unhex("000010")).err().map(|error| error.fault),
            Some(Fault::DynamicReference)
        );
    }

    /// RFC 9204 Section 3.1: "When the decoder encounters an invalid static
    /// table index in a field line representation, it MUST treat this as a
    /// connection error of type QPACK_DECOMPRESSION_FAILED.", Section 2.2.3
    /// says the same of a dynamic reference at or beyond the Required Insert
    /// Count, and Section 7.4 makes "a value larger than it is able to decode"
    /// a stream error: a representation that breaks both rules is the
    /// connection error, and the string limit applies once the reference
    /// resolves.
    #[test]
    fn an_invalid_reference_is_a_connection_error_even_when_its_value_is_over_the_string_limit() {
        let small = Http3Limits {
            max_field_section_size: 4,
            qpack_integer_cap: 16,
            ..Http3Limits::DEFAULT
        };
        let decoder = Decoder::new(&small).unwrap_or(Decoder { max_string_len: 0 });
        assert_eq!(decoder.max_string_len(), 16);
        let long = [b'a'; 17];
        let first_error = |representation: &Representation<'_>| {
            let mut section = Vec::new();
            assert_eq!(Prefix::STATIC.encode(&mut section), Some(()));
            assert_eq!(representation.encode(&mut section), Some(()));
            decoder
                .decode(&section)
                .err()
                .or_else(|| decoder.decode(&section).ok()?.find_map(Result::err))
        };
        let references = [
            (
                Representation::LiteralNameReference {
                    never_indexed: false,
                    static_table: true,
                    index: 99,
                    value: raw(&long),
                },
                Fault::InvalidStaticIndex,
            ),
            (
                Representation::LiteralNameReference {
                    never_indexed: false,
                    static_table: false,
                    index: 0,
                    value: raw(&long),
                },
                Fault::DynamicReference,
            ),
            (
                Representation::LiteralPostBaseNameReference {
                    never_indexed: false,
                    index: 0,
                    value: raw(&long),
                },
                Fault::DynamicReference,
            ),
        ];
        for (representation, fault) in references {
            let error = first_error(&representation);
            assert_eq!(
                error,
                Some(Error::new(Place::FieldSection, fault)),
                "{representation:?}"
            );
            assert!(error
                .is_some_and(|error| error.is_connection_error()
                    && error.code() == QPACK_DECOMPRESSION_FAILED));
        }
        let resolved = [
            Representation::LiteralNameReference {
                never_indexed: false,
                static_table: true,
                index: 1,
                value: raw(&long),
            },
            Representation::LiteralName {
                never_indexed: false,
                name: raw(&long),
                value: raw(b"v"),
            },
            Representation::LiteralName {
                never_indexed: true,
                name: raw(b"n"),
                value: raw(&long),
            },
        ];
        for representation in resolved {
            let error = first_error(&representation);
            assert_eq!(
                error,
                Some(Error::new(
                    Place::FieldSection,
                    Fault::Integer(IntegerError::TooLarge)
                )),
                "{representation:?}"
            );
            assert!(error.is_some_and(|error| !error.is_connection_error()));
        }
        let fits = Representation::LiteralNameReference {
            never_indexed: false,
            static_table: true,
            index: 1,
            value: raw(long.get(..16).unwrap_or_default()),
        };
        assert_eq!(first_error(&fits), None);
    }

    /// RFC 9204 Section 2.2: "The decoder MUST emit field lines in the order
    /// their representations appear in the encoded field section."
    #[test]
    fn the_decoder_emits_field_lines_in_the_order_of_their_representations() {
        let section = unhex("0000d1d7c1510b2f696e6465782e68746d6c2361626301787100");
        let lines = decode(&section);
        let expected: Vec<(&[u8], &[u8], bool)> = alloc::vec![
            (b":method", b"GET", false),
            (b":scheme", b"https", false),
            (b":path", b"/", false),
            (b":path", b"/index.html", false),
            (b"abc", b"x", false),
            (b":path", b"", true),
        ];
        let lines = lines.unwrap_or_default();
        let got: Vec<(&[u8], &[u8], bool)> = lines
            .iter()
            .map(|line| (&*line.name, &*line.value, line.never_indexed))
            .collect();
        assert_eq!(got, expected);
        let mut lines = decoder().decode(&section).into_iter().flatten();
        let first = lines.next();
        assert!(
            matches!(first, Some(Ok(ref line)) if matches!(line.name, Cow::Borrowed(b":method")))
        );
    }

    /// RFC 9204 Appendix B.2 and B.4: the encoded field sections of stream 4
    /// (`0381 10 11`) and stream 8 (`0500 80 c1 81`), and Section 4.5.1.1: "If
    /// the decoder encounters a value of EncodedInsertCount that could not have
    /// been produced by a conformant encoder, it MUST treat this as a connection
    /// error of type QPACK_DECOMPRESSION_FAILED."
    #[test]
    fn the_appendix_b_dynamic_field_sections_are_decompression_failed_at_capacity_zero() {
        let stream_4 = unhex("03811011");
        let stream_8 = unhex("050080c181");
        let expected_4 = [
            Representation::IndexedPostBase { index: 0 },
            Representation::IndexedPostBase { index: 1 },
        ];
        let expected_8 = [
            Representation::Indexed {
                static_table: false,
                index: 0,
            },
            Representation::Indexed {
                static_table: true,
                index: 1,
            },
            Representation::Indexed {
                static_table: false,
                index: 1,
            },
        ];
        for (section, prefix, expected) in [
            (
                stream_4.as_slice(),
                Prefix {
                    encoded_insert_count: 3,
                    sign: true,
                    delta_base: 1,
                },
                expected_4.as_slice(),
            ),
            (
                stream_8.as_slice(),
                Prefix {
                    encoded_insert_count: 5,
                    sign: false,
                    delta_base: 0,
                },
                expected_8.as_slice(),
            ),
        ] {
            assert_eq!(Prefix::parse(section), Ok((prefix, 2)));
            let mut rest = section.get(2..).unwrap_or_default();
            let mut parsed = Vec::new();
            while let Ok((representation, used)) = Representation::parse(rest) {
                parsed.push(representation);
                rest = rest.get(used..).unwrap_or_default();
            }
            assert!(rest.is_empty());
            assert_eq!(parsed.as_slice(), expected);
            let error = decoder().decode(section).err();
            assert_eq!(
                error,
                Some(Error::new(Place::FieldSection, Fault::RequiredInsertCount))
            );
            assert!(error
                .is_some_and(|error| error.code() == QPACK_DECOMPRESSION_FAILED
                    && error.is_connection_error()));
        }
    }

    /// RFC 9204 Section 4.1.2: "When Huffman encoding is enabled, the Huffman
    /// table from Appendix B of [RFC7541] is used without modification", RFC
    /// 7541 Section 5.2: "A padding not corresponding to the most significant
    /// bits of the code for the EOS symbol MUST be treated as a decoding
    /// error.", and RFC 9204 Section 4.5.1.2: "The value of Base MUST NOT be
    /// negative."; each failure is reported at the line that holds it.
    #[test]
    fn huffman_coded_and_truncated_lines_are_reported_in_place() {
        let authority = unhex("0000508cf1e3c2e5f23a6ba0ab90f4ff");
        let lines = decode(&authority).unwrap_or_default();
        assert_eq!(
            lines,
            alloc::vec![FieldLine::new(b":authority", b"www.example.com")]
        );
        assert!(matches!(
            lines.first().map(|line| &line.value),
            Some(Cow::Owned(_))
        ));
        let short = unhex("0000c1510b2f69");
        let mut truncated = decoder().decode(&short).into_iter().flatten();
        assert_eq!(truncated.next(), Some(Ok(FieldLine::new(b":path", b"/"))));
        assert_eq!(
            truncated.next(),
            Some(Err(Error::new(Place::FieldSection, Fault::Truncated)))
        );
        assert_eq!(truncated.next(), None);
        assert_eq!(
            decode(&unhex("000051811e")).err().map(|error| error.fault),
            Some(Fault::Huffman(crate::huffman::HuffmanError::PaddingNotEos))
        );
        assert_eq!(decode(&unhex("0000")), Ok(Vec::new()));
        assert_eq!(
            decode(&unhex("0080")).err().map(|error| error.fault),
            Some(Fault::NegativeBase)
        );
        assert_eq!(
            decode(&unhex("")).err().map(|error| error.fault),
            Some(Fault::Truncated)
        );
        assert_eq!(FieldLine::new(b"ab", b"cde").size(), 37);
    }

    /// RFC 9204 Section 4.5: arbitrary octets read as an encoded field section
    /// never panic the decoder, every decoded line has at least the 32-octet
    /// overhead of Section 3.2.1, and at most one error ends the section.
    #[test]
    fn arbitrary_octets_never_panic_the_decoder() {
        let mut rng = XorShift::new(0x4445_0001);
        let decoder = decoder();
        for _ in 0..crate::xorshift::iterations(20_000) {
            let mut section = rng.bytes(0, 32);
            if rng.flag() {
                if let Some(first) = section.get_mut(0) {
                    *first = 0;
                }
                if let Some(second) = section.get_mut(1) {
                    *second &= 0x7f;
                }
            }
            if let Ok(lines) = decoder.decode(&section) {
                let mut errors = 0usize;
                for line in lines {
                    match line {
                        Ok(line) => assert!(line.size() >= 32),
                        Err(error) => {
                            errors = errors.saturating_add(1);
                            assert_eq!(error.place, Place::FieldSection);
                        }
                    }
                }
                assert!(errors <= 1);
            }
        }
    }
}
