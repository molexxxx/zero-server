//! Cached CPU feature detection and the SIMD and SWAR kernels of zero-server.
//!
//! The kernels are the request-target scan, the header-name and header-value scans,
//! CRLF search, the WebSocket XOR unmask, and a streaming UTF-8 validator that resumes
//! across WebSocket fragments. The SWAR path is the reference and every SIMD kernel
//! (AVX2, SSE4.2, SSE2, NEON) is property-tested against it. This is the one no_std
//! crate allowed `unsafe`: the dispatch call site and every pointer-taking load and
//! store inside the kernels carry a `// SAFETY:` comment stating the bounds check that
//! precedes them.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
