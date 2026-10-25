//! Requests: the view, its values, and the lookups that return views.

use std::mem::size_of;
use std::ptr;

use zero_ffi::*;

use super::library::held;
use super::{Cases, Entry, Kind, Live, SENTINEL_WORD};
use crate::support::{ok, take_buffer, view};

/// The signature of the exports that write one view.
type ViewCall = unsafe extern "C" fn(u64, *mut ZeroBytes) -> ZeroStatus;

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_req_view",
            cases: request_view,
            placeholder: crate::placeholder_call!(unsafe zero_req_view(a, b)),
        },
        Entry {
            name: "zero_req_method",
            cases: method,
            placeholder: crate::placeholder_call!(unsafe zero_req_method(a, b)),
        },
        Entry {
            name: "zero_req_method_token",
            cases: |live, cases| one_view(live, cases, zero_req_method_token, Some(b"GET")),
            placeholder: crate::placeholder_call!(unsafe zero_req_method_token(a, b)),
        },
        Entry {
            name: "zero_req_target",
            cases: |live, cases| one_view(live, cases, zero_req_target, Some(b"/t/live?q=1")),
            placeholder: crate::placeholder_call!(unsafe zero_req_target(a, b)),
        },
        Entry {
            name: "zero_req_path",
            cases: |live, cases| one_view(live, cases, zero_req_path, Some(b"/t/live")),
            placeholder: crate::placeholder_call!(unsafe zero_req_path(a, b)),
        },
        Entry {
            name: "zero_req_query",
            cases: |live, cases| one_view(live, cases, zero_req_query, Some(b"q=1")),
            placeholder: crate::placeholder_call!(unsafe zero_req_query(a, b)),
        },
        Entry {
            name: "zero_req_route_path",
            cases: |live, cases| one_view(live, cases, zero_req_route_path, Some(b"/t/live")),
            placeholder: crate::placeholder_call!(unsafe zero_req_route_path(a, b)),
        },
        Entry {
            name: "zero_req_authority",
            cases: |live, cases| one_view(live, cases, zero_req_authority, Some(b"t")),
            placeholder: crate::placeholder_call!(unsafe zero_req_authority(a, b)),
        },
        Entry {
            name: "zero_req_param_count",
            cases: |live, cases| count(live, cases, zero_req_param_count, 1),
            placeholder: crate::placeholder_call!(unsafe zero_req_param_count(a, b)),
        },
        Entry {
            name: "zero_req_param",
            cases: param,
            placeholder: crate::placeholder_call!(unsafe zero_req_param(a, b, c)),
        },
        Entry {
            name: "zero_req_header_count",
            cases: |live, cases| count(live, cases, zero_req_header_count, 4),
            placeholder: crate::placeholder_call!(unsafe zero_req_header_count(a, b)),
        },
        Entry {
            name: "zero_req_header_at",
            cases: header_at,
            placeholder: crate::placeholder_call!(unsafe zero_req_header_at(a, b, c, d)),
        },
        Entry {
            name: "zero_req_header_id",
            cases: header_id,
            placeholder: crate::placeholder_call!(unsafe zero_req_header_id(a, b, c, d)),
        },
        Entry {
            name: "zero_req_header",
            cases: header,
            placeholder: crate::placeholder_call!(unsafe zero_req_header(a, b, c, d, e)),
        },
        Entry {
            name: "zero_req_trailer",
            cases: trailer,
            placeholder: crate::placeholder_call!(unsafe zero_req_trailer(a, b, c, d)),
        },
        Entry {
            name: "zero_req_body",
            cases: |live, cases| one_view(live, cases, zero_req_body, Some(b"")),
            placeholder: crate::placeholder_call!(unsafe zero_req_body(a, b)),
        },
        Entry {
            name: "zero_req_body_retain",
            cases: body_retain,
            placeholder: crate::placeholder_call!(unsafe zero_req_body_retain(a, b)),
        },
        Entry {
            name: "zero_req_claim",
            cases: claim,
            placeholder: crate::placeholder_call!(unsafe zero_req_claim(a, b, c, d)),
        },
        Entry {
            name: "zero_req_peer",
            cases: peer,
            placeholder: crate::placeholder_call!(unsafe zero_req_peer(a, b)),
        },
    ]
}

