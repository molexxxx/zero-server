<p align="center">
  <a href="https://z-http.com">
    <img src="documentation/public/icons/logo-animated.svg" alt="zero-http logo" width="120" height="120">
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
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Full-Featured Server](#full-featured-server)
- [Core](#core)
  - [createApp](#createapp)
  - [Router](#router)
  - [Request](#request)
  - [Response](#response)
- [Body Parsers](#body-parsers)
  - [json](#json)
  - [urlencoded](#urlencoded)
  - [text](#text)
  - [raw](#raw)
  - [multipart](#multipart)
- [Middleware](#middleware)
  - [cors](#cors)
  - [compress](#compress)
  - [helmet](#helmet)
  - [static](#static)
  - [rateLimit](#ratelimit)
  - [timeout](#timeout)
  - [requestId](#requestid)
  - [logger](#logger)
- [Cookies & Security](#cookies-security)
  - [cookieParser](#cookieparser)
  - [csrf](#csrf)
  - [validate](#validate)
- [Environment](#environment)
  - [env](#env)
  - [.env File Format](#env-file-format)
  - [Schema Types](#schema-types)
- [ORM](#orm)
  - [Database](#database)
  - [SQLite Adapter](#sqlite-adapter)
  - [MySQL Adapter](#mysql-adapter)
  - [PostgreSQL Adapter](#postgresql-adapter)
  - [MongoDB Adapter](#mongodb-adapter)
  - [Memory Adapter](#memory-adapter)
  - [JSON Adapter](#json-adapter)
  - [Model](#model)
  - [Query](#query)
  - [Schema DDL](#schema-ddl)
  - [TYPES](#types)
- [Real-Time](#real-time)
  - [WebSocket](#websocket)
  - [WebSocketPool](#websocketpool)
  - [SSE (Server-Sent Events)](#sse-server-sent-events)
- [Networking](#networking)
- [Error Handling](#error-handling)
  - [Error Classes](#error-classes)
  - [Framework Errors](#framework-errors)
  - [errorHandler](#errorhandler)
  - [debug](#debug)
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

## Installation

Install zero-http from npm. No external dependencies are required — everything is built in.

```bash
npm install zero-http
```


> **Tip:** zero-http has zero runtime dependencies — npm install is all you need.
> **Tip:** Requires Node.js 18+ (uses crypto.randomUUID, structuredClone, etc.).
> **Tip:** TypeScript definitions are included in the package under types/.


---

## Quickstart

Create a minimal server with JSON parsing and static file serving in under 10 lines.

```js
const { createApp, json, static: serveStatic } = require('zero-http')
const path = require('path')
const app = createApp()

app.use(json({ limit: '10kb' }))
app.use(serveStatic(path.join(__dirname, 'public'), { index: 'index.html' }))

app.get('/ping', (req, res) => res.json({ pong: true }))

app.listen(3000, () => {
	console.log('Server listening on http://localhost:3000')
})
```


> **Tip:** Middleware runs in registration order — add parsers before route handlers.
> **Tip:** All route methods (get, post, put, etc.) return the app, so you can chain them.
> **Tip:** Use app.onError() to register a global error handler for uncaught errors.


---

## Full-Featured Server

A complete production-ready skeleton combining security headers, CSRF, cookies, timeouts, request IDs, logging, CORS, compression, body parsing, rate limiting, validation, static serving, WebSocket, SSE, Router sub-apps, app settings, and error handling.

```js
const path = require('path')
const { createApp, cors, json, urlencoded, text, compress, helmet, timeout,
	requestId, cookieParser, csrf, validate, rateLimit, logger,
	static: serveStatic, Router, WebSocketPool } = require('zero-http')

const app = createApp()

// App settings
app.set('env', process.env.NODE_ENV || 'development')
app.locals.appName = 'My App'

// Middleware stack (order matters!)
app.use(requestId())    // tag every request with a unique ID
app.use(logger())       // log method, url, status, response time
app.use(helmet())       // security headers (CSP, HSTS, X-Frame, etc.)
app.use(cors())         // CORS with preflight handling
app.use(compress())     // brotli/gzip/deflate response compression
app.use(timeout(30000)) // 30s timeout → 408
app.use(rateLimit())    // 100 req/min per IP
app.use(cookieParser('my-secret'))  // signed cookies
app.use(json({ limit: '1mb' }))     // JSON body parser
app.use(urlencoded({ extended: true })) // form body parser
app.use(text())         // plain text parser
app.use(csrf())         // CSRF protection
app.use(serveStatic(path.join(__dirname, 'public')))

// API routes
const api = Router()
api.get('/health', (req, res) => res.json({ status: 'ok', id: req.id }))
api.post('/users', validate({
	body: {
		name:  { type: 'string', required: true, minLength: 2 },
		email: { type: 'email', required: true }
	}
}), (req, res) => res.status(201).json(req.body))
app.use('/api', api)

// WebSocket with rooms
const pool = new WebSocketPool()
app.ws('/chat', (ws, req) => {
	pool.add(ws)
	pool.join(ws, 'general')
	ws.on('message', msg => pool.toRoom('general', msg, ws))
})

// SSE
app.get('/events', (req, res) => {
	const sse = res.sse({ retry: 3000, autoId: true })
	sse.send('connected')
	sse.on('close', () => console.log('bye'))
})

app.onError((err, req, res) => {
	res.status(500).json({ error: err.message, requestId: req.id })
})

app.listen(3000)
```


> **Tip:** Always place parsers (json, urlencoded) before route handlers.
> **Tip:** helmet() should come early in the middleware stack to set security headers on all responses.
> **Tip:** cookieParser must come before csrf() since CSRF reads the cookie token.


---

## Core

### createApp

Creates an application instance — the central object for registering middleware, routes, and settings. Supports set/get, enable/disable, locals, param handlers, groups, chaining, and route introspection.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `use` | `use([path], ...handlers)` | Register middleware or mount a Router at a prefix. Runs in registration order. |
| `get` | `get(path, [opts], ...handlers)` | Register a GET route handler. Also: app.get(key) returns an app setting. |
| `post` | `post(path, [opts], ...handlers)` | Register a POST route handler. |
| `put` | `put(path, [opts], ...handlers)` | Register a PUT route handler. |
| `delete` | `delete(path, [opts], ...handlers)` | Register a DELETE route handler. |
| `patch` | `patch(path, [opts], ...handlers)` | Register a PATCH route handler. |
| `options` | `options(path, [opts], ...handlers)` | Register an OPTIONS route handler. |
| `head` | `head(path, [opts], ...handlers)` | Register a HEAD route handler. |
| `all` | `all(path, [opts], ...handlers)` | Register a handler for ALL HTTP methods. |
| `ws` | `ws(path, [opts], handler)` | Register a WebSocket upgrade handler. See Real-Time → WebSocket. |
| `set` | `set(key, value)` | Set an application setting (also used as get(key) to retrieve). |
| `enable` | `enable(key)` | Set a boolean setting to true. |
| `disable` | `disable(key)` | Set a boolean setting to false. |
| `enabled` | `enabled(key)` | Check if a setting is truthy. |
| `disabled` | `disabled(key)` | Check if a setting is falsy. |
| `locals` | `locals` | A plain object for storing application-wide data. Merged into req.locals on each request. |
| `param` | `param(name, handler)` | Register a parameter handler that fires when :name appears in a route. |
| `group` | `group(prefix, [...middleware], fn)` | Group routes under a prefix with shared middleware. |
| `chain` | `chain(path)` | Start a route chain for a single path. Returns { get, post, put, delete, ... }. |
| `routes` | `routes()` | Return the full route table for introspection/debugging. |
| `onError` | `onError(handler)` | Register a global error handler: (err, req, res, next) => {}. |
| `listen` | `listen(port, [tlsOpts], [cb])` | Start the HTTP(S) server. Pass TLS options for HTTPS. |
| `close` | `close()` | Shut down the server. |
| `handler` | `handler` | The raw (req, res) handler for use with custom HTTP servers. |


```js
const { createApp, json } = require('zero-http')
const app = createApp()

// App settings
app.set('env', 'production')
app.enable('trust proxy')
console.log(app.get('env'))            // 'production'
console.log(app.enabled('trust proxy')) // true

// Shared locals
app.locals.appName = 'My API'

// Route chaining
app.get('/', (req, res) => res.json({ app: req.locals.appName }))
   .get('/health', (req, res) => res.sendStatus(200))

// Route groups with shared middleware
app.group('/api/v1', json(), (router) => {
	router.get('/users', (req, res) => res.json([]))
	router.post('/users', (req, res) => res.status(201).json(req.body))
})

// Param handlers
app.param('id', (req, res, next, value) => {
	if (!/^\d+$/.test(value)) return res.status(400).json({ error: 'Invalid ID' })
	next()
})

app.listen(3000)
```


> **Tip:** All route methods (get, post, etc.) return the app instance, allowing chaining.
> **Tip:** app.set('key', value) and app.get('key') share a dual-purpose API like Express.
> **Tip:** The { secure: true } route option rejects non-HTTPS requests with 403.


### Router

Creates a standalone modular router instance for organizing routes into sub-apps. Mount routers with app.use(prefix, router). Supports all the same route methods as createApp, plus route chaining and introspection.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `get` | `get(path, [opts], ...handlers)` | Register a GET route on this router. |
| `post` | `post(path, [opts], ...handlers)` | Register a POST route. |
| `put` | `put(path, [opts], ...handlers)` | Register a PUT route. |
| `delete` | `delete(path, [opts], ...handlers)` | Register a DELETE route. |
| `patch` | `patch(path, [opts], ...handlers)` | Register a PATCH route. |
| `options` | `options(path, [opts], ...handlers)` | Register an OPTIONS route. |
| `head` | `head(path, [opts], ...handlers)` | Register a HEAD route. |
| `all` | `all(path, [opts], ...handlers)` | Register a handler for all HTTP methods. |
| `use` | `use([prefix], handler)` | Mount middleware or a nested router. |
| `route` | `route(path)` | Create a route chain: router.route('/items').get(fn).post(fn). |
| `inspect` | `inspect()` | Return the route table for this router. |


```js
const { createApp, Router, json } = require('zero-http')
const app = createApp()
app.use(json())

const users = Router()
users.get('/', (req, res) => res.json([]))
users.get('/:id', (req, res) => res.json({ id: req.params.id }))
users.post('/', (req, res) => res.status(201).json(req.body))

const posts = Router()
posts.route('/')
	.get((req, res) => res.json([]))
	.post((req, res) => res.status(201).json(req.body))
posts.get('/:id', (req, res) => res.json({ id: req.params.id }))

app.use('/api/users', users)
app.use('/api/posts', posts)

app.get('/debug/routes', (req, res) => res.json(app.routes()))

app.listen(3000)
```


> **Tip:** Routers can be nested — mount a Router inside another Router.
> **Tip:** Use app.routes() to see the full merged route table for debugging.
> **Tip:** The { secure } route option works on router-level routes too.


### Request

The request object wraps Node's IncomingMessage with Express-compatible properties and helpers. Available as the first argument to every route handler and middleware.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `method` | `req.method` | HTTP method string ('GET', 'POST', etc.). |
| `url` | `req.url` | Full URL including query string. |
| `path` | `req.path` | URL path without query string. |
| `headers` | `req.headers` | Lower-cased request headers object. |
| `query` | `req.query` | Parsed query-string key/value pairs. |
| `params` | `req.params` | Route parameters from path segments (e.g. /:id). |
| `body` | `req.body` | Request body (populated by body-parsing middleware). |
| `cookies` | `req.cookies` | Parsed cookies (populated by cookieParser). |
| `signedCookies` | `req.signedCookies` | Verified signed cookies (populated by cookieParser with a secret). |
| `secret` | `req.secret` | First signing secret (set by cookieParser). Used by res.cookie({ signed: true }). |
| `ip` | `req.ip` | Remote IP address. |
| `secure` | `req.secure` | true if the connection is over TLS. |
| `protocol` | `req.protocol` | 'https' or 'http'. |
| `hostname` | `req.hostname` | Hostname from the Host header. |
| `subdomains` | `req.subdomains([offset])` | Array of subdomains (offset defaults to 2). |
| `originalUrl` | `req.originalUrl` | Original URL as received — never rewritten by middleware. |
| `baseUrl` | `req.baseUrl` | The URL prefix on which the current router was mounted. |
| `locals` | `req.locals` | Request-scoped data store (merged from app.locals). |
| `id` | `req.id` | Unique request ID (set by requestId middleware). |
| `get` | `req.get(name)` | Get a request header (case-insensitive). |
| `is` | `req.is(type)` | Check if Content-Type matches (e.g. req.is('json')). |
| `accepts` | `req.accepts(...types)` | Content negotiation — which types the client accepts. |
| `fresh` | `req.fresh` | true if the client cache is still valid (ETag/Last-Modified). |
| `stale` | `req.stale` | Inverse of fresh. |
| `xhr` | `req.xhr` | true if X-Requested-With is XMLHttpRequest. |
| `range` | `req.range(size)` | Parse the Range header. Returns object or -1/-2. |
| `raw` | `req.raw` | The original Node IncomingMessage. |


> **Tip:** req.query is always an object — even if no query string is present, it defaults to {}.
> **Tip:** req.body is undefined until a body-parsing middleware populates it.
> **Tip:** req.locals persists for the life of the request — use it to pass data between middleware.


### Response

The response object wraps Node's ServerResponse with chainable methods for setting status codes, headers, cookies, and sending various response types. Available as the second argument to every route handler.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `status` | `res.status(code)` | Set the HTTP status code. Chainable. |
| `set` | `res.set(name, value)` | Set a response header. Chainable. |
| `get` | `res.get(name)` | Get a previously-set response header. |
| `append` | `res.append(name, value)` | Append a value to a header. |
| `vary` | `res.vary(field)` | Add a field to the Vary header. |
| `type` | `res.type(ct)` | Set Content-Type. Chainable. |
| `send` | `res.send(body)` | Send a response (string, Buffer, object, or null). Auto-sets Content-Type. |
| `json` | `res.json(obj)` | Send a JSON response with Content-Type: application/json. |
| `text` | `res.text(str)` | Send a plain text response. |
| `html` | `res.html(str)` | Send an HTML response. |
| `sendStatus` | `res.sendStatus(code)` | Send only the status code with its reason phrase as body. |
| `sendFile` | `res.sendFile(path, [opts], [cb])` | Stream a file as the response with appropriate Content-Type. |
| `download` | `res.download(path, [filename], [cb])` | Prompt a file download with Content-Disposition header. |
| `cookie` | `res.cookie(name, value, [opts])` | Set a cookie. Supports signed (auto-sign via req.secret), priority (Low/Medium/High), partitioned (CHIPS), and auto-serializes objects as JSON cookies (j: prefix). Chainable. |
| `clearCookie` | `res.clearCookie(name, [opts])` | Clear a cookie by setting it to expire. Chainable. |
| `redirect` | `res.redirect([status], url)` | Send a redirect response. Default status: 302. |
| `format` | `res.format(types)` | Content negotiation — respond based on Accept header. Keys are MIME types. |
| `links` | `res.links(links)` | Set the Link header from { rel: url } pairs. Chainable. |
| `location` | `res.location(url)` | Set the Location header. Chainable. |
| `sse` | `res.sse([opts])` | Open a Server-Sent Events stream. See Real-Time → SSE. |
| `headersSent` | `res.headersSent` | true if headers have already been sent. |
| `locals` | `res.locals` | Request-scoped data store. |
| `raw` | `res.raw` | The original Node ServerResponse. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `domain` | string | `—` | Cookie domain scope. |
| `path` | string | `'/'` | Cookie URL path scope. |
| `expires` | Date \| number | `—` | Cookie expiration date. |
| `maxAge` | number | `—` | Cookie lifetime in seconds. |
| `httpOnly` | boolean | `false` | Restrict cookie to HTTP(S) only — no JavaScript access. |
| `secure` | boolean | `false` | Send cookie only over HTTPS. |
| `sameSite` | string | `—` | 'Strict', 'Lax', or 'None'. Controls cross-site cookie behavior. |
| `signed` | boolean | `false` | Auto-sign the cookie value using req.secret (set by cookieParser). |
| `priority` | string | `—` | 'Low', 'Medium', or 'High'. Browser cookie eviction priority. |
| `partitioned` | boolean | `false` | CHIPS partitioned attribute. Requires secure: true. Isolates cookies per top-level site. |


```js
app.get('/data', (req, res) => {
	// Content negotiation
	res.format({
		'text/html': () => res.html('<h1>Data</h1>'),
		'application/json': () => res.json({ data: true }),
		'text/plain': () => res.text('data'),
		default: () => res.status(406).json({ error: 'Not Acceptable' })
	})
})

// Chaining
res.status(201).set('X-Custom', 'value').json({ ok: true })

// Cookies with new features
res.cookie('session', 'abc', { signed: true, httpOnly: true, secure: true })
res.cookie('prefs', { theme: 'dark' }, { maxAge: 86400 }) // auto JSON
res.cookie('important', 'val', { priority: 'High', partitioned: true })
```


> **Tip:** res.cookie() with signed: true requires cookieParser to be configured with a secret.
> **Tip:** Object values passed to res.cookie() are auto-serialized with the j: prefix for JSON cookies.
> **Tip:** res.send(object) calls res.json() automatically — you can use either interchangeably.



---

## Body Parsers

### json

Parses JSON request bodies into req.body. Matches Content-Type application/json by default. Supports size limits, strict mode (reject non-object/array roots), and custom reviver functions.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | string \| number | `'1mb'` | Maximum body size (e.g. '10kb', '5mb', or bytes as number). |
| `strict` | boolean | `true` | Reject payloads whose root is not an object or array. |
| `reviver` | function | `—` | JSON.parse reviver function for custom deserialization. |
| `type` | string \| function | `'application/json'` | Content-Type to match. Can be a function returning boolean. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, json } = require('zero-http')
const app = createApp()

app.use(json({ limit: '10kb', strict: true }))

app.post('/data', (req, res) => {
	console.log(req.body) // parsed JSON object
	res.json({ received: req.body })
})
```


> **Tip:** With strict: true (default), primitives like '"hello"' or '42' are rejected — only {} and [] are allowed.
> **Tip:** The limit option accepts human-readable strings: '100kb', '1mb', '500b'.
> **Tip:** Use requireSecure: true on sensitive endpoints to enforce HTTPS-only body submission.


### urlencoded

Parses URL-encoded form bodies (application/x-www-form-urlencoded) into req.body. Supports nested object parsing with the extended option.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `extended` | boolean | `false` | Enable nested bracket parsing (e.g. user[name]=Alice → { user: { name: 'Alice' } }). |
| `limit` | string \| number | `'1mb'` | Maximum body size. |
| `type` | string \| function | `'application/x-www-form-urlencoded'` | Content-Type to match. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, urlencoded } = require('zero-http')
const app = createApp()

app.use(urlencoded({ extended: true }))

app.post('/form', (req, res) => {
	console.log(req.body) // { name: 'Alice', age: '30' }
	res.json(req.body)
})
```


### text

Reads the raw request body as a UTF-8 string into req.body. Matches Content-Type text/* by default.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `type` | string \| function | `'text/*'` | Content-Type to match. |
| `limit` | string \| number | `'1mb'` | Maximum body size. |
| `encoding` | string | `'utf8'` | Character encoding. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, text } = require('zero-http')
const app = createApp()

app.use(text())

app.post('/log', (req, res) => {
	console.log(typeof req.body) // 'string'
	res.text('Received: ' + req.body)
})
```


### raw

Reads the raw request body as a Buffer into req.body. Useful for binary data, webhooks, or custom protocols.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `type` | string \| function | `'application/octet-stream'` | Content-Type to match. |
| `limit` | string \| number | `'1mb'` | Maximum body size. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, raw } = require('zero-http')
const app = createApp()

app.use(raw({ type: 'application/octet-stream', limit: '5mb' }))

app.post('/webhook', (req, res) => {
	console.log(Buffer.isBuffer(req.body)) // true
	res.sendStatus(200)
})
```


### multipart

Streams multipart/form-data file uploads to disk and populates req.body with { fields, files }. Each file entry includes the original filename, stored path, content type, and size.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `dir` | string | `os.tmpdir() + '/zero-http-uploads'` | Upload directory. Created automatically if it doesn't exist. |
| `maxFileSize` | number | `—` | Maximum file size in bytes. Rejects oversized files with 413. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const path = require('path')
const { createApp, multipart } = require('zero-http')
const app = createApp()

app.post('/upload', multipart({
	dir: path.join(__dirname, 'uploads'),
	maxFileSize: 10 * 1024 * 1024 // 10 MB
}), (req, res) => {
	res.json({
		files: req.body.files,   // [{ originalFilename, storedName, path, contentType, size }]
		fields: req.body.fields  // { description: 'My photo' }
	})
})
```


> **Tip:** Files are streamed to disk, not buffered in memory — safe for large uploads.
> **Tip:** The upload directory is created automatically if it doesn't exist.
> **Tip:** Each file object contains: originalFilename, storedName, path, contentType, size.



---

## Middleware

### cors

CORS middleware with automatic preflight handling. Supports exact origins, subdomain matching with dot-prefix syntax, credentials, and configurable allowed methods/headers.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `origin` | string \| string[] | `'*'` | Allowed origins. Use '.example.com' for subdomain wildcards. |
| `methods` | string | `'GET,POST,PUT,DELETE,PATCH,OPTIONS'` | Allowed HTTP methods. |
| `allowedHeaders` | string | `—` | Allowed request headers. |
| `exposedHeaders` | string | `—` | Headers exposed to the browser. |
| `credentials` | boolean | `false` | Allow credentials (cookies, auth headers). |
| `maxAge` | number | `—` | Preflight cache duration in seconds. |


```js
const { createApp, cors, json } = require('zero-http')
const app = createApp()

app.use(cors({
	origin: [
		'https://mysite.com',     // exact match
		'.mysite.com'             // matches api.mysite.com, www.mysite.com, etc.
	],
	credentials: true,
	methods: 'GET,POST,PUT,DELETE'
}))
app.use(json())

app.get('/data', (req, res) => res.json({ secure: true }))
```


> **Tip:** Use the dot-prefix '.example.com' to match all subdomains without listing each one.
> **Tip:** When credentials: true, origin cannot be '*' — you must specify explicit origins.
> **Tip:** Preflight OPTIONS requests are handled automatically — no extra route needed.


### compress

Response compression middleware. Auto-negotiates the best encoding (brotli > gzip > deflate) based on the client's Accept-Encoding header. Brotli preferred when available (Node 11.7+). Automatically skips SSE streams.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | number | `1024` | Minimum body size in bytes to compress. |
| `level` | number | `-1 (zlib default)` | Compression level. |
| `filter` | function | `—` | Return false to skip compression: (req, res) => boolean. |


```js
const { createApp, compress, json } = require('zero-http')
const app = createApp()

app.use(compress({ threshold: 512, level: 6 }))
app.use(json())

app.get('/big', (req, res) => {
	res.json({ data: 'x'.repeat(10000) }) // compressed
})

app.get('/small', (req, res) => {
	res.json({ ok: true }) // below threshold — sent raw
})
```


> **Tip:** Brotli typically achieves 15-25% better compression than gzip at similar speeds.
> **Tip:** SSE streams are automatically excluded from compression.
> **Tip:** Set threshold: 0 to compress everything, but very small responses don't benefit.


### helmet

Security headers middleware. Sets Content-Security-Policy, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and 11 more headers. Every header can be individually configured or disabled with false.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `contentSecurityPolicy` | object \| false | `default policy` | CSP directives or false to disable. |
| `frameguard` | string \| false | `'deny'` | 'deny', 'sameorigin', or false. |
| `hsts` | boolean \| false | `true` | Strict-Transport-Security header. |
| `hstsMaxAge` | number | `15552000` | HSTS max-age in seconds (180 days). |
| `noSniff` | boolean | `true` | X-Content-Type-Options: nosniff. |
| `referrerPolicy` | string \| false | `'no-referrer'` | Referrer-Policy header value. |
| `hidePoweredBy` | boolean | `true` | Remove X-Powered-By header. |
| `xssFilter` | boolean | `false` | Legacy X-XSS-Protection header. |


```js
const { createApp, helmet, json } = require('zero-http')
const app = createApp()

// Sensible defaults
app.use(helmet())

// Custom CSP + disable HSTS
app.use(helmet({
	contentSecurityPolicy: {
		defaultSrc: ["'self'"],
		scriptSrc: ["'self'", 'cdn.example.com'],
		imgSrc: ["'self'", 'data:', '*.cloudfront.net']
	},
	hsts: false,
	frameguard: 'sameorigin'
}))
```


> **Tip:** helmet() with no options gives you a strong security baseline out of the box.
> **Tip:** Set any header to false to disable it individually.
> **Tip:** CSP headers are critical for preventing XSS — always configure explicitly for production apps.


### static

Serves static files from a directory with automatic Content-Type detection (60+ MIME types), cache headers, dotfile protection, and HTML extension fallback.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `index` | string \| false | `'index.html'` | Default file for directory requests. Set false to disable. |
| `maxAge` | number | `0` | Cache-Control max-age in milliseconds. |
| `dotfiles` | string | `'ignore'` | 'allow', 'deny', or 'ignore'. Controls access to dotfiles. |
| `extensions` | string[] | `—` | Try these extensions if the file isn't found (e.g. ['html', 'htm']). |
| `setHeaders` | function | `—` | Custom header setter: (res, filePath) => {}. |


```js
const path = require('path')
const { createApp, static: serveStatic } = require('zero-http')
const app = createApp()

app.use(serveStatic(path.join(__dirname, 'public'), {
	index: 'index.html',
	maxAge: 3600000,          // 1 hour
	dotfiles: 'ignore',
	extensions: ['html', 'htm'],
	setHeaders: (res, filePath) => {
		res.setHeader('X-Served-By', 'zero-http')
	}
}))
```


> **Tip:** 'static' is a reserved word in JavaScript — import as: const { static: serveStatic } = require('zero-http').
> **Tip:** Set maxAge to at least 1 hour (3600000ms) in production for cache performance.
> **Tip:** dotfiles: 'deny' returns 403 for requests like /.env or /.git — use in production.


### rateLimit

Per-IP rate limiter middleware. Tracks request counts in a sliding window and returns 429 Too Many Requests when exceeded. Sets X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, and Retry-After headers.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | number | `60000` | Time window in milliseconds (default: 1 minute). |
| `max` | number | `100` | Maximum requests per window per IP. |
| `message` | string | `—` | Custom error message for rate-limited responses. |
| `statusCode` | number | `429` | HTTP status code for rate-limited responses. |
| `keyGenerator` | function | `req => req.ip` | Custom key extraction function for grouping requests. |
| `skip` | function | `—` | (req) => boolean. Return true to skip rate limiting for the request (e.g. whitelisted IPs or admin users). |
| `handler` | function | `—` | (req, res) => void. Custom handler for rate-limited requests instead of the default JSON error response. |


```js
const { createApp, json, rateLimit } = require('zero-http')
const app = createApp()

// Global: 200 req/min per IP
app.use(rateLimit({ windowMs: 60000, max: 200 }))
app.use(json())

// Login: 5 attempts per minute
app.post('/login', rateLimit({
	windowMs: 60000,
	max: 5,
	message: 'Too many login attempts'
}), (req, res) => {
	res.json({ ok: true })
})
```


> **Tip:** Apply strict limits to authentication endpoints (5-10 per minute).
> **Tip:** Rate limit headers (X-RateLimit-*) are set automatically for all responses.
> **Tip:** Use keyGenerator to rate-limit by API key instead of IP for authenticated APIs.
> **Tip:** Use skip to bypass rate limiting for trusted clients: skip: (req) => req.ip === '127.0.0.1'.
> **Tip:** Use handler to customize the rate-limited response (e.g. redirect, HTML page, or custom JSON).


### timeout

Request timeout middleware. If a handler doesn't respond within the specified duration, automatically sends a 408 response and sets req.timedOut to true.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `status` | number | `408` | HTTP status code for timeout responses. |
| `message` | string | `'Request Timeout'` | Error message body. |


```js
const { createApp, timeout } = require('zero-http')
const app = createApp()

app.use(timeout(10000)) // 10s timeout

app.get('/slow', async (req, res) => {
	await new Promise(r => setTimeout(r, 15000))
	if (req.timedOut) return // already sent 408
	res.json({ data: 'done' })
})
```


> **Tip:** Always check req.timedOut before responding in long-running handlers.
> **Tip:** Set different timeouts per route by applying timeout() as route middleware.
> **Tip:** 30 seconds is a reasonable default for most APIs.


### requestId

Generates a unique request ID (UUID v4 by default) for each request. Sets req.id and adds the ID as a response header for log correlation.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | string | `'X-Request-Id'` | Response header name. |
| `generator` | function | `crypto.randomUUID` | Custom ID generator function. |
| `trustProxy` | boolean | `false` | Trust incoming X-Request-Id from upstream proxies. |


```js
const { createApp, requestId, logger } = require('zero-http')
const app = createApp()

app.use(requestId()) // sets req.id + X-Request-Id header
app.use(logger())    // logs include the request ID

app.get('/info', (req, res) => {
	res.json({ requestId: req.id })
})
```


### logger

Request logger middleware with response timing. Logs method, URL, status code, and response time in configurable formats with optional colorized output.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `format` | string | `'dev'` | 'dev' (verbose), 'short' (compact), or 'tiny' (minimal). |
| `logger` | function | `console.log` | Custom log function (e.g. write to file). |
| `colors` | boolean | `auto (TTY detection)` | Colorize output. |


```js
const fs = require('fs')
const { createApp, logger } = require('zero-http')
const app = createApp()

// Colorized dev output to stdout
app.use(logger({ format: 'dev' }))

// Or: append to a log file
app.use(logger({
	format: 'short',
	colors: false,
	logger: (msg) => fs.appendFileSync('access.log', msg + '\n')
}))
```



---

## Cookies & Security

### cookieParser

Cookie parsing middleware with timing-safe HMAC-SHA256 signature verification, JSON cookie support, secret rotation, and static helper methods. Parses the Cookie header into req.cookies and req.signedCookies. When a secret is provided, signed cookies (s: prefix) are verified using crypto.timingSafeEqual to prevent timing attacks. JSON cookies (j: prefix) are automatically parsed into objects. Exposes req.secret and req.secrets for downstream middleware like res.cookie({ signed: true }) and csrf().

#### Methods

| Method | Signature | Description |
|---|---|---|
| `sign` | `cookieParser.sign(value, secret)` | Sign a value with HMAC-SHA256. Returns 's:<value>.<signature>'. |
| `unsign` | `cookieParser.unsign(value, secrets)` | Verify and unsign a signed cookie. Tries all provided secrets (rotation support). Returns the original value or false. |
| `jsonCookie` | `cookieParser.jsonCookie(value)` | Serialize a value as a JSON cookie string: 'j:' + JSON.stringify(value). |
| `parseJSON` | `cookieParser.parseJSON(str)` | Parse a JSON cookie string (j: prefix). Returns parsed value or original string. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `secret` | string \| string[] | `—` | Signing secret. Pass an array for key rotation — newest first. When set, populates req.secret and req.secrets. |
| `decode` | boolean | `true` | URI-decode cookie values. |


```js
const { createApp, cookieParser, json } = require('zero-http')
const app = createApp()

// Basic setup with signing secret
app.use(cookieParser('super-secret-key'))
app.use(json())

// Reading cookies
app.get('/read', (req, res) => {
	res.json({
		cookies: req.cookies,           // { theme: 'dark', prefs: { lang: 'en' } }
		signed: req.signedCookies,       // { session: 'abc123' }
		secret: req.secret               // available for downstream use
	})
})

// Setting cookies with new features
app.get('/set', (req, res) => {
	// Auto-sign using req.secret
	res.cookie('session', 'abc123', { signed: true, httpOnly: true, secure: true })

	// JSON cookie — objects auto-serialize with j: prefix
	res.cookie('prefs', { lang: 'en', theme: 'dark' }, { maxAge: 86400 })

	// Priority + Partitioned (CHIPS)
	res.cookie('important', 'value', { priority: 'High', partitioned: true, secure: true })

	res.json({ ok: true })
})

// Secret rotation — verify with old key, sign with new key
app.use(cookieParser(['new-secret', 'old-secret']))

// Static helpers for manual use
const signed = cookieParser.sign('data', 'secret')
const value = cookieParser.unsign(signed, ['secret'])  // 'data' or false
const parsed = cookieParser.jsonCookie({ a: 1 })        // 'j:{"a":1}'
```


> **Tip:** Always use signed cookies for session tokens and sensitive data.
> **Tip:** For key rotation, pass secrets as an array: ['new-key', 'old-key']. Cookies are verified against all secrets but signed with the first.
> **Tip:** Signature verification uses crypto.timingSafeEqual() to prevent timing attacks — never downgrade to string comparison.
> **Tip:** JSON cookies (j: prefix) are auto-parsed — no need to manually JSON.parse cookie values.
> **Tip:** res.cookie() with signed: true requires cookieParser to be configured with a secret. It reads req.secret automatically.
> **Tip:** The partitioned attribute (CHIPS) isolates cookies per top-level site — useful for third-party embedded widgets.


### csrf

Double-submit cookie CSRF protection. Generates a cryptographically random token, stores it in a cookie, and validates it on state-changing requests. GET, HEAD, and OPTIONS are automatically skipped. Tokens can be sent via header, body (_csrf field), or query parameter.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `cookie` | string | `'_csrf'` | Cookie name for the CSRF token. |
| `header` | string | `'x-csrf-token'` | Request header to check for the token. |
| `saltLength` | number | `18` | Token salt length in bytes. |
| `secret` | string | `auto-generated` | Secret for token generation. Auto-generated if not provided. |
| `ignoreMethods` | string[] | `['GET','HEAD','OPTIONS']` | HTTP methods that skip CSRF validation. |
| `ignorePaths` | string[] | `[]` | URL paths to skip (e.g. webhook endpoints). |
| `onError` | function | `—` | Custom error handler: (err, req, res, next) => {}. |


```js
const { createApp, csrf, json, cookieParser } = require('zero-http')
const app = createApp()

app.use(cookieParser())
app.use(json())
app.use(csrf())

// GET is safe — use it to read the token
app.get('/api/csrf-token', (req, res) => {
	res.json({ token: req.csrfToken })
})

// POST must include the token
app.post('/api/transfer', (req, res) => {
	res.json({ success: true, amount: req.body.amount })
})

// Client-side:
// const { token } = await fetch('/api/csrf-token').then(r => r.json())
// await fetch('/api/transfer', {
//   method: 'POST',
//   headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
//   body: JSON.stringify({ amount: 100 })
// })
```


> **Tip:** cookieParser() must be registered before csrf() even without a signing secret.
> **Tip:** Use ignorePaths for webhook endpoints that receive external POST requests.
> **Tip:** The token is available on req.csrfToken after the middleware runs.


### validate

Request validation middleware with 11 types and auto-coercion. Validates req.body, req.query, and req.params against a declarative schema. Unknown fields are stripped by default. Returns 422 with structured error messages on failure.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `validate.field` | `validate.field(value, rules)` | Validate a single value against rules. Returns { valid, errors, value }. |
| `validate.object` | `validate.object(data, schema)` | Validate an object against a schema. Returns { valid, errors, sanitized }. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `stripUnknown` | boolean | `true` | Remove fields not defined in the schema. |
| `onError` | function | `—` | Custom error handler. Default sends 422 JSON. |


```js
const { createApp, json, validate } = require('zero-http')
const app = createApp()
app.use(json())

// Validate body
app.post('/users', validate({
	body: {
		name:  { type: 'string', required: true, minLength: 2, maxLength: 50 },
		email: { type: 'email', required: true },
		age:   { type: 'integer', min: 13, max: 120 },
		role:  { type: 'string', enum: ['user', 'admin'], default: 'user' },
		tags:  { type: 'array', minItems: 1, maxItems: 5 }
	}
}), (req, res) => {
	res.status(201).json(req.body) // sanitized
})

// Validate query + params
app.get('/search/:category', validate({
	params: { category: { type: 'string', enum: ['books', 'music', 'films'] } },
	query: {
		q:     { type: 'string', required: true },
		page:  { type: 'integer', min: 1, default: 1 },
		limit: { type: 'integer', min: 1, max: 100, default: 20 }
	}
}), (req, res) => {
	res.json({ params: req.params, query: req.query })
})
// Validation failure → 422 { errors: ['name is required', ...] }
```


> **Tip:** Supported types: string, integer, number, float, boolean, array, json, date, uuid, email, url.
> **Tip:** Auto-coercion: '42' → 42 (integer), 'true' → true (boolean), etc.
> **Tip:** stripUnknown: true (default) prevents mass-assignment attacks by removing unknown fields.
> **Tip:** Use validate.field() and validate.object() for programmatic validation outside middleware.



---

## Environment

### env

Typed environment variable system with .env file loading, schema validation, and type coercion. Access variables via proxy (env.PORT), function call (env('PORT')), or method (env.get('PORT')). Supports 9 types: string, number, integer, port, boolean, array, json, url, enum. Loads .env files in precedence order with process.env always winning.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `load` | `env.load(schema, [opts])` | Load and validate environment variables from .env files against a typed schema. Throws on validation failure with all errors. |
| `get` | `env.get(key)` | Get a typed environment variable by key. |
| `require` | `env.require(key)` | Get a variable or throw if it's not set. Use for critical config. |
| `has` | `env.has(key)` | Check if a variable is set (not undefined). |
| `all` | `env.all()` | Get all loaded values as a plain object. |
| `reset` | `env.reset()` | Reset the env store. Useful for testing. |
| `parse` | `env.parse(src)` | Parse a .env file string into key-value pairs. Supports comments, quotes, multiline, interpolation, and export prefix. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | string | `process.cwd()` | Custom directory to load .env files from. |
| `override` | boolean | `false` | Write file values into process.env (normally process.env takes precedence). |


```js
const { createApp, env } = require('zero-http')

// Load with typed schema — validates and coerces on startup
env.load({
	PORT:         { type: 'port', default: 3000 },
	DATABASE_URL: { type: 'url', required: true },
	DEBUG:        { type: 'boolean', default: false },
	ALLOWED_IPS:  { type: 'array', separator: ',', default: [] },
	NODE_ENV:     { type: 'enum', values: ['development', 'production', 'test'], default: 'development' },
	MAX_UPLOAD_MB:{ type: 'integer', min: 1, max: 100, default: 10 },
	APP_CONFIG:   { type: 'json', default: {} }
})

const app = createApp()

app.get('/config', (req, res) => res.json({
	port: env.PORT,           // number: 3000
	debug: env.DEBUG,         // boolean: false
	ips: env.ALLOWED_IPS,     // array: ['10.0.0.1', '10.0.0.2']
	env: env.NODE_ENV         // string: 'development'
}))

app.listen(env.PORT)
```


> **Tip:** env.load() should be called before createApp() — config errors are caught at startup, not at request time.
> **Tip:** process.env always wins over .env file values. Use override: true to reverse this.
> **Tip:** Schema types with examples: port (0-65535), boolean ('true'/'yes'/'1'/'on' → true), array ('a,b,c' → ['a','b','c']), json ('{"key":1}' → object).
> **Tip:** Use env.require('KEY') for critical config that must exist — it throws immediately with a clear error message.


### .env File Format

The env module loads .env files in a specific precedence order with full parsing support. Files are loaded from the working directory (or custom path) in this order: .env → .env.local → .env.{NODE_ENV} → .env.{NODE_ENV}.local. Later files override earlier ones. process.env always takes final precedence.

```bash
# .env — shared defaults
PORT=3000
DATABASE_URL=postgres://localhost:5432/mydb
DEBUG=false
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
APP_NAME=My App

# Comments start with #
export SECRET_KEY=my-secret  # 'export' prefix is stripped

# Quoted values (single, double, backtick)
GREETING="Hello World"
MESSAGE='Single quoted'
TEMPLATE=`Backtick quoted`

# Multiline values
RSA_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----"

# Variable interpolation
API_URL=https://api.example.com
HEALTH_URL=${API_URL}/health

# .env.local — local overrides (gitignore this)
DATABASE_URL=postgres://localhost:5432/mydb_local
DEBUG=true

# .env.production — production settings
DATABASE_URL=postgres://prod-server:5432/mydb
DEBUG=false
NODE_ENV=production
```


> **Tip:** File load order: .env → .env.local → .env.{NODE_ENV} → .env.{NODE_ENV}.local. Each subsequent file overrides previous values.
> **Tip:** Always .gitignore .env.local and .env.*.local files — they contain machine-specific secrets.
> **Tip:** Supports variable interpolation: API_URL=https://api.com then HEALTH=${API_URL}/health.
> **Tip:** The 'export' keyword prefix is stripped automatically — compatible with shell sourceable .env files.
> **Tip:** Multiline values are supported with quotes — the value continues until the matching closing quote.
> **Tip:** Inline comments are supported in unquoted values: PORT=3000 # web server port.


### Schema Types

The env.load() schema supports 9 typed field definitions with validation constraints. Each field can have type, required, default, and type-specific options like min/max, match, separator, and values.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `string` | type | `—` | Basic string. Supports min (min length), max (max length), match (RegExp pattern). |
| `number` | type | `—` | Floating-point number. Supports min, max range validation. |
| `integer` | type | `—` | Whole number (parseInt). Supports min, max range validation. |
| `port` | type | `—` | Integer 0-65535. Rejects values outside valid port range. |
| `boolean` | type | `—` | Truthy: 'true', '1', 'yes', 'on'. Falsy: 'false', '0', 'no', 'off', ''. |
| `array` | type | `—` | Split string by separator (default: ','). Trims items and removes empties. |
| `json` | type | `—` | JSON.parse the value. Throws with clear error if invalid JSON. |
| `url` | type | `—` | Validated URL string. Throws if not a valid URL (uses URL constructor). |
| `enum` | type | `—` | Must be one of values: []. Throws with allowed values in error message. |


```js
env.load({
	// String with pattern matching
	API_KEY:    { type: 'string', required: true, min: 32, match: /^sk_/ },

	// Number with range
	TIMEOUT_MS: { type: 'number', min: 100, max: 60000, default: 5000 },

	// Integer
	WORKERS:    { type: 'integer', min: 1, max: 16, default: 4 },

	// Port (validated 0-65535)
	PORT:       { type: 'port', default: 3000 },

	// Boolean (true/false/yes/no/1/0/on/off)
	DEBUG:      { type: 'boolean', default: false },

	// Array (split by separator)
	ALLOWED:    { type: 'array', separator: ',', default: [] },

	// JSON (parsed to object)
	CONFIG:     { type: 'json', default: {} },

	// URL (validated)
	API_URL:    { type: 'url', required: true },

	// Enum (must match one of values)
	LOG_LEVEL:  { type: 'enum', values: ['debug','info','warn','error'], default: 'info' }
})
```


> **Tip:** If a required field is missing and has no default, env.load() throws immediately with all validation errors.
> **Tip:** Defaults can be functions: { default: () => crypto.randomUUID() } — they're called lazily.
> **Tip:** All type coercion happens at load() time — after that, env.PORT returns a real number, not a string.



---

## ORM

### Database

The ORM entry point. Connect to a database using one of 6 built-in adapters (memory, json, sqlite, mysql, postgres, mongo), register your Model classes, and sync schemas. The Database instance manages the connection lifecycle and provides transaction support. All network-facing adapters (mysql, postgres, mongo) validate credentials on connect — invalid host, port, user, or database values throw immediately.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `connect` | `Database.connect(type, [opts])` | Static factory method. Creates a Database instance with the specified adapter. Validates credentials for network adapters. Returns the Database instance. |
| `register` | `db.register(ModelClass)` | Register a Model class with this database. Chainable. |
| `registerAll` | `db.registerAll(...models)` | Register multiple Model classes. Chainable. |
| `sync` | `db.sync()` | Create tables for all registered models. Returns Promise. |
| `drop` | `db.drop()` | Drop tables for all registered models. Returns Promise. |
| `close` | `db.close()` | Close the database connection. Returns Promise. |
| `model` | `db.model(name)` | Get a registered model by class name. |
| `transaction` | `db.transaction(fn)` | Run an async function inside a transaction. Auto-commits on success, rolls back on error. Falls back to direct execution if the adapter doesn't support transactions. |
| `addColumn` | `db.addColumn(table, column, def)` | Add a column to an existing table. Supports all schema options (type, required, default, references, check). |
| `dropColumn` | `db.dropColumn(table, column)` | Drop a column from a table. |
| `renameColumn` | `db.renameColumn(table, old, new)` | Rename a column in a table. |
| `renameTable` | `db.renameTable(old, new)` | Rename a table. |
| `createIndex` | `db.createIndex(table, cols, [opts])` | Create an index. opts: { name, unique }. cols can be a string or string[]. |
| `dropIndex` | `db.dropIndex(table, name)` | Drop an index by name. |
| `hasTable` | `db.hasTable(table)` | Check if a table exists. Returns Promise<boolean>. |
| `hasColumn` | `db.hasColumn(table, column)` | Check if a column exists on a table. Returns Promise<boolean>. |
| `describeTable` | `db.describeTable(table)` | Get column info for a table. Returns Promise<Array>. |
| `addForeignKey` | `db.addForeignKey(table, col, refTable, refCol, [opts])` | Add a FK constraint (MySQL/PostgreSQL). opts: { name, onDelete, onUpdate }. |
| `dropForeignKey` | `db.dropForeignKey(table, name)` | Drop a FK constraint by name (MySQL/PostgreSQL). |
| `validateFKAction` | `validateFKAction(action)` | Validate a FK action string (CASCADE, SET NULL, SET DEFAULT, RESTRICT, NO ACTION). Throws on invalid. Used internally by adapters; available for custom DDL. |
| `validateCheck` | `validateCheck(expr)` | Validate a CHECK constraint expression for SQL injection patterns (blocks semicolons, DROP, DELETE, INSERT, UPDATE, ALTER, CREATE, EXEC). Throws on dangerous input. Used internally by adapters. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `memory` | adapter | `—` | In-memory adapter. No options required. Great for testing and prototyping. |
| `json` | adapter | `—` | File-based JSON adapter. Options: { path: 'data.json' }. |
| `sqlite` | adapter | `—` | SQLite adapter. Options: { filename, readonly, fileMustExist, createDir, pragmas }. Requires better-sqlite3. Auto-creates parent directories. |
| `mysql` | adapter | `—` | MySQL adapter. Options: { host, user, password, database, port }. Requires mysql2. Credentials validated on connect. |
| `postgres` | adapter | `—` | PostgreSQL adapter. Options: { host, user, password, database, port, ssl }. Requires pg. Credentials validated on connect. |
| `mongo` | adapter | `—` | MongoDB adapter. Options: { url, database, clientOptions }. Requires mongodb. URL and database validated on connect. |


```js
const { Database, Model, TYPES } = require('zero-http')
const path = require('path')

// SQLite with file-based persistence (recommended for single-server apps)
const db = Database.connect('sqlite', {
	filename: path.join(__dirname, 'Database', 'app.db'),
	// createDir: true (default) — auto-creates the Database/ folder
	// pragmas are production-tuned by default:
	//   journal_mode: WAL, foreign_keys: ON, busy_timeout: 5000,
	//   synchronous: NORMAL, cache_size: -64000 (64 MB),
	//   temp_store: MEMORY, mmap_size: 268435456 (256 MB)
})

// Override pragmas as needed
const testDb = Database.connect('sqlite', {
	filename: ':memory:',
	pragmas: { cache_size: '-32000', wal_autocheckpoint: '500' }
})

// Network adapters validate credentials
// Database.connect('mysql', { host: 123 }) → throws: host must be a non-empty string
// Database.connect('postgres', { port: 99999 }) → throws: port must be 1-65535

class User extends Model {
	static table = 'users'
	static schema = {
		id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		name: { type: TYPES.STRING, required: true }
	}
}

db.register(User)
await db.sync()

// Transaction — auto rollback on error
await db.transaction(async () => {
	const sender = await User.findById(1)
	const receiver = await User.findById(2)
	await sender.decrement('balance', 100)
	await receiver.increment('balance', 100)
})
```


> **Tip:** Use 'memory' for tests and prototyping — zero setup, instant startup.
> **Tip:** SQLite with WAL mode handles concurrent reads and writes well for single-server apps.
> **Tip:** All SQLite pragmas have production-ready defaults — you only need to set filename.
> **Tip:** createDir: true (default) auto-creates parent directories for the database file.
> **Tip:** Network adapter credentials (host, port, user, password, database) are type-checked on connect.
> **Tip:** db.transaction() wraps your callback in begin/commit/rollback when the adapter supports it.
> **Tip:** db.register() returns the Database instance — you can chain: db.register(User).register(Post).
> **Tip:** Always call db.sync() after registering models to create the database tables.
> **Tip:** FK actions (onDelete, onUpdate) and CHECK expressions are automatically validated against injection — invalid values throw immediately.
> **Tip:** Import validateFKAction / validateCheck from 'zero-http' for custom DDL validation outside the ORM.


### SQLite Adapter

The SQLite adapter uses better-sqlite3 for synchronous, high-performance file-based persistence. It auto-creates parent directories, ships with production-tuned PRAGMA defaults (WAL, 64 MB cache, memory-mapped I/O), and exposes utility methods for database maintenance. Ideal for single-server apps, prototyping, and embedded use cases.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `pragma` | `adapter.pragma(key)` | Read a single PRAGMA value (e.g. 'journal_mode' → 'wal'). |
| `checkpoint` | `adapter.checkpoint([mode])` | Force a WAL checkpoint. Modes: PASSIVE (default), FULL, RESTART, TRUNCATE. |
| `integrity` | `adapter.integrity()` | Run PRAGMA integrity_check. Returns 'ok' or a problem description. |
| `vacuum` | `adapter.vacuum()` | Rebuild the database file, reclaiming unused pages. |
| `fileSize` | `adapter.fileSize()` | Get the database file size in bytes. Returns 0 for in-memory databases. |
| `tables` | `adapter.tables()` | List all user-created table names. |
| `raw` | `adapter.raw(sql, ...params)` | Execute a raw SQL SELECT query with parameters. |
| `transaction` | `adapter.transaction(fn)` | Run a function inside a SQLite transaction. Auto-commits or rolls back. |
| `close` | `adapter.close()` | Close the database connection. |
| `columns` | `adapter.columns(table)` | Get column info: cid, name, type, notnull, defaultValue, pk. |
| `indexes` | `adapter.indexes(table)` | Get indexes: name, unique, and column names for each index. |
| `foreignKeys` | `adapter.foreignKeys(table)` | Get foreign keys: id, table, from, to, onUpdate, onDelete. |
| `tableStatus` | `adapter.tableStatus([table])` | Get row count per table. Omit table to get all tables. |
| `overview` | `adapter.overview()` | Database overview: all tables with row counts, total rows, and file size. |
| `pageInfo` | `adapter.pageInfo()` | Get page size, page count, and total bytes — helps estimate table overhead. |
| `compileOptions` | `adapter.compileOptions()` | Get the compile-time options that SQLite was built with. |
| `cacheStatus` | `adapter.cacheStatus()` | Get prepared statement cache stats: { cached, max }. |
| `addColumn` | `adapter.addColumn(table, col, def)` | Add a column to a table. def supports type, required, default, check, references. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column (SQLite 3.35+). |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column (SQLite 3.25+). |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Create an index. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Drop an index by name (table is ignored — indexes are schema-scoped in SQLite). |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns boolean. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns boolean. |
| `describeTable` | `adapter.describeTable(table)` | Get full table info: { columns, indexes, foreignKeys }. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `filename` | string | `':memory:'` | Path to the SQLite file, or ':memory:' for an in-memory database. |
| `readonly` | boolean | `false` | Open the database in read-only mode. |
| `fileMustExist` | boolean | `false` | Throw if the database file does not exist. |
| `createDir` | boolean | `true` | Auto-create parent directories for the database file. |
| `pragmas.journal_mode` | string | `'WAL'` | WAL mode enables concurrent reads/writes. Options: WAL, DELETE, TRUNCATE, MEMORY, OFF. |
| `pragmas.foreign_keys` | string | `'ON'` | Enforce foreign key constraints. |
| `pragmas.busy_timeout` | string | `'5000'` | Milliseconds to wait when the database is locked. |
| `pragmas.synchronous` | string | `'NORMAL'` | Sync mode: OFF, NORMAL, FULL, EXTRA. |
| `pragmas.cache_size` | string | `'-64000'` | Page cache size. Negative = KiB (e.g. -64000 = 64 MB). |
| `pragmas.temp_store` | string | `'MEMORY'` | Store temp tables in memory for speed. |
| `pragmas.mmap_size` | string | `'268435456'` | Memory-mapped I/O size (256 MB). |
| `pragmas.page_size` | string | `—` | Page size in bytes. Must be set before WAL is enabled. |
| `pragmas.auto_vacuum` | string | `—` | Auto-vacuum mode: NONE, FULL, INCREMENTAL. |
| `pragmas.secure_delete` | string | `—` | Overwrite deleted content with zeros. |
| `pragmas.wal_autocheckpoint` | string | `—` | Number of pages before WAL auto-checkpoint (default 1000). |
| `pragmas.locking_mode` | string | `—` | NORMAL or EXCLUSIVE locking. |


```js
const { Database, Model, TYPES } = require('zero-http')
const path = require('path')

// Production SQLite setup with Database/ folder
const db = Database.connect('sqlite', {
	filename: path.join(__dirname, 'Database', 'app.db'),
	// Pragmas are auto-applied with production defaults
	// Override any as needed:
	pragmas: {
		wal_autocheckpoint: '500',  // checkpoint every 500 pages
		secure_delete: 'ON',        // zero-fill deleted content
	}
})

// Access adapter utilities
const adapter = db.adapter
console.log(adapter.pragma('journal_mode'))  // 'wal'
console.log(adapter.tables())                // ['users', 'posts', ...]
console.log(adapter.fileSize())              // 49152 (bytes)
console.log(adapter.integrity())             // 'ok'

// Maintenance
adapter.checkpoint('TRUNCATE')  // reset WAL file
adapter.vacuum()                // reclaim free space

// Read-only replica
const replica = Database.connect('sqlite', {
	filename: path.join(__dirname, 'Database', 'app.db'),
	readonly: true,
	fileMustExist: true
})
```


> **Tip:** WAL mode (default) gives you concurrent reads while a single writer commits — ideal for web servers.
> **Tip:** cache_size of -64000 means 64 MB of page cache — enough for most applications.
> **Tip:** mmap_size of 256 MB uses memory-mapped I/O for fast reads on large databases.
> **Tip:** Use checkpoint('TRUNCATE') periodically to reset the WAL file size.
> **Tip:** integrity() is useful in health-check endpoints to verify database consistency.
> **Tip:** readonly mode is perfect for read replicas — prevents accidental writes.
> **Tip:** The adapter auto-creates parent directories — just point filename to 'Database/app.db'.
> **Tip:** overview() is a one-call dashboard — returns tables, row counts, total rows, and formatted file size.
> **Tip:** columns(table) + indexes(table) + foreignKeys(table) give you full schema introspection.
> **Tip:** cacheStatus() shows how many prepared statements are cached — helps tune stmtCacheSize.
> **Tip:** pageInfo() reveals the page size and count — useful for diagnosing storage overhead.


### MySQL Adapter

MySQL / MariaDB adapter using the mysql2 driver with connection pooling, prepared statements, and utility methods for introspection and maintenance. Supports SSL, custom charsets, timezone configuration, pool health monitoring, and built-in debug methods for table status, indexes, foreign keys, and server variables.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `raw` | `adapter.raw(sql, ...params)` | Execute a raw SQL SELECT query with parameterized inputs. Returns rows. |
| `exec` | `adapter.exec(sql, ...params)` | Execute a raw statement (INSERT, UPDATE, DDL). Returns { affectedRows, insertId }. |
| `tables` | `adapter.tables()` | List all tables in the current database. |
| `columns` | `adapter.columns(table)` | Get column info for a table (Field, Type, Null, Key, Default, Extra). |
| `databaseSize` | `adapter.databaseSize()` | Get total database size in bytes (data + indexes). |
| `poolStatus` | `adapter.poolStatus()` | Get pool stats: { total, idle, used, queued }. |
| `version` | `adapter.version()` | Get MySQL/MariaDB server version string. |
| `ping` | `adapter.ping()` | Ping the server. Returns true if healthy. |
| `transaction` | `adapter.transaction(fn)` | Run a function inside a transaction. Receives a connection object. Auto-commits/rollbacks. |
| `close` | `adapter.close()` | Close the connection pool. |
| `tableStatus` | `adapter.tableStatus([table])` | SHOW TABLE STATUS — name, engine, rows, dataLength, indexLength, totalSize, autoIncrement, collation, createTime, updateTime, comment. |
| `tableSize` | `adapter.tableSize(table)` | Human-readable table size: { rows, dataSize, indexSize, totalSize }. |
| `indexes` | `adapter.indexes(table)` | SHOW INDEX — name, column, unique, type, cardinality. |
| `tableCharset` | `adapter.tableCharset(table)` | Get charset and collation of a table. |
| `foreignKeys` | `adapter.foreignKeys(table)` | Get foreign keys: constraintName, column, referencedTable, referencedColumn, onDelete, onUpdate. |
| `overview` | `adapter.overview()` | Full database overview — all tables with size, rows, and formatted total size. |
| `variables` | `adapter.variables([filter])` | SHOW VARIABLES — optionally filtered with a LIKE pattern. |
| `processlist` | `adapter.processlist()` | SHOW PROCESSLIST — active connections: id, user, host, db, command, time, state, info. |
| `alterTable` | `adapter.alterTable(table, opts)` | Alter a table's engine, charset, or collation. opts: { engine, charset, collation }. |
| `addColumn` | `adapter.addColumn(table, col, def, [opts])` | Add a column. def: schema definition. opts: { after: 'col' } to position after a column. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column. |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Create an index. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Drop an index from a table. |
| `addForeignKey` | `adapter.addForeignKey(table, col, refTable, refCol, [opts])` | Add a FK constraint. opts: { name, onDelete, onUpdate }. |
| `dropForeignKey` | `adapter.dropForeignKey(table, name)` | Drop a FK constraint by name. |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns Promise<boolean>. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(table)` | Get detailed column info. Returns Promise<Array>. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | string | `'localhost'` | Server hostname or IP address. |
| `port` | number | `3306` | Server port. |
| `user` | string | `'root'` | Database user. |
| `password` | string | `''` | Database password. Validated as string on connect. |
| `database` | string | `—` | Database name (required). Validated as non-empty string. |
| `connectionLimit` | number | `10` | Maximum concurrent connections in the pool. |
| `waitForConnections` | boolean | `true` | Queue requests when all connections are busy. |
| `queueLimit` | number | `0` | Max queued requests (0 = unlimited). |
| `connectTimeout` | number | `10000` | Connection timeout in milliseconds. |
| `charset` | string | `'utf8mb4'` | Default character set (utf8mb4 for full emoji support). |
| `timezone` | string | `'Z'` | Session timezone. |
| `ssl` | string\|object | `—` | SSL profile name or TLS options object. |
| `multipleStatements` | boolean | `false` | Allow multiple statements per query (use with caution). |
| `decimalNumbers` | boolean | `false` | Return DECIMAL columns as JavaScript numbers instead of strings. |


```js
const { Database, Model, TYPES } = require('zero-http')

const db = Database.connect('mysql', {
	host: process.env.DB_HOST || 'localhost',
	port: Number(process.env.DB_PORT) || 3306,
	user: process.env.DB_USER || 'root',
	password: process.env.DB_PASS || '',
	database: process.env.DB_NAME,
	connectionLimit: 20,
	charset: 'utf8mb4',
})

// Health check endpoint
app.get('/health', async (req, res) => {
	const alive = await db.adapter.ping()
	const pool = db.adapter.poolStatus()
	const version = await db.adapter.version()
	res.json({ alive, pool, version })
})

// Introspection
const tables = await db.adapter.tables()    // ['users', 'posts', ...]
const cols = await db.adapter.columns('users') // [{ Field, Type, ... }]
const size = await db.adapter.databaseSize() // bytes

// Raw queries with parameterized inputs (safe from injection)
const users = await db.adapter.raw(
	'SELECT * FROM users WHERE role = ? AND active = ?',
	'admin', true
)

// DDL / write operations
await db.adapter.exec(
	'ALTER TABLE users ADD COLUMN bio TEXT'
)
```


> **Tip:** Always use environment variables for credentials — never hardcode passwords!
> **Tip:** connectionLimit of 10-20 is a safe default. Go higher only if you're seeing pool exhaustion.
> **Tip:** poolStatus() is perfect for monitoring dashboards — track idle vs used connections.
> **Tip:** Use charset: 'utf8mb4' (default) to support emojis and full Unicode.
> **Tip:** ping() is ideal for health check endpoints in load balancers.
> **Tip:** exec() is for writes that don't return rows — raw() is for SELECTs.
> **Tip:** Credentials are validated on Database.connect() — bad host/port/user types throw immediately.
> **Tip:** tableStatus() + tableSize() + indexes() give you a full database inspector.
> **Tip:** overview() returns all tables with sizes and row counts — one call for a dashboard view.
> **Tip:** variables('innodb%') filters server variables by pattern — great for tuning diagnostics.
> **Tip:** processlist() shows active queries — use it to spot slow queries and stuck connections.
> **Tip:** alterTable() lets you change engine/charset/collation live — e.g. migrate from MyISAM to InnoDB.
> **Tip:** createTable supports tableOptions: { engine, charset, collation, comment } for full control.


### PostgreSQL Adapter

PostgreSQL adapter using the pg driver with connection pooling, $1/$2 parameterized queries, JSONB support, and utility methods for schema introspection, pool monitoring, real-time LISTEN/NOTIFY, and built-in debug methods for table status, indexes, foreign keys, constraints, and server variables.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `raw` | `adapter.raw(sql, ...params)` | Execute a raw SQL SELECT query with $1-style params. Returns rows. |
| `exec` | `adapter.exec(sql, ...params)` | Execute a raw statement that doesn't return rows. Returns { rowCount }. |
| `tables` | `adapter.tables([schema])` | List all tables in a schema (default: 'public'). |
| `columns` | `adapter.columns(table, [schema])` | Get column info: column_name, data_type, is_nullable, column_default. |
| `databaseSize` | `adapter.databaseSize()` | Get total database size in bytes. |
| `tableSize` | `adapter.tableSize(table)` | Get total size of a table including indexes, in bytes. |
| `poolStatus` | `adapter.poolStatus()` | Get pool stats: { total, idle, waiting }. |
| `version` | `adapter.version()` | Get PostgreSQL server version string. |
| `ping` | `adapter.ping()` | Ping the server. Returns true if healthy. |
| `listen` | `adapter.listen(channel, callback)` | Subscribe to PG LISTEN/NOTIFY. Returns an unlisten function. |
| `transaction` | `adapter.transaction(fn)` | Run a function inside a transaction. Receives a client. Auto-commits/rollbacks. |
| `close` | `adapter.close()` | Close the connection pool. |
| `tableStatus` | `adapter.tableStatus([table])` | pg_stat_user_tables — name, rows, totalSize, dataSize, indexSize, sequentialScans, indexScans, liveTuples, deadTuples, lastVacuum, lastAnalyze. |
| `tableSizeFormatted` | `adapter.tableSizeFormatted(table)` | Human-readable table size: { rows, dataSize, indexSize, totalSize }. |
| `indexes` | `adapter.indexes(table)` | Get indexes: name, columns, unique, type, size. |
| `foreignKeys` | `adapter.foreignKeys(table)` | Get foreign keys: constraintName, column, referencedTable, referencedColumn, onDelete, onUpdate. |
| `overview` | `adapter.overview()` | Full database overview — all tables with sizes, row counts, and formatted total. |
| `variables` | `adapter.variables([filter])` | Get pg_settings — optionally filtered with a LIKE pattern. |
| `processlist` | `adapter.processlist()` | Active backends from pg_stat_activity: pid, user, database, state, query, duration. |
| `constraints` | `adapter.constraints(table)` | Get all table constraints: name, type (PRIMARY KEY, UNIQUE, CHECK, FK, EXCLUSION), definition. |
| `comments` | `adapter.comments(table)` | Get table comment and column comments: { tableComment, columns: [{ name, comment }] }. |
| `addColumn` | `adapter.addColumn(table, col, def)` | Add a column. def supports type, required, default, check, references. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column. |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Create an index. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Drop an index by name (table is ignored — indexes are schema-scoped in PostgreSQL). |
| `addForeignKey` | `adapter.addForeignKey(table, col, refTable, refCol, [opts])` | Add a FK constraint. opts: { name, onDelete, onUpdate }. |
| `dropForeignKey` | `adapter.dropForeignKey(table, name)` | Drop a FK constraint by name. |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns Promise<boolean>. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(table)` | Get column info with types, nullable, defaults, and PK flags. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | string | `'localhost'` | Server hostname. |
| `port` | number | `5432` | Server port. |
| `user` | string | `—` | Database user. Validated on connect. |
| `password` | string | `—` | Database password. Validated on connect. |
| `database` | string | `—` | Database name (required). Validated as non-empty. |
| `connectionString` | string | `—` | Full connection URI (overrides individual host/port/user/password). |
| `max` | number | `10` | Maximum pool size. |
| `idleTimeoutMillis` | number | `10000` | How long idle clients sit before being closed. |
| `connectionTimeoutMillis` | number | `0` | Timeout for establishing new connections (0 = no limit). |
| `ssl` | boolean\|object | `false` | Enable SSL or pass TLS options ({ rejectUnauthorized: false }). |
| `application_name` | string | `—` | Shows up in pg_stat_activity — great for identifying your app. |
| `statement_timeout` | number | `—` | Auto-cancel queries running longer than this (ms). |


```js
const { Database } = require('zero-http')

// Connection string style
const db = Database.connect('postgres', {
	connectionString: process.env.DATABASE_URL,
	ssl: { rejectUnauthorized: false }, // common on Heroku/Render
	max: 20,
	application_name: 'my-api',
	statement_timeout: 30000,
})

// Or individual options
const db2 = Database.connect('postgres', {
	host: 'localhost',
	port: 5432,
	user: 'postgres',
	password: process.env.PG_PASS,
	database: 'myapp',
})

// Health + monitoring
app.get('/health', async (req, res) => {
	const alive = await db.adapter.ping()
	const pool = db.adapter.poolStatus()  // { total, idle, waiting }
	const dbSize = await db.adapter.databaseSize()
	res.json({ alive, pool, dbSize })
})

// Schema introspection
const tables = await db.adapter.tables()           // ['users', 'posts']
const cols = await db.adapter.columns('users')     // [{ column_name, data_type, ... }]
const size = await db.adapter.tableSize('users')   // bytes

// Real-time LISTEN/NOTIFY
const unlisten = await db.adapter.listen('new_order', (msg) => {
	console.log('New order:', msg.payload)
})
// Later: await unlisten()

// Raw parameterized query ($1, $2 — safe from injection)
const admins = await db.adapter.raw(
	'SELECT * FROM users WHERE role = $1 AND active = $2',
	'admin', true
)
```


> **Tip:** Use connectionString for hosted databases (Heroku, Render, Supabase, Neon).
> **Tip:** application_name shows up in pg_stat_activity — makes debugging production queries a breeze.
> **Tip:** statement_timeout prevents runaway queries from hogging connections.
> **Tip:** LISTEN/NOTIFY is PostgreSQL's built-in pub/sub — great for real-time features without polling.
> **Tip:** PostgreSQL uses JSONB natively — the ORM maps TYPES.JSON to JSONB for indexable JSON columns.
> **Tip:** poolStatus().waiting > 0 means clients are queued — consider increasing max pool size.
> **Tip:** SERIAL PRIMARY KEY is auto-used for integer autoIncrement columns.
> **Tip:** tableStatus() + indexes() + foreignKeys() give you a full database inspector.
> **Tip:** overview() returns all tables with sizes and row counts — one call for a dashboard view.
> **Tip:** constraints(table) shows PRIMARY KEY, UNIQUE, CHECK, FK, and EXCLUSION constraints with definitions.
> **Tip:** comments(table) retrieves table and column comments — perfect for auto-generating documentation.
> **Tip:** processlist() shows active backends — use it to spot long-running queries in production.
> **Tip:** variables('work_mem') lets you inspect specific server settings for tuning.
> **Tip:** createTable supports tableOptions: { tablespace, unlogged, comment } and column-level references.


### MongoDB Adapter

MongoDB adapter using the official mongodb driver with connection pooling, automatic reconnection, index management, and utility methods for collection introspection and database stats. Maps the ORM's relational model to MongoDB documents with auto-increment IDs.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `raw` | `adapter.raw(command)` | Run a raw MongoDB command document. Returns the command result. |
| `collections` | `adapter.collections()` | List all collections in the database. |
| `stats` | `adapter.stats()` | Get database stats: { collections, objects, dataSize, storageSize, indexes, indexSize }. |
| `collectionStats` | `adapter.collectionStats(name)` | Get stats for a specific collection: { count, size, avgObjSize, storageSize, nindexes }. |
| `createIndex` | `adapter.createIndex(collection, keys, [opts])` | Create an index. keys: { email: 1 } for ascending. opts: { unique: true }. |
| `indexes` | `adapter.indexes(collection)` | List all indexes on a collection. |
| `dropIndex` | `adapter.dropIndex(collection, indexName)` | Drop a specific index by name. |
| `ping` | `adapter.ping()` | Ping the MongoDB server. Returns true if healthy. |
| `version` | `adapter.version()` | Get the MongoDB server version. |
| `isConnected` | `adapter.isConnected` | Property — true if currently connected. |
| `transaction` | `adapter.transaction(fn)` | Run operations in a transaction (requires replica set). Receives a session object. |
| `close` | `adapter.close()` | Close the connection. |
| `hasTable` | `adapter.hasTable(collection)` | Check if a collection exists. Returns Promise<boolean>. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a collection. |
| `addColumn` | `adapter.addColumn(collection, field, def)` | Add a field to all documents with a default value. |
| `dropColumn` | `adapter.dropColumn(collection, field)` | Remove a field from all documents. |
| `renameColumn` | `adapter.renameColumn(collection, old, new)` | Rename a field in all documents. |
| `hasColumn` | `adapter.hasColumn(collection, field)` | Check if a field exists in any document. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(collection, [sample])` | Infer schema by sampling documents. Returns [{ name, types }]. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | string | `'mongodb://127.0.0.1:27017'` | MongoDB connection string. Supports SRV: mongodb+srv://... |
| `database` | string | `—` | Database name (required). Validated on connect. |
| `maxPoolSize` | number | `10` | Maximum number of connections in the pool. |
| `minPoolSize` | number | `0` | Keep this many connections warm. |
| `connectTimeoutMS` | number | `10000` | Connection timeout. |
| `socketTimeoutMS` | number | `0` | Socket timeout (0 = no limit). |
| `serverSelectionTimeoutMS` | number | `30000` | Timeout for selecting a server from a replica set. |
| `retryWrites` | boolean | `true` | Retry write operations on transient errors. |
| `retryReads` | boolean | `true` | Retry read operations on transient errors. |
| `authSource` | string | `—` | Authentication database (default: the database name). |
| `replicaSet` | string | `—` | Replica set name (required for transactions). |
| `clientOptions` | object | `{}` | Extra MongoClient options passed directly to the driver. |


```js
const { Database, Model, TYPES } = require('zero-http')

const db = Database.connect('mongo', {
	url: process.env.MONGO_URI || 'mongodb://localhost:27017',
	database: 'myapp',
	maxPoolSize: 20,
})

// Health check
app.get('/health', async (req, res) => {
	const alive = await db.adapter.ping()
	const ver = await db.adapter.version()
	const s = await db.adapter.stats()
	res.json({ alive, version: ver, ...s })
})

// Introspection
const cols = await db.adapter.collections()  // ['users', 'posts']
const s = await db.adapter.collectionStats('users')
// { count: 1500, size: 245760, avgObjSize: 163, ... }

// Index management
await db.adapter.createIndex('users', { email: 1 }, { unique: true })
await db.adapter.createIndex('posts', { title: 'text' }) // full-text index
const idxs = await db.adapter.indexes('users')

// Transactions (replica set required)
await db.transaction(async (session) => {
	// Use session for operations that need ACID
})

// Connection status
console.log(db.adapter.isConnected) // true
```


> **Tip:** Use mongodb+srv:// connection strings for Atlas — handles DNS seedlists automatically.
> **Tip:** The ORM simulates auto-increment IDs for MongoDB — each insert finds the max(id) + 1.
> **Tip:** Transactions require a replica set — use 'rs.initiate()' in mongosh for local dev.
> **Tip:** createIndex with { unique: true } enforces uniqueness — like SQL UNIQUE constraints.
> **Tip:** Full-text search: createIndex(collection, { field: 'text' }) then query with $text.
> **Tip:** isConnected is a getter — it's a property, not a method (no parentheses).
> **Tip:** collectionStats().avgObjSize tells you the average document size — useful for capacity planning.


### Memory Adapter

Zero-dependency in-memory adapter — perfect for tests, prototyping, and ephemeral applications. All data lives in JavaScript Maps and arrays. Supports full CRUD, query builder, and utility methods for introspection, export/import, and cloning.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `tables` | `adapter.tables()` | List all registered table names. |
| `totalRows` | `adapter.totalRows()` | Count all rows across all tables. |
| `stats` | `adapter.stats()` | Get memory stats: { tables, totalRows, estimatedBytes }. |
| `toJSON` | `adapter.toJSON()` | Export all data as a plain object: { tableName: rows[], ... }. |
| `fromJSON` | `adapter.fromJSON(data)` | Import data from a plain object. Merges with existing data. |
| `clone` | `adapter.clone()` | Deep-copy the entire database state into a new MemoryAdapter. |
| `clear` | `adapter.clear()` | Delete all rows from all tables (tables remain registered). |
| `addColumn` | `adapter.addColumn(table, col, def)` | Add a column. Sets default value for existing rows. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column from all rows. |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column in schema and all rows. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Track an index in metadata. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Remove an index from metadata (table is ignored — searches all tables). |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns Promise<boolean>. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(table)` | Get column info from schema: name, type, nullable, defaultValue, primaryKey. |
| `indexes` | `adapter.indexes(table)` | Get tracked indexes: name, columns, unique. |


```js
const { Database, Model, TYPES } = require('zero-http')

const db = Database.connect('memory')

class User extends Model {
	static table = 'users'
	static schema = {
		id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		name: { type: TYPES.STRING, required: true },
	}
}

db.register(User)
await db.sync()

// Seed data for tests
await User.createMany([
	{ name: 'Alice' },
	{ name: 'Bob' },
	{ name: 'Charlie' },
])

// Introspection
console.log(db.adapter.tables())     // ['users']
console.log(db.adapter.totalRows())  // 3
console.log(db.adapter.stats())      // { tables: 1, totalRows: 3, estimatedBytes: ... }

// Snapshot & restore
const snapshot = db.adapter.toJSON()
// ... run tests that mutate data ...
await db.adapter.clear()
db.adapter.fromJSON(snapshot)  // restore!

// Independent clone for parallel testing
const fork = db.adapter.clone()
// fork has its own isolated copy of all data
```


> **Tip:** Memory adapter is the fastest — zero IO overhead, instant operations.
> **Tip:** Use toJSON() + fromJSON() to snapshot and restore state between tests.
> **Tip:** clone() creates a fully independent copy — mutations in one don't affect the other.
> **Tip:** clear() keeps table registrations but empties all rows — great for beforeEach() in tests.
> **Tip:** stats().estimatedBytes gives a rough size estimate — useful for memory-conscious apps.
> **Tip:** Data doesn't survive process restarts. For persistence, switch to JSON or SQLite.


### JSON Adapter

File-backed database adapter that persists data as JSON files on disk — one file per table. Zero-dependency, extends the Memory adapter with atomic writes, auto-flushing, backup support, and file management. Great for prototyping, small apps, and embedded scenarios.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `flush` | `adapter.flush()` | Immediately write all pending changes to disk. |
| `fileSize` | `adapter.fileSize()` | Get total size of all JSON files in bytes. |
| `compact` | `adapter.compact(table)` | Re-serialize and save a table's JSON file. |
| `backup` | `adapter.backup(destDir)` | Copy all JSON files to a target directory. |
| `directory` | `adapter.directory` | Property — the resolved path where JSON files are stored. |
| `hasPendingWrites` | `adapter.hasPendingWrites` | Property — true if there are unflushed writes. |
| `tables` | `adapter.tables()` | List all registered table names (inherited from Memory). |
| `stats` | `adapter.stats()` | Get stats: { tables, totalRows, estimatedBytes } (inherited from Memory). |
| `toJSON` | `adapter.toJSON()` | Export all data (inherited from Memory). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `dir` | string | `—` | Directory to store JSON files (required). Created automatically if needed. |
| `pretty` | boolean | `true` | Pretty-print JSON with 2-space indentation. |
| `flushInterval` | number | `50` | Debounce interval for writes in milliseconds. |
| `autoFlush` | boolean | `true` | Auto-write to disk. Set false for manual flush() control. |


```js
const { Database, Model, TYPES } = require('zero-http')
const path = require('path')

const db = Database.connect('json', {
	dir: path.join(__dirname, 'data'),
	pretty: true,      // human-readable files
	flushInterval: 100, // debounce writes to 100ms
})

class Note extends Model {
	static table = 'notes'
	static schema = {
		id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		title: { type: TYPES.STRING, required: true },
		body: { type: TYPES.TEXT },
	}
	static timestamps = true
}

db.register(Note)
await db.sync()

// CRUD works exactly like any other adapter
await Note.create({ title: 'Hello', body: 'World' })
// Creates data/notes.json on disk

// Backup before deployment
db.adapter.backup(path.join(__dirname, 'backups', Date.now().toString()))

// Monitor disk usage
console.log(db.adapter.fileSize())  // total bytes on disk
console.log(db.adapter.directory)   // '/path/to/data'

// Force immediate flush (useful before process.exit)
await db.adapter.flush()
```


> **Tip:** JSON files are human-readable — you can edit them manually in an emergency.
> **Tip:** Writes are atomic (tmp + rename) so you won't get corrupted files on crash.
> **Tip:** flushInterval debounces rapid writes — higher values = fewer disk writes.
> **Tip:** backup() is great for creating snapshots before risky operations.
> **Tip:** Set autoFlush: false and call flush() manually for batch-heavy operations.
> **Tip:** JSON adapter inherits ALL Memory adapter utilities (tables, stats, toJSON, fromJSON, clone).
> **Tip:** For more performance, switch to SQLite — it handles concurrent access much better.


### Model

The ORM base class — extend it to define your data models. Supports typed schemas with validation, timestamps, soft deletes, lifecycle hooks, hidden fields, reusable scopes, relationships (hasMany, hasOne, belongsTo, belongsToMany), and a full suite of CRUD operations.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `create` | `Model.create(data)` | Insert a new record. Runs validation and beforeCreate/afterCreate hooks. Returns Promise<Model>. |
| `createMany` | `Model.createMany([data, ...])` | Insert multiple records. Returns Promise<Model[]>. |
| `find` | `Model.find([conditions])` | Find all records matching conditions. Returns Promise<Model[]>. |
| `findOne` | `Model.findOne(conditions)` | Find a single record. Returns Promise<Model\|null>. |
| `findById` | `Model.findById(id)` | Find by primary key. Returns Promise<Model\|null>. |
| `findOrCreate` | `Model.findOrCreate(conditions, [defaults])` | Find or insert. Returns Promise<{ instance, created }>. |
| `exists` | `Model.exists([conditions])` | Check if any matching records exist. Returns Promise<boolean>. |
| `upsert` | `Model.upsert(conditions, data)` | Insert or update. Finds by conditions, creates with merged data if not found, updates if found. Returns Promise<{ instance, created }>. |
| `updateWhere` | `Model.updateWhere(conditions, data)` | Update all matching records. Returns Promise<number> (affected count). |
| `deleteWhere` | `Model.deleteWhere(conditions)` | Delete all matching records (respects softDelete). Returns Promise<number>. |
| `count` | `Model.count([conditions])` | Count matching records. Returns Promise<number>. |
| `query` | `Model.query()` | Start a fluent Query builder. See ORM → Query. |
| `scope` | `Model.scope(name, [...args])` | Start a query with a named scope applied. Returns Query. |
| `save` | `instance.save()` | Insert (if new) or update dirty fields (if persisted). Returns Promise<Model>. |
| `update` | `instance.update(data)` | Update specific fields on the instance. Returns Promise<Model>. |
| `delete` | `instance.delete()` | Delete the instance (soft or hard depending on softDelete setting). |
| `restore` | `instance.restore()` | Restore a soft-deleted instance (sets deletedAt to null). |
| `reload` | `instance.reload()` | Re-fetch the instance from the database. Returns Promise<Model>. |
| `toJSON` | `instance.toJSON()` | Return a plain object, excluding fields listed in static hidden. |
| `load` | `instance.load(relationName)` | Eagerly load a relationship. Sets instance[relationName]. Returns Promise. |
| `increment` | `instance.increment(field, [by])` | Increment a numeric field by amount (default 1). Saves immediately. |
| `decrement` | `instance.decrement(field, [by])` | Decrement a numeric field by amount (default 1). Saves immediately. |
| `hasMany` | `Model.hasMany(Related, foreignKey, [localKey])` | Define a one-to-many relationship. |
| `hasOne` | `Model.hasOne(Related, foreignKey, [localKey])` | Define a one-to-one relationship. |
| `belongsTo` | `Model.belongsTo(Related, foreignKey, [otherKey])` | Define an inverse belongs-to relationship. |
| `belongsToMany` | `Model.belongsToMany(Related, opts)` | Define a many-to-many relationship through a junction table. Options: { through, foreignKey, otherKey, localKey, relatedKey }. |
| `first` | `Model.first([conditions])` | Find the first record. Returns Promise<Model\|null>. |
| `last` | `Model.last([conditions])` | Find the last record (by PK descending). Returns Promise<Model\|null>. |
| `all` | `Model.all([conditions])` | Get all records (alias for find). Returns Promise<Model[]>. |
| `paginate` | `Model.paginate(page, [perPage], [conditions])` | Rich pagination: returns { data, total, page, perPage, pages, hasNext, hasPrev }. |
| `chunk` | `Model.chunk(size, fn, [conditions])` | Process all records in batches. fn(batch, batchIndex) — supports async. |
| `random` | `Model.random([conditions])` | Get a random record. Returns Promise<Model\|null>. |
| `pluck` | `Model.pluck(field, [conditions])` | Pluck values for a single column. Returns Promise<Array>. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `table` | string | `—` | Database table name (required). |
| `schema` | object | `—` | Column definitions with type, required, default, unique, primaryKey, autoIncrement, enum, min, max, minLength, maxLength, match, guarded, references, check, index, compositeKey, compositeUnique, compositeIndex. |
| `timestamps` | boolean | `false` | Auto-manage createdAt and updatedAt columns. |
| `softDelete` | boolean | `false` | Mark records as deleted (deletedAt) instead of removing them. Use .restore() to undelete. |
| `hooks` | object | `{}` | Lifecycle hooks: beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete. |
| `hidden` | string[] | `[]` | Fields excluded from toJSON() output. Use for passwords, tokens, internal IDs. |
| `scopes` | object | `{}` | Named reusable query conditions. Each scope is a function: (query, ...args) => query.where(...). |


```js
const { Model, TYPES } = require('zero-http')

class User extends Model {
	static table = 'users'
	static timestamps = true
	static softDelete = true
	static hidden = ['password', 'resetToken']
	static scopes = {
		active: (q) => q.where('active', true),
		role: (q, role) => q.where('role', role),
		recent: (q) => q.orderBy('createdAt', 'desc').limit(10)
	}
	static schema = {
		id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		name:     { type: TYPES.STRING, required: true, minLength: 2 },
		email:    { type: TYPES.STRING, required: true, unique: true },
		password: { type: TYPES.STRING, guarded: true },
		role:     { type: TYPES.STRING, enum: ['user', 'admin'], default: 'user' },
		logins:   { type: TYPES.INTEGER, default: 0 },
		active:   { type: TYPES.BOOLEAN, default: true }
	}
	static hooks = {
		beforeCreate: (data) => { data.email = data.email.toLowerCase() }
	}
}

// Static shortcuts — no query builder needed
const first = await User.first({ role: 'admin' })  // first admin
const last  = await User.last()                     // last user by PK
const all   = await User.all({ active: true })      // alias for find()
const pick  = await User.random()                   // random user
const names = await User.pluck('name')              // ['Alice','Bob',...]

// Pagination with rich metadata
const page = await User.paginate(2, 10, { active: true })
// { data: [...], total: 42, page: 2, perPage: 10, pages: 5, hasNext: true, hasPrev: true }

// Batch processing — never loads all records at once
await User.chunk(100, async (batch, i) => {
	console.log(`Processing batch ${i}: ${batch.length} users`)
})

// Scoped queries
const activeAdmins = await User.scope('active')
const recentAdmins = await User.scope('role', 'admin')

// Upsert — insert or update
const { instance, created } = await User.upsert(
	{ email: 'alice@example.com' },
	{ name: 'Alice', role: 'admin' }
)

// Increment/decrement
const user = await User.findById(1)
await user.increment('logins')      // logins + 1
await user.decrement('logins', 5)   // logins - 5

// toJSON respects hidden — no password leak
console.log(user.toJSON())
```


> **Tip:** Model.first/last/all/random/pluck are shortcuts — they build queries internally so you don't have to.
> **Tip:** Model.paginate() returns metadata (total, pages, hasNext, hasPrev) — perfect for REST API pagination endpoints.
> **Tip:** Model.chunk() processes large tables in batches — avoids loading millions of records into memory at once.
> **Tip:** static hidden = ['password'] prevents accidental password leaks in API responses.
> **Tip:** Scopes are the most powerful feature for DRY queries — define once, reuse everywhere.
> **Tip:** upsert() is atomic find-or-create-or-update — avoids race conditions in concurrent environments.
> **Tip:** increment/decrement save immediately — no need to call instance.save() after.
> **Tip:** guarded: true on a schema field prevents it from being set via mass-assignment (create/update with object).
> **Tip:** Hooks are great for data normalization (lowercase emails) and audit logging.
> **Tip:** belongsToMany requires a junction table name and the foreign keys for both sides.


### Query

Fluent query builder returned by Model.query(). All filter/sort/limit methods are chainable. Execute with .exec(), .first(), .count(), .exists(), .pluck(), or aggregates (sum/avg/min/max). Also thenable — you can await the query directly without calling .exec().

#### Selection

| Method | Signature | Description |
|---|---|---|
| `select` | `select(...fields)` | Select specific columns. Chainable. |
| `distinct` | `distinct()` | Return unique rows only. Chainable. |


#### Filtering

| Method | Signature | Description |
|---|---|---|
| `where` | `where(field, [op], value)` | Add a WHERE condition. Supports object form, (field, value), or (field, op, value). Operators: =, !=, >, <, >=, <=, LIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL. |
| `orWhere` | `orWhere(field, [op], value)` | Add an OR WHERE condition. Chainable. |
| `whereNull` | `whereNull(field)` | WHERE field IS NULL. Chainable. |
| `whereNotNull` | `whereNotNull(field)` | WHERE field IS NOT NULL. Chainable. |
| `whereIn` | `whereIn(field, values)` | WHERE field IN (...values). Chainable. |
| `whereNotIn` | `whereNotIn(field, values)` | WHERE field NOT IN (...values). Chainable. |
| `whereBetween` | `whereBetween(field, low, high)` | WHERE field BETWEEN low AND high. Chainable. |
| `whereNotBetween` | `whereNotBetween(field, low, high)` | WHERE field NOT BETWEEN low AND high. Chainable. |
| `whereLike` | `whereLike(field, pattern)` | WHERE field LIKE pattern (% and _ wildcards). Chainable. |
| `whereRaw` | `whereRaw(sql, ...params)` | Inject raw SQL WHERE clause (SQL adapters only). Parameterized. Chainable. |
| `withDeleted` | `withDeleted()` | Include soft-deleted records in results. Chainable. |
| `scope` | `scope(name, [...args])` | Apply a named scope from the model's static scopes. Chainable. |


#### Ordering & Pagination

| Method | Signature | Description |
|---|---|---|
| `orderBy` | `orderBy(field, [dir])` | Sort results. dir: 'asc' (default) or 'desc'. Chainable. |
| `orderByDesc` | `orderByDesc(field)` | Shorthand for orderBy(field, 'desc'). Chainable. |
| `limit` | `limit(n)` | Maximum number of results. Chainable. |
| `offset` | `offset(n)` | Skip n records. Chainable. |
| `page` | `page(pageNum, [perPage])` | Pagination helper. 1-indexed. perPage defaults to 20. Chainable. |
| `paginate` | `paginate(page, [perPage])` | Rich pagination: returns { data, total, page, perPage, pages, hasNext, hasPrev }. |


#### Grouping & Joins

| Method | Signature | Description |
|---|---|---|
| `groupBy` | `groupBy(...fields)` | Group results by columns. Chainable. |
| `having` | `having(field, [op], value)` | Add a HAVING condition (use with groupBy). Chainable. |
| `join` | `join(table, localKey, foreignKey)` | INNER JOIN. Chainable. |
| `leftJoin` | `leftJoin(table, localKey, foreignKey)` | LEFT JOIN. Chainable. |
| `rightJoin` | `rightJoin(table, localKey, foreignKey)` | RIGHT JOIN. Chainable. |


#### Execution

| Method | Signature | Description |
|---|---|---|
| `exec` | `exec()` | Execute the query. Returns Promise<Model[]>. |
| `first` | `first()` | Execute and return the first result. Returns Promise<Model\|null>. |
| `last` | `last()` | Execute and return the last result. Returns Promise<Model\|null>. |
| `count` | `count()` | Execute and return the count. Returns Promise<number>. |
| `exists` | `exists()` | Returns Promise<boolean> — true if any matching records exist. |
| `pluck` | `pluck(field)` | Returns Promise<Array> of values for a single column. |


#### Aggregates

| Method | Signature | Description |
|---|---|---|
| `sum` | `sum(field)` | Returns Promise<number> — sum of a numeric column. |
| `avg` | `avg(field)` | Returns Promise<number> — average of a numeric column. |
| `min` | `min(field)` | Returns Promise<*> — minimum value of a column. |
| `max` | `max(field)` | Returns Promise<*> — maximum value of a column. |


#### Functional Transforms

| Method | Signature | Description |
|---|---|---|
| `each` | `each(fn)` | Execute and iterate each result. fn(item, index) — supports async. |
| `map` | `map(fn)` | Execute, transform each result. Returns Promise<Array>. |
| `filter` | `filter(fn)` | Execute, post-filter results in JS. Returns Promise<Model[]>. |
| `reduce` | `reduce(fn, initial)` | Execute and reduce results to a single value. |
| `chunk` | `chunk(size, fn)` | Process results in batches. Calls fn(batch, batchIndex) for each chunk. |


#### Conditional & Debugging

| Method | Signature | Description |
|---|---|---|
| `when` | `when(condition, fn)` | Conditionally apply query logic if condition is truthy. Chainable. |
| `unless` | `unless(condition, fn)` | Conditionally apply query logic if condition is falsy. Chainable. |
| `tap` | `tap(fn)` | Inspect the query for debugging without breaking the chain. Chainable. |


#### LINQ Aliases

| Method | Signature | Description |
|---|---|---|
| `take` | `take(n)` | Alias for limit() — LINQ naming. Chainable. |
| `skip` | `skip(n)` | Alias for offset() — LINQ naming. Chainable. |
| `toArray` | `toArray()` | Alias for exec() — returns Promise<Model[]>. |
| `orderByDesc` | `orderByDesc(field)` | Shorthand for orderBy(field, 'desc'). Chainable. |
| `orderByDescending` | `orderByDescending(field)` | C# alias for orderByDesc(). Chainable. |
| `firstOrDefault` | `firstOrDefault()` | Alias for first() — returns null on empty (JS default). |
| `lastOrDefault` | `lastOrDefault()` | Alias for last() — returns null on empty. |
| `average` | `average(field)` | Alias for avg() — C# naming. |
| `aggregate` | `aggregate(fn, seed)` | Alias for reduce() — C# Aggregate naming. |


#### LINQ Element Operators

| Method | Signature | Description |
|---|---|---|
| `single` | `single()` | Returns the only element. Throws if count !== 1. |
| `singleOrDefault` | `singleOrDefault()` | Returns the only element or null. Throws if more than one. |
| `elementAt` | `elementAt(index)` | Get element at 0-based index. Throws if out of range. |
| `elementAtOrDefault` | `elementAtOrDefault(index)` | Get element at index, or null if out of range. |
| `defaultIfEmpty` | `defaultIfEmpty(value)` | Returns results, or [value] if the sequence is empty. |


#### LINQ Quantifiers

| Method | Signature | Description |
|---|---|---|
| `any` | `any(predicate?)` | True if any elements match. Without predicate, same as exists(). |
| `all` | `all(predicate)` | True if all elements satisfy the predicate. |
| `contains` | `contains(field, value)` | True if any record has the given value for a column. |
| `sequenceEqual` | `sequenceEqual(other, compareFn?)` | True if both sequences have the same elements in the same order. |


#### LINQ Ordering

| Method | Signature | Description |
|---|---|---|
| `thenBy` | `thenBy(field)` | Add secondary ascending sort. Chainable. |
| `thenByDescending` | `thenByDescending(field)` | Add secondary descending sort. Chainable. |


#### LINQ Set Operations

| Method | Signature | Description |
|---|---|---|
| `concat` | `concat(other)` | Append results from another query or array. |
| `union` | `union(other, keyFn?)` | Distinct union of two result sets. |
| `intersect` | `intersect(other, keyFn?)` | Elements common to both result sets. |
| `except` | `except(other, keyFn?)` | Elements in this set but not in other. |


#### LINQ Projection

| Method | Signature | Description |
|---|---|---|
| `selectMany` | `selectMany(fn)` | FlatMap — project each element to an array and flatten. |
| `zip` | `zip(other, fn)` | Combine two result sets element-wise using fn(a, b). |
| `toDictionary` | `toDictionary(keyFn, valueFn?)` | Convert results to a Map keyed by selector. Throws on duplicate keys. |
| `toLookup` | `toLookup(keyFn)` | Group results into a Map of arrays keyed by selector. |


#### LINQ Partitioning

| Method | Signature | Description |
|---|---|---|
| `takeWhile` | `takeWhile(predicate)` | Take elements while predicate returns true. |
| `skipWhile` | `skipWhile(predicate)` | Skip elements while predicate returns true, then return the rest. |


#### LINQ Transforms

| Method | Signature | Description |
|---|---|---|
| `reverse` | `reverse()` | Reverse the result order. |
| `append` | `append(...items)` | Append items to the end of results. |
| `prepend` | `prepend(...items)` | Prepend items to the beginning of results. |
| `distinctBy` | `distinctBy(keyFn)` | Distinct results by a key selector. |


#### LINQ Aggregate Selectors

| Method | Signature | Description |
|---|---|---|
| `minBy` | `minBy(fn)` | Element with the minimum value from a selector. |
| `maxBy` | `maxBy(fn)` | Element with the maximum value from a selector. |
| `sumBy` | `sumBy(fn)` | Sum using a value selector function. |
| `averageBy` | `averageBy(fn)` | Average using a value selector function. |
| `countBy` | `countBy(keyFn)` | Count elements per group, returns Map<key, count>. |


```js
// Filtering with negation
const results = await User.query()
	.whereNotIn('role', ['banned', 'suspended'])
	.whereNotBetween('age', 0, 12)
	.whereLike('email', '%@gmail.com')
	.orderBy('name')
	.exec()

// Scoped queries (chainable)
const activeAdmins = await User.query()
	.scope('active')
	.scope('role', 'admin')
	.orderBy('name')
	.exec()

// Aggregates
const avgAge = await User.query().avg('age')
const revenue = await Order.query().where('status', 'paid').sum('total')
const maxPrice = await Product.query().max('price')
const count = await User.query().where('role', 'admin').count()

// LINQ-style aliases
const top5 = await User.query().orderByDesc('score').take(5)
const page3 = await User.query().skip(40).take(20)
const oldest = await User.query().orderBy('age').last()

// LINQ element operators
const onlyAdmin = await User.query().where('email', 'admin@co.com').single()
const third = await User.query().orderBy('id').elementAt(2)
const fallback = await User.query().where('role', 'owner').defaultIfEmpty({ name: 'N/A' })

// LINQ quantifiers
const hasAdmins = await User.query().where('role', 'admin').any()
const allAdults = await User.query().all(u => u.age >= 18)
const hasAlice = await User.query().contains('name', 'Alice')

// LINQ ordering with secondary sorts
const sorted = await User.query()
	.orderBy('role').thenByDescending('score').toArray()

// LINQ set operations
const admins = User.query().where('role', 'admin')
const seniors = User.query().where('age', '>=', 50)
const both = await admins.intersect(seniors, u => u.id)
const onlyAdmins = await admins.except(seniors, u => u.id)

// LINQ projection
const tags = await Post.query().selectMany(p => p.tags)
const byRole = await User.query().toLookup(u => u.role)
const idMap = await User.query().toDictionary(u => u.id)

// LINQ partitioning
const while18 = await User.query().orderBy('age').takeWhile(u => u.age < 21)
const after18 = await User.query().orderBy('age').skipWhile(u => u.age < 18)

// LINQ aggregate selectors
const youngest = await User.query().minBy(u => u.age)
const topScorer = await User.query().maxBy(u => u.score)
const totalScore = await User.query().sumBy(u => u.score)
const roleCounts = await User.query().countBy(u => u.role)

// Conditional query building (perfect for API endpoints)
const users = await User.query()
	.when(req.query.role, q => q.where('role', req.query.role))
	.when(req.query.minAge, q => q.where('age', '>=', req.query.minAge))
	.unless(req.query.showAll, q => q.limit(50))
	.tap(q => console.log('Query:', q.build()))

// Rich pagination with metadata
const result = await User.query()
	.where('active', true)
	.paginate(2, 10)
// { data: [...], total: 53, page: 2, perPage: 10,
//   pages: 6, hasNext: true, hasPrev: true }

// Batch processing for large datasets
await User.query().chunk(100, async (batch, i) => {
	console.log(`Batch ${i}: ${batch.length} users`)
	for (const u of batch) await u.update({ migrated: true })
})

// Functional transforms
const names = await User.query().map(u => u.name)
const filteredAdmins = await User.query().filter(u => u.role === 'admin')
const totalAge = await User.query().reduce((sum, u) => sum + u.age, 0)
```


> **Tip:** Queries are thenable — 'await User.query().where(...)' works without calling .exec().
> **Tip:** take() and skip() are LINQ aliases for limit() and offset() — use whichever feels natural.
> **Tip:** single() vs first(): single() throws if there isn't exactly one result — use it for unique lookups.
> **Tip:** any()/all() accept optional predicates for post-execution checks, or use any() without args like exists().
> **Tip:** thenBy()/thenByDescending() add secondary sorts — chain after orderBy() for multi-column ordering.
> **Tip:** Set operations (union/intersect/except) accept a keyFn for custom equality — defaults to JSON comparison.
> **Tip:** toDictionary() throws on duplicate keys — use toLookup() when keys aren't unique.
> **Tip:** takeWhile()/skipWhile() operate on ordered results — always pair with orderBy() for deterministic output.
> **Tip:** minBy()/maxBy() return the full element, not just the value — great for 'find the user with highest score'.
> **Tip:** countBy() returns a Map — perfect for quick grouping like countBy(u => u.role).
> **Tip:** when() is a game-changer for API endpoints — conditionally apply filters based on request params.
> **Tip:** tap() is perfect for debugging — inspect the query state without breaking the chain.
> **Tip:** paginate() returns everything you need for pagination UI: total, pages, hasNext, hasPrev.
> **Tip:** chunk() processes large datasets in batches — no memory explosion on million-row tables.
> **Tip:** map/filter/reduce work like Array methods but on query results — great for transformations.


### Schema DDL

Advanced schema options for DDL generation. Define foreign keys, CHECK constraints, indexes, composite primary keys, composite unique constraints, and composite indexes directly in your schema — the ORM generates the correct DDL for every adapter. Sync ordering is automatic: tables with foreign key references are created after their targets.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `references` | object | `—` | Foreign key: { table, column, onDelete, onUpdate }. Generates REFERENCES clause in SQL. onDelete/onUpdate accept CASCADE, SET NULL, RESTRICT, NO ACTION. |
| `check` | string | `—` | SQL CHECK constraint expression. e.g. '"price" > 0'. Applied inline on the column. |
| `index` | boolean\|string | `false` | Create a single-column index. true = auto-named, string = custom index name. e.g. index: 'idx_users_email'. |
| `compositeKey` | boolean | `false` | Mark as part of a composite primary key. Set primaryKey: true and compositeKey: true on each column. |
| `compositeUnique` | string | `—` | Group columns into a composite UNIQUE constraint. Columns with the same string value form one constraint. |
| `compositeIndex` | string | `—` | Group columns into a composite index. Columns with the same string value form one multi-column index. |
| `guarded` | boolean | `false` | Prevent mass-assignment of this field via create/update. Must be set explicitly on the instance. |


```js
const { Database, Model, TYPES } = require('zero-http')

// Foreign Keys — CASCADE delete from parent removes children
class Post extends Model {
	static table = 'posts'
	static schema = {
		id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		title:    { type: TYPES.STRING, required: true, index: true },
		authorId: {
			type: TYPES.INTEGER, required: true,
			references: { table: 'users', column: 'id', onDelete: 'CASCADE' }
		},
		status: { type: TYPES.STRING, check: '"status" IN (\'draft\', \'published\', \'archived\')' },
	}
}

// Composite Primary Key — junction table for many-to-many
class Enrollment extends Model {
	static table = 'enrollments'
	static schema = {
		studentId: { type: TYPES.INTEGER, primaryKey: true, compositeKey: true,
			references: { table: 'students', column: 'id', onDelete: 'CASCADE' } },
		courseId:  { type: TYPES.INTEGER, primaryKey: true, compositeKey: true,
			references: { table: 'courses', column: 'id', onDelete: 'CASCADE' } },
		grade: { type: TYPES.STRING },
		enrolledAt: { type: TYPES.DATETIME },
	}
}

// Composite Unique + Composite Index
class UserRole extends Model {
	static table = 'user_roles'
	static schema = {
		id:     { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		userId: { type: TYPES.INTEGER, compositeUnique: 'user_role',
			compositeIndex: 'user_lookup' },
		role:   { type: TYPES.STRING, compositeUnique: 'user_role' },
		orgId:  { type: TYPES.INTEGER, compositeIndex: 'user_lookup' },
	}
}

// Migrations — evolve your schema after deployment
const db = Database.connect('sqlite', { filename: 'app.db' })

// Add a column
await db.addColumn('users', 'bio', { type: TYPES.TEXT, default: '' })

// Create an index
await db.createIndex('users', ['email'], { name: 'idx_email', unique: true })

// Rename a column
await db.renameColumn('users', 'bio', 'biography')

// Check if table/column exists before migrating
if (await db.hasTable('users') && !await db.hasColumn('users', 'avatar')) {
	await db.addColumn('users', 'avatar', { type: TYPES.STRING })
}

// Introspect existing schema
const info = await db.describeTable('users')
console.log(info)
```


> **Tip:** references generates real FK constraints in SQL — enforced at the database level, not just app level.
> **Tip:** db.sync() automatically creates referenced tables first (topological ordering).
> **Tip:** compositeKey: true creates a multi-column PRIMARY KEY — perfect for junction tables.
> **Tip:** compositeUnique groups columns into a single UNIQUE constraint — e.g. (userId, role) must be unique together.
> **Tip:** compositeIndex groups columns into a single multi-column index — speeds up queries filtering on both columns.
> **Tip:** check constraints are raw SQL expressions — use double-quoted column names for portability.
> **Tip:** Migration methods (addColumn, dropColumn, renameColumn) work on all adapters including memory.
> **Tip:** hasTable/hasColumn are essential before running migrations — check before you change.
> **Tip:** describeTable returns adapter-specific column metadata — columns, types, defaults, and PK flags.
> **Tip:** The memory adapter enforces unique and compositeUnique constraints at insert time — throws on duplicates.
> **Tip:** MongoDB adapter uses JSON Schema validation and unique indexes from schema definitions.


### TYPES

Column type constants for defining model schemas. Each type maps to the appropriate native type in the target database adapter.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `STRING` | const | `'string'` | Variable-length string (VARCHAR). |
| `INTEGER` | const | `'integer'` | Whole number (INT). |
| `FLOAT` | const | `'float'` | Floating-point number (REAL/DOUBLE). |
| `BOOLEAN` | const | `'boolean'` | True/false (BOOLEAN/TINYINT). |
| `DATE` | const | `'date'` | Date without time. |
| `DATETIME` | const | `'datetime'` | Date with time (TIMESTAMP). |
| `JSON` | const | `'json'` | JSON column (auto-serialize/deserialize). PostgreSQL maps to JSONB. |
| `TEXT` | const | `'text'` | Large text field (TEXT/CLOB). |
| `BLOB` | const | `'blob'` | Binary data (BLOB/BYTEA). |
| `UUID` | const | `'uuid'` | UUID string. Can auto-generate with default: () => crypto.randomUUID(). |
| `BIGINT` | const | `'bigint'` | 64-bit integer (BIGINT). |
| `SMALLINT` | const | `'smallint'` | 16-bit integer (SMALLINT). |
| `TINYINT` | const | `'tinyint'` | 8-bit integer (TINYINT in MySQL, SMALLINT in PG). |
| `DECIMAL` | const | `'decimal'` | Fixed-precision number. Use precision/scale in schema: { precision: 10, scale: 2 }. |
| `DOUBLE` | const | `'double'` | Double-precision float (DOUBLE / DOUBLE PRECISION). |
| `REAL` | const | `'real'` | Single-precision float (REAL). |
| `CHAR` | const | `'char'` | Fixed-length string. Use length in schema: { length: 10 }. |
| `BINARY` | const | `'binary'` | Fixed-length binary. Use length in schema. |
| `VARBINARY` | const | `'varbinary'` | Variable-length binary. Use length in schema. |
| `TIMESTAMP` | const | `'timestamp'` | Timestamp with time zone (TIMESTAMPTZ in PG). |
| `TIME` | const | `'time'` | Time without date. |
| `ENUM` | const | `'enum'` | MySQL ENUM. Define values: { enum: ['admin', 'user', 'guest'] }. |
| `SET` | const | `'set'` | MySQL SET (multi-value). Define values: { values: ['read', 'write', 'delete'] }. |
| `MEDIUMTEXT` | const | `'mediumtext'` | MySQL medium text (16 MB max). |
| `LONGTEXT` | const | `'longtext'` | MySQL long text (4 GB max). |
| `MEDIUMBLOB` | const | `'mediumblob'` | MySQL medium blob (16 MB max). |
| `LONGBLOB` | const | `'longblob'` | MySQL long blob (4 GB max). |
| `YEAR` | const | `'year'` | MySQL YEAR type (4-digit year). |
| `SERIAL` | const | `'serial'` | PostgreSQL auto-incrementing integer. |
| `BIGSERIAL` | const | `'bigserial'` | PostgreSQL auto-incrementing 64-bit integer. |
| `JSONB` | const | `'jsonb'` | PostgreSQL binary JSON (indexable, faster queries). |
| `INTERVAL` | const | `'interval'` | PostgreSQL time interval. |
| `INET` | const | `'inet'` | PostgreSQL IPv4/IPv6 address. |
| `CIDR` | const | `'cidr'` | PostgreSQL CIDR network address. |
| `MACADDR` | const | `'macaddr'` | PostgreSQL MAC address. |
| `MONEY` | const | `'money'` | PostgreSQL money type. |
| `XML` | const | `'xml'` | PostgreSQL XML type. |
| `CITEXT` | const | `'citext'` | PostgreSQL case-insensitive text (requires extension). |
| `ARRAY` | const | `'array'` | PostgreSQL array. Use arrayOf in schema: { arrayOf: 'TEXT' }. |
| `NUMERIC` | const | `'numeric'` | SQLite NUMERIC affinity. Maps to REAL/INTEGER based on value. |


```js
const { TYPES } = require('zero-http')

static schema = {
	id:        { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
	uuid:      { type: TYPES.UUID, default: () => crypto.randomUUID() },
	name:      { type: TYPES.STRING, required: true, minLength: 2, maxLength: 100 },
	bio:       { type: TYPES.TEXT },
	age:       { type: TYPES.INTEGER, min: 0, max: 150 },
	score:     { type: TYPES.FLOAT, default: 0.0 },
	active:    { type: TYPES.BOOLEAN, default: true },
	birthday:  { type: TYPES.DATE },
	loginAt:   { type: TYPES.DATETIME },
	settings:  { type: TYPES.JSON, default: {} },
	avatar:    { type: TYPES.BLOB },
	price:     { type: TYPES.DECIMAL, precision: 10, scale: 2 },
	role:      { type: TYPES.ENUM, enum: ['admin', 'user', 'guest'] },
	perms:     { type: TYPES.SET, values: ['read', 'write', 'delete'] },
	tags:      { type: TYPES.ARRAY, arrayOf: 'TEXT' },
	ip:        { type: TYPES.INET },
	code:      { type: TYPES.CHAR, length: 6 }
}
```



---

## Real-Time

### WebSocket

Built-in RFC 6455 WebSocket server. Register handlers with app.ws(path, handler). Each connection receives a WebSocketConnection instance with send/receive, ping/pong, binary support, and event emitter methods. Configure max payload size, ping intervals, and client verification.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `send` | `ws.send(data)` | Send a text or binary message. |
| `sendJSON` | `ws.sendJSON(obj)` | Send a JSON-serialized message. |
| `ping` | `ws.ping([data])` | Send a ping frame. |
| `pong` | `ws.pong([data])` | Send a pong frame. |
| `close` | `ws.close([code], [reason])` | Graceful close with optional status code and reason. |
| `terminate` | `ws.terminate()` | Forcefully close the connection. |
| `on` | `ws.on(event, handler)` | Listen for events: message, close, error, ping, pong, drain. |
| `once` | `ws.once(event, handler)` | Listen for an event once. |
| `off` | `ws.off(event, handler)` | Remove an event listener. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPayload` | number | `1048576 (1MB)` | Maximum incoming message size in bytes. |
| `pingInterval` | number | `30000` | Automatic ping interval in ms (0 to disable). |
| `verifyClient` | function | `—` | Verification function: (req) => boolean. Return false to reject. |


```js
const { createApp } = require('zero-http')
const app = createApp()

const clients = new Set()

app.ws('/chat', {
	maxPayload: 64 * 1024,
	pingInterval: 20000
}, (ws, req) => {
	ws.data.name = req.query.name || 'anon'
	clients.add(ws)
	ws.send('Welcome, ' + ws.data.name + '!')

	ws.on('message', msg => {
		for (const c of clients) {
			if (c !== ws && c.readyState === 1)
				c.send(ws.data.name + ': ' + msg)
		}
	})

	ws.on('close', () => clients.delete(ws))
})

app.listen(3000)
```


> **Tip:** ws.data is a plain object for storing per-connection user data (name, auth, etc.).
> **Tip:** Check ws.readyState === 1 (OPEN) before sending to avoid errors.
> **Tip:** Use verifyClient to enforce authentication before accepting the upgrade.
> **Tip:** Properties: id, readyState, protocol, extensions, headers, ip, query, url, secure, connectedAt, uptime, bufferedAmount.


### WebSocketPool

Connection and room manager for WebSocket apps. Automatically tracks connections, manages room membership, supports broadcast/targeted messaging, and cleans up on disconnect.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `add` | `pool.add(ws)` | Add a connection to the pool. Auto-removed on close. |
| `remove` | `pool.remove(ws)` | Remove a connection from the pool and all rooms. |
| `join` | `pool.join(ws, room)` | Join a connection to a named room. |
| `leave` | `pool.leave(ws, room)` | Leave a room. |
| `broadcast` | `pool.broadcast(msg, [exclude])` | Send to all connections. |
| `broadcastJSON` | `pool.broadcastJSON(obj, [exclude])` | Send JSON to all connections. |
| `toRoom` | `pool.toRoom(room, msg, [exclude])` | Send to all in a room. |
| `toRoomJSON` | `pool.toRoomJSON(room, obj, [exclude])` | Send JSON to all in a room. |
| `in` | `pool.in(room)` | Get all connections in a room. |
| `roomsOf` | `pool.roomsOf(ws)` | Get all rooms a connection is in. |
| `closeAll` | `pool.closeAll()` | Close all connections. |
| `size` | `pool.size` | Total connection count. |
| `clients` | `pool.clients` | All connections as an iterable. |
| `rooms` | `pool.rooms` | Array of all room names. |
| `roomSize` | `pool.roomSize(room)` | Number of connections in a room. |


```js
const { createApp, WebSocketPool } = require('zero-http')
const app = createApp()
const pool = new WebSocketPool()

app.ws('/chat', (ws, req) => {
	const room = req.query.room || 'general'
	pool.add(ws)         // auto-removed on close
	pool.join(ws, room)

	ws.data.name = req.query.name || 'anon'
	pool.toRoomJSON(room, { type: 'join', user: ws.data.name }, ws)

	ws.on('message', msg => {
		pool.toRoom(room, ws.data.name + ': ' + msg, ws)
	})

	ws.on('close', () => {
		pool.toRoomJSON(room, { type: 'leave', user: ws.data.name })
	})
})

app.get('/pool/status', (req, res) => res.json({
	connections: pool.size,
	rooms: pool.rooms,
	roomSizes: pool.rooms.reduce((o, r) => (o[r] = pool.roomSize(r), o), {})
}))
```


### SSE (Server-Sent Events)

Push real-time events to browser clients via res.sse(). Returns an SSEStream instance with auto-IDs, named events, keep-alive pings, and graceful disconnect handling. The browser connects with new EventSource(url).

#### Methods

| Method | Signature | Description |
|---|---|---|
| `send` | `sse.send(data)` | Send a data-only event. |
| `sendJSON` | `sse.sendJSON(obj)` | Send a JSON-serialized event. |
| `event` | `sse.event(name, data)` | Send a named event. Browser listens with es.addEventListener(name, ...). |
| `comment` | `sse.comment(text)` | Send a comment line (not received by EventSource). |
| `retry` | `sse.retry(ms)` | Set the reconnection interval for the client. |
| `keepAlive` | `sse.keepAlive(ms)` | Start sending periodic comment pings. |
| `flush` | `sse.flush()` | Flush the response stream. |
| `close` | `sse.close()` | Close the SSE stream. |
| `on` | `sse.on(event, handler)` | Listen for events: close, error. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `status` | number | `200` | HTTP status code. |
| `retry` | number | `—` | Initial reconnection interval in ms. |
| `keepAlive` | number | `0` | Keep-alive ping interval in ms (0 = disabled). |
| `keepAliveComment` | string | `'ping'` | Comment text for keep-alive pings. |
| `autoId` | boolean | `false` | Auto-generate incrementing event IDs. |
| `startId` | number | `1` | Starting ID for autoId. |
| `pad` | number | `0` | Pad the response with whitespace for proxy compatibility. |
| `headers` | object | `{}` | Extra response headers. |


```js
const { createApp } = require('zero-http')
const app = createApp()

app.get('/events', (req, res) => {
	const sse = res.sse({
		retry: 5000,
		autoId: true,
		keepAlive: 30000
	})

	sse.send('connected')

	const iv = setInterval(() => {
		sse.event('tick', { time: Date.now() })
	}, 1000)

	sse.on('close', () => {
		clearInterval(iv)
		console.log('client disconnected')
	})
})

// Browser:
// const es = new EventSource('/events')
// es.addEventListener('tick', e => console.log(JSON.parse(e.data)))
```


> **Tip:** SSE is automatically excluded from response compression.
> **Tip:** Use keepAlive to prevent proxy/load-balancer timeouts on idle connections.
> **Tip:** Properties: connected, eventCount, bytesSent, connectedAt, uptime, lastEventId, data (user store).



---

## fetch

Built-in HTTP/HTTPS client for server-side requests. Returns a Response-like object with ok, status, json(), text(), arrayBuffer(). Supports timeouts, abort signals, upload/download progress tracking, automatic JSON body serialization, and custom TLS options for HTTPS URLs.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `ok` | `res.ok` | true if status is 200-299. |
| `status` | `res.status` | HTTP status code. |
| `statusText` | `res.statusText` | HTTP status text. |
| `secure` | `res.secure` | true if the request was over HTTPS. |
| `url` | `res.url` | Final URL after redirects. |
| `headers.get` | `res.headers.get(name)` | Get a response header value. |
| `text` | `res.text()` | Read body as text. Returns Promise<string>. |
| `json` | `res.json()` | Read body as parsed JSON. Returns Promise<any>. |
| `arrayBuffer` | `res.arrayBuffer()` | Read body as ArrayBuffer. Returns Promise<ArrayBuffer>. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `method` | string | `'GET'` | HTTP method. |
| `headers` | object | `{}` | Request headers. |
| `body` | string \| Buffer \| object | `—` | Request body. Objects are auto-serialized to JSON. |
| `timeout` | number | `—` | Request timeout in milliseconds. |
| `signal` | AbortSignal | `—` | AbortController signal for cancellation. |
| `onDownloadProgress` | function | `—` | Progress callback: ({ loaded, total }) => {}. |
| `onUploadProgress` | function | `—` | Upload progress callback. |
| `rejectUnauthorized` | boolean | `true` | TLS: reject self-signed certs. |
| `ca` | string \| Buffer | `—` | TLS: custom CA certificate. |
| `cert` | string \| Buffer | `—` | TLS: client certificate. |
| `key` | string \| Buffer | `—` | TLS: client private key. |


```js
const { fetch } = require('zero-http')

async function download(url) {
	const controller = new AbortController()
	setTimeout(() => controller.abort(), 10000)

	const res = await fetch(url, {
		timeout: 5000,
		signal: controller.signal,
		rejectUnauthorized: false,  // accept self-signed certs
		onDownloadProgress: ({ loaded, total }) =>
			console.log(`${loaded}/${total || '?'} bytes`)
	})

	console.log(res.ok, res.status, res.secure, res.url)
	const data = await res.json()
	return data
}

download('https://jsonplaceholder.typicode.com/todos/1')
	.then(console.log)
```


> **Tip:** Object bodies are auto-serialized to JSON and Content-Type is set automatically.
> **Tip:** Use rejectUnauthorized: false only for development — never in production.
> **Tip:** Timeout and AbortSignal can be used together — whichever fires first cancels the request.


---

## Error Handling

### Error Classes

Built-in HTTP error classes with status codes, machine-readable codes, and optional details. Every error extends HttpError which carries statusCode, code, and details. Throw them in route handlers — the router catches and sends the correct HTTP response automatically.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `HttpError` | `new HttpError(statusCode, [message], [opts])` | Base class. opts: { code, details }. |
| `BadRequestError` | `new BadRequestError([message], [opts])` | 400 Bad Request. |
| `UnauthorizedError` | `new UnauthorizedError([message], [opts])` | 401 Unauthorized. |
| `ForbiddenError` | `new ForbiddenError([message], [opts])` | 403 Forbidden. |
| `NotFoundError` | `new NotFoundError([message], [opts])` | 404 Not Found. |
| `MethodNotAllowedError` | `new MethodNotAllowedError([message], [opts])` | 405 Method Not Allowed. |
| `ConflictError` | `new ConflictError([message], [opts])` | 409 Conflict. |
| `GoneError` | `new GoneError([message], [opts])` | 410 Gone. |
| `PayloadTooLargeError` | `new PayloadTooLargeError([message], [opts])` | 413 Payload Too Large. |
| `UnprocessableEntityError` | `new UnprocessableEntityError([message], [opts])` | 422 Unprocessable Entity. |
| `ValidationError` | `new ValidationError([message], [errors], [opts])` | 422 with field-level errors. errors: object or array stored in .errors and .details. |
| `TooManyRequestsError` | `new TooManyRequestsError([message], [opts])` | 429 Too Many Requests. |
| `InternalError` | `new InternalError([message], [opts])` | 500 Internal Server Error. |
| `NotImplementedError` | `new NotImplementedError([message], [opts])` | 501 Not Implemented. |
| `BadGatewayError` | `new BadGatewayError([message], [opts])` | 502 Bad Gateway. |
| `ServiceUnavailableError` | `new ServiceUnavailableError([message], [opts])` | 503 Service Unavailable. |
| `createError` | `createError(statusCode, [message], [opts])` | Factory — creates the correct error class for any status code. |
| `isHttpError` | `isHttpError(err)` | Returns true if err is an HttpError or has a statusCode. Type guard. |
| `toJSON` | `err.toJSON()` | Serialize: { error, code, statusCode, details? }. |


```js
const { NotFoundError, ValidationError, createError, isHttpError } = require('zero-http')

// Throw in route handlers — automatically caught!
app.get('/users/:id', async (req, res) => {
	const user = await User.findById(req.params.id)
	if (!user) throw new NotFoundError('User not found')
	res.json(user)
})

// Validation with field-level errors
app.post('/users', async (req, res) => {
	const errors = {}
	if (!req.body.email) errors.email = 'required'
	if (!req.body.name) errors.name = 'required'
	if (Object.keys(errors).length > 0) {
		throw new ValidationError('Invalid input', errors)
		// Response: { error: 'Invalid input', code: 'VALIDATION_FAILED',
		//   statusCode: 422, details: { email: 'required', name: 'required' } }
	}
	res.json(await User.create(req.body))
})

// Factory — create by status code
throw createError(409, 'Duplicate entry', { details: { id: 42 } })

// Custom error code
throw new HttpError(503, 'Database offline', { code: 'DB_DOWN' })

// Type checking in error handlers
app.onError((err, req, res, next) => {
	if (isHttpError(err)) {
		res.status(err.statusCode).json(err.toJSON())
	} else {
		res.status(500).json({ error: 'Unexpected error' })
	}
})
```


> **Tip:** Just throw — the router wraps all handlers in try/catch and catches async rejections too.
> **Tip:** Every error auto-generates a code from the status text: 404 → NOT_FOUND, 422 → UNPROCESSABLE_ENTITY.
> **Tip:** ValidationError.errors stores field-level details — perfect for form validation feedback.
> **Tip:** createError(statusCode) returns the correct typed class: createError(404) returns NotFoundError.
> **Tip:** Use opts.details to attach any structured data (IDs, field names, debug info) to the error.
> **Tip:** isHttpError() works as a TypeScript type guard — narrows the type to HttpError.


### Framework Errors

Specialized error classes for framework-specific failures — database errors, configuration problems, middleware failures, routing issues, and timeouts. Each carries context-specific properties alongside the standard HttpError fields. These are thrown automatically by the framework internals and can also be used directly in application code.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `DatabaseError` | `new DatabaseError([message], [opts])` | 500 — Database/ORM failure. opts: { query, adapter, details }. Thrown on adapter-level failures. |
| `ConfigurationError` | `new ConfigurationError([message], [opts])` | 500 — Invalid configuration. opts: { setting, details }. Thrown when app/adapter config is invalid. |
| `MiddlewareError` | `new MiddlewareError([message], [opts])` | 500 — Middleware failure. opts: { middleware, details }. Thrown when a middleware function fails unexpectedly. |
| `RoutingError` | `new RoutingError([message], [opts])` | 500 — Routing failure. opts: { path, method, details }. Thrown when route resolution fails. |
| `TimeoutError` | `new TimeoutError([message], [opts])` | 408 — Operation timed out. opts: { timeout, details }. Thrown when a request exceeds the allowed time. |


```js
const { DatabaseError, ConfigurationError, MiddlewareError,
	RoutingError, TimeoutError, isHttpError } = require('zero-http')

// Database error with context
app.get('/users', async (req, res) => {
	try {
		const users = await User.find()
		res.json(users)
	} catch (err) {
		throw new DatabaseError('Failed to fetch users', {
			query: 'SELECT * FROM users',
			adapter: 'sqlite',
			details: { originalError: err.message }
		})
	}
})

// Configuration error
if (!process.env.DATABASE_URL) {
	throw new ConfigurationError('DATABASE_URL is required', {
		setting: 'DATABASE_URL'
	})
}

// Middleware error
const safeMiddleware = (req, res, next) => {
	try {
		// middleware logic
		next()
	} catch (err) {
		next(new MiddlewareError('Auth middleware failed', {
			middleware: 'auth',
			details: { originalError: err.message }
		}))
	}
}

// Differentiate error types in error handler
app.onError((err, req, res, next) => {
	if (err instanceof DatabaseError) {
		console.error('DB Error:', err.adapter, err.query)
		res.status(500).json({ error: 'Database unavailable' })
	} else if (err instanceof TimeoutError) {
		res.status(408).json({ error: err.message, timeout: err.timeout })
	} else if (isHttpError(err)) {
		res.status(err.statusCode).json(err.toJSON())
	} else {
		res.status(500).json({ error: 'Internal error' })
	}
})
```


> **Tip:** All framework errors extend HttpError — they work with isHttpError(), toJSON(), and createError().
> **Tip:** DatabaseError carries .query and .adapter — use them in error handlers for debugging and monitoring.
> **Tip:** ConfigurationError.setting tells you which config key is invalid — great for startup validation.
> **Tip:** MiddlewareError.middleware identifies which middleware failed — useful for debugging middleware chains.
> **Tip:** RoutingError carries .path and .method — helpful for diagnosing route conflicts.
> **Tip:** TimeoutError carries .timeout (in ms) — the limit that was exceeded.
> **Tip:** ORM model validation now throws ValidationError (422) instead of plain Error — catch it with instanceof.
> **Tip:** Use instanceof checks in app.onError() to handle different failure categories with different responses.


### errorHandler

Configurable error-handling middleware. Formats error responses based on environment (dev vs production), includes stack traces in dev, hides internal details in production, and supports custom formatters and logging. Use with app.onError().

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `stack` | boolean | `true (non-production)` | Include stack traces in responses. Auto-detected from NODE_ENV. |
| `log` | boolean | `true` | Log errors to console. |
| `logger` | function | `console.error` | Custom log function. |
| `formatter` | function | `—` | Custom response formatter: (err, req, isDev) => responseBody. |
| `onError` | function | `—` | Callback on every error: (err, req, res) => void. |


```js
const { createApp, errorHandler } = require('zero-http')
const app = createApp()

// Basic — dev mode with stack traces
app.onError(errorHandler())

// Production — hide internals
app.onError(errorHandler({ stack: false }))

// Custom formatter
app.onError(errorHandler({
	formatter: (err, req, isDev) => ({
		success: false,
		message: err.message,
		...(isDev && { stack: err.stack })
	})
}))

// Error monitoring callback
app.onError(errorHandler({
	onError: (err, req) => {
		// Send to Sentry, DataDog, etc.
		errorTracker.capture(err, { url: req.url, method: req.method })
	}
}))
```


> **Tip:** In production (NODE_ENV=production), 5xx errors show 'Internal Server Error' instead of the real message.
> **Tip:** 4xx errors always show the real message — they're client errors, not secrets.
> **Tip:** The formatter option gives you full control over the response shape for your API style.
> **Tip:** onError is perfect for error monitoring (Sentry, DataDog) without changing response format.
> **Tip:** Headers-already-sent errors are silently skipped — no double-response crashes.


### debug

Lightweight namespaced debug logger with levels, colors, and timestamps. Enable via DEBUG env var or programmatically. Each namespace gets a unique color. Supports text and structured JSON output.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `debug(namespace)` | `debug('app:routes')` | Create a namespaced logger. Returns a function with level methods. |
| `log()` | `log(...args)` | Log at debug level (default call). Supports %s, %d, %j format specifiers. |
| `log.trace()` | `log.trace(...args)` | Log at trace level (most verbose). |
| `log.info()` | `log.info(...args)` | Log at info level. |
| `log.warn()` | `log.warn(...args)` | Log at warn level. |
| `log.error()` | `log.error(...args)` | Log at error level. |
| `log.fatal()` | `log.fatal(...args)` | Log at fatal level (most severe). |
| `debug.level()` | `debug.level('info')` | Set minimum log level globally. Levels: trace, debug, info, warn, error, fatal, silent. |
| `debug.enable()` | `debug.enable('app:*')` | Enable namespaces by pattern. Same syntax as DEBUG env var. |
| `debug.disable()` | `debug.disable()` | Disable all debug output. |
| `debug.json()` | `debug.json(true)` | Enable structured JSON output (for log aggregators). |
| `debug.timestamps()` | `debug.timestamps(false)` | Toggle timestamps. |
| `debug.colors()` | `debug.colors(false)` | Toggle ANSI colors. |
| `debug.output()` | `debug.output(stream)` | Set custom output stream (default: stderr). |
| `debug.reset()` | `debug.reset()` | Reset all settings to defaults. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `DEBUG` | env var | `—` | Comma-separated namespace patterns. Supports * glob and -prefix to exclude. |
| `DEBUG_LEVEL` | env var | `debug` | Minimum log level: trace, debug, info, warn, error, fatal, silent. |


```js
const { debug } = require('zero-http')

const log = debug('app:routes')
const dbLog = debug('db:queries')

// Log at different levels
log.info('server started on port %d', 3000)
log.warn('deprecated endpoint hit: %s', req.url)
log.error('request failed', err)
log.trace('entering handler for %s %s', req.method, req.url)

// Conditional logging
if (log.enabled) {
	log('expensive debug data: %j', buildDebugPayload())
}

// JSON mode for production log aggregators
debug.json(true)
debug.level('info')
// Output: {"timestamp":"...","level":"INFO","namespace":"app:routes","message":"server started on port 3000"}

// Enable specific namespaces
debug.enable('app:*,db:*')     // only app and db
debug.enable('*,-db:queries')  // everything except db:queries

// Environment variables
// DEBUG=app:* node server.js
// DEBUG_LEVEL=warn node server.js
```


> **Tip:** Set DEBUG=* to see all debug output, or DEBUG=app:* to filter by namespace.
> **Tip:** Use debug.json(true) in production for structured JSON logs — pipe to ELK, Datadog, etc.
> **Tip:** Format specifiers: %s (string), %d (number), %j (JSON), %o (object).
> **Tip:** Each namespace gets a unique color — makes it easy to scan logs visually.
> **Tip:** debug.level('warn') filters out trace/debug/info — only show warnings and above.
> **Tip:** log.enabled is a boolean — use it to skip expensive debug payload construction.



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
