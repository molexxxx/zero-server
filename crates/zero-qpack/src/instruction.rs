//! Encoder and decoder stream instructions (RFC 9204 Sections 4.3 and 4.4), and
//! the receivers of a peer's streams at a maximum table capacity of zero.
//!
//! Encoder stream, by first octet: `1Txxxxxx` Insert with Name Reference, Name
//! Index (6+) then the value as an 8-bit prefix string literal (Section 4.3.2);
//! `01Hxxxxx` Insert with Literal Name, the name as a 6-bit prefix string
//! literal then the value (Section 4.3.3); `001xxxxx` Set Dynamic Table
//! Capacity, Capacity (5+) (Section 4.3.1); `000xxxxx` Duplicate, Index (5+)
//! (Section 4.3.4). Decoder stream: `1xxxxxxx` Section Acknowledgment, Stream ID
//! (7+) (Section 4.4.1); `01xxxxxx` Stream Cancellation, Stream ID (6+) (Section
//! 4.4.2); `00xxxxxx` Insert Count Increment, Increment (6+) (Section 4.4.3).
//! Both streams are unframed, so a parser reports an instruction that is not
//! complete yet as `Ok(None)`. Every integer is read up to 2^62-1; a string
//! length above the string literal limit is refused as soon as its integer is
//! complete.
//!
//! "When the maximum table capacity is zero, the encoder MUST NOT insert
//! entries into the dynamic table and MUST NOT send any encoder instructions on
//! the encoder stream." (Section 3.2.3). A decoder that advertised zero
//! therefore refuses every encoder instruction with QPACK_ENCODER_STREAM_ERROR,
//! reporting the most specific rule broken, and decides at the instruction head
//! (the opcode and first integer, at most 10 octets) without waiting for string
//! octets: "a stream containing a large instruction can become deadlocked if the
//! decoder withholds flow-control credit until the instruction is completely
//! received." (Section 2.1.3). An encoder that never references the dynamic
//! table refuses every Section Acknowledgment and Insert Count Increment with
//! QPACK_DECODER_STREAM_ERROR and accepts Stream Cancellation, for which no
//! error is stated.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.3>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.4>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.2.3>

use alloc::vec::Vec;

use crate::error::{Error, Fault, Place};
use crate::integer::{self, IntegerError, PrefixBits, MAX_VALUE};
use crate::string::{StringLiteral, StringPrefixBits};
use crate::table::STATIC_TABLE;

/// An encoder stream integer fault.
const fn encoder_stream(error: IntegerError) -> Error {
    Error::new(Place::EncoderStream, Fault::Integer(error))
}

/// A decoder stream integer fault.
const fn decoder_stream(error: IntegerError) -> Error {
    Error::new(Place::DecoderStream, Fault::Integer(error))
}

/// The largest static table index, 98.
fn last_static_index() -> u64 {
    u64::try_from(STATIC_TABLE.len())
        .unwrap_or(0)
        .saturating_sub(1)
}

/// An encoder instruction (RFC 9204 Section 4.3).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.3>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncoderInstruction<'a> {
    /// `001xxxxx`, Capacity (5+) (Section 4.3.1).
    SetDynamicTableCapacity {
        /// The new dynamic table capacity.
        capacity: u64,
    },
    /// `1Txxxxxx`, Name Index (6+), value as an 8-bit prefix string (Section
    /// 4.3.2).
    InsertWithNameReference {
        /// T: the name index is into the static table, else relative into the
        /// dynamic table.
        static_table: bool,
        /// The name index.
        index: u64,
        /// The value.
        value: StringLiteral<'a>,
    },
    /// `01Hxxxxx`, name as a 6-bit prefix string, value as an 8-bit prefix
    /// string (Section 4.3.3).
    InsertWithLiteralName {
        /// The name.
        name: StringLiteral<'a>,
        /// The value.
        value: StringLiteral<'a>,
    },
    /// `000xxxxx`, Index (5+), relative (Section 4.3.4).
    Duplicate {
        /// The relative index of the entry to duplicate.
        index: u64,
    },
}

