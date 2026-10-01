//! The streaming UTF-8 validator.
//!
//! The validator accepts exactly the byte sequences of the UTF-8 syntax of RFC
//! 3629 Section 4, which `core::str::from_utf8` implements and quotes:
//!
//! ```text
//! UTF8-1 = %x00-7F
//! UTF8-2 = %xC2-DF UTF8-tail
//! UTF8-3 = %xE0 %xA0-BF UTF8-tail / %xE1-EC 2( UTF8-tail ) /
//!          %xED %x80-9F UTF8-tail / %xEE-EF 2( UTF8-tail )
//! UTF8-4 = %xF0 %x90-BF 2( UTF8-tail ) / %xF1-F3 3( UTF8-tail ) /
//!          %xF4 %x80-8F 2( UTF8-tail )
//! UTF8-tail = %x80-BF
//! ```
//!
//! So overlong forms, the surrogate range and anything above U+10FFFF are
//! refused. The state machine keeps the sequence it is inside across calls,
//! which is what a WebSocket text message split into fragments needs, and a
//! one-shot check reports the same position and length as `core` does.
//!
//! @see <https://www.rfc-editor.org/rfc/rfc3629.html#section-4>

use core::fmt;

/// Why a byte sequence is not UTF-8.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Utf8Error {
    /// The number of bytes of the input that were valid before the error.
    ///
    /// On a fed fragment this is the offset of the offending sequence within
    /// that fragment, or zero when the sequence began in an earlier fragment.
    pub valid_up_to: usize,
    /// The length of the invalid prefix starting at `valid_up_to`, or `None`
    /// when the input ended inside a sequence.
    pub error_len: Option<u8>,
}

impl fmt::Display for Utf8Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.error_len {
            Some(len) => write!(
                f,
                "invalid UTF-8 sequence of {len} bytes from index {}",
                self.valid_up_to
            ),
            None => write!(
                f,
                "incomplete UTF-8 sequence from index {}",
                self.valid_up_to
            ),
        }
    }
}

#[cfg(feature = "std")]
impl std::error::Error for Utf8Error {}

/// Where the validator is inside a sequence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    /// Between sequences; the next byte is a lead byte or ASCII.
    #[default]
    Start,
    /// One `UTF8-tail` remains.
    Tail1,
    /// Two `UTF8-tail` remain.
    Tail2,
    /// Three `UTF8-tail` remain.
    Tail3,
    /// After `E0`: the next byte is `A0-BF`, then one tail.
    E0,
    /// After `ED`: the next byte is `80-9F`, then one tail.
    Ed,
    /// After `F0`: the next byte is `90-BF`, then two tails.
    F0,
    /// After `F4`: the next byte is `80-8F`, then two tails.
    F4,
}

/// A UTF-8 validator that resumes across fragments.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Utf8Validator {
    state: State,
    /// The bytes accepted so far of the sequence in progress.
    seen: u8,
}

impl Utf8Validator {
    /// Creates a validator between sequences.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: State::Start,
            seen: 0,
        }
    }

    /// Returns `true` when no sequence is in progress, so the input so far
    /// is complete UTF-8.
    #[must_use]
    pub const fn is_complete(&self) -> bool {
        matches!(self.state, State::Start)
    }

    /// Forgets any sequence in progress.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// Validates the next fragment.
    ///
    /// # Arguments
    ///
    /// * `bytes` - the fragment; a sequence may end in a later one.
    ///
    /// # Errors
    ///
    /// Returns the first invalid sequence. The validator then stays at the
    /// error, so it must be [`reset`](Self::reset) before reuse.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<(), Utf8Error> {
        let mut index = 0usize;
        while let Some(byte) = bytes.get(index).copied() {
            if matches!(self.state, State::Start) {
                let ascii = bytes.get(index..).map_or(0, crate::scan_ascii);
                if ascii > 0 {
                    index = index.saturating_add(ascii);
                    continue;
                }
            }
            if !self.step(byte) {
                return Err(Utf8Error {
                    valid_up_to: index.saturating_sub(usize::from(self.seen)),
                    error_len: Some(self.seen.max(1)),
                });
            }
            index = index.saturating_add(1);
        }
        Ok(())
    }

    /// Checks that no sequence is in progress at the end of the input.
    ///
    /// # Arguments
    ///
    /// * `len` - the length of the last fragment, so the error can point at
    ///   the start of the unfinished sequence within it.
    ///
    /// # Errors
    ///
    /// Returns an error with `error_len` of `None` when a sequence is
    /// incomplete.
    pub fn finish(&self, len: usize) -> Result<(), Utf8Error> {
        if self.is_complete() {
            Ok(())
        } else {
            Err(Utf8Error {
                valid_up_to: len.saturating_sub(usize::from(self.seen)),
                error_len: None,
            })
        }
    }

    /// Advances by one byte; `false` means the byte is invalid here, in which
    /// case `seen` is the number of bytes of the broken sequence that were
    /// accepted before it.
    fn step(&mut self, byte: u8) -> bool {
        let next = match (self.state, byte) {
            (State::Start, 0x00..=0x7F) => (State::Start, 0),
            (State::Start, 0xC2..=0xDF) => (State::Tail1, 1),
            (State::Start, 0xE0) => (State::E0, 1),
            (State::Start, 0xE1..=0xEC | 0xEE..=0xEF) => (State::Tail2, 1),
            (State::Start, 0xED) => (State::Ed, 1),
            (State::Start, 0xF0) => (State::F0, 1),
            (State::Start, 0xF1..=0xF3) => (State::Tail3, 1),
            (State::Start, 0xF4) => (State::F4, 1),
            (State::Tail1, 0x80..=0xBF) => (State::Start, 0),
            (State::Tail2, 0x80..=0xBF) => (State::Tail1, self.seen.saturating_add(1)),
            (State::Tail3, 0x80..=0xBF) => (State::Tail2, self.seen.saturating_add(1)),
            (State::E0, 0xA0..=0xBF) | (State::Ed, 0x80..=0x9F) => (State::Tail1, 2),
            (State::F0, 0x90..=0xBF) | (State::F4, 0x80..=0x8F) => (State::Tail2, 2),
            _ => return false,
        };
        (self.state, self.seen) = next;
        true
    }
}

