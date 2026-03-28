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

> **Full API reference, interactive playground, and live demos at [z-http.com](https://z-http.com)**

## Features

- **Zero dependencies** — built entirely on Node.js core APIs
- **Express-like API** — `createApp()`, `use()`, `get()`, `post()`, `put()`, `delete()`, `patch()`, `head()`, `options()`, `all()`, `listen()`
- **HTTP & HTTPS** — pass `{ key, cert }` to `listen()` for TLS; `req.secure` and `req.protocol` everywhere
- **Built-in ORM** — `Database.connect()` with memory, JSON, SQLite, MySQL, PostgreSQL, and MongoDB adapters; `Model` base class with schema validation, CRUD, timestamps, soft deletes, scopes, hooks, and a fluent `Query` builder
- **Environment config** — typed `.env` loader with schema validation, multi-environment file support (`.env.local`, `.env.production`), and property-style access (`env.PORT`)
- **Built-in WebSocket server** — `app.ws('/path', handler)` with RFC 6455 framing, auto-ping, sub-protocols, `verifyClient`, rooms, and broadcasting via `WebSocketPool`
- **Server-Sent Events** — `res.sse()` returns a chainable stream controller with auto-IDs, keep-alive, retry hints, and event counting
- **12 built-in middlewares** — `cors()`, `helmet()`, `compress()`, `rateLimit()`, `logger()`, `timeout()`, `requestId()`, `cookieParser()`, `csrf()`, `validate()`, `errorHandler()`, and static file serving
- **5 body parsers** — `json()`, `urlencoded()`, `text()`, `raw()`, `multipart()` with HTTPS enforcement option
- **Request validation** — `validate()` middleware with typed schema for body, query, and params — supports string, number, boolean, email, url, uuid, date, and custom validators
- **CSRF protection** — double-submit cookie pattern with HMAC tokens, automatic rotation, and configurable paths
- **Error handling** — `HttpError` classes for every common status code, `errorHandler()` middleware with dev/production formatting, and `createError()` factory
- **Debug logging** — namespaced logger with levels (trace → fatal), `DEBUG=app:*` pattern matching, colors, timestamps, and JSON mode
- **Router sub-apps** — `Router()` with nested mounting, route chaining, wildcard/param patterns, protocol-aware routing, and full introspection
- **Request & response helpers** — content negotiation, cookies, caching, range parsing, file downloads, redirects, and more
- **Tiny `fetch` replacement** — server-side HTTP/HTTPS client with TLS passthrough, progress callbacks, and abort support
- **Security built-in** — CRLF injection prevention, prototype pollution filtering, path traversal guards, filename sanitization

```bash
npm install zero-http
```

## Quick Start

```js
const { createApp, json } = require('zero-http')
const app = createApp()

app.use(json())
app.post('/echo', (req, res) => res.json({ received: req.body }))
app.listen(3000, () => console.log('Listening on :3000'))
```

## Demo

Live documentation and playground at **https://z-http.com**, or run locally:

```bash
npm run docs
# open http://localhost:3000
```

---

## API Reference

### Exports

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
  debug,
  WebSocketConnection, WebSocketPool, SSEStream
} = require('zero-http')
```

| Export | Type | Description |
|---|---|---|
| `createApp()` | function | Create a new application instance. |
| `Router()` | function | Create a standalone router for modular route grouping. |
| `json` | function | JSON body parser factory. |
| `urlencoded` | function | URL-encoded body parser factory. |
| `text` | function | Text body parser factory. |
| `raw` | function | Raw/binary body parser factory. |
| `multipart` | function | Streaming multipart/form-data parser factory. |
| `static` | function | Static file serving middleware factory. |
| `cors` | function | CORS middleware factory. |
| `helmet` | function | Security headers middleware factory. |
| `compress` | function | Response compression middleware (brotli/gzip/deflate). |
| `rateLimit` | function | In-memory rate-limiting middleware factory. |
| `logger` | function | Request-logging middleware factory. |
| `timeout` | function | Request timeout middleware factory. |
| `requestId` | function | Request ID middleware factory. |
| `cookieParser` | function | Cookie parsing middleware factory. |
| `csrf` | function | CSRF protection middleware factory. |
| `validate` | function | Request validation middleware factory. |
| `errorHandler` | function | Configurable error-handling middleware factory. |
| `env` | proxy | Typed environment variable loader and accessor. |
| `Database` | class | ORM database connection factory. |
| `Model` | class | Base model class for defining database entities. |
| `TYPES` | enum | Column type constants for model schemas. |
| `Query` | class | Fluent query builder. |
| `HttpError` | class | Base HTTP error class with status code. |
| `BadRequestError` | class | 400 error. |
| `UnauthorizedError` | class | 401 error. |
| `ForbiddenError` | class | 403 error. |
| `NotFoundError` | class | 404 error. |
| `MethodNotAllowedError` | class | 405 error. |
| `ConflictError` | class | 409 error. |
| `GoneError` | class | 410 error. |
| `PayloadTooLargeError` | class | 413 error. |
| `UnprocessableEntityError` | class | 422 error. |
| `ValidationError` | class | 422 error with field-level details. |
| `TooManyRequestsError` | class | 429 error. |
| `InternalError` | class | 500 error. |
| `NotImplementedError` | class | 501 error. |
| `BadGatewayError` | class | 502 error. |
| `ServiceUnavailableError` | class | 503 error. |
| `createError` | function | Create an `HttpError` by status code. |
| `isHttpError` | function | Check if a value is an `HttpError` instance. |
| `debug` | function | Namespaced debug logger factory. |
| `fetch` | function | Server-side HTTP/HTTPS client. |
| `WebSocketConnection` | class | WebSocket connection wrapper. |
| `WebSocketPool` | class | WebSocket connection & room manager. |
| `SSEStream` | class | SSE stream controller. |

---

### createApp()

Creates an application instance with a middleware pipeline, router, and server lifecycle.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `use` | `use(fn)` / `use(path, fn)` / `use(path, router)` | Register middleware globally, scoped to a path prefix, or mount a sub-router. Path-scoped middleware strips the prefix before calling downstream. |
| `get` | `get(path, [opts], ...handlers)` | Register GET route handlers. |
| `post` | `post(path, [opts], ...handlers)` | Register POST route handlers. |
| `put` | `put(path, [opts], ...handlers)` | Register PUT route handlers. |
| `delete` | `delete(path, [opts], ...handlers)` | Register DELETE route handlers. |
| `patch` | `patch(path, [opts], ...handlers)` | Register PATCH route handlers. |
| `options` | `options(path, [opts], ...handlers)` | Register OPTIONS route handlers. |
| `head` | `head(path, [opts], ...handlers)` | Register HEAD route handlers. |
| `all` | `all(path, [opts], ...handlers)` | Register handlers for ALL HTTP methods. |
| `ws` | `ws(path, [opts], handler)` | Register a WebSocket upgrade handler. |
| `onError` | `onError(fn)` | Register a global error handler `fn(err, req, res, next)`. |
| `listen` | `listen(port, [tlsOpts], [cb])` | Start HTTP or HTTPS server. Returns the underlying `http.Server`. |
| `close` | `close([cb])` | Gracefully close the server. |
| `routes` | `routes()` | Return a flat list of all registered routes including sub-routers and WebSocket handlers. |
| `handler` | property | Bound `(req, res)` handler for use with `http.createServer(app.handler)`. |

**Route options object** — pass as the first argument after the path:

```js
// HTTPS-only route
app.get('/admin', { secure: true }, (req, res) => res.json({ admin: true }))

