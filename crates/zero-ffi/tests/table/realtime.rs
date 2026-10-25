//! WebSocket, server-sent events and rooms, on connections the fixture accepted and
//! opened; their sends queue in the outboxes until the responses go out.

use std::ptr;

use zero_ffi::*;

use super::library::held;
use super::{Cases, Entry, Kind, Live};

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_ws_send",
            cases: ws_send,
            placeholder: crate::placeholder_call!(unsafe zero_ws_send(a, b, c, d)),
        },
        Entry {
            name: "zero_ws_ping",
            cases: ws_ping,
            placeholder: crate::placeholder_call!(unsafe zero_ws_ping(a, b, c)),
        },
        Entry {
            name: "zero_ws_writable",
            cases: |live, cases| flag(live, cases, zero_ws_writable, live.ws_conn, live.sse_conn),
            placeholder: crate::placeholder_call!(unsafe zero_ws_writable(a, b)),
        },
        Entry {
            name: "zero_ws_buffered",
            cases: |live, cases| octets(live, cases, zero_ws_buffered, live.ws_conn, live.sse_conn),
            placeholder: crate::placeholder_call!(unsafe zero_ws_buffered(a, b)),
        },
        Entry {
            name: "zero_room_join",
            cases: |live, cases| room(live, cases, zero_room_join),
            placeholder: crate::placeholder_call!(unsafe zero_room_join(a, b, c)),
        },
        Entry {
            name: "zero_room_leave",
            cases: |live, cases| room(live, cases, zero_room_leave),
            placeholder: crate::placeholder_call!(unsafe zero_room_leave(a, b, c)),
        },
        Entry {
            name: "zero_room_broadcast",
            cases: room_broadcast,
            placeholder: crate::placeholder_call!(unsafe zero_room_broadcast(a, b, c, d, e, f, g, h)),
        },
        Entry {
            name: "zero_room_size",
            cases: room_size,
            placeholder: crate::placeholder_call!(unsafe zero_room_size(a, b, c, d)),
        },
        Entry {
            name: "zero_sse_send",
            cases: sse_send,
            placeholder: crate::placeholder_call!(unsafe zero_sse_send(a, b, c, d, e, f, g)),
        },
        Entry {
            name: "zero_sse_comment",
            cases: sse_comment,
            placeholder: crate::placeholder_call!(unsafe zero_sse_comment(a, b, c)),
        },
        Entry {
            name: "zero_sse_retry",
            cases: sse_retry,
            placeholder: crate::placeholder_call!(zero_sse_retry(a, b)),
        },
        Entry {
            name: "zero_sse_writable",
            cases: |live, cases| flag(live, cases, zero_sse_writable, live.sse_conn, live.ws_conn),
            placeholder: crate::placeholder_call!(unsafe zero_sse_writable(a, b)),
        },
        Entry {
            name: "zero_sse_buffered",
            cases: |live, cases| {
                octets(live, cases, zero_sse_buffered, live.sse_conn, live.ws_conn)
            },
            placeholder: crate::placeholder_call!(unsafe zero_sse_buffered(a, b)),
        },
        Entry {
            name: "zero_sse_close",
            cases: sse_close,
            placeholder: crate::placeholder_call!(zero_sse_close(a)),
        },
        Entry {
            name: "zero_ws_close",
            cases: ws_close,
            placeholder: crate::placeholder_call!(unsafe zero_ws_close(a, b, c, d)),
        },
        Entry {
            name: "zero_ws_terminate",
            cases: ws_terminate,
            placeholder: crate::placeholder_call!(zero_ws_terminate(a)),
        },
    ]
}

/// Send a WebSocket message from a slice.
fn send(conn: u64, opcode: u8, data: &[u8]) -> ZeroStatus {
    // SAFETY: the range is the bytes of a slice.
    unsafe { zero_ws_send(conn, opcode, data.as_ptr(), data.len()) }
}

