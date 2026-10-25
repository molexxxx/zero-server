//! Requests: reads of a leased slot's request by slot id.
//!
//! A call that hands out a view, a pointer into the slot, succeeds only on a thread that
//! holds a pin on the slot or on the slot's target thread before it acknowledged the
//! delivering batch (the view rule); any other thread gets `ZeroStatus_InvalidArgument`.
//! The view stays valid until the later of that thread's unpin and its acknowledgment,
//! and the memory it points to is not written while it is valid, because a pinned slot
//! is never retired and an index is reused only once the acknowledgments pass its
//! retirement (ANSSI FFI-CK-REF-MODEL). A call that returns only values reads from any
//! thread. The library never reads through a view it hands out.
//!
//! @see <https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#ffi-memory-model>

use std::mem::size_of;
use std::net::SocketAddr;

use zero_host::access;
use zero_http::exchange::VIEW_SECURE;
use zero_http::{HostSpan, ViewSnapshot};
use zero_http_types::HeaderName;

use crate::abi::{ZeroBytes, ZeroField, ZeroPeer, ZeroRequestView, ZeroSpan, ZeroStatus};
use crate::guard::{guard, Fail};
use crate::handles::ZeroBuffer;
use crate::ptr as host;

const PARAM_INDEX: Fail = Fail::invalid("the parameter index is at or past the parameter count");
const HEADER_INDEX: Fail = Fail::invalid("the field index is at or past the field count");
const UNKNOWN_HEADER: Fail = Fail::invalid("the header id is not below ZERO_HEADER_COUNT");
const CLAIMS: Fail =
    Fail::unsupported("token claims need JWT verification, which this version does not include");

/// An offset or a length of the view as an index.
fn index(value: u32) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}

/// The bytes a span of the head covers, as a view.
fn head_span(view: &ViewSnapshot, span: HostSpan) -> ZeroBytes {
    if view.head.is_null() {
        return ZeroBytes::ABSENT;
    }
    ZeroBytes {
        ptr: view.head.wrapping_add(index(span.start)),
        len: index(span.len),
    }
}

/// The view of a span the request may not have.
fn optional_span(view: &ViewSnapshot, span: Option<HostSpan>) -> ZeroBytes {
    span.map_or(ZeroBytes::ABSENT, |span| head_span(view, span))
}

/// A read of a slot's published view that hands out one byte range.
fn view_bytes(slot: u64, pick: impl FnOnce(&ViewSnapshot) -> ZeroBytes) -> Result<ZeroBytes, Fail> {
    Ok(access::with_view(slot, pick)?)
}

/// The whole request view of a snapshot.
fn request_view(view: &ViewSnapshot) -> ZeroRequestView {
    ZeroRequestView {
        size: 0,
        method: view.method,
        version: view.version,
        flags: view.flags,
        route: view.route,
        miss_status: view.miss_status,
        allow: view.allow,
        head: view.head,
        head_len: view.head_len,
        field_count: view.field_count,
        method_token: ZeroSpan::of(view.method_token),
        target: ZeroSpan::of(view.target),
        path: ZeroSpan::of(view.path),
        query: view.query.map_or_else(ZeroSpan::default, ZeroSpan::of),
        authority: view.authority.map_or_else(ZeroSpan::default, ZeroSpan::of),
        fields: view.fields.cast::<ZeroField>(),
        route_path: view.route_path,
        route_path_len: view.route_path_len,
        param_count: view.param_count,
        body: view.body,
        body_len: view.body_len,
        field_size: u32::try_from(ZeroField::V1_SIZE).unwrap_or(u32::MAX),
        reserved: 0,
    }
}

/// An address as its family, its port and its sixteen address octets.
fn address_of(address: Option<SocketAddr>) -> (u8, u16, [u8; 16]) {
    match address {
        Some(SocketAddr::V4(address)) => {
            let mut octets = [0u8; 16];
            if let Some(prefix) = octets.get_mut(..4) {
                prefix.copy_from_slice(&address.ip().octets());
            }
            (4, address.port(), octets)
        }
        Some(SocketAddr::V6(address)) => (6, address.port(), address.ip().octets()),
        None => (0, 0, [0; 16]),
    }
}

