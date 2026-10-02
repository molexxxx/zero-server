# Fetched facts for the host dispatch, C ABI and Node binding work

Every fact below was fetched live on 2026-10-01 (UTC date of the session) from the URL named beside it. Quotations are verbatim from the fetched text. Statements marked "read in source" come from the published source of the pinned version (docs.rs source view or the GitHub tag), not from prose documentation. Anything not fetched is listed in the last section.

## 1. Registry versions

crates.io values come from `https://crates.io/api/v1/crates/<name>` (fields `max_stable_version`, `updated_at`, per-version `created_at` and `yanked`); npm from `https://registry.npmjs.org/<name>/latest` plus the package `time` map.

| Package | Registry stable today | Published | Yanked | Locked in the repo today | rust-version / engines of the package |
| --- | --- | --- | --- | --- | --- |
| napi (crate) | 3.14.0 | 2026-10-01T05:01:18Z | no | 3.13.0 (bindings/node/Cargo.lock) | rust-version 1.88 |
| napi-derive (crate) | 3.6.10 | 2026-10-01T05:01:27Z | no | 3.6.9 | rust-version 1.88 |
| napi-build (crate) | 2.6.0 | 2026-10-01T04:53:16Z | no | 2.5.0 | rust-version 1.88 |
| napi-sys (crate, transitive) | 3.4.0 | 2026-10-01T05:01:05Z | no | 3.3.2 | rust-version 1.88 |
| napi-derive-backend (crate, transitive) | 6.1.4 | 2026-09-20T03:46:40Z | no | 6.1.4 | |
| @napi-rs/cli (npm) | 3.10.6 | 2026-10-01T17:25:17Z | not deprecated | `^3.10.0` in bindings/node/package.json | engines `^20.17.0 \|\| ^22.13.0 \|\| >= 23.5.0` |
| loom (crate) | 0.7.2 | 2024-04-23T09:24:01Z | no | 0.7.2 (root Cargo.lock, supply-chain exemption 0.7.2) | rust-version 1.65 |
| cbindgen (crate) | 0.29.4 | 2026-06-09T19:03:00Z | no | 0.29.4 (root Cargo.lock), `version = "0.29"` in crates/zero-ffi/Cargo.toml | rust-version 1.74 |

Previous napi releases (crates.io): 3.13.0 on 2026-09-22, 3.12.7 on 2026-09-20, 3.12.6 on 2026-09-16. Previous loom releases: 0.7.1 on 2023-10-02, 0.7.0 on 2023-08-04.

Policy checks, same date:

- RustSec advisory-db (`https://api.github.com/repos/rustsec/advisory-db/contents/crates/<name>`, control query on `tokio` returned its five advisories): no directory, therefore no RustSec advisory, for napi, napi-derive, napi-build, napi-sys, loom, cbindgen.
- GitHub advisory GHSA-3hv5-cch8-c72w exists for napi below 3.12.3 (napi CHANGELOG, section 3.12.3 "Security": "`BufferSlice::from_data`, `BufferSlice::copy_from` and `BufferSlice::from_external` built their `Deref`/`DerefMut` slice over the `napi_value` handle instead of the buffer's bytes (OOB read into V8's handle scope, attacker-length OOB write)"). It has no RustSec entry, so `cargo deny check advisories` alone would not report it. The locked 3.13.0 is past the fix.
- Repositories not archived (`https://api.github.com/repos/<owner>/<repo>`): napi-rs/napi-rs (pushed 2026-10-01), tokio-rs/loom (pushed 2026-02-20), mozilla/cbindgen (pushed 2026-08-22).
- loom fails two allowlist conditions of RULES.md as written: its last release (0.7.2, 2024-04-23) is older than 12 months and it is a `0.x` line. It is a test-only dependency used under `cfg(loom)`; the design must record why it is accepted (RULES.md "unless the design records why"). loom 0.7.2 normal dependencies (crates.io `/crates/loom/0.7.2/dependencies`): cfg-if ^1.0.0, generator ^0.8.1, scoped-tls ^1.0.0, tracing ^0.1.27, tracing-subscriber ^0.3.8; optional pin-utils, serde, serde_json; features `checkpoint`, `futures`, default empty.
- cbindgen is a `0.x` line as well (already allowed in deny.toml as a build-only tool). cbindgen 0.29.4 normal dependencies: heck ^0.5, indexmap ^2.1.0, log ^0.4, proc-macro2 ^1.0.60, quote ^1, serde ^1.0.103, serde_json ^1.0, syn ^2.0.85, tempfile ^3, toml ^0.9, optional clap ^4.3.

Changelogs (raw `CHANGELOG.md` on napi-rs main, fetched):

- napi 3.14.0 (2026-10-01): "*(napi)* lock the allocator on threaded WASI and never hang after a worker crash (#3552)". 3.13.0 (2026-09-22): "offer the MultiThread flavor on wasm32-wasip1-threads" and "*(napi)* validate native payload provenance for External and instance data (#3540)". 3.12.7: "guard AsyncTask completion against env teardown". 3.12.3 also lists "*(napi)* catch panics in closure trampolines instead of aborting (#3473)" and "*(napi)* outline threadsafe callback dispatch (#3465)".
- napi-derive 3.6.10 and 3.6.9: "update Cargo.toml dependencies".
- napi-build: the main-branch CHANGELOG stops at 2.5.0 (2026-09-22); no entry for 2.6.0 was found.
- @napi-rs/cli: the main-branch CHANGELOG stops at 3.10.4 (2026-09-17); no entry for 3.10.5 or 3.10.6 was found.
- Open issue napi-rs#3377 "Unsound `Send` implementation on `SendableResolver<Data, R>`" (GitHub search API).

## 2. napi 3.14.0 ThreadsafeFunction

Sources: `https://docs.rs/napi/3.14.0/napi/threadsafe_function/struct.ThreadsafeFunction.html`, `https://docs.rs/napi/3.14.0/napi/bindgen_prelude/struct.ThreadsafeFunctionBuilder.html`, `https://docs.rs/napi/3.14.0/napi/bindgen_prelude/struct.Function.html`, `https://docs.rs/napi/3.14.0/napi/enum.Status.html`, source `https://docs.rs/napi/3.14.0/src/napi/threadsafe_function.rs.html` (identical to `https://raw.githubusercontent.com/napi-rs/napi-rs/napi-v3.14.0/crates/napi/src/threadsafe_function.rs`), guide `https://napi.rs/docs/concepts/threadsafe-function` (page footer "Last updated on July 29, 2026").

Type:

```rust
pub struct ThreadsafeFunction<T: 'static, Return: 'static + FromNapiValue = Unknown<'static>, CallJsBackArgs: 'static + JsValuesTupleIntoVec = T, ErrorStatus: AsRef<str> + From<Status> = Status, const CalleeHandled: bool = true, const Weak: bool = false, const MaxQueueSize: usize = 0> {
 pub handle: Arc<ThreadsafeFunctionHandle>,
 /* private fields */
}
```

Builder (the v3 way to create one):

