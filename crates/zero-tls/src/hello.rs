//! The client's hello, read before any session exists.
//!
//! rustls's `Acceptor` reassembles the hello from the bytes a connection delivers, in
//! whatever pieces they arrive: bytes it cannot take yet stay queued here until it
//! has processed what it holds, so a hello spread over several records loses none.
//! Once the hello is whole, the version and the TLS 1.3 extensions it offers are
//! checked on its raw bytes before the server name picks an identity, so each refusal
//! carries the alert its RFC names: `protocol_version` for a client that offers no
//! version the server speaks (RFC 8996 Sections 4 and 5, RFC 9846 Appendix E.2) and
//! for a TLS 1.3 hello whose `legacy_version` is not 0x0303 (RFC 9846 Section 4.1.2),
//! and `missing_extension` for a TLS 1.3 hello without the extensions RFC 9846
//! Section 9.2 requires. rustls checks other things first and would answer these
//! with `handshake_failure`. Versions come from `supported_versions` when the hello
//! carries it and from `legacy_version` otherwise (RFC 9846 Section 4.3.1).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc8996.html#section-4>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-4.1.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-4.3.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-9.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#appendix-E.2>
//! @see <https://docs.rs/rustls/0.23.45/rustls/server/struct.Acceptor.html>

use std::io;

use rustls::server::Acceptor;

use crate::buffered::tls_error;

/// The alert description `protocol_version` (RFC 9846 Section 6.2).
pub(crate) const PROTOCOL_VERSION: u8 = 70;

/// The alert description `missing_extension` (RFC 9846 Section 6.2).
pub(crate) const MISSING_EXTENSION: u8 = 109;

/// The alert description `unrecognized_name` (RFC 9846 Section 6.2).
pub(crate) const UNRECOGNIZED_NAME: u8 = 112;

/// The record content type of a handshake message.
const HANDSHAKE: u8 = 22;

/// The handshake type of a client hello.
const CLIENT_HELLO: u8 = 1;

/// The extensions the checks read.
const SUPPORTED_GROUPS: u16 = 10;
const SIGNATURE_ALGORITHMS: u16 = 13;
const PRE_SHARED_KEY: u16 = 41;
const SUPPORTED_VERSIONS: u16 = 43;
const KEY_SHARE: u16 = 51;

/// The protocol versions on the wire.
const TLS12: u16 = 0x0303;
const TLS13: u16 = 0x0304;

/// A fatal alert record, sent in the clear before any key exists, with the record
/// version 0x0303 that RFC 9846 Section 5.1 sets for every record but the first hello.
pub(crate) const fn fatal_alert(description: u8) -> [u8; 7] {
    [0x15, 0x03, 0x03, 0x00, 0x02, 0x02, description]
}

/// What the reader decided once the hello was whole.
#[derive(Debug)]
pub(crate) enum Hello {
    /// The server name, if any, and every byte read so far.
    Read(Option<String>, Vec<u8>),
    /// The alert record to send, and why.
    Refused(Vec<u8>, io::Error),
}

/// Reads one client hello from a connection's first bytes.
pub(crate) struct HelloReader {
    acceptor: Acceptor,
    bytes: Vec<u8>,
    fed: usize,
    tls12: bool,
}

impl std::fmt::Debug for HelloReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HelloReader")
            .field("bytes", &self.bytes.len())
            .field("fed", &self.fed)
            .finish_non_exhaustive()
    }
}

impl HelloReader {
    /// A reader for a server that speaks TLS 1.3, and TLS 1.2 when `tls12` is set.
    pub(crate) fn new(tls12: bool) -> Self {
        HelloReader {
            acceptor: Acceptor::default(),
            bytes: Vec::new(),
            fed: 0,
            tls12,
        }
    }

    /// How many bytes were read so far.
    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Take the next bytes the connection delivered.
    ///
    /// # Returns
    ///
    /// The decision once the hello is whole or refused, `None` while it is not.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Option<Hello> {
        self.bytes.extend_from_slice(chunk);
        loop {
            let pending = self.bytes.get(self.fed..).unwrap_or(&[]);
            let mut rest = pending;
            while !rest.is_empty() {
                match self.acceptor.read_tls(&mut rest) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let took = pending.len().saturating_sub(rest.len());
            self.fed = self.fed.saturating_add(took);
            let verdict = match self.acceptor.accept() {
                Ok(None) if took > 0 && self.fed < self.bytes.len() => continue,
                Ok(None) => return None,
                Ok(Some(accepted)) => Ok(accepted.client_hello().server_name().map(str::to_owned)),
                Err((err, mut alert)) => {
                    let mut record = Vec::new();
                    let _ = alert.write_all(&mut record);
                    Err((record, err))
                }
            };
            return Some(self.decide(verdict));
        }
    }

