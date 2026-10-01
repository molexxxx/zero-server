//! Security response headers: the fields a response carries so a browser treats it
//! safely, and the one it must not carry.
//!
//! - `Strict-Transport-Security` (RFC 6797): `max-age` always, `includeSubDomains`
//!   valueless (Sections 6.1.1 and 6.1.2), never over plain HTTP, since "An HSTS Host
//!   MUST NOT include the STS header field in HTTP responses conveyed over non-secure
//!   transport" (Section 7.2), and once per response, since a user agent "MUST
//!   process only the first such header field" (Section 8.1). `max-age=0` withdraws
//!   the policy.
//! - `Content-Security-Policy` (CSP3): directives serialized as `name value; name
//!   value` with names of `ALPHA / DIGIT / "-"` (Sections 2.2 and 2.3), the
//!   `-Report-Only` field name for a policy that is monitored rather than enforced
//!   (Section 3.2), a nonce that is "a unique value each time it transmits a policy",
//!   128 bits from a cryptographically secure generator (Section 7.1, "Nonce
//!   Reuse"), and `frame-ancestors`, `report-uri` and `sandbox` dropped from the
//!   `<meta>` form, which supports none of them (Section 3.3).
//! - `X-Content-Type-Options: nosniff` (Fetch, Section 3.6).
//! - `X-Frame-Options` (RFC 7034 Section 2.1): `DENY` or `SAMEORIGIN`; `ALLOW-FROM` is
//!   not offered, since `frame-ancestors` expresses it in every browser that honors
//!   CSP.
//! - `Referrer-Policy` (Referrer Policy, Section 4.1): one token or a fallback list,
//!   of which a user agent keeps the last token it recognizes (Section 8.1).
//! - `Cross-Origin-Resource-Policy` (Fetch, Section 3.7): exactly `same-origin`,
//!   `same-site` or `cross-origin`, case-sensitive.
//! - `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` (HTML, Sections
//!   7.1.3.1 and 7.1.4.1): structured-header tokens from the defined set, with an
//!   optional `report-to` parameter and `-Report-Only` variants.
//! - `X-XSS-Protection: 0`, and `X-Powered-By` removed, as the OWASP HTTP Security
//!   Response Headers Cheat Sheet recommends.
//!
//! Sources, read 2026-10-01: RFC 6797 and RFC 7034 at rfc-editor.org; CSP3 from
//! w3c/webappsec-csp `index.bs`; the Fetch Standard from whatwg/fetch `fetch.bs`; the
//! HTML Standard's "Loading web pages"; Referrer Policy at w3.org/TR; the OWASP cheat
//! sheet.

use zero_core::{Error, Result, Rng};
use zero_date::Decimal;

use crate::cors::Field;

/// The fields no response may carry, removed by [`SecurityHeaders::scrub`].
pub const REMOVED: &[&[u8]] = &[b"X-Powered-By"];

/// The directives a `<meta>` policy cannot carry (CSP3 Section 3.3).
const NOT_IN_META: &[&[u8]] = &[b"frame-ancestors", b"report-uri", b"sandbox"];

/// How many random bytes a nonce draws: 128 bits, the floor CSP3 Section 7.1 sets.
const NONCE_BYTES: usize = 16;

/// A `Strict-Transport-Security` policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hsts {
    /// How long the user agent treats the host as an HSTS host, in seconds; zero
    /// withdraws the policy.
    pub max_age: u64,
    /// Whether the policy covers every subdomain too.
    pub include_subdomains: bool,
}

impl Hsts {
    /// The field value: `max-age=N`, then `; includeSubDomains` when asserted.
    #[must_use]
    pub fn value(&self) -> Vec<u8> {
        let mut out = b"max-age=".to_vec();
        out.extend_from_slice(Decimal::new(self.max_age).as_bytes());
        if self.include_subdomains {
            out.extend_from_slice(b"; includeSubDomains");
        }
        out
    }
}

/// One source expression of a CSP directive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// A source expression written as it is, such as `'self'` or `https://cdn.invalid`.
    Literal(Vec<u8>),
    /// `'nonce-…'` with a fresh value for every response.
    Nonce,
}

