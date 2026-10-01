//! The declarative rule engine behind tier 0 of zero-server.
//!
//! CORS, security headers, request ids, trust proxy, body limits, bearer extraction,
//! rate limiting with RFC 6585 and draft ratelimit headers, and timeouts. Rules are
//! data evaluated in Rust, never code crossing the language boundary.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
