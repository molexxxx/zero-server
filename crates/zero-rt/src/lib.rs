//! Workers, slot ownership and host dispatch for zero-server.
//!
//! [`worker`] runs one worker per core over the `zero-io` seam, with panic
//! containment ([`contain`](mod@contain)), the status callback and a flag that marks
//! the worker threads. [`tier`] names the five handler tiers, ordered so that
//! everything expressible as data runs in Rust without crossing into a host
//! language, and [`cancel`] is the per-request cancel flag.
//!
//! The rest is the path of a tier 3 request to a host thread and back:
//!
//! - [`slot`] is the per-slot state word: one atomic that says who may touch the slot
//!   (`Free`, `Parsing`, `WorkerOwned`, `Leased`, `Completing`, `Closed`), counts the
//!   pins host threads hold, and carries the generation a slot id must match. Every
//!   transition is one generation-checked compare-and-swap, so a stale id moves
//!   nothing and a pinned slot is never retired.
//! - [`arena`] is the per-worker arena of slots, a fixed spine of chunks that never
//!   move, each slot holding its word, its payload behind a lock and a published view
//!   hosts read without the lock. Hosts check the word before and inside the lock; the
//!   worker only ever tries the lock, so it never waits on a host.
//! - [`alloc`] hands out and takes back slot indexes: retired indexes wait in a
//!   quarantine until the host acknowledged every batch posted before their
//!   retirement, then return to a warm list that keeps their buffers, or, past
//!   `SLOTS_KEPT`, a cold list that gives them back.
//! - [`intake`] is where host threads hand completed ids and acknowledgments back,
//!   with one lock and one cross-thread wake per call, and holds the published and
//!   acknowledged epochs that gate index reuse.
//! - [`ring`] holds each batch in flight until it is acknowledged, and
//!   [`dispatch`] assembles the ready jobs and realtime events into batches, posts
//!   them to the worker index's [`Target`], keeps the late list of slots waiting for a
//!   pin or a lock, admits or refuses new requests, and runs as one task per worker
//!   that returns once a drain leaves nothing to do.
//! - [`sync`] supplies the atomics and locks of all of the above: `std`'s, or loom's
//!   when the crate is built with `--cfg zero_loom`, so the loom models check the
//!   protocol's own code.
//!
//! The tier 1 cache shard does not exist yet. The crate holds no `unsafe` code: the
//! arena is shareable because its parts are, and no `&mut` to a slot is ever formed.

pub mod alloc;
pub mod arena;
pub mod cancel;
pub mod contain;
pub mod dispatch;
pub mod intake;
pub mod ring;
pub mod slot;
pub mod sync;
pub mod tier;
pub mod worker;

#[cfg(all(test, zero_loom))]
mod loom_tests;

pub use alloc::{Allocator, Exhausted};
pub use arena::{Arena, Payload, Reset, Slot};
pub use cancel::Cancel;
pub use contain::{contain, Panicked};
pub use dispatch::{
    run, Admission, Counters, DispatchLimits, Dispatcher, Failure, Job, Kick, Late, Parts, Post,
    Sealed, Target, Turned, Waiters,
};
pub use intake::Intake;
pub use ring::{BatchRef, BatchRing, EventRec};
pub use slot::{Borrow, Refused, SlotState, SlotWord};
pub use tier::Tier;
pub use worker::{is_worker_thread, start, Config, Event, StatusSink, Worker, Workers};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
