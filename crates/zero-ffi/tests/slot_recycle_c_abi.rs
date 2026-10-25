//! The race test of slot reuse through the C exports, for ThreadSanitizer and
//! AddressSanitizer: views and pins race the retirement and reuse of the indexes they
//! name.
//!
//! One server with one core answers `GET /t0` in Rust and leases `GET /t3/:n` to the
//! host. H1 polls the pull target, so it is the bound thread: it reads each leased
//! request through `zero_req_view`, `zero_req_param` and `zero_req_header` inside the
//! batch window, echoes its `X-Seq` field through `zero_res_respond`, and completes the
//! batch with its epoch; every seventh slot goes to H2 instead, which pins it, answers it,
//! unpins it and completes it later with `ZERO_EPOCH_NONE`. H3 keeps the last 512 ids
//! answered and loops over them, pinning, reading the field through a view and unpinning,
//! accepting `Closed` and checking that every read that succeeds returns the value
//! recorded for its id. Four clients send 2,000 requests each over keep-alive
//! connections, alternating the two routes in pipelined pairs, and drop one connection
//! in ten once a pair is sent. Every wait is on a response, a channel, a poll or a join.

#![cfg(not(miri))]
#![allow(unsafe_code)]

mod support;

use std::collections::VecDeque;
use std::mem::size_of;
use std::net::SocketAddr;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use support::{
    address, app_new, attach, complete, ok, poll, route, server_new, view, workers, Client,
};
use zero_ffi::*;

/// The client threads.
const CLIENTS: usize = 4;

/// The pipelined pairs each client sends: 2,000 requests.
const PAIRS: usize = 1_000;

/// How many answered ids the late reader keeps.
const KEPT: usize = 512;

/// The ids answered and the `X-Seq` each one's request carried, the newest last.
type Answered = Arc<Mutex<VecDeque<(u64, Vec<u8>)>>>;

fn record(answered: &Answered, id: u64, seq: Vec<u8>) {
    let mut answered = answered.lock().unwrap();
    if answered.len() == KEPT {
        answered.pop_front();
    }
    answered.push_back((id, seq));
}

/// A refusal a host thread accepts: the lease ended, or the index moved on.
#[track_caller]
fn closed(status: ZeroStatus) {
    assert_eq!(status, ZeroStatus::Closed, "{}", support::last_error());
}

/// A field of a request through a view: the status and the bytes.
fn field(slot: u64, name: &[u8]) -> (ZeroStatus, Option<Vec<u8>>) {
    let mut bytes = ZeroBytes::ABSENT;
    // SAFETY: the range is `name` and `bytes` is a writable `ZeroBytes`.
    let status = unsafe { zero_req_header(slot, name.as_ptr(), name.len(), 0, &mut bytes) };
    (
        status,
        (status == ZeroStatus::Ok).then(|| view(bytes)).flatten(),
    )
}

/// Read a leased request as a thread the view rule admits, and answer it; the `X-Seq`
/// value, or `None` when the lease ended meanwhile.
fn answer(slot: u64, route: u32) -> Option<Vec<u8>> {
    let mut request = ZeroRequestView {
        size: u32::try_from(size_of::<ZeroRequestView>()).unwrap(),
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
    };
    // SAFETY: `request` is a writable struct of its own size.
    match unsafe { zero_req_view(slot, &mut request) } {
        ZeroStatus::Ok => assert_eq!(
            (request.route, request.param_count),
            (route, 1),
            "slot {slot}"
        ),
        status => closed(status),
    }
    let mut param = ZeroBytes::ABSENT;
    // SAFETY: `param` is a writable `ZeroBytes`.
    let status = unsafe { zero_req_param(slot, 0, &mut param) };
    if status != ZeroStatus::Ok {
        closed(status);
        return None;
    }
    let param = view(param).unwrap_or_default();
    let (status, seq) = field(slot, b"x-seq");
    if status != ZeroStatus::Ok {
        closed(status);
        return None;
    }
    let seq = seq.unwrap_or_default();
    let body = format!(
        "n={};seq={}",
        String::from_utf8_lossy(&param),
        String::from_utf8_lossy(&seq)
    );
    let spec = ZeroResponseSpec {
        size: u32::try_from(size_of::<ZeroResponseSpec>()).unwrap(),
        status: 200,
        reserved: 0,
        field_size: u32::try_from(size_of::<ZeroHeaderPair>()).unwrap(),
        reserved2: 0,
        fields: ptr::null(),
        field_count: 0,
        body: ZeroBytes {
            ptr: body.as_ptr(),
            len: body.len(),
        },
    };
    // SAFETY: `spec` is a readable struct of its size whose body range is `body`.
    let status = unsafe { zero_res_respond(slot, &spec) };
    if status != ZeroStatus::Ok {
        closed(status);
        return None;
    }
    Some(seq)
}

/// H1: polls the target, so it is bound to it; answers each batch's slots, hands every
/// seventh to H2, and acknowledges the batch, until the target is detached.
fn bound_host(target: u64, worker: u8, route: u32, later: &Sender<u64>, answered: &Answered) {
    let mut seen = 0usize;
    loop {
        let polled = match poll(target, 1_000) {
            Ok(polled) => polled,
            Err(ZeroStatus::Timeout) => continue,
            Err(status) => {
                closed(status);
                return;
            }
        };
        let mut handled = Vec::with_capacity(polled.slots.len());
        for &slot in &polled.slots {
            seen += 1;
            if seen.is_multiple_of(7) {
                let _ = later.send(slot);
                continue;
            }
            if let Some(seq) = answer(slot, route) {
                record(answered, slot, seq);
            }
            handled.push(slot);
        }
        let _ = complete(worker, &handled, polled.batch.epoch);
    }
}

