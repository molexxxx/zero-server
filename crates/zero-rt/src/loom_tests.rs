//! loom models of the slot protocol, compiled only with `--cfg zero_loom`.
//!
//! Each model runs the crate's own `SlotWord`, `Slot`, `Arena`, `Allocator`, `Intake`
//! and the dispatcher's publish step over loom's atomics and locks, with a payload
//! behind the real lock and a view of two loom atomics: `tag`, and `buffer`, which
//! export sets to the request's tag and a release overwrites with poison, the
//! stand-in for the buffers a C view points into being given back. Reading `buffer`
//! after an accessor returned is the stand-in for a host dereferencing a view.
//! Acknowledgments come only from the host thread bound to the target. Run with
//! `RUSTFLAGS="--cfg zero_loom" LOOM_MAX_PREEMPTIONS=3 cargo test -p zero-rt --release
//! --lib loom_`.

use std::collections::VecDeque;
use std::future::{poll_fn, Future};
use std::pin::pin;
use std::sync::Arc as StdArc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::Instant;

use loom::sync::atomic::AtomicBool;
use loom::thread;

use zero_core::SlotId;

use crate::alloc::Allocator;
use crate::arena::{Arena, Payload, Reset};
use crate::dispatch::{
    Counters, DispatchLimits, Dispatcher, Failure, Job, Parts, Post, Sealed, Target, Waiters,
};
use crate::intake::Intake;
use crate::ring::{BatchRef, BatchRing};
use crate::slot::{Refused, SlotState};
use crate::sync::{Arc, AtomicU64, Mutex, Ordering};

const TAG_A: u64 = 0xA;
const TAG_B: u64 = 0xB;
const POISON: u64 = u64::MAX;

/// The payload behind the slot's lock: the request's tag and what hosts appended.
#[derive(Debug, Default)]
struct TestPayload {
    tag: u64,
    appended: Vec<u64>,
}

impl Reset for TestPayload {}

/// The published view.
#[derive(Debug, Default)]
struct TestView {
    tag: AtomicU64,
    buffer: AtomicU64,
}

impl Payload for TestPayload {
    type View = TestView;

    fn release(&mut self, view: &TestView, _cold: bool) -> u64 {
        self.tag = 0;
        self.appended.clear();
        view.buffer.store(POISON, Ordering::Release);
        0
    }
}

/// A target whose queue the bound host thread pops, the shape of both real targets.
#[derive(Debug, Default)]
struct ModelTarget {
    queue: Mutex<VecDeque<BatchRef>>,
}

impl Target for ModelTarget {
    fn post(&self, batch: BatchRef) -> Post {
        self.queue.lock().unwrap().push_back(batch);
        Post::Taken
    }
}

impl ModelTarget {
    /// The bound host thread waits for the next batch.
    fn pop(&self) -> BatchRef {
        loop {
            if let Some(batch) = self.queue.lock().unwrap().pop_front() {
                return batch;
            }
            thread::yield_now();
        }
    }
}

/// The waiter table: one entry per request future, sealed or not.
#[derive(Debug, Default)]
struct ModelWaiters {
    waiting: Vec<(SlotId, bool)>,
}

impl ModelWaiters {
    fn is_sealed(&self, id: SlotId) -> bool {
        self.waiting
            .iter()
            .any(|&(waiting, sealed)| waiting == id && sealed)
    }
}

impl Waiters for ModelWaiters {
    fn sealed(&mut self, id: SlotId) -> Sealed {
        match self.waiting.iter_mut().find(|(waiting, _)| *waiting == id) {
            Some(entry) => {
                entry.1 = true;
                Sealed::Woken
            }
            None => Sealed::Stale,
        }
    }

    fn posted(&mut self, _id: SlotId) {}

    fn fail(&mut self, id: SlotId, _failure: Failure) -> bool {
        self.waiting.retain(|(waiting, _)| *waiting != id);
        true
    }

