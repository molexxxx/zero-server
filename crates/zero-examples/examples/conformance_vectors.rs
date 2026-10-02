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
use zero_h3::datagram::MAX_QUARTER_STREAM_ID;
use zero_h3::decoder::SETTINGS_PAYLOAD_LIMIT;
use zero_h3::{
    encode_capsule, encode_data_header, encode_datagram_capsule, encode_reserved, reserved, varint,
    CapsuleDecoder, CapsuleStep, Datagram, Disposition, ErrorCode, Frame, FrameDecoder,
    FrameHeader, FrameLimits, FrameType, GoawaySender, PeerControl, Reserved, Role, Scope,
    Settings, Step, StreamKind, StreamType, UniStreams,
};
use zero_http1::{parse_request, BodyLength, Field, ResponseWriter, Status, WriteError};
use zero_http_types::Method;
use zero_limits::http1::Http1Limits;
use zero_limits::transport::QPACK_INTEGER_CAP;
use zero_limits::Http3Limits;
use zero_qpack::encoder::SENSITIVE_NAMES;
use zero_qpack::huffman::{self, HuffmanError};
use zero_qpack::integer::{self, IntegerError, PrefixBits, MAX_VALUE};
use zero_qpack::prefix::{self, Prefix};
use zero_qpack::table::{self, Match, STATIC_TABLE};
use zero_qpack::{
    Decoder, DecoderInstruction, DecoderStreamReceiver, Encoder, EncoderHead, EncoderInstruction,
    EncoderStreamReceiver, FieldLine, HuffmanPolicy, Representation, StringLiteral,
};
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

/// A 62-bit protocol value as a decimal string: JavaScript numbers lose
/// integers above 2^53-1, and RFC 9000 Appendix A.1 publishes one.
fn dec(value: u64) -> Value {
    json!(value.to_string())
}

/// The octets of a published hexadecimal vector, used only to compare library
/// output with the specification's own bytes.
fn unhex(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    digits
        .chunks(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("a hex vector is ASCII");
            u8::from_str_radix(pair, 16).expect("a hex vector holds hex digits")
        })
        .collect()
}

/// Text the vectors write as a JSON string.
fn utf8(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).expect("vector text is UTF-8")
}

/// RFC 7541 Appendix C.1.1: 10 encoded with a 5-bit prefix.
const RFC7541_C_1_1: &str = "0a";
/// RFC 7541 Appendix C.1.2: 1337 encoded with a 5-bit prefix.
const RFC7541_C_1_2: &str = "1f9a0a";
/// RFC 7541 Appendix C.1.3: 42 encoded starting at an octet boundary.
const RFC7541_C_1_3: &str = "2a";

/// The Huffman-coded string literals of RFC 7541 Appendices C.4 and C.6: the
/// section, the text and the encoded octets the RFC prints.
const RFC7541_HUFFMAN: [(&str, &str, &str); 12] = [
    (
        "RFC 7541 Appendix C.4.1",
        "www.example.com",
        "f1e3c2e5f23a6ba0ab90f4ff",
    ),
    ("RFC 7541 Appendix C.4.2", "no-cache", "a8eb10649cbf"),
    ("RFC 7541 Appendix C.4.3", "custom-key", "25a849e95ba97d7f"),
    ("RFC 7541 Appendix C.4.3", "custom-value", "25a849e95bb8e8b4bf"),
    ("RFC 7541 Appendix C.6.1", "302", "6402"),
    ("RFC 7541 Appendix C.6.1", "private", "aec3771a4b"),
    (
        "RFC 7541 Appendix C.6.1",
        "Mon, 21 Oct 2013 20:13:21 GMT",
        "d07abe941054d444a8200595040b8166e082a62d1bff",
    ),
    (
        "RFC 7541 Appendix C.6.1",
        "https://www.example.com",
        "9d29ad171863c78f0b97c8e9ae82ae43d3",
    ),
    ("RFC 7541 Appendix C.6.2", "307", "640eff"),
    (
        "RFC 7541 Appendix C.6.3",
        "Mon, 21 Oct 2013 20:13:22 GMT",
        "d07abe941054d444a8200595040b8166e084a62d1bff",
    ),
    ("RFC 7541 Appendix C.6.3", "gzip", "9bd9ab"),
    (
        "RFC 7541 Appendix C.6.3",
        "foo=ASDJKHQKBZXOQWEOPIUAXQWEOIU; max-age=3600; version=1",
        "94e7821dd7f2e6c7b335dfdfcd5b3960d5af27087f3672c1ab270fb5291f9587316065c003ed4ee5b1063d5007",
    ),
];

/// RFC 9204 Appendix B.1, stream 0: a literal with a static name reference.
const RFC9204_B_1: &str = "0000510b2f696e6465782e68746d6c";
/// RFC 9204 Appendix B.2, the encoder stream.
const RFC9204_B_2_ENCODER: &str =
    "3fbd01c00f7777772e6578616d706c652e636f6dc10c2f73616d706c652f70617468";
/// RFC 9204 Appendix B.2, stream 4.
const RFC9204_B_2_STREAM_4: &str = "03811011";
/// RFC 9204 Appendix B.2, the decoder stream.
const RFC9204_B_2_DECODER: &str = "84";
/// RFC 9204 Appendix B.3, the encoder stream.
const RFC9204_B_3_ENCODER: &str = "4a637573746f6d2d6b65790c637573746f6d2d76616c7565";
/// RFC 9204 Appendix B.3, the decoder stream.
const RFC9204_B_3_DECODER: &str = "01";
/// RFC 9204 Appendix B.4, the encoder stream.
const RFC9204_B_4_ENCODER: &str = "02";
/// RFC 9204 Appendix B.4, stream 8.
const RFC9204_B_4_STREAM_8: &str = "050080c181";
/// RFC 9204 Appendix B.4, the decoder stream.
const RFC9204_B_4_DECODER: &str = "48";
/// RFC 9204 Appendix B.5, the encoder stream.
const RFC9204_B_5_ENCODER: &str = "810d637573746f6d2d76616c756532";

/// A QPACK error in the vector shape.
fn qpack_error(error: &zero_qpack::Error) -> Value {
    json!({
        "error": {
            "code": error.code(),
            "name": error.code_name(),
            "connection": error.is_connection_error(),
            "kind": error.fault.name(),
        }
    })
}

/// A field line in the vector shape.
fn field_line_value(line: &FieldLine<'_>) -> Value {
    json!({
        "name": utf8(&line.name),
        "value": utf8(&line.value),
        "neverIndexed": line.never_indexed,
    })
}

/// The decoded text of a string literal.
fn literal_text(literal: &StringLiteral<'_>) -> String {
    let decoded = literal.decode().expect("a vector's string literal decodes");
    utf8(&decoded).to_owned()
}

/// A raw string literal.
const fn raw(data: &[u8]) -> StringLiteral<'_> {
    StringLiteral {
        huffman: false,
        data,
    }
}

/// A field line representation in the vector shape, strings as decoded text.
fn representation_value(representation: &Representation<'_>) -> Value {
    match *representation {
        Representation::Indexed {
            static_table,
            index,
        } => json!({ "indexed": { "static": static_table, "index": dec(index) } }),
        Representation::IndexedPostBase { index } => json!({ "indexedPostBase": dec(index) }),
        Representation::LiteralNameReference {
            never_indexed,
            static_table,
            index,
            value,
        } => json!({
            "literalNameReference": {
                "neverIndexed": never_indexed,
                "static": static_table,
                "index": dec(index),
                "huffman": value.huffman,
                "value": literal_text(&value),
            }
        }),
        Representation::LiteralPostBaseNameReference {
            never_indexed,
            index,
            value,
        } => json!({
            "literalPostBaseNameReference": {
                "neverIndexed": never_indexed,
                "index": dec(index),
                "huffman": value.huffman,
                "value": literal_text(&value),
            }
        }),
        Representation::LiteralName {
            never_indexed,
            name,
            value,
        } => json!({
            "literalName": {
                "neverIndexed": never_indexed,
                "nameHuffman": name.huffman,
                "name": literal_text(&name),
                "valueHuffman": value.huffman,
                "value": literal_text(&value),
            }
        }),
    }
}

/// The representations of a complete field section, after its prefix.
fn representations_of(section: &[u8]) -> Vec<Value> {
    let (_, used) = Prefix::parse(section).expect("a vector's prefix parses");
    let mut rest = &section[used..];
    let mut list = Vec::new();
    while !rest.is_empty() {
        let (representation, used) =
            Representation::parse(rest).expect("a vector's representation parses");
        list.push(representation_value(&representation));
        rest = &rest[used..];
    }
    list
}

