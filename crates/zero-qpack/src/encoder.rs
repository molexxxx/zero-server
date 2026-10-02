//! The static-only encoder: it never inserts into the dynamic table and never
//! writes an encoder instruction.
//!
//! "When the maximum table capacity is zero, the encoder MUST NOT insert
//! entries into the dynamic table and MUST NOT send any encoder instructions on
//! the encoder stream." (RFC 9204 Section 3.2.3). This encoder has no encoder
//! stream output at all, so that holds by construction. Every section starts
//! with the prefix `00 00`: "For a field section encoded with no references to
//! the dynamic table, the Required Insert Count is zero." (Section 2.1.2), and
//! "setting Delta Base to zero is one of the most efficient encodings" (Section
//! 4.5.1.2). "An encoder MUST emit field representations in the order they
//! appear in the input field section." (Section 2.1).
//!
//! Each line becomes, in order of preference: an indexed line for an exact
//! static match (Section 4.5.2), a literal with a static name reference (Section
//! 4.5.4), or a literal with a literal name (Section 4.5.6). A line marked never
//! indexed, and every line named `authorization`, `cookie` or `set-cookie`, is
//! always a literal with the N bit set: "When the 'N' bit is set, the encoded
//! field line MUST always be encoded with a literal representation." (Section
//! 4.5.4), and the bit is what keeps the value out of a dynamic table on the
//! next hop (Section 7.1.3).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.2.3>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-7.1.3>

use alloc::vec::Vec;

use crate::decoder::FieldLine;
use crate::huffman;
use crate::integer::{self, PrefixBits};
use crate::prefix::Prefix;
use crate::string::{StringLiteral, StringPrefixBits};
use crate::table::{self, Match};

/// When string literals are Huffman coded. RFC 7541 Section 5.2 leaves the
/// choice to the encoder.
///
/// @see <https://www.rfc-editor.org/rfc/rfc7541.html#section-5.2>
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum HuffmanPolicy {
    /// Raw octets always (the Appendix B examples use H = 0).
    Never,
    /// Huffman when strictly shorter.
    #[default]
    Shorter,
    /// Huffman always.
    Always,
}

/// The field names always written as literals with the N bit set:
/// `authorization`, `cookie` and `set-cookie`.
///
/// RFC 9204 Section 7.1.3: "An encoder might also choose not to index values
/// for fields that are considered to be highly valuable or sensitive to
/// recovery, such as the Cookie or Authorization header fields." A static-only
/// encoder indexes nothing at this hop, but the N bit is what protects the value
/// at the next one.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-7.1.3>
pub const SENSITIVE_NAMES: [&[u8]; 3] = [b"authorization", b"cookie", b"set-cookie"];

/// The N bit of a literal with name reference.
const NAME_REFERENCE_NEVER_INDEXED: u8 = 0x20;
/// The T bit of a literal with name reference.
const NAME_REFERENCE_STATIC: u8 = 0x10;
/// The pattern of a literal with name reference.
const NAME_REFERENCE: u8 = 0x40;
/// The pattern and T bit of a static indexed line.
const INDEXED_STATIC: u8 = 0xc0;
/// The pattern of a literal with literal name.
const LITERAL_NAME: u8 = 0x20;
/// The N bit of a literal with literal name.
const LITERAL_NAME_NEVER_INDEXED: u8 = 0x10;

/// An encoder that never inserts into the dynamic table and never writes an
/// encoder instruction.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.2.3>
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Encoder {
    huffman: HuffmanPolicy,
}

impl Encoder {
    /// Creates an encoder.
    ///
    /// # Arguments
    ///
    /// * `huffman` - when string literals are Huffman coded.
    #[must_use]
    pub const fn new(huffman: HuffmanPolicy) -> Self {
        Self { huffman }
    }

    /// The Huffman policy.
    #[must_use]
    pub const fn huffman(&self) -> HuffmanPolicy {
        self.huffman
    }

