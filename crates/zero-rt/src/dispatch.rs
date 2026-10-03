//! The batch dispatcher of one worker: tier 3 jobs and realtime events, assembled
//! into batches and offered to the worker index's target, with the acknowledgment
//! bookkeeping, the late list, admission, and the task loop that runs it.
//!
//! One [`turn`](Dispatcher::turn):
//!
//! 1. Reserves the intake's vectors and its own to the arena's capacity when the
//!    arena grew. Drains the intake: wakes the waiters of completed ids and retires
//!    orphans, applies a target attachment or loss, applies acknowledgments (each
//!    frees its ring entry and clears `full`), and releases the quarantine.
//! 2. Re-polls the late list, whose entries back off from 1 ms to one second.
//! 3. While a target is attached, fewer than the in-flight bound are unacknowledged,
//!    the last post was not refused, and requests or events wait: picks a kind
//!    (alternating when both wait), fills a free ring entry with up to a batch,
//!    leasing each request, stores the batch's epoch as published, and posts. A
//!    refused post rolls `published` back, unleases the jobs and puts them back in
//!    order; with nothing in flight it arms a retry timer, since no acknowledgment
//!    will come to clear the refusal. A target that is gone is lost.
//!
//! Whatever is ready goes out: no job is held back to grow a batch. [`run`] sleeps
//! between turns on the intake, the kick, the timers and the shutdown signal, and
//! returns once a draining dispatcher has nothing left, its open realtime
//! connections included, so it never holds a worker's drain open and never strands
//! a close event.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::fmt;
use std::future::{poll_fn, Future};
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use zero_core::SlotId;
use zero_io::seam::Shutdown;
use zero_limits::services::{
    MemoryLimits, MAX_BATCHES_IN_FLIGHT, MAX_BATCHES_IN_FLIGHT_CEILING, MAX_BATCH_SIZE,
    MAX_QUEUED_BATCHES_PER_CORE, QUEUE_FULL_RETRY,
};

use crate::alloc::Allocator;
use crate::arena::{Arena, Payload};
use crate::intake::Intake;
use crate::ring::{BatchRef, BatchRing, EventRec, EVENTS, REQUESTS};
use crate::slot::{Refused, SlotState};
use crate::sync;

/// The re-poll interval of a late-list entry for its first [`LATE_FAST_FOR`].
pub const LATE_FIRST: Duration = Duration::from_millis(1);
/// How long a late-list entry is re-polled every [`LATE_FIRST`]; after that its
/// interval doubles.
pub const LATE_FAST_FOR: Duration = Duration::from_millis(64);
/// The longest interval a late-list entry backs off to.
pub const LATE_CEILING: Duration = Duration::from_secs(1);

/// A tier 3 request waiting to be leased: its slot and its route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Job {
    /// The slot holding the exported request.
    pub slot: SlotId,
    /// The route id the host dispatches on.
    pub route: u32,
}

/// Where batches go: a host's queue.
pub trait Target: Send + Sync {
    /// Offer a batch; never blocks and never runs host code on the calling thread.
    ///
    /// # Arguments
    ///
    /// * `batch` - the batch; the target copies it out of the ring on the host's
    ///   thread.
    ///
    /// # Returns
    ///
    /// Whether the target took the batch, is full, or is gone.
    fn post(&self, batch: BatchRef) -> Post;
}

/// A target's answer to a post.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Post {
    /// The batch is queued for the host.
    Taken,
    /// The queue is full; the batch was not queued.
    Full,
    /// The target is gone; the batch was not queued.
    Gone,
}

/// What became of a completed id handed to its waiter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sealed {
    /// The waiting future was woken to take the response back.
    Woken,
    /// The future was dropped; the slot goes to the retire path.
    Orphan,
    /// No waiter holds this generation; the id is ignored.
    Stale,
}

/// Why a lease ends without a host response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The worker index's target is gone: answered 503.
    TargetGone,
    /// The host dispatch of the core failed: answered 500.
    Failed,
}

/// Why a slot is on the late list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Late {
    /// A future waits to import the response once the lock is free and, for a
    /// staged body, no pin is counted in; [`Waiters::late`] re-polls it.
    Import,
    /// The slot is retired once no pin is counted in; a lease its dropped future left
    /// is closed first.
    Retire,
}

/// The per-index records of the futures waiting on their leases; the dispatcher
/// reports what happened to each.
pub trait Waiters {
    /// A host completed `id`: wake its future.
    ///
    /// # Arguments
    ///
    /// * `id` - the completed id, checked against the waiter's generation.
    ///
    /// # Returns
    ///
    /// Whether a future was woken, had been dropped, or holds another generation.
    fn sealed(&mut self, id: SlotId) -> Sealed;

    /// The batch carrying `id` was taken by the target.
    ///
    /// # Arguments
    ///
    /// * `id` - the leased id.
    fn posted(&mut self, id: SlotId);

    /// End the wait of `id` with `failure`.
    ///
    /// # Arguments
    ///
    /// * `id` - the id.
    /// * `failure` - why the lease ends.
    ///
    /// # Returns
    ///
    /// Whether a waiting future took the failure; `false` when the response was
    /// already sealed or no future waits, in which case the slot is left as it is.
    fn fail(&mut self, id: SlotId, failure: Failure) -> bool;

    /// Re-poll a late import.
    ///
    /// # Arguments
    ///
    /// * `id` - the id on the late list.
    ///
    /// # Returns
    ///
    /// Whether the entry is settled: its future was woken to import, or no longer
    /// waits.
    fn late(&mut self, id: SlotId) -> bool;

