//! `zero serve` end to end through the built binary: a temporary directory served over
//! HTTP and over HTTPS with the zero-tls test certificate, checked against the test CA;
//! a dotfile answered 404; the security headers on every response the directory
//! answers, and none on the 400 and 421 the HTTP layer writes itself; the exit codes of
//! a command line the binary does not take, a missing directory and an unreadable
//! certificate; and on Unix a FIFO answered 404 without holding its core, the drain a
//! first `SIGTERM` starts, the longest drain `--drain` takes, and the immediate exit a
//! second stop signal forces. Signals are sent with the POSIX `kill` utility and FIFOs
//! made with `mkfifo`, so the test holds no `unsafe` code.
//!
//! @see <https://pubs.opengroup.org/onlinepubs/9799919799/utilities/kill.html>
//! @see <https://pubs.opengroup.org/onlinepubs/9799919799/utilities/mkfifo.html>

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::version::{TLS12, TLS13};
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};

const ZERO: &str = env!("CARGO_BIN_EXE_zero");
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../zero-tls/tests/fixtures");
const CA: &[u8] = include_bytes!("../../zero-tls/tests/fixtures/ca.pem");
const INDEX: &[u8] = b"<!doctype html><title>zero</title>\n";
const HELLO: &[u8] = b"hello from zero serve\n";
const SECRET: &[u8] = b"TOKEN=not-for-the-network\n";

/// How long any one step may take before the test fails instead of hanging.
const WAIT: Duration = Duration::from_secs(30);

static SITES: AtomicUsize = AtomicUsize::new(0);

/// A temporary directory to serve, removed on drop.
struct Site {
    root: PathBuf,
}

impl Site {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "zero-serve-test-{}-{}",
            std::process::id(),
            SITES.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), INDEX).unwrap();
        std::fs::write(root.join("hello.txt"), HELLO).unwrap();
        std::fs::write(root.join(".env"), SECRET).unwrap();
        Site { root }
    }

    fn with(self, name: &str, bytes: &[u8]) -> Self {
        std::fs::write(self.root.join(name), bytes).unwrap();
        self
    }
}

