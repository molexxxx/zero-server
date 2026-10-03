//! A request exported to an exchange and imported back, end to end: every part of
//! the request survives the move and the response goes out as a handler's would;
//! the published view matches the exchange; a miss reaches the miss route with the
//! core's status and `Allow`; a warm round trip allocates nothing; the body's
//! charge moves from the core's budget to the exchange for as long as the lease
//! lasts, import returns the response octets the exchange counted, and what a
//! handler leases pauses accepts; an external body leaves as one slice and is
//! released after the write.

#![cfg(any(feature = "io-tokio", feature = "io-compio"))]

use std::cell::{Cell, RefCell};
use std::io::{self, IoSlice, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use std::time::{Duration, Instant};

use zero_core::{Error, OwnedBuf};
use zero_date::Decimal;
use zero_http::exchange::{
    BODY_KEEP, METHOD_OTHER, VIEW_EXPECT_CONTINUE, VIEW_HEAD_AS_GET, VIEW_KEEP_ALIVE, VIEW_QUERY,
    VIEW_SECURE, VIEW_UPGRADE,
};
use zero_http::{
    serve, serve_with, Accept, Action, Call, Config, Exchange, ExportOptions, ExternalBody,
    Handler, HostSpan, Prepared, PublishedView, Request, Router, ViewSnapshot, Workers,
};
use zero_http_types::{HeaderName, Method, StatusCode};
use zero_io::pool::Pool;
use zero_io::seam::{Leased, Stream};
use zero_limits::Http1Limits;
use zero_sys::alloc::Counting;

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// Start a server on `threads` cores with a request-memory budget.
fn start<H, M>(threads: usize, budget: Option<u64>, make: M) -> Workers
where
    H: Handler,
    M: Fn(&zero_http::Worker) -> H + Send + Sync + 'static,
{
    start_with(config(threads, budget), make)
}

fn start_with<H, M>(config: Config, make: M) -> Workers
where
    H: Handler,
    M: Fn(&zero_http::Worker) -> H + Send + Sync + 'static,
{
    serve(
        "127.0.0.1:0".parse().unwrap(),
        config,
        Arc::new(|_| {}),
        make,
    )
    .unwrap()
}

fn config(threads: usize, budget: Option<u64>) -> Config {
    let mut io = zero_io::rt::Config {
        threads,
        drain: Duration::from_secs(2),
        ..zero_io::rt::Config::default()
    };
    if let Some(budget) = budget {
        io.memory_budget = budget;
    }
    Config {
        runtime: zero_rt::Config { io },
        limits: Http1Limits::DEFAULT,
        server: None,
    }
}

fn connect(workers: &Workers) -> TcpStream {
    let conn = TcpStream::connect(workers.local_addr()).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    conn.set_nodelay(true).unwrap();
    conn
}

/// One parsed response.
#[derive(Debug)]
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
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

/// Read one response: the head, then `Content-Length` bytes of body unless the
/// request was HEAD or the status has none (RFC 9112 Section 6.3).
fn read_reply(conn: &mut TcpStream, head_request: bool) -> io::Result<Reply> {
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
    Ok(Reply {
        status,
        headers,
        body,
    })
}

fn send(conn: &mut TcpStream, request: &[u8], head_request: bool) -> Reply {
    conn.write_all(request).unwrap();
    read_reply(conn, head_request).unwrap()
}

fn get(conn: &mut TcpStream, path: &str) -> Reply {
    send(
        conn,
        format!("GET {path} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes(),
        false,
    )
}

/// Poll `done` until it holds or ten seconds pass.
fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    Item,
    Plain,
    Upload,
    Release,
    External,
    Miss,
    Go,
}

fn router() -> Router<Route> {
    let mut router = Router::new();
    router
        .route(Method::Get, "/items/:id/:name", Route::Item)
        .unwrap();
    router
        .route(Method::Post, "/items/:id/:name", Route::Item)
        .unwrap();
    router.route(Method::Get, "/plain", Route::Plain).unwrap();
    router
        .route(Method::Post, "/upload", Route::Upload)
        .unwrap();
    router
        .route(Method::Get, "/release", Route::Release)
        .unwrap();
    router
        .route(Method::Get, "/external", Route::External)
        .unwrap();
    router.route(Method::Get, "/go", Route::Go).unwrap();
    router
}

/// Everything a handler can read of a request, owned.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Seen {
    method: Option<Method>,
    method_token: Vec<u8>,
    target: Vec<u8>,
    path: Vec<u8>,
    query: Option<Vec<u8>>,
    authority: Option<Vec<u8>>,
    version: String,
    headers: Vec<(Vec<u8>, Vec<u8>)>,
    host: Option<Vec<u8>>,
    body: Vec<u8>,
    trailers: Vec<u8>,
    route_path: Vec<u8>,
    params: Vec<Vec<u8>>,
    decoded: Vec<u8>,
    peer: Option<SocketAddr>,
    secure: bool,
}

impl Seen {
    fn of(request: &Request<'_>) -> Self {
        let mut decoded = Vec::new();
        let _ = request.param_decoded(1, &mut decoded);
        Seen {
            method: request.method(),
            method_token: request.method_token().to_vec(),
            target: request.target().to_vec(),
            path: request.path().to_vec(),
            query: request.query().map(<[u8]>::to_vec),
            authority: request.authority().map(<[u8]>::to_vec),
            version: format!("{:?}", request.version()),
            headers: request
                .headers()
                .map(|(name, value)| (name.to_vec(), value.to_vec()))
                .collect(),
            host: request.header_id(HeaderName::Host).map(<[u8]>::to_vec),
            body: request.body().to_vec(),
            trailers: request.trailers().to_vec(),
            route_path: request.route_path().to_vec(),
            params: request.params().map(<[u8]>::to_vec).collect(),
            decoded,
            peer: request.peer(),
            secure: request.is_secure(),
        }
    }
}

