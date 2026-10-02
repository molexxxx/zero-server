# Release 1 benchmarks: what exists, what is missing, and how to build the publication

Audit of 2026-10-02, read-only. Scope: `crates/zero-bench`, `bench/`, the R.2 and R.3
benchmark design (`.github/cloud/ROADMAP.md`, `.github/cloud/DESIGN.md` sections 5.7, 8.6,
12.5, 13), DESIGN-12-13 section 9 and WP-15, the publication decision in
`.github/cloud/STATUS.md` ("Decisions already made", 2026-10-01) and the publication method in
`.github/cloud/RULES.md` (Conventions). Every external fact below was fetched on 2026-10-02 and
carries its URL in "Sources". Commands that measured this machine are quoted with their output.

## Summary

Today the repository holds the two zero-server TechEmpower entries, a closed-loop load
generator, an idle-memory probe, a route-miss timer, the binding probes and the TechEmpower
entry files. None of the publication exists: no competitor entry, no third-party load
generator, no orchestrator, no results data, no chart generator, no `BENCHMARKS.md`, no README
section, and no `docs/about/benchmarking.md` (which `.github/cloud/RULES.md` already links to). The
DESIGN-12-13 work packages deliver the Node binding and the boundary micro-harness (WP-15),
which are prerequisites, but no package builds the published comparison. The design does not
cover four things the publication needs: a Node entry app, a public fixed-response route in
the facade, worker pinning that respects a cpuset, and the comparison harness itself.

The audit found 24 gaps (B1 to B24). Three of them would make published numbers wrong rather
than only missing:

- **B4.** `zero-io` pins worker `i` to absolute CPU `i`, so inside `--cpuset-cpus` it pins
  outside the allowed set or leaves some workers unpinned.
- **B9.** The Express and Fastify TechEmpower entries size their cluster with
  `os.cpus().length`. Under a 6-CPU cpuset that returned 14 (measured), so those servers
  would run more than twice as many processes as they have CPUs.
- **B14.** Docker's default seccomp profile blocks `io_uring_setup` (measured), so an
  `io-compio` row silently falls back to epoll.

The design below uses these tools:

- **Throughput:** wrk, the generator TechEmpower used for every round.
- **Fixed-rate latency:** oha 1.16.0, for the latency-corrected test.
- **Cross-check:** zero-bench's own generator.

It covers two language groups in release 1, Rust (with Drogon as the C++ reference) and Node.
Python and .NET are stated as not measured, because their facades do not serve requests in
release 1. One full session is five interleaved runs of 12 entries, about 6.5 hours of
machine time on the owner's 9950X3D under WSL2.

## What exists today

| Item | Where | State |
| --- | --- | --- |
| Realistic entry (router, `zero-limits` defaults, `Server: zero`, `Date`) | `crates/zero-bench/src/entries.rs:60-97`, bin `zero-server` | json and plaintext only; no parameter route, no static route, no `zero-policy` |
| Platform entry (raw handler) | `entries.rs:99-121`, bin `zero-server-plt` | json and plaintext |
| Load generator | `crates/zero-bench/src/load.rs` | closed loop on tokio; pipelining; counts non-200 and unparsable responses as errors; latency is per batch round trip (`load.rs:239-241`), not per request; no rate mode; text output only (`bin/zero-bench.rs:63-85`) |
| Idle probe | `crates/zero-bench/src/idle.rs` | `VmRSS` of one pid before and after; connects without choosing a source address; one-byte reads of the head |
| Route-miss timer | `crates/zero-bench/src/miss.rs` | median of batches; 230 ns at 400 routes recorded in STATUS (plan-only figure) |
| Entry tests | `crates/zero-bench/tests/entries.rs` | json and plaintext shape, short zero-error loads |
| TechEmpower entry files | `bench/techempower/` | `benchmark_config.json`, two dockerfiles `FROM rust:latest`, README |
| Binding probes and Linux reruns | `bench/probes/**`, `cargo xtask probes` (`crates/xtask/src/probes.rs`) | Node 24.21.0, Python 3.13.15, .NET 10.0.12 results committed; images by floating tag (`node:24`, `python:3.13`, `mcr.microsoft.com/dotnet/sdk:10.0`) |
| `just bench <command>` | `justfile:104-106` | runs one `zero-bench` command |
| Boundary cells | DESIGN-12-13 section 9.2, WP-15 | planned (line 6 of the package order), results to `.docs/bench/` |
| Published comparison, competitor entries, generator images, orchestrator, results data, charts, `BENCHMARKS.md`, README section, `docs/about/benchmarking.md` | none | `Test-Path BENCHMARKS.md`, `bench/results`, `docs/about/benchmarking.md`: all False |

In flux while this was read: `crates/zero-bench/Cargo.toml` gained `zero-host` and `zero-ffi`
dependencies for the boundary cells (uncommitted, WP-1). `crates/zero-host` is a placeholder
(`src/lib.rs`, 761 bytes). `zero-ffi` exports only the version. The Node binding exports only
the version (`bindings/node/src/lib.rs`, 1,297 bytes). `crates/zero-sys/src/affinity.rs`,
`Cargo.toml`, `docs/standards.toml`, `docs/capabilities.toml` and `fuzz/` carry other agents'
uncommitted edits. None of these edits touches the gaps below except where noted.

## What DESIGN-12-13 delivers toward the benchmark (counted as planned)

- **WP-8 to WP-11.** Host dispatch, the C ABI, the Node native crate and the facade
  (`createApp`, `listen({ threads, isolates })`, `res.json`, `res.sendFile`, `static`). This
  is the precondition for any Node row.
- **WP-15.** The boundary cells of section 9.2, including `node_json_handler` ("the json test
  through a Node handler against uwebsockets.js", recorded before any yardstick claim) and the
  gated `node_grid_*` cells. The design covers these in full. Results go under `.docs/bench/`,
  which is gitignored. That suits a gate, but not a figure that is published (see B20).
- **Native `appRoute(kind, ...)`** with `ROUTE_FIXED` (`status`, `contentType`, `body`) and
  `ROUTE_STATIC`, in sections 6.9 and 8.10. The public facade table of section 8.11 exposes
  `static` but no fixed-response route (see B10).

Not covered by any work package:

- the Node benchmark apps;
- the competitor entries;
- the generators;
- the orchestrator;
- the results format;
- the charts, `BENCHMARKS.md` and the README section;
- the cpuset-aware pinning.

## Gaps

Each gap gives what is missing, the evidence, why it matters for release 1, and what closes it.

### B1. No published comparison exists

- **Missing:** `BENCHMARKS.md`, `bench/results/<date>/`, generated charts and the README
  overview that the owner decision of 2026-10-01 (STATUS, "Decisions already made") requires.
- **Evidence:** `Test-Path` returned False for `BENCHMARKS.md`, `bench/results` and
  `docs/about/benchmarking.md`. The README (171 lines) has no performance section.
- **Why it matters:** the owner's bar is "benchmarked with the release, published as a
  benchmark page with charts".
- **Closes it:** the build order below, steps 1 to 10.

### B2. No credible primary load generator

- **Missing:** a third-party generator. zero-bench's own has four limits:
  - it is closed loop with no rate mode;
  - it reports batch latency, not per-request latency (`load.rs:203-241`);
  - its response parser allocates per read (`Parser::feed` returns a `Vec`, `head`
    `extend_from_slice`, `split_off`), which costs generator CPU;
  - it prints text only.
- **Evidence:** `load.rs` and `bin/zero-bench.rs` as cited.
- **Why it matters:** a comparison measured with the author's own generator is not credible
  to readers. TechEmpower's figures come from wrk (`toolset/wrk/*.sh` at 523534bb). A
  closed-loop generator also cannot measure latency at a defined load (coordinated omission).
- **Closes it:** wrk for throughput and oha for fixed-rate latency (decision below). Keep
  zero-bench `load` as a cross-check, and add `--json` output to all three zero-bench commands.

### B3. The zero-server entries lack the routed-parameter and static-file tests

- **Missing:** a `GET /users/:id` route in a realistic route table, and a static route over
  `zero-static`.
- **Evidence:** `entries.rs:50-77` registers only `/json` and `/plaintext`.
- **Why it matters:** the owner's test list includes "a routed parameter, static file".
- **Closes it:** add to `Realistic` the miss harness's table shape (`miss::table`, the 100
  `/api/v1/resource<n>/:id` routes), a `/users/:id` route answering the decoded parameter as
  `text/plain`, and `/static/*` mounted on `zero_static::Files` over a fixed directory. Add
  tests in `tests/entries.rs` for each.

