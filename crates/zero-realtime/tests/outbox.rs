//! Outboxes end to end, over the HTTP/1.1 driver: frames and events pushed from plain
//! threads, the order of Close, Terminate, Join and Leave against them, pongs and
//! the drained signal, the per-connection and per-worker limits, the worker's
//! counter, the outbox closing with its connection, what a draining server sends
//! before it ends WebSocket connections and event streams, and a paused WebSocket
//! that reads nothing while it still writes and shuts down. The streams count the
//! socket reads they start, so a test sees a socket left unread and not only that
//! no message surfaced.

use std::collections::HashMap;
use std::future::Future;
use std::io::{self, IoSlice, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use zero_core::{Error, OwnedBuf};
use zero_http::{serve_with, Accept, Call, Config, Handler, Prepared, TakeOver, Taken, Workers};
use zero_http_types::StatusCode;
use zero_io::pool::Pool;
use zero_io::seam::{Leased, Shutdown, Stream};
use zero_limits::{Http1Limits, WebSocketLimits};
use zero_realtime::{
    accept_websocket, start_event_stream, Command, Drained, EventStream, Incoming, MemberId,
    Message, Outbox, OutboxTotal, ReadPause, Rooms, WebSocket, HIGH_WATER, INBOX_BYTES,
    LIMIT_FACTOR,
};
use zero_sse::{encode, Decoder, Event};
use zero_ws::frame::{self, Opcode};
use zero_ws::handshake::Config as WsConfig;
use zero_ws::CloseCode;

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const MASK: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

/// The token of the stream that writes pre-encoded events itself.
const ENCODED: u64 = 0;

/// What every core's handler shares with the test.
struct Shared {
    log: Mutex<Vec<String>>,
    outboxes: Mutex<HashMap<u64, Arc<Outbox>>>,
    pauses: Mutex<HashMap<u64, ReadPause>>,
    totals: Mutex<Vec<Arc<OutboxTotal>>>,
    rooms: Arc<Rooms>,
    high_water: u64,
    gate: Gate,
}

/// The socket reads each connection started, by the client's address.
type Reads = Arc<Mutex<Vec<(SocketAddr, Arc<AtomicU64>)>>>;

/// A stream that counts the reads it starts.
struct Counted {
    inner: zero_io::rt::TcpStream,
    reads: Arc<AtomicU64>,
}

impl Stream for Counted {
    fn readable(&self) -> impl Future<Output = io::Result<()>> {
        self.inner.readable()
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inner.read_leased(pool).await
    }

    fn read_into(&self, buf: OwnedBuf) -> impl Future<Output = (io::Result<usize>, OwnedBuf)> {
        self.inner.read_into(buf)
    }

    fn write(&self, buf: OwnedBuf) -> impl Future<Output = (io::Result<usize>, OwnedBuf)> {
        self.inner.write(buf)
    }

    async fn writev(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        self.inner.writev(bufs).await
    }

    fn shutdown_write(&self) -> io::Result<()> {
        self.inner.shutdown_write()
    }

    fn close_write(&self) -> impl Future<Output = io::Result<()>> {
        self.inner.close_write()
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        self.inner.peer_addr()
    }
}

/// Hands every connection over as a [`Counted`] stream and keeps its counter.
struct Counting(Reads);

impl Accept for Counting {
    type Stream = Counted;

    fn accept(
        self: Rc<Self>,
        stream: zero_io::rt::TcpStream,
        peer: SocketAddr,
    ) -> impl Future<Output = io::Result<Prepared<Counted>>> + 'static {
        let reads = Arc::new(AtomicU64::new(0));
        self.0.lock().unwrap().push((peer, Arc::clone(&reads)));
        std::future::ready(Ok(Prepared::any_host(Counted {
            inner: stream,
            reads,
        })))
    }
}

/// Holds a core's thread inside a handler until the test opens it, so that what
/// the test does meanwhile reaches a connection task all at once.
#[derive(Default)]
struct Gate {
    entered: AtomicBool,
    open: Mutex<bool>,
    opened: Condvar,
}

impl Gate {
    fn hold(&self) {
        self.entered.store(true, Ordering::Release);
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.opened.wait(open).unwrap();
        }
    }

    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }
}

impl Shared {
    fn note(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }
}

struct App {
    shared: Arc<Shared>,
    total: Arc<OutboxTotal>,
}

