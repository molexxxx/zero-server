<p align="center">
  <a href="https://z-http.com">
    <img src="documentation/public/vendor/icons/logo.svg" alt="zero-http logo" width="120" height="120">
  </a>
</p>

<h1 align="center">zero-http — API Reference</h1>

<p align="center">
  <strong>
    <a href="https://z-http.com">📖 Interactive docs, live playground, and searchable reference at z-http.com →</a>
  </strong>
</p>

---

## Table of Contents

- [Exports](#exports)
- [createApp](#createapp)
- [Router](#router)
- [Request](#request-req)
- [Response](#response-res)
- [Body Parsers](#body-parsers)
  - [json](#jsonopts)
  - [urlencoded](#urlencodedopts)
  - [text](#textopts)
  - [raw](#rawopts)
  - [multipart](#multipartopts)
- [Middleware](#middleware)
  - [helmet](#helmetopts)
  - [cors](#corsopts)
  - [compress](#compressopts)
  - [rateLimit](#ratelimitopts)
  - [logger](#loggeropts)
  - [timeout](#timeoutms-opts)
  - [requestId](#requestidopts)
  - [cookieParser](#cookieparsersecret-opts)
  - [static](#staticrootpath-opts)
  - [validate](#validateschema-opts)
  - [csrf](#csrfopts)
  - [errorHandler](#errorhandleropts)
- [Environment Config](#environment-config--env)
- [Database / ORM](#database--orm)
  - [Database.connect](#databaseconnectadapter-opts)
  - [Model](#model)
  - [TYPES](#types)
  - [Query Builder](#fluent-query-builder)
- [Real-Time](#real-time)
  - [WebSocket](#websocket--appwspath-opts-handler)
  - [WebSocketPool](#websocketpool--connection--room-manager)
  - [SSE](#server-sent-events--resseopts)
- [fetch](#fetchurl-opts)
- [Error Handling](#error-classes--httperror)
- [Debug Logger](#debug-logger--debugnamespace)
- [HTTPS](#https)
- [Examples](#examples)

---

## Exports

All exports are available from the package root:

```js
const {
  createApp, Router, cors, fetch,
  json, urlencoded, text, raw, multipart,
  static: serveStatic,
  rateLimit, logger, compress,
  helmet, timeout, requestId, cookieParser,
  csrf, validate, errorHandler,
  env, Database, Model, TYPES, Query,
  HttpError, NotFoundError, BadRequestError, ValidationError, createError, isHttpError,
  debug, version,
  WebSocketConnection, WebSocketPool, SSEStream
} = require('zero-http')
```

| Export | Type | Description |
|---|---|---|
| `createApp()` | function | Create a new application instance |
| `Router()` | function | Create a standalone router for modular route grouping |
| `json` | function | JSON body parser factory |
| `urlencoded` | function | URL-encoded body parser factory |
| `text` | function | Text body parser factory |
| `raw` | function | Raw/binary body parser factory |
| `multipart` | function | Streaming multipart/form-data parser factory |
| `static` | function | Static file serving middleware factory |
| `cors` | function | CORS middleware factory |
| `helmet` | function | Security headers middleware factory |
| `compress` | function | Response compression middleware (brotli/gzip/deflate) |
| `rateLimit` | function | In-memory rate-limiting middleware factory |
| `logger` | function | Request-logging middleware factory |
| `timeout` | function | Request timeout middleware factory |
| `requestId` | function | Request ID middleware factory |
| `cookieParser` | function | Cookie parsing middleware factory |
| `csrf` | function | CSRF protection middleware factory |
| `validate` | function | Request validation middleware factory |
| `errorHandler` | function | Configurable error-handling middleware factory |
| `env` | proxy | Typed environment variable loader and accessor |
| `Database` | class | ORM database connection factory |
| `Model` | class | Base model class for defining database entities |
| `TYPES` | enum | Column type constants for model schemas |
| `Query` | class | Fluent query builder |
| `HttpError` | class | Base HTTP error class with status code |
| `BadRequestError` | class | 400 error |
| `UnauthorizedError` | class | 401 error |
| `ForbiddenError` | class | 403 error |
| `NotFoundError` | class | 404 error |
| `MethodNotAllowedError` | class | 405 error |
| `ConflictError` | class | 409 error |
| `GoneError` | class | 410 error |
| `PayloadTooLargeError` | class | 413 error |
| `UnprocessableEntityError` | class | 422 error |
| `ValidationError` | class | 422 error with field-level details |
| `TooManyRequestsError` | class | 429 error |
| `InternalError` | class | 500 error |
| `NotImplementedError` | class | 501 error |
| `BadGatewayError` | class | 502 error |
| `ServiceUnavailableError` | class | 503 error |
| `DatabaseError` | class | Database operation error |
| `ConfigurationError` | class | Configuration/setup error |
| `MiddlewareError` | class | Middleware pipeline error |
| `RoutingError` | class | Routing resolution error |
| `TimeoutError` | class | Operation timeout error |
| `createError` | function | Create an `HttpError` by status code |
| `isHttpError` | function | Check if a value is an `HttpError` instance |
| `debug` | function | Namespaced debug logger factory |
| `fetch` | function | Server-side HTTP/HTTPS client |
| `version` | string | Package version string |
| `WebSocketConnection` | class | WebSocket connection wrapper |
| `WebSocketPool` | class | WebSocket connection & room manager |
| `SSEStream` | class | SSE stream controller |

---

## createApp()

Creates an application instance with a middleware pipeline, router, and server lifecycle.

### Methods

| Method | Signature | Description |
|---|---|---|
| `use` | `use(fn)` / `use(path, fn)` / `use(path, router)` | Register middleware globally, scoped to a path prefix, or mount a sub-router. Path-scoped middleware strips the prefix before calling downstream |
| `get` | `get(path, [opts], ...handlers)` | Register GET route handlers |
| `post` | `post(path, [opts], ...handlers)` | Register POST route handlers |
| `put` | `put(path, [opts], ...handlers)` | Register PUT route handlers |
| `delete` | `delete(path, [opts], ...handlers)` | Register DELETE route handlers |
| `patch` | `patch(path, [opts], ...handlers)` | Register PATCH route handlers |
| `options` | `options(path, [opts], ...handlers)` | Register OPTIONS route handlers |
| `head` | `head(path, [opts], ...handlers)` | Register HEAD route handlers |
| `all` | `all(path, [opts], ...handlers)` | Register handlers for ALL HTTP methods |
| `ws` | `ws(path, [opts], handler)` | Register a WebSocket upgrade handler |
| `set` | `set(key, value)` | Set an application setting |
| `enable` | `enable(key)` | Set a boolean setting to `true` |
| `disable` | `disable(key)` | Set a boolean setting to `false` |
| `enabled` | `enabled(key)` | Check if a setting is truthy |
| `disabled` | `disabled(key)` | Check if a setting is falsy |
| `locals` | property | Application-wide data store, merged into `req.locals` |
| `param` | `param(name, handler)` | Register a parameter handler for `:name` |
| `group` | `group(prefix, [...mw], fn)` | Group routes under a prefix with shared middleware |
| `chain` | `chain(path)` | Start a route chain: `{ get, post, put, delete, ... }` |
| `routes` | `routes()` | Return the full route table for introspection |
| `onError` | `onError(fn)` | Register a global error handler `(err, req, res, next)` |
| `listen` | `listen(port, [tlsOpts], [cb])` | Start HTTP or HTTPS server. Returns `http.Server` |
| `close` | `close([cb])` | Gracefully close the server |
| `handler` | property | Bound `(req, res)` handler for `http.createServer(app.handler)` |

**Route options object** — pass as the first argument after the path:

```js
// HTTPS-only route
app.get('/admin', { secure: true }, (req, res) => res.json({ admin: true }))

// HTTP-only route
app.get('/public', { secure: false }, (req, res) => res.json({ public: true }))
```

```js
const { createApp, json } = require('zero-http')
const app = createApp()

app.set('env', 'production')
app.enable('trust proxy')

app.locals.appName = 'My API'

app.get('/', (req, res) => res.json({ app: req.locals.appName }))

app.group('/api/v1', json(), (router) => {
  router.get('/users', (req, res) => res.json([]))
  router.post('/users', (req, res) => res.status(201).json(req.body))
})

app.param('id', (req, res, next, value) => {
  if (!/^\d+$/.test(value)) return res.status(400).json({ error: 'Invalid ID' })
  next()
})

app.listen(3000)
```

> **Tip:** All route methods return the app instance for chaining. Use `app.handler` when you need manual control over the HTTP server.

---

## Router

Create modular route groups with `Router()`. Routers support all the same HTTP verb methods as `createApp()`, plus mounting and chaining.

### Methods

| Method | Signature | Description |
|---|---|---|
| `get/post/put/delete/patch/options/head/all` | `(path, [opts], ...handlers)` | Register route handlers. Chainable |
| `use` | `use(prefix, router)` | Mount a child router at a prefix |
| `route` | `route(path)` | Returns a chainable object for multiple methods on one path |
| `inspect` | `inspect([prefix])` | Return a flat list of all routes |

### Route Patterns

| Pattern | Example | `req.params` |
|---|---|---|
| Named parameter | `/users/:id` | `{ id: '42' }` |
| Multiple params | `/users/:userId/posts/:postId` | `{ userId: '1', postId: '5' }` |
| Wildcard catch-all | `/files/*` | `{ '0': 'path/to/file.txt' }` |

```js
const { createApp, Router, json } = require('zero-http')
const app = createApp()

const api = Router()
api.get('/users', (req, res) => res.json([]))
api.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
api.post('/users', (req, res) => res.status(201).json(req.body))

const v2 = Router()
v2.get('/health', (req, res) => res.json({ status: 'ok', version: 2 }))
api.use('/v2', v2)

app.use(json())
app.use('/api', api)

// Route chaining
const items = Router()
items.route('/items')
  .get((req, res) => res.json([]))
  .post((req, res) => res.status(201).json(req.body))
  .delete((req, res) => res.sendStatus(204))
app.use(items)

console.log(app.routes())
```

---

## Request (`req`)

Every handler receives an enhanced request object wrapping `http.IncomingMessage`.

### Properties

| Property | Type | Description |
|---|---|---|
| `method` | string | HTTP method (`GET`, `POST`, etc.) |
| `url` | string | Full request URL including query string |
| `path` | string | URL path without query string |
| `headers` | object | Lowercased request headers |
| `query` | object | Parsed query string key-value pairs |
| `params` | object | Named route parameters (e.g. `{ id: '42' }`) |
| `body` | any | Parsed request body (populated by body parsers) |
| `ip` | string\|null | Remote IP address |
| `secure` | boolean | `true` when connection is over TLS |
| `protocol` | string | `'https'` or `'http'` |
| `cookies` | object | Parsed cookies (populated by `cookieParser()`) |
| `signedCookies` | object | Verified signed cookies |
| `locals` | object | Request-scoped data store shared between middleware |
| `raw` | object | Underlying `http.IncomingMessage` |

### Getters

| Getter | Returns | Description |
|---|---|---|
| `hostname` | string\|undefined | Hostname from `Host` header (strips port) |
| `fresh` | boolean | `true` if client cache is still valid |
| `stale` | boolean | Inverse of `fresh` |
| `xhr` | boolean | `true` if `X-Requested-With: XMLHttpRequest` |

### Methods

| Method | Signature | Returns | Description |
|---|---|---|---|
| `get` | `get(name)` | string\|undefined | Get a request header (case-insensitive) |
| `is` | `is(type)` | boolean | Check if `Content-Type` matches |
| `accepts` | `accepts(...types)` | string\|false | Content negotiation — first acceptable type from `Accept` |
| `subdomains` | `subdomains(offset)` | string[] | Extract subdomains |
| `range` | `range(size)` | object\|number | Parse the `Range` header |

```js
app.get('/api/data', (req, res) => {
  if (req.accepts('json')) return res.json({ data: [] })
  if (req.accepts('html')) return res.html('<ul></ul>')
  res.status(406).send('Not Acceptable')
})

app.get('/resource', (req, res) => {
  if (req.fresh) return res.sendStatus(304)
  res.set('ETag', '"v1"').json({ data: 'new' })
})
```

---

## Response (`res`)

Every handler receives an enhanced response object wrapping `http.ServerResponse`.

### Chainable Methods

These return `this` so you can chain calls:

| Method | Signature | Description |
|---|---|---|
| `status` | `status(code)` | Set the HTTP status code |
| `set` | `set(name, value)` | Set a response header |
| `type` | `type(contentType)` | Set `Content-Type` (supports shorthand: `'json'`, `'html'`, etc.) |
| `append` | `append(name, value)` | Append to a header |
| `vary` | `vary(field)` | Add a field to the `Vary` header |
| `cookie` | `cookie(name, value, [opts])` | Set an HTTP cookie |
| `clearCookie` | `clearCookie(name, [opts])` | Expire a cookie |

### Terminal Methods

These finalize and send the response:

| Method | Signature | Description |
|---|---|---|
| `send` | `send(body)` | Send response with auto Content-Type detection |
| `json` | `json(obj)` | Send JSON response |
| `text` | `text(str)` | Send plain text |
| `html` | `html(str)` | Send HTML |
| `sendStatus` | `sendStatus(code)` | Send status code with reason phrase body |
| `redirect` | `redirect([status], url)` | Redirect (default 302) |
| `sendFile` | `sendFile(path, [opts], [cb])` | Stream a file |
| `download` | `download(path, [filename], [cb])` | Prompt a file download |
| `sse` | `sse([opts])` | Open an SSE stream → `SSEStream` |
| `get` | `get(name)` | Get a previously-set response header |

### `res.cookie()` Options

| Option | Type | Default | Description |
|---|---|---|---|
| `domain` | string | — | Cookie domain |
| `path` | string | `'/'` | Cookie path |
| `expires` | Date | — | Expiration date |
| `maxAge` | number | — | Max age in **seconds** |
| `httpOnly` | boolean | `true` | Prevent client-side access |
| `secure` | boolean | — | Only send over HTTPS |
| `sameSite` | string | `'Lax'` | `'Strict'`, `'Lax'`, or `'None'` |

```js
res.cookie('session', token, { maxAge: 3600, httpOnly: true, secure: true })
res.status(200).set('X-Custom', 'value').json({ ok: true })
res.download('/reports/q4.pdf', 'Q4-Report.pdf')
res.sendStatus(204)
```

---

## Body Parsers

All body parsers accept these common options:

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | number\|string | `'1mb'` | Maximum body size (`'10kb'`, `'2mb'`, etc.) |
| `type` | string\|function | varies | Content-Type to match |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403 |

### json([opts])

| Option | Default | Description |
|---|---|---|
| `strict` | `true` | Only accept objects and arrays |
| `reviver` | — | Custom `JSON.parse()` reviver |

```js
app.use(json({ limit: '500kb', strict: true }))
```

### urlencoded([opts])

| Option | Default | Description |
|---|---|---|
| `extended` | `false` | Enable nested bracket syntax: `a[b]=1` → `{ a: { b: '1' } }` |

> **Security:** `__proto__`, `constructor`, and `prototype` keys are filtered when `extended: true`.

```js
app.use(urlencoded({ extended: true }))
```

### text([opts])

| Option | Default | Description |
|---|---|---|
| `encoding` | `'utf8'` | Character encoding |

### raw([opts])

Read the body as a `Buffer` into `req.body`.

### multipart([opts])

| Option | Default | Description |
|---|---|---|
| `dir` | `os.tmpdir()/zero-http-uploads` | Upload directory |
| `maxFileSize` | — | Maximum file size in bytes (413 on exceed) |

Sets `req.body = { fields, files }`. Each file: `originalFilename`, `storedName`, `path`, `contentType`, `size`.

> **Security:** Filenames are sanitized — path traversal, null bytes, and unsafe characters are stripped.

```js
app.post('/upload', multipart({ dir: './uploads', maxFileSize: 5 * 1024 * 1024 }), (req, res) => {
  res.json({ files: req.body.files, fields: req.body.fields })
})
```

---

## Middleware

### helmet([opts])

Security headers middleware.

| Option | Type | Default | Description |
|---|---|---|---|
| `contentSecurityPolicy` | object\|false | permissive CSP | CSP directives or `false` to disable |
| `crossOriginOpenerPolicy` | string\|false | `'same-origin'` | COOP value |
| `crossOriginResourcePolicy` | string\|false | `'same-origin'` | CORP value |
| `dnsPrefetchControl` | boolean | `true` | `X-DNS-Prefetch-Control: off` |
| `frameguard` | string\|false | `'deny'` | `X-Frame-Options` |
| `hidePoweredBy` | boolean | `true` | Remove `X-Powered-By` |
| `hsts` | boolean | `true` | `Strict-Transport-Security` |
| `noSniff` | boolean | `true` | `X-Content-Type-Options: nosniff` |

```js
app.use(helmet())
app.use(helmet({ frameguard: 'sameorigin', hsts: false }))
```

### cors([opts])

CORS middleware with automatic preflight handling.

| Option | Type | Default | Description |
|---|---|---|---|
| `origin` | string\|array | `'*'` | Allowed origin(s) |
| `methods` | string | `'GET,POST,PUT,DELETE,OPTIONS'` | Allowed methods |
| `allowedHeaders` | string | `'Content-Type,Authorization'` | Headers client can send |
| `exposedHeaders` | string | — | Headers browser can read |
| `credentials` | boolean | `false` | Allow credentials |
| `maxAge` | number | — | Preflight cache seconds |

```js
app.use(cors({ origin: ['https://app.example.com'], credentials: true }))
```

### compress([opts])

Response compression (brotli > gzip > deflate).

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | number | `1024` | Minimum response size to compress |
| `level` | number | `-1` | Compression level (1–9) |
| `filter` | function | — | `(req, res) => boolean` |

```js
app.use(compress({ threshold: 512, level: 6 }))
```

### rateLimit([opts])

In-memory per-IP rate limiter.

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | number | `60000` | Time window (ms) |
| `max` | number | `100` | Max requests per window |
| `message` | string | `'Too many requests…'` | Error body |
| `statusCode` | number | `429` | Rate-limited status |
| `keyGenerator` | function | `(req) => req.ip` | Custom key function |

```js
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }))
```

### logger([opts])

| Option | Type | Default | Description |
|---|---|---|---|
| `format` | string | `'dev'` | `'dev'`, `'short'`, or `'tiny'` |
| `logger` | function | `console.log` | Custom output function |
| `colors` | boolean | auto | ANSI colors |

### timeout(ms, [opts])

| Option | Type | Default | Description |
|---|---|---|---|
| `ms` | number | `30000` | Timeout in ms |
| `status` | number | `408` | Timeout status code |
| `message` | string | `'Request Timeout'` | Error body |

Sets `req.timedOut = true` on timeout.

```js
app.use(timeout(5000))
```

### requestId([opts])

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | string | `'X-Request-Id'` | Response header name |
| `generator` | function | UUID v4 | Custom ID generator |
| `trustProxy` | boolean | `false` | Reuse incoming header |

Sets `req.id` and the response header.

### cookieParser([secret], [opts])

Parse `Cookie` header into `req.cookies`. Optionally verify signed cookies.

| Parameter | Type | Description |
|---|---|---|
| `secret` | string\|string[] | Signing secret(s) |
| `options.decode` | boolean | URI-decode values (default `true`) |

Static: `cookieParser.sign(value, secret)` → `'s:<value>.<hmac>'`

```js
app.use(cookieParser('my-secret'))

app.get('/profile', (req, res) => {
  res.json({ user: req.signedCookies.user, theme: req.cookies.theme })
})
```

### static(rootPath, [opts])

Serve static files. 60+ MIME types.

| Option | Type | Default | Description |
|---|---|---|---|
| `index` | string\|false | `'index.html'` | Default file for directories |
| `maxAge` | number | `0` | Cache-Control max-age (ms) |
| `dotfiles` | string | `'ignore'` | `'allow'`, `'deny'`, or `'ignore'` |
| `extensions` | string[] | — | Fallback extensions |
| `setHeaders` | function | — | `(res, filePath) => void` |

```js
app.use('/public', serveStatic('./public', { maxAge: 86400000, dotfiles: 'deny' }))
```

### validate(schema, [opts])

Request validation middleware. Returns 422 with detailed errors on failure.

**Schema targets:** `body`, `query`, `params`

| Rule | Type | Description |
|---|---|---|
| `type` | string | `'string'`, `'integer'`, `'number'`, `'boolean'`, `'array'`, `'date'`, `'email'`, `'url'`, `'uuid'`, `'json'` |
| `required` | boolean | Fail if missing |
| `default` | any | Default value |
| `min` / `max` | number | Numeric range |
| `minLength` / `maxLength` | number | String length |
| `match` | RegExp | Pattern match |
| `enum` | array | Allowed values |
| `validate` | function | Custom `(value) => errorString` |

| Option | Type | Default | Description |
|---|---|---|---|
| `stripUnknown` | boolean | `true` | Remove unknown fields |

```js
app.post('/users', validate({
  body: {
    name:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
    email: { type: 'email', required: true },
    age:   { type: 'integer', min: 0, max: 150 },
    role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
  }
}), (req, res) => res.json(req.body))
```

### csrf([opts])

CSRF protection using double-submit cookie + header/body pattern.

Checks: `req.headers['x-csrf-token']` → `req.body._csrf` → `req.query._csrf`

| Option | Type | Default | Description |
|---|---|---|---|
| `cookie` | string | `'_csrf'` | Cookie name |
| `header` | string | `'x-csrf-token'` | Request header |
| `saltLength` | number | `18` | Token randomness bytes |
| `secret` | string | auto | HMAC secret |
| `ignoreMethods` | string[] | `['GET','HEAD','OPTIONS']` | Methods to skip |
| `ignorePaths` | string[] | `[]` | Path prefixes to skip |
| `onError` | function | — | Custom error handler |

```js
app.use(cookieParser())
app.use(json())
app.use(csrf())

app.get('/form', (req, res) => res.json({ csrfToken: req.csrfToken }))
```

### errorHandler([opts])

| Option | Type | Default | Description |
|---|---|---|---|
| `stack` | boolean | `NODE_ENV !== 'production'` | Include stack traces |
| `log` | boolean | `true` | Log errors |
| `logger` | function | `console.error` | Log function |
| `formatter` | function | — | `(err, req, isDev) => object` |
| `onError` | function | — | `(err, req, res) => void` |

```js
app.use(errorHandler())
app.use(errorHandler({
  formatter: (err, req, isDev) => ({
    message: err.message,
    ...(isDev && { stack: err.stack }),
  }),
}))
```

---

## Environment Config — `env`

Zero-dependency typed environment variable system.

### File Loading Order

1. `.env` — shared defaults
2. `.env.local` — local overrides (gitignored)
3. `.env.{NODE_ENV}` — environment-specific
4. `.env.{NODE_ENV}.local` — env-specific local overrides

`process.env` always takes final precedence.

### Schema Types

`string`, `number`, `integer`, `boolean`, `port`, `array`, `json`, `url`, `enum`

### env.load(schema, [opts])

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | string | `process.cwd()` | Directory for `.env` files |
| `override` | boolean | — | `true`: write to `process.env`; `false`: no sync; default: fill missing keys |

Schema fields: `type`, `required`, `default`, `min`, `max`, `match`, `separator` (arrays), `values` (enums).

```js
const { env } = require('zero-http')

env.load({
  PORT:            { type: 'port', default: 3000 },
  DATABASE_URL:    { type: 'string', required: true },
  DEBUG:           { type: 'boolean', default: false },
  ALLOWED_ORIGINS: { type: 'array', separator: ',' },
  LOG_LEVEL:       { type: 'enum', values: ['debug','info','warn','error'], default: 'info' },
})

env.PORT              // 3000 (number)
env('PORT')           // 3000 (callable)
env.get('PORT')       // 3000
env.has('PORT')       // true
env.require('DB_URL') // throws if missing
env.all()             // { PORT: 3000, ... }
```

---

## Database / ORM

Built-in ORM with memory, JSON, SQLite, MySQL, PostgreSQL, and MongoDB adapters. Memory and JSON work out of the box; others use "bring your own driver."

### Database.connect(adapter, [opts])

| Adapter | Driver | Options |
|---|---|---|
| `'memory'` | none | — |
| `'json'` | none | `{ path: './data.json' }` |
| `'sqlite'` | `better-sqlite3` | `{ filename: './db.sqlite' }` |
| `'mysql'` | `mysql2` | `{ host, port, user, password, database }` |
| `'postgres'` | `pg` | `{ host, port, user, password, database }` |
| `'mongo'` | `mongodb` | `{ url, database }` |

```js
const { Database, Model, TYPES } = require('zero-http')
const db = Database.connect('sqlite', { filename: './app.db' })
```

### Model

Define entities by extending `Model`.

| Static Property | Type | Default | Description |
|---|---|---|---|
| `table` | string | required | Table/collection name |
| `schema` | object | `{}` | Column definitions |
| `timestamps` | boolean | `false` | Auto `createdAt`/`updatedAt` |
| `softDelete` | boolean | `false` | Use `deletedAt` instead of real deletion |
| `hidden` | string[] | `[]` | Fields excluded from `toJSON()` |
| `scopes` | object | `{}` | Named reusable query conditions |

#### Schema Constraints

| Constraint | Description |
|---|---|
| `primaryKey` | Mark as primary key |
| `autoIncrement` | Auto-increment |
| `required` | Must be provided |
| `unique` | Enforce uniqueness |
| `default` | Default value (or function) |
| `minLength` / `maxLength` | String length |
| `min` / `max` | Numeric range |
| `enum` | Allowed values |
| `match` | RegExp pattern |
| `nullable` | Allow nulls |

```js
class User extends Model {
  static table = 'users'
  static schema = {
    id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
    name:     { type: TYPES.STRING, required: true, maxLength: 100 },
    email:    { type: TYPES.STRING, required: true, unique: true },
    role:     { type: TYPES.STRING, enum: ['user', 'admin'], default: 'user' },
    password: { type: TYPES.STRING, required: true },
  }
  static timestamps = true
  static softDelete = true
  static hidden = ['password']
  static scopes = {
    active: q => q.where('active', true),
    admins: q => q.where('role', 'admin'),
  }
}

db.register(User)
await db.sync()
```

#### CRUD Operations

```js
const user = await User.create({ name: 'Alice', email: 'a@b.com', password: 'hashed' })
const users = await User.findAll()
const alice = await User.findById(1)
const one   = await User.findOne({ email: 'a@b.com' })
await alice.update({ name: 'Alice W.' })
await alice.delete()
const count = await User.count({ role: 'user' })
const activeAdmins = await User.scope('active').scope('admins').exec()
```

### TYPES

Column type constants:

`STRING`, `INTEGER`, `FLOAT`, `BOOLEAN`, `DATE`, `DATETIME`, `JSON`, `TEXT`, `BLOB`, `UUID`

### Fluent Query Builder

```js
const results = await User.query()
  .where('age', '>', 18)
  .where('role', 'admin')
  .orderBy('name', 'asc')
  .limit(10)
  .offset(20)
  .select('name', 'email')
```

#### Selection

| Method | Description |
|---|---|
| `select(...fields)` | Choose columns to return |
| `distinct()` | Return unique rows only |

#### Filtering

| Method | Description |
|---|---|
| `where(field, [op], value)` | Add a condition (`=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `IN`, `NOT IN`, `BETWEEN`) |
| `orWhere(field, [op], value)` | OR condition |
| `whereNull(field)` | Field is null |
| `whereNotNull(field)` | Field is not null |
| `whereIn(field, values)` | Field in array |
| `whereNotIn(field, values)` | Field not in array |
| `whereBetween(field, [lo, hi])` | Field between range |
| `whereNot(field, value)` | Field not equal |
| `whereRaw(fn)` | Custom filter function |
| `whereLike(field, pattern)` | SQL LIKE pattern match |
| `whereExists(subFn)` | EXISTS subquery |
| `having(field, op, value)` | Post-group filter |

#### Ordering & Pagination

| Method | Description |
|---|---|
| `orderBy(field, dir)` | Sort by field (`'asc'`/`'desc'`) |
| `limit(n)` | Max rows |
| `offset(n)` | Skip rows |
| `page(num, size)` | Page helper (1-indexed) |
| `paginate(num, size)` | Returns `{ data, total, page, pageSize, totalPages }` |
| `chunk(size, fn)` | Process in batches |

#### Grouping & Joins

| Method | Description |
|---|---|
| `groupBy(field)` | Group results |
| `join(target, localKey, foreignKey)` | Inner join |
| `leftJoin(target, localKey, foreignKey)` | Left join |
| `crossJoin(target)` | Cross join |
| `with(relation, config)` | Eager-load relation |

#### Execution

| Method | Description |
|---|---|
| `exec()` | Execute and return results |
| `first()` | First matching row |
| `count()` | Count matching rows |
| `exists()` | Boolean existence check |
| `pluck(field)` | Array of single field values |
| `value(field)` | Single field from first row |

#### Aggregates

| Method | Description |
|---|---|
| `sum(field)` | Sum |
| `avg(field)` | Average |
| `min(field)` | Minimum |
| `max(field)` | Maximum |

#### Functional Transforms

| Method | Description |
|---|---|
| `map(fn)` | Transform each result |
| `tap(fn)` | Side-effect on results |
| `when(condition, fn)` | Conditional query building |
| `unless(condition, fn)` | Inverse conditional |
| `pipe(fn)` | Pass query through a function |

#### Conditional & Debugging

| Method | Description |
|---|---|
| `toSQL()` | Return SQL string (SQL adapters) |
| `explain()` | Return query plan |
| `clone()` | Deep-copy the query |

---

## Real-Time

### WebSocket — `app.ws(path, [opts], handler)`

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPayload` | number | `1048576` | Max incoming frame size (1 MB) |
| `pingInterval` | number | `30000` | Auto-ping interval (ms) |
| `verifyClient` | function | — | `(req) => boolean` |

#### WebSocketConnection Properties

| Property | Type | Description |
|---|---|---|
| `id` | string | Unique connection ID |
| `readyState` | number | 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED |
| `protocol` | string | Negotiated sub-protocol |
| `ip` | string\|null | Remote IP |
| `query` | object | Parsed query params |
| `secure` | boolean | `true` for WSS |
| `data` | object | Per-connection data store |
| `uptime` | number | Ms since connection |

#### WebSocketConnection Methods

| Method | Signature | Description |
|---|---|---|
| `send` | `send(data, [opts])` | Send text or binary |
| `sendJSON` | `sendJSON(obj)` | Send JSON |
| `ping` | `ping([payload], [cb])` | Send ping frame |
| `close` | `close([code], [reason])` | Graceful close |
| `terminate` | `terminate()` | Force-destroy socket |
| `on` | `on(event, fn)` | Events: `message`, `close`, `error`, `ping`, `pong`, `drain` |
| `off` | `off(event, fn)` | Remove listener |

```js
const { createApp, WebSocketPool } = require('zero-http')
const app = createApp()
const pool = new WebSocketPool()

app.ws('/chat', (ws, req) => {
  pool.add(ws)
  pool.join(ws, req.query.room || 'general')
  ws.on('message', msg => pool.toRoom('general', msg, ws))
  ws.on('close', () => pool.toRoomJSON('general', { type: 'leave' }))
})
```

### WebSocketPool — Connection & Room Manager

| Method | Signature | Description |
|---|---|---|
| `add` | `add(ws)` | Track a connection |
| `remove` | `remove(ws)` | Remove from pool and rooms |
| `join` | `join(ws, room)` | Add to a room |
| `leave` | `leave(ws, room)` | Remove from a room |
| `broadcast` | `broadcast(data, [exclude])` | Send to ALL |
| `broadcastJSON` | `broadcastJSON(obj, [exclude])` | Broadcast JSON |
| `toRoom` | `toRoom(room, data, [exclude])` | Send to room |
| `toRoomJSON` | `toRoomJSON(room, obj, [exclude])` | Send JSON to room |
| `in` | `in(room)` | Get room connections |
| `roomsOf` | `roomsOf(ws)` | Rooms a connection belongs to |
| `closeAll` | `closeAll([code], [reason])` | Close all |
| `size` | getter | Connection count |
| `clients` | getter | All connections |
| `rooms` | getter | Active room names |
| `roomSize` | `roomSize(room)` | Room connection count |

### Server-Sent Events — `res.sse([opts])`

| Option | Type | Default | Description |
|---|---|---|---|
| `retry` | number | — | Reconnection interval hint (ms) |
| `keepAlive` | number | `0` | Auto keep-alive interval (ms) |
| `autoId` | boolean | `false` | Auto-increment event IDs |
| `pad` | number | `0` | Initial padding bytes |
| `headers` | object | — | Additional response headers |

#### SSEStream Methods (all chainable)

| Method | Signature | Description |
|---|---|---|
| `send` | `send(data, [id])` | Send data event |
| `sendJSON` | `sendJSON(obj, [id])` | Send JSON event |
| `event` | `event(name, data, [id])` | Named event |
| `comment` | `comment(text)` | Comment line |
| `retry` | `retry(ms)` | Update retry interval |
| `keepAlive` | `keepAlive(ms, [comment])` | Start keep-alive |
| `close` | `close()` | Close stream |

#### SSEStream Properties

| Property | Type | Description |
|---|---|---|
| `connected` | boolean | Stream is open |
| `eventCount` | number | Total events sent |
| `bytesSent` | number | Bytes written |
| `uptime` | number | Ms since connected |
| `lastEventId` | string\|null | `Last-Event-ID` |
| `secure` | boolean | HTTPS |
| `data` | object | Per-stream data store |

```js
app.get('/events', (req, res) => {
  const sse = res.sse({ retry: 5000, autoId: true, keepAlive: 30000 })
  sse.send('connected')

  const interval = setInterval(() => sse.event('tick', { time: Date.now() }), 1000)
  sse.on('close', () => clearInterval(interval))
})
```

---

## fetch(url, [opts])

Zero-dependency server-side HTTP/HTTPS client.

| Option | Type | Default | Description |
|---|---|---|---|
| `method` | string | `'GET'` | HTTP method |
| `headers` | object | — | Request headers |
| `body` | string\|Buffer\|object | — | Body (objects auto-JSON'd) |
| `timeout` | number | — | Timeout (ms) |
| `signal` | AbortSignal | — | Cancel support |
| `onDownloadProgress` | function | — | `({ loaded, total }) => void` |
| `onUploadProgress` | function | — | `({ loaded, total }) => void` |

**TLS options:** `rejectUnauthorized`, `ca`, `cert`, `key`, `pfx`, `passphrase`

### Response

| Property/Method | Type | Description |
|---|---|---|
| `status` | number | HTTP status code |
| `ok` | boolean | 200–299 |
| `secure` | boolean | HTTPS |
| `headers` | object | Response headers with `.get(name)` |
| `text()` | Promise\<string\> | Read as string |
| `json()` | Promise\<object\> | Read as JSON |
| `arrayBuffer()` | Promise\<Buffer\> | Read as Buffer |

```js
const { fetch } = require('zero-http')

const res = await fetch('https://api.example.com/data')
const data = await res.json()

const res = await fetch('https://api.example.com/users', {
  method: 'POST',
  body: { name: 'Alice' },
})

await fetch('https://example.com/bigfile.zip', {
  onDownloadProgress: ({ loaded, total }) => {
    console.log(`${Math.round(loaded / total * 100)}%`)
  }
})
```

---

## Error Classes — `HttpError`

Structured HTTP error classes with status codes and machine-readable codes.

```js
const { NotFoundError, ValidationError, createError, isHttpError } = require('zero-http')

throw new NotFoundError('User not found')
// → { error: 'User not found', code: 'NOT_FOUND', statusCode: 404 }

throw new ValidationError('Invalid input', { email: 'required', age: 'must be >= 18' })
// → { statusCode: 422, details: { ... } }

throw createError(503, 'Database unavailable')
if (isHttpError(err)) console.log(err.statusCode)
```

### HTTP Error Classes

| Class | Status | Code |
|---|---|---|
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `MethodNotAllowedError` | 405 | `METHOD_NOT_ALLOWED` |
| `ConflictError` | 409 | `CONFLICT` |
| `GoneError` | 410 | `GONE` |
| `PayloadTooLargeError` | 413 | `PAYLOAD_TOO_LARGE` |
| `UnprocessableEntityError` | 422 | `UNPROCESSABLE_ENTITY` |
| `ValidationError` | 422 | `VALIDATION_FAILED` |
| `TooManyRequestsError` | 429 | `TOO_MANY_REQUESTS` |
| `InternalError` | 500 | `INTERNAL_ERROR` |
| `NotImplementedError` | 501 | `NOT_IMPLEMENTED` |
| `BadGatewayError` | 502 | `BAD_GATEWAY` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |

### Framework Error Classes

| Class | Code | Use case |
|---|---|---|
| `DatabaseError` | `DATABASE_ERROR` | Database operation failures |
| `ConfigurationError` | `CONFIGURATION_ERROR` | Invalid setup or missing config |
| `MiddlewareError` | `MIDDLEWARE_ERROR` | Middleware pipeline failures |
| `RoutingError` | `ROUTING_ERROR` | Route resolution failures |
| `TimeoutError` | `TIMEOUT_ERROR` | Operation timeouts |

---

## Debug Logger — `debug(namespace)`

Namespaced logger with levels, colors, timestamps, and `DEBUG` filtering.

**Levels:** `trace` (0) → `debug` (1) → `info` (2) → `warn` (3) → `error` (4) → `fatal` (5) → `silent` (6)

```js
const { debug } = require('zero-http')
const log = debug('app:routes')

log('debug message')
log.info('server started on port %d', 3000)
log.warn('deprecated route')
log.error('connection failed', err)
```

| Variable | Example | Description |
|---|---|---|
| `DEBUG` | `app:*,router` | Enable namespaces (glob) |
| `DEBUG_LEVEL` | `warn` | Minimum level |

```bash
DEBUG=app:* node server.js
DEBUG=*,-verbose:* node server.js
DEBUG_LEVEL=warn node server.js
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

| API | Property | Description |
|---|---|---|
| Request | `req.secure` / `req.protocol` | `true` / `'https'` |
| WebSocket | `ws.secure` | `true` for WSS |
| SSE | `sse.secure` | `true` over TLS |
| Fetch | `res.secure` | `true` for `https:` |
| Body Parsers | `requireSecure` option | Reject non-TLS with 403 |
| Routes | `{ secure: true }` | HTTPS-only matching |

---

## Examples

### WebSocket Chat with Rooms

```js
const { createApp, WebSocketPool } = require('zero-http')
const app = createApp()
const pool = new WebSocketPool()

app.ws('/chat', (ws, req) => {
  const room = req.query.room || 'general'
  ws.data.name = req.query.name || 'Anon'

  pool.add(ws)
  pool.join(ws, room)
  pool.toRoomJSON(room, { type: 'join', user: ws.data.name }, ws)

  ws.on('message', msg => {
    pool.toRoomJSON(room, { type: 'message', user: ws.data.name, text: msg }, ws)
  })

  ws.on('close', () => {
    pool.toRoomJSON(room, { type: 'leave', user: ws.data.name })
  })
})

app.listen(3000)
```

### Real-Time Dashboard with SSE

```js
const { createApp, helmet, compress } = require('zero-http')
const app = createApp()
app.use(helmet())
app.use(compress())

const clients = new Set()

app.get('/dashboard/stream', (req, res) => {
  const sse = res.sse({ autoId: true, keepAlive: 15000, pad: 2048 })
  clients.add(sse)
  sse.on('close', () => clients.delete(sse))
})

setInterval(() => {
  const metrics = { cpu: process.cpuUsage(), mem: process.memoryUsage().heapUsed }
  for (const sse of clients) sse.event('metrics', metrics)
}, 1000)

app.listen(3000)
```

### File Upload API

```js
const { createApp, json, multipart } = require('zero-http')
const app = createApp()
app.use(json())

app.post('/upload', multipart({ dir: './uploads', maxFileSize: 10 * 1024 * 1024 }), (req, res) => {
  const { files, fields } = req.body
  res.json({
    uploaded: Object.keys(files).length,
    details: Object.values(files).map(f => ({
      name: f.originalFilename,
      size: f.size,
      type: f.contentType
    }))
  })
})

app.listen(3000)
```

### Middleware Composition

```js
// Order matters
app.use(logger())      // 1. Log
app.use(helmet())      // 2. Security headers
app.use(cors())        // 3. CORS
app.use(compress())    // 4. Compress
app.use(rateLimit())   // 5. Rate limit
app.use(json())        // 6. Parse body

// Path-scoped
app.use('/api', rateLimit({ max: 50 }))
app.use('/admin', (req, res, next) => {
  if (!req.get('authorization')) return res.sendStatus(401)
  next()
})

// Error handler goes last
app.onError((err, req, res) => {
  res.status(err.statusCode || 500).json({ error: err.message })
})
```

---

## License

MIT
