# molex-http-npm

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

## Installation

```bash
npm install molex-http
```

## Quick Start

Run the demo server and visit http://localhost:3000:

```bash
node documentation/full-server.js
# visit http://localhost:3000
```

## Core middlewares

- `json()` — parse JSON request bodies
- `urlencoded()` — parse application/x-www-form-urlencoded bodies
- `text()` — parse raw text bodies
- `raw()` — receive raw bytes as a Buffer
- `multipart({ dir, maxFileSize })` — stream file parts to disk; exposes `req.body.files` and `req.body.fields`

## Built-in fetch replacement

Use the bundled `fetch` as a tiny alternative to third-party clients:

```js
const { fetch } = require('molex-http')
const r = await fetch('https://example.com')
const text = await r.text()
```

It returns an object with `status`, `headers`, and helpers: `text()`, `json()`, `arrayBuffer()` and supports optional `onUploadProgress` / `onDownloadProgress` callbacks.

## API Overview

- `createApp()` — returns an app instance with Express-like methods: `use`, `get`, `post`, `put`, `delete`, `listen`
- `cors(opts)` — small CORS middleware used in the demo
- `json(), urlencoded(), text(), raw(), multipart(opts)` — body parsers
- `static(root)` — serve static files from a folder
- `fetch(url, opts)` — small HTTP client replacement (see `lib/fetch.js`)

## Example: Echo endpoint

```js
const { createApp, json } = require('molex-http')
const app = createApp()
app.use(json())
app.post('/echo', (req, res) => res.json({ received: req.body }))
app.listen(3000)
```

## Uploads and Thumbnails (demo)

The demo server (`documentation/full-server.js`) includes endpoints and helpers for streaming multipart uploads to disk and generating small SVG thumbnails for image uploads. Uploaded files are stored in `documentation/uploads` and thumbnails in `documentation/uploads/.thumbs`.

Key controllers:

- `controllers/upload.js` — receives multipart parts, stores files and writes thumbnails for recognized image types
- `controllers/uploads.js` — move uploads to `.trash`, restore, and permanently delete; keeps thumbnails in sync
- `controllers/uploadsList.js` — lists uploaded files and prefers thumbnail URLs when present

## Proxy helper

The demo includes a proxy endpoint (`/proxy`) implemented in `controllers/proxy.js` that proxies external URLs using the built-in `fetch` (useful for demoing CORS-free fetches).

## File layout

- `lib/` — core helpers and middleware (router, fetch, body parsers, static server)
- `documentation/` — demo server, controllers and public UI used to showcase features
- `examples/` — small usage examples

## Testing

Run the demo and use the UI playground for manual testing. There are example/test scripts in `examples/` and `test/` where present.

## Notes and extensions

- The multipart parser writes to disk by design; adapt it to stream parts directly to S3 or another backend by modifying `lib/body/multipart.js` or the demo controller.
- The built-in `fetch` is intentionally minimal — focused on convenience and progress callbacks rather than full feature parity with larger clients.

## License

MIT

