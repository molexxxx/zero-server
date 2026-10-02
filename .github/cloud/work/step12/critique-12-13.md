# Critique of DESIGN-12-13.md (steps 12 and 13)

Critic pass, 2026-10-02. Read: BRIEF.md; zero-core `.github/cloud/RULES.md` and `.github/cloud/RULES.md`;
DESIGN.md sections 5, 7 (7.3 in full), 8, 10.1, 10.2 and ROADMAP R.3 rows 12 and 13;
DESIGN-12-13.md in full; the six maps; and the code the design plans to change (zero-http
`record.rs`, `conn.rs`, `server.rs`, tests; zero-rt `worker.rs`; zero-io `tokio_rt/worker.rs`;
zero-limits; zero-serve; xtask `packages.rs` and `lints.rs`; zero-realtime `rooms.rs`; the 1.x
`test/http/response.test.js`). No repository file was edited.

Fetched for this critique (2026-10-02):

- napi-rs 3.14.0 source, `crates/napi/src/threadsafe_function.rs` at tag `napi-v3.14.0`
  (raw.githubusercontent.com): the closure passed to `build_callback` is called in `call_js_cb`;
  an `Err` it returns becomes a `JsError` value, and `call_js_cb_raw` matches
  `Err(error_value) if !callee_handled => (unsafe { sys::napi_fatal_exception(raw_env, error_value) }, None)`.
  `handle_call_js_cb_status` routes other non-ok statuses to `napi_fatal_exception` as well.
- Node v22.23.3 Node-API: `napi_fatal_exception`: "Trigger an 'uncaughtException' in JavaScript.
  Useful if an async callback throws an exception with no way to recover."
- Node v22.23.3 CLI, `UV_THREADPOOL_SIZE`: "The default size of the threadpool is 4 threads";
  threadpool users include `dns.lookup()`, some `fs` operations, `crypto.pbkdf2/randomBytes/scrypt`
  and `zlib`.
- loom 0.7.2 `sync::Mutex` (docs.rs): `try_lock(&self) -> TryLockResult<MutexGuard<'_, T>>` exists
  (the design's worker-side `try_lock` shim is implementable under loom).

Inherited facts are cited as "facts N" (facts.md, fetched 2026-10-01). Design line numbers refer
to DESIGN-12-13.md as read today.

Findings are ordered most severe first.

## 1. Acknowledgment race: a fast host's ack is refused because `published` is stored after the post (lost ack, permanent stall)

Severity: high (deadlock between worker and host).

Where: section 4.5 (lines 678-685) and section 5.2 step 3 (lines 836-837).

Evidence: the dispatcher "assigns `published + 1` to a batch, writes it into the ring entry,
posts, and on `Taken` stores it with `Release`" (line 678-680; step 3: "stamp `published + 1`;
`post`. `Taken`: push `(epoch, entry)` to `unacked`, store `published`"). `zero_batch_complete`
with a nonzero epoch "succeeds only when ... `epoch == acked + 1` and `epoch <= published`"
(lines 681-683), and "Anything else returns `InvalidArgument` and changes nothing" (684). Section
4.6 step 2 makes the refusal atomic for the whole call: "It checks the pointers, the worker index
and the epoch rule first (a refusal changes nothing)" (lines 709-711).

Interleaving: the worker calls `TsfnTarget::post` (napi queue push plus `uv_async_send`) or
`PullTarget::post` (queue push plus `Condvar::notify_one`). The host thread wakes, runs the batch
synchronously and calls `batchComplete(worker, ids, count, e)` before the worker thread returns
from `post` and stores `published = e` (preemption of the worker right after the syscall is
enough). The host's call sees `e > published`, is refused, and "changes nothing": neither the ack
nor the batch's completions are applied.

Consequence: acks are strictly in order, so `acked` stays at `e - 1` forever: every later ack
(`e + 1`, ...) fails `epoch == acked + 1`. The batch's sealed slots are never imported (their
clients wait for `request_total`, 300 s). In flight never drops, so after four batches the
dispatcher posts nothing, `ready` fills, and the core answers every tier 3 request 503 until the
server is restarted. The quarantine also stops releasing (floor stuck). None of the loom models
covers the post-then-store ordering (`loom_intake_loses_no_completion` acks epochs 1 and 2 with
no post at all, line 1611), and TSan cannot see it (no data race), so the defect would ship as an
intermittent, permanent stall.

