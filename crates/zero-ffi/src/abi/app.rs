//! Apps: the routes, the miss route, the policies and the mounts a server is built from,
//! registered from UTF-8 JSON option documents.
//!
//! Each document is read with zero-json's strict parser into the typed options of its
//! kind, and an unknown key is refused with `ZeroStatus_Codec` naming the key, so a typo
//! never falls back to a default. Route ids are dense, in registration order, and the
//! canonical table (`zero_app_table`) tells two registrations apart byte for byte.

use std::mem::size_of;

use zero_host::{App, Method, PolicyKind, RouteKind};

use crate::abi::names::ZERO_METHOD_ANY;
use crate::abi::ZeroStatus;
use crate::guard::{guard, Fail};
use crate::handles::ZeroBuffer;
use crate::ids::Table;
use crate::ptr as host;

/// Every app a host built and has not freed or mounted.
pub(crate) static APPS: Table<App> = Table::new(
    "the app id is unknown, was freed, or was mounted",
    "a panic poisoned the app table",
);

const ROUTE_KIND: Fail = Fail::invalid("the route kind is not one of ZERO_ROUTE_*");
const POLICY_KIND: Fail = Fail::invalid("the policy kind is not one of ZERO_POLICY_*");
const METHOD: Fail = Fail::invalid("the method is not a ZERO_METHOD_* id or ZERO_METHOD_ANY");
const PATTERN: Fail = Fail::invalid("the pattern is not UTF-8");
const PREFIX: Fail = Fail::invalid("the prefix is not UTF-8");
const SELF_MOUNT: Fail = Fail::invalid("an app cannot be mounted on itself");

/// The method a route registers for: one of the table, or every method.
fn route_method(method: u8) -> Result<Option<Method>, Fail> {
    if method == ZERO_METHOD_ANY {
        return Ok(None);
    }
    Method::from_id(method).map(Some).ok_or(METHOD)
}

/// Creates an app with no route.
///
/// # Arguments
///
/// * `app_out` - receives the app's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a NULL or misaligned `app_out`.
///
/// # Safety
///
/// `app_out` must be NULL or point to a writable `uint64_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_app_new(app_out: *mut u64) -> ZeroStatus {
    guard(|| {
        host::check_out(app_out)?;
        let id = APPS.insert(App::new())?;
        // SAFETY: outputs: `app_out` was checked and points to a writable `uint64_t`.
        unsafe { host::write_elements(app_out, size_of::<u64>(), &[id]) }
    })
}

/// Releases an app. A server built from it keeps its own frozen copy.
///
/// # Arguments
///
/// * `app` - the app's id.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` for an unknown or freed id, `InvalidArgument` for an id above `ZERO_ID_MAX`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn zero_app_free(app: u64) -> ZeroStatus {
    guard(|| APPS.remove(app).map(drop))
}

