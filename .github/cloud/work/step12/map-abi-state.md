# Map: current C ABI and binding state, and what steps 12 and 13 change

Read on 2026-10-01 at `zero-core` HEAD e41a22b (clean tree at the start of the read). During the
read another session modified `.github/workflows/ci.yml` (adds a `concurrency` group and
`timeout-minutes: 90` on `miri`) and `crates/zero-tls/tests/driver.rs`; neither touches the ABI
or the bindings, and this map was not affected. Nothing in the repository was edited by this
reader. xtask was built into a task-unique target dir under `scratchpad/step12/target-abi-map`
and run with `--check` only.

Latest CI on e41a22b: node.yml, python.yml, dotnet.yml green; ci.yml in progress; docs.yml
failing on every run since at least ce268da.

## 1. crates/zero-ffi today

- `src/lib.rs`: one export, `zero_version() -> *const c_char`, `#[allow(unsafe_code)]` on the
  item (for `#[no_mangle]`), body under `panic::catch_unwind`, null on panic. One unit test
  reads it back with `CStr::from_ptr` under a `// SAFETY:` comment. The crate doc already states
  the conventions step 12 must honor: catch_unwind at every export, opaque caller-owned handles
  with matching `*_free`, UTF-8 borrowed inputs, and "an enum the caller passes in must hold a
  declared value, each binding refuses one before the call".
- Nothing else exists: no `ZeroStatus`, no thread-local last error, no owned string or buffer
  handles, no lifecycle, routes, accessors, batch descriptor, completion, ws, sse, rooms,
  plugin vtable, no `ZERO_ABI_VERSION`. The `Cargo.toml` description already promises
  "ZeroStatus, the thread-local last error, and catch_unwind at every export".
- `Cargo.toml`: `crate-type = ["lib", "cdylib", "staticlib"]`; deps `zero-core`, `zero-http`
  (unused today); build-dep `cbindgen = { version = "0.29", default-features = false }`; no
  `[features]` at all, although ci.yml runs `cargo check -p zero-ffi --no-default-features`
  under a comment that says "the C ABI crate builds with every capability off". The `[lints]`
  block is a verbatim copy of `docs/lints/audited.toml` (unsafe_code deny, missing_docs deny,
  unsafe_op_in_unsafe_fn deny, clippy all warn priority -1, mem_forget,
  undocumented_unsafe_blocks, multiple_unsafe_ops_per_block deny). `docs/capabilities.toml` row:
  `lint = "audited"`, `no_std = false`, `release = 1`, and zero-ffi is the `[engine] abi`.
- `build.rs` (pamoja copy): watches every `src/*.rs` and `cbindgen.toml`; regenerates only when
  the grandparent dir holds a `[workspace]` manifest (never from a registry checkout); writes
  `include/zero.h` only when bytes differ; a cbindgen failure or write failure is a
  `cargo:warning`, not an error. It calls `.expect("read cbindgen.toml")`, so the file must ship
  in the published crate (it does by default).
- `cbindgen.toml`: `language = "C"`, `pragma_once`, `cpp_compat`, `documentation_style = "c99"`
  (rustdoc becomes `//` comments, `# Returns` headings included), `style = "type"`,
  `[parse] parse_deps = false` (every ABI type must be declared inside zero-ffi; nothing from
  zero-core or zero-rt can appear in a signature), `[enum] prefix_with_name = true` (variants
  render as `ZeroStatus_Ok`), `[export] item_types = ["constants", "enums", "structs",
  "opaque", "functions"]`. "typedefs" is not listed, so a `pub type ZeroDispatchFn =
  extern "C" fn(..)` would not be emitted; cbindgen's docs list the accepted values as
  "constants", "globals", "enums", "structs", "unions", "typedefs", "opaque", "functions"
  (fetched from the v0.29.2 tag docs.md, 2026-10-01).
- `include/zero.h`: 32 lines, the header comment, `#pragma once`, the four standard includes,
  `extern "C"` guards, and `const char *zero_version(void);`.

What enforces it today:
- dotnet.yml: `cargo build -p zero-ffi --release`, then `git diff --exit-code --
  crates/zero-ffi/include/zero.h` (the only header drift check).
- ci.yml `rust`: fmt, clippy, `lints --check` (the copied table), `cargo check -p zero-ffi
  --no-default-features`, `cargo test --workspace`.
- ci.yml `miri`: `cargo +nightly miri test -p zero-ffi` (strict provenance, many seeds).
- ci.yml `sanitizers`: ASan and TSan with `-Zbuild-std` over `-p zero-rt -p zero-ffi`; a second
  step runs `cargo test -p zero-rt -- --include-ignored slot_recycle`. No test name in zero-rt
  contains `slot_recycle` (grep), so that step runs zero tests and passes vacuously today.
- ci.yml `reproducible`: two container builds of `libzero_ffi.so` in
  `rust:1.89-bookworm@sha256:948f...`, `cmp` must match.
- ci.yml `hardened`: readelf PIE, RELRO, BIND_NOW, NX on `libzero_ffi.so`; nightly
  `-Zstack-protector=all -Zsanitizer=cfi -Clto -Ccodegen-units=1` cdylib-only build of zero-ffi.
- No loom job exists anywhere.

## 2. zero-rt pieces step 12 builds on (for the FFI side)

