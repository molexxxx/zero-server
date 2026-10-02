# Release 1: documentation, packaging and release readiness

Audit of 2026-10-02, read-only. Two trees were measured:

- **HEAD** `e13e631` (the committed state), exported with `git archive` to a scratch directory and
  built in the `zero-server-lint` image (rustc and cargo 1.99.0, 2026-09-28), so the committed
  state is told apart from the files other work is changing.
- **Working tree**, which other packages are editing now: `Cargo.toml`, `Cargo.lock`,
  `crates/zero-host/` (new, untracked), `crates/zero-rt`, `crates/zero-http`, `crates/zero-io`,
  `crates/zero-ffi/Cargo.toml`, `docs/standards.toml` (27 new release 1 rows),
  `docs/capabilities.toml`, `docs/about/standards.md`, `fuzz/` (8 new targets with seeds and
  dictionaries) and several crate READMEs. Anything read from those files is marked "in flux".

Work that `.github/cloud/work/step12/DESIGN-12-13.md` delivers (section 14 work packages, with the owner
decisions in `.github/cloud/work/BRIEF.md`) is counted as **planned**, after checking the design
names the file and the change. Where the design does not reach a file that its own decisions
change, the gap is listed as **not covered**.

## Verdict

A `v2.0.0-alpha.1` tag pushed today publishes nothing: every release workflow stops in
`release-preflight` at the version check. That is the safe failure. Once the version is bumped,
the preflight still blocks on `docs --check` (ten missing guides and two bundle features) and on
`standards --check`, which passes only after DESIGN-12-13 lands. The crates themselves are
ready to package. All 27 committed publishable crates pass `cargo publish --workspace
--dry-run` with no warning, both at 0.1.0 and at 2.0.0-alpha.1 with exact sibling requirements,
and every crates.io name is free.

The serious problems sit around the crates:

- No documentation site exists. Every crate README's first link 404s, and a published README
  cannot be changed.
- The seven-target native builds for npm, PyPI and NuGet have never run.
- The release workflows publish independently of one another, so one late failure leaves a
  partial, irreversible release.
- SECURITY.md describes controls that do not exist, and its only reporting channel is switched
  off on the repository.
- The benchmark publication the owner asked for has no page, no charts and no README section.

## What was run today

