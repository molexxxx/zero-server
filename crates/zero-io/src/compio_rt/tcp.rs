//! A TCP stream on the completion backend.
//!
//! A read waits for readability first (a poll operation on Unix, a zero-length
//! receive on IOCP), leases its block only then, and receives into it at once
//! without blocking, so a connection that is waiting holds no buffer. The readiness
//! operation belongs to the stream, not to
//! the future that waits on it: a driver that races its read against a write and a
//! timer each turn drops the wait whenever something else wins, and cancelling an
//! operation per turn would cost a cancel and two completions each time. The
//! operation stays in flight until readiness arrives and the next wait takes it.
//! Nothing is awaited between the receive and its return, so a dropped read never
//! loses bytes the kernel already handed over. The io_uring driver could take the
//! block from a provided buffer ring with the completion instead; this backend does
//! not use one.
//!
//! A write stages its slices into a buffer the kernel owns for the length of the
//! send. The send belongs to the stream too: one whose future is dropped stays in
//! flight, since cancelling it cannot tell whether the kernel already sent its bytes,
//! and the next write, which the seam requires to start with the same bytes, takes
//! its count instead of sending them again.

use std::cell::{Cell, RefCell};
use std::future::{poll_fn, Future};
use std::io::{self, IoSlice, Read};
use std::net::SocketAddr;
use std::rc::Rc;
use std::task::Poll;

use compio_buf::{BufResult, IntoInner};
#[cfg(windows)]
use compio_driver::op::{Recv, RecvFlags};
use compio_driver::op::{Send, SendFlags};
use compio_driver::{Key, PushEntry, SharedFd};
use socket2::Socket;
use zero_core::OwnedBuf;

use super::executor::Handle;
use crate::pool::Pool;
use crate::seam::{Leased, Stream};

/// The readiness operation of a stream: a poll on Unix, a receive into no bytes on
/// IOCP, which completes when data is available.
#[cfg(unix)]
type ReadyOp = super::ops::PollOp;
#[cfg(windows)]
type ReadyOp = super::ops::ProbeOp;

/// A send of staged bytes.
type SendOp = Send<Vec<u8>, SharedFd<Socket>>;

/// A connected TCP stream on this core.
pub struct TcpStream {
    fd: SharedFd<Socket>,
    handle: Rc<Handle>,
    /// The readiness operation in flight, kept across the futures that wait on it.
    ready: RefCell<Option<Key<ReadyOp>>>,
    /// The send in flight, kept across the futures that wait on it.
    send: RefCell<Option<Key<SendOp>>>,
    /// Bytes a finished send reported beyond what the write that took its count was
    /// given, owed to the next write.
    carried: Cell<usize>,
}

impl Drop for TcpStream {
    fn drop(&mut self) {
        if let Some(key) = self.ready.borrow_mut().take() {
            self.handle.abandon(key);
        }
        if let Some(key) = self.send.borrow_mut().take() {
            self.handle.abandon(key);
        }
    }
}

impl std::fmt::Debug for TcpStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TcpStream")
            .field("inner", &*self.fd)
            .finish_non_exhaustive()
    }
}

/// The flags every send carries: no `SIGPIPE` where the kernel offers the flag.
fn send_flags() -> SendFlags {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        SendFlags::NOSIGNAL
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        SendFlags::empty()
    }
}