### B4. Worker pinning ignores the process's allowed CPUs

- **Missing:** the mapping from a worker index to the n-th allowed CPU.
- **Evidence:**
  - `crates/zero-io/src/tokio_rt/worker.rs:371` calls
    `zero_sys::affinity::pin_current_thread(&[index])`, and
    `crates/zero-io/src/compio_rt/worker.rs:359` does the same.
  - `pin_current_thread` sets absolute CPU ids (`zero-sys/src/affinity.rs:37-63`).
  - `net.rs:74-75` passes the same core index to `SO_INCOMING_CPU`, which is off by default.
  - `zero_sys::affinity::current_thread_cpus()` exists (`affinity.rs:76`) but only its test
    calls it (`git grep current_thread_cpus`).
- **Why it matters:** with `--cpuset-cpus 1-4` and 4 workers, worker 0's pin to CPU 0 fails.
  It runs unpinned, workers 1 to 3 pin to CPUs 1 to 3, and CPU 4 serves only the floating
  worker. With a generator-side cpuset the pins land outside the set. The published numbers
  would understate zero-server, or vary with the cpuset chosen. The same defect affects
  production in any cpuset-limited container (Docker `--cpuset-cpus`, Kubernetes static CPU
  manager, `taskset`).
- **Closes it:** pin worker `i` to `allowed[i % allowed.len()]`, with `allowed` read once
  through `current_thread_cpus()` before the workers start; the same mapping for
  `SO_INCOMING_CPU`. Add a test that restricts the mask with `pin_current_thread` before
  `serve` and asserts every worker reports `pinned()` on a CPU inside the mask. This is a bug
  fix, so it ships with a test that fails on the current code (RULES, Testing).

### B5. The entry dockerfiles use `rust:latest`

- **Missing:** pinned base images.
- **Evidence:** `bench/techempower/zero-server.dockerfile:1` and `zero-server-plt.dockerfile:1`
  read `FROM rust:latest`. RULES, Currency: "`latest` in any manifest or workflow" is a defect.
- **Why it matters:** a published figure must be reproducible from a committed command (RULES,
  Conventions). `latest` changes under the reader.
- **Closes it:** `FROM rust:1.99.0-slim-trixie@sha256:01dd4f9c24801cfc8ba9cf8a5dd6dcca451cd17d1ae73574edc22591de6e6816`
  (Docker Hub, read 2026-10-02; Rust 1.99.0 released 2026-10-01). Copy `Cargo.lock` and build
  with `--locked`, and drop `cargo clean`, which does nothing in a fresh image. The lint image
  may stay on `rust:latest` as `.github/cloud/RULES.md` records, but no benchmark image may.

### B6. The idle probe cannot measure multi-process servers or more than about 28,000 connections

- **Missing:**
  - a memory reading that covers every process of an entry;
  - source-address spreading;
  - a JSON report.
- **Evidence:**
  - `idle.rs:41-50` reads `VmRSS` of one pid.
  - `idle.rs:77` connects without binding a source address.
  - In a container on this machine, `cat /proc/sys/net/ipv4/ip_local_port_range` printed
    `32768 60999`, which allows 28,232 connections to one address and port.
  - The Node TechEmpower entries are cluster-mode multi-process servers (`app.js` of `nodejs`,
    `express`, `fastify`; `clustered.js` of `uwebsockets.js`).
- **Why it matters:** "memory per idle connection" is in the owner's test list. DESIGN 5.7
  also asks for 100k and 1M connections on zero-server. A `VmRSS` of one Node worker misses
  the others, and a sum of `VmRSS` counts shared pages twice.
- **Closes it:** read the server container's cgroup v2 `memory.stat` (`anon`, `sock`,
  `kernel`) before and after, through `docker exec <server> cat /sys/fs/cgroup/memory.stat`,
  and keep `VmRSS` as a cross-check for single-process entries. Bind each client socket to a
  source address in `127.0.0.2` to `127.0.0.255`, round-robin, before connect. Read the head
  with a buffered reader. Add `--json`. Publish 10,000 connections for every entry, and record
  100k (and 1M if the 24 GB VM holds it) for zero-server only, as DESIGN 5.7 gates.

### B7. No verification step before measuring

- **Missing:** the TechEmpower-style check of every entry's responses before its numbers are
  used. DESIGN 12.5: "the Drogon container passes every verification before its numbers are
  used".
- **Evidence:** no such code exists. zero-bench's `tests/entries.rs` checks only zero-server.
- **Why it matters:** a misconfigured competitor (wrong `Content-Type`, missing `Date`,
  404 on a route) yields a wrong number.
- **Closes it:** the orchestrator issues one request per test and asserts status 200, body,
  `Content-Type`, `Content-Length`, `Server` and `Date` (the TechEmpower rules quoted under
  "Tests"). It excludes a failing entry from that test, with the reason in the results file.

### B8. The VM's listen backlog and descriptor limits are below the 16,384-connection level

- **Missing:** session sysctls and ulimits.
- **Evidence:**
  - In a `--network host` container, `/proc/sys/net/core/somaxconn` printed `4096`.
  - TechEmpower runs every server with `sysctls={'net.core.somaxconn': 65535}` and
    `nofile` 200,000, but passes no `net.*` sysctl in host network mode
    (`toolset/utils/docker_helper.py:176-185`, 523534bb).
  - The zero-io listener backlog default is 1,024 (`zero-io/src/net.rs:42`).
- **Why it matters:** at 16,384 connections a small backlog shows up as wrk connect errors,
  and RULES requires every error counter at zero for a published figure.
- **Closes it:** at session start, run
  `docker run --rm --privileged --network host <harness image> sysctl -w net.core.somaxconn=65535 net.ipv4.tcp_max_syn_backlog=65535`,
  record both values in the results file, and start every container with
  `--ulimit nofile=200000:200000`. Each entry keeps its own backlog setting as its production
  configuration does; zero-server's 1,024 per core is its own choice.

