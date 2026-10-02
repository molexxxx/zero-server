//! The RFC 7541 prefixed integer and the RFC 9204 string literal on arbitrary
//! bytes, the first octet choosing the prefix size: they never panic, an
//! integer never takes more than ten octets and re-encodes with its flag bits
//! to the same value, and a string literal never claims more octets than are
//! present and re-encodes to itself.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_qpack::integer::{self, PrefixBits, MAX_LEN, MAX_VALUE};
use zero_qpack::{StringLiteral, StringPrefixBits};

fn integer_case(input: &[u8], prefix: PrefixBits) {
    let Ok(Some((value, used))) = integer::decode(input, prefix, MAX_VALUE) else {
        return;
    };
    assert!(used <= MAX_LEN && used <= input.len());
    assert!(value <= MAX_VALUE);
    let flags = input[0] & !prefix.mask();
    let mut out = Vec::new();
    integer::push(value, prefix, flags, &mut out).unwrap();
    assert_eq!(out[0] & !prefix.mask(), flags);
    assert!(out.len() <= used, "the shortest encoding is never longer");
    assert_eq!(integer::encoded_len(value, prefix), Some(out.len()));
    assert_eq!(
        integer::decode(&out, prefix, MAX_VALUE),
        Ok(Some((value, out.len())))
    );
}

fn string_case(input: &[u8], prefix: StringPrefixBits) {
    let Ok(Some((literal, used))) = StringLiteral::parse(input, prefix, MAX_VALUE) else {
        return;
    };
    assert!(used <= input.len());
    let (len, len_used) = integer::decode(input, prefix.length_prefix(), MAX_VALUE)
        .unwrap()
        .unwrap();
    assert_eq!(u64::try_from(literal.data.len()).unwrap(), len);
    assert_eq!(used, len_used + literal.data.len());
    assert_eq!(literal.huffman, input[0] & prefix.huffman_flag() != 0);
    let flags = input[0] & !(prefix.huffman_flag() | prefix.length_prefix().mask());
    let mut out = Vec::new();
    literal.encode(prefix, flags, &mut out).unwrap();
    assert_eq!(
        StringLiteral::parse(&out, prefix, MAX_VALUE),
        Ok(Some((literal, out.len())))
    );
    let _ = literal.decode();
}

fuzz_target!(|data: &[u8]| {
    let Some((&selector, input)) = data.split_first() else {
        return;
    };
    if selector & 0x80 == 0 {
        integer_case(input, PrefixBits::ALL[usize::from(selector & 0x07)]);
    } else {
        let index = usize::from(selector & 0x7f) % StringPrefixBits::ALL.len();
        string_case(input, StringPrefixBits::ALL[index]);
    }
});
