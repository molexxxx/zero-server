//! WebSocket connections over the HTTP/1.1 driver.
//!
//! [`accept`] answers a handshake from a handler: it checks the request with
//! `zero-ws`, and either claims the connection with `101 Switching Protocols` and the
//! accept value, or writes the refusal (400, 403, or 426 with `Upgrade: websocket`
//! and `Sec-WebSocket-Version: 13`). [`WebSocket`] serves the claimed connection in
//! [`Handler::taken`](zero_http::Handler::taken): the bytes that arrived after the
//! request head are the first input, so a frame sent with the handshake is not lost;
//! [`WebSocket::recv`] answers pings, completes the closing handshake, sends 1001
//! Going Away when the server drains, and returns each whole message; and once a
//! Close went out nothing more is sent.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.1>

use std::future::{poll_fn, Future};
use std::pin::pin;
use std::rc::Rc;
use std::task::Poll;
use std::time::{Duration, Instant};

use zero_core::{Error, Result};
use zero_http::{Call, Request, Taken};
use zero_http1::Version;
use zero_io::seam::{Leased, Shutdown, Stream, Timer};
use zero_limits::WebSocketLimits;
use zero_server_crypto::Sha1;
use zero_ws::handshake::{self, Config, Reason};
use zero_ws::session::{Event, Session};
use zero_ws::CloseCode;

/// The protocol name a WebSocket upgrade switches to.
pub const PROTOCOL: &[u8] = b"websocket";

/// How long the server waits for the peer's Close once it sent its own, before it
/// closes the connection anyway.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a read waits when the core's buffer pool has no budget.
const BUDGET_RETRY: Duration = Duration::from_millis(1);

/// Answer a WebSocket handshake.
///
/// # Arguments
///
/// * `call` - the request.
/// * `config` - the subprotocols and origins the server accepts.
/// * `token` - handed back with the connection by
///   [`Taken::token`](zero_http::Taken::token).
///
/// # Returns
///
/// `true` when the connection is claimed and a `101` goes out; `false` when the
/// response carries the refusal.
///
/// # Errors
///
/// The digest's error, or a field the response refuses.
pub fn accept(call: &mut Call<'_>, config: &Config<'_>, token: u64) -> Result<bool> {
    let decided = {
        let request = call.request();
        let http11 = request.version() != Version::Http10;
        match handshake::negotiate(request.method(), http11, request.headers(), config) {
            Ok(accepted) => Ok(accepted.response_fields(&Sha1)?),
            Err(refusal) => Err(refusal),
        }
    };
    match decided {
        Ok(fields) => {
            call.upgrade(PROTOCOL, token)?;
            for (name, value) in fields.iter() {
                if !name.eq_ignore_ascii_case(b"upgrade")
                    && !name.eq_ignore_ascii_case(b"connection")
                {
                    call.response().header(name, value)?;
                }
            }
            Ok(true)
        }
        Err(refusal) => {
            if refusal.reason == Reason::Version {
                call.upgrade_required(PROTOCOL)?;
            } else {
                call.response().status(refusal.status);
            }
            for (name, value) in refusal.fields {
                call.response().header(name, value)?;
            }
            Ok(false)
        }
    }
}

/// A whole message, as the application receives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    /// A text message.
    Text(String),
    /// A binary message.
    Binary(Vec<u8>),
}

/// What one read produced.
enum Read {
    Data,
    Done,
    Shutdown,
}

/// The first of two futures to finish.
enum Either<A, B> {
    Left(A),
    Right(B),
}

async fn race<A: Future, B: Future>(a: A, b: B) -> Either<A::Output, B::Output> {
    let mut a = pin!(a);
    let mut b = pin!(b);
    poll_fn(|cx| {
        if let Poll::Ready(value) = a.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(value));
        }
        if let Poll::Ready(value) = b.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(value));
        }
        Poll::Pending
    })
    .await
}

/// A server-side WebSocket connection.
pub struct WebSocket<S> {
    taken: Taken<S>,
    session: Session,
    input: Vec<u8>,
    start: usize,
    started: Instant,
    closing: bool,
}

impl<S> std::fmt::Debug for WebSocket<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebSocket")
            .field("session", &self.session)
            .field("closing", &self.closing)
            .finish_non_exhaustive()
    }
}

