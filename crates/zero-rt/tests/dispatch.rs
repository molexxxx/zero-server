//! The dispatcher over a test target: batch assembly, the in-flight bound, ordered
//! acknowledgments, refused posts, admission, tombstones, kind alternation, the late
//! list, target loss, the leased gauge, and the dispatcher task, which returns once a
//! drain leaves nothing, open realtime connections included, and is woken by
//! completions from a foreign thread on either backend.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use zero_core::SlotId;
use zero_io::seam::Shutdown;
use zero_limits::services::MAX_BATCHES_IN_FLIGHT_CEILING;
use zero_rt::dispatch::{LATE_CEILING, LATE_FAST_FOR, LATE_FIRST};
use zero_rt::ring::{EVENTS, REQUESTS};
use zero_rt::{
    run, Admission, Allocator, Arena, BatchRef, BatchRing, Counters, DispatchLimits, Dispatcher,
    EventRec, Failure, Intake, Job, Kick, Late, Parts, Payload, Post, Refused, Reset, Sealed,
    SlotState, Target, Turned, Waiters,
};

/// A slot payload: the request's tag and whether the host sealed a response.
#[derive(Debug, Default)]
struct Exchange {
    tag: u64,
    sealed: bool,
}

impl Reset for Exchange {}

/// The published view: the request's tag.
#[derive(Debug, Default)]
struct View {
    tag: AtomicU64,
}

impl Payload for Exchange {
    type View = View;

    fn release(&mut self, view: &View, _cold: bool) -> u64 {
        self.reset();
        view.tag.store(0, Ordering::Release);
        0
    }
}

/// A read hold that counts how many are alive.
#[derive(Debug)]
struct Hold(Rc<Cell<usize>>);

impl Drop for Hold {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

/// A target that queues what it takes, answers from a script, and can acknowledge
/// each batch inside `post`, before `post` returns to the worker.
#[derive(Default)]
struct TestTarget {
    taken: Mutex<VecDeque<BatchRef>>,
    answers: Mutex<VecDeque<Post>>,
    acknowledge_inside: Option<Arc<Intake>>,
    inside: Mutex<Vec<Result<(), Refused>>>,
    notify: Mutex<Option<mpsc::Sender<BatchRef>>>,
}

impl TestTarget {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn answering(answers: &[Post]) -> Arc<Self> {
        let target = Self::default();
        target.answers.lock().unwrap().extend(answers);
        Arc::new(target)
    }

    fn take(&self) -> Option<BatchRef> {
        self.taken.lock().unwrap().pop_front()
    }

    fn taken(&self) -> Vec<BatchRef> {
        self.taken.lock().unwrap().iter().copied().collect()
    }
}

impl Target for TestTarget {
    fn post(&self, batch: BatchRef) -> Post {
        let answer = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Post::Taken);
        if answer == Post::Taken {
            if let Some(intake) = &self.acknowledge_inside {
                let outcome = intake.complete([], batch.epoch);
                self.inside.lock().unwrap().push(outcome);
            }
            self.taken.lock().unwrap().push_back(batch);
            if let Some(notify) = self.notify.lock().unwrap().as_ref() {
                let _ = notify.send(batch);
            }
        }
        answer
    }
}

/// Where a test request's future is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Queued,
    Posted,
    Sealed,
    Dropped,
}

/// The waiter table: one entry per request future.
#[derive(Debug, Default)]
struct TestWaiters {
    waiting: Vec<(SlotId, Stage)>,
    failed: Vec<(SlotId, Failure)>,
    late_settles: bool,
    late_polls: usize,
}

impl TestWaiters {
    fn stage(&self, id: SlotId) -> Option<Stage> {
        self.waiting
            .iter()
            .find(|(waiting, _)| *waiting == id)
            .map(|&(_, stage)| stage)
    }

    fn set(&mut self, id: SlotId, stage: Stage) {
        if let Some(entry) = self.waiting.iter_mut().find(|(waiting, _)| *waiting == id) {
            entry.1 = stage;
        }
    }

    fn remove(&mut self, id: SlotId) {
        self.waiting.retain(|(waiting, _)| *waiting != id);
    }
}

impl Waiters for TestWaiters {
    fn sealed(&mut self, id: SlotId) -> Sealed {
        match self.stage(id) {
            Some(Stage::Dropped) => {
                self.remove(id);
                Sealed::Orphan
            }
            Some(_) => {
                self.set(id, Stage::Sealed);
                Sealed::Woken
            }
            None => Sealed::Stale,
        }
    }

    fn posted(&mut self, id: SlotId) {
        self.set(id, Stage::Posted);
    }

    fn fail(&mut self, id: SlotId, failure: Failure) -> bool {
        match self.stage(id) {
            Some(Stage::Queued | Stage::Posted) => {
                self.remove(id);
                self.failed.push((id, failure));
                true
            }
            _ => false,
        }
    }

    fn late(&mut self, _id: SlotId) -> bool {
        self.late_polls += 1;
        self.late_settles
    }

    fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }
}

/// One worker index's parts and a dispatcher over them, on a fake clock.
struct Harness {
    arena: Arc<Arena<Exchange>>,
    alloc: Allocator,
    intake: Arc<Intake>,
    ring: Arc<BatchRing>,
    waiters: TestWaiters,
    dispatcher: Dispatcher<Hold>,
    holds: Rc<Cell<usize>>,
    now: Instant,
}

