//! Connection takeover: a handler claims the connection once its response head is
//! written, to switch protocols or to stream a body.
//!
//! [`Call::upgrade`](crate::Call::upgrade) answers `101 Switching Protocols` with the
//! `Upgrade` field and the `upgrade` connection option, after which "the data stream
//! switches" to the new protocol (RFC 9110 Section 7.8). The server "MUST NOT switch
//! to a protocol that was not indicated by the client", so the protocol must be one
//! the request's `Upgrade` field lists, and a request that expected `100-continue`
//! gets the 100 before the 101. Any bytes that arrived after the request head belong
//! to the new protocol and are handed over with the connection; no further HTTP
//! request is parsed once an upgrade is asked for, and reading pauses until the
//! handler decides.
//!
//! [`Call::stream`](crate::Call::stream) writes the head without `Content-Length` and
//! with `Connection: close`, so the body is "determined by the number of octets
//! received prior to the server closing the connection" (RFC 9112 Section 6.3, item
//! 8), and the handler writes it as it is produced. Requests pipelined after a
//! claimed one are dropped unanswered, as the connection ends with the claim.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-7.8>
//! @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3>

use std::io::{self, IoSlice};
use std::rc::Rc;

use zero_io::rt::Core;
use zero_io::seam::Stream;
use zero_rt::Worker;

use crate::call::Request;
use crate::record::Record;

/// How a handler claims its connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TakeOver {
    /// The connection switched protocols after a `101`.
    Upgrade,
    /// The response body is streamed until the connection closes.
    Stream,
}

/// A claim recorded on the request, honored when its head is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Claim {
    pub(crate) kind: TakeOver,
    pub(crate) token: u64,
}

/// A claimed connection, handed to [`Handler::taken`](crate::Handler::taken) once the
/// response head is written.
pub struct Taken<S> {
    stream: Rc<S>,
    leftover: Vec<u8>,
    record: Box<Record>,
    worker: Worker,
    claim: Claim,
}

impl<S> std::fmt::Debug for Taken<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Taken")
            .field("kind", &self.claim.kind)
            .field("token", &self.claim.token)
            .field("leftover", &self.leftover.len())
            .finish_non_exhaustive()
    }
}

impl<S: Stream> Taken<S> {
    pub(crate) fn new(
        stream: Rc<S>,
        leftover: Vec<u8>,
        record: Box<Record>,
        worker: Worker,
        claim: Claim,
    ) -> Self {
        Taken {
            stream,
            leftover,
            record,
            worker,
            claim,
        }
    }

    /// How the connection was claimed.
    #[must_use]
    pub const fn kind(&self) -> TakeOver {
        self.claim.kind
    }

    /// The token the handler gave when it claimed the connection, to tell its
    /// claims apart.
    #[must_use]
    pub const fn token(&self) -> u64 {
        self.claim.token
    }

    /// The request that claimed the connection.
    #[must_use]
    pub fn request(&self) -> Request<'_> {
        Request::of(&self.record)
    }

    /// Take the bytes that arrived after the request head, which belong to the new
    /// protocol; empty after the first call.
    pub fn take_leftover(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.leftover)
    }

    /// The connection.
    #[must_use]
    pub fn stream(&self) -> &S {
        &self.stream
    }

    /// The worker the connection runs on.
    #[must_use]
    pub const fn worker(&self) -> &Worker {
        &self.worker
    }

    /// The core the connection runs on: its timer, pool and shutdown signal.
    #[must_use]
    pub const fn core(&self) -> &Core {
        self.worker.core()
    }

    /// Write all of `bytes`.
    ///
    /// If this future is dropped, an unknown part of `bytes` may already be committed
    /// to the connection, so nothing else may be written after it: close the
    /// connection. A caller that races its writes against other events keeps them
    /// going through [`stream`](Self::stream) with `writev`, passing the same bytes
    /// again after a dropped call, as the seam's `Stream` requires.
    ///
    /// # Arguments
    ///
    /// * `bytes` - what to write.
    ///
    /// # Errors
    ///
    /// The operating system's error, or `WriteZero` when the connection took
    /// nothing.
    pub async fn write_all(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let written = self.stream.writev(&[IoSlice::new(bytes)]).await?;
            if written == 0 {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            bytes = bytes.get(written..).unwrap_or(&[]);
        }
        Ok(())
    }
}
