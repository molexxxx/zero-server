//! The Capsule Protocol over the data stream of a request: the concatenated
//! payloads of its DATA frames (RFC 9297 Section 3.1).
//!
//! A capsule is a Type, a Length and Length octets of Value (Section 3.2).
//! The decoder holds a DATAGRAM capsule (Section 3.5) whole when its payload
//! is within the configured limit, and hands every other capsule out in
//! pieces without buffering it:
//!
//! - "Endpoints that receive a Capsule with an unknown Capsule Type MUST
//!   silently drop that Capsule and skip over it to parse the next Capsule."
//!   (Section 3.2); the reserved types 0x29 * N + 0x17 are unknown types
//!   (Section 5.4), and the skipped value is handed out so an intermediary
//!   can forward it;
//! - a DATAGRAM capsule "so large as to not be usable" is discarded "without
//!   buffering its contents into memory" (Section 3.5);
//! - a stream that ends cleanly inside a capsule is a malformed message
//!   (Section 3.3), which in HTTP/3 is a stream error of type
//!   H3_MESSAGE_ERROR (RFC 9114 Section 4.1.2); before the end, a partial
//!   capsule only waits for more octets.
//!
//! Types and lengths are accepted in any encoding length (RFC 9297 Section
//! 1.1). The Capsule-Protocol header field and the message rules of Section
//! 3.2 belong to the HTTP/3 layer that reads the field section.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-3>

use alloc::vec::Vec;

use crate::error::Error;
use crate::varint;

/// The DATAGRAM capsule type (RFC 9297 Section 3.5).
pub const DATAGRAM: u64 = 0x00;

/// Whether `value` has the reserved capsule type form 0x29 * N + 0x17 and
/// fits a variable-length integer.
///
/// # Arguments
///
/// * `value` - the capsule type.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-5.4>
#[must_use]
pub const fn is_reserved_capsule_type(value: u64) -> bool {
    if value > varint::MAX {
        return false;
    }
    match value.checked_sub(0x17) {
        Some(offset) => matches!(offset.checked_rem(0x29), Some(0)),
        None => false,
    }
}

/// One step of the Capsule Protocol.
///
/// A skipped capsule follows one sequence: its `Skipped` step, then `Value`
/// pieces whose lengths sum to its Length, the last and only the last with
/// `end` set. A capsule with Length 0 yields exactly one empty piece with
/// `end` set, returned by the next call even when that call's input is empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapsuleStep<'a> {
    /// The input ends inside a capsule header or inside a DATAGRAM capsule
    /// held whole; `consumed` octets were used and the rest must be presented
    /// again with more octets after it.
    NeedMore {
        /// The input octets used.
        consumed: usize,
    },
    /// A whole DATAGRAM capsule within the limit.
    Datagram {
        /// The HTTP Datagram Payload, borrowed from the input; it may be
        /// empty.
        payload: &'a [u8],
        /// The input octets used: the header and the payload.
        consumed: usize,
    },
    /// The header of a capsule of an unknown type, or of a DATAGRAM capsule
    /// above the limit; its value follows as [`CapsuleStep::Value`] steps.
    Skipped {
        /// The capsule type.
        capsule_type: u64,
        /// The value length.
        len: u64,
        /// The input octets used: the header.
        consumed: usize,
    },
    /// Octets of a skipped capsule's value, handed out so an intermediary can
    /// forward them.
    Value {
        /// The value octets, borrowed from the input.
        data: &'a [u8],
        /// The input octets used.
        consumed: usize,
        /// Whether the piece completes the capsule.
        end: bool,
    },
}

/// Where the decoder is in the capsule sequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CapsuleState {
    /// At the start of a capsule.
    Header,
    /// Inside a skipped value with this many octets left; zero for a
    /// Length-0 capsule that still owes its end piece.
    Value(u64),
}

/// A streaming decoder of the capsules on one request stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapsuleDecoder {
    max_datagram: u64,
    state: CapsuleState,
}

impl CapsuleDecoder {
    /// Creates a decoder at the start of the data stream.
    ///
    /// # Arguments
    ///
    /// * `max_datagram` - the largest DATAGRAM payload held whole; a longer
    ///   DATAGRAM capsule is skipped (RFC 9297 Section 3.5).
    #[must_use]
    pub const fn new(max_datagram: u64) -> Self {
        Self {
            max_datagram,
            state: CapsuleState::Header,
        }
    }

