//! The unbuffered driver: rustls's `UnbufferedServerConnection` over the seam.
//!
//! rustls keeps no ciphertext and no plaintext here; the driver holds both. Each call
//! to `process_tls_records` hands back one state, handled before the next call, with a
//! count of consumed bytes discarded from the front of the incoming buffer
//! afterwards: records to encode go to the [`Outbox`] and are marked transmitted at
//! once (the outbox writes them in order, exactly once), application data is copied
//! to the plaintext buffer, early data is discarded since none is ever accepted, and a
//! fatal error is turned into its alert record by one more call with no input. The
//! same resume rule as the buffered driver keeps a dropped write from repeating or
//! losing records.
//!
//! @see <https://docs.rs/rustls/0.23.45/rustls/unbuffered/index.html>

use std::cell::{Cell, RefCell};
use std::io::{self, IoSlice};
use std::net::SocketAddr;
use std::sync::Arc;

use rustls::server::UnbufferedServerConnection;
use rustls::unbuffered::{
    ConnectionState, EncodeError, EncryptError, InsufficientSizeError, UnbufferedStatus,
};
use rustls::ServerConfig;
use zero_core::OwnedBuf;
use zero_io::pool::Pool;
use zero_io::seam::{Leased, Stream};

use crate::buffered::tls_error;
use crate::outbox::Outbox;

/// The most plaintext one write encrypts.
const WRITE_CHUNK: usize = 64 * 1024;

/// The most ciphertext waiting on one incomplete message: a handshake message of the
/// largest length rustls joins (2^16 - 1 bytes) and one record of the largest size
/// on the wire (2^14 + 2048 + 5 bytes). rustls's unbuffered connection joins a
/// fragmented message inside this driver's buffer and discards nothing until it is
/// whole, so without this bound a peer sending one-byte records would grow the buffer
/// by a record header and tag per byte. rustls's buffered connection, which joins
/// the payloads alone, refuses a message past the same length.
const MAX_PENDING: usize = 0xffff + 18_437;

/// What one pass asks of the connection besides processing input.
#[derive(Clone, Copy)]
enum Action<'a> {
    Nothing,
    Encrypt(&'a [u8]),
    CloseNotify,
}

/// Where a pass stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    /// The handshake needs more input.
    NeedInput,
    /// Application data may flow.
    Ready,
    /// Both sides closed.
    Closed,
}

/// What one state asked for.
enum Step {
    Again,
    Stop(Outcome),
    Fail(rustls::Error),
}

/// A TLS session over a transport, through rustls's unbuffered connection.
pub struct UnbufferedStream<S> {
    inner: S,
    conn: RefCell<UnbufferedServerConnection>,
    incoming: RefCell<Vec<u8>>,
    plain: RefCell<Vec<u8>>,
    plain_start: Cell<usize>,
    outbox: Outbox,
    reported: Cell<usize>,
    peer_closed: Cell<bool>,
    closed: Cell<bool>,
    ended: Cell<bool>,
    /// A fatal error ended the session and its alert is queued; rustls's unbuffered
    /// connection keeps no error state, so the input that failed is never processed
    /// again.
    failed: Cell<bool>,
}

impl<S> std::fmt::Debug for UnbufferedStream<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnbufferedStream")
            .field("incoming", &self.incoming.borrow().len())
            .field("peer_closed", &self.peer_closed.get())
            .finish_non_exhaustive()
    }
}

impl<S: Stream> UnbufferedStream<S> {
    /// Start a session whose first bytes, the client's hello, were already read.
    pub(crate) fn new(inner: S, config: Arc<ServerConfig>, first: Vec<u8>) -> io::Result<Self> {
        let conn = UnbufferedServerConnection::new(config).map_err(tls_error)?;
        Ok(UnbufferedStream {
            inner,
            conn: RefCell::new(conn),
            incoming: RefCell::new(first),
            plain: RefCell::new(Vec::new()),
            plain_start: Cell::new(0),
            outbox: Outbox::default(),
            reported: Cell::new(0),
            peer_closed: Cell::new(false),
            closed: Cell::new(false),
            ended: Cell::new(false),
            failed: Cell::new(false),
        })
    }

