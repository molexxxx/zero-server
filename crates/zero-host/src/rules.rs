//! The policies evaluated in Rust around every request: the CORS preflight before
//! routing, answered with the security header fields and the request id, and after
//! the response is written (by a tier 0 route, by the core, or by the host and
//! imported) the CORS sharing fields, the security header fields and the request id.
//! A tier 3 response gets them inside the import, against the request still frozen in
//! the exchange.
//!
//! A policy covers the paths under its prefix on a segment boundary, matched against
//! the normalized path a route matched, or the path as received when no route ran.
//! Each kind's rules are kept in order of prefix length, registration order within a
//! length, so the covering rule with the longest prefix, the later registration on a
//! tie, is the last one that covers the path, and the security header fields of every
//! covering policy are set from the least specific policy to the most.

#[cfg(feature = "policy")]
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
#[cfg(feature = "policy")]
use std::sync::Arc;

use zero_http::{Call, Request, Response};
#[cfg(feature = "policy")]
use zero_policy::TrustProxy;

use crate::app::PolicyEntry;

/// The field a security-headers policy sends only over a secure transport.
#[cfg(feature = "policy")]
const STRICT_TRANSPORT_SECURITY: &[u8] = b"strict-transport-security";

/// Whether a rule answered the request itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Answered {
    Yes,
    No,
}

/// The policies of one server, grouped by kind, each kind in order of prefix length
/// and then of registration.
#[derive(Debug, Default)]
pub(crate) struct Rules {
    #[cfg(feature = "policy")]
    cors: Vec<(String, zero_policy::Cors)>,
    #[cfg(feature = "policy")]
    security: Vec<(String, crate::spec::Fields)>,
    #[cfg(feature = "policy")]
    request_ids: Vec<(String, crate::spec::RequestIdSpec)>,
    #[cfg(feature = "policy")]
    body_limits: Option<zero_policy::BodyLimits>,
    #[cfg(feature = "policy")]
    trust: Option<Arc<TrustProxy>>,
}

/// The path of a target without its query.
#[cfg(feature = "policy")]
fn path_of(target: &[u8]) -> &[u8] {
    match target.iter().position(|&byte| byte == b'?') {
        Some(end) => target.get(..end).unwrap_or(target),
        None => target,
    }
}

/// Whether `prefix` covers `path` on a segment boundary.
#[cfg(feature = "policy")]
fn covers(prefix: &str, path: &[u8]) -> bool {
    let prefix = prefix.as_bytes();
    if prefix == b"/" {
        return true;
    }
    match path.strip_prefix(prefix) {
        Some(rest) => rest.is_empty() || rest.first() == Some(&b'/'),
        None => false,
    }
}

/// The rule of the longest prefix that covers `path`, the later registration on a
/// tie: the last covering one, since each kind is kept in order of prefix length.
#[cfg(feature = "policy")]
fn covering<'a, T>(rules: &'a [(String, T)], path: &[u8]) -> Option<&'a T> {
    rules
        .iter()
        .rev()
        .find(|(prefix, _)| covers(prefix, path))
        .map(|(_, rule)| rule)
}

/// The path a policy is matched against: the route's normalized path when a route
/// ran, the path as received otherwise.
#[cfg(feature = "policy")]
fn matched_path<'a>(request: &Request<'a>) -> &'a [u8] {
    let routed = request.route_path();
    if routed.is_empty() {
        path_of(request.path())
    } else {
        routed
    }
}

