//! A server WebSocket session on arbitrary client bytes, fed whole, one octet
//! at a time and in pieces the first octet sizes: every feeding reports the same
//! messages, pings, pongs and Close, fails with the same code and queues the same
//! output. The output is unmasked final frames (RFC 6455 Section 5.1): a Pong
//! with identical application data for every Ping (Section 5.5.3), and at most one
//! Close, last, carrying the received status code or the code the connection
//! failed with (Sections 5.5.1 and 7.1.7). No message passes the size limit.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_limits::WebSocketLimits;
use zero_ws::close::CloseCode;
use zero_ws::frame::{Opcode, MAX_CONTROL_PAYLOAD};
use zero_ws::session::{Event, Session};

/// Small limits, so the size, fragment and control-frame refusals are reached
/// by short inputs.
const LIMITS: WebSocketLimits = WebSocketLimits {
    max_message: 1024,
    max_fragments: 8,
    max_control_frames_per_second: 8,
};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Seen {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close(CloseCode, String),
}

impl From<Event<'_>> for Seen {
    fn from(event: Event<'_>) -> Self {
        match event {
            Event::Text(text) => Seen::Text(text.to_owned()),
            Event::Binary(data) => Seen::Binary(data.to_vec()),
            Event::Ping(data) => Seen::Ping(data.to_vec()),
            Event::Pong(data) => Seen::Pong(data.to_vec()),
            Event::Close(close) => Seen::Close(close.code, close.reason.to_owned()),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Outcome {
    events: Vec<Seen>,
    failure: Option<CloseCode>,
    output: Vec<u8>,
    finished: bool,
    close_code: Option<CloseCode>,
}

fn run(input: &[u8], piece: usize) -> Outcome {
    let mut session = Session::new(LIMITS);
    let mut pending: Vec<u8> = Vec::new();
    let mut events = Vec::new();
    let mut failure = None;
    'feed: for chunk in input.chunks(piece.max(1)) {
        pending.extend_from_slice(chunk);
        loop {
            let step = session
                .feed(&mut pending, 0)
                .map(|step| (step.consumed, step.event.map(Seen::from)));
            match step {
                Ok((consumed, event)) => {
                    assert!(consumed <= pending.len());
                    pending.drain(..consumed);
                    let progressed = consumed > 0 || event.is_some();
                    events.extend(event);
                    if !progressed {
                        break;
                    }
                }
                Err(code) => {
                    failure = Some(code);
                    break 'feed;
                }
            }
        }
    }
    Outcome {
        events,
        failure,
        output: session.output().to_vec(),
        finished: session.is_finished(),
        close_code: session.close_code(),
    }
}

/// The frames a server wrote: each final and unmasked, as its opcode and
/// payload.
fn server_frames(mut output: &[u8]) -> Vec<(Opcode, Vec<u8>)> {
    let mut frames = Vec::new();
    while let [first, second, rest @ ..] = output {
        assert_eq!(first & 0xf0, 0x80, "final, no reserved bit");
        assert_eq!(second & 0x80, 0, "a server frame is never masked");
        let opcode = Opcode::from_bits(first & 0x0f).unwrap();
        let (len, rest) = match second & 0x7f {
            126 => (
                usize::from(u16::from_be_bytes([rest[0], rest[1]])),
                &rest[2..],
            ),
            127 => (
                usize::try_from(u64::from_be_bytes(rest[..8].try_into().unwrap())).unwrap(),
                &rest[8..],
            ),
            short => (usize::from(short), rest),
        };
        frames.push((opcode, rest[..len].to_vec()));
        output = &rest[len..];
    }
    assert!(output.is_empty());
    frames
}

fn check(outcome: &Outcome) {
    let frames = server_frames(&outcome.output);
    let pings: Vec<&Vec<u8>> = outcome
        .events
        .iter()
        .filter_map(|event| match event {
            Seen::Ping(data) => Some(data),
            _ => None,
        })
        .collect();
    let pongs: Vec<&Vec<u8>> = frames
        .iter()
        .filter(|(opcode, _)| *opcode == Opcode::Pong)
        .map(|(_, data)| data)
        .collect();
    assert_eq!(pings, pongs, "a Pong answers each Ping with its data");
    for event in &outcome.events {
        match event {
            Seen::Text(text) => assert!(text.len() as u64 <= LIMITS.max_message),
            Seen::Binary(data) => assert!(data.len() as u64 <= LIMITS.max_message),
            Seen::Ping(data) | Seen::Pong(data) => assert!(data.len() <= MAX_CONTROL_PAYLOAD),
            Seen::Close(code, _) => assert!(*code == CloseCode::NO_STATUS || code.is_valid()),
        }
    }
    let received = outcome
        .events
        .iter()
        .enumerate()
        .find_map(|(at, event)| match event {
            Seen::Close(code, _) => Some((at, *code)),
            _ => None,
        });
    if let Some((at, _)) = received {
        assert_eq!(
            at + 1,
            outcome.events.len(),
            "nothing is processed after a Close"
        );
    }
    let received = received.map(|(_, code)| code);
    let closes: Vec<&(Opcode, Vec<u8>)> = frames
        .iter()
        .filter(|(opcode, _)| *opcode == Opcode::Close)
        .collect();
    let answered = match (received, outcome.failure) {
        (Some(code), None) | (None, Some(code)) => Some(code),
        (None, None) => None,
        (Some(_), Some(_)) => panic!("a session that received a Close processes no more input"),
    };
    match answered {
        Some(code) => {
            assert_eq!(closes.len(), 1, "one Close");
            assert_eq!(
                frames.last().map(|(opcode, _)| *opcode),
                Some(Opcode::Close)
            );
            let body = &closes[0].1;
            if code == CloseCode::NO_STATUS {
                assert!(body.is_empty(), "1005 is never sent");
            } else {
                assert_eq!(body[..], code.0.to_be_bytes());
            }
        }
        None => assert!(closes.is_empty()),
    }
    assert_eq!(outcome.finished, answered.is_some());
    assert_eq!(outcome.close_code, received);
}

fuzz_target!(|data: &[u8]| {
    let Some((&piece, input)) = data.split_first() else {
        return;
    };
    let whole = run(input, input.len());
    check(&whole);
    let bytewise = run(input, 1);
    assert_eq!(whole, bytewise);
    let pieces = run(input, usize::from(piece));
    assert_eq!(whole, pieces);
});
