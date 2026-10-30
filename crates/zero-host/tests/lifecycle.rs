//! The server's lifecycle: the configuration refused when the lease timeout is not
//! the request total, worker indexes reused by a second server with the first one's
//! ids reading `Closed` and its detach, wait and statistics leaving the second server
//! alone, the drain returning within a second of shutdown on an idle server and of
//! the last in-flight completion with a 30 s deadline, the waits a thread may not
//! make, pull targets and the threads they bind, the canonical table check, stop
//! listeners, and the release of a stopped server's status callback.
//!
//! The tests take one lock so the worker indexes each claims are the lowest free
//! ones, which the reuse tests rely on.

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use support::{eventually, get, ids, start, stop, Client, TestTarget};
use zero_host::{
    bind_thread, complete, App, Batch, EventRec, Method, PullTarget, RouteKind, Server,
    ServerOptions, Status, MAX_BATCH,
};

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One poll of `target` with arrays a batch long; the status of a refusal.
fn poll_once(target: &PullTarget, timeout: Duration) -> Result<Batch, Status> {
    let mut slots = vec![0u64; MAX_BATCH];
    let mut routes = vec![0u32; MAX_BATCH];
    let mut events = Vec::new();
    target
        .poll(timeout, &mut slots, &mut routes, &mut events)
        .map_err(|err| err.status())
}

fn app() -> App {
    let mut app = App::new();
    app.route(
        RouteKind::Fixed,
        Some(Method::Get),
        "/fixed",
        br#"{"body":"fixed"}"#,
    )
    .unwrap();
    app.route(RouteKind::Host, Some(Method::Get), "/host", b"")
        .unwrap();
    app
}