/// A field section built from a prefix and representations.
fn section_of(prefix: Prefix, representations: &[Representation<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    prefix.encode(&mut out).expect("a prefix within 2^62-1");
    for representation in representations {
        representation
            .encode(&mut out)
            .expect("a representation within 2^62-1");
    }
    out
}

/// A field section the static-only encoder writes.
fn encode_section(policy: HuffmanPolicy, lines: &[FieldLine<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    Encoder::new(policy)
        .encode(lines, &mut out)
        .expect("names and values within 2^62-1");
    out
}

/// Decodes a field section with the decoder of the default limits.
fn decode_section(section: &[u8]) -> Result<Vec<FieldLine<'_>>, zero_qpack::Error> {
    let decoder = Decoder::new(&Http3Limits::DEFAULT).expect("the default limits build a decoder");
    decoder.decode(section)?.collect()
}

/// An integer encoding with one added to its first continuation octet: the
/// encoding of 2^62-1 becomes one of 2^62.
fn one_past_max(prefix: PrefixBits, flags: u8) -> Vec<u8> {
    let mut out = Vec::new();
    integer::push(MAX_VALUE, prefix, flags, &mut out).expect("2^62-1 encodes");
    assert_ne!(out[1] & 0x7f, 0x7f, "the increment must not carry");
    out[1] += 1;
    out
}

fn qpack_static_table() -> Value {
    assert_eq!(STATIC_TABLE.len(), 99, "RFC 9204 Appendix A has 99 entries");
    let mut entries = Vec::new();
    for (index, entry) in (0u8..).zip(STATIC_TABLE.iter()) {
        assert_eq!(table::get(u64::from(index)), Some(*entry));
        assert_eq!(
            table::find(entry.name, entry.value),
            Some(Match::Full(index)),
            "entry {index} is found by name and value"
        );
        entries.push(json!([utf8(entry.name), utf8(entry.value)]));
    }
    assert_eq!(table::get(99), None, "index 99 is invalid");
    json!({ "section": "RFC 9204 Appendix A", "entries": entries })
}

/// A prefixed integer: the name, the section, the prefix size, the flag bits
/// above the prefix, the value and the published octets if any.
type IntegerCase = (
    &'static str,
    &'static str,
    PrefixBits,
    u8,
    u64,
    Option<&'static str>,
);

fn qpack_integers() -> Value {
    let cases: [IntegerCase; 5] = [
        (
            "10 with a 5-bit prefix",
            "RFC 7541 Appendix C.1.1",
            PrefixBits::P5,
            0,
            10,
            Some(RFC7541_C_1_1),
        ),
        (
            "10 with a 5-bit prefix and flag bits set",
            "RFC 7541 Appendix C.1.1",
            PrefixBits::P5,
            0xe0,
            10,
            None,
        ),
        (
            "1337 with a 5-bit prefix",
            "RFC 7541 Appendix C.1.2",
            PrefixBits::P5,
            0,
            1337,
            Some(RFC7541_C_1_2),
        ),
        (
            "42 with an 8-bit prefix",
            "RFC 7541 Appendix C.1.3",
            PrefixBits::P8,
            0,
            42,
            Some(RFC7541_C_1_3),
        ),
        (
            "2^62-1 with a 3-bit prefix",
            "RFC 9204 Section 4.1.1",
            PrefixBits::P3,
            0,
            MAX_VALUE,
            None,
        ),
    ];
    let mut list = Vec::new();
    for (name, section, prefix, flags, value, published) in cases {
        let mut encoded = Vec::new();
        integer::push(value, prefix, flags, &mut encoded).expect("a value within 2^62-1");
        if let Some(published) = published {
            assert_eq!(encoded, unhex(published), "{name}");
        }
        assert_eq!(
            integer::decode(&encoded, prefix, MAX_VALUE),
            Ok(Some((value, encoded.len()))),
            "{name}"
        );
        list.push(json!({
            "name": name,
            "section": section,
            "prefixBits": prefix.bits(),
            "encoded": hex(&encoded),
            "value": dec(value),
        }));
    }
    json!({ "cases": list })
}

/// A refused integer: the name, the section, the prefix size, the cap, the
/// octets and the error.
type IntegerErrorCase = (
    &'static str,
    &'static str,
    PrefixBits,
    u64,
    Vec<u8>,
    IntegerError,
);

fn qpack_integer_errors() -> Value {
    let mut ten_continuations = Vec::new();
    integer::push(31, PrefixBits::P5, 0, &mut ten_continuations).expect("31 encodes");
    let last = ten_continuations
        .pop()
        .expect("31 has a continuation octet");
    ten_continuations.extend_from_slice(&[0x80; 9]);
    ten_continuations.push(last);
    let mut above_cap = Vec::new();
    integer::push(QPACK_INTEGER_CAP + 1, PrefixBits::P7, 0, &mut above_cap)
        .expect("2^30+1 encodes");
    let cases: [IntegerErrorCase; 3] = [
        (
            "ten continuation octets",
            "RFC 7541 Section 5.1",
            PrefixBits::P5,
            MAX_VALUE,
            ten_continuations,
            IntegerError::TooLong,
        ),
        (
            "2^62 with a 5-bit prefix",
            "RFC 7541 Section 5.1",
            PrefixBits::P5,
            MAX_VALUE,
            one_past_max(PrefixBits::P5, 0),
            IntegerError::TooLarge,
        ),
        (
            "a length above QPACK_INTEGER_CAP",
            "RFC 9204 Section 7.4",
            PrefixBits::P7,
            QPACK_INTEGER_CAP,
            above_cap,
            IntegerError::TooLarge,
        ),
    ];
    let mut list = Vec::new();
    for (name, section, prefix, cap, encoded, error) in cases {
        assert_eq!(integer::decode(&encoded, prefix, cap), Err(error), "{name}");
        list.push(json!({
            "name": name,
            "section": section,
            "prefixBits": prefix.bits(),
            "cap": dec(cap),
            "encoded": hex(&encoded),
            "error": error.name(),
        }));
    }
    json!({ "cases": list })
}

fn qpack_huffman() -> Value {
    let mut list = Vec::new();
    for (section, text, published) in RFC7541_HUFFMAN {
        let mut encoded = Vec::new();
        huffman::encode(text.as_bytes(), &mut encoded);
        assert_eq!(encoded, unhex(published), "{section} {text}");
        assert_eq!(
            huffman::encoded_len(text.as_bytes()),
            u64::try_from(encoded.len()).expect("a short vector")
        );
        let mut decoded = Vec::new();
        huffman::decode_to_vec(&encoded, &mut decoded).expect("an RFC vector decodes");
        assert_eq!(decoded, text.as_bytes(), "{section} {text}");
        list.push(json!({
            "name": text,
            "section": section,
            "text": text,
            "encoded": hex(&encoded),
        }));
    }
    json!({ "cases": list })
}

fn qpack_huffman_errors() -> Value {
    let (eos_code, eos_len) = huffman::CODES[usize::from(huffman::EOS)];
    let pad = 32 - u32::from(eos_len);
    let eos = ((eos_code << pad) | ((1 << pad) - 1))
        .to_be_bytes()
        .to_vec();
    let mut long_padding = Vec::new();
    huffman::encode(b"&", &mut long_padding);
    long_padding.push(0xff);
    let mut not_eos = Vec::new();
    huffman::encode(b"a", &mut not_eos);
    let last = not_eos.len() - 1;
    not_eos[last] &= 0xfe;
    let cases = [
        ("EOS in the data", eos, HuffmanError::Eos),
        ("eight bits of padding", long_padding, HuffmanError::Padding),
        (
            "padding that is not an EOS prefix",
            not_eos,
            HuffmanError::PaddingNotEos,
        ),
    ];
    let mut list = Vec::new();
    for (name, encoded, error) in cases {
        let mut decoded = Vec::new();
        assert_eq!(
            huffman::decode_to_vec(&encoded, &mut decoded),
            Err(error),
            "{name}"
        );
        list.push(json!({
            "name": name,
            "section": "RFC 7541 Section 5.2",
            "encoded": hex(&encoded),
            "error": error.name(),
        }));
    }
    json!({ "cases": list })
}

/// What decoding a field section must produce: the lines, or the fault name
/// and whether it closes the connection.
type SectionExpect = Result<Vec<(&'static str, &'static str, bool)>, (&'static str, bool)>;

/// One encoded field section and what the static-only decoder makes of it.
struct FieldSectionCase {
    name: &'static str,
    section: &'static str,
    encoded: Vec<u8>,
    published: Option<&'static str>,
    list_representations: bool,
    expect: SectionExpect,
}

fn qpack_field_section_cases() -> Vec<FieldSectionCase> {
    let case = |name, section, encoded, expect| FieldSectionCase {
        name,
        section,
        encoded,
        published: None,
        list_representations: false,
        expect,
    };
    let static_prefix =
        |representations: &[Representation<'_>]| section_of(Prefix::STATIC, representations);
    let mut past_end = static_prefix(&[]);
    integer::push(1, PrefixBits::P4, 0x50, &mut past_end).expect("index 1 encodes");
    integer::push(1 << 31, PrefixBits::P7, 0, &mut past_end).expect("2^31 encodes");
    past_end.push(b'x');
    let mut beyond = static_prefix(&[]);
    beyond.extend_from_slice(&one_past_max(PrefixBits::P6, 0xc0));
    let mut bad_huffman = static_prefix(&[]);
    let mut not_eos = Vec::new();
    huffman::encode(b"a", &mut not_eos);
    not_eos[0] &= 0xfe;
    Representation::LiteralNameReference {
        never_indexed: false,
        static_table: true,
        index: 0,
        value: StringLiteral {
            huffman: true,
            data: &not_eos,
        },
    }
    .encode(&mut bad_huffman)
    .expect("a short literal encodes");
    let mut truncated = encode_section(
        HuffmanPolicy::Never,
        &[FieldLine::new(b":path", b"/index.html")],
    );
    truncated.truncate(6);
    vec![
        FieldSectionCase {
            published: Some(RFC9204_B_1),
            ..case(
                "Appendix B.1 literal with a static name reference",
                "RFC 9204 Appendix B.1",
                encode_section(
                    HuffmanPolicy::Never,
                    &[FieldLine::new(b":path", b"/index.html")],
                ),
                Ok(vec![(":path", "/index.html", false)]),
            )
        },
        FieldSectionCase {
            published: Some(RFC9204_B_2_STREAM_4),
            list_representations: true,
            ..case(
                "Appendix B.2 stream 4",
                "RFC 9204 Appendix B.2",
                section_of(
                    Prefix {
                        encoded_insert_count: 3,
                        sign: true,
                        delta_base: 1,
                    },
                    &[
                        Representation::IndexedPostBase { index: 0 },
                        Representation::IndexedPostBase { index: 1 },
                    ],
                ),
                Err(("requiredInsertCount", true)),
            )
        },
        FieldSectionCase {
            published: Some(RFC9204_B_4_STREAM_8),
            list_representations: true,
            ..case(
                "Appendix B.4 stream 8",
                "RFC 9204 Appendix B.4",
                section_of(
                    Prefix {
                        encoded_insert_count: 5,
                        sign: false,
                        delta_base: 0,
                    },
                    &[
                        Representation::Indexed {
                            static_table: false,
                            index: 0,
                        },
                        Representation::Indexed {
                            static_table: true,
                            index: 1,
                        },
                        Representation::Indexed {
                            static_table: false,
                            index: 1,
                        },
                    ],
                ),
                Err(("requiredInsertCount", true)),
            )
        },
        case(
            "dynamic indexed line with Required Insert Count 0",
            "RFC 9204 Section 2.2.3",
            static_prefix(&[Representation::Indexed {
                static_table: false,
                index: 0,
            }]),
            Err(("dynamicReference", true)),
        ),
        case(
            "post-Base indexed line",
            "RFC 9204 Section 2.2.3",
            static_prefix(&[Representation::IndexedPostBase { index: 0 }]),
            Err(("dynamicReference", true)),
        ),
        case(
            "dynamic name reference",
            "RFC 9204 Section 2.2.3",
            static_prefix(&[Representation::LiteralNameReference {
                never_indexed: false,
                static_table: false,
                index: 0,
                value: raw(b"a"),
            }]),
            Err(("dynamicReference", true)),
        ),
        case(
            "post-Base name reference",
            "RFC 9204 Section 2.2.3",
            static_prefix(&[Representation::LiteralPostBaseNameReference {
                never_indexed: false,
                index: 0,
                value: raw(b"a"),
            }]),
            Err(("dynamicReference", true)),
        ),
        case(
            "static index 99",
            "RFC 9204 Section 3.1",
            static_prefix(&[Representation::Indexed {
                static_table: true,
                index: 99,
            }]),
            Err(("invalidStaticIndex", true)),
        ),
        case(
            "static index 2^31",
            "RFC 9204 Section 3.1",
            static_prefix(&[Representation::Indexed {
                static_table: true,
                index: 1 << 31,
            }]),
            Err(("invalidStaticIndex", true)),
        ),
        case(
            "literal with static name index 99",
            "RFC 9204 Section 3.1",
            static_prefix(&[Representation::LiteralNameReference {
                never_indexed: false,
                static_table: true,
                index: 99,
                value: raw(b""),
            }]),
            Err(("invalidStaticIndex", true)),
        ),
        case(
            "Required Insert Count 2^31 at capacity zero",
            "RFC 9204 Section 4.5.1.1",
            section_of(
                Prefix {
                    encoded_insert_count: 1 << 31,
                    sign: false,
                    delta_base: 0,
                },
                &[],
            ),
            Err(("requiredInsertCount", true)),
        ),
        case(
            "Delta Base 2^31 with Sign 0",
            "RFC 9204 Section 4.5.1.2",
            section_of(
                Prefix {
                    encoded_insert_count: 0,
                    sign: false,
                    delta_base: 1 << 31,
                },
                &[],
            ),
            Ok(vec![]),
        ),
        case(
            "string length 2^31 past the section end",
            "RFC 9204 Section 7.4",
            past_end,
            Err(("truncated", true)),
        ),
        case(
            "an index beyond 62 bits",
            "RFC 9204 Section 7.4",
            beyond,
            Err(("tooLarge", false)),
        ),
        case(
            "Sign 1 with Required Insert Count 0",
            "RFC 9204 Section 4.5.1.2",
            section_of(
                Prefix {
                    encoded_insert_count: 0,
                    sign: true,
                    delta_base: 0,
                },
                &[],
            ),
            Err(("negativeBase", true)),
        ),
        case(
            "empty section",
            "RFC 9204 Section 4.5",
            static_prefix(&[]),
            Ok(vec![]),
        ),
        case(
            "Huffman value www.example.com",
            "RFC 9204 Section 4.1.2",
            encode_section(
                HuffmanPolicy::Shorter,
                &[FieldLine::new(b":authority", b"www.example.com")],
            ),
            Ok(vec![(":authority", "www.example.com", false)]),
        ),
        case(
            "Huffman padding that is not an EOS prefix",
            "RFC 7541 Section 5.2",
            bad_huffman,
            Err(("paddingNotEos", true)),
        ),
        case(
            "never-indexed authorization",
            "RFC 9204 Section 4.5.4",
            encode_section(
                HuffmanPolicy::Never,
                &[FieldLine::sensitive(b"authorization", b"Bearer abc")],
            ),
            Ok(vec![("authorization", "Bearer abc", true)]),
        ),
        case(
            "truncated value",
            "RFC 9204 Section 4.5.4",
            truncated,
            Err(("truncated", true)),
        ),
    ]
}

fn qpack_field_sections() -> Value {
    let mut list = Vec::new();
    for case in qpack_field_section_cases() {
        if let Some(published) = case.published {
            assert_eq!(case.encoded, unhex(published), "{}", case.name);
        }
        let expect = match decode_section(&case.encoded) {
            Ok(lines) => {
                let got: Vec<(&str, &str, bool)> = lines
                    .iter()
                    .map(|line| (utf8(&line.name), utf8(&line.value), line.never_indexed))
                    .collect();
                assert_eq!(case.expect.as_ref().ok(), Some(&got), "{}", case.name);
                json!({ "lines": lines.iter().map(field_line_value).collect::<Vec<_>>() })
            }
            Err(error) => {
                let got = (error.fault.name(), error.is_connection_error());
                assert_eq!(case.expect.as_ref().err(), Some(&got), "{}", case.name);
                qpack_error(&error)
            }
        };
        list.push(json!({
            "name": case.name,
            "section": case.section,
            "encoded": hex(&case.encoded),
            "representations": case
                .list_representations
                .then(|| representations_of(&case.encoded)),
            "expect": expect,
        }));
    }
    json!({ "cases": list })
}

/// A static name reference in the vector shape of a representation.
fn name_reference(never_indexed: bool, index: u64, huffman: bool, value: &str) -> Value {
    json!({
        "literalNameReference": {
            "neverIndexed": never_indexed,
            "static": true,
            "index": dec(index),
            "huffman": huffman,
            "value": value,
        }
    })
}

/// A static indexed line in the vector shape of a representation.
fn static_indexed(index: u64) -> Value {
    json!({ "indexed": { "static": true, "index": dec(index) } })
}

/// One field section the static-only encoder writes: the policy, the lines,
/// the representations it must choose and the published octets if any.
type EncodingCase = (
    &'static str,
    &'static str,
    HuffmanPolicy,
    Vec<FieldLine<'static>>,
    Value,
    Option<&'static str>,
);

fn qpack_encodings() -> Value {
    let cases: [EncodingCase; 6] = [
        (
            "Appendix B.1 without Huffman",
            "RFC 9204 Appendix B.1",
            HuffmanPolicy::Never,
            vec![FieldLine::new(b":path", b"/index.html")],
            json!([name_reference(false, 1, false, "/index.html")]),
            Some(RFC9204_B_1),
        ),
        (
            "exact static matches",
            "RFC 9204 Section 4.5.2",
            HuffmanPolicy::Shorter,
            vec![
                FieldLine::new(b":method", b"GET"),
                FieldLine::new(b":scheme", b"https"),
                FieldLine::new(b":path", b"/"),
            ],
            json!([static_indexed(17), static_indexed(23), static_indexed(1)]),
            None,
        ),
        (
            "never-indexed exact static match",
            "RFC 9204 Section 4.5.4",
            HuffmanPolicy::Never,
            vec![FieldLine::sensitive(b"authorization", b"")],
            json!([name_reference(true, 84, false, "")]),
            None,
        ),
        (
            "sensitive names get the N bit",
            "RFC 9204 Section 7.1.3",
            HuffmanPolicy::Never,
            vec![
                FieldLine::new(b"cookie", b""),
                FieldLine::new(b"set-cookie", b"a=b"),
            ],
            json!([
                name_reference(true, 5, false, ""),
                name_reference(true, 14, false, "a=b"),
            ]),
            None,
        ),
        (
            "literal name",
            "RFC 9204 Section 4.5.6",
            HuffmanPolicy::Never,
            vec![FieldLine::new(b"x-custom", b"value")],
            json!([{
                "literalName": {
                    "neverIndexed": false,
                    "nameHuffman": false,
                    "name": "x-custom",
                    "valueHuffman": false,
                    "value": "value",
                }
            }]),
            None,
        ),
        (
            "Huffman always",
            "RFC 9204 Section 4.1.2",
            HuffmanPolicy::Always,
            vec![FieldLine::new(b":path", b"/index.html")],
            json!([name_reference(false, 1, true, "/index.html")]),
            None,
        ),
    ];
    let mut list = Vec::new();
    for (name, section, policy, lines, representations, published) in cases {
        let encoded = encode_section(policy, &lines);
        if let Some(published) = published {
            assert_eq!(encoded, unhex(published), "{name}");
        }
        assert_eq!(
            json!(representations_of(&encoded)),
            representations,
            "{name}"
        );
        let expected: Vec<FieldLine<'_>> = lines
            .iter()
            .map(|line| FieldLine {
                never_indexed: line.never_indexed || SENSITIVE_NAMES.contains(&&*line.name),
                ..line.clone()
            })
            .collect();
        assert_eq!(decode_section(&encoded), Ok(expected), "{name}");
        list.push(json!({
            "name": name,
            "section": section,
            "huffman": match policy {
                HuffmanPolicy::Never => "never",
                HuffmanPolicy::Shorter => "shorter",
                HuffmanPolicy::Always => "always",
            },
            "lines": lines.iter().map(field_line_value).collect::<Vec<_>>(),
            "encoded": hex(&encoded),
            "representations": representations,
        }));
    }
    json!({ "cases": list })
}

/// An encoder instruction in the vector shape, strings as decoded text.
fn encoder_instruction_value(instruction: &EncoderInstruction<'_>) -> Value {
    match *instruction {
        EncoderInstruction::SetDynamicTableCapacity { capacity } => {
            json!({ "setDynamicTableCapacity": dec(capacity) })
        }
        EncoderInstruction::InsertWithNameReference {
            static_table,
            index,
            value,
        } => json!({
            "insertWithNameReference": {
                "static": static_table,
                "index": dec(index),
                "huffman": value.huffman,
                "value": literal_text(&value),
            }
        }),
        EncoderInstruction::InsertWithLiteralName { name, value } => json!({
            "insertWithLiteralName": {
                "nameHuffman": name.huffman,
                "name": literal_text(&name),
                "valueHuffman": value.huffman,
                "value": literal_text(&value),
            }
        }),
        EncoderInstruction::Duplicate { index } => json!({ "duplicate": dec(index) }),
    }
}

/// An encoder instruction head in the vector shape.
fn encoder_head_value(head: &EncoderHead) -> Value {
    match *head {
        EncoderHead::SetDynamicTableCapacity { capacity } => {
            json!({ "setDynamicTableCapacity": dec(capacity) })
        }
        EncoderHead::InsertWithNameReference {
            static_table,
            index,
        } => json!({ "insertWithNameReference": { "static": static_table, "index": dec(index) } }),
        EncoderHead::InsertWithLiteralName { huffman, name_len } => {
            json!({ "insertWithLiteralName": { "huffman": huffman, "nameLength": dec(name_len) } })
        }
        EncoderHead::Duplicate { index } => json!({ "duplicate": dec(index) }),
    }
}

/// One encoder stream input and the verdict of a decoder at capacity zero.
struct EncoderStreamCase {
    name: &'static str,
    section: &'static str,
    published: Option<&'static str>,
    encoded: Vec<u8>,
    instructions: Option<Vec<EncoderInstruction<'static>>>,
    verdict: &'static str,
}

impl EncoderStreamCase {
    fn of(
        name: &'static str,
        section: &'static str,
        instructions: Vec<EncoderInstruction<'static>>,
        verdict: &'static str,
    ) -> Self {
        let mut encoded = Vec::new();
        for instruction in &instructions {
            instruction
                .encode(&mut encoded)
                .expect("an instruction within 2^62-1");
        }
        Self {
            name,
            section,
            published: None,
            encoded,
            instructions: Some(instructions),
            verdict,
        }
    }

    fn published(self, published: &'static str) -> Self {
        Self {
            published: Some(published),
            ..self
        }
    }
}

/// The complete encoder instructions of `input`, or `None` when it ends inside
/// one.
fn encoder_instructions(input: &[u8]) -> Option<Vec<EncoderInstruction<'_>>> {
    let mut rest = input;
    let mut list = Vec::new();
    while !rest.is_empty() {
        let (instruction, used) = EncoderInstruction::parse(rest, QPACK_INTEGER_CAP)
            .expect("no integer fault in a vector")?;
        list.push(instruction);
        rest = &rest[used..];
    }
    Some(list)
}

/// The verdict of a decoder at capacity zero, which must arrive with the
/// octet that completes the first instruction head whether the input is fed
/// whole or one octet at a time.
fn encoder_stream_verdict(input: &[u8]) -> zero_qpack::Error {
    let verdict = EncoderStreamReceiver::new(QPACK_INTEGER_CAP)
        .feed(input)
        .expect_err("capacity zero refuses every encoder instruction");
    let (_, head_len) = EncoderHead::parse(input, QPACK_INTEGER_CAP)
        .expect("a vector head parses")
        .expect("a vector holds a whole head");
    for end in 1..=input.len() {
        let mut receiver = EncoderStreamReceiver::new(QPACK_INTEGER_CAP);
        let expected = if end < head_len { Ok(0) } else { Err(verdict) };
        assert_eq!(receiver.feed(&input[..end]), expected, "after {end} octets");
    }
    verdict
}

fn qpack_encoder_stream() -> Value {
    let mut head_only = Vec::new();
    integer::push(1 << 30, PrefixBits::P5, 0x40, &mut head_only).expect("2^30 encodes");
    let cases = [
        EncoderStreamCase::of(
            "Appendix B.2",
            "RFC 9204 Appendix B.2",
            vec![
                EncoderInstruction::SetDynamicTableCapacity { capacity: 220 },
                EncoderInstruction::InsertWithNameReference {
                    static_table: true,
                    index: 0,
                    value: raw(b"www.example.com"),
                },
                EncoderInstruction::InsertWithNameReference {
                    static_table: true,
                    index: 1,
                    value: raw(b"/sample/path"),
                },
            ],
            "capacityExceeded",
        )
        .published(RFC9204_B_2_ENCODER),
        EncoderStreamCase::of(
            "Appendix B.3",
            "RFC 9204 Appendix B.3",
            vec![EncoderInstruction::InsertWithLiteralName {
                name: raw(b"custom-key"),
                value: raw(b"custom-value"),
            }],
            "entryTooLarge",
        )
        .published(RFC9204_B_3_ENCODER),
        EncoderStreamCase::of(
            "Appendix B.4",
            "RFC 9204 Appendix B.4",
            vec![EncoderInstruction::Duplicate { index: 2 }],
            "instructionAtCapacityZero",
        )
        .published(RFC9204_B_4_ENCODER),
        EncoderStreamCase::of(
            "Appendix B.5",
            "RFC 9204 Appendix B.5",
            vec![EncoderInstruction::InsertWithNameReference {
                static_table: false,
                index: 1,
                value: raw(b"custom-value2"),
            }],
            "entryTooLarge",
        )
        .published(RFC9204_B_5_ENCODER),
        EncoderStreamCase::of(
            "capacity zero",
            "RFC 9204 Section 3.2.3",
            vec![EncoderInstruction::SetDynamicTableCapacity { capacity: 0 }],
            "instructionAtCapacityZero",
        ),
        EncoderStreamCase::of(
            "capacity 2^62-1",
            "RFC 9204 Section 4.1.1",
            vec![EncoderInstruction::SetDynamicTableCapacity {
                capacity: MAX_VALUE,
            }],
            "capacityExceeded",
        ),
        EncoderStreamCase::of(
            "static index 99 on the encoder stream",
            "RFC 9204 Section 3.1",
            vec![EncoderInstruction::InsertWithNameReference {
                static_table: true,
                index: 99,
                value: raw(b""),
            }],
            "invalidStaticIndex",
        ),
        EncoderStreamCase {
            name: "insert refused at its head",
            section: "RFC 9204 Section 2.1.3",
            published: None,
            encoded: head_only,
            instructions: None,
            verdict: "entryTooLarge",
        },
    ];
    let mut list = Vec::new();
    for case in cases {
        if let Some(published) = case.published {
            assert_eq!(case.encoded, unhex(published), "{}", case.name);
        }
        let parsed = encoder_instructions(&case.encoded);
        assert_eq!(parsed, case.instructions, "{}", case.name);
        let verdict = encoder_stream_verdict(&case.encoded);
        assert_eq!(verdict.fault.name(), case.verdict, "{}", case.name);
        let head_only = if case.instructions.is_none() {
            let (head, _) = EncoderHead::parse(&case.encoded, QPACK_INTEGER_CAP)
                .expect("a vector head parses")
                .expect("a vector holds a whole head");
            encoder_head_value(&head)
        } else {
            Value::Null
        };
        list.push(json!({
            "name": case.name,
            "section": case.section,
            "encoded": hex(&case.encoded),
            "instructions": parsed.map(|list| list.iter().map(encoder_instruction_value).collect::<Vec<_>>()),
            "headOnly": head_only,
            "atCapacityZero": qpack_error(&verdict),
        }));
    }
    json!({ "cases": list })
}

/// A decoder instruction in the vector shape.
fn decoder_instruction_value(instruction: &DecoderInstruction) -> Value {
    match *instruction {
        DecoderInstruction::SectionAcknowledgment { stream_id } => {
            json!({ "sectionAcknowledgment": dec(stream_id) })
        }
        DecoderInstruction::StreamCancellation { stream_id } => {
            json!({ "streamCancellation": dec(stream_id) })
        }
        DecoderInstruction::InsertCountIncrement { increment } => {
            json!({ "insertCountIncrement": dec(increment) })
        }
    }
}

/// The verdict of an encoder that never references the dynamic table, the
/// same whether the input is fed whole or one octet at a time.
fn decoder_stream_verdict(input: &[u8]) -> Result<(), zero_qpack::Error> {
    let whole = DecoderStreamReceiver.feed(input).map(|consumed| {
        assert_eq!(consumed, input.len(), "every instruction is consumed");
    });
    let mut receiver = DecoderStreamReceiver;
    let mut pending = Vec::new();
    let mut bytewise = Ok(());
    for &octet in input {
        pending.push(octet);
        match receiver.feed(&pending) {
            Ok(consumed) => {
                pending.drain(..consumed);
            }
            Err(error) => {
                bytewise = Err(error);
                break;
            }
        }
    }
    if bytewise.is_ok() {
        assert!(pending.is_empty(), "every instruction is consumed");
    }
    assert_eq!(whole, bytewise, "whole and one-octet feeding agree");
    whole
}

/// A decoder stream input: the name, the section, the published octets if
/// any, the octets when no instruction builds them, the instruction and the
/// verdict of an encoder that never references the dynamic table.
type DecoderStreamCase = (
    &'static str,
    &'static str,
    Option<&'static str>,
    Vec<u8>,
    Option<DecoderInstruction>,
    &'static str,
);

fn qpack_decoder_stream() -> Value {
    let cases: [DecoderStreamCase; 7] = [
        (
            "Appendix B.2",
            "RFC 9204 Appendix B.2",
            Some(RFC9204_B_2_DECODER),
            Vec::new(),
            Some(DecoderInstruction::SectionAcknowledgment { stream_id: 4 }),
            "unexpectedAcknowledgment",
        ),
        (
            "Appendix B.3",
            "RFC 9204 Appendix B.3",
            Some(RFC9204_B_3_DECODER),
            Vec::new(),
            Some(DecoderInstruction::InsertCountIncrement { increment: 1 }),
            "invalidIncrement",
        ),
        (
            "Appendix B.4",
            "RFC 9204 Appendix B.4",
            Some(RFC9204_B_4_DECODER),
            Vec::new(),
            Some(DecoderInstruction::StreamCancellation { stream_id: 8 }),
            "accepted",
        ),
        (
            "increment zero",
            "RFC 9204 Section 4.4.3",
            None,
            Vec::new(),
            Some(DecoderInstruction::InsertCountIncrement { increment: 0 }),
            "invalidIncrement",
        ),
        (
            "stream ID 2^62-1",
            "RFC 9204 Section 4.1.1",
            None,
            Vec::new(),
            Some(DecoderInstruction::StreamCancellation {
                stream_id: MAX_VALUE,
            }),
            "accepted",
        ),
        (
            "increment 2^62-1",
            "RFC 9204 Section 4.1.1",
            None,
            Vec::new(),
            Some(DecoderInstruction::InsertCountIncrement {
                increment: MAX_VALUE,
            }),
            "invalidIncrement",
        ),
        (
            "stream ID beyond 62 bits",
            "RFC 9204 Section 7.4",
            None,
            one_past_max(PrefixBits::P7, 0x80),
            None,
            "tooLarge",
        ),
    ];
    let mut list = Vec::new();
    for (name, section, published, bytes, instruction, verdict) in cases {
        let encoded = match instruction {
            Some(instruction) => {
                let mut out = Vec::new();
                instruction
                    .encode(&mut out)
                    .expect("an instruction within 2^62-1");
                assert_eq!(
                    DecoderInstruction::parse(&out),
                    Ok(Some((instruction, out.len()))),
                    "{name}"
                );
                out
            }
            None => bytes,
        };
        if let Some(published) = published {
            assert_eq!(encoded, unhex(published), "{name}");
        }
        let outcome = decoder_stream_verdict(&encoded);
        let at_static_encoder = match outcome {
            Ok(()) => {
                assert_eq!(verdict, "accepted", "{name}");
                json!("accepted")
            }
            Err(error) => {
                assert_eq!(error.fault.name(), verdict, "{name}");
                qpack_error(&error)
            }
        };
        list.push(json!({
            "name": name,
            "section": section,
            "encoded": hex(&encoded),
            "instructions": instruction.map(|instruction| vec![decoder_instruction_value(&instruction)]),
            "atStaticEncoder": at_static_encoder,
        }));
    }
    json!({ "cases": list })
}

/// A Required Insert Count reconstruction: the name, the section, the
/// EncodedInsertCount, MaxEntries, the total inserts and the result.
type InsertCountCase = (
    &'static str,
    &'static str,
    u64,
    u64,
    u64,
    Result<u64, &'static str>,
);

fn qpack_required_insert_count() -> Value {
    assert_eq!(prefix::max_entries(100), 3, "RFC 9204 Section 4.5.1.1");
    assert_eq!(prefix::max_entries(220), 6, "RFC 9204 Appendix B.2");
    assert_eq!(prefix::max_entries(0), 0);
    let cases: [InsertCountCase; 5] = [
        (
            "Section 4.5.1.1 example",
            "RFC 9204 Section 4.5.1.1",
            4,
            prefix::max_entries(100),
            10,
            Ok(9),
        ),
        (
            "Appendix B.2 stream 4",
            "RFC 9204 Appendix B.2",
            3,
            prefix::max_entries(220),
            2,
            Ok(2),
        ),
        (
            "Appendix B.4 stream 8",
            "RFC 9204 Appendix B.4",
            5,
            prefix::max_entries(220),
            3,
            Ok(4),
        ),
        (
            "capacity zero",
            "RFC 9204 Section 4.5.1.1",
            1,
            prefix::max_entries(0),
            0,
            Err("requiredInsertCount"),
        ),
        (
            "above FullRange",
            "RFC 9204 Section 4.5.1.1",
            13,
            prefix::max_entries(220),
            0,
            Err("requiredInsertCount"),
        ),
    ];
    let mut list = Vec::new();
    for (name, section, encoded, max_entries, total_inserts, expect) in cases {
        let got = prefix::required_insert_count(encoded, max_entries, total_inserts);
        assert_eq!(got.map_err(|fault| fault.name()), expect, "{name}");
        list.push(json!({
            "name": name,
            "section": section,
            "encodedInsertCount": dec(encoded),
            "maxEntries": dec(max_entries),
            "totalInserts": dec(total_inserts),
            "expect": match got {
                Ok(count) => dec(count),
                Err(fault) => json!({ "error": fault.name() }),
            },
        }));
    }
    json!({ "cases": list })
}

/// A Base computation: the name, the section, the Required Insert Count, the
/// Sign bit, the Delta Base and the result.
type BaseCase = (
    &'static str,
    &'static str,
    u64,
    bool,
    u64,
    Result<u64, &'static str>,
);

fn qpack_base() -> Value {
    let cases: [BaseCase; 5] = [
        (
            "Section 4.5.1.2 example",
            "RFC 9204 Section 4.5.1.2",
            9,
            true,
            2,
            Ok(6),
        ),
        (
            "Appendix B.2 stream 4",
            "RFC 9204 Appendix B.2",
            2,
            true,
            1,
            Ok(0),
        ),
        (
            "Appendix B.4 stream 8",
            "RFC 9204 Appendix B.4",
            4,
            false,
            0,
            Ok(4),
        ),
        (
            "Sign 1 at Required Insert Count 0",
            "RFC 9204 Section 4.5.1.2",
            0,
            true,
            0,
            Err("negativeBase"),
        ),
        (
            "Sign 1 with Delta Base equal to the count",
            "RFC 9204 Section 4.5.1.2",
            9,
            true,
            9,
            Err("negativeBase"),
        ),
    ];
    let mut list = Vec::new();
    for (name, section, required_insert_count, sign, delta_base, expect) in cases {
        let got = prefix::base(required_insert_count, sign, delta_base);
        assert_eq!(got.map_err(|fault| fault.name()), expect, "{name}");
        list.push(json!({
            "name": name,
            "section": section,
            "requiredInsertCount": dec(required_insert_count),
            "sign": sign,
            "deltaBase": dec(delta_base),
            "expect": match got {
                Ok(base) => dec(base),
                Err(fault) => json!({ "error": fault.name() }),
            },
        }));
    }
    json!({ "cases": list })
}

/// The `qpack` section: RFC 9204 with the RFC 7541 primitives it shares.
fn qpack() -> Value {
    json!({
        "staticTable": qpack_static_table(),
        "integers": qpack_integers(),
        "integerErrors": qpack_integer_errors(),
        "huffman": qpack_huffman(),
        "huffmanErrors": qpack_huffman_errors(),
        "fieldSections": qpack_field_sections(),
        "encodings": qpack_encodings(),
        "encoderStream": qpack_encoder_stream(),
        "decoderStream": qpack_decoder_stream(),
        "requiredInsertCount": qpack_required_insert_count(),
        "base": qpack_base(),
    })
}

/// RFC 9000 Appendix A.1: the sample encodings and the values they decode to.
const RFC9000_A_1: [(&str, &str, u64); 5] = [
    (
        "eight-octet example",
        "c2197c5eff14e88c",
        151_288_809_941_952_652,
    ),
    ("four-octet example", "9d7f3e7d", 494_878_333),
    ("two-octet example", "7bbd", 15_293),
    ("one-octet example", "25", 37),
    ("non-minimal 37", "4025", 37),
];

/// An HTTP/3 error in the vector shape.
fn h3_error(error: &zero_h3::Error) -> Value {
    json!({
        "error": {
            "code": error.code().0,
            "name": error.code().name(),
            "connection": error.scope() == Scope::Connection,
            "kind": error.name(),
        }
    })
}

/// Settings in the vector shape: all five keys, null when absent.
fn settings_value(settings: &Settings) -> Value {
    json!({
        "qpackMaxTableCapacity": settings.qpack_max_table_capacity.map(dec),
        "maxFieldSectionSize": settings.max_field_section_size.map(dec),
        "qpackBlockedStreams": settings.qpack_blocked_streams.map(dec),
        "enableConnectProtocol": settings.enable_connect_protocol,
        "h3Datagram": settings.h3_datagram,
    })
}

/// The shortest variable-length encoding of `value`.
fn varint_bytes(value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    varint::push(value, &mut out).expect("a value within 2^62-1");
    out
}

/// The variable-length encoding of `value` on exactly `len` octets.
fn varint_with_len(value: u64, len: usize) -> Vec<u8> {
    let mut out = [0u8; varint::MAX_LEN];
    let written = varint::encode_with_len(value, len, &mut out).expect("the value fits");
    out[..written].to_vec()
}

/// The octets of the parts, in order.
fn cat(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

/// A whole frame.
fn frame_bytes(frame: Frame<'_>) -> Vec<u8> {
    let mut out = Vec::new();
    frame.encode(&mut out).expect("a frame within 2^62-1");
    out
}

/// A frame header of any type.
fn frame_header(frame_type: u64, len: u64) -> Vec<u8> {
    let mut out = Vec::new();
    FrameHeader::encode(FrameType(frame_type), len, &mut out).expect("a header within 2^62-1");
    out
}

/// A DATA frame carrying `payload`.
fn data_frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    encode_data_header(
        u64::try_from(payload.len()).expect("a short payload"),
        &mut out,
    )
    .expect("a length within 2^62-1");
    out.extend_from_slice(payload);
    out
}

/// A reserved frame of type 0x1f * n + 0x21.
fn reserved_frame(n: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    encode_reserved(n, payload, &mut out).expect("n within the reserved range");
    out
}

/// A decoded frame, owned so the whole and one-octet feedings compare equal;
/// the pieces of one DATA frame are joined.
#[derive(Clone, Debug, PartialEq, Eq)]
enum FrameEvent {
    Headers(Vec<u8>),
    CancelPush(u64),
    Settings(Settings),
    PushPromise(u64, Vec<u8>),
    Goaway(u64),
    MaxPushId(u64),
    Data(Vec<u8>),
    Skipped(u64, u64),
    Oversized(u64, u64),
}

fn frame_event_value(event: &FrameEvent) -> Value {
    match event {
        FrameEvent::Headers(section) => json!({ "headers": hex(section) }),
        FrameEvent::CancelPush(push_id) => json!({ "cancelPush": dec(*push_id) }),
        FrameEvent::Settings(settings) => json!({ "settings": settings_value(settings) }),
        FrameEvent::PushPromise(push_id, section) => json!({
            "pushPromise": { "pushId": dec(*push_id), "fieldSection": hex(section) }
        }),
        FrameEvent::Goaway(id) => json!({ "goaway": dec(*id) }),
        FrameEvent::MaxPushId(push_id) => json!({ "maxPushId": dec(*push_id) }),
        FrameEvent::Data(data) => json!({ "data": hex(data) }),
        FrameEvent::Skipped(frame_type, len) => {
            json!({ "skipped": { "type": dec(*frame_type), "length": dec(*len) } })
        }
        FrameEvent::Oversized(frame_type, len) => {
            json!({ "oversized": { "type": dec(*frame_type), "length": dec(*len) } })
        }
    }
}

/// How a stream's input ended: cleanly, inside a frame or capsule with more
/// to come, or with an error.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Ending {
    Done,
    NeedMore,
    Failed(zero_h3::Error),
}

impl Ending {
    fn name(&self) -> &'static str {
        match self {
            Self::Done => "ok",
            Self::NeedMore => "needMore",
            Self::Failed(error) => error.name(),
        }
    }

    fn value(&self) -> Value {
        match self {
            Self::Done => json!("ok"),
            Self::NeedMore => json!("needMore"),
            Self::Failed(error) => h3_error(error),
        }
    }
}

