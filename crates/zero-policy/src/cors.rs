//! CORS: the server side of the Fetch Standard's CORS protocol.
//!
//! A CORS request is a request with an `Origin` field; a CORS-preflight request is
//! `OPTIONS` with `Origin` and `Access-Control-Request-Method`. The response says
//! whether it may be shared through `Access-Control-Allow-Origin`, which carries the
//! literal `Origin` value or `*` and never a list, and, with credentials,
//! `Access-Control-Allow-Credentials: true` beside a reflected origin, since "if
//! credentials mode is 'include', then Access-Control-Allow-Origin cannot be `*`"
//! and the `*` of the other allow fields "counts as a wildcard for requests without
//! credentials" only. An origin is compared as RFC 6454 Section 5 says, "the same
//! if, and only if, they have identical schemes, hosts, and ports", and the literal
//! `null` of a privacy-sensitive context matches nothing. When the allowed origin
//! varies per request the response carries `Vary: Origin` (RFC 9110 Section
//! 12.5.5).

use zero_date::Decimal;
use zero_http_types::Method;

/// Which origins a rule allows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AllowOrigin {
    /// Every origin: `*`, or the request's origin reflected when credentials are on.
    Any,
    /// These serialized origins exactly, scheme, host and port.
    List(Vec<Vec<u8>>),
}

/// A CORS rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cors {
    /// Which origins may share responses.
    pub allow_origin: AllowOrigin,
    /// Whether responses may be shared with credentials.
    pub credentials: bool,
    /// The methods a preflight may approve; `*` means any, for requests without
    /// credentials.
    pub allow_methods: Vec<Vec<u8>>,
    /// The request headers a preflight may approve; `*` means any, for requests
    /// without credentials.
    pub allow_headers: Vec<Vec<u8>>,
    /// The response headers a client may read beyond the CORS-safelisted ones.
    pub expose_headers: Vec<Vec<u8>>,
    /// How long a preflight's answer may be cached, in seconds.
    pub max_age: Option<u32>,
}

impl Default for Cors {
    fn default() -> Self {
        Cors {
            allow_origin: AllowOrigin::Any,
            credentials: false,
            allow_methods: vec![b"GET".to_vec(), b"HEAD".to_vec(), b"POST".to_vec()],
            allow_headers: Vec::new(),
            expose_headers: Vec::new(),
            max_age: None,
        }
    }
}

/// A field line the rule adds to the response.
pub type Field = (&'static [u8], Vec<u8>);

/// What the rule decided for one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// No `Origin` field: not a CORS request, nothing is added.
    NotCors,
    /// The origin is not allowed, or the preflight asks for a method or a header
    /// the rule does not allow: nothing is added, and a preflight is answered
    /// `403` with no body.
    Refused {
        /// Whether the request was a preflight, which is answered `403` with no
        /// body rather than run.
        preflight: bool,
    },
    /// A CORS-preflight request to answer `204` with these fields and no body,
    /// without running the route.
    Preflight(Vec<Field>),
    /// A CORS request to run as usual, with these fields on its response.
    Allowed(Vec<Field>),
}

/// Whether `origin` is a serialized origin of RFC 6454 Section 6.2,
/// `scheme "://" host [ ":" port ]`, which the literal `null` is not.
fn is_serialized_origin(origin: &[u8]) -> bool {
    let Some(at) = origin.windows(3).position(|window| window == b"://") else {
        return false;
    };
    let scheme = origin.get(..at).unwrap_or(&[]);
    let rest = origin.get(at.saturating_add(3)..).unwrap_or(&[]);
    let scheme_ok = scheme.first().is_some_and(u8::is_ascii_alphabetic)
        && scheme
            .iter()
            .all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'));
    if !scheme_ok || rest.is_empty() {
        return false;
    }
    let (host, port) = match rest.iter().rposition(|&byte| byte == b':') {
        Some(colon)
            if !rest.get(..colon).unwrap_or(&[]).ends_with(b"]")
                || rest.contains(&b'[') && rest.get(colon..).is_some_and(|tail| tail.len() > 1) =>
        {
            let tail = rest.get(colon.saturating_add(1)..).unwrap_or(&[]);
            if rest.starts_with(b"[") && !rest.get(..colon).unwrap_or(&[]).ends_with(b"]") {
                (rest, &[][..])
            } else {
                (rest.get(..colon).unwrap_or(&[]), tail)
            }
        }
        _ => (rest, &[][..]),
    };
    if host.is_empty() || host.contains(&b'/') || host.contains(&b' ') {
        return false;
    }
    port.is_empty() || (port.len() <= 5 && port.iter().all(u8::is_ascii_digit))
}

