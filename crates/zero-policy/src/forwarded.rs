//! The trust-proxy rule: the client's address and scheme as the trusted proxies in
//! front of a request report them, in `Forwarded` (RFC 7239) or in
//! `X-Forwarded-For` and `X-Forwarded-Proto`, and the peer's own address otherwise.
//!
//! RFC 7239 Section 8.1: the field "cannot be relied upon to be correct, as it may
//! be modified ... by every node on the way to the server, including the client
//! making the request", and "the chain of IP addresses listed before the request
//! came to the proxy cannot be trusted". So nothing in these fields is read unless
//! the immediate peer is a configured trusted proxy; a rule reads one family of
//! fields, the one its proxies write, and never the other, which reaches the server
//! as the client sent it; and the chain is walked from the right, from the peer
//! through each trusted proxy, to the first address that is not one: the client. In
//! a chain the proxies wrote, the first `for` parameter "will disclose the client
//! where the request was first made" (Section 5.2), and the walk stops there, so
//! what a client wrote to the left of its own address is never read.

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
    split_unquoted(value, b',')
}

/// The parts of `value` between the `separator` octets that sit outside quoted
/// strings, each trimmed. A quoted-string runs from one `"` to the next one that
/// no backslash escapes (RFC 9110 Section 5.6.4), so a `,` or `;` inside one, as
/// in `host="a;b"` or `ext="a\";b"`, belongs to its value (RFC 7239 Section 4).
///
/// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-4>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.4>
fn split_unquoted(value: &[u8], separator: u8) -> Vec<&[u8]> {
    let mut parts = Vec::new();
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
        } else if byte == b'"' {
            quoted = true;
        } else if byte == separator {
            parts.push(trim(value.get(start..index).unwrap_or(&[])));
            start = index.saturating_add(1);
        }
    }
    parts.push(trim(value.get(start..).unwrap_or(&[])));
    parts
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

/// One element's pairs, separated by the semicolons outside quoted strings (RFC
/// 7239 Section 4); `None` when a parameter repeats or a pair is malformed, which
/// makes the element invalid as a whole.
///
/// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-4>
fn element(member: &[u8]) -> Option<Element<'_>> {
    let mut out = Element::default();
    let mut seen_for = false;
    let mut seen_by = false;
    for pair in split_unquoted(member, b';') {
        if pair.is_empty() {
            continue;
        }
        let at = pair.iter().position(|&byte| byte == b'=')?;
        let name = trim(pair.get(..at)?);
        let raw = trim(pair.get(at.checked_add(1)?..)?);
        let value = unquote(raw)?;
        if name.eq_ignore_ascii_case(b"for") {
            if seen_for {
                return None;
            }
            seen_for = true;
            out.for_node = Some(node(raw, &value)?);
        } else if name.eq_ignore_ascii_case(b"by") {
            if seen_by {
                return None;
            }
            seen_by = true;
            out.by = Some(node(raw, &value)?);
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

/// The node a pair's value names, from the value as it sits in the field (`raw`)
/// and with its quoting undone (`value`).
///
/// A value without quoted-pairs is parsed where it sits, so an obfuscated
/// identifier borrows the field. One with quoted-pairs is parsed with them resolved
/// (RFC 9110 Section 5.6.4) when it names an address or `unknown`. An obfuscated
/// identifier or port written with quoted-pairs is refused: its octets do not sit
/// in the field in that order, so it has nothing to borrow, and no sender needs a
/// quoted-pair there, since Section 5.6.4 says one "SHOULD NOT" be generated except
/// for `"` and `\`, which an identifier never holds (RFC 7239 Section 6.3).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.4>
/// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-6.3>
fn node<'a>(raw: &'a [u8], value: &[u8]) -> Option<Node<'a>> {
    let inner = match raw.strip_prefix(b"\"") {
        Some(inner) => inner.strip_suffix(b"\"")?,
        None => raw,
    };
    if inner == value {
        return Node::parse(inner);
    }
    let node = Node::parse(value)?;
    let name = match node.name {
        NodeName::Ip(ip) => NodeName::Ip(ip),
        NodeName::Unknown => NodeName::Unknown,
        NodeName::Obfuscated(_) => return None,
    };
    let port = match node.port {
        None => None,
        Some(Port::Number(number)) => Some(Port::Number(number)),
        Some(Port::Obfuscated(_)) => return None,
    };
    Some(Node { name, port })
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

/// The family of forwarding fields a trust-proxy rule reads: the one its trusted
/// proxies write. The other family is never read, whatever it says, since a proxy
/// that writes one passes the other through as the client sent it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ForwardingHeader {
    /// `X-Forwarded-For` names the chain, one address per member, and
    /// `X-Forwarded-Proto` the scheme.
    #[default]
    XForwardedFor,
    /// `Forwarded` (RFC 7239): the `for` parameter of each element names the chain,
    /// and the `proto` of the element that names the client is the scheme.
    Forwarded,
}

