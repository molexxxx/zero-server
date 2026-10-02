# Runtime map: zero-rt and zero-io against DESIGN.md 7.3 and 8.2

Reader notes for steps 12 and 13. Paths are relative to `C:\Users\tonyw\Desktop\projects\zero-core`.
Line numbers are from the working tree read on 2026-10-01. Nothing in the repository was edited.

Read for this map: `.github/cloud/RULES.md`, `.github/cloud/RULES.md`, `.github/cloud/DESIGN.md` sections 5,
7, 8, 10.1, 10.2, `ROADMAP.md` rows 12 and 13 (lines 180 and 181), all of `crates/zero-rt/src`,
`crates/zero-io/src/{lib.rs,seam.rs,tokio_rt/*,compio_rt/{executor,worker,listen,shutdown,time}.rs}`,
`crates/zero-realtime/src/{rooms.rs,websocket.rs}`, `crates/zero-core/src/slot.rs`, the record and
connection parts of `crates/zero-http/src/{conn.rs,record.rs,handler.rs,server.rs}`,
`crates/zero-limits/src/services.rs`, `crates/zero-ffi/src/lib.rs`, the sanitizer job in
`.github/workflows/ci.yml`.

## 1. Short answer

- The slot state word and the borrow protocol exist and are unit tested
  (`crates/zero-rt/src/slot.rs`), and the chunked arena exists (`crates/zero-rt/src/arena.rs`).
  Nothing outside zero-rt uses either: the HTTP/1.1 driver keeps requests in boxed `Record`s on a
  per-core free list (`crates/zero-http/src/conn.rs:72-75,105-119`), not in arena slots.
- Missing entirely: epoch-based index reuse, the batch dispatcher (queue, batches, in-flight and
  queued bounds, QueueFull handling, 503 rule), the completion intake from host threads, lease
  timeout, `late_reader` metric, a host-reachable view of the arena, a loom model, and the TSan
  test the CI job already names (`.github/workflows/ci.yml:403-411` runs `-p zero-rt --
  --include-ignored slot_recycle`; no test called `slot_recycle` exists in the workspace).
- Cross-thread wakes today are all `Mutex` plus `std::task::Waker` (rooms inbox, compio handoff
  slot, compio shutdown) or tokio `Notify` and unbounded `mpsc` inside zero-io. A host thread can
  wake a worker core with nothing but a stored `Waker`: both backends make a cross-thread
  `Waker::wake` push the task to a shared queue and interrupt the core's driver. That is the
  mechanism a completion intake can reuse in zero-rt without naming tokio and without unsafe.

## 2. What zero-rt provides today

### 2.1 The state word (`crates/zero-rt/src/slot.rs`)

Layout (doc at 11-12, constants at 18-25): bits 0 to 2 state, bits 3 to 18 reader count
(`MAX_READERS` = 65,535 at 28), bit 19 cancel, bits 20 to 49 generation (30 bits, masked with
`zero_core::slot::GENERATION_MASK`, `crates/zero-core/src/slot.rs:22`). Bits 50 to 63 (14 bits)
are unused.

States (`SlotState`, 31-46): `Free = 0`, `Parsing = 1`, `WorkerOwned = 2`, `Leased = 3`,
`Completing = 4`, `Closed = 5`. `from_bits` maps 6 and 7 to `Free` (56); unreachable in practice.
DESIGN 7.3 writes `Leased { generation, readers }`; the code keeps generation and readers in the
same word beside the state, which is the same information.

Operations, each a CAS loop with `compare_exchange_weak(AcqRel, Acquire)` unless noted:

| Operation | Lines | From | To | Checks | Who (by design) |
|---|---|---|---|---|---|
| `transition(from, next)` | 129-146 | `from` | `next` | state only; no generation check; any pair accepted | worker |
| `borrow(generation)` | 162-185 | `Leased` | `Leased`, readers + 1 | generation, state `Leased`, readers below max | host accessor |
| `Borrow::drop` | 295-301 | any | readers - 1 (`fetch_sub`, AcqRel) | none | host accessor |
| `complete(generation)` | 197-217 | `Leased` | `Completing` | generation, state | host (`zero_batch_complete`) |
| `cancel()` | 220-222 | any | cancel bit set (`fetch_or`, AcqRel) | none | worker |
| `close()` | 225-239 | any (including `Free`) | `Closed`, readers and cancel kept | none | worker |
| `recycle()` | 253-278 | `Parsing`, `WorkerOwned`, `Completing`, `Closed` | `Free`, generation + 1, readers 0, cancel cleared | readers == 0; refuses `Free` and `Leased` | worker |

