//! Byte ranges: the `Range` field of RFC 9110 Section 14.2 over the `bytes` unit of
//! Section 14.1.2, `Content-Range` of Section 14.4, and the `multipart/byteranges`
//! content of Section 14.6.

use zero_date::Decimal;

/// How many ranges one request may name before it is refused as "an excessive
/// number of small or overlapping ranges" (Section 15.5.17).
pub const MAX_RANGES: usize = 16;

/// What a `Range` field asks for, against a representation of a known length.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ranges {
    /// The field is to be ignored and the whole representation sent: another range
    /// unit, an invalid specifier, or a representation with no content.
    Ignore,
    /// No range is satisfiable: 416 with `Content-Range: bytes */complete-length`.
    Unsatisfiable,
    /// The request is refused: more than [`MAX_RANGES`] ranges, or ranges that
    /// overlap or run backwards, an indication of a broken client or an attack.
    Refused,
    /// The satisfiable ranges, each as inclusive first and last offsets, in the
    /// order requested with overlapping and adjacent ranges coalesced.
    Satisfiable(Vec<(u64, u64)>),
}

/// One `range-spec` of the `bytes` unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Spec {
    /// `first-pos "-" [ last-pos ]`.
    Int { first: u64, last: Option<u64> },
    /// `"-" suffix-length`.
    Suffix(u64),
}

fn digits(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut value: u64 = 0;
    for &byte in bytes {
        value = value
            .checked_mul(10)?
            .checked_add(u64::from(byte.wrapping_sub(b'0')))?;
    }
    Some(value)
}

/// The bytes before and after the first `separator`.
fn split_at_byte(bytes: &[u8], separator: u8) -> Option<(&[u8], &[u8])> {
    let at = bytes.iter().position(|&byte| byte == separator)?;
    Some((bytes.get(..at)?, bytes.get(at.checked_add(1)?..)?))
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

/// One `range-spec`; `None` when it is invalid, which makes the whole specifier
/// invalid. A numeral too large for the integer counts as invalid rather than
/// overflowing, as Section 14.1.2 asks.
fn spec(member: &[u8]) -> Option<Spec> {
    let (first, last) = split_at_byte(member, b'-')?;
    if first.is_empty() {
        return Some(Spec::Suffix(digits(last)?));
    }
    let first = digits(first)?;
    if last.is_empty() {
        return Some(Spec::Int { first, last: None });
    }
    let last = digits(last)?;
    if last < first {
        return None;
    }
    Some(Spec::Int {
        first,
        last: Some(last),
    })
}

/// Resolve a `Range` field against a representation of `length` bytes.
///
/// # Arguments
///
/// * `value` - the `Range` field value.
/// * `length` - the complete length of the selected representation.
///
/// # Returns
///
/// What to do with the request; see [`Ranges`].
#[must_use]
pub fn resolve(value: &[u8], length: u64) -> Ranges {
    let value = trim(value);
    let Some((unit, set)) = split_at_byte(value, b'=') else {
        return Ranges::Ignore;
    };
    if !trim(unit).eq_ignore_ascii_case(b"bytes") {
        return Ranges::Ignore;
    }
    let mut specs = Vec::new();
    for member in set.split(|&byte| byte == b',') {
        let member = trim(member);
        if member.is_empty() {
            continue;
        }
        match spec(member) {
            Some(spec) => specs.push(spec),
            None => return Ranges::Ignore,
        }
    }
    if specs.is_empty() {
        return Ranges::Ignore;
    }
    if specs.len() > MAX_RANGES {
        return Ranges::Refused;
    }
    if length == 0 {
        // Only a suffix-range with a non-zero length is satisfiable against no
        // content, and it selects nothing; the field is ignored then.
        return Ranges::Ignore;
    }
    let mut ranges: Vec<(u64, u64)> = Vec::with_capacity(specs.len());
    for spec in specs {
        let resolved = match spec {
            Spec::Int { first, last } => {
                if first >= length {
                    continue;
                }
                let end = last.map_or(length.saturating_sub(1), |last| {
                    last.min(length.saturating_sub(1))
                });
                (first, end)
            }
            Spec::Suffix(0) => continue,
            Spec::Suffix(count) => (length.saturating_sub(count), length.saturating_sub(1)),
        };
        match ranges.last_mut() {
            // Overlapping or adjacent to the one before it: coalesce.
            Some(previous) if resolved.0 <= previous.1.saturating_add(1) => {
                if resolved.0 < previous.0 {
                    return Ranges::Refused;
                }
                previous.1 = previous.1.max(resolved.1);
            }
            Some(previous) if resolved.0 < previous.0 => return Ranges::Refused,
            _ => ranges.push(resolved),
        }
    }
    if ranges.is_empty() {
        Ranges::Unsatisfiable
    } else {
        Ranges::Satisfiable(ranges)
    }
}

/// Write `bytes first-last/complete-length`, the `Content-Range` of a single-part
/// 206 (Section 14.4).
///
/// # Arguments
///
/// * `out` - where the value goes.
/// * `range` - the inclusive offsets.
/// * `length` - the complete length.
pub fn write_content_range(out: &mut Vec<u8>, range: (u64, u64), length: u64) {
    out.extend_from_slice(b"bytes ");
    out.extend_from_slice(Decimal::new(range.0).as_bytes());
    out.push(b'-');
    out.extend_from_slice(Decimal::new(range.1).as_bytes());
    out.push(b'/');
    out.extend_from_slice(Decimal::new(length).as_bytes());
}

/// Write `bytes */complete-length`, the `Content-Range` of a 416 (Section 14.4).
///
/// # Arguments
///
/// * `out` - where the value goes.
/// * `length` - the complete length.
pub fn write_unsatisfied_range(out: &mut Vec<u8>, length: u64) {
    out.extend_from_slice(b"bytes */");
    out.extend_from_slice(Decimal::new(length).as_bytes());
}

/// Write the `multipart/byteranges` content of a multi-part 206 (Section 14.6): each
/// part with its own `Content-Type` and `Content-Range`, separated by the boundary.
///
/// # Arguments
///
/// * `out` - where the content goes.
/// * `data` - the whole representation.
/// * `ranges` - the inclusive offsets of each part, as [`resolve`] returned them.
/// * `content_type` - the representation's media type, repeated in each part.
/// * `boundary` - the boundary parameter, without the leading dashes.
pub fn write_multipart(
    out: &mut Vec<u8>,
    data: &[u8],
    ranges: &[(u64, u64)],
    content_type: &[u8],
    boundary: &[u8],
) {
    let length = u64::try_from(data.len()).unwrap_or(u64::MAX);
    for &(first, last) in ranges {
        let Some(part) = usize::try_from(first)
            .ok()
            .zip(usize::try_from(last).ok())
            .and_then(|(first, last)| data.get(first..=last))
        else {
            continue;
        };
        out.extend_from_slice(b"\r\n--");
        out.extend_from_slice(boundary);
        out.extend_from_slice(b"\r\nContent-Type: ");
        out.extend_from_slice(content_type);
        out.extend_from_slice(b"\r\nContent-Range: ");
        write_content_range(out, (first, last), length);
        out.extend_from_slice(b"\r\n\r\n");
        out.extend_from_slice(part);
    }
    out.extend_from_slice(b"\r\n--");
    out.extend_from_slice(boundary);
    out.extend_from_slice(b"--\r\n");
}
