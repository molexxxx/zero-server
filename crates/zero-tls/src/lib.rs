//! TLS for zero-server over the runtime seam.
//!
//! The rustls `ServerConfig` builder with the project defaults, the SNI resolver with
//! atomic reload, ticket rotation, the session cache, the two TLS drivers over the
//! seam, the handshake timeout and the per-core in-progress handshake limit, and the
//! OCSP stapler, mTLS with CRL support and opt-in kTLS through `zero-sys`.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