/// One CSP directive: a name and its source expressions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Directive {
    name: Vec<u8>,
    values: Vec<Source>,
}

impl Directive {
    /// A directive.
    ///
    /// # Arguments
    ///
    /// * `name` - the directive name, `1*( ALPHA / DIGIT / "-" )`, written lowercase.
    /// * `values` - its source expressions; none for a valueless directive such as
    ///   `upgrade-insecure-requests`.
    ///
    /// # Returns
    ///
    /// The directive.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] for a name outside the grammar, and for a literal value that
    /// is empty, holds whitespace, `;` or `,`, or a byte outside visible ASCII, any of
    /// which would split or end the serialized policy.
    pub fn new(name: &str, values: Vec<Source>) -> Result<Self> {
        let valid_name = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !valid_name {
            return Err(Error::Protocol(format!(
                "{name:?} is not a CSP directive name"
            )));
        }
        for value in &values {
            if let Source::Literal(bytes) = value {
                let valid = !bytes.is_empty()
                    && bytes
                        .iter()
                        .all(|&b| b.is_ascii_graphic() && b != b';' && b != b',');
                if !valid {
                    return Err(Error::Protocol(format!(
                        "{:?} cannot appear in a serialized CSP",
                        String::from_utf8_lossy(bytes)
                    )));
                }
            }
        }
        Ok(Directive {
            name: name.as_bytes().to_vec(),
            values,
        })
    }

    /// The directive name.
    #[must_use]
    pub fn name(&self) -> &[u8] {
        &self.name
    }
}

/// A Content Security Policy.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Csp {
    /// The directives, serialized in this order.
    pub directives: Vec<Directive>,
    /// Whether the policy is monitored (`Content-Security-Policy-Report-Only`)
    /// rather than enforced.
    pub report_only: bool,
}

impl Csp {
    /// Whether any directive carries a nonce, so a response needs a fresh one.
    #[must_use]
    pub fn needs_nonce(&self) -> bool {
        self.directives
            .iter()
            .any(|d| d.values.iter().any(|v| matches!(v, Source::Nonce)))
    }

    /// The field name: enforcing or report-only.
    #[must_use]
    pub fn field_name(&self) -> &'static [u8] {
        if self.report_only {
            b"Content-Security-Policy-Report-Only"
        } else {
            b"Content-Security-Policy"
        }
    }

    /// The serialized policy for the response header.
    ///
    /// # Arguments
    ///
    /// * `nonce` - the response's nonce, required when [`needs_nonce`](Self::needs_nonce).
    ///
    /// # Returns
    ///
    /// The value, every directive included.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] when the policy needs a nonce and none is given.
    pub fn header_value(&self, nonce: Option<&str>) -> Result<Vec<u8>> {
        self.serialize(nonce, false)
    }

    /// The serialized policy for a `<meta http-equiv="Content-Security-Policy">`
    /// element, without the directives a `<meta>` policy cannot carry.
    ///
    /// # Arguments
    ///
    /// * `nonce` - the response's nonce, required when [`needs_nonce`](Self::needs_nonce).
    ///
    /// # Returns
    ///
    /// The value, without `frame-ancestors`, `report-uri` and `sandbox`.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] when the policy needs a nonce and none is given.
    pub fn meta_content(&self, nonce: Option<&str>) -> Result<Vec<u8>> {
        self.serialize(nonce, true)
    }

    fn serialize(&self, nonce: Option<&str>, meta: bool) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        for directive in &self.directives {
            if meta && NOT_IN_META.contains(&directive.name.as_slice()) {
                continue;
            }
            if !out.is_empty() {
                out.extend_from_slice(b"; ");
            }
            out.extend_from_slice(&directive.name);
            for value in &directive.values {
                out.push(b' ');
                match value {
                    Source::Literal(bytes) => out.extend_from_slice(bytes),
                    Source::Nonce => {
                        let nonce = nonce.ok_or_else(|| {
                            Error::Protocol("the policy needs a nonce".to_owned())
                        })?;
                        out.extend_from_slice(b"'nonce-");
                        out.extend_from_slice(nonce.as_bytes());
                        out.push(b'\'');
                    }
                }
            }
        }
        Ok(out)
    }
}