### B9. Two Node entries oversubscribe a cpuset

- **Missing:** worker counts sized to the CPUs the container may use.
- **Evidence:**
  - Measured: `docker run --rm --cpuset-cpus 1-6 node:24.21.0-slim node -e "...os.cpus().length, os.availableParallelism()"`
    printed `cpus().length 14 availableParallelism 6 v24.21.0`.
  - The Express entry (`app.js`, `numCPUs = require('os').cpus().length`) and the Fastify
    entry (`app.js`, same) fork 14 processes on 6 CPUs.
  - The `nodejs` and `uwebsockets.js` entries use `availableParallelism()`.
- **Why it matters:** an entry configured differently from its production intent ("one process
  per CPU") is not the entry "built and configured the way its own project documents for
  production" (RULES).
- **Closes it:** a one-line patch in each of the two entries, from `os.cpus().length` to
  `os.availableParallelism()`, recorded as a deviation in the entry's `ENTRY.md` and on the page.

### B10. The Node facade has no public fixed-response route

- **Missing:** a user-facing way to declare from TypeScript a route answered in Rust with a
  fixed body.
- **Evidence:** DESIGN-12-13 section 6.9 defines `ROUTE_FIXED` and section 8.10 exposes native
  `appRoute(app, kind, ...)`. The facade table of section 8.11 lists `static` as the only tier 0
  route a user declares.
- **Why it matters:** the owner decision asks for two zero-server rows per language group:
  "routes declared at startup and answered in Rust" and "a handler written in that language".
  Without a fixed route, the first Node row exists only for the static test.
- **Closes it:** a small WP-11 addition, for example
  `app.get('/plaintext', fixed({ contentType: 'text/plain', body: 'Hello, World!' }))`
  exported from `@zero-server/sdk`, with a facade test and a guide line. Even with it, that row
  has no json cell. TechEmpower's json rule says "The serialization to JSON must not be cached;
  the computational effort to serialize an object to JSON must occur within the scope of
  handling each request", and a fixed body is a cached serialization. The page shows "not
  applicable" there, with the rule quoted. Plaintext from a fixed route is comparable to the
  uwebsockets.js TechEmpower entry, which answers plaintext with a `DeclarativeResponse`
  (`src/server.js`). The fixed route must still compose `Date` and the other fields per
  response ("the rest of the response must be fully composed on the spot").

### B11. No Node benchmark apps

- **Missing:** the two zero-server apps for the Node group, under `bench/entries/node/`:
  - `zero-server-rust-routes`: a fixed plaintext route and `static`;
  - `zero-server-js`: JavaScript handlers for plaintext, json and `/users/:id`, `sendFile` in a
    handler for the static test.
- **Evidence:** no work package in DESIGN-12-13 section 14 names them. The `node_json_handler`
  cell of WP-15 is a micro-harness cell, not an entry served to wrk.
- **Why it matters:** without them the Node group has no zero-server rows.
- **Closes it:** two small apps against the public facade only (no native calls), with
  `listen({ port: 8080, threads: N, isolates: N })`, where N comes from
  `os.availableParallelism()`, and `NODE_ENV=production`.

### B12. No competitor entries

- **Missing:** hyper, axum, actix-web, Drogon, node:http, Express, Fastify and uWebSockets.js
  entries, each built from its TechEmpower entry. Each also needs routed-parameter and static
  routes where the framework has a router or static server.
- **Evidence:** nothing under `bench/` but zero-server's own files.
- **Why it matters:** these are the named comparisons of the owner decision.
- **Closes it:** the entry table below; one directory per entry with an `ENTRY.md` that records
  the source URL and commit, every deviation and the image digest.

### B13. No orchestrator

- **Missing:**
  - the session runner: quiet-machine check, cpusets, sysctls, entry start and stop,
    verification, primer, warm-up, levels, interleaving, cgroup CPU and memory sampling, raw
    log capture, `results.json`;
  - the report step: medians, ratios, error gate, tables.
- **Evidence:** none in `crates/xtask/src` (the task list has `probes` but no `bench`) and none
  under `bench/`.
- **Why it matters:** five interleaved runs over 12 entries is about 6.5 hours of machine time.
  It cannot be done by hand reproducibly, and RULES requires "the command that reproduces it in
  the repository".
- **Closes it:** `cargo xtask bench` (the `probes.rs` pattern: `docker` through `Command`, unit
  tests for every pure part), with subcommands `build`, `verify`, `run`, `report`.

### B14. Docker's default seccomp profile blocks io_uring

- **Missing:** a uniform container security setting.
- **Evidence:** measured on this machine. `docker run --rm zero-server-lint python3 /s/uring.py`
  (`syscall(425, 1, NULL)`) printed `io_uring_setup rc -1 errno Operation not permitted`. With
  `--security-opt seccomp=unconfined` it printed `Bad address`, which means the syscall reached
  the kernel. TechEmpower starts every server container `privileged=True`
  (`docker_helper.py:239`), which disables seccomp.
- **Why it matters:** an `io-compio` row (DESIGN 5.7 records both backends in release 1) would
  silently run on compio's epoll fallback. Entries would also run under different security
  settings than TechEmpower's.
- **Closes it:** start every server container with `--security-opt seccomp=unconfined`, the
  part of TechEmpower's `privileged` that changes behavior here, and state it on the page.
  Record the backend line each zero-server entry prints (`entries::backend()`, for example
  `io-compio on io_uring`), and fail the cell if it does not name `io_uring`.

### B15. No quiet-machine precondition in code

- **Missing:** a scripted check that nothing else runs.
- **Evidence:** during this audit `docker ps` listed `zero-fuzz` (up 16 hours) and four
  `zero-server-lint` build containers from other agents.
- **Why it matters:** the published numbers would include other agents' compiles and the fuzz
  campaign.
- **Closes it:** the orchestrator:
  - refuses to start while any container outside its own label is running, except `zero-fuzz`,
    which it pauses (`docker pause zero-fuzz`) and resumes in a `finally` path;
  - before each cell, samples `/proc/stat` for 5 s in the VM and requires at least 97 percent
    idle on every vCPU outside the two cpusets, and `/proc/loadavg` below 0.5;
  - at session start, samples Windows `\Processor(_Total)\% Processor Time` for 10 s through
    PowerShell (below 3 percent);
  - records all of it in `results.json`.

### B16. WSL2 hides the CPU topology

- **Missing:** a statement and a mitigation.
- **Evidence:**
  - Windows reports `NumberOfCores 16`, `NumberOfLogicalProcessors 16` (SMT off).
  - `lscpu` in a container shows 14 cores, `Thread(s) per core: 1`, `L3 cache: 96 MiB (1 instance)`.
  - The 9950X3D's second cache die is invisible, and Hyper-V places vCPUs on any host core,
    so a cpuset pins vCPUs, not cores.
- **Why it matters:** cpusets separate the server from the generator inside the VM, but cannot
  keep both off the same physical core or cache die.
- **Closes it:** keep `processors=14` in `.wslconfig`, which leaves Windows two cores. Run with
  the Ultimate Performance plan (active now, measured with `powercfg /getactivescheme`).
  Publish the run-to-run spread (min and max of the five runs) beside every median, and state
  on the page that the run is "one desktop under WSL2" (owner decision).

### B17. Drogon's TechEmpower entry needs a database host to start as written

- **Missing:** a Drogon configuration for tests without a database.
- **Evidence:** `frameworks/C++/drogon/drogon_benchmark/config.json` (archived master 57d92fbe)
  declares `db_clients` with `host: tfb-database`. Its dockerfile pins Drogon commit
  `96919df488e0ebaa0ed304bbd76bba33508df3cc` and mimalloc v1.6.7. The current release is
  v1.9.13 (2026-05-07).
- **Why it matters:** without the database host Drogon either retries forever or logs errors
  on every turn, and it is the C++ reference the design names.
- **Closes it:** use `config.json` with `db_clients` removed (a documented deviation; none of
  the published tests touch a database), Drogon checked out at the v1.9.13 tag commit, and
  everything else as the entry builds it. Keep the pinned Round 23 entry (commit 96919df4) as
  a raw-data row for the R.2 thesis ratio, not on the charts.

### B18. The Realistic entry does not match its definition

- **Missing:** the `zero-policy` defaults. R.2 defines the Realistic entry as "through the
  router, `zero-limits` and `zero-policy` defaults" (also DESIGN 12.5).
- **Evidence:** `entries.rs` builds a router and `Config` with no policy, and
  `zero-http/src/server.rs:109-116` `Config` has no policy field.
- **Why it matters:** the page must say exactly what the entry runs. Competitors' TechEmpower
  entries add no security headers either, so the choice is about honesty, not advantage.
- **Closes it:** either apply the default policy set an application gets when it adds
  `zero-policy` with no options (and say so), or amend R.2 and DESIGN 12.5 to "router and
  `zero-limits` defaults". Recommended: amend. The policy subset is opt-in today, and the entry
  should match what `serve` does by default.

### B19. The plan and the public text contradict the owner decision

- **Missing:** amendments.
- **Evidence:**
  - `web/home.toml:181-188` says numbers are taken on "a rented Linux host, or two bare-metal
    instances on the same switch", that "no throughput or latency figure is published" until
    then, and promises "a win required in every run".
  - ROADMAP R.3 rows 7 and 14 require tier A, B and C runs on rented hardware, results "under
    `.docs/bench/`" and "the owner's go decision".
  - STATUS line 752 records "The tier C benchmark needs rented hardware and is skipped".
  - The owner decision of 2026-10-01 moved publication to the 9950X3D.
- **Why it matters:** RULES requires that public text describes only what exists, and that
  every change that ships a capability audits `web/home.toml` and the README in the same
  commit. A plan whose exit criteria cannot be met leaves release 1 undefined.
- **Closes it:**
  - Rewrite the `[backing]` text in the publication commit: one desktop, the method of RULES,
    and no "win required" clause, since a publication reports ratios whatever they are.
  - Amend R.3 rows 7 and 14 to the desktop run, with tiers A to C as a later rented run.
  - Record the R.2 thesis ratio as an open owner decision (see "Open decisions").

### B20. Gate results and published results go to different places

- **Missing:** one home for the numbers the page shows.
- **Evidence:** DESIGN-12-13 WP-15: "results under `.docs/bench/`" (gitignored). The owner
  decision puts "the raw data under `bench/results/<date>/`" in the repository.
- **Why it matters:** RULES: "the raw data and the command that reproduces it in the
  repository".
- **Closes it:** published comparisons go to `bench/results/<date>/`. WP-15's gated cells stay
  in `.docs/bench/` unless a cell is quoted publicly, in which case its JSON joins the dated
  folder.

### B21. No results format, no report, no generated tables

- **Missing:** a schema for `results.json`, the medians and ratios computation, and
  generated table regions so prose numbers cannot drift from the data.
- **Evidence:** none exists. `crates/xtask/src/regions.rs` already renders
  `<!-- table: ... -->` regions in hand-written Markdown, and `cargo xtask docs --check`
  reports a hand edit.
- **Why it matters:** RULES forbids any performance number in public text that does not come
  from a committed run.
- **Closes it:** the schema below; `cargo xtask bench report` writes `summary.json`; a
  `table: bench <group> <test>` renderer in xtask's docs task, used by `BENCHMARKS.md` and the
  README.

### B22. No chart generator

- **Missing:** `scripts/bench_charts.py` and the shared glyph code.
- **Evidence:** `scripts/` holds `architecture.py` (846 lines; `Face` at line 169 and `Canvas`
  at line 185 outline Outfit and JetBrains Mono from pinned google/fonts commits with SHA-256
  checks) and nothing for charts.
- **Why it matters:** the owner asked for SVG charts in the brand palette, generated by a
  script like `scripts/architecture.py`.
- **Closes it:** move `Face`, the font download and `num`/`esc` into `scripts/svgglyphs.py`
  imported by both scripts (rerun `architecture.py` and check that its six files are byte
  for byte unchanged), then the chart script specified below.

### B23. The brand palette cannot carry categorical chart colors

- **Missing:** a chart color scheme that passes the dataviz checks.
- **Evidence:** the dataviz validator (`validate_palette.js`, run 2026-10-02):
  - `#688D00,#8C6A12,#A39E93` on white, all pairs: CVD separation FAIL (`#8C6A12` against
    `#688D00` ΔE 4.8 deutan) and normal-vision FAIL (ΔE 11.1).
  - `#D9F542,#CFAE45,#A39E93` on `#0d1117`: normal-vision FAIL (ash against brass ΔE 12.6).
  - Two-color pairs pass. Light, moss `#688D00` against ash `#A39E93` on white: normal ΔE 17.5,
    CVD ΔE 14.2; ash contrast 2.67:1 is a WARN that visible labels relieve. Dark, flare
    `#D9F542` against ash on `#0d1117`: normal ΔE 28.4, CVD ΔE 26.8, both at or above 3:1.
  - The chroma FAIL on ash is expected, since it is the deliberate neutral.
  - Every brand hue sits between 41 and 76 degrees (`docs/brand.md`), so no third separable
    hue exists.
- **Why it matters:** five-entry line charts with one color per entry cannot meet the checks.
- **Closes it:**
  - emphasis bar charts: zero-server in the accent, every other entry in ash, a direct label
    and value on every bar, and a table under every chart;
  - per-level detail as tables, not multi-series line charts;
  - the two zero-server rows of the Node group share the accent and differ by label and a
    45-degree hatch on the JavaScript-handler row.

### B24. No documentation of how to run it

- **Missing:** `docs/about/benchmarking.md`.
- **Evidence:** `.github/cloud/RULES.md`, Commands: "Bench: `just bench <entry>` (Linux host or container;
  see docs/about/benchmarking.md)". The file does not exist. The `just bench` recipe takes one
  argument (`justfile:105`), so `just bench load --connections 256` needs quoting.
