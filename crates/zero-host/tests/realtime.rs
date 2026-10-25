//! WebSocket connections, event streams and rooms driven by a host, end to end over
//! loopback with a test target that hands every batch to the test thread, which is
//! the bound host thread: handshakes refused in Rust (RFC 6455 Sections 4.2.1, 4.2.2
//! and 10.2), leased upgrades accepted or declined, every event kind, the close
//! codes and payload sizes a host may send (Sections 5.5, 7.1.5, 7.4.1 and 7.4.2),
//! the subprotocol rule, the event stream field rules (WHATWG HTML Sections 9.2.5
//! and 9.2.6), sends from host threads, rooms with an exclusion, the bound of events
//! a connection holds for the host, the outbox octets in the core's request-memory
//! budget, connections a lease left behind, and the drain.

#![cfg(all(feature = "realtime", feature = "testing"))]

mod support;

use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::thread;
use std::time::{Duration, Instant};

use support::{eventually, ids, start, stop, Client, Reply, TestTarget};
use zero_host::realtime::{
    self, EVENT_SSE_CLOSED, EVENT_SSE_DRAINED, EVENT_WS_CLOSE, EVENT_WS_DRAINED, EVENT_WS_MESSAGE,
    EVENT_WS_OPEN, EVENT_WS_PONG, OPCODE_BINARY, OPCODE_TEXT,
};
use zero_host::{access, actions};
use zero_host::{
    bind_thread, complete, take_events, testing, App, BatchRef, EventRec, Method, RouteKind,
    Server, ServerOptions, Status, BATCH_EVENTS, BATCH_REQUESTS,
};
use zero_http::Exchange;
use zero_http_types::StatusCode;

/// The worker indexes of the process: the tests share them, and a test that needs
/// its second server on the index its first server gave back holds them alone, so
/// the index it gave back is the lowest free one.
static INDEXES: RwLock<()> = RwLock::new(());

fn sharing() -> RwLockReadGuard<'static, ()> {
    INDEXES.read().unwrap_or_else(PoisonError::into_inner)
}

fn alone() -> RwLockWriteGuard<'static, ()> {
    INDEXES.write().unwrap_or_else(PoisonError::into_inner)
}

/// The sample key of RFC 6455 Section 1.3.
const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

/// The accept value RFC 6455 Section 1.3 gives for [`KEY`].
const ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

/// The masking key of every frame the test client sends.
const MASK: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

/// The route ids of [`app`].
const WS: u32 = 1;
const CHAT: u32 = 2;
const EVENTS: u32 = 3;
const PING: u32 = 4;
const SMALL: u32 = 5;

/// A fixed route, a WebSocket route that takes any subprotocol, one that allows
/// `chat` from `https://a.example` only, a host route for event streams, a
/// WebSocket route that pings every 20 ms, and one whose messages hold 4 octets.
fn app() -> App {
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Get),
        "/fixed",
        br#"{"status":200,"contentType":"text/plain","body":"fixed"}"#,
    )
    .unwrap();
    assert_eq!(
        app.route(RouteKind::WebSocket, None, "/ws", b"").unwrap(),
        WS
    );
    assert_eq!(
        app.route(
            RouteKind::WebSocket,
            Some(Method::Get),
            "/chat",
            br#"{"protocols":["chat"],"origins":["https://a.example"]}"#,
        )
        .unwrap(),
        CHAT
    );
    assert_eq!(
        app.route(RouteKind::Host, None, "/events", b"").unwrap(),
        EVENTS
    );
    assert_eq!(
        app.route(
            RouteKind::WebSocket,
            Some(Method::Get),
            "/ping",
            br#"{"pingIntervalMs":20}"#,
        )
        .unwrap(),
        PING
    );
    assert_eq!(
        app.route(
            RouteKind::WebSocket,
            Some(Method::Get),
            "/small",
            br#"{"maxPayload":4}"#,
        )
        .unwrap(),
        SMALL
    );
    app
}

/// A WebSocket opening handshake for `path`, with more fields.
fn handshake(path: &str, fields: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n{fields}\r\n"
    )
}

