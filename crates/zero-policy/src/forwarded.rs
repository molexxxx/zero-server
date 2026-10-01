//! The trust-proxy rule: the client's address, scheme and host as a trusted proxy
//! reported them in `Forwarded` (RFC 7239) or the `X-Forwarded-*` fields, and the
//! peer's own address otherwise.
//!
//! RFC 7239 Section 8.1: the field "cannot be relied upon to be correct, as it may
//! be modified ... by every node on the way to the server, including the client",
//! and the one approach it names is "to verify the correctness of proxies and to
//! whitelist them as trusted". So nothing in these fields is read unless the
//! immediate peer is a configured trusted proxy, and then the first `for` value is
//! the originating client (Section 5.2: "the first 'for' parameter will disclose
//! the client where the request was first made, followed by any subsequent proxy
//! identifiers").

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// A node identifier of RFC 7239 Section 6: an address, `unknown`, or an
/// obfuscated token, each with an optional port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node<'a> {
    /// Who the node is.
    pub name: NodeName<'a>,
    /// The port, when given.
    pub port: Option<Port<'a>>,
}

/// The `nodename` of a node identifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeName<'a> {
    /// An IP address.
    Ip(IpAddr),
    /// `unknown`: the proxy does not know the preceding entity (Section 6.2).
    Unknown,
    /// A generated identifier with its leading underscore (Section 6.3).
    Obfuscated(&'a [u8]),
}

/// The `node-port` of a node identifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Port<'a> {
    /// A port number.
    Number(u16),
    /// A generated identifier with its leading underscore.
    Obfuscated(&'a [u8]),
}

impl<'a> Node<'a> {
    /// Parses a node identifier after quoted-string unescaping.
    ///
    /// # Arguments
    ///
    /// * `value` - the `node` text: `nodename [ ":" node-port ]`.
    ///
    /// # Returns
    ///
    /// The node, or `None` when the text is not one.
    #[must_use]
    pub fn parse(value: &'a [u8]) -> Option<Self> {
        let (name, port) = if let Some(rest) = value.strip_prefix(b"[") {
            // An IPv6 address is always in brackets; what follows may be a port.
            let close = rest.iter().position(|&byte| byte == b']')?;
            let address = std::str::from_utf8(rest.get(..close)?).ok()?;
            let ip: Ipv6Addr = address.parse().ok()?;
            let tail = rest.get(close.checked_add(1)?..)?;
            let port = match tail.strip_prefix(b":") {
                Some(port) => Some(Port::parse(port)?),
                None if tail.is_empty() => None,
                None => return None,
            };
            (NodeName::Ip(IpAddr::V6(ip)), port)
        } else {
            let (name, port) = match value.iter().position(|&byte| byte == b':') {
                Some(at) => (
                    value.get(..at)?,
                    Some(Port::parse(value.get(at.checked_add(1)?..)?)?),
                ),
                None => (value, None),
            };
            (NodeName::parse(name)?, port)
        };
        Some(Node { name, port })
    }

    /// The node's address, when it is one.
    #[must_use]
    pub const fn ip(&self) -> Option<IpAddr> {
        match self.name {
            NodeName::Ip(ip) => Some(ip),
            NodeName::Unknown | NodeName::Obfuscated(_) => None,
        }
    }
}

/// Whether `bytes` is `"_" 1*( ALPHA / DIGIT / "." / "_" / "-")`.
fn is_obfuscated(bytes: &[u8]) -> bool {
    bytes.len() > 1
        && bytes.first() == Some(&b'_')
        && bytes
            .iter()
            .all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

impl<'a> NodeName<'a> {
    fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.eq_ignore_ascii_case(b"unknown") {
            return Some(NodeName::Unknown);
        }
        if is_obfuscated(bytes) {
            return Some(NodeName::Obfuscated(bytes));
        }
        let text = std::str::from_utf8(bytes).ok()?;
        let ip: Ipv4Addr = text.parse().ok()?;
        Some(NodeName::Ip(IpAddr::V4(ip)))
    }
}

impl<'a> Port<'a> {
    fn parse(bytes: &'a [u8]) -> Option<Self> {
        if is_obfuscated(bytes) {
            return Some(Port::Obfuscated(bytes));
        }
        if bytes.is_empty() || bytes.len() > 5 || !bytes.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let text = std::str::from_utf8(bytes).ok()?;
        text.parse().ok().map(Port::Number)
    }
}