/// The view rule's cases of a view call: refused on a thread that neither pinned the slot
/// nor is inside the delivering batch, refused on the target thread after it acknowledged
/// the batch, and allowed on a thread that pinned the slot.
fn view_rule(
    live: &Live,
    cases: &mut Cases,
    call: impl Fn(u64) -> ZeroStatus + Copy + Send + 'static,
) {
    let slot = live.slot;
    let unpinned = std::thread::spawn(move || call(slot)).join().unwrap();
    cases.case(
        Kind::View,
        "a thread without a pin, outside the batch window",
        ZeroStatus::InvalidArgument,
        unpinned,
    );
    cases.case(
        Kind::View,
        "the target thread after it acknowledged the delivering batch",
        ZeroStatus::InvalidArgument,
        call(live.respond),
    );
    let pinned = std::thread::spawn(move || {
        ok(zero_slot_pin(slot));
        let status = call(slot);
        ok(zero_slot_unpin(slot));
        status
    })
    .join()
    .unwrap();
    cases.case(
        Kind::View,
        "a thread that pinned the slot",
        ZeroStatus::Ok,
        pinned,
    );
}

/// The cases of an export that writes one view.
fn one_view(live: &Live, cases: &mut Cases, export: ViewCall, expected: Option<&[u8]>) {
    let call = |slot: u64, out: *mut ZeroBytes| {
        // SAFETY: `export` is a view export, and every `out` a case passes is NULL,
        // misaligned or writable; the library refuses the first two before any access.
        unsafe { export(slot, out) }
    };
    let mut bytes = ZeroBytes::ABSENT;
    cases.output("out", |out| call(live.slot, out));
    cases.slot_ids(live, |slot| call(slot, &mut bytes));
    view_rule(live, cases, move |slot| written(export, slot));
    let status = call(live.slot, &mut bytes);
    cases.case(
        Kind::Valid,
        "the live slot on its target thread",
        ZeroStatus::Ok,
        status,
    );
    cases.case(
        Kind::Valid,
        "its bytes",
        ZeroStatus::Ok,
        held(view(bytes).as_deref() == expected),
    );
}

/// Call a view export into a local output and return its status.
fn written(export: ViewCall, slot: u64) -> ZeroStatus {
    let mut bytes = ZeroBytes::ABSENT;
    // SAFETY: `bytes` is a writable `ZeroBytes`.
    unsafe { export(slot, &mut bytes) }
}

