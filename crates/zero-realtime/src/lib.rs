//! Real-time connections for zero-server.
//!
//! [`websocket`] answers WebSocket handshakes and serves the upgraded connections;
//! [`sse`] serves server-sent event streams with keep-alive comments and
//! `Last-Event-ID`. Both run on connections a handler claimed from the HTTP/1.1
//! driver ([`zero_http::takeover`]), on the core that accepted them.

pub mod sse;
pub mod websocket;

pub use sse::{start as start_event_stream, stop_reconnecting, EventStream};
pub use websocket::{accept as accept_websocket, Message, WebSocket};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
