//! The connection driver end to end: pipelining order, concurrency of safe methods,
//! `Expect: 100-continue`, the limits and timeouts, the shutdown sequence, the error
//! registry, and a panicking handler.

#![cfg(feature = "io-tokio")]

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use zero_core::Error;
use zero_http::{serve, Call, Config, Event, Handler, Workers};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_io::seam::{Shutdown, Timer};
use zero_limits::Http1Limits;

/// The test application: routes on the path, logs every start and end.
struct App {
    log: Arc<Mutex<Vec<String>>>,
}

impl App {
    fn note(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }

    async fn route(&self, call: &mut Call<'_>, path: &str) -> Result<(), Error> {
        if let Some(rest) = path.strip_prefix("/sleep/") {
            let (millis, tag) = rest.split_once('/').unwrap_or((rest, "slept"));
            let millis: u64 = millis.parse().unwrap_or(0);
            call.core().sleep(Duration::from_millis(millis)).await;
            call.response().body(tag.as_bytes());
            return Ok(());
        }
        if let Some(kind) = path.strip_prefix("/err/") {
            return Err(match kind {
                "auth" => Error::Auth("no token".to_owned()),
                "upstream" => Error::Timeout("upstream"),
                "database" => Error::Timeout("database"),
                "unsupported" => Error::Unsupported("tls"),
                "limit" => Error::Limit("the field is 3 bytes too long".to_owned()),
                _ => Error::Io("disk on fire".to_owned()),
            });
        }
        if let Some(code) = path.strip_prefix("/status/") {
            let status = StatusCode::new(code.parse().unwrap_or(500)).unwrap();
            call.response().status(status).body(b"status");
            return Ok(());
        }
        match path {
            "/hello" => {
                call.response().content_type(b"text/plain")?.body(b"hello");
            }
            "/echo" | "/echo/small" | "/echo/large" => {
                let (request, mut response) = call.parts();
                if let Some(kind) = request.header_id(HeaderName::ContentType) {
                    response.content_type(kind)?;
                }
                let trailers = request.trailers().trim_ascii_end().to_vec();
                if !trailers.is_empty() {
                    response.header(b"X-Trailers", &trailers)?;
                }
                response.body(request.body());
            }
            "/headers" => {
                let (request, mut response) = call.parts();
                let echoed = request.header(b"x-echo").unwrap_or(b"none").to_vec();
                let version = format!("{:?}", request.version());
                response.header(b"X-Echoed", &echoed)?;
                response.header(b"X-Version", version.as_bytes())?;
                response.body(b"headers");
            }
            "/panic" => {
                if std::hint::black_box(true) {
                    panic!("handler fell over");
                }
            }
            "/panics" => {
                let count = call.worker().panics().to_string();
                call.response().body(count.as_bytes());
            }
            "/split" => {
                // A value with CR LF is refused at the accessor; nothing of it is sent.
                let refused = call
                    .response()
                    .header(b"X-Bad", b"a\r\nInjected: yes")
                    .is_err();
                call.response()
                    .body(if refused { b"refused" } else { b"sent" });
            }
            _ => {
                call.response()
                    .status(StatusCode::NOT_FOUND)
                    .body(b"not found");
            }
        }
        Ok(())
    }
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let path = String::from_utf8_lossy(call.request().path()).into_owned();
        let method = call.request().method_token().to_vec();
        let tag = format!("{} {path}", String::from_utf8_lossy(&method));
        self.note(format!("start {tag}"));
        let outcome = self.route(call, &path).await;
        self.note(format!("end {tag}"));
        outcome
    }

    fn body_limit(&self, method: Option<Method>, path: &[u8]) -> Option<u64> {
        self.note(format!(
            "limit {method:?} {}",
            String::from_utf8_lossy(path)
        ));
        match path {
            b"/echo/small" => Some(4),
            b"/echo/large" => Some(64),
            _ => None,
        }
    }
}

/// A running test server.
struct Server {
    workers: Option<Workers>,
    addr: SocketAddr,
    log: Arc<Mutex<Vec<String>>>,
    events: Arc<Mutex<Vec<Event>>>,
}

