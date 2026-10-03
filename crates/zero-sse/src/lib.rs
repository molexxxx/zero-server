//! The server-sent events codec of zero-server.
//!
//! [`encode`](mod@encode) writes an event stream: events, comments, the response fields, and the
//! keep-alive schedule. [`decode`] reads one, for the bindings' fetch client.
//! [`last_event_id`] checks the `Last-Event-ID` a reconnecting client sends, and
//! [`STOP_RECONNECTING`] is the status that tells a client not to reconnect.
//!
//! @see <https://html.spec.whatwg.org/multipage/server-sent-events.html>

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod decode;
pub mod encode;

pub use decode::{Decoder, Message};
pub use encode::{
    comment, encode, Event, KeepAlive, CONTENT_TYPE, KEEP_ALIVE_COMMENT, KEEP_ALIVE_MS,
    RESPONSE_FIELDS,
};

use zero_http_types::StatusCode;

/// The version of this crate, as published to crates.io.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The status that tells a client to stop reconnecting: "a client can be told to
/// stop reconnecting using the HTTP 204 No Content response code" (WHATWG HTML,
/// Section 9.2.1), since any status other than 200 fails the connection for good
/// (Section 9.2.2).
pub const STOP_RECONNECTING: StatusCode = StatusCode::NO_CONTENT;

/// The id a reconnecting client resumes from.
///
/// The `Last-Event-ID` request header "reports an EventSource object's last event ID
/// string to the server when the user agent is to reestablish the connection"; its
/// value is "essentially any UTF-8 encoded string, that does not contain U+0000 NULL,
/// U+000A LF, or U+000D CR" (WHATWG HTML, Section 9.2.4). A client sends it only
/// when the string is not empty.
///
/// # Arguments
///
/// * `value` - the header value as received.
///
/// # Returns
///
/// The id, or `None` for an empty value, one that is not UTF-8, or one holding
/// U+0000, LF or CR.
///
/// @see <https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header>
#[must_use]
pub fn last_event_id(value: &[u8]) -> Option<&str> {
    if value.is_empty() || value.iter().any(|&byte| matches!(byte, 0 | b'\n' | b'\r')) {
        return None;
    }
    core::str::from_utf8(value).ok()
}

#[cfg(test)]
mod tests {
    use alloc::string::{String, ToString};
    use alloc::vec;
    use alloc::vec::Vec;

    use zero_http_types::StatusCode;

    use super::{
        comment, encode, last_event_id, Decoder, Event, KeepAlive, Message, CONTENT_TYPE,
        KEEP_ALIVE_COMMENT, KEEP_ALIVE_MS, RESPONSE_FIELDS, STOP_RECONNECTING,
    };

    fn written(event: &Event<'_>) -> String {
        let mut out = Vec::new();
        assert!(encode(event, &mut out).is_ok(), "{event:?}");
        String::from_utf8(out).unwrap_or_default()
    }

    fn decoded(stream: &[u8], piece: usize) -> (Vec<Message>, Decoder) {
        let mut decoder = Decoder::new(1 << 20);
        let mut out = Vec::new();
        for chunk in stream.chunks(piece.max(1)) {
            assert!(decoder.feed(chunk, &mut out).is_ok());
        }
        (out, decoder)
    }

    fn message(event: &str, data: &str, id: &str) -> Message {
        Message {
            event: event.to_string(),
            data: data.to_string(),
            id: id.to_string(),
        }
    }

    #[test]
    fn sse_responses_use_content_type_text_event_stream_and_utf_8() {
        assert_eq!(CONTENT_TYPE, b"text/event-stream; charset=utf-8");
        let expected: [(&[u8], &[u8]); 2] = [
            (b"Content-Type", b"text/event-stream; charset=utf-8"),
            (b"Cache-Control", b"no-store"),
        ];
        assert_eq!(RESPONSE_FIELDS, expected);
        let text = written(&Event {
            data: Some("κόσμε"),
            ..Event::default()
        });
        assert_eq!(
            text.as_bytes(),
            "data: κόσμε\n\n".as_bytes(),
            "written as UTF-8"
        );
        let (seen, _) = decoded(b"data: \xFFok\n\n", 64);
        assert_eq!(
            seen,
            [message("message", "\u{FFFD}ok", "")],
            "a client decodes bytes that are not UTF-8 to U+FFFD"
        );
    }

