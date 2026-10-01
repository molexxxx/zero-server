//! Base 64 (RFC 4648 Section 4) and base64url (Section 5) for zero-server.
//!
//! The encoder writes into a caller's buffer or a new `Vec`, pads unless told not
//! to (Section 3.2), and never inserts line feeds (Section 3.1). The decoder
//! rejects every byte outside the alphabet (Section 3.3), a wrong padding, and
//! pad bits that are not zero (Section 3.5), so an encoding has exactly one
//! accepted spelling; the WebSocket accept value and JWT segments, which this crate
//! serves, need nothing looser.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use zero_core::Error;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Which 64-character alphabet is in use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alphabet {
    /// Table 1 of RFC 4648: `A-Z`, `a-z`, `0-9`, `+`, `/`.
    Standard,
    /// Table 2 of RFC 4648: `A-Z`, `a-z`, `0-9`, `-`, `_`.
    UrlSafe,
}

impl Alphabet {
    const fn table(self) -> &'static [u8; 64] {
        match self {
            Self::Standard => b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
            Self::UrlSafe => b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
        }
    }

    /// The value of an alphabet character, or `None` for any other byte.
    const fn value(self, byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte.wrapping_sub(b'A')),
            b'a'..=b'z' => Some(byte.wrapping_sub(b'a').wrapping_add(26)),
            b'0'..=b'9' => Some(byte.wrapping_sub(b'0').wrapping_add(52)),
            b'+' if matches!(self, Self::Standard) => Some(62),
            b'/' if matches!(self, Self::Standard) => Some(63),
            b'-' if matches!(self, Self::UrlSafe) => Some(62),
            b'_' if matches!(self, Self::UrlSafe) => Some(63),
            _ => None,
        }
    }
}

/// The pad character.
pub const PAD: u8 = b'=';

/// Why an encoding was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// A byte outside the alphabet, at this offset (RFC 4648 Section 3.3).
    InvalidByte {
        /// The offset of the byte.
        offset: usize,
        /// The byte.
        byte: u8,
    },
    /// The encoded length does not end a quantum: one character left over, or a
    /// padded input whose length is not a multiple of four.
    InvalidLength,
    /// Padding present where none was expected, missing, or not at the end.
    InvalidPadding,
    /// The bits the final character carries past the data are not zero
    /// (Section 3.5), so the input is not the canonical encoding of any data.
    NonZeroPadBits,
    /// The output buffer is too small.
    Full,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidByte { offset, byte } => {
                write!(
                    f,
                    "byte {byte:#04x} at offset {offset} is outside the alphabet"
                )
            }
            Self::InvalidLength => f.write_str("the encoded length does not end a quantum"),
            Self::InvalidPadding => f.write_str("the padding is wrong"),
            Self::NonZeroPadBits => f.write_str("the pad bits are not zero"),
            Self::Full => f.write_str("the output buffer is full"),
        }
    }
}

impl From<DecodeError> for Error {
    fn from(error: DecodeError) -> Self {
        match error {
            DecodeError::Full => Error::Limit(alloc::format!("base64: {error}")),
            _ => Error::Codec(alloc::format!("base64: {error}")),
        }
    }
}

/// The length of the encoding of `len` bytes.
///
/// # Arguments
///
/// * `len` - the input length.
/// * `pad` - whether the final quantum is padded to four characters.
///
/// # Returns
///
/// The encoded length, or `None` when it does not fit a `usize`.
#[must_use]
pub const fn encoded_len(len: usize, pad: bool) -> Option<usize> {
    let whole = len / 3;
    let rest = len % 3;
    let Some(full) = whole.checked_mul(4) else {
        return None;
    };
    let tail = match (rest, pad) {
        (0, _) => 0,
        (_, true) => 4,
        (1, false) => 2,
        (_, false) => 3,
    };
    full.checked_add(tail)
}

/// The most bytes the decoding of `len` characters can hold.
///
/// # Arguments
///
/// * `len` - the encoded length, padding included or not.
#[must_use]
pub const fn decoded_len(len: usize) -> usize {
    let whole = len / 4;
    let rest = len % 4;
    let tail = match rest {
        0 => 0,
        2 => 1,
        _ => 2,
    };
    whole.saturating_mul(3).saturating_add(tail)
}