/// A frame decoder driven over a buffer, checking the step sequence of every
/// streamed payload and, on a control stream, the GOAWAY, MAX_PUSH_ID and
/// CANCEL_PUSH rules.
struct FrameRun {
    decoder: FrameDecoder,
    control: Option<PeerControl>,
    tunnel_after_headers: bool,
    pending: Vec<u8>,
    events: Vec<FrameEvent>,
    open: Option<(bool, u64)>,
}

impl FrameRun {
    fn new(kind: StreamKind, role: Role, limits: FrameLimits, tunnel_after_headers: bool) -> Self {
        let control = if kind == StreamKind::Control {
            Some(PeerControl::new(role))
        } else {
            None
        };
        Self {
            decoder: FrameDecoder::new(kind, role, limits),
            control,
            tunnel_after_headers,
            pending: Vec::new(),
            events: Vec::new(),
            open: None,
        }
    }

    /// Accounts for one piece of a streamed payload.
    fn piece(&mut self, data: &[u8], end: bool, is_data: bool) {
        let (open_data, remaining) = self.open.expect("a piece inside a streamed payload");
        assert_eq!(open_data, is_data, "a piece of the open payload");
        let len = u64::try_from(data.len()).expect("a piece fits u64");
        assert!(len <= remaining, "a piece within the frame Length");
        let left = remaining - len;
        assert_eq!(end, left == 0, "end marks the last piece");
        self.open = (!end).then_some((open_data, left));
        if is_data {
            if let Some(FrameEvent::Data(buffer)) = self.events.last_mut() {
                buffer.extend_from_slice(data);
            }
        }
    }

