//! Targets and completion: where a worker's batches go, and how a host hands the
//! answered slots back.
//!
//! A [`PullTarget`] is the target of a host thread that blocks: the worker pushes
//! each batch's sixteen-octet reference into the target's queue, reserved at
//! creation so a post allocates nothing, and the host's thread takes it in
//! [`PullTarget::poll`], which copies the slot ids and route ids out of the
//! worker's batch ring. The first thread to poll binds the target and becomes the
//! only thread whose acknowledgments count, for every worker index the target
//! serves. A binding that supplies its own `zero_rt::Target` binds its thread with
//! [`bind_thread`] and reads each batch with [`read_batch`] or [`take_events`].
//!
//! [`complete`] hands answered ids back to a worker with one lock and one wake per
//! call, and acknowledges a batch when called from the bound thread with that
//! batch's epoch, which releases the indexes retired before it.

use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use zero_core::slot::MAX_ENCODED;
use zero_core::SlotId;
use zero_rt::{BatchRef, EventRec, Post, SlotState, Target};

use crate::registry::{self, lock, WorkerShared};
use crate::{HostError, Status, BATCH_EVENTS, BATCH_REQUESTS};

/// The next token a host thread is given; 0 means "not bound".
static NEXT_THREAD: AtomicU64 = AtomicU64::new(1);

/// The longest single condition-variable wait of a poll; a longer timeout waits
/// again.
const LONGEST_WAIT: Duration = Duration::from_secs(3_600);

thread_local! {
    /// The calling thread's token, 0 until the thread binds; a const initializer and
    /// no destructor, so reading it never allocates.
    static THREAD: Cell<u64> = const { Cell::new(0) };
}

thread_local! {
    /// The buffer a thread's completions collect their accepted ids in, kept between
    /// calls so a completion allocates only when it accepts more ids than any before.
    static ACCEPTED: Cell<Vec<SlotId>> = const { Cell::new(Vec::new()) };
}

/// The calling thread's token, given out on first use.
pub(crate) fn thread_token() -> u64 {
    THREAD.with(|token| {
        if token.get() == 0 {
            token.set(NEXT_THREAD.fetch_add(1, Ordering::Relaxed));
        }
        token.get()
    })
}

/// The calling thread's token, or 0 when it never bound.
pub(crate) fn current_token() -> u64 {
    THREAD.with(Cell::get)
}

/// One batch a host took: which worker index it came from, whether it carries
/// requests or events, how many, and the epoch the host acknowledges it with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Batch {
    /// The worker index whose slots the batch names.
    pub worker: u8,
    /// [`BATCH_REQUESTS`] or [`BATCH_EVENTS`].
    pub kind: u8,
    /// How many requests or events the batch carries.
    pub count: u32,
    /// The batch's epoch.
    pub epoch: u64,
}

#[derive(Debug)]
struct PullQueue {
    batches: VecDeque<BatchRef>,
    woken: bool,
    gone: bool,
}

/// The target of a host thread that blocks in [`poll`](Self::poll), for one worker
/// index or every worker index of a server.
#[derive(Debug)]
pub struct PullTarget {
    serial: u64,
    workers: Vec<Arc<WorkerShared>>,
    batch: usize,
    capacity: usize,
    queue: Mutex<PullQueue>,
    ready: Condvar,
    bound: AtomicU64,
}

impl Target for PullTarget {
    fn post(&self, batch: BatchRef) -> Post {
        let mut queue = lock(&self.queue);
        if queue.gone {
            return Post::Gone;
        }
        if queue.batches.len() >= self.capacity {
            return Post::Full;
        }
        queue.batches.push_back(batch);
        drop(queue);
        self.ready.notify_one();
        Post::Taken
    }
}

impl PullTarget {
    pub(crate) fn new(
        serial: u64,
        workers: Vec<Arc<WorkerShared>>,
        batch: usize,
        in_flight: usize,
    ) -> Self {
        let capacity = in_flight.saturating_mul(workers.len()).max(1);
        PullTarget {
            serial,
            workers,
            batch: batch.max(1),
            capacity,
            queue: Mutex::new(PullQueue {
                batches: VecDeque::with_capacity(capacity),
                woken: false,
                gone: false,
            }),
            ready: Condvar::new(),
            bound: AtomicU64::new(0),
        }
    }

    pub(crate) const fn serial(&self) -> u64 {
        self.serial
    }

    /// The worker indexes this target serves.
    ///
    /// # Returns
    ///
    /// The indexes, in the server's order.
    #[must_use]
    pub fn workers(&self) -> Vec<u8> {
        self.workers.iter().map(|worker| worker.index).collect()
    }

