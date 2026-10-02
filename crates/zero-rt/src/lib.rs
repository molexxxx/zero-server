//! Workers and thread ownership for zero-server.
//!
//! [`arena`] is the per-worker request arena: chunked, with stable addresses, never
//! reallocated, addressed by the 53-bit slot ids of `zero-core`. [`slot`] is the
//! per-slot ownership state word, one atomic per slot that says who may touch it
//! (`Free`, `Parsing`, `WorkerOwned`, `Leased`, `Completing`, `Closed`) and counts the
//! host readers inside a lease, so a stale id reads nothing and a slot with a reader is
//! never recycled. [`tier`] names the five handler tiers, ordered so that everything
//! expressible as data runs in Rust without crossing into a host language. [`cancel`]
//! is the per-request cancel flag, [`contain`](mod@contain) the panic containment (a
//! panicking task answers for itself and the core stays up), and [`worker`] the
//! per-core workers over the `zero-io` seam with the panic counter and the status
//! callback. The crate does not yet provide the batch dispatcher, epoch-based index
//! reuse or the tier 1 cache shard.
//!
//! The crate holds no `unsafe` code: the arena hands out `&mut` through the worker's
//! exclusive borrow, and the state word is an atomic, which needs none.

pub mod arena;
pub mod cancel;
pub mod contain;
pub mod slot;
pub mod tier;
pub mod worker;

pub use arena::{Arena, Reset};
pub use cancel::Cancel;
pub use contain::{contain, Panicked};
pub use slot::{Borrow, Refused, SlotState, SlotWord};
pub use tier::Tier;
pub use worker::{start, Config, Event, StatusSink, Worker, Workers};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
