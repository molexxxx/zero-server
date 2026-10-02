# Request path map: zero-http, zero-router, zero-realtime, and the tier 3 hook

Repository: `C:\Users\tonyw\Desktop\projects\zero-core`. All paths below are relative to it;
`file:N-M` means lines N to M as of 2026-10-01. Read in full: `crates/zero-http/src/{lib,handler,call,conn,record,ring,server,takeover,error}.rs`,
`crates/zero-router/src/lib.rs` (non-test part), `crates/zero-realtime/src/{lib,websocket,sse,rooms}.rs`,
`crates/zero-rt/src/{lib,slot,arena,tier,contain,cancel,worker}.rs`, `crates/zero-ffi/{Cargo.toml,src/lib.rs,include/zero.h}`,
`crates/zero-limits/src/{services,http1}.rs` (relevant parts), `crates/zero-io/src/tokio_rt/worker.rs:55-352`,
plus DESIGN.md sections 5, 6.1 to 6.3, 7, 8, 10.1, 10.2 and the R.3 rows for steps 12 and 13.

## 1. Summary

- Every request on a core is a `Box<Record>` taken from a per-core free list (`Shared.records`,
  `crates/zero-http/src/conn.rs:75`, `105-119`), not an arena slot. Nothing in zero-http uses
  `zero_rt::Arena`, `SlotWord`, `SlotId`, `Tier` or `Cancel` (grep over `crates/` outside zero-rt finds
  no use). The section 7.3 statement "a request is a 53-bit slot id into the per-worker arena from
  parse to final write" is not what the driver does today.
- A handler runs as a future that owns the `Box<Record>` (`request_task`, `conn.rs:147-173`), pinned
  in a reusable per-ring-position slot and polled inline by the connection task (`ring.rs:247-266`,
  `329-356`). Cancellation is `drop` of that future, which frees the `Box<Record>` with it.
- The only existing extension point is the `Handler` trait (`handler.rs:20-80`), instantiated once per
  core by `serve`'s `make` closure (`server.rs:145-177`). A tier 3 host handler fits there without
  touching `conn.rs`, but the host-visible request memory cannot be the `Box<Record>`; it has to move
  into memory whose lifetime the slot protocol controls (section 6 of this note).
- zero-rt already has the state word (`slot.rs`) and a chunked arena (`arena.rs`), but the arena's
  API forms `&mut Entry` (state word included) on the worker, its chunk spine is a growable `Vec`, it
  is `!Sync`, its free list reuses an index immediately, and `get_mut` hands out a leased slot. Each of
  these must change before a host thread may touch it (section 7).
- zero-ffi exports only `zero_version` (`crates/zero-ffi/src/lib.rs:47-52`, `include/zero.h:27`) and
  depends on zero-core and zero-http only (`crates/zero-ffi/Cargo.toml:19-21`), not zero-rt.

## 2. End-to-end flow of one HTTP/1.1 request

1. Start. `zero_http::serve` (`server.rs:145-177`) validates limits and builds the `Server` line
   (`prepare`, `server.rs:245-273`), then `zero_rt::start` (`crates/zero-rt/src/worker.rs:208-244`)
   runs one closure per core on that core's thread. The closure builds `Shared` with the core's
   `Worker`, the handler from `make(&worker)`, the limits, the `Server` line and the memory budget
   (`server.rs:157-164`), and runs the accept loop `run_core` (`server.rs:278-332`). `serve_with`
   (`server.rs:197-242`) adds an `Accept` (TLS) that prepares each stream and may restrict authorities.
2. Accept. `run_core` pauses while `Shared::over_budget` (leased receive blocks plus buffered bodies,
   `conn.rs:123-130`) or `Accept::saturated` holds, otherwise spawns
   `Conn::new(shared, Rc::new(stream), peer, request_task::<H>).run()` through `Worker::spawn`
   (`server.rs:171-174`; `worker.rs:109-120` wraps every task in `contain`).
3. Connection loop. `Conn::run` (`conn.rs:424-462`) repeats `tick` then `wait` then `apply`.
   `tick` (`conn.rs:473-479`) = `expire` (deadlines), `process_input` (parse heads, feed bodies),
   `start_runnable` (start handler futures), `plan_write` (choose the next vectored write).
4. Read. `wait` (`conn.rs:483-545`) polls, in one `poll_fn`, every running handler future
   (`poll_running`, `conn.rs:521`), the write in progress, the read (`read_leased` from the core pool),
   the earliest deadline and the shutdown signal. A read happens only when the input is empty or a head
   is partial, the connection is not closing, no claim or upgrade is pending (`conn.rs:486-490`).
5. Parse. `parse_head` (`conn.rs:955-986`) takes a reset record (`Shared::take_record`,
   `conn.rs:105-110`) into `Conn.next` and calls `zero_http1::parse_request(input.tail(),
   &mut record.fields, limits)`. On `Complete`, `accept` (`conn.rs:990-1034`) copies the head bytes out
   of the receive block into `record.head` (`conn.rs:993-994`, so the block can return to the pool),
   stores the parsed `Head` (a `Copy` struct of spans, `crates/zero-http1/src/head.rs:195-229`), the
   peer, the secure flag and the 421 check (`conn.rs:995-998`, `serves` at `386-416`), decides
   close-after (`1000-1003`), answers 417 for an unknown expectation (`1004-1008`), asks the handler for
   the body limit (`body_limit`, `conn.rs:1038-1047`, which calls `Handler::body_limit` with the method
   and the raw path), refuses an oversize `Content-Length` with 413 at once (`1012-1016`), and pushes an
   `Entry` (`ring.rs:55-92`) at `Stage::Body` or `Stage::Waiting` into the ring (`conn.rs:1029-1033`).
