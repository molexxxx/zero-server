//! The HTTP types shared by every zero-server protocol crate.
//!
//! `Method` as integer ids, `RequestHead` and `ResponseHead`, trailers, body chunk
//! types, the `Early` marker, the `StatusCode` table with prebuilt status lines, the
//! interned header-name id table shared with the C header, `Fields` as a bounded list
//! of name and value pairs with linear scan, and HTML escaping.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