impl Rules {
    /// The rules of `policies`; `max_body` is the limit of a path no body-limit
    /// policy covers.
    #[cfg_attr(not(feature = "policy"), allow(unused_variables))]
    pub(crate) fn new(policies: &[PolicyEntry], max_body: u64) -> Self {
        #[cfg(feature = "policy")]
        {
            use crate::app::PolicySpec;
            let mut rules = Rules::default();
            let mut limits: Option<zero_policy::BodyLimits> = None;
            for entry in policies {
                let prefix = entry.prefix.clone();
                match &entry.spec {
                    PolicySpec::Cors(cors) => rules.cors.push((prefix, cors.clone())),
                    PolicySpec::SecurityHeaders(fields) => {
                        rules.security.push((prefix, fields.clone()));
                    }
                    PolicySpec::RequestId(spec) => rules.request_ids.push((prefix, spec.clone())),
                    PolicySpec::TrustProxy(rule) => rules.trust = Some(Arc::new(rule.clone())),
                    PolicySpec::BodyLimit(max) => {
                        let table = limits
                            .take()
                            .unwrap_or_else(|| zero_policy::BodyLimits::new(max_body));
                        limits = match table.clone().route(&prefix, *max) {
                            Ok(next) => Some(next),
                            Err(_) => Some(table),
                        };
                    }
                }
            }
            rules.cors.sort_by_key(|(prefix, _)| prefix.len());
            rules.security.sort_by_key(|(prefix, _)| prefix.len());
            rules.request_ids.sort_by_key(|(prefix, _)| prefix.len());
            rules.body_limits = limits;
            rules
        }
        #[cfg(not(feature = "policy"))]
        Rules::default()
    }