/// Registers a route.
///
/// The option document of each kind holds these keys: `ZERO_ROUTE_HOST` `maxBody`;
/// `ZERO_ROUTE_STATIC` `root`, `index` (a name or false), `maxAgeMs`, `dotfiles`
/// (`ignore`, `deny` or `allow`), `extensions`, `fallthrough`, `etag`, `ranges`;
/// `ZERO_ROUTE_REDIRECT` `status` (301, 302, 303, 307 or 308) and `location`;
/// `ZERO_ROUTE_FIXED` `status`, `contentType`, and `body` or `bodyBase64`;
/// `ZERO_ROUTE_WEBSOCKET` `protocols`, `origins` (an array or null), `maxPayload`,
/// `pingIntervalMs`; `ZERO_ROUTE_HEALTH` `status` and `body`. An empty document takes
/// every default.
///
/// # Arguments
///
/// * `app` - the app's id.
/// * `kind` - a `ZERO_ROUTE_*` value.
/// * `method` - a `ZERO_METHOD_*` id, or `ZERO_METHOD_ANY` for every method.
/// * `pattern` - the UTF-8 path pattern: `/` then static segments, `:name` parameters and
///   at most one final `*` or `*name` catch-all.
/// * `pattern_len` - its length in octets.
/// * `options` - the UTF-8 JSON option document.
/// * `options_len` - its length in octets.
/// * `route_out` - receives the route's id, the next in registration order.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Codec` for a malformed option document, naming the key; `InvalidArgument` for an
/// undeclared kind or method, a pattern that is not UTF-8 or is outside the syntax, or a
/// route already registered for the method and pattern; `Io` for a static root that
/// cannot be opened; `Unsupported` for a kind whose capability is compiled out; `Closed`
/// for an unknown app.
///
/// # Safety
///
/// `pattern` and `options` must be readable ranges of their lengths, and `route_out` NULL
/// or a writable `uint32_t`.
#[allow(unsafe_code, clippy::too_many_arguments)]
#[no_mangle]
pub unsafe extern "C" fn zero_app_route(
    app: u64,
    kind: u32,
    method: u8,
    pattern: *const u8,
    pattern_len: usize,
    options: *const u8,
    options_len: usize,
    route_out: *mut u32,
) -> ZeroStatus {
    guard(|| {
        host::check_out(route_out)?;
        let kind = RouteKind::from_code(kind).ok_or(ROUTE_KIND)?;
        let method = route_method(method)?;
        // SAFETY: input ranges: `pattern` is `pattern_len` readable octets for the call.
        let pattern = unsafe { host::read_bytes(pattern, pattern_len) }?;
        let pattern = std::str::from_utf8(pattern).map_err(|_| PATTERN)?;
        // SAFETY: input ranges: `options` is `options_len` readable octets for the call.
        let options = unsafe { host::read_bytes(options, options_len) }?;
        let route = APPS.with(app, |app| app.route(kind, method, pattern, options))??;
        // SAFETY: outputs: `route_out` was checked and points to a writable `uint32_t`.
        unsafe { host::write_elements(route_out, size_of::<u32>(), &[route]) }
    })
}

/// Mounts one app under a prefix of another: the child's routes are matched under the
/// prefix, renumbered after the routes the parent holds, and its policies apply under
/// the prefix. On success the child's id is consumed.
///
/// # Arguments
///
/// * `app` - the parent's id.
/// * `prefix` - the UTF-8 prefix: `/` and static segments, not the root.
/// * `prefix_len` - its length in octets.
/// * `child` - the child's id; it must have no miss route and no trust-proxy policy.
/// * `base_out` - receives how much every child route id grew: the id the child's first
///   route has now.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `InvalidArgument` for a prefix outside the syntax or not UTF-8, a child with a miss
/// route or a trust-proxy policy, or a child that is the parent; `Closed` for an unknown
/// app. Both apps are unchanged, and the child's id stays valid, after a refusal.
///
/// # Safety
///
/// `prefix` must be a readable range of `prefix_len` octets, and `base_out` NULL or a
/// writable `uint32_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_app_mount(
    app: u64,
    prefix: *const u8,
    prefix_len: usize,
    child: u64,
    base_out: *mut u32,
) -> ZeroStatus {
    guard(|| {
        host::check_out(base_out)?;
        crate::ids::check(app)?;
        crate::ids::check(child)?;
        if app == child {
            return Err(SELF_MOUNT);
        }
        // SAFETY: input ranges: `prefix` is `prefix_len` readable octets for the call.
        let prefix = unsafe { host::read_bytes(prefix, prefix_len) }?;
        let prefix = std::str::from_utf8(prefix).map_err(|_| PREFIX)?;
        let base = {
            let mut apps = APPS.lock()?;
            let mounted = apps.get(&child).cloned().ok_or_else(|| APPS.unknown())?;
            let parent = apps.get_mut(&app).ok_or_else(|| APPS.unknown())?;
            let base = parent.mount(prefix, mounted)?;
            apps.remove(&child);
            base
        };
        // SAFETY: outputs: `base_out` was checked and points to a writable `uint32_t`.
        unsafe { host::write_elements(base_out, size_of::<u32>(), &[base]) }
    })
}

