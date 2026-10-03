//! The worker-local slot allocator: warm and cold free lists, the epoch quarantine,
//! and the slots still pinned when a new server took the worker index.
//!
//! A retired index enters a FIFO quarantine stamped with the newest posted epoch and
//! leaves it once the host's acknowledgment floor reaches the stamp, so an index is
//! reused only after its pins reached zero and every batch posted before it was
//! retired was acknowledged. Stamps never decrease, so the quarantine stays sorted
//! and is released from its front. Leaving the quarantine releases the payload: at
//! most [`SLOTS_KEPT`] indexes keep their buffers on the FIFO warm list, the rest
//! give them back and wait on the cold list, which is used only when no warm index
//! is free. Capacities are reserved as the arena grows, so the warm path allocates
//! nothing. The invariants the allocator keeps are listed with the others in
//! [`arena`](crate::arena).

use std::collections::VecDeque;
use std::fmt;

use zero_core::SlotId;
use zero_limits::services::SLOTS_KEPT;

use crate::arena::{Arena, Payload, Slot};
use crate::slot::{Refused, SlotState};
use crate::sync::{self, MutexGuard, TryLock};

/// No index is free and the arena cannot grow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exhausted;

impl fmt::Display for Exhausted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("every slot of the arena is in use or quarantined")
    }
}

impl std::error::Error for Exhausted {}

/// How many times [`Allocator::adopt`] retries a slot whose pin count moves under it
/// before it leaves the slot to the next turn.
const SETTLE_ATTEMPTS: usize = 8;

/// A claimed index, its payload's guard, and the octets its reset released.
type Claimed<'a, T> = (SlotId, MutexGuard<'a, T>, u64);

/// What claiming one index from a list found.
enum Claim<'a, T> {
    /// The index is claimed and its payload reset under the returned guard.
    Got(Claimed<'a, T>),
    /// A host holds the index's lock; the index stays where it is.
    Busy,
    /// The index cannot be claimed; it leaves the list.
    Lost,
}

/// The free lists and the quarantine of one worker index.
#[derive(Debug)]
pub struct Allocator {
    warm: VecDeque<u16>,
    cold: Vec<u16>,
    quarantine: VecDeque<(u16, u64)>,
    limbo: Vec<u16>,
    live: usize,
    reserved: usize,
    adopted: u64,
}

impl Default for Allocator {
    fn default() -> Self {
        Self::new()
    }
}

impl Allocator {
    /// An allocator for an arena no server has used.
    ///
    /// # Returns
    ///
    /// The allocator, with empty lists.
    #[must_use]
    pub const fn new() -> Self {
        Allocator {
            warm: VecDeque::new(),
            cold: Vec::new(),
            quarantine: VecDeque::new(),
            limbo: Vec::new(),
            live: 0,
            reserved: 0,
            adopted: 0,
        }
    }

    /// An allocator for a server that takes a worker index an earlier server used.
    /// Every grown slot is brought to `Free`: a held slot is closed and retired when
    /// no pin holds it, and a pinned one waits in limbo for
    /// [`retry_limbo`](Self::retry_limbo). Each free slot's payload is released under
    /// `try_lock`, and the slot joins the warm list while fewer than [`SLOTS_KEPT`]
    /// are warm, the cold list beyond, so it can be allocated at once. The octets
    /// those releases took off the retained-memory count are returned by the next
    /// [`release`](Self::release). The generations continue, so a stale id from the
    /// earlier server reads nothing.
    ///
    /// # Arguments
    ///
    /// * `arena` - the arena of the worker index.
    ///
    /// # Returns
    ///
    /// The allocator.
    #[must_use]
    pub fn adopt<T: Payload>(arena: &Arena<T>) -> Self {
        let mut allocator = Self::new();
        allocator.reserve(arena.capacity());
        for (index, slot) in arena.slots() {
            if settle(slot) {
                let freed = allocator.shelve(Some(slot), index);
                allocator.adopted = allocator.adopted.saturating_add(freed);
            } else {
                allocator.limbo.push(index);
            }
        }
        allocator
    }

