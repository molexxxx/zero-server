//! The table-driven test over the header: every prototype of `include/zero.h` has an
//! entry, and every entry runs its cases against one real server started through the C
//! ABI, whose slots the test thread genuinely leased. Each named test runs the table and
//! checks its own kind of case; the full test checks them all.

#![cfg(not(miri))]
#![allow(unsafe_code)]

mod support;
#[path = "table/mod.rs"]
mod table;

use std::collections::BTreeSet;
use std::ffi::c_char;
use std::mem::size_of;

use support::{
    app_new, attach, complete, ok, poll_batch, route, server_new, stop, workers, Client,
};
use table::{assert_cases, entries, prototypes, run, Check, Kind, Live, Outcome};
use zero_ffi::*;

/// The committed header.
fn header() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/include/zero.h"))
        .expect("the header")
}

/// Start the live fixture and run every entry's cases against it.
fn run_table() -> (Live, Vec<Check>) {
    let live = Live::start();
    let checks = run(&live, &entries());
    (live, checks)
}

/// The pins the live server counts.
fn pinned(server: u64) -> u64 {
    let mut stats = ZeroStats {
        size: u32::try_from(size_of::<ZeroStats>()).unwrap(),
        ..ZeroStats::default()
    };
    // SAFETY: `stats` is a writable struct of its own size.
    ok(unsafe { zero_server_stats(server, &mut stats) });
    stats.pinned
}

#[test]
fn every_prototype_in_the_header_has_cases_and_each_returns_its_status() {
    let declared: BTreeSet<String> = prototypes(&header()).into_iter().collect();
    let listed: BTreeSet<String> = entries()
        .iter()
        .map(|entry| entry.name.to_owned())
        .collect();
    let missing: Vec<&String> = declared.difference(&listed).collect();
    let extra: Vec<&String> = listed.difference(&declared).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "prototypes without cases: {missing:?}; cases without a prototype: {extra:?}"
    );
    let (live, checks) = run_table();
    assert_cases(&checks, &[]);
    live.finish();
}

