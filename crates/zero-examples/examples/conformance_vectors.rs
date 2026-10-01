//! Generates `conformance/vectors.json`: the cases every binding asserts.
//!
//! Each section holds cases built with library calls and the outcome the
//! specification requires; before writing the file, the generator checks
//! that the Rust implementation produces that outcome, so a vector can never
//! disagree with the crate that generated it. Keys are written sorted and
//! bytes as hex, so the committed file is stable and CI can diff it.

use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};
use zero_http1::{parse_request, BodyLength, Field, ResponseWriter, Status, WriteError};
use zero_http_types::Method;
use zero_limits::http1::Http1Limits;
use zero_router::{Resolution, Router};

/// One request-head case: the bytes, and either the head that results or
/// the rejection.
struct HeadCase {
    name: &'static str,
    section: &'static str,
    request: Vec<u8>,
    expect: Value,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn request(lines: &[&str]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for line in lines {
        bytes.extend_from_slice(line.as_bytes());
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"\r\n");
    bytes
}

fn reject(status: u16) -> Value {
    json!({ "reject": { "status": status, "close": true } })
}

fn accept(
    method: &str,
    target: &str,
    version: &str,
    fields: &[(&str, &str)],
    body: Value,
    keep_alive: bool,
) -> Value {
    json!({
        "head": {
            "method": method,
            "target": target,
            "version": version,
            "fields": fields.iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(),
            "body": body,
            "keepAlive": keep_alive,
        }
    })
}

fn head_cases() -> Vec<HeadCase> {
    vec![
        HeadCase {
            name: "origin form with host",
            section: "RFC 9112 Section 3.2.1",
            request: request(&["GET /where?q=now HTTP/1.1", "Host: www.example.org"]),
            expect: accept(
                "GET",
                "/where?q=now",
                "HTTP/1.1",
                &[("Host", "www.example.org")],
                json!("none"),
                true,
            ),
        },
        HeadCase {
            name: "content length body",
            section: "RFC 9112 Section 6.3",
            request: request(&["POST /submit HTTP/1.1", "Host: a", "Content-Length: 5"]),
            expect: accept(
                "POST",
                "/submit",
                "HTTP/1.1",
                &[("Host", "a"), ("Content-Length", "5")],
                json!({ "length": 5 }),
                true,
            ),
        },
        HeadCase {
            name: "chunked body",
            section: "RFC 9112 Section 6.3",
            request: request(&[
                "POST /submit HTTP/1.1",
                "Host: a",
                "Transfer-Encoding: chunked",
            ]),
            expect: accept(
                "POST",
                "/submit",
                "HTTP/1.1",
                &[("Host", "a"), ("Transfer-Encoding", "chunked")],
                json!("chunked"),
                true,
            ),
        },
        HeadCase {
            name: "connection close",
            section: "RFC 9112 Section 9.6",
            request: request(&["GET / HTTP/1.1", "Host: a", "Connection: close"]),
            expect: accept(
                "GET",
                "/",
                "HTTP/1.1",
                &[("Host", "a"), ("Connection", "close")],
                json!("none"),
                false,
            ),
        },
        HeadCase {
            name: "http 1.0 without host closes",
            section: "RFC 9112 Section 9.3",
            request: request(&["GET / HTTP/1.0"]),
            expect: accept("GET", "/", "HTTP/1.0", &[], json!("none"), false),
        },
        HeadCase {
            name: "empty lines before the request line",
            section: "RFC 9112 Section 2.2",
            request: {
                let mut bytes = b"\r\n\r\n".to_vec();
                bytes.extend_from_slice(&request(&["GET / HTTP/1.1", "Host: a"]));
                bytes
            },
            expect: accept(
                "GET",
                "/",
                "HTTP/1.1",
                &[("Host", "a")],
                json!("none"),
                true,
            ),
        },
        HeadCase {
            name: "transfer encoding and content length",
            section: "RFC 9112 Section 6.1",
            request: request(&[
                "POST / HTTP/1.1",
                "Host: a",
                "Transfer-Encoding: chunked",
                "Content-Length: 3",
            ]),
            expect: reject(400),
        },
        HeadCase {
            name: "transfer encoding not ending in chunked",
            section: "RFC 9112 Section 6.3",
            request: request(&[
                "POST / HTTP/1.1",
                "Host: a",
                "Transfer-Encoding: chunked, gzip",
            ]),
            expect: reject(400),
        },
        HeadCase {
            name: "transfer coding not implemented",
            section: "RFC 9112 Section 6.1",
            request: request(&[
                "POST / HTTP/1.1",
                "Host: a",
                "Transfer-Encoding: gzip, chunked",
            ]),
            expect: reject(501),
        },
        HeadCase {
            name: "transfer encoding on http 1.0",
            section: "RFC 9112 Section 6.1",
            request: request(&["POST / HTTP/1.0", "Transfer-Encoding: chunked"]),
            expect: reject(400),
        },
        HeadCase {
            name: "invalid content length",
            section: "RFC 9112 Section 6.3",
            request: request(&["POST / HTTP/1.1", "Host: a", "Content-Length: 3a"]),
            expect: reject(400),
        },
        HeadCase {
            name: "content length list",
            section: "RFC 9110 Section 8.6",
            request: request(&["POST / HTTP/1.1", "Host: a", "Content-Length: 3, 3"]),
            expect: reject(400),
        },
        HeadCase {
            name: "repeated content length",
            section: "RFC 9110 Section 8.6",
            request: request(&[
                "POST / HTTP/1.1",
                "Host: a",
                "Content-Length: 3",
                "Content-Length: 3",
            ]),
            expect: reject(400),
        },
        HeadCase {
            name: "content length overflow",
            section: "RFC 9110 Section 8.6",
            request: request(&[
                "POST / HTTP/1.1",
                "Host: a",
                "Content-Length: 18446744073709551616",
            ]),
            expect: reject(400),
        },
        HeadCase {
            name: "whitespace before colon",
            section: "RFC 9112 Section 5.1",
            request: request(&["GET / HTTP/1.1", "Host : a"]),
            expect: reject(400),
        },
        HeadCase {
            name: "missing host",
            section: "RFC 9112 Section 3.2",
            request: request(&["GET / HTTP/1.1"]),
            expect: reject(400),
        },
        HeadCase {
            name: "two hosts",
            section: "RFC 9112 Section 3.2",
            request: request(&["GET / HTTP/1.1", "Host: a", "Host: a"]),
            expect: reject(400),
        },
        HeadCase {
            name: "invalid host",
            section: "RFC 9112 Section 3.2",
            request: request(&["GET / HTTP/1.1", "Host: a b"]),
            expect: reject(400),
        },
        HeadCase {
            name: "obsolete line folding",
            section: "RFC 9112 Section 5.2",
            request: request(&["GET / HTTP/1.1", "Host: a", "X-Long: one", " two"]),
            expect: reject(400),
        },
        HeadCase {
            name: "whitespace before the first field",
            section: "RFC 9112 Section 2.2",
            request: request(&["GET / HTTP/1.1", " Host: a"]),
            expect: reject(400),
        },
        HeadCase {
            name: "bare line feed",
            section: "RFC 9112 Section 2.2",
            request: b"GET / HTTP/1.1\nHost: a\r\n\r\n".to_vec(),
            expect: reject(400),
        },
        HeadCase {
            name: "bare carriage return",
            section: "RFC 9112 Section 2.2",
            request: b"GET / HTTP/1.1\r\nHost: a\rX: y\r\n\r\n".to_vec(),
            expect: reject(400),
        },
        HeadCase {
            name: "control character in field value",
            section: "RFC 9110 Section 5.5",
            request: b"GET / HTTP/1.1\r\nHost: a\r\nX: y\x00z\r\n\r\n".to_vec(),
            expect: reject(400),
        },
        HeadCase {
            name: "double space in request line",
            section: "RFC 9112 Section 3",
            request: request(&["GET  / HTTP/1.1", "Host: a"]),
            expect: reject(400),
        },
        HeadCase {
            name: "unsupported major version",
            section: "RFC 9110 Section 2.5",
            request: request(&["GET / HTTP/2.0", "Host: a"]),
            expect: reject(505),
        },
        HeadCase {
            name: "over long method",
            section: "RFC 9112 Section 3",
            request: request(&["ABCDEFGHIJ / HTTP/1.1", "Host: a"]),
            expect: reject(501),
        },
        HeadCase {
            name: "over long request target",
            section: "RFC 9112 Section 3",
            request: {
                let mut line = String::from("GET /");
                line.push_str(&"a".repeat(8_300));
                line.push_str(" HTTP/1.1");
                request(&[&line, "Host: a"])
            },
            expect: reject(414),
        },
        HeadCase {
            name: "asterisk form needs options",
            section: "RFC 9112 Section 3.2.4",
            request: request(&["GET * HTTP/1.1", "Host: a"]),
            expect: reject(400),
        },
        HeadCase {
            name: "connect needs authority form",
            section: "RFC 9112 Section 3.2.3",
            request: request(&["CONNECT / HTTP/1.1", "Host: a"]),
            expect: reject(400),
        },
        HeadCase {
            name: "absolute form with empty host",
            section: "RFC 9110 Section 4.2.1",
            request: request(&["GET http:/// HTTP/1.1", "Host: a"]),
            expect: reject(400),
        },
    ]
}

/// Runs the parser over a case and returns the outcome in the vector's shape.
fn parser_outcome(case: &HeadCase) -> Value {
    let mut table = [Field::EMPTY; 64];
    match parse_request(&case.request, &mut table, &Http1Limits::DEFAULT) {
        Status::Complete(head) => {
            let input = &case.request;
            let fields: Vec<Value> = table
                .iter()
                .take(head.field_count)
                .map(|field| json!([text(field.name(input)), text(field.value(input))]))
                .collect();
            let body = match head.body {
                BodyLength::None => json!("none"),
                BodyLength::Chunked => json!("chunked"),
                BodyLength::Length(length) => json!({ "length": length }),
            };
            json!({
                "head": {
                    "method": text(head.method_token.of(input)),
                    "target": text(head.target.of(input)),
                    "version": match head.version {
                        zero_http1::Version::Http10 => "HTTP/1.0",
                        zero_http1::Version::Http11 => "HTTP/1.1",
                    },
                    "fields": fields,
                    "body": body,
                    "keepAlive": head.keep_alive,
                }
            })
        }
        Status::Partial => json!("partial"),
        Status::Reject(reject) => {
            json!({ "reject": { "status": reject.status.as_u16(), "close": reject.close } })
        }
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The response-splitting cases: field values and names host code might
/// pass, and whether the serializer accepts them.
fn splitting_cases() -> Vec<(&'static str, &'static str, Vec<u8>, bool)> {
    vec![
        ("plain value", "Location", b"/next?x=1".to_vec(), true),
        ("value with tab", "X-Trace", b"a\tb".to_vec(), true),
        (
            "value with obs-text",
            "X-Name",
            "caf\u{e9}".as_bytes().to_vec(),
            true,
        ),
        (
            "crlf injection",
            "Location",
            b"/next\r\nSet-Cookie: a=b".to_vec(),
            false,
        ),
        ("lone line feed", "Location", b"/next\nX: y".to_vec(), false),
        (
            "lone carriage return",
            "Location",
            b"/next\rX: y".to_vec(),
            false,
        ),
        ("nul byte", "Location", b"/next\x00".to_vec(), false),
        ("delete byte", "Location", b"/next\x7f".to_vec(), false),
        ("leading space", "Location", b" /next".to_vec(), false),
        ("trailing tab", "Location", b"/next\t".to_vec(), false),
    ]
}

fn serializer_accepts(name: &str, value: &[u8]) -> bool {
    let mut out = [0u8; 512];
    let mut writer = ResponseWriter::new(&mut out, false);
    writer
        .status_line(zero_http_types::StatusCode::OK)
        .expect("the buffer holds a status line");
    match writer.field(name.as_bytes(), value) {
        Ok(()) => true,
        Err(WriteError::InvalidValue | WriteError::InvalidName) => false,
        Err(other) => panic!("unexpected serializer error {other}"),
    }
}

/// The route table every binding builds for the `router` section: method,
/// pattern and the integer descriptor the match returns; mounts are child tables
/// under a prefix.
fn router_table() -> (Value, Router<u32>) {
    let routes: Vec<(&str, &str, u32)> = vec![
        ("GET", "/", 1),
        ("GET", "/users", 2),
        ("POST", "/users", 3),
        ("GET", "/users/me", 4),
        ("GET", "/users/:id", 5),
        ("DELETE", "/users/:id", 6),
        ("GET", "/users/:id/posts/:post", 7),
        ("GET", "/files/:name", 8),
        ("GET", "/static/*path", 9),
        ("GET", "/*", 10),
    ];
    let admin: Vec<(&str, &str, u32)> = vec![
        ("GET", "/", 20),
        ("GET", "/list", 21),
        ("PUT", "/settings/:key", 22),
    ];
    let mut router = Router::new();
    for (method, pattern, id) in &routes {
        router
            .route(
                Method::parse(method.as_bytes()).expect("a known method"),
                pattern,
                *id,
            )
            .expect("a valid route");
    }
    let mut child = Router::new();
    for (method, pattern, id) in &admin {
        child
            .route(
                Method::parse(method.as_bytes()).expect("a known method"),
                pattern,
                *id,
            )
            .expect("a valid route");
    }
    router.mount("/admin", child).expect("a valid mount");
    let describe = |rows: &[(&str, &str, u32)]| -> Vec<Value> {
        rows.iter()
            .map(|(method, pattern, id)| json!({ "method": method, "pattern": pattern, "id": id }))
            .collect()
    };
    let table = json!({
        "routes": describe(&routes),
        "mounts": [{ "prefix": "/admin", "routes": describe(&admin) }],
        "trailingSlash": "ignore",
    });
    (table, router)
}

/// What the router answers for a method token and a request target.
fn router_outcome(router: &Router<u32>, method: &str, target: &str) -> Value {
    let mut scratch = Vec::new();
    let Ok(resolved) = router.resolve_target(method.as_bytes(), target.as_bytes(), &mut scratch)
    else {
        return json!({ "status": 400 });
    };
    let allow_value = |allow: zero_router::Allow| {
        let mut value = Vec::new();
        allow.write(&mut value);
        String::from_utf8(value).expect("method names are ASCII")
    };
    match resolved.resolution {
        Resolution::Matched {
            descriptor,
            params,
            head,
        } => json!({
            "matched": {
                "id": descriptor,
                "head": head,
                "path": String::from_utf8_lossy(resolved.path),
                "query": resolved.query.map(String::from_utf8_lossy),
                "params": params
                    .iter()
                    .map(|(name, range)| json!([
                        String::from_utf8_lossy(name),
                        String::from_utf8_lossy(&resolved.path[range]),
                    ]))
                    .collect::<Vec<_>>(),
            }
        }),
        Resolution::NotFound => json!({ "status": 404 }),
        Resolution::MethodNotAllowed { allow } => {
            json!({ "status": 405, "allow": allow_value(allow) })
        }
        Resolution::Options { allow } => json!({ "status": 200, "allow": allow_value(allow) }),
        Resolution::NotImplemented => json!({ "status": 501 }),
    }
}

/// The `router` cases: a name, the method token, the target, and the outcome the
/// router must produce over [`router_table`].
fn router_cases() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("root", "GET", "/"),
        ("static segment", "GET", "/users"),
        ("static over parameter", "GET", "/users/me"),
        ("parameter", "GET", "/users/42"),
        ("two parameters", "GET", "/users/42/posts/7"),
        ("parameter with query", "GET", "/users/42?x=1&y=/users/me"),
        ("other method on parameter route", "DELETE", "/users/42"),
        ("catch-all", "GET", "/static/css/site.css"),
        ("catch-all empty", "GET", "/static/"),
        ("root catch-all", "GET", "/anything/else"),
        ("trailing slash ignored", "GET", "/users/"),
        ("empty segment is no parameter", "GET", "/users//x"),
        ("head served by get", "HEAD", "/users"),
        ("options automatic", "OPTIONS", "/users"),
        ("method not allowed", "PUT", "/users"),
        ("method not allowed on parameter route", "PUT", "/users/42"),
        ("unimplemented token", "PATCH", "/users"),
        ("lowercase token", "get", "/users"),
        ("mount root", "GET", "/admin"),
        ("mount root with slash", "GET", "/admin/"),
        ("mount route", "GET", "/admin/list"),
        ("mount parameter", "PUT", "/admin/settings/theme"),
        ("mount owns its prefix", "GET", "/admin/unknown"),
        ("mount keeps the query", "GET", "/admin/list?page=2"),
        ("not a mount", "GET", "/administrator"),
        ("encoded slash is data", "GET", "/files/a%2Fb"),
        ("encoded slash lowercase", "GET", "/files/a%2fb"),
        ("real slash is a separator", "GET", "/files/a/b"),
        ("unreserved decoded", "GET", "/%75sers/m%65"),
        ("unreserved parameter decoded", "GET", "/users/%34%32"),
        ("dot segments removed", "GET", "/public/../admin/list"),
        (
            "encoded dot segments removed",
            "GET",
            "/admin/%2e%2E/users/me",
        ),
        ("leading dot-dot", "GET", "/../users"),
        ("query never matches", "GET", "/users?/users/me"),
        ("bad percent", "GET", "/users/%zz"),
        ("space in path", "GET", "/a b"),
        ("asterisk is not a path", "OPTIONS", "*"),
    ]
}

fn main() {
    let mut http1_parser = Vec::new();
    for case in head_cases() {
        let outcome = parser_outcome(&case);
        assert_eq!(
            outcome, case.expect,
            "parser disagrees with the vector {}",
            case.name
        );
        http1_parser.push(json!({
            "name": case.name,
            "section": case.section,
            "request": hex(&case.request),
            "expect": case.expect,
        }));
    }

    let mut response_splitting = Vec::new();
    for (name, field, value, accepted) in splitting_cases() {
        assert_eq!(
            serializer_accepts(field, &value),
            accepted,
            "serializer disagrees with the vector {name}"
        );
        response_splitting.push(json!({
            "name": name,
            "field": field,
            "value": hex(&value),
            "accepted": accepted,
        }));
    }

    let (router_table_value, router) = router_table();
    let mut router_cases_value = Vec::new();
    for (name, method, target) in router_cases() {
        router_cases_value.push(json!({
            "name": name,
            "method": method,
            "target": target,
            "expect": router_outcome(&router, method, target),
        }));
    }

    let mut document = Map::new();
    document.insert(
        "note".into(),
        json!("Generated by `cargo run -p zero-examples --example conformance_vectors`. Do not edit by hand."),
    );
    document.insert("tolerance".into(), json!(1e-6));
    document.insert("http1Parser".into(), json!({ "cases": http1_parser }));
    document.insert(
        "responseSplitting".into(),
        json!({ "cases": response_splitting }),
    );
    document.insert(
        "router".into(),
        json!({ "table": router_table_value, "cases": router_cases_value }),
    );

    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/vectors.json");
    let mut text =
        serde_json::to_string_pretty(&Value::Object(document)).expect("the document serializes");
    text.push('\n');
    fs::write(&path, text).expect("the vectors file is writable");
    println!("wrote {}", path.display());
}
