# Status

Updated 2026-10-01. A session that changes the position updates this file in
the same commit.

## Position

- The workspace is scaffolded and verified: 31 release 1 crates with their
  lint tables, the three binding skeletons with smoke tests over
  `zero_version`, xtask with its ten tasks, the standards registry
  (`docs/standards.toml`, 515 statements with a release per row), the
  capability catalog, the API contract, the dependency policy (`deny.toml`,
  `deny/`), the supply-chain store, the CI, release and docs workflows. CI is
  green on every job except two checks that run as advisory until the release
  1 tests and documentation pages exist: `cargo xtask standards --check` and
  `cargo xtask docs --check`. Both block in the release preflight.
- `zero-core` holds the error model, the `Codec` trait, `OwnedBuf` (the
  fixed-capacity buffer that crosses the I/O seam by value), the 53-bit
  `SlotId` with its generation check and `next_generation`, the `Value` model
  with linear-scan objects, and the `Digest`, `Mac`, `Kdf` and `Rng` traits
  (`crates/zero-core/src/{buf,codec,slot,value,primitive}.rs`, 25 unit tests,
  no_std and thumbv7em green). `zero-date` holds `civil_from_days` and
  `days_from_civil` over every four-digit year (tested day by day across the
  whole range), `ImfFixdate` from a u64 unix timestamp with the RFC 9110
  section 5.6.7 example pinned by the `routing-10` standards row, and the
  20-byte `Decimal` formatter checked against `core::fmt` (16 unit tests).
  `zero-limits` holds every value of `DESIGN.md` section 10.4 as a `const`
  default in `http1`, `transport` (TLS, HTTP/2, QUIC and HTTP/3) and
  `services` (memory and batch budgets, WebSocket, gRPC, WebRTC, body and
  session), the `Limits` struct of nested per-protocol structs with
  `Limits::check` for the relations the parsers rely on, and a test that pins
  every default. Where the design gave no number, these defaults were chosen
  and are recorded in the commit body: `MAX_CONNECTIONS` 2^20,
  `WS_MAX_FRAGMENTS` 1,024, `WS_MAX_CONTROL_FRAMES_PER_SECOND` 64, and the
  HTTP/3 reset window equal to the HTTP/2 one (200 per 10 s).
  `zero-http-types` holds `Method` (the eight RFC 9110 methods as ids 0 to
  7; `parse` is case-sensitive and anything else, PATCH included, is
  unrecognized until its RFC is fetched and given an id), `StatusCode` (the
  44 codes of RFC 9110 section 15 with prebuilt `HTTP/1.1` status lines,
  classes, the x00 fallback, and `write_status_line` for any code in 100 to
  599 with the RFC 9112 section 4 bare-reason form; 429 and 431 from RFC
  6585 and 425 from RFC 8470 get table entries when those RFCs are fetched,
  which `zero-http1` and `zero-policy` need), `HeaderName` (49 interned
  names: the RFC 9110, 9111 and 9112 registrations in alphabetical order,
  ids 0 to 48, append-only; the WebSocket, CORS, cookie and security-header
  names join in the steps that fetch their documents), `Fields` (bounded,
  linear scan, case-insensitive names, values validated against RFC 9110
  section 5.5 on insert, `FieldError` mapped onto `zero_core::Error`),
  `RequestHead`, `ResponseHead`, `Trailers`, `BodyChunk`, `Scheme`, `Early`,
  and `escape_html` (the five OWASP entities). Standards rows `routing-28`,
  `h1-14` and `html-01` were added and `routing-07`'s field-name row now
  cites `field.rs`. The transport error enum of `DESIGN.md` section 6.1
  (the h2 and h3 error spaces) is deferred to the `zero-h3` codec step,
  which fetches RFC 9114.
  `zero-simd` holds the per-byte definitions (`scalar`), the SWAR kernels
  (`swar`: exact per-lane masks for the request-target, header-value, byte
  and CR/LF scans, a per-byte token scan, the unmask), the x86-64 kernels
  (`x86`: SSE2 and AVX2 behind the detection token), the AArch64 kernels
  (`neon`), the streaming `Utf8Validator` (state machine over the RFC 3629
  syntax, resumable across fragments, one-shot verdicts identical to
  `core::str::from_utf8` in position and length, standards row `utf8-01`),
  and the cached `Features` token read from `cpuid` and `xgetbv` on every
  build (compile-time features under Miri). The crate-root functions
  dispatch through the token to the widest kernel the CPU offers and
  otherwise to SWAR. Every kernel is checked against SWAR for every byte at
  every lane position and on random inputs from the in-crate xorshift
  generator (no proptest dependency), under Miri with a stride, and by the
  libFuzzer targets under `fuzz/`. `zero-http1` holds the request head
  parser (`head.rs`), the chunked decoder and encoder with the trailer
  parser (`chunked.rs`), the validating `ResponseWriter` (`response.rs`),
  the list and whitespace helpers (`list.rs`) and `Reject` (`error.rs`), 37
  unit tests of which three hold the allocation-free claim under the
  counting allocator, no_std and thumbv7em green; `conformance/vectors.json`
  carries its `http1Parser` and `responseSplitting` sections. `zero-sys`
  holds `alloc::Counting`, the system allocator with a per-thread count of
  allocations and reallocations (`crates/zero-sys/src/alloc.rs`, the one
  `unsafe impl` of the workspace so far, with its `SAFETY` comments), which
  test binaries and the measurement harnesses install as their global
  allocator. `zero-sys` also holds the first operating-system wrappers of R.3
  step 4 (`sockopt.rs`: `TCP_NODELAY` and `SO_REUSEPORT` through socket2,
  `SO_INCOMING_CPU`, `TCP_DEFER_ACCEPT`, `TCP_FASTOPEN`, `UDP_SEGMENT`,
  `UDP_GRO`, the path-MTU probe mode, `IP_RECVERR`, packet information, the
  received and sent type-of-service byte, each a `setsockopt` with one C
  `int` and a getter that checks the length the kernel wrote, and
  `SO_EXCLUSIVEADDRUSE` on Windows; `msg.rs`: `sendmsg` and `recvmsg` over
  borrowed `IoSlice`s, a control buffer and socket2's address storage, the
  slice count capped at 1,024; `cmsg.rs`: the control-message builder and
  walk, written without a pointer from libc's `cmsghdr` offsets and the
  length field's own type, total over any bytes; `affinity.rs`:
  `sched_setaffinity` on Linux, `SetThreadAffinityMask` on Windows, and
  `Unsupported` on Apple platforms). The crate depends on libc, socket2 and
  windows-sys at the versions the lockfile pins, is linted for
  `x86_64-pc-windows-msvc` and `aarch64-apple-darwin` from the Linux runner
  (CI's `rust` job), and its Linux tests run on real sockets (`#[cfg_attr(miri,
  ignore)]`); only the control-message codec and the allocator run under Miri.
  `zero-io` holds the seam traits, the per-core pool and date block, and the
  `io-tokio` backend (see "In progress", step 4). `zero-rt` holds the chunked
  arena, the slot state word, the tiers, the cancel flag, panic containment and
  the per-core workers with the status callback (step 5, first half).
  `zero-http` holds the HTTP/1.1 connection driver over the seam
  (`crates/zero-http/src/conn.rs`: one task per connection, the input block
  leased on readiness and returned when consumed, the pipelining ring of
  `ring.rs` with responses written in request order through one vectored
  write per turn, safe methods run beside each other and an unsafe method
  waits for everything before it, `Expect: 100-continue`, the head, body,
  idle, keep-alive and request-total timeouts of section 10.4 answered 408 or
  503 with `Connection: close`, 413 for a body past the limit, 417 for an
  unknown expectation, HTTP/1.0 persistence with `Connection: keep-alive`, the
  request cap, `Date` and `Server` on every response, and the drain rule), the
  tier 4 handler ABI (`handler.rs`, `call.rs`: `Handler::handle(&self, &mut
  Call)` returning a `!Send` future polled inline by the connection task, the
  request views and the response builder that validates every field once and
  refuses the framing names), the error registry (`error.rs`: every
  `zero_core::Error` variant mapped to a status and a code, the RFC 9457
  problem details body with `type`, `title`, `status`, `code` and a `detail`
  only for the client-side variants), the per-core accept loop with the
  request-memory budget that pauses accepts (`server.rs`), and the tests
  (`tests/driver.rs`, 24 cases through real sockets on two cores;
  `tests/no_alloc.rs`, the counting allocator over the whole path of a tier
  4 request: zero global allocations per request on a warm connection).
  Records are boxed and pooled per core and move by pointer between the pool,
  the ring and the handler future; the arena's slot ids address them from
  step 12, when the FFI needs the lease protocol. `Call::route` resolves a
  request against a `zero-router` table into the record's parameter ranges
  and answers the misses itself (404, 405 with `Allow`, 501, the automatic
  OPTIONS with `Allow` and `Content-Length: 0`, `OPTIONS *`, 400 for a target
  that is not a path), `Request::param` and `param_decoded` read the captured
  parameters, `Response::redirect` and `redirect_preserving` set the five
  `Location` statuses; `tests/routing.rs` drives all of it on the wire, and
  `tests/no_alloc.rs` routes every request, so the zero-allocation claim
  covers the router.
  The step 6 codecs: `zero-base64` (RFC 4648 base64 and base64url into a
  caller buffer or a `Vec`, padding on or off, every byte outside the
  alphabet, a wrong padding and non-zero pad bits refused, the Section 10
  vectors), `zero-mime` (the extension table `scripts/mime_table.py` writes
  from mime-db 1.54.0 with nginx's table breaking ties, 1,246 extensions as a
  sorted static with binary search; the RFC 9110 Section 8.3.1 media type
  value parser with quoted parameters; `negotiate` over `Accept` with the
  Section 12.5.1 precedence and Section 12.4.2 weights, `q=0` never selected),
  `zero-uri` (RFC 3986 component split, strict percent-decoding,
  `normalize_path` with unreserved octets decoded, hexadecimal digits
  uppercased and `remove_dot_segments`, reserved characters kept encoded, the
  query split at the first `?`), `zero-qs` (the URL Standard's
  `application/x-www-form-urlencoded` parser: split on `&`, empty sequences
  skipped, the first `=`, `+` to space, a bare `%` kept, UTF-8 without BOM with
  U+FFFD), `zero-json` (the buffer-direct `Writer` with one bit per open
  container and no allocation of its own; the strict parser into
  `zero_core::Value` with size and depth caps, the top-level and big-integer
  options, duplicate names resolved last-wins in place, escapes with surrogate
  pairs, invalid UTF-8 and lone surrogates refused; the 316 small cases of
  nst/JSONTestSuite under `tests/suite/` with its license, the two large
  nesting cases built by the test), and `zero-router` (a trie of static,
  `:param` and final `*` segments over paths normalized by `zero-uri`, 404,
  405 with `Allow`, 501 for a method token outside the eight, HEAD served by
  GET with the `head` flag, the automatic OPTIONS, mounts that own their
  prefix and come before the parent's catch-all, a trailing slash ignored
  unless `TrailingSlash::Strict`, 16 parameters and 64 segments at most,
  `resolve_target` with a caller scratch buffer, route introspection). Rows
  `routing-01` to `routing-06`, `routing-08`, `routing-14` to `routing-22` and
  `body-01` to `body-11` cite their tests.
  Every other crate is a skeleton with only its `VERSION` export. Every crate is at 0.1.0 and
  nothing is published to any registry.
- The repository is `molexxxx/zero-server`; the earlier Node SDK lives in
  `molexxxx/zero-server-node` and is out of scope for sessions working here.
- The brand work landed (`BRAND-REPORT.md`, `docs/brand.md`). The mark is the
  loop: a ring with one lit segment between two slots. Palette:
  `ink` #16140F, `surface` bone #F4EEE1, `gray-1` graphite #57534A, `gray-2`
  ash #A39E93, `hero` brass #CFAE45, `hero-mid` gilt #8C6A12 (the ring and
  hyphen on light pages only), `hero-deep` bronze #5F470F (text), `accent`
  flare #D9F542, `accent-deep` moss #688D00; every hue sits between 41 and 76
  degrees. Every mark file is written by `node scripts/brand.mjs` (the
  palette checks run first) and the animation plays once, one lap in eight
  ticks, resting at one-thirty. Files: `assets/` (`zero-logo.svg`,
  `zero-logo-dark.svg`, the bare `zero-symbol*.svg` for dark pages,
  `zero-icon.svg`, the three `-animated` variants, `zero-server-icon.png` for
  NuGet, and the four architecture diagrams, wide and narrow in light and
  dark, generated by `python scripts/architecture.py` from the palette with
  outlined Outfit and JetBrains Mono glyphs; never edit them by hand), the site copies
  in `web/assets/`, the generated copies in `docs/assets/`, `docs/brand.md`
  (palette, contrast table, usage) and `web/theme.css` (site tokens). The
  molexxxx profile shows a zero-server card (animated icon on light, bare
  symbol on dark, described as pre-release) and a separate zero-server-node
  card for the Node line. Still on the old
  palette: `crates/xtask/src/site/layout.rs` (`THEME_COLOR` and the inlined
  mark).
- The site generator renders for a base path: `layout::HOST` is
  `https://molexxxx.github.io`, `layout::DEFAULT_BASE` is `/zero-server/`
  (the GitHub Pages project site), and `cargo xtask site --base <path>` (also
  with `--verify`) renders for another, `/` included. Every link of the shell,
  the front page, the 404 page, the canonical URLs, the sitemap and
  `robots.txt` start at the base path, `data-root` carries it for `site.js`,
  `site --verify` refuses a tree rendered for another base path, and the link
  check reports a root-absolute link that leaves it. `catalog::SITE` (the
  absolute links of the committed tables) is
  `https://molexxxx.github.io/zero-server/docs`; the pdoc logo in `docs.yml`,
  the issue templates and `web/serve.mjs` (which serves under the base path,
  `--base /` for the root) point at the same address. Still on the dead
  `z-server.dev` address: the `homepage` fields of the Node packages under
  `bindings/node`, which belong to the binding step.
