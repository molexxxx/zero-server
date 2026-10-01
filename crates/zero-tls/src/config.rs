//! The rustls `ServerConfig` the listener runs with, and the options that shape it.
//!
//! The defaults:
//!
//! - TLS 1.3 and TLS 1.2 only, TLS 1.3 preferred whenever the client offers it; TLS
//!   1.0 and 1.1 are never negotiated (RFC 8996, RFC 9325 Section 3.1.1, RFC 9852).
//! - The aws-lc-rs provider's suites: AEAD only, with forward secrecy, and on TLS 1.2
//!   only ECDHE suites, so static RSA and finite-field Diffie-Hellman are never
//!   selected (RFC 10015 Sections 3 and 4). The server's order decides, AES-256-GCM
//!   first.
//! - On TLS 1.2 the extended main secret is required: a client that does not offer it
//!   is refused with `handshake_failure`. RFC 9325 Section 3.5 requires TLS 1.2
//!   implementations to support it against the triple handshake attack, and RFC 7627
//!   Section 5.2 lets a server that "does not wish to interoperate with legacy
//!   clients" abort; rustls defaults it on only under a FIPS provider. An operator
//!   with a named legacy client population can turn it off, the one TLS 1.2
//!   downgrade the options allow.
//! - ALPN offers `http/1.1` only; a client that offers ALPN without it is refused with
//!   a fatal `no_application_protocol` alert (RFC 7301 Section 3.2), and a client that
//!   offers none is served HTTP/1.1 with no ALPN in the reply (RFC 9846 Section 4.3).
//! - Early data is never accepted (`max_early_data_size` 0, `send_half_rtt_data`
//!   off): TLS gives 0-RTT data no replay protection across connections (RFC 9846
//!   Section 8), and an application protocol must not use it without a profile
//!   (Appendix F.5), which HTTP/1.1 here does not implement.
//! - Stateless session tickets from the aws-lc-rs ticketer, whose keys rotate every
//!   6 hours and whose tickets live 12 hours, inside the 7-day limit (RFC 9846
//!   Section 4.7.1) and the weekly rotation RFC 9325 Section 3.4 asks for; a session
//!   cache of 256 for TLS 1.2 session ids.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9325.html>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html>
//! @see <https://docs.rs/rustls/0.23.45/rustls/server/struct.ServerConfig.html>

use std::sync::Arc;

use rustls::crypto::aws_lc_rs::Ticketer;
use rustls::server::{NoServerSessionStorage, ServerSessionMemoryCache};
use rustls::version::{TLS12, TLS13};
use rustls::ServerConfig;
use zero_core::{Error, Result};
use zero_limits::TlsLimits;

use crate::identity::Identities;
use crate::provider;

/// The longest ticket lifetime a server may send: 7 days (RFC 9846 Section 4.7.1).
pub const MAX_TICKET_LIFETIME: u32 = 604_800;

/// Which TLS driver serves the connections.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Driver {
    /// rustls's buffered `ServerConnection`.
    Buffered,
    /// rustls's unbuffered state machine, which encrypts and decrypts in the
    /// driver's own buffers.
    Unbuffered,
}

impl Driver {
    /// The driver for the runtime backend in the build: unbuffered on the
    /// completion backend, buffered on the readiness backend.
    #[must_use]
    pub fn for_backend() -> Self {
        if zero_io::rt::BACKEND == "io-compio" {
            Driver::Unbuffered
        } else {
            Driver::Buffered
        }
    }
}

/// How a TLS listener is set up.
#[derive(Clone, Debug)]
pub struct TlsOptions {
    /// The application protocols offered by ALPN, most preferred first.
    pub alpn: Vec<Vec<u8>>,
    /// Whether TLS 1.2 is offered beside TLS 1.3.
    pub tls12: bool,
    /// Whether a TLS 1.2 client must offer the extended main secret.
    pub require_ems: bool,
    /// Whether stateless session tickets are issued.
    pub tickets: bool,
    /// How many TLS 1.2 sessions the in-memory cache keeps; 0 keeps none.
    pub session_cache: usize,
    /// The handshake timeout and the per-core limit on handshakes in progress.
    pub limits: TlsLimits,
    /// The driver.
    pub driver: Driver,
}

impl Default for TlsOptions {
    fn default() -> Self {
        TlsOptions {
            alpn: vec![b"http/1.1".to_vec()],
            tls12: true,
            require_ems: true,
            tickets: true,
            session_cache: 256,
            limits: TlsLimits::DEFAULT,
            driver: Driver::for_backend(),
        }
    }
}

/// Build the `ServerConfig` for a listener.
///
/// # Arguments
///
/// * `identities` - the identities, which the config resolves certificates from.
/// * `options` - the options.
///
/// # Returns
///
/// The config, shared by every connection.
///
/// # Errors
///
/// [`Error::Protocol`] when the provider cannot serve the chosen versions, and
/// [`Error::Io`] when the ticketer cannot draw its keys.
pub fn server_config(
    identities: Arc<Identities>,
    options: &TlsOptions,
) -> Result<Arc<ServerConfig>> {
    let versions: &[&'static rustls::SupportedProtocolVersion] = if options.tls12 {
        &[&TLS13, &TLS12]
    } else {
        &[&TLS13]
    };
    let mut config = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(versions)
        .map_err(|err| Error::Protocol(format!("the TLS versions: {err}")))?
        .with_no_client_auth()
        .with_cert_resolver(identities);
    config.alpn_protocols.clone_from(&options.alpn);
    config.ignore_client_order = true;
    config.max_early_data_size = 0;
    config.send_half_rtt_data = false;
    config.require_ems = options.tls12 && options.require_ems;
    config.session_storage = if options.session_cache == 0 {
        Arc::new(NoServerSessionStorage {})
    } else {
        ServerSessionMemoryCache::new(options.session_cache)
    };
    if options.tickets {
        let ticketer = Ticketer::new().map_err(|err| Error::Io(format!("the ticketer: {err}")))?;
        if ticketer.lifetime() > MAX_TICKET_LIFETIME {
            return Err(Error::Protocol(format!(
                "a ticket lifetime of {} s is over the {MAX_TICKET_LIFETIME} s limit",
                ticketer.lifetime()
            )));
        }
        config.ticketer = ticketer;
    }
    Ok(Arc::new(config))
}