/// One `forwarded-element`: the parameters a proxy added.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Element<'a> {
    /// `for`: the node making the request to the proxy.
    pub for_node: Option<Node<'a>>,
    /// `by`: the proxy's user-agent facing interface.
    pub by: Option<Node<'a>>,
    /// `host`: the `Host` field as the proxy received it.
    pub host: Option<Vec<u8>>,
    /// `proto`: the scheme the request was made with.
    pub proto: Option<Vec<u8>>,
}

/// The members of a comma-separated list, outside quoted strings, each trimmed.
fn list_members(value: &[u8]) -> Vec<&[u8]> {
    let mut members = Vec::new();
    let mut start = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for (index, &byte) in value.iter().enumerate() {
        if escaped {
            escaped = false;
        } else if quoted {
            match byte {
                b'\\' => escaped = true,
                b'"' => quoted = false,
                _ => {}
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b',' => {
                    members.push(trim(value.get(start..index).unwrap_or(&[])));
                    start = index.saturating_add(1);
                }
                _ => {}
            }
        }
    }
    members.push(trim(value.get(start..).unwrap_or(&[])));
    members
}

fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|&byte| byte != b' ' && byte != b'\t')
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|&byte| byte != b' ' && byte != b'\t')
        .map_or(start, |last| last.saturating_add(1));
    bytes.get(start..end).unwrap_or(&[])
}

/// A `value`: a token as is, or a quoted-string with its escapes undone.
fn unquote(value: &[u8]) -> Option<Vec<u8>> {
    let Some(inner) = value.strip_prefix(b"\"") else {
        if value.is_empty() || !value.iter().all(|&byte| is_tchar(byte)) {
            return None;
        }
        return Some(value.to_vec());
    };
    let inner = inner.strip_suffix(b"\"")?;
    let mut out = Vec::with_capacity(inner.len());
    let mut escaped = false;
    for &byte in inner {
        if escaped {
            out.push(byte);
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            return None;
        } else {
            out.push(byte);
        }
    }
    if escaped {
        return None;
    }
    Some(out)
}

/// `tchar` of RFC 9110 Section 5.6.2.
const fn is_tchar(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

/// One element's pairs; `None` when a parameter repeats or a pair is malformed,
/// which makes the element invalid as a whole.
fn element(member: &[u8]) -> Option<Element<'_>> {
    let mut out = Element::default();
    let mut seen_for = false;
    let mut seen_by = false;
    for pair in member.split(|&byte| byte == b';') {
        let pair = trim(pair);
        if pair.is_empty() {
            continue;
        }
        let at = pair.iter().position(|&byte| byte == b'=')?;
        let name = trim(pair.get(..at)?);
        let value = unquote(trim(pair.get(at.checked_add(1)?..)?))?;
        if name.eq_ignore_ascii_case(b"for") {
            if seen_for {
                return None;
            }
            seen_for = true;
            out.for_node = Some(parse_owned_node(member, pair, &value)?);
        } else if name.eq_ignore_ascii_case(b"by") {
            if seen_by {
                return None;
            }
            seen_by = true;
            out.by = Some(parse_owned_node(member, pair, &value)?);
        } else if name.eq_ignore_ascii_case(b"host") {
            if out.host.is_some() {
                return None;
            }
            out.host = Some(value);
        } else if name.eq_ignore_ascii_case(b"proto") {
            if out.proto.is_some() {
                return None;
            }
            out.proto = Some(value.to_ascii_lowercase());
        }
    }
    Some(out)
}

/// A node from an unquoted value, borrowed from the field; a quoted one with
/// escapes is rare enough to be parsed from the original quoted text when it has
/// none, and refused otherwise.
fn parse_owned_node<'a>(member: &'a [u8], pair: &'a [u8], value: &[u8]) -> Option<Node<'a>> {
    let at = pair.iter().position(|&byte| byte == b'=')?;
    let raw = trim(pair.get(at.checked_add(1)?..)?);
    let borrowed = match raw.strip_prefix(b"\"") {
        Some(inner) => inner.strip_suffix(b"\"")?,
        None => raw,
    };
    if borrowed != value {
        return None;
    }
    let _ = member;
    Node::parse(borrowed)
}

/// Parses a `Forwarded` field value into its elements, first proxy first; an
/// element with a repeated or malformed parameter is left out.
///
/// # Arguments
///
/// * `value` - the field value; several field lines are joined with commas first.
#[must_use]
pub fn parse(value: &[u8]) -> Vec<Element<'_>> {
    list_members(value)
        .into_iter()
        .filter(|member| !member.is_empty())
        .filter_map(element)
        .collect()
}

