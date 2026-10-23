//! The tier 3 path end to end over loopback, with a test target that hands each
//! batch to the test thread: tier 0 and tier 3 on one core, the 503 past the
//! queued-batch bound with `Retry-After` (RFC 9110 Sections 15.6.4 and 10.2.3), a
//! batch the target refused as full kept and posted after the next acknowledgment
//! (Node-API `napi_call_threadsafe_function`: the value is queued only on `napi_ok`),
//! an acknowledgment that arrives before the post returns, the answers without a
//! target and after its loss, leases closed by dropped connections, refused
//! acknowledgments, and the retained octets of a burst of large bodies returning to
//! idle.

mod support;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use support::{eventually, get, ids, routes, start, stop, Client, TestTarget};
use zero_host::{bind_thread, complete, App, BatchRef, HostError, Method, RouteKind, Status};

/// A fixed route at `/fixed` answered in Rust and a host route at `/host` for every
/// method.
fn app() -> (App, u32) {
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Get),
        "/fixed",
        br#"{"status":200,"contentType":"text/plain","body":"fixed"}"#,
    )
    .unwrap();
    let host = app.route(RouteKind::Host, None, "/host", b"").unwrap();
    (app, host)
}

/// The answer to a lease the host completed without writing a response.
fn assert_no_response(reply: &support::Reply) {
    assert_eq!(reply.status, 500, "{}", reply.text());
    assert!(
        reply.text().contains("\"code\":\"NO_RESPONSE\""),
        "{}",
        reply.text()
    );
    assert_eq!(
        reply.header("content-type"),
        Some("application/problem+json")
    );
}

#[test]
fn tier_0_and_tier_3_requests_are_served_on_one_core() {
    let (app, host) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();

    let mut leased = Client::connect(&server);
    leased.send_get("/host");
    let batch = target.take();
    assert_eq!(
        (batch.worker, batch.kind),
        (worker, zero_host::BATCH_REQUESTS)
    );
    assert_eq!(routes(batch), [host]);
    let slots = ids(batch);
    assert_eq!(slots.len(), 1);

    for _ in 0..3 {
        let fixed = get(&server, "/fixed");
        assert_eq!((fixed.status, fixed.text().as_str()), (200, "fixed"));
    }
    assert_eq!(server.stats().leased, 1, "the lease is still open");

    complete(worker, &slots, batch.epoch, None).unwrap();
    assert_no_response(&leased.read().unwrap());
    let fixed = leased.get("/fixed");
    assert_eq!(
        fixed.status, 200,
        "the connection serves on after the lease"
    );
    let stats = server.stats();
    assert_eq!(
        (stats.dispatched, stats.batches, stats.acks, stats.leased),
        (1, 1, 1, 0)
    );
    stop(&server);
}

#[test]
fn past_the_queued_batch_bound_a_host_request_is_answered_503_with_retry_after() {
    let (app, _) = app();
    let server = start(
        &app,
        r#"{"threads":1,"drainMs":5000,"limits":{"maxPipelined":32}}"#,
    );
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    let request: &[u8] = b"GET /host HTTP/1.1\r\nHost: t\r\nContent-Length: 1\r\n\r\nx";

    // Four batches of one request each fill the in-flight bound of four.
    let mut clients = Vec::new();
    for posted in 1..=4 {
        let mut client = Client::connect(&server);
        client.send(request);
        eventually("the batch to be posted", || target.counts().2 == posted);
        clients.push(client);
    }
    // Then 16 full batches' worth, 4,096 requests, queue behind it: 32 pipelined on
    // each connection. Each request's one-octet body counts while it is exported.
    let burst = request.repeat(32);
    for _ in 0..128 {
        let mut client = Client::connect(&server);
        client.send(&burst);
        clients.push(client);
    }
    eventually("every request to be exported", || {
        server.stats().retained == 4 + 4_096
    });
    let stats = server.stats();
    assert_eq!((stats.dispatched, stats.refused_503), (4, 0));

    let refused = get(&server, "/host");
    assert_eq!(refused.status, 503, "{}", refused.text());
    assert_eq!(refused.header("retry-after"), Some("1"));
    assert!(refused.text().contains("\"code\":\"SERVICE_UNAVAILABLE\""));
    assert_eq!(server.stats().refused_503, 1);
    let fixed = get(&server, "/fixed");
    assert_eq!(fixed.status, 200, "tier 0 serves past the bound");
    assert_eq!(target.counts().2, 4, "nothing more was posted");
    drop(clients);
    stop(&server);
}

