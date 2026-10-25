//! Servers: build, TLS, the table check, start, address, workers, shutdown, wait,
//! statistics and free.

use std::mem::size_of;
use std::ptr;

use zero_ffi::*;

use super::library::held;
use super::{Cases, Entry, Kind, Live, SENTINEL_WORD};
use crate::support::{app_new, ok, server_new, take_string};

pub fn entries() -> Vec<Entry> {
    vec![
        Entry {
            name: "zero_server_new",
            cases: new,
            placeholder: crate::placeholder_call!(unsafe zero_server_new(a, b, c, d)),
        },
        Entry {
            name: "zero_server_tls",
            cases: tls,
            placeholder: crate::placeholder_call!(unsafe zero_server_tls(a, b, c, d, e, f, g)),
        },
        Entry {
            name: "zero_server_check_table",
            cases: check_table,
            placeholder: crate::placeholder_call!(zero_server_check_table(a, b)),
        },
        Entry {
            name: "zero_server_start",
            cases: start,
            placeholder: crate::placeholder_call!(zero_server_start(a)),
        },
        Entry {
            name: "zero_server_address",
            cases: address,
            placeholder: crate::placeholder_call!(unsafe zero_server_address(a, b)),
        },
        Entry {
            name: "zero_server_workers",
            cases: workers,
            placeholder: crate::placeholder_call!(unsafe zero_server_workers(a, b, c, d)),
        },
        Entry {
            name: "zero_server_shutdown",
            cases: shutdown,
            placeholder: crate::placeholder_call!(zero_server_shutdown(a, b)),
        },
        Entry {
            name: "zero_server_wait",
            cases: wait,
            placeholder: crate::placeholder_call!(zero_server_wait(a, b)),
        },
        Entry {
            name: "zero_server_stats",
            cases: stats,
            placeholder: crate::placeholder_call!(unsafe zero_server_stats(a, b)),
        },
        Entry {
            name: "zero_server_free",
            cases: free,
            placeholder: crate::placeholder_call!(zero_server_free(a)),
        },
    ]
}

/// Build a server with byte options.
fn build(app: u64, options: &[u8], out: *mut u64) -> ZeroStatus {
    // SAFETY: the range is the bytes of a slice, and `out` is NULL, misaligned or a
    // writable `uint64_t`; the library refuses the first two before any access.
    unsafe { zero_server_new(app, options.as_ptr(), options.len(), out) }
}

