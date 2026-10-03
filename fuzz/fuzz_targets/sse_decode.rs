//! The event stream decoder on arbitrary bytes, fed whole, one octet at a time
//! and in pieces the first octet sizes: every feeding dispatches the same events
//! and ends with the same last event ID, reconnection time and verdict, whatever
//! the line endings and chunk boundaries (WHATWG HTML Section 9.2.6); every
//! dispatched event, written back with the encoder, decodes to itself; and a
//! `Last-Event-ID` value is accepted only without U+0000, LF and CR (Section
//! 9.2.4).

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_sse::{encode, last_event_id, Decoder, Event, Message};

/// A small line and data limit, so the refusal is reached by short inputs.
const MAX_EVENT: usize = 256;

#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    messages: Vec<Message>,
    last_event_id: String,
    retry: Option<u64>,
    error: Option<String>,
}

fn run(stream: &[u8], piece: usize) -> Outcome {
    let mut decoder = Decoder::new(MAX_EVENT);
    let mut messages = Vec::new();
    let mut error = None;
    for chunk in stream.chunks(piece.max(1)) {
        if let Err(refused) = decoder.feed(chunk, &mut messages) {
            error = Some(format!("{refused:?}"));
            break;
        }
    }
    Outcome {
        messages,
        last_event_id: decoder.last_event_id().to_owned(),
        retry: decoder.retry(),
        error,
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&piece, stream)) = data.split_first() else {
        return;
    };
    let whole = run(stream, stream.len());
    assert_eq!(whole, run(stream, 1));
    assert_eq!(whole, run(stream, usize::from(piece)));

    for message in &whole.messages {
        assert!(!message.event.is_empty());
        assert!(!message.event.contains(['\r', '\n']));
        assert!(!message.id.contains(['\0', '\r', '\n']));
        assert!(!message.data.contains('\r'));
        let mut written = Vec::new();
        let event = Event {
            event: Some(&message.event),
            id: Some(&message.id),
            retry: None,
            data: Some(&message.data),
        };
        encode(&event, &mut written).unwrap();
        let mut again = Vec::new();
        let mut decoder = Decoder::new(usize::MAX);
        decoder.feed(&written, &mut again).unwrap();
        assert_eq!(again.as_slice(), std::slice::from_ref(message));
        assert_eq!(decoder.last_event_id(), message.id);
    }

    if let Some(id) = last_event_id(stream) {
        assert_eq!(id.as_bytes(), stream);
        assert!(
            !stream.is_empty() && !stream.iter().any(|&byte| matches!(byte, 0 | b'\n' | b'\r'))
        );
    }
});
