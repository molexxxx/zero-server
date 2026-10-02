//! HTTP/3 error codes and the errors this codec reports for received bytes.
//!
//! Every [`Error`] is a peer's violation of RFC 9114, RFC 9204 Section 4.2 or
//! RFC 9297, or a frame beyond a local limit that RFC 9114 Section 10.5 lets
//! an endpoint enforce ([`Error::ExcessiveLoad`], H3_EXCESSIVE_LOAD), and
//! carries the error code and scope the specification names: a connection
//! error closes the whole connection, a stream error only the stream. Local
//! misuse, such as encoding a value above 2^62-1, is never an `Error`; the
//! encoders return `None` instead.
//!
//! A received error code is interpreted through [`ErrorCode::on_receipt`]:
//! "receipt of an unknown error code MUST be treated as equivalent to
//! H3_NO_ERROR" (RFC 9114 Section 8), the reserved codes 0x1f * N + 0x21
//! among them (Section 8.1).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-8>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-8.1>

use core::fmt;

use crate::decoder::StreamKind;
use crate::frame::FrameType;
use crate::reserved;
use crate::stream::StreamType;

/// A value of the HTTP/3 Error Codes registry.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-8.1>
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ErrorCode(pub u64);

impl ErrorCode {
    /// H3_DATAGRAM_ERROR (0x33): a datagram or the Capsule Protocol was
    /// misused (RFC 9297 Section 5.2).
    pub const H3_DATAGRAM_ERROR: Self = Self(0x33);
    /// H3_NO_ERROR (0x0100): no error.
    pub const H3_NO_ERROR: Self = Self(0x0100);
    /// H3_GENERAL_PROTOCOL_ERROR (0x0101): a protocol violation with no more
    /// specific code.
    pub const H3_GENERAL_PROTOCOL_ERROR: Self = Self(0x0101);
    /// H3_INTERNAL_ERROR (0x0102): an internal error in the HTTP stack.
    pub const H3_INTERNAL_ERROR: Self = Self(0x0102);
    /// H3_STREAM_CREATION_ERROR (0x0103): the peer created a stream that is
    /// not accepted.
    pub const H3_STREAM_CREATION_ERROR: Self = Self(0x0103);
    /// H3_CLOSED_CRITICAL_STREAM (0x0104): a stream the connection requires
    /// was closed or reset.
    pub const H3_CLOSED_CRITICAL_STREAM: Self = Self(0x0104);
    /// H3_FRAME_UNEXPECTED (0x0105): a frame not permitted in the current
    /// state or on the current stream.
    pub const H3_FRAME_UNEXPECTED: Self = Self(0x0105);
    /// H3_FRAME_ERROR (0x0106): a frame that violates its layout or size
    /// rules.
    pub const H3_FRAME_ERROR: Self = Self(0x0106);
    /// H3_EXCESSIVE_LOAD (0x0107): the peer's behavior might be generating
    /// excessive load.
    pub const H3_EXCESSIVE_LOAD: Self = Self(0x0107);
    /// H3_ID_ERROR (0x0108): a stream ID or push ID used incorrectly.
    pub const H3_ID_ERROR: Self = Self(0x0108);
    /// H3_SETTINGS_ERROR (0x0109): a SETTINGS frame with invalid values.
    pub const H3_SETTINGS_ERROR: Self = Self(0x0109);
    /// H3_MISSING_SETTINGS (0x010a): no SETTINGS frame at the start of the
    /// control stream.
    pub const H3_MISSING_SETTINGS: Self = Self(0x010A);
    /// H3_REQUEST_REJECTED (0x010b): the request was not processed.
    pub const H3_REQUEST_REJECTED: Self = Self(0x010B);
    /// H3_REQUEST_CANCELLED (0x010c): the data is no longer needed; the
    /// registered spelling.
    pub const H3_REQUEST_CANCELLED: Self = Self(0x010C);
    /// H3_REQUEST_INCOMPLETE (0x010d): the stream ended without a complete
    /// request.
    pub const H3_REQUEST_INCOMPLETE: Self = Self(0x010D);
    /// H3_MESSAGE_ERROR (0x010e): a malformed message.
    pub const H3_MESSAGE_ERROR: Self = Self(0x010E);
    /// H3_CONNECT_ERROR (0x010f): the connection of a CONNECT request was
    /// reset or closed abnormally.
    pub const H3_CONNECT_ERROR: Self = Self(0x010F);
    /// H3_VERSION_FALLBACK (0x0110): retry over HTTP/1.1.
    pub const H3_VERSION_FALLBACK: Self = Self(0x0110);
    /// QPACK_DECOMPRESSION_FAILED (0x0200): an encoded field section could
    /// not be interpreted (RFC 9204 Section 6).
    pub const QPACK_DECOMPRESSION_FAILED: Self = Self(0x0200);
    /// QPACK_ENCODER_STREAM_ERROR (0x0201): an encoder instruction could not
    /// be interpreted (RFC 9204 Section 6).
    pub const QPACK_ENCODER_STREAM_ERROR: Self = Self(0x0201);
    /// QPACK_DECODER_STREAM_ERROR (0x0202): a decoder instruction could not
    /// be interpreted (RFC 9204 Section 6).
    pub const QPACK_DECODER_STREAM_ERROR: Self = Self(0x0202);

