const native = require("C:/Users/tonyw/Desktop/projects/zero-edge/bindings/node/packages/native/index.js");

// Round trip: JS -> #[napi] async fn on tokio -> ThreadsafeFunction -> JS handler on main thread
// -> settled value back to tokio -> Promise resolved on main thread -> JS await.
async function main()
{
    let calls = 0;
    const handlers = {
        connect() {},
        send(topic, payload) { calls += payload.length; },
        subscribe() {},
    };
    const transport = native.Transport.fromHandlers(handlers);
    await transport.connect();
    const payload = Buffer.alloc(64);

    for (let i = 0; i < 20000; i++) await transport.send("t", payload);

    const sequential = 200000;
    let start = process.hrtime.bigint();
    for (let i = 0; i < sequential; i++) await transport.send("t", payload);
    let elapsed = Number(process.hrtime.bigint() - start);
    console.log(`sequential round trip (send 64 bytes, await): ${(elapsed / sequential).toFixed(0)} ns/call`);

    for (const width of [16, 64, 256])
    {
        const rounds = 4000;
        start = process.hrtime.bigint();
        for (let r = 0; r < rounds; r++)
        {
            const batch = new Array(width);
            for (let i = 0; i < width; i++) batch[i] = transport.send("t", payload);
            await Promise.all(batch);
        }
        elapsed = Number(process.hrtime.bigint() - start);
        const total = rounds * width;
        console.log(`concurrent x${width}: ${(elapsed / total).toFixed(0)} ns/call, ${Math.round(total / (elapsed / 1e9)).toLocaleString("en-US")} calls/s`);
    }

    // Baseline: same shape without the native hop (JS async fn calling the handler).
    async function jsSend(topic, payload) { handlers.send(topic, payload); }
    start = process.hrtime.bigint();
    for (let i = 0; i < sequential; i++) await jsSend("t", payload);
    elapsed = Number(process.hrtime.bigint() - start);
    console.log(`pure JS async call + await: ${(elapsed / sequential).toFixed(0)} ns/call (sink ${calls})`);
    console.log("node", process.version, process.arch, process.platform);
}

main().catch((e) => { console.error(e); process.exit(1); });
