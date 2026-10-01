//! The request rules of zero-server, the rules tier 0 is built from.
//!
//! CORS, security headers, Fetch Metadata, request ids, trust proxy and body limits,
//! each an evaluator a handler calls. Rules are data evaluated in Rust, never code
//! crossing the language boundary. Bearer extraction, rate limiting and timeouts
//! come in a later release.
//!
//! [`forwarded`] holds the trust-proxy rule over `Forwarded` (RFC 7239) and the
//! `X-Forwarded-*` fields; [`cors`] the server side of the Fetch Standard's CORS
//! protocol; [`security`] the security response headers; [`fetch_metadata`] the
//! refusal of cross-site requests that would change state; [`request_id`] the
//! identifier each request is logged under; [`body_limit`] the largest content each
//! path prefix takes.

pub mod body_limit;
pub mod cors;
pub mod fetch_metadata;
pub mod forwarded;
pub mod request_id;
pub mod security;

pub use body_limit::BodyLimits;
pub use cors::{AllowOrigin, Cors, Decision};
pub use fetch_metadata::{FetchMetadata, Missing, Site, Verdict};
pub use forwarded::{Element, Node, NodeName, Port, TrustProxy};
pub use request_id::RequestId;
pub use security::{
    Csp, Directive, EmbedderPolicy, EmbedderValue, FrameOptions, Hsts, Isolation, OpenerPolicy,
    OpenerValue, ReferrerPolicy, Rendered, ResourcePolicy, SecurityHeaders, Source,
};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    use zero_http_types::Method;
    use zero_server_crypto::SystemRng;

    use super::body_limit::BodyLimits;
    use super::cors::{AllowOrigin, Cors, Decision};
    use super::fetch_metadata::{FetchMetadata, Missing, Site, Verdict};
    use super::forwarded::{parse, Node, NodeName, Port, TrustProxy};
    use super::request_id::{self, RequestId, Version};
    use super::security::{
        Csp, Directive, EmbedderValue, Hsts, Isolation, OpenerValue, ReferrerPolicy, Rendered,
        ResourcePolicy, SecurityHeaders, Source,
    };

    fn field<'a>(fields: &'a [(&'static [u8], Vec<u8>)], name: &[u8]) -> Option<&'a [u8]> {
        fields
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_slice())
    }

    fn listed() -> Cors {
        Cors {
            allow_origin: AllowOrigin::List(vec![b"https://foo.invalid".to_vec()]),
            ..Cors::default()
        }
    }

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    fn peer(ip: IpAddr) -> SocketAddr {
        SocketAddr::new(ip, 40_000)
    }

    #[test]
    fn forwarded_header_values_are_parsed_as_comma_separated_forwarded_elements_of_for_by_host_and_proto_pairs(
    ) {
        // RFC 7239 Section 7.5.
        let elements =
            parse(b"for=192.0.2.43, for=198.51.100.17;by=203.0.113.60;proto=http;host=example.com");
        assert_eq!(elements.len(), 2);
        assert_eq!(
            elements[0].for_node.as_ref().and_then(Node::ip),
            Some(v4(192, 0, 2, 43))
        );
        assert_eq!(elements[0].by, None);
        assert_eq!(
            elements[1].for_node.as_ref().and_then(Node::ip),
            Some(v4(198, 51, 100, 17))
        );
        assert_eq!(
            elements[1].by.as_ref().and_then(Node::ip),
            Some(v4(203, 0, 113, 60))
        );
        assert_eq!(elements[1].proto.as_deref(), Some(&b"http"[..]));
        assert_eq!(elements[1].host.as_deref(), Some(&b"example.com"[..]));
        // Parameter names are case-insensitive; whitespace around the list
        // separators is allowed (Sections 4 and 7.1).
        let mixed = parse(b"For=192.0.2.60;Proto=HTTPS ,  by=203.0.113.43");
        assert_eq!(mixed.len(), 2);
        assert_eq!(mixed[0].proto.as_deref(), Some(&b"https"[..]));
        // A parameter repeated within one element makes that element invalid.
        let repeated = parse(b"for=192.0.2.43;for=192.0.2.44, for=192.0.2.45");
        assert_eq!(repeated.len(), 1);
        assert_eq!(
            repeated[0].for_node.as_ref().and_then(Node::ip),
            Some(v4(192, 0, 2, 45))
        );
    }

    #[test]
    fn ipv6_addresses_and_node_identifiers_with_a_port_in_forwarded_are_accepted_only_in_quoted_form(
    ) {
        // RFC 7239 Sections 4 and 6: ":" and "[]" are not token characters.
        let quoted = parse(b"For=\"[2001:db8:cafe::17]:4711\"");
        let node = quoted[0].for_node.as_ref().expect("a node");
        assert_eq!(
            node.name,
            NodeName::Ip(IpAddr::V6(Ipv6Addr::new(
                0x2001, 0xdb8, 0xcafe, 0, 0, 0, 0, 0x17
            )))
        );
        assert_eq!(node.port, Some(Port::Number(4711)));
        let with_port = parse(b"for=\"192.0.2.43:47011\"");
        assert_eq!(
            with_port[0].for_node,
            Some(Node {
                name: NodeName::Ip(v4(192, 0, 2, 43)),
                port: Some(Port::Number(47_011)),
            })
        );
        assert!(parse(b"for=[2001:db8:cafe::17]").is_empty());
        assert!(parse(b"for=192.0.2.43:47011").is_empty());
        assert!(parse(b"for=\"2001:db8:cafe::17\"").is_empty());
    }

    #[test]
    fn unknown_and_underscore_prefixed_obfuscated_identifiers_are_accepted_without_being_treated_as_ip_addresses(
    ) {
        // RFC 7239 Sections 6.2 and 6.3.
        let elements = parse(b"for=_hidden, for=_SEVKISEK, for=unknown, for=\"_gazonk:_port1\"");
        assert_eq!(elements.len(), 4);
        assert_eq!(
            elements[0].for_node.as_ref().map(|node| node.name),
            Some(NodeName::Obfuscated(b"_hidden"))
        );
        assert_eq!(
            elements[2].for_node.as_ref().map(|node| node.name),
            Some(NodeName::Unknown)
        );
        assert_eq!(
            elements[3].for_node,
            Some(Node {
                name: NodeName::Obfuscated(b"_gazonk"),
                port: Some(Port::Obfuscated(b"_port1")),
            })
        );
        for element in &elements {
            assert_eq!(element.for_node.as_ref().and_then(Node::ip), None);
        }
        // An identifier without the underscore, or with a byte outside the set, is
        // not a node.
        assert!(parse(b"for=hidden").is_empty());
        assert!(parse(b"for=_hid$den").is_empty());
        assert_eq!(Node::parse(b"_"), None);
    }

    #[test]
    fn the_first_for_value_is_the_originating_client_and_later_values_are_successive_proxies() {
        // RFC 7239 Section 5.2, with the proxy at 203.0.113.60 trusted.
        let trust = TrustProxy::new(vec![(v4(203, 0, 113, 60), 32)]);
        let forwarded = b"for=192.0.2.43, for=198.51.100.17;by=203.0.113.60";
        assert_eq!(
            trust.client(peer(v4(203, 0, 113, 60)), Some(forwarded), None),
            v4(192, 0, 2, 43)
        );
        // An obfuscated or unknown first node names no address; the first address
        // after it is not the client either, so the peer stands.
        assert_eq!(
            trust.client(
                peer(v4(203, 0, 113, 60)),
                Some(b"for=_hidden, for=192.0.2.43"),
                None
            ),
            v4(203, 0, 113, 60)
        );
        // X-Forwarded-For is read the same way when Forwarded is absent, with
        // IPv6 unbracketed (Section 7.4).
        assert_eq!(
            trust.client(
                peer(v4(203, 0, 113, 60)),
                None,
                Some(b"2001:db8:cafe::17, 198.51.100.17")
            ),
            IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0xcafe, 0, 0, 0, 0, 0x17))
        );
        assert_eq!(
            trust.proto(
                peer(v4(203, 0, 113, 60)),
                Some(b"for=192.0.2.43;proto=https"),
                None
            ),
            Some(b"https".to_vec())
        );
        assert_eq!(
            trust.proto(peer(v4(203, 0, 113, 60)), None, Some(b"HTTPS")),
            Some(b"https".to_vec())
        );
    }

    #[test]
    fn forwarded_and_x_forwarded_values_are_ignored_unless_the_immediate_peer_is_a_configured_trusted_proxy(
    ) {
        // RFC 7239 Section 8.1.
        let forwarded = b"for=192.0.2.43";
        let untrusted = TrustProxy::none();
        assert_eq!(
            untrusted.client(
                peer(v4(203, 0, 113, 60)),
                Some(forwarded),
                Some(b"192.0.2.44")
            ),
            v4(203, 0, 113, 60)
        );
        assert_eq!(
            untrusted.proto(
                peer(v4(203, 0, 113, 60)),
                Some(b"proto=https"),
                Some(b"https")
            ),
            None
        );
        let trust = TrustProxy::new(vec![
            (v4(10, 0, 0, 0), 8),
            (IpAddr::V6(Ipv6Addr::LOCALHOST), 128),
        ]);
        assert_eq!(
            trust.client(peer(v4(10, 1, 2, 3)), Some(forwarded), None),
            v4(192, 0, 2, 43)
        );
        assert_eq!(
            trust.client(peer(v4(11, 1, 2, 3)), Some(forwarded), None),
            v4(11, 1, 2, 3)
        );
        assert_eq!(
            trust.client(peer(IpAddr::V6(Ipv6Addr::LOCALHOST)), Some(forwarded), None),
            v4(192, 0, 2, 43)
        );
        // A mapped IPv4 peer matches an IPv4 prefix.
        let mapped = IpAddr::V6(Ipv4Addr::new(10, 9, 9, 9).to_ipv6_mapped());
        assert!(trust.trusts(mapped));
    }

    #[test]
    fn the_origin_header_is_compared_as_an_exact_scheme_host_and_port_triple_and_the_literal_null_origin_is_treated_as_matching_nothing(
    ) {
        // RFC 6454 Sections 5 and 6.2.
        let rule = Cors {
            allow_origin: AllowOrigin::List(vec![
                b"https://foo.invalid".to_vec(),
                b"http://foo.invalid:8080".to_vec(),
            ]),
            ..Cors::default()
        };
        assert!(rule.allows(b"https://foo.invalid"));
        assert!(rule.allows(b"http://foo.invalid:8080"));
        assert!(!rule.allows(b"http://foo.invalid"));
        assert!(!rule.allows(b"https://foo.invalid:8443"));
        assert!(!rule.allows(b"https://FOO.invalid"));
        assert!(!rule.allows(b"https://foo.invalid/"));
        assert!(!rule.allows(b"https://foo.invalid.evil.example"));
        assert!(!rule.allows(b"null"));
        assert!(!Cors::default().allows(b"null"));
        assert!(!Cors::default().allows(b"foo.invalid"));
        assert_eq!(
            Cors::default().decide(Some(Method::Get), Some(b"null"), None, None),
            Decision::Refused { preflight: false }
        );
    }

    #[test]
    fn access_control_allow_origin_carries_exactly_one_serialized_origin_or_never_a_list() {
        // Fetch, HTTP responses: the literal Origin value or `*`.
        let any =
            Cors::default().decide(Some(Method::Get), Some(b"https://foo.invalid"), None, None);
        let Decision::Allowed(fields) = any else {
            panic!("allowed");
        };
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Origin"),
            Some(&b"*"[..])
        );
        assert_eq!(field(&fields, b"Vary"), None);
        let rule = Cors {
            allow_origin: AllowOrigin::List(vec![
                b"https://foo.invalid".to_vec(),
                b"https://bar.invalid".to_vec(),
            ]),
            ..Cors::default()
        };
        let Decision::Allowed(fields) =
            rule.decide(Some(Method::Get), Some(b"https://bar.invalid"), None, None)
        else {
            panic!("allowed");
        };
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Origin"),
            Some(&b"https://bar.invalid"[..])
        );
        assert_eq!(
            rule.decide(Some(Method::Get), Some(b"https://baz.invalid"), None, None),
            Decision::Refused { preflight: false }
        );
        assert_eq!(
            rule.decide(Some(Method::Get), None, None, None),
            Decision::NotCors
        );
    }

    #[test]
    fn with_credentials_enabled_the_middleware_reflects_the_allowed_origin_instead_of_and_sends_access_control_allow_credentials_true(
    ) {
        // Fetch, CORS protocol and credentials: `*` cannot be used with credentials
        // and `true` is byte case-sensitive.
        let rule = Cors {
            credentials: true,
            ..Cors::default()
        };
        let Decision::Allowed(fields) =
            rule.decide(Some(Method::Get), Some(b"https://foo.invalid"), None, None)
        else {
            panic!("allowed");
        };
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Origin"),
            Some(&b"https://foo.invalid"[..])
        );
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Credentials"),
            Some(&b"true"[..])
        );
        assert_eq!(field(&fields, b"Vary"), Some(&b"Origin"[..]));
    }

    #[test]
    fn a_preflight_is_recognized_only_as_options_with_origin_and_access_control_request_method_and_it_is_answered_without_running_the_route(
    ) {
        let rule = Cors {
            allow_methods: vec![b"GET".to_vec(), b"PUT".to_vec()],
            allow_headers: vec![b"Content-Type".to_vec()],
            ..Cors::default()
        };
        let preflight = rule.decide(
            Some(Method::Options),
            Some(b"https://foo.invalid"),
            Some(b"PUT"),
            Some(b"content-type"),
        );
        let Decision::Preflight(fields) = preflight else {
            panic!("a preflight: {preflight:?}");
        };
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Methods"),
            Some(&b"GET, PUT"[..])
        );
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Headers"),
            Some(&b"Content-Type"[..])
        );
        // OPTIONS without Access-Control-Request-Method is an ordinary CORS request.
        assert!(matches!(
            rule.decide(
                Some(Method::Options),
                Some(b"https://foo.invalid"),
                None,
                None
            ),
            Decision::Allowed(_)
        ));
        // A method or header the rule does not allow fails the preflight.
        assert_eq!(
            rule.decide(
                Some(Method::Options),
                Some(b"https://foo.invalid"),
                Some(b"DELETE"),
                None
            ),
            Decision::Refused { preflight: true }
        );
        assert_eq!(
            rule.decide(
                Some(Method::Options),
                Some(b"https://foo.invalid"),
                Some(b"PUT"),
                Some(b"X-Token")
            ),
            Decision::Refused { preflight: true }
        );
    }

    #[test]
    fn access_control_allow_methods_and_access_control_allow_headers_wildcards_are_not_relied_on_for_credentialed_requests(
    ) {
        let open = Cors {
            allow_methods: vec![b"*".to_vec()],
            allow_headers: vec![b"*".to_vec()],
            ..Cors::default()
        };
        let Decision::Preflight(fields) = open.decide(
            Some(Method::Options),
            Some(b"https://foo.invalid"),
            Some(b"DELETE"),
            Some(b"X-Token"),
        ) else {
            panic!("a preflight");
        };
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Methods"),
            Some(&b"*"[..])
        );
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Headers"),
            Some(&b"*"[..])
        );
        // With credentials the wildcard counts for nothing: the method must be listed.
        let credentialed = Cors {
            credentials: true,
            ..open
        };
        assert_eq!(
            credentialed.decide(
                Some(Method::Options),
                Some(b"https://foo.invalid"),
                Some(b"DELETE"),
                Some(b"X-Token")
            ),
            Decision::Refused { preflight: true }
        );
        let explicit = Cors {
            credentials: true,
            allow_methods: vec![b"DELETE".to_vec()],
            allow_headers: vec![b"X-Token".to_vec()],
            ..Cors::default()
        };
        let Decision::Preflight(fields) = explicit.decide(
            Some(Method::Options),
            Some(b"https://foo.invalid"),
            Some(b"DELETE"),
            Some(b"x-token"),
        ) else {
            panic!("a preflight");
        };
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Methods"),
            Some(&b"DELETE"[..])
        );
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Headers"),
            Some(&b"X-Token"[..])
        );
    }

    #[test]
    fn access_control_max_age_is_emitted_as_delta_seconds() {
        let rule = Cors {
            max_age: Some(600),
            ..Cors::default()
        };
        let Decision::Preflight(fields) = rule.decide(
            Some(Method::Options),
            Some(b"https://foo.invalid"),
            Some(b"GET"),
            None,
        ) else {
            panic!("a preflight");
        };
        assert_eq!(field(&fields, b"Access-Control-Max-Age"), Some(&b"600"[..]));
        let Decision::Preflight(fields) = Cors::default().decide(
            Some(Method::Options),
            Some(b"https://foo.invalid"),
            Some(b"GET"),
            None,
        ) else {
            panic!("a preflight");
        };
        assert_eq!(field(&fields, b"Access-Control-Max-Age"), None);
    }

    #[test]
    fn non_safelisted_response_headers_the_client_must_read_are_listed_in_access_control_expose_headers(
    ) {
        let rule = Cors {
            expose_headers: vec![
                b"Content-Security-Policy".to_vec(),
                b"X-Request-Id".to_vec(),
            ],
            ..Cors::default()
        };
        let Decision::Allowed(fields) =
            rule.decide(Some(Method::Get), Some(b"https://foo.invalid"), None, None)
        else {
            panic!("allowed");
        };
        assert_eq!(
            field(&fields, b"Access-Control-Expose-Headers"),
            Some(&b"Content-Security-Policy, X-Request-Id"[..])
        );
        // A preflight response carries no expose list; `*` is kept only without
        // credentials.
        let Decision::Preflight(fields) = rule.decide(
            Some(Method::Options),
            Some(b"https://foo.invalid"),
            Some(b"GET"),
            None,
        ) else {
            panic!("a preflight");
        };
        assert_eq!(field(&fields, b"Access-Control-Expose-Headers"), None);
        let starred = Cors {
            credentials: true,
            expose_headers: vec![b"*".to_vec()],
            ..Cors::default()
        };
        let Decision::Allowed(fields) =
            starred.decide(Some(Method::Get), Some(b"https://foo.invalid"), None, None)
        else {
            panic!("allowed");
        };
        assert_eq!(field(&fields, b"Access-Control-Expose-Headers"), None);
    }

    fn rendered(rule: &SecurityHeaders, secure: bool) -> Rendered {
        rule.render(secure, &SystemRng).expect("rendered")
    }

    fn csp(directives: Vec<Directive>) -> Csp {
        Csp {
            directives,
            report_only: false,
        }
    }

    fn only_csp(policy: Csp) -> SecurityHeaders {
        SecurityHeaders {
            csp: Some(policy),
            ..SecurityHeaders::default()
        }
    }

    fn literal(value: &str) -> Source {
        Source::Literal(value.as_bytes().to_vec())
    }

    /// The directive names of a serialized policy, as CSP3 Section 2.2.1 parses it:
    /// split on `;`, strip ASCII whitespace, skip empty tokens, the name up to the
    /// first whitespace, lowercased.
    fn parsed_names(serialized: &[u8]) -> Vec<Vec<u8>> {
        serialized
            .split(|&b| b == b';')
            .map(<[u8]>::trim_ascii)
            .filter(|token| !token.is_empty())
            .map(|token| {
                token
                    .split(u8::is_ascii_whitespace)
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
            })
            .collect()
    }

    #[test]
    fn strict_transport_security_always_includes_max_age_and_includesubdomains_is_emitted_valueless(
    ) {
        // RFC 6797 Sections 6.1.1 and 6.1.2.
        let fields = rendered(&SecurityHeaders::default(), true).fields;
        assert_eq!(
            field(&fields, b"Strict-Transport-Security"),
            Some(&b"max-age=63072000; includeSubDomains"[..])
        );
        let bare = SecurityHeaders {
            hsts: Some(Hsts {
                max_age: 31_536_000,
                include_subdomains: false,
            }),
            ..SecurityHeaders::default()
        };
        assert_eq!(
            field(&rendered(&bare, true).fields, b"Strict-Transport-Security"),
            Some(&b"max-age=31536000"[..])
        );
    }

    #[test]
    fn strict_transport_security_is_not_sent_on_responses_over_plain_http() {
        // RFC 6797 Section 7.2.
        let fields = rendered(&SecurityHeaders::default(), false).fields;
        assert_eq!(field(&fields, b"Strict-Transport-Security"), None);
        assert_eq!(
            field(&fields, b"X-Content-Type-Options"),
            Some(&b"nosniff"[..])
        );
    }

    #[test]
    fn only_one_strict_transport_security_field_is_emitted_per_response_since_user_agents_process_only_the_first(
    ) {
        // RFC 6797 Section 8.1: the rule's field replaces any the handler set.
        let rule = SecurityHeaders::default();
        let mut own: Vec<(Vec<u8>, Vec<u8>)> = vec![
            (b"strict-transport-security".to_vec(), b"max-age=1".to_vec()),
            (b"Content-Type".to_vec(), b"text/html".to_vec()),
        ];
        rule.scrub(&mut own);
        assert_eq!(own, vec![(b"Content-Type".to_vec(), b"text/html".to_vec())]);
        let fields = rendered(&rule, true).fields;
        let count = fields
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(b"Strict-Transport-Security"))
            .count();
        assert_eq!(count, 1);
        // Every field the rule renders appears once.
        for (name, _) in &fields {
            assert_eq!(fields.iter().filter(|(other, _)| other == name).count(), 1);
        }
    }

    #[test]
    fn max_age_0_is_accepted_as_the_way_to_withdraw_hsts() {
        // RFC 6797 Section 6.1.1: max-age=0 tells the user agent to stop.
        let withdraw = SecurityHeaders {
            hsts: Some(Hsts {
                max_age: 0,
                include_subdomains: false,
            }),
            ..SecurityHeaders::default()
        };
        assert_eq!(
            field(
                &rendered(&withdraw, true).fields,
                b"Strict-Transport-Security"
            ),
            Some(&b"max-age=0"[..])
        );
    }

    #[test]
    fn csp_directives_are_serialized_semicolon_separated_with_directive_names_that_round_trip_through_the_csp_parser(
    ) {
        // CSP3 Sections 2.2 and 2.2.1.
        let policy = csp(vec![
            Directive::new("default-src", vec![literal("'self'")]).expect("valid"),
            Directive::new(
                "img-src",
                vec![literal("'self'"), literal("https://cdn.invalid")],
            )
            .expect("valid"),
            Directive::new("upgrade-insecure-requests", Vec::new()).expect("valid"),
        ]);
        let value = policy.header_value(None).expect("serialized");
        assert_eq!(
            value,
            b"default-src 'self'; img-src 'self' https://cdn.invalid; upgrade-insecure-requests"
        );
        assert_eq!(
            parsed_names(&value),
            vec![
                b"default-src".to_vec(),
                b"img-src".to_vec(),
                b"upgrade-insecure-requests".to_vec()
            ]
        );
        // A name outside 1*( ALPHA / DIGIT / "-" ) or a value that would split the
        // policy is refused rather than serialized.
        assert!(Directive::new("script_src", Vec::new()).is_err());
        assert!(Directive::new("Script-Src", Vec::new()).is_err());
        assert!(Directive::new("", Vec::new()).is_err());
        assert!(Directive::new("script-src", vec![literal("'self'; object-src *")]).is_err());
        assert!(Directive::new("script-src", vec![literal("a,b")]).is_err());
        assert!(Directive::new("script-src", vec![literal("")]).is_err());
    }

    #[test]
    fn script_and_style_nonces_are_fresh_and_unguessable_on_every_response_and_never_reused_across_responses(
    ) {
        // CSP3 Section 7.1: a unique value each time, at least 128 bits, from a
        // cryptographically secure generator.
        let rule = only_csp(csp(vec![
            Directive::new(
                "script-src",
                vec![Source::Nonce, literal("'strict-dynamic'")],
            )
            .expect("valid"),
            Directive::new("style-src", vec![Source::Nonce]).expect("valid"),
        ]));
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1_000 {
            let response = rendered(&rule, true);
            let nonce = response.nonce.expect("a nonce");
            let raw = zero_base64::decode(nonce.as_bytes(), zero_base64::Alphabet::Standard, true)
                .expect("base64");
            assert_eq!(raw.len(), 16);
            assert!(seen.insert(nonce.clone()), "nonce reused");
            let value = field(&response.fields, b"Content-Security-Policy").expect("policy");
            let expected =
                format!("script-src 'nonce-{nonce}' 'strict-dynamic'; style-src 'nonce-{nonce}'");
            assert_eq!(value, expected.as_bytes());
        }
        // A policy without a nonce source draws none.
        let plain = only_csp(csp(vec![Directive::new(
            "default-src",
            vec![literal("'self'")],
        )
        .expect("valid")]));
        assert_eq!(rendered(&plain, true).nonce, None);
    }

    #[test]
    fn frame_ancestors_is_delivered_only_via_the_http_header_never_a_meta_element() {
        // CSP3 Section 3.3: a <meta> policy supports neither frame-ancestors nor
        // report-uri nor sandbox.
        let policy = csp(vec![
            Directive::new("default-src", vec![literal("'self'")]).expect("valid"),
            Directive::new("frame-ancestors", vec![literal("'none'")]).expect("valid"),
            Directive::new("sandbox", Vec::new()).expect("valid"),
            Directive::new("report-uri", vec![literal("/csp")]).expect("valid"),
        ]);
        let header = policy.header_value(None).expect("header");
        assert_eq!(
            parsed_names(&header),
            vec![
                b"default-src".to_vec(),
                b"frame-ancestors".to_vec(),
                b"sandbox".to_vec(),
                b"report-uri".to_vec()
            ]
        );
        let meta = policy.meta_content(None).expect("meta");
        assert_eq!(meta, b"default-src 'self'");
    }

    #[test]
    fn a_report_only_mode_emits_content_security_policy_report_only_instead_of_the_enforcing_header(
    ) {
        // CSP3 Section 3.2.
        let mut policy = csp(vec![
            Directive::new("default-src", vec![literal("'self'")]).expect("valid")
        ]);
        policy.report_only = true;
        let fields = rendered(&only_csp(policy), true).fields;
        assert_eq!(
            field(&fields, b"Content-Security-Policy-Report-Only"),
            Some(&b"default-src 'self'"[..])
        );
        assert_eq!(field(&fields, b"Content-Security-Policy"), None);
    }

    #[test]
    fn x_content_type_options_is_exactly_nosniff() {
        // Fetch Section 3.6: X-Content-Type-Options = "nosniff".
        let fields = rendered(&SecurityHeaders::default(), true).fields;
        assert_eq!(
            field(&fields, b"X-Content-Type-Options"),
            Some(&b"nosniff"[..])
        );
        let off = SecurityHeaders {
            nosniff: false,
            ..SecurityHeaders::default()
        };
        assert_eq!(
            field(&rendered(&off, true).fields, b"X-Content-Type-Options"),
            None
        );
    }

    #[test]
    fn cross_origin_resource_policy_is_one_of_same_site_same_origin_or_cross_origin() {
        // Fetch Section 3.7: %s"same-origin" / %s"same-site" / %s"cross-origin",
        // case-sensitive.
        for policy in [
            ResourcePolicy::SameOrigin,
            ResourcePolicy::SameSite,
            ResourcePolicy::CrossOrigin,
        ] {
            assert_eq!(ResourcePolicy::parse(policy.value()), Some(policy));
            let rule = SecurityHeaders {
                resource_policy: Some(policy),
                ..SecurityHeaders::default()
            };
            assert_eq!(
                field(
                    &rendered(&rule, true).fields,
                    b"Cross-Origin-Resource-Policy"
                ),
                Some(policy.value())
            );
        }
        assert_eq!(ResourcePolicy::parse(b"Same-Site"), None);
        assert_eq!(ResourcePolicy::parse(b"same-site "), None);
        assert_eq!(ResourcePolicy::parse(b"none"), None);
    }

    #[test]
    fn cross_origin_opener_policy_and_cross_origin_embedder_policy_values_are_structured_header_tokens_from_the_defined_set(
    ) {
        // HTML Sections 7.1.3.1 and 7.1.4.1: a token, an optional report-to string
        // parameter, and the -Report-Only variants.
        let rule = SecurityHeaders {
            opener_policy: Some(Isolation {
                value: OpenerValue::SameOriginAllowPopups,
                report_to: Some("coop".to_owned()),
                report_only: false,
            }),
            embedder_policy: Some(Isolation {
                value: EmbedderValue::RequireCorp,
                report_to: None,
                report_only: true,
            }),
            ..SecurityHeaders::default()
        };
        let fields = rendered(&rule, true).fields;
        assert_eq!(
            field(&fields, b"Cross-Origin-Opener-Policy"),
            Some(&b"same-origin-allow-popups;report-to=\"coop\""[..])
        );
        assert_eq!(
            field(&fields, b"Cross-Origin-Embedder-Policy-Report-Only"),
            Some(&b"require-corp"[..])
        );
        assert_eq!(field(&fields, b"Cross-Origin-Embedder-Policy"), None);
        // A quote or a backslash in the endpoint is escaped as an sf-string requires,
        // and a byte outside visible ASCII is refused.
        let quoted = SecurityHeaders {
            opener_policy: Some(Isolation {
                value: OpenerValue::SameOrigin,
                report_to: Some("a\"b\\c".to_owned()),
                report_only: false,
            }),
            ..SecurityHeaders::default()
        };
        assert_eq!(
            field(
                &rendered(&quoted, true).fields,
                b"Cross-Origin-Opener-Policy"
            ),
            Some(&b"same-origin;report-to=\"a\\\"b\\\\c\""[..])
        );
        let bad = SecurityHeaders {
            opener_policy: Some(Isolation {
                value: OpenerValue::SameOrigin,
                report_to: Some("tab\there".to_owned()),
                report_only: false,
            }),
            ..SecurityHeaders::default()
        };
        assert!(bad.render(true, &SystemRng).is_err());
    }

    #[test]
    fn referrer_policy_accepts_a_comma_separated_fallback_list_and_the_last_recognized_token_wins()
    {
        // Referrer Policy Sections 4.1 and 8.1.
        let rule = SecurityHeaders {
            referrer_policy: vec![
                ReferrerPolicy::NoReferrer,
                ReferrerPolicy::StrictOriginWhenCrossOrigin,
            ],
            ..SecurityHeaders::default()
        };
        let value = field(&rendered(&rule, true).fields, b"Referrer-Policy")
            .expect("a policy")
            .to_vec();
        assert_eq!(value, b"no-referrer, strict-origin-when-cross-origin");
        assert_eq!(
            ReferrerPolicy::parse_header(&value),
            Some(ReferrerPolicy::StrictOriginWhenCrossOrigin)
        );
        assert_eq!(
            ReferrerPolicy::parse_header(b"no-referrer, some-future-policy"),
            Some(ReferrerPolicy::NoReferrer)
        );
        assert_eq!(
            ReferrerPolicy::parse_header(b"origin,  unsafe-url"),
            Some(ReferrerPolicy::UnsafeUrl)
        );
        assert_eq!(ReferrerPolicy::parse_header(b"unknown"), None);
    }

    #[test]
    fn when_fetch_metadata_mode_is_on_an_unsafe_request_with_sec_fetch_site_cross_site_is_rejected()
    {
        // Fetch Metadata Section 2.3; OWASP CSRF, Fetch Metadata headers.
        let rule = FetchMetadata::default();
        for method in [Method::Post, Method::Put, Method::Delete] {
            assert!(matches!(
                rule.decide(Some(method), Some(b"cross-site")),
                Verdict::Refused(_)
            ));
        }
        // A method outside the registry's eight, such as PATCH, counts as unsafe.
        assert!(matches!(
            rule.decide(None, Some(b"cross-site")),
            Verdict::Refused(_)
        ));
        // Safe methods pass whatever the site, so cross-site links and images work.
        for method in [Method::Get, Method::Head, Method::Options, Method::Trace] {
            assert!(matches!(
                rule.decide(Some(method), Some(b"cross-site")),
                Verdict::Allowed(_)
            ));
        }
        // Same-origin and user-initiated requests pass; same-site only when trusted.
        assert!(matches!(
            rule.decide(Some(Method::Post), Some(b"same-origin")),
            Verdict::Allowed(_)
        ));
        assert!(matches!(
            rule.decide(Some(Method::Post), Some(b"none")),
            Verdict::Allowed(_)
        ));
        assert!(matches!(
            rule.decide(Some(Method::Post), Some(b"same-site")),
            Verdict::Refused(_)
        ));
        let siblings = FetchMetadata {
            allow_same_site: true,
            ..FetchMetadata::default()
        };
        assert!(matches!(
            siblings.decide(Some(Method::Post), Some(b"same-site")),
            Verdict::Allowed(_)
        ));
        // An invalid value is ignored, like an absent header, and both follow the
        // rule's setting for clients that send none.
        assert_eq!(Site::parse(b"Cross-Site"), None);
        assert!(matches!(
            rule.decide(Some(Method::Post), Some(b"Cross-Site")),
            Verdict::Allowed(_)
        ));
        assert!(matches!(
            rule.decide(Some(Method::Post), None),
            Verdict::Allowed(_)
        ));
        let strict = FetchMetadata {
            missing: Missing::Refuse,
            ..FetchMetadata::default()
        };
        assert!(matches!(
            strict.decide(Some(Method::Post), None),
            Verdict::Refused(_)
        ));
        assert!(matches!(
            strict.decide(Some(Method::Get), None),
            Verdict::Allowed(_)
        ));
    }

    #[test]
    fn responses_whose_handling_depends_on_sec_fetch_headers_send_a_matching_vary() {
        // Fetch Metadata Section 5.1: the response depends on Sec-Fetch-Site, so it
        // names it in Vary whether the request ran or not.
        let rule = FetchMetadata::default();
        for verdict in [
            rule.decide(Some(Method::Post), Some(b"cross-site")),
            rule.decide(Some(Method::Post), Some(b"same-origin")),
            rule.decide(Some(Method::Get), None),
        ] {
            let fields = match verdict {
                Verdict::Allowed(fields) | Verdict::Refused(fields) => fields,
            };
            assert_eq!(field(&fields, b"Vary"), Some(&b"Sec-Fetch-Site"[..]));
        }
    }

    /// Whether `id` is a UUID string of the given version: 8-4-4-4-12 lowercase hex
    /// digits, the version nibble at the start of the third group, the variant bits
    /// `10` at the start of the fourth (RFC 9562 Sections 4, 4.1 and 4.2).
    fn is_uuid(id: &[u8], version: u8) -> bool {
        let hyphens = [8usize, 13, 18, 23];
        let shape = id.len() == 36
            && id.iter().enumerate().all(|(i, &b)| {
                if hyphens.contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }
            });
        let version_digit = id.get(14).copied();
        let variant_digit = id.get(19).copied();
        shape
            && version_digit == Some(b'0'.saturating_add(version))
            && matches!(variant_digit, Some(b'8' | b'9' | b'a' | b'b'))
    }

    #[test]
    fn generated_request_ids_are_uuidv4_or_uuidv7_with_correct_version_and_variant_bits_emitted_in_lowercase_hex(
    ) {
        // RFC 9562 Sections 4, 4.1, 4.2, 5.4 and 5.7.
        let v7 = RequestId::default();
        let now = 1_759_312_800_123u64;
        let (name, id) = v7.assign(None, &SystemRng, now).expect("an id");
        assert_eq!(name, b"X-Request-Id");
        assert!(is_uuid(&id, 7), "{}", String::from_utf8_lossy(&id));
        // The first 48 bits are the millisecond timestamp, big-endian.
        let ms = u64::from_str_radix(
            &String::from_utf8_lossy(&[&id[..8], &id[9..13]].concat()),
            16,
        )
        .expect("hex");
        assert_eq!(ms, now);
        // Later milliseconds sort later.
        let (_, later) = v7.assign(None, &SystemRng, now + 1).expect("an id");
        assert!(later > id);
        let v4 = RequestId {
            version: Version::V4,
            ..RequestId::default()
        };
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1_000 {
            let (_, id) = v4.assign(None, &SystemRng, now).expect("an id");
            assert!(is_uuid(&id, 4), "{}", String::from_utf8_lossy(&id));
            assert!(seen.insert(id));
        }
        // The fixed layout of the two versions, on known octets.
        let octets = [0xffu8; 16];
        assert_eq!(
            &request_id::format(&octets),
            b"ffffffff-ffff-ffff-ffff-ffffffffffff"
        );
    }

    #[test]
    fn an_incoming_request_id_is_length_and_charset_validated_before_being_echoed_or_logged_and_no_code_path_treats_it_as_an_access_capability(
    ) {
        // RFC 9562 Section 8: an id is an identifier, never a capability, so the rule
        // only checks its form; nothing reads it to grant anything.
        let trusting = RequestId {
            trust_incoming: true,
            ..RequestId::default()
        };
        let now = 1_759_312_800_000u64;
        let kept = trusting
            .assign(Some(b"edge-7f3a.42:9"), &SystemRng, now)
            .expect("an id");
        assert_eq!(kept.1, b"edge-7f3a.42:9");
        let too_long = vec![b'a'; request_id::MAX_INCOMING + 1];
        let longest = vec![b'a'; request_id::MAX_INCOMING];
        assert!(request_id::is_acceptable(&longest));
        for hostile in [
            &b"abc\r\nSet-Cookie: x=1"[..],
            b"abc def",
            b"abc\"def",
            b"",
            b"\xe2\x80\x8b",
            too_long.as_slice(),
        ] {
            assert!(!request_id::is_acceptable(hostile));
            let (_, id) = trusting
                .assign(Some(hostile), &SystemRng, now)
                .expect("an id");
            assert!(is_uuid(&id, 7), "replaced by a generated id");
        }
        // Without trust, even a well-formed incoming id is replaced.
        let (_, id) = RequestId::default()
            .assign(Some(b"client-chosen"), &SystemRng, now)
            .expect("an id");
        assert!(is_uuid(&id, 7));
    }

    #[test]
    fn x_xss_protection_is_sent_as_0_and_x_powered_by_is_removed() {
        // OWASP HTTP Security Response Headers Cheat Sheet.
        let rule = SecurityHeaders::default();
        let fields = rendered(&rule, true).fields;
        assert_eq!(field(&fields, b"X-XSS-Protection"), Some(&b"0"[..]));
        let mut own: Vec<(&[u8], &[u8])> = vec![
            (b"x-powered-by", b"zero-server"),
            (b"X-XSS-Protection", b"1; mode=block"),
            (b"Content-Type", b"text/plain"),
        ];
        rule.scrub(&mut own);
        assert_eq!(own, vec![(&b"Content-Type"[..], &b"text/plain"[..])]);
    }

    #[test]
    fn when_the_allowed_origin_varies_per_request_the_response_carries_vary_origin() {
        // RFC 9110 Section 12.5.5: the selected response depends on Origin.
        let Decision::Allowed(fields) =
            listed().decide(Some(Method::Get), Some(b"https://foo.invalid"), None, None)
        else {
            panic!("allowed");
        };
        assert_eq!(field(&fields, b"Vary"), Some(&b"Origin"[..]));
        assert_eq!(
            field(&fields, b"Access-Control-Allow-Origin"),
            Some(&b"https://foo.invalid"[..])
        );
        let Decision::Allowed(fields) =
            Cors::default().decide(Some(Method::Get), Some(b"https://foo.invalid"), None, None)
        else {
            panic!("allowed");
        };
        assert_eq!(field(&fields, b"Vary"), None);
    }

    #[test]
    fn body_limit_prefixes_match_on_segment_boundaries_after_rfc_3986_normalization_so_a_dot_segment_cannot_borrow_another_routes_limit(
    ) {
        let limits = BodyLimits::new(1024)
            .route("/upload", 1 << 20)
            .unwrap()
            .route("/upload/avatar/", 4096)
            .unwrap()
            .route("/api", 64)
            .unwrap();
        assert_eq!(limits.limit(b"/upload"), 1 << 20);
        assert_eq!(limits.limit(b"/upload/file?name=x"), 1 << 20);
        assert_eq!(
            limits.limit(b"/upload/avatar"),
            4096,
            "the longest prefix wins"
        );
        assert_eq!(limits.limit(b"/upload/avatar/me"), 4096);
        assert_eq!(limits.limit(b"/uploads"), 1024, "not a segment boundary");
        assert_eq!(limits.limit(b"/hello"), 1024);
        assert_eq!(limits.limit(b""), 1024, "the authority and asterisk forms");
        assert_eq!(
            limits.limit(b"/upload/../api/x"),
            64,
            "Section 5.2.4: dot-segments are removed before matching"
        );
        assert_eq!(
            limits.limit(b"/%75pload/x"),
            1 << 20,
            "Section 6.2.2.2: an unreserved octet is decoded"
        );
        assert_eq!(
            limits.limit(b"/upload%2Fx"),
            1024,
            "Section 2.2: an encoded slash is not a separator"
        );
        assert_eq!(
            limits.limit(b"/api?/upload"),
            64,
            "Section 3.4: the query never takes part"
        );
        assert_eq!(
            limits.limit(b"/upload/%zz"),
            64,
            "a path that cannot be normalized gets the smallest limit"
        );

        let root = BodyLimits::new(10).route("/", 20).unwrap();
        assert_eq!(root.limit(b"/anything"), 20);
        assert_eq!(root.limit(b""), 10);

        let replaced = BodyLimits::new(1)
            .route("/a", 2)
            .unwrap()
            .route("/a/", 3)
            .unwrap();
        assert_eq!(replaced.limit(b"/a/b"), 3, "a prefix added again replaces");

        for bad in ["upload", "/a?b", "/a%zz", ""] {
            assert!(BodyLimits::new(1).route(bad, 2).is_err(), "{bad:?}");
        }
    }
}
