//! Validators and conditional requests: entity tags and their two comparison
//! functions (RFC 9110 Section 8.8.3.2), the five preconditions and the order they
//! are evaluated in (Section 13.2.2).
//!
//! The evaluation is a pure function over the request's precondition fields and the
//! selected representation's validators, so it is tested without a file or a socket.
//! The caller applies it only where the response would otherwise be a 2xx, as
//! Section 13.2.1 requires: "A server MUST ignore all received preconditions if its
//! response to the same request without those conditions ... would have been a
//! status code other than a 2xx (Successful) or 412 (Precondition Failed)".

use zero_date::parse_http_date;
use zero_http_types::Method;

/// An entity tag as received or generated: `"opaque"` or `W/"opaque"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntityTag<'a> {
    /// Whether the tag carries the `W/` weakness indicator.
    pub weak: bool,
    /// The opaque tag, without its quotes.
    pub opaque: &'a [u8],
}

impl<'a> EntityTag<'a> {
    /// Parses one `entity-tag`: an optional case-sensitive `W/`, then the opaque
    /// tag in double quotes, every byte of it `etagc` (VCHAR except the quote,
    /// plus obs-text).
    ///
    /// # Arguments
    ///
    /// * `value` - the bytes, with no surrounding whitespace.
    ///
    /// # Returns
    ///
    /// The tag, or `None` for anything else.
    #[must_use]
    pub fn parse(value: &'a [u8]) -> Option<Self> {
        let (weak, quoted) = match value.strip_prefix(b"W/") {
            Some(rest) => (true, rest),
            None => (false, value),
        };
        let opaque = quoted.strip_prefix(b"\"")?.strip_suffix(b"\"")?;
        if !opaque.iter().all(|&byte| is_etagc(byte)) {
            return None;
        }
        Some(EntityTag { weak, opaque })
    }

    /// The strong comparison function: "two entity tags are equivalent if both are
    /// not weak and their opaque-tags match character-by-character".
    #[must_use]
    pub fn strong_eq(self, other: Self) -> bool {
        !self.weak && !other.weak && self.opaque == other.opaque
    }

    /// The weak comparison function: "two entity tags are equivalent if their
    /// opaque-tags match character-by-character, regardless of either or both
    /// being tagged as weak".
    #[must_use]
    pub fn weak_eq(self, other: Self) -> bool {
        self.opaque == other.opaque
    }
}

/// `etagc = %x21 / %x23-7E / obs-text`.
const fn is_etagc(byte: u8) -> bool {
    byte == 0x21 || (byte >= 0x23 && byte <= 0x7E) || byte >= 0x80
}

/// The members of a `#entity-tag` list, each trimmed of optional whitespace; an
/// empty member is skipped as the list ABNF allows.
fn tags(list: &[u8]) -> impl Iterator<Item = Option<EntityTag<'_>>> {
    list.split(|&byte| byte == b',')
        .map(trim)
        .filter(|member| !member.is_empty())
        .map(EntityTag::parse)
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

/// The current validators of the selected representation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Validators<'a> {
    /// The entity tag, when the representation has one.
    pub etag: Option<EntityTag<'a>>,
    /// The last modification time as a unix timestamp, when known.
    pub last_modified: Option<u64>,
}

/// The precondition fields of a request, each as received.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Preconditions<'a> {
    /// `If-Match`.
    pub if_match: Option<&'a [u8]>,
    /// `If-None-Match`.
    pub if_none_match: Option<&'a [u8]>,
    /// `If-Modified-Since`.
    pub if_modified_since: Option<&'a [u8]>,
    /// `If-Unmodified-Since`.
    pub if_unmodified_since: Option<&'a [u8]>,
    /// `If-Range`.
    pub if_range: Option<&'a [u8]>,
    /// `Range`.
    pub range: Option<&'a [u8]>,
}

/// What the preconditions decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome<'a> {
    /// Perform the method; `range` is the `Range` field to apply, when the method is
    /// GET, a `Range` was sent, and `If-Range` did not void it.
    Proceed {
        /// The `Range` field value to honor, if any.
        range: Option<&'a [u8]>,
    },
    /// 304 Not Modified: a GET or HEAD whose `If-None-Match` or `If-Modified-Since`
    /// condition was false.
    NotModified,
    /// 412 Precondition Failed.
    PreconditionFailed,
}

