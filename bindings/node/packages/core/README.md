# @zero-server/core

The zero-server core's surface for Node: the runtime version of the compiled core. This is the counterpart of the `zero-core` crate, and like it, it is small. The compiled core it loads is `@zero-server/native`.

## Install

```sh
npm install @zero-server/core
```

## Use

```ts
import { version } from '@zero-server/core'

console.log(version())
```
