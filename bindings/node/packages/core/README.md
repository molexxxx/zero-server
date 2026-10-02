# @zero-server/core

The zero-server core's surface for Node: the runtime version of the compiled core. This is the counterpart of the `zero-core` crate, and like it, it is small. The compiled core it loads is `@zero-server/native`. It has no server API yet.

This package is not published from this repository yet. The 1.x versions of `@zero-server/core` on npm are the earlier JavaScript framework, a different code base.

## Use

```ts
import { version } from '@zero-server/core'

console.log(version())
```
