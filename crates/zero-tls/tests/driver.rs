//! HTTPS end to end over loopback sockets, for both TLS drivers: requests served
//! over TLS, `close_notify` on every close, a truncated body never reaching the
//! handler, the handshake timeout, the per-core limit on handshakes in progress, the
//! server name alerts, `421 Misdirected Request`, and interop with `curl` and
//! `openssl s_client` where they are installed.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::version::{TLS12, TLS13};
use rustls::{AlertDescription, ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use zero_core::Error;
use zero_http::{Call, Config, Handler, Workers};
use zero_limits::{Http1Limits, TlsLimits};
use zero_tls::{serve, Driver, Identities, Identity, TlsOptions};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
const CA: &[u8] = include_bytes!("fixtures/ca.pem");
const LOCALHOST: &[u8] = include_bytes!("fixtures/localhost.pem");
const LOCALHOST_KEY: &[u8] = include_bytes!("fixtures/localhost.key");
const OTHER: &[u8] = include_bytes!("fixtures/other.test.pem");
const OTHER_KEY: &[u8] = include_bytes!("fixtures/other.test.key");
const DRIVERS: [Driver; 2] = [Driver::Buffered, Driver::Unbuffered];

struct App {
    log: Arc<Mutex<Vec<String>>>,
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let path = String::from_utf8_lossy(call.request().path()).into_owned();
        let secure = call.request().is_secure();
        let body = call.request().body().len();
        self.log
            .lock()
            .unwrap()
            .push(format!("{path} secure={secure} body={body}"));
        let reply = match path.as_str() {
            "/big" => vec![b'z'; 300_000],
            _ => format!("hello {}", if secure { "secure" } else { "plain" }).into_bytes(),
        };
        call.response().body(&reply);
        Ok(())
    }
}

struct Server {
    workers: Option<Workers>,
    addr: SocketAddr,
    log: Arc<Mutex<Vec<String>>>,
    identities: Arc<Identities>,
}

fn localhost() -> Identity {
    Identity::from_pem(LOCALHOST, LOCALHOST_KEY, &["localhost", "127.0.0.1"]).unwrap()
}

impl Server {
    fn start(driver: Driver, limits: TlsLimits, threads: usize) -> Self {
        let other = Identity::from_pem(OTHER, OTHER_KEY, &["other.test"]).unwrap();
        let identities = Arc::new(Identities::new(&[localhost(), other], Some(localhost())));
        Server::start_with(driver, limits, threads, identities)
    }

