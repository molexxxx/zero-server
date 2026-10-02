//! The static-only QPACK decoder on arbitrary field sections: it never
//! panics, a section whose lines all decode re-encodes under two Huffman
//! policies to the same lines with the N bit kept and set on the sensitive
//! names, every representation stays inside its input, an integer fault is
//! reported exactly when an integer is longer or larger than 62 bits, and with
//! a 16-octet string limit an invalid static index or a dynamic reference is
//! still reported as such (RFC 9204 Sections 3.1 and 2.2.3), never as the
//! string limit of Section 7.4.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_limits::Http3Limits;
use zero_qpack::encoder::SENSITIVE_NAMES;
use zero_qpack::integer::MAX_VALUE;
use zero_qpack::{Decoder, Encoder, Fault, FieldLine, HuffmanPolicy, Prefix, Representation};

/// Limits small enough that a string literal of 17 octets is over the limit.
const SMALL: Http3Limits = Http3Limits {
    max_field_section_size: 4,
    qpack_integer_cap: 16,
    ..Http3Limits::DEFAULT
};

/// The fault a representation's table reference earns at capacity zero, if
/// any: a static index above 98 or any dynamic reference.
fn reference_fault(representation: &Representation<'_>) -> Option<Fault> {
    match *representation {
        Representation::Indexed {
            static_table: true,
            index,
        }
        | Representation::LiteralNameReference {
            static_table: true,
            index,
            ..
        } => (index > 98).then_some(Fault::InvalidStaticIndex),
        Representation::LiteralName { .. } => None,
        _ => Some(Fault::DynamicReference),
    }
}

/// An integer with an N-bit prefix read as RFC 7541 Section 5.1 describes it,
/// with no cap: the value and its length, `u128::MAX` for a ninth
/// continuation octet that flags another, or `None` when the input ends
/// inside it.
fn reference(input: &[u8], bits: u32) -> Option<(u128, usize)> {
    let mask = u8::try_from((1u16 << bits) - 1).unwrap();
    let first = *input.first()?;
    let mut value = u128::from(first & mask);
    if value < u128::from(mask) {
        return Some((value, 1));
    }
    for (count, &octet) in input[1..].iter().enumerate() {
        value += u128::from(octet & 0x7f) << (7 * count);
        if octet & 0x80 == 0 {
            return Some((value, count + 2));
        }
        if count + 1 >= 9 {
            return Some((u128::MAX, count + 2));
        }
    }
    None
}

/// Whether an integer is beyond 62 bits.
fn oversized(value: u128) -> bool {
    value > u128::from(MAX_VALUE)
}

/// Whether the prefix holds an integer beyond 62 bits before the input ends.
fn prefix_oversized(input: &[u8]) -> bool {
    let Some((value, used)) = reference(input, 8) else {
        return false;
    };
    oversized(value) || matches!(reference(&input[used..], 7), Some((value, _)) if oversized(value))
}

/// Whether the representation at the start of `input` holds an integer beyond
/// 62 bits before the input ends: the index or name length first, then the
/// value length.
fn representation_oversized(input: &[u8]) -> bool {
    let Some(&first) = input.first() else {
        return false;
    };
    let (bits, name_first, value_follows) = if first & 0x80 != 0 {
        (6, false, false)
    } else if first & 0xc0 == 0x40 {
        (4, false, true)
    } else if first & 0xe0 == 0x20 {
        (3, true, true)
    } else if first & 0xf0 == 0x10 {
        (4, false, false)
    } else {
        (3, false, true)
    };
    let Some((value, used)) = reference(input, bits) else {
        return false;
    };
    if oversized(value) {
        return true;
    }
    let mut rest = &input[used..];
    if name_first {
        let Some(name) = usize::try_from(value).ok().filter(|len| *len <= rest.len()) else {
            return false;
        };
        rest = &rest[name..];
    }
    value_follows && matches!(reference(rest, 7), Some((value, _)) if oversized(value))
}

fuzz_target!(|data: &[u8]| {
    match Prefix::parse(data) {
        Ok((_, used)) => {
            assert!(used <= data.len());
            assert!(!prefix_oversized(data));
            let mut rest = &data[used..];
            while !rest.is_empty() {
                match Representation::parse(rest) {
                    Ok((_, used)) => {
                        assert!(used > 0 && used <= rest.len());
                        assert!(!representation_oversized(rest));
                        rest = &rest[used..];
                    }
                    Err(fault) => {
                        assert_eq!(
                            matches!(fault, Fault::Integer(_)),
                            representation_oversized(rest),
                            "an integer fault names an integer beyond 62 bits"
                        );
                        break;
                    }
                }
            }
        }
        Err(fault) => assert_eq!(matches!(fault, Fault::Integer(_)), prefix_oversized(data)),
    }

    let small = Decoder::new(&SMALL).unwrap();
    if let (Ok(lines), Ok((_, used))) = (small.decode(data), Prefix::parse(data)) {
        let mut rest = &data[used..];
        for line in lines {
            let Ok((representation, used)) = Representation::parse(rest) else {
                break;
            };
            if let Some(fault) = reference_fault(&representation) {
                assert_eq!(
                    line.err().map(|error| error.fault),
                    Some(fault),
                    "a table reference fault comes before the string limit"
                );
                break;
            }
            if line.is_err() {
                break;
            }
            rest = &rest[used..];
        }
    }

    let decoder = Decoder::new(&Http3Limits::DEFAULT).unwrap();
    let Ok(lines) = decoder
        .decode(data)
        .and_then(|lines| lines.collect::<Result<Vec<FieldLine<'_>>, _>>())
    else {
        return;
    };
    for policy in [HuffmanPolicy::Never, HuffmanPolicy::Shorter] {
        let mut encoded = Vec::new();
        Encoder::new(policy).encode(&lines, &mut encoded).unwrap();
        let again: Vec<FieldLine<'_>> = decoder
            .decode(&encoded)
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(again.len(), lines.len());
        for (before, after) in lines.iter().zip(&again) {
            assert_eq!(before.name, after.name);
            assert_eq!(before.value, after.value);
            let sensitive = SENSITIVE_NAMES.contains(&&*before.name);
            assert_eq!(after.never_indexed, before.never_indexed || sensitive);
        }
    }
});
