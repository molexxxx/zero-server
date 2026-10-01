//! Static file serving for zero-server.
//!
//! Files and directories with a path policy on every segment, resolution that keeps a
//! symlink inside the root, ETag and Last-Modified validators, 304, byte ranges,
//! Cache-Control per route, precomputed header blocks per asset, a bounded per-core
//! small-file cache, and the platform file-send path when the backend offers one.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