fn ws_send(live: &Live, cases: &mut Cases) {
    cases.null_range("data", |data, len| {
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access.
        unsafe { zero_ws_send(live.ws_conn, ZERO_OPCODE_BINARY, data, len) }
    });
    for opcode in [0u8, 3, 8, 9, 10, u8::MAX] {
        cases.case(
            Kind::Set,
            format!("opcode {opcode}"),
            ZeroStatus::InvalidArgument,
            send(live.ws_conn, opcode, b"x"),
        );
    }
    cases.case(
        Kind::Other,
        "text that is not UTF-8",
        ZeroStatus::InvalidArgument,
        send(live.ws_conn, ZERO_OPCODE_TEXT, b"\xff"),
    );
    cases.case(
        Kind::Other,
        "an event stream's id",
        ZeroStatus::InvalidArgument,
        send(live.sse_conn, ZERO_OPCODE_TEXT, b"x"),
    );
    cases.conn_ids(live, |conn| send(conn, ZERO_OPCODE_TEXT, b"x"));
    cases.case(
        Kind::Valid,
        "a text message",
        ZeroStatus::Ok,
        send(live.ws_conn, ZERO_OPCODE_TEXT, b"hi"),
    );
    cases.case(
        Kind::Valid,
        "a binary message",
        ZeroStatus::Ok,
        send(live.ws_conn, ZERO_OPCODE_BINARY, &[0, 255]),
    );
}

fn ws_ping(live: &Live, cases: &mut Cases) {
    let call = |conn: u64, data: &[u8]| {
        // SAFETY: the range is the bytes of a slice.
        unsafe { zero_ws_ping(conn, data.as_ptr(), data.len()) }
    };
    cases.null_range("data", |data, len| {
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access.
        unsafe { zero_ws_ping(live.ws_conn, data, len) }
    });
    cases.case(
        Kind::Other,
        "a ping of 126 octets",
        ZeroStatus::InvalidArgument,
        call(live.ws_conn, &[7; 126]),
    );
    cases.conn_ids(live, |conn| call(conn, b"p"));
    cases.case(
        Kind::Valid,
        "a ping of 125 octets",
        ZeroStatus::Ok,
        call(live.ws_conn, &[7; 125]),
    );
}

/// The cases of an export that writes a flag of a connection.
fn flag(
    live: &Live,
    cases: &mut Cases,
    export: unsafe extern "C" fn(u64, *mut u8) -> ZeroStatus,
    conn: u64,
    other: u64,
) {
    let call = |conn: u64, out: *mut u8| {
        // SAFETY: every `out` a case passes is NULL or writable, and the library refuses
        // NULL before any access.
        unsafe { export(conn, out) }
    };
    let mut value = 9u8;
    cases.output("out", |out| call(conn, out));
    cases.conn_ids(live, |conn| call(conn, &mut value));
    cases.case(
        Kind::Other,
        "a connection of the other kind",
        ZeroStatus::InvalidArgument,
        call(other, &mut value),
    );
    cases.case(
        Kind::Valid,
        "a queued connection",
        ZeroStatus::Ok,
        call(conn, &mut value),
    );
    cases.case(
        Kind::Valid,
        "it takes more",
        ZeroStatus::Ok,
        held(value == 1),
    );
}

/// The cases of an export that writes a count of octets of a connection.
fn octets(
    live: &Live,
    cases: &mut Cases,
    export: unsafe extern "C" fn(u64, *mut u64) -> ZeroStatus,
    conn: u64,
    other: u64,
) {
    let call = |conn: u64, out: *mut u64| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { export(conn, out) }
    };
    let mut value = u64::MAX;
    cases.output("bytes_out", |out| call(conn, out));
    cases.conn_ids(live, |conn| call(conn, &mut value));
    cases.case(
        Kind::Other,
        "a connection of the other kind",
        ZeroStatus::InvalidArgument,
        call(other, &mut value),
    );
    cases.case(
        Kind::Valid,
        "a queued connection",
        ZeroStatus::Ok,
        call(conn, &mut value),
    );
    cases.case(
        Kind::Valid,
        "a count",
        ZeroStatus::Ok,
        held(value != u64::MAX),
    );
}

