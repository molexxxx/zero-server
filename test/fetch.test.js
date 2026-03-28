const http = require('http');
const { doFetch, fetch } = require('./_helpers');
const { createApp } = require('../');

describe('Fetch Replacement', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/fetch-test', (req, res) => res.json({ hello: 'world' }));
        app.post('/fetch-post', (req, res) => res.json({ method: 'POST' }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('ok property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(r.ok).toBe(true);
    });

    it('status property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(r.status).toBe(200);
    });

    it('url property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(typeof r.url).toBe('string');
    });

    it('secure property', async () => {
        const r = await fetch(`${base}/fetch-test`);
        expect(r.secure).toBe(false);
    });

    it('json() parsing', async () => {
        const r = await fetch(`${base}/fetch-test`);
        const body = await r.json();
        expect(body.hello).toBe('world');
    });

    it('POST method', async () => {
        const r = await fetch(`${base}/fetch-post`, {
            method: 'POST',
            body: JSON.stringify({ test: 1 }),
            headers: { 'content-type': 'application/json' }
        });
        const body = await r.json();
        expect(body.method).toBe('POST');
    });

    it('text() returns string', async () => {
        const r = await fetch(`${base}/fetch-test`);
        const t = await r.text();
        expect(typeof t).toBe('string');
    });

    it('arrayBuffer() returns Buffer', async () => {
        const r = await fetch(`${base}/fetch-test`);
        const buf = await r.arrayBuffer();
        expect(Buffer.isBuffer(buf)).toBe(true);
    });
});
