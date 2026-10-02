# zero core architecture, angle: pragmatic and fast

Date: 2026-09-30. Written from the ten research files in this directory (research-*.md, salvage-map.md), each of which cites the document it fetched, plus two measurements run in this task (measure-cargo-tree.txt from the earlier run, measure-tokio-tree.txt from this run). Every factual statement below names its research file or measurement; design decisions are marked as decisions, estimates as judgment, and anything not backed by a fetched source is marked unverified.

## 1. Summary

One Rust workspace named `zero-server` with about fifty `zero-*` crates in the pamoja layout: no_std plus alloc codecs and parsers at the bottom, one std runtime crate (`zero-io`) that owns the event loop behind an owned-buffer trait, protocol servers above it, an FFI crate, and Node, Python and .NET bindings outside the workspace. The runtime for the first release is tokio configured as one current-thread runtime per logical CPU, each with its own listener on Linux and a shared listener with handoff on Windows and macOS. That is the exact shape of the Round 23 entries ntex-plt (24.9M plaintext, 2.96M json), hyper (17.5M, 2.89M), ntex-db (1.29M db, 1.38M query, 1.13M fortunes, 474K updates) and xitca-web-unrealistic (28.0M, 3.02M, Stripped), all of which beat Drogon on every test they entered (research-techempower.md sections 3 and 4). The HTTP/1.1 parser, response writer, router, JSON writer, WebSocket codec and every database wire codec are in-house no_std crates; rustls terminates TLS; quinn-proto is the only other protocol-level crate and sits behind an off-by-default HTTP/3 feature. The runtime crate is the only place tokio types appear, so a compio backend and later a custom io_uring reactor replace it without touching the HTTP or database layers.

Priorities in the owner's order and how the design meets them:

1. Faster than Drogon: reached by copying the technique matrix of the Round 23 leaders (research-techempower.md section 4.9 and 7.3), not by the runtime choice; the same framework on tokio and compio landed within 5 percent either way (research-runtime-io.md section 3.1).
2. Fully non-blocking: tokio current-thread runtimes never block on I/O; the only blocking work (SQLite, file reads without sendfile) runs on dedicated threads behind channels.
3. Low CPU and memory per connection: no work stealing, no Send bound, one 8 KiB initial read buffer per connection grown on demand to the header cap (research-nostd-and-security.md section 7), bounded pipelining depth, per-core caches. No published figure exists for any runtime (research-runtime-io.md section 3.2), so the design carries a measurement gate rather than a number.
4. Maximum security: reject-not-normalize framing, the limit table, forbid(unsafe_code) outside four audited crates, overflow checks on in release, fuzzing per parser, the pinned allowlist with cargo-deny bans, cargo-vet, cargo auditable (research-nostd-and-security.md sections 4 to 10, research-tls-and-deps.md section 6).
5. no_std wherever no OS is needed: 28 codec and logic crates build for a target without std in CI (section 10).

## 2. Runtime model

### 2.1 Shape shared by every operating system

Decision: N worker threads, N = available_parallelism, each owning one `tokio::runtime::Builder::new_current_thread()` runtime with a `LocalSet`, so every task is !Send and per-request state carries no Arc or atomics. tokio's current-thread scheduler has a global and a local FIFO queue, no LIFO slot, and polls the I/O and timer drivers when idle or every 61 tasks (research-runtime-io.md section 2.2, docs.rs tokio). This is what hyper, axum, salvo and xitca-web-unrealistic run in the Round 23 tree (research-techempower.md sections 3.1 and 4.8, fetched TFB sources).

Cross-core traffic exists only for accept handoff (Windows, macOS), WebSocket room broadcast and cache invalidation, all through `tokio::sync::mpsc` to the target core; the receiving runtime is woken by mio's `Waker` (eventfd on Linux, per research-runtime-io.md section 2b). Nothing on the per-request path crosses a core.

Owned buffers across every await: the `zero-io` traits are `read_into(OwnedBuf) -> (Result<usize>, OwnedBuf)`, `write(OwnedBuf) -> (Result<usize>, OwnedBuf)` and `writev(Vec<OwnedBuf>)`. The tokio backend performs the read on readiness into the owned buffer (`try_read` after `readable()`), which is the direction compio's polling driver already takes (research-runtime-io.md section 7.1). Decision: this contract is fixed from the first commit because it is what makes the compio and io_uring backends drop-in later (section 15); it costs nothing on epoll and kqueue.

Timers: tokio's hierarchical wheel, 6 levels of 64 slots, 1 ms precision (research-runtime-io.md section 5.2). One per-core `DateService` task refreshes a 37-byte `Date: ...\r\n` block every second; the codec copies it (research-http-and-ws.md section 9). TechEmpower's verifier requires the Date to change within 3 seconds (research-techempower.md section 5), which a 1 s refresh satisfies.

Graceful shutdown in tokio's three parts (decide, signal, wait): close listeners, set a per-core cancellation flag, drain in-flight requests to a deadline, then either wait unbounded or `shutdown_timeout` (research-runtime-io.md section 5.3).

Allocator: mimalloc as `#[global_allocator]` in the standalone binary and the TechEmpower entry (every Round 23 leader ships mimalloc or snmalloc, research-techempower.md section 7.3), behind a default-on `mimalloc` feature in the bindings. It adds C code (libmimalloc-sys through cc, measured: mimalloc 0.1.52, libmimalloc-sys 0.1.49, cc, shlex, find-msvc-tools), which section 12 records as the second deliberate exception to the memory-safe core after SQLite.

Release profile: opt-level 3, lto fat, codegen-units 1, overflow-checks true, panic unwind for every cdylib (unwinding across extern "C" is undefined behavior, so `zero-ffi` catches panics; research-nostd-and-security.md section 9), panic abort permitted only in the standalone binary and the TechEmpower entry. The cost of overflow checks on the parser hot path is unmeasured; if the self-run shows a loss against the Drogon targets it is relaxed for `zero-simd` only (research-nostd-and-security.md section 13).

### 2.2 Linux

One `SO_REUSEPORT` listener per core created with socket2 (`set_reuse_port(true)` as hyper's and axum's TFB entries do, research-techempower.md section 3.1 attribution), backlog 1024 (ntex, actix), `TCP_NODELAY` on accepted sockets, `TCP_DEFER_ACCEPT` and `TCP_FASTOPEN` as listener options (research-runtime-io.md section 2b, tcp(7)). Thread affinity through `libc::sched_setaffinity` (xitca-web-compio and ntex pin workers, research-techempower.md sections 4.3 and 4.8). Kernel I/O is epoll through mio; io_uring is not used in the first release, which keeps the product identical inside default Docker 25 containers, whose seccomp profile blocks io_uring (research-runtime-io.md section 2b). Optional `SO_INCOMING_CPU` behind a setting.

### 2.3 Windows

Windows has no `SO_REUSEPORT` listener group and Microsoft documents `SO_REUSEADDR` as indeterminate for servers (research-runtime-io.md section 2b), so one listener socket with `SO_EXCLUSIVEADDRUSE` accepts on core 0 and hands each accepted `std::net::TcpStream` round-robin to a per-core runtime, which registers it with `TcpStream::from_std`. tokio on Windows runs mio's IOCP driver, which copies through an intermediate buffer per read and write (research-runtime-io.md section 2b, mio docs); that cost is accepted for the first release and removed by the compio IOCP backend in section 15. Affinity through `SetThreadAffinityMask` (windows-sys is already in the tokio graph on Windows, measured). Never set `SO_REUSEADDR`. `TransmitFile` for static files arrives with the compio backend; the first release reads files into owned buffers.

