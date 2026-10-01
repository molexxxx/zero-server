//! The limit table that bounds every zero-server parser and connection.
//!
//! The defaults are `const` values and a `Limits` struct carries the configured set:
//! request line, header field and head sizes, header count, body size, timeouts,
//! requests per connection, pipelining depth, chunk sizes, trailer sizes, receive
//! buffer blocks, and the per-core memory and batch budgets. The values already chosen
//! in the Node SDK (1 MiB bodies, 4 MiB gRPC messages, 64 KiB SDP, 4,096-byte session
//! cookies) are the defaults.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
