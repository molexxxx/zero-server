//! The arena, its slots' access paths and the allocator: lookups, the lock-then-check
//! accessors and the published view, warm and cold reuse, the epoch quarantine, the
//! memory a burst gives back, and adopting an arena an earlier server used.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use zero_core::SlotId;
use zero_limits::services::SLOTS_KEPT;
use zero_rt::{Allocator, Arena, Exhausted, Payload, Refused, Reset, SlotState};

/// The buffer each warm payload keeps across a release.
const KEEP: usize = 64;

/// A slot payload: a tagged request with a body, and a response.
#[derive(Debug, Default)]
struct Exchange {
    tag: u64,
    body: Vec<u8>,
    response: Vec<u8>,
    counted: u64,
}

impl Reset for Exchange {
    fn reset(&mut self) {
        self.tag = 0;
        self.body.clear();
        self.response.clear();
    }
}

/// The published view: the request's tag.
#[derive(Debug, Default)]
struct View {
    tag: AtomicU64,
}

impl Payload for Exchange {
    type View = View;

    fn release(&mut self, view: &View, cold: bool) -> u64 {
        self.reset();
        let keep = if cold { 0 } else { KEEP };
        self.body.shrink_to(keep);
        self.response.shrink_to(keep);
        view.tag.store(0, Ordering::Release);
        std::mem::take(&mut self.counted)
    }
}

/// Allocate, export `tag` with a body of `body` octets, and hold the slot.
fn export(alloc: &mut Allocator, arena: &Arena<Exchange>, tag: u64, body: usize) -> (SlotId, u64) {
    let (id, mut payload, freed) = alloc.allocate(arena).unwrap();
    payload.tag = tag;
    payload.body.resize(body, 0xA5);
    payload.counted = u64::try_from(body).unwrap();
    let slot = arena.lookup(id).unwrap();
    slot.view().tag.store(tag, Ordering::Release);
    slot.word().hold(id.generation()).unwrap();
    drop(payload);
    (id, freed)
}

/// Take a held slot through a lease to `Completing`.
fn complete(arena: &Arena<Exchange>, id: SlotId) {
    let word = arena.lookup(id).unwrap().word();
    word.lease(id.generation()).unwrap();
    word.begin_import(id.generation()).unwrap();
}

#[test]
fn lookup_of_another_worker_or_a_never_grown_index_is_unknown() {
    let arena: Arena<Exchange> = Arena::new(3, 4, 16).unwrap();
    let mut alloc = Allocator::new();
    assert_eq!(
        arena
            .lookup(SlotId::new(3, 0, 0).unwrap())
            .map(|slot| slot.word().state()),
        Err(Refused::Unknown),
        "nothing is grown yet"
    );
    let (id, _) = export(&mut alloc, &arena, 1, 0);
    assert_eq!(arena.capacity(), 4);
    assert!(arena.lookup(id).is_ok());
    assert_eq!(
        arena.lookup(SlotId::new(3, 0, 4).unwrap()).err(),
        Some(Refused::Unknown),
        "beyond the grown chunk"
    );
    assert_eq!(
        arena.lookup(SlotId::new(2, 0, 0).unwrap()).err(),
        Some(Refused::Unknown),
        "another worker's id"
    );
    assert!(arena.slot(3).is_some());
    assert!(arena.slot(4).is_none());
    assert_eq!(
        alloc.retire(&arena, SlotId::new(2, 0, 0).unwrap(), 0),
        Err(Refused::Unknown)
    );
}

#[test]
fn an_arena_refuses_a_worker_index_past_127_and_clamps_its_sizes() {
    assert!(Arena::<Exchange>::new(128, 4, 16).is_none());
    let arena: Arena<Exchange> = Arena::new(127, 0, 1_000_000).unwrap();
    assert_eq!(arena.worker(), 127);
    assert_eq!(arena.chunk(), 1, "a chunk holds at least one slot");
    assert_eq!(arena.limit(), 65_536, "a worker addresses 65,536 slots");
    let small: Arena<Exchange> = Arena::new(0, 300, 5).unwrap();
    assert_eq!((small.chunk(), small.limit()), (5, 5));
    assert!(format!("{small:?}").contains("capacity: 0"));
}

