//! The CORS rule on arbitrary request fields: the first octet picks the rule,
//! the method and which fields are present, and the rest splits at line feeds
//! into `Origin`, `Access-Control-Request-Method` and
//! `Access-Control-Request-Headers`. Following the Fetch Standard's CORS protocol
//! (Section 3.3): a request without `Origin` is not a CORS request, the literal
//! `null` and anything that is not a `serialized-origin` of the `Origin` grammar
//! are refused (Section 3.2, which supplants the definition in RFC 6454), only a
//! preflight (`OPTIONS` with a requested method) is answered as one,
//! `Access-Control-Allow-Origin` is `*` or the request's origin and never `*`
//! with credentials (Section 3.3.5), which also need
//! `Access-Control-Allow-Credentials: true`, `Vary: Origin` accompanies a
//! reflected origin (RFC 9110 Section 12.5.5), and a preflight is approved only
//! when the requested method and every requested header name are allowed, by
//! name or, without credentials, by the `*` wildcard (Section 3.3.4).

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_http_types::Method;
use zero_policy::{AllowOrigin, Cors, Decision};

fn list(items: &[&str]) -> Vec<Vec<u8>> {
    items.iter().map(|item| item.as_bytes().to_vec()).collect()
}

fn rule(index: u8) -> Cors {
    match index & 0x03 {
        0 => Cors::default(),
        1 => Cors {
            allow_origin: AllowOrigin::List(list(&[
                "https://foo.invalid",
                "https://rabbit.invalid",
            ])),
            credentials: true,
            allow_methods: list(&["GET", "PUT", "*"]),
            allow_headers: list(&["Content-Security-Policy", "*"]),
            expose_headers: list(&["*", "Strict-Transport-Security"]),
            max_age: Some(600),
        },
        2 => Cors {
            allow_origin: AllowOrigin::Any,
            credentials: true,
            allow_methods: list(&["GET", "POST"]),
            allow_headers: list(&["X-Requested-With"]),
            expose_headers: Vec::new(),
            max_age: None,
        },
        _ => Cors {
            allow_origin: AllowOrigin::Any,
            credentials: false,
            allow_methods: list(&["*"]),
            allow_headers: list(&["*"]),
            expose_headers: list(&["*"]),
            max_age: Some(5),
        },
    }
}

/// The members of a `#field-name` list (RFC 9110 Section 5.6.1), trimmed of
/// spaces and tabs, empty ones dropped.
fn members(value: &[u8]) -> Vec<&[u8]> {
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
                .map_or(start, |last| last + 1);
            &member[start..end]
        })
        .filter(|member| !member.is_empty())
        .collect()
}

