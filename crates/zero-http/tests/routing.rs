//! The router through the driver: method and path dispatch with parameters, the
//! automatic HEAD and OPTIONS answers, 404, 405 with `Allow`, 501, redirects, and
//! content negotiation.

#![cfg(feature = "io-tokio")]

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use zero_core::Error;
use zero_http::{serve, Call, Config, Handler, Router, Workers};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_mime::{negotiate, VARY_ACCEPT};

#[derive(Clone, Copy, Debug)]
enum Route {
    Hello,
    Users,
    CreateUser,
    User,
    File,
    Moved,
    Found,
    SeeOther,
    Temporary,
    Permanent,
    Negotiated,
    Admin,
}

struct App {
    router: Router<Route>,
}

impl App {
    fn new() -> Self {
        let mut router = Router::new();
        router.route(Method::Get, "/hello", Route::Hello).unwrap();
        router.route(Method::Get, "/users", Route::Users).unwrap();
        router
            .route(Method::Post, "/users", Route::CreateUser)
            .unwrap();
        router
            .route(Method::Get, "/users/:id", Route::User)
            .unwrap();
        router
            .route(Method::Get, "/files/:name", Route::File)
            .unwrap();
        router.route(Method::Get, "/moved", Route::Moved).unwrap();
        router.route(Method::Get, "/found", Route::Found).unwrap();
        router.route(Method::Get, "/see", Route::SeeOther).unwrap();
        router
            .route(Method::Post, "/temporary", Route::Temporary)
            .unwrap();
        router
            .route(Method::Post, "/permanent", Route::Permanent)
            .unwrap();
        router
            .route(Method::Get, "/negotiated", Route::Negotiated)
            .unwrap();
        let mut admin = Router::new();
        admin.route(Method::Get, "/", Route::Admin).unwrap();
        router.mount("/admin", admin).unwrap();
        App { router }
    }
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        match routed.descriptor {
            Route::Hello => {
                call.response().content_type(b"text/plain")?.body(b"hello");
            }
            Route::Users => {
                call.response().body(b"[]");
            }
            Route::CreateUser => {
                call.response().status(StatusCode::CREATED).body(b"made");
            }
            Route::User => {
                let (request, mut response) = call.parts();
                let id = request.param(0).unwrap_or(b"?").to_vec();
                response.body(b"user ").body(&id);
            }
            Route::File => {
                let (request, mut response) = call.parts();
                let mut name = Vec::new();
                request.param_decoded(0, &mut name)?;
                response.body(&name);
            }
            Route::Moved => {
                call.response()
                    .redirect(StatusCode::MOVED_PERMANENTLY, b"/hello")?;
            }
            Route::Found => {
                call.response().redirect(StatusCode::FOUND, b"/hello")?;
            }
            Route::SeeOther => {
                call.response().redirect(StatusCode::SEE_OTHER, b"/hello")?;
            }
            Route::Temporary => {
                call.response().redirect_preserving(false, b"/users")?;
            }
            Route::Permanent => {
                call.response().redirect_preserving(true, b"/users")?;
            }
            Route::Negotiated => {
                let available = ["application/json", "text/html"];
                let accept = call.request().header_id(HeaderName::Accept);
                match negotiate(accept, &available) {
                    Some(index) => {
                        let body: &[u8] = if index == 0 {
                            br#"{"ok":true}"#
                        } else {
                            b"<p>ok</p>"
                        };
                        let mut response = call.response();
                        response.content_type(available[index].as_bytes())?;
                        response.header_id(HeaderName::Vary, VARY_ACCEPT)?;
                        response.body(body);
                    }
                    None => {
                        let mut response = call.response();
                        response.status(StatusCode::NOT_ACCEPTABLE);
                        response.header_id(HeaderName::Vary, VARY_ACCEPT)?;
                        response.content_type(b"text/plain")?;
                        response.body(b"application/json, text/html");
                    }
                }
            }
            Route::Admin => {
                call.response().body(b"admin");
            }
        }
        Ok(())
    }
}

struct Server {
    workers: Option<Workers>,
    addr: SocketAddr,
}

impl Server {
    fn start() -> Self {
        let config = Config {
            runtime: zero_rt::Config {
                io: zero_io::rt::Config {
                    threads: 2,
                    drain: Duration::from_secs(2),
                    listen: zero_io::rt::ListenConfig {
                        handoff: std::env::var_os("ZERO_TEST_HANDOFF").is_some(),
                        ..zero_io::rt::ListenConfig::default()
                    },
                    ..zero_io::rt::Config::default()
                },
            },
            ..Config::default()
        };
        let workers = serve(
            "127.0.0.1:0".parse().unwrap(),
            config,
            Arc::new(|_| {}),
            |_| App::new(),
        )
        .unwrap();
        let addr = workers.local_addr();
        Server {
            workers: Some(workers),
            addr,
        }
    }

