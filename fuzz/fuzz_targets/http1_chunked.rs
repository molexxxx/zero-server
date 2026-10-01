//! The chunked decoder on arbitrary bytes, whole and one byte at a time: it
//! never panics, both feedings reach the same verdict and the same data, and
//! a trailer section parses or is refused without panicking.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_http1::{parse_trailers, ChunkedDecoder, Field, Span, Step};
use zero_limits::http1::Http1Limits;

fn decode_whole(body: &[u8], limits: &Http1Limits) -> Result<(Vec<u8>, Option<Span>), u16> {
    let mut decoder = ChunkedDecoder::new();
    let mut data = Vec::new();
    let mut pos = 0usize;
    loop {
        match decoder
            .decode(&body[pos..], limits)
            .map_err(|reject| reject.status.as_u16())?
        {
            Step::Data {
                data: chunk,
                consumed,
            } => {
                data.extend_from_slice(chunk);
                pos += consumed;
            }
            Step::NeedMore { consumed } => {
                pos += consumed;
                if consumed == 0 || pos >= body.len() {
                    return Ok((data, None));
                }
            }
            Step::Done { trailers, consumed } => {
                let trailers = Span::new(trailers.start + pos, trailers.end + pos);
                assert!(pos + consumed <= body.len());
                return Ok((data, Some(trailers)));
            }
        }
    }
}

fn decode_bytewise(body: &[u8], limits: &Http1Limits) -> Result<(Vec<u8>, bool), u16> {
    let mut decoder = ChunkedDecoder::new();
    let mut data = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    for byte in body {
        if decoder.is_done() {
            break;
        }
        pending.push(*byte);
        loop {
            match decoder
                .decode(&pending, limits)
                .map_err(|reject| reject.status.as_u16())?
            {
                Step::Data {
                    data: chunk,
                    consumed,
                } => {
                    data.extend_from_slice(chunk);
                    pending.drain(..consumed);
                }
                Step::NeedMore { consumed } => {
                    pending.drain(..consumed);
                    break;
                }
                Step::Done { consumed, .. } => {
                    pending.drain(..consumed);
                    break;
                }
            }
        }
    }
    Ok((data, decoder.is_done()))
}

fuzz_target!(|data: &[u8]| {
    let limits = Http1Limits::DEFAULT;
    let whole = decode_whole(data, &limits);
    let bytewise = decode_bytewise(data, &limits);
    match (&whole, &bytewise) {
        (Ok((data_a, trailers)), Ok((data_b, done))) => {
            assert_eq!(data_a, data_b);
            assert_eq!(trailers.is_some(), *done);
            if let Some(trailers) = trailers {
                let mut table = [Field::EMPTY; 8];
                let _ = parse_trailers(data, *trailers, &mut table, &limits);
            }
        }
        (Err(a), Err(b)) => assert_eq!(a, b),
        (Ok(_), Err(_)) | (Err(_), Ok(_)) => {
            // A refusal that depends on where the input ends is allowed only
            // when the whole feeding stopped short of the error.
            assert!(whole.as_ref().is_ok_and(|(_, trailers)| trailers.is_none()));
        }
    }
});
