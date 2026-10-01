//! The WebSocket codec of zero-server.
//!
//! The handshake accept value, the frame codec over the caller buffer, in-place unmask
//! and streaming UTF-8 validation across fragments through `zero-simd`, the close code
//! rules, and permessage-deflate parameter parsing behind a feature.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
