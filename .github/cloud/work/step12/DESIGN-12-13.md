# Steps 12 and 13: host dispatch, the C ABI and the Node binding

Synthesized design, 2026-10-02, revised the same day against `critique-12-13.md` (section 17
maps every finding to its resolution and records the remedies not adopted). Repository
`C:\Users\tonyw\Desktop\projects\zero-core` (paths below are relative to it unless they start with
`scratchpad/`). Nothing in either repository was edited; this file is the only output of the
synthesis.

Inputs read in full: `BRIEF.md`; zero-core `.github/cloud/RULES.md` and `.github/cloud/RULES.md`; DESIGN
sections 5, 7, 8, 10.1 and 10.2; ROADMAP R.3 rows 12 and 13; the six maps (`map-request-path.md`,
`map-runtime.md`, `map-abi-state.md`, `facts.md`, `map-legacy-tests.md`, `map-node-api.md`); the
three designs (`design-copy-out.md`, `design-lease-record.md`, `design-free.md`); both judges'
verdicts.

Base and grafts. The base is the copy-out design: both judges scored its safety highest (9 of 10
from each), and it is the only design in which a protocol bug cannot become undefined behavior,
because slot payloads sit behind safe locks, no host function pointer is ever called, and no unsafe
code exists outside two audited helpers. One judge ranked it first; the other ranked the split-cell
design first and grafted copy-out's safety parts onto it. Both graft lists converge on the same
target: a safe core with ack-based in-flight accounting, a one-shot respond, a cheap request view,
a checked body region, strict ack order, Node large-body staging with detach, Rust-side error
bodies, a conformance entry for every binding, plain per-request JavaScript objects, pins for C
views, and pull targets. Every graft from both lists is applied (section 2 maps each one), with
three refinements that close the performance defect both judges named without adding unsafe code:

1. Lock-then-check access: a host call takes the slot's lock and checks the generation inside it,
   instead of a counted CAS borrow plus a lock. Two atomic read-modify-writes per access, the same
   as the split-cell borrow, with no `UnsafeCell`.
2. A published request view: at export the worker stores the request's pointers and spans in
   atomics beside the state word; `zero_req_view` reads them between two acquire loads of the word
   and costs no read-modify-write. A view is handed only to a thread that pins the slot or is the
   slot's target thread inside the batch that delivered it, and the memory it points to stays
   frozen until reuse, which the epoch floor and the reader count gate.
3. The request head moves into the slot by a buffer swap, not a copy; the connection's record keeps
   its parsed head and field spans, so the driver's serialization is untouched.

Precondition. The step 11 work in progress in the tree (new sources in `crates/zero-qpack` and
`crates/zero-h3`, edits to `deny.toml`, `deny/*.toml`, `docs/standards.toml`, `Cargo.lock`,
`crates/xtask`) is committed before any package below starts: WP-5 regenerates
`conformance/vectors.json`, WP-0 edits `docs/standards.toml`, and WP-8 links `zero-qpack` and
`zero-h3` for the conformance entry. The `qpack` and `h3Frames` vector sections are step 11's.

## 0. Decisions

1. A tier 3 request is leased at dispatch, not at parse. The connection keeps its `Box<Record>`.
   `Call::export` swaps the head, body, trailer and route-path buffers into the slot's `Exchange`
   (moves of `Vec` headers, no byte copy), converts the live field table into a C-layout table,
   and copies the `Copy` metadata (parsed head, parameters, peer). The record keeps `parsed`,
   `fields` and every framing flag, so serialization, HEAD suppression, HTTP/1.0 keep-alive and
   100-continue need nothing back. `Call::import` swaps the response buffers back. File, WebSocket
   and SSE actions copy the head bytes back into the record before they run (once per upgrade or
   file response).
2. The slot payload is `std::sync::Mutex<Exchange>` beside the existing state word. Hosts use
   lock-then-check: lock, acquire-load the word, require the generation and an allowed state,
   access, unlock. The worker only ever uses `try_lock`, so it never waits on a host.
3. C hosts read requests through a published view of atomics (refinement 2 above), at zero
   read-modify-writes. The view rule is checked at entry (pin table or batch window) and
   documented for the time after return.
4. Only the worker changes a slot's state. Hosts change only the reader count, through pins.
   Completion is a seal inside the lock (`zero_res_respond`, `zero_res_send`, `zero_res_error` or
   an action call) plus the id appended to the worker's intake by `zero_batch_complete`: one intake
   lock and one cross-thread wake per call, no per-slot lock. A listed slot that was never sealed is
   sealed by the worker at import: sent as written, or answered 500 `NO_RESPONSE` when nothing was
   written.
