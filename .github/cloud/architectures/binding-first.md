# zero core, binding-first architecture

Date: 2026-09-30. Angle: design from the FFI boundary outward so TypeScript, Python and C# users get near-Rust speed. Every claim below cites one of the research files in this directory (which record the source fetched for each statement) or a measurement recorded there; judgments and estimates are labeled as such, and anything not backed by a recorded source is marked unverified.

Research files cited by short name: bindings (research-bindings-and-handlers.md), runtime (research-runtime-io.md), http (research-http-and-ws.md), h3 (research-http3-and-quic.md), tls (research-tls-and-deps.md), db (research-db-drivers.md), nostd (research-nostd-and-security.md), tfb (research-techempower.md), pamoja (research-pamoja-template.md), salvage (salvage-map.md).

## 1. Summary

One Rust workspace named `zero-server` (bundle crate) with `zero-` prefixed capability crates, mirroring pamoja's layout (crates/, bindings/node, bindings/python, bindings/dotnet, an ffi crate, conformance/vectors.json, cargo xtask, Docker-run rustfmt and clippy, cargo-deny, release workflows for crates.io, npm, PyPI and NuGet). The design starts at the boundary: a request is a 53-bit slot id into a per-worker arena, never an object handed to the bound language; handlers are reached in batches, several batches in flight; everything that can be described as data (routes, static responses, cache specs, database plans, auth rules) is executed in Rust without a crossing. The runtime is thread-per-core on a completion-model driver (compio-driver behind an in-house trait) because that is the shape in which a request never changes threads, buffers never move during a handler call, and Python and .NET workers attach to their runtimes once per thread or once per batch instead of once per request.

The measured basis (bindings section 5, Windows 11 desktop, so ratios not absolutes): a bare Node crossing is 13.4 ns, a Promise per request caps a Node process near 520k to 546k requests per second, a pipelined ThreadsafeFunction round trip is about 505 ns, batching 256 items per crossing brings it to 124 ns per item, creating one finalizable JS object costs 874 ns, a Python attach from a foreign thread costs 2,249 ns while an attached callback costs 36 ns, and a .NET reverse P/Invoke costs 2.7 ns after a one-time 12,400 ns thread attach. The architecture is the set of rules that keep every per-request cost at the small end of those numbers.

Performance target (tfb section 7): a self-run of the archived TechEmpower toolset at commit 523534bb against the Round 23 Drogon entry (commit 96919df4), ratio zero-core over Drogon at least 1.10 on plaintext (every pipeline level), json, db, query q=1, fortunes and updates q=1, at least 1.25 on query q=20 and 1.40 on updates q=20, medians of five interleaved runs with zero errors, Realistic classification. The database tests are carried by tier 2 (plans executed in Rust), so the same numbers apply to a TypeScript, Python or C# application that describes its queries as data.

## 2. The FFI boundary, designed first

### 2.1 Request identity: a slot id, not an object

- A request lives in a per-worker arena slot from parse to final write. The only value that crosses any boundary is a 53-bit slot id: 8 bits worker index, 21 bits generation, 24 bits arena index (design choice; 53 bits so the id survives as a JavaScript number without BigInt, which pamoja needed napi6 for; bindings section 1). A stale id (generation mismatch) makes every accessor return a typed error rather than another request's data.
- Why not an object: `External` and external `Buffer` creation cost about 874 ns and 859 ns in Node (bindings 5.4), which alone exceeds the 505 ns pipelined crossing. Each Node isolate keeps a small pool of reusable view objects whose `slot` field is set per request; Python may allocate a `#[pyclass]` view per request (200 ns, bindings 5.5) but the facade still pools; .NET receives a `#[repr(C)]` view struct by pointer (1.3 ns fill, bindings 5.6).
- The arena never moves memory while a handler call is in progress on that slot (owned buffers from the per-core pool, runtime section 5.1), so borrowed byte views handed to the handler stay valid for the duration of the call.

### 2.2 Accessor surface (one C ABI, three facades)

Generated once by cbindgen from `zero-ffi` (pamoja section 8 conventions: status enum, thread-local last error, opaque handles, `*_free`, panics caught at the boundary) and mirrored by napi-rs functions, PyO3 functions and `[LibraryImport]` declarations:

- Request reads (all take the slot id, return integers or borrowed views): `zero_req_method` (u8 enum), `zero_req_path` (borrowed bytes), `zero_req_query` (borrowed bytes), `zero_req_param(slot, index)` (borrowed bytes, index from the route's parameter table), `zero_req_header_id(slot, name_id)` (borrowed bytes; name ids are a generated table of about 60 interned names shared by the header and by the facades), `zero_req_header(slot, name_ptr, name_len)` for the long tail, `zero_req_body(slot)` (borrowed bytes valid only during the call), `zero_req_body_retain(slot)` (one copy into a language-owned buffer), `zero_req_claim(slot, name)` (JWT claims already verified in Rust), `zero_req_peer(slot)` (address, scheme, ALPN, transport kind).
- Response writes: `zero_res_status(slot, u16)`, `zero_res_header_id(slot, name_id, value)`, `zero_res_header(slot, name, value)`, `zero_res_body_copy(slot, bytes)` for bodies under 64 KiB, `zero_res_body_transfer(slot, buffer, release_fn)` above it with the documented no-mutation rule (napi documents the data race for owned buffers, bindings section 2), `zero_res_json(slot, bytes)`, `zero_res_file(slot, path)`, `zero_res_sse_open(slot)` and `zero_res_ws_accept(slot)`, then `zero_res_send(slot)`.
- Batch completion: `zero_batch_complete(worker, slots_ptr, count)` posts one wake to the owning worker per batch rather than one per request; the facades accumulate completed slots and flush at the end of the batch iteration (sync handlers) or from a scheduled microtask or continuation (async handlers).
- Strings decoded on demand are memoized in the arena so a second read of the same field costs the crossing only (bindings 6.3).
- Every accessor is total: null pointers, stale slots and out-of-range indexes return a status, never panic across the boundary (nostd section 12.1, ANSSI FFI rules; `catch_unwind` at every export, nostd section 9).

### 2.3 Batch descriptor

A batch is a `#[repr(C)]` struct: worker index, count, pointer to a slot array, pointer to a parallel array of route ids (so the facade can dispatch to the right handler without reading the path), and a flags word (early data, upgrade request). Node receives it through one ThreadsafeFunction call per batch (bindings 5.4: 124 ns per item at 256 per crossing with several batches in flight); Python receives it as one call on an attached worker (bindings 5.5: 16 to 19 ns per item batched); .NET receives it through one `[UnmanagedCallersOnly]` call (bindings 5.6). Batch size adapts from 1 under light load to 256 under saturation, and the dispatcher keeps several batches in flight per target because a batch of 16 with one crossing in flight is worse than unbatched pipelining (1,136 ns versus 505 ns, bindings 5.4).

## 3. Runtime model, chosen for the boundary

### 3.1 Shape

Thread-per-core: one reactor, one single-threaded executor and one request arena per core, no work stealing, `!Send` tasks, completion semantics as the internal contract on every platform, owned buffers across every await, cross-core traffic only through explicit wakes (runtime section 7.1). Persistent worker threads for the process lifetime, which Windows requires anyway (I/O issued by a thread is canceled when the thread exits, runtime section 5.3) and which lets a .NET worker pay its 12,400 ns runtime attach once (bindings 5.6).

Why this shape is the cheapest for the boundary (design argument from the measurements): a request never migrates threads, so the arena is single-writer and accessors take no lock; a Python worker attaches once per batch and runs sync handlers at 36 ns per call (bindings 5.5); a .NET worker calls managed code at 2.7 ns (bindings 5.6); Node crossings are counted per batch, not per request, and the dispatcher round-robins batches across registered isolates so JS handler throughput scales with `worker_threads` count (bindings 6.4); tiers 0 to 2 never leave the worker at all.

### 3.2 Driver layer

`zero-io` wraps compio-driver's Proactor (native io_uring with polling fallback through its fusion driver, native IOCP, kqueue through polling, owned-buffer contract, BufferPool, cancel; runtime 2.7 and 2b) behind a small in-house trait: submit, poll, cancel, wake, buffer pool, datagram batch. Round 23 data shows compio at parity with tokio on HTTP (ntex tokio versus compio within 5 percent either way, runtime 3.1), so the driver is not the throughput lever; the trait exists so a custom io_uring backend can replace the Linux driver later for CPU-per-request work without touching HTTP (runtime 7.1). tokio multi-thread is rejected for the hot path (Send bound, stealing), glommio (Linux only), may (stack per connection, TLS hazards), SQPOLL and IOPOLL (idle CPU) (runtime 7.1).

### 3.3 Per operating system (runtime section 7.2)

- Linux: io_uring with SINGLE_ISSUER, DEFER_TASKRUN, COOP_TASKRUN, multishot accept, multishot recv over a provided buffer ring, registered ring fd; on kernels older than 6.1 run without the taskrun flags; on EPERM or ENOSYS (default Docker 25 seccomp blocks io_uring, runtime 2b) fall back to epoll with EPOLLET and eventfd wakes. One SO_REUSEPORT listener per core, optional SO_INCOMING_CPU, TCP_NODELAY on accepted sockets, TCP_DEFER_ACCEPT and TCP_FASTOPEN as listener options. Cross-core wake: msg_ring, eventfd on the fallback.
- Windows: one IOCP per core (NumberOfConcurrentThreads 1), GetQueuedCompletionStatusEx batches, FILE_SKIP_COMPLETION_PORT_ON_SUCCESS where XP1_IFS_HANDLES allows, one listener with SO_EXCLUSIVEADDRUSE and pre-posted AcceptEx calls distributed round-robin across cores, TransmitFile for static files, never SO_REUSEADDR. Wake: PostQueuedCompletionStatus. RIO only as a later QUIC optimization.
- macOS: kqueue with EV_CLEAR, EVFILT_TIMER, EVFILT_USER wakes, one listener whose accepted descriptors are handed to per-core reactors, sendfile(2) with headers and trailers. FreeBSD gets SO_REUSEPORT_LB per-core listeners.
- Buffers: per-core provided buffer ring on Linux; per-core pooled receive buffers on IOCP and kqueue; registered buffers plus send_zc_fixed only above about 10 KB (MSG_ZEROCOPY effectiveness threshold, runtime 1.2); plain send from a per-core slab for small responses.
- Timers: one hierarchical wheel per core, 1 ms precision (tokio's 6 levels of 64 slots design), feeding io_uring MULTISHOT timeouts and link_timeout, the GetQueuedCompletionStatusEx wait argument, or a single EVFILT_TIMER (runtime 5.2); 1 ms meets RFC 9002 kGranularity.
- Shutdown: stop accepting, per-core cancellation flag, drain to a deadline, cancel remaining operations (IORING_ASYNC_CANCEL_ALL, CancelIoEx, EV_DELETE), wait for every completion before freeing buffers; unbounded wait and timeout modes (runtime 5.3). Bindings wire host signals (Node process signals, Python signal module, .NET PosixSignalRegistration) to the same shutdown entry point; the core never installs signal handlers inside a host process.

### 3.4 Who owns the threads

The core spawns its workers in every host: the napi addon, the PyO3 module, the .NET cdylib and the standalone binary all call the same `zero_server_start`. Node's libuv loop and the Python or .NET main threads are handler targets, not I/O threads. Default worker count is `available_parallelism()` with a `threads` option; the Node facade keeps `clusterize` as a compatibility shim that forwards to this option (salvage section 4).

### 3.5 Allocator

Every Round 23 leader ships mimalloc or snmalloc (tfb 4.9). Both are C allocators, so they sit outside the memory-safe core and the dependency allowlist. Decision: the standalone binary and the TechEmpower entry enable a `alloc-mimalloc` feature (allowlist addendum: mimalloc, libmimalloc-sys, cc); the bindings ship on the system allocator by default, with per-core slabs and buffer pools keeping the hot path allocation-free, and the effect of mimalloc inside a cdylib loaded by Node, Python or .NET is unmeasured until the harness runs.

## 4. Crate layout

Workspace at `crates/` with the pamoja conventions (pamoja sections 2 to 8): resolver 2, `[workspace.lints]`, `#![cfg_attr(not(feature = "std"), no_std)]` with `default = ["std"]` in dual crates, bindings excluded from the workspace, `publish = false` xtask, an examples crate holding the conformance generator. Name availability on crates.io (pamoja section 2 and 16): `zero` is taken (Nick Cameron's crate), `zero-server`, `zero-core` and `zero-ffi` returned 404 (free); every other `zero-*` name below is unverified until probed. NuGet `ZeroServer.Core` is free (pamoja 16); PyPI names are unverified.

Foundation (no_std plus alloc):
- `zero-core`: `Error` enum copied in shape from pamoja-core (`#[non_exhaustive]`, variants Protocol, Io, Codec, Closed, Auth, Unsupported, Timeout, Limit), `Result`, the six-line `Codec<T>` trait shape, owned-buffer types, slot id encoding.
- `zero-limits`: the limit table of nostd section 7 and 14.4 as `const` defaults and a `Limits` struct.
- `zero-simd`: cpu feature dispatch token plus AVX2, SSE4.2, SSE2, NEON and SWAR kernels for request-target scan, header-value scan, header-name scan, CRLF search and WebSocket unmasking (http section 8.2). Audited crate (unsafe allowed at the dispatch call site). x86 detection over `core::arch` cpuid (availability under no_std unverified); if unavailable, cpufeatures is the single allowed exception (it pulls libc, which the TLS graph already contains; http 16).
- `zero-http-types`: `RequestHead {method, scheme, authority, path, fields}`, `ResponseHead`, trailers, bounded `Vec<(Name, Value)>` field storage with linear scan (no hashbrown default hasher on attacker-keyed data, nostd 12.4), the interned header-name id table, the compile-time status-line table, and the `Early` marker (h3 section 5).
- `zero-date`: IMF-fixdate formatter from a unix timestamp and the 20-byte integer formatter (http section 7).
- `zero-http1-codec`: head parser, field validation, chunked decoder and encoder, framing decisions, response serializer into a caller buffer; httparse wired in as a differential oracle behind a `parser-httparse` feature (http sections 7 to 9).
- `zero-hpack`: prefix integers, the RFC 7541 Huffman table and static table, dynamic table over a bounded arena, never-indexed policy (http section 11); the Huffman coder is shared with QPACK.
- `zero-h2-codec`: frames, stream states, flow control capped at 2^31-1, settings, RFC 9218 priority parsing, Extended CONNECT, RFC 9113 section 10.5 budgets (http 11).
- `zero-qpack`: RFC 9204 static table (99 entries, 0-based), field section prefix, encoder and decoder instructions, dynamic table with capacity 0 unless negotiated (h3 4.3, nostd 14.3).
- `zero-h3-codec`: QUIC varints, HTTP/3 frames, unidirectional stream type classification, settings, GOAWAY (nostd 14.3).
- `zero-ws-codec`: handshake computation, frame codec, in-place masking through zero-simd, streaming UTF-8 validation, close code rules (http 12).
- `zero-sse`: encoder and client-side decoder (http 13).
- `zero-router`: method dispatch, path matching, parameter decoding, dot-segment removal, router middleware and query-string mount semantics transferred from zero-server's router tests (salvage 2.3, 6.6).
- `zero-uri`, `zero-qs`, `zero-cookie`, `zero-mime`, `zero-multipart` (boundary scanner and part headers), `zero-json` (parser and a writer that serializes into the output buffer), `zero-base64`, `zero-protobuf` (varint, wire types, proto parser), `zero-grpc-frame`, `zero-jwt-codec` (compact form, header and claims, algorithm allow list), `zero-env` (dotenv syntax), `zero-metrics` (registry and Prometheus text renderer), `zero-trace` (W3C Trace Context), `zero-totp`, `zero-sdp`, `zero-stun-codec`, `zero-template` (compiled text template with HTML escaping for tier 2 template shapes such as fortunes).
- `zero-sql`: query AST, per-dialect rendering and identifier quoting (the transferable half of zero-server's ORM, salvage section 6), the `QueryPlan` value that tier 2 executes.
- `zero-pg-proto`, `zero-mysql-proto`, `zero-bson`, `zero-mongo-proto`, `zero-resp`: wire codecs (db section 5).

Audited (unsafe permitted per item, own lints table, nostd 4 and 12.7): `zero-simd`, `zero-crypto`, `zero-ffi`, `zero-plugin`.

std:
- `zero-crypto`: SHA-1, SHA-256, HMAC, PBKDF2, constant-time verify, JWT signature primitives, all over the rustls crypto provider (aws-lc-rs default, ring feature), `secrecy` and `zeroize` types (nostd 8, tls 6.1).
- `zero-io`: driver trait, compio-driver backend, per-core reactor, timer wheel, buffer pools, wake primitives, per-OS listener strategy, datagram batch API, kTLS socket calls.
- `zero-rt`: workers, request arena, tier dispatch, batch dispatcher, per-worker cache (tier 1), pipelining ring, Date block refresh, shutdown.
- `zero-http`: HTTP/1.1 and HTTP/2 transport adapters, `StreamTransport` and `ByteStream` (h3 section 5), response writer, keep-alive and limits enforcement, Alt-Svc emission, Expect 100-continue.
- `zero-tls`: rustls acceptor, certificate resolver with atomic swap, ticket rotation, session cache, OCSP stapler, optional mTLS, kTLS (tls sections 4 and 5).
- `zero-quic`: quinn-proto and quinn-udp adapter, CID allocator, eBPF steering program, 0-RTT policy, qlog hook (h3 section 4).
- `zero-h3`: request and response mapping over `zero-quic` streams using the two codecs, extended CONNECT shared with h2 (nostd 14.3).
- `zero-ws`: rooms, pools, broadcast, permessage-deflate behind a feature (http 12).
- `zero-static`: files, ETag, conditional requests, ranges, dotfile policy on every segment, sendfile and TransmitFile paths.
- `zero-compress`: in-house DEFLATE and gzip (RFC 1951 and 1952) for responses and WebSocket compression; brotli deferred behind a feature pending an allowlist decision (crate choice unverified, http 16).
- `zero-db`: adapter trait mirroring zero-server's sql-base surface, common `Value` and `Row` model, FFI-safe row buffers, per-core connection driver, statement cache, tier 2 plan executor; `zero-db-postgres`, `zero-db-mysql`, `zero-db-mongo`, `zero-db-redis`, `zero-db-sqlite` (libsqlite3-sys bundled, the one C exception, db section 6).
- `zero-auth`: JWT verify and sign, JWKS, sessions, CSRF, OAuth and PKCE, WebAuthn (CBOR and COSE), two-factor flows.
- `zero-policy`: the declarative rule engine behind tier 0: CORS, security headers, rate limiting with RFC 6585 and ratelimit-headers draft output, request ids, timeouts, trust proxy, body limits, bearer extraction.
- `zero-fetch`: outbound client (JWKS, OCSP, proxy routes, health probes).
- `zero-grpc`: server and client over `zero-h2-codec`, health and reflection.
- `zero-observe`: structured logs (off by default), spans, health and readiness handlers, metrics endpoint.
- `zero-webrtc`: signaling hub, STUN and TURN servers (salvage section 4 drops the media adapters).
- `zero-plugin`: loader for tier 4 dynamic plugins over the C ABI (vtable with abi version and register function).
- `zero-ffi`: `crate-type = ["lib", "cdylib", "staticlib"]`, the C ABI, cbindgen header, catch_unwind at every export.
- `zero-cli`: standalone server binary, migrations, `doctor` (reports io_uring availability, kTLS, HTTP/3 UDP reachability, DNS HTTPS record advice).
- `zero-server`: bundle crate re-exporting every capability behind a feature named without the prefix, chapter features checked against docs/capabilities.toml.
- `xtask` (unpublished) and `zero-examples` (unpublished; conformance generator, guides, the TechEmpower entry binary `zero-tfb`).

Bindings (out of workspace, own lockfiles): `bindings/node` (napi-rs cdylib `zero-node`, `packages/native` as `@zero-server/native`, `packages/core`, one `@zero-server/<capability>` facade per capability, `@zero-server/sdk` 2.0.0 as the bundle so existing users keep the package name); `bindings/python` (PyO3 `zero-python` native package, pure-Python hatchling packages per capability, metapackage); `bindings/dotnet` (`ZeroServer.Native` with `[LibraryImport("zero_ffi")]`, `ZeroServer.Core`, `ZeroServer.<Capability>`, metapackage).

## 5. Handler model: five tiers

From bindings section 6.2, with the boundary rules of section 2 applied.

- Tier 0, declarative routes, zero crossings: a route is a value (method, pattern, and one of static body, file or directory, redirect, probe, proxy target, rejection rule). The facade builds values; Rust owns matching, conditional requests, compression policy and the write path. CORS preflight, JWT failures, rate-limit rejections, body-too-large and CSRF failures are answered here.
- Tier 1, cached handlers, crossing only on a miss: registered with a key spec (path, selected query keys, selected headers, principal id from the verified JWT), TTL, stale-while-revalidate window and tag list; hits served from a per-worker sharded cache with no cross-thread lock; `cache.invalidate(tag)` is one call off the request path.
- Tier 2, data routes: the facade registers a `QueryPlan` (parameterized SQL text or a `zero-sql` AST, parameter bindings from path, query, claims, validated body fields, constants, or a random range for the benchmark shapes) plus a serialization shape (object, array, scalar, `zero-template` id) and validation rules. Rust pipelines the statements on the worker's connection and serializes binary columns straight into the response buffer. This tier carries db, query, updates, fortunes and cached queries with no bound-language code on the request path. Off the request path, the same executor backs the Node, Python and C# ORM facades through an async call (Promise, awaitable, ValueTask), where the 1.9 microsecond pipelined Promise cost (bindings 5.4) is acceptable.
- Tier 3, batched bound-language handlers: section 2.3. A handler returning "next" is middleware; middleware that only inspects headers or claims is expressed as tier 0 rules instead (bindings 6.3). Errors thrown by handlers map to the transferred error registry inside Rust so the error path never makes a second crossing.
- Tier 4, Rust: in-process crate (a user binary links `zero-server` and registers `async fn` handlers on the request and response types; this is the TechEmpower entry) or a dynamic plugin (cdylib exposing `zero_plugin_abi_version` and `zero_plugin_register(registry)`, handlers receiving the same opaque `ZeroRequest` and `ZeroResponse` handles and accessor functions the .NET binding uses, so the header is generated once). The dynamic form stays on the C ABI; that the Rust ABI is unstable across compiler versions is unverified in this research.

Pipelining and ordering: safe methods may run in parallel, responses leave in request order through a per-connection ring (http section 10); a tier 3 batch therefore carries requests from many connections and completion order is free.

## 6. Binding model per language

Shared shape (pamoja section 9): a generated contract tier (napi `index.d.ts`, PyO3 stub, cbindgen header mirrored by `[LibraryImport]`), a core package, one package per capability, a bundle. Conformance vectors (`conformance/vectors.json`, sections http1Parser, router, jwt, cookies, rateLimit, qpack, h3Frames, hex in and structure out) are regenerated by `zero-examples` in CI and asserted by all three bindings (pamoja section 10). The API surface the facades reproduce is salvage section 5 minus section 4; `api-surface.json` generated from zero-server's JSDoc is the contract check (salvage 2.4).

### 6.1 TypeScript (Node)

- Process-global core; each isolate (main thread and every `worker_threads` worker) loads the context-aware addon, stores per-isolate state with `napi_set_instance_data`, registers its own ThreadsafeFunction, and unregisters in an env cleanup hook (Node forbids sharing `napi_env` across workers, bindings section 2). The dispatcher round-robins batches across isolates.
- One ThreadsafeFunction call per batch; the JS side iterates slots through the pooled view object, calls the user handler, writes through sync accessors, and pushes the slot onto a per-worker completion array flushed by one `zero_batch_complete` call. A handler returning a Promise completes later through the same sync `respond` plus a microtask-scheduled flush; Rust never awaits a JS Promise (bindings 6.2).
- Integer arguments go through the `Whole<T>` checker pattern (napi truncates silently, pamoja section 9). Request bodies are `BufferSlice` views valid only inside the call, with `body.retain()` for later use. `napi = { version = "3", default-features = false, features = ["napi6"] }`, no `tokio_rt` (the core owns its threads).
- Facade: `createApp`, `app.get("/health", ok())`, `files("./public", { etag: true })`, `query("select ... where id = $1", { params: ["path.id"], shape: "object" })`, `cached({ ttl: "30s", key: ["path", "auth.sub"] }, handler)`, plain `(req, res) => ...` handlers, `app.ws`, `app.listen({ port, tls, http2, http3 })`; Model classes over the tier 2 executor; error classes over the transferred registry; `clusterize` shim. The vitest subset that asserts observable HTTP behavior runs against the facade through a `test/_shim/` module map (salvage 2.3).

### 6.2 Python

- Workers attach once per batch (`Python::attach`, 2,249 ns) and call sync handlers directly (36 ns per call) through a `#[pyclass]` view whose slot is reset per request; then detach. Under the GIL only one worker executes Python at a time; the others keep serving tiers 0 to 2 (bindings 6.2, 6.4).
- `async def` handlers are never run on the worker: the batch is posted to a dedicated asyncio thread with one `call_soon_threadsafe` per batch, and each coroutine completes through a sync call into Rust; documentation states sync handlers are the fast path.
- Packaging: abi3-py310 wheel for GIL builds plus version-specific wheels for free-threaded 3.13t and later (abi3 is ignored there), thread-safe `#[pymodule]` declaration as PyO3 0.28 and later assume (bindings section 3). Free-threaded scaling is unverified (3.13t was not installed for the measurements).
- `pyo3 = { version = "0.29", features = ["abi3-py310"] }`; pyo3-async-runtimes only for the asyncio bridge; pyo3-stub-gen as a dev tool outside the wheel graph (tls 6.6).

### 6.3 C#

- `DisableRuntimeMarshalling` assembly-wide, `AllowUnsafeBlocks`, `[LibraryImport]` with UTF-8 or byte spans, never `string` on the hot path (decode costs 14x the crossing, bindings 5.6), `[SuppressGCTransition]` only on trivial view accessors that never touch I/O, locks, exceptions or callbacks (Microsoft's stated conditions, bindings section 4), function pointers rooted for the process lifetime, `SafeHandle` per pamoja `NativeHandle.cs`, `GCHandle` for dispatch context, and resolver registration in a module initializer so no `[SuppressGCTransition]` P/Invoke binds before `NativeLibrary.SetDllImportResolver` runs (pitfall reproduced, bindings 5.6).
- One `[UnmanagedCallersOnly]` dispatch per batch; sync handlers run inline on the persistent native worker; `ValueTask` handlers continue on the thread pool and complete through a function pointer. Request type is a `ref struct` over the view; response bodies pinned with `fixed` for the write call only.
- Minimal API style facade: `app.MapGet("/users/{id}", Query.Object("..."))`, `Func<Request, Response>` handlers.

### 6.4 Body ownership rule, all three

Request bodies are borrowed views valid during the handler call, `retain()` copies once. Response bodies under 64 KiB are copied into Rust-owned buffers (88 ns for a short string in Node, 110 ns for 1 KiB in Python, bindings 5.4 and 5.5); above that they are transferred by reference with the no-mutation rule.

## 7. HTTP stack

- HTTP/1.1 (http sections 2, 8 to 10): in-house parser producing byte ranges into a caller-owned 64-entry header table, SIMD kernels through `zero-simd` on stable `#[target_feature]` safe functions (Rust 1.86), SWAR reference path property-tested against every kernel. Reject rather than tolerate every RFC-permitted ambiguity: both Transfer-Encoding and Content-Length (400 and close), any non-chunked request Transfer-Encoding, bare CR, obs-fold, whitespace before the colon, CR, LF or NUL in values, differing or overflowing Content-Length. Defaults: request line 8,192, 64 headers, 64 KiB head, 16 hex digits for chunk sizes.
- Response serialization: compile-time status-line table, a per-worker 37-byte Date block refreshed once per second by the timer wheel (Drogon's `datePos_` idea without the per-response check), immutable precomputed header blocks per route, allocation-free Content-Length, one vectored write per event-loop turn; HEAD, 204, 304 and 1xx never carry a body.
- Pipelining: parse every complete head in the buffer, sequence-numbered in-order response ring, parallel handling for safe methods only (RFC 9112 9.3), consecutive ready responses batched into one writev, in-flight cap 32, unread bodies drained to a budget or the connection closed.
- HTTP/2 (http 11): in-house sans-I/O `zero-h2-codec` with the RFC 9113 10.5 budgets (SETTINGS, PING, WINDOW_UPDATE, CONTINUATION, empty DATA, RST_STREAM sliding window; ENHANCE_YOUR_CALM), h2 defaults for reset limits (nostd 12.5), Extended CONNECT for WebSocket, prior-knowledge cleartext for gRPC, h2 and hyper as interoperability test peers, an optional std-only `h2-crate` feature until conformance passes.
- WebSocket (http 12): in-house codec, in-place SIMD unmasking, streaming UTF-8 validation (simdutf8 no_std build, or in-house if the allowlist rejects it), sha1 from `zero-crypto`, permessage-deflate feature-gated and off; the three Node audit bugs (head bytes lost after upgrade, continuation frames dropped, write after close) become conformance vectors.
- SSE (http 13): one chunk per event with immediate flush over HTTP/1.1, one DATA frame per event over HTTP/2, comment keep-alive every 15 seconds, Last-Event-ID exposed.
- Static files: ETag and conditional requests, ranges, dotfile policy per segment, sendfile on macOS, TransmitFile on Windows, io_uring send from registered buffers on Linux for large bodies; static routes are tier 0.

## 8. HTTP/3 and QUIC

- Transport abstraction shared with TCP and HTTP/2 (h3 section 5): `zero-http-types` values (`RequestHead`, `ResponseHead`, trailers, body chunks, `Early` marker); three front-end codecs (h1, h2, h3) produce the same values; thin std adapters expose `StreamTransport { poll_accept_stream, drain, peer }` and `ByteStream { read, write, finish, reset, stop_sending }` with owned buffers; optional capability traits `Datagrams` (quarter stream id, capsule fallback on h1 and h2), `RawStreams` (WebTransport), `EarlyData`, denied by default and checked by the router. The router, handler tiers, header map, date cache, JSON writer and database pipeline never learn the transport. GOAWAY-based drain is identical on h2 and h3. The h1 hot loop gets no dynamic dispatch (the adapters are monomorphized per transport; nostd 14.1).
- Crate versus in-house (h3 section 4): quinn-proto is the transport state machine, driven by the core's own reactor, with quinn-udp on readiness backends and the core's io_uring and IOCP batch path where available; in-house only the reactor integration, the CID allocator encoding the core index, the eBPF SK_REUSEPORT steering program, the 0-RTT policy layer and observability. An in-house QUIC is rejected: five funded stacks aged six to eight years still carry 185 to 378 open issues, and quinn-proto alone is 27,528 lines. HTTP/3 framing and QPACK are in-house no_std codecs (bounded grammar; static-only QPACK with capacity 0 and blocked streams 0 is a complete conformant implementation, which is what hyperium/h3 ships on the wire). h3 with h3-quinn and curl are interop test clients only; quiche (BoringSSL through cmake) and s2n-quic (tokio, s2n-tls) are excluded.
- UDP path per OS (h3 section 3): Linux one SO_REUSEPORT UDP socket per core, CIDs `[core index | random]`, eBPF steering by DCID for short headers and 4-tuple hash for long headers, msg_ring handoff for migrated connections when eBPF is unavailable, multishot recvmsg over a provided buffer ring with GRO, ECN and pktinfo cmsgs, UDP_SEGMENT plus sendmsg_zc, IP_PMTUDISC_PROBE and IP_RECVERR for DPLPMTUD, 1452-byte upper bound. Windows USO on, URO off until quinn issue 2041 resolves, IP_RECVECN best-effort, single-socket completion with CID handoff (per-core UDP steering on Windows is unverified). macOS development-grade single-datagram path with IP_RECVTOS.
- TLS seam (tls 8.2): `rustls::quic::ServerConnection` (`read_hs`, `write_hs` with `KeyChange`, `quic_transport_parameters`), the same certificate resolver, ticketer and staple as TCP, `alpn_protocols` extended by `h3` on the QUIC listener only. rustls QUIC types are std-only, so no_std stops at the codecs.
- When it ships (h3 8.1): `zero-h3-codec` and `zero-qpack` are first-class in the first release with conformance vectors; the UDP listener, `zero-quic`, steering program and Alt-Svc emitter are built and interop-tested after HTTP/2 conformance; compiled in under a cargo feature `http3` that is on in published binaries and off at runtime by default (`listen({ http3: false })`); promoted to default-on after the interop runner passes (handshake, transfer, retry, resumption, ecn, keyupdate, http3), a CPU-per-request measurement with GSO, GRO and ack frequency lands within the Fastly-style parity band of TLS over TCP, and NAT-rebinding tests exercise the steering fallback. Not a lever on the benchmark (TechEmpower drives wrk over HTTP/1.1).
- Policy: 0-RTT off by default (`max_early_data_size 0`); when enabled per listener, safe methods only on routes flagged `early_data`, everything else deferred to handshake completion, `Early-Data: 1` honored with 425 and forwarded by the proxy middleware. Passive migration and NAT rebinding from the start, no preferred_address, 20 s keep-alive default on QUIC listeners, server push rejected. Alt-Svc `h3=":<udp-port>"; ma=86400` on every h1 and h2 response only while the QUIC listener is bound with the same certificate and a UDP self-probe succeeds; `Alt-Svc: clear` for one ma period after disabling; operator DNS step `HTTPS 1 . alpn="h3,h2"` surfaced by `zero doctor`.

## 9. TLS and crypto

- Engine: rustls 0.23.x (0.24 as rustls-aws-lc-rs and rustls-ring when released), `default-features = false`, provider supplied by the host through `builder_with_provider` or `builder_with_details`, never `install_default()` inside the library (it may be called once per process and the core is loaded into Node, Python and .NET hosts; tls section 3). aws-lc-rs default on tier-one targets (post-quantum X25519MLKEM768, FIPS option, `prebuilt-nasm` on Windows CI); ring behind a feature for no_std, wasm and toolchain-constrained builds.
- Shipped `ServerConfig` (tls section 5): TLS 1.3 and 1.2; provider defaults with AES-256-GCM first; `ignore_client_order = true` for cipher suites; `alpn_protocols` h2 then http/1.1 (rustls picks the server's first match; a client offering nothing that matches gets `no_application_protocol`); `max_early_data_size 0`; `send_half_rtt_data false`; `TicketRotator` with 6 h rotation (12 h acceptance); session cache 256, configurable to 0; `require_ems` exposed as a strict option; certificate compression off; `enable_secret_extraction` only on kTLS listeners; `logging` feature off in release.
- Certificates: PEM through `rustls_pki_types::pem`, `ResolvesServerCert` for SNI and hot reload with an atomic `Arc<CertifiedKey>` swap and `keys_match` validation, default identity for unknown SNI, in-house OCSP stapler (AIA fetch through `zero-fetch`, thisUpdate and nextUpdate validation, refresh at half the remaining interval, last good staple on failure, refuse to start a must-staple certificate with stapling off), optional mTLS through `WebPkiClientVerifier` behind a feature. Option names mirror `lib/app.js` and `lib/fetch` (`allowHTTP1`, `minVersion`, `maxVersion`, `servername`, `ciphers`) so the Node facade keeps its shape (tls section 7).
- kTLS (tls section 4): in-house over libc (TCP_ULP, TLS_TX, TLS_RX, drain at a record boundary, cmsg handling for control records and TLS 1.3 KeyUpdate reinstallation), Linux only, opt-in per listener, AES-GCM and ChaCha20-Poly1305 only, TLS_TX_ZEROCOPY_RO only for static-file sendfile, fall back to user-space records on any failure, fallback exercised in CI with the tls ULP loaded. Not applicable to QUIC.
- `zero-crypto` wraps the same provider for SHA-1 (WebSocket handshake), SHA-256, HMAC, PBKDF2 (SCRAM), JWT algorithms, constant-time verification through `subtle`, secrets in `secrecy::SecretBox` or `Zeroizing` (nostd section 8).

## 10. Database layer

- Codecs (db section 5): in-house no_std plus alloc crates for PostgreSQL v3 (3.0 and 3.2 negotiation), MySQL and MariaDB, BSON plus OP_MSG, RESP2 and RESP3, sharing one fuzz harness and one conformance-vector format across bindings; redis-protocol is the documented fallback for RESP only (the sole candidate crate that builds no_std).
- Layout (db section 7, tfb 7.3): one I/O driver task per core per endpoint owning one socket, one write buffer, one FIFO in-flight queue with bounded `max_in_flight`, one statement cache; handlers enqueue encoded requests and read lazily; a small per-core pool (default 1) covers long transactions; blocking Redis commands get dedicated connections; no shared cross-thread pool (every shared-pool Round 23 entry was 5 to 20 times slower; issue 8790 resilience gate: survive a database restart at no more than 5 percent throughput cost).
- PostgreSQL: extended protocol only, one Sync per logical request, results matched by counting ReadyForQuery, binary format codes everywhere with in-house decoders for the common OIDs, per-connection LRU statement cache keyed by (SQL, parameter OIDs) with Close('S') on eviction, one-round-trip Parse plus Bind plus Execute plus Sync on misses, explicit BEGIN and COMMIT pipelined with their statements, SCRAM-SHA-256 from `zero-crypto`; single-statement batched updates (CASE or unnest, pre-generated per count).
- MySQL and MariaDB: CLIENT_PROTOCOL_41 and CLIENT_DEPRECATE_EOF, binary result sets, per-connection LRU over COM_STMT_PREPARE ids with COM_STMT_CLOSE on eviction, optimistic in-order sends on by default only for MariaDB (plus the 0xFFFFFFFF prepare-and-execute path), caching_sha2_password full path only over TLS or a Unix socket.
- MongoDB: no wire pipelining; per-core pool following CMAP (maxConnecting 2, generation invalidation), OP_MSG payload type 1 for bulk writes, exhaustAllowed on getMore, SCRAM-SHA-256 with speculative authentication; first release standalone plus replica-set primary discovery; full SDAM, retryable writes and change streams deferred.
- Redis: HELLO 3 with RESP2 fallback, per-core pipelined connection flushed after about 200 frames or at the end of the poll cycle, push frames routed to a subscriber channel, attributes stripped and attached; cluster and sentinel in the second release.
- SQLite: libsqlite3-sys `bundled` with the sqlite.org hardening options, SQLITE_THREADSAFE=2 with single-owner connections enforced in Rust, `sqlite3_prepare_v3` with SQLITE_PREPARE_PERSISTENT behind a per-connection LRU, each connection on a dedicated thread behind an async facade; engine-agnostic wrapper trait so a `sqlite-turso` feature can land when turso reaches 1.0. Recorded as the one deliberate exception to the memory-safe core.
- Tier 2 executor: `QueryPlan` from `zero-sql`, bindings resolved from the request arena, results serialized by the JSON writer or `zero-template` directly into the response buffer; multi-tenancy as a request-scoped predicate carried in the arena (never a process global, salvage 2.2); audit log as a write path on every driver; migrations and snapshot diff in Rust with migration files in the host language.

## 11. no_std boundary per crate

Rule (nostd section 3): a crate is no_std plus alloc when its inputs and outputs are byte slices, buffers or plain values and it never needs a clock, a socket, a file, a thread or an OS event queue. Proof: CI builds every no_std crate with `--no-default-features` on the host and cross-compiles it for thumbv7em-none-eabihf, because `#![no_std]` alone does not prevent std from linking through a dependency (pamoja ci.yml pattern).

| Crate | Boundary | Note |
| --- | --- | --- |
| zero-core, zero-limits, zero-http-types, zero-date | no_std plus alloc | zero-core needs alloc only for owned buffers |
| zero-simd | no_std | audited; cpuid detection in core (unverified) or cpufeatures |
| zero-http1-codec, zero-hpack, zero-h2-codec, zero-qpack, zero-h3-codec, zero-ws-codec, zero-sse | no_std plus alloc | pure functions of bytes and a small state struct; alloc for the HPACK arena and stream map |
| zero-router, zero-uri, zero-qs, zero-cookie, zero-mime, zero-multipart, zero-json, zero-base64, zero-protobuf, zero-grpc-frame, zero-jwt-codec, zero-env, zero-metrics, zero-trace, zero-totp, zero-sdp, zero-stun-codec, zero-template, zero-sql | no_std plus alloc | `#![forbid(unsafe_code)]`; fields as bounded Vec pairs |
| zero-pg-proto, zero-mysql-proto, zero-bson, zero-mongo-proto, zero-resp | no_std plus alloc | wire codecs; auth message construction only, hashing from zero-crypto |
| zero-crypto | std by default, `ring` feature for no_std | aws-lc-rs requires std; ring supports `os = "none"` targets |
| zero-io, zero-rt, zero-http, zero-tls, zero-quic, zero-h3, zero-ws, zero-static, zero-compress, zero-db and drivers, zero-auth, zero-policy, zero-fetch, zero-grpc, zero-observe, zero-webrtc, zero-plugin, zero-ffi, zero-cli, zero-server | std | sockets, threads, timers, TLS I/O, quinn-proto (std only), SQLite thread, cdylib |

rustls's record layer is no_std through the unbuffered API with a caller-supplied `TimeProvider`, but the production configuration runs with `std` on; the no_std path is a portability guarantee, not the shipped build (nostd section 2). QUIC cannot be no_std because quinn-proto and rustls's QUIC types are std-only (h3 risks, tls 8.2).

## 12. Dependency policy and allowlist

Two tiers (tls section 2 and 6): zero third-party crates in every crate that does not terminate TLS or cross the async I/O boundary, and a pinned allowlist elsewhere. Enforced by `[bans] allow` in deny.toml (any crate not listed is denied), `multiple-versions = "deny"`, `wildcards = "deny"`, `external-default-features = "deny"`, `build.allow-build-scripts` limited to the named crates, `build.executables = "deny"`, `[sources] unknown-registry` and `unknown-git` denied, `[advisories] yanked = "deny"` with every ignore carrying a reason and review date, licenses as pamoja (MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause, BSD-3-Clause, ISC, Unicode-3.0, Zlib; MPL-2.0 exception for cbindgen only; aws-lc-sys, ring and rustls-webpki verified to satisfy the list). `cargo deny check` runs once per manifest (workspace, bindings/node, bindings/python native).

Allowlist:

| Group | Crates | Constraint |
| --- | --- | --- |
| TLS engine | rustls, rustls-webpki, rustls-pki-types, untrusted, subtle, zeroize, once_cell | `default-features = false`; features std, tls12, provider; logging only in dev |
| Provider, default | aws-lc-rs, aws-lc-sys (0.24: rustls-aws-lc-rs) | non-FIPS by default; FIPS behind a feature never on in bindings |
| Provider, alternative | ring (0.24: rustls-ring) | no_std, wasm, toolchain-constrained builds |
| Provider transitive | getrandom, libc, cfg-if | libc also hosts kTLS and UDP socket option calls; no nix, no socket2 |
| Build helpers | cc, shlex, find-msvc-tools, cmake, dunce, fs_extra, jobserver | only under build.allow-build-scripts for aws-lc-sys and ring |
| Driver | compio-driver and its io-uring, polling, windows-sys, socket2 graph | behind the `zero-io` trait; exact transitive set measured with `cargo tree` before the first release (unverified here) |
| QUIC (feature http3) | quinn-proto with `default-features = false, features = ["rustls-aws-lc-rs"]`, quinn-udp, and their mandatory graph (bytes, lru-slab, rand, rand_pcg, rustc-hash, slab, thiserror, tinyvec, tracing, web-time) | own deny.toml addendum; feature off at runtime by default; `tracing` acceptance is an owner decision |
| Allocator (feature alloc-mimalloc) | mimalloc, libmimalloc-sys | standalone binary and benchmark entry only |
| SQLite | libsqlite3-sys (bundled) | the C exception, hardening options on |
| SIMD helpers | simdutf8 (no_std build), optionally cpufeatures | or in-house replacements if rejected |
| Node binding | napi, napi-derive, napi-build, napi-sys and their measured transitive set (32 crates with `default-features = false`) | lowest napiN that carries what the binding needs |
| Python binding | pyo3, pyo3-ffi, pyo3-build-config, pyo3-macros and their measured set (13 crates with abi3-py310); pyo3-async-runtimes for the asyncio bridge | pyo3-stub-gen dev-only |
| .NET and C | cbindgen (build only) | MPL-2.0 exception, `default-features = false` |
| Dev only (excluded by exclude-dev) | httparse (oracle), h2, hyper, h3, h3-quinn, rcgen, proptest, libfuzzer-sys, arbitrary | never in the shipped graph |

Kept off the list with reasons (tls 6.1): rustls-native-certs and webpki-roots (only behind an mTLS or upstream feature), instant-acme, ktls (in-house), brotli and zlib-rs (compression code is attack surface), log and tracing in the core (own observability surface), x509-parser and der (minimal DER walker in-house), tokio and tokio-rustls (the core does not use tokio).

Supply chain (tls 6.3 to 6.5, nostd 10): cargo-vet beside cargo-deny (import mozilla, google, bytecode-alliance, isrg, embark-studios, zcash; exemptions with a review date and owner; trust entries only for the rustls organization with expiration); every shipped cdylib built with `cargo auditable`; `Cargo.lock` committed in the workspace and each binding, `--locked` in CI and `--frozen` after `cargo fetch` for releases; `cargo vendor --versioned-dirs --locked` tarball as a release artifact; exact toolchain pin and Docker image by digest; `--remap-path-prefix` and `CFLAGS=-ffile-prefix-map`, `SOURCE_DATE_EPOCH`, and a CI job that builds the release cdylib twice and fails on a SHA-256 mismatch; CycloneDX SBOM plus `actions/attest` on every binary, wheel, nupkg and npm tarball through a reusable workflow (SLSA Build L3); weekly `cargo audit bin`, `cargo outdated` and `cargo geiger` inventory.

## 13. Security model

- Unsafe policy (nostd section 4 and 12.1): `unsafe_code = "forbid"` workspace-wide; four audited crates (`zero-simd`, `zero-crypto`, `zero-ffi`, `zero-plugin`) carry their own copied lints table with `unsafe_code = "deny"` and per-item allows, `// SAFETY:` comments enforced by `clippy::undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block`, `unsafe_op_in_unsafe_fn = "deny"`, `clippy::mem_forget = "deny"`; a CI script diffs the tables (Cargo replaces rather than merges package lint tables).
- Panic policy: `indexing_slicing`, `unwrap_used`, `expect_used`, `panic`, `arithmetic_side_effects` at deny in every no_std crate; every malformed input returns `Err`; `overflow-checks = true` in release so a missed checked operation panics rather than wraps; `panic = "unwind"` because the FFI crate must `catch_unwind` at every export (unwinding across `extern "C"` is undefined behavior and `abort` would crash the host process); the standalone binary may use abort.
- Release profile (nostd section 9): opt-level 3, `lto = "fat"`, `codegen-units = 1`, `overflow-checks = true`, `panic = "unwind"`, `strip = "symbols"`; Windows control-flow-guard through `.cargo/config.toml` target rustflags (ANSSI DENV-CARGO-ENV); a nightly hardened job with `-Z stack-protector=all` and `-Z sanitizer=cfi`; `readelf` checks for RELRO, BIND_NOW and non-executable stack. If overflow checks cost the Drogon comparison, they are relaxed only for `zero-simd`, never workspace-wide (unmeasured).
- Verification (nostd sections 5, 6, 12.6): Miri with strict provenance and many seeds on the audited and codec crates; ASan and TSan jobs; cargo-fuzz targets per parser entry point with RFC examples, STANDARDS.md vectors and every crash artifact as committed seeds, run `-O -a -s address`, weekly `-s thread` and `--careful` passes, on Linux (Windows fuzzing support is contradicted between sources); proptest round-trip laws; differential tests against httparse, h2 and hyper.
- Limits (nostd sections 7, 12.5, 14.4): request line 8,192; header field 8,192; 100 headers (parser table 64 by default, configurable to the limit); 32 KiB head; header read timeout 30 s; idle keep-alive 60 s; body idle 60 s; request total 300 s; body 1 MiB unless a route opts in; 1,000 requests per connection; 8 KiB initial buffer; h2 max_concurrent_streams 100, frame 16,384, header list 32,768, table 4,096, h2-crate reset defaults plus a 200-per-10-s reset window with ENHANCE_YOUR_CALM; h3 initial_max_streams_bidi 100, uni 3 plus allowance, 1 MiB connection data, 256 KiB per stream, 30 s idle, 1350-byte receive payload, SETTINGS_MAX_FIELD_SECTION_SIZE 32,768 explicit, QPACK capacity 0 and blocked streams 0 in the first release, QPACK integer cap 2^30, RESET_STREAM and STOP_SENDING window closing with H3_EXCESSIVE_LOAD. Every value configurable; the reset-window and h3 values are starting values, not measurements.
- Smuggling posture (nostd 7 and 12.2): the back-end rule in both roles: ambiguous framing is 400 plus close; TE obfuscation is an unknown coding, also 400 plus close.
- Hash flooding: no hashbrown default hasher on attacker-keyed maps; bounded Vec pairs with linear scan (nostd 12.4).
- Secrets: constant-time comparison through `zero-crypto::verify_mac` and `verify_token`; `PartialEq` never implemented on secret newtypes (a grep test); secrets in `SecretBox` or `Zeroizing`, allocated once at final size.
- Runtime posture: io_uring is disabled by default Docker 25 seccomp and on Google production servers over kernel exploit history (runtime 2b), so the epoll fallback is always tested and the operator documentation states what enabling io_uring means; kTLS opt-in with fallback in CI; 0-RTT off; server push rejected on every protocol.
- Regression catalog: the roughly 120 audit findings become failing-first tests in the core or the owning binding (identifier injection, Mongo operator injection, prototype pollution, decompression bombs, dotfile check per segment, percent-escape panics, JWT algorithm confusion, JWKS kid and alg matching, WebAuthn userVerified, TURN reflection and RFC 1918 relay, protobuf 64-bit varints, gRPC deadlines, WebSocket framing, fetch double write, tenancy as a process global, unbounded maps; salvage 2.2).
- Conformance registry: docs/STANDARDS.md (148 sources, 515 statements) migrated into docs/standards.toml and extended with RFC 9000, 9001, 9002, 9114 and 9204; each statement becomes a test name or a vector; `xtask standards --check` fails when a row has no test (pamoja 12, salvage 2.1).

## 14. Expected performance per TechEmpower test versus Drogon

Every expectation is a design argument until the self-run described in tfb section 7.1 produces numbers. Round 23 figures are from round23-ph.json (Citrine continuous run 2025-01-30, best RPS across levels); the basis names the Round 23 entries that already reach the expected band using the same techniques this design adopts (tfb 4.9 technique matrix, 7.3 mandatory techniques). Bindings on tiers 0 to 2 see the same numbers as Rust (bindings section 7: 0.97 to 1.00).

| Test | Drogon Round 23 | Required ratio | Expected zero-core band | Basis |
| --- | --- | --- | --- | --- |
| plaintext (pipelined) | 14,655,006 (levels 12.73M, 14.66M, 13.23M, 11.69M) | 1.10 at every level, zero errors | 27.5M best level, 22M at 16,384 connections (98 percent of the 40 GbE ceiling) | The top is the inbound link (28.0M times 174 bytes is 39 Gbit/s, tfb 3.10); faf 28.03M, libreactor 28.03M, may-minihttp 27.91M, aspnetcore-aot 27.77M reach it with fixed heads, cached Date, zero-copy parse and one write per pipelined batch, all adopted in section 7; ntex-plt reaches 24.9M on a per-core tokio runtime, so the runtime is not the limiter; the 16,384 level is the risk (Drogon 11.69M, ntex-plt 17.67M) |
| json | 2,474,350 | 1.10 (2.72M) | 2.85M to 3.05M | hyper 2.89M, ntex-plt 2.96M, may-minihttp 3.10M, libreactor-server 3.12M; the test is a 164 to 207 microsecond round trip at 512 connections (tfb 3.10) so gains come from the JSON writer serializing into the output buffer (section 4 zero-json) and no per-request allocation; Drogon builds a jsoncpp DOM per request (tfb 4.8) |
| db | 1,033,970 (drogon-core), 1,014,116 (drogon) | 1.10 (1.14M) | 1.25M to 1.35M | ntex-db 1.29M, ntex-db-compio 1.33M, may-minihttp 1.36M, xitca-web 1.27M; all with one connection per core, prepared statements, binary rows (section 10); tier 2 route, no bound-language code |
| query q=1 | 999,446 (drogon-core) | 1.10 (1.10M) | 1.25M to 1.40M | ntex-db 1.38M, may-minihttp 1.44M, xitca-web 1.25M with every statement written before the first read |
| query q=20 | 65,211 (drogon-core), 59,192 (drogon) | 1.25 (81.5K) | 86K to 89K | database-bound plateau shared by may-minihttp 88.1K, ntex-db 88.6K, salvo-pg 89.2K; the per-request Sync point and pipelined batch of section 10 reach it; Drogon's concurrent-callback pattern does not (tfb 3.4) |
| fortunes | 1,042,653 (drogon-core), 947,069 (drogon) | 1.10 (1.15M) | 1.15M to 1.30M | ntex-db-compio 1.20M, may-minihttp 1.33M, h2o 1.23M; `zero-template` renders with escaping into the buffer as yarte and sailfish do (tfb 4.9) |
| updates q=1 | 454,275 (drogon) | 1.10 (500K) | 475K to 520K | ntex-db-compio 478K, may-minihttp 475K, ntex-db 474K; Drogon is within 5 percent here, so this is the narrowest margin and rests on the single-statement update plus pipelined selects |
| updates q=20 | 39,419 (drogon-core), 24,034 (drogon) | 1.40 versus drogon-core (55K) | 55K to 58K | may-minihttp 58.5K, ntex-db 58.1K with pre-generated CASE or unnest statements per count; Drogon's ORM path issues one statement per row (tfb 4.8) |
| cached queries | no Drogon entry | not applicable | 2.5M at count 1, 1.0M at count 100 | h2o 2.85M and 1.06M, salvo-lru 2.39M and 1.41M; tier 1 per-worker cache with no cross-thread lock |

Per-language tier 3 expectations relative to a Rust tier 4 handler (bindings section 7, estimates): C# sync 0.70 to 0.90, C# async 0.50 to 0.80, TypeScript sync 0.30 to 0.50 per isolate and up to 0.80 with 3 or 4 worker isolates (multi-isolate scaling unmeasured), TypeScript async 0.20 to 0.40 per isolate, Python sync under the GIL 0.15 to 0.30, Python async through asyncio 0.05 to 0.15. The Node facade is scored against uwebsockets.js (2.73M json, 0.71M db) and ultimate-express rather than bare nodejs (tfb 4.7); tier 2 routes are expected to exceed the uwebsockets.js database numbers because those entries still run postgres.js in JavaScript.

## 15. Risks

1. No official round will certify the result (repository archived, Round 23 final); the claim rests on a self-run whose hardware differs, so ratios and the reference-server ceiling are published, not absolutes (tfb 1, 9).
2. Run-to-run variance across separate runs is unverified; the 10 percent margin derives from within-run noise (about 1 percent) and the 5.5 percent spread of the json top ten, and may need widening (tfb 3.11).
3. Node tier 3 is bounded by the single JS thread: even at 124 ns per crossing the handler body caps one isolate near 1M to 1.5M executions per second; the product story must push users to tiers 0 to 2 or worker isolates, and multi-isolate scaling is unmeasured (bindings section 7).
4. Python under the GIL executes one handler at a time regardless of worker count; free-threaded scaling and its wheel matrix are unverified (bindings section 7).
5. Adaptive batch size and multiple in-flight batches are load-bearing; getting them wrong reproduces the pamoja-style 30 microsecond round trip (bindings 5.4).
6. Security versus speed: the Rust leaders ship with overflow checks off, unsafe date caches and no error handling in the Stripped builds; keeping overflow checks on, panic unwind and full error handling may cost a few percent, unmeasured (tfb 7.3, nostd 13).
7. In-house HTTP/2 is the largest attack-exposed scope item; mitigations are the 10.5 budgets, RFC vectors, differential tests against h2 and hyper, fuzz targets, and the `h2-crate` fallback feature until conformance passes (http 16).
8. In-house HTTP/1.1 parser replaces a fuzzed zero-dependency crate; httparse stays as the differential oracle and every rejection rule is a fuzz dictionary entry (http 16).
9. compio-driver is pre-1.0 (0.19.2) and single-organization; the in-house trait limits but does not remove the cost of an API break (runtime risks).
10. io_uring is blocked by default Docker 25 seccomp; most container deployments run the epoll fallback, so it must be a tested path, and the CPU and memory claims for io_uring rest on documented mechanisms, not measurements (runtime risks).
11. Windows has no SO_REUSEPORT and no per-core UDP steering story, so accept and QUIC paths differ structurally and need their own conformance tests; Windows GRO is disabled in quinn-udp over an open bug; macOS has no GSO or GRO (runtime and h3 risks).
12. quinn-proto is std-only with a dozen mandatory crates including tracing, so the QUIC adapter cannot be no_std and adds a supply chain that cargo-deny and cargo-vet must cover (h3 and tls risks).
13. QUIC costs more CPU per byte than kernel TCP unless GSO, GRO, ack frequency and full-size packets all work (Fastly: 42 percent of TLS over TCP untuned), so the low-hardware-usage goal is at risk for HTTP/3 traffic on deployments missing any of them (h3 section 6).
14. rustls 0.24 moves providers into separate crates; the allowlist, deny.toml and every binding lockfile must be re-cut together (tls risks).
15. aws-lc-sys is 67 MB of C source needing NASM on Windows x86_64 unless prebuilt-nasm; ring calls itself an experiment; both land on every binding CI matrix (tls risks).
16. kTLS TLS 1.3 rekey is implemented in-house; a bug leaks plaintext or hangs a connection, so it stays opt-in with the fallback exercised in CI (tls risks).
17. Bundled SQLite in C contradicts the memory-safe goal; turso is pre-1.0 with about 80 unsupported C API functions and WAL-only journaling (db risks).
18. MySQL server behavior under optimistic back-to-back commands is unverified; pipelined sends default off on MySQL (db risks).
19. The MongoDB driver scope (SDAM, retryable writes, sessions, transactions) is the largest and least certain; the first release limits replica-set and sharded deployments (db risks).
20. In-house SCRAM, caching_sha2_password and SASLprep are security-sensitive without the RustCrypto crates; non-ASCII passwords need SASLprep or a documented limitation (db risks).
21. Two crypto providers in one build split getrandom into 0.2 and 0.4, which `multiple-versions = "deny"` flags; feature unification across bindings must be checked (tls risks).
22. OCSP stapling needs an outbound client and a DER encoder; a must-staple certificate with a broken responder becomes an outage unless the last-good-staple and startup-refusal rules are tested (tls risks).
23. Reproducible builds depend on unstable Cargo trim-paths; the two-build hash check is what exposes leftover absolute paths (tls risks).
24. NuGet trusted-publishing policies are per package id and PyPI's new-project cap will refuse several first-release packages; the pamoja rank order and hourly backfill workflow must carry over (pamoja risks).
25. The napi glue trips CodeQL rust/access-invalid-pointer per exported class; the paths-ignore config must carry over (pamoja risks).
26. Crate name availability for every `zero-*` name except `zero-server`, `zero-core` and `zero-ffi` is unverified; a collision forces a rename before the first publish.
27. All binding measurements are single-machine Windows numbers; sequential cross-thread latencies are Windows wake latency and differ on Linux, where TechEmpower runs (bindings risks).
28. Every effort figure in section 16 is judgment.

## 16. Effort

Assumptions: one senior Rust engineer, pamoja scaffolding copied as listed in pamoja sections 13 and 14, the salvage items reused as listed, no Python or C# binding in the first release. All figures are judgment (unverified), in engineer-days.

First release (plaintext, json, static files, router, WebSocket, Node binding):

| Item | Days |
| --- | --- |
| Repository scaffold from pamoja (workspace, xtask subset, deny.toml, workflows, Docker fmt and clippy, docs site skeleton, capabilities and standards registers) | 10 |
| zero-core, zero-limits, zero-http-types, zero-date, zero-simd (kernels, SWAR reference, property tests, Miri) | 12 |
| zero-http1-codec (parser, chunked, framing rules, serializer, httparse oracle, fuzz targets, conformance vectors from STANDARDS.md) | 20 |
| zero-io (compio-driver behind the trait, per-core reactor, timer wheel, buffer pools, wakes, Linux, Windows and macOS listener strategies, shutdown) | 20 |
| zero-rt (workers, arena and slot ids, tier dispatch, batch dispatcher with adaptive size and in-flight batches, Date refresh, per-worker cache) | 15 |
| zero-http (h1 adapter, pipelining ring, response writer, limits and timeouts, Expect handling) | 10 |
| zero-router (semantics and tests transferred from zero-server) | 5 |
| zero-json writer and parser (for /json and request bodies) | 6 |
| zero-static (ETag, conditional, ranges, dotfile policy, sendfile and TransmitFile) | 8 |
| zero-ws-codec and zero-ws (handshake, framing, SIMD unmask, UTF-8, close rules, rooms, the three audit vectors) | 12 |
| zero-policy subset (CORS, security headers, request id, trust proxy, body limits) as tier 0 rules | 6 |
| zero-ffi first cut (lifecycle, routes, accessors, response builder, batch completion, plugin vtable, cbindgen header, catch_unwind) | 12 |
| Node binding (napi cdylib, per-isolate TSFN dispatcher, pooled views, completion flush, TypeScript facade for createApp, routes, static, ws, listen, error classes, per-platform packages, release workflow, vitest shim for the reusable subset) | 24 |
| TechEmpower entry (zero-tfb), self-run harness with the pinned Drogon entry, profile and allocator tuning | 10 |
| CI (no_std cross-build, fuzz jobs, Miri, sanitizers, deny, vet, auditable, reproducibility check), conformance generator | 8 |
| Documentation and guides for the first release | 6 |
| Total | 184 (range 150 to 210) |

Feature parity with zero-server (salvage section 5 surface minus section 4 drops), on top of the first release:

| Item | Days |
| --- | --- |
| zero-hpack and zero-h2-codec with budgets, interop tests, h2-crate fallback; gRPC prior knowledge | 35 |
| zero-tls (rustls config, resolver, tickets, OCSP stapler, mTLS) and kTLS with CI fallback | 25 |
| zero-qpack and zero-h3-codec (no_std, vectors, fuzz) | 15 |
| zero-quic, zero-h3, steering program, Alt-Svc, interop runner, UDP paths per OS | 30 |
| Database codecs and drivers: PostgreSQL 45, MySQL and MariaDB 45, MongoDB 55, Redis 25, SQLite 18, shared Value and Row model, adapter trait and Docker test harness 18 (db section 8: 34 to 46 engineer-weeks) | 206 |
| zero-sql, tier 2 executor, ORM facade semantics (relations, observers, mutators in host language), migrations and snapshots, tenancy, audit log, views, procedures, triggers, query cache, replicas | 45 |
| zero-auth (JWT sign and verify, JWKS, sessions, CSRF, OAuth and PKCE, WebAuthn CBOR and COSE, TOTP, two-factor and trusted devices) | 35 |
| Body parsers (multipart, urlencoded, text, raw, download disposition) and zero-compress (DEFLATE, gzip) | 22 |
| Remaining zero-policy rules (rate limiting with headers, timeouts, logger, validate hooks) | 12 |
| zero-grpc (server, client, protobuf codec and proto parser, health, reflection, load balancing, deadlines, compression) | 45 |
| zero-observe (structured logs, metrics, tracing, health handlers) and zero-fetch | 30 |
| SSE runtime, zero-webrtc (signaling hub, SDP and ICE parsers, STUN, TURN with the audit fixes) | 35 |
| zero-cli (migrations, seeders, doctor), zero-env | 12 |
| Python binding (native package, attached-worker dispatcher, asyncio bridge, facades, wheels including free-threaded, guides) | 25 |
| .NET binding (LibraryImport mirror, batch dispatch, ref struct views, facades, NuGet trusted publishing) | 25 |
| Regression catalog tests from the audit, remaining vitest migration, api-surface checks across three languages | 18 |
| Documentation site, three-language guides, STANDARDS.md migration to standards.toml with the h3 RFCs | 25 |
| Total | 640 (range 550 to 750) |

Cumulative to feature parity: about 824 engineer-days (range 700 to 960). The database drivers are the largest block and can run in parallel with a second engineer, which shortens the calendar but not the effort.

## 17. What transfers from zero-server (by destination)

- docs/STANDARDS.md into docs/standards.toml as the conformance registry and test name generator (salvage 2.1).
- The 2026-09-27 audit findings as a numbered regression catalog (salvage 2.2).
- About 3,400 vitest cases that assert observable HTTP behavior, run against the Node facade through a module shim (salvage 2.3).
- The JSDoc-described API surface as `conformance/api-surface.json` checked against all three contract tiers (salvage 2.4).
- Router semantics, the error registry and status mapping, JWT verification and claim rules, the ORM's model and query description layer as tier 2 plan builders, the docs data format and its example runner, the scope manifest idea as docs/capabilities.toml (salvage 2.5, bindings 6.6).
- TLS option names from `lib/app.js` and `lib/fetch`, and the ALPN, h2-over-TLS and 0-RTT conformance statements unchanged (tls section 7).
- Limit constants already chosen in the Node code (1 MiB bodies, 4 MiB gRPC messages, 64 KiB SDP, 4096-byte session cookies) as `zero-limits` defaults (nostd 11).
- Dropped: the Node wire-protocol driver plan, the TypeScript conversion of lib/, the packages generator, hand-written types, cluster.js as a feature, debug.js default-on logging, HTTP/2 push, the WebRTC media adapters, E2EE helpers, the JSON file adapter, PluginManager, DatabaseView and Query.cache until a core design exists (salvage section 4).