- `slot.rs`: `SlotWord` over `std::sync::atomic::AtomicU64` (bits 0-2 state, 3-18 readers,
  19 cancel, 20-49 generation), `SlotState {Free, Parsing, WorkerOwned, Leased, Completing,
  Closed}`, `borrow(generation) -> Borrow` (CAS that checks generation and `Leased`, counts a
  reader, `Drop` counts out), `complete`, `cancel`, `close`, `recycle` (refused while readers),
  `MAX_READERS`. `SlotWord::new` is a `const fn`; loom's atomics are not const-constructible, so a
  `cfg(loom)` swap needs a non-const constructor under loom.
- `arena.rs`: `Arena<T: Reset>` with `Vec<Box<[Entry<T>]>>` chunks, `Entry { word, value:
  UnsafeCell<T> }`, `allocate`, `get_mut(&mut self)`, `word(&self)`, `free(&mut self)` (pushes the
  index straight back on the free list). Only the worker reaches it (`&mut self`); there is no
  API a host thread can use to reach a leased slot's record, the chunk directory is a growing
  `Vec` (not shareable across threads while the worker grows it), and `Entry` is not `Sync`.
  The module doc says "the audited FFI crate reaches a leased slot through the word's borrow
  protocol instead", which step 12 must make real: a fixed-capacity, thread-shareable chunk
  directory (stable addresses, set-once chunks), and an accessor path where the only
  `UnsafeCell` dereference happens in zero-ffi under a live `Borrow`.
- No epoch: no per-worker completion epoch, no quarantine of freed indexes, no host target
  registry with acknowledged epochs.
- No batch dispatcher, no 4-in-flight bound, no 16-queued bound, no 503 rule.
- `zero-http` does not use the arena or slot words at all yet: its records are "boxed and pooled
  per core and move by pointer between the pool, the ring and the handler future; the arena's
  slot ids address them from step 12" (STATUS.md). Tier 3 dispatch therefore needs the driver
  wired to slots, not only a new FFI.
- `zero_core::Error` has 8 variants (Protocol, Io, Codec, Closed, Auth, Unsupported, Timeout,
  Limit); `zero_core::slot` carries the 7/30/16 layout, `SlotId::{new, from_raw, as_u64, as_f64,
  worker, generation, index}`, `next_generation`.

## 3. Node binding (bindings/node)

Crate `zero-server-node` (napi-rs cdylib, `publish = false`, rust-version 1.89, Apache-2.0):
- `napi = { version = "3", default-features = false, features = ["napi6"] }`, `napi-derive =
  "3"`, `zero-ffi` by path (linked as an rlib, so the addon calls `zero_ffi::zero_version()` as a
  Rust function and carries its own copy of the core), build-dep `napi-build = "2"`.
- `src/lib.rs`: one `#[napi] fn version() -> napi::Result<String>` with one SAFETY-commented
  `CStr::from_ptr`.
- `build.rs`: `napi_build::setup()`.
- `[lints]`: copy of the audited table (checked by `lints --check` through `BINDING_CRATES`).
- No `[profile.release]`: the binding is its own workspace, so it builds with Cargo's default
  release profile (`lto = false`, default codegen units, `overflow-checks = false`, no strip),
  not the workspace's `lto = "fat"`, `codegen-units = 1`, `overflow-checks = true`,
  `strip = "symbols"` of section 10.2. Same for the Python crate.

npm workspace (`package.json`, private `zero-server-node-workspace` 0.1.0, workspaces
`packages/*`): scripts `build` (= build:native + build:facade), `build:native` (`napi build
--platform --release --package-json-path packages/native/package.json --output-dir
packages/native`), `build:debug`, `build:facade` (`tsc -b`), `check:packaging`, `test` (`node
test.js && npm run test:guides`), `guides` (`tsc -p guides/tsconfig.json && node
guides/run.js`). devDependencies `@napi-rs/cli ^3.10.0`, `@types/node ^26.6.1`, `typescript
^7.0.2`. No vitest, no test runner beyond `test.js`. `package-lock.json` and `Cargo.lock`
committed.

- `tsconfig.base.json`: ES2020, `module`/`moduleResolution` node16, strict, declaration, no
  declaration maps. Root `tsconfig.json` references `packages/core` and `packages/sdk`.
- `packages/native` (`@zero-server/native` 0.1.0): generated `index.js` (napi-rs loader for every
  platform napi-rs knows, the WASI fallback chain, `__napiBindingTarget`, version checks pinned
  to `'0.1.0'`, final `module.exports.version = nativeBinding.version`), generated `index.d.ts`
  (`__napiBindingTarget` and `version(): string`), `napi.binaryName = "zero-server-native"`,
  `napi.targets` = the seven targets, `files: [index.js, index.d.ts]`, `engines.node >= 16`, no
  `optionalDependencies` (napi `pre-publish` adds them at publish time), a `tsconfig.json` with
  `noEmit` over `index.d.ts` that no project references.
- `packages/native/npm/<platform>/package.json` for the seven targets (linux x64/arm64 gnu and
  musl with `libc`, darwin x64/arm64, win32-x64-msvc), each `files` = the `.node` file.
- `packages/core` (`@zero-server/core` 0.1.0, public): `src/index.ts` is `export { version }
  from '@zero-server/native'`; depends on `@zero-server/native` 0.1.0.
