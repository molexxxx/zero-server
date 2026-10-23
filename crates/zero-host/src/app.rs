//! The application: routes, the miss route, policies and mounts, registered from
//! option documents, and the canonical table that tells two registrations apart.
//!
//! Route ids are dense and handed out in registration order; the miss route takes
//! one too. A mounted application's routes are renumbered after the routes already
//! registered, keeping their order, and its policies apply under the mount prefix.
//! The canonical table lists every route as its kind, method, pattern, id and
//! options, sorted by pattern then method, then the miss route, the policies in
//! registration order and the mounts, so two hosts that registered the same
//! application produce the same bytes.

use std::fmt::Write as _;

use zero_http_types::Method;
use zero_router::{RouteError, Router};

use crate::spec::{FixedSpec, HealthSpec, HostSpec, RedirectSpec};
use crate::HostError;

/// What a route does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RouteKind {
    /// The request is leased to the host.
    Host,
    /// Files from a root directory, served in Rust.
    Static,
    /// A redirect, answered in Rust.
    Redirect,
    /// A fixed response, answered in Rust.
    Fixed,
    /// A WebSocket upgrade, leased to the host.
    WebSocket,
    /// A health check, answered in Rust.
    Health,
    /// The route of requests no other route matched, leased to the host.
    Miss,
}

impl RouteKind {
    /// The kind a C ABI route code names: 0 host, 1 static, 2 redirect, 3 fixed,
    /// 4 WebSocket, 5 health.
    ///
    /// # Arguments
    ///
    /// * `code` - the code.
    ///
    /// # Returns
    ///
    /// The kind, or `None` for a code outside the set; the miss route has no code.
    #[must_use]
    pub const fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => Some(RouteKind::Host),
            1 => Some(RouteKind::Static),
            2 => Some(RouteKind::Redirect),
            3 => Some(RouteKind::Fixed),
            4 => Some(RouteKind::WebSocket),
            5 => Some(RouteKind::Health),
            _ => None,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            RouteKind::Host => "host",
            RouteKind::Static => "static",
            RouteKind::Redirect => "redirect",
            RouteKind::Fixed => "fixed",
            RouteKind::WebSocket => "websocket",
            RouteKind::Health => "health",
            RouteKind::Miss => "miss",
        }
    }
}

/// What a policy does.
///
/// A policy covers the paths under its prefix. Where policies of one kind cover a
/// path, the one with the longest prefix wins, then the later registration: one CORS
/// rule and one request-id rule decide each request, and every security-headers
/// policy that covers it adds its fields, the more specific one's value replacing the
/// other's for a field both set. A trust-proxy policy covers every path, and an
/// application has at most one. The CORS, security-headers and request-id fields reach
/// every response a route, the core or a host writes, a preflight answered in Rust
/// included. The answers the HTTP/1.1 driver writes itself, without a handler, carry
/// none of them: a malformed request, `408` for a request that timed out, `417`, the
/// `413` for content past a body limit, and the `503` for a request past its total
/// time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PolicyKind {
    /// CORS: preflights answered in Rust and the sharing fields on responses.
    Cors,
    /// Fixed security header fields on every response.
    SecurityHeaders,
    /// A request id field on every response.
    RequestId,
    /// The peers whose forwarding fields name the client and its scheme, and the one
    /// family of those fields they write.
    TrustProxy,
    /// The largest request body under a prefix.
    BodyLimit,
}

impl PolicyKind {
    /// The kind a C ABI policy code names: 0 CORS, 1 security headers, 2 request id,
    /// 3 trust proxy, 4 body limit.
    ///
    /// # Arguments
    ///
    /// * `code` - the code.
    ///
    /// # Returns
    ///
    /// The kind, or `None` for a code outside the set.
    #[must_use]
    pub const fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => Some(PolicyKind::Cors),
            1 => Some(PolicyKind::SecurityHeaders),
            2 => Some(PolicyKind::RequestId),
            3 => Some(PolicyKind::TrustProxy),
            4 => Some(PolicyKind::BodyLimit),
            _ => None,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            PolicyKind::Cors => "cors",
            PolicyKind::SecurityHeaders => "security-headers",
            PolicyKind::RequestId => "request-id",
            PolicyKind::TrustProxy => "trust-proxy",
            PolicyKind::BodyLimit => "body-limit",
        }
    }
}

