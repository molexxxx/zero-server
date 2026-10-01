//! A UDP socket on the completion backend: batches of datagrams received and sent,
//! each with its packet information, ECN codepoint and segment size.
//!
//! On Unix the socket waits for readiness through the driver and then goes through
//! `recvmsg` and `sendmsg` in `zero-sys` with a control buffer, as the readiness
//! backend does; on Windows each datagram is one receive or send operation on the
//! completion port, which carries the peer alone until `WSARecvMsg` is wired.

use std::io;
use std::net::SocketAddr;
use std::rc::Rc;

use compio_driver::SharedFd;
use socket2::Socket;
use zero_core::OwnedBuf;

use super::executor::{self, Handle};
pub use crate::net::DatagramConfig;
use crate::seam::{Datagram, DatagramMeta};

/// A bound UDP socket on this core.
pub struct UdpSocket {
    fd: SharedFd<Socket>,
    handle: Rc<Handle>,
    v6: bool,
}

impl std::fmt::Debug for UdpSocket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UdpSocket")
            .field("inner", &*self.fd)
            .field("v6", &self.v6)
            .finish_non_exhaustive()
    }
}

impl UdpSocket {
    /// Bind a socket, set up as `config` says. Call it on the core's thread.
    ///
    /// # Arguments
    ///
    /// * `addr` - the local address; port 0 picks one.
    /// * `config` - the options.
    ///
    /// # Errors
    ///
    /// The operating system's error, or that no core runs on this thread.
    pub fn bind(addr: SocketAddr, config: &DatagramConfig) -> io::Result<Self> {
        let handle = executor::current()?;
        let (socket, v6) = crate::net::bind_datagram(addr, config)?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawSocket;
            handle.attach(socket.as_raw_socket() as compio_driver::RawFd)?;
        }
        Ok(UdpSocket {
            fd: SharedFd::new(Socket::from(socket)),
            handle,
            v6,
        })
    }

    /// Whether the socket is IPv6.
    #[must_use]
    pub const fn is_v6(&self) -> bool {
        self.v6
    }

    /// The type of service every datagram is sent with unless its metadata says
    /// otherwise (`IP_TOS`, `IPV6_TCLASS`). Linux and Apple platforms.
    ///
    /// # Arguments
    ///
    /// * `tos` - the byte, ECN bits included.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    #[cfg(any(target_os = "linux", target_vendor = "apple"))]
    pub fn set_tos(&self, tos: u8) -> io::Result<()> {
        zero_sys::sockopt::set_tos(&*self.fd, crate::net::ip_family(self.v6), tos)
    }

    /// Wait for the socket to be readable or writable.
    #[cfg(unix)]
    async fn wait(&self, interest: compio_driver::op::Interest) -> io::Result<()> {
        let op = compio_driver::op::PollOnce::new(self.fd.clone(), interest);
        let compio_buf::BufResult(result, _) = self.handle.push(op).await;
        result.map(drop)
    }
}

impl Datagram for UdpSocket {
    async fn recv_batch(
        &self,
        bufs: &mut [OwnedBuf],
        meta: &mut [DatagramMeta],
    ) -> io::Result<usize> {
        if meta.len() < bufs.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "one metadata entry per buffer",
            ));
        }
        if bufs.is_empty() {
            return Ok(0);
        }
        #[cfg(unix)]
        {
            loop {
                self.wait(compio_driver::op::Interest::Readable).await?;
                let mut count = 0;
                for (buf, entry) in bufs.iter_mut().zip(meta.iter_mut()) {
                    match crate::net::unix::receive(&*self.fd, buf, entry) {
                        Ok(()) => count += 1,
                        Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                        Err(err) if count > 0 => {
                            let _ = err;
                            break;
                        }
                        Err(err) => return Err(err),
                    }
                }
                if count > 0 {
                    return Ok(count);
                }
            }
        }
        #[cfg(windows)]
        {
            windows::receive_one(&self.handle, &self.fd, bufs, meta).await
        }
    }

    async fn send_batch(&self, bufs: &[OwnedBuf], meta: &[DatagramMeta]) -> io::Result<usize> {
        if meta.len() < bufs.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "one metadata entry per buffer",
            ));
        }
        if bufs.is_empty() {
            return Ok(0);
        }
        #[cfg(unix)]
        {
            loop {
                self.wait(compio_driver::op::Interest::Writable).await?;
                let mut count = 0;
                for (buf, entry) in bufs.iter().zip(meta.iter()) {
                    match crate::net::unix::send(&*self.fd, self.v6, buf, entry) {
                        Ok(()) => count += 1,
                        Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                        Err(err) if count > 0 => {
                            let _ = err;
                            break;
                        }
                        Err(err) => return Err(err),
                    }
                }
                if count > 0 {
                    return Ok(count);
                }
            }
        }
        #[cfg(windows)]
        {
            windows::send_all(&self.handle, &self.fd, bufs, meta).await
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        super::tcp::internet_address(&self.fd.local_addr()?)
    }
}