- `packages/sdk` (`@zero-server/sdk` 0.1.0, `"private": true`): `src/index.ts` is `export {
  version } from '@zero-server/core'`; depends on core and native.
- `scripts/check-packaging.mjs`: for every non-private workspace package, `main` and `types`
  must exist on disk (guards a facade published without `dist/`).
- `test.js`: requires `@zero-server/native` and `@zero-server/core`, asserts `version()` is a
  non-empty string and equal across both. That is the whole Node test suite.
- `guides/version.ts` (ANCHOR `version`), `guides/run.js` (runs every compiled guide under
  `build/guides` from the repository root), `guides/tsconfig.json`.
- Not present: `conformance.js` (named by `conformance/README.md`), `test/legacy/`,
  `legacy-manifest.json`, `test/_shim/`, `guides/quickstart.ts` (read by
  `crates/xtask/src/site/home.rs` QUICKSTARTS with an `ANCHOR: example` region; the Rust,
  Python and C# quickstarts are missing too), `bindings/node/docs` (typedoc project docs.yml
  runs `npm ci` and `npx typedoc` in), `bindings/node/README.md`.
- `.gitignore`: `*.node`, `artifacts/`, `node_modules/`, `*.tsbuildinfo`, `build/`.

Shape conflict to resolve: the SDK 1.x export `version` is a string (`zero-server/index.js` line
82 and 546: `const { version } = require('./package.json')`), and `api-surface.json` records
`core.version` as `kind facade`, `type string`, release 1. The binding exports `version()` as a
function in native, core and sdk. A shape-aware api-surface diff fails on this unless the facade
exports a string `version` (and keeps the function under another name, for example
`coreVersion()`), or the change is recorded as a 2.0.0 CHANGELOG break and the diff is told so.

## 4. Python binding (bindings/python)

- `packages/native` crate `zero-server-python` (`crate-type = ["cdylib", "rlib"]`, lib name
  `zero_server_python`), `pyo3 = { version = "0.29", features = ["abi3-py310"] }`, optional
  `pyo3-stub-gen = "0.23"` behind feature `stubs`, `zero-ffi` by path (rlib, like Node); `[[bin]]
  stub_gen` at `src/stub_gen.rs` with `required-features = ["stubs"]`; audited `[lints]` copy.
- `src/lib.rs`: one `#[pyfunction] version()` (SAFETY-commented `CStr::from_ptr`) and `#[pymodule]
  fn _native`. `pyproject.toml`: maturin `>=1.7,<2.0`, `python-source = "python"`, `module-name =
  "zero_server._native"`, `features = ["pyo3/extension-module"]`, `requires-python >=3.10`.
- `python/zero_server/_native/__init__.pyi` (generated, `version() -> builtins.str`),
  `python/zero_server/raw.py` (re-exports `_native`), `py.typed`.
- `packages/core` (`zero-server-core`, hatchling): `zero_server/core/__init__.py` re-exports
  `version` from `_native`. `packages/zero-server` (`zero-server` metapackage, `bypass-selection`).
- `tests/test_smoke.py` (three tests: native version non-empty, core equals native, raw exposes
  it), `tests/test_guides.py` (runs every `guides/*.py` from the repo root), `guides/version.py`.
- Not present: `tests/test_conformance.py` (named by `conformance/README.md`).
- "A Python smoke import over the same cdylib" (roadmap step 13): today the Python module links
  zero-ffi statically as an rlib and never loads `zero_ffi` the cdylib. The smoke import exists;
  whether "the same cdylib" means loading `libzero_ffi` (ctypes) or the PyO3 module over the same
  zero-ffi source is a wording point for the owner, not a gap in code.

## 5. .NET binding (bindings/dotnet)

- `Directory.Build.props`: `net8.0`, `LangVersion latest`, nullable, implicit usings,
  `AllowUnsafeBlocks`, `TreatWarningsAsErrors`, version 0.1.0, icon from `assets/` (exists).
- `ZeroServer.Native`: `Interop/NativeMethods.cs` with `[assembly: DisableRuntimeMarshalling]`,
  `Library = "zero_ffi"`, seven `[LibraryImport]` declarations: `zero_version`, and six that
  `zero-ffi` does not export: `zero_last_error_message`, `zero_string_data(IntPtr)`,
  `zero_string_free(IntPtr)`, `zero_buffer_len(IntPtr) -> nuint`, `zero_buffer_data(IntPtr)`,
  `zero_buffer_free(IntPtr)`. P/Invoke binds lazily, so the smoke passes because it only calls
  `zero_version`; any call to the other six throws `EntryPointNotFoundException`, and
  `OwnedString`, `OwnedBuffer`, `Status.LastError`, `Status.ThrowIfError` and
  `NativeHandle.Create` (which reads `Status.LastError()` on a null handle) all depend on them.
- `Interop/ZeroStatus.cs`: `Ok = 0, Protocol = 1, Io = 2, Codec = 3, Closed = 4, Auth = 5,
  Unsupported = 6, Timeout = 7, Limit = 8, InvalidArgument = 9, Panic = 10` (the design 8.1
  list, numbered); the header has no `ZeroStatus` yet.
- `NativeHandle.cs` (SafeHandle with release delegate, optional SemaphoreSlim serialization,
  `Use`, `UseTry`, `UseAsync`, `LendAsync`, `Lease` returning a `ref struct NativeLease`,
  `Take`), `OwnedBuffer.cs`, `OwnedString.cs`, `Status.cs`, `ZeroServerException.cs`. The csproj
  packs `runtimes/**` (filled by release-nuget.yml).
