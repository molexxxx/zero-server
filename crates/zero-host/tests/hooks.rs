//! The paths that need the hooks of the `testing` feature: a host that reads and
//! writes the leased exchange directly, the miss route's status and `Allow` (RFC 9110
//! Section 15.5.6: an origin server "MUST generate an Allow header field in a 405
//! response"), the policy fields added at import, the exhausted arena and the
//! quarantine it releases before refusing, the late list, the checks of a completion
//! made outside the intake lock, the worker-thread flag, a dispatcher panic, and a
//! hook that panics.

#![cfg(feature = "testing")]

mod support;

use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use support::{eventually, get, ids, routes, start, stop, Client, TestTarget};
use zero_core::SlotId;
use zero_host::testing::{
    allocator, cap_slots, hold_check, hold_dispatcher, inspect, panic_next_turn, respond,
    run_on_worker,
};
use zero_host::{
    bind_thread, complete, App, Event, Method, RouteKind, Server, ServerOptions, Status, MAX_BATCH,
};
use zero_http_types::{HeaderName, StatusCode};

/// A fixed route at `/fixed`, a host route at `GET /items`, and the miss route.
fn app() -> (App, u32, u32) {
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Get),
        "/fixed",
        br#"{"body":"fixed"}"#,
    )
    .unwrap();
    let items = app
        .route(RouteKind::Host, Some(Method::Get), "/items", b"")
        .unwrap();
    let miss = app.miss();
    (app, items, miss)
}

/// Bind the test thread to a new test target on the server's only worker index.
fn attached(server: &Server) -> (u8, Arc<TestTarget>) {
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    (worker, target)
}

#[test]
fn misses_reach_the_miss_route_with_the_status_and_allow_the_core_would_have_answered_9110_15_5_6()
{
    let (app, _, miss) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let get_head_options =
        (1u16 << Method::Get.id()) | (1 << Method::Head.id()) | (1 << Method::Options.id());
    let cases = [
        ("DELETE /items", 405, get_head_options),
        ("GET /nothing", 404, 0),
        ("BREW /items", 501, 0),
        ("OPTIONS /items", 200, get_head_options),
    ];
    let mut client = Client::connect(&server);
    for (request, status, allow) in cases {
        client.send(format!("{request} HTTP/1.1\r\nHost: t\r\n\r\n").as_bytes());
        let batch = target.take();
        assert_eq!(routes(batch), [miss], "{request}");
        let id = ids(batch)[0];
        let seen = inspect(id, |exchange| {
            (
                exchange.route(),
                exchange
                    .miss()
                    .map(|miss| (miss.status.as_u16(), miss.allow_mask())),
                exchange.request().route_path().to_vec(),
            )
        })
        .unwrap();
        assert_eq!(seen.0, miss);
        assert_eq!(seen.1, Some((status, allow)), "{request}");
        assert!(seen.2.starts_with(b"/"), "the normalized path is kept");
        respond(id, |exchange| {
            let mut response = exchange.response();
            response.status(StatusCode::new(status).unwrap());
            if status == 405 {
                response
                    .header_id(HeaderName::Allow, b"GET, HEAD, OPTIONS")
                    .unwrap();
            }
            response.body(b"from the host");
            exchange.seal();
        })
        .unwrap();
        complete(worker, &[id], batch.epoch, None).unwrap();
        let reply = client.read().unwrap();
        assert_eq!(reply.status, status, "{request}");
        if status == 405 {
            assert_eq!(reply.header("allow"), Some("GET, HEAD, OPTIONS"));
        }
    }
    stop(&server);
}

#[cfg(feature = "policy")]
#[test]
fn a_host_response_is_sent_with_the_policy_fields_added_at_import() {
    use zero_host::PolicyKind;
    let (mut app, _, _) = app();
    app.policy(
        PolicyKind::Cors,
        "/",
        br#"{"origins":["https://a.example"],"methods":["GET","PUT"]}"#,
    )
    .unwrap();
    app.policy(
        PolicyKind::SecurityHeaders,
        "/items",
        br#"{"fields":[["X-Frame-Options","DENY"]]}"#,
    )
    .unwrap();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);

    let mut client = Client::connect(&server);
    client.send(b"GET /items HTTP/1.1\r\nHost: t\r\nOrigin: https://a.example\r\n\r\n");
    let batch = target.take();
    let id = ids(batch)[0];
    respond(id, |exchange| {
        exchange
            .response()
            .status(StatusCode::OK)
            .content_type(b"text/plain")
            .unwrap()
            .body(b"payload");
        exchange.seal();
    })
    .unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!((reply.status, reply.text().as_str()), (200, "payload"));
    assert_eq!(
        reply.header("access-control-allow-origin"),
        Some("https://a.example")
    );
    assert_eq!(reply.header("vary"), Some("Origin"));
    assert_eq!(reply.header("x-frame-options"), Some("DENY"));

    let preflight = client.get_with(
        "OPTIONS /items HTTP/1.1\r\nHost: t\r\nOrigin: https://a.example\r\n\
         Access-Control-Request-Method: PUT\r\n\r\n",
    );
    assert_eq!(preflight.status, 204, "the preflight is answered in Rust");
    assert_eq!(
        preflight.header("access-control-allow-origin"),
        Some("https://a.example")
    );
    let refused = client.get_with(
        "OPTIONS /items HTTP/1.1\r\nHost: t\r\nOrigin: https://b.example\r\n\
         Access-Control-Request-Method: PUT\r\n\r\n",
    );
    assert_eq!(refused.status, 403);
    let fixed = client.get("/fixed");
    assert_eq!(fixed.header("x-frame-options"), None, "outside the prefix");
    assert_eq!(target.counts().2, 1, "no preflight reached the host");
    stop(&server);
}

