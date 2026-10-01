//! The audited leaf crate that owns every raw operating-system call the zero-server
//! workspace makes.
//!
//! Safe, bounds-checked wrappers over socket options, `sendmsg` and `recvmsg` with
//! control-message construction and parsing, thread affinity, and the descriptor paths
//! the plugin loader needs. Every other crate stays at `unsafe_code = "forbid"` because
//! the raw calls live here. The [`alloc`] module holds the counting wrapper over the
//! system allocator that the allocation-free claims of the workspace are tested with.

pub mod alloc;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
