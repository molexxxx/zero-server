//! WebSocket connections, server-sent event streams and rooms, driven by a host.
//!
//! A host opens a connection by answering a leased request with
//! [`actions::ws_accept`](crate::actions::ws_accept) on a WebSocket route's upgrade
//! request, or [`actions::sse_open`](crate::actions::sse_open) on any other request
//! but HEAD. Either returns the connection's id at once; the core writes the `101`
//! or the stream head once the host completed the request, then serves the
//! connection on the core that accepted it. From any thread, the host sends with the
//! calls of this module: each encodes and checks its frame or event on the calling
//! thread, so a refusal returns before anything is queued, and queues it in the
//! connection's outbox, which the connection writes in the order the calls were
//! made. A host learns what happens on a connection from event batches: the events
//! [`EVENT_WS_OPEN`] to [`EVENT_SSE_DRAINED`], in the order they happened on each
//! connection.
//!
//! A WebSocket handshake is checked in Rust before it is leased: a request that is
//! not a valid opening handshake is answered 400, one with a version other than 13 is
//! answered 426 with `Upgrade: websocket` and `Sec-WebSocket-Version: 13`, and one
//! from an origin the route does not allow 403 (RFC 6455 Sections 4.2.1, 4.2.2 and
//! 10.2), each with the server's error body. A host that declines a valid handshake
//! answers it with an error status of its own and no upgrade happens. An accepted
//! subprotocol is one the client offered and the route allows; accepting with none
//! sends no `Sec-WebSocket-Protocol`.
//!
//! The rooms of a server group its WebSocket connections across every core: a
//! connection joins and leaves rooms in order with what it sends, and
//! [`Server::room_broadcast`](crate::Server::room_broadcast) reaches every member but
//! the one it leaves out, each in order with what is sent on it.
//!
//! When the server drains, a WebSocket sends what its outbox holds, then Close 1001,
//! and an event stream sends what its outbox holds and ends; each reports its close
//! event first. Without the `realtime` capability every call here returns
//! [`Status::Unsupported`](crate::Status::Unsupported).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1>
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html>

#[cfg(feature = "realtime")]
pub(crate) mod conns;
#[cfg(feature = "realtime")]
mod events;
#[cfg(feature = "realtime")]
mod rooms;
#[cfg(feature = "realtime")]
mod sse;
#[cfg(feature = "realtime")]
mod ws;

use crate::HostError;

/// A WebSocket connection opened: the `101` went out.
pub const EVENT_WS_OPEN: u8 = 1;

/// A whole WebSocket message: the opcode is [`OPCODE_TEXT`] or [`OPCODE_BINARY`] and
/// the data is the payload.
pub const EVENT_WS_MESSAGE: u8 = 2;

/// A pong; the data is its application data.
pub const EVENT_WS_PONG: u8 = 3;

/// The WebSocket connection closed. The code is the status code of the Close the
/// peer sent, 1005 for a Close that carried none, and 1006 when no Close arrived
/// (RFC 6455 Section 7.1.5); the data is the reason, the UTF-8 data that followed
/// the status code in that Close, empty when it carried none or no Close arrived
/// (Section 7.1.6).
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.5>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.6>
pub const EVENT_WS_CLOSE: u8 = 4;

/// The WebSocket connection's outbox fell below half its high-water mark after
/// passing it, so the host may send again.
pub const EVENT_WS_DRAINED: u8 = 5;

/// The event stream ended.
pub const EVENT_SSE_CLOSED: u8 = 6;

/// The event stream's outbox fell below half its high-water mark after passing it.
pub const EVENT_SSE_DRAINED: u8 = 7;

/// The opcode of a text message, which is UTF-8.
pub const OPCODE_TEXT: u8 = 1;

/// The opcode of a binary message.
pub const OPCODE_BINARY: u8 = 2;

#[cfg(feature = "realtime")]
pub(crate) use imp::{after_turn, dropped, serve, Local, Routes, ServerRealtime};
#[cfg(feature = "realtime")]
pub(crate) use rooms::{broadcast, size};
#[cfg(feature = "realtime")]
pub(crate) use sse::open_event_stream;
#[cfg(feature = "realtime")]
pub(crate) use ws::{open_websocket, refuse_handshake};