/// ANSSI FFI-NOPANIC: every export catches a panic and returns `ZeroStatus_Panic`, or NULL
/// or 0 for the value-returning ones, and the next call on the thread works; no pin
/// leaks.
#[test]
fn every_export_returns_panic_instead_of_unwinding() {
    let (live, checks) = run_table();
    assert_cases(&checks, &[Kind::Valid]);
    let before = pinned(live.server);
    let mut failed = Vec::new();
    for entry in entries() {
        zero_host::testing::panic_next_call();
        let outcome = (entry.placeholder)();
        let contained = matches!(
            outcome,
            Outcome::Status(ZeroStatus::Panic)
                | Outcome::Null(true)
                | Outcome::Number(0)
                | Outcome::Unit
        );
        let recorded = support::last_error().starts_with("the call panicked");
        let next = zero_abi_version() == ZERO_ABI_VERSION;
        if !(contained && recorded && next) {
            failed.push(format!(
                "{}: {outcome:?}, recorded {recorded}, next call {next}",
                entry.name
            ));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
    assert_eq!(pinned(live.server), before, "a pin leaked");
    live.finish();
}

/// The Rust Reference: a panic that reached a non-unwinding `extern "C"` boundary would
/// abort the process. Exports called through `extern "C"` function pointers, as a host
/// calls them, from several threads at once, each with a panic armed, all return, and the
/// process lives on.
#[test]
fn a_panic_never_crosses_an_extern_c_boundary() {
    let by_id: [extern "C" fn(u64) -> ZeroStatus; 6] = [
        zero_app_free,
        zero_server_start,
        zero_target_wake,
        zero_slot_pin,
        zero_res_send,
        zero_sse_close,
    ];
    let threads: Vec<_> = (0..4)
        .map(|_| {
            std::thread::spawn(move || {
                for export in by_id {
                    zero_host::testing::panic_next_call();
                    assert_eq!(export(1), ZeroStatus::Panic);
                    assert!(support::last_error().contains("armed to panic"));
                }
                let version: extern "C" fn() -> *const c_char = zero_version;
                zero_host::testing::panic_next_call();
                assert!(version().is_null());
                let abi: extern "C" fn() -> u32 = zero_abi_version;
                zero_host::testing::panic_next_call();
                assert_eq!(abi(), 0);
                abi()
            })
        })
        .collect();
    for thread in threads {
        assert_eq!(
            thread.join().expect("the thread returned"),
            ZERO_ABI_VERSION
        );
    }
}

/// ANSSI FFI-NOENUM: every closed-set input arrives as an integer, and a value outside the
/// set returns `ZeroStatus_InvalidArgument`.
#[test]
fn closed_set_inputs_out_of_range_return_invalid_argument() {
    let (live, checks) = run_table();
    assert_cases(&checks, &[Kind::Set]);
    for code in [-1, 11, i32::MAX, i32::MIN] {
        assert_eq!(ZeroStatus::from_code(code), None, "status {code}");
    }
    for code in 0..=10 {
        assert_eq!(
            ZeroStatus::from_code(code).map(|status| status as i32),
            Some(code)
        );
    }
    live.finish();
}

/// ANSSI FFI-CK-PTR-VALID: a NULL or misaligned pointer, a NULL range with a length, and a
/// size below version 1 are refused with `ZeroStatus_InvalidArgument`, and nothing is
/// written.
#[test]
fn null_and_misaligned_pointers_are_refused_and_nothing_is_written() {
    let (live, checks) = run_table();
    assert_cases(&checks, &[Kind::Pointer]);
    live.finish();
}

/// ANSSI FFI-MEM-OWNER: an owned string or buffer is released only by its free function,
/// and NULL is no handle to every function over them.
#[test]
fn every_owned_handle_is_released_only_by_its_free_function() {
    let (live, checks) = run_table();
    assert_cases(&checks, &[Kind::Handle]);
    for _ in 0..64 {
        let mut table = std::ptr::null_mut();
        // SAFETY: `table` is a writable pointer.
        ok(unsafe { zero_app_table(live.app, &mut table) });
        // SAFETY: `table` is a live buffer and is freed once.
        unsafe { zero_buffer_free(table) };
    }
    live.finish();
}

/// ANSSI FFI-CK-REF-MODEL: a view is handed only to a thread that pins the slot or is the
/// slot's target thread inside the delivering batch, and the memory it points to is not
/// written while it is valid.
#[test]
fn a_view_is_refused_without_a_pin_outside_its_batch_window() {
    let (live, checks) = run_table();
    assert_cases(&checks, &[Kind::View]);
    let mut path = ZeroBytes::ABSENT;
    // SAFETY: `path` is a writable `ZeroBytes`.
    ok(unsafe { zero_req_path(live.slot, &mut path) });
    let before = support::view(path);
    let body = vec![b'w'; 4096];
    for _ in 0..8 {
        // SAFETY: the range is `body`.
        ok(unsafe { zero_res_body_copy(live.slot, body.as_ptr(), body.len()) });
        ok(table::res_write_header(live.slot, b"X-Write", b"1"));
    }
    assert_eq!(
        support::view(path),
        before,
        "the view changed while it was valid"
    );
    assert_eq!(before.as_deref(), Some(&b"/t/live"[..]));
    live.finish();
}

/// RFC 9110 Section 5.5: "Field values containing CR, LF, or NUL characters are invalid
/// and dangerous." Through the C ABI a field value holding any of them is refused, by
/// each call that writes a field line, and none of it reaches the wire.
#[test]
fn a_field_value_with_cr_lf_or_nul_is_refused_through_the_c_abi() {
    let (live, checks) = run_table();
    assert_cases(&checks, &[Kind::Field]);
    live.finish();

    let app = app_new();
    route(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/split", "");
    let server = server_new(app, r#"{"threads":1}"#);
    let worker = workers(server)[0];
    let target = attach(server, u32::from(worker));
    ok(zero_server_start(server));
    let mut client = Client::connect(support::address(server));
    client.send(b"GET /split HTTP/1.1\r\nHost: t\r\n\r\n");
    let polled = poll_batch(target);
    let slot = polled.slots[0];
    for byte in [b'\r', b'\n', 0u8] {
        let value = [b'a', byte, b'X', b'-', b'I', b'n', b':', b' ', b'1'];
        let name = b"X-Split";
        // SAFETY: both ranges are the bytes of arrays.
        let by_name = unsafe {
            zero_res_header(
                slot,
                name.as_ptr(),
                name.len(),
                value.as_ptr(),
                value.len(),
                ZERO_HEADER_APPEND,
            )
        };
        assert_eq!(by_name, ZeroStatus::InvalidArgument, "by name, byte {byte}");
        // SAFETY: the range is the bytes of an array.
        let by_id = unsafe {
            zero_res_header_id(
                slot,
                ZERO_HEADER_LOCATION,
                value.as_ptr(),
                value.len(),
                ZERO_HEADER_SET,
            )
        };
        assert_eq!(by_id, ZeroStatus::InvalidArgument, "by id, byte {byte}");
        // SAFETY: the ranges are the bytes of arrays.
        let checked =
            unsafe { zero_field_validate(name.as_ptr(), name.len(), value.as_ptr(), value.len()) };
        assert_eq!(
            checked,
            ZeroStatus::InvalidArgument,
            "validated, byte {byte}"
        );
    }
    ok(table::res_write_header(slot, b"X-Kept", b"yes"));
    ok(zero_res_send(slot));
    let (status, results) = complete(worker, &[slot], polled.batch.epoch);
    ok(status);
    assert_eq!(results, [ZeroStatus::Ok]);
    let reply = client.read().expect("the reply");
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("x-kept"), Some("yes"));
    assert!(reply.header("x-split").is_none());
    assert!(reply.header("x-in").is_none());
    assert!(reply.header("location").is_none());
    ok(zero_target_detach(target));
    stop(server);
    ok(zero_app_free(app));
}