impl Harness {
    fn new(limits: DispatchLimits) -> Self {
        Self::over(
            Arc::new(Arena::new(2, 256, 65_536).unwrap()),
            Arc::new(Intake::new()),
            Arc::new(BatchRing::new(limits.in_flight, limits.batch)),
            limits,
        )
    }

    fn over(
        arena: Arc<Arena<Exchange>>,
        intake: Arc<Intake>,
        ring: Arc<BatchRing>,
        limits: DispatchLimits,
    ) -> Self {
        Harness {
            arena,
            alloc: Allocator::new(),
            intake,
            ring,
            waiters: TestWaiters::default(),
            dispatcher: Dispatcher::new(limits, Arc::new(Counters::default())),
            holds: Rc::new(Cell::new(0)),
            now: Instant::now(),
        }
    }

    fn limits(batch: usize, in_flight: usize) -> DispatchLimits {
        DispatchLimits {
            batch,
            in_flight,
            queued: 16,
        }
    }

    fn turn(&mut self) -> Turned {
        let mut parts = Parts {
            arena: &*self.arena,
            alloc: &mut self.alloc,
            intake: &self.intake,
            ring: &self.ring,
            waiters: &mut self.waiters,
        };
        self.dispatcher.turn(&mut parts, self.now)
    }

    fn attach(&mut self, target: Arc<TestTarget>) {
        self.intake.attach(target);
        self.turn();
    }

    /// Export a request tagged with its own id, hold it, and queue it.
    fn request(&mut self, route: u32) -> SlotId {
        let (id, mut payload, _) = self.alloc.allocate(&*self.arena).unwrap();
        payload.tag = id.as_u64();
        let slot = self.arena.lookup(id).unwrap();
        slot.view().tag.store(id.as_u64(), Ordering::Release);
        slot.word().hold(id.generation()).unwrap();
        drop(payload);
        self.holds.set(self.holds.get() + 1);
        self.dispatcher
            .push(Job { slot: id, route }, Some(Hold(Rc::clone(&self.holds))));
        self.waiters.waiting.push((id, Stage::Queued));
        id
    }

    fn event(&mut self, conn: u64) {
        let event = EventRec {
            conn,
            route: 7,
            kind: 2,
            opcode: 1,
            code: 0,
            data: vec![u8::try_from(conn).unwrap(); 3],
        };
        self.dispatcher.push_event(event).unwrap();
    }

    fn state(&self, id: SlotId) -> SlotState {
        self.arena.lookup(id).unwrap().word().state()
    }

    fn ids(&self, batch: BatchRef) -> Vec<SlotId> {
        self.ring
            .read(batch, |ids, _| ids.to_vec())
            .unwrap()
            .into_iter()
            .map(|raw| SlotId::from_raw(raw).unwrap())
            .collect()
    }

    /// The host's side of a request batch: seal every request, complete the ids, and
    /// acknowledge with `epoch`.
    fn host(&self, batch: BatchRef, epoch: u64) -> Result<(), Refused> {
        host(&self.arena, &self.ring, &self.intake, batch, epoch)
    }

    /// The futures of sealed requests: take each response back and retire the slot.
    fn finish_sealed(&mut self) -> usize {
        let sealed: Vec<SlotId> = self
            .waiters
            .waiting
            .iter()
            .filter(|(_, stage)| *stage == Stage::Sealed)
            .map(|&(id, _)| id)
            .collect();
        for &id in &sealed {
            let slot = self.arena.lookup(id).unwrap();
            slot.word().begin_import(id.generation()).unwrap();
            let response = slot.with_worker(id.generation(), |exchange, _| exchange.sealed);
            assert_eq!(response, Ok(true));
            self.alloc
                .retire(&*self.arena, id, self.intake.published())
                .unwrap();
            self.waiters.remove(id);
        }
        sealed.len()
    }

    fn advance(&mut self, by: Duration) {
        self.now += by;
    }

    fn leased(&self) -> u64 {
        self.dispatcher.counters().leased.load(Ordering::Relaxed)
    }

    /// The events of a taken event batch, by connection.
    fn conns(&self, batch: BatchRef) -> Vec<u64> {
        let mut delivered = Vec::with_capacity(256);
        self.ring.take_events(batch, &mut delivered).unwrap();
        delivered.iter().map(|event| event.conn).collect()
    }
}

/// The host's side of a request batch, from any thread.
fn host(
    arena: &Arena<Exchange>,
    ring: &BatchRing,
    intake: &Intake,
    batch: BatchRef,
    epoch: u64,
) -> Result<(), Refused> {
    let ids: Vec<SlotId> = ring
        .read(batch, |ids, _| ids.to_vec())
        .unwrap()
        .into_iter()
        .map(|raw| SlotId::from_raw(raw).unwrap())
        .collect();
    for &id in &ids {
        let slot = arena.lookup(id).unwrap();
        let tag = slot.with_read(id.generation(), |exchange| exchange.tag);
        assert_eq!(tag, Ok(id.as_u64()), "the host reads its own request");
        slot.with_write(id.generation(), |exchange| exchange.sealed = true)
            .unwrap();
    }
    intake.complete(ids, epoch)
}

