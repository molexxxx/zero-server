//! Responses: status, field lines, bodies, the error writer, the body region, the
//! one-call respond, the actions, reset and send.

use std::mem::size_of;
use std::ptr;

use zero_ffi::*;

use super::library::held;
use super::{Cases, Entry, Kind, Live, SENTINEL_WORD};
use crate::support::ok;

/// The bytes a field value may not hold, with their names.
pub const FORBIDDEN: [(u8, &str); 3] = [(b'\r', "CR"), (b'\n', "LF"), (0, "NUL")];

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_res_status",
            cases: status,
            placeholder: crate::placeholder_call!(zero_res_status(a, b)),
        },
        Entry {
            name: "zero_res_header",
            cases: header,
            placeholder: crate::placeholder_call!(unsafe zero_res_header(a, b, c, d, e, f)),
        },
        Entry {
            name: "zero_res_header_id",
            cases: header_id,
            placeholder: crate::placeholder_call!(unsafe zero_res_header_id(a, b, c, d, e)),
        },
        Entry {
            name: "zero_res_body_copy",
            cases: |live, cases| body(live, cases, zero_res_body_copy, b"x"),
            placeholder: crate::placeholder_call!(unsafe zero_res_body_copy(a, b, c)),
        },
        Entry {
            name: "zero_res_json",
            cases: |live, cases| body(live, cases, zero_res_json, br#"{"a":1}"#),
            placeholder: crate::placeholder_call!(unsafe zero_res_json(a, b, c)),
        },
        Entry {
            name: "zero_res_error",
            cases: error,
            placeholder: crate::placeholder_call!(unsafe zero_res_error(a, b, c, d, e, f, g, h)),
        },
        Entry {
            name: "zero_res_body_alloc",
            cases: body_alloc,
            placeholder: crate::placeholder_call!(unsafe zero_res_body_alloc(a, b, c)),
        },
        Entry {
            name: "zero_res_respond",
            cases: respond,
            placeholder: crate::placeholder_call!(unsafe zero_res_respond(a, b)),
        },
        Entry {
            name: "zero_res_file",
            cases: file,
            placeholder: crate::placeholder_call!(unsafe zero_res_file(a, b, c, d, e)),
        },
        Entry {
            name: "zero_res_sse_open",
            cases: sse_open,
            placeholder: crate::placeholder_call!(unsafe zero_res_sse_open(a, b, c)),
        },
        Entry {
            name: "zero_res_ws_accept",
            cases: ws_accept,
            placeholder: crate::placeholder_call!(unsafe zero_res_ws_accept(a, b, c, d)),
        },
        Entry {
            name: "zero_res_reset",
            cases: reset,
            placeholder: crate::placeholder_call!(zero_res_reset(a)),
        },
        Entry {
            name: "zero_res_send",
            cases: send,
            placeholder: crate::placeholder_call!(zero_res_send(a)),
        },
    ]
}

fn status(live: &Live, cases: &mut Cases) {
    for code in [0u16, 99, 100, 101, 199, 600, u16::MAX] {
        cases.case(
            Kind::Set,
            format!("status {code}"),
            ZeroStatus::InvalidArgument,
            zero_res_status(live.slot, code),
        );
    }
    cases.slot_ids(live, |slot| zero_res_status(slot, 200));
    cases.case(
        Kind::Valid,
        "200",
        ZeroStatus::Ok,
        zero_res_status(live.slot, 200),
    );
    cases.case(
        Kind::Valid,
        "599",
        ZeroStatus::Ok,
        zero_res_status(live.slot, 599),
    );
}

/// Write a field line by name.
pub fn write_header(slot: u64, name: &[u8], value: &[u8], mode: u32) -> ZeroStatus {
    // SAFETY: both ranges are the bytes of slices.
    unsafe {
        zero_res_header(
            slot,
            name.as_ptr(),
            name.len(),
            value.as_ptr(),
            value.len(),
            mode,
        )
    }
}

