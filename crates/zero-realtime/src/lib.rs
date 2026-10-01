//! Real-time connections for zero-server.
//!
//! [`websocket`] answers WebSocket handshakes and serves the upgraded connections;
//! [`rooms`] groups WebSocket connections for broadcasts that reach every core;
//! [`sse`] serves server-sent event streams with keep-alive comments and
//! `Last-Event-ID`. Connections run on the core that accepted them, claimed from the
//! HTTP/1.1 driver ([`zero_http::takeover`]).

pub mod rooms;
pub mod sse;
pub mod websocket;

pub use rooms::{MemberId, Rooms, INBOX_BYTES};
pub use sse::{start as start_event_stream, stop_reconnecting, EventStream};
pub use websocket::{accept as accept_websocket, Message, WebSocket};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