#[test]
fn whatever_is_ready_goes_out_at_once_in_batches_of_up_to_256() {
    let mut harness = Harness::new(DispatchLimits::DEFAULT);
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    let first = harness.request(1);
    harness.turn();
    let batch = target.take().unwrap();
    assert_eq!(
        (batch.kind, batch.count, batch.epoch, batch.worker),
        (REQUESTS, 1, 1, 2),
        "a lone request is not held back to grow a batch"
    );
    assert_eq!(harness.ids(batch), [first]);
    assert_eq!(harness.state(first), SlotState::Leased);
    assert_eq!(harness.arena.lookup(first).unwrap().lease_epoch(), 1);

    let ids: Vec<SlotId> = (0..300).map(|route| harness.request(route)).collect();
    assert_eq!(harness.holds.get(), 300);
    harness.turn();
    let batches = target.taken();
    assert_eq!(
        batches.iter().map(|batch| batch.count).collect::<Vec<_>>(),
        [256, 44]
    );
    assert_eq!(
        batches.iter().map(|batch| batch.epoch).collect::<Vec<_>>(),
        [2, 3]
    );
    let posted: Vec<SlotId> = batches
        .iter()
        .flat_map(|&batch| harness.ids(batch))
        .collect();
    assert_eq!(posted, ids, "in the order they were queued");
    let routes = harness
        .ring
        .read(batches[1], |_, routes| routes.to_vec())
        .unwrap();
    assert_eq!(routes, (256..300).collect::<Vec<u32>>());
    assert_eq!(
        harness.holds.get(),
        0,
        "the read holds drop once the batch is taken"
    );
    assert!(harness
        .waiters
        .waiting
        .iter()
        .all(|(_, stage)| *stage == Stage::Posted));
    let counters = harness.dispatcher.counters();
    assert_eq!(counters.batches.load(Ordering::Relaxed), 3);
    assert_eq!(counters.dispatched.load(Ordering::Relaxed), 301);
    assert_eq!(counters.in_flight.load(Ordering::Relaxed), 3);
    assert_eq!(harness.intake.published(), 3);
}

#[test]
fn in_flight_is_capped_at_max_batches_in_flight() {
    for cap in [1, 4, 8] {
        // The ring always has the most entries a ring can have, so only the
        // in-flight bound stops the posts.
        let mut harness = Harness::over(
            Arc::new(Arena::new(2, 256, 65_536).unwrap()),
            Arc::new(Intake::new()),
            Arc::new(BatchRing::new(MAX_BATCHES_IN_FLIGHT_CEILING, 1)),
            Harness::limits(1, cap),
        );
        assert_eq!(harness.ring.len(), 8);
        let target = TestTarget::new();
        harness.attach(Arc::clone(&target));
        for route in 0..cap + 3 {
            harness.request(u32::try_from(route).unwrap());
        }
        harness.turn();
        assert_eq!(target.taken().len(), cap, "{cap} in flight");
        assert_eq!(harness.dispatcher.in_flight(), cap);
        assert_eq!(harness.dispatcher.queued(), 3);
        harness.turn();
        assert_eq!(
            target.taken().len(),
            cap,
            "nothing more until an acknowledgment"
        );
        let oldest = target.take().unwrap();
        harness.host(oldest, oldest.epoch).unwrap();
        harness.turn();
        assert_eq!(
            target.taken().len(),
            cap,
            "one acknowledged, one more posted"
        );
        assert_eq!(harness.dispatcher.queued(), 2);
        assert_eq!(harness.intake.acked(), 1);
    }
}

#[test]
fn acknowledgments_are_accepted_in_order_and_refused_ones_still_deliver_their_ids() {
    let mut harness = Harness::new(Harness::limits(1, 4));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    assert_eq!(
        harness.intake.complete([], 1),
        Err(Refused::Stale),
        "nothing is published yet"
    );
    let ids: Vec<SlotId> = (0..3).map(|route| harness.request(route)).collect();
    harness.turn();
    let batches = target.taken();
    assert_eq!(harness.intake.published(), 3);
    assert_eq!(
        harness.host(batches[1], 2),
        Err(Refused::Stale),
        "epoch 2 before epoch 1"
    );
    assert_eq!(
        harness.intake.acked(),
        0,
        "a refused acknowledgment changes nothing"
    );
    harness.turn();
    assert_eq!(
        harness.waiters.stage(ids[1]),
        Some(Stage::Sealed),
        "the completion of the refused call was applied"
    );
    assert_eq!(harness.dispatcher.in_flight(), 3);
    assert_eq!(harness.host(batches[0], 1), Ok(()));
    assert_eq!(
        harness.intake.complete([], 1),
        Err(Refused::Stale),
        "only once"
    );
    assert_eq!(harness.intake.complete([], 2), Ok(()));
    assert_eq!(
        harness.intake.complete([], 4),
        Err(Refused::Stale),
        "never published"
    );
    harness.turn();
    assert_eq!(harness.dispatcher.in_flight(), 1);
    assert_eq!(harness.finish_sealed(), 2);
    assert_eq!(harness.alloc.quarantined(), 2);
    assert_eq!(
        harness.dispatcher.counters().acks.load(Ordering::Relaxed),
        2
    );
}

#[test]
fn a_target_that_acknowledges_inside_post_is_accepted_and_the_worker_keeps_posting() {
    let mut harness = Harness::new(Harness::limits(1, 1));
    let target = Arc::new(TestTarget {
        acknowledge_inside: Some(Arc::clone(&harness.intake)),
        ..TestTarget::default()
    });
    harness.attach(Arc::clone(&target));
    for route in 0..3 {
        harness.request(route);
    }
    for posted in 1..=3 {
        harness.turn();
        assert_eq!(target.taken().len(), posted);
    }
    assert_eq!(
        *target.inside.lock().unwrap(),
        [Ok(()), Ok(()), Ok(())],
        "an acknowledgment made before post returned is accepted"
    );
    assert_eq!(harness.intake.acked(), 3);
    harness.turn();
    assert_eq!(harness.dispatcher.in_flight(), 0);
}