    /// Applies one step and returns the octets it consumed and whether to
    /// continue.
    fn apply(
        &mut self,
        step: Step<'_>,
        header: Option<FrameHeader>,
    ) -> Result<(usize, bool), zero_h3::Error> {
        Ok(match step {
            Step::NeedMore { consumed } => (consumed, false),
            Step::Frame { frame, consumed } => {
                assert_eq!(self.open, None, "a whole frame between payloads");
                if let Some(control) = self.control.as_mut() {
                    control.receive(&frame)?;
                }
                let event = match frame {
                    Frame::Headers { field_section } => {
                        if self.tunnel_after_headers {
                            self.decoder.tunnel();
                        }
                        FrameEvent::Headers(field_section.to_vec())
                    }
                    Frame::CancelPush { push_id } => FrameEvent::CancelPush(push_id),
                    Frame::Settings(settings) => FrameEvent::Settings(settings),
                    Frame::PushPromise {
                        push_id,
                        field_section,
                    } => FrameEvent::PushPromise(push_id, field_section.to_vec()),
                    Frame::Goaway { id } => FrameEvent::Goaway(id),
                    Frame::MaxPushId { push_id } => FrameEvent::MaxPushId(push_id),
                };
                self.events.push(event);
                (consumed, true)
            }
            Step::Data {
                data,
                consumed,
                end,
            } => {
                if self.open.is_none() {
                    assert!(
                        data.is_empty() && !end && consumed > 0,
                        "the DATA header step"
                    );
                    let len = header.expect("a DATA frame header").len;
                    self.open = Some((true, len));
                    self.events.push(FrameEvent::Data(Vec::new()));
                } else {
                    self.piece(data, end, true);
                }
                (consumed, true)
            }
            Step::Skipped {
                frame_type,
                len,
                consumed,
            } => {
                assert_eq!(self.open, None, "a skipped frame between payloads");
                self.open = Some((false, len));
                self.events.push(FrameEvent::Skipped(frame_type.0, len));
                (consumed, true)
            }
            Step::Oversized {
                frame_type,
                len,
                consumed,
            } => {
                assert_eq!(self.open, None, "an oversized frame between payloads");
                self.open = Some((false, len));
                self.events.push(FrameEvent::Oversized(frame_type.0, len));
                (consumed, true)
            }
            Step::Discarded {
                data,
                consumed,
                end,
            } => {
                self.piece(data, end, false);
                (consumed, true)
            }
        })
    }

