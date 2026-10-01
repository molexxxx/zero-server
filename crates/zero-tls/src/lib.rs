//! TLS for zero-server over the runtime seam.
//!
//! [`server_config`] builds the rustls `ServerConfig` with the project defaults:
//! TLS 1.3 and 1.2, ECDHE AEAD suites only, the extended main secret required on
//! TLS 1.2, ALPN `http/1.1`, no early data, stateless tickets that rotate. The
//! [`Identities`] table picks a certificate by the client's server name and is
//! replaced whole on reload. [`TlsAccept`] runs on each core: it reads the client's
//! hello, refuses one that offers no version the server speaks with
//! `protocol_version` and a TLS 1.3 hello without its required extensions with
//! `missing_extension`, refuses an unknown name with `unrecognized_name` and a missing
//! one, when there is no default identity, with `missing_extension`, completes the handshake
//! under the handshake timeout and the per-core limit on handshakes in progress, and
//! hands the HTTP driver a [`TlsStream`] that serves only its identity's names. Two
//! drivers implement the stream: [`BufferedStream`] over rustls's buffered connection,
//! the default on the readiness backend, and [`UnbufferedStream`] over its unbuffered
//! state machine, the default on the completion backend. Both send `close_notify`
//! before closing their write side. [`serve`] starts an HTTPS server.
//!
//! The provider is aws-lc-rs, passed to rustls explicitly and never installed as the
//! process default, since a host runtime that loads the core may own that. OCSP
//! stapling, client certificates and kTLS come in a later release.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html>
//! @see <https://www.rfc-editor.org/rfc/rfc9325.html>
//! @see <https://docs.rs/rustls/0.23.45/rustls/>

mod accept;
pub mod buffered;
mod config;
mod hello;
mod identity;
mod outbox;
pub mod unbuffered;

use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

use rustls::crypto::CryptoProvider;
use zero_http::{Handler, StatusSink, Worker, Workers};

pub use accept::{TlsAccept, TlsStream};
pub use buffered::BufferedStream;
pub use config::{server_config, Driver, TlsOptions, MAX_TICKET_LIFETIME};
pub use identity::{Identities, Identity};
pub use unbuffered::UnbufferedStream;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The aws-lc-rs provider, made once.
pub(crate) fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    Arc::clone(PROVIDER.get_or_init(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider())))
}

/// Start an HTTPS server: [`zero_http::serve_with`] with a [`TlsAccept`] on every core.
///
/// # Arguments
///
/// * `addr` - where to listen; port 0 picks one.
/// * `config` - the HTTP settings.
/// * `identities` - the certificates; keep the `Arc` to reload them.
/// * `options` - the TLS options.
/// * `status` - the status callback for started, stopped and panicking cores.
/// * `make` - builds the core's handler; called on each worker's thread.
///
/// # Returns
///
/// The workers, already listening.
///
/// # Errors
///
/// `InvalidInput` for options the provider cannot serve, limits that allow no
/// handshake at all, or an ALPN protocol other than `http/1.1`, which the HTTP/1.1
/// driver would then be handed without speaking it (RFC 7301 Section 3.2); otherwise
/// as [`zero_http::serve`].
///
/// @see <https://www.rfc-editor.org/rfc/rfc7301.html#section-3.2>
pub fn serve<H, M>(
    addr: SocketAddr,
    config: zero_http::Config,
    identities: Arc<Identities>,
    options: TlsOptions,
    status: StatusSink,
    make: M,
) -> io::Result<Workers>
where
    H: Handler,
    M: Fn(&Worker) -> H + Send + Sync + 'static,
{
    if options.limits.max_handshakes_per_core == 0 || options.limits.handshake_timeout.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the TLS limits allow no handshake",
        ));
    }
    if let Some(other) = options
        .alpn
        .iter()
        .find(|protocol| protocol.as_slice() != HTTP_1_1)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "the ALPN protocol {:?} is not one this server speaks",
                String::from_utf8_lossy(other)
            ),
        ));
    }
    let tls = server_config(Arc::clone(&identities), &options)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
    zero_http::serve_with(addr, config, status, make, move |worker| {
        TlsAccept::new(
            Arc::clone(&identities),
            Arc::clone(&tls),
            worker.clone(),
            &options,
        )
    })
}