/// What the trusted proxies in front of a request report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Forwarding {
    /// The client: the first address from the right that is not a trusted proxy,
    /// the leftmost address of a chain whose every address is trusted, or the peer
    /// when it is not trusted or forwards no chain. `None` when the hop the walk
    /// reaches names no address (`unknown`, an obfuscated identifier, an element
    /// without `for`, or a member that does not parse), so the client is unknown.
    pub client: Option<IpAddr>,
    /// The scheme the proxy facing the client reported, lowercased, when it
    /// reported one.
    pub proto: Option<Vec<u8>>,
}

/// A trusted-proxy rule: the peers whose forwarding fields are believed, and the
/// family of fields they write.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustProxy {
    /// The trusted peers, as addresses with a prefix length (`/32` or `/128` for one
    /// address).
    pub trusted: Vec<(IpAddr, u8)>,
    /// The family of forwarding fields the trusted proxies write.
    pub header: ForwardingHeader,
}

impl TrustProxy {
    /// Trust no peer: every request's client is its peer.
    ///
    /// # Returns
    ///
    /// The rule.
    #[must_use]
    pub const fn none() -> Self {
        TrustProxy {
            trusted: Vec::new(),
            header: ForwardingHeader::XForwardedFor,
        }
    }

    /// Trust these peers, which write `X-Forwarded-For` and `X-Forwarded-Proto`.
    ///
    /// # Arguments
    ///
    /// * `trusted` - addresses with a prefix length; a length past the address's
    ///   width counts as the full width.
    ///
    /// # Returns
    ///
    /// The rule.
    #[must_use]
    pub fn new(trusted: Vec<(IpAddr, u8)>) -> Self {
        TrustProxy {
            trusted,
            header: ForwardingHeader::XForwardedFor,
        }
    }

    /// The same rule over another family of forwarding fields.
    ///
    /// # Arguments
    ///
    /// * `header` - the family the trusted proxies write.
    ///
    /// # Returns
    ///
    /// The rule.
    #[must_use]
    pub fn with_header(mut self, header: ForwardingHeader) -> Self {
        self.header = header;
        self
    }

    /// Whether `peer` is a trusted proxy.
    ///
    /// # Arguments
    ///
    /// * `peer` - the address.
    ///
    /// # Returns
    ///
    /// Whether a trusted prefix holds the address.
    #[must_use]
    pub fn trusts(&self, peer: IpAddr) -> bool {
        self.trusted
            .iter()
            .any(|&(network, prefix)| in_prefix(peer, network, prefix))
    }

