//! Workers and thread ownership for zero-server.
//!
//! The per-worker request arena and slot ids, the per-slot ownership state word and
//! borrow protocol, tier dispatch, the batch dispatcher with bounded batches in flight
//! and the QueueFull back-pressure rule, the per-worker tier 1 cache shard, Date block
//! refresh, cancellation, panic containment, and shutdown.

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
