//! The host boundary of zero-server.
//!
//! This crate is the layer between the HTTP/1.1 driver of `zero-http` and a host
//! language: the requests a route hands to a host, the batches that carry them to
//! the host's thread, and the calls the host answers them with. The C ABI of
//! `zero-ffi` and the language bindings are meant to be thin layers over it, so
//! every binding shares one implementation. The crate holds no `unsafe` code.
//!
//! The crate does not yet provide that layer: it exports only its version. The
//! capabilities a host can register (`static`, `policy`, `realtime`, `tls`) are
//! cargo features, all on by default.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