    /// Whether the target was detached, by the host or because its server stopped.
    ///
    /// # Returns
    ///
    /// `true` once no batch can arrive any more.
    #[must_use]
    pub fn is_detached(&self) -> bool {
        lock(&self.queue).gone
    }

    /// Wait for the next batch and copy it out.
    ///
    /// The first thread to poll binds the target: its token is recorded in every
    /// worker index the target serves, so only its acknowledgments count. A poll
    /// that cannot bind every index binds none, and a detached target binds nothing.
    /// A request batch's slot ids and route ids are copied into `slots` and
    /// `routes`; an event batch's records are moved into `events`, which is emptied
    /// first.
    ///
    /// # Arguments
    ///
    /// * `timeout` - how long to wait; zero checks once.
    /// * `slots` - room for at least a batch of slot ids.
    /// * `routes` - room for at least a batch of route ids.
    /// * `events` - where an event batch's records go.
    ///
    /// # Returns
    ///
    /// The batch.
    ///
    /// # Errors
    ///
    /// [`Status::InvalidArgument`] on an I/O worker thread, on a thread other than
    /// the bound one, while another thread is bound to one of the worker indexes,
    /// or with `slots` or `routes` shorter than a batch; [`Status::Timeout`] when
    /// nothing arrived in time or [`wake`](Self::wake) ended the wait;
    /// [`Status::Closed`] once the target is detached.
    pub fn poll(
        &self,
        timeout: Duration,
        slots: &mut [u64],
        routes: &mut [u32],
        events: &mut Vec<EventRec>,
    ) -> Result<Batch, HostError> {
        if zero_rt::is_worker_thread() {
            return Err(HostError::invalid(
                "a target cannot be polled on an I/O worker thread",
            ));
        }
        if slots.len() < self.batch || routes.len() < self.batch {
            return Err(HostError::invalid(format!(
                "the slot and route arrays must hold at least {} entries",
                self.batch
            )));
        }
        let deadline = Instant::now().checked_add(timeout);
        let mut queue = lock(&self.queue);
        if queue.gone {
            return Err(HostError::closed("the target is detached"));
        }
        self.bind()?;
        loop {
            if queue.gone {
                return Err(HostError::closed("the target is detached"));
            }
            if std::mem::take(&mut queue.woken) {
                return Err(HostError::new(Status::Timeout, "the poll was woken"));
            }
            if let Some(batch) = queue.batches.pop_front() {
                drop(queue);
                if let Some(taken) = self.deliver(batch, slots, routes, events)? {
                    return Ok(taken);
                }
                queue = lock(&self.queue);
                continue;
            }
            let left = deadline.map_or(LONGEST_WAIT, |at| {
                at.saturating_duration_since(Instant::now())
            });
            if left.is_zero() {
                return Err(HostError::new(Status::Timeout, "no batch arrived in time"));
            }
            queue = self
                .ready
                .wait_timeout(queue, left.min(LONGEST_WAIT))
                .map(|(guard, _)| guard)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        }
    }

    /// Bind the calling thread on its first poll, or check that it is the bound one.
    /// The caller holds the queue lock, so first polls bind one after the other and
    /// none binds once the target is detached. The target records the thread only
    /// once every worker index took it, so a refused poll leaves the target unbound
    /// and the next poll binds again.
    fn bind(&self) -> Result<(), HostError> {
        let token = thread_token();
        match self.bound.load(Ordering::Acquire) {
            0 => {}
            bound if bound == token => return Ok(()),
            _ => {
                return Err(HostError::invalid(
                    "the target is bound to the thread that polled it first",
                ))
            }
        }
        let elsewhere = |worker: &WorkerShared| {
            let bound = worker.intake.bound_thread();
            bound != 0 && bound != token
        };
        if let Some(worker) = self.workers.iter().find(|worker| elsewhere(worker)) {
            return Err(HostError::invalid(format!(
                "worker {} is bound to another thread",
                worker.index
            )));
        }
        for worker in &self.workers {
            if !worker.intake.bind_thread(token) {
                return Err(HostError::invalid(format!(
                    "worker {} is bound to another thread",
                    worker.index
                )));
            }
        }
        self.bound.store(token, Ordering::Release);
        Ok(())
    }

