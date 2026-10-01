<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/zero-logo-animated-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/zero-logo-animated.svg">
  <img alt="zero-server" src="assets/zero-logo-animated.svg" width="520">
</picture>

A memory-safe HTTP server core in Rust, being built so that TypeScript, Python
and C# applications run on one engine through one C ABI.

**Pre-release.** Nothing is published and nothing serves requests yet.
Release 1, HTTP/1.1 with the Node binding, is in development.

</div>

## Why

Every language brings its own web framework, and each one rebuilds the same
parsers, the same router and the same connection handling, with its own bugs and
its own limits. zero-server takes the opposite bet: write the server once, in
Rust, and let every language use that one core. Four rules shape the code:

- **One core for every language.** TypeScript, Python and C# get idiomatic
  packages over the same Rust engine, so a fix lands in every language at once.
- **Every parser follows its specification.** Wire formats are written from the
  current RFC text, and every statement the code relies on is a row in a
  registry with a test pinned to it.
- **Installing never compiles.** Bindings are meant to ship prebuilt for seven
  targets, so installing one needs no Rust toolchain and no C compiler.
- **The hot path stays in Rust.** Routes, files, policy rules, caching and
  queries are data the core runs itself; code in the host language is called
  once per batch of requests, not once per request.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="assets/architecture-narrow-dark.svg">
  <source media="(max-width: 600px)" srcset="assets/architecture-narrow.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="A request arrives at one core's event loop, one per CPU core, and runs along five handler tiers cheapest first: rules, cache, data plan, host handler, Rust handler. It stops at the first tier that answers. Only the host handler tier crosses the C ABI, with one call per batch, to the Node, Python or .NET runtime. The response leaves through the same core." src="assets/architecture.svg" width="960">
</picture>

This is the design release 1 builds toward.

**One event loop per CPU core.** Each core runs its own non-blocking loop with
its own listener, memory and cache. A connection stays on the core that accepted
it, so the request path takes no locks.

**Five tiers, cheapest first.** A request stops at the first tier that can
answer it: declarative rules such as CORS and static files, the core's cache, a
data plan the core runs on its own database connection, a handler in the host
language, or a handler in Rust. Only the host-language tier leaves Rust.

**One boundary.** The bindings reach the core through a single C ABI,
`zero-ffi`, whose header is generated on every build. A request crosses it as a
small integer id, never as an object, and a panic never crosses it at all.

**Codecs that need no operating system.** The HTTP/1.1, QPACK, HTTP/3 frame,
WebSocket and server-sent event codecs, the router and the parsers around them
are `no_std`, and CI builds them for a bare-metal target.

## A first look

This is the shape the Node package is built to ship in release 1. It does not
run today:

```ts
import { createApp, cors } from '@zero-server/sdk'

const app = createApp()
app.use(cors({ origin: 'https://example.com' }))

app.get('/users/:id', (req, res) =>
{
  res.json({ id: req.params.id })
})

app.listen(3000)
```

`cors` becomes a rule the core applies in Rust; the `/users/:id` handler runs in
JavaScript, called in batches. Python and C# get the same shape in release 2,
and the Rust API is designed during release 1. What runs today in every
language is the version call in each binding's guides folder:
[Node](bindings/node/guides/version.ts),
[Python](bindings/python/guides/version.py) and
[.NET](bindings/dotnet/samples/ZeroServer.Guides/VersionGuide.cs).

## Status

Every crate and package is at 0.1.0 and none is published. In place today: the
Cargo workspace with one crate per capability, the C ABI with its generated
header, the three binding skeletons with smoke tests, the standards registry,
and CI.

**Release 1, in development**
- HTTP/1.1 with pipelining, the router and static files
- WebSocket and server-sent events
- TLS through rustls
- The Node binding with its TypeScript facade
- The QPACK and HTTP/3 frame codecs, ahead of the transport

**Release 2, planned**
- HTTP/2 and streaming request and response bodies
- PostgreSQL, the cache and data routes
- JWT, sessions, mTLS
- The Python and C# packages

**Release 3, planned**
- HTTP/3 over QUIC
- MySQL, MongoDB, Redis and SQLite, and the ORM
- gRPC, observability, WebRTC signaling

The JavaScript framework that came before this core, `@zero-server/sdk` 1.x, now
lives in [molexxxx/zero-server-node](https://github.com/molexxxx/zero-server-node).
The Node package here takes over that name at 2.0, once it does everything 1.x
does.

## Packages

- **Rust:** the `zero-server` crate, or one `zero-<capability>` crate per need
- **TypeScript and Node:** `@zero-server/sdk`, over napi-rs
- **Python:** `zero-server`, over PyO3
- **C# and .NET:** `ZeroServer`, over `[LibraryImport]`
- **C:** the header `crates/zero-ffi/include/zero.h`

## Standards and safety

- **Standards first.** [`docs/standards.toml`](docs/standards.toml) lists every
  specification the core is held to, 544 statements, each with the release that
  ships it and the test that pins it. Nothing is implemented from memory: the
  cited source is read first and the code cites its section.
- **Unsafe code is fenced.** It is forbidden everywhere except a few audited
  crates, each listed with its inventory in [SECURITY.md](SECURITY.md).
- **Checked on every push.** CI runs the dependency allowlist and audits, Miri,
  AddressSanitizer and ThreadSanitizer, fuzzing, a reproducible-build check and
  a hardened build of the C ABI.

## Building from source

```sh
cargo build --workspace
cargo test --workspace
just ci            # everything CI runs
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the toolchain, the Docker recipe for
rustfmt and clippy, and what a change is held to.
[docs/brand.md](docs/brand.md) holds the logo and palette.

## License

Apache License 2.0. See [LICENSE](LICENSE).
