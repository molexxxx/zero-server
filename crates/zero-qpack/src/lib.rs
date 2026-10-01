//! The QPACK codec of zero-server.
//!
//! The RFC 9204 static table, the field section prefix, a static-only encoder and
//! decoder, and the integer and Huffman coding shared with `zero-hpack`; the dynamic
//! table sits behind a feature.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
