//! The declarative rule engine behind tier 0 of zero-server.
//!
//! CORS, security headers, request ids, trust proxy, body limits, bearer extraction,
//! rate limiting with RFC 6585 and draft ratelimit headers, and timeouts. Rules are
//! data evaluated in Rust, never code crossing the language boundary.
//!
//! [`forwarded`] holds the trust-proxy rule over `Forwarded` (RFC 7239) and the
//! `X-Forwarded-*` fields; [`cors`] the server side of the Fetch Standard's CORS
//! protocol.

pub mod cors;
pub mod forwarded;

pub use cors::{AllowOrigin, Cors, Decision};
pub use forwarded::{Element, Node, NodeName, Port, TrustProxy};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    use zero_http_types::Method;

    use super::cors::{AllowOrigin, Cors, Decision};
    use super::forwarded::{parse, Node, NodeName, Port, TrustProxy};

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
}