/// Registers the miss route: requests no route matches go to the host under its id,
/// with the status the core would have answered (404, 405, 501, or 200 for OPTIONS) in
/// `ZeroRequestView.miss_status` and the allowed methods in `allow`.
///
/// # Arguments
///
/// * `app` - the app's id.
/// * `route_out` - receives the miss route's id; the same id when it is registered again.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` for an unknown app, `InvalidArgument` for a NULL or misaligned `route_out`.
///
/// # Safety
///
/// `route_out` must be NULL or point to a writable `uint32_t`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_app_miss(app: u64, route_out: *mut u32) -> ZeroStatus {
    guard(|| {
        host::check_out(route_out)?;
        let route = APPS.with(app, App::miss)?;
        // SAFETY: outputs: `route_out` was checked and points to a writable `uint32_t`.
        unsafe { host::write_elements(route_out, size_of::<u32>(), &[route]) }
    })
}

/// Registers a policy over the paths under a prefix.
///
/// The option document of each kind holds these keys: `ZERO_POLICY_CORS` `origins` (`"*"`
/// or an array of origins and `.suffix` entries), `methods`, `headers`, `expose`,
/// `credentials`, `maxAge`; `ZERO_POLICY_SECURITY_HEADERS` `fields`, an array of name and
/// value pairs; `ZERO_POLICY_REQUEST_ID` `header`, `trustIncoming`, `version` (4 or 7);
/// `ZERO_POLICY_TRUST_PROXY` `cidrs` and `header` (`"x-forwarded-for"` or `"forwarded"`,
/// the one family of forwarding fields the trusted proxies write and the only one read);
/// `ZERO_POLICY_BODY_LIMIT` `max`. Where policies of one kind overlap, the longest prefix
/// wins, then the later registration.
///
/// # Arguments
///
/// * `app` - the app's id.
/// * `kind` - a `ZERO_POLICY_*` value.
/// * `prefix` - the UTF-8 path prefix, matched on a segment boundary; empty or `/` for
///   every path, which a trust-proxy policy must be.
/// * `prefix_len` - its length in octets.
/// * `options` - the UTF-8 JSON option document.
/// * `options_len` - its length in octets.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Codec` for a malformed option document, naming the key; `InvalidArgument` for an
/// undeclared kind, a prefix that is not an absolute path or not UTF-8, or a second
/// trust-proxy policy; `Unsupported` when the `policy` capability is compiled out;
/// `Closed` for an unknown app.
///
/// # Safety
///
/// `prefix` and `options` must be readable ranges of their lengths.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_app_policy(
    app: u64,
    kind: u32,
    prefix: *const u8,
    prefix_len: usize,
    options: *const u8,
    options_len: usize,
) -> ZeroStatus {
    guard(|| {
        let kind = PolicyKind::from_code(kind).ok_or(POLICY_KIND)?;
        // SAFETY: input ranges: `prefix` is `prefix_len` readable octets for the call.
        let prefix = unsafe { host::read_bytes(prefix, prefix_len) }?;
        let prefix = std::str::from_utf8(prefix).map_err(|_| PREFIX)?;
        // SAFETY: input ranges: `options` is `options_len` readable octets for the call.
        let options = unsafe { host::read_bytes(options, options_len) }?;
        APPS.with(app, |app| app.policy(kind, prefix, options))?
            .map_err(Fail::from)
    })
}

/// Writes the canonical table of an app: one line per route (kind, method, normalized
/// pattern, id and options) sorted by pattern then method, then the miss route, the
/// policies in registration order and the mounts. Two hosts that registered the same app
/// get the same bytes.
///
/// # Arguments
///
/// * `app` - the app's id.
/// * `table_out` - receives the table, an owned buffer the caller releases with
///   `zero_buffer_free`.
///
/// # Returns
///
/// `ZeroStatus_Ok`, or a refusal.
///
/// # Errors
///
/// `Closed` for an unknown app, `InvalidArgument` for a NULL or misaligned `table_out`.
///
/// # Safety
///
/// `table_out` must be NULL or point to a writable `ZeroBuffer *`.
#[allow(unsafe_code)]
#[no_mangle]
pub unsafe extern "C" fn zero_app_table(app: u64, table_out: *mut *mut ZeroBuffer) -> ZeroStatus {
    guard(|| {
        host::check_out(table_out)?;
        let table = APPS.with(app, |app| app.table())?;
        let buffer = ZeroBuffer::into_raw(table);
        // SAFETY: outputs: `table_out` was checked and points to a writable pointer.
        unsafe { host::write_elements(table_out, size_of::<*mut ZeroBuffer>(), &[buffer]) }
    })
}