    /// Whether no future waits.
    ///
    /// # Returns
    ///
    /// `true` when the table is empty.
    fn is_empty(&self) -> bool;
}

/// The batch and queue bounds of a dispatcher.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DispatchLimits {
    /// The most requests or events in one batch; 1 to 256.
    pub batch: usize,
    /// The most batches posted and not acknowledged; 1 to 8.
    pub in_flight: usize,
    /// The full batches queued behind the in-flight bound before admission refuses.
    pub queued: usize,
}

impl Default for DispatchLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

impl DispatchLimits {
    /// The defaults of `zero-limits`: batches of 256, 4 in flight, 16 queued.
    pub const DEFAULT: Self = Self {
        batch: MAX_BATCH_SIZE,
        in_flight: MAX_BATCHES_IN_FLIGHT,
        queued: MAX_QUEUED_BATCHES_PER_CORE,
    };

    /// The dispatch bounds of a configured memory budget.
    ///
    /// # Arguments
    ///
    /// * `memory` - the configured budget.
    ///
    /// # Returns
    ///
    /// The bounds, each brought into its range.
    #[must_use]
    pub fn from_memory(memory: &MemoryLimits) -> Self {
        Self {
            batch: memory.max_batch_size,
            in_flight: memory.max_batches_in_flight,
            queued: memory.max_queued_batches_per_core,
        }
        .clamped()
    }

    /// The jobs admission accepts before it refuses: `queued` full batches.
    ///
    /// # Returns
    ///
    /// `queued * batch`.
    #[must_use]
    pub const fn queue_bound(&self) -> usize {
        self.queued.saturating_mul(self.batch)
    }

    const fn clamped(self) -> Self {
        Self {
            batch: clamp(self.batch, 1, MAX_BATCH_SIZE),
            in_flight: clamp(self.in_flight, 1, MAX_BATCHES_IN_FLIGHT_CEILING),
            queued: clamp(self.queued, 1, usize::MAX),
        }
    }
}

const fn clamp(value: usize, low: usize, high: usize) -> usize {
    if value < low {
        low
    } else if value > high {
        high
    } else {
        value
    }
}

/// Per-worker counters, summed across workers for the server's statistics. The
/// dispatcher keeps those it can see; the host layer keeps the rest.
#[derive(Debug, Default)]
pub struct Counters {
    /// Requests posted to the target in batches it took.
    pub dispatched: AtomicU64,
    /// Batches the target took.
    pub batches: AtomicU64,
    /// Batches acknowledged.
    pub acks: AtomicU64,
    /// Slots that went on the late list to wait for a lock or a pin.
    pub late_readers: AtomicU64,
    /// Posts the target answered full.
    pub queue_full: AtomicU64,
    /// Requests refused at admission and answered 503.
    pub refused_503: AtomicU64,
    /// Leases closed because their target was lost.
    pub closed_leases: AtomicU64,
    /// Panics of the host dispatch on this core.
    pub panics: AtomicU64,
    /// Pins host threads hold right now.
    pub pinned: AtomicU64,
    /// The longest the quarantine has been.
    pub quarantined_peak: AtomicU64,
    /// Batches posted and not yet acknowledged.
    pub in_flight: AtomicU64,
    /// Slots leased to the host whose lease has not ended at the dispatcher. Added as
    /// each batch is leased; taken off when a drained completion wakes the waiting
    /// future, which takes the lease over; when the dispatcher closes a lease whose
    /// future was dropped, on an orphaned completion or a retirement deferred with
    /// [`Late::Retire`]; when a refused post unleases the batch; and when target loss
    /// closes a lease whose future still waits.
    pub leased: AtomicU64,
    /// Acknowledgments refused while their completions were applied.
    pub refused_acks: AtomicU64,
    /// Batches a target gave up on and answered with 500.
    pub abandoned_batches: AtomicU64,
    /// Octets of exchanges held outside the connection records, from export to the
    /// quarantine release.
    pub retained: AtomicU64,
}

impl Counters {
    fn add(counter: &AtomicU64, value: usize) {
        counter.fetch_add(u64::try_from(value).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    fn sub(counter: &AtomicU64, value: u64) {
        let mut current = counter.load(Ordering::Relaxed);
        while let Err(seen) = counter.compare_exchange_weak(
            current,
            current.saturating_sub(value),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            current = seen;
        }
    }
}

/// Whether a new tier 3 request may be queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    /// Queue it.
    Admit,
    /// No target is attached for this worker index.
    NoTarget,
    /// The queue holds its bound of full batches.
    Queue,
    /// The server is draining.
    Draining,
}

/// What one turn left behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Turned {
    /// The dispatcher is draining and nothing is left: no waiter, no ready job, no
    /// queued event, no unacknowledged batch, no late-list entry and no open realtime
    /// connection.
    pub finished: bool,
    /// When a timer is due: the full retry or the earliest late-list entry.
    pub timer: Option<Instant>,
}

/// What a turn works on besides the dispatcher's own state: the worker index's
/// permanent parts and the worker-local allocator and waiters.
#[derive(Debug)]
pub struct Parts<'a, T: Payload, W: Waiters> {
    /// The arena.
    pub arena: &'a Arena<T>,
    /// The allocator.
    pub alloc: &'a mut Allocator,
    /// The intake.
    pub intake: &'a Intake,
    /// The batch ring.
    pub ring: &'a BatchRing,
    /// The waiter table.
    pub waiters: &'a mut W,
}

