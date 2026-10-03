//! Suffix entries in a CORS origin list: `.example.com` allows the origins whose
//! host is a subdomain of `example.com`, matched at a label boundary only, and an
//! allowed origin is reflected as the Fetch Standard's CORS protocol requires.

use zero_http_types::Method;
use zero_policy::{AllowOrigin, Cors, Decision};

fn listing(entries: &[&str]) -> Cors {
    Cors {
        allow_origin: AllowOrigin::List(
            entries
                .iter()
                .map(|entry| entry.as_bytes().to_vec())
                .collect(),
        ),
        ..Cors::default()
    }
}

fn field<'a>(fields: &'a [(&'static [u8], Vec<u8>)], name: &[u8]) -> Option<&'a [u8]> {
    fields
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_slice())
}

#[test]
fn a_suffix_entry_matches_only_at_a_label_boundary_so_example_com_never_allows_badexample_com() {
    let rule = listing(&[".example.com"]);
    for origin in [
        "https://badexample.com",
        "https://example.com",
        "https://example.com.evil",
        "https://a.example.com.evil",
        "https://example.community",
        "https://aexample.com",
        "https://a-example.com",
    ] {
        assert!(!rule.allows(origin.as_bytes()), "{origin}");
        assert_eq!(
            rule.decide(Some(Method::Get), Some(origin.as_bytes()), None, None),
            Decision::Refused { preflight: false },
            "{origin}"
        );
    }
    assert!(rule.allows(b"https://a.example.com"));
}

#[test]
fn a_suffix_entry_allows_a_subdomain_of_any_depth_and_scheme_without_a_port() {
    let rule = listing(&[".example.com"]);
    for origin in [
        "https://a.example.com",
        "http://a.example.com",
        "https://a.b.example.com",
        "https://x-1.example.com",
        "web+app://a.example.com",
    ] {
        assert!(rule.allows(origin.as_bytes()), "{origin}");
    }
    for origin in [
        "https://a.example.com:8443",
        "https://a.example.com:443",
        "https://a.example.com/",
        "https://A.example.com",
        "https://.example.com",
        "null",
    ] {
        assert!(!rule.allows(origin.as_bytes()), "{origin}");
    }
}

#[test]
fn a_suffix_entry_never_allows_an_ip_address_host() {
    let rule = listing(&[".example.com"]);
    assert!(!rule.allows(b"https://[2001:db8::1]"));
    assert!(!rule.allows(b"http://192.0.2.1"));
    let numeric = listing(&[".2.1"]);
    assert!(!numeric.allows(b"http://192.0.2.1"));
    let hexadecimal = listing(&[".0x7f"]);
    assert!(!hexadecimal.allows(b"http://a.0x7f"));
}

#[test]
fn a_list_entry_is_a_fetch_section_3_2_serialized_origin_or_a_dot_and_a_serialized_domain() {
    for entry in [
        ".example.com",
        ".com",
        ".a-b.example",
        ".x1",
        "https://example.com",
        "http://a.example.com:8080",
        "https://[2001:db8::1]",
    ] {
        assert!(AllowOrigin::is_valid_entry(entry.as_bytes()), "{entry}");
    }
    for entry in [
        ".",
        "..example.com",
        ".example.com.",
        ".Example.com",
        ".-a.example",
        ".a-.example",
        ".exa mple.com",
        ".exa_mple.com",
        "example.com",
        "*.example.com",
        "https://example.com/",
        "https://Example.com",
        "null",
        "",
    ] {
        assert!(!AllowOrigin::is_valid_entry(entry.as_bytes()), "{entry}");
    }
}

#[test]
fn a_suffix_entry_whose_domain_ends_in_a_number_per_the_url_standard_host_parser_is_refused() {
    for entry in [".1", ".0.1", ".example.123", ".0x7f", ".0x", ".017"] {
        assert!(!AllowOrigin::is_valid_entry(entry.as_bytes()), "{entry}");
    }
    for entry in [".1a", ".example.0x7g", ".018x", ".a1"] {
        assert!(AllowOrigin::is_valid_entry(entry.as_bytes()), "{entry}");
    }
}

#[test]
fn a_malformed_suffix_entry_allows_nothing() {
    for entry in [
        ".Example.com",
        ".example.com.",
        "..example.com",
        ".",
        ".2.1",
    ] {
        let rule = listing(&[entry]);
        for origin in [
            "https://a.example.com",
            "https://a.Example.com",
            "https://a..example.com",
            "http://192.0.2.1",
        ] {
            assert!(!rule.allows(origin.as_bytes()), "{entry} {origin}");
        }
    }
}

#[test]
fn exact_entries_beside_a_suffix_entry_stay_exact_per_rfc_6454_section_5() {
    let rule = listing(&["https://example.com", ".example.net"]);
    assert!(rule.allows(b"https://example.com"));
    assert!(!rule.allows(b"https://a.example.com"));
    assert!(!rule.allows(b"http://example.com"));
    assert!(!rule.allows(b"https://example.com:8443"));
    assert!(rule.allows(b"https://a.example.net"));
    assert!(!rule.allows(b"https://example.net"));
}

#[test]
fn a_suffix_allowed_origin_is_reflected_literally_with_vary_origin() {
    let rule = listing(&[".example.com"]);
    let Decision::Allowed(fields) = rule.decide(
        Some(Method::Get),
        Some(b"https://a.example.com"),
        None,
        None,
    ) else {
        panic!("allowed");
    };
    assert_eq!(
        field(&fields, b"Access-Control-Allow-Origin"),
        Some(&b"https://a.example.com"[..])
    );
    assert_eq!(field(&fields, b"Vary"), Some(&b"Origin"[..]));
    let credentialed = Cors {
        credentials: true,
        ..listing(&[".example.com"])
    };
    let Decision::Allowed(fields) = credentialed.decide(
        Some(Method::Get),
        Some(b"https://a.b.example.com"),
        None,
        None,
    ) else {
        panic!("allowed");
    };
    assert_eq!(
        field(&fields, b"Access-Control-Allow-Origin"),
        Some(&b"https://a.b.example.com"[..])
    );
    assert_eq!(
        field(&fields, b"Access-Control-Allow-Credentials"),
        Some(&b"true"[..])
    );
}

#[test]
fn a_preflight_from_a_suffix_allowed_origin_is_answered_and_one_from_a_lookalike_is_refused() {
    let rule = listing(&[".example.com"]);
    let Decision::Preflight(fields) = rule.decide(
        Some(Method::Options),
        Some(b"https://api.example.com"),
        Some(b"POST"),
        None,
    ) else {
        panic!("a preflight");
    };
    assert_eq!(
        field(&fields, b"Access-Control-Allow-Origin"),
        Some(&b"https://api.example.com"[..])
    );
    assert_eq!(
        rule.decide(
            Some(Method::Options),
            Some(b"https://apiexample.com"),
            Some(b"POST"),
            None,
        ),
        Decision::Refused { preflight: true }
    );
}
