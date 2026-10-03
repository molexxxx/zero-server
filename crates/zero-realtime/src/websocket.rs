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
//! A connection that other threads send on gets an [`Outbox`] with
//! [`WebSocket::with_outbox`]. Its read wait then also takes the outbox's commands,
//! applied in the order they were pushed, and [`WebSocket::recv_event`] reports pongs
//! and [`Drained`](Incoming::Drained) beside the messages. When the server drains,
//! the frames the outbox still holds go out first, then the Close with 1001 "going
//! away" (RFC 6455 Section 7.4.1); the peer's Close is awaited for at most
//! [`CLOSE_TIMEOUT`] within the drain deadline, and the connection ends. The outbox
//! refuses pushes once a Close went out, and closes when the connection is dropped.
//!
//! A server that hands each received message on and waits for its acknowledgment
//! bounds what a connection may have waiting by pausing it with a [`ReadPause`]: a
//! paused connection reads no frame from its socket, so a client that keeps sending
//! is held back by TCP flow control rather than by server memory, while the
//! connection still writes its outbox and broadcasts, still closes, and still sends
//! Close 1001 and ends when the server drains.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.1>
//! @see <https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1>

use std::future::{poll_fn, Future};
use std::io::IoSlice;
use std::pin::pin;
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};
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

use crate::outbox::{Attached, Command, Outbox};
use crate::rooms::{MemberId, Membership, Rooms};

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

/// What [`WebSocket::recv_event`] reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Incoming {
    /// A whole message.
    Message(Message),
    /// A pong, with its application data.
    Pong(Vec<u8>),
    /// The outbox fell below half its high-water mark after passing it.
    Drained,
}

/// Whether a [`ReadPause`] holds its connection, and the task to wake when that
/// changes.
#[derive(Debug, Default)]
struct PauseState {
    paused: bool,
    waker: Option<Waker>,
}

/// Stops a WebSocket connection reading its socket, and lets it read again, from
/// any thread.
///
/// A paused connection reads no frame: what the client sends meanwhile stays in the
/// socket, where TCP flow control holds the client back, and frames already read
/// before the pause stay buffered. It still writes its outbox and its room
/// broadcasts, still sends a Close it is asked to send, and on the shutdown signal
/// still sends Close 1001 after its queued frames and ends; a Close answer it does
/// not read is waited for up to [`CLOSE_TIMEOUT`], as any other. Once resumed, it
/// reads again and the frames that waited surface in the order they were sent.
///
/// Clones control the same connection, so the task that counts what the connection
/// has waiting and the one that learns of acknowledgments can each hold one.
#[derive(Clone, Debug, Default)]
pub struct ReadPause(Arc<Mutex<PauseState>>);

impl ReadPause {
    /// A handle that does not pause its connection yet.
    ///
    /// # Returns
    ///
    /// The handle, resumed.
    #[must_use]
    pub fn new() -> Self {
        ReadPause::default()
    }

    fn lock(&self) -> MutexGuard<'_, PauseState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stop the connection reading its socket; a read it is waiting on is dropped.
    pub fn pause(&self) {
        self.set(true);
    }

    /// Let the connection read again.
    pub fn resume(&self) {
        self.set(false);
    }