#[test]
fn published_is_rolled_back_on_full_and_the_retry_is_armed_when_nothing_is_in_flight() {
    let mut harness = Harness::new(Harness::limits(4, 4));
    let target = TestTarget::answering(&[Post::Full]);
    harness.attach(Arc::clone(&target));
    let ids: Vec<SlotId> = (0..3).map(|route| harness.request(route)).collect();
    let turned = harness.turn();
    assert!(target.taken().is_empty());
    assert_eq!(harness.intake.published(), 0, "rolled back");
    assert_eq!(harness.dispatcher.queued(), 3, "the jobs went back");
    assert_eq!(harness.holds.get(), 3, "with their read holds");
    assert!(harness.dispatcher.backlogged());
    for &id in &ids {
        assert_eq!(harness.state(id), SlotState::WorkerOwned, "unleased");
    }
    assert_eq!(turned.timer, Some(harness.now + Duration::from_millis(1)));
    assert_eq!(
        harness
            .dispatcher
            .counters()
            .queue_full
            .load(Ordering::Relaxed),
        1
    );
    harness.turn();
    assert!(target.taken().is_empty(), "no post before the retry is due");
    harness.advance(Duration::from_millis(1));
    harness.turn();
    let batch = target.take().unwrap();
    assert_eq!(batch.epoch, 1, "the refused epoch is reused");
    assert_eq!(harness.ids(batch), ids, "in their order");
    assert!(!harness.dispatcher.backlogged());
}

#[test]
fn a_full_event_batch_goes_back_to_the_front_in_order_with_its_octets() {
    let mut harness = Harness::new(Harness::limits(4, 4));
    let target = TestTarget::answering(&[Post::Full]);
    harness.attach(Arc::clone(&target));
    for conn in 0..3 {
        harness.event(conn);
    }
    let turned = harness.turn();
    assert!(target.taken().is_empty());
    assert_eq!(
        harness.dispatcher.queued_events(),
        (3, 9),
        "every event and its octets went back"
    );
    assert_eq!(harness.intake.published(), 0, "rolled back");
    assert!(harness.dispatcher.backlogged());
    assert_eq!(turned.timer, Some(harness.now + Duration::from_millis(1)));
    harness.event(3);
    harness.advance(Duration::from_millis(1));
    harness.turn();
    let batch = target.take().unwrap();
    assert_eq!((batch.kind, batch.epoch), (EVENTS, 1));
    assert_eq!(harness.conns(batch), [0, 1, 2, 3], "in socket order");
    assert_eq!(harness.dispatcher.queued_events(), (0, 0));
}

#[test]
fn a_full_event_batch_behind_a_taken_request_batch_keeps_both_orders() {
    let mut harness = Harness::new(Harness::limits(4, 4));
    let target = TestTarget::answering(&[Post::Taken, Post::Full]);
    harness.attach(Arc::clone(&target));
    let ids: Vec<SlotId> = (0..2).map(|route| harness.request(route)).collect();
    for conn in 0..3 {
        harness.event(conn);
    }
    let turned = harness.turn();
    let requests = target.take().unwrap();
    assert!(target.taken().is_empty(), "the event batch was refused");
    assert_eq!((requests.kind, requests.epoch), (REQUESTS, 1));
    assert_eq!(harness.ids(requests), ids);
    assert_eq!(harness.intake.published(), 1, "only the refused epoch");
    assert_eq!(harness.dispatcher.queued_events(), (3, 9));
    assert_eq!(turned.timer, None, "the acknowledgment will clear it");
    harness.host(requests, 1).unwrap();
    harness.turn();
    let events = target.take().unwrap();
    assert_eq!((events.kind, events.epoch), (EVENTS, 2));
    assert_eq!(harness.conns(events), [0, 1, 2]);
    assert_eq!(harness.finish_sealed(), 2);
}

#[test]
fn a_full_target_with_a_batch_in_flight_waits_for_the_acknowledgment() {
    let mut harness = Harness::new(Harness::limits(1, 4));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    harness.request(0);
    harness.turn();
    let first = target.take().unwrap();
    target.answers.lock().unwrap().push_back(Post::Full);
    let second = harness.request(1);
    let turned = harness.turn();
    assert_eq!(turned.timer, None, "an acknowledgment will clear it");
    assert_eq!(harness.intake.published(), 1);
    harness.advance(Duration::from_secs(1));
    harness.turn();
    assert!(target.taken().is_empty(), "still full");
    harness.host(first, 1).unwrap();
    harness.turn();
    let batch = target.take().unwrap();
    assert_eq!((batch.epoch, harness.ids(batch)), (2, vec![second]));
}