/// A frame as a client sends it: masked, its length in the minimal form.
fn client_frame(first: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![first];
    match payload.len() {
        len @ 0..=125 => out.push(0x80 | len as u8),
        len @ 126..=0xFFFF => {
            out.push(0x80 | 126);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        }
        len => {
            out.push(0x80 | 127);
            out.extend_from_slice(&(len as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(&MASK);
    out.extend(payload.iter().zip(MASK.iter().cycle()).map(|(b, k)| b ^ k));
    out
}

fn close_body(code: u16, reason: &str) -> Vec<u8> {
    let mut body = code.to_be_bytes().to_vec();
    body.extend_from_slice(reason.as_bytes());
    body
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// The client side of a WebSocket.
struct WsClient {
    stream: TcpStream,
}

impl WsClient {
    fn handshake(server: &Server, path: &str, fields: &str) -> WsClient {
        let mut stream = TcpStream::connect(server.address().unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        stream.set_nodelay(true).unwrap();
        stream
            .write_all(handshake(path, fields).as_bytes())
            .unwrap();
        WsClient { stream }
    }

    /// The response head: the status and the fields.
    fn head(&mut self) -> (u16, Vec<(String, String)>) {
        let mut bytes = Vec::new();
        let mut byte = [0u8; 1];
        while !bytes.ends_with(b"\r\n\r\n") {
            self.stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        let text = String::from_utf8(bytes).unwrap();
        let mut lines = text.trim_end().split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .map(|line| {
                let (name, value) = line.split_once(':').unwrap();
                (name.to_owned(), value.trim().to_owned())
            })
            .collect();
        (status, headers)
    }

    fn send(&mut self, first: u8, payload: &[u8]) {
        self.stream
            .write_all(&client_frame(first, payload))
            .unwrap();
    }

    /// One server frame: the first byte and the payload; a server never masks.
    fn frame(&mut self) -> (u8, Vec<u8>) {
        let mut head = [0u8; 2];
        self.stream.read_exact(&mut head).unwrap();
        assert_eq!(head[1] & 0x80, 0, "a server frame is never masked");
        let len = match head[1] & 0x7F {
            126 => {
                let mut wide = [0u8; 2];
                self.stream.read_exact(&mut wide).unwrap();
                usize::from(u16::from_be_bytes(wide))
            }
            127 => {
                let mut wide = [0u8; 8];
                self.stream.read_exact(&mut wide).unwrap();
                usize::try_from(u64::from_be_bytes(wide)).unwrap()
            }
            short => usize::from(short),
        };
        let mut payload = vec![0u8; len];
        self.stream.read_exact(&mut payload).unwrap();
        (head[0], payload)
    }

    fn text(&mut self) -> String {
        let (first, payload) = self.frame();
        assert_eq!(first, 0x81);
        String::from_utf8(payload).unwrap()
    }

    /// Whether the server closed the connection.
    fn closed(&mut self) -> bool {
        let mut byte = [0u8; 1];
        matches!(self.stream.read(&mut byte), Ok(0))
    }
}

/// Read one event, up to and including the blank line that ends it.
fn read_event(stream: &mut TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while !bytes.ends_with(b"\n\n") {
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    bytes
}

/// Read until the server closes the connection.
fn read_rest(stream: &mut TcpStream) -> Vec<u8> {
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).unwrap();
    rest
}

/// A server for [`app`] with a test target bound to the calling thread, which
/// keeps the events of the batches it reads until the test asks for them and
/// acknowledges every batch once it read it.
struct Host {
    server: Server,
    worker: u8,
    target: Arc<TestTarget>,
    events: VecDeque<EventRec>,
    _indexes: Option<RwLockReadGuard<'static, ()>>,
}

impl Host {
    fn start(options: &str) -> Host {
        let indexes = sharing();
        let server = start(&app(), options);
        let worker = server.workers()[0];
        let target = TestTarget::new(8);
        server.attach(worker, target.clone()).unwrap();
        bind_thread(worker).unwrap();
        Host {
            server,
            worker,
            target,
            events: VecDeque::new(),
            _indexes: Some(indexes),
        }
    }

    /// A server for [`app`] with a test target attached before it starts, so it
    /// takes every event from the first turn on; the caller holds the indexes.
    fn attached_first(options: &str) -> Host {
        let server =
            Server::new(&app(), ServerOptions::parse(options.as_bytes()).unwrap()).unwrap();
        let worker = server.workers()[0];
        let target = TestTarget::new(8);
        server.attach(worker, target.clone()).unwrap();
        server.start().unwrap();
        bind_thread(worker).unwrap();
        Host {
            server,
            worker,
            target,
            events: VecDeque::new(),
            _indexes: None,
        }
    }

    fn ack(&self, batch: BatchRef) {
        complete(self.worker, &[], batch.epoch, None).unwrap();
    }

    /// Move an event batch's records out without acknowledging it.
    fn read_events(batch: BatchRef) -> Vec<EventRec> {
        assert_eq!(batch.kind, BATCH_EVENTS);
        let mut events = Vec::new();
        take_events(batch, &mut events).unwrap();
        events
    }

    /// The next leased request's slot id; the events that came before it are kept.
    fn request(&mut self) -> u64 {
        loop {
            let batch = self.target.take();
            if batch.kind == BATCH_REQUESTS {
                let slot = ids(batch)[0];
                self.ack(batch);
                return slot;
            }
            let events = Self::read_events(batch);
            self.ack(batch);
            self.events.extend(events);
        }
    }

    /// The next event.
    fn event(&mut self) -> EventRec {
        loop {
            if let Some(event) = self.events.pop_front() {
                return event;
            }
            let batch = self.target.take();
            let events = Self::read_events(batch);
            self.ack(batch);
            self.events.extend(events);
        }
    }

    /// The next event of connection `conn`; the events of other connections stay for
    /// later.
    fn event_of(&mut self, conn: u64) -> EventRec {
        loop {
            if let Some(position) = self.events.iter().position(|event| event.conn == conn) {
                return self.events.remove(position).unwrap();
            }
            let batch = self.target.take();
            let events = Self::read_events(batch);
            self.ack(batch);
            self.events.extend(events);
        }
    }

    /// Answer a leased request through `respond` and complete it.
    fn respond<R>(&self, slot: u64, respond: impl FnOnce(&mut Exchange) -> R) -> R {
        let answered = testing::respond(slot, respond).unwrap();
        complete(self.worker, &[slot], 0, None).unwrap();
        answered
    }

    /// Open a WebSocket on `path`, accepted with `protocol`, past its open event.
    fn websocket(&mut self, path: &str, fields: &str, protocol: &[u8]) -> (WsClient, u64) {
        let mut client = WsClient::handshake(&self.server, path, fields);
        let slot = self.request();
        let conn = self.respond(slot, |exchange| {
            actions::ws_accept(slot, exchange, protocol).unwrap()
        });
        assert_eq!(client.head().0, 101);
        assert_eq!(self.event_of(conn).kind, EVENT_WS_OPEN);
        (client, conn)
    }

    /// Run `queue` while the core is held on its worker thread, so what it queues is
    /// still queued when it returns, however fast the sockets take it.
    fn while_held<R>(&self, queue: impl FnOnce() -> R) -> R {
        let (entered, on_core) = mpsc::channel();
        let (release, released) = mpsc::channel::<()>();
        let (server, worker) = (self.server.clone(), self.worker);
        let holder = thread::spawn(move || {
            testing::run_on_worker(&server, worker, move || {
                let _ = entered.send(());
                let _ = released.recv();
            })
        });
        on_core.recv_timeout(Duration::from_secs(10)).unwrap();
        let queued = queue();
        release.send(()).unwrap();
        holder.join().unwrap().unwrap();
        queued
    }

    /// Drain the server with these connections open. A send to each is queued while
    /// the core is held, with the shutdown, so the outboxes still hold them when the
    /// drain starts: each WebSocket writes its send, then Close 1001, which its client
    /// answers, and each event stream writes its send and ends; the host receives
    /// every close event, a WebSocket's with 1001, before the server stops.
    fn drain(&mut self, sockets: Vec<(WsClient, u64)>, streams: Vec<(Client, u64)>) {
        self.while_held(|| {
            for (_, conn) in &sockets {
                realtime::ws_send(*conn, OPCODE_TEXT, b"queued at the drain").unwrap();
            }
            for (_, conn) in &streams {
                realtime::sse_send(*conn, None, None, b"queued at the drain").unwrap();
            }
            self.server.shutdown();
        });

        let mut closes = Vec::new();
        for (mut socket, conn) in sockets {
            assert_eq!(
                socket.text(),
                "queued at the drain",
                "the outbox goes out before the Close"
            );
            assert_eq!(socket.frame(), (0x88, close_body(1001, "")));
            socket.send(0x88, &close_body(1001, ""));
            assert!(socket.closed());
            closes.push((conn, EVENT_WS_CLOSE));
        }
        for (mut stream, conn) in streams {
            assert_eq!(
                read_event(&mut stream.stream),
                b"data: queued at the drain\n\n"
            );
            assert!(read_rest(&mut stream.stream).is_empty());
            closes.push((conn, EVENT_SSE_CLOSED));
        }
        for (conn, kind) in closes {
            let close = self.event_of(conn);
            assert_eq!(close.kind, kind, "the close event of {conn}");
            if kind == EVENT_WS_CLOSE {
                assert_eq!(close.code, 1001, "the client's answer to Close 1001");
            }
        }
        eventually("the server to stop", || !self.server.is_running());
    }

    /// Open an event stream on `/events` with no keep-alive comment.
    fn stream(&mut self) -> (Client, u64, Reply) {
        let mut client = Client::connect(&self.server);
        client.send_get("/events");
        let slot = self.request();
        let conn = self.respond(slot, |exchange| {
            actions::sse_open(slot, exchange, 0).unwrap()
        });
        let head = client.read().unwrap();
        (client, conn, head)
    }
}

#[test]
fn a_websocket_handshake_the_route_refuses_is_answered_in_rust_and_never_leased_6455_4_2_2() {
    let host = Host::start(r#"{"threads":1}"#);
    let upgrade = "Upgrade: websocket\r\nConnection: Upgrade\r\n";
    let ask = |request: String| Client::connect(&host.server).get_with(&request);

    let no_key = ask(format!(
        "GET /ws HTTP/1.1\r\nHost: t\r\n{upgrade}Sec-WebSocket-Version: 13\r\n\r\n"
    ));
    assert_eq!(no_key.status, 400, "{}", no_key.text());
    assert_eq!(
        no_key.header("content-type"),
        Some("application/problem+json")
    );
    assert_eq!(
        no_key.text(),
        r#"{"type":"about:blank","title":"Bad Request","status":400,"code":"protocol"}"#
    );

    let old = ask(format!(
        "GET /ws HTTP/1.1\r\nHost: t\r\n{upgrade}Sec-WebSocket-Key: {KEY}\r\n\
         Sec-WebSocket-Version: 8\r\n\r\n"
    ));
    assert_eq!(old.status, 426, "{}", old.text());
    assert_eq!(old.header("upgrade"), Some("websocket"));
    assert_eq!(old.header("sec-websocket-version"), Some("13"));
    assert!(old.text().contains(r#""code":"upgrade_required""#));

    let foreign = ask(handshake("/chat", "Origin: https://b.example\r\n"));
    assert_eq!(foreign.status, 403, "{}", foreign.text());
    assert!(foreign.text().contains(r#""code":"forbidden""#));

    let post = ask(format!(
        "POST /ws HTTP/1.1\r\nHost: t\r\n{upgrade}Sec-WebSocket-Key: {KEY}\r\n\
         Sec-WebSocket-Version: 13\r\nContent-Length: 0\r\n\r\n"
    ));
    assert_eq!(post.status, 400, "{}", post.text());

    assert_eq!(host.target.counts().2, 0, "no refused handshake was leased");
    stop(&host.server);
}

#[test]
fn a_leased_upgrade_the_host_accepts_reports_open_message_pong_and_close_events() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut client = WsClient::handshake(&host.server, "/ws", "");
    let slot = host.request();
    assert_eq!(testing::inspect(slot, Exchange::route).unwrap(), WS);
    let conn = host.respond(slot, |exchange| {
        actions::ws_accept(slot, exchange, b"").unwrap()
    });
    let (status, headers) = client.head();
    assert_eq!(status, 101);
    assert_eq!(header(&headers, "sec-websocket-accept"), Some(ACCEPT));
    assert_eq!(header(&headers, "sec-websocket-protocol"), None);
    let open = host.event();
    assert_eq!(
        (open.kind, open.conn, open.route),
        (EVENT_WS_OPEN, conn, WS)
    );

    client.send(0x81, b"hi");
    let text = host.event();
    assert_eq!(
        (text.kind, text.conn, text.opcode, text.data.as_slice()),
        (EVENT_WS_MESSAGE, conn, OPCODE_TEXT, b"hi".as_slice())
    );
    client.send(0x82, &[1, 2, 3]);
    let binary = host.event();
    assert_eq!(
        (binary.kind, binary.opcode, binary.data),
        (EVENT_WS_MESSAGE, OPCODE_BINARY, vec![1, 2, 3])
    );

    realtime::ws_ping(conn, b"p").unwrap();
    assert_eq!(client.frame(), (0x89, b"p".to_vec()));
    client.send(0x8A, b"p");
    let pong = host.event();
    assert_eq!(
        (pong.kind, pong.data.as_slice()),
        (EVENT_WS_PONG, b"p".as_slice())
    );

    realtime::ws_send(conn, OPCODE_TEXT, b"from the host").unwrap();
    assert_eq!(client.text(), "from the host");
    assert_eq!(
        realtime::sse_send(conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::InvalidArgument,
        "a WebSocket is not an event stream"
    );

    client.send(0x88, &close_body(1000, "done"));
    assert_eq!(client.frame(), (0x88, close_body(1000, "")));
    assert!(client.closed());
    let close = host.event();
    assert_eq!(
        (close.kind, close.conn, close.code),
        (EVENT_WS_CLOSE, conn, 1000)
    );
    assert_eq!(
        realtime::ws_send(conn, OPCODE_TEXT, b"late")
            .unwrap_err()
            .status(),
        Status::Closed
    );
    stop(&host.server);
}

#[test]
fn a_websocket_closed_without_a_status_reports_1005_and_one_that_drops_1006_6455_7_1_5() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut silent, silent_conn) = host.websocket("/ws", "", b"");
    silent.send(0x88, b"");
    assert_eq!(silent.frame(), (0x88, Vec::new()));
    assert!(silent.closed());
    let close = host.event();
    assert_eq!((close.conn, close.code), (silent_conn, 1005));

    let (dropped, dropped_conn) = host.websocket("/ws", "", b"");
    dropped.stream.shutdown(Shutdown::Both).unwrap();
    drop(dropped);
    let close = host.event();
    assert_eq!(
        (close.kind, close.conn, close.code),
        (EVENT_WS_CLOSE, dropped_conn, 1006)
    );
    stop(&host.server);
}

#[test]
fn a_host_close_refuses_reserved_and_unassigned_close_codes() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn) = host.websocket("/ws", "", b"");
    for code in [
        0,
        999,
        1004,
        1005,
        1006,
        1010,
        1015,
        1016,
        2000,
        2999,
        5000,
        u16::MAX,
    ] {
        assert_eq!(
            realtime::ws_close(conn, code, b"").unwrap_err().status(),
            Status::InvalidArgument,
            "{code}"
        );
    }
    assert_eq!(
        realtime::ws_buffered(conn).unwrap(),
        0,
        "a refused close queues nothing"
    );
    realtime::ws_close(conn, 4999, b"bye").unwrap();
    assert_eq!(client.frame(), (0x88, close_body(4999, "bye")));
    assert_eq!(
        realtime::ws_close(conn, 1000, b"").unwrap_err().status(),
        Status::Closed,
        "nothing follows a close"
    );

    client.send(0x88, &close_body(4999, ""));
    assert!(client.closed());
    let close = host.event_of(conn);
    assert_eq!((close.kind, close.code), (EVENT_WS_CLOSE, 4999));

    for code in [1000, 1013, 1014, 3000] {
        let (mut client, conn) = host.websocket("/ws", "", b"");
        realtime::ws_close(conn, code, b"").unwrap();
        assert_eq!(client.frame(), (0x88, close_body(code, "")), "{code}");
        client.send(0x88, &close_body(code, ""));
        assert!(client.closed());
        assert_eq!(host.event_of(conn).code, code, "the peer's answer");
    }
    stop(&host.server);
}

#[test]
fn a_host_ping_and_close_are_limited_to_125_octets_of_payload() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn) = host.websocket("/ws", "", b"");
    assert_eq!(
        realtime::ws_ping(conn, &[b'x'; 126]).unwrap_err().status(),
        Status::InvalidArgument
    );
    realtime::ws_ping(conn, &[b'x'; 125]).unwrap();
    assert_eq!(client.frame(), (0x89, vec![b'x'; 125]));
    eventually("the written ping to leave the outbox", || {
        realtime::ws_buffered(conn).unwrap() == 0
    });

    assert_eq!(
        realtime::ws_close(conn, 1000, &[b'r'; 124])
            .unwrap_err()
            .status(),
        Status::InvalidArgument
    );
    assert_eq!(
        realtime::ws_close(conn, 1000, &[0xff, 0xfe])
            .unwrap_err()
            .status(),
        Status::InvalidArgument,
        "a reason is UTF-8"
    );
    assert_eq!(realtime::ws_buffered(conn).unwrap(), 0);
    realtime::ws_close(conn, 1000, &[b'r'; 123]).unwrap();
    let (first, payload) = client.frame();
    assert_eq!((first, payload.len()), (0x88, 125));
    assert_eq!(payload, close_body(1000, &"r".repeat(123)));
    client.send(0x88, &close_body(1000, ""));
    assert!(client.closed());
    stop(&host.server);
}

#[test]
fn the_accepted_subprotocol_is_one_the_client_offered() {
    let mut host = Host::start(r#"{"threads":1}"#);

    let mut any = WsClient::handshake(
        &host.server,
        "/ws",
        "Sec-WebSocket-Protocol: chat, superchat\r\n",
    );
    let slot = host.request();
    let any_conn = host.respond(slot, |exchange| {
        for refused in [&b"other"[..], b"chat, superchat", b"Chat"] {
            assert_eq!(
                actions::ws_accept(slot, exchange, refused)
                    .unwrap_err()
                    .status(),
                Status::InvalidArgument,
                "{}",
                String::from_utf8_lossy(refused)
            );
        }
        actions::ws_accept(slot, exchange, b"superchat").unwrap()
    });
    let (status, headers) = any.head();
    assert_eq!(
        (status, header(&headers, "sec-websocket-protocol")),
        (101, Some("superchat"))
    );
    assert_eq!(host.event().kind, EVENT_WS_OPEN);

    let mut narrowed = WsClient::handshake(
        &host.server,
        "/chat",
        "Origin: https://a.example\r\nSec-WebSocket-Protocol: superchat, chat\r\n",
    );
    let slot = host.request();
    let narrowed_conn = host.respond(slot, |exchange| {
        assert_eq!(
            actions::ws_accept(slot, exchange, b"superchat")
                .unwrap_err()
                .status(),
            Status::InvalidArgument,
            "offered but not allowed by the route"
        );
        actions::ws_accept(slot, exchange, b"chat").unwrap()
    });
    let (status, headers) = narrowed.head();
    assert_eq!(
        (status, header(&headers, "sec-websocket-protocol")),
        (101, Some("chat"))
    );
    assert_eq!(host.event().kind, EVENT_WS_OPEN);

    let mut none = WsClient::handshake(&host.server, "/ws", "Sec-WebSocket-Protocol: chat\r\n");
    let slot = host.request();
    let none_conn = host.respond(slot, |exchange| {
        exchange
            .response()
            .header(b"Sec-WebSocket-Protocol", b"chat")
            .unwrap();
        actions::ws_accept(slot, exchange, b"").unwrap()
    });
    let (status, headers) = none.head();
    assert_eq!(status, 101);
    assert_eq!(
        header(&headers, "sec-websocket-protocol"),
        None,
        "an empty choice sends no Sec-WebSocket-Protocol, whatever the host set"
    );
    assert_eq!(host.event_of(none_conn).kind, EVENT_WS_OPEN);
    host.drain(
        vec![
            (any, any_conn),
            (narrowed, narrowed_conn),
            (none, none_conn),
        ],
        Vec::new(),
    );
}

#[test]
fn the_101_carries_each_handshake_field_once_and_only_as_the_core_negotiated_it_6455_11_3() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut client = WsClient::handshake(&host.server, "/ws", "Sec-WebSocket-Protocol: chat\r\n");
    let slot = host.request();
    let conn = host.respond(slot, |exchange| {
        let mut response = exchange.response();
        for (name, value) in [
            (&b"Sec-WebSocket-Protocol"[..], &b"evil"[..]),
            (b"Sec-WebSocket-Extensions", b"permessage-deflate"),
            (b"Sec-WebSocket-Accept", b"forged"),
            (b"Sec-WebSocket-Version", b"8"),
            (b"Upgrade", b"h2c"),
            (b"X-Host", b"kept"),
        ] {
            response.header(name, value).unwrap();
        }
        actions::ws_accept(slot, exchange, b"chat").unwrap()
    });
    let (status, headers) = client.head();
    assert_eq!(status, 101);
    let values = |name: &str| -> Vec<&str> {
        headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect()
    };
    assert_eq!(values("sec-websocket-protocol"), ["chat"]);
    assert_eq!(values("sec-websocket-accept"), [ACCEPT]);
    assert_eq!(values("upgrade"), ["websocket"]);
    assert!(
        values("sec-websocket-extensions").is_empty(),
        "no extension was negotiated"
    );
    assert!(values("sec-websocket-version").is_empty());
    assert_eq!(values("x-host"), ["kept"], "the host's other fields stay");
    assert_eq!(host.event_of(conn).kind, EVENT_WS_OPEN);
    host.drain(vec![(client, conn)], Vec::new());
}

#[test]
fn an_event_stream_head_carries_one_content_type_the_streams_own() {
    let mut host = Host::start(r#"{"threads":1}"#);
    for set in [&b"text/event-stream; charset=utf-8"[..], b"text/plain"] {
        let mut client = Client::connect(&host.server);
        client.send_get("/events");
        let slot = host.request();
        let conn = host.respond(slot, |exchange| {
            exchange.response().header(b"Content-Type", set).unwrap();
            actions::sse_open(slot, exchange, 0).unwrap()
        });
        let head = client.read().unwrap();
        let types: Vec<&str> = head
            .headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.as_str())
            .collect();
        assert_eq!(
            types,
            ["text/event-stream; charset=utf-8"],
            "the host set {}",
            String::from_utf8_lossy(set)
        );
        realtime::sse_close(conn).unwrap();
        assert!(read_rest(&mut client.stream).is_empty());
        assert_eq!(host.event_of(conn).kind, EVENT_SSE_CLOSED);
    }
    stop(&host.server);
}

#[test]
fn a_declined_upgrade_is_answered_with_an_http_error_status() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut client = Client::connect(&host.server);
    client.send(handshake("/ws", "").as_bytes());
    let slot = host.request();
    host.respond(slot, |exchange| {
        exchange.response().status(StatusCode::FORBIDDEN);
    });
    let declined = client.read().unwrap();
    assert_eq!(declined.status, 403);
    assert_eq!(declined.header("sec-websocket-accept"), None);
    assert_eq!(declined.header("upgrade"), None);
    assert_eq!(
        client.get("/fixed").text(),
        "fixed",
        "the connection still speaks HTTP/1.1: no upgrade happened"
    );
    stop(&host.server);
}

#[test]
fn an_event_stream_carries_the_hosts_fields_and_what_it_sent_before_the_head() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut client = Client::connect(&host.server);
    client.send_get("/events");
    let slot = host.request();
    let conn = host.respond(slot, |exchange| {
        assert_eq!(
            actions::ws_accept(slot, exchange, b"")
                .unwrap_err()
                .status(),
            Status::InvalidArgument,
            "only a WebSocket route's request is accepted"
        );
        exchange.response().header(b"X-Stream", b"1").unwrap();
        let conn = actions::sse_open(slot, exchange, 0).unwrap();
        realtime::sse_send(conn, Some(b"early"), None, b"before the head").unwrap();
        conn
    });
    let head = client.read().unwrap();
    assert_eq!(head.status, 200);
    assert_eq!(
        head.header("content-type"),
        Some("text/event-stream; charset=utf-8")
    );
    assert_eq!(head.header("cache-control"), Some("no-store"));
    assert_eq!(head.header("x-stream"), Some("1"));
    assert_eq!(head.header("content-length"), None);
    assert_eq!(head.header("connection"), Some("close"));
    assert_eq!(
        read_event(&mut client.stream),
        b"event: early\ndata: before the head\n\n"
    );
    realtime::sse_send(conn, None, Some(b"7"), b"later").unwrap();
    assert_eq!(read_event(&mut client.stream), b"id: 7\ndata: later\n\n");
    realtime::sse_retry(conn, 2500).unwrap();
    assert_eq!(read_event(&mut client.stream), b"retry: 2500\n\n");
    assert_eq!(
        realtime::ws_send(conn, OPCODE_TEXT, b"x")
            .unwrap_err()
            .status(),
        Status::InvalidArgument,
        "an event stream is not a WebSocket"
    );

    let mut probe = Client::connect(&host.server);
    probe.send(b"HEAD /events HTTP/1.1\r\nHost: t\r\n\r\n");
    let slot = host.request();
    host.respond(slot, |exchange| {
        assert_eq!(
            actions::sse_open(slot, exchange, 0).unwrap_err().status(),
            Status::InvalidArgument,
            "a response to HEAD carries no stream"
        );
        exchange.response().status(StatusCode::NO_CONTENT);
    });
    assert_eq!(probe.read().unwrap().status, 204);

    realtime::sse_close(conn).unwrap();
    assert!(read_rest(&mut client.stream).is_empty());
    let closed = host.event();
    assert_eq!(
        (closed.kind, closed.conn, closed.route),
        (EVENT_SSE_CLOSED, conn, EVENTS)
    );
    assert_eq!(
        realtime::sse_send(conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::Closed
    );
    for (conn, status) in [(0, Status::Closed), (u64::MAX, Status::InvalidArgument)] {
        assert_eq!(
            realtime::sse_send(conn, None, None, b"x")
                .unwrap_err()
                .status(),
            status,
            "{conn}"
        );
    }
    stop(&host.server);
}

#[test]
fn a_host_sse_call_with_cr_lf_or_nul_in_event_or_id_is_refused() {
    type EventAndId<'a> = (Option<&'a [u8]>, Option<&'a [u8]>);
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn, _) = host.stream();
    let refused: [EventAndId<'_>; 7] = [
        (Some(b"a\nb"), None),
        (Some(b"a\rb"), None),
        (Some(b"a\r\nb"), None),
        (None, Some(b"a\nb")),
        (None, Some(b"a\rb")),
        (None, Some(b"a\0b")),
        (Some(&[0xff]), None),
    ];
    for (event, id) in refused {
        assert_eq!(
            realtime::sse_send(conn, event, id, b"data")
                .unwrap_err()
                .status(),
            Status::InvalidArgument,
            "{event:?} {id:?}"
        );
        assert_eq!(
            realtime::sse_buffered(conn).unwrap(),
            0,
            "nothing is queued"
        );
    }
    realtime::sse_send(conn, Some(b"ok"), Some(b"1"), b"fine").unwrap();
    assert_eq!(
        read_event(&mut client.stream),
        b"event: ok\nid: 1\ndata: fine\n\n",
        "the refused calls wrote nothing before it"
    );
    stop(&host.server);
}

#[test]
fn host_comment_and_data_text_is_split_so_every_line_stays_one_field() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn, _) = host.stream();
    realtime::sse_send(conn, None, None, b"a\r\nb\nc\rd").unwrap();
    let event = read_event(&mut client.stream);
    assert_eq!(event, b"data: a\ndata: b\ndata: c\ndata: d\n\n");
    let mut decoder = zero_sse::Decoder::new(1 << 16);
    let mut seen = Vec::new();
    decoder.feed(&event, &mut seen).unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].data, "a\nb\nc\nd",
        "a client rejoins the lines with LF"
    );

    realtime::sse_comment(conn, b"x\r\ny\nz\rw").unwrap();
    realtime::sse_send(conn, None, None, b"after").unwrap();
    let mut written = vec![0u8; b":x\n:y\n:z\n:w\n".len()];
    client.stream.read_exact(&mut written).unwrap();
    assert_eq!(written, b":x\n:y\n:z\n:w\n");
    assert_eq!(read_event(&mut client.stream), b"data: after\n\n");
    stop(&host.server);
}

