//! The TLS listener: the [`Accept`] that turns each TCP connection into a TLS
//! session before the HTTP driver serves it.
//!
//! The client's hello is read first, through rustls's `Acceptor`, and the server
//! name it carries picks the identity. A name the listener does not serve is refused
//! with a fatal `unrecognized_name` alert (RFC 9325 Section 3.7), and a hello without a
//! name when no default identity exists with a fatal `missing_extension` alert (RFC
//! 9846 Section 9.2); rustls itself would answer both with `access_denied`. Otherwise
//! the hello starts the chosen driver's handshake, and the connection serves only the
//! names of its identity.
//!
//! The handshake runs under the handshake timeout, from the first byte to the last
//! record of the server's final flight, so a client cannot hold a handshake open
//! before the HTTP header timeout starts. A session that runs out of time sends
//! `close_notify` before its transport closes (RFC 9846 Section 6.1), which the
//! buffered driver can do at any point of the handshake; rustls's unbuffered state
//! machine offers no way to queue an alert until the handshake completes, so on that
//! driver a timed-out handshake only closes the transport. Each core counts its handshakes in
//! progress; at the limit it stops accepting, the kernel's backlog holds the rest, and
//! a connection accepted just as the limit was reached waits until a handshake ends.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9325.html#section-3.7>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-9.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9846.html#section-6.1>
//! @see <https://docs.rs/rustls/0.23.45/rustls/server/struct.Acceptor.html>

use std::cell::Cell;
use std::future::Future;
use std::io::{self, IoSlice};
use std::net::SocketAddr;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rustls::server::Acceptor;
use rustls::ServerConfig;
use zero_core::OwnedBuf;
use zero_http::{Accept, Prepared};
use zero_io::pool::Pool;
use zero_io::rt::TcpStream;
use zero_io::seam::{Leased, Stream, Timer};
use zero_limits::TlsLimits;
use zero_rt::Worker;

use crate::buffered::{tls_error, BufferedStream};
use crate::config::Driver;
use crate::identity::{Choice, Identities};
use crate::unbuffered::UnbufferedStream;

/// The largest hello the listener reads before it gives up: one handshake message
/// of the protocol's maximum length and its record headers.
const MAX_HELLO: usize = (1 << 16) + 1024;

/// How long a handshake that timed out may take to send its `close_notify`.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// The alert description `unrecognized_name` (RFC 9846 Section 6.2).
pub(crate) const UNRECOGNIZED_NAME: u8 = 112;

/// The alert description `missing_extension` (RFC 9846 Section 6.2).
pub(crate) const MISSING_EXTENSION: u8 = 109;

/// A fatal alert record, sent in the clear before any key exists, with the record
/// version 0x0303 that RFC 9846 Section 5.1 sets for every record but the first hello.
pub(crate) const fn fatal_alert(description: u8) -> [u8; 7] {
    [0x15, 0x03, 0x03, 0x00, 0x02, 0x02, description]
}

/// A TLS session served by either driver.
#[derive(Debug)]
pub enum TlsStream<S> {
    /// The buffered driver.
    Buffered(BufferedStream<S>),
    /// The unbuffered driver.
    Unbuffered(UnbufferedStream<S>),
}

impl<S: Stream> TlsStream<S> {
    /// Complete the handshake.
    async fn handshake(&self, pool: &Pool) -> io::Result<()> {
        match self {
            TlsStream::Buffered(stream) => stream.handshake(pool).await,
            TlsStream::Unbuffered(stream) => stream.handshake(pool).await,
        }
    }
}

impl<S: Stream> Stream for TlsStream<S> {
    async fn readable(&self) -> io::Result<()> {
        match self {
            TlsStream::Buffered(stream) => stream.readable().await,
            TlsStream::Unbuffered(stream) => stream.readable().await,
        }
    }

    async fn read_leased(&self, pool: &Pool) -> io::Result<Leased> {
        match self {
            TlsStream::Buffered(stream) => stream.read_leased(pool).await,
            TlsStream::Unbuffered(stream) => stream.read_leased(pool).await,
        }
    }