fn request_view(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, out: *mut ZeroRequestView| {
        // SAFETY: every `out` a case passes is NULL, misaligned, or a writable struct of at
        // least its `size` octets; the library refuses the first two before any access.
        unsafe { zero_req_view(slot, out) }
    };
    let sized = || {
        let mut view = empty_view();
        view.size = u32::try_from(size_of::<ZeroRequestView>()).unwrap();
        view
    };
    cases.output("view_out", |out| call(live.slot, out));
    let mut small = empty_view();
    small.size = 16;
    small.body_len = SENTINEL_WORD;
    let status = call(live.slot, &mut small);
    cases.untouched(
        "a size below version 1",
        ZeroStatus::InvalidArgument,
        status,
        small.size == 16 && small.body_len == SENTINEL_WORD,
    );
    let mut out = sized();
    cases.slot_ids(live, |slot| call(slot, &mut out));
    view_rule(live, cases, |slot| {
        let mut view = empty_view();
        view.size = u32::try_from(size_of::<ZeroRequestView>()).unwrap();
        // SAFETY: `view` is a writable struct of its own size.
        unsafe { zero_req_view(slot, &mut view) }
    });
    let mut view = sized();
    let status = call(live.slot, &mut view);
    cases.case(
        Kind::Valid,
        "the live slot on its target thread",
        ZeroStatus::Ok,
        status,
    );
    let head = if view.head.is_null() {
        Vec::new()
    } else {
        // SAFETY: the head is `head_len` octets the batch window keeps valid.
        unsafe { std::slice::from_raw_parts(view.head, usize::try_from(view.head_len).unwrap()) }
            .to_vec()
    };
    let span = |span: ZeroSpan| {
        let start = usize::try_from(span.start).unwrap();
        head.get(start..start + usize::try_from(span.len).unwrap())
            .map(<[u8]>::to_vec)
    };
    let first_field = if view.fields.is_null() || view.field_count == 0 {
        None
    } else {
        // SAFETY: the table holds `field_count` entries, the first at its start.
        Some(unsafe { *view.fields })
    };
    cases.case(
        Kind::Valid,
        "its values and spans",
        ZeroStatus::Ok,
        held(
            view.method == ZERO_METHOD_GET
                && view.version == 11
                && view.flags & ZERO_VIEW_QUERY != 0
                && view.flags & ZERO_VIEW_KEEP_ALIVE != 0
                && view.route == live.host_route
                && view.miss_status == 0
                && view.field_count == 4
                && view.param_count == 1
                && view.body_len == 0
                && usize::try_from(view.field_size).unwrap() == size_of::<ZeroField>()
                && usize::try_from(view.size).unwrap() == size_of::<ZeroRequestView>()
                && span(view.path).as_deref() == Some(&b"/t/live"[..])
                && span(view.query).as_deref() == Some(&b"q=1"[..])
                && first_field.is_some_and(|field| {
                    span(field.name).as_deref() == Some(&b"Host"[..])
                        && span(field.value).as_deref() == Some(&b"t"[..])
                        && field.id == ZERO_HEADER_HOST
                }),
        ),
    );
}

/// A request view with every field zero.
fn empty_view() -> ZeroRequestView {
    ZeroRequestView {
        size: 0,
        method: 0,
        version: 0,
        flags: 0,
        route: 0,
        miss_status: 0,
        allow: 0,
        head: ptr::null(),
        head_len: 0,
        field_count: 0,
        method_token: ZeroSpan::default(),
        target: ZeroSpan::default(),
        path: ZeroSpan::default(),
        query: ZeroSpan::default(),
        authority: ZeroSpan::default(),
        fields: ptr::null(),
        route_path: ptr::null(),
        route_path_len: 0,
        param_count: 0,
        body: ptr::null(),
        body_len: 0,
        field_size: 0,
        reserved: 0,
    }
}

fn method(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, out: *mut u8| {
        // SAFETY: every `out` a case passes is NULL or writable, and the library refuses
        // NULL before any access.
        unsafe { zero_req_method(slot, out) }
    };
    let mut method = u8::MAX;
    cases.output("method_out", |out| call(live.slot, out));
    cases.slot_ids(live, |slot| call(slot, &mut method));
    let slot = live.slot;
    let elsewhere = std::thread::spawn(move || {
        let mut method = u8::MAX;
        (call(slot, &mut method), method)
    })
    .join()
    .unwrap();
    cases.case(
        Kind::View,
        "a value, read from any thread",
        ZeroStatus::Ok,
        held(elsewhere == (ZeroStatus::Ok, ZERO_METHOD_GET)),
    );
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        call(live.slot, &mut method),
    );
    cases.case(
        Kind::Valid,
        "GET",
        ZeroStatus::Ok,
        held(method == ZERO_METHOD_GET),
    );
}