### 2.4 macOS and FreeBSD

macOS: kqueue through mio; Apple's `SO_REUSEPORT` does not distribute TCP (research-runtime-io.md section 2b), so the Windows accept-handoff shape is reused. No thread pinning (whether a supported macOS affinity API exists is unverified). FreeBSD is not a tier-one target; if built there, `SO_REUSEPORT_LB` per-core listeners apply (up to 256 sockets, research-runtime-io.md section 2b).

### 2.5 Blocking work

SQLite connections and file reads that cannot use sendfile run on dedicated threads with a bounded channel per core (research-db-drivers.md section 6). tokio's `spawn_blocking` pool is not used on the request path.

## 3. Crate layout

Bundle crate `zero-server` (the crates.io name `zero` is taken; `zero-server`, `zero-core` and `zero-ffi` returned 404 on 2026-09-29 and 2026-09-30, research-pamoja-template.md sections 2 and 16; every other name below is unverified for availability). Conventions copied from pamoja: `crates/<name>`, workspace version lockstep, `[lints] workspace = true`, one cargo feature per capability in the bundle, `docs/capabilities.toml`, `docs/standards.toml`, `conformance/vectors.json`, `crates/xtask`, `examples/` as `zero-examples` (research-pamoja-template.md sections 2, 7, 10, 12).

no_std plus alloc (built with `--no-default-features` on the host and cross-compiled for thumbv7em-none-eabihf in CI):

| Crate | Contents |
| --- | --- |
| zero-core | `RequestHead {method, scheme, authority, path, fields}`, `ResponseHead`, trailers, body chunk types, the `#[non_exhaustive] Error` enum (Protocol, Io, Codec, Closed, Auth, Unsupported, Timeout, Limit), `Result`, the six-line `Codec<T>` trait, the `Limits` struct with the section 12 defaults as `const` |
| zero-simd | detection token (cpufeatures on x86, compile-time NEON on aarch64) and the AVX2, SSE4.2, NEON and SWAR scan kernels; the one performance crate allowed unsafe |
| zero-http1-codec | request head parser, field validation, chunked decoder and encoder, framing decisions, status-line table, response serializer into a caller buffer |
| zero-date | IMF-fixdate formatter and parser from a u64 unix timestamp; integer to decimal |
| zero-uri | RFC 3986 parsing, percent decoding, dot-segment removal |
| zero-router | method and path matching, parameters, 404 and 405 and 501 semantics, router middleware and query-string mounts salvaged from zero-server |
| zero-json | writer that serializes into the output buffer; strict RFC 8259 parser with depth and size caps |
| zero-qs, zero-cookie, zero-mime, zero-base64, zero-multipart | query strings, RFC 6265 cookies, media types, base64 with slice encode, multipart boundary scanner and part headers |
| zero-hpack | prefix integer coder, RFC 7541 Huffman table, HPACK static and dynamic tables |
| zero-h2-codec | HTTP/2 frames, stream state machine, flow control, settings, RFC 9218 priority parsing, Extended CONNECT |
| zero-qpack | RFC 9204 static table (99 entries), field section prefix, static-only encoder and decoder, dynamic table behind capacity negotiation |
| zero-h3-codec | RFC 9000 varints, RFC 9114 frames, stream type demux, settings, capsules (RFC 9297) |
| zero-ws-codec | RFC 6455 framing, in-place SIMD unmasking, UTF-8 validation (simdutf8 no_std build), close codes, handshake accept value |
| zero-sse | WHATWG event stream encoder and decoder |
| zero-jwt-codec | compact serialization, header and claims, algorithm allow list, no signing |
| zero-proto | protobuf wire codec, .proto parser, gRPC 5-byte length prefix |
| zero-sql | query AST, per-dialect rendering, identifier and literal quoting |
| zero-pg-proto, zero-mysql-proto, zero-bson, zero-mongo-proto, zero-resp | wire codecs per research-db-drivers.md section 5 |
| zero-metrics-text, zero-trace, zero-env | Prometheus and OpenMetrics text renderer, W3C trace context, dotenv grammar |
| zero-sdp, zero-stun-codec | SDP and ICE candidate parsers, STUN message codec |

std:

| Crate | Contents |
| --- | --- |
| zero-io | the runtime seam: per-core runtimes, listeners per OS, owned-buffer `Stream` and `Listener` traits, timers, `DateService`, shutdown, datagram batch trait for UDP; backends `io-tokio` (default) and later `io-compio`, `io-uring` |
| zero-http | connection driver for HTTP/1.1 and HTTP/2, pipelining ring, in-order writer, handler ABI (tiers 0 to 4), static files, limits and timeouts enforcement, Alt-Svc emitter |
| zero-tls | rustls `ServerConfig` builder with the section 8 defaults, SNI resolver with hot reload, ticket rotation, OCSP stapler, kTLS (Linux, opt-in), TLS over the `zero-io` stream through rustls's buffered `ServerConnection` API driven with owned buffers |
| zero-ws, zero-sse-server | upgrade handling, rooms, pools, keep-alive comments, Last-Event-ID |
| zero-quic, zero-h3 | quinn-proto and quinn-udp adapter over `zero-io`, CID allocator, request mapping; feature `http3` |
| zero-crypto | SHA-1, SHA-256, HMAC, PBKDF2, constant-time compare (subtle), zeroization; wraps the rustls crypto provider for RSA, ECDSA and EdDSA so the workspace has one crypto library |
| zero-auth | JWT sign and verify, JWKS, OAuth 2.0 with PKCE and OIDC, bearer, TOTP, WebAuthn, sessions, trusted devices |
| zero-middleware | CORS, security headers, CSRF, rate limiting with RFC 6585 and draft ratelimit headers, request id, timeout, logger hooks |
| zero-compress | DEFLATE and gzip encoder in-house; brotli behind a feature (decision pending, section 14) |
| zero-db | adapter trait, `Value` and `Row`, per-core driver task, statement cache, per-core pool |
| zero-pg, zero-mysql, zero-mongo, zero-redis, zero-sqlite | drivers over the codecs; SQLite over libsqlite3-sys bundled |
| zero-orm | query execution, migrations and snapshot diff, tenancy predicate, audit write path, views, procedures, triggers |
| zero-grpc | server and client, metadata, deadlines, status, compression, keepalive, health, reflection |
| zero-observe | structured logs, metrics registry, tracing spans, health and readiness handlers |
| zero-webrtc | signaling hub, STUN server, TURN relay with the audit fixes |
| zero-fetch | outbound HTTP/1.1 client with TLS, redirects, RFC 9111 cache |
| zero-ffi | the C ABI (`crate-type = ["lib", "cdylib", "staticlib"]`), cbindgen header, status enum, thread-local last error, panic catching |
| zero-cli | migrate, seed, make targets, doctor |
| xtask, zero-examples | release, version, docs, site, standards, packages tasks; guides, conformance generator, `zero-bench-tfb` TechEmpower entry (publish = false) |

Bindings outside the workspace, as in pamoja: `bindings/node` (napi-rs cdylib plus `@zero-server/native`, `@zero-server/core` and one facade package per capability), `bindings/python/packages/*` (PyO3 native package plus hatchling packages), `bindings/dotnet` (`ZeroServer.Native` with `[LibraryImport("zero_ffi")]`, one project per capability). The existing npm scope `@zero-server` stays; `@zero-server/sdk` 2.0.0 becomes the bundle over the native package (salvage-map.md section 3).