/// A trusted-proxy rule: the peers whose forwarding fields are believed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustProxy {
    /// The trusted peers, as addresses with a prefix length (`/32` or `/128` for one
    /// address).
    pub trusted: Vec<(IpAddr, u8)>,
}

impl TrustProxy {
    /// Trust no peer: every request's client is its peer.
    #[must_use]
    pub const fn none() -> Self {
        TrustProxy {
            trusted: Vec::new(),
        }
    }

    /// Trust these peers.
    ///
    /// # Arguments
    ///
    /// * `trusted` - addresses with a prefix length; a length past the address's
    ///   width counts as the full width.
    #[must_use]
    pub fn new(trusted: Vec<(IpAddr, u8)>) -> Self {
        TrustProxy { trusted }
    }

    /// Whether `peer` is a trusted proxy.
    #[must_use]
    pub fn trusts(&self, peer: IpAddr) -> bool {
        self.trusted
            .iter()
            .any(|&(network, prefix)| in_prefix(peer, network, prefix))
    }

    /// The client of a request: the first `for` of `Forwarded`, else the first
    /// `X-Forwarded-For` address, when the peer is trusted; the peer otherwise.
    ///
    /// # Arguments
    ///
    /// * `peer` - the immediate peer.
    /// * `forwarded` - the `Forwarded` field value, joined, if any.
    /// * `x_forwarded_for` - the `X-Forwarded-For` field value, joined, if any.
    #[must_use]
    pub fn client(
        &self,
        peer: SocketAddr,
        forwarded: Option<&[u8]>,
        x_forwarded_for: Option<&[u8]>,
    ) -> IpAddr {
        if !self.trusts(peer.ip()) {
            return peer.ip();
        }
        if let Some(value) = forwarded {
            if let Some(ip) = parse(value)
                .iter()
                .find_map(|element| element.for_node.as_ref())
                .and_then(Node::ip)
            {
                return ip;
            }
        }
        if let Some(value) = x_forwarded_for {
            if let Some(ip) = list_members(value)
                .into_iter()
                .find(|member| !member.is_empty())
                .and_then(|member| std::str::from_utf8(member).ok())
                .and_then(|text| text.parse::<IpAddr>().ok())
            {
                return ip;
            }
        }
        peer.ip()
    }

    /// The scheme the client used as a trusted proxy reported it (`proto` of
    /// `Forwarded`, else `X-Forwarded-Proto`), lowercased; `None` when the peer is
    /// not trusted or nothing was reported.
    #[must_use]
    pub fn proto(
        &self,
        peer: SocketAddr,
        forwarded: Option<&[u8]>,
        x_forwarded_proto: Option<&[u8]>,
    ) -> Option<Vec<u8>> {
        if !self.trusts(peer.ip()) {
            return None;
        }
        if let Some(proto) =
            forwarded.and_then(|value| parse(value).into_iter().find_map(|element| element.proto))
        {
            return Some(proto);
        }
        x_forwarded_proto
            .and_then(|value| list_members(value).into_iter().next())
            .filter(|member| !member.is_empty() && member.iter().all(|&byte| is_tchar(byte)))
            .map(<[u8]>::to_ascii_lowercase)
    }
}

/// Whether `ip` is within `network/prefix`.
fn in_prefix(ip: IpAddr, network: IpAddr, prefix: u8) -> bool {
    match (ip, network) {
        (IpAddr::V4(ip), IpAddr::V4(network)) => {
            let prefix = u32::from(prefix.min(32));
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX.wrapping_shl(32u32.saturating_sub(prefix))
            };
            u32::from(ip) & mask == u32::from(network) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(network)) => {
            let prefix = u32::from(prefix.min(128));
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX.wrapping_shl(128u32.saturating_sub(prefix))
            };
            u128::from(ip) & mask == u128::from(network) & mask
        }
        (IpAddr::V4(ip), IpAddr::V6(network)) => {
            in_prefix(IpAddr::V6(ip.to_ipv6_mapped()), IpAddr::V6(network), prefix)
        }
        (IpAddr::V6(ip), IpAddr::V4(network)) => ip
            .to_ipv4_mapped()
            .is_some_and(|ip| in_prefix(IpAddr::V4(ip), IpAddr::V4(network), prefix)),
    }
}
