//! The body shape of the answers the server writes for errors, chosen through
//! `Handler::error_shape`: the RFC 9457 problem details object by default, the 1.x
//! JSON bodies when the handler asks for them. Covered: the router's 404 and 405,
//! the driver's 413 and 503, a handler's error, a misdirected request,
//! `Call::problem`, and a host's error written through `Exchange::write_error`;
//! the driver's 503 to a HEAD request without content, and a drain answer that
//! ends its connection through `Call::close_after_response`.

#![cfg(any(feature = "io-tokio", feature = "io-compio"))]

use std::cell::RefCell;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use zero_core::Error;
use zero_http::{
    serve, serve_with, Accept, Call, Config, ErrorShape, Exchange, ExportOptions, Handler,
    Prepared, Problem, PublishedView, Router, Workers,
};
use zero_http_types::{Method, StatusCode};
use zero_limits::Http1Limits;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    Hello,
    Stall,
    Auth,
    Limit,
    Overload,
    HostError,
    HostBare,
}

/// Answers in the shape it was built with, or leaves the default.
struct Shaped {
    shape: Option<ErrorShape>,
    router: Router<Route>,
    exchange: RefCell<Exchange>,
    view: PublishedView,
}

impl Handler for Shaped {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        match routed.descriptor {
            Route::Hello => {
                call.response().body(b"hello");
            }
            Route::Stall => std::future::pending::<()>().await,
            Route::Auth => return Err(Error::Auth("no token".to_owned())),
            Route::Limit => return Err(Error::Limit("the field is 3 bytes too long".to_owned())),
            Route::Overload => {
                call.problem(&Problem {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    code: "SERVICE_UNAVAILABLE",
                    detail: Some("Server is shutting down".to_owned()),
                });
                call.close_after_response();
            }
            Route::HostError | Route::HostBare => {
                let mut exchange = self.exchange.borrow_mut();
                exchange.release(false);
                call.export(
                    &mut exchange,
                    &self.view,
                    1,
                    false,
                    &ExportOptions::default(),
                );
                if routed.descriptor == Route::HostError {
                    exchange.write_error(
                        self.error_shape(),
                        StatusCode::NOT_FOUND,
                        "NOT_FOUND",
                        Some("nope"),
                        Some(br#"{"a":1}"#),
                    );
                } else {
                    exchange.write_error(
                        self.error_shape(),
                        StatusCode::new(418).unwrap(),
                        "TEAPOT",
                        None,
                        None,
                    );
                }
                exchange.seal();
                call.import(&mut exchange, |_, _| {});
            }
        }
        Ok(())
    }

    fn error_shape(&self) -> ErrorShape {
        self.shape.unwrap_or_default()
    }
}

/// Serves only the host `t`, as a TLS certificate for that name would.
struct OnlyT;

impl Accept for OnlyT {
    type Stream = zero_io::rt::TcpStream;

    fn accept(
        self: Rc<Self>,
        stream: zero_io::rt::TcpStream,
        _peer: SocketAddr,
    ) -> impl std::future::Future<Output = io::Result<Prepared<zero_io::rt::TcpStream>>> + 'static
    {
        std::future::ready(Ok(Prepared {
            stream,
            authorities: Some(Arc::from(vec![Box::from("t")])),
        }))
    }
}

fn start(shape: Option<ErrorShape>) -> Workers {
    let (config, make) = server(shape);
    serve(
        "127.0.0.1:0".parse().unwrap(),
        config,
        Arc::new(|_| {}),
        make,
    )
    .unwrap()
}

