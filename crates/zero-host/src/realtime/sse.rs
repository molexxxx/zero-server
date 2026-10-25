//! Server-sent event streams: the stream a host opens, the connection task, and the
//! calls a host sends with.

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::sync::Arc;
use std::task::Poll;

use zero_core::Error;
use zero_http::{Call, Taken};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_io::seam::Stream;
use zero_realtime::{Command, Drained, EventStream, Outbox};
use zero_sse::Event;

use super::conns::{self, Kind, Live};
use super::imp::{changed, foreign, refuse_foreign, Served, Start};
use super::ws::push;
use super::EVENT_SSE_DRAINED;
use crate::handler::CoreHost;
use crate::HostError;

/// Run a host's event stream: write the stream head with the status and fields the
/// host set, and claim the connection for its task. A response that cannot carry a
/// body, to HEAD or with a 1xx, 204 or 304 status, goes out as the host wrote it and
/// the reserved connection is closed and reported closed. The head carries one
/// `Content-Type`, the stream's own, whatever the host set: a client fails the
/// connection "if res's Content-Type is not text/event-stream" (WHATWG HTML Section
/// 9.2.2), and a field that is not a list goes out as one line (RFC 9110 Section
/// 5.3).
///
/// # Errors
///
/// None at present; the `Result` matches the other actions.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3>
pub(crate) fn open_event_stream(
    core: &CoreHost,
    call: &mut Call<'_>,
    conn: u64,
    keep_alive_ms: u32,
) -> Result<(), Error> {
    let Ok(id) = conns::parse(conn) else {
        return Ok(());
    };
    if foreign(core, id) {
        refuse_foreign(core, call);
        return Ok(());
    }
    let local = core.realtime();
    let head = call.request().method() == Some(Method::Head);
    let status = call.response().current_status().unwrap_or(StatusCode::OK);
    if !zero_http1::body_allowed(head, status) {
        local.abandon(core, id);
        return Ok(());
    }
    call.response()
        .remove_header(HeaderName::ContentType.as_bytes());
    if zero_realtime::start_event_stream(call, conn).is_err() {
        local.abandon(core, id);
        return Ok(());
    }
    let keep_alive_ms = match keep_alive_ms {
        0 => u64::MAX,
        every => u64::from(every),
    };
    local.claim(core, id, Start::EventStream { keep_alive_ms });
    Ok(())
}

/// Serve an event stream until it ends: write what the host sends, keep it alive
/// with comments, and report each drained outbox.
pub(crate) async fn run<S: Stream + 'static>(
    core: &CoreHost,
    served: &mut Served<'_>,
    taken: Taken<S>,
    outbox: Arc<Outbox>,
    keep_alive_ms: u64,
) {
    let mut stream = EventStream::new(taken, keep_alive_ms).with_outbox(outbox);
    loop {
        let wait = served.settle();
        let woke = {
            let mut next = pin!(stream.serve());
            let mut ledger = pin!(changed(core, wait));
            poll_fn(|cx| {
                if let Poll::Ready(drained) = next.as_mut().poll(cx) {
                    return Poll::Ready(Some(drained));
                }
                if wait.room && ledger.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(None);
                }
                Poll::Pending
            })
            .await
        };
        match woke {
            Some(Some(Drained)) => served.report(EVENT_SSE_DRAINED, 0, 0, Vec::new()),
            Some(None) => break,
            None => {}
        }
    }
}

/// The open event stream `conn` names.
fn event_stream(conn: u64) -> Result<Live, HostError> {
    let live = conns::find(conn)?;
    if live.kind != Kind::EventStream {
        return Err(HostError::invalid(format!(
            "the connection {conn} is a WebSocket, not an event stream"
        )));
    }
    Ok(live)
}

/// A value of an event stream field as text: the stream is UTF-8.
fn text<'a>(field: &str, value: &'a [u8]) -> Result<&'a str, HostError> {
    std::str::from_utf8(value)
        .map_err(|_| HostError::invalid(format!("an event stream `{field}` is UTF-8")))
}

/// Encode with the stream encoder, whose refusals are the caller's argument.
fn encoded(encode: impl FnOnce(&mut Vec<u8>) -> Result<(), Error>) -> Result<Command, HostError> {
    let mut out = Vec::new();
    encode(&mut out).map_err(|err| HostError::invalid(err.to_string()))?;
    Ok(Command::Frame(out.into()))
}

pub(super) fn send(
    conn: u64,
    event: Option<&[u8]>,
    id: Option<&[u8]>,
    data: &[u8],
) -> Result<(), HostError> {
    let event = event.map(|value| text("event", value)).transpose()?;
    let id = id.map(|value| text("id", value)).transpose()?;
    let data = text("data", data)?;
    let command = encoded(|out| {
        zero_sse::encode(
            &Event {
                event,
                id,
                retry: None,
                data: Some(data),
            },
            out,
        )
    })?;
    let live = event_stream(conn)?;
    push(&live, conn, command)
}

pub(super) fn comment(conn: u64, comment: &[u8]) -> Result<(), HostError> {
    let comment = text("comment", comment)?;
    let command = encoded(|out| zero_sse::comment(comment, out))?;
    let live = event_stream(conn)?;
    push(&live, conn, command)
}

pub(super) fn retry(conn: u64, milliseconds: u32) -> Result<(), HostError> {
    let command = encoded(|out| {
        zero_sse::encode(
            &Event {
                retry: Some(u64::from(milliseconds)),
                ..Event::default()
            },
            out,
        )
    })?;
    let live = event_stream(conn)?;
    push(&live, conn, command)
}

pub(super) fn close(conn: u64) -> Result<(), HostError> {
    let live = event_stream(conn)?;
    push(&live, conn, Command::End)
}

pub(super) fn writable(conn: u64) -> Result<bool, HostError> {
    Ok(event_stream(conn)?.outbox.is_writable())
}

pub(super) fn buffered(conn: u64) -> Result<u64, HostError> {
    Ok(event_stream(conn)?.outbox.buffered())
}
