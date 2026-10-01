//! The runtime seam of zero-server, and the only crate that names a third-party
//! runtime.
//!
//! Per-core runtimes, `Listener` and `Stream` traits over owned buffers, the datagram
//! batch trait, timers, `DateService`, wake primitives, the per-operating-system
//! listener strategy, and shutdown. The backends are `io-tokio` (default) and
//! `io-compio` (feature). Every raw socket option and control-message call goes
//! through `zero-sys`, so this crate stays at `unsafe_code = "forbid"`.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