impl App {
    fn outbox(&self, token: u64) -> Arc<Outbox> {
        let outbox = Arc::new(Outbox::with_high_water(
            Arc::clone(&self.total),
            self.shared.high_water,
        ));
        self.shared
            .outboxes
            .lock()
            .unwrap()
            .insert(token, Arc::clone(&outbox));
        self.shared
            .pauses
            .lock()
            .unwrap()
            .insert(token, ReadPause::new());
        outbox
    }
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let path = String::from_utf8_lossy(call.request().path()).into_owned();
        if let Some(token) = path.strip_prefix("/ws/") {
            let token = token.parse().unwrap();
            let outbox = self.outbox(token);
            if !accept_websocket(call, &WsConfig::default(), token)? {
                outbox.close();
            }
        } else if let Some(token) = path.strip_prefix("/sse/") {
            let outbox = self.outbox(token.parse().unwrap());
            outbox
                .push(Command::Frame(event("opened", "-").into()))
                .unwrap();
            start_event_stream(call, token.parse().unwrap())?;
        } else if path == "/encoded" {
            start_event_stream(call, ENCODED)?;
        } else if path == "/hold" {
            self.shared.gate.hold();
            call.response().status(StatusCode::NO_CONTENT);
        } else {
            call.response().status(StatusCode::NOT_FOUND);
        }
        Ok(())
    }

    fn taken<S: Stream + 'static>(&self, taken: Taken<S>) -> impl Future<Output = ()> {
        let shared = Arc::clone(&self.shared);
        async move {
            let token = taken.token();
            if token == ENCODED {
                let mut stream = EventStream::new(taken, 60_000);
                let tick = event("tick", "one\ntwo");
                let first = stream.send_encoded(&tick).await;
                let second = stream.send_encoded(&tick).await;
                shared.note(format!("encoded {} {}", first.is_ok(), second.is_ok()));
                return;
            }
            let Some(outbox) = shared.outboxes.lock().unwrap().get(&token).cloned() else {
                return;
            };
            let pause = shared.pauses.lock().unwrap().get(&token).cloned();
            match taken.kind() {
                TakeOver::Upgrade => {
                    let mut ws = WebSocket::new(taken, WebSocketLimits::DEFAULT)
                        .with_outbox(outbox, &shared.rooms)
                        .with_read_pause(pause.unwrap_or_default());
                    while let Some(incoming) = ws.recv_event().await {
                        let line = match incoming {
                            Incoming::Message(Message::Text(text)) => format!("text {text}"),
                            Incoming::Message(Message::Binary(data)) => {
                                format!("binary {}", data.len())
                            }
                            Incoming::Pong(data) => {
                                format!("pong {}", String::from_utf8_lossy(&data))
                            }
                            Incoming::Drained => "drained".to_owned(),
                        };
                        shared.note(format!("{token} {line}"));
                    }
                    let code = ws.close_code().map(|code| code.0);
                    shared.note(format!("reason of {token} {:?}", ws.close_reason()));
                    shared.note(format!("{token} closed {code:?}"));
                }
                TakeOver::Stream => {
                    let mut stream = EventStream::new(taken, 60_000).with_outbox(outbox);
                    while let Some(Drained) = stream.serve().await {
                        shared.note(format!("{token} drained"));
                    }
                    shared.note(format!("{token} closed"));
                }
            }
        }
    }
}

struct Server {
    workers: Option<Workers>,
    addr: SocketAddr,
    shared: Arc<Shared>,
    reads: Reads,
}

impl Server {
    fn start(threads: usize, high_water: u64) -> Self {
        let shared = Arc::new(Shared {
            log: Mutex::new(Vec::new()),
            outboxes: Mutex::new(HashMap::new()),
            pauses: Mutex::new(HashMap::new()),
            totals: Mutex::new(Vec::new()),
            rooms: Arc::new(Rooms::new()),
            high_water,
            gate: Gate::default(),
        });
        let config = Config {
            runtime: zero_rt::Config {
                io: zero_io::rt::Config {
                    threads,
                    drain: Duration::from_secs(3),
                    ..zero_io::rt::Config::default()
                },
            },
            limits: Http1Limits::DEFAULT,
            server: None,
        };
        let app_shared = Arc::clone(&shared);
        let reads: Reads = Arc::new(Mutex::new(Vec::new()));
        let accepted = Arc::clone(&reads);
        let workers = serve_with(
            "127.0.0.1:0".parse().unwrap(),
            config,
            Arc::new(|_| {}),
            move |_worker| {
                let total = Arc::new(OutboxTotal::default());
                app_shared.totals.lock().unwrap().push(Arc::clone(&total));
                App {
                    shared: Arc::clone(&app_shared),
                    total,
                }
            },
            move |_| Counting(Arc::clone(&accepted)),
        )
        .unwrap();
        let addr = workers.local_addr();
        Server {
            workers: Some(workers),
            addr,
            shared,
            reads,
        }
    }

    /// The pause of the WebSocket registered under `token`.
    fn pause(&self, token: u64) -> ReadPause {
        let mut found = None;
        wait_for(|| {
            found = self.shared.pauses.lock().unwrap().get(&token).cloned();
            found.is_some()
        });
        found.unwrap()
    }