fn server(
    shape: Option<ErrorShape>,
) -> (
    Config,
    impl Fn(&zero_http::Worker) -> Shaped + Send + Sync + 'static,
) {
    let mut router = Router::new();
    router.route(Method::Get, "/hello", Route::Hello).unwrap();
    router.route(Method::Get, "/stall", Route::Stall).unwrap();
    router.route(Method::Get, "/auth", Route::Auth).unwrap();
    router.route(Method::Get, "/limit", Route::Limit).unwrap();
    router
        .route(Method::Get, "/overload", Route::Overload)
        .unwrap();
    router
        .route(Method::Get, "/host-error", Route::HostError)
        .unwrap();
    router
        .route(Method::Get, "/host-bare", Route::HostBare)
        .unwrap();
    router.route(Method::Post, "/hello", Route::Hello).unwrap();
    let config = Config {
        runtime: zero_rt::Config {
            io: zero_io::rt::Config {
                threads: 1,
                drain: Duration::from_secs(2),
                ..zero_io::rt::Config::default()
            },
        },
        limits: Http1Limits {
            max_body: 16,
            request_total: Duration::from_secs(1),
            ..Http1Limits::DEFAULT
        },
        server: None,
    };
    let make = move |_: &zero_http::Worker| Shaped {
        shape,
        router: router.clone(),
        exchange: RefCell::new(Exchange::default()),
        view: PublishedView::default(),
    };
    (config, make)
}

/// One parsed response: the status, the content type and the body.
#[derive(Debug)]
struct Reply {
    status: u16,
    content_type: Option<String>,
    allow: Option<String>,
    connection: Option<String>,
    body: String,
}

/// A response head: the status and the fields, names in lowercase.
struct Head {
    status: u16,
    fields: Vec<(String, String)>,
}

impl Head {
    fn field(&self, name: &str) -> Option<String> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    }
}

fn read_head(conn: &mut TcpStream) -> io::Result<Head> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if conn.read(&mut byte)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "closed in the head",
            ));
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8(head).unwrap();
    let mut lines = text.trim_end().split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let fields = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_owned())
        })
        .collect();
    Ok(Head { status, fields })
}

fn read_reply(conn: &mut TcpStream) -> io::Result<Reply> {
    let head = read_head(conn)?;
    let length: usize = head
        .field("content-length")
        .map_or(0, |value| value.parse().unwrap());
    let mut body = vec![0u8; length];
    conn.read_exact(&mut body)?;
    Ok(Reply {
        status: head.status,
        content_type: head.field("content-type"),
        allow: head.field("allow"),
        connection: head.field("connection"),
        body: String::from_utf8(body).unwrap(),
    })
}

/// Connect to the server with a ten-second read timeout.
fn connect(workers: &Workers) -> TcpStream {
    let conn = TcpStream::connect(workers.local_addr()).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    conn
}

/// Send a request head on a new connection, with `Host: t` added.
fn request(workers: &Workers, head: &str) -> Reply {
    raw(workers, &format!("{head}\r\nHost: t\r\n\r\n"))
}

/// Send exactly these bytes on a new connection and read the response.
fn raw(workers: &Workers, bytes: &str) -> Reply {
    let mut conn = connect(workers);
    conn.write_all(bytes.as_bytes()).unwrap();
    read_reply(&mut conn).unwrap()
}

/// The four core answers: 404 and 405 from the router, 413 and 503 from the driver.
fn core_answers(workers: &Workers) -> [Reply; 4] {
    [
        request(workers, "GET /missing HTTP/1.1"),
        request(workers, "DELETE /hello HTTP/1.1"),
        request(workers, "POST /hello HTTP/1.1\r\nContent-Length: 17"),
        request(workers, "GET /stall HTTP/1.1"),
    ]
}

