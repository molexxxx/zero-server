# Release 1: the master list of remaining work

Written 2026-10-02, 20:00 to 20:40 UTC. Read-only: nothing in the repository was edited.

Inputs:
- The five audits in this folder, cited as RM (`roadmap.md`), RG (`registry.md`), CV (`coverage.md`), DR (`docs-and-release.md`) and BM (`benchmarks.md`).
- `.github/cloud/work/step12/DESIGN-12-13.md` section 14 (the work packages) and sections 8.11, 8.13, 13 and 15.
- `.github/cloud/work/BRIEF.md` (the owner decisions that apply to the binding work).
- `.github/cloud/{RULES,STATUS,ROADMAP}.md`.
- Checks made for this list, named in "New in this pass".

Tree: HEAD `e13e631`, plus 46 modified and many untracked paths from three agents still at work (see "In flux").

## Summary

- The list holds 113 items in 11 workstreams.
  - 25 are the DESIGN-12-13 packages: 17 packages (WP-0 to WP-16) and 8 scope amendments the design needs.
  - 88 are work that no package covers. With the 8 amendments, 96 items are not covered by the design as written.
- Of all 113, 49 are blockers, 15 of them DESIGN-12-13 packages. A blocker is something that makes the tag fail, publishes something wrong and permanent, ships a defect, or leaves out an item the owner named (the benchmark page and the README overview).
- The critical path runs through the DESIGN-12-13 chain WP-0, WP-1, WP-2 or WP-3, WP-8, WP-10, WP-11, WP-14 and WP-16. After that come the CI gates, the version bump, a non-publishing release-candidate run and the tag. Two machine-time loads must fit inside that chain on the one desktop:
  - the fuzz campaign: about 700 CPU-hours still to run;
  - the benchmark session: about 8 quiet hours.
- Seven owner items. Three are plan decisions: the R.2 benchmark gate, the httparse oracle and two RULES wordings. Three are account or repository actions. The last is confirming the tag.
- This pass found work none of the five audits listed:
  - three fuzz failures in committed code;
  - four crash files at the repository root;
  - missing third-party license notices in every prebuilt native artifact;
  - a work package that names a file that does not exist;
  - the runner image change of 2026-10-19.

## Legend

- **blocker**: the preflight or a release workflow fails; a registry receives something wrong and permanent; a public statement is false; a defect ships; or an item the owner named is absent.
- **required**: a ROADMAP exit criterion or a RULES requirement that does not stop the tag mechanically. The owner's bar ("nothing missing") includes these.
- **should**: hygiene with a small but real risk.
- **Covered** can take three values:
  - `WP-n`: DESIGN-12-13 delivers the item. The design text was read to confirm it.
  - `WP-n, amended`: the design must take the stated addition inside files it already owns.
  - `not covered`.
- **Needs**: the items that must merge first.
- **In flux**: another agent is changing the files now. Re-read them before starting.

## File ownership

Workstreams run in parallel only on disjoint files. Where two need the same file, this table fixes the order. "After X" means X has merged.

| Path | Owner, in order |
| --- | --- |
| `docs/standards.toml` | WP-0 (in flux, uncommitted), then R |
| `Cargo.toml` (workspace), `Cargo.lock`, `deny.toml`, `supply-chain/config.toml`, `docs/lints/workspace.toml` | WP-1 (in flux), then E11 for crate metadata. Lockfile changes only in their own commits (RULES). |
| `docs/capabilities.toml` | WP-1 (in flux), then D |
| `crates/xtask/src/lints.rs` | WP-1 |
| `crates/xtask/src/{ffi_names,ffi_mirror,surface,packages}.rs` | WP-6, then WP-11 for the sdk rule in `packages.rs` (BRIEF) |
| `crates/xtask/src/main.rs` | WP-6, then G2 and B5 add one registration line each, in sequence |
| `crates/xtask/src/standards.rs` | R |
| `crates/xtask/src/{docs,builds}.rs`, `site/**` | D |
| `crates/xtask/src/{catalog,regions}.rs` | in flux (template leftovers), then D |
| `crates/xtask/src/{release,version,licenses}.rs` and a new notices module | E |
| `crates/xtask/src/bench.rs` (new) | B |
| `crates/xtask/src/coverage.rs` (new) | G |
| `crates/zero-rt/**`, `crates/zero-limits/src/{lib,services}.rs` | WP-2 |
| `crates/zero-http/src/**` | WP-3, then C1 |
| `crates/zero-http/tests/routing.rs` | WP-5 |
| `crates/zero-http/tests/driver.rs` | T13 (no package edits it; WP-3 keeps it unchanged) |
| New files under `crates/zero-http/tests/` | T |
| `crates/zero-realtime/**`, `crates/zero-sse/src/lib.rs`, `crates/zero-ws/src/**` | WP-4, then T7 and T10 |
| `crates/zero-http-types/src/method.rs`, `crates/zero-router/src/lib.rs`, `conformance/vectors.json`, `crates/zero-examples/examples/conformance_vectors.rs` | WP-5 |
| `crates/zero-policy/src/cors.rs`, `crates/zero-static/src/files.rs` | WP-7 if taken, then F1 (cors) and T4 (files) |
| `crates/zero-policy/src/forwarded.rs`, `crates/zero-tls/src/hello.rs` | F1 (in flux) |
| `crates/zero-io/src/**` | in flux (crate-doc pass), then C2. T3 and C3 work in `tests/` only. |
| `crates/zero-host/**` | WP-1 (placeholder), then WP-8 |
| `crates/zero-ffi/**`, `include/zero.h` | WP-9 |
| `crates/zero-serve/src/lib.rs` | WP-2 (one match arm only) |
| `crates/zero-serve/tests/serve.rs` | C1 |
| New files under `crates/zero-serve/tests/` | T8 |
| `crates/zero-bench/Cargo.toml` | WP-1 |
| `crates/zero-bench/src/{boundary.rs, bin/zero-bench.rs, lib.rs}` | WP-15, then B |
| `crates/zero-bench/src/{entries,load,idle,args}.rs`, `tests/entries.rs` | in flux (crate-doc pass on `idle.rs`, `miss.rs`), then B |
| `bindings/node/{Cargo.toml,Cargo.lock,build.rs,src/**}`, `packages/native/index.*`, `test/native/**`, `deny/node.toml` | WP-10 |
| `bindings/node/packages/{core,sdk}/src/**`, `packages/native/package.json`, `packages/native/npm/*/package.json`, `guides/**`, `test/facade/**`, `test/lifecycle.test.js` | WP-11, then D2 for the TypeScript guide programs |
| `bindings/node/{package.json,package-lock.json,vitest.config.mjs,legacy-manifest.json,scripts/**}`, `test/{conformance,legacy,_shim,setup}/**`, `.github/workflows/{node,release-node}.yml` | WP-14 |
| `bindings/dotnet/**`, `.github/workflows/dotnet.yml` | WP-12 |
| `bindings/python/**`, `deny/python.toml`, `.github/workflows/python.yml` | WP-13 |
| `bench/probes/*/boundary/**`, `justfile` | WP-15, then B8 for the `bench` recipe |
| `.github/workflows/ci.yml`, `.github/CODEOWNERS` | WP-16, then G |
| `SECURITY.md` | WP-11 (sdk wording, BRIEF), then WP-16 |
| `CHANGELOG.md` | WP-16, then X1 |
| `README.md`, `web/home.toml` | WP-16, then B8, then X4 |
| `.github/cloud/{ROADMAP,DESIGN,STATUS,RULES}.md`, `.github/cloud/work/step12/DESIGN-12-13.md` | P before WP-16 starts, then WP-16 (section 13 amendments) |
| `fuzz/**`, `.github/workflows/fuzz.yml` (new), `.gitignore` | in flux (fuzz-target agent), then F |
| `docs/guides/**`, `docs/*.md` pages, `docs/theme/**`, `web/**` except `home.toml`, `crates/zero-examples/examples/guides/**`, `crates/zero-server/{Cargo.toml,src/lib.rs}`, `.github/workflows/{docs,pages}.yml`, `bindings/node/docs/`, `scripts/architecture.py`, `assets/{runtime,bindings}*.svg` | D. `architecture.py` passes to B7 after D9. |
| `.github/workflows/{release-python,release-nuget,release-crates,release-github,release-preflight,pypi-backfill}.yml`, `docs/about/releasing.md` (after WP-11) | E |
| `bench/**` except probes, `scripts/{svgglyphs,bench_charts}.py`, `assets/bench/**`, `BENCHMARKS.md`, `docs/about/benchmarking.md` | B |
| Crate rustdoc (`src/lib.rs` crate docs) | D, per crate after that crate's package and after T for that crate |
| `@see` lines in crate sources | R10, last |

## New in this pass

These came from checks made for this list, not from the five audits.