- Absent against design 8.5 and 10.1: no `NativeLibrary.SetDllImportResolver` module
  initializer (required before any `[SuppressGCTransition]` method is JIT compiled), no
  `[SuppressGCTransition]`, no `[UnmanagedCallersOnly]` dispatch stub, no `.github/CODEOWNERS`
  (SECURITY.md lines 145 and on describe the named-reviewer rule).
- `ZeroServer.Core/ZeroServerCore.cs`: `Version => Marshal.PtrToStringUTF8(zero_version()) ??
  ""`. `ZeroServer` metapackage (no build output).
- `tests/ZeroServer.Smoke`: copies `target/release/{zero_ffi.dll|libzero_ffi.so|.dylib}` and
  `conformance/vectors.json` next to the exe; `Program.cs` asserts only that the version is
  non-empty. It never reads vectors.json (design 8.7 says the smoke "runs the conformance
  vectors"; `conformance/README.md` says it asserts them).
- `samples/ZeroServer.Guides`: `VersionGuide` (ANCHOR `version`), `Program.cs` runner, same
  native copy logic. No `Quickstart.cs`, no `bindings/dotnet/docs/docfx.json` (docs.yml needs it).
- Nothing checks that `NativeMethods.cs` mirrors `zero.h` one to one.

## 6. conformance/

- `vectors.json` (generated by `crates/zero-examples/examples/conformance_vectors.rs`, CI
  regenerates and `git diff --exit-code`): `note`, `tolerance` 1e-6, `http1Parser.cases` (30:
  `name`, `section`, `request` hex, `expect.head{method,target,version,fields,body,keepAlive}` or a
  reject), `responseSplitting.cases` (10: `field`, `value` hex, `accepted`), `router` (`table`
  with `routes[{id,method,pattern}]` and `mounts[{prefix,routes}]`, 37 `cases` with
  `expect.matched{id,params,path,query,head}` or a miss). No `ws`, `sse`, `qpack`, `h3Frames`
  sections (design 6.6/8.1 say `ws` and `sse` ship in release 1; qpack and h3Frames come from
  step 11). No binding asserts any section today.
- `api-surface.json`: generated by `scripts/api-surface-from-zero-server.mjs` (tracked) from the
  sibling `zero-server` checkout (`index.js`, `lib/`, `.tools/scope-manifest.js`); header `note`,
  `source {package @zero-server/sdk, version 1.1.0}`, `kinds {ffi, facade, host-only}`,
  `exports[]` with fields `id`, `name`, `kind`, `type`, `scope`, `module`, `status`, `release`,
  `summary`, `params[{name,type,optional,default,description}]` (dotted `options.x` sub-params),
  `returns`, `examples`, and `reason` on the 21 dropped. 228 exports (the design text says 238):
  kind ffi 129, facade 27, host-only 72; status kept 204, dropped 21, shim 3; release 1: 50,
  release 2: 24, release 3: 154. Canonical id `<scope>.<snake_case>`; twin names get a type
  suffix (`auth.session_function`). Kind rules: a fixed FACADE name set, scopes `errors` and
  `orm` or a name ending in `Error` are host-only, everything else ffi. Release by scope with
  per-name overrides.
- Release 1 contract (50): facade `core.create_app`, `core.router`, `core.version` (string),
  `middleware.logger`, `middleware.validate`, `middleware.error_handler`,
  `lifecycle.lifecycle_manager`, `lifecycle.lifecycle_state`; ffi `middleware.cors`,
  `middleware.static`, `middleware.helmet`, `middleware.request_id`,
  `realtime.web_socket_connection`, `realtime.handle_upgrade`, `realtime.web_socket_pool`,
  `realtime.sse_stream`; host-only the 31 error classes plus `errors.create_error`,
  `errors.is_http_error`, `errors.debug`. This is wider than the brief's facade list (`logger`,
  `validate`, `errorHandler`, `LifecycleManager`, `LIFECYCLE_STATE`, `handleUpgrade`,
  `WebSocketPool`, `helmet`, `requestId`, `static` are release 1 here).
- `api-surface.node.json`, `.python.json`, `.dotnet.json`: `{note, language, rules, names}`
  where `names` maps all 228 ids to a spelling (Node unchanged; Python snake_case functions and
  unchanged classes; .NET PascalCase, `Error` to `Exception`, `Create` prefix when a function
  shadows a class). They carry names only, no shape, although design 8.7 says "name and shape".
- There is no mapping from an `ffi` canonical id to C symbols, and most of the ABI (`zero_req_*`,
  `zero_res_*`, `zero_batch_complete`, lifecycle) has no canonical id at all, because the ids are
  SDK-level exports. "CI diffs by canonical id" against `zero.h` is not implementable from the
  current files.
- Nothing reads any `api-surface*.json` (no xtask task, no script, no workflow).
- `conformance/README.md` claims runners that do not exist (`bindings/node/conformance.js`,
  `bindings/python/tests/test_conformance.py`, a .NET smoke that asserts the vectors).

## 7. xtask tasks that touch the ABI or the bindings