#[test]
fn an_event_stream_reports_a_drained_outbox_and_the_client_leaving() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn, _) = host.stream();
    let data = vec![b'x'; 1 << 20];
    host.while_held(|| {
        for _ in 0..40 {
            realtime::sse_send(conn, None, None, &data).unwrap();
        }
        assert!(!realtime::sse_writable(conn).unwrap(), "past the mark");
    });
    let mut rest = vec![0u8; 40 * (data.len() + 8)];
    client.stream.read_exact(&mut rest).unwrap();
    let drained = host.event();
    assert_eq!((drained.kind, drained.conn), (EVENT_SSE_DRAINED, conn));
    assert!(realtime::sse_writable(conn).unwrap());

    client.stream.shutdown(Shutdown::Both).unwrap();
    drop(client);
    let closed = host.event();
    assert_eq!((closed.kind, closed.conn), (EVENT_SSE_CLOSED, conn));
    assert_eq!(
        realtime::sse_send(conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::Closed
    );
    stop(&host.server);
}

#[test]
fn sends_from_host_threads_arrive_in_the_order_each_thread_made_them() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn) = host.websocket("/ws", "", b"");
    let (mut stream, stream_conn, _) = host.stream();
    let senders: Vec<_> = ["a", "b"]
        .into_iter()
        .map(|name| {
            thread::spawn(move || {
                for index in 0..100 {
                    realtime::ws_send(conn, OPCODE_TEXT, format!("{name}{index}").as_bytes())
                        .unwrap();
                }
            })
        })
        .collect();
    let streamer = thread::spawn(move || {
        for index in 0..50 {
            realtime::sse_send(stream_conn, None, None, index.to_string().as_bytes()).unwrap();
        }
    });
    for sender in senders {
        sender.join().unwrap();
    }
    streamer.join().unwrap();

    let mut next: HashMap<char, u32> = HashMap::new();
    for _ in 0..200 {
        let text = client.text();
        let name = text.chars().next().unwrap();
        let index: u32 = text[1..].parse().unwrap();
        let expected = next.entry(name).or_insert(0);
        assert_eq!(index, *expected, "{name}'s messages arrive in order");
        *expected += 1;
    }
    for index in 0..50 {
        assert_eq!(
            read_event(&mut stream.stream),
            format!("data: {index}\n\n").into_bytes()
        );
    }
    host.drain(vec![(client, conn)], vec![(stream, stream_conn)]);
}

