//! WebSocket and server-sent events end to end, over the HTTP/1.1 driver: the
//! handshake and its refusals, the three audit vectors (bytes sent with the
//! handshake, continuation frames, writes after a Close), draining, and event
//! streams with keep-alive comments and `Last-Event-ID`.

use std::future::Future;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use zero_core::Error;
use zero_http::{serve, Call, Config, Handler, Taken, Workers};
use zero_http_types::StatusCode;
use zero_io::seam::{Stream, Timer};
use zero_limits::{Http1Limits, WebSocketLimits};
use zero_realtime::{
    accept_websocket, start_event_stream, stop_reconnecting, EventStream, Message, WebSocket,
};
use zero_sse::{Decoder, Event};
use zero_ws::handshake::Config as WsConfig;
use zero_ws::CloseCode;

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const MASK: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

struct App {
    log: Arc<Mutex<Vec<String>>>,
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let path = String::from_utf8_lossy(call.request().path()).into_owned();
        match path.as_str() {
            "/ws" => {
                let config = WsConfig {
                    protocols: &[b"chat"],
                    origins: Some(&[b"https://good.example"]),
                };
                accept_websocket(call, &config, 1)?;
            }
            "/events" => start_event_stream(call, 2)?,
            "/events/stop" => stop_reconnecting(call),
            _ => {
                call.response().status(StatusCode::NOT_FOUND);
            }
        }
        Ok(())
    }

    fn taken<S: Stream + 'static>(&self, taken: Taken<S>) -> impl Future<Output = ()> {
        let log = Arc::clone(&self.log);
        async move {
            let note = |line: String| log.lock().unwrap().push(line);
            match taken.token() {
                1 => {
                    let mut ws = WebSocket::new(taken, WebSocketLimits::DEFAULT);
                    while let Some(message) = ws.recv().await {
                        match message {
                            Message::Text(text) if text == "close" => {
                                let _ = ws.close(CloseCode::NORMAL, "bye").await;
                                let late = ws.send_text("late").await;
                                note(format!("late refused {}", late.is_err()));
                            }
                            Message::Text(text) => {
                                let _ = ws.send_text(&text).await;
                            }
                            Message::Binary(data) => {
                                let _ = ws.send_binary(&data).await;
                            }
                        }
                    }
                    note(format!("closed {:?}", ws.close_code().map(|code| code.0)));
                }
                2 => {
                    let worker = taken.worker().clone();
                    let mut stream = EventStream::new(taken, 40);
                    let resumed = stream.last_event_id().unwrap_or("none").to_owned();
                    let data = format!("resumed from {resumed}");
                    let _ = stream
                        .send(&Event {
                            id: Some("1"),
                            data: Some(&data),
                            ..Event::default()
                        })
                        .await;
                    let waited = stream
                        .wait(worker.core().sleep(Duration::from_millis(130)))
                        .await;
                    note(format!("waited {}", waited.is_ok()));
                    let _ = stream
                        .send(&Event {
                            event: Some("done"),
                            data: Some("bye"),
                            ..Event::default()
                        })
                        .await;
                    if resumed == "drain" {
                        let drained = stream.wait(std::future::pending::<()>()).await;
                        note(format!("drained {}", drained.is_err()));
                    }
                }
                _ => {}
            }
        }
    }
}

struct Server {
    workers: Option<Workers>,
    addr: SocketAddr,
    log: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn start() -> Self {
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let config = Config {
            runtime: zero_rt::Config {
                io: zero_io::rt::Config {
                    threads: 2,
                    drain: Duration::from_secs(3),
                    ..zero_io::rt::Config::default()
                },
            },
            limits: Http1Limits::DEFAULT,
            server: None,
        };
        let app_log = Arc::clone(&log);
        let workers = serve(
            "127.0.0.1:0".parse().unwrap(),
            config,
            Arc::new(|_| {}),
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
        }
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

/// A response head: the status and the fields.
struct Head {
    status: u16,
    fields: Vec<(String, String)>,
}

impl Head {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn length(&self) -> usize {
        self.field("content-length")
            .map_or(0, |value| value.parse().unwrap())
    }
}

fn read_head(conn: &mut TcpStream) -> Head {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        conn.read_exact(&mut byte).unwrap();
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
    let fields = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_owned(), value.trim().to_owned())
        })
        .collect();
    Head { status, fields }
}

fn handshake(conn: &mut TcpStream, extra: &str, after: &[u8]) -> Head {
    let mut request = format!(
        "GET /ws HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {KEY}\r\n{extra}\r\n"
    )
    .into_bytes();
    if !extra.contains("Sec-WebSocket-Version") {
        request.splice(
            request.len() - 2..request.len() - 2,
            b"Sec-WebSocket-Version: 13\r\n".iter().copied(),
        );
    }
    request.extend_from_slice(after);
    conn.write_all(&request).unwrap();
    read_head(conn)
}

