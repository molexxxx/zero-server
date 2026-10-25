//! Outboxes: what other threads send on one WebSocket or event stream connection.
//!
//! A connection runs on the core that accepted it, while what is sent on it can come
//! from any thread, such as the thread of a language binding. An [`Outbox`] is the
//! queue between them: a sender pushes [`Command`]s, already encoded and checked on
//! its own thread so a refusal returns at once, and the connection task applies them
//! in the order they were pushed. Frames are written, a Close starts the closing
//! handshake, Terminate and End end the connection once what was pushed before them
//! is written, and Join and Leave change the rooms the connection is in. A push wakes
//! the task through its [`Waker`], which may be called from any thread.
//!
//! Every pushed octet stays counted until the connection wrote it: on the outbox
//! ([`Outbox::buffered`]) and on the [`OutboxTotal`] of the worker the connection runs
//! on, for the server to count in the core's memory budget so slow readers hold
//! accepts back the way buffered bodies do. An outbox stops being writable once it
//! holds more than its high-water mark ([`HIGH_WATER`] by default, the rooms inbox
//! limit) or its worker's total passes half its limit; a push is refused with
//! [`Error::Limit`] when the outbox would hold more than [`LIMIT_FACTOR`] times its
//! mark or the worker's total would pass its limit ([`REQUEST_MEMORY_PER_CORE`] by
//! default). After an outbox passed its mark, the connection reports [`Drained`] once
//! it holds less than half of it again. The outbox closes when the connection task
//! ends: what it still holds is dropped, its octets leave the worker's total, and
//! later pushes are refused with [`Error::Closed`].
//!
//! A room broadcast to a WebSocket served with an outbox waits in the same queue, so
//! the connection writes it in order with what was pushed before and after it. The
//! frame is shared by every member, so it counts in no outbox and on no total;
//! instead the broadcast frames waiting in one outbox may hold the rooms inbox limit
//! at most, and past it they are dropped and the connection closes with 1013 Try
//! Again Later, as a member with an inbox does.

use std::collections::VecDeque;
use std::ops::Deref;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

use zero_core::{Error, Result};
use zero_limits::services::REQUEST_MEMORY_PER_CORE;
use zero_ws::close::{self, CloseCode};
use zero_ws::frame::MAX_CONTROL_PAYLOAD;

/// The default high-water mark of an outbox, in octets: the limit of a rooms inbox.
pub const HIGH_WATER: u64 = 16 * 1024 * 1024;

/// How many times its high-water mark an outbox may hold before a push is refused.
pub const LIMIT_FACTOR: u64 = 4;

/// One thing sent on a connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// An encoded WebSocket frame, or an encoded event or comment of an event stream,
    /// written as it is.
    Frame(Arc<[u8]>),
    /// Start the WebSocket closing handshake.
    Close {
        /// The status code, or [`CloseCode::NO_STATUS`] for an empty body.
        code: CloseCode,
        /// The reason, at most 123 octets.
        reason: String,
    },
    /// End the connection once what was pushed before is written, without a
    /// WebSocket Close frame.
    Terminate,
    /// Join a room of the server's rooms.
    Join(String),
    /// Leave a room.
    Leave(String),
    /// End the connection once what was pushed before is written: an event stream
    /// ends its body, and a WebSocket ends as it does on [`Command::Terminate`].
    End,
}

impl Command {
    /// The octets the command holds while it waits.
    ///
    /// # Returns
    ///
    /// The length of the frame, the reason or the room name; 0 for Terminate and
    /// End.
    #[must_use]
    pub fn octets(&self) -> u64 {
        let len = match self {
            Command::Frame(frame) => frame.len(),
            Command::Close { reason, .. } => reason.len(),
            Command::Join(room) | Command::Leave(room) => room.len(),
            Command::Terminate | Command::End => 0,
        };
        u64::try_from(len).unwrap_or(u64::MAX)
    }

    /// Whether the command ends what may be sent on the connection.
    const fn ends(&self) -> bool {
        matches!(
            self,
            Command::Close { .. } | Command::Terminate | Command::End
        )
    }
}

