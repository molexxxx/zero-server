//! The calls a host thread reads a leased request and answers it with: the view rule
//! (the target thread's batch window, pins, and the refusals outside both), the
//! response writers with their status range and field rules (RFC 9110 Sections 15,
//! 15.2 and 5.3), body regions, the error writer in both error shapes, the counting of
//! host body writes, and the answer to a batch a binding gives up on.

mod support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use support::{eventually, ids, start, stop, Client, Reply, TestTarget};
use zero_core::SlotId;
use zero_host::access::{self, Access, FieldMode, MAX_PINS};
use zero_host::{
    bind_thread, complete, App, BatchRef, Method, RouteKind, Server, ServerOptions, Status,
};
use zero_http::ExternalBody;
use zero_http_types::HeaderName;

/// No field lines.
const NONE: [(&[u8], &[u8]); 0] = [];

/// A host route at `GET /items/:id`, and its route id.
fn app() -> (App, u32) {
    let mut app = App::new();
    let items = app
        .route(RouteKind::Host, Some(Method::Get), "/items/:id", b"")
        .unwrap();
    (app, items)
}

/// Attach a test target to the server's only worker index and bind the calling thread
/// to it.
fn attached(server: &Server) -> (u8, Arc<TestTarget>) {
    let worker = server.workers()[0];
    let target = TestTarget::new(8);
    server.attach(worker, target.clone()).unwrap();
    bind_thread(worker).unwrap();
    (worker, target)
}

/// Send `GET /items/<item>` with an `X-Nonce` field on a new connection and take the
/// batch that leases it.
fn lease(server: &Server, target: &TestTarget, item: &str) -> (Client, u64, BatchRef) {
    let mut client = Client::connect(server);
    client.send(
        format!("GET /items/{item} HTTP/1.1\r\nHost: t\r\nX-Nonce: n-{item}\r\n\r\n").as_bytes(),
    );
    let batch = target.take();
    let id = ids(batch)[0];
    (client, id, batch)
}

/// Lease `count` requests, one per connection, acknowledging each batch so the bound
/// on batches in flight never holds the rest back.
fn lease_many(
    server: &Server,
    target: &TestTarget,
    worker: u8,
    count: usize,
) -> (Vec<Client>, Vec<u64>) {
    let clients: Vec<Client> = (0..count)
        .map(|item| {
            let mut client = Client::connect(server);
            client.send_get(&format!("/items/{item}"));
            client
        })
        .collect();
    let mut slots = Vec::with_capacity(count);
    while slots.len() < count {
        let batch = target.take();
        slots.extend(ids(batch));
        complete(worker, &[], batch.epoch, None).unwrap();
    }
    (clients, slots)
}

/// The status a refused call ended with.
fn refusal<T: std::fmt::Debug>(outcome: Result<T, Access>) -> Status {
    outcome.expect_err("the call is refused").status()
}

/// A field line from two strings.
fn field<'a>(name: &'a str, value: &'a str) -> (&'a [u8], &'a [u8]) {
    (name.as_bytes(), value.as_bytes())
}

/// The values of every field line of `name`, in order.
fn lines<'a>(reply: &'a Reply, name: &str) -> Vec<&'a str> {
    reply
        .headers
        .iter()
        .filter(|(line, _)| line.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
        .collect()
}

/// A body another owner keeps.
struct Kept(Vec<u8>);

impl ExternalBody for Kept {
    fn bytes(&self) -> &[u8] {
        &self.0
    }
}

#[test]
fn the_target_thread_reads_views_from_the_delivery_of_a_batch_until_it_acknowledges_it() {
    let (app, items) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut first, one, first_batch) = lease(&server, &target, "1");
    let (mut second, two, second_batch) = lease(&server, &target, "22");
    assert!(second_batch.epoch > first_batch.epoch);

    for (id, item) in [(one, "1"), (two, "22")] {
        let view = access::with_view(id, |view| *view).unwrap();
        assert_eq!((view.route, view.param_count), (items, 1));
        assert!(!view.head.is_null());
        let param = access::with_pinned_read(id, |exchange| {
            exchange.request().param(0).map(<[u8]>::to_vec)
        })
        .unwrap();
        assert_eq!(param.as_deref(), Some(item.as_bytes()));
    }

    complete(worker, &[], first_batch.epoch, None).unwrap();
    assert_eq!(
        refusal(access::with_view(one, |_| ())),
        Status::InvalidArgument,
        "the first batch is acknowledged"
    );
    assert_eq!(
        refusal(access::with_pinned_read(one, |_| ())),
        Status::InvalidArgument
    );
    assert!(
        access::with_view(two, |_| ()).is_ok(),
        "the second batch is not acknowledged yet"
    );
    assert_eq!(
        access::with_read(one, |exchange| exchange.route()),
        Ok(items),
        "a read under the lock needs no window"
    );
    assert_eq!(
        access::with_values(one, |values| (values.route, values.head.is_null())),
        Ok((items, true)),
        "the values need no window and carry no pointer"
    );
    access::pin(one).unwrap();
    assert!(
        access::with_view(one, |_| ()).is_ok(),
        "a pin opens the view again"
    );
    access::unpin(one).unwrap();

    complete(worker, &[], second_batch.epoch, None).unwrap();
    assert_eq!(
        refusal(access::with_view(two, |_| ())),
        Status::InvalidArgument
    );

    for (client, id, body) in [(&mut first, one, "one"), (&mut second, two, "two")] {
        access::respond(id, 200, NONE, body.as_bytes()).unwrap();
        complete(worker, &[id], 0, None).unwrap();
        assert_eq!(client.read().unwrap().text(), body);
    }
    stop(&server);
}

