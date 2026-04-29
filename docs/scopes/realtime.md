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
const { WebSocketConnection, handleUpgrade, WebSocketPool } = require('@zero-server/realtime')
```

## Public surface

`@zero-server/realtime` exports the following public names:

| Symbol |
| --- |
| `WebSocketConnection` |
| `handleUpgrade` |
| `WebSocketPool` |
| `SSEStream` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/realtime`](../../packages/realtime)
