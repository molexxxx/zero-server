//! The HTTP/3 codec of zero-server.
//!
//! QUIC variable-length integers, the HTTP/3 frame codec, settings,
//! unidirectional stream type classification, GOAWAY, and capsule and
//! datagram parsing. Every item is a byte-in, structure-out codec with no I/O,
//! no clock and no global state; the QUIC transport and the HTTP/3 connection
//! that drives these codecs are not part of this crate. A HEADERS or
//! PUSH_PROMISE frame hands out its encoded field section as octets, which a
//! QPACK decoder interprets.
//!
//! The primary items are:
//!
//! - [`varint`] - RFC 9000 Section 16 variable-length integers.
//! - [`FrameDecoder`], [`Step`], [`StreamKind`], [`Role`] and [`FrameLimits`] -
//!   the streaming frame decoder and the stream, role, sequence and length
//!   rules of RFC 9114 Section 7.
//! - [`Frame`], [`FrameHeader`], [`FrameType`], [`encode_data_header`] and
//!   [`encode_reserved`] - the frames and their encoders.
//! - [`Settings`] and [`Reserved`] - the SETTINGS payload, with the server's
//!   settings from `zero_limits::Http3Limits`.
//! - [`StreamType`], [`UniStreams`] and [`Disposition`] - unidirectional
//!   stream types and the rules on the streams a peer opens.
//! - [`PeerControl`] and [`GoawaySender`] - GOAWAY, MAX_PUSH_ID and
//!   CANCEL_PUSH rules across a control stream.
//! - [`CapsuleDecoder`], [`CapsuleStep`], [`encode_capsule`] and
//!   [`encode_datagram_capsule`] - the RFC 9297 Capsule Protocol.
//! - [`Datagram`] - RFC 9297 HTTP/3 datagrams.
//! - [`Error`], [`ErrorCode`] and [`Scope`] - the error codes and the errors
//!   of received bytes.
//! - [`VERSION`] - the version of the crate.
//!
//! # Examples
//!
//! The field section is opaque here: this crate carries it whole and never
//! interprets it.
//!
//! ```
//! use zero_h3::{Frame, FrameDecoder, FrameLimits, Role, Settings, Step, StreamKind};
//! use zero_limits::Http3Limits;
//!
//! let mut request = Vec::new();
//! let field_section = b"an encoded field section";
//! assert_eq!(Frame::Headers { field_section }.encode(&mut request), Some(()));
//! assert_eq!(zero_h3::encode_data_header(5, &mut request), Some(()));
//! request.extend_from_slice(b"hello");
//!
//! let mut decoder = FrameDecoder::new(StreamKind::Request, Role::Server, FrameLimits::DEFAULT);
//! let mut rest = request.as_slice();
//! let mut body = Vec::new();
//! loop {
//!     match decoder.decode(rest) {
//!         Ok(Step::Frame { frame, consumed }) => {
//!             assert_eq!(frame, Frame::Headers { field_section });
//!             rest = &rest[consumed..];
//!         }
//!         Ok(Step::Data { data, consumed, .. }) => {
//!             body.extend_from_slice(data);
//!             rest = &rest[consumed..];
//!         }
//!         Ok(Step::NeedMore { .. }) => break,
//!         other => unreachable!("{other:?}"),
//!     }
//! }
//! assert_eq!(body, b"hello");
//! assert_eq!(decoder.finish(rest), Ok(()));
//!
//! let mut control = Vec::new();
//! let settings = Settings::server(&Http3Limits::DEFAULT);
//! assert_eq!(settings.encode_control_preface(None, &mut control), Some(()));
//! assert_eq!(settings.max_field_section_size, Some(32_768));
//! ```

#![cfg_attr(not(feature = "std"), no_std)]
#![deny(clippy::cast_possible_truncation)]

extern crate alloc;

pub mod capsule;
pub mod control;
pub mod datagram;
pub mod decoder;
pub mod error;
pub mod frame;
pub mod reserved;
pub mod settings;
pub mod stream;
pub mod varint;
#[cfg(test)]
mod xorshift;

pub use capsule::{encode_capsule, encode_datagram_capsule, CapsuleDecoder, CapsuleStep};
pub use control::{GoawaySender, PeerControl};
pub use datagram::Datagram;
pub use decoder::{FrameDecoder, FrameLimits, Role, Step, StreamKind};
pub use error::{Error, ErrorCode, Scope};
pub use frame::{encode_data_header, encode_reserved, Frame, FrameHeader, FrameType};
pub use settings::{Reserved, Settings};
pub use stream::{Disposition, StreamType, UniStreams};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
