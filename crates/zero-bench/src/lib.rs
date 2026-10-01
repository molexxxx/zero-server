//! The two TechEmpower entries of zero-server and the measurement harnesses.
//! Never published.
//!
//! [`entries`] holds the Realistic entry (`zero-server`: through the router, the
//! `zero-limits` defaults, `Server` and `Date` on every response) and the Platform
//! entry (`zero-server-plt`: the raw HTTP/1.1 handler with no router), both over
//! the `zero-http` driver, for the json and plaintext tests of the Round 23 rules:
//! an object instantiated and serialized per request, `application/json`,
//! `Content-Length`, no gzip, no disk logging, the response composed on the spot.
//! [`load`] is the pipelined load generator, [`idle`] the bytes-per-idle-connection
//! probe of `DESIGN.md` section 5.7 and [`miss`] the route-miss timing of section
//! 7.1; the counting-allocator gate lives in `zero-http`'s `tests/no_alloc.rs`.

pub mod args;
pub mod entries;
pub mod idle;
pub mod load;
pub mod miss;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