    fn connect(&self) -> TcpStream {
        let conn = TcpStream::connect(self.addr).unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        conn.set_nodelay(true).unwrap();
        conn
    }

    fn stop(mut self) -> io::Result<()> {
        self.workers.take().map_or(Ok(()), Workers::stop)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(workers) = self.workers.take() {
            let _ = workers.stop();
        }
    }
}

#[derive(Debug)]
struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn read_response(conn: &mut TcpStream, head_request: bool) -> io::Result<Response> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if conn.read(&mut byte)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "closed in the head",
            ));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8(head).unwrap();
    let mut lines = text.trim_end().split("\r\n");
    let status: u16 = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: Vec<(String, String)> = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_owned(), value.trim().to_owned())
        })
        .collect();
    let length: usize = if head_request || status < 200 || status == 204 || status == 304 {
        0
    } else {
        headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map_or(0, |(_, value)| value.parse().unwrap())
    };
    let mut body = vec![0u8; length];
    conn.read_exact(&mut body)?;
    Ok(Response {
        status,
        headers,
        body,
    })
}

fn send(conn: &mut TcpStream, method: &str, target: &str, extra: &str) -> Response {
    conn.write_all(format!("{method} {target} HTTP/1.1\r\nHost: t\r\n{extra}\r\n").as_bytes())
        .unwrap();
    read_response(conn, method == "HEAD").unwrap()
}

#[test]
fn routes_dispatch_on_method_and_path_with_the_parameters_captured() {
    let server = Server::start();
    let mut conn = server.connect();
    assert_eq!(send(&mut conn, "GET", "/hello", "").text(), "hello");
    assert_eq!(send(&mut conn, "GET", "/users/42", "").text(), "user 42");
    assert_eq!(
        send(&mut conn, "GET", "/users/42?x=1", "").text(),
        "user 42"
    );
    assert_eq!(
        send(&mut conn, "GET", "/files/a%2Fb%20c", "").text(),
        "a/b c"
    );
    assert_eq!(send(&mut conn, "GET", "/admin", "").text(), "admin");
    assert_eq!(
        send(&mut conn, "GET", "/admin/../hello", "").text(),
        "hello"
    );
    let created = send(&mut conn, "POST", "/users", "Content-Length: 0\r\n");
    assert_eq!((created.status, created.text()), (201, "made".to_owned()));
    let missing = send(&mut conn, "GET", "/nothing", "");
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.text(),
        r#"{"type":"about:blank","title":"Not Found","status":404,"code":"not_found"}"#
    );
    let bad = send(&mut conn, "GET", "/users/%zz", "");
    assert_eq!(bad.status, 400);
    assert!(bad.text().contains("\"code\":\"uri\""), "{}", bad.text());
    server.stop().unwrap();
}

/// Standards rows `routing-01`, `routing-02` and `routing-03` on the wire.
#[test]
fn a_missing_method_is_405_with_allow_and_an_unimplemented_token_is_501() {
    let server = Server::start();
    let mut conn = server.connect();
    let refused = send(&mut conn, "PUT", "/users", "Content-Length: 0\r\n");
    assert_eq!(refused.status, 405);
    assert_eq!(refused.header("allow"), Some("GET, HEAD, POST, OPTIONS"));
    assert!(refused.text().contains("\"status\":405"));
    let unknown = send(&mut conn, "PATCH", "/users", "Content-Length: 0\r\n");
    assert_eq!(unknown.status, 501);
    assert_eq!(
        send(&mut conn, "get", "/users", "").status,
        501,
        "case matters"
    );
    assert_eq!(send(&mut conn, "GET", "/users", "").text(), "[]");
    server.stop().unwrap();
}

/// Standards row `routing-05`: RFC 9110 Section 9.3.2.
#[test]
fn head_returns_the_same_header_fields_get_would_with_no_message_body() {
    let server = Server::start();
    let mut conn = server.connect();
    let get = send(&mut conn, "GET", "/hello", "");
    let head = send(&mut conn, "HEAD", "/hello", "");
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    let without_date = |response: &Response| -> Vec<(String, String)> {
        response
            .headers
            .iter()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("date"))
            .cloned()
            .collect()
    };
    assert_eq!(without_date(&head), without_date(&get));
    assert_eq!(head.header("content-length"), Some("5"));
    assert_eq!(
        send(&mut conn, "GET", "/hello", "").text(),
        "hello",
        "no body bytes were sent for HEAD, so the next response starts where it should"
    );
    server.stop().unwrap();
}