/// The peer of a snapshot.
fn peer_of(view: &ViewSnapshot) -> ZeroPeer {
    let secure = view.flags & VIEW_SECURE != 0;
    let (family, port, address) = address_of(view.peer);
    let (client_family, client_port, client_address) = address_of(view.client);
    ZeroPeer {
        size: 0,
        family,
        secure: u8::from(secure),
        transport: if secure { 2 } else { 1 },
        alpn: 0,
        port,
        client_port,
        client_family,
        reserved: [0; 7],
        address,
        client_address,
    }
}

/// Writes the whole request of a leased slot in one read of its published view, with
/// no lock and no atomic read-modify-write: the fast path. The pointers inside follow
/// the view rule.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `view_out` - receives the view; its `size` is set before the call.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a thread the view rule refuses, an id above `ZERO_ID_MAX`, a
/// NULL or misaligned `view_out` or a `size` below the version 1 size; `Closed` unless
/// the slot is leased or completing at the id's generation.
///
/// # Safety
///
/// `view_out` must be NULL or point to a writable struct of at least its `size` octets.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_view(slot: u64, view_out: *mut ZeroRequestView) -> ZeroStatus {
    guard(|| {
        // SAFETY: sized structs: `view_out` is NULL or a writable struct whose size the
        // host set.
        let written = unsafe { host::out_size(view_out) }?;
        let view = access::with_view(slot, request_view)?;
        // SAFETY: sized structs: `written` came from `out_size` for this `view_out`.
        unsafe { host::write_sized(view_out, written, view) }
    })
}

/// Writes the method of a slot's request, from any thread.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `method_out` - receives a `ZERO_METHOD_*` id, or `ZERO_METHOD_OTHER` for a token
///   outside the method table, which `zero_req_method_token` reads.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` unless the slot is leased or completing at the id's generation;
/// `InvalidArgument` for an id above `ZERO_ID_MAX` or a NULL `method_out`.
///
/// # Safety
///
/// `method_out` must be NULL or point to a writable `uint8_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_method(slot: u64, method_out: *mut u8) -> ZeroStatus {
    guard(|| {
        host::check_out(method_out)?;
        let method = access::with_values(slot, |view| view.method)?;
        // SAFETY: outputs: `method_out` was checked and points to a writable `uint8_t`.
        unsafe { host::write_elements(method_out, size_of::<u8>(), &[method]) }
    })
}

/// Writes a view of the method token as received.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_method_token(slot: u64, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let bytes = view_bytes(slot, |view| head_span(view, view.method_token))?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the request target as received.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_target(slot: u64, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let bytes = view_bytes(slot, |view| head_span(view, view.target))?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the path of the request target, without the query.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_path(slot: u64, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let bytes = view_bytes(slot, |view| head_span(view, view.path))?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the query as received, without its `?`: absent, `{NULL, 0}`, when the
/// target has none, and present and empty for a bare `?`.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_query(slot: u64, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let bytes = view_bytes(slot, |view| optional_span(view, view.query))?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the normalized path the route matched.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_route_path(slot: u64, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let bytes = view_bytes(slot, |view| {
            if view.route_path.is_null() {
                ZeroBytes::ABSENT
            } else {
                ZeroBytes {
                    ptr: view.route_path,
                    len: index(view.route_path_len),
                }
            }
        })?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the authority: the `Host` value or the host and port of an
/// absolute-form target; absent when the request has none.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_authority(slot: u64, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let bytes = view_bytes(slot, |view| optional_span(view, view.authority))?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes the number of route parameters, from any thread.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `count_out` - receives the count.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_method`.
///
/// # Safety
///
/// `count_out` must be NULL or point to a writable `uint32_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_param_count(slot: u64, count_out: *mut u32) -> ZeroStatus {
    guard(|| {
        host::check_out(count_out)?;
        let count = access::with_values(slot, |view| view.param_count)?;
        // SAFETY: outputs: `count_out` was checked and points to a writable `uint32_t`.
        unsafe { host::write_elements(count_out, size_of::<u32>(), &[count]) }
    })
}

