# Errors

> HttpError + 25+ typed framework and ORM errors.

## Install

```bash
npm install @zero-server/errors
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Every typed error class shipped by the SDK: HTTP status errors, framework errors (configuration / middleware / routing / timeout), ORM errors (database / connection / migration / transaction / query / adapter / cache), and the Phase 4 errors (tenancy / audit / plugin / procedure). Plus the `createError` factory and `isHttpError` guard.

## Usage

```js
const { createError } = require('@zero-server/errors')
```

## Public surface

`@zero-server/errors` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

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
| `createError` |
| `isHttpError` |
| `debug` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.com)
- [`packages/errors`](../../packages/errors)