## 4. Handler model

Five tiers, from research-bindings-and-handlers.md section 6, which rest on the measurements in its section 5 (napi-rs bare crossing 13.4 ns, `External` creation 874 ns, ThreadsafeFunction round trip 505 ns pipelined and 124 ns per item at 256 per batch; PyO3 attach 2,249 ns per foreign-thread attach versus 36 ns per call once attached; .NET reverse P/Invoke 2.7 ns):

- Tier 0, declarative routes: static bodies, files, redirects, probes, proxy targets, rejections (rate limit, JWT failure, CORS preflight, oversized body). Registered once as values; served by Rust with no crossing.
- Tier 1, cached handlers: key spec (path, chosen query keys and headers, principal), TTL, stale-while-revalidate, tag invalidation; per-core sharded cache; only misses reach tier 3.
- Tier 2, data routes: parameterized SQL text or a `zero-sql` AST plus bindings from path, query, claims or validated body, plus a serialization shape (object, array, escaped template). Rust executes on the per-core connection and serializes into the response buffer. This tier carries the TechEmpower db, query, updates and fortunes workloads for every binding.
- Tier 3, bound-language handlers, batched: per-core ready queues, adaptive batches of 1 to 256 with several batches in flight, request views as arena slot ids, response builder addressed by slot id, bodies as borrowed views with an explicit `retain()`.
- Tier 4, Rust: in-process `async fn(Req<'_>) -> Resp` spawned with `spawn_local` on the owning core (the TechEmpower entry and the Drogon-class path), and a dynamic plugin form on the C ABI vtable shared with the .NET binding.

Middleware in the bound language is a tier 3 handler returning "next"; header-only and JWT-only middleware is expressed as tier 0 rules. Handler errors map to the salvaged zero-server error registry inside Rust so the error path never makes a second crossing.

## 5. Binding model

The pamoja three-tier shape (generated contract, core package, one facade package per capability, bundle) for all three languages (research-pamoja-template.md section 9). Per language, from research-bindings-and-handlers.md sections 6.2 and 6.4:

- Node: process-global core; every isolate (main thread and each worker_threads worker) loads the context-aware addon, keeps instance data, registers its own ThreadsafeFunctions; the dispatcher round-robins batches across isolates; one TSFN call per batch; JS iterates slot ids through a pooled view object and answers through sync `respond` calls; a Promise-returning handler completes by calling the same sync `respond` later; Rust never awaits a JS Promise. `napi = { version = "3", default-features = false, features = ["napi6"] }` (32-crate graph measured, research-tls-and-deps.md section 2).
- Python: workers attach once per batch and call sync handlers directly; `async def` handlers are posted once per batch to a dedicated asyncio thread and complete through a sync call; `abi3-py310` wheels for GIL builds and version-specific wheels for free-threaded builds (scaling on 3.13t unverified); pyo3 0.29 with abi3 measured at 13 crates.
- .NET: `DisableRuntimeMarshalling`, `[LibraryImport]` with byte spans, one `[UnmanagedCallersOnly]` dispatch per batch with a `#[repr(C)]` batch descriptor, `[SuppressGCTransition]` only on trivial view accessors, function pointers rooted for process lifetime, SafeHandle per pamoja `NativeHandle.cs`, resolver registration in a module initializer.

Conformance: `conformance/vectors.json` gains sections `http1Parser`, `router`, `jwt`, `cookies`, `rateLimit`, `qpack`, `h3Frames` from the first release, and the 515 checklist statements of `docs/STANDARDS.md` migrate into `docs/standards.toml` so `xtask standards` renders them and `xtask links` checks the 148 URLs (research-pamoja-template.md sections 10 and 12, salvage-map.md section 2.1). The vitest subset that asserts observable HTTP behavior (about 3,400 cases) runs against the Node facade through a `test/_shim` module map (salvage-map.md section 2.3).

## 6. HTTP stack