- **N1. Three fuzz failures in committed code (F1).** Another agent's 60-second smoke of the eight new targets failed on three of them, at 19:53 to 19:56 UTC (`target/fzfix/run-*.log`). All three sit in `zero-policy` and `zero-tls`, which the working tree does not modify, so these are defects at HEAD or oracle errors:
  - **`forwarded_parse`.** The assertion at `fuzz/fuzz_targets/forwarded_parse.rs:176` fails: `for=192.0.2.43;ext="for=192.0.2.43;host=\"a;b\""` parses to `[]`. A quoted-string value holding `;` or an escaped quote drops the element (RFC 7239 Section 4).
  - **`tls_hello`.** The panic at `tls_hello.rs:322` fires on the records `14 03 01 00 01 01` (change_cipher_spec) and `17 03 03 00 01 00` (application_data) sent before any ClientHello. The reader refuses them with no alert record, where RFC 9846 Section 5 requires `unexpected_message`.
  - **`cors_fields`.** The panic at `cors_fields.rs:211`: with `AllowOrigin::Any` and credentials, the rule accepts and reflects `Origin: https://a?b`, which is not a Fetch Section 3.2 serialized origin. That agent is still checking whether the oracle's grammar is right (`target/fzfix/origin-check`).
- **N2. Crash files at the repository root (F2).** Four `crash-*` files at the root hold the inputs above:
  - `crash-6fea2f4a...`: `fhttps://a?b`;
  - `crash-85492b8c...` and `crash-c3013dad...`: the TLS records;
  - `crash-ba330ab1...`: `for=192.0.2.43;host="a;b"`.

  They are untracked and not ignored (`git check-ignore` exit 1), so a broad `git add` commits them.
- **N3. No third-party notices in prebuilt native artifacts (E3).** `deny.toml` admits MIT, BSD-2-Clause, BSD-3-Clause, ISC and Zlib crates. The napi addon, the abi3 wheels and the `ZeroServer.Native` library statically link `aws-lc-sys`, `rustls`, `tokio`, `napi` and others. `crates/xtask/src/licenses.rs` copies only the project's own Apache-2.0 text into packages. BSD-3-Clause: "Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution." MIT: the notice "shall be included in all copies or substantial portions of the Software." Both read at https://spdx.org/licenses/BSD-3-Clause.html and https://spdx.org/licenses/MIT.html on 2026-10-02. A published version cannot be changed, so a release without notices stays out of compliance for that version.
- **N4. WP-15 names a file that does not exist (AM-7).** Its file list names `crates/zero-bench/src/main.rs`. The binary is `src/bin/zero-bench.rs`, and the modules are registered in `src/lib.rs`. The benchmark work (B1, B5) needs both files, so WP-15 and B must run in sequence.
- **N5. A dispatch run of a release workflow cannot run before the bump.** Every release workflow calls `release-preflight.yml`, whose first step is `version --check "${VERSION#v}"` (line 49). A pre-tag build run at `2.0.0-alpha.1` therefore needs the bump commit first, or a build-only path that skips the preflight. This sets the shape of E1 and AM-6.
- **N6. The runner image moves (E4).** `ubuntu-latest` becomes Ubuntu 26 from 2026-10-19 (actions/runner-images issue 14748, annotation on every ci job of run 37048673426, read by RM). The release candidate and the tag may run on different images.

Also verified:
- `zero-serve` is `publish = false`, and `.github/cloud/work/readme-at-release.md` keeps its `cargo install --git` line, so the `zero` binary is not a gap.
- The working-tree change to `crates/zero-sys/src/affinity.rs` touches documentation only, so C2 is still open.
- CI's fuzz smoke iterates `cargo fuzz list` (`ci.yml`), so new targets join it when they are committed.

## W0. DESIGN-12-13 packages

Order (section 14):
- line 0: WP-0;
- line 1: WP-1;
- line 2: WP-2 to WP-7;
- line 3: WP-8;
- line 4: WP-9 and WP-10;
- line 5: WP-11 to WP-13;
- line 6: WP-14 and WP-15;
- line 7: WP-16.

Each package closes standards rows that `release-preflight` enforces, so every package is a blocker except optional WP-7.

**WP-0. Registry rows.** blocker. In flux: uncommitted, `docs/standards.toml` +360 lines.
- Closes the 27 rows of section 12 and the amended `at` text of `runtime-01` and `runtime-07` (RG R-01).
- Accept: committed. The RG scan lists exactly 29 rows without a test. The xtask check reports only the first failure (`routing-29`), so the package's own exit text needs R2 or a rewrite.

**WP-1. Workspace plumbing.** blocker. In flux: review and fix of run `wf_15113098-92a`, last build 19:59 UTC (`target/wp1-fix-verify.sh`).
- Delivers the `zero-host` member, `check-cfg`, loom, and the deny and vet entries.
- Accept: the section 14 exit, with `cargo deny check` and `cargo vet` green.

**WP-2. zero-rt slot protocol, allocator and dispatcher.** blocker.
- Closes: the R.3 row 12 loom and TSan criteria (rows `runtime-21` and `runtime-22` through WP-8); CV's zero-rt list (the CAS retry arms, arena refusals); the `slot_recycle` sanitizer step that today matches no test (with WP-16).

**WP-3. zero-http exchange, hooks and error shape.** blocker.
- Closes the problem-details shape through `Handler::error_shape`, which R1 depends on.

**WP-4. zero-realtime outboxes.** blocker.
- Closes the shutdown Close 1001 behavior (row `runtime-05`, RG R-06) and `WebSocket::leave` (CV gap 14 in part).

**WP-5. PATCH and the `ws` and `sse` vector sections.** blocker.
- Closes `routing-29`. It also changes `routing-01`'s PATCH case to PROPFIND.

**WP-6. Contract tooling and `engines >=22`.** blocker.
- Closes the Node `engines` floor (DR G13) and the `api-surface` tooling. Amended by AM-1.

**WP-7. Tier 0 options.** required only if taken. Optional in the design.
- If it is not taken, the affected legacy cases move to `dropped`, and F1 and T4 may edit `cors.rs` and `files.rs` at once.

**WP-8. zero-host.** blocker.
- Closes `runtime-21`, `runtime-22`, `routing-30`, `routing-31`, `realtime-34` to `realtime-39`, `no_alloc_tier3`, and the TSan test of section 7.2. Amended by AM-2.

**WP-9. zero-ffi.** blocker.
- Closes `ffi-01` to `ffi-08`, the header with its CI drift check (with WP-16) and the table-driven null, stale and out-of-range test (R.3 row 12). Amended by AM-3.

**WP-10. Node native crate.** blocker.
- Closes `runtime-23` to `runtime-26` and `runtime-28`, and the detach-after-send vector.

**WP-11. Node facade.** blocker.
- Closes `runtime-01`, `runtime-07`, `runtime-27`, the throwing-handler 500, and `createApp`, `app.ws`, `res.sse`, `listen({ tls })`.
- Per the BRIEF it also publishes the sdk: it removes `"private": true` through `packages.rs` after WP-6, and updates `releasing.md` lines 104-106, `SECURITY.md`, the bundle README and the `docs.rs` npm button (DR G16).
- Amended by AM-4.

**WP-12. .NET smoke on net10.0.** blocker.
- Closes the R.3 row 13 .NET smoke. Amended by AM-5.

**WP-13. Python smoke.** blocker.
- Closes `runtime-29` and `abi3-py311`. The `requires-python` line it cannot write is AM-1.

**WP-14. Node conformance, legacy runner and Node workflows.** blocker.
- Closes `routing-32`, the release 1 legacy `run` cases (R.3 row 13; the count is recomputed from the 724 of the roadmap), node.yml on 22, 24 and 26, and release-node on Node 24. Amended by AM-6.

**WP-15. Boundary harness.** required.
- Closes R.3 row 13 "the section 8.6 cells hold their budgets", which stays open until the owner's Docker run (accepted reading, section 15 question 5). Amended by AM-7.

**WP-16. Integration.** blocker.
- Delivers: the loom job; sanitizers over zero-rt, zero-host and zero-ffi with the three-test check; the header drift check; CODEOWNERS; the CHANGELOG 2.0.0 behavior breaks; the section 13 amendments; the capability audit of `README.md` and `web/home.toml`; the DESIGN 8.6 budgets table rewritten from the Linux reruns (R.3 row 1).
- Accept: `just ci`, `standards --check` green, and every binding workflow green on the integration commit.
- Amended by AM-8.

### Amendments to the design (not covered as written)

**AM-1. WP-6 also changes the Python metadata generator.** blocker.
- Missing: `requires-python = ">=3.10"` is hard-coded at `crates/xtask/src/packages.rs:959`. Python 3.10 reached end of life on 2026-10-01 (devguide.python.org/versions, read by DR 2026-10-02). WP-13 may not hand-edit generated files.
- The same generator writes the table-form `license` that PEP 639 deprecates, the deprecated `License ::` classifiers, and an `asgi` keyword with no ASGI support (DR G6, G22).
- Accept: `>=3.11`, an SPDX `license = "Apache-2.0"` string, no `License ::` classifier, no `asgi`; `cargo xtask packages --check` clean.
- Needs: nothing beyond WP-6.

