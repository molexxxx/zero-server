//! The strict JSON parser on arbitrary bytes: it never panics, a parsed value
//! written back parses to the same value, and the error offset lies inside the
//! input.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_json::{parse, parse_with, to_vec, BigIntegers, Options, TopLevel};

fuzz_target!(|data: &[u8]| {
    match parse(data) {
        Ok(value) => {
            let written = to_vec(&value).expect("a parsed value is finite and shallow enough");
            let again = parse(&written).expect("the writer's output parses");
            assert_eq!(again, value, "round trip");
        }
        Err(error) => assert!(error.offset <= data.len()),
    }
    let strict = Options {
        max_depth: 8,
        max_size: 512,
        top_level: TopLevel::ObjectOrArray,
        big_integers: BigIntegers::Strings,
    };
    let _ = parse_with(data, &strict);
});
