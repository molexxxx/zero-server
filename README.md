<p align="center">
  <img src="documentation/public/vendor/icons/logo.svg" alt="zero-http logo" width="300" height="300">
</p>

<h1 align="center">zero-http</h1>

[![npm version](https://img.shields.io/npm/v/zero-http.svg)](https://www.npmjs.com/package/zero-http)
[![npm downloads](https://img.shields.io/npm/dm/zero-http.svg)](https://www.npmjs.com/package/zero-http)
[![GitHub](https://img.shields.io/badge/GitHub-zero--http--npm-blue.svg)](https://github.com/tonywied17/zero-http)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

> **Zero-dependency backend framework for Node.js — Express-like routing, built-in ORM, WebSocket, SSE, security middleware, body parsers, response compression, and a tiny fetch client.**

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

Requires Node.js 14+. No external dependencies — everything is built on Node.js core APIs.

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

| Category | What you get |
|---|---|
| **Routing** | Express-like `get`, `post`, `put`, `delete`, `patch`, `head`, `options`, `all`, plus `Router()` sub-apps, route chaining, wildcard & param patterns, and protocol-aware routes |
| **Body Parsers** | `json()`, `urlencoded()`, `text()`, `raw()`, `multipart()` with streaming uploads |
| **Middleware** | `cors()`, `helmet()`, `compress()`, `rateLimit()`, `logger()`, `timeout()`, `requestId()`, `cookieParser()`, `csrf()`, `validate()`, `errorHandler()`, static file serving |
| **ORM** | `Database.connect()` with memory, JSON, SQLite, MySQL, PostgreSQL, and MongoDB adapters; `Model` with schema validation, CRUD, timestamps, soft deletes, scopes, hooks, and fluent `Query` builder |
| **Real-Time** | WebSocket server (`app.ws()`) with RFC 6455, rooms, broadcasting; Server-Sent Events (`res.sse()`) with auto-IDs, keep-alive |
| **Environment** | Typed `.env` loader with schema validation, multi-file support, property-style access |
| **HTTP Client** | Built-in `fetch()` with TLS passthrough, progress callbacks, abort support |
| **Error Handling** | `HttpError` classes for every status code, `errorHandler()` middleware, `debug()` namespaced logger |
| **Security** | CRLF injection prevention, prototype pollution filtering, path traversal guards, filename sanitization, CSRF tokens |
| **HTTPS** | Pass `{ key, cert }` to `listen()` — `req.secure`, `req.protocol`, `ws.secure`, `sse.secure` everywhere |

---

## Production Example

```js
const path = require('path')
const {
  createApp, Router, cors, json, urlencoded, compress,
  helmet, timeout, requestId, cookieParser, logger,
  static: serveStatic, rateLimit, WebSocketPool, env
} = require('zero-http')

env.load({
  PORT:   { type: 'port', default: 3000 },
  SECRET: { type: 'string', required: true },
})

const app = createApp()

// Middleware stack
app.use(helmet())
app.use(logger())
app.use(cors())
app.use(compress())
app.use(timeout(30000))
app.use(rateLimit())
app.use(cookieParser(env.SECRET))
app.use(json())
app.use(urlencoded())

// Static files
app.use(serveStatic(path.join(__dirname, 'public')))

// API routes
const api = Router()
api.get('/health', (req, res) => res.json({ status: 'ok' }))
api.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
app.use('/api', api)

// WebSocket
const pool = new WebSocketPool()
app.ws('/chat', (ws, req) => {
  pool.add(ws)
  pool.join(ws, 'lobby')
  ws.on('message', msg => pool.toRoom('lobby', msg, ws))
})

// SSE
app.get('/events', (req, res) => {
  const sse = res.sse({ retry: 3000, autoId: true })
  sse.send('connected')
})

app.listen(env.PORT, () => console.log(`Running on :${env.PORT}`))
```

---

## HTTPS

```js
const fs = require('fs')
const { createApp } = require('zero-http')
const app = createApp()

app.listen(443, {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
}, () => console.log('HTTPS on 443'))
```

---

## Exports

All exports from the package root:

```js
const {
  createApp, Router, cors, fetch,
  json, urlencoded, text, raw, multipart,
  static: serveStatic,
  rateLimit, logger, compress,
  helmet, timeout, requestId, cookieParser,
  csrf, validate, errorHandler,
  env, Database, Model, TYPES, Query,
  HttpError, NotFoundError, BadRequestError,
  ValidationError, createError, isHttpError,
  debug, version,
  WebSocketConnection, WebSocketPool, SSEStream
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
# Copy and configure environment
cp .env.example .env
# Edit .env if needed (TLS_CERT, TLS_KEY for HTTPS)

npm run docs
# open http://localhost:7273
```

---

## File Layout

```
lib/
  app.js              — App class (middleware pipeline, routing, listen, ws upgrade)
  body/               — body parsers (json, urlencoded, text, raw, multipart)
  debug.js            — namespaced debug logger with levels and colors
  env/                — typed .env loader with schema validation
  errors.js           — HttpError classes and factory
  fetch/              — server-side HTTP/HTTPS client
  http/               — Request & Response wrappers with QoL methods
  middleware/          — cors, helmet, logger, rateLimit, compress, static, timeout,
                         requestId, cookieParser, csrf, validate, errorHandler
  orm/                — Database, Model, Query, adapters (memory, json, sqlite, mysql, postgres, mongo)
  router/             — Router with sub-app mounting, pattern matching & introspection
  sse/                — SSEStream controller
  ws/                 — WebSocket connection, handshake, and room management
documentation/        — live demo server, controllers, and playground UI
test/                 — vitest test suite (1000+ tests)
```

## Testing

```bash
npm test            # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
```

## License

MIT
