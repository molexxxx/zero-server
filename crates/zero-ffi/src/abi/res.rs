//! Responses: writes of a leased slot's response by slot id, each under the slot's lock
//! while the slot is leased and the response is not sealed.
//!
//! Every write is checked before anything is written, so a refused call leaves the
//! response as it was: field names are tokens other than the four the driver writes,
//! field values hold no CR, LF, NUL or other control character, a status is 200 to 599,
//! and a body fits the server's response limit. A response is sealed by
//! `zero_res_respond`, `zero_res_send`, `zero_res_error` or an action; the worker sends
//! it once the slot is completed, and answers 500 `NO_RESPONSE` for a slot completed
//! with nothing written.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>

use std::mem::size_of;

use zero_host::access::{self, FieldMode};

use crate::abi::names::{ZERO_HEADER_APPEND, ZERO_HEADER_SET};
use crate::abi::{ZeroHeaderPair, ZeroResponseSpec, ZeroStatus};
use crate::guard::{guard, Fail};
use crate::ptr::{self as host, PTRDIFF_MAX};

/// The field lines a response call collects without allocating.
const INLINE_FIELDS: usize = 32;

const MODE: Fail = Fail::invalid("the mode is not ZERO_HEADER_SET or ZERO_HEADER_APPEND");
const SMALL_PAIR: Fail = Fail::invalid("field_size is below the version 1 size of ZeroHeaderPair");
const LONG_FIELDS: Fail = Fail::invalid("the field array is longer than PTRDIFF_MAX octets");

/// The field mode a `ZERO_HEADER_*` mode names.
fn field_mode(mode: u32) -> Result<FieldMode, Fail> {
    match mode {
        ZERO_HEADER_SET => Ok(FieldMode::Set),
        ZERO_HEADER_APPEND => Ok(FieldMode::Append),
        _ => Err(MODE),
    }
}

/// Sets the response status.
///
/// RFC 9110 Section 15: "All valid status codes are within the range of 100 to 599,
/// inclusive." A host sets 200 to 599: 100 belongs to the driver, which sends it for
/// `Expect: 100-continue`, 101 only to an accepted upgrade (`zero_res_ws_accept`), and "a
/// server MUST NOT send a 1xx response to an HTTP/1.0 client" (Section 15.2), which the
/// status call cannot tell apart.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `status` - the status, 200 to 599.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a status outside 200 to 599 or an id above `ZERO_ID_MAX`;
/// `Closed` for a stale id, a slot that is not leased, or a sealed response; `Panic` for
/// a slot a panic poisoned.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2>
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_res_status(slot: u64, status: u16) -> ZeroStatus {
    guard(|| access::status(slot, status).map_err(Into::into))
}

/// Writes a field line.
///
/// The name is a token (RFC 9110 Section 5.1) other than `Content-Length`, `Connection`,
/// `Transfer-Encoding` and `Date`, which the driver writes itself. The value is a field
/// value without surrounding whitespace: "Field values containing CR, LF, or NUL
/// characters are invalid and dangerous" (Section 5.5), so a value holding any of them,
/// or another control character, is refused rather than sent, and nothing is written.
/// `ZERO_HEADER_SET` replaces every line of the name, compared without regard to case;
/// `ZERO_HEADER_APPEND` adds one more line, so each `Set-Cookie` leaves as a field line of
/// its own, as it "does not use the list syntax" (Section 5.3).
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `name` - the field name.
/// * `name_len` - its length in octets.
/// * `value` - the field value.
/// * `value_len` - its length in octets.
/// * `mode` - `ZERO_HEADER_SET` or `ZERO_HEADER_APPEND`.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a name or a value the rules refuse, an undeclared mode, or an
/// input range the rules refuse; otherwise as `zero_res_status`.
///
/// # Safety
///
/// `name` and `value` must be readable ranges of their lengths.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_header(
    slot: u64,
    name: *const u8,
    name_len: usize,
    value: *const u8,
    value_len: usize,
    mode: u32,
) -> ZeroStatus {
    guard(|| {
        let mode = field_mode(mode)?;
        // SAFETY: input ranges: `name` is `name_len` readable octets for the call.
        let name = unsafe { host::read_bytes(name, name_len) }?;
        // SAFETY: input ranges: `value` is `value_len` readable octets for the call.
        let value = unsafe { host::read_bytes(value, value_len) }?;
        access::header(slot, name, value, mode).map_err(Into::into)
    })
}

