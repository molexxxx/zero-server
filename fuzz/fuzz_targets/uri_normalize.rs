//! The RFC 3986 helpers on arbitrary bytes: parsing, percent-decoding and path
//! normalization never panic, normalization is idempotent, a normalized path has
//! no dot-segment, no lowercase hexadecimal digit in a triplet and no triplet for
//! an unreserved octet, and every component range lies inside the input.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_uri::{is_unreserved, normalize_path, parse, percent_decode, remove_dot_segments, split_query};

fuzz_target!(|data: &[u8]| {
    if let Ok(components) = parse(data) {
        for range in [components.scheme, components.authority, Some(components.path), components.query, components.fragment]
            .into_iter()
            .flatten()
        {
            assert!(range.start <= range.end && range.end <= data.len());
        }
    }
    let mut decoded = Vec::new();
    let _ = percent_decode(data, &mut decoded);
    assert!(decoded.len() <= data.len());

    let (path, query) = split_query(data);
    assert_eq!(path.len() + query.map_or(0, |q| q.len() + 1), data.len());

    let mut scratch = Vec::new();
    let Ok(normalized) = normalize_path(path, &mut scratch) else {
        return;
    };
    let normalized = normalized.to_vec();
    let mut again = Vec::new();
    assert_eq!(normalize_path(&normalized, &mut again), Ok(normalized.as_slice()), "idempotent");
    for segment in normalized.split(|&b| b == b'/') {
        assert!(segment != b"." && segment != b"..");
    }
    let mut at = 0;
    while at < normalized.len() {
        if normalized[at] == b'%' {
            let high = normalized[at + 1];
            let low = normalized[at + 2];
            assert!(!high.is_ascii_lowercase() && !low.is_ascii_lowercase());
            let octet = u8::from_str_radix(std::str::from_utf8(&normalized[at + 1..at + 3]).unwrap(), 16).unwrap();
            assert!(!is_unreserved(octet));
            at += 3;
        } else {
            at += 1;
        }
    }
    let mut dots = normalized.clone();
    remove_dot_segments(&mut dots);
    assert_eq!(dots, normalized, "no dot-segment survives normalization");
});
