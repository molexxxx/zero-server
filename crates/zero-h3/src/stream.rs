//! Unidirectional stream types and the rules for the streams a peer opens.
//!
//! A unidirectional stream starts with its stream type, a variable-length
//! integer (RFC 9114 Section 6.2): 0x00 control (Section 6.2.1), 0x01 push
//! (Section 6.2.2), 0x02 QPACK encoder and 0x03 QPACK decoder (RFC 9204
//! Section 4.2). The rules on the streams a peer opens:
//!
//! - at most one control, one encoder and one decoder stream per peer, a
//!   second being H3_STREAM_CREATION_ERROR, and the closure of any of them
//!   H3_CLOSED_CRITICAL_STREAM (RFC 9114 Section 6.2.1, RFC 9204 Section
//!   4.2);
//! - only servers push, so a server that receives a push stream answers
//!   H3_STREAM_CREATION_ERROR (RFC 9114 Section 6.2.2);
//! - the encoder and decoder streams are accepted even when the settings
//!   prevent their use (RFC 9204 Section 4.2);
//! - an unknown or reserved stream type is discarded and never a connection
//!   error (RFC 9114 Sections 6.2 and 6.2.3);
//! - a stream closed before its type arrived is tolerated (RFC 9114 Section
//!   6.2).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-6.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.2>

use crate::decoder::Role;
use crate::error::Error;
use crate::{reserved, varint};

/// A unidirectional stream type.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-11.2.4>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamType {
    /// 0x00, a control stream (RFC 9114 Section 6.2.1).
    Control,
    /// 0x01, a push stream (RFC 9114 Section 6.2.2).
    Push,
    /// 0x02, a QPACK encoder stream (RFC 9204 Section 4.2).
    QpackEncoder,
    /// 0x03, a QPACK decoder stream (RFC 9204 Section 4.2).
    QpackDecoder,
    /// A reserved type 0x1f * N + 0x21, which carries no meaning (RFC 9114
    /// Section 6.2.3).
    Reserved(u64),
    /// Any other type, unknown to this codec.
    Unknown(u64),
}

impl StreamType {
    /// Classifies a stream type value.
    ///
    /// # Arguments
    ///
    /// * `value` - the stream type a stream started with.
    #[must_use]
    pub const fn from_value(value: u64) -> Self {
        match value {
            0x00 => Self::Control,
            0x01 => Self::Push,
            0x02 => Self::QpackEncoder,
            0x03 => Self::QpackDecoder,
            _ if reserved::is_reserved(value) => Self::Reserved(value),
            _ => Self::Unknown(value),
        }
    }

    /// The stream type value.
    #[must_use]
    pub const fn value(self) -> u64 {
        match self {
            Self::Control => 0x00,
            Self::Push => 0x01,
            Self::QpackEncoder => 0x02,
            Self::QpackDecoder => 0x03,
            Self::Reserved(value) | Self::Unknown(value) => value,
        }
    }

    /// Whether the stream is critical: control, QPACK encoder or QPACK
    /// decoder, whose closure is a connection error.
    #[must_use]
    pub const fn is_critical(self) -> bool {
        matches!(
            self,
            Self::Control | Self::QpackEncoder | Self::QpackDecoder
        )
    }

    /// Parses the stream type at the start of a unidirectional stream; any
    /// encoding length is accepted (RFC 9000 Section 16).
    ///
    /// # Arguments
    ///
    /// * `input` - the octets from the start of the stream.
    ///
    /// # Returns
    ///
    /// The type and the octets it took, or `None` until the integer is
    /// complete. A stream that ends while this is `None` is tolerated, not an
    /// error (RFC 9114 Section 6.2).
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-6.2>
    #[must_use]
    pub fn parse(input: &[u8]) -> Option<(Self, usize)> {
        let (value, len) = varint::decode(input)?;
        Some((Self::from_value(value), len))
    }
}

/// What to do with the rest of a unidirectional stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Frames: hand them to a [`crate::FrameDecoder`] for
    /// [`crate::StreamKind::Control`].
    Control,
    /// A push stream (client only): read the push ID integer, then frames.
    Push,
    /// Encoder instructions, for a QPACK encoder stream receiver.
    QpackEncoder,
    /// Decoder instructions, for a QPACK decoder stream receiver.
    QpackDecoder,
    /// An unknown or reserved type: discard the data or abort reading; never
    /// a connection error.
    Discard,
}

/// The unidirectional streams one peer opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UniStreams {
    local: Role,
    control: bool,
    encoder: bool,
    decoder: bool,
}

impl UniStreams {
    /// Starts with no streams opened.
    ///
    /// # Arguments
    ///
    /// * `local` - the role of the local endpoint, which receives the
    ///   streams.
    #[must_use]
    pub const fn new(local: Role) -> Self {
        Self {
            local,
            control: false,
            encoder: false,
            decoder: false,
        }
    }