/// Writes a field line under an interned name, with the rules of `zero_res_header`.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `name_id` - a `ZERO_HEADER_*` value.
/// * `value` - the field value.
/// * `value_len` - its length in octets.
/// * `mode` - `ZERO_HEADER_SET` or `ZERO_HEADER_APPEND`.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an id at or above `ZERO_HEADER_COUNT`; otherwise as
/// `zero_res_header`.
///
/// # Safety
///
/// `value` must be a readable range of `value_len` octets.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_header_id(
    slot: u64,
    name_id: u32,
    value: *const u8,
    value_len: usize,
    mode: u32,
) -> ZeroStatus {
    guard(|| {
        let mode = field_mode(mode)?;
        // SAFETY: input ranges: `value` is `value_len` readable octets for the call.
        let value = unsafe { host::read_bytes(value, value_len) }?;
        access::header_id(slot, name_id, value, mode).map_err(Into::into)
    })
}

/// Replaces the response body with a copy, up to the server's `maxResponseBody`.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `body` - the body.
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Limit` for a body longer than the server's response limit; `InvalidArgument` while a
/// body region is open or for an input range the rules refuse; otherwise as
/// `zero_res_status`.
///
/// # Safety
///
/// `body` must be a readable range of `len` octets.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_body_copy(slot: u64, body: *const u8, len: usize) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `body` is `len` readable octets for the call.
        let body = unsafe { host::read_bytes(body, len) }?;
        access::body(slot, body).map_err(Into::into)
    })
}

/// Replaces the response body with a copy of a JSON text and sets `Content-Type` to
/// `application/json`, the media type of JSON text (RFC 8259 Section 11). The text is not
/// parsed.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `json` - the JSON text.
/// * `len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_res_body_copy`.
///
/// # Safety
///
/// `json` must be a readable range of `len` octets.
///
/// @see <https://www.rfc-editor.org/rfc/rfc8259.html#section-11>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_json(slot: u64, json: *const u8, len: usize) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `json` is `len` readable octets for the call.
        let json = unsafe { host::read_bytes(json, len) }?;
        access::json(slot, json).map_err(Into::into)
    })
}

/// Answers with an error in the server's error shape and seals: the response written so
/// far is replaced by the status, the shape's `Content-Type` and an error body written by
/// the library. An error path never fails a second time: a status outside 400 to 599 is
/// answered 500, a message that is not UTF-8 is written with its invalid sequences
/// replaced, details that are not one JSON value are dropped, and the message, then the
/// details, are kept only while the body fits the server's response limit.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `status` - the status, 400 to 599.
/// * `code` - the error code, 1 to 64 octets of `A` to `Z`, `0` to `9` and `_`.
/// * `code_len` - its length in octets.
/// * `message` - the message; a zero length uses the status's reason phrase.
/// * `message_len` - its length in octets.
/// * `details_json` - one JSON value with the details; a zero length has none.
/// * `details_len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a code outside its alphabet or length, while a body region is
/// open, or for an input range the rules refuse; otherwise as `zero_res_status`.
///
/// # Safety
///
/// `code`, `message` and `details_json` must be readable ranges of their lengths.
#[allow(unsafe_code, clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_error(
    slot: u64,
    status: u16,
    code: *const u8,
    code_len: usize,
    message: *const u8,
    message_len: usize,
    details_json: *const u8,
    details_len: usize,
) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `code` is `code_len` readable octets for the call.
        let code = unsafe { host::read_bytes(code, code_len) }?;
        // SAFETY: input ranges: `message` is `message_len` readable octets for the call.
        let message = unsafe { host::read_bytes(message, message_len) }?;
        // SAFETY: input ranges: `details_json` is `details_len` readable octets for the call.
        let details = unsafe { host::read_bytes(details_json, details_len) }?;
        let message = (!message.is_empty()).then_some(message);
        let details = (!details.is_empty()).then_some(details);
        access::error(slot, status, code, message, details).map_err(Into::into)
    })
}

