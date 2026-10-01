# zero-core

The zero-server engine: one memory-safe Rust core for HTTP, exposed to Rust,
TypeScript, Python and C# through idiomatic bindings over a single C ABI. Every
parser in it is held to the specification it implements, every crate is
`no_std` where its inputs are bytes, and nothing installs a compiler on a
user's machine.

Release 1 is in development. Every crate, package and binding in this tree is
at version 0.1.0, the first version the release workflows will publish; nothing
has been published to a registry from this repository yet.

## The product and this repository

zero-server is the product. Today it ships as `@zero-server/sdk` on npm, a
zero-dependency Node.js framework written in JavaScript, and that package keeps
its name and its surface. This repository holds the core that package moves
onto:

- `@zero-server/sdk` 1.1.x is the Node implementation. It takes security
  patches and one correctness release, and then no further features.
- `@zero-server/sdk` 2.0 becomes the TypeScript facade over
  `@zero-server/native` (this core, prebuilt) and `@zero-server/core`, with one
  scoped package per capability. `createApp`, the error classes, the Model
  classes, `clusterize` as a shim and the `env` loader keep their shapes; the
  SDK's own test suite is the acceptance suite; anything dropped is a
  documented breaking change in that release's changelog.
- The Python package `zero-server` and the NuGet package `ZeroServer` are the
  same core with a facade in their own language, and every registry name
  follows the crate: `zero-<capability>`, `@zero-server/<capability>`,
  `zero-server-<capability>`, `ZeroServer.<Capability>`.

`conformance/api-surface.json` is the contract between the two: every export of
the Node SDK with a canonical id, generated from its documentation, that each
binding's declarations are diffed against.

## The bindings

| Language | Package | Over |
| --- | --- | --- |
| Rust | `zero-server` on crates.io, or one crate per capability | the crates directly |
| TypeScript and Node | `@zero-server/sdk`, `@zero-server/native`, `@zero-server/core` | napi-rs, with a per-core isolate pool |
| Python | `zero-server`, `zero-server-native`, `zero-server-core` | PyO3 with the stable ABI, a handler thread pool |
| C# and .NET | `ZeroServer`, `ZeroServer.Native`, `ZeroServer.Core` | `[LibraryImport]` declarations mirroring `include/zero.h` |
| C | `crates/zero-ffi/include/zero.h` | the cdylib itself |

Installing a binding never compiles anything: the release workflows build the
native library for seven targets (Linux gnu and musl on x64 and arm64, macOS
x64 and arm64, Windows x64) and publish it prebuilt.

## What release 1 covers

- HTTP/1.1 with pipelining, the router, static files, and the tier 0 policy
  rules (CORS, security headers, request ids, trust proxy, body limits).
- WebSocket and server-sent events with their host-side ABI: receive events,
  send, close, backpressure.
- TLS through rustls on both runtime drivers (`io-tokio` by default,
  `io-compio` behind a feature).
- The C ABI in `zero-ffi` with its generated header, the slot ownership
  protocol between the core and a host language, and `zero-sys`, the one crate
  that makes raw system calls.
- The Node binding with the TypeScript facade, a .NET smoke test and a Python
  smoke import over the same library, so three language hosts can load the
  first release.
- The QPACK and HTTP/3 frame codecs with their published vectors, ahead of the
  transport.
- Release 1 handlers are buffered: a request body arrives complete, up to the
  route's limit, and a response body is handed over in one call. Streaming
  bodies, HTTP/2, the database drivers and the rest of the capability list
  follow in the later releases named in `web/home.toml`.

## Layout

- `crates/`: one crate per responsibility, named `zero-<capability>`;
  `zero-server` is the bundle crate that re-exports every capability behind a
  feature each; `zero-ffi` is the C ABI; `xtask` is the task runner;
  `zero-bench` holds the benchmark entries and is never published.
- `bindings/node`, `bindings/python`, `bindings/dotnet`: standalone crates and
  projects excluded from the workspace, built by their own pipelines.
- `docs/standards.toml`: the register of every specification the core is held
  to, one row per conformance statement with the release that ships it.
  `docs/capabilities.toml` claims every crate once with its lint table and
  release; `docs/lints/` holds the three lint tables every manifest copies.
- `conformance/`: the vectors every binding asserts and the API surface
  contract, both generated.

## Building and testing

```sh
cargo build --workspace                                # build every crate
cargo test --workspace                                 # tests, including doctests
cargo clippy --workspace --all-targets -- -D warnings  # lint, warnings are errors
cargo fmt --all -- --check                             # format check
just nostd                                             # the no_std crates without std
just ci                                                # everything CI runs
cargo xtask                                            # the workspace tasks
```

The `no_std` crates also cross-compile for thumbv7em-none-eabihf in CI, which
is what proves no dependency links std. If your toolchain has neither rustfmt
nor clippy, [CONTRIBUTING.md](CONTRIBUTING.md) has the Docker recipe CI uses.

## Benchmarks

The core is measured against the archived TechEmpower toolset with the
unmodified Round 23 Drogon entry beside two entries of its own: `zero-server`,
which goes through the router, the limits and the policy rules and is
classified Realistic, and `zero-server-plt`, the raw HTTP/1.1 handler declared
Stripped and Platform, compared with the ceiling reference only.

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

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md): building, the standards-first rules, and
  what a change is held to.
- [SECURITY.md](SECURITY.md): reporting, the unsafe inventory per audited
  crate, and the regression catalog.
- [CHANGELOG.md](CHANGELOG.md): every release, one entry for all registries.
- [conformance/README.md](conformance/README.md): the vector format and the
  API surface contract.

## License

Apache License 2.0. See [LICENSE](LICENSE).
