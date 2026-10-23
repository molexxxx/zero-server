//! The process registry: the permanent state of each worker index and the pool of
//! indexes servers claim.
//!
//! A worker index's arena, intake, batch ring and counters are created the first time
//! a server claims the index and live for the rest of the process, so an id a host
//! holds from an earlier server is checked against the same generations and reads
//! `Closed`. A server claims the lowest free indexes and gives them back once it
//! stopped, with no target attached and no thread bound; the next server to claim
//! one adopts its arena.

use std::sync::{Arc, Mutex, OnceLock};

use zero_core::slot::{MAX_ENCODED, MAX_WORKERS, SLOTS_PER_WORKER};
use zero_core::SlotId;
use zero_http::{Exchange, PublishedView};
use zero_limits::services::{MAX_BATCHES_IN_FLIGHT_CEILING, MAX_BATCH_SIZE};
use zero_rt::{Arena, BatchRing, Counters, Intake, Payload, Reset, Slot, Target};

use crate::target::PullTarget;
use crate::HostError;

/// The worker indexes a process can hold.
const WORKER_COUNT: usize = MAX_WORKERS as usize;

/// The slots one chunk of an arena holds.
const CHUNK: usize = 256;

/// The payload of one slot: the exchange a host reads and answers.
///
/// The arena's payload trait lives in `zero-rt` and the exchange in `zero-http`, so
/// the payload is this wrapper. Releasing it clears and shrinks the exchange and
/// returns the octets it still counted; the published view keeps its last values,
/// which every reader checks against the slot's generation before it trusts them.
#[derive(Debug, Default)]
pub struct HostExchange(pub Exchange);

impl Reset for HostExchange {
    fn reset(&mut self) {
        self.0.reset();
    }
}

impl Payload for HostExchange {
    type View = PublishedView;

    fn release(&mut self, _view: &PublishedView, cold: bool) -> u64 {
        self.0.release(cold)
    }
}

/// The target attached to a worker index.
pub(crate) enum Attached {
    /// A pull target of the server.
    Pull(Arc<PullTarget>),
    /// A binding's own target, with the serial the server gave it.
    Own(u64, Arc<dyn Target>),
}

impl Attached {
    fn serial(&self) -> u64 {
        match self {
            Attached::Pull(target) => target.serial(),
            Attached::Own(serial, _) => *serial,
        }
    }

    fn target(&self) -> Arc<dyn Target> {
        match self {
            Attached::Pull(target) => Arc::clone(target) as Arc<dyn Target>,
            Attached::Own(_, target) => Arc::clone(target),
        }
    }
}

/// The permanent state of one worker index.
pub(crate) struct WorkerShared {
    pub(crate) index: u8,
    pub(crate) arena: Arena<HostExchange>,
    pub(crate) intake: Intake,
    pub(crate) ring: BatchRing,
    pub(crate) counters: Arc<Counters>,
    /// The target attached to this index, if any.
    target: Mutex<Option<Attached>>,
    #[cfg(feature = "testing")]
    pub(crate) hooks: crate::testing::Hooks,
}

impl std::fmt::Debug for WorkerShared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerShared")
            .field("index", &self.index)
            .field("intake", &self.intake)
            .finish_non_exhaustive()
    }
}

impl WorkerShared {
    fn new(index: u8) -> Option<Self> {
        let limit = usize::try_from(SLOTS_PER_WORKER).ok()?;
        Some(WorkerShared {
            index,
            arena: Arena::new(index, CHUNK, limit)?,
            intake: Intake::new(),
            ring: BatchRing::new(MAX_BATCHES_IN_FLIGHT_CEILING, MAX_BATCH_SIZE),
            counters: Arc::new(Counters::default()),
            target: Mutex::new(None),
            #[cfg(feature = "testing")]
            hooks: crate::testing::Hooks::default(),
        })
    }

    /// Check that no target is attached.
    ///
    /// # Errors
    ///
    /// [`Status::Limit`](crate::Status::Limit) when one is.
    pub(crate) fn check_free(&self) -> Result<(), HostError> {
        free(self.index, lock(&self.target).as_ref())
    }

    /// Record `attached` as this index's target and hand it to the worker, which
    /// takes it on its next turn, in one step.
    ///
    /// # Errors
    ///
    /// [`Status::Limit`](crate::Status::Limit) when a target is already attached.
    pub(crate) fn claim_target(&self, attached: Attached) -> Result<(), HostError> {
        let mut target = lock(&self.target);
        free(self.index, target.as_ref())?;
        self.intake.attach(attached.target());
        *target = Some(attached);
        Ok(())
    }