/// The members of a `#field-name` or `#method` list, trimmed, empty ones dropped.
fn members(value: &[u8]) -> impl Iterator<Item = &[u8]> {
    value
        .split(|&byte| byte == b',')
        .map(|member| {
            let start = member
                .iter()
                .position(|&byte| byte != b' ' && byte != b'\t')
                .unwrap_or(member.len());
            let end = member
                .iter()
                .rposition(|&byte| byte != b' ' && byte != b'\t')
                .map_or(start, |last| last.saturating_add(1));
            member.get(start..end).unwrap_or(&[])
        })
        .filter(|member| !member.is_empty())
}

fn join(list: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for item in list {
        if !out.is_empty() {
            out.extend_from_slice(b", ");
        }
        out.extend_from_slice(item);
    }
    out
}

impl Cors {
    /// Whether `origin` is allowed; the literal `null` never is, nor anything that
    /// is not a serialized origin.
    #[must_use]
    pub fn allows(&self, origin: &[u8]) -> bool {
        if origin == b"null" || !is_serialized_origin(origin) {
            return false;
        }
        match &self.allow_origin {
            AllowOrigin::Any => true,
            AllowOrigin::List(list) => list.iter().any(|allowed| allowed == origin),
        }
    }

    /// Whether `*` may stand for the allowed methods or headers: only for a request
    /// without credentials.
    fn wildcard_allowed(&self) -> bool {
        !self.credentials
    }

    /// The `Access-Control-Allow-Origin` value and whether it varies by `Origin`.
    fn allow_origin_value(&self, origin: &[u8]) -> (Vec<u8>, bool) {
        match &self.allow_origin {
            AllowOrigin::Any if !self.credentials => (b"*".to_vec(), false),
            _ => (origin.to_vec(), true),
        }
    }

    /// Decide a request.
    ///
    /// # Arguments
    ///
    /// * `method` - the request method.
    /// * `origin` - the `Origin` field, if any.
    /// * `request_method` - `Access-Control-Request-Method`, if any.
    /// * `request_headers` - `Access-Control-Request-Headers`, if any.
    #[must_use]
    pub fn decide(
        &self,
        method: Option<Method>,
        origin: Option<&[u8]>,
        request_method: Option<&[u8]>,
        request_headers: Option<&[u8]>,
    ) -> Decision {
        let Some(origin) = origin else {
            return Decision::NotCors;
        };
        let preflight = method == Some(Method::Options) && request_method.is_some();
        if !self.allows(origin) {
            return Decision::Refused { preflight };
        }
        let (allow_origin, varies) = self.allow_origin_value(origin);
        let mut fields: Vec<Field> = vec![(b"Access-Control-Allow-Origin", allow_origin)];
        if self.credentials {
            fields.push((b"Access-Control-Allow-Credentials", b"true".to_vec()));
        }
        if varies {
            fields.push((b"Vary", b"Origin".to_vec()));
        }
        if !preflight {
            if !self.expose_headers.is_empty() {
                let exposed: Vec<Vec<u8>> = self
                    .expose_headers
                    .iter()
                    .filter(|name| name.as_slice() != b"*" || self.wildcard_allowed())
                    .cloned()
                    .collect();
                if !exposed.is_empty() {
                    fields.push((b"Access-Control-Expose-Headers", join(&exposed)));
                }
            }
            return Decision::Allowed(fields);
        }
        // A preflight: the asked method and headers must each be allowed, by name
        // or, without credentials, by the wildcard.
        let any_method = self.wildcard_allowed() && self.allow_methods.iter().any(|m| m == b"*");
        let any_header = self.wildcard_allowed() && self.allow_headers.iter().any(|h| h == b"*");
        let asked_method = request_method.unwrap_or(&[]);
        let method_ok = any_method
            || self
                .allow_methods
                .iter()
                .any(|allowed| allowed.as_slice() == asked_method);
        if !method_ok {
            return Decision::Refused { preflight: true };
        }
        let asked_headers: Vec<&[u8]> =
            request_headers.map(members).into_iter().flatten().collect();
        let headers_ok = any_header
            || asked_headers.iter().all(|asked| {
                self.allow_headers
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(asked))
            });
        if !headers_ok {
            return Decision::Refused { preflight: true };
        }
        let methods = if any_method {
            b"*".to_vec()
        } else {
            join(&self.allow_methods)
        };
        fields.push((b"Access-Control-Allow-Methods", methods));
        if any_header {
            fields.push((b"Access-Control-Allow-Headers", b"*".to_vec()));
        } else if !self.allow_headers.is_empty() {
            fields.push((b"Access-Control-Allow-Headers", join(&self.allow_headers)));
        }
        if let Some(seconds) = self.max_age {
            fields.push((
                b"Access-Control-Max-Age",
                Decimal::new(u64::from(seconds)).as_bytes().to_vec(),
            ));
        }
        Decision::Preflight(fields)
    }
}