#[test]
fn chunks_are_set_in_order_and_never_move() {
    let arena: Arena<Exchange> = Arena::new(0, 2, 64).unwrap();
    let mut alloc = Allocator::new();
    let (first, _) = export(&mut alloc, &arena, 1, 0);
    let before = std::ptr::from_ref(arena.lookup(first).unwrap()).addr();
    for tag in 0..40 {
        export(&mut alloc, &arena, tag, 0);
    }
    assert_eq!(arena.capacity(), 42);
    let after = std::ptr::from_ref(arena.lookup(first).unwrap()).addr();
    assert_eq!(
        before, after,
        "the first slot kept its address through 20 chunks"
    );
    let indexes: Vec<u16> = arena.slots().map(|(index, _)| index).collect();
    assert_eq!(indexes, (0..42).collect::<Vec<u16>>());
    assert_eq!(std::mem::align_of_val(arena.lookup(first).unwrap()), 64);
}

#[test]
fn the_arena_refuses_past_its_limit_until_an_index_is_released() {
    let arena: Arena<Exchange> = Arena::new(1, 3, 5).unwrap();
    let mut alloc = Allocator::new();
    let ids: Vec<SlotId> = (0..5)
        .map(|tag| export(&mut alloc, &arena, tag, 0).0)
        .collect();
    assert_eq!(arena.capacity(), 5, "the last chunk is cut to the limit");
    assert_eq!(arena.grow(), None);
    assert!(matches!(alloc.allocate(&arena), Err(Exhausted)));
    assert_eq!(
        Exhausted.to_string(),
        "every slot of the arena is in use or quarantined"
    );
    complete(&arena, ids[2]);
    alloc.retire(&arena, ids[2], 1).unwrap();
    assert!(
        alloc.allocate(&arena).is_err(),
        "a quarantined index is not handed out"
    );
    assert_eq!(alloc.release(&arena, 1), 0);
    let (again, guard, _) = alloc.allocate(&arena).unwrap();
    drop(guard);
    assert_eq!((again.index(), again.generation()), (2, 1));
    assert_eq!(alloc.live(), 5);
}