    /// Detach the target `serial` names, or whichever is attached when `serial` is
    /// `None`; the worker applies the loss on its next turn. A pull target is
    /// stopped before the index unbinds its thread, so no poll of it can bind the
    /// index again.
    ///
    /// # Returns
    ///
    /// The target detached, if any.
    pub(crate) fn release_target(&self, serial: Option<u64>) -> Option<Attached> {
        let mut target = lock(&self.target);
        let named = match (&*target, serial) {
            (Some(attached), Some(wanted)) => attached.serial() == wanted,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if !named {
            return None;
        }
        let released = target.take()?;
        if let Attached::Pull(pull) = &released {
            pull.stop();
        }
        self.intake.detach();
        Some(released)
    }

    /// Hand the attached target to the worker again, after a start whose cores may
    /// have taken it from the intake and ended.
    pub(crate) fn requeue_target(&self) {
        if let Some(attached) = lock(&self.target).as_ref() {
            self.intake.attach(attached.target());
        }
    }
}

/// The refusal of a second target on worker index `index`.
fn free(index: u8, target: Option<&Attached>) -> Result<(), HostError> {
    match target {
        Some(_) => Err(HostError::limit(format!(
            "worker {index} already has a target"
        ))),
        None => Ok(()),
    }
}

/// Lock a registry mutex, taking the data back from a poisoned lock: every value it
/// guards stays consistent between statements.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

static WORKERS: [OnceLock<Arc<WorkerShared>>; WORKER_COUNT] =
    [const { OnceLock::new() }; WORKER_COUNT];

/// One bit per claimed worker index.
static CLAIMED: Mutex<u128> = Mutex::new(0);

/// The state of worker index `index`, once a server has claimed it.
pub(crate) fn worker(index: u8) -> Option<&'static Arc<WorkerShared>> {
    WORKERS.get(usize::from(index))?.get()
}

/// The state of worker index `index`, created on first use.
fn ensure(index: u8) -> Option<&'static Arc<WorkerShared>> {
    let cell = WORKERS.get(usize::from(index))?;
    if let Some(existing) = cell.get() {
        return Some(existing);
    }
    let created = Arc::new(WorkerShared::new(index)?);
    Some(cell.get_or_init(|| created))
}

/// Run `f` on the state of worker index `index` while a server holds the index,
/// under the pool's lock, so the server cannot give it back meanwhile.
///
/// # Returns
///
/// What `f` returned, or `None` when no server holds the index.
pub(crate) fn while_held<R>(index: u8, f: impl FnOnce(&WorkerShared) -> R) -> Option<R> {
    let claimed = lock(&CLAIMED);
    if *claimed & bit(index) == 0 {
        return None;
    }
    let shared = worker(index)?;
    let outcome = f(shared);
    drop(claimed);
    Some(outcome)
}

/// How many worker indexes no server holds.
///
/// # Returns
///
/// The count, at most 128.
#[must_use]
pub fn free_workers() -> usize {
    let claimed = *lock(&CLAIMED);
    usize::try_from(claimed.count_zeros()).unwrap_or(0)
}

/// The worker indexes a server holds; they return to the pool when it drops, each
/// with its thread unbound, so a thread that bound one while its server stopped
/// does not stay bound for the next server.
#[derive(Debug)]
pub(crate) struct Claim {
    indexes: Vec<u8>,
}

impl Claim {
    pub(crate) fn indexes(&self) -> &[u8] {
        &self.indexes
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut claimed = lock(&CLAIMED);
        for &index in &self.indexes {
            *claimed &= !bit(index);
            if let Some(shared) = worker(index) {
                shared.intake.detach();
            }
        }
    }
}

fn bit(index: u8) -> u128 {
    1u128.checked_shl(u32::from(index)).unwrap_or(0)
}

/// Claim worker indexes, the lowest free ones first, and create their state.
///
/// # Arguments
///
/// * `requested` - how many; 0 takes the smaller of the available parallelism and
///   the free indexes, at least 1.
///
/// # Errors
///
/// [`Status::Limit`](crate::Status::Limit) when fewer indexes are free than
/// requested, or none at all.
pub(crate) fn claim(requested: usize) -> Result<Claim, HostError> {
    let mut claimed = lock(&CLAIMED);
    let free = usize::try_from(claimed.count_zeros()).unwrap_or(0);
    let count = if requested == 0 {
        std::thread::available_parallelism()
            .map_or(1, std::num::NonZeroUsize::get)
            .min(free)
    } else {
        requested
    };
    if count == 0 || count > free {
        return Err(HostError::limit(format!(
            "{count} worker indexes were asked for and {free} are free"
        )));
    }
    let mut indexes = Vec::with_capacity(count);
    for index in (0..=u8::MAX).take(WORKER_COUNT) {
        if indexes.len() == count {
            break;
        }
        if *claimed & bit(index) == 0 && ensure(index).is_some() {
            *claimed |= bit(index);
            indexes.push(index);
        }
    }
    if indexes.len() < count {
        for &index in &indexes {
            *claimed &= !bit(index);
        }
        return Err(HostError::limit("the worker indexes could not be created"));
    }
    Ok(Claim { indexes })
}

/// The worker state and slot an id names, before any generation check.
///
/// # Errors
///
/// [`Status::InvalidArgument`](crate::Status::InvalidArgument) for an id above
/// 2^53 - 1, [`Status::Closed`](crate::Status::Closed) for a worker index no
/// server claimed or an index its arena never grew to.
pub(crate) fn slot(
    raw: u64,
) -> Result<(&'static WorkerShared, SlotId, &'static Slot<HostExchange>), HostError> {
    if raw > MAX_ENCODED {
        return Err(HostError::invalid(format!(
            "the slot id {raw} is out of range"
        )));
    }
    let id = SlotId::from_raw(raw)
        .ok_or_else(|| HostError::invalid(format!("the slot id {raw} is out of range")))?;
    let shared = worker(id.worker())
        .ok_or_else(|| HostError::closed(format!("the slot id {raw} names no worker")))?;
    let slot = shared
        .arena
        .lookup(id)
        .map_err(|_| HostError::closed(format!("the slot id {raw} names no slot")))?;
    Ok((shared, id, slot))
}