    /// What the trusted proxies in front of a request report: its client and the
    /// scheme the client used.
    ///
    /// Nothing is read unless the peer is trusted. The chain is then walked from the
    /// right, since every proxy appends the node it received the request from and
    /// "the chain of IP addresses listed before the request came to the proxy cannot
    /// be trusted" (RFC 7239 Section 8.1): starting at the peer, while the current
    /// hop is a trusted proxy, the walk steps to the address that proxy appended, the
    /// next member to the left. The first address that is not a trusted proxy is the
    /// client, and a chain whose every address is trusted yields its leftmost one. A
    /// hop that names no address leaves the client unknown rather than letting the
    /// last trusted proxy stand in for it, since a client could otherwise take a
    /// proxy's address by sending a member that breaks the parse.
    ///
    /// Only the lines of the rule's family are read. With
    /// [`ForwardingHeader::Forwarded`], the chain is each element's `for` and the
    /// scheme is the `proto` of the element where the walk ended. Each field line is
    /// split into its elements on its own, because a quoted-string runs to the next
    /// DQUOTE that no backslash escapes (RFC 9110 Section 5.6.4) and one a client
    /// leaves open must not swallow a line a proxy added after it (RFC 7239 Section
    /// 4 lets a proxy append to the last line or add a new one); the elements of the
    /// lines then follow one another in order, as in the combined field (RFC 9110
    /// Section 5.3). An element with a repeated or malformed parameter names no
    /// address. With [`ForwardingHeader::XForwardedFor`], each member of
    /// `X-Forwarded-For` is an address, bare or in the node form of RFC 7239 Section
    /// 6 (`192.0.2.43:4711`, `[2001:db8::17]`), and the scheme is the member of
    /// `X-Forwarded-Proto` at the same position from the right as the member where
    /// the walk ended: the one the proxy facing the client added, when proxies
    /// append to both lists in step, or else the first member, which a proxy that
    /// sets a single value leaves alone. Empty members of every list are skipped
    /// (RFC 9110 Section 5.6.1.2).
    ///
    /// # Arguments
    ///
    /// * `peer` - the immediate peer.
    /// * `fields` - the request's field lines, as name and value, in the order
    ///   received; names are compared without regard to case.
    ///
    /// # Returns
    ///
    /// The client and the scheme.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1>
    /// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-4>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.4>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.1.2>
    #[must_use]
    pub fn forwarding<'a, I>(&self, peer: SocketAddr, fields: I) -> Forwarding
    where
        I: IntoIterator<Item = (&'a [u8], &'a [u8])>,
    {
        let at_peer = Forwarding {
            client: Some(peer.ip()),
            proto: None,
        };
        if !self.trusts(peer.ip()) {
            return at_peer;
        }
        let mut chain: Vec<&[u8]> = Vec::new();
        let mut schemes: Vec<&[u8]> = Vec::new();
        let (chain_name, scheme_name): (&[u8], Option<&[u8]>) = match self.header {
            ForwardingHeader::Forwarded => (&b"forwarded"[..], None),
            ForwardingHeader::XForwardedFor => {
                (&b"x-forwarded-for"[..], Some(&b"x-forwarded-proto"[..]))
            }
        };
        for (name, value) in fields {
            let list = if name.eq_ignore_ascii_case(chain_name) {
                &mut chain
            } else if scheme_name.is_some_and(|scheme| name.eq_ignore_ascii_case(scheme)) {
                &mut schemes
            } else {
                continue;
            };
            list.extend(
                list_members(value)
                    .into_iter()
                    .filter(|member| !member.is_empty()),
            );
        }
        match self.header {
            ForwardingHeader::Forwarded => self.walk_elements(&chain, at_peer),
            ForwardingHeader::XForwardedFor => self.walk_addresses(&chain, &schemes, at_peer),
        }
    }

    /// Walk `Forwarded` elements from the right; the scheme is the `proto` of the
    /// element where the walk ended.
    fn walk_elements(&self, members: &[&[u8]], mut walked: Forwarding) -> Forwarding {
        for member in members.iter().rev() {
            let parsed = element(member);
            walked.proto = parsed.as_ref().and_then(|found| found.proto.clone());
            let address = parsed
                .as_ref()
                .and_then(|found| found.for_node.as_ref())
                .and_then(Node::ip);
            walked.client = address;
            if !address.is_some_and(|address| self.trusts(address)) {
                break;
            }
        }
        walked
    }

    /// Walk `X-Forwarded-For` members from the right; the scheme is the
    /// `X-Forwarded-Proto` member at the position where the walk ended.
    fn walk_addresses(
        &self,
        members: &[&[u8]],
        schemes: &[&[u8]],
        mut walked: Forwarding,
    ) -> Forwarding {
        let mut position = 1usize;
        for (index, member) in members.iter().rev().enumerate() {
            position = index.saturating_add(1);
            let address = std::str::from_utf8(member)
                .ok()
                .and_then(|text| text.parse::<IpAddr>().ok())
                .or_else(|| Node::parse(member).as_ref().and_then(Node::ip));
            walked.client = address;
            if !address.is_some_and(|address| self.trusts(address)) {
                break;
            }
        }
        walked.proto = schemes
            .len()
            .checked_sub(position)
            .and_then(|index| schemes.get(index))
            .or_else(|| schemes.first())
            .filter(|scheme| scheme.iter().all(|&byte| is_tchar(byte)))
            .map(|scheme| scheme.to_ascii_lowercase());
        walked
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
