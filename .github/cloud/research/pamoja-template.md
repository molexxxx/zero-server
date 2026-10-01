# Pamoja project template, extracted for the zero-server Rust core

Source of every claim below: files read from C:\Users\tonyw\Desktop\projects\zero-edge on 2026-09-29 and re-checked 2026-09-30 (git remote https://github.com/molexxxx/pamoja, HEAD a15f537b "Fit a long changelog entry into a GitHub release (#293)", workspace version 0.2.0), plus crates.io and NuGet API fetches and two RFC fetches listed in sections 16 and 17. Where a claim is inferred rather than read, it is marked unverified.

## 1. Repository root layout (read)

Top-level entries of zero-edge:

- Dirs: .cargo, .devcontainer, .docs (gitignored planning), .github, .impeccable, assets, bindings, chirpstack, conformance, crates, docs, examples, profiles, schema, sitl, target, web
- Files: .gitattributes, .gitignore, Cargo.lock, Cargo.toml, CHANGELOG.md, the local rules file, CODE_OF_CONDUCT.md, CONTRIBUTING.md, deny.toml, DESIGN.md, justfile, LICENSE-MIT, PRODUCT.md (gitignored), README.md, rust-toolchain.toml, SECURITY.md

Domain-specific dirs that do not transfer: chirpstack, sitl, profiles, schema, examples/boards, .impeccable, .devcontainer (ROS 2 image), assets (the convention of a repo icon transfers, not the files).

### .cargo/config.toml (40 bytes, copy verbatim)

```
[alias]
xtask = "run --package xtask --"
```

### rust-toolchain.toml (copy verbatim)

```
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

### .gitattributes (copy verbatim)

`* text=auto eol=lf`, plus `binary` for *.png, *.jpg, *.ico, *.node, *.wasm.

### .gitignore (adapt)

Sections: `.docs/` (planning docs never pushed), Rust (`/target/`, `**/target/`, `*.pdb`, `**/mutants.out*/`), Node (`node_modules/`, `dist/`, `*.tsbuildinfo`), Python (`__pycache__/`, `.venv/`, `*.egg-info/`, `wheels/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`), .NET scoped to `bindings/dotnet/**/bin/` and `bindings/dotnet/**/obj/` (comment explains a bare `bin/` would hide a Rust crate's src/bin), native artifacts (`*.o *.a *.so *.dylib *.dll *.node`), editor, coverage, `bindings/dotnet/docs/api/` (DocFX intermediates), and the untracked local files `PRODUCT.md`, `.github/agents`, `.github/hooks`, `.github/skills`. For zero-core: keep everything; drop `PRODUCT.md` and the three `.github/*` lines unless the same local tooling is used. Do NOT add the local rules file or the assistant directory (they are ignored machine-wide via core.excludesFile per the the machine-wide rules).

## 2. Workspace manifest conventions (Cargo.toml, read)

- `[workspace] resolver = "2"`, explicit `members` list (37 crates plus `crates/xtask` and `examples`).
- `exclude = ["bindings/node", "bindings/python", examples/boards/*]` with the comment: "Language bindings are standalone crates with their own toolchains and lint policy; they are built by their own pipelines, not the core workspace."
- `[workspace.package]`: version = "0.2.0", edition = "2021", rust-version = "1.89", license = "MIT", repository, homepage (https://pamoja.molex.cloud), documentation (homepage + /docs/), authors = ["molexxxx"], keywords, categories.
- `[workspace.dependencies]`: internal crates declared as `{ path = "crates/<name>", version = "0.2.0" }` with the comment "The version is required so each crate can be published to crates.io, and is kept in lockstep with workspace.package.version." Only four internal crates are in workspace.dependencies; the ffi crate and the bundle crate declare the rest inline with `path` + `version` + `optional = true`. Crates that need `default-features = false` on the core declare the dependency directly because "default-features cannot be overridden through workspace inheritance" (comment in pamoja-codec, pamoja-security, pamoja-audit Cargo.toml).
- `[workspace.lints.rust] missing_docs = "deny"`, `unsafe_code = "warn"`; `[workspace.lints.clippy] all = "warn"`. Every member carries `[lints] workspace = true`.
- `[profile.release] lto = "thin"`, `codegen-units = 1`.

Crate naming: `<product>-<capability>` (pamoja-core, pamoja-codec, pamoja-security, ...), a bundle crate named exactly `<product>` (crates/pamoja) that re-exports every capability behind a feature named as the crate without its prefix (`security = ["dep:pamoja-security"]`), plus chapter features (`trust = ["audit", "session", ...]`) checked against docs/capabilities.toml, `[package.metadata.docs.rs] all-features = true`; an FFI crate `<product>-ffi`; an unpublished `xtask` (`publish = false`, `name = "xtask"`, not prefixed); an unpublished `<product>-examples` crate at `examples/` holding runnable examples, guide programs, and the conformance generator.

Member manifests inherit with `version.workspace = true`, `edition.workspace = true`, `rust-version.workspace = true`, `license.workspace = true`, `repository.workspace = true`, `homepage.workspace = true`, `documentation.workspace = true`, `keywords.workspace = true`, `categories.workspace = true`, `authors.workspace = true`, plus a per-crate `description`.

no_std convention: `#![cfg_attr(not(feature = "std"), no_std)]` with `default = ["std"]` in the core crate; `#![cfg_attr(not(test), no_std)]` in leaf crates that are always no_std; `#![no_std]` in the allocation-free session crate; `extern crate alloc;` where owned types are needed. CI builds the no_std set with `--no-default-features` on the host and cross-compiles for thumbv7em-none-eabihf, thumbv6m-none-eabi, riscv32imc-unknown-none-elf.

Crate name availability (crates.io API, fetched 2026-09-29): `zero` EXISTS (Nick Cameron's zero-allocation binary parsing crate, 0.1.3, 2022-11-27, 2.7M downloads), so the bundle crate cannot be named `zero`. `zero-core`, `zero-server`, and `zero-ffi` returned HTTP 404 (not registered). Recommended names: `zero-server` as the bundle crate (matches the npm scope @zero-server already in use), `zero-server-core`, `zero-server-http`, `zero-server-ffi` for the members, or the shorter `zero-core` / `zero-ffi` if the owner accepts a prefix that differs from the product name. The CRATE_PREFIX constant in xtask version.rs (`"pamoja-"`) must be set to whichever prefix is chosen.

## 3. Toolchain reality and Docker rule (the local rules file, read)

- Local toolchain is scoop-based and has no rustfmt, clippy, or rustup. Verify with `cargo build` / `cargo test` locally; run fmt and clippy in the official `rust:latest` Docker image:
  - `MSYS_NO_PATHCONV=1 docker run --rm -e CARGO_TARGET_DIR=/tmp/t -v "C:/Users/tonyw/Desktop/projects/<repo>:/work" -w /work rust:latest cargo fmt --all`
  - `... rust:latest bash -c "cargo fmt --all -- --check && cargo clippy -p <crate> --all-targets -- -D warnings"`
- `CARGO_TARGET_DIR=/tmp/t` keeps Linux artifacts out of the Windows `target/`.
- Stock rustfmt, no rustfmt.toml. the local rules file warns that hand-guessing rustfmt output fails because `fn_call_width` (~60 columns) rewraps before `max_width = 100`.
- CI runs `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings`, and the same two over each out-of-workspace binding crate via `--manifest-path`.
- A crate is immutable once on crates.io, so the fmt+clippy job must be green before any publish.

## 4. Rustdoc and comment rules (the local rules file, CONTRIBUTING.md, code, read)

- `missing_docs = "deny"` at the workspace level; every public item documented.
- Public items use rustdoc with `# Arguments`, `# Returns`, and `# Errors` sections. Verbatim from crates/pamoja-codec/src/lib.rs:

```
    /// Encodes a value into a byte buffer.
    ///
    /// # Arguments
    ///
    /// * `value` - the value to serialize.
    ///
    /// # Returns
    ///
    /// A byte buffer containing the encoded representation of `value`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Codec`](pamoja_core::Error::Codec) if the value cannot
    /// be encoded.
    fn encode(&self, value: &T) -> Result<Vec<u8>>;
```

  Argument lines are `* \`name\` - description` with a plain hyphen. `# Errors` names the variant returned. Crate-level `//!` docs open with what the crate is, a bulleted list of the main types, and a runnable `# Examples` doctest.
- Doc comments are the canonical documentation; crate READMEs are generated from lib.rs rustdoc by `cargo xtask docs` (parsed with `syn`, no nightly), marked with `<!-- Generated by \`cargo xtask docs\` from this crate's lib.rs; edit the crate doc, not this file. -->`, and CI fails when stale.
- Module headers `//!` on every file; no inline narration; no "why I did X" comments; reasoning belongs in agent memory.
- No planning vocabulary in code, docs, or commits.
- Standards rule: implement from the authoritative spec; anchor tests to published reference vectors, not round-trips only. Parsers of untrusted input carry `proptest` tests and must never panic on arbitrary bytes.
- Examples and guides never paste byte blobs; values are built with library calls.
- Every change that adds or removes a capability audits `web/home.toml`, README, and the capability and standards pages in the same commit.
- Planning markdown lives in `.docs/` (gitignored).
- Commits: short imperative subject, authored as molexxxx, no AI attribution. PR template asks for what changed, why, how it was tested (naming the reference vector), and a checklist (fmt, clippy, tests, docs regenerated, conformance vector added for anything that decodes).

## 5. justfile (read, adapt)

Recipes: default (list), setup (rustup components), fmt, fmt-check, check, lint (`clippy --workspace --all-targets -- -D warnings`), test, build, nostd (`cargo build --no-default-features -p <each no_std crate>`), dashboard-checks (drop), builds (`cargo xtask builds`, size report), docs-check (`xtask docs --check`, `xtask profiles --check`), site (`xtask site`), site-verify (`xtask site --verify`), guides (runs guide examples in all four languages: `cargo test -p pamoja-examples --test guides`, `npm run test:guides`, `python -m pytest tests/test_guides.py`, `dotnet run --project bindings/dotnet/samples/Pamoja.Guides -c Release`), deny (`cargo deny check`), version-check (`xtask version --check`), ci (fmt-check lint nostd test dashboard-checks docs-check version-check release-plan), bump (`cargo xtask version {{version}}`), release-plan, release, release-dry, broker/broker-stop (Mosquitto in Docker; replace with whatever the server tests need).

## 6. deny.toml (read, adapt)

- `[graph] exclude-dev = true`.
- `[advisories] version = 2`, `yanked = "deny"`, `ignore` list with `{ id, reason }` entries, each justified in a comment.
- `[licenses] version = 2`, allow: MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause, BSD-3-Clause, ISC, Unicode-3.0, Zlib. `exceptions = [{ allow = ["MPL-2.0"], crate = "cbindgen" }]` (build-only tool).
- `[bans] multiple-versions = "warn"`, `wildcards = "warn"`.
- `[sources] unknown-registry = "deny"`, `unknown-git = "deny"`.
- For zero-core: copy with an empty `ignore` list; keep the cbindgen exception.

## 7. The xtask crate (read)

crates/xtask/Cargo.toml: `publish = false`, deps serde, serde_json, flate2, syn 3 (full, parsing, printing, extra-traits), quote, toml_edit 0.25, pulldown-cmark 0.13 (html only), syntect 5.3 (default-syntaxes, regex-fancy), two-face 0.5, oxc 0.150 (minifier, codegen), dev-dep jsonschema 0.57. Note the comment: "the fancy-regex engines keep the build free of C".

main.rs is a plain `match` on the first argument over a `TASKS: &[(&str, &str)]` table printed by `help()`; each task is a module with `pub fn run(&[String]) -> ExitCode`. Modules: builds, buttons, catalog, diagram, docs, examples, footprint, guides, hardware, i18n, licenses, links, packages, prices, profiles, regions, release, schema, site (assets, block, check, highlight, home, layout, markdown, minify, nav, pages, search), standards, theme, version.

Transferable as-is (copy, rename prefix): `release.rs` (publish order from `cargo metadata --no-deps`, `--plan`, `--dry-run` via `cargo publish --workspace --dry-run --allow-dirty --exclude <unpublishable>`, per-crate `cargo publish -p` with skip-if-already-uploaded and a 660 s retry on rate limit, MAX_ATTEMPTS 12, env override `PAMOJA_RELEASE_RETRY_SECS`), `version.rs` (rewrites `[workspace.package].version`, workspace.dependencies, every crate manifest, npm and pyproject manifests, the napi loader's two version sites, CHANGELOG `## [x.y.z]` presence check; CRATE_PREFIX and PROSE_SITES constants change), `regions.rs` (`<!-- table: ... -->` and `<!-- snippet: path#anchor -->` regions closed by `<!-- end -->`, fenced code skipped), `docs.rs` (README generation from lib.rs via syn), `packages.rs` (renders node package.json, tsconfig, README, python pyproject, dotnet csproj from the capability map, deriving dependencies from imports), `catalog.rs` (docs/capabilities.toml loader with checks that every lib crate is claimed exactly once and the node/python/dotnet keys match the real packages), `standards.rs` (docs/standards.toml register with `evidence`/`at`/`anchor` fields, rendered page and `links` URL check), `links.rs`, `licenses.rs`, `theme.rs`, `buttons.rs` (badge SVGs), `builds.rs` (feature-set crate counts via `cargo tree` for a pinned target and built engine sizes), `site/*` (static site generator).

Leave: hardware.rs, prices.rs, profiles.rs, schema.rs, i18n.rs, footprint.rs, diagram.rs (dashboard and hardware catalog specific), the `ros`, `sitl`, `chirpstack`, `dashboard` tasks in main.rs.

## 8. The FFI crate (read)

crates/pamoja-ffi: `crate-type = ["lib", "cdylib", "staticlib"]`; one cargo feature per capability, all default; `runtime = ["dep:tokio"]` shared by the async capabilities (tokio rt-multi-thread, sync, time); every capability crate an optional path+version dependency. `[build-dependencies] cbindgen = { version = "0.29", default-features = false }`.

build.rs: regenerates `include/pamoja.h` with cbindgen on every build, watches every `src/*.rs`, only writes when inside the workspace checkout (`in_workspace_checkout` looks for `[workspace]` two levels up so a registry build never mutates), writes only on change, and treats IO failure as a cargo warning. CI (dotnet.yml) runs `cargo build -p pamoja-ffi --release` and fails on `git diff --exit-code -- crates/pamoja-ffi/include/pamoja.h`.

cbindgen.toml: `language = "C"`, `pragma_once`, `cpp_compat`, `documentation_style = "c99"`, `style = "type"`, header comment about enum values, `autogen_warning`, `[parse] parse_deps = false`, `[enum] prefix_with_name = true`, `[export] item_types = ["constants", "enums", "structs", "opaque", "functions"]`.

lib.rs conventions: `#![allow(unsafe_code)]` with a comment that this is the single auditable unsafe boundary; `#[repr(C)] pub enum PamojaStatus { Ok = 0, Transport, Io, Codec, Closed, Unsupported, InvalidArgument, Other, Panic, Auth }` mapped from core `Error` by `from_error`; thread-local `LAST_ERROR: RefCell<Option<CString>>` with `set_last_error`, `take_last_error`, and exported `pamoja_last_error_message`; opaque heap handles owned by the caller with a matching `*_free`; UTF-8 strings borrowed for the call; panics caught at the boundary and reported as `Panic`; modules are `pub` and `#[cfg(feature = ...)]`-gated. Everything here copies with a rename (`ZeroStatus`, `zero_last_error_message`).

## 9. Bindings (read)

### Node (bindings/node)

- Standalone napi-rs crate at the directory root (excluded from the workspace): `name = "pamoja-node"`, `rust-version = "1.88"` (napi sets it), `publish = false`, `crate-type = ["cdylib"]`, `napi = { version = "3", default-features = false, features = ["napi6", "tokio_rt"] }`, `napi-derive = "3"`, `[build-dependencies] napi-build = "2"`, build.rs is `napi_build::setup();`. One feature per capability mirroring the ffi crate. src/lib.rs exports `version()` and `pub mod` per capability; `checked.rs` provides `Whole<T>` integer types that refuse out-of-range or fractional JavaScript numbers.
- npm workspace `package.json` (private, `workspaces: ["packages/*"]`), scripts: `build` = `build:native` (`napi build --platform --release --package-json-path packages/native/package.json --output-dir packages/native`) then `build:facade` (`tsc -b`); `check:packaging` (scripts/check-packaging.mjs verifies every non-private package's `main` and `types` exist on disk); `test` = `node test.js && node conformance.js && npm run test:guides`. devDeps: @napi-rs/cli ^3.10, @types/node, typescript ^7.
- `tsconfig.base.json`: ES2020, module node16, strict, declaration. Root `tsconfig.json` is a `references` list of every package.
- packages/native (`@pamoja/native`): the generated `index.js` + `index.d.ts` (committed, CI diff-checked), `napi.binaryName = "pamoja-native"`, `napi.targets` = x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-apple-darwin, aarch64-apple-darwin, x86_64-pc-windows-msvc; `npm/<platform>/package.json` per target with `os`, `cpu`, `libc`; `engines.node >= 16`.
- packages/core (`@pamoja/core`): hand-written TypeScript facade over the native contract, `dependencies: { "@pamoja/native": "0.2.0" }` (exact pin), `exports` with `types` before `default`, `files: ["dist/", "LICENSE-MIT"]`.
- packages/<capability>: same shape; package.json, tsconfig.json, README.md generated by `cargo xtask docs`. packages/pamoja: bundle re-exporting everything with exact-pinned deps on every package.
- `docs/` holds a separate typedoc project pinning its own TypeScript 6.0.3 and typedoc 0.28.20 (because the facade builds on TypeScript 7), `entryPointStrategy: "packages"`, output `target/site/docs/reference/node`.
- `guides/<name>.ts` compiled with `tsc -p guides/tsconfig.json` and run by `guides/run.js` one process each from the repo root.

### Python (bindings/python)

- `packages/native`: PyO3 crate `pamoja-python` (`rust-version = "1.74"`, `publish = false`, `crate-type = ["cdylib", "rlib"]`, lib name `pamoja_python`), `pyo3 = { version = "0.29", features = ["abi3-py310"] }`, `pyo3-async-runtimes` (tokio-runtime), `pyo3-stub-gen = "0.23"`, plus a `[[bin]] stub_gen` at `src/stub_gen.rs` (kept out of src/bin so the .NET bin/ ignore rule does not hide it) that writes the committed `python/pamoja/_native/__init__.pyi` (CI diff-checked). pyproject.toml: maturin build backend, `python-source = "python"`, `module-name = "pamoja._native"`, `features = ["pyo3/extension-module"]`, `requires-python >= 3.10`, `license-files = ["LICENSE-MIT"]`. `python/pamoja/raw.py` re-exports `_native` verbatim as the escape hatch.
- Every other package is pure Python with hatchling: `packages/core` (`pamoja-core`, depends `pamoja-native==0.2.0`, `[tool.hatch.build.targets.wheel] packages = ["pamoja"]`), one per capability, and the `pamoja` metapackage (`bypass-selection = true`, exact pins on every distribution). `pamoja` is a PEP 420 namespace package: each distribution ships `pamoja/<name>/` with `py.typed`.
- Tests: `pytest.ini` (`testpaths = tests`), tests/test_smoke.py, test_conformance.py, test_doctests.py, test_guides.py (runs every guides/*.py via runpy from the repo root), test_boards.py.
- Local build: `python -m venv .venv; pip install maturin pytest; maturin develop -m packages/native/Cargo.toml; pip install $(find packages -mindepth 1 -maxdepth 1 -type d ! -name native); python -m pytest`.

### .NET (bindings/dotnet)

- `Pamoja.sln`, `Directory.Build.props`: net8.0, LangVersion latest, Nullable, ImplicitUsings, `AllowUnsafeBlocks` (LibraryImport source generator), `TreatWarningsAsErrors`, `<Version>0.2.0</Version>`, Authors, Product, MIT expression, project and repository URLs, `PackageIcon` from `assets/pamoja-icon.png`, LICENSE-MIT packed beside the expression when present.
- `src/Pamoja.Native`: `Interop/NativeMethods*.cs` partial class with `[LibraryImport("pamoja_ffi")]` declarations mirroring pamoja.h one-to-one; `Interop/PamojaStatus.cs` mirrors the C enum; `NativeHandle.cs` is a `SafeHandle` carrying its release delegate with optional serialization (SemaphoreSlim gate), `Use`, `UseAsync`, `LendAsync`, `Lease`, `Take`; `Status.cs` reads the thread-local last error and `ThrowIfError`; `PamojaException.cs` in the root `Pamoja` namespace; `OwnedString.cs`, `OwnedBuffer.cs`, `FixedWidth.cs`, `NamedValue.cs`. csproj packs `runtimes/**/*.*` at `%(Identity)` so each cdylib lands under `runtimes/<rid>/native/`.
- `src/Pamoja.Core` and `src/Pamoja.<Capability>`: `GenerateDocumentationFile`, `IncludeSymbols` + `snupkg`, `PackageReadmeFile`, ProjectReference to Pamoja.Native (and Pamoja.Core for transports). `src/Pamoja`: metapackage with `IncludeBuildOutput=false`, `NoWarn NU5128`, references every package.
- `tests/Pamoja.Smoke`: console app that copies `target/release/<lib>` and `conformance/vectors.json` next to the executable; `samples/Pamoja.Guides` (`<Name>Guide.cs` with static `Run()`); `docs/docfx.json` (metadata from `src/*/*.csproj`, output `target/site/docs/reference/dotnet`, template `default, modern, templates/pamoja`).

### Three-tier shape shared by all bindings

Contract tier (generated: napi index.d.ts, PyO3 stub, cbindgen header + LibraryImport mirror), core package (engine surface: version, transport, error), one package per capability (hand-written facade, manifest generated from docs/capabilities.toml), domain packages per guide chapter, and a bundle/metapackage. Every registry name follows the crate: `@pamoja/<key>`, `pamoja-<key>`, `Pamoja.<Key>`.

## 10. Conformance vectors (read)

- One committed file `conformance/vectors.json` (437 KB), generated by `cargo run -p pamoja-examples --example conformance_vectors` (examples/conformance_vectors.rs, `#![recursion_limit = "256"]`, one `serde_json::json!` literal per section built with library calls, `hex()` for byte fields).
- Top-level shape: `{ "note": "Generated by ... Do not edit by hand.", "tolerance": 1e-6, "<capability>": { ...section... }, ... }`. Section keys are camelCase capability names (identity, codec, audit, session, telemetry, modbus, can, lora, ...); within a section, camelCase fields hold hex strings for bytes, numbers, strings, nested objects, and arrays of cases. Example section keys: `identity: {seed, publicKey, fingerprint, payload, signature, tamperedPayload}`, `session: {aad, gatewayPublicKey, gatewaySeed, hkdf, hmac, messages, nodePublicKey, nodeSeed}`, `audit: {entries, publicKey, resumed, seed, tampered}`.
- Consumers: bindings/node/conformance.js (require, assert), bindings/python/tests/test_conformance.py (loads `parents[3] / "conformance" / "vectors.json"`, `TOLERANCE = VECTORS["tolerance"]`, `bytes.fromhex`), bindings/dotnet/tests/Pamoja.Smoke (vectors.json copied to output), examples/tests/cross_language.rs (Rust side).
- CI (ci.yml) reruns every example including the generator and fails on `git diff --exit-code -- conformance/vectors.json`.
- Vectors carry f32 widened to f64 so they compare exactly; `tolerance` covers accumulation order.
- For zero-core the same format applies: sections such as `http1Parser`, `router`, `jwt`, `cookies`, `rateLimit` with request bytes as hex and expected parse results, generated from Rust and asserted by all three bindings.

## 11. Workflows (.github/workflows, all read)

Copy with renames (pamoja -> product, crate names, package paths):

- `ci.yml`: `permissions: contents: read`; jobs `rust` (rustup components, cache `~/.cargo/registry`, `~/.cargo/git`, `target` keyed on `hashFiles('**/Cargo.toml')`, fmt, clippy, fmt+clippy of each out-of-workspace binding via `--manifest-path`, no_std build, `cargo test --workspace`, feature-gated jobs, examples run + conformance diff, `xtask docs --check`, `xtask version --check`, `xtask release --plan`), `embedded` (bare-metal cross-compile of every no_std crate for thumbv7em-none-eabihf), `msrv` (reads `rust_version` from `cargo metadata`, installs it, `cargo +<msrv> check --workspace --exclude xtask --exclude <examples>`), `deny` (taiki-e/install-action cargo-deny, `cargo deny check`). Leave: ros-bridge, sitl, chirpstack, dashboard steps, SocketCAN step.
- `node.yml`, `python.yml`, `dotnet.yml`: build the binding, diff-check the generated contract (index.js/index.d.ts; `__init__.pyi` via stub_gen; pamoja.h via `cargo build -p pamoja-ffi --release`), run smoke + conformance + guides. Each starts a Mosquitto container for the MQTT guide; replace with nothing or the server's own test fixture.
- `docs.yml` (pull_request + workflow_call): setup node/python/dotnet, `rm -rf target/site`, `xtask docs --check`, `cargo doc --workspace --no-deps --exclude xtask --exclude <examples>` with `RUSTDOCFLAGS: -D warnings --html-in-header docs/theme/rustdoc.html` after `cargo clean --doc`, copy to `target/site/docs/reference/rust`; typedoc (`bindings/node/docs`, `npm ci`, `npx typedoc`); pdoc 16.0 with `--template-directory docs/theme/pdoc`; docfx 2.78.5; `xtask site`; `xtask site --verify`; upload `site` artifact.
- `pages.yml` (push main): calls docs.yml, `concurrency: group pages, cancel-in-progress false`, `configure-pages@v6`, download `site` artifact into `dist`, `upload-pages-artifact@v5`, `deploy-pages@v5`. Drop the dashboard assembly step.
- `release-preflight.yml` (workflow_call + dispatch): `fetch-depth: 0`, `xtask version --check "${VERSION#v}"`, `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`, and `gh run list --commit "$GITHUB_SHA" --workflow <ci|node|python|dotnet>.yml` must show a completed successful run of each.
- `release-crates.yml` (tag `v*` or dispatch with version): preflight, then `cargo xtask release` with `CARGO_REGISTRY_TOKEN: ${{ secrets.CRATES_TOKEN }}`, `timeout-minutes: 180`.
- `release-node.yml`: preflight; build matrix (ubuntu x86_64, ubuntu aarch64 with `cross: true` and goto-bus-stop/setup-zig 0.13.0, macos-latest x86_64 and aarch64, windows x86_64) running `npm run build:native -- --target <t> [--cross-compile]`, upload `packages/native/*.node`; publish job with `id-token: write`, `npx napi artifacts ...`, `npm run build:facade`, `npm run check:packaging`, `npx napi pre-publish -t npm ...` then `npm publish --workspaces --access public` with `NPM_TOKEN`.
- `release-python.yml`: preflight; wheels matrix via `PyO3/maturin-action@v1` (`manylinux: auto`, `sccache`, aarch64 on `ubuntu-24.04-arm` because ring's ARM assembly does not cross-compile in the manylinux image), sdist job, `pure` job building every non-native package with `python -m build`, publish job with twine through `.github/scripts/pypi-upload.sh dist <version>` (uploads existing projects first, new projects in a rank order, waits out PyPI's new-project cap using the `pypi-reset-seconds` header, `PYPI_WAIT_BUDGET` default 1800). `pypi-backfill.yml` runs hourly to claim what the cap refused.
- `release-nuget.yml`: preflight; native matrix (win-x64, linux-x64, linux-arm64 on ubuntu-24.04-arm, osx-x64, osx-arm64) with `dtolnay/rust-toolchain@stable`, `cargo build -p pamoja-ffi --release --target <t>`, stage under `staging/<rid>/native/<lib>`; publish job assembles `bindings/dotnet/src/Pamoja.Native/runtimes/<rid>/native/`, `dotnet pack Pamoja.sln -c Release -o dist`, `NuGet/login@v1` OIDC trusted publishing (`user: tonywied17`), `dotnet nuget push --skip-duplicate`.
- `release-github.yml`: preflight; extracts the `## [version]` section from CHANGELOG.md with awk, shortens past 100,000 chars, appends generated PR notes from `repos/.../releases/generate-notes`, `gh release create --verify-tag`.
- `codeql.yml`: matrix actions, csharp, javascript-typescript, python, rust, all `build-mode: none`, weekly cron, config `.github/codeql/config.yml` with `paths-ignore: bindings/node/src` (napi glue trips rust/access-invalid-pointer per exported class).
- `labels.yml` (`actions/labeler@v7.0.0`, `pull_request_target`) with `.github/labeler.yml` mapping paths to labels, and `.github/release.yml` grouping release notes by those labels.
- `badges.yml`: on ci completion, `gh api repos/molexxxx/molexxxx/dispatches -f event_type=refresh-badges` with `secrets.GH_TOKEN` (the profile README badge refresh; zero-server already has this).
- `links.yml`, `prices.yml`: hardware catalog specific; leave.
- `dependabot.yml`: cargo at `/`, `/bindings/node`, `/bindings/python/packages/native`; npm at `/bindings/node`; pip at `/bindings/python/packages/native`; nuget at `/bindings/dotnet`; github-actions at `/`; weekly, minor+patch grouped per manifest, commit prefixes cargo/npm/pip/nuget/ci.
- Action versions pinned in the files: actions/checkout@v7, actions/cache@v6, actions/setup-node@v7 (node 20), actions/setup-python@v7 (3.13), actions/setup-dotnet@v6 (8.0.x), actions/upload-artifact@v7, actions/download-artifact@v8, taiki-e/install-action@v2.87.13, github/codeql-action@v4.38.0, PyO3/maturin-action@v1, NuGet/login@v1, goto-bus-stop/setup-zig@v2, dtolnay/rust-toolchain@stable.

## 12. Documentation site (read)

- Hand-written Markdown under `docs/` (README.md, install.md, examples.md, community.md, about/{architecture,building,notices,privacy,releasing,standards,terms,why}.md, guides/<capability>.md, reference/{rust,node,python,dotnet}.md, theme/{rustdoc.html,typedoc.css,pdoc/}) with generated regions: `<!-- table: chapters -->`, `<!-- table: references -->`, `<!-- table: builds -->`, `<!-- snippet: <path>#<anchor> -->`, each closed by `<!-- end -->`; snippet sources are marked `ANCHOR: name` / `ANCHOR_END: name` in test or guide files.
- `docs/capabilities.toml`: `[[chapter]] key/title/intent` and `[[capability]] key/chapter/title/summary/crates/node/python/dotnet/guide/next` (plus optional guides, pages, rust_items, rust_crate). `cargo xtask docs --check` fails when it disagrees with the workspace, the node packages, the python modules, or the .NET types.
- `docs/standards.toml`: `[[group]] chapter/title/intent` and entries with `key/chapter/designation/body/subject/url/evidence/at/anchor` where anchor is one of vector, rule, interop, internal; renders docs/about/standards.md and feeds `xtask links`. This is the direct counterpart of zero-server's docs/STANDARDS.md (148 sources, 515 statements) and is the natural migration target for it.
- `web/home.toml`: `[hero]` (eyebrow, title lines, lead) and `[[scenario]]` entries (key, group, tab, eyebrow, title, body, crates, readings) that drive the front page; `xtask site` refuses a capability that no scenario names. `web/` also holds home.css, site.css, theme.css, reference.css, fonts/, js/{consoles,home,reference,site}.js, assets/{icon,logo}.svg, `.nojekyll`, and `serve.mjs` (local server on 8099 with live reload, `--root target/site`).
- `cargo xtask site` renders into `target/site` (front page at root, pages under /docs, four generated references under /docs/reference/{rust,node,python,dotnet}, hand-off index pages for rust and dotnet), builds nav and search index, highlights code with syntect at build time, minifies with oxc, and checks every link; `--verify` checks the finished tree.
- `.docs/` (gitignored) holds planning markdown, probes, and product-search JSON; nothing there is referenced from the tracked tree.
- CHANGELOG.md follows Keep a Changelog 1.1.0 with `## [Unreleased]` and `## [x.y.z] - YYYY-MM-DD`; `xtask version --check` requires the entry.

## 13. Files to copy verbatim

- `.cargo/config.toml`
- `rust-toolchain.toml`
- `.gitattributes`
- `LICENSE-MIT` (year and name unchanged: molexxxx)
- `CODE_OF_CONDUCT.md` (Contributor Covenant; not read in full, assumed stock, unverified)
- `.github/PULL_REQUEST_TEMPLATE.md` (change `cargo xtask docs` wording only if the task names differ)
- `.github/workflows/release-preflight.yml`, `release-crates.yml`, `release-github.yml` (title prefix "pamoja" becomes the product), `labels.yml`, `codeql.yml`
- `.github/scripts/pypi-upload.sh` and `pypi-upload.py` (rank table changes to the new package names)
- `.github/workflows/pypi-backfill.yml` (package name `pamoja-native` becomes the new native name)
- `crates/xtask/src/release.rs`, `regions.rs`, `licenses.rs`, `links.rs` (repo constant), `site/*` (product strings)
- `crates/pamoja-ffi/build.rs` (header name), `cbindgen.toml` (header comment text)
- `bindings/node/build.rs`, `tsconfig.base.json`, `scripts/check-packaging.mjs`, `guides/run.js`
- `bindings/python/pytest.ini`, `tests/test_guides.py`, `packages/native/src/stub_gen.rs`, `python/<pkg>/raw.py`
- `bindings/dotnet/src/Pamoja.Native/{NativeHandle,Status,PamojaException,OwnedString,OwnedBuffer}.cs` (rename the Pamoja identifiers)
- `web/serve.mjs`, `docs/theme/rustdoc.html` (generated by xtask theme; regenerate rather than copy)

## 14. Files to adapt, with the change

- `Cargo.toml`: member list, exclude list, package metadata (name, keywords, categories: `web-programming::http-server`, `network-programming`, `asynchronous`, `no-std`), workspace.dependencies names and version.
- `the local rules file`: keep stack, commands, Docker fmt/clippy rule, conventions verbatim; replace crate names and the IoT-specific rules (bytes-in-guides rule stays; hardware-specific text goes).
- `justfile`: drop dashboard-checks, broker recipes; nostd list becomes the new no_std crates; `ci` recipe = fmt-check lint nostd test docs-check version-check release-plan.
- `deny.toml`: empty ignore list.
- `.gitignore`: drop PRODUCT.md and the .github/agents|hooks|skills lines unless kept.
- `crates/xtask/src/main.rs`: TASKS table reduced to release, version, builds, docs, site, links, minify; drop ros/sitl/chirpstack/dashboard.
- `crates/xtask/src/version.rs`: `CRATE_PREFIX`, `PROSE_SITES`; `docs.rs`: `bindings()` map of crate to registry ids and the badge URL base; `catalog.rs`: `SITE` constant; `packages.rs`: `REPOSITORY`; `standards.rs`: `REPO`; `buttons.rs`/`theme.rs`: palette.
- `crates/<product>-ffi/Cargo.toml` and `src/lib.rs`: feature list, status enum name, error mapping, exported function prefix.
- `bindings/node/Cargo.toml` and `package.json`, `packages/native/package.json` (binaryName, targets), `packages/core`, `packages/<bundle>`, `docs/typedoc.json` (name, out).
- `bindings/python/packages/native/{Cargo.toml,pyproject.toml}` (module-name, names), `packages/core/pyproject.toml`, metapackage.
- `bindings/dotnet/Directory.Build.props` (Product, Version, icon path), `<Product>.sln`, `Pamoja.Native.csproj` (PackageId, Library const in NativeMethods), smoke csproj (native lib names `zero_ffi.dll`, `libzero_ffi.so`, `libzero_ffi.dylib`, unverified until the crate name is fixed), docfx.json (`_appName`, output).
- `.github/workflows/ci.yml`: remove hardware jobs; keep rust, embedded (target list reduced to what the server core claims), msrv, deny; conformance step runs the new generator.
- `.github/workflows/{node,python,dotnet}.yml`: remove the Mosquitto step.
- `.github/workflows/docs.yml`, `pages.yml`: remove the dashboard step; keep the rest.
- `.github/workflows/release-{node,python,nuget}.yml`: paths, package names, `user:` on NuGet/login (the trusted publishing policy is per package owner and must be created on nuget.org for the new package ids; unverified until done).
- `.github/dependabot.yml`, `labeler.yml`, `release.yml`, `ISSUE_TEMPLATE/*`, `codeql/config.yml`: paths and URLs.
- `CONTRIBUTING.md`, `SECURITY.md`, `README.md`, `CHANGELOG.md` (start at `## [Unreleased]`), `docs/*`, `web/home.toml`: rewritten for the server product.

## 15. Pamoja crates the server core could depend on or share

Evaluated from each crate's Cargo.toml and lib.rs.

- `pamoja-core` (traits Device, Sensor, Actuator, Telemetry, Transport, Receive, Store, EventBus, Map; `Error` enum with Transport/Io/Codec/Closed/Auth/Unsupported; `Result`; no_std with `std` feature; zero dependencies). Recommendation: LEAVE. The traits are device-shaped. COPY only the shape of `error.rs` (`#[non_exhaustive]` enum with String payloads, `Display`, `std::error::Error` behind `std`, `Result<T>` alias) and the `#![cfg_attr(not(feature = "std"), no_std)]` + `extern crate alloc` pattern into the new core crate, with server variants (Protocol, Io, Codec, Closed, Auth, Unsupported, Timeout, Limit).
- `pamoja-codec` (`Codec<T>` trait with `encode`/`decode` returning `Result<Vec<u8>>`/`Result<T>`; CborCodec via ciborium, JsonCodec via serde_json, BytesCodec, delta/quantizer packers; no_std + alloc). Recommendation: COPY the trait (six lines) into the server core rather than depend, because depending on it drags `pamoja-core::Error` as the error type and ties the server's release cadence to pamoja's. The CBOR/JSON impls are serde-based and add nothing a server needs beyond serde_json.
- `pamoja-security` (ed25519 DeviceIdentity/PublicIdentity/Signature over ed25519-dalek 3, no_std). Recommendation: LEAVE. A server needs Ed25519 for JWT EdDSA, which is a direct `ed25519-dalek` dependency; the pamoja wrapper adds a device-identity vocabulary and the pamoja-core error type.
- `pamoja-session` (X25519 RFC 7748, HKDF-SHA256 RFC 5869, ChaCha20-Poly1305 RFC 8439, HMAC-SHA256, counter nonces, anti-replay window; `#![no_std]`, allocation-free, no pamoja-core dependency, tests pinned to RFC vectors). Recommendation: SHARE as a dependency only if the server core needs a lightweight secured channel outside TLS (for example signed cookies via `hmac_sha256`, or an encrypted session store); otherwise LEAVE and use `hmac`/`sha2`/`hkdf` directly, which is what pamoja-session itself wraps. It is the one pamoja crate with no pamoja-core coupling, so sharing is cheap.
- `pamoja-audit` (hash-chained, ed25519-signed log entries; depends on pamoja-core and pamoja-security). Recommendation: LEAVE for the core; the ORM audit feature in zero-server is a database write log, not a signed chain. Revisit as an optional `zero-audit` crate later; if built, COPY the chain design rather than depend, to avoid the pamoja-core error type.
- `pamoja-telemetry` (allocation-free Event/Level/Reporter/LinkCost/Snapshot; no dependencies; no_std). Recommendation: LEAVE. Server observability needs metrics, tracing spans, and structured logs with allocation; the metered-link degradation model is device-specific.
- `xtask` modules listed in section 7: COPY (not a crate dependency; xtask is `publish = false`).
- `pamoja-ffi`, `bindings/*` scaffolding: COPY the shape (section 8 and 9).

## 16. Verification pass (2026-09-30, continuation after the interrupted run)

Re-checked against the working tree at HEAD a15f537b (unchanged since the first pass) and fresh fetches.

- crates.io API (fetched 2026-09-30): `zero-server`, `zero-server-core`, `zero-server-http`, `zero-server-ffi` all return HTTP 404 (not registered). Control fetch of `zero` in the same session returned the crate (0.1.3, created 2016-01-16, 2,795,498 downloads, "zero-allocation parsing of binary data"), so the 404s are genuine absences, not an API block. The earlier note listing `zero` as 2022-11-27 was its latest publish date; the crate was created 2016-01-16.
- NuGet flat container (fetched 2026-09-30): `zeroserver.core` returns HTTP 404; control fetch of `newtonsoft.json` returned 89 versions. So the id `ZeroServer.Core` is free. `Zero.*` ids were not probed. The trusted-publishing policy on nuget.org still has to be created per package id before `NuGet/login@v1` OIDC will work; that remains a setup step, not a research question.
- CODE_OF_CONDUCT.md (read): opens "# Contributor Covenant 3.0 Code of Conduct" with the standard pledge text; treat as stock Contributor Covenant 3.0 and copy verbatim.
- Smoke csproj (read, bindings/dotnet/tests/Pamoja.Smoke/Pamoja.Smoke.csproj): `PamojaNativeName` is `pamoja_ffi.dll` on Windows, `libpamoja_ffi.so` on Linux, `libpamoja_ffi.dylib` on macOS; `NativeMethods.cs` has `private const string Library = "pamoja_ffi";`. The cdylib basename is the crate name with hyphens replaced by underscores, so a crate named `zero-server-ffi` yields `zero_server_ffi.dll` / `libzero_server_ffi.so` / `libzero_server_ffi.dylib` and `Library = "zero_server_ffi"` (the hyphen-to-underscore rule is observed from pamoja-ffi's output, not fetched from cargo docs).
- Cargo.toml (grep): `resolver = "2"`, `rust-version = "1.89"`, `missing_docs = "deny"`, `unsafe_code = "warn"`, `lto = "thin"`, `codegen-units = 1` confirmed at the stated positions.
- pamoja-ffi/src/lib.rs (grep): `#![allow(unsafe_code)]` at line 51, `pub enum PamojaStatus` with `Ok = 0` at 182-184, thread-local `LAST_ERROR: RefCell<Option<CString>>` at 230, exported `pamoja_last_error_message` at 263. Confirmed.
- conformance/vectors.json (grep): the `note` key is at line 13419 and `tolerance: 1e-6` at line 16357, which corrects section 10: keys are emitted in sorted order (first key is `actuators`), so `note` and `tolerance` sit alphabetically among the sections rather than at the top. Consumers read them by key, so ordering does not matter.
- Workflow list (dir listing): badges, ci, codeql, docs, dotnet, labels, links, node, pages, prices, pypi-backfill, python, release-crates, release-github, release-node, release-nuget, release-preflight, release-python. Matches section 11.
- Crate list (dir listing): 37 crates under crates/ (pamoja bundle, 35 capability crates, xtask). Matches section 2.

Still unverified: the exact napi-rs, PyO3, maturin, cbindgen versions to pin for a new project (the numbers above are what pamoja pins today, read from its manifests); availability of `Zero.*` NuGet ids and of the `zero-server` name on PyPI.

## 17. Where HTTP/3 fits in this template (owner asked for a head start)

Sources fetched 2026-09-30: RFC 9114 (HTTP/3, Standards Track, June 2022) maps HTTP semantics over QUIC and cites stream multiplexing, per-stream flow control, and low-latency connection establishment as the reasons; it uses QPACK (RFC 9204) instead of HPACK because QUIC does not guarantee in-order delivery between streams. RFC 9000 (QUIC, Standards Track, May 2021) defines the transport, encapsulates one or more QUIC packets in a single UDP datagram, and delegates the TLS handshake to RFC 9001 and loss detection and congestion control to RFC 9002.

Template consequences, all derived from the pamoja conventions above rather than from any HTTP/3 implementation (which is a separate research topic):

- Crate naming: HTTP/3 lands as its own capability crate (`<prefix>-h3`, with QPACK either inside it or as `<prefix>-qpack`) following the one-crate-per-capability rule, re-exported from the bundle crate behind an `h3` feature, and claimed exactly once in `docs/capabilities.toml` so `xtask docs --check` passes. The QUIC transport (RFC 9000/9001/9002) is a fourth crate or an external dependency; that choice belongs to the runtime and TLS research files, not this one.
- Conformance vectors: QPACK static-table lookups, Huffman decoding, and HTTP/3 frame parsing are byte-in, structure-out functions, which is exactly the vector shape section 10 describes (hex request bytes, expected parse result). Add `qpack` and `h3Frames` sections to the generator so all three bindings assert them. Prefer published test vectors where the RFC provides them (RFC 9204 Appendix examples are worked encodings; whether they are complete enough to serve as vectors is unverified until that RFC is read).
- no_std split: frame and QPACK parsing has no OS dependency and belongs in the `--no-default-features` build set and the `embedded` CI job; UDP sockets, timers, and TLS keys stay behind `std`. This is the same `#![cfg_attr(not(feature = "std"), no_std)]` + `extern crate alloc` pattern the core crate uses.
- Standards register: each RFC (9000, 9001, 9002, 9114, 9204) becomes a `docs/standards.toml` entry with `evidence`, `at`, and `anchor = "vector"` or `"rule"`, and a `web/home.toml` scenario must name the capability or `xtask site` refuses the build.
- Feature-gated CI job: pamoja's ci.yml already runs per-feature jobs; HTTP/3 gets one so `cargo test -p <prefix>-h3` runs without pulling the QUIC runtime into the default test matrix.