/// The cases of an export that writes one count.
fn count(
    live: &Live,
    cases: &mut Cases,
    export: unsafe extern "C" fn(u64, *mut u32) -> ZeroStatus,
    expected: u32,
) {
    let call = |slot: u64, out: *mut u32| {
        // SAFETY: `export` is a count export, and every `out` a case passes is NULL,
        // misaligned or writable; the library refuses the first two before any access.
        unsafe { export(slot, out) }
    };
    let mut value = u32::MAX;
    cases.output("count_out", |out| call(live.slot, out));
    cases.slot_ids(live, |slot| call(slot, &mut value));
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        call(live.slot, &mut value),
    );
    cases.case(
        Kind::Valid,
        "its count",
        ZeroStatus::Ok,
        held(value == expected),
    );
}

fn param(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, index: u32, out: *mut ZeroBytes| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_req_param(slot, index, out) }
    };
    let mut bytes = ZeroBytes::ABSENT;
    cases.output("out", |out| call(live.slot, 0, out));
    cases.slot_ids(live, |slot| call(slot, 0, &mut bytes));
    cases.case(
        Kind::Set,
        "an index at the count",
        ZeroStatus::InvalidArgument,
        call(live.slot, 1, &mut bytes),
    );
    view_rule(live, cases, |slot| {
        let mut bytes = ZeroBytes::ABSENT;
        // SAFETY: `bytes` is a writable `ZeroBytes`.
        unsafe { zero_req_param(slot, 0, &mut bytes) }
    });
    cases.case(
        Kind::Valid,
        "parameter 0",
        ZeroStatus::Ok,
        call(live.slot, 0, &mut bytes),
    );
    cases.case(
        Kind::Valid,
        "its value",
        ZeroStatus::Ok,
        held(view(bytes).as_deref() == Some(&b"live"[..])),
    );
}

fn header_at(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, index: u32, name: *mut ZeroBytes, value: *mut ZeroBytes| {
        // SAFETY: every output a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_req_header_at(slot, index, name, value) }
    };
    let mut name = ZeroBytes::ABSENT;
    let mut value = ZeroBytes::ABSENT;
    cases.output("name_out", |out| call(live.slot, 0, out, &mut value));
    cases.output("value_out", |out| call(live.slot, 0, &mut name, out));
    cases.slot_ids(live, |slot| call(slot, 0, &mut name, &mut value));
    cases.case(
        Kind::Set,
        "an index at the count",
        ZeroStatus::InvalidArgument,
        call(live.slot, 4, &mut name, &mut value),
    );
    view_rule(live, cases, |slot| {
        let mut name = ZeroBytes::ABSENT;
        let mut value = ZeroBytes::ABSENT;
        // SAFETY: both outputs are writable `ZeroBytes`.
        unsafe { zero_req_header_at(slot, 0, &mut name, &mut value) }
    });
    cases.case(
        Kind::Valid,
        "field 2",
        ZeroStatus::Ok,
        call(live.slot, 2, &mut name, &mut value),
    );
    cases.case(
        Kind::Valid,
        "its name and value",
        ZeroStatus::Ok,
        held(
            view(name).as_deref() == Some(&b"X-Dup"[..])
                && view(value).as_deref() == Some(&b"a"[..]),
        ),
    );
}