/// What the router hands back for a match: the route id and its kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RouteDesc {
    pub(crate) route: u32,
    pub(crate) kind: RouteKind,
}

/// A static route's options and the parameter that names the file.
#[cfg(feature = "static")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StaticRoute {
    pub(crate) spec: crate::spec::StaticSpec,
    /// The index of the pattern's trailing catch-all, whose value is the file path;
    /// `None` serves the request path itself.
    pub(crate) catch_all: Option<usize>,
}

/// A route's parsed options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RouteSpec {
    Host(HostSpec),
    #[cfg(feature = "static")]
    Static(StaticRoute),
    Redirect(RedirectSpec),
    Fixed(FixedSpec),
    #[cfg(feature = "realtime")]
    WebSocket(crate::spec::WebSocketSpec),
    Health(HealthSpec),
    Miss,
}

/// A policy's parsed options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PolicySpec {
    #[cfg(feature = "policy")]
    Cors(zero_policy::Cors),
    #[cfg(feature = "policy")]
    SecurityHeaders(crate::spec::Fields),
    #[cfg(feature = "policy")]
    RequestId(crate::spec::RequestIdSpec),
    #[cfg(feature = "policy")]
    TrustProxy(zero_policy::TrustProxy),
    #[cfg(feature = "policy")]
    BodyLimit(u64),
}

#[derive(Clone, Debug)]
struct RouteEntry {
    id: u32,
    kind: RouteKind,
    method: Option<Method>,
    pattern: String,
    spec: RouteSpec,
}

/// A policy and the path prefix it covers.
#[derive(Clone, Debug)]
pub(crate) struct PolicyEntry {
    pub(crate) kind: PolicyKind,
    pub(crate) prefix: String,
    pub(crate) spec: PolicySpec,
}

#[derive(Clone, Debug)]
struct MountEntry {
    prefix: String,
    base: u32,
    app: App,
}

/// The routes and policies of an application, before a server serves them.
#[derive(Clone, Debug, Default)]
pub struct App {
    routes: Vec<RouteEntry>,
    policies: Vec<PolicyEntry>,
    mounts: Vec<MountEntry>,
    miss: Option<u32>,
    next: u32,
    router: Router<RouteDesc>,
}

/// An application frozen for a server: the router, every route's options by id, the
/// miss route, the policies and the canonical table.
#[derive(Debug)]
pub(crate) struct Built {
    pub(crate) router: Router<RouteDesc>,
    pub(crate) routes: Vec<Option<RouteSpec>>,
    pub(crate) miss: Option<RouteDesc>,
    pub(crate) policies: Vec<PolicyEntry>,
    pub(crate) table: Vec<u8>,
}

impl App {
    /// An application with no route.
    ///
    /// # Returns
    ///
    /// The application.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a route.
    ///
    /// The option document of each kind: host `maxBody`; static `root`, `index` (a
    /// name or false), `maxAgeMs`, `dotfiles` (`ignore`, `deny`, `allow`),
    /// `extensions`, `fallthrough`, `etag`, `ranges`; redirect `status` (301, 302,
    /// 303, 307, 308) and `location`, a URI reference; fixed `status`,
    /// `contentType`, and `body` or `bodyBase64`; WebSocket `protocols`, `origins`,
    /// `maxPayload`, `pingIntervalMs`; health `status` and `body`. The body of a
    /// fixed or health route is empty for status 204, 205 and 304, which carry no
    /// content. A static route whose pattern ends in a catch-all serves the file the
    /// catch-all names, any other the request path. It serves GET and HEAD; with
    /// `fallthrough` (the default) it hands a path its root does not serve, and any
    /// other method, to the miss route as a 404, and without it answers them 404 and
    /// 405 in the server's error shape.
    ///
    /// # Arguments
    ///
    /// * `kind` - what the route does; not [`RouteKind::Miss`], which
    ///   [`miss`](Self::miss) registers.
    /// * `method` - the method, or `None` for every method.
    /// * `pattern` - the path pattern: `/` then static segments, `:name` parameters
    ///   and at most one final `*` or `*name` catch-all.
    /// * `options` - the UTF-8 JSON option document; empty for the defaults.
    ///
    /// # Returns
    ///
    /// The route id, the next in registration order.
    ///
    /// # Errors
    ///
    /// [`Status::Codec`](crate::Status::Codec) for a malformed option document,
    /// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a pattern
    /// outside the syntax, a route already registered for the method and pattern,
    /// or the miss kind, [`Status::Io`](crate::Status::Io) for a static root that
    /// cannot be opened, and [`Status::Unsupported`](crate::Status::Unsupported) for
    /// a kind whose capability is compiled out.
    pub fn route(
        &mut self,
        kind: RouteKind,
        method: Option<Method>,
        pattern: &str,
        options: &[u8],
    ) -> Result<u32, HostError> {
        let spec = match kind {
            RouteKind::Host => RouteSpec::Host(HostSpec::parse(options)?),
            RouteKind::Static => static_spec(pattern, options)?,
            RouteKind::Redirect => RouteSpec::Redirect(RedirectSpec::parse(options)?),
            RouteKind::Fixed => RouteSpec::Fixed(FixedSpec::parse(options)?),
            RouteKind::WebSocket => websocket_spec(options)?,
            RouteKind::Health => RouteSpec::Health(HealthSpec::parse(options)?),
            RouteKind::Miss => {
                return Err(HostError::invalid(
                    "the miss route is registered with App::miss",
                ))
            }
        };
        let id = self.next;
        let entry = RouteEntry {
            id,
            kind,
            method,
            pattern: pattern.to_owned(),
            spec,
        };
        let mut router = self.router.clone();
        add(&mut router, &entry).map_err(|err| route_error(pattern, err))?;
        self.router = router;
        self.routes.push(entry);
        self.next = id.saturating_add(1);
        Ok(id)
    }

