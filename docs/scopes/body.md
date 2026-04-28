# Body parsers

> json, urlencoded, text, raw, multipart parsers.

## Install

```bash
npm install @zero-server/body
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Streaming-aware request body parsers. Includes JSON, URL-encoded forms (flat or nested), plain text, raw bytes, and a multipart/form-data parser with file uploads.

## Usage

```js
const { json, urlencoded, text } = require('@zero-server/body')
```

## Public surface

`@zero-server/body` re-exports the following names from [`@zero-server/sdk`](https://www.npmjs.com/package/@zero-server/sdk):

| Symbol |
| --- |
| `json` |
| `urlencoded` |
| `text` |
| `raw` |
| `multipart` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.com)
- [`packages/body`](../../packages/body)
