//! The per-worker request arena: chunked, stable addresses, never reallocated.
//!
//! Slots live in fixed chunks that are added as the arena grows and never moved, so
//! an address handed to a host while a slot is leased stays valid however many slots
//! are allocated after it (`DESIGN.md` section 7.3). Each slot carries its
//! [`SlotWord`]; a freed index waits on the free list and comes back with the next
//! generation, which the slot id must match. The worker addresses a slot through its
//! exclusive borrow of the arena, which is how the crate hands out `&mut` without
//! `unsafe`; the audited FFI crate reaches a leased slot through the word's borrow
//! protocol instead.

use std::cell::UnsafeCell;

use zero_core::slot::SLOTS_PER_WORKER;
use zero_core::{Error, Result, SlotId};

use crate::slot::{Refused, SlotState, SlotWord};

/// One slot: its state word and the request record.
#[derive(Debug)]
struct Entry<T> {
    word: SlotWord,
    value: UnsafeCell<T>,
}

/// A chunked arena of `T`, addressed by [`SlotId`].
#[derive(Debug)]
pub struct Arena<T> {
    worker: u8,
    chunk: usize,
    chunks: Vec<Box<[Entry<T>]>>,
    free: Vec<u16>,
    live: usize,
    limit: usize,
}

impl<T: Default> Arena<T> {
    /// An empty arena for worker `worker`, growing by `chunk` slots at a time up to
    /// `limit` slots.
    ///
    /// # Arguments
    ///
    /// * `worker` - the worker index the slot ids carry; below 128.
    /// * `chunk` - how many slots one chunk holds; at least 1.
    /// * `limit` - the most slots the arena will ever hold; at most 65,536.
    ///
    /// # Returns
    ///
    /// The arena, with no chunk allocated yet.
    #[must_use]
    pub fn new(worker: u8, chunk: usize, limit: usize) -> Self {
        let max = usize::try_from(SLOTS_PER_WORKER).unwrap_or(usize::MAX);
        Arena {
            worker,
            chunk: chunk.max(1),
            chunks: Vec::new(),
            free: Vec::new(),
            live: 0,
            limit: limit.min(max),
        }
    }

    /// How many slots are allocated right now.
    #[must_use]
    pub const fn live(&self) -> usize {
        self.live
    }

    /// How many slots exist, allocated or free.
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.chunks.iter().map(|chunk| chunk.len()).sum()
    }

    /// The most slots the arena will ever hold.
    #[must_use]
    pub const fn limit(&self) -> usize {
        self.limit
    }

    /// Allocate a slot: a free one first, else a slot of a new chunk. The slot moves
    /// to `Parsing` and the record is reset to its default.
    ///
    /// # Returns
    ///
    /// The slot id, with the slot's current generation.
    ///
    /// # Errors
    ///
    /// [`Error::Limit`] at the arena's limit.
    pub fn allocate(&mut self) -> Result<SlotId> {
        let index = match self.free.pop() {
            Some(index) => index,
            None => self.grow()?,
        };
        let entry = self.entry_mut(index)?;
        entry
            .word
            .transition(SlotState::Free, SlotState::Parsing)
            .map_err(|_| Error::Closed)?;
        *entry.value.get_mut() = T::default();
        let generation = entry.word.generation();
        self.live = self.live.saturating_add(1);
        SlotId::new(self.worker, generation, index).ok_or(Error::Closed)
    }

    /// The record of a live slot, for the worker.
    ///
    /// # Arguments
    ///
    /// * `id` - the slot id; its generation must be current.
    ///
    /// # Returns
    ///
    /// The record and its state word.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] for another worker's id, a stale generation or a free slot.
    pub fn get_mut(&mut self, id: SlotId) -> Result<(&mut T, &SlotWord)> {
        if id.worker() != self.worker {
            return Err(Error::Closed);
        }
        let entry = self.entry_mut(id.index())?;
        if entry.word.generation() != id.generation() || entry.word.state() == SlotState::Free {
            return Err(Error::Closed);
        }
        Ok((entry.value.get_mut(), &entry.word))
    }

    /// The state word of a slot, for transitions and host borrows.
    ///
    /// # Arguments
    ///
    /// * `id` - the slot id.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] for another worker's id or an index the arena has not grown
    /// to.
    pub fn word(&self, id: SlotId) -> Result<&SlotWord> {
        if id.worker() != self.worker {
            return Err(Error::Closed);
        }
        self.entry(id.index()).map(|entry| &entry.word)
    }

    /// Return a slot to the free list with the next generation; refused while a host
    /// reader is counted in, in which case the caller tries again later.
    ///
    /// # Arguments
    ///
    /// * `id` - the slot id; its generation must be current.
    ///
    /// # Returns
    ///
    /// Nothing; the record keeps its last contents until the slot is allocated again.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] for a stale or foreign id, [`Error::Limit`] while readers are
    /// counted in or the slot is leased.
    pub fn free(&mut self, id: SlotId) -> Result<()> {
        if id.worker() != self.worker {
            return Err(Error::Closed);
        }
        let entry = self.entry_mut(id.index())?;
        if entry.word.generation() != id.generation() {
            return Err(Error::Closed);
        }
        match entry.word.recycle() {
            Ok(_) => {
                self.free.push(id.index());
                self.live = self.live.saturating_sub(1);
                Ok(())
            }
            Err(Refused::Readers(readers)) => Err(Error::Limit(format!(
                "slot {} has {readers} reader(s) counted in",
                id.index()
            ))),
            Err(Refused::State(state)) => {
                Err(Error::Limit(format!("slot {} is {state:?}", id.index())))
            }
            Err(Refused::Stale | Refused::Full) => Err(Error::Closed),
        }
    }

    fn grow(&mut self) -> Result<u16> {
        let next = self.capacity();
        if next >= self.limit {
            return Err(Error::Limit(format!(
                "the arena holds its limit of {} slots",
                self.limit
            )));
        }
        let count = self.chunk.min(self.limit.saturating_sub(next));
        let chunk: Vec<Entry<T>> = (0..count)
            .map(|_| Entry {
                word: SlotWord::new(),
                value: UnsafeCell::new(T::default()),
            })
            .collect();
        self.chunks.push(chunk.into_boxed_slice());
        // The new chunk's slots join the free list in reverse, so the lowest index is
        // handed out first.
        for offset in (1..count).rev() {
            let index = u16::try_from(next.saturating_add(offset)).map_err(|_| Error::Closed)?;
            self.free.push(index);
        }
        u16::try_from(next).map_err(|_| Error::Closed)
    }

    fn entry(&self, index: u16) -> Result<&Entry<T>> {
        let index = usize::from(index);
        let chunk = index.checked_div(self.chunk).ok_or(Error::Closed)?;
        let offset = index.checked_rem(self.chunk).ok_or(Error::Closed)?;
        self.chunks
            .get(chunk)
            .and_then(|chunk| chunk.get(offset))
            .ok_or(Error::Closed)
    }

    fn entry_mut(&mut self, index: u16) -> Result<&mut Entry<T>> {
        let index = usize::from(index);
        let chunk = index.checked_div(self.chunk).ok_or(Error::Closed)?;
        let offset = index.checked_rem(self.chunk).ok_or(Error::Closed)?;
        self.chunks
            .get_mut(chunk)
            .and_then(|chunk| chunk.get_mut(offset))
            .ok_or(Error::Closed)
    }
}