    /// The socket reads the server started on `conn`.
    fn reads_of(&self, conn: &TcpStream) -> u64 {
        let local = conn.local_addr().unwrap();
        self.reads
            .lock()
            .unwrap()
            .iter()
            .find(|(peer, _)| *peer == local)
            .map(|(_, count)| count.load(Ordering::SeqCst))
            .unwrap()
    }

    /// The lines logged so far that start with `prefix`, in order.
    fn lines(&self, prefix: &str) -> Vec<String> {
        self.shared
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.starts_with(prefix))
            .cloned()
            .collect()
    }

    fn connect(&self) -> TcpStream {
        let conn = TcpStream::connect(self.addr).unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        conn.set_nodelay(true).unwrap();
        conn
    }

    /// A WebSocket connection whose outbox is registered under `token`.
    fn websocket(&self, token: u64) -> (TcpStream, Arc<Outbox>) {
        let mut conn = self.connect();
        let request = format!(
            "GET /ws/{token} HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        conn.write_all(request.as_bytes()).unwrap();
        assert_eq!(read_head(&mut conn), 101);
        (conn, self.outbox(token))
    }

    /// An event stream whose outbox is registered under `token`.
    fn event_stream(&self, token: u64) -> (TcpStream, Arc<Outbox>) {
        let mut conn = self.connect();
        conn.write_all(format!("GET /sse/{token} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes())
            .unwrap();
        assert_eq!(read_head(&mut conn), 200);
        (conn, self.outbox(token))
    }

    fn outbox(&self, token: u64) -> Arc<Outbox> {
        let mut found = None;
        wait_for(|| {
            found = self.shared.outboxes.lock().unwrap().get(&token).cloned();
            found.is_some()
        });
        found.unwrap()
    }

    fn rooms(&self) -> Arc<Rooms> {
        Arc::clone(&self.shared.rooms)
    }

    /// Hold the core's thread in a handler, run `meanwhile`, then let it go: what
    /// `meanwhile` does reaches the connection tasks of that core together.
    fn while_held(&self, meanwhile: impl FnOnce()) -> TcpStream {
        let mut conn = self.connect();
        conn.write_all(b"GET /hold HTTP/1.1\r\nHost: t\r\n\r\n")
            .unwrap();
        wait_for(|| self.shared.gate.entered.load(Ordering::Acquire));
        meanwhile();
        self.shared.gate.release();
        conn
    }

    fn request_shutdown(&self) {
        if let Some(workers) = self.workers.as_ref() {
            workers.shutdown_handle().request();
        }
    }

    fn logged(&self, line: &str) -> bool {
        self.shared
            .log
            .lock()
            .unwrap()
            .iter()
            .any(|seen| seen == line)
    }

    fn count(&self, line: &str) -> usize {
        self.shared
            .log
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| *seen == line)
            .count()
    }

    fn queued(&self) -> u64 {
        self.shared
            .totals
            .lock()
            .unwrap()
            .iter()
            .map(|total| total.queued())
            .sum()
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

/// Read a response head; returns its status.
fn read_head(conn: &mut TcpStream) -> u16 {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        conn.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    let text = String::from_utf8(bytes).unwrap();
    text.split(' ').nth(1).unwrap().parse().unwrap()
}

/// A frame as a client sends it: masked, the length in its minimal form.
fn client(first: u8, payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() <= 125);
    let mut out = vec![first, 0x80 | payload.len() as u8];
    out.extend_from_slice(&MASK);
    out.extend(payload.iter().zip(MASK.iter().cycle()).map(|(b, k)| b ^ k));
    out
}

/// Read one server frame: the first byte and the payload; the server never masks.
fn read_frame(conn: &mut TcpStream) -> (u8, Vec<u8>) {
    let mut head = [0u8; 2];
    conn.read_exact(&mut head).unwrap();
    assert_eq!(head[1] & 0x80, 0, "a server frame is never masked");
    let len = match head[1] & 0x7F {
        126 => {
            let mut wide = [0u8; 2];
            conn.read_exact(&mut wide).unwrap();
            usize::from(u16::from_be_bytes(wide))
        }
        127 => {
            let mut wide = [0u8; 8];
            conn.read_exact(&mut wide).unwrap();
            usize::try_from(u64::from_be_bytes(wide)).unwrap()
        }
        short => usize::from(short),
    };
    let mut payload = vec![0u8; len];
    conn.read_exact(&mut payload).unwrap();
    (head[0], payload)
}

fn text(conn: &mut TcpStream) -> String {
    let (first, payload) = read_frame(conn);
    assert_eq!(first, 0x81);
    String::from_utf8(payload).unwrap()
}

fn closed(conn: &mut TcpStream) -> bool {
    let mut byte = [0u8; 1];
    matches!(conn.read(&mut byte), Ok(0))
}

fn close_body(code: u16, reason: &str) -> Vec<u8> {
    let mut body = code.to_be_bytes().to_vec();
    body.extend_from_slice(reason.as_bytes());
    body
}

/// An encoded text message, as a host thread builds it.
fn message(text: &str) -> Command {
    let mut out = Vec::new();
    frame::write_message(Opcode::Text, text.as_bytes(), &mut out).unwrap();
    Command::Frame(out.into())
}

/// An encoded binary message of `len` octets that starts with `index`.
fn binary(index: u32, len: usize) -> Command {
    let mut payload = vec![7u8; len];
    payload[..4].copy_from_slice(&index.to_be_bytes());
    let mut out = Vec::new();
    frame::write_message(Opcode::Binary, &payload, &mut out).unwrap();
    Command::Frame(out.into())
}

/// An encoded event.
fn event(name: &str, data: &str) -> Vec<u8> {
    let mut out = Vec::new();
    encode(
        &Event {
            event: Some(name),
            data: Some(data),
            ..Event::default()
        },
        &mut out,
    )
    .unwrap();
    out
}

/// Read one event's bytes, up to and including the blank line that ends it.
fn read_event(conn: &mut TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while !bytes.ends_with(b"\n\n") {
        conn.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    bytes
}

/// The events of a stream, as a client decodes them: type and data.
fn events(body: &[u8]) -> Vec<(String, String)> {
    let mut decoder = Decoder::new(1 << 24);
    let mut seen = Vec::new();
    decoder.feed(body, &mut seen).unwrap();
    seen.into_iter()
        .map(|message| (message.event, message.data))
        .collect()
}

/// Poll until `done` holds, for state another thread settles.
fn wait_for(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::yield_now();
    }
}

/// Close from the client side and wait for the server's answer and the end.
fn close_from_client(conn: &mut TcpStream, code: u16) {
    conn.write_all(&client(0x88, &close_body(code, "")))
        .unwrap();
    assert_eq!(read_frame(conn), (0x88, close_body(code, "")));
    assert!(closed(conn));
}

#[test]
fn frames_pushed_from_a_plain_thread_arrive_in_order() {
    let server = Server::start(2, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(1);
    let pusher = std::thread::spawn(move || {
        for index in 0..500 {
            outbox.push(message(&format!("m{index}"))).unwrap();
        }
    });
    for index in 0..500 {
        assert_eq!(text(&mut conn), format!("m{index}"));
    }
    pusher.join().unwrap();
    conn.write_all(&client(0x81, b"done")).unwrap();
    wait_for(|| server.logged("1 text done"));
    close_from_client(&mut conn, 1000);
    wait_for(|| server.logged("1 closed Some(1000)"));
    server.stop().unwrap();
}

#[test]
fn a_close_pushed_after_frames_goes_out_after_them_and_later_pushes_are_refused() {
    let server = Server::start(2, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(2);
    outbox.push(message("a")).unwrap();
    outbox.push(message("b")).unwrap();
    outbox
        .push(Command::Close {
            code: CloseCode::NORMAL,
            reason: "bye".to_owned(),
        })
        .unwrap();
    assert!(matches!(outbox.push(message("c")), Err(Error::Closed)));
    assert!(matches!(
        outbox.push(Command::Join("late".to_owned())),
        Err(Error::Closed)
    ));
    assert_eq!(text(&mut conn), "a");
    assert_eq!(text(&mut conn), "b");
    assert_eq!(read_frame(&mut conn), (0x88, close_body(1000, "bye")));
    conn.write_all(&client(0x88, &close_body(1000, "")))
        .unwrap();
    assert!(closed(&mut conn), "nothing follows the Close");
    wait_for(|| server.logged("2 closed Some(1000)"));
    assert!(outbox.is_closed());
    assert_eq!(outbox.buffered(), 0);
    assert_eq!(server.rooms().members("late"), 0);
    server.stop().unwrap();
}

#[test]
fn a_terminate_pushed_after_frames_ends_the_connection_after_them_without_a_close_frame() {
    let server = Server::start(2, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(3);
    outbox.push(message("x")).unwrap();
    outbox.push(message("y")).unwrap();
    outbox.push(Command::Terminate).unwrap();
    assert!(matches!(outbox.push(message("z")), Err(Error::Closed)));
    assert_eq!(text(&mut conn), "x");
    assert_eq!(text(&mut conn), "y");
    assert!(
        closed(&mut conn),
        "the connection ends without a Close frame"
    );
    wait_for(|| server.logged("3 closed None"));
    assert!(outbox.is_closed());
    server.stop().unwrap();
}

#[test]
fn join_and_leave_pushed_between_frames_take_effect_in_send_order() {
    let server = Server::start(2, HIGH_WATER);
    let rooms = server.rooms();
    let (mut conn, outbox) = server.websocket(4);
    outbox.push(Command::Join("lobby".to_owned())).unwrap();
    outbox.push(message("joined")).unwrap();
    assert_eq!(text(&mut conn), "joined");
    assert_eq!(rooms.members("lobby"), 1, "the join came before the frame");
    assert_eq!(
        rooms.broadcast_text("lobby", "skipped", Some(MemberId::of_connection(4))),
        0,
        "a sender leaves the connection out by its token"
    );
    assert_eq!(rooms.broadcast_text("lobby", "hello", None), 1);
    assert_eq!(text(&mut conn), "hello");
    outbox.push(Command::Leave("lobby".to_owned())).unwrap();
    outbox.push(message("left")).unwrap();
    assert_eq!(text(&mut conn), "left");
    assert_eq!(rooms.members("lobby"), 0, "the leave came before the frame");
    assert_eq!(rooms.broadcast_text("lobby", "missed", None), 0);
    outbox.push(message("after")).unwrap();
    assert_eq!(
        text(&mut conn),
        "after",
        "no broadcast reached it after the leave"
    );
    close_from_client(&mut conn, 1000);
    server.stop().unwrap();
}

#[test]
fn a_broadcast_reaches_a_member_with_an_outbox_in_order_with_what_is_pushed_to_it() {
    let server = Server::start(1, HIGH_WATER);
    let rooms = server.rooms();
    let (mut conn, outbox) = server.websocket(30);
    outbox.push(Command::Join("lobby".to_owned())).unwrap();
    outbox.push(message("joined")).unwrap();
    assert_eq!(text(&mut conn), "joined");
    wait_for(|| outbox.buffered() == 0);
    let held = server.while_held(|| {
        let mut own = 0;
        for index in 0..50 {
            let before = message(&format!("before {index}"));
            let after = message(&format!("after {index}"));
            own += before.octets() + after.octets();
            outbox.push(before).unwrap();
            assert_eq!(
                rooms.broadcast_text("lobby", &format!("broadcast {index}"), None),
                1
            );
            outbox.push(after).unwrap();
        }
        assert_eq!(
            outbox.buffered(),
            own,
            "a broadcast frame counts in no outbox"
        );
    });
    for index in 0..50 {
        assert_eq!(text(&mut conn), format!("before {index}"));
        assert_eq!(text(&mut conn), format!("broadcast {index}"));
        assert_eq!(text(&mut conn), format!("after {index}"));
    }
    wait_for(|| outbox.buffered() == 0);
    drop(held);
    close_from_client(&mut conn, 1000);
    server.stop().unwrap();
}

#[test]
fn a_member_with_an_outbox_that_falls_too_far_behind_is_closed_with_1013_try_again_later() {
    let server = Server::start(1, HIGH_WATER);
    let rooms = server.rooms();
    let (mut conn, outbox) = server.websocket(31);
    outbox.push(Command::Join("lobby".to_owned())).unwrap();
    outbox.push(message("joined")).unwrap();
    assert_eq!(text(&mut conn), "joined");
    let large = vec![7u8; 4 * 1024 * 1024];
    let held = server.while_held(|| {
        for _ in 0..5 {
            assert_eq!(rooms.broadcast_binary("lobby", &large, None), 1);
        }
    });
    assert_eq!(
        read_frame(&mut conn),
        (0x88, close_body(1013, "")),
        "past the rooms inbox limit of broadcasts waiting"
    );
    conn.write_all(&client(0x88, &close_body(1013, "")))
        .unwrap();
    assert!(closed(&mut conn));
    wait_for(|| rooms.members("lobby") == 0);
    drop(held);
    server.stop().unwrap();
}

#[test]
fn the_peers_close_reason_is_the_utf_8_data_after_its_status_code_6455_7_1_6() {
    let server = Server::start(2, HIGH_WATER);
    let (mut conn, _outbox) = server.websocket(32);
    conn.write_all(&client(0x88, &close_body(4000, "all done")))
        .unwrap();
    assert_eq!(read_frame(&mut conn), (0x88, close_body(4000, "")));
    assert!(closed(&mut conn));
    wait_for(|| server.logged("32 closed Some(4000)"));
    assert!(server.logged("reason of 32 Some(\"all done\")"));

    let (mut plain, _outbox) = server.websocket(33);
    close_from_client(&mut plain, 1000);
    wait_for(|| server.logged("33 closed Some(1000)"));
    assert!(
        server.logged("reason of 33 Some(\"\")"),
        "a Close without a reason has the empty string"
    );

    let (dropped, _outbox) = server.websocket(34);
    drop(dropped);
    wait_for(|| server.logged("34 closed None"));
    assert!(server.logged("reason of 34 None"), "no Close arrived");
    server.stop().unwrap();
}

#[test]
fn a_pong_surfaces_as_an_event_of_the_connection() {
    let server = Server::start(2, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(5);
    let mut ping = Vec::new();
    frame::write_ping(b"p1", &mut ping).unwrap();
    outbox.push(Command::Frame(ping.into())).unwrap();
    assert_eq!(read_frame(&mut conn), (0x89, b"p1".to_vec()));
    conn.write_all(&client(0x8A, b"p1")).unwrap();
    wait_for(|| server.logged("5 pong p1"));
    conn.write_all(&client(0x8A, b"unsolicited")).unwrap();
    wait_for(|| server.logged("5 pong unsolicited"));
    close_from_client(&mut conn, 1000);
    server.stop().unwrap();
}

#[test]
fn the_connection_reports_drained_once_its_outbox_falls_below_half_the_mark_after_passing_it() {
    let server = Server::start(2, 1_024);
    let (mut conn, outbox) = server.websocket(6);
    outbox.push(binary(1, 100)).unwrap();
    assert_eq!(read_frame(&mut conn).1.len(), 100);
    outbox.push(binary(2, 2_000)).unwrap();
    assert_eq!(read_frame(&mut conn).1.len(), 2_000);
    wait_for(|| server.logged("6 drained"));
    outbox.push(binary(3, 100)).unwrap();
    assert_eq!(read_frame(&mut conn).1.len(), 100);
    close_from_client(&mut conn, 1000);
    wait_for(|| server.logged("6 closed Some(1000)"));
    assert_eq!(server.count("6 drained"), 1, "once per pass of the mark");

    let (conn, outbox) = server.event_stream(7);
    outbox
        .push(Command::Frame(event("big", &"x".repeat(2_000)).into()))
        .unwrap();
    wait_for(|| server.logged("7 drained"));
    drop(conn);
    wait_for(|| server.logged("7 closed"));
    server.stop().unwrap();
}

#[test]
fn a_push_is_refused_with_limit_past_four_times_the_mark_and_past_the_worker_total() {
    assert_eq!(LIMIT_FACTOR, 4);
    assert_eq!(HIGH_WATER, 16 * 1024 * 1024);
    assert_eq!(
        HIGH_WATER,
        u64::try_from(INBOX_BYTES).unwrap(),
        "the rooms inbox limit"
    );
    let total = Arc::new(OutboxTotal::new(10_000));
    let outbox = Outbox::with_high_water(Arc::clone(&total), 1_000);
    let frame = |len: usize| Command::Frame(vec![0u8; len].into());
    outbox.push(frame(1_000)).unwrap();
    assert!(outbox.is_writable(), "at the mark");
    outbox.push(frame(1)).unwrap();
    assert!(!outbox.is_writable(), "past the mark");
    outbox.push(frame(2_999)).unwrap();
    assert_eq!(outbox.buffered(), 4_000);
    assert!(matches!(outbox.push(frame(1)), Err(Error::Limit(_))));
    assert_eq!(outbox.buffered(), 4_000, "nothing is queued for a refusal");
    assert_eq!(total.queued(), 4_000);

    let other = Outbox::with_high_water(Arc::clone(&total), 100_000);
    assert!(total.is_writable());
    other.push(frame(6_000)).unwrap();
    assert_eq!(total.queued(), 10_000);
    assert!(!total.is_writable(), "past half the worker's limit");
    assert!(!other.is_writable());
    assert!(matches!(other.push(frame(1)), Err(Error::Limit(_))));
    assert_eq!(other.buffered(), 6_000);

    assert!(matches!(
        other.push(Command::Close {
            code: CloseCode::ABNORMAL,
            reason: String::new(),
        }),
        Err(Error::Protocol(_))
    ));
    assert!(matches!(
        other.push(Command::Close {
            code: CloseCode::NORMAL,
            reason: "r".repeat(124),
        }),
        Err(Error::Limit(_))
    ));
    assert_eq!(other.buffered(), 6_000, "an invalid Close queues nothing");

    outbox.close();
    assert_eq!(outbox.buffered(), 0);
    assert_eq!(total.queued(), 6_000);
    assert!(matches!(outbox.push(frame(1)), Err(Error::Closed)));
    other.close();
    assert_eq!(total.queued(), 0);
    assert_eq!(OutboxTotal::default().limit(), 268_435_456);
}

#[test]
fn the_worker_counter_returns_to_zero_when_every_outbox_drains() {
    let server = Server::start(1, HIGH_WATER);
    let (mut first, first_box) = server.websocket(8);
    let (mut second, second_box) = server.websocket(9);
    let (mut stream, stream_box) = server.event_stream(10);
    for index in 0..40 {
        first_box.push(binary(index, 16 * 1024)).unwrap();
        second_box.push(binary(index, 16 * 1024)).unwrap();
        stream_box
            .push(Command::Frame(event("e", &index.to_string()).into()))
            .unwrap();
    }
    stream_box.push(Command::End).unwrap();
    for index in 0..40u32 {
        for conn in [&mut first, &mut second] {
            let (_, payload) = read_frame(conn);
            assert_eq!(payload[..4], index.to_be_bytes());
        }
    }
    let mut body = Vec::new();
    stream.read_to_end(&mut body).unwrap();
    assert_eq!(events(&body).len(), 41);
    wait_for(|| server.queued() == 0);
    assert_eq!(first_box.buffered() + second_box.buffered(), 0);
    close_from_client(&mut first, 1000);
    close_from_client(&mut second, 1000);
    wait_for(|| server.logged("8 closed Some(1000)") && server.logged("9 closed Some(1000)"));
    assert!(server.logged("10 closed"));
    assert_eq!(server.queued(), 0);
    drop((first, second, stream));
    server.stop().unwrap();
}

#[test]
fn the_outbox_closes_when_the_connection_task_ends() {
    let server = Server::start(2, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(11);
    outbox.push(message("a")).unwrap();
    assert_eq!(text(&mut conn), "a");
    drop(conn);
    wait_for(|| server.logged("11 closed None"));
    assert!(outbox.is_closed());
    assert!(matches!(outbox.push(message("b")), Err(Error::Closed)));
    assert_eq!(outbox.buffered(), 0);

    let (conn, outbox) = server.event_stream(12);
    drop(conn);
    wait_for(|| server.logged("12 closed"));
    assert!(outbox.is_closed());
    assert!(matches!(
        outbox.push(Command::Frame(event("e", "late").into())),
        Err(Error::Closed)
    ));
    wait_for(|| server.queued() == 0);
    server.stop().unwrap();
}

#[test]
fn events_pushed_from_a_plain_thread_arrive_in_order_and_end_ends_the_stream() {
    let server = Server::start(2, HIGH_WATER);
    let (mut conn, outbox) = server.event_stream(13);
    let pusher = std::thread::spawn(move || {
        for index in 0..300 {
            outbox
                .push(Command::Frame(event("n", &index.to_string()).into()))
                .unwrap();
        }
        outbox.push(Command::End).unwrap();
        outbox
    });
    let mut body = Vec::new();
    conn.read_to_end(&mut body).unwrap();
    let outbox = pusher.join().unwrap();
    let seen = events(&body);
    assert_eq!(seen.len(), 301);
    assert_eq!(
        seen[0],
        ("opened".to_owned(), "-".to_owned()),
        "a push before the head"
    );
    for (index, (name, data)) in seen[1..].iter().enumerate() {
        assert_eq!(
            (name.as_str(), data.as_str()),
            ("n", index.to_string().as_str())
        );
    }
    wait_for(|| server.logged("13 closed"));
    assert!(outbox.is_closed());
    server.stop().unwrap();
}

#[test]
fn an_event_encoded_once_is_written_as_is_by_send_encoded() {
    let server = Server::start(2, HIGH_WATER);
    let mut conn = server.connect();
    conn.write_all(b"GET /encoded HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    assert_eq!(read_head(&mut conn), 200);
    let mut body = Vec::new();
    conn.read_to_end(&mut body).unwrap();
    assert_eq!(
        body,
        [event("tick", "one\ntwo"), event("tick", "one\ntwo")].concat()
    );
    let tick = ("tick".to_owned(), "one\ntwo".to_owned());
    assert_eq!(events(&body), [tick.clone(), tick]);
    wait_for(|| server.logged("encoded true true"));
    server.stop().unwrap();
}

#[test]
fn while_draining_websocket_clients_receive_a_close_frame_with_1001_going_away() {
    let server = Server::start(1, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(14);
    outbox.push(message("ready")).unwrap();
    assert_eq!(text(&mut conn), "ready");
    let frames = 200u32;
    let held = server.while_held(|| {
        for index in 0..frames {
            outbox.push(binary(index, 4 * 1024)).unwrap();
        }
        server.request_shutdown();
    });
    for index in 0..frames {
        let (first, payload) = read_frame(&mut conn);
        assert_eq!(first, 0x82);
        assert_eq!(
            payload[..4],
            index.to_be_bytes(),
            "the queued frames come first"
        );
    }
    assert_eq!(read_frame(&mut conn), (0x88, close_body(1001, "")));
    assert!(
        matches!(outbox.push(message("late")), Err(Error::Closed)),
        "the outbox refuses pushes once the Close went out"
    );
    conn.write_all(&client(0x88, &close_body(1001, "")))
        .unwrap();
    assert!(closed(&mut conn));
    wait_for(|| server.logged("14 closed Some(1001)"));
    assert!(outbox.is_closed());
    drop((conn, held));
    server.stop().unwrap();
}

#[test]
fn a_draining_server_writes_what_an_event_stream_outbox_holds_and_ends_the_stream() {
    let server = Server::start(1, HIGH_WATER);
    let (mut conn, outbox) = server.event_stream(15);
    assert_eq!(read_event(&mut conn), event("opened", "-"));
    let held = server.while_held(|| {
        for index in 0..200 {
            outbox
                .push(Command::Frame(event("n", &index.to_string()).into()))
                .unwrap();
        }
        server.request_shutdown();
    });
    let mut body = Vec::new();
    conn.read_to_end(&mut body).unwrap();
    let seen = events(&body);
    assert_eq!(seen.len(), 200);
    for (index, (name, data)) in seen.iter().enumerate() {
        assert_eq!(
            (name.as_str(), data.as_str()),
            ("n", index.to_string().as_str())
        );
    }
    assert!(
        server.logged("15 closed"),
        "the close event came before the end"
    );
    assert!(outbox.is_closed());
    assert!(matches!(
        outbox.push(Command::Frame(event("n", "late").into())),
        Err(Error::Closed)
    ));
    drop((conn, held));
    server.stop().unwrap();
}

/// Pause the WebSocket registered under `token`, and return once its task ran past
/// the pause: a frame pushed after it has reached the client.
fn paused(server: &Server, token: u64, conn: &mut TcpStream, outbox: &Outbox) -> ReadPause {
    let pause = server.pause(token);
    pause.pause();
    assert!(pause.is_paused());
    outbox.push(message("paused")).unwrap();
    assert_eq!(text(conn), "paused");
    pause
}

#[test]
fn a_paused_websocket_reads_no_frame_but_still_writes_its_outbox_and_surfaces_what_waited_once_resumed(
) {
    let server = Server::start(1, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(16);
    conn.write_all(&client(0x81, b"before")).unwrap();
    wait_for(|| server.logged("16 text before"));
    let pause = paused(&server, 16, &mut conn, &outbox);
    let reads = server.reads_of(&conn);
    for index in 0..3 {
        conn.write_all(&client(0x81, format!("c{index}").as_bytes()))
            .unwrap();
    }
    for index in 0..10 {
        outbox.push(message(&format!("o{index}"))).unwrap();
        assert_eq!(
            text(&mut conn),
            format!("o{index}"),
            "a paused connection still writes its outbox"
        );
    }
    assert_eq!(
        server.reads_of(&conn),
        reads,
        "a paused connection starts no socket read"
    );
    assert_eq!(server.lines("16 text"), ["16 text before"]);
    pause.resume();
    wait_for(|| server.lines("16 text").len() == 4);
    assert_eq!(
        server.lines("16 text"),
        ["16 text before", "16 text c0", "16 text c1", "16 text c2"],
        "what waited surfaces in the order it was sent"
    );
    assert!(server.reads_of(&conn) > reads);
    conn.write_all(&client(0x81, b"after")).unwrap();
    wait_for(|| server.logged("16 text after"));
    close_from_client(&mut conn, 1000);
    wait_for(|| server.logged("16 closed Some(1000)"));
    server.stop().unwrap();
}

#[test]
fn a_paused_websocket_still_sends_close_1001_after_its_queued_frames_when_the_server_drains() {
    let server = Server::start(1, HIGH_WATER);
    let (mut conn, outbox) = server.websocket(17);
    let pause = paused(&server, 17, &mut conn, &outbox);
    let reads = server.reads_of(&conn);
    conn.write_all(&client(0x81, b"waiting")).unwrap();
    let frames = 50u32;
    let held = server.while_held(|| {
        for index in 0..frames {
            outbox.push(binary(index, 1024)).unwrap();
        }
        server.request_shutdown();
    });
    for index in 0..frames {
        let (first, payload) = read_frame(&mut conn);
        assert_eq!(first, 0x82);
        assert_eq!(
            payload[..4],
            index.to_be_bytes(),
            "the queued frames come first"
        );
    }
    assert_eq!(read_frame(&mut conn), (0x88, close_body(1001, "")));
    assert!(matches!(outbox.push(message("late")), Err(Error::Closed)));
    assert_eq!(
        server.reads_of(&conn),
        reads,
        "the shutdown sent its Close without reading the socket"
    );
    assert!(server.lines("17 text").is_empty());
    pause.resume();
    conn.write_all(&client(0x88, &close_body(1001, "")))
        .unwrap();
    assert!(closed(&mut conn));
    wait_for(|| server.logged("17 closed Some(1001)"));
    assert_eq!(
        server.lines("17 "),
        ["17 text waiting", "17 closed Some(1001)"],
        "the frame that waited surfaces before the close event"
    );
    assert!(outbox.is_closed());
    drop((conn, held));
    server.stop().unwrap();
}