impl Server {
    fn start(limits: Http1Limits, drain: Duration) -> Self {
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
        let config = Config {
            runtime: zero_rt::Config {
                io: zero_io::rt::Config {
                    threads: 2,
                    drain,
                    listen: zero_io::rt::ListenConfig {
                        handoff: std::env::var_os("ZERO_TEST_HANDOFF").is_some(),
                        ..zero_io::rt::ListenConfig::default()
                    },
                    ..zero_io::rt::Config::default()
                },
            },
            limits,
            server: Some("zero-test".to_owned()),
        };
        let sink = Arc::clone(&events);
        let app_log = Arc::clone(&log);
        let workers = serve(
            "127.0.0.1:0".parse().unwrap(),
            config,
            Arc::new(move |event| sink.lock().unwrap().push(event)),
            move |_worker| App {
                log: Arc::clone(&app_log),
            },
        )
        .unwrap();
        let addr = workers.local_addr();
        Server {
            workers: Some(workers),
            addr,
            log,
            events,
        }
    }

    fn with_defaults() -> Self {
        Server::start(Http1Limits::DEFAULT, Duration::from_secs(2))
    }

    fn connect(&self) -> TcpStream {
        let conn = TcpStream::connect(self.addr).unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        conn.set_nodelay(true).unwrap();
        conn
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
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

/// One parsed response.
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

/// Read one response: the head, then `Content-Length` bytes of body.
fn read_response(conn: &mut TcpStream) -> io::Result<Response> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let count = conn.read(&mut byte)?;
        if count == 0 {
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
    let status_line = lines.next().unwrap();
    let status: u16 = status_line.split(' ').nth(1).unwrap().parse().unwrap();
    let headers: Vec<(String, String)> = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_owned(), value.trim().to_owned())
        })
        .collect();
    // RFC 9112 Section 6.3: a 1xx, 204 or 304 response has no body whatever its
    // fields say.
    let length: usize = if status < 200 || status == 204 || status == 304 {
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

/// Whether the peer closed: a read returns zero bytes.
fn closed(conn: &mut TcpStream) -> bool {
    let mut byte = [0u8; 1];
    matches!(conn.read(&mut byte), Ok(0))
}

fn get(conn: &mut TcpStream, path: &str) -> Response {
    conn.write_all(format!("GET {path} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes())
        .unwrap();
    read_response(conn).unwrap()
}

#[test]
fn a_request_is_answered_with_date_server_and_content_length() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let response = get(&mut conn, "/hello");
    assert_eq!(response.status, 200);
    assert_eq!(response.text(), "hello");
    assert_eq!(response.header("content-type"), Some("text/plain"));
    assert_eq!(response.header("content-length"), Some("5"));
    assert_eq!(response.header("server"), Some("zero-test"));
    assert!(response.header("connection").is_none(), "{response:?}");
    let date = response.header("date").unwrap();
    assert!(date.ends_with(" GMT") && date.len() == 29, "{date}");
    let again = get(&mut conn, "/missing");
    assert_eq!(again.status, 404, "the connection persisted");
    assert_eq!(get(&mut conn, "/split").text(), "refused");
    server.stop().unwrap();
}

/// Standards row `routing-11`: RFC 9110 Section 6.6.1.
#[test]
fn responses_include_a_date_header_field() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    for path in [
        "/hello",
        "/status/204",
        "/status/304",
        "/err/io",
        "/missing",
    ] {
        let response = get(&mut conn, path);
        let date = response
            .header("date")
            .unwrap_or_else(|| panic!("{path}: {response:?}"));
        assert_eq!(date.len(), 29, "{path}: {date}");
        assert!(date.ends_with(" GMT"));
    }
    server.stop().unwrap();
}

/// Standards row `h1-13`: RFC 9112 Section 9.3.2.
#[test]
fn responses_to_pipelined_requests_are_written_in_the_order_the_requests_were() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let started = Instant::now();
    conn.write_all(
        b"GET /sleep/150/first HTTP/1.1\r\nHost: t\r\n\r\n\
          GET /hello HTTP/1.1\r\nHost: t\r\n\r\n\
          GET /sleep/10/third HTTP/1.1\r\nHost: t\r\n\r\n",
    )
    .unwrap();
    let first = read_response(&mut conn).unwrap();
    let second = read_response(&mut conn).unwrap();
    let third = read_response(&mut conn).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(
        [first.text(), second.text(), third.text()],
        ["first", "hello", "third"]
    );
    assert!(
        elapsed < Duration::from_millis(300),
        "safe requests ran beside each other: {elapsed:?}"
    );
    let log = server.log();
    let position = |line: &str| log.iter().position(|entry| entry == line).unwrap();
    assert!(
        position("end GET /hello") < position("end GET /sleep/150/first"),
        "{log:?}"
    );
    server.stop().unwrap();
}