impl Drop for Site {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// A running `zero serve` on a port the system picked, killed on drop if it still runs.
struct Server {
    child: Child,
    addr: SocketAddr,
    scheme: String,
    log: Receiver<String>,
}

impl Server {
    /// Start the binary on `127.0.0.1:0`, with two threads unless `extra` names
    /// `--threads`, and learn the bound address from the line it prints once it listens.
    fn start(site: &Site, extra: &[&str]) -> Self {
        let threads: &[&str] = if extra.contains(&"--threads") {
            &[]
        } else {
            &["--threads", "2"]
        };
        let mut child = Command::new(ZERO)
            .arg("serve")
            .arg(&site.root)
            .args(["--listen", "127.0.0.1:0"])
            .args(threads)
            .args(extra)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the zero binary starts");
        let stderr = child.stderr.take().expect("a piped standard error");
        let (lines, log) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else {
                    return;
                };
                if lines.send(line).is_err() {
                    return;
                }
            }
        });
        let mut server = Server {
            child,
            addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            scheme: String::new(),
            log,
        };
        let serving = server.line_with("zero: serving ");
        let (scheme, rest) = serving
            .rsplit_once(" at ")
            .and_then(|(_, url)| url.split_once("://"))
            .unwrap_or_else(|| panic!("no listening address in {serving:?}"));
        let addr = rest.split(' ').next().unwrap_or_default();
        server.addr = addr
            .parse()
            .unwrap_or_else(|_| panic!("no listening address in {serving:?}"));
        server.scheme = scheme.to_owned();
        server
    }

    /// The next line of standard error that contains `text`, skipping the others.
    fn line_with(&self, text: &str) -> String {
        let deadline = Instant::now() + WAIT;
        loop {
            match self
                .log
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(line) if line.contains(text) => return line,
                Ok(_) => {}
                Err(err) => panic!("no line with {text:?} on standard error: {err}"),
            }
        }
    }

    fn connect(&self) -> TcpStream {
        let stream = TcpStream::connect(self.addr).expect("a connection");
        stream.set_read_timeout(Some(WAIT)).unwrap();
        stream.set_write_timeout(Some(WAIT)).unwrap();
        stream
    }

    /// Poll the process until it exits, failing after `limit`.
    fn exit_within(&mut self, limit: Duration) -> ExitStatus {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "zero still runs {limit:?} later");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Send the signal named `name` (`TERM`, `INT`) with `kill -s`.
    #[cfg(unix)]
    fn signal(&self, name: &str) {
        let status = Command::new("kill")
            .args(["-s", name, &self.child.id().to_string()])
            .status()
            .expect("the kill utility");
        assert!(status.success(), "kill -s {name}");
    }

    /// Stop the server and wait for it: `SIGTERM` and a clean exit on Unix; elsewhere
    /// the process is killed, since this test cannot send it a console event.
    fn stop(mut self) {
        #[cfg(unix)]
        {
            self.signal("TERM");
            let status = self.exit_within(WAIT);
            assert_eq!(status.code(), Some(0), "{status}");
        }
        #[cfg(not(unix))]
        {
            self.child.kill().unwrap();
            let _ = self.exit_within(WAIT);
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// One parsed response.
struct Response {
    status: u16,
    fields: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn parse(raw: &[u8]) -> Self {
        let end = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("a complete response head");
        let head = std::str::from_utf8(&raw[..end]).expect("a text head");
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split(' ').nth(1))
            .and_then(|code| code.parse().ok())
            .expect("a status line");
        let fields = lines
            .map(|line| {
                let (name, value) = line.split_once(':').expect("a field line");
                (name.to_owned(), value.trim().to_owned())
            })
            .collect();
        Response {
            status,
            fields,
            body: raw[end + 4..].to_vec(),
        }
    }

    fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(field, _)| field.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// The `zero-policy` defaults are on the response, with `Strict-Transport-Security`
    /// only over TLS: "An HSTS Host MUST NOT include the STS header field in HTTP
    /// responses conveyed over non-secure transport" (RFC 6797 Section 7.2).
    fn assert_security_headers(&self, secure: bool) {
        assert_eq!(self.field("X-Content-Type-Options"), Some("nosniff"));
        for name in [
            "X-Frame-Options",
            "Referrer-Policy",
            "Cross-Origin-Resource-Policy",
            "Cross-Origin-Opener-Policy",
            "X-XSS-Protection",
        ] {
            assert!(self.field(name).is_some(), "{name} on a {}", self.status);
        }
        assert_eq!(
            self.field("Strict-Transport-Security").is_some(),
            secure,
            "Strict-Transport-Security on a {} over {}",
            self.status,
            if secure { "TLS" } else { "plain HTTP" }
        );
    }
}

/// Send one `GET` with `Connection: close` and read the response to the end of the
/// stream.
fn get<S: Read + Write>(stream: &mut S, path: &str) -> Response {
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    exchange(stream, request.as_bytes())
}

/// Send `request` as it is and read the response to the end of the stream.
fn exchange<S: Read + Write>(stream: &mut S, request: &[u8]) -> Response {
    stream.write_all(request).unwrap();
    stream.flush().unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("the whole response");
    Response::parse(&raw)
}

/// Whether any of the `zero-policy` default fields is on the response.
fn carries_security_headers(response: &Response) -> bool {
    [
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Cross-Origin-Resource-Policy",
        "Strict-Transport-Security",
    ]
    .iter()
    .any(|name| response.field(name).is_some())
}

/// A client that trusts only the zero-tls test CA.
fn tls_client() -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(CA).expect("the test CA"))
        .unwrap();
    let mut config = ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_protocol_versions(&[&TLS13, &TLS12])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

fn zero(args: &[&str]) -> Output {
    Command::new(ZERO)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("the zero binary runs")
}

#[test]
fn serve_answers_files_over_http_with_the_security_headers_and_a_dotfile_with_404() {
    let site = Site::new();
    let server = Server::start(&site, &[]);
    assert_eq!(server.scheme, "http");
    let hello = get(&mut server.connect(), "/hello.txt");
    assert_eq!(hello.status, 200);
    assert_eq!(hello.body, HELLO);
    let index = get(&mut server.connect(), "/");
    assert_eq!(index.status, 200);
    assert_eq!(index.body, INDEX);
    for path in ["/.env", "/%2Eenv"] {
        let dotfile = get(&mut server.connect(), path);
        assert_eq!(dotfile.status, 404, "{path}");
        assert!(
            !dotfile
                .body
                .windows(SECRET.len())
                .any(|window| window == SECRET),
            "{path}"
        );
        dotfile.assert_security_headers(false);
    }
    hello.assert_security_headers(false);
    index.assert_security_headers(false);
    server.stop();
}