/// Opens a body region: the body becomes `len` zero octets that the calling thread fills
/// in place, so a host that writes less than it asked for never sends another
/// response's bytes. The region needs the calling thread's pin, and is valid while the
/// pin is held and until the response is sealed; while it is open, every other body call
/// and `zero_res_reset` are refused, so the region cannot move. `zero_res_send` seals the
/// response with the region as its body.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `len` - the body length in octets, up to the server's `maxResponseBody`.
/// * `region_out` - receives the start of the region.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` without the calling thread's pin, while a region is already open,
/// or for a NULL or misaligned `region_out`; `Limit` for a length above the server's
/// response limit or one that cannot be allocated; otherwise as `zero_res_status`.
///
/// # Safety
///
/// `region_out` must be NULL or point to a writable `uint8_t *`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_body_alloc(
    slot: u64,
    len: usize,
    region_out: *mut *mut u8,
) -> ZeroStatus {
    guard(|| {
        host::check_out(region_out)?;
        let region = access::body_alloc(slot, len)?;
        // SAFETY: outputs: `region_out` was checked and points to a writable pointer.
        unsafe { host::write_elements(region_out, size_of::<*mut u8>(), &[region]) }
    })
}

/// Writes the status, the field lines and the body in one call and seals. Every field
/// line is checked with the rules of `zero_res_header` before any is written, so a
/// refused call leaves the response as it was; the lines are appended after those
/// written before, each a line of its own.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `spec` - the response; its `size` is the size the host built it with.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a NULL `spec`, a `size` below the version 1 size, a
/// `field_size` below the version 1 size of `ZeroHeaderPair`, a field line the rules
/// refuse, or while a body region is open; otherwise as `zero_res_status` and
/// `zero_res_body_copy`.
///
/// # Safety
///
/// `spec` must be NULL or point to a readable struct of at least its `size` octets,
/// whose `fields` holds `field_count` readable pairs of `field_size` octets, and every
/// range it names must be readable.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_respond(slot: u64, spec: *const ZeroResponseSpec) -> ZeroStatus {
    guard(|| {
        // SAFETY: sized structs: `spec` is NULL or a readable struct of its own size.
        let spec = unsafe { host::read_sized(spec) }?;
        let count = spec.field_count;
        let stride = usize::try_from(spec.field_size).unwrap_or(usize::MAX);
        if count > 0 && stride < ZeroHeaderPair::V1_SIZE {
            return Err(SMALL_PAIR);
        }
        if count
            .checked_mul(stride)
            .is_none_or(|bytes| bytes > PTRDIFF_MAX)
        {
            return Err(LONG_FIELDS);
        }
        let mut inline: [(&[u8], &[u8]); INLINE_FIELDS] = [(&[], &[]); INLINE_FIELDS];
        let mut spilled: Vec<(&[u8], &[u8])> = Vec::new();
        for position in 0..count {
            // SAFETY: input arrays: `fields` holds `field_count` pairs of `field_size`
            // readable octets.
            let pair = unsafe { host::read_element(spec.fields, position, stride) }?;
            // SAFETY: input ranges: each pair names a readable range for its name.
            let name = unsafe { host::read_bytes(pair.name.ptr, pair.name.len) }?;
            // SAFETY: input ranges: each pair names a readable range for its value.
            let value = unsafe { host::read_bytes(pair.value.ptr, pair.value.len) }?;
            match inline.get_mut(position) {
                Some(entry) if count <= INLINE_FIELDS => *entry = (name, value),
                _ => spilled.push((name, value)),
            }
        }
        // SAFETY: input ranges: the spec's body names a readable range.
        let body = unsafe { host::read_bytes(spec.body.ptr, spec.body.len) }?;
        let fields = if count <= INLINE_FIELDS {
            inline.get(..count).unwrap_or_default()
        } else {
            spilled.as_slice()
        };
        access::respond(slot, spec.status, fields.iter().copied(), body).map_err(Into::into)
    })
}