/// What the round-trip handler saw of one request.
#[derive(Debug)]
struct Observed {
    before: Seen,
    after: Seen,
    flags: u16,
    head_len: u32,
    trailer: Option<Vec<u8>>,
    other_trailer: Option<Vec<u8>>,
    client: Option<SocketAddr>,
    counted: u64,
    counted_before_import: u64,
    imported: u64,
    counted_after_import: u64,
    mismatches: Vec<String>,
    record_method: Option<Method>,
    record_version: String,
    record_head_gone: bool,
}

/// Every way the snapshot differs from the exchange it was published for.
fn compare(view: &ViewSnapshot, exchange: &Exchange, head: bool) -> Vec<String> {
    let request = exchange.request();
    let at = |span: HostSpan| view.head.wrapping_add(span.start as usize);
    let same = |span: HostSpan, bytes: &[u8]| {
        at(span) == bytes.as_ptr() && span.len as usize == bytes.len()
    };
    let path_len = request.path().len() - request.query().map_or(0, |query| query.len() + 1);
    let headers: Vec<(&[u8], &[u8])> = request.headers().collect();
    let checks = [
        (
            "method token",
            same(view.method_token, request.method_token()),
        ),
        ("target", same(view.target, request.target())),
        (
            "path",
            at(view.path) == request.path().as_ptr() && view.path.len as usize == path_len,
        ),
        (
            "query",
            match (view.query, request.query()) {
                (Some(span), Some(query)) => same(span, query),
                (None, None) => true,
                _ => false,
            },
        ),
        (
            "authority",
            match (view.authority, request.authority()) {
                (Some(span), Some(authority)) => same(span, authority),
                (None, None) => true,
                _ => false,
            },
        ),
        (
            "method",
            view.method == request.method().map_or(METHOD_OTHER, Method::id),
        ),
        (
            "version",
            view.version
                == if format!("{:?}", request.version()) == "Http10" {
                    10
                } else {
                    11
                },
        ),
        (
            "query flag",
            (view.flags & VIEW_QUERY != 0) == request.query().is_some(),
        ),
        ("head flag", (view.flags & VIEW_HEAD_AS_GET != 0) == head),
        (
            "secure flag",
            (view.flags & VIEW_SECURE != 0) == request.is_secure(),
        ),
        ("upgrade flag", view.flags & VIEW_UPGRADE == 0),
        (
            "field count",
            view.field_count as usize == headers.len()
                && view.field_count as usize == exchange.fields().len(),
        ),
        ("field table", view.fields == exchange.fields().as_ptr()),
        (
            "field spans",
            exchange
                .fields()
                .iter()
                .zip(&headers)
                .all(|(field, (name, value))| same(field.name, name) && same(field.value, value)),
        ),
        (
            "field ids",
            exchange
                .fields()
                .iter()
                .zip(&headers)
                .all(|(field, (name, _))| field.header() == HeaderName::parse(name)),
        ),
        (
            "route path",
            view.route_path == request.route_path().as_ptr()
                && view.route_path_len as usize == request.route_path().len(),
        ),
        (
            "parameters",
            view.param_count as usize == request.params().count(),
        ),
        (
            "body",
            view.body == request.body().as_ptr() && view.body_len as usize == request.body().len(),
        ),
        ("route", view.route == exchange.route()),
        (
            "miss",
            view.miss_status == exchange.miss().map_or(0, |miss| miss.status.as_u16())
                && view.allow == exchange.miss().map_or(0, |miss| miss.allow_mask()),
        ),
        ("peer", view.peer == request.peer()),
        ("client", view.client == exchange.client()),
    ];
    checks
        .iter()
        .filter(|(_, ok)| !ok)
        .map(|(what, _)| (*what).to_owned())
        .collect()
}

/// Exports every routed request, reads it back from the exchange, answers through
/// the exchange and imports.
struct RoundTrip {
    router: Router<Route>,
    options: ExportOptions,
    exchange: RefCell<Exchange>,
    view: PublishedView,
    log: Arc<Mutex<Vec<Observed>>>,
}

impl RoundTrip {
    fn new(log: Arc<Mutex<Vec<Observed>>>) -> Self {
        let client = |request: &Request<'_>| {
            std::str::from_utf8(request.header(b"x-client")?)
                .ok()?
                .parse()
                .ok()
        };
        RoundTrip {
            router: router(),
            options: ExportOptions {
                trailers: vec![Box::from(&b"X-Checksum"[..])],
                client: Some(Arc::new(client)),
            },
            exchange: RefCell::new(Exchange::default()),
            view: PublishedView::default(),
            log,
        }
    }
}