/// One entry of the late list.
#[derive(Clone, Copy, Debug)]
struct LateEntry {
    id: SlotId,
    kind: Late,
    since: Instant,
    due: Instant,
    interval: Duration,
}

/// Slots waiting for a lock or a pin, each re-polled on its own back-off.
#[derive(Debug, Default)]
struct LateList {
    entries: Vec<LateEntry>,
}

impl LateList {
    fn push(&mut self, id: SlotId, kind: Late, now: Instant) {
        self.entries.push(LateEntry {
            id,
            kind,
            since: now,
            due: now.checked_add(LATE_FIRST).unwrap_or(now),
            interval: LATE_FIRST,
        });
    }

    fn next_due(&self) -> Option<Instant> {
        self.entries.iter().map(|entry| entry.due).min()
    }

    /// Re-poll every entry that is due; `settle` says whether it leaves the list.
    fn poll(&mut self, now: Instant, mut settle: impl FnMut(SlotId, Late) -> bool) {
        let mut position = 0;
        while let Some(entry) = self.entries.get(position).copied() {
            if entry.due > now {
                position = position.saturating_add(1);
                continue;
            }
            if settle(entry.id, entry.kind) {
                self.entries.swap_remove(position);
                continue;
            }
            let interval = if now.saturating_duration_since(entry.since) < LATE_FAST_FOR {
                LATE_FIRST
            } else {
                entry.interval.saturating_mul(2).min(LATE_CEILING)
            };
            if let Some(slot) = self.entries.get_mut(position) {
                slot.interval = interval;
                slot.due = now.checked_add(interval).unwrap_or(now);
            }
            position = position.saturating_add(1);
        }
    }
}

/// The dispatcher of one worker: worker-local, generic over the read hold a queued
/// request keeps on its connection until its batch is taken.
pub struct Dispatcher<H> {
    ready: VecDeque<(Job, Option<H>)>,
    events: VecDeque<EventRec>,
    event_bytes: usize,
    unacked: VecDeque<(u64, u8)>,
    busy: u8,
    posting: Vec<Job>,
    holds: Vec<Option<H>>,
    spare: Vec<u64>,
    late: LateList,
    target: Option<Arc<dyn Target>>,
    full: bool,
    retry: Option<Instant>,
    prefer_events: bool,
    draining: bool,
    connections: usize,
    reserved: usize,
    limits: DispatchLimits,
    counters: Arc<Counters>,
}

/// How a target was lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Loss {
    /// The host detached it, which unbound its thread at the call.
    Detached,
    /// A post found it gone.
    Gone,
}