#[test]
fn a_room_broadcast_reaches_every_member_but_the_one_left_out() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut first, first_conn) = host.websocket("/ws", "", b"");
    let (mut second, second_conn) = host.websocket("/ws", "", b"");
    realtime::room_join(first_conn, b"lobby").unwrap();
    realtime::room_join(second_conn, b"lobby").unwrap();
    eventually("both members to join", || {
        host.server.room_size(b"lobby").unwrap() == 2
    });

    assert_eq!(
        host.server
            .room_broadcast(b"lobby", OPCODE_TEXT, b"hello", Some(first_conn))
            .unwrap(),
        1
    );
    assert_eq!(second.text(), "hello");
    realtime::ws_send(first_conn, OPCODE_TEXT, b"direct").unwrap();
    assert_eq!(
        first.text(),
        "direct",
        "the member left out received no broadcast before it"
    );
    assert_eq!(
        host.server
            .room_broadcast(b"lobby", OPCODE_BINARY, &[9, 9], None)
            .unwrap(),
        2
    );
    assert_eq!(first.frame(), (0x82, vec![9, 9]));
    assert_eq!(second.frame(), (0x82, vec![9, 9]));
    for (opcode, data) in [(OPCODE_TEXT, &[0xff][..]), (7, &b"x"[..])] {
        assert_eq!(
            host.server
                .room_broadcast(b"lobby", opcode, data, None)
                .unwrap_err()
                .status(),
            Status::InvalidArgument
        );
    }

    realtime::room_leave(second_conn, b"lobby").unwrap();
    eventually("the member to leave", || {
        host.server.room_size(b"lobby").unwrap() == 1
    });
    assert_eq!(
        host.server
            .room_broadcast(b"lobby", OPCODE_TEXT, b"only", None)
            .unwrap(),
        1
    );
    assert_eq!(first.text(), "only");
    host.drain(vec![(first, first_conn), (second, second_conn)], Vec::new());
}