    /// Decodes until the decoder needs more octets.
    fn pump(&mut self) -> Result<(), zero_h3::Error> {
        loop {
            let mut input = std::mem::take(&mut self.pending);
            let header = FrameHeader::parse(&input);
            let step = self.decoder.decode(&input);
            let applied = match step {
                Ok(step) => self.apply(step, header),
                Err(error) => Err(error),
            };
            match applied {
                Ok((consumed, more)) => {
                    input.drain(..consumed);
                    self.pending = input;
                    if !more {
                        return Ok(());
                    }
                }
                Err(error) => {
                    self.pending = input;
                    return Err(error);
                }
            }
        }
    }

    /// How the input ended.
    fn end(&self, fin: bool) -> Ending {
        if fin {
            match self.decoder.finish(&self.pending) {
                Ok(()) => Ending::Done,
                Err(error) => Ending::Failed(error),
            }
        } else if self.pending.is_empty() && self.open.is_none() {
            Ending::Done
        } else {
            Ending::NeedMore
        }
    }
}

/// One stream's frames and what the decoder must make of them.
struct FrameCase {
    name: &'static str,
    section: &'static str,
    kind: StreamKind,
    role: Role,
    limits: FrameLimits,
    tunnel_after_headers: bool,
    encoded: Vec<u8>,
    fin: bool,
    events: Vec<FrameEvent>,
    outcome: &'static str,
}

impl FrameCase {
    fn new(
        name: &'static str,
        section: &'static str,
        kind: StreamKind,
        role: Role,
        encoded: Vec<u8>,
    ) -> Self {
        Self {
            name,
            section,
            kind,
            role,
            limits: FrameLimits::DEFAULT,
            tunnel_after_headers: false,
            encoded,
            fin: false,
            events: Vec::new(),
            outcome: "ok",
        }
    }

    fn fin(self) -> Self {
        Self { fin: true, ..self }
    }

    fn tunnel(self) -> Self {
        Self {
            tunnel_after_headers: true,
            ..self
        }
    }

    fn limits(self, limits: FrameLimits) -> Self {
        Self { limits, ..self }
    }

    fn yields(self, events: Vec<FrameEvent>, outcome: &'static str) -> Self {
        Self {
            events,
            outcome,
            ..self
        }
    }

    /// Decodes the input whole and one octet at a time and asserts both give
    /// the same events and ending.
    fn run(&self) -> (Vec<FrameEvent>, Ending) {
        let new_run =
            || FrameRun::new(self.kind, self.role, self.limits, self.tunnel_after_headers);
        let mut whole = new_run();
        whole.pending.extend_from_slice(&self.encoded);
        let whole_ending = match whole.pump() {
            Ok(()) => whole.end(self.fin),
            Err(error) => Ending::Failed(error),
        };
        let mut bytewise = new_run();
        let mut failed = None;
        for &octet in &self.encoded {
            bytewise.pending.push(octet);
            if let Err(error) = bytewise.pump() {
                failed = Some(error);
                break;
            }
        }
        let bytewise_ending = match failed {
            Some(error) => Ending::Failed(error),
            None => bytewise.end(self.fin),
        };
        assert_eq!(
            (&whole.events, &whole_ending),
            (&bytewise.events, &bytewise_ending),
            "whole and one-octet feeding agree on {}",
            self.name
        );
        (whole.events, whole_ending)
    }
}

fn stream_kind_name(kind: StreamKind) -> &'static str {
    match kind {
        StreamKind::Control => "control",
        StreamKind::Request => "request",
        StreamKind::Push => "push",
    }
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Client => "client",
        Role::Server => "server",
    }
}

fn frame_limits_value(limits: &FrameLimits) -> Value {
    json!({ "fieldSection": dec(limits.field_section), "settings": dec(limits.settings) })
}

fn h3_varints() -> Value {
    let mut list = Vec::new();
    for (name, published, value) in RFC9000_A_1 {
        let bytes = unhex(published);
        assert_eq!(varint::decode(&bytes), Some((value, bytes.len())), "{name}");
        assert_eq!(varint_with_len(value, bytes.len()), bytes, "{name}");
        let shortest = varint::encoded_len(value) == Some(bytes.len());
        list.push(json!({
            "name": name,
            "section": "RFC 9000 Appendix A.1",
            "encoded": hex(&bytes),
            "value": dec(value),
            "shortest": shortest,
        }));
    }
    let boundaries: [(u64, usize); 7] = [
        (63, 1),
        (64, 2),
        (16_383, 2),
        (16_384, 4),
        (1_073_741_823, 4),
        (1_073_741_824, 8),
        (varint::MAX, 8),
    ];
    for (value, len) in boundaries {
        let bytes = varint_bytes(value);
        assert_eq!(bytes.len(), len, "{value} takes {len} octets");
        assert_eq!(varint::decode(&bytes), Some((value, len)));
        list.push(json!({
            "name": value.to_string(),
            "section": "RFC 9000 Section 16",
            "encoded": hex(&bytes),
            "value": dec(value),
            "shortest": true,
        }));
    }
    let refused = [varint::MAX + 1, u64::MAX];
    for value in refused {
        assert_eq!(varint::encoded_len(value), None, "{value} is refused");
        assert_eq!(
            varint::push(value, &mut Vec::new()),
            None,
            "{value} is refused"
        );
    }
    json!({
        "cases": list,
        "refused": refused.iter().map(|value| dec(*value)).collect::<Vec<_>>(),
    })
}

fn h3_reserved_values() -> Value {
    let first: Vec<u64> = (0..6)
        .map(|n| reserved::reserved(n).expect("n within the reserved range"))
        .collect();
    assert_eq!(
        first,
        [0x21, 0x40, 0x5f, 0x7e, 0x9d, 0xbc],
        "0x1f * N + 0x21"
    );
    let last = reserved::reserved(reserved::MAX_N).expect("MAX_N is in range");
    assert_eq!(last, 0x3fff_ffff_ffff_fffe, "the largest reserved value");
    assert_eq!(reserved::reserved(reserved::MAX_N + 1), None);
    for value in first.iter().copied().chain([last]) {
        assert!(reserved::is_reserved(value), "{value} is reserved");
    }
    let not_reserved = [0, 1, 0x20, 0x22, 0x3f, varint::MAX];
    for value in not_reserved {
        assert!(!reserved::is_reserved(value), "{value} is not reserved");
    }
    json!({
        "section": "RFC 9114 Section 7.2.8",
        "first": first.iter().map(|value| dec(*value)).collect::<Vec<_>>(),
        "last": dec(last),
        "notReserved": not_reserved.iter().map(|value| dec(*value)).collect::<Vec<_>>(),
    })
}