    /// The registered name of the code.
    ///
    /// # Returns
    ///
    /// The name, or `None` for a value this codec does not know, reserved
    /// values included.
    #[must_use]
    pub const fn name(self) -> Option<&'static str> {
        Some(match self.0 {
            0x33 => "H3_DATAGRAM_ERROR",
            0x0100 => "H3_NO_ERROR",
            0x0101 => "H3_GENERAL_PROTOCOL_ERROR",
            0x0102 => "H3_INTERNAL_ERROR",
            0x0103 => "H3_STREAM_CREATION_ERROR",
            0x0104 => "H3_CLOSED_CRITICAL_STREAM",
            0x0105 => "H3_FRAME_UNEXPECTED",
            0x0106 => "H3_FRAME_ERROR",
            0x0107 => "H3_EXCESSIVE_LOAD",
            0x0108 => "H3_ID_ERROR",
            0x0109 => "H3_SETTINGS_ERROR",
            0x010A => "H3_MISSING_SETTINGS",
            0x010B => "H3_REQUEST_REJECTED",
            0x010C => "H3_REQUEST_CANCELLED",
            0x010D => "H3_REQUEST_INCOMPLETE",
            0x010E => "H3_MESSAGE_ERROR",
            0x010F => "H3_CONNECT_ERROR",
            0x0110 => "H3_VERSION_FALLBACK",
            0x0200 => "QPACK_DECOMPRESSION_FAILED",
            0x0201 => "QPACK_ENCODER_STREAM_ERROR",
            0x0202 => "QPACK_DECODER_STREAM_ERROR",
            _ => return None,
        })
    }

    /// Whether the value has the reserved form 0x1f * N + 0x21.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-8.1>
    #[must_use]
    pub const fn is_reserved(self) -> bool {
        reserved::is_reserved(self.0)
    }

    /// The code a received value is treated as.
    ///
    /// # Returns
    ///
    /// The code itself when this codec knows it, [`Self::H3_NO_ERROR`]
    /// otherwise: "receipt of an unknown error code MUST be treated as
    /// equivalent to H3_NO_ERROR" (RFC 9114 Section 8).
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-8>
    #[must_use]
    pub const fn on_receipt(self) -> Self {
        if self.name().is_some() {
            self
        } else {
            Self::H3_NO_ERROR
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.name() {
            Some(name) => write!(f, "{name} (0x{:x})", self.0),
            None => write!(f, "0x{:x}", self.0),
        }
    }
}

/// Whether an error closes the connection or only the stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// A connection error: the whole connection is closed.
    Connection,
    /// A stream error: only the stream is reset.
    Stream,
}

