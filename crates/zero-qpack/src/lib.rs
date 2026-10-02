//! The QPACK codec of zero-server (RFC 9204).
//!
//! A byte-in, structure-out codec with no I/O: the static table, the field
//! section prefix, a static-only encoder and decoder, the encoder and decoder
//! stream instructions, and the RFC 7541 integer, string literal and Huffman
//! coding, kept free of QPACK specifics so an HPACK codec can reuse it; no
//! HPACK codec exists yet.
//!
//! The decoder and the encoder are static-only: the decoder advertises a
//! maximum dynamic table capacity of zero and zero blocked streams, the defaults
//! of RFC 9204 Section 5, and the encoder never inserts into the dynamic table
//! and never writes an encoder instruction, which Section 3.2.3 requires when
//! the maximum table capacity is zero. A field line that references the dynamic
//! table is QPACK_DECOMPRESSION_FAILED, and every encoder instruction a peer
//! sends is QPACK_ENCODER_STREAM_ERROR. The representation, prefix and
//! instruction parsers are table-agnostic, so a dynamic table can be added
//! without changing them.
//!
//! The primary items are:
//!
//! - [`Decoder`], [`FieldLines`] and [`FieldLine`] - the static-only decoder
//!   and the field lines it yields.
//! - [`Encoder`] and [`HuffmanPolicy`] - the static-only encoder.
//! - [`Prefix`] and [`Representation`] - the wire forms of Section 4.5.
//! - [`EncoderInstruction`], [`EncoderHead`], [`DecoderInstruction`],
//!   [`EncoderStreamReceiver`] and [`DecoderStreamReceiver`] - the encoder and
//!   decoder streams of Sections 4.3 and 4.4.
//! - [`integer`], [`string`] and [`huffman`] - the RFC 7541 primitives.
//! - [`Error`], [`Place`] and [`Fault`] - the error model of Section 6.
//!
//! # Examples
//!
//! ```
//! use zero_limits::Http3Limits;
//! use zero_qpack::{Decoder, Encoder, FieldLine, HuffmanPolicy};
//!
//! let lines = [
//!     FieldLine::new(b":method", b"GET"),
//!     FieldLine::new(b":path", b"/index.html"),
//!     FieldLine::new(b"cookie", b"id=42"),
//! ];
//! let mut section = Vec::new();
//! Encoder::new(HuffmanPolicy::Shorter)
//!     .encode(&lines, &mut section)
//!     .ok_or("a name or value is too long")?;
//!
//! let decoder = Decoder::new(&Http3Limits::DEFAULT)?;
//! let decoded = decoder
//!     .decode(&section)?
//!     .collect::<Result<Vec<_>, _>>()?;
//! assert_eq!(decoded.len(), 3);
//! assert_eq!(&*decoded[1].value, b"/index.html");
//! assert!(decoded[2].never_indexed);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

#![cfg_attr(not(feature = "std"), no_std)]
#![deny(clippy::cast_possible_truncation)]

extern crate alloc;

pub mod decoder;
pub mod encoder;
pub mod error;
pub mod huffman;
pub mod instruction;
pub mod integer;
pub mod prefix;
pub mod representation;
pub mod string;
pub mod table;
#[cfg(test)]
mod xorshift;

