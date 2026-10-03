//! The counting-allocator check of the dispatcher: once warm, whole rounds of tier 3
//! requests make no call to the global allocator on the worker thread, from the
//! export through the turn that leases and posts them, the host's seal, completion
//! and acknowledgment, the drain, the import and the retirement, to the release.
//! The first drain after the arena grows makes none either, because the turn that
//! sees the grow reserves the intake's vectors for every slot.
//!
//! The test thread plays the worker and the host; the harness reserves its own
//! scratch vectors up front, so every allocation counted is the crate's.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use zero_core::SlotId;
use zero_rt::{
    Allocator, Arena, BatchRef, BatchRing, Counters, DispatchLimits, Dispatcher, Failure, Intake,
    Job, Parts, Payload, Post, Reset, Sealed, Target, Waiters,
};
use zero_sys::alloc::Counting;

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

/// The most slots the test arena holds.
const LIMIT: usize = 4_096;

/// A slot payload: the request's tag and whether the host sealed a response.
#[derive(Debug, Default)]
struct Exchange {
    tag: u64,
    sealed: bool,
}

impl Reset for Exchange {}

impl Payload for Exchange {
    type View = ();

    fn release(&mut self, (): &(), _cold: bool) -> u64 {
        self.reset();
        0
    }
}

/// A target that queues what it takes in a vector reserved for the in-flight bound.
struct Queue(Mutex<Vec<BatchRef>>);

impl Target for Queue {
    fn post(&self, batch: BatchRef) -> Post {
        self.0.lock().unwrap().push(batch);
        Post::Taken
    }
}

/// The waiter table, one entry per arena index.
struct Table {
    entries: Vec<Option<(SlotId, bool)>>,
    waiting: usize,
}

impl Waiters for Table {
    fn sealed(&mut self, id: SlotId) -> Sealed {
        match self.entries.get_mut(usize::from(id.index())) {
            Some(Some((waiting, sealed))) if *waiting == id => {
                *sealed = true;
                Sealed::Woken
            }
            _ => Sealed::Stale,
        }
    }

    fn posted(&mut self, _id: SlotId) {}

    fn fail(&mut self, _id: SlotId, _failure: Failure) -> bool {
        false
    }

    fn late(&mut self, _id: SlotId) -> bool {
        true
    }

    fn is_empty(&self) -> bool {
        self.waiting == 0
    }
}

/// One worker index's parts, a dispatcher over them, and the host's scratch space.
struct Harness {
    arena: Arena<Exchange>,
    alloc: Allocator,
    intake: Intake,
    ring: BatchRing,
    table: Table,
    dispatcher: Dispatcher<()>,
    target: Arc<Queue>,
    batches: Vec<BatchRef>,
    ids: Vec<u64>,
    live: Vec<SlotId>,
}

impl Harness {
    fn new() -> Self {
        let limits = DispatchLimits::DEFAULT;
        let harness = Harness {
            arena: Arena::new(0, 256, LIMIT).unwrap(),
            alloc: Allocator::new(),
            intake: Intake::new(),
            ring: BatchRing::new(limits.in_flight, limits.batch),
            table: Table {
                entries: vec![None; LIMIT],
                waiting: 0,
            },
            dispatcher: Dispatcher::new(limits, Arc::new(Counters::default())),
            target: Arc::new(Queue(Mutex::new(Vec::with_capacity(limits.in_flight)))),
            batches: Vec::with_capacity(limits.in_flight),
            ids: Vec::with_capacity(limits.batch),
            live: Vec::with_capacity(LIMIT),
        };
        harness
            .intake
            .attach(Arc::clone(&harness.target) as Arc<dyn Target>);
        harness
    }

    fn turn(&mut self) {
        let mut parts = Parts {
            arena: &self.arena,
            alloc: &mut self.alloc,
            intake: &self.intake,
            ring: &self.ring,
            waiters: &mut self.table,
        };
        self.dispatcher.turn(&mut parts, Instant::now());
    }