/// A fresh nonce: 128 bits from `rng`, in base64.
///
/// # Arguments
///
/// * `rng` - a cryptographically secure generator.
///
/// # Returns
///
/// The base64 nonce, 24 characters with padding, every character inside CSP3's
/// `base64-value`.
///
/// # Errors
///
/// [`Error::Io`] when the generator fails.
pub fn nonce(rng: &dyn Rng) -> Result<String> {
    let mut bytes = [0u8; NONCE_BYTES];
    rng.fill(&mut bytes)?;
    Ok(zero_base64::encode(
        &bytes,
        zero_base64::Alphabet::Standard,
        true,
    ))
}

/// `X-Frame-Options`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameOptions {
    /// `DENY`: never in a frame.
    Deny,
    /// `SAMEORIGIN`: only in a frame of the same origin.
    SameOrigin,
}

impl FrameOptions {
    /// The field value.
    #[must_use]
    pub fn value(self) -> &'static [u8] {
        match self {
            Self::Deny => b"DENY",
            Self::SameOrigin => b"SAMEORIGIN",
        }
    }
}

/// A referrer policy token of Referrer Policy Section 3.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferrerPolicy {
    /// `no-referrer`.
    NoReferrer,
    /// `no-referrer-when-downgrade`.
    NoReferrerWhenDowngrade,
    /// `same-origin`.
    SameOrigin,
    /// `origin`.
    Origin,
    /// `strict-origin`.
    StrictOrigin,
    /// `origin-when-cross-origin`.
    OriginWhenCrossOrigin,
    /// `strict-origin-when-cross-origin`.
    StrictOriginWhenCrossOrigin,
    /// `unsafe-url`.
    UnsafeUrl,
}

impl ReferrerPolicy {
    const ALL: [ReferrerPolicy; 8] = [
        Self::NoReferrer,
        Self::NoReferrerWhenDowngrade,
        Self::SameOrigin,
        Self::Origin,
        Self::StrictOrigin,
        Self::OriginWhenCrossOrigin,
        Self::StrictOriginWhenCrossOrigin,
        Self::UnsafeUrl,
    ];

    /// The token.
    #[must_use]
    pub fn token(self) -> &'static [u8] {
        match self {
            Self::NoReferrer => b"no-referrer",
            Self::NoReferrerWhenDowngrade => b"no-referrer-when-downgrade",
            Self::SameOrigin => b"same-origin",
            Self::Origin => b"origin",
            Self::StrictOrigin => b"strict-origin",
            Self::OriginWhenCrossOrigin => b"origin-when-cross-origin",
            Self::StrictOriginWhenCrossOrigin => b"strict-origin-when-cross-origin",
            Self::UnsafeUrl => b"unsafe-url",
        }
    }

    /// The policy a user agent takes from a `Referrer-Policy` value: the last token it
    /// recognizes, unknown tokens skipped (Referrer Policy Section 8.1).
    ///
    /// # Arguments
    ///
    /// * `value` - the field value, a comma-separated list.
    ///
    /// # Returns
    ///
    /// The policy, or `None` when no token is recognized.
    #[must_use]
    pub fn parse_header(value: &[u8]) -> Option<ReferrerPolicy> {
        value
            .split(|&b| b == b',')
            .rev()
            .map(<[u8]>::trim_ascii)
            .find_map(|token| {
                Self::ALL
                    .into_iter()
                    .find(|policy| policy.token().eq_ignore_ascii_case(token))
            })
    }
}

/// `Cross-Origin-Resource-Policy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourcePolicy {
    /// `same-origin`.
    SameOrigin,
    /// `same-site`.
    SameSite,
    /// `cross-origin`.
    CrossOrigin,
}

impl ResourcePolicy {
    /// The field value, case-sensitive as Fetch's ABNF writes it.
    #[must_use]
    pub fn value(self) -> &'static [u8] {
        match self {
            Self::SameOrigin => b"same-origin",
            Self::SameSite => b"same-site",
            Self::CrossOrigin => b"cross-origin",
        }
    }

    /// The policy a value names exactly, case-sensitive.
    #[must_use]
    pub fn parse(value: &[u8]) -> Option<ResourcePolicy> {
        [Self::SameOrigin, Self::SameSite, Self::CrossOrigin]
            .into_iter()
            .find(|policy| policy.value() == value)
    }
}