#[test]
fn a_thread_outside_the_batch_window_reads_views_only_while_it_holds_a_pin() {
    let (app, items) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "7");
    let counted = server.clone();
    thread::spawn(move || {
        assert_eq!(
            refusal(access::with_view(id, |_| ())),
            Status::InvalidArgument
        );
        assert_eq!(
            refusal(access::with_pinned_read(id, |_| ())),
            Status::InvalidArgument
        );
        assert_eq!(access::with_values(id, |values| values.route), Ok(items));
        let nonce = access::with_read(id, |exchange| {
            exchange.request().header(b"x-nonce").map(<[u8]>::to_vec)
        })
        .unwrap();
        assert_eq!(nonce.as_deref(), Some(&b"n-7"[..]));
        assert_eq!(
            refusal(access::unpin(id)),
            Status::InvalidArgument,
            "no pin yet"
        );

        access::pin(id).unwrap();
        assert_eq!(counted.stats().pinned, 1);
        assert_eq!(
            refusal(access::pin(id)),
            Status::InvalidArgument,
            "pinned already"
        );
        assert_eq!(
            access::with_view(id, |view| (view.route, view.param_count)),
            Ok((items, 1))
        );
        let param = access::with_pinned_read(id, |exchange| {
            exchange.request().param(0).map(<[u8]>::to_vec)
        })
        .unwrap();
        assert_eq!(param.as_deref(), Some(&b"7"[..]));
        access::unpin(id).unwrap();
        assert_eq!(counted.stats().pinned, 0);
        assert_eq!(refusal(access::unpin(id)), Status::InvalidArgument);
        assert_eq!(
            refusal(access::with_view(id, |_| ())),
            Status::InvalidArgument
        );
    })
    .join()
    .unwrap();
    access::respond(id, 200, NONE, b"ok").unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().text(), "ok");
    stop(&server);
}

/// A detach ends the window of the target's thread at once, and until the worker settled
/// the lost target no thread has one, a thread that bound since the detach included:
/// that thread is the target thread of the next target only.
#[cfg(feature = "testing")]
#[test]
fn a_detach_ends_the_target_threads_window_for_a_thread_bound_since_the_detach_too() {
    use std::sync::mpsc;
    use zero_host::testing::hold_dispatcher;

    /// What a thread saw of one slot: its view's route and parameter count, and its
    /// parameter through a read the view rule governs.
    type Seen = (Result<(u32, u32), Status>, Result<Option<Vec<u8>>, Status>);

    let (app, items) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut client, lost, _) = lease(&server, &target, "40");
    assert!(
        access::with_view(lost, |_| ()).is_ok(),
        "the target thread's window"
    );
    hold_dispatcher(&server, worker, true).unwrap();
    server.detach(worker).unwrap();
    assert_eq!(
        refusal(access::with_view(lost, |_| ())),
        Status::InvalidArgument,
        "the detach unbound the target's thread"
    );
    let (ask, asked) = mpsc::channel::<(u64, u64)>();
    let (tell, told) = mpsc::channel::<Seen>();
    let next = thread::spawn(move || {
        bind_thread(worker).unwrap();
        for (id, epoch) in asked {
            let view = access::with_view(id, |view| (view.route, view.param_count));
            let param = access::with_pinned_read(id, |exchange| {
                exchange.request().param(0).map(<[u8]>::to_vec)
            });
            if epoch != 0 {
                access::respond(id, 200, NONE, b"next").unwrap();
                complete(worker, &[id], epoch, None).unwrap();
            }
            let seen = (view.map_err(Access::status), param.map_err(Access::status));
            tell.send(seen).unwrap();
        }
    });
    ask.send((lost, 0)).unwrap();
    assert_eq!(
        told.recv().unwrap(),
        (Err(Status::InvalidArgument), Err(Status::InvalidArgument)),
        "a thread bound while the worker has not applied the detach reads no view of the lost target's slot"
    );
    hold_dispatcher(&server, worker, false).unwrap();
    assert_eq!(client.read().unwrap().status, 503);

    let replacement = TestTarget::new(8);
    server.attach(worker, replacement.clone()).unwrap();
    let (mut client, id, batch) = lease(&server, &replacement, "41");
    ask.send((id, batch.epoch)).unwrap();
    assert_eq!(
        told.recv().unwrap(),
        (Ok((items, 1)), Ok(Some(b"41".to_vec()))),
        "the thread bound since the detach is the next target's thread"
    );
    assert_eq!(client.read().unwrap().text(), "next");
    drop(ask);
    next.join().unwrap();
    stop(&server);
}