**AM-2. WP-8's property tests use the in-crate generator.** required.
- Missing: WP-8 plans "a proptest of arbitrary bytes per section". No manifest, `deny.toml` or `supply-chain` entry admits proptest (CV gap 9).
- Accept: generator-driven tests with fixed seeds, never panicking, per vector section.
- Needs: P3, or proptest adopted through `deny.toml`, `cargo vet` and a version fetched that day.

**AM-3. WP-9 refuses CR, LF and NUL in field values through the C ABI.** required.
- Missing: `routing-32` covers only the Node binding. `zero_res_header`, which .NET and Python use, has no row (RG R-16).
- Also replace "zero-core workspace" in `crates/zero-ffi/build.rs` (DR minor).
- Accept: an `abi_table.rs` case per byte, and a new `ffi` row citing it (R9).

**AM-4. WP-11 adds a public fixed-response route and fixes the package homepage.** blocker.
- Missing: the facade exposes no tier 0 fixed route, so the Node group's "routes answered in Rust" row has no plaintext cell (BM B10). `@zero-server/native` and its seven platform manifests carry `"homepage": "https://z-server.dev"`, a dead address (DR G22).
- Accept: `fixed({ status, contentType, body })` exported from `@zero-server/sdk` over native `ROUTE_FIXED`, with `Date` composed per response, a facade test and a guide line. Every package's homepage is the site URL or the repository.

**AM-5. WP-12 adds the docfx configuration.** required.
- Missing: docs.yml needs `bindings/dotnet/docs/docfx.json`, which does not exist. WP-12 owns `bindings/dotnet/**` (DR G11).
- Accept: the file exists, and the docs.yml .NET reference step passes.

**AM-6. WP-14 makes its own exit possible and pins the release path.** blocker.
- Missing:
  - WP-14's exit, "a `workflow_dispatch` run of release-node.yml builds the seven targets and publishes nothing", cannot pass. The gate publishes for every major of 2 or more, and the build is skipped below 2 (`release-node.yml:41-59`). See also N5.
  - No `npm publish --dry-run` exists anywhere (RM gap 15).
  - `npm install` is used where `npm ci` is required (`:115`, `:155`).
  - `goto-bus-stop/setup-zig@v2` (`:102`) is unmaintained. Its README says to use `mlugg/setup-zig`; last release 2024-09-28 (DR G18).
- Accept:
  - a `publish: false` input that runs every build, `napi artifacts`, `build:facade`, `check:packaging` and `npm publish --dry-run` for each package that will publish (sdk included), and uploads nothing;
  - the build-only mode can run without the version gate, for early runs;
  - `npm ci`;
  - `mlugg/setup-zig` at a tag fetched that day, with the zig version checked against what napi documents;
  - the dispatch run green for the seven targets.

**AM-7. WP-15's file list and where its results go.** required.
- Missing: the list names `src/main.rs` (N4). Results go to the gitignored `.docs/bench/`, but RULES requires published figures to have their raw data in the repository (BM B20).
- Accept: the list names `src/bin/zero-bench.rs` and `src/lib.rs`. Any cell quoted publicly is copied into `bench/results/<date>/`.

**AM-8. WP-16's SECURITY.md, CHANGELOG and public-text scope.** blocker.
- Missing:
  - WP-16 fills only the zero-ffi, bindings/node and .NET inventories. `zero-simd` has 37 unsafe sites, `zero-sys` 36 to 37, the Python native crate 1, and every table in `SECURITY.md` (lines 92-162) is empty.
  - `SECURITY.md:76-79` claims `cargo auditable`, a CycloneDX SBOM and attestations that no workflow produces.
  - `:101-104` names a ring provider feature that does not exist (DR G8, RM gap 8).
  - CHANGELOG lacks the `zero` binary, zero-http1, zero-core, zero-limits, zero-http-types, zero-simd, zero-sys, HTTP-date parsing, the packages, the vectors, the fuzz targets and the no_std builds (DR G14).
  - The public-text items of DR G15 (tier rungs shown as available, `[backing]`, the "ten thousand connections" claim, "one C ABI", the `host` scenario, the Node track item, zero-host absent) are not listed in the package.
- Accept:
  - every audited crate's table filled (item, file, obligation, justification) and checked against a cargo-geiger run;
  - the false sentences removed, or E6 shipped;
  - the CHANGELOG lines added;
  - the DR G15 checklist closed;
  - the README quick start using D1's feature names;
  - ROADMAP section 13 item 14 written from P4's corrected text.

## W1. Plan text and decisions (P)

**P1. Decide the R.2 benchmark gate and record it.** blocker, owner.
- Missing:
  - R.2 and R.3 rows 7 and 14 still require tier A on rented hardware, tier C on 25 or 40 GbE as a tag precondition, the Realistic entry at 1.10 times Drogon with a win in every run, results under `.docs/bench/` and the owner's go decision.
  - The owner moved runs to Docker on the 9950X3D (STATUS, Decisions, 2026-10-01). STATUS line 752 says tier C "is skipped". No waiver is written, and no go decision was recorded before step 8 (RM R.2 table, gap 7; BM B19, open decision 1).
- Accept: ROADMAP R.2 and R.3 rows 7 and 14 state:
  - the desktop Docker method of RULES;
  - tier C waived for release 1 or scheduled;
  - whether any ratio gates release 1 (recommended: publish ratios as measured, no gate);
  - the Realistic definition (B2, BM B18);
  - `bench/results/<date>/` as the home of the data;
  - the go decision with its date.
- Needs: owner.

**P2. Decide the httparse oracle.** required, owner.
- Missing: R.2 and R.3 step 3 name the oracle. httparse 1.10.1 is the newest stable release, created 2025-03-03 (crates.io, read by RM 2026-10-02). That is outside RULES' 12-month window, and the crate does not declare itself finished.
- Accept: ROADMAP records one of two choices.
  - (a) An exception for a dependency of `fuzz/` only, which is outside the shipped graph. F8 follows. Recommended: it is the only way to catch a head the parser accepts with wrong spans (CV gap 6).
  - (b) Drop the criterion, with the vectors and the fuzz targets named as the replacement.

**P3. RULES wording for property tests and test names.** required, owner.
- Missing:
  - RULES says parsers "carry proptest tests". The code uses an in-crate deterministic generator (STATUS step 2 decision), and 13 parsers have neither (CV gap 9).
  - RULES says conformance tests carry the section number in their names. 37 of 279 do (RG R-12).
- Accept: RULES amended so that (a) generator-driven property tests satisfy the rule and (b) the row's URL fragment and note may carry the section. Otherwise T11 adopts proptest and R12 renames 242 tests with their `at` text.

**P4. Correct DESIGN-12-13's stale publication text before WP-11 and WP-16 run.** blocker.
- Missing: these sections contradict the BRIEF's 2026-10-02 decision (sdk publishes 2.0.0-alpha.1 under `next`; one version everywhere). WP-16 is told to copy item 14 into ROADMAP (RM plan text 2, RM gap 18, DR G2).
  - Section 8.11 (line 2366: sdk `private`, "nothing is published before 2.0.0");
  - Section 8.13 (line 2435: "leaves the private `sdk` out of the publish set");
  - Section 13 item 14 ("no `2.0.0-alpha.1` publish");
  - Section 15 question 4 ("at 0.1.0").
- Accept: those four places state the sdk publish under `next` at 2.0.0-alpha.1.

**P5. ROADMAP and STATUS contradictions.** required.
- Missing:
  - R.3 step 14 "tag `v0.1.0`", R.3 row 34 "0.3.0" and R.7 item 12 "crates stay 0.x", against the single-version policy;
  - step 1 "`rerun-*-linux.txt` committed under `.docs/`" (they are in `bench/probes/`);
  - step 9 "the 33 ... statements" (27 at release 1 after the recorded deferral, RG R-17);
  - STATUS "Next" still says "tag v0.1.0" (RM plan text 1, 5; DR G2).
- Accept: grep of `.github/cloud/` for `v0.1.0` and `0.3.0` finds only history. Land before WP-16 starts.

## W2. Fuzzing (F)

**F1. Fix the three fuzz failures (N1).** blocker. Not covered. In flux (`target/fzfix`, 20:02 UTC).
- Accept, for each case:
  - the crate fixed, or the oracle corrected with the specification text cited;
  - a unit test named after the statement that fails on `e13e631`: RFC 7239 Section 4 quoted-string values, RFC 9846 Section 5 `unexpected_message` for a non-handshake record before the ClientHello, and Fetch Section 3.2 serialized-origin;
  - the input added under `fuzz/seeds/<target>/`;
  - a 60-second smoke of the three targets clean;
  - each source fetched that day and cited in the commit.
- Needs: coordination with WP-7 on `cors.rs`.

**F2. Remove the root crash files (N2).** blocker.
- Accept: no `crash-*` at the repository root, and `/crash-*` ignored at the root. The inputs live on as F1's seeds.

