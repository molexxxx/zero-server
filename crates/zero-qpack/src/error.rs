//! The QPACK error model: where a failure happened picks its HTTP/3 error code
//! (RFC 9204 Section 6), and the fault names the rule that was broken.
//!
//! - QPACK_DECOMPRESSION_FAILED (0x0200): "The decoder failed to interpret an
//!   encoded field section and is not able to continue decoding that field
//!   section."
//! - QPACK_ENCODER_STREAM_ERROR (0x0201): "The decoder failed to interpret an
//!   encoder instruction received on the encoder stream."
//! - QPACK_DECODER_STREAM_ERROR (0x0202): "The encoder failed to interpret a
//!   decoder instruction received on the decoder stream."
//!
//! Every failure closes the connection except one: a value larger than this
//! decoder accepts in a field section, which RFC 9204 Section 7.4 makes "a
//! stream error of type QPACK_DECOMPRESSION_FAILED if on a request stream".
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-6>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-7.4>

use core::fmt;

use crate::huffman::HuffmanError;
use crate::integer::IntegerError;

/// QPACK_DECOMPRESSION_FAILED (RFC 9204 Section 6).
pub const QPACK_DECOMPRESSION_FAILED: u64 = 0x0200;
/// QPACK_ENCODER_STREAM_ERROR (RFC 9204 Section 6).
pub const QPACK_ENCODER_STREAM_ERROR: u64 = 0x0201;
/// QPACK_DECODER_STREAM_ERROR (RFC 9204 Section 6).
pub const QPACK_DECODER_STREAM_ERROR: u64 = 0x0202;

/// Where a QPACK failure happened, which picks its error code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    /// An encoded field section on a request or push stream.
    FieldSection,
    /// An encoder instruction received on the encoder stream.
    EncoderStream,
    /// A decoder instruction received on the decoder stream.
    DecoderStream,
}

/// What went wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Fault {
    /// The input ended inside a representation or the prefix (field sections
    /// only; instruction parsers report incomplete input as `Ok(None)` instead).
    Truncated,
    /// A prefixed integer exceeded a limit (RFC 7541 Section 5.1).
    Integer(IntegerError),
    /// A Huffman string violated RFC 7541 Section 5.2, or the output buffer of
    /// the slice API was too short ([`HuffmanError::OutputFull`], which the
    /// decoder never reports).
    Huffman(HuffmanError),
    /// An EncodedInsertCount no conformant encoder produces (RFC 9204 Section
    /// 4.5.1.1).
    RequiredInsertCount,
    /// Sign 1 with Required Insert Count <= Delta Base (RFC 9204 Section
    /// 4.5.1.2).
    NegativeBase,
    /// A field line references the dynamic table at or beyond the Required
    /// Insert Count (RFC 9204 Section 2.2.3).
    DynamicReference,
    /// A static index above 98 (RFC 9204 Section 3.1).
    InvalidStaticIndex,
    /// A Set Dynamic Table Capacity above the advertised maximum (RFC 9204
    /// Section 4.3.1).
    CapacityExceeded,
    /// An insert larger than the dynamic table capacity (RFC 9204 Section
    /// 3.2.2).
    EntryTooLarge,
    /// An encoder instruction received while the advertised maximum table
    /// capacity is zero, where no more specific rule applies: Set Dynamic Table
    /// Capacity 0 and Duplicate (RFC 9204 Section 3.2.3).
    InstructionAtCapacityZero,
    /// A Section Acknowledgment with nothing to acknowledge (RFC 9204 Section
    /// 4.4.1).
    UnexpectedAcknowledgment,
    /// An Insert Count Increment of zero or beyond the inserts sent (RFC 9204
    /// Section 4.4.3).
    InvalidIncrement,
}

