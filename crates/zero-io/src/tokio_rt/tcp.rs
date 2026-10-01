//! A TCP stream on the readiness backend: wait for readiness, then perform the
//! operation into or out of the owned buffer the caller passed.

use std::future::Future;
use std::io::{self, IoSlice};
use std::net::SocketAddr;

use zero_core::OwnedBuf;

use crate::pool::Pool;
use crate::seam::{Leased, Stream};

/// A connected TCP stream on this core.
#[derive(Debug)]
pub struct TcpStream {
    inner: tokio::net::TcpStream,
}

impl TcpStream {
    pub(crate) fn new(inner: tokio::net::TcpStream) -> Self {
        TcpStream { inner }
    }

    /// The local address of the connection.
    ///
    /// # Errors
    ///
    /// The operating system's error.
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.inner.local_addr()
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
        zero_sys::sockopt::set_tcp_nodelay(&self.inner, on)
    }
}

impl Stream for TcpStream {
    fn readable(&self) -> impl Future<Output = io::Result<()>> {
        self.inner.readable()
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        loop {
            self.inner.readable().await?;
            let Some(mut buf) = pool.lease() else {
                return Ok(Leased::NoBudget);
            };
            match self.inner.try_read(buf.unfilled_mut()) {
                Ok(0) => {
                    pool.release(buf);
                    return Ok(Leased::Eof);
                }
                Ok(count) => {
                    if let Err(err) = buf.advance(count) {
                        pool.release(buf);
                        return Err(io::Error::other(err.to_string()));
                    }
                    return Ok(Leased::Data(buf));
                }
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

    async fn read_into(&self, mut buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
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
            if let Err(err) = self.inner.readable().await {
                return (Err(err), buf);
            }
            match self.inner.try_read(buf.unfilled_mut()) {
                Ok(count) => {
                    if let Err(err) = buf.advance(count) {
                        return (Err(io::Error::other(err.to_string())), buf);
                    }
                    return (Ok(count), buf);
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                Err(err) => return (Err(err), buf),
            }
        }
    }

    async fn write(&self, buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        if buf.is_empty() {
            return (Ok(0), buf);
        }
        loop {
            if let Err(err) = self.inner.writable().await {
                return (Err(err), buf);
            }
            match self.inner.try_write(buf.filled()) {
                Ok(count) => return (Ok(count), buf),
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                Err(err) => return (Err(err), buf),
            }
        }
    }

    async fn writev(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        loop {
            self.inner.writable().await?;
            match self.inner.try_write_vectored(bufs) {
                Ok(count) => return Ok(count),
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
                Err(err) => return Err(err),
            }
        }
    }

    fn shutdown_write(&self) -> io::Result<()> {
        socket2::SockRef::from(&self.inner).shutdown(std::net::Shutdown::Write)
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        self.inner.peer_addr()
    }
}