/// The `Cross-Origin-Opener-Policy` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenerValue {
    /// `unsafe-none`.
    UnsafeNone,
    /// `same-origin-allow-popups`.
    SameOriginAllowPopups,
    /// `same-origin`.
    SameOrigin,
    /// `noopener-allow-popups`.
    NoopenerAllowPopups,
}

impl OpenerValue {
    fn token(self) -> &'static [u8] {
        match self {
            Self::UnsafeNone => b"unsafe-none",
            Self::SameOriginAllowPopups => b"same-origin-allow-popups",
            Self::SameOrigin => b"same-origin",
            Self::NoopenerAllowPopups => b"noopener-allow-popups",
        }
    }
}

/// The `Cross-Origin-Embedder-Policy` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbedderValue {
    /// `unsafe-none`.
    UnsafeNone,
    /// `require-corp`.
    RequireCorp,
    /// `credentialless`.
    Credentialless,
}

impl EmbedderValue {
    fn token(self) -> &'static [u8] {
        match self {
            Self::UnsafeNone => b"unsafe-none",
            Self::RequireCorp => b"require-corp",
            Self::Credentialless => b"credentialless",
        }
    }
}

/// A cross-origin isolation policy: a token, an optional reporting endpoint, and
/// whether it is only reported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Isolation<V> {
    /// The policy token.
    pub value: V,
    /// The `report-to` endpoint name, a structured-field string.
    pub report_to: Option<String>,
    /// Whether the policy is only reported (the `-Report-Only` field).
    pub report_only: bool,
}

impl<V: Copy> Isolation<V> {
    fn render(&self, token: &[u8]) -> Result<Vec<u8>> {
        let mut out = token.to_vec();
        if let Some(endpoint) = &self.report_to {
            if !endpoint.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
                return Err(Error::Protocol(format!(
                    "{endpoint:?} is not a structured-field string"
                )));
            }
            out.extend_from_slice(b";report-to=\"");
            for byte in endpoint.bytes() {
                if byte == b'"' || byte == b'\\' {
                    out.push(b'\\');
                }
                out.push(byte);
            }
            out.push(b'"');
        }
        Ok(out)
    }
}

/// The opener policy of a document.
pub type OpenerPolicy = Isolation<OpenerValue>;

/// The embedder policy of a document.
pub type EmbedderPolicy = Isolation<EmbedderValue>;

/// The security response headers of a route or an application.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecurityHeaders {
    /// `Strict-Transport-Security`, sent only over a secure transport.
    pub hsts: Option<Hsts>,
    /// The content security policy; none by default, since a policy has to fit the
    /// application's own scripts and styles.
    pub csp: Option<Csp>,
    /// Whether to send `X-Content-Type-Options: nosniff`.
    pub nosniff: bool,
    /// `X-Frame-Options`.
    pub frame_options: Option<FrameOptions>,
    /// `Referrer-Policy`, one token or a fallback list; empty sends nothing.
    pub referrer_policy: Vec<ReferrerPolicy>,
    /// `Cross-Origin-Resource-Policy`.
    pub resource_policy: Option<ResourcePolicy>,
    /// `Cross-Origin-Opener-Policy`.
    pub opener_policy: Option<OpenerPolicy>,
    /// `Cross-Origin-Embedder-Policy`.
    pub embedder_policy: Option<EmbedderPolicy>,
    /// Whether to send `X-XSS-Protection: 0`, which turns off the legacy filter.
    pub xss_protection_off: bool,
}

impl Default for SecurityHeaders {
    /// The values the OWASP cheat sheet recommends, except the ones that change what
    /// a page may load: no content security policy and no embedder policy until the
    /// application sets them.
    fn default() -> Self {
        SecurityHeaders {
            hsts: Some(Hsts {
                max_age: 63_072_000,
                include_subdomains: true,
            }),
            csp: None,
            nosniff: true,
            frame_options: Some(FrameOptions::Deny),
            referrer_policy: vec![ReferrerPolicy::StrictOriginWhenCrossOrigin],
            resource_policy: Some(ResourcePolicy::SameSite),
            opener_policy: Some(Isolation {
                value: OpenerValue::SameOrigin,
                report_to: None,
                report_only: false,
            }),
            embedder_policy: None,
            xss_protection_off: true,
        }
    }
}

