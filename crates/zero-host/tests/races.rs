//! The races between a server's lifecycle calls, each held at the point a hook of
//! the `testing` feature names: a start, an attach and a second shutdown racing a
//! stop, TLS set while the server starts, and a start whose reaper thread or later
//! cores cannot be started.
//!
//! The tests take one lock so the worker indexes each claims are the lowest free
//! ones, which the tests that reuse an index rely on.

#![cfg(feature = "testing")]

mod support;

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use support::{eventually, get, ids, start, stop, Client, TestTarget};
use zero_host::testing::{hold, refuse_next_reaper, refuse_next_serve, Stage};
use zero_host::{bind_thread, complete, App, Method, RouteKind, Server, ServerOptions, Status};

static SERIAL: Mutex<()> = Mutex::new(());

/// The longest a test waits for a held thread or a stop.
const BOUND: Duration = Duration::from_secs(20);

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
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

/// A server of one worker index that has not started.
fn ready() -> Server {
    Server::new(&app(), ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap()
}

#[test]
fn a_start_racing_the_stop_of_a_server_that_never_started_is_refused() {
    let _serial = serial();
    let server = ready();
    let released = hold(&server, Stage::Release);
    let stopping = server.clone();
    let stopper = thread::spawn(move || stopping.shutdown());
    assert!(released.reached(BOUND), "the stop released the targets");
    let started = server.start();
    drop(released);
    stopper.join().unwrap();
    assert_eq!(started.map_err(|err| err.status()), Err(Status::Closed));
    server.wait(Some(BOUND)).unwrap();
    assert!(!server.is_running());
    assert_eq!(server.address(), None);
}

#[test]
fn a_second_shutdown_of_a_stopping_server_leaves_the_next_servers_target_attached() {
    let _serial = serial();
    let first = ready();
    let worker = first.workers()[0];
    let released = hold(&first, Stage::Release);
    let stopping = first.clone();
    let stopper = thread::spawn(move || stopping.shutdown());
    assert!(
        released.reached(BOUND),
        "the first stop released the targets"
    );
    let entered = hold(&first, Stage::Stop);
    let again = first.clone();
    let late = thread::spawn(move || again.shutdown());
    eventually("the second shutdown to return or to begin a stop", || {
        late.is_finished() || entered.reached(Duration::ZERO)
    });
    drop(released);
    stopper.join().unwrap();
    first.wait(Some(BOUND)).unwrap();

    let second = start(&app(), r#"{"threads":1}"#);
    assert_eq!(
        second.workers(),
        [worker],
        "the index went back to the pool"
    );
    let _target = second.attach_pull(Some(worker)).unwrap();
    drop(entered);
    late.join().unwrap();
    assert_eq!(
        second.detach(worker).map_err(|err| err.status()),
        Ok(()),
        "the second shutdown of the first server left the second server's target alone"
    );
    stop(&second);
}

#[test]
fn an_attach_racing_the_stop_of_a_running_server_is_refused() {
    let _serial = serial();
    let first = start(&app(), r#"{"threads":1}"#);
    let worker = first.workers()[0];
    let released = hold(&first, Stage::Release);
    first.shutdown();
    assert!(released.reached(BOUND), "the reaper released the targets");
    let attached = first.attach_pull(Some(worker));
    drop(released);
    first.wait(Some(BOUND)).unwrap();
    assert_eq!(
        attached.map(drop).map_err(|err| err.status()),
        Err(Status::Closed)
    );

    let second = start(&app(), r#"{"threads":1}"#);
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
    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    stop(&second);
}

#[test]
fn an_attach_racing_the_stop_of_a_server_that_never_started_is_refused() {
    let _serial = serial();
    let first = ready();
    let worker = first.workers()[0];
    let released = hold(&first, Stage::Release);
    let stopping = first.clone();
    let stopper = thread::spawn(move || stopping.shutdown());
    assert!(released.reached(BOUND), "the stop released the targets");
    let attached = first.attach(worker, TestTarget::new(1));
    drop(released);
    stopper.join().unwrap();
    assert_eq!(attached.map_err(|err| err.status()), Err(Status::Closed));

    let second = ready();
    assert_eq!(
        second.workers(),
        [worker],
        "the index went back to the pool"
    );
    assert_eq!(
        second
            .attach(worker, TestTarget::new(1))
            .map_err(|err| err.status()),
        Ok(()),
        "the stopped server left no target on the index"
    );
}

#[test]
fn a_start_whose_reaper_thread_cannot_be_started_leaves_the_server_ready() {
    let _serial = serial();
    let server = ready();
    refuse_next_reaper();
    assert_eq!(server.start().unwrap_err().status(), Status::Io);
    assert!(!server.is_running(), "nothing serves without a reaper");
    assert_eq!(server.address(), None);
    server.start().unwrap();
    assert_eq!(get(&server, "/fixed").status, 200);
    server.shutdown();
    server.wait(Some(BOUND)).unwrap();
}

#[test]
fn a_start_that_fails_once_its_cores_ran_keeps_the_targets_attached_before_it() {
    let _serial = serial();
    let server = ready();
    let worker = server.workers()[0];
    let target = TestTarget::new(4);
    server.attach(worker, target.clone()).unwrap();
    refuse_next_serve();
    assert_eq!(server.start().unwrap_err().status(), Status::Io);
    server.start().unwrap();
    bind_thread(worker).unwrap();
    let mut client = Client::connect(&server);
    client.send_get("/host");
    let batch = target.take();
    complete(worker, &ids(batch), batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    stop(&server);
}

#[cfg(feature = "tls")]
#[test]
fn tls_set_while_the_server_starts_is_refused() {
    const CHAIN: &[u8] = include_bytes!("../../zero-tls/tests/fixtures/localhost.pem");
    const KEY: &[u8] = include_bytes!("../../zero-tls/tests/fixtures/localhost.key");
    let _serial = serial();
    let server = ready();
    let built = hold(&server, Stage::Tls);
    let configuring = server.clone();
    let configure =
        thread::spawn(move || configuring.tls(CHAIN, KEY, br#"{"names":["localhost"]}"#));
    assert!(built.reached(BOUND), "the identity is built");
    server.start().unwrap();
    drop(built);
    assert_eq!(
        configure.join().unwrap().map_err(|err| err.status()),
        Err(Status::InvalidArgument)
    );
    assert_eq!(
        get(&server, "/fixed").status,
        200,
        "the server serves what it started with"
    );
    server.shutdown();
    server.wait(Some(BOUND)).unwrap();
}
