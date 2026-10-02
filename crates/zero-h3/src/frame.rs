//! HTTP/3 frames: the frame header, the frame types this codec defines, and
//! the frame encoders.
//!
//! Every frame is a Type and a Length, both variable-length integers, then
//! Length octets of payload (RFC 9114 Section 7.1). The payloads are DATA and
//! HEADERS `(..)`, CANCEL_PUSH, GOAWAY and MAX_PUSH_ID one integer, SETTINGS
//! pairs of integers, and PUSH_PROMISE an integer then `(..)` (Sections 7.2.1
//! to 7.2.7). "Padding is not defined in HTTP/3 frames" (Appendix A.2.5).
//! The types HTTP/2 used with no HTTP/3 counterpart, 0x02, 0x06, 0x08 and
//! 0x09, are reserved and refused on receipt (Section 7.2.8); every other
//! type this codec does not define is skipped by its Length, as "Implementations
//! MUST ignore unknown or unsupported values in all extensible protocol
//! elements" (Section 9) requires. PRIORITY_UPDATE and ORIGIN are among the
//! skipped types.
//!
//! The encoders refuse a value above 2^62-1 by returning `None` and leave the
//! output buffer as it was.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2>

use alloc::vec::Vec;

use crate::reserved;
use crate::settings::Settings;
use crate::varint;

/// A frame type value.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-11.2.1>
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FrameType(pub u64);

impl FrameType {
    /// DATA (0x00): request or response content (RFC 9114 Section 7.2.1).
    pub const DATA: Self = Self(0x00);
    /// HEADERS (0x01): an encoded field section (RFC 9114 Section 7.2.2).
    pub const HEADERS: Self = Self(0x01);
    /// CANCEL_PUSH (0x03): the cancellation of a server push (RFC 9114
    /// Section 7.2.3).
    pub const CANCEL_PUSH: Self = Self(0x03);
    /// SETTINGS (0x04): configuration parameters (RFC 9114 Section 7.2.4).
    pub const SETTINGS: Self = Self(0x04);
    /// PUSH_PROMISE (0x05): a promised server push (RFC 9114 Section 7.2.5).
    pub const PUSH_PROMISE: Self = Self(0x05);
    /// GOAWAY (0x07): the start of a graceful shutdown (RFC 9114 Section
    /// 7.2.6).
    pub const GOAWAY: Self = Self(0x07);
    /// MAX_PUSH_ID (0x0d): the largest push ID a server may use (RFC 9114
    /// Section 7.2.7).
    pub const MAX_PUSH_ID: Self = Self(0x0D);
    /// The types HTTP/2 used with no HTTP/3 counterpart: 0x02 (PRIORITY),
    /// 0x06 (PING), 0x08 (WINDOW_UPDATE) and 0x09 (CONTINUATION).
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.8>
    pub const RESERVED_HTTP2: [Self; 4] = [Self(0x02), Self(0x06), Self(0x08), Self(0x09)];

    /// Whether the type is one of [`Self::RESERVED_HTTP2`].
    #[must_use]
    pub const fn is_reserved_http2(self) -> bool {
        matches!(self.0, 0x02 | 0x06 | 0x08 | 0x09)
    }

    /// Whether the type has the reserved form 0x1f * N + 0x21, which carries
    /// no meaning and is skipped.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.8>
    #[must_use]
    pub const fn is_reserved(self) -> bool {
        reserved::is_reserved(self.0)
    }

    /// Whether this codec defines the type: DATA, HEADERS, CANCEL_PUSH,
    /// SETTINGS, PUSH_PROMISE, GOAWAY or MAX_PUSH_ID.
    #[must_use]
    pub const fn is_known(self) -> bool {
        matches!(self.0, 0x00 | 0x01 | 0x03 | 0x04 | 0x05 | 0x07 | 0x0D)
    }
}

/// The longest frame header: two eight-octet integers.
pub const MAX_HEADER_LEN: usize = 16;

/// A frame header: Type (i), Length (i).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.1>
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    /// The frame type.
    pub frame_type: FrameType,
    /// The payload length in octets.
    pub len: u64,
    /// The octets the header took, 2 to [`MAX_HEADER_LEN`].
    pub header_len: usize,
}

impl FrameHeader {
    /// Parses a header from a buffer that may hold only part of it. Both
    /// integers may use any encoding length (RFC 9000 Section 16).
    ///
    /// # Arguments
    ///
    /// * `input` - the octets from the start of the frame.
    ///
    /// # Returns
    ///
    /// The header, or `None` until both integers are complete; it never
    /// fails otherwise.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.1>
    #[must_use]
    pub fn parse(input: &[u8]) -> Option<Self> {
        let (frame_type, type_len) = varint::decode(input)?;
        let (len, len_len) = varint::decode(input.get(type_len..)?)?;
        Some(Self {
            frame_type: FrameType(frame_type),
            len,
            header_len: type_len.checked_add(len_len)?,
        })
    }