    fn late(&mut self, _id: SlotId) -> bool {
        true
    }

    fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }
}

/// What the worker and the hosts share: one worker index with a one-slot arena.
struct World {
    arena: Arena<TestPayload>,
    intake: Intake,
    ring: BatchRing,
    target: StdArc<ModelTarget>,
}

impl World {
    fn new() -> Arc<Self> {
        Arc::new(World {
            arena: Arena::new(0, 1, 1).unwrap(),
            intake: Intake::new(),
            ring: BatchRing::new(1, 1),
            target: StdArc::new(ModelTarget::default()),
        })
    }

    fn slot(&self) -> &crate::arena::Slot<TestPayload> {
        self.arena.slot(0).unwrap()
    }

    /// The bound host's side of one request batch: pop it, read the id out of the
    /// ring.
    fn receive(&self) -> (BatchRef, SlotId) {
        let batch = self.target.pop();
        let raw = self.ring.read(batch, |ids, _| ids[0]).unwrap();
        (batch, SlotId::from_raw(raw).unwrap())
    }

    /// Seal the response of `id` under the lock.
    fn seal(&self, id: SlotId) {
        let sealed = self.slot().with_write(id.generation(), |payload| {
            assert_eq!(payload.tag, TAG_A, "a write into another request");
            payload.appended.push(1);
        });
        assert_eq!(sealed, Ok(()));
    }

    /// A view snapshot of generation 0, both atomics.
    fn snapshot(&self) -> Result<(u64, u64), Refused> {
        self.slot().read_view(0, |view| {
            (
                view.tag.load(Ordering::Acquire),
                view.buffer.load(Ordering::Acquire),
            )
        })
    }

    /// `buffer`, read after an accessor returned: what a host dereferencing a view
    /// pointer would see.
    fn buffer(&self) -> u64 {
        self.slot().view().buffer.load(Ordering::Acquire)
    }
}

/// The worker's own state: the allocator, the dispatcher and the waiter table.
struct Worker {
    alloc: Allocator,
    dispatcher: Dispatcher<()>,
    waiters: ModelWaiters,
}

impl Worker {
    fn new(world: &World) -> Self {
        let limits = DispatchLimits {
            batch: 1,
            in_flight: 1,
            queued: 1,
        };
        let mut worker = Worker {
            alloc: Allocator::new(),
            dispatcher: Dispatcher::new(limits, StdArc::new(Counters::default())),
            waiters: ModelWaiters::default(),
        };
        world.intake.attach(world.target.clone());
        worker.turn(world);
        worker
    }

    fn turn(&mut self, world: &World) {
        let mut parts = Parts {
            arena: &world.arena,
            alloc: &mut self.alloc,
            intake: &world.intake,
            ring: &world.ring,
            waiters: &mut self.waiters,
        };
        self.dispatcher.turn(&mut parts, Instant::now());
    }

    /// Allocate, export `tag` into the payload and the view under one lock
    /// acquisition, and hold the slot.
    fn export(&mut self, world: &World, tag: u64) -> Option<SlotId> {
        let (id, mut payload, _) = self.alloc.allocate(&world.arena).ok()?;
        let slot = world.arena.lookup(id).unwrap();
        payload.tag = tag;
        slot.view().tag.store(tag, Ordering::Release);
        slot.view().buffer.store(tag, Ordering::Release);
        slot.word().hold(id.generation()).unwrap();
        drop(payload);
        Some(id)
    }

    /// Queue `id` and run the turn that leases it and posts its batch.
    fn dispatch(&mut self, world: &World, id: SlotId) {
        self.waiters.waiting.push((id, false));
        self.dispatcher.push(Job { slot: id, route: 0 }, None);
        self.turn(world);
    }

    /// Sleep on the intake until the completion of `id` arrives.
    fn wait_sealed(&mut self, world: &World, id: SlotId) {
        block_on(poll_fn(|cx| loop {
            self.turn(world);
            if self.waiters.is_sealed(id) {
                return Poll::Ready(());
            }
            if !world.intake.register(cx.waker()) {
                return Poll::Pending;
            }
        }));
    }