    /// Complete the handshake.
    pub(crate) async fn handshake(&self, pool: &Pool) -> io::Result<()> {
        loop {
            let outcome = match self.drive(Action::Nothing) {
                Ok(outcome) => outcome,
                Err(err) => {
                    let _ = self.outbox.flush(&self.inner).await;
                    return Err(err);
                }
            };
            self.outbox.flush(&self.inner).await?;
            if !self.conn.borrow().is_handshaking() {
                return Ok(());
            }
            if outcome == Outcome::Closed {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
            }
            self.check_pending()?;
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

    /// Process every record the input holds and carry out `action`.
    ///
    /// # Returns
    ///
    /// Where the pass stopped.
    fn drive(&self, action: Action<'_>) -> io::Result<Outcome> {
        if self.failed.get() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the TLS session already failed",
            ));
        }
        let mut conn = self.conn.borrow_mut();
        let mut incoming = self.incoming.borrow_mut();
        let mut plain = self.plain.borrow_mut();
        let mut action = action;
        self.outbox.fill(|out| loop {
            let UnbufferedStatus { mut discard, state } =
                conn.process_tls_records(&mut incoming[..]);
            let step = match state {
                Ok(ConnectionState::ReadTraffic(mut read)) => {
                    let mut step = Step::Again;
                    while let Some(record) = read.next_record() {
                        match record {
                            Ok(record) => {
                                discard = discard.saturating_add(record.discard);
                                plain.extend_from_slice(record.payload);
                            }
                            Err(err) => {
                                step = Step::Fail(err);
                                break;
                            }
                        }
                    }
                    step
                }
                Ok(ConnectionState::ReadEarlyData(mut early)) => {
                    let mut step = Step::Again;
                    while let Some(record) = early.next_record() {
                        match record {
                            Ok(record) => discard = discard.saturating_add(record.discard),
                            Err(err) => {
                                step = Step::Fail(err);
                                break;
                            }
                        }
                    }
                    step
                }
                Ok(ConnectionState::EncodeTlsData(mut encode)) => {
                    encode_into(out, |buf| encode.encode(buf))?;
                    Step::Again
                }
                Ok(ConnectionState::TransmitTlsData(transmit)) => {
                    transmit.done();
                    Step::Again
                }
                Ok(ConnectionState::BlockedHandshake) => Step::Stop(Outcome::NeedInput),
                Ok(ConnectionState::PeerClosed) => {
                    self.peer_closed.set(true);
                    Step::Again
                }
                Ok(ConnectionState::Closed) => {
                    self.peer_closed.set(true);
                    self.closed.set(true);
                    Step::Stop(Outcome::Closed)
                }
                Ok(ConnectionState::WriteTraffic(mut write)) => match action {
                    Action::Nothing => Step::Stop(Outcome::Ready),
                    Action::Encrypt(data) => {
                        encrypt_into(out, data.len(), |buf| write.encrypt(data, buf))?;
                        action = Action::Nothing;
                        Step::Again
                    }
                    Action::CloseNotify => {
                        encrypt_into(out, 0, |buf| write.queue_close_notify(buf))?;
                        action = Action::Nothing;
                        Step::Again
                    }
                },
                Ok(_) => Step::Stop(Outcome::Ready),
                Err(err) => Step::Fail(err),
            };
            let consumed = discard.min(incoming.len());
            incoming.drain(..consumed);
            match step {
                Step::Again => {}
                Step::Stop(outcome) => {
                    if !matches!(action, Action::Nothing) {
                        return Err(io::Error::from(io::ErrorKind::BrokenPipe));
                    }
                    return Ok(outcome);
                }
                Step::Fail(err) => {
                    self.failed.set(true);
                    loop {
                        let status = conn.process_tls_records(&mut []);
                        match status.state {
                            Ok(ConnectionState::EncodeTlsData(mut encode)) => {
                                encode_into(out, |buf| encode.encode(buf))?;
                            }
                            Ok(ConnectionState::TransmitTlsData(transmit)) => transmit.done(),
                            _ => break,
                        }
                    }
                    return Err(tls_error(err));
                }
            }
        })
    }

    /// Refuse to read more while the input that made no progress already holds
    /// [`MAX_PENDING`] bytes.
    fn check_pending(&self) -> io::Result<()> {
        if self.incoming.borrow().len() >= MAX_PENDING {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a TLS message larger than the largest handshake message",
            ));
        }
        Ok(())
    }

    /// Copy waiting plaintext into `out`.
    fn take_plain(&self, out: &mut [u8]) -> usize {
        let mut plain = self.plain.borrow_mut();
        let start = self.plain_start.get();
        let waiting = plain.get(start..).unwrap_or(&[]);
        let count = waiting.len().min(out.len());
        if let (Some(target), Some(source)) = (out.get_mut(..count), waiting.get(..count)) {
            target.copy_from_slice(source);
        }
        let next = start.saturating_add(count);
        if next >= plain.len() {
            plain.clear();
            self.plain_start.set(0);
        } else {
            self.plain_start.set(next);
        }
        count
    }

    fn has_plain(&self) -> bool {
        self.plain.borrow().len() > self.plain_start.get()
    }

    /// Read ciphertext from the transport into `incoming`.
    async fn pull(&self, pool: &Pool) -> io::Result<Option<Leased>> {
        match self.inner.read_leased(pool).await? {
            Leased::Data(buf) => {
                self.incoming.borrow_mut().extend_from_slice(buf.filled());
                pool.release(buf);
                Ok(None)
            }
            Leased::Eof => {
                self.ended.set(true);
                Ok(None)
            }
            Leased::NoBudget => Ok(Some(Leased::NoBudget)),
        }
    }

    /// Process input until plaintext waits or the stream ended.
    async fn fill(&self, pool: &Pool) -> io::Result<Option<Leased>> {
        loop {
            if self.has_plain() {
                return Ok(None);
            }
            if self.peer_closed.get() || self.ended.get() {
                return Ok(Some(Leased::Eof));
            }
            if !self.incoming.borrow().is_empty() {
                let before = self.incoming.borrow().len();
                self.drive(Action::Nothing)?;
                if self.has_plain() || self.peer_closed.get() {
                    continue;
                }
                if self.incoming.borrow().len() < before {
                    continue;
                }
            }
            self.check_pending()?;
            if let Some(leased) = self.pull(pool).await? {
                return Ok(Some(leased));
            }
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

impl<S: Stream> Stream for UnbufferedStream<S> {
    async fn readable(&self) -> io::Result<()> {
        if self.has_plain() || !self.incoming.borrow().is_empty() {
            return Ok(());
        }
        self.inner.readable().await
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        if let Some(leased) = self.fill(pool).await? {
            return Ok(leased);
        }
        let Some(mut block) = pool.lease() else {
            return Ok(Leased::NoBudget);
        };
        let count = self.take_plain(block.unfilled_mut());
        block
            .advance(count)
            .map_err(|err| io::Error::other(err.to_string()))?;
        Ok(Leased::Data(block))
    }

    async fn read_into(&self, mut buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        let pool = Pool::new(16 * 1024, 64 * 1024);
        match self.fill(&pool).await {
            Ok(None) => {
                let count = self.take_plain(buf.unfilled_mut());
                match buf.advance(count) {
                    Ok(()) => (Ok(count), buf),
                    Err(err) => (Err(io::Error::other(err.to_string())), buf),
                }
            }
            Ok(Some(Leased::Eof)) => (Ok(0), buf),
            Ok(Some(_)) => (Err(io::Error::from(io::ErrorKind::OutOfMemory)), buf),
            Err(err) => (Err(err), buf),
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
        for slice in bufs {
            let room = WRITE_CHUNK.saturating_sub(accepted);
            if room == 0 {
                break;
            }
            let take = slice.get(..slice.len().min(room)).unwrap_or(&[]);
            if take.is_empty() {
                continue;
            }
            self.drive(Action::Encrypt(take))?;
            accepted = accepted.saturating_add(take.len());
        }
        self.reported.set(accepted);
        self.outbox.flush(&self.inner).await?;
        self.reported.set(0);
        Ok(accepted)
    }

    fn shutdown_write(&self) -> io::Result<()> {
        self.inner.shutdown_write()
    }

    /// Send `close_notify`, or whatever alert an error queued, then close the
    /// transport. Before the handshake completes the state machine accepts no
    /// `close_notify`, so only what is already queued goes out.
    async fn close_write(&self) -> io::Result<()> {
        if !self.closed.get() {
            let _ = self.drive(Action::CloseNotify);
        }
        self.outbox.flush(&self.inner).await?;
        self.inner.close_write().await
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        self.inner.peer_addr()
    }
}

/// Encode a handshake or alert record at the end of `out`, growing it as rustls asks.
fn encode_into(
    out: &mut Vec<u8>,
    mut encode: impl FnMut(&mut [u8]) -> Result<usize, EncodeError>,
) -> io::Result<()> {
    let start = out.len();
    let mut room = 4 * 1024;
    loop {
        out.resize(start.saturating_add(room), 0);
        match encode(out.get_mut(start..).unwrap_or(&mut [])) {
            Ok(written) => {
                out.truncate(start.saturating_add(written));
                return Ok(());
            }
            Err(EncodeError::InsufficientSize(InsufficientSizeError { required_size }))
                if required_size > room =>
            {
                room = required_size;
            }
            Err(err) => {
                out.truncate(start);
                return Err(io::Error::other(format!("{err:?}")));
            }
        }
    }
}

/// Encrypt application data or a close_notify at the end of `out`, growing it as
/// rustls asks.
fn encrypt_into(
    out: &mut Vec<u8>,
    hint: usize,
    mut encrypt: impl FnMut(&mut [u8]) -> Result<usize, EncryptError>,
) -> io::Result<()> {
    let start = out.len();
    let mut room = hint.saturating_add(1024);
    loop {
        out.resize(start.saturating_add(room), 0);
        match encrypt(out.get_mut(start..).unwrap_or(&mut [])) {
            Ok(written) => {
                out.truncate(start.saturating_add(written));
                return Ok(());
            }
            Err(EncryptError::InsufficientSize(InsufficientSizeError { required_size }))
                if required_size > room =>
            {
                room = required_size;
            }
            Err(err) => {
                out.truncate(start);
                return Err(io::Error::other(format!("{err:?}")));
            }
        }
    }
}
