//! The policies and the routes answered in Rust, end to end over loopback: one
//! trust-proxy rule per server and the client it names, read from the one header
//! family the policy names and taken from the right of the forwarding chain because
//! "the chain of IP addresses listed before the request came to the proxy cannot be
//! trusted" (RFC 7239 Section 8.1); `Strict-Transport-Security` only over a secure
//! transport (RFC 6797 Section 7.2), whatever the other header family claims; the
//! CORS sharing fields, one
//! `Access-Control-Allow-Origin` per response and `Vary: Origin` (Fetch, CORS check
//! and CORS protocol and HTTP caches); the precedence of overlapping policies; the
//! fields of a preflight answered in Rust; a static route's answers to other methods
//! and its fallthrough to the miss route; and the driver's own 413, which no policy
//! reaches.

#![cfg(any(feature = "policy", feature = "static"))]

mod support;

/// How many field lines of `name` a reply carries.
#[cfg(feature = "policy")]
fn lines(reply: &support::Reply, name: &str) -> usize {
    reply
        .headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .count()
}

/// Send a GET with extra field lines, each ending in CRLF, and read the reply.
#[cfg(feature = "policy")]
fn get_with_fields(client: &mut support::Client, path: &str, fields: &str) -> support::Reply {
    client.get_with(&format!("GET {path} HTTP/1.1\r\nHost: t\r\n{fields}\r\n"))
}

