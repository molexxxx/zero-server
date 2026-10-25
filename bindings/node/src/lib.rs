//! The Node.js addon of zero-server: the native surface `@zero-server/native` loads.
//!
//! The addon calls the host layer of the core (`zero-host`) directly: applications,
//! servers and their lifecycle, targets that deliver batches of leased requests and
//! connection events to an isolate, the request readers and response writers by slot
//! id, large-body staging, WebSocket, server-sent events and rooms by connection id,
//! and the conformance entry. `@zero-server/core` wraps it with typed JavaScript, and
//! applications import `@zero-server/sdk`.
//!
//! Every export catches panics and turns every refusal into an `Error` whose `code`
//! is `ZERO_` and the status name (`ZERO_CLOSED` for a stale id,
//! `ZERO_INVALID_ARGUMENT` for an argument out of its range, `ZERO_PANIC` for a
//! caught panic), with the core's message. Ids cross as JavaScript numbers below
//! 2^53. Request bytes are copied out of the core inside each call, so no JavaScript
//! value points into the core's memory; the one shared buffer is a staged response
//! body, detached from JavaScript before the core reads it.
//!
//! Each worker_threads isolate loads the addon on its own: per-isolate state lives in
//! thread-locals of the isolate's thread, and environment cleanup hooks detach what
//! an isolate attached when it is torn down.
//!
//! @see <https://nodejs.org/docs/latest-v22.x/api/n-api.html>
//! @see <https://nodejs.org/docs/latest-v22.x/api/addons.html>

#![cfg_attr(test, allow(dead_code))]

mod app;
mod conformance;
mod guard;
mod ids;
mod realtime;
mod request;
mod response;
mod server;
mod staging;
mod status;
mod target;

use napi_derive::napi;
use zero_host::HeaderName;

use crate::guard::{node_guard, Code, Fail};

/// The version of the C ABI this core implements, `ZERO_ABI_VERSION` of `zero.h`.
const ABI_VERSION: u32 = 1;

/// The version of the native zero-server core.
///
/// # Returns
///
/// The version string of the core crates the addon was built from.
///
/// # Errors
///
/// None in practice; a caught panic is `ZERO_PANIC`.
#[napi(catch_unwind)]
pub fn core_version() -> napi::Result<String, Code> {
    node_guard(|| Ok(zero_host::VERSION.to_owned()))
}

/// The version of the native zero-server core, the name the packages read before
/// `coreVersion`.
///
/// # Returns
///
/// The version string of the core crates the addon was built from.
///
/// # Errors
///
/// None in practice; a caught panic is `ZERO_PANIC`.
#[napi(catch_unwind)]
pub fn version() -> napi::Result<String, Code> {
    node_guard(|| Ok(zero_host::VERSION.to_owned()))
}

/// The version of the C ABI this core implements.
///
/// # Returns
///
/// The `ZERO_ABI_VERSION` of `zero.h`.
///
/// # Errors
///
/// None in practice; a caught panic is `ZERO_PANIC`.
#[napi(catch_unwind)]
pub fn abi_version() -> napi::Result<u32, Code> {
    node_guard(|| Ok(ABI_VERSION))
}

/// The lowercase spelling of an interned header name, the table the facade builds
/// once to turn header ids into names.
///
/// # Arguments
///
/// * `id` - the header id, 0 to 48.
///
/// # Returns
///
/// The name.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for an id that names no header.
#[napi(catch_unwind)]
pub fn header_name(id: f64) -> napi::Result<String, Code> {
    node_guard(|| {
        let id = ids::u8_of(id, "the header id")?;
        HeaderName::from_id(id)
            .map(|name| name.as_str().to_owned())
            .ok_or_else(|| Fail::invalid(format!("header id {id} names no header")))
    })
}