fn header_id(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, id: u32, nth: u32, out: *mut ZeroBytes| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_req_header_id(slot, id, nth, out) }
    };
    let mut bytes = ZeroBytes::ABSENT;
    cases.output("out", |out| call(live.slot, ZERO_HEADER_HOST, 0, out));
    cases.slot_ids(live, |slot| call(slot, ZERO_HEADER_HOST, 0, &mut bytes));
    for id in [ZERO_HEADER_COUNT, 200, ZERO_HEADER_NONE] {
        cases.case(
            Kind::Set,
            format!("header id {id}"),
            ZeroStatus::InvalidArgument,
            call(live.slot, id, 0, &mut bytes),
        );
    }
    view_rule(live, cases, |slot| {
        let mut bytes = ZeroBytes::ABSENT;
        // SAFETY: `bytes` is a writable `ZeroBytes`.
        unsafe { zero_req_header_id(slot, ZERO_HEADER_HOST, 0, &mut bytes) }
    });
    cases.case(
        Kind::Valid,
        "Host",
        ZeroStatus::Ok,
        call(live.slot, ZERO_HEADER_HOST, 0, &mut bytes),
    );
    cases.case(
        Kind::Valid,
        "its value",
        ZeroStatus::Ok,
        held(view(bytes).as_deref() == Some(&b"t"[..])),
    );
    cases.case(
        Kind::Valid,
        "a second Host line",
        ZeroStatus::Ok,
        call(live.slot, ZERO_HEADER_HOST, 1, &mut bytes),
    );
    cases.case(
        Kind::Valid,
        "is absent",
        ZeroStatus::Ok,
        held(view(bytes).is_none()),
    );
}

fn header(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, name: &[u8], nth: u32, out: *mut ZeroBytes| {
        // SAFETY: the range is the bytes of a slice, and every `out` a case passes is NULL,
        // misaligned or writable; the library refuses the first two before any access.
        unsafe { zero_req_header(slot, name.as_ptr(), name.len(), nth, out) }
    };
    let mut bytes = ZeroBytes::ABSENT;
    cases.output("out", |out| call(live.slot, b"x-dup", 0, out));
    cases.null_range("name", |name, len| {
        let mut bytes = ZeroBytes::ABSENT;
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and `bytes` is writable.
        unsafe { zero_req_header(live.slot, name, len, 0, &mut bytes) }
    });
    cases.slot_ids(live, |slot| call(slot, b"x-dup", 0, &mut bytes));
    view_rule(live, cases, |slot| {
        let mut bytes = ZeroBytes::ABSENT;
        let name = b"x-dup";
        // SAFETY: the range is `name` and `bytes` is writable.
        unsafe { zero_req_header(slot, name.as_ptr(), name.len(), 0, &mut bytes) }
    });
    cases.case(
        Kind::Valid,
        "the second X-Dup",
        ZeroStatus::Ok,
        call(live.slot, b"X-DUP", 1, &mut bytes),
    );
    cases.case(
        Kind::Valid,
        "its value",
        ZeroStatus::Ok,
        held(view(bytes).as_deref() == Some(&b"b"[..])),
    );
    cases.case(
        Kind::Valid,
        "a third X-Dup",
        ZeroStatus::Ok,
        call(live.slot, b"x-dup", 2, &mut bytes),
    );
    cases.case(
        Kind::Valid,
        "is absent",
        ZeroStatus::Ok,
        held(view(bytes).is_none()),
    );
}

fn trailer(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, name: &[u8], out: *mut ZeroBytes| {
        // SAFETY: the range is the bytes of a slice, and every `out` a case passes is NULL,
        // misaligned or writable; the library refuses the first two before any access.
        unsafe { zero_req_trailer(slot, name.as_ptr(), name.len(), out) }
    };
    let mut bytes = ZeroBytes::ABSENT;
    cases.output("out", |out| call(live.slot, b"x-sum", out));
    cases.null_range("name", |name, len| {
        let mut bytes = ZeroBytes::ABSENT;
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and `bytes` is writable.
        unsafe { zero_req_trailer(live.slot, name, len, &mut bytes) }
    });
    cases.slot_ids(live, |slot| call(slot, b"x-sum", &mut bytes));
    view_rule(live, cases, |slot| {
        let mut bytes = ZeroBytes::ABSENT;
        let name = b"x-sum";
        // SAFETY: the range is `name` and `bytes` is writable.
        unsafe { zero_req_trailer(slot, name.as_ptr(), name.len(), &mut bytes) }
    });
    cases.case(
        Kind::Valid,
        "a trailer the request lacks",
        ZeroStatus::Ok,
        call(live.slot, b"x-sum", &mut bytes),
    );
    cases.case(
        Kind::Valid,
        "is absent",
        ZeroStatus::Ok,
        held(view(bytes).is_none()),
    );
}