#[test]
fn published_is_rolled_back_and_the_target_lost_when_it_is_gone() {
    let mut harness = Harness::new(Harness::limits(1, 4));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    assert!(harness.intake.bind_thread(9));
    let leased = harness.request(0);
    harness.turn();
    target.answers.lock().unwrap().push_back(Post::Gone);
    let queued = harness.request(1);
    harness.event(4);
    harness.turn();
    assert_eq!(
        harness.intake.published(),
        1,
        "rolled back to the last delivered epoch"
    );
    assert_eq!(
        harness.intake.acked(),
        1,
        "no view of a gone target can exist"
    );
    assert_eq!(harness.intake.bound_thread(), 0);
    assert_eq!(
        harness.waiters.failed,
        [(leased, Failure::TargetGone), (queued, Failure::TargetGone)]
    );
    assert_eq!(harness.state(leased), SlotState::Closed);
    assert!(harness.arena.lookup(leased).unwrap().word().is_canceled());
    assert_eq!(harness.state(queued), SlotState::WorkerOwned);
    assert_eq!(harness.dispatcher.queued(), 0);
    assert_eq!(harness.dispatcher.queued_events(), (0, 0));
    assert_eq!(harness.dispatcher.in_flight(), 0);
    assert!(!harness.dispatcher.has_target());
    assert_eq!(harness.dispatcher.admit(), Admission::NoTarget);
    assert_eq!(
        harness
            .dispatcher
            .counters()
            .closed_leases
            .load(Ordering::Relaxed),
        1
    );
}

#[test]
fn admission_refuses_past_4096_queued_jobs_without_a_target_and_while_draining() {
    let mut harness = Harness::new(DispatchLimits::DEFAULT);
    assert_eq!(harness.dispatcher.admit(), Admission::NoTarget);
    harness.attach(TestTarget::new());
    assert_eq!(harness.dispatcher.admit(), Admission::Admit);
    assert_eq!(DispatchLimits::DEFAULT.queue_bound(), 4_096);
    for index in 0..4_096u16 {
        let slot = SlotId::new(2, 0, index).unwrap();
        assert_eq!(harness.dispatcher.admit(), Admission::Admit);
        harness.dispatcher.push(Job { slot, route: 0 }, None);
    }
    assert_eq!(harness.dispatcher.admit(), Admission::Queue);
    harness.dispatcher.set_draining();
    assert!(harness.dispatcher.is_draining());
    assert_eq!(harness.dispatcher.admit(), Admission::Draining);
    assert_eq!(
        harness
            .dispatcher
            .counters()
            .refused_503
            .load(Ordering::Relaxed),
        3
    );
}

#[test]
fn a_tombstoned_job_is_skipped_and_retired_at_once() {
    let mut harness = Harness::new(DispatchLimits::DEFAULT);
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    let ids: Vec<SlotId> = (0..3).map(|route| harness.request(route)).collect();
    // The future of the middle request was dropped while it was queued.
    harness
        .arena
        .lookup(ids[1])
        .unwrap()
        .word()
        .close(0)
        .unwrap();
    harness.waiters.remove(ids[1]);
    harness.turn();
    let batch = target.take().unwrap();
    assert_eq!(harness.ids(batch), [ids[0], ids[2]]);
    assert_eq!(harness.state(ids[1]), SlotState::Free, "retired at once");
    assert_eq!(harness.alloc.quarantined(), 1);
    assert_eq!(harness.alloc.live(), 2);
    assert_eq!(harness.holds.get(), 0);
}

#[test]
fn request_and_event_batches_alternate_while_both_wait() {
    let mut harness = Harness::new(Harness::limits(1, 8));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    for index in 0..3 {
        harness.request(index);
        harness.event(u64::from(index));
    }
    assert_eq!(harness.dispatcher.queued_events(), (3, 9));
    harness.turn();
    let kinds: Vec<u8> = target.taken().iter().map(|batch| batch.kind).collect();
    assert_eq!(
        kinds,
        [REQUESTS, EVENTS, REQUESTS, EVENTS, REQUESTS, EVENTS]
    );
    let events = target.taken()[1];
    assert_eq!(
        harness.ring.read(events, |ids, _| ids.len()),
        Err(Refused::Stale),
        "an event batch carries no requests"
    );
    let mut delivered = Vec::with_capacity(256);
    harness.ring.take_events(events, &mut delivered).unwrap();
    assert_eq!(delivered.len(), 1);
    assert_eq!(
        (delivered[0].conn, delivered[0].data.as_slice()),
        (0, &[0u8; 3][..])
    );
    let requests = target.taken()[0];
    assert_eq!(
        harness.ring.take_events(requests, &mut delivered),
        Err(Refused::Stale)
    );
    assert_eq!(harness.dispatcher.queued_events(), (0, 0));
}

#[test]
fn the_event_queue_refuses_past_its_bound() {
    let mut harness = Harness::new(Harness::limits(1, 1));
    for conn in 0..16 {
        harness.event(conn);
    }
    let refused = harness.dispatcher.push_event(EventRec::default());
    assert_eq!(refused, Err(EventRec::default()));
}

#[test]
fn a_batch_reference_reads_nothing_once_its_entry_moved_on() {
    let mut harness = Harness::new(Harness::limits(2, 1));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    harness.request(0);
    harness.turn();
    let first = target.take().unwrap();
    harness.host(first, 1).unwrap();
    harness.turn();
    assert_eq!(
        harness.ring.read(first, |ids, _| ids.len()),
        Err(Refused::Stale)
    );
    harness.request(1);
    harness.turn();
    let second = target.take().unwrap();
    assert_eq!(second.entry, first.entry, "the entry was reused");
    assert_eq!(
        harness.ring.read(first, |ids, _| ids.len()),
        Err(Refused::Stale)
    );
    assert_eq!(harness.ring.read(second, |ids, _| ids.len()), Ok(1));
    let foreign = BatchRef { entry: 9, ..second };
    assert_eq!(
        harness.ring.read(foreign, |ids, _| ids.len()),
        Err(Refused::Unknown)
    );
}