#[cfg(not(feature = "realtime"))]
fn compiled_out() -> HostError {
    HostError::unsupported(
        "WebSocket and event streams need the `realtime` capability, which this build leaves out",
    )
}

/// Send a message on a WebSocket connection.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `opcode` - [`OPCODE_TEXT`] or [`OPCODE_BINARY`].
/// * `data` - the message; UTF-8 for text (RFC 6455 Section 5.6).
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for another opcode,
/// text that is not UTF-8, an id above 2^53 - 1 or the id of an event stream;
/// [`Status::Closed`](crate::Status::Closed) once the connection ended or a close was
/// sent; [`Status::Limit`](crate::Status::Limit) when its outbox, or the outboxes of
/// its core together, would pass their limit. Nothing is queued then.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.6>
pub fn ws_send(conn: u64, opcode: u8, data: &[u8]) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        ws::send(conn, opcode, data)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, opcode, data);
        Err(compiled_out())
    }
}

/// Send a ping on a WebSocket connection; the pong arrives as [`EVENT_WS_PONG`].
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `data` - the application data, at most 125 octets, since "All control frames
///   MUST have a payload length of 125 bytes or less" (RFC 6455 Section 5.5).
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for more than 125
/// octets, and otherwise as [`ws_send`].
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5>
pub fn ws_ping(conn: u64, data: &[u8]) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        ws::ping(conn, data)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, data);
        Err(compiled_out())
    }
}

/// Start the closing handshake of a WebSocket connection, after what was sent
/// before.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `code` - a status code a server may send: 1000 to 1003, 1007 to 1009, 1011 to
///   1014, or 3000 to 4999. 1005, 1006 and 1015 "MUST NOT be set as a status code in
///   a Close control frame by an endpoint", 1004 is reserved, 1010 is a client's,
///   the rest of 1000 to 2999 is unassigned in the IANA registry that Section 11.7
///   creates, and codes below 1000 are not used (RFC 6455 Sections 7.4.1, 7.4.2 and
///   11.7).
/// * `reason` - UTF-8, at most 123 octets, so the code and the reason fit the 125
///   octets of a control frame (Sections 5.5 and 5.5.1).
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for any other code, a
/// reason that is not UTF-8 or longer than 123 octets, and otherwise as
/// [`ws_send`].
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-11.7>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.1>
pub fn ws_close(conn: u64, code: u16, reason: &[u8]) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        ws::close(conn, code, reason)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, code, reason);
        Err(compiled_out())
    }
}

/// End a WebSocket connection without a Close frame, once what was sent before is
/// written.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Errors
///
/// As [`ws_send`].
pub fn ws_terminate(conn: u64) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        ws::terminate(conn)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = conn;
        Err(compiled_out())
    }
}

/// Whether a WebSocket connection takes more without passing its high-water mark.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Returns
///
/// `false` once its outbox holds more than its high-water mark or the outboxes of
/// its core hold more than half their limit; a send may still be queued then, up
/// to the limits of [`ws_send`].
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for an id above
/// 2^53 - 1 or the id of an event stream, and
/// [`Status::Closed`](crate::Status::Closed) once the connection ended.
pub fn ws_writable(conn: u64) -> Result<bool, HostError> {
    #[cfg(feature = "realtime")]
    {
        ws::writable(conn)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = conn;
        Err(compiled_out())
    }
}

/// The octets sent on a WebSocket connection and not yet written to its socket.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Returns
///
/// The octets.
///
/// # Errors
///
/// As [`ws_writable`].
pub fn ws_buffered(conn: u64) -> Result<u64, HostError> {
    #[cfg(feature = "realtime")]
    {
        ws::buffered(conn)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = conn;
        Err(compiled_out())
    }
}

