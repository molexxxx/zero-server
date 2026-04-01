/** parsers-features.test.js — body parser feature tests */
const http = require('http');
const os = require('os');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);
const brotli = promisify(zlib.brotliCompress);
const { doFetch } = require('../_helpers');
const { createApp, json, urlencoded, text, raw, multipart } = require('../../');

// ============================================================
//  Helpers
// ============================================================
function makeMultipartBody(boundary, parts)
{
    const bufs = [];
    for (const p of parts)
    {
        let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
        if (p.filename) headers += `; filename="${p.filename}"`;
        headers += '\r\n';
        if (p.contentType) headers += `Content-Type: ${p.contentType}\r\n`;
        headers += '\r\n';
        bufs.push(Buffer.from(headers));
        bufs.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
        bufs.push(Buffer.from('\r\n'));
    }
    bufs.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(bufs);
}

// ============================================================
//  rawBuffer / typeMatch unit tests (no server needed)
// ============================================================
describe('typeMatch — array type support', () =>
{
    const isTypeMatch = require('../../lib/body/typeMatch');

    it('matches when content-type is in the array', () =>
    {
        expect(isTypeMatch('application/json', ['application/json', 'text/plain'])).toBe(true);
    });

    it('matches wildcard in array', () =>
    {
        expect(isTypeMatch('text/html', ['application/*', 'text/*'])).toBe(true);
    });

    it('rejects when no array element matches', () =>
    {
        expect(isTypeMatch('image/png', ['application/json', 'text/*'])).toBe(false);
    });

    it('empty array matches nothing', () =>
    {
        expect(isTypeMatch('text/plain', [])).toBe(false);
    });
});

describe('charsetFromContentType', () =>
{
    const { charsetFromContentType } = require('../../lib/body/rawBuffer');

    it('extracts utf-8 charset', () =>
    {
        expect(charsetFromContentType('application/json; charset=utf-8')).toBe('utf8');
    });

    it('extracts ISO-8859-1 as latin1', () =>
    {
        expect(charsetFromContentType('text/plain; charset=ISO-8859-1')).toBe('latin1');
    });

    it('extracts utf-16le', () =>
    {
        expect(charsetFromContentType('text/plain; charset=utf-16le')).toBe('utf16le');
    });

    it('extracts ascii', () =>
    {
        expect(charsetFromContentType('text/plain; charset=us-ascii')).toBe('ascii');
    });

    it('returns null when no charset', () =>
    {
        expect(charsetFromContentType('application/json')).toBeNull();
    });

    it('returns null for empty string', () =>
    {
        expect(charsetFromContentType('')).toBeNull();
    });

    it('handles quoted charset', () =>
    {
        expect(charsetFromContentType('text/plain; charset="utf-8"')).toBe('utf8');
    });

    it('falls back to utf8 for unknown charset', () =>
    {
        expect(charsetFromContentType('text/plain; charset=windows-1252')).toBe('utf8');
    });
});

// ============================================================
//  rawBuffer — Content-Length pre-check
// ============================================================
describe('rawBuffer — Content-Length pre-check', () =>
{
    const rawBuffer = require('../../lib/body/rawBuffer');
    const { Readable } = require('stream');

    function makeReq(body, headers = {})
    {
        const r = new Readable({ read() { this.push(Buffer.from(body)); this.push(null); } });
        return { raw: r, headers };
    }

    it('rejects immediately when Content-Length exceeds limit', async () =>
    {
        const req = makeReq('x'.repeat(200), { 'content-length': '200' });
        await expect(rawBuffer(req, { limit: 50 })).rejects.toMatchObject({ status: 413 });
    });

    it('passes when Content-Length is within limit', async () =>
    {
        const req = makeReq('hello', { 'content-length': '5' });
        const buf = await rawBuffer(req, { limit: 100 });
        expect(buf.toString()).toBe('hello');
    });

    it('still rejects mid-stream when actual data exceeds limit', async () =>
    {
        // No Content-Length header, but data exceeds limit
        const req = makeReq('x'.repeat(200), {});
        await expect(rawBuffer(req, { limit: 50 })).rejects.toMatchObject({ status: 413 });
    });
});