- **Why it matters:** this is a dangling link in a checked-in file, and the reproduce command
  must be documented.
- **Closes it:** write the page (how to run a session, prerequisites, what each command
  writes), make `just bench` accept variadic arguments (`bench +args:`), and link the page
  from `BENCHMARKS.md`.

## The published benchmark, designed

### Load generator

Fetched 2026-10-02 from the GitHub API and each tool's documentation at its latest tag:

| Tool | Latest release, last commit | Pipelining | Fixed-rate latency | Output | Credibility | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| wrk (wg/wrk) | tag 4.2.0; last commit 2021-02-07; not archived; 40,417 stars; Ubuntu 24.04 ships 4.1.0-4build2 (4.1.0 to 4.2.0 is 8 build-only commits) | yes, through Lua (`pipeline.lua`) | no (closed loop) | text, plus a Lua `done(summary, latency, requests)` hook with `errors.connect/read/write/status/timeout` | TechEmpower used it for every round (`toolset/wrk/wrk.dockerfile`: `ubuntu:24.04` plus `apt-get install wrk`) | **primary throughput generator**, in TechEmpower's own image recipe and scripts |
| oha (hatoo/oha) | v1.16.0, 2026-08-23; active | no | yes: `-q` with `--latency-correction` ("Correct latency to avoid coordinated omission problem") | JSON (`--output-format json`, schema in repo) | used by the-benchmarker/web-frameworks for its corrected pass | **fixed-rate latency generator** |
| h2load (nghttp2) | v1.70.0, 2026-07-29; active | yes: `-m` "When http/1.1 is used, this specifies the number of HTTP pipelining requests in-flight" | `--rps` per client, measured from request send, so not corrected for coordinated omission | JSON with p95 and p99 and raw samples (`--output-file`) | well known, not used by TechEmpower | fallback if wrk fails to saturate; not on the page |
| wrk2 (giltene/wrk2) | no release; last commit 2019-09-24 | Lua | yes, corrected | text | historic reference for corrected latency | rejected: seven years without a commit; oha covers its role |
| rewrk (lnx-search) | 0.3.2, 2021-11-07; last commit 2023-02-12 | no | no | text | low | rejected: unmaintained |
| vegeta | v12.13.0, 2025-10-31 | no | yes, open loop | JSON | good for latency | not needed beside oha |
| bombardier | v2.0.2, 2025-03-04 | no | rate limit, uncorrected | text or JSON | moderate | rejected |
| autocannon | v8.0.0, 2024-10-14 | yes | no | JSON | Node-hosted client; tops out below the servers measured here | rejected |
| zrk (zoxy-io/zrk) | young Zig tool, 22 stars | no | yes | JSON | used by the-benchmarker since 2026-09 | rejected: no track record yet |
| zero-bench `load` | in tree | yes | no | text (needs `--json`) | the author's own | **cross-check only** |