    /// Decodes as much of `input` as one step allows; drop the consumed
    /// prefix and call again with the rest, extended by new octets.
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed octets of the data stream.
    ///
    /// # Returns
    ///
    /// The step, which borrows `input`. Decoding never fails: every octet
    /// string is a valid prefix of a capsule sequence.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-3.2>
    pub fn decode<'a>(&mut self, input: &'a [u8]) -> CapsuleStep<'a> {
        match self.state {
            CapsuleState::Header => self.capsule(input),
            CapsuleState::Value(remaining) => self.piece(input, remaining),
        }
    }

    /// Checks a clean end of the stream.
    ///
    /// # Arguments
    ///
    /// * `unconsumed` - the octets left over that no step consumed.
    ///
    /// # Errors
    ///
    /// [`Error::CapsuleTruncated`] when the stream ended inside a capsule.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-3.3>
    pub const fn finish(&self, unconsumed: &[u8]) -> Result<(), Error> {
        let inside = matches!(self.state, CapsuleState::Value(remaining) if remaining > 0);
        if inside || !unconsumed.is_empty() {
            return Err(Error::CapsuleTruncated);
        }
        Ok(())
    }

    /// Reads the capsule at the start of `input`.
    fn capsule<'a>(&mut self, input: &'a [u8]) -> CapsuleStep<'a> {
        let Some((capsule_type, type_len)) = varint::decode(input) else {
            return CapsuleStep::NeedMore { consumed: 0 };
        };
        let Some((len, len_len)) = varint::decode(input.get(type_len..).unwrap_or(&[])) else {
            return CapsuleStep::NeedMore { consumed: 0 };
        };
        let header_len = type_len.saturating_add(len_len);
        if capsule_type == DATAGRAM && len <= self.max_datagram {
            let total = u64::try_from(header_len)
                .unwrap_or(u64::MAX)
                .saturating_add(len);
            let available = u64::try_from(input.len()).unwrap_or(u64::MAX);
            if available < total {
                return CapsuleStep::NeedMore { consumed: 0 };
            }
            let total = usize::try_from(total).map_or(input.len(), |total| total.min(input.len()));
            return CapsuleStep::Datagram {
                payload: input.get(header_len..total).unwrap_or(&[]),
                consumed: total,
            };
        }
        self.state = CapsuleState::Value(len);
        CapsuleStep::Skipped {
            capsule_type,
            len,
            consumed: header_len,
        }
    }

    /// Hands out the next piece of a skipped value.
    fn piece<'a>(&mut self, input: &'a [u8], remaining: u64) -> CapsuleStep<'a> {
        if remaining > 0 && input.is_empty() {
            return CapsuleStep::NeedMore { consumed: 0 };
        }
        let available = u64::try_from(input.len()).unwrap_or(u64::MAX);
        let take = remaining.min(available);
        let len = usize::try_from(take).map_or(input.len(), |take| take.min(input.len()));
        let left = remaining.saturating_sub(take);
        self.state = if left == 0 {
            CapsuleState::Header
        } else {
            CapsuleState::Value(left)
        };
        CapsuleStep::Value {
            data: input.get(..len).unwrap_or(&[]),
            consumed: len,
            end: left == 0,
        }
    }
}

/// Appends a capsule: Type, Length and Value, the integers in the shortest
/// encoding.
///
/// # Arguments
///
/// * `capsule_type` - the capsule type.
/// * `value` - the capsule value.
/// * `out` - the buffer the capsule is appended to.
///
/// # Returns
///
/// `None` when the type or the length exceeds 2^62-1, in which case `out`
/// is unchanged.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-3.2>
pub fn encode_capsule(capsule_type: u64, value: &[u8], out: &mut Vec<u8>) -> Option<()> {
    let len = u64::try_from(value.len()).ok()?;
    varint::encoded_len(capsule_type)?;
    varint::encoded_len(len)?;
    varint::push(capsule_type, out)?;
    varint::push(len, out)?;
    out.extend_from_slice(value);
    Some(())
}