impl TcpStream {
    /// A stream over an accepted socket, registered with the core's driver.
    pub(crate) fn new(handle: Rc<Handle>, inner: Socket) -> io::Result<Self> {
        inner.set_nonblocking(true)?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawSocket;
            handle.attach(inner.as_raw_socket() as compio_driver::RawFd)?;
        }
        Ok(TcpStream {
            fd: SharedFd::new(inner),
            handle,
            ready: RefCell::new(None),
            send: RefCell::new(None),
            carried: Cell::new(0),
        })
    }

    /// The readiness operation for this stream, fresh.
    fn ready_op(&self) -> ReadyOp {
        #[cfg(unix)]
        {
            compio_driver::op::PollOnce::new(self.fd.clone(), compio_driver::op::Interest::Readable)
        }
        #[cfg(windows)]
        {
            Recv::new(self.fd.clone(), Vec::<u8>::new(), RecvFlags::empty())
        }
    }

    /// The local address of the connection.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        internet_address(&self.fd.local_addr()?)
    }

    /// `TCP_NODELAY`: send each write at once rather than coalescing it.
    ///
    /// # Arguments
    ///
    /// * `on` - whether to disable the delay.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    pub fn set_nodelay(&self, on: bool) -> io::Result<()> {
        zero_sys::sockopt::set_tcp_nodelay(&*self.fd, on)
    }

    /// Wait until the socket is readable, through the stream's own readiness
    /// operation: submitted when none is in flight, taken when it completed.
    async fn wait_readable(&self) -> io::Result<()> {
        poll_fn(|cx| {
            let mut proactor = self.handle.proactor();
            let mut ready = self.ready.borrow_mut();
            let pushed = match ready.take() {
                Some(key) => proactor.pop(key),
                None => proactor.push(self.ready_op()),
            };
            match pushed {
                PushEntry::Ready(BufResult(result, _)) => Poll::Ready(result.map(drop)),
                PushEntry::Pending(key) => {
                    proactor.update_waker(&key, cx.waker());
                    *ready = Some(key);
                    Poll::Pending
                }
            }
        })
        .await
    }

    /// Receive into the unfilled part of `buf` without blocking.
    fn receive_now(&self, buf: &mut OwnedBuf) -> io::Result<usize> {
        let count = loop {
            match (&*self.fd).read(buf.unfilled_mut()) {
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                outcome => break outcome?,
            }
        };
        buf.advance(count)
            .map_err(|err| io::Error::other(err.to_string()))?;
        Ok(count)
    }

    /// Wait for the stream's send in flight, submitting `op` first when there is
    /// none; the send stays with the stream if this future is dropped.
    async fn sent(&self, op: Option<SendOp>) -> io::Result<usize> {
        let mut op = op;
        poll_fn(|cx| {
            let mut proactor = self.handle.proactor();
            let mut send = self.send.borrow_mut();
            let pushed = match send.take() {
                Some(key) => proactor.pop(key),
                None => match op.take() {
                    Some(op) => proactor.push(op),
                    None => return Poll::Ready(Ok(0)),
                },
            };
            match pushed {
                PushEntry::Ready(BufResult(result, op)) => {
                    self.handle.give_staging(op.into_inner());
                    Poll::Ready(result)
                }
                PushEntry::Pending(key) => {
                    proactor.update_waker(&key, cx.waker());
                    *send = Some(key);
                    Poll::Pending
                }
            }
        })
        .await
    }

    /// Report a finished send's count against a write of `total` bytes, owing any
    /// excess to the next write.
    fn report(&self, count: usize, total: usize) -> usize {
        let reported = count.min(total);
        self.carried.set(count.saturating_sub(reported));
        reported
    }
}

impl Stream for TcpStream {
    fn readable(&self) -> impl Future<Output = io::Result<()>> {
        self.wait_readable()
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        loop {
            self.wait_readable().await?;
            let Some(mut buf) = pool.lease() else {
                return Ok(Leased::NoBudget);
            };
            match self.receive_now(&mut buf) {
                Ok(0) => {
                    pool.release(buf);
                    return Ok(Leased::Eof);
                }
                Ok(_) => return Ok(Leased::Data(buf)),
                // Readiness can be reported without data; the block goes back before
                // the wait, so a waiting connection holds nothing.
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => pool.release(buf),
                Err(err) => {
                    pool.release(buf);
                    return Err(err);
                }
            }
        }
    }

    async fn read_into(&self, buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        let mut buf = buf;
        if buf.remaining() == 0 {
            return (
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the buffer has no room to read into",
                )),
                buf,
            );
        }
        loop {
            if let Err(err) = self.wait_readable().await {
                return (Err(err), buf);
            }
            match self.receive_now(&mut buf) {
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                outcome => return (outcome, buf),
            }
        }
    }

    async fn write(&self, buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        let written = self.writev(&[IoSlice::new(buf.filled())]).await;
        (written, buf)
    }

    async fn writev(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        let total = bufs
            .iter()
            .fold(0usize, |sum, slice| sum.saturating_add(slice.len()));
        let carried = self.carried.get();
        if carried > 0 {
            return Ok(self.report(carried, total));
        }
        // A send left in flight by a dropped write carries the first bytes of these.
        if self.send.borrow().is_some() {
            match self.sent(None).await {
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                outcome => return outcome.map(|count| self.report(count, total)),
            }
        }
        if total == 0 {
            return Ok(0);
        }
        loop {
            // The one copy the seam costs a completion backend: the slices are staged
            // into a buffer the kernel can own for the length of the operation.
            let mut staging = self.handle.take_staging();
            for slice in bufs {
                staging.extend_from_slice(slice);
            }
            let op = Send::new(self.fd.clone(), staging, send_flags());
            match self.sent(Some(op)).await {
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                outcome => return outcome.map(|count| self.report(count, total)),
            }
        }
    }

    fn shutdown_write(&self) -> io::Result<()> {
        self.fd.shutdown(std::net::Shutdown::Write)
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        internet_address(&self.fd.peer_addr()?)
    }
}

/// An address as the seam reports it.
pub(crate) fn internet_address(addr: &socket2::SockAddr) -> io::Result<SocketAddr> {
    addr.as_socket().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the address is not an internet address",
        )
    })
}
