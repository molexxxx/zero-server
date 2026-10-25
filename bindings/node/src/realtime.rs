//! WebSocket connections, event streams and rooms, reached by connection id from any
//! isolate. Each send encodes and checks its frame or event on the calling thread,
//! so a refusal returns before anything is queued, and queues it in the
//! connection's outbox, which the connection writes in call order.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.6>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1>
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>

use napi::bindgen_prelude::{BufferSlice, Either};
use napi_derive::napi;
use zero_host::{realtime, Status};

use crate::guard::{node_guard, Code, Fail};
use crate::{ids, server};

/// The octets of a message: a `Buffer` as it is, a string as UTF-8.
fn message<'a>(data: &'a Either<BufferSlice<'_>, String>) -> &'a [u8] {
    match data {
        Either::A(buffer) => buffer,
        Either::B(text) => text.as_bytes(),
    }
}

/// Send a message on a WebSocket connection.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `opcode` - 1 text or 2 binary.
/// * `data` - the message; a text message is UTF-8.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for another opcode, text that is not UTF-8 or the id of
/// an event stream, `ZERO_CLOSED` once the connection ended or a close was sent, and
/// `ZERO_LIMIT` when its outbox, or the outboxes of its core together, would pass
/// their limit.
#[napi(
    catch_unwind,
    ts_args_type = "conn: number, opcode: number, data: Buffer | string"
)]
pub fn ws_send(
    conn: f64,
    opcode: f64,
    data: Either<BufferSlice<'_>, String>,
) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        let opcode = ids::u8_of(opcode, "the opcode")?;
        realtime::ws_send(conn, opcode, message(&data))?;
        Ok(Status::Ok.code())
    })
}

/// Send a ping on a WebSocket connection; the pong arrives as an event.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `data` - the application data, at most 125 octets, or `null`.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for more than 125 octets, and otherwise as `wsSend`.
#[napi(catch_unwind, ts_args_type = "conn: number, data: Buffer | null")]
pub fn ws_ping(conn: f64, data: Option<BufferSlice<'_>>) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        let payload: &[u8] = data.as_deref().unwrap_or(&[]);
        realtime::ws_ping(conn, payload)?;
        Ok(Status::Ok.code())
    })
}

/// Start the closing handshake of a WebSocket connection, after what was sent
/// before.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `code` - 1000 to 1003, 1007 to 1009, 1011 to 1014, or 3000 to 4999.
/// * `reason` - UTF-8, at most 123 octets.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for any other code or a longer reason, and otherwise as
/// `wsSend`.
#[napi(catch_unwind)]
pub fn ws_close(conn: f64, code: f64, reason: String) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        let code = ids::u16_of(code, "the close code")?;
        realtime::ws_close(conn, code, reason.as_bytes())?;
        Ok(Status::Ok.code())
    })
}

/// End a WebSocket connection without a Close frame, once what was sent before is
/// written.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// As `wsSend`.
#[napi(catch_unwind)]
pub fn ws_terminate(conn: f64) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        realtime::ws_terminate(conn)?;
        Ok(Status::Ok.code())
    })
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
/// `ZERO_INVALID_ARGUMENT` for the id of an event stream, and `ZERO_CLOSED` once the
/// connection ended.
#[napi(catch_unwind)]
pub fn ws_buffered(conn: f64) -> napi::Result<f64, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        Ok(ids::number(realtime::ws_buffered(conn)?))
    })
}

/// Send an event on an event stream.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `event` - the event type, or `null`.
/// * `id` - the event id, or `null`; an empty one resets the id the client reports.
/// * `data` - the data, one `data` field per line.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for an `event` or `id` holding CR or LF, an `id` holding
/// U+0000, or the id of a WebSocket; `ZERO_CLOSED` once the stream ended; `ZERO_LIMIT`
/// as for `wsSend`.
#[napi(
    catch_unwind,
    ts_args_type = "conn: number, event: string | null, id: string | null, data: string"
)]
pub fn sse_send(
    conn: f64,
    event: Option<String>,
    id: Option<String>,
    data: String,
) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        realtime::sse_send(
            conn,
            event.as_deref().map(str::as_bytes),
            id.as_deref().map(str::as_bytes),
            data.as_bytes(),
        )?;
        Ok(Status::Ok.code())
    })
}