#[cfg(test)]
mod tests {
    use super::Arena;
    use crate::slot::SlotState;
    use zero_core::Error;

    #[derive(Debug, Default)]
    struct Record {
        bytes: Vec<u8>,
    }

    #[test]
    fn slots_are_handed_out_lowest_first_and_come_back_with_a_new_generation() {
        let mut arena: Arena<Record> = Arena::new(3, 4, 16);
        assert_eq!(arena.capacity(), 0);
        let first = arena.allocate().unwrap();
        assert_eq!(
            (first.worker(), first.generation(), first.index()),
            (3, 0, 0)
        );
        assert_eq!(arena.capacity(), 4);
        let second = arena.allocate().unwrap();
        assert_eq!(second.index(), 1);
        assert_eq!(arena.live(), 2);
        {
            let (record, word) = arena.get_mut(first).unwrap();
            record.bytes.extend_from_slice(b"head");
            assert_eq!(word.state(), SlotState::Parsing);
        }
        arena.free(first).unwrap();
        assert_eq!(arena.live(), 1);
        assert!(matches!(arena.get_mut(first), Err(Error::Closed)), "stale");
        let again = arena.allocate().unwrap();
        assert_eq!(
            (again.generation(), again.index()),
            (1, 0),
            "the freed slot is reused"
        );
        assert!(
            arena.get_mut(again).unwrap().0.bytes.is_empty(),
            "the record is reset on allocation"
        );
    }

    #[test]
    fn chunks_are_added_and_never_moved() {
        let mut arena: Arena<Record> = Arena::new(0, 2, 64);
        let first = arena.allocate().unwrap();
        let before = std::ptr::from_ref(arena.get_mut(first).unwrap().0).addr();
        let ids: Vec<_> = (0..40).map(|_| arena.allocate().unwrap()).collect();
        assert_eq!(arena.capacity(), 42);
        assert_eq!(arena.chunks.len(), 21);
        let after = std::ptr::from_ref(arena.get_mut(first).unwrap().0).addr();
        assert_eq!(
            before, after,
            "the first slot kept its address through 20 chunks"
        );
        for id in ids {
            arena.free(id).unwrap();
        }
        assert_eq!(arena.live(), 1);
    }

    #[test]
    fn the_limit_and_foreign_ids_are_refused() {
        let mut arena: Arena<Record> = Arena::new(1, 3, 5);
        let ids: Vec<_> = (0..5).map(|_| arena.allocate().unwrap()).collect();
        assert_eq!(arena.capacity(), 5, "the last chunk is cut to the limit");
        assert!(matches!(arena.allocate(), Err(Error::Limit(_))));
        let foreign = zero_core::SlotId::new(2, 0, 0).unwrap();
        assert!(matches!(arena.get_mut(foreign), Err(Error::Closed)));
        assert!(matches!(arena.free(foreign), Err(Error::Closed)));
        assert!(matches!(arena.word(foreign), Err(Error::Closed)));
        let beyond = zero_core::SlotId::new(1, 0, 9).unwrap();
        assert!(matches!(arena.word(beyond), Err(Error::Closed)));
        for id in ids {
            arena.free(id).unwrap();
        }
        assert_eq!(arena.live(), 0);
    }

    #[test]
    fn a_leased_slot_with_a_reader_is_not_freed() {
        let mut arena: Arena<Record> = Arena::new(0, 2, 8);
        let id = arena.allocate().unwrap();
        let word = arena.word(id).unwrap();
        word.transition(SlotState::Parsing, SlotState::Leased)
            .unwrap();
        assert!(matches!(arena.free(id), Err(Error::Limit(_))), "leased");
        let word = arena.word(id).unwrap();
        word.complete(id.generation()).unwrap();
        let reader = word.borrow(id.generation());
        assert!(reader.is_err(), "no borrow after completion");
        drop(reader);
        arena.free(id).unwrap();
        let next = arena.allocate().unwrap();
        assert_eq!(next.generation(), 1);
    }
}