/// A received byte sequence that violates RFC 9114, RFC 9204 Section 4.2 or
/// RFC 9297, or that exceeds a local limit RFC 9114 Section 10.5 lets an
/// endpoint enforce ([`Error::ExcessiveLoad`]).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-10.5>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    /// A frame payload ended before its fields: H3_FRAME_ERROR (RFC 9114
    /// Section 7.1).
    PayloadTruncated {
        /// The frame type.
        frame_type: u64,
    },
    /// A frame payload had octets after its fields: H3_FRAME_ERROR (RFC 9114
    /// Section 7.1).
    PayloadTrailing {
        /// The frame type.
        frame_type: u64,
    },
    /// The stream ended cleanly inside a frame: H3_FRAME_ERROR (RFC 9114
    /// Section 7.1).
    StreamEndedInFrame,
    /// A known frame type on a stream that does not permit it:
    /// H3_FRAME_UNEXPECTED (RFC 9114 Sections 7.2.1 to 7.2.7 and 4.1).
    WrongStream {
        /// The frame type.
        frame_type: u64,
        /// The stream it arrived on.
        stream: StreamKind,
    },
    /// PUSH_PROMISE received by a server or MAX_PUSH_ID received by a
    /// client: H3_FRAME_UNEXPECTED (RFC 9114 Sections 7.2.5 and 7.2.7).
    WrongRole {
        /// The frame type.
        frame_type: u64,
    },
    /// A frame type reserved from HTTP/2: H3_FRAME_UNEXPECTED (RFC 9114
    /// Section 7.2.8).
    ReservedFrameType {
        /// The frame type: 0x02, 0x06, 0x08 or 0x09.
        frame_type: u64,
    },
    /// A second SETTINGS frame on the control stream: H3_FRAME_UNEXPECTED
    /// (RFC 9114 Section 7.2.4).
    SecondSettings,
    /// A frame out of the message sequence of a request or push stream, or
    /// a known frame other than DATA after a CONNECT completed:
    /// H3_FRAME_UNEXPECTED (RFC 9114 Sections 4.1 and 4.4).
    OutOfSequence {
        /// The frame type.
        frame_type: u64,
    },
    /// A control stream whose first frame is not SETTINGS:
    /// H3_MISSING_SETTINGS (RFC 9114 Section 6.2.1).
    MissingSettings {
        /// The type of the first frame.
        frame_type: u64,
    },
    /// A setting identifier reserved from HTTP/2: H3_SETTINGS_ERROR (RFC 9114
    /// Section 7.2.4.1).
    ReservedSetting {
        /// The identifier: 0x02, 0x03, 0x04 or 0x05.
        id: u64,
    },
    /// A setting identifier that occurs more than once: H3_SETTINGS_ERROR
    /// (RFC 9114 Section 7.2.4).
    DuplicateSetting {
        /// The repeated identifier.
        id: u64,
    },
    /// A setting value outside its range: H3_SETTINGS_ERROR (RFC 9297 Section
    /// 2.1.1, RFC 8441 Section 3 through RFC 9220 Section 3).
    SettingValue {
        /// The identifier.
        id: u64,
        /// The value received.
        value: u64,
    },
    /// A frame longer than a local limit: H3_EXCESSIVE_LOAD (RFC 9114 Section
    /// 10.5).
    ExcessiveLoad {
        /// The frame type.
        frame_type: u64,
        /// The frame length.
        len: u64,
    },
    /// A GOAWAY a client received whose stream ID is not client-initiated
    /// bidirectional: H3_ID_ERROR (RFC 9114 Section 7.2.6).
    GoawayStreamType {
        /// The identifier received.
        id: u64,
    },
    /// A GOAWAY with a larger identifier than before: H3_ID_ERROR (RFC 9114
    /// Section 5.2).
    GoawayIncreased {
        /// The identifier received.
        id: u64,
        /// The identifier of the previous GOAWAY.
        previous: u64,
    },
    /// A MAX_PUSH_ID smaller than before: H3_ID_ERROR (RFC 9114 Section
    /// 7.2.7).
    MaxPushIdDecreased {
        /// The push ID received.
        push_id: u64,
        /// The previous maximum push ID.
        previous: u64,
    },
    /// A CANCEL_PUSH above the maximum push ID: H3_ID_ERROR (RFC 9114 Section
    /// 7.2.3).
    PushIdAboveMaximum {
        /// The push ID received.
        push_id: u64,
    },
    /// A CANCEL_PUSH a server received for a push it never promised:
    /// H3_ID_ERROR (RFC 9114 Section 7.2.3).
    PushIdNotPromised {
        /// The push ID received.
        push_id: u64,
    },
    /// A second control, QPACK encoder or QPACK decoder stream:
    /// H3_STREAM_CREATION_ERROR (RFC 9114 Section 6.2.1, RFC 9204 Section
    /// 4.2).
    SecondCriticalStream {
        /// The stream type: 0x00, 0x02 or 0x03.
        stream_type: u64,
    },
    /// A push stream a server received: H3_STREAM_CREATION_ERROR (RFC 9114
    /// Section 6.2.2).
    PushStreamFromClient,
    /// The closure of a control, QPACK encoder or QPACK decoder stream:
    /// H3_CLOSED_CRITICAL_STREAM (RFC 9114 Section 6.2.1, RFC 9204 Section
    /// 4.2).
    CriticalStreamClosed {
        /// The stream type: 0x00, 0x02 or 0x03.
        stream_type: u64,
    },
    /// A request stream that ended before its HEADERS frame: a stream error
    /// of type H3_REQUEST_INCOMPLETE (RFC 9114 Section 4.1).
    RequestIncomplete,
    /// A datagram too short for its Quarter Stream ID: H3_DATAGRAM_ERROR (RFC
    /// 9297 Section 2.1).
    DatagramTooShort,
    /// A Quarter Stream ID above 2^60-1: H3_DATAGRAM_ERROR (RFC 9297 Section
    /// 2.1).
    QuarterStreamIdTooLarge {
        /// The Quarter Stream ID received.
        value: u64,
    },
    /// A stream that ended cleanly inside a capsule: a malformed message, a
    /// stream error of type H3_MESSAGE_ERROR (RFC 9297 Section 3.3, RFC 9114
    /// Section 4.1.2).
    CapsuleTruncated,
}

