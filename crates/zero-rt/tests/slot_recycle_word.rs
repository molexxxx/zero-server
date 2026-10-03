//! The slot protocol under real threads, for ThreadSanitizer: one worker recycles a
//! single slot while two readers and a completer hold ids that go stale under them.
//!
//! The worker exports a tag derived from the generation, leases, imports and retires
//! the slot 100,000 times. The readers read under the lock, through the published
//! view, and through a pin; the completer seals the response under the lock. Every
//! read that succeeds must carry the tag of the generation its id names, and a
//! pinned read must never see the poison the release writes, which is what keeps a
//! stale id from reading another request's data. Each kind of access must succeed
//! at least once, so an accessor that refused everything would fail rather than
//! check nothing. Ignored by default, since it is slow under the sanitizer; run it
//! with `-- --include-ignored slot_recycle`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use zero_core::SlotId;
use zero_rt::{Allocator, Arena, Payload, Refused, Reset};

const ITERATIONS: u32 = 100_000;
/// What a release writes into the view: the stand-in for buffers given back.
const POISON: u64 = u64::MAX;
/// How many times the worker yields for the completer before it imports anyway.
const SEAL_PATIENCE: u32 = 16;

/// The request's tag and the response's seal.
#[derive(Debug, Default)]
struct TestPayload {
    tag: u64,
    sealed: bool,
}

impl Reset for TestPayload {}

/// The published view: the tag, and a value a release overwrites with poison.
#[derive(Debug, Default)]
struct TestView {
    tag: AtomicU64,
    buffer: AtomicU64,
}

impl Payload for TestPayload {
    type View = TestView;

    fn release(&mut self, view: &TestView, _cold: bool) -> u64 {
        self.reset();
        view.tag.store(POISON, Ordering::Release);
        view.buffer.store(POISON, Ordering::Release);
        0
    }
}

/// The tag a generation's request carries: never 0 and never the poison.
fn tag_of(generation: u32) -> u64 {
    u64::from(generation) * 2 + 1
}

/// The slot, the id the worker published last, and the counts of what succeeded.
struct Shared {
    arena: Arena<TestPayload>,
    current: AtomicU64,
    sealed: AtomicU64,
    done: AtomicBool,
    reads: AtomicU64,
    views: AtomicU64,
    pins: AtomicU64,
    seals: AtomicU64,
}

impl Shared {
    fn current(&self) -> Option<SlotId> {
        match self.current.load(Ordering::Acquire) {
            0 => None,
            raw => SlotId::from_raw(raw - 1),
        }
    }
}

/// Sets `done` when the worker returns or panics, so the other threads stop.
struct Finish<'a>(&'a AtomicBool);

impl Drop for Finish<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn worker(shared: &Shared) {
    let _finish = Finish(&shared.done);
    let arena = &shared.arena;
    let mut alloc = Allocator::new();
    for _ in 0..ITERATIONS {
        alloc.release(arena, 0);
        // The only slot's lock may be held by a reader whose id just went stale; the
        // allocator skips it rather than wait, so the worker tries again.
        let (id, mut payload, _) = loop {
            match alloc.allocate(arena) {
                Ok(claimed) => break claimed,
                Err(_) => thread::yield_now(),
            }
        };
        let generation = id.generation();
        let slot = arena.lookup(id).unwrap();
        payload.tag = tag_of(generation);
        slot.view().tag.store(tag_of(generation), Ordering::Release);
        slot.view()
            .buffer
            .store(tag_of(generation), Ordering::Release);
        slot.word().hold(generation).unwrap();
        drop(payload);
        shared.current.store(id.as_u64() + 1, Ordering::Release);
        slot.word().lease(generation).unwrap();
        for _ in 0..SEAL_PATIENCE {
            if shared.sealed.load(Ordering::Acquire) == id.as_u64() + 1 {
                break;
            }
            thread::yield_now();
        }
        slot.word().begin_import(generation).unwrap();
        loop {
            let imported = slot.with_worker(generation, |payload, view| {
                assert_eq!(payload.tag, tag_of(generation));
                assert_eq!(view.buffer.load(Ordering::Acquire), tag_of(generation));
                payload.sealed
            });
            match imported {
                Ok(_) => break,
                Err(Refused::Busy) => thread::yield_now(),
                Err(refused) => panic!("import refused: {refused:?}"),
            }
        }
        loop {
            match alloc.retire(arena, id, 0) {
                Ok(()) => break,
                Err(Refused::Readers(_)) => thread::yield_now(),
                Err(refused) => panic!("retire refused: {refused:?}"),
            }
        }
    }
}

