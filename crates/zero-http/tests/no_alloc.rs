//! The counting-allocator criterion of R.3 step 5: on a warm core, a tier 4 request
//! makes no call to the global allocator on the whole path, from the read through
//! the parse, the route, the handler, the serializer and the write.
//!
//! The handler reports the core thread's allocation count in a header; the count
//! grows between the first and the second request while buffers and records reach
//! their capacity, and not at all between later requests on the same connection.
//!
//! On the `io-compio` backend the driver itself allocates one record per
//! operation it owns (compio-driver's proactor "owns the operations"), so there
//! the count grows by the same small number on every warm request, which the test
//! asserts and prints instead of zero; the number is recorded in the status file.

#![cfg(any(feature = "io-tokio", feature = "io-compio"))]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use zero_core::Error;
use zero_date::Decimal;
use zero_http::{serve, Call, Config, Handler, Router};
use zero_http_types::Method;
use zero_sys::alloc::Counting;

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// A routed application: the request goes through the router before the handler.
struct Counter {
    router: Router<u8>,
}

impl Counter {
    fn new() -> Self {
        let mut router = Router::new();
        router.route(Method::Get, "/plaintext", 1).unwrap();
        router.route(Method::Get, "/json", 2).unwrap();
        router.route(Method::Get, "/users/:id", 3).unwrap();
        Counter { router }
    }
}

impl Handler for Counter {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        let count = Decimal::new(Counting::allocations());
        let mut response = call.response();
        response.header(b"X-Allocations", count.as_bytes())?;
        response.content_type(b"text/plain")?;
        match routed.descriptor {
            1 => response.body(b"Hello, World!"),
            _ => response.body(b"other"),
        };
        Ok(())
    }
}

fn allocations_of(conn: &mut TcpStream) -> u64 {
    conn.write_all(b"GET /plaintext HTTP/1.1\r\nHost: t\r\n\r\n")
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        assert_eq!(conn.read(&mut byte).unwrap(), 1);
        head.push(byte[0]);
    }
    let text = String::from_utf8(head).unwrap();
    let mut body = [0u8; 13];
    conn.read_exact(&mut body).unwrap();
    assert_eq!(&body, b"Hello, World!");
    text.lines()
        .find_map(|line| line.strip_prefix("X-Allocations: "))
        .unwrap()
        .parse()
        .unwrap()
}

#[test]
fn a_tier_4_request_on_a_warm_core_makes_no_global_allocation() {
    let config = Config {
        runtime: zero_rt::Config {
            io: zero_io::rt::Config {
                threads: 1,
                drain: Duration::from_secs(1),
                ..zero_io::rt::Config::default()
            },
        },
        server: Some("zero".to_owned()),
        ..Config::default()
    };
    let workers = serve(
        "127.0.0.1:0".parse().unwrap(),
        config,
        Arc::new(|_| {}),
        |_| Counter::new(),
    )
    .unwrap();
    let mut conn = TcpStream::connect(workers.local_addr()).unwrap();
    conn.set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    conn.set_nodelay(true).unwrap();
    // Warm up: the record, the receive block and the response buffers grow once.
    let first = allocations_of(&mut conn);
    let second = allocations_of(&mut conn);
    let counts: Vec<u64> = (0..16).map(|_| allocations_of(&mut conn)).collect();
    assert!(second >= first);
    let per_request: Vec<u64> = counts.windows(2).map(|pair| pair[1] - pair[0]).collect();
    let expected = if cfg!(feature = "io-compio") {
        let first_delta = per_request[0];
        eprintln!("allocations per warm request on io-compio: {first_delta}");
        first_delta
    } else {
        0
    };
    for (index, delta) in per_request.iter().enumerate() {
        assert_eq!(
            *delta, expected,
            "request {} of the warm run allocated {delta} times against {expected} (counts {counts:?}, warm-up {first}, {second})",
            index + 4
        );
    }
    workers.stop().unwrap();
}
