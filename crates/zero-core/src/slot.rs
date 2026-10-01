//! `SlotId`: the 53-bit handle of a request slot in a worker's arena.
//!
//! The id packs a worker index, a generation and an arena index into 53 bits,
//! so it survives as a JavaScript number without `BigInt`. A slot's generation
//! advances every time the worker recycles it, and an accessor refuses any id
//! whose generation no longer matches, so a stale handle can never read another
//! request's data.

use crate::{Error, Result};

/// Bits reserved for the worker index.
pub const WORKER_BITS: u32 = 7;
/// Bits reserved for the generation.
pub const GENERATION_BITS: u32 = 30;
/// Bits reserved for the arena index.
pub const INDEX_BITS: u32 = 16;
/// The number of workers a slot id can address.
pub const MAX_WORKERS: u32 = 128;
/// The number of slots in one worker's arena.
pub const SLOTS_PER_WORKER: u32 = 65_536;
/// The largest generation; incrementing past it wraps to zero.
pub const GENERATION_MASK: u32 = 0x3FFF_FFFF;
/// The largest encoded id, which is also JavaScript's largest safe integer.
pub const MAX_ENCODED: u64 = 0x001F_FFFF_FFFF_FFFF;

const INDEX_MASK: u64 = 0xFFFF;
const WORKER_MASK: u64 = 0x7F;
const GENERATION_SHIFT: u32 = INDEX_BITS;
const WORKER_SHIFT: u32 = INDEX_BITS.wrapping_add(GENERATION_BITS);

/// The handle of one request slot: worker, generation and arena index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SlotId(u64);

impl SlotId {
    /// Packs a worker, a generation and an index into one id.
    ///
    /// # Arguments
    ///
    /// * `worker` - the worker index, below [`MAX_WORKERS`].
    /// * `generation` - the slot's current generation, at most
    ///   [`GENERATION_MASK`].
    /// * `index` - the slot's position in the worker's arena.
    ///
    /// # Returns
    ///
    /// The id, or `None` when `worker` or `generation` is out of range.
    #[must_use]
    pub const fn new(worker: u8, generation: u32, index: u16) -> Option<Self> {
        if worker as u32 >= MAX_WORKERS || generation > GENERATION_MASK {
            return None;
        }
        let packed = (worker as u64).wrapping_shl(WORKER_SHIFT)
            | (generation as u64).wrapping_shl(GENERATION_SHIFT)
            | index as u64;
        Some(Self(packed))
    }

    /// Reinterprets a raw integer, such as one received from a host language.
    ///
    /// # Arguments
    ///
    /// * `raw` - the encoded id.
    ///
    /// # Returns
    ///
    /// The id, or `None` when `raw` exceeds [`MAX_ENCODED`].
    #[must_use]
    pub const fn from_raw(raw: u64) -> Option<Self> {
        if raw > MAX_ENCODED {
            None
        } else {
            Some(Self(raw))
        }
    }

    /// Returns the encoded id.
    #[must_use]
    pub const fn as_u64(self) -> u64 {
        self.0
    }

    /// Returns the encoded id as the exact floating-point number a JavaScript
    /// host receives.
    #[must_use]
    pub fn as_f64(self) -> f64 {
        self.0 as f64
    }

    /// Returns the worker index.
    #[must_use]
    pub const fn worker(self) -> u8 {
        (self.0.wrapping_shr(WORKER_SHIFT) & WORKER_MASK) as u8
    }

    /// Returns the generation.
    #[must_use]
    pub const fn generation(self) -> u32 {
        (self.0.wrapping_shr(GENERATION_SHIFT) as u32) & GENERATION_MASK
    }

    /// Returns the arena index.
    #[must_use]
    pub const fn index(self) -> u16 {
        (self.0 & INDEX_MASK) as u16
    }

    /// Returns the same slot at a new generation.
    ///
    /// # Arguments
    ///
    /// * `generation` - the generation to encode, at most [`GENERATION_MASK`].
    ///
    /// # Returns
    ///
    /// The id, or `None` when `generation` is out of range.
    #[must_use]
    pub const fn with_generation(self, generation: u32) -> Option<Self> {
        Self::new(self.worker(), generation, self.index())
    }