impl<H> fmt::Debug for Dispatcher<H> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Dispatcher")
            .field("ready", &self.ready.len())
            .field("events", &self.events.len())
            .field("unacked", &self.unacked)
            .field("late", &self.late.entries.len())
            .field("target", &self.target.is_some())
            .field("full", &self.full)
            .field("draining", &self.draining)
            .field("connections", &self.connections)
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl<H> Dispatcher<H> {
    /// A dispatcher with its queues reserved to the bounds.
    ///
    /// # Arguments
    ///
    /// * `limits` - the batch and queue bounds; each is brought into its range.
    /// * `counters` - the worker index's counters.
    ///
    /// # Returns
    ///
    /// The dispatcher, with no target attached.
    #[must_use]
    pub fn new(limits: DispatchLimits, counters: Arc<Counters>) -> Self {
        let limits = limits.clamped();
        let queue = limits.queue_bound();
        Dispatcher {
            ready: VecDeque::with_capacity(queue),
            events: VecDeque::with_capacity(queue),
            event_bytes: 0,
            unacked: VecDeque::with_capacity(limits.in_flight),
            busy: 0,
            posting: Vec::with_capacity(limits.batch),
            holds: Vec::with_capacity(limits.batch),
            spare: Vec::new(),
            late: LateList::default(),
            target: None,
            full: false,
            retry: None,
            prefer_events: false,
            draining: false,
            connections: 0,
            reserved: 0,
            limits,
            counters,
        }
    }

    /// The bounds in force.
    ///
    /// # Returns
    ///
    /// The limits.
    #[must_use]
    pub const fn limits(&self) -> DispatchLimits {
        self.limits
    }

    /// The worker index's counters.
    ///
    /// # Returns
    ///
    /// The counters.
    #[must_use]
    pub const fn counters(&self) -> &Arc<Counters> {
        &self.counters
    }

    /// Whether a new tier 3 request may be queued; a refusal is counted as a 503.
    ///
    /// # Returns
    ///
    /// [`Admission::Admit`], or why the request is refused.
    pub fn admit(&self) -> Admission {
        let refusal = if self.draining {
            Admission::Draining
        } else if self.target.is_none() {
            Admission::NoTarget
        } else if self.ready.len() >= self.limits.queue_bound() {
            Admission::Queue
        } else {
            return Admission::Admit;
        };
        Counters::add(&self.counters.refused_503, 1);
        refusal
    }

    /// Whether a request queued now should stop its connection's reads until it is
    /// posted: the last post was refused, or more than a batch waits.
    ///
    /// # Returns
    ///
    /// `true` while backlogged.
    #[must_use]
    pub fn backlogged(&self) -> bool {
        self.full || self.ready.len() > self.limits.batch
    }

    /// Queue an admitted job; the caller wakes the dispatcher task.
    ///
    /// # Arguments
    ///
    /// * `job` - the job; its slot is held by the worker.
    /// * `hold` - the read hold its connection keeps until the batch is taken.
    pub fn push(&mut self, job: Job, hold: Option<H>) {
        self.ready.push_back((job, hold));
    }

    /// Queue a realtime event; the caller wakes the dispatcher task.
    ///
    /// # Arguments
    ///
    /// * `event` - the event.
    ///
    /// # Errors
    ///
    /// The event back when the queue holds its bound of full batches.
    pub fn push_event(&mut self, event: EventRec) -> Result<(), EventRec> {
        if self.events.len() >= self.limits.queue_bound() {
            return Err(event);
        }
        self.event_bytes = self.event_bytes.saturating_add(event.data.len());
        self.events.push_back(event);
        Ok(())
    }

    /// Put a slot on the late list; the caller wakes the dispatcher task so the
    /// re-poll timer is armed.
    ///
    /// # Arguments
    ///
    /// * `id` - the slot id.
    /// * `kind` - what the slot waits for.
    /// * `now` - the current time.
    pub fn defer(&mut self, id: SlotId, kind: Late, now: Instant) {
        self.late.push(id, kind, now);
        Counters::add(&self.counters.late_readers, 1);
    }

    /// Count a realtime connection opened on this worker index: a draining
    /// dispatcher does not finish while one is open, since its close events are still
    /// to come.
    pub fn connection_opened(&mut self) {
        self.connections = self.connections.saturating_add(1);
    }

    /// Count a realtime connection closed, once its last event is queued; the caller
    /// wakes the dispatcher task.
    pub fn connection_closed(&mut self) {
        self.connections = self.connections.saturating_sub(1);
    }

    /// How many realtime connections are open on this worker index.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub const fn open_connections(&self) -> usize {
        self.connections
    }

    /// Start draining: admission refuses from now on, and [`Turned::finished`] is
    /// set once nothing is left.
    pub fn set_draining(&mut self) {
        self.draining = true;
    }

    /// Whether the dispatcher is draining.
    ///
    /// # Returns
    ///
    /// `true` after [`set_draining`](Self::set_draining).
    #[must_use]
    pub const fn is_draining(&self) -> bool {
        self.draining
    }

    /// Whether a target is attached.
    ///
    /// # Returns
    ///
    /// `true` when one is.
    #[must_use]
    pub const fn has_target(&self) -> bool {
        self.target.is_some()
    }

    /// How many jobs wait to be leased.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.ready.len()
    }

    /// How many events wait to be posted, and their payload octets.
    ///
    /// # Returns
    ///
    /// The count and the octets.
    #[must_use]
    pub fn queued_events(&self) -> (usize, usize) {
        (self.events.len(), self.event_bytes)
    }

    /// How many batches are posted and not acknowledged.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub fn in_flight(&self) -> usize {
        self.unacked.len()
    }

    /// How many slots are on the late list.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub fn late(&self) -> usize {
        self.late.entries.len()
    }

    /// Run one turn: drain the intake, re-poll the late list, post batches.
    ///
    /// # Arguments
    ///
    /// * `parts` - the arena, allocator, intake, ring and waiters of this worker.
    /// * `now` - the current time.
    ///
    /// # Returns
    ///
    /// Whether the dispatcher is finished, and when its next timer is due.
    pub fn turn<T: Payload, W: Waiters>(
        &mut self,
        parts: &mut Parts<'_, T, W>,
        now: Instant,
    ) -> Turned {
        self.reserve(parts);
        self.take_intake(parts, now);
        self.poll_late(parts, now);
        if self.retry.is_some_and(|at| at <= now) {
            self.retry = None;
            self.full = false;
        }
        self.post(parts, now);
        let idle = self.ready.is_empty()
            && self.events.is_empty()
            && self.unacked.is_empty()
            && self.late.entries.is_empty()
            && self.connections == 0
            && parts.waiters.is_empty();
        Turned {
            finished: self.draining && idle,
            timer: match (self.retry, self.late.next_due()) {
                (Some(retry), Some(late)) => Some(retry.min(late)),
                (retry, late) => retry.or(late),
            },
        }
    }

    /// Make room for every slot the allocator has reserved for in the intake swap
    /// vectors and the late list, once per grow, so neither grows on the warm path.
    fn reserve<T: Payload, W: Waiters>(&mut self, parts: &Parts<'_, T, W>) {
        let total = parts.alloc.reserved();
        if total <= self.reserved {
            return;
        }
        self.spare.reserve(total.saturating_sub(self.spare.len()));
        self.late
            .entries
            .reserve(total.saturating_sub(self.late.entries.len()));
        parts.intake.reserve(total);
        self.reserved = total;
    }

    /// The first part of a turn: completions, the target change, acknowledgments,
    /// the quarantine.
    fn take_intake<T: Payload, W: Waiters>(&mut self, parts: &mut Parts<'_, T, W>, now: Instant) {
        let change = parts.intake.drain(&mut self.spare);
        let mut position = 0;
        while let Some(raw) = self.spare.get(position).copied() {
            position = position.saturating_add(1);
            let Some(id) = SlotId::from_raw(raw) else {
                continue;
            };
            match parts.waiters.sealed(id) {
                Sealed::Woken => Counters::sub(&self.counters.leased, 1),
                Sealed::Orphan => self.retire_or_defer(parts, id, now),
                Sealed::Stale => {}
            }
        }
        self.spare.clear();
        if change.detach {
            self.lose_target(parts, now, Loss::Detached);
        }
        if let Some(target) = change.attach {
            self.target = Some(target);
        }
        let acked = parts.intake.acked();
        while let Some(&(epoch, entry)) = self.unacked.front() {
            if epoch > acked {
                break;
            }
            self.unacked.pop_front();
            self.free_entry(parts.ring, entry);
            self.full = false;
            self.retry = None;
            Counters::add(&self.counters.acks, 1);
        }
        self.gauge_in_flight();
        if parts.alloc.limbo() > 0 {
            let stamp = parts.intake.published();
            parts.alloc.retry_limbo(parts.arena, stamp);
        }
        let freed = parts.alloc.release(parts.arena, acked);
        Counters::sub(&self.counters.retained, freed);
        let quarantined = u64::try_from(parts.alloc.quarantined()).unwrap_or(u64::MAX);
        self.counters
            .quarantined_peak
            .fetch_max(quarantined, Ordering::Relaxed);
    }

    /// The second part of a turn: re-poll the late-list entries that are due.
    fn poll_late<T: Payload, W: Waiters>(&mut self, parts: &mut Parts<'_, T, W>, now: Instant) {
        let arena: &Arena<T> = parts.arena;
        let intake: &Intake = parts.intake;
        let alloc = &mut *parts.alloc;
        let waiters = &mut *parts.waiters;
        let counters = &self.counters;
        self.late.poll(now, |id, kind| match kind {
            Late::Retire => !matches!(
                close_and_retire(arena, alloc, intake, counters, id),
                Err(Refused::Readers(_))
            ),
            Late::Import => waiters.late(id),
        });
    }

    /// The last part of a turn: post batches while the bounds allow.
    fn post<T: Payload, W: Waiters>(&mut self, parts: &mut Parts<'_, T, W>, now: Instant) {
        loop {
            let Some(target) = self.target.clone() else {
                return;
            };
            if self.full || self.unacked.len() >= self.limits.in_flight {
                return;
            }
            let requests = !self.ready.is_empty();
            let events = !self.events.is_empty();
            let kind = match (requests, events) {
                (false, false) => return,
                (true, false) => REQUESTS,
                (false, true) => EVENTS,
                (true, true) if self.prefer_events => EVENTS,
                (true, true) => REQUESTS,
            };
            self.prefer_events = kind == REQUESTS;
            let Some(entry) = self.free_entry_index(parts.ring) else {
                return;
            };
            let epoch = parts.intake.published().saturating_add(1);
            let count = if kind == REQUESTS {
                self.fill_requests(parts, entry, epoch, now)
            } else {
                self.fill_events(parts.ring, entry, epoch)
            };
            if count == 0 {
                continue;
            }
            let batch = BatchRef {
                worker: parts.arena.worker(),
                entry,
                kind,
                count: u16::try_from(count).unwrap_or(u16::MAX),
                epoch,
            };
            parts.intake.publish(epoch);
            match target.post(batch) {
                Post::Taken => self.taken(parts, entry, epoch, kind),
                Post::Full => {
                    parts.intake.publish(epoch.saturating_sub(1));
                    self.refused(parts, entry, kind);
                    self.full = true;
                    Counters::add(&self.counters.queue_full, 1);
                    if self.unacked.is_empty() {
                        self.retry = now.checked_add(QUEUE_FULL_RETRY);
                    }
                    return;
                }
                Post::Gone => {
                    parts.intake.publish(epoch.saturating_sub(1));
                    self.refused(parts, entry, kind);
                    self.lose_target(parts, now, Loss::Gone);
                    return;
                }
            }
        }
    }

    /// Fill ring entry `entry` with up to a batch of leased jobs; a job whose lease
    /// is refused (its future was dropped) is retired and skipped.
    fn fill_requests<T: Payload, W: Waiters>(
        &mut self,
        parts: &mut Parts<'_, T, W>,
        entry: u8,
        epoch: u64,
        now: Instant,
    ) -> usize {
        let ring = parts.ring;
        let Some(lock) = ring.entry(entry) else {
            return 0;
        };
        let mut buf = sync::lock_recovered(lock);
        buf.start(epoch, REQUESTS);
        self.posting.clear();
        self.holds.clear();
        while buf.slots.len() < self.limits.batch {
            let Some((job, hold)) = self.ready.pop_front() else {
                break;
            };
            let leased = parts.arena.lookup(job.slot).and_then(|slot| {
                slot.word().lease(job.slot.generation())?;
                slot.set_lease_epoch(epoch);
                Ok(())
            });
            if leased.is_ok() {
                buf.slots.push(job.slot.as_u64());
                buf.routes.push(job.route);
                self.posting.push(job);
                self.holds.push(hold);
            } else {
                drop(hold);
                self.retire_or_defer(parts, job.slot, now);
            }
        }
        Counters::add(&self.counters.leased, self.posting.len());
        buf.slots.len()
    }

    /// Fill ring entry `entry` with up to a batch of events, moved, not copied.
    fn fill_events(&mut self, ring: &BatchRing, entry: u8, epoch: u64) -> usize {
        let Some(lock) = ring.entry(entry) else {
            return 0;
        };
        let mut buf = sync::lock_recovered(lock);
        buf.start(epoch, EVENTS);
        while buf.events.len() < self.limits.batch {
            let Some(event) = self.events.pop_front() else {
                break;
            };
            self.event_bytes = self.event_bytes.saturating_sub(event.data.len());
            buf.events.push(event);
        }
        buf.events.len()
    }

    /// The target took the batch of `epoch` in `entry`.
    fn taken<T: Payload, W: Waiters>(
        &mut self,
        parts: &mut Parts<'_, T, W>,
        entry: u8,
        epoch: u64,
        kind: u8,
    ) {
        self.unacked.push_back((epoch, entry));
        self.busy |= entry_bit(entry);
        Counters::add(&self.counters.batches, 1);
        self.gauge_in_flight();
        if kind == REQUESTS {
            Counters::add(&self.counters.dispatched, self.posting.len());
            self.holds.clear();
            for job in self.posting.drain(..) {
                parts.waiters.posted(job.slot);
            }
        }
    }

    /// The target refused the batch in `entry`: no host has seen it, so its jobs are
    /// unleased and its jobs or events go back to the front, in order.
    fn refused<T: Payload, W: Waiters>(
        &mut self,
        parts: &mut Parts<'_, T, W>,
        entry: u8,
        kind: u8,
    ) {
        if kind == REQUESTS {
            let unleased = self.posting.len();
            while let Some(job) = self.posting.pop() {
                let hold = self.holds.pop().flatten();
                if let Ok(slot) = parts.arena.lookup(job.slot) {
                    let _ = slot.word().unlease(job.slot.generation());
                }
                self.ready.push_front((job, hold));
            }
            Counters::sub(
                &self.counters.leased,
                u64::try_from(unleased).unwrap_or(u64::MAX),
            );
        }
        let Some(lock) = parts.ring.entry(entry) else {
            return;
        };
        let mut buf = sync::lock_recovered(lock);
        while let Some(event) = buf.events.pop() {
            self.event_bytes = self.event_bytes.saturating_add(event.data.len());
            self.events.push_front(event);
        }
        buf.free();
    }

    /// The target is gone: close every lease whose future still waits and fail it,
    /// fail the queued jobs and retire those whose future was dropped, drop the
    /// queued events, free the ring, and settle the acknowledgment floor, since no
    /// view of the target can exist any more.
    fn lose_target<T: Payload, W: Waiters>(
        &mut self,
        parts: &mut Parts<'_, T, W>,
        now: Instant,
        loss: Loss,
    ) {
        self.target = None;
        let worker = parts.arena.worker();
        for (index, slot) in parts.arena.slots() {
            let word = slot.word();
            let generation = word.generation();
            if word.check(generation, &[SlotState::Leased]).is_err() {
                continue;
            }
            let Some(id) = SlotId::new(worker, generation, index) else {
                continue;
            };
            if parts.waiters.fail(id, Failure::TargetGone) && word.close_leased(generation).is_ok()
            {
                Counters::add(&self.counters.closed_leases, 1);
                Counters::sub(&self.counters.leased, 1);
            }
        }
        while let Some((job, hold)) = self.ready.pop_front() {
            drop(hold);
            if !parts.waiters.fail(job.slot, Failure::TargetGone) {
                self.retire_or_defer(parts, job.slot, now);
            }
        }
        self.events.clear();
        self.event_bytes = 0;
        while let Some((_, entry)) = self.unacked.pop_front() {
            self.free_entry(parts.ring, entry);
        }
        self.busy = 0;
        self.full = false;
        self.retry = None;
        self.gauge_in_flight();
        parts.intake.settle(loss == Loss::Gone);
    }

    /// Retire `id`, or put it on the late list while a pin is counted in. A slot
    /// still leased to a dropped future is closed first.
    fn retire_or_defer<T: Payload, W: Waiters>(
        &mut self,
        parts: &mut Parts<'_, T, W>,
        id: SlotId,
        now: Instant,
    ) {
        let retired = close_and_retire(parts.arena, parts.alloc, parts.intake, &self.counters, id);
        if let Err(Refused::Readers(_)) = retired {
            self.defer(id, Late::Retire, now);
        }
    }

    /// The first ring entry not in flight.
    fn free_entry_index(&self, ring: &BatchRing) -> Option<u8> {
        (0..ring.len())
            .filter_map(|entry| u8::try_from(entry).ok())
            .find(|&entry| self.busy & entry_bit(entry) == 0)
    }

    /// Empty ring entry `entry` and mark it free.
    fn free_entry(&mut self, ring: &BatchRing, entry: u8) {
        if let Some(lock) = ring.entry(entry) {
            sync::lock_recovered(lock).free();
        }
        self.busy &= !entry_bit(entry);
    }

    fn gauge_in_flight(&self) {
        let in_flight = u64::try_from(self.unacked.len()).unwrap_or(u64::MAX);
        self.counters.in_flight.store(in_flight, Ordering::Relaxed);
    }
}

