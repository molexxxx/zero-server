//! The connection driver of zero-server.
//!
//! HTTP/1.1 over the `zero-io` seam: the read loop parses every complete head in the
//! receive block, each request takes a position in the per-connection pipelining
//! ring, handlers run inline in the connection task (safe methods beside each other,
//! an unsafe method after everything before it), and responses leave in request
//! order through one vectored write per turn (`DESIGN.md` section 6.3). The driver
//! enforces the HTTP/1.1 limits and timeouts of section 10.4, answers
//! `Expect: 100-continue`, puts `Date` on every response, marks the last response
//! of a closing connection with `Connection: close`, and keeps a per-core
//! request-memory budget that pauses accepts. The handler ABI for tier 4 is
//! [`Handler`] over [`Call`]; a handler's error is answered from the error registry
//! ([`error`]) as a problem details body, and a handler's panic is answered 500
//! while the connection and the core serve on (section 10.2). A handler can claim
//! its connection ([`takeover`]) to switch protocols after a `101` or to stream a
//! body, which is what WebSocket and server-sent events build on. The
//! `StreamTransport` seam and Alt-Svc emission follow in their own steps.

pub mod call;
mod conn;
pub mod error;
pub mod handler;
mod record;
mod ring;
pub mod server;
pub mod takeover;

pub use call::{Call, Request, Response, Routed};
pub use error::{code_for, status_for, Problem, PROBLEM_MEDIA_TYPE, REGISTRY};
pub use handler::Handler;
pub use server::{serve, serve_with, Accept, Config, Prepared};
pub use takeover::{TakeOver, Taken};
pub use zero_router::Router;
pub use zero_rt::{Event, StatusSink, Worker, Workers};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