    /// Registers a new stream of the peer.
    ///
    /// # Arguments
    ///
    /// * `stream_type` - the type the stream started with.
    ///
    /// # Returns
    ///
    /// What to do with the rest of the stream.
    ///
    /// # Errors
    ///
    /// [`Error::SecondCriticalStream`] for a second control, encoder or
    /// decoder stream, and [`Error::PushStreamFromClient`] when the local
    /// endpoint is a server and the stream is a push stream.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-6.2.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-6.2.2>
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.2>
    pub fn open(&mut self, stream_type: StreamType) -> Result<Disposition, Error> {
        let (seen, disposition) = match stream_type {
            StreamType::Control => (&mut self.control, Disposition::Control),
            StreamType::QpackEncoder => (&mut self.encoder, Disposition::QpackEncoder),
            StreamType::QpackDecoder => (&mut self.decoder, Disposition::QpackDecoder),
            StreamType::Push => {
                return match self.local {
                    Role::Server => Err(Error::PushStreamFromClient),
                    Role::Client => Ok(Disposition::Push),
                };
            }
            StreamType::Reserved(_) | StreamType::Unknown(_) => return Ok(Disposition::Discard),
        };
        if *seen {
            return Err(Error::SecondCriticalStream {
                stream_type: stream_type.value(),
            });
        }
        *seen = true;
        Ok(disposition)
    }

    /// Checks the closure of a stream the peer opened.
    ///
    /// # Arguments
    ///
    /// * `stream_type` - the type of the closed stream; a stream closed
    ///   before its type arrived is never passed here.
    ///
    /// # Errors
    ///
    /// [`Error::CriticalStreamClosed`] for a control, encoder or decoder
    /// stream.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-6.2.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc9204.html#section-4.2>
    pub const fn closed(&self, stream_type: StreamType) -> Result<(), Error> {
        if stream_type.is_critical() {
            Err(Error::CriticalStreamClosed {
                stream_type: stream_type.value(),
            })
        } else {
            Ok(())
        }
    }
}

/// Whether a QUIC stream was initiated by the client: its least significant
/// bit is 0.
///
/// # Arguments
///
/// * `stream_id` - the QUIC stream ID.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9000.html#section-2.1>
#[must_use]
pub const fn is_client_initiated(stream_id: u64) -> bool {
    stream_id & 0x01 == 0
}

/// Whether a QUIC stream is bidirectional: its second least significant bit
/// is 0.
///
/// # Arguments
///
/// * `stream_id` - the QUIC stream ID.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9000.html#section-2.1>
#[must_use]
pub const fn is_bidirectional(stream_id: u64) -> bool {
    stream_id & 0x02 == 0
}

#[cfg(test)]
mod tests {
    use super::{is_bidirectional, is_client_initiated, Disposition, StreamType, UniStreams};
    use crate::decoder::Role;
    use crate::error::{Error, ErrorCode};
    use crate::settings::Settings;
    use crate::xorshift::{iterations, unhex, Rng};
    use crate::{reserved, varint};
    use zero_limits::Http3Limits;

    /// RFC 9114 Section 6.2.1: "Only one control stream per peer is permitted;
    /// receipt of a second stream claiming to be a control stream MUST be
    /// treated as a connection error of type H3_STREAM_CREATION_ERROR."
    #[test]
    fn a_second_control_stream_is_h3_stream_creation_error() {
        for local in [Role::Server, Role::Client] {
            let mut streams = UniStreams::new(local);
            assert_eq!(streams.open(StreamType::Control), Ok(Disposition::Control));
            let second = streams.open(StreamType::Control);
            assert_eq!(second, Err(Error::SecondCriticalStream { stream_type: 0 }));
            assert_eq!(
                second.map_err(|error| error.code()),
                Err(ErrorCode::H3_STREAM_CREATION_ERROR)
            );
            assert_eq!(
                streams.open(StreamType::QpackEncoder),
                Ok(Disposition::QpackEncoder)
            );
        }
    }

    /// RFC 9114 Section 6.2.1: "If either control stream is closed at any point,
    /// this MUST be treated as a connection error of type
    /// H3_CLOSED_CRITICAL_STREAM."
    #[test]
    fn closing_the_control_stream_is_h3_closed_critical_stream() {
        let mut streams = UniStreams::new(Role::Server);
        assert_eq!(streams.open(StreamType::Control), Ok(Disposition::Control));
        let closed = streams.closed(StreamType::Control);
        assert_eq!(closed, Err(Error::CriticalStreamClosed { stream_type: 0 }));
        assert_eq!(
            closed.map_err(|error| error.code()),
            Err(ErrorCode::H3_CLOSED_CRITICAL_STREAM)
        );
    }

