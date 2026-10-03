//! The per-slot ownership state word and its transitions.
//!
//! One atomic word per slot holds its state, the number of pins counted in, the
//! cancel flag, and the generation a slot id must match. Every transition is one
//! compare-and-swap that checks the generation and the state in the same step, with
//! acquire-release ordering on success and acquire on failure, so a stale id can move
//! nothing and a pinned slot is never retired. Only the worker changes the state bits;
//! a host changes only the pin count.
//!
//! | Method | Caller | From | To |
//! | --- | --- | --- | --- |
//! | [`claim`](SlotWord::claim) | worker, allocating | `Free` | `Parsing` |
//! | [`hold`](SlotWord::hold) | worker, after export | `Parsing` | `WorkerOwned` |
//! | [`lease`](SlotWord::lease) | dispatcher, into a batch | `WorkerOwned` | `Leased` |
//! | [`unlease`](SlotWord::unlease) | dispatcher, batch refused | `Leased` | `WorkerOwned` |
//! | [`begin_import`](SlotWord::begin_import) | worker, after the seal | `Leased` | `Completing` |
//! | [`close_leased`](SlotWord::close_leased) | worker, lease dropped | `Leased` | `Closed` |
//! | [`close`](SlotWord::close) | worker, queued job dropped | `Parsing`, `WorkerOwned` | `Closed` |
//! | [`retire`](SlotWord::retire) | worker | any but `Free` and `Leased` | `Free`, next generation |
//! | [`pin`](SlotWord::pin), [`unpin`](SlotWord::unpin) | any thread | `Leased`, `Completing` | pin count up or down |
//!
//! Layout of the word: bits 0 to 2 the state, bits 3 to 18 the pin count, bit 19 the
//! cancel flag, bits 20 to 49 the generation; bits 50 to 63 stay zero.

use zero_core::slot::{next_generation, GENERATION_MASK};

use crate::sync::{AtomicU64, Ordering};

const STATE_BITS: u32 = 3;
const STATE_MASK: u64 = (1 << STATE_BITS) - 1;
const READERS_SHIFT: u32 = STATE_BITS;
const READERS_BITS: u32 = 16;
const READERS_MASK: u64 = ((1 << READERS_BITS) - 1) << READERS_SHIFT;
const ONE_READER: u64 = 1 << READERS_SHIFT;
const CANCEL_SHIFT: u32 = READERS_SHIFT + READERS_BITS;
const CANCEL_BIT: u64 = 1 << CANCEL_SHIFT;
const GENERATION_SHIFT: u32 = CANCEL_SHIFT + 1;

/// The most pins a slot can count at once.
pub const MAX_READERS: u32 = (1 << READERS_BITS) - 1;

/// The states a host may read a slot in.
const LEASED_OR_COMPLETING: &[SlotState] = &[SlotState::Leased, SlotState::Completing];

/// Where a slot is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SlotState {
    /// On a free list; the worker may claim it.
    Free = 0,
    /// Claimed; the worker is writing a request into it.
    Parsing = 1,
    /// A request the worker holds, exported and not yet dispatched.
    WorkerOwned = 2,
    /// Dispatched to a host target; hosts read it and write its response.
    Leased = 3,
    /// The host sealed it; the worker is taking the response back.
    Completing = 4,
    /// The lease or the queued job was dropped; every host access is refused.
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