5. Epoch reuse: acknowledgments are in order per worker (`epoch` must equal the oldest
   unacknowledged epoch, and only the target's bound thread may acknowledge); the ack floor is the
   newest acknowledged epoch; a retired index enters a FIFO quarantine stamped with the newest
   posted epoch and is released once the floor reaches the stamp. The dispatcher stores a batch's
   epoch as `published` before it posts the batch and rolls it back on `Full` or `Gone`, so a host
   that acknowledges before `post` returns is never refused. An idle target never holds reuse
   back, so no probe batches exist. Released indexes are cleared and shrunk at release; the free
   list is FIFO among at most `SLOTS_KEPT` (4,096) warm indexes, and indexes beyond that bound give
   their buffers back and are used only when no warm index is free.
6. In flight means posted and not acknowledged. At most `maxBatchesInFlight` batches per target
   (1 to 8, default 4, DESIGN 7.2), never above the ThreadsafeFunction's `max_queue_size` of 8, so
   `QueueFull` cannot occur in steady state. Async completions pass `ZERO_EPOCH_NONE` and hold no
   place. A `Full` answer with nothing in flight retries on a 1 ms core timer. Completions are
   applied whether or not the acknowledgment in the same call is accepted.
7. A new safe crate `zero-host` holds everything between zero-http and a host: the app spec,
   option documents, the process registry, `HostHandler`, the lease future, the dispatcher wiring,
   access and pins, pull targets, the connection table, the realtime glue, the error writer, the
   conformance entry and the Rust API. `zero-ffi` is a thin C shim over it. `bindings/node` calls
   `zero-host` directly. zero-rt, zero-http, zero-realtime and zero-host stay at
   `unsafe_code = "forbid"`.
8. C hosts pull batches with `zero_target_poll`. Rust never calls a host function pointer at
   release 1. `zero_res_body_transfer` moves to release 2, delivered with its release as an event,
   because its `release_fn` would otherwise run on an I/O worker (DESIGN 5.1).
9. One process registry: 128 worker indexes, each with permanent state (arena, connection table,
   intake, batch ring, target slot) in `static WORKERS: [OnceLock<Arc<WorkerShared>>; 128]`. A
   host finds a slot with two acquire loads and no lock. Generations continue across servers, so a
   stale id from a stopped server meets a newer generation, never freed memory. Several servers
   run in one process (legacy requirement H4).
10. C handles for servers, apps, targets, slots and connections are 53-bit generation-checked
    integer ids: a stale or unknown id returns `Closed`, never undefined behavior. Owned strings
    and buffers are opaque pointers released only by `zero_string_free` and `zero_buffer_free`
    (DESIGN 8.1's `zero_last_error_message`, which also resolves the six imports .NET already
    declares); they are total on NULL, and a freed pointer is a host error documented under
    ANSSI FFI-MEM-OWNER, not a status (section 6.1 O7). Every struct passed singly by pointer in
    either direction starts with `uint32_t size`; every array of structs travels with its element
    size beside the pointer, so either side can grow an element at a later ABI version.
11. `zero_res_respond(slot, spec)` writes status, field lines and body under one lock pair and
    seals.
12. `zero_res_body_alloc` (C hosts) requires the caller's pin, sets `staged` inside the exchange,
    and every other body writer and `zero_res_reset` refuse while it is set; `zero_res_send` seals
    and clears it; import waits for the pins to drop while it is set.
13. Node bodies at or above 64 KiB use one external `ArrayBuffer` per response over an
    `Arc`-shared zeroed `Region`, at most one open per slot, installed into the response only at
    send, after checking that the buffer passed in is the staged one (same data pointer and byte
    length), that it is not detached, and after detaching it (napi7). A transferred or foreign
    buffer answers 500. If either staging vector fails on a supported Node line, the threshold
    becomes infinite and every body is copied. The detach-after-send exit vector of R.3 row 13
    stays.
14. Node `req` and `res` are plain per-request objects without finalizer or native handle, marked
    finished at the completion flush. Only facade internals are pooled.
15. Host errors are written in Rust: `zero_res_error` writes the error registry body in the
    server's `ErrorShape` (`Legacy` for the Node facade, `Problem` for RFC 9457 by default), and the
    same shape covers core-generated 404, 405, 413 and 503 answers. The shape is a `Handler`
    method, not a `zero_http::Config` field, so no existing configuration literal changes.
16. WebSocket and SSE events (open, message, pong, close, drained, SSE closed) travel in event
    batches through the same dispatcher, not in slots. Every WebSocket upgrade request is leased to
    the host after Rust validated the handshake, so the facade can run `verifyClient` (awaiting a
    Promise) and capture the request its `(ws, req)` handler reads.
17. `zero_conformance_case(section, input)` is a stateless, total entry that runs the codec
    sections (`http1Parser` parse-only, `responseSplitting`, `router`, `ws`, `sse`, `qpack`,
    `h3Frames`) through the parsers the server uses, so all three bindings assert every section at
    release 1.
18. zero-host and zero-ffi carry one cargo feature per capability (`static`, `policy`, `realtime`,
    `tls`), default on. A function of a disabled capability returns `Unsupported`, so the header
    never varies with features and `cargo check -p zero-ffi --no-default-features` builds a
    meaningful core.
19. PATCH becomes method id 8 (RFC 5789) before `zero.h` is first committed.
20. Support floors, from fetched support windows: `engines.node` `>=22`, .NET `net10.0`, Python
    `>=3.11` with `abi3-py311`. The Node binding's lock moves to napi 3.14.0 in its own commit before
    any code relies on the 3.14.0 behavior read in `facts.md`.
21. Registry rows go in first (WP-0) with the exact test names; each package writes those tests.

## 1. Sources and verification

Fetched or re-read for this synthesis on 2026-10-02:

- RFC 9110 as text (https://www.rfc-editor.org/rfc/rfc9110.txt, saved as
  `scratchpad/step12/rfc9110.txt`). Section 15: "All valid status codes are within the range of
  100 to 599, inclusive." Section 15.2: "Since HTTP/1.0 did not define any 1xx status codes, a
  server MUST NOT send a 1xx response to an HTTP/1.0 client." Section 15.6.4: "The server MAY send
  a Retry-After header field (Section 10.2.3) to suggest an appropriate amount of time for the
  client to wait before retrying the request." Section 10.2.3: "When sent with a 503 (Service
  Unavailable) response, Retry-After indicates how long the service is expected to be unavailable
  to the client", `Retry-After = HTTP-date / delay-seconds`, `delay-seconds = 1*DIGIT`. Section 5.5:
  "Field values containing CR, LF, or NUL characters are invalid and dangerous". Section 5.3 on
  `Set-Cookie`: it "often appears in a response message across multiple field lines and does not
  use the list syntax". There is no "SHOULD include a Retry-After" sentence; the free design's
  quotation was wrong and is not used.
- Repository reads: `HeaderName::ALL.len()` is 49 (`crates/zero-http-types/src/header.rs:190`);
  `Method` holds ids 0 to 7 and asserts `Method::parse(b"PATCH") == None` (`method.rs:172`);
  `docs/standards.toml` has `current_release = 1`, highest keys `runtime-20`, `routing-28`,
  `realtime-33`, `errors-10`; exactly two release 1 rows cite a missing file
  (`runtime-01`, `runtime-07`, both `bindings/node/test/lifecycle.test.js` with `fn ...` anchors);
  `cargo xtask standards --check` is `continue-on-error` in ci.yml and blocking in
  release-preflight, and `locate` matches the `at` text as a substring of exactly one line of any
  file type (`crates/xtask/src/standards.rs`); zero-io binds the first listener, reads its port and
  binds every other per-core listener to that address (`crates/zero-io/src/tokio_rt/worker.rs`,
  `serve`), so `port: 0` yields one shared ephemeral port; `zero_server_crypto::SecretBytes` is
  `Secret<Box<[u8]>>` over `Zeroizing` (`crates/zero-server-crypto/src/lib.rs:102-105`);
  `zero_tls::Identity::from_pem(chain: &[u8], key: &[u8], names: &[&str])`
  (`crates/zero-tls/src/identity.rs:63`); `zero_http::Config` has `runtime`, `limits`, `server`;
  the sanitizer job's race step is `-p zero-rt -- --include-ignored slot_recycle` (ci.yml:444);
  root `Cargo.toml` lists members explicitly and has no `unused_crate_dependencies` lint.

Fetched or read for the revision against the critique, 2026-10-02:

- napi-rs 3.14.0 `crates/napi/src/threadsafe_function.rs` at tag `napi-v3.14.0`
  (raw.githubusercontent.com): in `call_js_cb_raw` the arm
  `Err(error_value) if !callee_handled => (unsafe { sys::napi_fatal_exception(raw_env, error_value) }, None)`
  handles an `Err` returned by the closure given to `build_callback`; `handle_call_js_cb_status`
  passes a pending exception to `napi_fatal_exception` as well; `call_js_cb` returns at once when
  `raw_env` or the callback is null. So the callback closure must never return `Err` (section 8.4).
- docs.rs napi 3.14.0 `ArrayBuffer`: `impl Deref<Target = [u8]>` (so `as_ptr()` and `len()` are
  safe), `pub fn detach(self) -> Result<()>`, `pub fn is_detached(&self) -> Result<bool>`, `Clone`
  and `Copy`; `from_external` as in facts 4 (section 8.7).
- Inherited from the critique's fetches of the same day: Node v22.23.3 Node-API
  `napi_fatal_exception` ("Trigger an 'uncaughtException' in JavaScript"); Node v22.23.3 CLI
  `UV_THREADPOOL_SIZE` ("The default size of the threadpool is 4 threads", used by `dns.lookup()`,
  some `fs` calls, `crypto` and `zlib`); loom 0.7.2 `Mutex::try_lock` exists.
- Repository reads: `Worker::spawn` runs the task through `spawn_local`
  (`crates/zero-rt/src/worker.rs:109-120`), which counts it in `Tasks.live`, and the worker waits
  `timeout(config.drain, tasks.drained())` for `live == 0` (`crates/zero-io/src/tokio_rt/worker.rs:
  83-94, 130-143, 426`); the ring entry's body charge is released after the write
  (`crates/zero-http/src/conn.rs:657-663`) and the record pool keeps at most `RECORDS_KEPT` =
  4,096 records (`conn.rs:46, 113-119`); `zero_http::Config` literals without a default spread at
  `crates/zero-http/tests/driver.rs:199, 820, 1025`, `crates/zero-realtime/tests/realtime.rs:142`
  and `crates/zero-tls/tests/driver.rs:77`; `crates/zero-serve/src/lib.rs:678-691` matches
  `zero_rt::worker::Event` with no wildcard arm; `max_batches_in_flight` is validated in
  `crates/zero-limits/src/lib.rs:139-141`; `crates/xtask/src/packages.rs:225-353` writes the
  `package.json`, `tsconfig.json` and `README.md` of `packages/core` and `packages/sdk`, the native
  README and `bindings/node/tsconfig.json`, with dependencies derived from each package's imports
  and `engines` hard-coded at line 443; `zero_static::Files::new(root, options)` canonicalizes a
  root that must exist and owns an 8 MiB small-file cache by default (`files.rs:57-76, 193-207`);
  `Files::serve_path` writes its status and fields on top of the response already in the record,
  answers 405 with `Allow: GET, HEAD` for other methods, and a bare 404 with no body when the path
  is refused or missing (`files.rs:378-394`); zero-sse's encoder refuses CR and LF in `event` and
  `id` (`crates/zero-sse/src/lib.rs` tests at lines 147-159), and `last_event_id` (line 54) is the
  request header parser. In zero-server-node: `res.sendFile` resolves a path without `root` against
  the working directory with no containment check, refuses a path outside `root` with status 403,
  a NUL with 400 and a missing file with 404, calls the callback with that error or with `null` at
  the end of the stream, and `download` sets `Content-Disposition` then calls `sendFile`
  (`lib/http/response.js:301-383`); `test/http/response.test.js:143-198` and `:517-557` assert
  those statuses, the callback form and the disposition field.

Facts inherited, with their fetch dates (cited below as "facts N" for `facts.md` section N, or by
design):

- facts.md (2026-10-01): registry versions (napi 3.14.0, napi-derive 3.6.10, napi-build 2.6.0,
  napi-sys 3.4.0, loom 0.7.2, cbindgen 0.29.4), napi ThreadsafeFunction builder, statuses, the
  payload leak on non-`napi_ok`, teardown behavior, `Drop` release; instance data and cleanup
  hooks; `BufferSlice::copy_from` copies while `ArrayBuffer::copy_from` and the typed-array
  `copy_from` do not; `ArrayBuffer::from_external`, `detach` and `is_detached` (napi7); Node
  support windows (22, 24, 26 supported; 20 ended 2026-04-30); Node-API v22.23.3 texts including
  `napi_detach_arraybuffer` ("V8 requires that the ArrayBuffer be external"); worker_threads
  signals; loom 0.7.2 API and limits; cbindgen emits `extern "C-unwind"` like `extern "C"`;
  Rust 1.81 abort on a panic at a non-unwinding boundary; ANSSI FFI rule texts; TSan does not
  model `fence`.
- design-copy-out.md (2026-10-01 and 02): Rust 1.89 `Vec::as_ptr`/`as_mut_ptr` aliasing text,
  `Mutex` (`Sync` when `T: Send`, `clear_poison` since 1.77.0), `OnceLock` (`get` never blocks),
  `Option<extern "C" fn>` null-pointer optimization, RFC 6455 Section 4.2.2 subprotocol text,
  RFC 5789 Section 2, cbindgen 0.29.4 `typedefs` and the `function_ptr` expectation, loom 0.7.2
  `Mutex` API (no poison API), .NET support policy (page updated 2026-09-08: .NET 10 LTS end of
  support 2028-11-14; .NET 8 and 9 end 2026-11-10), IANA WebSocket close code registry.
- design-free.md (2026-10-01 and 02): RFC 6455 Sections 5.5, 5.5.1, 7.4.1, 7.4.2; WHATWG HTML
  server-sent events 9.2.4 to 9.2.6; Python devguide (3.10 end of life 2026-10-01, 3.11 supported
  to 2027-10); tokio 1.53.1 manifest declaring `[target.'cfg(loom)'.dev-dependencies]`; napi
  3.14.0 `Float64Array` (`as_mut` documented as "literally undefined behavior").
- design-lease-record.md (2026-10-01 and 02): Python 3.13 ctypes ("The Python global interpreter
  lock is released before calling any function exported by these libraries, and reacquired
  afterwards" for `CDLL`); Node v22.23.3 worker_threads (`filename` must be absolute, relative with
  `./`, or a `file:` or `data:` URL; `workerData` is structured-cloned); napi-rs shows no
  `catch_unwind` option for `#[napi]`.

## 2. Judge defects and grafts, and where each is resolved

| Item (source) | Resolution | Section |
| --- | --- | --- |
| Copy-out: a batch stays in flight until its last job retires, so 4 async handlers stall an isolate (both judges) | In flight ends at the acknowledgment, which the facade sends when the synchronous iteration ends; async completions carry `ZERO_EPOCH_NONE` | 5.1, 8.8 |
| Copy-out: about 6 RMWs per accessor (registry `RwLock`, borrow CAS, lock pair, release), no one-shot calls, and a worker memcpy of the head (both judges) | Registry is lock-free `OnceLock`s; lock-then-check costs 2 RMWs; `zero_req_view` costs 0; `zero_res_respond` one lock pair; the head moves by swap | 3.4, 4.2, 4.3, 9 |
| Copy-out O6: the `body_alloc` region valid only "until the next body-setting call" (both) | `staged` flag inside the exchange; pin required; every other body writer and reset refuse; import waits for pins while staged | 6.7 |
| Copy-out: `Full` with nothing in flight never resumes (judge 1) | 1 ms core timer retry | 5.4 |
| Copy-out: DESIGN 8.1 names dropped (owned strings, `*_free`, `body_retain`, `claim`), six .NET imports deleted, start split (both) | `zero_last_error_message`, string and buffer handles, `zero_req_body_retain`, `zero_req_claim` (returns `Unsupported` until JWT), `zero_server_new` plus `zero_server_start`; the six imports resolve | 6.5, 6.17 |
| Copy-out: Node bypasses zero-ffi; `thread_local!` replaces instance data (judge 1) | Kept with reasons: one implementation in zero-host serves both; C exports are covered by the header table test, .NET, Python ctypes and the C-path TSan test; `get_instance_data` hands out aliasing `&'static mut` | 8.1, 8.3 |
| Copy-out: qpack and h3Frames not asserted by bindings (both) | `zero_conformance_case` in every binding | 6.11, 11 |
| Copy-out: staging pool, detach-after-send and pooled views dropped (judge 1) | Staging restored per response with detach; vector restored; pooled user-visible views replaced by plain objects (a pool cannot detect escape) | 8.5, 8.7 |
| Copy-out: net8.0, `RwLock` const and napi version contradictions (both) | `net10.0`; no `RwLock` remains; napi 3.14.0 bump commit first | 0, 8.2, 10.1 |
| Copy-out: `lints.rs` flatten drops `check-cfg` (judge 1) | `xtask lints` keeps and diffs `check-cfg` | WP-1 |
| Free: pooled views reach the next request through a retained object (both) | Plain per-request objects | 8.5 |
| Free: swapping `RequestParts` out loses `parsed`, `peer`, `secure` for serialization (judge 1) | The record keeps `parsed` and its field spans; only byte buffers move | 3.4 |
| Free: `UnsafeCell` cells with `unsafe impl Sync` (judge 1) | Not adopted: `Mutex` plus atomics, no unsafe in zero-rt or zero-host | 4.2 |
| Free: no one-shot respond; C views protected by contract only (both) | `zero_res_respond`; view rule checked at entry with the pin table and the batch window | 6.5, 4.3 |
| Free: completed but undetached `Body::External` read by the worker (judge 2) | The external body is installed only by the staged send, after detach | 8.7 |
| Free: `ZeroTarget` returns `Busy` to a second thread, so .NET pool-thread completions retry (judge 2) | Any thread completes slots; only acknowledgments are bound to the target's thread; no `Busy` status | 4.6, 6.10 |
| Free: Retry-After quoted as SHOULD; 49 versus 56 headers; 1xx quotation (judge 2) | Verbatim MAY re-fetched; 49 read in source; verbatim 15.2 sentence | 1 |
| Free: engines `>=22.0.0` versus `>=22.14.0` (judge 1) | `>=22`; nothing needs Node-API 10 | 8.13 |
| Free: Python smoke over the PyO3 rlib (both) | ctypes over `libzero_ffi` plus the PyO3 import | 10.2 |
| Free: tier 0 option parity added scope (judge 1) | Separate optional WP-7 with a defined fallback | 14 |
| Lease-record: holder fast path without a counted borrow (both) | Not adopted; memory is never freed at completion and the view rule is checked | 4.3 |
| Lease-record: host code on workers (push `CTarget`, `ZeroEventFn`, `release_fn`) (both) | Not adopted: pull targets only; status reported by `zero_server_stats` and the Node status callback, not a C callback | 6.10 |
| Lease-record: `TypedArray::as_mut`, raw string write into spare capacity (both) | Not adopted; Node keeps one audited block (staging) | 8.15 |
| Lease-record: error bodies built in JavaScript (judge 1) | Written in Rust | 8.9 |
| Lease-record: loom modeled a tag stand-in (judge 1) | The real `Slot<T>`, `SlotWord`, `Intake` and allocator under loom | 7.1 |
| Graft: in-flight until ack; strict ack order; FIFO free list | Applied; FIFO among at most 4,096 warm indexes, with the rest giving their buffers back (section 17, finding 7) | 4.2, 4.5, 5.1 |
| Graft: one-shot respond and an all-spans view | Applied, the view at zero RMWs | 4.3, 6.5 |
| Graft: STAGED region flag; 1 ms retry; worker-thread flag; size prefix; layout test | Applied | 6.7, 5.4, 6.10, 6.4, 6.15 |
| Graft: features per capability with `Unsupported` stubs | Applied | 6.13 |
| Graft: RMW budget table as the harness grid; tier 3 counting-allocator assertion | Applied | 9, 5.8 |
| Graft: staging with detach and the transfer vector; `ErrorShape`; conformance entry; reads in `Completing`; header strict mode; RFC 6455 and SSE rows; TLS keys in `Zeroizing` | Applied | 8.7, 3.7, 6.11, 4.3, 6.15, 12, 6.9 |
| Graft: pin table; zero-host crate; loom over real code; ctypes smoke; GIL text; GC test; ESM entry | Applied | 4.3, 0, 7.1, 10 |
| Graft: split-cell layout kept as the fallback if the lock pair is over budget | Recorded with its decision rule; it saves no RMW (section 9), so it is a fallback only for a measured lock cost | 9.3 |
| Graft (optional): write the Node string body with `napi_get_value_string_utf8` into the response | Not at release 1; measured by a harness cell and recorded as an option needing one more audited block | 8.6 |

## 3. (a) Where tier 3 hooks into zero-http, and how a request is leased and completed

### 3.1 Ownership

| Memory | Owner | Read by | Written by | Freed or reused when |
| --- | --- | --- | --- | --- |
| `Box<Record>` (parsed head, field spans, framing flags, response head) | the connection: free list, ring entry, handler future | worker only | worker only | as today (`give_record`, or dropped with the future) |
| Exchange request side (head, field table, body, trailers, route path, parameters, peer) | the worker index's permanent arena | hosts while `Leased` or `Completing`, under the lock or through the published view | worker at export only | cleared and shrunk when the quarantine releases the index (readers 0 at retirement, the epoch floor past the stamp), or at the next `allocate` if the lock was busy then; counted in the core's memory budget from export until that release (section 4.5) |
| Exchange response side (status, field lines, body, action, flags) | same arena slot | worker at import | hosts while `Leased`, under the lock; a C host inside a pinned `body_alloc` region | swapped into the record at import; what a canceled lease left behind is cleared and shrunk at release, as above |
| Published view (atomics beside the word) | same arena slot | hosts (acquire loads) | worker at export (release stores) | rewritten at the next export after reuse |
| Batch ring entries (ids, route ids, event records) | the worker index (`Arc`, one `Mutex` per entry) | targets copy them out once per batch | worker, only for an entry not in flight | at the acknowledgment of that entry's epoch |
| Intake (completed ids, acknowledgments, waker) | the worker index | worker | hosts under the intake lock | swapped out by the worker each turn |
| Pull target delivery storage (event payloads) | the target | its bound host thread through `ZeroEvent` views | `zero_target_poll` | at the next poll on that target or at detach |
| Connection outbox | the connection table entry (`Arc<Outbox>`) | the connection task | hosts push pre-encoded frames | when the connection task ends; queued octets count in the core's memory budget (section 6.8) |
| Node staging `Region` | `Arc` shared by the response body and the `ArrayBuffer` finalizer | worker after send | JavaScript before send (detached at send) | when both owners released it |
| Host values (JavaScript strings, Buffers, .NET spans) | the host | host | host | the host's own rules |

### 3.2 The hook

The hook is a per-core `zero_host::handler::HostHandler` implementing `zero_http::Handler`, built
on each worker thread by the `make` closure that `zero_host` passes to `zero_http::serve` or
`serve_with` (`crates/zero-http/src/server.rs:145-242`). The connection driver's control flow does
not change: it already polls a pending handler future inline, keeps serving the connection's
other work, writes responses in request order, and treats the future's completion as "the record
holds the response" (map-request-path section 12).

```rust
struct CoreHost {
    worker: Worker,                            // zero-rt, Rc inside
    index: u8,                                 // global worker index
    shared: Arc<WorkerShared>,                 // permanent per index: arena, conns, intake, ring, target
    app: Arc<App>,                             // router, rules, ws routes, miss route, options, error shape
    alloc: RefCell<Allocator>,                 // warm and cold lists and the quarantine (zero-rt)
    dispatch: RefCell<Dispatcher<ReadHold>>,   // ready queue, events, in-flight epochs (zero-rt)
    waiters: RefCell<Waiters>,                 // per index: generation, stage, Option<Waker>
    kick: Rc<Kick>,                            // same-thread wake for the dispatcher task
    scratch: RefCell<Vec<u8>>,                 // route resolution for body_limit
    file_roots: RefCell<FileRoots>,            // at most FILE_ROOTS_KEPT Files for zero_res_file, least recently used dropped
}
```

`make` also spawns the per-core dispatcher task with `Worker::spawn` (allowed for driver tasks,
DESIGN 5.6) and sets the zero-rt worker-thread flag (section 6.10). Every task zero-host spawns
counts in zero-io's `Tasks.live`, which the worker's drain waits on, so each has an exit rule: the
dispatcher's is in section 5.2 step 6, and the realtime connection tasks end on the shutdown
signal (section 6.8).

### 3.3 `HostHandler`

```rust
async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
    let core = &self.core;
    if core.draining() { return overload::answer(call, &core.app, Overload::Draining); }
    if rules::before(&core.app, call)? == Answered::Yes { return Ok(()); }   // preflight, request id
    let Some(routed) = call.route_or_miss(&core.app.router, core.app.miss) else {
        rules::after(&core.app, call);                     // CORS, security headers on misses
        return Ok(());
    };
    match routed.descriptor.kind {
        RouteKind::Fixed | RouteKind::Redirect | RouteKind::Static | RouteKind::Health => {
            tier0::serve(&core.app, call, routed)?;        // a static miss with fallthrough re-routes
        }
        RouteKind::WebSocket => {
            if realtime::refuse_handshake(call, &routed)? == Answered::Yes { return Ok(()); }   // 400, 403, 426
            return lease::dispatch(core, call, routed).await;   // applies the after-rules itself
        }
        RouteKind::Host | RouteKind::Miss => return lease::dispatch(core, call, routed).await,
    }
    rules::after(&core.app, call);                         // tier 0 paths, as today
    Ok(())
}

fn body_limit(&self, method: Option<Method>, path: &[u8]) -> Option<u64> {
    // Resolves the raw path again with the per-core scratch (allocation-free when warm,
    // zero-router `resolve_target`); answers the route's `maxBody`, else a BodyLimit rule.
}

fn taken<S: Stream + 'static>(&self, taken: Taken<S>) -> impl Future<Output = ()> {
    realtime::serve(Rc::clone(&self.core), taken)          // section 6.8
}
```

`lease::dispatch`, the whole tier 3 path:

```rust
async fn dispatch(core: &Rc<CoreHost>, call: &mut Call<'_>, routed: Routed<RouteDesc>) -> Result<(), Error> {
    let shared = &core.shared;
    if core.dispatch.borrow().admit(shared) == Admission::Refuse {
        return overload::answer(call, &core.app, Overload::Queue);           // section 5.3
    }
    // `allocate` claims an index whose lock it could take, resets the payload under that lock and
    // returns the guard, which is held through export and `hold`: no host call can take the lock
    // between the reset and the export, so export never meets `Busy`.
    let Ok((id, mut payload, freed)) = core.alloc.borrow_mut().allocate(&shared.arena) else {
        return overload::answer(call, &core.app, Overload::Arena);
    };
    shared.retained.fetch_sub(freed, Ordering::Relaxed);                      // section 3.4
    let guard = LeaseGuard::new(Rc::clone(core), id);                         // from here every exit retires (4.7)
    let (route, head) = (routed.descriptor.route, routed.head);
    call.export(&mut payload.0, guard.slot().view(), route, head, &core.app.export);   // HostExchange(Exchange)
    guard.slot().word().hold(id.generation())?;                               // Parsing -> WorkerOwned, under the lock
    drop(payload);
    let hold = core.dispatch.borrow().backlogged().then(|| call.hold_reads());
    core.dispatch.borrow_mut().push(Job { slot: id, route }, hold);
    core.kick.wake();
    match guard.wait().await {                                                // woken by the dispatcher task
        Outcome::Sealed => {
            // 4.6 step 4: begin_import, then wait for the lock (and, when staged, for readers 0)
            // on the late list; the after-rules (CORS on the response, security headers, request
            // id) read the request from the exchange, since the head left the record at export.
            let action = guard.import(call, |request, response| rules::after_with(&core.app, request, response)).await?;
            guard.retire();                                                   // late list while pinned
            actions::apply(core, call, action)
        }
        Outcome::TargetGone => { guard.retire(); overload::answer(call, &core.app, Overload::TargetGone) }
        Outcome::Failed => { guard.close(); guard.retire(); Err(Error::Closed) }   // close_leased first if still Leased
    }
}
```

`LeaseGuard::import` is a future: it runs `begin_import(g)` and then `try_lock`; a busy lock, or a
nonzero reader count while `staged`, parks it on the late list until the dispatcher's re-poll
succeeds (section 4.6 step 4). A busy lock never fails the request. `LeaseGuard::close` applies
`close_leased(g)` when the slot is still `Leased` and `close(g)` when it is `Parsing` or
`WorkerOwned`, because `retire` refuses `Leased`.

### 3.4 What moves at export and import

`zero_http::exchange::Exchange` is the slot payload: a public type with crate-private fields,
defined in zero-http so it reuses `Request`, `Response` and their validators (`call.rs:333-666`).

| Exchange field | Filled at export from | How | Host access |
| --- | --- | --- | --- |
| `head: Vec<u8>` | `record.head` | `mem::swap` (the record receives the exchange's cleared buffer) | view pointer, spans |
| `fields: Vec<HostField>` | `record.fields[..field_count]` | converted: `HostField { name: HostSpan, value: HostSpan, id: u32 }`, `#[repr(C)]`, id `u32::MAX` when not interned | view pointer; lookups under the lock |
| `parsed: Option<Head>` | `record.parsed` | `Copy`; the record keeps its own | method id, version, flags |
| `body: Vec<u8>` | `record.body` | `mem::swap`; the ring entry's body charge (`body_bytes`) moves to the worker's `retained` counter, which `HostHandler::leased_bytes` reports until the quarantine release shrinks the exchange | view pointer |
| `trailers: Vec<u8>`, `trailer_fields: Vec<HostField>` | `record.trailers` | swap, then parsed with zero-http1's trailer parser into the table, keeping only names on the server's trailer allow list (DESIGN 6.2) | under the lock |
| `route_path: Vec<u8>`, `params: Vec<HostSpan>` | `record.route_path`, `record.params` | swap; parameters copied | view pointer; parameters under the lock |
| `peer`, `secure`, `client` | `record.peer`, `record.secure`; `client` from the trust-proxy rule when configured | `Copy` | `zero_req_peer` |
| `route`, `miss` | route descriptor; for the miss route, the would-be status and `Allow` mask | set | view |
| response: `status`, `fields: Vec<u8>`, `body: ResponseBody`, `action`, `sealed`, `staged`, `touched` | reset at allocate | hosts write under the lock | worker at import |

The record keeps `fields` (spans into a head it no longer holds), `parsed` and every framing
flag. Nothing in the driver reads `record.head` or `record.fields` after the handler starts except
`Taken::request()` for a claimed connection and the actions of section 3.5, so `import` copies the
head bytes back (`record.head.extend_from_slice(&x.head)`) only for those actions, which makes the
record's spans valid again. The policy rules that run after a handler (CORS fields on the response,
security headers, the request id) run inside the import against the exchange's request, which is
still frozen there. Export costs a handful of header swaps, one pass over the live fields and the
published-view stores; there is no head memcpy on the common path.

`Request<'a>` becomes a view over borrowed parts (the head, the parsed head, a field table that is
either the parser's `Field`s or the exchange's `HostField`s, the body, the trailers, the route path
and parameters, the peer), so the same accessors and the same policy code serve the record and the
exchange.

The request side is written only at export and is frozen until the next `allocate` of the index.
No accessor memoizes into it and no host call forms a mutable reference to it. Host calls write
only the response side. That is what keeps a published view valid while another thread writes the
response, and it keeps every lazy decode (query parsing, header lowercasing, string conversion)
on the host side.

`Exchange::reset` clears the request side, shrinks `body` and `trailers` above `BODY_KEEP`
(65,536 octets) as `Record::reset` does, and clears the response side, shrinking its body above
`BODY_KEEP` too (a canceled lease can leave up to `maxResponseBody` there). `Exchange::release`
does the same and then, for an index beyond the warm bound of section 4.2, shrinks every buffer
to zero. The allocator calls one of them when the quarantine releases the index (section 4.5)
and `allocate` calls `reset` only on an index whose release found the lock busy. Export moves the
ring entry's body charge to the worker's `retained` counter (an `AtomicU64` in `WorkerShared`; the
entry's `body_bytes` is set to 0 in the same step, so nothing is counted twice). Host body writes
add their octets to the same counter (section 6.7), and each exchange records in `counted` what it
added. Import subtracts the response octets that move into the record; the release subtracts
what is left in `counted` and zeroes it. That closes the gap between the write (where the entry's
charge used to end) and the reuse of the index, and covers a canceled lease's response. On warm buffers, export and import allocate nothing; a
counting-allocator test covers both (WP-3).

### 3.5 Post-completion actions

The host records at most one action; the tier 3 future runs it on the worker after import,
because each needs `&mut Call` (map-request-path section 12):

| Action | Set by | Runs | On failure |
| --- | --- | --- | --- |
| `File { root, path }` | `zero_res_file` | head copied back, then `zero_static::Files::serve_path(call, path)` with a `Files` for that root from `CoreHost::file_roots`: at most `FILE_ROOTS_KEPT` (16, a judgment) per core, each built with a 512 KiB `cache_budget` (8 MiB per core in all, one static mount's default), the least recently used dropped with its cache. The status and field lines the host set before the action stay in the response and zero-static appends its own (`files.rs:378-423`), so `Content-Disposition` from `download` reaches the client. zero-static serves GET and HEAD only (405 otherwise) | zero-static sets 404 with no body; `actions::apply` then writes the server's `ErrorShape` body for a 4xx zero-static left empty (`{"error":"Not Found"}` in `Legacy`, the 1.x body). A root that does not exist is 404 |
| `Sse { conn, keep_alive_ms }` | `zero_res_sse_open` | head copied back, then `zero_realtime::sse::start(call, conn)`; `taken()` serves the stream with the connection's outbox | the outbox closes, later sends return `Closed`, an `SSE_CLOSED` event follows |
| `Ws { conn, protocol }` | `zero_res_ws_accept` | head copied back, then `zero_realtime::websocket::accept(call, &config, conn)` with the route's protocols and origins and the chosen protocol | as above, a `WS_CLOSE` event with code 1006 |

The claim token passed to `accept` and `start` is the connection id the host already holds, so
`taken()` finds the outbox by token.

### 3.6 Errors and overload answers

`overload::answer` writes, on the worker, with no crossing: status 503; `Retry-After:
<retryAfterSecs>` (default 1, `delay-seconds` form, RFC 9110 Section 10.2.3; the field is a MAY in
Section 15.6.4, and the row pins that this server sends it); the server's `ErrorShape` body (code
`SERVICE_UNAVAILABLE` in the problem shape); the connection left as negotiated. While draining, the
answer carries `Retry-After: <drainRetryAfterSecs>` (default 5, the 1.x drain value), the message
"Server is shutting down", and `Connection: close`. A closed lease (target gone) answers the same 503. Host errors
arrive as one `zero_res_error` call (section 6.7).

### 3.7 zero-http changes (WP-3)

```rust
pub mod exchange;   // Exchange, HostField, HostSpan, PublishedView, ViewSnapshot, Action, ResponseBody, ExportOptions
pub use exchange::{Action, Exchange, ExportOptions, HostField, HostSpan, PublishedView, ResponseBody, ViewSnapshot};
pub use call::ReadHold;
pub use error::ErrorShape;

pub enum ResponseBody { Owned(Vec<u8>), External(Arc<dyn ExternalBody>) }   // the record's response_body becomes this
pub trait ExternalBody: Send + Sync + 'static { fn bytes(&self) -> &[u8]; }

pub enum ErrorShape { Problem, Legacy }   // chosen by Handler::error_shape; Problem (RFC 9457) is the default

impl zero_rt::Reset for Exchange { fn reset(&mut self); }   // the existing zero-rt trait record.rs already implements

impl Exchange {
    pub fn release(&mut self, cold: bool);                     // reset, then shrink every buffer to zero when cold
    pub fn counted(&self) -> u64;                              // octets this exchange added to the worker's retained counter
    pub fn request(&self) -> Request<'_>;                      // the view type handlers use
    pub fn response(&mut self) -> Response<'_>;                // the same validators (call.rs:550-591)
    pub fn route(&self) -> u32;
    pub fn seal(&mut self);
    pub fn sealed(&self) -> bool;
    pub fn touched(&self) -> bool;                             // any status, field, body or action written
    pub fn staged(&self) -> bool;
    pub fn stage(&mut self, len: usize) -> Result<*mut u8, Error>;   // zero-filled Owned body; raw pointer creation is safe
    pub fn set_action(&mut self, action: Action) -> Result<(), Error>;   // one action only, seals
    pub fn take_action(&mut self) -> Action;
    pub fn set_external(&mut self, body: Arc<dyn ExternalBody>) -> Result<(), Error>;   // Node staged send only
    pub fn write_error(&mut self, shape: ErrorShape, status: StatusCode, code: &str, message: Option<&str>, details_json: Option<&[u8]>);
    pub fn leased_bytes(&self) -> u64;
}

impl PublishedView {
    /// Acquire loads of every published value, as plain integers and raw pointers.
    pub fn snapshot(&self) -> ViewSnapshot;
}

impl Call<'_> {
    /// Moves what a host may read into `into` (buffer swaps) and publishes the view (release stores).
    pub fn export(&mut self, into: &mut Exchange, view: &PublishedView, route: u32, head: bool, options: &ExportOptions);
    /// Moves the host's response back; the driver serializes it. `after` writes the policy fields
    /// against the exchange's request; the head is copied back when the action needs it.
    pub fn import(&mut self, from: &mut Exchange, after: impl FnOnce(Request<'_>, &mut Response<'_>));
    /// `route`, except that a miss resolves to `miss` when one is given, carrying its status and Allow mask.
    pub fn route_or_miss<T: Copy>(&mut self, router: &Router<T>, miss: Option<T>) -> Option<Routed<T>>;
    /// Stops reading this connection until the hold drops.
    pub fn hold_reads(&self) -> ReadHold;
}

pub trait Handler: 'static {
    /// Octets this handler holds outside the records (exchanges, outboxes), counted by the request-memory budget.
    fn leased_bytes(&self) -> u64 { 0 }
    /// The body shape of core answers (404, 405, 413, 503) and `Record::problem`.
    fn error_shape(&self) -> ErrorShape { ErrorShape::Problem }
    // handle, body_limit, taken unchanged
}
```

`impl zero_rt::Payload for Exchange` cannot live in zero-http without WP-2's new trait, and the
orphan rule forbids it in zero-host, so zero-host wraps it: `pub struct HostExchange(zero_http::Exchange)`
with `impl zero_rt::Payload for HostExchange { type View = zero_http::PublishedView; }` and a
forwarding `Reset`. zero-http (WP-3) therefore depends only on zero-rt's existing `Reset`, and
WP-2 and WP-3 build in parallel; zero-host (WP-8) is the first crate that needs both.

- `ReadHold` is `!Send`: an `Rc<HoldCell { count: Cell<u32>, waker: RefCell<Option<Waker>> }>` owned
  by the `Conn`. `Conn::wait` adds `&& hold.count.get() == 0` to `want_read` (`conn.rs:486-490`) and
  registers its waker while the count is nonzero; the last drop wakes it.
- `Shared::over_budget` (`conn.rs:123-130`) adds `handler.leased_bytes()`, closing the gap
  map-request-path section 11 notes against `REQUEST_MEMORY_PER_CORE`.
- `fill_slices` writes `ResponseBody::External` as one iovec; `wrote` drops the `Arc` after the
  write. `response_len` reads its length. `Response::body` and `body_mut` work on `Owned` and turn an
  `External` back into an empty `Owned`.
- `Handler::error_shape` (default `Problem`) replaces a configuration field: `zero_http::Config`
  is built with struct literals that list every field and no default spread in five test files
  (`crates/zero-http/tests/driver.rs:199, 820, 1025`, `crates/zero-realtime/tests/realtime.rs:142`,
  `crates/zero-tls/tests/driver.rs:77`), and a trait method with a default leaves them compiling.
  `HostHandler` answers the server's configured shape. `Record::problem` and every core answer
  (404, 405, 413, 503) write the handler's shape. `Problem` writes today's RFC 9457 body with `code` in the `code`
  member. `Legacy` reproduces the 1.x bodies with `Content-Type: application/json`: a core answer is
  `{"error":<reason phrase>}` (the 1.x router's miss body), the drain answer is
  `{"error":"Service Unavailable","message":"Server is shutting down"}` (the 1.x drain body), and a
  host error written by `write_error` is the 1.x `toJSON` shape `{"error":<message>,"code":<code>,
  "statusCode":<status>}` plus `"details"` when given.
- `crates/zero-http/tests/no_alloc.rs` passes unchanged: tiers 0 and 4 never touch a slot.

## 4. (b) The slot ownership protocol

### 4.1 The state word

The layout stays (`crates/zero-rt/src/slot.rs:11-25`): state in bits 0 to 2, readers in bits 3 to
18, cancel in bit 19, generation in bits 20 to 49; bits 50 to 63 stay zero (reserved). The reader
count now counts pins only (section 4.3). Every transition is one generation-checked CAS loop with
`AcqRel` on success and `Acquire` on failure; the free-form `transition` becomes private and the
unconditional `close` is replaced (map-runtime defects 1 and 3).

| Method | Caller | From | To | Checks |
| --- | --- | --- | --- | --- |
| `claim(g)` (inside `Allocator::allocate`) | worker | `Free` at `g` | `Parsing` | generation, readers 0 |
| `hold(g)` | worker after export | `Parsing` | `WorkerOwned` | generation |
| `lease(g)` | dispatcher, as it writes the job into a batch | `WorkerOwned` | `Leased` | generation, cancel clear |
| `unlease(g)` | dispatcher when the post returned `Full` | `Leased` | `WorkerOwned` | generation (no host has seen the id) |
| `begin_import(g)` | tier 3 future after the seal was reported | `Leased` | `Completing` | generation |
| `close_leased(g)` | lease guard drop, target loss | `Leased` | `Closed`, cancel set | generation |
| `close(g)` | lease guard drop of a queued job | `Parsing` or `WorkerOwned` | `Closed`, cancel set | generation; refuses `Free` |
| `retire(g)` | worker | `Parsing`, `WorkerOwned`, `Completing`, `Closed` | `Free` at `g + 1`, cancel clear | generation, readers 0 |
| `pin(g)` | any thread | `Leased` or `Completing` | readers + 1 | generation, readers below 65,535 |
| `unpin(g)` | the pinning thread | any but `Free` | readers - 1 | generation, readers above 0 |
| `state`, `generation`, `readers`, `is_canceled` (renamed from `is_cancelled`, American spelling) | any | | | `Acquire` loads |

Only the worker changes the state bits (invariant I1). A host never moves a slot; it locks the
payload, reads the published view, or pins. `Refused` gains `Busy` (the worker's `try_lock` would
block) and `Poisoned`. The existing `borrow` and its `Borrow` guard stay as the RAII form of
`pin` for Rust tests.

### 4.2 Slot, arena and allocator (zero-rt, safe Rust)

```rust
// crates/zero-rt/src/arena.rs
pub trait Payload: Reset + Send + 'static {
    /// Atomics the worker publishes before a lease and hosts read without the lock.
    type View: Default + Send + Sync;
    /// Clears the payload for reuse, keeping `BODY_KEEP` of each buffer, or nothing when `cold`;
    /// returns the octets taken off the payload's budget charge.
    fn release(&mut self, cold: bool) -> u64;
}

#[repr(align(64))]
pub struct Slot<T: Payload> {
    word: SlotWord,
    lease_epoch: AtomicU64,        // epoch of the batch that delivered the current lease
    payload: sync::Mutex<T>,
    view: T::View,
}

impl<T: Payload> Slot<T> {
    pub fn word(&self) -> &SlotWord;
    pub fn lease_epoch(&self) -> u64;
    /// Host read: lock, require `generation` in Leased or Completing (Acquire load), run `f`, unlock.
    pub fn with_read<R>(&self, generation: u32, f: impl FnOnce(&T) -> R) -> Result<R, Refused>;
    /// Host write: lock, require `generation` in Leased, run `f`, unlock.
    pub fn with_write<R>(&self, generation: u32, f: impl FnOnce(&mut T) -> R) -> Result<R, Refused>;
    /// Host view: word, then `f` over the published atomics, then word again; Ok only when both
    /// word loads show `generation` in Leased or Completing.
    pub fn read_view<R>(&self, generation: u32, f: impl FnOnce(&T::View) -> R) -> Result<R, Refused>;
    /// Worker access outside a lease (Parsing, WorkerOwned, Completing, Closed); `try_lock` only.
    pub fn with_worker<R>(&self, generation: u32, f: impl FnOnce(&mut T, &T::View) -> R) -> Result<R, Refused>;
}

pub struct Arena<T: Payload> {            // Sync without any unsafe impl; permanent per worker index
    worker: u8,
    chunk: usize,                        // 256 slots
    chunks: Box<[OnceLock<Box<[Slot<T>]>>]>,   // fixed spine of SLOTS_PER_WORKER / chunk cells
}
impl<T: Payload> Arena<T> {
    pub fn new(worker: u8, chunk: usize) -> Self;
    pub fn slot(&self, index: u16) -> Option<&Slot<T>>;        // OnceLock::get, never blocks
    pub fn lookup(&self, id: SlotId) -> Result<&Slot<T>, Refused>;   // other worker or never grown: Closed
    pub fn grow(&self) -> Option<Range<u16>>;                  // worker only: sets the next chunk
}

pub struct Allocator {                    // worker-local, in CoreHost's RefCell
    warm: VecDeque<u16>,                  // FIFO, at most SLOTS_KEPT (4,096): buffers kept at BODY_KEEP
    cold: Vec<u16>,                       // buffers given back; taken only when `warm` is empty
    quarantine: VecDeque<(u16, u64)>,     // (index, newest posted epoch at retirement), sorted by construction
    limbo: Vec<u16>,                      // indexes still pinned when a new server claimed the worker
    live: usize,
}
impl Allocator {
    pub fn adopt<T: Payload>(arena: &Arena<T>) -> Self;        // a new server: scan the grown chunks
    /// Warm front, else cold, else grow; skips an index whose lock is busy. Resets the payload
    /// under the lock and returns the guard with the id, so the caller exports before any host
    /// can lock the slot; `.2` is the octets the reset took off the budget charge.
    pub fn allocate<'a, T: Payload>(&mut self, arena: &'a Arena<T>) -> Result<(SlotId, MutexGuard<'a, T>, u64), Exhausted>;
    pub fn retire<T: Payload>(&mut self, arena: &Arena<T>, id: SlotId, stamp: u64) -> Result<(), Refused>;
    /// Quarantine front while stamp <= acked: `Payload::release` under `try_lock` (a busy lock
    /// leaves the work to the reset in `allocate`), warm while fewer than SLOTS_KEPT are warm, cold
    /// beyond. Returns the octets to subtract from the worker's retained counter.
    pub fn release<T: Payload>(&mut self, arena: &Arena<T>, acked: u64) -> u64;
}
```

The sketch in section 3.3 destructures `(id, payload, freed)` and subtracts `freed` from
`WorkerShared::retained`.

Why this shape:

- `Arena<T>` is `Sync` with no `unsafe impl`: `OnceLock<U>` is `Sync` when `U: Sync + Send`,
  `Mutex<T>` is `Sync` when `T: Send`, `SlotWord` and `AtomicU64` are atomics, and `T::View: Sync`.
  The spine is created before the worker starts, so no host lookup races a reallocation
  (map-request-path 14 item 4). No `&mut` to any slot is ever formed (map-runtime defect 4).
- `with_worker` refuses `Leased` and maps a failed `try_lock` to `Busy` (map-runtime defect 2).
  `allocate` takes the lock once and keeps it through export and `hold`, so the reset and the
  export are one critical section; a slot whose lock is busy stays at the front of its list and
  the next index is used. Hosts check the word before locking (section 4.3), so a host holding a
  stale id no longer takes the worker's lock at all, and `Busy` at `allocate` needs a host that
  loaded the word just before the retirement.
- The payload is released (cleared and shrunk) when the quarantine releases the index, not at
  `retire`: a retired slot's bytes stay intact until the readers are 0 and the epoch floor has
  passed its stamp (section 4.5), after which no view or pin can point at them.
- Memory given back: at most `SLOTS_KEPT` (4,096, the counterpart of zero-http's `RECORDS_KEPT`)
  released indexes keep `BODY_KEEP` of each buffer; the rest keep nothing and are allocated only
  when no warm index is free, so a burst that grew the arena returns the core to the same retained
  bound as the record pool, and steady traffic below 4,096 concurrent leases stays on warm indexes
  and allocates nothing. The `Slot` structs themselves (word, lock, view, empty vectors) are never
  freed, because chunks have stable addresses.
- FIFO reuse among warm indexes stretches the 30-bit generation's wrap period by up to 4,096
  reuses of the other warm indexes.
- Poisoning: a closure that panics while holding the guard poisons the lock. `with_read` and
  `with_write` map it to `Refused::Poisoned` (C status `Panic`); the worker's import sees it and
  answers 500; `allocate` calls `Mutex::clear_poison` (std, since 1.77.0) before the reset.
- `#[repr(align(64))]` keeps a slot's word, lock and view off its neighbors' lines (map-runtime
  defect 6); the micro-harness cell decides whether 128 is better on the reference host.
- `crates/zero-rt/src/sync.rs` re-exports `AtomicU64`, `AtomicU32`, `AtomicPtr`, `Ordering`,
  `Mutex`, `MutexGuard` from `loom::sync` under `cfg(zero_loom)` and from `std::sync` otherwise;
  `SlotWord::new` is `const fn` only under `not(zero_loom)`. Under loom, whose `Mutex` has no
  poison API, the shim reports "not poisoned". The name is `zero_loom`, not `loom`, because
  `RUSTFLAGS` reach every crate and tokio 1.53.1 gates code on `cfg(loom)` (its manifest declares
  `[target.'cfg(loom)'.dev-dependencies]`, design-free 12.1).

### 4.3 Host access: lock-then-check, the published view, pins

| Mode | API | Atomic RMWs | States accepted | Used by |
| --- | --- | --- | --- | --- |
| Read under the lock | `Slot::with_read` | 2 (lock, unlock) | Leased, Completing | Node accessors, C name lookups (`zero_req_header`, `_header_id`, `_header_at`, `_param`, `_trailer`), `zero_req_body_retain` |
| Write under the lock | `Slot::with_write` | 2 | Leased, not sealed | every response call |
| Published view | `Slot::read_view` | 0 | Leased, Completing on both word loads | `zero_req_view`, `zero_req_method`, `_method_token`, `_target`, `_path`, `_query`, `_route_path`, `_authority`, `_param_count`, `_header_count`, `_body`, `_peer` |
| Pin | `SlotWord::pin`, `unpin` | 1 each | Leased, Completing | C views outside the batch window, `zero_res_body_alloc` |

Lock-then-check is sound without a reader count: the worker changes the payload only under
`try_lock` (export after `allocate`, import after `begin_import`), so a host holding the lock sees
a payload that matches the word it checks inside the lock. If the worker retires the slot while a
host holds the lock, the word moves to `g + 1` but the payload still holds generation `g`'s
request, which is the host's own; `allocate` skips the index while the lock is busy.

Pre-check: `with_read`, `with_write` and the pinned reads first load the word (`Acquire`) and
return `Closed` without locking when the generation differs or the state is not one they accept;
the check inside the lock stays the authority. The pre-check adds one load and no RMW, changes
nothing in the soundness argument, and keeps a host replaying stale ids (the TSan test's H3, ids
moved between isolates) off the worker's lock, so it can neither fail an export nor hold an
import on the late list.

The published view is `zero_http::PublishedView`: the head pointer and length; a packed `meta`
word (method id, version, flags, parameter count, field count); five packed spans (method token,
target, path, query with an absent bit, authority); pointers to the field table, the route path
and the body with their lengths; the route id, miss status and `Allow` mask; the peer address,
port, family, secure flag and the trust-proxy client address. Parameters and trailers are read under
the lock, because finding one means reading a table entry, which zero-host can do only through a
reference. The worker writes them with `Release` stores inside export, before `hold` and `lease`.
`read_view` loads the word (`Acquire`), checks it, runs the snapshot (`Acquire` loads), loads the
word again (`Acquire`) and compares generation and state. Proof: every value the snapshot can see
for a later generation `g'` was stored (`Release`) after `retire(g)` wrote `g + 1` into the word in
the worker's program order, so a snapshot that saw any such value makes the second word load see
`g + 1` or later, and the call returns `Closed`; a snapshot that saw only generation `g` values is
consistent. No fence is used, because ThreadSanitizer does not model fences (facts 13).
Creating the raw pointers from `Vec::as_ptr` is safe; zero-host never dereferences them, and the
heap buffers they point to are not covered by any `&mut Exchange` a writer holds, because a `Vec`
buffer sits behind a raw pointer that "does not materialize a reference to the underlying slice"
(Rust 1.89 `Vec::as_ptr`, design-copy-out section 1).

View rule (checked at entry, in `zero_host::access`):

```rust
static NEXT_THREAD: AtomicU64 = AtomicU64::new(1);

thread_local! {
    // Both have const initializers and no Drop, so touching them never allocates, takes a lock or
    // registers a destructor; the view path (and every [SuppressGCTransition] entry) stays clean.
    static PINS: RefCell<PinTable> = const { RefCell::new(PinTable::new()) };   // [u64; 64] plus a length
    static THREAD: Cell<u64> = const { Cell::new(0) };                          // 0 until the thread binds
    // Touched only by `pin`: its destructor unpins whatever the thread still holds when it exits.
    static PIN_RELEASE: PinRelease = PinRelease;
}

fn view_allowed(id: SlotId, worker: &WorkerShared, slot: &Slot<HostExchange>) -> bool {
    PINS.with(|pins| pins.borrow().contains(id.as_u64()))
        || (THREAD.with(Cell::get) != 0
            && worker.bound_thread() == THREAD.with(Cell::get)          // the thread bound to this worker's target
            && slot.lease_epoch() > worker.intake.acked())
}
```

A target records the token of its bound thread in each worker it serves (`bound_thread`, an
`AtomicU64`): a pull target at its first `zero_target_poll`, a Node target at `targetAttach` on the
isolate thread; binding assigns the thread's token from `NEXT_THREAD` if it is still 0. One thread
may be bound to several targets (several servers in one process).

A view call by a thread that satisfies neither condition returns `InvalidArgument`. Once handed
out, a view stays valid until the later of the calling thread's unpin of that slot (when it
pinned) and that thread's acknowledgment of the batch that delivered the slot (when it is the
target thread). Both bounds are enforced by Rust, not trusted: a pinned slot cannot retire
(readers above 0), and an index cannot be reused until the acknowledgment floor reaches its
retirement stamp, which is at least the delivering batch's epoch (section 4.5); only the target's
bound thread can advance that floor. A synchronous handler on the target thread therefore reads
views with no pin and no RMW; an async continuation on another thread pins first, and a thread
that pinned holds at most 64 pins (`Limit` beyond). The pin table check is exact: a reader count
of two or more would also be true while another thread's pin is held, which is why the table, not
the count, decides. Pin and unpin keep the table and the count in step (pin takes the count first
and records the id only on success; unpin removes the id first and releases the count only if the
id was present). A thread that exits holding pins releases them in `PIN_RELEASE`'s destructor
(the word CAS works from any thread, and the exiting thread can no longer use a view). Rust does
not promise that thread-local destructors run on every platform or for the main thread, so a pin
can still outlive its thread; such a slot stays out of reuse, which is the safe direction, the
`pinned` counter shows it, and the late list backs off for it (section 4.6 step 4).

`with_read`, `with_write` and `read_view` are called only from `crates/zero-host/src/access.rs`
outside zero-rt's own tests; a zero-host test greps the workspace sources for `with_read(`,
`with_write(` and `read_view(` and fails on any other caller. That is the lint-checked "every
accessor goes through one helper" invariant of DESIGN 7.3, held by the type system: there is no
other path to slot memory.

### 4.4 Memory ordering

- Publication: export (worker, under `try_lock`) writes the request side and stores the view
  (`Release`); `hold` and `lease` are `AcqRel` CASes; a host's lock (`Acquire`) or first word load
  (`Acquire`) of the leased generation happens after them.
- Response: a host's writes happen before its unlock (`Release`); the worker's `try_lock`
  (`Acquire`) at import happens after them.
- Pins: `pin` and `unpin` are `AcqRel`; the worker's `readers()` load before `retire` is `Acquire`,
  and `retire` is an `AcqRel` CAS that requires readers 0.
- Completion and acknowledgment: the intake lock orders the host's appended ids and the ack before
  the worker's drain; `acked` and `published` are atomics read with `Acquire` and written with
  `Release` (or a CAS). The dispatcher stores `published = e` (`Release`) before it posts batch
  `e`; a host learns `e` only from the delivery, which the post's queue (Node's TSFN queue lock, the
  pull target's `Mutex`) orders after that store, so the host's `epoch <= published` check under
  the intake lock always sees it. Acknowledgments are written only by the bound thread itself, or
  by the worker after the target is gone, so a bound thread's view-rule check always observes its
  own acknowledgments (program order).
- No `atomic::fence` anywhere (facts 13).

### 4.5 Epoch-based index reuse

Per worker index (in `WorkerShared::intake`, permanent, so the counters never restart):

- `published: AtomicU64`: the newest posted epoch. The dispatcher assigns `published + 1` to a
  batch, writes it into the ring entry, stores it into `published` with `Release`, and only then
  posts. `Full` and `Gone` store the previous value back (only the worker writes `published`, no
  host can hold an epoch it never received, and nothing else on the worker runs between the store
  and the roll-back), so a `Full` attempt's number is reused and posted epochs stay consecutive. A
  host that runs the batch and acknowledges it before `post` has returned on the worker therefore
  passes `epoch <= published`. The opposite order (store after `Taken`) would refuse that
  acknowledgment, `acked` would stay one behind forever, and the worker would stall with
  `maxBatchesInFlight` batches in flight; `loom_ack_before_post_returns` and a dispatcher test whose `TestTarget`
  acknowledges inside `post` pin the order (sections 7.1 and WP-2).
- `acked: AtomicU64`: the newest acknowledged epoch. A nonzero `epoch` in `zero_batch_complete` is
  accepted only when the calling thread is the target's bound thread and `epoch == acked + 1` and
  `epoch <= published`; it then stores `epoch` (a CAS from `epoch - 1`, under the intake lock). A
  refused acknowledgment changes no acknowledgment state and the call returns `InvalidArgument`
  (strict ack order; a confused host cannot release another batch's indexes early), but the
  completions listed in the same call are still applied: completions release nothing (only
  acknowledgments move the floor), each id is checked on its own, and dropping them would leave
  sealed responses unsent until `request_total`. `ZERO_EPOCH_NONE` is 0 and acknowledges nothing.
- `retire(id)` pushes `(index, published)` onto the FIFO quarantine. `release(acked)` moves entries
  from the front while `stamp <= acked`. Stamps are monotonic, so this is O(1) per index.

Guarantee: an index is reused only after (a) its pins reached zero and (b) every batch posted
before it was retired was acknowledged, that is, the target finished the synchronous dispatch
iteration of each of them. Since acks are in order and the floor is `acked`, a target with nothing
outstanding (`acked == published`) releases every retired index at once: there are no probe
batches. DESIGN 7.3's "every registered host target" is exactly one target per worker here, so the
minimum is that target's `acked`. Ids moved between isolates with `postMessage` hold no view and
are covered by the generation and the lock.

A target that stops acknowledging stops receiving batches after `maxBatchesInFlight`; its
quarantine grows until the arena cannot allocate, and that core answers tier 3 with 503 while
tiers 0 to 2 keep serving. Detaching the target (or an isolate's teardown) releases everything
(section 4.8).

`release(acked)` runs in the dispatcher turn right after an acknowledgment is applied, clears and
shrinks each released exchange under `try_lock` (section 3.4), and returns the octets that leave
the worker's `retained` counter.

Capacities of `warm`, `cold`, `quarantine` and the waiter table are reserved each time a chunk is
grown, so the warm path allocates nothing.

### 4.6 The completion path

1. A host seals each response: `zero_res_respond`, `zero_res_send`, `zero_res_error` or an action
   call (`zero_res_file`, `zero_res_sse_open`, `zero_res_ws_accept`) sets `sealed` under the lock;
   later writes return `Closed`.
2. Any thread calls `zero_batch_complete(worker, ids, count, epoch, results)`. It checks the
   pointers and the worker index first (a refusal there changes nothing). Each id is decoded
   (above 2^53 - 1 or another worker's index is `InvalidArgument`) and checked with one word load
   (a stale generation or a state other than `Leased` or `Completing` is `Closed`), with no
   per-slot lock and no per-slot RMW; `results_out` receives each id's status. Then one intake
   lock: append the accepted ids, check and apply the acknowledgment (section 4.5), take the
   waker; unlock; wake once. The call returns `Ok`, or `InvalidArgument` when the acknowledgment
   was refused, in which case the ids were still appended (decision 6). That is one cross-thread
   wake per call (DESIGN 8.1), which reaches the core through tokio's remote queue or compio's
   ready queue (map-runtime section 8).
3. The worker's dispatcher task swaps the intake vector with a spare of equal capacity, then per
   id: the waiter's generation must match (a stale id is ignored); a live waiter is woken with
   `Sealed` (a same-thread wake); an orphan (its future dropped) goes to the retire path. Each
   acknowledgment frees its ring entry, the floor moves, and the quarantine releases.
4. The tier 3 future runs `begin_import(g)`, then `with_worker`: a busy lock (a host is inside a
   call) or, when `staged`, a nonzero reader count puts the slot on the late list, which the
   dispatcher re-polls on a core timer and counts as `late_readers` (production re-polling, not a
   test sleep). Each entry carries its own interval: 1 ms for its first 64 ms on the list, then
   doubling up to 1 s, so a pin that outlives its thread (section 4.3) costs one timer wake per
   second rather than a thousand. The timer is armed for the earliest entry and disarmed when the
   list is empty. Under the lock it imports: an unsealed slot that was written (`touched`) is sent
   as written; one never written is answered 500 with code `NO_RESPONSE` in the server's shape.
   Then `retire` once readers are 0 (else the late list), and the action runs.

Exactly one outcome per lease: the worker alone retires, from its worker-local waiter record, once.
A host completion that arrives after `close_leased` finds `Closed` at its write and its id is
ignored at the drain.

### 4.7 Cancellation and the lease timeout

`LeaseGuard::drop` (the tier 3 future dropped before `retire`):

| Slot state at drop | Effect |
| --- | --- |
| `Parsing` or `WorkerOwned` (queued, not posted) | the dispatcher tombstones the job; `close(g)`; retired at once |
| `Leased` | `close_leased(g)` sets `Closed` and the cancel bit; later host writes return `Closed`, `zero_slot_canceled` reports it; retired once readers are 0 |
| `Completing` | retired once readers are 0 and the lock is free |
| `Closed` | retired once readers are 0 |

The triggers are the driver's (map-request-path section 8): request total timeout, socket errors,
discards after an earlier claim or close, the drain deadline. The lease timeout is the driver's
`request_total` (300 s, equal to `LEASE_TIMEOUT` in `zero-limits`): `zero_server_new` refuses a
configuration where they differ, and no second timer exists. Peer EOF while a handler runs does not
cancel today and this design keeps that.

### 4.8 Target loss, server stop and worker index reuse

- Target loss (`zero_target_detach`, a Node isolate's cleanup hook, or a TSFN post returning
  `Gone`) is pushed to the intake. The worker closes every `Leased` slot of that worker with
  `close_leased`, wakes their futures with `TargetGone` (503), fails queued jobs the same way, drops
  queued events, frees its ring entries, clears the worker's `bound_thread`, and stores
  `acked = published`: the target is gone, so no view of it can exist. For a C host,
  `zero_target_detach` is that declaration: the target's thread holds no view and makes no further
  view call through it, and a view call racing the detach is a host error (Node and Python reach
  the detach only from the environment teardown or after the polling thread stopped). A worker with
  no target admits no tier 3 request.
- `zero_server_shutdown` starts the drain and returns at once; a reaper thread in zero-host joins
  the workers (`Workers::stop` blocks, so it never runs on a host's dispatch thread,
  map-request-path 14 item 12), detaches every target, marks the server stopped, and runs the
  server's stop listeners once (zero-host keeps them as `Box<dyn FnOnce() + Send>`; the Node
  binding registers one per `serverWait`, section 8.4). `zero_server_wait` blocks the calling
  thread until then; it returns `InvalidArgument` on an I/O worker thread and on a thread bound to
  one of that server's targets, because the drain needs that thread's acknowledgments and a wait
  there could only time out. The worker indexes return to the pool.
- A server claiming a used index runs `Allocator::adopt`: `Free` slots join the warm list up to
  `SLOTS_KEPT` and the cold list beyond it; slots in
  another state with readers 0 are retired now (generation + 1); pinned slots go to `limbo` and are
  retried each turn. The arena, its generations and the intake counters persist, so a stale id from
  the earlier server reads `Closed`.

### 4.9 Invariants

These are the statements the loom models, the TSan tests and the rustdoc of `Slot` cite.

- I1. Only the worker changes the state bits; hosts change only the reader count.
- I2. The worker writes the request side and the published view only between `claim` and `hold`,
  under `try_lock`.
- I3. The request side and the view are frozen from `hold` until the next `claim` of the index.
- I4. A host reads the payload only under the lock with the word at the id's generation in `Leased`
  or `Completing`, or through the view between two such word loads.
- I5. A host writes the response side only under the lock with the word `Leased` at the id's
  generation and `sealed` clear.
- I6. The worker reads or swaps the response side only after `begin_import`, under `try_lock`, and,
  when `staged`, only with readers 0.
- I7. `retire` requires readers 0 and bumps the generation in the same CAS.
- I8. `allocate` takes an index only from the warm or cold list, which receive an index only when
  its stamp is at most `acked`; a slot's delivering epoch is at most its stamp.
- I9. `acked` advances by one, only from the target's bound thread, or by the worker after the
  target is gone.
- I10. No `fence`; every ordering comes from a lock, a CAS, or a `Release` and `Acquire` pair.
- I11. `published` holds a batch's epoch before the batch is posted, and returns to the previous
  value only when the post did not deliver it.
- I12. `allocate` resets, exports and holds a slot under one acquisition of its lock.

## 5. (c) The batch dispatcher

### 5.1 State (zero-rt `dispatch.rs`, worker-local, generic over the hold type)

```rust
pub struct Job { pub slot: SlotId, pub route: u32 }
pub struct EventRec { pub conn: u64, pub route: u32, pub kind: u8, pub opcode: u8, pub code: u16, pub data: Vec<u8> }

pub trait Target: Send + Sync {
    /// Offers a batch; never blocks and never runs host code on the calling thread.
    fn post(&self, batch: BatchRef) -> Post;
}
pub enum Post { Taken, Full, Gone }
#[derive(Clone, Copy)]
pub struct BatchRef { pub worker: u8, pub entry: u8, pub kind: u8, pub count: u16, pub epoch: u64 }   // 16 bytes, Copy, no Drop

pub struct BatchRing { entries: Box<[Mutex<BatchBuf>]> }          // max_batches_in_flight entries, permanent
pub struct BatchBuf { epoch: u64, kind: u8, slots: Vec<u64>, routes: Vec<u32>, events: Vec<EventRec> }   // capacity 256 each
impl BatchRing {
    /// Copies ids and route ids out if the entry still holds `r.epoch`.
    pub fn read<R>(&self, r: BatchRef, f: impl FnOnce(&[u64], &[u32]) -> R) -> Result<R, Refused>;
    /// Moves the event records out (vector header swaps) if the entry still holds `r.epoch`.
    pub fn take_events(&self, r: BatchRef, into: &mut Vec<EventRec>) -> Result<(), Refused>;
}

pub struct Dispatcher<H> {
    ready: VecDeque<(Job, Option<H>)>,     // reserved to max_queued_batches * max_batch_size (4,096)
    events: VecDeque<EventRec>,            // bounded by count (4,096) and bytes (the core's memory budget)
    unacked: VecDeque<(u64, u8)>,          // (epoch, ring entry), at most max_batches_in_flight
    full: bool,
    retry_armed: bool,
    prefer_events: bool,                   // alternate batch kinds when both wait
    draining: bool,                        // set by the shutdown signal; section 5.2 step 6
    limits: DispatchLimits,                // batch 256, in flight 4 (accepted 1 to 8), queued 16
    counters: Counters,
}
```

### 5.2 One dispatcher turn

1. Drain the intake (section 4.6): wake sealed waiters, retire orphans, apply acknowledgments
   (pop `unacked` front entries up to `acked`, free their ring entries, clear `full`), release the
   quarantine, apply a target attach or loss.
2. Re-poll the late list.
3. While a target is attached, `unacked.len() < in_flight` and not `full`, and `ready` or `events`
   is non-empty: pick the kind (alternate when both wait, so a WebSocket flood cannot starve HTTP
   requests or the reverse); take a free ring entry; move up to 256 entries in, skipping
   tombstones (retired at once); for requests, `lease(g)` each job and store its `lease_epoch`
   (a job whose lease fails is retired and skipped); stamp `e = published + 1` into the entry;
   store `published = e` (`Release`); `post`.
   - `Taken`: push `(e, entry)` to `unacked`, drop the posted jobs' read holds, set the waiters'
     stage to in flight, count `batches`. An acknowledgment of `e` may already sit in the intake;
     the next turn applies it.
   - `Full`: store `published = e - 1`, `unlease` the jobs (no host has seen them), put them back
     at the front in order, free the entry, set `full`, count `queue_full`. If nothing is in
     flight, arm a 1 ms core timer that clears `full`, since no acknowledgment will come to clear
     it.
   - `Gone`: store `published = e - 1`, then target loss (section 4.8).
4. Never hold a ready job back to grow a batch (DESIGN 7.2): whatever is ready goes out.
5. Sleep on the intake waker, the kick (new jobs and events), the retry and late-list timers, and
   the shutdown signal, raced in one `poll_fn` the way `websocket.rs:382-400` races the inbox, the
   read and shutdown.
6. Exit rule. The dispatcher task counts in zero-io's `Tasks.live`, and the worker's drain waits
   for `live == 0` up to the drain deadline (`crates/zero-io/src/tokio_rt/worker.rs:83-94, 426`),
   so a dispatcher that keeps sleeping would hold every shutdown to the full deadline (30 s by
   default), and one that stopped at the signal would strand the in-flight futures. On the
   shutdown signal it sets `draining` and keeps running turns: `admit` already refuses new tier 3
   work (section 3.3), queued jobs and events are still posted, and acknowledgments and
   completions are still drained. It returns at the end of a turn in which `draining` is set and
   nothing remains: no waiter, no ready job, no queued event, no unacknowledged batch, no late-list
   entry, and no open realtime connection on this worker index (the connection tasks end on the
   same signal, section 6.8, and push their close events first). With no target attached, target
   loss has already failed the waiters, so an idle core's dispatcher returns on the turn that sees
   the signal. If the deadline passes first, zero-io drops the remaining tasks; each dropped
   `LeaseGuard` closes its lease (section 4.7). Tests in WP-8, named after DESIGN 5.6's shutdown
   statement (no external specification, so no registry row): `zero_server_wait` returns within
   one second of `zero_server_shutdown` on an idle server with a target attached, and within one
   second of the in-flight request's completion when a tier 3 request is leased at the shutdown;
   both with a drain deadline of 30 s, so a dispatcher that holds the drain open fails them.

### 5.3 Admission and the 503 rule

`admit()` refuses when no target is attached for this worker, when `ready.len() >=
max_queued_batches * max_batch_size` (16 x 256 = 4,096 jobs: 16 full batches queued behind the
in-flight bound), or when the allocator is exhausted after releasing the quarantine. A refused
request is answered by `overload::answer` on the worker before any slot exists (section 3.6). In
the Node pool mode, `zero_server_start` runs only after every isolate attached, so the no-target
window is empty in practice.

### 5.4 Back pressure and `QueueFull`

- `backlogged()` is true while `full` is set or `ready` holds more than one batch's worth of jobs. A
  tier 3 request enqueued while backlogged takes `call.hold_reads()`, so its connection stops
  reading until its job is posted (the hold drops at `Taken`): "the worker stops reading from the
  connections that fed it" (DESIGN 8.2), per connection, without stalling tier 0 connections on the
  core. A non-pipelining client is already held by its own pending request; the hold matters for
  pipelining clients.
- The Node target's queue bound is 8 (`max_queue_size::<8>()`, a const generic, so it is the
  ceiling of `maxBatchesInFlight`) and in flight is at most `maxBatchesInFlight` (default 4)
  unacked batches; an item leaves Node's queue when `call_js_cb` runs, before its acknowledgment
  can exist, so `QueueFull` cannot occur in steady state (facts 2: the Rust-side cap counting until
  completion "is stricter than the Node queue bound"). It is handled anyway, counted, and the
  payload is the 16-byte `BatchRef`, so the leak napi 3.14.0 has on every non-`napi_ok` call (facts
  2, finding 1) holds no resource.
- Pull targets never return `Full`: their queue holds at most `in_flight` batches per worker.

### 5.5 Events

Each WebSocket or SSE connection task turns inbound occurrences into `EventRec`s (payload `Vec`s
moved from the frame decoder, not copied) and pushes them to the dispatcher with `kick`. A
connection keeps at most `MAX_PENDING_EVENTS_PER_CONN` (64, new zero-limits constant, a judgment)
unacknowledged events and stops reading its socket while at that bound, so a flooding client is
held by TCP rather than by memory. Events reach the host in socket order per connection (FIFO
queue, `Full` re-queues at the front in order, a target runs a batch's records in array order).
Event batches share the in-flight bound with request batches and are released at their
acknowledgment.

### 5.6 Targets

| Target | Crate | `post` | Host side |
| --- | --- | --- | --- |
| `PullTarget` | zero-host | `Mutex<VecDeque<BatchRef>>` push plus `Condvar::notify_one` (capacity `in_flight` per worker served) | the host's own thread blocks in `zero_target_poll` |
| `TsfnTarget` | bindings/node | `tsfn.call(batch, NonBlocking)`: `Ok` is `Taken`, `QueueFull` is `Full`, `Closing` is `Gone` | the isolate's ThreadsafeFunction callback |
| `TestTarget` | zero-rt and zero-host tests | channel to a test thread | test threads |

There is no push target calling a host function pointer: a C callback on the worker would run host
code on an I/O worker and attach it to the CLR or the interpreter (DESIGN 5.1 and 8.4), and a
foreign unwind through it would be undefined behavior (facts 11). A `PullTarget` attached with
`ZERO_ALL_WORKERS` serves every worker of a server from one queue (the single Python handler
thread under the GIL); otherwise it serves one worker (a .NET managed thread per worker).

### 5.7 Panic policy and metrics

The dispatcher task runs under `contain`; a panic there marks the core's host dispatch failed:
waiters are woken with `Failed` (500), new tier 3 requests get 503, and a new
`zero_rt::worker::Event::HostFailed { core, message }` goes through the status sink. The core
keeps serving tiers 0 to 2 and 4; the binding decides whether to restart the server. zero-serve's
status sink (`crates/zero-serve/src/lib.rs:678-691`) matches `Event` with no wildcard arm, so WP-2
adds the `HostFailed` arm there (logged like `TaskPanic`) in the same commit.

Per-worker counters in `WorkerShared` (atomics, summed by `zero_server_stats`): `dispatched`,
`batches`, `acks`, `late_readers`, `queue_full`, `refused_503`, `closed_leases`, `panics`,
`pinned`, `quarantined_peak`, `in_flight`, `leased`, `refused_acks` (acknowledgments refused while
their completions were applied), `abandoned_batches` (section 8.4), `retained` (octets, section
3.4).

### 5.8 Allocation discipline

Warm tier 3 path on the worker: no allocation. The pull target pushes into a reserved queue; the
ring entries, intake vectors, quarantine and free list are reserved as chunks grow. The Node
target allocates napi-rs's one `Box` per `call` (facts 2), which is per batch. A counting-allocator
test in zero-host (`tests/no_alloc_tier3.rs`) drives tier 3 through a `TestTarget` that does not
allocate and asserts zero global allocations per request on the worker thread after warm-up; the
existing tier 4 assertion in zero-http stays unchanged.

## 6. (d) The C ABI of zero-ffi for release 1

### 6.1 Rules (printed at the top of `zero.h` through the crate rustdoc)

- O1. Servers, apps, targets, slots and connections are `uint64_t` ids of at most 53 bits (they
  survive as JavaScript numbers) and are generation-checked: a stale or unknown id returns
  `ZeroStatus_Closed`, an id above `ZERO_ID_MAX` returns `ZeroStatus_InvalidArgument`. `ZERO_NONE`
  (`UINT64_MAX`) means "no id" where an argument allows it.
- O2. An input byte range `(const uint8_t *ptr, uintptr_t len)` is borrowed for the call only and
  must not change during it. `len == 0` accepts any `ptr`, including NULL; NULL with `len > 0`, or
  `len` above `PTRDIFF_MAX`, returns `InvalidArgument`. Rust copies whatever it keeps. One
  exception: in `zero_sse_send`, a NULL `event` or `id` means the field is absent, and a non-NULL
  pointer with length 0 is a present empty value.
- O3. An output pointer must be non-null and aligned for its type, otherwise `InvalidArgument` and
  nothing is written. Outputs are written only on `Ok`, except the per-slot `results_out` of
  `zero_batch_complete` and the `count_out` of `zero_server_workers`, which reports the full count
  with `Limit` when `cap` is too small.
- O4. Every struct passed singly by pointer starts with `uint32_t size`. For an input the host
  sets `size = sizeof(struct)`; Rust reads `min(size, its own size)` bytes and zero-fills the rest;
  a size below the version 1 size is `InvalidArgument`. For an output the host sets `size` before
  the call; Rust writes `min(size, its own size)` bytes and stores the number written in `size`.
  An array of structs carries its element size beside the pointer instead (`field_size` in
  `ZeroResponseSpec` for its `ZeroHeaderPair` array, `event_size` in `zero_target_poll` for its
  `ZeroEvent` array, `field_size` in `ZeroRequestView` for its `ZeroField` table), read and
  written with the same `min` rule per element, so an element can grow without breaking the
  stride. Fields are appended, never reordered, so an older host keeps working.
- O5. A view (`ZeroBytes`, `ZeroRequestView` and the pointers inside it) points into a slot and is
  read-only. A view call succeeds only for a thread that holds a pin on the slot
  (`zero_slot_pin`) or that is the slot's target thread and has not yet acknowledged the batch that
  delivered the slot; otherwise it returns `InvalidArgument`. A view stays valid until the later of
  that thread's unpin and that thread's acknowledgment of the delivering batch. A thread holds at
  most 64 pins (`Limit` beyond). `{NULL, 0}` means absent; a present empty value has a non-null
  pointer.
- O6. `zero_res_body_alloc` returns a writable, zero-filled region inside the slot's response. It
  requires the calling thread's pin, and is valid while that pin is held and until the response is
  sealed or reset. While a region is open, every other body-setting call and `zero_res_reset` on
  that slot return `InvalidArgument`.
- O7. Rust frees what Rust allocated: a `ZeroString *` or `ZeroBuffer *` is released only by
  `zero_string_free` or `zero_buffer_free` (NULL is a no-op), exactly once (ANSSI FFI-MEM-OWNER).
  These two handle types are the one exception to "stale input returns a status": they are owned
  pointers, not generation-checked ids, so the six functions over them (`zero_string_data`,
  `_len`, `_free`, `zero_buffer_data`, `_len`, `_free`) are total on NULL, and using a pointer
  after its free is a host error the header states, like `free(3)`. Every id-taking function
  (servers, apps, targets, slots, connections) returns a status on a stale id. Rust never frees
  host memory and never calls a host function pointer at release 1.
- O8. Every integer from a closed set (method, kind, opcode, mode, policy, close code) is an integer
  type checked against the set; Rust never receives a Rust enum value (ANSSI FFI-NOENUM).
  `ZeroStatus` is only ever returned.
- O9. Every export runs under `catch_unwind`. Status-returning exports return `ZeroStatus_Panic`
  instead of unwinding; the few value-returning exports (`zero_version`, `zero_abi_version`,
  `zero_last_error_message`, the string and buffer accessors and frees) return NULL or 0.
- O10. Every export may be called from any thread, except: `zero_target_poll` binds its target to
  the first thread that calls it, and another thread gets `InvalidArgument`; a nonzero `epoch` in
  `zero_batch_complete` is accepted only from that bound thread; `zero_target_poll` and
  `zero_server_wait` return `InvalidArgument` on an I/O worker thread instead of deadlocking, and
  `zero_server_wait` also on a thread bound to one of that server's targets, whose
  acknowledgments the drain needs.
- O11. Event payload views written by `zero_target_poll` live in the target's delivery storage and
  stay valid until the next `zero_target_poll` on that target or `zero_target_detach`.
- O12. A failing call records a thread-local message naming the argument or the refusal;
  `zero_last_error_message` returns it as a new owned string, or NULL when this thread has none.
  Success leaves it unchanged. The message lives in a fixed 256-octet per-thread buffer with a
  const initializer and no destructor (truncated at a UTF-8 boundary), so recording a refusal
  allocates nothing and takes no lock; only `zero_last_error_message` allocates.

### 6.2 Status codes

```c
typedef enum ZeroStatus {
  ZeroStatus_Ok = 0, ZeroStatus_Protocol = 1, ZeroStatus_Io = 2, ZeroStatus_Codec = 3,
  ZeroStatus_Closed = 4, ZeroStatus_Auth = 5, ZeroStatus_Unsupported = 6, ZeroStatus_Timeout = 7,
  ZeroStatus_Limit = 8, ZeroStatus_InvalidArgument = 9, ZeroStatus_Panic = 10,
} ZeroStatus;   /* #[repr(C)]; the numbering bindings/dotnet ZeroStatus.cs already uses */
```

| Condition | Status |
| --- | --- |
| null or misaligned output, null input with nonzero length, length above `PTRDIFF_MAX`, struct size below version 1 | `InvalidArgument` |
| id above `ZERO_ID_MAX`; an undeclared method, kind, opcode, mode, policy, header id or close code; an index at or past the count | `InvalidArgument` |
| view call without a pin outside the batch window; region call without a pin; body write or reset while a region is open; epoch out of order or from another thread (the completions in that call are still applied); poll from a second thread or a worker thread; wait from a worker thread or from a thread bound to one of the server's targets; an array element size below its version 1 size | `InvalidArgument` |
| invalid field name or value, status outside the allowed range, non-UTF-8 text frame, SSE `event` or `id` with CR or LF, `id` with NUL | `InvalidArgument` (DESIGN 8.1: response writes refuse rather than emit) |
| stale generation, unknown id, slot not in an accepted state, sealed response, connection gone, target detached, server stopped | `Closed` |
| pin limit, reader ceiling, body above the response limit, outbox hard cap, no free worker index, server still running at free, second target on a worker | `Limit` |
| malformed option document (the key or position is named) | `Codec` |
| capability compiled out, `zero_req_claim` before JWT, an unknown conformance section | `Unsupported` |
| poll or wait timed out | `Timeout` |
| bind failure, TLS material unreadable | `Io` |
| panic inside the export, or a poisoned slot | `Panic` |

`zero_host` has one `status_of(&Access)` mapping beside `zero_http::error::code_for`.

### 6.3 Constants

```c
#define ZERO_ABI_VERSION 1
#define ZERO_PLUGIN_ABI_VERSION 1
#define ZERO_ID_MAX 9007199254740991ULL
#define ZERO_NONE UINT64_MAX
#define ZERO_EPOCH_NONE 0
#define ZERO_ALL_WORKERS UINT32_MAX
#define ZERO_MAX_BATCH 256
#define ZERO_MAX_PARAMS 16
#define ZERO_HEADER_NONE UINT32_MAX
#define ZERO_HEADER_COUNT 49            /* HeaderName::ALL.len(); one ZERO_HEADER_<NAME> per entry */
#define ZERO_METHOD_GET 0               /* HEAD 1, POST 2, PUT 3, DELETE 4, CONNECT 5, OPTIONS 6, TRACE 7 */
#define ZERO_METHOD_PATCH 8
#define ZERO_METHOD_ANY 254             /* registration only */
#define ZERO_METHOD_OTHER 255           /* a token outside the registry; read it with zero_req_method_token */
#define ZERO_HEADER_SET 0               /* zero_res_header modes */
#define ZERO_HEADER_APPEND 1
#define ZERO_BATCH_REQUESTS 1
#define ZERO_BATCH_EVENTS 2
#define ZERO_EVENT_WS_OPEN 1            /* WS_MESSAGE 2, WS_PONG 3, WS_CLOSE 4, WS_DRAINED 5, SSE_CLOSED 6, SSE_DRAINED 7 */
#define ZERO_OPCODE_TEXT 1
#define ZERO_OPCODE_BINARY 2
#define ZERO_VIEW_SECURE 1              /* ZeroRequestView.flags */
#define ZERO_VIEW_UPGRADE 2
#define ZERO_VIEW_KEEP_ALIVE 4
#define ZERO_VIEW_EXPECT_CONTINUE 8
#define ZERO_VIEW_HEAD_AS_GET 16
#define ZERO_VIEW_QUERY 32              /* a query is present (possibly empty) */
#define ZERO_ROUTE_HOST 0               /* route kinds: STATIC 1, REDIRECT 2, FIXED 3, WEBSOCKET 4, HEALTH 5 */
#define ZERO_POLICY_CORS 0              /* SECURITY_HEADERS 1, REQUEST_ID 2, TRUST_PROXY 3, BODY_LIMIT 4 */
```

Constants are `pub const` items in `crates/zero-ffi/src/abi/names.rs`, written by
`cargo xtask ffi-names --write` (cbindgen does not expand macros and `parse_deps = false`); a unit
test asserts each equals the zero-http-types, zero-core or zero-limits value it mirrors and that
`ZERO_HEADER_COUNT == HeaderName::ALL.len()`.

### 6.4 Types

```c
typedef struct ZeroString ZeroString;   /* opaque, owned, NUL-terminated UTF-8 */
typedef struct ZeroBuffer ZeroBuffer;   /* opaque, owned bytes */

typedef struct ZeroBytes { const uint8_t *ptr; uintptr_t len; } ZeroBytes;
typedef struct ZeroSpan { uint32_t start; uint32_t len; } ZeroSpan;
typedef struct ZeroField { ZeroSpan name; ZeroSpan value; uint32_t id; } ZeroField;   /* id: ZERO_HEADER_* or ZERO_HEADER_NONE */

typedef struct ZeroRequestView {
  uint32_t size;
  uint8_t method; uint8_t version; uint16_t flags;        /* ZERO_METHOD_*, 10 or 11, ZERO_VIEW_* */
  uint32_t route; uint16_t miss_status; uint16_t allow;   /* miss_status 0 when matched; allow: bit i = method id i */
  const uint8_t *head; uint32_t head_len; uint32_t field_count;
  ZeroSpan method_token, target, path, query, authority;  /* into head; path excludes the query */
  const ZeroField *fields;                                /* field_count entries, spans into head */
  const uint8_t *route_path; uint32_t route_path_len; uint32_t param_count;   /* normalized path the route matched */
  const uint8_t *body; uint64_t body_len;
  uint32_t field_size; uint32_t reserved;                 /* sizeof(ZeroField) as written: the stride of `fields` */
} ZeroRequestView;

typedef struct ZeroPeer {
  uint32_t size;
  uint8_t family; uint8_t secure; uint8_t transport; uint8_t alpn;   /* family 0, 4 or 6; transport 1 tcp, 2 tls; alpn 0 at release 1 */
  uint16_t port; uint16_t client_port;
  uint8_t client_family; uint8_t reserved[7];
  uint8_t address[16];
  uint8_t client_address[16];                                       /* after the trust-proxy rule; equals address without one */
} ZeroPeer;

typedef struct ZeroHeaderPair { ZeroBytes name; ZeroBytes value; } ZeroHeaderPair;
typedef struct ZeroResponseSpec {
  uint32_t size; uint16_t status; uint16_t reserved;     /* status 0 keeps what is set (200 by default) */
  uint32_t field_size; uint32_t reserved2;               /* sizeof(ZeroHeaderPair) as the host built it */
  const ZeroHeaderPair *fields; uintptr_t field_count;   /* appended in order; Set-Cookie may repeat */
  ZeroBytes body;                                        /* copied; replaces any body */
} ZeroResponseSpec;

typedef struct ZeroBatch {
  uint32_t size;
  uint8_t worker; uint8_t kind; uint16_t flags;          /* ZERO_BATCH_REQUESTS or _EVENTS; flags 0 at release 1 */
  uint32_t count; uint32_t reserved;
  uint64_t epoch;
} ZeroBatch;

typedef struct ZeroEvent {
  uint64_t conn; uint32_t route;
  uint8_t kind; uint8_t opcode; uint16_t close_code;
  ZeroBytes data;                                        /* payload or close reason; O11 */
} ZeroEvent;

typedef struct ZeroStats {
  uint32_t size; uint32_t reserved;
  uint64_t dispatched, batches, acks, late_readers, queue_full, refused_503,
           closed_leases, panics, pinned, quarantined_peak, in_flight, leased,
           refused_acks, abandoned_batches, retained;
} ZeroStats;
```

On the Rust side every struct is `#[repr(C)]` with explicit reserved fields so no padding byte is
ever uninitialized when copied out, and no field is a `bool` or a Rust enum (any bit pattern a host
writes is a valid value). `ZeroField` and `ZeroSpan` are layout-identical to zero-http's
`HostField` and `HostSpan` (compile-time asserts, section 6.15), so the view's `fields` pointer is
a cast of the exchange's table pointer, never dereferenced by Rust.

### 6.5 Functions

Library and codec utilities (no server needed):

```c
const char *zero_version(void);                         /* static, process lifetime (exists) */
uint32_t    zero_abi_version(void);                     /* ZERO_ABI_VERSION */
ZeroString *zero_last_error_message(void);              /* O12; NULL when none */
const char *zero_string_data(const ZeroString *string); /* NULL for NULL */
uintptr_t   zero_string_len(const ZeroString *string);
void        zero_string_free(ZeroString *string);
const uint8_t *zero_buffer_data(const ZeroBuffer *buffer);
uintptr_t   zero_buffer_len(const ZeroBuffer *buffer);
void        zero_buffer_free(ZeroBuffer *buffer);
ZeroStatus  zero_header_name(uint32_t id, ZeroBytes *name_out);                       /* canonical spelling, static */
ZeroStatus  zero_header_id(const uint8_t *name, uintptr_t len, uint32_t *id_out);     /* ZERO_HEADER_NONE when not interned */
ZeroStatus  zero_field_validate(const uint8_t *name, uintptr_t name_len,
                                const uint8_t *value, uintptr_t value_len);           /* the zero_res_header rules */
ZeroStatus  zero_conformance_case(const uint8_t *section, uintptr_t section_len,
                                  const uint8_t *input, uintptr_t input_len,
                                  ZeroBuffer **result_out);                           /* section 6.11 */
```

Apps (route and policy registration; section 6.9 gives the option documents):

```c
ZeroStatus zero_app_new(uint64_t *app_out);
ZeroStatus zero_app_free(uint64_t app);
ZeroStatus zero_app_route(uint64_t app, uint32_t kind, uint8_t method,
                          const uint8_t *pattern, uintptr_t pattern_len,
                          const uint8_t *options, uintptr_t options_len, uint32_t *route_out);
ZeroStatus zero_app_mount(uint64_t app, const uint8_t *prefix, uintptr_t prefix_len, uint64_t child);   /* child consumed */
ZeroStatus zero_app_miss(uint64_t app, uint32_t *route_out);    /* unmatched requests go to the host under this id */
ZeroStatus zero_app_policy(uint64_t app, uint32_t kind, const uint8_t *prefix, uintptr_t prefix_len,
                           const uint8_t *options, uintptr_t options_len);
ZeroStatus zero_app_table(uint64_t app, ZeroBuffer **table_out);  /* canonical table bytes */
```

Servers:

```c
ZeroStatus zero_server_new(uint64_t app, const uint8_t *options, uintptr_t options_len, uint64_t *server_out);
ZeroStatus zero_server_tls(uint64_t server, const uint8_t *cert_chain_pem, uintptr_t cert_len,
                           const uint8_t *key_pem, uintptr_t key_len,
                           const uint8_t *options, uintptr_t options_len);   /* key copied into SecretBytes */
ZeroStatus zero_server_check_table(uint64_t server, uint64_t app);           /* names the first difference */
ZeroStatus zero_server_start(uint64_t server);                               /* binds and starts; returns once listening */
ZeroStatus zero_server_address(uint64_t server, ZeroString **address_out);
ZeroStatus zero_server_workers(uint64_t server, uint8_t *workers_out, uintptr_t cap, uintptr_t *count_out);
ZeroStatus zero_server_shutdown(uint64_t server, uint64_t drain_ms);         /* never blocks */
ZeroStatus zero_server_wait(uint64_t server, uint64_t timeout_ms);           /* Ok when stopped, else Timeout */
ZeroStatus zero_server_stats(uint64_t server, ZeroStats *stats_out);
ZeroStatus zero_server_free(uint64_t server);                                /* Limit while running */
```

Targets and completion:

```c
ZeroStatus zero_target_attach(uint64_t server, uint32_t worker, uint64_t *target_out);   /* a global index or ZERO_ALL_WORKERS */
ZeroStatus zero_target_poll(uint64_t target, uint64_t timeout_ms, ZeroBatch *batch_out,
                            uint64_t *slots, uint32_t *routes, ZeroEvent *events,
                            uintptr_t event_size, uintptr_t cap);   /* cap >= ZERO_MAX_BATCH; event_size = sizeof(ZeroEvent) */
ZeroStatus zero_target_wake(uint64_t target);                                /* a blocked poll returns Timeout */
ZeroStatus zero_target_detach(uint64_t target);                              /* section 4.8 */
ZeroStatus zero_batch_complete(uint8_t worker, const uint64_t *slots, uintptr_t count,
                               uint64_t epoch, ZeroStatus *results_out);     /* results_out nullable, count entries */
```

Slots and requests ("view" means rule O5 applies; "lock" means one lock pair):

| Function | Access | Notes |
| --- | --- | --- |
| `zero_slot_pin(uint64_t slot)` | pin | `Closed` unless `Leased` or `Completing` at that generation; pinning a slot this thread pinned is `InvalidArgument` |
| `zero_slot_unpin(uint64_t slot)` | unpin | `InvalidArgument` unless this thread pinned that id |
| `zero_slot_route(uint64_t slot, uint32_t *route_out)` | view, no rule | a value, not a pointer |
| `zero_slot_canceled(uint64_t slot, uint8_t *canceled_out)` | word load | the cancel bit; also 1 for a closed lease |
| `zero_req_view(uint64_t slot, ZeroRequestView *view_out)` | view | the one-call fast path |
| `zero_req_method(uint64_t slot, uint8_t *method_out)` | view, no rule | `ZERO_METHOD_OTHER` for an unregistered token |
| `zero_req_method_token`, `_target`, `_path`, `_query`, `_route_path`, `_authority` `(uint64_t slot, ZeroBytes *out)` | view | `_path` without the query; `_query` raw without `?`, absent `{NULL, 0}` |
| `zero_req_param_count(uint64_t slot, uint32_t *count_out)` | view, no rule | |
| `zero_req_param(uint64_t slot, uint32_t index, ZeroBytes *out)` | lock, rule | `InvalidArgument` at `index >= count` |
| `zero_req_header_count(uint64_t slot, uint32_t *count_out)` | view, no rule | |
| `zero_req_header_at(uint64_t slot, uint32_t index, ZeroBytes *name_out, ZeroBytes *value_out)` | lock, rule | |
| `zero_req_header_id(uint64_t slot, uint32_t name_id, uint32_t nth, ZeroBytes *out)` | lock, rule | `nth` past the last occurrence is `Ok` with an absent view |
| `zero_req_header(uint64_t slot, const uint8_t *name, uintptr_t len, uint32_t nth, ZeroBytes *out)` | lock, rule | ASCII case-insensitive |
| `zero_req_trailer(uint64_t slot, const uint8_t *name, uintptr_t len, ZeroBytes *out)` | lock, rule | names on the server's trailer allow list only (DESIGN 6.2) |
| `zero_req_body(uint64_t slot, ZeroBytes *out)` | view | buffered body |
| `zero_req_body_retain(uint64_t slot, ZeroBuffer **body_out)` | lock | an owned copy, valid until `zero_buffer_free` |
| `zero_req_claim(uint64_t slot, const uint8_t *name, uintptr_t len, ZeroBytes *out)` | | `Unsupported` until JWT verification ships (step 19) |
| `zero_req_peer(uint64_t slot, ZeroPeer *peer_out)` | view, no rule | values |

"View, no rule" functions return values, not pointers, so they need the generation check only.

Responses (each one write under the lock unless noted):

| Function | Notes |
| --- | --- |
| `zero_res_status(uint64_t slot, uint16_t status)` | 200 to 599; outside 100 to 599 refused ("All valid status codes are within the range of 100 to 599, inclusive", RFC 9110 Section 15); every 1xx refused, because 100 is the driver's, 101 comes only from `zero_res_ws_accept`, and "a server MUST NOT send a 1xx response to an HTTP/1.0 client" (Section 15.2) |
| `zero_res_header(uint64_t slot, const uint8_t *name, uintptr_t name_len, const uint8_t *value, uintptr_t value_len, uint32_t mode)` | RFC 9110 token name; value without CR, LF or NUL (Section 5.5) and without surrounding whitespace; `Content-Length`, `Connection`, `Transfer-Encoding`, `Date` refused (`call.rs:30-35`); `ZERO_HEADER_SET` replaces every line of that name, `ZERO_HEADER_APPEND` adds one more line, so each `Set-Cookie` is its own field line (Section 5.3) |
| `zero_res_header_id(uint64_t slot, uint32_t name_id, const uint8_t *value, uintptr_t value_len, uint32_t mode)` | as above |
| `zero_res_body_copy(uint64_t slot, const uint8_t *body, uintptr_t len)` | replaces the body; up to `maxResponseBody`; refused while a region is open |
| `zero_res_json(uint64_t slot, const uint8_t *json, uintptr_t len)` | body plus `Content-Type: application/json`; not parsed |
| `zero_res_error(uint64_t slot, uint16_t status, const uint8_t *code, uintptr_t code_len, const uint8_t *message, uintptr_t message_len, const uint8_t *details_json, uintptr_t details_len)` | clears the response; status outside 400 to 599 becomes 500; `code` 1 to 64 octets of `A-Z`, `0-9`, `_`; an absent message uses the reason phrase; `details_json` is checked with zero-json's strict parser and dropped when malformed (an error path never fails twice); writes the server's `ErrorShape`; seals |
| `zero_res_body_alloc(uint64_t slot, uintptr_t len, uint8_t **region_out)` | O6; zero-filled; up to `maxResponseBody` |
| `zero_res_respond(uint64_t slot, const ZeroResponseSpec *spec)` | status, field lines (appended) and body in one call; seals; refused while a region is open |
| `zero_res_file(uint64_t slot, const uint8_t *root, uintptr_t root_len, const uint8_t *path, uintptr_t path_len)` | action; empty root refused; zero-static policy at completion; seals |
| `zero_res_sse_open(uint64_t slot, uint32_t keep_alive_ms, uint64_t *conn_out)` | action; refused for HEAD (`sse.rs:46-51`); the connection id exists at once, and sends before the stream head is written queue in its outbox; status and fields set before the call go into the stream head; seals |
| `zero_res_ws_accept(uint64_t slot, const uint8_t *protocol, uintptr_t protocol_len, uint64_t *conn_out)` | action; only on a WebSocket route's leased upgrade request; a non-empty protocol must be one the client offered and the route allows (RFC 6455 Section 4.2.2: "The value chosen MUST be derived from the client's handshake"); an empty one sends no `Sec-WebSocket-Protocol`; seals. A host that declines sets a status such as 403 and sends |
| `zero_res_reset(uint64_t slot)` | discards status, fields, body and action; refused when sealed or while a region is open |
| `zero_res_send(uint64_t slot)` | seals, closing an open region |

WebSocket, SSE and rooms (connection ids; non-blocking; frames encoded on the calling thread, so
validation errors return synchronously):

```c
ZeroStatus zero_ws_send(uint64_t conn, uint8_t opcode, const uint8_t *data, uintptr_t len);      /* text must be UTF-8 */
ZeroStatus zero_ws_ping(uint64_t conn, const uint8_t *data, uintptr_t len);                     /* at most 125 octets */
ZeroStatus zero_ws_close(uint64_t conn, uint16_t code, const uint8_t *reason, uintptr_t len);   /* section 6.8 */
ZeroStatus zero_ws_terminate(uint64_t conn);                                                    /* closes without a Close frame */
ZeroStatus zero_ws_writable(uint64_t conn, uint8_t *writable_out);
ZeroStatus zero_ws_buffered(uint64_t conn, uint64_t *bytes_out);
ZeroStatus zero_sse_send(uint64_t conn, const uint8_t *event, uintptr_t event_len,
                         const uint8_t *id, uintptr_t id_len, const uint8_t *data, uintptr_t data_len);
ZeroStatus zero_sse_comment(uint64_t conn, const uint8_t *text, uintptr_t len);
ZeroStatus zero_sse_retry(uint64_t conn, uint32_t milliseconds);
ZeroStatus zero_sse_close(uint64_t conn);
ZeroStatus zero_sse_writable(uint64_t conn, uint8_t *writable_out);
ZeroStatus zero_sse_buffered(uint64_t conn, uint64_t *bytes_out);
ZeroStatus zero_room_join(uint64_t conn, const uint8_t *room, uintptr_t len);
ZeroStatus zero_room_leave(uint64_t conn, const uint8_t *room, uintptr_t len);
ZeroStatus zero_room_broadcast(uint64_t server, const uint8_t *room, uintptr_t room_len, uint8_t opcode,
                               const uint8_t *data, uintptr_t len, uint64_t except_conn, uint64_t *delivered_out);
ZeroStatus zero_room_size(uint64_t server, const uint8_t *room, uintptr_t len, uint64_t *count_out);
```

### 6.6 `guard`, the argument helpers and the access helpers

The export wrapper (`crates/zero-ffi/src/guard.rs`):

```rust
pub(crate) fn guard(f: impl FnOnce() -> Result<(), Fail>) -> ZeroStatus {
    match panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => ZeroStatus::Ok,
        Ok(Err(fail)) => { last_error::set(&fail); fail.status }
        Err(payload) => { last_error::set_panic(&payload); dispose(payload); ZeroStatus::Panic }
    }
}
pub(crate) fn guard_value<R>(on_panic: R, f: impl FnOnce() -> R) -> R;   // NULL or 0 on a panic

fn dispose(payload: Box<dyn Any + Send>) {
    // Dropping a payload may panic again (facts 11); a second panic's payload is leaked, not dropped.
    if let Err(again) = panic::catch_unwind(AssertUnwindSafe(move || drop(payload))) { Box::leak(again); }
}
```

`AssertUnwindSafe` is justified because an export touches only the slot (poisoning handled in
section 4.2), the thread-local last error (written with `try_borrow_mut`), the pin table, and the
process registry (`OnceLock`s and a cold-path `Mutex` whose poisoning is mapped to `Panic`). The
ABI is `extern "C"`, not `"C-unwind"`: with every export under `catch_unwind` no Rust panic
reaches the boundary, and since Rust 1.81 one that did would abort rather than be undefined
behavior (facts 11). cbindgen emits both ABIs alike (facts 10).

The single access path (`crates/zero-host/src/access.rs`, safe Rust):

```rust
pub fn with_read<R>(id: u64, f: impl FnOnce(&Exchange) -> R) -> Result<R, Access>;      // registry, lookup, Slot::with_read
pub fn with_write<R>(id: u64, f: impl FnOnce(&mut Exchange) -> R) -> Result<R, Access>; // Slot::with_write
pub fn with_view<R>(id: u64, f: impl FnOnce(&ViewSnapshot) -> R) -> Result<R, Access>;  // view rule, then Slot::read_view
pub fn with_pinned_read<R>(id: u64, f: impl FnOnce(&Exchange) -> R) -> Result<R, Access>;   // view rule, then the lock (lookups that return views)
pub fn pin(id: u64) -> Result<(), Access>;
pub fn unpin(id: u64) -> Result<(), Access>;
```

Each resolves the id (`SlotId::from_raw`, above 2^53 - 1 is `Invalid`), finds
`WORKERS[worker].get()` (absent is `Closed`), then `arena.lookup` (an index never grown is
`Closed`), then the word pre-check of section 4.3 (a stale generation is `Closed` without
touching the lock). zero-ffi exports are `guard(|| { args via ptr::*; zero_host::... ; write outputs })`.
The Node binding calls the same functions, so validation is identical by construction.

### 6.7 The response builder, `body_alloc` and the error writer

- Every `zero_res_*` call runs `access::with_write` and then zero-http's `Response` writers on
  `Exchange::response()`, which already validate names, values and reserved fields
  (`call.rs:550-591`); zero-host adds the status range, the seal, the `staged` refusals, the
  response size limit, and the charge to the worker's `retained` counter (one `fetch_add` per body
  call, recorded in the exchange's `counted`, read by `HostHandler::leased_bytes`; section 3.4).
- `zero_res_body_alloc(slot, len, &region)`: requires the calling thread's pin (pin table),
  refuses when sealed or already staged, resizes the `Owned` body to `len` zero bytes, sets
  `staged`, and returns `body.as_mut_ptr()`. Creating the pointer is safe and does not materialize
  a reference to the buffer (Rust 1.89 `Vec::as_mut_ptr`); no Rust reference to that buffer exists
  until the worker imports, which waits until `staged` slots have readers 0 (invariant I6). While
  `staged`, every other body writer and reset refuse, so the buffer cannot be reallocated under
  the host. The zero fill means a host that writes less than it allocated never sends another
  response's bytes; the region spares a host its own large allocation (a .NET large-object-heap
  array, a Python `bytearray`).
- `zero_res_body_copy` has no 64 KiB ceiling; the threshold of DESIGN 7.3 is each binding's switch
  to `body_alloc` or staging, not an ABI rule. The ceiling is `maxResponseBody` (default 64 MiB, a
  judgment), counted against `REQUEST_MEMORY_PER_CORE`.
- `zero_res_error` calls `Exchange::write_error(server.error_shape, ...)`, so the Node facade's
  try/catch costs one crossing and the body is written in Rust (DESIGN 7.2).

### 6.8 WebSocket, SSE and rooms underneath

- zero-realtime gains `outbox::Outbox` (WP-4): `Mutex<Queue { frames: VecDeque<Command>, bytes:
  u64, closed: bool, waker: Option<Waker> }>` plus an `AtomicU64` mirror of `bytes`, the shape of the
  rooms `Inbox` (`rooms.rs:43-86`). Commands: `Frame(Arc<[u8]>)` (an encoded WebSocket frame or SSE
  event), `Close { code, reason }`, `Terminate`, `Join(String)`, `Leave(String)`, `End`.
  `WebSocket::with_outbox` makes `recv`'s read wait also poll the outbox beside the socket, the
  shutdown signal and the room inbox, surfaces pongs, and signals `drained` when the queue falls
  below half its high-water mark after passing it; `EventStream::with_outbox` and
  `EventStream::send_encoded` do the same for SSE.
- Shutdown: on the shutdown signal a host-driven WebSocket sends Close 1001 ("going away", RFC
  6455 Section 7.4.1) after flushing its outbox, waits for the peer's Close up to the drain
  deadline, and ends; an SSE stream flushes its outbox and ends. Each pushes its `WS_CLOSE` or
  `SSE_CLOSED` event before it returns, so the task leaves `Tasks.live` and the dispatcher's exit
  rule (section 5.2 step 6) can complete.
- Memory: every outbox adds and removes its queued octets on a per-worker `AtomicU64` in
  `WorkerShared`, which `HostHandler::leased_bytes` adds to the core's budget, so slow readers
  pause accepts like buffered bodies do. A send is refused with `Limit` when its connection's
  queue would pass four times the high-water mark, or when the worker's outbox total would pass
  `REQUEST_MEMORY_PER_CORE` (256 MiB), whichever comes first. Room broadcasts do not pass through
  outboxes: they keep zero-realtime's per-member inbox of 16 MiB, which on overflow drops its
  frames and closes that member with 1013 Try Again Later (`rooms.rs:10-13, 48-68`).
- zero-host's connection table is per worker index and permanent: a fixed spine of set-once chunks
  of `ConnEntry { word: AtomicU64 (open or closed plus generation), outbox: Mutex<Option<Arc<Outbox>>> }`
  with a `Mutex<VecDeque<u16>>` free list (handshakes are rare, so the lock is off the request
  path). Connection ids use the slot id layout with generations starting at 1, so no id is 0.
  `HostHandler::taken` finds the outbox by the claim token, wraps the connection, and turns each
  inbound occurrence into an `EventRec` for the dispatcher.
- Encoding happens on the host thread inside `zero_ws_send` and `zero_sse_send` with the zero-ws
  and zero-sse encoders, so invalid input is refused before anything is queued. zero-sse's encoder
  already refuses CR and LF in `event` and `id` (its tests at `crates/zero-sse/src/lib.rs:147-159`);
  any rule below that the encoders do not yet enforce (NUL in `id`, the close-code set) is added
  to zero-sse or zero-ws by WP-4, which owns those edits, so the rule holds for every caller of
  the encoder and not only for zero-host:
  - opcode 1 or 2; text payloads valid UTF-8 (RFC 6455 Section 5.6);
  - ping payloads at most 125 octets and close reasons at most 123 octets of UTF-8, because "All
    control frames MUST have a payload length of 125 bytes or less" and the close body starts with
    a 2-byte status code (Sections 5.5 and 5.5.1);
  - close codes 1000 to 1003, 1007 to 1009, 1011 to 1013 and 3000 to 4999 only: 1004, 1005, 1006
    and 1015 "MUST NOT be set as a status code in a Close control frame by an endpoint", 1010 is
    sent by a client, the rest of 1000 to 2999 is reserved (Sections 7.4.1 and 7.4.2), and 1011,
    1012 and 1013 are assigned in the IANA WebSocket Close Code Number Registry (design-copy-out,
    fetched 2026-10-02);
  - SSE `event` and `id` without CR or LF, `id` without NUL (WHATWG HTML 9.2.5 `name-char` and
    `any-char` exclude CR and LF; 9.2.6 ignores an `id` containing U+0000); `data` and comment
    text split at CR, LF and CRLF into one line each; `retry` written from an integer, so it is
    ASCII digits by construction.
- `zero_ws_writable` and `zero_sse_writable` are false once the outbox passes its high-water mark
  (16 MiB, the rooms inbox limit) or the worker's outbox total passes half the per-core budget;
  sends still queue up to the limits of the memory rule above and then return `Limit`;
  `*_buffered` reports queued octets (the 1.x `bufferedAmount`).
- Rooms are per server (`Arc<Rooms>` in the server record). Join and leave are outbox commands
  applied by the connection task (membership is connection-owned in zero-realtime), so they take
  effect in order with that connection's sends. `zero_room_broadcast` calls `Rooms::broadcast_*`
  directly from the host thread (`&self`, thread-safe, `rooms.rs:156-173`) and skips
  `except_conn` (`ZERO_NONE` for none), which every 1.x `broadcast` and `toRoom` call needs.

### 6.9 Lifecycle, routes and policies

Registration takes one UTF-8 JSON document per route, policy or server, parsed with zero-json's
strict parser into a typed Rust struct. An unknown key is `Codec` with the key named, so a typo
never falls back to a default. Registration is the cold path; documents keep the ABI to one
function per concept and let options grow without changing a struct layout.

| Kind | Keys at release 1 |
| --- | --- |
| `ROUTE_HOST` | `maxBody` |
| `ROUTE_STATIC` | `root`, `index` (string or false), `maxAgeMs`, `dotfiles` (`ignore`, `deny`, `allow`), `extensions`, `fallthrough`, `etag`, `ranges` |
| `ROUTE_REDIRECT` | `status` (301, 302, 303, 307, 308), `location` |
| `ROUTE_FIXED` | `status`, `contentType`, `body` or `bodyBase64` |
| `ROUTE_WEBSOCKET` | `protocols`, `origins` (array or null), `maxPayload`, `pingIntervalMs` |
| `ROUTE_HEALTH` | `status`, `body` |
| `POLICY_CORS` | `origins` (`"*"` or an array whose entries are exact origins or, with WP-7, `.suffix` entries), `methods`, `headers`, `expose`, `credentials`, `maxAge` |
| `POLICY_SECURITY_HEADERS` | `fields`: name and value pairs (the facade turns `helmet(opts)` into fields; validated once here) |
| `POLICY_REQUEST_ID` | `header`, `trustIncoming`, `version` (4 or 7) |
| `POLICY_TRUST_PROXY` | `cidrs` |
| `POLICY_BODY_LIMIT` | `max` |
| `zero_server_new` | `host`, `port`, `threads` (0 for the smaller of available parallelism and the free worker indexes, at least 1; an explicit value above the free indexes is `Limit`), `drainMs`, `retryAfterSecs` (1), `drainRetryAfterSecs` (5), `maxResponseBody`, `maxBatchSize` (1 to 256), `maxBatchesInFlight` (1 to 8, default 4), `maxQueuedBatches` (16), `server`, `trailers` (allow list), `errorShape` (`problem` or `legacy`), `limits` (`maxBody`, `requestTotalMs`, which is the lease timeout, and the HTTP/1.1 limits) |
| `zero_server_tls` | `alpn`, `minVersion`, `maxVersion`, `requireEms`, `names` (DESIGN 6.7 names) |

`zero_server_tls` takes the certificate chain and the key as separate byte ranges, never inside
JSON: the key is copied into `zero_server_crypto::SecretBytes` (a `Zeroizing<Box<[u8]>>` allocated
at final size, DESIGN 10.5) and passed to `zero_tls::Identity::from_pem`, and the secret is dropped
(zeroized) after the identity is built.

The canonical table (`zero_app_table`) serializes every route as `(kind, method, normalized
pattern, route id, canonical options)` sorted by pattern then method, then policies in
registration order, then mounts. `zero_server_check_table` compares bytes and, on a difference,
names the first differing route in the last error. Byte equality replaces DESIGN 8.5's hash: it is
exact, needs no digest, and names the culprit. Route ids are dense, in registration order.

Lifecycle: `zero_server_new` claims `threads` worker indexes and builds per-worker state without
binding, so targets attach before traffic; `zero_server_start` binds and starts (zero-http `serve`
or `serve_with` for TLS) and returns once listening; `zero_server_shutdown` requests the drain and
returns at once; the reaper thread joins the workers, detaches targets and marks the server
stopped; `zero_server_wait` blocks until then; `zero_server_free` releases the id (refused while
running). The core installs no signal handlers (DESIGN 8.4).

### 6.10 Pull targets and the batch descriptor

`zero_target_attach(server, worker, &target)` registers a `PullTarget` for one worker index (from
`zero_server_workers`) or for every worker of the server (`ZERO_ALL_WORKERS`); a worker has at most
one target. `zero_target_poll`:

1. refuses an I/O worker thread (zero-rt sets a thread-local flag in each worker at start and
   exposes `zero_rt::worker::is_worker_thread()`), and a thread other than the bound one (the
   first poller binds the target and records its thread token in every worker the target serves);
2. waits up to `timeout_ms` on the target's `Condvar` for a `BatchRef`, a wake, a detach or a stop;
3. for a request batch, copies the ids and route ids out of the ring entry into the caller's
   arrays (`BatchRing::read`); for an event batch, drops the previous delivery's payloads, moves
   this batch's payloads into the target's delivery storage (`BatchRing::take_events`, vector
   header swaps) and writes `ZeroEvent` records pointing into it, `event_size` octets apart;
4. writes `ZeroBatch { size, worker, kind, flags, count, epoch }`.

An event-loop host (the release 2 Python facade runs asyncio on its handler thread, DESIGN 8.5)
cannot block in `zero_target_poll`, and a separate polling thread would become the bound thread,
leaving the loop thread without views or acknowledgments. Release 2 therefore adds
`zero_target_wait_handle(target, &handle)`, a readable OS handle (an eventfd on Linux, a pipe on
macOS, an event `HANDLE` on Windows) that the pull target signals when it queues a batch; the
loop thread registers it with its selector and calls `zero_target_poll` with timeout 0 as the
bound thread. Adding an export is compatible under ABI 1 (no existing prototype or struct
changes), so nothing is reserved now; release 1's `test_serve.py` exercises the blocking shape
that sync handler threads and the .NET managed threads use.

Nothing the worker owns escapes, except the request views of O5 and the event views of O11. This
replaces DESIGN 8.2 and 8.5's `[UnmanagedCallersOnly]` dispatch for .NET and the
post-to-handler-thread for Python with the shape those sections describe in prose ("one managed
thread ... that blocks on the worker's batch queue", "fed by one SPSC batch queue per worker"): the
host's dedicated thread blocks inside an ordinary P/Invoke or `ctypes.CDLL` call instead of being
called back. No reverse P/Invoke attach, no GC transition on the dispatch path, no Python thread
state created on a worker, and no foreign exception can unwind into a worker. The cost is one
condition-variable wake per batch, the same order as the libuv wake the Node TSFN pays; it is a
harness cell.

### 6.11 The conformance entry

`zero_conformance_case(section, input, &result)` is stateless and total: it parses with the same
parsers the server uses on untrusted input, so it adds no attack surface the network does not
already present, and a proptest drives arbitrary bytes through every section without a panic.
`input` is one case of `conformance/vectors.json` as JSON; `result` is a canonical JSON document the
runner compares with the case's `expect`.

| Section | Input | Result | Implemented with |
| --- | --- | --- | --- |
| `http1Parser` | `request` (hex) | `head` or `reject` status | zero-http1 `parse_request` with the server's default limits |
| `responseSplitting` | `field`, `value` (hex) | `accepted` | the `zero_res_header` validator |
| `router` | `table`, `method`, `target` | `matched` (id, params, path, query, head) or a miss with status and `Allow` | zero-router |
| `ws` | `handshake`, `frames` or `close` case | accept value, decoded frames, close code, or refusal | zero-ws, zero-server-crypto SHA-1, zero-base64 |
| `sse` | `call` (`event`, `id`, `data`, `retry`, `comment`) | `bytes` (hex) or `rejected` | zero-sse and the section 6.8 rules |
| `qpack` | step 11's case shape | step 11's expect shape | zero-qpack |
| `h3Frames` | step 11's case shape | step 11's expect shape | zero-h3 |

An unknown section is `Unsupported`. The Node binding exposes the same function as
`conformanceCase(section, input)`.

### 6.12 Plugin vtable declaration

Declared now so `zero.h` carries the layout; the loader, hashing and trust model are step 31
(DESIGN 10.8).

```rust
pub type ZeroPluginAbiVersionFn = Option<unsafe extern "C" fn() -> u32>;
pub type ZeroPluginRegisterFn =
    Option<unsafe extern "C" fn(host: *const ZeroHostApi, out: *mut ZeroPluginVTable) -> i32>;

#[repr(C)]
pub struct ZeroPluginVTable {
    pub abi_version: u32,
    pub size: u32,
    pub ctx: *mut c_void,                                                         // opaque to the core
    pub handle: Option<unsafe extern "C" fn(ctx: *mut c_void, route: u32, slot: u64) -> i32>,   // a ZeroStatus value
    pub unload: Option<unsafe extern "C" fn(ctx: *mut c_void)>,
}

#[repr(C)]
pub struct ZeroHostApi {
    pub abi_version: u32,
    pub size: u32,
    pub req_view: Option<unsafe extern "C" fn(slot: u64, out: *mut ZeroRequestView) -> ZeroStatus>,
    pub req_header: Option<unsafe extern "C" fn(slot: u64, name: *const u8, len: usize, nth: u32, out: *mut ZeroBytes) -> ZeroStatus>,
    pub req_body: Option<unsafe extern "C" fn(slot: u64, out: *mut ZeroBytes) -> ZeroStatus>,
    pub res_respond: Option<unsafe extern "C" fn(slot: u64, spec: *const ZeroResponseSpec) -> ZeroStatus>,
    pub res_body_alloc: Option<unsafe extern "C" fn(slot: u64, len: usize, region: *mut *mut u8) -> ZeroStatus>,
    pub res_send: Option<unsafe extern "C" fn(slot: u64) -> ZeroStatus>,
}
```

Rules recorded for step 31: every function pointer is `Option`-wrapped and checked for null
(ANSSI FFI-MARKEDFUNPTR, FFI-CKFUNPTR; `Option<extern "C" fn>` is null-pointer optimized); the
plugin's `int32_t` returns pass a checked conversion (FFI-NOENUM); the plugin functions are plain
`extern "C"`, so a panic in a plugin built against another standard library is a foreign unwind
that must not cross into the core (facts 11): a plugin catches its own panics, and one that does
not aborts at its own boundary, which is defined behavior since Rust 1.81. DESIGN 10.8's "a plugin
that panics is caught at the vtable boundary" is therefore amended. `plugin::validate(&ZeroPluginVTable)`
(safe) refuses a foreign `abi_version`, a `size` below version 1 and a null `handle`; its test is
the release 1 evidence. The plugin's `handle` will run on the worker against a slot the worker
leases to itself, so the same access helpers serve it.

### 6.13 Features

zero-host: `default = ["static", "policy", "realtime", "tls"]`, each gating its dependencies
(`static`: zero-static, zero-mime; `policy`: zero-policy; `realtime`: zero-realtime, zero-ws,
zero-sse; `tls`: zero-tls, zero-server-crypto). zero-ffi forwards each (`static =
["zero-host/static"]`, ...), same default. A disabled capability's route kinds, policies and
functions (`zero_res_file`, the `zero_ws_*`, `zero_sse_*` and `zero_room_*` group,
`zero_res_ws_accept`, `zero_res_sse_open`, `zero_server_tls`) still exist and return
`Unsupported`; the conformance sections of a disabled capability return `Unsupported`. The header is
identical across feature sets, and ci.yml's existing `cargo check -p zero-ffi --no-default-features`
now builds a meaningful core (host, fixed, redirect and health routes).

zero-host also has a non-default `testing` feature that adds `zero_host::testing::run_on_worker`
and `panic_next_call`; without it, the `maybe_panic` hook that `guard` calls is an inlined no-op.
zero-ffi enables the feature only through its dev-dependency on zero-host, so tests reach the hooks
and no shipped build contains them (Cargo's resolver 2 activates dev-dependency features only for
targets that need them), and no export depends on it, so the header is unaffected.

### 6.14 The exact unsafe surface

| Crate | Unsafe | Count |
| --- | --- | --- |
| zero-rt, zero-http, zero-host, zero-realtime | none (`forbid`) | 0 |
| zero-ffi `src/ptr.rs` | eight `unsafe fn` helpers, one operation each: `read_bytes` (`slice::from_raw_parts` after the null-with-length and size checks), `read_slice<T: Copy>` (`slice::from_raw_parts` after the alignment check, for id and route arrays of integers), `read_sized<T: Copy>` (reads `size`, then one `copy_nonoverlapping` of the prefix into a zeroed local), `write_sized<T: Copy>`, `read_element<T: Copy>` and `write_element<T: Copy>` (element `i` of a strided array: one `copy_nonoverlapping` of `min(stride, size_of::<T>())` octets at `base + i * stride`, after the overflow, null and stride checks; header pairs in, events out), `write_out<T: Copy>` (null and `is_aligned` checks, one `ptr::write`), `copy_out<T: Copy>` (one `copy_nonoverlapping`) | 8 blocks |
| zero-ffi `src/handles.rs` | `ZeroString` and `ZeroBuffer` are boxes handed out with `Box::into_raw` (safe); `reclaim` (one `Box::from_raw`, in the two frees) and `peek` (one `&*ptr`, in the data and length accessors) | 2 blocks |
| zero-ffi exports (`src/abi/*.rs`) | each export is `#[allow(unsafe_code)] #[no_mangle]` (the lint fires on the attribute in edition 2021); a pointer-taking export is `pub unsafe extern "C" fn` with a `# Safety` section and one single-operation `unsafe {}` block per pointer parameter, calling one helper and citing O2 to O6 | one per pointer parameter, enumerated by cargo-geiger in SECURITY.md |
| zero-ffi otherwise | no `unsafe impl`, no transmute, no function-pointer call, no dereference of slot memory (view pointers are created safely and never read by Rust) | 0 |
| bindings/node | one block: `ArrayBuffer::from_external` in `src/staging.rs` (section 8.7) | 1 |
| bindings/python/packages/native | none: the existing `CStr::from_ptr` goes away, `version()` reads `zero_ffi::VERSION` | 0 |
| bindings/dotnet | C# `unsafe` for spans over views and regions, and every `[SuppressGCTransition]` site, listed in SECURITY.md | per DESIGN 10.1 |

### 6.15 cbindgen, the header and layout checks

- `cbindgen.toml`: `item_types = ["constants", "enums", "structs", "typedefs", "opaque",
  "functions"]` (`typedefs` is accepted by cbindgen 0.29.4 and needed for the plugin function
  pointer typedefs); `[export] include = ["ZeroPluginVTable", "ZeroHostApi",
  "ZeroPluginAbiVersionFn", "ZeroPluginRegisterFn"]` because no export reaches them; `parse_deps =
  false` stays (every ABI type is declared in zero-ffi); `[enum] prefix_with_name = true` stays.
- `build.rs` keeps writing `include/zero.h` only when bytes differ, and turns a cbindgen failure
  into a build error when `ZERO_FFI_HEADER_STRICT` is set (ci.yml sets it); without it, the
  warning stays, so a registry checkout never fails to build.
- `src/abi/layout.rs`: compile-time `const _: () = assert!(...)` on `size_of`, `align_of` and
  `offset_of!` (stable since 1.77; rust-version 1.89) of every ABI struct, and equality of
  `ZeroField`/`ZeroSpan` with `zero_http::HostField`/`HostSpan`. A compile-time check runs on every
  target that builds the crate, including the seven release targets, which is the per-target layout
  test. The .NET smoke asserts `Marshal.SizeOf` and `Marshal.OffsetOf` against the same numbers.
- `tests/header.rs`: `ZERO_ABI_VERSION` equals `zero_abi_version()`; every type in a prototype is a
  C integer, `uintptr_t`, a `Zero*` struct, enum or opaque declared in the header, a pointer to one
  of those, or a function pointer typedef (ANSSI FFI-CTYPE); no prototype names a Rust-only type.
- Drift: ci.yml's `rust` job runs `cargo build -p zero-ffi` then
  `git diff --exit-code -- crates/zero-ffi/include/zero.h` (today only dotnet.yml checks it).
- Mirror: `cargo xtask ffi-mirror` generates
  `bindings/dotnet/src/ZeroServer.Native/Interop/NativeMethods.g.cs` from `zero.h` (`uint64_t` to
  `ulong`, `uintptr_t` to `nuint`, pointers to typed pointers, `ZeroStatus` to the C# enum, structs
  to `[StructLayout(LayoutKind.Sequential)]`); `--check` diffs it.

### 6.16 The table-driven test over the header

`crates/zero-ffi/tests/abi_table.rs`:

1. Parses `include/zero.h` with a small line parser (every prototype, its parameter names and C
   types) and fails if any prototype has no entry in `CASES`, so a new export without cases fails
   CI.
2. Starts one real server through the C ABI (`zero_app_new`, a host route `GET /t/:p`, a WebSocket
   route, `zero_server_new` with one thread, a pull target, `zero_server_start`), sends one request
   over a `std::net::TcpStream`, and polls the batch on a test thread, which holds a genuinely leased
   slot. It derives `stale` (same worker and index, generation + 1, and a slot completed and
   recycled), `foreign` (an unclaimed worker index), `wide` (2^53), `closed` (a lease closed by
   dropping its connection).
3. For each function, every case that applies: each pointer parameter NULL in turn (with nonzero
   length for a range), a misaligned output, a struct `size` below version 1, each id as `stale`,
   `foreign`, `wide`, `closed`; each closed-set integer at its first invalid values (method 9 to
   253, opcode 0 and 3, header mode 2, header id 49, status 99, 199 and 600, close codes 999, 1004,
   1005, 1006, 1010, 1015, 2999, 5000); each index at its count; an SSE id with NUL, CR and LF; a
   ping of 126 octets; a view call from a thread with no pin outside the window; `body_alloc`
   without a pin; body writes and reset while staged; an epoch out of order and an epoch from
   another thread (asserting that the ids listed in that call were still completed); a poll from a
   second thread and (through `zero_host::testing::run_on_worker`, section 6.13) from a worker
   thread; `zero_server_wait` from the target's bound thread; an element size below version 1 for
   `field_size` and `event_size`. Expected statuses come from section 6.2. Valid calls on the live
   slot are the positive controls. The six owned-handle functions of O7 take the NULL cases only:
   their stale column is marked not applicable in `CASES` with the O7 reference, and the R.3 row 12
   exit wording is amended to say so (section 13 item 15).
4. Completes the slot, reads the HTTP response, checks it, shuts the server down, waits, frees.
5. Panic injection: `zero_host::testing::panic_next_call` makes the next `guard` on this thread
   panic inside `catch_unwind`; the test asserts `Panic`, that the next call on the same thread
   works, and that no pin leaked.

The pointer helper tests run under Miri (Miri cannot run sockets, so they are separate unit tests);
the whole file runs under ASan and TSan in the sanitizer job.

### 6.17 Against the DESIGN 8.1 list

| DESIGN 8.1 | Here | Reason |
| --- | --- | --- |
| `zero_server_start` | `zero_server_new` then `zero_server_start` | targets attach and the identical-table check runs before the first byte is read |
| a CAS borrow per accessor | lock-then-check, or the published view at no RMW | section 4.3; the same or lower cost, no unsafe |
| `zero_batch_complete` moves each slot to `Completing` | the seal happens inside the lock; the worker moves the word | section 4.6; hosts never change state (I1) |
| `zero_req_body_retain` alias of the copy in Node | an owned `ZeroBuffer` for C hosts; Node copies in its own call | |
| `zero_req_claim` | exported, `Unsupported` until step 19 | the name is in the header from release 1 |
| `zero_res_body_copy` under 64 KiB | no ABI cap | section 6.7 |
| `zero_res_body_transfer(slot, ptr, len, release_fn)` | release 2, with the release delivered as an event | the `release_fn` would otherwise run on an I/O worker (DESIGN 5.1) |
| `zero_res_header(slot, name, value)` | adds `mode` (set or append) | RFC 9110 Section 5.3, `Set-Cookie` as separate field lines |
| `zero_res_ws_accept(slot)` | adds the chosen subprotocol | RFC 6455 Section 4.2.2 |
| `zero_res_sse_open(slot)` | adds the keep-alive interval | the 1.x `keepAlive` option |
| `zero_ws_ping(conn)` | adds the payload, plus `zero_ws_terminate`, `*_buffered` | 1.x `ping(payload)`, `terminate()`, `bufferedAmount` (map-node-api) |
| `zero_sse_send(conn, event, id, data)` | plus `zero_sse_comment`, `zero_sse_retry` | 1.x `comment`, `retry` |
| `zero_room_broadcast(room, opcode, ptr, len)` | adds `server`, `except_conn`, `delivered_out` | rooms are per server; every 1.x broadcast takes an exclusion |
| `[UnmanagedCallersOnly]` dispatch, a post to the Python thread | pull targets | section 6.10 |
| "unwinding across extern C is undefined behavior" | a panic aborts at a non-unwinding boundary since 1.81; `catch_unwind` stays to return `Panic` | facts 11 |
| (absent) | `zero_res_respond`, `zero_req_view`, `zero_field_validate`, `zero_header_name`, `zero_header_id`, `zero_conformance_case`, `zero_slot_pin`, `zero_slot_unpin` | the budgets, the conformance runners, the view rule |

## 7. (e) The loom models and the ThreadSanitizer tests

### 7.1 loom (zero-rt, `cfg(zero_loom)`)

Setup: `[target.'cfg(zero_loom)'.dev-dependencies] loom = "=0.7.2"` in `crates/zero-rt/Cargo.toml`
(the registry's stable line on 2026-10-01, already in `Cargo.lock` and exempted in
`supply-chain/config.toml`); `unexpected_cfgs = { level = "warn", check-cfg = ['cfg(zero_loom)'] }`
in `[workspace.lints.rust]` and `docs/lints/workspace.toml`, with `xtask lints` changed so its
`flatten` keeps `check-cfg` and the copies are diffed (map-abi-state section 7). Only zero-rt uses
the cfg, and it inherits the workspace table, so the audited tables do not change.

Adoption record (RULES currency rule; written as a comment beside the dependency with the check
date and a recheck date): loom 0.7.2 is a `0.x` line with no release since 2024-04-23, so it fails
the 12-month and stable-line conditions as written. It is accepted because it is a test-only
dev-dependency behind a cfg that no build of a shipped artifact sets, `deny.toml` has
`exclude-dev = true`, DESIGN 7.3 and 10.3 name loom as the model checker, no maintained
alternative for the C11 memory model exists in the allowlist (loom implements CDSChecker's
techniques, facts 9), RustSec has no entry for it (facts 1), and the advisory status of its own
dependencies (generator, scoped-tls, tracing, tracing-subscriber) is checked with `cargo deny`
when the job lands (unverified today).

The models live in `crates/zero-rt/src/loom_tests.rs` (`#[cfg(all(test, zero_loom))]`) and run the
real `SlotWord`, `Slot<T>`, `Intake`, `Allocator` and the dispatcher's publish step compiled over
loom's atomics and `Mutex`. The test payload is `TestPayload { tag: u64, appended: Vec<u64> }`
behind the real lock, and its `View` holds two loom `AtomicU64`s: `tag`, and `buffer`, which
export sets to the request's tag and `Payload::release` overwrites with a poison value (the
stand-in for the clear and shrink that gives back the memory a C view points at). A read of
`buffer` after an accessor has returned is the stand-in for a host dereferencing a view pointer.
So loom sees every payload access, and the `UnsafeCell` limitation of facts 9 does not arise,
because no unsafe code exists to model. A `ModelTarget` posts by pushing the `BatchRef` into a
loom `Mutex<VecDeque>` that the bound host thread pops, the shape of both real targets. Each model
uses `model::Builder` with `preemption_bound = Some(3)` and at most four modeled threads
(`MAX_THREADS` is 5). In every model, acknowledgments come only from the host thread bound to the
target (invariant I9); the worker never stores `acked` itself.

| Model | Threads | Property asserted |
| --- | --- | --- |
| `loom_stale_id_never_reads_another_request` | worker (export tag A at generation 0, hold, lease, publish and post epoch 1, wait for the seal and the ack, `begin_import`, retire with stamp 1, release, allocate generation 1, export tag B, lease); bound host (pops the batch, `with_write(0)` seals and completes with epoch 1); late reader (`with_read(0)` and `read_view(0)` twice, then `pin(0)`, read, `unpin(0)`) | every `Ok` under generation 0, through the lock or the view, returns tag A; no read returns tag B; `retire` never succeeds while the pin is held (the step 12 exit statement) |
| `loom_view_after_return_stays_frozen_until_ack` | worker (as above, then drains the intake, releases the quarantine and re-exports tag B as soon as it can); bound host (pops the batch, `read_view(0)` returns `Ok`, then reads `buffer` again after the call returned, then seals and completes with epoch 1) | the read after return sees tag A, never poison or tag B: the index cannot be released before the host's acknowledgment (the exit statement for the C view path) |
| `loom_pinned_view_stays_frozen_until_unpin` | worker (as above); bound host (seals and acknowledges at once); an unbound thread (`pin(0)`, `read_view(0)`, read `buffer` after return, `unpin(0)`) | while the pin is held the read after return sees tag A; once the bound host acknowledged, only the pin keeps the index out of reuse |
| `loom_ack_before_post_returns` | worker (publish and post epoch 1, then return from `post`); bound host (pops the batch and completes with epoch 1 at once) | the acknowledgment is accepted in every interleaving, `acked == 1` after the worker's next drain, and the batch's completion is applied; with `published` stored after the post (the order section 4.5 rejects) the model fails |
| `loom_view_never_mixes_generations` | worker re-exporting generation 0 then 1 with distinct tags in two view atomics; reader looping `read_view(0)` with `yield_now` | an `Ok` snapshot holds tag A in both atomics |
| `loom_close_and_seal_race_once` | worker (`close_leased(0)` as the guard drop); host (`with_write(0)` seal); reader | the slot is retired exactly once; a write after the close returns `Closed`; the reader's `Ok` results are tag A |
| `loom_response_writes_are_serialized` | two host writers appending under `with_write(0)`; worker (`begin_import`, `with_worker`) | the worker observes each append whole, in some order |
| `loom_intake_loses_no_completion` | two hosts posting disjoint ids, the bound one acknowledging epochs 1 then 2 after the worker published them; worker draining twice | the union arrives without duplicates, `acked == 2`, the waker is woken after the last post; a refused acknowledgment (epoch 3) still delivers its ids |
| `loom_epoch_gate_holds_reuse` | host acknowledging in order; worker retiring with stamp 2 and allocating in a bounded loop | the index is not handed out while `acked < 2` and is once `acked >= 2` |
| `loom_pin_blocks_retire` | pinning thread; worker retiring | `retire` succeeds only with readers 0; a pin after the retire returns `Closed` |

Run: `RUSTFLAGS="--cfg zero_loom" LOOM_MAX_PREEMPTIONS=3 cargo test -p zero-rt --release --lib loom_`.
CI: a `loom` job in ci.yml on ubuntu with the stable toolchain. Every other zero-rt test is
skipped by the `loom_` filter, since loom types panic outside a model.

### 7.2 ThreadSanitizer

- `crates/zero-rt/tests/slot_recycle_word.rs`, `#[ignore]`, `slot_recycle_word_race`: plain threads
  over one `Slot<TestPayload>`; a worker thread exports, leases, imports and retires 100,000 times
  against two readers (`with_read`, `read_view`, `pin` and `unpin`) and a completer
  (`with_write` seal); every `Ok` read carries the tag of its generation.
- `crates/zero-host/tests/slot_recycle.rs`, `#[ignore]`,
  `slot_recycle_late_readers_race_retire_with_tier0_and_tier3_on_one_core`: one server with
  `threads: 1`, `GET /t0` (fixed body, tier 0) and `GET /t3/:n` (host). A `TestTarget` forwards each
  batch to host thread H1, which reads the parameter and an `x-nonce` header through the access
  helpers, responds `n=<p>;nonce=<v>`, and acknowledges; every seventh slot is handed to H2, which
  responds and completes it later with `ZERO_EPOCH_NONE` (cross-thread, async). H3 keeps the last
  512 ids it saw and loops over them with `with_read`, pins, pinned views and unpins, accepting
  `Closed` and checking that any `Ok` read returns the nonce recorded for that id. Four client
  threads send 2,000 requests each over keep-alive connections, alternating `/t0` and `/t3/<i>`
  with random nonces and pipelining in pairs, and drop one connection in ten mid-request to drive
  cancellation and orphans. No sleeps: every wait is on a response, a channel or a join.
  Assertions: every `/t3` body carries its own `n` and nonce; every `/t0` body is the fixed body;
  no panic reached the status sink; after shutdown every arena reports zero live slots; the
  `late_readers` counter is reported.
- `crates/zero-ffi/tests/slot_recycle_c_abi.rs`, `#[ignore]`,
  `slot_recycle_c_abi_views_race_reuse_through_the_exports`: the same traffic through the C
  exports, with a pull target thread reading `zero_req_view` and echoing an `x-seq` header through
  `zero_res_respond`, and a second thread pinning, reading and unpinning replayed ids, accepting
  `Closed` or the recorded value.
- CI (`sanitizers` job, Linux only, since TSan does not support Windows targets, facts 13): the race
  step becomes `RUSTFLAGS=-Zsanitizer=thread RUSTDOCFLAGS=-Zsanitizer=thread cargo +nightly test
  -Zbuild-std --target x86_64-unknown-linux-gnu -p zero-rt -p zero-host -p zero-ffi --
  --include-ignored slot_recycle 2>&1 | tee race.log` and fails unless `race.log` reports three
  `slot_recycle` tests `ok`, because cargo exits 0 when a filter matches nothing (map-runtime
  defect 7). The ASan matrix entry runs the same. The nightly date to pin is fetched when the step
  lands (unverified today, facts 15). Nothing in the protocol uses a fence. If TSan reports inside
  tokio, a suppression scoped to tokio paths is added and recorded, never a blanket suppression.

## 8. (f) The Node binding

### 8.1 Decision: the napi cdylib calls zero-host, not zero-ffi's C exports

1. Calling zero-ffi's `extern "C"` functions from Rust needs an `unsafe` block per call (raw
   pointers in and out) and would hand Node raw views; calling `zero_host::access` is safe Rust with
   lifetimes the compiler checks, and Node copies every value inside the lock.
2. One semantic layer: zero-ffi is a thin shim over the same zero-host functions, so Node and C
   hosts get identical validation, lifecycle and dispatch by construction, and the conformance
   vectors exercise the same code in every binding.
3. The binding links the core statically either way (as today, through an rlib), so the C exports
   buy no shared-library benefit, and a separately loaded `libzero_ffi` would have its own
   registry anyway.
4. Errors stay typed until the one place they become a JavaScript value.

The C exports are covered by the header table test, the C-path TSan test, the .NET smoke and the
Python ctypes smoke.

### 8.2 Crate configuration

- `bindings/node/Cargo.toml` depends on `zero-host` (path, default features) instead of
  `zero-ffi`; `napi = { version = "3", default-features = false, features = ["napi7"] }`:
  `napi7` for `ArrayBuffer::detach` and `is_detached` (facts 3), and it enables `napi6`, the TSFN
  (Node-API 4) and cleanup hooks (Node-API 3). Node-API 7 is in "v10.23.0+, v12.19.0+, v14.12.0+,
  15.0.0 and all later versions" (facts 7), so every supported line has it. No `tokio_rt`.
- The first commit of WP-10 moves the binding lockfile from napi 3.13.0, napi-derive 3.6.9,
  napi-build 2.5.0, napi-sys 3.3.2 to the registry's stable line (3.14.0, 3.6.10, 2.6.0, 3.4.0 on
  2026-10-01; re-fetched on the day of the commit), links the napi and napi-derive changelog
  entries, records that none was found for napi-build 2.6.0 and napi-sys 3.4.0 (facts 1), and
  re-measures `deny/node.toml`. Every napi API this design names was read at 3.14.0.
- `[profile.release]` mirrors the workspace (`lto = "fat"`, `codegen-units = 1`,
  `overflow-checks = true`, `panic = "unwind"`, `strip = "symbols"`), since the binding is its own
  workspace (map-abi-state section 3).
- Every `#[napi]` body runs inside `node_guard` (`catch_unwind`, a panic becomes a JavaScript
  `Error` with `code = 'ZERO_PANIC'`), because napi-rs documents no catch option for `#[napi]`
  (design-lease-record section 1); a non-`Ok` access result becomes an `Error` with
  `code = 'ZERO_<STATUS>'` and the last-error message. The TSFN callback is the exception: napi
  3.14.0 hands an `Err` returned by that closure to `napi_fatal_exception` (section 1), so its body
  runs under `catch_unwind` and maps every failure and every panic to a value, never to `Err`
  (section 8.4).
- Ids arrive as JavaScript numbers and are accepted only when finite, integral and between 0 and
  2^53 - 1 (pamoja's `Whole<T>` checker, DESIGN 8.5), else `ZERO_INVALID_ARGUMENT`.
- Modules: `lib.rs`, `app.rs`, `server.rs` (new, tls, check, start, address, shutdown, `wait`
  resolved by a one-shot ThreadsafeFunction, section 8.4), `target.rs` (`TsfnTarget`, attach,
  detach, cleanup hook), `request.rs`, `response.rs`, `staging.rs`, `realtime.rs`,
  `conformance.rs`, `ids.rs`, `guard.rs`, `status.rs`.

### 8.3 Isolates pinned to workers

- `threads` comes from `createApp({ threads })`, then `listen({ threads })`, then
  `ZERO_SERVER_THREADS`, defaulting to `os.availableParallelism()` (DESIGN 8.5). The default is
  passed to `serverNew` as 0, which takes the smaller of available parallelism and the free worker
  indexes (128 per process, fewer when another server holds some), and the facade spawns
  `serverWorkers(server).length` isolates; only an explicit value above the free indexes is
  refused. Inline mode applies
  when `threads === 1`, when `isolates: 'inline'` or `ZERO_SERVER_ISOLATES=inline` is set, or when
  the caller already runs inside a `worker_threads` worker the facade did not create. The legacy
  runner and apps that share module state use inline mode (map-node-api D7, map-legacy-tests H3).
- Pool mode, main isolate: builds the app and its native app (`appNew`, `appRoute`, ...),
  `serverNew(app, options)`, then spawns `threads` workers with
  `new Worker(entry, { workerData: { zeroServer: { server, worker: k } }, argv: process.argv.slice(2) })`.
  `entry` is `require.main.filename` under CommonJS, else the absolute `process.argv[1]` (under an ES
  module entry `require.main` is undefined, and worker_threads accepts an absolute path, a `./` or
  `../` path, or a `file:` or `data:` URL, design-lease-record section 1), else the `entry` listen
  option; with none, `listen` rejects with an error naming `threads: 1` and `entry`. It waits for
  every worker's `ready` message (or its error), calls `serverStart`, reads the address, and emits
  `'listening'` and runs the callback once. It runs no handlers in pool mode.
- Pool mode, a worker isolate that exits while the server runs (an uncaught exception, an
  out-of-memory, `process.exit` in a worker): its cleanup hook detached its target, so its leased
  requests were answered 503 and that core answers tier 3 with 503 while it has no target. The main
  isolate listens for the worker's `'exit'` and, unless the server is closing, spawns a
  replacement with the same `workerData`; the replacement runs the identical-table check and
  attaches to the same worker index. At most 5 replacements per worker index in any 60 s (a
  judgment); past that, the server object emits `'error'` naming the index and leaves that core
  without a target. With no `'error'` listener Node's `EventEmitter` throws, which ends the process
  (Node's own convention for unhandled `'error'`); with a listener the application decides, for
  example by calling `close()`. A silent partial outage is never the default.
- Pool mode, worker isolate: the module runs again and reaches `app.listen`, which sees
  `workerData.zeroServer`, builds its own handler table keyed by route id, calls
  `serverCheckTable(server, app)` (the first differing route is named in the thrown error), then
  `targetAttach(server, [serverWorkers(server)[k]], dispatch)` (the k-th global worker index of the
  server), and posts `ready`. It never binds and never runs the user's listen callback.
- Inline mode: the calling isolate attaches to every worker of the server with one TSFN per worker
  (each bounded at 8, with `maxBatchesInFlight` in flight). Several apps per process each get
  their own server and worker indexes.
- Per-isolate native state is a `thread_local!` in the binding (worker_threads are OS threads, one
  environment each) plus a module-level object in the facade, never `napi_set_instance_data`,
  whose `get_instance_data` hands out an aliasing `&'static mut` on each call (facts 3).
  `env.add_env_cleanup_hook` (Node-API 3, safe) detaches the isolate's targets when its environment
  is torn down without closing (`worker.terminate()`, a crash). The hook's data is the target ids
  only, never an `Arc<TsfnTarget>`, so the hook cannot keep the strong function alive after a
  close; `targetDetach` removes the hook with `remove_env_cleanup_hook` and the `CleanupEnvHook`
  handle it kept (both in napi 3.14.0, facts 3), so a closed target leaves no hook behind.
- Signals: `SIGTERM` and `SIGINT` handlers are installed on the main thread only, since "Signals are
  not delivered through process.on('...')" in workers (facts 8); they call `app.shutdown()`, and the
  lifecycle exits explicitly after draining (rows `runtime-01` and `runtime-07`).
- `port: 0` gives one ephemeral port shared by every per-core listener: zero-io binds the first
  listener and binds the others to its address (`crates/zero-io/src/tokio_rt/worker.rs`, read
  2026-10-02).

### 8.4 One bounded ThreadsafeFunction per attached worker

```rust
let tsfn = dispatch
    .build_threadsafe_function::<BatchRef>()
    .callee_handled::<false>()
    .max_queue_size::<8>()                                  // == the maxBatchesInFlight ceiling
    .build_callback(move |ctx| Ok(deliver(&ctx.env, &shared, ctx.value)))?;   // never Err (below)
zero_host::attach(server, worker, Arc::new(TsfnTarget { tsfn }))?;

/// Turns one delivery into the dispatch arguments. It never fails: napi 3.14.0 passes an `Err`
/// returned by the callback closure to `napi_fatal_exception`, which raises `'uncaughtException'`
/// and ends the isolate unless the application handles it (section 1).
fn deliver(env: &Env, shared: &WorkerShared, batch: BatchRef) -> DispatchArgs {
    match catch_unwind(AssertUnwindSafe(|| arguments(env, shared, batch))) {
        Ok(Ok(args)) => args,
        Ok(Err(Delivery::Stale)) => {
            // The entry no longer holds this epoch: the target was detached (its slots were closed
            // and `acked` set to `published`), or a newer server reuses the index. Nothing to run
            // and nothing to acknowledge.
            shared.counters.stale_delivery();
            DispatchArgs::skip(batch)
        }
        Ok(Err(Delivery::Failed(_))) | Err(_) => {
            // The entry is live but could not be handed to JavaScript (allocation failure, a
            // panic). Answer it in Rust so neither the requests nor the acknowledgment order stall.
            let _ = catch_unwind(AssertUnwindSafe(|| zero_host::abandon_batch(shared, batch)));
            DispatchArgs::skip(batch)
        }
    }
}

fn arguments(env: &Env, shared: &WorkerShared, batch: BatchRef) -> Result<DispatchArgs, Delivery> {
    match batch.kind {
        KIND_REQUESTS => {
            let mut records = [0u8; 16 * 256];             // f64 id, u32 route, u32 reserved, little-endian
            let len = shared.ring.read(batch, |ids, routes| encode(ids, routes, &mut records))
                .map_err(|_| Delivery::Stale)?;
            let buffer = BufferSlice::copy_from(env, &records[..len]).map_err(Delivery::Failed)?;   // a real copy (facts 4)
            Ok(DispatchArgs::requests(batch, buffer))
        }
        _ => Ok(DispatchArgs::events(batch, events_to_js(env, &shared.ring, batch)?)),
    }
}
```

(Assembled from the napi 3.14.0 signatures in facts 2 and not compiled; WP-10 compiles it first.)
`zero_host::abandon_batch` runs on the target's bound thread: for a request batch it writes 500
with code `DISPATCH_FAILED` in the server's shape into every listed slot that is still leased and
unsealed, seals it, completes the ids and acknowledges the epoch; for an event batch it drops the
events and acknowledges. It counts `abandoned_batches` and reports a `DispatchFailed` status event.
`DispatchArgs::skip` passes `records = null` and `events = null`; the facade's dispatch function
returns at once for it and does not acknowledge. Every value in `DispatchArgs` is a number, `null`
or a napi value already created inside `arguments`, so nothing fallible remains after the closure
returns. A test detaches a target with batches still queued in Node's queue (`targetDetach`, then
`app.close()`) and asserts the isolate survives, every queued delivery is skipped, and the next
server in the same isolate serves (`runtime-24`'s file); a test hook makes `arguments` fail once
and asserts the 500 answers and that the next batch is delivered.
The callback runs on the isolate thread with the isolate's `Env` (`ThreadsafeCallContext { env,
value }`, design-copy-out section 1). One `Buffer` per batch, never per request; the epoch crosses
as a JavaScript number, exact below 2^53. Event payloads become a `Buffer` copy (binary) or a
string (text, close reasons). `ArrayBuffer::copy_from` and the typed-array `copy_from`
constructors are never used, because they do not copy (facts 4). `TsfnTarget::post` calls
`tsfn.call(batch, ThreadsafeFunctionCallMode::NonBlocking)` and maps `Ok`, `QueueFull` and
`Closing` to `Taken`, `Full` and `Gone`. With `CalleeHandled = false` a throw from the JavaScript
callback goes to `napi_fatal_exception` (facts 2), so the facade's dispatch function wraps its
whole body in try/catch and never throws. The TSFN is strong, which keeps the isolate's event loop
alive while it serves; detach, server stop and the cleanup hook drop zero-host's `Arc<TsfnTarget>`,
whose last drop releases the function (`impl Drop for ThreadsafeFunctionHandle`, facts 2), so the
isolate can exit. No `unref`, no raw handle, and never the deprecated
`Env::create_threadsafe_function`, which ignores its queue size. Items queued at teardown are leaked
by napi without `Drop`; they are `Copy` integers, and the cleanup hook's detach releases their
slots. `targetAttach` runs on the isolate thread and records it as the target's bound thread, so the
isolate's `batchComplete` acknowledgments pass the rule of section 4.5.

`serverOnStatus` builds a second ThreadsafeFunction, weak (so it never keeps the loop alive),
bounded at 16 and called `NonBlocking` from the core's status sink on core threads. napi 3.14.0
leaks the boxed payload of every call that does not return `napi_ok` (facts 2), and `TaskPanic` can
be triggered per request, so the status function never reaches `QueueFull`: an `AtomicU32` counts
calls in Node's queue (incremented before `call`, decremented first thing in the callback and on a
non-`Ok` return), and an event that would make it 17 is dropped before any call and counted in
`status_dropped`. The payload is a `Copy` `StatusRef { kind: u8, core: u8, seq: u64 }`; the
message text sits in a per-server ring of the last 64 status details in Rust, which the callback
reads by `seq` on the isolate thread to build `(event, core, detail)` (a detail already overwritten
reads as an empty string). A TSFN call is a Node-API queue push, not JavaScript, so no host code
runs on a core thread. The callback follows the dispatch callback's rule: it never returns `Err`.

`serverWait(server)` returns a Promise without occupying a libuv pool thread (the pool has 4
threads by default and also serves `dns.lookup()`, `fs`, `crypto` and `zlib`; section 1): it builds
a one-shot ThreadsafeFunction, strong so the loop stays alive until the server has stopped,
bounded at 1, and registers a stop listener with zero-host whose single `call` (from the reaper
thread, never an I/O worker) resolves the Promise in the callback; the call drops the listener's
`Arc`, which releases the function. A server already stopped resolves at once. Closing several
apps without awaiting them therefore holds no pool thread at all.

### 8.5 Request and response objects

`req` and `res` are plain JavaScript objects created per request (`new Request(slot, route, app)`,
`new Response(slot, req)`) that hold the slot id and memoize what they read. They own no native
resource and have no finalizer, so they do not pay the 826 ns finalizable-object cost DESIGN 8.3
measured. They are not pooled: a pooled object captured by an async closure would later read
another request's data and user properties (`req.user`) through a recycled object holding a fresh
valid id, which no generation check can catch, and JavaScript cannot detect that a reference
escaped. Pooled per isolate: the batch record buffer, the completion `Float64Array`, the header-name
table (id to lowercase name, built once with `headerName`), the per-route parameter-name arrays and
the handler chain arrays. If the harness shows the per-request objects over their cell, the remedy
is pooling the memo arrays inside them, not the objects.

Lifetime: every terminal writer seals the response natively and appends the id and its object
pair to the completion buffer; the flush then sets `finished` on both. Until the flush the slot is
still leased, so code that reads `req` after `res.json` in the same handler or tick reads live
values, and the completion hook (`logger`'s finish, lifecycle tracking) runs before the flush. A
finished object never passes its id to native again: reads answer from the memo, and a field never
read before the flush reads as `undefined`. Native would refuse the id anyway; the flag closes the
logical hazard of a retained object meeting a reused index after the generation wraps, and saves a
crossing that can only fail. Reading a field that was never read before the flush is not silent:
the getter returns `undefined` and emits `process.emitWarning` once per field name and isolate
(code `ZERO_REQUEST_FINISHED`, naming the field and saying to read it before the response is
sent). It does not throw, because a throw from a timer or a detached async continuation would
end the process under Node's default handling of uncaught exceptions and unhandled rejections,
and snapshotting the head and peer of every request would add one crossing and two to three V8
strings per request, which the section 8.6 budget cannot carry. The guide and the CHANGELOG state
the rule. Legacy cases that read `req` from a timer after the response are found by the runner
and either pass or move to `dropped` with a CHANGELOG anchor.

### 8.6 Body copy and response bodies below the staging threshold

- Request body: `reqBody(slot)` runs `BufferSlice::copy_from(env, x.request().body())` inside
  `with_read` (`napi_create_buffer_copy`, a JavaScript-owned copy, facts 4). WebSocket payloads are
  copied the same way in the event callback. At release 1 the sdk's `req.body` stays `null`
  (body parsers are release 2 in `api-surface.json`); `@zero-server/core` exposes
  `request.body()` over this copy for the conformance runner and early adopters.
- Response bodies under 64 KiB: `resRespond(slot, status, fields, body)` with `body` a `Buffer`, a
  string or `null`, one crossing and one lock pair. A `Buffer` is copied once into the exchange; a
  string is converted by napi-rs's safe string conversion (one UTF-8 copy by napi into a Rust
  buffer) and moved into the body. The harness cells `node_string_body_{1k,16k,64k}` measure it;
  writing the string with `napi_get_value_string_utf8` straight into the response buffer (one copy
  fewer, one more audited block) is recorded as an option, not built at release 1.
- Shared backing stores: napi-rs reads a `Buffer` argument (`resRespond`, `wsSend`, `wsPing`,
  `roomBroadcast`) through a Rust slice, and a `Buffer` over a `SharedArrayBuffer` can be written
  by another worker thread during the call, a data race under a Rust reference. `@zero-server/core`,
  the layer every caller of the native package goes through, copies such a view
  (`ArrayBuffer.isView(x) && x.buffer instanceof SharedArrayBuffer`) into a fresh `Buffer` before
  the call. The native functions also refuse a shared backing store with `ZERO_INVALID_ARGUMENT`
  if Node-API and napi-rs 3.14.0 offer a safe way to tell (unverified here: whether a Node-API
  call distinguishes a `SharedArrayBuffer` backing, and whether napi-rs surfaces it, is read in the
  pinned docs in WP-10); the `@zero-server/core` copy is the guarantee either way. The completion
  `Float64Array` is allocated by `@zero-server/core` and never shared.

### 8.7 Large-body staging (R.3 row 13, DESIGN 7.3)

Used by `res.send`, `res.json`, `res.text` and `res.html` at or above 64 KiB, and by the core API
`res.alloc(len)`.

1. `resStage(slot, len)` checks the slot is leased and unsealed (`with_read`) and that the
   isolate's staging map holds no region for that slot (a second `resStage` before the send is
   `ZERO_INVALID_ARGUMENT`: one open region per slot, so a second buffer can never replace the
   region the first one is backed by). It creates `Region { bytes: vec![0; len] }`, takes
   `ptr = bytes.as_mut_ptr()` before wrapping it in an `Arc`, and calls
   `ArrayBuffer::from_external(env, ptr, len, hint = Arc::clone(&region), finalize = drop(hint))`.
   This is the binding's one `unsafe` block. SAFETY: `ptr` is valid for `len` bytes until the
   finalizer drops the hint, because the `Arc` owns the `Vec` and nothing resizes it; no Rust
   reference to the bytes exists before the send detaches the buffer (`Region::bytes` is called
   only by the worker's writer, after completion, which follows the detach); the region's address
   is not reused while either owner lives, which also satisfies napi's debug-build refusal of two
   buffers sharing a pointer (facts 4). Copy fallback: on `napi_no_external_buffers_allowed`,
   `from_external` copies, runs the finalizer at once and still returns `Ok` (facts 4), so the
   status carries no signal. The call therefore compares the returned buffer's data pointer and
   length (`as_ptr()` and `len()` through its `Deref<Target = [u8]>`, section 1) with `ptr` and
   `len`; a difference means the runtime copied, the region is dropped, nothing enters the map,
   and the call returns `ZERO_UNSUPPORTED`, on which the facade takes the copy path. Otherwise the
   `Arc` is stored in the staging map under the slot id and the buffer is returned.
2. The facade fills it: `TextEncoder.encodeInto` writes a string's UTF-8 straight into it;
   `Uint8Array.set` copies a `Buffer`.
3. `resSendStaged(slot, status, fields, arrayBuffer)` takes the slot's region from the staging map
   (none is `ZERO_INVALID_ARGUMENT`) and checks, in order:
   - `is_detached()`: true means JavaScript transferred it (for example with
     `ArrayBuffer.prototype.transfer`); the region is dropped and the request is answered 500 with
     code `STAGING_DETACHED`, because whether V8 moved the backing store is unknown and the worker
     must never read memory JavaScript can still write.
   - Identity: the argument's data pointer and byte length must equal the region's. A buffer from
     another `resStage`, another slot or plain JavaScript is refused with `ZERO_INVALID_ARGUMENT`
     and nothing is detached or installed (the region stays in the map until the flush drops it),
     so `set_external` can only ever install the region whose one JavaScript buffer is the one
     detached next. Only the pointer and length are taken from the slice napi-rs built for the
     argument; its bytes are not read.
   - `detach()` (V8 requires an external buffer, which this is; facts 4 and 7); a failure answers
     500 `STAGING_DETACHED` and drops the region.
   Then `with_write`: status, fields, `set_external(region)`, seal, and the map entry is removed.
   After the detach "the ArrayBuffer is considered detached if its internal data is null" (facts
   7): no JavaScript view can read or write the region while the worker writes it.
4. The worker's `wrote` drops the response's `Arc`; the finalizer drops the other; the region is
   freed after both.
5. A handler that stages and never sends leaves the slot untouched, so completion answers 500
   `NO_RESPONSE`; the staging map entry is dropped at the flush that completes the slot.
6. Vectors, all run on Node 22, 24 and 26: `detach-after-send` (a retained `Uint8Array` over the
   staged buffer has `byteLength` 0 after send, and writing through it changes no byte on the
   wire), `transfer-before-send` (a transfer before send answers 500 and the original bytes
   never reach the wire), `second-stage-refused` (a second `res.alloc` on the same slot throws
   and the first buffer still sends its own bytes), and `foreign-buffer-refused` (sending through
   another slot's staged buffer or a plain `ArrayBuffer` throws `ZERO_INVALID_ARGUMENT`, and the
   bytes on the wire are those of neither). If any of the four cannot pass on a supported line,
   the facade sets the staging threshold to infinity and every body takes the copy path; the
   vectors stay as the gate. The
   ECMAScript text for a typed array over a detached buffer is read in WP-11 before the first
   assertion's wording is fixed (unverified here; the wire-bytes assertion does not depend on it).

DESIGN 7.3's "one finalizer per pool region, never per request" cannot hold: detach is permanent
("an ArrayBuffer is non-detachable if it has been detached before", facts 4), so a reused region
needs a new external `ArrayBuffer` and a new finalizer each time, and it cannot return to a pool
before the old buffer's finalizer ran. One external buffer per large response is the shape that
works; its cost is a harness cell (`node_large_body_{64k,1m}`, staging against copy).

### 8.8 Completion flush

- The facade appends each finished slot id to the per-isolate, per-worker `Float64Array`
  (capacity `maxBatchesInFlight x 256`, 1,024 by default) with a parallel array of the objects it
  marks finished, and keeps `seen[worker]`, the newest epoch delivered.
- Full buffer: an append that finds the buffer full first flushes what it holds with
  `batchComplete(worker, ids, count, 0)` (one extra crossing, no acknowledgment), then appends.
  The bound holds for synchronous completions (at most one batch per iteration) but not for
  asynchronous ones, which hold no in-flight place (decision 6): thousands of leased handlers
  awaiting one shared Promise settle in one microtask checkpoint.
- Synchronous handlers: after the batch loop, in a `finally`, one
  `batchComplete(worker, ids, count, seen[worker])`: it completes the batch's sealed slots and
  acknowledges the epoch in one crossing and one wake.
- Asynchronous handlers: the terminal writer appends (section 8.5) and schedules one flush per
  microtask turn (`queueMicrotask`, guarded by a flag) that calls `batchComplete(worker, ids,
  count, 0)`.
- A refused acknowledgment (`batchComplete` returns `InvalidArgument`) still completed the listed
  ids (section 4.5); the facade reports it through `debug('zero:dispatch')` and the
  `refused_acks` counter, and does not retry it.
- Skipped deliveries (`records` and `events` both `null`, section 8.4) run nothing and are not
  acknowledged.
- Event batches: deliver every event, then acknowledge in a `finally`.
- Rust never awaits a JavaScript Promise (DESIGN 8.5).

### 8.9 try/catch mapping to the error registry

```ts
function runOne(slot: number, route: number, app: App): void
{
    const req = new Request(slot, route, app);
    const res = new Response(slot, req);
    try
    {
        const result = runChain(route, req, res);          // global middleware, param handlers, route chain
        if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function')
        {
            (result as PromiseLike<unknown>).then(undefined, (error: unknown) => fail(res, error));
        }
    }
    catch (error)
    {
        fail(res, error);
    }
}

function fail(res: Response, error: unknown): void
{
    try
    {
        if (res.sent)
        {
            debug('zero:error')('error after the response was sent', error);
            return;
        }
        if (res.app.errorHook)
        {
            try
            {
                res.app.errorHook(error, res.req, res, noop);
                return;
            }
            catch (inner)
            {
                error = inner;
            }
        }
        const http = isHttpError(error);
        const status = http ? inRange((error as HttpError).statusCode, 400, 599, 500) : 500;
        const code = http ? (error as HttpError).code : 'INTERNAL_SERVER_ERROR';
        const message = http || status < 500 ? messageOf(error) : null;     // a plain Error's message is not sent
        native.resError(res.slot, status, code, message, http ? detailsJson(error) : null);
        res.markSent();
    }
    catch (native)
    {
        res.markAborted(native);                                // Closed: the request was canceled
    }
}
```

One native call writes the whole error response in Rust (DESIGN 7.2). A throwing handler yields
500 and the isolate keeps serving (R.3 row 13 exit). A `ZERO_PANIC` from any native call goes
through the same path. Decision: a plain `Error`'s message is not sent on a 5xx (the safer
default); the legacy cases that pin the 1.x leak (`errors.test.js:779-807` and `:903-919`,
map-node-api conflict 11) move to `dropped` with a CHANGELOG anchor.

### 8.10 Native surface (`packages/native/index.d.ts`, generated by napi-rs)

```ts
export function coreVersion(): string;
export function abiVersion(): number;
export function headerName(id: number): string;
export function fieldValidate(name: string, value: string): number;      // ZeroStatus
export function conformanceCase(section: string, input: string): string;
export function appNew(): number;
export function appRoute(app: number, kind: number, method: number, pattern: string, options: string): number;
export function appMount(app: number, prefix: string, child: number): void;
export function appMiss(app: number): number;
export function appPolicy(app: number, kind: number, prefix: string, options: string): void;
export function appTable(app: number): Buffer;
export function serverNew(app: number, options: string): number;
export function serverTls(server: number, cert: Buffer, key: Buffer, options: string): void;
export function serverCheckTable(server: number, app: number): void;
export function serverStart(server: number): string;                      // address
export function serverWorkers(server: number): number[];
export function serverShutdown(server: number, drainMs: number): void;
export function serverWait(server: number): Promise<void>;                // one-shot ThreadsafeFunction; no libuv pool thread
export function serverOnStatus(server: number, callback: (event: string, core: number, detail: string) => void): void;
export function serverStats(server: number): Record<string, number>;
export function targetAttach(server: number, workers: number[], dispatch: (worker: number, epoch: number, kind: number, records: Buffer | null, events: ZeroEvent[] | null) => void): number;   // both null: a skipped delivery, not acknowledged
export function targetDetach(target: number): void;
export function batchComplete(worker: number, ids: Float64Array, count: number, epoch: number): number;
export function slotCanceled(slot: number): boolean;
export function reqHead(slot: number): [number, string, string, number, number, number, number];   // method id, method token, target, version, flags, miss status, allow
export function reqMeta(slot: number): number;                            // packed method id, version, flags, miss status; published view, no lock
export function reqHeaders(slot: number): string[];                      // flat name, value pairs, latin1
export function reqHeader(slot: number, name: string): string | null;
export function reqParams(slot: number): string[];
export function reqTrailer(slot: number, name: string): string | null;
export function reqBody(slot: number): Buffer;                            // copy
export function reqPeer(slot: number): { address: string; port: number; family: number; secure: boolean; clientAddress: string };
export function resRespond(slot: number, status: number, fields: string[], body: Buffer | string | null): number;
export function resError(slot: number, status: number, code: string, message: string | null, details: string | null): number;
export function resStage(slot: number, length: number): ArrayBuffer;     // one open per slot; ZERO_UNSUPPORTED when the runtime copied
export function resSendStaged(slot: number, status: number, fields: string[], staged: ArrayBuffer): number;   // staged must be resStage's buffer
export function resFile(slot: number, status: number, fields: string[], root: string, path: string): number;
export function resSseOpen(slot: number, status: number, fields: string[], keepAliveMs: number): number;   // connection id
export function resWsAccept(slot: number, protocol: string | null): number;                                // connection id
export function wsSend(conn: number, opcode: number, data: Buffer | string): number;
export function wsPing(conn: number, data: Buffer | null): number;
export function wsClose(conn: number, code: number, reason: string): number;
export function wsTerminate(conn: number): number;
export function wsBuffered(conn: number): number;
export function sseSend(conn: number, event: string | null, id: string | null, data: string): number;
export function sseComment(conn: number, text: string): number;
export function sseRetry(conn: number, milliseconds: number): number;
export function sseClose(conn: number): number;
export function sseBuffered(conn: number): number;
export function roomJoin(conn: number, room: string): number;
export function roomLeave(conn: number, room: string): number;
export function roomBroadcast(server: number, room: string, opcode: number, data: Buffer | string, except: number | null): number;
export function roomSize(server: number, room: string): number;
```

The exact napi-rs 3.14.0 argument types for `Buffer | string` unions, `Float64Array` inputs,
`ArrayBuffer` arguments and latin1 string creation are read in the pinned docs before
implementation (unverified here).

### 8.11 The TypeScript facade for release 1

Packages: `@zero-server/native` (the generated loader and `index.d.ts`), `@zero-server/core` (typed
wrapper over native: ids, the status enum, `ZeroError`, the server, targets, dispatch loop,
completion flush, `request.body()`, `res.alloc`, `coreVersion`), `@zero-server/sdk` (the 1.x
facade). All three publish at `2.0.0-alpha.1` under the npm dist-tag `next` (owner decision
2026-10-02, BRIEF): the package that builds the facade removes `"private": true` from the sdk
manifest through the generator in `crates/xtask/src/packages.rs`. Grounded in map-node-api ("Release
split for the Node facade") and map-legacy-tests section 5.

| Area | Release 1 surface | Implementation |
| --- | --- | --- |
| Exports | the 50 release 1 ids of `api-surface.json`; `version` is the package version string (1.x shape), the native function is `coreVersion()`; `handleUpgrade` moves to `dropped` in the generator | `index.ts`; `export { serveStatic as static }` |
| App | `createApp(options?)`; `use` (three forms, variadic accepted), `get`, `post`, `put`, `delete`, `patch`, `head`, `options`, `all`, `route`, `chain`, `group`, `param`, `set`, `get(key)`, `enable`, `disable`, `enabled`, `disabled`, `locals`, `onError`, `listen(port, opts?, cb?)` and `listen({ port, host, tls, threads, isolates, entry })` returning a server-like `EventEmitter` (`address()`, `close(cb)`, `listening`, `'listening'`, `'error'`, `'close'`), `close`, `shutdown({ timeout })`, `shutdownTimeout`, `on`/`off('beforeShutdown' \| 'shutdown')`, `lifecycleState`, `registerPool`, `unregisterPool`, `trackSSE`, `ws`, `routes()`, `handler` (a tagged value the legacy http patch recognizes; calling it throws), the privates `_lifecycle`, `_server`, `_extractOpts`, `_paramHandlers` (legacy H6) | routes register with `appRoute`; JavaScript handler chains keyed by route id |
| Router | `Router()` factory (`new Router()` keeps throwing), `use` (three forms, `TypeError` on other shapes), verb helpers, `route`, `inspect`, `routes` | mounts, groups and chains flattened into full patterns |
| Request | `method`, `url`, `originalUrl`, `baseUrl`, `path`, `headers` (lazy, lowercased), `query` (1.x rules: 100 parts, `__proto__`, `constructor`, `prototype` skipped, malformed pairs dropped, `+` literal), `params` (named; the unnamed wildcard as `params['0']`), `body` (`null`), `get`, `is`, `accepts`, `range`, `fresh`, `stale`, `xhr`, `protocol`, `secure`, `hostname`, `subdomains`, `ip`, `ips`, `locals`, `app`, `cookies` (`{}`), `id` (with `requestId`), `httpVersion`, `aborted` | `reqHead` once, the rest lazily, memoized |
| Response | `status` (`RangeError` outside 100 to 599; a 1xx answers 500 at send and logs through `debug`), `set` (calls `fieldValidate`, so the same Rust validator throws at the call; CR or LF throws `Error('Header values must not contain CR or LF characters')`, the message the legacy tests match), `get`, `append`, `vary`, `type`, `location`, `links`, `send`, `json`, `text`, `html`, `sendStatus`, `redirect`, `format`, `sendFile(path, opts?, cb?)` and `download(path, name?, cb?)` (below), `sse`, `headersSent`, `locals`, `app` | headers in a case-insensitive JavaScript map with 1.x semantics, sent once by `resRespond`; `cookie` and `clearCookie` wait for the cookie rows of release 2 (the manifest skips those describes) |
| `sendFile` and `download` | the 1.x checks and callback (`lib/http/response.js:301-383`), then the Rust file action | Path mapping: with `root`, the path resolves against it and a result outside it is refused 403 (an absolute path under `root` is expressed relative to it); without `root`, an absolute path is served as named (`root` = its directory, `path` = its file name, so zero-static still checks the final segment), and a relative path resolves against the working directory as root, where zero-static refuses any `..` (stricter than 1.x, which served any relative path: a documented change, map-node-api conflict 14); a NUL is refused 400. Then `fs.stat` in JavaScript: missing or not a regular file is 404. A refusal with a callback calls `cb(err)` with the 1.x error shape (`status`, `message`) and sends nothing, so the handler writes its own response; without a callback it answers the 1.x JSON body (`{"error":"Forbidden"}`, `"Bad Request"`, `"Not Found"`). Otherwise `resFile` with the fields set so far (`download` adds `Content-Disposition: attachment; filename="..."` first, as 1.x does), and `cb(null)` runs after the completion flush, since the facade cannot observe the end of the write (1.x calls it at the end of the stream; documented). zero-static re-checks the path at completion, so a file removed after the stat answers its 404. `sendFile` in a handler for a method other than GET or HEAD answers 405 (zero-static's rule); a documented change |
| Middleware | `cors`, `static`, `helmet`, `requestId` compile to tier 0 policies and routes when used in `app.use(...)`, `app.use(prefix, ...)` or as a route's leading middleware (elsewhere registration throws naming the position). Order: a tier 0 rule runs before any JavaScript middleware, so `static` in `app.use` is accepted only while no JavaScript middleware registered before it covers an overlapping prefix (one mount path is a segment prefix of the other); otherwise registration throws naming both positions and saying to register `static` first or to serve the files from a route through `res.sendFile`, because 1.x ran `app.use(requireAuth); app.use(static('./private'))` in order and tier 0 would serve those files without the check. `cors`, `helmet` and `requestId` stay accepted in any position: their order changes only which responses carry their fields and that a preflight is answered before JavaScript middleware runs, not who can read a resource, and refusing them would make the common `logger`-first order throw; this is a 2.0.0 CHANGELOG entry; `requestId({ generator })` runs as JavaScript middleware; `static({ setHeaders })` throws at construction (release 3 in the manifest); `logger`, `validate`, `errorHandler` with their 1.x module bodies (map-legacy-tests Q4); `app.use(fn)` with a four-parameter function registers it as the error handler (fixes 1.x error path 5, documented) | `logger` uses the finish hook |
| Errors | the 31 classes, `createError`, `isHttpError`, `debug` | host-only TypeScript, ported |
| Lifecycle | `LifecycleManager`, `LIFECYCLE_STATE` with the 1.x member names | drives `serverShutdown`; drain answers come from Rust (section 3.6); `bindings/node/test/lifecycle.test.js` carries rows `runtime-01` and `runtime-07` |
| WebSocket | `app.ws(path, opts, handler)`; `WebSocketConnection` instance shape (`id`, `readyState`, `protocol`, `headers`, `ip`, `query`, `url`, `secure`, `maxPayload`, `connectedAt`, `data`, `bufferedAmount`, `uptime`, `send`, `sendJSON`, `ping`, `close`, `terminate`, events `message`, `close`, `error`, `pong`, `drain`); `WebSocketPool` host-side, accepting any object with `send`, `close`, `on`, `readyState`, whose rooms map onto core rooms named `pool:<n>:<room>` so broadcasts reach every core | every upgrade is leased: the facade snapshots method, url, headers, query and peer into a plain `req`, awaits `verifyClient` (a falsy result answers 403; a Promise is awaited, fixing the 1.x hole), chooses the subprotocol (the route's list when given, else the client's first offer), calls `resWsAccept`, and runs the handler at the `WS_OPEN` event |
| SSE | `res.sse(opts)`: `send`, `sendJSON`, `event`, `comment`, `retry`, `keepAlive`, `close`, `on`/`off('close')`, `lastEventId` (read from the request's `Last-Event-ID`), `eventCount`, `bytesSent`, `connectedAt`, `uptime`, `connected`, `secure`, `data` | `resSseOpen` with the stored `res.set` headers merged into the stream head (a correction of 1.x, map-node-api conflict 10); a custom keep-alive comment uses a JavaScript interval |

### 8.12 Decisions on the 1.x conflicts

- D1 member contract: the surface generator emits the members of App, Router, Request, Response,
  SSEStream, WebSocketConnection and WebSocketPool from 1.x `types/*.d.ts` with the balanced-brace
  fix, and `bindings/node/scripts/check-surface.mjs` diffs the built `packages/sdk/dist/index.d.ts`
  against it and against the 50 release 1 ids (WP-6, WP-14).
- D2 `env`: release 2, as `api-surface.json` says; the env suite stays `skip`.
- D3 `req.body`: `null` at release 1; the parsers and their security rows are release 2 (step 18).
- D4: the legacy runner patches `http.createServer(app.handler)` and carries the 1.x fetch client
  (map-legacy-tests H1, H2).
- D5 `handleUpgrade`: `dropped` (its parameters are Node socket objects).
- D6 `WebSocketPool`: host-side, per isolate, with cross-core broadcasts through core rooms;
  per-isolate module state is a 2.0.0 CHANGELOG entry.
- D7: inline mode as above.
- D8 global JavaScript middleware: when any `app.use(fn)` with a user function exists, the app
  registers the miss route, misses are leased with their would-be status and `Allow` mask
  (`reqHead`), and the facade runs the global chain then the route chain or the 1.x miss answer;
  URL rewriting in middleware no longer re-routes (documented change). Without global middleware,
  Rust answers misses with the legacy body and no crossing.
- Router: core 405 with `Allow`, automatic HEAD and 501 stay (RFC 9110 Section 9.1), and the two
  router cases pinning 404 move to `dropped`; parameters are renamed positionally (`:p0`, `:p1`)
  with each route's names kept in JavaScript, which removes zero-router's parameter-name
  conflicts; a later duplicate of the same method and pattern is dropped (1.x: first registration
  wins); a root mount is flattened.
- CORS: options are translated with the 1.x defaults written out; zero-policy's preflight rules
  (it requires `Origin` and `Access-Control-Request-Method`, refuses with 403, adds the allow fields
  to preflights only) stay and are 2.0.0 CHANGELOG entries; `credentials` with `'*'` throws at
  construction as in 1.x; `.suffix` origins need WP-7.
- Static: `maxAge` milliseconds become seconds; `extensions`, fall-through on a miss and tri-state
  `dotfiles` need WP-7; without it those options throw at construction and their legacy cases move
  to `dropped` with a CHANGELOG anchor. `static` after overlapping JavaScript middleware throws at
  registration (section 8.11); the legacy suites register it first (`test/docs/integration.test.js`
  and `test/middleware/static.test.js`), and a facade test pins that
  `app.use(requireAuth); app.use(static(dir))` throws while the reverse order serves.
- Trust proxy: `req.ip`, `req.ips`, `req.protocol`, `req.secure` and `req.hostname` keep the 1.x
  semantics in the facade (right-to-left walk of `X-Forwarded-For`, hop counts, named ranges,
  functions) from the raw headers and the socket peer; the core's `TrustProxy` rule is unchanged at
  release 1.
- Request id: the core's UUID v7 and its incoming-id character check stay; `version: 4` is passed
  for 1.x compatibility when the app asks for it.
- SSE `Connection: keep-alive`: the driver owns `Connection`, so the one legacy assertion of it on
  HTTP/1.1 moves to `dropped` with a CHANGELOG anchor.
- Q6: the error and debug coverage files (69 cases) run at release 1.

### 8.13 Packaging, engines and CI

- Seven per-platform packages stay (`packages/native/npm/*`). `engines.node` becomes `>=22` in
  every package and in the value hard-coded in `crates/xtask/src/packages.rs`: the supported lines
  on 2026-10-01 are 22, 24 and 26 (facts 6), and nothing here needs Node-API 10.
- node.yml: `npm ci`; Node 22, 24 and 26 on Linux; the addon also built on `windows-latest` and
  `macos-latest`; steps: build, `check:packaging`, generated-file diff, `npm test` (native, facade,
  lifecycle), conformance runner, legacy runner, surface check. release-node.yml keeps its 2.0.0
  gate, builds on Node 24 (active LTS), and publishes `@zero-server/sdk` with
  `@zero-server/core` and `@zero-server/native` at `2.0.0-alpha.1` under the dist-tag `next`
  (owner decision 2026-10-02).
- Guides: `bindings/node/guides/quickstart.ts` with an `ANCHOR: example` region (read by
  `crates/xtask/src/site/home.rs`), plus `ws.ts` and `sse.ts`, all run by `npm run guides`.

### 8.14 Legacy runner

`scripts/copy-legacy.mjs` copies `test/` from a pinned zero-server-node commit (never the working
tree, which has uncommitted edits), excluding `test/test.js` and `test/body/tmp-mp-boost-31488/`,
into `bindings/node/test/legacy/`. `legacy-manifest.json` is map-legacy-tests section 10 (schema 1)
with these decisions applied: Q1 accept the http patch, Q2 keep 405 and 501 (two router cases
dropped), Q3 PATCH added, Q4 port `errorHandler`, `validate` and `logger`, Q5 `WebSocketPool`
host-side, Q6 run the coverage files, the error-exposure drops of section 8.9, the SSE
`Connection` drop, D5. Setup files: `setup/http.mjs` (the `http.createServer(app.handler)` patch,
H2) and `setup/gate.mjs` (wraps `describe`, `it` and `test` so each case resolves its manifest
entry, H7); `_shim/` maps `require('../../')` to `@zero-server/sdk`, `lib/...` paths to stub modules
that throw on use rather than on require, and `_helpers.js`'s client to the copied 1.x fetch client
(H1). The runner sets `ZERO_SERVER_THREADS=1` (inline isolate, H3) and relies on several servers per
process (H4). vitest is added as a devDependency at the version the npm registry returns on the day
it is adopted. Exit: every case whose resolved entry is `run` at release 1 passes and no `skip`
entry is at release 1 or below; R.3's "724 facade-only cases" is replaced by the manifest's
computed release 1 `run` count (685 proposed before these decisions; recomputed and recorded by
WP-14).

### 8.15 The unsafe surface of bindings/node

| Site | Operation | Argument |
| --- | --- | --- |
| `src/staging.rs` | `ArrayBuffer::from_external(env, ptr, len, hint, finalize)` | section 8.7 step 1 |

Nothing else: `BufferSlice::copy_from`, the ThreadsafeFunction builder, `add_env_cleanup_hook`
and `remove_env_cleanup_hook`, `ArrayBuffer::detach`, `is_detached` and its `Deref<Target = [u8]>`
(used only for `as_ptr()` and `len()` in the staging identity check), and string creation are safe
napi-rs APIs at 3.14.0. No raw ThreadsafeFunction pointer, no `napi_unref_threadsafe_function`, no instance data,
no `TypedArray::as_mut` (napi documents it as "literally undefined behavior"), no raw string write.
DESIGN 10.1's list for the binding shrinks accordingly.

## 9. Budgets against DESIGN 8.6, and the micro-harness grid

### 9.1 Per-request cost by binding

Counts are exact for this design; nanosecond figures are estimates from DESIGN section 2's
measurements plus about 5 ns per uncontended atomic read-modify-write (unmeasured; the harness
replaces every figure).

| Binding and path | Crossings per request | RMWs per request | Per batch | Estimate | Budget |
| --- | --- | --- | --- | --- | --- |
| .NET sync, pull target: `zero_req_view` (with `[SuppressGCTransition]`: no lock, no blocking, no callback) then `zero_res_respond` | 2 | 2 (the respond lock pair) | poll and complete: 2 P/Invokes, one condvar wake, one intake lock | about 2 + 4 (view loads) + 4.5 + 10 + body copy = 21 ns, plus about 30 ns / n per batch of n | 25 ns |
| Python sync (release 2 PyO3 facade; the release 1 ctypes smoke is not budgeted) | 2 | 2 | as .NET | 100 to 130 ns at 36 ns per attached call | 150 ns |
| Node, 4 items with 4 in flight: crossing 611 ns per item; two plain objects; `resRespond` | 1 | 2 | one TSFN call, one `batchComplete` | about 680 ns with no accessor; each lazily read accessor adds one crossing, 2 RMWs and the string creation | 700 ns |
| Node, 8 items with 8 in flight (`maxBatchesInFlight: 8`): crossing 187 ns per item | 1 | 2 | as above | about 250 ns with no accessor | 250 ns |
| Tiers 0 to 2 and 4 | 0 | 0 added | 0 | 0 | 0 |

The worker side adds, per tier 3 request: allocate, export (a few swaps, one pass over the fields,
the view stores), `hold`, `lease`, `begin_import`, import and `retire`: five worker-side CASes on
lines the worker already owns, and no host-visible cost. DESIGN 8.6's 12 ns accessor figure does not
include V8 string creation (87 ns for a 24-byte path, DESIGN section 2); the facade materializes only
what a handler reads.

What the Node cells measure. DESIGN 8.6 defines each cell as the crossing plus one pooled view
reset plus three to five sync accessor calls at about 12 ns each, with no V8 string creation in
the accessor figure. The gated handler is therefore that definition through the real binding:
the two request objects, four sync `reqMeta` calls (an integer read through the published view,
0 RMWs, no string; section 8.10) and a `resRespond` with a fixed 27-octet JSON body. A second handler, the json test as an application
writes it (`req.method`, `req.url`, `JSON.stringify`), is measured beside it and recorded, not
gated; on the estimate above it lands near 880 ns at 4 by 4 (one more crossing and two strings),
which is the honest figure for a handler that reads strings. The 8 by 8 cell needs
`maxBatchesInFlight: 8`, which section 6.9 now accepts (default 4); a cell beyond 8 in flight
is out of range by construction.

### 9.2 Cells (`crates/zero-bench/src/boundary.rs`, `bench/probes/{node,python,dotnet}/boundary`)

| Cell | Measures | Gate |
| --- | --- | --- |
| `slot_lock_pair` | `with_read` of 8 bytes, same thread, warm | 15 ns (judgment) |
| `slot_cas_borrow_pair` | a CAS borrow plus `fetch_sub` on the same line, the split-cell baseline | recorded beside `slot_lock_pair` |
| `slot_view_snapshot` | `read_view` of the whole view | 10 ns (judgment) |
| `slot_neighbor_contention` | the cells above with another thread exporting the neighbor slot (64 against 128 alignment) | recorded |
| `export_import_typical` | export plus import, 300-octet head, 8 fields, 2 parameters, empty body | 60 ns (judgment) |
| `complete_batch_{1,8,64,256}` | `zero_batch_complete` plus the worker's drain and wakes | per-item cost recorded |
| `pull_target_round_trip` | post, poll wake, respond, complete, worker wake | recorded against the TSFN hop (a DESIGN 5.7 gate) |
| `dotnet_view_respond` | the .NET row of 9.1 through the real P/Invokes | 25 ns |
| `node_grid_{1x1,4x4,8x8,16x2,64x}` | the Node (items, in flight) grid through the real binding with the gated handler of section 9.1 (`8x8` with `maxBatchesInFlight: 8`) | DESIGN 8.6's table |
| `node_grid_app_{4x4,8x8}` | the same cells with the application-shaped json handler of section 9.1 | recorded |
| `node_accessor_roundtrip` | `reqHeader` from JavaScript | 12 ns plus `slot_lock_pair` |
| `node_string_body_{1k,16k,64k}`, `node_large_body_{64k,1m}` | copy path and staging | the staging threshold decision |
| `node_request_objects` | two plain objects per request against pooled objects | recorded (section 8.5) |
| `node_json_handler` | the json test through a Node handler against uwebsockets.js (R.3 row 13's harness row) | recorded before any yardstick claim |

Hardware-dependent cells run in Docker on the owner's machine or are reported skipped (brief);
results go under `.docs/bench/`. A cell over its gate fails the harness run, not CI. A skipped
cell is recorded as not measured and never counts as holding its budget: R.3 row 13's "the
section 8.6 cells hold their budgets" stays open until the owner's run records every gated cell,
and the step is closed with that item listed as open unless the owner restates the exit (section
15 question 5).

### 9.3 The split-cell fallback

If `slot_lock_pair` is more than twice `slot_cas_borrow_pair` on the reference host, the payload
moves to the split-cell layout of design-free sections 3.1 to 3.8 (a frozen request cell and a
single-writer response cell guarded by a writer bit, dereferenced only in an audited module). It
saves no RMW (a borrow plus its release is also two), so it pays only for a measured lock cost, and
it costs an `unsafe impl Sync` plus six dereferences in an audited crate. The published view and
every ABI signature stay unchanged, so the fallback is internal to zero-rt and zero-host.

## 10. (g) The .NET smoke test and the Python smoke import

### 10.1 .NET (`bindings/dotnet`)

- `TargetFramework` becomes `net10.0` in `Directory.Build.props`: .NET 8 support ends 2026-11-10
  and .NET 10 (LTS) is supported to 2028-11-14 (support policy page, fetched 2026-10-01 and
  2026-10-02 by the designers); dotnet.yml's `setup-dotnet` installs the 10.0 line.
- `Interop/NativeMethods.g.cs` is generated from `zero.h` by `cargo xtask ffi-mirror`; the
  hand-written `NativeMethods.cs` keeps `[assembly: DisableRuntimeMarshalling]`, the library name,
  and adds the `[ModuleInitializer]` that registers `NativeLibrary.SetDllImportResolver` before any
  `[SuppressGCTransition]` method can be compiled (DESIGN 8.5). `[SuppressGCTransition]` only on
  `zero_abi_version`, `zero_req_view`, `zero_req_method`, `zero_slot_route` (no lock, no blocking
  call, no callback, no throw); never on `zero_target_poll` or anything that locks. Their refusal
  path is as clean as their success path, since a stale id is the ordinary refusal: the message
  goes into the fixed per-thread buffer of O12, and the thread-locals they touch (`PINS`,
  `THREAD`, the error buffer) have const initializers and no destructor (section 4.3), so no
  refusal allocates, takes the allocator's lock or registers a thread-exit destructor. Only a
  panic allocates, and a panic in these four functions is a defect, caught by `guard`. `ZeroStatus.cs`
  already matches. The six string and buffer imports now resolve; `OwnedString`, `OwnedBuffer`,
  `Status.LastError` and `NativeHandle.Create` work as written.
- `tests/ZeroServer.Smoke/Program.cs`: (1) `zero_abi_version() == 1`; `Marshal.SizeOf` and
  `Marshal.OffsetOf` of every struct equal the compile-time numbers of section 6.15; a reflection
  loop calls every import with NULL or invalid arguments and asserts the documented status (which
  would have caught the six missing exports); (2) every codec section of `vectors.json` through
  `zero_conformance_case`, `qpack` and `h3Frames` included; (3) a one-thread server with a host
  route and a WebSocket route, a dedicated `Thread` (not the pool) looping on `zero_target_poll`,
  echoing method, target and fields through `zero_req_view` over a `ref struct` span view and
  `zero_res_respond`, acknowledging each batch; the `http1Parser` vectors sent end to end over a
  `TcpClient` (echo or reject status), `router` registered and asserted end to end,
  `responseSplitting` through `zero_res_header` inside the handler, a `ws` handshake and echo over a
  raw socket; (4) a handler that throws is caught by the loop, answered with `zero_res_error(500)`,
  and the next request succeeds; (5) `GC.Collect()` on another thread while the pull loop blocks in
  `zero_target_poll`, asserting it returns (whether a thread blocked in a P/Invoke ever delays a GC
  was not fetched; the test settles it); (6) `zero_target_detach` makes the blocked poll return
  `Closed`.

### 10.2 Python (`bindings/python`)

"A Python smoke import over the same cdylib" is met literally and through the module:

- `tests/test_smoke.py` stays (the PyO3 module imports; `version()` now reads `zero_ffi::VERSION`,
  so the crate's last `unsafe` block goes away).
- `tests/test_cdylib.py`: `ctypes.CDLL` loads `libzero_ffi` (`zero_ffi.dll`, `.so`, `.dylib`) from
  the path python.yml exports after `cargo build -p zero-ffi --release`, and asserts
  `zero_version`, `zero_abi_version`, `zero_last_error_message` after a refused call, and the
  NULL, stale and wide-id cases for a sample of accessors. It never passes a `CFUNCTYPE`
  callback: called on a worker, ctypes "creates a new dummy Python thread on every invocation"
  (Python 3.13 ctypes docs), which DESIGN 8.4 forbids.
- `tests/test_serve.py`: a one-thread server and a pull target; a `threading.Thread` loops on
  `zero_target_poll` (a `CDLL` call releases the GIL: "The Python global interpreter lock is
  released before calling any function exported by these libraries, and reacquired afterwards"),
  answers through `zero_req_view` and `zero_res_respond`, acknowledges, and a client in the test
  thread asserts the response; `zero_target_detach` ends the loop with `Closed`. This is the shape
  of a sync handler thread; the release 2 asyncio loop, which runs on that same thread (DESIGN
  8.5) and so cannot block in `zero_target_poll`, uses the wait handle planned in section 6.10.
- `tests/test_conformance.py`: every codec section through `zero_conformance_case`, plus
  `http1Parser` end to end through the `test_serve.py` server.
- `requires-python >=3.11` and `abi3-py311`: Python 3.10 reached end of life on 2026-10-01
  (devguide, fetched 2026-10-01); 3.11 is supported to 2027-10. python.yml pins `maturin` and
  `pytest` at the versions PyPI returns on the day of the change.

## 11. (h) Conformance runners

| Section | Node (`bindings/node/test/conformance/*.test.mjs`, vitest) | .NET smoke | Python | Rust |
| --- | --- | --- | --- | --- |
| `http1Parser` | `conformanceCase`, and end to end: raw `net` socket to an inline server whose route echoes method, target, fields and body through the facade's core layer; rejects compare status | codec and end to end | codec and end to end | generator |
| `router` | `conformanceCase`, and the vector table registered with `appRoute` and `appMount` (vector ids mapped to returned route ids), one request per case, matched id, params, path, query and HEAD flag via an echo handler, misses by status and `Allow` | codec and end to end | codec | generator |
| `responseSplitting` | `conformanceCase`, and `res.set` on a live slot: accepted cases succeed, refused ones throw | codec and `zero_res_header` | codec | generator |
| `ws` | `conformanceCase`, and end to end: the vector's handshake and client frames over a raw socket; accept value (RFC 6455 Section 1.3 vector), echoed frames, close codes, `wsClose` refusals | codec and end to end | codec | generator |
| `sse` | `conformanceCase`, and a live `res.sse()`: bytes for each call, refusals for CR, LF and NUL | codec | codec | generator |
| `qpack`, `h3Frames` | `conformanceCase` | `zero_conformance_case` | `zero_conformance_case` | generator (step 11) |
| staging (`detach-after-send`, `transfer-before-send`) | live | | | |

The `ws` and `sse` vector sections are added to
`crates/zero-examples/examples/conformance_vectors.rs` (absent today) and generated from zero-ws
and zero-sse: `ws.cases[{ name, section, kind: handshake | frames | close, request or clientFrames
(hex), routeProtocols, expect }]` and `sse.cases[{ name, section, call: { event, id, data, retry,
comment }, expect: { bytes (hex) } | { rejected: true } }]`. The router vector "unimplemented token"
moves from `PATCH` to `PROPFIND`, because PATCH becomes a method. Every runner refuses an unknown
section, so a section cannot pass silently. `conformance/README.md` names the runners that now
exist.

## 12. (i) Registry rows

WP-0 adds these rows to `docs/standards.toml` before any code (RULES: "No row: add one first"), in
the existing field shape (`key`, `chapter`, `designation`, `body`, `subject`, `url`, `evidence`,
`at`, `anchor`, `release`, `note`), all at `release = 1`. `cargo xtask standards --check` reports
their missing tests without failing ci.yml while the release is built and blocks the release
preflight until every test exists; each package writes the test whose `at` text it is assigned,
verbatim. Keys are the next free numbers in each area at the time WP-0 lands; if step 11 or another
change took one, renumber and keep the `at` text. URLs are checked by `cargo xtask links` before
the rows land (the ANSSI and Node.js fragment ids were not fetched as fragments).

| Key | Chapter | Designation, body | Subject | URL | Evidence, `at` | Anchor |
| --- | --- | --- | --- | --- | --- | --- |
| ffi-01 | runtime | ANSSI Secure Rust Guidelines FFI-NOPANIC, ANSSI | Every C export catches a panic and returns ZeroStatus_Panic, and the next call on that thread works | https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#FFI-NOPANIC | `crates/zero-ffi/tests/abi_table.rs`, `fn every_export_returns_panic_instead_of_unwinding` | rule |
| ffi-02 | runtime | The Rust Reference, Rust Project | No Rust panic reaches a non-unwinding extern "C" boundary, where it would abort the host process | https://doc.rust-lang.org/reference/items/functions.html | same file, `fn a_panic_never_crosses_an_extern_c_boundary` | rule |
| ffi-03 | runtime | ANSSI FFI-CTYPE and FFI-CAPI, ANSSI | The generated header declares only C-compatible types and is the only exported API | https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#FFI-CTYPE | `crates/zero-ffi/tests/header.rs`, `fn the_generated_header_declares_only_c_compatible_types` | rule |
| ffi-04 | runtime | ANSSI FFI-NOENUM, ANSSI | Closed-set inputs arrive as integers and an undeclared value returns InvalidArgument | https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#FFI-NOENUM | `abi_table.rs`, `fn closed_set_inputs_out_of_range_return_invalid_argument` | rule |
| ffi-05 | runtime | ANSSI FFI-CK-PTR-VALID, ANSSI | Null and misaligned pointers return InvalidArgument and nothing is written | https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#FFI-CK-PTR-VALID | `abi_table.rs`, `fn null_and_misaligned_pointers_are_refused_and_nothing_is_written` | rule |
| ffi-06 | runtime | ANSSI FFI-MEM-OWNER, ANSSI | An owned string or buffer is released only by its free function, and freeing NULL is a no-op | https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#FFI-MEM-OWNER | `abi_table.rs`, `fn every_owned_handle_is_released_only_by_its_free_function` | rule |
| ffi-07 | runtime | ANSSI FFI-MARKEDFUNPTR and FFI-CKFUNPTR, ANSSI | Plugin vtable entries are optional unsafe extern "C" pointers, and a null handler or a foreign ABI version is refused | https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#FFI-CKFUNPTR | `crates/zero-ffi/tests/plugin.rs`, `fn a_vtable_with_a_null_handler_or_a_foreign_abi_version_is_refused` | rule |
| ffi-08 | runtime | ANSSI FFI-CK-REF-MODEL, ANSSI | A request view is handed only to a thread that pins the slot or is inside the delivering batch, and the memory it points to is not written while it is valid | https://anssi-fr.github.io/rust-guide/unsafe/ffi.html#FFI-CK-REF-MODEL | `abi_table.rs`, `fn a_view_is_refused_without_a_pin_outside_its_batch_window` | rule |
| runtime-21 | runtime | RFC 9110, IETF | Past the per-core bound of queued host batches, a tier 3 request is answered 503 with Retry-After in delay-seconds | https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4 | `crates/zero-host/tests/dispatch.rs`, `fn past_the_queued_batch_bound_a_host_request_is_answered_503_with_retry_after` | rule |
| runtime-22 | runtime | Node.js v22.23.3 Node-API, Node.js | A value is queued only when the call returns napi_ok, so a batch refused as full stays queued on the worker and is posted after the next acknowledgment | https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_call_threadsafe_function | `crates/zero-host/tests/dispatch.rs`, `fn a_full_target_keeps_the_batch_queued_and_posts_it_after_an_acknowledgment` | interop |
| runtime-23 | runtime | Node.js v22.23.3 Node-API, Node.js | Closing the server releases the dispatch function, so the isolate's event loop can exit | https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_release_threadsafe_function | `bindings/node/test/native/lifecycle.test.mjs`, `closing the server releases the dispatch function so the isolate exits` | interop |
| runtime-24 | runtime | Node.js v22.23.3 Node-API, Node.js | A terminated worker isolate detaches its target, its leased requests are answered, and tier 0 keeps serving | https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_add_env_cleanup_hook | `bindings/node/test/native/isolates.test.mjs`, `a terminated isolate detaches its target and tier 0 keeps serving` | interop |
| runtime-25 | runtime | Node.js v22.23.3 Node-API, Node.js | A request body handed to JavaScript is a copy, so changing it changes nothing in the core | https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_create_buffer_copy | `bindings/node/test/native/body.test.mjs`, `a request body buffer is a copy that survives completion unchanged` | interop |
| runtime-26 | runtime | Node.js v22.23.3 Node-API, Node.js | A staged response body is detached at send, so no JavaScript view can read or change it and the wire carries the bytes written before send | https://nodejs.org/docs/latest-v22.x/api/n-api.html#napi_detach_arraybuffer | `bindings/node/test/native/staging.test.mjs`, `a staged body is detached at send and the wire bytes do not change` | interop |
| runtime-27 | runtime | Node.js v22.23.3 worker_threads, Node.js | Process signals are wired on the main thread only, because workers do not receive them | https://nodejs.org/docs/latest-v22.x/api/worker_threads.html | `bindings/node/test/facade/pool.test.mjs`, `process signals are wired on the main thread only` | interop |
| runtime-28 | runtime | Node.js v22.23.3 addons, Node.js | The addon loads in every per-core worker_threads isolate and each isolate registers its own target | https://nodejs.org/docs/latest-v22.x/api/addons.html | `bindings/node/test/native/isolates.test.mjs`, `the addon loads in each per-core isolate and registers its own target` | interop |
| runtime-29 | runtime | Python 3.13 ctypes, Python Software Foundation | A CDLL call releases the global interpreter lock, so a handler thread blocks in zero_target_poll without holding it | https://docs.python.org/3.13/library/ctypes.html | `bindings/python/tests/test_serve.py`, `def test_a_pull_target_serves_while_the_interpreter_runs_other_threads` | interop |
| routing-29 | http | RFC 5789, IETF | PATCH is a recognized method with its own route slot, neither safe nor idempotent | https://www.rfc-editor.org/rfc/rfc5789.html#section-2 | `crates/zero-http-types/src/method.rs`, `fn patch_is_a_recognized_method_that_is_neither_safe_nor_idempotent` | rule |
| routing-30 | http | RFC 9110, IETF | A host cannot set a status outside 100 to 599 or an informational status: 100 comes from the driver and 101 only from an accepted upgrade | https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2 | `crates/zero-host/tests/access.rs`, `fn a_host_cannot_set_an_out_of_range_or_informational_status` | rule |
| routing-31 | http | RFC 9110, IETF | Set-Cookie values appended by a host leave as separate field lines | https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3 | `crates/zero-host/tests/access.rs`, `fn appended_set_cookie_values_leave_as_separate_field_lines` | rule |
| routing-32 | http | RFC 9110, IETF | A host field value with CR, LF or NUL is refused at the boundary in every binding | https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5 | `bindings/node/test/conformance/response-splitting.test.mjs`, `a host field value with CR, LF or NUL is refused in the Node binding` | rule |
| realtime-34 | realtime | RFC 6455, IETF | A host close refuses 1004, 1005, 1006, 1010 and 1015, the unassigned codes below 3000, and codes outside 1000 to 4999 | https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1 | `crates/zero-host/tests/realtime.rs`, `fn a_host_close_refuses_reserved_and_unassigned_close_codes` | rule |
| realtime-35 | realtime | RFC 6455, IETF | A host ping payload and a close code with its reason are limited to 125 octets | https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5 | same file, `fn a_host_ping_and_close_are_limited_to_125_octets_of_payload` | rule |
| realtime-36 | realtime | RFC 6455, IETF | The accepted subprotocol is one the client offered, and an empty choice sends no Sec-WebSocket-Protocol | https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2 | same file, `fn the_accepted_subprotocol_is_one_the_client_offered` | rule |
| realtime-37 | realtime | RFC 6455, IETF | A host that declines an upgrade answers with an HTTP error status and no upgrade happens | https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2.2 | same file, `fn a_declined_upgrade_is_answered_with_an_http_error_status` | rule |
| realtime-38 | realtime | HTML Standard, WHATWG | A host SSE call with CR or LF in event or id, or NUL in id, is refused and writes nothing | https://html.spec.whatwg.org/multipage/server-sent-events.html | same file, `fn a_host_sse_call_with_cr_lf_or_nul_in_event_or_id_is_refused` | rule |
| realtime-39 | realtime | HTML Standard, WHATWG | Host comment and data text is split at CR, LF and CRLF so every line stays one field | https://html.spec.whatwg.org/multipage/server-sent-events.html | same file, `fn host_comment_and_data_text_is_split_so_every_line_stays_one_field` | rule |

Each row's `note` names the section as the source writes it (for runtime-21: "RFC 9110 Sections
15.6.4, The server MAY send a Retry-After header field, and 10.2.3, delay-seconds"). WP-0 also
amends two existing rows whose evidence file this step creates: `runtime-01` gets `at = "installing
SIGTERM and SIGINT listeners replaces the default exit, so the lifecycle exits explicitly after
draining"` and `runtime-07` gets `at = "work in the process exit handler is synchronous only"`,
both in `bindings/node/test/lifecycle.test.js` (their current `fn ...` text matches no JavaScript
test name). Existing rows reused, not duplicated: `routing-28` (status range in zero-http-types),
`runtime-08` (request total timeout answers 503, which covers the closed lease), `realtime-25` to
`realtime-33` (the SSE and WebSocket codecs the vectors exercise); `errors-10` stays release 2. The
slot protocol has no external specification, so its loom and TSan tests are named after DESIGN 7.3's
statements and carry no row.

## 13. Amendments to DESIGN.md and ROADMAP.md

WP-16 writes these into `.github/cloud/DESIGN.md` and `ROADMAP.md` (the plan folder, where planning
vocabulary is allowed), each with its reason:

1. 5.6 and 7.3: a slot is taken at tier 3 dispatch, not at parse; tiers 0 to 2 and 4 keep the boxed
   record and carry no slot atomic. The request moves into the slot's exchange by buffer swaps; the
   connection keeps its record.
2. 7.3: the payload is a `Mutex` beside the word, accessed lock-then-check; the reader count counts
   pins; a published view of atomics serves C views at no RMW; only the worker changes state; the
   view rule (pin or batch window); epoch semantics (in-order acks from the target's thread, floor
   equal to the newest ack, the epoch published before the post, FIFO reuse among at most 4,096
   warm indexes, no probes); exchanges cleared and shrunk at release and counted in the core's
   memory budget until then; lease timeout equal to `request_total`.
3. 7.3 bodies: one external `ArrayBuffer` per large Node response instead of a pooled region (detach
   is permanent); `zero_res_body_transfer` moves to release 2 with its release delivered as an event.
4. 7.2: host errors are still mapped in Rust; the facade picks status, code and message.
5. 8.1: the names and additions of section 6.17; `ZeroStatus` keeps its eleven values; unwinding
   wording per Rust 1.81; PATCH is method id 8.
6. 8.2 and 8.5: C hosts pull batches; in flight means unacknowledged; events travel in event
   batches; every WebSocket upgrade is leased.
7. 8.3: Node request and response objects are plain per-request objects; pooling is internal.
8. 8.5: the Node binding calls zero-host; per-isolate state in a thread local; the ThreadsafeFunction
   is released by dropping it; inline mode; per-server route tables compared byte for byte; napi7;
   the ESM entry rule.
9. 8.6: the budget table restated with RMW and crossing counts (section 9.1) and the harness grid.
10. 8.7: `qpack` and `h3Frames` asserted by all three bindings through the conformance entry; the
    Python smoke loads the cdylib with ctypes beside the PyO3 import.
11. 10.1: zero-host joins the forbid crates; bindings/node's unsafe is one block; the zero-ffi
    inventory of section 6.14.
12. 10.8: plugin functions are non-unwinding and return `int32_t`; a foreign-std plugin panic
    cannot be caught at the vtable.
13. 4.2: the new crate `zero-host` in the crate list.
14. R.3 row 13 exit: the legacy count is the manifest's computed release 1 `run` count; `@zero-server/sdk@2.0.0-alpha.1`
    is published under the npm dist-tag `next` with `@zero-server/core` and `@zero-server/native`
    (owner decision 2026-10-02; the first release is `2.0.0-alpha.1` on every registry); the
    detach-after-send vector stays and `transfer-before-send`, `second-stage-refused` and
    `foreign-buffer-refused` join it.
15. R.3 row 12 exit: "every accessor returns a status on null, stale and out-of-range input"
    becomes "every export that takes an id returns a status on null, stale and out-of-range
    input; the six owned string and buffer functions are total on NULL, and use after free is a
    host error under ANSSI FFI-MEM-OWNER" (section 6.1 O7).
16. 7.2 and 8.2: in flight is 4 by default and configurable from 1 to 8; the Node queue bound is
    8; a refused acknowledgment does not discard the completions sent with it.
17. R.3 row 13 exit: the section 8.6 cells are measured with the handler section 9.1 defines; a
    skipped cell leaves the budget item open (section 15 question 5).
18. 8.5: Node pool mode replaces an isolate that exits while the server runs (bounded rate, then
    `'error'`); the default thread count is capped at the free worker indexes; `serverWait` holds
    no libuv pool thread; the dispatch ThreadsafeFunction's callback never returns `Err`.
19. 5.6 (shutdown): the dispatcher task and the realtime connection tasks end on the shutdown
    signal once their work is done, so a shutdown waits for in-flight work rather than for the
    drain deadline.

## 14. Work packages

Every file has exactly one owning package. Packages on the same line run in parallel; a line starts
when the packages it names have merged. The single hand-off is `crates/zero-host/src/lib.rs`, which
WP-1 creates as a placeholder and WP-8 owns afterwards (they never run at the same time). Every
Rust package runs `cargo build` and `cargo test` for its crates, and in the `zero-server-lint` image
`cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings`, with a
`CARGO_TARGET_DIR` unique to the package. Commits follow RULES: authored as molexxxx, no planning
vocabulary, fetched facts with their URL and date in the body, lockfile changes only where named.
The R.3 effort figures (28 and 36 days) stand.

Generated files are never hand-edited (RULES), so they are owned by their generator, not by a
package: the package that changes a generator owns that change, and any package whose sources
change a generator's output re-runs the generator and commits the result in the same commit. The
cases here: `cargo xtask packages --write` (`crates/xtask/src/packages.rs`, changed by WP-6)
writes the `package.json`, `tsconfig.json` and `README.md` of `bindings/node/packages/core` and
`packages/sdk`, the native README and `bindings/node/tsconfig.json`, with dependencies derived from
each package's imports, so WP-6 regenerates them for the `engines` change and WP-11 regenerates
them again when its sources add imports; `include/zero.h` (WP-9), `NativeMethods.g.cs` (WP-6's
generator, run by WP-12), `packages/native/index.{js,d.ts}` (WP-10) and `conformance/vectors.json`
(WP-5) follow the same rule.

Order:

- Line 0: the step 11 work committed (precondition); WP-0.
- Line 1: WP-1.
- Line 2: WP-2, WP-3, WP-4, WP-5, WP-6, WP-7. WP-3 does not need WP-2: zero-http implements only
  zero-rt's existing `Reset`, and the `Payload` impl lives in zero-host on a newtype (section 3.7).
- Line 3: WP-8 (needs WP-2, WP-3, WP-4, and WP-7 or its fallback).
- Line 4: WP-9 (needs WP-5, WP-6, WP-8), WP-10 (needs WP-8).
- Line 5: WP-11 (needs WP-10), WP-12 (needs WP-6, WP-9), WP-13 (needs WP-9).
- Line 6: WP-14 (needs WP-5, WP-11), WP-15 (needs WP-9, WP-10, WP-11).
- Line 7: WP-16 (needs every other package).

Critical path: WP-0, WP-1, WP-2 or WP-3, WP-8, WP-10, WP-11, WP-14, WP-16.

### WP-0: registry rows first

- Files: `docs/standards.toml`.
- Delivers: the rows of section 12 with their exact `at` text; the `at` amendments of `runtime-01`
  and `runtime-07`; the runtime group's intent text gains "and the host boundary".
- Tests: none (each row's test is written by the package named in its evidence).
- Exit: `cargo xtask standards --check` parses the file and lists exactly the new rows, plus
  `runtime-01` and `runtime-07`, as missing tests; each URL was fetched before the commit and the
  fetch date is in the commit body.

### WP-1: workspace plumbing and manifests

- Files: `Cargo.toml` (member `crates/zero-host`, workspace dependency `zero-host`,
  `unexpected_cfgs` with `check-cfg = ['cfg(zero_loom)']`), `Cargo.lock` (the new member and path
  edges only; no registry version moves), `deny.toml` (`zero-host` in the workspace-member allow
  list), `docs/lints/workspace.toml`, `crates/xtask/src/lints.rs` (`flatten` keeps `check-cfg`),
  `docs/capabilities.toml` (`[[crate]] name = "zero-host" lint = "workspace" no_std = false
  release = 1`, `zero-host` in `[engine] crates`, the runtime chapter intent), `supply-chain/config.toml`
  (the loom rationale beside its exemption), `crates/zero-rt/Cargo.toml` (loom under
  `cfg(zero_loom)` with the adoption record of section 7.1), `crates/zero-host/Cargo.toml` (every
  dependency and the features of section 6.13, `testing` included), `crates/zero-host/src/lib.rs`
  (crate doc and `pub const VERSION` only), `crates/zero-ffi/Cargo.toml` (the `zero-host`
  dependency, forwarded features, and a dev-dependency on `zero-host` with `testing`),
  `crates/zero-bench/Cargo.toml` (`zero-host` and `zero-ffi` for WP-15).
- Tests: an xtask unit test that a differing `check-cfg` list fails `lints --check`.
- Exit: `cargo build --workspace`; `cargo xtask lints --check`; `cargo deny check`; `cargo vet`;
  `cargo xtask docs --check` fails on no new item (it fails today on the binding layout,
  map-abi-state section 7).

### WP-2: zero-rt slot protocol, allocator and dispatcher

- Files: `crates/zero-rt/src/{lib.rs, sync.rs, slot.rs, arena.rs, alloc.rs, intake.rs, ring.rs,
  dispatch.rs, worker.rs, loom_tests.rs}`, `crates/zero-rt/tests/{slot_recycle_word.rs,
  dispatch.rs, arena.rs}`, `crates/zero-limits/src/services.rs` (`MAX_PENDING_EVENTS_PER_CONN`
  64, `RETRY_AFTER_SECS` 1, `DRAIN_RETRY_AFTER_SECS` 5, `MAX_RESPONSE_BODY` 64 MiB, the 1 ms full
  retry, `SLOTS_KEPT` 4,096), `crates/zero-limits/src/lib.rs` (`max_batches_in_flight` validated
  to 1 to 8 where `validate` checks it today, lines 139-141, and its table test at 271-272),
  `crates/zero-serve/src/lib.rs` (the `HostFailed` arm of the status sink's exhaustive match,
  lines 678-691, only).
- Delivers: sections 4.1, 4.2, 4.5, the zero-rt half of 4.6 to 4.8, section 5's state machine
  including the exit rule of 5.2 step 6, the worker-thread flag, `Event::HostFailed`.
- Tests: one test per transition and per refusal (close refusing `Free`, retire with readers, every
  generation mismatch); `lookup` of a never-grown index is `Closed`; `allocate` returns the reset
  payload's guard and skips an index whose lock is held; warm FIFO allocation, cold indexes used
  only when no warm one is free, quarantine release by `acked` clearing and shrinking each
  exchange and returning its counted octets, `adopt` over a used arena; a burst that grows the
  arena past `SLOTS_KEPT` with large bodies leaves at most `SLOTS_KEPT` warm indexes and
  `retained == 0` once every index is released; `read_view` checks; dispatcher with a
  `TestTarget`: batches up to 256 without waiting, in flight capped at `maxBatchesInFlight` (1, 4
  and 8), in-order acks, a target that acknowledges inside `post` before returning `Taken` (the
  acknowledgment is accepted and the worker keeps posting; this fails if `published` is stored
  after the post), `published` rolled back on `Full` and `Gone`, `Full` keeps order and arms the
  retry when nothing is in flight, admission at 4,096, tombstones, kind alternation, the
  late-list back-off, the exit rule (the task returns once draining and empty), no allocation once
  warm (counting allocator); an intake wake from a foreign thread on `io-tokio` and `io-compio`;
  the ten loom models of section 7.1; `slot_recycle_word_race`; zero-limits accepts 8 and refuses
  0 and 9.
- Rows: none (no external specification).
- Exit: `cargo test -p zero-rt` on both backends; `RUSTFLAGS="--cfg zero_loom" LOOM_MAX_PREEMPTIONS=3
  cargo test -p zero-rt --release --lib loom_`; `cargo test -p zero-rt -- --include-ignored
  slot_recycle` runs one test; the same under `-Zsanitizer=thread` in a nightly container; zero-rt
  still `forbid`.

### WP-3: zero-http exchange, hooks and error shape

- Files: `crates/zero-http/src/{exchange.rs, call.rs, conn.rs, record.rs, handler.rs, error.rs,
  server.rs, lib.rs}`, `crates/zero-http/tests/{exchange.rs, read_hold.rs, error_shape.rs}`.
- Delivers: sections 3.4 and 3.7.
- Tests: export and import round trip (every span, field, parameter, body and trailer; the record's
  parsed head intact; HEAD suppression, HTTP/1.0 keep-alive and 100-continue serialized correctly
  after a round trip); warm export and import allocate nothing; the published snapshot equals the
  exchange; `route_or_miss` carries status and `Allow`; a held pipelining connection reads nothing
  more until the hold drops; leased bytes pause accepts; `ResponseBody::External` leaves as one
  iovec and is released after the write; legacy and problem bodies for 404, 405, 413 and 503
  chosen through `Handler::error_shape`; export moves the entry's body charge (the core's counted
  bodies drop by the body's length and the handler's `leased_bytes` carries it); `Exchange::release`
  shrinks to `BODY_KEEP`, or to zero when cold, and reports its counted octets; the existing
  driver, routing and `no_alloc` tests, and the `Config` literals in zero-http, zero-realtime and
  zero-tls tests, unchanged.
- Rows: none new; the existing http rows stay green.
- Exit: `cargo test -p zero-http` on both backends; `forbid` intact.

### WP-4: zero-realtime outboxes

- Files: `crates/zero-realtime/src/{outbox.rs, websocket.rs, sse.rs, rooms.rs, lib.rs}`,
  `crates/zero-realtime/tests/outbox.rs`, and the encoder edits section 6.8 needs in
  `crates/zero-sse/src/lib.rs` (refusing NUL in `id` if the encoder does not yet) and
  `crates/zero-ws/src/**` (the host close-code set and the 123-octet reason, if the encoder does
  not yet enforce them), with their unit tests in the same files.
- Delivers: the zero-realtime part of section 6.8, including the shutdown behavior and the
  per-worker outbox counter; the encoder rules of section 6.8 enforced in zero-sse and zero-ws.
- Tests: frames pushed from a plain thread arrive in order; close, terminate, join and leave apply
  in send order; pongs surface; `drained` after the high-water mark; `Limit` at four times the
  mark and at the per-worker total; the per-worker counter returns to zero when every outbox
  drains; SSE `send_encoded`; on the shutdown signal a WebSocket sends Close 1001 after its queued
  frames and the task ends, an SSE stream flushes and ends, each after pushing its close event;
  the outbox closes when the task ends; the zero-sse and zero-ws refusals.
- Exit: `cargo test -p zero-realtime -p zero-sse -p zero-ws`; the no_std builds of zero-sse and
  zero-ws stay green.

### WP-5: PATCH and the vector sections

- Files: `crates/zero-http-types/src/method.rs`, `crates/zero-router/src/lib.rs`,
  `crates/zero-http/tests/routing.rs`, `crates/zero-examples/examples/conformance_vectors.rs`,
  `conformance/vectors.json`, `conformance/README.md`.
- Delivers: `Method::Patch = 8` and `ALL` of nine; the router's per-leaf handler array sized from
  `Method::ALL.len()` (the literal 8 at `lib.rs:317`), with zero-router's `Allow` set widened
  internally while its public API stays source-compatible, so zero-http (WP-3) needs no change for
  it; the 501 vector moved to `PROPFIND`; the `ws` and `sse` sections; the README naming the
  runners.
- Tests: `fn patch_is_a_recognized_method_that_is_neither_safe_nor_idempotent`; router cases for
  PATCH routes and for `PROPFIND` as 501; the regenerated vectors.
- Rows: `routing-29`.
- Exit: `cargo test -p zero-http-types -p zero-router -p zero-http --test routing`; the no_std and
  thumbv7em builds of zero-http-types and zero-router; `cargo run -p zero-examples --example
  conformance_vectors` leaves no diff after the commit.

### WP-6: contract tooling

- Files: `crates/xtask/src/{ffi_names.rs, ffi_mirror.rs, surface.rs, packages.rs, main.rs}`,
  `scripts/api-surface-from-zero-server.mjs`, `conformance/api-surface.json`,
  `conformance/api-surface.node.json`, `conformance/api-surface.python.json`,
  `conformance/api-surface.dotnet.json`, `conformance/api-surface.members.json` (new; all
  regenerated, never hand-edited).
- Delivers: `cargo xtask ffi-names --write | --check` (the constants file of section 6.3),
  `cargo xtask ffi-mirror --write | --check` (`NativeMethods.g.cs` from `zero.h`), `cargo xtask
  surface --check` (the C# declarations against the header: names, parameter counts, a C-to-C#
  type map); the generator's balanced-brace fix, the member manifest, `handleUpgrade` dropped;
  `engines` `>=22` in `packages.rs` (line 443), with the files `cargo xtask packages --write`
  produces regenerated and committed (the generated-files rule above).
- Tests: xtask unit tests over a sample header and declaration file; the nested-brace regression;
  member extraction over a sample `.d.ts`.
- Exit: `cargo test -p xtask`; the generator's `--check` mode clean on the committed files.

### WP-7: tier 0 options for the 1.x middleware (optional)

- Files: `crates/zero-policy/src/cors.rs`, `crates/zero-static/src/files.rs`,
  `crates/zero-policy/tests/cors_suffix.rs`, `crates/zero-static/tests/options.rs`.
- Delivers: anchored `.suffix` origin entries (label-boundary match only); `extensions`;
  tri-state `dotfiles` (`ignore` falls through, `deny` answers 403, `allow`); a miss outcome that
  lets zero-host fall through instead of writing 404.
- Tests: each option; `.example.com` never matches `badexample.com`; existing static rows stay green.
- Exit: `cargo test -p zero-policy -p zero-static`. If this package is not taken, the facade throws
  at construction on those options and the affected legacy cases move to `dropped`.

### WP-8: zero-host

- Files: `crates/zero-host/src/**` (`lib.rs` from WP-1, `app.rs`, `spec.rs`, `registry.rs`,
  `server.rs`, `handler.rs`, `lease.rs`, `overload.rs`, `access.rs`, `target.rs`, `tier0.rs`,
  `rules.rs`, `actions.rs`, `conformance.rs`, `testing.rs`, `realtime/{mod.rs, conns.rs, ws.rs,
  sse.rs, rooms.rs, events.rs}`), `crates/zero-host/tests/{dispatch.rs, access.rs, lifecycle.rs,
  realtime.rs, conformance.rs, no_alloc_tier3.rs, sources.rs, slot_recycle.rs}`.
- Delivers: sections 3.2, 3.3, 3.5, 3.6, 4.3, 4.6 to 4.8, 5.3, 5.6, the Rust API that sections 6.5 to
  6.11 wrap, and the features of 6.13.
- Tests: end to end over loopback with a `TestTarget`: tier 0 and tier 3 on one core; misses to the
  miss route with status and `Allow`; 503 past 4,096 queued (`runtime-21`); a full target keeps the
  batch and posts it after an acknowledgment (`runtime-22`); no target and arena exhaustion answer
  503; quarantine release; leases closed by dropped connections; a configuration whose lease timeout
  differs from `request_total` is refused; two servers in one process with index reuse and stale
  ids; the identical-table check naming the difference; the view rule (pin, window, refusal from
  another thread, refusal after the acknowledgment); staged-region refusals; the status range and
  1xx refusal (`routing-30`); `Set-Cookie` append (`routing-31`); both error shapes; respond; file,
  WebSocket and SSE actions; target loss answering 503 while tier 0 serves; the worker-thread flag;
  `HostFailed` on a dispatcher panic (test hook); shutdown (section 5.2 step 6: `zero_server_wait`
  within one second of `zero_server_shutdown` on an idle server and after an in-flight request
  completes, both with a 30 s drain deadline); `zero_server_wait` refused on a bound thread; a
  host thread looping `with_read` on stale ids of one index never makes an export fail or an
  import wait (the pre-check); a tier 3 request whose host acknowledges before `post` returns;
  `abandon_batch` answering 500 `DISPATCH_FAILED` and acknowledging; a burst of 1 MiB-body tier 3
  requests returning `leased_bytes` to its idle value; the file action with more than
  `FILE_ROOTS_KEPT` roots (the oldest dropped), with host fields kept on the file response, and
  the `ErrorShape` body on a refusal; outbox octets counted in `leased_bytes`. Realtime: handshake refusals in Rust, leased
  upgrades, every event kind, sends from host threads, rooms with an exclusion, `realtime-34` to
  `realtime-39`. Conformance: every section against `vectors.json`, and a proptest of arbitrary
  bytes per section that never panics. `no_alloc_tier3`; the source grep of section 4.3; the TSan
  test of section 7.2.
- Rows: `runtime-21`, `runtime-22`, `routing-30`, `routing-31`, `realtime-34` to `realtime-39`.
- Exit: `cargo test -p zero-host --features testing` (the hook-driven tests carry
  `#![cfg(feature = "testing")]`); `cargo test -p zero-host --no-default-features`; the ignored
  `slot_recycle` test under TSan and ASan in a nightly container; `forbid` intact.

### WP-9: zero-ffi

- Files: `crates/zero-ffi/{build.rs, cbindgen.toml, include/zero.h}`, `crates/zero-ffi/src/{lib.rs,
  guard.rs, ptr.rs, last_error.rs, handles.rs}`, `crates/zero-ffi/src/abi/{mod.rs, names.rs,
  layout.rs, library.rs, app.rs, server.rs, target.rs, slot.rs, req.rs, res.rs, realtime.rs,
  plugin.rs}`, `crates/zero-ffi/tests/{abi_table.rs, header.rs, plugin.rs, lifecycle.rs,
  slot_recycle_c_abi.rs}`.
- Delivers: section 6.
- Tests: section 6.16; the header check; plugin validation; lifecycle (several servers, stale ids
  across them, shutdown with leased slots, free refused while running); the C-path TSan test; the
  constants test; Miri over the pointer helpers and handles.
- Rows: `ffi-01` to `ffi-08`.
- Exit: `cargo test -p zero-ffi`; `cargo check -p zero-ffi --no-default-features`; the header
  regenerated with `ZERO_FFI_HEADER_STRICT=1` and committed; `cargo xtask ffi-names --check`; Miri
  on the helper tests; TSan and ASan on `slot_recycle_c_abi`; `cargo build -p zero-ffi --release`
  on Linux, macOS and Windows.

### WP-10: Node native crate

- Files: `bindings/node/{Cargo.toml, Cargo.lock, build.rs}`, `bindings/node/src/**`,
  `bindings/node/packages/native/{index.js, index.d.ts}` (generated), `deny/node.toml`,
  `bindings/node/test/native/**`.
- Delivers: sections 8.1 to 8.4, the native parts of 8.6 and 8.7, and 8.10; the napi lock bump as
  its first commit.
- Tests: Rust unit tests for id checks and record encoding; `node:test` files: an inline isolate
  answering through a minimal dispatch loop; `lifecycle.test.mjs` (`runtime-23`; `serverWait`
  resolves with `UV_THREADPOOL_SIZE=1` while two waits are pending and a `dns.lookup` still
  completes; the cleanup hook is removed by `targetDetach`); `isolates.test.mjs` (`runtime-24`,
  `runtime-28`; a target detached with batches still in Node's queue skips each of them and the
  isolate survives; a forced failure in `arguments` answers 500 and the next batch arrives);
  `body.test.mjs` (`runtime-25`); `staging.test.mjs` (`runtime-26`, `transfer-before-send`,
  `second-stage-refused`, `foreign-buffer-refused`); `status.test.mjs` (a burst of 100 status
  events while the isolate is blocked makes no call past 16 queued and counts the rest in
  `status_dropped`).
- Rows: `runtime-23` to `runtime-26`, `runtime-28`.
- Exit: `npm ci && npm run build:native && node --test test/native` on Node 22, 24 and 26 on Linux;
  `cargo deny --manifest-path bindings/node/Cargo.toml --config deny/node.toml check`; clippy on
  the binding manifest; the regenerated loader shows only the intended change.

### WP-11: Node facade

- Files: `bindings/node/packages/{core,sdk}/src/**` and their tests,
  `bindings/node/packages/native/package.json`, `bindings/node/packages/native/npm/*/package.json`,
  `bindings/node/{tsconfig.base.json, test.js}`, `bindings/node/test/lifecycle.test.js`,
  `bindings/node/test/facade/**`, `bindings/node/guides/**`; plus the regenerated output of
  `cargo xtask packages --write` (the core and sdk `package.json`, `tsconfig.json` and
  `README.md`, `bindings/node/tsconfig.json`), never hand-edited.
- Delivers: sections 8.3 (facade side), 8.5, 8.7 (facade side), 8.8, 8.9, 8.11, 8.12; `engines`
  `>=22` in every package.
- Tests: `lifecycle.test.js` (`runtime-01`, `runtime-07`); `facade/pool.test.mjs` (`runtime-27`,
  an identical-table mismatch named, `port: 0` shared, an ES module entry); a test file per member
  group (app, router, request, response, errors, middleware, WebSocket, SSE); a throwing handler
  answers 500 and the isolate keeps serving; five long async handlers on one worker do not block a
  sixth request; 5,000 leased async handlers awaiting one shared Promise all complete (the
  flush-when-full rule); objects read from the memo after the flush, and a never-read field
  returning `undefined` with one `ZERO_REQUEST_FINISHED` warning; a 1 MiB body through staging;
  `app.use(requireAuth); app.use(static(dir))` throws and the reverse order serves; `sendFile` with
  a callback on a missing file (the handler's own 404 body), an absolute path without `root`, a
  traversal under `root` (403), and `download`'s `Content-Disposition`; a pool worker that calls
  `process.exit` is replaced and its core serves tier 3 again, and the sixth exit inside 60 s
  emits `'error'`; the default thread count with fewer free worker indexes than CPUs; a `Buffer`
  over a `SharedArrayBuffer` is copied before `resRespond`.
- Rows: `runtime-01`, `runtime-07`, `runtime-27`.
- Exit: `npm run build` (`tsc -b`) and `npm test` on Node 22, 24 and 26; `npm run guides`;
  `npm run check:packaging`; `cargo xtask packages --check` clean on the committed generated files.

### WP-12: .NET smoke

- Files: `bindings/dotnet/**`, `.github/workflows/dotnet.yml`.
- Delivers: section 10.1.
- Exit: `cargo build -p zero-ffi --release`, `dotnet build` and the smoke run green on Linux in CI;
  `cargo xtask ffi-mirror --check` and `cargo xtask surface --check` clean.

### WP-13: Python smoke

- Files: `bindings/python/**`, `deny/python.toml`, `.github/workflows/python.yml`.
- Delivers: section 10.2.
- Rows: `runtime-29`.
- Exit: `maturin develop` then `pytest` green, with `libzero_ffi` built by `cargo build -p zero-ffi
  --release`; the stub diff clean; `cargo deny` with `deny/python.toml`.

### WP-14: Node conformance, legacy runner and Node workflows

- Files: `bindings/node/{package.json, package-lock.json, vitest.config.mjs, legacy-manifest.json}`,
  `bindings/node/scripts/{copy-legacy.mjs, check-surface.mjs}`,
  `bindings/node/test/{conformance,legacy,_shim,setup}/**`, `.github/workflows/{node.yml,
  release-node.yml}`.
- Delivers: section 8.13's CI, 8.14, the Node column of section 11, D1's surface check.
- Tests: the conformance runner over every section, the staging vectors live, and
  `response-splitting.test.mjs` (`routing-32`); the legacy runner.
- Rows: `routing-32`.
- Exit: the conformance runner green on every section; every manifest case resolved to `run` at
  release 1 passes and no `skip` entry is at release 1 or below (the count recorded in the commit
  body); `node scripts/check-surface.mjs` green; node.yml green on Node 22, 24 and 26 and on the
  Windows and macOS addon builds; a `workflow_dispatch` run of release-node.yml builds the seven
  targets and publishes nothing.

### WP-15: boundary harness

- Files: `crates/zero-bench/src/{boundary.rs, main.rs}` (the entry registration),
  `bench/probes/node/boundary/**`, `bench/probes/python/boundary/**`,
  `bench/probes/dotnet/boundary/**`, `justfile` (a `bench boundary` recipe).
- Delivers: section 9.2.
- Exit: `cargo run -p zero-bench --release -- boundary` prints every Rust cell; the probes run in
  the owner's Docker or are recorded as skipped; results under `.docs/bench/`.

### WP-16: integration

- Files: `.github/workflows/ci.yml` (the `loom` job; the sanitizer step over zero-rt, zero-host and
  zero-ffi with the three-test check; the header drift check and `ZERO_FFI_HEADER_STRICT=1` in the
  `rust` job), `SECURITY.md` (the inventories of sections 6.14 and 8.15 and the .NET sites, checked
  against cargo-geiger), `.github/CODEOWNERS` (the named reviewer DESIGN 10.1 requires on the
  audited crates and the .NET unsafe files), `CHANGELOG.md` (the 2.0.0 breaks: hidden 5xx
  messages, 405, 501 and automatic HEAD, per-isolate state, CORS preflight rules, no re-routing
  after a URL rewrite, SSE header merge, the driver-owned `Connection`, PATCH as a method,
  `static` refused after overlapping JavaScript middleware, `cors`, `helmet` and `requestId`
  applied regardless of their position, `sendFile` refusing `..` in a relative path without
  `root` and answering 405 outside GET and HEAD, its callback called after completion, request
  fields first read after the response returning `undefined` with a warning, pool isolates
  replaced on exit),
  `.github/cloud/DESIGN.md`, `.github/cloud/ROADMAP.md` (section 13), `README.md`, `web/home.toml`
  (the capability audit RULES requires; public text describes only what exists and makes no
  performance claim).
- Exit: `just ci`; `cargo xtask standards --check` finds the test of every section 12 row and of
  `runtime-01` and `runtime-07`; every binding workflow green on the integration commit; `cargo
  xtask docs --check` fails on no new item.

## 15. Open questions for the owner

Answered 2026-10-02: every recommended default below is accepted (BRIEF, Owner decisions that
apply), and question 4 publishes at `2.0.0-alpha.1`, the single version of the first release.

1. Accept the plan amendments of section 13 as a set, vetoing any single item. Recommended: accept;
   each is argued where it appears.
2. Support floors: Node `>=22`, .NET `net10.0`, Python `>=3.11` with `abi3-py311`. Recommended:
   accept. .NET 8 support ends 2026-11-10 and Python 3.10 ended 2026-10-01 (fetched), and the floors
   decide who can install the 2.0.0-alpha.1 NuGet and PyPI packages.
3. The 2.0.0 behavior breaks gathered for the CHANGELOG (hidden 5xx messages, 405, 501 and HEAD,
   per-isolate state, CORS preflight rules, no re-routing after a URL rewrite, SSE header merge, the
   driver-owned `Connection`, `static` refused after overlapping JavaScript middleware, tier 0
   `cors`, `helmet` and `requestId` regardless of position, the `sendFile` path and method rules,
   post-response field reads). Recommended: accept as a set; each moves named legacy cases to
   `dropped` with an anchor.
4. Publish `zero-host` to crates.io with the other crates at 2.0.0-alpha.1, the single version of
   the first release (a published name is permanent).
   Recommended: yes. The alternative folds it into zero-ffi behind a module-level
   `#![forbid(unsafe_code)]`, which keeps the code but puts safe and audited code in one crate.
5. The R.3 row 13 budget exit. DESIGN 8.6's 8-by-8 cell needs 8 batches in flight, which this
   design now allows (`maxBatchesInFlight` 1 to 8, default 4); the gated handler is DESIGN 8.6's
   own definition (crossing, objects, four integer accessors, a fixed body), with an
   application-shaped handler recorded beside it; and a cell skipped because no Docker run on the
   owner's machine happened leaves the exit item open rather than met. Recommended: accept those
   three readings, or restate the cells (for example against the application-shaped handler, whose
   4-by-4 estimate is about 880 ns against the 700 ns budget).

## 16. Unverified

- Every nanosecond figure in section 9 (including about 5 ns per uncontended RMW and the cost of a
  `std` lock pair on Linux, Windows and macOS); the harness decides.
- The ThreadsafeFunction builder snippet (assembled from the napi 3.14.0 signatures, not compiled),
  and napi-rs 3.14.0 argument handling for `Buffer | string` unions, `Float64Array` and
  `ArrayBuffer` arguments and latin1 strings.
- The ECMAScript wording for a typed array over a detached buffer, and whether V8 moves an external
  backing store on `ArrayBuffer.prototype.transfer`; the staging design is safe either way.
- Whether a .NET thread blocked in a P/Invoke can delay a garbage collection (the smoke test
  settles it).
- The nightly toolchain date for the TSan job and whether `-Zbuild-std` needs more than `rust-src`;
  whether tokio uses fences on paths the TSan tests reach.
- The advisory status of loom's own dependencies.
- The ANSSI and Node.js fragment ids and the Rust Reference anchor for the row URLs.
- IANA close code 1014 (not fetched; refused until it is).
- The vitest, maturin and pytest versions (fetched on the day each is adopted).
- The release 1 legacy `run` count (685 is map-legacy-tests' proposal before this design's
  decisions; WP-14 recomputes it).
- Whether zero-sse's encoder refuses NUL in `id` (it refuses CR and LF in `event` and `id`, read
  2026-10-02; WP-4 adds the NUL rule if missing), and zero-mime's type for `.js` against the legacy
  static assertion.
- Whether Node-API and napi-rs 3.14.0 offer a safe check for a `SharedArrayBuffer`-backed
  `Buffer` argument (the `@zero-server/core` copy covers it either way, section 8.6).
- Which platforms run Rust thread-local destructors for the threads hosts create (the pin release
  of section 4.3 is best effort; the late-list back-off bounds the cost when it does not run).
- `SLOTS_KEPT` (4,096), `FILE_ROOTS_KEPT` (16), the 512 KiB per-root file cache, the late-list
  back-off (1 ms for 64 ms, then doubling to 1 s), the status detail ring (64) and the isolate
  replacement rate (5 in 60 s) are judgments, not measurements.
- Whether napi 3 with `default-features = false` links on `x86_64-pc-windows-msvc` in PR CI (facts
  3 reads that msvc always loads Node-API symbols at run time; the new Windows addon build in
  node.yml settles it).

## 17. Critique resolutions

Every finding of `critique-12-13.md` was checked before it was resolved: against the repository
(the reads in section 1), against zero-server-node's `lib/http/response.js` and
`test/http/response.test.js`, and against the napi-rs 3.14.0 source and docs fetched for this
revision. All twenty hold. Seventeen are resolved as the critique proposes, or by one of the
alternatives it names. For findings 5 and 20 (d), and for the remedy in finding 15, a different
remedy was chosen, and the table below says why.

| # | Finding | Check | Resolution | Sections |
| --- | --- | --- | --- | --- |
| 1 | A host that acknowledges before `post` returns is refused, and `acked` stalls for good | Holds: `published` was stored after `Taken`, and a refused call changed nothing | `published` stored before the post and rolled back on `Full` or `Gone`; completions applied even when the acknowledgment is refused; `loom_ack_before_post_returns`; a `TestTarget` that acknowledges inside `post` | 0 (5, 6), 4.4, 4.5, 4.6, 4.9 (I11), 5.2, 7.1, WP-2 |
| 2 | An `Err` from the TSFN callback reaches `napi_fatal_exception` | Holds: the `call_js_cb_raw` arm read in the napi-v3.14.0 source | The callback never returns `Err`: a stale entry is a skipped delivery, any other failure or panic is answered in Rust by `abandon_batch` (500 and the acknowledgment); tests with batches queued at detach and a forced failure | 1, 8.2, 8.4, 8.8, 8.10, WP-10 |
| 3 | The staged send does not check that the buffer it detaches backs the region it installs | Holds: no identity check, `res.alloc` could be called twice, and facts 4 shows the copy fallback returns `Ok` | One open region per slot; the send requires the region's data pointer and length; the copy fallback detected by comparing pointers; vectors `second-stage-refused` and `foreign-buffer-refused` | 0 (13), 8.7, 8.10, 13 (14), WP-10 |
| 4 | The dispatcher task holds zero-io's drain open until the deadline | Holds: `spawn_local` counts the task in `Tasks.live` and the drain waits for zero (`zero-io/src/tokio_rt/worker.rs`) | The exit rule of section 5.2 step 6; WebSocket and SSE tasks end on the shutdown signal after pushing their close events; tests bounding `zero_server_wait` to one second with a 30 s deadline | 3.2, 5.1, 5.2, 6.8, 13 (19), WP-2, WP-4, WP-8 |
| 5 | Tier 0 middleware runs ahead of user middleware registered before it | Holds for `static`, which decides who can read a file | `static` after overlapping JavaScript middleware throws at registration; facade test; CHANGELOG. For `cors`, `helmet`, `requestId` see below | 8.11, 8.12, 15 (3), WP-11, WP-16 |
| 6 | Export can meet a busy lock and leak the claimed index | Holds: two `try_lock`s with a gap, and the guard was created after export | `allocate` returns the reset payload's guard, held through export and `hold`; `LeaseGuard` created right after `allocate`; a word pre-check before host locks; `import` is an explicit late-list future | 3.3, 4.2, 4.3, 4.9 (I12), 6.6, WP-2, WP-8 |
| 7 | Retired exchanges keep bodies outside the budget, and the arena never gives memory back | Holds: the entry's charge ends at the write (`conn.rs:657-663`) and the exchange was reset only at reuse | Exchanges cleared and shrunk at quarantine release; a `retained` counter from export to release reported by `leased_bytes`; at most `SLOTS_KEPT` (4,096, the `RECORDS_KEPT` counterpart) warm indexes, the rest cold with no buffers | 0 (5), 3.1, 3.4, 3.7, 4.2, 4.5, 6.7, WP-2, WP-3, WP-8 |
| 8 | The loom models do not cover a view read after return, and one model stores the ack on the worker | Holds | Acknowledgments only from the bound host thread in every model; three models added (view after return until the ack, pinned view on an unbound thread, ack before `post` returns) | 7.1, WP-2 |
| 9 | The completion buffer can overflow with async handlers, and a refused ack drops completions | Holds | Flush when full (one extra crossing); capacity `maxBatchesInFlight x 256`; completions independent of the acknowledgment | 4.5, 4.6, 8.8, WP-11 |
| 10 | `sendFile` and `download` shapes break `http/response.test.js` | Holds: the callback form, absolute paths without `root`, 403 on traversal and `Content-Disposition` are all asserted | The facade replays the 1.x checks and callback before the Rust action; an absolute path without `root` is served as named; host fields survive into the file response (`serve_path` appends, read); refusals get the `ErrorShape` body | 3.5, 8.11, WP-8, WP-11 |
| 11 | Work packages cannot meet their exits without editing files they do not own | Holds for every item (the literals, the exhaustive match, `zero-limits/src/lib.rs`, `packages.rs`, zero-sse and zero-ws) | `Payload` implemented in zero-host on a newtype, so WP-2 and WP-3 stay parallel; `Handler::error_shape` instead of a `Config` field, so no literal changes; WP-2 owns the `zero-limits` validation and the zero-serve arm; the generated-files rule; WP-4 owns the zero-sse and zero-ws encoder edits | 3.7, 5.7, 14 |
| 12 | `serverWait` as an `AsyncTask` holds a libuv pool thread for the whole drain | Holds (4 threads by default, shared with `dns.lookup`) | A strong one-shot ThreadsafeFunction called by a zero-host stop listener; `zero_server_wait` refused on a bound thread | 4.8, 6.1 (O10), 6.2, 8.2, 8.4, 8.10, WP-10 |
| 13 | The status ThreadsafeFunction leaks its payload on every `QueueFull` | Holds (facts 2) | A Rust-side counter keeps calls at 16 or fewer; a `Copy` payload; message text in a 64-entry ring read by the callback | 8.4, WP-10 |
| 14 | The section 8.6 budget exit cannot be met as designed | Holds: in flight was capped at 4, and the gated handler excluded the facade's accessors | `maxBatchesInFlight` 1 to 8 (default 4, within DESIGN 7.2's "4 by default"), `max_queue_size` 8; the gated handler is DESIGN 8.6's definition, with an application-shaped handler recorded; a skipped cell leaves the item open; owner question 5 | 0 (6), 5.1, 5.4, 6.9, 9.1, 9.2, 13 (16, 17), 15 (5) |
| 15 | "Every accessor returns a status on stale input" cannot hold for owned strings and buffers | Holds | The exception recorded in O7, the table test and the R.3 row 12 wording | 0 (10), 6.1 (O7), 6.16, 13 (15) |
| 16 | The per-root `Files` cache grows without bound | Holds: each `Files` owns an 8 MiB cache by default (`files.rs:57-76`) | At most 16 roots per core with a 512 KiB cache each, least recently used dropped | 3.2, 3.5, WP-8 |
| 17 | A pin can outlive its thread and keep a 1 ms timer running; the pull ABI cannot serve an asyncio loop | Holds | Pins released by a thread-local destructor; the late list backs off to one wake per second; the release 2 wait handle planned | 4.3, 4.6, 6.10, 10.2 |
| 18 | Pool mode never replaces a dead isolate, and the default thread count can be refused | Holds | Replacement on `'exit'` (5 per index in 60 s, then `'error'`); the default capped at the free indexes, only explicit values refused | 6.9, 8.3, 13 (18), WP-11 |
| 19 | `[SuppressGCTransition]` entry points allocate on their refusal path | Holds: O12 recorded a message per refusal | A fixed per-thread message buffer; const-initialized thread-locals without destructors on the view path | 4.3, 6.1 (O12), 10.1 |
| 20 | Smaller gaps | (a) holds: `retire` refuses `Leased`; (b) holds: three arrays of structs had no stride; (c) holds; (d) holds; (e) holds; (f) holds | (a) `LeaseGuard::close` before `retire` in the failure arm; (b) element sizes beside every array of structs; (c) `@zero-server/core` copies `SharedArrayBuffer`-backed views; (d) a warning, see below; (e) cleanup hooks carry ids only and are removed at detach; (f) outbox octets in the per-core budget with a per-worker cap | (a) 3.3; (b) 0 (10), 6.1 (O4), 6.4, 6.5, 6.14; (c) 8.6; (d) 8.5; (e) 8.3; (f) 3.1, 6.8, WP-4 |

Remedies not adopted, and why:

- Finding 5, the strict rule for `cors`, `helmet` and `requestId`: these keep compiling to tier 0
  in any position. Their position decides which responses carry their fields and whether a
  preflight reaches JavaScript middleware, not who can read a resource: browsers send preflights
  without credentials, and CORS fields on a 401 expose nothing an authorization check protects.
  Refusing them after any JavaScript middleware would make the common `logger`-first order throw.
  The difference is a CHANGELOG entry. `static` gets the strict rule because there the position
  is the access check.
- Finding 7, LIFO reuse: not adopted. FIFO among the warm indexes keeps the reuse distance both
  judges grafted. The warm bound gives the same memory guarantee as LIFO and keeps steady traffic
  below 4,096 leases allocation-free.
- Finding 11, moving WP-3 to a later line, giving WP-3 the five test files, or `#[non_exhaustive]`
  on `Event`: the newtype keeps WP-2 and WP-3 parallel without lengthening the critical path, the
  `Handler` method avoids churn in three crates' tests, and `#[non_exhaustive]` would change
  zero-rt's public API and still need the wildcard arm in zero-serve.
- Finding 12, resolving `serverWait` from the status ThreadsafeFunction: not adopted. That
  function is weak and drops events past 16, so the Promise could hang, or the process could exit
  before it resolves. The critique's other option, a dedicated one-shot function, is used.
- Finding 13, detail fetched by a separate pull call: the callback reads the detail ring directly
  on the isolate thread, which has the same effect without another export.
- Finding 3, keeping a napi reference to the staged buffer: the pointer and length identity check
  is equivalent here and needs no reference lifecycle. Each region has exactly one JavaScript
  buffer, and the region stays alive while it is in the map, so no other buffer can share its
  address.
- Finding 15, generation-checked handles for strings and buffers: not adopted. It would change
  six .NET imports that already work as written and add a global lock to `zero_req_body_retain`,
  and DESIGN 8.1 frames these as owned handles under ANSSI FFI-MEM-OWNER. The exception is recorded
  instead, which is the critique's second option.
- Finding 17, reserving `zero_target_fd` now: not needed, because a new export is compatible under
  ABI 1. The plan is recorded in section 6.10. Releasing a dead thread's pins through a pin token
  is not adopted either: the thread-local destructor does the same without changing the pin API.
- Finding 18, stopping the dead isolate's core listener: not adopted. On Windows and macOS one
  listener on core 0 hands connections to every core (DESIGN 5.4), so there is no per-core listener
  to stop, and on Linux it would need a new zero-io control. Replacement, then `'error'`, covers
  every platform.
- Finding 20 (d), throwing on a post-response read or snapshotting every request: a throw from a
  timer or a detached continuation ends the process under Node's default handling, and a snapshot
  costs one crossing and two to three V8 strings per request. The getter instead returns
  `undefined` with a one-time warning, so the loss is not silent.

The critique's "Checked and found sound" list needed no change.