    /// Export `count` requests, queue them, and run the turn that posts them.
    fn post(&mut self, count: usize) {
        for route in 0..count {
            let (id, mut guard, _) = self.alloc.allocate(&self.arena).unwrap();
            guard.tag = id.as_u64();
            self.arena
                .lookup(id)
                .unwrap()
                .word()
                .hold(id.generation())
                .unwrap();
            drop(guard);
            let route = u32::try_from(route).unwrap();
            self.dispatcher.push(Job { slot: id, route }, None);
            self.table.entries[usize::from(id.index())] = Some((id, false));
            self.table.waiting += 1;
            self.live.push(id);
        }
        self.turn();
    }

    /// The host's side: seal every posted request, then complete each batch's ids
    /// and acknowledge it, in order.
    fn host(&mut self) {
        self.batches.clear();
        self.batches.append(&mut self.target.0.lock().unwrap());
        for &batch in &self.batches {
            self.ids.clear();
            let ids = &mut self.ids;
            self.ring
                .read(batch, |slots, _| ids.extend_from_slice(slots))
                .unwrap();
            for &raw in &self.ids {
                let id = SlotId::from_raw(raw).unwrap();
                let slot = self.arena.lookup(id).unwrap();
                let tag = slot
                    .with_write(id.generation(), |exchange| {
                        exchange.sealed = true;
                        exchange.tag
                    })
                    .unwrap();
                assert_eq!(tag, id.as_u64());
            }
            let completed = self.ids.iter().filter_map(|&raw| SlotId::from_raw(raw));
            self.intake.complete(completed, batch.epoch).unwrap();
        }
    }

    /// The futures: take each response back once woken, and retire the slot.
    fn finish(&mut self) {
        let stamp = self.intake.published();
        for &id in &self.live {
            let entry = self.table.entries[usize::from(id.index())].take();
            assert_eq!(entry, Some((id, true)), "the drain woke the future");
            let slot = self.arena.lookup(id).unwrap();
            slot.word().begin_import(id.generation()).unwrap();
            let sealed = slot.with_worker(id.generation(), |exchange, ()| exchange.sealed);
            assert_eq!(sealed, Ok(true));
            self.alloc.retire(&self.arena, id, stamp).unwrap();
        }
        self.table.waiting = 0;
        self.live.clear();
    }

    /// One round of `count` requests.
    ///
    /// Returns the allocations the thread made exporting and posting them, and
    /// those it made from the host's completion through the release.
    fn cycle(&mut self, count: usize) -> (u64, u64) {
        let ((), posting) = Counting::count(|| self.post(count));
        let ((), returning) = Counting::count(|| {
            self.host();
            self.turn();
            self.finish();
            self.turn();
        });
        assert_eq!(self.alloc.live(), 0);
        assert_eq!(self.alloc.quarantined(), 0);
        (posting, returning)
    }
}

#[test]
fn a_warm_dispatcher_makes_no_allocation() {
    let mut harness = Harness::new();
    for _ in 0..3 {
        harness.cycle(300);
    }
    for round in 0..20 {
        assert_eq!(harness.cycle(300), (0, 0), "round {round}");
    }
    let counters = harness.dispatcher.counters();
    assert_eq!(
        counters.batches.load(std::sync::atomic::Ordering::Relaxed),
        46
    );
    assert_eq!(
        counters.leased.load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[test]
fn the_first_drain_after_the_arena_grows_makes_no_allocation() {
    let mut harness = Harness::new();
    for _ in 0..3 {
        harness.cycle(300);
    }
    assert_eq!(harness.arena.capacity(), 512);
    let (posting, returning) = harness.cycle(600);
    assert_eq!(harness.arena.capacity(), 768);
    assert!(posting > 0, "the grow allocated a chunk");
    assert_eq!(
        returning, 0,
        "the completions of the grown arena fit the vectors reserved at the grow"
    );
    for round in 0..5 {
        assert_eq!(harness.cycle(600), (0, 0), "round {round}");
    }
}