/// Write a field line by interned id.
pub fn write_header_id(slot: u64, id: u32, value: &[u8], mode: u32) -> ZeroStatus {
    // SAFETY: the range is the bytes of a slice.
    unsafe { zero_res_header_id(slot, id, value.as_ptr(), value.len(), mode) }
}

fn header(live: &Live, cases: &mut Cases) {
    let slot = live.slot;
    cases.null_range("name", |name, len| {
        // SAFETY: the name range is NULL with a length, which the library refuses before
        // any access, and the value is a slice.
        unsafe { zero_res_header(slot, name, len, b"v".as_ptr(), 1, ZERO_HEADER_SET) }
    });
    cases.null_range("value", |value, len| {
        // SAFETY: the value range is NULL with a length, which the library refuses before
        // any access, and the name is a slice.
        unsafe { zero_res_header(slot, b"x-a".as_ptr(), 3, value, len, ZERO_HEADER_SET) }
    });
    for mode in [2u32, 3, u32::MAX] {
        cases.case(
            Kind::Set,
            format!("header mode {mode}"),
            ZeroStatus::InvalidArgument,
            write_header(slot, b"x-a", b"v", mode),
        );
    }
    for (byte, name) in FORBIDDEN {
        cases.case(
            Kind::Field,
            format!("a value holding {name}"),
            ZeroStatus::InvalidArgument,
            write_header(slot, b"x-split", &[b'a', byte, b'b'], ZERO_HEADER_APPEND),
        );
        cases.case(
            Kind::Field,
            format!("a value ending in {name}"),
            ZeroStatus::InvalidArgument,
            write_header(slot, b"x-split", &[b'a', byte], ZERO_HEADER_SET),
        );
    }
    cases.case(
        Kind::Other,
        "a name with a space",
        ZeroStatus::InvalidArgument,
        write_header(slot, b"x a", b"v", ZERO_HEADER_SET),
    );
    cases.case(
        Kind::Other,
        "an empty name",
        ZeroStatus::InvalidArgument,
        write_header(slot, b"", b"v", ZERO_HEADER_SET),
    );
    for reserved in [
        &b"Content-Length"[..],
        b"connection",
        b"Transfer-Encoding",
        b"DATE",
    ] {
        cases.case(
            Kind::Other,
            format!("the driver's {}", String::from_utf8_lossy(reserved)),
            ZeroStatus::InvalidArgument,
            write_header(slot, reserved, b"1", ZERO_HEADER_SET),
        );
    }
    cases.case(
        Kind::Other,
        "a value with a leading space",
        ZeroStatus::InvalidArgument,
        write_header(slot, b"x-a", b" v", ZERO_HEADER_SET),
    );
    cases.slot_ids(live, |slot| {
        write_header(slot, b"x-a", b"v", ZERO_HEADER_SET)
    });
    cases.case(
        Kind::Valid,
        "a field line",
        ZeroStatus::Ok,
        write_header(slot, b"X-Seq", b"1", ZERO_HEADER_SET),
    );
    cases.case(
        Kind::Valid,
        "an appended Set-Cookie",
        ZeroStatus::Ok,
        write_header(slot, b"Set-Cookie", b"a=1; Path=/", ZERO_HEADER_APPEND),
    );
}