Reads: `state` 97-99, `generation` 103-105, `readers` 109-111, `is_cancelled` 115-117 (all
`Acquire`). `Refused` (61-72): `Stale`, `State(s)`, `Readers(n)`, `Full`.

Memory ordering as written: the worker's `transition(_, Leased)` is a release on the word; the
reader's successful `borrow` CAS acquires it, so the worker's writes to the record before leasing
are visible to the reader. The reader's `Borrow::drop` (`fetch_sub` AcqRel) and the host's
`complete` (AcqRel) are releases on the same word; the worker's `readers()`/`recycle()` acquire
it, so host writes to the response are visible to the worker before it writes the response.
DESIGN 7.3 asks for a release store on completion; the AcqRel CAS is at least that.

Tests present (313-420): full walk with generation bump; borrow needs generation and lease and
blocks recycle; closed slot refuses borrows and recycles once readers leave; reader ceiling;
generation wraps inside 30 bits. All single-threaded.

### 2.2 The arena (`crates/zero-rt/src/arena.rs`)

- `Entry<T> { word: SlotWord, value: UnsafeCell<T> }` (29-33), private. `Arena<T>` holds
  `chunks: Vec<Box<[Entry<T>]>>`, `free: Vec<u16>`, `live`, `limit`, `worker`, `chunk` (36-44).
  Chunks are boxed slices added in `grow` (197-220) and never moved, so entry addresses are
  stable (test at 293-310).
- `UnsafeCell` is reached only through `UnsafeCell::get_mut` (110, 137), which is safe; its real
  effect is to make `Arena<T>` `!Sync`. No host thread can hold `&Arena`.
- `allocate` (100-114): pops the free list LIFO (101), else grows; `transition(Free, Parsing)`;
  `reset()` keeps capacity; returns `SlotId::new(worker, generation, index)`.
- `get_mut(id)` (129-138): checks worker, generation, and only refuses `Free`. It does not refuse
  `Leased` or `Completing`.
- `word(id)` (150-155): worker check and bounds only; no generation check.
- `free(id)` (172-195): generation check, then `recycle`; on success pushes the index back on the
  free list at once (182). `Readers` and `State` refusals become `Error::Limit` (186-192), which
  is the "retry next turn" signal for a late reader; nothing counts it.
- Limit 65,536 per worker (`SLOTS_PER_WORKER`, `crates/zero-core/src/slot.rs:20`), clamped in
  `new` (60-70). No chunk is allocated until the first `allocate`.

### 2.3 The rest of zero-rt

- `worker.rs`: `Worker { core, panics: Rc<Cell<u64>>, status: StatusSink }` (62-67); `spawn`
  runs every task under `contain` (109-120); `Event` has `Started`, `Stopped`, `TaskPanic`,
  `WorkerPanic` (23-49) and no dispatch or metric events; `start` wraps `rt::serve` and builds
  each `Worker` on its own thread (208-244). `Workers` exposes address, count, shutdown, stop,
  join (148-189) and no per-core handle reachable from another thread.
- `contain.rs`: `catch_unwind` around every poll (43-70).
- `cancel.rs`: `Cancel` is `Rc<Inner { Cell<bool>, RefCell<Option<Waker>> }>` (10-19), one core
  only. It is separate from the cancel bit in the state word; nothing ties the two together.
- `tier.rs`: `Tier` enum and `crosses()` (only `Batched`) (7-29); nothing outside the crate uses
  it (grep for `Tier::` outside zero-rt finds nothing).
- `lib.rs:12-16`: states that the dispatcher and epoch reuse follow later, and that the crate
  holds no unsafe. `Cargo.toml:13-16`: depends on zero-core, zero-limits, zero-io; no
  dev-dependencies.
- Budgets already exist as constants: `MAX_BATCH_SIZE = 256`, `MAX_BATCHES_IN_FLIGHT = 4`,
  `MAX_QUEUED_BATCHES_PER_CORE = 16`, `LEASE_TIMEOUT = 300 s`
  (`crates/zero-limits/src/services.rs:13-23`, struct fields at 26-40).

