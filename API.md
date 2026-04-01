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
  - [Model](#model)
  - [Schema DDL](#schema-ddl)
  - [TYPES](#types)
  - [Query](#query)
  - [SQLite Adapter](#sqlite-adapter)
  - [MySQL Adapter](#mysql-adapter)
  - [PostgreSQL Adapter](#postgresql-adapter)
  - [MongoDB Adapter](#mongodb-adapter)
  - [Redis Adapter](#redis-adapter)
  - [Memory Adapter](#memory-adapter)
  - [JSON Adapter](#json-adapter)
  - [Migrator](#migrator)
  - [QueryCache](#querycache)
  - [Seeder & Factory](#seeder-factory)
  - [QueryProfiler](#queryprofiler)
  - [ReplicaManager](#replicamanager)
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
  Migrator, defineMigration, QueryCache,
  Seeder, SeederRunner, Factory, Fake,
  HttpError, NotFoundError, BadRequestError, ValidationError, createError, isHttpError,
  ConnectionError, MigrationError, TransactionError, QueryError, AdapterError, CacheError,
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
| `Migrator` | class | Versioned migration framework |
| `defineMigration` | function | Migration definition helper |
| `QueryCache` | class | In-memory LRU query cache with TTL |
| `Seeder` | class | Base seeder class for data population |
| `SeederRunner` | class | Seeder orchestration runner |
| `Factory` | class | Model record factory for testing |
| `Fake` | class | Built-in fake data generator |
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
| `ConnectionError` | class | Database connection error |
| `MigrationError` | class | Migration execution error |
| `TransactionError` | class | Transaction error |
| `QueryError` | class | Query execution error |
| `AdapterError` | class | Adapter-level error |
| `CacheError` | class | Cache operation error |
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

#### HTTP Routing

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


#### WebSocket

| Method | Signature | Description |
|---|---|---|
| `ws` | `ws(path, [opts], handler)` | Register a WebSocket upgrade handler. See Real-Time → WebSocket. |


#### Route Helpers

| Method | Signature | Description |
|---|---|---|
| `param` | `param(name, handler)` | Register a parameter handler that fires when :name appears in a route. |
| `group` | `group(prefix, [...middleware], fn)` | Group routes under a prefix with shared middleware. |
| `chain` | `chain(path)` | Start a route chain for a single path. Returns { get, post, put, delete, ... }. |
| `routes` | `routes()` | Return the full route table for introspection/debugging. |
| `onError` | `onError(handler)` | Register a global error handler: (err, req, res, next) => {}. |
| `route` | `app.route(method, path, ...handlers)` | Register a route with a specific HTTP method string. Lower-level alternative to `app.get()`, `app.post()`, etc. |


#### App Settings

| Method | Signature | Description |
|---|---|---|
| `set` | `set(key, value)` | Set an application setting (also used as get(key) to retrieve). |
| `enable` | `enable(key)` | Set a boolean setting to true. |
| `disable` | `disable(key)` | Set a boolean setting to false. |
| `enabled` | `enabled(key)` | Check if a setting is truthy. |
| `disabled` | `disabled(key)` | Check if a setting is falsy. |
| `locals` | `locals` | A plain object for storing application-wide data. Merged into req.locals on each request. |
| `router` | `app.router` | The internal RouterInstance. Useful for advanced inspection or mounting child routers. |
| `middlewares` | `app.middlewares` | The middleware stack array. Read-only introspection of registered middleware. |


#### Server Lifecycle

| Method | Signature | Description |
|---|---|---|
| `listen` | `listen(port, [tlsOpts], [cb])` | Start the HTTP(S) server. Pass TLS options for HTTPS. |
| `close` | `close([cb])` | Shut down the server. |
| `handler` | `handler()` | The raw (req, res) handler for use with custom HTTP servers. |


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

#### HTTP Routes

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


#### Utilities

| Method | Signature | Description |
|---|---|---|
| `route` | `route(path)` | Create a route chain: router.route('/items').get(fn).post(fn). |
| `inspect` | `inspect()` | Return the route table for this router. |
| `add` | `router.add(method, path, handlers, [options])` | Low-level route registration. Prefer `router.get()`, `router.post()`, etc. for convenience. |
| `handle` | `router.handle(req, res)` | Match the request against registered routes and invoke the first matching handler chain. Called internally by the framework. |
| `routes` | `router.routes` | Array of all registered route entries. |


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

#### Request Line

| Method | Signature | Description |
|---|---|---|
| `method` | `req.method` | HTTP method string ('GET', 'POST', etc.). |
| `url` | `req.url` | Full URL including query string. |
| `path` | `req.path` | URL path without query string. |
| `originalUrl` | `req.originalUrl` | Original URL as received — never rewritten by middleware. |
| `baseUrl` | `req.baseUrl` | The URL prefix on which the current router was mounted. |


#### Headers & Content

| Method | Signature | Description |
|---|---|---|
| `headers` | `req.headers` | Lower-cased request headers object. |
| `get` | `req.get(name)` | Get a request header (case-insensitive). |
| `is` | `req.is(type)` | Check if Content-Type matches (e.g. req.is('json')). |
| `accepts` | `req.accepts(...types)` | Content negotiation — which types the client accepts. |


#### Route Data

| Method | Signature | Description |
|---|---|---|
| `params` | `req.params` | Route parameters from path segments (e.g. /:id). |
| `query` | `req.query` | Parsed query-string key/value pairs. |
| `body` | `req.body` | Request body (populated by body-parsing middleware). |
| `rawBody` | `req.rawBody` | Raw request body as a Buffer, set by body-parsing middleware before parsing. Useful for webhook signature verification (e.g. Stripe, GitHub). |


#### Auth & Cookies

| Method | Signature | Description |
|---|---|---|
| `cookies` | `req.cookies` | Parsed cookies (populated by cookieParser). |
| `signedCookies` | `req.signedCookies` | Verified signed cookies (populated by cookieParser with a secret). |
| `secret` | `req.secret` | First signing secret (set by cookieParser). Used by res.cookie({ signed: true }). |


#### Client Info

| Method | Signature | Description |
|---|---|---|
| `ip` | `req.ip` | Remote IP address. |
| `secure` | `req.secure` | true if the connection is over TLS. |
| `protocol` | `req.protocol` | 'https' or 'http'. |
| `hostname` | `req.hostname` | Hostname from the Host header. |
| `subdomains` | `req.subdomains([offset])` | Array of subdomains (offset defaults to 2). |
| `xhr` | `req.xhr` | true if X-Requested-With is XMLHttpRequest. |
| `fresh` | `req.fresh` | true if the client cache is still valid (ETag/Last-Modified). |
| `stale` | `req.stale` | Inverse of fresh. |


#### Misc

| Method | Signature | Description |
|---|---|---|
| `locals` | `req.locals` | Request-scoped data store (merged from app.locals). |
| `id` | `req.id` | Unique request ID (set by requestId middleware). |
| `range` | `req.range(size)` | Parse the Range header. Returns object or -1/-2. |
| `raw` | `req.raw` | The original Node IncomingMessage. |


#### Properties

| Method | Signature | Description |
|---|---|---|
| `timedOut` | `req.timedOut` | Whether the request timed out. Set to `true` by the timeout middleware when the deadline is exceeded. |
| `app` | `req.app` | Reference to the parent App instance. |
| `csrfToken` | `req.csrfToken` | CSRF token string. Populated by the csrf middleware for inclusion in forms or response headers. |
| `secrets` | `req.secrets` | Array of all signing secrets. Populated by cookieParser when multiple secrets are provided. |


> **Tip:** req.query is always an object — even if no query string is present, it defaults to {}.
> **Tip:** req.body is undefined until a body-parsing middleware populates it.
> **Tip:** req.locals persists for the life of the request — use it to pass data between middleware.


### Response

The response object wraps Node's ServerResponse with chainable methods for setting status codes, headers, cookies, and sending various response types. Available as the second argument to every route handler.

#### Status & Headers

| Method | Signature | Description |
|---|---|---|
| `status` | `res.status(code)` | Set the HTTP status code. Chainable. |
| `set` | `res.set(name, value)` | Set a response header. Chainable. |
| `get` | `res.get(name)` | Get a previously-set response header. |
| `append` | `res.append(name, value)` | Append a value to a header. |
| `vary` | `res.vary(field)` | Add a field to the Vary header. |
| `type` | `res.type(ct)` | Set Content-Type. Chainable. |


#### Body

| Method | Signature | Description |
|---|---|---|
| `send` | `res.send(body)` | Send a response (string, Buffer, object, or null). Auto-sets Content-Type. |
| `json` | `res.json(obj)` | Send a JSON response with Content-Type: application/json. |
| `text` | `res.text(str)` | Send a plain text response. |
| `html` | `res.html(str)` | Send an HTML response. |
| `sendStatus` | `res.sendStatus(code)` | Send only the status code with its reason phrase as body. |


#### Files & Redirects

| Method | Signature | Description |
|---|---|---|
| `sendFile` | `res.sendFile(path, [opts], [cb])` | Stream a file as the response with appropriate Content-Type. |
| `download` | `res.download(path, [filename], [cb])` | Prompt a file download with Content-Disposition header. |
| `redirect` | `res.redirect([status], url)` | Send a redirect response. Default status: 302. |
| `format` | `res.format(types)` | Content negotiation — respond based on Accept header. Keys are MIME types. |


#### Cookies

| Method | Signature | Description |
|---|---|---|
| `cookie` | `res.cookie(name, value, [opts])` | Set a cookie. Supports signed (auto-sign via req.secret), priority (Low/Medium/High), partitioned (CHIPS), and auto-serializes objects as JSON cookies (j: prefix). Chainable. |
| `clearCookie` | `res.clearCookie(name, [opts])` | Clear a cookie by setting it to expire. Chainable. |


#### Misc

| Method | Signature | Description |
|---|---|---|
| `links` | `res.links(links)` | Set the Link header from { rel: url } pairs. Chainable. |
| `location` | `res.location(url)` | Set the Location header. Chainable. |
| `sse` | `res.sse([opts])` | Open a Server-Sent Events stream. See Real-Time → SSE. |
| `headersSent` | `res.headersSent` | true if headers have already been sent. |
| `locals` | `res.locals` | Request-scoped data store. |
| `raw` | `res.raw` | The original Node ServerResponse. |
| `app` | `res.app` | Reference to the parent App instance. |


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

Parses JSON request bodies into req.body and stores the raw buffer on req.rawBody for signature verification. Auto-detects charset from the Content-Type header. Supports size limits, strict mode, gzip/deflate/brotli decompression, and a verify callback for webhook signatures.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | string \| number | `'1mb'` | Maximum body size (e.g. '10kb', '5mb', or bytes as number). |
| `strict` | boolean | `true` | Reject payloads whose root is not an object or array. |
| `reviver` | function | `—` | JSON.parse reviver function for custom deserialization. |
| `type` | string \| string[] \| function | `'application/json'` | Content-Type(s) to match. Accepts a string, an array of strings, or a function returning boolean. Supports suffix patterns like 'application/*+json' to match vendor types (e.g. application/vnd.api+json). |
| `verify` | function | `—` | verify(req, res, buf, encoding) — called with the raw Buffer before parsing. Throw an error to reject the request with 403. Ideal for webhook signature verification (e.g. Stripe, GitHub). |
| `inflate` | boolean | `true` | Decompress gzip, deflate, and brotli request bodies automatically. Set to false to reject compressed bodies with 415. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, json } = require('zero-http')
const crypto = require('crypto')
const app = createApp()

// Basic usage
app.use(json({ limit: '10kb', strict: true }))

// Webhook signature verification (e.g. Stripe)
app.post('/webhook', json({
	type: ['application/json', 'application/*+json'],
	verify: (req, res, buf) => {
		const sig = req.headers['x-signature']
		const expected = crypto.createHmac('sha256', process.env.SECRET)
			.update(buf).digest('hex')
		if (sig !== expected) throw new Error('Invalid signature')
	}
}), (req, res) => {
	// req.rawBody contains the original Buffer for verification
	res.json({ received: req.body })
})
```


> **Tip:** With strict: true (default), primitives like '"hello"' or '42' are rejected — only {} and [] are allowed.
> **Tip:** req.rawBody is always set to the raw Buffer before JSON.parse — use it for HMAC signature verification.
> **Tip:** Charset is auto-detected from the Content-Type header (e.g. charset=utf-16le). Falls back to utf8.
> **Tip:** The type option accepts arrays: ['application/json', 'application/*+json'] matches both standard and vendor JSON types.
> **Tip:** Compressed bodies (gzip, deflate, brotli) are automatically decompressed. Set inflate: false to reject them with 415.


### urlencoded

Parses URL-encoded form bodies (application/x-www-form-urlencoded) into req.body. Supports nested object parsing, parameter limits for DoS prevention, nesting depth limits, and stores req.rawBody for verification.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `extended` | boolean | `false` | Enable nested bracket parsing (e.g. user[name]=Alice → { user: { name: 'Alice' } }). |
| `limit` | string \| number | `'1mb'` | Maximum body size. |
| `parameterLimit` | number | `1000` | Maximum number of form parameters. Exceeding this returns 413. Prevents DoS via field flooding. |
| `depth` | number | `32` | Maximum nesting depth for bracket syntax (e.g. a[b][c][d]…). Exceeding this returns 400. Prevents deep-nesting DoS. |
| `type` | string \| string[] \| function | `'application/x-www-form-urlencoded'` | Content-Type(s) to match. |
| `verify` | function | `—` | verify(req, res, buf, encoding) — called with the raw Buffer before parsing. Throw to reject with 403. |
| `inflate` | boolean | `true` | Decompress gzip/deflate/brotli bodies. Set to false to reject compressed bodies with 415. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, urlencoded } = require('zero-http')
const app = createApp()

// Secure form parser with DoS protection
app.use(urlencoded({
	extended: true,
	parameterLimit: 500,  // max 500 fields
	depth: 10             // max 10 levels of nesting
}))

app.post('/form', (req, res) => {
	// req.rawBody has the raw Buffer for verification workflows
	res.json(req.body)
})
```


> **Tip:** parameterLimit: 1000 (default) protects against field-flooding DoS attacks automatically.
> **Tip:** depth: 32 (default) prevents deeply nested bracket keys like a[b][c][d]… from consuming CPU.
> **Tip:** req.rawBody is set before parsing — use it for signature verification on form submissions.


### text

Reads the raw request body as a string into req.body. Matches Content-Type text/* by default. Auto-detects charset from the Content-Type header, falling back to the encoding option. Stores req.rawBody for verification.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `type` | string \| string[] \| function | `'text/*'` | Content-Type(s) to match. |
| `limit` | string \| number | `'1mb'` | Maximum body size. |
| `encoding` | string | `'utf8'` | Fallback character encoding when Content-Type has no charset parameter. |
| `verify` | function | `—` | verify(req, res, buf, encoding) — called with the raw Buffer before decoding. Throw to reject with 403. |
| `inflate` | boolean | `true` | Decompress gzip/deflate/brotli bodies. Set to false to reject compressed bodies with 415. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, text } = require('zero-http')
const app = createApp()

app.use(text({ encoding: 'utf8' }))

app.post('/log', (req, res) => {
	// Charset is auto-detected from Content-Type (e.g. text/plain; charset=utf-16le)
	// req.rawBody contains the raw Buffer
	console.log(typeof req.body) // 'string'
	res.text('Received: ' + req.body)
})
```


> **Tip:** Charset is auto-detected from the Content-Type header. The encoding option is only used as a fallback.
> **Tip:** req.rawBody is always set to the raw Buffer before string conversion.


### raw

Reads the raw request body as a Buffer into req.body. Also sets req.rawBody. Useful for binary data, webhooks, custom protocols, and signature verification workflows.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `type` | string \| string[] \| function | `'application/octet-stream'` | Content-Type(s) to match. |
| `limit` | string \| number | `'1mb'` | Maximum body size. |
| `verify` | function | `—` | verify(req, res, buf) — called with the raw Buffer before setting req.body. Throw to reject with 403. |
| `inflate` | boolean | `true` | Decompress gzip/deflate/brotli bodies. Set to false to reject compressed bodies with 415. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const { createApp, raw } = require('zero-http')
const crypto = require('crypto')
const app = createApp()

// Webhook receiver with signature verification
app.post('/webhook', raw({
	type: 'application/octet-stream',
	limit: '5mb',
	verify: (req, res, buf) => {
		const sig = req.headers['x-hub-signature-256']
		const hmac = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
			.update(buf).digest('hex')
		if (sig !== `sha256=${hmac}`) throw new Error('Bad signature')
	}
}), (req, res) => {
	console.log(req.rawBody.length) // raw bytes
	res.sendStatus(200)
})
```


> **Tip:** req.rawBody and req.body are both the same Buffer instance for the raw parser.
> **Tip:** Use the verify callback for webhook signature validation before processing the payload.


### multipart

Streams multipart/form-data file uploads to disk and populates req.body with { fields, files }. Supports per-file size limits, file count limits, field count limits, MIME type whitelists, and combined total size limits for upload handling.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `dir` | string | `os.tmpdir() + '/zero-http-uploads'` | Upload directory. Created automatically if it doesn't exist. |
| `maxFileSize` | number | `—` | Maximum size per file in bytes. Rejects oversized files with 413. |
| `maxFiles` | number | `10` | Maximum number of uploaded files. Exceeding this returns 413. Prevents file flooding. |
| `maxFields` | number | `1000` | Maximum number of non-file form fields. Exceeding this returns 413. Prevents field flooding DoS. |
| `maxFieldSize` | number | `1048576` | Maximum size of a single field value in bytes (default 1 MB). Exceeding this returns 413. |
| `maxTotalSize` | number | `—` | Maximum combined size of all uploaded files in bytes. Exceeding this returns 413. |
| `allowedMimeTypes` | string[] | `—` | Whitelist of allowed MIME types for uploaded files (e.g. ['image/png', 'image/jpeg']). Files with non-matching types are rejected with 415. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |


```js
const path = require('path')
const { createApp, multipart } = require('zero-http')
const app = createApp()

// Upload handler with full security controls
app.post('/upload', multipart({
	dir: path.join(__dirname, 'uploads'),
	maxFileSize: 10 * 1024 * 1024,   // 10 MB per file
	maxFiles: 5,                      // max 5 files per request
	maxFields: 20,                    // max 20 form fields
	maxFieldSize: 64 * 1024,          // 64 KB per field value
	maxTotalSize: 50 * 1024 * 1024,   // 50 MB total across all files
	allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
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
> **Tip:** Use allowedMimeTypes to restrict uploads to specific file types — rejected files return 415.
> **Tip:** maxFiles: 10 (default) prevents file-flooding attacks. Lower it for endpoints that expect a single file.
> **Tip:** maxTotalSize limits the combined size of all uploads in a single request — useful for quota enforcement.



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
| `encoding` | string \| string[] | `—` | Force specific encoding(s) instead of auto-detecting from `Accept-Encoding`. E.g. `"gzip"` or `["gzip", "deflate"]`. |


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
| `crossOriginEmbedderPolicy` | boolean | `false` | Set Cross-Origin-Embedder-Policy header (require-corp). |
| `crossOriginOpenerPolicy` | string \| false | `'same-origin'` | Cross-Origin-Opener-Policy value. |
| `crossOriginResourcePolicy` | string \| false | `'same-origin'` | Cross-Origin-Resource-Policy value. |
| `dnsPrefetchControl` | boolean | `true` | Set X-DNS-Prefetch-Control: off. |
| `frameguard` | string \| false | `'deny'` | 'deny', 'sameorigin', or false. |
| `hsts` | boolean \| false | `true` | Strict-Transport-Security header. |
| `hstsMaxAge` | number | `15552000` | HSTS max-age in seconds (180 days). |
| `hstsPreload` | boolean | `false` | Add preload directive to HSTS header. |
| `noSniff` | boolean | `true` | X-Content-Type-Options: nosniff. |
| `permittedCrossDomainPolicies` | string \| false | `'none'` | X-Permitted-Cross-Domain-Policies header value. |
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


> **Tip:** When trustProxy is true, incoming X-Request-Id headers are accepted but truncated to 128 characters to prevent abuse.
> **Tip:** Use a custom generator to create shorter or application-specific IDs (e.g. nanoid, ULID, or prefixed UUIDs).


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

#### Signing

| Method | Signature | Description |
|---|---|---|
| `sign` | `cookieParser.sign(value, secret)` | Sign a value with HMAC-SHA256. Returns 's:<value>.<signature>'. |
| `unsign` | `cookieParser.unsign(value, secrets)` | Verify and unsign a signed cookie. Tries all provided secrets (rotation support). Returns the original value or false. |


#### Parsing

| Method | Signature | Description |
|---|---|---|
| `jsonCookie` | `cookieParser.jsonCookie(val)` | Serialize a value as a JSON cookie string: 'j:' + JSON.stringify(val). |
| `parseJSON` | `cookieParser.parseJSON(str)` | Parse a JSON cookie string (j: prefix). Returns parsed value or original string if not a valid JSON cookie. |


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

#### Validation

| Method | Signature | Description |
|---|---|---|
| `validate.field` | `validate.field(value, rules)` | Validate a single value against rules. Returns { valid, errors, value }. |
| `validate.object` | `validate.object(data, schema)` | Validate an object against a schema. Returns { valid, errors, sanitized }. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `body` | Record<string, ValidationRule> | `—` | Validation rules for `req.body` fields. |
| `query` | Record<string, ValidationRule> | `—` | Validation rules for `req.query` fields. |
| `params` | Record<string, ValidationRule> | `—` | Validation rules for `req.params` fields. |
| `stripUnknown` | boolean | `true` | Remove fields not defined in the schema. |
| `onError` | function | `—` | Custom error handler. Default sends 422 JSON. |
| `type` | string | `—` | Rule: Value type with auto-coercion. One of: `string`, `integer`, `number`, `float`, `boolean`, `array`, `json`, `date`, `uuid`, `email`, `url`. |
| `required` | boolean | `false` | Rule: Field must be present in the request. |
| `default` | any \| () => any | `—` | Rule: Default value (or factory function) when the field is missing. |
| `minLength` | number | `—` | Rule: Minimum string length. |
| `maxLength` | number | `—` | Rule: Maximum string length. |
| `min` | number | `—` | Rule: Minimum numeric value. |
| `max` | number | `—` | Rule: Maximum numeric value. |
| `match` | RegExp | `—` | Rule: Regex pattern the value must match. |
| `enum` | any[] | `—` | Rule: Allowed values whitelist. |
| `minItems` | number | `—` | Rule: Minimum array length (for `type: 'array'`). |
| `maxItems` | number | `—` | Rule: Maximum array length (for `type: 'array'`). |
| `validate` | (value: any) => string \| void | `—` | Rule: Custom validation function. Return a string to indicate an error. |


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

#### Loading

| Method | Signature | Description |
|---|---|---|
| `load` | `env.load(schema, [opts])` | Load and validate environment variables from .env files against a typed schema. Throws on validation failure with all errors. |
| `parse` | `env.parse(src)` | Parse a .env file string into key-value pairs. Supports comments, quotes, multiline, interpolation, and export prefix. |


#### Reading

| Method | Signature | Description |
|---|---|---|
| `get` | `env.get(key)` | Get a typed environment variable by key. |
| `require` | `env.require(key)` | Get a variable or throw if it's not set. Use for critical config. |
| `has` | `env.has(key)` | Check if a variable is set (not undefined). |
| `all` | `env.all()` | Get all loaded values as a plain object. |


#### Management

| Method | Signature | Description |
|---|---|---|
| `reset` | `env.reset()` | Reset the env store. Useful for testing. |


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
| `type` | string | `—` | Value type for coercion: 'string' \| 'number' \| 'integer' \| 'boolean' \| 'port' \| 'array' \| 'json' \| 'url' \| 'enum'. |
| `required` | boolean | `false` | If true, throws when the field is missing and has no default. |
| `default` | any \| () => any | `—` | Default value used when field is missing. Can be a function called lazily. |
| `min` | number | `—` | Minimum value (number/integer) or minimum length (string). |
| `max` | number | `—` | Maximum value (number/integer) or maximum length (string). |
| `match` | RegExp | `—` | Pattern that string values must match. |
| `separator` | string | `','` | Delimiter for array type. Items are trimmed and empties removed. |
| `values` | string[] | `—` | Allowed values for enum type. Throws with list of allowed values on mismatch. |
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

The ORM entry point. Connect to a database using one of 7 built-in adapters (memory, json, sqlite, mysql, postgres, mongo, redis), register your Model classes, and sync schemas. The Database instance manages the connection lifecycle and provides transaction support. All network-facing adapters (mysql, postgres, mongo, redis) validate credentials on connect — invalid host, port, user, or database values throw immediately.

#### Connection

| Method | Signature | Description |
|---|---|---|
| `connect` | `Database.connect(type, [opts])` | Static factory method. Creates a Database instance with the specified adapter. Validates credentials for network adapters. Returns the Database instance. |
| `close` | `db.close()` | Close the database connection. Returns Promise. |
| `ping` | `db.ping()` | Ping the database to check connectivity. Resolves true if reachable. |
| `register` | `db.register(ModelClass)` | Register a Model class with this database instance. The model will use this connection for all queries. Returns the Database instance for chaining. |
| `registerAll` | `db.registerAll(...models)` | Register multiple Model classes at once. Convenience wrapper around `register()`. Returns the Database instance for chaining. |
| `model` | `db.model(name)` | Retrieve a registered model class by its table name. |
| `retry` | `db.retry(fn, [options])` | Retry an async function with exponential backoff. Useful for transient database errors (connection drops, deadlocks). |


#### Query & DDL

| Method | Signature | Description |
|---|---|---|
| `sync` | `db.sync([opts])` | Create tables for all registered models. Returns Promise. |
| `drop` | `db.drop([tableName])` | Drop tables for all registered models. Returns Promise. |


#### Transactions

| Method | Signature | Description |
|---|---|---|
| `transaction` | `db.transaction(fn)` | Run an async function inside a transaction. Auto-commits on success, rolls back on error. Falls back to direct execution if the adapter doesn't support transactions. |


#### Migration

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `addColumn(table, column, opts)` | Adds a new column to an existing table. |
| `dropColumn` | `dropColumn(table, column)` | Drops a column from an existing table. |
| `renameColumn` | `renameColumn(table, from, to)` | Renames a column in an existing table. |
| `renameTable` | `renameTable(from, to)` | Renames an existing table. |
| `createIndex` | `createIndex(table, columns, opts)` | Creates an index on one or more columns. |
| `dropIndex` | `dropIndex(table, name)` | Drops a named index from a table. |
| `hasTable` | `hasTable(table)` | Checks whether a table exists in the database. |
| `hasColumn` | `hasColumn(table, column)` | Checks whether a column exists on a table. |
| `describeTable` | `describeTable(table)` | Returns full column metadata for a table. |
| `addForeignKey` | `addForeignKey(table, column, refTable, refColumn, opts)` | Adds a foreign key constraint to an existing column. |
| `dropForeignKey` | `dropForeignKey(table, constraintName)` | Drops a named foreign key constraint. |


#### Performance & Scalability

| Method | Signature | Description |
|---|---|---|
| `enableProfiling` | `db.enableProfiling([options])` | Enable query profiling on this database instance. Returns a QueryProfiler that records execution times, detects slow queries, and flags N+1 patterns. |
| `connectWithReplicas` | `Database.connectWithReplicas(type, primaryOpts, replicaConfigs, [options])` | Static factory that creates a Database with read replicas. Write operations go to the primary; read operations are distributed across replicas using the configured strategy. |


#### Instance Properties

| Method | Signature | Description |
|---|---|---|
| `adapter` | `database.adapter` | The underlying database adapter instance. Type depends on the adapter used during connect(). |
| `profiler` | `database.profiler` | The attached query profiler, or null if profiling is not enabled. Set via enableProfiling(). |
| `replicas` | `database.replicas` | The attached replica manager, or null if replicas are not configured. Set via connectWithReplicas(). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `memory` | adapter | `—` | In-memory adapter. No options required. Great for testing and prototyping. |
| `json` | adapter | `—` | File-based JSON adapter. Options: { path: 'data.json' }. |
| `sqlite` | adapter | `—` | SQLite adapter. Options: { filename, readonly, fileMustExist, createDir, pragmas }. Requires better-sqlite3. Auto-creates parent directories. |
| `mysql` | adapter | `—` | MySQL adapter. Options: { host, user, password, database, port }. Requires mysql2. Credentials validated on connect. |
| `postgres` | adapter | `—` | PostgreSQL adapter. Options: { host, user, password, database, port, ssl }. Requires pg. Credentials validated on connect. |
| `mongo` | adapter | `—` | MongoDB adapter. Options: { url, database, clientOptions }. Requires mongodb. URL and database validated on connect. |
| `redis` | adapter | `—` | Redis adapter. Options: { url, host, port, password, db, prefix }. Requires ioredis. Key-value, hashes, lists, sets, sorted sets, pub/sub. |


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


### Model

The ORM base class — extend it to define your data models. Supports typed schemas with validation, timestamps, soft deletes, lifecycle hooks, hidden fields, reusable scopes, relationships (hasMany, hasOne, belongsTo, belongsToMany), and a full suite of CRUD operations.

#### CRUD

| Method | Signature | Description |
|---|---|---|
| `find` | `Model.find([conditions])` | Find all records matching conditions. Returns Promise<Model[]>. |
| `findOne` | `Model.findOne(conditions)` | Find a single record. Returns Promise<Model\|null>. |
| `findOrCreate` | `Model.findOrCreate(conditions, [defaults])` | Find or insert. Returns Promise<{ instance, created }>. |
| `create` | `Model.create(data)` | Insert a new record. Runs validation and beforeCreate/afterCreate hooks. Returns Promise<Model>. |
| `createMany` | `Model.createMany([data, ...])` | Insert multiple records. Returns Promise<Model[]>. |
| `update` | `instance.update(data)` | Update specific fields on the instance. Returns Promise<Model>. |
| `delete` | `instance.delete()` | Delete the instance (soft or hard depending on softDelete setting). |
| `count` | `Model.count([conditions])` | Count matching records. Returns Promise<number>. |
| `exists` | `Model.exists([conditions])` | Check if any matching records exist. Returns Promise<boolean>. |
| `upsert` | `Model.upsert(conditions, data)` | Insert or update. Finds by conditions, creates with merged data if not found, updates if found. Returns Promise<{ instance, created }>. |
| `findById` | `Model.findById(id)` | Find a single record by its primary key value. |
| `updateWhere` | `Model.updateWhere(conditions, data)` | Update all records matching conditions. Returns the number of affected rows. |
| `deleteWhere` | `Model.deleteWhere(conditions)` | Delete all records matching conditions. Returns the number of deleted rows. |
| `scope` | `Model.scope(name, ...args)` | Start a fluent Query builder with a named scope applied. Scopes are reusable query conditions defined in `static scopes`. |


#### Query Builder

| Method | Signature | Description |
|---|---|---|
| `query` | `Model.query()` | Start a fluent Query builder. See ORM → Query. |
| `paginate` | `Model.paginate(page, [perPage], [conditions])` | Rich pagination: returns { data, total, page, perPage, pages, hasNext, hasPrev }. |


#### Soft Delete

| Method | Signature | Description |
|---|---|---|
| `restore` | `instance.restore()` | Restore a soft-deleted instance (sets deletedAt to null). |


#### LINQ-Inspired Shortcuts

| Method | Signature | Description |
|---|---|---|
| `first` | `Model.first([conditions])` | Find the first record matching optional conditions. |
| `last` | `Model.last([conditions])` | Find the last record matching optional conditions. |
| `all` | `Model.all([conditions])` | Get all records matching optional conditions. Alias for `find()`. |
| `chunk` | `Model.chunk(size, fn, [conditions])` | Process all matching records in batches. Calls `fn(batch, index)` for each chunk. |
| `random` | `Model.random([conditions])` | Get a random record matching optional conditions. |
| `pluck` | `Model.pluck(field, [conditions])` | Get an array of values for a single column from all matching records. |


#### Instance Methods

| Method | Signature | Description |
|---|---|---|
| `save` | `instance.save()` | Persist the instance. Inserts a new record if unpersisted, or updates only dirty (changed) fields if already saved. |
| `reload` | `instance.reload()` | Reload the instance from the database, discarding any unsaved local changes. |
| `toJSON` | `instance.toJSON()` | Return a plain object representation of the instance. Fields listed in `static hidden` are excluded. |
| `load` | `instance.load(relationName)` | Lazy-load a named relationship. The relation must be defined via `hasMany`, `hasOne`, `belongsTo`, or `belongsToMany`. |
| `increment` | `instance.increment(field, [by])` | Atomically increment a numeric field. Saves the change to the database immediately. |
| `decrement` | `instance.decrement(field, [by])` | Atomically decrement a numeric field. Saves the change to the database immediately. |


#### Relationships

| Method | Signature | Description |
|---|---|---|
| `hasMany` | `Model.hasMany(RelatedModel, foreignKey, [localKey])` | Define a one-to-many relationship. The related model's `foreignKey` references this model's primary key (or `localKey`). |
| `hasOne` | `Model.hasOne(RelatedModel, foreignKey, [localKey])` | Define a one-to-one relationship. Like `hasMany` but `load()` returns a single instance. |
| `belongsTo` | `Model.belongsTo(RelatedModel, foreignKey, [otherKey])` | Define an inverse one-to-one/many relationship. This model holds the foreign key. |
| `belongsToMany` | `Model.belongsToMany(RelatedModel, options)` | Define a many-to-many relationship through a junction (pivot) table. |


#### Schema & Lifecycle

| Method | Signature | Description |
|---|---|---|
| `sync` | `Model.sync()` | Create or sync the model's table in the database. Idempotent — safe to call multiple times. |
| `drop` | `Model.drop()` | Drop the model's table from the database. |


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
| `type` | TYPES.* | `—` | Column data type (e.g. `TYPES.STRING`, `TYPES.INTEGER`). Required. |
| `required` | boolean | `false` | Field must be provided on create. Throws validation error if missing. |
| `default` | any \| () => any | `—` | Default value, or a factory function. Called on each `create()` if the field is omitted. |
| `nullable` | boolean | `false` | Allow null values in the column. |
| `primaryKey` | boolean | `false` | Mark this column as the primary key. |
| `autoIncrement` | boolean | `false` | Auto-increment on insert (integer primary keys). |
| `unique` | boolean | `false` | Add a UNIQUE constraint on this column. |
| `minLength` | number | `—` | Minimum string length. Validated before insert/update. |
| `maxLength` | number | `—` | Maximum string length. Validated before insert/update. |
| `min` | number | `—` | Minimum numeric value. |
| `max` | number | `—` | Maximum numeric value. |
| `match` | RegExp | `—` | Pattern constraint for string values. |
| `enum` | string[] | `—` | Allowed values for string/ENUM type. |
| `values` | string[] | `—` | Allowed values for SET type. |
| `precision` | number | `—` | Total digit count for DECIMAL types. |
| `scale` | number | `—` | Digits after the decimal point for DECIMAL types. |
| `length` | number | `—` | Fixed width for CHAR, BINARY, VARBINARY types. |
| `unsigned` | boolean | `—` | MySQL: mark column as unsigned (no negative values). |
| `charset` | string | `—` | MySQL/PG: column-level character set. |
| `collation` | string | `—` | MySQL/PG: column-level collation. |
| `comment` | string | `—` | MySQL/PG: column comment stored in database metadata. |
| `arrayOf` | string | `—` | PostgreSQL: element type for ARRAY columns (e.g. `"text"`, `"integer"`). |


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


#### Performance & Scalability

| Method | Signature | Description |
|---|---|---|
| `withCount` | `withCount(relation)` | Eager-load a related record count without loading the records. Adds a <relation>_count property to each result. |
| `onReplica` | `onReplica()` | Force this query to execute on a read replica (if configured). Returns the query for chaining. |
| `explain` | `explain([options])` | Return the execution plan for this query instead of results. Options vary by adapter: { format, analyze, buffers }. |


#### Execution

| Method | Signature | Description |
|---|---|---|
| `build` | `query.build()` | Build and return the adapter-agnostic query descriptor without executing it. Useful for inspection, caching keys, or passing to `QueryCache.wrap()`. |


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


### SQLite Adapter

The SQLite adapter uses better-sqlite3 for synchronous, high-performance file-based persistence. It auto-creates parent directories, ships with production-tuned PRAGMA defaults (WAL, 64 MB cache, memory-mapped I/O), and exposes utility methods for database maintenance. Ideal for single-server apps, prototyping, and embedded use cases.

#### Connection & Queries

| Method | Signature | Description |
|---|---|---|
| `raw` | `adapter.raw(sql, ...params)` | Execute a raw SQL SELECT query with parameters. |
| `transaction` | `adapter.transaction(fn)` | Run a function inside a SQLite transaction. Auto-commits or rolls back. |
| `close` | `adapter.close()` | Close the database connection. |


#### Database Info

| Method | Signature | Description |
|---|---|---|
| `pragma` | `adapter.pragma(key)` | Read a single PRAGMA value (e.g. 'journal_mode' → 'wal'). |
| `checkpoint` | `adapter.checkpoint([mode])` | Force a WAL checkpoint. Modes: PASSIVE (default), FULL, RESTART, TRUNCATE. |
| `integrity` | `adapter.integrity()` | Run PRAGMA integrity_check. Returns 'ok' or a problem description. |
| `vacuum` | `adapter.vacuum()` | Rebuild the database file, reclaiming unused pages. |
| `fileSize` | `adapter.fileSize()` | Get the database file size in bytes. Returns 0 for in-memory databases. |
| `compileOptions` | `adapter.compileOptions()` | Get the compile-time options that SQLite was built with. |
| `cacheStatus` | `adapter.cacheStatus()` | Get prepared statement cache stats: { cached, max }. |
| `overview` | `adapter.overview()` | Database overview: all tables with row counts, total rows, and file size. |
| `pageInfo` | `adapter.pageInfo()` | Get page size, page count, and total bytes — helps estimate table overhead. |


#### Schema Inspection

| Method | Signature | Description |
|---|---|---|
| `tables` | `adapter.tables()` | List all user-created table names. |
| `columns` | `adapter.columns(table)` | Get column info: cid, name, type, notnull, defaultValue, pk. |
| `indexes` | `adapter.indexes(table)` | Get indexes: name, unique, and column names for each index. |
| `foreignKeys` | `adapter.foreignKeys(table)` | Get foreign keys: id, table, from, to, onUpdate, onDelete. |
| `tableStatus` | `adapter.tableStatus([table])` | Get row count per table. Omit table to get all tables. |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns boolean. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns boolean. |
| `describeTable` | `adapter.describeTable(table)` | Get full table info: { columns, indexes, foreignKeys }. |


#### Schema Mutations

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `adapter.addColumn(table, col, def)` | Add a column to a table. def supports type, required, default, check, references. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column (SQLite 3.35+). |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column (SQLite 3.25+). |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Create an index. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Drop an index by name (table is ignored — indexes are schema-scoped in SQLite). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `filename` | string | `':memory:'` | Path to the SQLite file, or ':memory:' for an in-memory database. |
| `readonly` | boolean | `false` | Open the database in read-only mode. |
| `fileMustExist` | boolean | `false` | Throw if the database file does not exist. |
| `createDir` | boolean | `true` | Auto-create parent directories for the database file. |
| `verbose` | boolean | `false` | Log all executed SQL statements to the console. |
| `pragmas` | object | `production defaults` | SQLite PRAGMA overrides. All keys below are set inside this object. |
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

#### Connection & Queries

| Method | Signature | Description |
|---|---|---|
| `raw` | `adapter.raw(sql, ...params)` | Execute a raw SQL SELECT query with parameterized inputs. Returns rows. |
| `exec` | `adapter.exec(sql, ...params)` | Execute a raw statement (INSERT, UPDATE, DDL). Returns { affectedRows, insertId }. |
| `transaction` | `adapter.transaction(fn)` | Run a function inside a transaction. Receives a connection object. Auto-commits/rollbacks. |
| `close` | `adapter.close()` | Close the connection pool. |
| `ping` | `adapter.ping()` | Ping the server. Returns true if healthy. |
| `poolStatus` | `adapter.poolStatus()` | Get pool stats: { total, idle, used, queued }. |


#### Database Info

| Method | Signature | Description |
|---|---|---|
| `databaseSize` | `adapter.databaseSize()` | Get total database size in bytes (data + indexes). |
| `version` | `adapter.version()` | Get MySQL/MariaDB server version string. |
| `overview` | `adapter.overview()` | Full database overview — all tables with size, rows, and formatted total size. |
| `variables` | `adapter.variables([filter])` | SHOW VARIABLES — optionally filtered with a LIKE pattern. |
| `processlist` | `adapter.processlist()` | SHOW PROCESSLIST — active connections: id, user, host, db, command, time, state, info. |


#### Schema Inspection

| Method | Signature | Description |
|---|---|---|
| `tables` | `adapter.tables()` | List all tables in the current database. |
| `columns` | `adapter.columns(table)` | Get column info for a table (Field, Type, Null, Key, Default, Extra). |
| `tableStatus` | `adapter.tableStatus([table])` | SHOW TABLE STATUS — name, engine, rows, dataLength, indexLength, totalSize, autoIncrement, collation, createTime, updateTime, comment. |
| `tableSize` | `adapter.tableSize(table)` | Human-readable table size: { rows, dataSize, indexSize, totalSize }. |
| `indexes` | `adapter.indexes(table)` | SHOW INDEX — name, column, unique, type, cardinality. |
| `tableCharset` | `adapter.tableCharset(table)` | Get charset and collation of a table. |
| `foreignKeys` | `adapter.foreignKeys(table)` | Get foreign keys: constraintName, column, referencedTable, referencedColumn, onDelete, onUpdate. |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns Promise<boolean>. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(table)` | Get detailed column info. Returns Promise<Array>. |


#### Schema Mutations

| Method | Signature | Description |
|---|---|---|
| `alterTable` | `adapter.alterTable(table, opts)` | Alter a table's engine, charset, or collation. opts: { engine, charset, collation }. |
| `addColumn` | `adapter.addColumn(table, col, def, [opts])` | Add a column. def: schema definition. opts: { after: 'col' } to position after a column. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column. |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Create an index. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Drop an index from a table. |
| `addForeignKey` | `adapter.addForeignKey(table, col, refTable, refCol, [opts])` | Add a FK constraint. opts: { name, onDelete, onUpdate }. |
| `dropForeignKey` | `adapter.dropForeignKey(table, name)` | Drop a FK constraint by name. |


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

#### Connection & Queries

| Method | Signature | Description |
|---|---|---|
| `raw` | `adapter.raw(sql, ...params)` | Execute a raw SQL SELECT query with $1-style params. Returns rows. |
| `exec` | `adapter.exec(sql, ...params)` | Execute a raw statement that doesn't return rows. Returns { rowCount }. |
| `transaction` | `adapter.transaction(fn)` | Run a function inside a transaction. Receives a client. Auto-commits/rollbacks. |
| `close` | `adapter.close()` | Close the connection pool. |
| `ping` | `adapter.ping()` | Ping the server. Returns true if healthy. |
| `poolStatus` | `adapter.poolStatus()` | Get pool stats: { total, idle, waiting }. |
| `listen` | `adapter.listen(channel, callback)` | Subscribe to PG LISTEN/NOTIFY. Returns an unlisten function. |


#### Database Info

| Method | Signature | Description |
|---|---|---|
| `databaseSize` | `adapter.databaseSize()` | Get total database size in bytes. |
| `version` | `adapter.version()` | Get PostgreSQL server version string. |
| `overview` | `adapter.overview()` | Full database overview — all tables with sizes, row counts, and formatted total. |
| `variables` | `adapter.variables([filter])` | Get pg_settings — optionally filtered with a LIKE pattern. |
| `processlist` | `adapter.processlist()` | Active backends from pg_stat_activity: pid, user, database, state, query, duration. |


#### Schema Inspection

| Method | Signature | Description |
|---|---|---|
| `tables` | `adapter.tables([schema])` | List all tables in a schema (default: 'public'). |
| `columns` | `adapter.columns(table, [schema])` | Get column info: column_name, data_type, is_nullable, column_default. |
| `tableStatus` | `adapter.tableStatus([table])` | pg_stat_user_tables — name, rows, totalSize, dataSize, indexSize, sequentialScans, indexScans, liveTuples, deadTuples, lastVacuum, lastAnalyze. |
| `tableSize` | `adapter.tableSize(table)` | Get total size of a table including indexes, in bytes. |
| `tableSizeFormatted` | `adapter.tableSizeFormatted(table)` | Human-readable table size: { rows, dataSize, indexSize, totalSize }. |
| `indexes` | `adapter.indexes(table)` | Get indexes: name, columns, unique, type, size. |
| `foreignKeys` | `adapter.foreignKeys(table)` | Get foreign keys: constraintName, column, referencedTable, referencedColumn, onDelete, onUpdate. |
| `constraints` | `adapter.constraints(table)` | Get all table constraints: name, type (PRIMARY KEY, UNIQUE, CHECK, FK, EXCLUSION), definition. |
| `comments` | `adapter.comments(table)` | Get table comment and column comments: { tableComment, columns: [{ name, comment }] }. |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns Promise<boolean>. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(table)` | Get column info with types, nullable, defaults, and PK flags. |


#### Schema Mutations

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `adapter.addColumn(table, col, def)` | Add a column. def supports type, required, default, check, references. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column. |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Create an index. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Drop an index by name (table is ignored — indexes are schema-scoped in PostgreSQL). |
| `addForeignKey` | `adapter.addForeignKey(table, col, refTable, refCol, [opts])` | Add a FK constraint. opts: { name, onDelete, onUpdate }. |
| `dropForeignKey` | `adapter.dropForeignKey(table, name)` | Drop a FK constraint by name. |


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

#### Connection & Queries

| Method | Signature | Description |
|---|---|---|
| `raw` | `adapter.raw(command)` | Run a raw MongoDB command document. Returns the command result. |
| `transaction` | `adapter.transaction(fn)` | Run operations in a transaction (requires replica set). Receives a session object. |
| `close` | `adapter.close()` | Close the connection. |
| `ping` | `adapter.ping()` | Ping the MongoDB server. Returns true if healthy. |
| `version` | `adapter.version()` | Get the MongoDB server version. |
| `isConnected` | `adapter.isConnected` | Property — true if currently connected. |


#### Collection Inspection

| Method | Signature | Description |
|---|---|---|
| `collections` | `adapter.collections()` | List all collections in the database. |
| `stats` | `adapter.stats()` | Get database stats: { collections, objects, dataSize, storageSize, indexes, indexSize }. |
| `collectionStats` | `adapter.collectionStats(name)` | Get stats for a specific collection: { count, size, avgObjSize, storageSize, nindexes }. |
| `indexes` | `adapter.indexes(collection)` | List all indexes on a collection. |
| `hasTable` | `adapter.hasTable(collection)` | Check if a collection exists. Returns Promise<boolean>. |
| `hasColumn` | `adapter.hasColumn(collection, field)` | Check if a field exists in any document. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(collection, [sample])` | Infer schema by sampling documents. Returns [{ name, types }]. |


#### Collection Mutations

| Method | Signature | Description |
|---|---|---|
| `createIndex` | `adapter.createIndex(collection, keys, [opts])` | Create an index. keys: { email: 1 } for ascending. opts: { unique: true }. |
| `dropIndex` | `adapter.dropIndex(collection, indexName)` | Drop a specific index by name. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a collection. |
| `addColumn` | `adapter.addColumn(collection, field, def)` | Add a field to all documents with a default value. |
| `dropColumn` | `adapter.dropColumn(collection, field)` | Remove a field from all documents. |
| `renameColumn` | `adapter.renameColumn(collection, old, new)` | Rename a field in all documents. |


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


### Redis Adapter

Redis adapter using ioredis with key-value operations, hashes, lists, sets, sorted sets, pub/sub, pipelines, TTL management, and full ORM CRUD. Stores table data as Redis hashes with sorted-set indexes for ordering and filtering. Bring-your-own-driver: npm install ioredis.

#### Connection & Control

| Method | Signature | Description |
|---|---|---|
| `ping` | `adapter.ping()` | Ping the Redis server. Returns 'PONG' if healthy. |
| `info` | `adapter.info([section])` | Get Redis server info. Optional section filter. |
| `dbsize` | `adapter.dbsize()` | Get the number of keys in the current database. |
| `raw` | `adapter.raw(command, ...args)` | Execute a raw Redis command. Command must be a non-empty string. |
| `close` | `adapter.close()` | Close the Redis connection. |
| `pipeline` | `adapter.pipeline()` | Create a pipeline for batching commands. Call exec() to run. |


#### String & Key Operations

| Method | Signature | Description |
|---|---|---|
| `get` | `adapter.get(key)` | Get a value by key. Auto-parses JSON. Key must be a non-empty string without control characters. |
| `set` | `adapter.set(key, value, [ttl])` | Set a key/value pair. Optional TTL in seconds (must be ≥ 0). Key must be a non-empty string without control characters. |
| `del` | `adapter.del(key)` | Delete a key. |
| `exists` | `adapter.exists(key)` | Check if a key exists. Returns boolean. |
| `expire` | `adapter.expire(key, seconds)` | Set a TTL on an existing key. Seconds must be ≥ 0. |
| `ttl` | `adapter.ttl(key)` | Get remaining TTL in seconds (-1 = no expiry, -2 = missing). |
| `incr` | `adapter.incr(key)` | Increment a numeric key by 1. Returns the new value. |
| `decr` | `adapter.decr(key)` | Decrement a numeric key by 1. Returns the new value. |


#### Hash Operations

| Method | Signature | Description |
|---|---|---|
| `hset` | `adapter.hset(key, field, value)` | Set a hash field. |
| `hget` | `adapter.hget(key, field)` | Get a hash field value. |
| `hgetall` | `adapter.hgetall(key)` | Get all fields and values in a hash. |
| `hdel` | `adapter.hdel(key, field)` | Delete a hash field. |


#### List Operations

| Method | Signature | Description |
|---|---|---|
| `rpush` | `adapter.rpush(key, ...values)` | Append values to a list (right). |
| `lpush` | `adapter.lpush(key, ...values)` | Prepend values to a list (left). |
| `lrange` | `adapter.lrange(key, start, stop)` | Get a range of list elements. |
| `rpop` | `adapter.rpop(key)` | Remove and return the last list element. |
| `lpop` | `adapter.lpop(key)` | Remove and return the first list element. |
| `llen` | `adapter.llen(key)` | Get the length of a list. |


#### Set Operations

| Method | Signature | Description |
|---|---|---|
| `sadd` | `adapter.sadd(key, ...members)` | Add members to a set. |
| `smembers` | `adapter.smembers(key)` | Get all members of a set. |
| `sismember` | `adapter.sismember(key, member)` | Check if a value is in a set. Returns boolean. |
| `srem` | `adapter.srem(key, member)` | Remove a member from a set. |
| `scard` | `adapter.scard(key)` | Get the number of members in a set. |


#### Sorted Set Operations

| Method | Signature | Description |
|---|---|---|
| `zadd` | `adapter.zadd(key, score, member)` | Add a member to a sorted set with a score. |
| `zrange` | `adapter.zrange(key, start, stop)` | Get members in a sorted set by index range. |
| `zrangebyscore` | `adapter.zrangebyscore(key, min, max)` | Get members by score range. |
| `zrem` | `adapter.zrem(key, member)` | Remove a member from a sorted set. |
| `zcard` | `adapter.zcard(key)` | Get the number of members in a sorted set. |


#### Pub/Sub

| Method | Signature | Description |
|---|---|---|
| `subscribe` | `adapter.subscribe(channel, callback)` | Subscribe to a pub/sub channel. callback must be a function. Returns an unsubscribe function. |
| `publish` | `adapter.publish(channel, message)` | Publish a message to a channel. Returns number of receivers. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | string | `—` | Redis connection URL: redis://user:pass@host:6379/0. |
| `host` | string | `'127.0.0.1'` | Redis server hostname. Must be a non-empty string. |
| `port` | number | `6379` | Redis server port. Must be an integer between 1 and 65535. |
| `password` | string | `—` | Redis password (AUTH). Must be a string if provided. |
| `db` | number | `0` | Redis database index. Must be an integer between 0 and 15. |
| `prefix` | string | `'zh:'` | Key prefix for namespacing all keys. |
| `maxRetries` | number | `3` | Max connection retry attempts. |
| `lazyConnect` | boolean | `false` | Defer connection until first operation. |
| `connectTimeout` | number | `10000` | Connection timeout in ms. Must be a non-negative number. |
| `tls` | object | `—` | TLS options for secure connections (Upstash, AWS ElastiCache). |


```js
const { Database, Model, TYPES } = require('zero-http')

const db = Database.connect('redis', {
	host: process.env.REDIS_HOST || '127.0.0.1',
	port: Number(process.env.REDIS_PORT) || 6379,
	password: process.env.REDIS_PASS,
	prefix: 'myapp:',
})

// Key-Value operations
await db.adapter.set('session:abc', { userId: 42 }, 3600) // TTL: 1 hour
const session = await db.adapter.get('session:abc')
await db.adapter.del('session:abc')

// Hash operations
await db.adapter.hset('user:1', 'name', 'Alice')
const name = await db.adapter.hget('user:1', 'name')
const all = await db.adapter.hgetall('user:1')

// Lists
await db.adapter.rpush('queue:jobs', 'task1', 'task2')
const items = await db.adapter.lrange('queue:jobs', 0, -1)
const next = await db.adapter.lpop('queue:jobs')

// Sets
await db.adapter.sadd('tags', 'node', 'redis', 'orm')
const members = await db.adapter.smembers('tags')
const isMember = await db.adapter.sismember('tags', 'node') // true

// Sorted Sets
await db.adapter.zadd('leaderboard', 100, 'alice')
await db.adapter.zadd('leaderboard', 200, 'bob')
const top = await db.adapter.zrange('leaderboard', 0, -1)

// Pub/Sub
const unsub = await db.adapter.subscribe('events', (msg) => {
	console.log('Received:', msg)
})
await db.adapter.publish('events', 'hello world')

// Pipeline (batched commands)
const pipe = db.adapter.pipeline()
pipe.set('a', '1')
pipe.set('b', '2')
pipe.get('a')
await pipe.exec()

// Health check
const pong = await db.adapter.ping() // 'PONG'
```


> **Tip:** Redis adapter requires the ioredis package — install with: npm install ioredis.
> **Tip:** Use prefix to namespace keys — avoids collisions when sharing a Redis instance.
> **Tip:** set() with a TTL is perfect for sessions, rate limiting, and temporary data.
> **Tip:** Pipeline batches multiple commands into a single round-trip — much faster than individual calls.
> **Tip:** Pub/Sub uses a separate connection internally — subscribing won't block your main client.
> **Tip:** The ORM CRUD layer (Model.create, find, etc.) works on top of Redis hashes + sorted sets.
> **Tip:** Use url for hosted Redis (Upstash, Redis Cloud, AWS ElastiCache).
> **Tip:** ping() is ideal for health check endpoints behind load balancers.


### Memory Adapter

Zero-dependency in-memory adapter — perfect for tests, prototyping, and ephemeral applications. All data lives in JavaScript Maps and arrays. Supports full CRUD, query builder, and utility methods for introspection, export/import, and cloning.

#### Inspection

| Method | Signature | Description |
|---|---|---|
| `tables` | `adapter.tables()` | List all registered table names. |
| `totalRows` | `adapter.totalRows()` | Count all rows across all tables. |
| `stats` | `adapter.stats()` | Get memory stats: { tables, totalRows, estimatedBytes }. |
| `indexes` | `adapter.indexes(table)` | Get tracked indexes: name, columns, unique. |
| `hasTable` | `adapter.hasTable(table)` | Check if a table exists. Returns Promise<boolean>. |
| `hasColumn` | `adapter.hasColumn(table, col)` | Check if a column exists. Returns Promise<boolean>. |
| `describeTable` | `adapter.describeTable(table)` | Get column info from schema: name, type, nullable, defaultValue, primaryKey. |


#### Data Serialization

| Method | Signature | Description |
|---|---|---|
| `toJSON` | `adapter.toJSON()` | Export all data as a plain object: { tableName: rows[], ... }. |
| `fromJSON` | `adapter.fromJSON(data)` | Import data from a plain object. Merges with existing data. |
| `clone` | `adapter.clone()` | Deep-copy the entire database state into a new MemoryAdapter. |
| `clear` | `adapter.clear()` | Delete all rows from all tables (tables remain registered). |


#### Schema Mutations

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `adapter.addColumn(table, col, def)` | Add a column. Sets default value for existing rows. |
| `dropColumn` | `adapter.dropColumn(table, col)` | Drop a column from all rows. |
| `renameColumn` | `adapter.renameColumn(table, old, new)` | Rename a column in schema and all rows. |
| `renameTable` | `adapter.renameTable(old, new)` | Rename a table. |
| `createIndex` | `adapter.createIndex(table, cols, [opts])` | Track an index in metadata. opts: { name, unique }. |
| `dropIndex` | `adapter.dropIndex(table, name)` | Remove an index from metadata (table is ignored — searches all tables). |


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

#### File Operations

| Method | Signature | Description |
|---|---|---|
| `flush` | `adapter.flush()` | Immediately write all pending changes to disk. |
| `fileSize` | `adapter.fileSize()` | Get total size of all JSON files in bytes. |
| `compact` | `adapter.compact(table)` | Re-serialize and save a table's JSON file. |
| `backup` | `adapter.backup(destDir)` | Copy all JSON files to a target directory. |
| `directory` | `adapter.directory` | Property — the resolved path where JSON files are stored. |
| `hasPendingWrites` | `adapter.hasPendingWrites` | Property — true if there are unflushed writes. |


#### Inspection

| Method | Signature | Description |
|---|---|---|
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


### Migrator

Versioned migration framework for the ORM. Define up/down migrations, track execution in batches, rollback safely, check status, and perform fresh resets. Migrations are stored in a _migrations tracking table within the same database.

#### Migration Control

| Method | Signature | Description |
|---|---|---|
| `rollback` | `migrator.rollback()` | Rollback the last batch. Returns { rolledBack: string[], batch: number }. |
| `reset` | `migrator.reset()` | Rollback all, then re-run all. Returns { rolledBack, migrated, batch }. |
| `status` | `migrator.status()` | Get current status: { executed: [], pending: [], lastBatch }. |
| `list` | `migrator.list()` | Get registered migration names. |
| `add` | `migrator.add(migration)` | Add a single migration definition. Returns the Migrator for chaining. |
| `addAll` | `migrator.addAll(migrations)` | Add multiple migration definitions at once. Returns the Migrator for chaining. |
| `migrate` | `migrator.migrate()` | Run all pending migrations. Returns info about what was migrated. |
| `rollbackAll` | `migrator.rollbackAll()` | Rollback ALL executed migrations (not just the last batch). |
| `fresh` | `migrator.fresh()` | Drop everything and re-run all migrations from scratch. Destructive — intended for development. |
| `hasPending` | `migrator.hasPending()` | Check whether there are any pending (unexecuted) migrations. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `table` | string | `'_migrations'` | Name of the migration tracking table. |
| `name` | string | `—` | Unique migration name. Only letters, digits, underscores, hyphens, and dots are allowed. |
| `up` | (db: Database) => Promise<void> | `—` | Function to apply the migration. Receives the Database instance. |
| `down` | (db: Database) => Promise<void> | `—` | Function to reverse the migration. Receives the Database instance. |


```js
const { Database, Migrator, defineMigration, TYPES } = require('zero-http')

const db = Database.connect('memory')
const migrator = new Migrator(db)

// Define migrations inline
migrator.add({
	name: '001_create_users',
	async up(db) {
		await db.adapter.createTable('users', {
			id:   { type: 'integer', primaryKey: true, autoIncrement: true },
			name: { type: 'string', required: true },
			email: { type: 'string', unique: true },
		});
	},
	async down(db) {
		await db.adapter.dropTable('users');
	}
})

// Or use the defineMigration helper
migrator.add(defineMigration('002_add_role',
	async (db) => {
		await db.addColumn('users', 'role', { type: TYPES.STRING, default: 'user' });
	},
	async (db) => {
		await db.dropColumn('users', 'role');
	}
))

// Run them
const { migrated, batch } = await migrator.migrate()
console.log(`Ran ${migrated.length} migrations in batch ${batch}`)

// Check status
const { executed, pending, lastBatch } = await migrator.status()

// Rollback last batch
const { rolledBack } = await migrator.rollback()

// Reset — rollback all then re-run
await migrator.reset()

// Fresh — drop everything and re-migrate
await migrator.fresh()
```


> **Tip:** Migration names should be ordered (001_, 002_) — they run in registration order.
> **Tip:** Each migrate() call creates a new batch — rollback() undoes the last batch only.
> **Tip:** rollbackAll() reverses all batches — useful for tearing down test databases.
> **Tip:** fresh() is destructive — it drops ALL tables including non-migrated ones.
> **Tip:** status() shows which migrations have run and which are pending — great for deploy checks.
> **Tip:** hasPending() is perfect for startup checks — block the server until migrations are current.
> **Tip:** The _migrations tracking table is auto-created on first use.
> **Tip:** defineMigration() is a convenience — it just returns { name, up, down }.


### QueryCache

In-memory LRU query cache with TTL support. Attach to a Database instance to cache query results automatically. Supports manual get/set, model-level invalidation, remember pattern, and optional Redis backend for distributed caching.

#### Cache Operations

| Method | Signature | Description |
|---|---|---|
| `get` | `cache.get(key)` | Get a cached value. Returns undefined on miss or expiry. |
| `set` | `cache.set(key, value, [ttl])` | Set a cache entry with optional TTL in seconds. |
| `has` | `cache.has(key)` | Check if a key exists and is not expired. |
| `delete` | `cache.delete(key)` | Delete a specific cache entry. |
| `wrap` | `cache.wrap(descriptor, executor, [ttl])` | Wrap a query execution with caching. Used internally by Query.cache(). |
| `invalidate` | `cache.invalidate(table)` | Remove all cache entries containing the table name. |
| `stats` | `cache.stats()` | Get hit/miss statistics: { size, hits, misses, hitRate, maxEntries }. |
| `flush` | `cache.flush()` | Clear the entire cache and reset stats. |
| `remember` | `cache.remember(key, fn, [ttl])` | Get a cached value by key, or compute it by calling `fn()` and cache the result. This is a read-through cache pattern — if the key exists, the cached value is returned immediately; otherwise `fn()` is awaited, the result is stored, and then returned. |


#### Static Methods

| Method | Signature | Description |
|---|---|---|
| `keyFromDescriptor` | `QueryCache.keyFromDescriptor()` | Generate a deterministic cache key from a query descriptor object. Used internally by wrap() but available for custom cache key generation. |


#### Instance Methods

| Method | Signature | Description |
|---|---|---|
| `prune` | `queryCache.prune()` | Remove all expired entries from the cache. Returns the number of entries removed. |
| `remember` | `queryCache.remember()` | Get a cached value by key, or compute it by calling fn() and cache the result. If the key exists, the cached value is returned; otherwise fn() is awaited, stored, and returned. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxEntries` | number | `1000` | Maximum cache entries (minimum 1). LRU eviction when full. |
| `defaultTTL` | number | `60` | Default TTL in seconds (minimum 0, 0 = no expiry). |
| `prefix` | string | `'qc:'` | Key prefix for cache namespacing. |
| `redis` | object | `—` | Redis adapter instance for distributed caching. |


```js
const { Database, QueryCache } = require('zero-http')

const db = Database.connect('memory')
const cache = new QueryCache({
	maxEntries: 500,
	defaultTTL: 60,  // 60 seconds
})

// Manual cache operations
cache.set('config', { theme: 'dark', lang: 'en' }, 300)
const config = cache.get('config')
cache.delete('config')

// Remember pattern — compute on miss, return from cache on hit
const users = await cache.remember('active-users', async () => {
	return await User.find({ active: true })
}, 120)

// Check if cached
if (cache.has('active-users')) {
	console.log('Cache hit!')
}

// Invalidate all user-related caches
cache.invalidate('users')

// Stats
const { size, hits, misses, hitRate } = cache.stats()
console.log(`Hit rate: ${(hitRate * 100).toFixed(1)}%`)

// Garbage collection
const pruned = cache.prune()

// Clear everything
cache.flush()
```


> **Tip:** LRU eviction removes the least-recently-used entry when maxEntries is reached.
> **Tip:** remember() is the most common pattern — avoids cache stampedes with a single call.
> **Tip:** invalidate('users') removes ALL cache entries containing 'users' in the key — perfect after writes.
> **Tip:** stats() returns hitRate as a 0–1 float — multiply by 100 for a percentage.
> **Tip:** prune() removes expired entries proactively — useful for memory-constrained environments.
> **Tip:** Pass a Redis adapter instance as options.redis for distributed caching across processes.
> **Tip:** flush() also resets hit/miss counters — useful for testing.


### Seeder & Factory

Database seeding utilities — structured data population for development and testing. Seeder defines what to seed, Factory generates records with fake data, and Fake provides built-in data generators. SeederRunner orchestrates execution.

#### Factory

| Method | Signature | Description |
|---|---|---|
| `define` | `factory.define(definition)` | Define default field generators. Values can be static or functions. |
| `count` | `factory.count(n)` | Set how many records to create. Must be a positive integer (≥ 1). |
| `state` | `factory.state(name, overrides)` | Define a named variation (e.g. 'admin'). |
| `withState` | `factory.withState(name)` | Apply a named state to the next create/make call. |
| `afterCreating` | `factory.afterCreating(fn)` | Register an after-create callback: async (record, index) => {}. |
| `make` | `factory.make([overrides])` | Build records without persisting. Returns object or array. |
| `create` | `factory.create([overrides])` | Create records and persist to database. Returns object or array. |


#### Fake

| Method | Signature | Description |
|---|---|---|
| `firstName` | `Fake.firstName()` | Random first name. |
| `lastName` | `Fake.lastName()` | Random last name. |
| `fullName` | `Fake.fullName()` | Random full name (first + last). |
| `email` | `Fake.email()` | Random email address. |
| `username` | `Fake.username()` | Random username. |
| `uuid` | `Fake.uuid()` | Random UUID v4. |
| `integer` | `Fake.integer([min], [max])` | Random integer between min and max (inclusive). |
| `float` | `Fake.float([min], [max], [decimals])` | Random float with configurable decimal places. |
| `boolean` | `Fake.boolean()` | Random true/false. |
| `date` | `Fake.date([start], [end])` | Random Date between start and end. |
| `dateString` | `Fake.dateString([start], [end])` | Random ISO date string. |
| `paragraph` | `Fake.paragraph([sentences])` | Random paragraph (default 3 sentences). |
| `sentence` | `Fake.sentence([wordCount])` | Random sentence (5–15 words). |
| `word` | `Fake.word()` | Random word. |
| `phone` | `Fake.phone()` | Random phone number. |
| `color` | `Fake.color()` | Random hex color. |
| `url` | `Fake.url()` | Random URL. |
| `ip` | `Fake.ip()` | Random IP address. |
| `pick` | `Fake.pick(array)` | Random element from an array. |
| `pickMany` | `Fake.pickMany(array, n)` | N random elements (no duplicates). |
| `json` | `Fake.json()` | Random JSON-safe object. |
| `seed` | `Fake.seed([value])` | Set a deterministic seed for reproducible fake data. Pass `null` to reset to Math.random. |
| `getSeed` | `Fake.getSeed()` | Return the active seed, or `null` if using Math.random. |
| `unique` | `Fake.unique(fn, [options])` | Generate a unique value by calling `fn()` until an unseen result is returned for the given namespace key. |
| `resetUnique` | `Fake.resetUnique([key])` | Clear uniqueness tracking for a key, or all keys if omitted. |
| `uniqueCount` | `Fake.uniqueCount(key)` | Count how many unique values have been generated for a key. |
| `middleName` | `Fake.middleName([options])` | Generate a random middle name. |
| `namePrefix` | `Fake.namePrefix([options])` | Generate a random name prefix (Mr., Ms., Dr., etc.). |
| `nameSuffix` | `Fake.nameSuffix()` | Generate a random name suffix (Jr., Sr., III, etc.). |
| `locales` | `Fake.locales()` | List all supported locale codes for name/phone generation. |
| `phoneCodes` | `Fake.phoneCodes()` | Return all supported phone country codes. |
| `domainName` | `Fake.domainName([options])` | Generate a random domain name. |
| `ipv6` | `Fake.ipv6()` | Generate a random IPv6 address. |
| `mac` | `Fake.mac([options])` | Generate a random MAC address. |
| `port` | `Fake.port([options])` | Generate a random port number. |
| `httpMethod` | `Fake.httpMethod([options])` | Generate a random HTTP method. |
| `userAgent` | `Fake.userAgent()` | Generate a random User-Agent string. |
| `password` | `Fake.password([options])` | Generate a random password. |
| `numericString` | `Fake.numericString([length], [options])` | Generate a fixed-length numeric string (e.g. ZIP codes, PINs, credit card numbers). |
| `alphanumeric` | `Fake.alphanumeric([length], [options])` | Generate a random alphanumeric string. |
| `alpha` | `Fake.alpha([length], [options])` | Generate a random alphabetic string (no digits). |
| `datePast` | `Fake.datePast([options])` | Generate a random date in the past. |
| `dateFuture` | `Fake.dateFuture([options])` | Generate a random date in the future. |
| `words` | `Fake.words([n])` | Generate `n` random words (space-separated). |
| `hackerPhrase` | `Fake.hackerPhrase()` | Generate a hacker-style phrase. |
| `slug` | `Fake.slug([wordCount])` | Generate a URL-safe slug. |
| `hashtag` | `Fake.hashtag()` | Generate a random hashtag. |
| `jobTitle` | `Fake.jobTitle([options])` | Generate a random job title. |
| `jobArea` | `Fake.jobArea()` | Generate a random job area/department. |
| `jobType` | `Fake.jobType()` | Generate a random job type (e.g. Engineer, Designer). |
| `jobDescriptor` | `Fake.jobDescriptor()` | Generate a random job descriptor (e.g. Senior, Lead). |
| `bio` | `Fake.bio([options])` | Generate a random biography string. |
| `zodiacSign` | `Fake.zodiacSign()` | Generate a random zodiac sign. |
| `gender` | `Fake.gender([options])` | Generate a random gender. |
| `bloodType` | `Fake.bloodType()` | Generate a random blood type. |
| `city` | `Fake.city([options])` | Generate a random city name. |
| `country` | `Fake.country([options])` | Generate a random country name or code. |
| `state` | `Fake.state([options])` | Generate a random US state. |
| `zipCode` | `Fake.zipCode([options])` | Generate a random ZIP/postal code. |
| `latitude` | `Fake.latitude([options])` | Generate a random latitude. |
| `longitude` | `Fake.longitude([options])` | Generate a random longitude. |
| `coordinates` | `Fake.coordinates()` | Generate random latitude/longitude coordinates. |
| `timezone` | `Fake.timezone()` | Generate a random timezone string. |
| `streetName` | `Fake.streetName()` | Generate a random street name. |
| `address` | `Fake.address([options])` | Generate a full address string or structured address object. |
| `productName` | `Fake.productName([options])` | Generate a random product name. |
| `category` | `Fake.category()` | Generate a random product category. |
| `department` | `Fake.department()` | Generate a random department name. |
| `company` | `Fake.company([options])` | Generate a random company name. |
| `price` | `Fake.price([options])` | Generate a random price string. |
| `industry` | `Fake.industry()` | Generate a random industry name. |
| `catchPhrase` | `Fake.catchPhrase()` | Generate a random business catch phrase. |
| `rgb` | `Fake.rgb([options])` | Generate a random RGB color. |
| `hsl` | `Fake.hsl([options])` | Generate a random HSL color. |
| `shuffle` | `Fake.shuffle(arr)` | Shuffle an array in-place using Fisher-Yates algorithm. |
| `enumValue` | `Fake.enumValue(values)` | Pick a random value from an array. Identical to `pick` but named for enum-like usage. |


#### SeederRunner

| Method | Signature | Description |
|---|---|---|
| `run` | `runner.run(...seeders)` | Run one or more Seeder classes. Returns names of seeders that ran. |
| `call` | `runner.call(SeederClass)` | Run a single seeder. |
| `fresh` | `runner.fresh(...seeders)` | Truncate all tables, then run seeders. |


```js
const { Database, Model, TYPES, Seeder, SeederRunner, Factory, Fake } = require('zero-http')

// --- Model ---
class User extends Model {
	static table = 'users'
	static schema = {
		id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		name:  { type: TYPES.STRING, required: true },
		email: { type: TYPES.STRING, required: true },
		role:  { type: TYPES.STRING, default: 'user' },
	}
}

// --- Factory with Fake data ---
const userFactory = new Factory(User)
userFactory.define({
	name:  () => Fake.fullName(),
	email: () => Fake.email(),
	role:  'user',
})
userFactory.state('admin', { role: 'admin' })

// Build without persisting
const data = userFactory.count(5).make()

// Create and persist
const users = await userFactory.count(10).create()
const admins = await userFactory.count(3).withState('admin').create()

// --- Seeder class ---
class UserSeeder extends Seeder {
	async run(db) {
		const factory = new Factory(User)
		factory.define({
			name:  () => Fake.fullName(),
			email: () => Fake.email(),
		})
		await factory.count(50).create()
	}
}

// --- SeederRunner ---
const db = Database.connect('memory')
db.register(User)
await db.sync()

const runner = new SeederRunner(db)
await runner.run(UserSeeder)

// Fresh — truncate all then re-seed
await runner.fresh(UserSeeder)

// --- Fake data generators ---
console.log(Fake.fullName())   // 'Alice Johnson'
console.log(Fake.email())      // 'bob.smith42@example.com'
console.log(Fake.uuid())       // 'a1b2c3d4-e5f6-4789-...'
console.log(Fake.integer(1, 100))  // 42
console.log(Fake.sentence())   // 'Lorem ipsum dolor sit amet.'
console.log(Fake.phone())      // '(555) 123-4567'
console.log(Fake.color())      // '#3a7f2b'
console.log(Fake.ip())         // '192.168.1.42'
console.log(Fake.pick(['a', 'b', 'c']))  // 'b'
```


> **Tip:** Factory.make() returns a single object when count is 1, an array when count > 1.
> **Tip:** Factory.create() persists to the database — make() just builds plain objects.
> **Tip:** Use state() + withState() for variations: factory.state('admin', { role: 'admin' }).
> **Tip:** afterCreating() runs after each record is persisted — perfect for creating related records.
> **Tip:** Fake works with zero dependencies — no need for faker.js or similar libraries.
> **Tip:** Fake.pick() and Fake.pickMany() are great for selecting from enums or option lists.
> **Tip:** SeederRunner.fresh() clears all data before seeding — ideal for resetting test databases.
> **Tip:** Extend Seeder and implement run(db) — SeederRunner instantiates and executes them for you.


### QueryProfiler

Automatic query profiling, slow-query detection, and N+1 pattern identification. Attach to any Database instance via db.enableProfiling(). Records every query execution with timing, flags queries exceeding a configurable threshold, and detects rapid repeated SELECTs on the same table within a time window. Capped history prevents memory leaks in long-running servers.

#### Profiler

| Method | Signature | Description |
|---|---|---|
| `reset` | `profiler.reset()` | Clear all profiling state — queries, counters, and N+1 detections. |
| `record` | `profiler.record(entry)` | Record a query execution. Called automatically when profiling is enabled; useful for manual recording. |
| `metrics` | `profiler.metrics()` | Get aggregate profiling metrics: total queries, average latency, queries/sec, slow query count, and N+1 detection count. |
| `slowQueries` | `profiler.slowQueries()` | Get all queries from history that exceeded the slow threshold. |
| `n1Detections` | `profiler.n1Detections()` | Get all detected N+1 query patterns. |
| `getQueries` | `profiler.getQueries([options])` | Get filtered query history. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable/disable profiling. |
| `slowThreshold` | number | `100` | Duration in ms above which a query is flagged as slow. |
| `maxHistory` | number | `1000` | Maximum number of query entries retained in memory. |
| `onSlow` | function | `null` | Callback invoked on every slow query: (entry) => {}. |
| `n1Threshold` | number | `5` | Minimum rapid same-table SELECTs to flag as N+1. |
| `n1Window` | number | `100` | Time window in ms for N+1 detection. |
| `onN1` | function | `null` | Callback invoked on N+1 detection: (info) => {}. |
| `maxN1History` | number | `100` | Maximum N+1 detection entries to retain. Oldest entries are evicted when exceeded. |


```js
const { Database, Model, TYPES, QueryProfiler } = require('zero-http')

const db = Database.connect('memory')

// Enable profiling with custom threshold
const profiler = db.enableProfiling({
	slowThreshold: 50,
	maxHistory: 500,
	onSlow: (entry) => console.warn('Slow:', entry.table, entry.duration + 'ms'),
	n1Threshold: 3,
	onN1: (info) => console.warn(info.message),
})

class User extends Model {
	static table = 'users'
	static schema = {
		id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
		name: { type: TYPES.STRING },
	}
}
db.register(User)
await db.sync()

await User.create({ name: 'Alice' })
await User.create({ name: 'Bob' })
await User.all()

// Check aggregate metrics
console.log(profiler.metrics())
// { totalQueries: 3, totalTime: ..., avgLatency: ..., queriesPerSecond: ..., slowQueries: 0, n1Detections: 0 }

// Filter query history
const selects = profiler.getQueries({ action: 'select' })
console.log(selects.length)

// Toggle profiling at runtime
profiler.enabled = false
profiler.enabled = true

// Reset all state
profiler.reset()
```


> **Tip:** enableProfiling() returns the profiler — store it or access later via db.profiler.
> **Tip:** slowThreshold defaults to 100 ms — lower it during development, raise it in production.
> **Tip:** maxHistory caps query retention to prevent memory growth in long-running processes.
> **Tip:** onSlow and onN1 callbacks let you pipe alerts to external monitoring (Sentry, Datadog, etc.).
> **Tip:** N+1 detection watches for repeated SELECTs on the same table within n1Window ms — tune n1Threshold for your workload.
> **Tip:** Use profiler.reset() between test runs to isolate measurements.
> **Tip:** maxN1History caps N+1 detection entries — prevents unbounded memory growth from recurring patterns.


### ReplicaManager

Read replica load balancing for horizontal read scaling. Distributes read queries across replica database connections using round-robin or random strategies. Supports health checks, sticky writes (reads go to primary briefly after a write to avoid stale data), and automatic fallback to primary when all replicas are down.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `setPrimary` | `manager.setPrimary(adapter)` | Set the primary (read-write) adapter. Throws if adapter is null. |
| `addReplica` | `manager.addReplica(adapter)` | Add a read replica adapter to the pool. |
| `removeReplica` | `manager.removeReplica(adapter)` | Remove a replica adapter from the pool. |
| `getReadAdapter` | `manager.getReadAdapter()` | Get the next read adapter. Returns primary during sticky window after a write, otherwise selects from healthy replicas using the configured strategy. Falls back to primary if no healthy replicas. |
| `getWriteAdapter` | `manager.getWriteAdapter()` | Get the primary adapter for write operations. Records the write timestamp for sticky-write tracking. |
| `markUnhealthy` | `manager.markUnhealthy(adapter)` | Mark a replica as unhealthy. It will be excluded from read selection until marked healthy. |
| `markHealthy` | `manager.markHealthy(adapter)` | Mark a previously unhealthy replica as healthy again. |
| `healthCheck` | `await manager.healthCheck()` | Ping all replicas and automatically mark them healthy or unhealthy based on response. |
| `status` | `manager.status()` | Return pool status: { primary, total, healthy, unhealthy, strategy }. |


#### Replica Management

| Method | Signature | Description |
|---|---|---|
| `setPrimary` | `manager.setPrimary(adapter)` | Set the primary (read-write) adapter. |
| `addReplica` | `manager.addReplica(adapter)` | Add a read replica adapter to the pool. |
| `getReadAdapter` | `manager.getReadAdapter()` | Get an adapter for read operations. Respects the configured strategy (round-robin/random), health status, and sticky-write window. |
| `getWriteAdapter` | `manager.getWriteAdapter()` | Get the primary adapter for write operations. Updates the sticky-write timestamp if `stickyWrite` is enabled. |
| `markUnhealthy` | `manager.markUnhealthy(adapter)` | Mark a replica as unhealthy. It will be excluded from read routing until marked healthy again. |
| `markHealthy` | `manager.markHealthy(adapter)` | Mark a previously unhealthy replica as healthy, returning it to the read pool. |
| `healthCheck` | `manager.healthCheck()` | Run a health check on all replicas. Pings each adapter and updates its health status. |
| `getAllAdapters` | `manager.getAllAdapters()` | Get all adapters (primary + all replicas). |
| `closeAll` | `manager.closeAll()` | Close all adapter connections (primary and all replicas). |


#### Instance Properties

| Method | Signature | Description |
|---|---|---|
| `replicaCount` | `replicaManager.replicaCount` | The number of registered read replicas. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `strategy` | string | `'round-robin'` | Replica selection strategy. Must be 'round-robin' or 'random'. Throws on invalid value. |
| `stickyWrite` | boolean | `true` | When true, reads go to primary for a brief window after a write to avoid stale data. |
| `stickyWindow` | number | `1000` | Duration in ms to read from primary after a write (sticky-write window). |


```js
const { Database, ReplicaManager } = require('zero-http')

// Using the static helper
const db = Database.connectWithReplicas('memory',
	{},
	[{}, {}],
	{ strategy: 'round-robin', stickyWindow: 2000 }
)

console.log(db.replicas.status())
// { primary: true, total: 2, healthy: 2, unhealthy: 0, strategy: 'round-robin' }

// Manual setup
const manager = new ReplicaManager({ strategy: 'random' })
const primary = Database.connect('memory')
manager.setPrimary(primary.adapter)

const replica1 = Database.connect('memory')
const replica2 = Database.connect('memory')
manager.addReplica(replica1.adapter)
manager.addReplica(replica2.adapter)

// Get adapters for read/write
const reader = manager.getReadAdapter()
const writer = manager.getWriteAdapter()

// Health management
manager.markUnhealthy(replica1.adapter)
console.log(manager.status().unhealthy) // 1
manager.markHealthy(replica1.adapter)

// Automatic health check (calls adapter.ping())
await manager.healthCheck()
```


> **Tip:** connectWithReplicas() is the easiest way to set up replicas — it wires everything automatically.
> **Tip:** Sticky writes prevent reading stale data right after a write — keep stickyWindow short (1-2s).
> **Tip:** healthCheck() pings every replica — run it on an interval in production for automatic failover.
> **Tip:** Use onReplica() in queries to explicitly route a specific query to a read replica.
> **Tip:** strategy must be 'round-robin' or 'random' — invalid values throw immediately.
> **Tip:** If all replicas are unhealthy, reads automatically fall back to the primary.



---

## Real-Time

### WebSocket

Built-in RFC 6455 WebSocket server. Register handlers with app.ws(path, handler). Each connection receives a WebSocketConnection instance with send/receive, ping/pong, binary support, and event emitter methods. Configure max payload size, ping intervals, and client verification.

#### Messaging

| Method | Signature | Description |
|---|---|---|
| `send` | `ws.send(data)` | Send a text or binary message. |
| `sendJSON` | `ws.sendJSON(obj)` | Send a JSON-serialized message. |
| `ping` | `ws.ping([data])` | Send a ping frame. |
| `pong` | `ws.pong([data])` | Send a pong frame. |


#### Events

| Method | Signature | Description |
|---|---|---|
| `on` | `ws.on(event, handler)` | Listen for events: message, close, error, ping, pong, drain. |
| `once` | `ws.once(event, handler)` | Listen for an event once. |
| `off` | `ws.off(event, handler)` | Remove an event listener. |


#### Lifecycle

| Method | Signature | Description |
|---|---|---|
| `close` | `ws.close([code], [reason])` | Graceful close with optional status code and reason. |
| `terminate` | `ws.terminate()` | Forcefully close the connection. |


#### Connection Properties

| Method | Signature | Description |
|---|---|---|
| `id` | `ws.id` | Unique connection identifier. |
| `readyState` | `ws.readyState` | Current WebSocket ready state (0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED). |
| `protocol` | `ws.protocol` | The negotiated sub-protocol string. |
| `extensions` | `ws.extensions` | The requested extensions string. |
| `headers` | `ws.headers` | Request headers from the upgrade handshake. |
| `ip` | `ws.ip` | Remote IP address of the connected client. |
| `query` | `ws.query` | Parsed query parameters from the upgrade URL. |
| `url` | `ws.url` | The full upgrade URL. |
| `secure` | `ws.secure` | Whether the connection is over TLS. |
| `maxPayload` | `ws.maxPayload` | Maximum incoming payload size in bytes. |
| `connectedAt` | `ws.connectedAt` | Timestamp (ms since epoch) when the connection was opened. |
| `data` | `ws.data` | Arbitrary user-data store for attaching custom data to the connection. |
| `bufferedAmount` | `ws.bufferedAmount` | Number of bytes waiting in the send buffer (readonly). |
| `uptime` | `ws.uptime` | Milliseconds since the connection was opened (readonly). |


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

#### Membership

| Method | Signature | Description |
|---|---|---|
| `add` | `pool.add(ws)` | Add a connection to the pool. Auto-removed on close. |
| `remove` | `pool.remove(ws)` | Remove a connection from the pool and all rooms. |


#### Rooms

| Method | Signature | Description |
|---|---|---|
| `join` | `pool.join(ws, room)` | Join a connection to a named room. |
| `leave` | `pool.leave(ws, room)` | Leave a room. |
| `in` | `pool.in(room)` | Get all connections in a room. |
| `roomsOf` | `pool.roomsOf(ws)` | Get all rooms a connection is in. |


#### Broadcasting

| Method | Signature | Description |
|---|---|---|
| `broadcast` | `pool.broadcast(msg, [exclude])` | Send to all connections. |
| `broadcastJSON` | `pool.broadcastJSON(obj, [exclude])` | Send JSON to all connections. |
| `toRoom` | `pool.toRoom(room, msg, [exclude])` | Send to all in a room. |
| `toRoomJSON` | `pool.toRoomJSON(room, obj, [exclude])` | Send JSON to all in a room. |


#### Introspection

| Method | Signature | Description |
|---|---|---|
| `size` | `pool.size` | Total connection count. |
| `clients` | `pool.clients` | All connections as an iterable. |
| `rooms` | `pool.rooms` | Array of all room names. |
| `roomSize` | `pool.roomSize(room)` | Number of connections in a room. |


#### Lifecycle

| Method | Signature | Description |
|---|---|---|
| `closeAll` | `pool.closeAll([code], [reason])` | Close all connections. |


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

#### Properties

| Method | Signature | Description |
|---|---|---|
| `connected` | `sse.connected` | Whether the stream is still open. |
| `lastEventId` | `sse.lastEventId` | The Last-Event-ID from client reconnection. |
| `eventCount` | `sse.eventCount` | Total events sent on this stream. |
| `bytesSent` | `sse.bytesSent` | Total bytes written to the stream. |
| `connectedAt` | `sse.connectedAt` | Timestamp (ms) when the stream was opened. |
| `uptime` | `sse.uptime` | Milliseconds since the stream was opened. |
| `secure` | `sse.secure` | Whether the connection is over TLS. |
| `data` | `sse.data` | Arbitrary user-data store for attaching custom properties. |


#### Writing

| Method | Signature | Description |
|---|---|---|
| `send` | `sse.send(data)` | Send a data-only event. |
| `sendJSON` | `sse.sendJSON(obj)` | Send a JSON-serialized event. |
| `event` | `sse.event(name, data)` | Send a named event. Browser listens with es.addEventListener(name, ...). |
| `comment` | `sse.comment(text)` | Send a comment line (not received by EventSource). |


#### Control

| Method | Signature | Description |
|---|---|---|
| `retry` | `sse.retry(ms)` | Set the reconnection interval for the client. |
| `keepAlive` | `sse.keepAlive(ms)` | Start sending periodic comment pings. |
| `flush` | `sse.flush()` | Flush the response stream. |
| `close` | `sse.close()` | Close the SSE stream. |


#### Events

| Method | Signature | Description |
|---|---|---|
| `on` | `sse.on(event, handler)` | Listen for events: close, error. |
| `once` | `sse.once(event, handler)` | Listen for an event once, then auto-remove the handler. |
| `off` | `sse.off(event, handler)` | Remove a specific event listener. |
| `removeAllListeners` | `sse.removeAllListeners(event?)` | Remove all listeners for a given event, or all events if omitted. |
| `listenerCount` | `sse.listenerCount(event)` | Return the number of listeners registered for the given event. |


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


#### Response Object

| Method | Signature | Description |
|---|---|---|
| `status` | `response.status` | HTTP status code (e.g. `200`, `404`). |
| `statusText` | `response.statusText` | HTTP status reason phrase (e.g. `"OK"`, `"Not Found"`). |
| `ok` | `response.ok` | `true` if status is 200-299. |
| `secure` | `response.secure` | `true` if the response came over HTTPS. |
| `url` | `response.url` | The final URL after any redirects. |
| `headers` | `response.headers` | Response headers object with `get(name)` method and `raw` property. |
| `get` | `response.headers.get(name)` | Get a response header value by name. |
| `raw` | `response.headers.raw` | Raw headers as a plain object. Multi-value headers are arrays. |
| `text` | `response.text()` | Read the body as a UTF-8 string. |
| `json` | `response.json()` | Read the body and parse as JSON. |
| `arrayBuffer` | `response.arrayBuffer()` | Read the body as a Buffer. |


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
| `agent` | http.Agent \| https.Agent | `—` | Custom HTTP(S) agent for connection pooling or proxy support. |


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

#### Base Class

| Method | Signature | Description |
|---|---|---|
| `HttpError` | `new HttpError(statusCode, [message], [opts])` | Base class. opts: { code, details }. |


#### 4xx Client Errors

| Method | Signature | Description |
|---|---|---|
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


#### 5xx Server Errors

| Method | Signature | Description |
|---|---|---|
| `InternalError` | `new InternalError([message], [opts])` | 500 Internal Server Error. |
| `NotImplementedError` | `new NotImplementedError([message], [opts])` | 501 Not Implemented. |
| `BadGatewayError` | `new BadGatewayError([message], [opts])` | 502 Bad Gateway. |
| `ServiceUnavailableError` | `new ServiceUnavailableError([message], [opts])` | 503 Service Unavailable. |


#### Utilities

| Method | Signature | Description |
|---|---|---|
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

#### Database & Query Errors

| Method | Signature | Description |
|---|---|---|
| `DatabaseError` | `new DatabaseError([message], [opts])` | 500 — Database/ORM failure. opts: { query, adapter, details }. Thrown on adapter-level failures. |
| `QueryError` | `new QueryError([message], [opts])` | 500 — Query execution failure. Extends DatabaseError. opts: { sql, params, table }. |
| `MigrationError` | `new MigrationError([message], [opts])` | 500 — Migration execution failure. Extends DatabaseError. opts: { migration, direction, batch }. |
| `TransactionError` | `new TransactionError([message], [opts])` | 500 — Transaction commit/rollback failure. Extends DatabaseError. opts: { phase }. phase: 'begin', 'commit', or 'rollback'. |
| `AdapterError` | `new AdapterError([message], [opts])` | 500 — Adapter-level issue (driver missing, unsupported op). Extends DatabaseError. opts: { adapter, operation }. |
| `CacheError` | `new CacheError([message], [opts])` | 500 — Caching layer failure. opts: { operation, key }. |
| `ConnectionError` | `new ConnectionError([message], [opts])` | 500 — Database connection failure. Extends DatabaseError. opts: { adapter, attempt, maxRetries, host, port }. |


#### Application Errors

| Method | Signature | Description |
|---|---|---|
| `ConfigurationError` | `new ConfigurationError([message], [opts])` | 500 — Invalid configuration. opts: { setting, details }. Thrown when app/adapter config is invalid. |
| `MiddlewareError` | `new MiddlewareError([message], [opts])` | 500 — Middleware failure. opts: { middleware, details }. Thrown when a middleware function fails unexpectedly. |
| `RoutingError` | `new RoutingError([message], [opts])` | 500 — Routing failure. opts: { path, method, details }. Thrown when route resolution fails. |
| `TimeoutError` | `new TimeoutError([message], [opts])` | 408 — Operation timed out. opts: { timeout, details }. Thrown when a request exceeds the allowed time. |


```js
const { DatabaseError, ConfigurationError, MiddlewareError,
	RoutingError, TimeoutError, ConnectionError, MigrationError,
	TransactionError, QueryError, AdapterError, CacheError,
	isHttpError } = require('zero-http')

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

// Connection error with retry context
throw new ConnectionError('Redis connection refused', {
	adapter: 'redis',
	attempt: 3,
	maxRetries: 5,
	host: '127.0.0.1',
	port: 6379
})

// Migration error
throw new MigrationError('Column already exists', {
	migration: '003_add_avatar',
	direction: 'up',
	batch: 2
})

// Transaction error
throw new TransactionError('Deadlock detected', {
	phase: 'commit'
})

// Query error with SQL context
throw new QueryError('Syntax error near FROM', {
	sql: 'SELECT * FORM users',
	params: [],
	table: 'users'
})

// Adapter error
throw new AdapterError('ioredis not installed', {
	adapter: 'redis',
	operation: 'connect'
})

// Cache error
throw new CacheError('Serialization failed', {
	operation: 'set',
	key: 'users:active'
})

// Differentiate error types in error handler
app.onError((err, req, res, next) => {
	if (err instanceof ConnectionError) {
		console.error('Connection failed:', err.host, err.port, `attempt ${err.attempt}/${err.maxRetries}`)
		res.status(503).json({ error: 'Database unavailable' })
	} else if (err instanceof MigrationError) {
		console.error('Migration failed:', err.migration, err.direction)
		res.status(500).json({ error: 'Migration error' })
	} else if (err instanceof DatabaseError) {
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
> **Tip:** ConnectionError extends DatabaseError — adds .attempt, .maxRetries, .host, .port for retry tracking.
> **Tip:** MigrationError extends DatabaseError — .migration, .direction ('up'/'down'), .batch identify the failure.
> **Tip:** TransactionError extends DatabaseError — .phase tells you if it failed on begin, commit, or rollback.
> **Tip:** QueryError extends DatabaseError — .sql, .params, .table give full query context for debugging.
> **Tip:** AdapterError extends DatabaseError — .operation identifies what the adapter was trying to do.
> **Tip:** CacheError carries .operation and .key — pinpoints exactly which cache operation failed.
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

#### Logger Creation

| Method | Signature | Description |
|---|---|---|
| `debug(namespace)` | `debug('app:routes')` | Create a namespaced logger. Returns a function with level methods. |
| `log()` | `log(...args)` | Log at debug level (default call). Supports %s, %d, %j format specifiers. |


#### Log Levels

| Method | Signature | Description |
|---|---|---|
| `log.trace()` | `log.trace(...args)` | Log at trace level (most verbose). |
| `log.info()` | `log.info(...args)` | Log at info level. |
| `log.warn()` | `log.warn(...args)` | Log at warn level. |
| `log.error()` | `log.error(...args)` | Log at error level. |
| `log.fatal()` | `log.fatal(...args)` | Log at fatal level (most severe). |
| `trace` | `log.trace(...args)` | Log at trace level (level 0). |
| `debug` | `log.debug(...args)` | Log at debug level (level 1). |
| `info` | `log.info(...args)` | Log at info level (level 2). |
| `warn` | `log.warn(...args)` | Log at warn level (level 3). |
| `error` | `log.error(...args)` | Log at error level (level 4). |
| `fatal` | `log.fatal(...args)` | Log at fatal level (level 5). |


#### Configuration

| Method | Signature | Description |
|---|---|---|
| `debug.level()` | `debug.level('info')` | Set minimum log level globally. Levels: trace, debug, info, warn, error, fatal, silent. |
| `debug.enable()` | `debug.enable('app:*')` | Enable namespaces by pattern. Same syntax as DEBUG env var. |
| `debug.disable()` | `debug.disable()(pattern)` | Disable all debug output. |
| `debug.json()` | `debug.json(true)` | Enable structured JSON output (for log aggregators). |
| `debug.timestamps()` | `debug.timestamps(false)` | Toggle timestamps. |
| `debug.colors()` | `debug.colors(false)` | Toggle ANSI colors. |
| `debug.output()` | `debug.output(stream)` | Set custom output stream (default: stderr). |
| `debug.reset()` | `debug.reset()` | Reset all settings to defaults. |
| `level` | `debug.level(level)` | Set the minimum log level globally. |
| `enable` | `debug.enable(patterns)` | Enable/disable namespaces. Same syntax as the `DEBUG` env var. |
| `disable` | `debug.disable()` | Disable all debug output. |
| `json` | `debug.json([on])` | Enable/disable structured JSON output. |
| `timestamps` | `debug.timestamps([on])` | Enable/disable timestamps in log output. |
| `colors` | `debug.colors([on])` | Enable/disable colored output. |
| `output` | `debug.output(stream)` | Set a custom output stream. |


#### Logger Properties

| Method | Signature | Description |
|---|---|---|
| `enabled` | `log.enabled` | Whether this logger is enabled based on current namespace/level settings (readonly). |
| `namespace` | `log.namespace` | The namespace this logger was created with (readonly). |


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