pub use decoder::{Decoder, FieldLine, FieldLines};
pub use encoder::{Encoder, HuffmanPolicy};
pub use error::{
    Error, Fault, Place, QPACK_DECODER_STREAM_ERROR, QPACK_DECOMPRESSION_FAILED,
    QPACK_ENCODER_STREAM_ERROR,
};
pub use instruction::{
    DecoderInstruction, DecoderStreamReceiver, EncoderHead, EncoderInstruction,
    EncoderStreamReceiver,
};
pub use integer::PrefixBits;
pub use prefix::Prefix;
pub use representation::Representation;
pub use string::{StringLiteral, StringPrefixBits};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// SETTINGS_QPACK_MAX_TABLE_CAPACITY, the setting identifier (RFC 9204 Section
/// 5).
pub const SETTINGS_QPACK_MAX_TABLE_CAPACITY: u64 = 0x01;
/// SETTINGS_QPACK_BLOCKED_STREAMS, the setting identifier (RFC 9204 Section 5).
pub const SETTINGS_QPACK_BLOCKED_STREAMS: u64 = 0x07;
/// The default of SETTINGS_QPACK_MAX_TABLE_CAPACITY: zero (RFC 9204 Section 5).
pub const DEFAULT_MAX_TABLE_CAPACITY: u64 = 0;
/// The default of SETTINGS_QPACK_BLOCKED_STREAMS: zero (RFC 9204 Section 5).
pub const DEFAULT_BLOCKED_STREAMS: u64 = 0;
/// The unidirectional stream type of the encoder stream (RFC 9204 Section 4.2).
pub const ENCODER_STREAM_TYPE: u64 = 0x02;
/// The unidirectional stream type of the decoder stream (RFC 9204 Section 4.2).
pub const DECODER_STREAM_TYPE: u64 = 0x03;
/// The size of an entry beyond its name and value, in octets (RFC 9204 Section
/// 3.2.1).
pub const ENTRY_OVERHEAD: u64 = 32;

