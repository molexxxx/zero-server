//! Server-sent event streams over the HTTP/1.1 driver.
//!
//! [`start`] answers a request with the event stream fields and claims the
//! connection for a streamed body, which on HTTP/1.1 is close-delimited, so every
//! write reaches the client as it is made rather than when a chunking layer decides
//! (WHATWG HTML, Section 9.2.7). [`EventStream`] writes events and, while the
//! application waits for the next one, a `:` comment whenever nothing was written for
//! the keep-alive interval. It exposes the `Last-Event-ID` a reconnecting client sent
//! (Section 9.2.4), and [`stop_reconnecting`] answers 204, which tells a client not
//! to reconnect (Section 9.2.1).
//!
//! A stream that other threads send on gets an [`Outbox`] with
//! [`EventStream::with_outbox`]: its waits then also write the events the outbox
//! holds, in the order they were pushed, and [`EventStream::serve`] runs such a
//! stream, reporting [`Drained`] after the outbox passed its high-water mark. When
//! the server drains, the stream writes what the outbox still holds and ends.
//!
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html>

use std::convert::Infallible;
use std::future::{poll_fn, Future};
use std::io::{self, IoSlice};
use std::pin::{pin, Pin};
use std::rc::Rc;
use std::sync::Arc;
use std::task::Poll;
use std::time::{Duration, Instant};

use zero_core::{Error, Result};
use zero_http::{Call, Request, Taken};
use zero_io::seam::{Leased, Shutdown, Stream, Timer};
use zero_sse::{
    comment, encode, last_event_id, Event, KeepAlive, KEEP_ALIVE_COMMENT, RESPONSE_FIELDS,
    STOP_RECONNECTING,
};

use crate::outbox::{Attached, Command, Drained, Outbox};

pub use zero_sse::KEEP_ALIVE_MS;

/// How long a wait pauses when the core's buffer pool has no budget.
const BUDGET_RETRY: Duration = Duration::from_millis(1);

/// Answer with an event stream: the stream fields, then the connection is claimed and
/// [`Handler::taken`](zero_http::Handler::taken) writes the events.
///
/// # Arguments
///
/// * `call` - the request.
/// * `token` - handed back with the connection by
///   [`Taken::token`](zero_http::Taken::token).
///
/// # Errors
///
/// [`Error::Protocol`] for a HEAD request.
pub fn start(call: &mut Call<'_>, token: u64) -> Result<()> {
    for (name, value) in RESPONSE_FIELDS {
        call.response().header(name, value)?;
    }
    call.stream(token)
}

/// Answer `204 No Content`, which tells an `EventSource` client to stop
/// reconnecting.
///
/// # Arguments
///
/// * `call` - the request.
pub fn stop_reconnecting(call: &mut Call<'_>) {
    call.response().status(STOP_RECONNECTING);
}

/// What woke a wait.
enum Woke<T> {
    Done(T),
    Due,
    Read(std::io::Result<Leased>),
    Shutdown,
    Outbox,
}

/// What one turn of a wait produced.
enum Turn<T> {
    Done(T),
    Drained,
    Ended,
}

/// An event stream on a claimed connection.
pub struct EventStream<S> {
    taken: Taken<S>,
    keep_alive: KeepAlive,
    started: Instant,
    buffer: Vec<u8>,
    /// How much of `buffer` the connection took; a write whose future was dropped
    /// leaves the rest, which the next write sends first.
    written: usize,
    outbox: Option<Attached>,
    /// Octets of outbox commands applied and not yet written.
    unreleased: u64,
    drained: bool,
    /// The stream is over: an End was applied, the client went away, or the server
    /// drains.
    ended: bool,
}

impl<S> std::fmt::Debug for EventStream<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventStream")
            .field("keep_alive", &self.keep_alive)
            .finish_non_exhaustive()
    }
}