    /// RFC 9114 Section 6.2.2: "Only servers can push; if a server receives a
    /// client-initiated push stream, this MUST be treated as a connection error
    /// of type H3_STREAM_CREATION_ERROR."
    #[test]
    fn a_server_receiving_a_push_stream_is_h3_stream_creation_error() {
        let mut server = UniStreams::new(Role::Server);
        let push = server.open(StreamType::Push);
        assert_eq!(push, Err(Error::PushStreamFromClient));
        assert_eq!(
            push.map_err(|error| error.code()),
            Err(ErrorCode::H3_STREAM_CREATION_ERROR)
        );
        let mut client = UniStreams::new(Role::Client);
        assert_eq!(client.open(StreamType::Push), Ok(Disposition::Push));
        assert_eq!(client.open(StreamType::Push), Ok(Disposition::Push));
        assert_eq!(client.closed(StreamType::Push), Ok(()));
    }

    /// RFC 9114 Section 6.2: "Recipients of unknown stream types MUST either
    /// abort reading of the stream or discard incoming data without further
    /// processing." and "The recipient MUST NOT consider unknown stream types
    /// to be a connection error of any kind."
    #[test]
    fn unknown_and_reserved_stream_types_are_discarded_and_never_a_connection_error() {
        let mut streams = UniStreams::new(Role::Server);
        for value in [
            0x04u64,
            0x05,
            0x20,
            0x21,
            0x40,
            0x54,
            0x3FFF_FFFF_FFFF_FFFE,
            varint::MAX,
        ] {
            let stream_type = StreamType::from_value(value);
            assert!(matches!(
                stream_type,
                StreamType::Reserved(_) | StreamType::Unknown(_)
            ));
            for _ in 0..3 {
                assert_eq!(
                    streams.open(stream_type),
                    Ok(Disposition::Discard),
                    "{value}"
                );
            }
            assert_eq!(streams.closed(stream_type), Ok(()));
        }
        assert_eq!(streams, UniStreams::new(Role::Server));
        let mut rng = Rng::new(0x5EED_000A);
        for _ in 0..iterations(2_000) {
            let value = rng.varint().saturating_add(4);
            assert_eq!(
                streams.open(StreamType::from_value(value)),
                Ok(Disposition::Discard)
            );
        }
    }

    /// RFC 9114 Section 6.2.1: "A control stream is indicated by a stream type
    /// of 0x00."
    /// RFC 9114 Section 6.2.2: "A push stream is indicated by a stream type of
    /// 0x01, followed by the push ID of the promise that it fulfills, encoded
    /// as a variable-length integer."
    /// RFC 9204 Section 4.2: "An encoder stream is a unidirectional stream of
    /// type 0x02." and "A decoder stream is a unidirectional stream of type
    /// 0x03."
    #[test]
    fn unidirectional_stream_types_0x00_to_0x03_are_classified_by_their_registered_values() {
        let cases: [(&str, StreamType, u64); 8] = [
            ("00", StreamType::Control, 0),
            ("01", StreamType::Push, 1),
            ("02", StreamType::QpackEncoder, 2),
            ("03", StreamType::QpackDecoder, 3),
            ("21", StreamType::Reserved(0x21), 0x21),
            ("04", StreamType::Unknown(4), 4),
            ("4000", StreamType::Control, 0),
            ("c000000000000003", StreamType::QpackDecoder, 3),
        ];
        for (hex, stream_type, value) in cases {
            let bytes = unhex(hex);
            assert_eq!(
                StreamType::parse(&bytes),
                Some((stream_type, bytes.len())),
                "{hex}"
            );
            assert_eq!(StreamType::from_value(value), stream_type);
            assert_eq!(stream_type.value(), value);
        }
        assert!(StreamType::Control.is_critical());
        assert!(StreamType::QpackEncoder.is_critical());
        assert!(StreamType::QpackDecoder.is_critical());
        assert!(!StreamType::Push.is_critical());
        assert!(!StreamType::Reserved(0x21).is_critical());
        assert!(!StreamType::Unknown(4).is_critical());
    }

    /// RFC 9204 Section 4.2: "Each endpoint MUST initiate, at most, one encoder
    /// stream and, at most, one decoder stream. Receipt of a second instance
    /// of either stream type MUST be treated as a connection error of type
    /// H3_STREAM_CREATION_ERROR."
    #[test]
    fn a_second_qpack_encoder_or_decoder_stream_is_h3_stream_creation_error() {
        for (stream_type, disposition, value) in [
            (StreamType::QpackEncoder, Disposition::QpackEncoder, 2u64),
            (StreamType::QpackDecoder, Disposition::QpackDecoder, 3),
        ] {
            let mut streams = UniStreams::new(Role::Server);
            assert_eq!(streams.open(stream_type), Ok(disposition));
            let second = streams.open(stream_type);
            assert_eq!(
                second,
                Err(Error::SecondCriticalStream { stream_type: value })
            );
            assert_eq!(
                second.map_err(|error| error.code()),
                Err(ErrorCode::H3_STREAM_CREATION_ERROR)
            );
        }
    }

