//! The QPACK encoder and decoder stream parsers on arbitrary bytes, the first
//! octet choosing the stream: they never panic, whole and one-octet feeding
//! give the same instructions and verdict, a decoder at capacity zero decides
//! by the octet that completes an instruction head and never waits with a
//! whole head present, and every parsed instruction encodes to octets that
//! parse back to it.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_limits::transport::QPACK_INTEGER_CAP;
use zero_qpack::integer::MAX_LEN;
use zero_qpack::{
    DecoderInstruction, DecoderStreamReceiver, EncoderHead, EncoderInstruction,
    EncoderStreamReceiver, Error,
};

/// The encoder instructions at the start of `input`, each re-encoded, and the
/// fault that stopped the parse.
fn encoder_whole(input: &[u8]) -> (Vec<Vec<u8>>, Option<Error>) {
    let mut rest = input;
    let mut list = Vec::new();
    loop {
        match EncoderInstruction::parse(rest, QPACK_INTEGER_CAP) {
            Ok(Some((instruction, used))) => {
                assert!(used > 0 && used <= rest.len());
                let mut out = Vec::new();
                instruction.encode(&mut out).unwrap();
                assert_eq!(
                    EncoderInstruction::parse(&out, QPACK_INTEGER_CAP),
                    Ok(Some((instruction, out.len())))
                );
                list.push(out);
                rest = &rest[used..];
            }
            Ok(None) => return (list, None),
            Err(error) => return (list, Some(error)),
        }
    }
}

/// The same parse with `input` arriving one octet at a time.
fn encoder_bytewise(input: &[u8]) -> (Vec<Vec<u8>>, Option<Error>) {
    let mut pending = Vec::new();
    let mut list = Vec::new();
    for &octet in input {
        pending.push(octet);
        loop {
            match EncoderInstruction::parse(&pending, QPACK_INTEGER_CAP) {
                Ok(Some((instruction, used))) => {
                    let mut out = Vec::new();
                    instruction.encode(&mut out).unwrap();
                    list.push(out);
                    pending.drain(..used);
                }
                Ok(None) => break,
                Err(error) => return (list, Some(error)),
            }
        }
    }
    (list, None)
}

fn encoder_stream(input: &[u8]) {
    assert_eq!(encoder_whole(input), encoder_bytewise(input));
    let verdict = EncoderStreamReceiver::new(QPACK_INTEGER_CAP).feed(input);
    assert!(
        !matches!(verdict, Ok(consumed) if consumed > 0),
        "capacity zero accepts no encoder instruction"
    );
    if input.len() >= MAX_LEN {
        assert!(verdict.is_err(), "a whole head is always decided");
    }
    match EncoderHead::parse(input, QPACK_INTEGER_CAP) {
        Ok(Some((_, head_len))) => {
            for end in 0..head_len {
                let mut receiver = EncoderStreamReceiver::new(QPACK_INTEGER_CAP);
                assert_eq!(receiver.feed(&input[..end]), Ok(0));
            }
            let mut receiver = EncoderStreamReceiver::new(QPACK_INTEGER_CAP);
            assert_eq!(receiver.feed(&input[..head_len]), verdict);
            assert!(verdict.is_err());
        }
        Ok(None) => assert_eq!(verdict, Ok(0)),
        Err(error) => assert_eq!(verdict, Err(error)),
    }
}

/// The decoder instructions at the start of `input` and the fault that
/// stopped the parse, whole or one octet at a time.
fn decoder_instructions(input: &[u8], bytewise: bool) -> (Vec<DecoderInstruction>, Option<Error>) {
    let mut pending = Vec::new();
    let mut list = Vec::new();
    let chunks: Vec<&[u8]> = if bytewise {
        input.chunks(1).collect()
    } else {
        vec![input]
    };
    for chunk in chunks {
        pending.extend_from_slice(chunk);
        loop {
            match DecoderInstruction::parse(&pending) {
                Ok(Some((instruction, used))) => {
                    assert!(used > 0 && used <= MAX_LEN);
                    let mut out = Vec::new();
                    instruction.encode(&mut out).unwrap();
                    assert_eq!(
                        DecoderInstruction::parse(&out),
                        Ok(Some((instruction, out.len())))
                    );
                    list.push(instruction);
                    pending.drain(..used);
                }
                Ok(None) => {
                    assert!(pending.len() < MAX_LEN);
                    break;
                }
                Err(error) => return (list, Some(error)),
            }
        }
    }
    (list, None)
}

/// The verdict of an encoder that never references the dynamic table and the
/// octets left waiting, whole or one octet at a time.
fn decoder_verdict(input: &[u8], bytewise: bool) -> (Result<(), Error>, usize) {
    let mut receiver = DecoderStreamReceiver;
    let mut pending = Vec::new();
    let chunks: Vec<&[u8]> = if bytewise {
        input.chunks(1).collect()
    } else {
        vec![input]
    };
    for chunk in chunks {
        pending.extend_from_slice(chunk);
        match receiver.feed(&pending) {
            Ok(consumed) => {
                pending.drain(..consumed);
            }
            Err(error) => return (Err(error), pending.len()),
        }
    }
    (Ok(()), pending.len())
}

fn decoder_stream(input: &[u8]) {
    assert_eq!(
        decoder_instructions(input, false),
        decoder_instructions(input, true)
    );
    let (verdict, waiting) = decoder_verdict(input, false);
    let (bytewise, bytewise_waiting) = decoder_verdict(input, true);
    assert_eq!(verdict, bytewise);
    if verdict.is_ok() {
        assert_eq!(waiting, bytewise_waiting);
        assert!(waiting < MAX_LEN);
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&selector, input)) = data.split_first() else {
        return;
    };
    if selector % 2 == 0 {
        encoder_stream(input);
    } else {
        decoder_stream(input);
    }
});
