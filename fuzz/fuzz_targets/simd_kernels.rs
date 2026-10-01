//! Every dispatched kernel and every SWAR kernel against the per-byte
//! definitions, on arbitrary bytes, with the search needle and the masking
//! key drawn from the input.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_simd::{
    find_byte, find_cr_or_lf, rotate_key, scalar, scan_ascii, scan_header_name, scan_header_value,
    scan_target, swar, unmask,
};

fuzz_target!(|data: &[u8]| {
    let needle = data.first().copied().unwrap_or(b'\r');

    assert_eq!(scan_ascii(data), scalar::scan_ascii(data));
    assert_eq!(scan_target(data), scalar::scan_target(data));
    assert_eq!(scan_header_name(data), scalar::scan_header_name(data));
    assert_eq!(scan_header_value(data), scalar::scan_header_value(data));
    assert_eq!(find_byte(data, needle), scalar::find_byte(data, needle));
    assert_eq!(find_cr_or_lf(data), scalar::find_cr_or_lf(data));

    assert_eq!(swar::scan_ascii(data), scalar::scan_ascii(data));
    assert_eq!(swar::scan_target(data), scalar::scan_target(data));
    assert_eq!(swar::scan_header_name(data), scalar::scan_header_name(data));
    assert_eq!(
        swar::scan_header_value(data),
        scalar::scan_header_value(data)
    );
    assert_eq!(
        swar::find_byte(data, needle),
        scalar::find_byte(data, needle)
    );
    assert_eq!(swar::find_cr_or_lf(data), scalar::find_cr_or_lf(data));

    let key = [
        data.first().copied().unwrap_or(1),
        data.get(1).copied().unwrap_or(2),
        data.get(2).copied().unwrap_or(3),
        data.get(3).copied().unwrap_or(4),
    ];
    let mut dispatched = data.to_vec();
    let mut reference = data.to_vec();
    unmask(&mut dispatched, key);
    scalar::unmask(&mut reference, key);
    assert_eq!(dispatched, reference);
    unmask(&mut dispatched, key);
    assert_eq!(dispatched, data);

    let split = data.len() / 2;
    let (head, tail) = data.split_at(split);
    let mut head = head.to_vec();
    let mut tail = tail.to_vec();
    unmask(&mut head, key);
    unmask(&mut tail, rotate_key(key, split));
    head.extend_from_slice(&tail);
    assert_eq!(head, reference);
});