6. Body. `feed_body` (`conn.rs:866-948`) appends content-length or decoded chunked bytes into
   `record.body`, counts them on the core budget (`count_body`), validates trailers into a stack table
   and keeps only their raw bytes in `record.trailers` (`conn.rs:935-944`), then moves the entry to
   `Waiting`. Bodies are fully buffered before the handler runs (`handler.rs:15`).
7. Start. `start_runnable` (`conn.rs:1063-1086`) starts the head entry, and a later entry only when it
   and every earlier entry are safe methods that already started (RFC 9112 section 9.3.2). Starting
   moves the `Box<Record>` out of the entry and calls `(self.make)(Rc::clone(&self.shared), record)`,
   which is `request_task::<H>` (`conn.rs:1074`); `Ring::start` pins the future into a reusable
   `Pin<Box<Option<F>>>` slot and marks the entry `Running` (`ring.rs:247-266`).
8. Handle. `request_task` (`conn.rs:147-173`): a misdirected request gets 421 without the handler;
   otherwise `Call::new(&mut record, &shared.worker)` and `contain(shared.handler.handle(&mut call))
   .await`. `Ok(Err(e))` becomes `record.problem(&Problem::from_error(&e))`; a panic is counted
   (`Worker::note_panic`, `worker.rs:129-135`) and answered with `Problem::panicked()` (500). The
   future returns the `Box<Record>`.
9. Complete. `poll_running` (`ring.rs:329-356`) pushes `(position, Box<Record>)` into
   `Conn.completed`; `apply` then `drain_completed` then `complete` (`conn.rs:566-591`) serializes the
   head (`serialize`, `conn.rs:1275-1350`), handles a claim (stop parsing, discard later pipelined
   entries, `conn.rs:576-583`), puts the record back into the entry and marks it `Done`.
10. Write. `plan_write` (`conn.rs:1090-1137`) groups every consecutive `Done` entry from the head (or
    the owed `100 Continue`). `fill_slices` (`conn.rs:1234-1270`) builds iovecs from each record's
    `response_head` and, when a body is allowed, `response_body`; one `writev` per turn.
11. Finish. `wrote` (`conn.rs:610-655`) pops written entries, moves a claimed record into `Conn.taken`,
    and returns every other record to the free list through `release_entry` then `give_record`
    (`conn.rs:658-663`, `113-119`), which calls `Record::reset` (`record.rs:136-154`) and keeps at most
    `RECORDS_KEPT` = 4,096 records per core (`conn.rs:46`).
12. Takeover or close. After the loop (`conn.rs:438-460`): a claimed record becomes a `Taken`
    (`takeover.rs:71-85`) passed to `Handler::taken` (`conn.rs:448-459`); then `linger` half-closes and
    drains for up to 1 s (`conn.rs:1153-1169`). A socket error path calls `abort` instead
    (`conn.rs:444-447`, `1144-1147`).

## 3. The Handler trait (`crates/zero-http/src/handler.rs`)

| Method | Lines | Contract | Relevance to tier 3 |
| --- | --- | --- | --- |
| `fn handle(&self, call: &mut Call<'_>) -> impl Future<Output = Result<(), Error>>` | 35 | One instance per core, `'static`, future is `!Send` and polled inline; `Err` is answered from the registry and replaces whatever was written; a panic is a 500 | The hook for a host dispatch: route, lease, await completion, return |
| `fn body_limit(&self, method: Option<Method>, path: &[u8]) -> Option<u64>` | 57-60 | Asked once per head with content, before any body byte; overrides `max_body` both ways | Must be answered in Rust (from the route descriptor or a `zero-policy` `BodyLimit`, `crates/zero-policy/src/body_limit.rs:77-110`); the host cannot be asked synchronously. Gets the raw path, not a route, so routing would run twice |
| `fn taken<S: Stream + 'static>(&self, taken: Taken<S>) -> impl Future<Output = ()>` | 76-79 | Owns the claimed connection until the future ends; default closes | Where the host-facing WebSocket and SSE loops run |

The concrete future type is part of the ring's slot type: `Ring<Req>` stores `Pin<Box<Option<Req>>>`
per position (`ring.rs:98-104`) and `Req` is `request_task::<H>`'s future, which embeds `H::handle`'s
future. A large tier 3 await state therefore enlarges every ring slot of every connection
(`conn.rs:1433-1439` asserts the task stays under twice the driver size).

## 4. Call, Request and Response (`crates/zero-http/src/call.rs`)

`Call<'a> { record: &'a mut Record, worker: &'a Worker }` (`call.rs:39-42`); constructed only by the
driver (`Call::new` is `pub(crate)`, `64-66`). `Worker` holds `Rc`s (`worker.rs:63-67`) and `Core`
holds `Rc<Pool>`, `Rc<Date>`, `Rc<Tasks>` (`crates/zero-io/src/tokio_rt/worker.rs:61-71`), so a `Call`
can never reach a host thread.

Call methods: `core` (70-72), `worker` (77-79), `upgrade(protocol, token)` (97-120: requires the
parsed `upgrade` flag and the protocol listed in `Upgrade`; sets 101, `Upgrade`, and `Claim{Upgrade,
token}`), `upgrade_required(protocol)` (134-139: 426), `stream(token)` (153-164: refuses HEAD; sets
`Claim{Stream, token}`), `request` (168-170), `response` (174-176), `parts` (181-217, split borrows of
the record), `route(&Router<T>) -> Option<Routed<T>>` (233-330).

