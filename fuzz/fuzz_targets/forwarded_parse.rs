//! The `Forwarded` parser and the trust-proxy rule on arbitrary bytes, split at
//! the first two line feeds into `Forwarded`, `X-Forwarded-For` and
//! `X-Forwarded-Proto` values. The elements that parse, written back with every
//! value quoted (RFC 7239 Section 4) and node identifiers in their Section 6
//! form, parse to the same elements; a node identifier on its own round-trips
//! the same way; an untrusted peer is the client and reports no scheme whatever
//! the fields say (Section 8.1); a rule reads only the family of fields it names,
//! so the other family's lines change nothing; a line a proxy adds after the
//! client's names the client whatever the client's line holds, since the chain is
//! walked from the right and each line is split on its own (Section 8.1); and a
//! scheme is lowercased. A pair's value may be any quoted-string (Section 4), so
//! the first line's octets that a quoted-string carries, quoted as an extension
//! pair after `for=192.0.2.43`, leave that element and its client in place, and
//! its octets that a `reg-name` holds unescaped (RFC 3986 Section 3.2.2), quoted
//! as `host`, parse back unchanged (Section 5.3).

#![no_main]

use std::io::Write as _;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use libfuzzer_sys::fuzz_target;
use zero_policy::forwarded::parse;
use zero_policy::{Element, Forwarding, ForwardingHeader, Node, NodeName, Port, TrustProxy};

/// A node identifier as `nodename [ ":" node-port ]` (RFC 7239 Section 6).
fn write_node(out: &mut Vec<u8>, node: &Node<'_>) {
    match node.name {
        NodeName::Ip(IpAddr::V4(ip)) => write!(out, "{ip}").unwrap(),
        NodeName::Ip(IpAddr::V6(ip)) => write!(out, "[{ip}]").unwrap(),
        NodeName::Unknown => out.extend_from_slice(b"unknown"),
        NodeName::Obfuscated(name) => out.extend_from_slice(name),
    }
    match node.port {
        Some(Port::Number(port)) => write!(out, ":{port}").unwrap(),
        Some(Port::Obfuscated(port)) => {
            out.push(b':');
            out.extend_from_slice(port);
        }
        None => {}
    }
}

/// A quoted-string with `"` and `\` escaped.
fn write_quoted(out: &mut Vec<u8>, value: &[u8]) {
    out.push(b'"');
    for &byte in value {
        if byte == b'"' || byte == b'\\' {
            out.push(b'\\');
        }
        out.push(byte);
    }
    out.push(b'"');
}

/// An octet a quoted-string carries, as `qdtext` or in a `quoted-pair` (RFC
/// 9110 Section 5.6.4).
fn is_quotable(byte: u8) -> bool {
    matches!(byte, b'\t' | b' ' | 0x21..=0x7e | 0x80..=0xff)
}

/// An octet a `reg-name` holds unescaped: `unreserved` or `sub-delims` (RFC
/// 3986 Sections 2.2, 2.3 and 3.2.2).
fn is_reg_name(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=".contains(&byte)
}