/// Encode into a caller's buffer.
///
/// # Arguments
///
/// * `input` - the bytes.
/// * `alphabet` - which alphabet.
/// * `pad` - whether to pad the final quantum (RFC 4648 Section 3.2 requires it
///   unless the referring specification says otherwise).
/// * `out` - the buffer, at least [`encoded_len`] long.
///
/// # Returns
///
/// How many bytes of `out` were written.
///
/// # Errors
///
/// [`DecodeError::Full`] when `out` is too small; nothing is written then.
pub fn encode_slice(
    input: &[u8],
    alphabet: Alphabet,
    pad: bool,
    out: &mut [u8],
) -> Result<usize, DecodeError> {
    let needed = encoded_len(input.len(), pad).ok_or(DecodeError::Full)?;
    let out = out.get_mut(..needed).ok_or(DecodeError::Full)?;
    let table = alphabet.table();
    let (chunks, rest) = input.as_chunks::<3>();
    let mut written = out.iter_mut();
    let mut put = |value: u8| {
        if let Some(slot) = written.next() {
            *slot = table.get(usize::from(value & 0x3F)).copied().unwrap_or(PAD);
        }
    };
    for &[a, b, c] in chunks {
        put(a.wrapping_shr(2));
        put((a & 0x03).wrapping_shl(4) | b.wrapping_shr(4));
        put((b & 0x0F).wrapping_shl(2) | c.wrapping_shr(6));
        put(c & 0x3F);
    }
    match (rest.first(), rest.get(1)) {
        (Some(&a), None) => {
            put(a.wrapping_shr(2));
            put((a & 0x03).wrapping_shl(4));
        }
        (Some(&a), Some(&b)) => {
            put(a.wrapping_shr(2));
            put((a & 0x03).wrapping_shl(4) | b.wrapping_shr(4));
            put((b & 0x0F).wrapping_shl(2));
        }
        _ => {}
    }
    if pad {
        for slot in written {
            *slot = PAD;
        }
    }
    Ok(needed)
}

/// Encode into a new string.
///
/// # Arguments
///
/// * `input` - the bytes.
/// * `alphabet` - which alphabet.
/// * `pad` - whether to pad the final quantum.
#[must_use]
pub fn encode(input: &[u8], alphabet: Alphabet, pad: bool) -> String {
    let needed = encoded_len(input.len(), pad).unwrap_or(0);
    let mut out = alloc::vec![0u8; needed];
    let written = encode_slice(input, alphabet, pad, &mut out).unwrap_or(0);
    out.truncate(written);
    // The table holds ASCII only, so the bytes are a string.
    String::from_utf8(out).unwrap_or_default()
}

/// Decode into a caller's buffer.
///
/// # Arguments
///
/// * `input` - the encoded bytes.
/// * `alphabet` - which alphabet.
/// * `padded` - whether the input carries padding: when `true`, the length must
///   be a multiple of four and the final quantum ends in the right number of `=`;
///   when `false`, no `=` is accepted.
/// * `out` - the buffer, at least [`decoded_len`] long.
///
/// # Returns
///
/// How many bytes of `out` were written.
///
/// # Errors
///
/// [`DecodeError`] for a byte outside the alphabet, a wrong length or padding,
/// pad bits that are not zero, or a full buffer; `out` may hold a prefix then.
pub fn decode_slice(
    input: &[u8],
    alphabet: Alphabet,
    padded: bool,
    out: &mut [u8],
) -> Result<usize, DecodeError> {
    let (data, pads) = split_padding(input, padded)?;
    let mut written = 0usize;
    let mut put = |byte: u8, written: &mut usize| -> Result<(), DecodeError> {
        let slot = out.get_mut(*written).ok_or(DecodeError::Full)?;
        *slot = byte;
        *written = written.saturating_add(1);
        Ok(())
    };
    let (chunks, rest) = data.as_chunks::<4>();
    for (index, chunk) in chunks.iter().enumerate() {
        let base = index.saturating_mul(4);
        let v = values(chunk, base, alphabet)?;
        put(v[0].wrapping_shl(2) | v[1].wrapping_shr(4), &mut written)?;
        put(v[1].wrapping_shl(4) | v[2].wrapping_shr(2), &mut written)?;
        put(v[2].wrapping_shl(6) | v[3], &mut written)?;
    }
    let base = data.len().saturating_sub(rest.len());
    match rest.len() {
        0 => {
            if pads != 0 {
                return Err(DecodeError::InvalidPadding);
            }
        }
        2 => {
            if padded && pads != 2 {
                return Err(DecodeError::InvalidPadding);
            }
            let v = values(rest, base, alphabet)?;
            if v[1] & 0x0F != 0 {
                return Err(DecodeError::NonZeroPadBits);
            }
            put(v[0].wrapping_shl(2) | v[1].wrapping_shr(4), &mut written)?;
        }
        3 => {
            if padded && pads != 1 {
                return Err(DecodeError::InvalidPadding);
            }
            let v = values(rest, base, alphabet)?;
            if v[2] & 0x03 != 0 {
                return Err(DecodeError::NonZeroPadBits);
            }
            put(v[0].wrapping_shl(2) | v[1].wrapping_shr(4), &mut written)?;
            put(v[1].wrapping_shl(4) | v[2].wrapping_shr(2), &mut written)?;
        }
        _ => return Err(DecodeError::InvalidLength),
    }
    Ok(written)
}

