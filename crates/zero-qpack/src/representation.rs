//! Field line representations (RFC 9204 Sections 4.5.2 to 4.5.6), parsed as
//! they are on the wire, before any table is consulted.
//!
//! The first octet selects the representation:
//!
//! - `1Txxxxxx`: Indexed Field Line, Index (6+) (Section 4.5.2);
//! - `01NTxxxx`: Literal Field Line with Name Reference, Name Index (4+), value
//!   as an 8-bit prefix string literal (Section 4.5.4);
//! - `001NHxxx`: Literal Field Line with Literal Name, name as a 4-bit prefix
//!   string literal, value as an 8-bit prefix string literal (Section 4.5.6);
//! - `0001xxxx`: Indexed Field Line with Post-Base Index, Index (4+) (Section
//!   4.5.3);
//! - `0000Nxxx`: Literal Field Line with Post-Base Name Reference, NameIdx (3+),
//!   value as an 8-bit prefix string literal (Section 4.5.5).
//!
//! Indexes and string lengths are read up to 2^62-1 (Section 4.1.1), and a
//! string length is compared with the octets left in the field section, so one
//! that runs past the end is truncation whatever its value. The string literal
//! limit of Section 7.4 is not applied here: the decoder applies it once the
//! table reference is resolved, so an invalid reference stays the connection
//! error of Section 3.1 or 2.2.3 whatever the length of the value.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5>

use alloc::vec::Vec;

use crate::error::Fault;
use crate::integer::{self, PrefixBits, MAX_VALUE};
use crate::string::{StringLiteral, StringPrefixBits};

/// A field line representation as it is on the wire, before any table is
/// consulted.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Representation<'a> {
    /// `1Txxxxxx`, Index (6+) (Section 4.5.2).
    Indexed {
        /// T: the index is into the static table, else relative into the
        /// dynamic table.
        static_table: bool,
        /// The index.
        index: u64,
    },
    /// `0001xxxx`, Index (4+) (Section 4.5.3).
    IndexedPostBase {
        /// The post-Base index into the dynamic table.
        index: u64,
    },
    /// `01NTxxxx`, Name Index (4+), value as an 8-bit prefix string (Section
    /// 4.5.4).
    LiteralNameReference {
        /// N: the line must stay a literal on every later hop.
        never_indexed: bool,
        /// T: the name index is into the static table, else relative into the
        /// dynamic table.
        static_table: bool,
        /// The name index.
        index: u64,
        /// The value.
        value: StringLiteral<'a>,
    },
    /// `0000Nxxx`, NameIdx (3+), value as an 8-bit prefix string (Section
    /// 4.5.5).
    LiteralPostBaseNameReference {
        /// N: the line must stay a literal on every later hop.
        never_indexed: bool,
        /// The post-Base name index into the dynamic table.
        index: u64,
        /// The value.
        value: StringLiteral<'a>,
    },
    /// `001NHxxx`, name as a 4-bit prefix string, value as an 8-bit prefix
    /// string (Section 4.5.6).
    LiteralName {
        /// N: the line must stay a literal on every later hop.
        never_indexed: bool,
        /// The name.
        name: StringLiteral<'a>,
        /// The value.
        value: StringLiteral<'a>,
    },
}

/// A complete index of a field section: an incomplete one is truncation.
fn index(input: &[u8], prefix: PrefixBits) -> Result<(u64, usize), Fault> {
    integer::decode(input, prefix, MAX_VALUE)
        .map_err(Fault::Integer)?
        .ok_or(Fault::Truncated)
}

/// A complete string literal of a field section: one that runs past the end
/// is truncation.
fn literal(input: &[u8], prefix: StringPrefixBits) -> Result<(StringLiteral<'_>, usize), Fault> {
    StringLiteral::parse(input, prefix, MAX_VALUE)
        .map_err(Fault::Integer)?
        .ok_or(Fault::Truncated)
}