#[test]
fn an_unsafe_method_waits_for_every_earlier_response_and_later_ones_wait_for_it() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    conn.write_all(
        b"GET /sleep/100/a HTTP/1.1\r\nHost: t\r\n\r\n\
          POST /sleep/100/b HTTP/1.1\r\nHost: t\r\nContent-Length: 0\r\n\r\n\
          GET /sleep/10/c HTTP/1.1\r\nHost: t\r\n\r\n",
    )
    .unwrap();
    let bodies: Vec<String> = (0..3)
        .map(|_| read_response(&mut conn).unwrap().text())
        .collect();
    assert_eq!(bodies, ["a", "b", "c"]);
    let log = server.log();
    let position = |line: &str| log.iter().position(|entry| entry == line).unwrap();
    assert!(
        position("end GET /sleep/100/a") < position("start POST /sleep/100/b"),
        "{log:?}"
    );
    assert!(
        position("end POST /sleep/100/b") < position("start GET /sleep/10/c"),
        "{log:?}"
    );
    server.stop().unwrap();
}

#[test]
fn forty_pipelined_requests_are_answered_in_order_through_the_bounded_ring() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let mut burst = Vec::new();
    for index in 0..40 {
        burst.extend_from_slice(
            format!("GET /sleep/1/r{index} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes(),
        );
    }
    conn.write_all(&burst).unwrap();
    for index in 0..40 {
        assert_eq!(
            read_response(&mut conn).unwrap().text(),
            format!("r{index}")
        );
    }
    server.stop().unwrap();
}

#[test]
fn a_100_continue_is_sent_before_the_body_and_omitted_when_content_already_arrived() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    conn.write_all(
        b"POST /echo HTTP/1.1\r\nHost: t\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n",
    )
    .unwrap();
    let interim = read_response(&mut conn).unwrap();
    assert_eq!(interim.status, 100);
    conn.write_all(b"hello").unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        (response.status, response.text()),
        (200, "hello".to_owned())
    );
    assert_eq!(response.header("content-type"), Some("text/plain"));

    conn.write_all(
        b"POST /echo HTTP/1.1\r\nHost: t\r\nContent-Length: 3\r\nExpect: 100-continue\r\n\r\nabc",
    )
    .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!((response.status, response.text()), (200, "abc".to_owned()));

    conn.write_all(b"POST /echo HTTP/1.1\r\nHost: t\r\nContent-Length: 3\r\nExpect: fly\r\n\r\n")
        .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(response.status, 417);
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));
    server.stop().unwrap();
}

#[test]
fn a_chunked_body_is_buffered_with_its_trailers() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    conn.write_all(
        b"POST /echo HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n\
          4\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Sum: 9\r\n\r\n",
    )
    .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        (response.status, response.text()),
        (200, "Wikipedia".to_owned())
    );
    assert_eq!(response.header("x-trailers"), Some("X-Sum: 9"));
    assert_eq!(get(&mut conn, "/hello").text(), "hello");
    server.stop().unwrap();
}

#[test]
fn a_body_past_the_limit_is_refused_with_413_and_the_connection_closes() {
    let server = Server::start(
        Http1Limits {
            max_body: 16,
            ..Http1Limits::DEFAULT
        },
        Duration::from_secs(2),
    );
    let mut conn = server.connect();
    conn.write_all(b"POST /echo HTTP/1.1\r\nHost: t\r\nContent-Length: 17\r\n\r\n")
        .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(response.status, 413);
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));

    let mut conn = server.connect();
    conn.write_all(
        b"POST /echo HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n1\r\nx\r\n0\r\n\r\n",
    )
    .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        response.status, 413,
        "a chunked body is refused when it grows past"
    );
    assert!(closed(&mut conn));
    server.stop().unwrap();
}