    /// The import of a sealed response, then the retirement once no pin is counted.
    fn import_and_retire(&mut self, world: &World, id: SlotId) {
        let slot = world.slot();
        slot.word().begin_import(id.generation()).unwrap();
        loop {
            match slot.with_worker(id.generation(), |payload, _| payload.appended.len()) {
                Ok(appended) => {
                    assert_eq!(appended, 1, "the sealed response is imported whole");
                    break;
                }
                Err(Refused::Busy) => thread::yield_now(),
                Err(refused) => panic!("import refused: {refused:?}"),
            }
        }
        loop {
            match self
                .alloc
                .retire(&world.arena, id, world.intake.published())
            {
                Ok(()) => break,
                Err(Refused::Readers(_)) => thread::yield_now(),
                Err(refused) => panic!("retire refused: {refused:?}"),
            }
        }
        self.waiters.waiting.retain(|(waiting, _)| *waiting != id);
    }

    /// Release the quarantine and export the next request as soon as the index comes
    /// back: sleeping on the intake while the quarantine waits for the
    /// acknowledgment, and trying again while a host whose id just went stale holds
    /// the released index's lock for a moment.
    fn reexport(&mut self, world: &World, tag: u64) -> SlotId {
        block_on(poll_fn(|cx| loop {
            self.turn(world);
            if let Some(id) = self.export(world, tag) {
                return Poll::Ready(id);
            }
            if self.alloc.quarantined() == 0 {
                thread::yield_now();
                continue;
            }
            if !world.intake.register(cx.waker()) {
                return Poll::Pending;
            }
        }))
    }
}

/// A worker-held slot at generation 0 with tag A, through the plain allocator.
fn held(world: &World, alloc: &mut Allocator) -> SlotId {
    let (id, mut payload, _) = alloc.allocate(&world.arena).unwrap();
    let slot = world.arena.lookup(id).unwrap();
    payload.tag = TAG_A;
    slot.view().tag.store(TAG_A, Ordering::Release);
    slot.view().buffer.store(TAG_A, Ordering::Release);
    slot.word().hold(id.generation()).unwrap();
    drop(payload);
    id
}

/// Wakes a modeled thread parked in [`block_on`].
struct Unpark(thread::Thread);

impl Wake for Unpark {
    fn wake(self: StdArc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &StdArc<Self>) {
        self.0.unpark();
    }
}

/// Drive `future` on the current modeled thread, parking it while the future is
/// pending: a wake that is lost leaves the thread parked, which loom reports.
fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(StdArc::new(Unpark(thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
            return output;
        }
        thread::park();
    }
}

/// Run `model` over every interleaving within three preemptions.
fn check(model: impl Fn() + Sync + Send + 'static) {
    let mut builder = loom::model::Builder::new();
    builder.preemption_bound = Some(3);
    builder.max_threads = 4;
    builder.check(model);
}

#[test]
fn loom_stale_id_never_reads_another_request() {
    check(|| {
        let world = World::new();
        let mut worker = Worker::new(&world);
        let a = worker.export(&world, TAG_A).unwrap();
        let host = {
            let world = world.clone();
            thread::spawn(move || {
                let (batch, id) = world.receive();
                world.seal(id);
                assert_eq!(world.intake.complete([id], batch.epoch), Ok(()));
            })
        };
        let reader = {
            let world = world.clone();
            thread::spawn(move || {
                let slot = world.slot();
                for _ in 0..2 {
                    if let Ok(tag) = slot.with_read(0, |payload| payload.tag) {
                        assert_eq!(tag, TAG_A, "a locked read of another request");
                    }
                    if let Ok(snapshot) = world.snapshot() {
                        assert_eq!(snapshot, (TAG_A, TAG_A), "a view of another request");
                    }
                }
                if slot.word().pin(0).is_ok() {
                    assert_eq!(slot.word().generation(), 0, "retired while pinned");
                    assert_eq!(world.buffer(), TAG_A, "reused while pinned");
                    if let Ok(tag) = slot.with_read(0, |payload| payload.tag) {
                        assert_eq!(tag, TAG_A);
                    }
                    slot.word().unpin(0).unwrap();
                }
            })
        };
        worker.dispatch(&world, a);
        worker.wait_sealed(&world, a);
        worker.import_and_retire(&world, a);
        let b = worker.reexport(&world, TAG_B);
        assert_eq!(b.generation(), 1);
        worker.dispatch(&world, b);
        assert_eq!(world.slot().word().state(), SlotState::Leased);
        host.join().unwrap();
        reader.join().unwrap();
    });
}