    async fn read_into(&self, buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        match self {
            TlsStream::Buffered(stream) => stream.read_into(buf).await,
            TlsStream::Unbuffered(stream) => stream.read_into(buf).await,
        }
    }

    async fn write(&self, buf: OwnedBuf) -> (io::Result<usize>, OwnedBuf) {
        match self {
            TlsStream::Buffered(stream) => stream.write(buf).await,
            TlsStream::Unbuffered(stream) => stream.write(buf).await,
        }
    }

    async fn writev(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        match self {
            TlsStream::Buffered(stream) => stream.writev(bufs).await,
            TlsStream::Unbuffered(stream) => stream.writev(bufs).await,
        }
    }

    fn shutdown_write(&self) -> io::Result<()> {
        match self {
            TlsStream::Buffered(stream) => stream.shutdown_write(),
            TlsStream::Unbuffered(stream) => stream.shutdown_write(),
        }
    }

    async fn close_write(&self) -> io::Result<()> {
        match self {
            TlsStream::Buffered(stream) => stream.close_write().await,
            TlsStream::Unbuffered(stream) => stream.close_write().await,
        }
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        match self {
            TlsStream::Buffered(stream) => stream.peer_addr(),
            TlsStream::Unbuffered(stream) => stream.peer_addr(),
        }
    }
}

/// What the hello asked for.
pub(crate) enum Hello {
    /// The server name, if any, and every byte read so far.
    Read(Option<String>, Vec<u8>),
    /// The hello was refused; the alert to send.
    Refused(Vec<u8>, rustls::Error),
}

/// Feed bytes to an acceptor until it has a whole hello.
///
/// # Returns
///
/// The server name when the hello is complete, `None` while it is not.
pub(crate) fn inspect(
    acceptor: &mut Acceptor,
    bytes: &[u8],
) -> Result<Option<Option<String>>, (Vec<u8>, rustls::Error)> {
    let mut rest = bytes;
    while !rest.is_empty() {
        match acceptor.read_tls(&mut rest) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    match acceptor.accept() {
        Ok(Some(accepted)) => Ok(Some(
            accepted.client_hello().server_name().map(str::to_owned),
        )),
        Ok(None) => Ok(None),
        Err((err, mut alert)) => {
            let mut record = Vec::new();
            let _ = alert.write_all(&mut record);
            Err((record, err))
        }
    }
}

/// Read the client's hello.
async fn read_hello<S: Stream>(stream: &S, pool: &Pool) -> io::Result<Hello> {
    let mut acceptor = Acceptor::default();
    let mut bytes = Vec::new();
    loop {
        match stream.read_leased(pool).await? {
            Leased::Data(buf) => {
                let start = bytes.len();
                bytes.extend_from_slice(buf.filled());
                pool.release(buf);
                match inspect(&mut acceptor, bytes.get(start..).unwrap_or(&[])) {
                    Ok(Some(name)) => return Ok(Hello::Read(name, bytes)),
                    Ok(None) => {}
                    Err((record, err)) => return Ok(Hello::Refused(record, err)),
                }
                if bytes.len() > MAX_HELLO {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the client hello is larger than one handshake message",
                    ));
                }
            }
            Leased::Eof => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Leased::NoBudget => return Err(io::Error::from(io::ErrorKind::OutOfMemory)),
        }
    }
}

/// Send a refusal and report it.
async fn refuse<S: Stream>(stream: &S, record: &[u8], reason: io::Error) -> io::Error {
    let _ = stream.writev(&[IoSlice::new(record)]).await;
    let _ = stream.close_write().await;
    reason
}

/// Counts one handshake in progress while it lives.
struct Slot(Rc<TlsAccept>);

impl Slot {
    fn enter(listener: Rc<TlsAccept>) -> Self {
        listener
            .in_progress
            .set(listener.in_progress.get().saturating_add(1));
        Slot(listener)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0
            .in_progress
            .set(self.0.in_progress.get().saturating_sub(1));
    }
}

