//! The client's hello, read before any session exists.
//!
//! rustls's `Acceptor` reassembles the hello from the bytes a connection delivers, in
//! whatever pieces they arrive: bytes it cannot take yet stay queued here until it
//! has processed what it holds, so a hello spread over several records loses none.
//! A record that is neither a handshake nor an alert record and arrives before the
//! hello is whole, a `change_cipher_spec` record among them, is an unexpected record
//! type and is refused with `unexpected_message` (RFC 9846 Section 5); handshake
//! records carrying the hello admit no other record between them (Section 5.1).
//! rustls refuses these without an alert record.
//!
//! Once the hello is whole, the version and the TLS 1.3 extensions it offers are
//! checked on its raw bytes before the server name picks an identity, so each refusal
//! carries the alert its RFC names: `protocol_version` for a client that offers no
//! version the server speaks (RFC 8996 Sections 4 and 5, RFC 9846 Appendix E.2), for
//! a hello whose `legacy_version` is below 0x0303 whatever `supported_versions`
//! offers (RFC 8996 Sections 4 and 5 for {03,01} and {03,02}, RFC 9846 Section 4.2.2
//! and Appendix E.5), and for a TLS 1.3 hello whose `legacy_version` is not 0x0303
//! (RFC 9846 Section 4.2.2), and `missing_extension` for a TLS 1.3 hello without the
//! extensions RFC 9846 Section 9.2 requires. rustls checks other things first and
//! would answer these with `handshake_failure`. Versions come from
//! `supported_versions` when the hello carries it and from `legacy_version`
//! otherwise (RFC 9846 Section 4.3.1), so a hello without the extension whose
//! `legacy_version` is 0x0304 or later is read as TLS 1.2, which Section 4.3.1
//! requires of a server that also speaks TLS 1.2.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc8996.html#section-4>
//! @see <https://www.rfc-editor.org/rfc/rfc8996.html#section-5>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-4.2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-4.3.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-5>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-5.1>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-9.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#appendix-E.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#appendix-E.5>
//! @see <https://docs.rs/rustls/0.23.45/rustls/server/struct.Acceptor.html>

use std::io;

use rustls::server::Acceptor;
use rustls::ContentType;

use crate::buffered::tls_error;

/// The alert description `protocol_version` (RFC 9846 Section 6.2).
pub(crate) const PROTOCOL_VERSION: u8 = 70;

/// The alert description `missing_extension` (RFC 9846 Section 6.2).
pub(crate) const MISSING_EXTENSION: u8 = 109;

/// The alert description `unrecognized_name` (RFC 9846 Section 6.2).
pub(crate) const UNRECOGNIZED_NAME: u8 = 112;

/// The alert description `unexpected_message` (RFC 9846 Section 6.2).
pub(crate) const UNEXPECTED_MESSAGE: u8 = 10;

/// The alert description `decode_error` (RFC 9846 Section 6.2).
pub(crate) const DECODE_ERROR: u8 = 50;

/// The alert description `handshake_failure` (RFC 9846 Section 6.2).
const HANDSHAKE_FAILURE: u8 = 40;

/// The record content type of an alert.
const ALERT: u8 = 21;

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
    records: Records,
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
            records: Records::default(),
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
        if let Some(kind) = self.records.unexpected(&self.bytes) {
            return Some(Hello::Refused(
                fatal_alert(UNEXPECTED_MESSAGE).to_vec(),
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("a record of content type {kind} before the client hello"),
                ),
            ));
        }
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
                    if record.is_empty() {
                        record = missing_alert(&err);
                    }
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
            if offer.legacy < TLS12 {
                return Hello::Refused(
                    fatal_alert(PROTOCOL_VERSION).to_vec(),
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "a hello whose legacy_version is below 0x0303",
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

/// The fatal alert record for a refusal rustls queued none for. rustls returns
/// some errors before it queues an alert, a handshake message declared longer than
/// its 0xffff octet limit among them, while RFC 9846 Section 6.2 says an
/// implementation that "encounters a fatal error condition ... SHOULD send an
/// appropriate fatal alert". A message rustls could not decode is answered with
/// `decode_error`, as rustls answers its other decoding failures; a peer that broke
/// the protocol with `unexpected_message`; anything else with `handshake_failure`.
/// A refusal caused by the client's own alert is answered with nothing, since
/// Section 6 treats every alert received as an error alert after which nothing
/// more is sent.
///
/// @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-6.2>
fn missing_alert(err: &rustls::Error) -> Vec<u8> {
    let description = match err {
        rustls::Error::AlertReceived(_)
        | rustls::Error::InappropriateMessage {
            got_type: ContentType::Alert,
            ..
        } => return Vec::new(),
        rustls::Error::InvalidMessage(_) => DECODE_ERROR,
        rustls::Error::PeerMisbehaved(_)
        | rustls::Error::InappropriateMessage { .. }
        | rustls::Error::InappropriateHandshakeMessage { .. } => UNEXPECTED_MESSAGE,
        _ => HANDSHAKE_FAILURE,
    };
    fatal_alert(description).to_vec()
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

/// The record layer in front of the hello, read as it arrives.
#[derive(Debug, Default)]
struct Records {
    /// The offset of the next record header.
    next: usize,
    /// The handshake message's type and length, as far as they arrived.
    header: [u8; 4],
    /// How many octets of handshake messages the records carried.
    carried: usize,
    /// Set once the hello is whole or an alert record arrives, which rustls handles.
    ended: bool,
}

impl Records {
    /// Read the record headers in `bytes` that arrived since the last call.
    ///
    /// # Returns
    ///
    /// The content type of the first record that is neither a handshake nor an
    /// alert record and arrives before the hello is whole, which RFC 9846 Section 5
    /// calls an unexpected record type; `None` otherwise.
    fn unexpected(&mut self, bytes: &[u8]) -> Option<u8> {
        while !self.ended {
            let mut record = Reader::new(bytes.get(self.next..)?);
            match record.u8()? {
                HANDSHAKE => {
                    record.take(2)?;
                    let length = record.u16()?;
                    let fragment = record.take(usize::from(length))?;
                    for (slot, byte) in self.header.iter_mut().skip(self.carried).zip(fragment) {
                        *slot = *byte;
                    }
                    self.carried = self.carried.saturating_add(fragment.len());
                    self.next = self.next.saturating_add(5).saturating_add(fragment.len());
                    let mut header = Reader::new(&self.header);
                    if let (Some(_), Some(length)) = (header.u8(), header.u24()) {
                        self.ended = self.carried >= length.saturating_add(4);
                    }
                }
                ALERT => self.ended = true,
                kind => return Some(kind),
            }
        }
        None
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
