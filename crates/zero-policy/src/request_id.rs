//! Request ids: one opaque identifier per request, echoed on the response and in logs.
//!
//! A generated id is a UUID of RFC 9562: version 4 (122 random bits) or version 7 (a
//! 48-bit big-endian count of milliseconds since the Unix epoch, then 74 random bits),
//! the version in "the most significant 4 bits of octet 6" (Section 4.2), the variant
//! bits `10` at the top of octet 8 (Section 4.1), written as 8-4-4-4-12 lowercase
//! hexadecimal digits (Section 4). An id a client sends is used only when the rule
//! trusts incoming ids, and only after its length and characters are checked, so a
//! value that would inject a line, a field or a log record is replaced by a generated
//! one. An id is an identifier and nothing more: UUIDs "MUST NOT be used as security
//! capabilities" (Section 8), and nothing in this rule reads an id to decide what a
//! request may do.
//!
//! Source, read 2026-10-01: https://www.rfc-editor.org/rfc/rfc9562.html.

use zero_core::{Result, Rng};

use crate::cors::Field;

/// The longest incoming id the rule accepts, in bytes.
pub const MAX_INCOMING: usize = 128;

/// Which UUID version the rule generates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Version {
    /// Version 4: random.
    V4,
    /// Version 7: time-ordered, so ids sort by the millisecond they were made.
    V7,
}

/// The request-id rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestId {
    /// The field the id travels in, on the request and the response.
    pub field: &'static [u8],
    /// Which version a generated id is.
    pub version: Version,
    /// Whether an incoming id that passes the checks is kept instead of a new one,
    /// for a server behind a proxy that assigns them.
    pub trust_incoming: bool,
}

impl Default for RequestId {
    fn default() -> Self {
        RequestId {
            field: b"X-Request-Id",
            version: Version::V7,
            trust_incoming: false,
        }
    }
}

/// Whether `value` may stand as a request id: 1 to 128 bytes of ASCII letters,
/// digits, `-`, `_`, `.` and `:`.
///
/// # Arguments
///
/// * `value` - the incoming field value.
///
/// # Returns
///
/// `true` when the value is safe to echo and to log.
#[must_use]
pub fn is_acceptable(value: &[u8]) -> bool {
    !value.is_empty()
        && value.len() <= MAX_INCOMING
        && value
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// A version 4 UUID: 16 random bytes with the version and variant bits set.
///
/// # Arguments
///
/// * `rng` - a cryptographically secure generator.
///
/// # Returns
///
/// The 16 octets.
///
/// # Errors
///
/// [`zero_core::Error::Io`] when the generator fails.
pub fn uuid_v4(rng: &dyn Rng) -> Result<[u8; 16]> {
    let mut octets = [0u8; 16];
    rng.fill(&mut octets)?;
    Ok(stamp(octets, 0x40))
}

/// A version 7 UUID: the millisecond timestamp, then random bytes, with the version
/// and variant bits set.
///
/// # Arguments
///
/// * `rng` - a cryptographically secure generator.
/// * `unix_ms` - milliseconds since the Unix epoch; only the low 48 bits are kept.
///
/// # Returns
///
/// The 16 octets.
///
/// # Errors
///
/// [`zero_core::Error::Io`] when the generator fails.
pub fn uuid_v7(rng: &dyn Rng, unix_ms: u64) -> Result<[u8; 16]> {
    let mut octets = [0u8; 16];
    let time = unix_ms.to_be_bytes();
    for (slot, byte) in octets.iter_mut().zip(time.iter().skip(2)) {
        *slot = *byte;
    }
    if let Some(random) = octets.get_mut(6..) {
        rng.fill(random)?;
    }
    Ok(stamp(octets, 0x70))
}

/// Set the version nibble of octet 6 and the `10` variant bits of octet 8.
fn stamp(mut octets: [u8; 16], version: u8) -> [u8; 16] {
    if let Some(byte) = octets.get_mut(6) {
        *byte = (*byte & 0x0f) | version;
    }
    if let Some(byte) = octets.get_mut(8) {
        *byte = (*byte & 0x3f) | 0x80;
    }
    octets
}

/// The 36-character string form: 8-4-4-4-12 lowercase hexadecimal digits.
///
/// # Arguments
///
/// * `octets` - the UUID.
///
/// # Returns
///
/// The ASCII bytes.
#[must_use]
pub fn format(octets: &[u8; 16]) -> [u8; 36] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [b'-'; 36];
    let mut at = 0usize;
    for (index, &byte) in octets.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            at = at.saturating_add(1);
        }
        for nibble in [byte >> 4, byte & 0x0f] {
            if let (Some(slot), Some(&digit)) = (out.get_mut(at), HEX.get(usize::from(nibble))) {
                *slot = digit;
            }
            at = at.saturating_add(1);
        }
    }
    out
}

impl RequestId {
    /// The id for one request, and the field that carries it on the response.
    ///
    /// # Arguments
    ///
    /// * `incoming` - the request's own value of the rule's field, if any.
    /// * `rng` - the generator a new id is drawn from.
    /// * `unix_ms` - the current time in milliseconds since the Unix epoch, for a
    ///   version 7 id.
    ///
    /// # Returns
    ///
    /// The field line; its value is the id to log with the request.
    ///
    /// # Errors
    ///
    /// [`zero_core::Error::Io`] when the generator fails.
    pub fn assign(&self, incoming: Option<&[u8]>, rng: &dyn Rng, unix_ms: u64) -> Result<Field> {
        if self.trust_incoming {
            if let Some(value) = incoming.filter(|value| is_acceptable(value)) {
                return Ok((self.field, value.to_vec()));
            }
        }
        let octets = match self.version {
            Version::V4 => uuid_v4(rng)?,
            Version::V7 => uuid_v7(rng, unix_ms)?,
        };
        Ok((self.field, format(&octets).to_vec()))
    }
}