    /// Appends a frame header in the shortest encoding.
    ///
    /// # Arguments
    ///
    /// * `frame_type` - the frame type.
    /// * `len` - the payload length.
    /// * `out` - the buffer the header is appended to.
    ///
    /// # Returns
    ///
    /// `None` when a value exceeds 2^62-1, in which case `out` is unchanged.
    pub fn encode(frame_type: FrameType, len: u64, out: &mut Vec<u8>) -> Option<()> {
        varint::encoded_len(frame_type.0)?;
        varint::encoded_len(len)?;
        varint::push(frame_type.0, out)?;
        varint::push(len, out)
    }
}

/// A whole frame other than DATA and the skipped types, borrowed from the
/// input it was decoded from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frame<'a> {
    /// HEADERS: the encoded field section, which QPACK decodes (RFC 9114
    /// Section 7.2.2).
    Headers {
        /// The encoded field section.
        field_section: &'a [u8],
    },
    /// CANCEL_PUSH (RFC 9114 Section 7.2.3).
    CancelPush {
        /// The push ID of the server push to cancel.
        push_id: u64,
    },
    /// SETTINGS (RFC 9114 Section 7.2.4).
    Settings(Settings),
    /// PUSH_PROMISE (RFC 9114 Section 7.2.5).
    PushPromise {
        /// The push ID of the promised push.
        push_id: u64,
        /// The encoded field section of the promised request.
        field_section: &'a [u8],
    },
    /// GOAWAY: a client-initiated bidirectional stream ID from a server, a
    /// push ID from a client (RFC 9114 Section 7.2.6).
    Goaway {
        /// The stream ID or push ID.
        id: u64,
    },
    /// MAX_PUSH_ID (RFC 9114 Section 7.2.7).
    MaxPushId {
        /// The largest push ID the server may use.
        push_id: u64,
    },
}

impl Frame<'_> {
    /// The type of the frame.
    #[must_use]
    pub const fn frame_type(&self) -> FrameType {
        match self {
            Self::Headers { .. } => FrameType::HEADERS,
            Self::CancelPush { .. } => FrameType::CANCEL_PUSH,
            Self::Settings(_) => FrameType::SETTINGS,
            Self::PushPromise { .. } => FrameType::PUSH_PROMISE,
            Self::Goaway { .. } => FrameType::GOAWAY,
            Self::MaxPushId { .. } => FrameType::MAX_PUSH_ID,
        }
    }

    /// Appends the frame: header and payload, every integer in the shortest
    /// encoding.
    ///
    /// # Arguments
    ///
    /// * `out` - the buffer the frame is appended to.
    ///
    /// # Returns
    ///
    /// `None` when a value exceeds 2^62-1, in which case `out` is unchanged.
    pub fn encode(&self, out: &mut Vec<u8>) -> Option<()> {
        match *self {
            Self::Headers { field_section } => append(FrameType::HEADERS, &[], field_section, out),
            Self::CancelPush { push_id } => append_integer(FrameType::CANCEL_PUSH, push_id, out),
            Self::Settings(settings) => settings.encode(None, out),
            Self::PushPromise {
                push_id,
                field_section,
            } => {
                let mut id = [0u8; varint::MAX_LEN];
                let id_len = varint::encode(push_id, &mut id)?;
                append(
                    FrameType::PUSH_PROMISE,
                    id.get(..id_len)?,
                    field_section,
                    out,
                )
            }
            Self::Goaway { id } => append_integer(FrameType::GOAWAY, id, out),
            Self::MaxPushId { push_id } => append_integer(FrameType::MAX_PUSH_ID, push_id, out),
        }
    }
}

/// Appends a frame whose payload is `head` then `body`; `out` is unchanged
/// on `None`.
fn append(frame_type: FrameType, head: &[u8], body: &[u8], out: &mut Vec<u8>) -> Option<()> {
    let len = u64::try_from(head.len())
        .ok()?
        .checked_add(u64::try_from(body.len()).ok()?)?;
    FrameHeader::encode(frame_type, len, out)?;
    out.extend_from_slice(head);
    out.extend_from_slice(body);
    Some(())
}

/// Appends a frame whose payload is one integer; `out` is unchanged on
/// `None`.
fn append_integer(frame_type: FrameType, value: u64, out: &mut Vec<u8>) -> Option<()> {
    let mut bytes = [0u8; varint::MAX_LEN];
    let len = varint::encode(value, &mut bytes)?;
    append(frame_type, bytes.get(..len)?, &[], out)
}