#[test]
fn the_late_list_backs_off_from_one_millisecond_to_one_second() {
    let mut harness = Harness::new(DispatchLimits::DEFAULT);
    let id = SlotId::new(2, 0, 0).unwrap();
    let start = harness.now;
    harness.dispatcher.defer(id, Late::Import, start);
    let mut previous = start;
    let mut intervals = Vec::new();
    for _ in 0..75 {
        let due = harness.turn().timer.unwrap();
        intervals.push(due - previous);
        previous = due;
        harness.now = due;
    }
    let ms = Duration::from_millis;
    let fast = usize::try_from(LATE_FAST_FOR.as_millis() / LATE_FIRST.as_millis()).unwrap();
    assert!(intervals[..fast]
        .iter()
        .all(|&interval| interval == LATE_FIRST));
    assert_eq!(
        intervals[fast..fast + 11],
        [
            ms(2),
            ms(4),
            ms(8),
            ms(16),
            ms(32),
            ms(64),
            ms(128),
            ms(256),
            ms(512),
            LATE_CEILING,
            LATE_CEILING
        ]
    );
    assert_eq!(harness.waiters.late_polls, 74);
    assert_eq!(harness.dispatcher.late(), 1);
    harness.waiters.late_settles = true;
    let turned = harness.turn();
    assert_eq!(harness.dispatcher.late(), 0);
    assert_eq!(
        turned.timer, None,
        "the timer is disarmed with the list empty"
    );
    assert_eq!(
        harness
            .dispatcher
            .counters()
            .late_readers
            .load(Ordering::Relaxed),
        1
    );
}

#[test]
fn a_pinned_orphan_waits_on_the_late_list_and_is_retired_once_unpinned() {
    let mut harness = Harness::new(DispatchLimits::DEFAULT);
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    let id = harness.request(0);
    harness.turn();
    let batch = target.take().unwrap();
    let arena = Arc::clone(&harness.arena);
    let word = arena.lookup(id).unwrap().word();
    word.pin(0).unwrap();
    harness.host(batch, 1).unwrap();
    harness.waiters.set(id, Stage::Dropped);
    let turned = harness.turn();
    assert_eq!(
        harness.state(id),
        SlotState::Closed,
        "the orphan's lease is closed"
    );
    assert_eq!(harness.dispatcher.late(), 1, "it waits for the pin");
    assert!(harness.waiters.is_empty());
    assert_eq!(turned.timer, Some(harness.now + LATE_FIRST));
    harness.advance(LATE_FIRST);
    harness.turn();
    assert_eq!(harness.dispatcher.late(), 1, "still pinned");
    word.unpin(0).unwrap();
    harness.advance(LATE_FIRST);
    harness.turn();
    assert_eq!(harness.dispatcher.late(), 0);
    assert_eq!(harness.state(id), SlotState::Free);
    assert_eq!(harness.alloc.live(), 0);
}

#[test]
fn target_loss_closes_waiting_leases_fails_queued_jobs_and_settles_the_floor() {
    let mut harness = Harness::new(Harness::limits(2, 1));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    assert!(harness.intake.bind_thread(5));
    assert!(
        harness.intake.bind_thread(5),
        "the bound thread binds again"
    );
    assert!(!harness.intake.bind_thread(6), "another thread does not");
    let ids: Vec<SlotId> = (0..5).map(|route| harness.request(route)).collect();
    harness.event(1);
    harness.turn();
    let batch = target.take().unwrap();
    assert_eq!(harness.ids(batch), ids[..2]);
    // The host seals the first request and completes it, without acknowledging.
    let slot = harness.arena.lookup(ids[0]).unwrap();
    slot.with_write(0, |exchange| exchange.sealed = true)
        .unwrap();
    harness.intake.complete([ids[0]], 0).unwrap();
    harness.intake.detach();
    harness.turn();
    assert_eq!(
        harness.waiters.stage(ids[0]),
        Some(Stage::Sealed),
        "a sealed response is still sent"
    );
    assert_eq!(harness.state(ids[0]), SlotState::Leased);
    assert_eq!(harness.state(ids[1]), SlotState::Closed);
    let failed: Vec<SlotId> = harness.waiters.failed.iter().map(|&(id, _)| id).collect();
    assert_eq!(failed, ids[1..]);
    assert_eq!(harness.dispatcher.queued_events(), (0, 0));
    assert_eq!(harness.dispatcher.in_flight(), 0);
    assert_eq!(harness.intake.acked(), harness.intake.published());
    assert_eq!(harness.intake.bound_thread(), 0);
    assert_eq!(harness.dispatcher.admit(), Admission::NoTarget);
    assert_eq!(harness.finish_sealed(), 1);
    let replacement = TestTarget::new();
    harness.attach(Arc::clone(&replacement));
    assert_eq!(harness.dispatcher.admit(), Admission::Admit);
    harness.request(9);
    harness.turn();
    assert_eq!(replacement.take().map(|batch| batch.epoch), Some(2));
}

#[test]
fn target_loss_retires_a_queued_job_whose_future_was_dropped() {
    let mut harness = Harness::new(Harness::limits(4, 4));
    harness.attach(TestTarget::new());
    let ids: Vec<SlotId> = (0..3).map(|route| harness.request(route)).collect();
    harness
        .arena
        .lookup(ids[1])
        .unwrap()
        .word()
        .close(0)
        .unwrap();
    harness.waiters.remove(ids[1]);
    harness.intake.detach();
    harness.turn();
    let failed: Vec<SlotId> = harness.waiters.failed.iter().map(|&(id, _)| id).collect();
    assert_eq!(failed, [ids[0], ids[2]]);
    assert_eq!(
        harness.state(ids[1]),
        SlotState::Free,
        "the tombstone is retired"
    );
    assert_eq!(harness.alloc.live(), 2);
    for id in [ids[0], ids[2]] {
        harness
            .alloc
            .retire(&*harness.arena, id, harness.intake.published())
            .unwrap();
    }
    harness.turn();
    assert_eq!(harness.alloc.live(), 0);
    assert_eq!(harness.alloc.quarantined(), 0);
    assert_eq!(
        harness.alloc.warm(),
        harness.arena.capacity(),
        "every index can be used again"
    );
}