## 3. Against DESIGN.md 7.3, item by item

| 7.3 statement | Status | Where |
|---|---|---|
| Six states in one atomic word per slot, safe Rust | Present | slot.rs:31-46, 75-78 |
| Only the worker moves into `Leased` and out of `Completing` | Convention only: `transition` accepts any pair (test at slot.rs:377 goes `Free` to `Leased`); `recycle` is the only exit from `Completing` | slot.rs:129-146, 253-278 |
| Accessor CAS borrow: generation, `Leased`, readers + 1, access, decrement | Present (`borrow` plus `Borrow::drop`) | slot.rs:162-185, 295-301 |
| Generation mismatch or non-`Leased` returns `Closed` without touching the slot | Present as `Refused::Stale` and `Refused::State`; mapping to `ZeroStatus::Closed` is zero-ffi's job (not written) | slot.rs:165-170 |
| `zero_batch_complete` moves to `Completing` with a release store | Per-slot `complete` exists; the batch call, the epoch ack and the wake do not | slot.rs:197-217 |
| Worker refuses to recycle while `readers` is nonzero, re-polls next turn, counts `late_reader` | Refusal present (`Refused::Readers`, `Error::Limit`); re-poll and metric absent | slot.rs:262-265, arena.rs:186-189 |
| Worker writes the response, then `Free` and generation bump | `recycle` does `Free` plus bump; no response path uses it | slot.rs:266-274 |
| Leased slot has its own response buffer from the arena, separate from the write slab | Absent; `T` is generic and zero-http's `Record` carries `response_body` (record.rs:57) but records are not in the arena | |
| Worker may set cancel on a leased slot, never frees it | `cancel()` present; `free` refuses `Leased` | slot.rs:220-222, arena.rs:190-192 |
| Close while leased defers the free until completion or lease timeout, then `Closed` | `close()` present but unconditional; no lease timer | slot.rs:225-239 |
| Chunked arena, stable addresses, never reallocated | Present | arena.rs:197-220 |
| zero-ffi never dereferences arena memory without a borrow token; one `with_slot` helper | Not written; zero-ffi has only `zero_version` (`crates/zero-ffi/src/lib.rs:47-52`); the arena exposes no host path (section 7 below) | |
| Loom model and TSan job racing a late accessor against recycle with tier 0 and tier 3 on one core | CI job exists, its test does not; no loom anywhere in zero-rt | ci.yml:370-411 |
| Epoch-based index reuse with per-target acknowledgment | Absent; free list is LIFO with immediate reuse | arena.rs:101, 182 |

## 4. Defects and risks in the existing code

1. `close()` from `Free` (slot.rs:225-239) leaves an index on the free list whose word says
   `Closed`; the next `allocate` pops it (arena.rs:101), fails `transition(Free, Parsing)`
   (105-109) with `Error::Closed`, and the index is lost from the free list for good. The worker
   should only close a slot it holds, or `close` should refuse `Free`.
2. `get_mut` (arena.rs:129-138) hands the worker `&mut T` for a `Leased` or `Completing` slot.
   Once hosts read leased records, that is a data race the type system cannot see. It should
   refuse `Leased`, and `Completing` while readers are counted.
3. `word(id)` (arena.rs:150-155) and `transition` (slot.rs:129-146) do not check the generation,
   so a worker path holding a stale id can transition a recycled slot. A worker-side
   `lease(id)`/`close(id)` that checks the generation in the same CAS closes this.
4. Aliasing across threads (needs a ruling, see unverified list): `allocate`, `get_mut` and `free`
   all go through `entry_mut` (arena.rs:232-240), which forms `&mut Entry<T>` (and `&mut` to the
   whole chunk slice on the way). A late host reader on another thread may at that moment be
   reading the same `SlotWord` through a shared reference derived from a raw pointer. The
   atomics make it race-free at the hardware level, but a live `&mut` covering memory another
   thread reads through `&` is undefined behavior under Stacked Borrows; the Tree Borrows verdict
   for interior-mutable memory was not checked. loom does not detect this class; Miri with
   threads can. A layout that keeps the words in chunks the worker only ever borrows shared
   (atomics need only `&`) and keeps records separate avoids the question for the word.