/// The elements as a `Forwarded` value; an element with no known parameter is
/// written as an extension pair, which parses to the same empty element.
fn write_elements(elements: &[Element<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    for (index, element) in elements.iter().enumerate() {
        if index > 0 {
            out.extend_from_slice(b", ");
        }
        let mut pairs: Vec<Vec<u8>> = Vec::new();
        for (name, node) in [(&b"for"[..], &element.for_node), (b"by", &element.by)] {
            if let Some(node) = node {
                let mut pair = name.to_vec();
                pair.extend_from_slice(b"=\"");
                write_node(&mut pair, node);
                pair.push(b'"');
                pairs.push(pair);
            }
        }
        for (name, value) in [(&b"host"[..], &element.host), (b"proto", &element.proto)] {
            if let Some(value) = value {
                let mut pair = name.to_vec();
                pair.push(b'=');
                write_quoted(&mut pair, value);
                pairs.push(pair);
            }
        }
        if pairs.is_empty() {
            pairs.push(b"ext=1".to_vec());
        }
        out.extend_from_slice(&pairs.join(&b';'));
    }
    out
}

/// Whether a field line belongs to the family `header` names.
fn in_family(header: ForwardingHeader, name: &[u8]) -> bool {
    match header {
        ForwardingHeader::Forwarded => name == b"forwarded",
        ForwardingHeader::XForwardedFor => name == b"x-forwarded-for" || name == b"x-forwarded-proto",
    }
}

fuzz_target!(|data: &[u8]| {
    let mut fields = data.splitn(3, |&byte| byte == b'\n');
    let forwarded = fields.next().unwrap_or_default();
    let x_forwarded_for = fields.next();
    let x_forwarded_proto = fields.next();

    let elements = parse(forwarded);
    let written = write_elements(&elements);
    assert_eq!(
        parse(&written),
        elements,
        "{:?}",
        String::from_utf8_lossy(&written)
    );

    if let Some(node) = Node::parse(forwarded) {
        let mut written = Vec::new();
        write_node(&mut written, &node);
        assert_eq!(Node::parse(&written), Some(node));
    }

    let mut lines: Vec<(&[u8], &[u8])> = vec![(b"forwarded", forwarded)];
    if let Some(value) = x_forwarded_for {
        lines.push((b"x-forwarded-for", value));
    }
    if let Some(value) = x_forwarded_proto {
        lines.push((b"x-forwarded-proto", value));
    }
    let listed = TrustProxy::new(vec![(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 0)), 24)]);
    let rules = [
        listed.clone(),
        listed.with_header(ForwardingHeader::Forwarded),
    ];
    let outsider = SocketAddr::from(([203, 0, 113, 9], 443));
    let proxy = SocketAddr::from(([192, 0, 2, 7], 443));
    let answer = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 17));
    for rule in &rules {
        assert_eq!(
            rule.forwarding(outsider, lines.iter().copied()),
            Forwarding {
                client: Some(outsider.ip()),
                proto: None,
            }
        );
        let all = rule.forwarding(proxy, lines.iter().copied());
        let own = rule.forwarding(
            proxy,
            lines
                .iter()
                .copied()
                .filter(|(name, _)| in_family(rule.header, name)),
        );
        assert_eq!(all, own, "the other family changes nothing");
        if let Some(proto) = &all.proto {
            assert_eq!(*proto, proto.to_ascii_lowercase());
        }

        let (name, appended): (&[u8], &[u8]) = match rule.header {
            ForwardingHeader::Forwarded => (b"forwarded", b"for=198.51.100.17"),
            ForwardingHeader::XForwardedFor => (b"x-forwarded-for", b"198.51.100.17"),
        };
        let client_line = match rule.header {
            ForwardingHeader::Forwarded => forwarded,
            ForwardingHeader::XForwardedFor => x_forwarded_for.unwrap_or_default(),
        };
        assert_eq!(
            rule.forwarding(proxy, [(name, client_line), (name, appended)])
                .client,
            Some(answer),
            "a proxy's line after the client's names the client: {:?}",
            String::from_utf8_lossy(client_line)
        );
    }

    let sender = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 43));
    let first = Element {
        for_node: Some(Node {
            name: NodeName::Ip(sender),
            port: None,
        }),
        ..Element::default()
    };
    let quotable: Vec<u8> = forwarded
        .iter()
        .copied()
        .filter(|&byte| is_quotable(byte))
        .collect();
    let mut written = b"for=192.0.2.43;ext=".to_vec();
    write_quoted(&mut written, &quotable);
    assert_eq!(
        parse(&written),
        [first.clone()],
        "a quoted-string value keeps its element (RFC 7239 Section 4): {:?}",
        String::from_utf8_lossy(&written)
    );
    assert_eq!(
        rules[1]
            .forwarding(proxy, [(&b"forwarded"[..], written.as_slice())])
            .client,
        Some(sender),
        "a chain of trusted addresses yields its leftmost one"
    );

    let host: Vec<u8> = forwarded
        .iter()
        .copied()
        .filter(|&byte| is_reg_name(byte))
        .collect();
    let mut written = b"for=192.0.2.43;host=".to_vec();
    write_quoted(&mut written, &host);
    assert_eq!(
        parse(&written),
        [Element {
            host: Some(host),
            ..first
        }],
        "a quoted host parses back unchanged (RFC 7239 Section 5.3): {:?}",
        String::from_utf8_lossy(&written)
    );
});
