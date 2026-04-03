<p align="center">
  <img src="documentation/public/icons/logo-animated.svg" alt="zero-http logo" width="300" height="300">
</p>

<h1 align="center">zero-http</h1>

[![npm version](https://img.shields.io/npm/v/zero-http.svg)](https://www.npmjs.com/package/zero-http)
[![npm downloads](https://img.shields.io/npm/dm/zero-http.svg)](https://www.npmjs.com/package/zero-http)
[![GitHub](https://img.shields.io/badge/GitHub-zero--http--npm-blue.svg)](https://github.com/tonywied17/zero-http)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-6098%20passed-brightgreen.svg)](https://github.com/tonywied17/zero-http/actions)
[![Coverage](https://img.shields.io/badge/coverage-95.4%25-brightgreen.svg)](https://github.com/tonywied17/zero-http)

> **Zero-dependency backend framework for Node.js — routing, ORM, auth, WebSocket, SSE, observability, and 20+ middleware from a single `require`.**

<p align="center">
  <strong>
    <a href="https://z-http.com">📖 Full Documentation &amp; Live Playground →</a>
  </strong>
</p>

---

## Install

```bash
npm install zero-http
```

Requires Node.js 18+. No external dependencies — everything is built on Node.js core APIs.

---

## Quick Start

```js
const { createApp, json } = require('zero-http')
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
const { Database, Model, TYPES } = require('zero-http')

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

- **Prometheus metrics** — `Counter`, `Gauge`, `Histogram`, `metricsMiddleware()`, and `/metrics` endpoint
- **Distributed tracing** — `Tracer` and `Span` with W3C Trace Context (`traceparent` propagation), `instrumentFetch()` for outgoing requests
- **Health checks** — `app.health()` and `app.ready()` with built-in memory, event-loop, and disk-space checks
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
} = require('zero-http')

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
} = require('zero-http')
```

---

## Documentation

| Resource | Description |
|---|---|
| **[z-http.com](https://z-http.com)** | Interactive documentation with live playground, search, and examples |
| **[API.md](API.md)** | Full API reference with tables, examples, and options for every export |

### Run docs locally

```bash
cp documentation/.env.example documentation/.env
npm run docs
# open http://localhost:7273
```

---

## File Layout

```
lib/
  app.js              — App class (middleware, routing, listen, ws upgrade, lifecycle)
  auth/               — JWT, OAuth 2.0, sessions, and authorization policies
  body/               — body parsers (json, urlencoded, text, raw, multipart)
  cli.js              — CLI runner (migrate, seed, scaffold commands)
  cluster.js          — multi-worker clustering with auto-respawn
  debug.js            — namespaced debug logger
  env/                — typed .env loader with schema validation
  errors.js           — 20+ HttpError classes and factory
  fetch/              — HTTP/HTTPS client
  http/               — Request & Response wrappers
  lifecycle.js        — graceful shutdown and lifecycle management
  middleware/          — cors, helmet, logger, rateLimit, compress, static, timeout,
                         requestId, cookieParser, csrf, validate, errorHandler
  observe/            — Prometheus metrics, W3C tracing, health checks, structured logging
  orm/                — Database, Model, Query, adapters, migrations, seeds, cache,
                         replicas, search, geo, tenancy, audit, views, procedures, plugins
  router/             — Router with sub-app mounting and pattern matching
  sse/                — SSE stream controller
  ws/                 — WebSocket connection, handshake, and room management
types/                — full TypeScript definitions
documentation/        — live demo server, controllers, and playground UI
test/                 — vitest test suite (6000+ tests, 95%+ coverage)
```

## Testing

```bash
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
```

## License

MIT
