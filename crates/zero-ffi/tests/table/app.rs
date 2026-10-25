//! Apps: routes, the miss route, policies, mounts and the canonical table.

use std::ptr;

use zero_ffi::*;

use super::library::held;
use super::{Cases, Entry, Kind, Live};
use crate::support::{app_new, ok, take_buffer};

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_app_new",
            cases: new,
            placeholder: crate::placeholder_call!(unsafe zero_app_new(a)),
        },
        Entry {
            name: "zero_app_free",
            cases: free,
            placeholder: crate::placeholder_call!(zero_app_free(a)),
        },
        Entry {
            name: "zero_app_route",
            cases: route,
            placeholder: crate::placeholder_call!(unsafe zero_app_route(a, b, c, d, e, f, g, h)),
        },
        Entry {
            name: "zero_app_mount",
            cases: mount,
            placeholder: crate::placeholder_call!(unsafe zero_app_mount(a, b, c, d, e)),
        },
        Entry {
            name: "zero_app_miss",
            cases: miss,
            placeholder: crate::placeholder_call!(unsafe zero_app_miss(a, b)),
        },
        Entry {
            name: "zero_app_policy",
            cases: policy,
            placeholder: crate::placeholder_call!(unsafe zero_app_policy(a, b, c, d, e, f)),
        },
        Entry {
            name: "zero_app_table",
            cases: table,
            placeholder: crate::placeholder_call!(unsafe zero_app_table(a, b)),
        },
    ]
}

fn new(_: &Live, cases: &mut Cases) {
    let call = |out: *mut u64| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_app_new(out) }
    };
    cases.output("app_out", call);
    let mut app = 0;
    cases.case(Kind::Valid, "a new app", ZeroStatus::Ok, call(&mut app));
    ok(zero_app_free(app));
}

fn free(live: &Live, cases: &mut Cases) {
    cases.app_ids(live, |id| zero_app_free(id));
    let app = app_new();
    cases.case(
        Kind::Valid,
        "a live app",
        ZeroStatus::Ok,
        zero_app_free(app),
    );
    cases.case(
        Kind::Id,
        "an app freed twice",
        ZeroStatus::Closed,
        zero_app_free(app),
    );
}

/// Register a route with byte arguments.
fn register(
    app: u64,
    kind: u32,
    method: u8,
    pattern: &[u8],
    options: &[u8],
    out: *mut u32,
) -> ZeroStatus {
    // SAFETY: both ranges are the bytes of slices, and `out` is NULL, misaligned or a
    // writable `uint32_t`; the library refuses the first two before any access.
    unsafe {
        zero_app_route(
            app,
            kind,
            method,
            pattern.as_ptr(),
            pattern.len(),
            options.as_ptr(),
            options.len(),
            out,
        )
    }
}

fn route(live: &Live, cases: &mut Cases) {
    let app = app_new();
    let mut id = 0u32;
    let raw = |pattern: *const u8, pattern_len: usize, options: *const u8, options_len: usize| {
        let mut id = 0u32;
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or readable, and `id` is writable.
        unsafe {
            zero_app_route(
                app,
                ZERO_ROUTE_HOST,
                ZERO_METHOD_GET,
                pattern,
                pattern_len,
                options,
                options_len,
                &mut id,
            )
        }
    };
    cases.null_range("pattern", |pattern, len| raw(pattern, len, ptr::null(), 0));
    cases.null_range("options", |options, len| {
        raw(b"/a".as_ptr(), 2, options, len)
    });
    cases.output("route_out", |out| {
        register(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, b"/b", b"", out)
    });
    for kind in [6, 7, u32::MAX] {
        cases.case(
            Kind::Set,
            format!("route kind {kind}"),
            ZeroStatus::InvalidArgument,
            register(app, kind, ZERO_METHOD_GET, b"/c", b"", &mut id),
        );
    }
    for method in [9u8, 10, 100, 253, ZERO_METHOD_OTHER] {
        cases.case(
            Kind::Set,
            format!("method {method}"),
            ZeroStatus::InvalidArgument,
            register(app, ZERO_ROUTE_HOST, method, b"/c", b"", &mut id),
        );
    }
    cases.case(
        Kind::Other,
        "a pattern that is not UTF-8",
        ZeroStatus::InvalidArgument,
        register(
            app,
            ZERO_ROUTE_HOST,
            ZERO_METHOD_GET,
            b"/\xff",
            b"",
            &mut id,
        ),
    );
    cases.case(
        Kind::Other,
        "a pattern without a leading slash",
        ZeroStatus::InvalidArgument,
        register(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, b"c", b"", &mut id),
    );
    cases.case(
        Kind::Other,
        "options that are not JSON",
        ZeroStatus::Codec,
        register(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, b"/c", b"{", &mut id),
    );
    cases.case(
        Kind::Other,
        "an unknown option key",
        ZeroStatus::Codec,
        register(
            app,
            ZERO_ROUTE_HOST,
            ZERO_METHOD_GET,
            b"/c",
            br#"{"maxBodies":1}"#,
            &mut id,
        ),
    );
    cases.app_ids(live, |app| {
        register(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, b"/d", b"", &mut id)
    });
    let status = register(
        app,
        ZERO_ROUTE_HOST,
        ZERO_METHOD_ANY,
        b"/e/:id",
        br#"{"maxBody":64}"#,
        &mut id,
    );
    cases.case(
        Kind::Valid,
        "a host route for every method",
        ZeroStatus::Ok,
        status,
    );
    let status = register(
        app,
        ZERO_ROUTE_FIXED,
        ZERO_METHOD_PATCH,
        b"/f",
        br#"{"body":"f"}"#,
        &mut id,
    );
    cases.case(Kind::Valid, "a fixed PATCH route", ZeroStatus::Ok, status);
    ok(zero_app_free(app));
}