Fix: store `published` (Release) before calling `post`, and roll it back on `Full` or `Gone`
(only the worker writes it, and a host cannot hold an epoch it never received). Alternatively
drop the `epoch <= published` condition, since a host can only learn an epoch from a delivered
batch. Separately, decouple the completions from the ack: apply the listed ids even when the ack
is refused, and report the ack refusal on its own. Add a dispatcher test whose `TestTarget` acks
inside `post` (synchronously, before returning `Taken`).

## 2. A Rust-side `Err` in the ThreadsafeFunction callback reaches `napi_fatal_exception` (process crash)

Severity: high (contradiction with napi-rs 3.14.0 as fetched; crash of the host process).

Where: section 8.4 (lines 1736-1750, 1761-1763) and 8.2 (`node_guard`, lines 1686-1690).

Evidence: the callback is `node_guard_callback(|| { ... shared.ring.read(ctx.value, ...)?; ...
BufferSlice::copy_from(...)?; ... events_to_js(...)? })` with `.callee_handled::<false>()`. The
design guards only the JavaScript side ("a throw from the JavaScript callback goes to
`napi_fatal_exception` (facts 2), so the facade's dispatch function wraps its whole body in
try/catch and never throws", lines 1761-1763), and `node_guard` turns a panic into a JavaScript
`Error` (line 1686-1690), which the closure returns as `Err`. In napi-rs 3.14.0 an `Err` from the
closure with `CalleeHandled = false` is passed to `napi_fatal_exception` (fetched source above),
which triggers `'uncaughtException'` (Node-API text above): the main isolate exits unless the
application installed a handler, and a pool-mode worker isolate terminates.

When `ring.read` refuses: target loss frees the ring entries and stores `acked = published`
(section 4.8, lines 750-754), and dropping the last `Arc<TsfnTarget>` releases the function, but
Node empties the queue first and calls `call_js_cb` "once for each value that was placed into the
queue", with a NULL env only "when the Node.js process exits" (facts 7). So `app.close()` (reaper
detach) or `targetDetach` with batches still queued delivers those batches with a live env, the
closure finds the entry freed (or reused by a newer epoch after a new server claimed the index in
inline mode, decision 9), returns `Err`, and the process crashes. The same happens on any Rust
panic inside the callback, on an allocation failure in `BufferSlice::copy_from`, and on any
`events_to_js` error.

Fix: the closure must never return `Err`. Map every refusal or failure to a value the facade
ignores (for example `DispatchArgs::stale(worker, epoch)` with `records = null`, never acked),
count it, and keep `node_guard` for panics but convert the caught panic to that value as well,
reporting it through the status callback. Add `runtime-24`-style tests that detach a target with
four batches queued and assert the isolate survives.

## 3. Staging send does not check that the ArrayBuffer it detaches is the region it installs

Severity: high (JavaScript-writable memory under a Rust `&[u8]` during writev; wrong bytes on the
wire).

Where: section 8.7 steps 1 and 3 (lines 1819-1839) and 8.10 (`resStage`, `resSendStaged`,
lines 1969-1970); decision 13.

Evidence: `resStage(slot, len)` "stores the `Arc` in the isolate's staging map under the slot id"
and returns the external `ArrayBuffer`. `resSendStaged(slot, status, fields, arrayBuffer)` checks
`is_detached()` on the buffer it is given, detaches it, then installs `set_external(region)` with
the region taken from the map. Nothing ties the two: the passed buffer's data pointer and length
are never compared with the region's.

Failure paths:

- `res.alloc(len)` is public in `@zero-server/core` (section 8.11, line 1998). Calling it twice for
  one slot overwrites the map entry (no refusal is specified); sending through the first buffer
  detaches buffer 1 and installs region 2, which is still attached to buffer 2 that JavaScript
  holds. JavaScript writes then race the worker's `ExternalBody::bytes(&self) -> &[u8]` read
  (section 3.7, line 410) on another thread: a data race on memory Rust holds a shared reference
  to, which is undefined behavior, and nondeterministic response bytes. A facade bug that passes
  another slot's buffer has the same effect.
- facts 4 (read in source): on `napi_no_external_buffers_allowed`, `ArrayBuffer::from_external`
  "copies, then runs the finalizer immediately"; it does not say that it returns an error. The
  design's "the call reports `ZERO_UNSUPPORTED` and the facade copies" (line 1828-1829) therefore
  has no signal to act on. The facade fills a JavaScript-owned copy, the send detaches that copy
  (if V8 allows it) and installs the zero-filled region: the client receives zeros.