#[test]
fn a_thread_holds_at_most_64_pins() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut clients, slots) = lease_many(&server, &target, worker, MAX_PINS + 1);
    for &id in &slots[..MAX_PINS] {
        access::pin(id).unwrap();
    }
    assert_eq!(server.stats().pinned, 64);
    assert_eq!(refusal(access::pin(slots[MAX_PINS])), Status::Limit);
    access::unpin(slots[0]).unwrap();
    access::pin(slots[MAX_PINS]).unwrap();
    for &id in &slots[1..] {
        access::unpin(id).unwrap();
    }
    assert_eq!(server.stats().pinned, 0);
    for &id in &slots {
        access::respond(id, 204, NONE, b"").unwrap();
    }
    complete(worker, &slots, 0, None).unwrap();
    for client in &mut clients {
        assert_eq!(client.read().unwrap().status, 204);
    }
    stop(&server);
}

#[test]
fn a_thread_that_exits_holding_pins_counts_them_out() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "3");
    thread::spawn(move || access::pin(id).unwrap())
        .join()
        .unwrap();
    assert_eq!(
        server.stats().pinned,
        0,
        "the exiting thread counted its pin out"
    );
    access::respond(id, 200, NONE, b"done").unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().text(), "done");
    eventually("the slot to retire", || {
        access::with_read(id, |_| ()).is_err()
    });
    stop(&server);
}

#[test]
fn a_body_region_needs_a_pin_and_refuses_every_other_body_write_while_it_is_open() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1,"maxResponseBody":64}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "5");
    assert_eq!(
        refusal(access::body_alloc(id, 16)),
        Status::InvalidArgument,
        "a region needs the thread's pin"
    );
    access::pin(id).unwrap();
    assert_eq!(refusal(access::body_alloc(id, 65)), Status::Limit);
    let region = access::body_alloc(id, 16).unwrap();
    assert!(!region.is_null());
    assert_eq!(
        refusal(access::body_alloc(id, 16)),
        Status::InvalidArgument,
        "one region per slot"
    );
    let refused = [
        ("body", access::body(id, b"x")),
        ("json", access::json(id, b"{}")),
        ("respond", access::respond(id, 200, NONE, b"x")),
        (
            "respond_external",
            access::respond_external(id, 200, NONE, Arc::new(Kept(b"x".to_vec()))),
        ),
        ("reset", access::reset(id)),
        ("error", access::error(id, 500, b"FAILED", None, None)),
        ("writable", access::writable(id)),
    ];
    for (call, outcome) in refused {
        assert_eq!(refusal(outcome), Status::InvalidArgument, "{call}");
    }
    access::status(id, 201).unwrap();
    access::header(id, b"X-Region", b"yes", FieldMode::Append).unwrap();
    access::send(id).unwrap();
    assert_eq!(
        refusal(access::body_alloc(id, 16)),
        Status::Closed,
        "sealed"
    );
    complete(worker, &[id], batch.epoch, None).unwrap();
    eventually("the import to wait for the pin", || {
        server.stats().late_readers >= 1
    });
    access::unpin(id).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(reply.status, 201);
    assert_eq!(reply.header("x-region"), Some("yes"));
    assert_eq!(
        reply.body,
        vec![0u8; 16],
        "a region the host left unwritten is zeros"
    );
    stop(&server);
}

/// A region no buffer can hold is refused as over the limit, even under a limit of
/// `u64::MAX`, the way a region the allocator refuses is: the slot's lock is not
/// poisoned and the body written before is left as it was. Both lengths exceed
/// `isize::MAX`, so the refusal comes before any call to the allocator, which a
/// sanitizer would end the process on.
#[test]
fn a_body_region_the_allocator_cannot_give_is_refused_and_leaves_the_body_as_it_was() {
    let (app, _) = app();
    let mut options = ServerOptions::parse(br#"{"threads":1}"#).unwrap();
    options.max_response_body = u64::MAX;
    let server = Server::new(&app, options).unwrap();
    server.start().unwrap();
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "60");
    access::body(id, b"kept").unwrap();
    access::pin(id).unwrap();
    for len in [usize::MAX, usize::try_from(isize::MAX).unwrap() + 1] {
        assert_eq!(
            refusal(access::body_alloc(id, len)),
            Status::Limit,
            "{len} octets"
        );
    }
    access::unpin(id).unwrap();
    access::send(id).unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().text(), "kept");
    stop(&server);
}

/// RFC 9110 Section 15: "All valid status codes are within the range of 100 to 599,
/// inclusive." Section 15.2: "a server MUST NOT send a 1xx response to an HTTP/1.0
/// client", and 100 comes from the driver and 101 only from an accepted upgrade, so a
/// host sets 200 to 599 only, and a refused status leaves the response as it was.
#[test]
fn a_host_cannot_set_an_out_of_range_or_informational_status() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);

    let (mut client, id, batch) = lease(&server, &target, "15");
    for refused in [
        1,
        99,
        100,
        101,
        102,
        103,
        150,
        199,
        600,
        700,
        999,
        1_000,
        u16::MAX,
    ] {
        assert_eq!(
            refusal(access::status(id, refused)),
            Status::InvalidArgument,
            "{refused}"
        );
        assert_eq!(
            refusal(access::respond(id, refused, NONE, b"")),
            Status::InvalidArgument,
            "{refused}"
        );
    }
    assert_eq!(refusal(access::status(id, 0)), Status::InvalidArgument);
    access::respond(id, 0, NONE, b"untouched").unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(
        (reply.status, reply.text().as_str()),
        (200, "untouched"),
        "no refused status was stored"
    );

    let (mut client, id, batch) = lease(&server, &target, "16");
    for accepted in [200, 299, 300, 404, 500, 599] {
        access::status(id, accepted).unwrap();
    }
    access::status(id, 203).unwrap();
    access::respond(id, 0, NONE, b"kept").unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!((reply.status, reply.text().as_str()), (203, "kept"));
    stop(&server);
}

