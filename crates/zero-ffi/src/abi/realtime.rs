//! WebSocket connections, server-sent event streams and rooms, by connection id.
//!
//! A connection opens with `zero_res_ws_accept` or `zero_res_sse_open`. Every call here is
//! non-blocking and may come from any thread: a frame or an event is encoded and checked
//! on the calling thread, so a refusal returns before anything is queued, and is queued
//! in the connection's outbox, which the connection writes in the order of the calls. A
//! send is refused with `ZeroStatus_Limit` when the connection's outbox, or the outboxes
//! of its core together, would pass their limit. What happens on a connection arrives in
//! event batches (`ZERO_EVENT_*`). Without the `realtime` capability every call here
//! returns `ZeroStatus_Unsupported`.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5>
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html>

use std::mem::size_of;

use zero_host::realtime;

use crate::abi::names::ZERO_NONE;
use crate::abi::ZeroStatus;
use crate::guard::{guard, Fail};
use crate::ptr as host;

/// Sends a message on a WebSocket connection.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `opcode` - `ZERO_OPCODE_TEXT` or `ZERO_OPCODE_BINARY`.
/// * `data` - the message; UTF-8 for text (RFC 6455 Section 5.6).
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for another opcode, text that is not UTF-8, an id above
/// `ZERO_ID_MAX`, the id of an event stream, or an input range the rules refuse;
/// `Closed` once the connection ended or a close was sent; `Limit` when an outbox limit
/// would be passed; nothing is queued then.
///
/// # Safety
///
/// `data` must be a readable range of `len` octets.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.6>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_ws_send(
    conn: u64,
    opcode: u8,
    data: *const u8,
    len: usize,
) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `data` is `len` readable octets for the call.
        let data = unsafe { host::read_bytes(data, len) }?;
        realtime::ws_send(conn, opcode, data).map_err(Fail::from)
    })
}

/// Sends a ping on a WebSocket connection; the pong arrives as `ZERO_EVENT_WS_PONG`.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `data` - the application data, at most 125 octets: "All control frames MUST have a
///   payload length of 125 bytes or less" (RFC 6455 Section 5.5).
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for more than 125 octets; otherwise as `zero_ws_send`.
///
/// # Safety
///
/// `data` must be a readable range of `len` octets.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_ws_ping(conn: u64, data: *const u8, len: usize) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `data` is `len` readable octets for the call.
        let data = unsafe { host::read_bytes(data, len) }?;
        realtime::ws_ping(conn, data).map_err(Fail::from)
    })
}

/// Starts the closing handshake of a WebSocket connection, after what was sent before.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `code` - a status code a server may send: 1000 to 1003, 1007 to 1009, 1011 to 1014,
///   or 3000 to 4999. 1005, 1006 and 1015 "MUST NOT be set as a status code in a Close
///   control frame by an endpoint", 1004 is reserved, 1010 is a client's, the rest of
///   1000 to 2999 is unassigned in the IANA registry that Section 11.7 creates, and codes
///   below 1000 are not used (RFC 6455 Sections 7.4.1, 7.4.2 and 11.7).
/// * `reason` - the reason, UTF-8 and at most 123 octets, so the code and the reason fit
///   a control frame (Sections 5.5 and 5.5.1).
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for any other code, or a reason that is not UTF-8 or is longer than
/// 123 octets; otherwise as `zero_ws_send`.
///
/// # Safety
///
/// `reason` must be a readable range of `len` octets.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-11.7>
/// @see <https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number>
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.1>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_ws_close(
    conn: u64,
    code: u16,
    reason: *const u8,
    len: usize,
) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `reason` is `len` readable octets for the call.
        let reason = unsafe { host::read_bytes(reason, len) }?;
        realtime::ws_close(conn, code, reason).map_err(Fail::from)
    })
}

/// Ends a WebSocket connection without a Close frame, once what was sent before is
/// written.
///
/// # Arguments
///
/// * `conn` - the connection's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_ws_send`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_ws_terminate(conn: u64) -> ZeroStatus {
    guard(|| realtime::ws_terminate(conn).map_err(Fail::from))
}

/// Writes whether a WebSocket connection takes more without passing its high-water
/// mark; a send may still be queued when it does not, up to the outbox limits.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `writable_out` - receives 1 when it takes more, 0 otherwise.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an id above `ZERO_ID_MAX`, the id of an event stream, or a NULL
/// `writable_out`; `Closed` once the connection ended.
///
/// # Safety
///
/// `writable_out` must be NULL or point to a writable `uint8_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_ws_writable(conn: u64, writable_out: *mut u8) -> ZeroStatus {
    guard(|| {
        host::check_out(writable_out)?;
        let writable = u8::from(realtime::ws_writable(conn)?);
        // SAFETY: outputs: `writable_out` was checked and points to a writable `uint8_t`.
        unsafe { host::write_elements(writable_out, size_of::<u8>(), &[writable]) }
    })
}

