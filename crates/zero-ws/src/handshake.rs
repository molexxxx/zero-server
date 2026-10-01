//! The server side of the opening handshake.
//!
//! [`negotiate`] reads the client's handshake (RFC 6455 Section 4.2.1): "An HTTP/1.1
//! or higher GET request", a `Host` field, an `Upgrade` field "containing the value
//! `websocket`, treated as an ASCII case-insensitive value", a `Connection` field
//! "that includes the token `Upgrade`", a `Sec-WebSocket-Key` "that, when decoded, is
//! 16 bytes in length", and a `Sec-WebSocket-Version` "with a value of 13". A request
//! that does not match is refused with 400; a version other than 13 with 426 Upgrade
//! Required and `Sec-WebSocket-Version: 13` (Section 4.2.2, step 4, /version/); and,
//! when the server keeps an Origin allow list, an Origin outside it with 403 Forbidden
//! (Section 10.2). A request without `Origin` does not come from a browser (Section
//! 4.2.1, item 7), so the allow list does not apply to it.
//!
//! The subprotocol is "one of the values from the |Sec-WebSocket-Protocol| field that
//! the server is willing to use", taken in the client's order of preference, and when
//! none matches no `Sec-WebSocket-Protocol` is sent (Section 4.2.2, /subprotocol/). No
//! extension is accepted, so `Sec-WebSocket-Extensions` is never sent and every RSV
//! bit must stay zero (Section 9).
//!
//! [`accept`] builds `Sec-WebSocket-Accept`: the key "with the string
//! `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`", hashed with SHA-1 and base64-encoded
//! (Section 4.2.2, step 5.4), into a 28-byte stack buffer.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.1>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2>

use zero_base64::{decode_slice, encode_slice, Alphabet};
use zero_core::{Digest, Error, Result};
use zero_http_types::{Method, StatusCode};

/// The GUID the accept value appends to the key.
pub const GUID: &[u8; 36] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// The length of a valid `Sec-WebSocket-Key`: 16 bytes in base64 with padding.
pub const KEY_LEN: usize = 24;

/// The length of `Sec-WebSocket-Accept`: a 20-byte SHA-1 digest in base64.
pub const ACCEPT_LEN: usize = 28;

/// The only protocol version this server speaks.
pub const VERSION: &[u8] = b"13";

/// What the server is willing to agree to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Config<'c> {
    /// The subprotocols the server speaks; empty for none.
    pub protocols: &'c [&'c [u8]],
    /// The serialized origins a browser may connect from, compared ASCII
    /// case-insensitively; `None` accepts any origin.
    pub origins: Option<&'c [&'c [u8]]>,
}

/// A handshake the server accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Accepted<'a> {
    /// The client's `Sec-WebSocket-Key`, as sent.
    pub key: &'a [u8],
    /// The subprotocol chosen from the client's offer, if any.
    pub protocol: Option<&'a [u8]>,
}

/// Why a handshake was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// Not a GET request.
    Method,
    /// Older than HTTP/1.1.
    HttpVersion,
    /// No `Host` field.
    Host,
    /// No `Upgrade` field naming `websocket`.
    Upgrade,
    /// No `Connection` field with the `Upgrade` token.
    Connection,
    /// `Sec-WebSocket-Key` missing, repeated, or not 16 bytes in base64.
    Key,
    /// `Sec-WebSocket-Version` missing.
    MissingVersion,
    /// `Sec-WebSocket-Version` other than 13.
    Version,
    /// `Origin` outside the allow list.
    Origin,
}

/// A refused handshake: the status to answer with and the fields that go with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// What was wrong.
    pub reason: Reason,
    /// 400, 426 or 403.
    pub status: StatusCode,
    /// The response fields: `Sec-WebSocket-Version: 13` with a 426, else none.
    pub fields: &'static [(&'static [u8], &'static [u8])],
}