fn header_id(live: &Live, cases: &mut Cases) {
    let slot = live.slot;
    cases.null_range("value", |value, len| {
        // SAFETY: the value range is NULL with a length, which the library refuses before
        // any access.
        unsafe { zero_res_header_id(slot, ZERO_HEADER_CACHE_CONTROL, value, len, ZERO_HEADER_SET) }
    });
    for id in [ZERO_HEADER_COUNT, 200, ZERO_HEADER_NONE] {
        cases.case(
            Kind::Set,
            format!("header id {id}"),
            ZeroStatus::InvalidArgument,
            write_header_id(slot, id, b"v", ZERO_HEADER_SET),
        );
    }
    cases.case(
        Kind::Set,
        "header mode 2",
        ZeroStatus::InvalidArgument,
        write_header_id(slot, ZERO_HEADER_CACHE_CONTROL, b"v", 2),
    );
    for (byte, name) in FORBIDDEN {
        cases.case(
            Kind::Field,
            format!("a value holding {name}"),
            ZeroStatus::InvalidArgument,
            write_header_id(
                slot,
                ZERO_HEADER_CACHE_CONTROL,
                &[b'a', byte, b'b'],
                ZERO_HEADER_SET,
            ),
        );
    }
    for reserved in [
        ZERO_HEADER_CONTENT_LENGTH,
        ZERO_HEADER_CONNECTION,
        ZERO_HEADER_TRANSFER_ENCODING,
        ZERO_HEADER_DATE,
    ] {
        cases.case(
            Kind::Other,
            format!("the driver's header {reserved}"),
            ZeroStatus::InvalidArgument,
            write_header_id(slot, reserved, b"1", ZERO_HEADER_SET),
        );
    }
    cases.slot_ids(live, |slot| {
        write_header_id(slot, ZERO_HEADER_CACHE_CONTROL, b"v", ZERO_HEADER_SET)
    });
    cases.case(
        Kind::Valid,
        "Cache-Control",
        ZeroStatus::Ok,
        write_header_id(
            slot,
            ZERO_HEADER_CACHE_CONTROL,
            b"no-store",
            ZERO_HEADER_SET,
        ),
    );
}

/// The cases of a body export.
fn body(
    live: &Live,
    cases: &mut Cases,
    export: unsafe extern "C" fn(u64, *const u8, usize) -> ZeroStatus,
    bytes: &[u8],
) {
    let call = |slot: u64, data: *const u8, len: usize| {
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or the bytes of a slice.
        unsafe { export(slot, data, len) }
    };
    cases.null_range("body", |data, len| call(live.slot, data, len));
    cases.slot_ids(live, |slot| call(slot, bytes.as_ptr(), bytes.len()));
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        call(live.slot, bytes.as_ptr(), bytes.len()),
    );
}

/// Write an error with byte arguments.
fn write_error(slot: u64, status: u16, code: &[u8], message: &[u8], details: &[u8]) -> ZeroStatus {
    // SAFETY: every range is the bytes of a slice.
    unsafe {
        zero_res_error(
            slot,
            status,
            code.as_ptr(),
            code.len(),
            message.as_ptr(),
            message.len(),
            details.as_ptr(),
            details.len(),
        )
    }
}

fn error(live: &Live, cases: &mut Cases) {
    let slot = live.error;
    let raw = |code: *const u8,
               code_len: usize,
               message: *const u8,
               message_len: usize,
               details: *const u8,
               details_len: usize| {
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or readable.
        unsafe {
            zero_res_error(
                slot,
                422,
                code,
                code_len,
                message,
                message_len,
                details,
                details_len,
            )
        }
    };
    let code = b"INVALID_INPUT";
    cases.null_range("code", |data, len| {
        raw(data, len, ptr::null(), 0, ptr::null(), 0)
    });
    cases.null_range("message", |data, len| {
        raw(code.as_ptr(), code.len(), data, len, ptr::null(), 0)
    });
    cases.null_range("details_json", |data, len| {
        raw(code.as_ptr(), code.len(), ptr::null(), 0, data, len)
    });
    cases.case(
        Kind::Other,
        "an empty code",
        ZeroStatus::InvalidArgument,
        write_error(slot, 422, b"", b"", b""),
    );
    cases.case(
        Kind::Other,
        "a lowercase code",
        ZeroStatus::InvalidArgument,
        write_error(slot, 422, b"bad_input", b"", b""),
    );
    cases.case(
        Kind::Other,
        "a code of 65 octets",
        ZeroStatus::InvalidArgument,
        write_error(slot, 422, &[b'A'; 65], b"", b""),
    );
    cases.slot_ids(live, |slot| write_error(slot, 422, code, b"", b""));
    cases.case(
        Kind::Valid,
        "an error with a message and details",
        ZeroStatus::Ok,
        write_error(
            slot,
            422,
            code,
            b"the input is not valid",
            br#"{"field":"name"}"#,
        ),
    );
    cases.case(
        Kind::Other,
        "a sealed response",
        ZeroStatus::Closed,
        write_error(slot, 500, b"AGAIN", b"", b""),
    );
}