/// Writes a view of a route parameter in pattern order, as the normalized path holds it:
/// reserved characters stay percent-encoded.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `index` - the parameter's position in the pattern.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an index at or past the count; otherwise as `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_param(slot: u64, index: u32, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let at = self::index(index);
        let bytes = access::with_pinned_read(slot, |exchange| {
            exchange.request().param(at).map(ZeroBytes::of)
        })?
        .ok_or(PARAM_INDEX)?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes the number of field lines of the request head, from any thread.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `count_out` - receives the count.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_method`.
///
/// # Safety
///
/// `count_out` must be NULL or point to a writable `uint32_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_header_count(slot: u64, count_out: *mut u32) -> ZeroStatus {
    guard(|| {
        host::check_out(count_out)?;
        let count = access::with_values(slot, |view| view.field_count)?;
        // SAFETY: outputs: `count_out` was checked and points to a writable `uint32_t`.
        unsafe { host::write_elements(count_out, size_of::<u32>(), &[count]) }
    })
}

/// Writes views of the name and the value of a field line, in the order received.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `index` - the line's position.
/// * `name_out` - receives the name as received.
/// * `value_out` - receives the value without its surrounding whitespace.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an index at or past the count; otherwise as `zero_req_view`.
///
/// # Safety
///
/// `name_out` and `value_out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_header_at(
    slot: u64,
    index: u32,
    name_out: *mut ZeroBytes,
    value_out: *mut ZeroBytes,
) -> ZeroStatus {
    guard(|| {
        host::check_out(name_out)?;
        host::check_out(value_out)?;
        let at = self::index(index);
        let (name, value) = access::with_pinned_read(slot, |exchange| {
            exchange
                .request()
                .headers()
                .nth(at)
                .map(|(name, value)| (ZeroBytes::of(name), ZeroBytes::of(value)))
        })?
        .ok_or(HEADER_INDEX)?;
        // SAFETY: outputs: `name_out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(name_out, size_of::<ZeroBytes>(), &[name]) }?;
        // SAFETY: outputs: `value_out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(value_out, size_of::<ZeroBytes>(), &[value]) }
    })
}

/// Writes a view of the value of the `nth` field line with an interned name.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `name_id` - a `ZERO_HEADER_*` value.
/// * `nth` - which line of that name, from 0.
/// * `out` - receives the value; absent when the request has fewer such lines.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for an id at or above `ZERO_HEADER_COUNT`; otherwise as
/// `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_header_id(
    slot: u64,
    name_id: u32,
    nth: u32,
    out: *mut ZeroBytes,
) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let name = u8::try_from(name_id)
            .ok()
            .and_then(HeaderName::from_id)
            .ok_or(UNKNOWN_HEADER)?;
        let nth = index(nth);
        let bytes = access::with_pinned_read(slot, |exchange| {
            let found = exchange
                .fields()
                .iter()
                .zip(exchange.request().headers())
                .filter(|(field, _)| field.header() == Some(name))
                .nth(nth)
                .map(|(_, (_, value))| value);
            ZeroBytes::of_option(found)
        })?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the value of the `nth` field line with a name, compared without
/// regard to ASCII case.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `name` - the field name.
/// * `len` - its length in octets.
/// * `nth` - which line of that name, from 0.
/// * `out` - receives the value; absent when the request has fewer such lines.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`, and `InvalidArgument` for an input range the rules refuse.
///
/// # Safety
///
/// `name` must be a readable range of `len` octets, and `out` NULL or a writable
/// `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_header(
    slot: u64,
    name: *const u8,
    len: usize,
    nth: u32,
    out: *mut ZeroBytes,
) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        // SAFETY: input ranges: `name` is `len` readable octets for the call.
        let name = unsafe { host::read_bytes(name, len) }?;
        let nth = index(nth);
        let bytes = access::with_pinned_read(slot, |exchange| {
            let found = exchange
                .request()
                .headers()
                .filter(|(field, _)| field.eq_ignore_ascii_case(name))
                .nth(nth)
                .map(|(_, value)| value);
            ZeroBytes::of_option(found)
        })?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the value of the first trailer field with a name, compared without
