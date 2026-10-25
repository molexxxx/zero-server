//! Applications: the routes and policies an isolate registers before a server serves
//! them.
//!
//! An application belongs to the isolate that created it: the registry is a
//! thread-local of the isolate's thread, so it is freed with the isolate, and an
//! application id from another isolate reads as unknown. Ids are handed out once per
//! process and never reused. A server freezes the application it is created from, so
//! later registrations reach only servers created after them.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use zero_host::{App, Method, PolicyKind, RouteKind};

use crate::guard::{node_guard, Code, Fail};
use crate::ids;

/// The method code that registers a route for every method.
pub(crate) const METHOD_ANY: u8 = 254;

/// The next application id.
static NEXT_APP: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// The applications of this isolate, by id.
    static APPS: RefCell<BTreeMap<u64, App>> = const { RefCell::new(BTreeMap::new()) };
}

/// Run `work` on the application `app` names in this isolate.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for an id that is not one, `ZERO_CLOSED` for an id this
/// isolate does not hold, and the refusal `work` returns.
pub(crate) fn with_app<R>(
    app: f64,
    work: impl FnOnce(&mut App) -> Result<R, Fail>,
) -> Result<R, Fail> {
    let id = ids::id(app, "the application id")?;
    APPS.try_with(|apps| {
        let mut apps = apps
            .try_borrow_mut()
            .map_err(|_| Fail::invalid("the application registry is in use"))?;
        let app = apps
            .get_mut(&id)
            .ok_or_else(|| Fail::closed(format!("no application {id} in this isolate")))?;
        work(app)
    })
    .map_err(|_| Fail::closed("the isolate is shutting down"))?
}

/// Create an application with no route.
///
/// # Returns
///
/// The application's id, valid in the calling isolate.
///
/// # Errors
///
/// `ZERO_LIMIT` once the process handed out 2^53 - 1 application ids, and
/// `ZERO_CLOSED` while the isolate shuts down.
#[napi(catch_unwind)]
pub fn app_new() -> napi::Result<f64, Code> {
    node_guard(|| {
        let id = NEXT_APP.fetch_add(1, Ordering::Relaxed);
        if id > ids::ID_MAX {
            return Err(Fail::new(
                Code::LIMIT,
                "the process handed out every application id",
            ));
        }
        APPS.try_with(|apps| {
            apps.try_borrow_mut()
                .map(|mut apps| {
                    apps.insert(id, App::new());
                })
                .map_err(|_| Fail::invalid("the application registry is in use"))
        })
        .map_err(|_| Fail::closed("the isolate is shutting down"))??;
        Ok(ids::number(id))
    })
}

/// Register a route.
///
/// The option document of each kind: host `maxBody`; static `root`, `index`,
/// `maxAgeMs`, `dotfiles`, `extensions`, `fallthrough`, `etag`, `ranges`; redirect
/// `status` and `location`; fixed `status`, `contentType`, and `body` or
/// `bodyBase64`; WebSocket `protocols`, `origins`, `maxPayload`, `pingIntervalMs`;
/// health `status` and `body`.
///
/// # Arguments
///
/// * `app` - the application id.
/// * `kind` - 0 host, 1 static, 2 redirect, 3 fixed, 4 WebSocket, 5 health.
/// * `method` - the method id (0 GET to 8 PATCH), or 254 for every method.
/// * `pattern` - the path pattern: `/`, static segments, `:name` parameters and at
///   most one final `*` or `*name` catch-all.
/// * `options` - the JSON option document; empty for the defaults.
///
/// # Returns
///
/// The route id, the next in registration order.
///
/// # Errors
///
/// `ZERO_CODEC` for a malformed option document, `ZERO_INVALID_ARGUMENT` for an
/// unknown kind or method, a pattern outside the syntax or a route already
/// registered for the method and pattern, `ZERO_IO` for a static root that cannot
/// be opened, `ZERO_UNSUPPORTED` for a kind this build leaves out, and `ZERO_CLOSED`
/// for an unknown application.
#[napi(catch_unwind)]
pub fn app_route(
    app: f64,
    kind: f64,
    method: f64,
    pattern: String,
    options: String,
) -> napi::Result<u32, Code> {
    node_guard(|| {
        let kind = RouteKind::from_code(ids::u32_of(kind, "the route kind")?)
            .ok_or_else(|| Fail::invalid("the route kind is not 0 to 5"))?;
        let method = route_method(method)?;
        with_app(app, |app| {
            app.route(kind, method, &pattern, options.as_bytes())
                .map_err(Fail::from)
        })
    })
}

