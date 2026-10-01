//! The WebSocket codec of zero-server.
//!
//! [`handshake`] checks a client's opening handshake and builds the `101` response
//! fields with the accept value; [`frame`] decodes and encodes frame headers;
//! [`close`] holds the close status codes and Close bodies; [`session`] runs one
//! connection after the handshake without doing I/O: in-place unmask through
//! `zero-simd`, streaming UTF-8 validation across fragments, the closing handshake,
//! and the message, fragment and control-frame limits. No extension is negotiated,
//! so permessage-deflate is not part of this release.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod close;
pub mod frame;
pub mod handshake;
pub mod session;

pub use close::{Close, CloseCode};
pub use frame::{Header, Opcode};
pub use handshake::{accept, negotiate, Accepted, Config, Reason, Refusal, ResponseFields};
pub use session::{Event, Session, Step};

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use alloc::string::{String, ToString};
    use alloc::vec;
    use alloc::vec::Vec;

    use zero_http_types::{Method, StatusCode};
    use zero_limits::WebSocketLimits;

    use super::frame::{self, Opcode};
    use super::handshake::{accept, negotiate, Accepted, Config, Reason};
    use super::session::{Event, Session};
    use super::CloseCode;

    const KEY: &[u8] = b"dGhlIHNhbXBsZSBub25jZQ==";
    const MASK: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

    fn handshake_fields() -> Vec<(&'static [u8], &'static [u8])> {
        vec![
            (b"Host", b"server.example.com"),
            (b"Upgrade", b"websocket"),
            (b"Connection", b"Upgrade"),
            (b"Sec-WebSocket-Key", KEY),
            (b"Sec-WebSocket-Version", b"13"),
        ]
    }

    fn without(name: &[u8]) -> Vec<(&'static [u8], &'static [u8])> {
        handshake_fields()
            .into_iter()
            .filter(|(field, _)| !field.eq_ignore_ascii_case(name))
            .collect()
    }

    fn replaced(name: &[u8], value: &'static [u8]) -> Vec<(&'static [u8], &'static [u8])> {
        let mut fields = without(name);
        let name: &'static [u8] = match name {
            b"Upgrade" => b"Upgrade",
            b"Connection" => b"Connection",
            b"Sec-WebSocket-Key" => b"Sec-WebSocket-Key",
            b"Sec-WebSocket-Version" => b"Sec-WebSocket-Version",
            _ => b"Origin",
        };
        fields.push((name, value));
        fields
    }

    fn refused(fields: Vec<(&'static [u8], &'static [u8])>) -> Option<Reason> {
        negotiate(Some(Method::Get), true, fields, &Config::default())
            .err()
            .map(|refusal| refusal.reason)
    }

    /// A frame as a client sends it: the first byte as given, masked with [`MASK`],
    /// the length in its minimal form.
    fn client(first: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![first];
        let len = payload.len();
        match u8::try_from(len) {
            Ok(short) if short < 126 => out.push(0x80 | short),
            _ => match u16::try_from(len) {
                Ok(medium) => {
                    out.push(0x80 | 126);
                    out.extend_from_slice(&medium.to_be_bytes());
                }
                Err(_) => {
                    out.push(0x80 | 127);
                    out.extend_from_slice(&(len as u64).to_be_bytes());
                }
            },
        }
        out.extend_from_slice(&MASK);
        out.extend(payload.iter().zip(MASK.iter().cycle()).map(|(b, k)| b ^ k));
        out
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Seen {
        Text(String),
        Binary(Vec<u8>),
        Ping(Vec<u8>),
        Pong(Vec<u8>),
        Close(u16, String),
    }

    fn own(event: Event<'_>) -> Seen {
        match event {
            Event::Text(text) => Seen::Text(text.to_string()),
            Event::Binary(data) => Seen::Binary(data.to_vec()),
            Event::Ping(data) => Seen::Ping(data.to_vec()),
            Event::Pong(data) => Seen::Pong(data.to_vec()),
            Event::Close(close) => Seen::Close(close.code.0, close.reason.to_string()),
        }
    }

    /// Feed `bytes` in pieces of `piece` bytes, as reads would deliver them.
    fn drive_in_pieces(
        session: &mut Session,
        bytes: &[u8],
        piece: usize,
    ) -> (Vec<Seen>, Option<CloseCode>) {
        let mut pending: Vec<u8> = Vec::new();
        let mut seen = Vec::new();
        for chunk in bytes.chunks(piece.max(1)) {
            pending.extend_from_slice(chunk);
            loop {
                let (consumed, event) = match session.feed(&mut pending, 0) {
                    Ok(step) => (step.consumed, step.event.map(own)),
                    Err(code) => return (seen, Some(code)),
                };
                pending.drain(..consumed);
                match event {
                    Some(event) => seen.push(event),
                    None if consumed == 0 => break,
                    None => {}
                }
            }
        }
        (seen, None)
    }

    fn drive(session: &mut Session, bytes: &[u8]) -> (Vec<Seen>, Option<CloseCode>) {
        drive_in_pieces(session, bytes, bytes.len())
    }

    fn fresh() -> Session {
        Session::new(WebSocketLimits::DEFAULT)
    }

    /// The frames in server output: the first byte, whether MASK was set, and the
    /// payload.
    fn server_frames(mut bytes: &[u8]) -> Vec<(u8, bool, Vec<u8>)> {
        let mut frames = Vec::new();
        while let Some(&[first, second]) = bytes.first_chunk::<2>() {
            let rest = bytes.get(2..).unwrap_or(&[]);
            let (len, at): (usize, usize) = match second & 0x7F {
                126 => (
                    rest.first_chunk::<2>()
                        .map_or(0, |b| usize::from(u16::from_be_bytes(*b))),
                    4,
                ),
                127 => (
                    rest.first_chunk::<8>()
                        .map_or(0, |b| usize::try_from(u64::from_be_bytes(*b)).unwrap_or(0)),
                    10,
                ),
                short => (usize::from(short), 2),
            };
            let end = at.saturating_add(len);
            let payload = bytes.get(at..end).unwrap_or(&[]).to_vec();
            frames.push((first, second & 0x80 != 0, payload));
            bytes = bytes.get(end..).unwrap_or(&[]);
        }
        frames
    }

    fn close_frame(code: u16) -> (u8, bool, Vec<u8>) {
        (0x88, false, code.to_be_bytes().to_vec())
    }

    #[test]
    fn the_handshake_requires_get_over_http_1_1_or_later_host_upgrade_websocket_and_connection_upgrade(
    ) {
        let accepted = negotiate(
            Some(Method::Get),
            true,
            handshake_fields(),
            &Config::default(),
        );
        assert_eq!(
            accepted,
            Ok(Accepted {
                key: KEY,
                protocol: None
            })
        );
        let mixed: Vec<(&[u8], &[u8])> = vec![
            (b"host", b"h"),
            (b"UPGRADE", b"WebSocket"),
            (b"connection", b"keep-alive, UPGRADE"),
            (b"sec-websocket-key", KEY),
            (b"sec-websocket-version", b"13"),
        ];
        assert!(
            negotiate(Some(Method::Get), true, mixed, &Config::default()).is_ok(),
            "names and the two tokens compare ASCII case-insensitively"
        );
        let post = negotiate(
            Some(Method::Post),
            true,
            handshake_fields(),
            &Config::default(),
        );
        assert_eq!(
            post.map_err(|r| (r.reason, r.status)),
            Err((Reason::Method, StatusCode::BAD_REQUEST))
        );
        let old = negotiate(
            Some(Method::Get),
            false,
            handshake_fields(),
            &Config::default(),
        );
        assert_eq!(old.err().map(|r| r.reason), Some(Reason::HttpVersion));
        assert_eq!(refused(without(b"Host")), Some(Reason::Host));
        assert_eq!(refused(without(b"Upgrade")), Some(Reason::Upgrade));
        assert_eq!(refused(replaced(b"Upgrade", b"h2c")), Some(Reason::Upgrade));
        assert_eq!(refused(without(b"Connection")), Some(Reason::Connection));
        assert_eq!(
            refused(replaced(b"Connection", b"keep-alive")),
            Some(Reason::Connection)
        );
    }

    #[test]
    fn a_sec_websocket_key_that_does_not_base64_decode_to_exactly_16_bytes_yields_400() {
        for key in [
            &b""[..],
            b"dGhlIHNhbXBsZSBub25jZQ",
            b"dGhlIHNhbXBsZSBub25jZQ==dGhl",
            b"dGhlIHNhbXBsZSBub25jZT==",
            b"AAAAAAAAAAAAAAAAAAAAAAA=",
            b"dGhlIHNhbXBsZSBub25j!Q==",
        ] {
            let fields = replaced(b"Sec-WebSocket-Key", key);
            let refusal = negotiate(Some(Method::Get), true, fields, &Config::default()).err();
            assert_eq!(
                refusal.map(|r| (r.reason, r.status)),
                Some((Reason::Key, StatusCode::BAD_REQUEST)),
                "{key:?}"
            );
        }
        let mut twice = handshake_fields();
        twice.push((b"Sec-WebSocket-Key", KEY));
        assert_eq!(refused(twice), Some(Reason::Key), "a repeated key");
        assert_eq!(refused(without(b"Sec-WebSocket-Key")), Some(Reason::Key));
    }

    #[test]
    fn a_sec_websocket_version_other_than_13_yields_426_upgrade_required_with_sec_websocket_version_13(
    ) {
        for version in [&b"8"[..], b"12", b"14", b"13, 8"] {
            let fields = replaced(b"Sec-WebSocket-Version", version);
            let refusal = negotiate(Some(Method::Get), true, fields, &Config::default()).err();
            assert_eq!(
                refusal.map(|r| (r.reason, r.status, r.fields)),
                Some((
                    Reason::Version,
                    StatusCode::UPGRADE_REQUIRED,
                    &[(&b"Sec-WebSocket-Version"[..], &b"13"[..])][..]
                )),
                "{version:?}"
            );
        }
        assert_eq!(
            refused(without(b"Sec-WebSocket-Version")),
            Some(Reason::MissingVersion)
        );
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn sec_websocket_accept_for_key_dghlihnhbxbszsbub25jzq_is_s3pplmbitxaq9kygzzhzrbk_xoo() {
        let sha1 = zero_server_crypto::Sha1;
        assert_eq!(
            accept(KEY, &sha1).ok(),
            Some(*b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        );
        let accepted = Accepted {
            key: KEY,
            protocol: Some(b"chat"),
        };
        let Ok(fields) = accepted.response_fields(&sha1) else {
            unreachable!("the response fields build");
        };
        let fields: Vec<(&[u8], &[u8])> = fields.iter().collect();
        let expected: [(&[u8], &[u8]); 4] = [
            (b"Upgrade", b"websocket"),
            (b"Connection", b"Upgrade"),
            (b"Sec-WebSocket-Accept", b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
            (b"Sec-WebSocket-Protocol", b"chat"),
        ];
        assert_eq!(fields, expected);
        assert!(accept(b"short", &sha1).is_err());
    }

    #[test]
    fn the_selected_sec_websocket_protocol_is_always_one_the_client_offered_and_none_is_sent_when_no_offer_matches(
    ) {
        let config = Config {
            protocols: &[b"superchat", b"chat"],
            origins: None,
        };
        let mut fields = handshake_fields();
        fields.push((b"Sec-WebSocket-Protocol", b"v2.chat, chat"));
        fields.push((b"Sec-WebSocket-Protocol", b"superchat"));
        let chosen = negotiate(Some(Method::Get), true, fields, &config).map(|a| a.protocol);
        assert_eq!(
            chosen,
            Ok(Some(&b"chat"[..])),
            "the client's first offer the server speaks"
        );
        let mut fields = handshake_fields();
        fields.push((b"Sec-WebSocket-Protocol", b"mqtt, , soap"));
        let chosen = negotiate(Some(Method::Get), true, fields, &config).map(|a| a.protocol);
        assert_eq!(chosen, Ok(None), "no offer matches, so none is sent");
        let chosen =
            negotiate(Some(Method::Get), true, handshake_fields(), &config).map(|a| a.protocol);
        assert_eq!(chosen, Ok(None), "no offer at all");
    }

    #[test]
    fn when_an_origin_allowlist_is_configured_a_disallowed_origin_is_refused_with_403_before_upgrading(
    ) {
        let config = Config {
            protocols: &[],
            origins: Some(&[b"https://app.example"]),
        };
        let decide = |fields| {
            negotiate(Some(Method::Get), true, fields, &config)
                .map(|_| ())
                .map_err(|r| (r.reason, r.status))
        };
        assert_eq!(decide(replaced(b"Origin", b"https://APP.example")), Ok(()));
        assert_eq!(
            decide(replaced(b"Origin", b"https://evil.example")),
            Err((Reason::Origin, StatusCode::FORBIDDEN))
        );
        assert_eq!(
            decide(replaced(b"Origin", b"null")),
            Err((Reason::Origin, StatusCode::FORBIDDEN))
        );
        assert_eq!(
            decide(handshake_fields()),
            Ok(()),
            "a client without Origin is not a browser"
        );
        let open = negotiate(
            Some(Method::Get),
            true,
            replaced(b"Origin", b"https://evil.example"),
            &Config::default(),
        );
        assert!(open.is_ok(), "no allow list accepts any origin");
    }

    #[test]
    fn an_unmasked_frame_from_the_client_makes_the_server_close_the_connection_with_1002() {
        let mut session = fresh();
        let (seen, failed) = drive(&mut session, b"\x81\x05Hello");
        assert_eq!((seen, failed), (vec![], Some(CloseCode::PROTOCOL_ERROR)));
        assert_eq!(server_frames(session.output()), [close_frame(1002)]);
        assert!(session.is_finished());
        let (seen, failed) = drive(&mut session, &client(0x81, b"Hello"));
        assert_eq!(
            (seen, failed),
            (vec![], None),
            "no input is processed after"
        );
    }

    #[test]
    fn frames_sent_by_the_server_are_never_masked() {
        let mut session = fresh();
        assert!(session.send_text("Hello").is_ok());
        assert!(session.send_binary(&[0u8; 300]).is_ok());
        assert!(session.ping(b"p").is_ok());
        let (_, failed) = drive(&mut session, &client(0x89, b"Hello"));
        assert_eq!(failed, None);
        assert!(session.close(CloseCode::NORMAL, "bye").is_ok());
        let frames = server_frames(session.output());
        assert_eq!(frames.len(), 5);
        assert!(frames.iter().all(|(_, masked, _)| !masked));
        assert_eq!(
            session.output().get(..7),
            Some(&b"\x81\x05Hello"[..]),
            "RFC 6455 Section 5.7's single-frame unmasked text message"
        );
    }

    #[test]
    fn any_nonzero_rsv_bit_not_claimed_by_a_negotiated_extension_fails_the_connection() {
        for first in [0xC1, 0xA1, 0x91] {
            let mut session = fresh();
            let (_, failed) = drive(&mut session, &client(first, b"x"));
            assert_eq!(failed, Some(CloseCode::PROTOCOL_ERROR), "{first:#x}");
        }
    }

    #[test]
    fn a_reserved_or_unknown_opcode_fails_the_connection() {
        for opcode in [0x3, 0x4, 0x5, 0x6, 0x7, 0xB, 0xC, 0xD, 0xE, 0xF] {
            let mut session = fresh();
            let (_, failed) = drive(&mut session, &client(0x80 | opcode, b""));
            assert_eq!(failed, Some(CloseCode::PROTOCOL_ERROR), "{opcode:#x}");
        }
    }

    #[test]
    fn payload_lengths_use_the_minimal_encoding_and_a_64_bit_length_with_the_most_significant_bit_set_is_rejected(
    ) {
        let mut padded = vec![0x82, 0x80 | 126, 0, 124];
        padded.extend_from_slice(&MASK);
        assert_eq!(
            frame::decode(&padded, 0),
            Err(CloseCode::PROTOCOL_ERROR),
            "124 bytes in the 16-bit form, the RFC's own example"
        );
        let mut wide = vec![0x82, 0x80 | 127];
        wide.extend_from_slice(&0xFFFFu64.to_be_bytes());
        wide.extend_from_slice(&MASK);
        assert_eq!(frame::decode(&wide, 0), Err(CloseCode::PROTOCOL_ERROR));
        let mut top = vec![0x82, 0x80 | 127];
        top.extend_from_slice(&(1u64 << 63).to_be_bytes());
        top.extend_from_slice(&MASK);
        assert_eq!(frame::decode(&top, 0), Err(CloseCode::PROTOCOL_ERROR));
        let mut minimal = vec![0x82, 0x80 | 126, 0, 126];
        minimal.extend_from_slice(&MASK);
        assert_eq!(
            frame::decode(&minimal, 0).map(|h| h.map(|h| h.len)),
            Ok(Some(126))
        );
        let mut out = [0u8; 10];
        assert_eq!(frame::encode(true, Opcode::Binary, 125, &mut out), 2);
        assert_eq!(frame::encode(true, Opcode::Binary, 126, &mut out), 4);
        assert_eq!(out.get(..4), Some(&[0x82, 126, 0, 126][..]));
        assert_eq!(frame::encode(true, Opcode::Binary, 0x1_0000, &mut out), 10);
        assert_eq!(
            out,
            [0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0],
            "Section 5.7's 64 KiB example"
        );
    }

    #[test]
    fn control_frames_with_payloads_over_125_bytes_or_without_fin_fail_the_connection() {
        let mut session = fresh();
        let (_, failed) = drive(&mut session, &client(0x89, &[0u8; 126]));
        assert_eq!(failed, Some(CloseCode::PROTOCOL_ERROR));
        for first in [0x09, 0x0A, 0x08] {
            let mut session = fresh();
            let (_, failed) = drive(&mut session, &client(first, b""));
            assert_eq!(failed, Some(CloseCode::PROTOCOL_ERROR), "{first:#x}");
        }
        let mut session = fresh();
        let (seen, failed) = drive(&mut session, &client(0x89, &[7u8; 125]));
        assert_eq!((seen, failed), (vec![Seen::Ping(vec![7u8; 125])], None));
    }

    #[test]
    fn a_continuation_frame_with_no_message_in_progress_or_a_new_data_frame_while_a_fragmented_message_is_open_fails_the_connection(
    ) {
        let mut session = fresh();
        let (_, failed) = drive(&mut session, &client(0x80, b"lo"));
        assert_eq!(
            failed,
            Some(CloseCode::PROTOCOL_ERROR),
            "a stray continuation"
        );

        let mut bytes = client(0x01, b"Hel");
        bytes.extend(client(0x82, b"bin"));
        let mut session = fresh();
        let (_, failed) = drive(&mut session, &bytes);
        assert_eq!(
            failed,
            Some(CloseCode::PROTOCOL_ERROR),
            "an interleaved message"
        );

        let mut bytes = client(0x01, b"Hel");
        bytes.extend(client(0x89, b"mid"));
        bytes.extend(client(0x00, b""));
        bytes.extend(client(0x80, b"lo"));
        let mut session = fresh();
        let (seen, failed) = drive(&mut session, &bytes);
        assert_eq!(
            (seen, failed),
            (
                vec![Seen::Ping(b"mid".to_vec()), Seen::Text("Hello".to_string())],
                None
            ),
            "a control frame between fragments is processed, and every fragment is kept"
        );
        assert_eq!(
            server_frames(session.output()),
            [(0x8A, false, b"mid".to_vec())]
        );
    }

    #[test]
    fn a_ping_is_answered_with_a_pong_carrying_identical_application_data_unless_a_close_was_already_received(
    ) {
        let mut session = fresh();
        let mut bytes = client(0x89, b"Hello");
        bytes.extend(client(0x8A, b"unsolicited"));
        let (seen, failed) = drive(&mut session, &bytes);
        assert_eq!(
            (seen, failed),
            (
                vec![
                    Seen::Ping(b"Hello".to_vec()),
                    Seen::Pong(b"unsolicited".to_vec())
                ],
                None
            )
        );
        assert_eq!(
            session.output(),
            b"\x8a\x05Hello",
            "one pong with the ping's data, nothing for the pong"
        );

        let mut session = fresh();
        let mut bytes = client(0x88, &1000u16.to_be_bytes());
        bytes.extend(client(0x89, b"late"));
        let (seen, _) = drive(&mut session, &bytes);
        assert_eq!(seen, [Seen::Close(1000, String::new())]);
        assert_eq!(server_frames(session.output()), [close_frame(1000)]);
    }

    #[test]
    fn a_received_close_is_echoed_once_and_the_codes_1005_1006_and_1015_are_never_placed_in_a_close_frame(
    ) {
        let mut session = fresh();
        let mut body = 1001u16.to_be_bytes().to_vec();
        body.extend_from_slice(b"shutting down");
        let mut bytes = client(0x88, &body);
        bytes.extend(client(0x88, &1000u16.to_be_bytes()));
        let (seen, failed) = drive(&mut session, &bytes);
        assert_eq!(
            (seen, failed),
            (vec![Seen::Close(1001, "shutting down".to_string())], None)
        );
        assert_eq!(
            server_frames(session.output()),
            [close_frame(1001)],
            "echoed once"
        );
        assert!(session.is_finished());
        assert_eq!(session.close_code(), Some(CloseCode(1001)));

        let mut session = fresh();
        let (seen, _) = drive(&mut session, &client(0x88, b""));
        assert_eq!(seen, [Seen::Close(1005, String::new())]);
        assert_eq!(
            server_frames(session.output()),
            [(0x88, false, vec![])],
            "an empty Close is answered with an empty Close, never 1005"
        );

        for code in [
            CloseCode::NO_STATUS,
            CloseCode::ABNORMAL,
            CloseCode::TLS_HANDSHAKE,
        ] {
            let mut session = fresh();
            assert!(session.close(code, "x").is_ok() == (code == CloseCode::NO_STATUS));
            assert!(server_frames(session.output())
                .iter()
                .all(|(_, _, payload)| payload.get(..2) != Some(&code.0.to_be_bytes()[..])));
        }

        let mut session = fresh();
        assert!(session.close(CloseCode::NORMAL, "done").is_ok());
        let (seen, _) = drive(&mut session, &client(0x88, &1000u16.to_be_bytes()));
        assert_eq!(seen, [Seen::Close(1000, String::new())]);
        assert_eq!(
            server_frames(session.output()).len(),
            1,
            "the server's own Close is not repeated"
        );
        assert!(session.is_finished());
    }

    #[test]
    fn a_close_frame_with_a_1_byte_payload_an_invalid_close_code_or_a_non_utf_8_reason_fails_the_connection_with_1002_or_1007(
    ) {
        let cases: [(Vec<u8>, CloseCode); 7] = [
            (vec![0x03], CloseCode::PROTOCOL_ERROR),
            (999u16.to_be_bytes().to_vec(), CloseCode::PROTOCOL_ERROR),
            (1004u16.to_be_bytes().to_vec(), CloseCode::PROTOCOL_ERROR),
            (1005u16.to_be_bytes().to_vec(), CloseCode::PROTOCOL_ERROR),
            (1016u16.to_be_bytes().to_vec(), CloseCode::PROTOCOL_ERROR),
            (5000u16.to_be_bytes().to_vec(), CloseCode::PROTOCOL_ERROR),
            (
                [0x03, 0xE8, 0xFF, 0xFE].to_vec(),
                CloseCode::INVALID_PAYLOAD,
            ),
        ];
        for (body, expected) in cases {
            let mut session = fresh();
            let (_, failed) = drive(&mut session, &client(0x88, &body));
            assert_eq!(failed, Some(expected), "{body:?}");
            assert_eq!(server_frames(session.output()), [close_frame(expected.0)]);
        }
        for code in [1000u16, 1003, 1007, 1011, 1014, 3000, 4999] {
            let mut session = fresh();
            let (seen, failed) = drive(&mut session, &client(0x88, &code.to_be_bytes()));
            assert_eq!(
                (seen, failed),
                (vec![Seen::Close(code, String::new())], None)
            );
        }
    }

    #[test]
    fn a_text_message_that_is_not_valid_utf_8_including_when_split_across_fragments_fails_with_1007(
    ) {
        let mut session = fresh();
        let (_, failed) = drive(&mut session, &client(0x81, &[0xCE, 0xBA, 0xFF]));
        assert_eq!(failed, Some(CloseCode::INVALID_PAYLOAD));

        let kosme = "κόσμε".as_bytes();
        let (head, tail) = kosme.split_at(1);
        let mut bytes = client(0x01, head);
        bytes.extend(client(0x80, tail));
        let mut session = fresh();
        let (seen, failed) = drive(&mut session, &bytes);
        assert_eq!(
            (seen, failed),
            (vec![Seen::Text("κόσμε".to_string())], None),
            "a code point split across fragments is kept"
        );

        let mut bytes = client(0x01, &[0xCE]);
        bytes.extend(client(0x80, &[0x41]));
        let mut session = fresh();
        let (_, failed) = drive(&mut session, &bytes);
        assert_eq!(failed, Some(CloseCode::INVALID_PAYLOAD));

        let mut bytes = client(0x01, b"ok");
        bytes.extend(client(0x80, &[0xE2, 0x82]));
        let mut session = fresh();
        let (_, failed) = drive(&mut session, &bytes);
        assert_eq!(
            failed,
            Some(CloseCode::INVALID_PAYLOAD),
            "the message ends mid-sequence"
        );

        let mut bytes = client(0x01, &[0xED]);
        bytes.extend(client(0x00, &[0xA0]));
        bytes.extend(client(0x80, &[0x80]));
        let mut session = fresh();
        let (seen, failed) = drive_in_pieces(&mut session, &bytes, 1);
        assert_eq!(
            (seen, failed),
            (vec![], Some(CloseCode::INVALID_PAYLOAD)),
            "a surrogate split three ways fails as soon as it is seen"
        );
    }

    #[test]
    fn a_message_over_the_configured_size_limit_closes_with_1009() {
        let limits = WebSocketLimits {
            max_message: 8,
            max_fragments: 4,
            ..WebSocketLimits::DEFAULT
        };
        let mut session = Session::new(limits);
        let (seen, failed) = drive(&mut session, &client(0x82, &[1u8; 8]));
        assert_eq!((seen, failed), (vec![Seen::Binary(vec![1u8; 8])], None));
        let (_, failed) = drive(&mut session, &client(0x82, &[1u8; 9]));
        assert_eq!(failed, Some(CloseCode::MESSAGE_TOO_BIG));
        assert_eq!(server_frames(session.output()), [close_frame(1009)]);

        let mut bytes = client(0x02, &[1u8; 5]);
        bytes.extend(client(0x80, &[1u8; 4]));
        let mut session = Session::new(limits);
        let (_, failed) = drive(&mut session, &bytes);
        assert_eq!(
            failed,
            Some(CloseCode::MESSAGE_TOO_BIG),
            "counted across fragments"
        );

        let mut huge = vec![0x82, 0x80 | 127];
        huge.extend_from_slice(&(1u64 << 60).to_be_bytes());
        huge.extend_from_slice(&MASK);
        let mut session = Session::new(limits);
        let (_, failed) = drive(&mut session, &huge);
        assert_eq!(
            failed,
            Some(CloseCode::MESSAGE_TOO_BIG),
            "refused from the header, before any payload"
        );

        let mut bytes = Vec::new();
        for _ in 0..4 {
            bytes.extend(client(0x00, b""));
        }
        let mut many = client(0x02, b"");
        many.extend(bytes);
        let mut session = Session::new(limits);
        let (_, failed) = drive(&mut session, &many);
        assert_eq!(
            failed,
            Some(CloseCode::MESSAGE_TOO_BIG),
            "too many fragments"
        );
    }

    #[test]
    fn while_draining_websocket_clients_receive_a_close_frame_with_1001_going_away() {
        let mut session = fresh();
        assert!(session.going_away().is_ok());
        assert_eq!(server_frames(session.output()), [close_frame(1001)]);
        assert!(!session.is_finished(), "the peer's Close is still awaited");
        let (seen, _) = drive(&mut session, &client(0x88, &1001u16.to_be_bytes()));
        assert_eq!(seen, [Seen::Close(1001, String::new())]);
        assert!(session.is_finished());
    }

    #[test]
    fn nothing_is_sent_after_a_close_and_input_is_ignored_once_the_connection_is_done() {
        let mut session = fresh();
        assert!(session.close(CloseCode::NORMAL, "").is_ok());
        assert!(session.send_text("late").is_err());
        assert!(session.send_binary(b"late").is_err());
        assert!(session.ping(b"late").is_err());
        assert!(session.close(CloseCode::NORMAL, "").is_err());
        assert_eq!(server_frames(session.output()).len(), 1);
        session.consume_output(2);
        assert!(session.output().len() == 2, "the written bytes are dropped");
    }

    #[test]
    fn frames_arriving_one_byte_at_a_time_are_reassembled_and_an_unfragmented_message_in_one_read_is_delivered_from_the_read_buffer(
    ) {
        let size = if cfg!(miri) { 300 } else { 70_000 };
        let payload: Vec<u8> = (0..=255u8).cycle().take(size).collect();
        let mut bytes = client(0x82, &payload);
        bytes.extend(client(0x81, b"Hello"));
        bytes.extend(client(0x89, b"p"));
        for piece in [1, 3, 4096] {
            let mut session = fresh();
            let (seen, failed) = drive_in_pieces(&mut session, &bytes, piece);
            assert_eq!(
                (seen, failed),
                (
                    vec![
                        Seen::Binary(payload.clone()),
                        Seen::Text("Hello".to_string()),
                        Seen::Ping(b"p".to_vec())
                    ],
                    None
                ),
                "pieces of {piece}"
            );
        }
        let mut whole = client(0x81, b"Hello");
        let start = whole.as_ptr() as usize;
        let mut session = fresh();
        let Ok(step) = session.feed(&mut whole, 0) else {
            unreachable!("a valid frame");
        };
        let Some(Event::Text(text)) = step.event else {
            unreachable!("a text message");
        };
        assert_eq!(text, "Hello");
        assert_eq!(
            text.as_ptr() as usize,
            start.wrapping_add(6),
            "a slice of the read buffer"
        );
    }

    #[test]
    fn a_frame_encoded_once_is_queued_as_is_and_refused_after_a_close() {
        let mut encoded = Vec::new();
        frame::write(Opcode::Text, b"Hello", &mut encoded);
        assert_eq!(encoded, b"\x81\x05Hello");
        let mut session = fresh();
        assert!(session.send_encoded(&encoded).is_ok());
        assert_eq!(session.output(), &encoded[..]);
        assert!(session.close(CloseCode::NORMAL, "").is_ok());
        assert!(session.send_encoded(&encoded).is_err());
        assert_eq!(server_frames(session.output()).len(), 2);
    }

    #[test]
    fn control_frames_past_the_per_second_budget_fail_with_1008() {
        let limits = WebSocketLimits {
            max_control_frames_per_second: 2,
            ..WebSocketLimits::DEFAULT
        };
        let mut session = Session::new(limits);
        let mut ping = client(0x89, b"");
        for now in [0, 10] {
            assert!(session.feed(&mut ping.clone(), now).is_ok());
        }
        assert!(
            session.feed(&mut ping.clone(), 1_000).is_ok(),
            "a new window"
        );
        assert!(session.feed(&mut ping.clone(), 1_001).is_ok());
        assert_eq!(
            session.feed(&mut ping, 1_002).map(|step| step.consumed),
            Err(CloseCode::POLICY_VIOLATION)
        );
    }
}