**F3. Commit the eight new targets.** blocker. In flux.
- Missing: `base64_decode`, `cors_fields`, `forwarded_parse`, `mime_parse`, `sse_decode`, `tls_hello`, `ws_frames` and `ws_session` are untracked with their seeds and dictionaries, and `fuzz/Cargo.toml` and `fuzz/Cargo.lock` are modified.
- Accept: committed together with F1 or after it. CI's fuzz smoke runs `cargo fuzz list`, so committing first turns it red. The fuzz-smoke job is green.

**F4. Targets for the remaining untrusted-input parsers.** required.
- Missing (CV gap 8):
  - `zero_date::parse_http_date`;
  - zero-static `range::resolve`, `EntityTag::parse` with `cond::evaluate`, and `Files::locate`;
  - zero-ws `handshake::negotiate` and `accept`;
  - zero-policy `Sec-Fetch-Site` and the incoming request id;
  - the zero-http1 `ResponseWriter`, whose input becomes host data through the bindings.
- Accept: one target each with seeds and a dictionary, asserting the specification's properties, not only the absence of a panic. A 60-second smoke is clean.

**F5. 24 CPU-hours for every target.** blocker for the 8 QPACK and HTTP/3 targets (R.3 step 11 exit) and for `http1_*` (done); required for the rest (R.7 item 14).
- Missing: `target/fuzz-campaign/progress.txt` shows `cmsg_decode`, `http1_chunked`, `http1_head` and `json_parse` done with 0 artifacts. `qs_parse` has run since 19:36 UTC. `router_resolve`, `simd_kernels`, `uri_normalize` and `utf8_validate` are queued. 16 targets are outside the campaign, and F4 adds about 8 more.
- Accept: a `done ... exit=0 artifacts=0` line for every target in `cargo fuzz list`. About 29 targets remain, about 700 CPU-hours: 116 hours at the campaign's 6 workers, about 58 at 12.
- Needs: F1, F3, F4. Paused during B6.

**F6. Record the campaign and commit the corpus.** required.
- Missing: the results live only in gitignored `target/`, and `fuzz/.gitignore` ignores `corpus`. R.7 item 14 asks for "the crash corpus committed" (RM gap 11, CV gap 7).
- Accept: per target, the duration, executions, corpus size, artifacts and the cargo-fuzz 0.13.2 pin, in STATUS and the commit body. A `cargo fuzz cmin` corpus is committed into `fuzz/seeds/`.

**F7. A scheduled fuzz workflow.** required.
- Missing: `ci.yml` says "the long runs are a separate schedule", and R.7 item 14 names "the weekly job". Only `codeql.yml` and `pypi-backfill.yml` have a `schedule`.
- Accept: `.github/workflows/fuzz.yml` runs weekly with cargo-fuzz pinned at a version fetched that day and a per-target time budget, uploads any crash, and its first run is green.

**F8. The httparse differential target.** required if P2 chooses (a).
- Accept: `http1_differential` in `fuzz/` with httparse pinned and vetted. It runs 24 CPU-hours clean, and the R.2 row is updated.

## W3. Core correctness fixes (C)

**C1. Security headers on the responses zero-http writes itself.** blocker. Not covered.
- DESIGN-12-13 section 3.2 adds the headers only to misses routed through zero-host.
- Missing: 400, 408, 413, 421, 505 and the 500 after a handler error carry no policy headers. STATUS records the follow-up, and `crates/zero-serve/tests/serve.rs:379` pins the exception (RM gap 12, RG R-07).
- Accept: a configured field set on zero-http's `Config`, written on every response the driver generates. One wire test per status, failing on `e13e631`. The `serve.rs:379` test inverted. Rows `policy-18` and `policy-25` cite a wire test (R9). The OWASP HTTP Headers Cheat Sheet is fetched and cited.
- Needs: WP-3.

**C2. Pin workers inside the process's allowed CPUs.** blocker. Not covered.
- Missing: `zero-io/src/tokio_rt/worker.rs:371` and `compio_rt/worker.rs:359` pin worker `i` to absolute CPU `i`, and `net.rs:74-75` passes the same index to `SO_INCOMING_CPU`. Under `--cpuset-cpus`, Kubernetes or `taskset`, workers pin outside the set or run unpinned, in production and on the benchmark (BM B4).
- Accept: worker `i` pins to `allowed[i % n]`, read once through `zero_sys::affinity::current_thread_cpus()`, with the same mapping for `SO_INCOMING_CPU`. A test restricts the mask before `serve` and asserts every worker's `pinned()` CPU is inside it. The test fails on `e13e631` and runs on both backends.
- Needs: the crate-doc pass commit (zero-io in flux).

**C3. The Windows io-compio truncated datagram.** required.
- Missing: `crates/zero-io/tests/datagram.rs` asserts nothing on Windows for a datagram longer than its buffer (STATUS step 8; RM gap 20).
- Accept: run natively on this Windows host (`cargo test -p zero-io --no-default-features --features io-compio --test datagram`), assert what the completion carries, and keep the CI seam job green on `windows-latest`. Not an owner item.

## W4. Test depth (T)

The owner asked for "heavily unit tested". Production line coverage is 92.15 % over 27 crates. The weakest are zero-tls (79.9 %) and zero-io (84.8 %); CV has the per-file lists. New tests go in new files under `tests/` wherever the item is public, so they do not collide with the packages.

**T1. zero-http driver: fragmented input and malformed bodies.** required (CV gap 1).
- Accept:
  - Driver tests on both backends with `zero_io::rt::Config::receive_block` set to a few dozen bytes. They cover heads across reads and heap growth (`conn.rs:222-261`), a chunked body stalled mid-line, framing errors and an obs-fold trailer, each answered 400 with `Connection: close` (`:930-945`), the no-budget read retry (`:554`, `:677`), and response head growth with the bare 500 (`:1329-1346`).
  - An accept-loop `EMFILE` test in a child process with `RLIMIT_NOFILE` lowered.
- Needs: WP-3.

**T2. zero-tls stream layer and refusals.** required (CV gap 2).
- Missing: five `Stream` methods on three stream types, every listener refusal outside the fuzz target, the no-budget paths, the TLS 1.3-only and tickets-off configurations, the ticket lifetime refusal, the unbuffered driver's buffer growth, identity loading errors, and the `ReadEarlyData` arm (test it with early data offered, or delete it).
- Accept: zero-tls at 90 % or more of production lines (a judgment floor); each refusal asserts its alert.
- Needs: F1 (`hello.rs`).

**T3. One seam conformance test generic over `zero_io::Stream`.** required (CV gap 3).
- Accept: `fn conformance<S: Stream>` instantiated for tokio, compio, buffered TLS and unbuffered TLS, covering every method including a drop mid-flight. Listener options are read back through the zero-sys getters. zero-io reaches 90 % or more.

**T4. zero-static: the symlink-swap vector and the Windows rules.** required; R.3 step 9 exit (RM gap 14, CV gap 4, RG R-06).
- Accept:
  - A test hook swaps a path component for a link between the check and `open_nofollow`, and the request answers 404. This reaches the device and inode check at `files.rs:289-293`.
  - The colon and short-name rules become a parameter testable on every host (`files.rs:168-177`), with `-p zero-static` on the Windows and macOS legs (G4).
  - Cache eviction and invalidation, 412, and the download `Content-Disposition` are tested.
  - `static-05` asserts Expires and Vary on the 304, and `static-15` is re-phrased or per-response.
- Needs: WP-7 if taken.

**T5. zero-http1 named rejection tests.** required (CV gap 5).
- Accept: one test per branch, named with RFC 9112 Sections 2.2, 3.2.3, 5.2 and 7.1.2, asserting the `Reject` status and close. The branches are at `head.rs:321`, `389`, `442` and `566`, and `chunked.rs:244`, `250-253`, `259-260`, `472`, `488` and `498`.

**T6. zero-http's public request accessors.** required (CV gap 13).
- Accept: one routing test reads `target()`, `query()`, `route_path()`, `params()`, `authority()` and `peer()`, and covers the default `Handler::taken`.

**T7. zero-realtime end to end.** required (CV gap 14, RG R-06).
- Accept:
  - Tests for `EventStream::comment()`, `request()`, `WebSocket::request()`, `token()`, a peer that drops mid-message and a zero-byte write.
  - Wire tests for `realtime-25` (the served SSE fields), `realtime-31` (the keep-alive comment emitted), `realtime-32` (`Last-Event-ID` exposed) and `realtime-33` (a served 204 ends the stream, today a constant compare).
- Needs: WP-4.

**T8. The `zero` binary's failure paths.** required (CV gap 15).
- Accept: process tests in a new `tests/` file for usage errors, start failures, panic reports, a core that stops, header rendering errors and a root that disappears, each asserting stderr and the exit status.

**T9. Router refusals and lookup by name.** required (CV gap 16).
- Accept: tests for `TooManyParameters`, `ParameterConflict`, `Params::by_name`, `len`, `is_empty` and the mount tie-break. The matching-rule cases of zero-server-node's `test/routing/router.test.js` are ported to Rust; the facade cases stay with WP-14.

