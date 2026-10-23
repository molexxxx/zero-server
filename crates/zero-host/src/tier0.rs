//! The routes answered in Rust on the core, with no crossing: fixed responses,
//! redirects, health checks and static files.

use zero_core::Error;
use zero_http::{Call, Problem, Routed};
use zero_http_types::{HeaderName, StatusCode};

use crate::app::{RouteDesc, RouteSpec};
use crate::handler::CoreHost;

/// What a tier 0 route did with a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Served {
    /// The response is written.
    Written,
    /// A static route's root does not serve the path and the route falls through.
    Fallthrough,
}

/// Answer a request for a tier 0 route.
///
/// A redirect sets one of the statuses that take a `Location` and the field (RFC
/// 9110 Section 10.2.2); a static route answers GET and HEAD from its root, and a
/// path the root does not serve is a 404 in the server's error shape unless the
/// route falls through. A static route that falls through also passes on every other
/// method; one that does not answers it 405 with `Allow: GET, HEAD` in the server's
/// error shape, since "the origin server MUST generate an Allow header field in a 405
/// response" (Section 15.5.6). A request that falls through goes to the miss route
/// marked as the 404 the route would have answered.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.2>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.6>
pub(crate) fn serve(
    core: &CoreHost,
    call: &mut Call<'_>,
    routed: Routed<RouteDesc>,
) -> Result<Served, Error> {
    let settings = core.settings();
    let route = routed.descriptor.route;
    let Some(spec) = usize::try_from(route)
        .ok()
        .and_then(|index| settings.app.routes.get(index))
        .and_then(Option::as_ref)
    else {
        call.problem(&Problem::new(StatusCode::NOT_FOUND, "not_found"));
        return Ok(Served::Written);
    };
    match spec {
        RouteSpec::Fixed(fixed) => {
            let mut response = call.response();
            response.status(fixed.status);
            if let Some(content_type) = &fixed.content_type {
                response.header_id(HeaderName::ContentType, content_type)?;
            }
            response.body(&fixed.body);
        }
        RouteSpec::Redirect(redirect) => {
            call.response()
                .redirect(redirect.status, &redirect.location)?;
        }
        RouteSpec::Health(health) => {
            let mut response = call.response();
            response.status(health.status);
            if !health.body.is_empty() {
                response.header_id(HeaderName::ContentType, b"text/plain; charset=utf-8")?;
                response.body(&health.body);
            }
        }
        #[cfg(feature = "static")]
        RouteSpec::Static(files) => return serve_static(core, call, route, files),
        RouteSpec::Host(_) | RouteSpec::Miss => {
            call.problem(&Problem::new(StatusCode::NOT_FOUND, "not_found"));
        }
        #[cfg(feature = "realtime")]
        RouteSpec::WebSocket(_) => {
            call.problem(&Problem::new(StatusCode::NOT_FOUND, "not_found"));
        }
    }
    Ok(Served::Written)
}

/// Serve a static route from the core's `Files` for it: GET and HEAD from the root,
/// any other method passed on or answered 405.
#[cfg(feature = "static")]
fn serve_static(
    core: &CoreHost,
    call: &mut Call<'_>,
    route: u32,
    files: &crate::app::StaticRoute,
) -> Result<Served, Error> {
    use zero_http_types::Method;
    if !matches!(call.request().method(), Some(Method::Get | Method::Head)) {
        if files.spec.fallthrough {
            return Ok(fall_through(call));
        }
        call.problem(&Problem::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
        ));
        call.response().header_id(HeaderName::Allow, b"GET, HEAD")?;
        return Ok(Served::Written);
    }
    let Some(root) = core.files(route) else {
        return Ok(miss(call, files));
    };
    let path = match files.catch_all {
        Some(index) => call.request().param(index).unwrap_or(&[]).to_vec(),
        None => call.request().route_path().to_vec(),
    };
    match root.try_serve_path(call, &path)? {
        zero_static::Served::Written => Ok(Served::Written),
        zero_static::Served::Miss => Ok(miss(call, files)),
    }
}

/// A path the root does not serve: fall through, or 404 in the server's shape.
#[cfg(feature = "static")]
fn miss(call: &mut Call<'_>, files: &crate::app::StaticRoute) -> Served {
    if files.spec.fallthrough {
        return fall_through(call);
    }
    call.problem(&Problem::new(StatusCode::NOT_FOUND, "not_found"));
    Served::Written
}

/// Pass the request on to the miss route as the 404 the route would have answered,
/// so the host reads that status and no `Allow` set, as for a path no route matches.
#[cfg(feature = "static")]
fn fall_through(call: &mut Call<'_>) -> Served {
    call.mark_miss(zero_http::Miss {
        status: StatusCode::NOT_FOUND,
        allow: zero_router::Allow::default(),
    });
    Served::Fallthrough
}
