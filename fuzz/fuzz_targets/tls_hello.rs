//! The TLS listener's client hello reader on arbitrary bytes. The reader is
//! private to zero-tls, so this target compiles `crates/zero-tls/src/hello.rs`
//! in place, beside the one-line `tls_error` it borrows from `buffered.rs`.
//!
//! The first octet picks where the bytes are split into two reads and the second
//! the record size they are fragmented into. A decision names every byte read,
//! and a server name is lowercase and was sent. A refusal is an `InvalidData`
//! error with one fatal alert record, or with none only when the client's own
//! alert record arrived before its hello was whole, since a party that receives
//! a fatal alert closes the connection (RFC 9846 Section 6.2). Bytes whose first
//! record, of at most 2^14 octets, is neither a handshake nor an alert record
//! carry an unexpected record type before the first ClientHello and are refused
//! with `unexpected_message` (Section 5). Two reads and one decide alike, a
//! server that also speaks TLS 1.2 reads every hello a TLS 1.3 only server
//! reads, and a hello whose records share one record version decides as it did
//! when fragmented across smaller records of that version (Section 5.1). When
//! the bytes hold a well-formed hello (Sections 4.2.2, 4.3 and 4.3.1), whatever
//! its record versions, which Appendix E.2 says to ignore, it is refused with
//! `protocol_version` when it offers no version the server speaks (RFC 8996
//! Sections 4 and 5, RFC 9846 Appendix E.2), when its `legacy_version` is below
//! 0x0303 whatever `supported_versions` offers (RFC 8996 Sections 4 and 5 for
//! {03,01} and {03,02}, RFC 9846 Section 4.2.2), or when it offers TLS 1.3 with
//! a `legacy_version` other than 0x0303 (Section 4.2.2), and with
//! `missing_extension` when it offers TLS 1.3 without the extensions Section 9.2
//! requires.

#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "../../crates/zero-tls/src/hello.rs"]
mod hello;

/// The part of `crates/zero-tls/src/buffered.rs` that `hello.rs` uses.
mod buffered {
    pub(crate) fn tls_error(err: rustls::Error) -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, err)
    }
}

use hello::{
    fatal_alert, Hello, HelloReader, MISSING_EXTENSION, PROTOCOL_VERSION, UNRECOGNIZED_NAME,
};

const ALERT: u8 = 21;
const HANDSHAKE: u8 = 22;
/// The alert description `unexpected_message` (RFC 9846 Section 6).
const UNEXPECTED_MESSAGE: u8 = 10;
const CLIENT_HELLO: u8 = 1;
const SUPPORTED_GROUPS: u16 = 10;
const SIGNATURE_ALGORITHMS: u16 = 13;
const PRE_SHARED_KEY: u16 = 41;
const SUPPORTED_VERSIONS: u16 = 43;
const KEY_SHARE: u16 = 51;
const TLS12: u16 = 0x0303;
const TLS13: u16 = 0x0304;
const MAX_FRAGMENT: usize = 1 << 14;

/// A decision with its owned parts.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Read(Option<String>, Vec<u8>),
    Refused(Vec<u8>),
}

fn verdict(hello: Hello) -> Verdict {
    match hello {
        Hello::Read(name, bytes) => Verdict::Read(name, bytes),
        Hello::Refused(record, err) => {
            assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
            Verdict::Refused(record)
        }
    }
}

/// The decision for `pieces` delivered as successive reads, `None` while the
/// hello is not whole.
fn read(pieces: &[&[u8]], tls12: bool) -> Option<Verdict> {
    let mut reader = HelloReader::new(tls12);
    let mut fed = 0usize;
    for piece in pieces {
        fed += piece.len();
        if let Some(hello) = reader.push(piece) {
            return Some(verdict(hello));
        }
        assert_eq!(reader.len(), fed);
    }
    None
}

/// A well-formed client hello: its records, its handshake message, and what it
/// offers.
struct Parsed {
    record_version: [u8; 2],
    /// Whether every record carries the first record's version.
    uniform: bool,
    message: Vec<u8>,
    legacy: u16,
    versions: Option<Vec<u16>>,
    signatures: bool,
    groups: bool,
    shares: bool,
    psk: bool,
}

struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let (head, tail) = (self.0.get(..count)?, self.0.get(count..)?);
        self.0 = tail;
        Some(head)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u16(&mut self) -> Option<u16> {
        let bytes = self.take(2)?;
        Some(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn vector8(&mut self) -> Option<&'a [u8]> {
        let len = self.u8()?;
        self.take(usize::from(len))
    }

    fn vector16(&mut self) -> Option<&'a [u8]> {
        let len = self.u16()?;
        self.take(usize::from(len))
    }
}