/// Serves a file as the response once the slot is completed: the field lines the host
/// set stay, before the file's own, and so does its status unless the file answer sets
/// one (206, 304 or a refusal). The path goes through the static file policy segment by
/// segment; a path the root does not serve, or a root that does not exist, is answered
/// 404, and a method other than GET and HEAD 405 with `Allow: GET, HEAD`. Seals.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `root` - the root directory, UTF-8 and not empty.
/// * `root_len` - its length in octets.
/// * `path` - the path of the file under the root, percent-encoded as a request path is.
/// * `path_len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an empty root or one that is not UTF-8, while a body region is
/// open, or for an input range the rules refuse; `Unsupported` when the `static`
/// capability is compiled out; otherwise as `zero_res_status`.
///
/// # Safety
///
/// `root` and `path` must be readable ranges of their lengths.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_file(
    slot: u64,
    root: *const u8,
    root_len: usize,
    path: *const u8,
    path_len: usize,
) -> ZeroStatus {
    guard(|| {
        // SAFETY: input ranges: `root` is `root_len` readable octets for the call.
        let root = unsafe { host::read_bytes(root, root_len) }?;
        // SAFETY: input ranges: `path` is `path_len` readable octets for the call.
        let path = unsafe { host::read_bytes(path, path_len) }?;
        access::file(slot, root, path).map_err(Into::into)
    })
}

/// Answers with a server-sent event stream once the slot is completed; the status and
/// fields the host set go into the stream head. The connection's id is valid at once,
/// and events sent before the head is written wait in its outbox. Seals.
///
/// # Arguments
///
/// * `slot` - the slot's id; not a HEAD request, whose response carries no body.
/// * `keep_alive_ms` - the interval of the keep-alive comment written while nothing
///   else is; 0 writes none.
/// * `conn_out` - receives the connection's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a HEAD request, while a body region is open, or for a NULL or
/// misaligned `conn_out`; `Limit` when the core holds its bound of connections;
/// `Unsupported` when the `realtime` capability is compiled out; otherwise as
/// `zero_res_status`.
///
/// # Safety
///
/// `conn_out` must be NULL or point to a writable `uint64_t`.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_sse_open(
    slot: u64,
    keep_alive_ms: u32,
    conn_out: *mut u64,
) -> ZeroStatus {
    guard(|| {
        host::check_out(conn_out)?;
        let conn = access::sse_open(slot, keep_alive_ms)?;
        // SAFETY: outputs: `conn_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(conn_out, size_of::<u64>(), &[conn]) }
    })
}

/// Accepts a WebSocket route's upgrade request once the slot is completed: `101
/// Switching Protocols` with the accept value and the chosen subprotocol. The
/// connection's id is valid at once, and messages sent before the `101` is written wait
/// in its outbox. A host that declines answers with an error status of its own instead.
/// Seals.
///
/// # Arguments
///
/// * `slot` - the slot's id; a leased upgrade request of a WebSocket route.
/// * `protocol` - the subprotocol: one the client offered and the route allows, since
///   "The value chosen MUST be derived from the client's handshake" (RFC 6455 Section
///   4.2.2); a zero length chooses none and sends no `Sec-WebSocket-Protocol`.
/// * `protocol_len` - its length in octets.
/// * `conn_out` - receives the connection's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a request that is not a WebSocket route's, a protocol the
/// client did not offer or the route does not allow, while a body region is open, or
/// for an output or an input range the rules refuse; `Limit` when the core holds its
/// bound of connections; `Unsupported` when the `realtime` capability is compiled out;
/// otherwise as `zero_res_status`.
///
/// # Safety
///
/// `protocol` must be a readable range of `protocol_len` octets, and `conn_out` NULL or a
/// writable `uint64_t`.
///
/// @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_res_ws_accept(
    slot: u64,
    protocol: *const u8,
    protocol_len: usize,
    conn_out: *mut u64,
) -> ZeroStatus {
    guard(|| {
        host::check_out(conn_out)?;
        // SAFETY: input ranges: `protocol` is `protocol_len` readable octets for the call.
        let protocol = unsafe { host::read_bytes(protocol, protocol_len) }?;
        let conn = access::ws_accept(slot, protocol)?;
        // SAFETY: outputs: `conn_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(conn_out, size_of::<u64>(), &[conn]) }
    })
}

/// Discards the status, the field lines, the body and the action written so far.
///
/// # Arguments
///
/// * `slot` - the slot's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` while a body region is open; otherwise as `zero_res_status`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_res_reset(slot: u64) -> ZeroStatus {
    guard(|| access::reset(slot).map_err(Into::into))
}

/// Seals the response as written; an open body region closes for the host, which may no
/// longer write to it.
///
/// # Arguments
///
/// * `slot` - the slot's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_res_status`, without its range.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_res_send(slot: u64) -> ZeroStatus {
    guard(|| access::send(slot).map_err(Into::into))
}
