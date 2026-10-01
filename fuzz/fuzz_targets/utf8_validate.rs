//! The UTF-8 validator against `core::str::from_utf8`, one-shot and in
//! fragments whose size the first input byte selects.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_simd::{validate_utf8, Utf8Validator};

fuzz_target!(|data: &[u8]| {
    let expected = core::str::from_utf8(data);
    match (validate_utf8(data), &expected) {
        (Ok(()), Ok(_)) => {}
        (Err(error), Err(core_error)) => {
            assert_eq!(error.valid_up_to, core_error.valid_up_to());
            assert_eq!(error.error_len.map(usize::from), core_error.error_len());
        }
        (ours, _) => panic!("verdicts differ: {ours:?} versus {expected:?}"),
    }

    let step = usize::from(data.first().copied().unwrap_or(1) % 7) + 1;
    let mut validator = Utf8Validator::new();
    let mut accepted = true;
    for fragment in data.chunks(step) {
        if validator.feed(fragment).is_err() {
            accepted = false;
            break;
        }
    }
    let accepted = accepted && validator.finish(0).is_ok();
    assert_eq!(accepted, expected.is_ok(), "fragmented verdict differs");
});