impl<'a> EncoderInstruction<'a> {
    /// Parses one whole instruction at the start of `input`.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.3>
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed octets of the encoder stream.
    /// * `max_string_len` - the longest string literal accepted.
    ///
    /// # Returns
    ///
    /// `Ok(None)` when `input` ends inside the instruction, otherwise the
    /// instruction and the octets it spans.
    ///
    /// # Errors
    ///
    /// An [`Error`] with [`Place::EncoderStream`] and [`Fault::Integer`] for an
    /// integer beyond 62 bits or 9 continuation octets, or a string length
    /// above `max_string_len`.
    pub fn parse(input: &'a [u8], max_string_len: u64) -> Result<Option<(Self, usize)>, Error> {
        let Some(&first) = input.first() else {
            return Ok(None);
        };
        if first & 0x80 != 0 {
            let Some((index, used)) =
                integer::decode(input, PrefixBits::P6, MAX_VALUE).map_err(encoder_stream)?
            else {
                return Ok(None);
            };
            let rest = input.get(used..).unwrap_or(&[]);
            let Some((value, value_len)) =
                StringLiteral::parse(rest, StringPrefixBits::P8, max_string_len)
                    .map_err(encoder_stream)?
            else {
                return Ok(None);
            };
            let instruction = Self::InsertWithNameReference {
                static_table: first & 0x40 != 0,
                index,
                value,
            };
            return Ok(Some((instruction, used.saturating_add(value_len))));
        }
        if first & 0xc0 == 0x40 {
            let Some((name, used)) =
                StringLiteral::parse(input, StringPrefixBits::P6, max_string_len)
                    .map_err(encoder_stream)?
            else {
                return Ok(None);
            };
            let rest = input.get(used..).unwrap_or(&[]);
            let Some((value, value_len)) =
                StringLiteral::parse(rest, StringPrefixBits::P8, max_string_len)
                    .map_err(encoder_stream)?
            else {
                return Ok(None);
            };
            let instruction = Self::InsertWithLiteralName { name, value };
            return Ok(Some((instruction, used.saturating_add(value_len))));
        }
        let Some((value, used)) =
            integer::decode(input, PrefixBits::P5, MAX_VALUE).map_err(encoder_stream)?
        else {
            return Ok(None);
        };
        let instruction = if first & 0xe0 == 0x20 {
            Self::SetDynamicTableCapacity { capacity: value }
        } else {
            Self::Duplicate { index: value }
        };
        Ok(Some((instruction, used)))
    }

    /// Appends the instruction to `out`, strings written as they are held.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer the instruction is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when a value exceeds 2^62-1.
    pub fn encode(&self, out: &mut Vec<u8>) -> Option<()> {
        let start = out.len();
        let written = match *self {
            Self::SetDynamicTableCapacity { capacity } => {
                integer::push(capacity, PrefixBits::P5, 0x20, out)
            }
            Self::InsertWithNameReference {
                static_table,
                index,
                value,
            } => {
                let flags = if static_table { 0xc0 } else { 0x80 };
                integer::push(index, PrefixBits::P6, flags, out)
                    .and_then(|()| value.encode(StringPrefixBits::P8, 0, out))
            }
            Self::InsertWithLiteralName { name, value } => name
                .encode(StringPrefixBits::P6, 0x40, out)
                .and_then(|()| value.encode(StringPrefixBits::P8, 0, out)),
            Self::Duplicate { index } => integer::push(index, PrefixBits::P5, 0x00, out),
        };
        if written.is_none() {
            out.truncate(start);
        }
        written
    }
}

/// The opcode and first integer of an encoder instruction: at most
/// [`integer::MAX_LEN`] octets.
///
/// It is all a decoder at maximum capacity zero needs for its verdict, and lets
/// a dynamic table bound an entry before its strings arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncoderHead {
    /// Set Dynamic Table Capacity and the capacity.
    SetDynamicTableCapacity {
        /// The new dynamic table capacity.
        capacity: u64,
    },
    /// Insert with Name Reference: T and the name index.
    InsertWithNameReference {
        /// T: the name index is into the static table.
        static_table: bool,
        /// The name index.
        index: u64,
    },
    /// Insert with Literal Name: H and the name length.
    InsertWithLiteralName {
        /// H: the name is Huffman coded.
        huffman: bool,
        /// The length of the encoded name.
        name_len: u64,
    },
    /// Duplicate and the relative index.
    Duplicate {
        /// The relative index of the entry to duplicate.
        index: u64,
    },
}

impl EncoderHead {
    /// Parses the head of the instruction at the start of `input`.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.3>
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed octets of the encoder stream.
    /// * `max_string_len` - the longest name accepted.
    ///
    /// # Returns
    ///
    /// `Ok(None)` when `input` ends inside the head, otherwise the head and the
    /// octets it spans.
    ///
    /// # Errors
    ///
    /// An [`Error`] with [`Place::EncoderStream`] and [`Fault::Integer`]:
    /// `name_len` is capped at `max_string_len`, every other integer read up to
    /// 2^62-1.
    pub fn parse(input: &[u8], max_string_len: u64) -> Result<Option<(Self, usize)>, Error> {
        let Some(&first) = input.first() else {
            return Ok(None);
        };
        let (prefix, cap) = if first & 0x80 != 0 {
            (PrefixBits::P6, MAX_VALUE)
        } else if first & 0xc0 == 0x40 {
            (PrefixBits::P5, max_string_len)
        } else {
            (PrefixBits::P5, MAX_VALUE)
        };
        let Some((value, used)) = integer::decode(input, prefix, cap).map_err(encoder_stream)?
        else {
            return Ok(None);
        };
        let head = if first & 0x80 != 0 {
            Self::InsertWithNameReference {
                static_table: first & 0x40 != 0,
                index: value,
            }
        } else if first & 0xc0 == 0x40 {
            Self::InsertWithLiteralName {
                huffman: first & 0x20 != 0,
                name_len: value,
            }
        } else if first & 0xe0 == 0x20 {
            Self::SetDynamicTableCapacity { capacity: value }
        } else {
            Self::Duplicate { index: value }
        };
        Ok(Some((head, used)))
    }
}

