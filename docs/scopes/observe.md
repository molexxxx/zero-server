# Observability

> Metrics, structured logging, distributed tracing, health checks.

## Install

```bash
npm install @zero-server/observe
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Prometheus-compatible metrics (Counter / Gauge / Histogram / Registry), structured logging, W3C Trace Context tracing (`Tracer`/`Span`/`traceparent`), and pluggable health checks (memory, event loop, disk).

## Usage

```js
const { createDefaultMetrics } = require('@zero-server/observe')
```

## Public surface

`@zero-server/observe` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `Logger` |
| `structuredLogger` |
| `Counter` |
| `Gauge` |
| `Histogram` |
| `MetricsRegistry` |
| `DEFAULT_BUCKETS` |
| `createDefaultMetrics` |
| `metricsMiddleware` |
| `metricsEndpoint` |
| `Span` |
| `Tracer` |
| `parseTraceparent` |
| `formatTraceparent` |
| `tracingMiddleware` |
| `instrumentFetch` |
| `healthCheck` |
| `createHealthHandlers` |
| `memoryCheck` |
| `eventLoopCheck` |
| `diskSpaceCheck` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/observe`](../../packages/observe)