fn body_alloc(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, len: usize, out: *mut *mut u8| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_res_body_alloc(slot, len, out) }
    };
    let slot = live.region;
    let mut region = ptr::null_mut::<u8>();
    cases.output("region_out", |out| call(slot, 16, out));
    cases.case(
        Kind::Other,
        "a region without the thread's pin",
        ZeroStatus::InvalidArgument,
        call(slot, 16, &mut region),
    );
    cases.slot_ids(live, |slot| call(slot, 16, &mut region));
    ok(zero_slot_pin(slot));
    cases.case(
        Kind::Other,
        "a region past the response limit",
        ZeroStatus::Limit,
        call(slot, usize::MAX, &mut region),
    );
    let status = call(slot, 16, &mut region);
    cases.case(Kind::Valid, "a pinned region", ZeroStatus::Ok, status);
    let zeroed = !region.is_null() && {
        // SAFETY: the region is 16 writable octets while the pin is held.
        let bytes = unsafe { std::slice::from_raw_parts(region.cast_const(), 16) };
        bytes.iter().all(|byte| *byte == 0)
    };
    cases.case(
        Kind::Valid,
        "a zero-filled region",
        ZeroStatus::Ok,
        held(zeroed),
    );
    let mut again = ptr::null_mut::<u8>();
    cases.case(
        Kind::Other,
        "a second region",
        ZeroStatus::InvalidArgument,
        call(slot, 8, &mut again),
    );
    let body = b"x";
    // SAFETY: the range is `body`.
    let copied = unsafe { zero_res_body_copy(slot, body.as_ptr(), body.len()) };
    cases.case(
        Kind::Other,
        "a body copy while a region is open",
        ZeroStatus::InvalidArgument,
        copied,
    );
    // SAFETY: the range is `body`.
    let json = unsafe { zero_res_json(slot, body.as_ptr(), body.len()) };
    cases.case(
        Kind::Other,
        "a JSON body while a region is open",
        ZeroStatus::InvalidArgument,
        json,
    );
    let spec = spec_of(200, &[], b"x");
    // SAFETY: `spec` is a readable struct of its size whose ranges are slices.
    let responded = unsafe { zero_res_respond(slot, &spec.spec) };
    cases.case(
        Kind::Other,
        "a respond while a region is open",
        ZeroStatus::InvalidArgument,
        responded,
    );
    cases.case(
        Kind::Other,
        "an error while a region is open",
        ZeroStatus::InvalidArgument,
        write_error(slot, 500, b"FAILED", b"", b""),
    );
    cases.case(
        Kind::Other,
        "a reset while a region is open",
        ZeroStatus::InvalidArgument,
        zero_res_reset(slot),
    );
    cases.case(
        Kind::Valid,
        "the send of the region",
        ZeroStatus::Ok,
        zero_res_send(slot),
    );
    ok(zero_slot_unpin(slot));
}

/// A response spec and the pairs and bytes it points to.
pub struct Spec {
    pub spec: ZeroResponseSpec,
    pub pairs: Vec<ZeroHeaderPair>,
}

/// A spec of `status`, field lines and a body; the slices must outlive its use.
pub fn spec_of(status: u16, fields: &[(&[u8], &[u8])], body: &[u8]) -> Spec {
    let pairs: Vec<ZeroHeaderPair> = fields
        .iter()
        .map(|(name, value)| ZeroHeaderPair {
            name: ZeroBytes {
                ptr: name.as_ptr(),
                len: name.len(),
            },
            value: ZeroBytes {
                ptr: value.as_ptr(),
                len: value.len(),
            },
        })
        .collect();
    let spec = ZeroResponseSpec {
        size: u32::try_from(size_of::<ZeroResponseSpec>()).unwrap(),
        status,
        reserved: 0,
        field_size: u32::try_from(size_of::<ZeroHeaderPair>()).unwrap(),
        reserved2: 0,
        fields: if pairs.is_empty() {
            ptr::null()
        } else {
            pairs.as_ptr()
        },
        field_count: pairs.len(),
        body: ZeroBytes {
            ptr: body.as_ptr(),
            len: body.len(),
        },
    };
    Spec { spec, pairs }
}

