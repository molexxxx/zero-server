// Smoke test: confirms the facade loads and the native core is reachable.
const assert = require("node:assert");
const native = require("@zero-server/native");
const { version } = require("@zero-server/core");

const v = version();
console.log("zero-server version:", v);
assert.strictEqual(typeof v, "string", "version() should return a string");
assert.notStrictEqual(v.length, 0, "version() should not be empty");
assert.strictEqual(v, native.version(), "the facade reports the native version");

console.log("ok");