/// The ALPN identifier of HTTP/1.1 (RFC 7301 Section 6).
const HTTP_1_1: &[u8] = b"http/1.1";

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rustls::client::Resumption;
    use rustls::crypto::{aws_lc_rs, CryptoProvider};
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, ServerName};
    use rustls::server::ServerSessionMemoryCache;
    use rustls::version::{TLS12, TLS13};
    use rustls::{
        AlertDescription, ClientConfig, ClientConnection, Error, HandshakeKind, NamedGroup,
        PeerIncompatible, ProtocolVersion, RootCertStore, ServerConfig, ServerConnection,
    };

    use super::hello::{
        fatal_alert, Hello, HelloReader, MISSING_EXTENSION, PROTOCOL_VERSION, UNRECOGNIZED_NAME,
    };
    use super::identity::Choice;
    use super::{
        provider, serve, server_config, Identities, Identity, TlsOptions, MAX_TICKET_LIFETIME,
    };

    const CA: &[u8] = include_bytes!("../tests/fixtures/ca.pem");
    const LOCALHOST: &[u8] = include_bytes!("../tests/fixtures/localhost.pem");
    const LOCALHOST_KEY: &[u8] = include_bytes!("../tests/fixtures/localhost.key");
    const OTHER: &[u8] = include_bytes!("../tests/fixtures/other.test.pem");
    const OTHER_KEY: &[u8] = include_bytes!("../tests/fixtures/other.test.key");

    fn localhost() -> Identity {
        Identity::from_pem(LOCALHOST, LOCALHOST_KEY, &["localhost"]).unwrap()
    }

    fn identities() -> Arc<Identities> {
        let other = Identity::from_pem(OTHER, OTHER_KEY, &["other.test"]).unwrap();
        Arc::new(Identities::new(&[localhost(), other], None))
    }

    fn server_with(options: &TlsOptions) -> Arc<ServerConfig> {
        server_config(identities(), options).unwrap()
    }

    fn server() -> Arc<ServerConfig> {
        server_with(&TlsOptions::default())
    }

    fn roots() -> RootCertStore {
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_slice(CA).unwrap())
            .unwrap();
        roots
    }

    fn client_with(
        provider: Arc<CryptoProvider>,
        versions: &[&'static rustls::SupportedProtocolVersion],
        alpn: &[&[u8]],
    ) -> ClientConfig {
        let mut config = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(versions)
            .unwrap()
            .with_root_certificates(roots())
            .with_no_client_auth();
        config.alpn_protocols = alpn.iter().map(|protocol| protocol.to_vec()).collect();
        config
    }

    fn client_config(alpn: &[&[u8]]) -> ClientConfig {
        client_with(provider(), &[&TLS13, &TLS12], alpn)
    }

    fn connect(config: &Arc<ClientConfig>, name: &'static str) -> ClientConnection {
        ClientConnection::new(Arc::clone(config), ServerName::try_from(name).unwrap()).unwrap()
    }

    /// Move every record the client has for the server.
    fn to_server(
        client: &mut ClientConnection,
        server: &mut ServerConnection,
    ) -> Result<Vec<u8>, Error> {
        let mut bytes = Vec::new();
        while client.wants_write() {
            client.write_tls(&mut bytes).unwrap();
        }
        let mut rest = &bytes[..];
        while !rest.is_empty() {
            if server.read_tls(&mut rest).unwrap() == 0 {
                break;
            }
            server.process_new_packets()?;
        }
        Ok(bytes)
    }

    /// Move every record the server has for the client.
    fn to_client(
        server: &mut ServerConnection,
        client: &mut ClientConnection,
    ) -> (Vec<u8>, Result<(), Error>) {
        let mut bytes = Vec::new();
        while server.wants_write() {
            server.write_tls(&mut bytes).unwrap();
        }
        let mut rest = &bytes[..];
        while !rest.is_empty() {
            if client.read_tls(&mut rest).unwrap() == 0 {
                break;
            }
            if let Err(err) = client.process_new_packets() {
                return (bytes, Err(err));
            }
        }
        (bytes, Ok(()))
    }

    /// A handshake that failed: the server's error, the records it sent after it,
    /// and the client's error on reading them.
    #[derive(Debug)]
    struct Failure {
        server: Error,
        alert: Vec<u8>,
        client: Option<Error>,
    }

    /// Run a handshake to its end.
    fn handshake(
        client: &mut ClientConnection,
        server: &mut ServerConnection,
    ) -> Result<(), Box<Failure>> {
        for _ in 0..16 {
            if let Err(err) = to_server(client, server) {
                let (alert, delivered) = to_client(server, client);
                return Err(Box::new(Failure {
                    server: err,
                    alert,
                    client: delivered.err(),
                }));
            }
            let (_, delivered) = to_client(server, client);
            if let Err(err) = delivered {
                return Err(Box::new(Failure {
                    server: err.clone(),
                    alert: Vec::new(),
                    client: Some(err),
                }));
            }
            if !client.is_handshaking() && !server.is_handshaking() {
                return Ok(());
            }
        }
        panic!("the handshake did not finish");
    }

    fn session(
        client_config: &Arc<ClientConfig>,
        server_config: &Arc<ServerConfig>,
    ) -> (ClientConnection, ServerConnection) {
        let mut client = connect(client_config, "localhost");
        let mut server = ServerConnection::new(Arc::clone(server_config)).unwrap();
        handshake(&mut client, &mut server).unwrap();
        (client, server)
    }

    /// A hand-built ClientHello: the record, the handshake header, the version, a
    /// random, no session id, the suites, null compression and the extensions.
    /// One extension: its type, its length and its data.
    fn extension(kind: u16, data: &[u8]) -> Vec<u8> {
        let mut out = kind.to_be_bytes().to_vec();
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
        out.extend_from_slice(data);
        out
    }

    /// The `server_name` extension for `name`.
    fn sni(name: &[u8]) -> Vec<u8> {
        let mut list = vec![0x00];
        list.extend_from_slice(&(name.len() as u16).to_be_bytes());
        list.extend_from_slice(name);
        let mut data = (list.len() as u16).to_be_bytes().to_vec();
        data.extend_from_slice(&list);
        extension(0, &data)
    }

    /// A hand-built hello record with exactly these extensions.
    fn client_hello(legacy: [u8; 2], suites: &[[u8; 2]], extensions: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&legacy);
        body.extend_from_slice(&[0x5a; 32]);
        body.push(0x00);
        body.extend_from_slice(&((suites.len() * 2) as u16).to_be_bytes());
        for suite in suites {
            body.extend_from_slice(suite);
        }
        body.extend_from_slice(&[0x01, 0x00]);
        if !extensions.is_empty() {
            body.extend_from_slice(&(extensions.len() as u16).to_be_bytes());
            body.extend_from_slice(extensions);
        }
        let mut handshake = vec![0x01];
        handshake.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
        handshake.extend_from_slice(&body);
        let mut record = vec![0x16, 0x03, 0x01];
        record.extend_from_slice(&(handshake.len() as u16).to_be_bytes());
        record.extend_from_slice(&handshake);
        record
    }

    /// What the listener's hello reader decides for one whole hello.
    fn gate(bytes: &[u8], tls12: bool) -> Hello {
        HelloReader::new(tls12)
            .push(bytes)
            .expect("the hello is whole")
    }

    fn hello(
        legacy: [u8; 2],
        suites: &[[u8; 2]],
        ems: bool,
        versions: Option<&[[u8; 2]]>,
    ) -> Vec<u8> {
        let mut extensions = sni(b"localhost");
        extensions.extend_from_slice(&[0x00, 0x0a, 0x00, 0x04, 0x00, 0x02, 0x00, 0x17]);
        extensions.extend_from_slice(&[0x00, 0x0d, 0x00, 0x04, 0x00, 0x02, 0x04, 0x03]);
        if ems {
            extensions.extend_from_slice(&[0x00, 0x17, 0x00, 0x00]);
        }
        if let Some(versions) = versions {
            let mut data = vec![(versions.len() * 2) as u8];
            for version in versions {
                data.extend_from_slice(version);
            }
            extensions.extend_from_slice(&extension(43, &data));
        }
        client_hello(legacy, suites, &extensions)
    }

    /// Feed a hand-built hello to a server and collect its answer.
    fn answer(config: &Arc<ServerConfig>, hello: &[u8]) -> (Result<(), Error>, Vec<u8>) {
        let mut server = ServerConnection::new(Arc::clone(config)).unwrap();
        let mut rest = hello;
        server.read_tls(&mut rest).unwrap();
        let processed = server.process_new_packets().map(|_| ());
        let mut out = Vec::new();
        while server.wants_write() {
            server.write_tls(&mut out).unwrap();
        }
        (processed, out)
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn the_server_picks_the_most_preferred_protocol_both_sides_support_and_with_no_overlap_it_fails_the_handshake_with_a_fatal_no_application_protocol_alert(
    ) {
        let config = server();
        let h2_only = Arc::new(client_config(&[b"h2"]));
        let mut client = connect(&h2_only, "localhost");
        let mut server = ServerConnection::new(Arc::clone(&config)).unwrap();
        let failure = handshake(&mut client, &mut server).unwrap_err();
        assert_eq!(failure.server, Error::NoApplicationProtocol);
        assert_eq!(
            failure.client,
            Some(Error::AlertReceived(
                AlertDescription::NoApplicationProtocol
            )),
            "on TLS 1.3 the alert follows the ServerHello, encrypted"
        );
        let h2_only12 = Arc::new(client_with(provider(), &[&TLS12], &[b"h2"]));
        let mut client = connect(&h2_only12, "localhost");
        let mut server = ServerConnection::new(Arc::clone(&config)).unwrap();
        let failure = handshake(&mut client, &mut server).unwrap_err();
        assert_eq!(failure.server, Error::NoApplicationProtocol);
        assert_eq!(
            failure.alert,
            [0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x78],
            "on TLS 1.2 the fatal no_application_protocol alert goes out in the clear"
        );
        assert_eq!(
            failure.client,
            Some(Error::AlertReceived(
                AlertDescription::NoApplicationProtocol
            ))
        );

        let both = Arc::new(client_config(&[b"h2", b"http/1.1"]));
        let (client, server) = session(&both, &config);
        assert_eq!(server.alpn_protocol(), Some(&b"http/1.1"[..]));
        assert_eq!(client.alpn_protocol(), Some(&b"http/1.1"[..]));

        let preferred = server_with(&TlsOptions {
            alpn: vec![b"http/1.1".to_vec(), b"x-test".to_vec()],
            ..TlsOptions::default()
        });
        let reversed = Arc::new(client_config(&[b"x-test", b"http/1.1"]));
        let (_, server) = session(&reversed, &preferred);
        assert_eq!(
            server.alpn_protocol(),
            Some(&b"http/1.1"[..]),
            "the server's order decides"
        );
    }

    #[test]
    fn status_0_rtt_early_data_is_never_accepted_so_early_data_a_client_sends_is_skipped_and_its_request_is_served_only_after_the_handshake_completes(
    ) {
        let config = server();
        assert_eq!(config.max_early_data_size, 0);
        assert!(!config.send_half_rtt_data);

        let mut eager = client_config(&[b"http/1.1"]);
        eager.enable_early_data = true;
        // rustls sizes its client cache in servers of eight tickets each; a cache of
        // eight or fewer evicts every ticket as it is stored.
        eager.resumption = Resumption::in_memory_sessions(256);
        let eager = Arc::new(eager);
        let (mut first, mut server) = session(&eager, &config);
        let _ = to_client(&mut server, &mut first);
        let mut second = connect(&eager, "localhost");
        assert!(
            second.early_data().is_none(),
            "a ticket from this server allows no early data"
        );
        let mut server = ServerConnection::new(Arc::clone(&config)).unwrap();
        handshake(&mut second, &mut server).unwrap();
        assert_eq!(second.handshake_kind(), Some(HandshakeKind::Resumed));
        assert!(server.early_data().is_none());

        let shared = ServerSessionMemoryCache::new(16);
        let mut lenient = (*server_with(&TlsOptions {
            tickets: false,
            ..TlsOptions::default()
        }))
        .clone();
        lenient.max_early_data_size = 1024;
        lenient.session_storage = shared.clone();
        let lenient = Arc::new(lenient);
        let mut strict = (*config).clone();
        strict.session_storage = shared;
        let strict = Arc::new(strict);
        let (mut primed, mut issuer) = session(&eager, &lenient);
        let _ = to_client(&mut issuer, &mut primed);
        let mut replaying = connect(&eager, "localhost");
        if let Some(mut early) = replaying.early_data() {
            use std::io::Write;
            early
                .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
        }
        let mut server = ServerConnection::new(strict).unwrap();
        handshake(&mut replaying, &mut server).unwrap();
        assert!(
            !replaying.is_early_data_accepted(),
            "early data offered to the server is skipped"
        );
        assert!(server.early_data().is_none());
    }

    #[test]
    fn the_server_negotiates_only_tls_1_3_and_tls_1_2_and_a_clienthello_offering_nothing_newer_than_tls_1_1_is_refused_with_a_fatal_protocol_version_alert(
    ) {
        let config = server();
        for (legacy, versions) in [
            ([0x03, 0x02], None),
            ([0x03, 0x01], None),
            ([0x03, 0x03], Some(&[[0x03, 0x02], [0x03, 0x01]][..])),
        ] {
            let (processed, out) = answer(&config, &hello(legacy, &[[0xc0, 0x2b]], true, versions));
            assert!(
                matches!(processed, Err(Error::PeerIncompatible(_))),
                "{legacy:?} {versions:?}: {processed:?}"
            );
            assert_eq!(out.first(), Some(&0x15), "an alert record, no ServerHello");
            assert!(out.ends_with(&[0x02, 0x46]), "protocol_version: {out:?}");
        }
        // The listener decides before rustls looks at anything else, so the alert is
        // the same for a hello without signature_algorithms, as TLS 1.0 and 1.1
        // clients send, and for one naming a server the listener does not serve.
        for bytes in [
            hello([0x03, 0x01], &[[0xc0, 0x2b]], true, None),
            client_hello([0x03, 0x01], &[[0x00, 0x2f]], &[]),
            client_hello([0x03, 0x02], &[[0x00, 0x2f]], &sni(b"unknown.test")),
            hello(
                [0x03, 0x03],
                &[[0xc0, 0x2b]],
                true,
                Some(&[[0x03, 0x02], [0x03, 0x01]]),
            ),
            // RFC 9846 Section 4.1.2: a TLS 1.3 hello's legacy_version is 0x0303.
            hello([0x03, 0x04], &[[0x13, 0x01]], true, Some(&[[0x03, 0x04]])),
        ] {
            match gate(&bytes, true) {
                Hello::Refused(record, _) => assert_eq!(record, fatal_alert(PROTOCOL_VERSION)),
                other => panic!("{other:?}"),
            }
        }
        match gate(&hello([0x03, 0x03], &[[0xc0, 0x2b]], true, None), false) {
            Hello::Refused(record, _) => assert_eq!(
                record,
                fatal_alert(PROTOCOL_VERSION),
                "a TLS 1.2 hello to a listener with TLS 1.2 off"
            ),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_tls_1_3_clienthello_without_the_extensions_rfc_9846_section_9_2_requires_is_refused_with_a_fatal_missing_extension_alert(
    ) {
        let versions = extension(43, &[0x02, 0x03, 0x04]);
        let signatures = extension(13, &[0x00, 0x02, 0x04, 0x03]);
        let groups = extension(10, &[0x00, 0x02, 0x00, 0x17]);
        let shares = extension(51, &[0x00, 0x00]);
        let name = sni(b"localhost");
        let suites = &[[0x13, 0x01]];
        for extensions in [
            [&versions[..], &name, &groups, &shares].concat(),
            [&versions[..], &name, &signatures, &shares].concat(),
            [&versions[..], &name, &signatures, &groups].concat(),
            [&versions[..], &name, &signatures].concat(),
        ] {
            match gate(&client_hello([0x03, 0x03], suites, &extensions), true) {
                Hello::Refused(record, _) => assert_eq!(record, fatal_alert(MISSING_EXTENSION)),
                other => panic!("{other:?}"),
            }
        }
        let whole = [&versions[..], &name, &signatures, &groups, &shares].concat();
        assert!(
            matches!(
                gate(&client_hello([0x03, 0x03], suites, &whole), true),
                Hello::Read(Some(name), _) if name == "localhost"
            ),
            "an empty key_share list is permitted"
        );
    }

    #[test]
    fn a_client_hello_spread_over_several_records_and_reads_is_read_whole() {
        let mut config = client_config(&[]);
        config.alpn_protocols = (0..100)
            .map(|index| format!("{index:0>200}").into_bytes())
            .collect();
        let mut client = connect(&Arc::new(config), "localhost");
        let mut bytes = Vec::new();
        while client.wants_write() {
            client.write_tls(&mut bytes).unwrap();
        }
        assert!(bytes.len() > 18_437, "two records: {}", bytes.len());
        let mut reader = HelloReader::new(true);
        let mut decided = None;
        for chunk in bytes.chunks(8 * 1024) {
            assert!(decided.is_none());
            decided = reader.push(chunk);
        }
        assert!(
            matches!(&decided, Some(Hello::Read(Some(name), _)) if name == "localhost"),
            "{decided:?}"
        );
    }

    struct Nothing;

    impl zero_http::Handler for Nothing {
        async fn handle(&self, _call: &mut zero_http::Call<'_>) -> zero_core::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn the_server_shall_not_select_a_protocol_it_then_does_not_speak_so_serve_refuses_any_alpn_protocol_but_http_1_1(
    ) {
        for alpn in [
            vec![b"h2".to_vec(), b"http/1.1".to_vec()],
            vec![b"x-test".to_vec()],
        ] {
            let refused = serve(
                "127.0.0.1:0".parse().unwrap(),
                zero_http::Config::default(),
                identities(),
                TlsOptions {
                    alpn,
                    ..TlsOptions::default()
                },
                Arc::new(|_| {}),
                |_| Nothing,
            );
            assert_eq!(
                refused.err().map(|err| err.kind()),
                Some(std::io::ErrorKind::InvalidInput)
            );
        }
    }

    #[test]
    fn when_the_client_offers_tls_1_3_the_server_selects_tls_1_3() {
        let config = server();
        let (client, server) = session(&Arc::new(client_config(&[b"http/1.1"])), &config);
        assert_eq!(server.protocol_version(), Some(ProtocolVersion::TLSv1_3));
        assert_eq!(client.protocol_version(), Some(ProtocolVersion::TLSv1_3));
        let older = Arc::new(client_with(provider(), &[&TLS12], &[b"http/1.1"]));
        let (_, server) = session(&older, &config);
        assert_eq!(server.protocol_version(), Some(ProtocolVersion::TLSv1_2));
    }

    #[test]
    fn a_tls_1_2_serverhello_from_a_server_that_also_supports_tls_1_3_ends_its_random_with_the_downgrade_sentinel(
    ) {
        let older = Arc::new(client_with(provider(), &[&TLS12], &[b"http/1.1"]));
        let mut client = connect(&older, "localhost");
        let mut server = ServerConnection::new(server()).unwrap();
        to_server(&mut client, &mut server).unwrap();
        let (flight, _) = to_client(&mut server, &mut client);
        assert_eq!(flight.get(35..43), Some(&b"DOWNGRD\x01"[..]));
    }

    #[test]
    fn tls_1_2_is_negotiated_only_with_ecdhe_aead_cipher_suites_and_a_clienthello_offering_only_static_rsa_or_finite_field_dhe_suites_is_refused(
    ) {
        let config = server();
        for suite in &config.crypto_provider().cipher_suites {
            if let rustls::SupportedCipherSuite::Tls12(suite) = suite {
                let name = format!("{:?}", suite.common.suite);
                assert!(name.contains("ECDHE"), "{name}");
                assert!(
                    name.contains("GCM") || name.contains("CHACHA20_POLY1305"),
                    "{name}"
                );
            }
        }
        let (processed, out) = answer(
            &config,
            &hello([0x03, 0x03], &[[0x00, 0x9c], [0x00, 0x9e]], true, None),
        );
        assert_eq!(
            processed,
            Err(Error::PeerIncompatible(
                PeerIncompatible::NoCipherSuitesInCommon
            ))
        );
        assert!(out.ends_with(&[0x02, 0x28]), "handshake_failure: {out:?}");
    }

    #[test]
    fn a_client_offering_only_tls_aes_128_gcm_sha256_and_secp256r1_completes_a_tls_1_3_handshake() {
        let minimal = CryptoProvider {
            cipher_suites: vec![aws_lc_rs::cipher_suite::TLS13_AES_128_GCM_SHA256],
            kx_groups: vec![aws_lc_rs::kx_group::SECP256R1],
            ..aws_lc_rs::default_provider()
        };
        let config = Arc::new(client_with(Arc::new(minimal), &[&TLS13], &[b"http/1.1"]));
        let (_, server) = session(&config, &server());
        assert_eq!(
            server.negotiated_cipher_suite().map(|suite| suite.suite()),
            Some(rustls::CipherSuite::TLS13_AES_128_GCM_SHA256)
        );
        assert_eq!(
            server
                .negotiated_key_exchange_group()
                .map(|group| group.name()),
            Some(NamedGroup::secp256r1)
        );
    }

    #[test]
    fn on_tls_1_2_a_clienthello_without_the_extended_main_secret_extension_is_refused_with_a_fatal_handshake_failure_alert(
    ) {
        let config = server();
        let (processed, out) = answer(&config, &hello([0x03, 0x03], &[[0xc0, 0x2b]], false, None));
        assert_eq!(
            processed,
            Err(Error::PeerIncompatible(
                PeerIncompatible::ExtendedMasterSecretExtensionRequired
            ))
        );
        assert!(out.ends_with(&[0x02, 0x28]), "handshake_failure: {out:?}");

        let lenient = server_with(&TlsOptions {
            require_ems: false,
            ..TlsOptions::default()
        });
        let (processed, out) = answer(&lenient, &hello([0x03, 0x03], &[[0xc0, 0x2b]], false, None));
        assert!(
            processed.is_ok(),
            "the option turns the rule off: {processed:?}"
        );
        assert_eq!(out.first(), Some(&0x16));

        let (processed, out) = answer(&config, &hello([0x03, 0x03], &[[0xc0, 0x2b]], true, None));
        assert!(processed.is_ok());
        assert!(
            contains(&out, &[0x00, 0x17, 0x00, 0x00]),
            "the ServerHello echoes the extension"
        );
    }

    #[test]
    fn on_tls_1_2_a_clienthello_carrying_tls_empty_renegotiation_info_scsv_receives_an_empty_renegotiation_info_extension(
    ) {
        let (processed, out) = answer(
            &server(),
            &hello([0x03, 0x03], &[[0xc0, 0x2b], [0x00, 0xff]], true, None),
        );
        assert!(processed.is_ok());
        assert!(contains(&out, &[0xff, 0x01, 0x00, 0x01, 0x00]), "{out:?}");
    }

    #[test]
    fn a_clienthello_without_the_alpn_extension_gets_no_alpn_extension_in_the_reply_and_is_served_http_1_1(
    ) {
        let (client, server) = session(&Arc::new(client_config(&[])), &server());
        assert_eq!(server.alpn_protocol(), None);
        assert_eq!(
            client.alpn_protocol(),
            None,
            "a reply carrying ALPN would have aborted the client"
        );
    }

    #[test]
    fn a_clienthello_naming_a_server_the_configuration_has_no_certificate_for_is_refused_with_a_fatal_unrecognized_name_alert(
    ) {
        let table = identities();
        let config = Arc::new(client_config(&[b"http/1.1"]));
        for (name, expected) in [
            ("unknown.test", None),
            ("localhost", Some("localhost")),
            ("OTHER.test", Some("other.test")),
        ] {
            let mut client = connect(
                &config,
                if name == "OTHER.test" {
                    "other.test"
                } else {
                    name
                },
            );
            let mut bytes = Vec::new();
            while client.wants_write() {
                client.write_tls(&mut bytes).unwrap();
            }
            let Hello::Read(sent, _) = gate(&bytes, true) else {
                panic!("a whole hello");
            };
            match (table.choose(sent.as_deref()), expected) {
                (Choice::Serve(identity), Some(served)) => {
                    assert_eq!(identity.names().first().map(|name| &**name), Some(served));
                }
                (Choice::Unrecognized, None) => {
                    let mut rest = &fatal_alert(UNRECOGNIZED_NAME)[..];
                    client.read_tls(&mut rest).unwrap();
                    assert_eq!(
                        client.process_new_packets().unwrap_err(),
                        Error::AlertReceived(AlertDescription::UnrecognisedName)
                    );
                }
                (choice, _) => panic!("{name}: {choice:?}"),
            }
        }
    }

    #[test]
    fn with_no_default_certificate_configured_a_clienthello_without_server_name_is_refused_with_a_fatal_missing_extension_alert(
    ) {
        let mut anonymous = client_config(&[b"http/1.1"]);
        anonymous.enable_sni = false;
        let mut client = connect(&Arc::new(anonymous), "localhost");
        let mut bytes = Vec::new();
        while client.wants_write() {
            client.write_tls(&mut bytes).unwrap();
        }
        let Hello::Read(sent, _) = gate(&bytes, true) else {
            panic!("a whole hello");
        };
        assert_eq!(sent, None);
        assert!(matches!(identities().choose(None), Choice::Missing));
        let mut rest = &fatal_alert(MISSING_EXTENSION)[..];
        client.read_tls(&mut rest).unwrap();
        assert_eq!(
            client.process_new_packets().unwrap_err(),
            Error::AlertReceived(AlertDescription::MissingExtension)
        );
        let with_default = Identities::new(&[], Some(localhost()));
        assert!(matches!(with_default.choose(None), Choice::Serve(_)));
    }

    #[test]
    fn every_newsessionticket_carries_a_ticket_lifetime_of_at_most_604800_seconds() {
        let config = server();
        assert!(config.ticketer.enabled());
        assert!(config.ticketer.lifetime() <= MAX_TICKET_LIFETIME);
        let mut older = client_with(provider(), &[&TLS12], &[b"http/1.1"]);
        older.resumption = Resumption::in_memory_sessions(256);
        let older = Arc::new(older);
        let mut client = connect(&older, "localhost");
        let mut server = ServerConnection::new(config).unwrap();
        let mut flights = Vec::new();
        for _ in 0..4 {
            to_server(&mut client, &mut server).unwrap();
            let (flight, delivered) = to_client(&mut server, &mut client);
            delivered.unwrap();
            flights.extend(flight);
        }
        let mut at = 0;
        let mut lifetimes = Vec::new();
        while let Some(header) = flights.get(at..at + 5) {
            let len = usize::from(u16::from_be_bytes([header[3], header[4]]));
            let body = flights.get(at + 5..at + 5 + len).unwrap_or(&[]);
            if header[0] == 0x16 && body.first() == Some(&0x04) {
                lifetimes.push(u32::from_be_bytes([body[4], body[5], body[6], body[7]]));
            }
            at += 5 + len;
        }
        assert!(!lifetimes.is_empty(), "a TLS 1.2 NewSessionTicket");
        assert!(
            lifetimes
                .iter()
                .all(|&lifetime| lifetime <= MAX_TICKET_LIFETIME),
            "{lifetimes:?}"
        );
    }

    #[test]
    fn ticket_encryption_keys_rotate_at_least_once_a_week_and_a_ticket_sealed_under_a_retired_key_falls_back_to_a_full_handshake(
    ) {
        let first = server();
        let lifetime = first.ticketer.lifetime();
        assert_eq!(lifetime, 43_200, "12 hours: keys rotate every 6 hours");
        assert!(lifetime / 2 <= MAX_TICKET_LIFETIME);
        let sealed = first.ticketer.encrypt(b"session state").unwrap();
        assert_eq!(
            first.ticketer.decrypt(&sealed).as_deref(),
            Some(&b"session state"[..])
        );
        let replaced = server();
        assert!(
            replaced.ticketer.decrypt(&sealed).is_none(),
            "keys are drawn fresh, never shared"
        );

        let mut resuming = client_config(&[b"http/1.1"]);
        resuming.resumption = Resumption::in_memory_sessions(256);
        let resuming = Arc::new(resuming);
        let (mut primed, mut issuer) = session(&resuming, &first);
        let _ = to_client(&mut issuer, &mut primed);
        let (client, _) = session(&resuming, &replaced);
        assert_eq!(client.handshake_kind(), Some(HandshakeKind::Full));
    }
}
