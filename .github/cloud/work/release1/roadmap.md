# Release 1 audit: the roadmap, step by step

Written 2026-10-02 from the tree, git log, CI and the registries. Read-only: nothing in the
repository was edited. HEAD is `e13e631` ("Regenerate the Node lockfile from its manifests"),
pushed and green in CI. The working tree carries the DESIGN-12-13 work in progress (WP-0 rows and
WP-1 plumbing), new fuzz targets and crate-doc edits; see "In flux" at the end.

Scope: every exit criterion of R.2 (the first deliverable) and of R.3 steps 1 to 14 (release 1) in
`.github/cloud/ROADMAP.md`, plus R.1 item 13 and the release mechanics of step 14. Each criterion is
marked:

- **done**: met at HEAD, with the evidence named.
- **partial**: part met; the rest is missing and not covered by DESIGN-12-13.
- **planned**: delivered by `.github/cloud/work/step12/DESIGN-12-13.md` (the work package is named, and the
  design was read to confirm it covers the criterion).
- **missing**: not in the tree and not in DESIGN-12-13.

Every step also carries three standing conditions (R.3 preamble): `just ci` green, the step's
standards rows green, and the CHANGELOG entry written. They are assessed once, in the cross-cutting
section, rather than repeated per step.

## Summary

- Steps 1 to 11 are built and tested. What keeps them from closing is not code in the crates but
  evidence and release plumbing: the benchmark gate of R.2 and step 7 has never run, the 24
  CPU-hour fuzz runs are complete for 4 of 25 targets, the httparse oracle is blocked by the
  dependency rule, and two unrelated defects remain (no security headers on the driver's own
  responses; seven implemented RFC 9457 rows parked at release 2).
- Steps 12 and 13 are almost entirely planned by DESIGN-12-13. The design covers every R.3 row 12
  and row 13 exit criterion. Two of its texts are stale against owner decisions made after it was
  written: it still says `@zero-server/sdk` stays private and that no `2.0.0-alpha.1` is published
  (sections 8.11, 8.13 and section 13 item 14). WP-16 would copy that stale amendment into
  ROADMAP.md.
- Step 14 is where most of the missing work sits. Today `release-preflight` would fail on three of
  its five steps (the version, the standards register and the docs check). The release build
  matrices for npm, PyPI and NuGet have never run. The documentation site cannot build. The
  `SECURITY.md` unsafe inventory is empty while 79 unsafe sites exist. No benchmark page exists.
  The tag name in the roadmap (`v0.1.0`) contradicts the owner's version policy
  (`v2.0.0-alpha.1`).
- The crates.io side of the release is in good shape: `cargo xtask release --dry-run` packages and
  verifies all 27 crates at HEAD, every crate name is still free on crates.io, and ci is green on
  all 15 jobs.
- Counts over the 107 rows of the criteria tables below: 51 done, 13 partial, 22 planned, 21
  missing. The ordered gap list at the end has 22 entries that are not covered by DESIGN-12-13.

## Measurements taken for this audit

All Rust commands ran in the `zero-server-lint` image (rustc 1.99.0, cargo 1.99.0) with
`CARGO_TARGET_DIR=/work/target/r1-roadmap/...`, once on the working tree and once on a `git archive`
of HEAD extracted under `target/r1-roadmap/head`. Script: `target/r1-roadmap/checks.sh`; outputs:
`target/r1-roadmap/{tree,head}-*.txt`.

| Command | HEAD e13e631 | Working tree |
| --- | --- | --- |
| `cargo xtask standards --check` | exit 1: `runtime-01: reading bindings/node/test/lifecycle.test.js: No such file or directory` | exit 1: first failure `routing-29` |
| Row scan (every row at or below `current_release = 1`, `at` text on exactly one line of `evidence`) | 642 rows: 252 at release 1, 139 at release 2, 251 at release 3; 2 failing (`runtime-01`, `runtime-07`) | 669 rows: 279 at release 1; 29 failing, all 27 WP-0 rows plus `runtime-01` and `runtime-07`, every one assigned to a DESIGN-12-13 package |
| `cargo xtask docs --check` | exit 1: bundle feature `http` does not turn on zero-date, zero-uri, zero-qs, zero-json, zero-base64, zero-mime, zero-static, zero-policy; no `http3` feature; 10 release 1 capabilities without a guide (http1, router, codecs, static, policy, websocket, sse, tls, qpack, h3); 20 later-release entries pending | same |
| `cargo xtask version --check` and `version --check 0.1.0` | exit 0, every manifest at 0.1.0 | exit 0 |
| `cargo xtask release --plan` | exit 0, 27 crates in order (zero-core first, zero-server last) | exit 0 (28 once zero-host is publishable) |
| `cargo xtask lints --check` | exit 0 | exit 0 |
| `cargo xtask packages --check` | exit 0 | exit 0 |
| `cargo xtask release --dry-run` | exit 0: "all 27 crates package cleanly" (see "Dry run result") | not run (zero-host is a placeholder) |

The row scan is a short Python script outside the repository: `tomllib` over `docs/standards.toml`
(HEAD read with `git show HEAD:<path>`), and for every row with `release <= current_release` it
requires the `at` text on exactly one line of the `evidence` file, the rule `standards.rs` applies.
The xtask check stops at the first failing row, so the scan is the only full count.

Registry and CI facts fetched live on 2026-10-02:

- crates.io (`https://crates.io/api/v1/crates/<name>`): all 28 publishable names (the 27 of the
  plan plus `zero-host`) return 404, so every name is free. They stay unclaimed until the first
  publish. The API was checked against `serde` and `serde-json` (which resolves to `serde_json`),
  so the 404s are genuine.
- crates.io `httparse`: newest stable 1.10.1, created 2025-03-03, not yanked. That is past the
  12-month adoption window of RULES.md, so the step 3 oracle stays blocked.
- PyPI (`https://pypi.org/pypi/<name>/json`): `zero-server`, `zero-server-native`,
  `zero-server-core` all 404 (no project exists yet).
- NuGet (`https://api.nuget.org/v3-flatcontainer/<id>/index.json`): `zeroserver`,
  `zeroserver.core`, `zeroserver.native` all 404.
- npm (`https://registry.npmjs.org/<name>`): `@zero-server/sdk` and `@zero-server/core` have
  `latest` 1.1.0 and versions 0.9.0 to 1.1.0; `@zero-server/native` 404.
- `gh repo view molexxxx/zero-server`: `visibility PUBLIC`.
- `gh secret list`: CRATES_TOKEN, PIP_TOKEN, NPM_TOKEN (all set 2026-10-01), BADGES_DISPATCH_TOKEN.
- `git ls-remote --tags origin`: no tags. `gh release list`: none. `gh run list -w <file>` for
  release-crates, release-node, release-python, release-nuget, release-github and
  release-preflight: no runs ever.
