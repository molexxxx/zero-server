//! The query string parser of zero-server.
//!
//! One parser and nothing else, with caps on pair count, key depth and array length
//! so attacker-keyed input stays bounded.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