/// The fields a 426 carries: the versions the server understands.
const VERSION_FIELDS: &[(&[u8], &[u8])] = &[(b"Sec-WebSocket-Version", VERSION)];

impl Refusal {
    fn new(reason: Reason) -> Self {
        let (status, fields) = match reason {
            Reason::Version => (StatusCode::UPGRADE_REQUIRED, VERSION_FIELDS),
            Reason::Origin => (StatusCode::FORBIDDEN, &[][..]),
            _ => (StatusCode::BAD_REQUEST, &[][..]),
        };
        Refusal {
            reason,
            status,
            fields,
        }
    }
}

/// One header field that must appear at most once.
#[derive(Clone, Copy, Debug, Default)]
enum Single<'a> {
    #[default]
    Absent,
    Once(&'a [u8]),
    Repeated,
}

impl<'a> Single<'a> {
    fn put(&mut self, value: &'a [u8]) {
        *self = match self {
            Single::Absent => Single::Once(value),
            Single::Once(_) | Single::Repeated => Single::Repeated,
        };
    }
}

/// Read and check a client's opening handshake.
///
/// # Arguments
///
/// * `method` - the request method, or `None` for one outside the registry.
/// * `http11_or_later` - whether the request is HTTP/1.1 or later.
/// * `fields` - the request's header fields as name and value, values without their
///   surrounding whitespace.
/// * `config` - the subprotocols and origins the server accepts.
///
/// # Returns
///
/// The key and the chosen subprotocol.
///
/// # Errors
///
/// A [`Refusal`] with the status and fields to answer with instead of upgrading.
pub fn negotiate<'a, I>(
    method: Option<Method>,
    http11_or_later: bool,
    fields: I,
    config: &Config<'_>,
) -> core::result::Result<Accepted<'a>, Refusal>
where
    I: IntoIterator<Item = (&'a [u8], &'a [u8])>,
{
    let mut host = false;
    let mut upgrade = false;
    let mut connection = false;
    let mut key = Single::Absent;
    let mut version = Single::Absent;
    let mut origin = Single::Absent;
    let mut protocol: Option<&'a [u8]> = None;
    for (name, value) in fields {
        if name.eq_ignore_ascii_case(b"host") {
            host = true;
        } else if name.eq_ignore_ascii_case(b"upgrade") {
            upgrade = upgrade || has_token(value, b"websocket");
        } else if name.eq_ignore_ascii_case(b"connection") {
            connection = connection || has_token(value, b"upgrade");
        } else if name.eq_ignore_ascii_case(b"sec-websocket-key") {
            key.put(value);
        } else if name.eq_ignore_ascii_case(b"sec-websocket-version") {
            version.put(value);
        } else if name.eq_ignore_ascii_case(b"origin") {
            origin.put(value);
        } else if name.eq_ignore_ascii_case(b"sec-websocket-protocol") && protocol.is_none() {
            protocol = elements(value).find(|offered| {
                config
                    .protocols
                    .iter()
                    .any(|supported| supported == offered)
            });
        }
    }
    let refuse = |reason| Err(Refusal::new(reason));
    if method != Some(Method::Get) {
        return refuse(Reason::Method);
    }
    if !http11_or_later {
        return refuse(Reason::HttpVersion);
    }
    if !host {
        return refuse(Reason::Host);
    }
    if !upgrade {
        return refuse(Reason::Upgrade);
    }
    if !connection {
        return refuse(Reason::Connection);
    }
    let Single::Once(key) = key else {
        return refuse(Reason::Key);
    };
    if !is_valid_key(key) {
        return refuse(Reason::Key);
    }
    match version {
        Single::Absent => return refuse(Reason::MissingVersion),
        Single::Once(value) if value == VERSION => {}
        Single::Once(_) | Single::Repeated => return refuse(Reason::Version),
    }
    if let Some(allowed) = config.origins {
        let permitted = match origin {
            Single::Absent => true,
            Single::Once(value) => allowed
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(value)),
            Single::Repeated => false,
        };
        if !permitted {
            return refuse(Reason::Origin);
        }
    }
    Ok(Accepted { key, protocol })
}

