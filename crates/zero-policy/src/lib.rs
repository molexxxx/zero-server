//! The declarative rule engine behind tier 0 of zero-server.
//!
//! CORS, security headers, request ids, trust proxy, body limits, bearer extraction,
//! rate limiting with RFC 6585 and draft ratelimit headers, and timeouts. Rules are
//! data evaluated in Rust, never code crossing the language boundary.
//!
//! [`forwarded`] holds the trust-proxy rule over `Forwarded` (RFC 7239) and the
//! `X-Forwarded-*` fields.

pub mod forwarded;

pub use forwarded::{Element, Node, NodeName, Port, TrustProxy};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    use super::forwarded::{parse, Node, NodeName, Port, TrustProxy};

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
}