/// RFC 9110 Section 5.3: `Set-Cookie` "often appears in a response message across
/// multiple field lines and does not use the list syntax", and RFC 6265bis Section 3:
/// "Origin servers and intermediaries MUST NOT combine multiple Set-Cookie header
/// fields into a single header field." Each appended value leaves as its own line,
/// commas inside a value included.
#[test]
fn appended_set_cookie_values_leave_as_separate_field_lines() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "31");
    access::header(id, b"Set-Cookie", b"a=1; Path=/", FieldMode::Append).unwrap();
    access::header(
        id,
        b"set-cookie",
        b"b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
        FieldMode::Append,
    )
    .unwrap();
    access::respond(id, 200, [field("Set-Cookie", "c=3")], b"cookies").unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(
        lines(&reply, "set-cookie"),
        [
            "a=1; Path=/",
            "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
            "c=3"
        ]
    );
    stop(&server);
}

#[test]
fn field_writes_refuse_invalid_names_and_values_and_the_fields_the_driver_writes() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "9");
    let refused: [(&[u8], &[u8]); 9] = [
        (b"", b"v"),
        (b"Bad Name", b"v"),
        (b"X-Split", b"one\r\nInjected: 1"),
        (b"X-Padded", b" padded"),
        (b"X-Nul", b"nul\0"),
        (b"Content-Length", b"5"),
        (b"connection", b"close"),
        (b"Transfer-Encoding", b"chunked"),
        (b"DATE", b"Wed, 21 Oct 2026 07:28:00 GMT"),
    ];
    for (name, value) in refused {
        for mode in [FieldMode::Set, FieldMode::Append] {
            assert_eq!(
                refusal(access::header(id, name, value, mode)),
                Status::InvalidArgument,
                "{:?}",
                String::from_utf8_lossy(name)
            );
        }
    }
    let date = u32::from(HeaderName::Date.id());
    let content_type = u32::from(HeaderName::ContentType.id());
    assert_eq!(
        refusal(access::header_id(id, 999, b"v", FieldMode::Append)),
        Status::InvalidArgument
    );
    assert_eq!(
        refusal(access::header_id(id, date, b"v", FieldMode::Set)),
        Status::InvalidArgument
    );
    assert_eq!(
        refusal(access::header_id(id, content_type, b"a\nb", FieldMode::Set)),
        Status::InvalidArgument
    );
    assert_eq!(
        refusal(access::respond(
            id,
            200,
            [field("X-Good", "1"), field("X-Bad", "two\r\nlines")],
            b"refused"
        )),
        Status::InvalidArgument
    );

    access::header(id, b"Content-Type", b"text/plain", FieldMode::Append).unwrap();
    access::header_id(id, content_type, b"application/xml", FieldMode::Set).unwrap();
    access::header(id, b"X-Repeat", b"1", FieldMode::Append).unwrap();
    access::header(id, b"x-repeat", b"2", FieldMode::Append).unwrap();
    access::header(id, b"X-REPEAT", b"3", FieldMode::Set).unwrap();
    access::respond(id, 200, NONE, b"<ok/>").unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(lines(&reply, "content-type"), ["application/xml"]);
    assert_eq!(
        lines(&reply, "x-repeat"),
        ["3"],
        "set replaces every line of the name"
    );
    assert!(
        lines(&reply, "x-good").is_empty(),
        "the refused call wrote nothing"
    );
    assert!(lines(&reply, "injected").is_empty());
    stop(&server);
}

