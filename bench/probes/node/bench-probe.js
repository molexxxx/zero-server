const path = require("path");
const probe = require(path.join(__dirname, "napi-probe", "probe.node"));

function bench(label, fn, iterations)
{
    for (let i = 0; i < 200000; i++) fn();
    const start = process.hrtime.bigint();
    let sink = 0;
    for (let i = 0; i < iterations; i++) sink += fn();
    const elapsed = Number(process.hrtime.bigint() - start);
    console.log(`${label}: ${(elapsed / iterations).toFixed(1)} ns/call (sink ${sink})`);
}

async function main()
{
    const n = 5_000_000;
    const buf = Buffer.alloc(256, 1);
    const req = probe.makeReq();
    bench("noop() sync", () => probe.noop(), n);
    bench("sumSlice(Buffer 256) borrowed view", () => probe.sumSlice(buf), n);
    bench("sumOwned(Buffer 256) owned ref", () => probe.sumOwned(buf), n);
    bench("takeString('/api/users/12345/profile')", () => probe.takeString("/api/users/12345/profile"), n);
    bench("reqMethod(External) opaque handle read", () => probe.reqMethod(req), n);
    bench("reqPath(External) -> String", () => probe.reqPath(req).length, n);
    bench("reqHeader(External, 'user-agent') -> String", () => probe.reqHeader(req, "user-agent").length, n);
    bench("makeReq() External alloc", () => (probe.makeReq(), 1), 1_000_000);
    bench("makeBody(1024) external Buffer", () => probe.makeBody(1024).length, 1_000_000);

    for (let i = 0; i < 20000; i++) await probe.noopAsync();
    let start = process.hrtime.bigint();
    const seq = 200000;
    for (let i = 0; i < seq; i++) await probe.noopAsync();
    console.log(`noopAsync() sequential: ${(Number(process.hrtime.bigint() - start) / seq).toFixed(0)} ns/call`);
    for (const width of [64, 256])
    {
        const rounds = 4000;
        start = process.hrtime.bigint();
        for (let r = 0; r < rounds; r++)
        {
            const batch = new Array(width);
            for (let i = 0; i < width; i++) batch[i] = probe.noopAsync();
            await Promise.all(batch);
        }
        const elapsed = Number(process.hrtime.bigint() - start);
        console.log(`noopAsync() concurrent x${width}: ${(elapsed / (rounds * width)).toFixed(0)} ns/call, ${Math.round(rounds * width / (elapsed / 1e9)).toLocaleString("en-US")} calls/s`);
    }

    const handler = (x) => x + 1;
    await probe.tsfnSequential(handler, 20000);
    let ns = await probe.tsfnSequential(handler, 200000);
    console.log(`tsfn round trip, tokio worker -> JS -> return value, sequential: ${ns.toFixed(0)} ns/call, ${Math.round(1e9 / ns).toLocaleString("en-US")} calls/s`);
    for (const width of [16, 64, 256, 1024])
    {
        ns = await probe.tsfnConcurrent(handler, 400000, width);
        console.log(`tsfn round trip, concurrent x${width}: ${ns.toFixed(0)} ns/call, ${Math.round(1e9 / ns).toLocaleString("en-US")} calls/s`);
    }
    const batchHandler = (items) => { let s = 0; for (const x of items) s += x; return s; };
    for (const batch of [16, 64, 256])
    {
        ns = await probe.tsfnBatched(batchHandler, 400000, batch);
        console.log(`tsfn batched x${batch} items per crossing: ${ns.toFixed(0)} ns/item, ${Math.round(1e9 / ns).toLocaleString("en-US")} items/s`);
    }
    ns = await probe.tsfnFireAndForget(handler, 400000);
    console.log(`tsfn fire-and-forget NonBlocking, no return: ${ns.toFixed(0)} ns/call, ${Math.round(1e9 / ns).toLocaleString("en-US")} calls/s`);
    console.log("node", process.version, process.arch, process.platform);
}

main().catch((e) => { console.error(e); process.exit(1); });
