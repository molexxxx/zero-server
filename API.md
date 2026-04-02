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

HTTP application with middleware pipeline, method-based routing, HTTPS support, built-in WebSocket upgrade handling, and route introspection. Created via `createApp()` in the public API.

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
| `listen` | `listen([port], [opts], [cb])` | Start listening for HTTP or HTTPS connections. |
| `close` | `close([cb])` | Gracefully close the server, stopping new connections. |


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

Lightweight wrapper around Node's `IncomingMessage`. Provides parsed query string, params, body, and convenience helpers.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `req` | import('http').IncomingMessage | Yes | Raw Node incoming message. |


#### Methods

| Method | Signature | Description |
|---|---|---|
| `get` | `get(name)` | Get a specific request header (case-insensitive). |
| `is` | `is(type)` | Check if the request Content-Type matches the given type. |
| `hostname` | `hostname()` | Get the hostname from the Host header (without port). Respects X-Forwarded-Host when behind a proxy. |
| `subdomains` | `subdomains([offset])` | Get the subdomains as an array (e.g. `['api', 'v2']` for `'v2.api.example.com'`). |
| `accepts` | `accepts(...types)` | Content negotiation — check if the client accepts the given type(s). Returns the best match, or `false` if none match. |
| `fresh` | `fresh()` | Check if the request is "fresh" (client cache is still valid). Compares If-None-Match / If-Modified-Since with ETag / Last-Modified. |
| `stale` | `stale()` | Inverse of `fresh`. |
| `xhr` | `xhr()` | Check whether this request was made with XMLHttpRequest. |
| `range` | `range(size)` | Parse the Range header. |


### Response

Lightweight wrapper around Node's `ServerResponse`. Provides chainable helpers for status, headers, and body output.

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `res` | import('http').ServerResponse | Yes | Raw Node server response. |


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

Static file-serving middleware with MIME detection, directory index files, extension fallbacks, dotfile policies, caching, and custom header hooks.

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

Base Model class for defining database-backed entities. Provides static CRUD methods, instance-level save/update/delete, lifecycle hooks, and relationship definitions.

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
| `toJSON` | `toJSON()` | Convert to plain object (for JSON serialization). Respects `static hidden = [...]` to exclude sensitive fields. |


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