/// The cases of a room membership export.
fn room(
    live: &Live,
    cases: &mut Cases,
    export: unsafe extern "C" fn(u64, *const u8, usize) -> ZeroStatus,
) {
    let call = |conn: u64, room: *const u8, len: usize| {
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or the bytes of a slice.
        unsafe { export(conn, room, len) }
    };
    let lobby = b"lobby";
    cases.null_range("room", |room, len| call(live.ws_conn, room, len));
    cases.case(
        Kind::Other,
        "a name that is not UTF-8",
        ZeroStatus::InvalidArgument,
        call(live.ws_conn, b"\xff".as_ptr(), 1),
    );
    cases.case(
        Kind::Other,
        "an event stream's id",
        ZeroStatus::InvalidArgument,
        call(live.sse_conn, lobby.as_ptr(), lobby.len()),
    );
    cases.conn_ids(live, |conn| call(conn, lobby.as_ptr(), lobby.len()));
    cases.case(
        Kind::Valid,
        "the lobby",
        ZeroStatus::Ok,
        call(live.ws_conn, lobby.as_ptr(), lobby.len()),
    );
}

fn room_broadcast(live: &Live, cases: &mut Cases) {
    let call = |server: u64, room: &[u8], opcode: u8, data: &[u8], except: u64, out: *mut u64| {
        // SAFETY: both ranges are the bytes of slices, and every `out` a case passes is
        // NULL, misaligned or writable; the library refuses the first two before any access.
        unsafe {
            zero_room_broadcast(
                server,
                room.as_ptr(),
                room.len(),
                opcode,
                data.as_ptr(),
                data.len(),
                except,
                out,
            )
        }
    };
    let raw = |room: *const u8, room_len: usize, data: *const u8, len: usize| {
        let mut delivered = 0u64;
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or readable, and `delivered` is writable.
        unsafe {
            zero_room_broadcast(
                live.server,
                room,
                room_len,
                ZERO_OPCODE_TEXT,
                data,
                len,
                ZERO_NONE,
                &mut delivered,
            )
        }
    };
    let mut delivered = 0u64;
    cases.null_range("room", |room, len| raw(room, len, b"x".as_ptr(), 1));
    cases.null_range("data", |data, len| raw(b"lobby".as_ptr(), 5, data, len));
    cases.output("delivered_out", |out| {
        call(
            live.server,
            b"lobby",
            ZERO_OPCODE_TEXT,
            b"x",
            ZERO_NONE,
            out,
        )
    });
    cases.case(
        Kind::Set,
        "opcode 3",
        ZeroStatus::InvalidArgument,
        call(live.server, b"lobby", 3, b"x", ZERO_NONE, &mut delivered),
    );
    cases.case(
        Kind::Id,
        "a wide connection to leave out",
        ZeroStatus::InvalidArgument,
        call(
            live.server,
            b"lobby",
            ZERO_OPCODE_TEXT,
            b"x",
            live.wide,
            &mut delivered,
        ),
    );
    cases.case(
        Kind::Other,
        "text that is not UTF-8",
        ZeroStatus::InvalidArgument,
        call(
            live.server,
            b"lobby",
            ZERO_OPCODE_TEXT,
            b"\xff",
            ZERO_NONE,
            &mut delivered,
        ),
    );
    cases.server_ids(live, |server| {
        call(
            server,
            b"lobby",
            ZERO_OPCODE_TEXT,
            b"x",
            ZERO_NONE,
            &mut delivered,
        )
    });
    cases.case(
        Kind::Valid,
        "a message to the lobby",
        ZeroStatus::Ok,
        call(
            live.server,
            b"lobby",
            ZERO_OPCODE_TEXT,
            b"hi",
            live.ws_conn,
            &mut delivered,
        ),
    );
}

