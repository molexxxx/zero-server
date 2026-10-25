//! The host boundary of zero-server.
//!
//! This crate is the layer between the HTTP/1.1 driver of `zero-http` and a host
//! language: the routes an application registers, the requests a route hands to a
//! host, the batches that carry them to the host's thread, and the completions the
//! host answers them with. The C ABI of `zero-ffi` and the language bindings are thin
//! layers over it, so every binding shares one implementation. The crate holds no
//! `unsafe` code.
//!
//! An `App` holds the routes and policies, each registered from a JSON option
//! document: routes answered in Rust (fixed responses, redirects, static files,
//! health checks), routes handed to the host, a miss route for requests no route
//! matched, and the CORS, security header, request id, trust proxy and body limit
//! policies. A `Server` claims worker indexes for its cores, binds, and serves the app
//! with one handler per core. A request for a host route is exported into a slot of
//! the core's arena, queued for the core's dispatcher, and posted in a batch to the
//! target attached to that worker index: a `PullTarget` that a host thread blocks on,
//! or any `zero_rt::Target` a binding supplies. The host hands the ids it answered
//! back with `complete`, acknowledging each batch from the thread bound to the
//! target, and the core sends the response with the policies' fields.
//!
//! Every overload answer is written on the core without crossing to the host: a
//! request past the queued-batch bound, on a worker index with no target, while the
//! arena is exhausted, after the target was lost, or while the server drains is
//! answered 503 with `Retry-After` and the server's error body. The capabilities a
//! host can register (`static`, `policy`, `realtime`, `tls`) are cargo features, all
//! on by default; a capability compiled out is refused with
//! [`Status::Unsupported`]. The `testing` feature adds the hooks in [`testing`] for
//! the tests of the crates built over this one.
//!
//! A host thread reads a leased request and writes its response by slot id through
//! [`access`], which applies one set of checks for the C ABI and every binding: a
//! stale id is refused without touching the slot's lock, a pointer into a slot is
//! handed out only under the view rule, and the octets a host writes count in the
//! core's request-memory budget. A slot completed without a response is answered
//! 500 `NO_RESPONSE`. The same calls record the [`actions`] the core runs once the
//! response is back: serving a file, accepting a WebSocket, opening an event stream.
//!
//! The core refuses a malformed WebSocket handshake itself, so only a valid upgrade
//! request reaches the host. An accepted connection is reached by connection id
//! through [`realtime`]: sends from any thread, encoded on the calling thread, rooms,
//! and the connection events the core posts in batches of their own, at most 64
//! unacknowledged per connection, whose payload octets count in the core's budget.
//!
//! [`conformance`] recomputes the outcomes of the shared conformance vectors with
//! the server's own parsers, encoders and routing, so every binding's runner
//! compares against one implementation.
//!
//! ```
//! use zero_host::{App, Method, RouteKind, Server, ServerOptions};
//!
//! let mut app = App::new();
//! let hello = app.route(
//!     RouteKind::Fixed,
//!     Some(Method::Get),
//!     "/hello",
//!     br#"{"status":200,"contentType":"text/plain","body":"hello"}"#,
//! )?;
//! let item = app.route(RouteKind::Host, Some(Method::Get), "/items/:id", b"")?;
//! assert_eq!((hello, item), (0, 1));
//!
//! let options = ServerOptions::parse(br#"{"threads":1,"port":0}"#)?;
//! let server = Server::new(&app, options)?;
//! assert_eq!(server.workers().len(), 1);
//! server.check_table(&app)?;
//! # Ok::<(), zero_host::HostError>(())
//! ```

pub mod access;
pub mod actions;
mod app;
pub mod conformance;
mod handler;
mod lease;
mod overload;
pub mod realtime;
mod registry;
mod rules;
mod server;
mod spec;
mod target;
pub mod testing;
mod tier0;

use std::fmt;

pub use app::{App, PolicyKind, RouteKind};
pub use registry::{free_workers, HostExchange};
pub use server::{Server, Stats};
pub use spec::ServerOptions;
pub use target::{
    abandon_batch, bind_thread, complete, read_batch, take_events, Batch, PullTarget,
};
pub use zero_http_types::Method;
pub use zero_rt::{BatchRef, Event, EventRec, Post, StatusSink, Target};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The kind of a batch of tier 3 requests.
pub const BATCH_REQUESTS: u8 = zero_rt::ring::REQUESTS;

/// The kind of a batch of WebSocket and SSE events.
pub const BATCH_EVENTS: u8 = zero_rt::ring::EVENTS;

/// The most requests or events one batch carries.
pub const MAX_BATCH: usize = zero_limits::services::MAX_BATCH_SIZE;

/// What a call of this crate's API ended with, numbered as the C ABI's status codes
/// so a binding maps it without a table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(i32)]
pub enum Status {
    /// The call succeeded.
    Ok = 0,
    /// A protocol rule refused the input.
    Protocol = 1,
    /// The operating system refused: a bind failure, an unreadable file.
    Io = 2,
    /// An option document is malformed; the message names the key or the position.
    Codec = 3,
    /// The id is stale or unknown, the slot is not in an accepted state, the target
    /// is detached, or the server is stopped.
    Closed = 4,
    /// An authentication rule refused the input.
    Auth = 5,
    /// The capability is compiled out.
    Unsupported = 6,
    /// A poll or a wait timed out.
    Timeout = 7,
    /// A bound is reached: no free worker index, a second target on a worker index.
    Limit = 8,
    /// An argument is out of its range, or the call is made from a thread that may
    /// not make it.
    InvalidArgument = 9,
    /// A panic was caught, or a slot's lock was poisoned by one.
    Panic = 10,
}

impl Status {
    /// The C ABI's number for this status.
    ///
    /// # Returns
    ///
    /// The code, from 0 to 10.
    #[must_use]
    pub const fn code(self) -> i32 {
        self as i32
    }
}

/// A refused call: the status and a message naming the argument or the refusal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostError {
    status: Status,
    message: String,
}

impl HostError {
    /// A refusal.
    ///
    /// # Arguments
    ///
    /// * `status` - the status the call ends with.
    /// * `message` - what was refused, for the host's last-error message.
    ///
    /// # Returns
    ///
    /// The error.
    #[must_use]
    pub fn new(status: Status, message: impl Into<String>) -> Self {
        HostError {
            status,
            message: message.into(),
        }
    }

    /// The status the call ended with.
    ///
    /// # Returns
    ///
    /// The status; never [`Status::Ok`] for an error this crate made.
    #[must_use]
    pub const fn status(&self) -> Status {
        self.status
    }

    /// What was refused.
    ///
    /// # Returns
    ///
    /// The message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(Status::InvalidArgument, message)
    }

    pub(crate) fn closed(message: impl Into<String>) -> Self {
        Self::new(Status::Closed, message)
    }

    pub(crate) fn codec(message: impl Into<String>) -> Self {
        Self::new(Status::Codec, message)
    }

    pub(crate) fn limit(message: impl Into<String>) -> Self {
        Self::new(Status::Limit, message)
    }

    pub(crate) fn unsupported(message: impl Into<String>) -> Self {
        Self::new(Status::Unsupported, message)
    }

    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self::new(Status::Io, message)
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.status, self.message)
    }
}

impl std::error::Error for HostError {}