#[test]
fn respond_writes_the_status_fields_and_body_at_once_and_seals_the_response() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);

    let (mut client, id, batch) = lease(&server, &target, "10");
    access::header(id, b"X-Before", b"1", FieldMode::Append).unwrap();
    access::body(id, b"replaced").unwrap();
    access::respond(
        id,
        201,
        [field("Content-Type", "text/plain"), field("X-After", "2")],
        b"created",
    )
    .unwrap();
    let sealed = [
        ("status", access::status(id, 200)),
        (
            "header",
            access::header(id, b"X-Late", b"1", FieldMode::Append),
        ),
        ("body", access::body(id, b"late")),
        ("json", access::json(id, b"{}")),
        ("error", access::error(id, 500, b"LATE", None, None)),
        ("respond", access::respond(id, 200, NONE, b"late")),
        ("send", access::send(id)),
        ("reset", access::reset(id)),
        ("writable", access::writable(id)),
    ];
    for (call, outcome) in sealed {
        assert_eq!(refusal(outcome), Status::Closed, "{call} after the seal");
    }
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!((reply.status, reply.text().as_str()), (201, "created"));
    assert_eq!(reply.header("x-before"), Some("1"));
    assert_eq!(reply.header("x-after"), Some("2"));
    assert_eq!(reply.header("content-type"), Some("text/plain"));
    assert!(reply.header("x-late").is_none());

    let (mut client, id, batch) = lease(&server, &target, "11");
    access::header(id, b"Content-Type", b"text/plain", FieldMode::Append).unwrap();
    access::json(id, br#"{"ok":true}"#).unwrap();
    access::send(id).unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(lines(&reply, "content-type"), ["application/json"]);
    assert_eq!(reply.text(), r#"{"ok":true}"#);

    let (mut client, id, batch) = lease(&server, &target, "12");
    access::status(id, 404).unwrap();
    access::body(id, b"discarded").unwrap();
    access::reset(id).unwrap();
    access::respond_external(
        id,
        0,
        [field("X-Kept", "1")],
        Arc::new(Kept(b"kept".to_vec())),
    )
    .unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(
        (reply.status, reply.text().as_str()),
        (200, "kept"),
        "the reset discarded the status and the body"
    );
    assert_eq!(reply.header("x-kept"), Some("1"));
    stop(&server);
}

#[test]
fn a_body_longer_than_the_servers_response_limit_is_refused() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1,"maxResponseBody":64}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "13");
    let long = [b'x'; 65];
    assert_eq!(refusal(access::body(id, &long)), Status::Limit);
    assert_eq!(refusal(access::json(id, &long)), Status::Limit);
    assert_eq!(
        refusal(access::respond(id, 200, NONE, &long)),
        Status::Limit
    );
    assert_eq!(
        refusal(access::respond_external(
            id,
            200,
            NONE,
            Arc::new(Kept(long.to_vec()))
        )),
        Status::Limit
    );
    access::respond(id, 200, NONE, &long[..64]).unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().body.len(), 64);
    stop(&server);
}

