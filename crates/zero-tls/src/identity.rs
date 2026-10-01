//! Server identities: certificate chains with their private keys, and the table that
//! picks one by the server name a client asks for.
//!
//! An [`Identity`] is a chain and its key, checked to match, and the host names it
//! serves, each checked to be a DNS name the end-entity certificate is valid for.
//! [`Identities`] maps names to identities, with an optional default for clients that
//! send no `server_name`. It is swapped whole by [`Identities::replace`], so a reload
//! never shows a handshake half of the old table and half of the new; handshakes in
//! progress keep the identity they started with.
//!
//! A name the table does not hold is refused with a fatal `unrecognized_name` alert,
//! as RFC 9325 Section 3.7 asks, rather than answered with the default identity; a
//! client with no `server_name` gets the default identity, or a fatal
//! `missing_extension` alert when there is none (RFC 9846 Section 9.2). The connection
//! then serves only the names of the identity that secured it (RFC 9110 Section 7.4).
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9325.html#section-3.7>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-9.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-7.4>

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, PoisonError, RwLock};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert, ResolvesServerCertUsingSni};
use rustls::sign::CertifiedKey;
use zero_core::{Error, Result};
use zero_server_crypto::SecretBytes;

use crate::provider;

/// A certificate chain, its private key and the host names it serves.
#[derive(Clone, Debug)]
pub struct Identity {
    key: Arc<CertifiedKey>,
    names: Arc<[Box<str>]>,
}

impl Identity {
    /// An identity from PEM text.
    ///
    /// # Arguments
    ///
    /// * `chain` - the end-entity certificate first, then its intermediates.
    /// * `key` - the private key: PKCS#8, PKCS#1 or SEC1.
    /// * `names` - the hosts it serves: DNS names, each checked to be one the
    ///   end-entity certificate is valid for, or IP addresses for clients that connect
    ///   by address, which are taken as given since only DNS names are checked
    ///   against the certificate here.
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
        let mut checked = Vec::with_capacity(names.len());
        for name in names {
            let lower = name.to_ascii_lowercase();
            let bare = lower.trim_end_matches('.');
            let literal = bare.trim_start_matches('[').trim_end_matches(']');
            let stored = match literal.parse::<IpAddr>() {
                Ok(IpAddr::V4(address)) => address.to_string(),
                Ok(IpAddr::V6(address)) => format!("[{address}]"),
                Err(_) => {
                    let mut probe = ResolvesServerCertUsingSni::new();
                    probe
                        .add(bare, certified.clone())
                        .map_err(|err| invalid(format!("the name {name:?}: {err}")))?;
                    bare.to_owned()
                }
            };
            checked.push(stored.into_boxed_str());
        }
        Ok(Identity {
            key: Arc::new(certified),
            names: Arc::from(checked),
        })
    }

    /// An identity from PEM files. The key file is read into memory that is zeroized
    /// once the key is loaded.
    ///
    /// # Arguments
    ///
    /// * `chain` - the certificate chain file.
    /// * `key` - the private key file.
    /// * `names` - the host names it serves.
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

    /// The host names it serves, lowercase, without a trailing dot.
    #[must_use]
    pub fn names(&self) -> &Arc<[Box<str>]> {
        &self.names
    }

    pub(crate) fn certified(&self) -> &Arc<CertifiedKey> {
        &self.key
    }
}

/// One generation of the table.
#[derive(Debug, Default)]
struct Table {
    by_name: HashMap<Box<str>, Identity>,
    default: Option<Identity>,
}

/// The identities a listener serves, picked by the client's server name.
#[derive(Debug, Default)]
pub struct Identities {
    current: RwLock<Arc<Table>>,
}

/// What the table decided for one `server_name`.
#[derive(Clone, Debug)]
pub(crate) enum Choice {
    /// Serve this identity.
    Serve(Identity),
    /// The client named a server the table does not hold.
    Unrecognized,
    /// The client named no server and there is no default identity.
    Missing,
}

impl Identities {
    /// A table holding `identities`, each under every name it serves, and the
    /// identity for clients that send no server name.
    ///
    /// # Arguments
    ///
    /// * `identities` - the identities; a name served by two of them goes to the
    ///   later one.
    /// * `default` - the identity for a client without `server_name`, if any.
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

    /// Decide for one `server_name`.
    pub(crate) fn choose(&self, server_name: Option<&str>) -> Choice {
        let table = Arc::clone(&self.current.read().unwrap_or_else(PoisonError::into_inner));
        match server_name {
            Some(name) => table
                .by_name
                .get(name.to_ascii_lowercase().trim_end_matches('.'))
                .cloned()
                .map_or(Choice::Unrecognized, Choice::Serve),
            None => table.default.clone().map_or(Choice::Missing, Choice::Serve),
        }
    }
}

impl Table {
    fn of(identities: &[Identity], default: Option<Identity>) -> Self {
        let mut by_name = HashMap::new();
        for identity in identities {
            for name in identity.names.iter() {
                by_name.insert(name.clone(), identity.clone());
            }
        }
        Table { by_name, default }
    }
}

impl ResolvesServerCert for Identities {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        match self.choose(client_hello.server_name()) {
            Choice::Serve(identity) => Some(Arc::clone(identity.certified())),
            Choice::Unrecognized | Choice::Missing => None,
        }
    }
}

fn invalid(message: String) -> Error {
    Error::Protocol(message)
}