- The README (159 lines, audited 2026-10-01) opens with the animated lockup,
  states under the tagline that nothing is published or running yet, words
  its four rules as what the code is built to do, shows the diagram, one
  TypeScript sketch labeled as not runnable, a release list, the packages,
  standards and safety, and how to build. It has no benchmark section and no
  tables. Keep it that short: internals belong in `SECURITY.md`,
  `CONTRIBUTING.md` and `docs/`; update its Status list as releases land.
- The boundary probes under `bench/probes` have Windows and Linux results;
  the design's binding budgets rest on them (`SCAFFOLD-REPORT.md`).

## Decisions already made

- The product, the repository and the bundle crate are all named
  `zero-server`; capability crates are `zero-<capability>`; the foundation
  crate keeps the crate name `zero-core`. License: Apache-2.0 only.
- Design decisions are delegated: where the design records a default, use
  it; where it lists an open question with a recommended default, take the
  default and record it in the commit body. Do not stop to ask.
- Runtime: `io-tokio` by default, `io-compio` built and tested beside it
  from the first release; the custom io_uring reactor is deferred past
  release 3 (`DESIGN.md` section 5.3).
- The Node facade keeps the `@zero-server/sdk` name at 2.0; internally,
  host-language handlers are scored against their language's best
  TechEmpower entry and the Rust tier 4 entry against Drogon (`DESIGN.md`
  section 13). None of that reaches public text: the README, the site,
  package pages, crate docs and the profile card make no performance claims
  and name no other project (`RULES.md`, Conventions).