    /// The trust-proxy rule as the exchange's client rule: the client the request's
    /// trusted proxies name, which zero-policy finds by walking the forwarding chain
    /// of the policy's header family from the right; the peer itself when it is not a
    /// trusted proxy; and the unspecified address of the peer's family when a trusted
    /// proxy's report names no address, so a client the proxies do not name never
    /// takes a proxy's address and no rule keyed on a real address applies to it.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1>
    pub(crate) fn client_rule(&self) -> Option<zero_http::exchange::ClientRule> {
        #[cfg(feature = "policy")]
        {
            let trust = Arc::clone(self.trust.as_ref()?);
            Some(Arc::new(move |request: &Request<'_>| {
                let peer = request.peer()?;
                Some(match trust.forwarding(peer, request.headers()).client {
                    Some(client) if client == peer.ip() => peer,
                    Some(client) => SocketAddr::new(client, 0),
                    None => SocketAddr::new(unspecified(peer.ip()), 0),
                })
            }))
        }
        #[cfg(not(feature = "policy"))]
        None
    }

    /// Answer a CORS preflight in Rust: `204` with the rule's fields, or `403` with
    /// no content for a preflight the rule refuses, since a preflight's success is an
    /// ok status, 200 to 299. Either answer carries the security header fields and
    /// the request id of the policies that cover the path, as every other answer
    /// does.
    ///
    /// @see <https://fetch.spec.whatwg.org/#statuses>
    /// @see <https://fetch.spec.whatwg.org/#http-responses>
    #[cfg_attr(not(feature = "policy"), allow(unused_variables))]
    pub(crate) fn before(&self, call: &mut Call<'_>) -> Answered {
        #[cfg(feature = "policy")]
        {
            use zero_http_types::StatusCode;
            use zero_policy::Decision;
            let decision = {
                let request = call.request();
                let Some(origin) = request.header(b"origin") else {
                    return Answered::No;
                };
                let Some(cors) = covering(&self.cors, path_of(request.path())) else {
                    return Answered::No;
                };
                cors.decide(
                    request.method(),
                    Some(origin),
                    request.header(b"access-control-request-method"),
                    request.header(b"access-control-request-headers"),
                )
            };
            let (request, mut response) = call.parts();
            match decision {
                Decision::Preflight(fields) => {
                    response.status(StatusCode::NO_CONTENT);
                    write_fields(&mut response, fields);
                }
                Decision::Refused { preflight: true } => {
                    response.status(StatusCode::FORBIDDEN);
                }
                Decision::Refused { preflight: false }
                | Decision::NotCors
                | Decision::Allowed(_) => return Answered::No,
            }
            let path = path_of(request.path());
            self.security_fields(&request, &mut response, path);
            self.request_id_field(&request, &mut response, path);
            Answered::Yes
        }
        #[cfg(not(feature = "policy"))]
        Answered::No
    }

    /// Add the fields of the policies that cover the request to the call's response.
    pub(crate) fn after(&self, call: &mut Call<'_>) {
        let (request, mut response) = call.parts();
        self.after_with(request, &mut response);
    }

    /// Add the fields of the policies that cover `request` to `response`: the CORS
    /// sharing fields, the security header fields and the request id, each replacing
    /// the lines of its name the response already held.
    #[cfg_attr(not(feature = "policy"), allow(unused_variables))]
    pub(crate) fn after_with(&self, request: Request<'_>, response: &mut Response<'_>) {
        #[cfg(feature = "policy")]
        {
            let path = matched_path(&request);
            self.cors_fields(&request, response, path);
            self.security_fields(&request, response, path);
            self.request_id_field(&request, response, path);
        }
    }

    /// Add the CORS sharing fields of the rule that covers `path`.
    ///
    /// A field the rule's decision names replaces the lines of its name a host wrote,
    /// since a browser reads `Access-Control-Allow-Origin` as every line of it
    /// combined, and a combined value never equals the request's origin (Fetch, CORS
    /// check); `Vary` is a list, so `Origin` is added to it instead. A response whose
    /// sharing depends on `Origin` names it in `Vary` whether or not it is shared, and
    /// a `*` rule sends `Access-Control-Allow-Origin: *` on responses to requests
    /// without `Origin` too, so a cache never hands a CORS request a response it
    /// stored for another request (Fetch, CORS protocol and HTTP caches; RFC 9110
    /// Section 12.5.5).
    ///
    /// @see <https://fetch.spec.whatwg.org/#cors-check>
    /// @see <https://fetch.spec.whatwg.org/#cors-protocol-and-http-caches>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.5>
    #[cfg(feature = "policy")]
    fn cors_fields(&self, request: &Request<'_>, response: &mut Response<'_>, path: &[u8]) {
        use zero_policy::{AllowOrigin, Decision};
        let Some(cors) = covering(&self.cors, path) else {
            return;
        };
        let Some(origin) = request.header(b"origin") else {
            let _ = if matches!(cors.allow_origin, AllowOrigin::Any) && !cors.credentials {
                response.set_header(b"Access-Control-Allow-Origin", b"*")
            } else {
                response.header(b"Vary", b"Origin")
            };
            return;
        };
        match cors.decide(request.method(), Some(origin), None, None) {
            Decision::Allowed(fields) => write_fields(response, fields),
            Decision::Refused { .. } | Decision::NotCors | Decision::Preflight(_) => {
                let _ = response.header(b"Vary", b"Origin");
            }
        }
    }

    /// Set the fields of every security-headers policy that covers `path`, from the
    /// least specific policy to the most, each replacing the lines of its name.
    ///
    /// `Strict-Transport-Security` is left out unless the client reached the server
    /// over a secure transport, since "An HSTS Host MUST NOT include the STS header
    /// field in HTTP responses conveyed over non-secure transport" (RFC 6797 Section
    /// 7.2); when it is set it replaces every line of its name, so the response
    /// carries the one field a user agent processes (Section 8.1).
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc6797.html#section-7.2>
    /// @see <https://www.rfc-editor.org/rfc/rfc6797.html#section-8.1>
    #[cfg(feature = "policy")]
    fn security_fields(&self, request: &Request<'_>, response: &mut Response<'_>, path: &[u8]) {
        let mut secure = None;
        for (_, fields) in self
            .security
            .iter()
            .filter(|(prefix, _)| covers(prefix, path))
        {
            for (name, value) in fields {
                if name.eq_ignore_ascii_case(STRICT_TRANSPORT_SECURITY)
                    && !*secure.get_or_insert_with(|| self.secure(request))
                {
                    continue;
                }
                let _ = response.set_header(name, value);
            }
        }
    }

    /// Set the request id of the rule that covers `path`.
    #[cfg(feature = "policy")]
    fn request_id_field(&self, request: &Request<'_>, response: &mut Response<'_>, path: &[u8]) {
        if let Some(spec) = covering(&self.request_ids, path) {
            request_id(spec, request, response);
        }
    }

    /// Whether the client reached the server over a secure transport: the scheme the
    /// trusted proxies in front of the request report, when the peer is one of them
    /// and they report one in the policy's header family (the `proto` of the
    /// `Forwarded` element that names the client, which "has the value of the used
    /// protocol type", RFC 7239 Section 5.4, or the `X-Forwarded-Proto` member the
    /// proxy facing the client added), and the connection's own security otherwise.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-5.4>
    #[cfg(feature = "policy")]
    fn secure(&self, request: &Request<'_>) -> bool {
        let reported = self
            .trust
            .as_deref()
            .zip(request.peer())
            .and_then(|(trust, peer)| trust.forwarding(peer, request.headers()).proto);
        reported.map_or_else(|| request.is_secure(), |proto| proto == b"https")
    }

    /// The body limit of the longest body-limit prefix that covers `target`, when
    /// the application has a body-limit policy.
    #[cfg_attr(not(feature = "policy"), allow(unused_variables))]
    pub(crate) fn body_limit(&self, target: &[u8]) -> Option<u64> {
        #[cfg(feature = "policy")]
        {
            self.body_limits.as_ref().map(|limits| limits.limit(target))
        }
        #[cfg(not(feature = "policy"))]
        None
    }
}