    /// Claim an index: the front of the warm list, else the cold list, else a new
    /// chunk, skipping any index whose lock a host holds. The payload is released as
    /// warm under its lock, and the guard is returned with the id so the caller
    /// exports and holds the slot before any host can lock it.
    ///
    /// # Arguments
    ///
    /// * `arena` - the arena of this worker index.
    ///
    /// # Returns
    ///
    /// The id at the slot's current generation, the payload's guard, and the octets
    /// the reset took off the retained-memory count.
    ///
    /// # Errors
    ///
    /// [`Exhausted`] when no index is free and the arena holds its limit.
    pub fn allocate<'a, T: Payload>(
        &mut self,
        arena: &'a Arena<T>,
    ) -> Result<(SlotId, MutexGuard<'a, T>, u64), Exhausted> {
        let mut position = 0;
        while let Some(&index) = self.warm.get(position) {
            match claim(arena, index) {
                Claim::Got(claimed) => {
                    self.warm.remove(position);
                    return Ok(self.count(claimed));
                }
                Claim::Busy => position = position.saturating_add(1),
                Claim::Lost => {
                    self.warm.remove(position);
                }
            }
        }
        let mut position = self.cold.len();
        while position > 0 {
            position = position.saturating_sub(1);
            let Some(&index) = self.cold.get(position) else {
                break;
            };
            match claim(arena, index) {
                Claim::Got(claimed) => {
                    self.cold.remove(position);
                    return Ok(self.count(claimed));
                }
                Claim::Busy => {}
                Claim::Lost => {
                    self.cold.remove(position);
                }
            }
        }
        let grown = arena.grow().ok_or(Exhausted)?;
        self.reserve(arena.capacity());
        let mut first = None;
        for index in grown.filter_map(|index| u16::try_from(index).ok()) {
            if first.is_none() {
                first = Some(index);
            } else if self.warm.len() < SLOTS_KEPT {
                self.warm.push_back(index);
            } else {
                self.cold.push(index);
            }
        }
        match first.map(|index| claim(arena, index)) {
            Some(Claim::Got(claimed)) => Ok(self.count(claimed)),
            _ => Err(Exhausted),
        }
    }

    /// Retire a slot and put its index in the quarantine, stamped with the newest
    /// posted epoch.
    ///
    /// # Arguments
    ///
    /// * `arena` - the arena of this worker index.
    /// * `id` - the slot id.
    /// * `stamp` - the newest epoch posted to the target.
    ///
    /// # Errors
    ///
    /// [`Refused::Unknown`] for an id of another arena; [`Refused::Readers`] while a
    /// pin is counted in, in which case the caller tries again later; otherwise what
    /// [`SlotWord::retire`](crate::slot::SlotWord::retire) refused.
    pub fn retire<T: Payload>(
        &mut self,
        arena: &Arena<T>,
        id: SlotId,
        stamp: u64,
    ) -> Result<(), Refused> {
        arena.lookup(id)?.word().retire(id.generation())?;
        self.quarantine.push_back((id.index(), stamp));
        self.live = self.live.saturating_sub(1);
        Ok(())
    }

    /// Release the quarantine's front while its stamp is at most `acked`: each payload
    /// is released under `try_lock` (a lock a host holds leaves the work to the reset
    /// in [`allocate`](Self::allocate)) and the index joins the warm list while fewer
    /// than [`SLOTS_KEPT`] are warm, the cold list beyond.
    ///
    /// # Arguments
    ///
    /// * `arena` - the arena of this worker index.
    /// * `acked` - the newest epoch the target acknowledged.
    ///
    /// # Returns
    ///
    /// The octets the releases took off the retained-memory count, with those the
    /// releases of [`adopt`](Self::adopt) took off and no call reported yet.
    pub fn release<T: Payload>(&mut self, arena: &Arena<T>, acked: u64) -> u64 {
        let mut freed = std::mem::take(&mut self.adopted);
        while let Some(&(index, stamp)) = self.quarantine.front() {
            if stamp > acked {
                break;
            }
            self.quarantine.pop_front();
            freed = freed.saturating_add(self.shelve(arena.slot(index), index));
        }
        freed
    }

    /// Try again to retire the slots still pinned when this allocator adopted the
    /// arena; each one that settles joins the quarantine stamped with `stamp`, so the
    /// quarantine stays sorted.
    ///
    /// # Arguments
    ///
    /// * `arena` - the arena of this worker index.
    /// * `stamp` - the newest epoch posted to the target.
    pub fn retry_limbo<T: Payload>(&mut self, arena: &Arena<T>, stamp: u64) {
        let mut position = 0;
        while let Some(&index) = self.limbo.get(position) {
            if arena.slot(index).is_none_or(settle) {
                self.limbo.swap_remove(position);
                self.quarantine.push_back((index, stamp));
            } else {
                position = position.saturating_add(1);
            }
        }
    }

    /// How many slots are claimed and not yet retired.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub const fn live(&self) -> usize {
        self.live
    }

    /// How many free indexes keep their buffers.
    ///
    /// # Returns
    ///
    /// The length of the warm list.
    #[must_use]
    pub fn warm(&self) -> usize {
        self.warm.len()
    }

    /// How many free indexes gave their buffers back.
    ///
    /// # Returns
    ///
    /// The length of the cold list.
    #[must_use]
    pub fn cold(&self) -> usize {
        self.cold.len()
    }

    /// How many retired indexes wait for the acknowledgment floor.
    ///
    /// # Returns
    ///
    /// The length of the quarantine.
    #[must_use]
    pub fn quarantined(&self) -> usize {
        self.quarantine.len()
    }

    /// How many slots adopted from an earlier server are still pinned.
    ///
    /// # Returns
    ///
    /// The length of the limbo list.
    #[must_use]
    pub fn limbo(&self) -> usize {
        self.limbo.len()
    }

    /// How many indexes the lists have room for: the arena's capacity when it last
    /// grew or was adopted. The dispatcher reserves its own vectors and the intake's
    /// to this count on the turn that sees it rise.
    ///
    /// # Returns
    ///
    /// The count.
    #[must_use]
    pub const fn reserved(&self) -> usize {
        self.reserved
    }

    /// The capacities of the lists, for the test that a warm path grows none.
    #[cfg(test)]
    pub(crate) fn capacities(&self) -> [usize; 3] {
        [
            self.warm.capacity(),
            self.cold.capacity(),
            self.quarantine.capacity(),
        ]
    }

    /// Count a claim as live and hand it out.
    fn count<'a, T>(&mut self, claimed: Claimed<'a, T>) -> Claimed<'a, T> {
        self.live = self.live.saturating_add(1);
        claimed
    }

    /// Make room for `total` indexes on every list, so the warm path allocates
    /// nothing.
    fn reserve(&mut self, total: usize) {
        let warm = total.min(SLOTS_KEPT);
        self.warm.reserve(warm.saturating_sub(self.warm.len()));
        self.cold.reserve(total.saturating_sub(self.cold.len()));
        self.quarantine
            .reserve(total.saturating_sub(self.quarantine.len()));
        self.reserved = self.reserved.max(total);
    }

    /// Release a free slot's payload and put its index on the warm list while fewer
    /// than [`SLOTS_KEPT`] are warm, on the cold list beyond.
    fn shelve<T: Payload>(&mut self, slot: Option<&Slot<T>>, index: u16) -> u64 {
        let cold = self.warm.len() >= SLOTS_KEPT;
        let freed = slot.map_or(0, |slot| release_payload(slot, cold));
        if cold {
            self.cold.push(index);
        } else {
            self.warm.push_back(index);
        }
        freed
    }
}