Request accessors (`call.rs:336-508`, all borrowing the record for `'a`):

| Accessor | Lines | Reads | Notes |
| --- | --- | --- | --- |
| `method` | 365-367 | `parsed.method` (`Option<Method>`, `repr(u8)` with `id`/`from_id`, `crates/zero-http-types/src/method.rs:16-17`, `87`, `103`) | `None` for a token outside the eight |
| `method_token` | 371-374 | `parsed.method_token` span of `head` | |
| `target` | 378-381 | `parsed.target` span | |
| `path` | 385-387 | `parsed.path` span | Path AND query as received, not normalized |
| `query` | 391-393 | `split_query(path()).1` | Raw, not decoded |
| `route_path` | 397-399 | `record.route_path` | Normalized path, filled by `Call::route` only |
| `param(i)` | 408-411 | `route_path[params[i]]` | Reserved characters stay percent-encoded; names are not stored |
| `param_decoded(i, out)` | 424-429 | same, decoded into a caller `Vec` | Allocates into `out` |
| `params` | 432-434 | all ranges | |
| `authority` | 438-442 | `parsed.authority` span | Host or absolute-form authority |
| `version` | 446-448 | `parsed.version` | |
| `header(name)` | 456-461 | linear case-insensitive scan of `fields` | |
| `header_id(HeaderName)` | 469-474 | `Field.id == Some(name)` | `HeaderName` is `repr(u8)` with `from_id` (`crates/zero-http-types/src/header.rs:21-22`, `43`) |
| `headers` | 477-482 | every `(name, value)` | |
| `body` | 486-488 | `record.body` | Buffered, complete |
| `trailers` | 492-494 | `record.trailers` raw bytes | No per-name table and no allow list kept (`conn.rs:935-940` validates into a stack table only) |
| `peer` | 498-500 | `record.peer` | No ALPN or transport kind recorded anywhere in the record |
| `is_secure` | 505-507 | `record.secure` | |

Response writers (`call.rs:512-666`): `status(StatusCode)` (532-535), `header(name, value)` (550-562:
RFC 9110 token name, `field-value` value, refuses `Content-Length`, `Connection`, `Transfer-Encoding`,
`Date` per `RESERVED` at 30-35), `header_id` (574-582), `content_type` (602-604), `redirect` (618-626,
301/302/303/307/308 only), `redirect_preserving` (639-650), `body(bytes)` (657-660), `body_mut`
(663-665). Validation happens once here, which is the response-splitting boundary of DESIGN 6.3.
`Request::of` and `Response::of` exist (`call.rs:349-361`, `519-525`) but are `pub(crate)`.

## 5. The Record (`crates/zero-http/src/record.rs`)

`pub struct Record` (`record.rs:27-69`) lives in a private module (`lib.rs:23`) and is not
re-exported (`lib.rs:28-35`), so no other crate can name it. Fields (all `pub(crate)`):

| Field | Line | Holds | Written by |
| --- | --- | --- | --- |
| `head: Vec<u8>` | 30 | The head bytes; every span indexes it | `accept` (`conn.rs:994`) |
| `fields: Vec<Field>` | 32 | Parser table, `parsed.field_count` live; `Field { name: Span, value: Span, id: Option<HeaderName> }` (`zero-http1/src/head.rs:109-116`) | `parse_request` (`conn.rs:963`) |
| `parsed: Option<Head>` | 34 | Method, token, target, form, path, authority, version, field count, body length, keep-alive, expect, upgrade, len | `accept` (`conn.rs:995`) |
| `body: Vec<u8>` | 36 | Buffered body | `feed_body` |
| `trailers: Vec<u8>` | 38 | Raw trailer section | `feed_body` (`conn.rs:940`) |
| `peer`, `secure`, `misdirected` | 40-44 | Connection facts | `accept` |
| `scratch: Vec<u8>` | 46 | Path normalization space | `Call::route` |
| `route_path: Vec<u8>` | 48 | Normalized matched path | `Call::route` (`call.rs:264-265`) |
| `params: [(u32, u32); MAX_PARAMS]`, `param_count` | 50-52 | Ranges into `route_path` (`MAX_PARAMS` = 16, `zero-router/src/lib.rs:45`) | `Call::route` (`call.rs:266-273`) |
| `status: Option<StatusCode>` | 54 | Response status, 200 when `None` | `Response::status` |
| `response_fields: Vec<u8>` | 56 | Validated field lines, each ending CRLF | `Response::header*` |
| `response_body: Vec<u8>` | 58 | Response body | `Response::body*` |
| `response_head: Vec<u8>` | 60 | Serialized head | `serialize` |
| `close`, `claim`, `continued`, `advertise_upgrade` | 62-68 | Framing and takeover state | driver and `Call` |

Lifetime: taken from the per-core free list when a head starts parsing (`conn.rs:962`), owned by
`Conn.next`, then by the ring `Entry`, then moved into the handler future while `Running`
(`conn.rs:1073-1074`), back into the `Entry` when `Done` (`conn.rs:585-590`), and reset and returned
to the free list after the write (`conn.rs:658-663`) or moved into `Taken` for a claim
(`conn.rs:638-644`, `450-456`). `Record::reset` keeps capacities but shrinks `body` and
`response_body` to `BODY_KEEP` = 65,536 bytes (`record.rs:24`, `141`, `150`), which reallocates.
`Record` already implements `zero_rt::Reset` (`record.rs:136-154`), the trait `Arena<T>` requires
(`crates/zero-rt/src/arena.rs:21-26`), so it is ready to be an arena payload type.

