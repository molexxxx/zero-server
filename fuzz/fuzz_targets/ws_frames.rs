//! The WebSocket frame header decoder and the Close body reader on arbitrary
//! bytes, the first octet naming the reserved bits an extension allows: a header
//! that decodes is masked, uses the fewest length octets and re-encodes, unmasked
//! and with its reserved bits cleared, to the octets it came from (RFC 6455
//! Section 5.2); every shorter prefix of it asks for more input; a control frame
//! is final and at most 125 octets (Section 5.5); and a Close body that parses
//! rebuilds to the same octets, while 0 to 999, 1005, 1006 and 1015 are never
//! accepted as a status code (Sections 5.5.1, 7.4.1 and 7.4.2).

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_ws::close::{self, CloseCode};
use zero_ws::frame::{self, MAX_CONTROL_PAYLOAD, MAX_HEADER};

/// The header length the first two octets announce: the two octets, the
/// extended length and the masking key.
fn announced(input: &[u8]) -> Option<usize> {
    let short = input.get(1)? & 0x7f;
    Some(match short {
        126 => 8,
        127 => 14,
        _ => 6,
    })
}

fn check_header(input: &[u8], allowed_rsv: u8) {
    match frame::decode(input, allowed_rsv) {
        Ok(Some(header)) => {
            let len = header.header_len;
            assert_eq!(Some(len), announced(input));
            assert!(len <= input.len() && len <= MAX_HEADER);
            assert_eq!(input[1] & 0x80, 0x80, "a client frame is masked");
            assert_eq!(header.rsv & !allowed_rsv, 0);
            assert_eq!(header.rsv, (input[0] >> 4) & 0x07);
            assert_eq!(header.fin, input[0] & 0x80 != 0);
            assert_eq!(header.len >> 63, 0);
            if header.opcode.is_control() {
                assert!(header.fin);
                assert!(header.len <= MAX_CONTROL_PAYLOAD as u64);
            }
            let mut encoded = [0u8; 10];
            let written = frame::encode(header.fin, header.opcode, header.len, &mut encoded);
            assert_eq!(written + 4, len);
            let mut expected = input[..written].to_vec();
            expected[0] &= 0x8f;
            expected[1] &= 0x7f;
            assert_eq!(
                &encoded[..written],
                &expected[..],
                "the fewest length octets"
            );
            assert_eq!(&header.mask[..], &input[written..len]);
            for end in 0..len {
                assert_eq!(frame::decode(&input[..end], allowed_rsv), Ok(None));
            }
        }
        Ok(None) => {
            if let Some(len) = announced(input) {
                assert!(input.len() < len);
            }
        }
        Err(code) => assert_eq!(code, CloseCode::PROTOCOL_ERROR),
    }
}

fn check_close(payload: &[u8]) {
    let parsed = close::parse(payload);
    let Some((code, reason)) = payload.split_first_chunk::<2>() else {
        let expected = if payload.is_empty() {
            Ok(CloseCode::NO_STATUS)
        } else {
            Err(CloseCode::PROTOCOL_ERROR)
        };
        assert_eq!(parsed.map(|close| close.code), expected);
        return;
    };
    let code = u16::from_be_bytes(*code);
    if matches!(code, 0..=999 | 1005 | 1006 | 1015) {
        assert_eq!(parsed, Err(CloseCode::PROTOCOL_ERROR));
    }
    match parsed {
        Ok(close) => {
            assert_eq!(close.code, CloseCode(code));
            assert_eq!(close.reason.as_bytes(), reason);
            if payload.len() <= MAX_CONTROL_PAYLOAD {
                let mut body = [0u8; MAX_CONTROL_PAYLOAD];
                let written = close::body(close.code, close.reason, &mut body).unwrap();
                assert_eq!(&body[..written], payload);
            }
        }
        Err(CloseCode::INVALID_PAYLOAD) => {
            assert!(CloseCode(code).is_valid());
            assert!(std::str::from_utf8(reason).is_err());
        }
        Err(other) => {
            assert_eq!(other, CloseCode::PROTOCOL_ERROR);
            assert!(!CloseCode(code).is_valid());
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&selector, input)) = data.split_first() else {
        return;
    };
    check_header(input, selector & 0x07);
    check_close(input);
});