- HTTP/1.1 head parser: in-house `zero-http1-codec` over `zero-simd` kernels (request-target scan, header-value scan, header-name scan, CRLF search), httparse wired in as a differential fuzzing oracle and behind a `parser-httparse` bring-up feature (research-http-and-ws.md sections 7 and 8). Rejections per RFC 9112: both Transfer-Encoding and Content-Length (400, close), any request TE other than exactly `chunked`, bare CR, obs-fold, whitespace before the colon, CR, LF or NUL in values, differing or overflowing Content-Length, missing or duplicate Host; request-line 8,192 octets, 64 header slots in the parser with a 100-field cap, 16 hex digits for chunk sizes (research-http-and-ws.md section 2, research-nostd-and-security.md section 7).
- Response writer: compile-time status-line table, the per-core Date block, precomputed immutable header blocks per route, allocation-free Content-Length, one vectored write per event-loop turn (research-http-and-ws.md section 9; this is the technique matrix of may-minihttp and ntex-plt in research-techempower.md section 4.9).
- Pipelining: parse every complete head in the buffer, sequence-numbered in-order ring, parallel handling only for safe methods (RFC 9112 section 9.3), batch consecutive ready responses into one writev, cap 32 in-flight heads, drain or close unread bodies (research-http-and-ws.md section 10).
- Router: salvaged semantics and tests from zero-server (router middleware, query-string mounts, precedence), implemented as a no_std matcher; the Node router today is a linear regex scan at 10.9 us per miss with 400 routes (salvage-map.md section 2.7), which the new matcher must beat by construction (unverified until measured).
- Static files: path policy on every segment (the audit's dotfile bug), ETag and Last-Modified with 304, byte ranges, per-core small-file cache with precomputed header blocks; sendfile and TransmitFile arrive with the compio backend.
- HTTP/2: in-house sans-I/O `zero-h2-codec` with HPACK, the RFC 9113 section 10.5 budgets (SETTINGS, PING, WINDOW_UPDATE, CONTINUATION, empty DATA, RST_STREAM with the sliding window from GHSA-qppj-fm5r-hxr3), Extended CONNECT for WebSocket, prior-knowledge cleartext for gRPC, h2 and hyper as interoperability peers, an optional std-only `h2-crate` feature until conformance passes (research-http-and-ws.md section 11, research-nostd-and-security.md section 12.5). Ships in the second release.
- WebSocket: in-house `zero-ws-codec`, strict minimal-length and control-frame rules, sha1 from `zero-crypto`, permessage-deflate feature-gated and off; the three Node audit bugs (head bytes lost after upgrade, continuation frames dropped, write after close) become conformance vectors (research-http-and-ws.md section 12).
- SSE: one chunk per event with immediate flush over HTTP/1.1, one DATA frame per event over HTTP/2, comment keep-alive every 15 seconds, Last-Event-ID exposed (research-http-and-ws.md section 13).
- JSON: `zero-json` writes directly into the output buffer (the yarte and sonic-rs pattern of the leaders; jsoncpp DOM building is Drogon's cost on the json test, research-techempower.md section 7.3).

## 7. HTTP/3 and QUIC

Transport abstraction shared by TCP plus TLS, HTTP/2 and QUIC (research-http3-and-quic.md section 5): `zero-core` holds the protocol-neutral `RequestHead` and `ResponseHead`; the three front-end codecs produce the same values; `zero-http` sees `StreamTransport { poll_accept_stream, drain, peer }` and `ByteStream { read, write, finish, reset, stop_sending }` with owned buffers; optional capability traits `Datagrams`, `RawStreams` and `EarlyData` are denied by default and checked by the router, so the HTTP/1.1 hot path carries no HTTP/3 dispatch (research-techempower.md section 6: the yardstick is HTTP/1.1 only).

Crate versus in-house: quinn-proto 0.11.18 as the sans-I/O transport state machine with `default-features = false, features = ["rustls-aws-lc-rs"]` so the workspace keeps one crypto provider; quinn-udp as the socket layer on the tokio backend; in-house only the reactor integration, the CID allocator encoding the core index, the eBPF `SK_REUSEPORT` steering program, the 0-RTT policy layer and qlog hooks. quiche (BoringSSL through cmake), s2n-quic (tokio-bound, s2n-tls), neqo (NSS) and msquic (C, beta binding) are excluded (research-http3-and-quic.md section 4, research-tls-and-deps.md section 8.3). HTTP/3 framing and QPACK are in-house no_std crates because RFC 9114 frames are seven varint-typed frame kinds and QPACK with capacity 0 and blocked streams 0 (the RFC defaults) is a complete conformant implementation (research-http3-and-quic.md section 4.3).

UDP path per operating system (research-http3-and-quic.md section 3): Linux one `SO_REUSEPORT` UDP socket per core, CIDs `[core index | random]`, eBPF steering by DCID for short headers and 4-tuple hash for long headers, cross-core handoff over the mpsc channel only for migrated connections when eBPF is unavailable, `UDP_SEGMENT` and `UDP_GRO`, `IP_PMTUDISC_PROBE`, `IP_RECVERR`, `IP_RECVTOS`, 1452-byte MTU upper bound; Windows USO on and URO off until quinn issue 2041 resolves, `IP_RECVECN` best effort, single-socket completion with CID handoff (per-core UDP steering on Windows unverified); macOS single-datagram path with `IP_RECVTOS`.

Ship plan (research-http3-and-quic.md section 8, research-nostd-and-security.md section 14.6): `zero-qpack` and `zero-h3-codec` ship in the first release as no_std crates with conformance vectors and fuzz targets; `zero-quic` and `zero-h3` land after HTTP/2 conformance, compiled in under the `http3` feature that is on in published binaries and runtime-off by default (`listen({ http3: false })`); Alt-Svc `h3=":<udp-port>"; ma=86400` is emitted only when the UDP listener is bound and a self-probe succeeds, `Alt-Svc: clear` for one `ma` period after disabling; promote to default-on after the interop runner passes, the CPU-per-request measurement lands within the Fastly parity band of TLS over TCP, and NAT-rebinding tests exercise the steering fallback. 0-RTT off (rustls `max_early_data_size` 0); when enabled per listener, only safe methods on routes flagged `early_data` with 425 on `Early-Data: 1`. Push is rejected, never implemented.

## 8. TLS and crypto

rustls 0.23.45 (the fix for RUSTSEC-2026-0285), `default-features = false`, provider aws-lc-rs on tier-one targets and ring behind a feature for no_std, wasm and toolchains without NASM or C++; `Arc<CryptoProvider>` supplied by the host through `builder_with_provider`, never `install_default()` from the library (research-tls-and-deps.md section 3). The measured minimum graphs: 15 crates linked with aws-lc-rs and std, 21 with build helpers; 14 with ring and no std (measure-cargo-tree.txt).

Shipped `ServerConfig` (research-tls-and-deps.md section 5): TLS 1.3 and 1.2, provider suite defaults with `ignore_client_order = true`, X25519MLKEM768 first, `alpn_protocols` h2 then http/1.1 (rustls picks the first server entry the client also offered), `max_early_data_size` 0, `send_half_rtt_data` false, TicketRotator with 6 h rotation, session cache 256 configurable to 0, `require_ems` exposed, certificate compression off, `enable_secret_extraction` only on kTLS listeners, `logging` feature off in release. Certificates through `rustls_pki_types::pem`, `ResolvesServerCert` for SNI with an atomic `Arc<CertifiedKey>` swap and `keys_match` validation, default identity for unknown SNI, in-house OCSP stapler task (AIA fetch through `zero-fetch`, thisUpdate and nextUpdate validation, refresh at half the remaining interval, serve last good staple, refuse to start a must-staple certificate with stapling off), optional mTLS through `WebPkiClientVerifier`.

TLS over the runtime seam: `zero-tls` drives rustls's buffered `ServerConnection` (`read_tls`, `process_new_packets`, `reader`, `writer`, `write_tls`) with the `zero-io` owned buffers, so tokio-rustls is not a dependency and the TLS layer moves with the backend. kTLS in-house on libc, Linux only, opt-in per listener, AES-GCM and ChaCha20-Poly1305 only, control-record and TLS 1.3 KeyUpdate handling with key reinstallation, `TLS_TX_ZEROCOPY_RO` only for static-file sendfile, fallback exercised in CI (research-tls-and-deps.md section 4). Second release.

`zero-crypto` supplies SHA-1 (WebSocket accept, SCRAM-SHA-1 for older MongoDB), SHA-256, HMAC, PBKDF2 and constant-time comparison through subtle, and wraps the provider's RSA, ECDSA and EdDSA for JWT so the workspace carries one crypto library. Secrets live in `Zeroizing` or `secrecy` types allocated once at final size (research-nostd-and-security.md section 8).

## 9. Database layer

From research-db-drivers.md sections 5 to 7 and research-techempower.md section 7.3: one I/O driver task per core per endpoint on the core's current-thread runtime, owning one socket, one write buffer, one FIFO in-flight queue with a bounded `max_in_flight`, one statement cache; handlers enqueue encoded requests and read lazily; a small per-core pool (default 1) covers long transactions and blocking Redis commands. Every shared cross-thread pool in Round 23 was 5 to 20 times slower (axum-pg-pool 70K versus ntex-db 1.29M on db).

- PostgreSQL: in-house `zero-pg-proto`, extended protocol only, one Sync per logical request, results matched by counting ReadyForQuery, binary format codes everywhere with in-house decoders for the common OIDs, per-connection LRU keyed by (SQL, parameter OIDs) with Close('S') on eviction, one-round-trip Parse plus Bind plus Execute plus Sync on misses, protocol 3.2 negotiation, SCRAM-SHA-256 from `zero-crypto` (ASCII passwords first, SASLprep documented as a limitation). Multi-query requests write every statement before reading the first reply; updates use a pre-generated single statement per count (CASE or unnest); the Drogon ORM path issues one statement per row, which is why it collapses to 24K at q=20.
- MySQL and MariaDB: in-house `zero-mysql-proto`, CLIENT_PROTOCOL_41 and CLIENT_DEPRECATE_EOF, binary result sets for prepared statements, per-connection LRU over COM_STMT_PREPARE ids, optimistic in-order sends on by default only for MariaDB (plus the 0xFFFFFFFF prepare-and-execute path), caching_sha2_password full path only over TLS or a Unix socket.
- MongoDB: in-house `zero-bson` and `zero-mongo-proto`, no wire pipelining, per-core CMAP-style pool (maxConnecting 2, generation invalidation), OP_MSG payload type 1 for bulk writes, exhaustAllowed on getMore, SCRAM-SHA-256 with speculative authentication; first release scope standalone plus replica-set primary discovery.
- Redis: in-house `zero-resp`, HELLO 3 with RESP2 fallback, per-core pipelined connection flushed after about 200 frames or at the end of the poll cycle, push frames to a subscriber channel, dedicated connections for blocking commands; cluster and sentinel later. redis-protocol 6.0.0 is the documented fallback because it already builds no_std.
- SQLite: libsqlite3-sys `bundled` with the sqlite.org hardening options (SQLITE_MAX_ALLOCATION_SIZE at or below 100,000,000, SQLITE_PRINTF_PRECISION_LIMIT 100000, SQLITE_TRUSTED_SCHEMA 0, DBCONFIG_DEFENSIVE), SQLITE_THREADSAFE 2 with single-owner connections enforced in Rust, `sqlite3_prepare_v3` with SQLITE_PREPARE_PERSISTENT behind a per-connection LRU, each connection on a dedicated thread behind an async facade; engine-agnostic wrapper trait with a `sqlite-turso` feature once turso reaches 1.0.
- Resilience gate from TechEmpower issue 8790: keep a per-request sync point, reconnect on connection loss, survive a database restart at no more than 5 percent throughput cost.

`zero-orm` keeps the salvaged model and query description layer (tables, relations, casts, pagination, tenancy predicate, audit write path, migrations and snapshot diff) as data over `zero-sql`; the fluent Model classes stay in each binding (salvage-map.md section 6).

## 10. no_std boundary per crate

Rule (research-nostd-and-security.md section 3): a crate is no_std plus alloc when its inputs and outputs are byte slices, buffers or plain values and it never needs a clock, socket, file, thread or event queue. Each such crate carries `#![cfg_attr(not(feature = "std"), no_std)]`, `extern crate alloc`, `default = ["std"]`, and CI proves it two ways: a host build with `--no-default-features` and a bare-metal cross-compile for thumbv7em-none-eabihf, because `#![no_std]` alone does not prevent std from being linked through a dependency.

| Crate | no_std | Why the line falls there |
| --- | --- | --- |
| zero-core, zero-http1-codec, zero-date, zero-uri, zero-router, zero-json, zero-qs, zero-cookie, zero-mime, zero-base64, zero-multipart, zero-hpack, zero-h2-codec, zero-qpack, zero-h3-codec, zero-ws-codec, zero-sse, zero-jwt-codec, zero-proto, zero-sql, zero-pg-proto, zero-mysql-proto, zero-bson, zero-mongo-proto, zero-resp, zero-metrics-text, zero-trace, zero-env, zero-sdp, zero-stun-codec | yes | pure functions of bytes and small state structs; no clock (the Date formatter takes a u64), no allocation beyond alloc; forbid(unsafe_code) |
| zero-simd | yes | core::arch kernels; the only performance crate allowed unsafe; SWAR reference path property-tested against every kernel |
| zero-crypto | no (std) | wraps the rustls provider (aws-lc-rs is std-only; ring supports no_std, so a `ring` feature can lower this line later, unverified) |
| zero-io, zero-http, zero-tls, zero-ws, zero-sse-server, zero-quic, zero-h3, zero-auth, zero-middleware, zero-compress, zero-db and drivers, zero-orm, zero-grpc, zero-observe, zero-webrtc, zero-fetch, zero-ffi, zero-cli | no (std) | sockets, TLS I/O, timers, threads, files, the runtime, FFI |

rustls itself is `#![no_std]` with alloc and its unbuffered API is no_std, but the QUIC connection types are std-only and aws-lc-rs is std-only, so TLS runs with `std` on in the product; the no_std path is a portability guarantee, not the production configuration (research-nostd-and-security.md section 2, research-tls-and-deps.md sections 3 and 8.2).

## 11. Dependency policy and allowlist

Two tiers (research-tls-and-deps.md section 6): zero third-party crates in every crate that neither terminates TLS nor sits on the runtime seam (every no_std crate above plus zero-http, zero-db and the drivers, zero-auth, zero-middleware, zero-orm, zero-grpc, zero-observe, zero-webrtc); a pinned allowlist elsewhere, enforced by `[bans] allow` in deny.toml so any crate not listed is denied.

Allowlist, grouped by the crate that introduces it, with the measurement or source:

| Group | Crates | Constraint |
| --- | --- | --- |
| Runtime (zero-io, default backend) | tokio 1.53.1 (features rt, net, time, sync, io-util only; no macros, no rt-multi-thread), mio 1.2.3, socket2 0.6.5, libc 0.2.189, bytes 1.12.1, pin-project-lite 0.2.17; on Windows windows-sys 0.61.2 and windows-link 0.2.1 | measured 2026-09-30 (measure-tokio-tree.txt): 6 crates on Linux and macOS, 7 on Windows; bytes is no_std plus alloc (research-nostd-and-security.md section 12.4) |
| Allocator | mimalloc 0.1.52, libmimalloc-sys 0.1.49; build: cc, shlex, find-msvc-tools | measured; feature `mimalloc`, default on |
| TLS (zero-tls, zero-crypto) | rustls 0.23.x (0.24 as rustls-aws-lc-rs and rustls-ring when released), rustls-webpki, rustls-pki-types, untrusted, subtle, zeroize, once_cell, aws-lc-rs and aws-lc-sys (default), ring (feature), getrandom, cfg-if; build: cc, shlex, find-msvc-tools, cmake, dunce, fs_extra, jobserver | measured (measure-cargo-tree.txt); licenses satisfied by the pamoja allow list without exception (research-tls-and-deps.md section 3) |
| SIMD and UTF-8 | cpufeatures 0.3.1 (depends on libc), simdutf8 0.1.5 (no_std build) | research-http-and-ws.md section 6.3; cpufeatures may be replaced by an in-house cpuid over core::arch (availability in core unverified) |
| HTTP/3 (feature http3, off by default in bindings' runtime settings) | quinn-proto 0.11.x with `default-features = false, features = ["rustls-aws-lc-rs"]`, quinn-udp 0.6.x, and their mandatory graph: bytes, lru-slab, rand, rand_pcg, rustc-hash, slab, thiserror, tinyvec, tracing, web-time, rustls-pki-types, getrandom 0.4; quinn-udp adds libc, socket2, windows-sys | research-tls-and-deps.md section 8.3; the transitive count was not measured with cargo tree (unverified); its own deny.toml addendum |
| SQLite | libsqlite3-sys 0.38.x `bundled`; build: cc | research-db-drivers.md section 2 |
| Node binding only | napi 3 (`default-features = false`, lowest napiN that carries what is needed), napi-derive, napi-build, and the measured 32-crate proc-macro graph | research-tls-and-deps.md section 2 |
| Python binding only | pyo3 0.29 with one `abi3-py3XX` feature and its measured 13-crate graph; pyo3-stub-gen dev-only | research-tls-and-deps.md section 2 |
| .NET and C | cbindgen 0.29 build-only (MPL-2.0 exception as in pamoja) | research-pamoja-template.md section 6 |
| Dev-only (excluded by `exclude-dev`) | httparse (oracle), h2, hyper, h3, h3-quinn, tokio-rustls, rcgen, proptest, libfuzzer-sys, arbitrary | research-http-and-ws.md section 7, research-nostd-and-security.md section 5 |

Explicitly not on the list: tokio-rustls (TLS is driven over the seam), log and tracing outside the http3 feature, serde and serde_json, http, hyper and h2 at runtime, x509-parser and der (in-house DER walker for AIA, serial and OCSP), ktls (in-house), redis-protocol (fallback only), core_affinity (libc and windows-sys calls instead), webpki-roots and rustls-native-certs (only behind an mTLS or upstream-TLS feature).

deny.toml, extending pamoja's: `exclude-dev = true`, `yanked = "deny"`, every `ignore` with a reason and review date, `[bans] allow` populated, `multiple-versions = "deny"` (one provider per build; two providers split getrandom into 0.2 and 0.4, measured), `wildcards = "deny"`, `external-default-features = "deny"`, `build.allow-build-scripts` limited to aws-lc-sys, ring, libmimalloc-sys, libsqlite3-sys, napi-build, pyo3-build-config and the ffi crate's cbindgen build, `build.executables = "deny"`, `unknown-registry` and `unknown-git` denied, run once per manifest (workspace, bindings/node, bindings/python native). cargo-vet beside cargo-deny with the mozilla, google, bytecode-alliance, isrg, embark-studios and zcash imports, exemptions with a named owner and review date, trust only for the rustls organization with an expiration. `Cargo.lock` committed everywhere, `--locked` in CI, `--frozen` after `cargo fetch` for releases, `cargo vendor --versioned-dirs --locked` tarball as a release artifact (aws-lc-sys alone is 67 MB). Every shipped cdylib built with `cargo auditable`. Reproducible builds: exact toolchain pin, Docker image by digest, `--remap-path-prefix` and `CFLAGS=-ffile-prefix-map` (the Windows control-flow-guard flag goes into `.cargo/config.toml` target rustflags per ANSSI DENV-CARGO-ENV, not `RUSTFLAGS`), `SOURCE_DATE_EPOCH`, and a CI job that builds the release cdylib twice and fails on a SHA-256 mismatch (research-tls-and-deps.md sections 6.2 to 6.5, research-nostd-and-security.md section 12.1).

## 12. Security model

- Lints: `[workspace.lints.rust] unsafe_code = "forbid"`, `missing_docs = "deny"`, `unsafe_op_in_unsafe_fn = "deny"`; in every no_std crate `clippy::indexing_slicing`, `unwrap_used`, `expect_used`, `panic`, `arithmetic_side_effects` at deny; `clippy::mem_forget` deny workspace-wide. The four audited crates (`zero-ffi`, `zero-simd`, `zero-crypto` as a provider wrapper, `zero-sqlite` over the C library) carry a copied lints table with only `unsafe_code = "deny"` changed, `// SAFETY:` comments enforced by `undocumented_unsafe_blocks` and `multiple_unsafe_ops_per_block`, and a CI diff against the workspace table (research-nostd-and-security.md sections 4 and 12.7). mimalloc and SQLite are the two recorded exceptions to the memory-safe core.
- Verification: Miri with strict provenance and many seeds on the audited and codec crates, ASan and TSan nightly jobs, `cargo fuzz run <target> -O -a -s address` per parser entry point with checked-in seeds from the RFC examples, the STANDARDS.md vectors and every crash artifact, a weekly `-s thread` pass and a `--careful` pass; fuzzing runs on Linux (Windows support in cargo-fuzz is contradicted between its README and the Rust Fuzz Book) (research-nostd-and-security.md sections 5, 6, 12.6).
- Limits (all configurable, research-nostd-and-security.md section 7): request line 8,192; header field 8,192; 100 headers; 32 KiB head; header read timeout 30 s; idle keep-alive 60 s; body read idle 60 s; request total timeout 300 s; body 1 MiB; 1,000 requests per connection; chunk extension 256; trailers 4 KiB; 8 pipelined requests (the codec allows 32 in-flight heads, the runtime default is 8); initial buffer 8 KiB. HTTP/2: 100 streams, 16,384 frame size, 32,768 header list, 4,096 table, h2's reset limits plus a 200 per 10 s reset window. HTTP/3: 100 bidi and 3 uni streams, 1 MiB connection and 256 KiB stream data, 30 s idle, 1,350-byte receive payload, `SETTINGS_MAX_FIELD_SECTION_SIZE` 32,768, QPACK capacity 0 and blocked streams 0.
- Smuggling posture: reject and close on any framing ambiguity, in both the standalone and behind-a-proxy roles (research-nostd-and-security.md section 12.2). Attacker-keyed fields are `Vec<(Name, Value)>` with a linear scan, never hashbrown's default foldhash (section 12.4).
- Secrets: `subtle::ConstantTimeEq` through `zero-crypto::verify_mac` and `verify_token`; no `PartialEq` on secret newtypes; `Zeroizing` and `secrecy` containers (section 8).
- FFI: ANSSI FFI rules (C-compatible types only, status codes as i32, opaque handles with constructor and destructor, single-language ownership, panic catching), cbindgen-generated header, thread-local last error (research-nostd-and-security.md section 12.1, research-pamoja-template.md section 8).
- Supply chain and provenance: cargo-deny, cargo-vet, cargo-audit bin weekly over released binaries, CycloneDX SBOM plus the nightly `-Z sbom` precursor, `actions/attest` on every binary, wheel, nupkg and npm tarball through a reusable workflow (SLSA Build L3), CodeQL for actions, csharp, javascript-typescript, python and rust with pamoja's paths-ignore for the napi glue (research-nostd-and-security.md section 10, research-pamoja-template.md section 11).
- Build hardening: PIE, NX, full RELRO and stack probes are rustc defaults on Linux; control-flow-guard on Windows through target rustflags; a nightly hardened job with `-Z stack-protector=all` and `-Z sanitizer=cfi` keeps the code CFI-clean; `readelf` checks in CI (research-nostd-and-security.md section 9).
- Regression catalog: the roughly 120 audit defects become failing-first tests; the core-level ones (identifier injection, Mongo operator injection, prototype pollution, decompression bombs, dotfile policy, percent-escape panics, JWT confusion, JWKS kid and alg, WebAuthn userVerified, TURN relay to loopback and RFC 1918, protobuf int64, gRPC deadlines, WebSocket framing, tenancy as a process global, unbounded maps) map to the crates above (salvage-map.md section 2.2).

## 13. Expected performance per TechEmpower test versus Drogon

Ground rules from research-techempower.md section 7.1: a self-run of the archived toolset at commit 523534bb with the unmodified Round 23 Drogon entry (Drogon commit 96919df4, `threads_num 0`, `is_fast true`, `connection_number 1`, SyncPlugin) on a three-machine layout with at least 40 GbE, five interleaved runs, ratios published with absolute numbers, error counters at zero, Realistic classification. Expectations below are the Round 23 numbers of the entries that share this design's runtime shape (tokio current-thread per core, hand-written HTTP/1.1, per-core PostgreSQL connection with pipelining); they are design arguments, not measurements of this code, until the self-run exists.

| Test | Drogon Round 23 | Expected zero core on the same hardware | Ratio | Basis (research-techempower.md sections 3, 4, 7) |
| --- | --- | --- | --- | --- |
| plaintext, best level | 14,655,006 (11.69M at 16,384) | 24.9M to 28.0M; 17.7M to 22.2M at 16,384; zero errors | 1.70 to 1.91 | ntex-plt on tokio 24,925,516 (Realistic); xitca-web-unrealistic on one tokio current-thread runtime per core 27,970,357 (Stripped); the 28.0M cluster is the 40 GbE inbound ceiling (section 3.10), so the deliverable is reaching it with zero errors at all four levels |
| json | 2,474,350 | 2.89M to 2.96M; 3.0M if the parser and JSON writer match may-minihttp | 1.17 to 1.20 | hyper 2,885,610 and ntex-plt 2,963,471 on tokio; may-minihttp 3,102,063 on epoll shows the hand-parser ceiling; the test is a 164 to 207 microsecond round trip per connection at 512 connections (section 3.10) |
| db | 1,033,970 (drogon-core) | 1.29M to 1.33M | 1.25 to 1.29 | ntex-db on tokio 1,294,048 with a tokio-postgres fork; ntex-db-compio 1,334,739; the in-house binary codec must at least match tokio-postgres (unverified until built) |
| query q=1 | 999,446 | 1.38M | 1.38 | ntex-db 1,378,950 with all statements written before the first read |
| query q=20 | 65,211 (drogon-core), 59,192 (drogon) | 88K to 89K | 1.35 to 1.50 | database-bound plateau shared by every leader (may-minihttp 88,108, ntex-db 88,589, salvo-pg 89,195) |
| fortunes | 1,042,653 | 1.13M to 1.20M; 1.33M with a may-minihttp-class template writer | 1.09 to 1.27 | ntex-db 1,134,702, ntex-db-compio 1,197,352, may-minihttp 1,327,379; this is the thinnest margin and the reason the escaped template writer serializes straight into the output buffer |
| updates q=1 | 454,275 | 474K to 478K | 1.04 to 1.05 | ntex-db 474,071, ntex-db-compio 477,805, may-minihttp 474,901; no Realistic Rust entry reached the 1.10 target (xitca-web-unrealistic's 560,808 uses a single sync point and is Stripped), so this target is at risk (section 14) |
| updates q=20 | 39,419 (drogon-core), 24,034 (drogon) | 58K | 1.47 versus drogon-core | ntex-db 58,143, may-minihttp 58,532; Drogon's ORM issues one UPDATE per row |
| cached queries, count 1 and 100 | no Drogon entry | 2.4M and 1.4M | not applicable | salvo-lru on tokio current-thread per core 2,391,162 and 1,410,295; the 2.5M count-1 target is close and unverified |

CPU per request and bytes per idle connection: no fetched source publishes them for any runtime (research-runtime-io.md section 3.2). Gates rather than numbers: bytes per idle connection at 10k, 100k and 1M connections on the tokio backend, and CPU per request by cgroup accounting on the HttpArena methodology, both recorded before the compio backend is compared (section 15).

Node binding: the tier 0 to 2 number equals the Rust number; tier 3 sync handlers on one isolate are expected at 0.30 to 0.50 of Rust and up to 0.80 with three or four worker isolates; the yardsticks are uwebsockets.js (2.73M json, 0.71M db) and ultimate-express, the only Node entries in the top tier (research-bindings-and-handlers.md section 7, research-techempower.md section 4.7).

## 14. Risks

1. updates q=1: every Realistic Rust entry lands at 1.04 to 1.05 times Drogon; the 1.10 target needs something the leaders do not do (for example the resilient single-sync batch with a fallback), which is unverified; the honest deliverable may be parity there plus the 1.47 ratio at q=20.
2. fortunes margin of 9 to 15 percent rests on the template writer; a serde-style two-pass render would lose the comparison.
3. overflow-checks on in release is unmeasured on the parser hot path; the fallback is relaxing it for `zero-simd` only.
4. Run-to-run variance across TechEmpower runs is unverified (only within-run noise of about 1 percent was measured), so the 10 percent margins may need widening.
5. No official round will certify the result; the repository is archived and the hardware differs, so every claim is a ratio from a self-run with the reference ceiling stated.
6. tokio on Windows copies through mio's intermediate buffers; Windows numbers trail Linux until the compio IOCP backend lands.
7. In-house HTTP/2 is the largest attack-exposed scope item; mitigations are the section 10.5 budgets, RFC vectors, differential tests against h2 and hyper, fuzz targets, and the `h2-crate` bring-up feature.
8. The in-house HTTP/1.1 parser replaces a fuzzed zero-dependency crate; httparse stays as the differential oracle.
9. tier 3 in Node is bounded by the JS thread (roughly 1M to 1.5M handler executions per second per isolate on the measurement machine); multi-isolate scaling and JSON serialization cost per handler are unverified.
10. Python under the GIL runs one handler at a time; free-threaded scaling is unmeasured and needs version-specific wheels.
11. The dependency allowlist grows with quinn-proto's twelve mandatory crates including tracing under the http3 feature; the owner decides whether tracing is acceptable in the shipped graph.
12. SQLite and mimalloc are C; both are recorded exceptions with hardening options and confined unsafe surfaces.
13. Brotli: an in-house encoder is large and no crate is on the allowlist; the first parity release may ship gzip and deflate only (decision pending, effort not counted).
14. rustls 0.24 moves providers to separate crates; the allowlist, deny.toml and every binding lockfile are re-cut together.
15. Effort figures are judgment; MongoDB and the auth stack (WebAuthn CBOR, COSE, attestation) are the least certain.
16. cpufeatures depends on libc; if the budget rejects it, the in-house cpuid over core::arch is unverified for availability in core.
17. NuGet trusted publishing policies and PyPI project names must exist before the first tag (research-pamoja-template.md section 18 risks).

## 15. Path to the custom reactor

The seam is `zero-io`: `Runtime::spawn_local`, `Listener::accept`, `Stream::read_into` and `write` with owned buffers, `Datagram::send_batch` and `recv_batch` with per-datagram ECN, destination and segment size, `Timer`, `DateService`, `Shutdown`. Nothing above it names tokio.

1. First release: `io-tokio` backend (this document).
2. Second backend: `io-compio` over compio-driver's Proactor (native io_uring with polling fallback through its fusion driver, native IOCP, kqueue through polling, owned-buffer contract, BufferPool, cancel), the design research-runtime-io.md section 7 recommends; Round 23 shows compio within 5 percent of tokio on HTTP, so the gain to prove is CPU per request and memory per connection, measured with the gates in section 13 before it becomes the Linux or Windows default.
3. Custom io_uring backend for Linux: SINGLE_ISSUER, DEFER_TASKRUN, COOP_TASKRUN, multishot accept, multishot recv over a provided buffer ring, registered ring fd, msg_ring wakes, link_timeout deadlines, IORING_ASYNC_CANCEL_ALL on shutdown, with the epoll fallback on EPERM or ENOSYS (default Docker seccomp) and the flag downgrades for kernels before 6.1 (research-runtime-io.md sections 2b and 7.2). sendfile, TransmitFile and kTLS zero-copy land with the completion backends.

The owned-buffer contract, the per-core placement and the handler ABI never change across the three steps, which is what makes this angle pragmatic rather than a rewrite deferred.

## 16. Effort

Engineer-days for one senior Rust engineer; every figure is judgment. First release scope: plaintext and json at the Round 23 targets, static files, router, WebSocket, TLS, the Node binding, and the TechEmpower self-run harness.

| Item | Days |
| --- | --- |
| Repository scaffold from pamoja (workspace, xtask, deny.toml, CI, release workflows, docs skeleton) | 5 |
| zero-core, zero-date, zero-uri, zero-simd (SWAR reference, AVX2, SSE4.2, NEON kernels, property tests) | 6 |
| zero-http1-codec with STANDARDS.md vectors, fuzz targets, httparse oracle | 9 |
| zero-io on tokio: per-core runtimes, listeners per OS, affinity, owned-buffer traits, timers, DateService, shutdown | 8 |
| zero-http: connection driver, pipelining ring, in-order writer, limits and timeouts, handler ABI tiers 0, 3 and 4, error registry | 7 |
| zero-router (salvaged semantics and tests), zero-json writer, zero-qs, zero-cookie parse | 5 |
| Static files: path policy, validators, ranges, per-core cache, MIME table | 4 |
| zero-ws-codec, handshake, server side, the three audit vectors | 5 |
| zero-tls: rustls over the seam, SNI resolver, hot reload, tickets, ALPN | 4 |
| zero-ffi minimum plus Node binding: napi cdylib, batch dispatcher, pooled views, TypeScript facade, per-platform packages, conformance runner, guides | 12 |
| zero-bench-tfb entry, self-run harness (toolset at 523534bb, pinned Drogon), tuning to the targets | 6 |
| Docs, README, CHANGELOG, security policy, release dry runs to crates.io and npm | 3 |
| First release total | 74 |

A calendar quarter holds about 63 working days, so the first release fits a quarter only with a second engineer taking the Node binding and the harness (the critical path is then about 56 days), or by deferring TLS hot reload, byte ranges and the Python packaging groundwork.

Feature parity with zero-server (cumulative from zero, including the first release):

| Area | Days |
| --- | --- |
| First release | 74 |
| HTTP/2 in-house (frames, HPACK, streams, flow control, budgets, interop versus h2 and hyper, fuzz) | 22 |
| zero-hpack sharing, zero-qpack, zero-h3-codec with vectors and fuzz | 12 |
| zero-quic, zero-h3, Alt-Svc, steering program, interop runner | 18 |
| Body parsers (json, urlencoded, text, raw, multipart with file sink) | 8 |
| Middleware set (CORS, security headers, CSRF, rate limit, request id, timeout, logger, validate hooks, cookie parser) | 12 |
| DEFLATE and gzip encoder in-house (brotli undecided, not counted) | 12 |
| Sessions, signed cookies, trusted devices, enrollment | 6 |
| zero-crypto (hashes, HMAC, PBKDF2, constant time, provider wrapper) | 8 |
| Auth: JWT, JWKS, OAuth 2.0 with PKCE and OIDC, bearer, TOTP, WebAuthn | 28 |
| Database codecs and drivers (research-db-drivers.md: 34 to 46 engineer-weeks; midpoint used) | 200 |
| zero-sql and zero-orm (AST, dialects, migrations, snapshots, tenancy, audit, views, procedures, triggers, full-text and geo rendering) | 30 |
| gRPC and protobuf (codec, .proto parser, server, client, health, reflection, balancing) | 28 |
| Observability (logs, metrics registry and text, tracing, health, fetch instrumentation) | 12 |
| WebRTC signaling, SDP and ICE parsers, STUN, TURN with the audit fixes | 24 |
| Outbound fetch client with cache | 10 |
| Python binding (batching, facade, wheels, stubs, guides) | 14 |
| .NET binding (FFI surface, LibraryImport, facade, NuGet) | 14 |
| CLI and typed env surface | 6 |
| kTLS, OCSP stapling, mTLS | 8 |
| Conformance migration (vitest shim, standards.toml, 515 test names) | 12 |
| Documentation site and guides in three languages for every capability | 12 |
| Feature parity total | 570 |

The database line dominates and carries the widest range (170 to 230 days); everything else is within about 20 percent of the figure shown (judgment). The compio backend (about 10 days) and the custom io_uring backend are not required for parity and are not counted.

## 17. Sources

All statements trace to the research files in this directory and the sources they cite: research-techempower.md (Round 23 results file round23-ph.json processed locally, TFB sources at commit 523534bb, Drogon sources and wiki, may_minihttp and faf sources), research-runtime-io.md (man7 io_uring, epoll, socket, tcp and udp pages, learn.microsoft.com IOCP, RIO and TransmitFile pages, FreeBSD and XNU kqueue, docs.rs tokio, mio, polling, monoio, glommio, may, compio, io-uring, Google kCTF post, Docker seccomp change, TechEmpower Round 23 announcement and issue 10932, HttpArena README), research-http-and-ws.md (RFC 9110, 9112, 9113, 7541, 6455, 7692, 8441, 9218, 9000, 9114, 9204, 9220, WHATWG SSE, Rust SIMD and target_feature docs, httparse, h2, hyper, hpack, h3, quinn-proto, quiche, s2n-quic, memchr, simdutf8, cpufeatures, base64, sha1, sha1_smol, httpdate, itoa, tokio-websockets, fastwebsockets, embedded-websocket, Drogon parser and response sources, Node CLI and API index), research-http3-and-quic.md (RFC 9000, 9001, 9002, 9114, 9204, 9221, 9297, 8899, 8470, 7838, 9460, WebTransport and QUIC-LB drafts, quinn, quiche, neqo, msquic, s2n-quic, h3, compio-quic, rustls quic, Linux and Windows UDP pages, Fastly, Cloudflare, Google, Facebook, WWW 2024 measurements), research-tls-and-deps.md (rustls docs and blog, aws-lc-rs, ring, graviola, kernel tls.rst, ktls crate, RustSec advisories, cargo-deny, cargo-vet, cargo-audit, cargo-auditable, cargo vendor and build docs, reproducible-builds.org, napi, pyo3, maturin, RFC 7301, 8446, 9325, 6066, 6960, 7633, memorysafety.org), research-bindings-and-handlers.md (napi.rs, nodejs.org N-API, pyo3.rs, pyo3-async-runtimes, learn.microsoft.com interop pages, local probes), research-db-drivers.md (PostgreSQL, MySQL, MariaDB, MongoDB, BSON, Redis and SQLite documentation and specifications, docs.rs driver crates, TFB database sources, turso), research-nostd-and-security.md (Rust reference and embedded book, Rustonomicon, rustc lints and mitigations, clippy, Miri, sanitizers, cargo-fuzz, libFuzzer, proptest, subtle, zeroize, secrecy, hashbrown, bytes, ANSSI guide, OWASP DoS sheet, nginx and hyper defaults, Node source defaults, h2 defaults and GHSA-qppj-fm5r-hxr3, RustSec, SLSA, GitHub attestations, CodeQL), research-pamoja-template.md (the zero-edge repository, crates.io and NuGet API probes, RFC 9000 and 9114), salvage-map.md (the zero-server repository, its audit memory, TechEmpower wiki, Drogon README, napi.rs, PyO3 and Microsoft Learn pages).

Measurements run in this task: measure-cargo-tree.txt (rustls graphs, 2026-09-29) and measure-tokio-tree.txt (tokio, socket2 and mimalloc graphs for x86_64-unknown-linux-gnu, x86_64-pc-windows-msvc and aarch64-apple-darwin, 2026-09-30, cargo 1.96.0).

Unverified in this document: availability of every crate name other than zero-server, zero-core and zero-ffi; the quinn-proto transitive crate count; whether the tokio `fs` feature adds crates; a supported macOS thread affinity API; the throughput cost of overflow checks; run-to-run TechEmpower variance; every effort figure; the relative speed of the in-house PostgreSQL codec against the tokio-postgres fork used by ntex-db; multi-isolate Node scaling; free-threaded Python scaling.
