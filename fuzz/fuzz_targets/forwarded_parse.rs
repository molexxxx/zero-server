//! The `Forwarded` parser and the trust-proxy rule on arbitrary bytes, split at
//! the first two line feeds into `Forwarded`, `X-Forwarded-For` and
//! `X-Forwarded-Proto` values. The elements that parse, written back with every
//! value quoted (RFC 7239 Section 4) and node identifiers in their Section 6
//! form, parse to the same elements; a node identifier on its own round-trips
//! the same way; an untrusted peer is the client and reports no scheme whatever
//! the fields say (Section 8.1); and a trusted peer's client comes from the first
//! `for` (Section 5.2) or the first `X-Forwarded-For` address, its scheme
//! lowercased. A pair's value may be any quoted-string (Section 4), so the
//! first line's octets that a quoted-string carries, quoted as an extension
//! pair after `for=192.0.2.43`, leave that element and its client in place, and
//! its octets that a `reg-name` holds unescaped (RFC 3986 Section 3.2.2), quoted
//! as `host`, parse back unchanged (Section 5.3).

#![no_main]

use std::io::Write as _;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use libfuzzer_sys::fuzz_target;
use zero_policy::forwarded::parse;
use zero_policy::{Element, Node, NodeName, Port, TrustProxy};

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

/// `bytes` without the spaces and horizontal tabs around it (RFC 9110 Section
/// 5.6.3 `OWS`).
fn trim_ows(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|&byte| byte != b' ' && byte != b'\t')
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|&byte| byte != b' ' && byte != b'\t')
        .map_or(start, |last| last + 1);
    &bytes[start..end]
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

    let rule = TrustProxy::new(vec![(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 0)), 24)]);
    let fields = (Some(forwarded), x_forwarded_for, x_forwarded_proto);
    let outsider = SocketAddr::from(([203, 0, 113, 9], 443));
    assert_eq!(rule.client(outsider, fields.0, fields.1), outsider.ip());
    assert_eq!(rule.proto(outsider, fields.0, fields.2), None);

    let proxy = SocketAddr::from(([192, 0, 2, 7], 443));
    let client = rule.client(proxy, fields.0, fields.1);
    if client != proxy.ip() {
        let first_for = elements
            .iter()
            .find_map(|element| element.for_node.as_ref())
            .and_then(Node::ip);
        let first_listed = x_forwarded_for.and_then(|value| {
            let member = value
                .split(|&byte| byte == b',')
                .map(trim_ows)
                .find(|member| !member.is_empty())?;
            std::str::from_utf8(member).ok()?.parse::<IpAddr>().ok()
        });
        assert!(Some(client) == first_for || Some(client) == first_listed);
    }
    if let Some(proto) = rule.proto(proxy, fields.0, fields.2) {
        assert_eq!(proto, proto.to_ascii_lowercase());
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
    assert_eq!(rule.client(proxy, Some(&written), None), sender);

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