    /// Register the miss route: requests no route matches go to the host under its
    /// id, carrying the status (404, 405, 501, or 200 for OPTIONS) and the `Allow`
    /// set the core would have answered.
    ///
    /// # Returns
    ///
    /// The miss route's id; the same id when it is registered again.
    pub fn miss(&mut self) -> u32 {
        if let Some(id) = self.miss {
            return id;
        }
        let id = self.next;
        self.miss = Some(id);
        self.next = id.saturating_add(1);
        id
    }

    /// Mount another application under a prefix: its routes are matched under the
    /// prefix before this application's catch-all routes, and its policies apply
    /// under it. A trust-proxy policy covers every path, so a mounted application
    /// cannot carry one.
    ///
    /// # Arguments
    ///
    /// * `prefix` - `/` and static segments; not the root.
    /// * `child` - the application to mount; it must have no miss route and no
    ///   trust-proxy policy.
    ///
    /// # Returns
    ///
    /// The id the child's first route has now: every child route id grew by this
    /// much, in the child's order.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a prefix
    /// outside the syntax or the root, or a child with a miss route or a trust-proxy
    /// policy; this application is unchanged then.
    pub fn mount(&mut self, prefix: &str, mut child: App) -> Result<u32, HostError> {
        if child.miss.is_some() {
            return Err(HostError::invalid(
                "a mounted application cannot have a miss route",
            ));
        }
        if child.has_trust_proxy() {
            return Err(HostError::invalid(
                "a mounted application cannot have a trust-proxy policy, which covers every path",
            ));
        }
        let base = self.next;
        child.shift(base).map_err(|err| route_error(prefix, err))?;
        let mut router = self.router.clone();
        router
            .mount(prefix, child.router.clone())
            .map_err(|err| route_error(prefix, err))?;
        let trimmed = prefix.trim_end_matches('/');
        for mut policy in std::mem::take(&mut child.policies) {
            policy.prefix = if policy.prefix == "/" {
                trimmed.to_owned()
            } else {
                format!("{trimmed}{}", policy.prefix)
            };
            self.policies.push(policy);
        }
        self.router = router;
        self.next = base.saturating_add(child.next);
        self.mounts.push(MountEntry {
            prefix: prefix.to_owned(),
            base,
            app: child,
        });
        Ok(base)
    }

