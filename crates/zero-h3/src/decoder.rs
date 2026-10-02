//! The streaming frame decoder of one HTTP/3 stream.
//!
//! The decoder reads the frames of a control, request or push stream from
//! the caller's buffer and keeps no octets of its own. It holds a frame whole
//! only when its payload is small and needed at once (HEADERS, PUSH_PROMISE,
//! SETTINGS, CANCEL_PUSH, GOAWAY, MAX_PUSH_ID), and hands every other payload
//! out in pieces as it arrives: DATA, the unknown and reserved types it skips,
//! and a HEADERS or PUSH_PROMISE longer than its hold limit. A frame header
//! is checked as soon as it is complete, in this order, the first failing
//! rule deciding:
//!
//! 1. on the control stream, a first frame other than SETTINGS is
//!    H3_MISSING_SETTINGS, unknown types included (RFC 9114 Sections 6.2.1
//!    and 9);
//! 2. the types reserved from HTTP/2 are H3_FRAME_UNEXPECTED (Section
//!    7.2.8);
//! 3. a known type on a stream Table 1 of Section 7 does not allow it on is
//!    H3_FRAME_UNEXPECTED (Sections 7.2.1 to 7.2.7, and 4.1 for PUSH_PROMISE
//!    on a push stream; GOAWAY for any endpoint per verified erratum 7780);
//! 4. PUSH_PROMISE received by a server and MAX_PUSH_ID received by a client
//!    are H3_FRAME_UNEXPECTED (Sections 7.2.5 and 7.2.7);
//! 5. a second SETTINGS on the control stream is H3_FRAME_UNEXPECTED
//!    (Section 7.2.4);
//! 6. on a request or push stream, DATA before HEADERS, HEADERS or DATA
//!    after the trailers, and after a CONNECT completed any known type but
//!    DATA, are H3_FRAME_UNEXPECTED (Sections 4.1 and 4.4); on a stream a
//!    client reads, the trailers are known only as a HEADERS frame after
//!    DATA, or after the final response once
//!    [`FrameDecoder::final_response`] marks it (see [`Role::Client`]);
//! 7. the length rules: a payload that cannot hold its fields or holds more
//!    is H3_FRAME_ERROR (Sections 7.1 and 10.8), a SETTINGS frame beyond
//!    its local limit H3_EXCESSIVE_LOAD (Section 10.5).
//!
//! Unknown types, the reserved 0x1f * N + 0x21 types among them, are skipped
//! by their Length on every stream (Section 9). Frame types and lengths are
//! accepted in any encoding length (RFC 9000 Section 16).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.1>

use crate::error::Error;
use crate::frame::{Frame, FrameHeader, FrameType};
use crate::settings::Settings;
use crate::varint;

/// The stream a decoder reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    /// The peer's control stream, after its 0x00 stream type.
    Control,
    /// A request stream: a client-initiated bidirectional stream.
    Request,
    /// A push stream, after its stream type and push ID.
    Push,
}

/// The local endpoint, which receives the frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// A client, which reads responses and the server's control stream.
    ///
    /// RFC 9114 Section 4.1: "A server sends zero or more interim HTTP
    /// responses on the same stream as the request, followed by a single
    /// final HTTP response", each with its own HEADERS frame, and an interim
    /// HEADERS differs from the final one only in its decoded `:status`, which
    /// this crate never sees. So on a stream a client reads, the decoder
    /// takes every HEADERS before DATA as a possible interim response and
    /// enforces "a HEADERS or DATA frame after the trailing HEADERS frame, is
    /// considered invalid" only for a HEADERS frame that follows DATA, until
    /// the caller reports the final response with
    /// [`FrameDecoder::final_response`]; from then on the next HEADERS is the
    /// trailer section and any frame of the message after it is
    /// H3_FRAME_UNEXPECTED. Whether a final response arrived at all is the
    /// caller's to check.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.1>
    Client,
    /// A server, which reads requests and the client's control stream.
    Server,
}

/// The payload limits of the frames the decoder holds whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameLimits {
    /// The largest HEADERS payload held whole; PUSH_PROMISE gets 8 more for
    /// its push ID. A longer frame is skipped and reported as
    /// [`Step::Oversized`].
    pub field_section: u64,
    /// The largest SETTINGS payload accepted; a longer one is
    /// H3_EXCESSIVE_LOAD.
    pub settings: u64,
}

/// The SETTINGS payload limit: a local bound under RFC 9114 Section 10.5.
pub const SETTINGS_PAYLOAD_LIMIT: u64 = 4_096;

/// The longest frame header, as a payload-domain count.
const HEADER_BOUND: u64 = 16;

/// The longest push ID of a PUSH_PROMISE.
const PUSH_ID_BOUND: u64 = 8;

/// The longest encoded field section whose decoded size can be within
/// `max_field_section_size`: 4 * max + 20, saturating.
///
/// A field line of an encoded section takes at most 22 octets of framing and
/// at most 3.75 octets per name and value octet, the longest Huffman code
/// being 30 bits, while RFC 9114 Section 4.2.2 counts it as name + value +
/// 32; the section prefix takes at most 20 octets. So a section longer than
/// this bound decodes to more than the limit.
///
/// # Arguments
///
/// * `max_field_section_size` - the advertised SETTINGS_MAX_FIELD_SECTION_SIZE.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.2.2>
#[must_use]
pub const fn encoded_field_section_bound(max_field_section_size: u64) -> u64 {
    max_field_section_size.saturating_mul(4).saturating_add(20)
}

/// The smaller of two values.
const fn min(a: u64, b: u64) -> u64 {
    if a < b {
        a
    } else {
        b
    }
}

impl FrameLimits {
    /// The limits that follow from the configured HTTP/3 limits: the field
    /// section bound of the advertised SETTINGS_MAX_FIELD_SECTION_SIZE and
    /// [`SETTINGS_PAYLOAD_LIMIT`], each capped so that a frame held whole,
    /// with its header and a PUSH_PROMISE push ID, fits in one stream's
    /// flow-control window. The decoder consumes nothing of a held frame
    /// until it is whole, so a longer one could never complete.
    ///
    /// A section the cap refuses may be within the advertised limit. RFC
    /// 9114 Section 4.2.2 lets an endpoint set what it accepts below that
    /// value: "An HTTP/3 implementation MAY impose a limit on the maximum
    /// size of the message header it will accept on an individual HTTP
    /// message", and Section 10.5.1 says of SETTINGS_MAX_FIELD_SECTION_SIZE
    /// "This setting is only advisory". A refused section is reported as
    /// [`Step::Oversized`], so a server can still answer 431.
    ///
    /// # Arguments
    ///
    /// * `limits` - the configured HTTP/3 limits.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.2.2>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-10.5>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-10.5.1>
    #[must_use]
    pub const fn from_limits(limits: &zero_limits::Http3Limits) -> Self {
        let window = limits.stream_data;
        Self {
            field_section: min(
                encoded_field_section_bound(limits.max_field_section_size),
                window
                    .saturating_sub(HEADER_BOUND)
                    .saturating_sub(PUSH_ID_BOUND),
            ),
            settings: min(SETTINGS_PAYLOAD_LIMIT, window.saturating_sub(HEADER_BOUND)),
        }
    }

    /// `from_limits(&Http3Limits::DEFAULT)`: field_section 131,092, below the
    /// window cap of 262,144 - 24 = 262,120, and settings 4,096.
    pub const DEFAULT: Self = Self::from_limits(&zero_limits::Http3Limits::DEFAULT);
}

impl Default for FrameLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// One step of decoding.
///
/// A streamed payload follows one sequence: its header step (a `Data` step
/// with no octets and `end` false for DATA, `Skipped` or `Oversized`
/// otherwise), then pieces (`Data` for DATA, `Discarded` otherwise) whose
/// lengths sum to the frame Length, the last and only the last with `end`
/// set. A frame with Length 0 yields exactly one empty piece with `end` set,
/// returned by the next call even when that call's input is empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step<'a> {
    /// The input ends inside a frame header or inside a frame held whole;
    /// `consumed` octets were used and the rest must be presented again with
    /// more octets after it.
    NeedMore {
        /// The input octets used.
        consumed: usize,
    },
    /// A whole frame, borrowed from the input.
    Frame {
        /// The frame.
        frame: Frame<'a>,
        /// The input octets used: the header and the payload.
        consumed: usize,
    },
    /// The header step of a DATA frame, or a piece of its payload as it
    /// arrives.
    Data {
        /// The payload octets, borrowed from the input; empty for the header
        /// step.
        data: &'a [u8],
        /// The input octets used.
        consumed: usize,
        /// Whether the piece completes the frame.
        end: bool,
    },
    /// The header of an unknown or reserved frame type; its payload follows
    /// as [`Step::Discarded`] steps.
    Skipped {
        /// The frame type.
        frame_type: FrameType,
        /// The payload length.
        len: u64,
        /// The input octets used: the header.
        consumed: usize,
    },
    /// The header of a HEADERS or PUSH_PROMISE frame longer than
    /// [`FrameLimits::field_section`]; its payload follows as
    /// [`Step::Discarded`] steps, and a server can answer 431 (RFC 9114
    /// Section 4.2.2). The message sequence advances as for a HEADERS frame.
    Oversized {
        /// The frame type.
        frame_type: FrameType,
        /// The payload length.
        len: u64,
        /// The input octets used: the header.
        consumed: usize,
    },
    /// Payload octets of a skipped or oversized frame, handed out so an
    /// intermediary can forward them.
    Discarded {
        /// The payload octets, borrowed from the input.
        data: &'a [u8],
        /// The input octets used.
        consumed: usize,
        /// Whether the piece completes the frame.
        end: bool,
    },
}

/// Where the decoder is in the frames of the stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// At the start of a frame.
    Header,
    /// Inside a DATA payload with this many octets left; zero for a Length-0
    /// frame that still owes its end piece.
    Data(u64),
    /// Inside a skipped or oversized payload, likewise.
    Discard(u64),
}