impl Handler for RoundTrip {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        let before = Seen::of(&call.request());
        let mut exchange = self.exchange.borrow_mut();
        exchange.release(false);
        call.export(&mut exchange, &self.view, 7, routed.head, &self.options);
        let view = self.view.snapshot();
        let record = call.request();
        let mut observed = Observed {
            before,
            after: Seen::of(&exchange.request()),
            flags: view.flags,
            head_len: view.head_len,
            trailer: exchange.trailer(b"x-checksum").map(<[u8]>::to_vec),
            other_trailer: exchange.trailer(b"x-other").map(<[u8]>::to_vec),
            client: exchange.client(),
            counted: exchange.counted(),
            counted_before_import: 0,
            imported: 0,
            counted_after_import: 0,
            mismatches: compare(&view, &exchange, routed.head),
            record_method: record.method(),
            record_version: format!("{:?}", record.version()),
            record_head_gone: record.target().is_empty() && record.body().is_empty(),
        };
        let body = exchange.request().body().to_vec();
        exchange
            .response()
            .status(StatusCode::CREATED)
            .header(b"X-Route", b"7")?
            .content_type(b"text/plain")?
            .body(b"echo:")
            .body(&body);
        exchange.count(u64::try_from(b"echo:".len() + body.len()).unwrap());
        observed.counted_before_import = exchange.counted();
        observed.imported = call.import(&mut exchange, |request, response| {
            let _ = response.header(b"X-After-Path", request.path());
        });
        observed.counted_after_import = exchange.counted();
        self.log.lock().unwrap().push(observed);
        Ok(())
    }
}

#[test]
fn an_export_and_import_round_trip_keeps_every_span_field_parameter_body_and_trailer() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let handler_log = Arc::clone(&log);
    let workers = start(1, None, move |_| RoundTrip::new(Arc::clone(&handler_log)));
    let mut conn = connect(&workers);
    let reply = send(
        &mut conn,
        b"POST /items/42/caf%C3%A9?x=1&y=2 HTTP/1.1\r\nHost: t:8080\r\nX-One: 1\r\n\
          X-Client: 198.51.100.4:9\r\nAccept: */*\r\nTransfer-Encoding: chunked\r\n\r\n\
          5\r\nhello\r\n6\r\n world\r\n0\r\nX-Checksum: abc\r\nX-Other: no\r\n\r\n",
        false,
    );
    assert_eq!(reply.status, 201, "{reply:?}");
    assert_eq!(reply.text(), "echo:hello world");
    assert_eq!(reply.header("x-route"), Some("7"));
    assert_eq!(
        reply.header("x-after-path"),
        Some("/items/42/caf%C3%A9?x=1&y=2"),
        "the policy hook reads the request from the exchange"
    );
    assert_eq!(reply.header("content-type"), Some("text/plain"));

    let observed = log.lock().unwrap().pop().unwrap();
    assert_eq!(observed.before, observed.after);
    assert_eq!(
        observed.after.params,
        [b"42".to_vec(), b"caf%C3%A9".to_vec()]
    );
    assert_eq!(observed.after.decoded, "café".as_bytes());
    assert_eq!(observed.after.body, b"hello world");
    assert_eq!(observed.after.headers.len(), 5);
    assert_eq!(observed.after.host.as_deref(), Some(&b"t:8080"[..]));
    assert_eq!(observed.after.query.as_deref(), Some(&b"x=1&y=2"[..]));
    assert!(observed.after.trailers.starts_with(b"X-Checksum: abc\r\n"));
    assert_eq!(observed.trailer.as_deref(), Some(&b"abc"[..]));
    assert_eq!(
        observed.other_trailer, None,
        "a trailer off the allow list is not offered"
    );
    assert_eq!(observed.client, Some("198.51.100.4:9".parse().unwrap()));
    assert_eq!(observed.counted, 11, "the body's charge moved with it");
    assert_eq!(
        observed.counted_before_import,
        11 + 16,
        "the host counted its 16 response octets on the exchange"
    );
    assert_eq!(
        observed.imported, 16,
        "import returns the response octets it took off the exchange"
    );
    assert_eq!(
        observed.counted_after_import, 11,
        "the body's charge stays on the exchange until release"
    );
    assert!(observed.mismatches.is_empty(), "{:?}", observed.mismatches);
    assert_eq!(
        observed.flags & (VIEW_KEEP_ALIVE | VIEW_EXPECT_CONTINUE),
        VIEW_KEEP_ALIVE
    );
    assert_eq!(
        observed.record_method,
        Some(Method::Post),
        "parsed head intact"
    );
    assert_eq!(observed.record_version, "Http11");
    assert!(observed.record_head_gone, "the head moved, not copied");

    assert_eq!(
        get(&mut conn, "/items/1/a").text(),
        "echo:",
        "the connection persisted"
    );
    let observed = log.lock().unwrap().pop().unwrap();
    assert_eq!(
        observed.client, observed.after.peer,
        "no rule answer: the peer"
    );
    assert!(observed.after.peer.is_some());
    workers.stop().unwrap();
}

