<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/zero-logo-animated-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/zero-logo-animated.svg">
  <img alt="zero-server" src="assets/zero-logo-animated.svg" width="520">
</picture>

A memory-safe HTTP server core in Rust, for TypeScript, Python and C#.

</div>

Every language builds its own web framework, and each one writes the same
parsers, router and connection handling again, with its own bugs and its own
limits. zero-server writes them once, in Rust, as one core that a package in
each language loads.

The Rust core serves HTTP/1.1 and HTTPS today. Nothing is published to a
registry yet, so it is used from this repository. The Node, Python and .NET
packages load the core but have no server API yet.

## What it does

- **HTTP/1.1** with pipelining, `Expect: 100-continue`, chunked bodies, body
  limits, timeouts on reading the head, reading the body, writing the response
  and idle connections, and graceful shutdown
- **HTTPS** through rustls: TLS 1.3 and 1.2, certificates chosen by server name
  and reloaded without a restart, and `421 Misdirected Request` for a host the
  certificate does not cover
- **Routing** with parameters, catch-alls and mounted routers, answering 404,
  405 and 501 on its own
- **Static files** with path checks on every segment, a root that symbolic
  links cannot leave, `ETag` and `Last-Modified` validators, conditional
  requests, byte ranges and a per-core cache for small files
- **WebSocket and server-sent events**, with rooms that broadcast across every
  core
- **Request rules**: CORS, security headers, refusal of cross-site requests
  that would change state, request ids and trusted proxies
- **Errors** answered as `application/problem+json`, and a panicking handler
  answered 500 while its connection keeps serving
- **Two runtime backends**: tokio by default, or compio with io_uring on Linux,
  IOCP on Windows and kqueue on macOS
- **A `zero` binary** that serves a directory of files over HTTP/1.1 or HTTPS

## Quick start

Make a binary crate with `cargo new hello` and add the core to its
`Cargo.toml`:

```toml
[dependencies.zero-server]
git = "https://github.com/molexxxx/zero-server"
version = "0.1.0"
default-features = false
features = ["http"]
```

Then put this in `src/main.rs`:

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

Start it with `cargo run`, and `curl http://127.0.0.1:3000/` answers `hello`.
It needs Rust 1.89 or newer.

The third argument to `serve` is a callback for cores that start, stop or
panic, which this example ignores; the last builds the handler once per worker.
The [`users` example](crates/zero-examples/examples/users.rs) adds a router and
a path parameter. For HTTPS, the `tls` feature adds `zero_server::tls::serve`,
which also takes an `Identities` table and `TlsOptions`.

To serve a directory of files without writing code, install the `zero` binary:

```sh
cargo install --locked --git https://github.com/molexxxx/zero-server zero-serve
zero serve ./public
```

It listens on `127.0.0.1:8080`, and `--cert`, `--key` and `--name` switch it to
HTTPS. `zero help` lists every option.

## How it works

<picture>
  <source media="(max-width: 600px)" srcset="assets/runtime-narrow.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/runtime-dark.svg">
  <img alt="Four cores side by side, each drawn as a ring: one single-threaded event loop per CPU core. On Linux the kernel spreads new connections over one SO_REUSEPORT listener per core; elsewhere one listener hands them out, and a connection never leaves its core. Each core has its own buffer pool, Date header cache and small-file cache, so the request path takes no locks; a buffer is leased only while bytes are read. Below, the loop every core runs: read, parse, route, answer and write, with the response leaving on the same connection, then on to the next connection with work ready." src="assets/runtime.svg" width="960">
</picture>

**One event loop per CPU core.** `serve` starts one worker per logical CPU, and
each runs its own non-blocking loop. On Linux each core has its own
`SO_REUSEPORT` listener; elsewhere one listener hands connections out to the
cores. A connection stays on the core that accepted it, and each core keeps its
own buffer pool, `Date` cache and small-file cache, so the request path takes
no locks. A connection leases a receive buffer when bytes arrive and returns it
once they are consumed, so a waiting connection holds none. The loop reads,
parses, routes, answers and writes, then moves on to the next connection with
work ready. The compio backend is behind the `io-compio` feature.

<picture>
  <source media="(max-width: 600px)" srcset="assets/bindings-narrow.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/bindings-dark.svg">
  <img alt="The design for other languages: an app in Node, Python or .NET loads the core as a native library in its own process, with one thread per core. At startup it declares its routes, rules and static files once across the host boundary, which Node crosses through Node-API and Python and .NET through the C ABI, and every core keeps them as tables. Requests reach the cores, not the app. Rules, static files and Rust handlers are answered in Rust; a route whose handler is the app's own function reaches that core's thread in one call per batch of up to 256, and the core writes the responses. Every core takes both kinds; the route decides." src="assets/bindings.svg" width="960">
</picture>

**The same core from other languages.** In the design the language packages
follow, a Node, Python or .NET application loads the core as a native library
and declares its routes, rules and static files once at startup, across the C
ABI. Rules, static files and Rust handlers are answered in Rust, and the
application's own handlers are called once per batch of up to 256 requests.
Today the C ABI exports only the core's version, and none of the packages can
serve a request yet.

**Codecs without an operating system.** The HTTP/1.1, WebSocket and server-sent
event codecs, the QPACK and HTTP/3 frame codecs, the router and the parsers
around them are `no_std`, and CI builds them for a bare-metal target.

## Packages

None of these is on a registry yet; the Rust crate is used from git, as in the
quick start.

- **Rust:** `zero-server`, with each capability behind a feature (`http`,
  `static`, `realtime`, `tls` and more), or a single capability crate such as
  `zero-http1` or `zero-router`
- **Node:** `@zero-server/core`, over the compiled core in `@zero-server/native`
- **Python:** `zero-server`
- **.NET:** `ZeroServer`

On npm, the 1.x versions of `@zero-server/sdk` and `@zero-server/core` are the
earlier JavaScript framework, a different code base from this core.

## Building from source

```sh
cargo build --workspace
cargo test --workspace
cargo run -p zero-examples --example hello
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the toolchain, the Docker recipe for
rustfmt and clippy, and the checks a change must pass.
[docs/about/standards.md](docs/about/standards.md) explains how the code follows
its specifications and what CI runs on every push.
[SECURITY.md](SECURITY.md) lists the crates allowed unsafe code and how to
report a vulnerability.

## License

Apache License 2.0. See [LICENSE](LICENSE).
