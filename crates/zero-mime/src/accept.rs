//! Proactive negotiation over `Accept` (RFC 9110 Section 12.5.1) with the
//! quality values of Section 12.4.2.

/// The field value a response selected by negotiation carries in `Vary`
/// (RFC 9110 Section 12.5.5).
pub const VARY_ACCEPT: &[u8] = b"Accept";

/// One media range of an `Accept` value: `type/subtype`, `type/*` or `*/*`
/// with its weight in thousandths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Range<'a> {
    kind: &'a [u8],
    subtype: &'a [u8],
    weight: u16,
}

impl Range<'_> {
    /// How specific the range is for `media_type`: 3 for an exact type, 2 for
    /// `type/*`, 1 for `*/*`, 0 when it does not match.
    fn specificity(&self, kind: &[u8], subtype: &[u8]) -> u8 {
        if self.kind == b"*" {
            return u8::from(self.subtype == b"*");
        }
        if !self.kind.eq_ignore_ascii_case(kind) {
            return 0;
        }
        if self.subtype == b"*" {
            return 2;
        }
        u8::from(self.subtype.eq_ignore_ascii_case(subtype)).saturating_mul(3)
    }
}

/// Pick the representation to send.
///
/// # Arguments
///
/// * `accept` - the `Accept` field value, or `None` when the request has none.
/// * `available` - the media types the resource has, in the server's order of
///   preference.
///
/// # Returns
///
/// The index into `available` of the type to send: the one with the highest
/// weight among those the client accepts, the server's order breaking ties; the
/// first one when there is no `Accept`; `None` when the client accepts none of
/// them (a weight of 0 means "not acceptable"), which the caller answers 406
/// unless it chooses a default.
#[must_use]
pub fn negotiate(accept: Option<&[u8]>, available: &[&str]) -> Option<usize> {
    let Some(accept) = accept else {
        return if available.is_empty() { None } else { Some(0) };
    };
    let mut best: Option<(u16, usize)> = None;
    for (index, media_type) in available.iter().enumerate() {
        let Some((kind, subtype)) = split_essence(media_type.as_bytes()) else {
            continue;
        };
        let mut weight = 0u16;
        let mut specificity = 0u8;
        let mut matched = false;
        for range in ranges(accept) {
            let found = range.specificity(kind, subtype);
            if found > specificity {
                specificity = found;
                weight = range.weight;
                matched = true;
            }
        }
        if !matched || weight == 0 {
            continue;
        }
        if best.is_none_or(|(best_weight, _)| weight > best_weight) {
            best = Some((weight, index));
        }
    }
    best.map(|(_, index)| index)
}

fn split_essence(media_type: &[u8]) -> Option<(&[u8], &[u8])> {
    let slash = media_type.iter().position(|&byte| byte == b'/')?;
    let kind = media_type.get(..slash)?;
    let subtype = media_type.get(slash.saturating_add(1)..)?;
    Some((kind, subtype))
}

/// The media ranges of an `Accept` value, each with its weight; a member the
/// grammar refuses is skipped.
fn ranges(accept: &[u8]) -> impl Iterator<Item = Range<'_>> {
    accept.split(|&byte| byte == b',').filter_map(|member| {
        let member = trim(member);
        if member.is_empty() {
            return None;
        }
        let (essence, parameters) = match member.iter().position(|&byte| byte == b';') {
            Some(at) => (trim(member.get(..at)?), member.get(at..)?),
            None => (member, &[][..]),
        };
        let (kind, subtype) = split_essence(essence)?;
        if kind.is_empty()
            || subtype.is_empty()
            || kind.iter().chain(subtype).any(|&byte| byte == b' ')
        {
            return None;
        }
        Some(Range {
            kind,
            subtype,
            weight: weight(parameters),
        })
    })
}

/// The `q` weight among the parameters, in thousandths; 1000 when absent or
/// outside the `qvalue` grammar.
fn weight(parameters: &[u8]) -> u16 {
    for parameter in parameters.split(|&byte| byte == b';') {
        let parameter = trim(parameter);
        let Some((name, value)) = parameter
            .iter()
            .position(|&byte| byte == b'=')
            .and_then(|at| Some((parameter.get(..at)?, parameter.get(at.saturating_add(1)..)?)))
        else {
            continue;
        };
        if !trim(name).eq_ignore_ascii_case(b"q") {
            continue;
        }
        return qvalue(trim(value)).unwrap_or(1000);
    }
    1000
}

