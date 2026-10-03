//! The media type parser, the `Accept` negotiator and the extension table on
//! arbitrary bytes. A `media-type` that parses is its type, a slash, its subtype
//! and its parameter section, both tokens (RFC 9110 Sections 5.6.2 and 8.3.1);
//! written back with each parameter value as a token or a quoted-string, which
//! are equivalent (Section 5.6.6), it parses to the same type, subtype and
//! parameters, and `parameter` agrees with the iterator. Negotiation names an
//! available type, one the `Accept` value also accepts alone (Section 12.5.1),
//! and the text test and the extension lookup ignore case. Empty parameters
//! between or after semicolons are allowed and name nothing (Section 5.6.6).

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_mime::{from_extension, from_path, is_text, negotiate, parse, MediaType, Unquoted};

const AVAILABLE: [&str; 4] = ["application/json", "text/html", "text/plain", "image/png"];

/// RFC 9110 Section 5.6.2 `tchar`.
fn is_tchar(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

/// The parameters in order: the name, the value with its quoting undone, and
/// whether the value is borrowed from the input.
fn parameters(media: &MediaType<'_>, scratch_len: usize) -> Vec<(Vec<u8>, Vec<u8>, bool)> {
    let mut scratch = vec![0u8; scratch_len];
    let mut iter = media.parameters(&mut scratch);
    let mut out = Vec::new();
    while let Some((name, value)) = iter.next_parameter() {
        let borrowed = matches!(value, Unquoted::Borrowed(_));
        out.push((name.to_vec(), value.bytes().to_vec(), borrowed));
    }
    out
}

/// The media type written back: each value a token when it is one, else a
/// quoted-string with `"` and `\` escaped (RFC 9110 Section 5.6.4).
fn write(media: &MediaType<'_>, list: &[(Vec<u8>, Vec<u8>, bool)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(media.kind);
    out.push(b'/');
    out.extend_from_slice(media.subtype);
    for (name, value, _) in list {
        out.push(b';');
        out.extend_from_slice(name);
        out.push(b'=');
        if !value.is_empty() && value.iter().all(|&byte| is_tchar(byte)) {
            out.extend_from_slice(value);
        } else {
            out.push(b'"');
            for &byte in value {
                if byte == b'"' || byte == b'\\' {
                    out.push(b'\\');
                }
                out.push(byte);
            }
            out.push(b'"');
        }
    }
    out
}

fuzz_target!(|data: &[u8]| {
    if let Some(media) = parse(data) {
        assert!(!media.kind.is_empty() && media.kind.iter().all(|&byte| is_tchar(byte)));
        assert!(!media.subtype.is_empty() && media.subtype.iter().all(|&byte| is_tchar(byte)));
        assert_eq!(
            media.kind.len() + 1 + media.subtype.len() + media.parameters.len(),
            data.len()
        );
        assert!(data.starts_with(media.kind) && data.ends_with(media.parameters));
        let mut essence = media.kind.to_ascii_uppercase();
        essence.push(b'/');
        essence.extend_from_slice(&media.subtype.to_ascii_lowercase());
        assert!(media.is(&essence), "the type and subtype ignore case");

        let list = parameters(&media, data.len());
        for (name, _, _) in &list {
            let first = list
                .iter()
                .find(|(other, _, borrowed)| other.eq_ignore_ascii_case(name) && *borrowed)
                .map(|(_, value, _)| value.as_slice());
            assert_eq!(media.parameter(name), first);
        }
        let written = write(&media, &list);
        let again = parse(&written).expect("the written form parses");
        assert_eq!(again.kind, media.kind);
        assert_eq!(again.subtype, media.subtype);
        let reread: Vec<(Vec<u8>, Vec<u8>)> = parameters(&again, written.len())
            .into_iter()
            .map(|(name, value, _)| (name, value))
            .collect();
        let original: Vec<(Vec<u8>, Vec<u8>)> = list
            .into_iter()
            .map(|(name, value, _)| (name, value))
            .collect();
        assert_eq!(reread, original);
        assert_eq!(is_text(&essence), is_text(&essence.to_ascii_lowercase()));

        let mut trailing = data.to_vec();
        trailing.extend_from_slice(b"; ;");
        let empty = parse(&trailing).expect("an empty parameter is allowed (Section 5.6.6)");
        let with_empty: Vec<(Vec<u8>, Vec<u8>)> = parameters(&empty, trailing.len())
            .into_iter()
            .map(|(name, value, _)| (name, value))
            .collect();
        assert_eq!(with_empty, original);
    }

    assert_eq!(negotiate(None, &AVAILABLE), Some(0));
    assert_eq!(negotiate(Some(data), &[]), None);
    if let Some(index) = negotiate(Some(data), &AVAILABLE) {
        assert!(index < AVAILABLE.len());
        assert_eq!(
            negotiate(Some(data), &AVAILABLE[index..=index]),
            Some(0),
            "the chosen type is acceptable alone"
        );
    }

    let found = from_path(data);
    assert_eq!(from_path(&data.to_ascii_uppercase()), found);
    assert_eq!(
        from_extension(&data.to_ascii_lowercase()),
        from_extension(data)
    );
    if let Some(media_type) = found {
        assert!(parse(media_type.as_bytes()).is_some());
    }
});
