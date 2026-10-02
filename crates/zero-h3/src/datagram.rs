//! HTTP/3 datagrams: the Datagram Data field of a QUIC DATAGRAM frame.
//!
//! An HTTP/3 datagram is a Quarter Stream ID, the client-initiated
//! bidirectional request stream divided by four, then the HTTP Datagram
//! Payload, which can be empty (RFC 9297 Section 2.1). Both receive rules of
//! that section are connection errors of type H3_DATAGRAM_ERROR: a payload
//! too short for the Quarter Stream ID, and a Quarter Stream ID above
//! 2^60-1. The stream state rules of Sections 2 and 2.1 (dropping datagrams
//! after the stream closed, buffering them before it opens, and the setting
//! that enables them) belong to the HTTP/3 layer that owns the streams.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-2.1>

use alloc::vec::Vec;

use crate::error::Error;
use crate::varint;

/// 2^60-1: the largest Quarter Stream ID (RFC 9297 Section 2.1).
pub const MAX_QUARTER_STREAM_ID: u64 = 0x0FFF_FFFF_FFFF_FFFF;

/// The Datagram Data field of a QUIC DATAGRAM frame carrying an HTTP/3
/// datagram.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Datagram<'a> {
    /// The request stream ID divided by four.
    pub quarter_stream_id: u64,
    /// The HTTP Datagram Payload, which may be empty.
    pub payload: &'a [u8],
}

impl<'a> Datagram<'a> {
    /// Parses the Datagram Data field of a QUIC DATAGRAM frame. A datagram is
    /// self-delimited, so there is no partial outcome; the Quarter Stream ID
    /// may use any encoding length (RFC 9297 Section 1.1).
    ///
    /// # Arguments
    ///
    /// * `data` - the whole Datagram Data field.
    ///
    /// # Returns
    ///
    /// The datagram, whose payload borrows `data`.
    ///
    /// # Errors
    ///
    /// [`Error::DatagramTooShort`] when `data` is empty or ends inside the
    /// Quarter Stream ID, and [`Error::QuarterStreamIdTooLarge`] above
    /// 2^60-1.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-2.1>
    pub fn parse(data: &'a [u8]) -> Result<Self, Error> {
        let (quarter_stream_id, len) = varint::decode(data).ok_or(Error::DatagramTooShort)?;
        if quarter_stream_id > MAX_QUARTER_STREAM_ID {
            return Err(Error::QuarterStreamIdTooLarge {
                value: quarter_stream_id,
            });
        }
        Ok(Self {
            quarter_stream_id,
            payload: data.get(len..).unwrap_or(&[]),
        })
    }

    /// The request stream the datagram belongs to: `quarter_stream_id * 4`,
    /// at most 2^62-4.
    ///
    /// # Returns
    ///
    /// The stream ID, or `None` when `quarter_stream_id` is above
    /// [`MAX_QUARTER_STREAM_ID`], which [`Self::parse`] never yields but a
    /// value built by hand can hold.
    #[must_use]
    pub const fn stream_id(&self) -> Option<u64> {
        if self.quarter_stream_id > MAX_QUARTER_STREAM_ID {
            return None;
        }
        self.quarter_stream_id.checked_mul(4)
    }