#[test]
fn the_core_answers_404_405_413_and_503_in_the_problem_shape_by_default() {
    let workers = start(None);
    let [missing, refused, large, stalled] = core_answers(&workers);
    for (reply, status, body) in [
        (
            &missing,
            404,
            r#"{"type":"about:blank","title":"Not Found","status":404,"code":"not_found"}"#,
        ),
        (
            &refused,
            405,
            r#"{"type":"about:blank","title":"Method Not Allowed","status":405,"code":"method_not_allowed"}"#,
        ),
        (
            &large,
            413,
            r#"{"type":"about:blank","title":"Content Too Large","status":413,"code":"limit"}"#,
        ),
        (
            &stalled,
            503,
            r#"{"type":"about:blank","title":"Service Unavailable","status":503,"code":"timeout"}"#,
        ),
    ] {
        assert_eq!((reply.status, reply.body.as_str()), (status, body));
        assert_eq!(
            reply.content_type.as_deref(),
            Some("application/problem+json"),
            "{status}"
        );
    }
    assert_eq!(refused.allow.as_deref(), Some("GET, HEAD, POST, OPTIONS"));
    workers.stop().unwrap();
}

#[test]
fn the_core_answers_404_405_413_and_503_in_the_legacy_shape_when_the_handler_asks_for_it() {
    let workers = start(Some(ErrorShape::Legacy));
    let [missing, refused, large, stalled] = core_answers(&workers);
    for (reply, status, body) in [
        (&missing, 404, r#"{"error":"Not Found"}"#),
        (&refused, 405, r#"{"error":"Method Not Allowed"}"#),
        (&large, 413, r#"{"error":"Content Too Large"}"#),
        (&stalled, 503, r#"{"error":"Service Unavailable"}"#),
    ] {
        assert_eq!((reply.status, reply.body.as_str()), (status, body));
        assert_eq!(
            reply.content_type.as_deref(),
            Some("application/json"),
            "{status}"
        );
    }
    assert_eq!(
        refused.allow.as_deref(),
        Some("GET, HEAD, POST, OPTIONS"),
        "the shape changes the body, not the fields RFC 9110 Section 15.5.6 requires"
    );
    workers.stop().unwrap();
}

#[test]
fn a_handler_error_and_call_problem_take_the_handlers_shape() {
    let problem = start(Some(ErrorShape::Problem));
    let legacy = start(Some(ErrorShape::Legacy));
    for (workers, path, status, body) in [
        (
            &problem,
            "/auth",
            401,
            r#"{"type":"about:blank","title":"Unauthorized","status":401,"code":"auth"}"#,
        ),
        (&legacy, "/auth", 401, r#"{"error":"Unauthorized"}"#),
        (
            &problem,
            "/limit",
            413,
            r#"{"type":"about:blank","title":"Content Too Large","status":413,"code":"limit","detail":"the field is 3 bytes too long"}"#,
        ),
        (
            &legacy,
            "/limit",
            413,
            r#"{"error":"Content Too Large","message":"the field is 3 bytes too long"}"#,
        ),
        (
            &problem,
            "/overload",
            503,
            r#"{"type":"about:blank","title":"Service Unavailable","status":503,"code":"SERVICE_UNAVAILABLE","detail":"Server is shutting down"}"#,
        ),
        (
            &legacy,
            "/overload",
            503,
            r#"{"error":"Service Unavailable","message":"Server is shutting down"}"#,
        ),
    ] {
        let reply = request(workers, &format!("GET {path} HTTP/1.1"));
        assert_eq!(
            (reply.status, reply.body.as_str()),
            (status, body),
            "{path}"
        );
    }
    problem.stop().unwrap();
    legacy.stop().unwrap();
}

#[test]
fn a_misdirected_request_is_answered_421_in_the_handlers_shape() {
    for (shape, kind, body) in [
        (
            ErrorShape::Problem,
            "application/problem+json",
            r#"{"type":"about:blank","title":"Misdirected Request","status":421,"code":"misdirected"}"#,
        ),
        (
            ErrorShape::Legacy,
            "application/json",
            r#"{"error":"Misdirected Request"}"#,
        ),
    ] {
        let (config, make) = server(Some(shape));
        let workers = serve_with(
            "127.0.0.1:0".parse().unwrap(),
            config,
            Arc::new(|_| {}),
            make,
            |_| OnlyT,
        )
        .unwrap();
        assert_eq!(request(&workers, "GET /hello HTTP/1.1").body, "hello");
        let reply = raw(&workers, "GET /hello HTTP/1.1\r\nHost: other.test\r\n\r\n");
        assert_eq!((reply.status, reply.body.as_str()), (421, body));
        assert_eq!(reply.content_type.as_deref(), Some(kind));
        workers.stop().unwrap();
    }
}

#[test]
fn a_host_error_is_written_in_the_handlers_shape_with_its_code_message_and_details() {
    let problem = start(None);
    let legacy = start(Some(ErrorShape::Legacy));
    for (workers, path, status, kind, body) in [
        (
            &problem,
            "/host-error",
            404,
            "application/problem+json",
            r#"{"type":"about:blank","title":"Not Found","status":404,"code":"NOT_FOUND","detail":"nope","details":{"a":1}}"#,
        ),
        (
            &legacy,
            "/host-error",
            404,
            "application/json",
            r#"{"error":"nope","code":"NOT_FOUND","statusCode":404,"details":{"a":1}}"#,
        ),
        (
            &problem,
            "/host-bare",
            418,
            "application/problem+json",
            r#"{"type":"about:blank","status":418,"code":"TEAPOT"}"#,
        ),
        (
            &legacy,
            "/host-bare",
            418,
            "application/json",
            r#"{"error":"Error","code":"TEAPOT","statusCode":418}"#,
        ),
    ] {
        let reply = request(workers, &format!("GET {path} HTTP/1.1"));
        assert_eq!(
            (reply.status, reply.body.as_str()),
            (status, body),
            "{path}"
        );
        assert_eq!(reply.content_type.as_deref(), Some(kind), "{path}");
    }
    problem.stop().unwrap();
    legacy.stop().unwrap();
}

#[test]
fn the_server_must_not_send_content_in_a_response_to_head_even_when_a_stall_is_answered_503_section_9_3_2(
) {
    for shape in [None, Some(ErrorShape::Legacy)] {
        let workers = start(shape);
        let mut get = connect(&workers);
        let mut head = connect(&workers);
        get.write_all(b"GET /stall HTTP/1.1\r\nHost: t\r\n\r\n")
            .unwrap();
        head.write_all(b"HEAD /stall HTTP/1.1\r\nHost: t\r\n\r\n")
            .unwrap();
        let answered = read_reply(&mut get).unwrap();
        assert_eq!(answered.status, 503, "{shape:?}");
        let answer = read_head(&mut head).unwrap();
        assert_eq!(answer.status, 503, "{shape:?}");
        assert_eq!(
            answer.field("content-length"),
            Some(answered.body.len().to_string()),
            "{shape:?}: the length GET's answer carries"
        );
        let mut content = Vec::new();
        head.read_to_end(&mut content).unwrap();
        assert!(
            content.is_empty(),
            "{shape:?}: the 503 to HEAD carried content: {:?}",
            String::from_utf8_lossy(&content)
        );
        workers.stop().unwrap();
    }
}

#[test]
fn a_server_that_sends_the_close_option_closes_the_connection_after_that_response_section_9_6() {
    let workers = start(None);
    let mut conn = connect(&workers);
    conn.write_all(
        b"GET /overload HTTP/1.1\r\nHost: t\r\n\r\nGET /hello HTTP/1.1\r\nHost: t\r\n\r\n",
    )
    .unwrap();
    let reply = read_reply(&mut conn).unwrap();
    assert_eq!(reply.status, 503);
    assert_eq!(reply.connection.as_deref(), Some("close"));
    let mut rest = Vec::new();
    conn.read_to_end(&mut rest).unwrap();
    assert!(
        rest.is_empty(),
        "the request pipelined behind the closing response is not answered: {:?}",
        String::from_utf8_lossy(&rest)
    );
    let fresh = request(&workers, "GET /hello HTTP/1.1");
    assert_eq!(
        (fresh.status, fresh.body.as_str()),
        (200, "hello"),
        "only that connection closed"
    );
    workers.stop().unwrap();
}