/// Decode into a new vector.
///
/// # Arguments
///
/// * `input` - the encoded bytes.
/// * `alphabet` - which alphabet.
/// * `padded` - whether the input carries padding.
///
/// # Errors
///
/// [`DecodeError`] as for [`decode_slice`].
pub fn decode(input: &[u8], alphabet: Alphabet, padded: bool) -> Result<Vec<u8>, DecodeError> {
    let mut out = alloc::vec![0u8; decoded_len(input.len())];
    let written = decode_slice(input, alphabet, padded, &mut out)?;
    out.truncate(written);
    Ok(out)
}

/// Split the trailing `=` characters off: at most two, only at the end, and only
/// when padding is expected.
fn split_padding(input: &[u8], padded: bool) -> Result<(&[u8], usize), DecodeError> {
    let pads = input.iter().rev().take_while(|&&byte| byte == PAD).count();
    if !padded {
        if pads != 0 {
            return Err(DecodeError::InvalidPadding);
        }
        return Ok((input, 0));
    }
    if !input.len().is_multiple_of(4) {
        return Err(DecodeError::InvalidLength);
    }
    if pads > 2 {
        return Err(DecodeError::InvalidPadding);
    }
    let data = input.get(..input.len().saturating_sub(pads)).unwrap_or(&[]);
    Ok((data, pads))
}