impl Error {
    /// The error code the specification names for the violation.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::PayloadTruncated { .. }
            | Self::PayloadTrailing { .. }
            | Self::StreamEndedInFrame => ErrorCode::H3_FRAME_ERROR,
            Self::WrongStream { .. }
            | Self::WrongRole { .. }
            | Self::ReservedFrameType { .. }
            | Self::SecondSettings
            | Self::OutOfSequence { .. } => ErrorCode::H3_FRAME_UNEXPECTED,
            Self::MissingSettings { .. } => ErrorCode::H3_MISSING_SETTINGS,
            Self::ReservedSetting { .. }
            | Self::DuplicateSetting { .. }
            | Self::SettingValue { .. } => ErrorCode::H3_SETTINGS_ERROR,
            Self::ExcessiveLoad { .. } => ErrorCode::H3_EXCESSIVE_LOAD,
            Self::GoawayStreamType { .. }
            | Self::GoawayIncreased { .. }
            | Self::MaxPushIdDecreased { .. }
            | Self::PushIdAboveMaximum { .. }
            | Self::PushIdNotPromised { .. } => ErrorCode::H3_ID_ERROR,
            Self::SecondCriticalStream { .. } | Self::PushStreamFromClient => {
                ErrorCode::H3_STREAM_CREATION_ERROR
            }
            Self::CriticalStreamClosed { .. } => ErrorCode::H3_CLOSED_CRITICAL_STREAM,
            Self::RequestIncomplete => ErrorCode::H3_REQUEST_INCOMPLETE,
            Self::DatagramTooShort | Self::QuarterStreamIdTooLarge { .. } => {
                ErrorCode::H3_DATAGRAM_ERROR
            }
            Self::CapsuleTruncated => ErrorCode::H3_MESSAGE_ERROR,
        }
    }

    /// Whether the error closes the connection or only the stream: only
    /// [`Self::RequestIncomplete`] and [`Self::CapsuleTruncated`] are stream
    /// errors.
    #[must_use]
    pub const fn scope(&self) -> Scope {
        match self {
            Self::RequestIncomplete | Self::CapsuleTruncated => Scope::Stream,
            _ => Scope::Connection,
        }
    }

    /// The camelCase name used in conformance vectors.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::PayloadTruncated { .. } => "payloadTruncated",
            Self::PayloadTrailing { .. } => "payloadTrailing",
            Self::StreamEndedInFrame => "streamEndedInFrame",
            Self::WrongStream { .. } => "wrongStream",
            Self::WrongRole { .. } => "wrongRole",
            Self::ReservedFrameType { .. } => "reservedFrameType",
            Self::SecondSettings => "secondSettings",
            Self::OutOfSequence { .. } => "outOfSequence",
            Self::MissingSettings { .. } => "missingSettings",
            Self::ReservedSetting { .. } => "reservedSetting",
            Self::DuplicateSetting { .. } => "duplicateSetting",
            Self::SettingValue { .. } => "settingValue",
            Self::ExcessiveLoad { .. } => "excessiveLoad",
            Self::GoawayStreamType { .. } => "goawayStreamType",
            Self::GoawayIncreased { .. } => "goawayIncreased",
            Self::MaxPushIdDecreased { .. } => "maxPushIdDecreased",
            Self::PushIdAboveMaximum { .. } => "pushIdAboveMaximum",
            Self::PushIdNotPromised { .. } => "pushIdNotPromised",
            Self::SecondCriticalStream { .. } => "secondCriticalStream",
            Self::PushStreamFromClient => "pushStreamFromClient",
            Self::CriticalStreamClosed { .. } => "criticalStreamClosed",
            Self::RequestIncomplete => "requestIncomplete",
            Self::DatagramTooShort => "datagramTooShort",
            Self::QuarterStreamIdTooLarge { .. } => "quarterStreamIdTooLarge",
            Self::CapsuleTruncated => "capsuleTruncated",
        }
    }
}

/// A frame type written by name when the codec defines it.
struct FrameLabel(u64);

impl fmt::Display for FrameLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match FrameType(self.0) {
            FrameType::DATA => "DATA",
            FrameType::HEADERS => "HEADERS",
            FrameType::CANCEL_PUSH => "CANCEL_PUSH",
            FrameType::SETTINGS => "SETTINGS",
            FrameType::PUSH_PROMISE => "PUSH_PROMISE",
            FrameType::GOAWAY => "GOAWAY",
            FrameType::MAX_PUSH_ID => "MAX_PUSH_ID",
            _ => return write!(f, "frame type 0x{:x}", self.0),
        };
        f.write_str(name)
    }
}