#[test]
fn a_per_request_body_limit_from_the_handler_refuses_a_declared_content_length_over_it_with_413_before_the_content_is_read(
) {
    let server = Server::start(
        Http1Limits {
            max_body: 16,
            ..Http1Limits::DEFAULT
        },
        Duration::from_secs(2),
    );

    let mut conn = server.connect();
    conn.write_all(b"POST /echo/large HTTP/1.1\r\nHost: t\r\nContent-Length: 40\r\n\r\n")
        .unwrap();
    conn.write_all(&[b'x'; 40]).unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        (response.status, response.body.len()),
        (200, 40),
        "a route may take more than the server default"
    );
    conn.write_all(
        b"POST /echo/large HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n14\r\n0123456789abcdefghij\r\n0\r\n\r\n",
    )
    .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        (response.status, response.text()),
        (200, "0123456789abcdefghij".to_owned())
    );
    assert_eq!(get(&mut conn, "/hello").text(), "hello");

    let mut conn = server.connect();
    conn.write_all(
        b"POST /echo/small HTTP/1.1\r\nHost: t\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n",
    )
    .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        response.status, 413,
        "refused instead of a 100 Continue, so the client never sends the content"
    );
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));

    let mut conn = server.connect();
    conn.write_all(
        b"POST /echo/small HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n",
    )
    .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        response.status, 413,
        "a chunked body is refused once it passes the route's limit"
    );
    assert!(closed(&mut conn));

    let log = server.log();
    server.stop().unwrap();
    let asked: Vec<&str> = log
        .iter()
        .filter_map(|line| line.strip_prefix("limit "))
        .collect();
    assert_eq!(
        asked,
        [
            "Some(Post) /echo/large",
            "Some(Post) /echo/large",
            "Some(Post) /echo/small",
            "Some(Post) /echo/small",
        ],
        "asked once per request with content, never for one without"
    );
    assert!(
        !log.iter()
            .any(|line| line.starts_with("start POST /echo/small")),
        "a refused request never reaches the handler"
    );
}

#[test]
fn a_malformed_head_is_answered_400_and_the_input_after_it_is_discarded() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    conn.write_all(b"GET /hello HTTP/1.1\r\nHost: t\r\n\r\nGET / HTTP/1.1\r\nBad Name: x\r\n\r\nGET /hello HTTP/1.1\r\nHost: t\r\n\r\n").unwrap();
    assert_eq!(read_response(&mut conn).unwrap().status, 200);
    let rejected = read_response(&mut conn).unwrap();
    assert_eq!(rejected.status, 400);
    assert_eq!(rejected.header("connection"), Some("close"));
    assert!(closed(&mut conn), "the third request is not processed");
    server.stop().unwrap();
}

/// Standards row `runtime-08`: RFC 9110 Sections 15.5.9 and 15.6.4.
#[test]
fn a_request_that_times_out_before_the_handler_responds_receives_503_or_for_a_slow_client_body_408()
{
    let server = Server::start(
        Http1Limits {
            request_total: Duration::from_millis(200),
            body_read_idle: Duration::from_millis(200),
            header_read_timeout: Duration::from_millis(200),
            ..Http1Limits::DEFAULT
        },
        Duration::from_secs(2),
    );
    let mut conn = server.connect();
    let response = get(&mut conn, "/sleep/5000");
    assert_eq!(response.status, 503, "the handler did not answer in time");
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));

    let mut conn = server.connect();
    conn.write_all(b"POST /echo HTTP/1.1\r\nHost: t\r\nContent-Length: 10\r\n\r\nabc")
        .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(response.status, 408, "the body stalled");
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));

    let mut conn = server.connect();
    conn.write_all(b"GET /hello HTTP/1.1\r\nHost: t\r\nX-Slow")
        .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(response.status, 408, "the head stalled");
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));
    server.stop().unwrap();
}

/// Standards row `runtime-09`: RFC 9110 Section 15.6.5.
#[test]
fn a_proxied_upstream_timeout_is_reported_as_504() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let response = get(&mut conn, "/err/upstream");
    assert_eq!(response.status, 504);
    assert_eq!(
        response.header("content-type"),
        Some("application/problem+json")
    );
    assert_eq!(
        response.text(),
        r#"{"type":"about:blank","title":"Gateway Timeout","status":504,"code":"upstream_timeout"}"#
    );
    assert_eq!(get(&mut conn, "/err/database").status, 503);
    server.stop().unwrap();
}

