//! The base64 and base64url codec of zero-server.
//!
//! One codec and nothing else, in the padded and unpadded forms.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