#[test]
fn a_host_error_is_written_in_the_servers_error_shape_and_seals_the_response() {
    /// One host error and the answer it leaves as.
    struct Case<'a> {
        status: u16,
        code: &'a [u8],
        message: Option<&'a [u8]>,
        details: Option<&'a [u8]>,
        sent: u16,
        body: &'a str,
    }

    let (app, _) = app();
    let problem = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&problem);
    let cases = [
        Case {
            status: 404,
            code: b"ITEM_MISSING",
            message: Some(b"no item 9"),
            details: Some(br#"{"item":9}"#),
            sent: 404,
            body: r#"{"type":"about:blank","title":"Not Found","status":404,"code":"ITEM_MISSING","detail":"no item 9","details":{"item":9}}"#,
        },
        Case {
            status: 302,
            code: b"MOVED",
            message: None,
            details: Some(b"{malformed"),
            sent: 500,
            body: r#"{"type":"about:blank","title":"Internal Server Error","status":500,"code":"MOVED"}"#,
        },
        Case {
            status: 503,
            code: b"BUSY_2",
            message: Some(b"caf\xE9"),
            details: Some(b"\xEF\xBB\xBF[1,2]"),
            sent: 503,
            body: "{\"type\":\"about:blank\",\"title\":\"Service Unavailable\",\"status\":503,\"code\":\"BUSY_2\",\"detail\":\"caf\u{FFFD}\",\"details\":[1,2]}",
        },
        Case {
            status: 42,
            code: b"ODD",
            message: None,
            details: None,
            sent: 500,
            body: r#"{"type":"about:blank","title":"Internal Server Error","status":500,"code":"ODD"}"#,
        },
    ];
    for case in cases {
        let (mut client, id, batch) = lease(&problem, &target, "20");
        access::header(id, b"X-Dropped", b"1", FieldMode::Append).unwrap();
        access::error(id, case.status, case.code, case.message, case.details).unwrap();
        assert_eq!(
            refusal(access::status(id, 200)),
            Status::Closed,
            "the error seals"
        );
        complete(worker, &[id], batch.epoch, None).unwrap();
        let reply = client.read().unwrap();
        assert_eq!(reply.status, case.sent);
        assert_eq!(
            reply.header("content-type"),
            Some("application/problem+json")
        );
        assert!(
            reply.header("x-dropped").is_none(),
            "the error replaced the response"
        );
        assert_eq!(reply.text(), case.body);
    }
    let (mut client, id, batch) = lease(&problem, &target, "21");
    for code in [&b""[..], b"lower", b"WITH SPACE", b"DASH-ED", &[b'A'; 65]] {
        assert_eq!(
            refusal(access::error(id, 500, code, None, None)),
            Status::InvalidArgument,
            "{:?}",
            String::from_utf8_lossy(code)
        );
    }
    access::error(id, 500, &[b'A'; 64], None, None).unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    stop(&problem);

    let legacy = start(
        &app,
        r#"{"threads":1,"errorShape":"legacy","maxResponseBody":80}"#,
    );
    let (worker, target) = attached(&legacy);
    let long = [b'x'; 100];
    let cases = [
        Case {
            status: 422,
            code: b"INVALID",
            message: Some(b"bad field"),
            details: Some(br#"["name"]"#),
            sent: 422,
            body: r#"{"error":"bad field","code":"INVALID","statusCode":422,"details":["name"]}"#,
        },
        Case {
            status: 500,
            code: b"FAILED",
            message: None,
            details: None,
            sent: 500,
            body: r#"{"error":"Internal Server Error","code":"FAILED","statusCode":500}"#,
        },
        Case {
            status: 400,
            code: b"TOO_LONG",
            message: Some(&long),
            details: None,
            sent: 400,
            body: r#"{"error":"Bad Request","code":"TOO_LONG","statusCode":400}"#,
        },
    ];
    for case in cases {
        let (mut client, id, batch) = lease(&legacy, &target, "22");
        access::error(id, case.status, case.code, case.message, case.details).unwrap();
        complete(worker, &[id], batch.epoch, None).unwrap();
        let reply = client.read().unwrap();
        assert_eq!(reply.status, case.sent);
        assert_eq!(reply.header("content-type"), Some("application/json"));
        assert_eq!(reply.text(), case.body);
        assert!(reply.body.len() <= 80, "{}", reply.text());
    }
    stop(&legacy);
}

/// A server's own error shape and response limit reach the host calls, with no test
/// hook: building the server configures every worker index it claims.
#[test]
fn a_servers_error_shape_and_response_limit_reach_the_host_calls_on_its_worker_indexes() {
    let (app, _) = app();
    let options =
        ServerOptions::parse(br#"{"threads":1,"errorShape":"legacy","maxResponseBody":64}"#)
            .unwrap();
    let server = Server::new(&app, options).unwrap();
    server.start().unwrap();
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "90");
    assert_eq!(
        refusal(access::body(id, &[b'x'; 65])),
        Status::Limit,
        "a body over the server's limit"
    );
    access::body(id, &[b'x'; 64]).unwrap();
    access::error(
        id,
        404,
        b"MISSING",
        Some(b"no item with the id 90 exists here"),
        None,
    )
    .unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(reply.status, 404);
    assert_eq!(reply.header("content-type"), Some("application/json"));
    assert_eq!(
        reply.text(),
        r#"{"error":"Not Found","code":"MISSING","statusCode":404}"#,
        "the legacy shape, its message left out under the limit"
    );
    stop(&server);
}

/// The response limit bounds the error body as written, escapes included: the message is
/// kept when the body with it fits, the details when the body with them fits too, and
/// otherwise each is left out. A control character takes six octets in a JSON string
/// (RFC 8259 Section 7).
#[test]
fn an_error_body_with_its_escapes_stays_within_the_servers_response_limit() {
    /// A message, details, and the body the error leaves as.
    type Case<'a> = (Option<&'a [u8]>, Option<&'a [u8]>, &'a str);

    const BARE: &str =
        r#"{"type":"about:blank","title":"Internal Server Error","status":500,"code":"FAILED"}"#;
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1,"maxResponseBody":100}"#);
    let (worker, target) = attached(&server);
    let controls = [1u8; 100];
    let with_message = BARE.replace('}', r#","detail":"a\nb"}"#);
    let with_details = BARE.replace('}', r#","details":[1,2]}"#);
    let cases: [Case<'_>; 6] = [
        (Some(&controls), None, BARE),
        (Some(b"abcdef"), None, BARE),
        (Some(b"a\nb"), None, &with_message),
        (Some(b"a\nb"), Some(b"[1,2]"), &with_message),
        (None, Some(b"[1,2]"), &with_details),
        (Some(&controls), Some(b"[1,2]"), &with_details),
    ];
    for (message, details, body) in cases {
        let (mut client, id, batch) = lease(&server, &target, "50");
        access::error(id, 500, b"FAILED", message, details).unwrap();
        complete(worker, &[id], batch.epoch, None).unwrap();
        let reply = client.read().unwrap();
        assert_eq!(reply.text(), body);
        assert!(reply.body.len() <= 100, "{} octets", reply.body.len());
    }
    assert_eq!((with_message.len(), with_details.len()), (99, 99));
    stop(&server);
}

/// Under a limit smaller than the error's envelope the status, the reason phrase and the
/// code are still written, so an error always answers in the server's shape; only the
/// message and the details are left out.
#[test]
fn an_error_under_a_limit_smaller_than_its_envelope_writes_the_envelope_alone() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1,"maxResponseBody":10}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "51");
    access::error(id, 503, b"BUSY", Some(b"m"), Some(b"1")).unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    let reply = client.read().unwrap();
    assert_eq!(reply.status, 503);
    assert_eq!(
        reply.text(),
        r#"{"type":"about:blank","title":"Service Unavailable","status":503,"code":"BUSY"}"#
    );
    stop(&server);
}

/// Details are checked with zero-json's strict parser at its default limits, which bound
/// the value the check builds: up to 1 MiB and 64 levels of nesting they are kept, beyond
/// either they are left out like malformed details.
#[test]
fn error_details_are_kept_up_to_the_strict_parsers_default_size_and_depth() {
    use zero_json::parse::{DEFAULT_DEPTH, DEFAULT_SIZE};
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let string = |len: usize| {
        let mut text = vec![b'a'; len];
        text[0] = b'"';
        text[len - 1] = b'"';
        text
    };
    let nested = |depth: usize| [vec![b'['; depth], vec![b']'; depth]].concat();
    let cases = [
        (string(DEFAULT_SIZE), true),
        (string(DEFAULT_SIZE + 1), false),
        (nested(DEFAULT_DEPTH), true),
        (nested(DEFAULT_DEPTH + 1), false),
    ];
    for (details, kept) in cases {
        let (mut client, id, batch) = lease(&server, &target, "52");
        access::error(id, 422, b"INVALID", None, Some(&details)).unwrap();
        complete(worker, &[id], batch.epoch, None).unwrap();
        let reply = client.read().unwrap();
        assert_eq!(reply.status, 422);
        let member = [&b",\"details\":"[..], details.as_slice(), &b"}"[..]].concat();
        assert_eq!(
            reply.body.ends_with(&member),
            kept,
            "{} octets",
            details.len()
        );
        assert_eq!(reply.text().contains("\"details\""), kept);
    }
    stop(&server);
}