/// A frame as a client sends it: masked, the length in its minimal form.
fn client(first: u8, payload: &[u8]) -> Vec<u8> {
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

fn closed(conn: &mut TcpStream) -> bool {
    let mut byte = [0u8; 1];
    matches!(conn.read(&mut byte), Ok(0))
}

fn close_body(code: u16, reason: &str) -> Vec<u8> {
    let mut body = code.to_be_bytes().to_vec();
    body.extend_from_slice(reason.as_bytes());
    body
}

#[test]
fn a_websocket_handshake_is_answered_101_with_the_accept_value_and_the_chosen_subprotocol() {
    let server = Server::start();
    let mut conn = server.connect();
    let head = handshake(
        &mut conn,
        "Origin: https://good.example\r\nSec-WebSocket-Protocol: superchat, chat\r\n",
        b"",
    );
    assert_eq!(head.status, 101);
    assert_eq!(head.field("upgrade"), Some("websocket"));
    assert_eq!(head.field("connection"), Some("upgrade"));
    assert_eq!(
        head.field("sec-websocket-accept"),
        Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    );
    assert_eq!(head.field("sec-websocket-protocol"), Some("chat"));
    assert_eq!(head.field("content-length"), None);
    conn.write_all(&client(0x81, b"hello")).unwrap();
    assert_eq!(read_frame(&mut conn), (0x81, b"hello".to_vec()));
    conn.write_all(&client(0x88, &close_body(1000, "")))
        .unwrap();
    assert_eq!(read_frame(&mut conn), (0x88, close_body(1000, "")));
    assert!(
        closed(&mut conn),
        "the server closes once a Close went each way"
    );
    server.stop().unwrap();
}

#[test]
fn a_refused_websocket_handshake_is_answered_426_403_or_400_and_http_goes_on() {
    let server = Server::start();
    let mut conn = server.connect();
    let head = handshake(&mut conn, "Sec-WebSocket-Version: 8\r\n", b"");
    assert_eq!(head.status, 426);
    assert_eq!(head.field("upgrade"), Some("websocket"));
    assert_eq!(head.field("connection"), Some("upgrade"));
    assert_eq!(head.field("sec-websocket-version"), Some("13"));
    let mut body = vec![0u8; head.length()];
    conn.read_exact(&mut body).unwrap();

    let head = handshake(&mut conn, "Origin: https://evil.example\r\n", b"");
    assert_eq!(head.status, 403, "an origin outside the allow list");
    let mut body = vec![0u8; head.length()];
    conn.read_exact(&mut body).unwrap();

    conn.write_all(
        b"GET /ws HTTP/1.1\r\nHost: t\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n\r\n",
    )
    .unwrap();
    let head = read_head(&mut conn);
    assert_eq!(head.status, 400, "a key that is not 16 bytes");
    let mut body = vec![0u8; head.length()];
    conn.read_exact(&mut body).unwrap();

    conn.write_all(b"GET /missing HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    assert_eq!(read_head(&mut conn).status, 404);
    server.stop().unwrap();
}

#[test]
fn a_frame_sent_together_with_the_handshake_is_not_lost() {
    let server = Server::start();
    let mut conn = server.connect();
    let head = handshake(&mut conn, "", &client(0x81, b"early"));
    assert_eq!(head.status, 101);
    assert_eq!(read_frame(&mut conn), (0x81, b"early".to_vec()));
    conn.write_all(&client(0x88, &close_body(1000, "")))
        .unwrap();
    assert_eq!(read_frame(&mut conn).0, 0x88);
    assert!(closed(&mut conn));
    server.stop().unwrap();
}

#[test]
fn continuation_frames_are_reassembled_and_a_ping_between_them_is_answered() {
    let server = Server::start();
    let mut conn = server.connect();
    assert_eq!(handshake(&mut conn, "", b"").status, 101);
    let mut frames = client(0x01, b"Hel");
    frames.extend(client(0x89, b"p"));
    frames.extend(client(0x00, b"l"));
    frames.extend(client(0x80, b"o"));
    for byte in frames {
        conn.write_all(&[byte]).unwrap();
    }
    assert_eq!(read_frame(&mut conn), (0x8A, b"p".to_vec()));
    assert_eq!(read_frame(&mut conn), (0x81, b"Hello".to_vec()));
    let big: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
    conn.write_all(&client(0x02, &big[..30_000])).unwrap();
    conn.write_all(&client(0x80, &big[30_000..])).unwrap();
    assert_eq!(read_frame(&mut conn), (0x82, big));
    conn.write_all(&client(0x88, &close_body(1001, "")))
        .unwrap();
    assert_eq!(read_frame(&mut conn), (0x88, close_body(1001, "")));
    assert!(closed(&mut conn));
    server.stop().unwrap();
}

#[test]
fn nothing_is_written_after_the_server_sends_its_close() {
    let server = Server::start();
    let mut conn = server.connect();
    assert_eq!(handshake(&mut conn, "", b"").status, 101);
    conn.write_all(&client(0x81, b"close")).unwrap();
    assert_eq!(read_frame(&mut conn), (0x88, close_body(1000, "bye")));
    conn.write_all(&client(0x88, &close_body(1000, "")))
        .unwrap();
    assert!(closed(&mut conn), "no frame follows the Close");
    let log = server.log();
    server.stop().unwrap();
    assert!(log.contains(&"late refused true".to_owned()), "{log:?}");
    assert!(log.contains(&"closed Some(1000)".to_owned()), "{log:?}");
}

#[test]
fn a_draining_server_closes_websocket_connections_with_1001_going_away() {
    let server = Server::start();
    let mut conn = server.connect();
    assert_eq!(handshake(&mut conn, "", b"").status, 101);
    conn.write_all(&client(0x81, b"ready")).unwrap();
    assert_eq!(read_frame(&mut conn), (0x81, b"ready".to_vec()));
    let log = Arc::clone(&server.log);
    let stopping = std::thread::spawn(move || server.stop());
    assert_eq!(read_frame(&mut conn), (0x88, close_body(1001, "")));
    conn.write_all(&client(0x88, &close_body(1001, "")))
        .unwrap();
    assert!(closed(&mut conn));
    stopping.join().unwrap().unwrap();
    assert!(log
        .lock()
        .unwrap()
        .contains(&"closed Some(1001)".to_owned()));
}

fn read_stream(conn: &mut TcpStream, last_event_id: &str) -> (Head, Vec<u8>) {
    conn.write_all(
        format!("GET /events HTTP/1.1\r\nHost: t\r\nLast-Event-ID: {last_event_id}\r\n\r\n")
            .as_bytes(),
    )
    .unwrap();
    let head = read_head(conn);
    let mut body = Vec::new();
    conn.read_to_end(&mut body).unwrap();
    (head, body)
}

#[test]
fn an_event_stream_is_text_event_stream_kept_alive_with_comments_and_sees_last_event_id() {
    let server = Server::start();
    let mut conn = server.connect();
    let (head, body) = read_stream(&mut conn, "7");
    assert_eq!(head.status, 200);
    assert_eq!(
        head.field("content-type"),
        Some("text/event-stream; charset=utf-8")
    );
    assert_eq!(head.field("cache-control"), Some("no-store"));
    assert_eq!(head.field("connection"), Some("close"));
    assert_eq!(head.field("content-length"), None);
    let comments = body
        .split(|&byte| byte == b'\n')
        .filter(|line| *line == b":")
        .count();
    assert!(
        comments >= 2,
        "keep-alive comments while waiting: {comments}"
    );
    let mut decoder = Decoder::new(1 << 16);
    let mut events = Vec::new();
    decoder.feed(&body, &mut events).unwrap();
    let seen: Vec<(&str, &str, &str)> = events
        .iter()
        .map(|event| (event.event.as_str(), event.data.as_str(), event.id.as_str()))
        .collect();
    assert_eq!(
        seen,
        [("message", "resumed from 7", "1"), ("done", "bye", "1")]
    );
    let mut stop = server.connect();
    stop.write_all(b"GET /events/stop HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    assert_eq!(
        read_head(&mut stop).status,
        204,
        "a client is told to stop reconnecting"
    );
    let log = server.log();
    server.stop().unwrap();
    assert!(log.contains(&"waited true".to_owned()), "{log:?}");
}

#[test]
fn a_draining_server_ends_event_streams() {
    let server = Server::start();
    let mut conn = server.connect();
    conn.write_all(b"GET /events HTTP/1.1\r\nHost: t\r\nLast-Event-ID: drain\r\n\r\n")
        .unwrap();
    assert_eq!(read_head(&mut conn).status, 200);
    let mut seen = Vec::new();
    let mut chunk = [0u8; 256];
    while !String::from_utf8_lossy(&seen).contains("event: done") {
        let count = conn.read(&mut chunk).unwrap();
        assert!(count > 0, "the stream ended early");
        seen.extend_from_slice(&chunk[..count]);
    }
    let log = Arc::clone(&server.log);
    let stopping = std::thread::spawn(move || server.stop());
    let mut rest = Vec::new();
    conn.read_to_end(&mut rest).unwrap();
    stopping.join().unwrap().unwrap();
    assert!(log.lock().unwrap().contains(&"drained true".to_owned()));
}