5. No writer exclusion inside a lease: several host threads may each hold a `Borrow` and write the
   response concurrently (readers counts them, nothing serializes them). One isolate per worker
   (Node) never does this; .NET `ValueTask` continuations on the thread pool and a Python pool
   could. Either zero-ffi takes a writer bit for `zero_res_*` (one of the 14 free bits) or the
   contract states one writer per slot.
6. False sharing: `Entry` puts each word next to its record (arena.rs:29-33), so a host
   incrementing readers on slot i dirties a line the worker may be writing for slot i or its
   neighbor. Relevant to the micro-harness cost measurement of the borrow protocol.
7. CI names a test that does not exist (ci.yml:403-411); with `--include-ignored slot_recycle`
   and zero matches, cargo exits 0, so the job passes vacuously today.

## 5. Epoch-based index reuse: what is missing

Nothing exists. Pieces needed, in the order the worker touches them:

- A per-worker completion epoch (`u64`, so it never wraps) incremented per dispatched batch and
  written into the batch descriptor (DESIGN 8.2 lists the epoch field).
- A registry of host targets per worker with one acknowledged epoch each (`AtomicU64`, written
  by the host thread in `zero_batch_complete(worker, slots, count, epoch)` with `fetch_max` or a
  release store, read by the worker with acquire). Registration and unregistration are needed:
  an isolate that exits without unregistering stalls reuse for its worker forever.
- A quarantine in the arena: `free` pushes `(index, epoch_at_free)` to a FIFO (`VecDeque`) instead
  of the free list (arena.rs:182). Epochs are monotonic, so the worker releases from the front
  while `front.epoch <= min(acks)`. `allocate` takes from the reusable list, then grows, then
  returns `Error::Limit` (the 503 path). Capacity for the quarantine has to be reserved as chunks
  grow, or the warm path allocates and fails the counting-allocator assertion.
- Edge rules the design leaves open: a target that has never received a batch from this worker
  (does it count in the minimum?), a target that is idle (its ack must be able to advance without
  a batch, or reuse stalls under light load), a slot id moved between isolates by `postMessage`
  (DESIGN 7.3 says "every registered host target", so the minimum is global, not per pairing),
  and a stalled target (lease timeout should also force-unregister, or the quarantine fills the
  arena and the core answers 503 forever).
- The 14 spare high bits of the word could carry a truncated free epoch instead of a separate
  queue; the FIFO keeps the word layout unchanged and makes the release check O(1), so the word
  bits are better kept for a writer bit (item 5 above).

## 6. Batch dispatcher: what is missing

Nothing exists in zero-rt or zero-http. Needed, with what in the tree each piece can build on:

- A per-worker ready queue of tier 3 slot ids plus route ids (bounded, preallocated).
- Batch assembly: whatever is ready up to `MAX_BATCH_SIZE`, never held back; per-batch storage for
  the slot-id and route-id arrays that stays valid until the batch completes, from a per-worker
  pool sized `MAX_BATCHES_IN_FLIGHT` times targets (the `#[repr(C)]` descriptor itself belongs to
  zero-ffi; zero-rt can own the arrays and hand out slices).
- A target trait object, `Send + Sync`, with a non-blocking post that returns full rather than
  waiting (Node's ThreadsafeFunction `NonBlocking` returns `QueueFull`, DESIGN 8.5). On full, the
  batch stays queued and dispatch to that target resumes on its next completion wake.
- Two different bounds that the design names as one: the target's own queue (TSFN
  `max_queue_size` 4 counts calls JavaScript has not run yet) and batches whose slots have not all
  completed (async handlers complete a subset of a batch later). The dispatcher has to track
  remaining slots per batch to know when a batch leaves flight.
- The 503 rule: past `MAX_QUEUED_BATCHES_PER_CORE` queued batches, a synchronous admission check
  the request path calls before leasing, answering 503 with `Retry-After` from tier 0.
- Back pressure on reading: the driver already stops parsing a connection whose ring is at
  `max_pipelined` (`crates/zero-http/src/conn.rs:468-470, 855-857`), so a connection whose tier 3
  requests are waiting stops reading once its ring fills; there is no hook to stop it earlier.
