//! The race test of slot reuse on one core, for ThreadSanitizer: tier 0 and tier 3
//! requests share one core while host threads read leased slots through the access
//! helpers from the target's thread, from a thread that answers later, and from a
//! thread that keeps reading ids after their requests finished, so reads race the
//! retirement and the reuse of the indexes they name.
//!
//! One server with one core answers `GET /t0` in Rust and leases `GET /t3/:n` to the
//! host. The target forwards each batch to H1, the thread bound to it, which reads the
//! parameter and the `X-Nonce` field through the access helpers, answers
//! `n=<n>;nonce=<nonce>` and acknowledges the batch; every seventh slot goes to H2
//! instead, which pins it, answers it and completes it later without an
//! acknowledgment. H3 keeps the last 512 ids answered and loops over them, reading
//! under the lock, pinning, reading the pinned view and unpinning, accepting `Closed`
//! and checking that every read that succeeds returns the nonce recorded for its id.
//! Four clients send 2,000 requests each over keep-alive connections, alternating the
//! two routes in pipelined pairs with random nonces, and drop one connection in ten
//! once a pair is sent, which leaves leases to close and completions to arrive for
//! closed slots. Every wait is on a response, a channel or a join.

mod support;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use support::Client;
use zero_host::access::{self, Access};
use zero_host::{
    bind_thread, complete, read_batch, App, BatchRef, Event, Method, Post, RouteKind, Server,
    ServerOptions, Status, Target, MAX_BATCH,
};
use zero_http::Exchange;

/// The client threads.
const CLIENTS: usize = 4;

/// The pipelined pairs each client sends: 2,000 requests.
const PAIRS: usize = 1_000;

/// How many answered ids the late reader keeps.
const KEPT: usize = 512;

/// The body of `GET /t0`.
const FIXED: &str = "fixed body";

/// No field lines.
const NONE: [(&[u8], &[u8]); 0] = [];

/// Hands each batch to the thread bound to the target.
struct Forward(Mutex<Sender<BatchRef>>);

impl Target for Forward {
    fn post(&self, batch: BatchRef) -> Post {
        match self.0.lock().unwrap().send(batch) {
            Ok(()) => Post::Taken,
            Err(_) => Post::Gone,
        }
    }
}

/// The ids answered and the nonce each one's request carried, the newest last.
type Answered = Arc<Mutex<VecDeque<(u64, Vec<u8>)>>>;

fn record(answered: &Answered, id: u64, nonce: Vec<u8>) {
    let mut answered = answered.lock().unwrap();
    if answered.len() == KEPT {
        answered.pop_front();
    }
    answered.push_back((id, nonce));
}

/// A refusal a host thread accepts: the lease closed, or the index moved on.
fn closed(refusal: Access) {
    assert_eq!(refusal.status(), Status::Closed, "{refusal}");
}

/// The route parameter and the nonce of a request.
fn parameter_and_nonce(exchange: &Exchange) -> (Vec<u8>, Vec<u8>) {
    let request = exchange.request();
    (
        request.param(0).map(<[u8]>::to_vec).unwrap_or_default(),
        request
            .header(b"x-nonce")
            .map(<[u8]>::to_vec)
            .unwrap_or_default(),
    )
}

/// The nonce of a request.
fn nonce(exchange: &Exchange) -> Option<Vec<u8>> {
    exchange.request().header(b"x-nonce").map(<[u8]>::to_vec)
}

/// Read a leased request through the view and the lock, as a thread the view rule
/// admits, and answer it; the nonce, or `None` when the lease closed meanwhile.
fn answer(id: u64, route: u32) -> Option<Vec<u8>> {
    match access::with_view(id, |view| (view.route, view.param_count)) {
        Ok(values) => assert_eq!(values, (route, 1), "slot {id}"),
        Err(refusal) => closed(refusal),
    }
    let (parameter, nonce) = access::with_pinned_read(id, parameter_and_nonce)
        .map_err(closed)
        .ok()?;
    let body = format!(
        "n={};nonce={}",
        String::from_utf8_lossy(&parameter),
        String::from_utf8_lossy(&nonce)
    );
    access::respond(id, 200, NONE, body.as_bytes())
        .map_err(closed)
        .ok()?;
    Some(nonce)
}

/// H1: bound to the target, it answers each batch's slots, hands every seventh to H2,
/// and acknowledges the batch, until the target is dropped.
fn bound_host(
    worker: u8,
    route: u32,
    batches: &Receiver<BatchRef>,
    later: &Sender<u64>,
    answered: &Answered,
) {
    bind_thread(worker).unwrap();
    let mut slots = vec![0u64; MAX_BATCH];
    let mut routes = vec![0u32; MAX_BATCH];
    let mut handled = Vec::with_capacity(MAX_BATCH);
    let mut seen = 0usize;
    for batch in batches {
        let Ok(count) = read_batch(batch, &mut slots, &mut routes) else {
            continue;
        };
        handled.clear();
        for &id in &slots[..count] {
            seen += 1;
            if seen.is_multiple_of(7) {
                let _ = later.send(id);
                continue;
            }
            if let Some(nonce) = answer(id, route) {
                record(answered, id, nonce);
            }
            handled.push(id);
        }
        let _ = complete(worker, &handled, batch.epoch, None);
    }
}

/// H2: pins each slot it is handed, answers it and completes it with no
/// acknowledgment.
fn later_host(worker: u8, route: u32, ids: &Receiver<u64>, answered: &Answered) {
    for id in ids {
        if let Err(refusal) = access::pin(id) {
            closed(refusal);
        } else {
            let nonce = answer(id, route);
            access::unpin(id).unwrap();
            if let Some(nonce) = nonce {
                record(answered, id, nonce);
            }
        }
        let _ = complete(worker, &[id], 0, None);
    }
}

