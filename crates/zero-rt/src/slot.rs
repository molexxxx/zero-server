//! The per-slot ownership state word and borrow protocol (`DESIGN.md` section 7.3).
//!
//! One atomic word per slot holds its state, the number of host readers inside the
//! current lease, the cancel flag, and the generation the slot id must match. The
//! worker is the only party that moves a slot into `Leased` and out of `Completing`;
//! a host reader borrows with one compare-and-swap that checks the generation and the
//! state and counts itself in, so the check and the access are one protected section;
//! the worker refuses to recycle a slot while a reader is counted, and bumps the
//! generation when it does, so a stale id can never read another request's data.
//!
//! Layout of the word: bits 0 to 2 the state, bits 3 to 18 the reader count, bit 19 the
//! cancel flag, bits 20 to 49 the generation.

use std::sync::atomic::{AtomicU64, Ordering};

use zero_core::slot::{next_generation, GENERATION_MASK};

const STATE_BITS: u32 = 3;
const STATE_MASK: u64 = (1 << STATE_BITS) - 1;
const READERS_SHIFT: u32 = STATE_BITS;
const READERS_BITS: u32 = 16;
const READERS_MASK: u64 = ((1 << READERS_BITS) - 1) << READERS_SHIFT;
const CANCEL_SHIFT: u32 = READERS_SHIFT + READERS_BITS;
const CANCEL_BIT: u64 = 1 << CANCEL_SHIFT;
const GENERATION_SHIFT: u32 = CANCEL_SHIFT + 1;

/// The most readers a lease can count at once.
pub const MAX_READERS: u32 = (1 << READERS_BITS) - 1;

/// Where a slot is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SlotState {
    /// On the free list; the worker may allocate it.
    Free = 0,
    /// Allocated; the worker is parsing a request into it.
    Parsing = 1,
    /// A parsed request the worker is handling itself (tiers 0, 1, 2 and 4).
    WorkerOwned = 2,
    /// Dispatched to a host target; readers borrow it, the worker keeps out.
    Leased = 3,
    /// The host completed it; the worker writes the response once no reader is left.
    Completing = 4,
    /// The lease timed out or the connection went away; every accessor sees `Closed`.
    Closed = 5,
}

impl SlotState {
    const fn from_bits(bits: u64) -> Self {
        match bits & STATE_MASK {
            1 => Self::Parsing,
            2 => Self::WorkerOwned,
            3 => Self::Leased,
            4 => Self::Completing,
            5 => Self::Closed,
            _ => Self::Free,
        }
    }
}

/// Why a borrow or a transition was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// The id's generation is not the slot's: the request it named is gone.
    Stale,
    /// The slot is not in the state the operation needs.
    State(SlotState),
    /// A reader is still counted in, so the slot cannot be recycled yet.
    Readers(u32),
    /// The reader count is at its maximum.
    Full,
}

/// The state word of one slot.
#[derive(Debug)]
pub struct SlotWord {
    word: AtomicU64,
}

impl Default for SlotWord {
    fn default() -> Self {
        Self::new()
    }
}

impl SlotWord {
    /// A free slot at generation 0.
    #[must_use]
    pub const fn new() -> Self {
        SlotWord {
            word: AtomicU64::new(0),
        }
    }

    /// The current state.
    #[must_use]
    pub fn state(&self) -> SlotState {
        SlotState::from_bits(self.word.load(Ordering::Acquire))
    }

    /// The current generation.
    #[must_use]
    pub fn generation(&self) -> u32 {
        generation_of(self.word.load(Ordering::Acquire))
    }

    /// How many readers are counted in.
    #[must_use]
    pub fn readers(&self) -> u32 {
        readers_of(self.word.load(Ordering::Acquire))
    }

