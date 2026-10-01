//! The request head parser on arbitrary bytes: it never panics, every proper
//! prefix of a complete head is partial, and the head's spans lie inside the
//! input.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_http1::{parse_request, Field, Status};
use zero_limits::http1::Http1Limits;

fuzz_target!(|data: &[u8]| {
    let mut table = [Field::EMPTY; 16];
    let limits = Http1Limits::DEFAULT;
    match parse_request(data, &mut table, &limits) {
        Status::Complete(head) => {
            assert!(head.len <= data.len());
            assert!(head.method_token.end <= head.len);
            assert!(head.target.end <= head.len);
            assert!(head.path.end <= head.len);
            assert!(head.field_count <= table.len());
            for field in table.iter().take(head.field_count) {
                assert!(field.name.end <= head.len);
                assert!(field.value.end <= head.len);
                assert!(!field.name.is_empty());
            }
            if let Some(authority) = head.authority {
                assert!(authority.end <= head.len);
            }
            let mut again = [Field::EMPTY; 16];
            for cut in 0..head.len {
                assert_eq!(
                    parse_request(&data[..cut], &mut again, &limits),
                    Status::Partial,
                    "prefix {cut}"
                );
            }
        }
        Status::Partial => {
            let mut again = [Field::EMPTY; 16];
            let mut longer = data.to_vec();
            longer.extend_from_slice(b"\r\n\r\n");
            let _ = parse_request(&longer, &mut again, &limits);
        }
        Status::Reject(reject) => {
            assert!(reject.close);
            let status = reject.status.as_u16();
            assert!(matches!(status, 400 | 414 | 431 | 501 | 505), "{status}");
        }
    }
});
