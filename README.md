<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/zero-logo-animated-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/zero-logo-animated.svg">
  <img alt="zero-server" src="assets/zero-logo-animated.svg" width="520">
</picture>

A memory-safe HTTP server core in Rust, shared by TypeScript, Python and C#.

</div>

Every language builds its own web framework, and each one writes the same
parsers, router and connection handling again, with its own bugs and its own
limits. zero-server writes them once, in Rust, from the current RFC text, and
makes that one core the engine behind a package in each language.

zero-server is in early development. The Rust core runs today; the TypeScript,
Python and C# packages are not published yet.

## What it does

- **HTTP/1.1** with pipelining, `Expect: 100-continue`, chunked bodies, body
  limits, a timeout on every stage and graceful shutdown
- **HTTPS** through rustls: TLS 1.3 and 1.2, certificates chosen by server name
  and reloaded without a restart, and 421 for a host the certificate does not
  cover
- **Routing** with parameters, catch-alls and mounted routers, answering 404,
  405 and 501 on its own
- **Static files** with a path policy on every segment, a root that symbolic
  links cannot leave, validators, conditional requests and byte ranges
- **WebSocket and server-sent events**, with rooms that broadcast across every
  core
- **Request rules**: CORS, security headers, Fetch Metadata, request ids and
  trusted proxies
- **Errors** as RFC 9457 problem details, and a panicking handler answered 500
  while its connection keeps serving
- **Two runtime backends**: tokio by default, or compio with io_uring on Linux,
  IOCP on Windows and kqueue on macOS

## Quick start

```toml
[dependencies.zero-server]
git = "https://github.com/molexxxx/zero-server"
version = "0.1.0"
default-features = false
features = ["http"]
```

```rust
use std::net::SocketAddr;
use std::sync::Arc;

use zero_server::core::Error;
use zero_server::http::{serve, Call, Config, Handler};

struct Hello;

impl Handler for Hello {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        call.response().content_type(b"text/plain")?.body(b"hello");
        Ok(())
    }
}

fn main() -> std::io::Result<()> {
    let address = SocketAddr::from(([127, 0, 0, 1], 3000));
    let workers = serve(address, Config::default(), Arc::new(|_| {}), |_| Hello)?;
    println!("listening on {}", workers.local_addr());
    workers.join()
}
```

`serve` starts one worker per logical CPU and builds a handler on each. The
[`users` example](crates/zero-examples/examples/users.rs) adds a router and a
path parameter. For HTTPS, turn on the `tls` feature and call
`zero_server::tls::serve` with an `Identities` table built from your
certificate.

## From TypeScript, Python and C#

The language packages are thin layers over the core's C ABI, and they are being
built now. The TypeScript package keeps the API of `@zero-server/sdk`:

```ts
import { createApp, cors } from '@zero-server/sdk'

const app = createApp()
app.use(cors({ origin: 'https://example.com' }))
app.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
app.listen(3000)
```

`cors` runs as a rule inside the core, and the route handler runs in JavaScript,
called with batches of requests so the hot path stays in Rust. The Python and
C# packages take the same shape.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="assets/architecture-narrow-dark.svg">
  <source media="(max-width: 600px)" srcset="assets/architecture-narrow.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="A request arrives at one core's event loop, one per CPU core, and runs along five handler tiers cheapest first: rules, cache, data plan, host handler, Rust handler. It stops at the first tier that answers. The rules, cache and data plan are answered in Rust: an app in Node, Python or .NET declares them once at startup across the C ABI. Only the host handler tier crosses the C ABI at request time, with one call per batch. The response leaves through the same core." src="assets/architecture.svg" width="960">
</picture>

**One event loop per CPU core.** Each core runs its own non-blocking loop with
its own memory, and on Linux its own listener. A connection stays on the core
that accepted it, so the request path takes no locks.

**Handler tiers, cheapest first.** A request stops at the first tier that can
answer it: declarative rules, a per-core cache, a data plan the core runs
itself, a handler in the host language, or a handler in Rust. An application in
TypeScript, Python or C# declares its rules, files and routes once at startup,
and the core answers them in Rust from then on, with the same per-core loops and
memory a Rust application gets. Only a route whose handler is the application's
own function reaches its language, called once per batch of requests. The rules
and Rust handlers work today; the cache, data plans and host-language handlers
are being built.

**One boundary.** The language packages reach the core through one C ABI,
`zero-ffi`, whose header is generated on every build. It is designed so that a
request crosses it as a small integer id, never as an object, and a panic never
crosses it at all.

**Codecs without an operating system.** The HTTP/1.1, WebSocket and server-sent
event codecs, the router and the parsers around them are `no_std`, and CI
builds them for a bare-metal target.

## Packages

- **Rust:** `zero-server`, with every capability as a feature (`http`,
  `static`, `realtime`, `tls` and more), or a single `zero-<capability>` crate
- **TypeScript:** `@zero-server/sdk` from 2.0. Versions 1.x are the earlier pure
  JavaScript framework, maintained at
  [molexxxx/zero-server-node](https://github.com/molexxxx/zero-server-node).
- **Python:** `zero-server`
- **C# and .NET:** `ZeroServer`
- **C:** the generated header
  [`crates/zero-ffi/include/zero.h`](crates/zero-ffi/include/zero.h)

## Standards and safety

- **Standards first.** Every parser and protocol behavior is written from the
  current specification text, listed in [`docs/standards.toml`](docs/standards.toml)
  with the section it implements, and pinned by a test named after it.
- **Unsafe code is fenced.** It is forbidden outside a few audited crates, each
  listed with its inventory in [SECURITY.md](SECURITY.md).
- **Checked on every push.** CI runs Miri, AddressSanitizer and
  ThreadSanitizer, fuzzing, dependency audits, a reproducible-build check and a
  hardened build of the C ABI.

## Building from source

```sh
cargo build --workspace
cargo test --workspace
cargo run -p zero-examples --example hello
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the toolchain, the Docker recipe for
rustfmt and clippy, and what a change is held to.
[docs/brand.md](docs/brand.md) holds the logo and palette.

## License

Apache License 2.0. See [LICENSE](LICENSE).