#[test]
fn a_full_target_keeps_the_batch_queued_and_posts_it_after_an_acknowledgment() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(1);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();

    let mut first = Client::connect(&server);
    first.send_get("/host");
    eventually("the first batch", || target.counts().2 == 1);
    let mut second = Client::connect(&server);
    second.send_get("/host");
    eventually("the full refusal", || server.stats().queue_full == 1);
    assert_eq!(target.counts().1, 1);

    // The host takes the first batch, which frees the target's queue, and answers
    // its request without acknowledging: the turn that wakes the request does not
    // offer the refused batch again.
    let batch = target.take();
    complete(worker, &ids(batch), 0, None).unwrap();
    assert_no_response(&first.read().unwrap());
    assert_eq!(target.counts(), (2, 1, 1), "the refused batch waits");

    // The acknowledgment of the first batch lets the second one out, under the epoch
    // the refused attempt had.
    complete(worker, &[], batch.epoch, None).unwrap();
    let posted = target.take();
    assert_eq!(posted.epoch, batch.epoch + 1);
    assert_eq!(target.counts(), (3, 1, 2));
    complete(worker, &ids(posted), posted.epoch, None).unwrap();
    assert_no_response(&second.read().unwrap());
    let stats = server.stats();
    assert_eq!(
        (
            stats.batches,
            stats.acks,
            stats.queue_full,
            stats.dispatched
        ),
        (2, 2, 1, 2)
    );
    stop(&server);
}

#[test]
fn a_host_that_acknowledges_before_the_post_returns_is_accepted() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    let (to_host, batches) = mpsc::channel::<BatchRef>();
    let (to_worker, acknowledged) = mpsc::channel::<Result<(), HostError>>();
    let host = thread::spawn(move || {
        bind_thread(worker).unwrap();
        for batch in batches {
            let slots = ids(batch);
            let _ = to_worker.send(complete(worker, &slots, batch.epoch, None));
        }
    });
    let outcomes: Arc<Mutex<Vec<Result<(), HostError>>>> = Arc::default();
    let seen = Arc::clone(&outcomes);
    let to_host = Mutex::new(to_host);
    let acknowledged = Mutex::new(acknowledged);
    target.before_return(Arc::new(move |batch| {
        to_host.lock().unwrap().send(batch).unwrap();
        let outcome = acknowledged
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        seen.lock().unwrap().push(outcome);
    }));
    server.attach(worker, target.clone()).unwrap();

    for _ in 0..2 {
        assert_no_response(&get(&server, "/host"));
    }
    assert_eq!(*outcomes.lock().unwrap(), [Ok(()), Ok(())]);
    let stats = server.stats();
    assert_eq!((stats.acks, stats.refused_acks, stats.in_flight), (2, 0, 0));
    for &worker in server.workers() {
        server.detach(worker).unwrap();
    }
    drop(target);
    stop(&server);
    drop(host);
}

#[test]
fn a_worker_index_without_a_target_answers_host_requests_503_while_tier_0_serves() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1,"retryAfterSecs":7}"#);
    let refused = get(&server, "/host");
    assert_eq!(refused.status, 503);
    assert_eq!(refused.header("retry-after"), Some("7"));
    assert_eq!(
        refused.header("content-type"),
        Some("application/problem+json")
    );
    assert!(refused.text().contains("\"code\":\"SERVICE_UNAVAILABLE\""));
    assert_eq!(get(&server, "/fixed").status, 200);
    assert_eq!(server.stats().refused_503, 1);
    stop(&server);

    let legacy = start(&app, r#"{"threads":1,"errorShape":"legacy"}"#);
    let refused = get(&legacy, "/host");
    assert_eq!(refused.status, 503);
    assert_eq!(refused.header("content-type"), Some("application/json"));
    assert_eq!(refused.text(), r#"{"error":"Service Unavailable"}"#);
    stop(&legacy);
}

#[test]
fn a_lost_target_answers_its_leases_503_while_tier_0_serves() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    let mut leased = Client::connect(&server);
    leased.send_get("/host");
    let batch = target.take();
    let slots = ids(batch);

    server.detach(worker).unwrap();
    let lost = leased.read().unwrap();
    assert_eq!(lost.status, 503, "{}", lost.text());
    assert_eq!(lost.header("retry-after"), Some("1"));
    assert_eq!(get(&server, "/fixed").status, 200);
    assert_eq!(get(&server, "/host").status, 503);
    let mut results = [Status::Ok];
    complete(worker, &slots, 0, Some(&mut results)).unwrap();
    assert_eq!(results, [Status::Closed], "the closed lease refuses its id");
    let stats = server.stats();
    assert_eq!((stats.closed_leases, stats.leased), (1, 0));
    assert_eq!(
        server.detach(worker).unwrap_err().status(),
        Status::Closed,
        "the index has no target any more"
    );
    stop(&server);
}