#[test]
fn head_suppression_http_1_0_keep_alive_and_100_continue_are_serialized_correctly_after_a_round_trip(
) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let handler_log = Arc::clone(&log);
    let workers = start(1, None, move |_| RoundTrip::new(Arc::clone(&handler_log)));
    let mut conn = connect(&workers);

    let head = send(
        &mut conn,
        b"HEAD /items/1/a HTTP/1.1\r\nHost: t\r\n\r\n",
        true,
    );
    assert_eq!(head.status, 201);
    assert_eq!(head.header("content-length"), Some("5"));
    let observed = log.lock().unwrap().pop().unwrap();
    assert_eq!(observed.flags & VIEW_HEAD_AS_GET, VIEW_HEAD_AS_GET);
    assert!(observed.mismatches.is_empty(), "{:?}", observed.mismatches);
    assert_eq!(
        get(&mut conn, "/items/2/b").text(),
        "echo:",
        "no body followed the HEAD response"
    );

    let mut old = connect(&workers);
    for _ in 0..2 {
        let reply = send(
            &mut old,
            b"GET /items/3/c HTTP/1.0\r\nHost: t\r\nConnection: keep-alive\r\n\r\n",
            false,
        );
        assert_eq!(reply.status, 201);
        assert_eq!(reply.header("connection"), Some("keep-alive"));
        assert_eq!(reply.text(), "echo:");
    }
    let observed = log.lock().unwrap().pop().unwrap();
    assert_eq!(observed.after.version, "Http10");
    assert_eq!(
        observed.flags & (VIEW_KEEP_ALIVE | VIEW_EXPECT_CONTINUE),
        VIEW_KEEP_ALIVE
    );
    assert!(observed.mismatches.is_empty(), "{:?}", observed.mismatches);

    let mut expecting = connect(&workers);
    expecting
        .write_all(
            b"POST /items/4/d HTTP/1.1\r\nHost: t\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n",
        )
        .unwrap();
    let interim = read_reply(&mut expecting, false).unwrap();
    assert_eq!(interim.status, 100);
    let reply = send(&mut expecting, b"abcde", false);
    assert_eq!((reply.status, reply.text()), (201, "echo:abcde".to_owned()));
    let observed = log.lock().unwrap().pop().unwrap();
    assert_eq!(
        observed.flags & (VIEW_KEEP_ALIVE | VIEW_EXPECT_CONTINUE),
        VIEW_KEEP_ALIVE | VIEW_EXPECT_CONTINUE
    );
    assert!(observed.mismatches.is_empty(), "{:?}", observed.mismatches);
    assert_eq!(
        get(&mut expecting, "/items/5/e").text(),
        "echo:",
        "the connection persisted"
    );
    workers.stop().unwrap();
}

/// The length of the head at the start of a request: through the empty line.
fn head_len(request: &[u8]) -> u32 {
    let end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    u32::try_from(end + 4).unwrap()
}

/// Check what `compare` leaves out: the head length and the connection flags.
fn check_head_and_flags(observed: &Observed, request: &[u8], keep_alive: bool) {
    let text = String::from_utf8_lossy(request);
    assert!(
        observed.mismatches.is_empty(),
        "{text}: {:?}",
        observed.mismatches
    );
    assert_eq!(observed.head_len, head_len(request), "{text}");
    let expected = if keep_alive { VIEW_KEEP_ALIVE } else { 0 };
    assert_eq!(
        observed.flags & (VIEW_KEEP_ALIVE | VIEW_EXPECT_CONTINUE),
        expected,
        "{text}: keep-alive set only when the connection persists, expect-continue clear"
    );
}

#[test]
fn the_published_snapshot_equals_the_exchange() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let handler_log = Arc::clone(&log);
    let workers = start(1, None, move |_| RoundTrip::new(Arc::clone(&handler_log)));
    let mut conn = connect(&workers);
    for (request, head_request) in [
        (&b"GET /items/1/a HTTP/1.1\r\nHost: t\r\n\r\n"[..], false),
        (
            b"GET /items/1/a?x=1&y HTTP/1.1\r\nHost: t\r\nX-A: 1\r\nX-B: 2\r\n\r\n",
            false,
        ),
        (b"GET /items/1/a? HTTP/1.1\r\nHost: t\r\n\r\n", false),
        (
            b"GET http://t:80/items/2/b?z HTTP/1.1\r\nHost: t\r\n\r\n",
            false,
        ),
        (
            b"HEAD /items/3/c HTTP/1.1\r\nHost: t\r\nAccept: */*\r\n\r\n",
            true,
        ),
        (
            b"GET /items/4/d HTTP/1.0\r\nConnection: keep-alive\r\n\r\n",
            false,
        ),
        (
            b"POST /items/5/e HTTP/1.1\r\nHost: t\r\nContent-Length: 3\r\n\r\nabc",
            false,
        ),
    ] {
        let reply = send(&mut conn, request, head_request);
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(request));
        let observed = log.lock().unwrap().pop().unwrap();
        check_head_and_flags(&observed, request, true);
    }
    for request in [
        &b"GET /items/6/f HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n"[..],
        b"GET /items/7/g HTTP/1.0\r\n\r\n",
    ] {
        let mut once = connect(&workers);
        let reply = send(&mut once, request, false);
        assert_eq!(reply.status, 201, "{}", String::from_utf8_lossy(request));
        assert_eq!(reply.header("connection"), Some("close"));
        let observed = log.lock().unwrap().pop().unwrap();
        check_head_and_flags(&observed, request, false);
    }
    let observed = {
        send(
            &mut conn,
            b"GET http://t:80/items/2/b?z HTTP/1.1\r\nHost: t\r\n\r\n",
            false,
        );
        log.lock().unwrap().pop().unwrap()
    };
    assert_eq!(observed.after.path, b"/items/2/b?z");
    assert_eq!(observed.after.authority.as_deref(), Some(&b"t:80"[..]));
    assert_eq!(observed.after.query.as_deref(), Some(&b"z"[..]));
    workers.stop().unwrap();
}

/// Routes with a miss route, exports, and reports what the exchange and the view say.
struct Missing {
    router: Router<Route>,
    exchange: RefCell<Exchange>,
    view: PublishedView,
}