#[test]
fn the_leased_gauge_returns_to_zero_once_every_lease_ends() {
    let mut harness = Harness::new(Harness::limits(4, 4));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    let ids: Vec<SlotId> = (0..3).map(|route| harness.request(route)).collect();
    harness.turn();
    assert_eq!(harness.leased(), 3);
    // The future of the last request was dropped while the host held it.
    harness.waiters.set(ids[2], Stage::Dropped);
    let batch = target.take().unwrap();
    harness.host(batch, 1).unwrap();
    harness.turn();
    assert_eq!(
        harness.leased(),
        0,
        "every drained completion ended its lease"
    );
    assert_eq!(harness.state(ids[2]), SlotState::Free, "the orphan retired");
    assert_eq!(harness.finish_sealed(), 2);
    harness.turn();
    assert_eq!(harness.alloc.live(), 0);
    assert_eq!(harness.leased(), 0);
}

#[test]
fn a_lease_whose_future_was_dropped_is_closed_and_counted_off_by_its_deferred_retirement() {
    let mut harness = Harness::new(Harness::limits(4, 4));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    let id = harness.request(0);
    harness.turn();
    assert_eq!(
        (harness.state(id), harness.leased()),
        (SlotState::Leased, 1)
    );
    let batch = target.take().unwrap();
    let arena = Arc::clone(&harness.arena);
    let word = arena.lookup(id).unwrap().word();
    word.pin(0).unwrap();
    // The future was dropped before any completion; it leaves the slot, still
    // leased, to the dispatcher.
    harness.waiters.remove(id);
    let now = harness.now;
    harness.dispatcher.defer(id, Late::Retire, now);
    harness.advance(LATE_FIRST);
    harness.turn();
    assert_eq!(harness.state(id), SlotState::Closed, "the lease is closed");
    assert!(word.is_canceled());
    assert_eq!(harness.leased(), 0, "and counted off");
    assert_eq!(harness.dispatcher.late(), 1, "the pin holds the retirement");
    assert_eq!(
        arena
            .lookup(id)
            .unwrap()
            .with_write(0, |exchange| exchange.sealed = true),
        Err(Refused::State(SlotState::Closed)),
        "a host completion now finds the slot closed"
    );
    word.unpin(0).unwrap();
    harness.advance(LATE_FIRST);
    harness.turn();
    assert_eq!(harness.dispatcher.late(), 0);
    assert_eq!(harness.state(id), SlotState::Free);
    assert_eq!(harness.alloc.live(), 0);
    assert_eq!(harness.leased(), 0, "counted off once");
    harness.intake.complete([], batch.epoch).unwrap();
    harness.turn();
    assert_eq!(harness.alloc.quarantined(), 0);
}

#[test]
fn a_thread_that_binds_after_its_own_detach_and_attach_stays_bound() {
    let mut harness = Harness::new(Harness::limits(1, 1));
    harness.attach(TestTarget::new());
    assert!(harness.intake.bind_thread(5));
    harness.intake.detach();
    assert_eq!(harness.intake.bound_thread(), 0, "a detach unbinds at once");
    let replacement = TestTarget::new();
    harness
        .intake
        .attach(Arc::clone(&replacement) as Arc<dyn Target>);
    assert!(harness.intake.bind_thread(5));
    harness.turn();
    assert!(harness.dispatcher.has_target());
    assert_eq!(
        harness.intake.bound_thread(),
        5,
        "the binding belongs to the replacement"
    );
    harness.intake.detach();
    assert!(
        harness.intake.bind_thread(6),
        "another thread binds once the target is detached"
    );
}

#[test]
fn a_draining_dispatcher_waits_for_its_open_realtime_connections() {
    let mut harness = Harness::new(Harness::limits(4, 4));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    harness.dispatcher.connection_opened();
    assert_eq!(harness.dispatcher.open_connections(), 1);
    harness.dispatcher.set_draining();
    assert!(
        !harness.turn().finished,
        "the connection's close event is still to come"
    );
    harness.event(3);
    harness.dispatcher.connection_closed();
    assert_eq!(harness.dispatcher.open_connections(), 0);
    assert!(!harness.turn().finished, "the close event is in flight");
    let batch = target.take().unwrap();
    assert_eq!(harness.conns(batch), [3]);
    harness.intake.complete([], batch.epoch).unwrap();
    assert!(harness.turn().finished);
}

#[test]
fn a_draining_dispatcher_finishes_only_once_nothing_is_left() {
    let mut harness = Harness::new(Harness::limits(1, 1));
    let target = TestTarget::new();
    harness.attach(Arc::clone(&target));
    harness.request(0);
    harness.request(1);
    harness.dispatcher.set_draining();
    assert!(!harness.turn().finished, "queued jobs are still posted");
    let first = target.take().unwrap();
    harness.host(first, 1).unwrap();
    assert!(
        !harness.turn().finished,
        "the first response is not taken back yet"
    );
    harness.finish_sealed();
    assert!(!harness.turn().finished, "the second batch is in flight");
    let second = target.take().unwrap();
    harness.host(second, 2).unwrap();
    harness.turn();
    harness.finish_sealed();
    assert!(harness.turn().finished);
}

