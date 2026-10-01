//! The HTTP/1.1 codec of zero-server.
//!
//! The request head parser produces byte spans into the caller's buffer and a
//! caller-owned field table, decides the body framing, and refuses every
//! ambiguity the specifications let a recipient repair; beside it sit the
//! small value grammars the framing decisions need. The chunked decoder
//! streams a body over the caller's buffers and parses the trailer section
//! into a separate table; the encoder writes chunks. The response serializer
//! writes a status line, validated field lines and a body into the caller's
//! buffer, and is the response-splitting boundary.
//!
//! The primary items are:
//!
//! - [`parse_request`], [`Head`], [`Field`], [`Span`] and [`Status`] - the
//!   request head parser and its outputs.
//! - [`BodyLength`], [`TargetForm`], [`Version`] and [`Expect`] - what the
//!   head decides.
//! - [`ChunkedDecoder`], [`Step`], [`parse_trailers`], [`chunk_header`] and
//!   [`encode_chunk`] - the chunked transfer coding and its trailers.
//! - [`ResponseWriter`], [`WriteError`] and [`body_allowed`] - the validating
//!   response serializer.
//! - [`Reject`] - the status a refused message is answered with.
//! - [`VERSION`] - the version of the crate.
//!
//! # Examples
//!
//! ```
//! use zero_http1::{parse_request, BodyLength, Field, Status};
//! use zero_limits::http1::Http1Limits;
//!
//! let input = b"POST /submit HTTP/1.1\r\nHost: example.org\r\nContent-Length: 5\r\n\r\nhello";
//! let mut table = [Field::EMPTY; 16];
//! let Status::Complete(head) = parse_request(input, &mut table, &Http1Limits::DEFAULT) else {
//!     unreachable!("the head is complete");
//! };
//! assert_eq!(head.path.of(input), b"/submit");
//! assert_eq!(head.body, BodyLength::Length(5));
//! assert_eq!(&input[head.len..], b"hello");
//! ```

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod chunked;
pub mod error;
pub mod head;
pub mod list;
#[cfg(test)]
mod no_alloc;
pub mod response;

pub use chunked::{
    chunk_header, encode_chunk, is_trailer_allowed, parse_trailers, ChunkedDecoder, Step,
    CHUNK_END, LAST_CHUNK, MAX_CHUNK_HEADER_LEN,
};
pub use error::Reject;
pub use head::{
    parse_request, BodyLength, Expect, Field, Head, Span, Status, TargetForm, Version,
    LONGEST_METHOD,
};
pub use response::{body_allowed, content_length_allowed, ResponseWriter, WriteError};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
