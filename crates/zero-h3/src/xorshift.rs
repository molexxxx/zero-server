//! The deterministic generator the randomized tests draw their inputs from,
//! and the hex reader the tests quote published vectors with.

use alloc::vec::Vec;

/// Reads lowercase or uppercase hex digits into octets, skipping whitespace.
pub fn unhex(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text
        .chars()
        .filter_map(|digit| digit.to_digit(16))
        .filter_map(|digit| u8::try_from(digit).ok())
        .collect();
    digits
        .chunks(2)
        .map(|pair| match pair {
            [high, low] => high.wrapping_shl(4) | low,
            _ => 0,
        })
        .collect()
}

/// Returns the number of cases a randomized test runs: the full count on a
/// native run, a hundredth under Miri, which interprets every instruction.
pub fn iterations(native: usize) -> usize {
    if cfg!(miri) {
        native.div_euclid(100).max(20)
    } else {
        native
    }
}

/// An xorshift64* generator; the same seed always yields the same inputs, so
/// a failing case can be rerun.
pub struct Rng(u64);

impl Rng {
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
        x ^= x.wrapping_shr(12);
        x ^= x.wrapping_shl(25);
        x ^= x.wrapping_shr(27);
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Returns a random byte.
    pub fn byte(&mut self) -> u8 {
        u8::try_from(self.next_u64().wrapping_shr(56)).unwrap_or_default()
    }

    /// Returns a value below `bound`, or zero when `bound` is zero.
    pub fn below(&mut self, bound: u64) -> u64 {
        self.next_u64().checked_rem(bound).unwrap_or(0)
    }

    /// Returns an index below `bound`, or zero when `bound` is zero.
    pub fn index(&mut self, bound: usize) -> usize {
        let bound = u64::try_from(bound).unwrap_or(u64::MAX);
        usize::try_from(self.below(bound)).unwrap_or(0)
    }

    /// Returns a 62-bit value whose magnitude is spread over every varint
    /// length, so 1, 2, 4 and 8 octet encodings all appear.
    pub fn varint(&mut self) -> u64 {
        let mask = match self.below(4) {
            0 => 0x3F,
            1 => 0x3FFF,
            2 => 0x3FFF_FFFF,
            _ => 0x3FFF_FFFF_FFFF_FFFF,
        };
        self.next_u64() & mask
    }

    /// Returns `len` random bytes, with `len` below `bound`.
    pub fn bytes(&mut self, bound: usize) -> Vec<u8> {
        let len = self.index(bound);
        (0..len).map(|_| self.byte()).collect()
    }
}
