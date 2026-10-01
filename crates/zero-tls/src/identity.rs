//! Server identities: certificate chains with their private keys, and the table that
//! picks one by the server name a client asks for.
//!
//! An [`Identity`] is a chain and its key, checked to match, and the hosts it serves,
//! each a DNS name or an IP address the end-entity certificate is checked to be valid
//! for. [`Identities`] maps names and addresses to identities, with an optional
//! default. It is swapped whole by [`Identities::replace`], so a reload never shows a
//! handshake half of the old table and half of the new; the listener pins the
//! identity it chose for a handshake, so handshakes in progress keep it.
//!
//! A client names its server by DNS name only, since RFC 6066 Section 3 permits no IP
//! literal in `server_name`; a client that connects by address sends none. A hello
//! with a name the table does not hold is refused with a fatal `unrecognized_name`
//! alert, as RFC 9325 Section 3.7 asks, rather than answered with the default
//! identity. A hello without one gets the identity that lists the address the client
//! connected to, then the default identity, or a fatal `missing_extension` alert when
//! there is neither (RFC 9846 Section 9.2). The connection then serves only the hosts
//! of the identity that secured it (RFC 9110 Section 7.4).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6066.html#section-3>
//! @see <https://www.rfc-editor.org/rfc/rfc9325.html#section-3.7>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-9.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-7.4>

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, PoisonError, RwLock};

use rustls::client::verify_server_name;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::server::{ClientHello, ParsedCertificate, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use zero_core::{Error, Result};
use zero_server_crypto::SecretBytes;

use crate::provider;

/// A certificate chain, its private key and the hosts it serves.
#[derive(Clone, Debug)]
pub struct Identity {
    key: Arc<CertifiedKey>,
    names: Arc<[Box<str>]>,
    addresses: Arc<[IpAddr]>,
}

impl Identity {
    /// An identity from PEM text.
    ///
    /// # Arguments
    ///
    /// * `chain` - the end-entity certificate first, then its intermediates.
    /// * `key` - the private key: PKCS#8, PKCS#1 or SEC1.
    /// * `names` - the hosts it serves: DNS names, and IP addresses for clients that
    ///   connect by address, each checked to be one the end-entity certificate is
    ///   valid for.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] for PEM without a certificate or a key, a key that does not
    /// match the certificate, or a name the certificate does not cover.
    pub fn from_pem(chain: &[u8], key: &[u8], names: &[&str]) -> Result<Self> {
        let chain = CertificateDer::pem_slice_iter(chain)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|err| invalid(format!("the certificate PEM: {err}")))?;
        if chain.is_empty() {
            return Err(invalid(
                "the certificate PEM holds no certificate".to_owned(),
            ));
        }
        let key = PrivateKeyDer::from_pem_slice(key)
            .map_err(|err| invalid(format!("the private key PEM: {err}")))?;
        let certified = CertifiedKey::from_der(chain, key, &provider())
            .map_err(|err| invalid(format!("the certificate and key: {err}")))?;
        let end_entity = certified
            .end_entity_cert()
            .map_err(|err| invalid(format!("the certificate: {err}")))?;
        let parsed = ParsedCertificate::try_from(end_entity)
            .map_err(|err| invalid(format!("the certificate: {err}")))?;
        let mut checked = Vec::with_capacity(names.len());
        let mut addresses = Vec::new();
        for name in names {
            let lower = name.to_ascii_lowercase();
            let bare = lower.trim_end_matches('.');
            let literal = bare.trim_start_matches('[').trim_end_matches(']');
            let (server, stored) = match literal.parse::<IpAddr>() {
                Ok(address) => {
                    let address = address.to_canonical();
                    addresses.push(address);
                    (ServerName::from(address), host_of(address))
                }
                Err(_) => {
                    let server = ServerName::try_from(bare.to_owned())
                        .map_err(|err| invalid(format!("the name {name:?}: {err}")))?;
                    (server, bare.to_owned())
                }
            };
            verify_server_name(&parsed, &server)
                .map_err(|err| invalid(format!("the name {name:?}: {err}")))?;
            checked.push(stored.into_boxed_str());
        }
        Ok(Identity {
            key: Arc::new(certified),
            names: Arc::from(checked),
            addresses: Arc::from(addresses),
        })
    }

    /// An identity from PEM files. The key file is read into memory that is zeroized
    /// once the key is loaded.
    ///
    /// # Arguments
    ///
    /// * `chain` - the certificate chain file.
    /// * `key` - the private key file.
    /// * `names` - the hosts it serves.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when a file cannot be read; otherwise as [`Identity::from_pem`].
    pub fn from_pem_files(
        chain: impl AsRef<Path>,
        key: impl AsRef<Path>,
        names: &[&str],
    ) -> Result<Self> {
        let chain = std::fs::read(chain).map_err(|err| Error::Io(err.to_string()))?;
        let key =
            SecretBytes::from_vec(std::fs::read(key).map_err(|err| Error::Io(err.to_string()))?);
        Identity::from_pem(&chain, key.expose(), names)
    }

    /// The hosts it serves, as [`zero_http::Prepared::authorities`] holds them:
    /// lowercase, without a trailing dot, an IPv4 address dotted and an IPv6 address
    /// in brackets in its canonical text.
    #[must_use]
    pub fn names(&self) -> &Arc<[Box<str>]> {
        &self.names
    }

    pub(crate) fn certified(&self) -> &Arc<CertifiedKey> {
        &self.key
    }
}