```rust
// Function<'_, Args, Return>
pub fn build_threadsafe_function<T: 'static>(&self) -> ThreadsafeFunctionBuilder<'_, T, Args, Return>
// "Create a threadsafe function from the JavaScript function."

pub struct ThreadsafeFunctionBuilder<'env, T: 'static, Args: 'static + JsValuesTupleIntoVec, Return, ErrorStatus: AsRef<str> + From<Status> = Status, const CalleeHandled: bool = false, const Weak: bool = false, const MaxQueueSize: usize = 0>
pub fn error_status<NewErrorStatus: AsRef<str> + From<Status>>(self) -> ThreadsafeFunctionBuilder<'env, T, Args, Return, NewErrorStatus, CalleeHandled, Weak, MaxQueueSize>
pub fn weak<const NewWeak: bool>(self) -> ThreadsafeFunctionBuilder<.., CalleeHandled, NewWeak, MaxQueueSize>
pub fn callee_handled<const NewCalleeHandled: bool>(self) -> ThreadsafeFunctionBuilder<.., NewCalleeHandled, Weak, MaxQueueSize>
pub fn max_queue_size<const NewMaxQueueSize: usize>(self) -> ThreadsafeFunctionBuilder<.., CalleeHandled, Weak, NewMaxQueueSize>
pub fn build_callback<CallJsBackArgs, Callback>(&self, call_js_back: Callback) -> Result<ThreadsafeFunction<T, Return, CallJsBackArgs, ErrorStatus, CalleeHandled, Weak, MaxQueueSize>>
 where CallJsBackArgs: 'static + JsValuesTupleIntoVec, Callback: 'static + FnMut(ThreadsafeCallContext<T>) -> Result<CallJsBackArgs>
// only when T == Args:
pub fn build(&self) -> Result<ThreadsafeFunction<T, Return, T, ErrorStatus, CalleeHandled, Weak, MaxQueueSize>>
```

Note the two different defaults: the builder defaults `CalleeHandled` to `false`, the struct defaults it to `true`. A field or parameter typed `ThreadsafeFunction<X>` without the fifth argument therefore does not match what the builder returns by default. The napi.rs guide's heading "CalleeHandled: true (default behavior)" describes the struct default.

Shape of a bounded, non-error-first, strong function built from the signatures above (not compiled in this task):

```rust
let tsfn = js_dispatch
 .build_threadsafe_function::<BatchDescriptor>()
 .callee_handled::<false>()
 .max_queue_size::<4>()
 .build_callback(|ctx| Ok(/* JS argument tuple from ctx.value */))?;
// tsfn: ThreadsafeFunction<BatchDescriptor, Return, Args, Status, false, false, 4>
let status = tsfn.call(batch, ThreadsafeFunctionCallMode::NonBlocking); // Status::Ok, QueueFull or Closing
```

Creation (read in source, `create_raw`): calls `napi_create_threadsafe_function(env, func, NULL, "napi_rs_threadsafe_function", max_queue_size, 1, Weak handle ptr, thread_finalize_cb, callback_ptr, call_js_cb, &raw)`. So `MaxQueueSize` is passed straight through as Node's `max_queue_size`, `initial_thread_count` is 1, the context is the boxed Rust callback. When `Weak` is true it immediately calls `napi_unref_threadsafe_function(env, raw)`.

Call modes and statuses:

- `#[repr(u8)] pub enum ThreadsafeFunctionCallMode { NonBlocking = 0, Blocking = 1 }`.
- `Status::QueueFull = 15` ("ThreadSafeFunction queue is full"), `Status::Closing = 16` ("ThreadSafeFunction closed"), `Status::PendingException = 10`, `Status::DetachableArraybufferExpected = 20`, `Status::NoExternalBuffersAllowed = 22`.
- napi.rs guide: "MaxQueueSize sets the queue capacity in both call modes. When that capacity is reached, Blocking waits for space; NonBlocking returns immediately with Status::QueueFull." And: "A capacity of one guarantees the backpressure behavior, not a fixed output sequence."
- With `CalleeHandled = false`: `pub fn call(&self, value: T, mode: ThreadsafeFunctionCallMode) -> Status`. With `CalleeHandled = true`: `pub fn call(&self, value: Result<T, ErrorStatus>, mode) -> Status`.
- napi.rs guide on `CalleeHandled: false`: "the first argument of JavaScript callback is the value from the Rust, not Error | null" and "The plain call method has no error channel back to Rust. A synchronous throw in the JavaScript callback is routed through napi_fatal_exception, and a returned Promise is not awaited automatically." and "Use this mode only when native failures are handled before call and the JavaScript callback cannot throw."
- Read in source (`call_js_cb_raw`, `handle_call_js_cb_status`): for a plain `call`, a JavaScript throw leaves `napi_pending_exception`, which is cleared and passed to `napi_fatal_exception`; the status checks there use `assert!`/`assert_eq!` inside an `unsafe extern "C" fn` trampoline. Consequence for the facade: the per-handler try/catch the design requires is the only thing that keeps a throwing handler from raising an uncaught exception on the isolate.
- Read in source: `call` first takes the `aborted` read lock and returns `Status::Closing` without allocating if the function was finalized. Otherwise it allocates one `Box<ThreadsafeFunctionCallJsBackData<T, Return>>` per call (plus a boxed zero-sized no-op callback) and passes the raw pointer to `napi_call_threadsafe_function`. The returned status is converted and returned, and nothing reclaims the box when the status is not `napi_ok`. Node's text says "The value is only added to the queue if the API returns napi_ok." So in napi 3.14.0 every `QueueFull` (and every `Closing` reported by Node itself) leaks the boxed payload `T`, and `T`'s `Drop` never runs. The batch descriptor passed to `call` should therefore be a small plain value, and the dispatcher's own in-flight accounting should keep `QueueFull` from being the normal back-pressure signal. A queue item leaves the Node queue when `call_js_cb` runs, so a Rust-side in-flight cap that counts until `zero_batch_complete` is stricter than the Node queue bound.
- `call_with_return_value`, `call_async` and `call_async_catch` exist. `call_async` warns: "if the JavaScript callback throws, this method will route the captured exception through napi_fatal_exception, which terminates the host process".

Release, reference counting and unref:

- Trait implementations listed on the 3.14.0 page: `FromNapiValue`, `Send`, `Sync`, `TypeName`, `ValidateNapiValue`. There is no `Clone` impl on `ThreadsafeFunction` in 3.14.0, although the deprecation notes say "Please use ThreadsafeFunction::clone". The napi.rs guide's examples share it as `Arc<ThreadsafeFunction<...>>`.
- Read in source: `unsafe impl Send` and `unsafe impl Sync` for `ThreadsafeFunction` carry no `T: Send` bound. The type system will not stop a non-`Send` payload type from crossing threads, so the payload type needs its own audit.
- `refer(&mut self, env: &Env)` and `unref(&mut self, env: &Env)` are "Deprecated since 2.17.0" and need `&mut self`, so they cannot be called through a shared `Arc`. `abort(self)` is deprecated: "Drop all references to the ThreadsafeFunction will automatically release it". `raw(&self) -> napi_threadsafe_function` returns the raw handle. Node allows ref and unref only from the main (JS) thread of that env.
- Read in source: `impl Drop for ThreadsafeFunctionHandle` calls `napi_release_threadsafe_function(raw, napi_tsfn_release)` when not aborted; a failed release status is ignored. Dropping the last `Arc<ThreadsafeFunctionHandle>` therefore releases the single acquisition from `initial_thread_count = 1`, and Node destroys the function after the queue drains.
- napi.rs guide on Weak: "By default, the ThreadsafeFunction will cause the event loop on the thread on which it is created to remain alive until the ThreadsafeFunction is destroyed." and "Weak mode does not guarantee callback delivery or suppress callbacks; it only removes this ThreadsafeFunction as a reason to keep the loop alive."
- Ways to let an isolate exit after `close()` with 3.14.0: create it `weak::<true>()` and keep the isolate alive by other means while serving; or drop every Rust-side clone so the function is released; or call raw `napi_unref_threadsafe_function(env, tsfn.raw())` on the isolate thread (unsafe). The deprecated `unref` is impractical behind an `Arc`.
- napi.rs guide: "you can't access `napi_env`, `napi_value`, and `napi_ref` on another thread."

