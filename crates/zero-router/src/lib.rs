//! Method and path dispatch for zero-server.
//!
//! Method dispatch by integer id, static segments, parameters and wildcards, 404, 405
//! with Allow, 501, automatic HEAD and OPTIONS, RFC 3986 dot-segment removal,
//! percent-decoding that returns an error rather than panicking, and router-level
//! middleware and query-string mounts with the semantics transferred from the Node SDK.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