fn mount(live: &Live, cases: &mut Cases) {
    let call = |app: u64, prefix: &[u8], child: u64, out: *mut u32| {
        // SAFETY: the range is the bytes of a slice, and `out` is NULL, misaligned or a
        // writable `uint32_t`; the library refuses the first two before any access.
        unsafe { zero_app_mount(app, prefix.as_ptr(), prefix.len(), child, out) }
    };
    let parent = app_new();
    let child = app_new();
    crate::support::route(child, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/x", "");
    let mut base = 0u32;
    cases.null_range("prefix", |prefix, len| {
        let mut base = 0u32;
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and `base` is writable.
        unsafe { zero_app_mount(parent, prefix, len, child, &mut base) }
    });
    cases.output("base_out", |out| call(parent, b"/api", child, out));
    cases.app_ids(live, |app| call(app, b"/api", child, &mut base));
    cases.app_ids(live, |id| call(parent, b"/api", id, &mut base));
    cases.case(
        Kind::Other,
        "an app on itself",
        ZeroStatus::InvalidArgument,
        call(parent, b"/api", parent, &mut base),
    );
    cases.case(
        Kind::Other,
        "the root as the prefix",
        ZeroStatus::InvalidArgument,
        call(parent, b"/", child, &mut base),
    );
    crate::support::route(parent, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/p", "");
    cases.case(
        Kind::Valid,
        "a child",
        ZeroStatus::Ok,
        call(parent, b"/api", child, &mut base),
    );
    cases.case(
        Kind::Valid,
        "the child's base",
        ZeroStatus::Ok,
        held(base == 1),
    );
    cases.case(
        Kind::Id,
        "the mounted child's id",
        ZeroStatus::Closed,
        zero_app_free(child),
    );
    ok(zero_app_free(parent));
}

fn miss(live: &Live, cases: &mut Cases) {
    let call = |app: u64, out: *mut u32| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_app_miss(app, out) }
    };
    let app = app_new();
    let mut id = 0u32;
    cases.output("route_out", |out| call(app, out));
    cases.app_ids(live, |app| call(app, &mut id));
    cases.case(
        Kind::Valid,
        "the miss route",
        ZeroStatus::Ok,
        call(app, &mut id),
    );
    let first = id;
    cases.case(
        Kind::Valid,
        "the miss route again",
        ZeroStatus::Ok,
        call(app, &mut id),
    );
    cases.case(
        Kind::Valid,
        "the same id",
        ZeroStatus::Ok,
        held(first == id),
    );
    ok(zero_app_free(app));
}

fn policy(live: &Live, cases: &mut Cases) {
    let call = |app: u64, kind: u32, prefix: &[u8], options: &[u8]| {
        // SAFETY: both ranges are the bytes of slices.
        unsafe {
            zero_app_policy(
                app,
                kind,
                prefix.as_ptr(),
                prefix.len(),
                options.as_ptr(),
                options.len(),
            )
        }
    };
    let app = app_new();
    let cors = br#"{"origins":"*"}"#;
    cases.null_range("prefix", |prefix, len| {
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and the options are the bytes of a slice.
        unsafe {
            zero_app_policy(
                app,
                ZERO_POLICY_CORS,
                prefix,
                len,
                cors.as_ptr(),
                cors.len(),
            )
        }
    });
    cases.null_range("options", |options, len| {
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and the prefix is empty.
        unsafe { zero_app_policy(app, ZERO_POLICY_CORS, ptr::null(), 0, options, len) }
    });
    for kind in [5, u32::MAX] {
        cases.case(
            Kind::Set,
            format!("policy kind {kind}"),
            ZeroStatus::InvalidArgument,
            call(app, kind, b"/", cors),
        );
    }
    cases.case(
        Kind::Other,
        "options that are not JSON",
        ZeroStatus::Codec,
        call(app, ZERO_POLICY_CORS, b"/", b"["),
    );
    cases.case(
        Kind::Other,
        "a prefix that is not absolute",
        ZeroStatus::InvalidArgument,
        call(app, ZERO_POLICY_CORS, b"api", cors),
    );
    cases.app_ids(live, |app| call(app, ZERO_POLICY_CORS, b"/", cors));
    cases.case(
        Kind::Valid,
        "a CORS policy",
        ZeroStatus::Ok,
        call(app, ZERO_POLICY_CORS, b"/", cors),
    );
    let limit = br#"{"max":1024}"#;
    cases.case(
        Kind::Valid,
        "a body limit under a prefix",
        ZeroStatus::Ok,
        call(app, ZERO_POLICY_BODY_LIMIT, b"/api", limit),
    );
    ok(zero_app_free(app));
}

fn table(live: &Live, cases: &mut Cases) {
    let call = |app: u64, out: *mut *mut ZeroBuffer| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_app_table(app, out) }
    };
    let mut table = ptr::null_mut();
    cases.output("table_out", |out| call(live.app, out));
    cases.app_ids(live, |app| call(app, &mut table));
    let status = call(live.app, &mut table);
    cases.case(Kind::Valid, "the live app's table", ZeroStatus::Ok, status);
    let text = if status == ZeroStatus::Ok {
        String::from_utf8(take_buffer(table)).unwrap_or_default()
    } else {
        String::new()
    };
    cases.case(
        Kind::Valid,
        "the table names both routes",
        ZeroStatus::Ok,
        held(text.contains("route host GET /t/:p 0") && text.contains("route websocket GET /ws 1")),
    );
}
