//! The operations this backend keeps across futures, named once.
//!
//! A dropped future cancels its operation and the driver keeps the operation,
//! buffer included, until the cancellation completes; the buffer is then dropped
//! with it. A block leased from the pool returns its lease at once (the pool
//! counts leases, not blocks), so a read cut short by a timeout costs the pool one
//! block's allocation later and never its budget.

use compio_driver::SharedFd;
use socket2::Socket;

/// A socket as the operations borrow it.
pub(crate) type Fd = SharedFd<Socket>;

/// A wait for readiness.
#[cfg(unix)]
pub(crate) type PollOp = compio_driver::op::PollOnce<Fd>;

/// A receive into no bytes, which IOCP completes when data is available.
#[cfg(windows)]
pub(crate) type ProbeOp = compio_driver::op::Recv<Vec<u8>, Fd>;