    /// Appends one encoded field section: [`Prefix::STATIC`], then one
    /// representation per line, in input order.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-2.1>
    ///
    /// # Arguments
    ///
    /// * `lines` - the field lines, names lowercase as RFC 9114 Section 4.2
    ///   requires.
    /// * `out` - the buffer the section is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when a name or value is longer than 2^62-1
    /// octets.
    pub fn encode<'l, 'a: 'l>(
        &self,
        lines: impl IntoIterator<Item = &'l FieldLine<'a>>,
        out: &mut Vec<u8>,
    ) -> Option<()> {
        let start = out.len();
        let written = Prefix::STATIC.encode(out).and_then(|()| {
            lines
                .into_iter()
                .try_for_each(|line| self.encode_line(line, out))
        });
        if written.is_none() {
            out.truncate(start);
        }
        written
    }

    /// Appends the representation of one field line.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.5>
    ///
    /// # Arguments
    ///
    /// * `line` - the field line, its name lowercase as RFC 9114 Section 4.2
    ///   requires.
    /// * `out` - the buffer the representation is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when the name or value is longer than
    /// 2^62-1 octets.
    pub fn encode_line(&self, line: &FieldLine<'_>, out: &mut Vec<u8>) -> Option<()> {
        let start = out.len();
        let written = self.write_line(line, out);
        if written.is_none() {
            out.truncate(start);
        }
        written
    }

    /// Appends the representation, possibly leaving part of it on failure.
    fn write_line(&self, line: &FieldLine<'_>, out: &mut Vec<u8>) -> Option<()> {
        let name: &[u8] = &line.name;
        let value: &[u8] = &line.value;
        let never_indexed = line.never_indexed || SENSITIVE_NAMES.contains(&name);
        match (never_indexed, table::find(name, value)) {
            (true, Some(Match::Full(index) | Match::Name(index))) => {
                let flags = NAME_REFERENCE | NAME_REFERENCE_NEVER_INDEXED | NAME_REFERENCE_STATIC;
                integer::push(u64::from(index), PrefixBits::P4, flags, out)?;
                self.text(value, StringPrefixBits::P8, 0, out)
            }
            (false, Some(Match::Full(index))) => {
                integer::push(u64::from(index), PrefixBits::P6, INDEXED_STATIC, out)
            }
            (false, Some(Match::Name(index))) => {
                let flags = NAME_REFERENCE | NAME_REFERENCE_STATIC;
                integer::push(u64::from(index), PrefixBits::P4, flags, out)?;
                self.text(value, StringPrefixBits::P8, 0, out)
            }
            (never_indexed, None) => {
                let flags = if never_indexed {
                    LITERAL_NAME | LITERAL_NAME_NEVER_INDEXED
                } else {
                    LITERAL_NAME
                };
                self.text(name, StringPrefixBits::P4, flags, out)?;
                self.text(value, StringPrefixBits::P8, 0, out)
            }
        }
    }

    /// Appends `text` as a string literal, Huffman coded as the policy says.
    fn text(
        &self,
        text: &[u8],
        prefix: StringPrefixBits,
        flags: u8,
        out: &mut Vec<u8>,
    ) -> Option<()> {
        let huffman = match self.huffman {
            HuffmanPolicy::Never => false,
            HuffmanPolicy::Always => true,
            HuffmanPolicy::Shorter => {
                huffman::encoded_len(text) < u64::try_from(text.len()).unwrap_or(u64::MAX)
            }
        };
        StringLiteral::encode_text(text, huffman, prefix, flags, out)
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{Encoder, HuffmanPolicy, SENSITIVE_NAMES};
    use crate::decoder::{Decoder, FieldLine};
    use crate::prefix::Prefix;
    use crate::representation::Representation;
    use crate::unhex;
    use crate::xorshift::XorShift;

    const POLICIES: [HuffmanPolicy; 3] = [
        HuffmanPolicy::Never,
        HuffmanPolicy::Shorter,
        HuffmanPolicy::Always,
    ];

    /// Encodes `lines` into a fresh vector.
    fn encode(policy: HuffmanPolicy, lines: &[FieldLine<'_>]) -> Vec<u8> {
        let mut out = Vec::new();
        assert_eq!(Encoder::new(policy).encode(lines, &mut out), Some(()));
        out
    }

    /// The representations of an encoded section after its prefix.
    fn representations(section: &[u8]) -> (Prefix, Vec<Representation<'_>>) {
        let (prefix, used) = Prefix::parse(section).unwrap_or((
            Prefix {
                encoded_insert_count: u64::MAX,
                sign: true,
                delta_base: 0,
            },
            0,
        ));
        let mut rest = section.get(used..).unwrap_or_default();
        let mut parsed = Vec::new();
        while !rest.is_empty() {
            let Ok((representation, used)) = Representation::parse(rest) else {
                break;
            };
            parsed.push(representation);
            rest = rest.get(used..).unwrap_or_default();
        }
        assert!(rest.is_empty());
        (prefix, parsed)
    }

    /// A random field line drawn from the static table, a static name or a
    /// random name, random values and a random N bit.
    fn random_line(rng: &mut XorShift) -> (Vec<u8>, Vec<u8>, bool) {
        let entry = crate::table::get(rng.below(99));
        let (name, value) = match (rng.below(3), entry) {
            (0, Some(entry)) => (entry.name.to_vec(), entry.value.to_vec()),
            (1, Some(entry)) => (entry.name.to_vec(), rng.bytes(0, 30)),
            _ => (rng.bytes(1, 20), rng.bytes(0, 30)),
        };
        (name, value, rng.below(4) == 0)
    }

    /// RFC 9204 Section 3.2.3: "When the maximum table capacity is zero, the
    /// encoder MUST NOT insert entries into the dynamic table and MUST NOT send
    /// any encoder instructions on the encoder stream." and Section 2.1.2: "For
    /// a field section encoded with no references to the dynamic table, the
    /// Required Insert Count is zero."
    #[test]
    fn with_capacity_zero_every_encoded_section_has_required_insert_count_zero_and_no_dynamic_reference(
    ) {
        let mut rng = XorShift::new(0x454e_0001);
        for _ in 0..crate::xorshift::iterations(1_500) {
            let count = rng.len(0, 8);
            let owned: Vec<(Vec<u8>, Vec<u8>, bool)> =
                (0..count).map(|_| random_line(&mut rng)).collect();
            let lines: Vec<FieldLine<'_>> = owned
                .iter()
                .map(|(name, value, never)| FieldLine {
                    never_indexed: *never,
                    ..FieldLine::new(name, value)
                })
                .collect();
            for policy in POLICIES {
                let section = encode(policy, &lines);
                assert_eq!(section.get(..2), Some(unhex("0000").as_slice()));
                let (prefix, parsed) = representations(&section);
                assert_eq!(prefix, Prefix::STATIC);
                assert_eq!(parsed.len(), lines.len());
                assert!(parsed
                    .iter()
                    .all(|representation| !representation.is_dynamic()));
                let decoder = Decoder::new(&zero_limits::Http3Limits::DEFAULT);
                let decoded: Option<Vec<FieldLine<'_>>> = decoder
                    .ok()
                    .and_then(|decoder| decoder.decode(&section).ok())
                    .and_then(|lines| lines.collect::<Result<Vec<_>, _>>().ok());
                let decoded = decoded.unwrap_or_default();
                assert_eq!(decoded.len(), lines.len());
                for (line, back) in lines.iter().zip(&decoded) {
                    assert_eq!(back.name, line.name);
                    assert_eq!(back.value, line.value);
                    let sensitive = SENSITIVE_NAMES.contains(&&*line.name);
                    assert_eq!(back.never_indexed, line.never_indexed || sensitive);
                }
            }
        }
    }

    /// RFC 9204 Section 2.1: "An encoder MUST emit field representations in the
    /// order they appear in the input field section."
    #[test]
    fn the_encoder_emits_representations_in_the_order_of_the_input_field_lines() {
        let lines = [
            FieldLine::new(b":path", b"/"),
            FieldLine::new(b":method", b"GET"),
            FieldLine::new(b"x-custom", b"1"),
            FieldLine::new(b":scheme", b"https"),
            FieldLine::new(b":path", b"/index.html"),
        ];
        let section = encode(HuffmanPolicy::Never, &lines);
        assert_eq!(
            section,
            unhex("0000c1d12701782d637573746f6d0131d7510b2f696e6465782e68746d6c")
        );
        let mut reversed = lines.clone();
        reversed.reverse();
        let (_, forward) = representations(&section);
        let backward_section = encode(HuffmanPolicy::Never, &reversed);
        let (_, mut backward) = representations(&backward_section);
        backward.reverse();
        assert_eq!(forward, backward);
        assert_eq!(
            encode(HuffmanPolicy::Shorter, lines.get(..2).unwrap_or_default()),
            unhex("0000c1d1")
        );
    }

    /// RFC 9204 Section 4.5.4: "When the 'N' bit is set, the encoded field line
    /// MUST always be encoded with a literal representation."
    #[test]
    fn a_field_line_with_the_n_bit_is_always_encoded_with_a_literal_representation() {
        for policy in POLICIES {
            let exact = [FieldLine::sensitive(b":method", b"GET")];
            let section = encode(policy, &exact);
            let (_, parsed) = representations(&section);
            assert!(matches!(
                parsed.as_slice(),
                [Representation::LiteralNameReference {
                    never_indexed: true,
                    static_table: true,
                    index: 17,
                    ..
                }]
            ));
            let named = [FieldLine::sensitive(b":path", b"/secret")];
            let section = encode(policy, &named);
            let (_, parsed) = representations(&section);
            assert!(matches!(
                parsed.as_slice(),
                [Representation::LiteralNameReference {
                    never_indexed: true,
                    static_table: true,
                    index: 1,
                    ..
                }]
            ));
            let literal = [FieldLine::sensitive(b"x-token", b"abc")];
            let section = encode(policy, &literal);
            let (_, parsed) = representations(&section);
            assert!(matches!(
                parsed.as_slice(),
                [Representation::LiteralName {
                    never_indexed: true,
                    ..
                }]
            ));
        }
        assert_eq!(
            encode(
                HuffmanPolicy::Never,
                &[FieldLine::sensitive(b":method", b"GET")]
            ),
            unhex("00007f0203474554")
        );
    }

    /// RFC 9204 Section 7.1.3: "An encoder might also choose not to index values
    /// for fields that are considered to be highly valuable or sensitive to
    /// recovery, such as the Cookie or Authorization header fields."
    #[test]
    fn authorization_cookie_and_set_cookie_are_emitted_as_literals_with_the_n_bit_set() {
        for policy in POLICIES {
            for (name, index) in [
                (&b"authorization"[..], 84u64),
                (&b"cookie"[..], 5),
                (&b"set-cookie"[..], 14),
            ] {
                assert!(SENSITIVE_NAMES.contains(&name));
                for value in [&b""[..], &b"a=b; secret"[..]] {
                    let line = [FieldLine::new(name, value)];
                    let section = encode(policy, &line);
                    let (prefix, parsed) = representations(&section);
                    assert_eq!(prefix, Prefix::STATIC);
                    let [Representation::LiteralNameReference {
                        never_indexed,
                        static_table,
                        index: found,
                        value: literal,
                    }] = parsed.as_slice()
                    else {
                        unreachable!("{name:?} is a literal with a name reference: {parsed:?}");
                    };
                    assert!(*never_indexed && *static_table, "{name:?}");
                    assert_eq!(*found, index);
                    assert_eq!(literal.decode().as_deref(), Ok(value));
                }
            }
        }
        let mut out = Vec::new();
        assert_eq!(
            Encoder::new(HuffmanPolicy::Never).encode(&[FieldLine::new(b"cookie", b"")], &mut out),
            Some(())
        );
        assert_eq!(out, unhex("00007500"));
    }

    /// RFC 9204 Section 4.1.2: string literals "begin with a single bit flag,
    /// denoted as 'H' in this document (indicating whether the string is
    /// Huffman encoded)", and the policy sets it per literal: never, when
    /// strictly shorter, or always.
    #[test]
    fn the_huffman_policy_decides_each_string_literal() {
        let line = [FieldLine::new(b":path", b"/index.html")];
        assert_eq!(
            encode(HuffmanPolicy::Never, &line),
            unhex("0000510b2f696e6465782e68746d6c")
        );
        let shorter = encode(HuffmanPolicy::Shorter, &line);
        assert_eq!(shorter.get(..3), Some(unhex("000051").as_slice()));
        assert_eq!(shorter.get(3).map(|octet| octet & 0x80), Some(0x80));
        assert_eq!(shorter.len(), 12);
        let digits = [FieldLine::new(b"x", b"~~")];
        assert_eq!(
            encode(HuffmanPolicy::Shorter, &digits),
            unhex("00002178027e7e")
        );
        let always = encode(HuffmanPolicy::Always, &digits);
        assert_eq!(always.get(2), Some(&0x29));
        assert_eq!(Encoder::default().huffman(), HuffmanPolicy::Shorter);
    }
}