/// Send an event on an event stream.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `event` - the event type, or `None` for none; present and empty is an empty
///   type, which the client reads as `message`.
/// * `id` - the event id, or `None` for none; present and empty resets the id the
///   client reports when it reconnects.
/// * `data` - the data; split at CRLF, LF and CR, each line its own `data` field.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a value that is
/// not UTF-8, an `event` or `id` holding CR or LF, an `id` holding U+0000 (WHATWG
/// HTML Sections 9.2.5 and 9.2.6), an id above 2^53 - 1 or the id of a WebSocket;
/// [`Status::Closed`](crate::Status::Closed) once the stream ended or was closed;
/// [`Status::Limit`](crate::Status::Limit) as for [`ws_send`]. Nothing is queued
/// then.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation>
pub fn sse_send(
    conn: u64,
    event: Option<&[u8]>,
    id: Option<&[u8]>,
    data: &[u8],
) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        sse::send(conn, event, id, data)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, event, id, data);
        Err(compiled_out())
    }
}

/// Send a comment on an event stream, which the client ignores: one comment line per
/// line of `text`, split at CRLF, LF and CR.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `text` - the comment, UTF-8.
///
/// # Errors
///
/// As [`sse_send`].
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
pub fn sse_comment(conn: u64, text: &[u8]) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        sse::comment(conn, text)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, text);
        Err(compiled_out())
    }
}

/// Tell the client of an event stream how long to wait before it reconnects.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `milliseconds` - the reconnection time, written as ASCII digits.
///
/// # Errors
///
/// As [`sse_send`].
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation>
pub fn sse_retry(conn: u64, milliseconds: u32) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        sse::retry(conn, milliseconds)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, milliseconds);
        Err(compiled_out())
    }
}

/// End an event stream once what was sent before is written.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Errors
///
/// As [`sse_send`].
pub fn sse_close(conn: u64) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        sse::close(conn)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = conn;
        Err(compiled_out())
    }
}

/// Whether an event stream takes more without passing its high-water mark.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Returns
///
/// As [`ws_writable`].
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for an id above
/// 2^53 - 1 or the id of a WebSocket, and
/// [`Status::Closed`](crate::Status::Closed) once the stream ended.
pub fn sse_writable(conn: u64) -> Result<bool, HostError> {
    #[cfg(feature = "realtime")]
    {
        sse::writable(conn)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = conn;
        Err(compiled_out())
    }
}

/// The octets sent on an event stream and not yet written to its socket.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Returns
///
/// The octets.
///
/// # Errors
///
/// As [`sse_writable`].
pub fn sse_buffered(conn: u64) -> Result<u64, HostError> {
    #[cfg(feature = "realtime")]
    {
        sse::buffered(conn)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = conn;
        Err(compiled_out())
    }
}

/// Put a WebSocket connection in a room of its server, in order with what is sent on
/// it.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `room` - the room's name, UTF-8.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a name that is not
/// UTF-8, and otherwise as [`ws_send`].
pub fn room_join(conn: u64, room: &[u8]) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        rooms::join(conn, room)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, room);
        Err(compiled_out())
    }
}

/// Take a WebSocket connection out of a room, in order with what is sent on it.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `room` - the room's name, UTF-8.
///
/// # Errors
///
/// As [`room_join`].
pub fn room_leave(conn: u64, room: &[u8]) -> Result<(), HostError> {
    #[cfg(feature = "realtime")]
    {
        rooms::leave(conn, room)
    }
    #[cfg(not(feature = "realtime"))]
    {
        let _ = (conn, room);
        Err(compiled_out())
    }
}

#[cfg(not(feature = "realtime"))]
pub(crate) fn unsupported() -> HostError {
    compiled_out()
}

#[cfg(all(test, not(feature = "realtime")))]
mod tests {
    use zero_http::Exchange;

    use super::*;
    use crate::{actions, App, Server, ServerOptions, Status};