#[test]
fn an_exhausted_arena_answers_host_requests_503_with_retry_after() {
    let (app, _, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    cap_slots(&server, worker, Some(1)).unwrap();

    let mut leased = Client::connect(&server);
    leased.send_get("/items");
    let batch = target.take();
    let refused = get(&server, "/items");
    assert_eq!(refused.status, 503);
    assert_eq!(refused.header("retry-after"), Some("1"));
    assert_eq!(server.stats().refused_503, 1);
    assert_eq!(get(&server, "/fixed").status, 200);

    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_eq!(leased.read().unwrap().status, 500);
    eventually("the index to leave the quarantine", || {
        allocator(&server, worker).unwrap().quarantined == 0
    });
    leased.send_get("/items");
    let batch = target.take();
    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_eq!(leased.read().unwrap().status, 500);
    cap_slots(&server, worker, None).unwrap();
    stop(&server);
}

#[test]
fn an_exhausted_arena_releases_the_acknowledged_quarantine_before_it_refuses() {
    let (app, _, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    cap_slots(&server, worker, Some(1)).unwrap();
    let mut client = Client::connect(&server);
    client.send_get("/items");
    let batch = target.take();
    complete(worker, &ids(batch), 0, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    eventually("the retired index to wait in the quarantine", || {
        allocator(&server, worker).unwrap().quarantined == 1
    });

    hold_dispatcher(&server, worker, true).unwrap();
    complete(worker, &[], batch.epoch, None).unwrap();
    client.send_get("/items");
    eventually("the request to reach the core", || {
        allocator(&server, worker).unwrap().live == 1 || server.stats().refused_503 > 0
    });
    assert_eq!(
        server.stats().refused_503,
        0,
        "the acknowledged index was released for the request"
    );
    hold_dispatcher(&server, worker, false).unwrap();
    let batch = target.take();
    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    cap_slots(&server, worker, None).unwrap();
    stop(&server);
}

#[test]
fn the_ids_of_a_completion_are_checked_before_the_intake_lock_is_taken() {
    let (app, _, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let stale = SlotId::new(worker, 7, 60_000).unwrap().as_u64();
    let held = hold_check(stale);
    let checking = thread::spawn(move || {
        let mut results = [Status::Ok];
        complete(worker, &[stale], 0, Some(&mut results)).map(|()| results[0])
    });
    assert!(held.reached(Duration::from_secs(10)), "the check is held");
    let (done, finished) = mpsc::channel();
    let other = thread::spawn(move || {
        let _ = done.send(complete(worker, &[], 0, None));
    });
    let other_finished = finished.recv_timeout(Duration::from_secs(10));
    drop(held);
    assert_eq!(
        other_finished.map_err(drop),
        Ok(Ok(())),
        "another completion took the intake lock while the check was held"
    );
    assert_eq!(checking.join().unwrap(), Ok(Status::Closed));
    other.join().unwrap();
    stop(&server);
}

#[test]
fn a_hook_that_panics_is_reported_as_a_panic_and_the_dispatcher_serves_on() {
    let (app, _, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let panicked = run_on_worker::<()>(&server, worker, || panic!("the job panics")).unwrap_err();
    assert_eq!(panicked.status(), Status::Panic, "{panicked}");
    assert_eq!(server.stats().panics, 0, "the dispatcher did not fail");
    let mut client = Client::connect(&server);
    client.send_get("/items");
    let batch = target.take();
    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_eq!(
        client.read().unwrap().status,
        500,
        "a lease is still served"
    );
    stop(&server);
}

#[test]
fn a_retired_index_stays_quarantined_until_the_host_acknowledges_its_batch() {
    let (app, _, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);

    let mut client = Client::connect(&server);
    client.send_get("/items");
    let batch = target.take();
    let id = ids(batch)[0];
    inspect(id, |exchange| {
        assert_eq!(exchange.request().path(), b"/items")
    })
    .unwrap();
    complete(worker, &[id], 0, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    eventually("the retirement", || {
        let state = allocator(&server, worker).unwrap();
        state.live == 0 && state.quarantined == 1
    });
    let warm = allocator(&server, worker).unwrap().warm;
    assert_eq!(
        inspect(id, |_| ()).unwrap_err().status(),
        Status::Closed,
        "the retired generation reads nothing"
    );
    assert_eq!(
        inspect(u64::MAX, |_| ()).unwrap_err().status(),
        Status::InvalidArgument,
        "an id above 2^53 - 1"
    );

    complete(worker, &[], batch.epoch, None).unwrap();
    eventually("the release", || {
        let state = allocator(&server, worker).unwrap();
        state.quarantined == 0 && state.warm == warm + 1
    });
    stop(&server);
}

#[test]
fn a_slot_whose_lock_a_host_holds_is_imported_from_the_late_list() {
    let (app, _, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let mut client = Client::connect(&server);
    client.send_get("/items");
    let batch = target.take();
    let id = ids(batch)[0];

    let (locked, holding) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let holder = thread::spawn(move || {
        respond(id, |exchange| {
            locked.send(()).unwrap();
            released.recv().unwrap();
            exchange
                .response()
                .status(StatusCode::CREATED)
                .body(b"late");
            exchange.seal();
        })
    });
    holding.recv().unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    eventually("the import to wait on the late list", || {
        server.stats().late_readers >= 1
    });
    release.send(()).unwrap();
    holder.join().unwrap().unwrap();
    let reply = client.read().unwrap();
    assert_eq!((reply.status, reply.text().as_str()), (201, "late"));
    stop(&server);
}

#[test]
fn the_worker_thread_flag_marks_the_io_workers_where_waits_polls_and_binds_are_refused() {
    let (app, _, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    assert!(!zero_rt::is_worker_thread(), "the test thread is no worker");
    assert!(run_on_worker(&server, worker, zero_rt::is_worker_thread).unwrap());

    let waited = server.clone();
    let wait = run_on_worker(&server, worker, move || {
        waited
            .wait(Some(Duration::ZERO))
            .map_err(|err| err.status())
    })
    .unwrap();
    assert_eq!(wait, Err(Status::InvalidArgument));
    let bind = run_on_worker(&server, worker, move || {
        bind_thread(worker).map_err(|err| err.status())
    })
    .unwrap();
    assert_eq!(bind, Err(Status::InvalidArgument));
    let target = server.attach_pull(None).unwrap();
    let poll = run_on_worker(&server, worker, move || {
        let mut slots = vec![0u64; MAX_BATCH];
        let mut routes = vec![0u32; MAX_BATCH];
        let mut events = Vec::new();
        target
            .poll(Duration::ZERO, &mut slots, &mut routes, &mut events)
            .map(|_| ())
            .map_err(|err| err.status())
    })
    .unwrap();
    assert_eq!(poll, Err(Status::InvalidArgument));
    stop(&server);
}

#[test]
fn a_dispatcher_panic_answers_its_leases_500_new_host_requests_503_and_reports_host_failed() {
    let (app, _, _) = app();
    let server = Server::new(&app, ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap();
    let events: Arc<Mutex<Vec<Event>>> = Arc::default();
    let sink = Arc::clone(&events);
    server
        .on_event(Arc::new(move |event: Event| {
            sink.lock().unwrap().push(event)
        }))
        .unwrap();
    server.start().unwrap();
    let (worker, target) = attached(&server);

    let mut leased = Client::connect(&server);
    leased.send_get("/items");
    let batch = target.take();
    panic_next_turn(&server, worker).unwrap();
    let failed = leased.read().unwrap();
    assert_eq!(failed.status, 500);
    assert!(
        failed.text().contains("\"code\":\"DISPATCH_FAILED\""),
        "{}",
        failed.text()
    );
    eventually("the host failure to be reported", || {
        events.lock().unwrap().iter().any(|event| {
            matches!(event, Event::HostFailed { message, .. } if message.contains("armed to panic"))
        })
    });
    assert_eq!(get(&server, "/items").status, 503);
    assert_eq!(get(&server, "/fixed").status, 200, "tier 0 serves on");
    assert_eq!(server.stats().panics, 1);
    let mut results = [Status::Ok];
    complete(worker, &ids(batch), 0, Some(&mut results)).unwrap();
    assert_eq!(results, [Status::Closed]);
    stop(&server);
}