/// Why an access, a transition or a lookup was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// The id's generation is not the slot's: the request it named is gone.
    Stale,
    /// The slot is not in a state the operation accepts; the state it was in.
    State(SlotState),
    /// Pins are counted in, so the slot cannot be retired yet; how many.
    Readers(u32),
    /// The pin count is at [`MAX_READERS`].
    Full,
    /// The request was canceled, so it cannot be leased.
    Canceled,
    /// The worker's attempt to take the slot's lock would have waited for a host.
    Busy,
    /// A panic while the slot's lock was held left the payload poisoned.
    Poisoned,
    /// The id names no slot of this arena: another worker's, or an index the arena
    /// has not grown to.
    Unknown,
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
    ///
    /// # Returns
    ///
    /// The word.
    #[cfg(not(zero_loom))]
    #[must_use]
    pub const fn new() -> Self {
        SlotWord {
            word: AtomicU64::new(0),
        }
    }

    /// A free slot at generation 0; loom's atomics cannot be built in a constant.
    ///
    /// # Returns
    ///
    /// The word.
    #[cfg(zero_loom)]
    #[must_use]
    pub fn new() -> Self {
        SlotWord {
            word: AtomicU64::new(0),
        }
    }

    /// The current state.
    ///
    /// # Returns
    ///
    /// The state bits of one acquire load.
    #[must_use]
    pub fn state(&self) -> SlotState {
        SlotState::from_bits(self.word.load(Ordering::Acquire))
    }

    /// The current generation.
    ///
    /// # Returns
    ///
    /// The generation bits of one acquire load.
    #[must_use]
    pub fn generation(&self) -> u32 {
        generation_of(self.word.load(Ordering::Acquire))
    }

    /// How many pins are counted in.
    ///
    /// # Returns
    ///
    /// The pin count of one acquire load.
    #[must_use]
    pub fn readers(&self) -> u32 {
        readers_of(self.word.load(Ordering::Acquire))
    }

    /// Whether the request was canceled: its lease or its queued job was dropped.
    ///
    /// # Returns
    ///
    /// The cancel flag of one acquire load.
    #[must_use]
    pub fn is_canceled(&self) -> bool {
        self.word.load(Ordering::Acquire) & CANCEL_BIT != 0
    }

    /// Check with one acquire load that the slot is at `generation` in one of
    /// `accepted`.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the id the caller holds.
    /// * `accepted` - the states the caller may proceed in.
    ///
    /// # Returns
    ///
    /// The state the slot is in.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] for another generation, [`Refused::State`] for a state
    /// outside `accepted`.
    pub fn check(&self, generation: u32, accepted: &[SlotState]) -> Result<SlotState, Refused> {
        let word = self.word.load(Ordering::Acquire);
        if generation_of(word) != generation {
            return Err(Refused::Stale);
        }
        require(word, accepted)
    }

    /// Check with one acquire load that the slot is leased or completing at
    /// `generation`: the states a host may read in.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the id the caller holds.
    ///
    /// # Returns
    ///
    /// The state the slot is in.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`] for another generation, [`Refused::State`] for another
    /// state.
    pub fn check_lease(&self, generation: u32) -> Result<SlotState, Refused> {
        self.check(generation, LEASED_OR_COMPLETING)
    }

    /// `Free` to `Parsing`: the allocator claims the slot.
    ///
    /// # Arguments
    ///
    /// * `generation` - the slot's current generation.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] when the slot is not free,
    /// [`Refused::Readers`] when a pin is counted in.
    pub fn claim(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, &[SlotState::Free])?;
            no_readers(word)?;
            Ok(with_state(word, SlotState::Parsing))
        })
        .map(drop)
    }

    /// `Parsing` to `WorkerOwned`: the request is exported and held by the worker.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] when the slot is not parsing.
    pub fn hold(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, &[SlotState::Parsing])?;
            Ok(with_state(word, SlotState::WorkerOwned))
        })
        .map(drop)
    }

    /// `WorkerOwned` to `Leased`: the dispatcher writes the job into a batch.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] when the slot is not held by the
    /// worker, [`Refused::Canceled`] when the cancel flag is set.
    pub fn lease(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, &[SlotState::WorkerOwned])?;
            if word & CANCEL_BIT != 0 {
                return Err(Refused::Canceled);
            }
            Ok(with_state(word, SlotState::Leased))
        })
        .map(drop)
    }

    /// `Leased` to `WorkerOwned`: the target refused the batch, so no host has seen
    /// the id.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] when the slot is not leased.
    pub fn unlease(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, &[SlotState::Leased])?;
            Ok(with_state(word, SlotState::WorkerOwned))
        })
        .map(drop)
    }

    /// `Leased` to `Completing`: the host sealed the response and the worker takes
    /// it back.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] when the slot is not leased.
    pub fn begin_import(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, &[SlotState::Leased])?;
            Ok(with_state(word, SlotState::Completing))
        })
        .map(drop)
    }

    /// `Leased` to `Closed` with the cancel flag set: the lease was dropped or its
    /// target is gone, and every later host access is refused.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] when the slot is not leased.
    pub fn close_leased(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, &[SlotState::Leased])?;
            Ok(with_state(word, SlotState::Closed) | CANCEL_BIT)
        })
        .map(drop)
    }

    /// `Parsing` or `WorkerOwned` to `Closed` with the cancel flag set: a job that
    /// was queued and never leased was dropped. A free slot is refused, so a stale
    /// close can never strand an index on a free list.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] for any other state, `Free` included.
    pub fn close(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, &[SlotState::Parsing, SlotState::WorkerOwned])?;
            Ok(with_state(word, SlotState::Closed) | CANCEL_BIT)
        })
        .map(drop)
    }

    /// Back to `Free` at the next generation with the cancel flag clear, in the same
    /// step that checks no pin is counted in.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the slot's id.
    ///
    /// # Returns
    ///
    /// The generation the slot now has.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] for a free or leased slot,
    /// [`Refused::Readers`] while a pin is counted in.
    pub fn retire(&self, generation: u32) -> Result<u32, Refused> {
        self.update(generation, |word| {
            require(
                word,
                &[
                    SlotState::Parsing,
                    SlotState::WorkerOwned,
                    SlotState::Completing,
                    SlotState::Closed,
                ],
            )?;
            no_readers(word)?;
            Ok(u64::from(next_generation(generation_of(word))) << GENERATION_SHIFT)
        })
        .map(generation_of)
    }

    /// Count a pin in: while it is counted, the slot cannot be retired, so its
    /// payload and published view stay those of `generation`.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the id the host holds.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] when the slot is neither leased nor
    /// completing, [`Refused::Full`] at [`MAX_READERS`].
    pub fn pin(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            require(word, LEASED_OR_COMPLETING)?;
            if readers_of(word) >= MAX_READERS {
                return Err(Refused::Full);
            }
            Ok(word.saturating_add(ONE_READER))
        })
        .map(drop)
    }

    /// Count a pin out.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation the pin was taken at.
    ///
    /// # Errors
    ///
    /// [`Refused::Stale`], [`Refused::State`] for a free slot, [`Refused::Readers`]
    /// with 0 when no pin is counted in.
    pub fn unpin(&self, generation: u32) -> Result<(), Refused> {
        self.update(generation, |word| {
            if SlotState::from_bits(word) == SlotState::Free {
                return Err(Refused::State(SlotState::Free));
            }
            if readers_of(word) == 0 {
                return Err(Refused::Readers(0));
            }
            Ok(word.saturating_sub(ONE_READER))
        })
        .map(drop)
    }

    /// Pin the slot for as long as the returned guard lives: the RAII form of
    /// [`pin`](Self::pin) and [`unpin`](Self::unpin).
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation of the id the host holds.
    ///
    /// # Returns
    ///
    /// A guard that counts the pin out when dropped.
    ///
    /// # Errors
    ///
    /// As [`pin`](Self::pin).
    pub fn borrow(&self, generation: u32) -> Result<Borrow<'_>, Refused> {
        self.pin(generation)?;
        Ok(Borrow {
            word: self,
            generation,
        })
    }

    /// One generation-checked compare-and-swap loop: `step` maps the word it saw to
    /// the word to store, or refuses.
    fn update(
        &self,
        generation: u32,
        mut step: impl FnMut(u64) -> Result<u64, Refused>,
    ) -> Result<u64, Refused> {
        let mut current = self.word.load(Ordering::Acquire);
        loop {
            if generation_of(current) != generation {
                return Err(Refused::Stale);
            }
            let next = step(current)?;
            match self.word.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(next),
                Err(seen) => current = seen,
            }
        }
    }
}

