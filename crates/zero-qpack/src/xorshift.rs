//! The deterministic generator the randomized tests draw their inputs from.

use alloc::vec::Vec;

/// Returns the number of cases a randomized test runs: the full count on a
/// native run, a five-hundredth under Miri, which interprets every instruction
/// and runs the suite under several seeds.
pub fn iterations(native: usize) -> usize {
    if cfg!(miri) {
        native.div_euclid(500).max(4)
    } else {
        native
    }
}

/// A 64-bit xorshift generator; the same seed always yields the same inputs,
/// so a failing case can be rerun.
pub struct XorShift(u64);

impl XorShift {
    /// Seeds the generator; zero is replaced so the state never sticks.
    pub const fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9E37_79B9_7F4A_7C15
        } else {
            seed
        })
    }

    /// Returns the next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x.wrapping_shl(13);
        x ^= x.wrapping_shr(7);
        x ^= x.wrapping_shl(17);
        self.0 = x;
        x
    }

    /// Returns a value drawn uniformly below `bound`, or zero when `bound` is
    /// zero.
    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64().checked_rem(bound).unwrap_or(0)
    }

    /// Returns a length drawn uniformly from `min` to `max` inclusive.
    pub fn len(&mut self, min: usize, max: usize) -> usize {
        let span = u64::try_from(max.saturating_sub(min))
            .unwrap_or(0)
            .saturating_add(1);
        min.saturating_add(usize::try_from(self.below(span)).unwrap_or(0))
    }

    /// Returns a random octet.
    pub fn byte(&mut self) -> u8 {
        let [.., high] = self.next_u64().to_le_bytes();
        high
    }

    /// Returns a random boolean.
    pub fn flag(&mut self) -> bool {
        self.next_u64() & 0x100 != 0
    }

    /// Returns random octets of a length from `min` to `max` inclusive.
    pub fn bytes(&mut self, min: usize, max: usize) -> Vec<u8> {
        let len = self.len(min, max);
        (0..len).map(|_| self.byte()).collect()
    }

    /// Returns a value of at most 62 bits with a random bit width, so every
    /// encoded length appears.
    pub fn value62(&mut self) -> u64 {
        let width = u32::try_from(self.below(63)).unwrap_or(0);
        let mask = 1u64.wrapping_shl(width).wrapping_sub(1);
        self.next_u64() & mask
    }
}