/// Writes the octets sent on a WebSocket connection and not yet written to its socket.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `bytes_out` - receives the octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_ws_writable`.
///
/// # Safety
///
/// `bytes_out` must be NULL or point to a writable `uint64_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_ws_buffered(conn: u64, bytes_out: *mut u64) -> ZeroStatus {
    guard(|| {
        host::check_out(bytes_out)?;
        let bytes = realtime::ws_buffered(conn)?;
        // SAFETY: outputs: `bytes_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(bytes_out, size_of::<u64>(), &[bytes]) }
    })
}

/// Sends an event on an event stream.
///
/// `event` and `id` hold no CR or LF, since the stream grammar's `name-char` and
/// `any-char` exclude them, and `id` holds no NUL, which a client ignores an `id` for
/// (WHATWG HTML Sections 9.2.5 and 9.2.6); `data` is split at CRLF, LF and CR, each line
/// its own `data` field.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `event` - the event type; NULL with a zero length for none, and a non-NULL pointer
///   with a zero length for an empty type, which the client reads as `message`.
/// * `event_len` - its length in octets.
/// * `id` - the event id; NULL with a zero length for none, and a non-NULL pointer with a
///   zero length for an empty id, which resets the id the client reports.
/// * `id_len` - its length in octets.
/// * `data` - the data, UTF-8.
/// * `data_len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a value that is not UTF-8, an `event` or `id` holding CR or LF,
/// an `id` holding NUL, an id above `ZERO_ID_MAX`, the id of a WebSocket, or an input
/// range the rules refuse; `Closed` once the stream ended or was closed; `Limit` as for
/// `zero_ws_send`; nothing is queued then.
///
/// # Safety
///
/// `event`, `id` and `data` must be NULL or readable ranges of their lengths.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation>
#[allow(unsafe_code, clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn zero_sse_send(
    conn: u64,
    event: *const u8,
    event_len: usize,
    id: *const u8,
    id_len: usize,
    data: *const u8,
    data_len: usize,
) -> ZeroStatus {
    guard(|| {
        let event = if event.is_null() && event_len == 0 {
            None
        } else {
            // SAFETY: input ranges: `event` is `event_len` readable octets for the call.
            Some(unsafe { host::read_bytes(event, event_len) }?)
        };
        let id = if id.is_null() && id_len == 0 {
            None
        } else {
            // SAFETY: input ranges: `id` is `id_len` readable octets for the call.
            Some(unsafe { host::read_bytes(id, id_len) }?)
        };
        // SAFETY: input ranges: `data` is `data_len` readable octets for the call.
        let data = unsafe { host::read_bytes(data, data_len) }?;
        realtime::sse_send(conn, event, id, data).map_err(Fail::from)
    })
}

/// Sends a comment on an event stream, which the client ignores: one comment line per
/// line of `text`, split at CRLF, LF and CR.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `text` - the comment, UTF-8.
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_sse_send`.
///
/// # Safety
///
/// `text` must be a readable range of `len` octets.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_sse_comment(conn: u64, text: *const u8, len: usize) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `text` is `len` readable octets for the call.
        let text = unsafe { host::read_bytes(text, len) }?;
        realtime::sse_comment(conn, text).map_err(Fail::from)
    })
}

/// Tells the client of an event stream how long to wait before it reconnects, written
/// as ASCII digits.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `milliseconds` - the reconnection time.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_sse_send`.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation>
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_sse_retry(conn: u64, milliseconds: u32) -> ZeroStatus {
    guard(|| realtime::sse_retry(conn, milliseconds).map_err(Fail::from))
}

/// Ends an event stream once what was sent before is written.
///
/// # Arguments
///
/// * `conn` - the connection's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_sse_send`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_sse_close(conn: u64) -> ZeroStatus {
    guard(|| realtime::sse_close(conn).map_err(Fail::from))
}

/// Writes whether an event stream takes more without passing its high-water mark.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `writable_out` - receives 1 when it takes more, 0 otherwise.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an id above `ZERO_ID_MAX`, the id of a WebSocket, or a NULL
/// `writable_out`; `Closed` once the stream ended.
///
/// # Safety
///
/// `writable_out` must be NULL or point to a writable `uint8_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_sse_writable(conn: u64, writable_out: *mut u8) -> ZeroStatus {
    guard(|| {
        host::check_out(writable_out)?;
        let writable = u8::from(realtime::sse_writable(conn)?);
        // SAFETY: outputs: `writable_out` was checked and points to a writable `uint8_t`.
        unsafe { host::write_elements(writable_out, size_of::<u8>(), &[writable]) }
    })
}