/// Whether an `If-Match` or `If-None-Match` list matches the current entity tag:
/// `*` matches any current representation; otherwise one member must match under
/// `compare`.
fn list_matches(
    list: &[u8],
    current: Option<EntityTag<'_>>,
    compare: impl Fn(EntityTag<'_>, EntityTag<'_>) -> bool,
) -> bool {
    if trim(list) == b"*" {
        return true;
    }
    let Some(current) = current else {
        return false;
    };
    tags(list).any(|member| member.is_some_and(|tag| compare(tag, current)))
}

/// Whether an `If-Modified-Since` or `If-Unmodified-Since` value is one valid
/// HTTP-date; a list of dates is not.
fn one_date(value: &[u8], now: u64) -> Option<u64> {
    if value.contains(&b',') && value.iter().filter(|&&byte| byte == b',').count() > 1 {
        return None;
    }
    parse_http_date(trim(value), now)
}

/// Evaluate the preconditions in the order of Section 13.2.2.
///
/// # Arguments
///
/// * `method` - the request method; `None` for a method outside the eight, which
///   has no selected representation to condition on.
/// * `request` - the precondition fields as received.
/// * `current` - the validators of the selected representation.
/// * `now` - the current unix timestamp, for the HTTP-date century rule and the
///   strength of a date validator in `If-Range`.
///
/// # Returns
///
/// Whether to proceed (and with which `Range`), answer 304, or answer 412.
#[must_use]
pub fn evaluate<'a>(
    method: Option<Method>,
    request: Preconditions<'a>,
    current: Validators<'_>,
    now: u64,
) -> Outcome<'a> {
    let get_or_head = matches!(method, Some(Method::Get | Method::Head));
    // Step 1: If-Match, with the strong comparison function.
    if let Some(list) = request.if_match {
        if !list_matches(list, current.etag, |a, b| a.strong_eq(b)) {
            return Outcome::PreconditionFailed;
        }
    } else if let Some(value) = request.if_unmodified_since {
        // Step 2: If-Unmodified-Since, only without If-Match, only with a valid
        // date and a modification date to compare it with.
        if let (Some(date), Some(modified)) = (one_date(value, now), current.last_modified) {
            if modified > date {
                return Outcome::PreconditionFailed;
            }
        }
    }
    // Step 3: If-None-Match, with the weak comparison function.
    if let Some(list) = request.if_none_match {
        if list_matches(list, current.etag, |a, b| a.weak_eq(b)) {
            return if get_or_head {
                Outcome::NotModified
            } else {
                Outcome::PreconditionFailed
            };
        }
    } else if get_or_head {
        // Step 4: If-Modified-Since, only for GET and HEAD without If-None-Match.
        if let Some(value) = request.if_modified_since {
            if let (Some(date), Some(modified)) = (one_date(value, now), current.last_modified) {
                if modified <= date {
                    return Outcome::NotModified;
                }
            }
        }
    }
    // Step 5: Range applies to GET only; If-Range can void it.
    if method != Some(Method::Get) {
        return Outcome::Proceed { range: None };
    }
    let Some(range) = request.range else {
        return Outcome::Proceed { range: None };
    };
    let Some(if_range) = request.if_range else {
        return Outcome::Proceed { range: Some(range) };
    };
    let honored = if_range_matches(trim(if_range), current, now);
    Outcome::Proceed {
        range: honored.then_some(range),
    }
}

/// The `If-Range` condition of Section 13.1.5: an entity tag matches under the
/// strong comparison function; an HTTP-date matches exactly, and only when it is a
/// strong validator, which a modification date is once the second it names has
/// passed (Section 8.8.2.2).
fn if_range_matches(value: &[u8], current: Validators<'_>, now: u64) -> bool {
    if value.starts_with(b"\"") || value.starts_with(b"W/") {
        return match (EntityTag::parse(value), current.etag) {
            (Some(given), Some(etag)) => given.strong_eq(etag),
            _ => false,
        };
    }
    match (parse_http_date(value, now), current.last_modified) {
        (Some(date), Some(modified)) => date == modified && modified.saturating_add(1) <= now,
        _ => false,
    }
}