impl Handler for Missing {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let miss = (call.request().header(b"x-miss").is_some()).then_some(Route::Miss);
        let Some(routed) = call.route_or_miss(&self.router, miss) else {
            return Ok(());
        };
        let mut exchange = self.exchange.borrow_mut();
        exchange.release(false);
        call.export(
            &mut exchange,
            &self.view,
            routed.descriptor as u32,
            routed.head,
            &ExportOptions::default(),
        );
        let view = self.view.snapshot();
        let mismatches = compare(&view, &exchange, routed.head).join(",");
        let route_path = exchange.request().route_path().to_vec();
        let status = routed
            .miss
            .map_or(0, |miss| miss.status.as_u16())
            .to_string();
        let mask = routed.miss.map_or(0, |miss| miss.allow_mask()).to_string();
        let mut response = exchange.response();
        response.header(b"X-Miss-Status", status.as_bytes())?;
        response.header(b"X-Allow-Mask", mask.as_bytes())?;
        response.header(b"X-View-Status", view.miss_status.to_string().as_bytes())?;
        response.header(b"X-View-Allow", view.allow.to_string().as_bytes())?;
        response.header(b"X-Route-Path", &route_path)?;
        response.header(b"X-Mismatches", format!("[{mismatches}]").as_bytes())?;
        call.import(&mut exchange, |_, _| {});
        Ok(())
    }
}

#[test]
fn route_or_miss_sends_a_miss_to_the_miss_route_with_the_status_and_allow_the_core_would_have_answered(
) {
    let workers = start(1, None, |_| Missing {
        router: router(),
        exchange: RefCell::new(Exchange::default()),
        view: PublishedView::default(),
    });
    let mut conn = connect(&workers);
    let item_mask = [Method::Get, Method::Head, Method::Post, Method::Options]
        .iter()
        .fold(0u16, |mask, method| mask | 1 << method.id());
    for (request, status, mask, route_path) in [
        ("GET /nowhere/ HTTP/1.1", 404, 0, "/nowhere/"),
        ("DELETE /items/1/a HTTP/1.1", 405, item_mask, "/items/1/a"),
        ("OPTIONS /items/1/a HTTP/1.1", 200, item_mask, "/items/1/a"),
        ("PURGE /items/1/a HTTP/1.1", 501, 0, "/items/1/a"),
    ] {
        let reply = send(
            &mut conn,
            format!("{request}\r\nHost: t\r\nX-Miss: 1\r\n\r\n").as_bytes(),
            false,
        );
        assert_eq!(reply.status, 200, "{request}: answered by the miss route");
        assert_eq!(
            reply.header("x-miss-status"),
            Some(&*status.to_string()),
            "{request}"
        );
        assert_eq!(
            reply.header("x-view-status"),
            Some(&*status.to_string()),
            "{request}"
        );
        assert_eq!(
            reply.header("x-allow-mask"),
            Some(&*mask.to_string()),
            "{request}: the set the core's 405 lists in Allow (GET, HEAD, POST, OPTIONS)"
        );
        assert_eq!(
            reply.header("x-view-allow"),
            Some(&*mask.to_string()),
            "{request}"
        );
        assert_eq!(reply.header("x-route-path"), Some(route_path), "{request}");
        assert_eq!(reply.header("x-mismatches"), Some("[]"), "{request}");
    }
    let matched = get(&mut conn, "/items/1/a");
    assert_eq!(matched.header("x-miss-status"), Some("0"));
    assert_eq!(matched.header("x-view-status"), Some("0"));

    let unrouted = get(&mut conn, "/nowhere");
    assert_eq!(
        unrouted.status, 404,
        "without a miss route the core answers"
    );
    let refused = send(
        &mut conn,
        b"DELETE /items/1/a HTTP/1.1\r\nHost: t\r\n\r\n",
        false,
    );
    assert_eq!(refused.status, 405);
    assert!(refused
        .header("allow")
        .is_some_and(|allow| allow.contains("GET")));
    workers.stop().unwrap();
}

/// Sets an action on some requests and reports the record's request after import.
struct Acting {
    router: Router<Route>,
    exchange: RefCell<Exchange>,
    view: PublishedView,
}

impl Handler for Acting {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        let act = call.request().header(b"x-act").is_some();
        let mut exchange = self.exchange.borrow_mut();
        exchange.release(false);
        call.export(
            &mut exchange,
            &self.view,
            1,
            routed.head,
            &ExportOptions::default(),
        );
        let action = Action::File {
            root: b"/srv".to_vec(),
            path: b"a.txt".to_vec(),
        };
        if act {
            exchange.set_action(action.clone())?;
        }
        call.import(&mut exchange, |_, _| {});
        let taken = exchange.take_action();
        let path = call.request().path().to_vec();
        let user_agent = call
            .request()
            .header(b"user-agent")
            .unwrap_or(b"-")
            .to_vec();
        let param = call.request().param(0).unwrap_or(b"-").to_vec();
        let mut response = call.response();
        response.header(b"X-Record-Path", if path.is_empty() { b"-" } else { &path })?;
        response.header(b"X-Record-Agent", &user_agent)?;
        response.header(b"X-Record-Param", &param)?;
        response.header(b"X-Action", if taken == action { b"file" } else { b"none" })?;
        Ok(())
    }
}

#[test]
fn the_head_comes_back_into_the_record_only_for_an_action_that_reads_the_request() {
    let workers = start(1, None, |_| Acting {
        router: router(),
        exchange: RefCell::new(Exchange::default()),
        view: PublishedView::default(),
    });
    let mut conn = connect(&workers);
    let acted = send(
        &mut conn,
        b"GET /items/9/z?q HTTP/1.1\r\nHost: t\r\nUser-Agent: probe\r\nX-Act: 1\r\n\r\n",
        false,
    );
    assert_eq!(acted.header("x-action"), Some("file"));
    assert_eq!(acted.header("x-record-path"), Some("/items/9/z?q"));
    assert_eq!(acted.header("x-record-agent"), Some("probe"));
    assert_eq!(acted.header("x-record-param"), Some("9"));
    let plain = send(
        &mut conn,
        b"GET /items/9/z?q HTTP/1.1\r\nHost: t\r\nUser-Agent: probe\r\n\r\n",
        false,
    );
    assert_eq!(plain.header("x-action"), Some("none"));
    assert_eq!(
        plain.header("x-record-path"),
        Some("-"),
        "the head stays moved"
    );
    workers.stop().unwrap();
}