/// The client hello at the start of `bytes`, read strictly: handshake records of
/// 1 to 2^14 octets (RFC 9846 Section 5.1) carrying one ClientHello that ends
/// with its last record, `legacy_session_id<0..32>`, `cipher_suites<2..2^16-2>`,
/// `legacy_compression_methods<1..2^8-1>` (Section 4.2.2), then nothing or one
/// extension block that fills the rest with no type twice (Section 4.3), and
/// `supported_versions` as `versions<2..254>` (Section 4.3.1).
fn parse(bytes: &[u8]) -> Option<Parsed> {
    let mut records = Cursor(bytes);
    let mut message = Vec::new();
    let mut record_version = None;
    let mut uniform = true;
    loop {
        if records.u8()? != HANDSHAKE {
            return None;
        }
        let version = records.take(2)?;
        uniform &= *record_version.get_or_insert([version[0], version[1]]) == version;
        let fragment = records.vector16()?;
        if fragment.is_empty() || fragment.len() > MAX_FRAGMENT {
            return None;
        }
        message.extend_from_slice(fragment);
        if message.len() >= 4 {
            if message[0] != CLIENT_HELLO {
                return None;
            }
            let len = usize::from(message[1]) << 16
                | usize::from(message[2]) << 8
                | usize::from(message[3]);
            if message.len() == 4 + len {
                break;
            }
            if message.len() > 4 + len {
                return None;
            }
        }
    }
    let mut body = Cursor(&message[4..]);
    let legacy = body.u16()?;
    body.take(32)?;
    if body.vector8()?.len() > 32 {
        return None;
    }
    let suites = body.vector16()?;
    if suites.len() < 2 || suites.len() % 2 != 0 {
        return None;
    }
    if body.vector8()?.is_empty() {
        return None;
    }
    let mut parsed = Parsed {
        record_version: record_version?,
        uniform,
        message: message.clone(),
        legacy,
        versions: None,
        signatures: false,
        groups: false,
        shares: false,
        psk: false,
    };
    if body.0.is_empty() {
        return Some(parsed);
    }
    let mut extensions = Cursor(body.vector16()?);
    if !body.0.is_empty() {
        return None;
    }
    let mut seen = Vec::new();
    while !extensions.0.is_empty() {
        let kind = extensions.u16()?;
        let data = extensions.vector16()?;
        if seen.contains(&kind) {
            return None;
        }
        seen.push(kind);
        match kind {
            SUPPORTED_VERSIONS => {
                let mut data = Cursor(data);
                let list = data.vector8()?;
                if !data.0.is_empty() || list.len() < 2 || list.len() % 2 != 0 {
                    return None;
                }
                let versions = list
                    .chunks_exact(2)
                    .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                    .collect();
                parsed.versions = Some(versions);
            }
            SIGNATURE_ALGORITHMS => parsed.signatures = true,
            SUPPORTED_GROUPS => parsed.groups = true,
            KEY_SHARE => parsed.shares = true,
            PRE_SHARED_KEY => parsed.psk = true,
            _ => {}
        }
    }
    Some(parsed)
}

/// The fragments of the handshake records at the start of `bytes`, joined.
fn handshake_payload(bytes: &[u8]) -> Vec<u8> {
    let mut records = Cursor(bytes);
    let mut payload = Vec::new();
    while records.u8() == Some(HANDSHAKE) {
        let (Some(_), Some(fragment)) = (records.take(2), records.vector16()) else {
            break;
        };
        payload.extend_from_slice(fragment);
    }
    payload
}

/// The content type of the first record at the start of `bytes` that is not a
/// handshake record, when it arrives before the handshake records hold a whole
/// message.
fn record_before_hello(bytes: &[u8]) -> Option<u8> {
    let mut records = Cursor(bytes);
    let mut message = Vec::new();
    loop {
        let kind = records.u8()?;
        if kind != HANDSHAKE {
            return Some(kind);
        }
        records.take(2)?;
        message.extend_from_slice(records.vector16()?);
        if let [_, high, middle, low, body @ ..] = message.as_slice() {
            let len = usize::from(*high) << 16 | usize::from(*middle) << 8 | usize::from(*low);
            if body.len() >= len {
                return None;
            }
        }
    }
}

/// The alert descriptions the RFCs name for this hello at a server that speaks
/// TLS 1.3, and TLS 1.2 when `tls12` is set; empty when the hello passes.
fn required_alerts(parsed: &Parsed, tls12: bool) -> Vec<u8> {
    let (offers13, offers12) = match &parsed.versions {
        Some(versions) => (versions.contains(&TLS13), versions.contains(&TLS12)),
        None => (false, parsed.legacy >= TLS12),
    };
    let mut alerts = Vec::new();
    if !offers13 && !(offers12 && tls12) {
        alerts.push(PROTOCOL_VERSION);
    }
    if parsed.legacy < TLS12 || offers13 && parsed.legacy != TLS12 {
        alerts.push(PROTOCOL_VERSION);
    }
    if offers13
        && (!(parsed.psk || (parsed.signatures && parsed.groups)) || parsed.groups != parsed.shares)
    {
        alerts.push(MISSING_EXTENSION);
    }
    alerts
}