/// Validates a complete byte sequence.
///
/// # Arguments
///
/// * `bytes` - the input.
///
/// # Errors
///
/// Returns the first invalid or incomplete sequence, with the same position
/// and length `core::str::from_utf8` reports.
pub fn validate_utf8(bytes: &[u8]) -> Result<(), Utf8Error> {
    let mut validator = Utf8Validator::new();
    validator.feed(bytes)?;
    validator.finish(bytes.len())
}

#[cfg(test)]
mod tests {
    use alloc::string::String;
    use alloc::vec::Vec;

    use super::{validate_utf8, Utf8Error, Utf8Validator};
    use crate::test_support::{iterations, Rng};

    fn core_verdict(bytes: &[u8]) -> Result<(), Utf8Error> {
        core::str::from_utf8(bytes)
            .map(|_| ())
            .map_err(|error| Utf8Error {
                valid_up_to: error.valid_up_to(),
                error_len: error.error_len().and_then(|len| u8::try_from(len).ok()),
            })
    }

    /// RFC 3629 Section 4: the syntax admits no overlong form, no surrogate
    /// and nothing above U+10FFFF, and a truncated sequence is incomplete.
    #[test]
    fn utf8_text_is_validated_against_the_syntax_of_rfc_3629_section_4() {
        assert_eq!(validate_utf8(b""), Ok(()));
        assert_eq!(validate_utf8(b"plain ascii"), Ok(()));
        assert_eq!(validate_utf8("κόσμε".as_bytes()), Ok(()));
        assert_eq!(validate_utf8(&[0xF0, 0x9F, 0x92, 0xA9]), Ok(()));
        assert_eq!(validate_utf8(&[0xF4, 0x8F, 0xBF, 0xBF]), Ok(()));
        let overlong_slash = [0xC0, 0xAF];
        let overlong_nul = [0xE0, 0x80, 0x80];
        let surrogate = [0xED, 0xA0, 0x80];
        let above_max = [0xF4, 0x90, 0x80, 0x80];
        let lead_f5 = [0xF5, 0x80, 0x80, 0x80];
        let lone_tail = [0x80];
        for bad in [
            &overlong_slash[..],
            &overlong_nul,
            &surrogate,
            &above_max,
            &lead_f5,
            &lone_tail,
        ] {
            assert_eq!(validate_utf8(bad), core_verdict(bad), "{bad:?}");
            assert!(validate_utf8(bad).is_err(), "{bad:?}");
        }
        let truncated = [0xE2, 0x82];
        assert_eq!(
            validate_utf8(&truncated),
            Err(Utf8Error {
                valid_up_to: 0,
                error_len: None
            })
        );
        assert_eq!(validate_utf8(&truncated), core_verdict(&truncated));
        let bad_third = [b'a', 0xE2, 0x82, 0x20];
        assert_eq!(
            validate_utf8(&bad_third),
            Err(Utf8Error {
                valid_up_to: 1,
                error_len: Some(2)
            })
        );
        assert_eq!(validate_utf8(&bad_third), core_verdict(&bad_third));
    }