/// Standards row `routing-06`: RFC 9110 Sections 9.3.7 and 10.2.1.
#[test]
fn a_successful_options_response_with_no_content_sends_content_length_0_and_advertises_supported_methods_via_allow(
) {
    let server = Server::start();
    let mut conn = server.connect();
    let options = send(&mut conn, "OPTIONS", "/users", "");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("content-length"), Some("0"));
    assert_eq!(options.header("allow"), Some("GET, HEAD, POST, OPTIONS"));
    assert!(options.body.is_empty());
    let server_wide = send(&mut conn, "OPTIONS", "*", "");
    assert_eq!(server_wide.status, 200);
    assert_eq!(server_wide.header("content-length"), Some("0"));
    assert_eq!(send(&mut conn, "OPTIONS", "/nothing", "").status, 404);
    server.stop().unwrap();
}

/// Standards row `routing-14`: RFC 9110 Section 10.2.2.
#[test]
fn redirect_helpers_set_location_on_301_302_303_307_and_308() {
    let server = Server::start();
    let mut conn = server.connect();
    for (method, target, status, location) in [
        ("GET", "/moved", 301, "/hello"),
        ("GET", "/found", 302, "/hello"),
        ("GET", "/see", 303, "/hello"),
        ("POST", "/temporary", 307, "/users"),
        ("POST", "/permanent", 308, "/users"),
    ] {
        let response = send(&mut conn, method, target, "Content-Length: 0\r\n");
        assert_eq!(response.status, status, "{target}");
        assert_eq!(response.header("location"), Some(location), "{target}");
    }
    server.stop().unwrap();
}

/// Standards row `routing-15`: RFC 9110 Sections 15.4.8 and 15.4.9.
#[test]
fn status_307_and_308_are_the_codes_used_when_the_redirect_must_preserve_the_request_method_and_content(
) {
    let server = Server::start();
    let mut conn = server.connect();
    let temporary = send(&mut conn, "POST", "/temporary", "Content-Length: 0\r\n");
    assert_eq!(temporary.status, 307);
    let permanent = send(&mut conn, "POST", "/permanent", "Content-Length: 0\r\n");
    assert_eq!(permanent.status, 308);
    assert_eq!(
        send(&mut conn, "GET", "/moved", "").status,
        301,
        "the plain helper keeps its code"
    );
    server.stop().unwrap();
}

/// Standards row `routing-17`: RFC 9110 Section 15.5.7.
#[test]
fn when_no_representation_matches_accept_and_the_server_does_not_fall_back_the_response_is_406() {
    let server = Server::start();
    let mut conn = server.connect();
    let refused = send(&mut conn, "GET", "/negotiated", "Accept: image/png\r\n");
    assert_eq!(refused.status, 406);
    assert_eq!(
        refused.text(),
        "application/json, text/html",
        "the available representations are listed"
    );
    let zero = send(
        &mut conn,
        "GET",
        "/negotiated",
        "Accept: text/html;q=0, application/json;q=0\r\n",
    );
    assert_eq!(zero.status, 406);
    let html = send(&mut conn, "GET", "/negotiated", "Accept: text/html\r\n");
    assert_eq!(
        (html.status, html.header("content-type")),
        (200, Some("text/html"))
    );
    let any = send(&mut conn, "GET", "/negotiated", "");
    assert_eq!(
        (any.status, any.header("content-type")),
        (200, Some("application/json"))
    );
    server.stop().unwrap();
}

/// Standards row `routing-18`: RFC 9110 Section 12.5.5.
#[test]
fn a_response_selected_by_proactive_negotiation_includes_vary_naming_the_request_fields_used() {
    let server = Server::start();
    let mut conn = server.connect();
    let html = send(
        &mut conn,
        "GET",
        "/negotiated",
        "Accept: text/html;q=0.9, */*;q=0.1\r\n",
    );
    assert_eq!(html.header("vary"), Some("Accept"));
    assert_eq!(html.header("content-type"), Some("text/html"));
    let refused = send(&mut conn, "GET", "/negotiated", "Accept: image/png\r\n");
    assert_eq!(
        refused.header("vary"),
        Some("Accept"),
        "a 406 varies on Accept as well"
    );
    server.stop().unwrap();
}