/// H2: pins each slot it is handed, answers it and completes it with no
/// acknowledgment.
fn later_host(worker: u8, route: u32, ids: &Receiver<u64>, answered: &Answered) {
    for slot in ids {
        match zero_slot_pin(slot) {
            ZeroStatus::Ok => {
                let seq = answer(slot, route);
                ok(zero_slot_unpin(slot));
                if let Some(seq) = seq {
                    record(answered, slot, seq);
                }
            }
            status => closed(status),
        }
        let _ = complete(worker, &[slot], ZERO_EPOCH_NONE);
    }
}

/// H3: loops over the last answered ids until `done`, pinning each and reading its field
/// through a view; every read that succeeds must return the value recorded for its id.
/// Returns how many reads succeeded.
fn late_reader(answered: &Answered, done: &AtomicBool) -> usize {
    let mut succeeded = 0;
    while !done.load(Ordering::Acquire) {
        let window: Vec<(u64, Vec<u8>)> = answered.lock().unwrap().iter().cloned().collect();
        if window.is_empty() {
            thread::yield_now();
        }
        for (slot, recorded) in &window {
            match zero_slot_pin(*slot) {
                ZeroStatus::Ok => {}
                status => {
                    closed(status);
                    continue;
                }
            }
            match field(*slot, b"x-seq") {
                (ZeroStatus::Ok, seen) => {
                    assert_eq!(seen.as_ref(), Some(recorded), "slot {slot} through a pin");
                    succeeded += 1;
                }
                (status, _) => closed(status),
            }
            ok(zero_slot_unpin(*slot));
        }
    }
    succeeded
}

/// A deterministic generator of sequence values and choices: xorshift64.
struct Draws(u64);

impl Draws {
    fn next(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value
    }
}

/// One client: `PAIRS` pipelined pairs of `/t0` and `/t3/<n>`, checking every answer it
/// reads, and one connection in ten dropped once its pair is sent.
fn client(address: SocketAddr, index: usize) -> usize {
    let mut draws = Draws(0x9E37_79B9_7F4A_7C15 ^ (index as u64 + 1));
    let mut client = Client::connect(address);
    let mut dropped = 0;
    for pair in 0..PAIRS {
        let item = index * PAIRS + pair;
        let seq = format!("{:016x}", draws.next());
        let leased = format!("GET /t3/{item} HTTP/1.1\r\nHost: t\r\nX-Seq: {seq}\r\n\r\n");
        let fixed = "GET /t0 HTTP/1.1\r\nHost: t\r\n\r\n";
        let order = if pair % 2 == 0 {
            [fixed, leased.as_str()]
        } else {
            [leased.as_str(), fixed]
        };
        client.send(order.concat().as_bytes());
        if draws.next().is_multiple_of(10) {
            client = Client::connect(address);
            dropped += 1;
            continue;
        }
        for request in order {
            let reply = client.read().unwrap();
            assert_eq!(reply.status, 200, "{request}");
            if request == fixed {
                assert_eq!(reply.text(), "fixed body");
            } else {
                assert_eq!(reply.text(), format!("n={item};seq={seq}"));
            }
        }
    }
    dropped
}

#[test]
#[ignore = "a race test for ThreadSanitizer, run with --include-ignored slot_recycle"]
fn slot_recycle_c_abi_views_race_reuse_through_the_exports() {
    let app = app_new();
    route(
        app,
        ZERO_ROUTE_FIXED,
        ZERO_METHOD_GET,
        "/t0",
        r#"{"body":"fixed body"}"#,
    );
    let route = route(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/t3/:n", "");
    let server = server_new(app, r#"{"threads":1}"#);
    let worker = workers(server)[0];
    let target = attach(server, u32::from(worker));
    ok(zero_server_start(server));
    let address = address(server);

    let answered: Answered = Arc::default();
    let done = Arc::new(AtomicBool::new(false));
    let (later, handed) = mpsc::channel();
    let bound = {
        let answered = Arc::clone(&answered);
        thread::spawn(move || bound_host(target, worker, route, &later, &answered))
    };
    let delayed = {
        let answered = Arc::clone(&answered);
        thread::spawn(move || later_host(worker, route, &handed, &answered))
    };
    let reader = {
        let answered = Arc::clone(&answered);
        let done = Arc::clone(&done);
        thread::spawn(move || late_reader(&answered, &done))
    };
    let clients: Vec<_> = (0..CLIENTS)
        .map(|index| thread::spawn(move || client(address, index)))
        .collect();
    let dropped: usize = clients
        .into_iter()
        .map(|client| client.join().unwrap())
        .sum();
    done.store(true, Ordering::Release);
    let reads = reader.join().unwrap();

    ok(zero_target_detach(target));
    bound.join().unwrap();
    delayed.join().unwrap();
    ok(zero_server_shutdown(server, ZERO_NONE));
    ok(zero_server_wait(server, 60_000));
    let mut stats = ZeroStats {
        size: u32::try_from(size_of::<ZeroStats>()).unwrap(),
        ..ZeroStats::default()
    };
    // SAFETY: `stats` is a writable struct of its own size.
    ok(unsafe { zero_server_stats(server, &mut stats) });
    assert_eq!((stats.leased, stats.pinned, stats.panics), (0, 0, 0));
    assert_eq!(zero_host::testing::live_slots(worker), Some(0));
    ok(zero_server_free(server));
    ok(zero_app_free(app));
    eprintln!(
        "late_readers {}, late reader's successful reads {reads}, connections dropped {dropped}",
        stats.late_readers
    );
}