#[test]
fn loom_view_after_return_stays_frozen_until_ack() {
    check(|| {
        let world = World::new();
        let mut worker = Worker::new(&world);
        let a = worker.export(&world, TAG_A).unwrap();
        let host = {
            let world = world.clone();
            thread::spawn(move || {
                let (batch, id) = world.receive();
                assert_eq!(world.snapshot(), Ok((TAG_A, TAG_A)));
                world.seal(id);
                // An asynchronous completion holds no place; the view is still the
                // host's until it acknowledges the batch that delivered it.
                assert_eq!(world.intake.complete([id], 0), Ok(()));
                assert_eq!(world.buffer(), TAG_A, "the view moved before the ack");
                assert_eq!(world.intake.complete([], batch.epoch), Ok(()));
            })
        };
        worker.dispatch(&world, a);
        worker.wait_sealed(&world, a);
        worker.import_and_retire(&world, a);
        let b = worker.reexport(&world, TAG_B);
        assert_eq!(world.intake.acked(), 1, "reused only after the ack");
        assert_eq!(b.generation(), 1);
        host.join().unwrap();
    });
}

#[test]
fn loom_pinned_view_stays_frozen_until_unpin() {
    check(|| {
        let world = World::new();
        let mut worker = Worker::new(&world);
        let a = worker.export(&world, TAG_A).unwrap();
        let host = {
            let world = world.clone();
            thread::spawn(move || {
                let (batch, id) = world.receive();
                world.seal(id);
                assert_eq!(world.intake.complete([id], batch.epoch), Ok(()));
            })
        };
        let unbound = {
            let world = world.clone();
            thread::spawn(move || {
                let word = world.slot().word();
                if word.pin(0).is_ok() {
                    assert_eq!(world.snapshot(), Ok((TAG_A, TAG_A)));
                    assert_eq!(world.buffer(), TAG_A, "the pinned view was reused");
                    word.unpin(0).unwrap();
                }
            })
        };
        worker.dispatch(&world, a);
        worker.wait_sealed(&world, a);
        worker.import_and_retire(&world, a);
        let b = worker.reexport(&world, TAG_B);
        assert_eq!(b.generation(), 1);
        host.join().unwrap();
        unbound.join().unwrap();
    });
}

#[test]
fn loom_ack_before_post_returns() {
    check(|| {
        let world = World::new();
        let mut worker = Worker::new(&world);
        let a = worker.export(&world, TAG_A).unwrap();
        let host = {
            let world = world.clone();
            thread::spawn(move || {
                let (batch, id) = world.receive();
                assert_eq!(
                    world.intake.complete([id], batch.epoch),
                    Ok(()),
                    "an acknowledgment that may precede the post's return is accepted"
                );
            })
        };
        worker.dispatch(&world, a);
        worker.wait_sealed(&world, a);
        host.join().unwrap();
        worker.turn(&world);
        assert_eq!(world.intake.acked(), 1);
        assert_eq!(worker.dispatcher.in_flight(), 0);
        assert!(worker.waiters.is_sealed(a), "the completion was applied");
    });
}

