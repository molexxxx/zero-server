//! The buffered driver: rustls's `ServerConnection` over the seam.
//!
//! rustls holds the plaintext it decrypted and the records it produced; this driver
//! moves ciphertext between the connection and the transport. Ciphertext rustls
//! cannot take yet, because 16 KiB of plaintext already waits, stays in the driver
//! until the reader drains. Records go out only through the [`Outbox`], so a write the
//! connection driver drops is resumed, never repeated: plaintext encrypted by a write
//! that was dropped is reported written by the next call once its records are out,
//! and that call is passed the same bytes again.
//!
//! @see <https://docs.rs/rustls/0.23.45/rustls/server/struct.ServerConnection.html>

use std::cell::{Cell, RefCell};
use std::io::{self, BufRead, IoSlice, Read, Write};
use std::net::SocketAddr;
use std::sync::Arc;

use rustls::{ServerConfig, ServerConnection};
use zero_core::OwnedBuf;
use zero_io::pool::Pool;
use zero_io::seam::{Leased, Stream};

use crate::outbox::Outbox;

/// The most plaintext one write encrypts.
const WRITE_CHUNK: usize = 64 * 1024;

/// What the plaintext side holds.
enum Plain {
    Ready,
    End,
    Empty,
}

/// A TLS session over a transport, through rustls's buffered connection.
pub struct BufferedStream<S> {
    inner: S,
    tls: RefCell<ServerConnection>,
    incoming: RefCell<Vec<u8>>,
    outbox: Outbox,
    reported: Cell<usize>,
}

impl<S> std::fmt::Debug for BufferedStream<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BufferedStream")
            .field("incoming", &self.incoming.borrow().len())
            .finish_non_exhaustive()
    }
}

impl<S: Stream> BufferedStream<S> {
    /// Start a session whose first bytes, the client's hello, were already read.
    pub(crate) fn new(inner: S, config: Arc<ServerConfig>, first: Vec<u8>) -> io::Result<Self> {
        let tls = ServerConnection::new(config).map_err(tls_error)?;
        Ok(BufferedStream {
            inner,
            tls: RefCell::new(tls),
            incoming: RefCell::new(first),
            outbox: Outbox::default(),
            reported: Cell::new(0),
        })
    }

    /// Complete the handshake.
    pub(crate) async fn handshake(&self, pool: &Pool) -> io::Result<()> {
        loop {
            let fed = self.feed();
            self.collect()?;
            if let Err(err) = fed {
                let _ = self.outbox.flush(&self.inner).await;
                return Err(err);
            }
            self.outbox.flush(&self.inner).await?;
            if !self.tls.borrow().is_handshaking() {
                self.collect()?;
                return self.outbox.flush(&self.inner).await;
            }
            if !self.incoming.borrow().is_empty() {
                continue;
            }
            match self.inner.read_leased(pool).await? {
                Leased::Data(buf) => {
                    self.incoming.borrow_mut().extend_from_slice(buf.filled());
                    pool.release(buf);
                }
                Leased::Eof => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
                Leased::NoBudget => return Err(io::Error::from(io::ErrorKind::OutOfMemory)),
            }
        }
    }

    /// Hand rustls the ciphertext it will take and process it.
    fn feed(&self) -> io::Result<()> {
        let mut incoming = self.incoming.borrow_mut();
        let mut tls = self.tls.borrow_mut();
        while !incoming.is_empty() {
            let mut rest: &[u8] = &incoming;
            let taken = match tls.read_tls(&mut rest) {
                Ok(taken) => taken,
                Err(err) if err.kind() == io::ErrorKind::Other => break,
                Err(err) => return Err(err),
            };
            incoming.drain(..taken);
            tls.process_new_packets().map_err(tls_error)?;
            if taken == 0 {
                break;
            }
        }
        Ok(())
    }

    /// Move the records rustls produced into the outbox.
    fn collect(&self) -> io::Result<()> {
        let mut tls = self.tls.borrow_mut();
        self.outbox.fill(|out| {
            while tls.wants_write() {
                tls.write_tls(out)?;
            }
            Ok(())
        })
    }

    /// What the plaintext side holds now.
    fn plain(&self) -> io::Result<Plain> {
        let mut tls = self.tls.borrow_mut();
        let mut reader = tls.reader();
        match reader.fill_buf() {
            Ok(buf) if !buf.is_empty() => Ok(Plain::Ready),
            Ok(_) => Ok(Plain::End),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => Ok(Plain::Empty),
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => Ok(Plain::End),
            Err(err) => Err(err),
        }
    }

