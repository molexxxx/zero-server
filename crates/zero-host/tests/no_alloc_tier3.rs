//! The counting-allocator check of tier 3: once warm, a request leased to the host
//! makes no call to the global allocator on the worker thread over its whole round
//! trip, from the parse and the export through the batch that posts it, the import of
//! the host's response, the write and the retirement, to the release of its index at
//! the acknowledgment.
//!
//! The target records the worker thread's allocation count each time the worker posts
//! a batch, into room reserved up front, so the target allocates nothing itself; the
//! host is the test thread, whose allocations are not the worker's. Requests go one
//! at a time over one connection, so the count at one post minus the count at the post
//! before is what one whole request cost the worker. The arena hands its indexes out
//! in FIFO order, and each index's buffers reach their size on its first lease, so the
//! warm-up leases every index of the first chunk twice before the count starts.
//!
//! On the `io-compio` backend the driver allocates one record per operation it owns,
//! so there the cost is the same small number for every warm request, which the test
//! asserts and prints instead of zero, as the driver's own no-allocation test does.

mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use support::Client;
use zero_host::{
    access, bind_thread, complete, read_batch, App, BatchRef, Method, Post, RouteKind, Server,
    ServerOptions, Target, MAX_BATCH,
};
use zero_sys::alloc::Counting;

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// Requests before the count starts: every index of the first 256-slot chunk, twice.
const WARM_UP: usize = 600;

/// Requests counted.
const COUNTED: usize = 300;

/// The field line of every response.
const FIELDS: [(&[u8], &[u8]); 1] = [(b"Content-Type", b"text/plain")];

/// What the worker posted: the batches and its allocation count at each post.
struct Posted {
    batches: VecDeque<BatchRef>,
    counts: Vec<u64>,
}

/// A target that allocates nothing when posted to.
struct CountingTarget {
    posted: Mutex<Posted>,
    ready: Condvar,
}

impl Target for CountingTarget {
    fn post(&self, batch: BatchRef) -> Post {
        let allocations = Counting::allocations();
        let mut posted = self.posted.lock().unwrap();
        if posted.counts.len() == posted.counts.capacity()
            || posted.batches.len() == posted.batches.capacity()
        {
            return Post::Full;
        }
        posted.counts.push(allocations);
        posted.batches.push_back(batch);
        drop(posted);
        self.ready.notify_one();
        Post::Taken
    }
}

impl CountingTarget {
    fn new(posts: usize) -> Self {
        CountingTarget {
            posted: Mutex::new(Posted {
                batches: VecDeque::with_capacity(16),
                counts: Vec::with_capacity(posts),
            }),
            ready: Condvar::new(),
        }
    }

    /// The oldest batch posted, waiting up to ten seconds for one.
    fn take(&self) -> BatchRef {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut posted = self.posted.lock().unwrap();
        loop {
            if let Some(batch) = posted.batches.pop_front() {
                return batch;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "no batch arrived");
            posted = self.ready.wait_timeout(posted, left).unwrap().0;
        }
    }

    fn counts(&self) -> Vec<u64> {
        self.posted.lock().unwrap().counts.clone()
    }
}

#[test]
fn a_warm_tier_3_request_makes_no_global_allocation_on_the_worker_thread() {
    let mut app = App::new();
    app.route(RouteKind::Host, Some(Method::Get), "/t3", b"")
        .unwrap();
    let server = Server::new(&app, ServerOptions::parse(br#"{"threads":1}"#).unwrap()).unwrap();
    let worker = server.workers()[0];
    let target = Arc::new(CountingTarget::new(WARM_UP + COUNTED + 16));
    server.attach(worker, target.clone()).unwrap();
    server.start().unwrap();
    bind_thread(worker).unwrap();

    let mut client = Client::connect(&server);
    let mut slots = vec![0u64; MAX_BATCH];
    let mut routes = vec![0u32; MAX_BATCH];
    for _ in 0..WARM_UP + COUNTED {
        client.send_get("/t3");
        let batch = target.take();
        let count = read_batch(batch, &mut slots, &mut routes).unwrap();
        for &id in &slots[..count] {
            access::respond(id, 200, FIELDS, b"ok").unwrap();
        }
        complete(worker, &slots[..count], batch.epoch, None).unwrap();
        let reply = client.read().unwrap();
        assert_eq!((reply.status, reply.body.as_slice()), (200, &b"ok"[..]));
    }

    let counts = target.counts();
    assert_eq!(counts.len(), WARM_UP + COUNTED, "one batch per request");
    assert!(
        counts[WARM_UP] > counts[0],
        "the first leases of the arena's indexes allocate, so the worker's count moves during the warm-up ({} to {})",
        counts[0],
        counts[WARM_UP]
    );
    let per_request: Vec<u64> = counts[WARM_UP..]
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .collect();
    let compio = std::any::type_name::<zero_io::rt::Config>().contains("compio");
    let expected = if compio {
        let first = per_request[0];
        eprintln!("allocations per warm tier 3 request on io-compio: {first}");
        first
    } else {
        0
    };
    for (index, delta) in per_request.iter().enumerate() {
        assert_eq!(
            *delta,
            expected,
            "warm request {} allocated {delta} times on the worker thread (counts from the first warm request: {:?})",
            index + 1,
            &counts[WARM_UP..]
        );
    }
    server.detach(worker).unwrap();
    server.shutdown();
    server.wait(Some(Duration::from_secs(20))).unwrap();
}
