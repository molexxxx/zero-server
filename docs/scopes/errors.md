# Errors

> HttpError + 25+ typed framework and ORM errors.

## Install

```bash
npm install @zero-server/errors
```

_Or install the full SDK to get everything at once:_

```bash
npm install @zero-server/sdk
```

## Overview

Every typed error class shipped by the SDK: HTTP status errors, framework errors (configuration / middleware / routing / timeout), ORM errors (database / connection / migration / transaction / query / adapter / cache), and the Phase 4 errors (tenancy / audit / plugin / procedure). Plus the `createError` factory, `isHttpError` guard, and the lightweight `debug` logger.

## Usage

```js
const { createError } = require('@zero-server/errors')
```

## Public surface

`@zero-server/errors` exports the following public names:

| Symbol |
| --- |
| `HttpError` |
| `BadRequestError` |
| `UnauthorizedError` |
| `ForbiddenError` |
| `NotFoundError` |
| `MethodNotAllowedError` |
| `ConflictError` |
| `GoneError` |
| `PayloadTooLargeError` |
| `UnprocessableEntityError` |
| `ValidationError` |
| `TooManyRequestsError` |
| `InternalError` |
| `NotImplementedError` |
| `BadGatewayError` |
| `ServiceUnavailableError` |
| `DatabaseError` |
| `ConfigurationError` |
| `MiddlewareError` |
| `RoutingError` |
| `TimeoutError` |
| `ConnectionError` |
| `MigrationError` |
| `TransactionError` |
| `QueryError` |
| `AdapterError` |
| `CacheError` |
| `TenancyError` |
| `AuditError` |
| `PluginError` |
| `ProcedureError` |
| `WebRTCError` |
| `SignalingError` |
| `IceError` |
| `TurnError` |
| `SdpError` |
| `createError` |
| `isHttpError` |
| `debug` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/errors`](../../packages/errors)