## 6. Routing (`crates/zero-router/src/lib.rs`)

- `Router<T: Copy>` (`280-284`) is a trie (`Node`, `294-302`) plus mounts sorted longest prefix first
  (`498-520`). A leaf stores `handlers: [Option<T>; 8]` indexed by `Method::id` (`316-334`). The
  descriptor `T` is any `Copy` value the caller picks; nothing runs inside the matcher.
- `route(method, pattern, descriptor)` (`399-424`) normalizes the pattern like a request path, refuses
  duplicates, parameter-name conflicts, more than 16 parameters, and a non-final catch-all.
- `resolve_target(token, target, scratch)` (`535-548`) splits the query, normalizes the path with
  `zero_uri::normalize_path` (allocation-free on a warm `scratch`), and calls `resolve` (`557-562`),
  which answers `NotImplemented` for an unknown token, then `resolve_method` (`564-630`): static over
  parameter over catch-all, mounts before the parent's catch-alls, `dispatch` (`662-688`) giving
  `Matched { descriptor, params, head }` (HEAD served by GET with `head: true`), `Options { allow }`,
  `MethodNotAllowed { allow }`, or `NotFound`.
- `Call::route` (`call.rs:233-330`) maps the resolution onto the record: a match copies the normalized
  path and the parameter ranges into the record and returns `Routed { descriptor, head }`; every miss is
  answered in place (404, 405 with `Allow`, 501, OPTIONS 200 with `Allow`, `OPTIONS *`, 400 for a bad
  target). Parameter names are dropped; only ranges survive.
- `routes()` (`634-646`) lists `RouteInfo { method, pattern, descriptor }` "in no particular order",
  which is the input for the identical-route-table hash of DESIGN 8.5 (it must be sorted first).
- There is no router-level middleware and no handler chain in zero-router (grep for "middleware"
  finds only `zero-policy`). A route resolves to exactly one descriptor.
- In every test and bench (`crates/zero-http/tests/routing.rs:70-75`,
  `crates/zero-bench/src/entries.rs:79-97`), the application's `Handler::handle` calls `call.route`
  and matches on the descriptor; a tier 3 host handler would do the same with a descriptor such as
  `{ tier: Tier, route_id: u32, max_body: u64 }`.

## 7. Response serialization (`conn.rs:1275-1393`)

`serialize(shared, record, close)` reads `record.status` (default 200), `head_request()`, the
claim, `response_fields`, `response_body.len()`, `version()`, `keep_alive()`, `parsed.expect` and
`continued`, and writes `record.response_head`: status line, the core's `Date` block, the `Server`
line, `Content-Length` unless the status forbids it or the body streams, the handler's lines verbatim,
`Connection: upgrade` for 101 or advertised upgrades, then `Connection: close` or `keep-alive` for
HTTP/1.0 (`write_head`, `1370-1393`). A claim is honored only if the status still matches (101 for
`Upgrade`, a body-allowed status for `Stream`, `1281-1290`). A request with both `Upgrade` and
`100-continue` gets the 100 spliced before the 101 (`1310-1326`). A head that cannot be written even at
16 MiB becomes a bare 500 (`1329-1347`). Bodies of HEAD, 1xx, 204 and 304 are suppressed at write time
(`response_len` `1218-1226`, `fill_slices` `1257-1261`). The response body is one iovec pointing into
`record.response_body`; it is never copied into a write slab.

## 8. How a handler future is polled and cancelled

Polling: futures run only inside the connection task, in `wait`'s `poll_fn` through `poll_running`
(`ring.rs:329-356`); a ready future's slot is cleared and its output queued. The connection task is
woken by any of its futures' wakers, by I/O, by the timer or by shutdown. A pending tier 3 future
therefore costs nothing until its waker fires, and the connection keeps reading, parsing and writing
other pipelined responses (safe methods only run beside each other).

Cancellation is `drop`, through `Ring::clear_future` (`ring.rs:269-280`), `pop_front` and `pop_back`
(`ring.rs:218-240`). While `Running`, the entry's `record` is `None` (the future owns the
`Box<Record>`), so dropping the future frees the record rather than returning it to the pool.

| Trigger | Where | Effect on a running handler |
| --- | --- | --- |
| Request total timeout (`request_total` 300 s from head completion, `zero-limits/src/http1.rs:44`) | `expire` `conn.rs:705-724` (Running answers 503 at `715-716`), `fail_at` `769-788` | Future dropped, 503 with close, later entries dropped |
| Socket read error, write error or zero write; send idle | `apply` `conn.rs:555`, `expire` `680-685`, loop exit `443` (`discard_from(0)`) | All futures dropped, no response |
| An earlier response claims the connection | `complete` `conn.rs:576-583` | Later entries dropped unanswered |
| An earlier response closes the connection | `wrote` `conn.rs:648-651` | Later entries dropped |
| Shutdown | `apply` `conn.rs:558-561` marks close only; in-flight requests finish with `Connection: close`; at the drain deadline the runtime is dropped with every task (`server.rs:4-8`) | Dropped at the deadline |
| Peer EOF | `eof` `conn.rs:595-607` | Not cancelled: only a body-pending tail entry is removed; a running handler runs on until done or `request_total`, and reading stops |