- `lints --check` (blocking in ci.yml): diffs every member manifest and the two binding crates
  (`bindings/node`, `bindings/python/packages/native`, held to `audited`) against
  `docs/lints/*.toml`; the root `[workspace.lints]` must equal `workspace.toml`. It does not cap
  which crates may name `audited` (the cap is only the capabilities row plus `forbid`), and
  `flatten` keeps only `level` and `priority`, so a `check-cfg` list on `unexpected_cfgs` would
  not be diffed. Result today: 33 crates pass.
- `version --check` (blocking in ci.yml and release-preflight): every `package.json` (workspace,
  packages, platform packages), every `pyproject.toml` and its pins, `Directory.Build.props`,
  every `Cargo.lock` (workspace and bindings), the napi loader's two version sites in `index.js`
  (`bindingPackageVersion !== '...'` and `expected ... but got`), the CHANGELOG entry.
  `version <x.y.z>` rewrites them and refreshes the lockfiles (`npm install
  --package-lock-only`).
- `packages [--check]` (not in any workflow) and `docs [--check]` (`render_all` calls
  `packages::render_node`, `render_python`, `render_dotnet`): the renderers are still the pamoja
  template. They render `packages/core` with keywords `iot, robotics` and a `./transport`
  subpath, one package per capability whose `node` key equals its key, one package per domain
  (`http`, `realtime`, `http3`), a bare `zero-server` bundle package, and no `sdk`. Run today:
  `packages --check` fails with 47 stale or missing files across all three bindings (it also
  renders `bindings/python/packages/zero_server/` while the tree has `packages/zero-server/`);
  `docs --check` fails first in `Catalog::check` with at least 39 problems (output was cut at
  40 lines), among them
  `bindings/node/packages/sdk exists, which no capability claims`, `node = "http"` and
  `node = "http3"` have no package, plus the bundle-feature and zero-bench/zero-examples claims.
  `catalog.rs` `node_packages` excludes `core`, `native`, `zero-server` but not `sdk`;
  `dotnet_types` requires every `dotnet = [...]` name (App, Request, Response, Router, Json,
  StaticFiles, Cors, ...) to be a declared type. ci.yml and docs.yml run `docs --check` with
  `continue-on-error`; release-preflight runs it blocking, so no tag can publish until the
  binding layout and the renderers agree.
- `builds`: lists `target/release/{zero_ffi.dll,libzero_ffi.so,libzero_ffi.dylib}` as the C ABI
  artifacts.
- `probes`: builds `bench/probes/{node/napi-probe,python/pyo3-probe,dotnet/ffi-probe}` in Docker
  (the ffi probe builds `-p zero-ffi --release` and copies `libzero_ffi.so`); these are the
  boundary-cost fixtures the section 8.6 micro-harness can reuse.
- `licenses`: writes LICENSE copies under `bindings/{node,python}/packages` and `dotnet/src`.
- `site` (`home.rs`): reads four quickstart files (none exist).
- No task parses `zero.h`, `index.d.ts`, `__init__.pyi`, `NativeMethods.cs` or `api-surface*.json`.

## 8. Binding CI workflows

- `node.yml` (push main, PR; ubuntu-latest only): `actions/checkout@v7`, `actions/setup-node@v7`
  with `node-version: 20`, `npm install` (not `npm ci`), `npm run build`, `npm run
  check:packaging`, `git diff --exit-code -- packages/native/index.js packages/native/index.d.ts`,
  `npm test` (step titled "Smoke, conformance, and guide tests"; there is no conformance part).
  Node 20 is end-of-life since 2026-04-30 (ROADMAP R.5, fetched 2026-09-30); Node 22 maintenance
  LTS to 2027-04-30, 24 active LTS to 2028-04-30, 26 current. The addon is never built on
  Windows or macOS in PR CI.
- `python.yml` (ubuntu-latest, Python 3.13): venv, unpinned `pip install maturin pytest`,
  `maturin develop`, installs the pure packages, regenerates the stub with `cargo run --bin
  stub_gen --features stubs` and diff-checks `__init__.pyi`, runs pytest.
- `dotnet.yml` (ubuntu-latest, `setup-dotnet@v6` 8.0.x): `cargo build -p zero-ffi --release`,
  header diff check, `dotnet build` of the solution, runs Smoke and Guides.
- `release-node.yml` (tag `v*` or dispatch): preflight; `gate` publishes only when the major is
  at least 2 (owner decision, 3f1d67a), so v0.1.0 builds and publishes nothing to npm; the
  seven-target build matrix (ubuntu for linux with zig 0.13.0 `--cross-compile` for the three
  cross targets, macos-latest for both darwin, windows-latest with NASM 2.16.01), Node 20 for
  build, Node 24 plus npm 11.5.1 check for trusted publishing, `npm install`, `napi artifacts`,
  `build:facade`, `check:packaging`, `napi pre-publish`, `npm publish --workspaces --access
  public` (the private `sdk` is skipped or errors; not verified which).
- `release-preflight.yml` (called by every release workflow): `version --check <tag>`,
  `standards --check`, `docs --check` (blocking), commit on main, and a completed successful
  run of ci.yml, node.yml, python.yml and dotnet.yml on the tagged SHA.
- `docs.yml`: Node 20, `npm ci` and typedoc in `bindings/node/docs` (missing), docfx on
  `bindings/dotnet/docs/docfx.json` (missing); fails today.