/// An address as the host names hold it.
fn host_of(address: IpAddr) -> String {
    match address {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => format!("[{address}]"),
    }
}

/// One generation of the table.
#[derive(Debug, Default)]
struct Table {
    by_name: HashMap<Box<str>, Identity>,
    by_address: HashMap<IpAddr, Identity>,
    default: Option<Identity>,
}

/// The identities a listener serves, picked by the client's server name.
#[derive(Debug, Default)]
pub struct Identities {
    current: RwLock<Arc<Table>>,
}

/// What the table decided for one hello.
#[derive(Clone, Debug)]
pub(crate) enum Choice {
    /// Serve this identity.
    Serve(Identity),
    /// The client named a server the table does not hold.
    Unrecognized,
    /// The client named no server, and neither its address nor a default picks one.
    Missing,
}

impl Identities {
    /// A table holding `identities`, each under every host it serves, and the
    /// identity for clients that send no server name.
    ///
    /// # Arguments
    ///
    /// * `identities` - the identities; a host served by two of them goes to the
    ///   later one.
    /// * `default` - the identity for a client without `server_name` whose address
    ///   no identity lists, if any; its own hosts are served by it unless a listed
    ///   identity serves them.
    #[must_use]
    pub fn new(identities: &[Identity], default: Option<Identity>) -> Self {
        Identities {
            current: RwLock::new(Arc::new(Table::of(identities, default))),
        }
    }

    /// Replace the whole table at once; handshakes in progress keep the identity
    /// they started with.
    ///
    /// # Arguments
    ///
    /// * `identities` - the new identities.
    /// * `default` - the new default identity.
    pub fn replace(&self, identities: &[Identity], default: Option<Identity>) {
        let table = Arc::new(Table::of(identities, default));
        *self.current.write().unwrap_or_else(PoisonError::into_inner) = table;
    }

    /// Decide for one hello.
    ///
    /// # Arguments
    ///
    /// * `server_name` - the DNS name the hello carries, if any.
    /// * `local` - the address the client connected to, if known.
    pub(crate) fn choose(&self, server_name: Option<&str>, local: Option<IpAddr>) -> Choice {
        let table = Arc::clone(&self.current.read().unwrap_or_else(PoisonError::into_inner));
        match server_name {
            Some(name) => table
                .by_name
                .get(name.to_ascii_lowercase().trim_end_matches('.'))
                .cloned()
                .map_or(Choice::Unrecognized, Choice::Serve),
            None => local
                .and_then(|address| table.by_address.get(&address.to_canonical()))
                .or(table.default.as_ref())
                .cloned()
                .map_or(Choice::Missing, Choice::Serve),
        }
    }
}

impl Table {
    fn of(identities: &[Identity], default: Option<Identity>) -> Self {
        let mut by_name = HashMap::new();
        let mut by_address = HashMap::new();
        for identity in identities {
            for name in identity.names.iter() {
                by_name.insert(name.clone(), identity.clone());
            }
            for address in identity.addresses.iter() {
                by_address.insert(*address, identity.clone());
            }
        }
        if let Some(default) = &default {
            for name in default.names.iter() {
                by_name
                    .entry(name.clone())
                    .or_insert_with(|| default.clone());
            }
            for address in default.addresses.iter() {
                by_address
                    .entry(*address)
                    .or_insert_with(|| default.clone());
            }
        }
        Table {
            by_name,
            by_address,
            default,
        }
    }
}

impl ResolvesServerCert for Identities {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        match self.choose(client_hello.server_name(), None) {
            Choice::Serve(identity) => Some(Arc::clone(identity.certified())),
            Choice::Unrecognized | Choice::Missing => None,
        }
    }
}

/// The certificate of the identity the listener chose for one handshake, whatever
/// the table holds by the time rustls asks, such as after a reload during a
/// `HelloRetryRequest`: the certificate and the hosts the connection serves come from
/// the same choice.
#[derive(Debug)]
pub(crate) struct Pinned(pub(crate) Arc<CertifiedKey>);

impl ResolvesServerCert for Pinned {
    fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(Arc::clone(&self.0))
    }
}

fn invalid(message: String) -> Error {
    Error::Protocol(message)
}
