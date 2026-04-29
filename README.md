<p align="center">
  <img src="website-docs/public/icons/logo-animated.svg" alt="zero-server logo" width="300" height="300">
</p>

<h1 align="center">zero-server</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@zero-server/sdk"><img src="https://img.shields.io/badge/%40zero--server%2Fsdk-000?style=flat-square&logo=npm&logoColor=white" alt="@zero-server/sdk"></a>
  <a href="https://www.npmjs.com/package/@zero-server/sdk"><img src="https://img.shields.io/npm/v/%40zero-server%2Fsdk?style=flat-square&logo=npm&logoColor=white&label=&color=00d8e0" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@zero-server/sdk"><img src="https://img.shields.io/npm/dm/%40zero-server%2Fsdk?style=flat-square&logo=npm&logoColor=white&label=downloads&color=ff6b35" alt="npm downloads"></a>
</p>

<p align="center">
  <a href="https://github.com/tonywied17/zero-server/actions"><img src="https://img.shields.io/github/actions/workflow/status/tonywied17/zero-server/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI" alt="CI"></a>
  <a href="https://github.com/tonywied17/zero-server/actions"><img src="https://img.shields.io/badge/tests-13%2F7443%20failed-red?style=flat-square&logo=vitest&logoColor=white" alt="tests"></a>
  <a href="https://github.com/tonywied17/zero-server"><img src="https://img.shields.io/badge/coverage-0%25-red?style=flat-square&logo=vitest&logoColor=white" alt="coverage"></a>
  <a href="https://z-server.dev"><img src="https://img.shields.io/badge/docs-z--server.dev-00d8e0?style=flat-square&logo=readthedocs&logoColor=white" alt="docs"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-00d8e0?style=flat-square&logo=opensourceinitiative&logoColor=white" alt="MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=nodedotjs&logoColor=white" alt="node >=18"></a>
</p>

> **Zero-dependency backend framework for Node.js — routing, ORM, auth, WebSocket, SSE, observability, and 20+ middleware from a single `require`.**

<p align="center">
  <strong>
    <a href="https://z-server.dev">📖 Full Documentation &amp; Live Playground →</a>
  </strong>
</p>

---

## Install

```bash
npm install @zero-server/sdk
```

Requires Node.js 18+. No external dependencies — everything is built on Node.js core APIs.

### Or install only what you need (scoped packages)

`@zero-server/sdk` is the meta-package that re-exports every module. If you want a smaller install footprint, every section of the SDK is also published as its own scoped package and re-exports just that surface from the SDK:

| Package | Surface |
|---|---|
| `@zero-server/core` | `createApp`, `Router`, `Request`, `Response` |
| `@zero-server/body` | `json`, `urlencoded`, `text`, `raw`, `multipart` |
| `@zero-server/middleware` | `cors`, `helmet`, `compress`, `rateLimit`, `logger`, `timeout`, `requestId`, `cookieParser`, `csrf`, `validate`, `errorHandler`, `static` |
| `@zero-server/auth` | `jwt`, `session`, `oauth`, `authorize`, `twoFactor`, `webauthn`, `trustedDevice`, `enrollment` |
| `@zero-server/orm` | `Database`, `Model`, `Query`, `TYPES`, migrations, seeders, replicas, search, geo, tenancy, audit |
| `@zero-server/realtime` | `WebSocketConnection`, `WebSocketPool`, `SSEStream` |
| `@zero-server/grpc` | gRPC server, client, codec, status, metadata, framing, health, reflection, balancer |
| `@zero-server/observe` | `MetricsRegistry`, `Tracer`, structured `Logger`, health checks |
| `@zero-server/lifecycle` | `LifecycleManager`, `ClusterManager`, `clusterize` |
| `@zero-server/env` | typed `.env` loader |
| `@zero-server/fetch` | server-side `fetch` client |
| `@zero-server/errors` | every typed `HttpError` class plus ORM/framework errors |
| `@zero-server/cli` | programmatic `CLI` / `runCLI` entry points for `zh` / `zs` |

```bash
npm install @zero-server/core @zero-server/body @zero-server/middleware
```

> All scoped packages depend on `@zero-server/sdk` and pin to the same version, so mixing-and-matching is safe.

---

## Quick Start

```js
const { createApp, json } = require('@zero-server/sdk')
const app = createApp()

app.use(json())
app.post('/echo', (req, res) => res.json({ received: req.body }))
app.listen(3000, () => console.log('Listening on :3000'))
```

---

## Features

### Routing