/// Fetch Section 3.2 `serialized-ipv6`: eight lowercase groups without leading
/// zeros, or at most six around one `::`.
fn is_serialized_ipv6(address: &[u8]) -> bool {
    let h16 = |group: &[u8]| {
        group == b"0"
            || (matches!(group.first(), Some(b'1'..=b'9' | b'a'..=b'f'))
                && group.len() <= 4
                && group
                    .iter()
                    .all(|&byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    };
    let groups = |part: &[u8]| {
        if part.is_empty() {
            return Some(0);
        }
        let mut count = 0;
        for group in part.split(|&byte| byte == b':') {
            if !h16(group) {
                return None;
            }
            count += 1;
        }
        Some(count)
    };
    match address.windows(2).position(|pair| pair == b"::") {
        None => groups(address) == Some(8),
        Some(at) => match (groups(&address[..at]), groups(&address[at + 2..])) {
            (Some(before), Some(after)) => before + after <= 6,
            _ => false,
        },
    }
}

/// Fetch Section 3.2 `serialized-domain`: dot-separated labels of lowercase
/// letters, digits and inner hyphens. A `serialized-ipv4` has this form too.
fn is_serialized_domain(host: &[u8]) -> bool {
    let edge = |byte: Option<&u8>| {
        byte.is_some_and(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    };
    host.split(|&byte| byte == b'.').all(|label| {
        edge(label.first())
            && edge(label.last())
            && label
                .iter()
                .all(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// Fetch Section 3.2 `serialized-origin`:
/// `serialized-scheme "://" serialized-host [ ":" serialized-port ]`.
fn is_serialized_origin(origin: &[u8]) -> bool {
    let Some(colon) = origin.iter().position(|&byte| byte == b':') else {
        return false;
    };
    let (scheme, rest) = origin.split_at(colon);
    let Some(rest) = rest.strip_prefix(b"://") else {
        return false;
    };
    let scheme_ok = scheme.first().is_some_and(u8::is_ascii_lowercase)
        && scheme.iter().all(|&byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.')
        });
    let (host_ok, port) = match rest.strip_prefix(b"[") {
        Some(inner) => match inner.iter().position(|&byte| byte == b']') {
            Some(close) => (is_serialized_ipv6(&inner[..close]), &inner[close + 1..]),
            None => return false,
        },
        None => {
            let end = rest
                .iter()
                .position(|&byte| byte == b':')
                .unwrap_or(rest.len());
            (is_serialized_domain(&rest[..end]), &rest[end..])
        }
    };
    let port_ok = port.is_empty()
        || port.strip_prefix(b":").is_some_and(|digits| {
            (1..=5).contains(&digits.len()) && digits.iter().all(u8::is_ascii_digit)
        });
    scheme_ok && host_ok && port_ok
}

fn field<'f>(fields: &'f [(&'static [u8], Vec<u8>)], name: &[u8]) -> Vec<&'f [u8]> {
    fields
        .iter()
        .filter(|(field, _)| *field == name)
        .map(|(_, value)| value.as_slice())
        .collect()
}

fuzz_target!(|data: &[u8]| {
    let Some((&selector, rest)) = data.split_first() else {
        return;
    };
    let cors = rule(selector);
    let method = match (selector >> 2) & 0x03 {
        0 => None,
        1 => Some(Method::Get),
        2 => Some(Method::Options),
        _ => Some(Method::Post),
    };
    let mut parts = rest.splitn(3, |&byte| byte == b'\n');
    let origin = parts.next().filter(|_| selector & 0x10 == 0);
    let request_method = parts.next().filter(|_| selector & 0x20 == 0);
    let request_headers = parts.next().filter(|_| selector & 0x40 == 0);

    let decision = cors.decide(method, origin, request_method, request_headers);
    let preflight = method == Some(Method::Options) && request_method.is_some();
    let Some(origin) = origin else {
        assert_eq!(decision, Decision::NotCors);
        return;
    };
    let fields = match decision {
        Decision::NotCors => panic!("a request with Origin is a CORS request"),
        Decision::Refused { preflight: refused } => {
            assert_eq!(refused, preflight);
            return;
        }
        Decision::Preflight(fields) => {
            assert!(preflight);
            fields
        }
        Decision::Allowed(fields) => {
            assert!(!preflight);
            fields
        }
    };
    assert_ne!(origin, b"null");
    assert!(cors.allows(origin));
    if let AllowOrigin::List(allowed) = &cors.allow_origin {
        assert!(allowed.iter().any(|entry| entry == origin));
    }
    assert!(
        is_serialized_origin(origin),
        "only a serialized origin is allowed (Fetch Section 3.2): {:?}",
        String::from_utf8_lossy(origin)
    );

    let allow_origin = field(&fields, b"Access-Control-Allow-Origin");
    assert_eq!(allow_origin.len(), 1);
    let reflected = allow_origin[0] == origin;
    assert!(reflected || allow_origin[0] == b"*");
    assert_eq!(field(&fields, b"Vary") == [b"Origin"], reflected);
    let credentials = field(&fields, b"Access-Control-Allow-Credentials");
    if cors.credentials {
        assert!(reflected, "never * with credentials");
        assert_eq!(credentials, [b"true"]);
    } else {
        assert!(credentials.is_empty());
    }

    let wildcard = !cors.credentials;
    if preflight {
        let asked = request_method.unwrap();
        let methods = &cors.allow_methods;
        assert!(
            methods.iter().any(|allowed| allowed == asked)
                || wildcard && methods.iter().any(|allowed| allowed == b"*")
        );
        let headers = &cors.allow_headers;
        let any_header = wildcard && headers.iter().any(|allowed| allowed == b"*");
        for name in request_headers.map(members).unwrap_or_default() {
            assert!(
                any_header
                    || headers
                        .iter()
                        .any(|allowed| allowed.eq_ignore_ascii_case(name))
            );
        }
        assert_eq!(field(&fields, b"Access-Control-Allow-Methods").len(), 1);
        if cors.credentials {
            assert_ne!(field(&fields, b"Access-Control-Allow-Methods"), [b"*"]);
            assert_ne!(field(&fields, b"Access-Control-Allow-Headers"), [b"*"]);
        }
        let max_age = field(&fields, b"Access-Control-Max-Age");
        match cors.max_age {
            Some(seconds) => assert_eq!(max_age, [seconds.to_string().as_bytes()]),
            None => assert!(max_age.is_empty()),
        }
        assert!(field(&fields, b"Access-Control-Expose-Headers").is_empty());
    } else {
        for value in field(&fields, b"Access-Control-Expose-Headers") {
            assert!(!cors.credentials || !members(value).contains(&&b"*"[..]));
        }
        assert!(field(&fields, b"Access-Control-Allow-Methods").is_empty());
    }
});