/// A decoder instruction (RFC 9204 Section 4.4).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.4>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecoderInstruction {
    /// `1xxxxxxx`, Stream ID (7+) (Section 4.4.1).
    SectionAcknowledgment {
        /// The stream whose field section was processed.
        stream_id: u64,
    },
    /// `01xxxxxx`, Stream ID (6+) (Section 4.4.2).
    StreamCancellation {
        /// The stream that was reset or abandoned.
        stream_id: u64,
    },
    /// `00xxxxxx`, Increment (6+) (Section 4.4.3).
    InsertCountIncrement {
        /// The increase of the Known Received Count.
        increment: u64,
    },
}

impl DecoderInstruction {
    /// Parses one instruction at the start of `input`; stream IDs and increments
    /// are read up to 2^62-1.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.4>
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed octets of the decoder stream.
    ///
    /// # Returns
    ///
    /// `Ok(None)` when `input` ends inside the instruction (at most
    /// [`integer::MAX_LEN`] octets), otherwise the instruction and the octets it
    /// spans.
    ///
    /// # Errors
    ///
    /// An [`Error`] with [`Place::DecoderStream`] and [`Fault::Integer`] for an
    /// integer beyond 62 bits or 9 continuation octets.
    pub fn parse(input: &[u8]) -> Result<Option<(Self, usize)>, Error> {
        let Some(&first) = input.first() else {
            return Ok(None);
        };
        let prefix = if first & 0x80 != 0 {
            PrefixBits::P7
        } else {
            PrefixBits::P6
        };
        let Some((value, used)) =
            integer::decode(input, prefix, MAX_VALUE).map_err(decoder_stream)?
        else {
            return Ok(None);
        };
        let instruction = if first & 0x80 != 0 {
            Self::SectionAcknowledgment { stream_id: value }
        } else if first & 0x40 != 0 {
            Self::StreamCancellation { stream_id: value }
        } else {
            Self::InsertCountIncrement { increment: value }
        };
        Ok(Some((instruction, used)))
    }

    /// Appends the instruction to `out`.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer the instruction is appended to.
    ///
    /// # Returns
    ///
    /// `None`, with `out` unchanged, when a value exceeds 2^62-1.
    pub fn encode(&self, out: &mut Vec<u8>) -> Option<()> {
        match *self {
            Self::SectionAcknowledgment { stream_id } => {
                integer::push(stream_id, PrefixBits::P7, 0x80, out)
            }
            Self::StreamCancellation { stream_id } => {
                integer::push(stream_id, PrefixBits::P6, 0x40, out)
            }
            Self::InsertCountIncrement { increment } => {
                integer::push(increment, PrefixBits::P6, 0x00, out)
            }
        }
    }
}

/// Applies a peer's encoder stream to a decoder whose maximum table capacity is
/// zero.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.2.3>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncoderStreamReceiver {
    max_capacity: u64,
    max_string_len: u64,
}

impl EncoderStreamReceiver {
    /// Creates the receiver of a decoder that advertised a maximum table
    /// capacity of zero.
    ///
    /// # Arguments
    ///
    /// * `max_string_len` - the longest string literal accepted.
    #[must_use]
    pub const fn new(max_string_len: u64) -> Self {
        Self {
            max_capacity: 0,
            max_string_len,
        }
    }

    /// The verdict on one instruction head.
    ///
    /// At maximum capacity zero it is always an error: a capacity above zero
    /// exceeds the maximum (Section 4.3.1); a static name index above 98 is an
    /// invalid static index (Section 3.1); every insert adds an entry of at
    /// least 32 octets to a table of capacity zero (Section 3.2.2); and Set
    /// Dynamic Table Capacity 0 and Duplicate are encoder instructions that
    /// must not be sent at all (Section 3.2.3). The `Result` leaves room for
    /// the dynamic table.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-3.2.3>
    ///
    /// # Arguments
    ///
    /// * `head` - the opcode and first integer of the instruction.
    ///
    /// # Errors
    ///
    /// An [`Error`] with [`Place::EncoderStream`] and [`Fault::CapacityExceeded`],
    /// [`Fault::InvalidStaticIndex`], [`Fault::EntryTooLarge`] or
    /// [`Fault::InstructionAtCapacityZero`].
    pub fn check(&self, head: &EncoderHead) -> Result<(), Error> {
        let fault = match *head {
            EncoderHead::SetDynamicTableCapacity { capacity } if capacity > self.max_capacity => {
                Fault::CapacityExceeded
            }
            EncoderHead::InsertWithNameReference {
                static_table: true,
                index,
            } if index > last_static_index() => Fault::InvalidStaticIndex,
            EncoderHead::InsertWithNameReference { .. }
            | EncoderHead::InsertWithLiteralName { .. } => Fault::EntryTooLarge,
            EncoderHead::SetDynamicTableCapacity { .. } | EncoderHead::Duplicate { .. } => {
                Fault::InstructionAtCapacityZero
            }
        };
        Err(Error::new(Place::EncoderStream, fault))
    }