    /// Read ciphertext from the transport into `incoming`, or tell rustls the
    /// transport ended.
    async fn pull(&self, pool: &Pool) -> io::Result<Option<Leased>> {
        match self.inner.read_leased(pool).await? {
            Leased::Data(buf) => {
                self.incoming.borrow_mut().extend_from_slice(buf.filled());
                pool.release(buf);
                Ok(None)
            }
            Leased::Eof => {
                let mut tls = self.tls.borrow_mut();
                let _ = tls.read_tls(&mut io::empty());
                let _ = tls.process_new_packets();
                Ok(None)
            }
            Leased::NoBudget => Ok(Some(Leased::NoBudget)),
        }
    }

    /// Report plaintext whose records are already out, after a write was dropped:
    /// at most `total`, the bytes this write was given, with the rest owed to the
    /// next.
    async fn resume(&self, total: usize) -> io::Result<Option<usize>> {
        let reported = self.reported.get();
        if reported == 0 {
            return Ok(None);
        }
        self.outbox.flush(&self.inner).await?;
        let count = reported.min(total);
        self.reported.set(reported - count);
        Ok(Some(count))
    }
}

impl<S: Stream> Stream for BufferedStream<S> {
    async fn readable(&self) -> io::Result<()> {
        if !self.incoming.borrow().is_empty() || !matches!(self.plain()?, Plain::Empty) {
            return Ok(());
        }
        self.inner.readable().await
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        loop {
            let fed = self.feed();
            self.collect()?;
            fed?;
            match self.plain()? {
                Plain::Ready => {
                    let Some(mut block) = pool.lease() else {
                        return Ok(Leased::NoBudget);
                    };
                    let count = self.tls.borrow_mut().reader().read(block.unfilled_mut())?;
                    block
                        .advance(count)
                        .map_err(|err| io::Error::other(err.to_string()))?;
                    return Ok(Leased::Data(block));
                }
                Plain::End => return Ok(Leased::Eof),
                Plain::Empty => {}
            }
            if !self.incoming.borrow().is_empty() {
                continue;
            }
            if let Some(leased) = self.pull(pool).await? {
                return Ok(leased);
            }
        }
    }

    async fn read_into(&self, mut buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        let pool = Pool::new(16 * 1024, 64 * 1024);
        loop {
            let fed = self.feed().and_then(|()| self.collect());
            if let Err(err) = fed {
                return (Err(err), buf);
            }
            match self.plain() {
                Ok(Plain::Ready) => {
                    let read = self.tls.borrow_mut().reader().read(buf.unfilled_mut());
                    return match read {
                        Ok(count) => match buf.advance(count) {
                            Ok(()) => (Ok(count), buf),
                            Err(err) => (Err(io::Error::other(err.to_string())), buf),
                        },
                        Err(err) => (Err(err), buf),
                    };
                }
                Ok(Plain::End) => return (Ok(0), buf),
                Ok(Plain::Empty) => {}
                Err(err) => return (Err(err), buf),
            }
            if !self.incoming.borrow().is_empty() {
                continue;
            }
            match self.pull(&pool).await {
                Ok(None) => {}
                Ok(Some(_)) => return (Err(io::Error::from(io::ErrorKind::OutOfMemory)), buf),
                Err(err) => return (Err(err), buf),
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
        if let Some(reported) = self.resume(total).await? {
            return Ok(reported);
        }
        self.outbox.flush(&self.inner).await?;
        let mut accepted = 0usize;
        {
            let mut tls = self.tls.borrow_mut();
            let mut writer = tls.writer();
            for slice in bufs {
                let room = WRITE_CHUNK.saturating_sub(accepted);
                if room == 0 {
                    break;
                }
                let take = slice.get(..slice.len().min(room)).unwrap_or(&[]);
                let count = writer.write(take)?;
                accepted = accepted.saturating_add(count);
                if count < take.len() {
                    break;
                }
            }
        }
        self.collect()?;
        self.reported.set(accepted);
        self.outbox.flush(&self.inner).await?;
        self.reported.set(0);
        Ok(accepted)
    }

    fn shutdown_write(&self) -> io::Result<()> {
        self.inner.shutdown_write()
    }

    async fn close_write(&self) -> io::Result<()> {
        self.tls.borrow_mut().send_close_notify();
        self.collect()?;
        self.outbox.flush(&self.inner).await?;
        self.inner.close_write().await
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        self.inner.peer_addr()
    }
}

/// A TLS error as an I/O error.
pub(crate) fn tls_error(err: rustls::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, err)
}