/// A counted pin; dropping it counts the pin out.
#[derive(Debug)]
pub struct Borrow<'a> {
    word: &'a SlotWord,
    generation: u32,
}

impl Borrow<'_> {
    /// Whether the request was canceled while it was pinned.
    ///
    /// # Returns
    ///
    /// The cancel flag.
    #[must_use]
    pub fn is_canceled(&self) -> bool {
        self.word.is_canceled()
    }

    /// The generation the pin holds.
    ///
    /// # Returns
    ///
    /// The generation.
    #[must_use]
    pub const fn generation(&self) -> u32 {
        self.generation
    }
}

impl Drop for Borrow<'_> {
    fn drop(&mut self) {
        // The pin keeps the generation current, so the unpin cannot be refused.
        let _ = self.word.unpin(self.generation);
    }
}

/// The state of `word`, if it is one of `accepted`.
fn require(word: u64, accepted: &[SlotState]) -> Result<SlotState, Refused> {
    let state = SlotState::from_bits(word);
    if accepted.contains(&state) {
        Ok(state)
    } else {
        Err(Refused::State(state))
    }
}

/// Refuse a word with a pin counted in.
fn no_readers(word: u64) -> Result<(), Refused> {
    match readers_of(word) {
        0 => Ok(()),
        readers => Err(Refused::Readers(readers)),
    }
}