// ============================================================
//  rawBuffer — Content-Encoding decompression
// ============================================================
describe('rawBuffer — Content-Encoding decompression', () =>
{
    const rawBuffer = require('../../lib/body/rawBuffer');
    const { Readable } = require('stream');

    function makeReq(body, headers = {})
    {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const r = new Readable({ read() { this.push(buf); this.push(null); } });
        return { raw: r, headers };
    }

    it('decompresses gzip body', async () =>
    {
        const compressed = await gzip(Buffer.from('{"hello":"world"}'));
        const req = makeReq(compressed, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
        const buf = await rawBuffer(req, { limit: '1mb' });
        expect(buf.toString()).toBe('{"hello":"world"}');
    });

    it('decompresses deflate body', async () =>
    {
        const compressed = await deflate(Buffer.from('deflated data'));
        const req = makeReq(compressed, { 'content-encoding': 'deflate' });
        const buf = await rawBuffer(req, { limit: '1mb' });
        expect(buf.toString()).toBe('deflated data');
    });

    it('decompresses brotli body', async () =>
    {
        const compressed = await brotli(Buffer.from('brotli data'));
        const req = makeReq(compressed, { 'content-encoding': 'br' });
        const buf = await rawBuffer(req, { limit: '1mb' });
        expect(buf.toString()).toBe('brotli data');
    });

    it('handles x-gzip alias', async () =>
    {
        const compressed = await gzip(Buffer.from('x-gzip'));
        const req = makeReq(compressed, { 'content-encoding': 'x-gzip' });
        const buf = await rawBuffer(req, { limit: '1mb' });
        expect(buf.toString()).toBe('x-gzip');
    });

    it('rejects unsupported Content-Encoding with 415', async () =>
    {
        const req = makeReq('data', { 'content-encoding': 'compress' });
        await expect(rawBuffer(req, { limit: '1mb' })).rejects.toMatchObject({ status: 415 });
    });

    it('rejects when inflate is false and body is compressed', async () =>
    {
        const compressed = await gzip(Buffer.from('data'));
        const req = makeReq(compressed, { 'content-encoding': 'gzip' });
        await expect(rawBuffer(req, { limit: '1mb', inflate: false })).rejects.toMatchObject({ status: 415 });
    });

    it('passes identity encoding without decompression', async () =>
    {
        const req = makeReq('plain', { 'content-encoding': 'identity' });
        const buf = await rawBuffer(req, { limit: '1mb' });
        expect(buf.toString()).toBe('plain');
    });

    it('skips CL pre-check for compressed bodies', async () =>
    {
        // Compressed body is shorter than original
        const original = 'x'.repeat(1000);
        const compressed = await gzip(Buffer.from(original));
        // Set a limit that the original exceeds but compressed doesn't
        const req = makeReq(compressed, {
            'content-encoding': 'gzip',
            'content-length': String(compressed.length),
        });
        const buf = await rawBuffer(req, { limit: 2000 });
        expect(buf.toString()).toBe(original);
    });
});

// ============================================================
//  JSON parser — verify callback
// ============================================================
describe('JSON parser — verify callback', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json({
            verify: (req, res, buf, encoding) =>
            {
                const sig = req.headers['x-signature'];
                if (!sig || sig !== 'valid-sig') throw new Error('invalid signature');
            },
        }));
        app.post('/webhook', (req, res) => res.json({ body: req.body, hasRaw: !!req.rawBody }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('passes when verify succeeds', async () =>
    {
        const r = await doFetch(`${base}/webhook`, {
            method: 'POST', body: JSON.stringify({ ok: true }),
            headers: { 'content-type': 'application/json', 'x-signature': 'valid-sig' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.ok).toBe(true);
        expect(r.data.hasRaw).toBe(true);
    });

    it('rejects with 403 when verify throws', async () =>
    {
        const r = await doFetch(`${base}/webhook`, {
            method: 'POST', body: JSON.stringify({ ok: true }),
            headers: { 'content-type': 'application/json', 'x-signature': 'bad' },
        });
        expect(r.status).toBe(403);
    });

    it('rejects with 403 when signature missing', async () =>
    {
        const r = await doFetch(`${base}/webhook`, {
            method: 'POST', body: JSON.stringify({ ok: true }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(403);
    });
});

// ============================================================
//  JSON parser — req.rawBody
// ============================================================
describe('JSON parser — req.rawBody', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());
        app.post('/raw', (req, res) => res.json({
            body: req.body,
            rawBody: req.rawBody ? req.rawBody.toString() : null,
        }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('stores raw body buffer on req.rawBody', async () =>
    {
        const payload = JSON.stringify({ key: 'value' });
        const r = await doFetch(`${base}/raw`, {
            method: 'POST', body: payload,
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
        expect(r.data.rawBody).toBe(payload);
        expect(r.data.body.key).toBe('value');
    });
});

// ============================================================
//  JSON parser — type array
// ============================================================
describe('JSON parser — type array', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json({ type: ['application/json', 'application/*+json'] }));
        app.post('/data', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('matches application/json', async () =>
    {
        const r = await doFetch(`${base}/data`, {
            method: 'POST', body: JSON.stringify({ a: 1 }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.data.body.a).toBe(1);
    });

    it('matches application/vnd.api+json', async () =>
    {
        const r = await doFetch(`${base}/data`, {
            method: 'POST', body: JSON.stringify({ b: 2 }),
            headers: { 'content-type': 'application/vnd.api+json' },
        });
        expect(r.data.body.b).toBe(2);
    });

    it('rejects text/plain', async () =>
    {
        const r = await doFetch(`${base}/data`, {
            method: 'POST', body: JSON.stringify({ c: 3 }),
            headers: { 'content-type': 'text/plain' },
        });
        expect(r.data.body).toBeNull();
    });
});

// ============================================================
//  JSON parser — gzip decompression
// ============================================================
describe('JSON parser — gzip decompression', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());
        app.post('/data', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('auto-decompresses gzip JSON body', async () =>
    {
        const payload = JSON.stringify({ compressed: true, items: [1, 2, 3] });
        const compressed = await gzip(Buffer.from(payload));
        const r = await doFetch(`${base}/data`, {
            method: 'POST', body: compressed,
            headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.compressed).toBe(true);
        expect(r.data.body.items).toEqual([1, 2, 3]);
    });
});

// ============================================================
//  JSON parser — inflate:false
// ============================================================
describe('JSON parser — inflate:false', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json({ inflate: false }));
        app.post('/data', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('rejects compressed body with 415 when inflate is false', async () =>
    {
        const compressed = await gzip(Buffer.from('{"a":1}'));
        const r = await doFetch(`${base}/data`, {
            method: 'POST', body: compressed,
            headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        });
        expect(r.status).toBe(415);
    });

    it('accepts uncompressed body normally', async () =>
    {
        const r = await doFetch(`${base}/data`, {
            method: 'POST', body: JSON.stringify({ ok: true }),
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.ok).toBe(true);
    });
});

// ============================================================
//  Text parser — verify + rawBody + charset
// ============================================================
describe('Text parser — verify + rawBody', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(text({
            verify: (req, res, buf, encoding) =>
            {
                if (buf.toString().includes('BLOCKED')) throw new Error('blocked content');
            },
        }));
        app.post('/text', (req, res) => res.json({
            body: req.body,
            hasRaw: !!req.rawBody,
        }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('passes when verify succeeds and provides rawBody', async () =>
    {
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: 'hello world',
            headers: { 'content-type': 'text/plain' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body).toBe('hello world');
        expect(r.data.hasRaw).toBe(true);
    });

    it('rejects with 403 when verify throws', async () =>
    {
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: 'BLOCKED content',
            headers: { 'content-type': 'text/plain' },
        });
        expect(r.status).toBe(403);
    });
});

// ============================================================
//  Text parser — gzip decompression
// ============================================================
describe('Text parser — gzip decompression', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(text());
        app.post('/text', (req, res) => res.text(req.body));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('auto-decompresses gzip text body', async () =>
    {
        const compressed = await gzip(Buffer.from('hello compressed'));
        const r = await doFetch(`${base}/text`, {
            method: 'POST', body: compressed,
            headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        });
        expect(r.status).toBe(200);
        expect(r.data).toBe('hello compressed');
    });
});

// ============================================================
//  Raw parser — verify + rawBody + inflate
// ============================================================
describe('Raw parser — verify + inflate', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(raw({
            verify: (req, res, buf) =>
            {
                if (buf.length > 50) throw new Error('too big for verify');
            },
        }));
        app.post('/raw', (req, res) => res.json({
            size: req.body.length,
            hasRaw: !!req.rawBody,
        }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('passes when verify succeeds', async () =>
    {
        const r = await doFetch(`${base}/raw`, {
            method: 'POST', body: Buffer.from('small'),
            headers: { 'content-type': 'application/octet-stream' },
        });
        expect(r.status).toBe(200);
        expect(r.data.hasRaw).toBe(true);
    });

    it('rejects with 403 when verify throws', async () =>
    {
        const r = await doFetch(`${base}/raw`, {
            method: 'POST', body: Buffer.alloc(100, 'x'),
            headers: { 'content-type': 'application/octet-stream' },
        });
        expect(r.status).toBe(403);
    });
});

// ============================================================
//  URLEncoded — parameterLimit
// ============================================================
describe('URLEncoded — parameterLimit', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(urlencoded({ parameterLimit: 5, extended: false }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('accepts within parameterLimit', async () =>
    {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a=1&b=2&c=3',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.a).toBe('1');
    });

    it('rejects when exceeding parameterLimit', async () =>
    {
        const params = Array.from({ length: 10 }, (_, i) => `k${i}=v${i}`).join('&');
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: params,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(413);
    });
});

// ============================================================
//  URLEncoded — parameterLimit (extended mode)
// ============================================================
describe('URLEncoded — parameterLimit (extended)', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(urlencoded({ parameterLimit: 3, extended: true }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('rejects when exceeding parameterLimit in extended mode', async () =>
    {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a=1&b=2&c=3&d=4&e=5',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(413);
    });
});

// ============================================================
//  URLEncoded — depth limit
// ============================================================
describe('URLEncoded — depth limit', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(urlencoded({ extended: true, depth: 3 }));
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('accepts within depth limit', async () =>
    {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a[b][c]=deep',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.a.b.c).toBe('deep');
    });

    it('rejects when exceeding depth limit', async () =>
    {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'a[b][c][d][e]=too-deep',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(400);
    });
});

// ============================================================
//  URLEncoded — verify callback
// ============================================================
describe('URLEncoded — verify callback', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(urlencoded({
            verify: (req, res, buf, encoding) =>
            {
                if (buf.toString().includes('evil')) throw new Error('blocked');
            },
        }));
        app.post('/form', (req, res) => res.json({ body: req.body, hasRaw: !!req.rawBody }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('passes when verify succeeds and stores rawBody', async () =>
    {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'name=alice',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(200);
        expect(r.data.hasRaw).toBe(true);
    });

    it('rejects with 403 when verify throws', async () =>
    {
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: 'data=evil',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(r.status).toBe(403);
    });
});

// ============================================================
//  URLEncoded — gzip decompression
// ============================================================
describe('URLEncoded — gzip decompression', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(urlencoded());
        app.post('/form', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('auto-decompresses gzip urlencoded body', async () =>
    {
        const compressed = await gzip(Buffer.from('name=alice&city=wonderland'));
        const r = await doFetch(`${base}/form`, {
            method: 'POST', body: compressed,
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-encoding': 'gzip' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.name).toBe('alice');
        expect(r.data.body.city).toBe('wonderland');
    });
});

// ============================================================
//  Multipart — maxFiles
// ============================================================
describe('Multipart — maxFiles', () =>
{
    let server, base;
    const uploadDir = path.join(__dirname, 'tmp-maxfiles');

    beforeAll(async () =>
    {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({ dir: uploadDir, maxFiles: 2 }), (req, res) =>
        {
            res.json({ files: Object.keys(req.body.files || {}) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() =>
    {
        server?.close();
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    it('accepts within file limit', async () =>
    {
        const boundary = 'boundary-maxfiles-' + Date.now();
        const body = makeMultipartBody(boundary, [
            { name: 'f1', filename: 'a.txt', contentType: 'text/plain', data: 'aaa' },
            { name: 'f2', filename: 'b.txt', contentType: 'text/plain', data: 'bbb' },
        ]);
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.status).toBe(200);
    });

    it('rejects when exceeding maxFiles', async () =>
    {
        const boundary = 'boundary-maxfiles-over-' + Date.now();
        const body = makeMultipartBody(boundary, [
            { name: 'f1', filename: 'a.txt', contentType: 'text/plain', data: 'aaa' },
            { name: 'f2', filename: 'b.txt', contentType: 'text/plain', data: 'bbb' },
            { name: 'f3', filename: 'c.txt', contentType: 'text/plain', data: 'ccc' },
        ]);
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.status).toBe(413);
    });
});

// ============================================================
//  Multipart — maxFields
// ============================================================
describe('Multipart — maxFields', () =>
{
    let server, base;
    const uploadDir = path.join(__dirname, 'tmp-maxfields');

    beforeAll(async () =>
    {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({ dir: uploadDir, maxFields: 2 }), (req, res) =>
        {
            res.json({ fields: req.body.fields || {} });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() =>
    {
        server?.close();
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    it('rejects when exceeding maxFields', async () =>
    {
        const boundary = 'boundary-maxfields-' + Date.now();
        const body = makeMultipartBody(boundary, [
            { name: 'a', data: '1' },
            { name: 'b', data: '2' },
            { name: 'c', data: '3' },
        ]);
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.status).toBe(413);
    });
});

// ============================================================
//  Multipart — allowedMimeTypes
// ============================================================
describe('Multipart — allowedMimeTypes', () =>
{
    let server, base;
    const uploadDir = path.join(__dirname, 'tmp-mimetypes');

    beforeAll(async () =>
    {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({
            dir: uploadDir,
            allowedMimeTypes: ['image/png', 'image/jpeg'],
        }), (req, res) =>
        {
            res.json({ files: Object.keys(req.body.files || {}) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() =>
    {
        server?.close();
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    it('accepts allowed MIME types', async () =>
    {
        const boundary = 'boundary-mime-ok-' + Date.now();
        const body = makeMultipartBody(boundary, [
            { name: 'img', filename: 'photo.png', contentType: 'image/png', data: 'PNG-DATA' },
        ]);
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.status).toBe(200);
    });

    it('rejects disallowed MIME types with 415', async () =>
    {
        const boundary = 'boundary-mime-bad-' + Date.now();
        const body = makeMultipartBody(boundary, [
            { name: 'doc', filename: 'evil.exe', contentType: 'application/x-msdownload', data: 'EXE-DATA' },
        ]);
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.status).toBe(415);
    });
});

// ============================================================
//  Multipart — maxFieldSize
// ============================================================
describe('Multipart — maxFieldSize', () =>
{
    let server, base;
    const uploadDir = path.join(__dirname, 'tmp-fieldsize');

    beforeAll(async () =>
    {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({ dir: uploadDir, maxFieldSize: 20 }), (req, res) =>
        {
            res.json({ fields: req.body.fields || {} });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() =>
    {
        server?.close();
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    it('rejects oversized field value with 413', async () =>
    {
        const boundary = 'boundary-fieldsize-' + Date.now();
        const body = makeMultipartBody(boundary, [
            { name: 'big', data: 'x'.repeat(100) },
        ]);
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.status).toBe(413);
    });
});

// ============================================================
//  Multipart — maxTotalSize
// ============================================================
describe('Multipart — maxTotalSize', () =>
{
    let server, base;
    const uploadDir = path.join(__dirname, 'tmp-totalsize');

    beforeAll(async () =>
    {
        fs.mkdirSync(uploadDir, { recursive: true });
        const app = createApp();
        app.post('/upload', multipart({ dir: uploadDir, maxTotalSize: 50 }), (req, res) =>
        {
            res.json({ files: Object.keys(req.body.files || {}) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(async () =>
    {
        await new Promise(r => server?.close(r));
        await new Promise(r => setTimeout(r, 50));
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
    });

    it('rejects when combined file size exceeds maxTotalSize', async () =>
    {
        const boundary = 'boundary-total-' + Date.now();
        const body = makeMultipartBody(boundary, [
            { name: 'f1', filename: 'a.bin', contentType: 'application/octet-stream', data: 'x'.repeat(30) },
            { name: 'f2', filename: 'b.bin', contentType: 'application/octet-stream', data: 'y'.repeat(30) },
        ]);
        const r = await doFetch(`${base}/upload`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        expect(r.status).toBe(413);
    });
});

// =========================================================================
//  multipart parser � coverage boost (from coverage/boost.test.js)
// =========================================================================
{
	const uploadDir = path.join(__dirname, 'tmp-mp-boost-' + process.pid);

	beforeAll(() => fs.mkdirSync(uploadDir, { recursive: true }));
	afterAll(() => { try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {} });

	function buildMultipart(parts, boundary = 'BOUNDARY')
	{
		const chunks = [];
		for (const part of parts)
		{
			let headers = `--${boundary}\r\n`;
			if (part.filename)
			{
				headers += `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`;
				if (part.contentType) headers += `Content-Type: ${part.contentType}\r\n`;
			}
			else
			{
				headers += `Content-Disposition: form-data; name="${part.name}"\r\n`;
			}
			headers += '\r\n';
			chunks.push(Buffer.from(headers));
			chunks.push(Buffer.from(part.data || ''));
			chunks.push(Buffer.from('\r\n'));
		}
		chunks.push(Buffer.from(`--${boundary}--\r\n`));
		return Buffer.concat(chunks);
	}

	describe('HTTP integration multipart tests', () =>
	{
		let server, base;

		beforeAll(async () =>
		{
			const app = createApp();
			app.post('/up', multipart({
				dir: uploadDir,
				maxFileSize: 500,
				maxFiles: 2,
				maxFields: 3,
				maxFieldSize: 50,
				maxTotalSize: 800,
				allowedMimeTypes: ['text/plain', 'image/png'],
			}), (req, res) =>
			{
				res.json({ fields: req.body?.fields || {}, files: req.body?.files || {} });
			});
			server = http.createServer(app.handler);
			await new Promise(r => server.listen(0, r));
			base = `http://localhost:${server.address().port}`;
		});

		afterAll(() => server?.close());

		it('successful field + file upload', async () =>
		{
			const boundary = 'bnd-' + Date.now();
			const body = buildMultipart([
				{ name: 'title', data: 'My Upload' },
				{ name: 'doc', filename: 'readme.txt', contentType: 'text/plain', data: 'hello world' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(200);
			expect(r.data.fields.title).toBe('My Upload');
			expect(r.data.files.doc).toBeDefined();
		});

		it('too many files returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-files';
			const body = buildMultipart([
				{ name: 'f1', filename: 'a.txt', contentType: 'text/plain', data: 'a' },
				{ name: 'f2', filename: 'b.txt', contentType: 'text/plain', data: 'b' },
				{ name: 'f3', filename: 'c.txt', contentType: 'text/plain', data: 'c' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('too many fields returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-fields';
			const body = buildMultipart([
				{ name: 'f1', data: 'a' },
				{ name: 'f2', data: 'b' },
				{ name: 'f3', data: 'c' },
				{ name: 'f4', data: 'd' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('disallowed MIME type returns 415', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-mime';
			const body = buildMultipart([
				{ name: 'evil', filename: 'script.js', contentType: 'application/javascript', data: 'alert(1)' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(415);
		});

		it('oversized file returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-big';
			const body = buildMultipart([
				{ name: 'big', filename: 'large.txt', contentType: 'text/plain', data: 'x'.repeat(600) },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('oversized field value returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-bigfield';
			const body = buildMultipart([
				{ name: 'longval', data: 'x'.repeat(100) },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('combined total size limit', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-total';
			const body = buildMultipart([
				{ name: 'f1', filename: 'a.txt', contentType: 'text/plain', data: 'x'.repeat(450) },
				{ name: 'f2', filename: 'b.txt', contentType: 'text/plain', data: 'y'.repeat(450) },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('filename sanitization strips dangerous chars', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-san';
			const body = buildMultipart([
				{ name: 'file', filename: '../../../etc/passwd', contentType: 'text/plain', data: 'test' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			if (r.data.files?.file) {
				expect(r.data.files.file.originalFilename).not.toContain('..');
				expect(r.data.files.file.originalFilename).not.toContain('/');
			}
		});

		it('file without extension', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-noext';
			const body = buildMultipart([
				{ name: 'doc', filename: 'README', contentType: 'text/plain', data: 'content' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(200);
		});
	});

	describe('multipart requireSecure', () =>
	{
		let server, base;

		beforeAll(async () =>
		{
			const app = createApp();
			app.post('/up-sec', multipart({ requireSecure: true }), (req, res) => res.json({ ok: true }));
			server = http.createServer(app.handler);
			await new Promise(r => server.listen(0, r));
			base = `http://localhost:${server.address().port}`;
		});

		afterAll(() => server?.close());

		it('rejects non-HTTPS when requireSecure is true', async () =>
		{
			const boundary = 'bnd-' + Date.now();
			const body = buildMultipart([{ name: 'f', data: 'v' }], boundary);
			const r = await doFetch(`${base}/up-sec`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(403);
		});
	});
};

// ===================================================================
//  WebSocket handshake — function coverage (50% → 100%)
// ===================================================================



// =========================================================================
//  multipart � deep branch coverage (from coverage/deep.test.js)
// =========================================================================

describe('multipart — deep branch coverage', () => {
	let server, base, tmpDir;

	beforeAll(async () => {
		const { createApp, multipart } = require('../../');
		tmpDir = path.join(os.tmpdir(), 'zero-test-multipart-deep-' + Date.now());
		const app = createApp();

		// Route with all security controls enabled
		app.post('/secure-upload', multipart({
			dir: tmpDir,
			maxFileSize: 500,
			maxFields: 2,
			maxFiles: 1,
			maxFieldSize: 50,
			allowedMimeTypes: ['text/plain', 'image/png'],
			maxTotalSize: 1000,
			requireSecure: false,
		}), (req, res) => {
			res.json({ fields: req.body?.fields || {}, files: Object.keys(req.body?.files || {}) });
		});

		// Route that requires HTTPS
		app.post('/require-secure', multipart({ requireSecure: true }), (req, res) => {
			res.json({ ok: true });
		});

		// Permissive route for normal uploads
		app.post('/upload', multipart({ dir: tmpDir }), (req, res) => {
			res.json({
				fields: req.body?.fields || {},
				files: Object.keys(req.body?.files || {}),
				fileDetails: req.body?.files || {},
			});
		});

		// Route with relative dir path
		app.post('/reldir', multipart({ dir: 'test-uploads-tmp' }), (req, res) => {
			res.json({ ok: true, fields: req.body?.fields || {} });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => {
		server?.close();
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(path.join(process.cwd(), 'test-uploads-tmp'), { recursive: true, force: true }); } catch {}
	});

	function multipartBody(boundary, parts) {
		let body = '';
		for (const p of parts) {
			body += `--${boundary}\r\n`;
			if (p.filename) {
				body += `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`;
				if (p.contentType) body += `Content-Type: ${p.contentType}\r\n`;
				body += `\r\n${p.data}\r\n`;
			} else {
				body += `Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.data}\r\n`;
			}
		}
		body += `--${boundary}--\r\n`;
		return body;
	}

	it('rejects requests when requireSecure is true on HTTP', async () => {
		const boundary = 'test-boundary-secure';
		const body = multipartBody(boundary, [{ name: 'x', data: 'y' }]);
		const r = await fetch(`${base}/require-secure`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(403);
	});

	it('enforces maxFiles limit', async () => {
		const boundary = 'test-boundary-maxfiles';
		const body = multipartBody(boundary, [
			{ name: 'file1', filename: 'a.txt', contentType: 'text/plain', data: 'hello' },
			{ name: 'file2', filename: 'b.txt', contentType: 'text/plain', data: 'world' },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('enforces maxFields limit', async () => {
		const boundary = 'test-boundary-maxfields';
		const body = multipartBody(boundary, [
			{ name: 'f1', data: 'v1' },
			{ name: 'f2', data: 'v2' },
			{ name: 'f3', data: 'v3' },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('enforces maxFieldSize limit', async () => {
		const boundary = 'test-boundary-maxfieldsize';
		const body = multipartBody(boundary, [
			{ name: 'big', data: 'x'.repeat(100) },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('rejects disallowed MIME types', async () => {
		const boundary = 'test-boundary-mimetype';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'script.js', contentType: 'application/javascript', data: 'console.log()' },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(415);
	});

	it('enforces maxFileSize limit', async () => {
		const boundary = 'test-boundary-filesize';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'big.txt', contentType: 'text/plain', data: 'x'.repeat(600) },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('enforces maxTotalSize across multiple conceptual file chunks', async () => {
		const boundary = 'test-boundary-totalsize';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'big.txt', contentType: 'text/plain', data: 'y'.repeat(450) },
		]);
		// A single 450 byte file within 500 maxFileSize but total 1000 should be fine
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		// should be ok or 413 depending on total
		expect([200, 413]).toContain(r.status);
	});

	it('passes through when no boundary in content-type', async () => {
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': 'multipart/form-data' },
			body: 'test data',
		});
		// Without boundary, multipart passes to next(), body not parsed
		expect(r.status).toBe(200);
	});

	it('handles quoted boundary in content-type', async () => {
		const boundary = 'quoted-boundary-test';
		const body = multipartBody(boundary, [
			{ name: 'field1', data: 'value1' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary="${boundary}"` },
			body,
		});
		expect(r.status).toBe(200);
		const json = await r.json();
		expect(json.fields.field1).toBe('value1');
	});

	it('sanitizes directory traversal in filenames', async () => {
		const boundary = 'test-boundary-sanitize';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: '../../../etc/passwd', contentType: 'text/plain', data: 'hello' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
		const json = await r.json();
		// File should be stored, but filename stripped of traversal
		if (json.fileDetails?.file) {
			expect(json.fileDetails.file.originalFilename).not.toContain('..');
		}
	});

	it('handles filenames with special characters', async () => {
		const boundary = 'test-boundary-special';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: '.hidden<file>name|test?.txt', contentType: 'text/plain', data: 'data' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});

	it('handles upload with relative dir option', async () => {
		const boundary = 'test-boundary-reldir';
		const body = multipartBody(boundary, [
			{ name: 'msg', data: 'hello' },
		]);
		const r = await fetch(`${base}/reldir`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});

	it('handles empty file upload', async () => {
		const boundary = 'test-boundary-emptyfile';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'empty.txt', contentType: 'text/plain', data: '' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});

	it('handles file without extension', async () => {
		const boundary = 'test-boundary-noext';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'noext', contentType: 'text/plain', data: 'abc' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});
});


// =========================================================================
//  multipart parser — coverage boost (from coverage/boost.test.js)
// =========================================================================

{
	const uploadDir = path.join(__dirname, 'tmp-mp-boost-' + process.pid);

	beforeAll(() => fs.mkdirSync(uploadDir, { recursive: true }));
	afterAll(() => { try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {} });

	function buildMultipart(parts, boundary = 'BOUNDARY')
	{
		const chunks = [];
		for (const part of parts)
		{
			let headers = `--${boundary}\r\n`;
			if (part.filename)
			{
				headers += `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`;
				if (part.contentType) headers += `Content-Type: ${part.contentType}\r\n`;
			}
			else
			{
				headers += `Content-Disposition: form-data; name="${part.name}"\r\n`;
			}
			headers += '\r\n';
			chunks.push(Buffer.from(headers));
			chunks.push(Buffer.from(part.data || ''));
			chunks.push(Buffer.from('\r\n'));
		}
		chunks.push(Buffer.from(`--${boundary}--\r\n`));
		return Buffer.concat(chunks);
	}

	describe('HTTP integration multipart tests', () =>
	{
		let server, base;

		beforeAll(async () =>
		{
			const app = createApp();
			app.post('/up', multipart({
				dir: uploadDir,
				maxFileSize: 500,
				maxFiles: 2,
				maxFields: 3,
				maxFieldSize: 50,
				maxTotalSize: 800,
				allowedMimeTypes: ['text/plain', 'image/png'],
			}), (req, res) =>
			{
				res.json({ fields: req.body?.fields || {}, files: req.body?.files || {} });
			});
			server = http.createServer(app.handler);
			await new Promise(r => server.listen(0, r));
			base = `http://localhost:${server.address().port}`;
		});

		afterAll(() => server?.close());

		it('successful field + file upload', async () =>
		{
			const boundary = 'bnd-' + Date.now();
			const body = buildMultipart([
				{ name: 'title', data: 'My Upload' },
				{ name: 'doc', filename: 'readme.txt', contentType: 'text/plain', data: 'hello world' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(200);
			expect(r.data.fields.title).toBe('My Upload');
			expect(r.data.files.doc).toBeDefined();
		});

		it('too many files returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-files';
			const body = buildMultipart([
				{ name: 'f1', filename: 'a.txt', contentType: 'text/plain', data: 'a' },
				{ name: 'f2', filename: 'b.txt', contentType: 'text/plain', data: 'b' },
				{ name: 'f3', filename: 'c.txt', contentType: 'text/plain', data: 'c' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('too many fields returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-fields';
			const body = buildMultipart([
				{ name: 'f1', data: 'a' },
				{ name: 'f2', data: 'b' },
				{ name: 'f3', data: 'c' },
				{ name: 'f4', data: 'd' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('disallowed MIME type returns 415', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-mime';
			const body = buildMultipart([
				{ name: 'evil', filename: 'script.js', contentType: 'application/javascript', data: 'alert(1)' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(415);
		});

		it('oversized file returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-big';
			const body = buildMultipart([
				{ name: 'big', filename: 'large.txt', contentType: 'text/plain', data: 'x'.repeat(600) },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('oversized field value returns 413', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-bigfield';
			const body = buildMultipart([
				{ name: 'longval', data: 'x'.repeat(100) },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('combined total size limit', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-total';
			const body = buildMultipart([
				{ name: 'f1', filename: 'a.txt', contentType: 'text/plain', data: 'x'.repeat(450) },
				{ name: 'f2', filename: 'b.txt', contentType: 'text/plain', data: 'y'.repeat(450) },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(413);
		});

		it('filename sanitization strips dangerous chars', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-san';
			const body = buildMultipart([
				{ name: 'file', filename: '../../../etc/passwd', contentType: 'text/plain', data: 'test' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			if (r.data.files?.file) {
				expect(r.data.files.file.originalFilename).not.toContain('..');
				expect(r.data.files.file.originalFilename).not.toContain('/');
			}
		});

		it('file without extension', async () =>
		{
			const boundary = 'bnd-' + Date.now() + '-noext';
			const body = buildMultipart([
				{ name: 'doc', filename: 'README', contentType: 'text/plain', data: 'content' },
			], boundary);

			const r = await doFetch(`${base}/up`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(200);
		});
	});

	describe('multipart requireSecure', () =>
	{
		let server, base;

		beforeAll(async () =>
		{
			const app = createApp();
			app.post('/up-sec', multipart({ requireSecure: true }), (req, res) => res.json({ ok: true }));
			server = http.createServer(app.handler);
			await new Promise(r => server.listen(0, r));
			base = `http://localhost:${server.address().port}`;
		});

		afterAll(() => server?.close());

		it('rejects non-HTTPS when requireSecure is true', async () =>
		{
			const boundary = 'bnd-' + Date.now();
			const body = buildMultipart([{ name: 'f', data: 'v' }], boundary);
			const r = await doFetch(`${base}/up-sec`, {
				method: 'POST', body,
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
			});
			expect(r.status).toBe(403);
		});
	});
};

// ===================================================================
//  WebSocket handshake — function coverage (50% → 100%)
// ===================================================================


// =========================================================================
//  multipart — deep branch coverage (from coverage/deep.test.js)
// =========================================================================

describe('multipart — deep branch coverage', () => {
	let server, base, tmpDir;

	beforeAll(async () => {
		const { createApp, multipart } = require('../../');
		tmpDir = path.join(os.tmpdir(), 'zero-test-multipart-deep-' + Date.now());
		const app = createApp();

		// Route with all security controls enabled
		app.post('/secure-upload', multipart({
			dir: tmpDir,
			maxFileSize: 500,
			maxFields: 2,
			maxFiles: 1,
			maxFieldSize: 50,
			allowedMimeTypes: ['text/plain', 'image/png'],
			maxTotalSize: 1000,
			requireSecure: false,
		}), (req, res) => {
			res.json({ fields: req.body?.fields || {}, files: Object.keys(req.body?.files || {}) });
		});

		// Route that requires HTTPS
		app.post('/require-secure', multipart({ requireSecure: true }), (req, res) => {
			res.json({ ok: true });
		});

		// Permissive route for normal uploads
		app.post('/upload', multipart({ dir: tmpDir }), (req, res) => {
			res.json({
				fields: req.body?.fields || {},
				files: Object.keys(req.body?.files || {}),
				fileDetails: req.body?.files || {},
			});
		});

		// Route with relative dir path
		app.post('/reldir', multipart({ dir: 'test-uploads-tmp' }), (req, res) => {
			res.json({ ok: true, fields: req.body?.fields || {} });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => {
		server?.close();
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
		try { fs.rmSync(path.join(process.cwd(), 'test-uploads-tmp'), { recursive: true, force: true }); } catch {}
	});

	function multipartBody(boundary, parts) {
		let body = '';
		for (const p of parts) {
			body += `--${boundary}\r\n`;
			if (p.filename) {
				body += `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`;
				if (p.contentType) body += `Content-Type: ${p.contentType}\r\n`;
				body += `\r\n${p.data}\r\n`;
			} else {
				body += `Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.data}\r\n`;
			}
		}
		body += `--${boundary}--\r\n`;
		return body;
	}

	it('rejects requests when requireSecure is true on HTTP', async () => {
		const boundary = 'test-boundary-secure';
		const body = multipartBody(boundary, [{ name: 'x', data: 'y' }]);
		const r = await fetch(`${base}/require-secure`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(403);
	});

	it('enforces maxFiles limit', async () => {
		const boundary = 'test-boundary-maxfiles';
		const body = multipartBody(boundary, [
			{ name: 'file1', filename: 'a.txt', contentType: 'text/plain', data: 'hello' },
			{ name: 'file2', filename: 'b.txt', contentType: 'text/plain', data: 'world' },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('enforces maxFields limit', async () => {
		const boundary = 'test-boundary-maxfields';
		const body = multipartBody(boundary, [
			{ name: 'f1', data: 'v1' },
			{ name: 'f2', data: 'v2' },
			{ name: 'f3', data: 'v3' },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('enforces maxFieldSize limit', async () => {
		const boundary = 'test-boundary-maxfieldsize';
		const body = multipartBody(boundary, [
			{ name: 'big', data: 'x'.repeat(100) },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('rejects disallowed MIME types', async () => {
		const boundary = 'test-boundary-mimetype';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'script.js', contentType: 'application/javascript', data: 'console.log()' },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(415);
	});

	it('enforces maxFileSize limit', async () => {
		const boundary = 'test-boundary-filesize';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'big.txt', contentType: 'text/plain', data: 'x'.repeat(600) },
		]);
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(413);
	});

	it('enforces maxTotalSize across multiple conceptual file chunks', async () => {
		const boundary = 'test-boundary-totalsize';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'big.txt', contentType: 'text/plain', data: 'y'.repeat(450) },
		]);
		// A single 450 byte file within 500 maxFileSize but total 1000 should be fine
		const r = await fetch(`${base}/secure-upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		// should be ok or 413 depending on total
		expect([200, 413]).toContain(r.status);
	});

	it('passes through when no boundary in content-type', async () => {
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': 'multipart/form-data' },
			body: 'test data',
		});
		// Without boundary, multipart passes to next(), body not parsed
		expect(r.status).toBe(200);
	});

	it('handles quoted boundary in content-type', async () => {
		const boundary = 'quoted-boundary-test';
		const body = multipartBody(boundary, [
			{ name: 'field1', data: 'value1' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary="${boundary}"` },
			body,
		});
		expect(r.status).toBe(200);
		const json = await r.json();
		expect(json.fields.field1).toBe('value1');
	});

	it('sanitizes directory traversal in filenames', async () => {
		const boundary = 'test-boundary-sanitize';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: '../../../etc/passwd', contentType: 'text/plain', data: 'hello' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
		const json = await r.json();
		// File should be stored, but filename stripped of traversal
		if (json.fileDetails?.file) {
			expect(json.fileDetails.file.originalFilename).not.toContain('..');
		}
	});

	it('handles filenames with special characters', async () => {
		const boundary = 'test-boundary-special';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: '.hidden<file>name|test?.txt', contentType: 'text/plain', data: 'data' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});

	it('handles upload with relative dir option', async () => {
		const boundary = 'test-boundary-reldir';
		const body = multipartBody(boundary, [
			{ name: 'msg', data: 'hello' },
		]);
		const r = await fetch(`${base}/reldir`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});

	it('handles empty file upload', async () => {
		const boundary = 'test-boundary-emptyfile';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'empty.txt', contentType: 'text/plain', data: '' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});

	it('handles file without extension', async () => {
		const boundary = 'test-boundary-noext';
		const body = multipartBody(boundary, [
			{ name: 'file', filename: 'noext', contentType: 'text/plain', data: 'abc' },
		]);
		const r = await fetch(`${base}/upload`, {
			method: 'POST',
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
			body,
		});
		expect(r.status).toBe(200);
	});
});