/// The per-core TLS listener.
#[derive(Debug)]
pub struct TlsAccept {
    identities: Arc<Identities>,
    config: Arc<ServerConfig>,
    worker: Worker,
    limits: TlsLimits,
    driver: Driver,
    in_progress: Cell<usize>,
}

impl TlsAccept {
    /// The listener for one core.
    ///
    /// # Arguments
    ///
    /// * `identities` - the identities the server names pick from.
    /// * `config` - the config from [`server_config`](crate::server_config) over the
    ///   same identities.
    /// * `worker` - the core's worker.
    /// * `limits` - the handshake timeout and the per-core limit.
    /// * `driver` - the TLS driver.
    #[must_use]
    pub fn new(
        identities: Arc<Identities>,
        config: Arc<ServerConfig>,
        worker: Worker,
        limits: TlsLimits,
        driver: Driver,
    ) -> Self {
        TlsAccept {
            identities,
            config,
            worker,
            limits,
            driver,
            in_progress: Cell::new(0),
        }
    }

    /// How many handshakes are in progress on this core.
    #[must_use]
    pub fn in_progress(&self) -> usize {
        self.in_progress.get()
    }

    /// Read the hello, pick the identity and start the session; the handshake itself
    /// is left to the caller.
    async fn open(
        &self,
        stream: TcpStream,
        pool: &Pool,
    ) -> io::Result<(TlsStream<TcpStream>, Arc<[Box<str>]>)> {
        let (name, first) = match read_hello(&stream, pool).await? {
            Hello::Read(name, first) => (name, first),
            Hello::Refused(record, err) => {
                return Err(refuse(&stream, &record, tls_error(err)).await)
            }
        };
        let identity = match self.identities.choose(name.as_deref()) {
            Choice::Serve(identity) => identity,
            Choice::Unrecognized => {
                let reason =
                    io::Error::new(io::ErrorKind::InvalidData, "an unrecognized server name");
                return Err(refuse(&stream, &fatal_alert(UNRECOGNIZED_NAME), reason).await);
            }
            Choice::Missing => {
                let reason = io::Error::new(
                    io::ErrorKind::InvalidData,
                    "no server name and no default identity",
                );
                return Err(refuse(&stream, &fatal_alert(MISSING_EXTENSION), reason).await);
            }
        };
        let session = match self.driver {
            Driver::Buffered => TlsStream::Buffered(BufferedStream::new(
                stream,
                Arc::clone(&self.config),
                first,
            )?),
            Driver::Unbuffered => TlsStream::Unbuffered(UnbufferedStream::new(
                stream,
                Arc::clone(&self.config),
                first,
            )?),
        };
        Ok((session, Arc::clone(identity.names())))
    }
}

impl Accept for TlsAccept {
    type Stream = TlsStream<TcpStream>;

    fn secure(&self) -> bool {
        true
    }

    fn saturated(&self) -> bool {
        self.in_progress.get() >= self.limits.max_handshakes_per_core
    }

    fn accept(
        self: Rc<Self>,
        stream: TcpStream,
        _peer: SocketAddr,
    ) -> impl Future<Output = io::Result<Prepared<Self::Stream>>> + 'static {
        let slot = Slot::enter(Rc::clone(&self));
        async move {
            let _slot = slot;
            let core = self.worker.core();
            let pool = Rc::clone(&core.pool);
            let limit = self.limits.handshake_timeout;
            let started = Instant::now();
            let (session, authorities) = core
                .timeout(limit, self.open(stream, &pool))
                .await
                .map_err(|_| timed_out())??;
            let left = limit.saturating_sub(started.elapsed());
            match core.timeout(left, session.handshake(&pool)).await {
                Ok(Ok(())) => Ok(Prepared {
                    stream: session,
                    authorities: Some(authorities),
                }),
                Ok(Err(err)) => Err(err),
                Err(_) => {
                    let _ = core.timeout(CLOSE_GRACE, session.close_write()).await;
                    Err(timed_out())
                }
            }
        }
    }
}

/// The error of a handshake that ran out of time.
fn timed_out() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "the TLS handshake did not finish in time",
    )
}