/// Claim `index`: take its lock without waiting, move it from `Free` to `Parsing`,
/// and release its payload as warm under the lock.
fn claim<T: Payload>(arena: &Arena<T>, index: u16) -> Claim<'_, T> {
    let Some(slot) = arena.slot(index) else {
        return Claim::Lost;
    };
    let mut guard = match sync::try_lock(slot.payload()) {
        TryLock::Locked(guard) => guard,
        TryLock::Poisoned(guard) => {
            sync::clear_poison(slot.payload());
            guard
        }
        TryLock::Busy => return Claim::Busy,
    };
    let generation = slot.word().generation();
    let Some(id) = SlotId::new(arena.worker(), generation, index) else {
        return Claim::Lost;
    };
    if slot.word().claim(generation).is_err() {
        return Claim::Lost;
    }
    let freed = guard.release(slot.view(), false);
    Claim::Got((id, guard, freed))
}

/// Release a slot's payload if its lock is free.
fn release_payload<T: Payload>(slot: &Slot<T>, cold: bool) -> u64 {
    match sync::try_lock(slot.payload()) {
        TryLock::Locked(mut guard) => guard.release(slot.view(), cold),
        TryLock::Poisoned(mut guard) => {
            sync::clear_poison(slot.payload());
            guard.release(slot.view(), cold)
        }
        TryLock::Busy => 0,
    }
}

/// Bring a slot an earlier server left behind to `Free`: close what is held, retire
/// it when no pin is counted in.
///
/// # Returns
///
/// Whether the slot is free now.
fn settle<T: Payload>(slot: &Slot<T>) -> bool {
    let word = slot.word();
    for _ in 0..SETTLE_ATTEMPTS {
        let generation = word.generation();
        let outcome = match word.state() {
            SlotState::Free => return true,
            SlotState::Leased => word.close_leased(generation),
            SlotState::Parsing | SlotState::WorkerOwned => word.close(generation),
            SlotState::Completing | SlotState::Closed => match word.retire(generation) {
                Ok(_) => return true,
                Err(refused) => Err(refused),
            },
        };
        if let Err(Refused::Readers(_)) = outcome {
            return false;
        }
    }
    false
}
