//! The per-worker request arena: a fixed spine of chunks of slots, each chunk set
//! once and never moved, shared with host threads without any `unsafe` code.
//!
//! A [`Slot`] holds the [`SlotWord`] that says who may touch it, the epoch of the batch
//! that delivered its current lease, its payload behind a `Mutex`, and the payload's
//! published view: atomics the worker stores before a lease and hosts read without
//! the lock. Hosts check the word before and inside the lock (lock-then-check) and
//! read the view between two word loads, so a stale id reads nothing and never
//! touches the worker's lock; the worker takes a slot's lock only with `try_lock`, so
//! it never waits on a host.
//!
//! [`Arena`] is `Sync` from its parts alone: `OnceLock` chunks, atomics, `Mutex`
//! payloads and views that are `Sync`. Its spine is created before the worker starts,
//! so a host lookup never races a reallocation, and no `&mut` to a slot is ever
//! formed.
//!
//! These are the statements the loom models and the ThreadSanitizer test check, for
//! the arena, the allocator and the intake together:
//!
//! - Only the worker changes the state bits; hosts change only the pin count.
//! - The worker writes the request side and the view under the lock between `claim`
//!   and `hold`. After that it writes them only in the release that clears a slot
//!   for reuse, under `try_lock` and after `retire` moved the generation past every
//!   id a host can hold, so a host that checks the word never takes the cleared
//!   values for its own request.
//! - The request side and the view are otherwise frozen from `hold` until the slot
//!   is retired.
//! - A host reads the payload only under the lock with the word at the id's
//!   generation in `Leased` or `Completing`, or through the view between two such
//!   word loads.
//! - A host writes the response side only under the lock with the word `Leased` at
//!   the id's generation.
//! - The worker reads or swaps the response side only after `begin_import`, under
//!   `try_lock`.
//! - `retire` requires no pin and bumps the generation in the same
//!   compare-and-swap.
//! - `allocate` resets, exports and holds a slot under one acquisition of its lock.
//! - `allocate` takes an index only from the warm or cold list or a new chunk. A
//!   retired index joins those lists only once its stamp is at most the
//!   acknowledgment floor, and a slot's delivering epoch is at most its stamp; an
//!   index adopted from an earlier server joins them at once, since that server's
//!   target is gone and no view of it can exist.
//! - `acked` advances by one per accepted acknowledgment, or to `published` when the
//!   worker settles a lost target. The intake does not see the calling thread: its
//!   caller passes an epoch to [`Intake::complete`] only from the thread bound to
//!   the target.
//! - `published` holds a batch's epoch before the batch is posted, and returns to
//!   the previous value only when the post did not deliver it.
//! - No fence: every ordering comes from a lock, a compare-and-swap, or a release
//!   store and acquire load pair.
//!
//! [`Intake::complete`]: crate::intake::Intake::complete

use std::fmt;
use std::ops::Range;
use std::sync::OnceLock;

use zero_core::slot::{MAX_WORKERS, SLOTS_PER_WORKER};
use zero_core::SlotId;

use crate::slot::{Refused, SlotState, SlotWord};
use crate::sync::{self, AtomicU64, Mutex, Ordering, TryLock};

/// A record the arena reuses: `reset` returns it to its empty state and keeps whatever
/// capacity it holds, so a slot allocated again allocates nothing.
pub trait Reset: Default {
    /// Return to the empty state, keeping capacity.
    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// What a slot carries: the request a host reads and the response it writes.
pub trait Payload: Reset + Send + 'static {
    /// Atomics the worker publishes before a lease and hosts read without the lock.
    type View: Default + Send + Sync;

    /// Clear the payload for reuse, keeping a bounded part of each buffer, or nothing
    /// when `cold`, and clear what `view` publishes about it.
    ///
    /// # Arguments
    ///
    /// * `view` - the slot's published view.
    /// * `cold` - whether the slot leaves the warm list, so it keeps no buffer.
    ///
    /// # Returns
    ///
    /// The octets taken off the worker's retained-memory count.
    fn release(&mut self, view: &Self::View, cold: bool) -> u64;
}

/// The states the worker reaches a slot's payload in outside a lease.
const WORKER_STATES: &[SlotState] = &[
    SlotState::Parsing,
    SlotState::WorkerOwned,
    SlotState::Completing,
    SlotState::Closed,
];

/// The states a host may read a slot in.
const READ_STATES: &[SlotState] = &[SlotState::Leased, SlotState::Completing];

/// One slot: its state word, the epoch of its lease, its payload and published view.
///
/// Aligned to 64 octets so one slot's word, lock and view stay off its neighbors'
/// cache lines.
#[repr(align(64))]
pub struct Slot<T: Payload> {
    word: SlotWord,
    lease_epoch: AtomicU64,
    payload: Mutex<T>,
    view: T::View,
}

impl<T: Payload> fmt::Debug for Slot<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Slot")
            .field("word", &self.word)
            .field("lease_epoch", &self.lease_epoch())
            .finish_non_exhaustive()
    }
}