/// Close the lease a dropped future left on `id`, which ends it in the leased gauge,
/// then retire the slot stamped with the newest posted epoch. A slot that is not
/// leased refuses the close, so no lease is counted off twice.
fn close_and_retire<T: Payload>(
    arena: &Arena<T>,
    alloc: &mut Allocator,
    intake: &Intake,
    counters: &Counters,
    id: SlotId,
) -> Result<(), Refused> {
    if let Ok(slot) = arena.lookup(id) {
        if slot.word().close_leased(id.generation()).is_ok() {
            Counters::sub(&counters.leased, 1);
        }
    }
    alloc.retire(arena, id, intake.published())
}

/// The bit of ring entry `entry` in the in-flight mask.
const fn entry_bit(entry: u8) -> u8 {
    1u8.wrapping_shl(entry as u32)
}

/// The same-thread wake of a dispatcher task: new jobs, events or late entries.
#[derive(Debug, Default)]
pub struct Kick {
    kicked: Cell<bool>,
    waker: RefCell<Option<Waker>>,
}

impl Kick {
    /// A kick nobody has given.
    ///
    /// # Returns
    ///
    /// The kick.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Wake the dispatcher task for a turn.
    pub fn wake(&self) {
        self.kicked.set(true);
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }

    /// Take a kick, or store the task's waker until one comes.
    fn take(&self, cx: &Context<'_>) -> bool {
        if self.kicked.replace(false) {
            return true;
        }
        let mut slot = self.waker.borrow_mut();
        match slot.as_ref() {
            Some(waker) if waker.will_wake(cx.waker()) => {}
            _ => *slot = Some(cx.waker().clone()),
        }
        false
    }
}

