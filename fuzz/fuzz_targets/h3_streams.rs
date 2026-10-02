//! The unidirectional stream and control stream rules on arbitrary bytes, read
//! as a sequence of variable-length integers that a client and a server each
//! receive as stream types, GOAWAY identifiers and MAX_PUSH_ID values and send
//! as GOAWAY identifiers: nothing panics, a refusal leaves the state as it
//! was, and an accepted value keeps every rule of RFC 9114 Sections 5.2, 6.2
//! and 7.2.7.

#![no_main]

use libfuzzer_sys::fuzz_target;
use zero_h3::{
    varint, Disposition, Error, Frame, GoawaySender, PeerControl, Role, StreamType, UniStreams,
};

/// One endpoint and what it has seen.
struct Peer {
    role: Role,
    streams: UniStreams,
    control: PeerControl,
    sender: GoawaySender,
    opened: [bool; 4],
    last_sent: Option<u64>,
}

impl Peer {
    fn new(role: Role) -> Self {
        Self {
            role,
            streams: UniStreams::new(role),
            control: PeerControl::new(role),
            sender: GoawaySender::new(role),
            opened: [false; 4],
            last_sent: None,
        }
    }

    fn open(&mut self, value: u64, stream_type: StreamType) {
        match (self.streams.open(stream_type), stream_type) {
            (
                Ok(disposition),
                StreamType::Control | StreamType::QpackEncoder | StreamType::QpackDecoder,
            ) => {
                let index = usize::try_from(value).unwrap();
                assert!(!self.opened[index], "a critical stream is accepted once");
                self.opened[index] = true;
                let expected = match stream_type {
                    StreamType::Control => Disposition::Control,
                    StreamType::QpackEncoder => Disposition::QpackEncoder,
                    _ => Disposition::QpackDecoder,
                };
                assert_eq!(disposition, expected);
            }
            (Ok(disposition), StreamType::Push) => {
                assert_eq!(self.role, Role::Client);
                assert_eq!(disposition, Disposition::Push);
            }
            (Ok(disposition), StreamType::Reserved(_) | StreamType::Unknown(_)) => {
                assert_eq!(disposition, Disposition::Discard);
            }
            (Err(Error::SecondCriticalStream { stream_type: seen }), _) => {
                assert_eq!(seen, value);
                assert!(self.opened[usize::try_from(value).unwrap()]);
            }
            (Err(Error::PushStreamFromClient), StreamType::Push) => {
                assert_eq!(self.role, Role::Server);
            }
            (Err(error), _) => panic!("unexpected {error:?} for stream type {value}"),
        }
        assert_eq!(
            self.streams.closed(stream_type).is_err(),
            stream_type.is_critical()
        );
    }

    fn receive(&mut self, value: u64) {
        let before = self.control.goaway();
        match self.control.receive(&Frame::Goaway { id: value }) {
            Ok(()) => {
                assert_eq!(self.control.goaway(), Some(value));
                assert!(before.is_none_or(|before| value <= before));
                if self.role == Role::Client {
                    assert_eq!(value & 0x03, 0, "a client-initiated bidirectional stream");
                }
            }
            Err(_) => assert_eq!(self.control.goaway(), before),
        }
        let before = self.control.max_push_id();
        match self.control.receive(&Frame::MaxPushId { push_id: value }) {
            Ok(()) => {
                assert_eq!(self.control.max_push_id(), Some(value));
                assert!(before.is_none_or(|before| value >= before));
            }
            Err(_) => assert_eq!(self.control.max_push_id(), before),
        }
    }

    fn send(&mut self, value: u64) {
        let Some(sent) = self.sender.send(value) else {
            return;
        };
        assert_eq!(sent, value);
        assert!(self.last_sent.is_none_or(|last| sent <= last));
        if self.role == Role::Server {
            assert_eq!(sent & 0x03, 0, "a client-initiated bidirectional stream");
        }
        self.last_sent = Some(sent);
    }
}

fuzz_target!(|data: &[u8]| {
    let mut peers = [Peer::new(Role::Client), Peer::new(Role::Server)];
    let mut rest = data;
    while !rest.is_empty() {
        let parsed = StreamType::parse(rest);
        let decoded = varint::decode(rest);
        assert_eq!(
            parsed.map(|(stream_type, used)| (stream_type.value(), used)),
            decoded
        );
        let Some(((stream_type, used), (value, _))) = parsed.zip(decoded) else {
            break;
        };
        assert_eq!(StreamType::from_value(value), stream_type);
        for peer in &mut peers {
            peer.open(value, stream_type);
            peer.receive(value);
            peer.send(value);
        }
        rest = &rest[used..];
    }
});
