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
  - [errorHandler](#errorhandler)
- [Cookies & Security](#cookies-security)
  - [cookieParser](#cookieparser)
  - [csrf](#csrf)
  - [validate](#validate)
- [Authentication & Sessions](#authentication-sessions)
  - [jwt](#jwt)
  - [session](#session)
  - [oauth](#oauth)
  - [authorize](#authorize)
- [Environment](#environment)
  - [env](#env)
  - [.env File Format](#env-file-format)
  - [Schema Types](#schema-types)
- [Real-Time](#real-time)
  - [WebSocket](#websocket)
  - [WebSocketPool](#websocketpool)
  - [SSE (Server-Sent Events)](#sse-server-sent-events)
- [Networking](#networking)
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
  - [DatabaseView](#databaseview)
  - [FullTextSearch](#fulltextsearch)
  - [GeoQuery](#geoquery)
  - [TenantManager](#tenantmanager)
  - [AuditLog](#auditlog)
  - [PluginManager](#pluginmanager)
  - [StoredProcedure](#storedprocedure)
  - [CLI](#cli)
- [Observability](#observability)
  - [structuredLogger](#structuredlogger)
  - [MetricsRegistry](#metricsregistry)
  - [Tracer](#tracer)
  - [healthCheck](#healthcheck)
- [Lifecycle & Clustering](#lifecycle-clustering)
  - [LifecycleManager](#lifecyclemanager)
  - [ClusterManager](#clustermanager)
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

HTTP application with middleware pipeline, method-based routing, HTTP/2, HTTPS, and HTTP/1.1 support, built-in WebSocket upgrade handling, trust proxy resolution, and route introspection. Created via `createApp()` in the public API.

#### Settings

| Method | Signature | Description |
|---|---|---|
| `set` | `set(key, [val])` | Set an application setting, or retrieve one when called with a single argument. When called with two arguments, sets the value and returns `this` for chaining. When called with one argument, returns the stored value. Common settings: `'trust proxy'`, `'env'`, `'json spaces'`, `'etag'`, `'view engine'`, `'views'`, `'case sensitive routing'`. |
| `enable` | `enable(key)` | Set a boolean setting to `true`. |
| `disable` | `disable(key)` | Set a boolean setting to `false`. |
| `enabled` | `enabled(key)` | Check if a setting is truthy. |
| `disabled` | `disabled(key)` | Check if a setting is falsy. |


#### Middleware

| Method | Signature | Description |
|---|---|---|
| `use` | `use(pathOrFn, [fn])` | Register middleware or mount a sub-router. - `use(fn)` — global middleware applied to every request. - `use('/prefix', fn)` — path-scoped middleware (strips the prefix before calling `fn` so downstream sees relative paths). - `use('/prefix', router)` — mount a Router sub-app at the given prefix. |
| `onError` | `onError(fn)` | Register a global error handler. The handler receives `(err, req, res, next)` and is invoked whenever a middleware or route handler throws or passes an error to `next(err)`. |
| `param` | `param(name, fn)` | Register a parameter pre-processing handler. Runs before route handlers for any route containing a `:name` parameter. |


#### Request Handling

| Method | Signature | Description |
|---|---|---|
| `handle` | `handle(req, res)` | Core request handler.  Wraps the raw Node `req`/`res` in `Request`/`Response` wrappers, runs the middleware pipeline, then falls through to the router. |


#### Server Lifecycle

| Method | Signature | Description |
|---|---|---|
| `listen` | `listen([port], [opts], [cb])` | Start listening for HTTP, HTTPS, or HTTP/2 connections. |
| `close` | `close([cb])` | Gracefully close the server, stopping new connections. |
| `shutdown` | `shutdown([opts])` | Perform a full graceful shutdown. Stops accepting new connections, drains in-flight requests, closes WebSocket and SSE connections, and shuts down registered databases. |


#### Lifecycle Events

| Method | Signature | Description |
|---|---|---|
| `on` | `on(event, fn)` | Register a lifecycle event listener. Supported events: - `'beforeShutdown'` — fires before shutdown begins (flush caches, finish writes) - `'shutdown'`       — fires after shutdown is complete |
| `off` | `off(event, fn)` | Remove a lifecycle event listener. |


#### Lifecycle Resource Registration

| Method | Signature | Description |
|---|---|---|
| `registerPool` | `registerPool(pool)` | Register a WebSocket pool for graceful shutdown. All connections in the pool are closed with code `1001` when the server shuts down. |
| `unregisterPool` | `unregisterPool(pool)` | Unregister a WebSocket pool from lifecycle management. |
| `trackSSE` | `trackSSE(stream)` | Track an SSE stream for graceful shutdown. The stream is automatically untracked when it closes. |
| `registerDatabase` | `registerDatabase(db)` | Register an ORM Database instance for graceful shutdown. The database connection is closed during shutdown. |
| `unregisterDatabase` | `unregisterDatabase(db)` | Unregister an ORM Database instance from lifecycle management. |
| `shutdownTimeout` | `shutdownTimeout(ms)` | Configure the shutdown timeout—the maximum time (ms) to wait for in-flight requests to finish before forcefully terminating them. |
| `lifecycleState` | `lifecycleState()` | Current lifecycle state. |


#### Observability

| Method | Signature | Description |
|---|---|---|
| `health` | `health([path], [checks])` | Register a liveness health check endpoint. Returns `200` when healthy, `503` during shutdown. |
| `ready` | `ready([path], [checks])` | Register a readiness health check endpoint. Returns `200` when all checks pass, `503` otherwise. |
| `addHealthCheck` | `addHealthCheck(name, fn)` | Register a custom health check. |
| `metrics` | `metrics()` | Get the application metrics registry. Lazily created on first access. Returns a `MetricsRegistry` instance for registering custom metrics. |
| `metricsEndpoint` | `metricsEndpoint([path], [opts])` | Mount a Prometheus metrics endpoint. |


#### WebSocket Support

| Method | Signature | Description |
|---|---|---|
| `ws` | `ws(path, [opts], handler)` | Register a WebSocket upgrade handler for a path. The handler receives `(ws, req)` where `ws` is a `WebSocketConnection` instance with methods like `send()`, `sendJSON()`, `on()`, and `close()`. |


#### Route Introspection

| Method | Signature | Description |
|---|---|---|
| `routes` | `routes()` | Return a flat list of all registered routes across the router tree, including mounted sub-routers.  Useful for debugging, auto-generated docs, or CLI tooling. |


#### Route Registration

| Method | Signature | Description |
|---|---|---|
| `route` | `route(method, path, ...fns)` | Register one or more handler functions for a specific HTTP method and path. |
| `get` | `get(path, ...fns)` | Shortcut for GET requests. |
| `post` | `post(path, ...fns)` | Shortcut for POST requests. |
| `put` | `put(path, ...fns)` | Shortcut for PUT requests. |
| `delete` | `delete(path, ...fns)` | Shortcut for DELETE requests. |
| `patch` | `patch(path, ...fns)` | Shortcut for PATCH requests. |
| `options` | `options(path, ...fns)` | Shortcut for OPTIONS requests. |
| `head` | `head(path, ...fns)` | Shortcut for HEAD requests. |
| `all` | `all(path, ...fns)` | Matches every HTTP method. |
| `chain` | `chain(path)` | Chainable route builder — register multiple methods on the same path. |
| `group` | `group(prefix, ...middleware)` | Define a route group with shared middleware prefix. All routes registered inside the callback share the given path prefix and middleware stack. |


#### Authentication & Sessions

| Method | Signature | Description |
|---|---|---|
| `jwtAuth` | `jwtAuth(opts)` | Mount JWT authentication middleware. Shorthand for `app.use(jwt(opts))`. |
| `sessions` | `sessions(opts)` | Mount session middleware. Shorthand for `app.use(session(opts))`. |
| `oauth` | `oauth(opts)` | Create an OAuth2 client bound to this app. Returns the client — does NOT mount any middleware automatically. |


```js
  const { createApp } = require('zero-http');
  const app = createApp();

  app.use(logger());
  app.get('/hello', (req, res) => res.json({ hello: 'world' }));
  app.listen(3000);
```


### Router

Full-featured pattern-matching router with named parameters, wildcard catch-alls, sequential handler chains, sub-router mounting, and route introspection.

#### Core

| Method | Signature | Description |
|---|---|---|
| `add` | `add(method, path, handlers, [options])` | Register a route. |
| `use` | `use(prefix, router)` | Mount a child Router under a path prefix. Requests matching the prefix are delegated to the child router with the prefix stripped from `req.url`. |
| `handle` | `handle(req, res)` | Match an incoming request against the route table and execute the first matching handler chain.  Delegates to child routers when mounted. Sends a 404 JSON response when no route matches. |


#### Route Shortcuts

| Method | Signature | Description |
|---|---|---|
| `get` | `get(path, ...fns)` | Shortcut for GET requests. |
| `post` | `post(path, ...fns)` | Shortcut for POST requests. |
| `put` | `put(path, ...fns)` | Shortcut for PUT requests. |
| `delete` | `delete(path, ...fns)` | Shortcut for DELETE requests. |
| `patch` | `patch(path, ...fns)` | Shortcut for PATCH requests. |
| `options` | `options(path, ...fns)` | Shortcut for OPTIONS requests. |
| `head` | `head(path, ...fns)` | Shortcut for HEAD requests. |
| `all` | `all(path, ...fns)` | Matches every HTTP method. |
| `route` | `route(path)` | Chainable route builder — register multiple methods on the same path. |


#### Introspection

| Method | Signature | Description |
|---|---|---|
| `inspect` | `inspect([prefix])` | Return a flat list of all registered routes, including those in mounted child routers.  Useful for debugging or auto-documentation. |


```js
  const { Router } = require('zero-http');

  const api = new Router();

  api.get('/users/:id', (req, res) => {
      res.json({ id: req.params.id });
  });

  api.route('/posts')
      .get((req, res) => res.json([]))
      .post((req, res) => res.json({ created: true }));

  app.use('/api', api);
```


### Request

Lightweight wrapper around Node's `IncomingMessage`. Provides parsed query string, params, body, and convenience helpers. Supports trust-proxy configuration via `app.set('trust proxy', value)` to correctly resolve `req.ip`, `req.ips`, `req.protocol`, `req.secure`, and `req.hostname` when behind reverse proxies. HTTP/2 compatible — detects pseudo-headers (`:method`, `:path`, `:authority`) from HTTP/2 requests automatically.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `req` | import('http').IncomingMessage | Yes | Raw Node incoming message. |


#### Trust Proxy Resolution

| Method | Signature | Description |
|---|---|---|
| `ip` | `ip()` | Client IP address. When `trust proxy` is enabled, resolves through the X-Forwarded-For chain. |
| `ips` | `ips()` | Full proxy chain from X-Forwarded-For (client → proxy1 → proxy2 → socket). Empty array when `trust proxy` is not enabled. |
| `protocol` | `protocol()` | Request protocol (`'https'` or `'http'`). Reads `X-Forwarded-Proto` when behind a trusted proxy. |
| `secure` | `secure()` | `true` when the connection is over HTTPS. Respects `X-Forwarded-Proto` when trust proxy is enabled. |
| `get` | `get(name)` | Get a specific request header (case-insensitive). |
| `is` | `is(type)` | Check if the request Content-Type matches the given type. |
| `hostname` | `hostname()` | Get the hostname from the Host header (without port). Only reads `X-Forwarded-Host` when `trust proxy` is enabled. On HTTP/2, falls back to the `:authority` pseudo-header. |
| `subdomains` | `subdomains([offset])` | Get the subdomains as an array (e.g. `['api', 'v2']` for `'v2.api.example.com'`). |
| `accepts` | `accepts(...types)` | Content negotiation — check if the client accepts the given type(s). Returns the best match, or `false` if none match. |
| `fresh` | `fresh()` | Check if the request is "fresh" (client cache is still valid). Compares If-None-Match / If-Modified-Since with ETag / Last-Modified. |
| `stale` | `stale()` | Inverse of `fresh`. |
| `xhr` | `xhr()` | Check whether this request was made with XMLHttpRequest. |
| `range` | `range(size)` | Parse the Range header. |


### Response

Lightweight wrapper around Node's `ServerResponse`. Provides chainable helpers for status, headers, body output, and HTTP/2 server push.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `res` | import('http').ServerResponse | Yes | Raw Node server response. |


#### HTTP/2 Server Push

| Method | Signature | Description |
|---|---|---|
| `push` | `push(path, [opts])` | Push a resource to the client via HTTP/2 server push. No-op on HTTP/1.x connections (returns `null`). Server push pre-loads assets (CSS, JS, images) before the client requests them, eliminating one round trip for critical resources. |
| `supportsPush` | `supportsPush()` | Check if the current connection supports HTTP/2 server push. |


#### Server-Sent Events (SSE)

| Method | Signature | Description |
|---|---|---|
| `sse` | `sse([opts])` | Open a Server-Sent Events stream.  Sets the correct headers and returns an SSE controller object with methods for pushing events. The connection stays open until the client disconnects or you call `sse.close()`. |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `status` | `status(code)` | Set HTTP status code. Chainable. |
| `set` | `set(name, value)` | Set a response header. Chainable. |
| `get` | `get(name)` | Get a previously-set response header (case-insensitive). |
| `type` | `type(ct)` | Set the Content-Type header. Accepts a shorthand alias (`'json'`, `'html'`, `'text'`, etc.) or a full MIME string. Chainable. |
| `send` | `send(body)` | Send a response body and finalise the response. Auto-detects Content-Type (Buffer → octet-stream, string → text or HTML, object → JSON) when not explicitly set. |
| `json` | `json(obj)` | Send a JSON response.  Sets `Content-Type: application/json`. |
| `text` | `text(str)` | Send a plain-text response.  Sets `Content-Type: text/plain`. |
| `html` | `html(str)` | Send an HTML response.  Sets `Content-Type: text/html`. |
| `sendStatus` | `sendStatus(code)` | Send only the status code with the standard reason phrase as body. |
| `append` | `append(name, value)` | Append a value to a header. If the header already exists, creates a comma-separated list. |
| `vary` | `vary(field)` | Add the given field to the Vary response header. |
| `headersSent` | `headersSent()` | Whether headers have been sent to the client. |
| `sendFile` | `sendFile(filePath, [opts], [cb])` | Send a file as the response. Streams the file with proper Content-Type. |
| `download` | `download(filePath, [filename], [cb])` | Prompt a file download. Sets Content-Disposition: attachment. |
| `cookie` | `cookie(name, value, [opts])` | Set a cookie on the response. |
| `clearCookie` | `clearCookie(name, [opts])` | Clear a cookie by setting it to expire in the past. |
| `format` | `format(types)` | Respond with content-negotiated output based on the request Accept header. Calls the handler matching the best accepted type. |
| `links` | `links(links)` | Set the Link response header with the given links. |
| `location` | `location(url)` | Set the Location response header. |
| `redirect` | `redirect(statusOrUrl, [url])` | Redirect to the given URL with an optional status code (default 302). |



---

## Body Parsers

### json

JSON body-parsing middleware. Reads the request body, parses it as JSON, and sets `req.body`. Stores the raw buffer on `req.rawBody` for signature verification.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | string \| number | `—` | Max body size (e.g. `'10kb'`). Default `'1mb'`. |
| `reviver` | Function | `—` | `JSON.parse` reviver function. |
| `strict` | boolean | `true` | When true, reject non-object/array roots. |
| `type` | string \| string[] \| Function | `'application/json'` | Content-Type(s) to match. |
| `requireSecure` | boolean | `false` | When true, reject non-HTTPS requests with 403. |
| `verify` | Function | `—` | `verify(req, res, buf, encoding)` — called before parsing. Throw to reject with 403. |
| `inflate` | boolean | `true` | Decompress gzip/deflate/br bodies. When false, compressed bodies return 415. |


```js
  const { json } = require('zero-http');

  app.use(json({ limit: '500kb', strict: true }));

  app.post('/api/data', (req, res) => {
      console.log(req.body); // parsed JSON object
      res.json({ ok: true });
  });
```


### urlencoded

URL-encoded body-parsing middleware. Supports both flat (`URLSearchParams`) and extended (nested bracket syntax) parsing modes. Stores the raw buffer on `req.rawBody` for signature verification.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | string \| number | `—` | Max body size (e.g. `'10kb'`). Default `'1mb'`. |
| `type` | string \| string[] \| Function | `'application/x-www-form-urlencoded'` | Content-Type(s) to match. |
| `extended` | boolean | `false` | Use nested bracket parsing (e.g. `a[b][c]=1`). |
| `requireSecure` | boolean | `false` | When true, reject non-HTTPS requests with 403. |
| `parameterLimit` | number | `1000` | Max number of parameters. Prevents DoS via huge payloads. |
| `depth` | number | `32` | Max nesting depth for bracket syntax. Prevents deep-nesting DoS. |
| `verify` | Function | `—` | `verify(req, res, buf, encoding)` — called before parsing. Throw to reject with 403. |
| `inflate` | boolean | `true` | Decompress gzip/deflate/br bodies. |


```js
  const { urlencoded } = require('zero-http');

  // Flat parsing (default)
  app.use(urlencoded({ limit: '100kb' }));

  // Nested bracket syntax
  app.use(urlencoded({ extended: true }));

  app.post('/form', (req, res) => {
      console.log(req.body); // { name: 'Tony', age: '30' }
      res.json(req.body);
  });
```


### text

Plain-text body-parsing middleware. Reads the request body as a string and sets `req.body`. Stores the raw buffer on `req.rawBody` for signature verification.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | string \| number | `—` | Max body size. Default `'1mb'`. |
| `encoding` | string | `'utf8'` | Fallback character encoding when Content-Type has no charset. |
| `type` | string \| string[] \| Function | `'text/*'` | Content-Type(s) to match. |
| `requireSecure` | boolean | `false` | When true, reject non-HTTPS requests with 403. |
| `verify` | Function | `—` | `verify(req, res, buf, encoding)` — called before decoding. Throw to reject with 403. |
| `inflate` | boolean | `true` | Decompress gzip/deflate/br bodies. When false, compressed bodies return 415. |


```js
  const { text } = require('zero-http');

  app.use(text({ type: 'text/plain', limit: '256kb' }));

  app.post('/log', (req, res) => {
      console.log(req.body); // raw string
      res.send('ok');
  });
```


### raw

Raw-buffer body-parsing middleware. Stores the full request body as a Buffer on `req.body`. Also sets `req.rawBody` for signature verification workflows.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | string \| number | `—` | Max body size. Default `'1mb'`. |
| `type` | string \| string[] \| Function | `'application/octet-stream'` | Content-Type(s) to match. |
| `requireSecure` | boolean | `false` | When true, reject non-HTTPS requests with 403. |
| `verify` | Function | `—` | `verify(req, res, buf)` — called before setting body. Throw to reject with 403. |
| `inflate` | boolean | `true` | Decompress gzip/deflate/br bodies. When false, compressed bodies return 415. |


```js
  const { raw } = require('zero-http');

  app.use(raw({ type: 'application/octet-stream', limit: '5mb' }));

  app.post('/upload', (req, res) => {
      console.log(req.body); // Buffer
      res.send('received ' + req.body.length + ' bytes');
  });
```


### multipart

Streaming multipart/form-data parser. Writes uploaded files to a temp directory and collects form fields.  Sets `req.body = { fields, files }`.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `dir` | string | `—` | Upload directory (default: OS temp dir). |
| `maxFileSize` | number | `—` | Maximum size per file in bytes. |
| `requireSecure` | boolean | `false` | When true, reject non-HTTPS requests with 403. |
| `maxFields` | number | `1000` | Maximum number of non-file fields. Prevents DoS via field flooding. |
| `maxFiles` | number | `10` | Maximum number of uploaded files. |
| `maxFieldSize` | number | `—` | Maximum size of a single field value in bytes. Default 1 MB. |
| `allowedMimeTypes` | string[] | `—` | Whitelist of MIME types for uploaded files (e.g. `['image/png', 'image/jpeg']`). |
| `maxTotalSize` | number | `—` | Maximum combined size of all uploaded files in bytes. |


```js
  const { multipart } = require('zero-http');

  app.use(multipart({
      dir: './uploads',
      maxFileSize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      allowedMimeTypes: ['image/png', 'image/jpeg'],
  }));

  app.post('/upload', (req, res) => {
      const { fields, files } = req.body;
      res.json({ fields, uploaded: Object.keys(files) });
  });
```



---

## Middleware

### cors

CORS middleware.  Supports exact origins, wildcard `'*'`, arrays of allowed origins, and suffix matching with a leading dot (e.g. `'.example.com'` matches `sub.example.com`).

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `origin` | string \| string[] | `'*'` | Allowed origin(s).  Use `'*'` for any,
an array for a whitelist, or a string
starting with `'.'` for suffix matching. |
| `methods` | string | `'GET,POST,PUT,DELETE,OPTIONS'` | Allowed HTTP methods. |
| `allowedHeaders` | string | `'Content-Type,Authorization'` | Allowed request headers. |
| `exposedHeaders` | string | `—` | Headers the browser is allowed to read. |
| `credentials` | boolean | `false` | Whether to set `Access-Control-Allow-Credentials`. |
| `maxAge` | number | `—` | Preflight cache duration in seconds. |


```js
  app.use(cors());                                  // allow all origins
  app.use(cors({ origin: 'https://example.com' })); // single origin
  app.use(cors({                                     // fine-grained
      origin: ['https://my.example.com', '.example.com'],
      credentials: true,
      maxAge: 86400,
  }));
```


### compress

Response compression middleware using Node's built-in `zlib`. Supports gzip, deflate, and brotli (Node >= 11.7). Zero external dependencies.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | number | `1024` | Minimum body size in bytes to compress. |
| `level` | number | `—` | Compression level (zlib.constants.Z_DEFAULT_COMPRESSION). |
| `encoding` | string \| string[] | `—` | Force specific encoding(s). Default: auto-negotiate. |
| `filter` | Function | `—` | `(req, res) => boolean` — return false to skip compression. |


```js
  const { createApp, compress } = require('zero-http');
  const app = createApp();
  app.use(compress());                // gzip/deflate/br auto-negotiated
  app.use(compress({ threshold: 0 })) // compress everything
```


### helmet

Security headers middleware. Sets common security-related HTTP response headers to help protect against well-known web vulnerabilities (XSS, clickjacking, MIME sniffing, etc.). Inspired by the `helmet` npm package but zero-dependency.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `contentSecurityPolicy` | object \| false | `—` | CSP directive object or `false` to disable. |
| `crossOriginEmbedderPolicy` | boolean | `false` | Set COEP header. |
| `crossOriginOpenerPolicy` | string \| false | `'same-origin'` | COOP value. |
| `crossOriginResourcePolicy` | string \| false | `'same-origin'` | CORP value. |
| `dnsPrefetchControl` | boolean | `true` | Set X-DNS-Prefetch-Control: off. |
| `frameguard` | string \| false | `'deny'` | X-Frame-Options value ('deny' \| 'sameorigin'). |
| `hidePoweredBy` | boolean | `true` | Remove X-Powered-By header. |
| `hstsMaxAge` | number | `15552000` | HSTS max-age in seconds (default ~180 days). |
| `hstsIncludeSubDomains` | boolean | `true` | HSTS includeSubDomains directive. |
| `hstsPreload` | boolean | `false` | HSTS preload directive. |
| `ieNoOpen` | boolean | `true` | Set X-Download-Options: noopen. |
| `noSniff` | boolean | `true` | Set X-Content-Type-Options: nosniff. |
| `permittedCrossDomainPolicies` | string \| false | `'none'` | X-Permitted-Cross-Domain-Policies. |
| `referrerPolicy` | string \| false | `'no-referrer'` | Referrer-Policy value. |
| `xssFilter` | boolean | `false` | Set X-XSS-Protection (legacy, off by default). |


```js
  app.use(helmet());
  app.use(helmet({ frameguard: 'sameorigin', hsts: false }));
  app.use(helmet({
      contentSecurityPolicy: {
          directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "https:"],
          }
      }
  }));
```


### static

Static file-serving middleware with MIME detection, directory index files, extension fallbacks, dotfile policies, caching, custom header hooks, and HTTP/2 server push for linked assets.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `root` | string | Yes | Root directory to serve files from. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `index` | string \| false | `'index.html'` | Default file for directory requests, or `false` to disable. |
| `maxAge` | number | `0` | `Cache-Control` max-age in **milliseconds**. |
| `dotfiles` | string | `'ignore'` | Dotfile policy: `'allow'` \| `'deny'` \| `'ignore'`. |
| `extensions` | string[] | `—` | Array of fallback extensions (e.g. `['html', 'htm']`). |
| `setHeaders` | Function | `—` | `(res, filePath) => void` hook to set custom headers. |
| `pushAssets` | string[] \| Function | `—` | HTTP/2 server push. Array of paths
(relative to root) to push when serving HTML files, or a function `(filePath) => string[]`. |


```js
  app.use(serveStatic('public'));                            // serve ./public
  app.use(serveStatic('dist', { maxAge: 86400000 }));       // 1-day cache
  app.use(serveStatic('assets', { extensions: ['html'] })); // .html fallback
```


### rateLimit

In-memory rate-limiting middleware. Limits requests per IP address within a fixed time window.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `windowMs` | number | `60000` | Time window in milliseconds. |
| `max` | number | `100` | Maximum requests per window per IP. |
| `message` | string | `—` | Custom error message. |
| `statusCode` | number | `429` | HTTP status for rate-limited responses. |
| `keyGenerator` | function | `—` | (req) => string; custom key extraction (default: req.ip). |
| `skip` | function | `—` | (req) => boolean; return true to skip rate limiting. |
| `handler` | function | `—` | (req, res) => void; custom handler for rate-limited requests. |


```js
  app.use(rateLimit());                           // 100 req/min per IP
  app.use(rateLimit({ windowMs: 15 * 60000, max: 50 })); // 50 req per 15 min
  app.use(rateLimit({
      max: 10,
      keyGenerator: req => req.headers['x-api-key'],
      skip: req => req.path === '/health',
  }));
```


### timeout

Request timeout middleware. Automatically sends a 408 response if the handler doesn't respond within the configured time limit. Helps prevent Slowloris-style attacks and hung requests.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ms` | number | No | Timeout in milliseconds (default 30s). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `status` | number | `408` | HTTP status code for timeout responses. |
| `message` | string | `'Request Timeout'` | Error message body. |


```js
  app.use(timeout(5000)); // 5 second timeout
  app.use(timeout(10000, { message: 'Too slow' }));
```


### requestId

Request ID middleware. Assigns a unique identifier to each incoming request for tracing and debugging. Sets the ID on both the request object and as a response header.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | string | `'X-Request-Id'` | Response header name. |
| `generator` | Function | `—` | Custom ID generator `() => string`. |
| `trustProxy` | boolean | `false` | Trust incoming X-Request-Id header from proxy. |


```js
  app.use(requestId());
  app.get('/', (req, res) => {
      console.log(req.id); // e.g. '7f3a2b1c-...'
  });
```


### logger

Simple request-logging middleware. Logs method, url, status code, and response time.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `logger` | function | `—` | Custom log function (default: console.log). |
| `colors` | boolean | `—` | Colorize output (default: true when TTY). |
| `format` | string | `—` | 'tiny' \| 'short' \| 'dev' (default: 'dev'). |


```js
  app.use(logger());                           // default 'dev' format
  app.use(logger({ format: 'tiny' }));          // minimal output
  app.use(logger({ colors: false, logger: msg => fs.appendFileSync('access.log', msg + '\n') }));
```


### errorHandler

Configurable error-handling middleware that formats error responses based on environment (dev vs production), supports custom formatters, and integrates with HttpError classes.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `stack` | boolean | `—` | Include stack traces in responses (default: true when NODE_ENV !== 'production'). |
| `log` | boolean | `—` | Log errors to console (default: true). |
| `logger` | function | `—` | Custom log function (default: console.error). |
| `formatter` | function | `—` | Custom response formatter: (err, req, isDev) => object. |
| `onError` | function | `—` | Callback on every error: (err, req, res) => void. |


```js
  app.use(errorHandler());                       // dev-friendly by default
  app.use(errorHandler({ stack: false }));        // hide stack traces
  app.use(errorHandler({
      formatter: (err, req, isDev) => ({ message: err.message }),
      onError: (err) => metrics.increment('errors'),
  }));
```



---

## Cookies & Security

### cookieParser

Cookie parsing middleware. Parses the `Cookie` header and populates `req.cookies`. Supports signed cookies, JSON cookies, secret rotation, and timing-safe signature verification.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `secret` | string \| string[] | No | Secret(s) for signing / verifying cookies. |


#### Static helpers

| Method | Signature | Description |
|---|---|---|
| `sign` | `sign(val, secret)` | Sign a cookie value with the given secret. |
| `unsign` | `unsign(val, secret)` | Verify and unsign a signed cookie value. |
| `jsonCookie` | `jsonCookie(val)` | Serialize a value as a JSON cookie string (prefixed with `j:`). |
| `parseJSON` | `parseJSON(str)` | Parse a JSON cookie string (must start with `j:`). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `decode` | boolean | `true` | URI-decode cookie values. |


```js
  app.use(cookieParser());
  app.use(cookieParser('my-secret'));
  app.use(cookieParser(['new-secret', 'old-secret'])); // key rotation
```


### csrf

CSRF (Cross-Site Request Forgery) protection middleware. Uses the double-submit cookie + header/body token pattern. Safe methods (GET, HEAD, OPTIONS) are skipped automatically. For state-changing requests (POST, PUT, PATCH, DELETE), the middleware checks for a matching token in: 1. `req.headers['x-csrf-token']` 2. `req.body._csrf` (if body parsed) 3. `req.query._csrf`

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `cookie` | string | `'_csrf'` | Name of the double-submit cookie. |
| `header` | string | `'x-csrf-token'` | Request header that carries the token. |
| `saltLength` | number | `18` | Bytes of randomness for token generation. |
| `secret` | string | `—` | HMAC secret. Auto-generated per process if omitted. |
| `ignoreMethods` | string[] | `—` | HTTP methods to skip. Default: GET, HEAD, OPTIONS. |
| `ignorePaths` | string[] | `—` | Path prefixes to skip (e.g. ['/api/webhooks']). |
| `onError` | Function | `—` | Custom error handler `(req, res) => {}`. |


```js
  const { createApp, csrf } = require('zero-http');
  const app = createApp();

  app.use(csrf());                   // default options
  app.use(csrf({ cookie: 'tok' }));  // custom cookie name

  // In a route, read the token for forms / SPA:
  app.get('/form', (req, res) => {
      res.json({ csrfToken: req.csrfToken });
  });
```


### validate

Request validation middleware. Validates `req.body`, `req.query`, and `req.params` against a schema object.  Returns 422 with detailed errors on failure.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `schema` | object | Yes | Validation rules object. |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `field` | `field(value, rule, field)` | Validate a single value against a rule definition. |
| `object` | `object(data, schema, [opts])` | Validate an object against a schema. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `body` | object | `—` | Rules for req.body fields. |
| `query` | object | `—` | Rules for req.query fields. |
| `params` | object | `—` | Rules for req.params fields. |
| `stripUnknown` | boolean | `true` | Remove fields not in schema. |
| `onError` | Function | `—` | Custom error handler `(errors, req, res) => {}`. |


```js
  const { createApp, validate } = require('zero-http');
  const app = createApp();

  app.post('/users', validate({
      body: {
          name:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
          email: { type: 'string', required: true, match: /^[^@]+@[^@]+\.[^@]+$/ },
          age:   { type: 'integer', min: 0, max: 150 },
      },
      query: {
          format: { type: 'string', enum: ['json', 'xml'], default: 'json' },
      },
  }), (req, res) => {
      // req.body / req.query are now validated and sanitised
  });
```



---

## Authentication & Sessions

### jwt

Zero-dependency JWT (JSON Web Token) middleware. Supports HMAC (HS256/384/512) and RSA (RS256/384/512) algorithms, JWKS endpoint auto-fetching, token extraction from header/cookie/query, and configurable validation rules. Populates `req.user` with the decoded payload and `req.token` with the raw token string.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `token` | string | Yes | Raw JWT string. |


#### JWT Middleware

| Method | Signature | Description |
|---|---|---|
| `jwt` | `jwt(opts)` | Create JWT authentication middleware. On success, populates: - `req.user` — decoded payload - `req.auth` — `{ header, payload, token }` full decode info - `req.token` — raw JWT string |


#### JWT Core Functions

| Method | Signature | Description |
|---|---|---|
| `sign` | `sign(payload, secret, [opts])` | Sign a payload and produce a JWT string. |
| `verify` | `verify(token, secretOrKey, [opts])` | Verify a JWT signature and validate claims. |


#### JWKS Support

| Method | Signature | Description |
|---|---|---|
| `jwks` | `jwks(jwksUri, [opts])` | Create a JWKS key provider that fetches and caches public keys. Auto-refreshes keys when a `kid` is not found. |


#### Token Refresh Helpers

| Method | Signature | Description |
|---|---|---|
| `tokenPair` | `tokenPair(config)` | Create a token-pair factory for convenient access + refresh token generation. |
| `createRefreshToken` | `createRefreshToken(payload, secret, [opts])` | Generate a signed refresh token. Refresh tokens are long-lived and should be stored securely. |


```js
  const { createApp, jwt } = require('zero-http');
  const app = createApp();

  app.use(jwt({ secret: process.env.JWT_SECRET }));
```


### session

Zero-dependency session middleware. Supports encrypted cookie sessions (stateless, AES-256-GCM) and server-side session stores (memory and custom adapters). Cookie sessions embed the entire session in an encrypted cookie, so no server-side storage is needed.  Server-side sessions store only a session ID in the cookie, keeping data on the server.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Session ID. |
| `data` | object | No | Initial data. |


#### Session class

| Method | Signature | Description |
|---|---|---|
| `get` | `get(key)` | Get a session value by key. |
| `set` | `set(key, value)` | Set a session value. |
| `has` | `has(key)` | Check if a key exists in the session. |
| `delete` | `delete(key)` | Delete a session key. |
| `all` | `all()` | Get all session data as a plain object. |
| `size` | `size()` | Number of session entries. |
| `clear` | `clear()` | Clear all session data. |
| `destroy` | `destroy()` | Destroy the session. Clears all data and marks cookie for expiry. |
| `regenerate` | `regenerate()` | Regenerate the session ID (prevents session fixation). Preserves existing data under a new ID. |
| `flash` | `flash(key, value)` | Set a flash message (available only on the next request). |
| `flashes` | `flashes([key])` | Read flash messages for a key (consumes them). |


#### Memory Store

| Method | Signature | Description |
|---|---|---|
| `get` | `get(sid)` |  |
| `set` | `set(sid, data, [maxAge])` |  |
| `destroy` | `destroy(sid)` |  |
| `length` | `length()` | Number of active sessions. |
| `clear` | `clear()` | Clear all sessions. |
| `close` | `close()` | Stop the prune timer. |


#### Session Middleware

| Method | Signature | Description |
|---|---|---|
| `session` | `session(opts)` | Create session middleware. Two modes: 1. **Cookie session** (no `store`): Entire session encrypted in a cookie. Great for small payloads (< 4 KB). Zero server state. 2. **Server-side session** (with `store`): Only session ID in cookie, data lives in the store. Scales to large payloads. |


```js
  // Encrypted cookie session (stateless)
  app.use(session({ secret: process.env.SESSION_SECRET }));
```


### oauth

Zero-dependency OAuth 2.0 client with PKCE support. Built-in provider presets for Google, GitHub, Microsoft, and Apple. Uses the Authorization Code flow with PKCE for maximum security.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `length` | number | No | Verifier length (43–128 per RFC 7636). |


#### OAuth2 Client

| Method | Signature | Description |
|---|---|---|
| `oauth` | `oauth(opts)` | Create an OAuth 2.0 client for Authorization Code flow (+ PKCE). |


#### PKCE Helpers

| Method | Signature | Description |
|---|---|---|
| `generateState` | `generateState([bytes])` | Generate a cryptographically random state parameter. |


```js
  const { oauth } = require('zero-http');
  const github = oauth({
      provider: 'github',
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackUrl: 'https://myapp.com/auth/github/callback',
  });

  app.get('/auth/github', (req, res) => {
      const { url, state, codeVerifier } = github.authorize({ scope: 'user:email' });
      req.session.set('oauth_state', state);
      req.session.set('oauth_verifier', codeVerifier);
      res.redirect(url);
  });

  app.get('/auth/github/callback', async (req, res) => {
      const tokens = await github.callback(req.query, {
          state: req.session.get('oauth_state'),
          codeVerifier: req.session.get('oauth_verifier'),
      });
      const user = await github.userInfo(tokens.access_token);
      res.json(user);
  });
```


### authorize

Authorization helpers — role-based access control (RBAC), permission-based access, and policy classes. Works with any authentication middleware that sets `req.user`.

#### Role-Based Access Control

| Method | Signature | Description |
|---|---|---|
| `authorize` | `authorize(...roles)` | Role-based authorization middleware. Checks `req.user.role` or `req.user.roles` against allowed roles. Returns 401 if `req.user` is missing (not authenticated). Returns 403 if the user's role is not in the allowed list. |


#### Permission-Based Access Control

| Method | Signature | Description |
|---|---|---|
| `can` | `can(...permissions)` | Permission-based authorization middleware. Checks `req.user.permissions` (array or Set) for the required permission(s). Permission strings follow a `resource:action` convention: - `'posts:write'` — write access to posts - `'users:delete'` — delete users - `'*'` — superuser wildcard |
| `canAny` | `canAny(...permissions)` | Like `can()`, but passes if the user has ANY of the listed permissions. |


#### Policy Classes

| Method | Signature | Description |
|---|---|---|
| `check` | `check(action, user, [resource])` | Check if an action is allowed. Falls through to the action method if defined, otherwise denies. |
| `gate` | `gate(policy, action, [getResource])` | Policy gate middleware. Runs a policy check against a resource loaded from the request. |


#### req.user helpers (mixed in by middleware barrel)

| Method | Signature | Description |
|---|---|---|
| `attachUserHelpers` | `attachUserHelpers()` | Attach convenience authorization methods to `req.user`. Call this middleware after JWT/session middleware. Adds: - `req.user.is(...roles)` — check roles - `req.user.can(...perms)` — check permissions |


```js
  const { authorize, can } = require('zero-http');

  // Role-based: only admins and editors
  app.put('/posts/:id', authorize('admin', 'editor'), (req, res) => {
      res.json({ updated: true });
  });

  // Permission-based
  app.delete('/posts/:id', can('posts:delete'), (req, res) => {
      res.json({ deleted: true });
  });

  // Policy class
  class PostPolicy extends Policy {
      update(user, post) { return user.id === post.authorId || user.role === 'admin'; }
      delete(user, post) { return user.role === 'admin'; }
  }
  app.delete('/posts/:id', gate(new PostPolicy(), 'delete', async (req) => {
      return await db.query('SELECT * FROM posts WHERE id = ?', [req.params.id]);
  }), (req, res) => {
      res.json({ deleted: true });
  });
```



---

## Environment

### env

Zero-dependency typed environment variable system. Loads `.env` files, validates against a typed schema, and exposes a fast accessor with built-in type coercion. Supports: string, number, boolean, integer, array, json, url, port, enum. Multi-environment: `.env`, `.env.local`, `.env.{NODE_ENV}`, `.env.{NODE_ENV}.local`.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `load` | `load([schema], [options])` | Load environment variables from `.env` files and validate against a typed schema. Files are loaded in precedence order (later overrides earlier): 1. `.env` — shared defaults 2. `.env.local` — local overrides (gitignored) 3. `.env.{NODE_ENV}` — environment-specific  (e.g. `.env.production`) 4. `.env.{NODE_ENV}.local` — env-specific local overrides Process environment variables (`process.env`) always take precedence. |
| `get` | `get(key)` | Get a typed environment variable. Can also be called as `env(key)`. |
| `require` | `require(key)` | Get a required environment variable. Throws if missing. |
| `has` | `has(key)` | Check if a variable is set (not undefined). |
| `all` | `all()` | Get all loaded values as a plain object. |
| `reset` | `reset()` | Reset the env store (useful for testing). |
| `parse` | `parse(src)` | Parse a `.env` file string into key-value pairs. Supports `#` comments, single/double/backtick quotes, multiline values, inline comments, interpolation `${VAR}`, and `export` prefix. |


```js
  const { env } = require('zero-http');

  env.load({
      PORT:            { type: 'port',    default: 3000 },
      DATABASE_URL:    { type: 'string',  required: true },
      DEBUG:           { type: 'boolean', default: false },
      ALLOWED_ORIGINS: { type: 'array',   separator: ',' },
      LOG_LEVEL:       { type: 'enum',    values: ['debug','info','warn','error'], default: 'info' },
  });

  env.PORT          // => 3000 (number)
  env('PORT')       // => 3000
  env.DEBUG         // => false (boolean)
  env.require('DATABASE_URL')  // throws if missing
```


### .env File Format

The .env file format supports comments, quoted values (single, double, backtick), multiline strings, variable interpolation, and export prefix.

```env
# Database
DATABASE_URL=postgres://localhost/mydb

# Quoted values
APP_NAME="My App"
SECRET_KEY='s3cr3t'

# Multiline (backtick)
RSA_KEY=`-----BEGIN RSA KEY-----
MIIBog...
-----END RSA KEY-----`

# Interpolation
BASE_URL=https://example.com
API_URL=${BASE_URL}/api/v1

# Export prefix (optional, ignored)
export NODE_ENV=production
```


> **Tip:** Lines starting with # are comments.
> **Tip:** Variable interpolation uses ${VAR} syntax and resolves from already-parsed values or process.env.
> **Tip:** Files load in order: .env → .env.local → .env.{NODE_ENV} → .env.{NODE_ENV}.local (later files override earlier).


### Schema Types

Supported schema types for env.load() validation. Each type automatically coerces and validates the raw string from the environment.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `string` | string | `—` | Pass-through. Supports min/max length and match regex constraints. |
| `number` | number | `—` | Parsed via Number(). Supports min/max range. |
| `integer` | integer | `—` | Parsed via parseInt(). Supports min/max range. |
| `port` | port | `—` | Integer 0–65535. Rejects out-of-range values. |
| `boolean` | boolean | `—` | Truthy: 'true', '1', 'yes', 'on'. Falsy: 'false', '0', 'no', 'off'. |
| `array` | array | `—` | Split by separator (default ','). |
| `json` | json | `—` | Parsed via JSON.parse(). |
| `url` | url | `—` | Validated via new URL(). |
| `enum` | enum | `—` | Must be one of the 'values' array. |


```js
env.load({
	PORT:       { type: 'port',    default: 3000 },
	DB_URL:     { type: 'string',  required: true },
	DEBUG:      { type: 'boolean', default: false },
	ORIGINS:    { type: 'array',   separator: ',' },
	LOG_LEVEL:  { type: 'enum',    values: ['debug','info','warn','error'], default: 'info' },
})
```



---

## Real-Time

### WebSocket

Full-featured WebSocket connection wrapper over a raw TCP socket. Implements RFC 6455 framing for text, binary, ping, pong, and close.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `socket` | import('net').Socket | Yes | The upgraded TCP socket. |
| `meta` | object | No | Connection metadata from the upgrade handshake. |


#### Event Emitter

| Method | Signature | Description |
|---|---|---|
| `on` | `on(event, fn)` | Register an event listener. |
| `once` | `once(event, fn)` | Register a one-time event listener. |
| `off` | `off(event, fn)` | Remove a specific event listener. |
| `removeAllListeners` | `removeAllListeners([event])` | Remove all listeners for an event, or all events if none specified. |
| `listenerCount` | `listenerCount(event)` | Count listeners for a given event. |


#### Sending

| Method | Signature | Description |
|---|---|---|
| `send` | `send(data, [opts])` | Send a text or binary message. |
| `sendJSON` | `sendJSON(obj, [cb])` | Send a JSON-serialised message (sets text frame). |
| `ping` | `ping([payload], [cb])` | Send a ping frame. |
| `pong` | `pong([payload], [cb])` | Send a pong frame. |
| `close` | `close([code], [reason])` | Close the WebSocket connection. |
| `terminate` | `terminate()` | Forcefully destroy the underlying socket without a close frame. |


#### Computed Properties

| Method | Signature | Description |
|---|---|---|
| `bufferedAmount` | `bufferedAmount()` | Bytes waiting in the send buffer. |
| `uptime` | `uptime()` | How long this connection has been alive (ms). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPayload` | number | `1048576` | Maximum incoming frame size in bytes. |
| `pingInterval` | number | `30000` | Auto-ping interval in ms (0 to disable). |
| `protocol` | string | `—` | Negotiated WebSocket sub-protocol. |
| `extensions` | string | `—` | Negotiated WebSocket extensions. |
| `headers` | object | `—` | HTTP headers from the upgrade request. |
| `ip` | string | `—` | Remote IP address of the client. |
| `query` | object | `—` | Parsed query-string parameters from the upgrade URL. |
| `url` | string | `—` | The request URL path. |
| `secure` | boolean | `false` | Whether the connection is over TLS. |


### WebSocketPool

WebSocket room/channel manager. Provides broadcast, room-based messaging, and connection registry for WebSocket connections.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `add` | `add(ws)` | Add a connection to the pool. |
| `remove` | `remove(ws)` | Remove a connection from the pool and all rooms. |
| `join` | `join(ws, room)` | Join a connection to a room. |
| `leave` | `leave(ws, room)` | Remove a connection from a room. |
| `roomsOf` | `roomsOf(ws)` | Get all rooms a connection belongs to. |
| `broadcast` | `broadcast(data, [exclude])` | Broadcast a message to ALL connected clients. |
| `broadcastJSON` | `broadcastJSON(obj, [exclude])` | Broadcast a JSON message to ALL connected clients. |
| `toRoom` | `toRoom(room, data, [exclude])` | Send a message to all connections in a specific room. |
| `toRoomJSON` | `toRoomJSON(room, obj, [exclude])` | Send a JSON message to all connections in a specific room. |
| `in` | `in(room)` | Get all connections in a room. |
| `size` | `size()` | Total number of active connections. |
| `roomSize` | `roomSize(room)` | Number of connections in a specific room. |
| `rooms` | `rooms()` | List all active room names. |
| `clients` | `clients()` | Get all active connections. |
| `closeAll` | `closeAll([code], [reason])` | Close all connections gracefully. |


### SSE (Server-Sent Events)

SSE (Server-Sent Events) stream controller. Wraps a raw HTTP response and provides the full SSE text protocol. Tracks connection state, event counts, and bytes sent. Emits `'close'` when the client disconnects and `'error'` on write failures.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `raw` | import('http').ServerResponse | Yes | Raw HTTP response stream. |


#### Event Emitter

| Method | Signature | Description |
|---|---|---|
| `on` | `on(event, fn)` | Register an event listener. |
| `once` | `once(event, fn)` | Register a one-time listener. |
| `off` | `off(event, fn)` | Remove a listener. |
| `removeAllListeners` | `removeAllListeners([event])` | Remove all listeners for an event (or all events). |
| `listenerCount` | `listenerCount(event)` | Count listeners for an event. |


#### Public API

| Method | Signature | Description |
|---|---|---|
| `send` | `send(data, [id])` | Send an unnamed data event. Objects are automatically JSON-serialised. |
| `sendJSON` | `sendJSON(obj, [id])` | Convenience: send an object as JSON data (same as `.send(obj)`). |
| `event` | `event(eventName, data, [id])` | Send a named event with data. |
| `comment` | `comment(text)` | Send a comment line.  Comments are ignored by EventSource clients but useful as a keep-alive mechanism. |
| `retry` | `retry(ms)` | Send (or update) the retry interval hint. The client's EventSource will use this value for reconnection delay. |
| `keepAlive` | `keepAlive(intervalMs, [comment])` | Start or restart an automatic keep-alive timer that sends comment pings at the given interval. |
| `flush` | `flush()` | Flush the response (hint to Node to push buffered data to the network). Useful when piping through reverse proxies that buffer. |
| `close` | `close()` | Close the SSE connection from the server side. |
| `connected` | `connected()` | Whether the connection is still open. |
| `uptime` | `uptime()` | How long this stream has been open (ms). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `secure` | boolean | `—` | Whether the connection is over TLS. |
| `autoId` | boolean | `—` | Auto-increment event IDs. |
| `startId` | number | `—` | Starting value for auto-ID (default 1). |
| `lastEventId` | string | `—` | Last-Event-ID from the client reconnection header. |
| `keepAlive` | number | `—` | Interval (ms) for automatic keep-alive pings. 0 to disable. |
| `keepAliveComment` | string | `—` | Comment text for keep-alive pings (default `'ping'`). |


```js
  app.get('/events', (req, res) => {
      const stream = res.sse();           // opens SSE connection

      stream.send({ hello: 'world' });    // unnamed event
      stream.event('update', { id: 1 });  // named event
      stream.retry(3000);                 // set client reconnect delay
      stream.keepAlive(15000);            // auto-ping every 15s

      stream.on('close', () => {
          console.log('client disconnected after', stream.uptime, 'ms');
      });
  });
```



---

## fetch

Minimal, zero-dependency server-side `fetch()` replacement. Supports HTTP/HTTPS, JSON/URLSearchParams/Buffer/stream bodies, download & upload progress callbacks, timeouts, and AbortSignal.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | Absolute URL to fetch. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `method` | string | `'GET'` | HTTP method. |
| `headers` | object | `—` | Request headers. |
| `body` | string \| Buffer \| object \| ReadableStream | `—` | Request body. |
| `timeout` | number | `—` | Request timeout in ms. |
| `signal` | AbortSignal | `—` | Abort signal for cancellation. |
| `agent` | import('http').Agent | `—` | Custom HTTP agent. |
| `onDownloadProgress` | Function | `—` | `({ loaded, total }) => void` download progress callback. |
| `onUploadProgress` | Function | `—` | `({ loaded, total }) => void` upload progress callback. |
| `rejectUnauthorized` | boolean | `—` | Reject connections with unverified certs (default: Node default `true`). TLS option — passed to `https.request()`. |
| `ca` | string \| Buffer \| Array | `—` | Override default CA certificates. |
| `cert` | string \| Buffer | `—` | Client certificate (PEM) for mutual TLS. |
| `key` | string \| Buffer | `—` | Private key (PEM) for mutual TLS. |
| `pfx` | string \| Buffer | `—` | PFX / PKCS12 bundle (alternative to cert+key). |
| `passphrase` | string | `—` | Passphrase for the key or PFX. |
| `servername` | string | `—` | SNI server name override. |
| `ciphers` | string | `—` | Colon-separated cipher list. |
| `secureProtocol` | string | `—` | SSL/TLS protocol method name. |
| `minVersion` | string | `—` | Minimum TLS version (`'TLSv1.2'`, etc.). |
| `maxVersion` | string | `—` | Maximum TLS version. |


```js
  const res = await fetch('https://api.example.com/data');
  const body = await res.json();

  // POST with JSON body & timeout
  const res2 = await fetch('https://api.example.com/items', {
      method: 'POST',
      body: { name: 'widget' },
      timeout: 5000,
  });
```


---

## ORM

### Database

ORM entry point.  Provides the `Database` factory that creates a connection to a backing store, the base `Model` class, the `TYPES` enum, and schema helpers. Supported adapters (all optional "bring your own driver"): - `memory`  — in-process (no driver needed) - `json`    — JSON file persistence (no driver needed) - `sqlite`  — requires `better-sqlite3` - `mysql`   — requires `mysql2` - `postgres` — requires `pg` - `mongo`   — requires `mongodb`

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `adapter` | object | Yes | Instantiated adapter. |


#### Database class

| Method | Signature | Description |
|---|---|---|
| `connect` | `connect(type, [options])` | Create a Database connection. |
| `register` | `register(ModelClass)` | Register a Model class with this database. Binds the adapter to the model so all CRUD operations go through it. |
| `registerAll` | `registerAll(...models)` | Register multiple Model classes at once. |
| `sync` | `sync()` | Synchronise all registered models — create tables if they don't exist. Tables are ordered so referenced tables are created first (topological sort). |
| `drop` | `drop()` | Drop all registered model tables (in reverse order to respect FK deps). |
| `close` | `close()` | Close the underlying connection / pool. |
| `model` | `model(name)` | Get a registered model by table name. |
| `transaction` | `transaction(fn)` | Execute a callback within a database transaction. If the callback throws, the transaction is rolled back. If the callback returns normally, the transaction is committed. Note: Transaction support depends on the adapter. Memory and JSON adapters run the callback directly (no real transaction). |


#### Migration / DDL Convenience

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `addColumn(table, column, definition)` | Add a column to an existing table. |
| `dropColumn` | `dropColumn(table, column)` | Drop a column from a table. |
| `renameColumn` | `renameColumn(table, oldName, newName)` | Rename a column. |
| `renameTable` | `renameTable(oldName, newName)` | Rename a table. |
| `createIndex` | `createIndex(table, columns, [options])` | Create an index on a table. |
| `dropIndex` | `dropIndex(table, name)` | Drop an index. |
| `hasTable` | `hasTable(table)` | Check if a table exists. |
| `hasColumn` | `hasColumn(table, column)` | Check if a column exists on a table. |
| `describeTable` | `describeTable(table)` | Get detailed column info for a table. |
| `addForeignKey` | `addForeignKey(table, column, refTable, refColumn, [options])` | Add a foreign key constraint (MySQL / PostgreSQL only). |
| `dropForeignKey` | `dropForeignKey(table, constraintName)` | Drop a foreign key constraint (MySQL / PostgreSQL only). |


#### Health Check & Retry

| Method | Signature | Description |
|---|---|---|
| `ping` | `ping()` | Ping the database to check connectivity. Works across all adapters. |
| `retry` | `retry(fn, [options])` | Execute a function with automatic retry on failure. Uses exponential backoff with jitter. |


#### Profiling

| Method | Signature | Description |
|---|---|---|
| `enableProfiling` | `enableProfiling([options])` | Enable query profiling on this database. Attaches a QueryProfiler that tracks every query execution, detects slow queries, and flags potential N+1 patterns. |
| `profiler` | `profiler()` | The attached profiler (if profiling is enabled). |
| `replicas` | `replicas()` | The attached replica manager (if configured). |


#### Read Replicas

| Method | Signature | Description |
|---|---|---|
| `connectWithReplicas` | `connectWithReplicas(type, primaryOpts, [replicaConfigs], [options])` | Create a Database with read replica support. Automatically sets up a ReplicaManager with the primary and replica adapters. |


```js
  const { Database, Model, TYPES } = require('zero-http');

  const db = Database.connect('memory');

  class User extends Model {
      static table = 'users';
      static schema = {
          id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
          name:  { type: TYPES.STRING, required: true },
          email: { type: TYPES.STRING, required: true, unique: true },
      };
      static timestamps = true;
  }

  db.register(User);
  await db.sync();

  const user = await User.create({ name: 'Alice', email: 'a@b.com' });
```


### Model

Base Model class for defining database-backed entities. Provides static CRUD methods, instance-level save/update/delete, lifecycle hooks, relationship definitions, computed/virtual columns, attribute casting, model events & observers, and advanced relationships.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `data` | object | Yes | Row data. |


#### Instance Methods

| Method | Signature | Description |
|---|---|---|
| `save` | `save()` | Save this instance to the database. Insert if new, update if persisted. |
| `update` | `update(data)` | Update specific fields on this instance. |
| `delete` | `delete()` | Delete this instance from the database. If softDelete is enabled, sets deletedAt instead. |
| `restore` | `restore()` | Restore a soft-deleted record. |
| `increment` | `increment(field, [by])` | Increment a numeric field atomically. |
| `decrement` | `decrement(field, [by])` | Decrement a numeric field atomically. |
| `reload` | `reload()` | Reload this instance from the database. |
| `toJSON` | `toJSON()` | Convert to plain object (for JSON serialization). Respects `static hidden = [...]` to exclude sensitive fields. Includes computed columns and applies accessor transformations. |


#### Static CRUD

| Method | Signature | Description |
|---|---|---|
| `create` | `create(data)` | Create and persist a new record. |
| `createMany` | `createMany(dataArray)` | Create multiple records at once. Uses batch INSERT when the adapter supports it (much faster for SQL databases). |
| `find` | `find([conditions])` | Find records matching conditions. |
| `findOne` | `findOne(conditions)` | Find a single record matching conditions. |
| `findById` | `findById(id)` | Find a record by primary key. |
| `findOrCreate` | `findOrCreate(conditions, [defaults])` | Find one or create if not found. |
| `updateWhere` | `updateWhere(conditions, data)` | Update records matching conditions. |
| `deleteWhere` | `deleteWhere(conditions)` | Delete records matching conditions. |
| `count` | `count([conditions])` | Count records matching conditions. |
| `exists` | `exists([conditions])` | Check whether any records matching conditions exist. |
| `upsert` | `upsert(conditions, data)` | Insert or update a record matching conditions. If a matching record exists, update it. Otherwise, create a new one. |
| `scope` | `scope(name, ...args)` | Start a query with a named scope applied. |
| `query` | `query()` | Start a fluent query builder. |


#### LINQ-Inspired Static Shortcuts

| Method | Signature | Description |
|---|---|---|
| `first` | `first([conditions])` | Find the first record matching optional conditions. |
| `last` | `last([conditions])` | Find the last record matching optional conditions. |
| `paginate` | `paginate(page, [perPage], [conditions])` | Rich pagination with metadata. Returns `{ data, total, page, perPage, pages, hasNext, hasPrev }`. |
| `chunk` | `chunk(size, fn, [conditions])` | Process all matching records in batches. Calls `fn(batch, batchIndex)` for each chunk. |
| `all` | `all([conditions])` | Get all records, optionally filtered. Alias for find() — for LINQ-familiarity. |
| `random` | `random([conditions])` | Get a random record. |
| `pluck` | `pluck(field, [conditions])` | Pluck values for a single column across all matching records. |


#### Relationships

| Method | Signature | Description |
|---|---|---|
| `hasMany` | `hasMany(RelatedModel, foreignKey, [localKey])` | Define a hasMany relationship. |
| `hasOne` | `hasOne(RelatedModel, foreignKey, [localKey])` | Define a hasOne relationship. |
| `belongsTo` | `belongsTo(RelatedModel, foreignKey, [otherKey])` | Define a belongsTo relationship. |
| `belongsToMany` | `belongsToMany(RelatedModel, opts)` | Define a many-to-many relationship through a junction/pivot table. |
| `load` | `load(relationName)` | Load a related model for this instance. |


#### Attribute Casting Helpers

| Method | Signature | Description |
|---|---|---|
| `getAttribute` | `getAttribute(key)` | Get an attribute value with accessor/cast applied. |
| `setAttribute` | `setAttribute(key, value)` | Set an attribute value with mutator/cast applied. |


#### Model Events

| Method | Signature | Description |
|---|---|---|
| `on` | `on(event, listener)` | Register an event listener on this model. Supported events: `creating`, `created`, `updating`, `updated`, `deleting`, `deleted`, `saving`, `saved`. |
| `once` | `once(event, listener)` | Register a one-time event listener. |
| `off` | `off(event, listener)` | Remove an event listener. |
| `removeAllListeners` | `removeAllListeners([event])` | Remove all listeners for an event, or all listeners entirely. |


#### Observers

| Method | Signature | Description |
|---|---|---|
| `observe` | `observe(observer)` | Register an observer for this model. An observer is an object with methods named after lifecycle events: `creating`, `created`, `updating`, `updated`, `deleting`, `deleted`. |
| `unobserve` | `unobserve(observer)` | Remove an observer from this model. |


#### Advanced Relationships

| Method | Signature | Description |
|---|---|---|
| `morphOne` | `morphOne(RelatedModel, morphName, [localKey])` | Define a polymorphic one-to-one relationship (morphOne). The related table uses two columns: a type column and an ID column. |
| `morphMany` | `morphMany(RelatedModel, morphName, [localKey])` | Define a polymorphic one-to-many relationship (morphMany). The related table uses two columns: a type column and an ID column. |
| `hasManyThrough` | `hasManyThrough(RelatedModel, ThroughModel, firstKey, secondKey, [localKey], [secondLocalKey])` | Define a has-many-through relationship. Accesses distant relations through an intermediate table. |
| `selfReferential` | `selfReferential(opts)` | Define a self-referential relationship for tree/graph structures. Sets up both parent and children relationships. |
| `tree` | `tree([options])` | Build a full tree structure from self-referential records. Returns nested objects with a `children` array property. |
| `ancestors` | `ancestors([foreignKey])` | Get all ancestors of this instance in a self-referential tree. |
| `descendants` | `descendants([foreignKey])` | Get all descendants of this instance in a self-referential tree. |


```js
  const { Model, Database } = require('zero-http');

  class User extends Model {
      static table = 'users';
      static schema = {
          id:    { type: 'integer', primaryKey: true, autoIncrement: true },
          name:  { type: 'string',  required: true, maxLength: 100 },
          email: { type: 'string',  required: true, unique: true },
          role:  { type: 'string',  enum: ['user','admin'], default: 'user' },
      };
      static timestamps = true;   // auto createdAt/updatedAt
      static softDelete = true;   // deletedAt instead of real delete
  }

  db.register(User);

  const user = await User.create({ name: 'Alice', email: 'a@b.com' });
  const users = await User.find({ role: 'admin' });
  const u = await User.findById(1);
  await u.update({ name: 'Alice2' });
  await u.delete();
```


### Schema DDL

Schema definition and validation for ORM models. Validates data against column definitions, coerces types, and enforces constraints (required, unique, min, max, enum, match).

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `value` | * | Yes | Raw input value. |
| `colDef` | object | Yes | Column definition. |
| `colName` | string | Yes | Column name (for error messages). |


#### Validation

| Method | Signature | Description |
|---|---|---|
| `validate` | `validate(data, columns, [options])` | Validate all columns of a data object against the schema. |


#### DDL Security Helpers

| Method | Signature | Description |
|---|---|---|
| `validateFKAction` | `validateFKAction(action)` | Validate and return a FK action string, or throw. |
| `validateCheck` | `validateCheck(expr)` | Validate a CHECK expression for dangerous SQL patterns. |


```js
  const { TYPES, validate } = require('zero-http').Schema;

  const columns = {
      name:  { type: TYPES.STRING, required: true, minLength: 1 },
      email: { type: TYPES.STRING, required: true, match: /@/ },
      age:   { type: TYPES.INTEGER, min: 0, max: 150 },
  };

  const { valid, errors, sanitized } = validate(
      { name: 'Alice', email: 'alice@example.com', age: '30' },
      columns,
  );
  // valid: true, sanitized.age === 30 (coerced from string)
```


### TYPES

Column type constants for ORM schema definitions. Use these when defining model schemas to specify the data type of each column.

#### Core

| Option | Type | Default | Description |
|---|---|---|---|
| `STRING` | string | `'string'` | Maps to 'string' column type. |
| `INTEGER` | string | `'integer'` | Maps to 'integer' column type. |
| `FLOAT` | string | `'float'` | Maps to 'float' column type. |
| `BOOLEAN` | string | `'boolean'` | Maps to 'boolean' column type. |
| `DATE` | string | `'date'` | Maps to 'date' column type. |
| `DATETIME` | string | `'datetime'` | Maps to 'datetime' column type. |
| `JSON` | string | `'json'` | Maps to 'json' column type. |
| `TEXT` | string | `'text'` | Maps to 'text' column type. |
| `BLOB` | string | `'blob'` | Maps to 'blob' column type. |
| `UUID` | string | `'uuid'` | Maps to 'uuid' column type. |


#### Extended numeric types

| Option | Type | Default | Description |
|---|---|---|---|
| `BIGINT` | string | `'bigint'` | Maps to 'bigint' column type. |
| `SMALLINT` | string | `'smallint'` | Maps to 'smallint' column type. |
| `TINYINT` | string | `'tinyint'` | Maps to 'tinyint' column type. |
| `DECIMAL` | string | `'decimal'` | Maps to 'decimal' column type. |
| `DOUBLE` | string | `'double'` | Maps to 'double' column type. |
| `REAL` | string | `'real'` | Maps to 'real' column type. |


#### Extended string / binary types

| Option | Type | Default | Description |
|---|---|---|---|
| `CHAR` | string | `'char'` | Maps to 'char' column type. |
| `BINARY` | string | `'binary'` | Maps to 'binary' column type. |
| `VARBINARY` | string | `'varbinary'` | Maps to 'varbinary' column type. |


#### Temporal types

| Option | Type | Default | Description |
|---|---|---|---|
| `TIMESTAMP` | string | `'timestamp'` | Maps to 'timestamp' column type. |
| `TIME` | string | `'time'` | Maps to 'time' column type. |


#### MySQL-specific

| Option | Type | Default | Description |
|---|---|---|---|
| `ENUM` | string | `'enum'` | Maps to 'enum' column type. |
| `SET` | string | `'set'` | Maps to 'set' column type. |
| `MEDIUMTEXT` | string | `'mediumtext'` | Maps to 'mediumtext' column type. |
| `LONGTEXT` | string | `'longtext'` | Maps to 'longtext' column type. |
| `MEDIUMBLOB` | string | `'mediumblob'` | Maps to 'mediumblob' column type. |
| `LONGBLOB` | string | `'longblob'` | Maps to 'longblob' column type. |
| `YEAR` | string | `'year'` | Maps to 'year' column type. |


#### PostgreSQL-specific

| Option | Type | Default | Description |
|---|---|---|---|
| `SERIAL` | string | `'serial'` | Maps to 'serial' column type. |
| `BIGSERIAL` | string | `'bigserial'` | Maps to 'bigserial' column type. |
| `JSONB` | string | `'jsonb'` | Maps to 'jsonb' column type. |
| `INTERVAL` | string | `'interval'` | Maps to 'interval' column type. |
| `INET` | string | `'inet'` | Maps to 'inet' column type. |
| `CIDR` | string | `'cidr'` | Maps to 'cidr' column type. |
| `MACADDR` | string | `'macaddr'` | Maps to 'macaddr' column type. |
| `MONEY` | string | `'money'` | Maps to 'money' column type. |
| `XML` | string | `'xml'` | Maps to 'xml' column type. |
| `CITEXT` | string | `'citext'` | Maps to 'citext' column type. |
| `ARRAY` | string | `'array'` | Maps to 'array' column type. |


#### SQLite

| Option | Type | Default | Description |
|---|---|---|---|
| `NUMERIC` | string | `'numeric'` | Maps to 'numeric' column type. |


```js
const { TYPES } = require('zero-http')

const schema = {
	name:    { type: TYPES.STRING,  required: true },
	age:     { type: TYPES.INTEGER },
	active:  { type: TYPES.BOOLEAN, default: true },
	profile: { type: TYPES.JSON },
}
```


### Query

Fluent query builder that produces adapter-agnostic query objects. Each method returns `this` for chaining.  Call `.exec()` or `await` the query to execute it against the adapter.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `model` | object | Yes | The Model class to query. |
| `adapter` | object | Yes | The database adapter instance. |


#### Selection

| Method | Signature | Description |
|---|---|---|
| `select` | `select(...fields)` | Select specific columns. |
| `distinct` | `distinct()` | Select distinct rows. |


#### Filtering

| Method | Signature | Description |
|---|---|---|
| `where` | `where(field, [op], [value])` | Add a WHERE condition. Accepts multiple forms: - `where('age', 18)` → `age = 18` - `where('age', '>', 18)` → `age > 18` - `where({ role: 'admin', active: true })` → `role = 'admin' AND active = true` |
| `orWhere` | `orWhere(field, [op], [value])` | Add an OR WHERE condition. |
| `whereNull` | `whereNull(field)` | WHERE column IS NULL. |
| `whereNotNull` | `whereNotNull(field)` | WHERE column IS NOT NULL. |
| `whereIn` | `whereIn(field, values)` | WHERE column IN (...values). |
| `whereNotIn` | `whereNotIn(field, values)` | WHERE column NOT IN (...values). |
| `whereBetween` | `whereBetween(field, low, high)` | WHERE column BETWEEN low AND high. |
| `whereNotBetween` | `whereNotBetween(field, low, high)` | WHERE column NOT BETWEEN low AND high. |
| `whereLike` | `whereLike(field, pattern)` | WHERE column LIKE pattern. |


#### Ordering

| Method | Signature | Description |
|---|---|---|
| `orderBy` | `orderBy(field, [dir])` | ORDER BY a column. |
| `thenBy` | `thenBy(field)` | Add secondary sort ascending (use after orderBy). |
| `thenByDescending` | `thenByDescending(field)` | Add secondary sort descending (use after orderBy). |


#### Pagination

| Method | Signature | Description |
|---|---|---|
| `limit` | `limit(n)` | LIMIT results. |
| `offset` | `offset(n)` | OFFSET results. |
| `page` | `page(page, perPage)` | Convenience: page(pageNum, perPage). |


#### Grouping

| Method | Signature | Description |
|---|---|---|
| `groupBy` | `groupBy(...fields)` | GROUP BY column(s). |
| `having` | `having(field, [op], [value])` | HAVING (used with GROUP BY). |


#### Joins

| Method | Signature | Description |
|---|---|---|
| `join` | `join(table, localKey, foreignKey)` | INNER JOIN. |
| `leftJoin` | `leftJoin(table, localKey, foreignKey)` | LEFT JOIN. |
| `rightJoin` | `rightJoin(table, localKey, foreignKey)` | RIGHT JOIN. |


#### Soft Delete

| Method | Signature | Description |
|---|---|---|
| `withDeleted` | `withDeleted()` | Include soft-deleted records in results. |


#### Eager Loading

| Method | Signature | Description |
|---|---|---|
| `with` | `with(...relations)` | Eager-load one or more relationships. Batches related queries to avoid the N+1 problem. Accepts either relation names or a relation name + a scope function to constrain the sub-query. |
| `include` | `include(...relations)` | Alias for with() — mirrors Entity Framework include syntax. |
| `withCount` | `withCount(...relations)` | Eager-count one or more relationships without loading the records. Adds a `RelationName_count` field to each result instance. |
| `onReplica` | `onReplica()` | Force this query to execute against a read replica (if configured). Falls back to primary adapter if no replica manager is attached. |
| `explain` | `explain([options])` | Get the query execution plan from the adapter. For SQL adapters, returns EXPLAIN / EXPLAIN QUERY PLAN output. For the memory adapter, returns a plan description object. |
| `scope` | `scope(name, ...args)` | Apply a named scope from the model. Allows chaining multiple scopes on a single query. |


#### Execution

| Method | Signature | Description |
|---|---|---|
| `build` | `build()` | Build the abstract query descriptor. |
| `exec` | `exec()` | Execute the query and return results. |
| `first` | `first()` | Execute and return the first result. |
| `count` | `count()` | Count matching records. |
| `exists` | `exists()` | Check whether any matching records exist. |
| `pluck` | `pluck(field)` | Get an array of values for a single column. |
| `sum` | `sum(field)` | SUM of a numeric column. |
| `avg` | `avg(field)` | AVG of a numeric column. |
| `min` | `min(field)` | MIN of a column. |
| `max` | `max(field)` | MAX of a column. |
| `then` | `then(resolve, reject)` | Make Query thenable — allows `await query`. |


#### Aliases

| Method | Signature | Description |
|---|---|---|
| `take` | `take(n)` | Alias for limit (LINQ naming). |
| `skip` | `skip(n)` | Alias for offset (LINQ naming). |
| `toArray` | `toArray()` | Alias for exec — explicitly convert to array. |
| `orderByDesc` | `orderByDesc(field)` | Shorthand for orderBy(field, 'desc'). |
| `orderByDescending` | `orderByDescending(field)` | C# alias: OrderByDescending. |
| `firstOrDefault` | `firstOrDefault()` | Alias for first() — C# FirstOrDefault returns null on empty. |
| `average` | `average(field)` | Alias for avg() — C# naming. |
| `aggregate` | `aggregate(fn, seed)` | Alias for reduce() — C# Aggregate naming. |


#### Element Operators

| Method | Signature | Description |
|---|---|---|
| `last` | `last()` | Execute and return the last result. Reverses the first orderBy or defaults to primary key DESC. |
| `lastOrDefault` | `lastOrDefault()` | Alias for last() — C# naming. |
| `single` | `single()` | Returns the only element. Throws if count !== 1. |
| `singleOrDefault` | `singleOrDefault()` | Returns the only element, or null if empty. Throws if more than one. |
| `elementAt` | `elementAt(index)` | Get element at a specific index. |
| `elementAtOrDefault` | `elementAtOrDefault(index)` | Get element at index, or null if out of range. |
| `defaultIfEmpty` | `defaultIfEmpty(defaultValue)` | Returns results, or an array with defaultValue if empty. |


#### Quantifiers

| Method | Signature | Description |
|---|---|---|
| `any` | `any([predicate])` | Returns true if any elements match. With a predicate, filters post-execution. Without a predicate, equivalent to exists(). |
| `all` | `all(predicate)` | Returns true if all elements match the predicate. |
| `contains` | `contains(field, value)` | Returns true if any record has the given value for a column. |
| `sequenceEqual` | `sequenceEqual(other, [compareFn])` | Compares results of this query with another for equality. |


#### Set Operations

| Method | Signature | Description |
|---|---|---|
| `concat` | `concat(other)` | Append results from another query or array. |
| `union` | `union(other, [keyFn])` | Distinct union of this query's results with another. |
| `intersect` | `intersect(other, [keyFn])` | Elements common to both this query and another. |
| `except` | `except(other, [keyFn])` | Elements in this query but not in other. |


#### Projection

| Method | Signature | Description |
|---|---|---|
| `selectMany` | `selectMany(fn)` | FlatMap — project each element to an array and flatten. |
| `zip` | `zip(other, fn)` | Combine two result sets element-wise. |
| `toDictionary` | `toDictionary(keyFn, [valueFn])` | Convert results to a Map keyed by a selector. |
| `toLookup` | `toLookup(keyFn)` | Group results into a Map of arrays keyed by a selector. |


#### Partitioning

| Method | Signature | Description |
|---|---|---|
| `takeWhile` | `takeWhile(predicate)` | Take elements while predicate returns true (post-execution). |
| `skipWhile` | `skipWhile(predicate)` | Skip elements while predicate returns true, then return the rest. |


#### Post-Execution Transforms

| Method | Signature | Description |
|---|---|---|
| `reverse` | `reverse()` | Reverse the result order. |
| `append` | `append(...items)` | Append items to the end of results. |
| `prepend` | `prepend(...items)` | Prepend items to the beginning of results. |
| `distinctBy` | `distinctBy(keyFn)` | Distinct by a key selector (post-execution). |


#### Aggregate with Selectors

| Method | Signature | Description |
|---|---|---|
| `minBy` | `minBy(fn)` | Element with the minimum value from a selector. |
| `maxBy` | `maxBy(fn)` | Element with the maximum value from a selector. |
| `sumBy` | `sumBy(fn)` | Sum using a value selector. |
| `averageBy` | `averageBy(fn)` | Average using a value selector. |
| `countBy` | `countBy(keyFn)` | Count elements per group using a key selector. |


#### Conditional & Debugging

| Method | Signature | Description |
|---|---|---|
| `when` | `when(condition, fn)` | Conditionally apply query logic. If `condition` is truthy, calls `fn(query)`. Perfect for optional filters. |
| `unless` | `unless(condition, fn)` | Inverse of when — apply query logic when condition is falsy. |
| `tap` | `tap(fn)` | Inspect the query without breaking the chain. Calls `fn(this)` for side effects (logging, debugging). |
| `chunk` | `chunk(size, fn)` | Process results in batches. Calls `fn(batch, batchIndex)` for each chunk. Useful for processing large datasets without loading everything into memory. |
| `each` | `each(fn)` | Execute and iterate each result with a callback. |
| `map` | `map(fn)` | Execute, transform results with a mapper, and return the mapped array. |
| `filter` | `filter(fn)` | Execute, filter results with a predicate, and return matches. |
| `reduce` | `reduce(fn, initial)` | Execute and reduce results to a single value. |
| `paginate` | `paginate(pg, [perPage])` | Rich pagination with metadata. Returns `{ data, total, page, perPage, pages, hasNext, hasPrev }`. |
| `whereRaw` | `whereRaw(sql, ...params)` | Inject a raw WHERE clause for SQL adapters. Ignored by non-SQL adapters (memory, json, mongo). |


```js
  const users = await User.query()
      .where('age', '>', 18)
      .where('role', 'admin')
      .orderBy('name', 'asc')
      .limit(10)
      .offset(20)
      .select('name', 'email');
```


### SQLite Adapter

SQLite adapter using the optional `better-sqlite3` driver. Requires: `npm install better-sqlite3`

#### Statement Caching

| Method | Signature | Description |
|---|---|---|
| `stmtCacheStats` | `stmtCacheStats()` | Get prepared statement cache statistics. |
| `explain` | `explain(descriptor)` | Get the query execution plan (EXPLAIN QUERY PLAN). |
| `createTable` | `createTable(table, schema)` | Create a table with the given schema. |
| `dropTable` | `dropTable(table)` | Drop a table if it exists. |
| `insert` | `insert(table, data)` | Insert a single row. |
| `insertMany` | `insertMany(table, dataArray)` | Insert multiple rows in a batch. |
| `update` | `update(table, pk, pkVal, data)` | Update a single row by primary key. |
| `updateWhere` | `updateWhere(table, conditions, data)` | Update rows matching the given conditions. |
| `remove` | `remove(table, pk, pkVal)` | Delete a single row by primary key. |
| `deleteWhere` | `deleteWhere(table, conditions)` | Delete rows matching the given conditions. |
| `execute` | `execute(descriptor)` | Execute a query descriptor built by the Query builder. |
| `aggregate` | `aggregate(descriptor)` | Execute an aggregate function (count, sum, avg, min, max). |


#### SQLite Utilities

| Method | Signature | Description |
|---|---|---|
| `ping` | `ping()` | Ping the database to check connectivity. |
| `pragma` | `pragma(key)` | Read a single PRAGMA value. |
| `checkpoint` | `checkpoint([mode])` | Force a WAL checkpoint (only useful in WAL mode). |
| `integrity` | `integrity()` | Run `PRAGMA integrity_check`. |
| `vacuum` | `vacuum()` | Rebuild the database file, reclaiming free pages. |
| `fileSize` | `fileSize()` | Get the size of the database file in bytes. Returns 0 for in-memory databases. |
| `tables` | `tables()` | List all user-created tables. |
| `close` | `close()` | Close the database connection. |
| `raw` | `raw(sql, ...params)` | Run a raw SQL query. |
| `transaction` | `transaction(fn)` | Begin a transaction. |


#### Table Info & Debug (Schema Introspection)

| Method | Signature | Description |
|---|---|---|
| `columns` | `columns(table)` | Get column information for a table. |
| `indexes` | `indexes(table)` | Get indexes for a table. |
| `foreignKeys` | `foreignKeys(table)` | Get foreign keys for a table. |
| `tableStatus` | `tableStatus([table])` | Get detailed table status (size estimates, row counts). |
| `overview` | `overview()` | Get counts for all tables — structured database overview. |
| `pageInfo` | `pageInfo()` | Get the page size and page count (helps estimate table overhead). |
| `compileOptions` | `compileOptions()` | Get compile-time options that SQLite was built with. |
| `cacheStatus` | `cacheStatus()` | Get the number of cached prepared statements. |


#### Schema Migrations

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `addColumn(table, column, colDef)` | Add a column to an existing table. |
| `dropColumn` | `dropColumn(table, column)` | Drop a column from an existing table. Requires SQLite 3.35.0+ (2021-03-12). |
| `renameColumn` | `renameColumn(table, oldName, newName)` | Rename a column in an existing table. Requires SQLite 3.25.0+ (2018-09-15). |
| `renameTable` | `renameTable(oldName, newName)` | Rename a table. |
| `createIndex` | `createIndex(table, columns, [opts])` | Create an index. |
| `dropIndex` | `dropIndex(_table, name)` | Drop an index. |
| `hasTable` | `hasTable(table)` | Check if a table exists. |
| `hasColumn` | `hasColumn(table, column)` | Check if a column exists in a table. |
| `describeTable` | `describeTable(table)` | Get a unified table description. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `filename` | string | `':memory:'` | Path to SQLite file, or ':memory:'. |
| `readonly` | boolean | `false` | Open database in read-only mode. |
| `fileMustExist` | boolean | `false` | Throw if the database file does not exist. |
| `verbose` | boolean | `—` | Log every SQL statement (debug). |
| `createDir` | boolean | `true` | Automatically create parent directories for the file. |
| `pragmas` | object | `—` | PRAGMA settings to apply on open. |
| `pragmas.journal_mode` | string | `'WAL'` | Journal mode (WAL, DELETE, TRUNCATE, MEMORY, OFF). |
| `pragmas.foreign_keys` | string | `'ON'` | Enforce foreign-key constraints. |
| `pragmas.busy_timeout` | string | `'5000'` | Milliseconds to wait on a locked database. |
| `pragmas.synchronous` | string | `'NORMAL'` | Sync mode (OFF, NORMAL, FULL, EXTRA). |
| `pragmas.cache_size` | string | `'-64000'` | Page cache size (negative = KiB, e.g. -64000 = 64 MB). |
| `pragmas.temp_store` | string | `'MEMORY'` | Temp tables in memory for speed. |
| `pragmas.mmap_size` | string | `'268435456'` | Memory-mapped I/O size (256 MB). |
| `pragmas.page_size` | string | `—` | Page size in bytes (must be set before WAL). |
| `pragmas.auto_vacuum` | string | `—` | Auto-vacuum mode (NONE, FULL, INCREMENTAL). |
| `pragmas.secure_delete` | string | `—` | Overwrite deleted content with zeros. |
| `pragmas.wal_autocheckpoint` | string | `—` | Pages before auto-checkpoint (default 1000). |
| `pragmas.locking_mode` | string | `—` | NORMAL or EXCLUSIVE. |


```js
  const { Database, Model, TYPES } = require('zero-http');

  const db = Database.connect('sqlite', { filename: './app.db' });

  class User extends Model {
      static table  = 'users';
      static schema = {
          id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
          name:  { type: TYPES.STRING,  required: true },
          email: { type: TYPES.STRING,  required: true, unique: true },
      };
      static timestamps = true;
  }

  db.register(User);
  await db.sync();

  const user = await User.create({ name: 'Alice', email: 'a@b.com' });
  const found = await User.findById(user.id);
```


### MySQL Adapter

MySQL / MariaDB adapter using the optional `mysql2` driver. Requires: `npm install mysql2`

#### MySQL Utilities

| Method | Signature | Description |
|---|---|---|
| `tables` | `tables()` | List all user-created tables in the current database. |
| `columns` | `columns(table)` | Get the columns of a table. |
| `databaseSize` | `databaseSize()` | Get the current database size in bytes. |
| `poolStatus` | `poolStatus()` | Get connection pool status. |
| `version` | `version()` | Get the MySQL/MariaDB server version string. |
| `ping` | `ping()` | Ping the database to check connectivity. |
| `exec` | `exec(sql, ...params)` | Execute a raw statement that doesn't return rows (INSERT, UPDATE, DDL). |


#### Table Info & Debug (Schema Introspection)

| Method | Signature | Description |
|---|---|---|
| `tableStatus` | `tableStatus([table])` | Get detailed table status (rows, size, engine, collation, etc.). Returns a structured database overview. |
| `tableSize` | `tableSize(table)` | Get table size in a human-readable format. |
| `indexes` | `indexes(table)` | Get indexes for a table. |
| `tableCharset` | `tableCharset(table)` | Get the charset and collation of a table. |
| `foreignKeys` | `foreignKeys(table)` | Get foreign keys for a table. |
| `overview` | `overview()` | Get full database overview — all tables with size and row counts. Returns a structured database summary. |
| `variables` | `variables([filter])` | Get the server variables (global settings). |
| `processlist` | `processlist()` | Get processlist — active connections/queries. |
| `alterTable` | `alterTable(table, opts)` | Alter a table's engine, charset, or collation. |


#### Schema Migrations

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `addColumn(table, column, colDef, [opts])` | Add a column to an existing table. |
| `dropColumn` | `dropColumn(table, column)` | Drop a column from an existing table. |
| `renameColumn` | `renameColumn(table, oldName, newName)` | Rename a column. |
| `renameTable` | `renameTable(oldName, newName)` | Rename a table. |
| `createIndex` | `createIndex(table, columns, [opts])` | Create an index. |
| `dropIndex` | `dropIndex(table, name)` | Drop an index. |
| `addForeignKey` | `addForeignKey(table, column, refTable, refColumn, [options])` | Add a foreign key constraint. |
| `dropForeignKey` | `dropForeignKey(table, fkName)` | Drop a foreign key constraint. |
| `hasTable` | `hasTable(table)` | Check if a table exists. |
| `hasColumn` | `hasColumn(table, column)` | Check if a column exists in a table. |
| `describeTable` | `describeTable(table)` | Get a unified table description. |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `createTable` | `createTable(table, schema)` | Create a table with the given schema. |
| `dropTable` | `dropTable(table)` | Drop a table if it exists. |
| `insert` | `insert(table, data)` | Insert a single row. |
| `insertMany` | `insertMany(table, dataArray)` | Insert multiple rows in a batch. |
| `update` | `update(table, pk, pkVal, data)` | Update a single row by primary key. |
| `updateWhere` | `updateWhere(table, conditions, data)` | Update rows matching the given conditions. |
| `remove` | `remove(table, pk, pkVal)` | Delete a single row by primary key. |
| `deleteWhere` | `deleteWhere(table, conditions)` | Delete rows matching the given conditions. |
| `execute` | `execute(descriptor)` | Execute a query descriptor built by the Query builder. |
| `aggregate` | `aggregate(descriptor)` | Execute an aggregate function (count, sum, avg, min, max). |
| `explain` | `explain(descriptor, [options])` | Get the query execution plan (EXPLAIN). |
| `stmtCacheStats` | `stmtCacheStats()` | Get prepared statement cache statistics. mysql2 handles prepared statement caching internally per connection. |
| `warmup` | `warmup([count])` | Pre-warm the connection pool by creating idle connections. |
| `close` | `close()` | Close the database connection. |
| `raw` | `raw()` |  |
| `transaction` | `transaction()` |  |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | string | `'localhost'` | Server hostname. |
| `port` | number | `3306` | Server port. |
| `user` | string | `'root'` | Database user. |
| `password` | string | `''` | Database password. |
| `database` | string | `—` | Database name. |
| `connectionLimit` | number | `10` | Max pool connections. |
| `waitForConnections` | boolean | `true` | Queue when pool is full. |
| `queueLimit` | number | `0` | Max queued requests (0 = unlimited). |
| `connectTimeout` | number | `10000` | Connection timeout in ms. |
| `charset` | string | `'utf8mb4'` | Default character set. |
| `timezone` | string | `'Z'` | Session timezone. |
| `multipleStatements` | boolean | `false` | Allow multi-statement queries. |
| `decimalNumbers` | boolean | `false` | Return DECIMAL as numbers instead of strings. |
| `ssl` | string | `—` | SSL profile or options object. |


```js
  const { Database, Model, TYPES } = require('zero-http');

  const db = Database.connect('mysql', {
      host: '127.0.0.1',
      user: 'root',
      password: '',
      database: 'myapp',
  });

  class Product extends Model {
      static table  = 'products';
      static schema = {
          id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
          name:  { type: TYPES.STRING,  required: true, maxLength: 255 },
          price: { type: TYPES.DECIMAL, required: true, min: 0 },
      };
      static timestamps = true;
  }

  db.register(Product);
  await db.sync();

  await Product.create({ name: 'Widget', price: 9.99 });
  const cheap = await Product.query().where('price', '<', 20).exec();
```


### PostgreSQL Adapter

PostgreSQL adapter using the optional `pg` driver. Requires: `npm install pg`

#### PostgreSQL Utilities

| Method | Signature | Description |
|---|---|---|
| `tables` | `tables([schema])` | List all user-created tables in the current schema. |
| `columns` | `columns(table, [schema])` | Get column information for a table. |
| `databaseSize` | `databaseSize()` | Get the current database size in bytes. |
| `tableSize` | `tableSize(table)` | Get the row count for a table (estimated for large tables, exact for small ones). |
| `poolStatus` | `poolStatus()` | Get connection pool status. |
| `version` | `version()` | Get the PostgreSQL server version string. |
| `ping` | `ping()` | Ping the database to check connectivity. |
| `exec` | `exec(sql, ...params)` | Execute a raw statement that doesn't return rows (INSERT, UPDATE, DDL). |


#### Table Info & Debug (Schema Introspection)

| Method | Signature | Description |
|---|---|---|
| `tableStatus` | `tableStatus([table])` | Get detailed table status (rows, sizes, etc.) from pg_stat_user_tables. |
| `tableSizeFormatted` | `tableSizeFormatted(table)` | Get table size in human-readable format. |
| `indexes` | `indexes(table)` | Get indexes for a table. |
| `foreignKeys` | `foreignKeys(table)` | Get foreign keys for a table. |
| `overview` | `overview()` | Get full database overview — all tables with size and row counts. |
| `variables` | `variables([filter])` | Get server settings/variables. |
| `processlist` | `processlist()` | Get active backends (like MySQL SHOW PROCESSLIST). |
| `constraints` | `constraints(table)` | Get table constraints (PRIMARY KEY, UNIQUE, CHECK, FK). |
| `comments` | `comments(table)` | Get table and column comments for schema documentation. |
| `listen` | `listen(channel, callback)` | Run a LISTEN/NOTIFY style query. Useful for subscribing to PG notifications. |


#### Migration / DDL Methods

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `addColumn(table, column, def)` | Add a column to an existing table. |
| `dropColumn` | `dropColumn(table, column)` | Drop a column from a table. |
| `renameColumn` | `renameColumn(table, oldName, newName)` | Rename a column. |
| `renameTable` | `renameTable(oldName, newName)` | Rename a table. |
| `createIndex` | `createIndex(table, columns, [options])` | Create an index on a table. |
| `dropIndex` | `dropIndex(name)` | Drop an index. |
| `addForeignKey` | `addForeignKey(table, column, refTable, refColumn, [options])` | Add a foreign key constraint. |
| `dropForeignKey` | `dropForeignKey(table, constraintName)` | Drop a foreign key constraint. |
| `hasTable` | `hasTable(table)` | Check if a table exists. |
| `hasColumn` | `hasColumn(table, column)` | Check if a column exists on a table. |
| `describeTable` | `describeTable(table)` | Get detailed column info for a table (migration-friendly format). |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `createTable` | `createTable(table, schema)` | Create a table with the given schema. |
| `dropTable` | `dropTable(table)` | Drop a table if it exists. |
| `insert` | `insert(table, data)` | Insert a single row. |
| `insertMany` | `insertMany(table, dataArray)` | Insert multiple rows in a batch. |
| `update` | `update(table, pk, pkVal, data)` | Update a single row by primary key. |
| `updateWhere` | `updateWhere(table, conditions, data)` | Update rows matching the given conditions. |
| `remove` | `remove(table, pk, pkVal)` | Delete a single row by primary key. |
| `deleteWhere` | `deleteWhere(table, conditions)` | Delete rows matching the given conditions. |
| `execute` | `execute(descriptor)` | Execute a query descriptor built by the Query builder. |
| `aggregate` | `aggregate(descriptor)` | Execute an aggregate function (count, sum, avg, min, max). |
| `explain` | `explain(descriptor, [options])` | Get the query execution plan (EXPLAIN). |
| `stmtCacheStats` | `stmtCacheStats()` | Get prepared statement cache statistics. |
| `warmup` | `warmup([count])` | Pre-warm the connection pool by creating idle connections. |
| `close` | `close()` | Close the database connection. |
| `raw` | `raw()` |  |
| `transaction` | `transaction()` |  |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `user` | string | `—` | Database user. |
| `password` | string | `—` | Database password. |
| `database` | string | `—` | Database name. |
| `max` | number | `10` | Max pool size. |
| `idleTimeoutMillis` | number | `10000` | Idle client timeout. |
| `connectionTimeoutMillis` | number | `0` | Connection timeout (0 = no limit). |
| `ssl` | boolean \| object | `—` | SSL mode or TLS options. |
| `connectionString` | string | `—` | Full connection URI (overrides individual settings). |
| `application_name` | string | `—` | Identify the app in pg_stat_activity. |
| `statement_timeout` | number | `—` | Statement timeout in ms. |


```js
  const { Database, Model, TYPES } = require('zero-http');

  const db = Database.connect('postgres', {
      host: '127.0.0.1',
      user: 'postgres',
      password: '',
      database: 'myapp',
  });

  class Article extends Model {
      static table  = 'articles';
      static schema = {
          id:      { type: TYPES.SERIAL, primaryKey: true },
          title:   { type: TYPES.STRING,  required: true },
          content: { type: TYPES.TEXT },
          tags:    { type: TYPES.JSONB, default: [] },
      };
      static timestamps = true;
  }

  db.register(Article);
  await db.sync();

  await Article.create({ title: 'Hello', content: 'World', tags: ['intro'] });
  const recent = await Article.query().orderBy('createdAt', 'desc').limit(10).exec();
```


### MongoDB Adapter

MongoDB adapter using the optional `mongodb` driver. Requires: `npm install mongodb`

#### DDL

| Method | Signature | Description |
|---|---|---|
| `createTable` | `createTable(table, schema)` | Create a table with the given schema. |
| `dropTable` | `dropTable(table)` | Drop a table if it exists. |


#### CRUD

| Method | Signature | Description |
|---|---|---|
| `insert` | `insert(table, data)` | Insert a single row. |
| `insertMany` | `insertMany(table, dataArray)` | Insert multiple rows in a batch. |
| `aggregate` | `aggregate(descriptor)` | Execute an aggregate function (count, sum, avg, min, max). |
| `update` | `update(table, pk, pkVal, data)` | Update a single row by primary key. |
| `updateWhere` | `updateWhere(table, conditions, data)` | Update rows matching the given conditions. |
| `remove` | `remove(table, pk, pkVal)` | Delete a single row by primary key. |
| `deleteWhere` | `deleteWhere(table, conditions)` | Delete rows matching the given conditions. |


#### Query execution

| Method | Signature | Description |
|---|---|---|
| `execute` | `execute(descriptor)` | Execute a query descriptor built by the Query builder. |


#### Utility

| Method | Signature | Description |
|---|---|---|
| `close` | `close()` | Close the database connection. |
| `raw` | `raw(command)` | Run a raw MongoDB command. |
| `transaction` | `transaction(fn)` | Run multiple operations in a transaction (requires replica set). |


#### MongoDB Utilities

| Method | Signature | Description |
|---|---|---|
| `collections` | `collections()` | List all collections in the database. |
| `stats` | `stats()` | Get database stats (document count, storage size, indexes, etc.). |
| `collectionStats` | `collectionStats(name)` | Get collection stats. |
| `createIndex` | `createIndex(collection, keys, [options])` | Create an index on a collection. |
| `indexes` | `indexes(collection)` | List indexes on a collection. |
| `dropIndex` | `dropIndex(collection, indexName)` | Drop an index from a collection. |
| `ping` | `ping()` | Ping the MongoDB server. |
| `version` | `version()` | Get MongoDB server version and build info. |
| `isConnected` | `isConnected()` | Check if connected. |


#### Migration / DDL Methods

| Method | Signature | Description |
|---|---|---|
| `hasTable` | `hasTable(table)` | Check if a collection exists. |
| `hasColumn` | `hasColumn(table, column)` | Check if a field exists in any document of a collection. |
| `renameTable` | `renameTable(oldName, newName)` | Rename a collection. |
| `addColumn` | `addColumn(table, column, def)` | Add a field to all documents (sets default for existing docs). |
| `dropColumn` | `dropColumn(table, column)` | Remove a field from all documents. |
| `renameColumn` | `renameColumn(table, oldName, newName)` | Rename a field in all documents. |
| `describeTable` | `describeTable(table, [sampleSize])` | Describe the inferred schema of a collection by sampling documents. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `database` | string | `—` | Database name. |
| `maxPoolSize` | number | `10` | Max connection pool size. |
| `minPoolSize` | number | `0` | Min connection pool size. |
| `connectTimeoutMS` | number | `10000` | Connection timeout. |
| `socketTimeoutMS` | number | `0` | Socket timeout (0 = no limit). |
| `serverSelectionTimeoutMS` | number | `30000` | Server selection timeout. |
| `retryWrites` | boolean | `true` | Retry writes on network errors. |
| `retryReads` | boolean | `true` | Retry reads on network errors. |
| `authSource` | string | `—` | Auth database name. |
| `replicaSet` | string | `—` | Replica set name. |
| `clientOptions` | object | `—` | Extra MongoClient options (passed directly). |


```js
  const { Database, Model, TYPES } = require('zero-http');

  const db = Database.connect('mongo', {
      url: 'mongodb://localhost:27017',
      database: 'myapp',
  });

  class Event extends Model {
      static table  = 'events';
      static schema = {
          id:      { type: TYPES.STRING, primaryKey: true },
          name:    { type: TYPES.STRING, required: true },
          payload: { type: TYPES.JSON,   default: {} },
      };
      static timestamps = true;
  }

  db.register(Event);
  await db.sync();

  await Event.create({ name: 'signup', payload: { userId: 42 } });
  const signups = await Event.find({ name: 'signup' });
```


### Redis Adapter

Redis database adapter for the zero-http ORM. Uses `ioredis` as the driver. Stores table data as Redis hashes with sorted-set indexes for ordering and filtering. Bring-your-own-driver: `npm install ioredis` Supports full ORM CRUD, key-value operations, pub/sub, pipelines, TTL, and all DDL/migration methods.

#### Table Management

| Method | Signature | Description |
|---|---|---|
| `createTable` | `createTable(table, [schema])` | Create a table (register schema + initialize index). |
| `dropTable` | `dropTable(table)` | Drop a table (delete all keys). |


#### CRUD Operations

| Method | Signature | Description |
|---|---|---|
| `insert` | `insert(table, data)` | Insert a row. |
| `insertMany` | `insertMany(table, dataArray)` | Insert multiple rows. |
| `update` | `update(table, pk, pkVal, data)` | Update a row by primary key. |
| `updateWhere` | `updateWhere(table, conditions, data)` | Update all rows matching conditions. |
| `remove` | `remove(table, pk, pkVal)` | Remove a row by primary key. |
| `deleteWhere` | `deleteWhere(table, conditions)` | Delete all rows matching conditions. |


#### Query Execution

| Method | Signature | Description |
|---|---|---|
| `execute` | `execute(descriptor)` | Execute a query descriptor (from the Query builder). |
| `aggregate` | `aggregate(descriptor)` | Compute an aggregate value. |


#### Redis-Specific Operations

| Method | Signature | Description |
|---|---|---|
| `get` | `get(key)` | Get a value by key (raw Redis GET). |
| `set` | `set(key, value, [ttl])` | Set a key-value pair (raw Redis SET). |
| `del` | `del(key)` | Delete a key. |
| `exists` | `exists(key)` | Check if a key exists. |
| `expire` | `expire(key, seconds)` | Set expiration on a key. |
| `ttl` | `ttl(key)` | Get TTL of a key in seconds. |
| `incr` | `incr(key, [by])` | Increment a numeric key. |
| `decr` | `decr(key, [by])` | Decrement a numeric key. |


#### Hash Operations

| Method | Signature | Description |
|---|---|---|
| `hset` | `hset(key, field, value)` | Set a hash field. |
| `hget` | `hget(key, field)` | Get a hash field. |
| `hgetall` | `hgetall(key)` | Get all fields in a hash. |
| `hdel` | `hdel(key, field)` | Delete a hash field. |


#### List Operations

| Method | Signature | Description |
|---|---|---|
| `rpush` | `rpush(key, ...values)` | Push values to the end of a list. |
| `lpush` | `lpush(key, ...values)` | Push values to the beginning of a list. |
| `lrange` | `lrange(key, [start], [stop])` | Get a range of list elements. |
| `rpop` | `rpop(key)` | Pop from the end of a list. |
| `lpop` | `lpop(key)` | Pop from the beginning of a list. |
| `llen` | `llen(key)` | Get list length. |


#### Set Operations

| Method | Signature | Description |
|---|---|---|
| `sadd` | `sadd(key, ...members)` | Add members to a set. |
| `smembers` | `smembers(key)` | Get all members of a set. |
| `sismember` | `sismember(key, member)` | Check if a value is a member of a set. |
| `srem` | `srem(key, member)` | Remove a member from a set. |
| `scard` | `scard(key)` | Get the number of members in a set. |


#### Sorted Set Operations

| Method | Signature | Description |
|---|---|---|
| `zadd` | `zadd(key, score, member)` | Add a member to a sorted set. |
| `zrangebyscore` | `zrangebyscore(key, min, max)` | Get members from a sorted set by score range. |
| `zrange` | `zrange(key, start, stop)` | Get members from a sorted set by rank range. |
| `zrem` | `zrem(key, member)` | Remove a member from a sorted set. |
| `zcard` | `zcard(key)` | Get sorted set cardinality. |


#### Pub/Sub

| Method | Signature | Description |
|---|---|---|
| `subscribe` | `subscribe(channel, callback)` | Subscribe to a channel. |
| `publish` | `publish(channel, message)` | Publish a message to a channel. |


#### Pipeline / Batch

| Method | Signature | Description |
|---|---|---|
| `pipeline` | `pipeline()` | Create a pipeline for batching commands. |


#### Transaction Support

| Method | Signature | Description |
|---|---|---|
| `beginTransaction` | `beginTransaction()` | Begin a Redis MULTI transaction. |
| `commit` | `commit()` | Commit a MULTI transaction. |
| `rollback` | `rollback()` | Discard a MULTI transaction. |


#### Utility & Admin

| Method | Signature | Description |
|---|---|---|
| `clear` | `clear()` | Clear all data (flush matched prefix keys). Uses SCAN for safety in production (no KEYS *). |
| `ping` | `ping()` | Ping the Redis server. |
| `info` | `info([section])` | Get Redis server info. |
| `dbsize` | `dbsize()` | Get database size (number of keys). |
| `tables` | `tables()` | List all table names (by scanning for schema keys). |
| `stats` | `stats()` | Get stats for the adapter. |
| `poolStatus` | `poolStatus()` | Get pool/connection status. |
| `client` | `client()` | Get the underlying ioredis client. |
| `raw` | `raw(command, ...args)` | Execute a raw Redis command. |
| `close` | `close()` | Close the connection. |


#### Migration / DDL Methods

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `addColumn(table, column, def)` | Add a column to an existing table. |
| `dropColumn` | `dropColumn(table, column)` | Drop a column from a table. |
| `renameColumn` | `renameColumn(table, oldName, newName)` | Rename a column. |
| `renameTable` | `renameTable(oldName, newName)` | Rename a table. |
| `createIndex` | `createIndex(table, columns, [options])` | Create an index (tracked in metadata). |
| `dropIndex` | `dropIndex(_table, name)` | Drop an index. |
| `hasTable` | `hasTable(table)` | Check if a table exists. |
| `hasColumn` | `hasColumn(table, column)` | Check if a column exists on a table. |
| `describeTable` | `describeTable(table)` | Describe a table's columns. |
| `indexes` | `indexes(table)` | Get indexes for a table. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | string | `—` | Redis connection URL. |
| `host` | string | `'127.0.0.1'` | Redis host. |
| `port` | number | `6379` | Redis port. |
| `password` | string | `—` | Redis password. |
| `db` | number | `0` | Redis database index. |
| `prefix` | string | `'zh:'` | Key prefix for namespacing. |
| `maxRetries` | number | `3` | Max connection retries. |
| `lazyConnect` | boolean | `false` | If true, defer connection until first operation. |
| `tls` | object | `—` | TLS options for secure connections. |
| `keyPrefix` | string | `—` | Alias for prefix (ioredis compat). |
| `connectTimeout` | number | `10000` | Connection timeout in ms. |


```js
  // Connect by host/port
  const db = Database.connect('redis', { host: '127.0.0.1', port: 6379 });

  // Connect by URL with authentication
  const db2 = Database.connect('redis', { url: 'redis://user:pass@host:6379/0' });

  // Connect with key prefix
  const db3 = Database.connect('redis', { url: 'redis://host:6379', prefix: 'myapp:' });
```


### Memory Adapter

In-memory database adapter. Zero-dependency, perfect for testing, prototyping, and applications that don't need persistence beyond the process lifecycle. All data is stored in plain JavaScript Maps and arrays. Supports full CRUD, filtering, ordering, pagination, and counting.

#### Memory Adapter Utilities

| Method | Signature | Description |
|---|---|---|
| `tables` | `tables()` | List all registered table names. |
| `totalRows` | `totalRows()` | Get the total number of rows across all tables. |
| `stats` | `stats()` | Get memory usage stats. |
| `toJSON` | `toJSON()` | Export all data as a plain object. |
| `fromJSON` | `fromJSON(data)` | Import data from a plain object, merging with existing data. |
| `clone` | `clone()` | Clone the entire database state (deep copy). |


#### Migration / DDL Methods

| Method | Signature | Description |
|---|---|---|
| `addColumn` | `addColumn(table, column, def)` | Add a column to an existing table (sets default for existing rows). |
| `dropColumn` | `dropColumn(table, column)` | Drop a column from a table. |
| `renameColumn` | `renameColumn(table, oldName, newName)` | Rename a column. |
| `renameTable` | `renameTable(oldName, newName)` | Rename a table. |
| `createIndex` | `createIndex(table, columns, [options])` | Create an index (tracked in metadata, no-op for queries). |
| `dropIndex` | `dropIndex(_table, name)` | Drop an index. |
| `hasTable` | `hasTable(table)` | Check if a table exists. |
| `hasColumn` | `hasColumn(table, column)` | Check if a column exists on a table. |
| `describeTable` | `describeTable(table)` | Get column info for a table. |
| `indexes` | `indexes(table)` | Get indexes for a table. |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `createTable` | `createTable(table, schema)` | Create a table (register schema). |
| `dropTable` | `dropTable(table)` | Drop a table. |
| `insert` | `insert(table, data)` | Insert a row. |
| `insertMany` | `insertMany(table, dataArray)` | Insert multiple rows at once. |
| `update` | `update(table, pk, pkVal, data)` | Update a row by primary key. |
| `updateWhere` | `updateWhere(table, conditions, data)` | Update all rows matching conditions. |
| `remove` | `remove(table, pk, pkVal)` | Remove a row by primary key. |
| `deleteWhere` | `deleteWhere(table, conditions)` | Delete all rows matching conditions. |
| `execute` | `execute(descriptor)` | Execute a query descriptor (from the Query builder). |
| `aggregate` | `aggregate(descriptor)` | Compute an aggregate value in memory. |
| `explain` | `explain(descriptor)` | Get the query execution plan (memory adapter). Returns a description object since there is no real query plan. |
| `clear` | `clear()` | Clear all data (for testing). |


```js
  const { Database, Model, TYPES } = require('zero-http');

  const db = Database.connect('memory');

  class Task extends Model {
      static table  = 'tasks';
      static schema = {
          id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
          title: { type: TYPES.STRING,  required: true },
          done:  { type: TYPES.BOOLEAN, default: false },
      };
  }

  db.register(Task);
  await db.sync();

  await Task.create({ title: 'Write tests' });
  const pending = await Task.find({ done: false });
```


### JSON Adapter

JSON file-backed database adapter. Persists data to JSON files on disk — one file per table. Zero-dependency, suitable for prototyping, small apps, and embedded scenarios. Uses atomic writes for safety.

#### JSON Adapter Utilities

| Method | Signature | Description |
|---|---|---|
| `directory` | `directory()` | Get the directory where JSON files are stored. |
| `fileSize` | `fileSize()` | Get the total size of all JSON files in bytes. |
| `hasPendingWrites` | `hasPendingWrites()` | Check if there are pending writes that haven't been flushed. |
| `compact` | `compact(table)` | Compact a specific table's JSON file (re-serialize, removes whitespace bloat). |
| `backup` | `backup(destDir)` | Back up the entire data directory to a target path. |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `createTable` | `createTable(table, schema)` | Create a table with the given schema. |
| `dropTable` | `dropTable(table)` | Drop a table if it exists. |
| `insert` | `insert(table, data)` | Insert a single row. |
| `update` | `update(table, pk, pkVal, data)` | Update a single row by primary key. |
| `updateWhere` | `updateWhere(table, conditions, data)` | Update rows matching the given conditions. |
| `remove` | `remove(table, pk, pkVal)` | Delete a single row by primary key. |
| `deleteWhere` | `deleteWhere(table, conditions)` | Delete rows matching the given conditions. |
| `clear` | `clear(table)` | Delete all rows from a table. |
| `flush` | `flush()` | Immediately flush all pending writes. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `dir` | string | `—` | Directory to store JSON files. Created if needed. |
| `pretty` | boolean | `true` | Pretty-print JSON files. |
| `flushInterval` | number | `50` | Debounce interval in ms for writes. |
| `autoFlush` | boolean | `true` | Automatically flush writes (set false for manual flush()). |


```js
  const { Database, Model, TYPES } = require('zero-http');

  const db = Database.connect('json', { directory: './data' });

  class Note extends Model {
      static table  = 'notes';
      static schema = {
          id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
          body:  { type: TYPES.TEXT, required: true },
      };
  }

  db.register(Note);
  await db.sync();

  await Note.create({ body: 'Hello world' });
  // Data persisted to ./data/notes.json
```


### Migrator

Versioned migration framework for the zero-http ORM. Supports up/down migrations, batch tracking, rollback, status reporting, and full reset/fresh operations.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `db` | import('./index').Database | Yes | Database instance. |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `add` | `add(migration)` | Add a migration definition. |
| `addAll` | `addAll(migrations)` | Add multiple migrations at once. |
| `migrate` | `migrate()` | Run all pending migrations. |
| `rollback` | `rollback()` | Rollback the last batch of migrations. |
| `rollbackAll` | `rollbackAll()` | Rollback all migrations (in reverse order, batch by batch). |
| `reset` | `reset()` | Reset the database: rollback all migrations, then re-run all. |
| `fresh` | `fresh()` | Fresh start: drop ALL tables (not just migrated ones) then re-migrate. ⚠️  DESTRUCTIVE — use with caution. |
| `status` | `status()` | Get the current migration status. |
| `hasPending` | `hasPending()` | Check if there are any pending migrations. |
| `list` | `list()` | Get the list of registered migration names. |
| `defineMigration` | `defineMigration(name, up, down)` | Helper to create a migration definition object. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `table` | string | `'_migrations'` | Migration tracking table name. |


```js
  const { Database, Migrator } = require('zero-http');

  const db = Database.connect('sqlite', { filename: './app.db' });

  const migrator = new Migrator(db);

  // Define migrations
  migrator.add({
      name: '001_create_users',
      async up(db) {
          await db.adapter.execute({
              action: 'raw',
              sql: `CREATE TABLE users (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT NOT NULL,
                  email TEXT UNIQUE
              )`
          });
      },
      async down(db) {
          await db.adapter.dropTable('users');
      }
  });

  // Run pending migrations
  const result = await migrator.migrate();

  // Rollback last batch
  await migrator.rollback();

  // Check status
  const status = await migrator.status();
```


### QueryCache

Query caching layer for the zero-http ORM. Provides an in-memory LRU cache with TTL support. Can also delegate to a Redis adapter for distributed caching.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `keyFromDescriptor` | `keyFromDescriptor(descriptor)` | Generate a cache key from a query descriptor. |
| `get` | `get(key)` | Get a cached value. |
| `set` | `set(key, value, [ttl])` | Set a cached value. |
| `delete` | `delete(key)` | Delete a specific cache entry. |
| `has` | `has(key)` | Check if a key exists in cache (and is not expired). |
| `invalidate` | `invalidate(table)` | Invalidate all cache entries for a specific table/model. Removes any cache key that contains the table name. |
| `flush` | `flush()` | Clear the entire cache. |
| `stats` | `stats()` | Get cache statistics. |
| `prune` | `prune()` | Remove expired entries (garbage collection). Called automatically but can be triggered manually. |
| `remember` | `remember(key, fn, [ttl])` | Get or set: return cached value if available, otherwise call fn() and cache the result. |
| `wrap` | `wrap(descriptor, executor, [ttl])` | Wrap a query execution with caching. Used internally by the Query builder's `.cache()` method. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxEntries` | number | `1000` | Maximum cache entries (LRU eviction). |
| `defaultTTL` | number | `60` | Default TTL in seconds (0 = no expiry). |
| `prefix` | string | `'qc:'` | Key prefix for cache namespacing. |
| `redis` | object | `—` | Redis adapter instance for distributed caching. |


```js
  const { Database, QueryCache } = require('zero-http');

  const db = Database.connect('sqlite', { filename: './app.db' });
  const cache = new QueryCache({ maxEntries: 500, defaultTTL: 60 });

  // Attach cache to database
  db.cache = cache;

  // Use in queries (via Model.query().cache(ttl))
  const users = await User.query().where('active', true).cache(30).exec();

  // Manual cache operations
  cache.set('custom:key', { data: 'value' }, 120);
  const val = cache.get('custom:key');
  cache.invalidate('users');   // Clear all user-related caches
  cache.flush();               // Clear everything
```


### Seeder & Factory

Base Seeder class and SeederRunner for orchestrating database seeding operations.

#### Seeder

| Method | Signature | Description |
|---|---|---|
| `Seeder` | `new Seeder(db)` | Extend this class to create a seeder.  Override `run(db)` with your seeding logic. |
| `run` | `run(db)` | Run the seeder.  Must be overridden in subclasses. |


#### SeederRunner

| Method | Signature | Description |
|---|---|---|
| `SeederRunner` | `new SeederRunner(db)` | Orchestrates running one or more seeders against a database connection. |
| `run` | `run(...seeders)` | Run one or more seeder classes (or instances) in order. |
| `call` | `call(SeederClass)` | Run a single seeder class or instance. |
| `fresh` | `fresh(...seeders)` | Clear all adapter data then run the provided seeders. Works with adapters that expose a `clear()` method (memory, json, redis). |


#### Factory

| Method | Signature | Description |
|---|---|---|
| `Factory` | `new Factory(ModelClass)` | Factory pattern for generating and persisting model records. |
| `define` | `define(definition)` | Define default field generators for the factory. Values can be static literals or functions `(index) => value`. |
| `count` | `count(n)` | Set how many records to build / create. |
| `state` | `state(name, overrides)` | Register a named state (variation) that can override field values. |
| `withState` | `withState(name)` | Apply a previously registered state to the next create / make call. |
| `afterCreating` | `afterCreating(fn)` | Register a callback invoked after each record is created. Useful for setting up relationships. |
| `make` | `make([overrides])` | Build plain data objects without persisting to the database. |
| `create` | `create([overrides])` | Create records and persist them to the database. |


#### Seeding & Uniqueness

| Method | Signature | Description |
|---|---|---|
| `seed` | `seed([value])` | Set a deterministic seed so all subsequent calls produce the same output. Pass `null` or `undefined` to reset to Math.random. |
| `getSeed` | `getSeed()` |  |
| `unique` | `unique(fn, [options])` | Generate a guaranteed-unique value within a namespace. |
| `resetUnique` | `resetUnique([key])` | Reset unique-value tracking. |
| `uniqueCount` | `uniqueCount(key)` | How many unique values have been generated for a namespace. |


#### Names

| Method | Signature | Description |
|---|---|---|
| `firstName` | `firstName([options])` | Random first name. |
| `lastName` | `lastName([options])` | Random last name. |
| `middleName` | `middleName([options])` | Random middle name (falls back to first-name pool if locale lacks one). |
| `fullName` | `fullName([options])` | Random full name. |
| `namePrefix` | `namePrefix([options])` | Name prefix (Mr., Ms., Dr., Prof., …). |
| `nameSuffix` | `nameSuffix()` | Random name suffix (Jr., Sr., PhD, MD, …). |
| `locales` | `locales()` | All supported locale codes. |


#### Phone Numbers

| Method | Signature | Description |
|---|---|---|
| `phone` | `phone([options])` | Random phone number. |
| `phoneCodes` | `phoneCodes()` | All supported phone country codes. |


#### Email

| Method | Signature | Description |
|---|---|---|
| `email` | `email([options])` | Random email address. |


#### Username

| Method | Signature | Description |
|---|---|---|
| `username` | `username([options])` | Random username. |


#### Numbers

| Method | Signature | Description |
|---|---|---|
| `integer` | `integer([min], [max])` | Random integer in [min, max]. |
| `float` | `float([min], [max], [decimals])` | Random float in [min, max]. |
| `numericString` | `numericString([length], [options])` | Random numeric string with an exact number of digits. Leading zeros are preserved (unlike integer()). |
| `alphanumeric` | `alphanumeric([length], [options])` | Random alphanumeric string of `length` characters. |
| `alpha` | `alpha([length], [options])` | Random alpha-only string of `length` characters. |
| `boolean` | `boolean()` | Random boolean. |


#### Dates

| Method | Signature | Description |
|---|---|---|
| `date` | `date([start], [end])` | Random Date between start and end. |
| `dateString` | `dateString([start], [end])` | Random ISO date string. |
| `datePast` | `datePast([options])` | Random date in the past. |
| `dateFuture` | `dateFuture([options])` | Random date in the future. |


#### Text

| Method | Signature | Description |
|---|---|---|
| `word` | `word([options])` | Random word from the lorem ipsum vocabulary. |
| `words` | `words([n])` | Array of n random words. |
| `sentence` | `sentence([wordCount])` | Random sentence of `wordCount` words. |
| `paragraph` | `paragraph([sentences])` | Random paragraph of `sentences` sentences. |
| `hackerPhrase` | `hackerPhrase()` | Hacker-speak phrase ("synthesize redundant protocols"). |
| `slug` | `slug([words])` | URL-friendly slug from n random words. |
| `hashtag` | `hashtag()` | Random hashtag (no spaces, prefixed with #). |


#### Person

| Method | Signature | Description |
|---|---|---|
| `jobTitle` | `jobTitle([options])` | Random job title. |
| `jobArea` | `jobArea()` | Random job area / department string (e.g. 'Engineering'). |
| `jobType` | `jobType()` | Random job type noun (e.g. 'Manager'). |
| `jobDescriptor` | `jobDescriptor()` | Random job level descriptor (e.g. 'Senior'). |
| `bio` | `bio([options])` | Random short biography string. |
| `zodiacSign` | `zodiacSign()` | Random zodiac sign. |
| `gender` | `gender([options])` | Random gender label. |
| `bloodType` | `bloodType()` | Random blood type (A+, B-, O+, AB+, …). |


#### Location

| Method | Signature | Description |
|---|---|---|
| `city` | `city([options])` | Random city. |
| `country` | `country([options])` | Random country. |
| `state` | `state([options])` | Random US state. |
| `zipCode` | `zipCode([options])` | Random postal / ZIP code. |
| `latitude` | `latitude([options])` | Random latitude as a float in [-90, 90]. |
| `longitude` | `longitude([options])` | Random longitude as a float in [-180, 180]. |
| `coordinates` | `coordinates([options])` | Random { latitude, longitude } coordinate object. |
| `timezone` | `timezone()` | Random IANA timezone identifier (e.g. 'America/New_York'). |
| `streetName` | `streetName()` | Random street name (e.g. 'Oak Avenue'). |
| `address` | `address([options])` | Random full street address. |


#### Commerce

| Method | Signature | Description |
|---|---|---|
| `productName` | `productName([options])` | Random product name (adjective + material + noun). |
| `category` | `category()` | Random product category (e.g. 'Electronics'). |
| `department` | `department()` | Random business department name. |
| `company` | `company([options])` | Random company name. |
| `price` | `price([options])` | Random price as a float with 2 decimal places. |
| `industry` | `industry()` | Random industry sector name. |
| `catchPhrase` | `catchPhrase()` | Random catch phrase buzzword phrase. |


#### Internet & Network

| Method | Signature | Description |
|---|---|---|
| `uuid` | `uuid()` | Random UUID v4. |
| `domainName` | `domainName([options])` | Random domain name (adjective-noun.tld). |
| `url` | `url([options])` | Random URL. |
| `ip` | `ip([options])` | Random IPv4 address. |
| `ipv6` | `ipv6()` | Random IPv6 address. |
| `mac` | `mac([options])` | Random MAC address. |
| `port` | `port([options])` | Random network port number. |
| `httpMethod` | `httpMethod([options])` | Random HTTP method. |
| `userAgent` | `userAgent()` | Random user agent string (realistic browser/client). |
| `password` | `password([options])` | Random password-like string. NOT suitable for real passwords — uses a PRNG seeded from Math.random, not a CSPRNG. |


#### Colors

| Method | Signature | Description |
|---|---|---|
| `color` | `color()` | Random hex color code. |
| `rgb` | `rgb([options])` | Random RGB color object or string. |
| `hsl` | `hsl([options])` | Random HSL color string or object. |


#### Helpers

| Method | Signature | Description |
|---|---|---|
| `pick` | `pick(arr)` | Pick a random element from an array. |
| `pickMany` | `pickMany(arr, n)` | Pick n random elements from an array (no duplicates). |
| `shuffle` | `shuffle(arr)` | Shuffle an array in-place using Fisher-Yates and return it. |
| `json` | `json()` | Random JSON-safe object (useful as a quick fixture value). |
| `enumValue` | `enumValue(values)` | Random element from an enum-like array, validated at call time. |


```js
  class UserSeeder extends Seeder {
      async run(db) {
          const factory = new Factory(User);
          factory.define({ name: () => Fake.fullName(), email: () => Fake.email() });
          await factory.count(50).create();
      }
  }

  const runner = new SeederRunner(db);
  await runner.run(UserSeeder, PostSeeder);
```


### QueryProfiler

Query profiling, slow query detection, and automatic N+1 detection. Attach to a Database instance via `db.enableProfiling()`.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `record` | `record(entry)` | Record a query execution. |
| `metrics` | `metrics()` | Get aggregate profiling metrics. |
| `slowQueries` | `slowQueries()` | Get all slow queries from history. |
| `n1Detections` | `n1Detections()` | Get all N+1 detections. |
| `getQueries` | `getQueries([options])` | Get filtered query history. |
| `reset` | `reset()` | Reset all profiling state. |
| `enabled` | `enabled()` |  |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable/disable profiling. |
| `slowThreshold` | number | `100` | Duration (ms) above which a query is "slow". |
| `maxHistory` | number | `1000` | Maximum recorded query entries. |
| `onSlow` | Function | `—` | Callback on slow query: (entry) => {}. |
| `n1Threshold` | number | `5` | Minimum rapid same-table SELECTs to flag N+1. |
| `n1Window` | number | `100` | Time window (ms) for N+1 detection. |
| `onN1` | Function | `—` | Callback on N+1 detection: (info) => {}. |


```js
  const { Database, QueryProfiler } = require('zero-http');

  const db = Database.connect('memory');
  const profiler = db.enableProfiling({ slowThreshold: 100 });

  // ... run queries ...

  console.log(profiler.metrics());
  console.log(profiler.slowQueries());
  console.log(profiler.n1Detections());
```


### ReplicaManager

Read replica management with automatic read/write splitting, round-robin and random selection strategies, sticky writes, and health checking.

#### Methods

| Method | Signature | Description |
|---|---|---|
| `setPrimary` | `setPrimary(adapter)` | Set the primary (read-write) adapter. |
| `addReplica` | `addReplica(adapter)` | Add a read replica adapter. |
| `replicaCount` | `replicaCount()` | Number of registered replicas. |
| `getReadAdapter` | `getReadAdapter()` | Get an adapter for read operations. Respects strategy, health status, and sticky writes. |
| `getWriteAdapter` | `getWriteAdapter()` | Get the primary adapter for write operations. Also updates the last write timestamp for sticky window tracking. |
| `markUnhealthy` | `markUnhealthy(adapter)` | Mark a replica as unhealthy (excluded from read routing). |
| `markHealthy` | `markHealthy(adapter)` | Mark a replica as healthy (re-included in read routing). |
| `healthCheck` | `healthCheck()` | Run a health check on all replicas. Calls adapter.ping() if available. |
| `getAllAdapters` | `getAllAdapters()` | Get all adapters (primary + replicas). |
| `removeReplica` | `removeReplica(adapter)` | Remove a replica adapter from the pool. |
| `status` | `status()` | Get pool status summary. |
| `closeAll` | `closeAll()` | Close all adapters (primary + replicas). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `strategy` | string | `'round-robin'` | Selection strategy: 'round-robin' \| 'random'. |
| `stickyWrite` | boolean | `true` | Read from primary after a write for stickyWindow ms. |
| `stickyWindow` | number | `1000` | Duration (ms) to read from primary after a write. |


```js
  const { Database, ReplicaManager } = require('zero-http');

  const db = Database.connectWithReplicas('postgres',
      { host: 'primary.db', database: 'app' },
      [
          { host: 'replica1.db', database: 'app' },
          { host: 'replica2.db', database: 'app' },
      ],
      { strategy: 'round-robin', stickyWindow: 2000 }
  );
```


### DatabaseView

Database view management for the ORM. Supports creating, dropping, and querying database views. View-backed models are read-only by default.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | View name. |


#### DatabaseView class

| Method | Signature | Description |
|---|---|---|
| `create` | `create(db)` | Create the view in the database. For SQL adapters, issues CREATE VIEW (or CREATE MATERIALIZED VIEW). For memory/JSON adapters, stores the query definition for execution. |
| `drop` | `drop(db)` | Drop the view from the database. |
| `refresh` | `refresh([db])` | Refresh a materialized view (PostgreSQL only). |
| `exists` | `exists([db])` | Check whether the view exists. |
| `all` | `all()` | Query all records from the view. |
| `find` | `find(conditions)` | Find records from the view matching conditions. |
| `findOne` | `findOne(conditions)` | Find a single record from the view. |
| `count` | `count([conditions])` | Count records in the view. |
| `query` | `query()` | Start a fluent query against the view. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `query` | Query | `—` | Query builder instance defining the view's SELECT. |
| `sql` | string | `—` | Raw SQL for the view definition (SQL adapters only). |
| `model` | typeof Model | `—` | Model class the view is based on. |
| `schema` | object | `—` | Column schema for the view (optional; inferred from model if omitted). |
| `materialized` | boolean | `false` | Whether to create a materialized view (PostgreSQL only). |


```js
  const { DatabaseView } = require('zero-http');

  // Define a view
  const activeUsers = new DatabaseView('active_users', {
      query: User.query().where('active', true).select('id', 'name', 'email'),
      model: User,
  });

  // Create the view in the database
  await activeUsers.create(db);

  // Query the view
  const users = await activeUsers.all();
  const user = await activeUsers.findOne({ name: 'Alice' });
```


### FullTextSearch

Full-text search integration for the ORM. Provides a unified API across PostgreSQL (tsvector/tsquery), MySQL (FULLTEXT), SQLite (FTS5), and in-memory (regex-based).

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ModelClass` | typeof Model | Yes | Model class to search. |


#### FullTextSearch class

| Method | Signature | Description |
|---|---|---|
| `createIndex` | `createIndex(db)` | Create the full-text search index. Adapts to the underlying database: - PostgreSQL: creates a GIN index on tsvector columns - MySQL: creates a FULLTEXT index - SQLite: creates an FTS5 virtual table - Memory/JSON: no-op (search operates with in-memory regex) |
| `dropIndex` | `dropIndex(db)` | Drop the full-text search index. |
| `search` | `search(query, [options])` | Perform a full-text search. |
| `searchModels` | `searchModels(query, [options])` | Search and return model instances instead of plain objects. |
| `count` | `count(query, [options])` | Count matching search results. |
| `suggest` | `suggest(prefix, [options])` | Build search suggestions (autocomplete) from indexed fields. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `fields` | string[] | `—` | Column names to include in the search index. |
| `weights` | Object<string, string> | `—` | Weight map for fields (e.g. `{ title: 'A', body: 'B' }`). |
| `language` | string | `'english'` | Language for stemming. |
| `indexName` | string | `—` | Custom index name. |


```js
  const { FullTextSearch } = require('zero-http');

  // Create a search index
  const search = new FullTextSearch(Article, {
      fields: ['title', 'body'],
      weights: { title: 'A', body: 'B' },
  });

  // Create the index in the database
  await search.createIndex(db);

  // Search
  const results = await search.search('javascript framework');
  const ranked = await search.search('node.js', { rank: true, limit: 10 });
```


### GeoQuery

Geo-spatial query support for the ORM. Provides distance calculations, bounding box queries, radius searches, and GeoJSON support. Works with in-memory adapters using Haversine formula; SQL adapters can use native spatial extensions (PostGIS, MySQL spatial).

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ModelClass` | typeof Model | Yes | Model class with location data. |


#### GeoQuery class

| Method | Signature | Description |
|---|---|---|
| `near` | `near(lat, lng, [options])` | Find records near a geographic point. Uses Haversine formula for distance calculation. |
| `within` | `within(bounds, [options])` | Find records within a bounding box. |
| `distance` | `distance(lat1, lng1, lat2, lng2, [unit])` | Calculate the distance between two geographic points. Uses the Haversine formula. |
| `haversine` | `haversine(lat1, lng1, lat2, lng2, [unit])` | Calculate the Haversine distance between two points. |
| `toGeoJSON` | `toGeoJSON(record, [options])` | Convert a record to GeoJSON Point feature. |
| `toGeoJSONCollection` | `toGeoJSONCollection(records, [options])` | Convert multiple records to a GeoJSON FeatureCollection. |
| `fromGeoJSON` | `fromGeoJSON(feature)` | Create a model instance from a GeoJSON Feature. |
| `isWithinRadius` | `isWithinRadius(lat, lng, centerLat, centerLng, radius, [unit])` | Check if a point is within a given radius of a center point. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `latField` | string | `—` | Column name for latitude. |
| `lngField` | string | `—` | Column name for longitude. |
| `unit` | string | `'km'` | Distance unit: 'km' or 'mi'. |


```js
  const { GeoQuery } = require('zero-http');

  // Create a geo query helper for a model
  const geo = new GeoQuery(Store, {
      latField: 'latitude',
      lngField: 'longitude',
  });

  // Find stores within 10km of a point
  const nearby = await geo.near(40.7128, -74.0060, { radius: 10 });

  // Find stores within a bounding box
  const inBox = await geo.within({
      north: 40.8, south: 40.6,
      east: -73.9, west: -74.1,
  });
```


### TenantManager

Multi-tenancy support for the ORM. Provides schema-based tenancy (PostgreSQL) and row-level tenancy with automatic scoping, tenant middleware, and tenant-aware migrations.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `db` | import('./index').Database | Yes | Database instance. |


#### Tenant Identity

| Method | Signature | Description |
|---|---|---|
| `setCurrentTenant` | `setCurrentTenant(tenantId)` | Set the current tenant for all subsequent queries. |
| `getCurrentTenant` | `getCurrentTenant()` | Get the current tenant ID. |
| `clearTenant` | `clearTenant()` | Clear the current tenant context. |
| `withTenant` | `withTenant(tenantId, fn)` | Execute a function within a specific tenant context. Restores the previous tenant after the callback completes. |


#### Model Registration

| Method | Signature | Description |
|---|---|---|
| `addModel` | `addModel(ModelClass)` | Register a Model class for tenant scoping. For row-level tenancy, this patches the model's query methods to auto-filter. |
| `addModels` | `addModels(...models)` | Register multiple Model classes for tenant scoping. |


#### Schema-Based Tenancy

| Method | Signature | Description |
|---|---|---|
| `createTenant` | `createTenant(tenantId)` | Create a new tenant schema (PostgreSQL schema-based tenancy). Runs all registered model syncs within the new schema. |
| `dropTenant` | `dropTenant(tenantId, [options])` | Drop a tenant schema (schema-based) or delete tenant rows (row-level). |
| `listTenants` | `listTenants()` | List all known tenant IDs. |
| `hasTenant` | `hasTenant(tenantId)` | Check if a tenant exists. |


#### Tenant Middleware

| Method | Signature | Description |
|---|---|---|
| `middleware` | `middleware([options])` | Returns an HTTP middleware function that extracts the tenant ID from the request and sets it on the TenantManager. |


#### Tenant-Aware Migrations

| Method | Signature | Description |
|---|---|---|
| `migrate` | `migrate(migrator, tenantId)` | Run migrations for a specific tenant. For schema strategy, switches to the tenant's schema before migrating. For row strategy, runs normal migrations (tables are shared). |
| `migrateAll` | `migrateAll(migrator)` | Run migrations for all known tenants. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `strategy` | string | `'row'` | Tenancy strategy: `'row'` or `'schema'`. |
| `tenantColumn` | string | `'tenant_id'` | Column name for row-level tenancy. |
| `defaultSchema` | string | `'public'` | Default schema name (schema strategy). |
| `schemaPrefix` | string | `'tenant_'` | Schema name prefix (schema strategy). |


```js
  const { TenantManager } = require('zero-http');

  // Row-level tenancy
  const tenants = new TenantManager(db, {
      strategy: 'row',
      tenantColumn: 'tenant_id',
  });

  tenants.setCurrentTenant('acme');
  const users = await User.find(); // auto-scoped to tenant_id = 'acme'
```


### AuditLog

Automatic audit logging for the ORM. Tracks who changed what and when, with diff-based change logs. Supports storing audit trails in the same database or a separate one and provides querying capabilities for the audit trail.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `db` | import('./index').Database | Yes | Database instance for storing audit entries. |


#### Setup

| Method | Signature | Description |
|---|---|---|
| `install` | `install()` | Initialize the audit log table and attach hooks to models. Must be called after models are registered and synced. |


#### Actor Management

| Method | Signature | Description |
|---|---|---|
| `setActor` | `setActor(actor)` | Set the current actor (user) performing operations. |
| `getActor` | `getActor()` | Get the current actor. |
| `withActor` | `withActor(actor, fn)` | Execute a function within a specific actor context. |


#### Diff Computation

| Method | Signature | Description |
|---|---|---|
| `diff` | `diff(oldValues, newValues)` | Compute a diff between old and new values. Returns an array of `{ field, from, to }` objects. |


#### Querying Audit Trail

| Method | Signature | Description |
|---|---|---|
| `trail` | `trail([options])` | Query the audit trail. |
| `history` | `history(table, recordId, [options])` | Get the audit history for a specific record. |
| `byActor` | `byActor([options])` | Get audit entries grouped by actor. |
| `count` | `count([options])` | Count audit entries matching the given filters. |
| `purge` | `purge(options)` | Purge old audit entries. |
| `middleware` | `middleware([options])` | Returns an HTTP middleware that sets the actor from the request. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `table` | string | `'_audit_log'` | Table name for audit entries. |
| `include` | Array<typeof import('./model')> | `—` | Models to audit (all registered if omitted). |
| `exclude` | Array<typeof import('./model')> | `—` | Models to exclude from auditing. |
| `excludeFields` | string[] | `—` | Fields to never log (e.g. passwords). |
| `actorField` | string | `—` | Context property for the actor identifier. |
| `storage` | import('./index').Database | `—` | Separate database for audit storage. |
| `timestamps` | boolean | `true` | Include timestamps in audit entries. |
| `diffs` | boolean | `true` | Store field-level diffs for updates. |


```js
  const { AuditLog } = require('zero-http');

  const audit = new AuditLog(db, {
      actorField: 'userId',       // field on req/context identifying the actor
      include: [User, Post],      // models to audit
  });

  // Automatically tracks creates, updates, and deletes
  await User.create({ name: 'Alice' }); // audit entry logged

  // Query audit trail
  const trail = await audit.trail({ table: 'users', recordId: 1 });
```


### PluginManager

Plugin system for the zero-http ORM. Provides a registration API, lifecycle hooks, and a standard interface for extending the framework.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `db` | import('./index').Database | No | Database instance (optional, can be set later). |


#### Registration

| Method | Signature | Description |
|---|---|---|
| `register` | `register(plugin, [options])` | Register a plugin. |
| `registerAll` | `registerAll(...plugins)` | Register multiple plugins at once. |
| `unregister` | `unregister(name)` | Unregister a plugin by name. |


#### Lifecycle

| Method | Signature | Description |
|---|---|---|
| `boot` | `boot()` | Boot all registered plugins. Calls the `boot()` method on each plugin (if defined). Should be called after all plugins are registered. |


#### Hook System

| Method | Signature | Description |
|---|---|---|
| `hook` | `hook(name, callback)` | Register a hook listener. |
| `unhook` | `unhook(name, callback)` | Remove a hook listener. |
| `runHook` | `runHook(name, ...args)` | Execute all listeners for a hook. Listeners run in registration order. If a listener returns a value, that value is passed to the next listener as the payload. |
| `hasHook` | `hasHook(name)` | Check if any listeners exist for a hook. |


#### Query

| Method | Signature | Description |
|---|---|---|
| `has` | `has(name)` | Check if a plugin is registered. |
| `get` | `get(name)` | Get a registered plugin by name. |
| `getOptions` | `getOptions(name)` | Get options for a registered plugin. |
| `list` | `list()` | List all registered plugin names. |
| `info` | `info()` | Get detailed info about all registered plugins. |
| `size` | `size()` | Number of registered plugins. |


```js
  const { PluginManager } = require('zero-http');

  // Define a plugin
  const timestampPlugin = {
      name: 'timestamps',
      version: '1.0.0',
      install(manager, options) {
          manager.hook('beforeCreate', (model, data) => {
              data.createdAt = new Date().toISOString();
              return data;
          });
      },
  };

  // Register it
  const plugins = new PluginManager(db);
  plugins.register(timestampPlugin);
```


### StoredProcedure

Stored procedures, functions, and trigger management for the ORM. Provides a cross-adapter API for defining, creating, executing, and dropping stored procedures, functions, and triggers.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Procedure name. |


#### StoredProcedure

| Method | Signature | Description |
|---|---|---|
| `create` | `create(db)` | Create the stored procedure in the database. |
| `drop` | `drop(db, [options])` | Drop the stored procedure. |
| `execute` | `execute(db, [args])` | Execute the stored procedure with arguments. |
| `exists` | `exists(db)` | Check if the procedure exists. |


#### StoredFunction

| Method | Signature | Description |
|---|---|---|
| `create` | `create(db)` | Create the function in the database. |
| `drop` | `drop(db, [options])` | Drop the function. |
| `call` | `call(db, [args])` | Call the function and return its result. |
| `exists` | `exists(db)` | Check if the function exists. |


#### TriggerManager

| Method | Signature | Description |
|---|---|---|
| `define` | `define(name, options)` | Define a trigger. |
| `create` | `create(name)` | Create a trigger in the database. |
| `createAll` | `createAll()` | Create all defined triggers. |
| `drop` | `drop(name, [options])` | Drop a trigger. |
| `list` | `list()` | List all defined trigger names. |
| `get` | `get(name)` | Get a trigger definition by name. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `params` | Array<{name: string, type: string, direction?: string}> | `[` | ] - Parameters. |
| `body` | string | `—` | Procedure body (SQL). |
| `language` | string | `'sql'` | Language (sql, plpgsql, javascript). |
| `options` | object | `—` | Adapter-specific options. |


```js
  const { StoredProcedure, StoredFunction, TriggerManager } = require('zero-http');

  // Define a procedure
  const proc = new StoredProcedure('update_balance', {
      params: [
          { name: 'user_id', type: 'INTEGER' },
          { name: 'amount', type: 'DECIMAL' },
      ],
      body: `UPDATE accounts SET balance = balance + amount WHERE id = user_id;`,
  });

  await proc.create(db);
  await proc.execute(db, [1, 50.00]);
```


### CLI

CLI tool for zero-http ORM operations. Provides commands for migrations, seeding, and scaffolding. Requires a `zero.config.js` (or `.zero-http.js`) in your project root that exports your database adapter and connection settings.


---

## Observability

### structuredLogger

Structured, enterprise-grade request logger. Outputs JSON or pretty-text with consistent fields: `requestId`, `method`, `url`, `status`, `duration`, `ip`, `userAgent`. Correlates with the `requestId` middleware (`req.id`), supports child loggers with bound context, custom transports, and environment-aware log level defaults.

#### Logger Core

| Method | Signature | Description |
|---|---|---|
| `child` | `child(context)` | Create a child logger with additional bound context. Child inherits all parent settings but merges extra fields into every log entry. |
| `setLevel` | `setLevel(level)` | Set the minimum log level. |
| `trace` | `trace(message, [fields])` | Log at trace level. |
| `debug` | `debug(message, [fields])` | Log at debug level. |
| `info` | `info(message, [fields])` | Log at info level. |
| `warn` | `warn(message, [fields])` | Log at warn level. |
| `error` | `error(message, [fields])` | Log at error level. |
| `fatal` | `fatal(message, [fields])` | Log at fatal level. |


#### Structured Logger Middleware

| Method | Signature | Description |
|---|---|---|
| `structuredLogger` | `structuredLogger([opts])` | Create structured request-logging middleware. Automatically logs every completed request with: `requestId`, `method`, `url`, `status`, `duration`, `ip`, `userAgent`, and `contentLength`. Also attaches `req.log` — a child logger with bound request context so handlers can log with full correlation. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `level` | string \| number | `—` | Minimum log level. |
| `context` | object | `—` | Bound context fields merged into every entry. |
| `transport` | Function | `—` | Custom transport `(entry) => void`. |
| `json` | boolean | `false` | Force JSON output. |
| `colors` | boolean | `—` | Enable ANSI colors (default: TTY detection). |
| `timestamps` | boolean | `true` | Include timestamps. |
| `stream` | WritableStream | `—` | Output stream (default: stdout/stderr). |


```js
  const { structuredLogger } = require('zero-http');
  app.use(structuredLogger());
```


### MetricsRegistry

Zero-dependency metrics registry with Prometheus-compatible text exposition format. Provides Counter, Gauge, and Histogram metric types with label support, automatic HTTP instrumentation middleware, and a handler for `/metrics` endpoints.

#### Metric Types

| Method | Signature | Description |
|---|---|---|
| `inc` | `inc([labels], [value])` | Increment the counter. |
| `get` | `get([labels])` | Get the current value. |
| `reset` | `reset()` | Reset the counter (all label combinations). |
| `collect` | `collect()` | Serialize to Prometheus text format. |


#### Gauge

| Method | Signature | Description |
|---|---|---|
| `set` | `set(labels, [value])` | Set the gauge to a specific value. |
| `inc` | `inc([labels], [value])` | Increment the gauge. |
| `dec` | `dec([labels], [value])` | Decrement the gauge. |
| `get` | `get([labels])` | Get the current value. |
| `reset` | `reset()` | Reset the gauge (all label combinations). |
| `collect` | `collect()` | Serialize to Prometheus text format. |


#### Histogram

| Method | Signature | Description |
|---|---|---|
| `observe` | `observe(labels, [value])` | Observe a value. |
| `startTimer` | `startTimer([labels])` | Start a timer that, when stopped, observes the elapsed duration in seconds. |
| `get` | `get([labels])` | Get summary stats for a label combination. |
| `reset` | `reset()` | Reset all observations. |
| `collect` | `collect()` | Serialize to Prometheus text format. |


#### Metrics Registry

| Method | Signature | Description |
|---|---|---|
| `counter` | `counter(opts)` | Create and register a Counter. |
| `gauge` | `gauge(opts)` | Create and register a Gauge. |
| `histogram` | `histogram(opts)` | Create and register a Histogram. |
| `getMetric` | `getMetric(name)` | Get a registered metric by name. |
| `removeMetric` | `removeMetric(name)` | Remove a registered metric. |
| `clear` | `clear()` | Remove all registered metrics. |
| `resetAll` | `resetAll()` | Reset all metric values without removing registrations. |
| `metrics` | `metrics()` | Serialize all metrics to Prometheus text exposition format. |
| `toJSON` | `toJSON()` | Return all metrics as a plain object (for JSON export or IPC transfer). |
| `merge` | `merge(snapshot)` | Merge a metrics snapshot (from `toJSON()`) into this registry. Used for aggregating worker metrics on the primary process. |


#### Default HTTP Metrics

| Method | Signature | Description |
|---|---|---|
| `createDefaultMetrics` | `createDefaultMetrics(registry)` | Create the standard set of HTTP metrics on a registry. |


#### Metrics Middleware

| Method | Signature | Description |
|---|---|---|
| `metricsMiddleware` | `metricsMiddleware([opts])` | Create HTTP metrics collection middleware. Automatically tracks `http_requests_total`, `http_request_duration_seconds`, and `http_active_connections`. |
| `metricsEndpoint` | `metricsEndpoint(registry)` | Create a metrics endpoint handler. Returns Prometheus text exposition format. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | `—` | Metric name (snake_case recommended). |
| `help` | string | `—` | Human-readable description. |
| `labels` | string[] | `[` | ] - Label names. |


```js
  const { MetricsRegistry, metricsMiddleware } = require('zero-http');

  const registry = new MetricsRegistry();
  app.use(metricsMiddleware({ registry }));
  app.get('/metrics', (req, res) => {
      res.set('Content-Type', 'text/plain; version=0.04');
      res.send(registry.metrics());
  });
```


### Tracer

Zero-dependency distributed tracing with W3C Trace Context propagation. Provides span creation, context propagation via `traceparent`/`tracestate` headers, and auto-instrumentation middleware for HTTP, ORM queries, WebSocket, SSE, and outbound fetch calls. Compatible with OpenTelemetry: spans export in OTLP-like format and support configurable exporters for Jaeger, Zipkin, or any custom backend.

#### Span

| Method | Signature | Description |
|---|---|---|
| `setAttribute` | `setAttribute(key, value)` | Set a span attribute. |
| `setAttributes` | `setAttributes(attrs)` | Set multiple attributes at once. |
| `addEvent` | `addEvent(name, [attributes])` | Add a timestamped event to the span. |
| `setOk` | `setOk()` | Set status to OK. |
| `setError` | `setError([message])` | Set status to ERROR. |
| `recordException` | `recordException(err)` | Record an exception as a span event and set error status. |
| `end` | `end()` | End the span and report to the tracer. |
| `duration` | `duration()` | Duration in milliseconds (or null if not ended). |
| `traceparent` | `traceparent()` | The traceparent header value for this span. |
| `toJSON` | `toJSON()` | Serialize span for export. |


#### Tracer

| Method | Signature | Description |
|---|---|---|
| `startSpan` | `startSpan(name, [opts])` | Create a new span. |
| `shouldSample` | `shouldSample()` | Whether a new trace should be sampled. |
| `onSpanEnd` | `onSpanEnd(fn)` | Register a listener for completed spans. |
| `flush` | `flush()` | Flush buffered spans to the exporter. |
| `shutdown` | `shutdown()` | Shut down the tracer, flushing remaining spans. |


#### Tracing Middleware

| Method | Signature | Description |
|---|---|---|
| `tracingMiddleware` | `tracingMiddleware([opts])` | Create HTTP tracing middleware. Automatically creates a span for each request, extracts incoming `traceparent`/`tracestate` headers, and sets outgoing `traceparent`. |
| `instrumentFetch` | `instrumentFetch(fetchFn, tracer)` | Instrument outbound fetch calls with tracing. Wraps the zero-http fetch to inject `traceparent` headers and create client spans. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | `—` | Operation name. |
| `traceId` | string | `—` | Trace ID. |
| `parentSpanId` | string | `—` | Parent span ID. |
| `kind` | string | `'server'` | Span kind: 'server', 'client', 'producer', 'consumer', 'internal'. |
| `attributes` | object | `—` | Initial attributes. |
| `tracer` | Tracer | `—` | Tracer instance for export. |


```js
  const { tracingMiddleware, Tracer } = require('zero-http');

  const tracer = new Tracer({ serviceName: 'my-api' });
  app.use(tracingMiddleware({ tracer }));
```


### healthCheck

Health check middleware with liveness and readiness probes. Kubernetes-compatible `/healthz` and `/readyz` endpoints with composable checks (database ping, memory, event loop lag, disk space) and custom check registration. Returns `200` when healthy, `503` when degraded or during shutdown drain phase, with a JSON body detailing each check.

#### Health Check Handler

| Method | Signature | Description |
|---|---|---|
| `healthCheck` | `healthCheck([opts])` | Create a health check route handler. Returns a JSON response with the status of all registered checks. Returns `200` when all checks pass, `503` when any check fails or when the application is in drain/shutdown state. Response format: ```json { "status": "healthy", "uptime": 12345, "timestamp": "2026-01-01T00:00:00.000Z", "checks": { "database": { "healthy": true, "duration": 5, "details": {} } } } ``` |


#### Convenience Health & Ready Factory

| Method | Signature | Description |
|---|---|---|
| `createHealthHandlers` | `createHealthHandlers([opts])` | Create paired liveness and readiness handlers for an app. Liveness includes basic process checks; readiness includes all registered dependency checks. |


#### Built-in Checks

| Method | Signature | Description |
|---|---|---|
| `eventLoopCheck` | `eventLoopCheck([opts])` | Check event loop lag against a threshold. |
| `diskSpaceCheck` | `diskSpaceCheck([opts])` | Check available disk space (simple heuristic using os.freemem). |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxHeapUsedPercent` | number | `90` | Max heap usage percentage. |
| `maxRssBytes` | number | `—` | Max RSS in bytes. |


```js
  const { healthCheck } = require('zero-http');

  app.get('/healthz', healthCheck());
  app.get('/readyz', healthCheck({
      checks: {
          database: () => db.ping(),
          cache: () => redis.ping(),
      },
  }));
```



---

## Lifecycle & Clustering

### LifecycleManager

Graceful shutdown manager for zero-http applications. Tracks active connections, drains in-flight requests, closes WebSocket and SSE connections, and shuts down ORM databases before exiting.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `app` | import('./app') | Yes | The App instance to manage. |


#### Event Emitter

| Method | Signature | Description |
|---|---|---|
| `on` | `on(event, fn)` | Register a lifecycle event listener. |
| `off` | `off(event, fn)` | Remove a lifecycle event listener. |


#### Connection Tracking

| Method | Signature | Description |
|---|---|---|
| `trackRequest` | `trackRequest(res)` | Track an active HTTP request. Called automatically by the App request handler when lifecycle management is enabled. |
| `activeRequests` | `activeRequests()` | Number of currently active HTTP requests. |
| `registerPool` | `registerPool(pool)` | Register a WebSocket pool for graceful shutdown. All connections in registered pools are closed with code `1001` during shutdown. |
| `unregisterPool` | `unregisterPool(pool)` | Unregister a WebSocket pool. |
| `trackSSE` | `trackSSE(stream)` | Track an active SSE stream for graceful shutdown. |
| `registerDatabase` | `registerDatabase(db)` | Register an ORM Database instance for graceful shutdown. The database connection is closed during shutdown. |
| `unregisterDatabase` | `unregisterDatabase(db)` | Unregister an ORM Database instance. |


#### Signal Handling

| Method | Signature | Description |
|---|---|---|
| `installSignalHandlers` | `installSignalHandlers()` | Install `SIGTERM` and `SIGINT` process signal handlers that trigger graceful shutdown. Called automatically by `app.listen()`. Safe to call multiple times — handlers are only installed once. |
| `removeSignalHandlers` | `removeSignalHandlers()` | Remove previously installed signal handlers. Called automatically during shutdown cleanup. |


#### Shutdown Sequence

| Method | Signature | Description |
|---|---|---|
| `shutdown` | `shutdown([opts])` | Perform a full graceful shutdown. Shutdown sequence: 1. Emit `'beforeShutdown'` — run pre-shutdown hooks (flush metrics, etc.) 2. Stop accepting new connections (server.close) 3. Close all WebSocket connections with code `1001` (Going Away) 4. Close all SSE streams 5. Wait for in-flight HTTP requests to complete (with timeout) 6. Close all registered ORM database connections 7. Emit `'shutdown'` — final cleanup complete If in-flight requests do not complete within the configured timeout (default 30s), they are forcefully terminated. |
| `isDraining` | `isDraining()` | Whether the server is currently draining (rejecting new requests). |
| `isClosed` | `isClosed()` | Whether the server has fully shut down. |


```js
  const app = createApp();
  app.listen(3000);

  // Automatic — SIGTERM/SIGINT handlers registered by listen()
  // Manual trigger:
  await app.shutdown();
```


### ClusterManager

Clustering support for zero-http applications. Forks worker processes, manages automatic restarts with backoff, and provides IPC messaging between the primary and workers.

#### Cluster Manager

| Method | Signature | Description |
|---|---|---|
| `isPrimary` | `isPrimary()` | Whether the current process is the primary (master) process. |
| `isWorker` | `isWorker()` | Whether the current process is a worker process. |
| `workerCount` | `workerCount()` | Number of configured workers. |
| `workerIds` | `workerIds()` | Get all active worker IDs. |
| `activeWorkers` | `activeWorkers()` | Number of currently alive workers. |
| `fork` | `fork()` | Fork all worker processes. Only call from the primary process. |


#### IPC Messaging

| Method | Signature | Description |
|---|---|---|
| `broadcast` | `broadcast(type, data)` | Send a typed message from the primary to all workers. |
| `sendTo` | `sendTo(workerId, type, data)` | Send a typed message to a specific worker. |
| `sendToPrimary` | `sendToPrimary(type, data)` | Send a typed message from a worker to the primary process. Call this from within a worker process. |
| `onMessage` | `onMessage(type, fn)` | Register a handler for a typed IPC message. On the primary, receives messages from workers. On workers, receives messages from the primary. |


#### Per-Worker Metrics Aggregation

| Method | Signature | Description |
|---|---|---|
| `enableMetrics` | `enableMetrics(registry, [opts])` | Enable automatic per-worker metrics aggregation. Workers periodically send their metrics snapshot to the primary, which merges them into a single registry for exposition. |
| `disableMetrics` | `disableMetrics()` | Stop the per-worker metrics reporting timer. |


#### Sticky Sessions

| Method | Signature | Description |
|---|---|---|
| `enableSticky` | `enableSticky(server, [opts])` | Enable sticky sessions by hashing client IP addresses to specific workers. Ensures WebSocket and SSE connections from the same client always land on the same worker for proper room/state management. Must be called on the primary BEFORE listen(). Replaces the default round-robin OS scheduling with a custom `connection` listener that distributes sockets to workers based on IP hash. |


#### Graceful Restart & Shutdown

| Method | Signature | Description |
|---|---|---|
| `reload` | `reload()` | Perform a rolling restart of all workers (zero-downtime). Workers are restarted one at a time — a new worker is spawned and confirmed listening before the old one is disconnected. |
| `shutdown` | `shutdown([opts])` | Shut down the entire cluster gracefully. Sends `'shutdown'` IPC message to all workers, then waits for them to exit. Workers that don't exit within the timeout are killed. |


#### Convenience Function

| Method | Signature | Description |
|---|---|---|
| `clusterize` | `clusterize(workerFn, [opts])` | High-level clustering helper. Forks workers on the primary process and runs the provided setup function on each worker. |


#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `workers` | number | `—` | Number of worker processes (default: CPU count). |
| `respawn` | boolean | `true` | Automatically respawn crashed workers. |
| `respawnDelay` | number | `1000` | Initial delay (ms) before respawning. |
| `maxRespawnDelay` | number | `30000` | Maximum respawn delay after backoff. |
| `backoffFactor` | number | `2` | Multiplier for exponential backoff. |


```js
  const { createApp, cluster } = require('zero-http');

  cluster((worker) => {
      const app = createApp();
      app.get('/', (req, res) => res.json({ pid: process.pid }));
      app.listen(3000);
  });
```



---

## Error Handling

### Error Classes

HTTP error classes with status codes, error codes, and structured details. Every error extends HttpError which carries a statusCode, code, and optional details.

#### Base HttpError

| Method | Signature | Description |
|---|---|---|
| `HttpError` | `new HttpError(statusCode, [message], [opts])` | Base HTTP error class.  All framework error classes extend this. |


#### Specific Error Classes

| Method | Signature | Description |
|---|---|---|
| `BadRequestError` | `new BadRequestError([message], [opts])` | Bad Request |
| `UnauthorizedError` | `new UnauthorizedError([message], [opts])` | Unauthorized |
| `ForbiddenError` | `new ForbiddenError([message], [opts])` | Forbidden |
| `NotFoundError` | `new NotFoundError([message], [opts])` | Not Found |
| `MethodNotAllowedError` | `new MethodNotAllowedError([message], [opts])` | Method Not Allowed |
| `ConflictError` | `new ConflictError([message], [opts])` | Conflict |
| `GoneError` | `new GoneError([message], [opts])` | Gone |
| `PayloadTooLargeError` | `new PayloadTooLargeError([message], [opts])` | Payload Too Large |
| `UnprocessableEntityError` | `new UnprocessableEntityError([message], [opts])` | Unprocessable Entity |
| `ValidationError` | `new ValidationError([message], [errors], [opts])` | Validation error with field-level details. |
| `TooManyRequestsError` | `new TooManyRequestsError([message], [opts])` | Too Many Requests |
| `InternalError` | `new InternalError([message], [opts])` | Internal Server Error |
| `NotImplementedError` | `new NotImplementedError([message], [opts])` | Not Implemented |
| `BadGatewayError` | `new BadGatewayError([message], [opts])` | Bad Gateway |
| `ServiceUnavailableError` | `new ServiceUnavailableError([message], [opts])` | Service Unavailable |


#### Framework Error Classes

| Method | Signature | Description |
|---|---|---|
| `DatabaseError` | `new DatabaseError([message], [opts])` | Database / ORM error — wraps adapter-level failures. |
| `ConfigurationError` | `new ConfigurationError([message], [opts])` | Configuration error — thrown when app/adapter configuration is invalid. |
| `MiddlewareError` | `new MiddlewareError([message], [opts])` | Middleware error — a middleware function failed unexpectedly. |
| `RoutingError` | `new RoutingError([message], [opts])` | Routing error — thrown when route resolution fails. |
| `TimeoutError` | `new TimeoutError([message], [opts])` | Timeout error — operation exceeded allowed time. |


#### ORM-Specific Error Classes

| Method | Signature | Description |
|---|---|---|
| `ConnectionError` | `new ConnectionError([message], [opts])` | Connection error — database connection failures with retry context. |
| `MigrationError` | `new MigrationError([message], [opts])` | Migration error — migration execution failures. |
| `TransactionError` | `new TransactionError([message], [opts])` | Transaction error — transaction commit/rollback failures. |
| `QueryError` | `new QueryError([message], [opts])` | Query error — query execution failures with SQL context. |
| `AdapterError` | `new AdapterError([message], [opts])` | Adapter error — adapter-level issues (driver not found, unsupported operation). |
| `CacheError` | `new CacheError([message], [opts])` | Cache error — caching layer failures. |


#### Phase 4 Error Classes

| Method | Signature | Description |
|---|---|---|
| `TenancyError` | `new TenancyError([message], [opts])` | Tenancy error — multi-tenancy operation failures. |
| `AuditError` | `new AuditError([message], [opts])` | Audit error — audit logging failures. |
| `PluginError` | `new PluginError([message], [opts])` | Plugin error — plugin registration or lifecycle failures. |
| `ProcedureError` | `new ProcedureError([message], [opts])` | Procedure error — stored procedure/function failures. |


#### Utilities

| Method | Signature | Description |
|---|---|---|
| `createError` | `createError(statusCode, [message], [opts])` | Create an HttpError by status code. |
| `isHttpError` | `isHttpError(err)` | Check if a value is an HttpError (or duck-typed equivalent). |


```js
  const { NotFoundError, ValidationError, createError } = require('zero-http');

  // Throw a named error class
  throw new NotFoundError('User not found');

  // Attach a machine-readable code + details
  throw new NotFoundError('Invoice missing', {
      code: 'INVOICE_NOT_FOUND',
      details: { invoiceId: 'INV-42' },
  });

  // Field-level validation errors
  throw new ValidationError('Invalid input', {
      email: 'required',
      age:   'must be >= 18',
  });

  // Factory — create by status code
  throw createError(503, 'Try again later');
```


### Framework Errors

Specialized error classes for framework internals, ORM operations, and infrastructure failures. All extend HttpError and carry structured context.

#### Framework Error Classes

| Method | Signature | Description |
|---|---|---|
| `DatabaseError` | `new DatabaseError([message], [opts])` | Database / ORM error — wraps adapter-level failures. |
| `ConfigurationError` | `new ConfigurationError([message], [opts])` | Configuration error — thrown when app/adapter configuration is invalid. |
| `MiddlewareError` | `new MiddlewareError([message], [opts])` | Middleware error — a middleware function failed unexpectedly. |
| `RoutingError` | `new RoutingError([message], [opts])` | Routing error — thrown when route resolution fails. |
| `TimeoutError` | `new TimeoutError([message], [opts])` | Timeout error — operation exceeded allowed time. |


#### ORM-Specific Error Classes

| Method | Signature | Description |
|---|---|---|
| `ConnectionError` | `new ConnectionError([message], [opts])` | Connection error — database connection failures with retry context. |
| `MigrationError` | `new MigrationError([message], [opts])` | Migration error — migration execution failures. |
| `TransactionError` | `new TransactionError([message], [opts])` | Transaction error — transaction commit/rollback failures. |
| `QueryError` | `new QueryError([message], [opts])` | Query error — query execution failures with SQL context. |
| `AdapterError` | `new AdapterError([message], [opts])` | Adapter error — adapter-level issues (driver not found, unsupported operation). |
| `CacheError` | `new CacheError([message], [opts])` | Cache error — caching layer failures. |


```js
  const { NotFoundError, ValidationError, createError } = require('zero-http');

  // Throw a named error class
  throw new NotFoundError('User not found');

  // Attach a machine-readable code + details
  throw new NotFoundError('Invoice missing', {
      code: 'INVOICE_NOT_FOUND',
      details: { invoiceId: 'INV-42' },
  });

  // Field-level validation errors
  throw new ValidationError('Invalid input', {
      email: 'required',
      age:   'must be >= 18',
  });

  // Factory — create by status code
  throw createError(503, 'Try again later');
```


### errorHandler

Configurable error-handling middleware that formats error responses based on environment (dev vs production), supports custom formatters, and integrates with HttpError classes.

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `stack` | boolean | `—` | Include stack traces in responses (default: true when NODE_ENV !== 'production'). |
| `log` | boolean | `—` | Log errors to console (default: true). |
| `logger` | function | `—` | Custom log function (default: console.error). |
| `formatter` | function | `—` | Custom response formatter: (err, req, isDev) => object. |
| `onError` | function | `—` | Callback on every error: (err, req, res) => void. |


```js
  app.use(errorHandler());                       // dev-friendly by default
  app.use(errorHandler({ stack: false }));        // hide stack traces
  app.use(errorHandler({
      formatter: (err, req, isDev) => ({ message: err.message }),
      onError: (err) => metrics.increment('errors'),
  }));
```


### debug

Lightweight namespaced debug logger with levels, colors, and timestamps. Enable via DEBUG env variable: DEBUG=app:*,router (supports glob patterns). Each namespace gets a unique color for easy visual scanning. Levels: trace (0), debug (1), info (2), warn (3), error (4), fatal (5), silent (6). Set level via DEBUG_LEVEL env var or programmatically.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `namespace` | string | Yes | Logger namespace (e.g. 'app:routes', 'db:queries'). |


#### Configuration API

| Method | Signature | Description |
|---|---|---|
| `level` | `level(level)` | Set the minimum log level globally. Messages below this level are silenced. |
| `enable` | `enable(patterns)` | Enable/disable namespaces programmatically (same syntax as DEBUG env var). |
| `disable` | `disable()` | Disable all debug output. |
| `json` | `json([on])` | Enable structured JSON output. |
| `timestamps` | `timestamps([on])` | Enable/disable timestamps. |
| `colors` | `colors([on])` | Enable/disable colors. |
| `output` | `output(stream)` | Set custom output stream. |
| `reset` | `reset()` | Reset all settings to defaults. |


```js
  const debug = require('zero-http').debug;
  const log = debug('app:routes');

  log.info('server started on port %d', 3000);
  log.warn('deprecation notice');
  log.error('failed to connect', err);
  log('shorthand for debug level');

  // Set minimum level — anything below is silenced
  debug.level('warn');   // only warn, error, fatal
  debug.level('silent'); // suppress all output
  debug.level('trace');  // show everything
  debug.level(0);        // same as 'trace'
```



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