// HTTP-only route
app.get('/public', { secure: false }, (req, res) => res.json({ public: true }))
```

> **Tip:** Use `app.handler` when you need manual control over the HTTP server, e.g. sharing with other libraries or running on a custom port.

---

### Request (`req`)

Every handler receives an enhanced request object wrapping the native `http.IncomingMessage`.

#### Properties

| Property | Type | Description |
|---|---|---|
| `method` | string | HTTP method (`GET`, `POST`, etc.). |
| `url` | string | Full request URL including query string. |
| `path` | string | URL path without query string. |
| `headers` | object | Lowercased request headers. |
| `query` | object | Parsed query string key-value pairs. |
| `params` | object | Named route parameters (e.g. `{ id: '42' }` from `/users/:id`). |
| `body` | any | Parsed request body (populated by body parsers). |
| `ip` | string\|null | Remote IP address. |
| `secure` | boolean | `true` when connection is over TLS. |
| `protocol` | string | `'https'` or `'http'`. |
| `cookies` | object | Parsed cookies (populated by `cookieParser()`). |
| `signedCookies` | object | Verified signed cookies (populated by `cookieParser(secret)`). |
| `locals` | object | Request-scoped data store shared between middleware and handlers. |
| `raw` | object | Underlying `http.IncomingMessage` for advanced use. |

#### Getters

| Getter | Returns | Description |
|---|---|---|
| `hostname` | string\|undefined | Hostname from `Host` header (strips port). |
| `fresh` | boolean | `true` if client cache is still valid (based on `ETag`/`If-Modified-Since`). |
| `stale` | boolean | Inverse of `fresh`. |
| `xhr` | boolean | `true` if `X-Requested-With: XMLHttpRequest` is present. |

#### Methods

| Method | Signature | Returns | Description |
|---|---|---|---|
| `get` | `get(name)` | string\|undefined | Get a request header (case-insensitive). |
| `is` | `is(type)` | boolean | Check if `Content-Type` matches. Accepts shorthand (`'json'`, `'html'`) or full MIME. |
| `accepts` | `accepts(...types)` | string\|false | Content negotiation — returns the first acceptable type from the `Accept` header, or `false`. |
| `subdomains` | `subdomains(offset = 2)` | string[] | Extract subdomains. E.g. `'v2.api.example.com'` → `['api', 'v2']`. |
| `range` | `range(size)` | object\|number | Parse the `Range` header. Returns `{ type, ranges: [{ start, end }] }`, `-1` (unsatisfiable), or `-2` (malformed). |

```js
app.get('/api/data', (req, res) => {
  // Content negotiation
  if (req.accepts('json')) return res.json({ data: [] })
  if (req.accepts('html')) return res.html('<ul></ul>')
  res.status(406).send('Not Acceptable')
})

// Conditional GET
app.get('/resource', (req, res) => {
  if (req.fresh) return res.sendStatus(304)
  res.set('ETag', '"v1"').json({ data: 'new' })
})

// Range requests for streaming
app.get('/video', (req, res) => {
  const r = req.range(fileSize)
  if (r === -1) return res.sendStatus(416)
  // serve partial content...
})
```

---

### Response (`res`)

Every handler receives an enhanced response object wrapping `http.ServerResponse`.

#### Properties

| Property | Type | Description |
|---|---|---|
| `locals` | object | Shared request-scoped data store (same object as `req.locals`). |
| `headersSent` | boolean | Whether response headers have already been flushed. |

#### Chainable Methods

These return `this` so you can chain calls:

| Method | Signature | Description |
|---|---|---|
| `status` | `status(code)` | Set the HTTP status code. |
| `set` | `set(name, value)` | Set a response header. Throws on CRLF injection attempt. |
| `type` | `type(contentType)` | Set `Content-Type`. Accepts shorthand: `'json'`, `'html'`, `'text'`, `'xml'`, `'form'`, `'bin'`. |
| `append` | `append(name, value)` | Append to a header (comma-separated if it already exists). |
| `vary` | `vary(field)` | Add a field to the `Vary` header. |
| `cookie` | `cookie(name, value, [opts])` | Set an HTTP cookie on the response. |
| `clearCookie` | `clearCookie(name, [opts])` | Expire a cookie (must match `path`/`domain` of original). |

#### Terminal Methods

These finalize and send the response (not chainable):

| Method | Signature | Description |
|---|---|---|
| `send` | `send(body)` | Send response. Auto-detects Content-Type: Buffer → `application/octet-stream`, string → `text/html`, object → JSON. |
| `json` | `json(obj)` | Send JSON response with `application/json` Content-Type. |
| `text` | `text(str)` | Send plain text response. |
| `html` | `html(str)` | Send HTML response. |
| `sendStatus` | `sendStatus(code)` | Send the status code with the standard reason phrase as the body. |
| `redirect` | `redirect([status], url)` | Redirect to a URL (default `302`). |
| `sendFile` | `sendFile(path, [opts], [cb])` | Stream a file to the response. Options: `root` (base directory), `headers` (additional headers). |
| `download` | `download(path, [filename], [cb])` | Prompt a file download. Sets `Content-Disposition: attachment`. |
| `sse` | `sse([opts])` | Open an SSE stream. Returns an `SSEStream` controller. |
| `get` | `get(name)` | Get a previously-set response header. |

#### `res.cookie()` Options

| Option | Type | Default | Description |
|---|---|---|---|
| `domain` | string | — | Cookie domain. |
| `path` | string | `'/'` | Cookie path. |
| `expires` | Date | — | Expiration date. |
| `maxAge` | number | — | Max age in **seconds** (takes precedence over `expires`). |
| `httpOnly` | boolean | `true` | Prevent client-side JavaScript access. |
| `secure` | boolean | — | Only send over HTTPS. |
| `sameSite` | string | `'Lax'` | `'Strict'`, `'Lax'`, or `'None'`. |

```js
// Set a session cookie
res.cookie('session', token, { maxAge: 3600, httpOnly: true, secure: true })

