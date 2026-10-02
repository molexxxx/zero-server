<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/zero-logo-animated-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/zero-logo-animated.svg">
  <img alt="zero-server" src="assets/zero-logo-animated.svg" width="520">
</picture>

A memory-safe HTTP server core in Rust, for TypeScript, Python and C#.

</div>

Every language rebuilds the same parsers, router and connection handling, each
with its own bugs. zero-server writes them once, in Rust, from the current RFC
text, so that TypeScript, Python and C# applications can run on that one core,
installed from prebuilt packages that never compile anything.

> [!NOTE]
> Pre-release: nothing is published yet. The Rust core serves HTTP/1.1 and HTTPS
> today; the Node binding is the next large piece of release 1.

## Status

**Release 1**

- [x] HTTP/1.1 with pipelining, timeouts, body limits, RFC 9457 errors and
      graceful shutdown
- [x] Routing with parameters, catch-alls and mounted routers
- [x] Static files with a path policy on every segment, validators, byte ranges
      and a per-core cache
- [x] WebSocket and server-sent events, with rooms that reach every core
- [x] TLS 1.3 and 1.2 through rustls, on both runtime backends
- [x] CORS, security headers, Fetch Metadata, request ids and trust proxy, called
      from a handler
- [ ] The same rules applied before any handler runs
- [ ] The QPACK and HTTP/3 frame codecs
- [ ] Request slots and the C ABI the bindings call
- [ ] The Node binding with its TypeScript facade
- [ ] The standalone `zero` server binary

**Later.** Release 2 brings HTTP/2, streaming bodies, PostgreSQL, the response
cache, JWT and sessions, and the Python and C# packages. Release 3 brings HTTP/3
over QUIC, MySQL, MongoDB, Redis and SQLite with the ORM, gRPC, observability and
WebRTC signaling.

## A first look

This Rust program runs today. It answers `GET /users/:id` with the id, and the
router answers every other path and method with 404, 405 or 501 on its own.

```toml
[dependencies.zero-server]
git = "https://github.com/molexxxx/zero-server"
default-features = false
features = ["http"]
```

```rust
use std::net::SocketAddr;
use std::sync::Arc;

use zero_server::core::Error;
use zero_server::http::{serve, Call, Config, Handler, Router};
use zero_server::http_types::Method;

#[derive(Clone, Copy)]
enum Route {
    User,
}

struct App {
    router: Router<Route>,
}

impl App {
    fn new() -> Self {
        let mut router = Router::new();
        router
            .route(Method::Get, "/users/:id", Route::User)
            .expect("the pattern is valid");
        App { router }
    }
}

impl Handler for App {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let Some(routed) = call.route(&self.router) else {
            return Ok(());
        };
        match routed.descriptor {
            Route::User => {
                let (request, mut response) = call.parts();
                response.content_type(b"text/plain")?;
                response.body(request.param(0).unwrap_or_default());
            }
        }
        Ok(())
    }
}

fn main() -> std::io::Result<()> {
    let workers = serve(
        SocketAddr::from(([127, 0, 0, 1], 3000)),
        Config::default(),
        Arc::new(|_| {}),
        |_| App::new(),
    )?;
    println!("listening on {}", workers.local_addr());
    workers.join()
}
```

`serve` starts one worker per logical CPU and builds a handler on each. For
HTTPS, turn on the `tls` feature and call `zero_server::tls::serve` with the same
handler and an `Identities` table built by `Identity::from_pem_files`; a request
for a host the certificate does not cover is answered 421.

The Node facade keeps the shape of `@zero-server/sdk` 1.x. It arrives with
release 1 and does not run yet:

```ts
import { createApp, cors } from '@zero-server/sdk'

const app = createApp()
app.use(cors({ origin: 'https://example.com' }))
app.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
app.listen(3000)
```

There, `cors` becomes a rule the core applies in Rust, and the route handler runs
in JavaScript, called in batches.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="assets/architecture-narrow-dark.svg">
  <source media="(max-width: 600px)" srcset="assets/architecture-narrow.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="A request arrives at one core's event loop, one per CPU core, and runs along five handler tiers cheapest first: rules, cache, data plan, host handler, Rust handler. It stops at the first tier that answers. Only the host handler tier crosses the C ABI, with one call per batch, to the Node, Python or .NET runtime. The response leaves through the same core." src="assets/architecture.svg" width="960">
</picture>

The diagram is the full design. What it shows exists today except where a
paragraph below says otherwise.

**One event loop per CPU core.** Each core runs its own non-blocking loop with
its own memory, and on Linux its own listener. A connection stays on the core
that accepted it, so the request path takes no locks.

**Two runtime backends.** The core reaches the operating system through one
seam: tokio by default, or compio with io_uring on Linux, IOCP on Windows and
kqueue on macOS. TLS runs on both.

**Five tiers, cheapest first.** A request stops at the first tier that answers
it. Rust handlers and the request rules run today. Host-language handlers arrive
with the Node binding in release 1, and the response cache and data plans in
release 2. Only the host-language tier leaves Rust, once per batch of requests.

**One boundary.** The bindings reach the core through one C ABI, `zero-ffi`,
whose header is generated on every build. In release 1 a request crosses it as a
small integer id, never as an object, and a panic never crosses it at all.

**Codecs that need no operating system.** The HTTP/1.1, WebSocket and
server-sent event codecs, the router and the parsers around them are `no_std`,
and CI builds them for a bare-metal target.

## Packages

None of these is published yet; they are the names releases will use.

- **Rust:** the `zero-server` crate, or one `zero-<capability>` crate per need.
  The bundle turns every capability on by default; with `default-features =
  false`, each is a feature named after its crate, such as `http`, `static`,
  `realtime` or `tls`, and `io-compio` selects the compio backend.
- **TypeScript and Node:** `@zero-server/sdk` from 2.0. Until then that name
  belongs to the earlier JavaScript framework, maintained in
  [molexxxx/zero-server-node](https://github.com/molexxxx/zero-server-node).
- **Python:** `zero-server`. **C# and .NET:** `ZeroServer`. **C:** the header
  `crates/zero-ffi/include/zero.h`.

## Standards and safety

- **Standards first.** [`docs/standards.toml`](docs/standards.toml) lists every
  specification statement the core relies on, with the release that ships it
  and, once it ships, the test that pins it. The cited source is read before the
  code is written, and the code cites its section.
- **Unsafe code is fenced.** It is forbidden everywhere except a few audited
  crates, each listed with its inventory in [SECURITY.md](SECURITY.md).
- **Checked on every push.** CI runs the dependency allowlist and audits, Miri,
  AddressSanitizer and ThreadSanitizer, fuzzing, a reproducible-build check and
  a hardened build of the C ABI.

## Building from source

```sh
cargo build --workspace
cargo test --workspace
just ci            # what the main CI job runs
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the toolchain, the Docker recipe for
rustfmt and clippy, and what a change is held to.
[docs/brand.md](docs/brand.md) holds the logo and palette.

## License

Apache License 2.0. See [LICENSE](LICENSE).