    /// Register a policy over the paths under a prefix.
    ///
    /// The option document of each kind: CORS `origins` (`"*"` or an array of
    /// origins and `.suffix` entries), `methods`, `headers`, `expose`,
    /// `credentials` (with an array of `origins` only), `maxAge`; security headers
    /// `fields`, an array of `[name, value]` pairs, of which
    /// `Strict-Transport-Security` goes only on responses to a client on a secure
    /// transport; request id `header`, `trustIncoming`, `version` (4 or 7); trust
    /// proxy `cidrs` and `header`, the one family of forwarding fields the trusted
    /// proxies write and the only one read (`"x-forwarded-for"`, the default, for
    /// `X-Forwarded-For` and `X-Forwarded-Proto`, or `"forwarded"` for `Forwarded`);
    /// body limit `max`. Where policies of one kind overlap, the longest prefix wins,
    /// then the later registration ([`PolicyKind`]).
    ///
    /// # Arguments
    ///
    /// * `kind` - the policy.
    /// * `prefix` - the path prefix, matched on a segment boundary; empty or `/`
    ///   for every path. A trust-proxy policy covers every path.
    /// * `options` - the UTF-8 JSON option document.
    ///
    /// # Errors
    ///
    /// [`Status::Codec`](crate::Status::Codec) for a malformed option document,
    /// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for a prefix that
    /// is not an absolute path, a trust-proxy prefix other than the root, or a
    /// second trust-proxy policy, and
    /// [`Status::Unsupported`](crate::Status::Unsupported) when the `policy`
    /// capability is compiled out.
    pub fn policy(
        &mut self,
        kind: PolicyKind,
        prefix: &str,
        options: &[u8],
    ) -> Result<(), HostError> {
        let prefix = normal_prefix(prefix)?;
        let spec = policy_spec(kind, &prefix, options)?;
        if kind == PolicyKind::TrustProxy && self.has_trust_proxy() {
            return Err(HostError::invalid(
                "an application has one trust-proxy policy, which covers every path",
            ));
        }
        self.policies.push(PolicyEntry { kind, prefix, spec });
        Ok(())
    }

    /// Whether this application or one it mounted has a trust-proxy policy.
    fn has_trust_proxy(&self) -> bool {
        self.policies
            .iter()
            .any(|policy| policy.kind == PolicyKind::TrustProxy)
    }

    /// How many ids the application has handed out, the miss route included.
    ///
    /// # Returns
    ///
    /// The count; the next route registered gets this id.
    #[must_use]
    pub const fn route_count(&self) -> u32 {
        self.next
    }

    /// The canonical table: one line per route (kind, method, pattern, id and the
    /// parsed options), sorted by pattern then method, then the miss route, the
    /// policies in registration order, and each mount with its child's table
    /// indented beneath it.
    ///
    /// # Returns
    ///
    /// The table as UTF-8 bytes.
    #[must_use]
    pub fn table(&self) -> Vec<u8> {
        let mut out = String::new();
        self.write_table(&mut out, "");
        out.into_bytes()
    }

    fn write_table(&self, out: &mut String, indent: &str) {
        let mut routes: Vec<&RouteEntry> = self.routes.iter().collect();
        routes.sort_by(|a, b| {
            normal_pattern(&a.pattern)
                .cmp(normal_pattern(&b.pattern))
                .then_with(|| method_name(a.method).cmp(method_name(b.method)))
        });
        for entry in routes {
            let _ = writeln!(
                out,
                "{indent}route {} {} {} {} {:?}",
                entry.kind.name(),
                method_name(entry.method),
                normal_pattern(&entry.pattern),
                entry.id,
                entry.spec
            );
        }
        if let Some(id) = self.miss {
            let _ = writeln!(out, "{indent}miss {id}");
        }
        for policy in &self.policies {
            let _ = writeln!(
                out,
                "{indent}policy {} {} {:?}",
                policy.kind.name(),
                policy.prefix,
                policy.spec
            );
        }
        for mount in &self.mounts {
            let _ = writeln!(out, "{indent}mount {} {}", mount.prefix, mount.base);
            mount.app.write_table(out, &format!("{indent}  "));
        }
    }

    /// Renumber every route of this application and its mounts by `base`.
    fn shift(&mut self, base: u32) -> Result<(), RouteError> {
        for entry in &mut self.routes {
            entry.id = entry.id.saturating_add(base);
        }
        for mount in &mut self.mounts {
            mount.base = mount.base.saturating_add(base);
            mount.app.shift(base)?;
        }
        let mut router = Router::new();
        for entry in &self.routes {
            add(&mut router, entry)?;
        }
        for mount in &self.mounts {
            router.mount(&mount.prefix, mount.app.router.clone())?;
        }
        self.router = router;
        Ok(())
    }