/// H3: loops over the last answered ids until `done`, reading each under the lock and
/// through a pin; every read that succeeds must return the nonce recorded for its id.
/// Returns how many reads succeeded.
fn late_reader(answered: &Answered, done: &AtomicBool, route: u32) -> usize {
    let mut succeeded = 0;
    while !done.load(Ordering::Acquire) {
        let window: Vec<(u64, Vec<u8>)> = answered.lock().unwrap().iter().cloned().collect();
        if window.is_empty() {
            thread::yield_now();
        }
        for (id, recorded) in &window {
            let id = *id;
            match access::with_read(id, nonce) {
                Ok(seen) => {
                    assert_eq!(seen.as_ref(), Some(recorded), "slot {id} under the lock");
                    succeeded += 1;
                }
                Err(refusal) => closed(refusal),
            }
            if let Err(refusal) = access::pin(id) {
                closed(refusal);
                continue;
            }
            match access::with_view(id, |view| (view.route, view.param_count)) {
                Ok(values) => assert_eq!(values, (route, 1), "slot {id} through the view"),
                Err(refusal) => closed(refusal),
            }
            match access::with_pinned_read(id, nonce) {
                Ok(seen) => {
                    assert_eq!(seen.as_ref(), Some(recorded), "slot {id} through a pin");
                    succeeded += 1;
                }
                Err(refusal) => closed(refusal),
            }
            access::unpin(id).unwrap();
        }
    }
    succeeded
}

/// A deterministic generator of nonces and choices: xorshift64.
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

/// One client: `PAIRS` pipelined pairs of `/t0` and `/t3/<n>` with a random nonce,
/// checking every answer it reads, and one connection in ten dropped once its pair is
/// sent.
fn client(server: &Server, index: usize) -> usize {
    let mut draws = Draws(0x9E37_79B9_7F4A_7C15 ^ (index as u64 + 1));
    let mut client = Client::connect(server);
    let mut dropped = 0;
    for pair in 0..PAIRS {
        let item = index * PAIRS + pair;
        let nonce = format!("{:016x}", draws.next());
        let leased = format!("GET /t3/{item} HTTP/1.1\r\nHost: t\r\nX-Nonce: {nonce}\r\n\r\n");
        let fixed = "GET /t0 HTTP/1.1\r\nHost: t\r\n\r\n";
        let order = if pair % 2 == 0 {
            [fixed, leased.as_str()]
        } else {
            [leased.as_str(), fixed]
        };
        client.send(order.concat().as_bytes());
        if draws.next().is_multiple_of(10) {
            client = Client::connect(server);
            dropped += 1;
            continue;
        }
        for request in order {
            let reply = client.read().unwrap();
            assert_eq!(reply.status, 200, "{request}");
            if request == fixed {
                assert_eq!(reply.text(), FIXED);
            } else {
                assert_eq!(reply.text(), format!("n={item};nonce={nonce}"));
            }
        }
    }
    dropped
}

#[test]
#[ignore = "a race test for ThreadSanitizer, run with --include-ignored slot_recycle"]
fn slot_recycle_late_readers_race_retire_with_tier0_and_tier3_on_one_core() {
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Get),
        "/t0",
        br#"{"body":"fixed body"}"#,
    )
    .unwrap();
    let route = app
        .route(RouteKind::Host, Some(Method::Get), "/t3/:n", b"")
        .unwrap();
    let server = Server::new(&app, ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap();
    let failures: Arc<Mutex<Vec<Event>>> = Arc::default();
    let sink = Arc::clone(&failures);
    server
        .on_event(Arc::new(move |event: Event| {
            if matches!(
                event,
                Event::TaskPanic { .. } | Event::WorkerPanic { .. } | Event::HostFailed { .. }
            ) {
                sink.lock().unwrap().push(event);
            }
        }))
        .unwrap();
    let worker = server.workers()[0];
    let (forward, batches) = mpsc::channel();
    server
        .attach(worker, Arc::new(Forward(Mutex::new(forward))))
        .unwrap();
    server.start().unwrap();

    let answered: Answered = Arc::default();
    let done = Arc::new(AtomicBool::new(false));
    let (later, handed) = mpsc::channel();
    let bound = {
        let answered = Arc::clone(&answered);
        thread::spawn(move || bound_host(worker, route, &batches, &later, &answered))
    };
    let delayed = {
        let answered = Arc::clone(&answered);
        thread::spawn(move || later_host(worker, route, &handed, &answered))
    };
    let reader = {
        let answered = Arc::clone(&answered);
        let done = Arc::clone(&done);
        thread::spawn(move || late_reader(&answered, &done, route))
    };
    let clients: Vec<_> = (0..CLIENTS)
        .map(|index| {
            let server = server.clone();
            thread::spawn(move || client(&server, index))
        })
        .collect();
    let dropped: usize = clients
        .into_iter()
        .map(|client| client.join().unwrap())
        .sum();
    done.store(true, Ordering::Release);
    let reads = reader.join().unwrap();

    server.detach(worker).unwrap();
    bound.join().unwrap();
    delayed.join().unwrap();
    server.shutdown();
    server.wait(Some(Duration::from_secs(60))).unwrap();
    let stats = server.stats();
    assert!(
        failures.lock().unwrap().is_empty(),
        "{:?}",
        failures.lock().unwrap()
    );
    assert_eq!((stats.leased, stats.pinned), (0, 0));
    #[cfg(feature = "testing")]
    assert_eq!(zero_host::testing::live_slots(worker), Some(0));
    eprintln!(
        "late_readers {}, late reader's successful reads {reads}, connections dropped {dropped}",
        stats.late_readers
    );
}