/// `qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )`, in thousandths.
fn qvalue(value: &[u8]) -> Option<u16> {
    let (first, rest) = value.split_first()?;
    let (whole, fraction) = match rest.split_first() {
        None => (*first, &[][..]),
        Some((b'.', digits)) if digits.len() <= 3 => (*first, digits),
        _ => return None,
    };
    let mut thousandths: u16 = match whole {
        b'0' => 0,
        b'1' => 1000,
        _ => return None,
    };
    let mut scale = 100u16;
    for &digit in fraction {
        if !digit.is_ascii_digit() {
            return None;
        }
        thousandths =
            thousandths.saturating_add(u16::from(digit.wrapping_sub(b'0')).saturating_mul(scale));
        scale /= 10;
    }
    if thousandths > 1000 {
        return None;
    }
    Some(thousandths)
}

fn trim(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|&byte| byte != b' ' && byte != b'\t')
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|&byte| byte != b' ' && byte != b'\t')
        .map_or(start, |at| at.saturating_add(1));
    bytes.get(start..end).unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::{negotiate, qvalue};

    const JSON_OR_HTML: [&str; 2] = ["application/json", "text/html"];

    #[test]
    fn the_most_specific_matching_range_decides_and_the_server_order_breaks_ties() {
        assert_eq!(negotiate(None, &JSON_OR_HTML), Some(0));
        assert_eq!(negotiate(Some(b"*/*"), &JSON_OR_HTML), Some(0));
        assert_eq!(negotiate(Some(b"text/html"), &JSON_OR_HTML), Some(1));
        assert_eq!(negotiate(Some(b"text/*"), &JSON_OR_HTML), Some(1));
        assert_eq!(
            negotiate(Some(b"TEXT/HTML;level=1"), &JSON_OR_HTML),
            Some(1)
        );
        assert_eq!(
            negotiate(
                Some(b"text/html;q=0.5, application/json;q=0.9"),
                &JSON_OR_HTML
            ),
            Some(0)
        );
        assert_eq!(
            negotiate(
                Some(b"text/html;q=0.9, application/json;q=0.5"),
                &JSON_OR_HTML
            ),
            Some(1)
        );
        assert_eq!(
            negotiate(
                Some(b"text/*;q=0.3, text/html;q=0.7, */*;q=0.5"),
                &JSON_OR_HTML
            ),
            Some(1),
            "text/html takes its own weight, not the wildcard's"
        );
        assert_eq!(negotiate(Some(b"image/png"), &JSON_OR_HTML), None);
        assert_eq!(
            negotiate(Some(b"garbage, , text/html"), &JSON_OR_HTML),
            Some(1)
        );
        assert_eq!(negotiate(None, &[]), None);
    }

    /// Standards row `routing-16`: RFC 9110 Section 12.4.2.
    #[test]
    fn accept_with_q_0_marks_a_media_type_as_not_acceptable_and_content_negotiation_never_selects_it(
    ) {
        assert_eq!(
            negotiate(Some(b"text/html;q=0, */*"), &JSON_OR_HTML),
            Some(0)
        );
        assert_eq!(negotiate(Some(b"text/html;q=0"), &["text/html"]), None);
        assert_eq!(
            negotiate(Some(b"*/*;q=0, text/html"), &JSON_OR_HTML),
            Some(1)
        );
        assert_eq!(negotiate(Some(b"text/*;q=0.000"), &["text/html"]), None);
        assert_eq!(
            negotiate(Some(b"text/html;Q=0"), &["text/html"]),
            None,
            "q is case-insensitive"
        );
    }

    #[test]
    fn quality_values_follow_the_grammar() {
        assert_eq!(qvalue(b"1"), Some(1000));
        assert_eq!(qvalue(b"1.000"), Some(1000));
        assert_eq!(qvalue(b"0.5"), Some(500));
        assert_eq!(qvalue(b"0.123"), Some(123));
        assert_eq!(qvalue(b"0"), Some(0));
        assert_eq!(qvalue(b"0."), Some(0));
        assert_eq!(qvalue(b"1.5"), None);
        assert_eq!(qvalue(b"0.1234"), None);
        assert_eq!(qvalue(b"2"), None);
        assert_eq!(qvalue(b""), None);
        assert_eq!(qvalue(b".5"), None);
    }
}
