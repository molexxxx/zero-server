# Status

Updated 2026-09-30. A session that changes the position updates this file in
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
- Nothing is implemented yet beyond crate skeletons, `zero-core`'s error
  model and the `zero_version` export. Every crate is at 0.1.0 and nothing is
  published to any registry.
- The repository is `molexxxx/zero-server`; the earlier Node SDK lives in
  `molexxxx/zero-server-node` and is out of scope for sessions working here.
- Brand assets: if `assets/zero-logo-animated.svg` and `docs/brand.md` exist,
  the brand work landed (see `BRAND-REPORT.md`); otherwise `BRAND-BRIEF.md`
  describes what to produce first.
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
- The Node facade keeps the `@zero-server/sdk` name at 2.0; host-language
  handlers are scored against their language's best TechEmpower entry, the
  Rust tier 4 entry against Drogon (`DESIGN.md` section 13).
- The README header is the animated SVG logo; no GIF anywhere; the palette
  has no hue between 170 and 300 degrees (`BRAND-BRIEF.md`).
- The molexcloud-remake application is the final proof of the rebuild,
  after release 3 (`ROADMAP.md` R.8); nothing is done for it before then.
- Dependabot pull requests are left to the owner; a session never merges
  version bumps in bulk (`RULES.md`, Currency).

## In progress

Nothing. The next session starts the item below.

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
3. `zero-sys` and `zero-io` on tokio (R.3 step 4), then `zero-rt` and
   `zero-http` (step 5), the router and the small codecs (step 6), the
   benchmark harness and the thesis measurement (step 7), then steps 8 to 14
   to the release 1 tag.

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
  (cargo-vet 0.10.2, installed with `cargo install --locked --version`).
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
- Docker is not assumed. The container-only checks (the hardened build, the
  sanitizers, miri, the fuzz smoke) run in CI on push; a session reads the
  CI result of its push with `gh run list` and `gh run view --log-failed`
  and fixes what fails before continuing.

## Out of scope for a session

- The Node repository, its releases and its vitest corpus (they transfer in
  release 1 step 13 and later, from here, when the roadmap says so).
- Creating repositories, publishing to any registry, cutting tags, changing
  the license, merging Dependabot pull requests, editing GitHub settings.
- Anything under `.docs/` (an owner-local folder that is not in the clone).
