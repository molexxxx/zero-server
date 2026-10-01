// The smallest program over the binding: load the compiled core and print its version.
import { version } from '@zero-server/core'

// ANCHOR: version
const core = version()
console.log(`zero-server core ${core}`)
// ANCHOR_END: version

if (typeof core !== 'string' || core.length === 0) {
  throw new Error('version() should return a non-empty string')
}