/// The method a route registers for: one method id, or every method.
fn route_method(method: f64) -> Result<Option<Method>, Fail> {
    let code = ids::u8_of(method, "the method id")?;
    if code == METHOD_ANY {
        return Ok(None);
    }
    Method::from_id(code)
        .map(Some)
        .ok_or_else(|| Fail::invalid("the method id is not 0 to 8 or 254"))
}

/// Mount another application of this isolate under a prefix: its routes are matched
/// under the prefix and its policies apply under it. The child is consumed: its id
/// is no longer valid once the mount succeeded, and stays valid when it is refused.
///
/// # Arguments
///
/// * `app` - the application id.
/// * `prefix` - `/` and static segments; not the root.
/// * `child` - the id of the application to mount; it has no miss route and no
///   trust-proxy policy.
///
/// # Returns
///
/// The id the child's first route has now: every child route id grew by this much.
///
/// # Errors
///
/// `ZERO_INVALID_ARGUMENT` for a prefix outside the syntax, the root, an application
/// mounted into itself, or a child with a miss route or a trust-proxy policy, and
/// `ZERO_CLOSED` for an unknown application.
#[napi(catch_unwind)]
pub fn app_mount(app: f64, prefix: String, child: f64) -> napi::Result<u32, Code> {
    node_guard(|| {
        let parent = ids::id(app, "the application id")?;
        let child = ids::id(child, "the child application id")?;
        if parent == child {
            return Err(Fail::invalid(
                "an application cannot be mounted into itself",
            ));
        }
        APPS.try_with(|apps| {
            let mut apps = apps
                .try_borrow_mut()
                .map_err(|_| Fail::invalid("the application registry is in use"))?;
            let mounted = apps
                .get(&child)
                .cloned()
                .ok_or_else(|| Fail::closed(format!("no application {child} in this isolate")))?;
            let base = apps
                .get_mut(&parent)
                .ok_or_else(|| Fail::closed(format!("no application {parent} in this isolate")))?
                .mount(&prefix, mounted)
                .map_err(Fail::from)?;
            apps.remove(&child);
            Ok(base)
        })
        .map_err(|_| Fail::closed("the isolate is shutting down"))?
    })
}

/// Register the miss route: requests no route matches go to the host under its id,
/// carrying the status and the `Allow` set the core would have answered.
///
/// # Arguments
///
/// * `app` - the application id.
///
/// # Returns
///
/// The miss route's id; the same id when it is registered again.
///
/// # Errors
///
/// `ZERO_CLOSED` for an unknown application.
#[napi(catch_unwind)]
pub fn app_miss(app: f64) -> napi::Result<u32, Code> {
    node_guard(|| with_app(app, |app| Ok(app.miss())))
}

/// Register a policy over the paths under a prefix.
///
/// The option document of each kind: CORS `origins`, `methods`, `headers`,
/// `expose`, `credentials`, `maxAge`; security headers `fields`; request id
/// `header`, `trustIncoming`, `version`; trust proxy `cidrs` and `header`; body
/// limit `max`.
///
/// # Arguments
///
/// * `app` - the application id.
/// * `kind` - 0 CORS, 1 security headers, 2 request id, 3 trust proxy, 4 body limit.
/// * `prefix` - the path prefix, matched on a segment boundary; empty or `/` for
///   every path.
/// * `options` - the JSON option document.
///
/// # Errors
///
/// `ZERO_CODEC` for a malformed option document, `ZERO_INVALID_ARGUMENT` for an
/// unknown kind, a prefix that is not an absolute path, or a second trust-proxy
/// policy, `ZERO_UNSUPPORTED` when the policy capability is left out, and
/// `ZERO_CLOSED` for an unknown application.
#[napi(catch_unwind)]
pub fn app_policy(app: f64, kind: f64, prefix: String, options: String) -> napi::Result<(), Code> {
    node_guard(|| {
        let kind = PolicyKind::from_code(ids::u32_of(kind, "the policy kind")?)
            .ok_or_else(|| Fail::invalid("the policy kind is not 0 to 4"))?;
        with_app(app, |app| {
            app.policy(kind, &prefix, options.as_bytes())
                .map_err(Fail::from)
        })
    })
}

/// The application's canonical table: one line per route, sorted by pattern then
/// method, then the miss route, the policies and the mounts, so two isolates that
/// registered the same application produce the same bytes.
///
/// # Arguments
///
/// * `app` - the application id.
///
/// # Returns
///
/// The table as UTF-8 bytes.
///
/// # Errors
///
/// `ZERO_CLOSED` for an unknown application.
#[napi(catch_unwind)]
pub fn app_table(app: f64) -> napi::Result<Buffer, Code> {
    node_guard(|| with_app(app, |app| Ok(Buffer::from(app.table()))))
}
