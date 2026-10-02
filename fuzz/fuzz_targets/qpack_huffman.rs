//! The RFC 7541 Huffman code on arbitrary bytes: decoding into a buffer of
//! `decoded_len_bound` octets never runs out of room, the slice and vector
//! decoders agree, a decoded string encodes and decodes back to itself, and
//! every input encodes to `encoded_len` octets that decode back to it.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_qpack::huffman::{self, HuffmanError};

fuzz_target!(|data: &[u8]| {
    let mut buffer = vec![0u8; huffman::decoded_len_bound(data.len())];
    let sliced = huffman::decode(data, &mut buffer);
    assert_ne!(sliced, Err(HuffmanError::OutputFull));
    let mut decoded = Vec::new();
    let owned = huffman::decode_to_vec(data, &mut decoded);
    match (sliced, owned) {
        (Ok(written), Ok(())) => {
            assert_eq!(&buffer[..written], &decoded[..]);
            let mut again = Vec::new();
            huffman::encode(&decoded, &mut again);
            let mut round = Vec::new();
            huffman::decode_to_vec(&again, &mut round).unwrap();
            assert_eq!(round, decoded);
        }
        (Err(a), Err(b)) => assert_eq!(a, b),
        (sliced, owned) => panic!("the decoders disagree: {sliced:?} and {owned:?}"),
    }

    let mut encoded = Vec::new();
    huffman::encode(data, &mut encoded);
    assert_eq!(
        huffman::encoded_len(data),
        u64::try_from(encoded.len()).unwrap()
    );
    let mut round = Vec::new();
    huffman::decode_to_vec(&encoded, &mut round).unwrap();
    assert_eq!(round, data);
});
