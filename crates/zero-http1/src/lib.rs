//! The HTTP/1.1 codec of zero-server.
//!
//! The request head parser produces byte ranges into a caller-owned header table;
//! beside it sit field validation, the chunked decoder and encoder, the framing rules,
//! trailer parsing into a separate table, and a response serializer into a caller
//! buffer that validates every outbound field name as a token and every value as a
//! field value. httparse serves as a differential oracle behind a dev feature.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