    /// Copy one batch out of its worker's ring; `None` for a batch that is no longer
    /// there, which a target loss can leave behind.
    fn deliver(
        &self,
        batch: BatchRef,
        slots: &mut [u64],
        routes: &mut [u32],
        events: &mut Vec<EventRec>,
    ) -> Result<Option<Batch>, HostError> {
        let Some(worker) = self
            .workers
            .iter()
            .find(|worker| worker.index == batch.worker)
        else {
            return Ok(None);
        };
        let delivered = match batch.kind {
            BATCH_REQUESTS => copy_batch(worker, batch, slots, routes),
            BATCH_EVENTS => worker.ring.take_events(batch, events).map_err(|_| ()),
            _ => Err(()),
        };
        Ok(delivered.ok().map(|()| Batch {
            worker: batch.worker,
            kind: batch.kind,
            count: u32::from(batch.count),
            epoch: batch.epoch,
        }))
    }

    /// End a blocked poll with [`Status::Timeout`], or the next one when no poll is
    /// blocked.
    pub fn wake(&self) {
        lock(&self.queue).woken = true;
        self.ready.notify_all();
    }

    /// Detach the target: every worker index it serves closes the target's leases
    /// and answers them 503, fails the queued requests the same way, and settles its
    /// acknowledgment floor, so the indexes the target held are released. The
    /// target's thread holds no view of a slot after this call.
    pub fn detach(&self) {
        self.stop();
        for worker in &self.workers {
            drop(worker.release_target(Some(self.serial)));
        }
    }

    /// Mark the target gone and end every poll.
    pub(crate) fn stop(&self) {
        let mut queue = lock(&self.queue);
        queue.gone = true;
        queue.batches.clear();
        drop(queue);
        self.ready.notify_all();
    }
}

/// Copy a request batch's ids into `slots` and `routes`.
fn copy_batch(
    worker: &WorkerShared,
    batch: BatchRef,
    slots: &mut [u64],
    routes: &mut [u32],
) -> Result<(), ()> {
    worker
        .ring
        .read(batch, |ids, route_ids| {
            if ids.len() > slots.len() || route_ids.len() > routes.len() {
                return Err(());
            }
            for (into, &id) in slots.iter_mut().zip(ids) {
                *into = id;
            }
            for (into, &route) in routes.iter_mut().zip(route_ids) {
                *into = route;
            }
            Ok(())
        })
        .map_err(|_| ())?
}

/// Copy a request batch a binding's own target received out of the worker's ring.
///
/// # Arguments
///
/// * `batch` - the batch reference the target was posted.
/// * `slots` - room for the batch's slot ids.
/// * `routes` - room for the batch's route ids.
///
/// # Returns
///
/// How many ids were copied.
///
/// # Errors
///
/// [`Status::Closed`] when the worker index is unknown or its ring moved on to
/// another batch, [`Status::InvalidArgument`] when the arrays are too short.
pub fn read_batch(
    batch: BatchRef,
    slots: &mut [u64],
    routes: &mut [u32],
) -> Result<usize, HostError> {
    let worker = registry::worker(batch.worker)
        .ok_or_else(|| HostError::closed(format!("worker {} is unknown", batch.worker)))?;
    let count = usize::from(batch.count);
    if slots.len() < count || routes.len() < count {
        return Err(HostError::invalid(
            "the slot and route arrays are too short",
        ));
    }
    copy_batch(worker, batch, slots, routes)
        .map_err(|()| HostError::closed("the batch is no longer in the ring"))?;
    Ok(count)
}

/// Move an event batch a binding's own target received out of the worker's ring.
///
/// # Arguments
///
/// * `batch` - the batch reference the target was posted.
/// * `events` - where the records go; emptied first.
///
/// # Errors
///
/// [`Status::Closed`] when the worker index is unknown or its ring moved on to
/// another batch.
pub fn take_events(batch: BatchRef, events: &mut Vec<EventRec>) -> Result<(), HostError> {
    let worker = registry::worker(batch.worker)
        .ok_or_else(|| HostError::closed(format!("worker {} is unknown", batch.worker)))?;
    worker
        .ring
        .take_events(batch, events)
        .map_err(|_| HostError::closed("the batch is no longer in the ring"))
}

/// Bind the calling thread to the target of a worker index, for a binding that
/// supplies its own target; only the bound thread's acknowledgments count. The
/// index must be held by a server, whose stop unbinds it, so no binding carries over
/// to the next server that claims the index.
///
/// # Arguments
///
/// * `worker` - the worker index.
///
/// # Errors
///
/// [`Status::InvalidArgument`] on an I/O worker thread or when another thread is
/// bound to the index, [`Status::Closed`] for an index no server holds.
pub fn bind_thread(worker: u8) -> Result<(), HostError> {
    if zero_rt::is_worker_thread() {
        return Err(HostError::invalid(
            "an I/O worker thread cannot be bound to a target",
        ));
    }
    let token = thread_token();
    match registry::while_held(worker, |shared| shared.intake.bind_thread(token)) {
        Some(true) => Ok(()),
        Some(false) => Err(HostError::invalid(format!(
            "worker {worker} is bound to another thread"
        ))),
        None => Err(HostError::closed(format!(
            "no server holds worker {worker}"
        ))),
    }
}