- `deny` job: `cargo deny --manifest-path bindings/node/Cargo.toml --config deny/node.toml
  check` and the same for Python. `deny/node.toml` and `deny/python.toml` allow the core crates
  zero-ffi links today (zero-core, zero-date, zero-ffi, zero-http, zero-http-types, zero-http1,
  zero-io, zero-limits, zero-router, zero-uri, zero-rt, zero-simd, zero-sys), tokio and its six,
  the napi graph (measured against napi 3.13.0, napi-derive 3.6.9, napi-sys 3.3.2, napi-build
  2.5.0) and the cbindgen build tree. They do not allow zero-tls, zero-server-crypto,
  zero-policy, zero-static, zero-realtime, zero-ws, zero-sse, rustls, rustls-webpki, aws-lc-rs,
  aws-lc-sys, subtle, zeroize or untrusted, and `[bans.build] allow-build-scripts` lacks
  aws-lc-sys and friends. `include-workspace = true` there.
- No `vet` coverage of the two binding lockfiles (cargo vet runs on the workspace only).

## 9. What step 12 must add or change (ABI side)

zero-rt (safe Rust, stays at `forbid`):
- A host-reachable slot directory: fixed-capacity chunk table with set-once chunks (stable
  addresses, shareable through an `Arc` without the worker's `&mut`), exposing the word and a
  way for zero-ffi to reach the record only under a `Borrow`. Decide where the `UnsafeCell`
  dereference for host reads and response writes lives: zero-rt cannot hold `unsafe` (and an
  `unsafe impl Sync` is unsafe code), so the record pointer must be handed to zero-ffi and
  dereferenced there, inside `with_slot`, with the SAFETY argument being the `Leased` state plus
  the counted reader.
- Epoch-based reuse: a per-worker completion epoch, freed indexes quarantined until every
  registered host target acknowledged the epoch they were freed in (acknowledged through
  `zero_batch_complete(worker, slots, count, epoch)`), and a target registry.
- The bounded batch dispatcher: up to 256 ready slots per batch, at most 4 batches in flight per
  target, the worker stops reading from the feeding connections on a full target, and past 16
  queued batches per core new tier 3 requests answer 503 with `Retry-After` from tier 0.
- zero-http wiring: tier 3 routes move a parsed record into a slot, `Leased` at dispatch,
  `Completing` read back and written in request order; the late-reader re-poll and
  `late_reader` metric; lease timeout to `Closed`.
- loom model: `cfg(loom)` swap of `AtomicU64`/`Ordering` (and a non-const `SlotWord::new` under
  loom), a model racing a stale-id borrow against recycle, plus `cfg(loom)` registered for
  `unexpected_cfgs` (options: add `check-cfg = ["cfg(loom)"]` to `[workspace.lints.rust]` and
  `docs/lints/workspace.toml`, which `lints.rs` flatten would not diff; or a zero-rt build
  script, which `deny.toml` `allow-build-scripts` with `include-workspace = true` would then have
  to list). loom 0.7.2 is the newest release, last published 2024-04-23 (crates.io, fetched
  2026-10-01): a 0.x line with no release in 12 months, so adopting it needs the written
  exception the currency rules require. It is already in the workspace lockfile and
  `supply-chain/config.toml` has `[[exemptions.loom]] version = "0.7.2"`; cargo-deny skips it as
  a dev-dependency (`exclude-dev = true`).
- A ci.yml `loom` job, and a real ignored test whose name contains `slot_recycle` (or a changed
  filter) so the TSan race step stops passing vacuously; the race test runs tier 0 traffic and
  tier 3 completions on one core.

zero-ffi:
- `#[repr(C)] enum ZeroStatus` with the eleven values the .NET enum already numbers; a
  thread-local last error and `zero_last_error_message`; opaque owned string and buffer handles
  with `zero_string_data`, `zero_string_free`, `zero_buffer_len`, `zero_buffer_data`,
  `zero_buffer_free` (the six imports .NET declares), or remove those declarations; `*_free` for
  every owned handle; `ZERO_ABI_VERSION` constant (R.5 deprecation policy).
- Lifecycle and registration: server config, route registration returning route ids (tier 0
  values for `static`, `cors`, `helmet` (security headers), `requestId`; tier 3 host routes;
  tier 4 stays Rust), host target registration per worker with the dispatch callback,
  `zero_server_start`, `zero_server_shutdown`, the process-global route table with a descriptor
  hash for the identical-table check.
- Accessors through one `with_slot` helper (id decode, worker lookup, `borrow`, record access,
  drop) for `zero_req_method`, `path`, `query`, `param`, `header_id`, `header`, `trailer`,
  `body`, `body_retain`, `claim`, `peer`; response writes validating arguments (`status` 100 to
  599, `header` token and CR/LF/NUL/whitespace rules reusing zero-http1's outbound validator,
  `body_copy` under 64 KiB, `body_alloc` region, `body_transfer` for .NET and Python only,
  `json`, `file` through zero-static's policy, `sse_open`, `ws_accept`, `send`).
- `#[repr(C)] struct ZeroBatch { worker, count, slots: *const u64, routes: *const u32, epoch,
  flags }`, the dispatch callback typedef, `zero_batch_complete`.
- WebSocket, SSE and room entry points (`zero_ws_send`, `close`, `writable`, `ping`, the ws
  event batch, `drained`; `zero_sse_send`, `close`, `writable`; `zero_room_join`, `leave`,
  `broadcast`).
- Plugin vtable declaration only (`zero_plugin_abi_version`, `ZeroPluginVTable`); the loader is
  step 31.
- `catch_unwind` at every export mapping to `Panic`; null, stale and out-of-range inputs return
  a status (the table-driven test over the header: parse `include/zero.h` function prototypes
  and assert each pointer-taking or slot-taking export has a case, so a new export without a
  case fails).
- Dependencies: zero-rt (direct), and for the release 1 surface zero-router, zero-policy,
  zero-static, zero-realtime, zero-ws, zero-sse, zero-tls (for `listen({ tls })`). Recommended:
  one zero-ffi feature per capability, default on, so the existing `--no-default-features` CI
  step means something. Every new crate in the zero-ffi graph must be added to
  `deny/node.toml` and `deny/python.toml` (allow, bans.features, allow-build-scripts for
  aws-lc-sys and its build graph); zero-tls also pulls aws-lc-sys C code into the reproducible
  and the CFI-hardened jobs, which then need to stay green.
- `cbindgen.toml`: add "typedefs" (and "unions"/"globals" only if used) to `item_types`.
- Standards rows: `docs/standards.toml` has no row for the FFI rules (ANSSI FFI-NOPANIC,
  FFI-CTYPE, FFI-CAPI, FFI-MEM-OWNER, the Rust reference on unwinding across `extern "C"`), nor
  for Node-API; rows first, with tests named after the statements.
- Header drift check: today it lives only in dotnet.yml; a ci.yml check (or `git diff` after
  `cargo build -p zero-ffi`) keeps it on the main job too.
- Section 8.6 micro-harness cell for the borrow protocol's cost (zero-bench; hardware-dependent
  runs in Docker on the owner's machine or skipped, per the brief).

## 10. What step 13 must add or change (Node, .NET smoke, Python smoke, conformance)

Node crate:
- napi functions over zero-ffi: per-isolate instance data (`napi_set_instance_data`, N-API 6,
  fetched), env cleanup hook (N-API 3, fetched), one ThreadsafeFunction per isolate (N-API 4,
  fetched) created bounded at 4 (`MaxQueueSize` is a const generic defaulting to 0, and
  `refer`/`unref` are deprecated in napi 3.14.0 while a `Weak` const generic exists: docs.rs
  napi 3.14.0, fetched; use the non-deprecated way to unreference at close), `NonBlocking` call
  mode with QueueFull leaving the batch queued, `CalleeHandled = false`.
- External ArrayBuffer staging pool for bodies of 64 KiB and more, detached at send; Node's
  `napi_status` enum includes `napi_no_external_buffers_allowed` (fetched), so creating an
  external buffer can fail in some hosts and the pool needs a copy fallback. If
  `napi_detach_arraybuffer` needs a Node-API level above 6, the `napi6` floor in Cargo.toml, its
  comment and the deny/node.toml note change with it.
- `[profile.release]` mirroring the workspace (section 10.2) in the binding manifest, and the
  same in the Python crate.
- napi 3.14.0 is on crates.io as of 2026-10-01 (deny/node.toml measured 3.13.0); the lockfile
  pin decides, and any bump is its own commit.

TypeScript (packages/sdk and core):
- `createApp`, `Router`, routes, `res.json`, `cors` and the other release 1 middleware,
  `app.ws`, `res.sse`, `app.listen({ port, tls })`, the `worker_threads` pool sized by
  `os.availableParallelism()` with the `threads` option, the identical-route-table check, pooled
  view objects, the completion array with a microtask flush, try/catch to the error registry,
  the 31 error classes and the three error helpers, `logger`, `validate`, `errorHandler`,
  `LifecycleManager`, `LIFECYCLE_STATE`, `handleUpgrade`, `WebSocketPool`, `SSEStream`,
  signal wiring to `zero_server_shutdown`; reconcile `version` (section 3).
- `engines.node >= 16` everywhere (also hard-coded in `packages.rs`) and Node 20 in node.yml,
  release-node.yml and docs.yml are stale against the fetched support window; the build tool
  `@napi-rs/cli` 3.10.6 (npm, fetched 2026-10-01) declares engines `^20.17.0 || ^22.13.0 ||
  >= 23.5.0`; TypeScript latest is 7.0.2 (npm, fetched) with engines `>=16.20.0`. The engines
  floor is an owner decision recorded with its fetch date.
- `@zero-server/sdk` stays `private` or the release gate keeps it off npm; nothing is
  published before 2.0.0 (the roadmap's `2.0.0-alpha.1` publish is dropped by owner decision).

Packaging and generators:
- `crates/xtask/src/packages.rs` and `catalog.rs` must be rewritten for this layout (`sdk` as the
  facade package, `core`, `native`, and whatever capability packages the owner wants), with
  zero-server keywords, the right engines, and the `node`/`python`/`dotnet` keys of
  `docs/capabilities.toml` matching real packages and declared types; otherwise `docs --check`
  (blocking in release-preflight) keeps every tag from publishing.

api-surface diff (new tool):
- Inputs: `api-surface.json`, the per-language name maps, the generated declarations
  (`packages/native/index.d.ts`, the built `packages/sdk/dist/index.d.ts`, `__init__.pyi`,
  `NativeMethods.cs`, `zero.h`).
- Missing data to decide first: shapes in the maps (design 8.7), a canonical-id to C-symbol map
  for the `ffi` entries (generated, since api-surface files are never hand-edited: extend
  `scripts/api-surface-from-zero-server.mjs` or tag exports in rustdoc), ABI-only symbols that
  have no canonical id, and a per-binding release floor (Python and .NET facades arrive at
  release 2, so at release 1 they are held to the header mirror only).
- A `NativeMethods.cs` to `zero.h` one-to-one check (names and parameter types).

Conformance runners:
- `http1Parser`: send `request` bytes over a socket to a server with one tier 3 route whose
  handler echoes method, target and fields through the accessors (rejects compare status);
  `router`: register `router.table` routes and mounts with their ids and assert the matched id
  and params; `responseSplitting`: call `zero_res_header(field, value)` and compare
  `Ok`/`InvalidArgument` with `accepted`; `ws` and `sse` need their vector sections added to the
  generator first (absent today); `qpack` and `h3Frames` arrive with step 11 and are codec-level,
  so they need an ABI or a test-only entry to be asserted from a binding at all (decision).
- .NET smoke must read the copied `vectors.json` and run them; Python adds
  `tests/test_conformance.py` or the README stops claiming it.
- Legacy suite: `bindings/node/test/legacy/` from `zero-server/test` (128 files; app 7, routing 1,
  realtime 3, errors 4, env 1, http 8, middleware 5, body 5, auth 11, observe 5, grpc 6, orm 38,
  webrtc 29, docs 3, packages 2), `test/_shim/` require rewrite, `legacy-manifest.json`, vitest
  as a new devDependency (version fetched at adoption). The zero-server working tree has
  uncommitted test edits, so copy from a named commit, not the working tree.
- node.yml: `npm ci`, a Node matrix on supported lines, a Windows and macOS addon build, the
  conformance and legacy steps, the api-surface diff; python.yml pinned tool versions.

## 11. Release 1 and the 0.1.0 tag

- Per STATUS.md the owner publishes crates.io, PyPI and NuGet at v0.1.0 and npm only from 2.0.0.
  `ZeroServer.Native` 0.1.0 and `zero-server-native` 0.1.0 will ship whatever ABI step 12 leaves,
  so the .NET imports must all resolve and the header must be final for 0.x before the tag.
- release-preflight blocks on `docs --check` and `standards --check` and on green ci, node,
  python and dotnet runs for the tagged SHA; `docs --check` fails today on the binding layout
  (section 7), so it gates 0.1.0 regardless of the ABI work.

## 12. Facts fetched in this read (2026-10-01)

- crates.io napi: max_stable_version 3.14.0, updated 2026-10-01, not yanked; features napi1 to
  napi10 cascade (napi7 enables napi6), `tokio_rt` requires napi4, default `dyn-symbols`.
- docs.rs napi 3.14.0 `ThreadsafeFunction`: generics `T, Return, CallJsBackArgs, ErrorStatus,
  CalleeHandled (default true), Weak (default false), MaxQueueSize (default 0)`; `refer`/`unref`
  deprecated; no feature gate shown on the page.
- nodejs.org/api/n-api.html (page for v26.10.0): `napi_set_instance_data` N-API 6,
  `napi_create_threadsafe_function` N-API 4 (added v10.6.0), `napi_add_env_cleanup_hook` N-API
  3; `napi_no_external_buffers_allowed` is in `napi_status`.
- crates.io loom: 0.7.2, updated 2024-04-23, not yanked, repository tokio-rs/loom.
- crates.io cbindgen: 0.29.4, updated 2026-06-09, not yanked; cbindgen docs.md at v0.29.2:
  `item_types` values listed in section 1.
- npm typescript latest 7.0.2 (engines node >=16.20.0); npm @napi-rs/cli latest 3.10.6
  (engines `^20.17.0 || ^22.13.0 || >= 23.5.0`).

## 13. Unverified

- The Node-API version that introduced `napi_detach_arraybuffer`, `napi_is_detached_arraybuffer`,
  `napi_create_external_arraybuffer` and `napi_unref_threadsafe_function`, the meaning of
  `max_queue_size = 0`, and when `napi_no_external_buffers_allowed` is returned: the fetched
  n-api page was truncated before those sections. Read them from the docs of the pinned
  `engines` line before choosing the napi feature floor.
- How napi 3.14.0 sets `max_queue_size`, the `NonBlocking` and `QueueFull` behavior, and the
  replacement for the deprecated `unref`: the docs.rs page did not describe them.
- Whether napi 3 with `default-features = false` (no `dyn-symbols`) links on
  x86_64-pc-windows-msvc: the addon is only built on Windows in release-node.yml, which the
  gate skips below 2.0.0.
- Whether `npm publish --workspaces` skips or fails on the `private` `@zero-server/sdk`.
- Whether `tsc -b` behaves the same under TypeScript 7.0.2 as the tsconfig files assume (the
  node.yml run on e41a22b passed, so the current two-file build works).
- cbindgen's handling of fn-pointer typedefs and explicit enum discriminants: the v0.29.2
  docs.md does not describe them; the docs were read at the v0.29.2 tag, and the lockfile's
  cbindgen version was not read (lockfiles are not read in this workspace).
- The Node support window, cited from ROADMAP R.5 (fetched 2026-09-30), not refetched here.
- The release 1 count of 50 api-surface entries and the 228 total are measured from the file;
  the design's 238 is not reconciled.
