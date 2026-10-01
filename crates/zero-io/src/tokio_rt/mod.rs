//! The `io-tokio` backend: one tokio current-thread runtime per core.
//!
//! [`serve`] starts one worker thread per CPU, each with its own current-thread runtime
//! and `LocalSet` (two FIFO queues, no work stealing, no `Send` bound), pins it to its
//! CPU where the platform allows, and runs the caller's per-core future on it with a
//! [`Core`] (the pool, the date block, the clock and the shutdown signal) and an
//! [`Acceptor`]. On Linux every core owns an `SO_REUSEPORT` listener and the kernel
//! distributes connections; on Windows and macOS core 0 owns the one listener and hands
//! each accepted socket round-robin to a core over an explicit wake, the only cross-core
//! traffic there is (`DESIGN.md` sections 5.1 and 5.4).
//!
//! The readiness model performs each operation when the socket is ready: a read leases
//! its buffer only after `readable` returns, so an idle connection holds none.

mod listen;
mod shutdown;
mod tcp;
mod time;
mod worker;

pub use listen::{Acceptor, ListenConfig};
pub use shutdown::ShutdownHandle;
pub use tcp::TcpStream;
pub use time::{sleep, timeout};
pub use worker::{serve, Config, Core, Workers};
