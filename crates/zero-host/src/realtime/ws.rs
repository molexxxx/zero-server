//! WebSocket connections: the handshake checked before a lease, the accept a host
//! asks for, the connection task, and the calls a host sends with.

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::{Duration, Instant};

use zero_core::Error;
use zero_http::{Call, Problem, Taken};
use zero_http1::Version;
use zero_io::seam::{Stream, Timer};
use zero_limits::WebSocketLimits;
use zero_realtime::websocket::PROTOCOL;
use zero_realtime::{Command, Incoming, Message, Outbox, ReadPause, WebSocket};
use zero_ws::close::MAX_REASON;
use zero_ws::frame::{self, Opcode, MAX_CONTROL_PAYLOAD};
use zero_ws::handshake::{self, Config, Reason, Refusal};
use zero_ws::CloseCode;

use super::conns::{self, Kind, Live};
use super::imp::{changed, foreign, refuse_foreign, Served, Start, ABNORMAL};
use super::{
    EVENT_WS_DRAINED, EVENT_WS_MESSAGE, EVENT_WS_OPEN, EVENT_WS_PONG, OPCODE_BINARY, OPCODE_TEXT,
};
use crate::app::RouteSpec;
use crate::handler::CoreHost;
use crate::rules::Answered;
use crate::server::Settings;
use crate::spec::WebSocketSpec;
use crate::HostError;

/// The code of the answer to a request that is not a valid opening handshake.
const HANDSHAKE: &str = "protocol";

/// The code of the answer to a handshake with a version other than 13.
const UPGRADE_REQUIRED: &str = "upgrade_required";

/// The options of WebSocket route `route`.
fn route_spec(settings: &Settings, route: u32) -> Option<&WebSocketSpec> {
    match settings.app.routes.get(usize::try_from(route).ok()?)? {
        Some(RouteSpec::WebSocket(spec)) => Some(spec),
        _ => None,
    }
}

/// The origins a route allows, as the handshake compares them.
fn origins(spec: Option<&WebSocketSpec>) -> Option<Vec<&[u8]>> {
    spec.and_then(|spec| spec.origins.as_ref())
        .map(|origins| origins.iter().map(String::as_bytes).collect())
}

/// Answer a WebSocket route's request in Rust when it is not an opening handshake the
/// route accepts, so only a valid upgrade reaches the host: 400 for a request that
/// is not one, 426 with `Upgrade: websocket` and `Sec-WebSocket-Version: 13` for
/// another version, and 403 for an origin outside the route's list, each with the
/// server's error body.
///
/// # Returns
///
/// [`Answered::Yes`] when the request was refused.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.1>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2>
pub(crate) fn refuse_handshake(core: &CoreHost, call: &mut Call<'_>, route: u32) -> Answered {
    let spec = route_spec(core.settings(), route);
    let origins = origins(spec);
    let config = Config {
        protocols: &[],
        origins: origins.as_deref(),
    };
    let refusal = {
        let request = call.request();
        let http11 = request.version() != Version::Http10;
        match handshake::negotiate(request.method(), http11, request.headers(), &config) {
            Ok(_) => return Answered::No,
            Err(refusal) => refusal,
        }
    };
    refuse(call, refusal);
    Answered::Yes
}

/// Write a refused handshake's answer: the status, its fields and the error body.
fn refuse(call: &mut Call<'_>, refusal: Refusal) {
    let code = match refusal.reason {
        Reason::Version => UPGRADE_REQUIRED,
        Reason::Origin => crate::actions::FORBIDDEN,
        Reason::Method
        | Reason::HttpVersion
        | Reason::Host
        | Reason::Upgrade
        | Reason::Connection
        | Reason::Key
        | Reason::MissingVersion => HANDSHAKE,
    };
    call.problem(&Problem::new(refusal.status, code));
    if refusal.reason == Reason::Version {
        let _ = call.upgrade_required(PROTOCOL);
    }
    for (name, value) in refusal.fields {
        let _ = call.response().header(name, value);
    }
}

/// The fields of the opening handshake the core writes into the `101` itself.
const HANDSHAKE_FIELDS: [&[u8]; 5] = [
    b"upgrade",
    b"sec-websocket-accept",
    b"sec-websocket-protocol",
    b"sec-websocket-extensions",
    b"sec-websocket-version",
];