fn body_retain(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, out: *mut *mut ZeroBuffer| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_req_body_retain(slot, out) }
    };
    let mut buffer = ptr::null_mut();
    cases.output("body_out", |out| call(live.slot, out));
    cases.slot_ids(live, |slot| call(slot, &mut buffer));
    let slot = live.slot;
    let elsewhere = std::thread::spawn(move || {
        let mut buffer = ptr::null_mut();
        let status = call(slot, &mut buffer);
        (
            status,
            status == ZeroStatus::Ok && take_buffer(buffer).is_empty(),
        )
    })
    .join()
    .unwrap();
    cases.case(
        Kind::View,
        "an owned copy, taken on any thread",
        ZeroStatus::Ok,
        held(elsewhere == (ZeroStatus::Ok, true)),
    );
    let status = call(live.slot, &mut buffer);
    cases.case(Kind::Valid, "the live slot", ZeroStatus::Ok, status);
    let empty = status == ZeroStatus::Ok && take_buffer(buffer).is_empty();
    cases.case(
        Kind::Handle,
        "an owned empty body",
        ZeroStatus::Ok,
        held(empty),
    );
}

fn claim(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, name: &[u8], out: *mut ZeroBytes| {
        // SAFETY: the range is the bytes of a slice, and every `out` a case passes is NULL,
        // misaligned or writable; the library refuses the first two before any access.
        unsafe { zero_req_claim(slot, name.as_ptr(), name.len(), out) }
    };
    let mut bytes = ZeroBytes::ABSENT;
    cases.output("out", |out| call(live.slot, b"sub", out));
    cases.null_range("name", |name, len| {
        let mut bytes = ZeroBytes::ABSENT;
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and `bytes` is writable.
        unsafe { zero_req_claim(live.slot, name, len, &mut bytes) }
    });
    cases.slot_ids(live, |slot| call(slot, b"sub", &mut bytes));
    cases.case(
        Kind::Valid,
        "a claim before token verification ships",
        ZeroStatus::Unsupported,
        call(live.slot, b"sub", &mut bytes),
    );
}

fn peer(live: &Live, cases: &mut Cases) {
    let call = |slot: u64, out: *mut ZeroPeer| {
        // SAFETY: every `out` a case passes is NULL, misaligned, or a writable struct of at
        // least its `size` octets; the library refuses the first two before any access.
        unsafe { zero_req_peer(slot, out) }
    };
    let empty = || ZeroPeer {
        size: u32::try_from(size_of::<ZeroPeer>()).unwrap(),
        family: 0,
        secure: 9,
        transport: 0,
        alpn: 0,
        port: 0,
        client_port: 0,
        client_family: 0,
        reserved: [0; 7],
        address: [0; 16],
        client_address: [0; 16],
    };
    cases.output("peer_out", |out| call(live.slot, out));
    let mut small = ZeroPeer { size: 4, ..empty() };
    let status = call(live.slot, &mut small);
    cases.untouched(
        "a size below version 1",
        ZeroStatus::InvalidArgument,
        status,
        small.size == 4 && small.secure == 9,
    );
    let mut out = empty();
    cases.slot_ids(live, |slot| call(slot, &mut out));
    let mut peer = empty();
    cases.case(
        Kind::Valid,
        "the live slot",
        ZeroStatus::Ok,
        call(live.slot, &mut peer),
    );
    cases.case(
        Kind::Valid,
        "a loopback peer over TCP, the client itself",
        ZeroStatus::Ok,
        held(
            peer.family == 4
                && peer.address[..4] == [127, 0, 0, 1]
                && peer.port != 0
                && peer.secure == 0
                && peer.transport == 1
                && peer.client_family == peer.family
                && peer.client_address == peer.address
                && peer.client_port == peer.port,
        ),
    );
}
