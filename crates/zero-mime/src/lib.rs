//! The media type table and parser of zero-server.
//!
//! Extension lookup for static files and the parser for `Content-Type` and `Accept`
//! values.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