    /// Reads instruction heads at the start of `input` and decides on each as
    /// soon as it is complete, without waiting for string octets.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-2.1.3>
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed octets of the encoder stream.
    ///
    /// # Returns
    ///
    /// The octets consumed: always 0 at capacity zero, where the first complete
    /// head is refused; while a head is incomplete, at most
    /// [`integer::MAX_LEN`] - 1 octets wait.
    ///
    /// # Errors
    ///
    /// The first head's verdict, or an integer fault.
    pub fn feed(&mut self, input: &[u8]) -> Result<usize, Error> {
        let mut consumed = 0usize;
        while let Some(rest) = input.get(consumed..) {
            let Some((head, _)) = EncoderHead::parse(rest, self.max_string_len)? else {
                break;
            };
            self.check(&head)?;
            let Some((_, used)) = EncoderInstruction::parse(rest, self.max_string_len)? else {
                break;
            };
            consumed = consumed.saturating_add(used);
        }
        Ok(consumed)
    }
}

/// Applies a peer's decoder stream to an encoder that never references the
/// dynamic table.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.4>
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecoderStreamReceiver;

impl DecoderStreamReceiver {
    /// Applies one instruction.
    ///
    /// Every field section this encoder sends has Required Insert Count 0, so a
    /// Section Acknowledgment names a stream "on which every encoded field
    /// section with a non-zero Required Insert Count has already been
    /// acknowledged" (Section 4.4.1), and an Insert Count Increment is zero or
    /// "increases the Known Received Count beyond what the encoder has sent"
    /// (Section 4.4.3). A Stream Cancellation has no stated error and no effect.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.4.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.4.3>
    ///
    /// # Arguments
    ///
    /// * `instruction` - the decoder instruction.
    ///
    /// # Errors
    ///
    /// An [`Error`] with [`Place::DecoderStream`] and
    /// [`Fault::UnexpectedAcknowledgment`] or [`Fault::InvalidIncrement`].
    pub fn receive(&mut self, instruction: &DecoderInstruction) -> Result<(), Error> {
        match *instruction {
            DecoderInstruction::SectionAcknowledgment { .. } => Err(Error::new(
                Place::DecoderStream,
                Fault::UnexpectedAcknowledgment,
            )),
            DecoderInstruction::InsertCountIncrement { .. } => {
                Err(Error::new(Place::DecoderStream, Fault::InvalidIncrement))
            }
            DecoderInstruction::StreamCancellation { .. } => Ok(()),
        }
    }

    /// Parses and applies every complete instruction at the start of `input`.
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed octets of the decoder stream.
    ///
    /// # Returns
    ///
    /// The octets consumed; each instruction is one integer, so at most
    /// [`integer::MAX_LEN`] - 1 octets of a partial one wait.
    ///
    /// # Errors
    ///
    /// The first refused instruction, or an integer fault.
    pub fn feed(&mut self, input: &[u8]) -> Result<usize, Error> {
        let mut consumed = 0usize;
        while let Some(rest) = input.get(consumed..) {
            let Some((instruction, used)) = DecoderInstruction::parse(rest)? else {
                break;
            };
            self.receive(&instruction)?;
            consumed = consumed.saturating_add(used);
        }
        Ok(consumed)
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        DecoderInstruction, DecoderStreamReceiver, EncoderHead, EncoderInstruction,
        EncoderStreamReceiver,
    };
    use crate::error::{
        Error, Fault, Place, QPACK_DECODER_STREAM_ERROR, QPACK_ENCODER_STREAM_ERROR,
    };
    use crate::integer::{self, IntegerError, PrefixBits, MAX_LEN, MAX_VALUE};
    use crate::string::StringLiteral;
    use crate::unhex;
    use crate::xorshift::XorShift;

    /// The string literal limit of the default limits.
    const CAP: u64 = zero_limits::transport::QPACK_INTEGER_CAP;

