//! The `io-compio` backend: one compio-driver proactor per core under an executor of
//! this crate's own.
//!
//! [`serve`] starts one worker thread per CPU, each with its own proactor (io_uring
//! on Linux with the epoll fallback compio's fusion driver takes when `io_uring_setup`
//! is refused, IOCP on Windows, kqueue through polling on macOS), a run queue of
//! `!Send` tasks, and a timer list whose next deadline bounds the wait on the driver.
//! It pins the thread to its CPU where the platform allows and runs the caller's
//! per-core future on it with a [`Core`] (the pool, the date block, the clock and
//! the shutdown signal) and an [`Acceptor`]. The listener strategy is shared with the
//! `io-tokio` backend: a listener per core on Linux, core 0's listener handing sockets
//! to every core elsewhere.
//!
//! Every operation hands the kernel an owned buffer and gets it back with the
//! completion, which is the contract the seam was written for: a read takes the
//! block's storage out of its [`OwnedBuf`](zero_core::OwnedBuf) by value and puts
//! it back with the count, so nothing is copied on the way in or out. A connection
//! waits for readability before it leases a block, so an idle connection holds no
//! buffer on this backend either. The one copy the seam costs a completion backend is
//! the vectored write: [`Stream::writev`](crate::seam::Stream::writev) takes borrowed
//! slices, and the kernel needs a buffer it owns for the length of the send, so the
//! slices are staged into one owned buffer.

mod executor;
mod listen;
mod ops;
mod shutdown;
mod tcp;
mod time;
mod udp;
mod worker;

/// The name of this backend, for a report.
pub const BACKEND: &str = "io-compio";

pub use executor::{block_on, driver};
pub use listen::Acceptor;
pub use shutdown::ShutdownHandle;
pub use tcp::TcpStream;
pub use time::{sleep, timeout};
pub use udp::UdpSocket;
pub use worker::{serve, Config, Core, Workers};

pub use crate::net::{DatagramConfig, ListenConfig};