/// regard to case, among the trailers the server's `trailers` option allows; any other
/// name is absent.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `name` - the trailer field name.
/// * `len` - its length in octets.
/// * `out` - receives the value, or absent.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_header`.
///
/// # Safety
///
/// As `zero_req_header`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_trailer(
    slot: u64,
    name: *const u8,
    len: usize,
    out: *mut ZeroBytes,
) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        // SAFETY: input ranges: `name` is `len` readable octets for the call.
        let name = unsafe { host::read_bytes(name, len) }?;
        let bytes = access::with_pinned_read(slot, |exchange| {
            ZeroBytes::of_option(exchange.trailer(name))
        })?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes a view of the buffered request body.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `out` - receives the view.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_view`.
///
/// # Safety
///
/// `out` must be NULL or point to a writable `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_body(slot: u64, out: *mut ZeroBytes) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        let bytes = view_bytes(slot, |view| {
            if view.body.is_null() {
                ZeroBytes::ABSENT
            } else {
                ZeroBytes {
                    ptr: view.body,
                    len: usize::try_from(view.body_len).unwrap_or(usize::MAX),
                }
            }
        })?;
        // SAFETY: outputs: `out` was checked and points to a writable `ZeroBytes`.
        unsafe { host::write_elements(out, size_of::<ZeroBytes>(), &[bytes]) }
    })
}

/// Writes an owned copy of the buffered request body, from any thread; it stays valid
/// after the slot is gone.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `body_out` - receives the copy, an owned buffer the caller releases with
///   `zero_buffer_free`.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_method`, and `Panic` for a slot a panic poisoned.
///
/// # Safety
///
/// `body_out` must be NULL or point to a writable `ZeroBuffer *`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_body_retain(
    slot: u64,
    body_out: *mut *mut ZeroBuffer,
) -> ZeroStatus {
    guard(|| {
        host::check_out(body_out)?;
        let body = access::with_read(slot, |exchange| exchange.request().body().to_vec())?;
        let buffer = ZeroBuffer::into_raw(body);
        // SAFETY: outputs: `body_out` was checked and points to a writable pointer.
        unsafe { host::write_elements(body_out, size_of::<*mut ZeroBuffer>(), &[buffer]) }
    })
}

/// Reads a claim of the request's verified token. Token verification is not part of
/// this version, so a valid call returns `ZeroStatus_Unsupported`.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `name` - the claim's name.
/// * `len` - its length in octets.
/// * `out` - would receive the claim's value.
///
/// # Returns
///
/// `ZeroStatus_Unsupported` for a valid call, or another refusal.
///
/// # Errors
///
/// As `zero_req_method`, and `InvalidArgument` for an input range the rules refuse.
///
/// # Safety
///
/// `name` must be a readable range of `len` octets, and `out` NULL or a writable
/// `ZeroBytes`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_claim(
    slot: u64,
    name: *const u8,
    len: usize,
    out: *mut ZeroBytes,
) -> ZeroStatus {
    guard(|| {
        host::check_out(out)?;
        // SAFETY: input ranges: `name` is `len` readable octets for the call.
        unsafe { host::read_bytes(name, len) }?;
        access::with_values(slot, |_| ())?;
        Err(CLAIMS)
    })
}

/// Writes the addresses of a request's connection, from any thread: the peer, and the
/// client after the trust-proxy rule.
///
/// # Arguments
///
/// * `slot` - the slot's id.
/// * `peer_out` - receives the addresses; its `size` is set before the call.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// As `zero_req_method`, and `InvalidArgument` for a `size` below the version 1 size.
///
/// # Safety
///
/// `peer_out` must be NULL or point to a writable struct of at least its `size` octets.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_req_peer(slot: u64, peer_out: *mut ZeroPeer) -> ZeroStatus {
    guard(|| {
        // SAFETY: sized structs: `peer_out` is NULL or a writable struct whose size the
        // host set.
        let written = unsafe { host::out_size(peer_out) }?;
        let peer = access::with_values(slot, peer_of)?;
        // SAFETY: sized structs: `written` came from `out_size` for this `peer_out`.
        unsafe { host::write_sized(peer_out, written, peer) }
    })
}