**T10. Specification branches and error mappings in the small codecs.** required (CV gap 17).
- Accept:
  - zero-uri: RFC 3986 Section 5.2.4 step 2A and two refusals;
  - zero-base64: the RFC 4648 Section 3.2 padding refusals;
  - zero-date: the asctime two-digit day and RFC 850 trailing bytes;
  - zero-ws: the RFC 6455 Section 5.5 125-octet control frame on send (after WP-4);
  - zero-sse: `max_event`;
  - one table-driven test per crate over every error variant's `Display` and its `zero_core::Error` mapping (base64 `Full` maps to 413).

**T11. Property tests for every parser of untrusted input.** required (RULES, CV gap 9).
- Accept: for zero-http1, zero-uri, zero-qs, zero-json, zero-router, zero-mime, zero-base64, zero-ws, zero-sse, zero-policy, zero-static, zero-date and zero-tls, generator-driven tests in `cargo test` with fixed seeds, scaled down under Miri. They cover prefix partiality, split-feed equivalence and round trips.
- Needs: P3.

**T12. Strengthen the Partial and Weak row tests not covered by T4 or T7.** required (RG R-06).
- Accept:
  - `routing-10`: Date on the wire and Last-Modified from zero-static;
  - `h1-12`: the connection closes after the response;
  - `body-06`: a 413 on the wire;
  - `policy-12`: the preflight status on the wire;
  - `qpack-01`: all 99 entries against RFC 9204 Appendix A;
  - `jwt-24`: delegation to the constant-time primitive.

**T13. No fixed sleeps or wall-clock upper bounds in cited tests.** required (RULES, RG R-15).
- Accept: the 50 ms sleeps of `runtime-02` and `runtime-03` replaced by waiting on the handler's real start. The upper bounds of `h1-13`, `runtime-02` and `tls-17` widened or dropped.

**T14. The small remaining lists.** should (CV per-crate lists).
- zero-core: `OwnedBuf::into_vec`, the `From` impls and `None` arms, and the `Display` of four `Error` variants.
- zero-sys: `getrandom` interrupted or empty, the non-int `getsockopt`, the `MSG_PEEK` and `MSG_ERRQUEUE` flags, and the signal and `fcntl` failures.

**T15. The TLS handshake cap at its default.** should (RM step 10 note).
- Accept: a test holds at least 1,025 half-open handshakes on one core and asserts that the 1,025th waits.

**T16. Coverage of the Windows and macOS code paths.** should (CV limits).
- Accept: G4's runs report which platform-specific functions ran (`SO_EXCLUSIVEADDRUSE`, `SetThreadAffinityMask`, the Ctrl+C path).

## W5. Registry (R)

**R1. Move eleven tested behaviors to release 1.** blocker (RG R-04, RM gap 13).
- Missing: `errors-01` to `errors-07` (RFC 9457, tests at `crates/zero-http/tests/driver.rs:1208-1316`) and `body-08` to `body-11` (URL Standard form decoding, `crates/zero-qs/src/lib.rs:177-215`) are `release = 2`. Rows above the current release are not enforced, so the standards page calls shipped behavior unwritten.
- Accept: `release = 1`; the scan is green.
- Needs: WP-0 committed.

**R2. `standards --check` reports every failure and checks the line is a test.** blocker (RG R-02).
- Missing: `standards.rs:363-402` stops at the first problem. `locate` (`:477-498`) accepts any line, so a comment, a helper or an `#[ignore]` test passes.
- Accept: all problems are printed. A shape check per evidence type: Rust `#[test]` family and not ignored, JavaScript `it(` or `test(` with the title, Python `def test_`. An xtask unit test for each.

**R3. Rows for release 1 features without one.** required (RG R-05).
- Accept: rows citing the 15 existing statement-named tests, anchored `vector` where the test uses the RFC's examples. They cover:
  - zero-base64 (RFC 4648);
  - zero-date recipient parsing;
  - zero-uri Section 5.2.4;
  - zero-mime Section 8.3.1;
  - the zero-http-types tables;
  - the QPACK constants and Huffman table;
  - the zero-sys FIFO and signal status;
  - zero-serve HSTS over plain HTTP;
  - the documents cited without a row: RFC 8615, the IANA close codes, `text/event-stream`.

**R4. Anchors that misstate their evidence.** required (RG R-08).
- Accept:
  - `runtime-02` and `runtime-06` become `rule`.
  - `runtime-22` is re-anchored to `rule` with the dispatcher's reaction as its subject, or re-cited to WP-10's `status.test.mjs`.
  - `routing-10`, `routing-23`, `static-01`, `static-07`, `static-16`, `realtime-08` and `realtime-11` become `vector`.

**R5. Node.js rows cite the pinned engines line.** required (RG R-09).
- Accept: `runtime-01`, `runtime-02`, `runtime-07` and `tls-17` cite `https://nodejs.org/docs/latest-v22.x/api/...` with the text confirmed and the date recorded.

**R6. `tls-06` cites RFC 9846, not the obsoleted RFC 7627.** required (RG R-10).

**R7. RFC 9931 in the notes of `h1-15` and `h1-16`.** should (RG R-11).
- Accept: the notes cite it, and a row or rustdoc pins that CONNECT is never tunneled.

**R8. Deep links for 35 release 1 URLs.** should (RG R-14).

**R9. Re-cite rows once their stronger tests exist.** required.
- Accept: `policy-18` and `policy-25` cite C1's wire tests; the rows of T4, T7 and T12 cite the new tests; AM-3's new `ffi` row is added.
- Needs: C1, T4, T7, T12, AM-3.

**R10. `@see` on the implementing items.** required (RULES, RG R-13).
- Missing: 55 rows have no `@see` in their crate. zero-router, zero-json, zero-mime, zero-uri, zero-qs and zero-base64 have none at all.
- Accept: `@see <url>#section` beside the existing plain-text citations.
- Needs: runs last, per crate, after the package, T and D for that crate.

**R11. `docs/about/standards.md` says a row holds "the file that implements it".** should (RG R-17).
- Accept: the sentence matches the schema.
- Needs: the crate-doc pass (in flux).

**R12. Section numbers in test names.** required only if P3 keeps the rule (RG R-12).
- Accept: 242 tests renamed with their `at` text in the same commits.

## W6. Documentation and site (D)

**D1. The bundle crate's chapter features.** blocker (RM gap 3, DR G10).
- Missing: `docs --check` reports that feature `http` of `crates/zero-server` (`Cargo.toml:65`) does not turn on zero-date, zero-uri, zero-qs, zero-json, zero-base64, zero-mime, zero-static or zero-policy, and that there is no `http3` feature. Feature names are permanent at the first publish.
- Accept:
  - zero-http's bundle feature renamed through a `bundle_feature` exception (for example `server`, as `static` re-exports as `files`), so `http` is the chapter;
  - `http3 = ["qpack", "h3"]`;
  - the choice recorded in the crate doc;
  - `builds.rs` updated, and the README line handed to WP-16 (AM-8);
  - `docs --check` reports no feature problem;
  - every feature and builds row checks alone (G5).

**D2. The ten capability guides.** blocker (RM gap 2, DR G9).
- Missing: `docs --check` reports that http1, router, codecs, static, policy, websocket, sse, tls, qpack and h3 have no guide. WP-11 writes only `quickstart.ts`, `ws.ts` and `sse.ts`.
- Accept:
  - `docs/guides/<key>.md` with `guide =` lines in `capabilities.toml`;
  - Rust examples in `crates/zero-examples/examples/guides/<key>.rs`, run by the CI examples step;
  - TypeScript programs in `bindings/node/guides/<key>.ts`, run by `npm run guides`; qpack and h3 say there is no TypeScript surface;
  - Python and C# sections saying they ship in release 2;
  - valid `next` keys;
  - the coverage the DR G9 table gives for each guide;
  - `cargo xtask docs --check` exit 0 together with D1.
- Needs: WP-11 for the TypeScript sections; WP-1 for `capabilities.toml`.

**D3. Crate READMEs must not publish dead links.** blocker (DR G3).
- Missing: `crates/xtask/src/docs.rs:131-137` puts the site's reference URL first in every crate README. The site returns 404, and a README packaged into a crates.io version never changes.
- Accept: the generator links `https://docs.rs/<crate>/2.0.0-alpha.1` until D4 is live, or D4 is live before release-crates runs (X3). A link check runs over the packaged READMEs.

**D4. A documentation site that builds and deploys.** required (RM gap 4, DR G11).
- Missing:
  - eight front-end files (`web/site.css`, `home.css`, `reference.css`, `js/{site,home,consoles,reference}.js`, `.nojekyll`);
  - the nav pages (`docs/index.md`, `install`, `examples`, `community`, `reference/{index,rust,node,python,dotnet}`, `about/{why,architecture,building,privacy,terms,notices}`);
  - `docs/theme/rustdoc.html` and the pdoc theme;
  - the typedoc project;
  - `home.toml` groups (`field` and `robotics` against `server` and `bindings`, `site/home.rs:328`);
  - the dashboard and the old palette (`THEME_COLOR` `#0f5f56`, `layout.rs:418`);
  - quickstart paths that do not exist (`site/home.rs:143-155`);
  - `pages.yml` that is dispatch-only and has never succeeded.
