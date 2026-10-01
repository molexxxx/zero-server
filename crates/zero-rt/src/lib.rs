//! Workers and thread ownership for zero-server.
//!
//! [`arena`] is the per-worker request arena: chunked, with stable addresses, never
//! reallocated, addressed by the 53-bit slot ids of `zero-core`. [`slot`] is the
//! per-slot ownership state word of `DESIGN.md` section 7.3, one atomic per slot that
//! says who may touch it (`Free`, `Parsing`, `WorkerOwned`, `Leased`, `Completing`,
//! `Closed`) and counts the host readers inside a lease, so a stale id reads nothing and
//! a slot with a reader is never recycled. [`tier`] names the five handler tiers of
//! section 7.2. [`cancel`] is the per-request cancel flag, [`contain`] the panic
//! containment of section 10.2 (a panicking task answers for itself and the core stays
//! up), and [`worker`] the per-core workers over the `zero-io` seam with the panic
//! counter and the status callback. The batch dispatcher, the epoch-based index reuse
//! and the tier 1 cache shard follow in their own steps.
//!
//! The crate holds no `unsafe` code: the arena hands out `&mut` through the worker's
//! exclusive borrow, and the state word is an atomic, which needs none.

pub mod arena;
pub mod cancel;
pub mod contain;
pub mod slot;
pub mod tier;
pub mod worker;

pub use arena::Arena;
pub use cancel::Cancel;
pub use contain::{contain, Panicked};
pub use slot::{Borrow, Refused, SlotState, SlotWord};
pub use tier::Tier;
pub use worker::{start, Config, Event, StatusSink, Worker, Workers};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