/// Appends a DATA frame header for a payload of `len` octets; the caller
/// writes the payload, so content is never copied.
///
/// # Arguments
///
/// * `len` - the payload length.
/// * `out` - the buffer the header is appended to.
///
/// # Returns
///
/// `None` above 2^62-1, in which case `out` is unchanged.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.1>
pub fn encode_data_header(len: u64, out: &mut Vec<u8>) -> Option<()> {
    FrameHeader::encode(FrameType::DATA, len, out)
}

/// Appends a reserved frame of type 0x1f * n + 0x21, which a receiver
/// ignores; endpoints use them to exercise that requirement.
///
/// # Arguments
///
/// * `n` - the index of the reserved type, at most [`reserved::MAX_N`].
/// * `payload` - the payload, chosen freely.
/// * `out` - the buffer the frame is appended to.
///
/// # Returns
///
/// `None` when `n` is above [`reserved::MAX_N`], in which case `out` is
/// unchanged.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9114.html#section-7.2.8>
pub fn encode_reserved(n: u64, payload: &[u8], out: &mut Vec<u8>) -> Option<()> {
    append(FrameType(reserved::reserved(n)?), payload, &[], out)
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::{
        encode_data_header, encode_reserved, Frame, FrameHeader, FrameType, MAX_HEADER_LEN,
    };
    use crate::reserved;
    use crate::settings::Settings;
    use crate::varint;
    use crate::xorshift::{iterations, unhex, Rng};

    /// Encodes one frame into a fresh buffer.
    fn encoded(frame: &Frame<'_>) -> Vec<u8> {
        let mut out = Vec::new();
        assert_eq!(frame.encode(&mut out), Some(()), "{frame:?}");
        out
    }

    /// RFC 9114 Section 7.2, Figures 4 to 10: DATA (0x00), HEADERS (0x01),
    /// CANCEL_PUSH (0x03), SETTINGS (0x04), PUSH_PROMISE (0x05), GOAWAY (0x07)
    /// and MAX_PUSH_ID (0x0d) each encode as Type (i), Length (i) and the
    /// fields of their figure; Section 7.2.8: reserved types are "0x1f * N +
    /// 0x21".
    #[test]
    fn every_frame_type_encodes_in_the_layout_of_its_figure() {
        let field_section = unhex("0000d1d7c1");
        let cases: [(Frame<'_>, &str); 6] = [
            (
                Frame::Headers {
                    field_section: &field_section,
                },
                "01050000d1d7c1",
            ),
            (Frame::CancelPush { push_id: 3 }, "030103"),
            (Frame::Settings(Settings::EMPTY), "0400"),
            (
                Frame::PushPromise {
                    push_id: 1,
                    field_section: &field_section,
                },
                "0506010000d1d7c1",
            ),
            (Frame::Goaway { id: 4 }, "070104"),
            (Frame::MaxPushId { push_id: 16_384 }, "0d0480004000"),
        ];
        for (frame, hex) in cases {
            let bytes = encoded(&frame);
            assert_eq!(bytes, unhex(hex), "{frame:?}");
            let header = FrameHeader::parse(&bytes);
            assert_eq!(
                header.map(|header| header.frame_type),
                Some(frame.frame_type())
            );
            let payload_len = header.map_or(0, |header| header.header_len);
            assert_eq!(
                header.map(|header| header.len),
                u64::try_from(bytes.len().saturating_sub(payload_len)).ok()
            );
        }
        let mut data = Vec::new();
        assert_eq!(encode_data_header(5, &mut data), Some(()));
        data.extend_from_slice(b"hello");
        assert_eq!(data, unhex("000568656c6c6f"));
        let mut grease = Vec::new();
        assert_eq!(encode_reserved(0, &[0xAB, 0xCD], &mut grease), Some(()));
        assert_eq!(grease, unhex("2102abcd"));
        let mut grease = Vec::new();
        assert_eq!(encode_reserved(1, &[], &mut grease), Some(()));
        assert_eq!(grease, unhex("404000"));
    }

    /// RFC 9114 Section 7.2.8: "Frame types of the format 0x1f * N + 0x21 for
    /// non-negative integer values of N are reserved to exercise the
    /// requirement that unknown types be ignored" and "Frame types that were
    /// used in HTTP/2 where there is no corresponding HTTP/3 frame have also
    /// been reserved (Section 11.2.1)."
    #[test]
    fn frame_types_are_classified_as_known_reserved_or_reserved_from_http_2() {
        for known in [0x00u64, 0x01, 0x03, 0x04, 0x05, 0x07, 0x0D] {
            let frame_type = FrameType(known);
            assert!(frame_type.is_known(), "{known}");
            assert!(!frame_type.is_reserved_http2(), "{known}");
            assert!(!frame_type.is_reserved(), "{known}");
        }
        for http2 in FrameType::RESERVED_HTTP2 {
            assert!(http2.is_reserved_http2());
            assert!(!http2.is_known());
        }
        assert_eq!(
            FrameType::RESERVED_HTTP2.map(|frame_type| frame_type.0),
            [0x02, 0x06, 0x08, 0x09]
        );
        for unknown in [0x0Au64, 0x0C, 0x21, 0xF0700, 0xF0701] {
            let frame_type = FrameType(unknown);
            assert!(!frame_type.is_known(), "{unknown}");
            assert!(!frame_type.is_reserved_http2(), "{unknown}");
        }
        assert!(FrameType(0x21).is_reserved());
        assert!(!FrameType(0xF0700).is_reserved());
    }

    /// RFC 9114 Section 7.1, Figure 3: a frame starts with "Type (i)" and
    /// "Length (i)", two variable-length integers, so a header is parsed only
    /// once both are complete, in any of the encoding lengths RFC 9000
    /// Section 16 allows.
    #[test]
    fn a_frame_header_is_parsed_only_once_both_integers_are_complete() {
        let header = unhex("800f0700c000000000000005");
        for end in 0..header.len() {
            assert_eq!(
                FrameHeader::parse(header.get(..end).unwrap_or(&[])),
                None,
                "{end}"
            );
        }
        assert_eq!(
            FrameHeader::parse(&header),
            Some(FrameHeader {
                frame_type: FrameType(0xF0700),
                len: 5,
                header_len: 12
            })
        );
        let longest = [0xFFu8; MAX_HEADER_LEN];
        assert_eq!(
            FrameHeader::parse(&longest).map(|header| (
                header.frame_type.0,
                header.len,
                header.header_len
            )),
            Some((varint::MAX, varint::MAX, MAX_HEADER_LEN))
        );
    }

    /// RFC 9000 Section 16: variable-length integers carry values up to
    /// 2^62-1, so no frame field of RFC 9114 Section 7.2 is written with a
    /// larger value.
    #[test]
    fn frame_encoders_refuse_values_above_2_62_minus_1_and_leave_the_buffer_unchanged() {
        let too_large = varint::MAX.saturating_add(1);
        let frames = [
            Frame::CancelPush { push_id: too_large },
            Frame::Goaway { id: too_large },
            Frame::MaxPushId { push_id: too_large },
            Frame::PushPromise {
                push_id: too_large,
                field_section: &[],
            },
        ];
        for frame in frames {
            let mut out = alloc::vec![9u8];
            assert_eq!(frame.encode(&mut out), None, "{frame:?}");
            assert_eq!(out, [9u8]);
        }
        let mut out = alloc::vec![9u8];
        assert_eq!(encode_data_header(too_large, &mut out), None);
        assert_eq!(FrameHeader::encode(FrameType(too_large), 0, &mut out), None);
        assert_eq!(
            FrameHeader::encode(FrameType::DATA, too_large, &mut out),
            None
        );
        assert_eq!(
            encode_reserved(reserved::MAX_N.saturating_add(1), b"x", &mut out),
            None
        );
        assert_eq!(out, [9u8]);
    }

    /// RFC 9000 Section 16: "Values do not need to be encoded on the minimum
    /// number of bytes necessary", so a frame header of RFC 9114 Section 7.1
    /// parses the same in its shortest and its 8-octet encodings.
    #[test]
    fn random_frame_headers_round_trip_in_every_encoding_length() {
        let mut rng = Rng::new(0x5EED_0005);
        for _ in 0..iterations(10_000) {
            let frame_type = rng.varint();
            let len = rng.varint();
            let mut shortest = Vec::new();
            assert_eq!(
                FrameHeader::encode(FrameType(frame_type), len, &mut shortest),
                Some(())
            );
            let parsed = FrameHeader::parse(&shortest);
            assert_eq!(
                parsed.map(|header| (header.frame_type.0, header.len)),
                Some((frame_type, len))
            );
            assert_eq!(parsed.map(|header| header.header_len), Some(shortest.len()));
            let mut padded = [0u8; MAX_HEADER_LEN];
            let type_len = varint::encode_with_len(frame_type, 8, &mut padded).unwrap_or(0);
            let len_len = varint::encode_with_len(len, 8, padded.get_mut(8..).unwrap_or(&mut []))
                .unwrap_or(0);
            assert_eq!(type_len.saturating_add(len_len), MAX_HEADER_LEN);
            let parsed = FrameHeader::parse(&padded);
            assert_eq!(
                parsed.map(|header| (header.frame_type.0, header.len)),
                Some((frame_type, len))
            );
        }
    }
}
