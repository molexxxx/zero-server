//! The server-sent events codec of zero-server.
//!
//! The event stream encoder and the client-side decoder.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
