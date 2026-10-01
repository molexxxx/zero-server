//! The JSON codec of zero-server.
//!
//! A buffer-direct writer (object, key, string with escaping, integer, float, array)
//! and a strict parser with depth and size caps.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