    /// A raw string literal holding `data`.
    const fn raw(data: &[u8]) -> StringLiteral<'_> {
        StringLiteral {
            huffman: false,
            data,
        }
    }

    /// The verdict of a receiver fed `input` whole, checked against the verdict
    /// of the same receiver fed one octet at a time.
    fn encoder_verdict(input: &[u8]) -> Result<usize, Error> {
        let whole = EncoderStreamReceiver::new(CAP).feed(input);
        let mut receiver = EncoderStreamReceiver::new(CAP);
        let mut pending = Vec::new();
        let mut bytewise = Ok(0usize);
        for &octet in input {
            pending.push(octet);
            match receiver.feed(&pending) {
                Ok(used) => {
                    pending.drain(..used.min(pending.len()));
                    assert!(pending.len() < MAX_LEN, "{input:?}");
                    bytewise = Ok(0);
                }
                Err(error) => {
                    bytewise = Err(error);
                    break;
                }
            }
        }
        assert_eq!(whole.err(), bytewise.err(), "{input:?}");
        whole
    }

    /// The parsed encoder instructions of `input`, which must hold whole ones.
    fn encoder_instructions(input: &[u8]) -> Vec<EncoderInstruction<'_>> {
        let mut rest = input;
        let mut parsed = Vec::new();
        while let Ok(Some((instruction, used))) = EncoderInstruction::parse(rest, CAP) {
            parsed.push(instruction);
            rest = rest.get(used..).unwrap_or_default();
        }
        assert!(rest.is_empty(), "{input:?}");
        parsed
    }

    /// RFC 9204 Section 4.3.1: "The decoder MUST treat a new dynamic table
    /// capacity value that exceeds this limit as a connection error of type
    /// QPACK_ENCODER_STREAM_ERROR."
    #[test]
    fn a_dynamic_table_capacity_above_the_advertised_maximum_is_an_encoder_stream_error() {
        let mut max = Vec::new();
        let instruction = EncoderInstruction::SetDynamicTableCapacity {
            capacity: MAX_VALUE,
        };
        assert_eq!(instruction.encode(&mut max), Some(()));
        for input in [unhex("3fbd01"), unhex("21"), max] {
            let error = encoder_verdict(&input).err();
            assert_eq!(
                error,
                Some(Error::new(Place::EncoderStream, Fault::CapacityExceeded)),
                "{input:?}"
            );
            assert!(error
                .is_some_and(|error| error.code() == QPACK_ENCODER_STREAM_ERROR
                    && error.is_connection_error()));
        }
    }

    /// RFC 9204 Section 3.2.2: "It is an error if the encoder attempts to add an
    /// entry that is larger than the dynamic table capacity; the decoder MUST
    /// treat this as a connection error of type QPACK_ENCODER_STREAM_ERROR."
    #[test]
    fn an_insert_larger_than_the_dynamic_table_capacity_is_an_encoder_stream_error() {
        let b3 = unhex("4a637573746f6d2d6b65790c637573746f6d2d76616c7565");
        let b5 = unhex("810d637573746f6d2d76616c756532");
        let mut static_name = unhex("c0");
        assert_eq!(
            raw(b"value").encode(crate::string::StringPrefixBits::P8, 0, &mut static_name),
            Some(())
        );
        let head_only = unhex("5fe1ffffff03");
        assert_eq!(
            EncoderHead::parse(&head_only, CAP),
            Ok(Some((
                EncoderHead::InsertWithLiteralName {
                    huffman: false,
                    name_len: 1 << 30
                },
                6
            )))
        );
        for input in [b3, b5, static_name, head_only] {
            let error = encoder_verdict(&input).err();
            assert_eq!(
                error,
                Some(Error::new(Place::EncoderStream, Fault::EntryTooLarge)),
                "{input:?}"
            );
            assert!(error.is_some_and(|error| error.code() == QPACK_ENCODER_STREAM_ERROR));
        }
    }

    /// RFC 9204 Section 3.2.2: "It is an error if the encoder attempts to add
    /// an entry that is larger than the dynamic table capacity", which an
    /// insert head decides at capacity zero before its string octets arrive,
    /// and Section 7.4: a value larger than the decoder accepts is "a
    /// connection error of the appropriate type if on the encoder or decoder
    /// stream".
    #[test]
    fn an_encoder_instruction_is_refused_at_its_head_without_waiting_for_string_octets() {
        let head_only = unhex("5fe1ffffff03");
        let mut receiver = EncoderStreamReceiver::new(CAP);
        for end in 1..head_only.len() {
            assert_eq!(
                receiver.feed(head_only.get(..end).unwrap_or_default()),
                Ok(0)
            );
        }
        assert_eq!(
            receiver.feed(&head_only),
            Err(Error::new(Place::EncoderStream, Fault::EntryTooLarge))
        );
        assert_eq!(EncoderInstruction::parse(&head_only, CAP), Ok(None));
        let mut above = Vec::new();
        assert_eq!(
            integer::push(CAP.saturating_add(1), PrefixBits::P5, 0x40, &mut above),
            Some(())
        );
        assert_eq!(
            receiver.feed(&above),
            Err(Error::new(
                Place::EncoderStream,
                Fault::Integer(IntegerError::TooLarge)
            ))
        );
        assert_eq!(
            EncoderInstruction::parse(&above, CAP),
            Err(Error::new(
                Place::EncoderStream,
                Fault::Integer(IntegerError::TooLarge)
            ))
        );
        let mut value_above = unhex("c0");
        assert_eq!(
            integer::push(CAP.saturating_add(1), PrefixBits::P7, 0, &mut value_above),
            Some(())
        );
        assert_eq!(
            EncoderInstruction::parse(&value_above, CAP),
            Err(Error::new(
                Place::EncoderStream,
                Fault::Integer(IntegerError::TooLarge)
            ))
        );
    }

    /// RFC 9204 Appendix B.2 to B.5: the encoder stream octets `3fbd01`,
    /// `c00f7777772e6578616d706c652e636f6d`, `c10c2f73616d706c652f70617468`,
    /// `4a637573746f6d2d6b65790c637573746f6d2d76616c7565`, `02` and
    /// `810d637573746f6d2d76616c756532` with their interpretations.
    #[test]
    fn the_appendix_b_encoder_stream_octets_parse_to_the_annotated_instructions() {
        let cases: [(&str, &str, Vec<EncoderInstruction<'static>>); 4] = [
            (
                "B.2",
                "3fbd01c00f7777772e6578616d706c652e636f6dc10c2f73616d706c652f70617468",
                alloc::vec![
                    EncoderInstruction::SetDynamicTableCapacity { capacity: 220 },
                    EncoderInstruction::InsertWithNameReference {
                        static_table: true,
                        index: 0,
                        value: raw(b"www.example.com"),
                    },
                    EncoderInstruction::InsertWithNameReference {
                        static_table: true,
                        index: 1,
                        value: raw(b"/sample/path"),
                    },
                ],
            ),
            (
                "B.3",
                "4a637573746f6d2d6b65790c637573746f6d2d76616c7565",
                alloc::vec![EncoderInstruction::InsertWithLiteralName {
                    name: raw(b"custom-key"),
                    value: raw(b"custom-value"),
                }],
            ),
            (
                "B.4",
                "02",
                alloc::vec![EncoderInstruction::Duplicate { index: 2 }],
            ),
            (
                "B.5",
                "810d637573746f6d2d76616c756532",
                alloc::vec![EncoderInstruction::InsertWithNameReference {
                    static_table: false,
                    index: 1,
                    value: raw(b"custom-value2"),
                }],
            ),
        ];
        for (section, hex, expected) in cases {
            let input = unhex(hex);
            assert_eq!(encoder_instructions(&input), expected, "{section}");
            let mut out = Vec::new();
            for instruction in &expected {
                assert_eq!(instruction.encode(&mut out), Some(()));
            }
            assert_eq!(out, input, "{section}");
            for end in 0..input.len() {
                let head = input.get(..end).unwrap_or_default();
                let complete = encoder_instructions_prefix(head);
                assert!(complete < expected.len(), "{section}");
            }
        }
    }

    /// The number of whole instructions at the start of `input`.
    fn encoder_instructions_prefix(input: &[u8]) -> usize {
        let mut rest = input;
        let mut count = 0usize;
        while let Ok(Some((_, used))) = EncoderInstruction::parse(rest, CAP) {
            count = count.saturating_add(1);
            rest = rest.get(used..).unwrap_or_default();
        }
        count
    }

    /// RFC 9204 Appendix B.2, B.3 and B.4: the decoder stream octets `84`
    /// "Section Acknowledgment (stream=4)", `01` "Insert Count Increment (1)"
    /// and `48` "Stream Cancellation (Stream=8)".
    #[test]
    fn the_appendix_b_decoder_stream_octets_parse_to_the_annotated_instructions() {
        let cases = [
            (
                "84",
                DecoderInstruction::SectionAcknowledgment { stream_id: 4 },
            ),
            (
                "01",
                DecoderInstruction::InsertCountIncrement { increment: 1 },
            ),
            (
                "48",
                DecoderInstruction::StreamCancellation { stream_id: 8 },
            ),
        ];
        for (hex, expected) in cases {
            let input = unhex(hex);
            assert_eq!(DecoderInstruction::parse(&input), Ok(Some((expected, 1))));
            let mut out = Vec::new();
            assert_eq!(expected.encode(&mut out), Some(()));
            assert_eq!(out, input, "{hex}");
        }
        assert_eq!(DecoderInstruction::parse(&[]), Ok(None));
        assert_eq!(DecoderInstruction::parse(&unhex("ff")), Ok(None));
    }

    /// RFC 9204 Section 4.4.1: "If an encoder receives a Section Acknowledgment
    /// instruction referring to a stream on which every encoded field section
    /// with a non-zero Required Insert Count has already been acknowledged, this
    /// MUST be treated as a connection error of type QPACK_DECODER_STREAM_ERROR."
    #[test]
    fn a_section_acknowledgment_with_nothing_unacknowledged_is_a_decoder_stream_error() {
        let mut receiver = DecoderStreamReceiver;
        let error = receiver.feed(&unhex("84")).err();
        assert_eq!(
            error,
            Some(Error::new(
                Place::DecoderStream,
                Fault::UnexpectedAcknowledgment
            ))
        );
        assert!(error.is_some_and(
            |error| error.code() == QPACK_DECODER_STREAM_ERROR && error.is_connection_error()
        ));
        assert_eq!(
            receiver
                .receive(&DecoderInstruction::SectionAcknowledgment { stream_id: 0 })
                .map_err(|error| error.fault),
            Err(Fault::UnexpectedAcknowledgment)
        );
        assert_eq!(receiver.feed(&unhex("4848")), Ok(2));
        assert_eq!(
            receiver.feed(&unhex("4884")).map_err(|error| error.fault),
            Err(Fault::UnexpectedAcknowledgment)
        );
    }

    /// RFC 9204 Section 4.4.3: "An encoder that receives an Increment field
    /// equal to zero, or one that increases the Known Received Count beyond what
    /// the encoder has sent, MUST treat this as a connection error of type
    /// QPACK_DECODER_STREAM_ERROR."
    #[test]
    fn an_insert_count_increment_of_zero_or_beyond_the_inserts_sent_is_a_decoder_stream_error() {
        let mut max = Vec::new();
        let instruction = DecoderInstruction::InsertCountIncrement {
            increment: MAX_VALUE,
        };
        assert_eq!(instruction.encode(&mut max), Some(()));
        for input in [unhex("00"), unhex("01"), max] {
            let error = DecoderStreamReceiver.feed(&input).err();
            assert_eq!(
                error,
                Some(Error::new(Place::DecoderStream, Fault::InvalidIncrement)),
                "{input:?}"
            );
            assert!(error.is_some_and(|error| error.code() == QPACK_DECODER_STREAM_ERROR));
        }
    }

    /// RFC 9204 Section 3.2.3: "When the maximum table capacity is zero, the
    /// encoder MUST NOT insert entries into the dynamic table and MUST NOT send
    /// any encoder instructions on the encoder stream."
    #[test]
    fn with_a_maximum_table_capacity_of_zero_any_encoder_instruction_is_an_encoder_stream_error() {
        for hex in ["20", "02", "00", "1f8000", "1f808080808080808000"] {
            let input = unhex(hex);
            assert_eq!(
                encoder_verdict(&input).err(),
                Some(Error::new(
                    Place::EncoderStream,
                    Fault::InstructionAtCapacityZero
                )),
                "{hex}"
            );
        }
        let mut rng = XorShift::new(0x494e_0001);
        for _ in 0..crate::xorshift::iterations(2_000) {
            let instruction = match rng.below(4) {
                0 => EncoderInstruction::SetDynamicTableCapacity {
                    capacity: rng.value62(),
                },
                1 => EncoderInstruction::InsertWithNameReference {
                    static_table: rng.flag(),
                    index: rng.value62(),
                    value: raw(b"v"),
                },
                2 => EncoderInstruction::InsertWithLiteralName {
                    name: raw(b"n"),
                    value: raw(b"v"),
                },
                _ => EncoderInstruction::Duplicate {
                    index: rng.value62(),
                },
            };
            let mut input = Vec::new();
            assert_eq!(instruction.encode(&mut input), Some(()));
            let verdict = encoder_verdict(&input);
            assert!(
                verdict.is_err_and(|error| error.place == Place::EncoderStream
                    && error.code() == QPACK_ENCODER_STREAM_ERROR
                    && error.is_connection_error()),
                "{instruction:?}"
            );
        }
        assert_eq!(EncoderStreamReceiver::new(CAP).feed(&[]), Ok(0));
    }

    /// RFC 9204 Section 3.1: an invalid static table index "received on the
    /// encoder stream ... MUST be treated as a connection error of type
    /// QPACK_ENCODER_STREAM_ERROR", reported before the Section 3.2.2 error of
    /// an insert larger than the capacity.
    #[test]
    fn an_invalid_static_name_index_on_the_encoder_stream_is_reported_first() {
        let input = unhex("ff2400");
        assert_eq!(
            EncoderHead::parse(&input, CAP),
            Ok(Some((
                EncoderHead::InsertWithNameReference {
                    static_table: true,
                    index: 99
                },
                2
            )))
        );
        assert_eq!(
            encoder_verdict(&input).err().map(|error| error.fault),
            Some(Fault::InvalidStaticIndex)
        );
        assert_eq!(
            encoder_verdict(&unhex("fe2200"))
                .err()
                .map(|error| error.fault),
            Some(Fault::EntryTooLarge)
        );
    }

    /// RFC 9204 Section 4.1.1: "QPACK implementations MUST be able to decode
    /// integers up to and including 62 bits long.", so no instruction of
    /// Sections 4.3 and 4.4 is written with a larger value.
    #[test]
    fn instruction_encoders_refuse_a_value_above_2_62_minus_1_and_leave_the_buffer_unchanged() {
        let above = MAX_VALUE.saturating_add(1);
        let encoder = [
            EncoderInstruction::SetDynamicTableCapacity { capacity: above },
            EncoderInstruction::InsertWithNameReference {
                static_table: true,
                index: above,
                value: raw(b"v"),
            },
            EncoderInstruction::Duplicate { index: above },
        ];
        for instruction in encoder {
            let mut out = alloc::vec![9];
            assert_eq!(instruction.encode(&mut out), None);
            assert_eq!(out, alloc::vec![9]);
        }
        let decoder = [
            DecoderInstruction::SectionAcknowledgment { stream_id: above },
            DecoderInstruction::StreamCancellation { stream_id: above },
            DecoderInstruction::InsertCountIncrement { increment: above },
        ];
        for instruction in decoder {
            let mut out = alloc::vec![9];
            assert_eq!(instruction.encode(&mut out), None);
            assert_eq!(out, alloc::vec![9]);
        }
    }

    /// RFC 9204 Sections 4.3.1 to 4.3.4 and 4.4.1 to 4.4.3: every encoder and
    /// decoder instruction, written with its bit pattern and fields, parses
    /// back to itself.
    #[test]
    fn random_instructions_round_trip() {
        let mut rng = XorShift::new(0x494e_0002);
        for _ in 0..crate::xorshift::iterations(3_000) {
            let name = rng.bytes(0, 20);
            let value = rng.bytes(0, 40);
            let encoder = match rng.below(4) {
                0 => EncoderInstruction::SetDynamicTableCapacity {
                    capacity: rng.value62(),
                },
                1 => EncoderInstruction::InsertWithNameReference {
                    static_table: rng.flag(),
                    index: rng.value62(),
                    value: StringLiteral {
                        huffman: rng.flag(),
                        data: &value,
                    },
                },
                2 => EncoderInstruction::InsertWithLiteralName {
                    name: StringLiteral {
                        huffman: rng.flag(),
                        data: &name,
                    },
                    value: raw(&value),
                },
                _ => EncoderInstruction::Duplicate {
                    index: rng.value62(),
                },
            };
            let mut out = Vec::new();
            assert_eq!(encoder.encode(&mut out), Some(()));
            assert_eq!(
                EncoderInstruction::parse(&out, CAP),
                Ok(Some((encoder, out.len())))
            );
            let decoder = match rng.below(3) {
                0 => DecoderInstruction::SectionAcknowledgment {
                    stream_id: rng.value62(),
                },
                1 => DecoderInstruction::StreamCancellation {
                    stream_id: rng.value62(),
                },
                _ => DecoderInstruction::InsertCountIncrement {
                    increment: rng.value62(),
                },
            };
            let mut out = Vec::new();
            assert_eq!(decoder.encode(&mut out), Some(()));
            assert_eq!(
                DecoderInstruction::parse(&out),
                Ok(Some((decoder, out.len())))
            );
        }
    }

    /// RFC 9204 Sections 4.3 and 4.4: arbitrary octets read as encoder or
    /// decoder stream instructions never panic the parsers, and whatever parses
    /// is written back to the same instruction.
    #[test]
    fn arbitrary_octets_never_panic_the_instruction_parsers() {
        let mut rng = XorShift::new(0x494e_0003);
        for _ in 0..crate::xorshift::iterations(20_000) {
            let input = rng.bytes(0, 24);
            if let Ok(Some((instruction, used))) = EncoderInstruction::parse(&input, CAP) {
                assert!(used <= input.len());
                let mut out = Vec::new();
                assert_eq!(instruction.encode(&mut out), Some(()));
                assert_eq!(
                    EncoderInstruction::parse(&out, CAP),
                    Ok(Some((instruction, out.len())))
                );
            }
            if let Ok(Some((_, used))) = EncoderHead::parse(&input, CAP) {
                assert!(used <= MAX_LEN && used <= input.len());
            }
            if let Ok(Some((instruction, used))) = DecoderInstruction::parse(&input) {
                assert!(used <= MAX_LEN && used <= input.len());
                let mut out = Vec::new();
                assert_eq!(instruction.encode(&mut out), Some(()));
                assert_eq!(
                    DecoderInstruction::parse(&out),
                    Ok(Some((instruction, out.len())))
                );
            }
            let verdict = encoder_verdict(&input);
            assert!(matches!(verdict, Ok(0) | Err(_)));
            if input.len() >= MAX_LEN {
                assert!(verdict.is_err(), "{input:?}");
            }
            let mut receiver = DecoderStreamReceiver;
            if let Ok(used) = receiver.feed(&input) {
                assert!(used <= input.len());
            }
        }
    }
}