impl<S: Stream + 'static> WebSocket<S> {
    /// Serve a connection [`accept`] claimed.
    ///
    /// # Arguments
    ///
    /// * `taken` - the connection from [`Handler::taken`](zero_http::Handler::taken).
    /// * `limits` - the message size, fragment and control-frame limits.
    #[must_use]
    pub fn new(mut taken: Taken<S>, limits: WebSocketLimits) -> Self {
        let input = taken.take_leftover();
        WebSocket {
            taken,
            session: Session::new(limits),
            input,
            start: 0,
            started: Instant::now(),
            closing: false,
        }
    }

    /// The handshake request.
    #[must_use]
    pub fn request(&self) -> Request<'_> {
        self.taken.request()
    }

    /// The token given to [`accept`].
    #[must_use]
    pub const fn token(&self) -> u64 {
        self.taken.token()
    }

    /// The status code of the peer's Close, once one arrived.
    #[must_use]
    pub fn close_code(&self) -> Option<CloseCode> {
        self.session.close_code()
    }

    /// The next whole message.
    ///
    /// # Returns
    ///
    /// The message, or `None` once the connection is done: the closing handshake
    /// completed, the peer failed the protocol, the connection dropped, or the
    /// server drained.
    pub async fn recv(&mut self) -> Option<Message> {
        loop {
            if !self.flush().await || self.session.is_finished() {
                return None;
            }
            if self.start < self.input.len() {
                let now = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
                let rest = self.input.get_mut(self.start..).unwrap_or(&mut []);
                let fed = self.session.feed(rest, now).map(|step| {
                    let message = match step.event {
                        Some(Event::Text(text)) => Some(Message::Text(text.to_owned())),
                        Some(Event::Binary(data)) => Some(Message::Binary(data.to_vec())),
                        _ => None,
                    };
                    (step.consumed, step.event.is_some(), message)
                });
                match fed {
                    Ok((consumed, evented, message)) => {
                        self.start = self.start.saturating_add(consumed);
                        if let Some(message) = message {
                            return Some(message);
                        }
                        if evented || consumed > 0 {
                            continue;
                        }
                    }
                    Err(_) => continue,
                }
            }
            self.input.drain(..self.start.min(self.input.len()));
            self.start = 0;
            match self.read().await {
                Read::Data => {}
                Read::Done => return None,
                Read::Shutdown => {
                    if self.session.going_away().is_ok() {
                        self.closing = true;
                    }
                }
            }
        }
    }

    /// Send a text message.
    ///
    /// # Arguments
    ///
    /// * `text` - the message.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent or the connection is done;
    /// [`Error::Io`] when the write fails.
    pub async fn send_text(&mut self, text: &str) -> Result<()> {
        self.session.send_text(text)?;
        self.flush_or_fail().await
    }

    /// Send a binary message.
    ///
    /// # Arguments
    ///
    /// * `data` - the message.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent or the connection is done;
    /// [`Error::Io`] when the write fails.
    pub async fn send_binary(&mut self, data: &[u8]) -> Result<()> {
        self.session.send_binary(data)?;
        self.flush_or_fail().await
    }

    /// Start the closing handshake; [`recv`](Self::recv) then waits up to
    /// [`CLOSE_TIMEOUT`] for the peer's Close.
    ///
    /// # Arguments
    ///
    /// * `code` - the status code, or [`CloseCode::NO_STATUS`] for none.
    /// * `reason` - the reason, at most 123 bytes.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent; [`Error::Protocol`] for a code that
    /// may not be sent or a reason that does not fit; [`Error::Io`] when the write
    /// fails.
    pub async fn close(&mut self, code: CloseCode, reason: &str) -> Result<()> {
        self.session.close(code, reason)?;
        self.closing = true;
        self.flush_or_fail().await
    }

    /// Write what the session queued.
    ///
    /// # Returns
    ///
    /// Whether the write succeeded.
    async fn flush(&mut self) -> bool {
        let pending = self.session.output();
        if pending.is_empty() {
            return true;
        }
        let len = pending.len();
        if self.taken.write_all(pending).await.is_err() {
            return false;
        }
        self.session.consume_output(len);
        true
    }

    async fn flush_or_fail(&mut self) -> Result<()> {
        if self.flush().await {
            Ok(())
        } else {
            Err(Error::Io("the WebSocket connection dropped".to_owned()))
        }
    }

    /// Read more input, or notice the shutdown signal.
    async fn read(&mut self) -> Read {
        let core = self.taken.core();
        let pool = Rc::clone(&core.pool);
        let outcome = if self.closing {
            match core
                .timeout(CLOSE_TIMEOUT, self.taken.stream().read_leased(&pool))
                .await
            {
                Ok(outcome) => Either::Left(outcome),
                Err(_) => return Read::Done,
            }
        } else {
            race(
                self.taken.stream().read_leased(&pool),
                self.taken.worker().shutdown().requested(),
            )
            .await
        };
        match outcome {
            Either::Left(Ok(Leased::Data(buf))) => {
                self.input.extend_from_slice(buf.filled());
                pool.release(buf);
                Read::Data
            }
            Either::Left(Ok(Leased::NoBudget)) => {
                core.sleep(BUDGET_RETRY).await;
                Read::Data
            }
            Either::Left(Ok(Leased::Eof) | Err(_)) => Read::Done,
            Either::Right(()) => Read::Shutdown,
        }
    }
}
