# fetch (HTTP client)

> Server-side fetch with mTLS, timeouts, AbortSignal.

## Install

```bash
npm install @zero-server/fetch
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Built-in `fetch()` for outbound HTTP/HTTPS calls. Supports mTLS, custom CA bundles, timeouts, `AbortSignal`, progress callbacks, JSON / form / stream bodies, and retries.

## Usage

```js
const { fetch } = require('@zero-server/fetch')
```

## Public surface

`@zero-server/fetch` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `fetch` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/fetch`](../../packages/fetch)