#[test]
fn loom_view_never_mixes_generations() {
    check(|| {
        let world = World::new();
        let mut alloc = Allocator::new();
        let a = held(&world, &mut alloc);
        world.slot().word().lease(0).unwrap();
        let reader = {
            let world = world.clone();
            thread::spawn(move || {
                for _ in 0..2 {
                    if let Ok(snapshot) = world.snapshot() {
                        assert_eq!(snapshot, (TAG_A, TAG_A), "a snapshot mixed generations");
                    }
                    thread::yield_now();
                }
            })
        };
        let word = world.slot().word();
        word.begin_import(0).unwrap();
        alloc.retire(&world.arena, a, 0).unwrap();
        alloc.release(&world.arena, 0);
        let (b, mut payload, _) = alloc.allocate(&world.arena).unwrap();
        payload.tag = TAG_B;
        world.slot().view().tag.store(TAG_B, Ordering::Release);
        world.slot().view().buffer.store(TAG_B, Ordering::Release);
        word.hold(b.generation()).unwrap();
        drop(payload);
        word.lease(b.generation()).unwrap();
        reader.join().unwrap();
    });
}

#[test]
fn loom_close_and_seal_race_once() {
    check(|| {
        let world = World::new();
        let mut alloc = Allocator::new();
        let a = held(&world, &mut alloc);
        world.slot().word().lease(0).unwrap();
        let closed = Arc::new(AtomicBool::new(false));
        let host = {
            let (world, closed) = (world.clone(), closed.clone());
            thread::spawn(move || {
                let after_close = closed.load(Ordering::Acquire);
                let written = world
                    .slot()
                    .with_write(0, |payload| payload.appended.push(1));
                if after_close {
                    assert!(written.is_err(), "a write after the close was accepted");
                }
            })
        };
        let reader = {
            let world = world.clone();
            thread::spawn(move || {
                if let Ok(tag) = world.slot().with_read(0, |payload| payload.tag) {
                    assert_eq!(tag, TAG_A);
                }
            })
        };
        let word = world.slot().word();
        word.close_leased(0).unwrap();
        closed.store(true, Ordering::Release);
        // The lease guard's drop and an orphaned completion both try to retire.
        let retired = [
            alloc.retire(&world.arena, a, 0),
            alloc.retire(&world.arena, a, 0),
        ];
        assert_eq!(retired.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(retired[1], Err(Refused::Stale));
        host.join().unwrap();
        reader.join().unwrap();
        assert_eq!(word.generation(), 1, "retired exactly once");
        assert_eq!(alloc.quarantined(), 1);
    });
}

#[test]
fn loom_response_writes_are_serialized() {
    check(|| {
        let world = World::new();
        let mut alloc = Allocator::new();
        let a = held(&world, &mut alloc);
        world.slot().word().lease(0).unwrap();
        let writers: Vec<_> = [1u64, 2]
            .into_iter()
            .map(|writer| {
                let world = world.clone();
                thread::spawn(move || {
                    let _ = world.slot().with_write(0, |payload| {
                        payload.appended.push(writer);
                        payload.appended.push(writer);
                    });
                })
            })
            .collect();
        world.slot().word().begin_import(0).unwrap();
        let seen = loop {
            match world
                .slot()
                .with_worker(a.generation(), |payload, _| payload.appended.clone())
            {
                Ok(seen) => break seen,
                Err(Refused::Busy) => thread::yield_now(),
                Err(refused) => panic!("import refused: {refused:?}"),
            }
        };
        assert!(seen.len() <= 4);
        for pair in seen.chunks(2) {
            assert_eq!(pair.len(), 2, "an append was cut: {seen:?}");
            assert_eq!(pair[0], pair[1], "appends interleaved: {seen:?}");
        }
        for writer in writers {
            writer.join().unwrap();
        }
    });
}

#[test]
fn loom_intake_loses_no_completion() {
    check(|| {
        let intake = Arc::new(Intake::new());
        intake.publish(1);
        intake.publish(2);
        let id = |index| SlotId::new(0, 0, index).unwrap();
        let bound = {
            let intake = intake.clone();
            thread::spawn(move || {
                assert_eq!(intake.complete([id(1)], 1), Ok(()));
                assert_eq!(intake.complete([id(2)], 2), Ok(()));
                assert_eq!(
                    intake.complete([id(5)], 3),
                    Err(Refused::Stale),
                    "epoch 3 was never published"
                );
            })
        };
        let other = {
            let intake = intake.clone();
            thread::spawn(move || {
                assert_eq!(intake.complete([id(3), id(4)], 0), Ok(()));
            })
        };
        let mut seen = Vec::new();
        let mut drained = Vec::new();
        block_on(poll_fn(|cx| loop {
            let _ = intake.drain(&mut drained);
            seen.extend(drained.drain(..));
            if seen.len() >= 5 {
                return Poll::Ready(());
            }
            if !intake.register(cx.waker()) {
                return Poll::Pending;
            }
        }));
        seen.sort_unstable();
        let expected: Vec<u64> = (1..=5).map(|index| id(index).as_u64()).collect();
        assert_eq!(seen, expected, "every id once, the refused call's included");
        bound.join().unwrap();
        other.join().unwrap();
        assert_eq!(intake.acked(), 2);
    });
}

#[test]
fn loom_epoch_gate_holds_reuse() {
    check(|| {
        let world = World::new();
        let mut alloc = Allocator::new();
        let a = held(&world, &mut alloc);
        let word = world.slot().word();
        word.lease(0).unwrap();
        word.begin_import(0).unwrap();
        world.intake.publish(1);
        world.intake.publish(2);
        let host = {
            let world = world.clone();
            thread::spawn(move || {
                assert_eq!(world.intake.complete([], 1), Ok(()));
                assert_eq!(world.intake.complete([], 2), Ok(()));
            })
        };
        alloc.retire(&world.arena, a, 2).unwrap();
        let mut reused = false;
        for _ in 0..3 {
            let acked = world.intake.acked();
            alloc.release(&world.arena, acked);
            if let Ok((b, guard, _)) = alloc.allocate(&world.arena) {
                drop(guard);
                assert!(acked >= 2, "handed out at floor {acked}");
                assert_eq!(b.generation(), 1);
                reused = true;
                break;
            }
            assert!(acked < 2, "held back at floor {acked}");
            thread::yield_now();
        }
        host.join().unwrap();
        if !reused {
            alloc.release(&world.arena, world.intake.acked());
            assert!(alloc.allocate(&world.arena).is_ok(), "released once acked");
        }
    });
}

#[test]
fn loom_pin_blocks_retire() {
    check(|| {
        let world = World::new();
        let mut alloc = Allocator::new();
        let a = held(&world, &mut alloc);
        let word = world.slot().word();
        word.lease(0).unwrap();
        word.begin_import(0).unwrap();
        let pinner = {
            let world = world.clone();
            thread::spawn(move || {
                let word = world.slot().word();
                match word.pin(0) {
                    Ok(()) => {
                        assert_eq!(word.generation(), 0, "retired while pinned");
                        assert_eq!(word.state(), SlotState::Completing);
                        word.unpin(0).unwrap();
                    }
                    Err(refused) => {
                        assert_eq!(refused, Refused::Stale, "a pin after the retire");
                        assert_eq!(word.generation(), 1);
                    }
                }
            })
        };
        loop {
            match alloc.retire(&world.arena, a, 0) {
                Ok(()) => break,
                Err(Refused::Readers(readers)) => {
                    assert!(readers > 0);
                    thread::yield_now();
                }
                Err(refused) => panic!("retire refused: {refused:?}"),
            }
        }
        assert_eq!(word.readers(), 0);
        pinner.join().unwrap();
    });
}
