# CLI runner

> Programmatic access to the `zh` / `zs` CLI.

## Install

```bash
npm install @zero-server/cli
```

_Or install everything via the meta-package:_

```bash
npm install @zero-server/sdk
```

## Overview

Programmatic entry points for the bundled CLI (`zh` / `zs`): scaffolding, migrations, seeding, rollback, status. Useful when embedding the CLI inside your own tooling.

## Usage

```js
const { CLI, runCLI } = require('@zero-server/cli')
```

## Public surface

`@zero-server/cli` exports the following public names:

| Symbol |
| --- |
| `CLI` |
| `runCLI` |

## See also

- [Top-level README](../../README.md)
- [Full API reference](../../API.md)
- [Live docs site](https://z-server.dev)
- [`packages/cli`](../../packages/cli)