    fn start_with(
        driver: Driver,
        limits: TlsLimits,
        threads: usize,
        identities: Arc<Identities>,
    ) -> Self {
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let config = Config {
            runtime: zero_rt::Config {
                io: zero_io::rt::Config {
                    threads,
                    drain: Duration::from_secs(2),
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
            Arc::clone(&identities),
            TlsOptions {
                limits,
                driver,
                ..TlsOptions::default()
            },
            Arc::new(|_| {}),
            move |_| App {
                log: Arc::clone(&app_log),
            },
        )
        .unwrap();
        let addr = workers.local_addr();
        Server {
            workers: Some(workers),
            addr,
            log,
            identities,
        }
    }

    fn with(driver: Driver) -> Self {
        Server::start(driver, TlsLimits::DEFAULT, 2)
    }

    fn tcp(&self) -> TcpStream {
        let tcp = TcpStream::connect(self.addr).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        tcp
    }

    fn tls(
        &self,
        name: &'static str,
        versions: &[&'static rustls::SupportedProtocolVersion],
    ) -> StreamOwned<ClientConnection, TcpStream> {
        let conn =
            ClientConnection::new(client(versions), ServerName::try_from(name).unwrap()).unwrap();
        StreamOwned::new(conn, self.tcp())
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

fn client(versions: &[&'static rustls::SupportedProtocolVersion]) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(CA).unwrap())
        .unwrap();
    let mut config = ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_protocol_versions(versions)
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

/// Read one response with a `Content-Length` body.
fn response<R: Read>(stream: &mut R) -> (u16, Vec<u8>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    let text = String::from_utf8(head).unwrap();
    let status = text.split(' ').nth(1).unwrap().parse().unwrap();
    let length: usize = text
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).unwrap();
    (status, body)
}

#[test]
fn requests_are_served_over_tls_on_both_drivers_and_reported_secure() {
    for driver in DRIVERS {
        let server = Server::with(driver);
        for versions in [&[&TLS13][..], &[&TLS12][..]] {
            let mut stream = server.tls("localhost", versions);
            stream
                .write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\nGET /big HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            assert_eq!(
                response(&mut stream),
                (200, b"hello secure".to_vec()),
                "{driver:?}"
            );
            let (status, big) = response(&mut stream);
            assert_eq!((status, big.len()), (200, 300_000), "{driver:?}");
            assert!(big.iter().all(|&byte| byte == b'z'));
            stream
                .write_all(b"GET /again HTTP/1.1\r\nHost: localhost:443\r\n\r\n")
                .unwrap();
            assert_eq!(response(&mut stream).0, 200);
        }
        server.stop().unwrap();
    }
}

#[test]
fn the_server_sends_close_notify_before_closing_its_write_side_so_a_client_reads_a_clean_end_of_stream(
) {
    for driver in DRIVERS {
        let server = Server::with(driver);
        let mut stream = server.tls("localhost", &[&TLS13, &TLS12]);
        stream
            .write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        assert_eq!(response(&mut stream).0, 200);
        let mut rest = Vec::new();
        let end = stream.read_to_end(&mut rest);
        assert!(
            matches!(end, Ok(0)),
            "{driver:?}: a clean end of stream, not a truncation: {end:?}"
        );
        assert!(stream.conn.process_new_packets().unwrap().peer_has_closed());
        server.stop().unwrap();
    }
}

#[test]
fn a_close_notify_from_the_client_still_lets_the_server_finish_writing_the_response_in_progress() {
    for driver in DRIVERS {
        let server = Server::with(driver);
        let mut stream = server.tls("localhost", &[&TLS13, &TLS12]);
        stream
            .write_all(b"GET /big HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        stream.conn.send_close_notify();
        stream.flush().unwrap();
        let (status, big) = response(&mut stream);
        assert_eq!((status, big.len()), (200, 300_000), "{driver:?}");
        let mut rest = Vec::new();
        assert!(matches!(stream.read_to_end(&mut rest), Ok(0)), "{driver:?}");
        server.stop().unwrap();
    }
}

#[test]
fn a_transport_close_without_close_notify_in_the_middle_of_a_content_length_or_chunked_body_never_reaches_the_handler(
) {
    for driver in DRIVERS {
        let server = Server::with(driver);
        for request in [
            &b"POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n0123"[..],
            b"POST /upload HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n0123\r\n",
        ] {
            let mut stream = server.tls("localhost", &[&TLS13, &TLS12]);
            stream.write_all(request).unwrap();
            stream.flush().unwrap();
            stream.sock.shutdown(std::net::Shutdown::Write).unwrap();
            let mut rest = Vec::new();
            let _ = stream.read_to_end(&mut rest);
            assert!(rest.is_empty(), "{driver:?}: no response to an incomplete request");
        }
        let log = server.log();
        server.stop().unwrap();
        assert!(
            !log.iter().any(|line| line.starts_with("/upload")),
            "{driver:?}: {log:?}"
        );
    }
}

#[test]
fn a_connection_whose_tls_handshake_has_not_completed_within_the_handshake_timeout_is_closed() {
    assert!(TlsLimits::DEFAULT.handshake_timeout <= Duration::from_secs(120));
    for driver in DRIVERS {
        let limits = TlsLimits {
            handshake_timeout: Duration::from_millis(300),
            ..TlsLimits::DEFAULT
        };
        let server = Server::start(driver, limits, 1);
        let mut tcp = server.tcp();
        tcp.write_all(&[0x16, 0x03, 0x01, 0x02, 0x00, 0x01])
            .unwrap();
        let started = Instant::now();
        let mut byte = [0u8; 1];
        let ended = tcp.read(&mut byte);
        assert!(
            matches!(&ended, Ok(0))
                || matches!(&ended, Err(err) if err.kind() == io::ErrorKind::ConnectionReset),
            "{driver:?}: {ended:?}"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(250),
            "{driver:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(5), "{driver:?}");

        // A client that takes the server's whole flight and never answers it. The
        // buffered driver ends with close_notify (RFC 9846 Section 6.1); rustls's
        // unbuffered state machine can queue no alert during a handshake, so that
        // driver only closes the transport.
        let mut tcp = server.tcp();
        let mut client = ClientConnection::new(
            client(&[&TLS13]),
            ServerName::try_from("localhost").unwrap(),
        )
        .unwrap();
        client.write_tls(&mut tcp).unwrap();
        let started = Instant::now();
        let mut received = Vec::new();
        let _ = tcp.read_to_end(&mut received);
        assert!(
            started.elapsed() >= Duration::from_millis(250),
            "{driver:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(5), "{driver:?}");
        let mut rest = received.as_slice();
        while !rest.is_empty() && client.read_tls(&mut rest).unwrap() > 0 {}
        let state = client.process_new_packets();
        let closed = matches!(&state, Ok(io) if io.peer_has_closed());
        assert_eq!(closed, driver == Driver::Buffered, "{driver:?}: {state:?}");
        server.stop().unwrap();
    }
}

/// Move records between a client and the server until the client's handshake is
/// done.
fn finish(client: &mut ClientConnection, tcp: &mut TcpStream) {
    while client.is_handshaking() {
        while client.wants_write() {
            client.write_tls(tcp).unwrap();
        }
        if client.is_handshaking() && client.wants_read() {
            client.read_tls(tcp).unwrap();
            client.process_new_packets().unwrap();
        }
    }
    while client.wants_write() {
        client.write_tls(tcp).unwrap();
    }
}

#[test]
fn a_reload_during_a_hello_retry_request_keeps_the_certificate_the_listener_chose() {
    for driver in DRIVERS {
        let server = Server::with(driver);
        let mut provider = rustls::crypto::aws_lc_rs::default_provider();
        provider.kx_groups = vec![
            rustls::crypto::aws_lc_rs::kx_group::MLKEM1024,
            rustls::crypto::aws_lc_rs::kx_group::SECP256R1,
        ];
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_slice(CA).unwrap())
            .unwrap();
        let config = ClientConfig::builder_with_provider(Arc::new(provider))
            .with_protocol_versions(&[&TLS13])
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let mut client =
            ClientConnection::new(Arc::new(config), ServerName::try_from("localhost").unwrap())
                .unwrap();
        let mut tcp = server.tcp();
        client.write_tls(&mut tcp).unwrap();
        while !client.wants_write() {
            client.read_tls(&mut tcp).unwrap();
            client.process_new_packets().unwrap();
        }
        // The server asked for another key share; the table loses every identity
        // before the second hello arrives.
        server.identities.replace(&[], None);
        finish(&mut client, &mut tcp);
        assert_eq!(
            client.handshake_kind(),
            Some(rustls::HandshakeKind::FullWithHelloRetryRequest),
            "{driver:?}"
        );
        let mut stream = StreamOwned::new(client, tcp);
        stream
            .write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        assert_eq!(response(&mut stream).0, 200, "{driver:?}");
        server.stop().unwrap();
    }
}

#[test]
fn a_client_that_connects_by_address_without_a_server_name_gets_the_identity_listing_that_address()
{
    for driver in DRIVERS {
        let identities = Arc::new(Identities::new(&[localhost()], None));
        let server = Server::start_with(driver, TlsLimits::DEFAULT, 1, identities);
        let ip = ServerName::IpAddress(std::net::Ipv4Addr::LOCALHOST.into());
        let conn = ClientConnection::new(client(&[&TLS13, &TLS12]), ip).unwrap();
        let mut stream = StreamOwned::new(conn, server.tcp());
        stream
            .write_all(b"GET /hello HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        assert_eq!(
            response(&mut stream),
            (200, b"hello secure".to_vec()),
            "{driver:?}"
        );
        stream
            .write_all(b"GET /hello HTTP/1.1\r\nHost: [::ffff:127.0.0.1]\r\n\r\n")
            .unwrap();
        assert_eq!(response(&mut stream).0, 200, "{driver:?}");
        server.stop().unwrap();
    }
}

#[test]
fn a_handshake_message_sent_one_byte_per_record_is_refused_once_it_outgrows_the_largest_message() {
    for driver in DRIVERS {
        let limits = TlsLimits {
            handshake_timeout: Duration::from_secs(6),
            ..TlsLimits::DEFAULT
        };
        let server = Server::start(driver, limits, 1);
        let mut tcp = server.tcp();
        let mut client = ClientConnection::new(
            client(&[&TLS12]),
            ServerName::try_from("localhost").unwrap(),
        )
        .unwrap();
        client.write_tls(&mut tcp).unwrap();
        let mut flight = [0u8; 1024];
        assert!(tcp.read(&mut flight).unwrap() > 0, "{driver:?}: the flight");
        // A client_key_exchange header claiming 65535 bytes, then its body one byte
        // per plaintext record, 6 bytes on the wire for each byte of message.
        let mut records = Vec::new();
        for byte in [0x10, 0x00, 0xff, 0xff]
            .into_iter()
            .chain(std::iter::repeat_n(0u8, 30_000))
        {
            records.extend_from_slice(&[0x16, 0x03, 0x03, 0x00, 0x01, byte]);
        }
        let started = Instant::now();
        let _ = tcp.write_all(&records);
        let mut rest = Vec::new();
        let ended = tcp.read_to_end(&mut rest);
        assert!(
            ended.is_ok()
                || matches!(&ended, Err(err) if err.kind() == io::ErrorKind::ConnectionReset),
            "{driver:?}: {ended:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{driver:?}: closed before the handshake timeout, after {:?}",
            started.elapsed()
        );
        server.stop().unwrap();
    }
}

#[test]
fn a_record_that_fails_decryption_is_answered_with_a_fatal_bad_record_mac_alert() {
    for driver in DRIVERS {
        let server = Server::with(driver);
        for versions in [&[&TLS13][..], &[&TLS12][..]] {
            let mut stream = server.tls("localhost", versions);
            stream
                .write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            assert_eq!(response(&mut stream).0, 200);
            let StreamOwned { mut conn, mut sock } = stream;
            conn.writer()
                .write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            let mut record = Vec::new();
            conn.write_tls(&mut record).unwrap();
            let last = record.len() - 1;
            record[last] ^= 0x01;
            sock.write_all(&record).unwrap();
            let mut received = Vec::new();
            let _ = sock.read_to_end(&mut received);
            let mut rest = received.as_slice();
            while !rest.is_empty() && conn.read_tls(&mut rest).unwrap() > 0 {}
            let state = conn.process_new_packets();
            assert!(
                matches!(
                    state,
                    Err(rustls::Error::AlertReceived(AlertDescription::BadRecordMac))
                ),
                "{driver:?} {versions:?}: RFC 9846 Section 5.2: {state:?}"
            );
        }
        server.stop().unwrap();
    }
}

#[test]
fn a_core_keeps_at_most_its_limit_of_handshakes_in_progress_and_the_rest_wait() {
    for driver in DRIVERS {
        let limits = TlsLimits {
            max_handshakes_per_core: 1,
            ..TlsLimits::DEFAULT
        };
        let server = Server::start(driver, limits, 1);
        let idle = server.tcp();
        let mut waiting = server.tls("localhost", &[&TLS13]);
        waiting
            .sock
            .set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let request = b"GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let early = waiting.write_all(request);
        assert!(
            matches!(&early, Err(err) if matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)),
            "{driver:?}: no handshake while the slot is taken: {early:?}"
        );
        assert!(waiting.conn.is_handshaking());
        drop(idle);
        waiting
            .sock
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        waiting.write_all(request).unwrap();
        assert_eq!(
            response(&mut waiting),
            (200, b"hello secure".to_vec()),
            "{driver:?}"
        );
        server.stop().unwrap();
    }
}

#[test]
fn a_request_whose_host_is_not_covered_by_the_certificate_that_secured_the_connection_is_answered_421_and_an_unknown_server_name_gets_unrecognized_name(
) {
    for driver in DRIVERS {
        let server = Server::with(driver);
        let mut unknown = server.tls("unknown.test", &[&TLS13]);
        let failed = unknown
            .write_all(b"GET / HTTP/1.1\r\n\r\n")
            .and_then(|()| unknown.flush());
        let mut byte = [0u8; 1];
        let refused = failed.and_then(|()| unknown.read(&mut byte).map(|_| ()));
        let err = refused.unwrap_err();
        let inner = err
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<rustls::Error>())
            .cloned();
        assert_eq!(
            inner,
            Some(rustls::Error::AlertReceived(
                AlertDescription::UnrecognisedName
            )),
            "{driver:?}: {err:?}"
        );

        let mut other = server.tls("other.test", &[&TLS13]);
        other
            .write_all(b"GET /hello HTTP/1.1\r\nHost: other.test\r\n\r\n")
            .unwrap();
        assert_eq!(response(&mut other).0, 200);
        let served = other.conn.peer_certificates().unwrap()[0].clone();
        assert_eq!(served, CertificateDer::from_pem_slice(OTHER).unwrap());
        other
            .write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        assert_eq!(
            response(&mut other).0,
            421,
            "{driver:?}: RFC 9110 Section 7.4"
        );
        server.stop().unwrap();
    }
}

/// Run a program if it is installed; `None` when it is not.
fn run(program: &str, args: &[&str], input: &[u8]) -> Option<(bool, String)> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(input).ok()?;
    let output = child.wait_with_output().ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Some((output.status.success(), text))
}

#[test]
fn both_drivers_interoperate_with_curl_and_openssl_s_client() {
    let ca = format!("{FIXTURES}/ca.pem");
    for driver in DRIVERS {
        let server = Server::with(driver);
        let port = server.addr.port().to_string();
        let resolve = format!("localhost:{port}:127.0.0.1");
        let url = format!("https://localhost:{port}/hello");
        for version in ["--tlsv1.3", "--tlsv1.2"] {
            let max = if version == "--tlsv1.2" { "1.2" } else { "1.3" };
            if let Some((ok, text)) = run(
                "curl",
                &[
                    "-sS",
                    "--cacert",
                    &ca,
                    "--resolve",
                    &resolve,
                    version,
                    "--tls-max",
                    max,
                    &url,
                ],
                b"",
            ) {
                assert!(
                    ok && text.contains("hello secure"),
                    "{driver:?} curl {version}: {text}"
                );
            }
        }
        let connect = format!("127.0.0.1:{port}");
        if let Some((_, text)) = run(
            "openssl",
            &[
                "s_client",
                "-connect",
                &connect,
                "-servername",
                "localhost",
                "-CAfile",
                &ca,
                "-alpn",
                "http/1.1",
                "-quiet",
                "-verify_return_error",
            ],
            b"GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        ) {
            assert!(text.contains("hello secure"), "{driver:?} s_client: {text}");
        }
        if let Some((ok, text)) = run(
            "openssl",
            &[
                "s_client",
                "-connect",
                &connect,
                "-servername",
                "localhost",
                "-CAfile",
                &ca,
                "-alpn",
                "h2",
            ],
            b"",
        ) {
            // OpenSSL names the alert in some builds and prints its number,
            // no_application_protocol(120), in others.
            let text_lower = text.to_ascii_lowercase();
            assert!(
                !ok && (text_lower.contains("no application protocol")
                    || text_lower.contains("alert number 120")),
                "{driver:?} s_client with ALPN h2: {text}"
            );
        }
        server.stop().unwrap();
    }
}