| Check | HEAD `e13e631` | Working tree (in flux) |
| --- | --- | --- |
| `cargo xtask docs --check` | **exit 1**: 10 capabilities without a guide; bundle feature `http` does not turn on 8 crates of the http chapter; no `http3` feature | **exit 1**, same 12 problems |
| `cargo xtask packages --check` | exit 0 (prints the docs task's message, "docs: the crate READMEs and the generated regions are in sync") | exit 0 |
| `cargo xtask version --check` | exit 0, "every manifest, lockfile, and generated file is at 0.1.0" | exit 0 |
| `cargo xtask version --check 2.0.0-alpha.1` | **exit 1**: "Cargo.toml: workspace.package.version is 0.1.0, expected 2.0.0-alpha.1" | not run |
| `cargo xtask standards --check` | **exit 1** at the first broken row: `runtime-01` cites `bindings/node/test/lifecycle.test.js`, which does not exist | **exit 1** at `routing-29` (`fn patch_is_a_recognized_method_that_is_neither_safe_nor_idempotent` not in `method.rs`) |
| Release 1 rows without their cited test (my own scan of every row, since the check stops at the first) | 2 of 252 (`runtime-01`, `runtime-07`) | 29 of 279: the 27 new DESIGN-12-13 rows plus those two, all **planned** (WP-5, 8, 9, 10, 11, 13, 14) |
| `cargo xtask lints --check` | exit 0, 33 crates | exit 0, 34 crates |
| `cargo xtask release --plan` | 27 crates | 28 crates (`zero-host` added) |
| `cargo xtask site --out ...` | **exit 1**: "reading web/js/consoles.js: No such file or directory" | same files missing |
| `cargo package --workspace --no-verify` (27 crates) | exit 0, no warning, `.crate` sizes 8.5 KB to 60.4 KB | not run (zero-host in flux) |
| `cargo publish --workspace --dry-run` (what `cargo xtask release --dry-run` runs) | **exit 0**: 27 packaged, 27 verified, no warning | not run |
| Same dry run with every version set to `2.0.0-alpha.1` and exact `=2.0.0-alpha.1` sibling requirements (scratch copy, after `cargo update --workspace`) | **exit 0**: 27 packaged and verified at 2.0.0-alpha.1, no warning | |
| `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` (what docs.yml runs) | **exit 101** at the first crate: `encode` is both a function and a module, `crates/zero-sse/src/lib.rs:3` (same line in the working tree). Without `-D warnings`: 11 warnings in 6 crates (zero-io 1, zero-json 2, zero-policy 3, zero-rt 2, zero-sse 1, zero-tls 2) | |
| docs.rs-style build: `cargo +nightly doc -p zero-server --all-features --no-deps` with `--cfg docsrs -D warnings` | exit 0 | |
| `cargo test --doc` over the 27 crates | exit 0; 19 doctests in total, and 16 crates have none | |
| `cargo check -p zero-server --no-default-features --features <f>` for every bundle feature alone, for `tls,http`, for `io-compio`, and with none | all 27 exit 0 | |
| GitHub: docs.yml | the last 4 runs (2026-10-01) failed: "error reading `docs/theme/rustdoc.html`: No such file or directory" | |
| GitHub: pypi-backfill.yml | 6 of 6 scheduled runs failed (latest 2026-10-02 15:47): "pathspec 'v' did not match any file(s) known to git" | |
| GitHub: release-crates, -node, -python, -nuget, -github | **no run has ever happened** | |
| GitHub: private vulnerability reporting | **`{"enabled":false}`** (`gh api repos/molexxxx/zero-server/private-vulnerability-reporting`) | |
| Site `https://molexxxx.github.io/zero-server/` | HTTP 404 | |

The scripts are `target/r1-docs-audit*.sh` and the logs are under `target/r1-docs-audit-logs/`.

## Gaps, most severe first

Each gap lists what is missing, the evidence, why it matters for the release, and what would
close it. The planned or not covered status refers to DESIGN-12-13 and the BRIEF.

### Blockers: the tag fails, or publishes something wrong and permanent

**G1. `docs --check` fails, so the preflight blocks.** Not covered.

- *What is missing:* the ten capability guides, and the bundle crate's chapter features (G9, G10).
- *Evidence:* the table above, and `.github/workflows/release-preflight.yml:74-75`.
- *Why it matters:* every release workflow calls the preflight and stops there.
- *What closes it:* G9 and G10.

**G2. The tree is not at the release version.** Planned in `.github/cloud/work/readme-at-release.md` and
STATUS. Not part of DESIGN-12-13.

- *What is missing:* the bump to 2.0.0-alpha.1.
- *Evidence:* `Cargo.toml` `workspace.package.version = "0.1.0"`; `CHANGELOG.md:8` reads
  `## [0.1.0] - Unreleased`. `release-github.yml:54-63` extracts `## [<version>]` and fails when
  that entry is missing.
- *Why it matters:* the preflight blocks until it is done.
- *What closes it:* run `cargo xtask version 2.0.0-alpha.1` (it also runs `cargo update
  --workspace` and `npm install --package-lock-only`, so it needs Node), rename the CHANGELOG
  heading, and commit those alone, as STATUS asks. The plan text disagrees and should be put
  right: ROADMAP R.3 step 14 says "tag `v0.1.0`", and DESIGN-12-13 section 13 item 14 says "no
  `2.0.0-alpha.1` publish" and its section 15 question 4 says "crates at 0.1.0". The owner
  decisions of 2026-10-02 (one version, 2.0.0-alpha.1, on all four registries) supersede all
  three, and WP-16's ROADMAP amendments should say so.

**G3. A crate README cannot be corrected once published, and today every one opens with dead
links.** Not covered.

- *What is missing:* a deployed documentation site.
- *Evidence:*
  - `crates/xtask/src/docs.rs:131-137` puts
    `https://molexxxx.github.io/zero-server/docs/reference/rust/<crate>/index.html` first in
    every crate README.
  - The "same capability in every language" table also links `.../docs/reference/rust.html#...`.
  - The site returns 404, and `pages.yml` has one failed run.
  - The issue template config links `.../docs/` and `.../docs/about/building.html`.
- *Why it matters:* crates.io renders the README packaged with each version, and that README
  never changes for that version. Publishing 28 crates now bakes 404 links into their pages
  permanently.
- *What closes it:* either deploy the site before the crates.io publish (G11), or have the
  generator point "API reference" at `https://docs.rs/<crate>/<version>` until the site is live.
  The second option is one change in `docs.rs:131-142` and the `cross_language` table renderer.

**G4. The seven-target release builds have never run, and the five release workflows publish
independently.** Not covered (WP-14 asks for a dispatch run of release-node that "builds the
seven targets and publishes nothing", which the workflows cannot do today).

- *Evidence:*
  - `gh run list` shows no run of `release-crates`, `release-node`, `release-python`,
    `release-nuget` or `release-github`.
  - `release-node.yml` publishes whenever the gate passes. `release-python.yml` and
    `release-nuget.yml` publish whenever their builds pass. None has a dry-run input.
  - The Python and .NET CI jobs build only `x86_64-unknown-linux-gnu`.
  - `release-preflight.yml` does not run `cargo xtask release --dry-run`, although ROADMAP R.3
    step 14 makes "`cargo xtask release --dry-run` green" an exit criterion.
- *Why it matters:* the first time the aws-lc-sys cross builds run is the irreversible tag. That
  covers zig for both musl targets and aarch64-gnu under `napi --cross-compile`, NASM on
  Windows, and macOS x86-64 cross-built on Apple Silicon. The tag starts five workflows in
  parallel, so a NuGet native build failing on `aarch64-unknown-linux-musl` does not stop
  crates.io, which by then has published crates it can never take back. The maturin sdist build
  is not exercised anywhere before the tag either (unverified that it packs the `zero-ffi` path
  dependency).
- *What closes it:*
  - Add a `dry_run: boolean` input to each release workflow that runs every build and packaging
    step and skips each upload: `npm pack` for every package, `twine check` on the wheels and
    sdists, `dotnet pack` with the seven runtimes asserted present.
  - Run that on the release commit before tagging.
  - Add `cargo publish --workspace --dry-run` to the preflight.
  - Prefer one release workflow whose publish jobs all `needs:` every build job, so nothing
    uploads until every artifact of every registry exists.

**G5. The .NET floor and the SDK the workflows install disagree.** Not covered.

- *Evidence:*
  - The BRIEF (line 24) accepts DESIGN-12-13's floor `net10.0`, and WP-12 owns
    `bindings/dotnet/**` and `dotnet.yml`.
  - `release-nuget.yml:127` and `docs.yml:36` still install `dotnet-version: "8.0.x"`, and no
    package owns those two files.
  - Today `bindings/dotnet/Directory.Build.props` targets `net8.0`.
  - .NET 8 support ends November 10, 2026 (dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core,
    read 2026-10-02).
- *Why it matters:* `dotnet pack` of a `net10.0` project with the 8.0 SDK fails, so the NuGet
  release fails after crates.io and PyPI have published (G4). Staying on `net8.0` instead ships
  a package whose runtime leaves support five weeks after the release.
- *What closes it:* give WP-12 (or WP-16) `release-nuget.yml` and `docs.yml`, set
  `dotnet-version: "10.0.x"`, and record the page and date beside the value.

**G6. The Python floor cannot be changed where WP-13 is allowed to change it.** Not covered.

- *Evidence:*
  - The BRIEF accepts `>=3.11` with `abi3-py311`.
  - Every `pyproject.toml` is generated, and `requires-python = ">=3.10"` is hard-coded in
    `crates/xtask/src/packages.rs:959`.
  - WP-6 changes `packages.rs` only for `engines` (line 443). WP-13 owns `bindings/python/**`,
    but may not hand-edit generated files.
  - `bindings/python/packages/native/Cargo.toml` uses `abi3-py310`.
  - Python 3.10 reached end of life on 2026-10-01 (devguide.python.org/versions, read
    2026-10-02).
- *Why it matters:* without the change, the release publishes wheels and metadata that invite
  an interpreter that is already out of support.
- *What closes it:* add the `requires-python` change to WP-6 (or let WP-13 own that line of
  `packages.rs`), run `cargo xtask packages`, and switch the PyO3 feature to `abi3-py311` in
  WP-13.

**G7. The only vulnerability reporting channel is switched off.** Not covered. This needs an
owner action in the repository settings, which a session cannot take.

- *Evidence:*
  - `SECURITY.md:33-37` names GitHub's "Report a vulnerability" button as the one channel, and
    `.github/ISSUE_TEMPLATE/config.yml` links `/security/advisories/new`.
  - The repository reports `private-vulnerability-reporting: {"enabled": false}`, so that link
    leads nowhere.
- *Why it matters:* the first public release of a network-facing parser would have no working
  private report path.
- *What closes it:* the owner enables private vulnerability reporting under Settings, Code
  security. An email fallback in SECURITY.md is optional.

**G8. SECURITY.md states controls that do not exist.** Partly planned.

- *Evidence:*
  - `SECURITY.md:76-79` says every shipped library is built with `cargo auditable` and each
    release carries a CycloneDX SBOM and a build attestation. No workflow contains
    `auditable`, `cyclonedx`, `sbom` or `attest` (grep over `.github/`).
  - `SECURITY.md:88-90` says `cargo geiger` produces the inventory "on each release" and "every
    table is empty until its first block lands". Yet `crates/zero-simd` has 37 `unsafe`
    sites and `crates/zero-sys` 36 (32 `// SAFETY:` comments; grep of `unsafe {`, `unsafe fn`
    and `unsafe impl`), and both tables are empty.
  - `SECURITY.md:101-104` names "ring under the alternate provider feature" for
    zero-server-crypto. The crate has no such feature; its only provider is aws-lc-rs
    (`crates/zero-server-crypto/Cargo.toml`).
  - `SECURITY.md:157-162` requires a named reviewer "through the CODEOWNERS rule", and there is
    no CODEOWNERS file.
  - `docs/about/standards.md` (in flux) also points readers at "their inventory".
- *Why it matters:* a security policy that claims SBOMs, attestations and an audited inventory
  that are not there is a false public statement, and RULES says "Public text describes only
  what exists". ROADMAP step 14 requires "cargo-geiger inventory in SECURITY.md" as an exit
  criterion.
- *What closes it:*
  - WP-16 already writes the zero-ffi, bindings/node and .NET inventories and CODEOWNERS
    (planned).
  - Not covered: the zero-simd and zero-sys tables, removing the ring sentence, and either
    adding the release steps or deleting the sentence. The release steps are `cargo auditable
    build` for the cdylib, the napi addon and the wheels, a CycloneDX SBOM with
    `cargo cyclonedx`, and `actions/attest-build-provenance` on the artifacts. Fetch each
    tool's version on the day it is adopted.

### Required for "completely finished, nothing missing"

**G9. The ten capability guides.** Not covered (STATUS lists them as open, and no DESIGN-12-13
package owns `docs/guides/`).

*What a guide is, per the generators:*
- A page `docs/guides/<key>.md` and a `guide = "guides/<key>.md"` line on the capability in
  `docs/capabilities.toml`.
- The site folds a run of `## Rust`, `## TypeScript`, `## Python`, `## C#` sections into tabs
  (`crates/xtask/src/site/pages.rs:18-23`).
- Examples are spliced from files CI runs (`<!-- snippet: path#anchor -->` regions,
  `crates/xtask/src/regions.rs`): Rust under `crates/zero-examples/examples/guides/<key>.rs`,
  which the ci.yml examples step already runs (the directory does not exist yet), and
  TypeScript under `bindings/node/guides/<key>.ts`, which `npm run guides` runs.
- Every guide's `next` keys must point at capabilities that also have guides
  (`catalog.rs:584-590`).

*What each one needs:*
- **The Python and C# sections.** The Python and C# facades ship in release 2
  (`[packages] python = 2`, `dotnet = 2`), so at release 1 these sections can only say so
  plainly.
- **The TypeScript sections.** These follow WP-11's facade.
- **What every guide covers.** Per the product principles in STATUS: why the capability exists,
  the specification sections it follows (from `docs/standards.toml`), the trade-off, and a
  runnable example.

| Guide | Crates | Rust example to write | TypeScript (WP-11 surface) | Must cover |
| --- | --- | --- | --- | --- |
| `http1` | zero-http-types, zero-date, zero-http1, zero-http | `serve` with a `Handler` (the `hello` example is the seed) | `createApp`, `listen` | refusing ambiguous framing (400, 501, 505 with close), pipelining order, `Expect: 100-continue`, the `zero-limits` table and its timeouts, problem details errors, 16 + 19 rows of RFC 9110 and 9112 |
| `router` | zero-router, zero-uri, zero-qs | the `users` example (path parameter) plus a mount and a wildcard | `app.get('/users/:id')`, `Router()` | 404, 405 with `Allow`, 501, automatic HEAD and OPTIONS, trailing slash, percent-decoding failures, PATCH (WP-5), query-string caps |
| `codecs` | zero-json, zero-base64, zero-mime | the JSON `Writer` and strict parse with caps; base64 round trip; `negotiate` over `Accept` | `res.json`, `req.accepts` | depth and size caps, duplicate names, RFC 8259 rows, RFC 4648, media-type parsing |
| `static` | zero-static | a static route; also the `zero serve` binary | `static(dir)` as tier 0, `res.sendFile` | path policy per segment, dotfiles, symlinks, validators and 304, ranges, Cache-Control, the ordering rule of DESIGN-12-13 8.11 |
| `policy` | zero-policy | CORS, security headers, request id, trust proxy, body limits | `cors`, `helmet`, `requestId` | Fetch Metadata, preflight rules, the 2.0.0 behavior changes (8.12) |
| `websocket` | zero-ws, zero-realtime | an echo server and a room broadcast | `app.ws`, `WebSocketPool` | handshake, close codes, UTF-8 across fragments, cross-core rooms, RFC 6455 rows |
| `sse` | zero-sse | an event stream with keep-alive | `res.sse` | `Last-Event-ID`, retry, NUL refusal in `id`, the HTML Standard rows |
| `tls` | zero-tls, zero-server-crypto | `zero_server::tls::serve` with `Identities` | `listen({ tls })` | SNI with atomic reload, tickets, ALPN, handshake timeout and cap, 421, `zero serve --cert` |
| `qpack` | zero-qpack | encode and decode a field section with the static table | none: say so | that the HTTP/3 transport does not exist yet (release 3), that the codec is `no_std`, and the RFC 9204 Appendix B vectors |
| `h3` | zero-h3 | frame and settings round trip, GOAWAY, a capsule | none: say so | the same honesty about the transport; varints; stream types; RFC 9297 |

**G10. The bundle's chapter features.** Not covered.

- *Evidence:*
  - The rule is in `crates/xtask/src/catalog.rs:1333-1450`: a feature per capability crate,
    named by stripping `zero-`, and a feature per chapter of two or more capabilities, named by
    the chapter key.
  - The crate `zero-http` and the chapter `http` both map to the feature `http`.
    `crates/zero-server/Cargo.toml:65` defines `http` as the driver alone, so the chapter check
    fails on zero-date, zero-uri, zero-qs, zero-json, zero-base64, zero-mime, zero-static and
    zero-policy.
  - The `http3` chapter (qpack and h3) has no feature.
  - `realtime` has the same collision but passes, because zero-realtime already turns on ws and
    sse.
- *Why it matters:* the preflight blocks (G1). Whichever meaning `http` takes is also a public
  API decision. The README quick start (`features = ["http"]`, README.md:51-56), the
  `cargo xtask builds` table ("HTTP/1.1 over the runtime seam ... 19 crates") and every user who
  copies them depend on it, and a published feature name cannot be withdrawn.
- *What closes it:* pick one option and record it in the bundle's crate doc.
  - Rename the zero-http crate feature, for example `server`, through an exception in
    `bundle_feature` the way `static` re-exports as `files`. `http` then becomes the chapter.
  - Or rename the chapter key.
  - Then add `http3 = ["qpack", "h3"]`, update README.md, `builds.rs` and the re-export doc, and
    regenerate. Also add a CI step that runs `cargo check -p zero-server --no-default-features
    --features <f>` for each feature and each `builds` row. Every one compiles today on HEAD
    (measured), but nothing keeps it so.

**G11. The documentation site and its workflow are not buildable.** Not covered.

*Evidence for docs.yml:*
- It fails at the Rust reference: `docs/theme/rustdoc.html` is missing.
- It then needs files that do not exist: `bindings/node/docs/` (typedoc project), `docs/theme/pdoc/`
  and `bindings/dotnet/docs/docfx.json`.
- `cargo doc -D warnings` also fails, on 11 rustdoc warnings in HEAD (measured,
  `target/r1-docs-audit-logs/rustdoc/workspace-warnings.txt`), and some may already be fixed
  by the rustdoc cleanup in flux:
  - three ambiguous links: `encode` in `zero-sse/src/lib.rs:3`, `parse` in
    `zero-json/src/lib.rs:6`, and `contain` in `zero-rt/src/lib.rs:9`;
  - three unresolved links: `compio_rt` in `zero-io/src/lib.rs:40`, `Event::Panic` in
    `zero-rt/src/worker.rs:5`, and `Value` in `zero-json/src/lib.rs:7`;
  - two public docs linking the private `Outbox`, in `zero-tls/src/buffered.rs:6` and
    `unbuffered.rs:6`;
  - three bare URLs in `zero-policy`: `fetch_metadata.rs:16` and `:17`, and
    `request_id.rs:14`.
- docs.yml still sets `node-version: 20`, which is EOL (G13).

*Evidence for `cargo xtask site`:*
- It reads, and then fails on, eight front-end files that were never committed
  (`git log --diff-filter=D -- web/` is empty): `web/site.css`, `web/home.css`,
  `web/reference.css`, `web/js/site.js`, `web/js/home.js`, `web/js/consoles.js`,
  `web/js/reference.js` and `web/.nojekyll`. It also reads the `web/fonts/` directory
  (`site/assets.rs:12-32`).
- `site/home.rs:328` accepts only scenario groups `"field"` and `"robotics"` (leftover from the
  generator's previous project), while `web/home.toml` uses `"server"` and `"bindings"`, so all
  four scenarios fail the check.
- `site/nav.rs:46-101` requires pages that do not exist: `docs/index.md`, `install.md`,
  `examples.md`, `community.md`, `reference/{index,rust,node,python,dotnet}.md`, and
  `about/{why,architecture,building,privacy,terms,notices}.md`.
- `docs/brand.md` is not in the navigation, so `pages::load` refuses it.
- `QUICKSTARTS` (`site/home.rs:143-155`) reads `examples/guides/quickstart.rs`. That is a root
  path that does not exist, since the examples live in `crates/zero-examples`. It also reads
  `bindings/python/guides/quickstart.py` and
  `bindings/dotnet/samples/ZeroServer.Guides/Quickstart.cs`, which cannot serve a request before
  release 2.
- `site/layout.rs:418` keeps `THEME_COLOR = "#0f5f56"` (hue about 173 degrees, inside the band
  the brand excludes), and `site/home.rs:843-874` and `site/check.rs:139-141` still carry the
  dashboard.

*Why it matters:* G3, plus the owner's bar. The issue templates, the crate READMEs and the README
all point at pages that do not exist.

*What closes it:*
- Write the web front end and the nav pages.
- Make the quickstart and the language sections release-aware, the way `docs --check` already
  is, so Python and C# show "ships in release 2" instead of failing.
- Fix the group names and remove the dashboard and old palette leftovers.
- Add the docs theme files and the typedoc, pdoc and docfx configurations, and fix the rustdoc
  warnings.
- Then switch `pages.yml` from `workflow_dispatch` to the release.

**G12. Benchmark publication.** Not covered (the harness belongs to `benchmarks.md`; this is the
documentation side).

- *What is missing:* no `BENCHMARKS.md`, no `bench/results/`, no chart generator (no script or
  zero-bench code writes an SVG chart), no README section, and no site page or nav entry.
  `docs/about/benchmarking.md`, which `.github/cloud/RULES.md` names, does not exist.
- *Why it matters:* the owner's bar is a benchmark page with charts per language group and a
  short README overview, under the method in RULES.md (Conventions). That method requires the
  raw data and the command that reproduces each figure in the repository.
- *What closes it:*
  - Create `bench/results/<date>/` with the raw runs and the command line.
  - Write a generator for the per-language SVG bar charts in the brand palette, with ratios
    beside absolute numbers, in light and dark like `scripts/architecture.py`.
  - Write `BENCHMARKS.md` with the method, the hardware ("one desktop under WSL2" per the
    decision in STATUS), the entries and how each was configured, plus a matching site page.
  - Add a short README section linking it, with no figure that is not in the committed run.
  - Fix `web/home.toml [backing]` (G15).

**G13. Node toolchain and engines.** Mostly planned.

- *Evidence:*
  - `release-node.yml:94` builds on Node 20; so do `node.yml:24` and `docs.yml:28`.
  - Every package declares `"engines": {"node": ">= 16"}` (`crates/xtask/src/packages.rs:443`).
  - Node v20 is listed as EOL (nodejs.org/en/about/previous-releases, read 2026-10-02: v20
    "EOL", v22 and v24 "LTS", v26 "Current").
- *What closes it:* WP-6 and WP-11 set `>=22`, and WP-14 moves node.yml to 22, 24 and 26 and
  release-node to 24 (planned). Not covered: `docs.yml:28`.

**G14. CHANGELOG.md is incomplete.** Partly planned: WP-16 adds the 2.0.0 behavior changes.

*Shipped and committed, but absent from `CHANGELOG.md:8-46`:*
- The `zero` binary (`zero serve` over HTTP/1.1 or HTTPS with a graceful drain; d02b4e6).
- The zero-http1 parser, chunked codec and validating serializer (only the zero-http driver is
  listed).
- zero-core's types (Error, Codec, OwnedBuf, SlotId, Value, the primitive traits).
- The zero-limits table.
- zero-http-types.
- The zero-simd kernels (SWAR, SSE2 and AVX2, NEON, the streaming UTF-8 validator).
- The zero-sys wrappers (socket options, control messages, affinity, random bytes, stop
  signals, the FIFO-safe open).
- HTTP-date parsing.
- The Node, Python and .NET packages and what they contain at this release.
- `conformance/vectors.json`.
- The fuzz targets.
- The `no_std` and bare-metal builds.

*To come with DESIGN-12-13:* zero-host, the zero-ffi C ABI and header, the Node facade, PATCH,
and the batch dispatcher.

*Also:* the heading must become `## [2.0.0-alpha.1] - <date>` (G2), and Keep a Changelog's
version link references at the foot are missing.

*What closes it:* one pass over `git log` against the entry, grouped as Added and Security,
written in the same commit as the bump.

**G15. Public text claims what does not exist.** Planned as WP-16's "capability audit" of
`web/home.toml` and README.md, but the specific items are not listed there.

*In `web/home.toml`:*
- The tier rungs present tier 1 (cache), tier 2 (data) and tier 4 (native plugin), plus "rate
  limits" in tier 0, as available. Those are release 2 and 3.
- `[backing]` says figures need "a rented Linux host, or two bare-metal instances" and "a win
  required in every run". That contradicts the owner's decided method: the owner's 9950X3D in
  Docker, with ratios published whatever they are.
- "Ten thousand open connections" is an unmeasured claim.
- The hero says every language is "reached ... through one C ABI". DESIGN-12-13 8.1 puts the
  Node binding on zero-host, not the C exports. STATUS also asks for the bindings diagram label
  to be checked.
- The `host` scenario shows "the same handler in TypeScript, Python and C#".
- The track item "the Node binding ..." is `next` and must flip to `ships`.
- zero-host is absent from the engine track.

*In README.md:*
- "Nothing is published" and the git dependency (planned in at-release.md).
- No TypeScript example (planned, at-release R5).
- No benchmark overview (G12, not covered).
- The quick start is a hand copy of `crates/zero-examples/examples/hello.rs`, not a
  `<!-- snippet: -->` region, so CI does not hold it to the file.

*In the crate READMEs:* "The TypeScript, Python and C# packages of this capability ship in a
later release" appears in every capability README, for example `crates/zero-static/README.md`.
At release 1, `@zero-server/sdk` does serve `static`, `cors`, `ws` and `sse` from TypeScript.
`Catalog::cross_language` should name the sdk entry point once the sdk publishes.

**G16. The sdk publish decision is not yet reflected, and its files belong to three
packages.** Planned by the BRIEF ("the package that builds the facade removes
`"private": true` and updates `packages.rs`, `docs/about/releasing.md` and SECURITY.md").

- *Evidence:*
  - The sdk `package.json` has `"private": true`.
  - `packages.rs:314` derives `private` from `catalog.packages_ship("node")`, which is release
    3, so a hand edit is overwritten by the generator.
  - `docs.rs:81-101` omits the npm button for the bundle crate.
  - `releasing.md:104-106` says the sdk "stays private ... until its facade reaches parity".
  - `bindings/node/packages/sdk/README.md` says the same.
  - `at-release.md:315-319` predates the decision and says the sdk README needs nothing.
- *Why it matters:* WP-11 owns neither `packages.rs` (WP-6) nor SECURITY.md (WP-16), and no
  package owns `releasing.md`. The change can fall between them.
- *What closes it:*
  - Name one owner.
  - Make `private` and the npm button follow a sdk-specific rule instead of `[packages] node = 3`.
  - Add the sdk install line (`npm install @zero-server/sdk@next`) to the at-release text.
  - Add "trusted publisher for `@zero-server/sdk`" to the owner checklist in `releasing.md`
    (it already lists `@zero-server/core`).

**G17. Crate rustdoc and READMEs as a Rust user meets them.** Partly in flux.

- 16 of 27 crates have no runnable example in their docs (measured with `cargo test --doc`):
  zero-base64, zero-ffi, zero-http, zero-io, zero-json, zero-mime, zero-policy, zero-qs,
  zero-realtime, zero-router, zero-rt, zero-sse, zero-static, zero-tls, zero-uri and zero-ws.
  CONTRIBUTING.md:97-100 says doc comments "carry runnable examples", and the product
  principles ask for a runnable example on every page.
- The bundle crate's generated README (`crates/zero-server/README.md`, 22 lines) has no feature
  table and no server example. It is the crate `cargo add zero-server` users land on. The
  `table: builds` region and the hello example could both be spliced into its crate doc.
- The committed tree cites the gitignored `DESIGN.md` 28 times in crate sources and in the
  READMEs of zero-io, zero-http, zero-rt and zero-router. In the working tree this is down to
  two `Cargo.toml` comments (zero-io:26, zero-rt:23), which still ship inside `Cargo.toml.orig`
  in the `.crate`. This is in flux and being fixed.
- *What closes it:* doc examples per crate, and the bundle crate doc rewritten around its
  features.

### Should fix before the tag

**G18. The release path uses unmaintained and unpinned tools.** Not covered.

- *Unmaintained action:* `goto-bus-stop/setup-zig@v2` in `release-node.yml:102` and
  `release-nuget.yml:82`. Its README says "This GitHub Action is unmaintained. Please use
  mlugg/setup-zig instead", and its last release is v2.2.1 of 2024-09-28 (both read with
  `gh api` on 2026-10-02). The pinned zig is 0.13.0 while zig's newest tag is 0.15.2.
- *Unpinned installs:*
  - `pip install cargo-zigbuild` (`release-nuget.yml:88`)
  - `pip install build` and `twine` (`release-python.yml:122,166`, `pypi-backfill.yml:177,223`)
  - `pip install maturin pytest` (`python.yml:32`) and `maturin` (`docs.yml:88`)
- *Lockfiles not enforced:*
  - `npm install` instead of `npm ci` (`release-node.yml:115,155`, `node.yml:27`; WP-14 fixes
    node.yml only).
  - `cargo build` without `--locked` in `release-nuget.yml:99`.
- *Why it matters:* RULES (Currency and Testing) requires pinned versions and builds from the
  committed lockfiles, and the release is the build that matters most.
- *What closes it:* move to `mlugg/setup-zig` at a fetched tag, pin every pip and cargo tool at
  its registry version with the date in a comment, and use `npm ci` and `--locked` everywhere
  in the release path.

**G19. The crates.io publish timing.**

- *Evidence:* crates.io allows a burst of 5 new crates, then 1 every 10 minutes
  (`rust-lang/crates.io` `src/rate_limiter.rs`: `PublishNew => 10 * 60` and burst `5`, read
  2026-10-02).
- *The arithmetic:* 28 new crates need at least 230 minutes of waiting, plus a verify build per
  crate, against `timeout-minutes: 300`. The comment at `release-crates.yml:31` still says 27.
- *What closes it:*
  - Update the comment.
  - Measure one crate's publish-and-verify time from the dry run (the full dry run took
    minutes, not hours).
  - Either ask the crates.io team for a temporary publish-rate override for the account (the
    limiter reads a per-user override table) or accept a rerun. A rerun skips what is already
    published, as `docs/about/releasing.md` says.

**G20. pypi-backfill fails every hour until the first tag.**

- *Evidence:* `pypi-backfill.yml:54-56` takes the newest `v*` tag; with none, it runs
  `git checkout "v"`, as the 6 failed scheduled runs show. It is scheduled for every hour
  (`cron: "17 * * * *"`).
- *What closes it:* exit 0 with a notice when no tag exists.

**G21. Crate keywords and categories are the same for all 28 crates.**

- *Evidence:* the workspace sets `keywords = ["http", "server", "no-std", "async", "web"]` and
  the categories `web-programming::http-server`, `network-programming`, `asynchronous` and
  `no-std` for every crate.
- *What is wrong with that:*
  - 12 crates are std-only: zero-sys, zero-io, zero-rt, zero-http, zero-static, zero-policy,
    zero-realtime, zero-server-crypto, zero-tls, zero-host, zero-ffi and zero-server. They still
    claim `no-std`, which crates.io defines as "able to function without the Rust standard
    library" (crates.io API, read 2026-10-02).
  - The 16 synchronous codecs claim `asynchronous`.
  - zero-base64, zero-json and zero-date claim `web-programming::http-server`.
- *Why it matters:* this metadata is fixed for each published version.
- *What closes it:* set keywords and categories per crate, for example zero-json
  `["json", "parser", "no-std"]` with `encoding`, `parser-implementations` and `no-std`; and
  zero-sys `os` and `network-programming`. All of these slugs were checked against the crates.io
  API.
- *Everything else in the crates.io metadata is complete:*
  - `description`, `license`, `repository`, `rust-version` and `authors` are set on every
    publishable crate.
  - Each has its own README.md and LICENSE.
  - With no `readme` field, Cargo uses README.md.
  - With no `documentation` field, crates.io links docs.rs
    (doc.rust-lang.org/cargo/reference/manifest.html, read 2026-10-02).
  - `homepage` is unset, which is right until the site exists.
  - All 29 names (the 28 crates and `zero-serve`) return 404 on the crates.io API today, so all
    are free.

**G22. Python and npm package metadata.** Partly planned.

- *Python* (generated by `packages.rs`, not covered):
  - `license = { text = "Apache-2.0" }` is the table form that PEP 639 deprecated in favor of an
    SPDX string, and the `License ::` classifiers are deprecated as well
    (packaging.python.org/en/latest/specifications/pyproject-toml/, read 2026-10-02).
  - `zero-server-native` lists the keyword `asgi`, although there is no ASGI support.
  - The three PyPI names (`zero-server`, `zero-server-core`, `zero-server-native`) are free.
- *npm:*
  - `@zero-server/native` and its seven platform manifests carry `"homepage": "https://z-server.dev"`,
    a dead address. WP-11 owns those files, so this is planned if WP-11 regenerates them.
  - `@zero-server/native` and the platform names are free.
  - `@zero-server/sdk` and `@zero-server/core` exist with `latest` 1.1.0 (registry.npmjs.org,
    read 2026-10-02).
- *NuGet:* `ZeroServer`, `ZeroServer.Core` and `ZeroServer.Native` are free.

**G23. Owner actions before the tag.** These need the owner and are not repository changes.

- Enable private vulnerability reporting (G7).
- Add `release-node.yml` as the trusted publisher of `@zero-server/core` and `@zero-server/sdk`.
- Confirm that `NPM_TOKEN` (created 2026-10-01, 90 days) is still valid for the eight new npm
  names.
- Confirm `CRATES_TOKEN` and `PIP_TOKEN`. PyPI creates three new projects, under its
  four-a-day cap.
- Confirm the NuGet trusted publishing policy (STATUS lists it as configured).
- Optionally request the crates.io rate override (G19).
- Set the repository homepage to the site once it is live (the repository has no homepage or
  topics today).

### Minor

- `cargo xtask packages --check` prints "docs: the crate READMEs and the generated regions are
  in sync". It reuses `docs::verify_files` (`packages.rs:95`), so the message names the wrong
  task.
- Leftovers from the generator's previous project:
  - xtask test fixtures still use `mqtt` (`release.rs:277`), `zero-lorawan` (`standards.rs:557`),
    `modbus`, `boards/pi.md` and `farm` (`catalog.rs`, `home.rs` tests).
  - `crates/zero-ffi/build.rs` says "zero-core workspace".
  - DESIGN-12-13 mentions `cargo xtask packages --write`, but the task has no `--write` flag
    (it writes whenever `--check` is absent).
- `zero-tls` packages `tests/fixtures/*.key` (test-only private keys) in its `.crate`, because
  `tests/driver.rs` needs them. Generating them at test time would keep secret scanners quiet.
- `release-preflight.yml` sets only `contents: read` and calls `gh run list`. Whether that works
  without `actions: read` is unverified, because the workflow has never run. Adding
  `actions: read` costs nothing.
- `release-python.yml` publishes with the long-lived `PIP_TOKEN`, while npm and NuGet use OIDC.
  PyPI trusted publishing is the consistent choice (not fetched today; unverified whether a
  pending publisher fits the three new names).
- `bindings/node/README.md` and `bindings/python/README.md` do not exist. The docs generator
  lists them as region files and skips them.
- CONTRIBUTING.md has no section on building and testing the three bindings (Node 24 or the new
  floor, maturin, the .NET SDK) or on `just guides`, and its "runnable examples" sentence is not
  yet true (G17).
- `cargo xtask release --dry-run` uses `cargo publish --workspace`, which Cargo first supports in
  1.90 (blog.rust-lang.org Rust 1.90.0 announcement, read 2026-10-02). The workspace declares
  `rust-version = "1.89"`, so `docs/about/releasing.md` should state the toolchain the release
  tooling needs.

## What a `v2.0.0-alpha.1` tag does, per registry

**Today**, the tag starts five workflows (`release-crates`, `release-node`, `release-python`,
`release-nuget`, `release-github`). Each calls `release-preflight`, whose first step fails at
`version --check 2.0.0-alpha.1`. Nothing builds or publishes.

**After the bump and with G1 and the DESIGN-12-13 rows green**, each workflow passes the
preflight once ci, node, python and dotnet have succeeded on the tagged commit. Then:

| Registry | What it does | What would fail or go wrong today |
| --- | --- | --- |
| crates.io | `cargo xtask release` publishes 28 crates in dependency order with `CRATES_TOKEN`, waiting out the rate limit and skipping versions already published | Packaging and verification pass at 0.1.0 and at 2.0.0-alpha.1 with exact sibling requirements, for the 27 committed crates (measured). zero-host is not yet measured. The dead links of G3 are baked in, and so is the metadata of G21. Without a preflight dry run, a verify failure on crate N leaves crates 1 to N-1 published. The job runs about 230 minutes at minimum (G19). |
| npm | The gate publishes for major 2 under `next`. It builds 7 addons on Node 20 with `npm install` and cross-builds the Linux targets with `goto-bus-stop/setup-zig` and zig 0.13.0. It then publishes `@zero-server/native` (new, needs `NPM_TOKEN`), its 7 platform packages (new) and `@zero-server/core` (OIDC trusted publishing, if configured for this repository). `@zero-server/sdk` is skipped as private | The cross builds have never run (G4). The sdk is not published, against the owner decision (G16). The engines are `>= 16` (G13). The new names get `latest` on their first publish, which `releasing.md` accepts. |
| PyPI | Wheels for 7 targets (abi3-py310), one sdist, and the pure `zero-server-core` and `zero-server` packages, uploaded with `PIP_TOKEN` in dependency order. Three new projects fit the cap | The native wheel matrix and the sdist have never run (G4). `requires-python >=3.10` is EOL (G6). Unpinned build tools (G18). |
| NuGet | Builds `zero_ffi` for 7 RIDs (zig for musl), packs `ZeroServer`, `ZeroServer.Core` and `ZeroServer.Native` with SDK 8.0.x, then pushes through the NuGet OIDC login | The builds have never run (G4). Moving to net10.0 breaks the pack (G5). The `cargo build` is not `--locked` (G18). |
| GitHub | Extracts `## [2.0.0-alpha.1]` from CHANGELOG.md, appends the generated pull request list, and creates the release with `--prerelease=true` | It fails if the heading is not renamed (G2). The notes are incomplete (G14). |

The five run in parallel, so any single failure after crates.io starts leaves a partial release
(G4).

## In flux at the time of this audit

These files were read as they stood and may already have changed:

- `Cargo.toml` and `Cargo.lock` (zero-host member).
- `crates/zero-host/**` (untracked).
- `crates/zero-ffi/Cargo.toml` (now forwards zero-host features with `tls` on by default).
- `crates/zero-rt`, `crates/zero-http`, `crates/zero-io` and `crates/zero-router` (rustdoc
  cleanup of DESIGN.md references).
- `docs/standards.toml` (27 new release 1 rows: routing-29 to 32, realtime-34 to 39, ffi-01 to
  08, runtime-21 to 29).
- `docs/capabilities.toml` (17 changed lines).
- `docs/about/standards.md` (lists the 8 new fuzz targets).
- `fuzz/` (base64_decode, cors_fields, forwarded_parse, mime_parse, sse_decode, tls_hello,
  ws_frames and ws_session, untracked).
- `deny.toml` and `supply-chain/config.toml`.

The working tree's `docs --check` fails exactly as HEAD's does. Its `standards --check` fails
only on rows the design delivers.

## Facts fetched for this audit (2026-10-02)

- Cargo manifest reference: the `readme` default, docs.rs as the default documentation link,
  keyword and category limits, `description` required.
  https://doc.rust-lang.org/cargo/reference/manifest.html
- crates.io names: 29 names, all HTTP 404; categories `web-programming::http-server`,
  `network-programming`, `asynchronous`, `no-std`, `no-std::no-alloc`, `encoding`,
  `parser-implementations`, `cryptography`, `os`, `api-bindings`, `development-tools::ffi`,
  `web-programming::websocket` and `command-line-utilities` exist.
  https://crates.io/api/v1/crates/<name>, https://crates.io/api/v1/categories/<slug>
- crates.io rate limits: new crates burst 5, refill 600 s; new versions burst 30, refill 60 s.
  https://github.com/rust-lang/crates.io/blob/main/src/rate_limiter.rs (last changed
  2026-09-15)
- npm: `@zero-server/sdk` and `@zero-server/core` `latest` 1.1.0, maintainer molex222;
  `@zero-server/native` and the platform names 404. https://registry.npmjs.org/<name>
- PyPI: the three names 404. https://pypi.org/pypi/<name>/json
- NuGet: `zeroserver`, `zeroserver.core` and `zeroserver.native` 404.
  https://api.nuget.org/v3-flatcontainer/<id>/index.json
- Node release lines: v20 "EOL", v22 and v24 "LTS", v26 "Current".
  https://nodejs.org/en/about/previous-releases
- Python: 3.10 end of life 2026-10-01; 3.11 security until 2027-10.
  https://devguide.python.org/versions/
- .NET: 8 and 9 end support 2026-11-10; 10 LTS until 2028-11-14.
  https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core
- pyproject `license`: the table form is deprecated by PEP 639; `License ::` classifiers are
  deprecated. https://packaging.python.org/en/latest/specifications/pyproject-toml/
- `cargo publish --workspace` first supported in Rust 1.90.0.
  https://blog.rust-lang.org/2025/09/18/Rust-1.90.0/
- GitHub Actions in use: checkout v7.0.1, setup-node v7.0.0, setup-python v7.0.0,
  setup-dotnet v6.0.0, cache v6.1.0, upload-artifact v7.0.1, download-artifact v8.0.1,
  configure-pages v6.0.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1, labeler v7.0.0
  (all current; none archived); taiki-e/install-action newest v2.87.22 (pinned v2.87.13);
  goto-bus-stop/setup-zig v2.2.1 of 2024-09-28 and marked unmaintained; mlugg/setup-zig v2.2.1
  of 2026-01-19; zig newest tag 0.15.2. Read with `gh api repos/<owner>/<repo>/releases/latest`.
- Repository: public, `has_pages` true, no homepage, no topics, private vulnerability reporting
  off. `gh api repos/molexxxx/zero-server`
- The site: https://molexxxx.github.io/zero-server/ returns 404.
- Unverified: whether a GITHUB_TOKEN limited to `contents: read` can call `gh run list` in the
  preflight. The REST page says "Anyone with read access to the repository can use this
  endpoint", but does not settle the token scope.
  https://docs.github.com/en/rest/actions/workflow-runs
