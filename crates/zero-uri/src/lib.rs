//! The RFC 3986 URI parser of zero-server.
//!
//! One parser and nothing else: components are produced as byte ranges over the
//! caller's input.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
