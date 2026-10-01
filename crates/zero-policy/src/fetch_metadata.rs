//! Fetch Metadata: refusing cross-site requests that would change state.
//!
//! `Sec-Fetch-Site` "exposes the relationship between a request initiator's origin and
//! its target's origin. It is a Structured Field whose value is a token", one of
//! `cross-site`, `same-origin`, `same-site` and `none`, and "servers SHOULD ignore
//! this header if it contains an invalid value" (Fetch Metadata Request Headers,
//! Section 2.3). With the rule on, an unsafe request (RFC 9110 Section 9.2.1) whose
//! value is `cross-site` is refused with 403, as the OWASP Cross-Site Request Forgery
//! Prevention Cheat Sheet recommends; `same-site` is refused too unless the rule
//! trusts sibling sites. A request without the header, or with a value the rule does
//! not recognize, follows the rule's `missing` setting, since older browsers and
//! clients that are not browsers send none. Because the decision depends on the field,
//! every response the rule sees carries `Vary: Sec-Fetch-Site` (Section 5.1).
//!
//! Sources, read 2026-10-01: the Fetch Metadata Request Headers source,
//! https://raw.githubusercontent.com/w3c/webappsec-fetch-metadata/main/index.bs, and
//! https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html.

use zero_http_types::Method;

use crate::cors::Field;

/// A `Sec-Fetch-Site` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Site {
    /// `cross-site`: the initiator is on another site.
    CrossSite,
    /// `same-origin`: the initiator has the target's origin.
    SameOrigin,
    /// `same-site`: the initiator is on the target's site, another origin.
    SameSite,
    /// `none`: a user-initiated request, such as a typed URL or a bookmark.
    None,
}

impl Site {
    /// The value a field carries, or `None` for a value outside the four tokens,
    /// which a server ignores.
    ///
    /// # Arguments
    ///
    /// * `value` - the field value.
    ///
    /// # Returns
    ///
    /// The site, or `None`.
    #[must_use]
    pub fn parse(value: &[u8]) -> Option<Site> {
        match value {
            b"cross-site" => Some(Self::CrossSite),
            b"same-origin" => Some(Self::SameOrigin),
            b"same-site" => Some(Self::SameSite),
            b"none" => Some(Self::None),
            _ => None,
        }
    }
}

/// What the rule does with a request that carries no recognized `Sec-Fetch-Site`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Missing {
    /// Let it through, for clients that do not send the header.
    Allow,
    /// Refuse it when unsafe, for endpoints only browsers that send the header reach.
    Refuse,
}

/// The Fetch Metadata rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FetchMetadata {
    /// Whether `same-site` requests may change state, which trusts every sibling
    /// site of the target.
    pub allow_same_site: bool,
    /// What happens when the header is absent or holds no recognized value.
    pub missing: Missing,
}

impl Default for FetchMetadata {
    fn default() -> Self {
        FetchMetadata {
            allow_same_site: false,
            missing: Missing::Allow,
        }
    }
}

/// What the rule decided for one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Run the request, with these fields on its response.
    Allowed(Vec<Field>),
    /// Answer `403` without running the route, with these fields on the response.
    Refused(Vec<Field>),
}

impl FetchMetadata {
    /// Decide one request.
    ///
    /// # Arguments
    ///
    /// * `method` - the request method, or `None` for a method outside the eight the
    ///   registry knows, which is treated as unsafe.
    /// * `site` - the `Sec-Fetch-Site` field value, if the request carries one.
    ///
    /// # Returns
    ///
    /// Allowed or refused, with `Vary: Sec-Fetch-Site` either way.
    #[must_use]
    pub fn decide(&self, method: Option<Method>, site: Option<&[u8]>) -> Verdict {
        let vary: Field = (b"Vary", b"Sec-Fetch-Site".to_vec());
        let safe = method.is_some_and(Method::is_safe);
        if safe {
            return Verdict::Allowed(vec![vary]);
        }
        let allowed = match site.and_then(Site::parse) {
            Some(Site::SameOrigin | Site::None) => true,
            Some(Site::SameSite) => self.allow_same_site,
            Some(Site::CrossSite) => false,
            Option::None => self.missing == Missing::Allow,
        };
        if allowed {
            Verdict::Allowed(vec![vary])
        } else {
            Verdict::Refused(vec![vary])
        }
    }
}