- `gh run view 37048673426` (ci on e13e631): all 15 jobs green (rust, bare-metal, aarch64 kernels,
  runtime seam on three operating systems, minimum supported rust, license and advisory audit,
  dependency audits, Miri 9m15s, sanitizers address and thread, fuzz smoke 17m46s, reproducible
  build, hardened build). The `rust` job carries two "Process completed with exit code 1"
  annotations: the advisory `docs --check` and `standards --check` steps (`continue-on-error: true`,
  `ci.yml` lines 148-158). node, python, dotnet and codeql are green on the same SHA.
- docs.yml: failed on every run (last 2026-10-01, run 36837378714) at "Rust reference", exit 101.
  pages.yml: one run, failed (2026-10-01). pypi-backfill: fails on every scheduled run
  (37029500058 and five before it) at its first step, because no tag exists.
- `gh api repos/<action>`: `goto-bus-stop/setup-zig` not archived, last push 2024-09-28;
  `ilammy/setup-nasm` last push 2025-10-01; `PyO3/maturin-action`, `NuGet/login` and
  `dtolnay/rust-toolchain` pushed in the last week.

Local fuzz campaign (`target/fuzz-campaign/progress.txt`, container `zero-fuzz`, 6 workers by
14,400 s per target, which is 24 CPU-hours): the target list was fixed at its start
(2026-10-02T03:33Z, 9 targets). Done and clean (exit 0, 0 artifacts): `cmsg_decode`,
`http1_chunked`, `http1_head`, `json_parse`. Running: `qs_parse` (started 19:36Z). Queued:
`router_resolve`, `simd_kernels`, `uri_normalize`, `utf8_validate`. Not in the campaign: the 8
QPACK and HTTP/3 targets committed in f022411, and the 8 untracked targets now in `fuzz/`
(`base64_decode`, `cors_fields`, `forwarded_parse`, `mime_parse`, `sse_decode`, `tls_hello`,
`ws_frames`, `ws_session`).

### Dry run result

`cargo xtask release --dry-run` on the HEAD snapshot: exit 0, "xtask release: all 27 crates
package cleanly". Each of the 27 crates was packaged (6 to 29 files, 25.0 to 272.8 KiB) and verified
by a build from its packaged sources against its unpublished siblings, with no warning other than
"aborting upload due to dry run" (`target/r1-roadmap/head-release_dry-run.txt`). Three limits on
what this proves:

- It ran at 0.1.0 with caret requirements. The release version is 2.0.0-alpha.1, whose bump writes
  exact `=2.0.0-alpha.1` requirements between the crates (`docs/about/releasing.md`), so the dry
  run must be repeated after the bump.
- `zero-host` is not in it (a placeholder in the tree, absent at HEAD); the final run covers 28
  crates.
- The snapshot had no `.git`, so the packages carry no `.cargo_vcs_info.json`; the real publish
  from a checkout does.

## Cross-cutting conditions (every step)

| Condition | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| `just ci` green | partial | The recipe is `fmt-check lint lints-check nostd test docs-check standards-check version-check release-plan` (justfile). `docs-check` and `standards-check` exit 1 on HEAD (table above). ci.yml is green only because those two steps are `continue-on-error`. | The 10 guides and the bundle features (gaps 2, 3), and the DESIGN-12-13 rows (WP-8 to WP-14). |
| Standards rows of each step green | done for steps 1 to 11 | Row scan at HEAD: only `runtime-01` and `runtime-07` fail, both reassigned to `bindings/node/test/lifecycle.test.js` (WP-11). | WP-11; WP-8 to WP-14 for the 27 rows WP-0 added. |
| CHANGELOG entry per step | partial | `CHANGELOG.md` has one `## [0.1.0] - Unreleased` entry covering steps 1 to 11. It has no line for the `zero` binary (d02b4e6, `zero serve`). The heading carries the wrong version for the owner's policy and no date. | Gap 1 and gap 17. WP-16 adds the 2.0.0 behavior breaks. |

## R.2 First deliverable: the thesis proof

| Criterion | Status | Evidence | Why it matters | What closes it |
| --- | --- | --- | --- | --- |
| The 40 HTTP statements plus the section 6.2 rows and the `responseSplitting` vectors pass as named tests or vectors | done | Row scan: `h1` 19 rows and `routing` 32 rows at release 1, every one citing an existing test at HEAD; `conformance/vectors.json` `http1Parser` 30 cases and `responseSplitting` 10 cases | The thesis rests on a correct parser before it rests on a fast one | n/a |
| `xtask standards --check` green for release 1 rows in those two sections | done | Row scan at HEAD (only runtime rows fail) | Same | n/a |
| httparse differential oracle run 24 CPU-hours | missing | `httparse` 1.10.1 is the newest stable release, created 2025-03-03 (crates.io, fetched 2026-10-02). That is outside RULES.md's 12-month window, and the crate does not declare itself finished. STATUS step 3 records the block. | R.2 names the oracle as part of the conformance content; without it the parser has no second implementation to disagree with | An owner decision recorded in ROADMAP.md: either an exception for a dev-only oracle inside `fuzz/` (excluded from the workspace and from `deny.toml`'s shipped graph), or dropping the oracle with the vectors and the fuzz targets named as the replacement |
| `zero-http1` fuzz target 24 CPU-hours with no crash on the request and trailer parsers | done (local) | `progress.txt`: `done http1_chunked exit=0 artifacts=0 2026-10-02T11:34:06Z`, `done http1_head exit=0 artifacts=0 2026-10-02T15:35:07Z` | Untrusted-input parsers ship only after the fuzz bar | Record the run (targets, duration, corpus size, the cargo-fuzz 0.13.2 pin) in STATUS.md or a commit body. `target/` is gitignored, so the evidence exists only on this machine today. |
| Tier A json: Realistic entry at least 1.10 over the pinned Drogon entry, zero errors at 16 to 512 connections, five interleaved runs | missing | `bench/techempower/` holds only the two zero-server entries; there is no Drogon build, no interleaving harness and no `bench/results/`. STATUS step 7: "What needs hardware and the owner: the tier A json ratio against the pinned Drogon entry". | This is the deliverable's pass rule and the owner's "benchmarked with the release" bar | Amend R.2 to the owner's method (STATUS "Decisions already made": Docker on the 9950X3D, server and load generator on separate cpusets, fuzz container paused, RULES.md publication method), then build the Drogon entry from the archived toolset commit 523534bb and run it. benchmarks.md has the full harness gap. |
| nodejs and uwebsockets.js yardsticks recorded in the same session | missing | No entry for either under `bench/` | The Node group of the owner's benchmark page needs them | Same harness |
| Tier B plaintext ratio against the ceiling reference (libreactor, then faf) at 256, 1,024, 4,096 and 16,384 connections | missing | No ceiling entry | Pass rule | Same harness; the 16,384 level needs `ulimit -n` above the container's 20,000 hard limit for both sides (STATUS, environment notes) |
| Tier C plaintext (25 or 40 GbE rented bare metal), a precondition of the tag | missing | STATUS resume point: "The tier C benchmark needs rented hardware and is skipped." No owner waiver is recorded in ROADMAP.md. | R.2 makes it a precondition of the release 1 tag, so the tag cannot pass the plan as written | An owner waiver recorded in ROADMAP.md (R.2 pass rule and step 14), or the rented run |
| Gate: zero global-allocator calls per request through accept to writev on the Realistic entry | done | `crates/zero-http/tests/no_alloc.rs`, which routes every request; green in CI | One of the three pass conditions | n/a |
| Gate: bytes per idle connection at 10k, 100k and 1M on `io-tokio` with the lazy lease | partial | 10k measured: 6,914 bytes (STATUS step 7, `zero-bench idle`). 100k and 1M not measured. The figure exists only in STATUS and a commit body, not as data. | Memory per connection is a design claim | Run 100k and 1M in Docker with raised descriptor and memory limits; commit the raw output with the run configuration |
| Gate: the 16,384-connection plaintext level with zero errors | missing | Not run | Pass condition of tier B | Same harness |
| Gate: the cost of `overflow-checks = true`, one run with it off | missing | Not run; `[profile.release.package.zero-simd]` stays empty (Cargo.toml) | Decides section 18 question 12 | One paired run |
| Gate: the 16-connection json figure | partial | Loopback only: 181,118 at 16 connections against 178,460 at 256 (STATUS step 7) | Shows whether the 25K to 30K band appears | Re-run under the real harness |
| Pass rule met and the owner's go decision recorded before step 8 | missing | Steps 8 to 11 proceeded with no recorded go decision; no `.docs/bench/` directory exists | The stop rule exists so a thesis miss is caught early; it was skipped | Run the gate, then record the owner's decision in ROADMAP.md or STATUS.md |

