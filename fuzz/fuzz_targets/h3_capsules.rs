//! The Capsule Protocol and HTTP/3 datagrams on arbitrary bytes: capsule
//! decoding never panics, every skipped value follows its step sequence,
//! whole and one-octet feeding produce the same capsules and end-of-stream
//! verdict, and an accepted datagram re-encodes to an equal datagram.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_h3::{CapsuleDecoder, CapsuleStep, Datagram, Error};

/// A small DATAGRAM limit, so the discard path is reached by short inputs.
const MAX_DATAGRAM: u64 = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Event {
    Datagram(Vec<u8>),
    Skipped(u64, u64),
}

struct Run {
    decoder: CapsuleDecoder,
    pending: Vec<u8>,
    events: Vec<Event>,
    open: Option<u64>,
}

impl Run {
    fn new() -> Self {
        Self {
            decoder: CapsuleDecoder::new(MAX_DATAGRAM),
            pending: Vec::new(),
            events: Vec::new(),
            open: None,
        }
    }

    fn pump(&mut self) {
        loop {
            let input = std::mem::take(&mut self.pending);
            let (consumed, more) = match self.decoder.decode(&input) {
                CapsuleStep::NeedMore { consumed } => (consumed, false),
                CapsuleStep::Datagram { payload, consumed } => {
                    assert_eq!(self.open, None);
                    assert!(u64::try_from(payload.len()).unwrap() <= MAX_DATAGRAM);
                    self.events.push(Event::Datagram(payload.to_vec()));
                    (consumed, true)
                }
                CapsuleStep::Skipped {
                    capsule_type,
                    len,
                    consumed,
                } => {
                    assert_eq!(self.open, None);
                    self.open = Some(len);
                    self.events.push(Event::Skipped(capsule_type, len));
                    (consumed, true)
                }
                CapsuleStep::Value {
                    data,
                    consumed,
                    end,
                } => {
                    let remaining = self.open.expect("a piece inside a skipped value");
                    let len = u64::try_from(data.len()).unwrap();
                    assert!(len <= remaining);
                    let left = remaining - len;
                    assert_eq!(end, left == 0, "end marks the last piece");
                    self.open = (!end).then_some(left);
                    (consumed, true)
                }
            };
            assert!(consumed <= input.len());
            self.pending = input[consumed..].to_vec();
            if !more {
                return;
            }
        }
    }

    fn finish(self) -> (Vec<Event>, Result<(), Error>) {
        let end = self.decoder.finish(&self.pending);
        (self.events, end)
    }
}

fuzz_target!(|data: &[u8]| {
    let mut whole = Run::new();
    whole.pending.extend_from_slice(data);
    whole.pump();
    let mut bytewise = Run::new();
    for &octet in data {
        bytewise.pending.push(octet);
        bytewise.pump();
    }
    assert_eq!(whole.finish(), bytewise.finish());

    if let Ok(datagram) = Datagram::parse(data) {
        let stream_id = datagram.stream_id().unwrap();
        let mut out = Vec::new();
        Datagram::encode(stream_id, datagram.payload, &mut out).unwrap();
        assert_eq!(Datagram::parse(&out), Ok(datagram));
    }
});