impl Fault {
    /// The camelCase name used in conformance vectors: the inner error's name
    /// for [`Fault::Integer`] and [`Fault::Huffman`], the variant name otherwise.
    ///
    /// # Returns
    ///
    /// The name; the names are distinct across [`Fault`], [`IntegerError`] and
    /// [`HuffmanError`].
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Truncated => "truncated",
            Self::Integer(error) => error.name(),
            Self::Huffman(error) => error.name(),
            Self::RequiredInsertCount => "requiredInsertCount",
            Self::NegativeBase => "negativeBase",
            Self::DynamicReference => "dynamicReference",
            Self::InvalidStaticIndex => "invalidStaticIndex",
            Self::CapacityExceeded => "capacityExceeded",
            Self::EntryTooLarge => "entryTooLarge",
            Self::InstructionAtCapacityZero => "instructionAtCapacityZero",
            Self::UnexpectedAcknowledgment => "unexpectedAcknowledgment",
            Self::InvalidIncrement => "invalidIncrement",
        }
    }

    /// A description of the fault and the section that states the rule, or
    /// the local condition for the one fault no specification names.
    const fn describe(&self) -> (&'static str, &'static str) {
        match self {
            Self::Truncated => (
                "the input ended inside a representation",
                "RFC 9204 Section 4.5",
            ),
            Self::Integer(IntegerError::TooLong) => (
                "an integer has too many continuation octets",
                "RFC 7541 Section 5.1",
            ),
            Self::Integer(IntegerError::TooLarge) => (
                "a value is larger than the decoder accepts",
                "RFC 9204 Section 7.4",
            ),
            Self::Huffman(HuffmanError::Padding) => (
                "Huffman padding is longer than 7 bits",
                "RFC 7541 Section 5.2",
            ),
            Self::Huffman(HuffmanError::PaddingNotEos) => (
                "Huffman padding is not a prefix of EOS",
                "RFC 7541 Section 5.2",
            ),
            Self::Huffman(HuffmanError::Eos) => {
                ("a Huffman string contains EOS", "RFC 7541 Section 5.2")
            }
            Self::Huffman(HuffmanError::OutputFull) => (
                "the Huffman output buffer is too short",
                "a local condition of the slice API",
            ),
            Self::RequiredInsertCount => (
                "no conformant encoder produces this Required Insert Count",
                "RFC 9204 Section 4.5.1.1",
            ),
            Self::NegativeBase => ("the Base is negative", "RFC 9204 Section 4.5.1.2"),
            Self::DynamicReference => (
                "a field line references an entry the dynamic table does not hold",
                "RFC 9204 Section 2.2.3",
            ),
            Self::InvalidStaticIndex => {
                ("the static table index is invalid", "RFC 9204 Section 3.1")
            }
            Self::CapacityExceeded => (
                "the dynamic table capacity exceeds the advertised maximum",
                "RFC 9204 Section 4.3.1",
            ),
            Self::EntryTooLarge => (
                "the entry is larger than the dynamic table capacity",
                "RFC 9204 Section 3.2.2",
            ),
            Self::InstructionAtCapacityZero => (
                "an encoder instruction arrived with a maximum table capacity of zero",
                "RFC 9204 Section 3.2.3",
            ),
            Self::UnexpectedAcknowledgment => (
                "no field section on that stream awaits acknowledgment",
                "RFC 9204 Section 4.4.1",
            ),
            Self::InvalidIncrement => (
                "the Insert Count Increment is zero or beyond the inserts sent",
                "RFC 9204 Section 4.4.3",
            ),
        }
    }
}

/// A QPACK failure: the place picks the code, the fault names the rule.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-6>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error {
    /// Where the failure happened.
    pub place: Place,
    /// The rule that was broken.
    pub fault: Fault,
}

impl Error {
    /// Creates an error.
    ///
    /// # Arguments
    ///
    /// * `place` - where the failure happened.
    /// * `fault` - the rule that was broken.
    #[must_use]
    pub const fn new(place: Place, fault: Fault) -> Self {
        Self { place, fault }
    }

