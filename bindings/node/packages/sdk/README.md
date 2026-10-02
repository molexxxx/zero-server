# @zero-server/sdk

The zero-server framework over the Rust core: the TypeScript facade every application imports. It re-exports `@zero-server/core` and, as the facade grows, the routing, ORM, auth and real-time surfaces of the framework.

The package is private at this version. It becomes publishable when the facade reaches parity with the Node SDK it replaces, at which point it takes over the `@zero-server/sdk` name from the 1.x line. Until then npm's `latest` tag for `@zero-server/sdk` stays on the 1.x line. `@zero-server/core` publishes its pre-releases under the `next` tag, so its `latest` tag also stays on the 1.x line until the first final release of this core.