#[test]
fn a_dropped_connection_closes_its_lease() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();

    // The fixed response stays unread, so dropping the connection resets it.
    let mut client = Client::connect(&server);
    client.send(b"GET /fixed HTTP/1.1\r\nHost: t\r\n\r\nGET /host HTTP/1.1\r\nHost: t\r\n\r\n");
    let batch = target.take();
    let slots = ids(batch);
    eventually("the fixed response to arrive", || {
        let mut peek = [0u8; 1];
        client.stream.peek(&mut peek).is_ok_and(|count| count == 1)
    });
    drop(client);
    eventually("the lease to close", || server.stats().leased == 0);
    let mut results = [Status::Ok];
    complete(worker, &slots, batch.epoch, Some(&mut results)).unwrap();
    assert_eq!(results, [Status::Closed]);
    assert_eq!(get(&server, "/fixed").status, 200);
    stop(&server);
}

#[test]
fn a_refused_acknowledgment_still_applies_its_completions_and_each_id_is_checked() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();

    let mut leased = Client::connect(&server);
    leased.send_get("/host");
    let batch = target.take();
    let slots = ids(batch);
    let answered = slots.clone();
    let elsewhere = thread::spawn(move || complete(worker, &answered, batch.epoch, None))
        .join()
        .unwrap();
    assert_eq!(elsewhere.unwrap_err().status(), Status::InvalidArgument);
    assert_no_response(&leased.read().unwrap());
    assert_eq!(server.stats().refused_acks, 1);
    let early = complete(worker, &[], batch.epoch + 1, None).unwrap_err();
    assert_eq!(
        early.status(),
        Status::InvalidArgument,
        "an epoch never posted"
    );
    assert_eq!(server.stats().refused_acks, 2);
    complete(worker, &[], batch.epoch, None).unwrap();
    eventually("the acknowledgment", || server.stats().acks == 1);

    let other_worker = zero_core::SlotId::new(worker.wrapping_add(1) % 128, 0, 0)
        .unwrap()
        .as_u64();
    let mut results = [Status::Ok; 3];
    complete(
        worker,
        &[u64::MAX, other_worker, slots[0]],
        0,
        Some(&mut results),
    )
    .unwrap();
    assert_eq!(
        results,
        [
            Status::InvalidArgument,
            Status::InvalidArgument,
            Status::Closed
        ]
    );
    let mut short = [Status::Ok; 1];
    assert_eq!(
        complete(worker, &[1, 2], 0, Some(&mut short))
            .unwrap_err()
            .status(),
        Status::InvalidArgument
    );
    stop(&server);
}

#[test]
fn a_burst_of_one_mebibyte_bodies_returns_the_retained_octets_to_idle() {
    const BODY: usize = 1_048_576;
    const REQUESTS: usize = 16;
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    let idle = server.stats().retained;
    assert_eq!(idle, 0);

    let peak = Arc::new(AtomicU64::new(0));
    let host = {
        let target = Arc::clone(&target);
        let server = server.clone();
        let peak = Arc::clone(&peak);
        thread::spawn(move || {
            bind_thread(worker).unwrap();
            let mut answered = 0;
            while answered < REQUESTS {
                let batch = target.take();
                let slots = ids(batch);
                peak.fetch_max(server.stats().retained, Ordering::Relaxed);
                answered += slots.len();
                complete(worker, &slots, batch.epoch, None).unwrap();
            }
        })
    };
    let mut head =
        format!("POST /host HTTP/1.1\r\nHost: t\r\nContent-Length: {BODY}\r\n\r\n").into_bytes();
    head.resize(head.len() + BODY, b'z');
    let mut clients: Vec<Client> = (0..REQUESTS).map(|_| Client::connect(&server)).collect();
    for client in &mut clients {
        client.send(&head);
    }
    for client in &mut clients {
        assert_no_response(&client.read().unwrap());
    }
    host.join().unwrap();
    assert!(
        peak.load(Ordering::Relaxed) >= u64::try_from(BODY).unwrap(),
        "an exported body counts while it is leased"
    );
    eventually("the retained octets to return to idle", || {
        server.stats().retained == idle
    });
    stop(&server);
}

