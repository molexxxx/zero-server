//! The acceptor of the `io-compio` backend over the listener strategy of
//! [`crate::net`]: an accept operation on a core's own listener on Linux, or the
//! sockets core 0's listener hands it through a slot with a waker on Windows and
//! macOS.

use std::collections::VecDeque;
use std::future::poll_fn;
use std::io;
use std::net::SocketAddr;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use compio_buf::BufResult;
#[cfg(unix)]
use compio_buf::IntoInner;
use compio_driver::SharedFd;
use socket2::Socket;

use super::executor::Handle;
use super::shutdown::ShutdownHandle;
use super::tcp::{internet_address, TcpStream};
use crate::net::{is_transient, Handoff};
use crate::seam::{Listener, Shutdown};

/// A core's share of the handed-off sockets, filled by core 0's acceptor.
#[derive(Debug, Default)]
pub(crate) struct Slot {
    inner: Mutex<SlotInner>,
    closed: AtomicBool,
}

#[derive(Debug, Default)]
struct SlotInner {
    items: VecDeque<Handoff>,
    waker: Option<Waker>,
}

impl Slot {
    fn inner(&self) -> MutexGuard<'_, SlotInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Hand one socket to the core and wake its acceptor.
    fn push(&self, item: Handoff) {
        let waker = {
            let mut inner = self.inner();
            inner.items.push_back(item);
            inner.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Tell the core no more sockets come.
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let waker = self.inner().waker.take();
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// The next socket, `None` once the listener is gone.
    fn poll_next(&self, cx: &mut Context<'_>) -> Poll<Option<Handoff>> {
        let mut inner = self.inner();
        if let Some(item) = inner.items.pop_front() {
            return Poll::Ready(Some(item));
        }
        if self.closed.load(Ordering::Acquire) {
            return Poll::Ready(None);
        }
        inner.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

/// Where a core's connections come from.
pub struct Acceptor {
    source: Source,
}

enum Source {
    /// This core's own listener.
    Own {
        /// The listener, shared with the operations in flight on it.
        listener: SharedFd<Socket>,
        /// The core.
        handle: Rc<Handle>,
        /// Whether accepted sockets get `TCP_NODELAY`.
        nodelay: bool,
    },
    /// The sockets another core's listener hands to this one.
    Handoff {
        /// This core's slot.
        slot: Arc<Slot>,
        /// The core.
        handle: Rc<Handle>,
        /// The address the shared listener is bound to.
        addr: SocketAddr,
        /// Whether accepted sockets get `TCP_NODELAY`.
        nodelay: bool,
    },
}

impl Acceptor {
    /// An acceptor on this core's own listener.
    pub(crate) fn own(listener: SharedFd<Socket>, handle: Rc<Handle>, nodelay: bool) -> Self {
        Acceptor {
            source: Source::Own {
                listener,
                handle,
                nodelay,
            },
        }
    }

    /// An acceptor on this core's share of the handed-off sockets.
    pub(crate) fn handoff(
        slot: Arc<Slot>,
        handle: Rc<Handle>,
        addr: SocketAddr,
        nodelay: bool,
    ) -> Self {
        Acceptor {
            source: Source::Handoff {
                slot,
                handle,
                addr,
                nodelay,
            },
        }
    }
}

impl std::fmt::Debug for Acceptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.source {
            Source::Own { listener, .. } => f
                .debug_struct("Own")
                .field("listener", &**listener)
                .finish_non_exhaustive(),
            Source::Handoff { addr, .. } => f
                .debug_struct("Handoff")
                .field("addr", addr)
                .finish_non_exhaustive(),
        }
    }
}

/// One accept on `listener`: the socket, blocking mode not yet set, and the peer.
pub(crate) async fn accept_raw(
    handle: &Rc<Handle>,
    listener: &SharedFd<Socket>,
) -> io::Result<(Socket, SocketAddr)> {
    #[cfg(unix)]
    {
        let op = compio_driver::op::Accept::new(listener.clone());
        let BufResult(result, op) = handle.push(op).await;
        result?;
        let (socket, addr) = op.into_inner();
        let peer = internet_address(&addr)?;
        Ok((socket, peer))
    }
    #[cfg(windows)]
    {
        use socket2::{Domain, Protocol, Type};
        let local = internet_address(&listener.local_addr()?)?;
        let socket = Socket::new(
            Domain::for_address(local),
            Type::STREAM,
            Some(Protocol::TCP),
        )?;
        let op = compio_driver::op::Accept::new(listener.clone(), SharedFd::new(socket));
        let BufResult(result, op) = handle.push(op).await;
        result?;
        op.update_context()?;
        let (socket, addr) = op.into_addr()?;
        let peer = internet_address(&addr)?;
        let socket = socket.try_unwrap().map_err(|_| {
            io::Error::other("the accepted socket is still shared with an operation")
        })?;
        Ok((socket, peer))
    }
}

impl Listener for Acceptor {
    type Stream = TcpStream;

    async fn accept(&self) -> io::Result<(TcpStream, SocketAddr)> {
        let (socket, peer, handle, nodelay) = match &self.source {
            Source::Own {
                listener,
                handle,
                nodelay,
            } => {
                let (socket, peer) = accept_raw(handle, listener).await?;
                (socket, peer, handle, *nodelay)
            }
            Source::Handoff {
                slot,
                handle,
                nodelay,
                ..
            } => {
                let handed = poll_fn(|cx| slot.poll_next(cx)).await;
                let (socket, peer) = handed.ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotConnected, "the listener closed")
                })?;
                (Socket::from(socket), peer, handle, *nodelay)
            }
        };
        let stream = TcpStream::new(Rc::clone(handle), socket)?;
        if nodelay {
            stream.set_nodelay(true)?;
        }
        Ok((stream, peer))
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        match &self.source {
            Source::Own { listener, .. } => internet_address(&listener.local_addr()?),
            Source::Handoff { addr, .. } => Ok(*addr),
        }
    }
}

/// Accept on the shared listener and hand each socket to the next core, until a
/// shutdown is requested or the listener fails for good; then close every slot.
///
/// # Arguments
///
/// * `handle` - core 0.
/// * `listener` - the one listener.
/// * `cores` - every core's slot, in order.
/// * `shutdown` - the signal that ends the loop.
pub(crate) async fn distribute(
    handle: Rc<Handle>,
    listener: SharedFd<Socket>,
    cores: Vec<Arc<Slot>>,
    shutdown: ShutdownHandle,
) {
    let mut targets = cores.iter().cycle();
    while let Some(accepted) = shutdown.until(accept_raw(&handle, &listener)).await {
        match accepted {
            Ok((socket, peer)) => {
                if let Some(target) = targets.next() {
                    target.push((socket.into(), peer));
                }
            }
            // A transient failure (the descriptor table is full, a connection was
            // reset before accept) is retried after a pause; see accept(2).
            Err(err) if is_transient(&err) => {
                let pause = super::time::sleep_on(&handle, Duration::from_millis(10));
                if shutdown.until(pause).await.is_none() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    for slot in &cores {
        slot.close();
    }
}
