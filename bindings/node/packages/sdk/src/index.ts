/**
 * The zero-server framework in one package.
 *
 * This is the facade applications import, a hand-written TypeScript surface over
 * the generated napi-rs contract in `@zero-server/native`. It depends on
 * `@zero-server/core`, the core's own surface, and re-exports it. The package
 * stays private until the facade reaches parity with the Node SDK it replaces.
 *
 * @packageDocumentation
 */

export { version } from '@zero-server/core'