#[test]
fn allocate_returns_the_reset_payloads_guard_and_skips_an_index_whose_lock_is_held() {
    let arena = Arc::new(Arena::<Exchange>::new(0, 1, 16).unwrap());
    let mut alloc = Allocator::new();
    let (id, freed) = export(&mut alloc, &arena, 7, 100);
    assert_eq!(freed, 0);
    complete(&arena, id);

    // A host holds the lock through a read of the completing slot while the worker
    // retires and releases it, and while the worker allocates next.
    let (inside_tx, inside_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let host_arena = Arc::clone(&arena);
    let host = std::thread::spawn(move || {
        host_arena
            .lookup(id)
            .unwrap()
            .with_read(id.generation(), |exchange| {
                inside_tx.send(exchange.tag).unwrap();
                go_rx.recv().unwrap();
            })
    });
    assert_eq!(inside_rx.recv_timeout(Duration::from_secs(10)), Ok(7));
    alloc.retire(&arena, id, 0).unwrap();
    assert_eq!(
        alloc.release(&arena, 0),
        0,
        "a busy lock leaves the release to the next allocate"
    );
    assert_eq!(
        alloc.warm(),
        1,
        "the index joined the warm list all the same"
    );

    // Index 0 heads the warm list, but its lock is held: a new index is used.
    let (next, guard, _) = alloc.allocate(&arena).unwrap();
    assert_eq!(next.index(), 1);
    assert_eq!(alloc.warm(), 1, "the busy index stays at the front");
    drop(guard);
    go_tx.send(()).unwrap();
    assert_eq!(host.join().unwrap(), Ok(()));

    let (again, guard, freed) = alloc.allocate(&arena).unwrap();
    assert_eq!((again.index(), again.generation()), (id.index(), 1));
    assert_eq!(
        freed, 100,
        "the reset at allocate gave back the counted octets"
    );
    assert_eq!(guard.tag, 0, "the guard holds the reset payload");
    assert!(guard.body.is_empty());
    assert!(guard.body.capacity() <= KEEP);
    assert_eq!(
        arena.lookup(again).unwrap().word().state(),
        SlotState::Parsing
    );
}

#[test]
fn warm_indexes_are_reused_first_in_first_out() {
    let arena: Arena<Exchange> = Arena::new(0, 3, 8).unwrap();
    let mut alloc = Allocator::new();
    let ids: Vec<SlotId> = (0..3)
        .map(|tag| export(&mut alloc, &arena, tag, 0).0)
        .collect();
    assert_eq!(
        ids.iter().map(|id| id.index()).collect::<Vec<_>>(),
        [0, 1, 2]
    );
    for index in [2, 0, 1] {
        let id = ids[index];
        alloc.retire(&arena, id, 0).unwrap();
    }
    alloc.release(&arena, 0);
    let order: Vec<u16> = (0..3)
        .map(|_| alloc.allocate(&arena).unwrap().0.index())
        .collect();
    assert_eq!(order, [2, 0, 1], "the order the indexes were released in");
}

#[test]
fn the_quarantine_releases_by_the_acknowledgment_floor_and_returns_the_counted_octets() {
    let arena: Arena<Exchange> = Arena::new(0, 2, 2).unwrap();
    let mut alloc = Allocator::new();
    let (first, _) = export(&mut alloc, &arena, 1, 1_000);
    let (second, _) = export(&mut alloc, &arena, 2, 3_000);
    complete(&arena, first);
    complete(&arena, second);
    alloc.retire(&arena, first, 2).unwrap();
    alloc.retire(&arena, second, 3).unwrap();
    assert_eq!(alloc.quarantined(), 2);
    assert_eq!(alloc.live(), 0);

    assert_eq!(
        alloc.release(&arena, 1),
        0,
        "the floor is below both stamps"
    );
    let slot = arena.lookup(first).unwrap();
    assert_eq!(
        slot.view().tag.load(Ordering::Acquire),
        1,
        "a quarantined slot keeps its bytes"
    );
    assert_eq!(alloc.release(&arena, 2), 1_000);
    assert_eq!(alloc.quarantined(), 1);
    assert_eq!(slot.view().tag.load(Ordering::Acquire), 0, "released");
    assert_eq!(alloc.release(&arena, 3), 3_000);
    assert_eq!(alloc.quarantined(), 0);
    let (reused, guard, freed) = alloc.allocate(&arena).unwrap();
    assert_eq!(freed, 0, "the release already gave the octets back");
    assert!(
        guard.body.capacity() <= KEEP,
        "shrunk to what a warm slot keeps"
    );
    assert_eq!(reused.generation(), 1);
}

#[test]
fn a_burst_past_slots_kept_leaves_at_most_slots_kept_warm_and_nothing_retained() {
    let total = SLOTS_KEPT + 300;
    let arena: Arena<Exchange> = Arena::new(0, 256, 65_536).unwrap();
    let mut alloc = Allocator::new();
    let mut retained = 0u64;
    let mut ids = Vec::with_capacity(total);
    for tag in 0..total {
        let (id, freed) = export(&mut alloc, &arena, u64::try_from(tag).unwrap(), 4_096);
        retained = retained + 4_096 - freed;
        ids.push(id);
    }
    assert_eq!(alloc.live(), total);
    assert!(arena.capacity() >= total);
    for &id in &ids {
        complete(&arena, id);
        alloc.retire(&arena, id, 1).unwrap();
    }
    retained -= alloc.release(&arena, 1);
    assert_eq!(retained, 0, "every counted octet came back");
    assert_eq!(alloc.warm(), SLOTS_KEPT);
    let cold = alloc.cold();
    assert_eq!(cold, arena.capacity() - SLOTS_KEPT);
    let mut emptied = 0;
    for &id in &ids {
        let slot = arena.lookup(id).unwrap();
        let generation = slot.word().generation();
        slot.word().claim(generation).unwrap();
        let capacity = slot
            .with_worker(generation, |exchange, _| exchange.body.capacity())
            .unwrap();
        assert!(
            capacity <= KEEP,
            "a released slot keeps at most a warm buffer"
        );
        if capacity == 0 {
            emptied += 1;
        }
        slot.word().retire(generation).unwrap();
    }
    assert_eq!(emptied, cold, "every cold slot gave its buffers back");
}

#[test]
fn cold_indexes_are_used_only_when_no_warm_index_is_free() {
    let arena: Arena<Exchange> = Arena::new(0, 256, 65_536).unwrap();
    let mut alloc = Allocator::new();
    let ids: Vec<SlotId> = (0..SLOTS_KEPT + 2)
        .map(|tag| export(&mut alloc, &arena, u64::try_from(tag).unwrap(), 0).0)
        .collect();
    for &id in &ids {
        alloc.retire(&arena, id, 0).unwrap();
    }
    alloc.release(&arena, 0);
    let cold_before = alloc.cold();
    assert!(cold_before >= 2);
    for _ in 0..SLOTS_KEPT {
        let (_, guard, _) = alloc.allocate(&arena).unwrap();
        drop(guard);
        assert_eq!(
            alloc.cold(),
            cold_before,
            "no cold index while a warm one is free"
        );
    }
    assert_eq!(alloc.warm(), 0);
    let capacity = arena.capacity();
    let (_, guard, _) = alloc.allocate(&arena).unwrap();
    drop(guard);
    assert_eq!(alloc.cold(), cold_before - 1, "now a cold one");
    assert_eq!(arena.capacity(), capacity, "and no chunk was grown for it");
}

#[test]
fn adopting_a_used_arena_frees_what_is_held_and_keeps_pinned_slots_in_limbo() {
    let arena: Arena<Exchange> = Arena::new(5, 8, 8).unwrap();
    let mut earlier = Allocator::new();
    let ids: Vec<SlotId> = (0..6)
        .map(|tag| export(&mut earlier, &arena, tag, 10).0)
        .collect();
    // 0 stays held; 1 is leased; 2 is leased and pinned; 3 is completing; 4 is
    // closed; 5 is retired and still in the earlier server's quarantine.
    let word = |index: usize| arena.lookup(ids[index]).unwrap().word();
    word(1).lease(0).unwrap();
    word(2).lease(0).unwrap();
    word(2).pin(0).unwrap();
    complete(&arena, ids[3]);
    word(4).close(0).unwrap();
    complete(&arena, ids[5]);
    earlier.retire(&arena, ids[5], 9).unwrap();
    drop(earlier);

    let mut alloc = Allocator::adopt(&arena);
    assert_eq!(alloc.live(), 0);
    assert_eq!(alloc.limbo(), 1, "the pinned slot waits");
    assert_eq!(
        alloc.quarantined(),
        0,
        "no target saw a slot of this server"
    );
    assert_eq!(alloc.warm(), 7, "every other grown slot can be allocated");
    assert_eq!(
        arena
            .lookup(ids[5])
            .unwrap()
            .view()
            .tag
            .load(Ordering::Acquire),
        0,
        "the payloads were released"
    );
    for index in [0, 1, 3, 4] {
        assert_eq!(word(index).state(), SlotState::Free, "{index}");
        assert_eq!(word(index).generation(), 1, "{index}: retired now");
    }
    assert_eq!(
        word(2).state(),
        SlotState::Closed,
        "the pinned lease is closed"
    );
    assert_eq!(word(2).readers(), 1);
    let stale = arena.lookup(ids[1]).unwrap();
    assert_eq!(
        stale.with_read(0, |exchange| exchange.tag),
        Err(Refused::Stale),
        "an id of the earlier server reads nothing"
    );

    let (id, guard, freed) = alloc.allocate(&arena).unwrap();
    assert_eq!(
        (id.worker(), id.index(), id.generation()),
        (5, 0, 1),
        "the front of the warm list, without a release first"
    );
    assert_eq!(freed, 0, "the adoption already released it");
    drop(guard);
    assert_eq!(
        alloc.release(&arena, 0),
        50,
        "the octets of the five unpinned slots the earlier server used"
    );
    assert_eq!(alloc.release(&arena, 0), 0, "reported once");
    alloc.retry_limbo(&arena, 0);
    assert_eq!(alloc.limbo(), 1, "still pinned");
    word(2).unpin(0).unwrap();
    alloc.retry_limbo(&arena, 0);
    assert_eq!(alloc.limbo(), 0);
    assert_eq!(alloc.release(&arena, 0), 10);
    assert_eq!(alloc.warm(), 7);
}

#[test]
fn adopting_an_arena_past_slots_kept_puts_the_rest_on_the_cold_list() {
    let arena: Arena<Exchange> = Arena::new(0, 256, 65_536).unwrap();
    while arena.capacity() <= SLOTS_KEPT {
        arena.grow().unwrap();
    }
    let alloc = Allocator::adopt(&arena);
    assert_eq!(alloc.warm(), SLOTS_KEPT);
    assert_eq!(alloc.cold(), arena.capacity() - SLOTS_KEPT);
    assert_eq!(alloc.quarantined(), 0);
    assert_eq!(alloc.reserved(), arena.capacity());
}

#[test]
fn a_slot_settled_out_of_limbo_is_stamped_with_the_newest_posted_epoch() {
    let arena: Arena<Exchange> = Arena::new(0, 4, 4).unwrap();
    let mut earlier = Allocator::new();
    let pinned = export(&mut earlier, &arena, 1, 0).0;
    let word = arena.lookup(pinned).unwrap().word();
    word.lease(0).unwrap();
    word.pin(0).unwrap();
    drop(earlier);
    let mut alloc = Allocator::adopt(&arena);
    assert_eq!(alloc.limbo(), 1);

    // This server has posted epoch 5 and the floor is at 4 when the earlier
    // server's pin goes away; a request of its own is retired after that.
    word.unpin(0).unwrap();
    alloc.retry_limbo(&arena, 5);
    assert_eq!((alloc.limbo(), alloc.quarantined()), (0, 1));
    let (later, _) = export(&mut alloc, &arena, 2, 0);
    complete(&arena, later);
    alloc.retire(&arena, later, 6).unwrap();

    alloc.release(&arena, 4);
    assert_eq!(alloc.quarantined(), 2, "the floor is below every stamp");
    alloc.release(&arena, 5);
    assert_eq!(
        alloc.quarantined(),
        1,
        "the floor's advance to 5 released the settled slot, and only it"
    );
    alloc.release(&arena, 6);
    assert_eq!(alloc.quarantined(), 0);
}

#[test]
fn hosts_read_and_write_only_under_the_lock_at_their_generation() {
    let arena: Arena<Exchange> = Arena::new(0, 2, 2).unwrap();
    let mut alloc = Allocator::new();
    let (id, _) = export(&mut alloc, &arena, 9, 0);
    let slot = arena.lookup(id).unwrap();
    let generation = id.generation();
    assert_eq!(
        slot.with_read(generation, |exchange| exchange.tag),
        Err(Refused::State(SlotState::WorkerOwned))
    );
    assert_eq!(
        slot.with_write(generation, |exchange| exchange.response.push(1)),
        Err(Refused::State(SlotState::WorkerOwned))
    );
    slot.word().lease(generation).unwrap();
    assert_eq!(slot.with_read(generation, |exchange| exchange.tag), Ok(9));
    assert_eq!(
        slot.with_read(generation + 1, |exchange| exchange.tag),
        Err(Refused::Stale)
    );
    assert_eq!(
        slot.with_write(generation, |exchange| {
            exchange.response.extend_from_slice(b"ok");
            exchange.response.len()
        }),
        Ok(2)
    );
    assert_eq!(slot.with_write(generation + 1, |_| ()), Err(Refused::Stale));
    assert_eq!(
        slot.with_worker(generation, |_, _| ()),
        Err(Refused::State(SlotState::Leased)),
        "the worker keeps out of a lease"
    );
    slot.word().begin_import(generation).unwrap();
    assert_eq!(slot.with_read(generation, |exchange| exchange.tag), Ok(9));
    assert_eq!(
        slot.with_write(generation, |_| ()),
        Err(Refused::State(SlotState::Completing)),
        "no write once the worker imports"
    );
    assert_eq!(
        slot.with_worker(generation, |exchange, view| {
            (exchange.response.clone(), view.tag.load(Ordering::Acquire))
        }),
        Ok((b"ok".to_vec(), 9))
    );
    assert_eq!(
        slot.with_worker(generation + 1, |_, _| ()),
        Err(Refused::Stale)
    );
    alloc.retire(&arena, id, 0).unwrap();
    assert_eq!(
        slot.with_worker(generation, |_, _| ()),
        Err(Refused::Stale),
        "retired"
    );
    assert_eq!(
        slot.with_worker(generation + 1, |_, _| ()),
        Err(Refused::State(SlotState::Free))
    );
}

#[test]
fn a_stale_id_is_refused_before_the_lock_so_it_never_waits_on_the_worker() {
    let arena = Arc::new(Arena::<Exchange>::new(0, 1, 1).unwrap());
    let mut alloc = Allocator::new();
    let (id, _) = export(&mut alloc, &arena, 1, 0);
    complete(&arena, id);
    alloc.retire(&arena, id, 0).unwrap();
    alloc.release(&arena, 0);
    // The worker claims the index again and holds its lock through the export.
    let (fresh, guard, _) = alloc.allocate(&arena).unwrap();
    assert_eq!(fresh.index(), id.index());
    let (done_tx, done_rx) = mpsc::channel();
    let host_arena = Arc::clone(&arena);
    std::thread::spawn(move || {
        let slot = host_arena.lookup(id).unwrap();
        let read = slot.with_read(id.generation(), |exchange| exchange.tag);
        let write = slot.with_write(id.generation(), |_| ());
        done_tx.send((read, write)).unwrap();
    });
    assert_eq!(
        done_rx.recv_timeout(Duration::from_secs(10)),
        Ok((Err(Refused::Stale), Err(Refused::Stale))),
        "the stale reads returned while the worker held the lock"
    );
    drop(guard);
}

#[test]
fn a_busy_lock_refuses_the_worker_instead_of_blocking_it() {
    let arena = Arc::new(Arena::<Exchange>::new(0, 2, 2).unwrap());
    let mut alloc = Allocator::new();
    let (id, _) = export(&mut alloc, &arena, 4, 0);
    arena.lookup(id).unwrap().word().lease(0).unwrap();
    let (inside_tx, inside_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let host_arena = Arc::clone(&arena);
    let host = std::thread::spawn(move || {
        host_arena.lookup(id).unwrap().with_write(0, |exchange| {
            inside_tx.send(()).unwrap();
            go_rx.recv().unwrap();
            exchange.response.push(1);
        })
    });
    inside_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let slot = arena.lookup(id).unwrap();
    slot.word().begin_import(0).unwrap();
    assert_eq!(slot.with_worker(0, |_, _| ()), Err(Refused::Busy));
    go_tx.send(()).unwrap();
    assert_eq!(host.join().unwrap(), Ok(()));
    assert_eq!(
        slot.with_worker(0, |exchange, _| exchange.response.len()),
        Ok(1)
    );
}

#[test]
fn a_panic_under_the_lock_poisons_the_slot_until_it_is_allocated_again() {
    let arena: Arena<Exchange> = Arena::new(0, 1, 1).unwrap();
    let mut alloc = Allocator::new();
    let (id, _) = export(&mut alloc, &arena, 3, 0);
    let slot = arena.lookup(id).unwrap();
    slot.word().lease(0).unwrap();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        slot.with_write(0, |_| panic!("host fell over"))
    }));
    std::panic::set_hook(previous);
    assert!(panicked.is_err());
    assert_eq!(
        slot.with_read(0, |exchange| exchange.tag),
        Err(Refused::Poisoned)
    );
    assert_eq!(slot.with_write(0, |_| ()), Err(Refused::Poisoned));
    slot.word().begin_import(0).unwrap();
    assert_eq!(slot.with_worker(0, |_, _| ()), Err(Refused::Poisoned));
    alloc.retire(&arena, id, 0).unwrap();
    alloc.release(&arena, 0);
    let (again, guard, _) = alloc.allocate(&arena).unwrap();
    drop(guard);
    slot.word().hold(again.generation()).unwrap();
    slot.word().lease(again.generation()).unwrap();
    assert_eq!(
        slot.with_read(again.generation(), |exchange| exchange.tag),
        Ok(0),
        "the release cleared the poison"
    );
}