## R.3 step 1: repository scaffold

| Criterion | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| `just ci` green on an empty workspace | done at scaffold, partial now | Scaffolded in 4a578d9; see the cross-cutting `just ci` row | Cross-cutting row |
| `xtask standards --check` reports 0 failing and 515 pending rows | done, superseded | The register grew: at HEAD, 642 rows, 252 enforced, 390 pending, 2 failing | n/a; the failing two are WP-11's |
| `cargo deny check` and `cargo vet` green | done | ci jobs "license + advisory audit" and "dependency audits" green on 37048673426. In flux: `deny.toml` and `supply-chain/config.toml` are being edited by WP-1 (zero-host member, loom exemption). | WP-1 exit reruns both |
| The lint image builds | done | `.docker/lint.Dockerfile` tracked since 4a578d9; image `zero-server-lint` present locally | n/a |
| `rerun-*-linux.txt` committed | done | `bench/probes/rerun-{node,python,dotnet}-linux.txt` (4a578d9), under `bench/probes`, not `.docs/` as the row says | n/a |
| The budgets table in DESIGN section 8.6 rewritten from the reruns | planned (WP-16, DESIGN-12-13 section 13 item 9) | DESIGN.md line 315 still reads "provisional until the Linux rerun of section 12.5" | WP-16 |
| R.1 item 13: crate names probed | done (today) | All 28 names 404 on crates.io (fetched 2026-10-02) | Names are free but unclaimed until the tag; a squatter between now and the tag would break the publish order |
| R.1 item 13: NuGet trusted publishing policies | done (owner) | STATUS "Next": policy for `release-nuget.yml`, owner tonywied17, globs `ZeroServer`, `ZeroServer.*`. Not verifiable from the repository. | n/a |
| R.1 item 13: PyPI projects created | partial | All three names 404. `release-python.yml` uploads with `PIP_TOKEN`, which creates the projects on first upload only if the token is scoped to the whole account. | Confirm the token scope before the tag (gap 21) |
| R.1 item 13: `release --plan` and `--dry-run` | done | `release --plan` exit 0, 27 crates; `release --dry-run` exit 0 at HEAD | Repeat after the version bump (gap 1) |

## R.3 step 2: foundation no_std crates

| Criterion | Status | Evidence |
| --- | --- | --- |
| `--no-default-features` host build and thumbv7em cross-compile green | done | ci steps "no_std build" and "bare-metal cross-compile" (16 crates, `ci.yml` lines 73-78 and 191-196), green |
| Every kernel property-tested against the SWAR reference | done | STATUS step 2; the AArch64 run that was waiting now passes in the `aarch64 kernels` job on `ubuntu-24.04-arm` (37048673426) |
| UTF-8 validator property-tested against `core::str::from_utf8` | done | Row `utf8-01` (`crates/zero-simd/src/utf8.rs`); fuzz target `utf8_validate` |
| Miri green on zero-simd | done | Miri job (`-p zero-simd ...`, `-Zmiri-many-seeds=0..4`) green, 9m15s |
| zero-date IMF-fixdate vectors from RFC 9110 section 5.6.7 | done | Row `routing-10` |

Open beside the exit: `utf8_validate` and `simd_kernels` are queued in the 24 CPU-hour campaign
(R.7 item 14 asks 24 CPU-hours per target before a codec ships). That is gap 11.

## R.3 step 3: zero-http1

| Criterion | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| The 13 framing statements and the section 6.2 additions pass as named tests or vectors | done | `h1-01` to `h1-19` at release 1, all present at HEAD | n/a |
| Fuzz 24 CPU-hours clean | done (local) | `http1_head`, `http1_chunked` (see R.2) | Record the evidence (gap 11) |
| The parser never allocates (counting allocator) | done | `crates/zero-http1/src/no_alloc.rs` | n/a |
| `Reject { status, close }` covers 400, 414, 501 and 505 | done | `crates/zero-http1/src/head.rs` tests at lines 1057-1072 (414, 501) and 1121-1122 (505); 431 in `error.rs` | n/a |
| Deliverable: the httparse oracle | missing | Blocked (R.2 row above) | Gap 10 |

## R.3 step 4: zero-sys and zero-io on io-tokio