#[test]
fn a_configuration_whose_lease_timeout_differs_from_the_request_total_is_refused() {
    let _serial = serial();
    let app = app();
    let mut options = ServerOptions::default();
    options.limits.memory.lease_timeout = Duration::from_secs(10);
    let refused = Server::new(&app, options).unwrap_err();
    assert_eq!(refused.status(), Status::InvalidArgument);
    assert!(refused.message().contains("lease timeout"), "{refused}");

    let document = br#"{"threads":1,"limits":{"requestTotalMs":5000,"leaseTimeoutMs":6000}}"#;
    let options = ServerOptions::parse(document).unwrap();
    assert_eq!(
        Server::new(&app, options).unwrap_err().status(),
        Status::InvalidArgument
    );
    let same = ServerOptions::parse(br#"{"threads":1,"limits":{"requestTotalMs":5000}}"#).unwrap();
    let server = Server::new(&app, same).unwrap();
    assert_eq!(server.workers().len(), 1);
}

#[test]
fn a_second_server_reuses_the_worker_index_and_the_first_servers_ids_read_closed() {
    let _serial = serial();
    let app = app();
    let first = start(&app, r#"{"threads":1}"#);
    let worker = first.workers()[0];
    let target = TestTarget::new(4);
    first.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    let mut client = Client::connect(&first);
    client.send_get("/host");
    let batch = target.take();
    let old = ids(batch)[0];
    let first_epoch = batch.epoch;
    complete(worker, &[old], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    drop(client);
    stop(&first);

    let second = start(&app, r#"{"threads":1}"#);
    assert_eq!(
        second.workers(),
        [worker],
        "the index went back to the pool"
    );
    let target = TestTarget::new(4);
    second.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    let mut client = Client::connect(&second);
    client.send_get("/host");
    let batch = target.take();
    let new = ids(batch)[0];
    assert_ne!(new, old, "the generations continue across servers");
    assert_eq!(
        batch.epoch,
        first_epoch + 1,
        "the epochs continue across servers"
    );
    let mut results = [Status::Ok; 2];
    complete(worker, &[old, new], batch.epoch, Some(&mut results)).unwrap();
    assert_eq!(results, [Status::Closed, Status::Ok]);
    assert_eq!(client.read().unwrap().status, 500);
    drop(client);
    stop(&second);
}

#[test]
fn wait_returns_within_one_second_of_shutdown_on_an_idle_server_with_a_target_attached() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":2,"drainMs":30000}"#);
    let target = server.attach_pull(None).unwrap();
    assert_eq!(get(&server, "/fixed").status, 200);
    let asked = Instant::now();
    server.shutdown();
    server.wait(Some(Duration::from_secs(20))).unwrap();
    assert!(
        asked.elapsed() < Duration::from_secs(1),
        "the drain took {:?}",
        asked.elapsed()
    );
    assert!(!server.is_running());
    assert!(
        target.is_detached(),
        "a stopped server detaches its targets"
    );
}

#[test]
fn wait_returns_within_one_second_of_the_in_flight_requests_completion_after_shutdown() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":1,"drainMs":30000}"#);
    let target = server.attach_pull(None).unwrap();
    let (polled, batches) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let host = thread::spawn(move || {
        let mut slots = vec![0u64; MAX_BATCH];
        let mut routes = vec![0u32; MAX_BATCH];
        let mut events: Vec<EventRec> = Vec::new();
        let batch = target
            .poll(
                Duration::from_secs(10),
                &mut slots,
                &mut routes,
                &mut events,
            )
            .unwrap();
        polled.send(()).unwrap();
        released.recv().unwrap();
        let count = usize::try_from(batch.count).unwrap();
        complete(batch.worker, &slots[..count], batch.epoch, None).unwrap();
        Instant::now()
    });
    let mut client = Client::connect(&server);
    client.send_get("/host");
    batches.recv().unwrap();
    server.shutdown();
    assert!(server.is_running(), "the drain waits for the lease");
    assert_eq!(
        server
            .wait(Some(Duration::from_millis(50)))
            .unwrap_err()
            .status(),
        Status::Timeout
    );
    release.send(()).unwrap();
    let completed = host.join().unwrap();
    let reply = client.read().unwrap();
    assert_eq!(reply.status, 500);
    assert_eq!(reply.header("connection"), Some("close"));
    drop(client);
    server.wait(Some(Duration::from_secs(20))).unwrap();
    assert!(
        completed.elapsed() < Duration::from_secs(1),
        "the drain ended {:?} after the completion",
        completed.elapsed()
    );
}

#[test]
fn wait_is_refused_on_a_thread_bound_to_one_of_the_servers_targets() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":1}"#);
    let target = server.attach_pull(None).unwrap();
    let mut slots = vec![0u64; MAX_BATCH];
    let mut routes = vec![0u32; MAX_BATCH];
    let mut events = Vec::new();
    let polled = target
        .poll(Duration::ZERO, &mut slots, &mut routes, &mut events)
        .unwrap_err();
    assert_eq!(
        polled.status(),
        Status::Timeout,
        "the poll bound this thread"
    );
    server.shutdown();
    assert_eq!(
        server.wait(Some(Duration::ZERO)).unwrap_err().status(),
        Status::InvalidArgument
    );
    let waiter = server.clone();
    thread::spawn(move || waiter.wait(Some(Duration::from_secs(20))))
        .join()
        .unwrap()
        .unwrap();
    server.wait(Some(Duration::ZERO)).unwrap();
}

#[test]
fn a_pull_target_binds_its_first_poller_and_ends_polls_on_wake_and_detach() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":2}"#);
    let workers = server.workers().to_vec();
    let target = server.attach_pull(None).unwrap();
    assert_eq!(target.workers(), workers);
    assert_eq!(
        server.attach_pull(Some(workers[0])).unwrap_err().status(),
        Status::Limit,
        "a worker index has one target"
    );
    let (ended, ends) = mpsc::channel();
    let poller = Arc::clone(&target);
    let host = thread::spawn(move || {
        let mut slots = vec![0u64; MAX_BATCH];
        let mut routes = vec![0u32; MAX_BATCH];
        let mut events = Vec::new();
        let mut served = 0;
        loop {
            match poller.poll(
                Duration::from_secs(120),
                &mut slots,
                &mut routes,
                &mut events,
            ) {
                Ok(batch) => {
                    let count = usize::try_from(batch.count).unwrap();
                    served += count;
                    complete(batch.worker, &slots[..count], batch.epoch, None).unwrap();
                    if served == 8 {
                        let mut short = vec![0u64; 1];
                        let refused = poller
                            .poll(Duration::ZERO, &mut short, &mut routes, &mut events)
                            .map(drop)
                            .map_err(|err| err.status());
                        ended.send(refused).unwrap();
                    }
                }
                Err(err) => {
                    ended.send(Err(err.status())).unwrap();
                    if err.status() == Status::Closed {
                        return served;
                    }
                }
            }
        }
    });
    for _ in 0..8 {
        assert_eq!(get(&server, "/host").status, 500);
    }
    let bound = Duration::from_secs(10);
    assert_eq!(
        ends.recv_timeout(bound).unwrap(),
        Err(Status::InvalidArgument),
        "the bound thread's arrays are shorter than a batch"
    );
    assert_eq!(
        poll_once(&target, Duration::ZERO),
        Err(Status::InvalidArgument),
        "another thread is bound"
    );
    target.wake();
    assert_eq!(
        ends.recv_timeout(bound).unwrap(),
        Err(Status::Timeout),
        "the wake ends the blocked poll"
    );
    target.detach();
    assert_eq!(
        ends.recv_timeout(bound).unwrap(),
        Err(Status::Closed),
        "the detach ends the next poll"
    );
    assert_eq!(host.join().unwrap(), 8);
    assert!(target.is_detached());
    assert_eq!(get(&server, "/host").status, 503);
    let attached = server.attach(workers[1], TestTarget::new(1));
    assert!(attached.is_ok(), "a detached index takes a new target");
    stop(&server);
}