#[test]
fn serve_answers_over_https_with_a_certificate_the_test_ca_verifies() {
    let site = Site::new();
    let cert = format!("{FIXTURES}/localhost.pem");
    let key = format!("{FIXTURES}/localhost.key");
    let server = Server::start(
        &site,
        &["--cert", &cert, "--key", &key, "--name", "localhost"],
    );
    assert_eq!(server.scheme, "https");
    let fetch = |path: &str| {
        let conn = ClientConnection::new(tls_client(), ServerName::try_from("localhost").unwrap())
            .unwrap();
        get(&mut StreamOwned::new(conn, server.connect()), path)
    };
    let hello = fetch("/hello.txt");
    assert_eq!(hello.status, 200);
    assert_eq!(hello.body, HELLO);
    hello.assert_security_headers(true);
    let dotfile = fetch("/.env");
    assert_eq!(dotfile.status, 404);
    dotfile.assert_security_headers(true);
    server.stop();
}

/// The documented exception to the security headers: a request the HTTP layer refuses
/// before the handler runs is answered by the driver alone. RFC 9112 Section 3.2: "A
/// server MUST respond with a 400 (Bad Request) status code to any HTTP/1.1 request
/// message that lacks a Host header field"; RFC 9110 Section 7.4: "a request for an
/// "https" resource MUST be rejected unless it has been received over a connection that
/// has been secured via a certificate valid for that target URI's origin", with 421.
#[test]
fn a_400_or_421_the_http_layer_writes_itself_carries_no_security_headers() {
    let site = Site::new();
    let plain = Server::start(&site, &[]);
    let hostless = exchange(
        &mut plain.connect(),
        b"GET / HTTP/1.1\r\nConnection: close\r\n\r\n",
    );
    assert_eq!(hostless.status, 400);
    assert!(
        !carries_security_headers(&hostless),
        "{:?}",
        hostless.fields
    );
    let index = get(&mut plain.connect(), "/");
    assert_eq!(index.status, 200);
    index.assert_security_headers(false);
    plain.stop();
    let cert = format!("{FIXTURES}/localhost.pem");
    let key = format!("{FIXTURES}/localhost.key");
    let secure = Server::start(
        &site,
        &["--cert", &cert, "--key", &key, "--name", "localhost"],
    );
    let conn =
        ClientConnection::new(tls_client(), ServerName::try_from("localhost").unwrap()).unwrap();
    let misdirected = exchange(
        &mut StreamOwned::new(conn, secure.connect()),
        b"GET / HTTP/1.1\r\nHost: other.test\r\nConnection: close\r\n\r\n",
    );
    assert_eq!(misdirected.status, 421);
    assert!(
        !carries_security_headers(&misdirected),
        "{:?}",
        misdirected.fields
    );
    secure.stop();
}

#[test]
fn a_command_line_zero_does_not_take_exits_2_and_names_the_problem() {
    for (args, named) in [
        (&["serve", "--threads", "0"][..], "--threads"),
        (&["serve", "--bogus"], "--bogus"),
        (&["serve", "--cert", "c.pem"], "--key"),
        (
            &["serve", "--cert=", "--key=k.pem", "--name=localhost"],
            "--cert",
        ),
        (&["serve", ""], "DIRECTORY"),
        (&["help", "--threads", "0"], "help takes no arguments"),
        (&["start"], "start"),
        (&[], "no command"),
    ] {
        let output = zero(args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(named), "{args:?}: {stderr}");
        assert!(stderr.contains("zero help"), "{args:?}: {stderr}");
    }
}