Fix: keep a napi `Reference` to the staged `ArrayBuffer` in the staging map and detach that
reference, not an argument; or compare the argument's data pointer and length with the region's
before detaching and refuse a mismatch. Refuse a second `resStage` while one is open on the slot.
Detect the copy fallback explicitly (the hint's `Arc::strong_count` after `from_external`, or the
data pointer of the returned buffer) and return `ZERO_UNSUPPORTED`. Add vectors for "second alloc
then send through the first buffer" and "send with a foreign ArrayBuffer".

## 4. The dispatcher task keeps the zero-io drain open, so every shutdown waits the full drain deadline

Severity: high (termination defect; breaks `runtime-23`, the lifecycle rows and the legacy hooks).

Where: section 3.2 ("`make` also spawns the per-core dispatcher task with `Worker::spawn`", lines
264-265) and section 5.2 step 5 ("Sleep on ... the shutdown signal", lines 844-846). No exit
condition is given anywhere.

Evidence: `Worker::spawn` runs the task through `self.core.spawn_local` (zero-rt
`worker.rs:109-120`), which increments `Tasks.live` (zero-io `tokio_rt/worker.rs:129-143`). After
the accept loop returns, the worker waits `tokio::time::timeout(config.drain, tasks.drained())`
and `drained` returns only when `live == 0` (`worker.rs:83-94`, `423-429`). A dispatcher loop that
keeps sleeping keeps `live >= 1`, so drain always runs to the deadline. If the task instead exits
on the shutdown signal, in-flight tier 3 futures are never woken (their completions sit in the
intake) and they too hold the drain to the deadline, then lose their responses when the runtime
is dropped. The host-driven WebSocket and SSE loops in `HostHandler::taken` have the same open
question (WP-4's `with_outbox` loops must end on shutdown).

Consequence: with the 1.x default of 30,000 ms (map-node-api, `app.shutdown` default) every
`app.close()`, `app.shutdown()` and `serverWait` takes the whole deadline even when idle; the
strong ThreadsafeFunction is released only after the reaper joins (section 8.4, lines 1763-1766),
so `runtime-23` ("closing the server releases the dispatch function, so the isolate exits") takes
the deadline; legacy `afterAll(() => server.close(...))` hooks and the lifecycle cases that expect
a prompt shutdown run into the test runner's hook timeout; a CLI script that closes its server
cannot exit for 30 s. Finding 12 compounds it.

Fix: specify the dispatcher's exit rule: after shutdown, keep draining the intake and posting
until no waiter, queued job, late-list entry or unacknowledged batch remains (or the deadline
passes), then return; make the realtime glue end its loops on the shutdown signal. Add a zero-host
test asserting `zero_server_wait` returns within a small bound after `zero_server_shutdown` on an
idle server, and one with a tier 3 request in flight.

## 5. Tier 0 middleware runs ahead of user middleware registered before it (authorization bypass)

Severity: high (security regression introduced by the facade; changes legacy ordering).

Where: section 8.11 middleware row (line 2009) and section 8.12 D8 (lines 2029-2033).

Evidence: "`cors`, `static`, `helmet`, `requestId` compile to tier 0 policies and routes when used
in `app.use(...)`, `app.use(prefix, ...)` or as a route's leading middleware (elsewhere
registration throws naming the position)". The "leading" restriction is stated for route chains
only; for `app.use` any position compiles to tier 0. `HostHandler::handle` serves
`RouteKind::Static` in `tier0::serve` without a crossing (section 3.3, lines 278-281), and D8
leases only misses and host routes to the global JavaScript chain. map-node-api (lines 231-240,
698-699) records the 1.x rule: every `app.use` function runs in order before routing, "so a file
shadows a route of the same path", and "Tier 0 rules ... also lose their position in the `use`
chain relative to user middleware".

Consequence: `app.use(requireAuth); app.use(static('./private'))` protects files in 1.x and
serves them to anyone through the facade, silently. A `logger` registered first never sees static
requests. No legacy case was found that pins the auth order, so the runner will not catch it.

Fix: in `app.use`, accept a tier 0 middleware only while no user function precedes it in the same
chain (throw naming the position otherwise, as for route chains), or lease requests for such a
static mount to the host so the preceding chain runs. Record the decision as a CHANGELOG entry and
add a facade test for the auth-before-static order.

## 6. Export can fail on a busy slot lock and leaks the claimed index (lock-then-check lets stale hosts take the lock)

Severity: medium-high (spurious request failure plus permanent slot leak, reachable by any host
holding a stale id).

