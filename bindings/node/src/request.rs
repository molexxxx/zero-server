//! Request readers: every value is copied out of the slot inside one access, so no
//! JavaScript value points into the core's memory. The copy is made under the slot's
//! lock and the JavaScript value is created from it after the lock is released.
//!
//! The head, the field lines, the parameters and the trailers become strings with
//! one character per octet (latin1), the way Node reads header bytes, so no octet is
//! lost or replaced. The body becomes a `Buffer` that owns a copy of the bytes, which
//! stays valid and unchanged after the request completes and its slot is reused.
//!
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_create_buffer_copy>
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_create_string_latin1>

use std::net::SocketAddr;

use napi::bindgen_prelude::BufferSlice;
use napi::{Env, JsString};
use napi_derive::napi;
use zero_host::access;

use crate::guard::{node_guard, Code, Fail};
use crate::ids;

/// The view flag of a request that arrived over a secure connection.
const VIEW_SECURE: u16 = 1;

/// The request head as `reqHead` returns it.
type Head<'env> = (u32, JsString<'env>, JsString<'env>, u32, u32, u32, u32);

/// A latin1 string of `bytes`.
fn latin1<'env>(env: &'env Env, bytes: &[u8]) -> Result<JsString<'env>, Fail> {
    env.create_string_latin1(bytes)
        .map_err(|error| Fail::napi(&error))
}

/// Latin1 strings of a list of octet strings, in order.
fn latin1_all<'env>(env: &'env Env, list: &[Vec<u8>]) -> Result<Vec<JsString<'env>>, Fail> {
    list.iter().map(|bytes| latin1(env, bytes)).collect()
}

/// Whether a slot's request was canceled: its connection or its worker index's
/// target went away. Writes to a canceled slot are refused anyway.
///
/// # Arguments
///
/// * `slot` - the slot id.
///
/// # Returns
///
/// `true` for a canceled or closed lease.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a number that is not an id, and `ZERO_CLOSED` for a
/// stale or unknown id, including a lease the worker already retired.
#[napi(catch_unwind)]
pub fn slot_canceled(slot: f64) -> napi::Result<bool, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        access::canceled(id).map_err(Fail::from)
    })
}

/// The request head in one call: the method id (255 for a token outside the
/// registry), the method token, the request target, the version (10 or 11), the view
/// flags (1 secure, 2 upgrade, 4 keep-alive, 8 expect continue, 16 HEAD served by
/// GET, 32 query present), the status the core would have answered a request routed
/// to the miss route (0 for a matched route) and its `Allow` set (bit `i` for method
/// id `i`).
///
/// # Arguments
///
/// * `slot` - the slot id.
///
/// # Returns
///
/// `[method, token, target, version, flags, missStatus, allow]`.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a number that is not an id, `ZERO_CLOSED` for a stale
/// or unknown id or a slot that is no longer leased, and `ZERO_PANIC` for a slot a
/// panic poisoned.
#[napi(
    catch_unwind,
    ts_return_type = "[number, string, string, number, number, number, number]"
)]
pub fn req_head(env: &Env, slot: f64) -> napi::Result<Head<'_>, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let (method, version, flags, miss, allow) = access::with_values(id, |view| {
            (
                view.method,
                view.version,
                view.flags,
                view.miss_status,
                view.allow,
            )
        })?;
        let (token, target) = access::with_read(id, |exchange| {
            let request = exchange.request();
            (request.method_token().to_vec(), request.target().to_vec())
        })?;
        Ok((
            u32::from(method),
            latin1(env, &token)?,
            latin1(env, &target)?,
            u32::from(version),
            u32::from(flags),
            u32::from(miss),
            u32::from(allow),
        ))
    })
}

/// The request's method id, version, view flags and miss status packed in one
/// number, read from the slot's published view without its lock: bits 0 to 7 the
/// method id, 8 to 15 the version, 16 to 31 the flags, 32 to 47 the miss status.
///
/// # Arguments
///
/// * `slot` - the slot id.
///
/// # Returns
///
/// The packed number.
///
/// # Errors
///
/// As `reqHead`.
#[napi(catch_unwind)]
pub fn req_meta(slot: f64) -> napi::Result<f64, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let packed = access::with_values(id, |view| {
            u64::from(view.method)
                | u64::from(view.version) << 8
                | u64::from(view.flags) << 16
                | u64::from(view.miss_status) << 32
        })?;
        Ok(ids::number(packed))
    })
}

