//! Server lifecycles through the C ABI: several servers in one process, ids of a stopped
//! server, a shutdown with leased slots, and a free refused while running.

#![cfg(not(miri))]
#![allow(unsafe_code)]

mod support;

use std::ptr;

use support::{
    address, app_new, attach, complete, ok, poll, poll_batch, route, server_new, workers, Client,
};
use zero_ffi::*;

/// A started server of one host route `GET /h`, its worker index and its pull target.
struct Running {
    app: u64,
    server: u64,
    worker: u8,
    target: u64,
}

fn running(options: &str) -> Running {
    let app = app_new();
    route(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/h", "");
    let server = server_new(app, options);
    let worker = workers(server)[0];
    let target = attach(server, u32::from(worker));
    ok(zero_server_start(server));
    Running {
        app,
        server,
        worker,
        target,
    }
}

/// Lease one request on a new connection: the client and the slot id.
fn lease(running: &Running) -> (Client, u64) {
    let mut client = Client::connect(address(running.server));
    client.send(b"GET /h HTTP/1.1\r\nHost: t\r\n\r\n");
    let polled = poll_batch(running.target);
    ok(complete(running.worker, &[], polled.batch.epoch).0);
    (client, polled.slots[0])
}

/// Answer a slot with a body and complete it.
fn answer(running: &Running, slot: u64, body: &[u8]) {
    // SAFETY: the range is `body`.
    ok(unsafe { zero_res_body_copy(slot, body.as_ptr(), body.len()) });
    ok(zero_res_send(slot));
    ok(complete(running.worker, &[slot], 0).0);
}

/// The status of a value read of a slot.
fn route_of(slot: u64) -> ZeroStatus {
    let mut route = 0;
    // SAFETY: `route` is a writable `uint32_t`.
    unsafe { zero_slot_route(slot, &mut route) }
}

/// Shut a server down and wait for it from a thread no target is bound to.
fn stop_elsewhere(server: u64) {
    ok(zero_server_shutdown(server, ZERO_NONE));
    let waited = std::thread::spawn(move || zero_server_wait(server, 30_000))
        .join()
        .unwrap();
    ok(waited);
}

#[test]
fn several_servers_serve_at_once_and_the_ids_of_a_stopped_one_read_closed() {
    let first = running(r#"{"threads":1}"#);
    let second = running(r#"{"threads":1}"#);
    assert_ne!(first.worker, second.worker);
    let (mut first_client, first_slot) = lease(&first);
    let (mut second_client, second_slot) = lease(&second);
    answer(&first, first_slot, b"one");
    answer(&second, second_slot, b"two");
    assert_eq!(first_client.read().unwrap().text(), "one");
    assert_eq!(second_client.read().unwrap().text(), "two");

    let (_held, held_slot) = lease(&first);
    ok(zero_server_shutdown(first.server, ZERO_NONE));
    assert_eq!(
        zero_server_wait(first.server, 0),
        ZeroStatus::InvalidArgument,
        "a wait on the thread bound to the server's target"
    );
    ok(zero_target_detach(first.target));
    ok(zero_server_wait(first.server, 30_000));
    assert_eq!(route_of(first_slot), ZeroStatus::Closed);
    assert_eq!(route_of(held_slot), ZeroStatus::Closed);
    assert_eq!(zero_target_wake(first.target), ZeroStatus::Closed);
    let mut address_out = ptr::null_mut();
    // SAFETY: `address_out` is a writable pointer.
    let listening = unsafe { zero_server_address(first.server, &mut address_out) };
    assert_eq!(listening, ZeroStatus::Closed);
    ok(zero_server_free(first.server));
    assert_eq!(zero_server_start(first.server), ZeroStatus::Closed);

    let third = running(r#"{"threads":1}"#);
    let (mut third_client, third_slot) = lease(&third);
    assert_eq!(
        route_of(first_slot),
        ZeroStatus::Closed,
        "an id of the stopped server"
    );
    assert_ne!(third_slot, first_slot);
    answer(&third, third_slot, b"three");
    assert_eq!(third_client.read().unwrap().text(), "three");

    let (mut again, again_slot) = lease(&second);
    answer(&second, again_slot, b"still");
    assert_eq!(again.read().unwrap().text(), "still");

    for server in [&second, &third] {
        ok(zero_target_detach(server.target));
        stop_elsewhere(server.server);
        ok(zero_server_free(server.server));
    }
    for app in [first.app, second.app, third.app] {
        ok(zero_app_free(app));
    }
}

#[test]
fn a_server_shut_down_with_leased_slots_stops_within_its_drain() {
    let server = running(r#"{"threads":1,"drainMs":500}"#);
    let (mut client, slot) = lease(&server);
    let (_other, unanswered) = lease(&server);
    stop_elsewhere(server.server);
    assert_eq!(route_of(slot), ZeroStatus::Closed);
    assert_eq!(route_of(unanswered), ZeroStatus::Closed);
    assert_eq!(zero_res_send(slot), ZeroStatus::Closed);
    assert_eq!(poll(server.target, 0).err(), Some(ZeroStatus::Closed));
    assert!(client.read().is_err() || client.read().is_ok_and(|reply| reply.status >= 500));
    ok(zero_target_detach(server.target));
    ok(zero_server_free(server.server));
    ok(zero_app_free(server.app));
}

#[test]
fn a_running_server_is_not_freed() {
    let server = running(r#"{"threads":1}"#);
    assert_eq!(zero_server_free(server.server), ZeroStatus::Limit);
    ok(zero_target_detach(server.target));
    assert_eq!(zero_server_free(server.server), ZeroStatus::Limit);
    stop_elsewhere(server.server);
    ok(zero_server_free(server.server));
    assert_eq!(zero_server_free(server.server), ZeroStatus::Closed);
    ok(zero_app_free(server.app));
}