    /// The HTTP/3 error code.
    ///
    /// # Returns
    ///
    /// [`QPACK_DECOMPRESSION_FAILED`], [`QPACK_ENCODER_STREAM_ERROR`] or
    /// [`QPACK_DECODER_STREAM_ERROR`], by place.
    #[must_use]
    pub const fn code(&self) -> u64 {
        match self.place {
            Place::FieldSection => QPACK_DECOMPRESSION_FAILED,
            Place::EncoderStream => QPACK_ENCODER_STREAM_ERROR,
            Place::DecoderStream => QPACK_DECODER_STREAM_ERROR,
        }
    }

    /// The registered name of [`Error::code`].
    ///
    /// # Returns
    ///
    /// `"QPACK_DECOMPRESSION_FAILED"`, `"QPACK_ENCODER_STREAM_ERROR"` or
    /// `"QPACK_DECODER_STREAM_ERROR"`.
    #[must_use]
    pub const fn code_name(&self) -> &'static str {
        match self.place {
            Place::FieldSection => "QPACK_DECOMPRESSION_FAILED",
            Place::EncoderStream => "QPACK_ENCODER_STREAM_ERROR",
            Place::DecoderStream => "QPACK_DECODER_STREAM_ERROR",
        }
    }

    /// Whether the failure closes the connection.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-7.4>
    ///
    /// # Returns
    ///
    /// `false` only for [`Fault::Integer`] in a field section: an integer above
    /// 2^62-1 or longer than 9 continuation octets, or a string literal longer
    /// than the configured limit, which RFC 9204 Section 7.4 makes a stream
    /// error; every other failure closes the connection.
    #[must_use]
    pub const fn is_connection_error(&self) -> bool {
        !matches!(
            (self.place, self.fault),
            (Place::FieldSection, Fault::Integer(_))
        )
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (description, section) = self.fault.describe();
        write!(
            f,
            "{} ({:#x}): {description} ({section})",
            self.code_name(),
            self.code()
        )
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Error {}

impl From<Error> for zero_core::Error {
    fn from(error: Error) -> Self {
        Self::Protocol(alloc::format!("{error}"))
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::ToString;

    use super::{
        Error, Fault, Place, QPACK_DECODER_STREAM_ERROR, QPACK_DECOMPRESSION_FAILED,
        QPACK_ENCODER_STREAM_ERROR,
    };
    use crate::huffman::HuffmanError;
    use crate::integer::IntegerError;

    /// RFC 9204 Section 6: "QPACK_DECOMPRESSION_FAILED (0x0200): The decoder
    /// failed to interpret an encoded field section", "QPACK_ENCODER_STREAM_ERROR
    /// (0x0201): The decoder failed to interpret an encoder instruction received
    /// on the encoder stream." and "QPACK_DECODER_STREAM_ERROR (0x0202): The
    /// encoder failed to interpret a decoder instruction received on the decoder
    /// stream."
    #[test]
    fn qpack_error_codes_carry_the_section_6_values_by_stream() {
        assert_eq!(QPACK_DECOMPRESSION_FAILED, 0x0200);
        assert_eq!(QPACK_ENCODER_STREAM_ERROR, 0x0201);
        assert_eq!(QPACK_DECODER_STREAM_ERROR, 0x0202);
        let cases = [
            (Place::FieldSection, 0x0200, "QPACK_DECOMPRESSION_FAILED"),
            (Place::EncoderStream, 0x0201, "QPACK_ENCODER_STREAM_ERROR"),
            (Place::DecoderStream, 0x0202, "QPACK_DECODER_STREAM_ERROR"),
        ];
        for (place, code, name) in cases {
            let error = Error::new(place, Fault::Integer(IntegerError::TooLarge));
            assert_eq!(error.code(), code);
            assert_eq!(error.code_name(), name);
            assert_eq!(
                error.is_connection_error(),
                place != Place::FieldSection,
                "{place:?}"
            );
            let integer = Error::new(place, Fault::Integer(IntegerError::TooLong));
            assert_eq!(integer.is_connection_error(), place != Place::FieldSection);
            let huffman = Error::new(place, Fault::Huffman(HuffmanError::Eos));
            assert!(huffman.is_connection_error());
        }
        let field = Error::new(Place::FieldSection, Fault::RequiredInsertCount);
        assert!(field.is_connection_error());
        assert_eq!(
            field.to_string(),
            "QPACK_DECOMPRESSION_FAILED (0x200): no conformant encoder produces this \
             Required Insert Count (RFC 9204 Section 4.5.1.1)"
        );
        let converted = zero_core::Error::from(field);
        assert!(matches!(converted, zero_core::Error::Protocol(ref message)
            if message.contains("QPACK_DECOMPRESSION_FAILED")));
    }

    /// RFC 7541 Section 5.2 names three Huffman decoding errors: "A padding
    /// strictly longer than 7 bits", "A padding not corresponding to the most
    /// significant bits of the code for the EOS symbol" and "A Huffman-encoded
    /// string literal containing the EOS symbol". A short output buffer is
    /// none of them, so its description cites no section.
    #[test]
    fn only_the_three_rfc_7541_section_5_2_huffman_errors_cite_that_section() {
        let cited = [
            HuffmanError::Padding,
            HuffmanError::PaddingNotEos,
            HuffmanError::Eos,
        ];
        for error in cited {
            let text = Error::new(Place::FieldSection, Fault::Huffman(error)).to_string();
            assert!(text.ends_with("(RFC 7541 Section 5.2)"), "{text}");
        }
        let short = Error::new(
            Place::FieldSection,
            Fault::Huffman(HuffmanError::OutputFull),
        );
        assert_eq!(
            short.to_string(),
            "QPACK_DECOMPRESSION_FAILED (0x200): the Huffman output buffer is too short \
             (a local condition of the slice API)"
        );
    }

    /// RFC 9204 Section 6 error codes carry a description and a section for
    /// every fault, and the conformance vectors name each fault by one flat,
    /// distinct camelCase string.
    #[test]
    fn fault_names_are_the_flat_vector_names() {
        let cases = [
            (Fault::Truncated, "truncated"),
            (Fault::Integer(IntegerError::TooLong), "tooLong"),
            (Fault::Integer(IntegerError::TooLarge), "tooLarge"),
            (Fault::Huffman(HuffmanError::Padding), "padding"),
            (Fault::Huffman(HuffmanError::PaddingNotEos), "paddingNotEos"),
            (Fault::Huffman(HuffmanError::Eos), "eos"),
            (Fault::Huffman(HuffmanError::OutputFull), "outputFull"),
            (Fault::RequiredInsertCount, "requiredInsertCount"),
            (Fault::NegativeBase, "negativeBase"),
            (Fault::DynamicReference, "dynamicReference"),
            (Fault::InvalidStaticIndex, "invalidStaticIndex"),
            (Fault::CapacityExceeded, "capacityExceeded"),
            (Fault::EntryTooLarge, "entryTooLarge"),
            (
                Fault::InstructionAtCapacityZero,
                "instructionAtCapacityZero",
            ),
            (Fault::UnexpectedAcknowledgment, "unexpectedAcknowledgment"),
            (Fault::InvalidIncrement, "invalidIncrement"),
        ];
        for (index, (fault, name)) in cases.iter().enumerate() {
            assert_eq!(fault.name(), *name);
            for (_, other) in cases.iter().skip(index.saturating_add(1)) {
                assert_ne!(name, other);
            }
            let text = Error::new(Place::EncoderStream, *fault).to_string();
            assert!(
                text.starts_with("QPACK_ENCODER_STREAM_ERROR (0x201): "),
                "{text}"
            );
            assert!(text.ends_with(')'), "{text}");
        }
    }
}
