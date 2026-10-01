//! The runtime seam of zero-server, and the only crate that names a third-party
//! runtime.
//!
//! The traits in [`seam`] are the contract every backend implements and every crate
//! above the seam programs against: [`seam::Runtime`] (spawn on this core),
//! [`seam::Listener`] and [`seam::Stream`] over owned buffers (a read takes an
//! [`OwnedBuf`](zero_core::OwnedBuf) and hands it back with the count, so no borrowed
//! slice crosses an await), [`seam::Datagram`] with per-datagram ECN, destination and
//! segment size, [`seam::Timer`], [`seam::DateService`] and [`seam::Shutdown`]. They are
//! fixed from the first commit, so a later backend is a drop-in (`DESIGN.md` section
//! 5.2).
//!
//! [`Pool`] is the per-core receive-buffer pool: a connection leases a block when it
//! becomes readable and returns it when it goes idle, so an idle connection holds no
//! receive buffer (section 5.6); the pool counts its leases, which is what the idle
//! memory claim is tested with. [`Date`] is the per-core `Date` header block.
//!
//! The `io-tokio` backend (on by default) is one tokio current-thread runtime per core
//! with no work stealing and no `Send` bound: [`tokio_rt::serve`] starts one worker
//! thread per CPU, pins it where the platform allows, gives it its own listener on
//! Linux (`SO_REUSEPORT`) or its share of one listener's accepts on Windows and macOS
//! (section 5.4), and runs the caller's per-core future on it. Every raw socket option
//! and affinity call goes through `zero-sys`, so this crate stays at
//! `unsafe_code = "forbid"`.

pub mod date;
pub mod pool;
pub mod seam;
#[cfg(feature = "io-tokio")]
pub mod tokio_rt;

pub use date::{Date, DATE_BLOCK_LEN};
pub use pool::Pool;
pub use seam::{DatagramMeta, Ecn, Leased};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