    #[test]
    fn every_realtime_call_answers_unsupported_without_the_realtime_capability() {
        let unsupported = Some(Status::Unsupported);
        let status = |result: Result<(), HostError>| result.err().map(|err| err.status());
        assert_eq!(status(ws_send(1, OPCODE_TEXT, b"x")), unsupported);
        assert_eq!(status(ws_ping(1, b"")), unsupported);
        assert_eq!(status(ws_close(1, 1000, b"")), unsupported);
        assert_eq!(status(ws_terminate(1)), unsupported);
        assert_eq!(status(ws_writable(1).map(drop)), unsupported);
        assert_eq!(status(ws_buffered(1).map(drop)), unsupported);
        assert_eq!(status(sse_send(1, None, None, b"x")), unsupported);
        assert_eq!(status(sse_comment(1, b"x")), unsupported);
        assert_eq!(status(sse_retry(1, 1)), unsupported);
        assert_eq!(status(sse_close(1)), unsupported);
        assert_eq!(status(sse_writable(1).map(drop)), unsupported);
        assert_eq!(status(sse_buffered(1).map(drop)), unsupported);
        assert_eq!(status(room_join(1, b"r")), unsupported);
        assert_eq!(status(room_leave(1, b"r")), unsupported);

        let mut exchange = Exchange::default();
        assert_eq!(
            status(actions::sse_open(1, &mut exchange, 0).map(drop)),
            unsupported
        );
        assert_eq!(
            status(actions::ws_accept(1, &mut exchange, b"").map(drop)),
            unsupported
        );
        assert!(!exchange.sealed(), "a refused action records nothing");

        let options = ServerOptions::parse(br#"{"threads":1}"#).unwrap();
        let server = Server::new(&App::new(), options).unwrap();
        assert_eq!(
            status(
                server
                    .room_broadcast(b"r", OPCODE_TEXT, b"x", None)
                    .map(drop)
            ),
            unsupported
        );
        assert_eq!(status(server.room_size(b"r").map(drop)), unsupported);
    }
}

#[cfg(feature = "realtime")]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::future::{poll_fn, Future};
    use std::rc::Rc;
    use std::sync::Arc;
    use std::task::Poll;
    use std::time::{Duration, Instant};

    use zero_core::SlotId;
    use zero_http::{Call, Problem, ReadHold, Taken};
    use zero_http_types::StatusCode;
    use zero_io::seam::Stream;
    use zero_limits::{Limits, WebSocketLimits};
    use zero_realtime::Rooms;
    use zero_rt::{Dispatcher, EventRec, SlotState};

    use super::conns::{self, Kind, Table};
    use super::events::{octets_of, Ledger, Pending, Wait};
    use super::{sse, ws, EVENT_SSE_CLOSED, EVENT_WS_CLOSE};
    use crate::app::{Built, RouteSpec};
    use crate::handler::CoreHost;
    use crate::registry::WorkerShared;

    /// The close code a WebSocket reports when no Close arrived (RFC 6455 Section
    /// 7.1.5).
    pub(crate) const ABNORMAL: u16 = 1006;

    /// The code of the answer to an action whose connection is reserved for a slot
    /// of another core.
    pub(crate) const FOREIGN_CONNECTION: &str = "FOREIGN_CONNECTION";

    /// Whether `conn` belongs to a worker index other than this core's: the host
    /// passed the slot id of one request with the exchange of another.
    pub(crate) fn foreign(core: &CoreHost, conn: SlotId) -> bool {
        conn.worker() != core.shared().index
    }