    /// Whether the worker asked for this request to be abandoned.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.word.load(Ordering::Acquire) & CANCEL_BIT != 0
    }

    /// Move the slot to `next`, which must follow `from`; the worker's transitions.
    ///
    /// # Arguments
    ///
    /// * `from` - the state the slot must be in.
    /// * `next` - the state to move to.
    ///
    /// # Errors
    ///
    /// [`Refused::State`] with the state the slot was actually in.
    pub fn transition(&self, from: SlotState, next: SlotState) -> Result<(), Refused> {
        let mut current = self.word.load(Ordering::Acquire);
        loop {
            if SlotState::from_bits(current) != from {
                return Err(Refused::State(SlotState::from_bits(current)));
            }
            let updated = (current & !STATE_MASK) | next as u64;
            match self.word.compare_exchange_weak(
                current,
                updated,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(()),
                Err(seen) => current = seen,
            }
        }
    }

    /// Count a host reader in, if `generation` is current and the slot is leased.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot id the reader holds.
    ///
    /// # Returns
    ///
    /// A borrow that counts the reader out when dropped.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] for another generation, [`Refused::State`] when the slot is
    /// not leased, [`Refused::Full`] at the reader limit.
    pub fn borrow(&self, generation: u32) -> Result<Borrow<'_>, Refused> {
        let mut current = self.word.load(Ordering::Acquire);
        loop {
            if generation_of(current) != generation {
                return Err(Refused::Stale);
            }
            if SlotState::from_bits(current) != SlotState::Leased {
                return Err(Refused::State(SlotState::from_bits(current)));
            }
            if readers_of(current) >= MAX_READERS {
                return Err(Refused::Full);
            }
            let updated = current + (1 << READERS_SHIFT);
            match self.word.compare_exchange_weak(
                current,
                updated,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(Borrow { word: self }),
                Err(seen) => current = seen,
            }
        }
    }

    /// The host's completion: `Leased` to `Completing`, if `generation` is current.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot id the host holds.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] for another generation, [`Refused::State`] when the slot is
    /// not leased.
    pub fn complete(&self, generation: u32) -> Result<(), Refused> {
        let mut current = self.word.load(Ordering::Acquire);
        loop {
            if generation_of(current) != generation {
                return Err(Refused::Stale);
            }
            if SlotState::from_bits(current) != SlotState::Leased {
                return Err(Refused::State(SlotState::from_bits(current)));
            }
            let updated = (current & !STATE_MASK) | SlotState::Completing as u64;
            match self.word.compare_exchange_weak(
                current,
                updated,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(()),
                Err(seen) => current = seen,
            }
        }
    }

    /// Set the cancel flag: the request should be abandoned when its holder looks.
    pub fn cancel(&self) {
        self.word.fetch_or(CANCEL_BIT, Ordering::AcqRel);
    }

    /// Mark the slot closed, from any state: every later borrow is refused.
    pub fn close(&self) {
        let mut current = self.word.load(Ordering::Acquire);
        loop {
            let updated = (current & !STATE_MASK) | SlotState::Closed as u64;
            match self.word.compare_exchange_weak(
                current,
                updated,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(seen) => current = seen,
            }
        }
    }

    /// Recycle the slot: back to `Free` with the next generation and no cancel flag.
    /// Only a slot in `Completing`, `WorkerOwned`, `Parsing` or `Closed` with no reader
    /// counted in can be recycled.
    ///
    /// # Returns
    ///
    /// The generation the slot now has.
    ///
    /// # Errors
    ///
    /// [`Refused::Readers`] while a reader is counted in, [`Refused::State`] for a free
    /// or leased slot.
    pub fn recycle(&self) -> Result<u32, Refused> {
        let mut current = self.word.load(Ordering::Acquire);
        loop {
            match SlotState::from_bits(current) {
                SlotState::Free | SlotState::Leased => {
                    return Err(Refused::State(SlotState::from_bits(current)));
                }
                _ => {}
            }
            let readers = readers_of(current);
            if readers != 0 {
                return Err(Refused::Readers(readers));
            }
            let generation = next_generation(generation_of(current));
            let updated = u64::from(generation) << GENERATION_SHIFT;
            match self.word.compare_exchange_weak(
                current,
                updated,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(generation),
                Err(seen) => current = seen,
            }
        }
    }
}

/// A counted host reader; dropping it counts the reader out.
#[derive(Debug)]
pub struct Borrow<'a> {
    word: &'a SlotWord,
}

impl Borrow<'_> {
    /// Whether the worker cancelled the request while it was borrowed.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.word.is_cancelled()
    }
}

impl Drop for Borrow<'_> {
    fn drop(&mut self) {
        self.word
            .word
            .fetch_sub(1 << READERS_SHIFT, Ordering::AcqRel);
    }
}

const fn generation_of(word: u64) -> u32 {
    // The shift leaves 30 bits, which `GENERATION_MASK` keeps and `u32` holds.
    ((word >> GENERATION_SHIFT) as u32) & GENERATION_MASK
}