`get`, `post`, `put`, `delete`, `patch`, `head`, `options`, `all`, plus `Router()` sub-apps with `use()` mounting. Route chaining via `chain(path)`, route grouping via `group(prefix, ...mw, cb)`, wildcard & parameter patterns, and `param()` pre-processing. Full route introspection with `routes()`.

### Body Parsers

`json()`, `urlencoded()`, `text()`, `raw()`, and `multipart()` with streaming file uploads, size limits, and progress tracking.

### Middleware

20+ built-in middleware — all zero-dependency:

| Middleware | Purpose |
|---|---|
| `cors()` | Cross-origin resource sharing |
| `helmet()` | Security headers |
| `compress()` | Gzip, Brotli, and deflate compression |
| `rateLimit()` | Per-IP request throttling |
| `logger()` | Request logging with timing and colors |
| `timeout()` | Request timeout enforcement |
| `requestId()` | Unique request IDs |
| `cookieParser()` | Cookie parsing with signed cookie support |
| `csrf()` | CSRF token protection |
| `validate()` | Schema-based request validation |
| `errorHandler()` | Centralized error handling |
| `static()` | Static file serving with ETags and HTTP/2 push |

### Authentication & Authorization

Full auth stack with no external libraries:

- **JWT** — `jwt()` middleware, `jwtSign()`, `jwtVerify()`, `jwtDecode()`, JWKS key sets, access/refresh token pairs
- **Sessions** — `session()` middleware with in-memory store (pluggable)
- **OAuth 2.0** — `oauth()` middleware with PKCE, pre-configured providers (Google, GitHub, Microsoft, etc.)
- **Authorization** — `authorize()` policies, `can()` / `canAny()` permission checks, `gate()` middleware

### ORM & Database

Full-featured ORM with 7 adapters — memory, JSON file, SQLite, MySQL, PostgreSQL, MongoDB, and Redis:

```js
const { Database, Model, TYPES } = require('@zero-server/sdk')

const db = Database.connect('sqlite', { filename: 'app.db' })

class User extends Model {
  static table = 'users'
  static schema = {
    name:  { type: TYPES.STRING, required: true },
    email: { type: TYPES.STRING, unique: true },
  }
}

db.register(User)
await db.sync()

await User.create({ name: 'Alice', email: 'alice@example.com' })
const users = await User.find({ name: 'Alice' })
```

**Query builder** — `where()`, `select()`, `orderBy()`, `limit()`, `offset()`, `join()`, `groupBy()`, `having()`, `paginate()`, `findOrCreate()`

**Advanced ORM features:**

| Feature | Description |
|---|---|
| Migrations | `Migrator` with up/down, rollback, and status tracking |
| Seeding | `Seeder`, `Factory`, and `Fake` for test data generation |
| Query caching | In-memory LRU cache with TTL and write-through invalidation |
| Read replicas | `ReplicaManager` with automatic primary/replica routing |
| Full-text search | `FullTextSearch` with indexing and ranked results |
| Geo queries | `GeoQuery` with distance, bounding box, and nearest-neighbor |
| Multi-tenancy | `TenantManager` with isolated per-tenant scoping |
| Audit logging | `AuditLog` for change tracking with diffs and user attribution |
| Schema snapshots | EF Core-style snapshot diffing with auto-generated migrations |
| Query profiler | N+1 detection, slow query tracking, and execution analysis |
| Views & procedures | `DatabaseView`, `StoredProcedure`, `StoredFunction`, `TriggerManager` |
| Plugins | `PluginManager` for extending ORM behavior |

### Real-Time

- **WebSocket** — `app.ws(path, handler)` with RFC 6455, `WebSocketPool` for rooms, broadcasting, and sub-protocols
- **Server-Sent Events** — `res.sse()` with auto-IDs, named events, and keep-alive

### Observability

Built-in Prometheus metrics, health checks, distributed tracing, and structured logging — zero dependencies.

```js
const { createApp, metricsMiddleware } = require('@zero-server/sdk')
const app = createApp()

// Auto-instrument all HTTP requests (counters, histograms, active connections)
app.use(metricsMiddleware({ registry: app.metrics() }))

// Expose endpoints
app.metricsEndpoint()   // GET /metrics  (Prometheus scrape target)
app.health()            // GET /healthz  (liveness probe)
app.ready()             // GET /readyz   (readiness probe)

// Custom metrics
const logins = app.metrics().counter({
  name: 'user_logins_total',
  help: 'Total login attempts',
  labels: ['provider'],
})
logins.inc({ provider: 'github' })

app.listen(3000)
```