Env teardown (read in source):

- `ThreadsafeFunctionHandle::new` pins the addon image ("Every handle pins the addon image, at construction ... environment teardown finalizes the threadsafe function first, which marks the handle aborted, and `Drop` then takes its no-op branch").
- `thread_finalize_cb` (run by Node when the function is destroyed, including at env teardown) sets `aborted = true` and drops the boxed callback. After that every `call` returns `Status::Closing` without touching Node.
- `call_js_cb` starts with `if raw_env.is_null() || js_callback.is_null() { return; }`. Node invokes it with NULL env and callback for items still queued at teardown, so those queued payloads are leaked and their `Drop` does not run. Slots referenced by batches that were queued when an isolate died must be reclaimed by the lease timeout or a cleanup hook, never by `Drop` of the batch value.

Deprecated constructor: `Env::create_threadsafe_function(&self, func: &JsFunction, _max_queue_size: usize, callback: R)` is gated on `all(feature = "napi4", feature = "compat-mode")`, deprecated since 2.17.0, and its body is `ThreadsafeFunction::<T, Unknown, V>::create(self.0, func.0.value, callback)`, which ignores the queue size argument (the default `MaxQueueSize` of 0 means unbounded). It must not be used for the bounded dispatcher.

## 3. napi 3.14.0 instance data, cleanup hooks, Cargo features

Sources: `https://docs.rs/napi/3.14.0/napi/struct.Env.html`, source `https://docs.rs/napi/3.14.0/src/napi/env.rs.html`, `https://raw.githubusercontent.com/napi-rs/napi-rs/napi-v3.14.0/crates/napi/Cargo.toml`, `https://raw.githubusercontent.com/napi-rs/napi-rs/napi-sys-v3.4.0/crates/sys/Cargo.toml`, `.../napi-sys-v3.4.0/crates/sys/src/lib.rs`.