/// The connection fell below half its outbox's high-water mark after passing it, so
/// its sender may send again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Drained;

/// The octets queued in every outbox of one worker, and the most they may reach.
#[derive(Debug)]
pub struct OutboxTotal {
    queued: AtomicU64,
    limit: u64,
}

impl Default for OutboxTotal {
    fn default() -> Self {
        OutboxTotal::new(REQUEST_MEMORY_PER_CORE)
    }
}

impl OutboxTotal {
    /// Nothing queued yet.
    ///
    /// # Arguments
    ///
    /// * `limit` - the most octets the worker's outboxes may hold together,
    ///   [`REQUEST_MEMORY_PER_CORE`] by default.
    ///
    /// # Returns
    ///
    /// The counter, at zero.
    #[must_use]
    pub const fn new(limit: u64) -> Self {
        OutboxTotal {
            queued: AtomicU64::new(0),
            limit,
        }
    }

    /// The octets the worker's outboxes hold and their connections have not written,
    /// which the server counts in the core's memory budget.
    ///
    /// # Returns
    ///
    /// The octets.
    #[must_use]
    pub fn queued(&self) -> u64 {
        self.queued.load(Ordering::Acquire)
    }

    /// The most octets the worker's outboxes may hold together.
    ///
    /// # Returns
    ///
    /// The limit given to [`new`](Self::new).
    #[must_use]
    pub const fn limit(&self) -> u64 {
        self.limit
    }

    /// Whether the worker's outboxes hold at most half their limit.
    ///
    /// # Returns
    ///
    /// `false` once they hold more, which makes every outbox of the worker report
    /// that it is not writable.
    #[must_use]
    pub fn is_writable(&self) -> bool {
        self.queued() <= self.limit / 2
    }

    /// Count `octets` more, unless the total would pass the limit.
    fn reserve(&self, octets: u64) -> bool {
        let mut queued = self.queued.load(Ordering::Acquire);
        loop {
            let Some(next) = queued
                .checked_add(octets)
                .filter(|&next| next <= self.limit)
            else {
                return false;
            };
            match self.queued.compare_exchange_weak(
                queued,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(seen) => queued = seen,
            }
        }
    }

    /// Stop counting `octets`.
    fn release(&self, octets: u64) {
        if octets == 0 {
            return;
        }
        let mut queued = self.queued.load(Ordering::Acquire);
        loop {
            match self.queued.compare_exchange_weak(
                queued,
                queued.saturating_sub(octets),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(seen) => queued = seen,
            }
        }
    }
}

/// One entry of an outbox: a command a sender pushed, or a frame broadcast to a room
/// the connection is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Queued {
    Sent(Command),
    Broadcast(Arc<[u8]>),
}

/// What an outbox holds.
#[derive(Debug, Default)]
struct Queue {
    entries: VecDeque<Queued>,
    /// Octets pushed and not yet written, whether still queued or taken by the task.
    bytes: u64,
    /// Octets of the broadcast frames waiting in `entries`.
    broadcast_bytes: usize,
    /// Broadcast frames were dropped because too many waited.
    overflowed: bool,
    /// A Close, Terminate or End was pushed, so nothing more is.
    ending: bool,
    /// No push is accepted any more.
    closed: bool,
    /// `bytes` passed the high-water mark since the last [`Drained`].
    passed: bool,
    waker: Option<Waker>,
}

/// The commands other threads queue for one connection.
#[derive(Debug)]
pub struct Outbox {
    queue: Mutex<Queue>,
    bytes: AtomicU64,
    high_water: u64,
    total: Arc<OutboxTotal>,
}

impl Outbox {
    /// An empty outbox with the [`HIGH_WATER`] mark.
    ///
    /// # Arguments
    ///
    /// * `total` - the counter of the worker the connection runs on.
    ///
    /// # Returns
    ///
    /// The outbox, open and empty.
    #[must_use]
    pub fn new(total: Arc<OutboxTotal>) -> Self {
        Outbox::with_high_water(total, HIGH_WATER)
    }