fn room_size(live: &Live, cases: &mut Cases) {
    let call = |server: u64, room: &[u8], out: *mut u64| {
        // SAFETY: the range is the bytes of a slice, and every `out` a case passes is NULL,
        // misaligned or writable; the library refuses the first two before any access.
        unsafe { zero_room_size(server, room.as_ptr(), room.len(), out) }
    };
    let mut count = u64::MAX;
    cases.null_range("room", |room, len| {
        let mut count = 0u64;
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and `count` is writable.
        unsafe { zero_room_size(live.server, room, len, &mut count) }
    });
    cases.output("count_out", |out| call(live.server, b"lobby", out));
    cases.server_ids(live, |server| call(server, b"lobby", &mut count));
    cases.case(
        Kind::Valid,
        "the lobby",
        ZeroStatus::Ok,
        call(live.server, b"lobby", &mut count),
    );
    cases.case(
        Kind::Valid,
        "a count",
        ZeroStatus::Ok,
        held(count != u64::MAX),
    );
}

/// Send an event from optional slices: `None` passes NULL with a zero length.
fn event(conn: u64, kind: Option<&[u8]>, id: Option<&[u8]>, data: &[u8]) -> ZeroStatus {
    let (kind, kind_len) = kind.map_or((ptr::null(), 0), |kind| (kind.as_ptr(), kind.len()));
    let (id, id_len) = id.map_or((ptr::null(), 0), |id| (id.as_ptr(), id.len()));
    // SAFETY: every range is NULL with a zero length or the bytes of a slice.
    unsafe { zero_sse_send(conn, kind, kind_len, id, id_len, data.as_ptr(), data.len()) }
}

fn sse_send(live: &Live, cases: &mut Cases) {
    let conn = live.sse_conn;
    let raw = |kind: *const u8,
               kind_len: usize,
               id: *const u8,
               id_len: usize,
               data: *const u8,
               len: usize| {
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or readable.
        unsafe { zero_sse_send(conn, kind, kind_len, id, id_len, data, len) }
    };
    cases.null_range("event", |kind, len| {
        raw(kind, len, ptr::null(), 0, b"d".as_ptr(), 1)
    });
    cases.null_range("id", |id, len| {
        raw(ptr::null(), 0, id, len, b"d".as_ptr(), 1)
    });
    cases.null_range("data", |data, len| {
        raw(ptr::null(), 0, ptr::null(), 0, data, len)
    });
    for (byte, name) in [(b'\r', "CR"), (b'\n', "LF")] {
        cases.case(
            Kind::Field,
            format!("an event type holding {name}"),
            ZeroStatus::InvalidArgument,
            event(conn, Some(&[b'e', byte]), None, b"d"),
        );
    }
    for (byte, name) in [(b'\r', "CR"), (b'\n', "LF"), (0u8, "NUL")] {
        cases.case(
            Kind::Field,
            format!("an id holding {name}"),
            ZeroStatus::InvalidArgument,
            event(conn, None, Some(&[b'1', byte]), b"d"),
        );
    }
    cases.case(
        Kind::Other,
        "data that is not UTF-8",
        ZeroStatus::InvalidArgument,
        event(conn, None, None, b"\xff"),
    );
    cases.case(
        Kind::Other,
        "a WebSocket's id",
        ZeroStatus::InvalidArgument,
        event(live.ws_conn, None, None, b"d"),
    );
    cases.conn_ids(live, |conn| event(conn, None, None, b"d"));
    cases.case(
        Kind::Valid,
        "an event with a type, an id and two lines",
        ZeroStatus::Ok,
        event(conn, Some(b"update"), Some(b"7"), b"a\nb"),
    );
    cases.case(
        Kind::Valid,
        "an event with no type and no id",
        ZeroStatus::Ok,
        event(conn, None, None, b"x"),
    );
    cases.case(
        Kind::Valid,
        "an empty type and an empty id",
        ZeroStatus::Ok,
        event(conn, Some(b""), Some(b""), b"y"),
    );
}

