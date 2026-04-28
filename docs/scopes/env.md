# Environment

> Typed .env loader with schema validation.

## Install

```bash
npm install @zero-server/env
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Typed `.env` loader with multi-file support (`.env`, `.env.local`, `.env.{NODE_ENV}`, `.env.{NODE_ENV}.local`), variable interpolation, and schema-driven type coercion (string, number, integer, port, boolean, array, json, url, enum).

## Usage

```js
const { env } = require('@zero-server/env')
```

## Public surface

`@zero-server/env` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `env` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/env`](../../packages/env)