#[test]
fn a_room_broadcast_reaches_a_member_in_order_with_the_sends_made_on_it_before_and_after() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn) = host.websocket("/ws", "", b"");
    realtime::room_join(conn, b"r").unwrap();
    realtime::ws_send(conn, OPCODE_TEXT, b"joined").unwrap();
    assert_eq!(client.text(), "joined", "the join went before this frame");
    let rounds = 200;
    for round in 0..rounds {
        realtime::ws_send(conn, OPCODE_TEXT, format!("send {round}").as_bytes()).unwrap();
        assert_eq!(
            host.server
                .room_broadcast(
                    b"r",
                    OPCODE_TEXT,
                    format!("broadcast {round}").as_bytes(),
                    None
                )
                .unwrap(),
            1
        );
        realtime::ws_send(conn, OPCODE_TEXT, format!("after {round}").as_bytes()).unwrap();
    }
    for round in 0..rounds {
        assert_eq!(client.text(), format!("send {round}"));
        assert_eq!(client.text(), format!("broadcast {round}"));
        assert_eq!(client.text(), format!("after {round}"));
    }
    host.drain(vec![(client, conn)], Vec::new());
}

#[test]
fn the_close_event_carries_the_peers_close_code_and_reason_6455_7_1_6() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn) = host.websocket("/ws", "", b"");
    client.send(0x88, &close_body(4001, "going home"));
    assert_eq!(client.frame(), (0x88, close_body(4001, "")));
    assert!(client.closed());
    let close = host.event_of(conn);
    assert_eq!(
        (close.kind, close.code, close.data.as_slice()),
        (EVENT_WS_CLOSE, 4001, b"going home".as_slice()),
        "the UTF-8 data after the status code"
    );

    for body in [close_body(1000, ""), Vec::new()] {
        let (mut client, conn) = host.websocket("/ws", "", b"");
        client.send(0x88, &body);
        assert_eq!(client.frame().0, 0x88);
        assert!(client.closed());
        let close = host.event_of(conn);
        assert_eq!(
            (close.kind, close.data.as_slice()),
            (EVENT_WS_CLOSE, b"".as_slice()),
            "a Close without a reason has the empty reason: {body:?}"
        );
    }

    let (dropped, conn) = host.websocket("/ws", "", b"");
    dropped.stream.shutdown(Shutdown::Both).unwrap();
    drop(dropped);
    let close = host.event_of(conn);
    assert_eq!(
        (close.code, close.data.as_slice()),
        (1006, b"".as_slice()),
        "no Close arrived"
    );
    stop(&host.server);
}

#[test]
fn a_connection_stops_reading_while_it_holds_its_bound_of_unacknowledged_events() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut client, conn) = host.websocket("/ws", "", b"");
    let size = 32 * 1024;
    let bound = zero_limits::services::MAX_PENDING_EVENTS_PER_CONN;
    let payload = |index: u32| {
        let mut payload = vec![0u8; size];
        payload[..4].copy_from_slice(&index.to_be_bytes());
        payload
    };
    let past_bound = u32::try_from(bound).unwrap();
    let mut frames: Vec<u8> = (0..=past_bound)
        .flat_map(|index| client_frame(0x82, &payload(index)))
        .collect();
    frames.extend(client_frame(0x89, b"probe"));
    frames.extend((past_bound + 1..1000).flat_map(|index| client_frame(0x82, &payload(index))));
    let mut writer = client.stream.try_clone().unwrap();
    let finisher = thread::spawn(move || writer.write_all(&frames).unwrap());
    let at_bound = u64::try_from(bound * size).unwrap();
    let octets = || testing::realtime_octets(&host.server, host.worker).unwrap();
    eventually("the connection to hold its bound of events", || {
        octets() >= at_bound
    });
    client
        .stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut byte = [0u8; 1];
    let waiting = client.stream.read(&mut byte);
    assert!(
        matches!(&waiting, Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)),
        "the ping behind the frame past the bound waits unread for an acknowledgment: {waiting:?}"
    );
    assert_eq!(
        octets(),
        at_bound,
        "the connection read no frame past its bound while the host acknowledged nothing"
    );
    client
        .stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let mut held = Vec::new();
    while host.target.holding() > 0 {
        held.push(host.target.take());
    }
    let delivered: Vec<EventRec> = held
        .iter()
        .flat_map(|&batch| Host::read_events(batch))
        .collect();
    assert!(
        delivered.len() <= bound,
        "{} events reached the host before an acknowledgment",
        delivered.len()
    );
    for batch in held {
        host.ack(batch);
    }
    host.events.extend(delivered);

    for index in 0..1000 {
        let event = host.event();
        assert_eq!(
            (event.kind, event.conn, event.data),
            (EVENT_WS_MESSAGE, conn, payload(index)),
            "message {index}"
        );
    }
    assert_eq!(
        client.frame(),
        (0x8A, b"probe".to_vec()),
        "the ping is answered once reading resumes"
    );
    finisher.join().unwrap();
    host.drain(vec![(client, conn)], Vec::new());
}

