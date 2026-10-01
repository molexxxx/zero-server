const native = require("C:/Users/tonyw/Desktop/projects/zero-edge/bindings/node/packages/native/index.js");

// JS -> #[napi] async fn on tokio -> Promise resolved on main thread. No host callback.
async function main()
{
    const broker = new native.LoopbackBroker();
    const link = broker.link();
    await link.connect();
    for (let i = 0; i < 20000; i++) await link.isConnected();

    const sequential = 200000;
    let start = process.hrtime.bigint();
    for (let i = 0; i < sequential; i++) await link.isConnected();
    let elapsed = Number(process.hrtime.bigint() - start);
    console.log(`async fn hop, sequential: ${(elapsed / sequential).toFixed(0)} ns/call`);

    for (const width of [16, 64, 256])
    {
        const rounds = 4000;
        start = process.hrtime.bigint();
        for (let r = 0; r < rounds; r++)
        {
            const batch = new Array(width);
            for (let i = 0; i < width; i++) batch[i] = link.isConnected();
            await Promise.all(batch);
        }
        elapsed = Number(process.hrtime.bigint() - start);
        const total = rounds * width;
        console.log(`async fn hop, concurrent x${width}: ${(elapsed / total).toFixed(0)} ns/call, ${Math.round(total / (elapsed / 1e9)).toLocaleString("en-US")} calls/s`);
    }
    console.log("node", process.version, process.arch, process.platform);
}

main().catch((e) => { console.error(e); process.exit(1); });