/// `word` with its state bits replaced.
const fn with_state(word: u64, state: SlotState) -> u64 {
    (word & !STATE_MASK) | state as u64
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

    /// A word walked from `Free` to `state` at generation 0.
    fn word_in(state: SlotState) -> SlotWord {
        let word = SlotWord::new();
        match state {
            SlotState::Free => {}
            SlotState::Parsing => word.claim(0).unwrap(),
            SlotState::WorkerOwned => {
                word.claim(0).unwrap();
                word.hold(0).unwrap();
            }
            SlotState::Leased => {
                word.claim(0).unwrap();
                word.hold(0).unwrap();
                word.lease(0).unwrap();
            }
            SlotState::Completing => {
                word.claim(0).unwrap();
                word.hold(0).unwrap();
                word.lease(0).unwrap();
                word.begin_import(0).unwrap();
            }
            SlotState::Closed => {
                word.claim(0).unwrap();
                word.close(0).unwrap();
            }
        }
        assert_eq!(word.state(), state);
        word
    }

    const ALL: [SlotState; 6] = [
        SlotState::Free,
        SlotState::Parsing,
        SlotState::WorkerOwned,
        SlotState::Leased,
        SlotState::Completing,
        SlotState::Closed,
    ];

    type Transition = fn(&SlotWord, u32) -> Result<(), Refused>;

    /// Each transition, the one state it starts from, and the state it ends in.
    const TRANSITIONS: [(&str, Transition, &[SlotState], SlotState); 7] = [
        (
            "claim",
            SlotWord::claim,
            &[SlotState::Free],
            SlotState::Parsing,
        ),
        (
            "hold",
            SlotWord::hold,
            &[SlotState::Parsing],
            SlotState::WorkerOwned,
        ),
        (
            "lease",
            SlotWord::lease,
            &[SlotState::WorkerOwned],
            SlotState::Leased,
        ),
        (
            "unlease",
            SlotWord::unlease,
            &[SlotState::Leased],
            SlotState::WorkerOwned,
        ),
        (
            "begin_import",
            SlotWord::begin_import,
            &[SlotState::Leased],
            SlotState::Completing,
        ),
        (
            "close_leased",
            SlotWord::close_leased,
            &[SlotState::Leased],
            SlotState::Closed,
        ),
        (
            "close",
            SlotWord::close,
            &[SlotState::Parsing, SlotState::WorkerOwned],
            SlotState::Closed,
        ),
    ];

    #[test]
    fn each_transition_moves_only_from_its_own_states() {
        for (name, transition, from, to) in TRANSITIONS {
            for state in ALL {
                let word = word_in(state);
                let outcome = transition(&word, 0);
                if from.contains(&state) {
                    assert_eq!(outcome, Ok(()), "{name} from {state:?}");
                    assert_eq!(word.state(), to, "{name} from {state:?}");
                    assert_eq!(word.generation(), 0, "{name} keeps the generation");
                } else {
                    assert_eq!(outcome, Err(Refused::State(state)), "{name} from {state:?}");
                    assert_eq!(word.state(), state, "a refusal changes nothing");
                }
            }
        }
    }

    #[test]
    fn each_transition_refuses_another_generation() {
        for (name, transition, from, _) in TRANSITIONS {
            let word = word_in(from[0]);
            assert_eq!(transition(&word, 1), Err(Refused::Stale), "{name}");
            assert_eq!(
                transition(&word, GENERATION_MASK),
                Err(Refused::Stale),
                "{name}"
            );
            assert_eq!(word.state(), from[0], "{name}: a stale id moves nothing");
        }
        let word = word_in(SlotState::Completing);
        assert_eq!(word.retire(1), Err(Refused::Stale));
        assert_eq!(word.pin(1), Err(Refused::Stale));
        assert_eq!(word.unpin(1), Err(Refused::Stale));
        assert_eq!(word.check_lease(1), Err(Refused::Stale));
        assert!(matches!(word.borrow(1), Err(Refused::Stale)));
    }

    #[test]
    fn close_refuses_a_free_slot_so_no_index_is_stranded() {
        let word = SlotWord::new();
        assert_eq!(word.close(0), Err(Refused::State(SlotState::Free)));
        assert_eq!(word.state(), SlotState::Free);
        assert_eq!(word.claim(0), Ok(()), "the index can still be claimed");
    }

    #[test]
    fn close_sets_the_cancel_flag_and_retire_clears_it() {
        for state in [SlotState::Parsing, SlotState::WorkerOwned] {
            let word = word_in(state);
            assert!(!word.is_canceled());
            word.close(0).unwrap();
            assert!(word.is_canceled());
            assert_eq!(word.retire(0), Ok(1));
            assert!(!word.is_canceled(), "retire clears the cancel flag");
        }
        let word = word_in(SlotState::Leased);
        word.close_leased(0).unwrap();
        assert!(word.is_canceled());
        assert_eq!(word.state(), SlotState::Closed);
    }

    #[test]
    fn retire_moves_every_held_state_to_free_at_the_next_generation() {
        for state in ALL {
            let word = word_in(state);
            let outcome = word.retire(0);
            match state {
                SlotState::Free | SlotState::Leased => {
                    assert_eq!(outcome, Err(Refused::State(state)), "{state:?}");
                }
                _ => {
                    assert_eq!(outcome, Ok(1), "{state:?}");
                    assert_eq!(word.state(), SlotState::Free);
                    assert_eq!(word.generation(), 1);
                    assert_eq!(word.readers(), 0);
                }
            }
        }
    }

    #[test]
    fn retire_refuses_while_a_pin_is_counted_in() {
        let word = word_in(SlotState::Leased);
        word.pin(0).unwrap();
        word.begin_import(0).unwrap();
        word.pin(0).unwrap();
        assert_eq!(word.retire(0), Err(Refused::Readers(2)));
        word.unpin(0).unwrap();
        assert_eq!(word.retire(0), Err(Refused::Readers(1)));
        word.unpin(0).unwrap();
        assert_eq!(word.retire(0), Ok(1));
    }

    #[test]
    fn retire_refuses_with_readers_from_a_closed_lease() {
        let word = word_in(SlotState::Leased);
        let pin = word.borrow(0).unwrap();
        word.close_leased(0).unwrap();
        assert!(pin.is_canceled(), "the pin sees the cancel");
        assert_eq!(word.retire(0), Err(Refused::Readers(1)));
        drop(pin);
        assert_eq!(word.retire(0), Ok(1));
    }

    /// A word holding exactly `bits`, for states no sequence of transitions reaches.
    fn raw(bits: u64) -> SlotWord {
        SlotWord {
            word: crate::sync::AtomicU64::new(bits),
        }
    }

    #[test]
    fn claim_refuses_a_free_slot_with_a_pin_counted_in() {
        let word = raw(super::ONE_READER);
        assert_eq!(word.state(), SlotState::Free);
        assert_eq!(word.claim(0), Err(Refused::Readers(1)));
        assert_eq!(word.state(), SlotState::Free);
    }

    #[test]
    fn lease_refuses_a_canceled_request() {
        let word = raw(SlotState::WorkerOwned as u64 | super::CANCEL_BIT);
        assert_eq!(word.lease(0), Err(Refused::Canceled));
        assert_eq!(word.state(), SlotState::WorkerOwned);
        let closed = word_in(SlotState::WorkerOwned);
        closed.close(0).unwrap();
        assert_eq!(closed.lease(0), Err(Refused::State(SlotState::Closed)));
    }

    #[test]
    fn pins_need_a_leased_or_completing_slot_at_their_generation() {
        for state in ALL {
            let word = word_in(state);
            let outcome = word.pin(0);
            match state {
                SlotState::Leased | SlotState::Completing => {
                    assert_eq!(outcome, Ok(()), "{state:?}");
                    assert_eq!(word.readers(), 1);
                    assert_eq!(word.unpin(0), Ok(()));
                    assert_eq!(word.readers(), 0);
                }
                _ => assert_eq!(outcome, Err(Refused::State(state)), "{state:?}"),
            }
        }
    }

    #[test]
    fn unpin_refuses_a_free_slot_and_a_count_of_zero() {
        assert_eq!(
            SlotWord::new().unpin(0),
            Err(Refused::State(SlotState::Free))
        );
        let word = word_in(SlotState::Completing);
        assert_eq!(word.unpin(0), Err(Refused::Readers(0)));
        let closed = word_in(SlotState::Closed);
        assert_eq!(closed.unpin(0), Err(Refused::Readers(0)));
    }

    #[test]
    fn the_pin_count_has_a_ceiling() {
        let word = word_in(SlotState::Leased);
        let pins: Vec<_> = (0..MAX_READERS).map(|_| word.borrow(0).unwrap()).collect();
        assert_eq!(word.readers(), MAX_READERS);
        assert_eq!(word.pin(0), Err(Refused::Full));
        assert_eq!(word.state(), SlotState::Leased, "the count never spills");
        assert_eq!(word.generation(), 0, "the count never spills");
        assert!(!word.is_canceled(), "the count never spills");
        drop(pins);
        assert_eq!(word.readers(), 0);
    }

    #[test]
    fn check_reports_the_state_or_the_refusal_in_one_load() {
        let word = word_in(SlotState::Completing);
        assert_eq!(word.check_lease(0), Ok(SlotState::Completing));
        assert_eq!(
            word.check(0, &[SlotState::Leased]),
            Err(Refused::State(SlotState::Completing))
        );
        let parsing = word_in(SlotState::Parsing);
        assert_eq!(
            parsing.check_lease(0),
            Err(Refused::State(SlotState::Parsing))
        );
        assert_eq!(
            parsing.check(0, &[SlotState::Parsing]),
            Ok(SlotState::Parsing)
        );
    }

    #[test]
    fn a_borrow_reports_its_generation_and_unpins_on_drop() {
        let word = word_in(SlotState::Completing);
        let pin = word.borrow(0).unwrap();
        assert_eq!(pin.generation(), 0);
        assert!(!pin.is_canceled());
        assert_eq!(word.readers(), 1);
        drop(pin);
        assert_eq!(word.readers(), 0);
    }

    #[test]
    fn the_generation_wraps_inside_thirty_bits() {
        let word = SlotWord::new();
        let mut generation = 0;
        for _ in 0..3 {
            word.claim(generation).unwrap();
            generation = word.retire(generation).unwrap();
        }
        assert_eq!(generation, 3);
        assert_eq!(super::generation_of(u64::MAX), GENERATION_MASK);
        let top = u64::from(GENERATION_MASK) << super::GENERATION_SHIFT;
        let wrapped = raw(top | SlotState::Closed as u64);
        assert_eq!(wrapped.generation(), GENERATION_MASK);
        assert_eq!(wrapped.retire(GENERATION_MASK), Ok(0), "wraps to zero");
        assert_eq!(wrapped.generation(), 0);
    }

    #[test]
    fn concurrent_pins_retry_their_compare_and_swap_and_lose_no_count() {
        let word = std::sync::Arc::new(word_in(SlotState::Leased));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let word = std::sync::Arc::clone(&word);
                std::thread::spawn(move || {
                    for _ in 0..10_000 {
                        word.pin(0).unwrap();
                        word.unpin(0).unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(word.readers(), 0);
        assert_eq!(word.state(), SlotState::Leased);
        assert_eq!(word.generation(), 0);
    }
}