- Accept: `cargo xtask site --verify` green; Python and C# release-aware; docs.yml green; `pages.yml` deploying on the release; https://molexxxx.github.io/zero-server/ serving.
- Needs: D5, D7, AM-5; the catalog edits in flux.

**D5. Rustdoc without warnings.** required (DR G11).
- Missing: `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` exits 101. There are 11 warnings in 6 crates: ambiguous links in zero-sse, zero-json and zero-rt; unresolved links in zero-io, zero-rt and zero-json; private `Outbox` links in zero-tls; and bare URLs in zero-policy. The crate-doc pass may already fix some.
- Accept: exit 0.
- Needs: per crate, after its package.

**D6. Runnable examples in crate docs, and the bundle crate's page.** required (DR G17).
- Missing: 16 of 27 crates have no doctest. `crates/zero-server/README.md` has no feature table or server example, and CONTRIBUTING says the docs carry runnable examples.
- Accept: a doctest per crate. The bundle crate doc splices the `builds` table and the hello example.
- Needs: D1, and T for each crate.

**D7. docs.yml toolchains.** required (DR G5, G13, G18).
- Accept: `setup-node` on 24 (Node 20 is EOL), `setup-dotnet` 10.0.x, maturin pinned, each value cited with page and date.

**D8. Stale public text outside WP-16's files.** required (DR G15, G16).
- Accept:
  - `capabilities.toml` lines 201-202 ("ship in release 3, when @zero-server/sdk is made public") corrected;
  - `Catalog::cross_language` names the sdk entry points, replacing "ship in a later release" in every capability README;
  - `bindings/node/README.md` and `bindings/python/README.md` written (the generator lists them);
  - the issue template links resolve.

**D9. The bindings diagram's boundary label.** required.
- Missing: `assets/bindings*.svg` labels the boundary "C ABI" for every language. DESIGN-12-13 section 8.1 puts the Node binding on zero-host, not on the C exports, and STATUS asks for this check.
- Accept: `scripts/architecture.py` relabels the boundary and regenerates its six files, then a screenshot review.
- Needs: before B7 refactors `architecture.py`.

**D10. CONTRIBUTING covers the bindings.** should (DR minor).
- Accept: CONTRIBUTING covers building and testing Node, Python and .NET, and `just guides`.

**D11. Leftovers from the generator's previous project.** should (DR minor).
- Missing: `mqtt`, `zero-lorawan`, `modbus`, `boards/pi.md` and `farm` fixtures in xtask tests; `packages --check` prints the docs task's message (`packages.rs:95`).
- In flux in part (`catalog.rs`).

