//! The control-message walk on arbitrary bytes: it never panics, every message it yields
//! lies inside the input, and what the builder writes is read back unchanged.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_sys::cmsg::{messages, Builder};

fuzz_target!(|data: &[u8]| {
    let mut count = 0usize;
    for message in messages(data) {
        assert!(message.data.len() <= data.len());
        let _ = message.int();
        count += 1;
    }
    // A header is at least twelve bytes on every platform.
    assert!(count <= data.len() / 12 + 1, "{count} messages from {} bytes", data.len());

    let mut buf = vec![0u8; 64 * 32];
    let mut builder = Builder::new(&mut buf);
    let mut expected = Vec::new();
    for (index, chunk) in data.chunks(7).take(64).enumerate() {
        let level = index as i32;
        let kind = chunk.len() as i32;
        if builder.push(level, kind, chunk).is_ok() {
            expected.push((level, kind, chunk.to_vec()));
        }
    }
    let found: Vec<(i32, i32, Vec<u8>)> = messages(builder.written())
        .map(|message| (message.level, message.kind, message.data.to_vec()))
        .collect();
    assert_eq!(found, expected);
});