There is no per-request cancel signal today: `zero_rt::Cancel` (`crates/zero-rt/src/cancel.rs:11-56`,
`Rc`, single-core) and the state word's cancel bit (`slot.rs:220-222`) are unused by the driver, and
"client went away" is not observed while a handler runs.

Panics: `contain` (`crates/zero-rt/src/contain.rs:43-70`) wraps each poll in `catch_unwind`; the
connection and core continue (`conn.rs:160-171`). For tier 3 the host code never runs inside this
poll, so host failures arrive as data (a status or a thrown error mapped by the facade), and FFI-export
panics are the `catch_unwind` of zero-ffi.

## 9. Takeover: WebSocket, SSE and rooms

- Claiming: `Call::upgrade` or `Call::stream` sets `record.claim` with a caller `token: u64`
  (`call.rs:97-164`, `takeover.rs:45-48`). After the claimed response is written, the record moves into
  `Conn.taken` (`conn.rs:638-644`), the loop ends, the input after the head becomes `leftover`
  (`conn.rs:438`), and `Handler::taken(Taken::new(stream, leftover, record, worker, claim))` runs on the
  same connection task (`conn.rs:448-459`). `Taken` (`takeover.rs:52-58`) keeps the `Box<Record>` for
  the whole connection so `request()` (`102-104`) stays readable; `token()` (`96-98`) distinguishes
  claims; `stream()`, `worker()`, `core()`, `write_all` (`114-155`). `Taken::new` is `pub(crate)`.
- WebSocket: `zero_realtime::websocket::accept(call, config, token)` (`websocket.rs:63-96`) negotiates
  with `zero-ws`, computes the accept value with `zero_server_crypto::Sha1`, then `call.upgrade` and
  adds the handshake fields, or writes the refusal (400, 403, or 426 with `Sec-WebSocket-Version`).
  `WebSocket::new(taken, limits)` (`150-161`) seeds input with `take_leftover`. `recv` (`248-290`)
  delivers room frames, flushes, feeds the session, answers ping and close, sends 1001 on drain, and
  returns `Message::Text(String)` or `Message::Binary(Vec<u8>)` (each an owned copy, `259-261`); pings,
  pongs and close are not surfaced as messages (close code via `close_code`, `237-239`). `send_text`,
  `send_binary`, `close` are `async` and `&mut self` (`302-339`). Its read wait (`370-419`) selects the
  socket, shutdown and the room inbox (`382-400`); there is no other external input.
- Rooms: `Rooms` is `Arc`-shared across cores (`rooms.rs:97-101`). A broadcast encodes once and pushes an
  `Arc<[u8]>` into each member's `Inbox` (`Mutex<Queue>` plus a stored `Waker`, `rooms.rs:43-86`), waking
  the member's task on whatever core (`rooms.rs:5-8`). `broadcast_text` and `broadcast_binary` take
  `&self` and are thread-safe (`156-173`). Joining is `WebSocket::join(&mut self, ...)`
  (`websocket.rs:181-189`) over the `pub(crate)` `Membership` (`rooms.rs:227-275`); `enter` and `exit`
  are private (`rooms.rs:205-221`). `MemberId` is per `Rooms` table (`rooms.rs:28-30`, `236`).
- SSE: `zero_realtime::sse::start(call, token)` (`sse.rs:46-51`) adds the stream fields and calls
  `call.stream`; `EventStream::new(taken, keep_alive_ms)` (`98-106`), `send` (`133-138`), `comment`,
  `wait(future)` (`171-216`: runs the application future while writing keep-alive comments and watching
  EOF and shutdown), `last_event_id` (`116-121`).
- There is no connection id in zero-http; the claim token is the only handle. No `writable` or
  `drained` query exists on either connection type.

## 10. The error registry (`crates/zero-http/src/error.rs`)

- `REGISTRY` (`22-34`) maps eleven codes to statuses; `status_for` (`46-59`) and `code_for` (`67-80`)
  cover the eight `zero_core::Error` variants (`Protocol`, `Io`, `Codec`, `Closed`, `Auth`,
  `Unsupported(&'static str)`, `Timeout(&'static str)`, `Limit`; `crates/zero-core/src/error.rs:16-53`),
  with `Timeout("upstream")` as 504 (`38`, `54`).
- `Problem { status, code: &'static str, detail: Option<String> }` (`85-93`); `from_error`
  (`119-131`) exposes the message only for `Protocol`, `Codec` and `Limit`; `panicked()` (`135-137`);
  `write_json` (`152-168`) writes RFC 9457 `{type: "about:blank", title, status, code, detail?}`.
  `Record::problem` (`record.rs:128-133`) clears the response and writes `Content-Type:
  application/problem+json` (`error.rs:19`) plus that body.
- The module header (`error.rs:7-8`) defers the Node registry to the binding step. The Node registry
  (`C:\Users\tonyw\Desktop\projects\zero-server\lib\errors.js:58-97`) is a class hierarchy with an
  arbitrary `statusCode`, a free-form `code` (`opts.code` or derived from the status text) and
  `details`, serialized as `{ error, code, statusCode, details? }`. It does not fit `Problem.code:
  &'static str` and its JSON shape differs from RFC 9457.
- The planned `ZeroStatus` of DESIGN 8.1 (`Ok = 0`, Protocol, Io, Codec, Closed, Auth, Unsupported,
  Timeout, Limit, InvalidArgument, Panic) lines up with the eight `Error` variants plus two, so
  `code_for` can serve the FFI status mapping as well.