    /// Appends the Datagram Data field of a datagram on `stream_id`.
    ///
    /// # Arguments
    ///
    /// * `stream_id` - the request stream: a client-initiated bidirectional
    ///   stream ID, divisible by four, at most 2^62-1.
    /// * `payload` - the HTTP Datagram Payload.
    /// * `out` - the buffer the datagram is appended to.
    ///
    /// # Returns
    ///
    /// `None` when `stream_id` is not such a stream ID, in which case `out`
    /// is unchanged.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9297.html#section-2.1>
    pub fn encode(stream_id: u64, payload: &[u8], out: &mut Vec<u8>) -> Option<()> {
        if stream_id > varint::MAX || stream_id & 0x03 != 0 {
            return None;
        }
        varint::push(stream_id >> 2, out)?;
        out.extend_from_slice(payload);
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{Datagram, MAX_QUARTER_STREAM_ID};
    use crate::error::{Error, ErrorCode, Scope};
    use crate::varint;
    use crate::xorshift::{iterations, unhex, Rng};

    /// RFC 9297 Section 2.1: "The largest legal QUIC stream ID value is 2^62-1,
    /// so the largest legal value of the Quarter Stream ID field is 2^60-1.
    /// Receipt of an HTTP/3 Datagram that includes a larger value MUST be
    /// treated as an HTTP/3 connection error of type H3_DATAGRAM_ERROR (0x33)."
    #[test]
    fn a_quarter_stream_id_above_2_60_minus_1_is_h3_datagram_error() {
        assert_eq!(MAX_QUARTER_STREAM_ID, 1_152_921_504_606_846_975);
        let largest = unhex("cfffffffffffffff");
        let datagram = Datagram::parse(&largest);
        assert_eq!(
            datagram,
            Ok(Datagram {
                quarter_stream_id: MAX_QUARTER_STREAM_ID,
                payload: &[]
            })
        );
        assert_eq!(
            datagram.map(|datagram| datagram.stream_id()),
            Ok(Some(0x3FFF_FFFF_FFFF_FFFC))
        );
        for (hex, value) in [
            ("d000000000000000", 0x1000_0000_0000_0000u64),
            ("d000000000000000aa", 0x1000_0000_0000_0000),
            ("ffffffffffffffff", varint::MAX),
        ] {
            let bytes = unhex(hex);
            let error = Datagram::parse(&bytes);
            assert_eq!(
                error,
                Err(Error::QuarterStreamIdTooLarge { value }),
                "{hex}"
            );
            assert_eq!(
                error.map_err(|error| error.code()),
                Err(ErrorCode::H3_DATAGRAM_ERROR)
            );
            assert_eq!(error.map_err(|error| error.scope()), Err(Scope::Connection));
        }
        assert_eq!(ErrorCode::H3_DATAGRAM_ERROR.0, 0x33);
    }

    /// RFC 9297 Section 2.1: "Receipt of a QUIC DATAGRAM frame whose payload is
    /// too short to allow parsing the Quarter Stream ID field MUST be treated
    /// as an HTTP/3 connection error of type H3_DATAGRAM_ERROR (0x33)."
    #[test]
    fn a_datagram_too_short_for_its_quarter_stream_id_is_h3_datagram_error() {
        for hex in ["", "40", "80ab", "c0000000000000"] {
            let bytes = unhex(hex);
            let error = Datagram::parse(&bytes);
            assert_eq!(error, Err(Error::DatagramTooShort), "{hex}");
            assert_eq!(
                error.map_err(|error| error.code()),
                Err(ErrorCode::H3_DATAGRAM_ERROR)
            );
        }
        assert_eq!(
            Datagram::parse(&unhex("00")),
            Ok(Datagram {
                quarter_stream_id: 0,
                payload: &[]
            })
        );
    }

    /// RFC 9297 Section 2.1: the Quarter Stream ID "contains the value of the
    /// client-initiated bidirectional stream that this datagram is associated
    /// with divided by four", so the encoder takes only stream IDs divisible
    /// by four, up to the largest legal one.
    #[test]
    fn datagrams_round_trip_and_the_encoder_takes_only_client_bidirectional_streams() {
        let mut out = Vec::new();
        assert_eq!(Datagram::encode(4, &[0xAB, 0xCD], &mut out), Some(()));
        assert_eq!(out, unhex("01abcd"));
        assert_eq!(
            Datagram::parse(&out).map(|datagram| (datagram.stream_id(), datagram.payload)),
            Ok((Some(4), [0xABu8, 0xCD].as_slice()))
        );
        let mut out = alloc::vec![9u8];
        for refused in [
            1u64,
            2,
            3,
            5,
            varint::MAX,
            varint::MAX.saturating_add(1),
            u64::MAX,
        ] {
            assert_eq!(Datagram::encode(refused, b"x", &mut out), None, "{refused}");
        }
        assert_eq!(out, [9u8]);
        assert_eq!(
            Datagram::encode(0x3FFF_FFFF_FFFF_FFFC, b"", &mut out),
            Some(())
        );
        assert_eq!(out, unhex("09cfffffffffffffff"));
        let built = Datagram {
            quarter_stream_id: MAX_QUARTER_STREAM_ID.saturating_add(1),
            payload: &[],
        };
        assert_eq!(built.stream_id(), None);
    }

    /// RFC 9297 Section 2.1, Figure 1: a Quarter Stream ID followed by the
    /// HTTP Datagram Payload; random client bidirectional stream IDs and
    /// payloads round trip.
    #[test]
    fn random_datagrams_round_trip_through_encode_and_parse() {
        let mut rng = Rng::new(0x5EED_0011);
        for _ in 0..iterations(10_000) {
            let stream_id = rng.varint() & 0x3FFF_FFFF_FFFF_FFFC;
            let payload = rng.bytes(24);
            let mut out = Vec::new();
            assert_eq!(Datagram::encode(stream_id, &payload, &mut out), Some(()));
            let parsed = Datagram::parse(&out);
            assert_eq!(
                parsed.map(|datagram| datagram.stream_id()),
                Ok(Some(stream_id))
            );
            assert_eq!(
                parsed.map(|datagram| datagram.payload.to_vec()),
                Ok(payload)
            );
        }
    }

    /// RFC 9297 Section 2.1: arbitrary octets read as an HTTP/3 Datagram never
    /// panic the parser, and whatever parses is written back to the same
    /// stream ID.
    #[test]
    fn arbitrary_octets_never_panic_the_datagram_parser() {
        let mut rng = Rng::new(0x5EED_0012);
        for _ in 0..iterations(20_000) {
            let data = rng.bytes(16);
            if let Ok(datagram) = Datagram::parse(&data) {
                let mut again = Vec::new();
                let stream_id = datagram.stream_id().unwrap_or(1);
                assert_eq!(
                    Datagram::encode(stream_id, datagram.payload, &mut again),
                    Some(())
                );
                assert_eq!(
                    Datagram::parse(&again).map(|again| again.stream_id()),
                    Ok(Some(stream_id))
                );
            }
        }
    }
}