#[test]
fn fixed_redirect_and_health_routes_are_answered_in_rust() {
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Get),
        "/teapot",
        br#"{"status":202,"contentType":"application/octet-stream","bodyBase64":"AAEC"}"#,
    )
    .unwrap();
    app.route(
        RouteKind::Redirect,
        Some(Method::Get),
        "/old",
        br#"{"status":308,"location":"/new"}"#,
    )
    .unwrap();
    app.route(
        RouteKind::Health,
        Some(Method::Get),
        "/health",
        br#"{"body":"ok"}"#,
    )
    .unwrap();
    let server = start(&app, r#"{"threads":1}"#);
    let mut client = Client::connect(&server);
    let fixed = client.get("/teapot");
    assert_eq!(
        (fixed.status, fixed.body.as_slice()),
        (202, &[0u8, 1, 2][..])
    );
    assert_eq!(
        fixed.header("content-type"),
        Some("application/octet-stream")
    );
    let moved = client.get("/old");
    assert_eq!(
        (moved.status, moved.header("location")),
        (308, Some("/new"))
    );
    let health = client.get("/health");
    assert_eq!((health.status, health.text().as_str()), (200, "ok"));
    let head = client.head("/health");
    assert_eq!(
        (head.status, head.header("content-length")),
        (200, Some("2"))
    );
    let missing = client.get("/nothing");
    assert_eq!(missing.status, 404, "without a miss route the core answers");
    assert_eq!(server.stats().dispatched, 0, "nothing crossed to a host");
    stop(&server);
}

#[test]
fn a_host_routes_max_body_refuses_a_larger_body_with_413_before_the_host_sees_it() {
    let mut app = App::new();
    app.route(
        RouteKind::Host,
        Some(Method::Post),
        "/small",
        br#"{"maxBody":4}"#,
    )
    .unwrap();
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    let mut client = Client::connect(&server);
    let refused =
        client.get_with("POST /small HTTP/1.1\r\nHost: t\r\nContent-Length: 5\r\n\r\nabcde");
    assert_eq!(refused.status, 413);
    assert_eq!(
        target.counts().0,
        0,
        "the host was never offered the request"
    );
    stop(&server);
}

#[cfg(feature = "static")]
#[test]
fn a_static_route_serves_its_root_in_rust_and_a_path_it_does_not_serve_falls_through_to_the_miss_route(
) {
    let root = std::env::temp_dir().join(format!("zero-host-static-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("hello.txt"), b"hello").unwrap();
    let path = root.display().to_string().replace('\\', "\\\\");
    let mut app = App::new();
    app.route(
        RouteKind::Static,
        Some(Method::Get),
        "/files/*path",
        format!(r#"{{"root":"{path}"}}"#).as_bytes(),
    )
    .unwrap();
    app.route(
        RouteKind::Static,
        Some(Method::Get),
        "/strict/*path",
        format!(r#"{{"root":"{path}","fallthrough":false}}"#).as_bytes(),
    )
    .unwrap();
    let miss = app.miss();
    assert_eq!(
        app.route(
            RouteKind::Static,
            Some(Method::Get),
            "/gone/*path",
            br#"{"root":"/no/such/directory/for/zero-host"}"#
        )
        .unwrap_err()
        .status(),
        Status::Io
    );
    let server = start(&app, r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();

    let mut client = Client::connect(&server);
    let served = client.get("/files/hello.txt");
    assert_eq!((served.status, served.text().as_str()), (200, "hello"));
    let strict = client.get("/strict/absent.txt");
    assert_eq!(strict.status, 404);
    assert!(strict.text().contains("not_found"), "{}", strict.text());

    client.send_get("/files/absent.txt");
    let batch = target.take();
    assert_eq!(
        routes(batch),
        [miss],
        "the miss route takes what the root does not serve"
    );
    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_no_response(&client.read().unwrap());
    stop(&server);
    let _ = std::fs::remove_dir_all(&root);
}