- `#[cfg(feature = "napi6")] pub fn set_instance_data<T, Hint, F>(&self, native: T, hint: Hint, finalize_cb: F) -> Result<()> where T: 'static, Hint: 'static, F: FnOnce(FinalizeContext<T, Hint>)`. Doc: "This API associates data with the currently running Agent. ... Any existing data associated with the currently running Agent which was set by means of a previous call to Env::set_instance_data() will be overwritten. If a finalize_cb was provided by the previous call, it will not be called." Since 3.13.0 the payload is registered and `get_instance_data` refuses a pointer that this API did not set (read in source; changelog #3540).
- `#[cfg(feature = "napi6")] pub fn get_instance_data<T>(&self) -> Result<Option<&'static mut T>>`. It hands out `&'static mut T` on each call, so two calls alias a mutable reference; the binding should call it once per entry and never hold two results.
- `#[cfg(feature = "napi3")] pub fn add_env_cleanup_hook<T, F>(&self, cleanup_data: T, cleanup_fn: F) -> Result<CleanupEnvHook<T>> where T: 'static, F: 'static + FnOnce(T)` and `remove_env_cleanup_hook<T>(&self, hook: CleanupEnvHook<T>) -> Result<()>`.
- `#[cfg(feature = "napi8")] add_removable_async_cleanup_hook` and `add_async_cleanup_hook`: not available with the `napi6` feature the binding pins.
- Cargo features of napi 3.14.0: `default = ["napi4", "dyn-symbols"]`, `napi6 = ["napi5", "napi-sys/napi6"]`, `napi7 = ["napi6", "napi-sys/napi7"]`, `napi8 = ["napi7", ...]`, up to `napi10`; `compat-mode = []`; `tokio_rt = ["tokio", "napi4"]`; `async-runtime = ["napi4"]`; `dyn-symbols = ["napi-sys/dyn-symbols"]`; `noop = []`. Normal dependencies: bitflags 2, ctor 1.0.0 (default-features false), nohash-hasher 0.2.0, rustc-hash 2.1.1, napi-sys 3.4.0, libc 0.2 on unix; optional anyhow, encoding_rs, chrono, tracing, tokio.
- napi-sys 3.4.0: `default = ["dyn-symbols"]`, `libloading = { version = "0.9" }` is a non-optional dependency. Read in source: on `target_env = "msvc"` the Node-API symbols are always loaded at run time through libloading; on other targets they are loaded at run time only with `dyn-symbols`, otherwise declared as plain `extern "C"` and resolved by the host at load. `bindings/node/Cargo.toml` uses `default-features = false`, which turns `dyn-symbols` off.
- Consequence for the pinned feature set `features = ["napi6"]`: `ArrayBuffer::detach` and `ArrayBuffer::is_detached` are `#[cfg(feature = "napi7")]` (section 4), so the staging pool's detach-at-send needs `napi7` at least. Every Node line supported today provides Node-API 8 or later (section 6).

## 4. napi 3.14.0 Buffer and ArrayBuffer constructors

Sources: `https://docs.rs/napi/3.14.0/napi/bindgen_prelude/struct.ArrayBuffer.html`, `https://raw.githubusercontent.com/napi-rs/napi-rs/napi-v3.14.0/crates/napi/src/bindgen_runtime/js_values/arraybuffer.rs`, `.../js_values/buffer.rs`, the same arraybuffer.rs at tag `napi-v3.13.0` and at `main`.

Copies into JavaScript-owned memory:

- `BufferSlice::copy_from<D: AsRef<[u8]>>(env: &Env, data: D) -> Result<Self>`: calls `napi_create_buffer_copy(env, len, data_ptr, NULL, &buf)` and points the Rust view at the engine-owned copy via `napi_get_buffer_info` (read in source). This is a real copy into a Node `Buffer`; it is the constructor that matches the design's "JavaScript-owned copy" for `zero_req_body` and WebSocket payloads.
- `ArrayBuffer::copy_from<D: AsRef<[u8]>>(env, data)` (doc: "Copy data from a &[u8] and create a ArrayBuffer from it.") calls `napi_create_arraybuffer(env, len, &underlying_data, &value)` and returns. It never writes `data` into the new allocation. The same holds for the macro-generated `Int8ArraySlice`, `Uint8ArraySlice`, `Int16ArraySlice`, `Uint16ArraySlice`, `Int32ArraySlice`, `Uint32ArraySlice`, `Float32ArraySlice`, `Float64ArraySlice`, `BigInt64ArraySlice`, `BigUint64ArraySlice` and `Uint8ClampedSlice` `copy_from`, which also pass the element count, not the byte count, to `napi_create_arraybuffer`. Read in source at tags napi-v3.13.0 and napi-v3.14.0 and on main: identical. These constructors must not be used for body copies; a test that compares bytes would catch it.

Zero-copy and external constructors:

- `impl From<Vec<u8>> for Buffer` then `ToNapiValue for Buffer`: creates an external buffer over the Rust `Vec` with a `drop_buffer` finalizer, falling back to `napi_create_buffer_copy` only when the runtime reports `napi_no_external_buffers_allowed` (read in source). JavaScript gets a mutable view of Rust-allocated memory freed at garbage collection; this is not a copy.
- `ArrayBuffer::from_data<D: Into<Vec<u8>>>(env, data)`: `napi_create_external_arraybuffer` over the `Vec` with a `finalize_slice` finalizer; copy fallback on `napi_no_external_buffers_allowed`.
- `pub unsafe fn ArrayBuffer::from_external<T: 'env, F: FnOnce(Env, T)>(env: &Env, data: *mut u8, len: usize, finalize_hint: T, finalize_callback: F) -> Result<Self>`: "The caller must ensure that: The data pointer is valid for the lifetime of the buffer and points to a memory region of at least len bytes; The finalize callback properly cleans up the data" and "JavaScript may mutate the data passed in to this buffer when writing the buffer. However, some JavaScript runtimes do not support external buffers (notably electron!) in which case modifications may be lost." Read in source: returns `InvalidArg` "Borrowed data should not be null" for a null pointer; in debug builds on non-Windows it panics if the same pointer is already backing another buffer ("Share the same data between different buffers is not allowed"); on `napi_no_external_buffers_allowed` it copies, then runs the finalizer immediately.
- `pub unsafe fn BufferSlice::from_external` has the same contract for Node `Buffer`.
- `#[cfg(feature = "napi7")] pub fn ArrayBuffer::detach(self) -> Result<()>` calls `napi_detach_arraybuffer`; doc: "Generally, an ArrayBuffer is non-detachable if it has been detached before. The engine may impose additional conditions on whether an ArrayBuffer is detachable. For example, V8 requires that the ArrayBuffer be external, that is, created with napi_create_external_arraybuffer". `#[cfg(feature = "napi7")] pub fn is_detached(&self) -> Result<bool>`: "The ArrayBuffer is considered detached if its internal data is null."
- `pub unsafe fn ArrayBuffer::as_mut(&mut self) -> &mut [u8]`: "This is literally undefined behavior, as the JS side may always modify the underlying buffer, without synchronization."
- Deprecated `Env` constructors (since 3.0.0): `create_buffer_copy` ("Use BufferSlice::copy_from instead"), `create_buffer_with_borrowed_data` ("Use BufferSlice::from_external instead"), `create_arraybuffer_with_borrowed_data` ("Use ArrayBuffer::from_external instead").
- `Env::adjust_external_memory(&self, size: i64)` exists; its doc says not to combine it with `create_buffer_with_data`/`create_arraybuffer_with_data`, which already call it.

## 5. napi-derive 3.6.10, napi-build 2.6.0, @napi-rs/cli 3.10.6

- `https://docs.rs/napi-derive/3.6.10/napi_derive/index.html`: attribute macros `module_init` and `napi`.
- `https://docs.rs/napi-build/2.6.0/napi_build/fn.setup.html`: `pub fn setup()`, "Configure the build of a napi-rs addon crate. Call it from the addon's build.rs." It also sets a crate-local `cfg(napi_wasi_threads)` for `wasm32-wasip1-threads`.
- `https://raw.githubusercontent.com/napi-rs/napi-rs/%40napi-rs/cli%403.10.6/cli/src/def/build.ts`: the `build` command accepts `--platform`, `--release,-r`, `--package-json-path`, `--output-dir,-o`, `--target,-t`, `--manifest-path`, `--cross-compile,-x`, `--use-napi-cross`, `--features,-F`, `--no-default-features`, `--strip,-s`, `--profile`, `--js`, `--no-js`, `--dts`, `--esm`, `--const-enum` among others. The repo's `build:native` script flags exist in 3.10.6.

## 6. Node.js support windows and the engines line

Sources: `https://nodejs.org/en/about/previous-releases`, `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json`, `https://nodejs.org/dist/index.json`.

| Line | Status today | LTS start | Maintenance start | End of life | Latest release (date) | NODE_MODULE_VERSION |
| --- | --- | --- | --- | --- | --- | --- |
| 20 (Iron) | End-of-life | 2023-10-24 | 2024-10-22 | 2026-04-30 | v20.20.2 (2026-03-24) | 115 |
| 22 (Jod) | Maintenance LTS | 2024-10-29 | 2025-10-21 | 2027-04-30 | v22.23.3 (2026-09-23) | 127 |
| 24 (Krypton) | Active LTS | 2025-10-28 | 2026-10-20 | 2028-04-30 | v24.21.0 (2026-09-07) | 137 |
| 26 | Current | 2026-10-28 | 2027-10-20 | 2029-04-30 | v26.10.0 (2026-09-21) | 147 |
| 27 | not released | | 2027-10-20 | 2030-04-30 | start 2027-04-22 | |

Quotations: "Starting with Node.js 27, the release cycle will be annual and every major version will move to LTS status after its six-month Current phase (and six additional months of Alpha phase)." "LTS release status is 'long-term support', which typically guarantees that critical bugs will be fixed for a total of 30 months." "Production applications should only use Active LTS or Maintenance LTS releases."

Repository state compared with that: every package under `bindings/node/packages/*/package.json` declares `"engines": { "node": ">= 16" }`, and `.github/workflows/node.yml` runs `node-version: 20`. Node 16 reached end of life on 2023-09-11 and Node 20 on 2026-04-30, so both values point at unsupported lines. The supported lines today are 22, 24 and 26; the lowest is 22. Node-API docs below were read for v22.23.3 and cross-checked on v24.21.0 and v26.10.0.

## 7. Node-API documentation (Node v22.23.3)

Source: `https://nodejs.org/docs/latest-v22.x/api/n-api.html` (page banner "Node.js v22.23.3"); cross-checks on `https://nodejs.org/docs/latest-v24.x/api/n-api.html` (v24.21.0) and `https://nodejs.org/docs/latest-v26.x/api/n-api.html` (v26.10.0) show the same version matrix, the same `max_queue_size` line and the same `napi_detach_arraybuffer` text.

Node-API version matrix: 10 in "v22.14.0+, 23.6.0+ and all later versions"; 9 in "v18.17.0+, 20.3.0+, 21.0.0 and all later versions"; 8 in "v12.22.0+, v14.17.0+, v15.12.0+, 16.0.0 and all later versions"; 7 in "v10.23.0+, v12.19.0+, v14.12.0+, 15.0.0 and all later versions"; 6 in "v10.20.0+, v12.17.0+, 14.0.0 and all later versions". "If NAPI_VERSION is not set it will default to 8."

Thread-safe functions:

- "If an addon creates additional threads, then Node-API functions that require a napi_env, napi_value, or napi_ref must not be called from those threads."
- `napi_create_threadsafe_function(env, func, async_resource, async_resource_name, size_t max_queue_size, size_t initial_thread_count, thread_finalize_data, thread_finalize_cb, context, call_js_cb, result)`, Added in v10.6.0, N-API version 4. "[in] max_queue_size: Maximum size of the queue. 0 for no limit." "[in] initial_thread_count: The initial number of acquisitions, i.e. the initial number of threads, including the main thread, which will be making use of this function." Change history: "Version 10 (NAPI_VERSION is defined as 10 or higher): Uncaught exceptions thrown in call_js_cb are handled with the 'uncaughtException' event, instead of being ignored."
- Calling: "If set to napi_tsfn_nonblocking, the API behaves non-blockingly, returning napi_queue_full if the queue was full, preventing data from being successfully added to the queue. If set to napi_tsfn_blocking, the API blocks until space becomes available in the queue. napi_call_threadsafe_function() never blocks if the thread-safe function was created with a maximum queue size of 0." "napi_call_threadsafe_function() should not be called with napi_tsfn_blocking from a JavaScript thread, because, if the queue is full, it may cause the JavaScript thread to deadlock."
- `napi_call_threadsafe_function(func, void* data, napi_threadsafe_function_call_mode is_blocking)`: "napi_tsfn_nonblocking to indicate that the call should return immediately with a status of napi_queue_full whenever the queue is full." "This API will return napi_closing if napi_release_threadsafe_function() was called with abort set to napi_tsfn_abort from any thread. The value is only added to the queue if the API returns napi_ok. This API may be called from any thread which makes use of func." History: v14.1.0 added `napi_would_deadlock`, v14.5.0 reverted it.
- `call_js_cb` "is invoked on the main thread once for each value that was placed into the queue". "The callback may also be invoked with env and call_js_cb both set to NULL to indicate that calls into JavaScript are no longer possible, while items remain in the queue that may need to be freed. This normally occurs when the Node.js process exits while there is a thread-safe function still active." The typedef text: data "is managed entirely by the threads and this callback. Thus this callback should free the data." "Zero or more queued items may be invoked in each tick of the event loop."
- Reference counting: "napi_threadsafe_function objects are destroyed when every thread which uses the object has called napi_release_threadsafe_function() or has received a return status of napi_closing in response to a call to napi_call_threadsafe_function. The queue is emptied before the napi_threadsafe_function is destroyed." "do not use a thread-safe function after receiving a return value of napi_closing". "Once the number of threads making use of a napi_threadsafe_function reaches zero ... all subsequent API calls associated with it, except napi_release_threadsafe_function(), will return an error value of napi_closing." `napi_tsfn_abort` makes later calls return `napi_closing` "even before its reference count reaches zero".
- Process lifetime: "A 'referenced' thread-safe function will cause the event loop on the thread on which it is created to remain alive until the thread-safe function is destroyed. In contrast, an 'unreferenced' thread-safe function will not prevent the event loop from exiting." `napi_ref_threadsafe_function` and `napi_unref_threadsafe_function` take `(node_api_basic_env env, napi_threadsafe_function func)`, are idempotent, and "This API may only be called from the main thread." "Neither does napi_unref_threadsafe_function mark the thread-safe functions as able to be destroyed nor does napi_ref_threadsafe_function prevent it from being destroyed."

Instance data (N-API version 6, added v12.8.0 and v10.20.0): `napi_set_instance_data(node_api_basic_env env, void* data, napi_finalize finalize_cb, void* finalize_hint)`: "[in] finalize_cb: The function to call when the environment is being torn down." "Any existing data associated with the currently running Node.js environment which was set by means of a previous call to napi_set_instance_data() will be overwritten. If a finalize_cb was provided by the previous call, it will not be called." `napi_get_instance_data`: "If no data is set, the call will succeed and data will be set to NULL." Section intro: "A Node.js environment corresponds to an ECMAScript Agent. In the main process, an environment is created at startup, and additional environments can be created on separate threads to serve as worker threads." "the bindings it provides may be called multiple times, from multiple contexts, and even concurrently from multiple threads."

Cleanup hooks: `napi_add_env_cleanup_hook(node_api_basic_env env, napi_cleanup_hook fun, void* arg)`, N-API version 3: "Registers fun as a function to be run with the arg parameter once the current Node.js environment exits." "Providing the same fun and arg values multiple times is not allowed and will lead the process to abort." "The hooks will be called in reverse order, i.e. the most recently added one will be called first." `napi_remove_env_cleanup_hook`: "The function must have originally been registered with napi_add_env_cleanup_hook, otherwise the process will abort." `napi_add_async_cleanup_hook` is N-API version 8.

ArrayBuffers and Buffers:

- `napi_detach_arraybuffer(napi_env env, napi_value arraybuffer)`, added v13.0.0, v12.16.0, v10.22.0, N-API version 7: "Returns napi_ok if the API succeeded. If a non-detachable ArrayBuffer is passed in it returns napi_detachable_arraybuffer_expected. Generally, an ArrayBuffer is non-detachable if it has been detached before. The engine may impose additional conditions on whether an ArrayBuffer is detachable. For example, V8 requires that the ArrayBuffer be external, that is, created with napi_create_external_arraybuffer. This API represents the invocation of the ArrayBuffer detach operation as defined in Section detachArrayBuffer of the ECMAScript Language Specification." This closes the design's open note that the text "could not be retrieved".
- `napi_is_detached_arraybuffer`, N-API version 7: "The ArrayBuffer is considered detached if its internal data is null."
- `napi_create_external_arraybuffer`, N-API version 1: "The caller must ensure that the byte buffer remains valid until the finalize callback is called." "On runtimes other than Node.js this method may return napi_no_external_buffers_allowed to indicate that external buffers are not supported. One such runtime is Electron". `NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED` hides the two external-buffer functions.
- `napi_create_buffer_copy(env, size_t length, const void* data, void** result_data, napi_value* result)`, N-API version 1: "This API allocates a node::Buffer object and initializes it with data copied from the passed-in buffer."
- `napi_create_external_buffer`: same external-buffer caveats; "For Node.js >=4 Buffers are Uint8Arrays."

Module registration: "All Node-API addons are context-aware, meaning they may be loaded multiple times."

## 8. Addons and worker_threads (Node v22.23.3)

Sources: `https://nodejs.org/docs/latest-v22.x/api/addons.html`, `https://nodejs.org/docs/latest-v22.x/api/worker_threads.html`, `https://nodejs.org/docs/latest-v22.x/api/os.html`.

- Worker support: "In order to be loaded from multiple Node.js environments, such as a main thread and a Worker thread, an add-on needs to either: Be an Node-API addon, or Be declared as context-aware using NODE_MODULE_INIT()". "In order to support Worker threads, addons need to clean up any resources they may have allocated when such a thread exits." Cleanup callbacks "are run in last-in first-out order."
- Context-aware addons: "Since the addon may be loaded multiple times, potentially even from different threads, any global static data stored in the addon must be properly protected, and must not contain any persistent references to JavaScript objects. The reason for this is that JavaScript objects are only valid in one context, and will likely cause a crash when accessed from the wrong context or from a different thread than the one on which they were created."
- Worker environment differences (worker_threads page): "Signals are not delivered through process.on('...')." "Execution may stop at any point as a result of worker.terminate() being invoked." "Native add-ons can only be loaded from multiple threads if they fulfill certain conditions." Signal wiring for `zero_server_shutdown` therefore belongs on the main thread.
- `worker.terminate()`: "Stop all JavaScript execution in the worker thread as soon as possible. Returns a Promise for the exit code that is fulfilled when the 'exit' event is emitted."
- `worker.unref()`: "Calling unref() on a worker allows the thread to exit if this is the only active handle in the event system."
- `worker.markAsUntransferable(object)`: "Mark an object as not transferable. If object occurs in the transfer list of a port.postMessage() call, an error is thrown." "Node.js marks the ArrayBuffers it uses for its Buffer pool with this." "This operation cannot be undone." The documented effect is on `postMessage` transfer lists.
- Transfer note: "for Buffers created from the internal Buffer pool (using, for instance Buffer.from() or Buffer.allocUnsafe()), transferring them is not possible and they are always cloned". "The ArrayBuffers for Buffer instances created using Buffer.alloc() or Buffer.allocUnsafeSlow() can always be transferred".
- `os.availableParallelism()` is listed in the v22 `os` module index.

## 9. loom 0.7.2

Sources: `https://docs.rs/loom/0.7.2/loom/index.html`, `.../constant.MAX_THREADS.html`, `.../model/struct.Builder.html`, `.../fn.model.html`, `.../sync/index.html`, `.../sync/atomic/index.html`, `.../sync/atomic/struct.AtomicU64.html`, `.../thread/index.html`, `.../cell/index.html`, `.../cell/struct.UnsafeCell.html`, `.../cell/struct.Cell.html`.

- `pub fn model<F>(f: F) where F: Fn() + Sync + Send + 'static`: "Run all concurrent permutations of the provided closure. Uses a default Builder which can be affected by environment variables."
- "Test cases using loom must be fully deterministic. All sources of non-determism must be via loom types". "Any code that does not use loom's replacement types is invisible to loom".
- Setup: "It is recommended to use a loom cfg flag to signal using the loom types. You can do this by passing RUSTFLAGS="--cfg loom"" and in Cargo.toml `[target.'cfg(loom)'.dependencies] loom = "0.7"`, with a `sync` module that re-exports `loom::sync::atomic::AtomicUsize` under `#[cfg(loom)]` and `std::sync::atomic::AtomicUsize` under `#[cfg(not(loom))]`. Run: `RUSTFLAGS="--cfg loom" cargo test --test loom_my_struct --release`.
- `pub const MAX_THREADS: usize = 5;` "Maximum number of threads that can be included in a model." `Builder.max_threads` "must be less than MAX_THREADS".
- `model::Builder` (non_exhaustive) fields: `max_threads`, `max_branches` (LOOM_MAX_BRANCHES), `max_permutations` (LOOM_MAX_PERMUTATIONS), `max_duration` (LOOM_MAX_DURATION), `preemption_bound` (LOOM_MAX_PREEMPTIONS), `checkpoint_file` (LOOM_CHECKPOINT_FILE), `checkpoint_interval` (LOOM_CHECKPOINT_INTERVAL), `expect_explicit_explore`, `location` (LOOM_LOCATION), `log` (LOOM_LOG). Methods `new()`, `checkpoint_file(&mut self, &str)`, `check<F>(&self, f: F) where F: Fn() + Sync + Send + 'static`. "setting the thread pre-emption bound to 2 or 3 is enough to catch most bugs while significantly reducing the number of possible executions."
- `loom::sync::atomic` mocks AtomicBool, AtomicI8 to AtomicI64, AtomicIsize, AtomicPtr, AtomicU8 to AtomicU64, AtomicUsize, plus `fence`; `Ordering` is re-exported from std. `AtomicU64` has `new`, `with_mut`, `unsafe fn unsync_load`, `into_inner`, `load`, `store`, `swap`, `compare_and_swap`, `compare_exchange(&self, current: u64, new: u64, success: Ordering, failure: Ordering) -> Result<u64, u64>`, `compare_exchange_weak`, `fetch_add`, `fetch_sub`, `fetch_and`, `fetch_nand`, `fetch_or`, `fetch_xor`, `fetch_max`, `fetch_min`, `fetch_update`.
- `loom::sync` mocks Arc, Condvar, Mutex, RwLock, Notify; Barrier "is not supported yet in Loom".
- `loom::thread`: `spawn`, `yield_now`, `park`, `current`, `JoinHandle`, `Builder`. Spin loops "must include calls to loom::thread::yield_now".
- `loom::cell::UnsafeCell` replaces `get()` with `with(&self, f: FnOnce(*const T) -> R)` and `with_mut(&self, f: FnOnce(*mut T) -> R)`, which "panic if the access is not valid under the Rust memory model". Reading through the raw pointer needs `unsafe`, which `zero-rt` forbids. `loom::cell::Cell` is safe but its auto traits are `!Sync` and `Send`, so it cannot be shared between modeled threads. A safe-Rust model of "a stale id reads another request's data" therefore has to represent the slot payload with loom atomics (for example an atomic that stores the owning id, checked by the modeled accessor) rather than with `UnsafeCell`.
- Limits: "it is not possible for loom to completely model all the interleavings that relaxed memory ordering allows" (it cannot reorder operations within one thread).
- Implementation: "Loom is an implementation of techniques described in CDSChecker".
- `cfg(loom)` and lints (`https://doc.rust-lang.org/rustc/check-cfg/cargo-specifics.html`): a custom static cfg is declared with `[lints.rust] unexpected_cfgs = { level = "warn", check-cfg = ['cfg(has_foo)'] }`; build scripts use `cargo::rustc-check-cfg=cfg(...)`. The workspace `Cargo.toml` has no `loom` or `check-cfg` entry today, and the copied lint tables would need the same line.

## 10. cbindgen 0.29.4

Sources: `https://raw.githubusercontent.com/mozilla/cbindgen/v0.29.4/docs.md`, `.../v0.29.4/CHANGES`, `.../v0.29.4/src/bindgen/utilities.rs`, `.../v0.29.4/src/bindgen/parser.rs`.

- docs.md: cbindgen emits `#[no_mangle] pub extern fn` ("functions") and `#[no_mangle] pub static` ("globals"); honors `#[repr(C)]`, `#[repr(u8, u16, ...)]`, `#[repr(transparent)]`, `#[repr(align(N))]` and `#[repr(packed)]`, not `#[repr(packed(N))]`.
- Read in source: `SynAbiHelpers::is_c` matches `"C" | "C-unwind"`, and the function loader takes a function when `is_extern_c` (ABI omitted, "C", "C-unwind" or a CMSE ABI) and it has an exported name (`no_mangle` or `export_name`); otherwise it logs "Skipping ... (not `no_mangle`, and has no `export_name` attribute)" or "Skipping ... (not `extern \"C\"`)". So exports declared `extern "C-unwind"` are emitted into the header like `extern "C"` ones.
- CHANGES: 0.29.4 "Support constant enums and arrays."; 0.29.3 exposes `line_endings` to the builder and "In C23 mode, define sized enums as enums rather than typedefs."; 0.29.0 "Added test for unsafe(no_mangle) attribute"; 0.28.0 "Parse unsafe attributes".

## 11. Panics, unwinding and the C ABI

Sources: `https://doc.rust-lang.org/reference/panic.html`, `https://doc.rust-lang.org/reference/items/functions.html` (section `items.fn.extern.unwind`), `https://doc.rust-lang.org/std/panic/fn.catch_unwind.html` and `.../struct.AssertUnwindSafe.html` (rustdoc 1.99.0, b940084d7 2026-09-28), `https://blog.rust-lang.org/2024/09/05/Rust-1.81.0/`, `https://blog.rust-lang.org/2023/07/13/Rust-1.71.0/`, `https://api.github.com/repos/rust-lang/rust/releases/latest`.

- Current stable Rust: 1.99.0, released 2026-10-01. The repo's `rust-toolchain.toml` says `channel = "stable"` (no version pinned); workspace and binding `rust-version` is 1.89.
- Reference `items.fn.extern.unwind.behavior` table: with panic=unwind, a panic reaching a non-unwinding ABI boundary ("C", "system", ...) is "abort", and a native (foreign) unwind reaching it is "undefined behavior"; at an unwinding ABI boundary ("C-unwind") both "unwind". With panic=abort, a panic "aborts without unwinding" either way. `items.fn.extern.abort`: "With panic=unwind, when a panic is turned into an abort by a non-unwinding ABI boundary, either no destructors (Drop calls) will run, or all destructors up until the ABI boundary will run. It is unspecified which of those two behaviors will happen."
- Rust 1.81 release notes: "As of 1.81, the non-unwind ABIs (e.g., "C") will now abort on uncaught unwinds, closing the longstanding soundness problem." "Programs relying on unwinding should transition to using -unwind suffixed ABI variants." Rust 1.71: "1.71.0 stabilizes C-unwind (and other -unwind suffixed ABI variants)."
- Correction to DESIGN.md section 8.1 ("unwinding across `extern "C"` is undefined behavior"): at rust-version 1.89 a Rust panic escaping an `extern "C"` export is defined and aborts the whole host process (Node, Python or .NET); undefined behavior remains only for a foreign unwind (for example a C++ exception) entering Rust through a "C" declaration, and for calling a "C-unwind" export from code that does not support unwinding. `catch_unwind` at every export is still needed, because the requirement is to return `ZeroStatus::Panic` instead of aborting.
- `panic.unwind.ffi.catch-foreign`: catching a foreign unwind with `catch_unwind` either aborts or returns an opaque `Err`, unspecified which; "Rust code compiled or linked with a different instance of the Rust standard library counts as a 'foreign exception'". `panic.unwind.ffi.dispose-panic`: "an unwind originated from a Rust runtime must either lead to termination of the process or be caught by the same runtime." Relevant to the plugin vtable: a panic in a plugin built against another std must not cross into the core.
- `pub fn catch_unwind<F: FnOnce() -> R + UnwindSafe, R>(f: F) -> Result<R>`: "Rust functions that are expected to be called from foreign code that does not support unwinding (such as C compiled with -fno-exceptions) should be defined using extern "C", which ensures that if the Rust code panics, it is automatically caught and the process is aborted." Notes: "This function only catches unwinding panics, not those that abort the process." "If a custom panic hook has been set, it will be invoked before the panic is caught, before unwinding." "be careful in how you drop the result of this function. If it is Err, it contains the panic payload, and dropping that may in turn panic!"
- `AssertUnwindSafe<T>(pub T)`: "A simple wrapper around a type to assert that it is unwind safe."
- Reference `panic.panic_handler.std.no_std`: "Linking a no_std binary, dylib, cdylib, or staticlib will require specifying your own panic handler."

## 12. ANSSI secure Rust guide, FFI rules

Sources: `https://anssi-fr.github.io/rust-guide/checklist.html`, `https://anssi-fr.github.io/rust-guide/unsafe/ffi.html` (the guide is titled "Secure Rust Guidelines (unstable)"; last commit to ANSSI-FR/rust-guide 3f9e2e2809 on 2026-05-18). The older path `https://anssi-fr.github.io/rust-guide/07_ffi.html` returns 404; cite `unsafe/ffi.html#<ID>`.

Checklist ids and kinds: FFI-SAFEWRAPPING (Recommendation), FFI-CTYPE (Rule), FFI-TCONS (Rule), FFI-AUTOMATE (Recommendation), FFI-PFTYPE (Rule), FFI-CKNONROBUST (Rule), FFI-CKINRUST (Recommendation), FFI-CK-PTR-VALID (Rule), FFI-INPUT-PTR (Recommendation), FFI-CK-INPUT-REF-VALID (Rule), FFI-MARKEDFUNPTR (Rule), FFI-CKFUNPTR (Rule), FFI-NOENUM (Rule), FFI-R-OPAQUE (Recommendation), FFI-C-OPAQUE (Recommendation), FFI-CK-REF-MODEL (Rule), FFI-MEM-NODROP (Rule), FFI-MEM-OWNER (Rule), FFI-MEM-WRAPPING (Recommendation), FFI-NOPANIC (Recommendation), FFI-CAPI (Rule).

Texts:

- FFI-NOPANIC (Recommendation, "Handle `panic!` correctly in FFI"): "Rust code called from FFI SHOULD either ensure the function cannot panic, or use a panic handling mechanism (such as std::panic::catch_unwind, std::panic::set_hook, #[panic_handler]) to ensure the rust code will not abort or return in an unstable state. Note that catch_unwind will only catch unwinding panics, not those that abort the process." The example is `#[unsafe(no_mangle)] pub unsafe extern "C" fn no_panic() -> i32 { let result = catch_unwind(may_panic); match result { Ok(_) => 0, Err(_) => -1, } }`. DESIGN.md calls it a rule; the guide labels it a Recommendation.
- FFI-CTYPE: "non C-compatible types MUST NOT be used as parameter or return type of imported or exported functions and as types of imported or exported global variables. The lone exception is types that are considered opaque on the foreign side." C-compatible includes integral and floating primitives, `repr(C)` structs, `repr(C)` or `repr(Int)` fieldless enums with at least one variant, raw pointers, `Option<NonNull<U>>`, `core::num::NonZero*`, single-field `repr(transparent)` structs.
- FFI-NOENUM: "the Rust code MUST NOT accept incoming values of any Rust enum type." Exceptions: types opaque to the foreign side or bound to safe foreign enumerations such as C++ `enum class`. Inputs such as a method id or an opcode must arrive as integers and be converted with a checked conversion; returning `ZeroStatus` is outgoing and allowed by FFI-CTYPE.
- FFI-CK-PTR-VALID: "any Rust code that dereferences a foreign pointer MUST check their validity beforehand. In particular, pointers MUST be checked to be non-null before any use."
- FFI-CKNONROBUST: "there MUST NOT be any use of unchecked foreign values of non-robust types."
- FFI-CK-INPUT-REF-VALID: "every foreign reference that is transmitted to Rust through FFI MUST be checked on the foreign side either automatically (for instance, by a compiler) or manually."
- FFI-CK-REF-MODEL: "the use of indirection (pointers, references) crossing the boundary MUST preserve Rust's memory model." Its example is UB when C passes the same pointer as two `&mut`.
- FFI-MARKEDFUNPTR: "any function pointer types at the FFI boundary MUST be marked extern (possibly with the specific ABI) and unsafe." It suggests `Option`-wrapped function pointers checked against null. FFI-CKFUNPTR: "any foreign function pointer MUST be checked at the FFI boundary." Both apply to `release_fn` and the plugin vtable.
- FFI-MEM-NODROP: "Rust code MUST NOT implement Drop for any types that are directly transmitted to foreign code (i.e. not through a pointer or reference)."
- FFI-MEM-OWNER: "when data of some type passes without copy through a FFI boundary, one MUST ensure that: A single language is responsible for both allocation and deallocation of data. The other language MUST NOT allocate or free the data directly but use dedicated foreign functions provided by the chosen language."
- FFI-CAPI: "exposing a Rust library to a foreign language SHOULD only be done through a dedicated C-compatible API. The crate cbindgen may be used to automatically generate C or C++ bindings".

## 13. ThreadSanitizer (`-Zsanitizer=thread`)

Source: `https://doc.rust-lang.org/nightly/unstable-book/compiler-flags/sanitizer.html`.

- Tracking issues #39699 and #89653. ThreadSanitizer is listed among sanitizers "intended for testing or fuzzing (but not production use)".
- Enable with `-Zsanitizer=thread`; "You might also need the --target and build-std flags." Example: `export RUSTFLAGS=-Zsanitizer=thread RUSTDOCFLAGS=-Zsanitizer=thread` then `cargo run -Zbuild-std --target x86_64-unknown-linux-gnu`.
- Supported targets: aarch64-apple-darwin, aarch64-unknown-linux-gnu, x86_64-apple-darwin, x86_64-unknown-freebsd, x86_64-unknown-linux-gnu. Windows is not listed, so the job runs in a Linux container.
- "To work correctly ThreadSanitizer needs to be 'aware' of all synchronization operations in a program. ... Using it without instrumenting all the program code can lead to false positive reports." "ThreadSanitizer does not support atomic fences std::sync::atomic::fence, nor synchronization performed using inline assembly code." The borrow protocol should synchronize through ordered atomic operations on the state word, not through `fence`; `crates/zero-rt/src/slot.rs` currently imports `std::sync::atomic::{AtomicU64, Ordering}` and has no `fence`.
- "It is strongly recommended to combine sanitizers with recompiled and instrumented standard library, for example using cargo -Zbuild-std functionality." On build scripts and procedural macros: "when using cargo always remember to pass --target flag" so the sanitizer rustflags are not applied to them.

## 14. Findings that change or sharpen the design

1. napi 3.14.0 `ThreadsafeFunction::call` leaks the boxed payload whenever the status is not `napi_ok` (QueueFull or Closing from Node). Keep the payload small and make the dispatcher's in-flight cap, not `QueueFull`, the normal back-pressure path.
2. Payloads queued when an isolate's env is torn down are leaked without `Drop` (`call_js_cb` returns early on a NULL env). Slot reclamation after an isolate dies must come from the lease timeout or a cleanup hook.
3. A JavaScript throw from the dispatch callback with `CalleeHandled = false` goes to `napi_fatal_exception`; the per-handler try/catch in the facade is mandatory, and the dispatch function itself must not throw.
4. The bounded function must come from `Function::build_threadsafe_function().callee_handled::<false>().max_queue_size::<4>()`; the deprecated `Env::create_threadsafe_function` ignores its queue size.
5. `ThreadsafeFunction` has no `Clone` in 3.14.0 and its `refer`/`unref` are deprecated and need `&mut self`; share it as `Arc`, and choose between `weak::<true>()`, dropping every clone, or a raw `napi_unref_threadsafe_function` on the isolate thread for the close path. Its `Send`/`Sync` impls do not require `T: Send`.
6. `ArrayBuffer::copy_from` and the typed-array slice `copy_from` constructors do not copy their input (3.13.0, 3.14.0 and main). Use `BufferSlice::copy_from` (napi_create_buffer_copy) for request bodies and WebSocket payloads.
7. `ArrayBuffer::detach` needs the `napi7` cargo feature; `bindings/node/Cargo.toml` enables only `napi6`. Detach works only on external ArrayBuffers in V8, which the staging pool's `from_external` regions are.
8. `engines` `>= 16` and CI `node-version: 20` both name end-of-life lines; the supported lines on 2026-10-01 are 22, 24 and 26.
9. Panics escaping `extern "C"` abort the host process since Rust 1.81 rather than being undefined behavior; DESIGN.md 8.1's wording is outdated, the `catch_unwind` requirement stands.
10. TSan does not model `atomic::fence`; the slot protocol and anything the TSan job exercises should avoid fences.
11. A safe-Rust loom model cannot dereference `loom::cell::UnsafeCell`, and `loom::cell::Cell` is `!Sync`; model the payload ownership with loom atomics.
12. loom 0.7.2 is older than 12 months and `0.x`; record the rationale for a test-only exception. `cfg(loom)` needs a `check-cfg` entry in the lint tables.
13. The lock pins napi 3.13.0, napi-derive 3.6.9, napi-build 2.5.0, napi-sys 3.3.2; the registry moved to 3.14.0, 3.6.10, 2.6.0 and 3.4.0 today (same majors, so not stale under RULES.md; a bump is its own commit).
14. cbindgen 0.29.4 emits `extern "C-unwind"` exports, so the ABI choice does not affect header generation.

## 15. Unverified

- The bounded-function snippet in section 2 was assembled from the published signatures and was not compiled.
- What a `napi_create_arraybuffer` allocation contains when `ArrayBuffer::copy_from` returns it (zero-filled or not) was not fetched; only the absence of the copy was read in source.
- The ECMAScript text for reading a typed-array view after its ArrayBuffer is detached (needed for the detach-after-send vector's assertion) was not fetched.
- Whether `ArrayBuffer.prototype.transfer` honors `markAsUntransferable`, and whether Node's own `Buffer` backing stores are detachable through it, was not fetched; Node documents `markAsUntransferable` only for `postMessage` transfer lists.
- Release notes for napi-build 2.6.0, napi-sys 3.4.0 and @napi-rs/cli 3.10.5 and 3.10.6 were not found on the main-branch changelogs.
- The advisory status of loom's own dependencies (generator, scoped-tls, tracing, tracing-subscriber) was not checked; only loom itself was checked against RustSec.
- Node-API documentation for the lines the repo currently names (16 and 20) was not read, because both are end of life; v22.23.3 was read and v24.21.0 and v26.10.0 were cross-checked for the sections cited.
- napi-rs behavior when a worker isolate terminates while a Rust worker is inside `call` was derived from reading the source (read lock on `aborted`, Node returning `napi_closing`), not from a run.
- The nightly toolchain date to pin for the TSan job, and whether `-Zbuild-std` needs anything beyond the `rust-src` component on it, were not fetched.
- The ANSSI guide is marked "(unstable)"; its rule ids and kinds may change.