/// The status of one completed id, checked with one load of its slot's state word.
fn check(worker: u8, raw: u64) -> Status {
    #[cfg(feature = "testing")]
    crate::testing::reach(crate::testing::Point::Check(raw));
    if raw > MAX_ENCODED {
        return Status::InvalidArgument;
    }
    match SlotId::from_raw(raw) {
        Some(id) if id.worker() == worker => {}
        _ => return Status::InvalidArgument,
    }
    match registry::slot(raw) {
        Ok((_, id, slot)) => match slot
            .word()
            .check(id.generation(), &[SlotState::Leased, SlotState::Completing])
        {
            Ok(_) => Status::Ok,
            Err(_) => Status::Closed,
        },
        Err(err) => err.status(),
    }
}

/// Hand answered slots back to a worker and, from the thread bound to its target,
/// acknowledge a batch.
///
/// Each id is checked on its own with one load of its slot's state word, before
/// any lock is taken: an id above 2^53 - 1 or of another worker index is
/// [`Status::InvalidArgument`], a stale generation or a slot neither leased nor
/// completing is [`Status::Closed`]. The accepted ids and the acknowledgment are
/// then applied under one lock with one wake of the worker, so the worker, which
/// takes the same lock each turn, never waits for the checks. An acknowledgment is
/// accepted only from the bound thread, for the epoch after the last one
/// acknowledged and no later than the newest posted; a refused acknowledgment
/// changes no acknowledgment state, and the ids of the same call are still applied,
/// since completions release nothing on their own.
///
/// # Arguments
///
/// * `worker` - the worker index the ids belong to.
/// * `ids` - the answered slot ids.
/// * `epoch` - the epoch to acknowledge, or 0 for none.
/// * `results` - when given, the status of each id, at least `ids.len()` entries.
///
/// # Errors
///
/// [`Status::InvalidArgument`] for a worker index outside the 128, a `results`
/// shorter than `ids` (nothing is applied then), or a refused acknowledgment;
/// [`Status::Closed`] for a worker index no server claimed.
pub fn complete(
    worker: u8,
    ids: &[u64],
    epoch: u64,
    mut results: Option<&mut [Status]>,
) -> Result<(), HostError> {
    if u32::from(worker) >= zero_core::slot::MAX_WORKERS {
        return Err(HostError::invalid(format!(
            "worker {worker} is out of range"
        )));
    }
    let shared = registry::worker(worker)
        .ok_or_else(|| HostError::closed(format!("worker {worker} is unknown")))?;
    if results
        .as_ref()
        .is_some_and(|results| results.len() < ids.len())
    {
        return Err(HostError::invalid(
            "the results array is shorter than the ids",
        ));
    }
    let token = current_token();
    let bound = token != 0 && token == shared.intake.bound_thread();
    let acknowledged = if bound { epoch } else { 0 };
    let mut accepted = ACCEPTED.try_with(Cell::take).unwrap_or_default();
    accepted.clear();
    for (position, &raw) in ids.iter().enumerate() {
        let status = check(worker, raw);
        if let Some(slot) = results
            .as_deref_mut()
            .and_then(|results| results.get_mut(position))
        {
            *slot = status;
        }
        if status == Status::Ok {
            if let Some(id) = SlotId::from_raw(raw) {
                accepted.push(id);
            }
        }
    }
    let outcome = shared.intake.complete(accepted.drain(..), acknowledged);
    let _ = ACCEPTED.try_with(|kept| kept.set(accepted));
    if epoch == 0 {
        return Ok(());
    }
    let refusal = if !bound {
        Some("only the thread bound to the target acknowledges its batches")
    } else if outcome.is_err() {
        Some("the epoch is not the next one to acknowledge")
    } else {
        None
    };
    match refusal {
        Some(reason) => {
            shared.counters.refused_acks.fetch_add(1, Ordering::Relaxed);
            Err(HostError::invalid(format!(
                "the acknowledgment of epoch {epoch} was refused: {reason}"
            )))
        }
        None => Ok(()),
    }
}