#[test]
fn handler_errors_are_answered_from_the_registry_as_problem_details() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let auth = get(&mut conn, "/err/auth");
    assert_eq!(auth.status, 401);
    assert!(auth.text().contains(r#""status":401"#), "{auth:?}");
    assert!(auth.text().contains(r#""title":"Unauthorized""#));
    assert!(
        !auth.text().contains("no token"),
        "the message stays inside"
    );
    let limit = get(&mut conn, "/err/limit");
    assert_eq!(limit.status, 413);
    assert!(limit
        .text()
        .contains(r#""detail":"the field is 3 bytes too long""#));
    assert_eq!(get(&mut conn, "/err/unsupported").status, 501);
    let io = get(&mut conn, "/err/io");
    assert_eq!(io.status, 500);
    assert!(!io.text().contains("disk on fire"), "{io:?}");
    assert_eq!(
        get(&mut conn, "/hello").text(),
        "hello",
        "the connection persisted"
    );
    server.stop().unwrap();
}

/// Standards row `errors-01`: RFC 9457 Section 3.
#[test]
fn problem_responses_are_sent_with_media_type_application_problem_json() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    for path in ["/err/auth", "/err/io", "/err/limit", "/err/upstream"] {
        let response = get(&mut conn, path);
        assert_eq!(
            response.header("content-type"),
            Some("application/problem+json"),
            "{path}"
        );
        assert!(response.text().starts_with('{') && response.text().ends_with('}'));
    }
    server.stop().unwrap();
}

/// Standards row `errors-02`: RFC 9457 Section 3.1.2.
#[test]
fn the_status_member_when_present_equals_the_http_status_code_of_the_response() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    for (path, status) in [
        ("/err/auth", 401),
        ("/err/limit", 413),
        ("/err/unsupported", 501),
        ("/err/io", 500),
        ("/err/database", 503),
        ("/err/upstream", 504),
    ] {
        let response = get(&mut conn, path);
        assert_eq!(response.status, status, "{path}");
        assert!(
            response.text().contains(&format!("\"status\":{status}")),
            "{path}: {}",
            response.text()
        );
    }
    server.stop().unwrap();
}

/// Standards row `errors-03`: RFC 9457 Sections 3.1.1 and 4.2.1.
#[test]
fn when_type_is_absent_it_is_treated_as_about_blank_and_title_then_matches_the_status_code_reason_phrase(
) {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let response = get(&mut conn, "/err/unsupported");
    assert!(response.text().contains("\"type\":\"about:blank\""));
    assert!(
        response.text().contains("\"title\":\"Not Implemented\""),
        "{}",
        response.text()
    );
    server.stop().unwrap();
}

/// Standards row `errors-04`: RFC 9457 Section 3.1.3.
#[test]
fn title_is_stable_across_occurrences_of_the_same_problem_type() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let titles: Vec<String> = (0..3)
        .map(|_| {
            let text = get(&mut conn, "/err/auth").text();
            let start = text.find("\"title\":").unwrap();
            text[start..].split(',').next().unwrap().to_owned()
        })
        .collect();
    assert_eq!(titles[0], "\"title\":\"Unauthorized\"");
    assert!(titles.iter().all(|title| *title == titles[0]), "{titles:?}");
    server.stop().unwrap();
}

/// Standards row `errors-05`: RFC 9457 Section 3.1.4.
#[test]
fn detail_explains_the_occurrence_to_the_client_and_does_not_carry_debugging_output() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let limit = get(&mut conn, "/err/limit");
    assert!(
        limit
            .text()
            .contains("\"detail\":\"the field is 3 bytes too long\""),
        "{}",
        limit.text()
    );
    let io = get(&mut conn, "/err/io");
    assert!(!io.text().contains("detail"), "{}", io.text());
    assert!(!io.text().contains("disk on fire"));
    server.stop().unwrap();
}

/// Standards row `errors-06`: RFC 9457 Section 3.2.
#[test]
fn extension_members_such_as_errors_or_code_are_allowed_and_do_not_collide_with_the_standard_members(
) {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let response = get(&mut conn, "/err/auth");
    let text = response.text();
    assert!(text.contains("\"code\":\"auth\""), "{text}");
    for member in ["\"type\":", "\"title\":", "\"status\":", "\"code\":"] {
        assert_eq!(text.matches(member).count(), 1, "{member} once in {text}");
    }
    server.stop().unwrap();
}

/// Standards row `errors-07`: RFC 9457 Section 5.
#[test]
fn stack_traces_and_internal_implementation_details_are_never_serialized_into_production_error_responses(
) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let panicked = get(&mut conn, "/panic");
    assert_eq!(panicked.status, 500);
    let text = panicked.text();
    assert!(
        !text.contains("fell over") && !text.contains("driver.rs"),
        "{text}"
    );
    let io = get(&mut conn, "/err/io").text();
    assert!(!io.contains("disk on fire"), "{io}");
    server.stop().unwrap();
    std::panic::set_hook(previous);
}