    #[test]
    fn multi_line_data_is_emitted_as_one_data_line_per_line_so_the_client_rejoins_it_with_lf() {
        let text = written(&Event {
            data: Some("YHOO\n+2\r\n10\rend"),
            ..Event::default()
        });
        assert_eq!(text, "data: YHOO\ndata: +2\ndata: 10\ndata: end\n\n");
        let (seen, _) = decoded(text.as_bytes(), 64);
        assert_eq!(seen, [message("message", "YHOO\n+2\n10\nend", "")]);
        for data in ["", "\n", "a\n", "\n\nb", "trailing\r\n"] {
            let text = written(&Event {
                data: Some(data),
                ..Event::default()
            });
            let (seen, _) = decoded(text.as_bytes(), 3);
            let rejoined = data.replace("\r\n", "\n").replace('\r', "\n");
            assert_eq!(seen, [message("message", &rejoined, "")], "{data:?}");
        }
    }

    #[test]
    fn cr_and_lf_are_stripped_or_rejected_in_event_and_id_values_since_any_of_cr_lf_or_crlf_ends_a_line(
    ) {
        let mut out = Vec::new();
        for event in [
            Event {
                event: Some("a\nb"),
                ..Event::default()
            },
            Event {
                event: Some("a\rb"),
                ..Event::default()
            },
            Event {
                id: Some("1\r\n"),
                ..Event::default()
            },
            Event {
                id: Some("1\n2"),
                ..Event::default()
            },
        ] {
            assert!(encode(&event, &mut out).is_err(), "{event:?}");
        }
        assert!(out.is_empty(), "nothing is written for a refused event");
        assert!(comment("a\nb", &mut out).is_err());
        assert!(out.is_empty());
    }

    #[test]
    fn an_id_value_containing_u_0000_is_never_emitted_because_clients_ignore_it() {
        let mut out = Vec::new();
        let event = Event {
            id: Some("a\0b"),
            data: Some("x"),
            ..Event::default()
        };
        assert!(encode(&event, &mut out).is_err());
        assert!(out.is_empty());
        let (seen, decoder) = decoded(b"id: 7\ndata: a\n\nid: x\0y\ndata: b\n\n", 64);
        assert_eq!(
            seen,
            [message("message", "a", "7"), message("message", "b", "7")]
        );
        assert_eq!(
            decoder.last_event_id(),
            "7",
            "the client ignores an id with U+0000"
        );
        let event = Event {
            event: Some("e\0"),
            data: Some("x"),
            ..Event::default()
        };
        assert!(
            encode(&event, &mut out).is_ok(),
            "U+0000 is allowed in an event type"
        );
    }

    #[test]
    fn retry_is_emitted_only_as_ascii_digits() {
        for (retry, digits) in [
            (0u64, "0"),
            (7, "7"),
            (3_000, "3000"),
            (u64::MAX, "18446744073709551615"),
        ] {
            let text = written(&Event {
                retry: Some(retry),
                ..Event::default()
            });
            assert_eq!(text, alloc::format!("retry: {digits}\n\n"));
            let (_, decoder) = decoded(text.as_bytes(), 64);
            assert_eq!(decoder.retry(), Some(retry));
        }
        let (_, decoder) = decoded(b"retry: 12a\n\nretry: -1\n\nretry:\n\n", 64);
        assert_eq!(
            decoder.retry(),
            None,
            "the client ignores anything but digits"
        );
    }

    #[test]
    fn every_event_ends_with_a_blank_line_which_is_what_dispatches_it() {
        let text = written(&Event {
            event: Some("update"),
            id: Some("42"),
            retry: Some(1_000),
            data: Some("payload"),
        });
        assert_eq!(
            text,
            "event: update\nid: 42\nretry: 1000\ndata: payload\n\n"
        );
        assert!(text.ends_with("\n\n"));
        let unterminated = text
            .as_bytes()
            .get(..text.len().saturating_sub(1))
            .unwrap_or(&[]);
        let (seen, _) = decoded(unterminated, 64);
        assert!(
            seen.is_empty(),
            "without the blank line nothing is dispatched"
        );
        let (seen, decoder) = decoded(text.as_bytes(), 1);
        assert_eq!(seen, [message("update", "payload", "42")]);
        assert_eq!(decoder.retry(), Some(1_000));
        let text = written(&Event {
            id: Some("9"),
            ..Event::default()
        });
        assert_eq!(text, "id: 9\n\n");
        let (seen, decoder) = decoded(text.as_bytes(), 64);
        assert!(seen.is_empty(), "no data line, no event");
        assert_eq!(decoder.last_event_id(), "9", "but the id is taken");
    }

