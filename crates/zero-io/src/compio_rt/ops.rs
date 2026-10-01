//! The operations this backend submits, named once, and what becomes of one whose
//! future was dropped before it completed.
//!
//! A dropped future cancels its operation, but the kernel still owns the buffer
//! until the cancellation completes, so the key is kept and the completion is
//! reaped on a later wait: a block leased from the pool goes back to the pool, a
//! staging buffer back to its list, and anything else is dropped. Without that, a
//! read cut short by a timeout would leak its block from the pool's budget.

use std::rc::Rc;

use compio_buf::{IntoInner, Slice};
use compio_driver::op::{Recv, Send};
use compio_driver::{Key, OpCode, Proactor, PushEntry, SharedFd};
use socket2::Socket;
use zero_core::OwnedBuf;

use crate::pool::Pool;

/// A socket as the operations borrow it.
pub(crate) type Fd = SharedFd<Socket>;

/// A block's storage as an operation reads or writes it.
pub(crate) type Storage = Slice<Box<[u8]>>;

/// A receive into a block.
pub(crate) type RecvOp = Recv<Storage, Fd>;

/// A send out of a block.
pub(crate) type SendOp = Send<Storage, Fd>;

/// A send out of a staging buffer.
pub(crate) type StagedOp = Send<Vec<u8>, Fd>;

/// A wait for readiness.
#[cfg(unix)]
pub(crate) type PollOp = compio_driver::op::PollOnce<Fd>;

/// A receive into no bytes, which IOCP completes when data is available.
#[cfg(windows)]
pub(crate) type ProbeOp = Recv<Vec<u8>, Fd>;

/// An accept.
#[cfg(unix)]
pub(crate) type AcceptOp = compio_driver::op::Accept<Fd>;

/// An accept, with the socket the connection lands on.
#[cfg(windows)]
pub(crate) type AcceptOp = compio_driver::op::Accept<Fd, Fd>;

/// A datagram receive with its peer.
#[cfg(windows)]
pub(crate) type RecvFromOp = compio_driver::op::RecvFrom<Storage, Fd>;

/// A datagram send to a peer.
#[cfg(windows)]
pub(crate) type SendToOp = compio_driver::op::SendTo<Vec<u8>, Fd>;

/// An operation this backend can cancel and later reap.
pub(crate) trait Reap: OpCode + Sized + 'static {
    /// The record kept for the cancelled operation.
    ///
    /// # Arguments
    ///
    /// * `key` - the operation's key, kept until the completion arrives.
    /// * `pooled` - whether the buffer in it was leased from the pool.
    fn cancelled(key: Key<Self>, pooled: bool) -> Cancelled;
}

/// A cancelled operation whose completion is still to come.
pub(crate) enum Cancelled {
    /// A receive; the block goes back to the pool when `pooled`.
    Recv { key: Key<RecvOp>, pooled: bool },
    /// A send out of a block.
    Send(Key<SendOp>),
    /// A send out of a staging buffer, which goes back to the list.
    Staged(Key<StagedOp>),
    /// A readiness wait.
    #[cfg(unix)]
    Poll(Key<PollOp>),
    /// A readiness probe.
    #[cfg(windows)]
    Probe(Key<ProbeOp>),
    /// An accept.
    Accept(Key<AcceptOp>),
    /// A datagram receive.
    #[cfg(windows)]
    RecvFrom(Key<RecvFromOp>),
    /// A datagram send.
    #[cfg(windows)]
    SendTo(Key<SendToOp>),
}

impl Reap for RecvOp {
    fn cancelled(key: Key<Self>, pooled: bool) -> Cancelled {
        Cancelled::Recv { key, pooled }
    }
}

impl Reap for SendOp {
    fn cancelled(key: Key<Self>, _: bool) -> Cancelled {
        Cancelled::Send(key)
    }
}

impl Reap for StagedOp {
    fn cancelled(key: Key<Self>, _: bool) -> Cancelled {
        Cancelled::Staged(key)
    }
}

#[cfg(unix)]
impl Reap for PollOp {
    fn cancelled(key: Key<Self>, _: bool) -> Cancelled {
        Cancelled::Poll(key)
    }
}

#[cfg(windows)]
impl Reap for ProbeOp {
    fn cancelled(key: Key<Self>, _: bool) -> Cancelled {
        Cancelled::Probe(key)
    }
}

impl Reap for AcceptOp {
    fn cancelled(key: Key<Self>, _: bool) -> Cancelled {
        Cancelled::Accept(key)
    }
}

#[cfg(windows)]
impl Reap for RecvFromOp {
    fn cancelled(key: Key<Self>, _: bool) -> Cancelled {
        Cancelled::RecvFrom(key)
    }
}

#[cfg(windows)]
impl Reap for SendToOp {
    fn cancelled(key: Key<Self>, _: bool) -> Cancelled {
        Cancelled::SendTo(key)
    }
}

/// Where a reaped buffer goes.
pub(crate) struct Returns<'a> {
    /// The pool a leased block goes back to.
    pub(crate) pool: &'a Rc<Pool>,
    /// The staging buffers a staging buffer goes back to.
    pub(crate) staging: &'a mut Vec<Vec<u8>>,
    /// How many staging buffers are kept.
    pub(crate) staging_kept: usize,
}

/// Take a completed operation out of the driver, `None` when it is still pending.
fn take<T: OpCode>(proactor: &mut Proactor, key: Key<T>) -> Result<T, Key<T>> {
    match proactor.pop(key) {
        PushEntry::Ready(result) => Ok(result.1),
        PushEntry::Pending(key) => Err(key),
    }
}

impl Cancelled {
    /// Reap the completion if it arrived, returning the buffer where it belongs.
    ///
    /// # Returns
    ///
    /// The record again when the completion has not arrived yet.
    pub(crate) fn reap(self, proactor: &mut Proactor, returns: &mut Returns<'_>) -> Option<Self> {
        match self {
            Cancelled::Recv { key, pooled } => match take(proactor, key) {
                Ok(op) => {
                    let storage = op.into_inner().into_inner();
                    if pooled {
                        returns.pool.release(OwnedBuf::from_parts(storage, 0));
                    }
                    None
                }
                Err(key) => Some(Cancelled::Recv { key, pooled }),
            },
            Cancelled::Send(key) => take(proactor, key).err().map(Cancelled::Send),
            Cancelled::Staged(key) => match take(proactor, key) {
                Ok(op) => {
                    let mut buffer = op.into_inner();
                    buffer.clear();
                    if returns.staging.len() < returns.staging_kept {
                        returns.staging.push(buffer);
                    }
                    None
                }
                Err(key) => Some(Cancelled::Staged(key)),
            },
            #[cfg(unix)]
            Cancelled::Poll(key) => take(proactor, key).err().map(Cancelled::Poll),
            #[cfg(windows)]
            Cancelled::Probe(key) => take(proactor, key).err().map(Cancelled::Probe),
            Cancelled::Accept(key) => take(proactor, key).err().map(Cancelled::Accept),
            #[cfg(windows)]
            Cancelled::RecvFrom(key) => take(proactor, key).err().map(Cancelled::RecvFrom),
            #[cfg(windows)]
            Cancelled::SendTo(key) => take(proactor, key).err().map(Cancelled::SendTo),
        }
    }
}
