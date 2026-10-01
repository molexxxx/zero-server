//! Real-time fan-out for zero-server.
//!
//! WebSocket rooms, pools and cross-core fan-out; SSE streams with keep-alive comments
//! and Last-Event-ID.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