    #[test]
    fn random_bytes_match_core() {
        let mut rng = Rng::new(0x5EED_0010);
        for _ in 0..iterations(40_000) {
            let bytes = rng.utf8_like(0..=48);
            assert_eq!(validate_utf8(&bytes), core_verdict(&bytes), "{bytes:?}");
        }
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn every_two_byte_prefix_matches_core() {
        for first in 0u8..=255 {
            for second in 0u8..=255 {
                let bytes = [first, second];
                assert_eq!(validate_utf8(&bytes), core_verdict(&bytes), "{bytes:?}");
                let longer = [first, second, 0x80, 0x80];
                assert_eq!(validate_utf8(&longer), core_verdict(&longer), "{longer:?}");
            }
        }
    }

    #[test]
    fn valid_strings_are_accepted_whole_and_in_fragments() {
        let mut rng = Rng::new(0x5EED_0011);
        for _ in 0..iterations(5_000) {
            let text = rng.string(0..=40);
            let bytes = text.as_bytes();
            assert_eq!(validate_utf8(bytes), Ok(()), "{text:?}");
            let mut validator = Utf8Validator::new();
            let mut rest = bytes;
            while !rest.is_empty() {
                let take = usize::from(rng.byte())
                    .rem_euclid(rest.len())
                    .saturating_add(1);
                let (fragment, tail) = rest.split_at(take.min(rest.len()));
                assert_eq!(validator.feed(fragment), Ok(()), "{text:?}");
                rest = tail;
            }
            assert_eq!(validator.finish(0), Ok(()), "{text:?}");
            assert!(validator.is_complete());
        }
    }

    #[test]
    fn mutated_strings_match_core() {
        let mut rng = Rng::new(0x5EED_0012);
        for _ in 0..iterations(20_000) {
            let text = rng.string(1..=24);
            let mut bytes: Vec<u8> = text.into_bytes();
            let position = usize::from(rng.byte()).rem_euclid(bytes.len());
            let replacement = rng.byte();
            if let Some(slot) = bytes.get_mut(position) {
                *slot = replacement;
            }
            assert_eq!(validate_utf8(&bytes), core_verdict(&bytes), "{bytes:?}");
        }
    }

    #[test]
    fn fragmented_verdicts_match_the_one_shot_verdict() {
        let mut rng = Rng::new(0x5EED_0013);
        for _ in 0..iterations(20_000) {
            let bytes = rng.utf8_like(0..=40);
            let whole = validate_utf8(&bytes);
            let mut validator = Utf8Validator::new();
            let mut consumed = 0usize;
            let mut streamed = Ok(());
            let mut rest: &[u8] = &bytes;
            while !rest.is_empty() {
                let take = usize::from(rng.byte())
                    .rem_euclid(rest.len())
                    .saturating_add(1);
                let (fragment, tail) = rest.split_at(take.min(rest.len()));
                if let Err(error) = validator.feed(fragment) {
                    streamed = Err((consumed, error));
                    break;
                }
                consumed = consumed.saturating_add(fragment.len());
                rest = tail;
            }
            match (whole, streamed) {
                (Ok(()), Ok(())) => assert!(validator.finish(0).is_ok(), "{bytes:?}"),
                (Err(error), Ok(())) => {
                    assert_eq!(error.error_len, None, "{bytes:?}");
                    assert!(validator.finish(0).is_err(), "{bytes:?}");
                }
                (Err(whole), Err((fragment_start, error))) => {
                    assert_eq!(whole.error_len, error.error_len, "{bytes:?}");
                    if whole.valid_up_to >= fragment_start {
                        assert_eq!(
                            fragment_start.saturating_add(error.valid_up_to),
                            whole.valid_up_to,
                            "{bytes:?}"
                        );
                    } else {
                        assert_eq!(error.valid_up_to, 0, "{bytes:?}");
                    }
                }
                (Ok(()), Err(_)) => unreachable!("fragments refused valid input {bytes:?}"),
            }
        }
    }

    #[test]
    fn a_validator_stays_at_its_error_until_reset() {
        let mut validator = Utf8Validator::new();
        assert!(validator.feed(&[0xE2, 0x82]).is_ok());
        assert!(!validator.is_complete());
        assert!(validator.finish(2).is_err());
        assert!(validator.feed(&[0x20]).is_err());
        assert!(validator.feed(b"ok").is_err());
        validator.reset();
        assert!(validator.feed(b"ok").is_ok());
        assert!(validator.is_complete());
        assert_eq!(
            alloc::format!(
                "{}",
                Utf8Error {
                    valid_up_to: 3,
                    error_len: Some(2)
                }
            ),
            "invalid UTF-8 sequence of 2 bytes from index 3"
        );
        assert_eq!(
            alloc::format!(
                "{}",
                Utf8Error {
                    valid_up_to: 3,
                    error_len: None
                }
            ),
            "incomplete UTF-8 sequence from index 3"
        );
        let _ = String::new();
    }
}