// Set and send
res.status(200).set('X-Custom', 'value').json({ ok: true })

// File download
res.download('/reports/q4.pdf', 'Q4-Report.pdf')

// Status-only response
res.sendStatus(204) // sends "No Content"
```

---

### Router

Create modular route groups with `Router()`. Routers support all the same HTTP verb methods as `createApp()`, plus mounting and chaining.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `get/post/put/delete/patch/options/head/all` | `(path, [opts], ...handlers)` | Register route handlers. Chainable (returns `this`). |
| `use` | `use(prefix, router)` | Mount a child router at a prefix. |
| `route` | `route(path)` | Returns a chainable object for registering multiple methods on one path. |
| `inspect` | `inspect([prefix])` | Return a flat list of all routes. |

#### Route Patterns

| Pattern | Example | `req.params` |
|---|---|---|
| Named parameter | `/users/:id` | `{ id: '42' }` |
| Multiple params | `/users/:userId/posts/:postId` | `{ userId: '1', postId: '5' }` |
| Wildcard catch-all | `/files/*` | `{ '0': 'path/to/file.txt' }` |

```js
const { createApp, Router, json } = require('zero-http')
const app = createApp()

// Modular API router
const api = Router()
api.get('/users', (req, res) => res.json([]))
api.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
api.post('/users', (req, res) => res.status(201).json(req.body))

// Nested router
const v2 = Router()
v2.get('/health', (req, res) => res.json({ status: 'ok', version: 2 }))
api.use('/v2', v2)

app.use(json())
app.use('/api', api)

// Route chaining — multiple methods on one path
const items = Router()
items.route('/items')
  .get((req, res) => res.json([]))
  .post((req, res) => res.status(201).json(req.body))
  .delete((req, res) => res.sendStatus(204))
app.use(items)

// Introspection
console.log(app.routes())
// [{ method: 'GET', path: '/api/users' }, { method: 'GET', path: '/api/users/:id' }, ...]
```

---

### Body Parsers

All body parsers accept these common options:

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | number\|string | `'1mb'` | Maximum body size. Accepts bytes or unit strings like `'10kb'`, `'2mb'`. |
| `type` | string\|function | (varies) | Content-Type to match. String pattern or `(contentType) => boolean`. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with `403 HTTPS required`. |

#### json([opts])

Parse JSON request bodies into `req.body`.

| Option | Default | Description |
|---|---|---|
| `strict` | `true` | Only accept objects and arrays (reject primitive roots). |
| `reviver` | — | Custom reviver function passed to `JSON.parse()`. |

```js
app.use(json({ limit: '500kb', strict: true }))
```

#### urlencoded([opts])

Parse URL-encoded form bodies into `req.body`.

| Option | Default | Description |
|---|---|---|
| `extended` | `false` | Enable nested bracket syntax: `a[b][c]=1` → `{ a: { b: { c: '1' } } }`. |

> **Security:** When `extended: true`, keys containing `__proto__`, `constructor`, or `prototype` are automatically filtered to prevent prototype pollution.

```js
app.use(urlencoded({ extended: true }))
```

#### text([opts])

Read the body as a plain string into `req.body`.

| Option | Default | Description |
|---|---|---|
| `encoding` | `'utf8'` | Character encoding. |

#### raw([opts])

Read the body as a `Buffer` into `req.body`.

#### multipart([opts])

Stream file uploads to disk and collect form fields.

| Option | Default | Description |
|---|---|---|
| `dir` | `os.tmpdir()/zero-http-uploads` | Upload directory (created automatically). |
| `maxFileSize` | — | Maximum file size in bytes. Sends `413` on exceed. |

Sets `req.body = { fields, files }` where each file entry has: `originalFilename`, `storedName`, `path`, `contentType`, `size`.

> **Security:** Filenames are sanitized — path traversal sequences, null bytes, and unsafe characters are stripped.

```js
app.post('/upload', multipart({ dir: './uploads', maxFileSize: 5 * 1024 * 1024 }), (req, res) => {
  res.json({ files: req.body.files, fields: req.body.fields })
})
```

---

### Middleware

#### helmet([opts])

Set security-related HTTP headers. All options can be set to `false` to disable.

| Option | Type | Default | Description |
|---|---|---|---|
| `contentSecurityPolicy` | object\|false | (permissive CSP) | CSP directives object, or `false` to disable. |
| `crossOriginOpenerPolicy` | string\|false | `'same-origin'` | Cross-Origin-Opener-Policy value. |
| `crossOriginResourcePolicy` | string\|false | `'same-origin'` | Cross-Origin-Resource-Policy value. |
| `crossOriginEmbedderPolicy` | boolean | `false` | Set COEP to `require-corp`. |
| `dnsPrefetchControl` | boolean | `true` | Set `X-DNS-Prefetch-Control: off`. |
| `frameguard` | string\|false | `'deny'` | `X-Frame-Options` — `'deny'` or `'sameorigin'`. |
| `hidePoweredBy` | boolean | `true` | Remove the `X-Powered-By` header. |
| `hsts` | boolean | `true` | Enable `Strict-Transport-Security`. |
| `hstsMaxAge` | number | `15552000` | HSTS max-age in seconds (~180 days). |
| `hstsIncludeSubDomains` | boolean | `true` | Include subdomains in HSTS. |
| `hstsPreload` | boolean | `false` | Add the `preload` directive. |
| `ieNoOpen` | boolean | `true` | Set `X-Download-Options: noopen`. |
| `noSniff` | boolean | `true` | Set `X-Content-Type-Options: nosniff`. |
| `permittedCrossDomainPolicies` | string\|false | `'none'` | `X-Permitted-Cross-Domain-Policies` value. |
| `referrerPolicy` | string\|false | `'no-referrer'` | `Referrer-Policy` value. |
| `xssFilter` | boolean | `false` | Set `X-XSS-Protection: 1; mode=block` (legacy). |

```js
app.use(helmet())

// Customized
app.use(helmet({
  frameguard: 'sameorigin',
  hsts: false,
  contentSecurityPolicy: false,
  referrerPolicy: 'same-origin'
}))
```

#### cors([opts])

CORS middleware with automatic preflight (`OPTIONS → 204`) handling.

| Option | Type | Default | Description |
|---|---|---|---|
| `origin` | string\|array | `'*'` | Allowed origin(s). Use an array for multiple origins, or a `.suffix` string for subdomain matching. |
| `methods` | string | `'GET,POST,PUT,DELETE,OPTIONS'` | Allowed HTTP methods. |
| `allowedHeaders` | string | `'Content-Type,Authorization'` | Headers the client can send. |
| `exposedHeaders` | string | — | Headers the browser can read from the response. |
| `credentials` | boolean | `false` | Set `Access-Control-Allow-Credentials: true`. |
| `maxAge` | number | — | Preflight cache duration in seconds. |

```js
app.use(cors({ origin: ['https://app.example.com', 'https://admin.example.com'], credentials: true }))
```

> **Tip:** When using `credentials: true`, you must specify explicit origins — browsers reject `*` with credentials.

#### compress([opts])

Response compression middleware. Negotiates the best encoding from `Accept-Encoding`: brotli > gzip > deflate. Brotli requires Node ≥ 11.7. Automatically skips SSE streams.

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | number | `1024` | Minimum response size (bytes) before compressing. |
| `level` | number | `-1` | zlib compression level (1–9, or -1 for default). |
| `filter` | function | — | `(req, res) => boolean` — return `false` to skip compression. |

```js
app.use(compress({ threshold: 512, level: 6 }))
```

#### rateLimit([opts])

In-memory per-IP rate limiter with sliding window.

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | number | `60000` | Time window in milliseconds. |
| `max` | number | `100` | Max requests per window per key. |
| `message` | string | `'Too many requests…'` | Error message body. |
| `statusCode` | number | `429` | HTTP status for rate-limited responses. |
| `keyGenerator` | function | `(req) => req.ip` | Custom key extraction function. |

Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers on every response. Adds `Retry-After` when the limit is exceeded.

```js
// Strict API rate limiting
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }))

// Custom key (e.g. by API key instead of IP)
app.use(rateLimit({ keyGenerator: (req) => req.get('x-api-key') || req.ip }))
```

> **Note:** Rate limit state is in-memory and resets on server restart. For distributed systems, use an external store.

#### logger([opts])

Request logger that logs method, URL, status code, and response time.

| Option | Type | Default | Description |
|---|---|---|---|
| `format` | string | `'dev'` | `'dev'` (colorized with status), `'short'`, or `'tiny'`. |
| `logger` | function | `console.log` | Custom log output function. |
| `colors` | boolean | auto (TTY) | Enable/disable ANSI colors. |

```js
app.use(logger({ format: 'dev' }))
```

#### timeout(ms, [opts])

Automatically send a timeout response if the handler doesn't respond within the time limit.

| Option | Type | Default | Description |
|---|---|---|---|
| `ms` (1st arg) | number | `30000` | Timeout in milliseconds. |
| `status` | number | `408` | HTTP status code for timeout response. |
| `message` | string | `'Request Timeout'` | Error message body. |

Sets `req.timedOut = true` on timeout so downstream handlers can check.

```js
app.use(timeout(5000))

app.get('/slow', (req, res) => {
  // Long operation...
  if (req.timedOut) return // response already sent
  res.json({ result })
})
```

#### requestId([opts])

Generate or extract a unique request ID for tracing.

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | string | `'X-Request-Id'` | Response header name. |
| `generator` | function | UUID v4 | Custom ID generator `() => string`. |
| `trustProxy` | boolean | `false` | Trust and reuse the incoming `X-Request-Id` header. |

Sets `req.id` and adds the ID to the response header.

```js
app.use(requestId())

app.get('/test', (req, res) => {
  console.log('Request ID:', req.id)
  res.json({ id: req.id })
})
```

#### cookieParser([secret], [opts])

Parse the `Cookie` header into `req.cookies`. Optionally verify signed cookies.

| Parameter | Type | Description |
|---|---|---|
| `secret` | string\|string[] | Secret(s) for signed cookie verification. |
| `options.decode` | boolean | URI-decode cookie values (default `true`). |

Populates `req.cookies` (all cookies) and `req.signedCookies` (verified signed cookies only). Failed signatures are silently excluded.

**Static method:** `cookieParser.sign(value, secret)` — manually sign a value. Returns `'s:<value>.<HMAC-SHA256>'`.

```js
const secret = 'my-secret'
app.use(cookieParser(secret))

app.get('/profile', (req, res) => {
  const user = req.signedCookies.user // verified
  const theme = req.cookies.theme     // unsigned
  res.json({ user, theme })
})

app.post('/login', (req, res) => {
  const signed = cookieParser.sign(req.body.username, secret)
  res.cookie('user', signed, { httpOnly: true, maxAge: 86400 })
  res.json({ ok: true })
})
```

#### static(rootPath, [opts])

Serve static files from `rootPath`. Supports 60+ MIME types.

| Option | Type | Default | Description |
|---|---|---|---|
| `index` | string\|false | `'index.html'` | Default file for directory requests, or `false` to disable. |
| `maxAge` | number | `0` | `Cache-Control` max-age in **milliseconds**. |
| `dotfiles` | string | `'ignore'` | `'allow'`, `'deny'` (403), or `'ignore'` (404). |
| `extensions` | string[] | — | Fallback extensions to try (e.g. `['html', 'htm']`). |
| `setHeaders` | function | — | Hook `(res, filePath) => void` for custom headers. |

> **Security:** Path traversal (`../`), null bytes, and directory escape attempts are blocked.

```js
app.use('/public', serveStatic('./public', {
  maxAge: 86400000, // 1 day
  extensions: ['html'],
  dotfiles: 'deny'
}))
```

#### validate(schema, [opts])

Request validation middleware. Validates `req.body`, `req.query`, and `req.params` against a typed schema. Returns `422` with detailed errors on failure.

**Schema targets:** `body`, `query`, `params` — each is an object mapping field names to rules.

| Rule | Type | Description |
|---|---|---|
| `type` | string | `'string'`, `'integer'`, `'number'`, `'float'`, `'boolean'`, `'array'`, `'date'`, `'email'`, `'url'`, `'uuid'`, `'json'`. Auto-coerces from strings. |
| `required` | boolean | Fail if the field is missing or empty. |
| `default` | any | Default value when absent (can be a function). |
| `min` / `max` | number | Numeric range constraints. |
| `minLength` / `maxLength` | number | String length constraints. |
| `minItems` / `maxItems` | number | Array length constraints. |
| `match` | RegExp | Pattern the value must match. |
| `enum` | array | Whitelist of allowed values. |
| `validate` | function | Custom validator `(value) => errorString \| undefined`. |

| Option | Type | Default | Description |
|---|---|---|---|
| `stripUnknown` | boolean | `true` | Remove fields not defined in the schema. |

```js
const { createApp, json, validate } = require('zero-http')
const app = createApp()
app.use(json())

app.post('/users', validate({
  body: {
    name:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
    email: { type: 'email',  required: true },
    age:   { type: 'integer', min: 0, max: 150 },
    role:  { type: 'string',  enum: ['user', 'admin'], default: 'user' },
  },
  query: {
    format: { type: 'string', enum: ['json', 'xml'], default: 'json' },
  },
}), (req, res) => {
  // req.body and req.query are validated and sanitised
  res.json(req.body)
})
```

#### csrf([opts])

CSRF protection using the double-submit cookie + header/body token pattern. Safe methods (`GET`, `HEAD`, `OPTIONS`) are skipped automatically and receive a token cookie. State-changing requests must include the token.

The middleware checks for a matching token in:
1. `req.headers['x-csrf-token']`
2. `req.body._csrf` (if body is parsed)
3. `req.query._csrf`

| Option | Type | Default | Description |
|---|---|---|---|
| `cookie` | string | `'_csrf'` | Name of the double-submit cookie. |
| `header` | string | `'x-csrf-token'` | Request header that carries the token. |
| `saltLength` | number | `18` | Bytes of randomness for token generation. |
| `secret` | string | (auto) | HMAC secret. Auto-generated per process if omitted. |
| `ignoreMethods` | string[] | `['GET','HEAD','OPTIONS']` | HTTP methods to skip. |
| `ignorePaths` | string[] | `[]` | Path prefixes to skip (e.g. `['/api/webhooks']`). |
| `onError` | function | — | Custom error handler `(req, res) => {}`. |

Tokens are rotated automatically on every state-changing request. Access the current token via `req.csrfToken`.

```js
const { createApp, csrf, cookieParser, json } = require('zero-http')
const app = createApp()

app.use(cookieParser())
app.use(json())
app.use(csrf())

// Read the token for forms or SPAs
app.get('/form', (req, res) => {
  res.json({ csrfToken: req.csrfToken })
})

// State-changing requests are protected automatically
app.post('/transfer', (req, res) => {
  res.json({ ok: true })
})
```

> **Note:** `csrf()` requires `cookieParser()` to be applied first so it can read the cookie token.

#### errorHandler([opts])

Configurable error-handling middleware that formats error responses based on environment (dev vs production), integrates with `HttpError` classes, and supports custom formatters.

| Option | Type | Default | Description |
|---|---|---|---|
| `stack` | boolean | `NODE_ENV !== 'production'` | Include stack traces in responses. |
| `log` | boolean | `true` | Log errors to console. |
| `logger` | function | `console.error` | Custom log function. |
| `formatter` | function | — | Custom response formatter: `(err, req, isDev) => object`. |
| `onError` | function | — | Callback on every error: `(err, req, res) => void`. |

```js
const { createApp, errorHandler, NotFoundError } = require('zero-http')
const app = createApp()

app.use(errorHandler())

app.get('/users/:id', (req, res) => {
  throw new NotFoundError('User not found')
  // → 404 { error: 'User not found', code: 'NOT_FOUND', statusCode: 404 }
})

// Custom formatter
app.use(errorHandler({
  formatter: (err, req, isDev) => ({
    message: err.message,
    ...(isDev && { stack: err.stack }),
  }),
}))
```

---

### fetch(url, [opts])

Zero-dependency server-side HTTP/HTTPS client.

| Option | Type | Default | Description |
|---|---|---|---|
| `method` | string | `'GET'` | HTTP method. |
| `headers` | object | — | Request headers. |
| `body` | string\|Buffer\|object\|URLSearchParams\|ReadableStream | — | Request body. Objects are auto-JSON-encoded with appropriate `Content-Type`. |
| `timeout` | number | — | Request timeout in milliseconds. |
| `signal` | AbortSignal | — | Cancel the request. |
| `agent` | object | — | Custom HTTP agent for pooling/proxies. |
| `onDownloadProgress` | function | — | `({ loaded, total }) => void` progress callback. |
| `onUploadProgress` | function | — | `({ loaded, total }) => void` progress callback. |

**TLS options** (passed through for `https:` URLs): `rejectUnauthorized`, `ca`, `cert`, `key`, `pfx`, `passphrase`, `servername`, `ciphers`, `secureProtocol`, `minVersion`, `maxVersion`.

**Response object:**

| Property/Method | Type | Description |
|---|---|---|
| `status` | number | HTTP status code. |
| `statusText` | string | Reason phrase. |
| `ok` | boolean | `true` when `status` is 200–299. |
| `secure` | boolean | `true` if HTTPS. |
| `url` | string | Final request URL. |
| `headers` | object | Response headers with `.get(name)` method and `.raw` property. |
| `text()` | Promise\<string\> | Read the body as a string. |
| `json()` | Promise\<object\> | Read and parse the body as JSON. |
| `arrayBuffer()` | Promise\<Buffer\> | Read the body as a Buffer. |

```js
const { fetch } = require('zero-http')

// Simple GET
const res = await fetch('https://api.example.com/data')
const data = await res.json()

// POST with JSON
const res = await fetch('https://api.example.com/users', {
  method: 'POST',
  body: { name: 'Alice' }, // auto-serialized
  headers: { Authorization: 'Bearer token' }
})

// Download with progress
await fetch('https://example.com/bigfile.zip', {
  onDownloadProgress: ({ loaded, total }) => {
    console.log(`${Math.round(loaded / total * 100)}%`)
  }
})

// mTLS client certificate
await fetch('https://internal.api/data', {
  cert: fs.readFileSync('client.crt'),
  key: fs.readFileSync('client.key'),
  ca: fs.readFileSync('ca.crt')
})
```

---

### WebSocket — `app.ws(path, [opts], handler)`

Register a WebSocket upgrade handler. The handler receives `(ws, req)` where `ws` is a `WebSocketConnection`.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPayload` | number | `1048576` | Maximum incoming frame size in bytes (1 MB). |
| `pingInterval` | number | `30000` | Auto-ping interval in ms. Set to `0` to disable. |
| `verifyClient` | function | — | `(req) => boolean` — return `false` to reject the upgrade with `403`. |

#### WebSocketConnection — Properties

| Property | Type | Description |
|---|---|---|
| `id` | string | Unique connection ID (e.g. `ws_1_l8x3k`). |
| `readyState` | number | `0`=CONNECTING, `1`=OPEN, `2`=CLOSING, `3`=CLOSED. |
| `protocol` | string | Negotiated sub-protocol (from `Sec-WebSocket-Protocol`). |
| `extensions` | string | Requested WebSocket extensions header. |
| `headers` | object | Upgrade request headers. |
| `ip` | string\|null | Remote IP address. |
| `query` | object | Parsed query params from the upgrade URL. |
| `url` | string | Full upgrade URL path. |
| `secure` | boolean | `true` for WSS connections. |
| `maxPayload` | number | Max incoming payload bytes. |
| `connectedAt` | number | Timestamp (ms) of connection. |
| `uptime` | number | Milliseconds since connection (getter). |
| `bufferedAmount` | number | Bytes waiting to be flushed (getter). |
| `data` | object | Arbitrary per-connection data store. |

#### WebSocketConnection — Methods

| Method | Signature | Description |
|---|---|---|
| `send` | `send(data, [opts])` | Send text or binary message. `opts.binary` forces binary frame. Returns `false` on backpressure. |
| `sendJSON` | `sendJSON(obj)` | Send JSON-serialized text message. |
| `ping` | `ping([payload], [cb])` | Send a ping frame. |
| `pong` | `pong([payload], [cb])` | Send a pong frame. |
| `close` | `close([code], [reason])` | Graceful close with optional status code (`1000`–`4999`). |
| `terminate` | `terminate()` | Forcefully destroy the socket (no close frame). |
| `on` | `on(event, fn)` | Listen for events: `'message'`, `'close'`, `'error'`, `'ping'`, `'pong'`, `'drain'`. |
| `once` | `once(event, fn)` | One-time event listener. |
| `off` | `off(event, fn)` | Remove a specific listener. |
| `removeAllListeners` | `removeAllListeners([event])` | Remove all listeners (optionally for one event). |
| `listenerCount` | `listenerCount(event)` | Count registered listeners for an event. |

#### WebSocketPool — Connection & Room Manager

Manage groups of WebSocket connections with room-based broadcasting.

| Method | Signature | Description |
|---|---|---|
| `add` | `add(ws)` | Track a connection (auto-removes on close). |
| `remove` | `remove(ws)` | Remove from pool and all rooms. |
| `join` | `join(ws, room)` | Add a connection to a named room. |
| `leave` | `leave(ws, room)` | Remove a connection from a room. |
| `broadcast` | `broadcast(data, [exclude])` | Send to ALL connections (optionally excluding one). |
| `broadcastJSON` | `broadcastJSON(obj, [exclude])` | Broadcast JSON to all. |
| `toRoom` | `toRoom(room, data, [exclude])` | Send to all connections in a room. |
| `toRoomJSON` | `toRoomJSON(room, obj, [exclude])` | Send JSON to a room. |
| `in` | `in(room)` | Get all connections in a room. |
| `roomsOf` | `roomsOf(ws)` | Get all rooms a connection belongs to. |
| `closeAll` | `closeAll([code], [reason])` | Close every connection gracefully. |
| `size` | getter | Total active connection count. |
| `clients` | getter | Array of all connections. |
| `rooms` | getter | Array of active room names. |
| `roomSize` | `roomSize(room)` | Connection count in a room. |

```js
const { createApp, WebSocketPool } = require('zero-http')
const app = createApp()
const pool = new WebSocketPool()

app.ws('/chat', (ws, req) => {
  const room = req.query.room || 'general'
  pool.add(ws)
  pool.join(ws, room)

  ws.data.username = req.query.name || 'Anonymous'

  pool.toRoomJSON(room, {
    type: 'join',
    user: ws.data.username,
    count: pool.roomSize(room)
  }, ws)

  ws.on('message', (msg) => {
    pool.toRoom(room, `${ws.data.username}: ${msg}`, ws)
  })

  ws.on('close', () => {
    pool.toRoomJSON(room, { type: 'leave', user: ws.data.username })
  })
})

app.listen(3000)
```

---

### Server-Sent Events — `res.sse([opts])`

Open an SSE stream. Returns a chainable `SSEStream` controller.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `status` | number | `200` | HTTP status code. |
| `retry` | number | — | Reconnection interval hint (ms) sent to client. |
| `keepAlive` | number | `0` | Auto keep-alive comment interval (ms). |
| `keepAliveComment` | string | `'ping'` | Comment text for keep-alive pings. |
| `autoId` | boolean | `false` | Auto-increment event IDs. |
| `startId` | number | `1` | Starting value for auto-IDs. |
| `pad` | number | `0` | Bytes of initial padding (helps flush proxy buffers). |
| `headers` | object | — | Additional response headers. |

#### SSEStream — Methods (all chainable)

| Method | Signature | Description |
|---|---|---|
| `send` | `send(data, [id])` | Send unnamed data event. Objects are auto-JSON-serialized. |
| `sendJSON` | `sendJSON(obj, [id])` | Send object as JSON data. |
| `event` | `event(name, data, [id])` | Send a named event. |
| `comment` | `comment(text)` | Send a comment line (invisible to `EventSource.onmessage`). |
| `retry` | `retry(ms)` | Update the reconnection interval hint. |
| `keepAlive` | `keepAlive(ms, [comment])` | Start/restart the keep-alive timer. |
| `flush` | `flush()` | Flush response buffer through proxies. |
| `close` | `close()` | Close the stream from the server side. |

#### SSEStream — Properties

| Property | Type | Description |
|---|---|---|
| `connected` | boolean | Whether the stream is still open. |
| `eventCount` | number | Total events sent. |
| `bytesSent` | number | Total bytes written. |
| `connectedAt` | number | Connection timestamp (ms). |
| `uptime` | number | Milliseconds since connected. |
| `lastEventId` | string\|null | `Last-Event-ID` from the client reconnection header. |
| `secure` | boolean | `true` if HTTPS. |
| `data` | object | Arbitrary per-stream data store. |

#### SSEStream — Events

| Event | Description |
|---|---|
| `'close'` | Client disconnected or server called `close()`. |
| `'error'` | Write error on the underlying response. |

```js
app.get('/events', (req, res) => {
  const sse = res.sse({ retry: 5000, autoId: true, keepAlive: 30000 })

  sse.send('connected')

  const interval = setInterval(() => {
    sse.event('tick', { time: Date.now() })
  }, 1000)

  sse.on('close', () => {
    clearInterval(interval)
    console.log(`Client was connected for ${sse.uptime}ms, sent ${sse.eventCount} events`)
  })
})
```

> **Tip:** Use `pad` when deploying behind reverse proxies (like Nginx) that buffer small responses. A 2KB pad typically forces the first flush.

---

### HTTPS

```js
const fs = require('fs')
const { createApp } = require('zero-http')
const app = createApp()

app.listen(443, {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
}, () => console.log('HTTPS on 443'))
```

HTTPS awareness is built into every module:

| API | Property | Value |
|---|---|---|
| Request | `req.secure` / `req.protocol` | `true` / `'https'` |
| WebSocket | `ws.secure` | `true` for WSS |
| SSE | `sse.secure` | `true` over TLS |
| Fetch response | `res.secure` | `true` if `https:` |
| Body parsers | `requireSecure` option | Reject non-TLS with 403 |
| Routes | `{ secure: true }` option | Match HTTPS-only |

---

### Environment Config — `env`

Zero-dependency typed environment variable system. Loads `.env` files, validates against a typed schema, and exposes values via property access or function call.

#### File Loading Order

Files are loaded in precedence order (later overrides earlier). `process.env` always takes final precedence.

1. `.env` — shared defaults
2. `.env.local` — local overrides (gitignored)
3. `.env.{NODE_ENV}` — environment-specific (e.g. `.env.production`)
4. `.env.{NODE_ENV}.local` — env-specific local overrides

#### Schema Types

`string`, `number`, `integer`, `boolean`, `port`, `array`, `json`, `url`, `enum`

#### env.load(schema, [opts])

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | string | `process.cwd()` | Directory to load `.env` files from. |
| `override` | boolean | `false` | Write file values into `process.env`. |

Schema fields support: `type`, `required`, `default`, `min`, `max`, `match`, `separator` (for arrays), `values` (for enums).

```js
const { env } = require('zero-http')

env.load({
  PORT:            { type: 'port',    default: 3000 },
  DATABASE_URL:    { type: 'string',  required: true },
  DEBUG:           { type: 'boolean', default: false },
  ALLOWED_ORIGINS: { type: 'array',   separator: ',' },
  LOG_LEVEL:       { type: 'enum',    values: ['debug','info','warn','error'], default: 'info' },
})

env.PORT          // => 3000 (number, not string)
env('PORT')       // => 3000 (callable)
env.get('PORT')   // => 3000
env.DEBUG         // => false (boolean)
env.require('DATABASE_URL')  // throws if missing
env.has('PORT')   // => true
env.all()         // => { PORT: 3000, DATABASE_URL: '...', ... }
```

Throws on startup if required variables are missing or values fail type validation — **fail fast, not at runtime**.

---

### Database / ORM

Built-in ORM with support for memory, JSON file, SQLite, MySQL, PostgreSQL, and MongoDB. Memory and JSON adapters work out of the box; other adapters use "bring your own driver" (`better-sqlite3`, `mysql2`, `pg`, `mongodb`).

#### Database.connect(adapter, [opts])

| Adapter | Driver Required | Options |
|---|---|---|
| `'memory'` | none | — |
| `'json'` | none | `{ path: './data.json' }` |
| `'sqlite'` | `better-sqlite3` | `{ filename: './db.sqlite' }` |
| `'mysql'` | `mysql2` | `{ host, port, user, password, database }` |
| `'postgres'` | `pg` | `{ host, port, user, password, database }` |
| `'mongo'` | `mongodb` | `{ url, database }` |

```js
const { Database, Model, TYPES } = require('zero-http')

const db = Database.connect('memory')
// or
const db = Database.connect('sqlite', { filename: './app.db' })
```

#### Model

Define database entities by extending `Model`. Register with a database and call `sync()` to create tables.

| Static Property | Type | Default | Description |
|---|---|---|---|
| `table` | string | (required) | Table/collection name. |
| `schema` | object | `{}` | Column definitions. |
| `timestamps` | boolean | `false` | Auto-manage `createdAt`/`updatedAt`. |
| `softDelete` | boolean | `false` | Use `deletedAt` instead of real deletion. |
| `hidden` | string[] | `[]` | Fields excluded from `toJSON()` (e.g. passwords). |
| `scopes` | object | `{}` | Named reusable query conditions. |

#### TYPES

Column type constants for schemas:

`STRING`, `INTEGER`, `FLOAT`, `BOOLEAN`, `DATE`, `DATETIME`, `JSON`, `TEXT`, `BLOB`, `UUID`

#### Schema Constraints

| Constraint | Description |
|---|---|
| `primaryKey` | Mark as primary key. |
| `autoIncrement` | Auto-increment (integer PKs). |
| `required` | Value must be provided. |
| `unique` | Enforce uniqueness. |
| `default` | Default value (or function). |
| `minLength` / `maxLength` | String length. |
| `min` / `max` | Numeric range. |
| `enum` | Allowed values whitelist. |
| `match` | RegExp pattern. |
| `nullable` | Allow null values. |

```js
class User extends Model {
  static table = 'users'
  static schema = {
    id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
    name:     { type: TYPES.STRING,  required: true, maxLength: 100 },
    email:    { type: TYPES.STRING,  required: true, unique: true },
    role:     { type: TYPES.STRING,  enum: ['user', 'admin'], default: 'user' },
    password: { type: TYPES.STRING,  required: true },
  }
  static timestamps = true
  static softDelete = true
  static hidden = ['password']
  static scopes = {
    active: q => q.where('active', true),
    admins: q => q.where('role', 'admin'),
    olderThan: (q, age) => q.where('age', '>', age),
  }
}

db.register(User)
await db.sync()
```

#### CRUD Operations

```js
// Create
const user = await User.create({ name: 'Alice', email: 'a@b.com', password: 'hashed' })

// Find
const users = await User.findAll()
const admins = await User.find({ role: 'admin' })
const alice = await User.findById(1)
const one = await User.findOne({ email: 'a@b.com' })

// Update
await alice.update({ name: 'Alice W.' })
await User.updateById(1, { role: 'admin' })

// Delete
await alice.delete()
await User.deleteById(2)

// Count
const count = await User.count({ role: 'user' })

// Scopes
const activeAdmins = await User.scope('active').scope('admins').exec()
```

#### Fluent Query Builder

```js
const results = await User.query()
  .where('age', '>', 18)
  .where('role', 'admin')
  .orderBy('name', 'asc')
  .limit(10)
  .offset(20)
  .select('name', 'email')

// Aggregations, grouping, joins also supported
```

---

### Error Classes — `HttpError`

Structured HTTP error classes with status codes, machine-readable codes, and optional details. Every error extends `HttpError` and serializes cleanly to JSON.

```js
const { NotFoundError, ValidationError, createError, isHttpError } = require('zero-http')

// Throw named errors
throw new NotFoundError('User not found')
// → { error: 'User not found', code: 'NOT_FOUND', statusCode: 404 }

// With extra details
throw new ValidationError('Invalid input', {
  email: 'required',
  age: 'must be >= 18',
})
// → { error: 'Invalid input', code: 'VALIDATION_FAILED', statusCode: 422, details: { email: '...', age: '...' } }

// Factory
throw createError(503, 'Database unavailable')

// Type check
if (isHttpError(err)) console.log(err.statusCode)
```

**Available error classes:** `HttpError`, `BadRequestError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `MethodNotAllowedError` (405), `ConflictError` (409), `GoneError` (410), `PayloadTooLargeError` (413), `UnprocessableEntityError` (422), `ValidationError` (422), `TooManyRequestsError` (429), `InternalError` (500), `NotImplementedError` (501), `BadGatewayError` (502), `ServiceUnavailableError` (503).

---

### Debug Logger — `debug(namespace)`

Lightweight namespaced logger with levels, colors, timestamps, and pattern-based filtering via the `DEBUG` environment variable.

**Levels:** `trace` (0) → `debug` (1) → `info` (2) → `warn` (3) → `error` (4) → `fatal` (5) → `silent` (6)

```js
const { debug } = require('zero-http')
const log = debug('app:routes')

log('shorthand debug message')
log.info('server started on port %d', 3000)
log.warn('deprecated route used')
log.error('failed to connect', err)
```

**Environment variables:**

| Variable | Example | Description |
|---|---|---|
| `DEBUG` | `app:*,router` | Enable specific namespaces (supports glob patterns). Prefix with `-` to exclude. |
| `DEBUG_LEVEL` | `warn` | Minimum log level. |

```bash
# Enable all 'app:' namespaces
DEBUG=app:* node server.js

# Enable everything except noisy modules
DEBUG=*,-verbose:* node server.js

# Show only warnings and above
DEBUG_LEVEL=warn node server.js
```

---

## Examples

### Full-Featured Server

```js
const path = require('path')
const {
  createApp, Router, cors, json, urlencoded, text, compress,
  static: serveStatic, logger, rateLimit, helmet, timeout,
  requestId, cookieParser, csrf, validate, errorHandler,
  env, WebSocketPool
} = require('zero-http')

// Load environment config
env.load({
  PORT:    { type: 'port', default: 3000 },
  SECRET:  { type: 'string', required: true },
})

const app = createApp()

// Security & logging
app.use(helmet())
app.use(logger({ format: 'dev' }))
app.use(requestId())
app.use(timeout(10000))

// CORS & compression
app.use(cors({ origin: 'https://myapp.com', credentials: true }))
app.use(compress({ threshold: 512 }))

// Rate limiting
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }))

// Body parsers & security
app.use(json({ limit: '1mb' }))
app.use(urlencoded({ extended: true }))
app.use(text())
app.use(cookieParser(env.SECRET))
app.use(csrf())

// Error handler
app.use(errorHandler())

// Static files
app.use(serveStatic(path.join(__dirname, 'public'), { maxAge: 86400000 }))

// API routes with validation
const api = Router()
api.get('/health', (req, res) => res.json({ status: 'ok', requestId: req.id }))
api.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
api.post('/users', validate({
  body: {
    name:  { type: 'string', required: true, minLength: 1 },
    email: { type: 'email', required: true },
  }
}), (req, res) => res.status(201).json(req.body))
app.use('/api', api)

// WebSocket with rooms
const pool = new WebSocketPool()
app.ws('/chat', (ws, req) => {
  pool.add(ws)
  pool.join(ws, 'lobby')
  ws.on('message', msg => pool.toRoom('lobby', msg, ws))
})

// Server-Sent Events
app.get('/events', (req, res) => {
  const sse = res.sse({ retry: 3000, autoId: true, keepAlive: 30000 })
  sse.send('connected')
  sse.on('close', () => console.log('client left'))
})

// Global error handler
app.onError((err, req, res) => {
  console.error(err)
  res.status(500).json({ error: err.message })
})

app.listen(env.PORT, () => console.log(`Server running on :${env.PORT}`))
```

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
// Connect: ws://localhost:3000/chat?room=dev&name=Alice
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

// Broadcast metrics every second
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
    description: fields.description || 'No description',
    details: Object.values(files).map(f => ({
      name: f.originalFilename,
      size: f.size,
      type: f.contentType
    }))
  })
})

app.listen(3000)
```

### Middleware Composition Tips

```js
// Middleware runs in registration order
app.use(logger())      // 1. Log the request
app.use(helmet())      // 2. Set security headers
app.use(cors())        // 3. Handle CORS
app.use(compress())    // 4. Compress responses
app.use(rateLimit())   // 5. Check rate limits
app.use(json())        // 6. Parse body

// Path-scoped middleware
app.use('/api', rateLimit({ max: 50 }))     // stricter for API
app.use('/admin', (req, res, next) => {     // custom auth
  if (!req.get('authorization')) return res.sendStatus(401)
  next()
})

// Custom middleware pattern
app.use((req, res, next) => {
  req.locals.startTime = Date.now()
  res.locals.requestId = req.id
  next()
})

// Error handler goes last
app.onError((err, req, res, next) => {
  const duration = Date.now() - req.locals.startTime
  console.error(`Error after ${duration}ms:`, err.message)
  res.status(err.statusCode || 500).json({ error: err.message })
})
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
  middleware/         — cors, helmet, logger, rateLimit, compress, static, timeout,
                        requestId, cookieParser, csrf, validate, errorHandler
  orm/                — Database, Model, Query, adapters (memory, json, sqlite, mysql, postgres, mongo)
  router/             — Router with sub-app mounting, pattern matching & introspection
  sse/                — SSEStream controller
  ws/                 — WebSocket connection, handshake, and room management
documentation/        — live demo server, controllers, and playground UI
test/                 — vitest test suite (970 tests)
```

## Testing

```bash
npm test          # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
```

## License

MIT