#[test]
fn outbox_octets_count_in_the_cores_request_memory_budget() {
    let mut host = Host::start(r#"{"threads":1,"limits":{"requestMemoryPerCore":4194304}}"#);
    let mut client = Client::connect(&host.server);
    let (held, upgrade) = pipelined_behind_held(&host, &mut client, &handshake("/ws", ""));
    let conn = host.respond(upgrade, |exchange| {
        actions::ws_accept(upgrade, exchange, b"").unwrap()
    });
    eventually("the accept to run", || {
        testing::inspect(upgrade, |_| ()).is_err()
    });
    let message = vec![7u8; 1 << 20];
    for _ in 0..40 {
        realtime::ws_send(conn, OPCODE_BINARY, &message).unwrap();
    }
    assert!(realtime::ws_buffered(conn).unwrap() > 4 << 20);
    assert!(!realtime::ws_writable(conn).unwrap(), "past the mark");

    let mut late = Client::connect(&host.server);
    late.stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    late.send_get("/fixed");
    let mut byte = [0u8; 1];
    let waiting = late.stream.read(&mut byte);
    assert!(
        matches!(&waiting, Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)),
        "a core whose outboxes hold more than its budget serves no new connection: {waiting:?}"
    );

    host.respond(held, |exchange| {
        exchange.response().status(StatusCode::NO_CONTENT);
    });
    assert_eq!(client.read().unwrap().status, 204);
    assert_eq!(client.read().unwrap().status, 101);
    let mut client = WsClient {
        stream: client.stream,
    };
    for _ in 0..40 {
        let (first, payload) = client.frame();
        assert_eq!((first, payload.len()), (0x82, message.len()));
    }
    assert_eq!(host.event_of(conn).kind, EVENT_WS_OPEN);
    let drained = host.event_of(conn);
    assert_eq!((drained.kind, drained.conn), (EVENT_WS_DRAINED, conn));
    late.stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    assert_eq!(late.read().unwrap().text(), "fixed");
    host.drain(vec![(client, conn)], Vec::new());
}

#[test]
fn a_connection_whose_lease_ends_before_its_action_runs_is_closed() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut client = Client::connect(&host.server);
    client.send_get("/events");
    let slot = host.request();
    let conn = testing::respond(slot, |exchange| actions::sse_open(slot, exchange, 0))
        .unwrap()
        .unwrap();
    realtime::sse_send(conn, None, None, b"never sent").unwrap();
    assert!(realtime::sse_buffered(conn).unwrap() > 0);
    host.server.detach(host.worker).unwrap();
    assert_eq!(client.read().unwrap().status, 503);
    eventually("the reserved connection to close", || {
        realtime::sse_buffered(conn).is_err()
    });
    assert_eq!(
        realtime::sse_send(conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::Closed
    );
    stop(&host.server);
}