impl<'a> Representation<'a> {
    /// Parses one representation at the start of `input`.
    ///
    /// No string literal limit is applied: the caller compares the lengths
    /// with its own limit (RFC 9204 Section 7.4) after it has resolved the
    /// table reference.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5>
    ///
    /// # Arguments
    ///
    /// * `input` - the rest of a complete field section.
    ///
    /// # Returns
    ///
    /// The representation and the octets it spans.
    ///
    /// # Errors
    ///
    /// [`Fault::Truncated`] when the representation runs past the end of
    /// `input`, whatever the length it announces; [`Fault::Integer`] for an
    /// integer, a string length included, beyond 62 bits or 9 continuation
    /// octets.
    pub fn parse(input: &'a [u8]) -> Result<(Self, usize), Fault> {
        let first = *input.first().ok_or(Fault::Truncated)?;
        if first & 0x80 != 0 {
            let (index, used) = index(input, PrefixBits::P6)?;
            let static_table = first & 0x40 != 0;
            return Ok((
                Self::Indexed {
                    static_table,
                    index,
                },
                used,
            ));
        }
        if first & 0xc0 == 0x40 {
            let (index, used) = index(input, PrefixBits::P4)?;
            let rest = input.get(used..).unwrap_or(&[]);
            let (value, value_len) = literal(rest, StringPrefixBits::P8)?;
            let representation = Self::LiteralNameReference {
                never_indexed: first & 0x20 != 0,
                static_table: first & 0x10 != 0,
                index,
                value,
            };
            return Ok((representation, used.saturating_add(value_len)));
        }
        if first & 0xe0 == 0x20 {
            let (name, used) = literal(input, StringPrefixBits::P4)?;
            let rest = input.get(used..).unwrap_or(&[]);
            let (value, value_len) = literal(rest, StringPrefixBits::P8)?;
            let representation = Self::LiteralName {
                never_indexed: first & 0x10 != 0,
                name,
                value,
            };
            return Ok((representation, used.saturating_add(value_len)));
        }
        if first & 0xf0 == 0x10 {
            let (index, used) = index(input, PrefixBits::P4)?;
            return Ok((Self::IndexedPostBase { index }, used));
        }
        let (index, used) = index(input, PrefixBits::P3)?;
        let rest = input.get(used..).unwrap_or(&[]);
        let (value, value_len) = literal(rest, StringPrefixBits::P8)?;
        let representation = Self::LiteralPostBaseNameReference {
            never_indexed: first & 0x08 != 0,
            index,
            value,
        };
        Ok((representation, used.saturating_add(value_len)))
    }

    /// Appends the representation to `out`, strings written as they are held
    /// (the H flag and the octets).
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer the representation is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when an index or a string length exceeds
    /// 2^62-1.
    pub fn encode(&self, out: &mut Vec<u8>) -> Option<()> {
        let start = out.len();
        let written = self.write(out);
        if written.is_none() {
            out.truncate(start);
        }
        written
    }

    /// Appends the representation, possibly leaving part of it on failure.
    fn write(&self, out: &mut Vec<u8>) -> Option<()> {
        match *self {
            Self::Indexed {
                static_table,
                index,
            } => {
                let flags = if static_table { 0xc0 } else { 0x80 };
                integer::push(index, PrefixBits::P6, flags, out)
            }
            Self::IndexedPostBase { index } => integer::push(index, PrefixBits::P4, 0x10, out),
            Self::LiteralNameReference {
                never_indexed,
                static_table,
                index,
                value,
            } => {
                let mut flags = 0x40;
                if never_indexed {
                    flags |= 0x20;
                }
                if static_table {
                    flags |= 0x10;
                }
                integer::push(index, PrefixBits::P4, flags, out)?;
                value.encode(StringPrefixBits::P8, 0, out)
            }
            Self::LiteralPostBaseNameReference {
                never_indexed,
                index,
                value,
            } => {
                let flags = if never_indexed { 0x08 } else { 0x00 };
                integer::push(index, PrefixBits::P3, flags, out)?;
                value.encode(StringPrefixBits::P8, 0, out)
            }
            Self::LiteralName {
                never_indexed,
                name,
                value,
            } => {
                let flags = if never_indexed { 0x30 } else { 0x20 };
                name.encode(StringPrefixBits::P4, flags, out)?;
                value.encode(StringPrefixBits::P8, 0, out)
            }
        }
    }