- The README header is the animated SVG logo; no GIF anywhere; the palette
  has no hue between 170 and 300 degrees (`BRAND-BRIEF.md`).
- The molexcloud-remake application is the final proof of the rebuild,
  after release 3 (`ROADMAP.md` R.8); nothing is done for it before then.
- Dependabot pull requests are left to the owner; a session never merges
  version bumps in bulk (`RULES.md`, Currency).
- Product truth for every README, docs and site change: primary users are
  TypeScript, Python and C# backend developers who want a Rust-grade server
  without writing Rust, Rust developers second, every skill level in scope.
  Principles: teach in every page (why, the specification section, the
  trade-off, a runnable example; readable by a junior, respected by a
  principal); measure or cite every claim; lead examples with the user's
  language with Rust beside it; keep the hot path in Rust; never make a user
  compile. Never fabricate throughput numbers, users, testimonials or
  published packages. The site and README meet WCAG 2.2 AA.
- The documentation site is GitHub Pages with GitHub Actions as the source
  (enabled 2026-09-30), at the default address
  https://molexxxx.github.io/zero-server/ until a custom domain is chosen.
  `pages.yml` runs on `workflow_dispatch` only until the site has pages.
- npm publishing uses trusted publishing over OIDC, never a stored token:
  npm retired the 2FA-bypass granular tokens' sensitive operations in August
  2026 and retires their publishing in January 2027 (github.blog changelog of
  2026-07-08, read 2026-09-30). `release-node.yml` publishes with the job's
  OIDC token and asserts npm 11.5.1 or later; each package names that
  workflow as its trusted publisher on npmjs.com. The owner configures the
  publishers; a session never creates or stores registry tokens.