fn h3_frame_case_list() -> Vec<FrameCase> {
    use FrameEvent as E;
    use Role::{Client, Server};
    use StreamKind::{Control, Push, Request};

    let get = encode_section(
        HuffmanPolicy::Shorter,
        &[
            FieldLine::new(b":method", b"GET"),
            FieldLine::new(b":scheme", b"https"),
            FieldLine::new(b":path", b"/"),
        ],
    );
    let connect = encode_section(
        HuffmanPolicy::Shorter,
        &[
            FieldLine::new(b":method", b"CONNECT"),
            FieldLine::new(b":authority", b"example.com:443"),
        ],
    );
    let ok = encode_section(
        HuffmanPolicy::Shorter,
        &[FieldLine::new(b":status", b"200")],
    );
    let trailers = encode_section(
        HuffmanPolicy::Shorter,
        &[FieldLine::new(b"x-trailer", b"1")],
    );
    let headers = |section: &[u8]| {
        frame_bytes(Frame::Headers {
            field_section: section,
        })
    };
    let goaway = |id| frame_bytes(Frame::Goaway { id });
    let max_push_id = |push_id| frame_bytes(Frame::MaxPushId { push_id });
    let cancel_push = |push_id| frame_bytes(Frame::CancelPush { push_id });
    let push_promise = frame_bytes(Frame::PushPromise {
        push_id: 0,
        field_section: &get,
    });
    let empty = frame_bytes(Frame::Settings(Settings::EMPTY));
    let server = Settings::server(&Http3Limits::DEFAULT);
    let settings = || E::Settings(Settings::EMPTY);
    let cut_data = cat(&[&headers(&get), &data_frame(b"hello")[..4]]);
    let held = FrameLimits {
        field_section: 4,
        settings: SETTINGS_PAYLOAD_LIMIT,
    };
    assert!(get.len() > 4, "the section is above the held limit");
    vec![
        FrameCase::new(
            "server control stream",
            "RFC 9114 Section 6.2.1",
            Control,
            Client,
            frame_bytes(Frame::Settings(server)),
        )
        .yields(vec![E::Settings(server)], "ok"),
        FrameCase::new(
            "request with content and trailers",
            "RFC 9114 Section 4.1",
            Request,
            Server,
            cat(&[
                &headers(&get),
                &data_frame(b"hello"),
                &data_frame(b""),
                &headers(&trailers),
            ]),
        )
        .fin()
        .yields(
            vec![
                E::Headers(get.clone()),
                E::Data(b"hello".to_vec()),
                E::Data(Vec::new()),
                E::Headers(trailers.clone()),
            ],
            "ok",
        ),
        FrameCase::new(
            "response after a push promise",
            "RFC 9114 Section 4.1",
            Request,
            Client,
            cat(&[&push_promise, &headers(&ok), &data_frame(b"ok")]),
        )
        .fin()
        .yields(
            vec![
                E::PushPromise(0, get.clone()),
                E::Headers(ok.clone()),
                E::Data(b"ok".to_vec()),
            ],
            "ok",
        ),
        FrameCase::new(
            "grease frame skipped",
            "RFC 9114 Section 7.2.8",
            Request,
            Server,
            cat(&[&reserved_frame(0, &[0xab, 0xcd]), &headers(&get)]),
        )
        .fin()
        .yields(vec![E::Skipped(0x21, 2), E::Headers(get.clone())], "ok"),
        FrameCase::new(
            "zero-length grease frame skipped",
            "RFC 9114 Section 7.2.8",
            Request,
            Server,
            cat(&[&reserved_frame(0, &[]), &headers(&get)]),
        )
        .fin()
        .yields(vec![E::Skipped(0x21, 0), E::Headers(get.clone())], "ok"),
        FrameCase::new(
            "frame type 0x4000 is DATA",
            "RFC 9000 Section 16",
            Request,
            Server,
            cat(&[
                &headers(&get),
                &varint_with_len(0x00, 2),
                &varint_bytes(3),
                b"abc",
            ]),
        )
        .fin()
        .yields(
            vec![E::Headers(get.clone()), E::Data(b"abc".to_vec())],
            "ok",
        ),
        FrameCase::new(
            "PRIORITY_UPDATE is skipped",
            "RFC 9114 Section 9",
            Control,
            Server,
            cat(&[&empty, &frame_header(0xf0700, 4), &[0x00], b"u=1"]),
        )
        .yields(vec![settings(), E::Skipped(0xf0700, 4)], "ok"),
        FrameCase::new(
            "graceful GOAWAY",
            "RFC 9114 Section 5.2",
            Control,
            Client,
            cat(&[&empty, &goaway(GoawaySender::GRACEFUL_SERVER)]),
        )
        .yields(
            vec![settings(), E::Goaway(GoawaySender::GRACEFUL_SERVER)],
            "ok",
        ),
        FrameCase::new(
            "repeated MAX_PUSH_ID",
            "RFC 9114 Section 7.2.7",
            Control,
            Server,
            cat(&[&empty, &max_push_id(8), &max_push_id(8)]),
        )
        .yields(vec![settings(), E::MaxPushId(8), E::MaxPushId(8)], "ok"),
        FrameCase::new(
            "GOAWAY payload with an octet after its integer",
            "RFC 9114 Section 7.1",
            Control,
            Client,
            cat(&[&empty, &frame_header(0x07, 2), &varint_bytes(4), &[0x00]]),
        )
        .yields(vec![settings()], "payloadTrailing"),
        FrameCase::new(
            "GOAWAY payload ending inside its integer",
            "RFC 9114 Section 7.1",
            Control,
            Client,
            cat(&[&empty, &frame_header(0x07, 1), &varint_with_len(4, 2)[..1]]),
        )
        .yields(vec![settings()], "payloadTruncated"),
        FrameCase::new(
            "stream ended inside a DATA payload",
            "RFC 9114 Section 7.1",
            Request,
            Server,
            cut_data.clone(),
        )
        .fin()
        .yields(
            vec![E::Headers(get.clone()), E::Data(b"he".to_vec())],
            "streamEndedInFrame",
        ),
        FrameCase::new(
            "input ending inside a DATA payload",
            "RFC 9114 Section 7.1",
            Request,
            Server,
            cut_data,
        )
        .yields(
            vec![E::Headers(get.clone()), E::Data(b"he".to_vec())],
            "needMore",
        ),
        FrameCase::new(
            "SETTINGS Length ending inside a value",
            "RFC 9114 Section 10.8",
            Control,
            Server,
            cat(&[
                &frame_header(0x04, 2),
                &varint_bytes(0x06),
                &varint_with_len(32_768, 4)[..1],
            ]),
        )
        .yields(vec![], "payloadTruncated"),
        FrameCase::new(
            "DATA on the control stream",
            "RFC 9114 Section 7.2.1",
            Control,
            Server,
            cat(&[&empty, &data_frame(b"")]),
        )
        .yields(vec![settings()], "wrongStream"),
        FrameCase::new(
            "HEADERS on the control stream",
            "RFC 9114 Section 7.2.2",
            Control,
            Server,
            cat(&[&empty, &headers(&get)]),
        )
        .yields(vec![settings()], "wrongStream"),
        FrameCase::new(
            "CANCEL_PUSH on a request stream",
            "RFC 9114 Section 7.2.3",
            Request,
            Server,
            cancel_push(0),
        )
        .yields(vec![], "wrongStream"),
        FrameCase::new(
            "CANCEL_PUSH above the maximum push ID",
            "RFC 9114 Section 7.2.3",
            Control,
            Server,
            cat(&[&empty, &cancel_push(0)]),
        )
        .yields(vec![settings()], "pushIdAboveMaximum"),
        FrameCase::new(
            "CANCEL_PUSH for a push never promised",
            "RFC 9114 Section 7.2.3",
            Control,
            Server,
            cat(&[&empty, &max_push_id(8), &cancel_push(4)]),
        )
        .yields(vec![settings(), E::MaxPushId(8)], "pushIdNotPromised"),
        FrameCase::new(
            "second SETTINGS",
            "RFC 9114 Section 7.2.4",
            Control,
            Server,
            cat(&[&empty, &empty]),
        )
        .yields(vec![settings()], "secondSettings"),
        FrameCase::new(
            "SETTINGS on a request stream",
            "RFC 9114 Section 7.2.4",
            Request,
            Server,
            empty.clone(),
        )
        .yields(vec![], "wrongStream"),
        FrameCase::new(
            "control stream starting with GOAWAY",
            "RFC 9114 Section 6.2.1",
            Control,
            Client,
            goaway(0),
        )
        .yields(vec![], "missingSettings"),
        FrameCase::new(
            "control stream starting with a reserved frame type",
            "RFC 9114 Section 6.2.1",
            Control,
            Server,
            reserved_frame(0, &[]),
        )
        .yields(vec![], "missingSettings"),
        FrameCase::new(
            "PUSH_PROMISE received by a server",
            "RFC 9114 Section 7.2.5",
            Request,
            Server,
            push_promise.clone(),
        )
        .yields(vec![], "wrongRole"),
        FrameCase::new(
            "PUSH_PROMISE on the control stream",
            "RFC 9114 Section 7.2.5",
            Control,
            Client,
            cat(&[&empty, &push_promise]),
        )
        .yields(vec![settings()], "wrongStream"),
        FrameCase::new(
            "PUSH_PROMISE on a push stream",
            "RFC 9114 Section 4.1",
            Push,
            Client,
            push_promise.clone(),
        )
        .yields(vec![], "wrongStream"),
        FrameCase::new(
            "GOAWAY on a request stream",
            "RFC 9114 Section 7.2.6",
            Request,
            Server,
            goaway(0),
        )
        .yields(vec![], "wrongStream"),
        FrameCase::new(
            "MAX_PUSH_ID on a request stream",
            "RFC 9114 Section 7.2.7",
            Request,
            Server,
            max_push_id(0),
        )
        .yields(vec![], "wrongStream"),
        FrameCase::new(
            "MAX_PUSH_ID received by a client",
            "RFC 9114 Section 7.2.7",
            Control,
            Client,
            cat(&[&empty, &max_push_id(0)]),
        )
        .yields(vec![settings()], "wrongRole"),
        FrameCase::new(
            "MAX_PUSH_ID smaller than before",
            "RFC 9114 Section 7.2.7",
            Control,
            Server,
            cat(&[&empty, &max_push_id(8), &max_push_id(4)]),
        )
        .yields(vec![settings(), E::MaxPushId(8)], "maxPushIdDecreased"),
        FrameCase::new(
            "HTTP/2 PRIORITY type on a request stream",
            "RFC 9114 Section 7.2.8",
            Request,
            Server,
            frame_header(0x02, 0),
        )
        .yields(vec![], "reservedFrameType"),
        FrameCase::new(
            "HTTP/2 PING type on the control stream",
            "RFC 9114 Section 7.2.8",
            Control,
            Server,
            cat(&[&empty, &frame_header(0x06, 0)]),
        )
        .yields(vec![settings()], "reservedFrameType"),
        FrameCase::new(
            "HTTP/2 WINDOW_UPDATE type first on the control stream",
            "RFC 9114 Section 6.2.1",
            Control,
            Server,
            frame_header(0x08, 0),
        )
        .yields(vec![], "missingSettings"),
        FrameCase::new(
            "HTTP/2 CONTINUATION type on a push stream",
            "RFC 9114 Section 7.2.8",
            Push,
            Client,
            frame_header(0x09, 0),
        )
        .yields(vec![], "reservedFrameType"),
        FrameCase::new(
            "DATA before HEADERS",
            "RFC 9114 Section 4.1",
            Request,
            Server,
            data_frame(b""),
        )
        .yields(vec![], "outOfSequence"),
        FrameCase::new(
            "HEADERS after the trailers",
            "RFC 9114 Section 4.1",
            Request,
            Server,
            cat(&[&headers(&get), &headers(&trailers), &headers(&get)]),
        )
        .yields(
            vec![E::Headers(get.clone()), E::Headers(trailers.clone())],
            "outOfSequence",
        ),
        FrameCase::new(
            "DATA after the trailers",
            "RFC 9114 Section 4.1",
            Request,
            Server,
            cat(&[
                &headers(&get),
                &data_frame(b"x"),
                &headers(&trailers),
                &data_frame(b""),
            ]),
        )
        .yields(
            vec![
                E::Headers(get.clone()),
                E::Data(b"x".to_vec()),
                E::Headers(trailers.clone()),
            ],
            "outOfSequence",
        ),
        FrameCase::new(
            "HEADERS after a CONNECT completed",
            "RFC 9114 Section 4.4",
            Request,
            Server,
            cat(&[&headers(&connect), &data_frame(b"x"), &headers(&trailers)]),
        )
        .tunnel()
        .yields(
            vec![E::Headers(connect.clone()), E::Data(b"x".to_vec())],
            "outOfSequence",
        ),
        FrameCase::new(
            "DATA and unknown frames after a CONNECT completed",
            "RFC 9114 Section 4.4",
            Request,
            Server,
            cat(&[
                &headers(&connect),
                &data_frame(b"x"),
                &reserved_frame(1, &[0x00]),
                &data_frame(b"y"),
            ]),
        )
        .tunnel()
        .fin()
        .yields(
            vec![
                E::Headers(connect.clone()),
                E::Data(b"x".to_vec()),
                E::Skipped(0x40, 1),
                E::Data(b"y".to_vec()),
            ],
            "ok",
        ),
        FrameCase::new(
            "request stream ended before HEADERS",
            "RFC 9114 Section 4.1",
            Request,
            Server,
            reserved_frame(1, &[]),
        )
        .fin()
        .yields(vec![E::Skipped(0x40, 0)], "requestIncomplete"),
        FrameCase::new(
            "SETTINGS above the local limit",
            "RFC 9114 Section 10.5",
            Control,
            Server,
            frame_header(0x04, SETTINGS_PAYLOAD_LIMIT + 1),
        )
        .yields(vec![], "excessiveLoad"),
        FrameCase::new(
            "HEADERS above the field section limit",
            "RFC 9114 Section 4.2.2",
            Request,
            Server,
            headers(&get),
        )
        .limits(held)
        .fin()
        .yields(
            vec![E::Oversized(
                0x01,
                u64::try_from(get.len()).expect("a short section"),
            )],
            "ok",
        ),
    ]
}

fn h3_frame_cases() -> Value {
    let mut list = Vec::new();
    for case in h3_frame_case_list() {
        let (events, ending) = case.run();
        assert_eq!(events, case.events, "{}", case.name);
        assert_eq!(ending.name(), case.outcome, "{}", case.name);
        list.push(json!({
            "name": case.name,
            "section": case.section,
            "stream": stream_kind_name(case.kind),
            "role": role_name(case.role),
            "limits": frame_limits_value(&case.limits),
            "tunnelAfterHeaders": case.tunnel_after_headers,
            "encoded": hex(&case.encoded),
            "fin": case.fin,
            "events": events.iter().map(frame_event_value).collect::<Vec<_>>(),
            "outcome": ending.value(),
        }));
    }
    json!({ "cases": list })
}

/// A SETTINGS payload of identifier and value pairs.
fn settings_payload(pairs: &[(u64, u64)]) -> Vec<u8> {
    let mut out = Vec::new();
    for &(id, value) in pairs {
        varint::push(id, &mut out).expect("an identifier within 2^62-1");
        varint::push(value, &mut out).expect("a value within 2^62-1");
    }
    out
}

/// A SETTINGS payload: the name, the section, the octets and the result.
type SettingsCase = (
    &'static str,
    &'static str,
    Vec<u8>,
    Result<Settings, &'static str>,
);

fn h3_settings_cases() -> Value {
    let server = Settings::server(&Http3Limits::DEFAULT);
    let server_frame = frame_bytes(Frame::Settings(server));
    let header = FrameHeader::parse(&server_frame).expect("a whole header");
    let server_payload = server_frame[header.header_len..].to_vec();
    assert_eq!(
        server_payload,
        settings_payload(&[(0x01, 0), (0x06, 32_768), (0x07, 0)]),
        "the server sends 0x01, 0x06 and 0x07"
    );
    let enabled = Settings {
        enable_connect_protocol: Some(true),
        h3_datagram: Some(true),
        ..Settings::EMPTY
    };
    let cases: [SettingsCase; 15] = [
        (
            "empty",
            "RFC 9114 Section 7.2.4",
            Vec::new(),
            Ok(Settings::EMPTY),
        ),
        (
            "server settings",
            "RFC 9114 Section 7.2.4.1",
            server_payload,
            Ok(server),
        ),
        (
            "unknown and reserved identifiers ignored",
            "RFC 9114 Section 7.2.4",
            settings_payload(&[(0x21, 0), (0x4d44, 0)]),
            Ok(Settings::EMPTY),
        ),
        (
            "0x00 ignored",
            "RFC 9114 Section 7.2.4",
            settings_payload(&[(0x00, 0)]),
            Ok(Settings::EMPTY),
        ),
        (
            "reserved 0x02",
            "RFC 9114 Section 7.2.4.1",
            settings_payload(&[(0x02, 0)]),
            Err("reservedSetting"),
        ),
        (
            "reserved 0x03",
            "RFC 9114 Section 7.2.4.1",
            settings_payload(&[(0x03, 0)]),
            Err("reservedSetting"),
        ),
        (
            "reserved 0x04",
            "RFC 9114 Section 7.2.4.1",
            settings_payload(&[(0x04, 0)]),
            Err("reservedSetting"),
        ),
        (
            "reserved 0x05",
            "RFC 9114 Section 7.2.4.1",
            settings_payload(&[(0x05, 0)]),
            Err("reservedSetting"),
        ),
        (
            "duplicate 0x06",
            "RFC 9114 Section 7.2.4",
            settings_payload(&[(0x06, 0), (0x06, 0)]),
            Err("duplicateSetting"),
        ),
        (
            "duplicate reserved identifier",
            "RFC 9114 Section 7.2.4",
            settings_payload(&[(0x21, 0), (0x21, 1)]),
            Err("duplicateSetting"),
        ),
        (
            "SETTINGS_H3_DATAGRAM 2",
            "RFC 9297 Section 2.1.1",
            settings_payload(&[(0x33, 2)]),
            Err("settingValue"),
        ),
        (
            "SETTINGS_ENABLE_CONNECT_PROTOCOL 2",
            "RFC 9220 Section 3",
            settings_payload(&[(0x08, 2)]),
            Err("settingValue"),
        ),
        (
            "Extended CONNECT and datagrams enabled",
            "RFC 9297 Section 2.1.1",
            settings_payload(&[(0x08, 1), (0x33, 1)]),
            Ok(enabled),
        ),
        (
            "a dangling identifier",
            "RFC 9114 Section 7.1",
            varint_bytes(0x06),
            Err("payloadTruncated"),
        ),
        (
            "a value ending inside its integer",
            "RFC 9114 Section 7.1",
            cat(&[&varint_bytes(0x06), &varint_with_len(32_768, 4)[..2]]),
            Err("payloadTruncated"),
        ),
    ];
    let mut list = Vec::new();
    for (name, section, payload, expect) in cases {
        let parsed = Settings::parse(&payload);
        assert_eq!(parsed.map_err(|error| error.name()), expect, "{name}");
        let expect = match parsed {
            Ok(settings) => {
                let frame = frame_bytes(Frame::Settings(settings));
                let header = FrameHeader::parse(&frame).expect("a whole header");
                assert_eq!(
                    Settings::parse(&frame[header.header_len..]),
                    Ok(settings),
                    "{name} re-encodes"
                );
                json!({ "settings": settings_value(&settings) })
            }
            Err(error) => h3_error(&error),
        };
        list.push(json!({
            "name": name,
            "section": section,
            "payload": hex(&payload),
            "expect": expect,
        }));
    }
    json!({ "cases": list })
}

