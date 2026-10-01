//! The connection driver of zero-server.
//!
//! HTTP/1.1 with the pipelining ring and in-order writer, limits and timeouts
//! enforcement, Expect 100-continue, the `StreamTransport` and `ByteStream` seam,
//! Alt-Svc emission, the handler ABI for tiers 0 to 4, and the WebSocket and SSE event
//! and send entry points.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