/// The values of up to four alphabet characters, the missing ones zero.
fn values(chunk: &[u8], base: usize, alphabet: Alphabet) -> Result<[u8; 4], DecodeError> {
    let mut out = [0u8; 4];
    for (index, (slot, &byte)) in out.iter_mut().zip(chunk).enumerate() {
        *slot = alphabet.value(byte).ok_or(DecodeError::InvalidByte {
            offset: base.saturating_add(index),
            byte,
        })?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use alloc::string::String;
    use alloc::vec::Vec;

    use super::{
        decode, decode_slice, decoded_len, encode, encode_slice, encoded_len, Alphabet, DecodeError,
    };

    /// RFC 4648 Section 10.
    const VECTORS: [(&str, &str); 7] = [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ];

    #[test]
    fn the_rfc_4648_test_vectors_encode_and_decode() {
        for (plain, encoded) in VECTORS {
            assert_eq!(encode(plain.as_bytes(), Alphabet::Standard, true), encoded);
            assert_eq!(
                decode(encoded.as_bytes(), Alphabet::Standard, true),
                Ok(plain.as_bytes().to_vec())
            );
            let unpadded: String = encoded.trim_end_matches('=').into();
            assert_eq!(
                encode(plain.as_bytes(), Alphabet::Standard, false),
                unpadded
            );
            assert_eq!(
                decode(unpadded.as_bytes(), Alphabet::Standard, false),
                Ok(plain.as_bytes().to_vec())
            );
            assert_eq!(encoded_len(plain.len(), true), Some(encoded.len()));
            assert_eq!(encoded_len(plain.len(), false), Some(unpadded.len()));
            assert!(decoded_len(encoded.len()) >= plain.len());
        }
    }

    #[test]
    fn the_url_safe_alphabet_differs_only_in_the_last_two_characters() {
        let bytes = [0xFBu8, 0xFF, 0xBF, 0xFE];
        assert_eq!(encode(&bytes, Alphabet::Standard, true), "+/+//g==");
        assert_eq!(encode(&bytes, Alphabet::UrlSafe, true), "-_-__g==");
        assert_eq!(encode(&bytes, Alphabet::UrlSafe, false), "-_-__g");
        assert_eq!(
            decode(b"-_-__g", Alphabet::UrlSafe, false),
            Ok(bytes.to_vec())
        );
        assert_eq!(
            decode(b"-_-__g", Alphabet::Standard, false),
            Err(DecodeError::InvalidByte {
                offset: 0,
                byte: b'-'
            })
        );
    }

    #[test]
    fn bytes_outside_the_alphabet_wrong_padding_and_stray_pad_bits_are_rejected() {
        assert_eq!(
            decode(b"Zm9v\nYg=", Alphabet::Standard, true),
            Err(DecodeError::InvalidByte {
                offset: 4,
                byte: b'\n'
            }),
            "a line feed is not alphabet (Section 3.1 and 3.3)"
        );
        assert_eq!(
            decode(b"Zm9v\nYg==", Alphabet::Standard, true),
            Err(DecodeError::InvalidLength)
        );
        assert_eq!(
            decode(b"Zg", Alphabet::Standard, true),
            Err(DecodeError::InvalidLength)
        );
        assert_eq!(
            decode(b"Zg=", Alphabet::Standard, true),
            Err(DecodeError::InvalidLength)
        );
        assert_eq!(
            decode(b"Zg==", Alphabet::Standard, false),
            Err(DecodeError::InvalidPadding)
        );
        assert_eq!(
            decode(b"Zm8=", Alphabet::Standard, true),
            Ok(b"fo".to_vec())
        );
        assert_eq!(
            decode(b"Zm9=", Alphabet::Standard, true),
            Err(DecodeError::NonZeroPadBits),
            "'9' carries two bits past the two data bytes"
        );
        assert_eq!(
            decode(b"Z===", Alphabet::Standard, true),
            Err(DecodeError::InvalidPadding)
        );
        assert_eq!(
            decode(b"Zh==", Alphabet::Standard, true),
            Err(DecodeError::NonZeroPadBits),
            "'h' carries bits past the one data byte (Section 3.5)"
        );
        assert_eq!(
            decode(b"Zm9w", Alphabet::Standard, true),
            Ok(b"fop".to_vec())
        );
        assert_eq!(
            decode(b"Zg==Zg==", Alphabet::Standard, true),
            Err(DecodeError::InvalidByte {
                offset: 2,
                byte: b'='
            }),
            "padding only at the end"
        );
        assert_eq!(
            decode(b"Z", Alphabet::Standard, false),
            Err(DecodeError::InvalidLength)
        );
    }

    #[test]
    fn the_slice_forms_report_a_full_buffer_and_round_trip_every_length() {
        let mut small = [0u8; 3];
        assert_eq!(
            encode_slice(b"foo", Alphabet::Standard, true, &mut small),
            Err(DecodeError::Full)
        );
        let mut buffer = [0u8; 64];
        let mut back = [0u8; 48];
        for len in 0..=40usize {
            let input: Vec<u8> = (0..len)
                .map(|i| u8::try_from(i.wrapping_mul(37) & 0xFF).unwrap_or(0))
                .collect();
            let written = encode_slice(&input, Alphabet::Standard, true, &mut buffer);
            assert_eq!(written, encoded_len(len, true).ok_or(DecodeError::Full));
            let encoded = buffer.get(..written.unwrap_or(0)).unwrap_or(&[]);
            let decoded = decode_slice(encoded, Alphabet::Standard, true, &mut back);
            assert_eq!(decoded, Ok(len));
            assert_eq!(back.get(..len), Some(input.as_slice()));
        }
        let mut two = [0u8; 2];
        assert_eq!(
            decode_slice(b"Zm9v", Alphabet::Standard, true, &mut two),
            Err(DecodeError::Full)
        );
    }
}