Where: section 3.3 `lease::dispatch` (lines 310-318), section 4.2 (lines 553, 565-567) and 4.3
(lines 592-596).

Evidence: `allocate` "resets the payload under `try_lock`" and unlocks; then
`slot.with_worker(id.generation(), |x, view| call.export(...))?;` takes a second `try_lock`, and
`with_worker` "maps a failed `try_lock` to `Busy`". Lock-then-check means any host call on that
index takes the mutex first and checks the generation inside it, including a call with a stale
id, which the design expects hosts to make ("Ids moved between isolates ... are covered by the
generation and the lock", line 694-695; the TSan test's H3 loops over 512 stale ids, line
1630-1632). If a host holds the lock between the reset and the export, `?` returns `Err` from
`dispatch`. The `LeaseGuard` is created only after export (line 318), so nothing retires the slot:
it stays `Parsing` forever (only the worker retires, invariant I1), `live` stays incremented, and
after enough such races `admit` refuses and the core answers 503. The request itself fails with a
problem response although nothing was wrong with it. The `hold(...)?` on the next line has the
same leak shape.

The same contention reaches import: a busy lock sends the slot to the late list, re-polled every
1 ms (section 4.6 step 4); a host hammering stale ids on one index can delay that response
indefinitely. Note the sketch at line 326 calls `guard.import(...)?` synchronously, which
contradicts the late-list rule of 4.6 step 4 and would turn a busy lock into a failed request.