## 11. What zero-rt and zero-limits already provide for step 12

- `SlotWord` (`crates/zero-rt/src/slot.rs:76-279`): bits 0-2 state, 3-18 readers, 19 cancel, 20-49
  generation (`11-12`); `transition` (`129-146`), `borrow(generation)` (`162-185`, CAS that checks
  generation and `Leased` and counts a reader), `complete(generation)` (`197-217`), `cancel`
  (`220-222`), `close` (`225-239`), `recycle` (`253-278`, refuses `Free`, `Leased`, or readers > 0,
  bumps the generation and clears the cancel bit), `Borrow` drop counts out (`295-301`).
- `Arena<T: Reset>` (`arena.rs:37-44`): `chunks: Vec<Box<[Entry<T>]>>`, `free: Vec<u16>` (LIFO),
  `Entry { word: SlotWord, value: UnsafeCell<T> }` (`30-33`); `allocate` (`100-114`, `Free` to
  `Parsing`, reset), `get_mut` (`129-138`), `word` (`150-155`), `free` (`172-195`), `grow` (`197-220`).
- `SlotId` (`crates/zero-core/src/slot.rs:12-24`, `33-139`): 7 worker bits, 30 generation, 16 index;
  `from_raw` refuses above 2^53 - 1 (`69-75`).
- `Tier` (`crates/zero-rt/src/tier.rs:7-22`) with `crosses()` true only for `Batched`.
- `MemoryLimits` (`crates/zero-limits/src/services.rs:27-51`): `max_batch_size` 256,
  `max_batches_in_flight` 4, `max_queued_batches_per_core` 16, `lease_timeout` 300 s equal to
  `request_total` (`services.rs:13-23`); not threaded into `zero_http::Config` (`server.rs:109-116`
  carries `Http1Limits` and the runtime config only), and `over_budget` (`conn.rs:123-130`) does not
  count leased response buffers although `REQUEST_MEMORY_PER_CORE`'s doc says it should
  (`services.rs:10-12`).
- Absent: the batch dispatcher, epoch-based index reuse, any cross-thread completion queue, the
  `late_reader` metric, and any FFI accessor (`crates/zero-rt/src/lib.rs:12-13` says the dispatcher and
  epoch reuse follow later).

## 12. Where a tier 3 host handler hooks in

The hook is a per-core `Handler` implementation (call it `HostHandler`) built by the `make` closure
that `zero_server_start` passes to `zero_http::serve` or `serve_with`. No change to the connection
driver's control flow is required: the driver already polls a pending handler future inline, keeps
serving the connection's other work, writes responses in order, and treats completion as "the record
holds the response".

`HostHandler` per-core state (built on the worker thread from `Send + Sync` registration data):
the `Router<RouteDesc>` copy (the process-global route table), the core's slot arena, the core's
dispatcher handle (`Rc`, local), and the host target paired with this worker index.

`HostHandler::handle(&self, call)`:

1. `let routed = call.route(&self.router)?` (a miss is already answered, `call.rs:233-330`).
2. Tier 0 (declarative) and tier 4 descriptors run inline as today (redirect, `Files::serve_path`
   at `crates/zero-static/src/files.rs:378`, policy decisions).
3. Tier 3: if the core already holds `max_queued_batches_per_core` batches, answer 503 with
   `Retry-After` here and return (the "from tier 0" rule of DESIGN 8.2). Otherwise allocate a slot,
   move the request bytes into it (section 13), move it `Parsing` to `WorkerOwned` to `Leased`, push
   `(slot id, route id)` into the per-core ready queue, register this future's waker under the slot
   index, and await completion.
4. On wake with the slot in `Completing` (and readers 0): move the response side back into the
   `Box<Record>`, run any post-completion action that needs `&mut Call` on the worker (see below),
   apply a host error through the registry, release the slot (deferred, epoch-gated), and return.
5. A drop guard inside the future handles cancellation (timeout, abort, discard, drain): set the
   cancel bit, and if the slot is `Leased` hand its id to the dispatcher's orphan list, which closes it
   at the lease timeout and recycles it only after the host completes or acknowledges the epoch and no
   reader is counted. The guard must never free memory a host may still read.

Post-completion actions that must run on the worker because they need `&mut Call` (and with it the
`Worker`, the core's crypto or file I/O): `zero_res_ws_accept` calls
`zero_realtime::websocket::accept(call, &config, token)`; `zero_res_sse_open` calls
`zero_realtime::sse::start(call, token)`; `zero_res_file` calls `Files::serve_path(call, path)`. The
host records the request for the action in the slot (a small enum); the tier 3 future performs it after
`Completing`, before returning. The token passed to `accept` and `start` should be the connection id
the host later uses with `zero_ws_*` and `zero_sse_*`.

`HostHandler::taken(taken)`: by token, wrap the connection in `WebSocket::new` or `EventStream::new`
and run a loop that turns received messages into ws event batch entries for the same dispatcher, and
drains a per-connection outbox that host calls (`zero_ws_send`, `zero_ws_close`, `zero_sse_send`,
`zero_sse_close`, `zero_room_join`, `zero_room_leave`) fill from host threads. The outbox needs the same
shape as `rooms::Inbox` (`rooms.rs:43-86`: a `Mutex` queue plus a stored `std::task::Waker`).
`std::task::Waker` "Implements Clone, Send, and Sync; therefore, a waker may be invoked from any thread,
including ones not in any way managed by the executor" (doc.rust-lang.org/1.89.0/std/task/struct.Waker.html,
fetched 2026-10-01; the workspace `rust-version` is 1.89, `Cargo.toml:54`). `zero_room_broadcast` can
call `Rooms::broadcast_*` directly from a host thread because those take `&self` on an `Arc<Rooms>`.