    /// Every route's options by id, this application's and its mounts'.
    fn collect(&self, into: &mut Vec<Option<RouteSpec>>) {
        for entry in &self.routes {
            let Ok(index) = usize::try_from(entry.id) else {
                continue;
            };
            if into.len() <= index {
                into.resize(index.saturating_add(1), None);
            }
            if let Some(slot) = into.get_mut(index) {
                *slot = Some(entry.spec.clone());
            }
        }
        for mount in &self.mounts {
            mount.app.collect(into);
        }
    }

    /// Freeze the application for a server.
    pub(crate) fn build(&self) -> Built {
        let mut routes = Vec::new();
        self.collect(&mut routes);
        let miss = self.miss.map(|route| {
            if let Ok(index) = usize::try_from(route) {
                if routes.len() <= index {
                    routes.resize(index.saturating_add(1), None);
                }
                if let Some(slot) = routes.get_mut(index) {
                    *slot = Some(RouteSpec::Miss);
                }
            }
            RouteDesc {
                route,
                kind: RouteKind::Miss,
            }
        });
        Built {
            router: self.router.clone(),
            routes,
            miss,
            policies: self.policies.clone(),
            table: self.table(),
        }
    }
}

/// Register `entry` on `router`, for every method when it names none.
fn add(router: &mut Router<RouteDesc>, entry: &RouteEntry) -> Result<(), RouteError> {
    let descriptor = RouteDesc {
        route: entry.id,
        kind: entry.kind,
    };
    match entry.method {
        Some(method) => router.route(method, &entry.pattern, descriptor),
        None => Method::ALL
            .iter()
            .try_for_each(|&method| router.route(method, &entry.pattern, descriptor)),
    }
}

fn route_error(pattern: &str, err: RouteError) -> HostError {
    HostError::invalid(format!("the route {pattern:?} is refused: {err}"))
}

fn method_name(method: Option<Method>) -> &'static str {
    method.map_or("ANY", Method::as_str)
}

/// A pattern as the router matches it: without a trailing `/` past the root.
fn normal_pattern(pattern: &str) -> &str {
    match pattern.strip_suffix('/') {
        Some(stripped) if !stripped.is_empty() => stripped,
        _ => pattern,
    }
}

/// A policy prefix: `/` for empty, otherwise an absolute path without a trailing
/// `/` or a query.
fn normal_prefix(prefix: &str) -> Result<String, HostError> {
    if prefix.is_empty() || prefix == "/" {
        return Ok("/".to_owned());
    }
    if !prefix.starts_with('/') || prefix.contains('?') {
        return Err(HostError::invalid(format!(
            "the policy prefix {prefix:?} is not an absolute path"
        )));
    }
    Ok(normal_pattern(prefix).to_owned())
}

#[cfg(feature = "static")]
fn static_spec(pattern: &str, options: &[u8]) -> Result<RouteSpec, HostError> {
    let spec = crate::spec::StaticSpec::parse(options)?;
    zero_static::Files::new(&spec.root, spec.options.clone()).map_err(|err| {
        HostError::io(format!(
            "the static root {} cannot be served: {err}",
            spec.root.display()
        ))
    })?;
    let segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let params = segments
        .iter()
        .filter(|segment| segment.starts_with(':') || segment.starts_with('*'))
        .count();
    let catch_all = segments
        .last()
        .filter(|segment| segment.starts_with('*'))
        .map(|_| params.saturating_sub(1));
    Ok(RouteSpec::Static(StaticRoute { spec, catch_all }))
}

#[cfg(not(feature = "static"))]
fn static_spec(_pattern: &str, _options: &[u8]) -> Result<RouteSpec, HostError> {
    Err(HostError::unsupported(
        "static routes need the `static` capability, which this build leaves out",
    ))
}

#[cfg(feature = "realtime")]
fn websocket_spec(options: &[u8]) -> Result<RouteSpec, HostError> {
    Ok(RouteSpec::WebSocket(crate::spec::WebSocketSpec::parse(
        options,
    )?))
}

#[cfg(not(feature = "realtime"))]
fn websocket_spec(_options: &[u8]) -> Result<RouteSpec, HostError> {
    Err(HostError::unsupported(
        "WebSocket routes need the `realtime` capability, which this build leaves out",
    ))
}