#[test]
fn a_panicking_handler_yields_500_and_the_connection_and_core_stay_usable() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let server = Server::with_defaults();
    let mut conn = server.connect();
    let response = get(&mut conn, "/panic");
    assert_eq!(response.status, 500);
    assert_eq!(
        response.text(),
        r#"{"type":"about:blank","title":"Internal Server Error","status":500,"code":"panic"}"#
    );
    assert_eq!(
        get(&mut conn, "/hello").text(),
        "hello",
        "the connection serves on"
    );
    assert_eq!(get(&mut conn, "/panics").text(), "1", "the core counted it");
    let events = server.events.lock().unwrap().clone();
    assert!(events.iter().any(
        |event| matches!(event, Event::TaskPanic { message, .. } if message == "handler fell over")
    ));
    drop(events);
    server.stop().unwrap();
    std::panic::set_hook(previous);
}

#[test]
fn http_1_0_closes_unless_keep_alive_was_asked_and_the_request_cap_closes_too() {
    let server = Server::start(
        Http1Limits {
            max_requests_per_connection: 2,
            ..Http1Limits::DEFAULT
        },
        Duration::from_secs(2),
    );
    let mut conn = server.connect();
    conn.write_all(b"GET /headers HTTP/1.0\r\n\r\n").unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(response.header("x-version"), Some("Http10"));
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));

    let mut conn = server.connect();
    conn.write_all(b"GET /hello HTTP/1.0\r\nConnection: keep-alive\r\n\r\n")
        .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(response.header("connection"), Some("keep-alive"));
    let second = get(&mut conn, "/hello");
    assert_eq!(
        second.header("connection"),
        Some("close"),
        "the second request is the connection's last"
    );
    assert!(closed(&mut conn));

    let mut conn = server.connect();
    conn.write_all(b"GET /hello HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
        .unwrap();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));
    server.stop().unwrap();
}

#[test]
fn an_idle_connection_is_closed_after_the_keep_alive_timeout_without_a_response() {
    let server = Server::start(
        Http1Limits {
            idle_keep_alive: Duration::from_millis(200),
            ..Http1Limits::DEFAULT
        },
        Duration::from_secs(2),
    );
    let mut conn = server.connect();
    assert_eq!(get(&mut conn, "/hello").status, 200);
    let started = Instant::now();
    assert!(closed(&mut conn), "closed with nothing written");
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(150) && waited < Duration::from_secs(5),
        "{waited:?}"
    );
    server.stop().unwrap();
}

/// Standards row `runtime-03`: RFC 9112 Section 9.6.
#[test]
fn while_draining_http_1_1_responses_carry_connection_close() {
    let server = Server::with_defaults();
    let mut conn = server.connect();
    conn.write_all(b"GET /sleep/300/drained HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    server.workers.as_ref().unwrap().shutdown_handle().request();
    let response = read_response(&mut conn).unwrap();
    assert_eq!(
        (response.status, response.text()),
        (200, "drained".to_owned())
    );
    assert_eq!(response.header("connection"), Some("close"));
    assert!(closed(&mut conn));
    server.stop().unwrap();
}

/// Standards row `runtime-02`: the Node `http.Server` shutdown order.
#[test]
fn shutdown_calls_server_close_to_stop_accepting_then_closeidleconnections_then_closeallconnections_after_the_grace_timeout(
) {
    let server = Server::start(Http1Limits::DEFAULT, Duration::from_millis(400));
    let addr = server.addr;
    let mut idle = server.connect();
    assert_eq!(get(&mut idle, "/hello").status, 200);
    let mut busy = server.connect();
    busy.write_all(b"GET /sleep/5000/late HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let started = Instant::now();
    let stopped = std::thread::spawn(move || server.stop());
    assert!(closed(&mut idle), "the idle connection closes at once");
    let idle_closed = started.elapsed();
    assert!(idle_closed < Duration::from_millis(300), "{idle_closed:?}");
    assert!(
        closed(&mut busy),
        "the busy connection is closed at the grace deadline without a response"
    );
    let busy_closed = started.elapsed();
    assert!(
        busy_closed >= Duration::from_millis(350) && busy_closed < Duration::from_secs(3),
        "{busy_closed:?}"
    );
    stopped.join().unwrap().unwrap();
    assert!(
        TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err(),
        "the listeners are closed"
    );
}