/// The frame sequence rules of the stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sequence {
    /// A control stream before its SETTINGS frame.
    AwaitSettings,
    /// A control stream after its SETTINGS frame.
    Control,
    /// A message stream before its first HEADERS frame.
    Start,
    /// On a stream a client reads, after a HEADERS frame that may be an
    /// interim response and before any DATA.
    Interim,
    /// After the HEADERS frame of the request or the final response and
    /// before any DATA.
    Header,
    /// After DATA.
    Body,
    /// After the trailing HEADERS frame.
    Trailers,
    /// After a CONNECT completed.
    Tunnel,
}

/// A streaming decoder of the frames on one stream.
///
/// # Examples
///
/// ```
/// use zero_h3::{FrameDecoder, FrameLimits, Role, Settings, Step, StreamKind};
/// use zero_limits::Http3Limits;
///
/// let mut stream = Vec::new();
/// let settings = Settings::server(&Http3Limits::DEFAULT);
/// assert_eq!(settings.encode(None, &mut stream), Some(()));
/// let mut decoder = FrameDecoder::new(StreamKind::Control, Role::Client, FrameLimits::DEFAULT);
/// let Ok(Step::Frame { frame, consumed }) = decoder.decode(&stream) else {
///     unreachable!("a whole SETTINGS frame");
/// };
/// assert_eq!(frame, zero_h3::Frame::Settings(settings));
/// assert_eq!(consumed, stream.len());
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameDecoder {
    kind: StreamKind,
    role: Role,
    limits: FrameLimits,
    state: State,
    sequence: Sequence,
}

impl FrameDecoder {
    /// Creates a decoder at the start of a stream's frames.
    ///
    /// # Arguments
    ///
    /// * `kind` - the stream the frames arrive on.
    /// * `role` - the local endpoint, which receives them.
    /// * `limits` - the payload limits of the frames held whole.
    #[must_use]
    pub const fn new(kind: StreamKind, role: Role, limits: FrameLimits) -> Self {
        Self {
            kind,
            role,
            limits,
            state: State::Header,
            sequence: match kind {
                StreamKind::Control => Sequence::AwaitSettings,
                StreamKind::Request | StreamKind::Push => Sequence::Start,
            },
        }
    }

    /// Decodes as much of `input` as one step allows, with the calling
    /// convention of `zero_http1::ChunkedDecoder::decode`.
    ///
    /// # Arguments
    ///
    /// * `input` - the unconsumed octets of the stream; after a step, drop
    ///   the consumed prefix and call again with the rest, extended by new
    ///   octets.
    ///
    /// # Returns
    ///
    /// The step, which borrows `input`.
    ///
    /// # Errors
    ///
    /// Every [`Error`] the module lists for frames: a header that breaks a
    /// stream, role, sequence or length rule, or a payload whose fields do
    /// not match its Length. The decoder is unchanged by a failed call.
    pub fn decode<'a>(&mut self, input: &'a [u8]) -> Result<Step<'a>, Error> {
        match self.state {
            State::Header => self.frame(input),
            State::Data(remaining) => Ok(self.piece(input, remaining, true)),
            State::Discard(remaining) => Ok(self.piece(input, remaining, false)),
        }
    }

    /// Marks a CONNECT request stream as established: from now on only DATA
    /// and unknown frame types are accepted (RFC 9114 Section 4.4). It has
    /// no effect on a control stream.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.4>
    pub const fn tunnel(&mut self) {
        if !matches!(self.kind, StreamKind::Control) {
            self.sequence = Sequence::Tunnel;
        }
    }

    /// Marks the HEADERS frame just decoded on a stream a client reads as
    /// the final response, once the caller has decoded a `:status` outside
    /// 1xx: the next HEADERS frame is then the trailer section, and a
    /// HEADERS or DATA frame after it is H3_FRAME_UNEXPECTED (RFC 9114
    /// Section 4.1). It has no effect anywhere else: on a stream a server
    /// reads, where the first HEADERS frame is always the request's header
    /// section, after DATA, or before any HEADERS frame.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.1>
    pub const fn final_response(&mut self) {
        if matches!(self.sequence, Sequence::Interim) {
            self.sequence = Sequence::Header;
        }
    }

    /// Checks a clean end of the stream.
    ///
    /// On a stream a client reads, a clean end at a frame boundary is
    /// accepted whatever HEADERS frames came before it: only the caller, which
    /// decodes `:status`, knows whether a final response arrived (see
    /// [`Role::Client`]).
    ///
    /// # Arguments
    ///
    /// * `unconsumed` - the octets left over that no step consumed.
    ///
    /// # Errors
    ///
    /// [`Error::CriticalStreamClosed`] for the control stream, whatever its
    /// state; [`Error::StreamEndedInFrame`] inside a frame or with octets
    /// left over; [`Error::RequestIncomplete`] for a request stream a server
    /// reads that ended before any HEADERS frame.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-6.2.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-4.1>
    pub const fn finish(&self, unconsumed: &[u8]) -> Result<(), Error> {
        if matches!(self.kind, StreamKind::Control) {
            return Err(Error::CriticalStreamClosed { stream_type: 0x00 });
        }
        let inside = match self.state {
            State::Header => false,
            State::Data(remaining) | State::Discard(remaining) => remaining > 0,
        };
        if inside || !unconsumed.is_empty() {
            return Err(Error::StreamEndedInFrame);
        }
        if matches!(
            (self.kind, self.role, self.sequence),
            (StreamKind::Request, Role::Server, Sequence::Start)
        ) {
            return Err(Error::RequestIncomplete);
        }
        Ok(())
    }

    /// Hands out the next piece of a streamed payload.
    fn piece<'a>(&mut self, input: &'a [u8], remaining: u64, data: bool) -> Step<'a> {
        if remaining > 0 && input.is_empty() {
            return Step::NeedMore { consumed: 0 };
        }
        let available = u64::try_from(input.len()).unwrap_or(u64::MAX);
        let take = remaining.min(available);
        let len = usize::try_from(take).map_or(input.len(), |take| take.min(input.len()));
        let piece = input.get(..len).unwrap_or(&[]);
        let left = remaining.saturating_sub(take);
        let end = left == 0;
        self.state = match (end, data) {
            (true, _) => State::Header,
            (false, true) => State::Data(left),
            (false, false) => State::Discard(left),
        };
        if data {
            Step::Data {
                data: piece,
                consumed: len,
                end,
            }
        } else {
            Step::Discarded {
                data: piece,
                consumed: len,
                end,
            }
        }
    }

    /// Reads the frame at the start of `input`.
    fn frame<'a>(&mut self, input: &'a [u8]) -> Result<Step<'a>, Error> {
        let Some(header) = FrameHeader::parse(input) else {
            return Ok(Step::NeedMore { consumed: 0 });
        };
        let frame_type = header.frame_type;
        let next = self.check(frame_type)?;
        let len = header.len;
        let consumed = header.header_len;
        if frame_type == FrameType::DATA {
            self.sequence = next;
            self.state = State::Data(len);
            return Ok(Step::Data {
                data: &[],
                consumed,
                end: false,
            });
        }
        if !frame_type.is_known() {
            self.state = State::Discard(len);
            return Ok(Step::Skipped {
                frame_type,
                len,
                consumed,
            });
        }
        let limit = match frame_type {
            FrameType::HEADERS => Some(self.limits.field_section),
            FrameType::PUSH_PROMISE => {
                Some(self.limits.field_section.saturating_add(PUSH_ID_BOUND))
            }
            _ => None,
        };
        if let Some(limit) = limit {
            if frame_type == FrameType::PUSH_PROMISE && len == 0 {
                return Err(Error::PayloadTruncated {
                    frame_type: frame_type.0,
                });
            }
            if len > limit {
                self.sequence = next;
                self.state = State::Discard(len);
                return Ok(Step::Oversized {
                    frame_type,
                    len,
                    consumed,
                });
            }
        }
        match frame_type {
            FrameType::SETTINGS if len > self.limits.settings => {
                return Err(Error::ExcessiveLoad {
                    frame_type: frame_type.0,
                    len,
                });
            }
            FrameType::CANCEL_PUSH | FrameType::GOAWAY | FrameType::MAX_PUSH_ID => {
                if len == 0 {
                    return Err(Error::PayloadTruncated {
                        frame_type: frame_type.0,
                    });
                }
                if len > PUSH_ID_BOUND {
                    return Err(Error::PayloadTrailing {
                        frame_type: frame_type.0,
                    });
                }
            }
            _ => {}
        }
        let total = u64::try_from(consumed)
            .unwrap_or(u64::MAX)
            .saturating_add(len);
        let available = u64::try_from(input.len()).unwrap_or(u64::MAX);
        if available < total {
            return Ok(Step::NeedMore { consumed: 0 });
        }
        let total = usize::try_from(total).map_or(input.len(), |total| total.min(input.len()));
        let payload = input.get(consumed..total).unwrap_or(&[]);
        let frame = payload_frame(frame_type, payload)?;
        self.sequence = next;
        Ok(Step::Frame {
            frame,
            consumed: total,
        })
    }

    /// Checks a frame type against the stream, role and sequence rules
    /// without changing the decoder.
    ///
    /// # Returns
    ///
    /// The sequence state once the frame is consumed.
    fn check(&self, frame_type: FrameType) -> Result<Sequence, Error> {
        let value = frame_type.0;
        if matches!(self.sequence, Sequence::AwaitSettings) && frame_type != FrameType::SETTINGS {
            return Err(Error::MissingSettings { frame_type: value });
        }
        if frame_type.is_reserved_http2() {
            return Err(Error::ReservedFrameType { frame_type: value });
        }
        if !frame_type.is_known() {
            return Ok(self.sequence);
        }
        let allowed = match self.kind {
            StreamKind::Control => matches!(
                frame_type,
                FrameType::CANCEL_PUSH
                    | FrameType::SETTINGS
                    | FrameType::GOAWAY
                    | FrameType::MAX_PUSH_ID
            ),
            StreamKind::Request => matches!(
                frame_type,
                FrameType::DATA | FrameType::HEADERS | FrameType::PUSH_PROMISE
            ),
            StreamKind::Push => matches!(frame_type, FrameType::DATA | FrameType::HEADERS),
        };
        if !allowed {
            return Err(Error::WrongStream {
                frame_type: value,
                stream: self.kind,
            });
        }
        if matches!(
            (frame_type, self.role),
            (FrameType::PUSH_PROMISE, Role::Server) | (FrameType::MAX_PUSH_ID, Role::Client)
        ) {
            return Err(Error::WrongRole { frame_type: value });
        }
        let out_of_sequence = Err(Error::OutOfSequence { frame_type: value });
        match (self.sequence, frame_type) {
            (Sequence::AwaitSettings, _) => Ok(Sequence::Control),
            (Sequence::Control, FrameType::SETTINGS) => Err(Error::SecondSettings),
            (Sequence::Start, FrameType::HEADERS) => Ok(match self.role {
                Role::Server => Sequence::Header,
                Role::Client => Sequence::Interim,
            }),
            (Sequence::Interim, FrameType::HEADERS) => Ok(Sequence::Interim),
            (Sequence::Header | Sequence::Body, FrameType::HEADERS) => Ok(Sequence::Trailers),
            (Sequence::Interim | Sequence::Header | Sequence::Body, FrameType::DATA) => {
                Ok(Sequence::Body)
            }
            (Sequence::Tunnel, FrameType::DATA) => Ok(Sequence::Tunnel),
            (Sequence::Start | Sequence::Trailers, FrameType::DATA)
            | (Sequence::Trailers | Sequence::Tunnel, FrameType::HEADERS)
            | (Sequence::Tunnel, _) => out_of_sequence,
            (sequence, _) => Ok(sequence),
        }
    }
}