const fn readers_of(word: u64) -> u32 {
    // Sixteen bits after the shift, which `u32` holds.
    ((word & READERS_MASK) >> READERS_SHIFT) as u32
}

#[cfg(test)]
mod tests {
    use super::{Refused, SlotState, SlotWord, MAX_READERS};
    use zero_core::slot::GENERATION_MASK;

    #[test]
    fn a_slot_walks_its_life_and_comes_back_with_a_new_generation() {
        let word = SlotWord::new();
        assert_eq!(word.state(), SlotState::Free);
        assert_eq!(word.generation(), 0);
        word.transition(SlotState::Free, SlotState::Parsing)
            .unwrap();
        word.transition(SlotState::Parsing, SlotState::WorkerOwned)
            .unwrap();
        assert_eq!(
            word.transition(SlotState::Parsing, SlotState::Leased),
            Err(Refused::State(SlotState::WorkerOwned))
        );
        word.transition(SlotState::WorkerOwned, SlotState::Leased)
            .unwrap();
        assert_eq!(word.recycle(), Err(Refused::State(SlotState::Leased)));
        word.complete(0).unwrap();
        assert_eq!(word.state(), SlotState::Completing);
        assert_eq!(word.recycle(), Ok(1));
        assert_eq!(word.state(), SlotState::Free);
        assert_eq!(word.generation(), 1);
        assert_eq!(word.recycle(), Err(Refused::State(SlotState::Free)));
    }

    #[test]
    fn a_borrow_needs_the_generation_and_the_lease_and_blocks_recycling() {
        let word = SlotWord::new();
        word.transition(SlotState::Free, SlotState::Parsing)
            .unwrap();
        assert_eq!(
            word.borrow(0).unwrap_err(),
            Refused::State(SlotState::Parsing)
        );
        word.transition(SlotState::Parsing, SlotState::Leased)
            .unwrap();
        assert_eq!(word.borrow(1).unwrap_err(), Refused::Stale);
        let first = word.borrow(0).unwrap();
        let second = word.borrow(0).unwrap();
        assert_eq!(word.readers(), 2);
        assert!(!first.is_cancelled());
        word.cancel();
        assert!(first.is_cancelled());
        word.complete(0).unwrap();
        assert_eq!(word.recycle(), Err(Refused::Readers(2)));
        drop(first);
        assert_eq!(word.recycle(), Err(Refused::Readers(1)));
        drop(second);
        assert_eq!(word.readers(), 0);
        assert_eq!(word.recycle(), Ok(1));
        assert!(!word.is_cancelled(), "recycling clears the cancel flag");
        assert_eq!(
            word.complete(1).unwrap_err(),
            Refused::State(SlotState::Free)
        );
    }

    #[test]
    fn a_closed_slot_refuses_every_borrow_and_recycles_once_readers_leave() {
        let word = SlotWord::new();
        word.transition(SlotState::Free, SlotState::Leased).unwrap();
        let reader = word.borrow(0).unwrap();
        word.close();
        assert_eq!(word.state(), SlotState::Closed);
        assert_eq!(
            word.borrow(0).unwrap_err(),
            Refused::State(SlotState::Closed)
        );
        assert_eq!(word.recycle(), Err(Refused::Readers(1)));
        drop(reader);
        assert_eq!(word.recycle(), Ok(1));
    }

    #[test]
    fn the_reader_count_has_a_ceiling() {
        let word = SlotWord::new();
        word.transition(SlotState::Free, SlotState::Leased).unwrap();
        let readers: Vec<_> = (0..MAX_READERS).map(|_| word.borrow(0).unwrap()).collect();
        assert_eq!(word.readers(), MAX_READERS);
        assert_eq!(word.borrow(0).unwrap_err(), Refused::Full);
        drop(readers);
        assert_eq!(word.readers(), 0);
    }

    #[test]
    fn the_generation_wraps_inside_thirty_bits() {
        let word = SlotWord::new();
        for _ in 0..3 {
            word.transition(SlotState::Free, SlotState::Parsing)
                .unwrap();
            word.recycle().unwrap();
        }
        assert_eq!(word.generation(), 3);
        let mut turns = 0u64;
        let mut last = 3;
        while last != 0 && turns < 4 {
            word.transition(SlotState::Free, SlotState::Parsing)
                .unwrap();
            last = word.recycle().unwrap();
            turns += 1;
        }
        assert!(last <= GENERATION_MASK);
    }
}