/// The completion-port datagram path: one operation per datagram, owned buffers in
/// and out, the peer from the operation.
#[cfg(windows)]
mod windows {
    use std::io;
    use std::rc::Rc;

    use compio_buf::{BufResult, IntoInner, IoBuf};
    use compio_driver::op::{RecvFlags, RecvFrom, SendFlags, SendTo};
    use compio_driver::SharedFd;
    use zero_core::OwnedBuf;

    use super::Handle;
    use crate::seam::DatagramMeta;

    /// Windows fills the buffer with the first part of a datagram that is longer
    /// than it and then fails the call with this code, so the error is a full,
    /// truncated buffer whose peer is not reported.
    const WSAEMSGSIZE: i32 = 10040;

    /// The same condition as the completion port reports it, `ERROR_MORE_DATA`,
    /// the Win32 reading of `STATUS_BUFFER_OVERFLOW`.
    const ERROR_MORE_DATA: i32 = 234;

    pub(super) async fn receive_one(
        handle: &Rc<Handle>,
        fd: &SharedFd<socket2::Socket>,
        bufs: &mut [OwnedBuf],
        meta: &mut [DatagramMeta],
    ) -> io::Result<usize> {
        let Some((first, entry)) = bufs.iter_mut().zip(meta.iter_mut()).next() else {
            return Ok(0);
        };
        let taken = std::mem::replace(first, OwnedBuf::with_capacity(0));
        let (storage, filled) = taken.into_parts();
        let capacity = storage.len();
        let op = RecvFrom::new(fd.clone(), storage.slice(filled..), RecvFlags::empty());
        let BufResult(result, op) = handle.push(op).await;
        let (slice, addr) = op.into_inner();
        let storage = slice.into_inner();
        match result {
            Ok(count) => {
                *first = OwnedBuf::from_parts(storage, filled.saturating_add(count));
                *entry = DatagramMeta {
                    peer: addr.and_then(|addr| addr.as_socket()),
                    ..DatagramMeta::default()
                };
                Ok(1)
            }
            Err(err) if matches!(err.raw_os_error(), Some(WSAEMSGSIZE | ERROR_MORE_DATA)) => {
                *first = OwnedBuf::from_parts(storage, capacity);
                *entry = DatagramMeta {
                    peer: None,
                    truncated: true,
                    ..DatagramMeta::default()
                };
                Ok(1)
            }
            Err(err) => {
                *first = OwnedBuf::from_parts(storage, filled);
                Err(err)
            }
        }
    }

    pub(super) async fn send_all(
        handle: &Rc<Handle>,
        fd: &SharedFd<socket2::Socket>,
        bufs: &[OwnedBuf],
        meta: &[DatagramMeta],
    ) -> io::Result<usize> {
        let mut count = 0;
        for (buf, entry) in bufs.iter().zip(meta.iter()) {
            let peer = entry.peer.ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "a datagram needs a peer")
            })?;
            let copy = buf.filled().to_vec();
            let op = SendTo::new(fd.clone(), copy, peer.into(), SendFlags::empty());
            let BufResult(result, _) = handle.push(op).await;
            match result {
                Ok(_) => count += 1,
                Err(_) if count > 0 => break,
                Err(err) => return Err(err),
            }
        }
        Ok(count)
    }
}
