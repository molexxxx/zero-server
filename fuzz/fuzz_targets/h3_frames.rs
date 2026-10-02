//! The HTTP/3 frame decoder on arbitrary bytes, the first octet choosing the
//! stream and the local role: it never panics, every streamed payload follows
//! its step sequence, whole and one-octet feeding produce the same frames and
//! verdict, and the end-of-stream check agrees between them.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_h3::{
    Error, Frame, FrameDecoder, FrameHeader, FrameLimits, Role, Settings, Step, StreamKind,
};

/// Small payload limits, so the oversized and excessive-load paths are
/// reached by short inputs.
const LIMITS: FrameLimits = FrameLimits {
    field_section: 64,
    settings: 64,
};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Event {
    Headers(Vec<u8>),
    CancelPush(u64),
    Settings(Settings),
    PushPromise(u64, Vec<u8>),
    Goaway(u64),
    MaxPushId(u64),
    Data(Vec<u8>),
    Skipped(u64, u64),
    Oversized(u64, u64),
}

struct Run {
    decoder: FrameDecoder,
    tunnel_after_headers: bool,
    pending: Vec<u8>,
    events: Vec<Event>,
    open: Option<(bool, u64)>,
}

impl Run {
    fn new(kind: StreamKind, role: Role, tunnel_after_headers: bool) -> Self {
        Self {
            decoder: FrameDecoder::new(kind, role, LIMITS),
            tunnel_after_headers,
            pending: Vec::new(),
            events: Vec::new(),
            open: None,
        }
    }

    fn piece(&mut self, data: &[u8], end: bool, is_data: bool) {
        let (open_data, remaining) = self.open.expect("a piece inside a streamed payload");
        assert_eq!(open_data, is_data);
        let len = u64::try_from(data.len()).unwrap();
        assert!(len <= remaining);
        let left = remaining - len;
        assert_eq!(end, left == 0, "end marks the last piece");
        self.open = (!end).then_some((open_data, left));
        if is_data {
            if let Some(Event::Data(buffer)) = self.events.last_mut() {
                buffer.extend_from_slice(data);
            }
        }
    }

    fn pump(&mut self) -> Result<(), Error> {
        loop {
            let input = std::mem::take(&mut self.pending);
            let header = FrameHeader::parse(&input);
            let step = self.decoder.decode(&input);
            let (consumed, more) = match step {
                Err(error) => {
                    self.pending = input;
                    return Err(error);
                }
                Ok(Step::NeedMore { consumed }) => (consumed, false),
                Ok(Step::Frame { frame, consumed }) => {
                    assert_eq!(self.open, None);
                    let event = match frame {
                        Frame::Headers { field_section } => {
                            if self.tunnel_after_headers {
                                self.decoder.tunnel();
                            }
                            Event::Headers(field_section.to_vec())
                        }
                        Frame::CancelPush { push_id } => Event::CancelPush(push_id),
                        Frame::Settings(settings) => Event::Settings(settings),
                        Frame::PushPromise {
                            push_id,
                            field_section,
                        } => Event::PushPromise(push_id, field_section.to_vec()),
                        Frame::Goaway { id } => Event::Goaway(id),
                        Frame::MaxPushId { push_id } => Event::MaxPushId(push_id),
                    };
                    self.events.push(event);
                    (consumed, true)
                }
                Ok(Step::Data {
                    data,
                    consumed,
                    end,
                }) => {
                    if self.open.is_none() {
                        assert!(data.is_empty() && !end && consumed > 0);
                        self.open = Some((true, header.unwrap().len));
                        self.events.push(Event::Data(Vec::new()));
                    } else {
                        self.piece(data, end, true);
                    }
                    (consumed, true)
                }
                Ok(Step::Skipped {
                    frame_type,
                    len,
                    consumed,
                }) => {
                    assert_eq!(self.open, None);
                    self.open = Some((false, len));
                    self.events.push(Event::Skipped(frame_type.0, len));
                    (consumed, true)
                }
                Ok(Step::Oversized {
                    frame_type,
                    len,
                    consumed,
                }) => {
                    assert_eq!(self.open, None);
                    self.open = Some((false, len));
                    self.events.push(Event::Oversized(frame_type.0, len));
                    (consumed, true)
                }
                Ok(Step::Discarded {
                    data,
                    consumed,
                    end,
                }) => {
                    self.piece(data, end, false);
                    (consumed, true)
                }
            };
            assert!(consumed <= input.len());
            self.pending = input[consumed..].to_vec();
            if !more {
                return Ok(());
            }
        }
    }

    /// The events, the error if any, and the end-of-stream verdict.
    fn finish(
        self,
        outcome: Result<(), Error>,
    ) -> (Vec<Event>, Result<(), Error>, Result<(), Error>) {
        let end = self.decoder.finish(&self.pending);
        (self.events, outcome, end)
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&selector, input)) = data.split_first() else {
        return;
    };
    let (kind, role, tunnel) = match selector % 6 {
        0 => (StreamKind::Control, Role::Server, false),
        1 => (StreamKind::Request, Role::Server, false),
        2 => (StreamKind::Control, Role::Client, false),
        3 => (StreamKind::Request, Role::Client, false),
        4 => (StreamKind::Push, Role::Client, false),
        _ => (StreamKind::Request, Role::Server, true),
    };

    let mut whole = Run::new(kind, role, tunnel);
    whole.pending.extend_from_slice(input);
    let outcome = whole.pump();
    let whole = whole.finish(outcome);

    let mut bytewise = Run::new(kind, role, tunnel);
    let mut outcome = Ok(());
    for &octet in input {
        bytewise.pending.push(octet);
        outcome = bytewise.pump();
        if outcome.is_err() {
            break;
        }
    }
    let bytewise = bytewise.finish(outcome);

    assert_eq!(whole.0, bytewise.0, "the same frames");
    assert_eq!(whole.1, bytewise.1, "the same verdict");
    if whole.1.is_ok() {
        assert_eq!(whole.2, bytewise.2, "the same end-of-stream verdict");
    }
});