fn h3_server_control_stream() -> Value {
    let settings = Settings::server(&Http3Limits::DEFAULT);
    assert_eq!(
        settings,
        Settings {
            qpack_max_table_capacity: Some(0),
            max_field_section_size: Some(32_768),
            qpack_blocked_streams: Some(0),
            enable_connect_protocol: None,
            h3_datagram: None,
        },
        "the server pins capacity 0, 32,768 and 0 blocked streams"
    );
    let decoder = Decoder::new(&Http3Limits::DEFAULT).expect("the default limits build a decoder");
    assert_eq!(
        settings.qpack_max_table_capacity,
        Some(decoder.max_table_capacity())
    );
    assert_eq!(
        settings.qpack_blocked_streams,
        Some(decoder.blocked_streams())
    );
    assert_eq!(
        decoder.max_table_capacity(),
        zero_qpack::DEFAULT_MAX_TABLE_CAPACITY
    );
    assert_eq!(
        decoder.blocked_streams(),
        zero_qpack::DEFAULT_BLOCKED_STREAMS
    );
    let preface = |reserved: Option<Reserved>| {
        let mut out = Vec::new();
        settings
            .encode_control_preface(reserved, &mut out)
            .expect("the settings encode");
        let (stream_type, used) = StreamType::parse(&out).expect("a whole stream type");
        assert_eq!(stream_type, StreamType::Control);
        let case = FrameCase::new(
            "server control stream",
            "RFC 9114 Section 6.2.1",
            StreamKind::Control,
            Role::Client,
            out[used..].to_vec(),
        );
        let (events, ending) = case.run();
        assert_eq!(events, vec![FrameEvent::Settings(settings)]);
        assert_eq!(ending, Ending::Done);
        out
    };
    let reserved = Reserved { n: 0, value: 0 };
    json!({
        "section": "RFC 9114 Sections 6.2.1 and 7.2.4.1",
        "settings": settings_value(&settings),
        "encoded": hex(&preface(None)),
        "withReserved": {
            "n": dec(reserved.n),
            "value": dec(reserved.value),
            "encoded": hex(&preface(Some(reserved))),
        },
    })
}

fn stream_type_name(stream_type: StreamType) -> &'static str {
    match stream_type {
        StreamType::Control => "control",
        StreamType::Push => "push",
        StreamType::QpackEncoder => "qpackEncoder",
        StreamType::QpackDecoder => "qpackDecoder",
        StreamType::Reserved(_) => "reserved",
        StreamType::Unknown(_) => "unknown",
    }
}

fn h3_stream_types() -> Value {
    let reserved_type = reserved::reserved(0).expect("n = 0 is in range");
    let cases: [(&str, &str, Vec<u8>, Option<StreamType>); 8] = [
        (
            "control",
            "RFC 9114 Section 6.2.1",
            varint_bytes(0x00),
            Some(StreamType::Control),
        ),
        (
            "push",
            "RFC 9114 Section 6.2.2",
            varint_bytes(0x01),
            Some(StreamType::Push),
        ),
        (
            "QPACK encoder",
            "RFC 9204 Section 4.2",
            varint_bytes(zero_qpack::ENCODER_STREAM_TYPE),
            Some(StreamType::QpackEncoder),
        ),
        (
            "QPACK decoder",
            "RFC 9204 Section 4.2",
            varint_bytes(zero_qpack::DECODER_STREAM_TYPE),
            Some(StreamType::QpackDecoder),
        ),
        (
            "reserved 0x21",
            "RFC 9114 Section 6.2.3",
            varint_bytes(reserved_type),
            Some(StreamType::Reserved(reserved_type)),
        ),
        (
            "unknown 0x04",
            "RFC 9114 Section 6.2",
            varint_bytes(0x04),
            Some(StreamType::Unknown(0x04)),
        ),
        (
            "non-minimal control",
            "RFC 9000 Section 16",
            varint_with_len(0x00, 2),
            Some(StreamType::Control),
        ),
        (
            "stream ended inside its type",
            "RFC 9114 Section 6.2",
            varint_with_len(0x00, 2)[..1].to_vec(),
            None,
        ),
    ];
    let mut list = Vec::new();
    for (name, section, encoded, expect) in cases {
        let parsed = StreamType::parse(&encoded);
        assert_eq!(parsed.map(|(stream_type, _)| stream_type), expect, "{name}");
        if let Some((_, used)) = parsed {
            assert_eq!(used, encoded.len(), "{name}");
        }
        list.push(json!({
            "name": name,
            "section": section,
            "encoded": hex(&encoded),
            "type": expect.map_or("needMore", stream_type_name),
            "value": expect.map(|stream_type| dec(stream_type.value())),
        }));
    }
    json!({ "cases": list })
}

fn disposition_name(disposition: Disposition) -> &'static str {
    match disposition {
        Disposition::Control => "control",
        Disposition::Push => "push",
        Disposition::QpackEncoder => "qpackEncoder",
        Disposition::QpackDecoder => "qpackDecoder",
        Disposition::Discard => "discard",
    }
}

/// Values one endpoint receives in order: the name, the section, the local
/// role, the values and the outcome of each, up to the first error.
type SequenceCase = (
    &'static str,
    &'static str,
    Role,
    Vec<u64>,
    Vec<&'static str>,
);

fn h3_uni_streams() -> Value {
    let cases: [SequenceCase; 6] = [
        (
            "one of each critical stream",
            "RFC 9204 Section 4.2",
            Role::Server,
            vec![0x00, 0x02, 0x03, 0x21, 0x04],
            vec![
                "control",
                "qpackEncoder",
                "qpackDecoder",
                "discard",
                "discard",
            ],
        ),
        (
            "second control stream",
            "RFC 9114 Section 6.2.1",
            Role::Server,
            vec![0x00, 0x00],
            vec!["control", "secondCriticalStream"],
        ),
        (
            "second encoder stream",
            "RFC 9204 Section 4.2",
            Role::Server,
            vec![0x02, 0x02],
            vec!["qpackEncoder", "secondCriticalStream"],
        ),
        (
            "second decoder stream",
            "RFC 9204 Section 4.2",
            Role::Server,
            vec![0x03, 0x03],
            vec!["qpackDecoder", "secondCriticalStream"],
        ),
        (
            "push stream at a server",
            "RFC 9114 Section 6.2.2",
            Role::Server,
            vec![0x01],
            vec!["pushStreamFromClient"],
        ),
        (
            "push stream at a client",
            "RFC 9114 Section 6.2.2",
            Role::Client,
            vec![0x01],
            vec!["push"],
        ),
    ];
    let mut list = Vec::new();
    for (name, section, role, opened, expect) in cases {
        let mut streams = UniStreams::new(role);
        let mut names = Vec::new();
        let mut values = Vec::new();
        for &stream_type in &opened {
            match streams.open(StreamType::from_value(stream_type)) {
                Ok(disposition) => {
                    names.push(disposition_name(disposition));
                    values.push(json!(disposition_name(disposition)));
                }
                Err(error) => {
                    names.push(error.name());
                    values.push(h3_error(&error));
                    break;
                }
            }
        }
        assert_eq!(names, expect, "{name}");
        list.push(json!({
            "name": name,
            "section": section,
            "role": role_name(role),
            "opened": opened.iter().map(|value| dec(*value)).collect::<Vec<_>>(),
            "expect": values,
        }));
    }
    let closed_cases: [(u64, &str); 5] = [
        (0x00, "criticalStreamClosed"),
        (0x01, "ok"),
        (0x02, "criticalStreamClosed"),
        (0x03, "criticalStreamClosed"),
        (0x21, "ok"),
    ];
    let mut closed = Vec::new();
    for (stream_type, expect) in closed_cases {
        let verdict = UniStreams::new(Role::Server).closed(StreamType::from_value(stream_type));
        assert_eq!(
            verdict.map_or_else(|error| error.name(), |()| "ok"),
            expect,
            "closing stream type {stream_type}"
        );
        closed.push(json!({
            "type": dec(stream_type),
            "expect": verdict.map_or_else(|error| h3_error(&error), |()| json!("ok")),
        }));
    }
    json!({ "cases": list, "closed": closed })
}

fn h3_error_codes() -> Value {
    let registered = [
        ErrorCode::H3_DATAGRAM_ERROR,
        ErrorCode::H3_NO_ERROR,
        ErrorCode::H3_GENERAL_PROTOCOL_ERROR,
        ErrorCode::H3_INTERNAL_ERROR,
        ErrorCode::H3_STREAM_CREATION_ERROR,
        ErrorCode::H3_CLOSED_CRITICAL_STREAM,
        ErrorCode::H3_FRAME_UNEXPECTED,
        ErrorCode::H3_FRAME_ERROR,
        ErrorCode::H3_EXCESSIVE_LOAD,
        ErrorCode::H3_ID_ERROR,
        ErrorCode::H3_SETTINGS_ERROR,
        ErrorCode::H3_MISSING_SETTINGS,
        ErrorCode::H3_REQUEST_REJECTED,
        ErrorCode::H3_REQUEST_CANCELLED,
        ErrorCode::H3_REQUEST_INCOMPLETE,
        ErrorCode::H3_MESSAGE_ERROR,
        ErrorCode::H3_CONNECT_ERROR,
        ErrorCode::H3_VERSION_FALLBACK,
        ErrorCode::QPACK_DECOMPRESSION_FAILED,
        ErrorCode::QPACK_ENCODER_STREAM_ERROR,
        ErrorCode::QPACK_DECODER_STREAM_ERROR,
    ];
    let values: Vec<u64> = registered.iter().map(|code| code.0).collect();
    let expected: Vec<u64> = [0x33]
        .into_iter()
        .chain(0x0100..=0x0110)
        .chain(0x0200..=0x0202)
        .collect();
    assert_eq!(
        values, expected,
        "RFC 9114 Section 8.1, RFC 9297 and RFC 9204"
    );
    assert_eq!(
        [
            ErrorCode::QPACK_DECOMPRESSION_FAILED.0,
            ErrorCode::QPACK_ENCODER_STREAM_ERROR.0,
            ErrorCode::QPACK_DECODER_STREAM_ERROR.0,
        ],
        [
            zero_qpack::QPACK_DECOMPRESSION_FAILED,
            zero_qpack::QPACK_ENCODER_STREAM_ERROR,
            zero_qpack::QPACK_DECODER_STREAM_ERROR,
        ],
        "both codecs carry the same QPACK codes"
    );
    let mut list = Vec::new();
    for code in registered {
        assert!(!code.is_reserved(), "{code} is outside the reserved space");
        assert_eq!(code.on_receipt(), code);
        list.push(json!({ "name": code.name().expect("a registered name"), "value": code.0 }));
    }
    let on_receipt: [(u64, ErrorCode); 3] = [
        (0x21, ErrorCode::H3_NO_ERROR),
        (0x1000, ErrorCode::H3_NO_ERROR),
        (0x0105, ErrorCode::H3_FRAME_UNEXPECTED),
    ];
    let mut received = Vec::new();
    for (value, treated_as) in on_receipt {
        assert_eq!(ErrorCode(value).on_receipt(), treated_as, "{value}");
        received.push(json!({ "value": dec(value), "treatedAs": treated_as.0 }));
    }
    json!({ "registered": list, "onReceipt": received })
}

