# Middleware

> 20+ zero-dependency middleware.

## Install

```bash
npm install @zero-server/middleware
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Cross-cutting middleware: CORS, security headers (helmet), compression (br/gzip/deflate), rate limiting, request logging, timeout enforcement, request IDs, cookie parsing, CSRF tokens, validation, central error handling, and static file serving.

## Usage

```js
const { cors, helmet, compress } = require('@zero-server/middleware')
```

## Public surface

`@zero-server/middleware` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `cors` |
| `helmet` |
| `compress` |
| `rateLimit` |
| `logger` |
| `timeout` |
| `requestId` |
| `cookieParser` |
| `csrf` |
| `validate` |
| `errorHandler` |
| `static` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.com)
- [`packages/middleware`](../../packages/middleware)