    /// An empty outbox with its own high-water mark.
    ///
    /// # Arguments
    ///
    /// * `total` - the counter of the worker the connection runs on.
    /// * `high_water` - the octets past which the outbox is not writable; a push is
    ///   refused past [`LIMIT_FACTOR`] times this.
    ///
    /// # Returns
    ///
    /// The outbox, open and empty.
    #[must_use]
    pub fn with_high_water(total: Arc<OutboxTotal>, high_water: u64) -> Self {
        Outbox {
            queue: Mutex::new(Queue::default()),
            bytes: AtomicU64::new(0),
            high_water,
            total,
        }
    }

    /// The high-water mark.
    ///
    /// # Returns
    ///
    /// The octets past which the outbox is not writable.
    #[must_use]
    pub const fn high_water(&self) -> u64 {
        self.high_water
    }

    /// The counter of the worker the connection runs on.
    ///
    /// # Returns
    ///
    /// The counter given at construction.
    #[must_use]
    pub fn total(&self) -> &Arc<OutboxTotal> {
        &self.total
    }

    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queue a command for the connection.
    ///
    /// # Arguments
    ///
    /// * `command` - the command; a [`Command::Close`] is checked here, so an invalid
    ///   code or reason is refused before anything is queued.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once the outbox closed or a Close, Terminate or End was
    /// pushed; [`Error::Limit`] when the outbox would hold more than [`LIMIT_FACTOR`]
    /// times its high-water mark, or the worker's outbox total would pass its limit;
    /// for a Close, the errors of [`close::start_body`]. Nothing is queued then.
    pub fn push(&self, command: Command) -> Result<()> {
        if let Command::Close { code, reason } = &command {
            close::start_body(*code, reason, &mut [0u8; MAX_CONTROL_PAYLOAD])?;
        }
        let octets = command.octets();
        let waker = {
            let mut queue = self.lock();
            if queue.closed || queue.ending {
                return Err(Error::Closed);
            }
            let cap = self.high_water.saturating_mul(LIMIT_FACTOR);
            let bytes = queue.bytes.saturating_add(octets);
            if bytes > cap {
                return Err(Error::Limit(format!(
                    "a connection's outbox holds at most {cap} octets; {} are waiting and \
                     {octets} more were sent",
                    queue.bytes
                )));
            }
            if !self.total.reserve(octets) {
                return Err(Error::Limit(format!(
                    "the outboxes of a worker hold at most {} octets; {} are waiting and \
                     {octets} more were sent",
                    self.total.limit(),
                    self.total.queued()
                )));
            }
            queue.bytes = bytes;
            self.bytes.store(bytes, Ordering::Release);
            if bytes > self.high_water {
                queue.passed = true;
            }
            if command.ends() {
                queue.ending = true;
            }
            queue.entries.push_back(Queued::Sent(command));
            queue.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
        Ok(())
    }

    /// Queue a frame broadcast to a room the connection is in, after what was pushed
    /// before; nothing is queued once a Close, Terminate or End was pushed or the
    /// outbox closed. Past `limit` octets of broadcast frames waiting, they are
    /// dropped and the connection learns at its next take that it fell behind.
    pub(crate) fn broadcast(&self, frame: &Arc<[u8]>, limit: usize) {
        let waker = {
            let mut queue = self.lock();
            if queue.closed || queue.ending || queue.overflowed {
                return;
            }
            let bytes = queue.broadcast_bytes.saturating_add(frame.len());
            if bytes > limit {
                queue.overflowed = true;
                queue
                    .entries
                    .retain(|entry| matches!(entry, Queued::Sent(_)));
                queue.broadcast_bytes = 0;
            } else {
                queue.broadcast_bytes = bytes;
                queue
                    .entries
                    .push_back(Queued::Broadcast(Arc::clone(frame)));
            }
            queue.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// The octets pushed and not yet written, which a WebSocket API reports as its
    /// buffered amount.
    ///
    /// # Returns
    ///
    /// The octets, read without taking the outbox's lock.
    #[must_use]
    pub fn buffered(&self) -> u64 {
        self.bytes.load(Ordering::Acquire)
    }

    /// Whether the outbox holds at most its high-water mark and the worker's outboxes
    /// at most half their limit.
    ///
    /// # Returns
    ///
    /// `false` past either; a push may still succeed then, up to the limits of
    /// [`push`](Self::push).
    #[must_use]
    pub fn is_writable(&self) -> bool {
        self.buffered() <= self.high_water && self.total.is_writable()
    }

    /// Whether the outbox closed: its connection can no longer send, or its task
    /// ended.
    ///
    /// # Returns
    ///
    /// `true` once every push is refused for that reason; a push after a Close,
    /// Terminate or End is refused as well, before the connection applied it.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// Close the outbox: later pushes are refused with [`Error::Closed`], and what it
    /// holds is dropped and leaves the worker's total. The connection task does this
    /// when it ends; a server does it for a connection that never started.
    pub fn close(&self) {
        let (dropped, waker) = {
            let mut queue = self.lock();
            queue.closed = true;
            let octets = std::mem::take(&mut queue.bytes);
            self.bytes.store(0, Ordering::Release);
            self.total.release(octets);
            queue.passed = false;
            queue.broadcast_bytes = 0;
            queue.overflowed = false;
            (std::mem::take(&mut queue.entries), queue.waker.take())
        };
        drop(dropped);
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Ready once an entry waits or broadcast frames were dropped; registers the
    /// task to be woken otherwise.
    pub(crate) fn poll_ready(&self, cx: &Context<'_>) -> Poll<()> {
        let mut queue = self.lock();
        if !queue.entries.is_empty() || queue.overflowed {
            return Poll::Ready(());
        }
        queue.waker = Some(cx.waker().clone());
        Poll::Pending
    }

    /// Take the waiting entries, and whether broadcast frames were dropped since the
    /// last take; the octets of the commands stay counted until
    /// [`release`](Self::release).
    pub(crate) fn take(&self) -> (VecDeque<Queued>, bool) {
        let mut queue = self.lock();
        queue.broadcast_bytes = 0;
        (
            std::mem::take(&mut queue.entries),
            std::mem::take(&mut queue.overflowed),
        )
    }

    /// Refuse every later push and broadcast and take what waits, so nothing queued
    /// before is lost.
    pub(crate) fn seal(&self) -> VecDeque<Queued> {
        let mut queue = self.lock();
        queue.closed = true;
        queue.broadcast_bytes = 0;
        std::mem::take(&mut queue.entries)
    }

    /// Stop counting `octets` the connection wrote or dropped.
    ///
    /// # Returns
    ///
    /// Whether this took the outbox below half its high-water mark after it passed
    /// the mark.
    pub(crate) fn release(&self, octets: u64) -> bool {
        let mut queue = self.lock();
        let octets = octets.min(queue.bytes);
        queue.bytes = queue.bytes.saturating_sub(octets);
        self.bytes.store(queue.bytes, Ordering::Release);
        self.total.release(octets);
        if queue.passed && queue.bytes.saturating_mul(2) < self.high_water {
            queue.passed = false;
            return true;
        }
        false
    }
}

/// An outbox a connection task serves; closed when the task drops it.
#[derive(Debug)]
pub(crate) struct Attached(Arc<Outbox>);

impl Attached {
    pub(crate) fn new(outbox: Arc<Outbox>) -> Self {
        Attached(outbox)
    }

    /// The outbox, for the rooms to queue broadcasts in.
    pub(crate) fn shared(&self) -> Arc<Outbox> {
        Arc::clone(&self.0)
    }
}

impl Deref for Attached {
    type Target = Outbox;

    fn deref(&self) -> &Outbox {
        &self.0
    }
}

impl Drop for Attached {
    fn drop(&mut self) {
        self.0.close();
    }
}