impl<T: Payload> Slot<T> {
    fn new() -> Self {
        Slot {
            word: SlotWord::new(),
            lease_epoch: AtomicU64::new(0),
            payload: Mutex::new(T::default()),
            view: T::View::default(),
        }
    }

    /// The slot's state word.
    ///
    /// # Returns
    ///
    /// The word.
    #[must_use]
    pub const fn word(&self) -> &SlotWord {
        &self.word
    }

    /// The epoch of the batch that delivered the current lease.
    ///
    /// # Returns
    ///
    /// The epoch, from an acquire load; 0 before the first lease.
    #[must_use]
    pub fn lease_epoch(&self) -> u64 {
        self.lease_epoch.load(Ordering::Acquire)
    }

    /// Record the epoch of the batch the lease is delivered in, before the batch is
    /// posted.
    pub(crate) fn set_lease_epoch(&self, epoch: u64) {
        self.lease_epoch.store(epoch, Ordering::Release);
    }

    /// The published view, for the worker's export: it stores the view with release
    /// ordering while it holds the guard [`Allocator::allocate`] returned.
    ///
    /// [`Allocator::allocate`]: crate::alloc::Allocator::allocate
    ///
    /// # Returns
    ///
    /// The view.
    #[must_use]
    pub const fn view(&self) -> &T::View {
        &self.view
    }

    /// Host read: check the word, lock, check the word again, run `f`, unlock.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the id the host holds.
    /// * `f` - the read; it runs under the lock.
    ///
    /// # Returns
    ///
    /// What `f` returned.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] or [`Refused::State`] unless the slot is leased or
    /// completing at `generation`, before the lock is taken or inside it;
    /// [`Refused::Poisoned`] when a panic poisoned the lock.
    pub fn with_read<R>(&self, generation: u32, f: impl FnOnce(&T) -> R) -> Result<R, Refused> {
        self.word.check(generation, READ_STATES)?;
        let guard = sync::lock(&self.payload).map_err(|_| Refused::Poisoned)?;
        self.word.check(generation, READ_STATES)?;
        Ok(f(&guard))
    }

    /// Host write: check the word, lock, check that the slot is still leased at
    /// `generation`, run `f`, unlock.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the id the host holds.
    /// * `f` - the write; it runs under the lock.
    ///
    /// # Returns
    ///
    /// What `f` returned.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] or [`Refused::State`] unless the slot is leased at
    /// `generation`; [`Refused::Poisoned`] when a panic poisoned the lock.
    pub fn with_write<R>(
        &self,
        generation: u32,
        f: impl FnOnce(&mut T) -> R,
    ) -> Result<R, Refused> {
        self.word.check(generation, &[SlotState::Leased])?;
        let mut guard = sync::lock(&self.payload).map_err(|_| Refused::Poisoned)?;
        self.word.check(generation, &[SlotState::Leased])?;
        Ok(f(&mut guard))
    }

    /// Host view: load the word, run `f` over the published atomics, load the word
    /// again. Every value `f` can see for a later generation was stored after the
    /// word moved past `generation`, so a snapshot that saw one fails the second load.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the id the host holds.
    /// * `f` - the snapshot; it reads the view with acquire loads.
    ///
    /// # Returns
    ///
    /// What `f` returned, when both loads show the slot leased or completing at
    /// `generation`.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] or [`Refused::State`] when either load does not.
    pub fn read_view<R>(
        &self,
        generation: u32,
        f: impl FnOnce(&T::View) -> R,
    ) -> Result<R, Refused> {
        self.word.check(generation, READ_STATES)?;
        let snapshot = f(&self.view);
        self.word.check(generation, READ_STATES)?;
        Ok(snapshot)
    }

    /// Worker access outside a lease: `try_lock` only, so the worker never waits on a
    /// host.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    /// * `f` - the access, with the payload and its view.
    ///
    /// # Returns
    ///
    /// What `f` returned.
    ///
    /// # Errors
    ///
    /// [`Refused::Busy`] while a host holds the lock, [`Refused::Poisoned`] when a
    /// panic poisoned it, [`Refused::Stale`] for another generation, and
    /// [`Refused::State`] for a free or leased slot.
    pub fn with_worker<R>(
        &self,
        generation: u32,
        f: impl FnOnce(&mut T, &T::View) -> R,
    ) -> Result<R, Refused> {
        let mut guard = match sync::try_lock(&self.payload) {
            TryLock::Locked(guard) => guard,
            TryLock::Busy => return Err(Refused::Busy),
            TryLock::Poisoned(_) => return Err(Refused::Poisoned),
        };
        self.word.check(generation, WORKER_STATES)?;
        Ok(f(&mut guard, &self.view))
    }

    /// The payload's lock, for the allocator.
    pub(crate) const fn payload(&self) -> &Mutex<T> {
        &self.payload
    }
}

/// A chunked arena of [`Slot`]s, addressed by [`SlotId`]; permanent per worker index.
pub struct Arena<T: Payload> {
    worker: u8,
    chunk: usize,
    limit: usize,
    chunks: Box<[Chunk<T>]>,
}