/// The section of RFC 9114 that rules a known frame type out on a stream.
const fn wrong_stream_section(frame_type: u64, stream: StreamKind) -> &'static str {
    match (FrameType(frame_type), stream) {
        (FrameType::DATA, _) => "RFC 9114 Section 7.2.1",
        (FrameType::HEADERS, _) => "RFC 9114 Section 7.2.2",
        (FrameType::CANCEL_PUSH, _) => "RFC 9114 Section 7.2.3",
        (FrameType::SETTINGS, _) => "RFC 9114 Section 7.2.4",
        (FrameType::PUSH_PROMISE, StreamKind::Push) => "RFC 9114 Section 4.1",
        (FrameType::PUSH_PROMISE, _) => "RFC 9114 Section 7.2.5",
        (FrameType::GOAWAY, _) => "RFC 9114 Section 7.2.6",
        (FrameType::MAX_PUSH_ID, _) => "RFC 9114 Section 7.2.7",
        _ => "RFC 9114 Section 7",
    }
}

/// The name of a stream a frame decoder reads.
const fn stream_name(stream: StreamKind) -> &'static str {
    match stream {
        StreamKind::Control => "control",
        StreamKind::Request => "request",
        StreamKind::Push => "push",
    }
}

/// The name and governing section of a critical stream type.
const fn critical_stream(stream_type: u64) -> (&'static str, &'static str) {
    match StreamType::from_value(stream_type) {
        StreamType::Control => ("control", "RFC 9114 Section 6.2.1"),
        StreamType::QpackEncoder => ("QPACK encoder", "RFC 9204 Section 4.2"),
        StreamType::QpackDecoder => ("QPACK decoder", "RFC 9204 Section 4.2"),
        _ => ("unidirectional", "RFC 9114 Section 6.2"),
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: ", self.code())?;
        match *self {
            Self::PayloadTruncated { frame_type } => write!(
                f,
                "{} payload ends before its fields (RFC 9114 Section 7.1)",
                FrameLabel(frame_type)
            ),
            Self::PayloadTrailing { frame_type } => write!(
                f,
                "{} payload has octets after its fields (RFC 9114 Section 7.1)",
                FrameLabel(frame_type)
            ),
            Self::StreamEndedInFrame => {
                f.write_str("the stream ended inside a frame (RFC 9114 Section 7.1)")
            }
            Self::WrongStream { frame_type, stream } => write!(
                f,
                "{} frame on the {} stream ({})",
                FrameLabel(frame_type),
                stream_name(stream),
                wrong_stream_section(frame_type, stream)
            ),
            Self::WrongRole { frame_type } => {
                if frame_type == FrameType::PUSH_PROMISE.0 {
                    f.write_str("a server received a PUSH_PROMISE frame (RFC 9114 Section 7.2.5)")
                } else {
                    write!(
                        f,
                        "a client received a {} frame (RFC 9114 Section 7.2.7)",
                        FrameLabel(frame_type)
                    )
                }
            }
            Self::ReservedFrameType { frame_type } => write!(
                f,
                "frame type 0x{frame_type:x} is reserved from HTTP/2 (RFC 9114 Section 7.2.8)"
            ),
            Self::SecondSettings => f.write_str(
                "a second SETTINGS frame on the control stream (RFC 9114 Section 7.2.4)",
            ),
            Self::OutOfSequence { frame_type } => write!(
                f,
                "{} frame out of sequence on a request or push stream (RFC 9114 Sections 4.1 and 4.4)",
                FrameLabel(frame_type)
            ),
            Self::MissingSettings { frame_type } => write!(
                f,
                "the first frame of the control stream is {}, not SETTINGS (RFC 9114 Section 6.2.1)",
                FrameLabel(frame_type)
            ),
            Self::ReservedSetting { id } => write!(
                f,
                "setting 0x{id:x} is reserved from HTTP/2 (RFC 9114 Section 7.2.4.1)"
            ),
            Self::DuplicateSetting { id } => write!(
                f,
                "setting 0x{id:x} occurs more than once (RFC 9114 Section 7.2.4)"
            ),
            Self::SettingValue { id, value } => {
                let section = if id == crate::settings::SETTINGS_H3_DATAGRAM {
                    "RFC 9297 Section 2.1.1"
                } else {
                    "RFC 8441 Section 3, RFC 9220 Section 3"
                };
                write!(
                    f,
                    "setting 0x{id:x} has the value {value}, not 0 or 1 ({section})"
                )
            }
            Self::ExcessiveLoad { frame_type, len } => write!(
                f,
                "{} frame of {len} octets exceeds the local limit (RFC 9114 Section 10.5)",
                FrameLabel(frame_type)
            ),
            Self::GoawayStreamType { id } => write!(
                f,
                "GOAWAY stream ID {id} is not a client-initiated bidirectional stream (RFC 9114 Section 7.2.6)"
            ),
            Self::GoawayIncreased { id, previous } => write!(
                f,
                "GOAWAY identifier {id} is larger than the previous {previous} (RFC 9114 Section 5.2)"
            ),
            Self::MaxPushIdDecreased { push_id, previous } => write!(
                f,
                "MAX_PUSH_ID {push_id} is smaller than the previous {previous} (RFC 9114 Section 7.2.7)"
            ),
            Self::PushIdAboveMaximum { push_id } => write!(
                f,
                "CANCEL_PUSH push ID {push_id} is above the maximum push ID (RFC 9114 Section 7.2.3)"
            ),
            Self::PushIdNotPromised { push_id } => write!(
                f,
                "CANCEL_PUSH push ID {push_id} was never promised (RFC 9114 Section 7.2.3)"
            ),
            Self::SecondCriticalStream { stream_type } => {
                let (name, section) = critical_stream(stream_type);
                write!(f, "a second {name} stream ({section})")
            }
            Self::PushStreamFromClient => {
                f.write_str("a client-initiated push stream (RFC 9114 Section 6.2.2)")
            }
            Self::CriticalStreamClosed { stream_type } => {
                let (name, section) = critical_stream(stream_type);
                write!(f, "the {name} stream was closed ({section})")
            }
            Self::RequestIncomplete => f.write_str(
                "the request stream ended before its HEADERS frame (RFC 9114 Section 4.1)",
            ),
            Self::DatagramTooShort => f.write_str(
                "the datagram is too short for its Quarter Stream ID (RFC 9297 Section 2.1)",
            ),
            Self::QuarterStreamIdTooLarge { value } => write!(
                f,
                "Quarter Stream ID {value} is above 2^60-1 (RFC 9297 Section 2.1)"
            ),
            Self::CapsuleTruncated => {
                f.write_str("the stream ended inside a capsule (RFC 9297 Section 3.3)")
            }
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Error {}

impl From<Error> for zero_core::Error {
    fn from(error: Error) -> Self {
        match error {
            Error::ExcessiveLoad { .. } => Self::Limit(alloc::format!("{error}")),
            _ => Self::Protocol(alloc::format!("{error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use alloc::string::ToString;

    use super::{Error, ErrorCode, Scope};
    use crate::decoder::StreamKind;
    use crate::reserved;
    use crate::xorshift::{iterations, Rng};

    /// RFC 9114 Section 8: "Because new error codes can be defined without
    /// negotiation (see Section 9), use of an error code in an unexpected
    /// context or receipt of an unknown error code MUST be treated as
    /// equivalent to H3_NO_ERROR."
    #[test]
    fn an_unknown_or_reserved_error_code_is_treated_as_h3_no_error() {
        for unknown in [0u64, 0x21, 0x32, 0x34, 0xFF, 0x0111, 0x01FF, 0x0203, 0x1000] {
            assert_eq!(
                ErrorCode(unknown).on_receipt(),
                ErrorCode::H3_NO_ERROR,
                "{unknown}"
            );
        }
        assert!(ErrorCode(0x21).is_reserved());
        assert_eq!(ErrorCode(0x21).name(), None);
        let mut rng = Rng::new(0x5EED_0004);
        for _ in 0..iterations(2_000) {
            let n = rng.below(reserved::MAX_N);
            let code = ErrorCode(reserved::reserved(n).unwrap_or(0x21));
            assert!(code.is_reserved());
            assert_eq!(code.on_receipt(), ErrorCode::H3_NO_ERROR, "{code:?}");
        }
        for known in [
            ErrorCode::H3_FRAME_UNEXPECTED,
            ErrorCode::H3_NO_ERROR,
            ErrorCode::H3_DATAGRAM_ERROR,
            ErrorCode::QPACK_DECODER_STREAM_ERROR,
        ] {
            assert_eq!(known.on_receipt(), known);
        }
    }

    /// RFC 9114 Section 8.1: "H3_NO_ERROR (0x0100): No error. This is used
    /// when the connection or stream needs to be closed, but there is no
    /// error to signal."
    #[test]
    fn http_3_error_codes_carry_the_registered_values() {
        let registered: [(ErrorCode, u64, &str); 21] = [
            (ErrorCode::H3_DATAGRAM_ERROR, 0x33, "H3_DATAGRAM_ERROR"),
            (ErrorCode::H3_NO_ERROR, 0x0100, "H3_NO_ERROR"),
            (
                ErrorCode::H3_GENERAL_PROTOCOL_ERROR,
                0x0101,
                "H3_GENERAL_PROTOCOL_ERROR",
            ),
            (ErrorCode::H3_INTERNAL_ERROR, 0x0102, "H3_INTERNAL_ERROR"),
            (
                ErrorCode::H3_STREAM_CREATION_ERROR,
                0x0103,
                "H3_STREAM_CREATION_ERROR",
            ),
            (
                ErrorCode::H3_CLOSED_CRITICAL_STREAM,
                0x0104,
                "H3_CLOSED_CRITICAL_STREAM",
            ),
            (
                ErrorCode::H3_FRAME_UNEXPECTED,
                0x0105,
                "H3_FRAME_UNEXPECTED",
            ),
            (ErrorCode::H3_FRAME_ERROR, 0x0106, "H3_FRAME_ERROR"),
            (ErrorCode::H3_EXCESSIVE_LOAD, 0x0107, "H3_EXCESSIVE_LOAD"),
            (ErrorCode::H3_ID_ERROR, 0x0108, "H3_ID_ERROR"),
            (ErrorCode::H3_SETTINGS_ERROR, 0x0109, "H3_SETTINGS_ERROR"),
            (
                ErrorCode::H3_MISSING_SETTINGS,
                0x010A,
                "H3_MISSING_SETTINGS",
            ),
            (
                ErrorCode::H3_REQUEST_REJECTED,
                0x010B,
                "H3_REQUEST_REJECTED",
            ),
            (
                ErrorCode::H3_REQUEST_CANCELLED,
                0x010C,
                "H3_REQUEST_CANCELLED",
            ),
            (
                ErrorCode::H3_REQUEST_INCOMPLETE,
                0x010D,
                "H3_REQUEST_INCOMPLETE",
            ),
            (ErrorCode::H3_MESSAGE_ERROR, 0x010E, "H3_MESSAGE_ERROR"),
            (ErrorCode::H3_CONNECT_ERROR, 0x010F, "H3_CONNECT_ERROR"),
            (
                ErrorCode::H3_VERSION_FALLBACK,
                0x0110,
                "H3_VERSION_FALLBACK",
            ),
            (
                ErrorCode::QPACK_DECOMPRESSION_FAILED,
                0x0200,
                "QPACK_DECOMPRESSION_FAILED",
            ),
            (
                ErrorCode::QPACK_ENCODER_STREAM_ERROR,
                0x0201,
                "QPACK_ENCODER_STREAM_ERROR",
            ),
            (
                ErrorCode::QPACK_DECODER_STREAM_ERROR,
                0x0202,
                "QPACK_DECODER_STREAM_ERROR",
            ),
        ];
        for (code, value, name) in registered {
            assert_eq!(code.0, value, "{name}");
            assert_eq!(code.name(), Some(name));
            assert!(!code.is_reserved(), "{name}");
            assert_eq!(code.on_receipt(), code);
        }
        assert_eq!(
            ErrorCode::H3_FRAME_UNEXPECTED.to_string(),
            "H3_FRAME_UNEXPECTED (0x105)"
        );
        assert_eq!(ErrorCode(0x21).to_string(), "0x21");
    }

    /// RFC 9114 Section 8 separates a "stream error" from a "connection
    /// error", and each error carries the code of Section 8.1 and the scope
    /// that the section stating its rule names (RFC 9114, RFC 9204 Section 4.2
    /// and RFC 9297 Section 3), with a distinct vector name.
    #[test]
    fn every_error_carries_its_code_scope_and_vector_name() {
        let cases: [(Error, ErrorCode, Scope, &str); 25] = [
            (
                Error::PayloadTruncated { frame_type: 7 },
                ErrorCode::H3_FRAME_ERROR,
                Scope::Connection,
                "payloadTruncated",
            ),
            (
                Error::PayloadTrailing { frame_type: 7 },
                ErrorCode::H3_FRAME_ERROR,
                Scope::Connection,
                "payloadTrailing",
            ),
            (
                Error::StreamEndedInFrame,
                ErrorCode::H3_FRAME_ERROR,
                Scope::Connection,
                "streamEndedInFrame",
            ),
            (
                Error::WrongStream {
                    frame_type: 0,
                    stream: StreamKind::Control,
                },
                ErrorCode::H3_FRAME_UNEXPECTED,
                Scope::Connection,
                "wrongStream",
            ),
            (
                Error::WrongRole { frame_type: 5 },
                ErrorCode::H3_FRAME_UNEXPECTED,
                Scope::Connection,
                "wrongRole",
            ),
            (
                Error::ReservedFrameType { frame_type: 6 },
                ErrorCode::H3_FRAME_UNEXPECTED,
                Scope::Connection,
                "reservedFrameType",
            ),
            (
                Error::SecondSettings,
                ErrorCode::H3_FRAME_UNEXPECTED,
                Scope::Connection,
                "secondSettings",
            ),
            (
                Error::OutOfSequence { frame_type: 0 },
                ErrorCode::H3_FRAME_UNEXPECTED,
                Scope::Connection,
                "outOfSequence",
            ),
            (
                Error::MissingSettings { frame_type: 7 },
                ErrorCode::H3_MISSING_SETTINGS,
                Scope::Connection,
                "missingSettings",
            ),
            (
                Error::ReservedSetting { id: 2 },
                ErrorCode::H3_SETTINGS_ERROR,
                Scope::Connection,
                "reservedSetting",
            ),
            (
                Error::DuplicateSetting { id: 6 },
                ErrorCode::H3_SETTINGS_ERROR,
                Scope::Connection,
                "duplicateSetting",
            ),
            (
                Error::SettingValue { id: 0x33, value: 2 },
                ErrorCode::H3_SETTINGS_ERROR,
                Scope::Connection,
                "settingValue",
            ),
            (
                Error::ExcessiveLoad {
                    frame_type: 4,
                    len: 5_000,
                },
                ErrorCode::H3_EXCESSIVE_LOAD,
                Scope::Connection,
                "excessiveLoad",
            ),
            (
                Error::GoawayStreamType { id: 2 },
                ErrorCode::H3_ID_ERROR,
                Scope::Connection,
                "goawayStreamType",
            ),
            (
                Error::GoawayIncreased { id: 8, previous: 4 },
                ErrorCode::H3_ID_ERROR,
                Scope::Connection,
                "goawayIncreased",
            ),
            (
                Error::MaxPushIdDecreased {
                    push_id: 1,
                    previous: 2,
                },
                ErrorCode::H3_ID_ERROR,
                Scope::Connection,
                "maxPushIdDecreased",
            ),
            (
                Error::PushIdAboveMaximum { push_id: 3 },
                ErrorCode::H3_ID_ERROR,
                Scope::Connection,
                "pushIdAboveMaximum",
            ),
            (
                Error::PushIdNotPromised { push_id: 3 },
                ErrorCode::H3_ID_ERROR,
                Scope::Connection,
                "pushIdNotPromised",
            ),
            (
                Error::SecondCriticalStream { stream_type: 0 },
                ErrorCode::H3_STREAM_CREATION_ERROR,
                Scope::Connection,
                "secondCriticalStream",
            ),
            (
                Error::PushStreamFromClient,
                ErrorCode::H3_STREAM_CREATION_ERROR,
                Scope::Connection,
                "pushStreamFromClient",
            ),
            (
                Error::CriticalStreamClosed { stream_type: 2 },
                ErrorCode::H3_CLOSED_CRITICAL_STREAM,
                Scope::Connection,
                "criticalStreamClosed",
            ),
            (
                Error::RequestIncomplete,
                ErrorCode::H3_REQUEST_INCOMPLETE,
                Scope::Stream,
                "requestIncomplete",
            ),
            (
                Error::DatagramTooShort,
                ErrorCode::H3_DATAGRAM_ERROR,
                Scope::Connection,
                "datagramTooShort",
            ),
            (
                Error::QuarterStreamIdTooLarge {
                    value: 0x1000_0000_0000_0000,
                },
                ErrorCode::H3_DATAGRAM_ERROR,
                Scope::Connection,
                "quarterStreamIdTooLarge",
            ),
            (
                Error::CapsuleTruncated,
                ErrorCode::H3_MESSAGE_ERROR,
                Scope::Stream,
                "capsuleTruncated",
            ),
        ];
        for (error, code, scope, name) in cases {
            assert_eq!(error.code(), code, "{name}");
            assert_eq!(error.scope(), scope, "{name}");
            assert_eq!(error.name(), name);
            let text = error.to_string();
            assert!(text.starts_with(code.name().unwrap_or("?")), "{text}");
            assert!(text.contains("(RFC "), "{text}");
            let converted = zero_core::Error::from(error);
            match error {
                Error::ExcessiveLoad { .. } => assert!(
                    matches!(&converted, zero_core::Error::Limit(message) if *message == text),
                    "{converted:?}"
                ),
                _ => assert!(
                    matches!(&converted, zero_core::Error::Protocol(message) if *message == text),
                    "{converted:?}"
                ),
            }
        }
        assert_eq!(
            Error::WrongStream { frame_type: 0, stream: StreamKind::Control }.to_string(),
            "H3_FRAME_UNEXPECTED (0x105): DATA frame on the control stream (RFC 9114 Section 7.2.1)"
        );
    }
}