Per-core dispatcher: a task spawned once per core with `Worker::spawn` (allowed for driver tasks,
DESIGN 5.6). It drains the ready queue into batches of at most 256, keeps at most 4 in flight per
target, posts each batch through the host target's `Send` callback (Node: the isolate's
ThreadsafeFunction in `NonBlocking` mode; `QueueFull` keeps the batch queued), and receives
`zero_batch_complete(worker, slots, count, epoch)` through a `Send` queue plus one stored waker, so the
host pays one cross-thread wake per batch; the dispatcher then wakes the per-slot futures locally. This
is the "one wake to the owning worker per batch" of DESIGN 8.1.

Back pressure: the driver has no API for a handler to pause its connection's reads. Reading is gated by
the input state, close, the pool's `NoBudget`, a pending claim or upgrade (`conn.rs:486-490`), and
parsing stops at `max_pipelined` (8 by default, `zero-limits/src/http1.rs:23`; `conn.rs:855-857`). A
pending tier 3 request therefore holds back a non-pipelining client by itself; for the explicit "stop
reading from the connections that fed it" rule of DESIGN 8.2, `wait` needs a core-level pause flag in
`want_read`, and `over_budget` needs to count leased response buffers.

## 13. Data a host accessor must read or write

Every row reads the slot's copy of the request, under `SlotWord::borrow` (generation and `Leased`
checked, reader counted) for the duration of the access.

| ABI (DESIGN 8.1) | Record data | Existing Rust API | Gap |
| --- | --- | --- | --- |
| `zero_req_method` | `parsed.method` (u8 id), else `parsed.method_token` span | `Request::method`, `method_token` | None |
| `zero_req_path` | `parsed.path` span, or `route_path` | `Request::path` (with query), `route_path` (normalized) | Decide which the ABI returns; `path()` includes the query |
| `zero_req_query` | `split_query(path)` | `Request::query` | Raw only; decoding is a facade concern |
| `zero_req_param(slot, i)` | `route_path[params[i]]` | `Request::param`, `param_decoded` | Names live only in the route pattern; the facade maps names to indexes per route id |
| `zero_req_header_id(slot, id)` | `fields[..field_count]` with `id`, spans into `head` | `Request::header_id`; `HeaderName::from_id` | None |
| `zero_req_header(slot, name)` | same, case-insensitive | `Request::header` | None |
| `zero_req_trailer(slot, name)` | `trailers` raw bytes | `Request::trailers` | No stored table, no allow list (DESIGN 6.2 requires one) |
| `zero_req_body` / `_retain` | `body` | `Request::body` | Node copies; .NET and Python borrow |
| `zero_req_claim` | none | none | JWT is step 19 |
| `zero_req_peer` | `peer`, `secure` | `Request::peer`, `is_secure` | ALPN and transport kind are not recorded (`Prepared` carries only the stream and authorities, `server.rs:73-84`) |
| route id | descriptor | `Routed<T>` | Not stored in the record; travels in the batch descriptor's route-id array |
| `zero_res_status` | `status` | `Response::status(StatusCode)` | Range check 100 to 599 and refusal of non-101 1xx belong in the accessor |
| `zero_res_header`, `_header_id` | `response_fields` | `Response::header`, `header_id` (validated, reserved names refused) | Needs a worker-free constructor (`Response::of` is `pub(crate)`) |
| `zero_res_body_copy`, `zero_res_json` | `response_body` | `Response::body`, `content_type` | None |
| `zero_res_body_alloc`, `zero_res_send` | `response_body` sized by the host | `Response::body_mut` | A Node staging region that the driver writes from directly needs a non-`Vec` body variant in the record released after `wrote` |
| `zero_res_file`, `zero_res_ws_accept`, `zero_res_sse_open` | `claim`, status, fields | `Files::serve_path`, `websocket::accept`, `sse::start` (all need `&mut Call`) | Run as post-completion actions on the worker |
| thrown error | `status`, `response_fields`, `response_body` via `Record::problem` | `Problem`, `Record::problem` | `Problem.code` is `&'static str`; host codes are arbitrary strings |

## 14. Ownership and lifetime changes required

1. Request memory a host reads must not be a `Box<Record>` owned by the handler future. Dropping that
   future (section 8 table) frees it at once, while a host thread may be inside an accessor or holding a
   .NET span. The design's answer is the arena slot, whose memory is never freed and whose reuse the
   state word gates.
2. Two shapes are possible. (a) Tier 3 only: at dispatch, swap the request buffers (`head`, `fields`,
   `parsed`, `body`, `trailers`, `route_path`, `params`, peer facts) and the response buffers between the
   `Box<Record>` and the slot's record; at completion, swap back only the response side and the `Copy`
   request metadata (`parsed`, `peer`, `secure`) that `serialize` needs, leaving the request byte
   buffers in the slot until epoch-gated reuse. Swaps exchange `Vec` headers, so the warm path still
   allocates nothing, and tiers 0 and 4 keep the current path and the counting-allocator test
   (`crates/zero-http/tests/no_alloc.rs`). For a claimed ws or sse request the request buffers must come
   back into the `Box` for `Taken::request()`, so a host span on an upgrade request must not outlive
   completion. (b) Every request in the arena from parse to write, as DESIGN 7.3 states: replaces
   `Box<Record>` in `Shared.records`, `Conn.next`, `Entry.record`, `request_task`, `completed` and
   `Taken`, and needs `&mut Record` across an await from a shared arena, which safe Rust cannot give
   without a per-slot lock. (a) is the smaller change; (b) is the literal design text.