/// One cell of the spine: a chunk of slots, set once by the worker.
type Chunk<T> = OnceLock<Box<[Slot<T>]>>;

impl<T: Payload> fmt::Debug for Arena<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Arena")
            .field("worker", &self.worker)
            .field("chunk", &self.chunk)
            .field("limit", &self.limit)
            .field("capacity", &self.capacity())
            .finish()
    }
}

impl<T: Payload> Arena<T> {
    /// An arena for worker index `worker` whose spine has room for `limit` slots in
    /// chunks of `chunk`; no chunk is allocated yet.
    ///
    /// # Arguments
    ///
    /// * `worker` - the worker index the slot ids carry.
    /// * `chunk` - the slots one chunk holds; at least 1 is used.
    /// * `limit` - the most slots the arena will hold; at most 65,536 are used.
    ///
    /// # Returns
    ///
    /// The arena, or `None` when `worker` is not below 128.
    #[must_use]
    pub fn new(worker: u8, chunk: usize, limit: usize) -> Option<Self> {
        if u32::from(worker) >= MAX_WORKERS {
            return None;
        }
        let max = usize::try_from(SLOTS_PER_WORKER).unwrap_or(usize::MAX);
        let limit = limit.clamp(1, max);
        let chunk = chunk.clamp(1, limit);
        let cells = limit.div_ceil(chunk);
        let chunks = (0..cells).map(|_| OnceLock::new()).collect();
        Some(Arena {
            worker,
            chunk,
            limit,
            chunks,
        })
    }

    /// The worker index the slot ids carry.
    ///
    /// # Returns
    ///
    /// The index.
    #[must_use]
    pub const fn worker(&self) -> u8 {
        self.worker
    }

    /// The slots one chunk holds.
    ///
    /// # Returns
    ///
    /// The chunk size.
    #[must_use]
    pub const fn chunk(&self) -> usize {
        self.chunk
    }

    /// The most slots the arena will hold.
    ///
    /// # Returns
    ///
    /// The limit.
    #[must_use]
    pub const fn limit(&self) -> usize {
        self.limit
    }

    /// How many slots the grown chunks hold.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.chunks
            .iter()
            .filter_map(OnceLock::get)
            .map(|chunk| chunk.len())
            .sum()
    }

    /// The slot at `index`, if its chunk is grown; never blocks.
    ///
    /// # Arguments
    ///
    /// * `index` - the arena index.
    ///
    /// # Returns
    ///
    /// The slot, or `None` for an index the arena has not grown to.
    #[must_use]
    pub fn slot(&self, index: u16) -> Option<&Slot<T>> {
        let index = usize::from(index);
        let cell = index.checked_div(self.chunk)?;
        let offset = index.checked_rem(self.chunk)?;
        self.chunks.get(cell)?.get()?.get(offset)
    }

    /// The slot an id names, whatever its generation; the accessors check that.
    ///
    /// # Arguments
    ///
    /// * `id` - the slot id.
    ///
    /// # Returns
    ///
    /// The slot.
    ///
    /// # Errors
    ///
    /// [`Refused::Unknown`] for another worker's id or an index the arena has not
    /// grown to.
    pub fn lookup(&self, id: SlotId) -> Result<&Slot<T>, Refused> {
        if id.worker() != self.worker {
            return Err(Refused::Unknown);
        }
        self.slot(id.index()).ok_or(Refused::Unknown)
    }

    /// Set the next chunk of the spine; for the worker only.
    ///
    /// Every new slot's lock is taken and released once before the chunk is
    /// published. std's mutex on Apple targets and the other pthread platforms
    /// allocates its pthread mutex on first use, so taking each lock here keeps
    /// that allocation with the chunk's own and leaves a slot's first request
    /// allocation-free, as every later one is.
    ///
    /// # Returns
    ///
    /// The indexes of the new slots, or `None` when the arena holds its limit.
    pub fn grow(&self) -> Option<Range<u32>> {
        let cell = self.chunks.iter().position(|cell| cell.get().is_none())?;
        let first = cell.checked_mul(self.chunk)?;
        let count = self.chunk.min(self.limit.saturating_sub(first));
        let slots: Box<[Slot<T>]> = (0..count).map(|_| Slot::new()).collect();
        #[cfg(not(zero_loom))]
        for slot in &*slots {
            drop(sync::lock_recovered(&slot.payload));
        }
        self.chunks.get(cell)?.set(slots).ok()?;
        let start = u32::try_from(first).ok()?;
        let end = u32::try_from(first.saturating_add(count)).ok()?;
        Some(start..end)
    }

    /// Every grown slot with its index, in index order.
    ///
    /// # Returns
    ///
    /// The slots.
    pub fn slots(&self) -> impl Iterator<Item = (u16, &Slot<T>)> {
        self.chunks
            .iter()
            .filter_map(OnceLock::get)
            .flat_map(|chunk| chunk.iter())
            .enumerate()
            .filter_map(|(index, slot)| Some((u16::try_from(index).ok()?, slot)))
    }
}