/// The octets of a lowercase hexadecimal string, for quoting published vectors
/// in tests.
#[cfg(test)]
fn unhex(text: &str) -> alloc::vec::Vec<u8> {
    let digits: alloc::vec::Vec<u8> = text
        .bytes()
        .filter_map(|digit| char::from(digit).to_digit(16))
        .filter_map(|digit| u8::try_from(digit).ok())
        .collect();
    digits
        .chunks(2)
        .map(|pair| match *pair {
            [high, low] => high.wrapping_shl(4) | low,
            [single] => single,
            _ => 0,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use zero_limits::Http3Limits;

    use crate::error::{Error, Fault, Place};
    use crate::integer::{self, IntegerError, PrefixBits, MAX_VALUE};
    use crate::{
        unhex, Decoder, DecoderInstruction, DecoderStreamReceiver, Encoder, EncoderInstruction,
        EncoderStreamReceiver, FieldLine, HuffmanPolicy, Prefix, Representation, StringLiteral,
        QPACK_DECOMPRESSION_FAILED, QPACK_ENCODER_STREAM_ERROR,
    };

    /// The decoder of the default limits.
    fn decoder() -> Option<Decoder> {
        Decoder::new(&Http3Limits::DEFAULT).ok()
    }

    /// Decodes a whole section with `decoder`, stopping at the first error.
    fn decode_with(decoder: Option<Decoder>, section: &[u8]) -> Result<Vec<FieldLine<'_>>, Error> {
        let decoder = decoder.ok_or(Error::new(Place::FieldSection, Fault::Truncated))?;
        decoder.decode(section)?.collect()
    }

    /// Decodes a whole section with the default decoder.
    fn decode(section: &[u8]) -> Result<Vec<FieldLine<'_>>, Error> {
        decode_with(decoder(), section)
    }

    /// A static-prefix field section holding one representation.
    fn section_with(representation: &Representation<'_>) -> Vec<u8> {
        let mut section = Vec::new();
        assert_eq!(Prefix::STATIC.encode(&mut section), Some(()));
        assert_eq!(representation.encode(&mut section), Some(()));
        section
    }

    /// RFC 9204 Section 4.1.1: "QPACK implementations MUST be able to decode
    /// integers up to and including 62 bits long." The test covers every
    /// prefix size and each of the twelve integers that are not string
    /// lengths: Required Insert Count and Delta Base (Section 4.5.1), the
    /// indexes of Sections 4.5.2 to 4.5.5, Capacity, Name Index and Duplicate
    /// Index on the encoder stream (Section 4.3), and the Stream ID and
    /// Increment of the decoder stream (Section 4.4). Each one reaches its own
    /// rule, never an integer fault.
    #[test]
    fn integers_up_to_and_including_62_bits_long_decode_at_every_prefix_size_and_every_use() {
        for prefix in PrefixBits::ALL {
            let mut out = Vec::new();
            assert_eq!(integer::push(MAX_VALUE, prefix, 0, &mut out), Some(()));
            assert_eq!(
                integer::decode(&out, prefix, MAX_VALUE),
                Ok(Some((MAX_VALUE, out.len()))),
                "{prefix:?}"
            );
        }
        let delta_base = unhex("007f81ffffff07");
        let mut built = Vec::new();
        let prefix = Prefix {
            delta_base: 1 << 31,
            ..Prefix::STATIC
        };
        assert_eq!(prefix.encode(&mut built), Some(()));
        assert_eq!(built, delta_base);
        assert_eq!(decode(&delta_base), Ok(Vec::new()));

        let static_index = unhex("0000ffc1ffffff07");
        let mut built = Vec::new();
        assert_eq!(Prefix::STATIC.encode(&mut built), Some(()));
        let indexed = Representation::Indexed {
            static_table: true,
            index: 1 << 31,
        };
        assert_eq!(indexed.encode(&mut built), Some(()));
        assert_eq!(built, static_index);
        assert_eq!(
            decode(&static_index).err().map(|error| error.fault),
            Some(Fault::InvalidStaticIndex)
        );

        let insert_count = unhex("ff81feffff0700");
        assert_eq!(
            decode(&insert_count).err().map(|error| error.fault),
            Some(Fault::RequiredInsertCount)
        );

        let mut capacity = Vec::new();
        let set = EncoderInstruction::SetDynamicTableCapacity {
            capacity: MAX_VALUE,
        };
        assert_eq!(set.encode(&mut capacity), Some(()));
        assert_eq!(
            EncoderStreamReceiver::new(1 << 30)
                .feed(&capacity)
                .map_err(|error| error.fault),
            Err(Fault::CapacityExceeded)
        );

        let mut cancellation = Vec::new();
        let cancel = DecoderInstruction::StreamCancellation {
            stream_id: MAX_VALUE,
        };
        assert_eq!(cancel.encode(&mut cancellation), Some(()));
        assert_eq!(
            DecoderStreamReceiver.feed(&cancellation),
            Ok(cancellation.len())
        );

        let mut increment = Vec::new();
        let increase = DecoderInstruction::InsertCountIncrement {
            increment: MAX_VALUE,
        };
        assert_eq!(increase.encode(&mut increment), Some(()));
        assert_eq!(
            DecoderStreamReceiver
                .feed(&increment)
                .map_err(|error| error.fault),
            Err(Fault::InvalidIncrement)
        );

        let mut acknowledgment = Vec::new();
        let acknowledge = DecoderInstruction::SectionAcknowledgment {
            stream_id: MAX_VALUE,
        };
        assert_eq!(acknowledge.encode(&mut acknowledgment), Some(()));
        assert_eq!(
            DecoderStreamReceiver
                .feed(&acknowledgment)
                .map_err(|error| error.fault),
            Err(Fault::UnexpectedAcknowledgment)
        );

        let value = StringLiteral {
            huffman: false,
            data: b"v",
        };
        let mut insert = Vec::new();
        let named = EncoderInstruction::InsertWithNameReference {
            static_table: true,
            index: MAX_VALUE,
            value,
        };
        assert_eq!(named.encode(&mut insert), Some(()));
        assert_eq!(
            EncoderStreamReceiver::new(1 << 30)
                .feed(&insert)
                .map_err(|error| error.fault),
            Err(Fault::InvalidStaticIndex)
        );

        let mut duplicate = Vec::new();
        let copy = EncoderInstruction::Duplicate { index: MAX_VALUE };
        assert_eq!(copy.encode(&mut duplicate), Some(()));
        assert_eq!(
            EncoderStreamReceiver::new(1 << 30)
                .feed(&duplicate)
                .map_err(|error| error.fault),
            Err(Fault::InstructionAtCapacityZero)
        );

        let lines = [
            (
                Representation::LiteralNameReference {
                    never_indexed: false,
                    static_table: true,
                    index: MAX_VALUE,
                    value,
                },
                Fault::InvalidStaticIndex,
            ),
            (
                Representation::IndexedPostBase { index: MAX_VALUE },
                Fault::DynamicReference,
            ),
            (
                Representation::LiteralPostBaseNameReference {
                    never_indexed: false,
                    index: MAX_VALUE,
                    value,
                },
                Fault::DynamicReference,
            ),
        ];
        for (representation, fault) in lines {
            assert_eq!(
                decode(&section_with(&representation))
                    .err()
                    .map(|error| error.fault),
                Some(fault),
                "{representation:?}"
            );
        }
    }

    /// RFC 9204 Section 7.4: "If an implementation encounters a value larger
    /// than it is able to decode, this MUST be treated as a stream error of type
    /// QPACK_DECOMPRESSION_FAILED if on a request stream or a connection error
    /// of the appropriate type if on the encoder or decoder stream."
    #[test]
    fn a_value_larger_than_the_decoder_accepts_is_a_stream_error_on_a_request_stream() {
        let mut beyond = unhex("0000ff");
        beyond.extend_from_slice(&unhex("ffffffffffffffff7f"));
        let error = decode(&beyond).err();
        assert_eq!(
            error,
            Some(Error::new(
                Place::FieldSection,
                Fault::Integer(IntegerError::TooLarge)
            ))
        );
        assert!(error.is_some_and(
            |error| !error.is_connection_error() && error.code() == QPACK_DECOMPRESSION_FAILED
        ));
        let too_long = unhex("0000ff80808080808080808000");
        assert!(decode(&too_long)
            .err()
            .is_some_and(|error| error.fault == Fault::Integer(IntegerError::TooLong)
                && !error.is_connection_error()));

        let small = Http3Limits {
            max_field_section_size: 4,
            qpack_integer_cap: 16,
            ..Http3Limits::DEFAULT
        };
        let small = Decoder::new(&small).ok();
        let mut long_value = Vec::new();
        let line = [FieldLine::new(b":path", b"/0123456789abcdef")];
        assert_eq!(
            Encoder::new(HuffmanPolicy::Never).encode(&line, &mut long_value),
            Some(())
        );
        let error = decode_with(small, &long_value).err();
        assert!(error.is_some_and(
            |error| error.fault == Fault::Integer(IntegerError::TooLarge)
                && !error.is_connection_error()
        ));
        let mut fits = Vec::new();
        let line = [FieldLine::new(b":path", b"/0123456789abcde")];
        assert_eq!(
            Encoder::new(HuffmanPolicy::Never).encode(&line, &mut fits),
            Some(())
        );
        assert!(decode_with(small, &fits).is_ok());

        let mut past_end = unhex("000051");
        assert_eq!(
            integer::push(1 << 31, PrefixBits::P7, 0, &mut past_end),
            Some(())
        );
        past_end.push(b'x');
        let error = decode(&past_end).err();
        assert_eq!(
            error,
            Some(Error::new(Place::FieldSection, Fault::Truncated))
        );
        assert!(error.is_some_and(|error| error.is_connection_error()));

        let mut name = Vec::new();
        assert_eq!(
            integer::push(1 << 31, PrefixBits::P5, 0x40, &mut name),
            Some(())
        );
        let error = EncoderStreamReceiver::new(1 << 30).feed(&name).err();
        assert!(error.is_some_and(
            |error| error.fault == Fault::Integer(IntegerError::TooLarge)
                && error.code() == QPACK_ENCODER_STREAM_ERROR
                && error.is_connection_error()
        ));
        let error = DecoderStreamReceiver
            .feed(&unhex("ffffffffffffffffff7f"))
            .err();
        assert!(
            error.is_some_and(|error| error.place == Place::DecoderStream
                && error.fault == Fault::Integer(IntegerError::TooLarge)
                && error.is_connection_error())
        );
    }

    /// RFC 9204 Appendix B.1: "The encoder sends an encoded field section
    /// containing a literal representation of a field with a static name
    /// reference.", the octets `0000 510b 2f69 6e64 6578 2e68 746d 6c`
    /// annotated as a Literal Field Line with Name Reference to static index 1,
    /// `:path=/index.html`.
    #[test]
    fn the_appendix_b_1_field_section_decodes_and_encodes_to_the_published_octets() {
        let published = unhex("0000510b2f696e6465782e68746d6c");
        assert_eq!(
            decode(&published),
            Ok(alloc::vec![FieldLine::new(b":path", b"/index.html")])
        );
        let mut encoded = Vec::new();
        let line = [FieldLine::new(b":path", b"/index.html")];
        assert_eq!(
            Encoder::new(HuffmanPolicy::Never).encode(&line, &mut encoded),
            Some(())
        );
        assert_eq!(encoded, published);
        assert_eq!(encoded.len(), 15);
    }

    /// RFC 9204 Section 3.1: "When the decoder encounters an invalid static
    /// table index in a field line representation, it MUST treat this as a
    /// connection error of type QPACK_DECOMPRESSION_FAILED. If this index is
    /// received on the encoder stream, this MUST be treated as a connection
    /// error of type QPACK_ENCODER_STREAM_ERROR."
    #[test]
    fn an_invalid_static_index_is_decompression_failed_or_an_encoder_stream_error() {
        for hex in ["0000ff24", "0000ffc1ffffff07", "00005f5400"] {
            let error = decode(&unhex(hex)).err();
            assert_eq!(
                error,
                Some(Error::new(Place::FieldSection, Fault::InvalidStaticIndex)),
                "{hex}"
            );
            assert!(error
                .is_some_and(|error| error.code() == QPACK_DECOMPRESSION_FAILED
                    && error.is_connection_error()));
        }
        assert_eq!(decode(&unhex("0000ff23")).map(|lines| lines.len()), Ok(1));
        assert_eq!(decode(&unhex("00005f5300")).map(|lines| lines.len()), Ok(1));
        let error = EncoderStreamReceiver::new(1 << 30)
            .feed(&unhex("ff2400"))
            .err();
        assert_eq!(
            error,
            Some(Error::new(Place::EncoderStream, Fault::InvalidStaticIndex))
        );
        assert!(error.is_some_and(
            |error| error.code() == QPACK_ENCODER_STREAM_ERROR && error.is_connection_error()
        ));
    }

    /// RFC 9204 Section 7.1.3: "An intermediary MUST NOT re-encode a value that
    /// uses a literal representation with the 'N' bit set with another
    /// representation that would index it. If QPACK is used for re-encoding, a
    /// literal representation with the 'N' bit set MUST be used."
    #[test]
    fn re_encoding_a_never_indexed_literal_keeps_a_literal_with_the_n_bit_set() {
        let mut received = Vec::new();
        let sent = [
            FieldLine::sensitive(b":method", b"GET"),
            FieldLine::sensitive(b"x-secret", b"token"),
            FieldLine::new(b":path", b"/"),
        ];
        assert_eq!(
            Encoder::new(HuffmanPolicy::Shorter).encode(&sent, &mut received),
            Some(())
        );
        let lines = decode(&received).unwrap_or_default();
        assert_eq!(lines, sent.to_vec());
        for policy in [
            HuffmanPolicy::Never,
            HuffmanPolicy::Shorter,
            HuffmanPolicy::Always,
        ] {
            let mut forwarded = Vec::new();
            assert_eq!(
                Encoder::new(policy).encode(&lines, &mut forwarded),
                Some(())
            );
            let mut rest = forwarded.get(2..).unwrap_or_default();
            let mut representations = Vec::new();
            while let Ok((representation, used)) = Representation::parse(rest) {
                representations.push(representation);
                rest = rest.get(used..).unwrap_or_default();
            }
            assert!(matches!(
                representations.as_slice(),
                [
                    Representation::LiteralNameReference {
                        never_indexed: true,
                        static_table: true,
                        index: 17,
                        ..
                    },
                    Representation::LiteralName {
                        never_indexed: true,
                        ..
                    },
                    Representation::Indexed {
                        static_table: true,
                        index: 1
                    },
                ]
            ));
            assert_eq!(decode(&forwarded), Ok(sent.to_vec()));
        }
    }

    /// RFC 9204 Section 4.2: "An encoder stream is a unidirectional stream of
    /// type 0x02." and "A decoder stream is a unidirectional stream of type
    /// 0x03."; Section 3.2.1: "The size of an entry is the sum of its name's
    /// length in bytes, its value's length in bytes, and 32 additional bytes."
    #[test]
    fn the_crate_constants_match_rfc_9204() {
        assert_eq!(crate::ENCODER_STREAM_TYPE, 0x02);
        assert_eq!(crate::DECODER_STREAM_TYPE, 0x03);
        assert_eq!(crate::ENTRY_OVERHEAD, 32);
        assert!(!crate::VERSION.is_empty());
        assert_eq!(unhex("0a1F"), alloc::vec![0x0a, 0x1f]);
    }
}
