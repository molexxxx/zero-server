const path = require("path");
const native = require(path.join(
  "C:/Users/tonyw/Desktop/projects/zero-edge/bindings/node/packages/native/index.js"
));

function jsVersion() {
  return "0.2.0";
}

function bench(label, fn, iterations) {
  for (let i = 0; i < 200000; i++) fn();
  const start = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < iterations; i++) sink += fn().length;
  const elapsed = Number(process.hrtime.bigint() - start);
  console.log(`${label}: ${(elapsed / iterations).toFixed(1)} ns/call (sink ${sink})`);
}

const n = 5_000_000;
bench("js function returning string", jsVersion, n);
bench("napi-rs version() returning String", native.version, n);

const samples = [];
for (let i = 0; i < 64; i++) samples.push(i);
const encoded = native.encodeDeltaSamples(samples);
bench("napi-rs encodeDeltaSamples(64 numbers) -> Buffer", () => native.encodeDeltaSamples(samples), 1_000_000);
bench("napi-rs decodeDeltaSamples(Buffer) -> number[]", () => native.decodeDeltaSamples(encoded), 1_000_000);
console.log("node", process.version, process.arch, process.platform);