#[test]
fn an_idle_dispatcher_without_a_target_finishes_on_the_turn_that_sees_the_drain() {
    let mut harness = Harness::new(DispatchLimits::DEFAULT);
    assert!(!harness.turn().finished);
    harness.dispatcher.set_draining();
    assert!(harness.turn().finished);
}

/// What the foreign-thread tests report: how many responses the worker took back,
/// and whether it ran on a worker thread.
type Report = (usize, bool);

/// The dispatcher task over `harness`, until it finishes; the turn reports each
/// response it takes back on `done`.
async fn dispatch_until_drained<S: Shutdown>(
    shutdown: &S,
    harness: Rc<RefCell<Harness>>,
    done: mpsc::Sender<Report>,
) {
    let intake = Arc::clone(&harness.borrow().intake);
    let kick = Kick::new();
    run(shutdown, &intake, &kick, |now, stopping| {
        let mut harness = harness.borrow_mut();
        if stopping {
            harness.dispatcher.set_draining();
        }
        harness.now = now;
        let turned = harness.turn();
        let finished = harness.finish_sealed();
        if finished > 0 {
            let _ = done.send((finished, zero_rt::is_worker_thread()));
            kick.wake();
        }
        turned
    })
    .await;
}

#[test]
fn the_task_returns_once_draining_and_empty_after_a_completion_from_a_foreign_thread() {
    let arena = Arc::new(Arena::new(0, 16, 16).unwrap());
    let intake = Arc::new(Intake::new());
    let ring = Arc::new(BatchRing::new(4, 256));
    let (posted_tx, posted_rx) = mpsc::channel();
    let target = TestTarget::new();
    *target.notify.lock().unwrap() = Some(posted_tx);
    let (done_tx, done_rx) = mpsc::channel();
    let host_parts = (Arc::clone(&arena), Arc::clone(&ring), Arc::clone(&intake));
    let foreign = std::thread::spawn(move || {
        let batch = posted_rx.recv().unwrap();
        let (arena, ring, intake) = host_parts;
        host(&arena, &ring, &intake, batch, batch.epoch)
    });
    let started = Instant::now();
    let outcome = zero_io::rt::block_on(async move {
        let shutdown = zero_io::rt::ShutdownHandle::new();
        let harness = Rc::new(RefCell::new(Harness::over(
            arena,
            intake,
            ring,
            DispatchLimits::DEFAULT,
        )));
        harness.borrow_mut().attach(target);
        harness.borrow_mut().request(3);
        shutdown.request();
        dispatch_until_drained(&shutdown, Rc::clone(&harness), done_tx).await;
        let harness = harness.borrow();
        (harness.alloc.live(), harness.intake.acked())
    })
    .unwrap();
    assert_eq!(foreign.join().unwrap(), Ok(()));
    assert_eq!(done_rx.recv().unwrap().0, 1);
    assert_eq!(outcome, (0, 1), "returned with the response taken back");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "a drain-bound task returns without waiting for a deadline"
    );
    println!("driver: {}", zero_io::rt::driver().unwrap());
}

#[test]
fn an_intake_wake_from_a_foreign_thread_reaches_the_dispatcher_on_a_worker() {
    let arena = Arc::new(Arena::new(1, 16, 16).unwrap());
    let intake = Arc::new(Intake::new());
    let ring = Arc::new(BatchRing::new(4, 256));
    let (posted_tx, posted_rx) = mpsc::channel();
    let target = TestTarget::new();
    *target.notify.lock().unwrap() = Some(posted_tx);
    let (done_tx, done_rx) = mpsc::channel();
    let parts = (Arc::clone(&arena), Arc::clone(&intake), Arc::clone(&ring));
    let done_tx = Mutex::new(done_tx);
    let config = zero_rt::Config {
        io: zero_io::rt::Config {
            threads: 1,
            drain: Duration::from_secs(30),
            ..zero_io::rt::Config::default()
        },
    };
    let workers = zero_rt::start(
        "127.0.0.1:0".parse().unwrap(),
        config,
        Arc::new(|_: zero_rt::Event| {}),
        move |worker, _acceptor| {
            let (arena, intake, ring) = (
                Arc::clone(&parts.0),
                Arc::clone(&parts.1),
                Arc::clone(&parts.2),
            );
            let target = Arc::clone(&target);
            let done = done_tx.lock().unwrap().clone();
            async move {
                let harness = Rc::new(RefCell::new(Harness::over(
                    arena,
                    intake,
                    ring,
                    DispatchLimits::DEFAULT,
                )));
                harness.borrow_mut().attach(target);
                harness.borrow_mut().request(5);
                dispatch_until_drained(worker.shutdown(), harness, done).await;
                Ok(())
            }
        },
    )
    .unwrap();
    let batch = posted_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(!zero_rt::is_worker_thread());
    host(&arena, &ring, &intake, batch, batch.epoch).unwrap();
    let (finished, on_worker) = done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(finished, 1, "the foreign completion woke the dispatcher");
    assert!(
        on_worker,
        "the response was taken back on the worker thread"
    );
    let started = Instant::now();
    workers.stop().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the dispatcher task did not hold the 30 s drain open"
    );
    assert_eq!(intake.acked(), 1);
    println!("driver: {}", zero_io::rt::driver().unwrap());
}
