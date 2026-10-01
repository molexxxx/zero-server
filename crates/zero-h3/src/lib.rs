//! The HTTP/3 codec of zero-server.
//!
//! QUIC varints, the HTTP/3 frame codec, settings, unidirectional stream type
//! classification, GOAWAY, and capsule and datagram frame parsing.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