**Scrape with Prometheus** — create a `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'my-app'
    scrape_interval: 5s
    static_configs:
      - targets: ['localhost:3000']
```

```bash
docker run -d -p 9090:9090 -v ./prometheus.yml:/etc/prometheus/prometheus.yml prom/prometheus
# Open http://localhost:9090 → Graph → query http_requests_total
```

**Also includes:**
- **Distributed tracing** — `Tracer` and `Span` with W3C Trace Context (`traceparent` propagation), `instrumentFetch()` for outgoing requests
- **Structured logging** — `Logger` with levels, JSON output, and namespaced `debug()` logger

### Lifecycle & Clustering

- **Graceful shutdown** — signal handlers (SIGTERM/SIGINT), in-flight request draining, automatic WebSocket/SSE/database cleanup
- **Clustering** — `clusterize()` for multi-worker processes with auto-respawn and exponential backoff

### CLI

Scaffolding and database management via `npx zh`:

```bash
npx zh migrate              # run pending migrations
npx zh migrate:rollback     # rollback last migration
npx zh migrate:status       # show migration status
npx zh seed                 # run seeders
npx zh make:model User      # scaffold a model
npx zh make:migration name  # create migration file
npx zh make:seeder User     # create seeder file
```

### Environment Config

Typed `.env` loader with schema validation, multi-file support (`.env`, `.env.local`, `.env.{NODE_ENV}`), variable interpolation, and type coercion (string, number, boolean, integer, array, json, url, port, enum).

### HTTP Client

Built-in `fetch()` with HTTPS/mTLS support, timeouts, `AbortSignal`, progress callbacks, and JSON/form/stream bodies.

### HTTPS & HTTP/2

```js
app.listen(443, {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem'),
}, () => console.log('HTTPS on 443'))
```

Native HTTP/2 with automatic HTTP/1.1 fallback. `req.secure`, `req.protocol`, `ws.secure`, and `sse.secure` everywhere.

### Error Handling

20+ typed error classes (`NotFoundError`, `ValidationError`, `ForbiddenError`, `PayloadTooLargeError`, `DatabaseError`, `MigrationError`, etc.) plus `createError(status, message)` factory and `isHttpError()` check. Built-in CRLF injection prevention, prototype pollution filtering, path traversal guards, and filename sanitization.

### TypeScript

Full type definitions for every API, middleware option, ORM model, auth flow, and plugin interface.

---

## Production Example

```js
const path = require('path')
const {
  createApp, Router, cors, json, urlencoded, compress,
  helmet, timeout, requestId, cookieParser, logger,
  static: serveStatic, rateLimit, jwt, session,
  Database, Model, TYPES, env, clusterize,
  WebSocketPool,
} = require('@zero-server/sdk')

env.load({
  PORT:       { type: 'port', default: 3000 },
  JWT_SECRET: { type: 'string', required: true },
  DB_PATH:    { type: 'string', default: './data.db' },
})

clusterize(() => {
  const app = createApp()
  const db = Database.connect('sqlite', { filename: env.DB_PATH })

  // Middleware stack
  app.use(helmet())
  app.use(logger())
  app.use(cors())
  app.use(compress())
  app.use(timeout(30_000))
  app.use(rateLimit())
  app.use(cookieParser())
  app.use(session({ secret: env.JWT_SECRET }))
  app.use(json())
  app.use(urlencoded())
  app.use(serveStatic(path.join(__dirname, 'public')))

  // Observability
  app.health()
  app.ready()
  app.metricsEndpoint()

  // API routes
  const api = Router()
  api.get('/health', (req, res) => res.json({ status: 'ok' }))
  api.get('/users/:id', jwt({ secret: env.JWT_SECRET }), (req, res) => {
    res.json({ id: req.params.id, user: req.user })
  })
  app.use('/api', api)

  // WebSocket
  const pool = new WebSocketPool()
  app.ws('/chat', (ws) => {
    pool.add(ws)
    pool.join(ws, 'lobby')
    ws.on('message', msg => pool.toRoom('lobby', msg, ws))
  })

  // SSE
  app.get('/events', (req, res) => {
    const sse = res.sse({ retry: 3000, autoId: true })
    sse.send('connected')
  })

  app.listen(env.PORT, () => console.log(`Worker ${process.pid} on :${env.PORT}`))
})
```

---

## Exports

All exports from the package root:

```js
const {
  // Core
  createApp, Router, version,

  // Body parsers
  json, urlencoded, text, raw, multipart,

  // Middleware
  cors, helmet, compress, rateLimit, logger,
  timeout, requestId, cookieParser, csrf,
  validate, errorHandler, static: serveStatic,

  // Auth
  jwt, jwtSign, jwtVerify, jwtDecode, jwks, tokenPair,
  session, Session, MemoryStore,
  oauth, generatePKCE, generateState, OAUTH_PROVIDERS,
  authorize, can, canAny, Policy, gate,

  // ORM
  Database, Model, TYPES, Query,
  Migrator, defineMigration,
  Seeder, SeederRunner, Factory, Fake,
  QueryCache, QueryProfiler, ReplicaManager,
  FullTextSearch, GeoQuery, TenantManager, AuditLog,
  DatabaseView, StoredProcedure, StoredFunction, TriggerManager,
  PluginManager, buildSnapshot, diffSnapshots,

  // Observability
  Logger, structuredLogger,
  Counter, Gauge, Histogram, MetricsRegistry,
  metricsMiddleware, metricsEndpoint,
  Span, Tracer, tracingMiddleware, instrumentFetch,
  healthCheck, memoryCheck, eventLoopCheck, diskSpaceCheck,

  // Real-time
  WebSocketConnection, WebSocketPool, SSEStream,

  // gRPC
  GrpcStatus, grpcToHttp, grpcStatusName, GRPC_STATUS_NAMES,
  GrpcMetadata, ProtoWriter, ProtoReader, protoEncode, protoDecode,
  parseProto, parseProtoFile, frameEncode, FrameParser,
  GrpcServiceRegistry, GrpcClient,
  GrpcHealthService, GrpcServingStatus, GrpcReflectionService,
  GrpcLoadBalancer, GrpcSubchannel, GrpcSubchannelState,
  ChannelCredentials, createRotatingCredentials, watchProto,

  // Utilities
  fetch, env, debug,
  ClusterManager, clusterize,
  LifecycleManager, LIFECYCLE_STATE,

  // Errors
  HttpError, BadRequestError, UnauthorizedError,
  ForbiddenError, NotFoundError, ValidationError,
  ConflictError, PayloadTooLargeError, TooManyRequestsError,
  TimeoutError, DatabaseError, MigrationError,
  createError, isHttpError,

  // CLI
  CLI, runCLI,
} = require('@zero-server/sdk')
```

---

## Documentation

| Resource | Description |
|---|---|
| **[z-server.dev](https://z-server.dev)** | Interactive documentation with live playground, search, and examples |
| **[API.md](API.md)** | Full API reference with tables, examples, and options for every export |

### Run docs locally

```bash
cp website-docs/.env.example website-docs/.env
npm run docs
# open http://localhost:7273
```

---

## File Layout

```
lib/
  app.js              — App class (middleware, routing, listen, ws upgrade, lifecycle)
  auth/               — JWT, OAuth 2.0, sessions, MFA (TOTP/WebAuthn), authorization
  body/               — body parsers (json, urlencoded, text, raw, multipart)
  cli.js              — CLI runner (migrate, seed, scaffold commands)
  cluster.js          — multi-worker clustering with auto-respawn
  debug.js            — namespaced debug logger
  env/                — typed .env loader with schema validation
  errors.js           — 25+ HttpError / framework / ORM error classes
  fetch/              — HTTP/HTTPS client (mTLS, AbortSignal, retries)
  grpc/               — HTTP/2 gRPC stack: server, client, codec, framing,
                         status, metadata, health, reflection, balancer, watch
  http/               — Request & Response wrappers
  lifecycle.js        — graceful shutdown and lifecycle management
  middleware/         — cors, helmet, logger, rateLimit, compress, static, timeout,
                         requestId, cookieParser, csrf, validate, errorHandler
  observe/            — Prometheus metrics, W3C tracing, health checks, structured logging
  orm/                — Database, Model, Query, adapters, migrations, seeds, cache,
                         replicas, search, geo, tenancy, audit, views, procedures, plugins
  router/             — Router with sub-app mounting and pattern matching
  sse/                — SSE stream controller
  ws/                 — WebSocket connection, handshake, and room management
packages/             — generated scoped @zero-server/* re-exports (one dir per scope)
.tools/
  scope-manifest.js   — single source of truth for scoped packages & their surface
  generate-package-stubs.js
  generate-scope-docs.js
types/                — full TypeScript definitions
website-docs/         — live demo server, controllers, and playground UI
test/                 — vitest test suite (7000+ tests, 95%+ coverage)
```

## Testing

```bash
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
```

## License

MIT