/// Run a host's WebSocket accept: answer `101` with the subprotocol the host chose,
/// or none, and claim the connection for its task; a handshake that fails now closes
/// the reserved connection and reports it closed. The handshake fields of the `101`
/// are the core's alone, whatever the host set: each "MUST NOT appear more than once
/// in an HTTP response" (RFC 6455 Sections 11.3.2 to 11.3.4), and a subprotocol the
/// client did not request makes it fail the connection (Section 4.1), as would an
/// extension the core does not implement.
///
/// # Errors
///
/// The digest's error, or a field the response refuses.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-11.3.4>
pub(crate) fn open_websocket(
    core: &CoreHost,
    call: &mut Call<'_>,
    route: u32,
    conn: u64,
    protocol: &[u8],
) -> Result<(), Error> {
    let Ok(id) = conns::parse(conn) else {
        return Ok(());
    };
    if foreign(core, id) {
        refuse_foreign(core, call);
        return Ok(());
    }
    let local = core.realtime();
    let settings = core.settings();
    let spec = route_spec(settings, route);
    let origins = origins(spec);
    let chosen = [protocol];
    let config = Config {
        protocols: if protocol.is_empty() { &[] } else { &chosen },
        origins: origins.as_deref(),
    };
    {
        let mut response = call.response();
        for name in HANDSHAKE_FIELDS {
            response.remove_header(name);
        }
    }
    match zero_realtime::accept_websocket(call, &config, conn) {
        Ok(true) => {
            let server = &settings.realtime;
            let limits = WebSocketLimits {
                max_message: spec
                    .and_then(|spec| spec.max_payload)
                    .unwrap_or(server.websocket.max_message),
                ..server.websocket
            };
            let ping = spec
                .and_then(|spec| spec.ping_interval)
                .filter(|every| !every.is_zero());
            local.claim(core, id, Start::WebSocket { limits, ping });
            Ok(())
        }
        Ok(false) => {
            local.abandon(core, id);
            crate::actions::refusal_body(call, settings.shape);
            Ok(())
        }
        Err(err) => {
            local.abandon(core, id);
            Err(err)
        }
    }
}

/// What woke the connection task.
enum Woke {
    Socket(Option<Incoming>),
    Ledger,
    Ping,
}

/// Serve an accepted WebSocket until it ends: report it open, report each message,
/// pong and drained outbox, write what the host sends and what is broadcast to its
/// rooms, ping it at the route's interval, and stop reading its socket while it
/// holds its bound of events the host has not acknowledged.
///
/// # Returns
///
/// The close code to report: the peer's, 1005 for a Close without one, 1006 when no
/// Close arrived (RFC 6455 Section 7.1.5); and the reason: the UTF-8 data after the
/// status code of the peer's Close, empty when it carried none or none arrived
/// (Section 7.1.6).
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.5>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.6>
pub(crate) async fn run<S: Stream + 'static>(
    core: &CoreHost,
    served: &mut Served<'_>,
    taken: Taken<S>,
    outbox: Arc<Outbox>,
    limits: WebSocketLimits,
    ping: Option<Duration>,
) -> (u16, Vec<u8>) {
    let rooms = Arc::clone(&core.settings().realtime.rooms);
    let pause = ReadPause::new();
    let mut socket = WebSocket::new(taken, limits)
        .with_outbox(Arc::clone(&outbox), &rooms)
        .with_read_pause(pause.clone());
    served.report(EVENT_WS_OPEN, 0, 0, Vec::new());
    let mut next_ping = ping.and_then(|every| Instant::now().checked_add(every));
    loop {
        let wait = served.settle();
        if wait.paused {
            pause.pause();
        } else {
            pause.resume();
        }
        let woke = {
            let clock = core.worker().core();
            let mut incoming = pin!(socket.recv_event());
            let mut due =
                pin!(next_ping.map(|at| clock.sleep(at.saturating_duration_since(Instant::now()))));
            let mut ledger = pin!(changed(core, wait));
            poll_fn(|cx| {
                if let Poll::Ready(incoming) = incoming.as_mut().poll(cx) {
                    return Poll::Ready(Woke::Socket(incoming));
                }
                if wait.paused && ledger.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(Woke::Ledger);
                }
                if let Some(Poll::Ready(())) = due.as_mut().as_pin_mut().map(|due| due.poll(cx)) {
                    return Poll::Ready(Woke::Ping);
                }
                Poll::Pending
            })
            .await
        };
        match woke {
            Woke::Socket(Some(Incoming::Message(Message::Text(text)))) => {
                served.report(EVENT_WS_MESSAGE, OPCODE_TEXT, 0, text.into_bytes());
            }
            Woke::Socket(Some(Incoming::Message(Message::Binary(data)))) => {
                served.report(EVENT_WS_MESSAGE, OPCODE_BINARY, 0, data);
            }
            Woke::Socket(Some(Incoming::Pong(data))) => served.report(EVENT_WS_PONG, 0, 0, data),
            Woke::Socket(Some(Incoming::Drained)) => {
                served.report(EVENT_WS_DRAINED, 0, 0, Vec::new());
            }
            Woke::Socket(None) => break,
            Woke::Ledger => {}
            Woke::Ping => {
                let mut encoded = Vec::with_capacity(2);
                if frame::write_ping(&[], &mut encoded).is_ok() {
                    let _ = outbox.push(Command::Frame(encoded.into()));
                }
                next_ping = ping.and_then(|every| Instant::now().checked_add(every));
            }
        }
    }
    let reason = socket
        .close_reason()
        .unwrap_or_default()
        .as_bytes()
        .to_vec();
    (socket.close_code().map_or(ABNORMAL, |code| code.0), reason)
}

