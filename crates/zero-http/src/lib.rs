//! The connection driver of zero-server.
//!
//! HTTP/1.1 over the `zero-io` seam: the read loop parses every complete head in the
//! receive block, each request takes a position in the per-connection pipelining
//! ring, handlers run inline in the connection task (safe methods beside each other,
//! an unsafe method after everything before it), and responses leave in request
//! order, as RFC 9112 Section 9.3.2 requires, through one vectored write per turn.
//! The driver enforces the HTTP/1.1 size limits and timeouts that `zero-limits`
//! defines, answers `Expect: 100-continue`, puts `Date` on every response, marks the
//! last response of a closing connection with `Connection: close`, and keeps a
//! per-core request-memory budget that pauses accepts. The handler ABI for tier 4 is
//! [`Handler`] over [`Call`]; a handler's error is answered from the error registry
//! ([`error`]) as a problem details body, and a handler's panic is answered 500
//! while the connection and the core serve on. A handler can claim its connection
//! ([`takeover`]) to switch protocols after a `101` or to stream a body, which is
//! what WebSocket and server-sent events build on. The driver serves HTTP/1.1 only:
//! it has no transport abstraction for HTTP/2 or HTTP/3 streams and does not
//! advertise `Alt-Svc`.

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