## In progress

R.3 step 2, the foundation no_std crates, taken one crate per commit in the
order `zero-core`, `zero-date`, `zero-limits`, `zero-http-types`, `zero-simd`.
Done: `zero-core`, `zero-date`, `zero-limits`, `zero-http-types`, the
`zero-simd` reference layer (scalar definitions, SWAR kernels, the streaming
UTF-8 validator, the detection token, property tests, Miri), and the
`zero-simd` x86-64 kernels (SSE2 and AVX2 behind the token, every kernel
checked against SWAR for every byte at every lane position and on random
inputs, on a host with AVX2), the NEON kernels (clippy-clean for
`aarch64-unknown-linux-gnu` and compiled for it without std; their tests
against SWAR run only on an AArch64 host, so `ci.yml` gained an `arm` job on
`ubuntu-24.04-arm`; no AArch64 machine ran them yet), and the in-house
`cpuid` and `xgetbv` detection that every build uses (tested against the
standard library's answer on this host), and the libFuzzer targets under
`fuzz/` (`utf8_validate` against `core::str::from_utf8`, one-shot and
fragmented; `simd_kernels`, every dispatched and SWAR kernel against the
per-byte definitions; seeds under `fuzz/seeds/<target>`, dictionaries under
`fuzz/dictionaries`, the ignored corpus grown from the seeds; 20-second
smoke runs under address sanitizer found nothing). R.3 step 2 is complete
except for its AArch64 run, which only CI's `arm` job can provide.

R.3 step 3, `zero-http1`, has begun: `head.rs` holds the request head
parser (spans into the caller's buffer, a caller-owned `Field` table,
`Partial` or `Reject { status, close: true }`, the framing decision, the
`Host`, `Connection`, `Expect` and `Upgrade` reads) with the rule set of
`DESIGN.md` section 6.2 and tests named after rows `h1-01` to `h1-06`,
`h1-08`, `h1-09` and `h1-12`, which now cite `head.rs`. `chunked.rs` holds
the streaming `ChunkedDecoder` (checked chunk sizes with the digit cap,
bounded and ignored extensions, the trailer section reported as a span and
parsed by `parse_trailers` into a separate caller-owned table with the RFC
9110 section 6.5.1 drop list), `chunk_header` and `encode_chunk`; rows
`h1-10` and `h1-11` cite it. `response.rs` holds `ResponseWriter`, the
serializer into a caller buffer that validates every outbound field name
as a token and every value as a field-value, writes `Content-Length` from
`zero-date`'s `Decimal`, chunked framing, `Connection: close`, and
suppresses the body of a response to `HEAD` and of 1xx, 204 and 304 and
`Content-Length` on 1xx and 204; rows `h1-07`, the CR/LF/NUL rejection
row, the 1xx/204 `Content-Length` row and the 204/304 content row cite
it. `crates/zero-examples/examples/conformance_vectors.rs` generates
`conformance/vectors.json` with the `http1Parser` (30 cases) and
`responseSplitting` (10 cases) sections, asserting the crates agree with
every vector before writing; CI runs it from `crates/zero-examples/examples`
and diffs the file. The fuzz crate gained `http1_head` (never panics, every
proper prefix of a complete head is partial, spans stay inside the input)
and `http1_chunked` (whole and byte-wise feedings agree). The crate's unit
tests install `zero_sys::alloc::Counting` as the global allocator and show
that the head parser (complete, partial and rejected input), the chunked
decoder with the trailer parser, and the serializer (fixed length and
chunked) make no allocation (`crates/zero-http1/src/no_alloc.rs`), which is
the step's counting-allocator criterion. Still open in the step: the
httparse oracle, which the dependency rule blocks today: crates.io
reports httparse 1.10.1 as the newest stable release, published 2025-03-03,
more than twelve months ago, and the crate does not declare itself finished
(checked 2026-10-01); the parser's conformance vectors, property tests and
fuzz targets stand in for it until the owner decides on an exception or a
newer release appears. Also open: the 24 CPU-hour fuzz runs (only a schedule
can provide them), and `h1-13` (pipelining order), which belongs to the
connection driver of `zero-http` in step 5.

R.3 step 4 is complete on this machine; its Windows and macOS runs wait
for CI's `seam` job. `zero-sys` holds the socket options the design lists
for release 1 (section 4.2 row and 5.4), `sendmsg` and `recvmsg` with the
control-message codec (`cmsg_decode` fuzz target, Miri), and thread affinity.
The Linux tests set and read every option on real sockets and pass a packet
information message both ways over loopback. Not yet in the crate: kTLS
(release 2), `memfd_create` and `bpf(2)` (release 3). `zero-io` holds the
seam traits of section 5.2 (`seam.rs`: `Runtime`, `Listener`, `Stream` with
`read_leased`, `read_into`, `write` and `writev` over `OwnedBuf`, `Datagram`
with `DatagramMeta` and `Ecn`, `Timer`, `DateService`, `Shutdown`), the
per-core `Pool` with its lease counter, the `Date` block, and the `io-tokio`
backend (`tokio_rt`: `serve` with one current-thread runtime and `LocalSet`
per core, pinned on Linux, `SO_REUSEPORT` listeners per core on Linux and
the accept handoff from one listener on Windows and macOS, `TcpStream`
performing reads on readiness into a block leased at that moment and
returned on a spurious wake, the shutdown signal with `until`, the clock,
and a drain deadline). `tests/echo.rs` holds the step's echo test: one worker
per CPU, every connection echoed, and an idle connection holding no buffer
by the pool's own count. The Windows and macOS paths of both crates are
compile-checked by clippy for those targets and have run on no such machine
yet; CI's new `seam` job runs the two crates' tests on the three runners.
`tokio_rt::UdpSocket` implements `Datagram`: batches received and sent on
readiness through `zero-sys`'s `recvmsg` and `sendmsg` inside tokio's
`try_io`, with the destination address, the ECN codepoint and the GRO
segment size read from the control messages (`zero_sys::packet`, typed over
the libc layouts) and the source address, the per-datagram ECN and the GSO
segment size written into them (ECN per datagram and segmentation are
Linux; Apple platforms get packet information and the received type of
service; Windows carries the peer alone until `WSARecvMsg` arrives with the
completion backend). `tests/datagram.rs` passes batches over loopback and,
on Linux, ECN codepoints and an 1,800-byte buffer segmented at 600. Not yet
in `zero-io`: the `io-compio` backend (step 8).

R.3 step 5 is complete except for the part that needs the router. `zero-rt`
first half: `arena.rs` (the chunked per-worker arena over `zero-core`'s
`SlotId`, chunks added and never moved, a free list that hands indices back
with the next generation, records reset in place through the `Reset` trait,
`&mut` access through the worker's exclusive borrow and no `unsafe`),
`slot.rs` (the per-slot atomic state word of `DESIGN.md` section 7.3: `Free`,
`Parsing`, `WorkerOwned`, `Leased`, `Completing`, `Closed`, a 16-bit reader
count, the cancel flag and the 30-bit generation in one `AtomicU64`; `borrow`
is one compare-and-swap that checks the generation and the lease, `recycle`
refuses while a reader is counted in and bumps the generation; the
epoch-based index reuse, the loom model and the TSan race belong to step 12),
`tier.rs` (the five tiers), `cancel.rs` (the per-request cancel flag with a
waker), `contain.rs` (every poll under `catch_unwind`, a panic becomes
`Panicked` and the future is dropped), and `worker.rs` (`start` over
`zero-io`'s `serve`: every spawned task is contained, a task panic counts on
the core and reaches the status callback as `TaskPanic` while the core serves
on, `note_panic` counts one a connection task contained itself, and a panic
in the core's own loop stops that core and is reported as `WorkerPanic`; the
tests drive both through real connections). `zero-io`'s workers now count
the tasks a core spawned and drain them to the deadline after the per-core
future returns, so in-flight connections finish during a shutdown instead of
being dropped with the `LocalSet`. `zero-http`: see Position. The step's
exit criteria met here: pipelined responses leave in request order (the RFC
9112 section 9.3.2 test, row `h1-13`), a panicking tier 4 handler yields 500
and the connection and core stay usable, the counting allocator reports zero
global allocations per request on a tier 4 route. Rows `routing-11`,
`runtime-02`, `runtime-03`, `runtime-08`, `runtime-09` and `errors-01` to
`errors-07` cite the driver tests. Still open in the step: the 27 semantics
statements through the router and driver, which need `zero-router` (step 6);
`errors-08` (a consumer rule, for the client side when one exists),
`errors-09` (the 401 challenge belongs to `zero-policy`'s JWT step) and
`errors-10` (`Retry-After` on 429 and 503, with the rate limiter and the
batch dispatcher's 503 rule). Unverified: the RFC 9457 text was read from the
HTTP API working group's repository copy of the document, since the RFC
Editor is unreachable from this environment.

R.3 step 6 is in progress: the six crates are written and tested (see
Position) and the routing rows of the registry pass. Still open in the step:
the `router` section of `conformance/vectors.json`, the fuzz targets for
`zero-uri`, `zero-qs`, `zero-json` and `zero-router`, the 400-route miss
measurement against the 10.9 microsecond Node figure (the harness of step 7
measures it), and the router tests transferred from the Node repository,
which arrive with the corpus in step 13; until then the router's own tests
and the regression entries of `DESIGN.md` section 15 (a child mount keeps the
query string; a mount wins over an application-level `/*`) stand in.
Unverified: RFC 3986 was read from the uriparser project's copy and RFC 8259
and RFC 4648 from the rfc-translater project's copies (the English column),
because the RFC Editor is unreachable; the URL Standard from the WHATWG
repository's `url.bs`; the IANA media type registry is unreachable too, so
the extension table rests on mime-db's compilation of it.

## Next, in order

The work is `ROADMAP.md` section R.3, taken in order with the exit criteria
stated there. The first release's items:

1. Foundation no_std crates (R.3 step 2): `zero-core` (the `Codec` trait,
   `OwnedBuf`, the slot id encoding of `DESIGN.md` section 8.3 with its
   generation check, the `Value` model, the `Digest`, `Mac`, `Kdf` and `Rng`
   traits of section 4.3), `zero-limits` (section 10.4 as `const` defaults
   and a `Limits` struct), `zero-http-types` (section 4.1 row), `zero-date`
   (IMF-fixdate from a u64, civil-from-days, the 20-byte integer formatter),
   `zero-simd` (the SWAR reference kernels first, then AVX2, SSE4.2 and NEON
   behind runtime detection, every kernel property-tested against the SWAR
   path; the streaming UTF-8 validator tested against `core::str::from_utf8`).
   Every public item documented; every parser-like function fuzz-targeted;
   `--no-default-features` builds green.
2. HTTP/1.1 codec (R.3 step 3): `zero-http1` with the rule set of
   `DESIGN.md` section 6.2, the outbound validator of 6.3, fuzz targets, the
   httparse oracle behind a dev feature; the `http1Parser` and
   `responseSplitting` vector sections; the registry's HTTP/1.1 rows turn
   green one by one (`cargo xtask standards --check` names each by id).
3. Site base path: done (see Position). `pages.yml` stays on
   `workflow_dispatch` until the documentation pages and the web tree exist
   and `cargo xtask site --verify` passes on a rendered tree.
4. `zero-sys` and `zero-io` on tokio (R.3 step 4), `zero-rt` with
   `zero-http` (step 5), and the router with the small codecs (step 6): done
   except for the parts named under "In progress". Next: the `router` vector
   section and the step 6 fuzz targets, then the benchmark harness and the
   thesis measurement (step 7), then steps 8 to 14 to the release 1 tag.

Before writing code for an item: read the roadmap entry, the design sections
it cites, and the research note for the area; fetch every standard the code
implements and work from its text (`RULES.md`, Standards-first).

## Commit protocol (work in chunks, lose nothing)

- A chunk is one coherent unit that compiles and passes its tests: a module
  with its tests, a group of conformance statements with their tests, a
  kernel with its property tests. Aim for a commit every hour or two of
  work, never a day's work in one.
- Before every commit, from the repository root:
  `cargo fmt --all -- --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`,
  `cargo check -p <crate> --no-default-features` for every no_std crate
  touched, `cargo run -p xtask -- lints --check`,
  `cargo run -p xtask -- version --check`; and when a dependency changed,
  `cargo deny check` (cargo-deny 0.20.2) and `cargo vet --locked`
  (cargo-vet 0.10.2, installed with `cargo install --locked --version`),
  plus the three audits CI runs beside the root one: `cargo deny
  --manifest-path bindings/node/Cargo.toml --config deny/node.toml check`,
  the same for `bindings/python/packages/native/Cargo.toml` with
  `deny/python.toml`, and `cargo deny --manifest-path crates/zero-io/Cargo.toml
  --features io-compio --config deny/io-compio.toml check`. Every change to
  `deny.toml` is mirrored into `deny/node.toml`, `deny/python.toml`,
  `deny/io-compio.toml` and `deny/http3.toml`, and the two binding lockfiles
  the audits update are committed with it.
- Commit subject: short, imperative, what changed; body: why, the standard
  sections fetched with their URLs, anything unverified. No planning
  vocabulary, no attribution of any tool. Then `git push origin main`. If the
  push is rejected, `git pull --rebase origin main`, rerun the checks, push
  again. Never force-push, never amend a pushed commit.
- Keep the tree compiling at all times. If a unit cannot be finished, revert
  to the last commit rather than committing a broken state, and describe
  what remains under "In progress" above in a commit of its own.
- Every commit that moves the position updates "Position", "In progress"
  and "Next" above.

## Environment for a fresh Linux session

- Rust: `rustup` stable with `rustfmt` and `clippy`
  (`rustup component add rustfmt clippy`); the bare-metal check needs
  `rustup target add thumbv7em-none-eabihf`. `rust-toolchain.toml` pins the
  channel.
- `cargo install --locked cargo-deny --version 0.20.2` and
  `cargo install --locked cargo-vet --version 0.10.2` when the dependency
  graph changes. `just` is optional; every recipe is a cargo or xtask
  command.
- Node 24, Python 3.13 and the .NET 8 SDK are needed only when a binding
  under `bindings/` changes; `bindings/node` is an npm workspace
  (`npm ci`), `bindings/python` uses maturin in a venv, `bindings/dotnet`
  builds with `dotnet build bindings/dotnet/ZeroServer.sln`.
- Standards fetches from a cloud session: rfc-editor.org, datatracker.ietf.org,
  www.ietf.org and httpwg.org were unreachable on 2026-10-01 (blocked by the
  environment's egress policy), while GitHub is reachable. The HTTP Working
  Group keeps the published text of RFC 9110, 9111 and 9112 in its repository
  (`https://raw.githubusercontent.com/httpwg/http-core/main/rfc9110.html` and
  siblings); download the file and extract the section locally rather than
  fetching through a page summarizer, which truncates a document this size. A
  standard with no such copy is reported unverified in the commit body, as
  `RULES.md` requires.
- Docker is not assumed. The container-only checks (the hardened build, the
  sanitizers, miri, the fuzz smoke) run in CI on push; a session reads the
  CI result of its push with `gh run list` and `gh run view <id>` and fixes
  what fails before continuing. The job logs sit on a storage host the egress
  policy blocks (`gh run view --log` and the jobs API both fail), so a red
  job is reproduced locally with the job's own command; `gh run view <id>`
  still names the failed step, and `gh api
  repos/molexxxx/zero-server/check-runs/<job id>/annotations` returns the
  `::error::` lines a step printed, which the `seam` job uses to repeat the
  failing test names and panic messages of the Windows and macOS runs.
- CI's `rustup` stable is newer than a long-lived container's (1.98.1
  against 1.97.0 on 2026-10-01) and its clippy carries lints the older one
  lacks, so run `rustup update stable` before the protocol's clippy step;
  the minimum-toolchain job is `rustup toolchain install 1.89 --profile
  minimal` and `cargo +1.89 check --workspace --exclude xtask --exclude
  zero-examples --exclude zero-bench --exclude zero-serve`, and the AArch64
  job is `cargo clippy -p zero-simd --all-targets --target
  aarch64-unknown-linux-gnu -- -D warnings` from this machine.

## Out of scope for a session

- The Node repository, its releases and its vitest corpus (they transfer in
  release 1 step 13 and later, from here, when the roadmap says so).
- Creating repositories, publishing to any registry, cutting tags, changing
  the license, merging Dependabot pull requests, editing GitHub settings.
- Anything under `.docs/` (an owner-local folder that is not in the clone).