- Lease timeout per slot on the core's `Timer` (`Core` implements it: tokio
  `crates/zero-io/src/tokio_rt/worker.rs:146-161`, compio `crates/zero-io/src/compio_rt/worker.rs:131-146`),
  cancel on client gone (the word's cancel bit plus any local `Cancel`), `late_reader` re-poll and
  count, and new `Event` variants or counters for QueueFull, 503 and late readers.
- Panic policy for the dispatcher task: under `Worker::spawn` a panic is a `TaskPanic` and the core
  serves on (worker.rs:109-120), but every leased slot then has no one to complete it. It should
  fail the core closed like the worker loop, or be restarted with its state intact.

Where tier 3 plugs into zero-http: `request_task` takes the record by value and returns it
(`conn.rs:147-150`), and the ring builds each request future from a plain function pointer
`make: fn(Rc<Shared<H>>, Box<Record>) -> Req` (`conn.rs:304`). A tier 3 request future can
therefore move the `Box<Record>` into an arena slot (no copy, the box address is stable), submit
the slot, await completion, and hand the record back to the ring. Going through the `Handler`
trait instead would mean copying, because `Handler::handle` only gets `&mut Call<'_>` borrowing a
record the ring owns (`crates/zero-http/src/handler.rs:35`). The per-core construction point for
the arena and dispatcher is the closure passed to `zero_rt::start` in
`crates/zero-http/src/server.rs:156-176` (and 211-230 for `serve_with`).

## 7. Host access to slot memory

- `Arena<T>` is `!Sync` (the `UnsafeCell` in `Entry`, arena.rs:30-33), `Entry` is private, and
  the only accessors are `&mut self` (`get_mut`) or tied to `&self` (`word`). A host thread holding
  a 53-bit id has no way to find the slot's word or record.
- zero-rt cannot write `unsafe impl Sync`, and zero-ffi cannot implement `Sync` for zero-rt's type
  (orphan rule), so the shareable view has to be made of types that are already `Send + Sync`. A
  safe-Rust option: zero-rt publishes each chunk's base address in a fixed table of
  `AtomicPtr` (`AtomicPtr<T>` is `Send + Sync` for any `T`; creating the pointer from the boxed
  slice is safe), sized `limit / chunk`, one table per worker in an `Arc` created before the
  threads start. zero-ffi indexes it by worker and index, loads with acquire, and dereferences
  under a `// SAFETY:` comment that cites the borrow it holds. The record type and its field
  accessors must be reachable from zero-ffi, which today means either zero-ffi depends on
  zero-http (`Record` is `pub` with `pub(crate)` fields, record.rs:27-60) or the leased view is a
  separate type defined lower down.
- Pre-creating per-core shared state before threads start is the pattern both backends already
  use for the accept handoff: tokio creates the channels in `serve` before spawning
  (`tokio_rt/worker.rs:284-299`), compio creates `Vec<Arc<Slot>>` (`compio_rt/worker.rs:266-276`).
  zero-rt's `start` can do the same around `rt::serve` and capture an `Arc<[PerCore]>` in the
  `per_core` closure (it must be `Send + Sync`, worker.rs:215), indexing by `core.index()`; no
  zero-io change is needed.

## 8. Cross-thread wakes today

| Path | Producer thread | Mechanism | Where |
|---|---|---|---|
| WebSocket room broadcast | any thread calling `Rooms::broadcast_*` (`Rooms` is `Send + Sync`) | per-member `Inbox { Mutex<Queue { frames, bytes, overflowed, waker: Option<Waker> }> }`; push under the lock, take the waker, wake after unlocking | `crates/zero-realtime/src/rooms.rs:34-86`, broadcast 175-203 |
| Room delivery on the member's core | member's connection task | `Inbox::poll_ready` registers `cx.waker()` inside the connection's combined `poll_fn` with read and shutdown, then `take()` drains | `crates/zero-realtime/src/websocket.rs:382-400`, 204-221 |
| Shutdown, tokio | any | `Arc<{ AtomicBool, tokio::sync::Notify }>`, `notify_waiters` after a release store; waiters `enable()` before checking the flag | `crates/zero-io/src/tokio_rt/shutdown.rs:19-54` |
| Shutdown, compio | any | `Mutex<Waiters { slots: Vec<Option<Waker>>, free }>`; flag stored under the lock, wakers taken and woken | `crates/zero-io/src/compio_rt/shutdown.rs:21-112` |
| Accept handoff, tokio (Windows, macOS, or `handoff`) | core 0 | `tokio::sync::mpsc::unbounded_channel`, one per core, receiver in `RefCell` | `tokio_rt/listen.rs:28-36, 51, 81-106`; channels made at `tokio_rt/worker.rs:284-299` |
| Accept handoff, compio | core 0 | `Slot { Mutex<{ VecDeque<Handoff>, Option<Waker> }>, closed: AtomicBool }`, same shape as the rooms inbox | `compio_rt/listen.rs:29-79, 240-268` |

The handoff exists only when `per_core_listeners` is false (`crates/zero-io/src/net.rs:55-57`,
Linux without `handoff`), so on Linux there is no per-core cross-thread channel at all today.

The seam (`crates/zero-io/src/seam.rs`) has no wake or mailbox trait; `Runtime` is only
`spawn_local` (35-44). zero-io is the only crate allowed to name tokio (DESIGN 5.2), so zero-rt
cannot reach `Notify` or `mpsc` directly. The rooms and compio-slot pattern is plain `std` and
works on both backends, which is why it is the template for the completion intake.

What a `Waker::wake` from a foreign thread does on each backend:

- io-tokio: tasks are `tokio::task::spawn_local` inside a `LocalSet` driven by
  `LocalSet::block_on` on a current-thread runtime (`tokio_rt/worker.rs:129-144, 367-373`). From
  the tokio 1.53.1 source (docs.rs, fetched 2026-10-01): `Shared::schedule` (local.rs about
  1089-1131) says "We are *not* on the thread that owns the `LocalSet`, so we have to wake to the
  remote queue", pushes onto `Shared.queue: Mutex<Option<VecDeque<task::Notified<Arc<Shared>>>>>`
  (about line 255) and calls `self.waker.wake()`; that `AtomicWaker` is registered by
  `RunUntil::poll` from the runtime's `block_on` context (about 1067-1068), and
  `LocalSet::block_on` is `rt.block_on(self.run_until(future))` (about 673-677). The
  current-thread `Handle`'s `wake_by_ref` (current_thread/mod.rs about 781-803) sets `woken` and
  calls `driver.unpark()` when not called from that scheduler's own context, which is the case on
  a host thread. The remote queue is also checked every `REMOTE_FIRST_INTERVAL = 31` ticks
  (local.rs about 470). Net effect: one mutex push plus one driver unpark per wake.
- io-compio: `TaskWaker::wake_by_ref` (`compio_rt/executor.rs:92-100`) swaps `scheduled`, pushes
  the task index onto `Queue.ready: Mutex<Vec<usize>>`, and, off the owning thread, calls the
  proactor's waker (`driver: proactor.waker()`, 113), which compio-driver 0.12.5 documents as
  "Create a waker to interrupt the inner driver" (docs.rs, fetched 2026-10-01). `park`
  (255-275) waits with a zero timeout if `ready` is non-empty.
- Evidence in tests: `compio_rt/shutdown.rs:158-175` wakes a core from a plain thread once; the
  realtime test runs 2 cores (`crates/zero-realtime/tests/realtime.rs:136`) and broadcasts among
  3 members (477-512), which crosses cores with certainty only under the round-robin handoff
  (Windows, macOS), not under Linux `SO_REUSEPORT` hashing.

## 9. How a worker can await a completion posted from a host thread

A shape that uses only what exists, keeps zero-rt safe, and posts one cross-thread wake per
`zero_batch_complete` as DESIGN 8.1 asks:

1. Per worker, before threads start (section 7), an `Arc<Completions>`:
   `Mutex<{ slots: Vec<u64> (reserved to in-flight capacity), waker: Option<Waker> }>` plus the
   per-target ack `AtomicU64`s. Same shape as `rooms::Inbox` and `compio_rt::listen::Slot`.
2. Host thread, inside `zero_batch_complete` (zero-ffi): for each id, `SlotWord::complete(gen)`
   (the release); then lock, append ids, store the ack epoch, take the waker, unlock, wake once.
   A stale or `Closed` id is reported per slot and still acknowledged.
3. Worker: one dispatcher task spawned with `Worker::spawn`, whose loop awaits
   `poll_fn(|cx| completions.poll_ready(cx))` raced with the shutdown signal (the way
   `websocket.rs:388-402` races inbox, read and shutdown). On wake it swaps the vector out,
   checks `readers()` on each slot (re-queue the late ones for the next turn and count them),
   and wakes the waiting request futures.
4. Request side: the tier 3 request future in the connection's ring registers its waker in a
   per-slot local cell (`Rc`, `Cell`, `RefCell<Option<Waker>>`, exactly like `Cancel`,
   cancel.rs:10-55) and returns the record when its slot is `Completing` with no readers. These
   wakes are same-thread, so on tokio they go to the local queue and on compio they skip the
   driver interrupt (executor.rs:97).

Costs to measure in the micro-harness: one mutex acquisition and one driver unpark (eventfd or
IOCP post) per batch on the host side, plus tokio's own remote-queue mutex push for the woken
task. `Vec` and tokio's `VecDeque` growth must be warmed or reserved to keep the counting-allocator
assertion. A lock-free MPSC would avoid the mutex but needs unsafe or a crate, so the mutex
version is the one that fits zero-rt's rules.

## 10. loom and TSan readiness

- loom is not a dependency of any workspace crate; it is in `Cargo.lock` only through
  compio's graph (`compio-send-wrapper`, `synchrony`) and has a cargo-vet exemption at 0.7.2
  (`supply-chain/config.toml:289-291`). `deny.toml:10-12` sets `exclude-dev = true`, so a
  dev-dependency does not enter the deny allowlist.
- crates.io (fetched 2026-10-01, `https://crates.io/api/v1/crates/loom`): max_stable_version
  0.7.2, updated_at 2024-04-23, not yanked, repository tokio-rs/loom. Against .github/cloud/RULES.md
  currency rules this is a 0.x line with no release in the last 12 months; adopting it as a
  dev-dependency needs either the crate declared finished or a recorded owner exception (DESIGN
  7.3 names loom explicitly, which may count as the recorded reason for 0.x but not for the
  12-month rule).
- loom 0.7.2 `AtomicU64::new` is `pub fn new(v: u64) -> Self` (docs.rs, fetched), not shown as
  `const`, while `SlotWord::new` is `const fn` (slot.rs:89-93). A `cfg(loom)` swap of the atomic
  type breaks that, so either `new` loses `const` under loom or the model drives a
  test-only copy of the word. The methods the word uses (`load`, `compare_exchange_weak`,
  `fetch_or`, `fetch_sub`) exist on loom's `AtomicU64`.
- `cfg(loom)` is an unexpected cfg under the workspace lint table (`Cargo.toml:102-111` has no
  `check-cfg`); with clippy at `-D warnings` the table needs a `check-cfg` entry (workspace
  table, since Cargo replaces package tables) or the model uses a cargo feature instead.
- A loom model of the real arena would also need `loom::cell::UnsafeCell` in place of
  `std::cell::UnsafeCell` to catch record races; the realistic target is a small model of the
  word plus a payload cell: a host thread doing borrow, read, drop, complete against a worker
  doing lease, recycle, re-lease with a new generation, asserting a stale id never reads the new
  payload.
- TSan: the job is wired (`ci.yml:370-411`, nightly, `-Zbuild-std`, `-p zero-rt -p zero-ffi`);
  it needs the ignored `slot_recycle` test to exist and to run tier 0 traffic and tier 3
  completions on one core, which needs the dispatcher and the completion intake first.

## 11. Unverified

- Tree Borrows and Stacked Borrows rulings on item 4 of section 4 (worker `&mut Entry` or
  `&mut [Entry]` while another thread reads the word through `&`). Not checked; settle under Miri
  with threads before zero-ffi dereferences arena memory.
- tokio line numbers above are as the docs.rs source pages reported them through a fetch
  summary; the quoted behavior (remote queue push, `AtomicWaker` wake, `driver.unpark()` from a
  foreign thread) was stated by the fetched source, the exact line numbers were not
  cross-checked.
- compio-driver 0.12.5: whether `Proactor::poll` resets the driver's internal notified state.
  The `flush` docs say it "resets the internal notified state" and is "only needed if you're
  waiting on the driver fd with an external event loop", which implies `poll` handles it, but
  the docs do not say so. The executor never calls `flush`. Only a single cross-thread wake is
  tested (`compio_rt/shutdown.rs:158-175`); a test of repeated cross-thread wakes on one core
  would settle it before the dispatcher depends on it.
- Whether loom 0.7.2's `AtomicU64::new` is `const` (the docs page shows `pub fn new`, read as
  not const).
- Cost of a cross-thread wake on either backend (mutex plus eventfd or IOCP post); not measured.
- No build or test was run for this map.
