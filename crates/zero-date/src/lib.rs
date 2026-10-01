//! Date formatting for zero-server.
//!
//! The IMF-fixdate formatter from a u64 unix timestamp, civil-from-days, and the
//! 20-byte integer formatter.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