/// The hello's message in records of at most `size` octets.
fn refragment(parsed: &Parsed, size: usize) -> Vec<u8> {
    let mut out = Vec::new();
    for fragment in parsed.message.chunks(size) {
        out.push(HANDSHAKE);
        out.extend_from_slice(&parsed.record_version);
        out.extend_from_slice(&u16::try_from(fragment.len()).unwrap().to_be_bytes());
        out.extend_from_slice(fragment);
    }
    out
}

fn check(bytes: &[u8], decided: &Option<Verdict>, tls12: bool) {
    match decided {
        Some(Verdict::Read(name, read)) => {
            assert_eq!(read.as_slice(), bytes, "every byte read is handed on");
            if let Some(name) = name {
                assert!(!name.is_empty());
                assert!(!name.bytes().any(|byte| byte.is_ascii_uppercase()));
                assert!(handshake_payload(bytes)
                    .windows(name.len())
                    .any(|window| window.eq_ignore_ascii_case(name.as_bytes())));
            }
        }
        Some(Verdict::Refused(record)) => {
            assert_ne!(record.as_slice(), fatal_alert(UNRECOGNIZED_NAME));
            if let [kind, _, _, length @ .., level, _] = record.as_slice() {
                assert_eq!(*kind, ALERT, "an alert record");
                assert_eq!(length, [0x00, 0x02]);
                assert_eq!(*level, 2, "a fatal alert");
            } else {
                assert!(
                    record.is_empty() && record_before_hello(bytes) == Some(ALERT),
                    "one fatal alert record unless the client sent an alert first \
                     (RFC 9846 Section 6.2): {record:?}"
                );
            }
        }
        None => {}
    }
    if let (Some(_), [kind, _, _, high, low, ..]) = (decided, bytes) {
        let length = usize::from(u16::from_be_bytes([*high, *low]));
        if *kind != HANDSHAKE && *kind != ALERT && length <= MAX_FRAGMENT {
            assert_eq!(
                decided,
                &Some(Verdict::Refused(fatal_alert(UNEXPECTED_MESSAGE).to_vec())),
                "an unexpected record type is refused with unexpected_message (RFC 9846 Section 5)"
            );
        }
    }
    if let Some(parsed) = parse(bytes) {
        assert!(decided.is_some(), "a whole hello is decided");
        let alerts = required_alerts(&parsed, tls12);
        if !alerts.is_empty() {
            let refused = alerts.iter().any(|&description| {
                decided.as_ref() == Some(&Verdict::Refused(fatal_alert(description).to_vec()))
            });
            assert!(refused, "refused with one of {alerts:?}, not {decided:?}");
        }
    }
}

fn same_kind(a: &Option<Verdict>, b: &Option<Verdict>) {
    match (a, b) {
        (Some(Verdict::Read(name_a, _)), Some(Verdict::Read(name_b, _))) => {
            assert_eq!(name_a, name_b)
        }
        (Some(Verdict::Refused(_)), Some(Verdict::Refused(_))) | (None, None) => {}
        _ => panic!("the decisions differ: {a:?} and {b:?}"),
    }
}

fuzz_target!(|data: &[u8]| {
    let [split, size, bytes @ ..] = data else {
        return;
    };
    let strict = read(&[bytes], false);
    let lenient = read(&[bytes], true);
    check(bytes, &strict, false);
    check(bytes, &lenient, true);
    if let Some(Verdict::Read(name, _)) = &strict {
        assert!(
            matches!(&lenient, Some(Verdict::Read(other, _)) if other == name),
            "a server that also speaks TLS 1.2 reads what a TLS 1.3 server reads"
        );
    }

    let at = usize::from(*split) * bytes.len() / 255;
    let (first, second) = bytes.split_at(at);
    let pieces = read(&[first, second], true);
    same_kind(&lenient, &pieces);
    if let Some(Verdict::Read(_, read)) = &pieces {
        assert!(bytes.starts_with(read));
    }

    if let Some(parsed) = parse(bytes) {
        let fragmented = refragment(&parsed, usize::from(*size).max(1));
        let again = read(&[&fragmented], true);
        check(&fragmented, &again, true);
        if parsed.uniform {
            same_kind(&lenient, &again);
        }
        if !required_alerts(&parsed, true).is_empty() {
            assert_eq!(lenient, again);
        }
    }
});