Usage:

- **wrk.** Image `bench/docker/wrk.dockerfile` built from
  `ubuntu:24.04@sha256:a853f94d226358a79c740cfc7bce0c289748f3fe3488d921d038ccd752c61b60`
  with `apt-get install wrk=4.1.0-4build2`. It carries TechEmpower's `pipeline.lua` unchanged,
  plus a separate `report.lua` that defines only `done()` and prints one JSON line.
  Defining `response()` would make wrk parse every response in Lua and slow it, so it stays
  undefined. The flags are TechEmpower's:
  `-H 'Host: ...' -H 'Accept: ...' -H 'Connection: keep-alive' --latency -d 15 -c <c> --timeout 8 -t min(c, nproc)`.
  The Accept value is `text/plain,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,*/*;q=0.7`
  for plaintext, and the json value from `json.py`.
- **oha.** Image `bench/docker/oha.dockerfile`: `cargo install --locked oha --version 1.16.0`
  in `rust:1.99.0-slim-trixie@sha256:01dd...6816`, copied into a slim runtime stage.
- **zero-bench.** It runs in every session at plaintext 256 connections (pipeline 16) and json
  256 connections against zero-server and one competitor per group. The report compares the
  ratio zero-bench measures with the ratio wrk measures in the same run, and flags a
  disagreement above 5 percent. The 5 percent threshold is a starting value (judgment).

### Entries per language group

Versions are fetched 2026-10-02:

- crates.io: hyper 1.11.1, hyper-util 0.1.21, axum 0.8.9, actix-web 4.15.0, actix-http
  3.18.12, actix-files 0.7.0, tower-http 0.7.1, tokio 1.53.1.
- npm: express 5.2.1, fastify 5.12.5, @fastify/static 10.1.5, serve-static 2.2.1.
- GitHub: uWebSockets.js v20.71.0 (2026-09-16), Drogon v1.9.13 (2026-05-07).
- Node: 24.21.0 Active LTS.
- Rust: 1.99.0.

Re-fetch on the run date; the results file records what was used.

Every entry's source is the TechEmpower tree's final commit
`57d92fbec6f8fd7431bc77326dd0484e60c96e20` (2026-03-23; the repository is archived,
`pushed_at` 2026-03-24). The framework crate or package is moved to today's stable version.
Everything else stays at the entry's lockfile, with any code change an upgrade forces recorded
in `ENTRY.md`.

Rust group (one zero-server row; the Platform and `io-compio` rows in the raw data only):

| Entry | Source and build | Configuration | Deviations to record |
| --- | --- | --- | --- |
| zero-server | `crates/zero-bench` bin `zero-server`, workspace release profile (fat LTO, one codegen unit, `overflow-checks = true`, `panic = "unwind"`), `RUSTFLAGS=-C target-cpu=native` as the TechEmpower entries use | `--threads <cpuset size>`, per-core `SO_REUSEPORT` listeners (`io-tokio`) | none; the `io-compio` build runs as a raw-data row with its backend line recorded |
| hyper | `frameworks/Rust/hyper`, `hyper.dockerfile` (`cargo install --path . --locked`) | `docker_cmd` `hyper-techempower --runtime current-thread` (the `default` test); threads from `num_cpus::get()`, which follows the affinity mask | base image `rust:1.85` to the pinned 1.99.0; hyper to 1.11.1 |
| axum | `frameworks/Rust/axum`, `axum.dockerfile` (`cargo build --release`, distroless runtime), mimalloc | `/app/axum`, port 8000 | axum to 0.8.9; base image pinned |
| actix-web | `frameworks/Rust/actix`, `actix.dockerfile`, bin `tfb-web` (snmalloc, simd-json-derive, `KeepAlive::Os`, backlog 1,024) | `default` test, "Actix Web" | actix-web to 4.15.0; base image pinned |
| Drogon (C++ reference) | `frameworks/C++/drogon`, `drogon.dockerfile` (`ubuntu:22.04`, `-flto`, mimalloc v1.6.7) | `config.json`, `threads_num 0` | Drogon at v1.9.13 instead of 96919df4; `db_clients` removed (B17); `ubuntu:22.04` by digest `sha256:b1066385...d7f7` |

Node group (two zero-server rows):