    /// Check the whole hello's versions and extensions, then take rustls's verdict.
    fn decide(&mut self, verdict: Result<Option<String>, (Vec<u8>, rustls::Error)>) -> Hello {
        if let Some(offer) = first_message(&self.bytes).and_then(|body| offer(&body)) {
            if !offer.tls13 && !(offer.tls12 && self.tls12) {
                return Hello::Refused(
                    fatal_alert(PROTOCOL_VERSION).to_vec(),
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the client offers no TLS version the server speaks",
                    ),
                );
            }
            if offer.tls13 && offer.legacy != TLS12 {
                return Hello::Refused(
                    fatal_alert(PROTOCOL_VERSION).to_vec(),
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "a TLS 1.3 hello whose legacy_version is not 0x0303",
                    ),
                );
            }
            if offer.tls13 && !offer.conforms {
                return Hello::Refused(
                    fatal_alert(MISSING_EXTENSION).to_vec(),
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "a TLS 1.3 hello without the extensions RFC 9846 Section 9.2 requires",
                    ),
                );
            }
        }
        match verdict {
            Ok(name) => Hello::Read(name, std::mem::take(&mut self.bytes)),
            Err((record, err)) => Hello::Refused(record, tls_error(err)),
        }
    }
}

/// What a hello offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Offer {
    legacy: u16,
    tls13: bool,
    tls12: bool,
    /// For a TLS 1.3 offer, whether it has the extensions RFC 9846 Section 9.2
    /// requires: `signature_algorithms` and `supported_groups` unless it carries
    /// `pre_shared_key`, and `supported_groups` and `key_share` together.
    conforms: bool,
}

/// Bytes read front to back; every read is checked.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes }
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let taken = self.bytes.get(..count)?;
        self.bytes = self.bytes.get(count..)?;
        Some(taken)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take(1)?.first().copied()
    }

    fn u16(&mut self) -> Option<u16> {
        let bytes = self.take(2)?;
        Some(u16::from_be_bytes([*bytes.first()?, *bytes.get(1)?]))
    }

    fn u24(&mut self) -> Option<usize> {
        let bytes = self.take(3)?;
        Some(
            usize::from(*bytes.first()?) << 16
                | usize::from(*bytes.get(1)?) << 8
                | usize::from(*bytes.get(2)?),
        )
    }
}

/// The body of the client hello the handshake records at the start of `bytes`
/// carry, reassembled; `None` when they hold something else or not all of it.
fn first_message(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut records = Reader::new(bytes);
    let mut message = Vec::new();
    loop {
        if records.u8()? != HANDSHAKE {
            return None;
        }
        records.take(2)?;
        let length = records.u16()?;
        message.extend_from_slice(records.take(usize::from(length))?);
        let mut header = Reader::new(&message);
        if let (Some(kind), Some(length)) = (header.u8(), header.u24()) {
            if kind != CLIENT_HELLO {
                return None;
            }
            if let Some(body) = header.take(length) {
                return Some(body.to_vec());
            }
        }
    }
}

/// What a client hello body offers; `None` when it is malformed, which rustls then
/// answers itself.
fn offer(body: &[u8]) -> Option<Offer> {
    let mut hello = Reader::new(body);
    let legacy = hello.u16()?;
    hello.take(32)?;
    let session = hello.u8()?;
    hello.take(usize::from(session))?;
    let suites = hello.u16()?;
    hello.take(usize::from(suites))?;
    let compression = hello.u8()?;
    hello.take(usize::from(compression))?;
    let mut versions: Option<Vec<u16>> = None;
    let (mut signatures, mut groups, mut shares, mut psk) = (false, false, false, false);
    if !hello.is_empty() {
        let length = hello.u16()?;
        let mut extensions = Reader::new(hello.take(usize::from(length))?);
        while !extensions.is_empty() {
            let kind = extensions.u16()?;
            let length = extensions.u16()?;
            let data = extensions.take(usize::from(length))?;
            match kind {
                SUPPORTED_VERSIONS => {
                    let mut data = Reader::new(data);
                    let count = data.u8()?;
                    let mut list = Reader::new(data.take(usize::from(count))?);
                    let mut offered = Vec::new();
                    while !list.is_empty() {
                        offered.push(list.u16()?);
                    }
                    versions = Some(offered);
                }
                SIGNATURE_ALGORITHMS => signatures = true,
                SUPPORTED_GROUPS => groups = true,
                KEY_SHARE => shares = true,
                PRE_SHARED_KEY => psk = true,
                _ => {}
            }
        }
    }
    let (tls13, tls12) = match &versions {
        Some(offered) => (offered.contains(&TLS13), offered.contains(&TLS12)),
        None => (false, legacy >= TLS12),
    };
    let conforms = (psk || (signatures && groups)) && groups == shares;
    Some(Offer {
        legacy,
        tls13,
        tls12,
        conforms,
    })
}