/// Write the fields of a CORS decision: `Vary` is a list, so `Origin` is added to it,
/// and every other field replaces the lines of its name.
#[cfg(feature = "policy")]
fn write_fields(response: &mut Response<'_>, fields: Vec<zero_policy::cors::Field>) {
    for (name, value) in fields {
        let _ = if name.eq_ignore_ascii_case(b"vary") {
            response.header(name, &value)
        } else {
            response.set_header(name, &value)
        };
    }
}

/// The unspecified address of `address`'s family: `0.0.0.0` or `::`.
#[cfg(feature = "policy")]
fn unspecified(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    }
}

/// Set the request id field: an incoming id the rule trusts and accepts, else a new
/// UUID in the rule's version, drawn by `zero-policy`.
#[cfg(feature = "policy")]
fn request_id(
    spec: &crate::spec::RequestIdSpec,
    request: &Request<'_>,
    response: &mut Response<'_>,
) {
    use zero_policy::request_id::{format, is_acceptable};
    let incoming = request
        .header(&spec.header)
        .filter(|value| spec.trust_incoming && is_acceptable(value));
    if let Some(value) = incoming {
        let _ = response.set_header(&spec.header, value);
        return;
    }
    if let Some(octets) = generate(spec.version) {
        let _ = response.set_header(&spec.header, &format(&octets));
    }
}

/// A new UUID in `version`, 4 or 7, from the system random generator.
#[cfg(feature = "policy")]
fn generate(version: u8) -> Option<[u8; 16]> {
    use zero_policy::request_id::{uuid_v4, uuid_v7};
    let rng = zero_server_crypto::SystemRng;
    if version == 4 {
        return uuid_v4(&rng).ok();
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        });
    uuid_v7(&rng, now).ok()
}

#[cfg(all(test, feature = "policy"))]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::{covering, covers, path_of, unspecified};

    #[test]
    fn a_prefix_covers_paths_on_a_segment_boundary_only() {
        assert!(covers("/", b"/anything"));
        assert!(covers("/api", b"/api"));
        assert!(covers("/api", b"/api/users"));
        assert!(!covers("/api", b"/apis"));
        assert!(!covers("/api", b"/"));
        assert_eq!(path_of(b"/a?b=c"), b"/a");
        assert_eq!(path_of(b"/a"), b"/a");
    }

    #[test]
    fn the_covering_rule_is_the_longest_prefix_and_the_later_registration_on_a_tie() {
        let rules = [
            ("/".to_owned(), 1),
            ("/".to_owned(), 2),
            ("/api".to_owned(), 3),
            ("/api/v1".to_owned(), 4),
        ];
        assert_eq!(covering(&rules, b"/other"), Some(&2));
        assert_eq!(covering(&rules, b"/api/users"), Some(&3));
        assert_eq!(covering(&rules, b"/api/v1/x"), Some(&4));
        assert_eq!(covering(&rules[2..], b"/other"), None);
    }

    #[test]
    fn a_client_the_trusted_proxies_do_not_name_is_reported_as_the_unspecified_address() {
        assert_eq!(
            unspecified(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2))),
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        );
        assert_eq!(
            unspecified(IpAddr::V6(Ipv6Addr::LOCALHOST)),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED)
        );
    }
}