fn respond(live: &Live, cases: &mut Cases) {
    let slot = live.respond;
    let call = |slot: u64, spec: *const ZeroResponseSpec| {
        // SAFETY: every `spec` a case passes is NULL or a readable struct of its size whose
        // array and ranges are NULL with a count or readable; the library refuses NULL
        // before any access.
        unsafe { zero_res_respond(slot, spec) }
    };
    cases.case(
        Kind::Pointer,
        "spec NULL",
        ZeroStatus::InvalidArgument,
        call(slot, ptr::null()),
    );
    let good = spec_of(
        201,
        &[(b"Set-Cookie", b"a=1"), (b"Set-Cookie", b"b=2")],
        b"made",
    );
    let mut small = good.spec;
    small.size = 8;
    cases.case(
        Kind::Pointer,
        "a size below version 1",
        ZeroStatus::InvalidArgument,
        call(slot, &small),
    );
    let mut narrow = good.spec;
    narrow.field_size = 8;
    cases.case(
        Kind::Pointer,
        "field_size below version 1",
        ZeroStatus::InvalidArgument,
        call(slot, &narrow),
    );
    let mut no_fields = good.spec;
    no_fields.fields = ptr::null();
    cases.case(
        Kind::Pointer,
        "fields NULL with a count",
        ZeroStatus::InvalidArgument,
        call(slot, &no_fields),
    );
    let nameless = spec_of(201, &[(b"x-a", b"v")], b"");
    let mut nameless_spec = nameless.spec;
    let mut nameless_pairs = nameless.pairs.clone();
    nameless_pairs[0].name.ptr = ptr::null();
    nameless_spec.fields = nameless_pairs.as_ptr();
    cases.case(
        Kind::Pointer,
        "a field name NULL with a length",
        ZeroStatus::InvalidArgument,
        call(slot, &nameless_spec),
    );
    let mut bodiless = good.spec;
    bodiless.body.ptr = ptr::null();
    cases.case(
        Kind::Pointer,
        "the body NULL with a length",
        ZeroStatus::InvalidArgument,
        call(slot, &bodiless),
    );
    for code in [99u16, 101, 199, 600] {
        let mut wrong = good.spec;
        wrong.status = code;
        cases.case(
            Kind::Set,
            format!("status {code}"),
            ZeroStatus::InvalidArgument,
            call(slot, &wrong),
        );
    }
    for (byte, name) in FORBIDDEN {
        let value = [b'a', byte, b'b'];
        let split = spec_of(
            201,
            &[(b"Set-Cookie", b"c=3"), (b"X-Split", &value)],
            b"split",
        );
        cases.case(
            Kind::Field,
            format!("a field line whose value holds {name}"),
            ZeroStatus::InvalidArgument,
            call(slot, &split.spec),
        );
    }
    cases.slot_ids(live, |slot| call(slot, &good.spec));
    let mut wider = [SENTINEL_WORD; 8];
    let wide_spec = ZeroResponseSpec {
        size: u32::try_from(size_of::<[u64; 8]>()).unwrap(),
        ..good.spec
    };
    // SAFETY: `wider` holds 64 octets, at least the spec's size.
    unsafe {
        ptr::copy_nonoverlapping(
            ptr::from_ref(&wide_spec).cast::<u8>(),
            wider.as_mut_ptr().cast::<u8>(),
            size_of::<ZeroResponseSpec>(),
        )
    };
    cases.case(
        Kind::Valid,
        "a spec larger than version 1",
        ZeroStatus::Ok,
        call(slot, wider.as_ptr().cast::<ZeroResponseSpec>()),
    );
    cases.case(
        Kind::Other,
        "a sealed response",
        ZeroStatus::Closed,
        call(slot, &good.spec),
    );
}