| Criterion | Status | Evidence |
| --- | --- | --- |
| Seam traits of section 5.2 frozen and documented | done | `crates/zero-io/src/seam.rs`; no DESIGN-12-13 package edits zero-io (section 14 file lists), so the seam stays frozen through steps 12 and 13 |
| Echo test on Linux, macOS and Windows runners, one worker per core | done | `runtime seam` job on ubuntu-latest, macos-latest and windows-latest, green |
| zero-io stays `forbid` (lint diff green) | done | `crates/zero-io/Cargo.toml` `[lints] workspace = true`; `docs/capabilities.toml` `lint = "workspace"`; `lints --check` exit 0 |
| Idle connections hold no receive buffer | done | `crates/zero-io/tests/echo.rs` (the pool's lease counter) |
| Deliverable: cmsg fuzz target and Miri | done | `cmsg_decode` 24 CPU-hours clean (campaign); Miri runs `-p zero-sys` |

## R.3 step 5: zero-rt first half and zero-http

| Criterion | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| The 27 semantics statements pass through the router and driver | done | `routing-01` to `routing-28` all cite tests present at HEAD (`routing-29` to `32` are WP-0's new rows, owned by WP-5, WP-8 and WP-14) | n/a |
| Pipelined responses in request order (RFC 9112 section 9.3.2) | done | Row `h1-13`, `crates/zero-http/tests/driver.rs` | n/a |
| A panicking tier 4 handler yields 500 and the connection and core stay usable | done | `crates/zero-http/tests/driver.rs:1336` `a_panicking_handler_yields_500_and_the_connection_and_core_stay_usable`; `crates/zero-rt/src/worker.rs:316` and `:372` for the task and worker-loop cases | n/a |
| Zero global allocations per request on a tier 4 route | done | `crates/zero-http/tests/no_alloc.rs` | n/a |
| Registry accuracy for the error registry | partial | `errors-01` to `errors-07` cite tests that exist at `crates/zero-http/tests/driver.rs` lines 1208-1316 (RFC 9457 problem details, shipped in step 5), but the rows sit at `release = 2`. The release 1 standards page would therefore list shipped behavior as "Ships in release 2; the test is not written yet" (`standards.rs` line 431). | Move the seven rows to release 1 (gap 13) |
| Security headers on responses the driver writes itself (400, 408, 413, 421, 505, the 500 after a handler error) | missing | STATUS 2026-10-02: "zero-http writes no security headers on the responses it writes itself". `git grep -i "security.header\|SecurityHeaders" HEAD -- crates/zero-http/src` finds nothing. DESIGN-12-13 section 3.2 adds them only to misses routed through zero-host (`rules::after`), not to driver-generated answers. | A configured field set in zero-http written on every response, with a test per status (gap 12) |

## R.3 step 6: router and small codecs

| Criterion | Status | Evidence |
| --- | --- | --- |
| Router tests transferred from `zero-server/test/routing` pass | planned (WP-14) | `map-legacy-tests.md` line 219: `routing/router.test.js`, 45 cases, release 1, `run (+overrides)`; DESIGN-12-13 section 8.14 drops the two cases pinning 404 |
| Percent-decoding returns errors on every malformed input (fuzz) | done (smoke); 24 CPU-hours queued | `uri_normalize` target; queued in the campaign (gap 11) |
| The 400-route miss cost measured and beating the 10.9 microsecond Node figure | done | 230 ns per miss at 400 routes, 316 ns at 4,000 (STATUS step 7, `zero-bench miss`, the median of five batches of a million). The figure lives only in STATUS and a commit body. |
| Deliverable: `router` vector section | done | `conformance/vectors.json` `router`, 37 cases |

## R.3 step 7: zero-bench and the R.2 runs

| Criterion | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| R.2 pass rule met | missing | R.2 table above | Gap 9 |
| Numbers, ratios and gate values committed under `.docs/bench/` with the run configuration | missing | `Test-Path .docs/bench` is False. The owner's later decision puts published data in `bench/results/<date>/` with `BENCHMARKS.md`; neither exists. | Gap 9 |
| The owner's go decision recorded | missing | Not in STATUS, ROADMAP or DESIGN | Gap 9 |
| Deliverable: Realistic and Platform entries, load generator, idle probe, miss timing, TechEmpower entry files | done | `crates/zero-bench/src/{entries,load,idle,miss}.rs`; `bench/techempower/` | n/a |
| Deliverable: the tiered self-run harness (pinned Drogon, ceiling reference, nodejs and uwebsockets.js, five interleaved runs) | missing | Nothing under `bench/` beyond the two zero-server entries | Gap 9 (benchmarks.md) |
| Deliverable: hardware rental for tier A | missing, superseded by owner decision | STATUS "Decisions already made": runs in Docker on the owner's machine | Amend R.2 and step 7 in ROADMAP.md to match |

## R.3 step 8: io-compio

| Criterion | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| Full test matrix green on both backends | partial | ci "Test on the io-compio backend" and the `runtime seam` job's compio step on three operating systems are green. One case asserts nothing on Windows under io-compio: a datagram longer than its buffer comes back with no bytes (`crates/zero-io/tests/datagram.rs`, STATUS step 8). | Establish what the completion port carries for a truncated datagram on a Windows machine and assert it (gap 20) |
| The section 5.7 gates recorded on io-compio beside io-tokio | partial | Recorded in STATUS: 5 allocations per warm request on io-compio against 0 on io-tokio (asserted constant by `tests/no_alloc.rs`), 6,282 idle bytes, throughput at 256, 1,024 and 16 connections. The CPU-per-request figure "needs cgroup accounting" and is not recorded. | Part of gap 9: record the cgroup CPU figure in the harness run |
| `deny/io-compio.toml` accepted | done | ci step "cargo deny with the io-compio backend" green |
| No compio crate in the default graph (`cargo tree` diff in CI) | done | ci step "No compio crate in the default graph" green |

## R.3 step 9: static files, policy subset, WebSocket and SSE

| Criterion | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| The 16 static-file statements pass | done | `static-01` to `static-17` at release 1, all present |
| The 33 WebSocket and SSE statements pass (read counts) | done for the 27 kept at release 1 | `realtime-01` to `18` and `25` to `33` present; `realtime-19` to `23` (permessage-deflate) moved to release 3 and `realtime-24` (WebSocket over HTTP/2) to release 2 by the register |
| The symlink-swap and traversal vectors refuse | partial | Traversal: `crates/zero-static/src/lib.rs:656` `encoded_traversal_such_as_2e_2e_or_2f_never_resolves_outside_the_configured_root`. Symlink: `lib.rs:752` checks a link that exists before the request. No test swaps a path component for a link between the check and the open, which is the attack `files.rs:13` says the device and inode comparison defeats. | A test that replaces a directory with a symlink between the policy check and `open_nofollow` (a hook in the test build), asserting 404 (gap 14) |
| RFC 6455 section 1.3 accept vector `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=` through zero-server-crypto SHA-1 and zero-base64 | done | `crates/zero-ws/src/lib.rs:294`, `crates/zero-realtime/tests/realtime.rs:328` |
| The three audit vectors | done | `crates/zero-realtime/tests/realtime.rs` (STATUS step 9) |

## R.3 step 10: zero-tls and the crypto minimum

| Criterion | Status | Evidence |
| --- | --- | --- |
| ALPN, h2-over-TLS-later and 0-RTT statements pass | done | `h2-14`, `h2-15`, `tls-01` to `tls-24` present (`crates/zero-tls/src/lib.rs:383`, `:434`) |
| Both drivers pass the same interop test against curl and `openssl s_client` | done | `crates/zero-tls/tests/driver.rs`, 22 tests per backend (STATUS step 10) |
| A half-open handshake flood capped at 1,024 per core | done (rule), with a note | The cap is `accept.rs:283` `saturated()`; `tests/driver.rs:502` `a_core_keeps_at_most_its_limit_of_handshakes_in_progress_and_the_rest_wait` exercises it at a limit of 1; the 1,024 default is pinned by `crates/zero-limits/src/lib.rs:207`. No test opens 1,024 or more half-open handshakes. |
| Review follow-up: a response write has no deadline | done | e41a22b adds `send_idle` (60 s) to `Http1Limits` |

## R.3 step 11: zero-qpack and zero-h3

| Criterion | Status | Evidence | What closes it |
| --- | --- | --- | --- |
| RFC 9204 Appendix B examples pass as vectors | done | `crates/zero-examples/examples/conformance_vectors.rs` lines 640-659 (B.1 to B.5); `qpack` section in `vectors.json` |
| `SETTINGS_QPACK_MAX_TABLE_CAPACITY` 0 and `SETTINGS_QPACK_BLOCKED_STREAMS` 0 defaults pinned | done | `crates/zero-h3/src/settings.rs`; the `h3Frames.settings` vectors |
| Fuzz 24 CPU-hours clean | missing | The 8 targets (`qpack_field_section`, `qpack_huffman`, `qpack_instructions`, `qpack_primitives`, `h3_capsules`, `h3_frames`, `h3_settings`, `h3_streams`) landed in f022411 after the campaign fixed its list; CI runs them for 60 s each | Add them to the campaign (`FUZZ_TARGETS`), 32 hours of wall time at 6 workers (gap 11) |
| no_std and thumbv7em builds green | done | Both crates are in the ci no_std and bare-metal lists |

## R.3 step 12: slot ownership and the C ABI

Today: `crates/zero-ffi` exports only `zero_version` (`include/zero.h`); zero-rt has the state
word but no epoch reuse, dispatcher or loom model; `crates/zero-host` is a placeholder `lib.rs`
(WP-1, in flux).

| Criterion | Status | Evidence in the design |
| --- | --- | --- |
| loom finds no interleaving in which a stale id reads another request's data | planned (WP-2; WP-16 adds the `loom` CI job) | DESIGN-12-13 section 7.1 (ten models, including `loom_ack_before_post_returns`) |
| The TSan job passes with tier 0 traffic and tier 3 completions on one core | planned (WP-2, WP-8, WP-9; WP-16 the "three-test check") | Section 7.2. Today ci's step "Race a late accessor against slot recycle" (`ci.yml` lines 439-445) runs `cargo test -p zero-rt -- --include-ignored slot_recycle`, and `git grep slot_recycle HEAD -- crates` finds no test, so the step passes with zero tests. WP-16's check that the three tests ran closes that. |
| `include/zero.h` committed and CI diff-checked | planned (WP-9, WP-16) | The header and the dotnet.yml diff step exist; WP-9 regenerates it with `ZERO_FFI_HEADER_STRICT=1`, WP-16 moves the drift check into the `rust` job |
| Every accessor returns a status on null, stale and out-of-range input (amended to every export that takes an id; owned strings total on NULL) | planned (WP-9) | Section 6.16 table-driven test; amendment 15 |
| The borrow protocol's cost measured in the section 8.6 micro-harness | planned (WP-15), needs the owner's Docker run | Section 9.2 cells `slot_lock_pair`, `slot_cas_borrow_pair`, `slot_view_snapshot`; "a skipped cell is recorded as not measured and never counts as holding its budget" |
| Deliverable: epoch reuse, batch dispatcher with QueueFull and the 503 rule | planned (WP-2, WP-8; rows `runtime-21`, `runtime-22`) | Sections 4.5, 5 |
| Deliverable: zero-ffi lifecycle, routes, accessors, response builder with `body_alloc`, batch descriptor, completion, WebSocket, SSE and rooms, plugin vtable declaration, `catch_unwind` at every export | planned (WP-9; rows `ffi-01` to `ffi-08`) | Section 6 |

## R.3 step 13: the Node binding

Today: `bindings/node/src/lib.rs` exports `version()` only; the facade packages are skeletons; no
`test/legacy`, no conformance runner.

| Criterion | Status | Evidence in the design | Note |
| --- | --- | --- | --- |
| The 724 facade-only cases run through `bindings/node/test/legacy/`, every release 1 `run` case passes | planned (WP-14) | Section 8.14; amendment 14 replaces 724 by the manifest's computed count (685 proposed) | ROADMAP row 13 needs the amendment written (WP-16) |
| The detach-after-send vector asserts unchanged bytes | planned (WP-10, row `runtime-26`) | Section 8.7; `staging.test.mjs` | |
| A throwing tier 3 handler yields 500 and the isolate stays usable | planned (WP-11) | Section 8.9; WP-11 tests | |
| The section 8.6 cells hold their budgets | planned (WP-15), open until the owner's run | Section 9.2: the item stays open unless every gated cell is measured on the owner's machine | Owner accepted that reading (BRIEF) |
| `@zero-server/sdk@2.0.0-alpha.1` published under `next` | planned by owner decision, blocked by gap 1 | BRIEF.md: WP-11 removes `"private": true` and updates `packages.rs`, `releasing.md`, `SECURITY.md`. DESIGN-12-13 sections 8.11 and 8.13 and section 13 item 14 still say the sdk stays private and nothing is published. | Gap 18: correct the design text before WP-16 copies item 14 into ROADMAP.md |
| Deliverable: napi cdylib, isolate pool with the identical-table check, bounded ThreadsafeFunction dispatcher, body copy path, staging, completion flush, try/catch mapping | planned (WP-10, WP-11) | Sections 8.1 to 8.9 | |
| Deliverable: facade with `createApp`, `app.ws`, `res.sse`, `app.listen({ port, tls })` | planned (WP-11) | Section 8.11 (`listen({ port, host, tls, threads, isolates, entry })`) | |
| Deliverable: per-platform packages, `api-surface.json` diff by canonical id | planned (WP-6, WP-11, WP-14) | Sections 8.12 D1, 8.13 | |
| Deliverable: guides | planned for the three Node guides (WP-11); the ten capability guides are missing | Section 8.13: `quickstart.ts`, `ws.ts`, `sse.ts` | The `docs/guides/*.md` pages `docs --check` requires are not in any package (gap 2) |
| Deliverable: .NET smoke test and Python smoke import over the same cdylib | planned (WP-12, WP-13; row `runtime-29`) | Section 10 | |
| Deliverable: conformance runners for `http1Parser`, `router`, `responseSplitting`, `ws`, `sse` | planned (WP-5 adds the `ws` and `sse` sections; WP-14 Node; WP-12 and WP-13 .NET and Python) | Section 11 | |
| Deliverable: zero-bench binding rows (Node json handler against uwebsockets.js, boundary cells) | planned (WP-15) | Section 9.2 `node_json_handler`, `node_grid_*` | Needs the uwebsockets.js entry the benchmark harness also lacks (gap 9) |
| Node 20 in CI and in the release build | planned (WP-14) | Section 8.13: node.yml on 22, 24, 26; release-node builds on 24 | `node.yml` and `release-node.yml` both pin `node-version: 20` today |

## R.3 step 14: build matrix, documentation, release

| Criterion or deliverable | Status | Evidence | Why it matters | What closes it |
| --- | --- | --- | --- | --- |
| CI build matrix for the seven prebuilt targets | partial | Defined in `release-node.yml` (lines 66-85), `release-python.yml` (33-55) and `release-nuget.yml` (36-72). None has ever run. The musl rows of the napi build are marked unverified in R.1 item 10. | The first execution of all three matrices would be the irreversible tag | Gap 5 |
| npm, wheel and nupkg skeletons | done | `bindings/node/packages/{core,native,sdk}` with seven platform packages; `bindings/python/packages/{native,core,zero-server}`; `bindings/dotnet/src/{ZeroServer,ZeroServer.Core,ZeroServer.Native}` | | n/a |
| Documentation | missing | docs.yml fails at "Rust reference" because `docs/theme/rustdoc.html` does not exist. `bindings/node/docs` (typedoc), `docs/theme/pdoc` and `bindings/dotnet/docs/docfx.json` do not exist either, so the three later steps would fail next. There is no `docs/guides/` and no page beyond `docs/about/{releasing,standards}.md` and `docs/brand.md`. pages.yml is `workflow_dispatch` only, and its one run failed. | The site is the documentation the README and the packages point to; `site --verify` is the docs gate | Gap 4 |
| README | partial | Accurate for HEAD, but it states "Nothing is published to a registry yet", installs from git, and has no benchmark overview (`Test-Path BENCHMARKS.md` False) | The owner's bar includes a short benchmark overview in the README | Gap 16; WP-16 covers only the capability audit |
| CHANGELOG | partial | See the cross-cutting row | release-github publishes the entry as the release notes | Gaps 1 and 17 |
| `SECURITY.md` with the unsafe inventory, from cargo-geiger | missing | Every inventory table in `SECURITY.md` (lines 92-162) is empty, with the sentence "Every table is empty until its first block lands". HEAD has 37 unsafe sites in zero-simd, 37 in zero-sys, 3 in zero-ffi, 1 in bindings/node, 1 in the Python native crate (`git grep -c -E "unsafe \{\|unsafe fn\|unsafe impl\|unsafe extern\|no_mangle"`). `git grep -i geiger HEAD -- .github crates justfile docs` finds nothing. WP-16 plans the zero-ffi, bindings/node and .NET tables "checked against cargo-geiger", not zero-simd, zero-sys or the Python crate. | The public security page misstates the audited surface | Gap 8 |
| Release dry runs to crates.io and npm | partial | crates.io: green at HEAD, 27 crates at 0.1.0 (see "Dry run result"). npm: no `npm publish --dry-run` (or `npm pack`) of the package sets runs anywhere. | A packaging error found after the tag costs a version | Gap 15; repeat the crates dry run after gap 1 |
| Tier C ratios published beside the ceiling ratio | missing | R.2 table | | Gap 9 |
| Public repository | done | `gh repo view`: PUBLIC | | n/a |
| `release-preflight` green | missing | Fails today on three steps: `version --check 2.0.0-alpha.1` (the tree is at 0.1.0), `standards --check`, `docs --check` | Every release workflow waits on it | Gaps 1, 2, 3 and the DESIGN-12-13 rows |
| `cargo xtask release --dry-run` green for every crate | done at HEAD, to repeat | exit 0, 27 of 27 crates verified at 0.1.0 | Proves the publish order and packaging; not yet at 2.0.0-alpha.1 with exact pins or with zero-host | Rerun after gap 1 and after WP-8 makes zero-host real |
| Release 1 tag pushed; `release-crates`, `release-node`, `release-github` succeed | missing | No tags, no release runs. The roadmap names the tag `v0.1.0`; the owner's version policy (2026-10-01, confirmed 2026-10-02) makes it `v2.0.0-alpha.1`. | | Gap 1, then the tag, which the owner confirms |

## Release mechanics: what each release workflow blocks on

A `v*` tag starts five workflows at once; each calls `release-preflight.yml` first.

| Workflow | Blocks on | State today |
| --- | --- | --- |
| `release-preflight` | `version --check <tag>` (every manifest, lockfile, loader and a CHANGELOG entry at that version); `standards --check`; `docs --check`; the commit is an ancestor of `origin/main`; a successful ci, node, python and dotnet run on the exact SHA | Version: tree at 0.1.0, CHANGELOG `## [0.1.0] - Unreleased` (gap 1). Standards: 2 rows at HEAD, 29 in the tree, all owned by DESIGN-12-13 packages. Docs: gaps 2 and 3. The `version --check` accepted the `- Unreleased` heading for 0.1.0, so the tag date is not enforced (gap 17). |
| `release-crates` | `CRATES_TOKEN`; `cargo xtask release` (one `cargo publish -p` per crate, retrying on the rate limit), 300-minute job limit | Secret present. Never run. 28 crates once zero-host is publishable (the workflow comment says 27). Each attempt rebuilds and verifies the crate. |
| `release-node` | Gate: major >= 2, `next` for a pre-release; build matrix on Node 20 with zig 0.13.0 through `goto-bus-stop/setup-zig@v2` (last pushed 2024-09-28) and NASM 2.16.01; publish on Node 24 with npm >= 11.5.1, `npm install` (not `npm ci`), `napi artifacts`, `build:facade`, `check:packaging`, `napi pre-publish`, then each workspace package not marked private; OIDC trusted publishing, with `NPM_TOKEN` for the first publish of `@zero-server/native` and its seven platform packages | Never run. Node 20 is end-of-life (2026-04-30 per the schedule ROADMAP R.5 fetched); WP-14 moves the build to 24. With a 0.x version the gate skips the build entirely, and with 2.x a dispatch run publishes, so WP-14's exit "a `workflow_dispatch` run builds the seven targets and publishes nothing" cannot pass without a new non-publishing input (gap 5). The sdk is still `private` (WP-11 flips it). `NPM_TOKEN` expires about 2026-12-30 (owner note). |
| `release-python` | Seven maturin wheel builds (Python 3.13 host, abi3), sdist, the pure packages; `PIP_TOKEN`; `pypi-upload.sh` with the four-new-projects-per-day cap | Never run; no non-publishing mode (gap 5). Three new projects fit inside the cap. Token scope unverified (gap 21). WP-13 moves the floor to `abi3-py311`. |
| `release-nuget` | Seven `zero-ffi` cdylib builds (`dtolnay/rust-toolchain@stable`, `pip install cargo-zigbuild` unpinned for musl), pack with `setup-dotnet` 8.0.x, NuGet OIDC login as tonywied17, push with `--skip-duplicate` | Never run; no non-publishing mode (gap 5). WP-12 moves `Directory.Build.props` to `net10.0` but does not own this file, so `dotnet pack` on the .NET 8 SDK cannot target net10.0 (gap 6). The unpinned `cargo-zigbuild` install conflicts with RULES.md's currency rule (gap 22). |
| `release-github` | A CHANGELOG section headed `## [<version>]`; `gh release create --verify-tag`, marked as a pre-release when the version has a hyphen | Needs the 2.0.0-alpha.1 heading (gap 1). |

Two further facts bear on the tag day:

- The `ubuntu-latest` label moves to Ubuntu 26 from 2026-10-19 (annotation on every ci job,
  actions/runner-images issue 14748, read from `gh run view` on 2026-10-02). Every release job but
  the macOS and Windows rows runs on `ubuntu-latest`, so a tag after that date runs an image no CI
  job has run yet.
- `pypi-backfill` fails every hour until a tag exists (gap 19). That is noise on the Actions page,
  not a preflight input.

## Plan text that contradicts later owner decisions

These do not block a build but will mislead the next session or get copied into ROADMAP.md.

1. ROADMAP R.3 step 14 ("tag `v0.1.0`"), R.3 row 34 ("crates at 0.3.0") and R.7 item 12 ("crates
   stay 0.x") against the owner's single-version policy (2.0.0-alpha.1 everywhere, 2026-10-01;
   `docs/about/releasing.md` and the version tooling already follow it).
2. DESIGN-12-13 section 13 item 14 ("no `2.0.0-alpha.1` publish"), section 8.11 (`@zero-server/sdk`
   `private`; "nothing is published before 2.0.0") and section 8.13 ("leaves the private `sdk` out
   of the publish set") against the 2026-10-02 decision to publish the sdk under `next`. WP-16 is
   told to write item 14 into ROADMAP.md as is.
3. `docs/capabilities.toml` lines 201-202 ("The npm capability packages ship in release 3, when
   @zero-server/sdk is made public") and `docs/about/releasing.md` lines 104-106 ("`@zero-server/sdk`
   stays private") against the same decision. BRIEF.md assigns `releasing.md` to WP-11; the
   capabilities comment is in flux under another agent.
4. R.2 and R.3 step 7 (tier A on rented hardware or two instances on one switch, tier C on 25 or
   40 GbE as a tag precondition) against the owner's decision that runs happen in Docker on the
   9950X3D and the STATUS note that tier C is skipped. No waiver is written in ROADMAP.md.
5. R.3 step 1 ("`rerun-*-linux.txt` committed under `.docs/`") and step 7 ("committed under
   `.docs/bench/`"): `.docs/` is gitignored, so "committed" there is impossible; the reruns went to
   `bench/probes/` and the owner's benchmark decision names `bench/results/<date>/`.
6. ci.yml line 474 says "the long runs are a separate schedule", and R.7 item 14 names "the weekly
   job", but no scheduled fuzz workflow exists (`git grep schedule HEAD -- .github/workflows` finds
   only codeql and pypi-backfill).

## Gaps not covered by DESIGN-12-13, in release order

Each entry: what is missing, the evidence, why it matters for the release, and what closes it.

1. **The version and the tag.** The tree is at 0.1.0 (`version --check` exit 0 at 0.1.0); the
   owner's policy is one version, 2.0.0-alpha.1, on every registry, with the bump as its own commit
   after the step 11 crates (already landed). CHANGELOG's heading is `## [0.1.0] - Unreleased`. The
   preflight's `version --check v2.0.0-alpha.1` fails until both change, and release-github finds
   no notes. Closes with `cargo xtask version 2.0.0-alpha.1` (exact `=` pins between crates, PEP 440
   `2.0.0a1` in pyproject files), the CHANGELOG heading `## [2.0.0-alpha.1] - <tag date>`, and the
   ROADMAP amendments of plan-text item 1.
2. **The ten capability guides.** `docs --check`: "capability http1 ships in release 1 and has no
   guide", and the same for router, codecs, static, policy, websocket, sse, tls, qpack and h3.
   These are `docs/guides/<key>.md` (catalog.rs line 568). DESIGN-12-13 writes only the three Node
   guide programs. The preflight blocks on `docs --check`. Closes with the ten pages, each leading
   with TypeScript and showing Rust beside it, with spliced, compiled examples.
3. **The bundle crate's features.** `docs --check`: feature `http` of `crates/zero-server` does not
   turn on zero-date, zero-uri, zero-qs, zero-json, zero-base64, zero-mime, zero-static or
   zero-policy, and there is no `http3` feature. STATUS notes the `http` name collides with
   zero-http's own feature. This blocks the preflight, and the published bundle's feature names
   become permanent at the first publish. Closes with the feature table in
   `crates/zero-server/Cargo.toml` matching `docs/capabilities.toml`, and `cargo xtask builds` run
   for every feature set.
4. **The documentation site.** docs.yml exits 101 at "Rust reference" (missing
   `docs/theme/rustdoc.html`); `bindings/node/docs`, `docs/theme/pdoc` and
   `bindings/dotnet/docs/docfx.json` are also missing; there are no documentation pages; pages.yml
   is dispatch-only and has never succeeded; the site generator still carries template leftovers
   (`dashboard` role in `catalog.rs` lines 86-94 and 864, the `radio` and `lora` lookups at 534-540;
   in flux in the tree). Release 1's documentation deliverable has nothing to publish. Closes with
   the theme files and reference configs, the pages, `cargo xtask site --verify` green, and the
   pages.yml push trigger restored at the tag.
5. **No non-publishing run of the release matrices.** release-node, release-python and
   release-nuget have never run; none has a dry-run input; release-node's gate skips the build for
   0.x and publishes for 2.x, so WP-14's planned dispatch check cannot pass as written. The musl
   napi builds and the aws-lc-sys cross builds are unverified. A failure after the tag can leave
   crates.io published and npm, PyPI or NuGet not, at a version that cannot be reused. Closes with
   a `publish: false` input (or a build-only workflow on pull requests labeled `release`) on all
   three, run green for the seven targets on the release candidate SHA.
6. **Toolchain floors in workflows no package owns.** `release-nuget.yml` and `docs.yml` install
   the .NET 8.0.x SDK while WP-12 moves the projects to `net10.0` (an SDK cannot target a newer
   framework than itself); `docs.yml` also pins Node 20, end-of-life since 2026-04-30. Closes with
   setup-dotnet on the 10.0 line and setup-node on 24 in both files, each version fetched and cited.
7. **The R.2 gate is unwritten as policy.** R.2 still requires rented hardware and a tier C run
   before the tag. Closes with an owner amendment in ROADMAP.md that adopts the Docker method and
   waives or schedules tier C (plan-text item 4). This is the decision gap 9 depends on.
8. **SECURITY.md's unsafe inventory.** Every table is empty while zero-simd (37 sites) and zero-sys
   (37 sites) carry unsafe code at HEAD, and cargo-geiger never runs. WP-16 fills only the zero-ffi,
   bindings/node and .NET tables. Closes with every audited crate's table filled from the code (item,
   file, obligation, justification), a cargo-geiger run whose output is checked against them, and
   the "Every table is empty" sentence removed.
9. **Benchmarks with the release.** Nothing of the owner's benchmark page exists: no entries for
   hyper, axum, actix-web, Drogon, node:http, Express, Fastify or uWebSockets.js; no interleaving
   harness; no `bench/results/<date>/`; no `BENCHMARKS.md`; no README overview. Also open: the R.2
   gates at 100k and 1M idle connections, the 16,384-connection level, the overflow-checks run, the
   io-compio CPU-per-request figure, and the owner's go decision. The release bar names benchmarks
   explicitly, and RULES.md forbids any public performance claim without such a run. benchmarks.md
   holds the harness detail; the roadmap needs gap 7 first.
10. **The httparse oracle.** Blocked by the 12-month rule (1.10.1, 2025-03-03). It is an R.2 and step
    3 deliverable. Closes with an owner decision recorded in ROADMAP.md (plan-text item 4 style).
11. **Fuzz hours and their record.** Four of 25 targets have their 24 CPU-hours (R.7 item 14);
    qs_parse is running, 4 more are queued (about 16 hours), and 16 are outside the campaign (the 8
    QPACK and HTTP/3 targets that step 11's exit names, and the 8 new targets), about 64 hours more
    at 6 workers. The benchmark runs need the fuzz container paused, so the two compete for the same
    machine. Results live only in gitignored `target/`. There is no scheduled fuzz workflow. Closes
    with all targets in the campaign, a recorded summary per target (duration, executions, corpus,
    artifacts) in STATUS.md or a commit body, and either a weekly CI job or an amendment to R.7 item
    14 and the ci.yml comment.
12. **Security headers on the driver's own responses.** zero-http writes 400, 408, 413, 421, 505 and
    the post-error 500 without the policy headers (STATUS follow-up; no match in
    `crates/zero-http/src`). DESIGN-12-13 adds headers only on misses routed through zero-host. These
    are the responses an attacker can trigger at will. Closes with a configured field set in
    zero-http written on every response it generates, and a test per status.
13. **Seven implemented rows parked at release 2.** `errors-01` to `errors-07` (RFC 9457) cite tests
    present at `crates/zero-http/tests/driver.rs:1208-1316`, but `release = 2`, so the release 1
    standards page will call shipped behavior unwritten. Closes with the rows at release 1 (the
    preflight then enforces them).
14. **The symlink-swap vector.** Step 9 names it; only a static symlink test exists
    (`crates/zero-static/src/lib.rs:752`). Closes with a race test that swaps a component between the
    check and the open.
15. **The npm dry run.** Step 14 names "release dry runs to crates.io and npm"; nothing packs or
    dry-runs the npm packages. `check:packaging` covers entry points only. Closes with `npm publish
    --dry-run --workspaces` (or `npm pack`) of every package that will publish, after `napi
    artifacts`, inside the non-publishing release run of gap 5.
16. **README at release.** It says nothing is published and installs from git; it has no benchmark
    overview; Packages does not mention `@zero-server/sdk@next`. Closes with the release-time edit:
    registry install lines at 2.0.0-alpha.1 (`cargo xtask version` already rewrites the version
    sites), the npm `next` line, and the overview linking `BENCHMARKS.md`.
17. **CHANGELOG completeness.** No entry for the `zero` binary (d02b4e6) and no tag date; the
    preflight does not enforce a date (`version --check 0.1.0` passed with `- Unreleased`). Closes
    with the missing lines and the date at the bump.
18. **Stale design text that WP-16 will copy.** DESIGN-12-13 section 13 item 14, sections 8.11 and
    8.13 (plan-text item 2). Closes with the design corrected to the 2026-10-02 decision before WP-16
    runs.
19. **pypi-backfill fails hourly with no tag.** Runs 37029500058 and five before it fail at
    `git checkout "v$version"`. Closes with an early successful exit when no `v*` tag exists.
20. **The Windows io-compio truncated datagram.** `crates/zero-io/tests/datagram.rs` asserts
    nothing for that case on Windows (STATUS step 8). Closes with a run on a Windows machine and an
    assertion of what the completion carries.
21. **PyPI first upload.** No project exists; whether `PIP_TOKEN` is account-scoped (needed to
    create projects) is not verifiable from the repository. Closes with the owner confirming the
    scope, or creating pending trusted publishers for the three names.
22. **Currency of release tooling.** `release-nuget.yml` runs `pip install cargo-zigbuild` without a
    version, and both release-node and release-nuget pin zig 0.13.0 through `goto-bus-stop/setup-zig@v2`,
    whose repository was last pushed 2024-09-28. RULES.md treats an unpinned install as a defect.
    Closes with cargo-zigbuild pinned to the version PyPI returns on the day, the zig version
    checked against what cargo-zigbuild and napi document, and the setup action reviewed.

## In flux at the time of this audit

Read as they were on 2026-10-02 between 19:30 and 20:15 UTC; other agents were editing them.

- DESIGN-12-13 WP-0 is in the tree: `docs/standards.toml` gained 27 rows (`ffi-01` to `08`,
  `runtime-21` to `29`, `routing-29` to `32`, `realtime-34` to `39`), all failing until their
  packages land, which is expected.
- WP-1 is in progress: `Cargo.toml` (member `crates/zero-host`, `check-cfg` for `zero_loom`),
  `Cargo.lock`, `deny.toml`, `docs/lints/workspace.toml`, `crates/xtask/src/lints.rs`,
  `docs/capabilities.toml`, `supply-chain/config.toml`, `crates/zero-rt/Cargo.toml` (loom),
  `crates/zero-ffi/Cargo.toml`, `crates/zero-bench/Cargo.toml`, and `crates/zero-host/` (manifest,
  README, LICENSE, a placeholder `lib.rs`). Workflow run `wf_15113098-92a`.
- Fuzz targets: 8 untracked targets with seeds and dictionaries under `fuzz/`, and `fuzz/Cargo.toml`
  and `fuzz/Cargo.lock` modified.
- Crate docs: most citations of the gitignored DESIGN.md are gone from the tree (28 files cited it
  at HEAD). Two remain, in `crates/zero-io/Cargo.toml` line 26 and `crates/zero-rt/Cargo.toml` line
  23. Manifest comments ship inside the published `.crate` (`Cargo.toml.orig`).
- `crates/xtask/src/catalog.rs` and `regions.rs` are being edited (the template leftovers of gap 4).
- `docs/about/standards.md`, several crate READMEs and sources under zero-http, zero-io, zero-rt,
  zero-router, zero-sys and zero-bench carry small edits from the crate-doc pass.