/// A server of the live app that never starts.
fn idle(live: &Live) -> u64 {
    server_new(live.app, r#"{"threads":1}"#)
}

fn new(live: &Live, cases: &mut Cases) {
    let mut server = 0u64;
    cases.output("server_out", |out| build(live.app, b"{}", out));
    cases.null_range("options", |options, len| {
        let mut server = 0u64;
        // SAFETY: the range is NULL with a length, which the library refuses before any
        // access, and `server` is writable.
        unsafe { zero_server_new(live.app, options, len, &mut server) }
    });
    cases.case(
        Kind::Other,
        "options that are not JSON",
        ZeroStatus::Codec,
        build(live.app, b"[", &mut server),
    );
    cases.case(
        Kind::Other,
        "an unknown option key",
        ZeroStatus::Codec,
        build(live.app, br#"{"thread":1}"#, &mut server),
    );
    cases.case(
        Kind::Other,
        "a batch size of 0",
        ZeroStatus::Codec,
        build(live.app, br#"{"maxBatchSize":0}"#, &mut server),
    );
    cases.case(
        Kind::Other,
        "a lease timeout other than the request total",
        ZeroStatus::InvalidArgument,
        build(
            live.app,
            br#"{"limits":{"leaseTimeoutMs":1000}}"#,
            &mut server,
        ),
    );
    cases.app_ids(live, |app| build(app, br#"{"threads":1}"#, &mut server));
    let status = build(live.app, br#"{"threads":1}"#, &mut server);
    cases.case(Kind::Valid, "a server", ZeroStatus::Ok, status);
    if status == ZeroStatus::Ok {
        ok(zero_server_free(server));
    }
}

fn tls(live: &Live, cases: &mut Cases) {
    let call = |server: u64, chain: &[u8], key: &[u8], options: &[u8]| {
        // SAFETY: every range is the bytes of a slice.
        unsafe {
            zero_server_tls(
                server,
                chain.as_ptr(),
                chain.len(),
                key.as_ptr(),
                key.len(),
                options.as_ptr(),
                options.len(),
            )
        }
    };
    let raw = |chain: *const u8, chain_len: usize, key: *const u8, key_len: usize| {
        // SAFETY: every range a case passes is NULL with a length, which the library refuses
        // before any access, or readable.
        unsafe { zero_server_tls(live.server, chain, chain_len, key, key_len, ptr::null(), 0) }
    };
    let pem = b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    cases.null_range("cert_chain_pem", |chain, len| {
        raw(chain, len, pem.as_ptr(), pem.len())
    });
    cases.null_range("key_pem", |key, len| raw(pem.as_ptr(), pem.len(), key, len));
    cases.null_range("options", |options, len| {
        // SAFETY: the options range is NULL with a length, which the library refuses before
        // any access, and the others are the bytes of a slice.
        unsafe {
            zero_server_tls(
                live.server,
                pem.as_ptr(),
                pem.len(),
                pem.as_ptr(),
                pem.len(),
                options,
                len,
            )
        }
    });
    cases.server_ids(live, |server| call(server, pem, pem, b""));
    cases.case(
        Kind::Other,
        "a running server",
        ZeroStatus::InvalidArgument,
        call(live.server, pem, pem, b""),
    );
    let server = idle(live);
    cases.case(
        Kind::Other,
        "material that is not a certificate and a key",
        ZeroStatus::Io,
        call(server, pem, pem, b""),
    );
    cases.case(
        Kind::Other,
        "TLS options that are not JSON",
        ZeroStatus::Codec,
        call(server, pem, pem, b"{"),
    );
    ok(zero_server_free(server));
}

fn check_table(live: &Live, cases: &mut Cases) {
    cases.server_ids(live, |server| zero_server_check_table(server, live.app));
    cases.app_ids(live, |app| zero_server_check_table(live.server, app));
    let other = app_new();
    cases.case(
        Kind::Other,
        "an app with other routes",
        ZeroStatus::InvalidArgument,
        zero_server_check_table(live.server, other),
    );
    ok(zero_app_free(other));
    cases.case(
        Kind::Valid,
        "the server's own app",
        ZeroStatus::Ok,
        zero_server_check_table(live.server, live.app),
    );
}

fn start(live: &Live, cases: &mut Cases) {
    cases.server_ids(live, |id| zero_server_start(id));
    cases.case(
        Kind::Other,
        "a running server",
        ZeroStatus::InvalidArgument,
        zero_server_start(live.server),
    );
}

fn address(live: &Live, cases: &mut Cases) {
    let call = |server: u64, out: *mut *mut ZeroString| {
        // SAFETY: every `out` a case passes is NULL, misaligned or writable, and the
        // library refuses the first two before any access.
        unsafe { zero_server_address(server, out) }
    };
    let mut string = ptr::null_mut();
    cases.output("address_out", |out| call(live.server, out));
    cases.server_ids(live, |server| call(server, &mut string));
    let server = idle(live);
    cases.case(
        Kind::Other,
        "a server that has not started",
        ZeroStatus::Closed,
        call(server, &mut string),
    );
    ok(zero_server_free(server));
    let status = call(live.server, &mut string);
    cases.case(Kind::Valid, "the live server", ZeroStatus::Ok, status);
    let text = if status == ZeroStatus::Ok {
        take_string(string).unwrap_or_default()
    } else {
        String::new()
    };
    cases.case(
        Kind::Valid,
        "the address it listens on",
        ZeroStatus::Ok,
        held(text.parse::<std::net::SocketAddr>().ok() == Some(live.address)),
    );
}

fn workers(live: &Live, cases: &mut Cases) {
    let call = |server: u64, workers: *mut u8, cap: usize, count: *mut usize| {
        // SAFETY: every array a case passes holds `cap` writable octets or is NULL, and
        // every `count` is NULL, misaligned or writable; the library refuses those first.
        unsafe { zero_server_workers(server, workers, cap, count) }
    };
    let mut indexes = [0u8; 8];
    let mut count = 0usize;
    cases.output("count_out", |out| {
        call(live.server, indexes.as_mut_ptr(), 8, out)
    });
    cases.case(
        Kind::Pointer,
        "workers_out NULL with a capacity",
        ZeroStatus::InvalidArgument,
        call(live.server, ptr::null_mut(), 1, &mut count),
    );
    cases.server_ids(live, |server| {
        call(server, indexes.as_mut_ptr(), 8, &mut count)
    });
    count = 0;
    let status = call(live.server, ptr::null_mut(), 0, &mut count);
    cases.case(Kind::Other, "a capacity of 0", ZeroStatus::Limit, status);
    cases.case(
        Kind::Other,
        "the full count with Limit",
        ZeroStatus::Ok,
        held(count == 1),
    );
    let status = call(live.server, indexes.as_mut_ptr(), indexes.len(), &mut count);
    cases.case(
        Kind::Valid,
        "the live server's index",
        ZeroStatus::Ok,
        status,
    );
    cases.case(
        Kind::Valid,
        "one index, the live one",
        ZeroStatus::Ok,
        held(count == 1 && indexes[0] == live.worker),
    );
}

fn shutdown(live: &Live, cases: &mut Cases) {
    cases.server_ids(live, |server| zero_server_shutdown(server, ZERO_NONE));
    let server = idle(live);
    cases.case(
        Kind::Other,
        "a drain shorter than drainMs",
        ZeroStatus::Unsupported,
        zero_server_shutdown(server, 0),
    );
    cases.case(
        Kind::Valid,
        "a server that never started",
        ZeroStatus::Ok,
        zero_server_shutdown(server, ZERO_NONE),
    );
    cases.case(
        Kind::Valid,
        "a stopped server waits at once",
        ZeroStatus::Ok,
        zero_server_wait(server, 0),
    );
    ok(zero_server_free(server));
}

fn wait(live: &Live, cases: &mut Cases) {
    cases.server_ids(live, |server| zero_server_wait(server, 0));
    cases.case(
        Kind::Thread,
        "a wait on the thread bound to the server's target",
        ZeroStatus::InvalidArgument,
        zero_server_wait(live.server, 0),
    );
    let server = idle(live);
    cases.case(
        Kind::Other,
        "a server that has not stopped",
        ZeroStatus::Timeout,
        zero_server_wait(server, 0),
    );
    ok(zero_server_shutdown(server, ZERO_NONE));
    cases.case(
        Kind::Valid,
        "a stopped server",
        ZeroStatus::Ok,
        zero_server_wait(server, ZERO_NONE),
    );
    ok(zero_server_free(server));
}

fn stats(live: &Live, cases: &mut Cases) {
    let call = |server: u64, out: *mut ZeroStats| {
        // SAFETY: every `out` a case passes is NULL, misaligned, or a writable struct of
        // at least its `size` octets; the library refuses the first two before any access.
        unsafe { zero_server_stats(server, out) }
    };
    let sized = || ZeroStats {
        size: u32::try_from(size_of::<ZeroStats>()).unwrap(),
        ..ZeroStats::default()
    };
    cases.output("stats_out", |out| call(live.server, out));
    let mut small = ZeroStats {
        size: 8,
        dispatched: SENTINEL_WORD,
        ..ZeroStats::default()
    };
    let status = call(live.server, &mut small);
    cases.untouched(
        "a size below version 1",
        ZeroStatus::InvalidArgument,
        status,
        small.size == 8 && small.dispatched == SENTINEL_WORD,
    );
    let mut stats = sized();
    cases.server_ids(live, |server| call(server, &mut stats));
    let mut stats = sized();
    let status = call(live.server, &mut stats);
    cases.case(Kind::Valid, "the live server", ZeroStatus::Ok, status);
    cases.case(
        Kind::Valid,
        "every octet written and the batches counted",
        ZeroStatus::Ok,
        held(usize::try_from(stats.size).unwrap() == size_of::<ZeroStats>() && stats.batches >= 11),
    );
}

fn free(live: &Live, cases: &mut Cases) {
    cases.server_ids(live, |id| zero_server_free(id));
    cases.case(
        Kind::Other,
        "a running server",
        ZeroStatus::Limit,
        zero_server_free(live.server),
    );
    let server = idle(live);
    cases.case(
        Kind::Valid,
        "a server that never started",
        ZeroStatus::Ok,
        zero_server_free(server),
    );
    cases.case(
        Kind::Id,
        "a server freed twice",
        ZeroStatus::Closed,
        zero_server_free(server),
    );
}