/// Parses the payload of a frame held whole.
fn payload_frame(frame_type: FrameType, payload: &[u8]) -> Result<Frame<'_>, Error> {
    let truncated = Error::PayloadTruncated {
        frame_type: frame_type.0,
    };
    match frame_type {
        FrameType::SETTINGS => Settings::parse(payload).map(Frame::Settings),
        FrameType::PUSH_PROMISE => {
            let (push_id, len) = varint::decode(payload).ok_or(truncated)?;
            Ok(Frame::PushPromise {
                push_id,
                field_section: payload.get(len..).unwrap_or(&[]),
            })
        }
        FrameType::CANCEL_PUSH | FrameType::GOAWAY | FrameType::MAX_PUSH_ID => {
            let (value, len) = varint::decode(payload).ok_or(truncated)?;
            if len < payload.len() {
                return Err(Error::PayloadTrailing {
                    frame_type: frame_type.0,
                });
            }
            Ok(match frame_type {
                FrameType::CANCEL_PUSH => Frame::CancelPush { push_id: value },
                FrameType::GOAWAY => Frame::Goaway { id: value },
                _ => Frame::MaxPushId { push_id: value },
            })
        }
        _ => Ok(Frame::Headers {
            field_section: payload,
        }),
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        encoded_field_section_bound, FrameDecoder, FrameLimits, Role, Step, StreamKind,
        SETTINGS_PAYLOAD_LIMIT,
    };
    use crate::error::{Error, ErrorCode, Scope};
    use crate::frame::{
        encode_data_header, encode_reserved, Frame, FrameHeader, FrameType, MAX_HEADER_LEN,
    };
    use crate::settings::Settings;
    use crate::varint;
    use crate::xorshift::{iterations, unhex, Rng};
    use zero_limits::Http3Limits;

    /// A decoded frame, owned so whole and one-octet runs can be compared.
    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Event {
        Headers(Vec<u8>),
        CancelPush(u64),
        Settings(Settings),
        PushPromise(u64, Vec<u8>),
        Goaway(u64),
        MaxPushId(u64),
        Data(Vec<u8>),
        Skipped(u64, u64),
        Oversized(u64, u64),
    }

    /// How a run ended.
    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Outcome {
        Ok,
        NeedMore,
        Failed(Error),
    }

    /// A decoder driven over a buffer, checking the step sequence of every
    /// streamed payload.
    struct Run {
        decoder: FrameDecoder,
        pending: Vec<u8>,
        events: Vec<Event>,
        open: Option<(bool, u64)>,
        tunnel_after_headers: bool,
    }

    impl Run {
        fn new(
            kind: StreamKind,
            role: Role,
            limits: FrameLimits,
            tunnel_after_headers: bool,
        ) -> Self {
            Self {
                decoder: FrameDecoder::new(kind, role, limits),
                pending: Vec::new(),
                events: Vec::new(),
                open: None,
                tunnel_after_headers,
            }
        }

        /// Accounts for one piece of a streamed payload.
        fn piece(
            open: &mut Option<(bool, u64)>,
            events: &mut [Event],
            data: &[u8],
            end: bool,
            is_data: bool,
        ) {
            let Some((open_data, remaining)) = *open else {
                unreachable!("a piece outside a streamed payload");
            };
            assert_eq!(open_data, is_data);
            let len = u64::try_from(data.len()).unwrap_or(u64::MAX);
            assert!(len <= remaining, "{len} > {remaining}");
            let left = remaining.saturating_sub(len);
            assert_eq!(end, left == 0, "end must mark the last piece");
            *open = (!end).then_some((open_data, left));
            if is_data {
                if let Some(Event::Data(buffer)) = events.last_mut() {
                    buffer.extend_from_slice(data);
                }
            }
        }

        /// Decodes until the decoder needs more octets.
        fn pump(&mut self) -> Result<(), Error> {
            loop {
                let header = FrameHeader::parse(&self.pending);
                let (consumed, more) = match self.decoder.decode(&self.pending)? {
                    Step::NeedMore { consumed } => (consumed, false),
                    Step::Frame { frame, consumed } => {
                        assert_eq!(self.open, None);
                        let event = match frame {
                            Frame::Headers { field_section } => {
                                if self.tunnel_after_headers {
                                    self.decoder.tunnel();
                                }
                                Event::Headers(field_section.to_vec())
                            }
                            Frame::CancelPush { push_id } => Event::CancelPush(push_id),
                            Frame::Settings(settings) => Event::Settings(settings),
                            Frame::PushPromise {
                                push_id,
                                field_section,
                            } => Event::PushPromise(push_id, field_section.to_vec()),
                            Frame::Goaway { id } => Event::Goaway(id),
                            Frame::MaxPushId { push_id } => Event::MaxPushId(push_id),
                        };
                        self.events.push(event);
                        (consumed, true)
                    }
                    Step::Data {
                        data,
                        consumed,
                        end,
                    } => {
                        if self.open.is_none() {
                            assert!(data.is_empty() && !end && consumed > 0);
                            let len = header.map_or(u64::MAX, |header| header.len);
                            self.open = Some((true, len));
                            self.events.push(Event::Data(Vec::new()));
                        } else {
                            Self::piece(&mut self.open, &mut self.events, data, end, true);
                        }
                        (consumed, true)
                    }
                    Step::Skipped {
                        frame_type,
                        len,
                        consumed,
                    } => {
                        assert_eq!(self.open, None);
                        self.open = Some((false, len));
                        self.events.push(Event::Skipped(frame_type.0, len));
                        (consumed, true)
                    }
                    Step::Oversized {
                        frame_type,
                        len,
                        consumed,
                    } => {
                        assert_eq!(self.open, None);
                        self.open = Some((false, len));
                        self.events.push(Event::Oversized(frame_type.0, len));
                        (consumed, true)
                    }
                    Step::Discarded {
                        data,
                        consumed,
                        end,
                    } => {
                        Self::piece(&mut self.open, &mut self.events, data, end, false);
                        (consumed, true)
                    }
                };
                self.pending.drain(..consumed.min(self.pending.len()));
                if !more {
                    return Ok(());
                }
            }
        }

        /// The outcome once the input is exhausted.
        fn end(&self, fin: bool) -> Outcome {
            if fin {
                match self.decoder.finish(&self.pending) {
                    Ok(()) => Outcome::Ok,
                    Err(error) => Outcome::Failed(error),
                }
            } else if self.pending.is_empty() && self.open.is_none() {
                Outcome::Ok
            } else {
                Outcome::NeedMore
            }
        }
    }

    /// Decodes `input` presented whole.
    fn whole(
        kind: StreamKind,
        role: Role,
        limits: FrameLimits,
        input: &[u8],
        fin: bool,
        tunnel: bool,
    ) -> (Vec<Event>, Outcome) {
        let mut run = Run::new(kind, role, limits, tunnel);
        run.pending.extend_from_slice(input);
        match run.pump() {
            Ok(()) => {
                let outcome = run.end(fin);
                (run.events, outcome)
            }
            Err(error) => (run.events, Outcome::Failed(error)),
        }
    }

    /// Decodes `input` presented in the given split points.
    fn split(
        kind: StreamKind,
        role: Role,
        limits: FrameLimits,
        input: &[u8],
        fin: bool,
        tunnel: bool,
        cuts: &[usize],
    ) -> (Vec<Event>, Outcome) {
        let mut run = Run::new(kind, role, limits, tunnel);
        let mut start = 0usize;
        for cut in cuts.iter().copied().chain(core::iter::once(input.len())) {
            let cut = cut.clamp(start, input.len());
            run.pending
                .extend_from_slice(input.get(start..cut).unwrap_or(&[]));
            start = cut;
            if let Err(error) = run.pump() {
                return (run.events, Outcome::Failed(error));
            }
        }
        let outcome = run.end(fin);
        (run.events, outcome)
    }

    /// Decodes `input` whole and one octet at a time, asserting both agree.
    fn decode_with(
        kind: StreamKind,
        role: Role,
        limits: FrameLimits,
        input: &[u8],
        fin: bool,
        tunnel: bool,
    ) -> (Vec<Event>, Outcome) {
        let all = whole(kind, role, limits, input, fin, tunnel);
        let cuts: Vec<usize> = (1..input.len()).collect();
        let bytewise = split(kind, role, limits, input, fin, tunnel, &cuts);
        assert_eq!(
            all, bytewise,
            "whole and one-octet decoding differ for {input:02x?}"
        );
        all
    }

    /// Decodes with the default limits and no CONNECT.
    fn decode(kind: StreamKind, role: Role, input: &[u8], fin: bool) -> (Vec<Event>, Outcome) {
        decode_with(kind, role, FrameLimits::DEFAULT, input, fin, false)
    }

    /// Decodes `input` whole to a clean end, calling
    /// [`FrameDecoder::final_response`] after the `nth` HEADERS frame,
    /// counted from 1; 0 never calls it.
    fn marking_final(kind: StreamKind, role: Role, input: &[u8], nth: usize) -> Outcome {
        let mut decoder = FrameDecoder::new(kind, role, FrameLimits::DEFAULT);
        let mut rest = input;
        let mut seen = 0usize;
        loop {
            let consumed = match decoder.decode(rest) {
                Ok(Step::NeedMore { .. }) => break,
                Ok(Step::Frame {
                    frame: Frame::Headers { .. },
                    consumed,
                }) => {
                    seen = seen.saturating_add(1);
                    if seen == nth {
                        decoder.final_response();
                    }
                    consumed
                }
                Ok(
                    Step::Frame { consumed, .. }
                    | Step::Data { consumed, .. }
                    | Step::Skipped { consumed, .. }
                    | Step::Oversized { consumed, .. }
                    | Step::Discarded { consumed, .. },
                ) => consumed,
                Err(error) => return Outcome::Failed(error),
            };
            rest = rest.get(consumed..).unwrap_or(&[]);
        }
        match decoder.finish(rest) {
            Ok(()) => Outcome::Ok,
            Err(error) => Outcome::Failed(error),
        }
    }

    /// Concatenates encoded parts.
    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    /// Encodes one frame.
    fn bytes(frame: &Frame<'_>) -> Vec<u8> {
        let mut out = Vec::new();
        assert_eq!(frame.encode(&mut out), Some(()));
        out
    }

    /// Encodes a DATA frame with its payload.
    fn data(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let len = u64::try_from(payload.len()).unwrap_or(u64::MAX);
        assert_eq!(encode_data_header(len, &mut out), Some(()));
        out.extend_from_slice(payload);
        out
    }

    /// A static-only QPACK field section (`:method GET`, `:path /`), carried
    /// as opaque octets.
    fn section() -> Vec<u8> {
        unhex("0000d1c1")
    }

    /// Encodes a HEADERS frame around [`section`].
    fn headers() -> Vec<u8> {
        bytes(&Frame::Headers {
            field_section: &section(),
        })
    }

    /// The control stream prefix: an empty SETTINGS frame.
    fn settings() -> Vec<u8> {
        bytes(&Frame::Settings(Settings::EMPTY))
    }

    /// Asserts a run failed with `error` and its code.
    fn assert_failed(outcome: &Outcome, error: Error, code: ErrorCode) {
        assert_eq!(outcome, &Outcome::Failed(error));
        assert_eq!(error.code(), code);
    }

    /// RFC 9000 Section 16: "Values do not need to be encoded on the minimum
    /// number of bytes necessary, with the sole exception of the Frame Type
    /// field; see Section 12.4."
    #[test]
    fn non_minimal_varints_are_accepted_in_http_3_frame_types_and_lengths() {
        let request = cat(&[&unhex("40014004"), &section(), &unhex("4000800000026869")]);
        let (events, outcome) = decode(StreamKind::Request, Role::Server, &request, true);
        assert_eq!(
            events,
            [Event::Headers(section()), Event::Data(b"hi".to_vec())]
        );
        assert_eq!(outcome, Outcome::Ok);
        let control = unhex("c0000000000000044000 4007024000 800000030480000000");
        let (events, outcome) = decode(StreamKind::Control, Role::Client, &control, false);
        assert_eq!(
            events,
            [
                Event::Settings(Settings::EMPTY),
                Event::Goaway(0),
                Event::CancelPush(0)
            ]
        );
        assert_eq!(outcome, Outcome::Ok);
    }

    /// RFC 9114 Section 7.1: "A frame payload that contains additional bytes
    /// after the identified fields or a frame payload that terminates before
    /// the end of the identified fields MUST be treated as a connection error
    /// of type H3_FRAME_ERROR."
    #[test]
    fn a_frame_payload_with_extra_bytes_or_ending_before_its_fields_is_h3_frame_error() {
        let control_cases: [(Role, &str, Error); 6] = [
            (
                Role::Client,
                "040007020400",
                Error::PayloadTrailing { frame_type: 7 },
            ),
            (
                Role::Client,
                "04000700",
                Error::PayloadTruncated { frame_type: 7 },
            ),
            (
                Role::Client,
                "04000309",
                Error::PayloadTrailing { frame_type: 3 },
            ),
            (
                Role::Server,
                "04000d0140",
                Error::PayloadTruncated { frame_type: 0x0D },
            ),
            (
                Role::Server,
                "04000d020000",
                Error::PayloadTrailing { frame_type: 0x0D },
            ),
            (
                Role::Server,
                "040106",
                Error::PayloadTruncated { frame_type: 4 },
            ),
        ];
        for (role, input, error) in control_cases {
            let (_, outcome) = decode(StreamKind::Control, role, &unhex(input), false);
            assert_failed(&outcome, error, ErrorCode::H3_FRAME_ERROR);
        }
        for push_promise in ["0500", "050140"] {
            let input = cat(&[&headers(), &unhex(push_promise)]);
            let (events, outcome) = decode(StreamKind::Request, Role::Client, &input, false);
            assert_eq!(events, [Event::Headers(section())]);
            assert_failed(
                &outcome,
                Error::PayloadTruncated { frame_type: 5 },
                ErrorCode::H3_FRAME_ERROR,
            );
        }
    }

    /// RFC 9114 Section 7.1: "When a stream terminates cleanly, if the last
    /// frame on the stream was truncated, this MUST be treated as a connection
    /// error of type H3_FRAME_ERROR."
    #[test]
    fn a_stream_that_ends_cleanly_inside_a_frame_is_h3_frame_error() {
        let complete = cat(&[&headers(), &data(b"hello")]);
        let truncated: [Vec<u8>; 5] = [
            complete.get(..3).unwrap_or(&[]).to_vec(),
            complete
                .get(..complete.len().saturating_sub(2))
                .unwrap_or(&[])
                .to_vec(),
            cat(&[&complete, &[0x01]]),
            cat(&[&complete, &unhex("2103aa")]),
            cat(&[&complete, &unhex("40")]),
        ];
        for input in truncated {
            let (_, outcome) = decode(StreamKind::Request, Role::Server, &input, true);
            assert_failed(
                &outcome,
                Error::StreamEndedInFrame,
                ErrorCode::H3_FRAME_ERROR,
            );
            assert_eq!(Error::StreamEndedInFrame.scope(), Scope::Connection);
            let (_, outcome) = decode(StreamKind::Push, Role::Client, &input, true);
            assert_failed(
                &outcome,
                Error::StreamEndedInFrame,
                ErrorCode::H3_FRAME_ERROR,
            );
        }
        let (_, outcome) = decode(StreamKind::Request, Role::Server, &complete, true);
        assert_eq!(outcome, Outcome::Ok);
    }

    /// RFC 9114 Section 10.8: "An implementation MUST ensure that the length of
    /// a frame exactly matches the length of the fields it contains."
    #[test]
    fn the_frame_length_exactly_matches_the_length_of_the_fields_it_contains() {
        let exact: [(&str, Event); 3] = [
            ("04000d024001", Event::MaxPushId(1)),
            ("04000708c000000000000004", Event::Goaway(4)),
            ("0400030480000005", Event::CancelPush(5)),
        ];
        for (input, event) in exact {
            let (events, outcome) = decode(StreamKind::Control, Role::Server, &unhex(input), false);
            assert_eq!(events, [Event::Settings(Settings::EMPTY), event], "{input}");
            assert_eq!(outcome, Outcome::Ok, "{input}");
        }
        let mismatched: [(&str, Error); 5] = [
            (
                "04000d0440010000",
                Error::PayloadTrailing { frame_type: 0x0D },
            ),
            ("040003028000", Error::PayloadTruncated { frame_type: 3 }),
            ("04000701c0", Error::PayloadTruncated { frame_type: 7 }),
            ("04000703400400", Error::PayloadTrailing { frame_type: 7 }),
            ("04020640", Error::PayloadTruncated { frame_type: 4 }),
        ];
        for (input, error) in mismatched {
            let (_, outcome) = decode(StreamKind::Control, Role::Server, &unhex(input), false);
            assert_failed(&outcome, error, ErrorCode::H3_FRAME_ERROR);
        }
        let (events, outcome) = decode(
            StreamKind::Control,
            Role::Client,
            &unhex("0403064000"),
            false,
        );
        assert_eq!(
            events,
            [Event::Settings(Settings {
                max_field_section_size: Some(0),
                ..Settings::EMPTY
            })]
        );
        assert_eq!(outcome, Outcome::Ok);
    }

    /// RFC 9114 Section 7.2.1: "If a DATA frame is received on a control
    /// stream, the recipient MUST respond with a connection error of type
    /// H3_FRAME_UNEXPECTED."
    #[test]
    fn a_data_frame_on_the_control_stream_is_h3_frame_unexpected() {
        for role in [Role::Server, Role::Client] {
            let input = cat(&[&settings(), &data(b"")]);
            let (events, outcome) = decode(StreamKind::Control, role, &input, false);
            assert_eq!(events, [Event::Settings(Settings::EMPTY)]);
            assert_failed(
                &outcome,
                Error::WrongStream {
                    frame_type: 0,
                    stream: StreamKind::Control,
                },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
    }

    /// RFC 9114 Section 7.2.2: "If a HEADERS frame is received on a control
    /// stream, the recipient MUST respond with a connection error of type
    /// H3_FRAME_UNEXPECTED."
    #[test]
    fn a_headers_frame_on_the_control_stream_is_h3_frame_unexpected() {
        for role in [Role::Server, Role::Client] {
            let input = cat(&[&settings(), &headers()]);
            let (_, outcome) = decode(StreamKind::Control, role, &input, false);
            assert_failed(
                &outcome,
                Error::WrongStream {
                    frame_type: 1,
                    stream: StreamKind::Control,
                },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
    }

    /// RFC 9114 Section 7.2.3: "Receiving a CANCEL_PUSH frame on a stream other
    /// than the control stream MUST be treated as a connection error of type
    /// H3_FRAME_UNEXPECTED."
    #[test]
    fn a_cancel_push_frame_off_the_control_stream_is_h3_frame_unexpected() {
        let cancel = bytes(&Frame::CancelPush { push_id: 0 });
        for (kind, role) in [
            (StreamKind::Request, Role::Server),
            (StreamKind::Request, Role::Client),
            (StreamKind::Push, Role::Client),
        ] {
            for input in [cancel.clone(), cat(&[&headers(), &cancel])] {
                let (_, outcome) = decode(kind, role, &input, false);
                assert_failed(
                    &outcome,
                    Error::WrongStream {
                        frame_type: 3,
                        stream: kind,
                    },
                    ErrorCode::H3_FRAME_UNEXPECTED,
                );
            }
        }
    }

    /// RFC 9114 Section 7.2.4: "If an endpoint receives a second SETTINGS frame
    /// on the control stream, the endpoint MUST respond with a connection error
    /// of type H3_FRAME_UNEXPECTED."
    #[test]
    fn a_second_settings_frame_on_the_control_stream_is_h3_frame_unexpected() {
        let server = bytes(&Frame::Settings(Settings::server(&Http3Limits::DEFAULT)));
        for role in [Role::Server, Role::Client] {
            let input = cat(&[&server, &settings()]);
            let (events, outcome) = decode(StreamKind::Control, role, &input, false);
            assert_eq!(
                events,
                [Event::Settings(Settings::server(&Http3Limits::DEFAULT))]
            );
            assert_failed(
                &outcome,
                Error::SecondSettings,
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
    }

    /// RFC 9114 Section 7.2.4: "If an endpoint receives a SETTINGS frame on a
    /// different stream, the endpoint MUST respond with a connection error of
    /// type H3_FRAME_UNEXPECTED."
    #[test]
    fn a_settings_frame_off_the_control_stream_is_h3_frame_unexpected() {
        for (kind, role) in [
            (StreamKind::Request, Role::Server),
            (StreamKind::Request, Role::Client),
            (StreamKind::Push, Role::Client),
        ] {
            let (_, outcome) = decode(kind, role, &settings(), false);
            assert_failed(
                &outcome,
                Error::WrongStream {
                    frame_type: 4,
                    stream: kind,
                },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
    }

    /// RFC 9114 Section 6.2.1: "If the first frame of the control stream is any
    /// other frame type, this MUST be treated as a connection error of type
    /// H3_MISSING_SETTINGS."
    /// RFC 9114 Section 9: "an unknown frame type does not satisfy that
    /// requirement and SHOULD be treated as an error."
    #[test]
    fn a_control_stream_whose_first_frame_is_not_settings_is_h3_missing_settings() {
        let firsts: [(&str, u64); 8] = [
            ("070100", 0x07),
            ("0d0100", 0x0D),
            ("030100", 0x03),
            ("0000", 0x00),
            ("01020000", 0x01),
            ("2100", 0x21),
            ("0600", 0x06),
            ("800f070000", 0xF0700),
        ];
        for role in [Role::Server, Role::Client] {
            for (frame, frame_type) in firsts {
                let (events, outcome) = decode(StreamKind::Control, role, &unhex(frame), false);
                assert!(events.is_empty());
                assert_failed(
                    &outcome,
                    Error::MissingSettings { frame_type },
                    ErrorCode::H3_MISSING_SETTINGS,
                );
            }
        }
    }

    /// RFC 9114 Section 7.2.5: "A server MUST treat the receipt of a
    /// PUSH_PROMISE frame as a connection error of type H3_FRAME_UNEXPECTED."
    #[test]
    fn a_server_receiving_a_push_promise_frame_is_h3_frame_unexpected() {
        let promise = bytes(&Frame::PushPromise {
            push_id: 0,
            field_section: &section(),
        });
        for input in [promise.clone(), cat(&[&headers(), &promise])] {
            let (_, outcome) = decode(StreamKind::Request, Role::Server, &input, false);
            assert_failed(
                &outcome,
                Error::WrongRole { frame_type: 5 },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
        let input = cat(&[&settings(), &promise]);
        let (_, outcome) = decode(StreamKind::Control, Role::Server, &input, false);
        assert_failed(
            &outcome,
            Error::WrongStream {
                frame_type: 5,
                stream: StreamKind::Control,
            },
            ErrorCode::H3_FRAME_UNEXPECTED,
        );
    }

    /// RFC 9114 Section 7.2.5: "If a PUSH_PROMISE frame is received on the
    /// control stream, the client MUST respond with a connection error of type
    /// H3_FRAME_UNEXPECTED."
    #[test]
    fn a_client_receiving_push_promise_on_the_control_stream_is_h3_frame_unexpected() {
        let promise = bytes(&Frame::PushPromise {
            push_id: 3,
            field_section: &section(),
        });
        let input = cat(&[&settings(), &promise]);
        let (_, outcome) = decode(StreamKind::Control, Role::Client, &input, false);
        assert_failed(
            &outcome,
            Error::WrongStream {
                frame_type: 5,
                stream: StreamKind::Control,
            },
            ErrorCode::H3_FRAME_UNEXPECTED,
        );
        let input = cat(&[&promise, &headers(), &promise, &data(b"x"), &promise]);
        let (events, outcome) = decode(StreamKind::Request, Role::Client, &input, true);
        let promised = Event::PushPromise(3, section());
        assert_eq!(
            events,
            [
                promised.clone(),
                Event::Headers(section()),
                promised.clone(),
                Event::Data(b"x".to_vec()),
                promised
            ]
        );
        assert_eq!(outcome, Outcome::Ok);
    }

    /// RFC 9114 Section 4.1: "PUSH_PROMISE frames are not permitted on push
    /// streams; a pushed response that includes PUSH_PROMISE frames MUST be
    /// treated as a connection error of type H3_FRAME_UNEXPECTED."
    #[test]
    fn a_push_promise_frame_on_a_push_stream_is_h3_frame_unexpected() {
        let promise = bytes(&Frame::PushPromise {
            push_id: 1,
            field_section: &section(),
        });
        let input = cat(&[&headers(), &promise]);
        let (events, outcome) = decode(StreamKind::Push, Role::Client, &input, false);
        assert_eq!(events, [Event::Headers(section())]);
        assert_failed(
            &outcome,
            Error::WrongStream {
                frame_type: 5,
                stream: StreamKind::Push,
            },
            ErrorCode::H3_FRAME_UNEXPECTED,
        );
    }

    /// RFC 9114 Section 7.2.6: "A client MUST treat a GOAWAY frame on a stream
    /// other than the control stream as a connection error of type
    /// H3_FRAME_UNEXPECTED."
    /// Verified erratum 7780 replaces "A client" with "An endpoint", so a
    /// server applies the rule too.
    #[test]
    fn a_goaway_frame_off_the_control_stream_is_h3_frame_unexpected() {
        let goaway = bytes(&Frame::Goaway { id: 0 });
        for (kind, role) in [
            (StreamKind::Request, Role::Server),
            (StreamKind::Request, Role::Client),
            (StreamKind::Push, Role::Client),
        ] {
            let input = cat(&[&headers(), &goaway]);
            let (_, outcome) = decode(kind, role, &input, false);
            assert_failed(
                &outcome,
                Error::WrongStream {
                    frame_type: 7,
                    stream: kind,
                },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
    }

    /// RFC 9114 Section 7.2.7: "Receipt of a MAX_PUSH_ID frame on any other
    /// stream MUST be treated as a connection error of type
    /// H3_FRAME_UNEXPECTED."
    #[test]
    fn a_max_push_id_frame_off_the_control_stream_is_h3_frame_unexpected() {
        let max = bytes(&Frame::MaxPushId { push_id: 8 });
        for (kind, role) in [
            (StreamKind::Request, Role::Server),
            (StreamKind::Request, Role::Client),
            (StreamKind::Push, Role::Client),
        ] {
            let (_, outcome) = decode(kind, role, &max, false);
            assert_failed(
                &outcome,
                Error::WrongStream {
                    frame_type: 0x0D,
                    stream: kind,
                },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
    }

    /// RFC 9114 Section 7.2.7: "A client MUST treat the receipt of a
    /// MAX_PUSH_ID frame as a connection error of type H3_FRAME_UNEXPECTED."
    #[test]
    fn a_client_receiving_a_max_push_id_frame_is_h3_frame_unexpected() {
        let input = cat(&[&settings(), &bytes(&Frame::MaxPushId { push_id: 8 })]);
        let (events, outcome) = decode(StreamKind::Control, Role::Client, &input, false);
        assert_eq!(events, [Event::Settings(Settings::EMPTY)]);
        assert_failed(
            &outcome,
            Error::WrongRole { frame_type: 0x0D },
            ErrorCode::H3_FRAME_UNEXPECTED,
        );
        let (events, outcome) = decode(StreamKind::Control, Role::Server, &input, false);
        assert_eq!(
            events,
            [Event::Settings(Settings::EMPTY), Event::MaxPushId(8)]
        );
        assert_eq!(outcome, Outcome::Ok);
    }

    /// RFC 9114 Section 7.2.8: "Frame types that were used in HTTP/2 where
    /// there is no corresponding HTTP/3 frame have also been reserved (Section
    /// 11.2.1). These frame types MUST NOT be sent, and their receipt MUST be
    /// treated as a connection error of type H3_FRAME_UNEXPECTED."
    #[test]
    fn the_http_2_reserved_frame_types_are_h3_frame_unexpected_except_as_the_first_control_frame() {
        for frame_type in FrameType::RESERVED_HTTP2 {
            let mut frame = Vec::new();
            assert_eq!(FrameHeader::encode(frame_type, 0, &mut frame), Some(()));
            let expected = Error::ReservedFrameType {
                frame_type: frame_type.0,
            };
            for (kind, role, prefix) in [
                (StreamKind::Request, Role::Server, Vec::new()),
                (StreamKind::Request, Role::Server, headers()),
                (StreamKind::Request, Role::Client, headers()),
                (StreamKind::Push, Role::Client, Vec::new()),
                (StreamKind::Control, Role::Server, settings()),
                (StreamKind::Control, Role::Client, settings()),
            ] {
                let input = cat(&[&prefix, &frame]);
                let (_, outcome) = decode(kind, role, &input, false);
                assert_failed(&outcome, expected, ErrorCode::H3_FRAME_UNEXPECTED);
            }
            let (_, outcome) = decode(StreamKind::Control, Role::Server, &frame, false);
            assert_failed(
                &outcome,
                Error::MissingSettings {
                    frame_type: frame_type.0,
                },
                ErrorCode::H3_MISSING_SETTINGS,
            );
        }
        let (_, outcome) = decode(StreamKind::Control, Role::Client, &unhex("0600"), false);
        assert_eq!(
            outcome,
            Outcome::Failed(Error::MissingSettings { frame_type: 6 })
        );
    }

    /// RFC 9114 Section 9: "Implementations MUST ignore unknown or unsupported
    /// values in all extensible protocol elements."
    #[test]
    fn unknown_and_reserved_frame_types_are_skipped_except_as_the_first_control_frame() {
        let mut grease = Vec::new();
        assert_eq!(encode_reserved(0, &[0xAB, 0xCD], &mut grease), Some(()));
        let mut empty_grease = Vec::new();
        assert_eq!(encode_reserved(0, &[], &mut empty_grease), Some(()));
        let input = cat(&[
            &grease,
            &headers(),
            &empty_grease,
            &data(b"ok"),
            &unhex("0a0101"),
            &empty_grease,
        ]);
        let (events, outcome) = decode(StreamKind::Request, Role::Server, &input, true);
        assert_eq!(
            events,
            [
                Event::Skipped(0x21, 2),
                Event::Headers(section()),
                Event::Skipped(0x21, 0),
                Event::Data(b"ok".to_vec()),
                Event::Skipped(0x0A, 1),
                Event::Skipped(0x21, 0),
            ]
        );
        assert_eq!(outcome, Outcome::Ok);
        let mut decoder =
            FrameDecoder::new(StreamKind::Request, Role::Server, FrameLimits::DEFAULT);
        assert_eq!(
            decoder.decode(&empty_grease),
            Ok(Step::Skipped {
                frame_type: FrameType(0x21),
                len: 0,
                consumed: 2
            })
        );
        assert_eq!(
            decoder.decode(&[]),
            Ok(Step::Discarded {
                data: &[],
                consumed: 0,
                end: true
            })
        );
        assert_eq!(decoder.decode(&[]), Ok(Step::NeedMore { consumed: 0 }));
        let priority_update = unhex("800f0700030001ff");
        let origin = unhex("0c00");
        let control = cat(&[&settings(), &priority_update, &origin, &grease]);
        let (events, outcome) = decode(StreamKind::Control, Role::Server, &control, false);
        assert_eq!(
            events,
            [
                Event::Settings(Settings::EMPTY),
                Event::Skipped(0xF0700, 3),
                Event::Skipped(0x0C, 0),
                Event::Skipped(0x21, 2),
            ]
        );
        assert_eq!(outcome, Outcome::Ok);
        let push = cat(&[&grease, &headers(), &grease]);
        let (events, _) = decode(StreamKind::Push, Role::Client, &push, true);
        assert_eq!(events.len(), 3);
        let (_, outcome) = decode(StreamKind::Control, Role::Server, &grease, false);
        assert_eq!(
            outcome,
            Outcome::Failed(Error::MissingSettings { frame_type: 0x21 })
        );
    }

    /// RFC 9114 Section 4.1: "Receipt of an invalid sequence of frames MUST be
    /// treated as a connection error of type H3_FRAME_UNEXPECTED. In
    /// particular, a DATA frame before any HEADERS frame, or a HEADERS or DATA
    /// frame after the trailing HEADERS frame, is considered invalid." A
    /// server reads it as stated; a client, which also reads "zero or more
    /// interim HTTP responses", applies it after DATA and, once the final
    /// response is marked, after the trailer section.
    #[test]
    fn data_before_headers_or_headers_or_data_after_trailers_is_h3_frame_unexpected() {
        let h = headers();
        let d = data(b"abc");
        let invalid: [(Vec<u8>, u64); 5] = [
            (d.clone(), 0),
            (cat(&[&h, &h, &h]), 1),
            (cat(&[&h, &h, &d]), 0),
            (cat(&[&h, &d, &h, &d]), 0),
            (cat(&[&h, &d, &h, &h]), 1),
        ];
        for (input, frame_type) in invalid {
            let (_, outcome) = decode(StreamKind::Request, Role::Server, &input, true);
            assert_failed(
                &outcome,
                Error::OutOfSequence { frame_type },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
        let (_, outcome) = decode(StreamKind::Push, Role::Client, &d, true);
        assert_eq!(
            outcome,
            Outcome::Failed(Error::OutOfSequence { frame_type: 0 })
        );
        let interim = cat(&[&h, &h, &d, &d, &h]);
        let (events, outcome) = decode(StreamKind::Request, Role::Client, &interim, true);
        assert_eq!(events.len(), 5);
        assert_eq!(outcome, Outcome::Ok);
        let (_, outcome) = decode(
            StreamKind::Request,
            Role::Client,
            &cat(&[&interim, &d]),
            true,
        );
        assert_eq!(
            outcome,
            Outcome::Failed(Error::OutOfSequence { frame_type: 0 })
        );
        let promise = bytes(&Frame::PushPromise {
            push_id: 0,
            field_section: &section(),
        });
        let (_, outcome) = decode(
            StreamKind::Request,
            Role::Client,
            &cat(&[&interim, &promise]),
            true,
        );
        assert_eq!(outcome, Outcome::Ok);
        let (_, outcome) = decode(StreamKind::Request, Role::Server, &cat(&[&h, &d, &h]), true);
        assert_eq!(outcome, Outcome::Ok);

        let marked: [(Vec<u8>, usize, Outcome); 8] = [
            (
                cat(&[&h, &h, &d]),
                1,
                Outcome::Failed(Error::OutOfSequence { frame_type: 0 }),
            ),
            (
                cat(&[&h, &h, &h]),
                1,
                Outcome::Failed(Error::OutOfSequence { frame_type: 1 }),
            ),
            (cat(&[&h, &h, &d, &d, &h]), 2, Outcome::Ok),
            (
                cat(&[&h, &h, &d, &d, &h, &d]),
                2,
                Outcome::Failed(Error::OutOfSequence { frame_type: 0 }),
            ),
            (cat(&[&h, &h, &h, &h]), 3, Outcome::Ok),
            (
                cat(&[&h, &h, &h, &h, &h]),
                3,
                Outcome::Failed(Error::OutOfSequence { frame_type: 1 }),
            ),
            (cat(&[&h, &h, &d]), 0, Outcome::Ok),
            (
                cat(&[&h, &d, &h, &h]),
                1,
                Outcome::Failed(Error::OutOfSequence { frame_type: 1 }),
            ),
        ];
        for kind in [StreamKind::Request, StreamKind::Push] {
            for (input, nth, expected) in &marked {
                let outcome = marking_final(kind, Role::Client, input, *nth);
                assert_eq!(outcome, *expected, "{kind:?} final at {nth}: {input:02x?}");
                if let Outcome::Failed(error) = outcome {
                    assert_eq!(error.code(), ErrorCode::H3_FRAME_UNEXPECTED);
                    assert_eq!(error.scope(), Scope::Connection);
                }
            }
        }
        assert_eq!(
            marking_final(StreamKind::Request, Role::Server, &cat(&[&h, &h]), 1),
            Outcome::Ok
        );
        assert_eq!(
            marking_final(StreamKind::Request, Role::Server, &cat(&[&h, &h, &d]), 1),
            Outcome::Failed(Error::OutOfSequence { frame_type: 0 })
        );
        let mut early = FrameDecoder::new(StreamKind::Request, Role::Client, FrameLimits::DEFAULT);
        early.final_response();
        assert_eq!(
            early,
            FrameDecoder::new(StreamKind::Request, Role::Client, FrameLimits::DEFAULT)
        );
    }

    /// RFC 9114 Section 4.4: "Once the CONNECT method has completed, only DATA
    /// frames are permitted to be sent on the stream. Extension frames MAY be
    /// used if specifically permitted by the definition of the extension.
    /// Receipt of any other known frame type MUST be treated as a connection
    /// error of type H3_FRAME_UNEXPECTED."
    #[test]
    fn after_connect_completes_a_known_frame_other_than_data_is_h3_frame_unexpected() {
        let mut grease = Vec::new();
        assert_eq!(encode_reserved(3, b"pad", &mut grease), Some(()));
        let tunnel = cat(&[&headers(), &data(b"one"), &grease, &data(b"two")]);
        let limits = FrameLimits::DEFAULT;
        let (events, outcome) = decode_with(
            StreamKind::Request,
            Role::Server,
            limits,
            &tunnel,
            true,
            true,
        );
        assert_eq!(events.len(), 4);
        assert_eq!(outcome, Outcome::Ok);
        let promise = bytes(&Frame::PushPromise {
            push_id: 0,
            field_section: &section(),
        });
        for (role, extra, frame_type) in [
            (Role::Server, headers(), 1u64),
            (Role::Client, headers(), 1),
            (Role::Client, promise, 5),
        ] {
            let input = cat(&[&tunnel, &extra]);
            let (_, outcome) = decode_with(StreamKind::Request, role, limits, &input, true, true);
            assert_failed(
                &outcome,
                Error::OutOfSequence { frame_type },
                ErrorCode::H3_FRAME_UNEXPECTED,
            );
        }
        let mut decoder = FrameDecoder::new(StreamKind::Control, Role::Server, limits);
        decoder.tunnel();
        assert!(matches!(
            decoder.decode(&settings()),
            Ok(Step::Frame { .. })
        ));
    }

    /// RFC 9114 Section 4.1: "If a client-initiated stream terminates without
    /// enough of the HTTP message to provide a complete response, the server
    /// SHOULD abort its response stream with the error code
    /// H3_REQUEST_INCOMPLETE."
    #[test]
    fn a_request_stream_that_ends_before_its_headers_is_h3_request_incomplete() {
        let mut grease = Vec::new();
        assert_eq!(encode_reserved(0, b"", &mut grease), Some(()));
        for input in [Vec::new(), grease.clone()] {
            let (_, outcome) = decode(StreamKind::Request, Role::Server, &input, true);
            assert_eq!(outcome, Outcome::Failed(Error::RequestIncomplete));
            assert_eq!(
                Error::RequestIncomplete.code(),
                ErrorCode::H3_REQUEST_INCOMPLETE
            );
            assert_eq!(Error::RequestIncomplete.scope(), Scope::Stream);
        }
        let (_, outcome) = decode(StreamKind::Request, Role::Server, &headers(), true);
        assert_eq!(outcome, Outcome::Ok);
        let (_, outcome) = decode(StreamKind::Request, Role::Client, &[], true);
        assert_eq!(outcome, Outcome::Ok);
        let control = FrameDecoder::new(StreamKind::Control, Role::Server, FrameLimits::DEFAULT);
        assert_eq!(
            control.finish(&[]),
            Err(Error::CriticalStreamClosed { stream_type: 0 })
        );
    }

    /// RFC 9114 Section 10.5: "Implementations SHOULD track the use of these
    /// features and set limits on their use. An endpoint MAY treat activity
    /// that is suspicious as a connection error of type H3_EXCESSIVE_LOAD, but
    /// false positives will result in disrupting valid connections and
    /// requests."
    #[test]
    fn a_settings_frame_beyond_the_local_limit_is_h3_excessive_load() {
        assert_eq!(FrameLimits::DEFAULT.settings, SETTINGS_PAYLOAD_LIMIT);
        let mut payload = Vec::new();
        for index in 0..1_024u64 {
            let mut pair = [0u8; 4];
            let _ = varint::encode_with_len(0x100u64.saturating_add(index), 2, &mut pair);
            let _ = varint::encode_with_len(0, 2, pair.get_mut(2..).unwrap_or(&mut []));
            payload.extend_from_slice(&pair);
        }
        assert_eq!(payload.len(), 4_096);
        let mut at_limit = Vec::new();
        assert_eq!(
            FrameHeader::encode(FrameType::SETTINGS, 4_096, &mut at_limit),
            Some(())
        );
        at_limit.extend_from_slice(&payload);
        let (events, outcome) = decode(StreamKind::Control, Role::Server, &at_limit, false);
        assert_eq!(events, [Event::Settings(Settings::EMPTY)]);
        assert_eq!(outcome, Outcome::Ok);
        let mut beyond = Vec::new();
        assert_eq!(
            FrameHeader::encode(FrameType::SETTINGS, 4_097, &mut beyond),
            Some(())
        );
        let (_, outcome) = decode(StreamKind::Control, Role::Server, &beyond, false);
        assert_failed(
            &outcome,
            Error::ExcessiveLoad {
                frame_type: 4,
                len: 4_097,
            },
            ErrorCode::H3_EXCESSIVE_LOAD,
        );
    }

    /// RFC 9114 Section 4.2.2: "An HTTP/3 implementation MAY impose a limit on
    /// the maximum size of the message header it will accept on an individual
    /// HTTP message. A server that receives a larger header section than it is
    /// willing to handle can send an HTTP 431 (Request Header Fields Too Large)
    /// status code ([RFC6585])." The hold limit is the encoded bound of the
    /// advertised size capped by the stream window; the advertised size "is
    /// only advisory" (Section 10.5.1).
    #[test]
    fn a_headers_frame_beyond_the_field_section_bound_is_skipped_and_reported() {
        assert_eq!(encoded_field_section_bound(32_768), 131_092);
        assert_eq!(FrameLimits::DEFAULT.field_section, 131_092);
        let small = FrameLimits {
            field_section: 8,
            settings: SETTINGS_PAYLOAD_LIMIT,
        };
        let fits = bytes(&Frame::Headers {
            field_section: &[0u8; 8],
        });
        let over = bytes(&Frame::Headers {
            field_section: &[0u8; 9],
        });
        let input = cat(&[&over, &data(b"body"), &fits]);
        let (events, outcome) = decode_with(
            StreamKind::Request,
            Role::Server,
            small,
            &input,
            true,
            false,
        );
        assert_eq!(
            events,
            [
                Event::Oversized(1, 9),
                Event::Data(b"body".to_vec()),
                Event::Headers(alloc::vec![0u8; 8])
            ]
        );
        assert_eq!(outcome, Outcome::Ok);
        let promise_fits = bytes(&Frame::PushPromise {
            push_id: 0x3FFF_FFFF_FFFF_FFFF,
            field_section: &[0u8; 8],
        });
        let promise_over = bytes(&Frame::PushPromise {
            push_id: 0x3FFF_FFFF_FFFF_FFFF,
            field_section: &[0u8; 9],
        });
        let input = cat(&[&promise_fits, &promise_over]);
        let (events, _) = decode_with(
            StreamKind::Request,
            Role::Client,
            small,
            &input,
            true,
            false,
        );
        assert_eq!(
            events,
            [
                Event::PushPromise(0x3FFF_FFFF_FFFF_FFFF, alloc::vec![0u8; 8]),
                Event::Oversized(5, 17)
            ]
        );
        let mut header = Vec::new();
        assert_eq!(
            FrameHeader::encode(FrameType::HEADERS, 131_093, &mut header),
            Some(())
        );
        let mut decoder =
            FrameDecoder::new(StreamKind::Request, Role::Server, FrameLimits::DEFAULT);
        assert_eq!(
            decoder.decode(&header),
            Ok(Step::Oversized {
                frame_type: FrameType::HEADERS,
                len: 131_093,
                consumed: header.len()
            })
        );
        let mut header = Vec::new();
        assert_eq!(
            FrameHeader::encode(FrameType::HEADERS, 131_092, &mut header),
            Some(())
        );
        let mut decoder =
            FrameDecoder::new(StreamKind::Request, Role::Server, FrameLimits::DEFAULT);
        assert_eq!(decoder.decode(&header), Ok(Step::NeedMore { consumed: 0 }));

        let capped = FrameLimits::from_limits(&Http3Limits {
            max_field_section_size: 65_536,
            ..Http3Limits::DEFAULT
        });
        assert_eq!(encoded_field_section_bound(65_536), 262_164);
        assert_eq!(capped.field_section, 262_120);
        let mut header = Vec::new();
        assert_eq!(
            FrameHeader::encode(FrameType::HEADERS, 262_121, &mut header),
            Some(())
        );
        let mut decoder = FrameDecoder::new(StreamKind::Request, Role::Server, capped);
        assert_eq!(
            decoder.decode(&header),
            Ok(Step::Oversized {
                frame_type: FrameType::HEADERS,
                len: 262_121,
                consumed: header.len()
            })
        );
        let mut header = Vec::new();
        assert_eq!(
            FrameHeader::encode(FrameType::HEADERS, 262_120, &mut header),
            Some(())
        );
        let mut decoder = FrameDecoder::new(StreamKind::Request, Role::Server, capped);
        assert_eq!(decoder.decode(&header), Ok(Step::NeedMore { consumed: 0 }));
    }

    /// RFC 9000 Section 4.1: "Senders MUST NOT send data in excess of either
    /// limit.", and the decoder consumes nothing of a frame it holds whole, so
    /// the hold limits stay within one stream's flow-control window with the
    /// frame header and push ID, which RFC 9114 Section 4.2.2 allows: "An
    /// HTTP/3 implementation MAY impose a limit on the maximum size of the
    /// message header it will accept on an individual HTTP message".
    #[test]
    fn from_limits_never_yields_a_hold_limit_above_the_stream_window() {
        assert_eq!(
            FrameLimits::DEFAULT,
            FrameLimits {
                field_section: 131_092,
                settings: 4_096
            }
        );
        assert_eq!(FrameLimits::default(), FrameLimits::DEFAULT);
        let header = u64::try_from(MAX_HEADER_LEN).unwrap_or(0);
        assert_eq!(header, 16);
        let large_section = Http3Limits {
            max_field_section_size: 65_536,
            ..Http3Limits::DEFAULT
        };
        assert_eq!(
            FrameLimits::from_limits(&large_section),
            FrameLimits {
                field_section: 262_120,
                settings: 4_096
            }
        );
        let no_window = Http3Limits {
            stream_data: 0,
            ..Http3Limits::DEFAULT
        };
        assert_eq!(
            FrameLimits::from_limits(&no_window),
            FrameLimits {
                field_section: 0,
                settings: 0
            }
        );
        let unbounded = Http3Limits {
            stream_data: u64::MAX,
            max_field_section_size: u64::MAX,
            ..Http3Limits::DEFAULT
        };
        assert_eq!(
            FrameLimits::from_limits(&unbounded),
            FrameLimits {
                field_section: u64::MAX.saturating_sub(24),
                settings: 4_096
            }
        );
        for limits in [Http3Limits::DEFAULT, large_section, no_window, unbounded] {
            let hold = FrameLimits::from_limits(&limits);
            if limits.stream_data >= 24 {
                assert!(hold.field_section.saturating_add(24) <= limits.stream_data);
                assert!(hold.settings.saturating_add(16) <= limits.stream_data);
            }
            assert!(
                hold.field_section <= encoded_field_section_bound(limits.max_field_section_size)
            );
            assert!(hold.settings <= SETTINGS_PAYLOAD_LIMIT);
        }
    }

    /// RFC 9114 Section 9: "Implementations MUST ignore unknown or unsupported
    /// values in all extensible protocol elements.", so a reserved frame type
    /// is skipped by its whole Length, here above u32::MAX, and RFC 9114
    /// Section 7.1: "When a stream terminates cleanly, if the last frame on the
    /// stream was truncated, this MUST be treated as a connection error of type
    /// H3_FRAME_ERROR."
    #[test]
    fn a_frame_length_above_u32_max_is_skipped_by_its_full_length() {
        let input = unhex("21c0000001000000030102030405");
        let mut decoder =
            FrameDecoder::new(StreamKind::Request, Role::Server, FrameLimits::DEFAULT);
        assert_eq!(
            decoder.decode(&input),
            Ok(Step::Skipped {
                frame_type: FrameType(0x21),
                len: 4_294_967_299,
                consumed: 9
            })
        );
        let rest = input.get(9..).unwrap_or(&[]);
        assert_eq!(
            decoder.decode(rest),
            Ok(Step::Discarded {
                data: rest,
                consumed: 5,
                end: false
            })
        );
        assert_eq!(decoder.decode(&[]), Ok(Step::NeedMore { consumed: 0 }));
        assert_eq!(decoder.finish(&[]), Err(Error::StreamEndedInFrame));
    }

    /// RFC 9114 Section 7.2.1: "DATA frames (type=0x00) convey arbitrary,
    /// variable-length sequences of bytes", the empty one included, which the
    /// decoder hands out as a header step and one empty piece that ends it.
    #[test]
    fn a_zero_length_data_frame_yields_one_empty_piece_that_ends_it() {
        let input = cat(&[&headers(), &data(b"")]);
        let mut decoder =
            FrameDecoder::new(StreamKind::Request, Role::Server, FrameLimits::DEFAULT);
        let headers_len = headers().len();
        assert!(
            matches!(decoder.decode(&input), Ok(Step::Frame { consumed, .. }) if consumed == headers_len)
        );
        let rest = input.get(headers_len..).unwrap_or(&[]);
        assert_eq!(
            decoder.decode(rest),
            Ok(Step::Data {
                data: &[],
                consumed: 2,
                end: false
            })
        );
        assert_eq!(
            decoder.decode(&[]),
            Ok(Step::Data {
                data: &[],
                consumed: 0,
                end: true
            })
        );
        assert_eq!(decoder.decode(&[]), Ok(Step::NeedMore { consumed: 0 }));
        assert_eq!(decoder.finish(&[]), Ok(()));
    }

    /// RFC 9114 Sections 7.2.1 to 7.2.7: each frame type of Section 7.2
    /// decodes on its stream the same whether the octets arrive whole or one
    /// at a time, and Section 6.2.1: "If either control stream is closed at
    /// any point, this MUST be treated as a connection error of type
    /// H3_CLOSED_CRITICAL_STREAM."
    #[test]
    fn every_frame_type_decodes_whole_and_one_octet_at_a_time() {
        let control = cat(&[
            &bytes(&Frame::Settings(Settings::server(&Http3Limits::DEFAULT))),
            &bytes(&Frame::MaxPushId { push_id: 7 }),
            &bytes(&Frame::CancelPush { push_id: 2 }),
            &bytes(&Frame::Goaway { id: 4 }),
        ]);
        let (events, outcome) = decode(StreamKind::Control, Role::Server, &control, false);
        assert_eq!(
            events,
            [
                Event::Settings(Settings::server(&Http3Limits::DEFAULT)),
                Event::MaxPushId(7),
                Event::CancelPush(2),
                Event::Goaway(4),
            ]
        );
        assert_eq!(outcome, Outcome::Ok);
        let (_, outcome) = decode(StreamKind::Control, Role::Server, &control, true);
        assert_eq!(
            outcome,
            Outcome::Failed(Error::CriticalStreamClosed { stream_type: 0 })
        );
        let request = cat(&[&headers(), &data(b"hello"), &data(b""), &headers()]);
        let (events, outcome) = decode(StreamKind::Request, Role::Server, &request, true);
        assert_eq!(
            events,
            [
                Event::Headers(section()),
                Event::Data(b"hello".to_vec()),
                Event::Data(Vec::new()),
                Event::Headers(section()),
            ]
        );
        assert_eq!(outcome, Outcome::Ok);
        let (_, outcome) = decode(
            StreamKind::Request,
            Role::Server,
            request.get(..4).unwrap_or(&[]),
            false,
        );
        assert_eq!(outcome, Outcome::NeedMore);
    }

    /// RFC 9114 Section 4.1: "Frames of unknown types (Section 9), including
    /// reserved frames (Section 7.2.8) MAY be sent on a request or push stream
    /// before, after, or interleaved with other frames", and RFC 9000 Section
    /// 16: "Values do not need to be encoded on the minimum number of bytes
    /// necessary"; random sequences of DATA, padded DATA and reserved frames
    /// decode the same whatever the split points.
    #[test]
    fn random_frame_sequences_decode_the_same_whole_and_split_at_random_points() {
        let mut rng = Rng::new(0x5EED_000C);
        for _ in 0..iterations(1_500) {
            let mut input = headers();
            let mut expected = alloc::vec![Event::Headers(section())];
            for _ in 0..rng.index(6) {
                match rng.below(3) {
                    0 => {
                        let payload = rng.bytes(40);
                        input.extend_from_slice(&data(&payload));
                        expected.push(Event::Data(payload));
                    }
                    1 => {
                        let n = rng.below(1_000);
                        let payload = rng.bytes(20);
                        let _ = encode_reserved(n, &payload, &mut input);
                        let frame_type = crate::reserved::reserved(n).unwrap_or(0);
                        expected.push(Event::Skipped(
                            frame_type,
                            u64::try_from(payload.len()).unwrap_or(0),
                        ));
                    }
                    _ => {
                        let payload = rng.bytes(12);
                        let mut padded = Vec::new();
                        let len = u64::try_from(payload.len()).unwrap_or(0);
                        let mut header = [0u8; 8];
                        let written = varint::encode_with_len(len, 8, &mut header).unwrap_or(0);
                        padded.extend_from_slice(&unhex("c000000000000000"));
                        padded.extend_from_slice(header.get(..written).unwrap_or(&[]));
                        padded.extend_from_slice(&payload);
                        input.extend_from_slice(&padded);
                        expected.push(Event::Data(payload));
                    }
                }
            }
            let all = whole(
                StreamKind::Request,
                Role::Client,
                FrameLimits::DEFAULT,
                &input,
                true,
                false,
            );
            assert_eq!(all.0, expected);
            assert_eq!(all.1, Outcome::Ok);
            let mut cuts: Vec<usize> = (0..rng.index(8))
                .map(|_| rng.index(input.len().saturating_add(1)))
                .collect();
            cuts.sort_unstable();
            let pieces = split(
                StreamKind::Request,
                Role::Client,
                FrameLimits::DEFAULT,
                &input,
                true,
                false,
                &cuts,
            );
            assert_eq!(pieces, all, "{input:02x?} cut at {cuts:?}");
        }
    }

    /// RFC 9114 Section 7.1: arbitrary octets read as HTTP/3 frames on any
    /// stream and role never panic the decoder, and whole and one-octet
    /// decoding reach the same frames and the same verdict.
    #[test]
    fn arbitrary_octets_never_panic_the_frame_decoder() {
        let mut rng = Rng::new(0x5EED_000D);
        let kinds = [
            (StreamKind::Control, Role::Server),
            (StreamKind::Control, Role::Client),
            (StreamKind::Request, Role::Server),
            (StreamKind::Request, Role::Client),
            (StreamKind::Push, Role::Client),
        ];
        let small = FrameLimits {
            field_section: 16,
            settings: 32,
        };
        for _ in 0..iterations(4_000) {
            let (kind, role) = kinds
                .get(rng.index(kinds.len()))
                .copied()
                .unwrap_or((StreamKind::Request, Role::Server));
            let mut input = if matches!(kind, StreamKind::Control) && rng.below(2) == 0 {
                settings()
            } else {
                Vec::new()
            };
            if rng.below(2) == 0 && !matches!(kind, StreamKind::Control) {
                input.extend_from_slice(&headers());
            }
            input.extend_from_slice(&rng.bytes(48));
            let limits = if rng.below(2) == 0 {
                small
            } else {
                FrameLimits::DEFAULT
            };
            let tunnel = rng.below(4) == 0;
            let all = whole(kind, role, limits, &input, true, tunnel);
            let cuts: Vec<usize> = (1..input.len()).collect();
            let bytewise = split(kind, role, limits, &input, true, tunnel, &cuts);
            assert_eq!(all, bytewise, "{kind:?} {role:?} {input:02x?}");
        }
    }
}