    /// Whether the connection is paused.
    ///
    /// # Returns
    ///
    /// `true` between [`pause`](Self::pause) and [`resume`](Self::resume).
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.lock().paused
    }

    fn set(&self, paused: bool) {
        let waker = {
            let mut state = self.lock();
            if state.paused == paused {
                return;
            }
            state.paused = paused;
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Whether the connection is paused; registers the task to be woken when that
    /// changes.
    fn poll_paused(&self, cx: &Context<'_>) -> bool {
        let mut state = self.lock();
        if !state
            .waker
            .as_ref()
            .is_some_and(|waker| waker.will_wake(cx.waker()))
        {
            state.waker = Some(cx.waker().clone());
        }
        state.paused
    }
}

/// What one wait for input produced.
enum Read {
    Data,
    Done,
    Shutdown,
    Inbox,
    Outbox,
    Pause,
}

/// What woke a wait for input.
enum Woke {
    Read(std::io::Result<Leased>),
    Shutdown,
    Inbox,
    Outbox,
    Pause,
}

/// A server-side WebSocket connection.
pub struct WebSocket<S> {
    taken: Taken<S>,
    session: Session,
    input: Vec<u8>,
    start: usize,
    started: Instant,
    closing: bool,
    /// When the wait for the peer's Close ends, set once the first such wait starts.
    close_deadline: Option<Instant>,
    membership: Option<Membership>,
    outbox: Option<Attached>,
    pause: Option<ReadPause>,
    rooms: Option<Arc<Rooms>>,
    /// Octets of outbox commands applied and not yet written.
    unreleased: u64,
    drained: bool,
    /// A Terminate or End was applied: the connection ends once its output is written.
    ended: bool,
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
            close_deadline: None,
            membership: None,
            outbox: None,
            pause: None,
            rooms: None,
            unreleased: 0,
            drained: false,
            ended: false,
        }
    }

    /// Serve the commands other threads push to `outbox`, beside the socket. The
    /// connection then joins rooms as [`MemberId::of_connection`] of its claim token,
    /// so a sender can leave it out of a broadcast by that token alone.
    ///
    /// # Arguments
    ///
    /// * `outbox` - the connection's outbox; it closes when this connection is
    ///   dropped.
    /// * `rooms` - the server's rooms, which [`Command::Join`] and
    ///   [`Command::Leave`] act on.
    ///
    /// # Returns
    ///
    /// The connection.
    #[must_use]
    pub fn with_outbox(mut self, outbox: Arc<Outbox>, rooms: &Arc<Rooms>) -> Self {
        self.outbox = Some(Attached::new(outbox));
        self.rooms = Some(Arc::clone(rooms));
        self
    }

    /// Let `pause` stop and resume this connection's socket reads.
    ///
    /// # Arguments
    ///
    /// * `pause` - the handle; a clone kept elsewhere pauses and resumes this
    ///   connection from any thread.
    ///
    /// # Returns
    ///
    /// The connection.
    #[must_use]
    pub fn with_read_pause(mut self, pause: ReadPause) -> Self {
        self.pause = Some(pause);
        self
    }

    fn read_paused(&self) -> bool {
        self.pause.as_ref().is_some_and(ReadPause::is_paused)
    }

    /// This connection's id in the rooms it joined, to leave it out of its own
    /// broadcasts.
    #[must_use]
    pub fn id(&self) -> Option<MemberId> {
        self.membership.as_ref().map(|membership| membership.id)
    }

    /// Join a room, so its broadcasts reach this connection; joining rooms of
    /// another table leaves the rooms of the first.
    ///
    /// # Arguments
    ///
    /// * `rooms` - the server's rooms.
    /// * `room` - the room's name.
    ///
    /// # Returns
    ///
    /// This connection's id in the rooms.
    pub fn join(&mut self, rooms: &Arc<Rooms>, room: &str) -> MemberId {
        let id = self
            .outbox
            .is_some()
            .then(|| MemberId::of_connection(self.taken.token()));
        let membership = match self.membership.take() {
            Some(membership) if membership.is_in(rooms) => membership,
            _ => Membership::new(rooms, id),
        };
        let membership = self.membership.insert(membership);
        membership.join(room);
        membership.id
    }

    /// Leave a room.
    ///
    /// # Arguments
    ///
    /// * `room` - the room's name.
    pub fn leave(&mut self, room: &str) {
        if let Some(membership) = self.membership.as_mut() {
            membership.leave(room);
        }
    }

    /// Queue the frames broadcast to this connection, or close it with 1013 when it
    /// fell too far behind.
    fn deliver(&mut self) {
        let Some(membership) = self.membership.as_ref() else {
            return;
        };
        let (frames, overflowed) = membership.inbox.take();
        if overflowed {
            self.membership = None;
            if self.session.close(CloseCode::TRY_AGAIN_LATER, "").is_ok() {
                self.closing = true;
            }
            return;
        }
        for frame in frames {
            if self.session.send_encoded(&frame).is_err() {
                break;
            }
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
    /// completed, the peer failed the protocol, the connection dropped, the server
    /// drained, or a Terminate or End from the outbox was applied.
    pub async fn recv(&mut self) -> Option<Message> {
        loop {
            match self.recv_event().await? {
                Incoming::Message(message) => return Some(message),
                Incoming::Pong(_) | Incoming::Drained => {}
            }
        }
    }

    /// The next message, pong, or drained outbox.
    ///
    /// While the connection is paused ([`with_read_pause`](Self::with_read_pause)),
    /// no message or pong is returned and the socket is not read; the outbox is
    /// still written, and [`Incoming::Drained`] and the end are still reported.
    ///
    /// # Returns
    ///
    /// What the connection reports, or `None` once it is done, as for
    /// [`recv`](Self::recv); the outbox is closed then.
    pub async fn recv_event(&mut self) -> Option<Incoming> {
        loop {
            self.deliver();
            self.pour();
            if !self.flush().await || self.session.is_finished() || self.ended {
                self.finish();
                return None;
            }
            if std::mem::take(&mut self.drained) {
                return Some(Incoming::Drained);
            }
            if self.start < self.input.len() && !self.read_paused() {
                let now = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
                let rest = self.input.get_mut(self.start..).unwrap_or(&mut []);
                let fed = self.session.feed(rest, now).map(|step| {
                    let incoming = match step.event {
                        Some(Event::Text(text)) => {
                            Some(Incoming::Message(Message::Text(text.to_owned())))
                        }
                        Some(Event::Binary(data)) => {
                            Some(Incoming::Message(Message::Binary(data.to_vec())))
                        }
                        Some(Event::Pong(data)) => Some(Incoming::Pong(data.to_vec())),
                        _ => None,
                    };
                    (step.consumed, step.event.is_some(), incoming)
                });
                match fed {
                    Ok((consumed, evented, incoming)) => {
                        self.start = self.start.saturating_add(consumed);
                        if let Some(incoming) = incoming {
                            return Some(incoming);
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
                Read::Data | Read::Inbox | Read::Outbox | Read::Pause => {}
                Read::Done => {
                    self.finish();
                    return None;
                }
                Read::Shutdown => {
                    self.seal();
                    if !self.ended {
                        let _ = self.session.going_away();
                        self.closing = true;
                    }
                }
            }
        }
    }

    /// Apply the commands the outbox holds, in the order they were pushed, and refuse
    /// later pushes once nothing more can be sent.
    fn pour(&mut self) {
        let commands = match self.outbox.as_deref() {
            Some(outbox) => outbox.take(),
            None => return,
        };
        for command in commands {
            self.apply(command);
        }
        if self.closing || self.ended || self.session.is_finished() {
            self.seal();
        }
    }

    /// Refuse later pushes, and apply what the outbox still holds.
    fn seal(&mut self) {
        let commands = match self.outbox.as_deref() {
            Some(outbox) => outbox.seal(),
            None => return,
        };
        for command in commands {
            self.apply(command);
        }
    }

    fn apply(&mut self, command: Command) {
        self.unreleased = self.unreleased.saturating_add(command.octets());
        if self.ended {
            return;
        }
        match command {
            Command::Frame(frame) => {
                let _ = self.session.send_encoded(&frame);
            }
            Command::Close { code, reason } => {
                if self.session.close(code, &reason).is_ok() {
                    self.closing = true;
                }
            }
            Command::Terminate | Command::End => self.ended = true,
            Command::Join(room) => {
                if let Some(rooms) = self.rooms.clone() {
                    self.join(&rooms, &room);
                }
            }
            Command::Leave(room) => self.leave(&room),
        }
    }

    /// Stop counting the outbox octets that were written or dropped.
    fn release(&mut self) {
        let octets = std::mem::take(&mut self.unreleased);
        if octets > 0
            && self
                .outbox
                .as_deref()
                .is_some_and(|outbox| outbox.release(octets))
        {
            self.drained = true;
        }
    }

    /// Close the outbox once nothing more will be written.
    fn finish(&self) {
        if let Some(outbox) = self.outbox.as_deref() {
            outbox.close();
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
    /// * `reason` - the reason, at most 123 octets.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once a Close was sent; [`Error::Protocol`] for a code a
    /// server may not start a closing handshake with; [`Error::Limit`] for a reason
    /// that does not fit; [`Error::Io`] when the write fails.
    pub async fn close(&mut self, code: CloseCode, reason: &str) -> Result<()> {
        self.session.close(code, reason)?;
        self.closing = true;
        self.flush_or_fail().await
    }

    /// Write what the session queued, dropping each part from its output once the
    /// connection took it, so a flush whose future is dropped resumes with the same
    /// bytes and repeats none.
    ///
    /// # Returns
    ///
    /// Whether the write succeeded.
    async fn flush(&mut self) -> bool {
        loop {
            let pending = self.session.output();
            if pending.is_empty() {
                break;
            }
            match self.taken.stream().writev(&[IoSlice::new(pending)]).await {
                Ok(0) | Err(_) => return false,
                Ok(written) => self.session.consume_output(written),
            }
        }
        self.release();
        true
    }

    async fn flush_or_fail(&mut self) -> Result<()> {
        if self.flush().await {
            Ok(())
        } else {
            Err(Error::Io("the WebSocket connection dropped".to_owned()))
        }
    }

    /// Read more input, or notice the shutdown signal, a broadcast, a push to the
    /// outbox, or the pause changing. A paused connection starts no read.
    async fn read(&mut self) -> Read {
        let paused = self.read_paused();
        let deadline = self.closing.then(|| {
            *self.close_deadline.get_or_insert_with(|| {
                let now = Instant::now();
                now.checked_add(CLOSE_TIMEOUT).unwrap_or(now)
            })
        });
        let core = self.taken.core();
        let pool = Rc::clone(&core.pool);
        let pause = self.pause.as_ref();
        let mut read = pin!((!paused).then(|| self.taken.stream().read_leased(&pool)));
        let woke = if let Some(deadline) = deadline {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Read::Done;
            }
            let wait = poll_fn(|cx| {
                if pause.is_some_and(|pause| pause.poll_paused(cx)) != paused {
                    return Poll::Ready(Woke::Pause);
                }
                match read.as_mut().as_pin_mut() {
                    Some(read) => read.poll(cx).map(Woke::Read),
                    None => Poll::Pending,
                }
            });
            match core.timeout(left, wait).await {
                Ok(woke) => woke,
                Err(_) => return Read::Done,
            }
        } else {
            let inbox = self
                .membership
                .as_ref()
                .map(|membership| Arc::clone(&membership.inbox));
            let outbox = self.outbox.as_deref();
            let mut shutdown = pin!(self.taken.worker().shutdown().requested());
            poll_fn(|cx| {
                if pause.is_some_and(|pause| pause.poll_paused(cx)) != paused {
                    return Poll::Ready(Woke::Pause);
                }
                if let Some(Poll::Ready(outcome)) =
                    read.as_mut().as_pin_mut().map(|read| read.poll(cx))
                {
                    return Poll::Ready(Woke::Read(outcome));
                }
                if shutdown.as_mut().poll(cx).is_ready() {
                    return Poll::Ready(Woke::Shutdown);
                }
                if inbox
                    .as_ref()
                    .is_some_and(|inbox| inbox.poll_ready(cx).is_ready())
                {
                    return Poll::Ready(Woke::Inbox);
                }
                if outbox.is_some_and(|outbox| outbox.poll_ready(cx).is_ready()) {
                    return Poll::Ready(Woke::Outbox);
                }
                Poll::Pending
            })
            .await
        };
        match woke {
            Woke::Read(Ok(Leased::Data(buf))) => {
                self.input.extend_from_slice(buf.filled());
                pool.release(buf);
                Read::Data
            }
            Woke::Read(Ok(Leased::NoBudget)) => {
                core.sleep(BUDGET_RETRY).await;
                Read::Data
            }
            Woke::Read(Ok(Leased::Eof) | Err(_)) => Read::Done,
            Woke::Shutdown => Read::Shutdown,
            Woke::Inbox => Read::Inbox,
            Woke::Outbox => Read::Outbox,
            Woke::Pause => Read::Pause,
        }
    }
}