/// Send a comment on an event stream, one comment line per line of the text.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `text` - the comment.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// As `sseSend`.
#[napi(catch_unwind)]
pub fn sse_comment(conn: f64, text: String) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        realtime::sse_comment(conn, text.as_bytes())?;
        Ok(Status::Ok.code())
    })
}

/// Tell the client of an event stream how long to wait before it reconnects.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `milliseconds` - the reconnection time.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// As `sseSend`.
#[napi(catch_unwind)]
pub fn sse_retry(conn: f64, milliseconds: f64) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        let milliseconds = ids::u32_of(milliseconds, "the reconnection time")?;
        realtime::sse_retry(conn, milliseconds)?;
        Ok(Status::Ok.code())
    })
}

/// End an event stream once what was sent before is written.
///
/// # Arguments
///
/// * `conn` - the connection id.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// As `sseSend`.
#[napi(catch_unwind)]
pub fn sse_close(conn: f64) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        realtime::sse_close(conn)?;
        Ok(Status::Ok.code())
    })
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
/// `ZERO_INVALID_ARGUMENT` for the id of a WebSocket, and `ZERO_CLOSED` once the
/// stream ended.
#[napi(catch_unwind)]
pub fn sse_buffered(conn: f64) -> napi::Result<f64, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        Ok(ids::number(realtime::sse_buffered(conn)?))
    })
}

/// Put a WebSocket connection in a room of its server, in order with what is sent
/// on it.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `room` - the room's name.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// As `wsSend`.
#[napi(catch_unwind)]
pub fn room_join(conn: f64, room: String) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        realtime::room_join(conn, room.as_bytes())?;
        Ok(Status::Ok.code())
    })
}

/// Take a WebSocket connection out of a room, in order with what is sent on it.
///
/// # Arguments
///
/// * `conn` - the connection id.
/// * `room` - the room's name.
///
/// # Returns
///
/// 0.
///
/// # Errors
///
/// As `wsSend`.
#[napi(catch_unwind)]
pub fn room_leave(conn: f64, room: String) -> napi::Result<i32, Code> {
    node_guard(|| {
        let conn = ids::id(conn, "the connection id")?;
        realtime::room_leave(conn, room.as_bytes())?;
        Ok(Status::Ok.code())
    })
}

/// Send a message to every WebSocket connection in a room of a server, on every
/// core, but the one left out. The frame is encoded once; a member that falls 16 MiB
/// behind is closed with 1013 Try Again Later rather than holding more.
///
/// # Arguments
///
/// * `server` - the server id.
/// * `room` - the room's name.
/// * `opcode` - 1 text or 2 binary.
/// * `data` - the message.
/// * `except` - the id of a connection to leave out, or `null`.
///
/// # Returns
///
/// How many members the message was queued for.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for another opcode or text that is not UTF-8,
/// `ZERO_UNSUPPORTED` when realtime is left out of the build, and `ZERO_CLOSED` for an
/// unknown or stopped server.
#[napi(
    catch_unwind,
    ts_args_type = "server: number, room: string, opcode: number, data: Buffer | string, except: number | null"
)]
pub fn room_broadcast(
    server: f64,
    room: String,
    opcode: f64,
    data: Either<BufferSlice<'_>, String>,
    except: Option<f64>,
) -> napi::Result<f64, Code> {
    node_guard(|| {
        let (_, server) = server::running_arg(server)?;
        let opcode = ids::u8_of(opcode, "the opcode")?;
        let except = except
            .map(|conn| ids::id(conn, "the connection left out"))
            .transpose()?;
        let delivered = server.room_broadcast(room.as_bytes(), opcode, message(&data), except)?;
        Ok(ids::number(delivered))
    })
}

/// How many WebSocket connections are in a room of a server.
///
/// # Arguments
///
/// * `server` - the server id.
/// * `room` - the room's name.
///
/// # Returns
///
/// The count, over every core.
///
/// # Errors
///
/// `ZERO_UNSUPPORTED` when realtime is left out of the build, and `ZERO_CLOSED` for an
/// unknown or stopped server.
#[napi(catch_unwind)]
pub fn room_size(server: f64, room: String) -> napi::Result<f64, Code> {
    node_guard(|| {
        let (_, server) = server::running_arg(server)?;
        let size = server.room_size(room.as_bytes()).map_err(Fail::from)?;
        Ok(ids::number(size))
    })
}