#[test]
fn a_missing_directory_or_an_unreadable_certificate_exits_1_before_listening() {
    let site = Site::new();
    let missing = site.root.join("absent");
    let missing = missing.to_str().unwrap();
    let output = zero(&["serve", missing, "--listen", "127.0.0.1:0"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("does not exist"), "{stderr}");
    let root = site.root.to_str().unwrap();
    let cert = site.root.join("absent.pem");
    let cert = cert.to_str().unwrap();
    let key = format!("{FIXTURES}/localhost.key");
    let output = zero(&[
        "serve",
        root,
        "--listen",
        "127.0.0.1:0",
        "--cert",
        cert,
        "--key",
        &key,
        "--name",
        "localhost",
    ]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("cannot read the certificate file"),
        "{stderr}"
    );
    assert!(stderr.contains(cert), "{stderr}");
    assert!(!stderr.contains("serving"), "{stderr}");
}

#[test]
fn version_and_help_print_to_standard_output_and_exit_0() {
    for args in [&["version"][..], &["--version"], &["-V"]] {
        let output = zero(args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("zero {}\n", env!("CARGO_PKG_VERSION"))
        );
    }
    for args in [&["help"][..], &["--help"], &["-h"], &["serve", "--help"]] {
        let output = zero(args);
        assert_eq!(output.status.code(), Some(0), "{args:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("zero serve [DIRECTORY]"), "{args:?}");
        assert!(stdout.contains("--drain SECONDS"), "{args:?}");
    }
}

/// A file larger than the loopback socket buffers on both ends, so the server is still
/// writing it while the client holds off reading.
#[cfg(unix)]
fn large_body() -> Vec<u8> {
    (0..32 * 1024 * 1024_usize)
        .map(|index| (index % 251) as u8)
        .collect()
}

/// Ask for `/large.bin` and read until the response head and the first body bytes
/// arrived, so the response is in flight.
#[cfg(unix)]
fn start_large_response(server: &Server) -> (TcpStream, Vec<u8>) {
    let mut stream = server.connect();
    stream
        .write_all(b"GET /large.bin HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut received = Vec::new();
    let mut chunk = vec![0_u8; 64 * 1024];
    while !received.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).unwrap();
        assert_ne!(read, 0, "the server closed before the response head");
        received.extend_from_slice(&chunk[..read]);
    }
    (stream, received)
}

#[cfg(unix)]
#[test]
fn the_first_sigterm_stops_accepting_lets_the_response_in_flight_finish_and_exits_0_within_the_drain_limit(
) {
    const DRAIN: Duration = Duration::from_secs(20);
    let body = large_body();
    let site = Site::new().with("large.bin", &body);
    let mut server = Server::start(&site, &["--drain", "20"]);
    let (mut stream, mut received) = start_large_response(&server);
    let signaled = Instant::now();
    server.signal("TERM");
    server.line_with("SIGTERM received");
    let deadline = Instant::now() + WAIT;
    while TcpStream::connect(server.addr).is_ok() {
        assert!(
            Instant::now() < deadline,
            "the listener still accepts during the drain"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    stream
        .read_to_end(&mut received)
        .expect("the rest of the body");
    let response = Response::parse(&received);
    assert_eq!(response.status, 200);
    assert_eq!(response.body.len(), body.len());
    assert!(response.body == body, "the body arrived whole and in order");
    let status = server.exit_within(DRAIN.saturating_sub(signaled.elapsed()));
    assert_eq!(status.code(), Some(0), "{status}");
    assert!(signaled.elapsed() < DRAIN);
    server.line_with("zero: stopped");
}

#[cfg(unix)]
#[test]
fn a_second_stop_signal_during_the_drain_exits_at_once_with_128_plus_its_number() {
    let site = Site::new().with("large.bin", &large_body());
    let mut server = Server::start(&site, &["--drain", "600"]);
    let (_stream, _received) = start_large_response(&server);
    server.signal("TERM");
    server.line_with("SIGTERM received");
    server.signal("INT");
    let status = server.exit_within(WAIT);
    assert_eq!(status.code(), Some(128 + 2), "{status}");
    server.line_with("SIGINT received during the drain");
}

/// The runtime adds the drain limit to the current instant at the stop and panics when
/// the sum overflows, so `--drain` refuses more than `MAX_DRAIN`; at that value a
/// `SIGTERM` still stops cleanly.
#[cfg(unix)]
#[test]
fn a_sigterm_with_the_longest_drain_zero_takes_stops_cleanly_and_exits_0() {
    let site = Site::new();
    let longest = zero_serve::MAX_DRAIN.as_secs().to_string();
    let mut server = Server::start(&site, &["--drain", &longest]);
    assert_eq!(get(&mut server.connect(), "/").status, 200);
    server.signal("TERM");
    let status = server.exit_within(WAIT);
    assert_eq!(status.code(), Some(0), "{status}");
    server.line_with("zero: stopped");
}

/// POSIX `open()`: "If O_NONBLOCK is clear, an open() for reading-only shall block the
/// calling thread until a thread opens the file for writing." A FIFO under the served
/// directory is opened without waiting and answered 404, and the one core keeps serving.
#[cfg(unix)]
#[test]
fn a_fifo_in_the_served_directory_is_answered_404_and_its_core_keeps_serving() {
    let site = Site::new();
    let made = Command::new("mkfifo")
        .arg(site.root.join("pipe"))
        .status()
        .expect("the mkfifo utility");
    assert!(made.success(), "mkfifo");
    let server = Server::start(&site, &["--threads", "1"]);
    let pipe = get(&mut server.connect(), "/pipe");
    assert_eq!(pipe.status, 404);
    pipe.assert_security_headers(false);
    let index = get(&mut server.connect(), "/");
    assert_eq!(index.status, 200);
    assert_eq!(index.body, INDEX);
    server.stop();
}