#[test]
fn a_view_is_read_only_between_two_word_loads_at_its_generation() {
    let arena: Arena<Exchange> = Arena::new(0, 1, 1).unwrap();
    let mut alloc = Allocator::new();
    let (id, _) = export(&mut alloc, &arena, 11, 0);
    let slot = arena.lookup(id).unwrap();
    let read = |generation| slot.read_view(generation, |view| view.tag.load(Ordering::Acquire));
    assert_eq!(read(0), Err(Refused::State(SlotState::WorkerOwned)));
    slot.word().lease(0).unwrap();
    assert_eq!(read(0), Ok(11));
    assert_eq!(read(1), Err(Refused::Stale));
    slot.word().begin_import(0).unwrap();
    assert_eq!(read(0), Ok(11), "completing slots are still readable");
    // The worker retires the slot between the two loads: the snapshot is refused.
    assert_eq!(
        slot.read_view(0, |view| {
            slot.word().retire(0).unwrap();
            view.tag.load(Ordering::Acquire)
        }),
        Err(Refused::Stale)
    );
    assert_eq!(slot.lease_epoch(), 0);
    assert!(format!("{slot:?}").contains("lease_epoch: 0"));
}

#[test]
fn a_pin_keeps_a_slot_from_retiring_and_a_retired_slot_refuses_pins() {
    let arena: Arena<Exchange> = Arena::new(0, 1, 1).unwrap();
    let mut alloc = Allocator::new();
    let (id, _) = export(&mut alloc, &arena, 5, 0);
    let word = arena.lookup(id).unwrap().word();
    word.lease(0).unwrap();
    let pin = word.borrow(0).unwrap();
    word.begin_import(0).unwrap();
    assert_eq!(alloc.retire(&arena, id, 0), Err(Refused::Readers(1)));
    assert_eq!(alloc.live(), 1, "a refused retirement keeps the slot live");
    drop(pin);
    alloc.retire(&arena, id, 0).unwrap();
    assert_eq!(word.pin(0), Err(Refused::Stale));
    assert_eq!(
        alloc.retire(&arena, id, 0),
        Err(Refused::Stale),
        "retired once"
    );
}