fn file(live: &Live, cases: &mut Cases) {
    let root = live
        .root
        .to_str()
        .expect("a UTF-8 root")
        .as_bytes()
        .to_vec();
    let call = |slot: u64, root: &[u8], path: &[u8]| {
        // SAFETY: both ranges are the bytes of slices.
        unsafe { zero_res_file(slot, root.as_ptr(), root.len(), path.as_ptr(), path.len()) }
    };
    let slot = live.file;
    cases.null_range("root", |data, len| {
        // SAFETY: the root range is NULL with a length, which the library refuses before
        // any access, and the path is empty.
        unsafe { zero_res_file(slot, data, len, ptr::null(), 0) }
    });
    cases.null_range("path", |data, len| {
        // SAFETY: the path range is NULL with a length, which the library refuses before
        // any access, and the root is a slice.
        unsafe { zero_res_file(slot, root.as_ptr(), root.len(), data, len) }
    });
    cases.case(
        Kind::Other,
        "an empty root",
        ZeroStatus::InvalidArgument,
        call(slot, b"", b"hello.txt"),
    );
    cases.case(
        Kind::Other,
        "a root that is not UTF-8",
        ZeroStatus::InvalidArgument,
        call(slot, b"/\xff", b"hello.txt"),
    );
    cases.slot_ids(live, |slot| call(slot, &root, b"hello.txt"));
    cases.case(
        Kind::Valid,
        "a file",
        ZeroStatus::Ok,
        call(slot, &root, b"hello.txt"),
    );
    cases.case(
        Kind::Other,
        "a sealed response",
        ZeroStatus::Closed,
        call(slot, &root, b"hello.txt"),
    );
}

fn sse_open(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, out: *mut u64| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_res_sse_open(slot, 0, out) }
    };
    let mut conn = 0u64;
    cases.output("conn_out", |out| call(live.slot, out));
    cases.slot_ids(live, |slot| call(slot, &mut conn));
    cases.case(
        Kind::Valid,
        "the stream the fixture opened",
        ZeroStatus::Ok,
        held(live.sse_conn != 0),
    );
    cases.case(
        Kind::Other,
        "a sealed response",
        ZeroStatus::Closed,
        call(live.sse, &mut conn),
    );
}

fn ws_accept(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, protocol: &[u8], out: *mut u64| {
        // SAFETY: the range is the bytes of a slice, and every `out` a case passes is NULL,
        // misaligned or writable; the library refuses the first two before any access.
        unsafe { zero_res_ws_accept(slot, protocol.as_ptr(), protocol.len(), out) }
    };
    let mut conn = 0u64;
    cases.output("conn_out", |out| call(live.slot, b"", out));
    cases.null_range("protocol", |data, len| {
        let mut conn = 0u64;
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and `conn` is writable.
        unsafe { zero_res_ws_accept(live.slot, data, len, &mut conn) }
    });
    cases.slot_ids(live, |slot| call(slot, b"", &mut conn));
    cases.case(
        Kind::Other,
        "a request of a host route",
        ZeroStatus::InvalidArgument,
        call(live.slot, b"", &mut conn),
    );
    cases.case(
        Kind::Valid,
        "the connection the fixture accepted",
        ZeroStatus::Ok,
        held(live.ws_conn != 0),
    );
    cases.case(
        Kind::Other,
        "a sealed response",
        ZeroStatus::Closed,
        call(live.ws, b"chat", &mut conn),
    );
}

fn reset(live: &Live, cases: &mut Cases) {
    cases.slot_ids(live, |id| zero_res_reset(id));
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        zero_res_reset(live.slot),
    );
}

fn send(live: &Live, cases: &mut Cases) {
    cases.slot_ids(live, |id| zero_res_send(id));
    cases.case(
        Kind::Valid,
        "a response as written",
        ZeroStatus::Ok,
        zero_res_send(live.send),
    );
    cases.case(
        Kind::Other,
        "a sealed response",
        ZeroStatus::Closed,
        zero_res_send(live.send),
    );
}
