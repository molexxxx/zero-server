# Core — App, Router, Request/Response

> App factory, Router, and the HTTP Request/Response wrappers.

## Install

```bash
npm install @zero-server/core
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

The HTTP foundation of @zero-server/sdk: `createApp()`, the Router primitive, and the Request/Response wrappers. Everything else builds on this surface.

## Usage

```js
const { createApp } = require('@zero-server/core')
```

## Public surface

`@zero-server/core` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `createApp` |
| `Router` |
| `version` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/core`](../../packages/core)