fn h3_goaway() -> Value {
    let cases: [SequenceCase; 5] = [
        (
            "client receives decreasing stream IDs",
            "RFC 9114 Section 5.2",
            Role::Client,
            vec![8, 4, 4],
            vec!["ok", "ok", "ok"],
        ),
        (
            "client receives a larger stream ID",
            "RFC 9114 Section 5.2",
            Role::Client,
            vec![4, 8],
            vec!["ok", "goawayIncreased"],
        ),
        (
            "client receives a unidirectional stream ID",
            "RFC 9114 Section 7.2.6",
            Role::Client,
            vec![2],
            vec!["goawayStreamType"],
        ),
        (
            "server receives any push ID",
            "RFC 9114 Section 7.2.6",
            Role::Server,
            vec![3],
            vec!["ok"],
        ),
        (
            "server receives a larger push ID",
            "RFC 9114 Section 5.2",
            Role::Server,
            vec![3, 5],
            vec!["ok", "goawayIncreased"],
        ),
    ];
    let mut list = Vec::new();
    for (name, section, role, received, expect) in cases {
        let mut control = PeerControl::new(role);
        let mut names = Vec::new();
        let mut values = Vec::new();
        for &id in &received {
            match control.receive(&Frame::Goaway { id }) {
                Ok(()) => {
                    names.push("ok");
                    values.push(json!("ok"));
                }
                Err(error) => {
                    names.push(error.name());
                    values.push(h3_error(&error));
                    break;
                }
            }
        }
        assert_eq!(names, expect, "{name}");
        list.push(json!({
            "name": name,
            "section": section,
            "role": role_name(role),
            "received": received.iter().map(|id| dec(*id)).collect::<Vec<_>>(),
            "expect": values,
        }));
    }
    let mut server = GoawaySender::new(Role::Server);
    assert_eq!(
        server.send(GoawaySender::GRACEFUL_SERVER),
        Some(GoawaySender::GRACEFUL_SERVER)
    );
    assert_eq!(server.send(8), Some(8));
    assert_eq!(server.send(12), None, "never above a previous GOAWAY");
    assert_eq!(GoawaySender::new(Role::Server).send(2), None);
    let mut client = GoawaySender::new(Role::Client);
    assert_eq!(
        client.send(GoawaySender::GRACEFUL_CLIENT),
        Some(GoawaySender::GRACEFUL_CLIENT)
    );
    json!({
        "cases": list,
        "gracefulServer": dec(GoawaySender::GRACEFUL_SERVER),
        "gracefulClient": dec(GoawaySender::GRACEFUL_CLIENT),
    })
}

/// A capsule decoded on a stream; the pieces of a skipped value are not kept.
#[derive(Clone, Debug, PartialEq, Eq)]
enum CapsuleEvent {
    Datagram(Vec<u8>),
    Skipped(u64, u64),
}

fn capsule_event_value(event: &CapsuleEvent) -> Value {
    match event {
        CapsuleEvent::Datagram(payload) => json!({ "datagram": hex(payload) }),
        CapsuleEvent::Skipped(capsule_type, len) => {
            json!({ "skipped": { "type": dec(*capsule_type), "length": dec(*len) } })
        }
    }
}

/// A capsule decoder driven over a buffer, checking the step sequence of
/// every skipped value.
struct CapsuleRun {
    decoder: CapsuleDecoder,
    pending: Vec<u8>,
    events: Vec<CapsuleEvent>,
    open: Option<u64>,
}

impl CapsuleRun {
    fn new(max_datagram: u64) -> Self {
        Self {
            decoder: CapsuleDecoder::new(max_datagram),
            pending: Vec::new(),
            events: Vec::new(),
            open: None,
        }
    }

    /// Decodes until the decoder needs more octets.
    fn pump(&mut self) {
        loop {
            let mut input = std::mem::take(&mut self.pending);
            let (consumed, more) = match self.decoder.decode(&input) {
                CapsuleStep::NeedMore { consumed } => (consumed, false),
                CapsuleStep::Datagram { payload, consumed } => {
                    assert_eq!(self.open, None, "a whole capsule between values");
                    self.events.push(CapsuleEvent::Datagram(payload.to_vec()));
                    (consumed, true)
                }
                CapsuleStep::Skipped {
                    capsule_type,
                    len,
                    consumed,
                } => {
                    assert_eq!(self.open, None, "a skipped capsule between values");
                    self.open = Some(len);
                    self.events.push(CapsuleEvent::Skipped(capsule_type, len));
                    (consumed, true)
                }
                CapsuleStep::Value {
                    data,
                    consumed,
                    end,
                } => {
                    let remaining = self.open.expect("a piece inside a skipped value");
                    let len = u64::try_from(data.len()).expect("a piece fits u64");
                    assert!(len <= remaining, "a piece within the capsule Length");
                    let left = remaining - len;
                    assert_eq!(end, left == 0, "end marks the last piece");
                    self.open = (!end).then_some(left);
                    (consumed, true)
                }
            };
            input.drain(..consumed);
            self.pending = input;
            if !more {
                return;
            }
        }
    }

    fn end(&self, fin: bool) -> Ending {
        if fin {
            match self.decoder.finish(&self.pending) {
                Ok(()) => Ending::Done,
                Err(error) => Ending::Failed(error),
            }
        } else if self.pending.is_empty() && self.open.is_none() {
            Ending::Done
        } else {
            Ending::NeedMore
        }
    }
}

/// Decodes capsules whole and one octet at a time and asserts both give the
/// same events and ending.
fn capsule_events(max_datagram: u64, input: &[u8], fin: bool) -> (Vec<CapsuleEvent>, Ending) {
    let mut whole = CapsuleRun::new(max_datagram);
    whole.pending.extend_from_slice(input);
    whole.pump();
    let whole_ending = whole.end(fin);
    let mut bytewise = CapsuleRun::new(max_datagram);
    for &octet in input {
        bytewise.pending.push(octet);
        bytewise.pump();
    }
    let bytewise_ending = bytewise.end(fin);
    assert_eq!(
        (&whole.events, &whole_ending),
        (&bytewise.events, &bytewise_ending),
        "whole and one-octet feeding agree"
    );
    (whole.events, whole_ending)
}

/// A capsule sequence the codec writes.
fn capsule_bytes(capsule_type: u64, value: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    encode_capsule(capsule_type, value, &mut out).expect("a capsule within 2^62-1");
    out
}

/// A DATAGRAM capsule the codec writes.
fn datagram_capsule(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    encode_datagram_capsule(payload, &mut out).expect("a payload within 2^62-1");
    out
}

/// One stream's capsules and what the decoder must make of them.
type CapsuleCase = (
    &'static str,
    &'static str,
    u64,
    Vec<u8>,
    bool,
    Vec<CapsuleEvent>,
    &'static str,
);

fn h3_capsules() -> Value {
    use CapsuleEvent::{Datagram as D, Skipped as S};
    let reserved_type = 0x17;
    assert!(zero_h3::capsule::is_reserved_capsule_type(reserved_type));
    assert_eq!(zero_h3::capsule::DATAGRAM, 0x00);
    let truncated = datagram_capsule(b"hello")[..3].to_vec();
    let cases: [CapsuleCase; 8] = [
        (
            "DATAGRAM capsule",
            "RFC 9297 Section 3.5",
            1200,
            datagram_capsule(b"hel"),
            true,
            vec![D(b"hel".to_vec())],
            "ok",
        ),
        (
            "empty DATAGRAM capsule",
            "RFC 9297 Section 3.5",
            1200,
            datagram_capsule(b""),
            true,
            vec![D(Vec::new())],
            "ok",
        ),
        (
            "reserved type 0x17 skipped",
            "RFC 9297 Section 3.2",
            1200,
            cat(&[
                &capsule_bytes(reserved_type, &[0xab, 0xcd]),
                &datagram_capsule(&[0x01]),
            ]),
            true,
            vec![S(reserved_type, 2), D(vec![0x01])],
            "ok",
        ),
        (
            "zero-length reserved capsule skipped",
            "RFC 9297 Section 3.2",
            1200,
            cat(&[
                &capsule_bytes(reserved_type, &[]),
                &datagram_capsule(&[0x01]),
            ]),
            true,
            vec![S(reserved_type, 0), D(vec![0x01])],
            "ok",
        ),
        (
            "non-minimal type and length",
            "RFC 9297 Section 1.1",
            1200,
            cat(&[
                &varint_with_len(zero_h3::capsule::DATAGRAM, 2),
                &varint_with_len(1, 2),
                &[0xff],
            ]),
            true,
            vec![D(vec![0xff])],
            "ok",
        ),
        (
            "oversized DATAGRAM discarded",
            "RFC 9297 Section 3.5",
            2,
            datagram_capsule(&[0x01, 0x02, 0x03]),
            true,
            vec![S(zero_h3::capsule::DATAGRAM, 3)],
            "ok",
        ),
        (
            "truncated at FIN",
            "RFC 9297 Section 3.3",
            1200,
            truncated.clone(),
            true,
            vec![],
            "capsuleTruncated",
        ),
        (
            "input ending inside a capsule",
            "RFC 9297 Section 3.2",
            1200,
            truncated,
            false,
            vec![],
            "needMore",
        ),
    ];
    let mut list = Vec::new();
    for (name, section, max_datagram, encoded, fin, expect_events, outcome) in cases {
        let (events, ending) = capsule_events(max_datagram, &encoded, fin);
        assert_eq!(events, expect_events, "{name}");
        assert_eq!(ending.name(), outcome, "{name}");
        list.push(json!({
            "name": name,
            "section": section,
            "maxDatagram": dec(max_datagram),
            "encoded": hex(&encoded),
            "fin": fin,
            "events": events.iter().map(capsule_event_value).collect::<Vec<_>>(),
            "outcome": ending.value(),
        }));
    }
    json!({ "cases": list })
}

/// The Datagram Data field of a datagram on `stream_id`.
fn datagram_bytes(stream_id: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    Datagram::encode(stream_id, payload, &mut out)
        .expect("a client-initiated bidirectional stream");
    out
}

/// A datagram: the name, the section, the octets and the stream and payload
/// it carries, or the error.
type DatagramCase = (
    &'static str,
    &'static str,
    Vec<u8>,
    Result<(u64, Vec<u8>), &'static str>,
);

fn h3_datagrams() -> Value {
    let largest = MAX_QUARTER_STREAM_ID * 4;
    let cases: [DatagramCase; 7] = [
        (
            "stream 4",
            "RFC 9297 Section 2.1",
            datagram_bytes(4, &[0xab, 0xcd]),
            Ok((4, vec![0xab, 0xcd])),
        ),
        (
            "empty payload",
            "RFC 9297 Section 2.1",
            datagram_bytes(0, &[]),
            Ok((0, Vec::new())),
        ),
        (
            "largest Quarter Stream ID",
            "RFC 9297 Section 2.1",
            datagram_bytes(largest, &[]),
            Ok((largest, Vec::new())),
        ),
        (
            "non-minimal Quarter Stream ID",
            "RFC 9297 Section 1.1",
            cat(&[&varint_with_len(1, 2), &[0xab]]),
            Ok((4, vec![0xab])),
        ),
        (
            "Quarter Stream ID 2^60",
            "RFC 9297 Section 2.1",
            varint_bytes(MAX_QUARTER_STREAM_ID + 1),
            Err("quarterStreamIdTooLarge"),
        ),
        (
            "empty",
            "RFC 9297 Section 2.1",
            Vec::new(),
            Err("datagramTooShort"),
        ),
        (
            "truncated varint",
            "RFC 9297 Section 2.1",
            varint_with_len(1, 2)[..1].to_vec(),
            Err("datagramTooShort"),
        ),
    ];
    let mut list = Vec::new();
    for (name, section, encoded, expect) in cases {
        let parsed = Datagram::parse(&encoded);
        let got = parsed
            .map(|datagram| {
                let stream_id = datagram
                    .stream_id()
                    .expect("a parsed datagram has a stream");
                (stream_id, datagram.payload.to_vec())
            })
            .map_err(|error| error.name());
        assert_eq!(got, expect, "{name}");
        let expect = match parsed {
            Ok(datagram) => json!({
                "quarterStreamId": dec(datagram.quarter_stream_id),
                "streamId": dec(datagram.stream_id().expect("a parsed datagram has a stream")),
                "payload": hex(datagram.payload),
            }),
            Err(error) => h3_error(&error),
        };
        list.push(json!({
            "name": name,
            "section": section,
            "encoded": hex(&encoded),
            "expect": expect,
        }));
    }
    json!({ "cases": list })
}

/// The `h3Frames` section: RFC 9000 Section 16 integers, the RFC 9114 frame
/// codec and stream rules, and RFC 9297 capsules and datagrams.
fn h3_frames() -> Value {
    json!({
        "varints": h3_varints(),
        "reservedValues": h3_reserved_values(),
        "frames": h3_frame_cases(),
        "settings": h3_settings_cases(),
        "serverControlStream": h3_server_control_stream(),
        "streamTypes": h3_stream_types(),
        "uniStreams": h3_uni_streams(),
        "errorCodes": h3_error_codes(),
        "goaway": h3_goaway(),
        "capsules": h3_capsules(),
        "datagrams": h3_datagrams(),
    })
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
    document.insert("qpack".into(), qpack());
    document.insert("h3Frames".into(), h3_frames());

    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/vectors.json");
    let mut text =
        serde_json::to_string_pretty(&Value::Object(document)).expect("the document serializes");
    text.push('\n');
    fs::write(&path, text).expect("the vectors file is writable");
    println!("wrote {}", path.display());
}