| Entry | Source and build | Configuration | Deviations to record |
| --- | --- | --- | --- |
| zero-server, routes in Rust | `bench/entries/node/zero-server-rust-routes` (B11) over `@zero-server/sdk` built from this commit | `listen({ threads: n, isolates: n })`; plaintext from the fixed route (B10); `app.use(static(dir))` | none; json and parameter cells "not applicable" |
| zero-server, JavaScript handler | `bench/entries/node/zero-server-js` | `res.type('text/plain').send(...)`, `res.json({ message })` per request, `/users/:id` with `req.params.id`, `res.sendFile` | none |
| node:http | `frameworks/JavaScript/nodejs` (`cluster`, `availableParallelism()`, `parseurl`) | `NODE_ENV=production` | `node:21.1.0-slim` to `node:24.21.0-slim@sha256:0e0ff40c...b6`; parameter and static "not applicable" (no router or static server in node:http) |
| Express | `frameworks/JavaScript/express` (express 5.2.1, `fast-json-stringify`, `keepAliveTimeout 0`) | `cluster` | `os.cpus().length` to `os.availableParallelism()` (B9); Node 24.21.0 already; `/users/:id` and `express.static` added per the Express 5 documentation |
| Fastify | `frameworks/JavaScript/fastify` (`logger: false`, `keepAliveTimeout: 0`, response schema on `/json`) | `cluster` | fastify `^5.1.0` resolved to 5.12.5; Node 20.16 (end of life 2026-04-30 per ROADMAP R.5) to 24.21.0; `os.cpus().length` patch; `/users/:id` and `@fastify/static` 10.1.5 added |
| uWebSockets.js | `frameworks/JavaScript/uwebsockets.js` (`clustered.js` with `availableParallelism()`, `DeclarativeResponse` for plaintext) | `npm start` | `#v20.44.0` to `#v20.71.0`; Node 20 to 24.21.0; `/users/:id` with `getParameter(0)` added; static "not applicable" (no built-in static server) |

One Node version for the whole group is a deliberate deviation. The entries' own images
include Node 20, which is past end of life, and a single runtime isolates framework cost. The
page states this.

Where the TechEmpower entry has no route for a test, the added route follows the framework's
documentation at the pinned version (fetch and cite in `ENTRY.md`):

- actix-files `Files::new`;
- tower-http `ServeDir` (axum);
- Drogon's `document_root` with its `static_files_cache_time`;
- `express.static`;
- `@fastify/static`;
- axum 0.8 path syntax `/{id}`;
- Drogon `/users/{1}`.