/// The fields one response gets, and the nonce its page must use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendered {
    /// The field lines to add.
    pub fields: Vec<Field>,
    /// The nonce the policy names, for the page's `<script nonce>` and `<style
    /// nonce>` attributes.
    pub nonce: Option<String>,
}

impl SecurityHeaders {
    /// The fields for one response.
    ///
    /// # Arguments
    ///
    /// * `secure` - whether the response travels over TLS; HSTS is sent only then.
    /// * `rng` - the generator a nonce is drawn from, when the policy names one.
    ///
    /// # Returns
    ///
    /// The fields, one of each, and the response's nonce.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when the generator fails, and [`Error::Protocol`] for a
    /// `report-to` endpoint that is not a structured-field string.
    pub fn render(&self, secure: bool, rng: &dyn Rng) -> Result<Rendered> {
        let mut fields: Vec<Field> = Vec::new();
        let mut nonce_value = None;
        if secure {
            if let Some(hsts) = &self.hsts {
                fields.push((b"Strict-Transport-Security", hsts.value()));
            }
        }
        if let Some(csp) = &self.csp {
            if csp.needs_nonce() {
                nonce_value = Some(nonce(rng)?);
            }
            fields.push((csp.field_name(), csp.header_value(nonce_value.as_deref())?));
        }
        if self.nosniff {
            fields.push((b"X-Content-Type-Options", b"nosniff".to_vec()));
        }
        if let Some(frame) = self.frame_options {
            fields.push((b"X-Frame-Options", frame.value().to_vec()));
        }
        if !self.referrer_policy.is_empty() {
            let tokens: Vec<&[u8]> = self.referrer_policy.iter().map(|p| p.token()).collect();
            fields.push((b"Referrer-Policy", tokens.join(&b", "[..])));
        }
        if let Some(policy) = self.resource_policy {
            fields.push((b"Cross-Origin-Resource-Policy", policy.value().to_vec()));
        }
        if let Some(opener) = &self.opener_policy {
            let name: &'static [u8] = if opener.report_only {
                b"Cross-Origin-Opener-Policy-Report-Only"
            } else {
                b"Cross-Origin-Opener-Policy"
            };
            fields.push((name, opener.render(opener.value.token())?));
        }
        if let Some(embedder) = &self.embedder_policy {
            let name: &'static [u8] = if embedder.report_only {
                b"Cross-Origin-Embedder-Policy-Report-Only"
            } else {
                b"Cross-Origin-Embedder-Policy"
            };
            fields.push((name, embedder.render(embedder.value.token())?));
        }
        if self.xss_protection_off {
            fields.push((b"X-XSS-Protection", b"0".to_vec()));
        }
        Ok(Rendered {
            fields,
            nonce: nonce_value,
        })
    }

    /// Remove every field no response may carry, and every field this rule renders,
    /// from a response's own fields, so the rule's values are the only ones sent.
    ///
    /// # Arguments
    ///
    /// * `fields` - the response's field lines, names compared case-insensitively.
    pub fn scrub<N: AsRef<[u8]>, V>(&self, fields: &mut Vec<(N, V)>) {
        const RENDERED: &[&[u8]] = &[
            b"Strict-Transport-Security",
            b"Content-Security-Policy",
            b"Content-Security-Policy-Report-Only",
            b"X-Content-Type-Options",
            b"X-Frame-Options",
            b"Referrer-Policy",
            b"Cross-Origin-Resource-Policy",
            b"Cross-Origin-Opener-Policy",
            b"Cross-Origin-Opener-Policy-Report-Only",
            b"Cross-Origin-Embedder-Policy",
            b"Cross-Origin-Embedder-Policy-Report-Only",
            b"X-XSS-Protection",
        ];
        fields.retain(|(name, _)| {
            let name = name.as_ref();
            !REMOVED
                .iter()
                .chain(RENDERED.iter())
                .any(|known| known.eq_ignore_ascii_case(name))
        });
    }
}
