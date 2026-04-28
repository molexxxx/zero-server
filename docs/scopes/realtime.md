# Real-Time (WebSocket + SSE)

> WebSocket connection + room manager and SSE stream controller.

## Install

```bash
npm install @zero-server/realtime
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Real-time primitives: RFC 6455 WebSocket connection wrapper, a `WebSocketPool` for rooms / broadcasting / sub-protocols, and the `SSEStream` controller used by `res.sse()`.

## Usage

```js
const { WebSocketConnection, WebSocketPool, SSEStream } = require('@zero-server/realtime')
```

## Public surface

`@zero-server/realtime` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `WebSocketConnection` |
| `WebSocketPool` |
| `SSEStream` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.com)
- [`packages/realtime`](../../packages/realtime)