**D12. Manifest comments that cite the gitignored DESIGN.md.** required (DR G17, RM in flux).
- Missing: `crates/zero-io/Cargo.toml:26` and `crates/zero-rt/Cargo.toml:23` (WP-1's file). Both ship inside `Cargo.toml.orig` in the `.crate`.
- Accept: no `DESIGN.md` reference in any packaged file (`cargo package --list` plus grep).
- In flux.

## W7. Benchmarks (B)

The method and entries follow BM's design: wrk for throughput, oha for fixed-rate latency, five interleaved runs, medians, per-run ratios, every error counter at zero, and the raw data committed.

**B1. Load generators and machine-readable output.** blocker (BM B2).
- Accept:
  - `bench/docker/wrk.dockerfile`: `ubuntu:24.04` by digest, `wrk=4.1.0-4build2`, TechEmpower's `pipeline.lua` plus a `report.lua` defining only `done()`;
  - `oha.dockerfile` at 1.16.0, built `--locked` in a pinned Rust image;
  - versions refetched on the build day;
  - `--json` on `zero-bench load`, `idle` and `miss`.
- Needs: WP-15 for `bin/zero-bench.rs`.

**B2. zero-server's entries.** blocker (BM B3, B5, B18).
- Accept:
  - `/users/:id` inside the 100-route table and `/static/*` over `zero_static::Files`, with tests in `tests/entries.rs`;
  - dockerfiles `FROM rust:<version>-slim-trixie@sha256:...` with `--locked` (today `rust:latest`, a RULES defect);
  - the Realistic definition settled by P1: amend R.2 to "router and zero-limits defaults", or apply the zero-policy defaults.

**B3. Competitor entries.** blocker (BM B9, B12, B17).
- Accept:
  - `bench/entries/<group>/<name>/` with an `ENTRY.md` each (source URL and commit, image digest, every deviation) for hyper, axum, actix-web, Drogon, node:http, Express, Fastify and uWebSockets.js;
  - each from TechEmpower archived master `57d92fbe`, with the framework at the registry's version on the build day;
  - Drogon at v1.9.13 with `db_clients` removed, plus the pinned Round 23 Drogon as a raw-data row;
  - Express and Fastify patched to `os.availableParallelism()`;
  - routed-parameter and static routes per each framework's documentation at the pinned version.

**B4. The two Node apps.** blocker (BM B11).
- Accept: `bench/entries/node/zero-server-rust-routes` (`fixed()` and `static`) and `zero-server-js` (handlers for plaintext, json, `/users/:id` and `sendFile`) over the public facade only, with `NODE_ENV=production` and `threads` and `isolates` set from `availableParallelism()`.
- Needs: WP-11 and AM-4.

**B5. The orchestrator and the idle probe.** blocker (BM B6, B7, B8, B13, B14, B15, B21).
- Accept: `cargo xtask bench build|verify|run|report`, unit-tested in every pure part. It covers:
  - TechEmpower-style verification;
  - `somaxconn` and `tcp_max_syn_backlog` set to 65535, and `nofile` 200000;
  - `seccomp=unconfined`, with the cell failing unless the backend line names `io_uring` for io-compio;
  - the quiet-machine checks, pausing `zero-fuzz` and resuming it in a finally path;
  - cgroup CPU and memory sampling;
  - the interleaving, the `results.json` and `summary.json` schema, the error gate, the saturation flag and the zero-bench cross-check.

  The idle probe gains cgroup `memory.stat`, source-address spreading over `127.0.0.2` to `127.0.0.255`, and a buffered head read.
- Needs: B1, and `xtask/src/main.rs` after WP-6 (in sequence with G2).

**B6. The pilot and the five-run session.** blocker (BM build order 7 and 8; RM R.2 gates and step 8).
- Accept: `bench/results/<date>/` committed alone: `session.json`, `results.json`, `summary.json`, `raw/`, `entries.json` and `REPRODUCE.md`. The R.2 gates are recorded as raw data on zero-server:
  - idle bytes at 10k, 100k and, if the 24 GB VM holds it, 1M;
  - plaintext at 16,384 connections with zero errors;
  - a paired run with `overflow-checks` off;
  - the 16-connection json figure;
  - io-compio CPU per request.

  The measured commit is named. Any later change to the hot path before the tag (zero-http, zero-io, zero-host, the Node binding) means a rerun.
- Needs: B2 to B5, C1, C2, P1, F5 paused, and the owner's quiet window (O6).

**B7. The charts.** blocker (BM B22, B23).
- Accept:
  - `scripts/svgglyphs.py` extracted, with `architecture.py`'s six files byte-identical;
  - `scripts/bench_charts.py` writing `assets/bench/<group>-<test>{,-dark,-narrow}.svg` and `overview*.svg`: emphasis bars (zero-server in moss or flare, others in ash), direct labels, whiskers, `role="img"` with `<title>` and `<desc>`, outlined glyphs, palette-only colors;
  - a structure test over a fixture `summary.json`;
  - screenshots in Chromium and Firefox in both schemes.
- Needs: D9.

**B8. The publication.** blocker (BM B1, B19, B24; RM gap 9).
- Accept:
  - `BENCHMARKS.md` covers: the method, the hardware ("one desktop under WSL2"), the Rust and Node groups with `<!-- table: bench ... -->` regions generated from `summary.json`, latency and idle memory, the entries and deviations, Python and .NET stated as not measured, and the limitations;
  - `docs/about/benchmarking.md` written, which fixes the dangling link in `.github/cloud/RULES.md`, and `just bench +args`;
  - a README `## Performance` section: two sentences of method, the overview picture, a generated sentence and a link;
  - `web/home.toml` `[backing]` rewritten (today "rented Linux host", "a win required in every run");
  - a site page and nav entry;
  - `docs --check` holds every region to the data;
  - an adversarial review, one reviewer per competitor and one for wording against RULES, then fix and regenerate.
- Needs: B6, B7, and WP-16 (README and `home.toml`).

## W8. CI gates (G)

**G1. Make the registry and docs checks blocking.** blocker (RG R-03).
- Missing: `ci.yml:148-158` runs `docs --check` and `standards --check` with `continue-on-error: true`. Run 37048673426 failed both steps and reported green.
- Accept: both steps blocking.
- Needs: WP-16, D1, D2, R1.

**G2. A coverage job with per-crate floors.** required (CV gap 12).
- Accept:
  - cargo-llvm-cov at the version fetched that day (0.9.1 on 2026-10-02) running CV's five passes and uploading the lcov;
  - `cargo xtask coverage --check` failing when a crate's production line figure drops below the floor recorded in the repository;
  - floors set after T1 to T13 from the measured figures; the judgment target is at least 90 % for every release 1 library crate.
- Needs: WP-16 for `ci.yml`; WP-6 for `main.rs`.

**G3. Sanitizers over zero-sys and zero-simd.** required (CV gap 10).
- Missing: `ci.yml:429-435` tests only zero-rt and zero-ffi. WP-16 adds zero-host. zero-sys and zero-simd hold 73 unsafe sites, and Miri never runs the AVX2 kernels.
- Accept: `-p zero-sys -p zero-simd` and `zero-io --test datagram` under ASan, and zero-sys under TSan, green.

**G4. Tests on Windows and macOS.** required (CV gap 11).
- Accept: the seam job (`ci.yml:258-287`) also runs zero-tls, zero-static, zero-realtime and zero-serve, or the workspace, on `windows-latest` and `macos-latest`.

**G5. The bundle feature matrix.** required (DR G10).
- Accept: a step running `cargo check -p zero-server --no-default-features --features <f>` for every feature and every `builds` row.

## W9. Release engineering (E)

**E1. A non-publishing release candidate for every registry, and no partial releases.** blocker (RM gap 5, DR G4, N5).
- Missing:
  - release-python and release-nuget have no dry-run input and have never run.
  - The preflight does not run `cargo xtask release --dry-run`, although R.3 step 14 requires it.
  - The five workflows publish in parallel, so a late failure leaves crates.io published and another registry not.
- Accept:
  - a `publish: false` input on both, running every build, `twine check` on the wheels and the sdist, and `dotnet pack` with the seven runtimes asserted present, uploading nothing, and able to skip the version gate for early runs;
  - `cargo publish --workspace --dry-run` in the preflight;
  - publish jobs that wait for every registry's builds (one release workflow, or a gate job each publish job `needs`);
  - the release-candidate runs green on the X1 SHA, with registry 404 checks afterwards proving nothing was uploaded.
- Needs: AM-6 for release-node.

**E2. The .NET SDK in release-nuget.** blocker (DR G5, RM gap 6).
- Missing: `release-nuget.yml:127` installs 8.0.x, while WP-12 moves the projects to `net10.0`. An 8.0 SDK cannot pack them.
- Accept: `dotnet-version: "10.0.x"` with the support page and date cited.
- Needs: WP-12.

**E3. Third-party notices in native artifacts (N3).** blocker.
- Accept:
  - an xtask generator (or cargo-about at a version fetched that day and admitted by the policy) writing, from `cargo metadata` and the crates' license files, one notices file with the license text and copyright of every crate statically linked, including aws-lc's bundled components;
  - the file packed into the seven npm platform packages, the wheels, and the `ZeroServer.Native` package;
  - a `--check` mode in CI.
- Needs: WP-10, WP-12, WP-13 (their packaging files are regenerated after them).

**E4. Pin runner images across the candidate and the tag.** required (N6).
- Accept: `runs-on` in the release workflows (and in CI's jobs that release builds mirror) names an explicit image, with the actions/runner-images changelog fetched and cited. Otherwise the candidate runs after 2026-10-19 on the image the tag will use.

**E5. Currency in the release path.** required (RM gap 22, DR G18).
- Accept:
  - `mlugg/setup-zig` at a fetched tag in release-nuget (release-node via AM-6);
  - `cargo-zigbuild`, `build`, `twine` and `maturin` pinned at their PyPI versions with a dated comment (`release-nuget.yml:88`, `release-python.yml:122,166`, `pypi-backfill.yml:177,223`, `python.yml:32` via WP-13);
  - `cargo build --locked` (`release-nuget.yml:99`);
  - a pinned toolchain instead of `dtolnay/rust-toolchain@stable`.

**E6. SBOM, auditable builds and provenance.** required (DR G8).
- Accept: `cargo auditable` builds for the cdylib, the napi addon and the wheels; a CycloneDX SBOM; `actions/attest-build-provenance` on every artifact; each tool's version fetched. Otherwise AM-8 deletes the claim. Default: implement.

**E7. CHANGELOG date enforced.** required (RM gap 17).
- Missing: `version --check 0.1.0` passed with `## [0.1.0] - Unreleased`.
- Accept: for a release version, the check requires `## [<version>] - YYYY-MM-DD`, with an xtask test.

**E8. Crate keywords and categories per crate.** required (DR G21).
- Missing: all 28 crates share `no-std`, `asynchronous` and `web-programming::http-server`. 12 are std-only and 16 are synchronous. Published metadata is fixed per version.
- Accept: per-crate keywords and categories, with the slugs checked against the crates.io categories API.
- Needs: WP-1.

**E9. crates.io publish timing.** should (DR G19).
- Missing: 28 new crates need at least 230 minutes of rate-limit waiting plus a verify each, against `timeout-minutes: 300`. The comment at `release-crates.yml:31` says 27.
- Accept: the comment corrected; one crate's publish-and-verify time measured from the dry run; the rerun path documented in `releasing.md`.

**E10. `pypi-backfill` exits cleanly with no tag.** should (RM gap 19, DR G20).
- Missing: it fails hourly at `git checkout "v"`.
- Accept: exit 0 with a notice when no `v*` tag exists.

**E11. Preflight permissions.** should (DR minor; unverified that `gh run list` works with `contents: read`).
- Accept: `actions: read` added.

**E12. `releasing.md` completeness.** should (DR minor, G16, G23).
- Accept: it states that `cargo publish --workspace` needs Rust 1.90 (the workspace says 1.89), and adds the trusted publisher of `@zero-server/sdk` to the owner checklist.
- Needs: WP-11.

**E13. Test private keys inside the zero-tls crate package.** should (DR minor).
- Missing: zero-tls packages `tests/fixtures/*.key` in its `.crate`.
- Accept: the keys are generated at test time, or excluded from the package with the tests adjusted.

**E14. PyPI trusted publishing.** should (DR minor).
- Missing: release-python uses the long-lived `PIP_TOKEN`, while npm and NuGet use OIDC.
- Accept: the PyPI trusted publisher flow, once the owner registers pending publishers (O5).

## W10. Release sequence (X)

**X1. The version bump commit.** blocker (RM gap 1, DR G2).
- Accept: `cargo xtask version 2.0.0-alpha.1` (exact `=` sibling requirements, PEP 440 `2.0.0a1`, the npm lockfile) and the CHANGELOG heading `## [2.0.0-alpha.1] - <date>` with link references, committed alone. `version --check 2.0.0-alpha.1` exits 0.
- Needs: every item that changes a manifest or package text: WP-6, WP-11, WP-12, WP-13, AM-1, AM-4, D1, D3, E3, E8.

**X2. Every gate green on the bump SHA.** blocker (RM step 14).
- Accept:
  - `just ci`;
  - `standards --check` and `docs --check`;
  - ci, node, python and dotnet green;
  - `cargo xtask release --dry-run` with 28 crates at 2.0.0-alpha.1 including zero-host (measured today only for 27 at 0.1.0 and in a scratch copy);
  - the E1 and AM-6 candidate runs green.
- Needs: X1, G1, everything above marked blocker.

**X3. The documentation is live before the crates publish.** blocker (DR G3).
- Accept: D4 deployed, or D3's docs.rs links in the packaged READMEs.

**X4. Release-time text.** blocker (RM gap 16, DR G16).
- Missing: `.github/cloud/work/readme-at-release.md` predates the sdk decision (lines 128-129, 339, 349 say the sdk stays private).
- Accept: at-release.md corrected; README "Nothing is published" and the git dependency replaced by the registry lines; `npm install @zero-server/sdk@next` added; package READMEs per at-release; the Performance section (B8) present.
- Needs: WP-16, B8. Lands with X1 or just before it.

**X5. The tag.** blocker, owner.
- Accept: `v2.0.0-alpha.1` pushed on the X2 SHA after owner confirmation. release-crates (at least 230 minutes), release-node, release-python, release-nuget and release-github succeed. Each registry shows the version (npm under `next`). The pages deploy runs.

## Critical path to the v2.0.0-alpha.1 tag

1. **Now.**
   - Land the work in flux: WP-0 and WP-1, the crate-doc pass, F1 to F3. F5 continues.
   - The owner answers P1 to P3. P4 and P5 land.
   - Unblocked in parallel:
     - C2, C3;
     - T items on files no package owns (T3, T5, T6, T8, T9, T10 except zero-ws, T14, T15);
     - R1 to R8 once WP-0 is committed;
     - D1, D3, D4 (outside the catalog files in flux), D5 per free crate, D7, D9;
     - E4 to E11, E13;
     - B1 to B3, F4.
2. **Line 2.**
   - WP-2, WP-3, WP-4, WP-5, WP-6 with AM-1, and WP-7.
   - After them: C1 (needs WP-3), T1, T4 (WP-7), T7 and the zero-ws part of T10 (WP-4), B5 (WP-6).
3. **WP-8.** Then WP-9 with AM-3 and WP-10, then WP-11 with AM-4, WP-12 with AM-5, and WP-13.
   - After WP-11: B4 and D2's TypeScript programs. After WP-12: E2. After WP-10, WP-12 and WP-13: E3's packaging.
4. **Benchmark session.** Needs WP-11, C1, C2 and B1 to B5. The pilot, then the five-run session in the owner's quiet window, with `zero-fuzz` paused: about 8 hours with the pilot. Then B7.
   - It runs beside WP-14 with AM-6 and WP-15 with AM-7, and must be repeated if the hot path changes before the tag.
5. **WP-16 with AM-8.** Then G1 to G5 (`ci.yml`), B8 (README, `home.toml`), R9 and R10, T11 to T13 where they wait on the packages, D6, D10, D11 and E12.
6. **Fuzz hours.** F5 complete for every target (about 116 hours at 6 workers, about 58 at 12, net of the benchmark pause), then F6. F7 can land any time after F3.
7. **Release.**
   - X4 and X1 (bump).
   - X2: CI on the bump SHA, `release --dry-run`, and the candidate runs.
   - X3: site live.
   - X5: tag, which the owner confirms.

The longest chain is the DESIGN-12-13 chain (WP-0, WP-1, WP-2 or WP-3, WP-8, WP-10, WP-11, WP-14, WP-16), then G1, X1, X2 and X5. The benchmark session and the fuzz hours sit beside it. They fail the schedule only if:
- the session is not run between WP-11 and X1;
- the campaign's roughly 700 CPU-hours are not under way by line 2.

The NPM_TOKEN created on 2026-10-01 expires about 2026-12-30, so a tag after that date needs a new token (O5).

## Items that need the owner

**O1. The R.2 benchmark gate (P1).** Before B6 and before the tag.
- Choose: the desktop Docker method; tier C waived or scheduled; whether a ratio gates release 1; the Realistic entry definition; then record the go decision.
- Recommended: publish ratios whatever they are, waive tier C for release 1, and amend the Realistic entry to "router and zero-limits defaults".

**O2. The httparse oracle (P2).**
- Choose: a fuzz-only exception to the 12-month rule (recommended) or dropping the criterion.

**O3. Two RULES wordings (P3).**
- The in-crate generator satisfies "proptest tests". The section number may live in the row's URL fragment and note rather than in the test name.
- Recommended: accept both. Otherwise T11 adopts proptest and R12 renames 242 tests.

**O4. Enable private vulnerability reporting.** `SECURITY.md:33-37` names it as the one channel, and `gh api repos/molexxxx/zero-server/private-vulnerability-reporting` returns `{"enabled":false}` (DR G7). This is a repository setting, which sessions do not change (STATUS, out of scope).

**O5. Registry credentials and publishers.**
- Confirm `PIP_TOKEN` is account-scoped, since it must create `zero-server`, `zero-server-core` and `zero-server-native`, or register pending trusted publishers for them.
- Confirm `NPM_TOKEN` covers the eight new npm names and is valid on the tag day.
- Confirm the trusted publishers of `@zero-server/core` and `@zero-server/sdk` name `release-node.yml`.
- Confirm `CRATES_TOKEN` may publish new crates.
- Optional: ask crates.io for a publish-rate override.

**O6. A quiet window on the desktop for B6.** About 8 hours, overnight, with no interactive use. The quiet check also samples Windows' processor time, which a session cannot guarantee.

**O7. Confirm the tag (X5).** Afterwards, optionally, set the repository homepage to the site and add topics.

## In flux during this pass

Read as they stood at 20:00 to 20:40 UTC.
- **Binding-foundation run `wf_15113098-92a`.**
  - WP-0 rows: `docs/standards.toml`, uncommitted.
  - WP-1 plumbing, reviewed and being fixed (`target/wp1-*`, last at 19:59 UTC): `Cargo.toml`, `Cargo.lock`, `deny.toml`, `docs/lints/workspace.toml`, `crates/xtask/src/lints.rs`, `docs/capabilities.toml`, `supply-chain/config.toml`, the `zero-rt`, `zero-bench` and `zero-ffi` manifests, and the untracked `crates/zero-host/`.
- **Fuzz-target agent.**
  - The eight untracked targets with seeds and dictionaries; `fuzz/Cargo.toml` and `fuzz/Cargo.lock`.
  - The triage of the three failures in `target/fzfix` (last write 20:02 UTC).
  - The four root `crash-*` files.
- **Crate-doc pass.** README and source edits in zero-http, zero-io, zero-rt, zero-router, zero-sys (`affinity.rs`, documentation only), zero-http1 (`no_alloc.rs`), zero-bench (`idle.rs`, `lib.rs`, `miss.rs`), and `docs/about/standards.md`.
- **xtask edits.** `crates/xtask/src/catalog.rs` (-111 lines) and `regions.rs`, removing template leftovers.
- **Fuzz campaign.** Container `zero-fuzz` running `qs_parse` since 19:36 UTC (`target/fuzz-campaign/progress.txt`).

## Audit gaps mapped to items

Nothing from the five audits is dropped.

- **roadmap.md** gaps:
  - 1: X1, P5
  - 2: D2
  - 3: D1
  - 4: D4, D5, D7
  - 5: E1, AM-6
  - 6: E2, D7
  - 7: P1
  - 8: AM-8
  - 9: B1 to B8
  - 10: P2, F8
  - 11: F5, F6, F7
  - 12: C1
  - 13: R1
  - 14: T4
  - 15: AM-6
  - 16: X4, B8
  - 17: AM-8, E7, X1
  - 18: P4
  - 19: E10
  - 20: C3
  - 21: O5
  - 22: E5, AM-6
- **roadmap.md** other references:
  - plan text 1 to 6: P5, P4, D8, P1, P5, F7
  - R.2 table: P1, P2, F6, B6
  - R.3 step 1 budgets: WP-16
  - step 8 CPU figure: B6
  - step 10 cap: T15
- **registry.md**:
  - R-01: WP-5, WP-8, WP-9, WP-10, WP-11, WP-13, WP-14
  - R-02: R2
  - R-03: G1
  - R-04: R1
  - R-05: R3
  - R-06: T4, T7, T12, R9
  - R-07: C1, R9
  - R-08: R4
  - R-09: R5
  - R-10: R6
  - R-11: R7
  - R-12: R12, P3
  - R-13: R10
  - R-14: R8
  - R-15: T13
  - R-16: AM-3, R9
  - R-17: P5, R11
- **coverage.md** gaps:
  - 1: T1
  - 2: T2
  - 3: T3
  - 4: T4, G4
  - 5: T5
  - 6: P2, F8
  - 7: F5, F6, F7
  - 8: F4
  - 9: T11, P3, AM-2
  - 10: G3
  - 11: G4, T16
  - 12: G2
  - 13: T6
  - 14: T7, WP-4
  - 15: T8
  - 16: T9, WP-14
  - 17: T10
  - the per-crate lists: T14
- **docs-and-release.md**:
  - G1: D1, D2
  - G2: X1, P4, P5
  - G3: D3, X3
  - G4: E1, AM-6
  - G5: E2, D7
  - G6: AM-1, WP-13
  - G7: O4
  - G8: AM-8, E6
  - G9: D2
  - G10: D1, G5
  - G11: D4, D5, D7, AM-5
  - G12: B8
  - G13: WP-6, WP-11, WP-14, D7
  - G14: AM-8, X1
  - G15: AM-8, D8, B8
  - G16: WP-11, P4, X4, E12
  - G17: D6, D12
  - G18: E5, AM-6, D7
  - G19: E9, O5
  - G20: E10
  - G21: E8
  - G22: AM-1, AM-4
  - G23: O4, O5, O7
  - minor: D8, D10, D11, E11, E12, E13, E14
- **benchmarks.md**:
  - B1: B8
  - B2: B1
  - B3: B2
  - B4: C2
  - B5: B2
  - B6: B5
  - B7: B5
  - B8: B5
  - B9: B3
  - B10: AM-4
  - B11: B4
  - B12: B3
  - B13: B5
  - B14: B5
  - B15: B5
  - B16: B6, B8
  - B17: B3
  - B18: B2, P1
  - B19: B8, P1
  - B20: AM-7
  - B21: B5
  - B22: B7
  - B23: B7
  - B24: B8
  - open decisions 1 to 4: P1; the rest delegated to the defaults BM recommends (STATUS: design decisions are delegated).
- **This pass**:
  - N1: F1
  - N2: F2
  - N3: E3
  - N4: AM-7
  - N5: E1, AM-6
  - N6: E4
