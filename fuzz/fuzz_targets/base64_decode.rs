//! The base64 and base64url codec on arbitrary bytes, under both alphabets
//! (RFC 4648 Sections 4 and 5), padded and not (Section 3.2). A value that
//! decodes is the one spelling of its data, since bytes outside the alphabet and
//! nonzero pad bits are refused (Sections 3.3 and 3.5), so encoding the data
//! gives the value back; the data fits `decoded_len`, fills a buffer of its own
//! length and reports a buffer one octet shorter as full; a refused byte is the
//! input's byte at the offset named and outside the alphabet; the alphabets agree
//! on values without their last two characters; and any data encodes to
//! `encoded_len` alphabet characters that decode back to it.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_base64::{
    decode, decode_slice, decoded_len, encode, encode_slice, encoded_len, Alphabet, DecodeError,
    PAD,
};

const ALPHABETS: [Alphabet; 2] = [Alphabet::Standard, Alphabet::UrlSafe];

/// Whether `byte` is one of the alphabet's 64 characters (RFC 4648 Tables 1 and
/// 2).
fn in_alphabet(byte: u8, alphabet: Alphabet) -> bool {
    byte.is_ascii_alphanumeric()
        || match alphabet {
            Alphabet::Standard => matches!(byte, b'+' | b'/'),
            Alphabet::UrlSafe => matches!(byte, b'-' | b'_'),
        }
}

fn check_decode(input: &[u8], alphabet: Alphabet, padded: bool) -> Result<Vec<u8>, DecodeError> {
    let decoded = decode(input, alphabet, padded);
    match &decoded {
        Ok(data) => {
            assert!(data.len() <= decoded_len(input.len()));
            assert_eq!(
                encode(data, alphabet, padded).as_bytes(),
                input,
                "one spelling"
            );
            let mut exact = vec![0u8; data.len()];
            assert_eq!(
                decode_slice(input, alphabet, padded, &mut exact),
                Ok(data.len())
            );
            assert_eq!(&exact, data);
            if let Some(short) = data.len().checked_sub(1) {
                let mut small = vec![0u8; short];
                assert_eq!(
                    decode_slice(input, alphabet, padded, &mut small),
                    Err(DecodeError::Full)
                );
            }
        }
        Err(DecodeError::InvalidByte { offset, byte }) => {
            assert_eq!(input.get(*offset), Some(byte));
            assert!(!in_alphabet(*byte, alphabet));
        }
        Err(DecodeError::Full) => panic!("decode sizes its own buffer"),
        Err(DecodeError::InvalidPadding) => {
            assert!(input.contains(&PAD) || padded);
        }
        Err(DecodeError::InvalidLength | DecodeError::NonZeroPadBits) => {}
    }
    decoded
}

fn check_encode(data: &[u8], alphabet: Alphabet, pad: bool) {
    let encoded = encode(data, alphabet, pad);
    assert_eq!(Some(encoded.len()), encoded_len(data.len(), pad));
    let body = encoded.trim_end_matches('=');
    assert!(body.bytes().all(|byte| in_alphabet(byte, alphabet)));
    assert!(pad || body.len() == encoded.len());
    assert_eq!(
        decode(encoded.as_bytes(), alphabet, pad).as_deref(),
        Ok(data)
    );
    let mut exact = vec![0u8; encoded.len()];
    assert_eq!(
        encode_slice(data, alphabet, pad, &mut exact),
        Ok(encoded.len())
    );
    assert_eq!(exact, encoded.as_bytes());
    if let Some(short) = encoded.len().checked_sub(1) {
        let mut small = vec![0u8; short];
        assert_eq!(
            encode_slice(data, alphabet, pad, &mut small),
            Err(DecodeError::Full)
        );
    }
}

fuzz_target!(|data: &[u8]| {
    for padded in [true, false] {
        let standard = check_decode(data, Alphabet::Standard, padded);
        let url = check_decode(data, Alphabet::UrlSafe, padded);
        if !data
            .iter()
            .any(|byte| matches!(byte, b'+' | b'/' | b'-' | b'_'))
        {
            assert_eq!(standard, url, "the alphabets differ only in two characters");
        }
        for alphabet in ALPHABETS {
            check_encode(data, alphabet, padded);
        }
    }
});
