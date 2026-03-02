<p align="center">
  <img src="documentation/public/vendor/icons/logo.svg" alt="zero-http logo" width="300" height="300">
</p>

<h1 align="center">zero-http</h1>

[![npm version](https://img.shields.io/npm/v/zero-http.svg)](https://www.npmjs.com/package/zero-http)
[![npm downloads](https://img.shields.io/npm/dm/zero-http.svg)](https://www.npmjs.com/package/zero-http)
[![GitHub](https://img.shields.io/badge/GitHub-zero--http--npm-blue.svg)](https://github.com/tonywied17/zero-http-npm)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

> **Zero-dependency, Express-like HTTP/HTTPS server with built-in WebSocket, Server-Sent Events, response compression, modular routing, and a tiny fetch client.**

## Features

- **Zero dependencies** — implemented using Node core APIs only
- **Express-like API** — `createApp()`, `use()`, `get()`, `post()`, `put()`, `delete()`, `patch()`, `head()`, `options()`, `all()`, `listen()`
- **HTTPS support** — pass `{ key, cert }` to `listen()` for TLS; `req.secure` and `req.protocol` available everywhere
- **Built-in WebSocket server** — `app.ws('/path', handler)` with RFC 6455 framing, ping/pong, sub-protocols, `verifyClient`, per-connection data store
- **Server-Sent Events** — `res.sse()` returns a rich stream controller with auto-IDs, keep-alive, retry hints, and event counting
- **Response compression** — `compress()` middleware with brotli/gzip/deflate negotiation, threshold and filter options
- **Router sub-apps** — `Router()` factory with `.use()` mounting, nested sub-routers, route chaining, and introspection via `app.routes()`
- **Protocol-aware routing** — `{ secure: true }` option on routes to match HTTPS-only or HTTP-only requests
- **Built-in middlewares** — `cors()`, `json()`, `urlencoded()`, `text()`, `raw()`, `multipart()`, `rateLimit()`, `logger()`, `compress()`
- **Body parser HTTPS enforcement** — `{ requireSecure: true }` on any body parser to reject non-TLS requests with 403
- **Streaming multipart parser** — writes file parts to disk and exposes `req.body.files` and `req.body.fields`
- **Tiny `fetch` replacement** — server-side HTTP/HTTPS client with TLS options passthrough, progress callbacks, abort support
- **Static file serving** — 60+ MIME types, dotfile policy, caching, extension fallback
- **Error handling** — automatic 500 responses for thrown errors, global error handler via `app.onError()`
- **Rate limiting** — in-memory IP-based rate limiter with configurable windows
- **Request logger** — colorized dev/short/tiny log formats

```bash
npm install zero-http
```

## Quick start

```js
const { createApp, json } = require('zero-http')
const app = createApp()

app.use(json())
app.post('/echo', (req, res) => res.json({ received: req.body }))
app.listen(3000)
```

## Demo

You can view the live documentation and playground at https://zero-http.molex.cloud, or run the demo locally:

```bash
node documentation/full-server.js
# open http://localhost:3000
```

## API Reference

All exports are available from the package root:

```js
const {
	createApp, Router, cors, fetch,
	json, urlencoded, text, raw, multipart,
	static: serveStatic, rateLimit, logger, compress,
	WebSocketConnection, SSEStream
} = require('zero-http')
```

| Export | Type | Description |
|---|---|---|
| `createApp()` | function | Create a new application instance (router + middleware stack). |
| `Router()` | function | Create a standalone Router for modular route grouping. |
| `cors` | function | CORS middleware factory. |
| `fetch` | function | Node HTTP/HTTPS client with TLS options passthrough. |
| `json` | function | JSON body parser factory. |
| `urlencoded` | function | URL-encoded body parser factory. |
| `text` | function | Text body parser factory. |
| `raw` | function | Raw bytes parser factory. |
| `multipart` | function | Streaming multipart parser factory. |
| `static` | function | Static file serving middleware factory. |
| `rateLimit` | function | In-memory rate-limiting middleware factory. |
| `logger` | function | Request-logging middleware factory. |
| `compress` | function | Response compression middleware (brotli/gzip/deflate). |
| `WebSocketConnection` | class | WebSocket connection wrapper (for advanced usage). |
| `SSEStream` | class | SSE stream controller (for advanced usage). |

### createApp() methods

| Method | Signature | Description |
|---|---|---|
| `use` | `use(fn)` or `use(path, fn)` or `use(path, router)` | Register middleware globally, scoped to a path prefix, or mount a sub-router. |
| `get` | `get(path, [opts], ...handlers)` | Register GET route handlers. Optional `{ secure }` options object. |
| `post` | `post(path, [opts], ...handlers)` | Register POST route handlers. |
| `put` | `put(path, [opts], ...handlers)` | Register PUT route handlers. |
| `delete` | `delete(path, [opts], ...handlers)` | Register DELETE route handlers. |
| `patch` | `patch(path, [opts], ...handlers)` | Register PATCH route handlers. |
| `options` | `options(path, [opts], ...handlers)` | Register OPTIONS route handlers. |
| `head` | `head(path, [opts], ...handlers)` | Register HEAD route handlers. |
| `all` | `all(path, [opts], ...handlers)` | Register handlers for ALL HTTP methods. |
| `ws` | `ws(path, [opts], handler)` | Register a WebSocket upgrade handler. |
| `onError` | `onError(fn)` | Register a global error handler `fn(err, req, res, next)`. |
| `listen` | `listen(port, [tlsOpts], [cb])` | Start HTTP or HTTPS server. Pass `{ key, cert }` for TLS. |
| `close` | `close([cb])` | Gracefully close the server. |
| `routes` | `routes()` | Return a flat list of all registered routes (introspection). |
| `handler` | property | Bound request handler for `http.createServer(app.handler)`. |

### Request (`req`) properties & helpers

| Property / Method | Type | Description |
|---|---|---|
| `method` | string | HTTP method (GET, POST, etc.). |
| `url` | string | Request URL (path + query). |
| `headers` | object | Raw request headers. |
| `query` | object | Parsed query string. |
| `params` | object | Route parameters (populated by router). |
| `body` | any | Parsed body (populated by body parsers). |
| `ip` | string | Remote IP address of the client. |
| `secure` | boolean | `true` when the connection is over TLS (HTTPS). |
| `protocol` | string | `'https'` or `'http'`. |
| `get(name)` | function | Get a request header (case-insensitive). |
| `is(type)` | function | Check if Content-Type matches a type (e.g. `'json'`, `'text/html'`). |
| `raw` | object | Underlying `http.IncomingMessage`. |

### Response (`res`) helpers

| Method | Signature | Description |
|---|---|---|
| `status` | `status(code)` | Set HTTP status code. Chainable. |
| `set` | `set(name, value)` | Set a response header. Chainable. |
| `get` | `get(name)` | Get a previously-set response header. |
| `type` | `type(ct)` | Set Content-Type (accepts shorthand like `'json'`, `'html'`, `'text'`). Chainable. |
| `send` | `send(body)` | Send a response; auto-detects Content-Type for strings, objects, and Buffers. |
| `json` | `json(obj)` | Set JSON Content-Type and send object. |
| `text` | `text(str)` | Set text/plain and send string. |
| `html` | `html(str)` | Set text/html and send string. |
| `redirect` | `redirect([status], url)` | Redirect to URL (default 302). |
| `sse` | `sse([opts])` | Open a Server-Sent Events stream. Returns an `SSEStream` controller. |

### WebSocket — `app.ws(path, [opts], handler)`

Register a WebSocket upgrade handler. The handler receives `(ws, req)` where `ws` is a `WebSocketConnection`.

| Option | Type | Default | Description |
|---|---:|---|---|
| `maxPayload` | number | `1048576` | Maximum incoming frame size in bytes (1 MB). |
| `pingInterval` | number | `30000` | Auto-ping interval in ms. `0` to disable. |
| `verifyClient` | function | — | `(req) => boolean` — return `false` to reject the upgrade with 403. |

**WebSocketConnection properties:**

| Property | Type | Description |
|---|---|---|
| `id` | string | Unique connection ID (e.g. `ws_1_l8x3k`). |
| `readyState` | number | 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED. |
| `protocol` | string | Negotiated sub-protocol. |
| `headers` | object | Upgrade request headers. |
| `ip` | string | Remote IP address. |
| `query` | object | Parsed query params from the upgrade URL. |
| `url` | string | Full upgrade URL. |
| `secure` | boolean | `true` for WSS connections. |
| `extensions` | string | Requested WebSocket extensions header. |
| `maxPayload` | number | Max incoming payload bytes. |
| `connectedAt` | number | Timestamp (ms) of connection. |
| `uptime` | number | Milliseconds since connection (computed). |
| `bufferedAmount` | number | Bytes waiting to be flushed. |
| `data` | object | Arbitrary user-data store. |

**WebSocketConnection methods:**

| Method | Description |
|---|---|
| `send(data, [opts])` | Send text or binary message. `opts.binary` to force binary frame. |
| `sendJSON(obj)` | Send JSON-serialised text message. |
| `ping([payload])` | Send a ping frame. |
| `pong([payload])` | Send a pong frame. |
| `close([code], [reason])` | Graceful close with optional status code. |
| `terminate()` | Forcefully destroy the socket. |
| `on(event, fn)` | Listen for `'message'`, `'close'`, `'error'`, `'ping'`, `'pong'`, `'drain'`. |
| `once(event, fn)` | One-time event listener. |
| `off(event, fn)` | Remove a listener. |
| `removeAllListeners([event])` | Remove all listeners for an event, or all events. |
| `listenerCount(event)` | Return the number of listeners for an event. |

Example:

```js
app.ws('/chat', { maxPayload: 64 * 1024 }, (ws, req) => {
	ws.send('Welcome!')
	ws.on('message', data => ws.send('echo: ' + data))
	ws.on('close', () => console.log(ws.id, 'left'))
})
```

### Server-Sent Events — `res.sse([opts])`

Open an SSE stream. Returns an `SSEStream` controller.

| Option | Type | Default | Description |
|---|---:|---|---|
| `status` | number | `200` | HTTP status code for the SSE response. |
| `retry` | number | — | Reconnection interval hint (ms) sent to client. |
| `keepAlive` | number | `0` | Auto keep-alive comment interval (ms). |
| `keepAliveComment` | string | `'ping'` | Comment text sent by the keep-alive timer. |
| `autoId` | boolean | `false` | Auto-increment event IDs. |
| `startId` | number | `1` | Starting value for auto-IDs. |
| `pad` | number | `0` | Bytes of initial padding (helps flush proxy buffers). |
| `headers` | object | — | Additional response headers. |

**SSEStream methods:**

| Method | Description |
|---|---|
| `send(data, [id])` | Send an unnamed data event. Objects are auto-JSON-serialised. |
| `sendJSON(obj, [id])` | Alias for `send()` with an object. |
| `event(name, data, [id])` | Send a named event. |
| `comment(text)` | Send a comment line (keep-alive or debug). |
| `retry(ms)` | Update the reconnection interval hint. |
| `keepAlive(ms, [comment])` | Start/restart a keep-alive timer. |
| `flush()` | Flush buffered data through proxies. |
| `close()` | Close the stream from the server side. |
| `on(event, fn)` | Listen for `'close'` or `'error'` events. |
| `once(event, fn)` | One-time event listener. |
| `off(event, fn)` | Remove a specific event listener. |
| `removeAllListeners([event])` | Remove all listeners for an event, or all events. |
| `listenerCount(event)` | Return the number of listeners for an event. |

**SSEStream properties:** `connected`, `eventCount`, `bytesSent`, `connectedAt`, `uptime`, `lastEventId`, `secure`, `data`.

**SSEStream events:** `'close'` (client disconnect or server close), `'error'` (write error).

Example:

```js
app.get('/events', (req, res) => {
	const sse = res.sse({ retry: 5000, keepAlive: 30000, autoId: true })
	sse.send('hello')
	sse.event('update', { x: 1 })
	sse.on('close', () => console.log('client disconnected'))
})
```

### Router sub-apps

Create modular route groups with `Router()`:

```js
const { createApp, Router, json } = require('zero-http')
const app = createApp()
const api = Router()

api.get('/users', (req, res) => res.json([]))
api.get('/users/:id', (req, res) => res.json({ id: req.params.id }))

app.use(json())
app.use('/api', api)
app.listen(3000)

// Introspection
console.log(app.routes())
// [{ method: 'GET', path: '/api/users' }, { method: 'GET', path: '/api/users/:id' }]
```

Route chaining:

```js
const router = Router()
router.route('/items')
	.get((req, res) => res.json([]))
	.post((req, res) => res.status(201).json(req.body))
```

Protocol-aware routes:

```js
// Only matches HTTPS requests
app.get('/secret', { secure: true }, (req, res) => res.json({ secret: 42 }))
// Only matches plain HTTP
app.get('/public', { secure: false }, (req, res) => res.json({ public: true }))
```

### Response compression — `compress([opts])`

Negotiates the best encoding from `Accept-Encoding`: brotli (`br`) > gzip > deflate. Brotli requires Node ≥ 11.7. Automatically skips SSE (`text/event-stream`) streams.

| Option | Type | Default | Description |
|---|---:|---|---|
| `threshold` | number | `1024` | Minimum response size in bytes before compressing. |
| `level` | number | `-1` | zlib compression level (1–9, or -1 for default). |
| `filter` | function | — | `(req, res) => boolean` — return `false` to skip compression. |

```js
app.use(compress({ threshold: 512 }))
```

### Body parsers

All body parsers accept a `requireSecure` option. When `true`, non-HTTPS requests are rejected with `403 HTTPS required`.

#### json([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `limit` | number\|string | none | Maximum body size (bytes or unit string like `'1mb'`). |
| `reviver` | function | — | Function passed to `JSON.parse` for custom reviving. |
| `strict` | boolean | `true` | When `true` only accepts objects/arrays (rejects primitives). |
| `type` | string\|function | `'application/json'` | MIME matcher for the parser. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |

#### urlencoded([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `extended` | boolean | `false` | When `true` supports nested bracket syntax (`a[b]=1`). |
| `limit` | number\|string | none | Maximum body size. |
| `type` | string\|function | `'application/x-www-form-urlencoded'` | MIME matcher. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |

#### text([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `type` | string\|function | `text/*` | MIME matcher for text bodies. |
| `limit` | number\|string | none | Maximum body size. |
| `encoding` | string | `utf8` | Character encoding used to decode bytes. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |

#### raw([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `type` | string\|function | `application/octet-stream` | MIME matcher for raw parser. |
| `limit` | number\|string | none | Maximum body size. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |

#### multipart(opts)

Streaming multipart parser that writes file parts to disk and collects fields.

| Option | Type | Default | Description |
|---|---:|---|---|
| `dir` | string | `os.tmpdir()/zero-http-uploads` | Upload directory. |
| `maxFileSize` | number | none | Maximum file size in bytes. Returns 413 on exceed. |
| `requireSecure` | boolean | `false` | Reject non-HTTPS requests with 403. |

### static(rootPath, opts)

Serve static files from `rootPath`.

| Option | Type | Default | Description |
|---|---:|---|---|
| `index` | string\|false | `'index.html'` | File to serve for directory requests. |
| `maxAge` | number\|string | `0` | Cache-Control `max-age` (ms or unit string). |
| `dotfiles` | string | `'ignore'` | `'allow'|'deny'|'ignore'`. |
| `extensions` | string[] | — | Fallback extensions to try. |
| `setHeaders` | function | — | Hook `(res, filePath) => {}` for custom headers. |

### cors([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `origin` | string\|boolean\|array | `'*'` | Allowed origin(s). `.suffix` for subdomain matching. |
| `methods` | string | `'GET,POST,PUT,DELETE,OPTIONS'` | Allowed methods. |
| `credentials` | boolean | `false` | Set `Access-Control-Allow-Credentials`. |
| `allowedHeaders` | string | — | Headers allowed in requests. |

### fetch(url, opts)

Node HTTP/HTTPS client. Returns `{ status, statusText, ok, secure, url, headers, text(), json(), arrayBuffer() }`.

| Option | Type | Default | Description |
|---|---:|---|---|
| `method` | string | `GET` | HTTP method. |
| `headers` | object | — | Request headers. |
| `body` | Buffer\|string\|Stream\|URLSearchParams\|object | — | Request body (objects auto-JSON-encoded). |
| `timeout` | number | — | Request timeout in ms. |
| `signal` | AbortSignal | — | Cancel the request. |
| `agent` | object | — | Custom agent for pooling/proxies. |
| `onDownloadProgress` / `onUploadProgress` | function | — | `{ loaded, total }` callbacks. |

**TLS options** (passed through for `https:` URLs): `rejectUnauthorized`, `ca`, `cert`, `key`, `pfx`, `passphrase`, `servername`, `ciphers`, `secureProtocol`, `minVersion`, `maxVersion`.

### rateLimit([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `windowMs` | number | `60000` | Time window in ms. |
| `max` | number | `100` | Max requests per window per key. |
| `message` | string | `'Too many requests…'` | Error message. |
| `statusCode` | number | `429` | HTTP status for rate-limited responses. |
| `keyGenerator` | function | `(req) => req.ip` | Custom key extraction. |

### logger([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `format` | string | `'dev'` | `'dev'` (colorized), `'short'`, or `'tiny'`. |
| `logger` | function | `console.log` | Custom log function. |
| `colors` | boolean | auto (TTY) | Enable/disable ANSI colors. |

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

All modules respect HTTPS: `req.secure`, `req.protocol`, `ws.secure`, `sse.secure`, and `fetch()` response `secure` property.

## Examples

WebSocket chat:

```js
const { createApp } = require('zero-http')
const app = createApp()

app.ws('/chat', (ws, req) => {
	ws.send('Welcome to the chat!')
	ws.on('message', msg => {
		ws.send(`You said: ${msg}`)
	})
})

app.listen(3000)
```

Server-Sent Events:

```js
app.get('/events', (req, res) => {
	const sse = res.sse({ retry: 5000, autoId: true, keepAlive: 30000 })

	const interval = setInterval(() => {
		sse.event('tick', { time: Date.now() })
	}, 1000)

	sse.on('close', () => clearInterval(interval))
})
```

Full-featured server:

```js
const path = require('path')
const { createApp, cors, json, urlencoded, text, compress,
	static: serveStatic, logger, rateLimit, Router } = require('zero-http')

const app = createApp()

app.use(logger({ format: 'dev' }))
app.use(cors())
app.use(compress())
app.use(rateLimit({ windowMs: 60000, max: 200 }))
app.use(json({ limit: '1mb' }))
app.use(urlencoded({ extended: true }))
app.use(text())
app.use(serveStatic(path.join(__dirname, 'public')))

const api = Router()
api.get('/health', (req, res) => res.json({ status: 'ok' }))
api.get('/users/:id', (req, res) => res.json({ id: req.params.id }))
app.use('/api', api)

app.ws('/chat', (ws) => {
	ws.on('message', msg => ws.send('echo: ' + msg))
})

app.get('/events', (req, res) => {
	const sse = res.sse({ retry: 3000, autoId: true })
	sse.send('connected')
	sse.on('close', () => console.log('bye'))
})

app.onError((err, req, res) => {
	res.status(500).json({ error: err.message })
})

app.listen(3000, () => console.log('Server running on :3000'))
```

## File layout

```
lib/
  app.js            — core App class (middleware, routing, listen, ws)
  body/             — body parsers (json, urlencoded, text, raw, multipart)
  fetch/            — server-side HTTP/HTTPS client
  http/             — Request & Response wrappers
  middleware/       — cors, logger, rateLimit, compress, static
  router/           — Router with sub-app mounting & introspection
  sse/              — SSEStream controller
  ws/               — WebSocket connection & handshake
documentation/      — demo server, controllers, and public UI
test/               — integration tests
```

## Testing

```bash
node test/test.js
```

## License

MIT