    /// Checks the id against the generation the slot currently holds.
    ///
    /// # Arguments
    ///
    /// * `current` - the generation stored in the slot's state word.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Closed`] when the generations differ: the slot has been
    /// recycled since the id was issued, so the id refers to nothing.
    pub fn verify(self, current: u32) -> Result<()> {
        if self.generation() == current {
            Ok(())
        } else {
            Err(Error::Closed)
        }
    }
}

/// Returns the generation that follows `generation`, wrapping past
/// [`GENERATION_MASK`] to zero.
///
/// # Arguments
///
/// * `generation` - the current generation.
#[must_use]
pub const fn next_generation(generation: u32) -> u32 {
    generation.wrapping_add(1) & GENERATION_MASK
}

#[cfg(test)]
mod tests {
    use super::{
        next_generation, SlotId, GENERATION_BITS, GENERATION_MASK, INDEX_BITS, MAX_ENCODED,
        MAX_WORKERS, SLOTS_PER_WORKER, WORKER_BITS,
    };
    use crate::Error;

    #[test]
    fn the_layout_is_fifty_three_bits() {
        assert_eq!(WORKER_BITS + GENERATION_BITS + INDEX_BITS, 53);
        assert_eq!(MAX_ENCODED, (1u64 << 53) - 1);
        assert_eq!(MAX_WORKERS, 1 << WORKER_BITS);
        assert_eq!(SLOTS_PER_WORKER, 1 << INDEX_BITS);
        assert_eq!(GENERATION_MASK, (1 << GENERATION_BITS) - 1);
    }

    #[test]
    fn fields_round_trip() {
        let id = SlotId::new(5, 0x1234_5678, 0xBEEF);
        assert_eq!(id.map(SlotId::worker), Some(5));
        assert_eq!(id.map(SlotId::generation), Some(0x1234_5678));
        assert_eq!(id.map(SlotId::index), Some(0xBEEF));
    }

    #[test]
    fn the_largest_id_is_a_safe_javascript_integer() {
        let id = SlotId::new(127, GENERATION_MASK, u16::MAX);
        assert_eq!(id.map(SlotId::as_u64), Some(MAX_ENCODED));
        let raw = id.map(SlotId::as_f64).unwrap_or_default();
        assert_eq!(raw as u64, MAX_ENCODED);
        assert_eq!(raw, 9_007_199_254_740_991.0);
    }

    #[test]
    fn out_of_range_fields_are_refused() {
        assert!(SlotId::new(128, 0, 0).is_none());
        assert!(SlotId::new(0, GENERATION_MASK + 1, 0).is_none());
        assert!(SlotId::new(255, 0, 0).is_none());
    }

    #[test]
    fn raw_ids_above_the_layout_are_refused() {
        assert!(SlotId::from_raw(MAX_ENCODED).is_some());
        assert!(SlotId::from_raw(MAX_ENCODED + 1).is_none());
        assert!(SlotId::from_raw(u64::MAX).is_none());
        assert_eq!(SlotId::from_raw(0).map(SlotId::index), Some(0));
    }

    #[test]
    fn a_stale_generation_reads_as_closed() {
        let id = SlotId::new(1, 41, 9);
        assert!(id.is_some_and(|id| id.verify(41).is_ok()));
        assert!(id.is_some_and(|id| matches!(id.verify(42), Err(Error::Closed))));
        let renewed = id.and_then(|id| id.with_generation(42));
        assert!(renewed.is_some_and(|id| id.verify(42).is_ok()));
        assert_eq!(renewed.map(SlotId::worker), Some(1));
        assert_eq!(renewed.map(SlotId::index), Some(9));
    }

    #[test]
    fn generations_wrap_inside_the_mask() {
        assert_eq!(next_generation(0), 1);
        assert_eq!(next_generation(GENERATION_MASK), 0);
        assert_eq!(next_generation(GENERATION_MASK - 1), GENERATION_MASK);
    }

    #[test]
    fn ids_order_by_worker_then_generation_then_index() {
        let low = SlotId::new(0, 1, 2);
        let high = SlotId::new(1, 0, 0);
        assert!(low < high);
    }
}
