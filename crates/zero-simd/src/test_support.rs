//! The deterministic generator the property tests draw their inputs from.

use alloc::string::String;
use alloc::vec::Vec;
use core::ops::RangeInclusive;

/// Returns the number of cases a property test runs: the full count on a
/// native run, a hundredth under Miri, which interprets every instruction.
pub fn iterations(native: usize) -> usize {
    if cfg!(miri) {
        native.div_euclid(100).max(50)
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

    /// Returns a length drawn uniformly from the range.
    pub fn len(&mut self, range: RangeInclusive<usize>) -> usize {
        let span = range.end().saturating_sub(*range.start()).saturating_add(1);
        let offset = usize::try_from(self.next_u64().rem_euclid(span as u64)).unwrap_or_default();
        range.start().saturating_add(offset)
    }

    /// Returns random bytes of a random length in the range.
    pub fn bytes(&mut self, len: RangeInclusive<usize>) -> Vec<u8> {
        let len = self.len(len);
        (0..len).map(|_| self.byte()).collect()
    }

    /// Returns bytes drawn from the UTF-8 lead, tail and ASCII ranges in
    /// proportions that form real and nearly real sequences.
    pub fn utf8_like(&mut self, len: RangeInclusive<usize>) -> Vec<u8> {
        let len = self.len(len);
        (0..len)
            .map(|_| {
                let roll = self.next_u64();
                let class = roll.rem_euclid(8);
                let byte = self.byte();
                match class {
                    0 | 1 => byte & 0x7F,
                    2..=4 => 0x80 | (byte & 0x3F),
                    5 => 0xC0 | (byte & 0x1F),
                    6 => 0xE0 | (byte & 0x0F),
                    _ => 0xF0 | (byte & 0x07),
                }
            })
            .collect()
    }

    /// Returns a random scalar value, so every encoded length appears.
    pub fn char(&mut self) -> char {
        loop {
            let roll = self.next_u64();
            let value = match roll.rem_euclid(4) {
                0 => u32::try_from(roll.wrapping_shr(8).rem_euclid(0x80)).unwrap_or_default(),
                1 => u32::try_from(roll.wrapping_shr(8).rem_euclid(0x800)).unwrap_or_default(),
                2 => u32::try_from(roll.wrapping_shr(8).rem_euclid(0x1_0000)).unwrap_or_default(),
                _ => u32::try_from(roll.wrapping_shr(8).rem_euclid(0x11_0000)).unwrap_or_default(),
            };
            if let Some(character) = char::from_u32(value) {
                return character;
            }
        }
    }

    /// Returns a random string of a random number of characters in the
    /// range.
    pub fn string(&mut self, chars: RangeInclusive<usize>) -> String {
        let count = self.len(chars);
        (0..count).map(|_| self.char()).collect()
    }
}
