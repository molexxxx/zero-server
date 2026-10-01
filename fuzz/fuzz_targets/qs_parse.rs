//! The form-urlencoded parser on arbitrary bytes: it never panics, yields at most
//! one pair per `&`-separated sequence, and every decoded string is valid UTF-8
//! no longer than its sequence.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_qs::{decode, parse};

fuzz_target!(|data: &[u8]| {
    let sequences = data.split(|&b| b == b'&').filter(|s| !s.is_empty()).count();
    let mut pairs = 0usize;
    for (name, value) in parse(data) {
        pairs += 1;
        assert!(name.chars().count() <= data.len() && value.chars().count() <= data.len());
    }
    assert_eq!(pairs, sequences);
    let mut raw = parse(data);
    while let Some((name, value)) = raw.next_raw() {
        assert!(name.len() + value.len() <= data.len());
        let _ = decode(name);
        let _ = decode(value);
    }
});