#[cfg(feature = "policy")]
#[test]
fn a_server_has_one_trust_proxy_policy_and_a_mounted_application_cannot_carry_one() {
    use zero_host::{App, Method, PolicyKind, RouteKind, Status};
    let mut app = App::new();
    app.policy(PolicyKind::TrustProxy, "/", br#"{"cidrs":["10.0.0.0/8"]}"#)
        .unwrap();
    let before = app.table();
    let second = app
        .policy(PolicyKind::TrustProxy, "", br#"{"cidrs":["0.0.0.0/0"]}"#)
        .unwrap_err();
    assert_eq!(second.status(), Status::InvalidArgument, "{second}");
    let mut child = App::new();
    child
        .route(
            RouteKind::Fixed,
            Some(Method::Get),
            "/x",
            br#"{"body":"x"}"#,
        )
        .unwrap();
    child
        .policy(PolicyKind::TrustProxy, "/", br#"{"cidrs":["0.0.0.0/0"]}"#)
        .unwrap();
    let mounted = app.mount("/api", child.clone()).unwrap_err();
    assert_eq!(mounted.status(), Status::InvalidArgument, "{mounted}");
    assert_eq!(
        app.table(),
        before,
        "a refused registration changes nothing"
    );
    let mut bare = App::new();
    assert_eq!(
        bare.mount("/api", child).unwrap_err().status(),
        Status::InvalidArgument,
        "the rule covers every path, so no mounted application carries one"
    );
}

#[cfg(feature = "policy")]
#[test]
fn a_trust_proxy_document_names_the_one_header_family_its_proxies_write() {
    use zero_host::{App, PolicyKind, Status};
    for accepted in [
        &br#"{"cidrs":["10.0.0.0/8"]}"#[..],
        br#"{"cidrs":["10.0.0.0/8"],"header":"x-forwarded-for"}"#,
        br#"{"header":"Forwarded"}"#,
    ] {
        App::new()
            .policy(PolicyKind::TrustProxy, "/", accepted)
            .unwrap();
    }
    for refused in [
        &br#"{"header":"x-real-ip"}"#[..],
        br#"{"header":"forwarded, x-forwarded-for"}"#,
        br#"{"header":["forwarded"]}"#,
    ] {
        let err = App::new()
            .policy(PolicyKind::TrustProxy, "/", refused)
            .unwrap_err();
        assert_eq!(err.status(), Status::Codec, "{err}");
        assert!(err.message().contains("`header`"), "{err}");
    }
    let mut forwarded = App::new();
    forwarded
        .policy(PolicyKind::TrustProxy, "/", br#"{"header":"forwarded"}"#)
        .unwrap();
    let mut listed = App::new();
    listed.policy(PolicyKind::TrustProxy, "/", b"").unwrap();
    assert_ne!(
        forwarded.table(),
        listed.table(),
        "the family is part of the canonical table"
    );
}

#[cfg(all(feature = "policy", feature = "testing"))]
#[test]
fn the_client_is_read_from_the_policys_header_family_from_the_right_7239_8_1() {
    use std::net::IpAddr;
    use zero_host::testing::inspect;
    use zero_host::{bind_thread, complete, App, Method, PolicyKind, RouteKind};
    let families = [
        (
            "x-forwarded-for",
            [
                ("X-Forwarded-For: 203.0.113.9, 198.51.100.7", "198.51.100.7"),
                (
                    "X-Forwarded-For: 203.0.113.9, 198.51.100.7, 10.1.2.3",
                    "198.51.100.7",
                ),
                (
                    "X-Forwarded-For: 203.0.113.9\r\nX-Forwarded-For: 198.51.100.7",
                    "198.51.100.7",
                ),
                ("X-Forwarded-For: 10.0.0.5", "10.0.0.5"),
                ("X-Forwarded-For: 203.0.113.9, unknown", "0.0.0.0"),
                (
                    "Forwarded: for=203.0.113.9\r\nX-Forwarded-For: 198.51.100.7",
                    "198.51.100.7",
                ),
                ("Forwarded: for=203.0.113.9", "127.0.0.1"),
            ],
        ),
        (
            "forwarded",
            [
                (
                    "Forwarded: for=203.0.113.9, for=198.51.100.7",
                    "198.51.100.7",
                ),
                (
                    "Forwarded: for=203.0.113.9\r\nForwarded: for=198.51.100.7;proto=https, for=10.1.2.3",
                    "198.51.100.7",
                ),
                ("Forwarded: for=\"[2001:db8::1]:4711\"", "2001:db8::1"),
                ("Forwarded: for=10.0.0.5", "10.0.0.5"),
                ("Forwarded: for=203.0.113.9, for=unknown", "0.0.0.0"),
                (
                    "X-Forwarded-For: 203.0.113.9\r\nForwarded: for=198.51.100.7",
                    "198.51.100.7",
                ),
                ("X-Forwarded-For: 203.0.113.9", "127.0.0.1"),
            ],
        ),
    ];
    for (header, cases) in families {
        let mut app = App::new();
        app.route(RouteKind::Host, Some(Method::Get), "/who", b"")
            .unwrap();
        let document =
            format!(r#"{{"cidrs":["127.0.0.1","::1","10.0.0.0/8"],"header":"{header}"}}"#);
        app.policy(PolicyKind::TrustProxy, "/", document.as_bytes())
            .unwrap();
        let server = support::start(&app, r#"{"threads":1}"#);
        let worker = server.workers()[0];
        let target = support::TestTarget::new(4);
        server.attach(worker, target.clone()).unwrap();
        bind_thread(worker).unwrap();
        let mut client = support::Client::connect(&server);
        for (fields, expected) in cases {
            client.send(format!("GET /who HTTP/1.1\r\nHost: t\r\n{fields}\r\n\r\n").as_bytes());
            let batch = target.take();
            let id = support::ids(batch)[0];
            let seen = inspect(id, |exchange| exchange.client()).unwrap();
            assert_eq!(
                seen.map(|address| address.ip()),
                Some(expected.parse::<IpAddr>().unwrap()),
                "{header}: {fields}"
            );
            complete(worker, &[id], batch.epoch, None).unwrap();
            assert_eq!(client.read().unwrap().status, 500);
        }
        client.send_get("/who");
        let batch = target.take();
        let id = support::ids(batch)[0];
        let (peer, seen) = inspect(id, |exchange| {
            (exchange.request().peer(), exchange.client())
        })
        .unwrap();
        assert_eq!(
            seen, peer,
            "{header}: without forwarding fields the client is the peer"
        );
        complete(worker, &[id], batch.epoch, None).unwrap();
        assert_eq!(client.read().unwrap().status, 500);
        support::stop(&server);
    }
}

#[cfg(feature = "policy")]
#[test]
fn strict_transport_security_is_sent_only_on_responses_over_a_secure_transport_6797_7_2() {
    use zero_host::{App, Method, PolicyKind, RouteKind};
    let fields = br#"{"fields":[["Strict-Transport-Security","max-age=63072000; includeSubDomains"],["X-Frame-Options","DENY"]]}"#;
    let mut untrusting = App::new();
    untrusting
        .route(
            RouteKind::Fixed,
            Some(Method::Get),
            "/page",
            br#"{"body":"page"}"#,
        )
        .unwrap();
    untrusting
        .policy(PolicyKind::SecurityHeaders, "/", fields)
        .unwrap();
    let families = [
        (
            "x-forwarded-for",
            [
                ("X-Forwarded-Proto: https\r\n", true),
                (
                    "X-Forwarded-For: 198.51.100.7\r\nX-Forwarded-Proto: https, http\r\n",
                    false,
                ),
                ("X-Forwarded-Proto: http\r\n", false),
                ("Forwarded: for=198.51.100.7;proto=https\r\n", false),
                (
                    "X-Forwarded-Proto: https\r\nForwarded: for=198.51.100.7;proto=http\r\n",
                    true,
                ),
                (
                    "X-Forwarded-Proto: http\r\nForwarded: for=198.51.100.7;proto=https\r\n",
                    false,
                ),
            ],
        ),
        (
            "forwarded",
            [
                ("Forwarded: for=198.51.100.7;proto=https\r\n", true),
                (
                    "Forwarded: for=203.0.113.9;proto=https, for=198.51.100.7;proto=http\r\n",
                    false,
                ),
                ("Forwarded: for=198.51.100.7;proto=http\r\n", false),
                (
                    "X-Forwarded-For: 198.51.100.7\r\nX-Forwarded-Proto: https\r\n",
                    false,
                ),
                (
                    "Forwarded: for=198.51.100.7;proto=https\r\nX-Forwarded-Proto: http\r\n",
                    true,
                ),
                (
                    "Forwarded: for=198.51.100.7;proto=http\r\nX-Forwarded-Proto: https\r\n",
                    false,
                ),
            ],
        ),
    ];
    for (header, cases) in families {
        let mut app = untrusting.clone();
        let document = format!(r#"{{"cidrs":["127.0.0.1","::1"],"header":"{header}"}}"#);
        app.policy(PolicyKind::TrustProxy, "/", document.as_bytes())
            .unwrap();
        let server = support::start(&app, r#"{"threads":1}"#);
        let mut client = support::Client::connect(&server);
        let plain = client.get("/page");
        assert_eq!(
            plain.header("strict-transport-security"),
            None,
            "{header}: plain HTTP"
        );
        assert_eq!(plain.header("x-frame-options"), Some("DENY"));
        for (forwarding, sent) in cases {
            let reply = get_with_fields(&mut client, "/page", forwarding);
            assert_eq!(
                reply.header("strict-transport-security").is_some(),
                sent,
                "{header}: {forwarding}"
            );
            assert!(lines(&reply, "strict-transport-security") <= 1);
            assert_eq!(reply.header("x-frame-options"), Some("DENY"));
        }
        support::stop(&server);
    }

    let server = support::start(&untrusting, r#"{"threads":1}"#);
    let mut client = support::Client::connect(&server);
    let reply = get_with_fields(
        &mut client,
        "/page",
        "Forwarded: for=198.51.100.7;proto=https\r\n",
    );
    assert_eq!(
        reply.header("strict-transport-security"),
        None,
        "an untrusted peer's forwarding fields say nothing"
    );
    support::stop(&server);
}

#[cfg(feature = "policy")]
#[test]
fn cors_credentials_are_refused_without_an_explicit_origin_list_since_they_cannot_go_with_the_wildcard_fetch_3_3_5(
) {
    use zero_host::{App, PolicyKind, Status};
    let mut app = App::new();
    for refused in [
        &br#"{"origins":"*","credentials":true}"#[..],
        br#"{"credentials":true}"#,
    ] {
        let err = app.policy(PolicyKind::Cors, "/", refused).unwrap_err();
        assert_eq!(err.status(), Status::Codec, "{err}");
        assert!(err.message().contains("`credentials`"), "{err}");
    }
    app.policy(
        PolicyKind::Cors,
        "/",
        br#"{"origins":["https://a.example"],"credentials":true}"#,
    )
    .unwrap();
    app.policy(
        PolicyKind::Cors,
        "/open",
        br#"{"origins":"*","credentials":false}"#,
    )
    .unwrap();
}

#[cfg(feature = "policy")]
#[test]
fn a_response_a_cors_rule_covers_varies_on_origin_or_always_carries_the_wildcard_9110_12_5_5() {
    use zero_host::{App, Method, PolicyKind, RouteKind};
    let mut app = App::new();
    for path in ["/list/x", "/any/x"] {
        app.route(
            RouteKind::Fixed,
            Some(Method::Get),
            path,
            br#"{"body":"x"}"#,
        )
        .unwrap();
    }
    app.policy(
        PolicyKind::Cors,
        "/list",
        br#"{"origins":["https://a.example"]}"#,
    )
    .unwrap();
    app.policy(PolicyKind::Cors, "/any", br#"{"origins":"*"}"#)
        .unwrap();
    let server = support::start(&app, r#"{"threads":1}"#);
    let mut client = support::Client::connect(&server);
    for origin in [None, Some("https://b.example"), Some("https://a.example")] {
        let field = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
        let reply = get_with_fields(&mut client, "/list/x", &field);
        assert_eq!(reply.header("vary"), Some("Origin"), "{origin:?}");
        assert_eq!(
            reply.header("access-control-allow-origin"),
            origin.filter(|origin| *origin == "https://a.example"),
            "{origin:?}"
        );
    }
    for origin in [None, Some("https://b.example")] {
        let field = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
        let reply = get_with_fields(&mut client, "/any/x", &field);
        assert_eq!(
            reply.header("access-control-allow-origin"),
            Some("*"),
            "{origin:?}"
        );
        assert_eq!(reply.header("vary"), None, "{origin:?}");
    }
    let opaque = get_with_fields(&mut client, "/any/x", "Origin: null\r\n");
    assert_eq!(
        opaque.header("access-control-allow-origin"),
        None,
        "an origin that is not serialized is never shared"
    );
    assert_eq!(
        opaque.header("vary"),
        Some("Origin"),
        "the refusal depended on Origin"
    );
    support::stop(&server);
}

#[cfg(all(feature = "policy", feature = "testing"))]
#[test]
fn the_cors_rule_replaces_the_sharing_fields_a_host_wrote_so_the_reply_carries_one_of_each_fetch_4_10(
) {
    use zero_host::testing::respond;
    use zero_host::{bind_thread, complete, App, Method, PolicyKind, RouteKind};
    let mut app = App::new();
    app.route(RouteKind::Host, Some(Method::Get), "/items", b"")
        .unwrap();
    app.policy(
        PolicyKind::Cors,
        "/",
        br#"{"origins":["https://a.example"],"credentials":true,"expose":["X-Total"]}"#,
    )
    .unwrap();
    let server = support::start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = support::TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    let mut client = support::Client::connect(&server);
    client.send(b"GET /items HTTP/1.1\r\nHost: t\r\nOrigin: https://a.example\r\n\r\n");
    let batch = target.take();
    let id = support::ids(batch)[0];
    respond(id, |exchange| {
        let mut response = exchange.response();
        response
            .header(b"Access-Control-Allow-Origin", b"https://a.example")
            .unwrap();
        response
            .header(b"Access-Control-Allow-Credentials", b"true")
            .unwrap();
        response
            .header(b"Access-Control-Expose-Headers", b"X-Total")
            .unwrap();
        response.body(b"items");
        exchange.seal();
    })
    .unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!((reply.status, reply.text().as_str()), (200, "items"));
    assert_eq!(lines(&reply, "access-control-allow-origin"), 1);
    assert_eq!(
        reply.header("access-control-allow-origin"),
        Some("https://a.example")
    );
    assert_eq!(lines(&reply, "access-control-allow-credentials"), 1);
    assert_eq!(lines(&reply, "access-control-expose-headers"), 1);
    support::stop(&server);
}

#[cfg(feature = "policy")]
#[test]
fn a_preflight_answered_in_rust_carries_the_security_header_fields_and_the_request_id() {
    use zero_host::{App, Method, PolicyKind, RouteKind};
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Get),
        "/items",
        br#"{"body":"items"}"#,
    )
    .unwrap();
    app.policy(
        PolicyKind::Cors,
        "/",
        br#"{"origins":["https://a.example"],"methods":["GET","PUT"]}"#,
    )
    .unwrap();
    app.policy(
        PolicyKind::SecurityHeaders,
        "/",
        br#"{"fields":[["X-Frame-Options","DENY"]]}"#,
    )
    .unwrap();
    app.policy(PolicyKind::RequestId, "/", b"").unwrap();
    let server = support::start(&app, r#"{"threads":1}"#);
    let mut client = support::Client::connect(&server);
    for (origin, status) in [("https://a.example", 204), ("https://b.example", 403)] {
        let reply = client.get_with(&format!(
            "OPTIONS /items HTTP/1.1\r\nHost: t\r\nOrigin: {origin}\r\n\
             Access-Control-Request-Method: PUT\r\n\r\n"
        ));
        assert_eq!(reply.status, status, "{origin}");
        assert_eq!(reply.header("x-frame-options"), Some("DENY"), "{origin}");
        assert_eq!(
            reply.header("x-request-id").map(str::len),
            Some(36),
            "{origin}"
        );
    }
    support::stop(&server);
}

#[cfg(feature = "policy")]
#[test]
fn the_policy_with_the_longest_covering_prefix_wins_so_a_mounted_applications_rule_applies_under_it(
) {
    use zero_host::{App, Method, PolicyKind, RouteKind};
    for parent_first in [true, false] {
        let mut child = App::new();
        child
            .route(
                RouteKind::Fixed,
                Some(Method::Get),
                "/x",
                br#"{"body":"x"}"#,
            )
            .unwrap();
        child
            .policy(PolicyKind::Cors, "/", br#"{"origins":"*"}"#)
            .unwrap();
        child
            .policy(PolicyKind::RequestId, "/", br#"{"header":"X-Trace-Id"}"#)
            .unwrap();
        let mut app = App::new();
        app.route(
            RouteKind::Fixed,
            Some(Method::Get),
            "/other",
            br#"{"body":"other"}"#,
        )
        .unwrap();
        let parent = |app: &mut App| {
            app.policy(
                PolicyKind::Cors,
                "/",
                br#"{"origins":["https://a.example"]}"#,
            )
            .unwrap();
            app.policy(PolicyKind::RequestId, "/", b"").unwrap();
        };
        if parent_first {
            parent(&mut app);
            app.mount("/public", child).unwrap();
        } else {
            app.mount("/public", child).unwrap();
            parent(&mut app);
        }
        let server = support::start(&app, r#"{"threads":1}"#);
        let mut client = support::Client::connect(&server);
        let preflight = |client: &mut support::Client, path: &str| {
            client.get_with(&format!(
                "OPTIONS {path} HTTP/1.1\r\nHost: t\r\nOrigin: https://b.example\r\n\
                 Access-Control-Request-Method: GET\r\n\r\n"
            ))
        };
        let inside = preflight(&mut client, "/public/x");
        assert_eq!(inside.status, 204, "parent first: {parent_first}");
        assert_eq!(inside.header("access-control-allow-origin"), Some("*"));
        let shared = get_with_fields(&mut client, "/public/x", "Origin: https://b.example\r\n");
        assert_eq!(shared.header("access-control-allow-origin"), Some("*"));
        assert!(shared.header("x-trace-id").is_some(), "{shared:?}");
        assert_eq!(shared.header("x-request-id"), None);
        assert_eq!(preflight(&mut client, "/other").status, 403);
        let other = get_with_fields(&mut client, "/other", "Origin: https://b.example\r\n");
        assert_eq!(other.header("access-control-allow-origin"), None);
        assert!(other.header("x-request-id").is_some(), "{other:?}");
        assert_eq!(other.header("x-trace-id"), None);
        support::stop(&server);
    }
}

#[cfg(feature = "policy")]
#[test]
fn a_413_the_driver_writes_before_any_handler_runs_carries_no_policy_fields() {
    use zero_host::{App, Method, PolicyKind, RouteKind};
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Post),
        "/upload",
        br#"{"status":201}"#,
    )
    .unwrap();
    app.policy(PolicyKind::BodyLimit, "/", br#"{"max":4}"#)
        .unwrap();
    app.policy(PolicyKind::Cors, "/", br#"{"origins":"*"}"#)
        .unwrap();
    app.policy(
        PolicyKind::SecurityHeaders,
        "/",
        br#"{"fields":[["X-Frame-Options","DENY"]]}"#,
    )
    .unwrap();
    let server = support::start(&app, r#"{"threads":1}"#);
    let mut client = support::Client::connect(&server);
    let small = client.get_with(
        "POST /upload HTTP/1.1\r\nHost: t\r\nOrigin: https://a.example\r\n\
         Content-Length: 4\r\n\r\nabcd",
    );
    assert_eq!(small.status, 201);
    assert_eq!(small.header("access-control-allow-origin"), Some("*"));
    assert_eq!(small.header("x-frame-options"), Some("DENY"));
    let large = client.get_with(
        "POST /upload HTTP/1.1\r\nHost: t\r\nOrigin: https://a.example\r\n\
         Content-Length: 5\r\n\r\nabcde",
    );
    assert_eq!(large.status, 413);
    assert_eq!(large.header("access-control-allow-origin"), None);
    assert_eq!(large.header("x-frame-options"), None);
    support::stop(&server);
}

/// A directory holding `hello.txt`, named for the test that serves it.
#[cfg(feature = "static")]
fn static_root(test: &str) -> (std::path::PathBuf, String) {
    let root = std::env::temp_dir().join(format!("zero-host-http-{test}-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("hello.txt"), b"hello").unwrap();
    let escaped = root.display().to_string().replace('\\', "\\\\");
    (root, escaped)
}

#[cfg(feature = "static")]
#[test]
fn a_static_route_without_fallthrough_answers_other_methods_405_with_allow_in_the_error_shape_9110_15_5_6(
) {
    use zero_host::{App, RouteKind};
    let (root, path) = static_root("strict");
    let mut app = App::new();
    app.route(
        RouteKind::Static,
        None,
        "/strict/*path",
        format!(r#"{{"root":"{path}","fallthrough":false}}"#).as_bytes(),
    )
    .unwrap();
    let server = support::start(&app, r#"{"threads":1}"#);
    let mut client = support::Client::connect(&server);
    for target in ["/strict/hello.txt", "/strict/absent.txt"] {
        let refused = client.get_with(&format!(
            "POST {target} HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n"
        ));
        assert_eq!(refused.status, 405, "{target}");
        assert_eq!(refused.header("allow"), Some("GET, HEAD"), "{target}");
        assert_eq!(
            refused.header("content-type"),
            Some("application/problem+json"),
            "{target}"
        );
        assert!(
            refused.text().contains("method_not_allowed"),
            "{}",
            refused.text()
        );
    }
    assert_eq!(client.get("/strict/hello.txt").text(), "hello");
    support::stop(&server);
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(feature = "static")]
#[test]
fn a_static_route_with_fallthrough_hands_what_it_does_not_serve_to_the_miss_route_as_a_404() {
    use zero_host::{bind_thread, complete, App, RouteKind};
    let (root, path) = static_root("fallthrough");
    let mut app = App::new();
    app.route(
        RouteKind::Static,
        None,
        "/files/*path",
        format!(r#"{{"root":"{path}"}}"#).as_bytes(),
    )
    .unwrap();
    let miss = app.miss();
    let server = support::start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = support::TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    let mut client = support::Client::connect(&server);

    assert_eq!(client.get("/files/hello.txt").text(), "hello");
    for request in [
        "GET /files/absent.txt",
        "POST /files/hello.txt",
        "DELETE /files/absent.txt",
    ] {
        client
            .send(format!("{request} HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n").as_bytes());
        let batch = target.take();
        assert_eq!(support::routes(batch), [miss], "{request}");
        let id = support::ids(batch)[0];
        #[cfg(feature = "testing")]
        {
            let seen = zero_host::testing::inspect(id, |exchange| {
                (
                    exchange
                        .miss()
                        .map(|miss| (miss.status.as_u16(), miss.allow_mask())),
                    exchange.request().params().count(),
                    exchange.request().route_path().to_vec(),
                )
            })
            .unwrap();
            assert_eq!(
                (seen.0, seen.1),
                (Some((404, 0)), 0),
                "{request}: the miss route sees the 404 the static route would have answered"
            );
            assert!(seen.2.starts_with(b"/files/"), "{request}");
        }
        complete(worker, &[id], batch.epoch, None).unwrap();
        assert_eq!(client.read().unwrap().status, 500, "{request}");
    }
    support::stop(&server);
    let _ = std::fs::remove_dir_all(&root);
}