#[cfg(feature = "testing")]
#[test]
fn a_host_body_write_is_counted_on_the_exchange_and_the_core_until_the_import() {
    use zero_host::testing::inspect;
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let idle = server.stats().retained;
    let (mut client, id, batch) = lease(&server, &target, "14");
    let exported = inspect(id, |exchange| exchange.counted()).unwrap();
    let leased = server.stats().retained;
    access::body(id, &[7u8; 1_000]).unwrap();
    assert_eq!(
        inspect(id, |exchange| exchange.counted()),
        Ok(exported + 1_000)
    );
    assert_eq!(server.stats().retained, leased + 1_000);
    access::body(id, &[6u8; 1_000]).unwrap();
    assert_eq!(
        server.stats().retained,
        leased + 1_000,
        "a write that replaces the body is not counted again"
    );
    access::json(id, &[b'1'; 1_500]).unwrap();
    assert_eq!(
        server.stats().retained,
        leased + 1_500,
        "a longer body counts what it adds"
    );
    access::respond(id, 200, NONE, &[8u8; 500]).unwrap();
    assert_eq!(
        inspect(id, |exchange| exchange.counted()),
        Ok(exported + 1_500),
        "the exchange is counted for the longest body it held"
    );
    assert_eq!(server.stats().retained, leased + 1_500);
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().body, vec![8u8; 500]);
    eventually("the import and the release to give the octets back", || {
        server.stats().retained == idle
    });

    let (mut client, id, batch) = lease(&server, &target, "15");
    let leased = server.stats().retained;
    for round in 0..300u16 {
        let byte = u8::try_from(round % 251).unwrap();
        access::body(id, &[byte; 1_024]).unwrap();
    }
    assert_eq!(
        server.stats().retained,
        leased + 1_024,
        "300 writes of one 1,024-octet body hold one body"
    );
    access::error(id, 500, b"FAILED", None, None).unwrap();
    assert_eq!(server.stats().retained, leased + 1_024);
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().status, 500);
    eventually("the second exchange to give its octets back", || {
        server.stats().retained == idle
    });
    stop(&server);
}

#[cfg(feature = "testing")]
#[test]
fn abandon_batch_answers_each_unsealed_request_500_dispatch_failed_and_acknowledges_the_batch() {
    use zero_host::abandon_batch;
    use zero_host::testing::{allocator, hold_dispatcher};
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    hold_dispatcher(&server, worker, true).unwrap();
    let mut clients: Vec<Client> = (0..3)
        .map(|item| {
            let mut client = Client::connect(&server);
            client.send_get(&format!("/items/{item}"));
            client
        })
        .collect();
    eventually("the three requests to wait for the dispatcher", || {
        allocator(&server, worker).unwrap().live == 3
    });
    hold_dispatcher(&server, worker, false).unwrap();
    let batch = target.take();
    let slots = ids(batch);
    assert_eq!(slots.len(), 3, "one batch carries the three");
    access::respond(slots[0], 200, NONE, b"answered").unwrap();
    abandon_batch(batch).unwrap();
    let mut answered = 0;
    let mut failed = 0;
    for client in &mut clients {
        let reply = client.read().unwrap();
        if reply.status == 200 {
            assert_eq!(reply.text(), "answered");
            answered += 1;
        } else {
            assert_eq!(reply.status, 500);
            assert_eq!(
                reply.header("content-type"),
                Some("application/problem+json")
            );
            assert!(
                reply.text().contains(r#""code":"DISPATCH_FAILED""#),
                "{}",
                reply.text()
            );
            failed += 1;
        }
    }
    assert_eq!((answered, failed), (1, 2));
    assert_eq!(server.stats().abandoned_batches, 1);
    eventually("the acknowledgment to release the indexes", || {
        let state = allocator(&server, worker).unwrap();
        state.live == 0 && state.quarantined == 0
    });
    assert_eq!(server.stats().refused_acks, 0);

    let (mut client, _, batch) = lease(&server, &target, "9");
    let abandoned = thread::spawn(move || abandon_batch(batch).map_err(|err| err.status()))
        .join()
        .unwrap();
    assert_eq!(
        abandoned,
        Err(Status::InvalidArgument),
        "only the bound thread acknowledges"
    );
    assert_eq!(
        client.read().unwrap().status,
        500,
        "the answer went out regardless"
    );
    let stats = server.stats();
    assert_eq!((stats.abandoned_batches, stats.refused_acks), (2, 1));
    complete(worker, &[], batch.epoch, None).unwrap();
    stop(&server);
}

/// A request whose body region is open keeps it: the region is the pinning thread's
/// until it unpins, so the abandoned batch completes the request as written.
#[test]
fn abandon_batch_completes_a_request_with_an_open_body_region_as_written() {
    use zero_host::abandon_batch;
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (_, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "80");
    access::pin(id).unwrap();
    access::body_alloc(id, 4).unwrap();
    abandon_batch(batch).unwrap();
    access::unpin(id).unwrap();
    let reply = client.read().unwrap();
    assert_eq!((reply.status, reply.body), (200, vec![0u8; 4]));
    assert_eq!(server.stats().abandoned_batches, 1);
    stop(&server);
}

#[test]
fn every_call_refuses_a_stale_or_unknown_id_as_closed_and_one_above_2_53_as_invalid() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, batch) = lease(&server, &target, "8");
    access::respond(id, 200, NONE, b"gone").unwrap();
    complete(worker, &[id], batch.epoch, None).unwrap();
    assert_eq!(client.read().unwrap().text(), "gone");
    eventually("the slot to retire", || {
        access::with_read(id, |_| ()).is_err()
    });
    let unclaimed = SlotId::new(127, 0, 0).unwrap().as_u64();
    let content_type = u32::from(HeaderName::ContentType.id());
    let cases = [
        ("stale", id, Status::Closed),
        ("unclaimed worker", unclaimed, Status::Closed),
        ("2^53", 1u64 << 53, Status::InvalidArgument),
        ("u64::MAX", u64::MAX, Status::InvalidArgument),
    ];
    for (which, raw, expected) in cases {
        let outcomes = [
            access::with_read(raw, |_| ()),
            access::with_pinned_read(raw, |_| ()),
            access::with_view(raw, |_| ()),
            access::with_values(raw, |_| ()),
            access::pin(raw),
            access::canceled(raw).map(drop),
            access::status(raw, 200),
            access::header(raw, b"X-A", b"1", FieldMode::Append),
            access::header_id(raw, content_type, b"text/plain", FieldMode::Set),
            access::body(raw, b"x"),
            access::json(raw, b"{}"),
            access::error(raw, 500, b"GONE", None, None),
            access::body_alloc(raw, 1).map(drop),
            access::respond(raw, 200, NONE, b""),
            access::respond_external(raw, 200, NONE, Arc::new(Kept(Vec::new()))),
            access::send(raw),
            access::reset(raw),
            access::writable(raw),
        ];
        for (call, outcome) in outcomes.into_iter().enumerate() {
            assert_eq!(
                outcome.map_err(Access::status),
                Err(expected),
                "{which}: call {call}"
            );
        }
    }
    assert_eq!(refusal(access::unpin(u64::MAX)), Status::InvalidArgument);
    stop(&server);
}