/// The dispatcher task of one worker: run a turn, then sleep until the intake, the
/// kick, the timer the turn asked for, or the shutdown signal wakes it, and return
/// once a turn reports [`Turned::finished`].
///
/// # Arguments
///
/// * `shutdown` - the worker's shutdown signal.
/// * `intake` - the worker index's intake.
/// * `kick` - the worker-local kick.
/// * `turn` - one turn, given the time and whether shutdown was requested, so it
///   can set the dispatcher draining.
pub async fn run<S: Shutdown>(
    shutdown: &S,
    intake: &Intake,
    kick: &Kick,
    mut turn: impl FnMut(Instant, bool) -> Turned,
) {
    loop {
        let stopping = shutdown.is_requested();
        let turned = turn(Instant::now(), stopping);
        if turned.finished {
            return;
        }
        let mut sleep = pin!(sleep_until(turned.timer));
        let mut stop = pin!(shutdown.requested());
        poll_fn(|cx| {
            if intake.register(cx.waker()) || kick.take(cx) {
                return Poll::Ready(());
            }
            if sleep.as_mut().poll(cx).is_ready() {
                return Poll::Ready(());
            }
            if !stopping && stop.as_mut().poll(cx).is_ready() {
                return Poll::Ready(());
            }
            Poll::Pending
        })
        .await;
    }
}

