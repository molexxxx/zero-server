<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/zero-logo-animated-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/zero-logo-animated.svg">
  <img alt="zero-server" src="assets/zero-logo-animated.svg" width="520">
</picture>

zero-server is a memory-safe HTTP server core written in Rust that TypeScript,
Python and C# applications run on through one C ABI.

</div>

## Why

Every language today brings its own web framework, and each one rebuilds the same
parsers, the same router and the same connection handling, with its own bugs and
its own ceiling. zero-server is built on the opposite bet: write the server once,
in Rust, and let every language use that one core. Five claims follow from it,
and each is a design rule of this tree, not yet a measured result:

- **One core for every language.** TypeScript, Python and C# get idiomatic
  packages over the same Rust engine, so a fix or a speedup lands in every
  language at once.
- **Faster than the C++ leader, on its own benchmark.** The Rust entry is built
  to beat Drogon, the C++ leader on the TechEmpower workloads, and the claim is
  judged only on a self-run whose method and raw results are published (see
  [Benchmarks](#benchmarks)). No figure is claimed before that run exists.
- **Every parser held to its specification.** Each wire format is implemented
  from the current RFC or specification text, and every statement the code
  relies on is a row in a registry with a test pinned to it.
- **Nothing compiles at install.** The release workflows build the native
  library for seven targets and publish it prebuilt, so on those targets
  installing a binding never needs a Rust toolchain or a C compiler.
- **The hot path never leaves Rust.** Routes, files, policy rules, caching and
  queries are data the core executes itself; code written in the host language
  is reached once per batch of requests, never once per request.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="assets/architecture-narrow-dark.svg">
  <source media="(max-width: 600px)" srcset="assets/architecture-narrow.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="A request arrives at one core's event loop, one per CPU core, and runs along five handler tiers cheapest first: rules, cache, data plan, host handler, Rust handler. It stops at the first tier that answers. Only the host handler tier crosses the C ABI, with one call per batch, to the Node, Python or .NET runtime. The response leaves through the same core." src="assets/architecture.svg" width="960">
</picture>

This is the architecture the releases build; [Status](#status) says which parts
exist today.

**One worker per core, nothing shared.** The core starts one worker per logical
CPU. Each worker is a single-threaded, non-blocking event loop that owns its
listener (where the operating system allows one per core), its request arena and
its cache shard. A connection stays on the core that accepted it for its whole
life, so there are no locks on the request path and no work stealing. The I/O
backend sits behind one seam, `zero-io`: tokio by default, compio behind a
feature.

**Five handler tiers.** A request stops at the cheapest tier that can answer it:

| Tier | What answers | Boundary cost |
| --- | --- | --- |
| 0, declarative | static bodies, files, redirects, health probes, and rules such as CORS, security headers and body limits, evaluated in Rust from tables built once | none |
| 1, cached | the worker's own cache shard, with TTL and tag invalidation | none |
| 2, data | a query plan the core runs on its own database connection and serializes itself | none |
| 3, host handler | a handler in TypeScript, Python or C#, handed a batch of ready requests on the host thread paired with that core | one call per batch |
| 4, Rust | an `async fn` polled on the worker itself | none, in process |

**One C ABI.** `zero-ffi` is the only boundary, and cbindgen generates its
header, `include/zero.h`, on every build. A request crosses it as a 53-bit slot
id into the worker's arena, never as an object: accessors return integers and
borrowed views, an ownership word per slot turns a late access into a `Closed`
status instead of a read of another request's memory, and every export catches
panics so no unwind reaches the host. Node reaches the ABI through napi-rs with
one isolate per core, Python through PyO3 with a handler thread pool, and .NET
through `[LibraryImport]` with one managed thread per core.

**Codecs without an operating system.** Everything that is only bytes in and
bytes out (the HTTP/1.1, QPACK, HTTP/3 frame, WebSocket and server-sent event
codecs, the router, the URI, query string, JSON, base64 and media type parsers,
the limit table, the date formatter and the SIMD scanners) is `no_std` with
`alloc`. CI builds those 16 crates without `std` and cross-compiles them for a
bare-metal Cortex-M target, `thumbv7em-none-eabihf`.

## Using it

Nothing is published yet, so each language uses the core from a checkout of
this repository. What exists today in every language is the smallest program
over the core: load it and read its version. The handler sketch after each of
those calls shows the surface a release is built to ship, with the names the API
contract in `conformance/api-surface.json` gives that language; the sketches do
not run today.

### Rust

`zero-server` is the bundle crate. It re-exports every capability behind a
feature named as the crate without its `zero-` prefix (the static file crate as
`files`), all on by default, so one dependency gives an application the whole
server and turning features off compiles only what it uses:

```toml
[dependencies]
zero-server = { git = "https://github.com/molexxxx/zero-server" }

# or only the HTTP/1.1 codec and the router:
# zero-server = { git = "https://github.com/molexxxx/zero-server", default-features = false, features = ["http1", "router"] }
```

```rust
fn main() {
    assert_eq!(zero_server::core::VERSION, zero_server::VERSION);
    println!("zero-server {}", zero_server::VERSION);
}
```

The default features are `limits`, `simd`, `http-types`, `date`, `http1`,
`router`, `uri`, `qs`, `mime`, `base64`, `json`, `ws`, `sse`, `qpack`, `h3`,
`sys`, `io`, `rt`, `http`, `static`, `policy`, `realtime`, `crypto` and `tls`;
`io-compio` switches the runtime seam to the completion backend. Each
capability is also its own crate, `zero-<capability>`, for an application that
wants only one codec, including on a target with no operating system. The Rust
handler API (tier 4) is designed in release 1 and has no fixed signature yet, so
there is no Rust sketch here.

### TypeScript and Node

From [`bindings/node/guides/version.ts`](bindings/node/guides/version.ts),
after `npm install && npm run build` in `bindings/node`:

```ts
import { version } from '@zero-server/core'

const core = version()
console.log(`zero-server core ${core}`)
```

Shape of a release 1 handler, from the facade surface (not runnable today):

```ts
import { createApp, cors, helmet } from '@zero-server/sdk'

const app = createApp()
app.use(cors({ origin: 'https://example.com' }))
app.use(helmet())

app.get('/users/:id', (req, res) =>
{
  res.json({ id: req.params.id })
})

app.ws('/chat', (ws) =>
{
  ws.on('message', (data) => ws.send(data))
})

app.listen(3000)
```

`cors` and `helmet` become tier 0 rules evaluated in Rust; the `/users/:id`
handler is tier 3 and runs in a batch on the isolate paired with the core that
accepted the connection. Release 1 handlers are buffered: the request body
arrives complete and the response body is handed over in one call.

### Python

From [`bindings/python/guides/version.py`](bindings/python/guides/version.py),
after `maturin develop -m packages/native/Cargo.toml` and installing the other
packages under `bindings/python/packages` into a virtual environment:

```python
from zero_server.core import version

core = version()
print(f"zero-server core {core}")
```

Release 1 ships the Python smoke import; the handler facade follows in release
2. Its shape, from the facade surface (not runnable today):

```python
from zero_server import create_app, cors, helmet

app = create_app()
app.use(cors(origin="https://example.com"))
app.use(helmet())


def user(req, res):
    res.json({"id": req.params["id"]})


app.get("/users/:id", user)
app.listen(3000)
```

### C# and .NET

From [`bindings/dotnet/samples/ZeroServer.Guides/VersionGuide.cs`](bindings/dotnet/samples/ZeroServer.Guides/VersionGuide.cs),
after `cargo build -p zero-ffi --release` and
`dotnet build bindings/dotnet/ZeroServer.sln`:

```csharp
using ZeroServer.Core;

string core = ZeroServerCore.Version;
Console.WriteLine($"zero-server core {core}");
```

Release 1 ships the .NET smoke test; the handler facade follows in release 2, in
minimal-API style with the contract's names in PascalCase. Its shape (not
runnable today; the declaring types are not written yet):

```csharp
using static ZeroServer.Server;

var app = CreateApp();
app.Use(Cors(new CorsOptions { Origin = "https://example.com" }));
app.Use(Helmet());
app.MapGet("/users/{id}", (Request req) => Response.Json(new { id = req.Params["id"] }));
app.Listen(3000);
```

## Status

Every crate, package and binding in this tree is at version 0.1.0, the first
version the release workflows will publish, and nothing has been published to
any registry from this repository yet. In place today: the Cargo workspace with
one crate per capability and its lint table, the C ABI with its generated header
and the `zero_version` export, the three binding skeletons with smoke tests and
guides over that export, the standards registry, the capability catalog, the API
contract, the dependency policy, and the CI, release and documentation
workflows. The capability crates hold their module documentation and version
constant; filling them is the work of release 1.

| Release | What it covers | State |
| --- | --- | --- |
| 1 | HTTP/1.1 with pipelining, the router, static files, and the tier 0 policy rules (CORS, security headers, request ids, trust proxy, body limits); WebSocket and server-sent events with their host-side ABI (receive events, send, close, backpressure); TLS through rustls on both runtime drivers (`io-tokio` by default, `io-compio` behind a feature); the C ABI with its generated header, the slot ownership protocol between the core and a host language, and `zero-sys`, the one crate that makes raw system calls; the Node binding with the TypeScript facade, a .NET smoke test and a Python smoke import over the same library; the QPACK and HTTP/3 frame codecs with their published vectors, ahead of the transport; the two TechEmpower entries and the tiered self-run harness. Handlers are buffered: a request body arrives complete, up to the route's limit, and a response body is handed over in one call. | in development |
| 2 | HTTP/2, streaming request and response bodies, the PostgreSQL driver and tier 2 data routes, compiled templates, the tier 1 cache, the remaining policy rules, JWT verification with JWKS, sessions, body parsers, kTLS, OCSP stapling, mTLS, and the Python and C# facades | planned |
| 3 | HTTP/3 and QUIC, MySQL and MariaDB, MongoDB, Redis, SQLite, the ORM layer, the auth stack, gRPC, observability, WebRTC signaling, compression, the native plugin loader under a documented trust model, and parity with the JavaScript implementation | planned |

The JavaScript implementation that came before this core, `@zero-server/sdk`
1.x on npm, lives in the
[molexxxx/zero-server-node](https://github.com/molexxxx/zero-server-node)
repository. The TypeScript facade in `bindings/node/packages/sdk` is private
until it reaches parity and takes that package name over at 2.0.

## Standards first

[`docs/standards.toml`](docs/standards.toml) is the register of every
specification the core is held to: 515 conformance statements in ten chapters
(HTTP, TLS, real time, HTTP/3, auth, data, gRPC, observability, runtime and
WebRTC), each naming the document as its publisher writes it, the release that
ships the behavior (123 rows in release 1, 139 in release 2, 253 in release 3)
and the test that pins it. `cargo xtask standards --check` fails a release whose
rows have no test, and `cargo xtask links` fetches every cited URL.

The rule behind it: nothing is implemented from memory. Before code touches a
protocol, wire format, parser, header, cookie, cryptographic or authentication
behavior, the cited source is fetched and read, and the code is written from
that text. The rustdoc of the implementing item cites the section, the
conformance test is named after the statement it checks and carries the section
number, and only the current document counts (RFC 9110 to 9112, not 2616). Tests
anchor to the specification's own vectors, and `conformance/vectors.json`,
generated from the core, is asserted by every binding.

## Security

- `unsafe_code = "forbid"` in every crate except the audited ones (in this tree
  `zero-simd`, `zero-server-crypto`, `zero-ffi`, `zero-sys` and the Node and
  Python binding crates), which deny it with per-item allows and a `// SAFETY:`
  comment on every block. [SECURITY.md](SECURITY.md) keeps the unsafe inventory
  per crate and the regression catalog.
- Every third-party crate the workspace links is named in [`deny.toml`](deny.toml);
  any crate not listed is denied. `cargo deny`
  checks licenses and advisories and `cargo vet` checks audits on every push.
- CI runs Miri over the audited and codec crates, AddressSanitizer and
  ThreadSanitizer over the runtime and the C ABI (including a race of a late
  accessor against slot recycle), CodeQL, and a fuzz job that runs every
  libFuzzer target for a minute under AddressSanitizer. Every parser of untrusted
  input is required to carry property tests and a fuzz target and never to panic
  on arbitrary bytes.
- The release C ABI library is built twice in separate containers from the same
  image and must be byte-identical. The release library and the standalone
  binary are checked for position independence, a non-executable stack and full
  RELRO, and a build on the nightly toolchain compiles the C ABI with stack
  protectors and LLVM control-flow integrity over every indirect call.
- Every export of the C ABI catches panics and reports them as a status, never
  as an unwind across the boundary; accessors validate their arguments and
  return a status rather than writing anything invalid, and a binding refuses
  an out-of-range enum value before the call.

## Benchmarks

The core is measured against the archived TechEmpower toolset with the
unmodified Round 23 Drogon entry beside two entries of its own: `zero-server`,
which goes through the router, the limits and the policy rules and is
classified Realistic, and `zero-server-plt`, the raw HTTP/1.1 handler declared
Stripped and Platform, compared with the ceiling reference only. A handler
written in TypeScript, Python or C# is scored against the best entry of its own
language, never against Drogon.

The acceptance is a tiered self-run, because no official round will certify a
result: tier A runs json, db, query, fortunes and updates on one rented Linux
host where the link is not the limiter and reports a ratio against Drogon on
the same hardware; tier B reports plaintext only as a ratio against the ceiling
reference on whatever link exists, since a slower link caps every entry at the
same number; tier C is a final run on rented bare metal with a fast link
between the load generator and the server, the only tier on which a plaintext
ratio against Drogon is published. Five interleaved runs, medians compared, a
win required in every run, error counters at zero at every level, and every
ratio published beside the absolute number.

No throughput or latency figure appears in this repository until such a run
has been made.

## Bindings

| Language | Packages | Over | In release 1 |
| --- | --- | --- | --- |
| TypeScript and Node | `@zero-server/native`, `@zero-server/core`, `@zero-server/sdk` | napi-rs, one isolate per core | the facade |
| Python | `zero-server-native`, `zero-server-core`, `zero-server` | PyO3 on the stable ABI (Python 3.10 and later), a handler thread pool | a smoke import |
| C# and .NET | `ZeroServer.Native`, `ZeroServer.Core`, `ZeroServer` | `[LibraryImport]` declarations mirroring `include/zero.h` | a smoke test |
| C | `crates/zero-ffi/include/zero.h` | the cdylib itself | the header |

The native library is built for Linux gnu and musl on x64 and arm64, macOS x64
and arm64, and Windows x64. `conformance/api-surface.json` is the export
contract: every export has a canonical id, and each binding's declarations are
diffed against it through its own naming map, so a missing export or a changed
parameter list fails the build.

## Layout

| Path | What it holds |
| --- | --- |
| `crates/zero-server` | the bundle: every capability behind a feature |
| `crates/zero-core`, `zero-limits`, `zero-http-types`, `zero-date`, `zero-simd` | errors, buffers and slot ids, the limit table, header and status tables, IMF-fixdate, the SIMD scanners; `no_std` |
| `crates/zero-http1`, `zero-qpack`, `zero-h3`, `zero-ws`, `zero-sse` | the wire codecs; `no_std` |
| `crates/zero-router`, `zero-uri`, `zero-qs`, `zero-json`, `zero-base64`, `zero-mime` | routing and the parsers around a request; `no_std` |
| `crates/zero-sys`, `zero-io`, `zero-rt`, `zero-http` | raw system calls behind checked wrappers, the runtime seam, the per-core workers, the connection driver |
| `crates/zero-tls`, `zero-server-crypto`, `zero-static`, `zero-policy`, `zero-realtime` | TLS over rustls, the crypto primitives, static files, the rule engine, rooms and streams |
| `crates/zero-ffi` | the C ABI and its generated header |
| `crates/zero-serve`, `zero-bench`, `zero-examples`, `xtask` | the standalone binary, the benchmark entries, the examples and vector generator, the task runner; none published |
| `bindings/node`, `bindings/python`, `bindings/dotnet` | the bindings: standalone projects outside the workspace, each with its own lockfile and pipeline |
| `conformance/` | the vectors every binding asserts and the API contract with a naming map per binding |
| `docs/` | the standards registry, the capability catalog (`capabilities.toml`), the three lint tables every manifest copies (`lints/`), and the brand ([`brand.md`](docs/brand.md)) |
| `assets/`, `web/` | the logo, icon and diagrams; the site's palette and front-page data |

## Building and testing

```sh
cargo build --workspace                                # build every crate
cargo test --workspace                                 # tests, including doctests
cargo clippy --workspace --all-targets -- -D warnings  # lint, warnings are errors
cargo fmt --all -- --check                             # format check
just nostd                                             # the no_std crates without std
just guides                                            # the version guide in every language
just ci                                                # everything CI runs
cargo xtask                                            # the workspace tasks
```

The `no_std` crates also cross-compile for `thumbv7em-none-eabihf` in CI, which
is what proves no dependency links `std`. If your toolchain has neither rustfmt
nor clippy, [CONTRIBUTING.md](CONTRIBUTING.md) has the Docker recipe CI uses;
it also covers the standards-first rules and what a change is held to.
[CHANGELOG.md](CHANGELOG.md) has one entry per release for every registry.

## License

Apache License 2.0. See [LICENSE](LICENSE).