fn sse_comment(live: &Live, cases: &mut Cases) {
    let call = |conn: u64, text: &[u8]| {
        // SAFETY: the range is the bytes of a slice.
        unsafe { zero_sse_comment(conn, text.as_ptr(), text.len()) }
    };
    cases.null_range("text", |text, len| {
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access.
        unsafe { zero_sse_comment(live.sse_conn, text, len) }
    });
    cases.case(
        Kind::Other,
        "a WebSocket's id",
        ZeroStatus::InvalidArgument,
        call(live.ws_conn, b"c"),
    );
    cases.conn_ids(live, |conn| call(conn, b"c"));
    cases.case(
        Kind::Valid,
        "a comment of two lines",
        ZeroStatus::Ok,
        call(live.sse_conn, b"one\r\ntwo"),
    );
}

fn sse_retry(live: &Live, cases: &mut Cases) {
    cases.case(
        Kind::Other,
        "a WebSocket's id",
        ZeroStatus::InvalidArgument,
        zero_sse_retry(live.ws_conn, 1000),
    );
    cases.conn_ids(live, |conn| zero_sse_retry(conn, 1000));
    cases.case(
        Kind::Valid,
        "a retry",
        ZeroStatus::Ok,
        zero_sse_retry(live.sse_conn, 1000),
    );
}

fn sse_close(live: &Live, cases: &mut Cases) {
    cases.case(
        Kind::Other,
        "a WebSocket's id",
        ZeroStatus::InvalidArgument,
        zero_sse_close(live.ws_conn),
    );
    cases.conn_ids(live, |id| zero_sse_close(id));
    cases.case(
        Kind::Valid,
        "the stream",
        ZeroStatus::Ok,
        zero_sse_close(live.sse_conn),
    );
    cases.case(
        Kind::Other,
        "a stream closed before",
        ZeroStatus::Closed,
        event(live.sse_conn, None, None, b"z"),
    );
}

fn ws_close(live: &Live, cases: &mut Cases) {
    let call = |conn: u64, code: u16, reason: &[u8]| {
        // SAFETY: the range is the bytes of a slice.
        unsafe { zero_ws_close(conn, code, reason.as_ptr(), reason.len()) }
    };
    cases.null_range("reason", |reason, len| {
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access.
        unsafe { zero_ws_close(live.ws_conn, 1000, reason, len) }
    });
    for code in [
        0u16,
        999,
        1004,
        1005,
        1006,
        1010,
        1015,
        1016,
        2999,
        5000,
        u16::MAX,
    ] {
        cases.case(
            Kind::Set,
            format!("close code {code}"),
            ZeroStatus::InvalidArgument,
            call(live.ws_conn, code, b""),
        );
    }
    cases.case(
        Kind::Other,
        "a reason of 124 octets",
        ZeroStatus::InvalidArgument,
        call(live.ws_conn, 1000, &[b'r'; 124]),
    );
    cases.case(
        Kind::Other,
        "a reason that is not UTF-8",
        ZeroStatus::InvalidArgument,
        call(live.ws_conn, 1000, b"\xff"),
    );
    cases.case(
        Kind::Other,
        "an event stream's id",
        ZeroStatus::InvalidArgument,
        call(live.sse_conn, 1000, b""),
    );
    cases.conn_ids(live, |conn| call(conn, 1000, b""));
    cases.case(
        Kind::Valid,
        "a close with a reason of 123 octets",
        ZeroStatus::Ok,
        call(live.ws_conn, 1000, &[b'r'; 123]),
    );
    cases.case(
        Kind::Other,
        "a send after the close",
        ZeroStatus::Closed,
        send(live.ws_conn, ZERO_OPCODE_TEXT, b"late"),
    );
}

fn ws_terminate(live: &Live, cases: &mut Cases) {
    cases.case(
        Kind::Other,
        "an event stream's id",
        ZeroStatus::InvalidArgument,
        zero_ws_terminate(live.sse_conn),
    );
    cases.conn_ids(live, |id| zero_ws_terminate(id));
    cases.case(
        Kind::Valid,
        "a connection",
        ZeroStatus::Ok,
        zero_ws_terminate(live.ws2_conn),
    );
}