Each competitor's maintainers' production settings stand (for example Drogon's 5-second static
cache and Express's uncached `serve-static`). The page shows each entry's static-file
configuration in one line.

Python and .NET: not measured in release 1. The page says the Python and .NET packages load
the core but do not serve requests yet (README line 19, "have no server API yet"), and that
the groups join when the facades ship (ROADMAP step 21).

### Tests

TechEmpower rules quoted from the project wiki (fetched 2026-10-02):

- json: "For each request, an object mapping the key `message` to `Hello, World!` must be
  instantiated." and "The serialization to JSON must not be cached".
- plaintext: "It is acceptable but not required to re-use a single buffer for the response
  text (`Hello, World`). However, the rest of the response must be fully composed on the spot."
  and "Server support for HTTP/1.1 pipelining is assumed."
- all tests: "The response headers must include `Server` and `Date`." and "All test
  implementations must disable all disk logging."

| Test | Generator and shape | Levels | Published figure |
| --- | --- | --- | --- |
| plaintext, pipelined | wrk with `pipeline.lua` depth 16 (TechEmpower `plaintext.py`) | 256, 1,024, 4,096, 16,384 connections | requests per second at each level; the chart shows the best level per entry, as TechEmpower ranks |
| json | wrk, no pipelining | 16, 32, 64, 128, 256, 512 connections | requests per second at each level; the chart shows 256 and the table shows all |
| routed parameter | wrk, `GET /users/12345` against a table of 100 routes (`/api/v1/resource<n>/:id` under GET, POST, PUT, DELETE for 25 resources, the `miss.rs` shape) plus `/users/:id`; body is the parameter as `text/plain` | 256 connections | requests per second; entries without a router are "not applicable" |
| static file | wrk, `GET /static/app.css`, a 16 KiB file generated once by the orchestrator with fixed bytes, no conditional headers | 256 connections | requests per second |
| latency at a fixed rate | oha `-z 30s -c 64 -q R --latency-correction --no-tui --output-format json` on `/json`, after a 5 s oha warm-up at the same rate | one rate per group | p50, p99, p99.9 and max; the cell is valid only if the completed rate is within 1 percent of R with zero errors |
| memory per idle connection | the extended idle probe (B6): 10,000 keep-alive connections after one plaintext request each, 5 s settle | 10,000 | cgroup `anon` delta per connection, with `sock` and `kernel` beside it; the baseline resident memory of the idle server in the table |

Each wrk test runs TechEmpower's sequence:

1. a primer of 5 s at 8 connections;
2. a warm-up of 15 s at the highest json level (512);
3. one 15 s run per level, with 2 s between levels.

These match `concurrency.sh`, `pipeline.sh` and the `--duration` default of 15 in
`run-tests.py`. Each cell also records the server container's cgroup `cpu.stat` `usage_usec`
delta and the generator's, so CPU per request and a saturation check come from the same run.

The fixed rate R is set per group from a pilot run: half the slowest entry's median json
throughput at 256 connections, rounded down to two significant figures, and the same R for
every entry in the group. It is written into the session configuration before the five runs
start. the-benchmarker documents both a relative rate (50 percent of each framework's own)
and an absolute rate. The absolute rate is chosen here so that every entry is compared at the
same offered load.

### Machine and Docker layout

Measured on 2026-10-02:

- **CPU:** AMD Ryzen 9 9950X3D, 16 cores, 16 logical processors (SMT off).
- **Memory:** 32 GB DDR5-6000 (two G.Skill 16 GB modules).
- **Host OS:** Windows 11 Pro 10.0.26200, power plan Ultimate Performance.
- **WSL:** 2.7.12.0, kernel 6.18.33.2-microsoft-standard-WSL2; `.wslconfig` `processors=14`,
  `memory=24GB`, `swap=4GB`.
- **Docker:** Docker Desktop, engine 29.6.1, cgroup v2.
- **Kernel settings in the VM:** `io_uring_disabled` 0, descriptor hard limit 1,048,576,
  `somaxconn` 4,096.

Layout:

- **Networking.** `--network host` for every container, so the server and the generator talk
  over the VM's loopback. Docker's bridge and port publishing stay out of the path. The page
  states that the traffic never crosses a NIC, so the figures are not comparable with
  TechEmpower rounds.
- **CPU split (default, confirmed by the pilot).** vCPU 0 for the VM, dockerd and the
  orchestrator; the server on `--cpuset-cpus 1-4`; the generator on `--cpuset-cpus 5-13`.
  This follows the-benchmarker's guidance (README, fetched 2026-10-02): "Roughly three
  generator cores per server core are needed before a fast server saturates." The pilot also
  runs a 6 and 7 split. The split where the fastest entry in each group reaches at least
  90 percent server CPU with the generator below 90 percent of its cpuset is kept and
  recorded.
- **Saturation check.** Any cell where the server used under 90 percent of its cpuset is
  marked "generator-bound" in the table, as the-benchmarker's saturation check does.
- **Container options for every server:** `--ulimit nofile=200000:200000`,
  `--security-opt seccomp=unconfined` (B14), `--log-driver none` (TechEmpower: `log_config`
  type None), `--init`, `--memory 8g`. The generators get the same ulimit.
- **Session sysctls:** `net.core.somaxconn=65535` and `net.ipv4.tcp_max_syn_backlog=65535`,
  set once in the VM namespace and recorded (B8).
- **Quiet machine:** `zero-fuzz` paused and resumed afterward, no other container running, and
  the idle checks of B15 before each cell.
- **Worker counts:** every entry sized to the server cpuset. zero-server needs B4 fixed
  first; Express and Fastify need the B9 patch.

### Runs, medians and validity

- **Five runs in one session.** Run k visits the entries of each group starting at entry
  `k mod n`, so start-of-run warmth and thermal drift spread across entries. Each entry
  container is started fresh for each run and test group, as TechEmpower does. The order is
  recorded.
- **Medians.** The published figure per (entry, test, level) is the median of the five runs.
  The run-to-run minimum and maximum are shown beside it.
- **Ratios.** Ratios are computed within each run against zero-server's figure in the same run
  (the JavaScript-handler row in the Node group, the Realistic row in Rust). The page shows the
  median of the five per-run ratios, with their minimum and maximum. RULES: "the ratio against
  each entry measured in the same session beside the absolute number".
- **Errors.** A cell with any error counter above zero in any of the five runs (wrk
  connect/read/write/timeout/status, oha non-2xx or errors, a verification failure) is shown
  as "errors" with the counts, never as a number. This follows RULES, "every error counter at
  zero".
- **No win requirement.** The publication reports what was measured. Whether release 1 also
  needs a minimum ratio is an owner decision (below).

### Results data

`bench/results/<YYYY-MM-DD>/` contains:

- `session.json`: machine, versions, layout, sysctls, quiet checks;
- `results.json`: every measurement;
- `summary.json`: written by `report`;
- `raw/<run>/<entry>/<test>-<level>.txt`: every generator's stdout, and the server's start
  line and logs;
- `entries.json`: per entry, the image digest, source commit and deviations;
- `REPRODUCE.md`: the exact command, `cargo xtask bench run --session <file>`.

Shape of one measurement in `results.json`:

```json
{
  "run": 3,
  "order": 7,
  "group": "node",
  "entry": "express",
  "test": "json",
  "level": 256,
  "generator": { "tool": "wrk", "version": "4.1.0-4build2", "threads": 9, "duration_s": 15 },
  "started": "2026-10-09T01:12:03Z",
  "requests": 0,
  "requests_per_second": 0.0,
  "errors": { "connect": 0, "read": 0, "write": 0, "timeout": 0, "status": 0, "verify": 0 },
  "latency_us": { "p50": 0, "p90": 0, "p99": 0, "p999": 0, "max": 0 },
  "bytes": 0,
  "cpu_usec": { "server": 0, "generator": 0 },
  "memory": null,
  "backend_line": null
}
```

The zeros mark field types only; no figure here is a measurement. `summary.json` holds, per
cell, the median, minimum, maximum, the per-run ratios and their median, the error flag, the
generator-bound flag and the zero-bench cross-check result. The xtask report step is the only
writer of `summary.json`, and the chart script and the docs regions read only
`summary.json`.

### Charts

`scripts/bench_charts.py [--results bench/results/<date>] [--out assets/bench]` uses the
glyph module extracted from `architecture.py` (B22) and the pinned fonts. It writes:

- per group and test: `assets/bench/<group>-<test>.svg` (light, transparent, 960 wide),
  `-dark.svg`, and `-narrow.svg` (400 wide, carrying both palettes and switching with
  `prefers-color-scheme` inside the file). The narrow files follow the README `<picture>`
  lesson recorded in STATUS: GitHub rewrites any source that names a color scheme when a
  viewer picks one theme, so narrow selects by width only.
- `assets/bench/overview*.svg` for the README.

Chart form, from the dataviz method:

- **Throughput charts.** One horizontal bar per entry, sorted by value, at the headline level.
  zero-server bars are moss `#688D00` on light and flare `#D9F542` on dark. Every other entry
  is ash `#A39E93` in both. Every bar carries its entry label and its value (`1.23M req/s`
  style), with a thin whisker for the run minimum and maximum. The x axis starts at zero.
  "Requests per second, higher is better" is in the title, and the hardware line and the run
  date are in the caption.
- **Latency.** p99 bars with a tick at p50; "lower is better".
- **Memory.** Bytes per idle connection; "lower is better".
- **Per-level detail.** Tables only: a multi-series line chart needs more separable colors
  than the palette has (B23).
- **Accessibility.** Each SVG has `role="img"`, an `aria-label`, `<title>` and a `<desc>`
  holding the data as text, and the matching table sits under the chart in `BENCHMARKS.md`
  (the relief the contrast WARN requires). The glyphs are outlined, so no font is referenced.
  No color outside `docs/brand.md`.
- **Checks.** The script runs the hue rule and contrast checks of `scripts/brand.mjs` on its
  palette before writing. A test renders a fixture `summary.json` and checks structure (bar
  count, labels, the absence of any `font-family`, palette-only colors). Before commit the
  output is screenshotted in Chromium and Firefox in both schemes, as the diagram files were.

### BENCHMARKS.md and the README overview

`BENCHMARKS.md` (hand-written prose, generated tables):

1. What is measured and what is not (two language groups; Python and .NET not yet).
2. The machine, with the measured facts above and the one-desktop-under-WSL2 statement.
3. The method:
   - the generators and versions;
   - the TechEmpower sequence and levels;
   - the cpusets;
   - five interleaved runs, medians, per-run ratios;
   - the error rule;
   - the saturation flag;
   - the zero-bench cross-check.
4. Rust group: four charts (plaintext, json, parameter, static), each followed by its
   `<!-- table: bench rust <test> -->` region (all levels, median, min to max, ratio, CPU per
   request).
5. Node group: the same, with the two zero-server rows explained in one sentence each.
6. Latency at a fixed rate, and memory per idle connection, for both groups.
7. The entries, with source, version, image digest and every deviation.
8. Reproducing, with the command and a link to `docs/about/benchmarking.md`.
9. Limitations:
   - loopback, not a NIC;
   - vCPU placement under Hyper-V;
   - the second cache die;
   - not comparable with TechEmpower rounds;
   - one machine.

The README gets a `## Performance` section after "How it works": two sentences of method, the
overview picture (json at 256 connections for both groups, as two labeled panels each with its
own axis), one generated sentence from `<!-- table: bench overview -->` with the median ratios,
and a link to `BENCHMARKS.md`. The words come from the data; no adjective that the numbers do
not carry.

### Harness tests (the "heavily unit tested" bar for this code)

- **wrk parsing:** the `report.lua` JSON line, and the text fallback with
  `Socket errors: connect N, read N, write N, timeout N` and `Non-2xx or 3xx responses: N`.
- **oha parsing:** its JSON report against the schema at v1.16.0.
- **Ordering:** the rotation of entries per run.
- **Medians and ratios:** odd counts, a missing cell, the per-run ratio median.
- **Error gate:** one error in one run hides the cell.
- **Saturation flag:** the 90 percent threshold.
- **Cross-check:** the 5 percent disagreement.
- **Quiet check:** parsing `/proc/stat` and `/proc/loadavg`.
- **cgroup parsing:** `memory.stat` and `cpu.stat`.
- **Session file validation:** cpusets disjoint and inside 0 to 13; every entry's worker count
  equal to the server cpuset size.
- **Region renderer:** golden Markdown from a fixture summary.
- **Chart script:** structure checks as above.
- **zero-bench:** `--json` output for `load`, `idle`, `miss`; source-address spreading in the
  idle probe (a unit test over the address iterator and a 2,000-connection loopback test);
  cgroup reading.
- **zero-io:** the cpuset pinning test of B4.

## Build order

1. **Preconditions from DESIGN-12-13:** WP-8 to WP-11 merged (Node serves requests), plus two
   additions to WP-11: the public fixed-response route (B10), and nothing else. WP-15 lands
   independently.
2. **Core fixes with tests:**
   - B4, cpuset-aware pinning in `zero-io`, both backends, and `SO_INCOMING_CPU`;
   - B18, the amendment of the Realistic entry definition (or the policy layer);
   - B3, the parameter and static routes in the entries;
   - B5, pinned entry dockerfiles.
3. **zero-bench:** `--json` on every command, and the idle probe extensions (B6).
4. **Generator images:** `bench/docker/wrk.dockerfile`, `oha.dockerfile` and a zero-bench
   image, all by digest.
5. **Competitor entries** under `bench/entries/<group>/<name>/` with `ENTRY.md` (B12, B17, B9),
   and the two Node apps (B11).
6. **The orchestrator**, `cargo xtask bench build|verify|run|report`, with its unit tests (B7,
   B8, B13, B14, B15, B21).
7. **Pilot session:** confirm every entry verifies; choose the cpuset split and the per-group
   fixed rate R; time one full run; write the session file.
8. **The five-run session** on a quiet machine (about 6.5 hours, overnight), then
   `cargo xtask bench report`. Commit `bench/results/<date>/` as its own commit.
9. **Charts:** `scripts/svgglyphs.py` extraction (architecture output unchanged) and
   `scripts/bench_charts.py`; generate `assets/bench/*`; screenshot review.
10. **Documentation, in one commit:**
    - `BENCHMARKS.md` with regions;
    - the README `## Performance` section;
    - `docs/about/benchmarking.md`;
    - `web/home.toml` `[backing]` rewrite;
    - `CHANGELOG.md`;
    - the ROADMAP R.3 rows 7 and 14 amendment in `.github/cloud/` (B19, B24).
11. **Adversarial review** before publishing: one reviewer per competitor checks that the
    entry matches its TechEmpower entry and its documentation; one checks the wording against
    RULES (no claim beyond the data, every number from a region). Then fix and regenerate.

Machine time per session: about 6.5 minutes per entry per run (primer, warm-ups, 4 plus 6
levels, the parameter, static, latency and memory tests, container starts), 12 entries
(including the `io-compio` raw-data row and the pinned Round 23 Drogon row), five runs. That
is about 6.5 hours, plus image builds and the pilot.

## Open decisions for the owner

1. **The R.2 thesis gate.** ROADMAP R.2 requires the Realistic entry at 1.10 times Drogon on
   json, with a win in every run, before release 1. The 2026-10-01 decision is about
   publication. Recommended: release 1 requires the publication only, and the ratio is
   reported whatever it is. If the owner keeps the gate, the session file carries it and the
   report fails the session when it does not hold.
2. **Which zero-server row anchors the Node ratios.** Recommended: the JavaScript-handler row,
   because it is what a Node user writes. The Rust-routes row is shown beside it.
3. **The core split.** Recommended: let the pilot choose between 4 and 9 and 6 and 7 by the
   saturation rule, and publish the split.
4. **The `io-compio` row.** Recommended: raw data only in release 1, published when its own
   section 5.7 records exist.

## Sources (fetched 2026-10-02)

- TechEmpower toolset at 523534bb: `toolset/wrk/{wrk.dockerfile, pipeline.lua, pipeline.sh, concurrency.sh}`, `toolset/utils/docker_helper.py`, `toolset/run-tests.py`, `toolset/test_types/{plaintext,json}/*.py`, through `gh api repos/TechEmpower/FrameworkBenchmarks/contents/...?ref=523534bb`
- TechEmpower archived master `57d92fbec6f8fd7431bc77326dd0484e60c96e20` (archived: true, pushed_at 2026-03-24): `frameworks/Rust/{hyper,axum,actix}`, `frameworks/C++/drogon`, `frameworks/JavaScript/{nodejs,express,fastify,uwebsockets.js}` (dockerfiles, manifests, `benchmark_config.json`, `app.js`, `create-server.js`, `src/server.js`, `src/clustered.js`, `src/main_web.rs`, `drogon_benchmark/config.json`)
- TechEmpower test rules: https://github.com/TechEmpower/FrameworkBenchmarks/wiki/Project-Information-Framework-Tests-Overview
- wrk: `gh api repos/wg/wrk` (tags 4.2.0, last commit 2021-02-07), `SCRIPTING` at 4.1.0 and 4.2.0, `compare/4.1.0...4.2.0`; Ubuntu package https://packages.ubuntu.com/noble/wrk (4.1.0-4build2)
- wrk2: `gh api repos/giltene/wrk2` (last commit 2019-09-24)
- oha: `gh api repos/hatoo/oha/releases/latest` (v1.16.0, 2026-08-23), README at v1.16.0; https://crates.io/api/v1/crates/oha
- h2load: `doc/h2load.1.rst` at nghttp2 v1.70.0 (released 2026-07-29)
- rewrk, vegeta, bombardier, autocannon, k6: `gh api repos/<repo>` and `/releases/latest`
- the-benchmarker/web-frameworks README (`gh api repos/the-benchmarker/web-frameworks/contents/README.md`): routes, `zrk`, generator sizing, saturation check; zrk via `gh search repos zrk`
- crates.io API (`https://crates.io/api/v1/crates/<name>`): hyper, hyper-util, axum, actix-web, actix-http, actix-files, tower-http, tokio, serde_json, socket2, mimalloc, simd-json
- npm registry (`https://registry.npmjs.org/<name>/latest`): express, fastify, @fastify/static, serve-static, fast-json-stringify, slow-json-stringify, autocannon
- GitHub releases: uNetworking/uWebSockets.js (v20.71.0), drogonframework/drogon (v1.9.13), rust-lang/rust (1.99.0, 2026-10-01)
- Node releases: https://nodejs.org/dist/index.json (22.23.3 Jod, 24.21.0 Krypton, 26.10.0 Current)
- Docker Hub tags API: `library/ubuntu:24.04`, `library/ubuntu:22.04`, `library/rust:1.99.0-slim-trixie`, `library/rust:1.99.0-trixie`, `library/node:24.21.0-slim` (digests as quoted)
- dataviz palette validator, `scripts/validate_palette.js` of the bundled dataviz skill, runs quoted in B23

Measured on this machine (2026-10-02): `docker ps`; `docker version`, `docker info`;
`lscpu`, `nproc`, `cpuset.cpus.effective`, `ulimit -Hn`, `somaxconn`, `ip_local_port_range`,
`io_uring_disabled` in a `--network host` container; the io_uring seccomp probe; the Node cpuset
probe; `Get-CimInstance Win32_Processor` and `Win32_PhysicalMemory`; `powercfg
/getactivescheme`; `wsl --version`; `.wslconfig`.

Unverified: whether the hyper TechEmpower entry starts cleanly with no database host (its
`/db` routes use a `deadpool-postgres` pool, which is expected to connect lazily). The
orchestrator's verify step settles it at the first build.
