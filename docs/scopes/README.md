# Scoped packages

> The full SDK lives at [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk). Every scope below is published as its own narrow package and pinned to the same version.

| Package | Summary |
| --- | --- |
| [`@zero-server/core`](./core.md) | App factory, Router, and the HTTP Request/Response wrappers. |
| [`@zero-server/body`](./body.md) | json, urlencoded, text, raw, multipart parsers. |
| [`@zero-server/middleware`](./middleware.md) | 20+ zero-dependency middleware. |
| [`@zero-server/auth`](./auth.md) | JWT, sessions, OAuth, authorize, MFA stack. |
| [`@zero-server/orm`](./orm.md) | Database, Model, Query, migrations, seeds, search, geo, tenancy, audit. |
| [`@zero-server/realtime`](./realtime.md) | WebSocket connection + room manager and SSE stream controller. |
| [`@zero-server/grpc`](./grpc.md) | gRPC server, client, codec, framing, status, metadata, health, reflection, balancer. |
| [`@zero-server/observe`](./observe.md) | Metrics, structured logging, distributed tracing, health checks. |
| [`@zero-server/lifecycle`](./lifecycle.md) | Graceful shutdown manager and multi-worker clustering. |
| [`@zero-server/env`](./env.md) | Typed .env loader with schema validation. |
| [`@zero-server/fetch`](./fetch.md) | Server-side fetch with mTLS, timeouts, AbortSignal. |
| [`@zero-server/errors`](./errors.md) | HttpError + 25+ typed framework and ORM errors. |
| [`@zero-server/cli`](./cli.md) | Programmatic access to the `zh` / `zs` CLI. |