/// Writes the octets sent on an event stream and not yet written to its socket.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `bytes_out` - receives the octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_sse_writable`.
///
/// # Safety
///
/// `bytes_out` must be NULL or point to a writable `uint64_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_sse_buffered(conn: u64, bytes_out: *mut u64) -> ZeroStatus {
    guard(|| {
        host::check_out(bytes_out)?;
        let bytes = realtime::sse_buffered(conn)?;
        // SAFETY: outputs: `bytes_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(bytes_out, size_of::<u64>(), &[bytes]) }
    })
}

/// Puts a WebSocket connection in a room of its server, in order with what is sent on
/// it.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `room` - the room's name, UTF-8.
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a name that is not UTF-8; otherwise as `zero_ws_send`.
///
/// # Safety
///
/// `room` must be a readable range of `len` octets.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_room_join(conn: u64, room: *const u8, len: usize) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `room` is `len` readable octets for the call.
        let room = unsafe { host::read_bytes(room, len) }?;
        realtime::room_join(conn, room).map_err(Fail::from)
    })
}

/// Takes a WebSocket connection out of a room, in order with what is sent on it.
///
/// # Arguments
///
/// * `conn` - the connection's id.
/// * `room` - the room's name, UTF-8.
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_room_join`.
///
/// # Safety
///
/// `room` must be a readable range of `len` octets.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_room_leave(conn: u64, room: *const u8, len: usize) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `room` is `len` readable octets for the call.
        let room = unsafe { host::read_bytes(room, len) }?;
        realtime::room_leave(conn, room).map_err(Fail::from)
    })
}

/// Sends a message to every WebSocket connection in one of a server's rooms, on every
/// core, but the one left out. The frame is encoded once; each member writes it in order
/// with what is sent on it, after the sends made before this call returned and before
/// those made after it, and a member with 16 MiB of broadcasts waiting is closed with
/// 1013 Try Again Later rather than holding more.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `room` - the room's name, UTF-8.
/// * `room_len` - its length in octets.
/// * `opcode` - `ZERO_OPCODE_TEXT` or `ZERO_OPCODE_BINARY`.
/// * `data` - the message; UTF-8 for text.
/// * `len` - its length in octets.
/// * `except_conn` - the connection to leave out, usually the sender, or `ZERO_NONE`.
/// * `delivered_out` - receives how many members the message was queued for.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a name or a text that is not UTF-8, another opcode, an
/// `except_conn` above `ZERO_ID_MAX`, or an argument the rules refuse; `Unsupported` when
/// the `realtime` capability is compiled out; `Closed` for an unknown server.
///
/// # Safety
///
/// `room` and `data` must be readable ranges of their lengths, and `delivered_out` NULL
/// or a writable `uint64_t`.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-5.6>
#[allow(unsafe_code, clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn zero_room_broadcast(
    server: u64,
    room: *const u8,
    room_len: usize,
    opcode: u8,
    data: *const u8,
    len: usize,
    except_conn: u64,
    delivered_out: *mut u64,
) -> ZeroStatus {
    guard(|| {
        host::check_out(delivered_out)?;
        // SAFETY: input ranges: `room` is `room_len` readable octets for the call.
        let room = unsafe { host::read_bytes(room, room_len) }?;
        // SAFETY: input ranges: `data` is `len` readable octets for the call.
        let data = unsafe { host::read_bytes(data, len) }?;
        let except = (except_conn != ZERO_NONE).then_some(except_conn);
        let delivered =
            crate::abi::server::server(server)?.room_broadcast(room, opcode, data, except)?;
        // SAFETY: outputs: `delivered_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(delivered_out, size_of::<u64>(), &[delivered]) }
    })
}

/// Writes how many WebSocket connections are in one of a server's rooms, over every
/// core.
///
/// # Arguments
///
/// * `server` - the server's id.
/// * `room` - the room's name, UTF-8.
/// * `len` - its length in octets.
/// * `count_out` - receives the count.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a name that is not UTF-8 or an argument the rules refuse;
/// `Unsupported` when the `realtime` capability is compiled out; `Closed` for an unknown
/// server.
///
/// # Safety
///
/// `room` must be a readable range of `len` octets, and `count_out` NULL or a writable
/// `uint64_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_room_size(
    server: u64,
    room: *const u8,
    len: usize,
    count_out: *mut u64,
) -> ZeroStatus {
    guard(|| {
        host::check_out(count_out)?;
        // SAFETY: input ranges: `room` is `len` readable octets for the call.
        let room = unsafe { host::read_bytes(room, len) }?;
        let count = crate::abi::server::server(server)?.room_size(room)?;
        // SAFETY: outputs: `count_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(count_out, size_of::<u64>(), &[count]) }
    })
}