    /// Answer an action whose connection belongs to another core with 500: nothing
    /// is set up here, and the reservation closes on its own core once the slot it
    /// names ends.
    pub(crate) fn refuse_foreign(core: &CoreHost, call: &mut Call<'_>) {
        call.problem(&Problem::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            FOREIGN_CONNECTION,
        ));
        core.settings().rules.after(call);
    }

    /// The WebSocket routes of a server: the subprotocols each allows, which a host
    /// thread checks an accept against.
    #[derive(Debug, Default)]
    pub(crate) struct Routes {
        protocols: Vec<Option<Vec<Box<[u8]>>>>,
    }

    impl Routes {
        fn new(app: &Built) -> Self {
            Routes {
                protocols: app
                    .routes
                    .iter()
                    .map(|spec| match spec {
                        Some(RouteSpec::WebSocket(route)) => Some(
                            route
                                .protocols
                                .iter()
                                .map(|protocol| Box::from(protocol.as_bytes()))
                                .collect(),
                        ),
                        _ => None,
                    })
                    .collect(),
            }
        }

        /// The subprotocols WebSocket route `route` allows, empty for any the
        /// client offers; `None` when the route is not a WebSocket route.
        pub(crate) fn protocols(&self, route: u32) -> Option<&[Box<[u8]>]> {
            self.protocols.get(usize::try_from(route).ok()?)?.as_deref()
        }
    }

    /// What every core of a server shares for its connections.
    #[derive(Debug)]
    pub(crate) struct ServerRealtime {
        pub(crate) rooms: Arc<Rooms>,
        pub(crate) routes: Arc<Routes>,
        pub(crate) websocket: WebSocketLimits,
        /// How long an accepted connection may wait for its response head to be
        /// written: the request total, which ends any request sooner.
        pub(crate) claim_timeout: Duration,
        /// The request-memory budget of each core, in octets.
        pub(crate) memory_budget: u64,
    }

    impl ServerRealtime {
        pub(crate) fn new(app: &Built, limits: &Limits) -> Self {
            ServerRealtime {
                rooms: Arc::new(Rooms::new()),
                routes: Arc::new(Routes::new(app)),
                websocket: limits.websocket,
                claim_timeout: limits.http1.request_total,
                memory_budget: limits.memory.request_memory_per_core,
            }
        }
    }

    /// What a connection the core accepted needs once its task starts.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Start {
        WebSocket {
            limits: WebSocketLimits,
            ping: Option<Duration>,
        },
        EventStream {
            keep_alive_ms: u64,
        },
    }

    /// A connection whose response head is on its way: its task has not started.
    #[derive(Clone, Copy, Debug)]
    struct Claim {
        conn: SlotId,
        deadline: Instant,
        start: Start,
    }

    /// The connections of one core. When the core ends, every connection of its
    /// worker index that is still reserved or claimed closes, since no task will
    /// serve it, and a core that starts on an index an earlier server used closes
    /// what that server left there without reporting it.
    #[derive(Debug)]
    pub(crate) struct Local {
        table: Option<&'static Table>,
        pub(crate) ledger: RefCell<Ledger>,
        claims: RefCell<Vec<Claim>>,
        /// The close events of connections that never started, oldest first, which
        /// wait here while the dispatcher's queue holds its bound.
        refused: RefCell<VecDeque<EventRec>>,
        /// When the claims close at the latest once the server drains, set on the
        /// drain's first turn.
        drain_cap: Cell<Option<Instant>>,
    }

    /// The close event of a connection that never started: 1006 for a WebSocket,
    /// since no Close arrived (RFC 6455 Section 7.1.5).
    fn never_started(conn: SlotId, kind: Kind, route: u32) -> EventRec {
        let (kind, code) = match kind {
            Kind::WebSocket => (EVENT_WS_CLOSE, ABNORMAL),
            Kind::EventStream => (EVENT_SSE_CLOSED, 0),
        };
        EventRec {
            conn: conn.as_u64(),
            route,
            kind,
            opcode: 0,
            code,
            data: Vec::new(),
        }
    }

    impl Local {
        /// The connections of the core serving worker index `worker`, with the
        /// server's WebSocket routes installed for the host threads.
        pub(crate) fn new(worker: u8, server: &ServerRealtime) -> Self {
            let table = conns::table(worker);
            if let Some(table) = table {
                table.close_all();
                table.set_routes(Arc::clone(&server.routes));
            }
            Local {
                table,
                ledger: RefCell::new(Ledger::default()),
                claims: RefCell::new(Vec::new()),
                refused: RefCell::new(VecDeque::new()),
                drain_cap: Cell::new(None),
            }
        }

        pub(crate) const fn table(&self) -> Option<&'static Table> {
            self.table
        }

        /// The octets the outboxes of this worker index hold, and the payload octets
        /// of the events this core handed over that the host has not acknowledged.
        pub(crate) fn queued(&self) -> u64 {
            let outboxes = self.table.map_or(0, |table| table.total().queued());
            let events = self
                .ledger
                .try_borrow()
                .map_or(0, |ledger| ledger.outstanding());
            outboxes.saturating_add(events)
        }

        /// The action that set up `conn` ran and its response head is on its way:
        /// the connection counts as open from now, and closes if its task does not
        /// start in time. Once the core's host dispatch failed it closes at once,
        /// since no dispatcher is left to end it.
        pub(crate) fn claim(&self, core: &CoreHost, conn: SlotId, start: Start) {
            let Some(table) = self.table else {
                return;
            };
            if core.failed.get() {
                table.close(conn);
                return;
            }
            table.drop_reservation(conn);
            let timeout = core.settings().realtime.claim_timeout;
            let now = Instant::now();
            let mut deadline = now.checked_add(timeout).unwrap_or(now);
            if let Some(cap) = self.drain_cap.get() {
                deadline = deadline.min(cap);
            }
            self.claims.borrow_mut().push(Claim {
                conn,
                deadline,
                start,
            });
            if let Ok(mut dispatch) = core.dispatch.try_borrow_mut() {
                dispatch.connection_opened();
            }
            core.kick.wake();
        }

        /// The action that reserved `conn` could not set it up: close it and report
        /// it closed.
        pub(crate) fn abandon(&self, core: &CoreHost, conn: SlotId) {
            self.close_unstarted(core, conn);
            core.kick.wake();
        }

        /// The driver let go of the claimed connection `conn` before its response
        /// head was written, as when its client left: it closes now rather than at
        /// its deadline, is reported closed and counted closed.
        pub(crate) fn dropped(&self, core: &CoreHost, conn: SlotId) {
            if self.take_claim(conn).is_none() {
                return;
            }
            self.close_unstarted(core, conn);
            if let Ok(mut dispatch) = core.dispatch.try_borrow_mut() {
                dispatch.connection_closed();
            }
            core.kick.wake();
        }

        /// Close `conn`, whose task never started, and report it closed.
        fn close_unstarted(&self, core: &CoreHost, conn: SlotId) {
            let Some(live) = self.table.and_then(|table| table.close(conn)) else {
                return;
            };
            match (core.dispatch.try_borrow_mut(), self.ledger.try_borrow_mut()) {
                (Ok(mut dispatch), Ok(mut ledger)) => {
                    self.report_closed(&mut dispatch, &mut ledger, conn, live.kind, live.route);
                }
                _ => {
                    if let Ok(mut refused) = self.refused.try_borrow_mut() {
                        refused.push_back(never_started(conn, live.kind, live.route));
                    }
                }
            }
        }

        /// The core's host dispatch failed, so no dispatcher turn will close a
        /// connection again: close every claim and every reservation of the worker
        /// index without reporting them, since no host is left to tell, and count
        /// every event acknowledged.
        pub(crate) fn fail(&self) {
            if let Some(table) = self.table {
                if let Ok(mut claims) = self.claims.try_borrow_mut() {
                    for claim in claims.drain(..) {
                        table.close(claim.conn);
                    }
                }
                table.close_reserved();
            }
            if let Ok(mut refused) = self.refused.try_borrow_mut() {
                refused.clear();
            }
            if let Ok(mut ledger) = self.ledger.try_borrow_mut() {
                ledger.forget();
            }
        }

        fn take_claim(&self, conn: SlotId) -> Option<Start> {
            let mut claims = self.claims.try_borrow_mut().ok()?;
            let position = claims.iter().position(|claim| claim.conn == conn)?;
            Some(claims.swap_remove(position).start)
        }

        /// Hand the host the close event of a connection that never started, after
        /// the close events that wait already, or keep it waiting for room.
        ///
        /// # Returns
        ///
        /// Whether the dispatcher took an event.
        fn report_closed(
            &self,
            dispatch: &mut Dispatcher<ReadHold>,
            ledger: &mut Ledger,
            conn: SlotId,
            kind: Kind,
            route: u32,
        ) -> bool {
            if !dispatch.has_target() {
                return false;
            }
            if let Ok(mut refused) = self.refused.try_borrow_mut() {
                refused.push_back(never_started(conn, kind, route));
            }
            self.post_refused(dispatch, ledger)
        }

        /// Hand the dispatcher the close events that wait, oldest first, while its
        /// queue takes them; with no target they are dropped, since no host is there
        /// to take them.
        ///
        /// # Returns
        ///
        /// Whether the dispatcher took an event.
        fn post_refused(&self, dispatch: &mut Dispatcher<ReadHold>, ledger: &mut Ledger) -> bool {
            let Ok(mut refused) = self.refused.try_borrow_mut() else {
                return false;
            };
            if !dispatch.has_target() {
                refused.clear();
                return false;
            }
            let mut took = false;
            while let Some(event) = refused.pop_front() {
                let octets = octets_of(&event);
                match dispatch.push_event(event) {
                    Ok(()) => {
                        ledger.took(octets);
                        took = true;
                    }
                    Err(event) => {
                        refused.push_front(event);
                        ledger.full();
                        break;
                    }
                }
            }
            took
        }
    }

    impl Drop for Local {
        fn drop(&mut self) {
            if let Some(table) = self.table {
                table.close_all();
            }
        }
    }

    /// Whether the slot a reservation names can no longer run its action: it was
    /// retired, or its lease was closed.
    fn gone(shared: &WorkerShared, slot: SlotId) -> bool {
        match shared.arena.lookup(slot) {
            Ok(found) => {
                let word = found.word();
                word.generation() != slot.generation() || word.state() == SlotState::Closed
            }
            Err(_) => true,
        }
    }

    /// What the core's connection bookkeeping asks of the dispatcher after a turn.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub(crate) struct Settled {
        /// The next claim deadline.
        pub(crate) deadline: Option<Instant>,
        /// Events were handed over or a connection was counted closed, so another
        /// turn posts them and checks the drain again.
        pub(crate) again: bool,
        /// Close events wait for room in the dispatcher's queue, which a later turn
        /// makes, so the drain is not over.
        pub(crate) waiting: bool,
    }

    /// The core's connection bookkeeping after a dispatcher turn: the close events
    /// that waited for room are handed over first, the ledger learns what was posted
    /// and acknowledged, connections reserved by leases that ended without their
    /// action close, and accepted connections whose task never started close once
    /// their deadline passes, which the drain brings in to at most
    /// [`CLOSE_TIMEOUT`](zero_realtime::websocket::CLOSE_TIMEOUT) from its first
    /// turn, for the claims made during the drain as well.
    ///
    /// # Returns
    ///
    /// What the dispatcher has to do about the connections.
    pub(crate) fn after_turn(
        core: &CoreHost,
        dispatch: &mut Dispatcher<ReadHold>,
        now: Instant,
        stopping: bool,
    ) -> Settled {
        let local = core.realtime();
        let shared = core.shared();
        let Ok(mut ledger) = local.ledger.try_borrow_mut() else {
            return Settled::default();
        };
        let mut again = local.post_refused(dispatch, &mut ledger);
        let queued = dispatch.queued_events();
        let open = !dispatch.has_target() || queued.0 < dispatch.limits().queue_bound();
        ledger.settle(
            queued,
            shared.intake.published(),
            shared.intake.acked(),
            open,
        );
        if let Some(table) = local.table {
            for (conn, live) in table.sweep(|slot| gone(shared, slot)) {
                again |= local.report_closed(dispatch, &mut ledger, conn, live.kind, live.route);
            }
        }
        if stopping && local.drain_cap.get().is_none() {
            local.drain_cap.set(Some(
                now.checked_add(zero_realtime::websocket::CLOSE_TIMEOUT)
                    .unwrap_or(now),
            ));
        }
        let mut deadline = None;
        if let Ok(mut claims) = local.claims.try_borrow_mut() {
            if let Some(cap) = local.drain_cap.get() {
                for claim in claims.iter_mut() {
                    claim.deadline = claim.deadline.min(cap);
                }
            }
            claims.retain(|claim| {
                if claim.deadline > now {
                    return true;
                }
                if let Some(live) = local.table.and_then(|table| table.close(claim.conn)) {
                    local.report_closed(dispatch, &mut ledger, claim.conn, live.kind, live.route);
                }
                dispatch.connection_closed();
                again = true;
                false
            });
            deadline = claims.iter().map(|claim| claim.deadline).min();
        }
        let waiting = local
            .refused
            .try_borrow()
            .is_ok_and(|refused| !refused.is_empty());
        Settled {
            deadline,
            again,
            waiting,
        }
    }

    /// Wait until the ledger may end `wait`: an acknowledgment arrived or, for an
    /// event the dispatcher refused, it can take one.
    pub(crate) fn changed(core: &CoreHost, wait: Wait) -> impl Future<Output = ()> + '_ {
        poll_fn(move |cx| match core.realtime().ledger.try_borrow_mut() {
            Ok(mut ledger) => ledger.poll_change(wait.since, wait.room, cx),
            Err(_) => Poll::Ready(()),
        })
    }

    /// One connection a core serves, from its task's start to its last event: it
    /// ends the connection in the table and in the dispatcher's count however the
    /// task ends, dropped at the drain deadline or by a panic included.
    pub(crate) struct Served<'a> {
        core: &'a CoreHost,
        id: SlotId,
        kind: Kind,
        pending: Pending,
        last: bool,
        ended: bool,
    }

    impl<'a> Served<'a> {
        fn new(core: &'a CoreHost, id: SlotId, kind: Kind, route: u32) -> Self {
            Served {
                core,
                id,
                kind,
                pending: Pending::new(id.as_u64(), route),
                last: false,
                ended: false,
            }
        }

        /// Report an event of this connection.
        pub(crate) fn report(&mut self, kind: u8, opcode: u8, code: u16, data: Vec<u8>) {
            let event = self.pending.event(kind, opcode, code, data);
            self.pending.report(self.core, event);
        }

        /// Hand over what waits and tell whether the connection must stop reading.
        pub(crate) fn settle(&mut self) -> Wait {
            self.pending.settle(self.core)
        }

        /// The connection ended: close it in the table, so the host's later sends are
        /// refused, hand the host its close event once the dispatcher takes it, and
        /// count it closed.
        async fn end(mut self, kind: u8, code: u16, data: Vec<u8>) {
            if let Some(table) = self.core.realtime().table() {
                table.close(self.id);
            }
            self.last = true;
            self.report(kind, 0, code, data);
            loop {
                let wait = self.pending.settle(self.core);
                if self.pending.is_clear() || !wait.room {
                    break;
                }
                changed(self.core, wait).await;
            }
            self.ended = true;
            closed(self.core);
        }
    }

    impl Drop for Served<'_> {
        fn drop(&mut self) {
            if self.ended {
                return;
            }
            if let Some(table) = self.core.realtime().table() {
                table.close(self.id);
            }
            if self.last {
                self.pending.flush(self.core);
            } else {
                let (kind, code) = match self.kind {
                    Kind::WebSocket => (EVENT_WS_CLOSE, ABNORMAL),
                    Kind::EventStream => (EVENT_SSE_CLOSED, 0),
                };
                self.report(kind, 0, code, Vec::new());
            }
            closed(self.core);
        }
    }

    /// Count a connection closed once its last event is queued.
    fn closed(core: &CoreHost) {
        if let Ok(mut dispatch) = core.dispatch.try_borrow_mut() {
            dispatch.connection_closed();
        }
        core.kick.wake();
    }

    /// The driver let go of the connection `token` names before its response head
    /// was written.
    pub(crate) fn dropped(core: &CoreHost, token: u64) {
        if let Ok(id) = conns::parse(token) {
            core.realtime().dropped(core, id);
        }
    }

    /// Serve a connection the core claimed for a host's WebSocket accept or event
    /// stream, until it ends.
    pub(crate) async fn serve<S: Stream + 'static>(core: Rc<CoreHost>, taken: Taken<S>) {
        let local = core.realtime();
        let Ok(id) = conns::parse(taken.token()) else {
            return;
        };
        let Some(start) = local.take_claim(id) else {
            return;
        };
        let Some(live) = local.table().and_then(|table| table.live(id)) else {
            closed(&core);
            return;
        };
        let mut served = Served::new(&core, id, live.kind, live.route);
        match start {
            Start::WebSocket { limits, ping } if live.kind == Kind::WebSocket => {
                let (code, reason) =
                    ws::run(&core, &mut served, taken, live.outbox, limits, ping).await;
                served.end(EVENT_WS_CLOSE, code, reason).await;
            }
            Start::EventStream { keep_alive_ms } if live.kind == Kind::EventStream => {
                sse::run(&core, &mut served, taken, live.outbox, keep_alive_ms).await;
                served.end(EVENT_SSE_CLOSED, 0, Vec::new()).await;
            }
            Start::WebSocket { .. } | Start::EventStream { .. } => {}
        }
    }
}
