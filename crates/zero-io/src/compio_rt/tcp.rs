//! A TCP stream on the completion backend: every operation takes the buffer's
//! storage by value and hands it back with the count.
//!
//! A read waits for readability first (a poll operation on Unix, a zero-length
//! receive on IOCP) and leases its block only then, so a connection that is waiting
//! holds no buffer, the lazy lease of `DESIGN.md` section 5.6. The readiness
//! operation belongs to the stream, not to the future that waits on it: a driver
//! that races its read against a write and a timer each turn drops the wait
//! whenever something else wins, and cancelling an operation per turn would cost
//! a cancel and two completions each time. The operation stays in flight until
//! readiness arrives and the next wait takes it. The io_uring driver could take
//! the block from a provided buffer ring with the completion instead; that path is
//! recorded in the status file as the follow-up it is.

use std::cell::RefCell;
use std::future::{poll_fn, Future};
use std::io::{self, IoSlice};
use std::net::SocketAddr;
use std::rc::Rc;
use std::task::Poll;

use compio_buf::{BufResult, IntoInner, IoBuf};
use compio_driver::op::{Recv, RecvFlags, Send, SendFlags};
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

/// A connected TCP stream on this core.
pub struct TcpStream {
    fd: SharedFd<Socket>,
    handle: Rc<Handle>,
    /// The readiness operation in flight, kept across the futures that wait on it.
    ready: RefCell<Option<Key<ReadyOp>>>,
}

impl Drop for TcpStream {
    fn drop(&mut self) {
        if let Some(key) = self.ready.borrow_mut().take() {
            self.handle.abandon(key, false);
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

    /// Receive into the unfilled part of `buf`; a block from the pool goes back to
    /// it if the receive is dropped before it completes.
    async fn receive(&self, buf: OwnedBuf, pooled: bool) -> (io::Result<usize>, OwnedBuf) {
        let (storage, filled) = buf.into_parts();
        let op = Recv::new(self.fd.clone(), storage.slice(filled..), RecvFlags::empty());
        let submitted = if pooled {
            self.handle.push_pooled(op)
        } else {
            self.handle.push(op)
        };
        let BufResult(result, op) = submitted.await;
        let storage = op.into_inner().into_inner();
        match result {
            Ok(count) => (
                Ok(count),
                OwnedBuf::from_parts(storage, filled.saturating_add(count)),
            ),
            Err(err) => (Err(err), OwnedBuf::from_parts(storage, filled)),
        }
    }
}

impl Stream for TcpStream {
    fn readable(&self) -> impl Future<Output = io::Result<()>> {
        self.wait_readable()
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        loop {
            self.wait_readable().await?;
            let Some(buf) = pool.lease() else {
                return Ok(Leased::NoBudget);
            };
            let (result, buf) = self.receive(buf, true).await;
            match result {
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
        if buf.remaining() == 0 {
            return (
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the buffer has no room to read into",
                )),
                buf,
            );
        }
        let mut buf = buf;
        loop {
            let (result, back) = self.receive(buf, false).await;
            buf = back;
            match result {
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                outcome => return (outcome, buf),
            }
        }
    }

    async fn write(&self, buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        if buf.is_empty() {
            return (Ok(0), buf);
        }
        let (storage, filled) = buf.into_parts();
        let mut slice = storage.slice(..filled);
        loop {
            let op = Send::new(self.fd.clone(), slice, send_flags());
            let BufResult(result, back) = self.handle.push(op).await;
            slice = back.into_inner();
            match result {
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                outcome => return (outcome, OwnedBuf::from_parts(slice.into_inner(), filled)),
            }
        }
    }

    async fn writev(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        // The one copy the seam costs a completion backend: the slices are staged
        // into a buffer the kernel can own for the length of the operation.
        let mut staging = self.handle.take_staging();
        for slice in bufs {
            staging.extend_from_slice(slice);
        }
        if staging.is_empty() {
            self.handle.give_staging(staging);
            return Ok(0);
        }
        let result = loop {
            let op = Send::new(self.fd.clone(), staging, send_flags());
            let BufResult(result, back) = self.handle.push(op).await;
            staging = back.into_inner();
            match result {
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                outcome => break outcome,
            }
        };
        self.handle.give_staging(staging);
        result
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