/// Counts the allocations of export, the host's writes and import on the worker.
struct Warm {
    router: Router<Route>,
    exchange: RefCell<Exchange>,
    view: PublishedView,
    options: ExportOptions,
}

impl Handler for Warm {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        let mut exchange = self.exchange.borrow_mut();
        exchange.release(false);
        let (outcome, allocations) = Counting::count(|| -> Result<(), Error> {
            call.export(&mut exchange, &self.view, 1, routed.head, &self.options);
            let _ = self.view.snapshot();
            exchange
                .response()
                .header(b"X-Host", b"1")?
                .content_type(b"text/plain")?
                .body(b"Hello, World!");
            call.import(&mut exchange, |request, response| {
                let _ = response.header(b"X-Params", request.params().next().unwrap_or(b"-"));
            });
            Ok(())
        });
        outcome?;
        let count = Decimal::new(allocations);
        let driver = driver(call);
        call.response()
            .header(b"X-Allocations", count.as_bytes())?
            .header(b"X-Driver", driver.as_bytes())?;
        Ok(())
    }
}

/// The I/O driver of the core serving `call`.
#[cfg(feature = "io-compio")]
fn driver(call: &Call<'_>) -> &'static str {
    if call.core().is_io_uring() {
        "io_uring"
    } else {
        "epoll fallback"
    }
}

/// The I/O driver of the core serving `call`.
#[cfg(not(feature = "io-compio"))]
fn driver(_: &Call<'_>) -> &'static str {
    "tokio"
}

#[test]
fn warm_export_and_import_allocate_nothing() {
    let workers = start(1, None, |_| Warm {
        router: router(),
        exchange: RefCell::new(Exchange::default()),
        view: PublishedView::default(),
        options: ExportOptions {
            trailers: vec![Box::from(&b"X-Checksum"[..])],
            client: None,
        },
    });
    let mut conn = connect(&workers);
    let mut counts = Vec::new();
    for round in 0..24 {
        let reply = send(
            &mut conn,
            b"POST /items/7/x?a=b HTTP/1.1\r\nHost: t\r\nX-One: 1\r\nAccept: */*\r\n\
              Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Checksum: c\r\n\r\n",
            false,
        );
        assert_eq!(reply.text(), "Hello, World!", "round {round}");
        assert_eq!(reply.header("x-params"), Some("7"));
        counts.push(
            reply
                .header("x-allocations")
                .unwrap()
                .parse::<u64>()
                .unwrap(),
        );
    }
    let warm = &counts[8..];
    assert!(
        warm.iter().all(|&count| count == 0),
        "warm round trips allocated: {counts:?}"
    );
    let reply = get(&mut conn, "/items/7/x");
    eprintln!(
        "worker I/O driver: {}",
        reply.header("x-driver").unwrap_or("-")
    );
    workers.stop().unwrap();
}

/// Keeps the exchange of an upload and reports it as leased; the upload is
/// answered only once `/go` arrives, so the lease lasts while other requests run.
struct Keeper {
    router: Router<Route>,
    exchange: RefCell<Exchange>,
    view: PublishedView,
    leased: Cell<u64>,
    exported: Arc<AtomicBool>,
    go: Cell<bool>,
    waiting: Cell<Option<Waker>>,
}

impl Handler for Keeper {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        match routed.descriptor {
            Route::Upload => {
                let (counted, length) = {
                    let mut exchange = self.exchange.borrow_mut();
                    call.export(
                        &mut exchange,
                        &self.view,
                        1,
                        false,
                        &ExportOptions::default(),
                    );
                    self.leased.set(exchange.counted());
                    (
                        exchange.counted().to_string(),
                        exchange.request().body().len().to_string(),
                    )
                };
                self.exported.store(true, Ordering::SeqCst);
                std::future::poll_fn(|cx| {
                    if self.go.get() {
                        Poll::Ready(())
                    } else {
                        self.waiting.set(Some(cx.waker().clone()));
                        Poll::Pending
                    }
                })
                .await;
                call.response()
                    .header(b"X-Counted", counted.as_bytes())?
                    .header(b"X-Length", length.as_bytes())?;
            }
            Route::Go => {
                self.go.set(true);
                if let Some(waker) = self.waiting.take() {
                    waker.wake();
                }
                call.response().body(b"go");
            }
            Route::Release => {
                let mut exchange = self.exchange.borrow_mut();
                let released = exchange.release(false).to_string();
                let warm = exchange.capacity().to_string();
                exchange.release(true);
                let cold = exchange.capacity().to_string();
                self.leased.set(0);
                call.response()
                    .header(b"X-Released", released.as_bytes())?
                    .header(b"X-Warm-Capacity", warm.as_bytes())?
                    .header(b"X-Cold-Capacity", cold.as_bytes())?;
            }
            _ => {
                call.response().body(b"plain");
            }
        }
        Ok(())
    }

    fn leased_bytes(&self) -> u64 {
        self.leased.get()
    }
}

#[test]
fn export_moves_the_body_charge_off_the_core_onto_the_exchange_and_release_reports_it() {
    const BODY: usize = 256 * 1024;
    let exported = Arc::new(AtomicBool::new(false));
    let handler_exported = Arc::clone(&exported);
    let workers = start(1, Some(384 * 1024), move |_| Keeper {
        router: router(),
        exchange: RefCell::new(Exchange::default()),
        view: PublishedView::default(),
        leased: Cell::new(0),
        exported: Arc::clone(&handler_exported),
        go: Cell::new(false),
        waiting: Cell::new(None),
    });
    let mut uploader = connect(&workers);
    uploader
        .write_all(
            format!("POST /upload HTTP/1.1\r\nHost: t\r\nContent-Length: {BODY}\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
    uploader.write_all(&vec![b'u'; BODY]).unwrap();
    eventually("the upload to be exported", || {
        exported.load(Ordering::SeqCst)
    });

    let mut other = connect(&workers);
    assert_eq!(
        get(&mut other, "/plain").text(),
        "plain",
        "while the lease lasts the body counts once, on the handler's leased bytes: the \
         budget lies between one body and two, so a body counted on the core's buffered \
         bodies as well would pause accepts"
    );
    assert_eq!(get(&mut other, "/go").text(), "go");
    let uploaded = read_reply(&mut uploader, false).unwrap();
    assert_eq!(uploaded.header("x-length"), Some(&*BODY.to_string()));
    assert_eq!(
        uploaded.header("x-counted"),
        Some(&*BODY.to_string()),
        "the handler's leased bytes carry the body"
    );

    let released = get(&mut uploader, "/release");
    assert_eq!(released.header("x-released"), Some(&*BODY.to_string()));
    let warm: usize = released.header("x-warm-capacity").unwrap().parse().unwrap();
    assert!(
        warm <= 2 * BODY_KEEP,
        "a warm exchange keeps at most BODY_KEEP of a body: {warm}"
    );
    assert_eq!(released.header("x-cold-capacity"), Some("0"));
    let mut last = connect(&workers);
    assert_eq!(get(&mut last, "/plain").text(), "plain");
    workers.stop().unwrap();
}

/// Never answers `/upload`; answers anything else.
struct Stalling;

impl Handler for Stalling {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        if call.request().path() == b"/upload" {
            std::future::pending::<()>().await;
        }
        call.response().body(b"plain");
        Ok(())
    }
}

#[test]
fn a_request_dropped_before_its_handler_completes_gives_its_body_charge_back() {
    const BODY: usize = 160 * 1024;
    let mut config = config(1, Some(256 * 1024));
    config.limits.request_total = Duration::from_millis(500);
    let workers = start_with(config, |_| Stalling);
    for round in 0..3 {
        let mut uploader = connect(&workers);
        uploader
            .write_all(
                format!("POST /upload HTTP/1.1\r\nHost: t\r\nContent-Length: {BODY}\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap();
        uploader.write_all(&vec![b'u'; BODY]).unwrap();
        let reply = read_reply(&mut uploader, false).unwrap();
        assert_eq!(
            reply.status, 503,
            "round {round}: the handler never answered"
        );
    }
    let mut after = connect(&workers);
    assert_eq!(
        get(&mut after, "/plain").text(),
        "plain",
        "the canceled requests' bodies left the core's budget; two of them left counted \
         would pass it and stop the accepts"
    );
    workers.stop().unwrap();
}

/// Reports a leased amount the test sets, and counts how often it is asked.
struct Leasing {
    leased: Arc<AtomicU64>,
    asked: Arc<AtomicU64>,
    served: Arc<AtomicU64>,
}

impl Handler for Leasing {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        self.served.fetch_add(1, Ordering::SeqCst);
        call.response().body(b"served");
        Ok(())
    }

    fn leased_bytes(&self) -> u64 {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.leased.load(Ordering::SeqCst)
    }
}

#[test]
fn leased_bytes_over_the_budget_pause_accepts_until_they_drop() {
    let leased = Arc::new(AtomicU64::new(0));
    let asked = Arc::new(AtomicU64::new(0));
    let served = Arc::new(AtomicU64::new(0));
    let (handler_leased, handler_asked, handler_served) =
        (Arc::clone(&leased), Arc::clone(&asked), Arc::clone(&served));
    let workers = start(1, Some(1 << 20), move |_| Leasing {
        leased: Arc::clone(&handler_leased),
        asked: Arc::clone(&handler_asked),
        served: Arc::clone(&handler_served),
    });
    let mut first = connect(&workers);
    assert_eq!(get(&mut first, "/").text(), "served");

    leased.store(2 << 20, Ordering::SeqCst);
    let mut waiting = connect(&workers);
    waiting
        .write_all(b"GET / HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    let before = asked.load(Ordering::SeqCst);
    eventually("the accept loop to check the budget twenty times", || {
        asked.load(Ordering::SeqCst) >= before + 20
    });
    assert_eq!(
        served.load(Ordering::SeqCst),
        1,
        "nothing is accepted while the leased bytes pass the budget"
    );
    leased.store(0, Ordering::SeqCst);
    let reply = read_reply(&mut waiting, false).unwrap();
    assert_eq!((reply.status, reply.text()), (200, "served".to_owned()));
    assert_eq!(served.load(Ordering::SeqCst), 2);
    workers.stop().unwrap();
}

/// A body another owner keeps.
struct Payload(Vec<u8>);

impl ExternalBody for Payload {
    fn bytes(&self) -> &[u8] {
        &self.0
    }
}

/// A stream that records the slices of every vectored write.
struct Recording {
    inner: zero_io::rt::TcpStream,
    writes: Arc<Mutex<Vec<(usize, usize)>>>,
}

impl Stream for Recording {
    fn readable(&self) -> impl std::future::Future<Output = io::Result<()>> {
        self.inner.readable()
    }

    fn read_leased(&self, pool: &Pool) -> impl std::future::Future<Output = io::Result<Leased>> {
        self.inner.read_leased(pool)
    }

    fn read_into(
        &self,
        buf: OwnedBuf,
    ) -> impl std::future::Future<Output = (io::Result<usize>, OwnedBuf)> {
        self.inner.read_into(buf)
    }

    fn write(
        &self,
        buf: OwnedBuf,
    ) -> impl std::future::Future<Output = (io::Result<usize>, OwnedBuf)> {
        self.inner.write(buf)
    }

    async fn writev(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        self.writes.lock().unwrap().extend(
            bufs.iter()
                .map(|slice| (slice.as_ptr() as usize, slice.len())),
        );
        self.inner.writev(bufs).await
    }

    fn shutdown_write(&self) -> io::Result<()> {
        self.inner.shutdown_write()
    }

    fn close_write(&self) -> impl std::future::Future<Output = io::Result<()>> {
        self.inner.close_write()
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        self.inner.peer_addr()
    }
}

/// Hands every connection over as a [`Recording`] stream, reported secure when
/// `secure` is set, as a TLS listener's would be.
struct RecordingAccept {
    writes: Arc<Mutex<Vec<(usize, usize)>>>,
    secure: bool,
}

impl Accept for RecordingAccept {
    type Stream = Recording;

    fn secure(&self) -> bool {
        self.secure
    }

    fn accept(
        self: Rc<Self>,
        stream: zero_io::rt::TcpStream,
        _peer: SocketAddr,
    ) -> impl std::future::Future<Output = io::Result<Prepared<Recording>>> + 'static {
        std::future::ready(Ok(Prepared::any_host(Recording {
            inner: stream,
            writes: Arc::clone(&self.writes),
        })))
    }
}

#[test]
fn a_request_over_a_secure_connection_exports_and_publishes_the_secure_flag() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let handler_log = Arc::clone(&log);
    let workers = serve_with(
        "127.0.0.1:0".parse().unwrap(),
        config(1, None),
        Arc::new(|_| {}),
        move |_| RoundTrip::new(Arc::clone(&handler_log)),
        |_| RecordingAccept {
            writes: Arc::new(Mutex::new(Vec::new())),
            secure: true,
        },
    )
    .unwrap();
    let mut conn = connect(&workers);
    let reply = get(&mut conn, "/items/1/a");
    assert_eq!(reply.status, 201);
    let observed = log.lock().unwrap().pop().unwrap();
    assert!(
        observed.before.secure,
        "the record knows the connection is secure"
    );
    assert!(
        observed.after.secure,
        "the exchange carries the secure flag"
    );
    assert_eq!(observed.before, observed.after);
    assert_eq!(observed.flags & VIEW_SECURE, VIEW_SECURE);
    assert!(observed.mismatches.is_empty(), "{:?}", observed.mismatches);
    workers.stop().unwrap();
}

/// Answers `/external` with the shared payload as an external body.
struct Externals {
    router: Router<Route>,
    exchange: RefCell<Exchange>,
    view: PublishedView,
    payload: Arc<Payload>,
}

impl Handler for Externals {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        if routed.descriptor != Route::External {
            call.response().body(b"plain");
            return Ok(());
        }
        let mut exchange = self.exchange.borrow_mut();
        exchange.release(false);
        call.export(
            &mut exchange,
            &self.view,
            1,
            routed.head,
            &ExportOptions::default(),
        );
        exchange
            .response()
            .content_type(b"application/octet-stream")?;
        let body: Arc<dyn ExternalBody> = self.payload.clone();
        exchange.set_external(body)?;
        exchange.seal();
        call.import(&mut exchange, |_, _| {});
        Ok(())
    }
}

#[test]
fn an_external_body_leaves_as_one_slice_and_is_released_after_the_write() {
    let payload = Arc::new(Payload((0..200_000u32).map(|n| (n % 251) as u8).collect()));
    let writes = Arc::new(Mutex::new(Vec::new()));
    let (handler_payload, accept_writes) = (Arc::clone(&payload), Arc::clone(&writes));
    let workers = serve_with(
        "127.0.0.1:0".parse().unwrap(),
        config(1, None),
        Arc::new(|_| {}),
        move |_| Externals {
            router: router(),
            exchange: RefCell::new(Exchange::default()),
            view: PublishedView::default(),
            payload: Arc::clone(&handler_payload),
        },
        move |_| RecordingAccept {
            writes: Arc::clone(&accept_writes),
            secure: false,
        },
    )
    .unwrap();
    let mut conn = connect(&workers);
    assert_eq!(get(&mut conn, "/plain").text(), "plain");
    let idle = Arc::strong_count(&payload);

    let reply = get(&mut conn, "/external");
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.body, payload.0,
        "the external bytes reached the client"
    );
    let slice = (payload.0.as_ptr() as usize, payload.0.len());
    assert!(
        writes.lock().unwrap().contains(&slice),
        "the body was written from the external buffer as one slice"
    );
    eventually("the written body to be released", || {
        Arc::strong_count(&payload) == idle
    });
    assert_eq!(get(&mut conn, "/plain").text(), "plain");
    workers.stop().unwrap();
}