/// Whether a key is base64 for exactly 16 bytes.
fn is_valid_key(key: &[u8]) -> bool {
    let mut decoded = [0u8; 18];
    key.len() == KEY_LEN && decode_slice(key, Alphabet::Standard, true, &mut decoded) == Ok(16)
}

/// The comma-separated elements of a field value, without surrounding whitespace,
/// empty elements skipped.
fn elements(value: &[u8]) -> impl Iterator<Item = &[u8]> {
    value
        .split(|&byte| byte == b',')
        .map(<[u8]>::trim_ascii)
        .filter(|element| !element.is_empty())
}

/// Whether a comma-separated field value lists `token`, ASCII case-insensitively.
fn has_token(value: &[u8], token: &[u8]) -> bool {
    elements(value).any(|element| element.eq_ignore_ascii_case(token))
}

/// The `Sec-WebSocket-Accept` value for a key.
///
/// # Arguments
///
/// * `key` - the client's `Sec-WebSocket-Key`, as sent.
/// * `sha1` - a SHA-1 implementation.
///
/// # Returns
///
/// The 28 base64 characters.
///
/// # Errors
///
/// [`Error::Protocol`] for a key that is not 24 bytes long, or the digest's error.
pub fn accept(key: &[u8], sha1: &dyn Digest) -> Result<[u8; ACCEPT_LEN]> {
    let mut input = [0u8; KEY_LEN + GUID.len()];
    let (head, tail) = input.split_at_mut(KEY_LEN);
    if key.len() != KEY_LEN {
        return Err(Error::Protocol(alloc::format!(
            "a Sec-WebSocket-Key is {KEY_LEN} bytes, not {}",
            key.len()
        )));
    }
    head.copy_from_slice(key);
    tail.copy_from_slice(GUID);
    let mut digest = [0u8; 20];
    sha1.digest(&input, &mut digest)?;
    let mut out = [0u8; ACCEPT_LEN];
    encode_slice(&digest, Alphabet::Standard, true, &mut out)
        .map_err(|err| Error::Codec(alloc::format!("{err:?}")))?;
    Ok(out)
}

impl Accepted<'_> {
    /// The fields of the `101 Switching Protocols` response.
    ///
    /// # Arguments
    ///
    /// * `sha1` - a SHA-1 implementation for the accept value.
    ///
    /// # Returns
    ///
    /// `Upgrade`, `Connection`, `Sec-WebSocket-Accept` and, when one was chosen,
    /// `Sec-WebSocket-Protocol`.
    ///
    /// # Errors
    ///
    /// The digest's error.
    pub fn response_fields(&self, sha1: &dyn Digest) -> Result<ResponseFields> {
        Ok(ResponseFields {
            accept: accept(self.key, sha1)?,
            protocol: self.protocol.map(<[u8]>::to_vec),
        })
    }
}

/// The fields of a `101 Switching Protocols` response, owned so they outlive the
/// request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResponseFields {
    accept: [u8; ACCEPT_LEN],
    protocol: Option<alloc::vec::Vec<u8>>,
}

impl ResponseFields {
    /// The fields in the order they are written.
    ///
    /// # Returns
    ///
    /// Name and value pairs.
    pub fn iter(&self) -> impl Iterator<Item = (&'static [u8], &[u8])> {
        [
            Some((&b"Upgrade"[..], &b"websocket"[..])),
            Some((&b"Connection"[..], &b"Upgrade"[..])),
            Some((&b"Sec-WebSocket-Accept"[..], &self.accept[..])),
            self.protocol
                .as_deref()
                .map(|protocol| (&b"Sec-WebSocket-Protocol"[..], protocol)),
        ]
        .into_iter()
        .flatten()
    }
}