#[test]
fn canceled_reports_a_lease_its_targets_loss_closed() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let (mut client, id, _) = lease(&server, &target, "6");
    assert_eq!(access::canceled(id), Ok(false));
    server.detach(worker).unwrap();
    eventually("the lease to close", || access::canceled(id) != Ok(false));
    assert!(
        matches!(
            access::canceled(id).map_err(Access::status),
            Ok(true) | Err(Status::Closed)
        ),
        "a closed lease is canceled until it retires, then stale"
    );
    assert_eq!(refusal(access::status(id, 200)), Status::Closed);
    assert_eq!(client.read().unwrap().status, 503);
    stop(&server);
}

/// A stale id is refused on one load of its slot's word, before the lock: a host that
/// keeps calling with the ids of finished requests never holds the lock the worker
/// takes to export a new request into the same index or to import its response. The
/// arena hands its indexes out in FIFO order, so 600 requests reuse every index of the
/// first chunk while the stale ids of its earlier leases are being read.
#[test]
fn a_host_looping_on_stale_ids_never_makes_an_export_fail_or_an_import_wait() {
    let (app, _) = app();
    let server = start(&app, r#"{"threads":1}"#);
    let (worker, target) = attached(&server);
    let stale: Arc<Mutex<Vec<u64>>> = Arc::default();
    let done = Arc::new(AtomicBool::new(false));
    let looping = {
        let stale = Arc::clone(&stale);
        let done = Arc::clone(&done);
        thread::spawn(move || {
            let mut calls = 0u64;
            while !done.load(Ordering::Acquire) {
                let ids = stale.lock().unwrap().clone();
                if ids.is_empty() {
                    thread::yield_now();
                }
                for id in ids {
                    assert_eq!(refusal(access::with_read(id, |_| ())), Status::Closed);
                    assert_eq!(refusal(access::with_view(id, |_| ())), Status::Closed);
                    assert_eq!(refusal(access::pin(id)), Status::Closed);
                    assert_eq!(refusal(access::status(id, 200)), Status::Closed);
                    calls += 4;
                }
            }
            calls
        })
    };
    let mut client = Client::connect(&server);
    for round in 0..600 {
        client.send_get(&format!("/items/{round}"));
        let batch = target.take();
        let id = ids(batch)[0];
        access::respond(id, 200, NONE, b"answered").unwrap();
        complete(worker, &[id], batch.epoch, None).unwrap();
        assert_eq!(client.read().unwrap().status, 200, "round {round}");
        stale.lock().unwrap().push(id);
    }
    done.store(true, Ordering::Release);
    assert!(looping.join().unwrap() > 0, "the stale ids were read");
    let stats = server.stats();
    assert_eq!(
        (stats.refused_503, stats.late_readers),
        (0, 0),
        "no export was refused and no import waited for a lock"
    );
    stop(&server);
}