#[test]
fn an_accepted_connection_whose_head_is_never_written_closes_at_the_request_total() {
    let total = Duration::from_millis(1000);
    let mut host = Host::start(r#"{"threads":1,"limits":{"requestTotalMs":1000}}"#);
    let mut client = Client::connect(&host.server);
    let sent = Instant::now();
    let (_, stream) = pipelined_held_then_stream(&host, &mut client);
    let conn = open_behind(&host, stream);
    let closed = host.event_of(conn);
    assert_eq!(
        (closed.kind, closed.route),
        (EVENT_SSE_CLOSED, EVENTS),
        "the connection closes once the request total passes"
    );
    assert!(
        sent.elapsed() >= total,
        "the connection closed {:?} after its requests, before the request total",
        sent.elapsed()
    );
    assert_eq!(
        realtime::sse_send(conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::Closed
    );
    assert_eq!(
        client.read().unwrap().status,
        503,
        "the held request is answered at the request total"
    );
    assert!(
        read_rest(&mut client.stream).is_empty(),
        "the connection ends with no head of the stream"
    );
    stop(&host.server);
}

#[test]
fn a_draining_server_closes_websockets_with_1001_and_ends_streams_after_their_close_events() {
    let mut host = Host::start(r#"{"threads":1,"drainMs":30000}"#);
    let (mut socket, socket_conn) = host.websocket("/ws", "", b"");
    let (mut stream, stream_conn, _) = host.stream();
    realtime::ws_send(socket_conn, OPCODE_TEXT, b"last").unwrap();
    realtime::sse_send(stream_conn, None, None, b"last").unwrap();
    assert_eq!(socket.text(), "last");
    assert_eq!(read_event(&mut stream.stream), b"data: last\n\n");

    host.server.shutdown();
    assert_eq!(socket.frame(), (0x88, close_body(1001, "")));
    socket.send(0x88, &close_body(1001, ""));
    assert!(socket.closed());
    assert!(read_rest(&mut stream.stream).is_empty());
    let mut closes = [host.event(), host.event()];
    closes.sort_by_key(|event| event.kind);
    assert_eq!(
        (closes[0].kind, closes[0].conn, closes[0].code),
        (EVENT_WS_CLOSE, socket_conn, 1001)
    );
    assert_eq!(
        (closes[1].kind, closes[1].conn),
        (EVENT_SSE_CLOSED, stream_conn)
    );
    eventually("the server to stop", || !host.server.is_running());
}

#[test]
fn a_websocket_route_pings_at_its_interval_and_holds_messages_to_its_max_payload() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let (mut pinged, pinged_conn) = host.websocket("/ping", "", b"");
    for _ in 0..2 {
        assert_eq!(pinged.frame(), (0x89, Vec::new()), "the route's ping");
        pinged.send(0x8A, b"");
        let pong = host.event();
        assert_eq!(
            (pong.kind, pong.conn, pong.route),
            (EVENT_WS_PONG, pinged_conn, PING)
        );
    }
    drop(pinged);
    assert_eq!(host.event().kind, EVENT_WS_CLOSE);

    let (mut small, small_conn) = host.websocket("/small", "", b"");
    small.send(0x81, b"four");
    let fits = host.event();
    assert_eq!(
        (fits.kind, fits.route, fits.data.as_slice()),
        (EVENT_WS_MESSAGE, SMALL, b"four".as_slice())
    );
    small.send(0x81, b"fives");
    assert_eq!(
        small.frame(),
        (0x88, close_body(1009, "")),
        "a message past the route's maxPayload fails the connection with 1009"
    );
    let close = host.event();
    assert_eq!(
        (close.kind, close.conn, close.code),
        (EVENT_WS_CLOSE, small_conn, 1006),
        "the peer sent no Close"
    );
    stop(&host.server);
}

#[test]
fn every_realtime_call_refuses_an_id_out_of_range_and_one_no_connection_has() {
    let ids = [(0, Status::Closed), (u64::MAX, Status::InvalidArgument)];
    for (conn, status) in ids {
        assert_eq!(
            realtime::ws_send(conn, OPCODE_TEXT, b"x")
                .unwrap_err()
                .status(),
            status
        );
        assert_eq!(realtime::ws_ping(conn, b"").unwrap_err().status(), status);
        assert_eq!(
            realtime::ws_close(conn, 1000, b"").unwrap_err().status(),
            status
        );
        assert_eq!(realtime::ws_terminate(conn).unwrap_err().status(), status);
        assert_eq!(realtime::ws_writable(conn).unwrap_err().status(), status);
        assert_eq!(realtime::ws_buffered(conn).unwrap_err().status(), status);
        assert_eq!(
            realtime::sse_comment(conn, b"x").unwrap_err().status(),
            status
        );
        assert_eq!(realtime::sse_retry(conn, 1).unwrap_err().status(), status);
        assert_eq!(realtime::sse_close(conn).unwrap_err().status(), status);
        assert_eq!(realtime::sse_writable(conn).unwrap_err().status(), status);
        assert_eq!(
            realtime::room_join(conn, b"r").unwrap_err().status(),
            status
        );
        assert_eq!(
            realtime::room_leave(conn, b"r").unwrap_err().status(),
            status
        );
    }
}

/// The slots of two pipelined requests of `client`: one the test holds unanswered,
/// and `behind`, whose response head waits for the held response however much the
/// sockets buffer, since responses go out in the order of their requests (RFC 9112
/// Section 9.3.2).
fn pipelined_behind_held(host: &Host, client: &mut Client, behind: &str) -> (u64, u64) {
    client.send(format!("GET /events?held HTTP/1.1\r\nHost: t\r\n\r\n{behind}").as_bytes());
    let mut slots = Vec::new();
    while slots.len() < 2 {
        let batch = host.target.take();
        assert_eq!(batch.kind, BATCH_REQUESTS);
        slots.extend(ids(batch));
        host.ack(batch);
    }
    let held = |slot: u64| {
        testing::inspect(slot, |exchange| exchange.request().query().is_some()).unwrap()
    };
    if held(slots[0]) {
        (slots[0], slots[1])
    } else {
        (slots[1], slots[0])
    }
}

/// The slots of a held request and of the event stream pipelined behind it.
fn pipelined_held_then_stream(host: &Host, client: &mut Client) -> (u64, u64) {
    pipelined_behind_held(host, client, "GET /events HTTP/1.1\r\nHost: t\r\n\r\n")
}

/// Open an event stream on the leased request `stream` and wait until its action ran.
fn open_behind(host: &Host, stream: u64) -> u64 {
    let conn = host.respond(stream, |exchange| {
        actions::sse_open(stream, exchange, 0).unwrap()
    });
    eventually("the stream's action to run", || {
        testing::inspect(stream, |_| ()).is_err()
    });
    conn
}

#[test]
fn the_close_event_of_a_connection_that_never_started_waits_for_room_in_a_full_event_queue() {
    let mut host = Host::start(
        r#"{"threads":1,"maxBatchSize":1,"maxQueuedBatches":1,"maxBatchesInFlight":2}"#,
    );
    let mut socket = WsClient::handshake(&host.server, "/ws", "");
    let slot = host.request();
    let socket_conn = host.respond(slot, |exchange| {
        actions::ws_accept(slot, exchange, b"").unwrap()
    });
    assert_eq!(socket.head().0, 101);
    let opened = host.target.take();
    assert_eq!(Host::read_events(opened)[0].kind, EVENT_WS_OPEN);
    let mut stream = Client::connect(&host.server);
    stream.send_get("/events");
    let request = host.target.take();
    assert_eq!(request.kind, BATCH_REQUESTS);
    let stream_slot = ids(request)[0];

    // Both batches stay in flight, so the message's event fills the queue; the pong
    // shows the connection read the message before the ping.
    socket.send(0x81, b"queued");
    socket.send(0x89, b"sync");
    assert_eq!(socket.frame(), (0x8A, b"sync".to_vec()));
    let stream_conn = host.respond(stream_slot, |exchange| {
        exchange.response().status(StatusCode::NO_CONTENT);
        actions::sse_open(stream_slot, exchange, 0).unwrap()
    });
    assert_eq!(stream.read().unwrap().status, 204);
    assert_eq!(
        realtime::sse_send(stream_conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::Closed,
        "a 204 carries no stream"
    );

    host.ack(opened);
    host.ack(request);
    let message = host.event_of(socket_conn);
    assert_eq!(
        (message.kind, message.data.as_slice()),
        (EVENT_WS_MESSAGE, b"queued".as_slice())
    );
    socket.send(0x88, &close_body(1000, ""));
    assert_eq!(socket.frame(), (0x88, close_body(1000, "")));
    assert_eq!(host.event_of(socket_conn).kind, EVENT_WS_CLOSE);
    let stream_events: Vec<u8> = host
        .events
        .iter()
        .filter(|event| event.conn == stream_conn)
        .map(|event| event.kind)
        .collect();
    assert_eq!(
        stream_events,
        [EVENT_SSE_CLOSED],
        "the stream's close event waited for room and came before the WebSocket's"
    );
    stop(&host.server);
}

#[test]
fn a_connection_reserved_when_its_core_ends_closes_and_the_next_server_on_its_index_reports_none_of_it(
) {
    let _alone = alone();
    let first = start(&app(), r#"{"threads":1,"drainMs":300}"#);
    let worker = first.workers()[0];
    let target = TestTarget::new(8);
    first.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    let client = WsClient::handshake(&first, "/ws", "");
    let batch = target.take();
    let slot = ids(batch)[0];
    complete(worker, &[], batch.epoch, None).unwrap();
    let conn = testing::respond(slot, |exchange| actions::ws_accept(slot, exchange, b""))
        .unwrap()
        .unwrap();
    realtime::ws_send(conn, OPCODE_TEXT, &[b'x'; 1024]).unwrap();
    first.shutdown();
    eventually("the first server to stop at its drain deadline", || {
        !first.is_running()
    });
    assert_eq!(
        realtime::ws_send(conn, OPCODE_TEXT, b"late")
            .unwrap_err()
            .status(),
        Status::Closed,
        "the connection reserved by a lease its core dropped is closed"
    );
    assert_eq!(
        realtime::ws_buffered(conn).unwrap_err().status(),
        Status::Closed
    );
    drop((client, first));

    let mut second = Host::attached_first(r#"{"threads":1}"#);
    assert_eq!(second.worker, worker, "the index went back to the pool");
    let (client, own) = second.websocket("/ws", "", b"");
    assert!(
        second.events.iter().all(|event| event.conn != conn),
        "the second server reports nothing of the first one's connection: {:?}",
        second.events
    );
    assert_ne!(own, conn);
    drop(client);
    stop(&second.server);
}

#[test]
fn a_connection_whose_head_waits_when_its_core_ends_is_closed() {
    let host = Host::start(r#"{"threads":1,"drainMs":300}"#);
    let mut client = Client::connect(&host.server);
    let (_, stream) = pipelined_held_then_stream(&host, &mut client);
    let conn = open_behind(&host, stream);
    realtime::sse_send(conn, None, None, b"queued").unwrap();
    host.server.shutdown();
    eventually("the server to stop at its drain deadline", || {
        !host.server.is_running()
    });
    assert_eq!(
        realtime::sse_send(conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::Closed,
        "the claim its core dropped is closed"
    );
    assert_eq!(
        realtime::sse_buffered(conn).unwrap_err().status(),
        Status::Closed
    );
    drop(client);
}

#[test]
fn the_stream_and_websocket_actions_by_slot_id_open_connections_and_refuse_a_stale_id_a_sealed_response_and_an_open_region(
) {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut stream = Client::connect(&host.server);
    stream.send_get("/events");
    let slot = host.request();
    let stream_conn = access::sse_open(slot, 0).unwrap();
    complete(host.worker, &[slot], 0, None).unwrap();
    assert_eq!(stream.read().unwrap().status, 200);
    realtime::sse_send(stream_conn, None, None, b"by id").unwrap();
    assert_eq!(read_event(&mut stream.stream), b"data: by id\n\n");
    assert_eq!(
        access::sse_open(slot, 0).unwrap_err().status(),
        Status::Closed,
        "an id whose request was answered is stale"
    );

    let mut socket = WsClient::handshake(&host.server, "/ws", "Sec-WebSocket-Protocol: chat\r\n");
    let slot = host.request();
    let socket_conn = access::ws_accept(slot, b"chat").unwrap();
    complete(host.worker, &[slot], 0, None).unwrap();
    let (status, headers) = socket.head();
    assert_eq!(
        (status, header(&headers, "sec-websocket-protocol")),
        (101, Some("chat"))
    );
    assert_eq!(host.event_of(socket_conn).kind, EVENT_WS_OPEN);
    assert_eq!(
        access::ws_accept(slot, b"").unwrap_err().status(),
        Status::Closed,
        "an id whose request was answered is stale"
    );

    for region in [false, true] {
        let mut late = Client::connect(&host.server);
        late.send_get("/events");
        let slot = host.request();
        let expected = if region {
            access::pin(slot).unwrap();
            access::body_alloc(slot, 4).unwrap();
            Status::InvalidArgument
        } else {
            access::send(slot).unwrap();
            Status::Closed
        };
        assert_eq!(
            access::sse_open(slot, 0).unwrap_err().status(),
            expected,
            "region {region}"
        );
        assert_eq!(
            access::ws_accept(slot, b"").unwrap_err().status(),
            expected,
            "region {region}"
        );
        if region {
            access::send(slot).unwrap();
            access::unpin(slot).unwrap();
        }
        complete(host.worker, &[slot], 0, None).unwrap();
        let reply = late.read().unwrap();
        assert_eq!(
            (reply.status, reply.header("content-type")),
            (200, None),
            "no stream was opened, region {region}"
        );
    }
    host.drain(vec![(socket, socket_conn)], vec![(stream, stream_conn)]);
}

#[test]
fn a_host_thread_that_reserves_after_its_server_stopped_and_the_next_started_is_refused_and_never_reported(
) {
    let _alone = alone();
    let first = start(&app(), r#"{"threads":1,"drainMs":300}"#);
    let worker = first.workers()[0];
    let target = TestTarget::new(8);
    first.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    let mut client = Client::connect(&first);
    client.send_get("/events");
    let batch = target.take();
    let slot = ids(batch)[0];
    complete(worker, &[], batch.epoch, None).unwrap();

    let (checked, on_lock) = mpsc::channel();
    let (resume, resumed) = mpsc::channel::<()>();
    let host_thread = thread::spawn(move || {
        testing::respond(slot, move |exchange| {
            let _ = checked.send(());
            let _ = resumed.recv();
            actions::sse_open(slot, exchange, 0).map_err(|err| err.status())
        })
    });
    on_lock
        .recv_timeout(Duration::from_secs(10))
        .expect("the host thread holds the slot's lock past its check");
    first.shutdown();
    eventually("the first server to stop at its drain deadline", || {
        !first.is_running()
    });
    drop(client);
    let mut second = Host::attached_first(r#"{"threads":1}"#);
    assert_eq!(second.worker, worker, "the index went back to the pool");

    resume.send(()).unwrap();
    let reserved = host_thread.join().unwrap().unwrap();
    assert_eq!(
        reserved,
        Err(Status::Closed),
        "the lease ended before the connection was reserved"
    );
    let (socket, own) = second.websocket("/ws", "", b"");
    assert!(
        second
            .events
            .iter()
            .all(|event| event.kind != EVENT_SSE_CLOSED),
        "the second server reports no stream it never opened: {:?}",
        second.events
    );
    second.drain(vec![(socket, own)], Vec::new());
}

#[test]
fn a_connection_the_driver_lets_go_of_before_its_head_is_written_closes_at_once() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut client = Client::connect(&host.server);
    let (held, stream) = pipelined_held_then_stream(&host, &mut client);
    let conn = open_behind(&host, stream);
    realtime::sse_send(conn, None, None, b"queued").unwrap();
    let ahead = host.respond(held, |exchange| {
        actions::sse_open(held, exchange, 0).unwrap()
    });
    let closed = host.event_of(conn);
    assert_eq!(
        (closed.kind, closed.route),
        (EVENT_SSE_CLOSED, EVENTS),
        "the claim the driver dropped closes now, not at the request total"
    );
    assert_eq!(
        realtime::sse_send(conn, None, None, b"x")
            .unwrap_err()
            .status(),
        Status::Closed
    );
    assert_eq!(
        client.read().unwrap().status,
        200,
        "the head of the stream ahead"
    );
    realtime::sse_send(ahead, None, None, b"ahead").unwrap();
    assert_eq!(
        read_event(&mut client.stream),
        b"data: ahead\n\n",
        "the stream ahead took the connection, with no head of the one behind it"
    );
    drop(client);
    stop(&host.server);
}

#[test]
fn an_action_that_names_a_connection_reserved_for_another_core_is_answered_500() {
    let _indexes = sharing();
    let server = start(&app(), r#"{"threads":2}"#);
    let workers = server.workers().to_vec();
    let done = Arc::new(AtomicBool::new(false));
    let (sender, slots) = mpsc::channel();
    let hosts: Vec<_> = workers
        .iter()
        .map(|&worker| {
            let target = TestTarget::new(8);
            server.attach(worker, target.clone()).unwrap();
            let (done, sender) = (Arc::clone(&done), sender.clone());
            thread::spawn(move || {
                bind_thread(worker).unwrap();
                while !done.load(Ordering::Acquire) {
                    if target.holding() == 0 {
                        thread::yield_now();
                        continue;
                    }
                    let batch = target.take();
                    if batch.kind == BATCH_REQUESTS {
                        for slot in ids(batch) {
                            let _ = sender.send((worker, slot));
                        }
                    } else {
                        let _ = Host::read_events(batch);
                    }
                    complete(worker, &[], batch.epoch, None).unwrap();
                }
            })
        })
        .collect();

    let mut clients = Vec::new();
    let mut first: [Option<(u64, usize)>; 2] = [None, None];
    while first.iter().any(Option::is_none) {
        assert!(clients.len() < 64, "every connection reached one core");
        clients.push(WsClient::handshake(&server, "/ws", ""));
        let (worker, slot) = slots.recv_timeout(Duration::from_secs(10)).unwrap();
        let core = workers.iter().position(|&each| each == worker).unwrap();
        if first[core].is_none() {
            first[core] = Some((slot, clients.len() - 1));
        } else {
            testing::respond(slot, |exchange| {
                exchange.response().status(StatusCode::FORBIDDEN);
            })
            .unwrap();
            complete(worker, &[slot], 0, None).unwrap();
        }
    }
    let [Some((ours, our_client)), Some((theirs, their_client))] = first else {
        unreachable!("both cores leased a request");
    };
    testing::respond(ours, |exchange| actions::ws_accept(theirs, exchange, b""))
        .unwrap()
        .unwrap();
    complete(workers[0], &[ours], 0, None).unwrap();
    assert_eq!(
        clients[our_client].head().0,
        500,
        "the action named a connection reserved on the other core"
    );

    let own = testing::respond(theirs, |exchange| actions::ws_accept(theirs, exchange, b""))
        .unwrap()
        .unwrap();
    complete(workers[1], &[theirs], 0, None).unwrap();
    assert_eq!(clients[their_client].head().0, 101);
    realtime::ws_send(own, OPCODE_TEXT, b"own").unwrap();
    assert_eq!(clients[their_client].text(), "own");

    done.store(true, Ordering::Release);
    for host in hosts {
        host.join().unwrap();
    }
    drop(clients);
    stop(&server);
}

#[test]
fn a_connection_claimed_during_the_drain_closes_within_the_close_timeout_of_the_drain() {
    let mut host = Host::start(r#"{"threads":1,"drainMs":30000}"#);
    let mut client = Client::connect(&host.server);
    let (held, stream) = pipelined_held_then_stream(&host, &mut client);
    let asked = Instant::now();
    host.server.shutdown();
    let conn = open_behind(&host, stream);
    let closed = host.event_of(conn);
    assert_eq!(
        (closed.kind, closed.route),
        (EVENT_SSE_CLOSED, EVENTS),
        "the claim made while draining closes at the drain's cap, not at the request total"
    );
    assert!(
        asked.elapsed() >= zero_realtime::websocket::CLOSE_TIMEOUT,
        "the claim closed {:?} after the shutdown, before the drain's cap",
        asked.elapsed()
    );
    host.respond(held, |exchange| {
        exchange.response().body(b"held");
    });
    drop(client);
    eventually("the server to stop", || !host.server.is_running());
    assert!(
        asked.elapsed() < zero_realtime::websocket::CLOSE_TIMEOUT * 3,
        "the drain ended {:?} after the shutdown, short of its 30 s deadline",
        asked.elapsed()
    );
}

#[test]
fn a_failed_host_dispatch_closes_the_connections_still_waiting_for_their_action() {
    let mut host = Host::start(r#"{"threads":1}"#);
    let mut client = Client::connect(&host.server);
    client.send_get("/events");
    let slot = host.request();
    let conn = testing::respond(slot, |exchange| actions::sse_open(slot, exchange, 0))
        .unwrap()
        .unwrap();
    realtime::sse_send(conn, None, None, b"never sent").unwrap();
    testing::panic_next_turn(&host.server, host.worker).unwrap();
    assert_eq!(
        client.read().unwrap().status,
        500,
        "the waiting lease fails"
    );
    assert_eq!(
        realtime::sse_buffered(conn).unwrap_err().status(),
        Status::Closed,
        "no dispatcher is left to close the reservation later"
    );
    stop(&host.server);
}

#[test]
fn event_octets_the_host_has_not_acknowledged_count_in_the_cores_request_memory_budget() {
    let mut host = Host::start(r#"{"threads":1,"limits":{"requestMemoryPerCore":4194304}}"#);
    let (mut client, conn) = host.websocket("/ws", "", b"");
    let large = vec![5u8; 5 << 20];
    client.send(0x82, &large);
    client.send(0x81, b"after");
    let batch = host.target.take();
    let held = Host::read_events(batch);
    assert_eq!(
        held.iter()
            .map(|event| (event.kind, event.conn, event.data.len()))
            .collect::<Vec<_>>(),
        [(EVENT_WS_MESSAGE, conn, large.len())],
        "the connection stopped reading once its core held more than half its budget"
    );

    let mut late = Client::connect(&host.server);
    late.stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    late.send_get("/fixed");
    let mut byte = [0u8; 1];
    let waiting = late.stream.read(&mut byte);
    assert!(
        matches!(&waiting, Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)),
        "a core holding more unacknowledged event octets than its budget serves no new connection: {waiting:?}"
    );
    assert_eq!(
        host.target.holding(),
        0,
        "nothing more was read before the acknowledgment"
    );

    host.ack(batch);
    let after = host.event_of(conn);
    assert_eq!(
        (after.kind, after.data.as_slice()),
        (EVENT_WS_MESSAGE, b"after".as_slice())
    );
    late.stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    assert_eq!(late.read().unwrap().text(), "fixed");
    host.drain(vec![(client, conn)], Vec::new());
}