impl<S: Stream + 'static> EventStream<S> {
    /// Serve a connection [`start`] claimed.
    ///
    /// # Arguments
    ///
    /// * `taken` - the connection from [`Handler::taken`](zero_http::Handler::taken).
    /// * `keep_alive_ms` - the keep-alive interval, [`KEEP_ALIVE_MS`] by default.
    #[must_use]
    pub fn new(taken: Taken<S>, keep_alive_ms: u64) -> Self {
        EventStream {
            taken,
            keep_alive: KeepAlive::new(keep_alive_ms, 0),
            started: Instant::now(),
            buffer: Vec::new(),
            written: 0,
            outbox: None,
            unreleased: 0,
            drained: false,
            ended: false,
        }
    }

    /// Write the events other threads push to `outbox` while the stream waits. A
    /// [`Command::End`] ends the stream once what was pushed before it is written,
    /// and so do [`Command::Terminate`] and [`Command::Close`]; Join and Leave do
    /// nothing on an event stream.
    ///
    /// # Arguments
    ///
    /// * `outbox` - the stream's outbox; it closes when this stream is dropped.
    ///
    /// # Returns
    ///
    /// The stream.
    #[must_use]
    pub fn with_outbox(mut self, outbox: Arc<Outbox>) -> Self {
        self.outbox = Some(Attached::new(outbox));
        self
    }

    /// The request that opened the stream.
    #[must_use]
    pub fn request(&self) -> Request<'_> {
        self.taken.request()
    }

    /// The id a reconnecting client resumes from, from its `Last-Event-ID` header.
    #[must_use]
    pub fn last_event_id(&self) -> Option<&str> {
        self.taken
            .request()
            .header(b"last-event-id")
            .and_then(last_event_id)
    }

    /// Write one event.
    ///
    /// # Arguments
    ///
    /// * `event` - the event.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] for a field the encoder refuses; [`Error::Io`] when the
    /// write fails.
    pub async fn send(&mut self, event: &Event<'_>) -> Result<()> {
        self.write_buffer().await?;
        self.restart();
        encode(event, &mut self.buffer)?;
        self.write_buffer().await
    }

    /// Write an event or comment already encoded with [`zero_sse::encode()`] or
    /// [`zero_sse::comment()`], such as one encoded once for many streams or on
    /// another thread.
    ///
    /// # Arguments
    ///
    /// * `event` - the encoded event, ending with its blank line.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when the write fails.
    pub async fn send_encoded(&mut self, event: &[u8]) -> Result<()> {
        self.write_buffer().await?;
        self.restart();
        self.buffer.extend_from_slice(event);
        self.write_buffer().await
    }

    /// Write a comment, which the client ignores: one comment line per line of
    /// `text`.
    ///
    /// # Arguments
    ///
    /// * `text` - the comment; split at CRLF, LF and CR.
    ///
    /// # Errors
    ///
    /// [`Error::Io`] when the write fails.
    pub async fn comment(&mut self, text: &str) -> Result<()> {
        self.write_buffer().await?;
        self.restart();
        comment(text, &mut self.buffer)?;
        self.write_buffer().await
    }

    /// Run `future` while keeping the stream alive: a keep-alive comment goes out
    /// whenever nothing was written for the interval, and what the outbox holds is
    /// written as it arrives.
    ///
    /// # Arguments
    ///
    /// * `future` - what the application waits for, such as its next event.
    ///
    /// # Returns
    ///
    /// The future's output.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] when the client went away, the server drains, or the outbox
    /// ended the stream; the future is dropped then. [`Error::Io`] when a write
    /// fails.
    pub async fn wait<F: Future>(&mut self, future: F) -> Result<F::Output> {
        let mut future = pin!(future);
        loop {
            match self.turn(future.as_mut()).await? {
                Turn::Done(value) => return Ok(value),
                Turn::Drained => {}
                Turn::Ended => return Err(Error::Closed),
            }
        }
    }

    /// Serve the outbox until the stream ends: write what other threads push, keep
    /// the stream alive with comments, and notice the client leaving and the server
    /// draining.
    ///
    /// # Returns
    ///
    /// [`Drained`] when the outbox fell below half its high-water mark after passing
    /// it; `None` once the stream is over, after writing what the outbox held: an End
    /// was applied, the client went away, a write failed, or the server drains. The
    /// outbox is closed then.
    pub async fn serve(&mut self) -> Option<Drained> {
        let mut idle = pin!(std::future::pending::<Infallible>());
        match self.turn(idle.as_mut()).await {
            Ok(Turn::Drained) => Some(Drained),
            Ok(Turn::Done(never)) => match never {},
            Ok(Turn::Ended) | Err(_) => {
                self.finish();
                None
            }
        }
    }

    /// Wait for `future`, the keep-alive deadline, the outbox, the client and the
    /// shutdown signal, writing what is due, until one of them settles the turn.
    async fn turn<F: Future>(&mut self, mut future: Pin<&mut F>) -> Result<Turn<F::Output>> {
        loop {
            self.pour(false).await?;
            if std::mem::take(&mut self.drained) {
                return Ok(Turn::Drained);
            }
            if self.ended {
                return Ok(Turn::Ended);
            }
            let now = self.now_ms();
            if self.keep_alive.is_due(now) {
                self.write_buffer().await?;
                self.restart();
                self.buffer.extend_from_slice(KEEP_ALIVE_COMMENT);
                self.write_buffer().await?;
                continue;
            }
            let pause = Duration::from_millis(self.keep_alive.deadline().saturating_sub(now));
            let core = self.taken.core();
            let pool = Rc::clone(&core.pool);
            let woke = {
                let outbox = self.outbox.as_deref();
                let mut sleep = pin!(core.sleep(pause));
                let mut read = pin!(self.taken.stream().read_leased(&pool));
                let mut shutdown = pin!(self.taken.worker().shutdown().requested());
                poll_fn(|cx| {
                    if let Poll::Ready(value) = future.as_mut().poll(cx) {
                        return Poll::Ready(Woke::Done(value));
                    }
                    if shutdown.as_mut().poll(cx).is_ready() {
                        return Poll::Ready(Woke::Shutdown);
                    }
                    if outbox.is_some_and(|outbox| outbox.poll_ready(cx).is_ready()) {
                        return Poll::Ready(Woke::Outbox);
                    }
                    if let Poll::Ready(outcome) = read.as_mut().poll(cx) {
                        return Poll::Ready(Woke::Read(outcome));
                    }
                    if sleep.as_mut().poll(cx).is_ready() {
                        return Poll::Ready(Woke::Due);
                    }
                    Poll::Pending
                })
                .await
            };
            match woke {
                Woke::Done(value) => return Ok(Turn::Done(value)),
                Woke::Due | Woke::Outbox => {}
                Woke::Read(Ok(Leased::Data(buf))) => pool.release(buf),
                Woke::Read(Ok(Leased::NoBudget)) => core.sleep(BUDGET_RETRY).await,
                Woke::Read(Ok(Leased::Eof) | Err(_)) => {
                    self.ended = true;
                    self.finish();
                }
                Woke::Shutdown => {
                    self.pour(true).await?;
                    self.ended = true;
                }
            }
        }
    }

    /// Write what the outbox holds, in the order it was pushed; with `seal`, refuse
    /// later pushes first, so nothing pushed before is left behind. The commands
    /// move into the buffer before anything is awaited, so a wait whose future is
    /// dropped loses none of them.
    async fn pour(&mut self, seal: bool) -> Result<()> {
        if self.outbox.is_none() {
            return Ok(());
        }
        self.write_buffer().await?;
        let commands = match self.outbox.as_deref() {
            Some(outbox) if seal => outbox.seal(),
            Some(outbox) => outbox.take(),
            None => return Ok(()),
        };
        if !commands.is_empty() {
            self.restart();
            for command in commands {
                self.unreleased = self.unreleased.saturating_add(command.octets());
                if self.ended {
                    continue;
                }
                match command {
                    Command::Frame(frame) => self.buffer.extend_from_slice(&frame),
                    Command::End | Command::Terminate | Command::Close { .. } => {
                        self.ended = true;
                    }
                    Command::Join(_) | Command::Leave(_) => {}
                }
            }
        }
        self.write_buffer().await?;
        let octets = std::mem::take(&mut self.unreleased);
        if octets > 0
            && self
                .outbox
                .as_deref()
                .is_some_and(|outbox| outbox.release(octets))
        {
            self.drained = true;
        }
        Ok(())
    }

    /// Close the outbox once nothing more will be written.
    fn finish(&self) {
        if let Some(outbox) = self.outbox.as_deref() {
            outbox.close();
        }
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Empty the buffer for the next message, which the previous one has left.
    fn restart(&mut self) {
        self.buffer.clear();
        self.written = 0;
    }

    /// Write what the buffer still holds, counting each part once the connection
    /// took it, so a write whose future is dropped resumes with the same bytes.
    async fn write_buffer(&mut self) -> Result<()> {
        if self.written >= self.buffer.len() {
            return Ok(());
        }
        while let Some(rest) = self
            .buffer
            .get(self.written..)
            .filter(|rest| !rest.is_empty())
        {
            let written = self
                .taken
                .stream()
                .writev(&[IoSlice::new(rest)])
                .await
                .map_err(|err| Error::Io(err.to_string()))?;
            if written == 0 {
                return Err(Error::Io(
                    io::Error::from(io::ErrorKind::WriteZero).to_string(),
                ));
            }
            self.written = self.written.saturating_add(written);
        }
        let now = self.now_ms();
        self.keep_alive.wrote(now);
        Ok(())
    }
}
