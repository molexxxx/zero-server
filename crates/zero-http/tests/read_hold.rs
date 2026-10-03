//! A read hold through the driver: a connection whose request took a hold reads
//! nothing more until the last hold drops, then serves what arrived meanwhile,
//! while the other connections of the core are served throughout. The streams
//! count the reads that returned data, so a test sees the socket left unread and
//! not only that no handler started; and the read timeouts wait while the server,
//! not the client, holds the connection.

#![cfg(any(feature = "io-tokio", feature = "io-compio"))]

use std::cell::RefCell;
use std::io::{self, IoSlice, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use zero_core::{Error, OwnedBuf};
use zero_http::{serve_with, Accept, Call, Config, Handler, Prepared, ReadHold, Workers};
use zero_io::pool::Pool;
use zero_io::seam::{Leased, Stream};
use zero_limits::Http1Limits;

/// Takes one hold on `/hold` and two on `/hold-twice`, drops one on
/// `/release-one` and all on `/release`, answers `/probe` with whether `/second`
/// started, and logs every request it starts.
struct Holder {
    holds: RefCell<Vec<ReadHold>>,
    log: Arc<Mutex<Vec<String>>>,
}

impl Handler for Holder {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let path = String::from_utf8_lossy(call.request().path()).into_owned();
        if path == "/probe" {
            let started = self
                .log
                .lock()
                .unwrap()
                .iter()
                .any(|line| line == "start /second");
            call.response()
                .body(if started { b"started" } else { b"waiting" });
            return Ok(());
        }
        self.log.lock().unwrap().push(format!("start {path}"));
        match path.as_str() {
            "/hold" => self.holds.borrow_mut().push(call.hold_reads()),
            "/hold-twice" => {
                let mut holds = self.holds.borrow_mut();
                holds.push(call.hold_reads());
                holds.push(call.hold_reads());
            }
            "/release-one" => drop(self.holds.borrow_mut().pop()),
            "/release" => self.holds.borrow_mut().clear(),
            _ => {}
        }
        call.response().body(path.as_bytes());
        Ok(())
    }
}

/// The reads that returned data, per connection, by the client's address.
type Reads = Arc<Mutex<Vec<(SocketAddr, Arc<AtomicU64>)>>>;

/// A stream that counts its reads that returned data.
struct Counted {
    inner: zero_io::rt::TcpStream,
    reads: Arc<AtomicU64>,
}

