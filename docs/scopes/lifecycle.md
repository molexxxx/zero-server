# Lifecycle & Clustering

> Graceful shutdown manager and multi-worker clustering.

## Install

```bash
npm install @zero-server/lifecycle
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Graceful shutdown with signal handlers, in-flight request draining, automatic WebSocket / SSE / database cleanup, plus multi-worker clustering with auto-respawn and exponential backoff.

## Usage

```js
const { LifecycleManager, LIFECYCLE_STATE, ClusterManager } = require('@zero-server/lifecycle')
```

## Public surface

`@zero-server/lifecycle` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `LifecycleManager` |
| `LIFECYCLE_STATE` |
| `ClusterManager` |
| `cluster` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.com)
- [`packages/lifecycle`](../../packages/lifecycle)
