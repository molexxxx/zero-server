//! The cryptographic primitives of zero-server.
//!
//! SHA-1, SHA-256, HMAC, PBKDF2, random bytes, Ed25519 and the JWT signature
//! primitives, constant-time comparison, zeroizing secret types, and the std
//! implementations of the `zero-core` `Digest`, `Mac`, `Kdf` and `Rng` traits over one
//! crypto provider per build.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