Fix: hold the guard from `allocate` through export and `hold` (return the `MutexGuard` from
`allocate`, or let `allocate` take an index only when it can keep the lock), and create the
`LeaseGuard` immediately after `allocate` so every early return retires. Add a cheap pre-check
to the host helpers: an `Acquire` load of the word before locking, returning `Closed` on a
generation mismatch, then the existing re-check inside the lock (no RMW added, soundness
unchanged, stale callers no longer touch the worker's lock). Make `import` explicitly async with
the late list in the sketch.

## 7. Retired exchanges keep request bodies outside the memory budget, and the arena never gives memory back

Severity: medium-high (unbounded memory relative to `REQUEST_MEMORY_PER_CORE`; permanent growth).

Where: section 3.1 (line 231), 3.4 (lines 346, 373-375), 4.2 (lines 545-569), 4.5 (line 701-702).

Evidence: export moves the request body into the exchange by swap (line 346); the exchange is
reset only "at the next `allocate` of that index" (line 231; 4.2: "The payload is reset at
`allocate`, not at `retire`"). Today the body charge belongs to the ring entry and is released
when the entry is released after the write (`conn.rs:132-138`, `uncount_body` at `conn.rs:659`),
so after completion the bytes in the exchange are counted by nothing; the design's "the body's
budget charge moves from the record to the slot's leased bytes" (line 346) never says when that
charge is released, and releasing it at retire leaves the same gap (releasing it at reset instead
would hold accepts paused while idle slots wait for reuse, and with no new connections no reuse
happens). The free list is FIFO ("a hot index waits behind every other free index", line 546),
so every grown slot cycles and keeps warm buffers; chunks are added and never removed, and they
persist across servers (decision 9). The record pool caps itself at `RECORDS_KEPT` = 4,096 per
core (`conn.rs:113-119`); the arena has no cap below `SLOTS_PER_WORKER` = 65,536.

Numbers: default `max_body` is 1 MiB (`zero-limits/src/http1.rs:18`) and the per-core budget 256
MiB (`services.rs:12`). After a burst of async tier 3 requests (which hold no in-flight place,
decision 6) each grown slot can hold up to 1 MiB of body until its index cycles, and at least
`BODY_KEEP` (64 KiB, `record.rs:24`) of body plus head, trailer and field capacity forever after
its reset. For a canceled lease the host-written response (up to `maxResponseBody` 64 MiB, section
6.7) stays in the exchange until reuse, and "resets the response side" (line 374-375) does not say
the response body is shrunk.

Fix: when the floor releases an index from quarantine (`Allocator::release`), clear and shrink
the request and response buffers under `try_lock` (the epoch gate has already passed, so no view
can need them), and keep a byte counter of retained capacity that `HostHandler::leased_bytes`
reports; cap the number of warm slots (drop buffers of slots beyond a `SLOTS_KEPT` bound, the
counterpart of `RECORDS_KEPT`), or switch to LIFO reuse among released indexes now that the epoch
gate, not reuse distance, protects stale ids. Add a test that a burst of large-body tier 3
requests returns the process to its idle footprint.

## 8. The loom models do not demonstrate the step 12 exit statement for the path that can read another request's bytes

Severity: medium (exit criterion not met as designed).

Where: section 7.1 table (lines 1605-1613); exit statement in ROADMAP R.3 row 12 ("loom finds no
interleaving in which a stale id reads another request's data").

Evidence:

- The C view hands out raw pointers that the host dereferences after the call; validity rests on
  the view rule (pin table and bound-thread token in zero-host thread locals, lines 616-650) plus
  the epoch floor. The models run only zero-rt types, and the payload `View` is a tag atomic read
  inside `read_view`; no model has a reader read payload state after the accessor returned while
  inside its batch window, then ack, against a worker that waits for that ack before reusing the
  index.
- `loom_stale_id_never_reads_another_request` has the worker store the ack itself ("retire, ack
  stored, allocate generation 1", line 1607), which contradicts invariant I9 ("`acked` advances by
  one, only from the target's bound thread", line 785-786) and removes the host-ack-then-reuse
  ordering the view guarantee depends on.
- The post and `published` ordering of finding 1 is not modeled at all.

Fix: add a model with a bound host thread that receives a batch through a modeled `post`, calls
`read_view`, then reads the payload tag again after return (the stand-in for dereferencing the
view), then acks; the worker drains the intake, releases quarantine and re-exports tag B; assert
the post-return read is tag A. Add the pinned variant on a non-bound thread, and model the post
ordering so finding 1 fails the model before the fix. Keep the ack on the host thread in every
model.

## 9. Node completion buffer can overflow, and a refused ack discards completions

Severity: medium (lost completions; requests hang to `request_total`).

Where: section 8.8 (lines 1860-1867), decision 6 (line 68-71), section 4.6 step 2 (lines
709-711).

Evidence: the per-worker completion `Float64Array` has "capacity 1,024 = 4 x 256". That bound
holds for synchronous completions (at most one batch per synchronous iteration) but not for async
ones: decision 6 makes async completions hold no in-flight place, so any number of leased async
handlers can settle in one microtask checkpoint (for example 5,000 requests awaiting one shared
pool-ready Promise), all appending before the guarded flush microtask runs. No flush-when-full
rule is given. Separately, the sync flush sends completions and the ack in one call, and a refused
ack "changes nothing" (finding 1), so any epoch mismatch (a stale delivery after target loss, a
facade bug) drops that batch's completions too.

Fix: flush when the buffer is full (one extra crossing), or size it by the leased-slot count
rather than by in-flight batches. Apply completions independently of the ack result.

## 10. Facade shapes that break release 1 legacy cases in `http/response.test.js`

Severity: medium (the step 13 exit claims these run).

Where: section 3.5 (`File` action, line 384), section 8.11 Response row (`sendFile ... without
root, the process working directory is the root`, line 2008), section 8.14.

Evidence: map-legacy-tests marks `http/response.test.js` `run` at release 1 with only the cookie
describes overridden. The 1.x file has:

- `res.sendFile('nope.txt', { root: dir }, (err) => { if (err) res.status(err.status || 500).json({ error: err.message, fromCallback: true }); })`
  with `expect(r.data.fromCallback).toBe(true)` (`response.test.js:531-555`). In the design
  `zero_res_file` is an action that seals the response and runs on the worker after completion
  (sections 3.5 and 6.5: "zero-static policy at completion; seals"), so JavaScript can never see
  the missing file or write its own body; zero-static's 404 is sent instead.
- `res.sendFile(path.join(staticDir, 'hello.txt'))` and the missing-file variant with absolute
  paths and no root (`response.test.js:152,154`). The design makes the working directory the root
  but does not say how an absolute path is mapped; passed as is, zero-static's segment rules (and
  the Windows colon rule on the Windows addon build) refuse it.
- `res.download(path, 'custom-name.txt')` expects `Content-Disposition` (`response.test.js:155,
  187`); whether `Files::serve_path` keeps the field lines the host set before the action is not
  specified (for SSE the design states the merge; for files it does not).

Fix: emulate the callback form in the facade (stat in JavaScript before calling `resFile`, invoke
the callback with a 1.x-shaped error and let the handler respond), define the absolute-path rule
(relative to the working directory when inside it, refused otherwise), state that host field lines
survive into a file response, or move these cases to `dropped` with CHANGELOG anchors in the
manifest decisions of section 8.14.

## 11. Work package ownership gaps and a dependency inside one line

Severity: medium (packages cannot meet their exits without editing files they do not own).

Where: section 14 (order at lines 2326-2335; WP-2 2368-2388; WP-3 2390-2403; WP-6 2432-2446;
WP-11 2520-2535).

- WP-3 depends on WP-2 but both are on line 2. `impl zero_rt::Payload for Exchange` (section 3.7,
  line 414) needs WP-2's new `Payload` trait, and the orphan rule forbids putting the impl in
  zero-host, so WP-3 cannot compile until WP-2 merges.
- WP-3 adds `error_shape` to `zero_http::Config` (section 3.7, line 464). These literals list every
  field without `..Default::default()` and stop compiling: `crates/zero-http/tests/driver.rs:199-213`,
  `:820-830`, `:1025-1035`, `crates/zero-realtime/tests/realtime.rs:142-152`,
  `crates/zero-tls/tests/driver.rs:77-87`. None of them belongs to any package (WP-3 owns only
  `tests/{exchange,read_hold,error_shape}.rs`, WP-4 only `tests/outbox.rs`), and WP-3's exit says
  the driver tests stay "unchanged".
- WP-2 adds `zero_rt::worker::Event::HostFailed` (section 5.7). `crates/zero-serve/src/lib.rs:678-691`
  matches `Event` exhaustively (`Started`, `Stopped`, `TaskPanic`, `WorkerPanic`, no wildcard), so
  `cargo build --workspace` fails; zero-serve belongs to no package.
- WP-2 says `max_batches_in_flight` is "validated to 1 to 4" in `services.rs`, but validation lives
  in `crates/zero-limits/src/lib.rs:139-141` (today only `== 0`), with its tests in the same file;
  `lib.rs` belongs to no package.
- WP-11 owns `bindings/node/packages/{core,sdk}/**` and `bindings/node/tsconfig.json`, but
  `cargo xtask packages` renders `packages/core/{package.json,tsconfig.json,README.md}`, the
  `@zero-server/sdk` bundle's three files and `bindings/node/tsconfig.json`
  (`crates/xtask/src/packages.rs:225-353`), and WP-6 owns that generator (including the hard-coded
  `engines` at `packages.rs:443`). Generated files are never hand-edited (.github/cloud/RULES.md); WP-11 should
  own only `src/**` and tests, WP-6 the regenerated manifests.
- The design leaves open whether zero-sse refuses CR, LF and NUL in `event` and `id` (section 16)
  and plans host-side validation "with the zero-ws and zero-sse encoders" (section 6.8); a change
  in `crates/zero-sse/**` or `crates/zero-ws/**` has no owner.

Fix: move WP-3 to the line after WP-2 (or move `Payload` into a tiny first commit of WP-1); give
WP-3 the five test files (or keep `error_shape` out of `Config`, for example on the handler); give
WP-2 `zero-limits/src/lib.rs` and `zero-serve/src/lib.rs` (or mark `Event` `#[non_exhaustive]`
in the same commit and add the wildcard arm); give WP-6 the generated package files; name an owner
for zero-sse and zero-ws edits.

## 12. `serverWait` as an `AsyncTask` blocks libuv pool threads for the whole drain

Severity: medium (starves `dns.lookup`, `fs`, `crypto`, `zlib`; worse with finding 4).

Where: section 8.2 modules (line 1693-1694) and 8.10 (`serverWait ... AsyncTask on the libuv
pool`, line 1953).

Evidence: the default pool has 4 threads (Node CLI docs, fetched today), and its users include
`dns.lookup()`. Each `close`/`shutdown` occupies one thread until the server stops, which with
finding 4 is the full drain deadline. errors.test.js closes one app per case without awaiting
(map-legacy-tests line 58), and the copied 1.x fetch client resolves `localhost`, so four pending
closes stall every later request in the file. A C host has the related trap of calling
`zero_server_wait` on its own polling thread while leases are open (O10 refuses only I/O worker
threads, line 960-963); it is bounded by the caller's timeout, but drain cannot progress
meanwhile.

Fix: report "stopped" through the status ThreadsafeFunction (or a dedicated one-shot function)
and resolve the Promise from it, so no pool thread blocks; refuse `zero_server_wait` on a thread
bound to one of the server's targets.

## 13. Status ThreadsafeFunction leaks its payload on every `QueueFull`

Severity: medium (request-driven unbounded leak).

Where: section 8.4 (lines 1772-1775).

Evidence: the status function is weak, bounded at 16, called `NonBlocking` from core threads, and
"a full queue drops the event". facts 2: in napi 3.14.0 every non-`napi_ok` call leaks the boxed
payload and its `Drop` never runs. Unlike `BatchRef`, the status payload carries strings (the
callback receives `(event, core, detail)`), and `TaskPanic` is emitted per panicking request, so a
client that can trigger a handler panic leaks one box and one message per request whenever the
isolate is busy.

Fix: count status events in flight on the Rust side and drop before calling once 16 are queued
(decrement in the callback), and make the payload a small `Copy` code with details fetched by a
pull call.

## 14. The section 8.6 budget exit cannot be met as designed

Severity: medium (exit criterion).

Where: section 9.1 (lines 2111-2112), 9.2 (line 2133, 2139-2140), WP-2 (line 2373-2374), section
8.4 (`max_queue_size::<4>()`).

Evidence: R.3 row 13 requires "the section 8.6 cells hold their budgets", and DESIGN 8.6's table
includes "8 items and 8 in flight 250 ns". The design hard-caps in flight at 4
(`max_batches_in_flight` validated 1 to 4, `max_queue_size::<4>()` as a const generic), so
`node_grid_8x8` cannot be produced through the real binding. The one reachable cell that matters
(4 by 4, budget 700 ns) is estimated at 680 ns "with no accessor", which excludes the facade's own
per-request work: `reqHead` (one crossing, two RMWs and two V8 strings at about 87 ns each per
DESIGN section 2), two objects, the chain runner and `JSON.stringify`. Hardware cells may also be
"reported skipped" (line 2139-2140), which does not hold a budget.

Fix: ask the owner to restate the cells against the in-flight cap (or lift the cap for the
measurement), define the measured handler (with or without `reqHead`), and state what a skipped
cell means for the exit.

## 15. "Every accessor returns a status on stale input" cannot hold for the string and buffer functions

Severity: medium-low (exit criterion wording).

Where: section 6.1 O7 (lines 951-953), 6.5 (lines 1103-1111), 6.14 (`handles.rs`, line 1492).

Evidence: `zero_string_data`, `zero_string_len`, `zero_string_free`, `zero_buffer_data`,
`zero_buffer_len` and `zero_buffer_free` take raw owned pointers and `peek` dereferences them; a
stale (freed) pointer is a use-after-free and a second free is a double free. The table test of
section 6.16 cannot include those cases, so the R.3 row 12 statement is not met for six exports.

Fix: either make strings and buffers generation-checked ids in a per-thread or global slab (total
like every other handle), or record the exception in the exit wording and in `zero.h` with the
ANSSI FFI-MEM-OWNER reasoning.

## 16. Per-root `Files` cache grows without bound

Severity: medium-low (unbounded memory from host input).

Where: section 3.5 (`File { root, path }` ... "with a `Files` for that root, cached per root in
`CoreHost`", line 384).

Evidence: `root` is a host argument per call (`res.sendFile(name, { root: '/srv/tenants/' + id })`
in a multi-tenant app). Each `Files` carries its own per-core small-file cache (DESIGN step 9), and
no eviction or bound is given.

Fix: bound the cache (small LRU by root) or share one `Files` per core whose policy takes the root
per call.

## 17. Thread-bound pins can leak into a permanent 1 ms timer; pull model and release 2 asyncio

Severity: low-medium.

Where: section 4.3 (lines 637-650), 6.5 (`zero_slot_unpin` "InvalidArgument unless this thread
pinned that id", line 1170), 4.6 step 4 (late list re-polled "on a 1 ms core timer while
non-empty", line 720-723), section 10.2 (line 2198-2199).

Evidence: a pin can be released only by the thread that took it; a thread that exits holding a
pin "keeps those slots out of reuse, which is the safe direction" (line 648-650), but the slot
also stays on the late list, which keeps a 1 ms timer firing on that core forever (idle CPU,
DESIGN goal 3). Separately, the Python test `test_serve.py` is presented as "the shape the release
2 handler thread takes", but DESIGN 8.5 runs the asyncio loop on that same handler thread: a thread
blocked in `zero_target_poll` cannot run coroutines, and a separate polling thread would be the
bound thread, leaving the loop thread without views or acks. The pull ABI needs a pollable wake
handle (an fd or event the loop can select on) before release 2, and `zero.h` is ABI 1.

Fix: back off the late-list timer for slots pinned longer than a threshold (or re-poll only on
unpin events), let the worker release pins of threads that are gone if a pin token is used instead
of a thread table, and reserve a `zero_target_fd` entry point (or state the release 2 plan) now.

## 18. Pool mode never replaces a dead isolate; the default thread count can be refused

Severity: low-medium.

Where: section 4.8 ("A worker with no target admits no tier 3 request", line 758), 8.3 (default
`os.availableParallelism()`, lines 1700-1702), 6.9 (`threads` "refused above the free worker
indexes", line 1357).

Evidence: an isolate that dies (finding 2, an out-of-memory, `process.exit` in a worker) detaches
its target, and its core answers every tier 3 request 503 for the life of the server while
`SO_REUSEPORT` keeps sending it a share of new connections; no respawn policy exists. The default
`threads` is `availableParallelism()`, which exceeds the 128 worker indexes on large hosts and,
with a second server in the process, exceeds the free indexes on smaller ones; the design refuses
instead of capping.

Fix: respawn a worker isolate on `exit` (re-attach to the same worker index) or stop the core's
listener; cap the default at the free index count and refuse only explicit values.

## 19. `[SuppressGCTransition]` on functions whose failure path allocates

Severity: low.

Where: section 10.1 (lines 2161-2163), 6.1 O12 (lines 966-968).

Evidence: DESIGN 8.5 lists Microsoft's conditions (under a microsecond, no blocking syscall, no
callback, no throw, no locks). `zero_req_view`, `zero_req_method` and `zero_slot_route` record a
thread-local error message on every refusal (O12), which allocates (and may take the allocator's
lock), and a panic runs the hook and allocates. A stale id is the normal case for a refusal.

Fix: give the suppressed entry points a no-message variant (status only) or preallocate the
message buffer per thread.

## 20. Smaller correctness gaps in the sketches

Severity: low.

- `Outcome::Failed => { guard.retire(); ... }` (line 331): after a dispatcher panic the slot can
  still be `Leased`, and `retire` accepts only `Parsing`, `WorkerOwned`, `Completing` and `Closed`
  (table at line 492), so the slot stays leased; call `close_leased` first.
- Decision 10 says "every struct passed by pointer in either direction starts with `uint32_t
  size`", but `ZeroEvent` (an output array, lines 1079-1083), `ZeroHeaderPair` (an input array) and
  `ZeroField` do not, so they cannot grow at ABI 1 without breaking the array stride. Either add
  the prefix or pass the element size beside the array.
- `wsSend`, `resRespond` and `batchComplete` read JavaScript `Buffer` and `Float64Array` arguments
  through napi-rs slices; a `Buffer` over a `SharedArrayBuffer` can be written by another worker
  thread during the call, a data race under a Rust reference. Copy through the raw pointer or
  refuse shared backing stores.
- Section 8.5: a request field never read before the flush "reads as `undefined`". Post-response
  async work in 1.x apps (audit logging, rate counters keyed on `req.ip`) silently loses data;
  throwing a clear error, or snapshotting `reqHead` and the peer at construction, is safer.
- Cleanup hooks registered per `targetAttach` (section 8.3) should carry only ids and be removed on
  detach; one that captures the `Arc<TsfnTarget>` keeps the strong function alive after close.
- The outbox allows 64 MiB per connection (four times the 16 MiB mark, section 6.8) and is not
  counted in the per-core budget; many slow readers in one room can hold that much each.

## Checked and found sound

- `read_view` (section 4.3): a snapshot value stored for a later generation implies the second
  word load sees `g + 1` or later (release on the view store, acquire on the load, write-read
  coherence on the word); the proof holds without fences.
- Lock-then-check memory safety: every payload write for a later generation follows `retire(g)` in
  the worker's order, so a host that locks after it sees the new generation; the design cannot
  produce undefined behavior in zero-rt or zero-host (both stay `forbid`).
- `QueueFull` cannot occur in steady state with in flight at most 4 and `max_queue_size` 4: Node
  removes an item before `call_js_cb`, and the ack follows it (facts 2 and 7).
- loom 0.7.2 has `Mutex::try_lock` (fetched), so the `sync.rs` shim is implementable;
  `[target.'cfg(zero_loom)'.dev-dependencies]` works for `cargo test --lib`.
- Adding `check-cfg` to the workspace lint table does not affect the audited crates:
  `xtask lints` compares each manifest with the table `docs/capabilities.toml` names for it
  (`crates/xtask/src/lints.rs:156-179`), not with the workspace table.
- The workspace edition is 2021 (`Cargo.toml:53`), so plain `#[no_mangle]` with
  `#[allow(unsafe_code)]` is correct as written.
- `Span::of` returns an empty slice on an out-of-range span (`zero-http1/src/head.rs:95-97`), so a
  record whose head moved to the exchange cannot panic the driver, only read empty values.