#[cfg(feature = "policy")]
fn policy_spec(kind: PolicyKind, prefix: &str, options: &[u8]) -> Result<PolicySpec, HostError> {
    use crate::spec;
    Ok(match kind {
        PolicyKind::Cors => PolicySpec::Cors(spec::cors(options)?),
        PolicyKind::SecurityHeaders => {
            PolicySpec::SecurityHeaders(spec::security_headers(options)?)
        }
        PolicyKind::RequestId => PolicySpec::RequestId(spec::RequestIdSpec::parse(options)?),
        PolicyKind::TrustProxy => {
            if prefix != "/" {
                return Err(HostError::invalid(
                    "a trust-proxy policy covers every path; its prefix must be empty or /",
                ));
            }
            PolicySpec::TrustProxy(spec::trust_proxy(options)?)
        }
        PolicyKind::BodyLimit => {
            let max = spec::body_limit(options)?;
            zero_policy::BodyLimits::new(0)
                .route(prefix, max)
                .map_err(|err| HostError::invalid(err.to_string()))?;
            PolicySpec::BodyLimit(max)
        }
    })
}

#[cfg(not(feature = "policy"))]
fn policy_spec(kind: PolicyKind, _prefix: &str, _options: &[u8]) -> Result<PolicySpec, HostError> {
    Err(HostError::unsupported(format!(
        "the {} policy needs the `policy` capability, which this build leaves out",
        kind.name()
    )))
}

#[cfg(test)]
mod tests {
    use super::{App, RouteKind};
    use crate::{Method, Status};

    #[test]
    fn route_ids_are_dense_in_registration_order_and_a_mount_renumbers_its_routes() {
        let mut app = App::new();
        assert_eq!(
            app.route(RouteKind::Host, Some(Method::Get), "/a", b"")
                .unwrap(),
            0
        );
        assert_eq!(app.miss(), 1);
        assert_eq!(app.miss(), 1);
        let mut child = App::new();
        child
            .route(RouteKind::Host, Some(Method::Get), "/x", b"")
            .unwrap();
        child
            .route(RouteKind::Host, Some(Method::Post), "/x", b"")
            .unwrap();
        assert_eq!(app.mount("/api", child).unwrap(), 2);
        assert_eq!(app.route(RouteKind::Host, None, "/b", b"").unwrap(), 4);
        assert_eq!(app.route_count(), 5);
        let built = app.build();
        assert_eq!(built.routes.len(), 5);
        assert!(built.routes.iter().all(Option::is_some));
        let table = String::from_utf8(app.table()).unwrap();
        assert!(
            table.contains("mount /api 2\n  route host GET /x 2"),
            "{table}"
        );
        assert!(table.contains("route host ANY /b 4"), "{table}");
        assert!(table.contains("miss 1"), "{table}");
    }

    #[test]
    fn a_duplicate_route_is_refused_and_leaves_the_table_unchanged() {
        let mut app = App::new();
        app.route(RouteKind::Host, Some(Method::Put), "/a", b"")
            .unwrap();
        let before = app.table();
        let refused = app.route(RouteKind::Host, None, "/a", b"").unwrap_err();
        assert_eq!(refused.status(), Status::InvalidArgument);
        assert_eq!(app.table(), before);
        assert_eq!(
            app.route(RouteKind::Host, Some(Method::Get), "/a", b"")
                .unwrap(),
            1
        );
        assert_eq!(
            app.route(RouteKind::Miss, None, "/m", b"")
                .unwrap_err()
                .status(),
            Status::InvalidArgument
        );
    }

    #[test]
    fn the_same_registration_gives_the_same_table_and_another_route_changes_it() {
        let mut first = App::new();
        let mut second = App::new();
        first
            .route(
                RouteKind::Fixed,
                Some(Method::Get),
                "/b",
                br#"{"body":"b"}"#,
            )
            .unwrap();
        second
            .route(
                RouteKind::Fixed,
                Some(Method::Get),
                "/b",
                br#"{"body":"b"}"#,
            )
            .unwrap();
        assert_eq!(first.table(), second.table());
        second
            .route(
                RouteKind::Fixed,
                Some(Method::Get),
                "/a",
                br#"{"body":"a"}"#,
            )
            .unwrap();
        assert_ne!(first.table(), second.table());
    }
}