/// Every field line of the request in order, as name and value pairs in one flat
/// array, latin1, names as received.
///
/// # Arguments
///
/// * `slot` - the slot id.
///
/// # Returns
///
/// `[name, value, name, value, ...]`.
///
/// # Errors
///
/// As `reqHead`.
#[napi(catch_unwind, ts_return_type = "string[]")]
pub fn req_headers(env: &Env, slot: f64) -> napi::Result<Vec<JsString<'_>>, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let lines = access::with_read(id, |exchange| {
            let request = exchange.request();
            let mut lines = Vec::with_capacity(exchange.fields().len().saturating_mul(2));
            for (name, value) in request.headers() {
                lines.push(name.to_vec());
                lines.push(value.to_vec());
            }
            lines
        })?;
        latin1_all(env, &lines)
    })
}

/// The value of the first field line with a name, compared without regard to case.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `name` - the field name.
///
/// # Returns
///
/// The value, latin1, or `null` when the request has no such field.
///
/// # Errors
///
/// As `reqHead`.
#[napi(catch_unwind)]
pub fn req_header(env: &Env, slot: f64, name: String) -> napi::Result<Option<JsString<'_>>, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let value = access::with_read(id, |exchange| {
            exchange
                .request()
                .header(name.as_bytes())
                .map(<[u8]>::to_vec)
        })?;
        value.map(|value| latin1(env, &value)).transpose()
    })
}

/// The route parameters in pattern order, as the normalized path holds them:
/// reserved characters and octets outside ASCII stay percent-encoded.
///
/// # Arguments
///
/// * `slot` - the slot id.
///
/// # Returns
///
/// One string per parameter, latin1.
///
/// # Errors
///
/// As `reqHead`.
#[napi(catch_unwind, ts_return_type = "string[]")]
pub fn req_params(env: &Env, slot: f64) -> napi::Result<Vec<JsString<'_>>, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let params = access::with_read(id, |exchange| {
            exchange
                .request()
                .params()
                .map(<[u8]>::to_vec)
                .collect::<Vec<_>>()
        })?;
        latin1_all(env, &params)
    })
}

/// The value of the first trailer with a name, among the trailers the server's
/// `trailers` option allows.
///
/// # Arguments
///
/// * `slot` - the slot id.
/// * `name` - the trailer name, compared without regard to case.
///
/// # Returns
///
/// The value, latin1, or `null`.
///
/// # Errors
///
/// As `reqHead`.
#[napi(catch_unwind)]
pub fn req_trailer(env: &Env, slot: f64, name: String) -> napi::Result<Option<JsString<'_>>, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let value = access::with_read(id, |exchange| {
            exchange.trailer(name.as_bytes()).map(<[u8]>::to_vec)
        })?;
        value.map(|value| latin1(env, &value)).transpose()
    })
}

/// The buffered request body, as a `Buffer` that owns a copy: changing it changes
/// nothing in the core, and it stays valid and unchanged after the request
/// completes.
///
/// # Arguments
///
/// * `slot` - the slot id.
///
/// # Returns
///
/// The copy; empty when the request had no body.
///
/// # Errors
///
/// As `reqHead`, and `ZERO_LIMIT` when Node-API cannot allocate the copy.
///
/// @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_create_buffer_copy>
#[napi(catch_unwind)]
pub fn req_body(env: &Env, slot: f64) -> napi::Result<BufferSlice<'_>, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let body = access::with_read(id, |exchange| exchange.request().body().to_vec())?;
        BufferSlice::copy_from(env, body).map_err(|error| Fail::napi(&error))
    })
}

/// The peer of a request and the client the trust-proxy rule found.
#[napi(object, object_from_js = false)]
pub struct ZeroPeer {
    /// The peer's address; empty when unknown.
    pub address: String,
    /// The peer's port.
    pub port: u32,
    /// 4 or 6, or 0 when unknown.
    pub family: u32,
    /// Whether the request arrived over a secure connection.
    pub secure: bool,
    /// The client's address after the trust-proxy rule; the peer's without one.
    pub client_address: String,
}

/// The address, the port and the family of an address.
fn parts(address: Option<SocketAddr>) -> (String, u32, u32) {
    match address {
        Some(SocketAddr::V4(address)) => (address.ip().to_string(), u32::from(address.port()), 4),
        Some(SocketAddr::V6(address)) => (address.ip().to_string(), u32::from(address.port()), 6),
        None => (String::new(), 0, 0),
    }
}

/// The request's peer, read from the slot's published view without its lock.
///
/// # Arguments
///
/// * `slot` - the slot id.
///
/// # Returns
///
/// The peer.
///
/// # Errors
///
/// As `reqHead`.
#[napi(catch_unwind)]
pub fn req_peer(slot: f64) -> napi::Result<ZeroPeer, Code> {
    node_guard(|| {
        let id = ids::id(slot, "the slot id")?;
        let (peer, client, flags) =
            access::with_values(id, |view| (view.peer, view.client, view.flags))?;
        let (address, port, family) = parts(peer);
        let (client_address, _, _) = parts(client.or(peer));
        Ok(ZeroPeer {
            address,
            port,
            family,
            secure: flags & VIEW_SECURE != 0,
            client_address,
        })
    })
}
