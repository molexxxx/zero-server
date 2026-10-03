# Status

Updated 2026-10-03. A session that changes the position updates this file in
the same commit.

## Start here (handoff to a cloud session, updated 2026-10-03)

This folder is tracked again so a cloud session can continue from a fresh clone.
Read, in order: `RULES.md` (binding), this section, `work/BRIEF.md`,
`work/release1/GAPS.md` (the ordered master list of everything left for release 1,
with a file-ownership table for parallel work), and
`work/step12/DESIGN-12-13.md` (the design being implemented; section 14 lists its
work packages). Older sections below are history; where they conflict with this
section, this section wins.

### Where things stand

- `main` holds everything finished and green in CI: steps 1 to 11 of release 1,
  the `zero` binary (`zero serve`), the QPACK and HTTP/3 codecs, the README with
  its two diagrams, the pre-release versioning and release tooling, and the first
  two DESIGN-12-13 packages (WP-0 registry rows, WP-1 zero-host plumbing).
- 2026-10-03: the content of `pending-work` is on `main` as four linear commits
  (the three fixes, then "Fuzz the WebSocket, SSE, TLS hello, base64, media type
  and policy parsers"). The eight new fuzz targets run clean for 60 seconds each
  under ASan. GAPS.md F1, F2 and F3 are closed:
  - zero-tls: an unexpected record type before the hello is refused with
    `unexpected_message`, a `legacy_version` below 0x0303 with
    `protocol_version`, and every refusal rustls makes without queuing an alert
    now carries one (a fourth finding of the `tls_hello` target: a handshake
    message declared longer than rustls's 0xffff limit got no alert).
  - zero-policy: quoted `Forwarded` values keep their `;` and `,`; CORS accepts
    only a Fetch Section 3.2 `serialized-origin`.
  - zero-mime: empty parameters are allowed (RFC 9110 Section 5.6.6).
  - The reproducing inputs are seeds under `fuzz/seeds/<target>/`, so
    `work/fuzz-crashes/` is removed. Root `crash-*` files are already ignored.
  - The `pending-work` drafts of the method table, the router and the routing
    tests (WP-5) were left out; they stay readable in commit `658ad64` on the
    `pending-work` branch, which is kept on GitHub for that reason. The `.suffix`
    CORS origin entries of the draft (WP-7) were left out too.
- 2026-10-03: the owner decisions are written into the plan files (GAPS.md P1 to
  P5): ROADMAP already carried the benchmark method, the httparse exception, the
  test-name rule and the single-version policy; RULES now states the test-name
  rule, the generator-driven property-test rule and the httparse exception;
  DESIGN-12-13 sections 8.11, 8.13, 13 item 14 and 15 state the sdk publish under
  `next` at `2.0.0-alpha.1` and record section 15 as answered; DESIGN.md's roadmap
  copy defers to ROADMAP and its version lines follow the single-version policy.
- `cargo xtask docs --check` and `standards --check` fail exactly as before the
  merge (CI runs them with `continue-on-error`; GAPS.md G1).

### Environment limits seen by the 2026-10-03 cloud session

- Push and the GitHub API need the repository attached to the session with
  push access. The container's global git config signs commits with its own
  SSH key, which GitHub shows as Unverified: set `git config commit.gpgsign
  false` in the clone before the first commit. The owner allowed one
  force-push on 2026-10-03 to replace six signed commits with unsigned ones
  of the same content; RULES' no-force-push rule otherwise stands.
- Commit messages name no file under `.github/cloud/`, no notes, plans or
  sessions, and nothing about the tooling or the environment (owner,
  2026-10-03). Changes to this folder ride along with the code commit they
  describe, or go in a commit titled "Update internal documents".
- www.rfc-editor.org, datatracker.ietf.org, fetch.spec.whatwg.org,
  url.spec.whatwg.org, docs.rs, spdx.org and cheatsheetseries.owasp.org were
  unreachable. Reachable sources: crates.io (with a User-Agent), PyPI,
  nodejs.org, raw.githubusercontent.com (the WHATWG `.bs` sources, the TLS WG
  `draft-ietf-tls-rfc8446bis.md`, and the HTTP RFCs 9110 to 9114, 9204, 9651,
  6265 and 7230 as HTML in `httpwg/httpwg.github.io/specs/`). Commits name every
  source they could not fetch as unverified.
- To check when rfc-editor.org is reachable: the TLS WG source of RFC 9846 says
  in the ClientHello section that "A server which receives a legacy_version
  value not equal to 0x0303 MUST abort the handshake with an illegal_parameter
  alert", while zero-tls answers a TLS 1.3 hello with another `legacy_version`
  with `protocol_version` (citing Section 4.2.2) and RFC 8996 requires
  `protocol_version` for {03,01} and {03,02}. Read the published RFC 9846
  Sections 4.1.2 and 4.2.2 and RFC 8996 Sections 4 and 5 and settle which alert
  applies to which `legacy_version`.

### Owner decisions (written into the plan files 2026-10-03)

- Benchmarks: published as measured in Docker on the owner's 9950X3D with the
  RULES method; no ratio gates release 1; the rented tier A and tier C runs are
  waived for release 1; the Realistic entry goes through the router with the
  zero-limits defaults; the go decision is this one, 2026-10-02.
- httparse is allowed as a fuzz-only differential oracle despite the 12-month
  currency rule; it never enters a shipped graph.
- Tests driven by the in-crate deterministic generator with fixed seeds satisfy
  the property-test rule, and a conformance test's section number may live in its
  registry row's URL fragment and note instead of the test name.
- `@zero-server/sdk` publishes `2.0.0-alpha.1` under the npm dist-tag `next`
  with `@zero-server/core` and `@zero-server/native`; the first release is
  `2.0.0-alpha.1` on every registry.
- DESIGN-12-13 section 15: every recommended default is accepted.
- Private vulnerability reporting is enabled on the repository (owner, stated
  2026-10-02; not re-read, the API was unreachable from the 2026-10-03 session).

### Next, in order

1. Done 2026-10-03: the fuzz findings and the `pending-work` merge.
2. Done 2026-10-03: the decisions above in the plan files.
3. DESIGN-12-13 line 2: WP-2 to WP-7 (they own disjoint files and run in
   parallel), then WP-8, then WP-9 and WP-10, then WP-11 to WP-13, then WP-14
   and WP-15, then WP-16. GAPS.md amends several (AM-1 to AM-8). WP-5 starts
   from the drafts in commit `658ad64` on branch `pending-work` (method table,
   router, routing tests; `git show 658ad64:<path>`), WP-7 from the `.suffix`
   origin entries of the CORS draft in the same commit.
4. Beside them, the other GAPS.md workstreams, following its ownership table:
   core fixes C1 to C3, test depth T, registry R, docs and site D, release
   engineering E, fuzz F4, F6 to F8, the benchmark harness B1 to B5 (built here,
   run on the owner's desktop).
5. The release sequence of GAPS.md W10: version bump to `2.0.0-alpha.1`, CI on
   the bump, `cargo xtask release --dry-run`, the non-publishing release runs,
   then the tag, which only the owner confirms.

Left for the owner or the owner's desktop: the benchmark session (an overnight
quiet window, GAPS.md B6), the local fuzz campaign (F5, container `zero-fuzz`),
registry credentials and trusted publishers (O5), and confirming the tag (O7).

### How to work

- For each package: implement, then an adversarial review that runs the exit
  checks and proves each finding, then fixes. Check the committed state alone in
  a clean worktree (fmt, workspace clippy with warnings denied, workspace tests,
  the xtask checks) before pushing to `main`, and keep CI green.
- Commits: authored as `molexxxx <molex@sent.com>`; short imperative subject;
  a body with the change, its reason, and every fetched source with URL and
  date; no co-author trailers and no attribution of any kind; nothing that names
  the tooling; no planning vocabulary. A lockfile changes only in its own
  commit or with the dependency change that requires it.
- Never push a tag and never publish to a registry; the owner does that.

## Position

- The workspace is scaffolded and verified: 31 release 1 crates with their
  lint tables, the three binding skeletons with smoke tests over
  `zero_version`, xtask with its ten tasks, the standards registry
  (`docs/standards.toml`, 552 statements with a release per row), the
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
  `zero-io` holds the seam traits, the per-core pool and date block, the
  `io-tokio` backend (see "In progress", step 4) and the `io-compio` backend
  (`crates/zero-io/src/compio_rt/`, a feature off in every default; see "In
  progress", step 8); `zero_io::rt` names whichever backend the build has, and
  every crate above the seam uses that name. `zero-rt` holds the chunked
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
  `zero-bench` holds the two TechEmpower entries over the driver (`entries.rs`:
  `zero-server`, Realistic, through the router with the `zero-limits` defaults,
  `Server: zero` and `Date` on every response; `zero-server-plt`, Stripped and
  Platform, the raw handler comparing the path itself), their binaries
  (`--port`, `--threads`, `--handoff`), the pipelined load generator on tokio
  (`load.rs`: connections spread over client threads, a pipeline depth per
  connection, warm-up, requests, errors, bytes and batch latency percentiles),
  the idle probe (`idle.rs`: keep-alive connections with one request each and
  the server's resident set from `/proc/<pid>/status` before and after), the
  route-miss timing (`miss.rs`: a 400-route table in an application's shape,
  a miss timed per resolution) and the `zero-bench load|idle|miss` binary;
  `tests/entries.rs` checks both entries' json and plaintext responses and a
  short zero-error load. `bench/techempower/` holds the entry files for a
  self-run of the archived toolset: `benchmark_config.json` (`default`
  Realistic and Micro, `plt` Stripped and Platform, port 8080), the two
  dockerfiles and a README. An idle connection costs about 6.9 KB of resident
  memory on this machine: the boxed connection task (the driver with its
  32-entry ring and one turn's futures, 5.2 KB), the runtime's task cell, the
  completion list and the socket registration; `conn.rs` holds a size test
  that keeps the task under twice the driver.
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
  section 13). Owner decision 2026-10-01: measured results with named
  comparisons may be published, under the method in `RULES.md` (Conventions).
  The comparison is grouped by language: Rust (zero-server against hyper,
  axum and actix-web, with Drogon as the C++ reference), Node (zero-server
  from Node against node:http, Express, Fastify and uWebSockets.js), Python
  and .NET (against their popular frameworks, ASP.NET Core for .NET). Each
  language group shows two zero-server rows: routes declared at startup and
  answered in Rust, and a handler written in that language. One publication
  once the Node binding works (the owner chose everything at once over Rust
  first): `BENCHMARKS.md` with method, hardware, generated SVG charts and the
  raw data under `bench/results/<date>/`, plus a short overview in the README
  that links to it. Python and .NET groups join when those facades serve
  requests (release 2 in the roadmap). Runs happen in Docker on the owner's
  9950X3D with the server and the load generator on separate cpusets and the
  fuzz container paused; the page states it is one desktop under WSL2.
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

R.3 step 6 is complete except for two items that belong to later steps. The
six crates are written and tested (see Position), the routing rows of the
registry pass, `conformance/vectors.json` carries the `router` section (the
route table every binding builds, with a mount, and 37 cases over it: static,
parameter and catch-all matches with the captured parameters, HEAD served by
GET, the automatic OPTIONS, 405 with `Allow`, 501, mounts, the encoded slash,
unreserved decoding, dot-segments, the query, and the targets that are not
paths), and the fuzz crate gained `uri_normalize` (parse, decode and
normalize never panic, normalization is idempotent and its output has no
dot-segment, lowercase triplet or unreserved triplet), `qs_parse` (one pair
per sequence, valid strings), `json_parse` (never panics, a parsed value
written back parses equal) and `router_resolve` (parameter ranges inside the
path, the split and normalized path resolves the same); the first smoke
runs found two defects, both fixed and their inputs kept as seeds: a path
with a byte a path cannot hold after a dot-segment was normalized instead of
refused, and an integral float was written without a fraction and read back
as an integer. Still open: the 400-route miss measurement against the 10.9
microsecond Node figure (the harness of step 7 measures it), and the router
tests transferred from the Node repository, which arrive with the corpus in
step 13; until then the router's own tests and the regression entries of
`DESIGN.md` section 15 (a child mount keeps the query string; a mount wins
over an application-level `/*`) stand in.
Unverified: RFC 3986 was read from the uriparser project's copy and RFC 8259
and RFC 4648 from the rfc-translater project's copies (the English column),
because the RFC Editor is unreachable; the URL Standard from the WHATWG
repository's `url.bs`; the IANA media type registry is unreachable too, so
the extension table rests on mime-db's compilation of it.

R.3 step 7 has what this machine can give: the entries, the load generator,
the idle probe, the route-miss timing and the TechEmpower entry files (see
Position). Measured here on a 4-core container, the server on 2 cores and
the generator on the other 2, 5 s runs after 1 s of warm-up, loopback, no
acceptance value (the tiers run on other hardware): the Realistic entry
serves plaintext at 256 connections with 16 pipelined requests at 1,225,326
requests per second and at 1,024 connections at 1,246,027, json at 256
connections at 178,460 and at 16 connections at 181,118, every run with
zero errors; the Platform entry 1,412,861 on plaintext and 192,209 on json
at 256 connections. The 16-connection json figure equals the 256-connection
one here, so the 25K to 30K band of section 5.7 does not show on loopback
with this generator. Bytes per idle connection on `io-tokio` with the lazy
lease: 6,914 resident bytes at 10,000 connections after one request each
(one core, `zero-bench idle`); the probe's first reading was 37,894, which
was the connection future stored six times over, fixed in `zero-rt` and
`zero-http` and held by the size test in `conn.rs`; 100k and 1M need a
host with the descriptors and the memory. The route miss: 230 ns per miss
against 400 routes and 316 ns against 4,000 (`zero-bench miss`, release
build, the median of five batches of a million), against the 10.9
microsecond Node figure of section 7.1, which closes step 6's measurement.
The counting-allocator gate over the real path is `zero-http`'s
`tests/no_alloc.rs`. What needs hardware and the owner: the tier A json
ratio against the pinned Drogon entry, the tier B plaintext ratios against
the ceiling reference, the nodejs and uwebsockets.js yardsticks, five
interleaved runs with medians, the 16,384-connection level, the
`overflow-checks` run, the hardware rental and the go decision; `.docs/bench/`
is owner-local, so this machine's numbers live here and in the commit
bodies. For the self-run: at toolset commit 523534bb ntex's `plt` entries
declare `approach` Realistic with `classification` Platform
(`frameworks/Rust/ntex/benchmark_config.json`, read 2026-10-01), where the
design describes them as Stripped; `zero-server-plt` keeps the design's
Stripped and Platform.

R.3 step 8 is in: the `io-compio` backend of `zero-io` behind the feature of
that name, over compio-driver 0.12.5's proactor (io_uring on Linux with the
epoll fallback compio's fusion driver takes when the ring is refused, IOCP on
Windows, kqueue through polling on macOS) with an executor of this crate's own,
since the design keeps compio-runtime out of the graph: `executor.rs` (a run
queue of `!Send` tasks whose wakers push an index and interrupt the driver only
from another thread, the operation future that submits on first poll and pops
the completion, `block_on` for a core without the workers), `ops.rs` (the
operations kept across futures, named once; a dropped future cancels its
operation and the driver keeps the operation and its buffer until the
cancellation completes, as compio-runtime does, while a block leased from the
pool returns its lease at once, so a read cut short by a timeout costs one
block's allocation later and never the pool's budget; the first version kept
the cancelled keys and popped their completions, which the polling driver on
macOS answered with its "Key not unique" panic in CI), `time.rs`
(the deadlines in a binary heap whose entries know their position, so a sleep
leaves in logarithmic time and a warm core allocates nothing for timers),
`shutdown.rs`, `listen.rs` (an accept operation per core on Linux, core 0's
listener handing sockets through a slot with a waker elsewhere), `tcp.rs` (every
read and write takes the block's storage by value through `OwnedBuf::into_parts`
and `from_parts`, which `zero-core` gained for it, and the readiness operation
belongs to the stream across the futures that wait on it, since the HTTP driver
drops its read each turn another branch wins), `udp.rs` (readiness then the
`zero-sys` batch calls on Unix, one operation per datagram on Windows) and
`worker.rs`. The listener and datagram setup both backends share moved to
`crate::net`. CI runs `zero-io` without the tokio default and `zero-http` with
the feature on all three runners (`seam` job) and fails if a compio, io-uring
or polling crate appears in the default `cargo tree`; `deny/io-compio.toml` was
confirmed by its first run (concurrent-queue and the default features the
graph enables added, rustix `mm` and `system` for the ring), and the 38 crates
the feature adds to the lockfile carry safe-to-deploy exemptions in
`supply-chain/config.toml`. Every test of `zero-io` and `zero-http` passes on
both backends on this machine, where compio picks io_uring (kernel 6.18, the
ring not blocked here). Measured on the same container as step 7 (server on 2
cores, generator on 2, loopback, 4 s runs): the Realistic entry on `io-compio`
serves plaintext at 256 connections at 1,015,067 requests per second (tokio
1,225,326), at 1,024 connections 679,495 (tokio 1,246,027), json at 256
connections 166,194 (tokio 178,460) and at 16 connections 108,017 (tokio
181,118), the Platform entry 1,012,520 and 165,711; zero errors everywhere;
resident bytes per idle connection 6,282 at 10,000 connections (tokio 6,914);
the counting allocator sees 5 allocations per warm request on `io-compio`, all
inside the driver, which allocates one record per operation it owns
(`tests/no_alloc.rs` asserts the number stays constant on that backend and zero
on `io-tokio`). The gaps at 1,024 and at 16 connections are the backend's own
and are the next thing to look at: the receive still takes two operations (a
readiness poll, then the receive into the leased block) where io_uring's
provided buffer ring (`RecvManaged` with compio's `BufferPool`) would take one
and keep the lazy lease, and the driver's record per operation is the one
allocation per request this backend has. Also open: on CI's Windows runner the
backend passes every test but one: a datagram longer than its buffer comes back
from the completion port's receive with no bytes, where the readiness backend
gets the first part and `WSAEMSGSIZE`; the test asserts nothing for that one
case on Windows under `io-compio` until a Windows machine shows what the
completion carries (`crates/zero-io/tests/datagram.rs`). macOS passes with the
cancel-only protocol. The section 5.7 CPU-per-request figure needs cgroup
accounting.
Unverified: compio-driver's API was read from the crate sources downloaded from
the registry (0.12.5) and from the repository's clone (last commit
2026-09-30, so not archived), since docs.rs is unreachable here.

R.3 step 9 has begun, in small commits so a session can stop anywhere.
Done: `zero-date::parse_http_date` (`crates/zero-date/src/parse.rs`), the
three HTTP-date formats of RFC 9110 Section 5.6.7 with the two-digit-year rule
against a clock the caller passes, case-sensitive and exact, a leap second
counted into the next minute and a date before 1970 read as 0; the RFC's three
example timestamps are the test. Done: the pure layer of `zero-static`
(`crates/zero-static/src/cond.rs`: entity tags with the strong and weak
comparison functions, the five preconditions evaluated in the order of RFC 9110
Section 13.2.2, If-Range by exact match with a date counted strong once its
second has passed; `range.rs`: the `bytes` unit of Section 14 with suffix and
open-ended ranges, in-order overlapping ranges coalesced, backwards or more
than 16 ranges refused, `Content-Range` for 206 and 416 and the
`multipart/byteranges` content; `headers.rs`: the `Cache-Control` policy of a
route, `Content-Disposition: attachment` with the ASCII fallback and the RFC
8187 ext-value, the Last-Modified clamp), with the tests of rows `static-01` to
`static-04`, `static-06` to `static-11` and `static-14` to `static-16` in
`lib.rs`. Done: the file layer (`files.rs`: `Files::new(root, Options)` with
`serve(call)` and `serve_path(call, path)` for a mounted route; the path policy
on every segment after `zero-uri` normalization and strict percent-decoding,
with the Windows colon and tilde-digit rules; the open through
`zero_sys::fs::open_nofollow` (`O_NOFOLLOW | O_CLOEXEC` on Unix, a plain open
on Windows), the resolved path compared against the resolved root and on Unix
the opened file's device and inode compared with the resolved path's; a
strong ETag from the modification time and the length, `Last-Modified`
clamped to now, 304 with ETag and Cache-Control beside the driver's Date, 412,
`Accept-Ranges: bytes`, 206 single and multipart, 416, `Content-Disposition`
for a download route, 405 with `Allow: GET, HEAD`, the index file for a
directory path, the per-core small-file cache revalidated by one stat per hit
and bounded by a byte budget with insertion-order eviction), with rows
`static-05`, `static-12` and `static-13` and a Unix symlink-escape test, all
driven through `zero-http`'s server in `lib.rs`. All 16 static rows name
their tests. Not in the crate: the platform file-send path (bodies are
buffered on the handler ABI until release 2's streaming), a directory
listing, and precomputed header blocks per asset beyond the cached ETag and
media type. Done in `zero-policy`: the trust-proxy rule
(`crates/zero-policy/src/forwarded.rs`: the `Forwarded` elements of RFC 7239
with `for`, `by`, `host` and `proto`, node identifiers as addresses, `unknown`
or obfuscated tokens with a port, IPv6 and ports only in quoted form, an
element with a repeated parameter dropped; `TrustProxy` with address prefixes,
whose `client` and `proto` read `Forwarded` then `X-Forwarded-For` and
`X-Forwarded-Proto` only when the immediate peer is trusted and take the first
`for` as the originating client), rows `routing-23` to `routing-27` in
`lib.rs`. Done: CORS (`crates/zero-policy/src/cors.rs`: `Cors` with
`AllowOrigin::Any` or an exact list of serialized origins, credentials, the
allowed methods and headers with `*` honored only without credentials, the
exposed headers and `max-age`; `decide` tells a non-CORS request, a refused
one, a preflight to answer 204 without the route, or an allowed request with
its fields; `Access-Control-Allow-Origin` is one origin or `*`, the origin is
reflected with `Access-Control-Allow-Credentials: true` under credentials,
`Vary: Origin` whenever the value varies, `null` matches nothing), rows
`policy-08` and `policy-10` to `policy-16`. Done, one commit each, all read
2026-10-01: the OS random source (`crates/zero-sys/src/random.rs`: getrandom
on Linux, getentropy on Apple, BCryptGenRandom on Windows) behind
`zero_server_crypto::SystemRng`, so `zero-policy` draws nonces and ids without
a third-party crate; the security headers (`crates/zero-policy/src/security.rs`:
HSTS only on a secure connection, CSP with per-response nonces and a `<meta>`
form that drops what a meta element cannot carry, nosniff, X-Frame-Options,
Referrer-Policy, CORP, COOP, COEP with report-to, `X-XSS-Protection: 0`,
`X-Powered-By` scrubbed), rows `policy-17` to `policy-29`; fetch metadata
(`fetch_metadata.rs`: unsafe cross-site requests refused with 403, same-site
only when trusted, `Vary: Sec-Fetch-Site` on every answer), rows `policy-06`
and `policy-07`; the request id (`request_id.rs`: UUID v7 by default or v4
from RFC 9562, an incoming id kept only when trusted and only 1 to 128 bytes
of `[A-Za-z0-9-_.:]`), rows `observe-27` and `observe-28` moved to
`zero-policy` and release 1; the body limits (commit 808d854: `Handler` gains
`body_limit(method, path)`, asked by the driver only for a head that
announces content; a declared `Content-Length` over it is answered 413 before
any content is read and before a 100 Continue, a chunked body once its
decoded size passes it; `crates/zero-policy/src/body_limit.rs` holds
`BodyLimits`, prefixes matched on segment boundaries after RFC 3986
normalization with the query split off), rows `policy-30` and `policy-31`.
Then, all read 2026-10-01: SHA-1 and SHA-256 in `zero-server-crypto` over
aws-lc-rs 1.18.1 (commit 5c12814; `pkg-config` joined the bans allow list,
`shlex` and `zeroize` got default-feature exceptions, mirrored into `deny/`, and
the vet store got seven exemptions); `zero-ws` (commit 7509318: `handshake`
with `negotiate` and `accept` over the `Digest` trait, `frame` header decode and
encode, `close` codes per RFC 6455 Section 7.4 and the IANA registry, and the
sans-I/O `session` that unmasks in place, gathers fragments and partial frames,
validates UTF-8 per fragment, answers pings, echoes one Close, fails with 1002,
1007, 1008 or 1009, refuses sends after a Close and closes with 1001 when
draining), rows `realtime-01` to `realtime-18` and `runtime-05`; `zero-sse`
(commit 051b012: the encoder, `KeepAlive`, `last_event_id`,
`STOP_RECONNECTING`, and the client `Decoder`), rows `realtime-25` to
`realtime-33`; the connection takeover in `zero-http` (commit 87c9675:
`Call::upgrade` for a 101 to a protocol the client offered, with a 100 first
when one is owed, `Call::stream` for a close-delimited body, `Handler::taken`
with the bytes after the head; parsing and reading pause after an upgrade
request until it is answered), rows `h1-15` to `h1-18`; `zero-realtime`
(commit bf07d10: `accept_websocket`, `WebSocket` with `recv`, sends, close and a
5 s closing timeout, `start_event_stream`, `EventStream` with keep-alive
comments while waiting, `stop_reconnecting`; `Call::upgrade_required` for a 426
with `Upgrade`, row `h1-19`); rooms (commit 7951501: a table shared by every
core, one inbox per member woken through its `Waker`, a frame encoded once per
broadcast, 1013 for a member past its inbox limit). The three audit vectors
(bytes sent with the handshake, continuation frames, writes after a Close) pass
end to end in `crates/zero-realtime/tests/realtime.rs`. Step 9 is done; the
registry has 522 rows. Not in release 1 and not started: permessage-deflate
(`realtime-19` to `realtime-23`, release 3) and WebSocket over HTTP/2
(`realtime-24`, release 2). Next: step 10. The sources fetched for the
policy rows sit in the session's scratch directory (`fetch.bs`, `csp3.bs`,
`referrer-policy.html`, the tex2e copies of RFC 6454, 6797, 7034 and 7239,
`HTTP_Headers_Cheat_Sheet.md`), read 2026-10-01; a fresh session fetches them
again from GitHub. The RFC texts for the step sit in a session's scratch
directory only: RFC 9110 from the HTTP Working Group's repository copy, RFC
6266, 8187 and 9111 from the tex2e/rfc-translater repository's copies (the
English column), all read 2026-10-01; a fresh session fetches them again from
the same places.

R.3 step 10 is done (commits 6296f31 to 533e7e8, pushed 2026-10-01).
`zero-server-crypto` gained `verify_mac`, `verify_token` over aws-lc-rs
`constant_time` and `Secret<T: Zeroize>` with `SecretBytes` (c1500e8; zeroize
1.9.0 adopted in 6296f31; `subtle` was not taken, aws-lc already carries the
primitive). `zero-tls` takes rustls 0.23.45 with std, aws_lc_rs, tls12 and
prefer-post-quantum (af06a5e), passes the provider explicitly and never installs
it as the process default. `zero-http` grew `serve_with`, the `Accept` trait
(called synchronously on the accept loop with `self: Rc<Self>`, so a per-core
handshake count is taken before `saturated` is asked again), `Prepared` and the
421 path for a Host the connection does not serve (813b1b3, c271ef0).
`zero-tls` (533e7e8): `Identities` with `replace`, `server_config` (TLS 1.3 and
1.2, server suite order, EMS required, ALPN http/1.1, no early data, stateless
tickets rotating every 6 h with a 12 h lifetime, 256-entry session cache), the
ClientHello gate with unrecognized_name and missing_extension, the handshake
under `handshake_timeout` and `max_handshakes_per_core`, `BufferedStream`
(default on io-tokio) and `UnbufferedStream` (default on io-compio) over one
outbox whose unwritten bytes survive a dropped write, `close_notify` before
every write-side close. 22 tests on each backend, curl and openssl s_client
interop. Rows tls-01 to tls-17 added; h2-15 moved to RFC 9846, which obsoletes
RFC 8446, 7627, 5246 and 5077 (cite 9846 from now on; RFC 9325 is updated by
9852 and 10015). The registry is maintained in this repository now; the import
script writes `target/standards-import.toml` (fe8648a). A rustls quirk worth
remembering: a client `ClientSessionMemoryCache` of 8 or fewer evicts every
ticket, so resumption tests use 256.

Follow-ups landed the same day: dotfile segments refused by `zero-static`
unless `Options::dotfiles` allows them (f4862ad, row static-17, 545 rows now),
the bundle's `tls` feature turning on what zero-tls is built over (5e34ed0),
the README, crate docs, home page and changelog brought in line with the code
(d434801), and the justfile recipes fixed (cdf87dc). `cargo xtask standards
--check` passes every row up to `runtime-01`, whose evidence file
`crates/zero-serve/src/lib.rs` arrives with the `zero` binary. `cargo xtask docs
--check` still fails on .NET binding types that do not exist yet.

An adversarial review of step 10 (workflow run wf_a0b7f5c6-71a, 29 agents,
23 confirmed findings, 2 refuted) was fixed the same day in four commits:
368b09f (io-compio reads receive synchronously after readiness, a dropped send
stays on the stream and the next write takes its count; the seam's Stream
documents the cancellation contract), 47ed86f (an aborted connection flushes
the fatal alert its TLS session queued, linger bounds close_write, a timed-out
handshake sends close_notify on the buffered driver, resumed writes never
report more than they were given, WebSocket and SSE writers resume), b9806a2
(the hello reader keeps bytes the Acceptor has not taken, protocol_version and
missing_extension on the raw hello before the name gate, the unbuffered driver
bounds a fragmented message, serve refuses ALPN other than http/1.1), 4429814
(Host and absolute-form authorities held to uri-host [ ":" port ], IP hosts
compared as addresses, https over cleartext answered 421, identity names and
addresses checked against the certificate, the chosen identity pinned into the
session config, default names in the table, a nameless hello picked by local
address). Rows tls-18 to tls-24 are new (552 rows). RFC 9846 renumbers the
handshake messages: Client Hello is 4.2.2, HelloRetryRequest 4.2.4,
supported_versions 4.3.1; read the section numbers from the text, never from
RFC 8446. Open from the review: a response write has no deadline, so a client
that stops reading mid-response holds its connection (slow read); add a send
timeout to Http1Limits and the driver's expire().

## Resume point (written 2026-10-01 late, before a session limit)

The owner asked for every release 1 step to be finished before 0.1.0 reaches
crates.io, nothing on npm before 2.0.0, and hardware work only in Docker on the
owner's machine (Ryzen 9 9950X3D). In flight when this was written:

1. Step 11 workflow, run `wf_3f7b6a84-e1e` (research, design, critique, revise,
   implement zero-qpack and zero-h3 in parallel, integrate, five-dimension review
   with refuters, fix). Its notes, design and row fragments are mirrored to
   `.docs/work/step11/` (BRIEF.md is the agents' brief; research-*.md,
   qpack-static-table.tsv, huffman-table.tsv, design.md, critique.md,
   rows-qpack.toml, rows-h3.toml as they appear); its script to
   `.docs/work/scripts/step11-qpack-h3-*.js` and its journal (every finished
   agent's return value) to `.docs/work/journals/wf_3f7b6a84-e1e.jsonl`. Code goes
   straight into the working tree: crates/zero-qpack, crates/zero-h3,
   crates/zero-examples, conformance/vectors.json, fuzz/, docs/standards.toml,
   README.md, CHANGELOG.md. To resume in a new session: read the journal to see
   which agents finished, edit a copy of the script so `S` points at
   `.docs/work/step11` and the finished phases are skipped, and run it; then
   check, commit (separate commits for each crate and for the vectors, fuzz and
   registry integration) and push.
2. Steps 12 and 13 design workflow, run `wf_9452a601-854` (six readers, three
   designs, two judges, synthesis, critique, revision). Outputs mirror to
   `.docs/work/step12/` (map-*.md, facts.md, design-*.md, DESIGN-12-13.md,
   critique-12-13.md); script and journal as above. DESIGN-12-13.md ends with
   work packages with disjoint files: implement them with one workflow per
   package group, then review, then the Node binding.
3. Miri: every CI Miri job since 2026-10-01 morning hit the 6-hour limit. A local
   timing run writes `target/miri-times.txt` (seconds per crate under Miri, one
   seed). Use it to cut the slow tests under `cfg(miri)` or lower
   `-Zmiri-many-seeds`, so the job fits the new 90-minute limit.
4. Uncommitted in the working tree: `.github/workflows/ci.yml` (concurrency group
   cancelling superseded runs, Miri `timeout-minutes: 90`),
   `crates/zero-tls/tests/driver.rs` (the s_client ALPN check also accepts
   "alert number 120", which the CI runner's OpenSSL prints), and `README.md`
   (rewritten after an Impeccable audit: status first, one checklist, one Rust
   example, built and planned separated in How it works; render it with
   `gh api /markdown` and commit).
5. `%USERPROFILE%\.wslconfig` now sets processors=14 and memory=24GB (owner
   approved; backup `.wslconfig.bak-2026-10-01`). It takes effect after
   `wsl --shutdown`, run when no Docker build is active. Then install cargo-fuzz
   (version from crates.io, pinned) into the `zero-core-cargo` volume and run every
   fuzz target for 24 CPU-hours in the background, committing crash fixes and
   regression seeds.
6. Release 1 after step 13: step 14 (the `zero` binary in zero-serve with the
   rows runtime-01, runtime-06 and runtime-07; the two Node process rows belong
   to the Node facade's signal handling and their evidence moves there),
   release-preflight and `cargo xtask release --dry-run`, the documentation pass,
   then the v0.1.0 tag, which publishes crates.io, PyPI and NuGet and is
   irreversible. The tier C benchmark needs rented hardware and is skipped.

`.docs/work/sync.ps1` mirrors the session's scratch directory into `.docs/work`
every three minutes while a session runs it.

### State at 2026-10-02 morning (after the second session limit)

Pushed up to 71f56ac: the CI examples step no longer hangs (660c714; it ran the
`hello` and `users` servers to completion, so the rust job waited 3.5 hours until
cancelled; now the servers are started, checked over HTTP and stopped, and the
rust job has a 30-minute limit), the README picture fix (9605585), the cargo-fuzz
pin (718a687) and the fuzz log ignore (71f56ac).

README pictures on GitHub: GitHub wraps each `<picture>` in `<themed-picture>`.
When the viewer sets a single theme (not "sync with system"), its script rewrites
every `<source>` whose media mentions `prefers-color-scheme` to always or never
match and drops any width condition in the same query; width-only sources are left
alone (read from GitHub's `chunk-lazy-element-themed-picture` script on
2026-10-02). So never combine width and color scheme in one media query. The
pattern: a width-only source first for a self-contained narrow card (its own
background, both palettes inside the SVG), then the plain dark source, then the
light `<img>`. The diagrams build was told this and produces six files.

All five workflows were relaunched in the same session with `resumeFromRunId`
(same run ids as below); finished agents replay from cache. A resume replays
only the longest unchanged prefix of agent calls, so a failed agent makes every
later sibling in a `parallel` group run again: the step 12 designs reran that
way although all three files were finished. After the third limit (2026-10-02
about 08:00) the three designs were confirmed complete on disk and the rest of
that workflow moved to a new script, `step12-partB-judge.js` (run
`wf_50545191-31e`: two judges, synthesis, critique, revise). Agents that rerun
now carry a note to continue from partial files (zero-serve had about 55 KB of
unfinished work in `crates/zero-serve`). The narrow diagram is back on phones,
transparent and switching palettes inside the SVG (d61d324; the owner rejected
an opaque card); CI is green on 71f56ac.

The versioning workflow `wf_10982417-ba8` finished with three review findings.
Its changes stay uncommitted until run `wf_a588e562-9da`
(`release-readiness-*.js`) lands: it fixes the findings (prose spelling check,
PEP 440 phase wording, SECURITY.md npm wording), adds the missing `bump()` test,
adds an optional `NPM_TOKEN` fallback for the first publish of new npm names,
makes `docs --check` and `packages --check` pass for release 1 (release-aware,
like `standards --check`), and verifies with a throwaway `2.0.0-alpha.1` bump.
Then commit in this order: xtask, release workflows and scripts, docs, and the
regenerated `bindings/node/package-lock.json` on its own.

Diagrams: run `wf_73171436-e5d` finished. `scripts/architecture.py` now writes
six files (`assets/runtime*.svg`, `assets/bindings*.svg`; the narrow two are
transparent and switch palettes inside the SVG) and deleted the old
`assets/architecture*.svg`, so the working-tree README points at missing files
until the README edit lands; never commit the deletion without it. Run
`wf_9e61bf9c-3c1` (`diagram-finish-*.js`) applies three accepted finish-review
fixes plus a clipped thread pill, then screenshots all six in Chromium and
Firefox with page and system schemes crossed. Rejected: the reviewer's advice
to split the narrow files into dark variants behind a combined media query.
zero serve landed (2026-10-02): 98b721e (zero-sys stop signals), 3ab8a0c (FIFO
open without blocking), d02b4e6 (the `zero` binary), after the adversarial
review's six findings were fixed. The committed tree was checked alone in a
temporary worktree (fmt, workspace clippy, workspace tests, lints, examples).
Follow-up: zero-http writes no security headers on the responses it writes
itself (400, 408, 413, 421, 505, the 500 after a handler error); the fix is a
configured field set in zero-http written on every response. Rows runtime-01 and
runtime-07 wait for `bindings/node/test/lifecycle.test.js` with the titles
"installing SIGTERM and SIGINT listeners replaces the default exit" and
"work in the process 'exit' handler is synchronous only". For partial commits of
files several workflows share, `.docs/work/tools/stage_hunks.py <repo> <path>
<regex>` stages only the matching hunks (it passes the patch as bytes; text mode
on Windows turns it into CRLF and git apply refuses it).

Landed 2026-10-02 afternoon, CI green: the codecs (e710532 to f022411), the README
with the two diagrams and docs/about/standards.md (48351ba), and the versioning and
release tooling (717993d to e13e631: pre-release versions, release-aware docs
check, generators rewritten for this product with every crate's README and
LICENSE, pre-release publishing, the NPM_TOKEN first-publish fallback, the
lockfile). Owner decisions 2026-10-02: the README as proposed; SECURITY.md keeps
the zero-server-node link until that repository is archived; @zero-server/sdk
publishes 2.0.0-alpha.1 under `next` with @zero-server/core and
@zero-server/native (reverses "sdk private until parity"; flip `private`, the
generator's bundle README, releasing.md and SECURITY.md together with the
facade in the Node binding work).

Implementation of DESIGN-12-13 started 2026-10-02: brief at
`.docs/work/step13/BRIEF.md` (records the section 15 defaults, all accepted, and
the sdk decision); design mirrored at `.docs/work/step12/DESIGN-12-13.md`. Run
`wf_15113098-92a` (`binding-foundation-*.js`): WP-0 rows then WP-1 plumbing, each
reviewed and fixed, beside fuzz targets for the remaining parsers and crate
rustdoc without DESIGN.md references. Next: commit those, then line 2 (WP-2 to
WP-7) as its own workflow, and so on line by line, committing after each line.

Owner direction 2026-10-02: release 1 completely finished with nothing missing,
heavily unit tested, and benchmarked with the release. Run `wf_c532a541-02e`
(`release1-gap-audit-*.js`, read-only) writes `.docs/work/release1/`
(roadmap.md, registry.md, coverage.md with measured line coverage,
docs-and-release.md, benchmarks.md) and the ordered master list
`.docs/work/release1/GAPS.md`, which drives everything after the binding work.

Landed 2026-10-02 evening: 4e7d267 (WP-0 rows), 212a8d0 (WP-1 zero-host plumbing;
the zero-ffi to zero-host edge is held for WP-9 with the binding lockfiles; the
deferred manifest is target/wp1-deferred-zero-ffi-Cargo.toml), 2129a9a (crate docs
without internal references), 72e6d4c (leftover catalog tables). Held back: the
eight new fuzz targets (fuzz/**, docs/about/standards.md fuzz paragraph) until the
crate defects they found are fixed; crash inputs in .docs/work/fuzz-crashes/.

Owner decisions 2026-10-02 (from the gap audit, `.docs/work/release1/GAPS.md`):
benchmarks published as measured in Docker on the 9950X3D with no gate, rented tiers
waived for release 1; httparse allowed as a fuzz-only differential oracle; the
in-crate generator counts as property tests and a section number may live in the
row's URL and note; private vulnerability reporting enabled on the repository
(done, `{"enabled":true}`).

Running: `wf_2db8f13c-4a7` (WP-2, WP-3, WP-4), `wf_77b63bbd-de3` (WP-5, WP-6 with
AM-1, WP-7 with the CORS origin fix), `wf_3212dca0-d8a` (TLS hello, Forwarded and
media type fixes, /crash-* ignored, the decisions written into the plan files).
After them: commit per package, commit the fuzz targets once all three fuzz
failures pass, then the next wave from GAPS.md (WP-8; tests T; registry R; docs D;
release engineering E; benchmark harness B1 to B5; fuzz F4 to F8; core fixes C1 to
C3).

Release 1 work still open, in order: implement DESIGN-12-13 (host dispatch, C
ABI, Node binding and facade, the sdk publish change, lifecycle.test.js for
runtime-01 and runtime-07, NativeMethods.cs generated from zero.h); the ten
capability guides with Rust and TypeScript examples; the bundle's chapter
features (`http` collides with zero-http's feature; add `http3`); crate rustdoc
that cites the gitignored DESIGN.md by section; leftover catalog tables (radio,
lora); fuzz targets for the WebSocket frame and SSE decoders, the TLS hello
reader and the small field parsers; zero-http writing the security headers on
its own responses; the local fuzz campaign gaining the eight QPACK and HTTP/3
targets; the benchmark harness and run once Node works; then release-preflight,
`cargo xtask release --dry-run` and the tag (owner confirms the tag).

Fourth session limit (2026-10-02 08:50): relaunched step 11 (`wf_3f7b6a84-e1e`,
implementation of both crates finished and cached; `step11-part2-build.js` now
also carries the five-dimension review with refuters and the fix stage, and its
integrate stage no longer edits README.md), release readiness
(`wf_a588e562-9da`; the docs and packages agent also replaces leftover scaffold
copy in the xtask generators: IoT, MQTT, MIT, "Not a sensor library"), the
README audit (`wf_9cb7a65c-065`, audit cached) and the binding design judging
(`wf_50545191-31e`, judges and synthesis cached).

README audit: run `wf_9cb7a65c-065` (`readme-audit-*.js`) writes
`.docs/work/readme/` (audit.md, README.proposed.md, at-release.md, notes.md,
preview/*.png) without touching README.md. Show the owner the previews before
applying; apply it in one commit with the new diagrams, the deletion of the old
`assets/architecture*.svg`, `docs/about/standards.md` and the brand.md note.
`.docs/work/sync.ps1` now mirrors every workflow journal of the session.
Owner decision 2026-10-02: keep cores 1, 2 and n rotated away from the brand's
one-thirty rest; `docs/brand.md` now states the exception (uncommitted, goes in
with the diagram commit). Check after DESIGN-12-13 lands: the bindings diagram
labels the boundary "C ABI" for Node too; if the Node binding goes over the
Rust crates directly, relabel it. Still to do after
them: the benchmark harness (decision above in "Decisions already made"), the
`NPM_TOKEN` fallback, the release-aware docs check, the alpha bump.

### Also in flight (2026-10-02 early)

- Versioning, run `wf_10982417-ba8`: one version 2.0.0-alpha.1 on crates.io, PyPI
  (2.0.0a1), NuGet and npm (under the `next` dist-tag), an owner decision that
  replaces "no npm before 2.0". It prepares crates/xtask, the release workflows and
  docs/about/releasing.md and SECURITY.md; the bump itself (`cargo xtask version
  2.0.0-alpha.1`) is its own commit after the step 11 crates land. Still to add by
  hand: an NPM_TOKEN fallback in release-node.yml for the first publish of new npm
  names (OIDC works only for existing packages). Notes in
  `.docs/work/versioning/`.
- Diagrams, run `wf_73171436-e5d`: the README's architecture picture becomes two
  diagrams, `assets/runtime*.svg` (the thread-per-core engine) and
  `assets/bindings*.svg` (an application in another language on the same engine),
  from three drafts and two judges. Brief and drafts in `.docs/work/diagrams/`.
  Then one README edit: swap the pictures, drop the RFC references (they moved to
  the new `docs/about/standards.md`, uncommitted), and update Packages for the
  alpha on npm.
- zero-serve, run `wf_d6c84f6d-671`: `zero serve [DIR]` with HTTPS flags and
  SIGTERM, SIGINT and Ctrl+C graceful shutdown (signal waiting in zero-sys), the
  runtime-06 test, and runtime-01 and runtime-07 moved to the Node facade.
- Fuzzing: detached container `zero-fuzz` runs `target/fuzz-campaign.sh`, every
  target for 24 CPU-hours, 6 workers; progress in
  `target/fuzz-campaign/progress.txt`, crashes in `fuzz/artifacts/`. It survives a
  session end; rerun a target by deleting its `done` line. CI now pins cargo-fuzz
  0.13.2 (uncommitted with `fuzz/.gitignore`).

### How to resume in a fresh session (state at 2026-10-01 22:20)

Committed and pushed up to 8dd1a25: the README rewrite without plan language
(0c92a41, with compiled `hello` and `users` examples in zero-examples) and the
Miri and CI fixes (8dd1a25). The working tree is clean. Docker runs with 14 CPUs
and 24 GB.

Workflow run ids do not survive a session, so relaunch from the saved scripts:

1. Copy `.docs/work/resume/step11-BRIEF.md` over `.docs/work/step11/BRIEF.md`
   and `.docs/work/resume/step12-BRIEF.md` over `.docs/work/step12/BRIEF.md`
   (the copies point at `.docs/work` instead of the old session's scratch).
2. Step 11: `.docs/work/resume/step11-full.js` is the whole workflow with `S` at
   `.docs/work/step11`. The four research notes exist (research-qpack.md,
   research-h3.md, research-huffman.md, research-capsules.md, plus
   qpack-static-table.tsv and huffman-table.tsv), so delete the Research phase
   block and replace `research` and `notes` with the file list. If design.md and
   critique.md already exist, drop those agents too. Run it in parts of at most
   four or five agents (design trio; the two implementers plus integration; the
   review dimensions with their refuters; the fix), as the workflow size guideline
   asks.
3. Steps 12 and 13: `.docs/work/resume/step12-13-full.js` with `S` at
   `.docs/work/step12`. Readers done: map-request-path, map-runtime,
   map-abi-state, map-node-api and facts (check facts.md reads complete; its
   first agent died mid-write and a rerun followed). The legacy-tests reader
   (map-legacy-tests.md) may be missing: rerun just that reader if so. Then the
   three designs (design-copy-out.md, design-lease-record.md, design-free.md;
   skip any that exist), the two judges and the synthesis (DESIGN-12-13.md), the
   critique and the revision.
4. The journals of finished agents are in `.docs/work/journals/`; each line with
   `"type":"result"` holds an agent's full return value.

Update after the session limit reset (2026-10-01 night): nothing was lost. The
workflows' failed agents had not edited code. Docker now runs with 14 CPUs and
24 GB. README rewritten and pushed (76cc621). The step 11 workflow resumed under
the same run id with its research cached (script `step11-part1-design.js`: design,
critique, revision only; implementation, integration and review follow in
further parts of at most four new agents each). The Miri culprits were found:
zero-date's every-day walk (now a sampled walk under `cfg(miri)`), two zero-sys
file-system tests without the Miri ignore, and zero-json reading its corpus from
disk (now `include_bytes!`); CI moves to `-Zmiri-many-seeds=0..4`. The step 12/13
design workflow still needs its legacy-tests reader, the three designs, the
judges, the synthesis and the critique (facts.md was written before the limit
but its agent did not return, so check it before relying on it).

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
   `zero-http` (step 5), the router with the small codecs (step 6), and the
   harness with the measurements this machine can take (step 7): done except
   for the parts named under "In progress"; step 7's tier runs wait for
   hardware and the owner. The `io-compio` backend (step 8) is in and tested
   on both backends here; its buffer-ring receive and its Windows and macOS
   runs are named under "In progress". Step 9 (`zero-static`, the
   `zero-policy` subset, `zero-ws`, `zero-sse`, `zero-realtime`) is done.
   Step 10 (`zero-tls`, the crypto minimum) is done. Next: steps 11 to 14
   to the release 1 tag, starting with step 11: the `zero-qpack` and
   `zero-h3` codecs with their vectors, fetching RFC 9204 and RFC 9114
   first. Then step 12 (slot ownership in `zero-rt` and the `zero-ffi` C
   ABI), step 13 (the Node binding and its TypeScript facade) and step 14
   (build matrix, release dry runs, tag v0.1.0). The owner has set up
   publishing: CRATES_TOKEN, PIP_TOKEN and NPM_TOKEN (2FA bypass, 90 days)
   as repository secrets, npm trusted publishing on the existing
   @zero-server packages, and a NuGet trusted publishing policy for
   repository molexxxx/zero-server, workflow `release-nuget.yml`, owner
   tonywied17, package globs `ZeroServer`, `ZeroServer.*`, `Zero-Server`,
   `Zero-Server.*`. Accounts: GitHub is molexxxx; crates.io, PyPI and
   NuGet are tonywied17. Owner decision 2026-10-01: releases publish to
   crates.io, PyPI and NuGet only, and npm starts at 2.0.0, once this core
   covers everything zero-server-node does, because `@zero-server/sdk` and
   `@zero-server/core` 1.1.0 on npm are that line's (3f1d67a gates
   release-node on the major version). The NuGet login names tonywied17
   (b59c3ca); the crates.io job has 300 minutes for the 27 new crates
   (60da9f2). At 2.0 the new npm names (`@zero-server/native`, the platform
   packages, the capability packages) need a token for their first publish,
   since npm trusted publishing is configured per existing package; the
   NPM_TOKEN set up on 2026-10-01 expires after 90 days, so a fresh one
   will be needed then.
   The site generator (`crates/xtask/src/site/home.rs`) still carries
   pieces of the project it was adapted from: the `farm` stage fallback,
   the "a {stage_name} node" caption and the dashboard link and
   `catalog.dashboard` card. Rework them before `pages.yml` leaves
   `workflow_dispatch`; the false feature lines are already gone.

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
  `ZERO_TEST_HANDOFF=1` makes the echo, driver and routing tests use the
  one-listener accept handoff those platforms run, on Linux, so a failure of
  that path reproduces here (`ListenConfig::handoff`).
- io_uring is available in this container (kernel 6.18, `io_uring_disabled`
  0), so `cargo test -p zero-io --no-default-features --features io-compio`
  exercises the ring and `zero-server --threads 1` prints `io-compio on
  io_uring` when built with the feature; a container whose seccomp profile
  blocks the ring takes compio's epoll fallback and prints `on epoll`.
- The container's descriptor hard limit is 20,000 (`ulimit -Hn`) over a soft
  limit of 4,096; `ulimit -n 20000` before `zero-bench idle`, since the server
  and the probe each hold one descriptor per connection, and a server past its
  limit leaves connections in the backlog where the probe's read times out.
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
