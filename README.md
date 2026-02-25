# molex-http

[![npm version](https://img.shields.io/npm/v/molex-http.svg)](https://www.npmjs.com/package/molex-http)
[![npm downloads](https://img.shields.io/npm/dm/molex-http.svg)](https://www.npmjs.com/package/molex-http)
[![GitHub](https://img.shields.io/badge/GitHub-molex--http--npm-blue.svg)](https://github.com/tonywied17/molex-http-npm)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

> **Zero-dependency, minimal Express-like HTTP server with a tiny fetch replacement and streaming multipart parsing.**

## Features

- **Zero dependencies** — implemented using Node core APIs only
- **Express-like API** — `createApp()`, `use()`, `get()`, `post()`, `put()`, `delete()`, `listen()`
- **Built-in middlewares** — `cors()`, `json()`, `urlencoded()`, `text()`, `raw()`, `multipart()`
- **Streaming multipart parser** — writes file parts to disk and exposes `req.body.files` and `req.body.fields`
- **Tiny `fetch` replacement** — convenient server-side HTTP client with progress callbacks
- **Static file serving** — correct Content-Type handling and small footprint
 

```bash
npm install molex-http
```

## Quick start

```js
const { createApp, json } = require('molex-http')
const app = createApp()

app.use(json())
app.post('/echo', (req, res) => res.json({ received: req.body }))
app.listen(3000)
```

Visit the demo UI: run `node documentation/full-server.js` and open `http://localhost:3000`.

## API Reference

All exports are available from the package root:

```js
const { createApp, cors, fetch, json, urlencoded, text, raw, multipart, static } = require('molex-http')
```

- `createApp()` — returns an application instance with methods:
	- `use(fn)` — register middleware (fn signature: `(req, res, next)`).
	- `get(path, ...handlers)` / `post()` / `put()` / `delete()` — routing helpers.
	- `listen(port = 3000, cb)` — start HTTP server.

- Request object (`req`) wraps the raw Node request and exposes:
	- `req.method`, `req.url`, `req.headers`, `req.query`, `req.params`, `req.body`.
	- `req.parseBody()` — low-level helper that reads and parses body according to Content-Type.

- Response object (`res`) helpers:
	- `res.status(code)` — set status.
	- `res.set(name, value)` — set header.
	- `res.send(body)` — send response (Buffer/string/object → JSON).
	- `res.json(obj)` — convenience JSON response.
	- `res.text(str)` — convenience text response.

### Body parsers

The package exposes parser factory functions under `json`, `urlencoded`, `text`, `raw`, and `multipart`.

json([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `limit` | number|string | none | Maximum body size (bytes or unit string like `'1mb'`). |
| `reviver` | function | — | Function passed to `JSON.parse` for custom reviving. |
| `strict` | boolean | `true` | When `true` only accepts objects/arrays (rejects primitives). |
| `type` | string|function | `'application/json'` | MIME matcher for the parser. |

urlencoded([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `extended` | boolean | `false` | When `true` supports rich nested bracket syntax (a[b]=1, a[]=1). |
| `limit` | number|string | none | Maximum body size. |
| `type` | string|function | `'application/x-www-form-urlencoded'` | MIME matcher. |

text([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `type` | string|function | `text/*` | MIME matcher for text bodies. |
| `limit` | number|string | none | Maximum body size. |
| `encoding` | string | `utf8` | Character encoding used to decode bytes. |

raw([opts])

| Option | Type | Default | Description |
|---|---:|---|---|
| `type` | string|function | `application/octet-stream` | MIME matcher for raw parser. |
| `limit` | number|string | none | Maximum body size. |

multipart(opts)

Streaming multipart parser that writes file parts to disk and collects fields.

| Option | Type | Default | Description |
|---|---:|---|---|
| `dir` | string | `os.tmpdir()/molex-http-uploads` | Directory to store uploaded files (absolute or relative to `process.cwd()`). |
| `maxFileSize` | number | none | Maximum allowed file size in bytes. Exceeding this returns HTTP 413 and aborts the upload. |

Behavior: `multipart` writes file parts to disk with a generated name preserving the original extension when possible. On completion `req.body` will be `{ fields, files }` where `files` contains metadata: `originalFilename`, `storedName`, `path`, `contentType`, `size`.

### static(rootPath, opts)

Serve static files from `rootPath`.

| Option | Type | Default | Description |
|---|---:|---|---|
| `index` | string|false | `'index.html'` | File to serve for directory requests; set `false` to disable. |
| `maxAge` | number|string | `0` | Cache-Control `max-age` (ms or unit string like `'1h'`). |
| `dotfiles` | string | `'ignore'` | `'allow'|'deny'|'ignore'` — how to handle dotfiles. |
| `extensions` | string[] | — | Fallback extensions to try when a request omits an extension. |
| `setHeaders` | function | — | Hook `(res, filePath) => {}` to set custom headers per file. |

### cors([opts])

Small CORS middleware. Typical options:

| Option | Type | Default | Description |
|---|---:|---|---|
| `origin` | string|boolean|array | `'*'` | Allowed origin(s). Use `false` to disable CORS. |
| `methods` | string | `'GET,HEAD,PUT,POST,DELETE'` | Allowed methods. |
| `allowedHeaders` | string | — | Headers allowed in requests. |

### fetch(url, opts)

Small Node HTTP client returning an object with `status`, `headers` and helpers: `text()`, `json()`, `arrayBuffer()`.

| Option | Type | Default | Description |
|---|---:|---|---|
| `method` | string | `GET` | HTTP method. |
| `headers` | object | — | Request headers. |
| `body` | Buffer|string|Stream|URLSearchParams|object | — | Request body. Plain objects are JSON-encoded. |
| `timeout` | number | — | Request timeout in milliseconds. |
| `signal` | AbortSignal | — | Optional `AbortSignal` to cancel the request. |
| `onUploadProgress` / `onDownloadProgress` | function | — | Callbacks receiving `{ loaded, total }` during transfer. |

Example usage:

```js
const r = await fetch('https://jsonplaceholder.typicode.com/todos/1', { timeout: 5000 })
const data = await r.json()
```

## Examples

Small JSON API:

```js
const { createApp, json, cors } = require('molex-http')
const app = createApp()

app.use(cors({ origin: ['https://example.com'] }))
app.use(json({ limit: '10kb' }))

const items = []
app.post('/items', (req, res) => {
	items.push(req.body)
	res.status(201)
	res.json({ ok: true })
})
```

Upload handler (writes files to disk by default):

```js
app.post('/upload', multipart({ dir: uploadsDir, maxFileSize: 10 * 1024 * 1024 }), (req, res) => {
	res.json({ files: req.body.files })
})
```

Static server example:

```js
app.use(static(path.join(__dirname, 'documentation', 'public'), { index: 'index.html', maxAge: '1h' }))
```

## File layout

- `lib/` — core helpers and middleware (router, fetch, body parsers, static server)
- `documentation/` — demo server, controllers and public UI used to showcase features
- `test/` — tests for core functionality and edge cases

## Testing

Run the demo and use the UI playground for manual testing. There are example/test scripts in `examples/` and `test/`.

## License

MIT