#[test]
fn the_first_poll_of_a_detached_target_binds_nothing() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let detached = server.attach_pull(Some(worker)).unwrap();
    detached.detach();
    let late = Arc::clone(&detached);
    let polled = thread::spawn(move || poll_once(&late, Duration::ZERO).map(drop))
        .join()
        .unwrap();
    assert_eq!(polled, Err(Status::Closed));
    let target = server.attach_pull(Some(worker)).unwrap();
    assert_eq!(
        poll_once(&target, Duration::ZERO).map(drop),
        Err(Status::Timeout),
        "the index takes the new target's first poller"
    );
    stop(&server);
}

#[test]
fn a_poll_refused_for_another_threads_binding_is_refused_again() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = server.attach_pull(Some(worker)).unwrap();
    thread::spawn(move || bind_thread(worker))
        .join()
        .unwrap()
        .unwrap();
    for attempt in 0..2 {
        assert_eq!(
            poll_once(&target, Duration::ZERO).map(drop),
            Err(Status::InvalidArgument),
            "attempt {attempt}"
        );
    }
    stop(&server);
}

#[test]
fn bind_thread_is_refused_for_a_worker_index_no_server_holds() {
    let _serial = serial();
    let first = start(&app(), r#"{"threads":1}"#);
    let worker = first.workers()[0];
    stop(&first);
    let bound = thread::spawn(move || bind_thread(worker).map_err(|err| err.status()))
        .join()
        .unwrap();
    assert_eq!(bound, Err(Status::Closed));

    let second = start(&app(), r#"{"threads":1}"#);
    assert_eq!(
        second.workers(),
        [worker],
        "the index went back to the pool"
    );
    let target = second.attach_pull(Some(worker)).unwrap();
    assert_eq!(
        poll_once(&target, Duration::ZERO).map(drop),
        Err(Status::Timeout),
        "no other thread is bound to the index"
    );
    stop(&second);
}

#[test]
fn a_detached_pull_target_is_not_kept_by_its_server() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let target = server.attach_pull(Some(worker)).unwrap();
    target.detach();
    let kept = Arc::downgrade(&target);
    drop(target);
    let next = server.attach_pull(Some(worker)).unwrap();
    eventually("the detached target to be dropped", || {
        kept.upgrade().is_none()
    });
    drop(next);
    stop(&server);
}

#[test]
fn detach_on_a_stopped_server_leaves_the_next_servers_target_attached() {
    let _serial = serial();
    let first = start(&app(), r#"{"threads":1}"#);
    let worker = first.workers()[0];
    stop(&first);
    let second = start(&app(), r#"{"threads":1}"#);
    assert_eq!(
        second.workers(),
        [worker],
        "the index went back to the pool"
    );
    let target = TestTarget::new(4);
    second.attach(worker, target.clone()).unwrap();
    assert_eq!(
        first.detach(worker).map_err(|err| err.status()),
        Err(Status::Closed)
    );
    bind_thread(worker).unwrap();
    let mut client = Client::connect(&second);
    client.send_get("/host");
    let batch = target.take();
    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    stop(&second);
}

#[test]
fn wait_on_a_stopped_server_returns_on_a_thread_bound_to_the_next_servers_target() {
    let _serial = serial();
    let first = start(&app(), r#"{"threads":1}"#);
    let worker = first.workers()[0];
    stop(&first);
    let second = start(&app(), r#"{"threads":1}"#);
    assert_eq!(
        second.workers(),
        [worker],
        "the index went back to the pool"
    );
    second.attach(worker, TestTarget::new(1)).unwrap();
    bind_thread(worker).unwrap();
    first.wait(Some(Duration::ZERO)).unwrap();
    assert_eq!(
        second.wait(Some(Duration::ZERO)).unwrap_err().status(),
        Status::InvalidArgument,
        "the running server still refuses its bound thread"
    );
    stop(&second);
}

#[test]
fn the_statistics_of_a_stopped_server_stay_as_they_were_at_its_stop() {
    let _serial = serial();
    let first = start(&app(), r#"{"threads":1}"#);
    let worker = first.workers()[0];
    assert_eq!(get(&first, "/host").status, 503, "no target is attached");
    stop(&first);
    let stopped = first.stats();
    assert_eq!(stopped.refused_503, 1);

    let second = start(&app(), r#"{"threads":1}"#);
    assert_eq!(
        second.workers(),
        [worker],
        "the index went back to the pool"
    );
    assert_eq!(get(&second, "/host").status, 503);
    assert_eq!(second.stats().refused_503, 1);
    assert_eq!(
        first.stats(),
        stopped,
        "the second server's traffic is not counted"
    );
    stop(&second);
}

#[test]
fn the_table_check_names_the_first_route_that_differs() {
    let _serial = serial();
    let app = app();
    let server = Server::new(&app, ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap();
    server.check_table(&app).unwrap();

    let mut changed = App::new();
    changed
        .route(
            RouteKind::Fixed,
            Some(Method::Get),
            "/fixed",
            br#"{"body":"changed"}"#,
        )
        .unwrap();
    changed
        .route(RouteKind::Host, Some(Method::Get), "/host", b"")
        .unwrap();
    changed
        .route(
            RouteKind::Fixed,
            Some(Method::Get),
            "/g",
            br#"{"body":"added"}"#,
        )
        .unwrap();
    let different = server.check_table(&changed).unwrap_err();
    assert_eq!(different.status(), Status::InvalidArgument);
    let message = different.message();
    assert!(message.contains("at line 1:"), "{different}");
    assert!(message.contains("route fixed GET /fixed 0"), "{different}");
    assert!(
        !message.contains("/g") && !message.contains("/host"),
        "only the first difference is named: {different}"
    );

    let mut longer = app.clone();
    longer
        .route(RouteKind::Host, Some(Method::Post), "/host", b"")
        .unwrap();
    let longer = server.check_table(&longer).unwrap_err();
    assert!(
        longer.message().contains("at line 3:")
            && longer.message().contains("route host POST /host 2"),
        "the first line past the server's table is named: {longer}"
    );
}

#[test]
fn stop_listeners_run_once_when_the_server_stops() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":1}"#);
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&runs);
    server.on_stop(Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    server.shutdown();
    server.wait(Some(Duration::from_secs(20))).unwrap();
    eventually("the listener", || runs.load(Ordering::SeqCst) == 1);
    let late = Arc::clone(&runs);
    server.on_stop(Box::new(move || {
        late.fetch_add(1, Ordering::SeqCst);
    }));
    assert_eq!(
        runs.load(Ordering::SeqCst),
        2,
        "a late listener runs at once"
    );
    server.shutdown();
    assert_eq!(server.start().unwrap_err().status(), Status::Closed);
}

/// The worker indexes outlive the server, so a stopped server must leave no hold on
/// its status callback in them.
#[test]
fn dropping_a_stopped_server_releases_its_status_callback() {
    use zero_host::{Event, StatusSink};
    let _serial = serial();
    let server = Server::new(&app(), ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap();
    let sink: StatusSink = Arc::new(|_: Event| {});
    let kept = Arc::downgrade(&sink);
    server.on_event(sink).unwrap();
    server.start().unwrap();
    stop(&server);
    drop(server);
    eventually("the status callback to be released", || {
        kept.upgrade().is_none()
    });
}

#[test]
fn dropping_the_last_handle_of_a_running_server_drains_it_and_frees_its_worker_indexes() {
    let _serial = serial();
    let server = start(&app(), r#"{"threads":1}"#);
    let worker = server.workers()[0];
    let (stopped, on_stop) = mpsc::channel();
    server.on_stop(Box::new(move || {
        let _ = stopped.send(());
    }));
    drop(server);
    on_stop.recv_timeout(Duration::from_secs(20)).unwrap();
    let next = Server::new(&app(), ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap();
    assert_eq!(next.workers(), [worker]);
}

#[test]
fn a_capability_compiled_out_is_refused_as_unsupported() {
    let _serial = serial();
    let mut app = App::new();
    let static_route = app.route(
        RouteKind::Static,
        Some(Method::Get),
        "/files/*",
        br#"{"root":"/no/such/root"}"#,
    );
    let websocket = app.route(RouteKind::WebSocket, Some(Method::Get), "/ws", b"");
    let policy = app.policy(zero_host::PolicyKind::BodyLimit, "/", br#"{"max":10}"#);
    let server = Server::new(&app, ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap();
    let tls = server.tls(b"not a certificate", b"not a key", b"");
    let unsupported = |outcome: Result<(), zero_host::HostError>, enabled: bool| {
        assert_eq!(
            outcome.err().map(|err| err.status()) == Some(Status::Unsupported),
            !enabled
        );
    };
    unsupported(static_route.map(drop), cfg!(feature = "static"));
    unsupported(websocket.map(drop), cfg!(feature = "realtime"));
    unsupported(policy, cfg!(feature = "policy"));
    unsupported(tls.clone(), cfg!(feature = "tls"));
    if cfg!(feature = "tls") {
        assert_eq!(tls.unwrap_err().status(), Status::Io, "unreadable material");
        assert_eq!(
            server
                .tls(b"", b"", br#"{"maxVersion":"1.2"}"#)
                .unwrap_err()
                .status(),
            Status::Codec
        );
    }
}