    /// Whether the representation references the dynamic table.
    #[must_use]
    pub const fn is_dynamic(&self) -> bool {
        match self {
            Self::Indexed { static_table, .. }
            | Self::LiteralNameReference { static_table, .. } => !*static_table,
            Self::IndexedPostBase { .. } | Self::LiteralPostBaseNameReference { .. } => true,
            Self::LiteralName { .. } => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::Representation;
    use crate::error::Fault;
    use crate::integer::{IntegerError, MAX_VALUE};
    use crate::string::StringLiteral;
    use crate::unhex;
    use crate::xorshift::XorShift;

    /// A raw string literal holding `data`.
    const fn raw(data: &[u8]) -> StringLiteral<'_> {
        StringLiteral {
            huffman: false,
            data,
        }
    }

    /// RFC 9204 Sections 4.5.2 to 4.5.6: each representation "starts with"
    /// its bit pattern: '1' (Indexed Field Line), '0001' (Post-Base Index),
    /// '01' (Name Reference), '0000' (Post-Base Name Reference) and '001'
    /// (Literal Name).
    #[test]
    fn the_first_octet_selects_each_representation() {
        let cases: [(&str, Representation<'static>); 6] = [
            (
                "c1",
                Representation::Indexed {
                    static_table: true,
                    index: 1,
                },
            ),
            (
                "80",
                Representation::Indexed {
                    static_table: false,
                    index: 0,
                },
            ),
            ("11", Representation::IndexedPostBase { index: 1 }),
            (
                "510b2f696e6465782e68746d6c",
                Representation::LiteralNameReference {
                    never_indexed: false,
                    static_table: true,
                    index: 1,
                    value: raw(b"/index.html"),
                },
            ),
            (
                "0e0101",
                Representation::LiteralPostBaseNameReference {
                    never_indexed: true,
                    index: 6,
                    value: raw(b"\x01"),
                },
            ),
            (
                "336162630178",
                Representation::LiteralName {
                    never_indexed: true,
                    name: raw(b"abc"),
                    value: raw(b"x"),
                },
            ),
        ];
        for (hex, expected) in cases {
            let input = unhex(hex);
            assert_eq!(
                Representation::parse(&input),
                Ok((expected, input.len())),
                "{hex}"
            );
            let mut out = Vec::new();
            assert_eq!(expected.encode(&mut out), Some(()));
            assert_eq!(out, input, "{hex}");
        }
    }

    /// RFC 9204 Section 4.5: "An encoded field section consists of a prefix
    /// and a possibly empty sequence of representations", so a representation
    /// that runs past the end of the section is truncated whatever length it
    /// announces. Section 4.1.2 makes every string length a prefixed integer,
    /// and RFC 7541 Section 5.1: "Integer encodings that exceed implementation
    /// limits ... MUST be treated as decoding errors."
    #[test]
    fn a_representation_that_runs_past_the_section_is_truncated() {
        for hex in [
            "", "ff", "51", "510b2f69", "2361", "23616263", "0f", "0f02ff", "3f",
        ] {
            assert_eq!(
                Representation::parse(&unhex(hex)),
                Err(Fault::Truncated),
                "{hex}"
            );
        }
        assert_eq!(
            Representation::parse(&unhex("51ff80808080808080808000")),
            Err(Fault::Integer(IntegerError::TooLong))
        );
        assert_eq!(
            Representation::parse(&unhex("510378797a")).map(|(_, used)| used),
            Ok(5)
        );
        assert_eq!(
            Representation::parse(&unhex("510278797a")).map(|(_, used)| used),
            Ok(4)
        );
    }

    /// RFC 9204 Section 4.1.1: "QPACK implementations MUST be able to decode
    /// integers up to and including 62 bits long.", so an index above 2^62-1
    /// is never written.
    #[test]
    fn encoders_refuse_an_index_above_2_62_minus_1_and_leave_the_buffer_unchanged() {
        let above = MAX_VALUE.saturating_add(1);
        let lines = [
            Representation::Indexed {
                static_table: true,
                index: above,
            },
            Representation::IndexedPostBase { index: above },
            Representation::LiteralNameReference {
                never_indexed: false,
                static_table: true,
                index: above,
                value: raw(b"v"),
            },
            Representation::LiteralPostBaseNameReference {
                never_indexed: false,
                index: above,
                value: raw(b"v"),
            },
        ];
        for line in lines {
            let mut out = alloc::vec![1, 2];
            assert_eq!(line.encode(&mut out), None, "{line:?}");
            assert_eq!(out, alloc::vec![1, 2]);
        }
    }

    /// RFC 9204 Sections 4.5.2 to 4.5.6: every representation, written with
    /// its pattern, flags, index and string literals, parses back to itself.
    #[test]
    fn random_representations_round_trip() {
        let mut rng = XorShift::new(0x5245_0001);
        for _ in 0..crate::xorshift::iterations(4_000) {
            let name = rng.bytes(0, 20);
            let value = rng.bytes(0, 40);
            let representation = match rng.below(5) {
                0 => Representation::Indexed {
                    static_table: rng.flag(),
                    index: rng.value62(),
                },
                1 => Representation::IndexedPostBase {
                    index: rng.value62(),
                },
                2 => Representation::LiteralNameReference {
                    never_indexed: rng.flag(),
                    static_table: rng.flag(),
                    index: rng.value62(),
                    value: raw(&value),
                },
                3 => Representation::LiteralPostBaseNameReference {
                    never_indexed: rng.flag(),
                    index: rng.value62(),
                    value: raw(&value),
                },
                _ => Representation::LiteralName {
                    never_indexed: rng.flag(),
                    name: raw(&name),
                    value: raw(&value),
                },
            };
            let mut out = Vec::new();
            assert_eq!(representation.encode(&mut out), Some(()));
            assert_eq!(Representation::parse(&out), Ok((representation, out.len())));
        }
    }

    /// RFC 9204 Section 4.5: arbitrary octets read as field line
    /// representations never panic the parser, and whatever parses is
    /// written back to the same representation.
    #[test]
    fn arbitrary_octets_never_panic_the_representation_parser() {
        let mut rng = XorShift::new(0x5245_0002);
        for _ in 0..crate::xorshift::iterations(20_000) {
            let input = rng.bytes(0, 24);
            if let Ok((representation, used)) = Representation::parse(&input) {
                assert!((1..=input.len()).contains(&used));
                let mut out = Vec::new();
                assert_eq!(representation.encode(&mut out), Some(()));
                assert_eq!(Representation::parse(&out), Ok((representation, out.len())));
            }
        }
    }
}