    /// RFC 9204 Section 4.2: "Closure of either unidirectional stream type MUST
    /// be treated as a connection error of type H3_CLOSED_CRITICAL_STREAM."
    #[test]
    fn closing_a_qpack_encoder_or_decoder_stream_is_h3_closed_critical_stream() {
        let streams = UniStreams::new(Role::Client);
        for (stream_type, value) in [
            (StreamType::QpackEncoder, 2u64),
            (StreamType::QpackDecoder, 3),
        ] {
            let closed = streams.closed(stream_type);
            assert_eq!(
                closed,
                Err(Error::CriticalStreamClosed { stream_type: value })
            );
            assert_eq!(
                closed.map_err(|error| error.code()),
                Err(ErrorCode::H3_CLOSED_CRITICAL_STREAM)
            );
        }
    }

    /// RFC 9204 Section 4.2: "An endpoint MUST allow its peer to create an
    /// encoder stream and a decoder stream even if the connection's settings
    /// prevent their use."
    #[test]
    fn the_peer_may_open_qpack_encoder_and_decoder_streams_even_at_capacity_zero() {
        let advertised = Settings::server(&Http3Limits::DEFAULT);
        assert_eq!(advertised.qpack_max_table_capacity_or_default(), 0);
        assert_eq!(advertised.qpack_blocked_streams_or_default(), 0);
        let mut streams = UniStreams::new(Role::Server);
        assert_eq!(
            streams.open(StreamType::QpackEncoder),
            Ok(Disposition::QpackEncoder)
        );
        assert_eq!(
            streams.open(StreamType::QpackDecoder),
            Ok(Disposition::QpackDecoder)
        );
        assert_eq!(streams.open(StreamType::Control), Ok(Disposition::Control));
    }

    /// RFC 9114 Section 6.2: "A receiver MUST tolerate unidirectional streams
    /// being closed or reset prior to the reception of the unidirectional
    /// stream header."
    #[test]
    fn a_unidirectional_stream_closed_before_its_type_is_tolerated() {
        let mut streams = UniStreams::new(Role::Server);
        let before = streams;
        assert_eq!(StreamType::parse(&[]), None);
        assert_eq!(StreamType::parse(&[0x40]), None);
        assert_eq!(StreamType::parse(&unhex("c0000000")), None);
        assert_eq!(streams, before);
        assert_eq!(streams.open(StreamType::Control), Ok(Disposition::Control));
    }

    /// RFC 9000 Section 2.1: "The least significant bit (0x01) of the stream
    /// ID identifies the initiator of the stream." and "The second least
    /// significant bit (0x02) of the stream ID distinguishes between
    /// bidirectional streams (with the bit set to 0) and unidirectional
    /// streams (with the bit set to 1)."
    #[test]
    fn stream_id_helpers_read_the_initiator_and_direction_bits() {
        let cases: [(u64, bool, bool); 6] = [
            (0, true, true),
            (1, false, true),
            (2, true, false),
            (3, false, false),
            (4, true, true),
            (0x3FFF_FFFF_FFFF_FFFC, true, true),
        ];
        for (stream_id, client, bidirectional) in cases {
            assert_eq!(is_client_initiated(stream_id), client, "{stream_id}");
            assert_eq!(is_bidirectional(stream_id), bidirectional, "{stream_id}");
        }
    }

    /// RFC 9114 Section 6.2: the stream type "is sent as a variable-length
    /// integer at the start of the stream"; every value classifies, the
    /// reserved 0x1f * N + 0x21 values of Section 6.2.3 among them, and keeps
    /// its value through a round trip.
    #[test]
    fn random_stream_type_values_classify_and_round_trip() {
        let mut rng = Rng::new(0x5EED_000B);
        for _ in 0..iterations(10_000) {
            let value = rng.varint();
            let stream_type = StreamType::from_value(value);
            assert_eq!(stream_type.value(), value);
            assert_eq!(
                matches!(stream_type, StreamType::Reserved(_)),
                reserved::is_reserved(value)
            );
            let mut bytes = alloc::vec::Vec::new();
            assert_eq!(varint::push(value, &mut bytes), Some(()));
            assert_eq!(StreamType::parse(&bytes), Some((stream_type, bytes.len())));
        }
    }
}
