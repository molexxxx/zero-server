# molex-http

Zero-dependency, minimal Express-like server.

molex-http provides a small, familiar routing and middleware API, built-in body parsers (including streaming multipart), a tiny fetch replacement for Node, and a simple static file server — all implemented with zero runtime dependencies so the code is easy to inspect and reuse.

Features

- Zero dependencies — implemented using Node core APIs only
- Express-like API: `createApp()`, `use()`, `get()`, `post()`, `put()`, `delete()`, `listen()`
- Built-in middlewares: `cors()`, `json()`, `urlencoded()`, `text()`, `raw()`, `multipart()`
- Streaming multipart parser that writes file parts to disk and exposes `req.body.files` and `req.body.fields`
- Small `fetch(url, opts)` replacement for server-side HTTP requests with progress callbacks
- Static file serving with correct Content-Type handling
- Small example/demo server in `documentation/full-server.js` with upload playground and proxy test

Installation

```bash
npm install
```

Quick Start

Run the included demo server (from the repo root) and open http://localhost:3000:

```bash
node documentation/full-server.js
# visit http://localhost:3000
```

Core middlewares

- `json()` — parse JSON request bodies
- `urlencoded()` — parse application/x-www-form-urlencoded bodies
- `text()` — parse raw text bodies
- `raw()` — receive raw bytes as a Buffer
- `multipart({ dir, maxFileSize })` — stream file parts to disk; exposes `req.body.files` and `req.body.fields`

Built-in fetch replacement

Use the bundled `fetch` in Node as a tiny alternative to `node-fetch`:

```js
const { fetch } = require('molex-http')
const r = await fetch('https://example.com')
const text = await r.text()
```

It returns an object with `status`, `headers`, and async helpers: `text()`, `json()`, `arrayBuffer()` and supports optional `onUploadProgress` / `onDownloadProgress` callbacks when used with a Buffer or stream.

API Overview

- `createApp()` — returns an app instance with Express-like methods: `use`, `get`, `post`, `put`, `delete`, `listen`
- `cors(opts)` — small CORS middleware used in the demo
- `json(), urlencoded(), text(), raw(), multipart(opts)` — body parsers
- `static(root)` — serve static files from a folder (used to serve the demo UI)
- `fetch(url, opts)` — small HTTP client replacement (in `lib/fetch.js`)

Example: Echo endpoint

```js
const { createApp, json } = require('molex-http')
const app = createApp()
app.use(json())
app.post('/echo', (req, res) => res.json({ received: req.body }))
app.listen(3000)
```

Uploads and Thumbnails (demo)

The demo server (`documentation/full-server.js`) includes endpoints and helpers for streaming multipart uploads to disk and generating simple SVG thumbnails for image uploads. Uploaded files are stored in `documentation/uploads` and thumbnails in `documentation/uploads/.thumbs`.

Key controllers and behavior:

- `controllers/upload.js` — receives multipart parts, stores files and writes small SVG thumbnails for recognizable image extensions
- `controllers/uploads.js` — move uploads to `.trash`, restore, and permanently delete; also ensures thumbnail files are moved/removed alongside uploads
- `controllers/uploadsList.js` — lists uploaded files and prefers thumbnail URLs when present

Proxy helper

The demo includes a small proxy endpoint (`/proxy`) implemented in `controllers/proxy.js` that proxies an external URL using the built-in `fetch`. The demo UI shows how to fetch images and JSON through the server (avoids CORS issues when testing).

File layout

- `lib/` — core helpers and middleware (router, fetch, body parsers, static server)
- `documentation/` — demo server, controllers and public UI used to showcase features
- `examples/` — small usage examples

Testing

Run the demo and use the UI playground for quick manual tests. There are also small example/test scripts in the repo (see `examples/` and `test/` folders where present).

Notes and extensions

- The multipart parser writes to disk by design; you can adapt it to stream parts directly to S3 or another storage backend by replacing the write logic in `lib/body/multipart.js` or the demo upload controller.
- The built-in `fetch` is intentionally minimal — it focuses on convenience, progress callbacks, and working well in small server-side scripts.

License

MIT