    #[test]
    fn keep_alive_comments_beginning_with_are_sent_about_every_15_seconds() {
        assert_eq!(KEEP_ALIVE_MS, 15_000);
        assert_eq!(KEEP_ALIVE_COMMENT, b":\n");
        let mut schedule = KeepAlive::new(KEEP_ALIVE_MS, 1_000);
        assert!(!schedule.is_due(15_999));
        assert!(schedule.is_due(16_000));
        schedule.wrote(10_000);
        assert_eq!(
            schedule.deadline(),
            25_000,
            "an event pushes the comment back"
        );
        schedule.wrote(5_000);
        assert_eq!(schedule.deadline(), 25_000, "an older time changes nothing");
        let mut out = Vec::new();
        assert!(comment(" keep-alive", &mut out).is_ok());
        out.extend_from_slice(KEEP_ALIVE_COMMENT);
        out.extend_from_slice(b"data: x\n\n");
        assert_eq!(out.first(), Some(&b':'));
        let (seen, _) = decoded(&out, 64);
        assert_eq!(seen, [message("message", "x", "")], "comments are ignored");
    }

    #[test]
    fn the_last_event_id_request_header_is_exposed_to_handlers_for_resumption_after_reconnect() {
        assert_eq!(last_event_id(b"42"), Some("42"));
        assert_eq!(last_event_id("évènement-7".as_bytes()), Some("évènement-7"));
        for bad in [&b""[..], b"a\0b", b"a\nb", b"a\rb", b"\xFF"] {
            assert_eq!(last_event_id(bad), None, "{bad:?}");
        }
        let (_, decoder) = decoded(b"id: 1\ndata: first\n\ndata:second\nid\n\n", 64);
        assert_eq!(
            decoder.last_event_id(),
            "",
            "an empty id resets it, so no Last-Event-ID is sent"
        );
    }

    #[test]
    fn a_204_no_content_response_is_available_to_tell_the_client_to_stop_reconnecting() {
        assert_eq!(STOP_RECONNECTING, StatusCode::NO_CONTENT);
        assert_eq!(STOP_RECONNECTING.as_u16(), 204);
    }

    #[test]
    fn the_decoder_follows_the_specification_examples_and_line_ending_rules() {
        let (seen, _) = decoded(
            b": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n",
            64,
        );
        assert_eq!(
            seen,
            [
                message("message", "first event", "1"),
                message("message", "second event", ""),
                message("message", " third event", ""),
            ]
        );
        let (seen, _) = decoded(b"data\n\ndata\ndata\n\ndata:", 64);
        assert_eq!(
            seen,
            [message("message", "", ""), message("message", "\n", "")],
            "an unterminated block is discarded"
        );
        let (seen, _) = decoded(b"data:test\n\ndata: test\n\n", 64);
        assert_eq!(
            seen,
            [
                message("message", "test", ""),
                message("message", "test", "")
            ]
        );
        for piece in [1, 2, 5, 64] {
            let (seen, _) = decoded(b"\xEF\xBB\xBFdata: a\r\n\r\ndata: b\r\rdata: c\n\n", piece);
            assert_eq!(
                seen,
                [
                    message("message", "a", ""),
                    message("message", "b", ""),
                    message("message", "c", "")
                ],
                "pieces of {piece}"
            );
        }
        let (seen, _) = decoded(b"\xEF\xBB\xBF\xEF\xBB\xBFdata: x\n\n", 64);
        assert!(seen.is_empty(), "only one byte order mark is stripped");
        let (seen, _) = decoded(b"Data: x\n\n", 64);
        assert!(seen.is_empty(), "field names compare literally");
        let mut decoder = Decoder::new(8);
        let mut out = vec![];
        assert!(
            decoder.feed(b"data: 0123456789\n", &mut out).is_err(),
            "the limit holds"
        );
    }
}