fn reader(shared: &Shared) {
    while !shared.done.load(Ordering::Acquire) {
        let Some(id) = shared.current() else {
            thread::yield_now();
            continue;
        };
        let generation = id.generation();
        let slot = shared.arena.lookup(id).unwrap();
        if let Ok(tag) = slot.with_read(generation, |payload| payload.tag) {
            assert_eq!(tag, tag_of(generation), "a locked read of another request");
            shared.reads.fetch_add(1, Ordering::Relaxed);
        }
        let snapshot = slot.read_view(generation, |view| {
            (
                view.tag.load(Ordering::Acquire),
                view.buffer.load(Ordering::Acquire),
            )
        });
        if let Ok(snapshot) = snapshot {
            assert_eq!(
                snapshot,
                (tag_of(generation), tag_of(generation)),
                "a view snapshot of another request"
            );
            shared.views.fetch_add(1, Ordering::Relaxed);
        }
        if slot.word().pin(generation).is_ok() {
            let buffer = slot.view().buffer.load(Ordering::Acquire);
            assert_eq!(buffer, tag_of(generation), "a pinned view was reused");
            slot.word().unpin(generation).unwrap();
            shared.pins.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn completer(shared: &Shared) {
    while !shared.done.load(Ordering::Acquire) {
        let Some(id) = shared.current() else {
            thread::yield_now();
            continue;
        };
        let generation = id.generation();
        let slot = shared.arena.lookup(id).unwrap();
        let sealed = slot.with_write(generation, |payload| {
            assert_eq!(
                payload.tag,
                tag_of(generation),
                "a write into another request"
            );
            payload.sealed = true;
        });
        if sealed.is_ok() {
            shared.sealed.store(id.as_u64() + 1, Ordering::Release);
            shared.seals.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[test]
#[ignore = "a sanitizer workload: run with --include-ignored slot_recycle"]
fn slot_recycle_word_race() {
    let shared = Arc::new(Shared {
        arena: Arena::new(0, 1, 1).unwrap(),
        current: AtomicU64::new(0),
        sealed: AtomicU64::new(0),
        done: AtomicBool::new(false),
        reads: AtomicU64::new(0),
        views: AtomicU64::new(0),
        pins: AtomicU64::new(0),
        seals: AtomicU64::new(0),
    });
    let spawn = |role: fn(&Shared)| {
        let shared = Arc::clone(&shared);
        thread::spawn(move || role(&shared))
    };
    let threads = [
        spawn(reader),
        spawn(reader),
        spawn(completer),
        spawn(worker),
    ];
    for thread in threads {
        thread.join().unwrap();
    }
    let slot = shared.arena.slot(0).unwrap();
    assert_eq!(
        slot.word().generation(),
        ITERATIONS,
        "every iteration retired the slot once"
    );
    assert_eq!(slot.word().readers(), 0);
    let counts = [
        ("locked reads", shared.reads.load(Ordering::Relaxed)),
        ("view snapshots", shared.views.load(Ordering::Relaxed)),
        ("pinned reads", shared.pins.load(Ordering::Relaxed)),
        ("seals", shared.seals.load(Ordering::Relaxed)),
    ];
    for (access, count) in counts {
        assert!(
            count > 0,
            "no host access of this kind succeeded, so none was checked: {access}"
        );
    }
    println!(
        "{ITERATIONS} recycles: {} locked reads, {} view snapshots, {} pinned reads, {} seals",
        counts[0].1, counts[1].1, counts[2].1, counts[3].1,
    );
}