impl Stream for Counted {
    fn readable(&self) -> impl std::future::Future<Output = io::Result<()>> {
        self.inner.readable()
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        let read = self.inner.read_leased(pool).await;
        if matches!(read, Ok(Leased::Data(_))) {
            self.reads.fetch_add(1, Ordering::SeqCst);
        }
        read
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

/// Hands every connection over as a [`Counted`] stream and keeps its counter.
struct Counting(Reads);

impl Accept for Counting {
    type Stream = Counted;

    fn accept(
        self: Rc<Self>,
        stream: zero_io::rt::TcpStream,
        peer: SocketAddr,
    ) -> impl std::future::Future<Output = io::Result<Prepared<Counted>>> + 'static {
        let reads = Arc::new(AtomicU64::new(0));
        self.0.lock().unwrap().push((peer, Arc::clone(&reads)));
        std::future::ready(Ok(Prepared::any_host(Counted {
            inner: stream,
            reads,
        })))
    }
}

fn start(log: Arc<Mutex<Vec<String>>>) -> (Workers, Reads) {
    start_with(log, Http1Limits::DEFAULT)
}

fn start_with(log: Arc<Mutex<Vec<String>>>, limits: Http1Limits) -> (Workers, Reads) {
    let config = Config {
        runtime: zero_rt::Config {
            io: zero_io::rt::Config {
                threads: 1,
                drain: Duration::from_secs(2),
                ..zero_io::rt::Config::default()
            },
        },
        limits,
        server: None,
    };
    let reads: Reads = Arc::new(Mutex::new(Vec::new()));
    let accepted = Arc::clone(&reads);
    let workers = serve_with(
        "127.0.0.1:0".parse().unwrap(),
        config,
        Arc::new(|_| {}),
        move |_| Holder {
            holds: RefCell::new(Vec::new()),
            log: Arc::clone(&log),
        },
        move |_| Counting(Arc::clone(&accepted)),
    )
    .unwrap();
    (workers, reads)
}

fn connect(workers: &Workers) -> TcpStream {
    let conn = TcpStream::connect(workers.local_addr()).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    conn.set_nodelay(true).unwrap();
    conn
}

/// The reads with data the server made on `conn`, which has had a round trip.
fn reads_of(reads: &Reads, conn: &TcpStream) -> u64 {
    let local = conn.local_addr().unwrap();
    reads
        .lock()
        .unwrap()
        .iter()
        .find(|(peer, _)| *peer == local)
        .map(|(_, count)| count.load(Ordering::SeqCst))
        .unwrap()
}

/// Read one response and return its body.
fn read_body(conn: &mut TcpStream) -> io::Result<String> {
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
    let length: usize = text
        .split("\r\n")
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    conn.read_exact(&mut body)?;
    Ok(String::from_utf8(body).unwrap())
}

fn get(conn: &mut TcpStream, path: &str) -> String {
    conn.write_all(format!("GET {path} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes())
        .unwrap();
    read_body(conn).unwrap()
}

/// Ask the one core, over another connection, whether `/second` has started, ten
/// times: each probe is a full round trip through the core, which serves every
/// readable connection it may read on the way, and the held connection's bytes
/// were sent before the first probe.
fn probes(other: &mut TcpStream) -> Vec<String> {
    (0..10).map(|_| get(other, "/probe")).collect()
}

#[test]
fn a_held_connection_reads_nothing_more_until_the_last_hold_drops() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let (workers, reads) = start(Arc::clone(&log));
    let mut held = connect(&workers);
    let mut other = connect(&workers);

    assert_eq!(get(&mut held, "/hold-twice"), "/hold-twice");
    let before = reads_of(&reads, &held);
    held.write_all(
        b"GET /second HTTP/1.1\r\nHost: t\r\n\r\nGET /third HTTP/1.1\r\nHost: t\r\n\r\n",
    )
    .unwrap();
    let answers = probes(&mut other);
    assert!(
        answers.iter().all(|answer| answer == "waiting"),
        "no request of the held connection started: {answers:?}"
    );
    assert_eq!(
        reads_of(&reads, &held),
        before,
        "the held connection read nothing from its socket"
    );

    assert_eq!(get(&mut other, "/release-one"), "/release-one");
    let answers = probes(&mut other);
    assert!(
        answers.iter().all(|answer| answer == "waiting"),
        "one hold is still in place: {answers:?}"
    );
    assert_eq!(
        reads_of(&reads, &held),
        before,
        "one hold still keeps the socket unread"
    );

    assert_eq!(get(&mut other, "/release"), "/release");
    assert_eq!(read_body(&mut held).unwrap(), "/second");
    assert!(
        reads_of(&reads, &held) > before,
        "the socket is read once the last hold dropped"
    );
    assert_eq!(
        read_body(&mut held).unwrap(),
        "/third",
        "both requests that arrived while held are served"
    );
    let log = log.lock().unwrap().clone();
    let position = |line: &str| log.iter().position(|entry| entry == line).unwrap();
    assert!(
        position("start /release") < position("start /second"),
        "{log:?}"
    );
    assert_eq!(
        get(&mut held, "/after"),
        "/after",
        "the connection reads on"
    );
    workers.stop().unwrap();
}

#[test]
fn a_request_already_read_but_not_parsed_waits_in_the_buffer_and_is_served_once_the_hold_drops() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let (workers, reads) = start_with(
        Arc::clone(&log),
        Http1Limits {
            max_pipelined: 1,
            ..Http1Limits::DEFAULT
        },
    );
    let mut held = connect(&workers);
    let mut other = connect(&workers);
    held.write_all(b"GET /hold HTTP/1.1\r\nHost: t\r\n\r\nGET /second HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    assert_eq!(read_body(&mut held).unwrap(), "/hold");
    let before = reads_of(&reads, &held);
    let answers = probes(&mut other);
    assert!(
        answers.iter().all(|answer| answer == "waiting"),
        "with one request in flight at a time, the second stays unparsed: {answers:?}"
    );
    assert_eq!(
        reads_of(&reads, &held),
        before,
        "the held connection read nothing from its socket"
    );
    assert_eq!(get(&mut other, "/release"), "/release");
    assert_eq!(read_body(&mut held).unwrap(), "/second");
    assert_eq!(get(&mut held, "/after"), "/after");
    assert!(
        reads_of(&reads, &held) > before,
        "the socket is read once the hold dropped"
    );
    workers.stop().unwrap();
}

#[test]
fn requests_parsed_before_the_hold_still_run_and_are_answered() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let (workers, reads) = start(Arc::clone(&log));
    let mut held = connect(&workers);
    let mut other = connect(&workers);
    held.write_all(b"GET /hold HTTP/1.1\r\nHost: t\r\n\r\nGET /early HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    assert_eq!(read_body(&mut held).unwrap(), "/hold");
    assert_eq!(
        read_body(&mut held).unwrap(),
        "/early",
        "a request read with the one that took the hold still runs"
    );
    let before = reads_of(&reads, &held);
    held.write_all(b"GET /second HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    let answers = probes(&mut other);
    assert!(
        answers.iter().all(|answer| answer == "waiting"),
        "{answers:?}"
    );
    assert_eq!(
        reads_of(&reads, &held),
        before,
        "the held connection read nothing from its socket"
    );
    assert_eq!(get(&mut other, "/release"), "/release");
    assert_eq!(read_body(&mut held).unwrap(), "/second");
    assert!(
        reads_of(&reads, &held) > before,
        "the socket is read once the hold dropped"
    );
    workers.stop().unwrap();
}

#[test]
fn a_hold_suspends_the_header_read_timeout_of_a_head_begun_before_it() {
    const TIMEOUT: Duration = Duration::from_millis(200);
    let log = Arc::new(Mutex::new(Vec::new()));
    let (workers, _) = start_with(
        Arc::clone(&log),
        Http1Limits {
            header_read_timeout: TIMEOUT,
            ..Http1Limits::DEFAULT
        },
    );
    let mut held = connect(&workers);
    let mut other = connect(&workers);
    held.write_all(b"GET /hold HTTP/1.1\r\nHost: t\r\n\r\nGET /second HTTP/1.1\r\nHo")
        .unwrap();
    assert_eq!(read_body(&mut held).unwrap(), "/hold");
    let since = Instant::now();
    while since.elapsed() < TIMEOUT * 2 {
        let answers = probes(&mut connect(&workers));
        assert!(
            answers.iter().all(|answer| answer == "waiting"),
            "the hold stays for twice the header read timeout: {answers:?}"
        );
    }
    assert_eq!(get(&mut other, "/release"), "/release");
    held.write_all(b"st: t\r\n\r\n").unwrap();
    assert_eq!(
        read_body(&mut held).unwrap(),
        "/second",
        "the head begun before the hold is served, not answered 408"
    );
    assert_eq!(get(&mut held, "/after"), "/after");
    workers.stop().unwrap();
}