3. Arena changes (`crates/zero-rt/src/arena.rs`): host threads may call `borrow` on any slot id they
   hold, stale or not, at any time, so they touch the `SlotWord` of any entry concurrently with the
   worker. The worker's `entry_mut`, `get_mut`, `allocate` and `free` (`105`, `133`, `176`, `232-240`)
   form `&mut Entry<T>`, which covers that word. The Rust 1.89 `UnsafeCell` documentation states: "if
   you create a `&mut T` reference, then you must not access the data within the `UnsafeCell` with any
   other pointer/reference until that reference expires" and "it is still undefined behavior to have
   multiple `&mut UnsafeCell<T>` aliases" (doc.rust-lang.org/1.89.0/std/cell/struct.UnsafeCell.html,
   fetched 2026-10-01). So once hosts can reach an arena, the worker must address entries through `&`
   only, with record access through `UnsafeCell::get` (a safe call returning `*mut T`) dereferenced in
   an audited crate, or through a safe per-slot lock. Since zero-rt and zero-http stay
   `unsafe_code = "forbid"`, the dereferences (worker-side swaps and host-side reads) belong in zero-ffi,
   or zero-rt exposes only the words and raw pointers.
4. The chunk spine `Vec<Box<[Entry<T>]>>` reallocates on `grow` (`arena.rs:212`); a host locating
   index i must not read it while the worker pushes. It needs a fixed spine (for example 65,536 / chunk
   entries of `OnceLock<Box<[Entry<T>]>>`) reachable from host threads, and the per-core arena has to be
   `Arc`-owned by a process registry indexed by worker, not owned by the core's `Rc` state, so a host
   that calls an accessor after shutdown reads a `Closed` word instead of freed memory. `Arena` is
   `!Sync` today (`UnsafeCell<T>` is `!Sync`, same fetched page), so the shared wrapper needs either a
   `Sync` design without `unsafe impl` or an `unsafe impl Sync` in zero-ffi with a SAFETY argument.
5. `Arena::get_mut` must refuse `Leased` and `Completing` with readers (`arena.rs:134` refuses only a
   stale generation or `Free`).
6. Index reuse must wait for the epoch: `free` pushes the index onto the LIFO free list at once
   (`arena.rs:182`) and `allocate` resets the record (`110`), whose `shrink_to` reallocates the body
   buffers (`record.rs:141`, `150`). A slot freed after a `Closed` lease could otherwise be reset while
   a host span still points at it.
7. The state word counts readers but has no writer exclusion. Response writes from host threads
   (`zero_res_*`) mutate `response_*` `Vec`s; one slot must be driven by one host thread at a time (true
   for a Node isolate, not guaranteed for .NET `ValueTask` continuations), or a writer bit is needed.
8. zero-http visibility: `Record` (private module), `Request::of`, `Response::of`, `Call::new` and
   `Taken::new` are crate-private. A host accessor needs worker-free request and response views over a
   slot record, so `Record` or a slot payload type must become public, and the `Call` logic that does not
   need the `Worker` (`upgrade`, `stream`, `upgrade_required`) should be callable without it, or stay
   worker-side as post-completion actions.
9. Dependency direction: zero-http depends on zero-rt (`crates/zero-http/Cargo.toml:24`), so
   zero-rt's dispatcher cannot name `Record`; it should be generic over the slot payload or deal only in
   `SlotId`, route id and epoch. zero-ffi must add zero-rt (and zero-realtime, zero-static) to its
   dependencies.
10. Error registry: `Problem.code: &'static str` (`error.rs:89`) must become owned or an index into a
    registry table that includes the transferred Node codes, and a host problem must carry an explicit
    status (Node uses 400 to 599 freely).
11. Worker count: `SlotId` addresses 128 workers (`zero-core/src/slot.rs:12`, `17`) while
    `threads = 0` means `available_parallelism()` (`zero-io/src/tokio_rt/worker.rs:266-270`), so start
    must cap or refuse above 128.
12. Shutdown: `Workers::stop` blocks joining the threads (`zero-rt/src/worker.rs:177-179`); in-flight
    tier 3 requests drain only if host threads keep completing them, so `zero_server_shutdown` must not
    block a thread that is itself a handler target. The status sink is called on core threads
    (`worker.rs:52`), so its host bridge must be non-blocking.

## 15. Decisions the brief leaves open

- Tier 3 record placement: swap at dispatch (14.2 a) or arena from parse (14.2 b).
- Arena access model under `forbid(unsafe_code)` in zero-rt: raw pointers handed to zero-ffi, or a
  per-slot lock (one more atomic per access than DESIGN 5.6's "one atomic on the request path").
- `zero_req_path` semantics (raw path with query, raw path without query, or normalized route path).
- Error body shape for host errors: RFC 9457 as the Rust core writes today, or the Node
  `{ error, code, statusCode, details }` shape the legacy vitest cases may assert.
- Middleware: zero-router has no chain; a Node `app.use` chain either runs entirely in JavaScript per
  tier 3 dispatch (one crossing) or needs chain descriptors in Rust.
- Body limits for host routes: carried in the route descriptor and answered in `body_limit` (which
  receives the raw path, so it would route a second time), or a `zero-policy` `BodyLimit` table.