/// Appends a DATAGRAM capsule carrying `payload`.
///
/// # Arguments
///
/// * `payload` - the HTTP Datagram Payload, which may be empty.
/// * `out` - the buffer the capsule is appended to.
///
/// # Returns
///
/// `None` when the payload is longer than 2^62-1 octets, in which case `out`
/// is unchanged.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-3.5>
pub fn encode_datagram_capsule(payload: &[u8], out: &mut Vec<u8>) -> Option<()> {
    encode_capsule(DATAGRAM, payload, out)
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        encode_capsule, encode_datagram_capsule, is_reserved_capsule_type, CapsuleDecoder,
        CapsuleStep, DATAGRAM,
    };
    use crate::datagram::Datagram;
    use crate::error::{Error, ErrorCode, Scope};
    use crate::varint;
    use crate::xorshift::{iterations, unhex, Rng};

    /// A decoded capsule, owned so whole and split runs can be compared.
    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Event {
        Datagram(Vec<u8>),
        Skipped(u64, u64),
    }

    /// Decodes `input` presented in pieces cut at `cuts`, checking the step
    /// sequence of every skipped capsule, then checks the end when `fin`.
    fn run(
        max_datagram: u64,
        input: &[u8],
        cuts: &[usize],
        fin: bool,
    ) -> (Vec<Event>, Result<(), Error>, bool) {
        let mut decoder = CapsuleDecoder::new(max_datagram);
        let mut pending: Vec<u8> = Vec::new();
        let mut events = Vec::new();
        let mut open: Option<u64> = None;
        let mut start = 0usize;
        for cut in cuts.iter().copied().chain(core::iter::once(input.len())) {
            let cut = cut.clamp(start, input.len());
            pending.extend_from_slice(input.get(start..cut).unwrap_or(&[]));
            start = cut;
            loop {
                let (consumed, more) = match decoder.decode(&pending) {
                    CapsuleStep::NeedMore { consumed } => (consumed, false),
                    CapsuleStep::Datagram { payload, consumed } => {
                        assert_eq!(open, None);
                        events.push(Event::Datagram(payload.to_vec()));
                        (consumed, true)
                    }
                    CapsuleStep::Skipped {
                        capsule_type,
                        len,
                        consumed,
                    } => {
                        assert_eq!(open, None);
                        open = Some(len);
                        events.push(Event::Skipped(capsule_type, len));
                        (consumed, true)
                    }
                    CapsuleStep::Value {
                        data,
                        consumed,
                        end,
                    } => {
                        let remaining = open.unwrap_or(0);
                        let len = u64::try_from(data.len()).unwrap_or(u64::MAX);
                        assert!(len <= remaining);
                        let left = remaining.saturating_sub(len);
                        assert_eq!(end, left == 0);
                        open = (!end).then_some(left);
                        (consumed, true)
                    }
                };
                pending.drain(..consumed.min(pending.len()));
                if !more {
                    break;
                }
            }
        }
        let outcome = if fin {
            decoder.finish(&pending)
        } else {
            Ok(())
        };
        let waiting = !pending.is_empty() || open.is_some();
        (events, outcome, waiting)
    }

    /// Decodes whole and one octet at a time, asserting both agree.
    fn decode(max_datagram: u64, input: &[u8], fin: bool) -> (Vec<Event>, Result<(), Error>, bool) {
        let whole = run(max_datagram, input, &[], fin);
        let cuts: Vec<usize> = (1..input.len()).collect();
        assert_eq!(whole, run(max_datagram, input, &cuts, fin), "{input:02x?}");
        whole
    }

    /// RFC 9297 Section 3.2: "Endpoints that receive a Capsule with an unknown
    /// Capsule Type MUST silently drop that Capsule and skip over it to parse
    /// the next Capsule."
    #[test]
    fn a_capsule_of_unknown_type_is_dropped_and_the_next_capsule_parsed() {
        let cases: [(&str, u64, u64); 4] = [
            ("1702abcd000101", 0x17, 2),
            ("4040 03 aabbcc 000101", 0x40, 3),
            ("01 01 ff 000101", 0x01, 1),
            ("1700000101", 0x17, 0),
        ];
        for (hex, capsule_type, len) in cases {
            let (events, outcome, _) = decode(1_200, &unhex(hex), true);
            assert_eq!(
                events,
                [
                    Event::Skipped(capsule_type, len),
                    Event::Datagram(alloc::vec![0x01])
                ],
                "{hex}"
            );
            assert_eq!(outcome, Ok(()));
        }
        for reserved in [0x17u64, 0x40, 0x69, 0x92] {
            assert!(is_reserved_capsule_type(reserved), "{reserved}");
        }
        for other in [DATAGRAM, 0x01, 0x16, 0x18, 0x41, varint::MAX, u64::MAX] {
            assert!(!is_reserved_capsule_type(other), "{other}");
        }
        let mut decoder = CapsuleDecoder::new(1_200);
        assert_eq!(
            decoder.decode(&unhex("1700")),
            CapsuleStep::Skipped {
                capsule_type: 0x17,
                len: 0,
                consumed: 2
            }
        );
        assert_eq!(
            decoder.decode(&[]),
            CapsuleStep::Value {
                data: &[],
                consumed: 0,
                end: true
            }
        );
        assert_eq!(decoder.decode(&[]), CapsuleStep::NeedMore { consumed: 0 });
    }

    /// RFC 9297 Section 3.3: "If the receive side of a stream carrying
    /// Capsules is terminated cleanly (for example, in HTTP/3 this is defined
    /// as receiving a QUIC STREAM frame with the FIN bit set) and the last
    /// Capsule on the stream was truncated, this MUST be treated as if it were
    /// a malformed or incomplete message."
    #[test]
    fn a_capsule_truncated_at_a_clean_end_of_stream_is_a_malformed_message() {
        for hex in ["000568", "00", "40", "1705ab", "000101 0002aa"] {
            let input = unhex(hex);
            let (_, outcome, _) = decode(1_200, &input, true);
            assert_eq!(outcome, Err(Error::CapsuleTruncated), "{hex}");
            assert_eq!(Error::CapsuleTruncated.code(), ErrorCode::H3_MESSAGE_ERROR);
            assert_eq!(Error::CapsuleTruncated.scope(), Scope::Stream);
            let (_, outcome, waiting) = decode(1_200, &input, false);
            assert_eq!(outcome, Ok(()));
            assert!(waiting, "{hex}");
        }
        let (_, outcome, waiting) = decode(1_200, &unhex("000101"), true);
        assert_eq!(outcome, Ok(()));
        assert!(!waiting);
        assert_eq!(CapsuleDecoder::new(0).finish(&[]), Ok(()));
    }

    /// RFC 9297 Section 3.5: "HTTP Datagram Payload: The payload of the
    /// datagram, whose semantics are defined by the extension that is using
    /// HTTP Datagrams. Note that this field can be empty."
    #[test]
    fn the_datagram_capsule_carries_the_whole_value_as_its_payload_even_when_empty() {
        let mut out = Vec::new();
        assert_eq!(encode_datagram_capsule(b"hel", &mut out), Some(()));
        assert_eq!(out, unhex("000368656c"));
        let (events, outcome, _) = decode(1_200, &out, true);
        assert_eq!(events, [Event::Datagram(b"hel".to_vec())]);
        assert_eq!(outcome, Ok(()));
        let mut empty = Vec::new();
        assert_eq!(encode_datagram_capsule(b"", &mut empty), Some(()));
        assert_eq!(empty, unhex("0000"));
        let (events, outcome, _) = decode(0, &empty, true);
        assert_eq!(events, [Event::Datagram(Vec::new())]);
        assert_eq!(outcome, Ok(()));
        let mut decoder = CapsuleDecoder::new(1_200);
        assert_eq!(
            decoder.decode(&unhex("000368656c0000")),
            CapsuleStep::Datagram {
                payload: b"hel",
                consumed: 5
            }
        );
    }

    /// RFC 9297 Section 3.5: "If an incoming DATAGRAM Capsule has a length that
    /// is known to be so large as to not be usable, the implementation SHOULD
    /// discard the Capsule without buffering its contents into memory."
    #[test]
    fn a_datagram_capsule_too_large_to_use_is_discarded_without_buffering() {
        let input = unhex("0003010203");
        let (events, outcome, _) = decode(2, &input, true);
        assert_eq!(events, [Event::Skipped(DATAGRAM, 3)]);
        assert_eq!(outcome, Ok(()));
        let (events, _, _) = decode(3, &input, true);
        assert_eq!(events, [Event::Datagram(alloc::vec![1, 2, 3])]);
        let mut decoder = CapsuleDecoder::new(1_200);
        let huge = unhex("00c0000000ffffffff");
        assert_eq!(
            decoder.decode(&huge),
            CapsuleStep::Skipped {
                capsule_type: DATAGRAM,
                len: 0xFFFF_FFFF,
                consumed: 9
            }
        );
        assert_eq!(
            decoder.decode(&[7, 7]),
            CapsuleStep::Value {
                data: &[7, 7],
                consumed: 2,
                end: false
            }
        );
        assert_eq!(decoder.finish(&[]), Err(Error::CapsuleTruncated));
    }

    /// RFC 9297 Section 1.1: "Integer values do not need to be encoded on the
    /// minimum number of bytes necessary."
    #[test]
    fn capsule_and_datagram_integers_need_not_use_the_minimum_number_of_bytes() {
        let (events, outcome, _) = decode(1_200, &unhex("40004001ff"), true);
        assert_eq!(events, [Event::Datagram(alloc::vec![0xFF])]);
        assert_eq!(outcome, Ok(()));
        let (events, _, _) = decode(1_200, &unhex("8000001780000001aa"), true);
        assert_eq!(events, [Event::Skipped(0x17, 1)]);
        let datagram = unhex("4001abcd");
        assert_eq!(
            Datagram::parse(&datagram),
            Ok(Datagram {
                quarter_stream_id: 1,
                payload: &[0xAB, 0xCD]
            })
        );
        assert_eq!(
            Datagram::parse(&unhex("c000000000000002")).map(|datagram| datagram.stream_id()),
            Ok(Some(8))
        );
    }

    /// RFC 9297 Section 3.2: the Capsule Type and Capsule Length are
    /// variable-length integers (RFC 9000 Section 16, at most 2^62-1), so a
    /// larger type is never written and 2^62-1 itself is.
    #[test]
    fn capsule_encoders_refuse_values_above_2_62_minus_1_and_leave_the_buffer_unchanged() {
        let mut out = alloc::vec![5u8];
        assert_eq!(
            encode_capsule(varint::MAX.saturating_add(1), b"x", &mut out),
            None
        );
        assert_eq!(out, [5u8]);
        assert_eq!(encode_capsule(varint::MAX, b"", &mut out), Some(()));
        assert_eq!(out, unhex("05ffffffffffffffff00"));
    }

    /// RFC 9297 Section 3.2: "Endpoints that receive a Capsule with an unknown
    /// Capsule Type MUST silently drop that Capsule and skip over it to parse
    /// the next Capsule."; random sequences of DATAGRAM and other capsules
    /// decode the same whatever the split points.
    #[test]
    fn random_capsule_sequences_decode_the_same_whole_and_split_at_random_points() {
        let mut rng = Rng::new(0x5EED_000F);
        for _ in 0..iterations(2_000) {
            let max_datagram = rng.below(24);
            let mut input = Vec::new();
            let mut expected = Vec::new();
            for _ in 0..rng.index(6) {
                let value = rng.bytes(32);
                let len = u64::try_from(value.len()).unwrap_or(0);
                let capsule_type = if rng.below(2) == 0 {
                    DATAGRAM
                } else {
                    rng.varint()
                };
                assert_eq!(encode_capsule(capsule_type, &value, &mut input), Some(()));
                if capsule_type == DATAGRAM && len <= max_datagram {
                    expected.push(Event::Datagram(value));
                } else {
                    expected.push(Event::Skipped(capsule_type, len));
                }
            }
            let whole = run(max_datagram, &input, &[], true);
            assert_eq!(whole, (expected, Ok(()), false));
            let mut cuts: Vec<usize> = (0..rng.index(8))
                .map(|_| rng.index(input.len().saturating_add(1)))
                .collect();
            cuts.sort_unstable();
            assert_eq!(
                run(max_datagram, &input, &cuts, true),
                whole,
                "{input:02x?} cut at {cuts:?}"
            );
        }
    }

    /// RFC 9297 Section 3.2, Figure 3: arbitrary octets read as a Capsule
    /// Protocol data stream never panic the decoder.
    #[test]
    fn arbitrary_octets_never_panic_the_capsule_decoder() {
        let mut rng = Rng::new(0x5EED_0010);
        for _ in 0..iterations(5_000) {
            let input = rng.bytes(40);
            let max_datagram = rng.below(48);
            let _ = decode(max_datagram, &input, true);
        }
    }
}