/// The open WebSocket `conn` names.
pub(super) fn websocket(conn: u64) -> Result<Live, HostError> {
    let live = conns::find(conn)?;
    if live.kind != Kind::WebSocket {
        return Err(HostError::invalid(format!(
            "the connection {conn} is an event stream, not a WebSocket"
        )));
    }
    Ok(live)
}

/// Queue a command for a connection, mapping the outbox's refusal.
pub(super) fn push(live: &Live, conn: u64, command: Command) -> Result<(), HostError> {
    live.outbox.push(command).map_err(|err| match err {
        Error::Closed => HostError::closed(format!("the connection {conn} takes nothing more")),
        Error::Limit(message) => HostError::limit(message),
        other => HostError::invalid(other.to_string()),
    })
}

pub(super) fn send(conn: u64, opcode: u8, data: &[u8]) -> Result<(), HostError> {
    let opcode = match opcode {
        OPCODE_TEXT => Opcode::Text,
        OPCODE_BINARY => Opcode::Binary,
        other => {
            return Err(HostError::invalid(format!(
                "a message is sent as text (1) or binary (2), not opcode {other}"
            )))
        }
    };
    let live = websocket(conn)?;
    let mut encoded = Vec::with_capacity(data.len().saturating_add(10));
    frame::write_message(opcode, data, &mut encoded)
        .map_err(|err| HostError::invalid(err.to_string()))?;
    push(&live, conn, Command::Frame(encoded.into()))
}

pub(super) fn ping(conn: u64, data: &[u8]) -> Result<(), HostError> {
    if data.len() > MAX_CONTROL_PAYLOAD {
        return Err(HostError::invalid(format!(
            "a ping carries at most {MAX_CONTROL_PAYLOAD} octets, not {}",
            data.len()
        )));
    }
    let live = websocket(conn)?;
    let mut encoded = Vec::with_capacity(data.len().saturating_add(2));
    frame::write_ping(data, &mut encoded).map_err(|err| HostError::invalid(err.to_string()))?;
    push(&live, conn, Command::Frame(encoded.into()))
}

pub(super) fn close(conn: u64, code: u16, reason: &[u8]) -> Result<(), HostError> {
    let code = CloseCode(code);
    if !code.is_sendable() {
        return Err(HostError::invalid(format!(
            "a server does not close with code {}",
            code.0
        )));
    }
    let reason =
        std::str::from_utf8(reason).map_err(|_| HostError::invalid("a close reason is UTF-8"))?;
    if reason.len() > MAX_REASON {
        return Err(HostError::invalid(format!(
            "a close reason carries at most {MAX_REASON} octets, not {}",
            reason.len()
        )));
    }
    let live = websocket(conn)?;
    push(
        &live,
        conn,
        Command::Close {
            code,
            reason: reason.to_owned(),
        },
    )
}

pub(super) fn terminate(conn: u64) -> Result<(), HostError> {
    let live = websocket(conn)?;
    push(&live, conn, Command::Terminate)
}

pub(super) fn writable(conn: u64) -> Result<bool, HostError> {
    Ok(websocket(conn)?.outbox.is_writable())
}

pub(super) fn buffered(conn: u64) -> Result<u64, HostError> {
    Ok(websocket(conn)?.outbox.buffered())
}