/// Wait until `deadline`, or forever without one.
async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(at) => zero_io::rt::sleep(at.saturating_duration_since(Instant::now())).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use zero_core::SlotId;
    use zero_limits::services::MemoryLimits;

    use super::{
        Counters, DispatchLimits, Dispatcher, Failure, Job, Parts, Post, Sealed, Target, Waiters,
    };
    use crate::alloc::Allocator;
    use crate::arena::{Arena, Payload, Reset};
    use crate::intake::Intake;
    use crate::ring::{BatchRef, BatchRing};
    use crate::sync;

    #[derive(Debug, Default)]
    struct Request {
        sealed: bool,
    }

    impl Reset for Request {}

    impl Payload for Request {
        type View = ();

        fn release(&mut self, (): &(), _cold: bool) -> u64 {
            self.sealed = false;
            0
        }
    }

    #[derive(Debug, Default)]
    struct Queue(std::sync::Mutex<Vec<BatchRef>>);

    impl Target for Queue {
        fn post(&self, batch: BatchRef) -> Post {
            self.0.lock().unwrap().push(batch);
            Post::Taken
        }
    }

    #[derive(Debug, Default)]
    struct Table {
        waiting: Vec<(SlotId, bool)>,
    }

    impl Waiters for Table {
        fn sealed(&mut self, id: SlotId) -> Sealed {
            match self.waiting.iter_mut().find(|(waiting, _)| *waiting == id) {
                Some(entry) => {
                    entry.1 = true;
                    Sealed::Woken
                }
                None => Sealed::Stale,
            }
        }

        fn posted(&mut self, _id: SlotId) {}

        fn fail(&mut self, _id: SlotId, _failure: Failure) -> bool {
            false
        }

        fn late(&mut self, _id: SlotId) -> bool {
            true
        }

        fn is_empty(&self) -> bool {
            self.waiting.is_empty()
        }
    }

    struct Harness {
        arena: Arena<Request>,
        alloc: Allocator,
        intake: Intake,
        ring: BatchRing,
        table: Table,
        dispatcher: Dispatcher<()>,
        target: Arc<Queue>,
    }

    impl Harness {
        fn new() -> Self {
            let harness = Harness {
                arena: Arena::new(0, 256, 65_536).unwrap(),
                alloc: Allocator::new(),
                intake: Intake::new(),
                ring: BatchRing::new(4, 256),
                table: Table::default(),
                dispatcher: Dispatcher::new(DispatchLimits::DEFAULT, Arc::default()),
                target: Arc::default(),
            };
            harness
                .intake
                .attach(Arc::clone(&harness.target) as Arc<dyn Target>);
            harness
        }

        fn turn(&mut self) {
            let mut parts = Parts {
                arena: &self.arena,
                alloc: &mut self.alloc,
                intake: &self.intake,
                ring: &self.ring,
                waiters: &mut self.table,
            };
            self.dispatcher.turn(&mut parts, Instant::now());
        }

        /// One full round of `count` requests: export, post, the host's seal and
        /// acknowledgment, the import, the retirement and the release.
        fn cycle(&mut self, count: usize) {
            for route in 0..count {
                let (id, guard, _) = self.alloc.allocate(&self.arena).unwrap();
                self.arena
                    .lookup(id)
                    .unwrap()
                    .word()
                    .hold(id.generation())
                    .unwrap();
                drop(guard);
                let route = u32::try_from(route).unwrap();
                self.dispatcher.push(Job { slot: id, route }, None);
                self.table.waiting.push((id, false));
            }
            self.turn();
            let batches: Vec<BatchRef> = self.target.0.lock().unwrap().drain(..).collect();
            for batch in batches {
                let ids: Vec<SlotId> = self
                    .ring
                    .read(batch, |ids, _| ids.to_vec())
                    .unwrap()
                    .into_iter()
                    .map(|raw| SlotId::from_raw(raw).unwrap())
                    .collect();
                for &id in &ids {
                    let slot = self.arena.lookup(id).unwrap();
                    slot.with_write(id.generation(), |request| request.sealed = true)
                        .unwrap();
                }
                self.intake.complete(ids, batch.epoch).unwrap();
            }
            self.turn();
            let sealed: Vec<SlotId> = self.table.waiting.iter().map(|&(id, _)| id).collect();
            for id in sealed {
                let slot = self.arena.lookup(id).unwrap();
                slot.word().begin_import(id.generation()).unwrap();
                assert_eq!(
                    slot.with_worker(id.generation(), |request, ()| request.sealed),
                    Ok(true)
                );
                self.alloc
                    .retire(&self.arena, id, self.intake.published())
                    .unwrap();
            }
            self.table.waiting.clear();
            self.turn();
            assert_eq!(self.alloc.live(), 0);
            assert_eq!(self.alloc.quarantined(), 0);
        }

        /// The address and capacity of every buffer a turn touches.
        fn buffers(&self) -> Vec<usize> {
            let dispatcher = &self.dispatcher;
            let mut swapped = [
                (
                    dispatcher.spare.as_ptr().addr(),
                    dispatcher.spare.capacity(),
                ),
                self.intake.completed_buffer(),
            ];
            swapped.sort_unstable();
            let mut buffers = vec![
                dispatcher.ready.capacity(),
                dispatcher.events.capacity(),
                dispatcher.unacked.capacity(),
                dispatcher.posting.as_ptr().addr(),
                dispatcher.posting.capacity(),
                dispatcher.holds.as_ptr().addr(),
                dispatcher.holds.capacity(),
                dispatcher.late.entries.capacity(),
                swapped[0].0,
                swapped[0].1,
                swapped[1].0,
                swapped[1].1,
            ];
            buffers.extend(self.alloc.capacities());
            for entry in 0..self.ring.len() {
                let lock = self.ring.entry(u8::try_from(entry).unwrap()).unwrap();
                let buf = sync::lock_recovered(lock);
                buffers.extend([
                    buf.slots.as_ptr().addr(),
                    buf.slots.capacity(),
                    buf.routes.as_ptr().addr(),
                    buf.routes.capacity(),
                    buf.events.as_ptr().addr(),
                    buf.events.capacity(),
                ]);
            }
            buffers
        }
    }

    #[test]
    fn a_warm_dispatcher_reallocates_no_buffer() {
        let mut harness = Harness::new();
        for _ in 0..3 {
            harness.cycle(300);
        }
        let warm = harness.buffers();
        for _ in 0..20 {
            harness.cycle(300);
        }
        assert_eq!(
            harness.buffers(),
            warm,
            "a buffer was reallocated once warm"
        );
        let counters = harness.dispatcher.counters();
        assert_eq!(
            counters.batches.load(std::sync::atomic::Ordering::Relaxed),
            46
        );
        assert_eq!(
            counters
                .dispatched
                .load(std::sync::atomic::Ordering::Relaxed),
            6_900
        );
        assert_eq!(
            counters.leased.load(std::sync::atomic::Ordering::Relaxed),
            0
        );
    }

    #[test]
    fn the_turn_after_a_grow_reserves_the_intake_and_the_late_list_for_every_slot() {
        let mut harness = Harness::new();
        harness.cycle(300);
        let capacity = harness.arena.capacity();
        assert_eq!(capacity, 512);
        assert!(harness.dispatcher.spare.capacity() >= capacity);
        assert!(harness.intake.completed_buffer().1 >= capacity);
        assert!(harness.dispatcher.late.entries.capacity() >= capacity);
        assert_eq!(harness.dispatcher.reserved, capacity);
    }

    #[test]
    fn dispatch_limits_are_brought_into_their_ranges() {
        let mut memory = MemoryLimits::DEFAULT;
        assert_eq!(
            DispatchLimits::from_memory(&memory),
            DispatchLimits::DEFAULT
        );
        assert_eq!(DispatchLimits::default(), DispatchLimits::DEFAULT);
        memory.max_batch_size = 0;
        memory.max_batches_in_flight = 9;
        memory.max_queued_batches_per_core = 0;
        let limits = DispatchLimits::from_memory(&memory);
        assert_eq!((limits.batch, limits.in_flight, limits.queued), (1, 8, 1));
        memory.max_batch_size = 1_000;
        assert_eq!(DispatchLimits::from_memory(&memory).batch, 256);
        let dispatcher: Dispatcher<()> = Dispatcher::new(
            DispatchLimits {
                batch: 0,
                in_flight: 0,
                queued: 0,
            },
            Arc::new(Counters::default()),
        );
        assert_eq!(dispatcher.limits().queue_bound(), 1);
        assert!(format!("{dispatcher:?}").contains("Dispatcher"));
    }

    #[test]
    fn a_kick_wakes_the_task_once() {
        use std::task::{Context, Waker};
        let kick = super::Kick::new();
        let cx = Context::from_waker(Waker::noop());
        assert!(!kick.take(&cx), "nothing yet");
        kick.wake();
        assert!(kick.take(&cx));
        assert!(!kick.take(&cx), "taken once");
        let late = Duration::from_millis(1);
        assert_eq!(super::LATE_FIRST, late);
    }
}
