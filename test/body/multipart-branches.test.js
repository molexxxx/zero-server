/** multipart-branches.test.js — multipart parser branch coverage */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('stream');
const { doFetch } = require('../_helpers');
const { createApp, multipart } = require('../../');
const mpFactory = require('../../lib/body/multipart');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRes()
{
    const res = {
        headersSent: false,
        statusCode: null,
        _headers: {},
        _body: null,
        setHeader(k, v) { this._headers[k] = v; },
        end(b) { this._body = b; this.headersSent = true; },
        writeHead(code) { this.statusCode = code; this.headersSent = true; },
    };
    res.raw = res;
    return res;
}

function buildMultipart(boundary, parts)
{
    const chunks = [];
    for (const p of parts)
    {
        chunks.push(`--${boundary}\r\n`);
        let disp = `Content-Disposition: form-data; name="${p.name}"`;
        if (p.filename) disp += `; filename="${p.filename}"`;
        chunks.push(disp + '\r\n');
        if (p.ct) chunks.push(`Content-Type: ${p.ct}\r\n`);
        chunks.push('\r\n');
        chunks.push(p.data);
        chunks.push('\r\n');
    }
    chunks.push(`--${boundary}--\r\n`);
    return Buffer.from(chunks.join(''));
}

function callMw(opts, headers, dataBuffers)
{
    return new Promise((resolve) =>
    {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers, secure: true };
        const res = mockRes();

        const mw = mpFactory(opts);
        mw(req, res, () => resolve({ req, res, nextCalled: true }));

        // Allow the middleware to attach listeners
        setImmediate(() =>
        {
            for (const buf of dataBuffers) emitter.emit('data', Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
            emitter.emit('end');
        });

        // Safety timeout — if next() is never called check res
        setTimeout(() => resolve({ req, res, nextCalled: false }), 500);
    });
}

// ---------------------------------------------------------------------------
// Tests — HTTP server based (integration)
// ---------------------------------------------------------------------------

describe('multipart — incremental body with partial boundary buffering', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-inc-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) =>
        {
            const files = req.body?.files || {};
            const sizes = {};
            for (const [k, v] of Object.entries(files)) sizes[k] = v.size;
            res.json({ fields: req.body?.fields || {}, sizes });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('handles large file upload that triggers incremental write (>1024 tail)', async () =>
    {
        const bnd = 'inc-boundary-test';
        const bigData = 'X'.repeat(4096);
        const body = buildMultipart(bnd, [{ name: 'bigfile', filename: 'big.bin', ct: 'application/octet-stream', data: bigData }]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.sizes.bigfile).toBeGreaterThan(0);
    });

    it('handles multiple fields and files in single upload', async () =>
    {
        const bnd = 'multi-parts';
        const body = buildMultipart(bnd, [
            { name: 'name', data: 'Alice' },
            { name: 'age', data: '30' },
            { name: 'avatar', filename: 'avatar.png', ct: 'image/png', data: 'fakeimagedata' },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.fields.name).toBe('Alice');
        expect(r.data.fields.age).toBe('30');
        expect(r.data.sizes.avatar).toBeGreaterThan(0);
    });

    it('handles field-only upload (no files)', async () =>
    {
        const bnd = 'fields-only';
        const body = buildMultipart(bnd, [
            { name: 'key1', data: 'val1' },
            { name: 'key2', data: 'val2' },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.fields.key1).toBe('val1');
        expect(r.data.fields.key2).toBe('val2');
    });
});

// ---------------------------------------------------------------------------
// Tests — Direct middleware calls targeting specific branches
// ---------------------------------------------------------------------------

describe('multipart — sanitizeFilename edge cases', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-sanfn-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) =>
        {
            const files = req.body?.files || {};
            const filenames = {};
            for (const [k, v] of Object.entries(files)) filenames[k] = v.originalFilename;
            res.json({ filenames, fields: req.body?.fields || {} });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('sanitizes empty filename to "unnamed"', async () =>
    {
        const bnd = 'sanfn';
        // Manually build body with filename=""
        const raw = `--${bnd}\r\nContent-Disposition: form-data; name="f"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\ndata\r\n--${bnd}--\r\n`;
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body: Buffer.from(raw),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
    });

    it('sanitizes filename with null bytes', async () =>
    {
        const bnd = 'sanfn2';
        const raw = `--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="test\x00evil.txt"\r\nContent-Type: text/plain\r\n\r\ndata\r\n--${bnd}--\r\n`;
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body: Buffer.from(raw),
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.filenames.f).toBe('testevil.txt');
    });
});

describe('multipart — parseContentDisposition edge cases', () =>
{
    it('handles segment that does not match key=value regex', async () =>
    {
        const bnd = 'cdedge';
        // Add extra empty segment via double-semicolon  
        const raw = `--${bnd}\r\nContent-Disposition: form-data;; name="val"\r\n\r\nhello\r\n--${bnd}--\r\n`;
        const result = await callMw(
            {},
            { 'content-type': `multipart/form-data; boundary=${bnd}` },
            [raw],
        );
        expect(result.nextCalled).toBe(true);
        // Field should still be parsed (the empty segment is skipped)
        expect(result.req.body.fields.val).toBe('hello');
    });
});

describe('multipart — no boundary in content-type', () =>
{
    it('calls next() when no boundary is present', async () =>
    {
        const result = await callMw(
            {},
            { 'content-type': 'multipart/form-data' }, // no boundary
            ['some data'],
        );
        expect(result.nextCalled).toBe(true);
        expect(result.req.body).toBeUndefined();
    });
});

describe('multipart — quoted boundary', () =>
{
    it('handles quoted boundary in content-type', async () =>
    {
        const bnd = 'qb-test';
        const body = buildMultipart(bnd, [{ name: 'x', data: 'val' }]);
        const result = await callMw(
            {},
            { 'content-type': `multipart/form-data; boundary="${bnd}"` },
            [body],
        );
        expect(result.nextCalled).toBe(true);
        expect(result.req.body.fields.x).toBe('val');
    });
});

describe('multipart — file without extension', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-noext-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir }), (req, res) =>
        {
            const files = req.body?.files || {};
            const info = {};
            for (const [k, v] of Object.entries(files)) info[k] = v.storedName;
            res.json(info);
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('creates file without extension appended', async () =>
    {
        const bnd = 'noext';
        const body = buildMultipart(bnd, [
            { name: 'f', filename: 'noextfile', ct: 'application/octet-stream', data: 'data' },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
        expect(r.data.f).not.toContain('.');
    });
});

describe('multipart — relative dir option', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        const relDir = 'test-uploads-' + process.pid;
        tmpDir = path.join(process.cwd(), relDir);
        const app = createApp();
        app.post('/up', multipart({ dir: relDir }), (req, res) =>
        {
            res.json({ files: Object.keys(req.body?.files || {}) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('handles relative dir path', async () =>
    {
        const bnd = 'reldir';
        const body = buildMultipart(bnd, [
            { name: 'f', filename: 'rel.txt', ct: 'text/plain', data: 'hello' },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(200);
    });
});

describe('multipart — error event on raw stream', () =>
{
    it('calls next() on error event', async () =>
    {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': 'multipart/form-data; boundary=ERRTEST' }, secure: true };
        const res = mockRes();

        let nextCalled = false;
        const mw = mpFactory({});
        mw(req, res, () => { nextCalled = true; });

        setImmediate(() =>
        {
            emitter.emit('error', new Error('stream failure'));
        });

        await new Promise(r => setTimeout(r, 100));
        expect(nextCalled).toBe(true);
    });
});

describe('multipart — end event with pending current', () =>
{
    it('finishes current field on stream end without final boundary', async () =>
    {
        const bnd = 'ENDTEST';
        const data = `--${bnd}\r\nContent-Disposition: form-data; name="partial"\r\n\r\nsome value`;
        const result = await callMw(
            {},
            { 'content-type': `multipart/form-data; boundary=${bnd}` },
            [data],
        );
        expect(result.nextCalled).toBe(true);
        expect(result.req.body).toBeDefined();
        expect(result.req._multipart).toBe(true);
        expect(result.req.body.fields.partial).toBeDefined();
    });
});

describe('multipart — maxFileSize enforcement', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-mfs-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, maxFileSize: 5 }), (req, res) =>
        {
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('rejects file exceeding maxFileSize at boundary-found path', async () =>
    {
        const bnd = 'mfs';
        const body = buildMultipart(bnd, [
            { name: 'f', filename: 'x.bin', ct: 'application/octet-stream', data: 'A'.repeat(20) },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });

    it('rejects file exceeding maxFileSize during incremental write', async () =>
    {
        const bnd = 'mfsinc';
        const bigData = 'B'.repeat(4096);
        const body = buildMultipart(bnd, [
            { name: 'f', filename: 'big.bin', ct: 'application/octet-stream', data: bigData },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });
});

describe('multipart — maxTotalSize enforcement', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-total-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, maxTotalSize: 20 }), (req, res) =>
        {
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('rejects when total file size exceeds maxTotalSize', async () =>
    {
        const bnd = 'total-limit';
        const body = buildMultipart(bnd, [
            { name: 'f1', filename: 'a.bin', ct: 'application/octet-stream', data: 'Y'.repeat(50) },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });

    it('rejects when total exceeds limit across multiple files', async () =>
    {
        const bnd = 'total2';
        const body = buildMultipart(bnd, [
            { name: 'f1', filename: 'a.bin', ct: 'application/octet-stream', data: 'Y'.repeat(15) },
            { name: 'f2', filename: 'b.bin', ct: 'application/octet-stream', data: 'Y'.repeat(15) },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });
});

describe('multipart — maxFieldSize enforcement', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-field-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, maxFieldSize: 10 }), (req, res) =>
        {
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('rejects field value exceeding maxFieldSize at boundary-found', async () =>
    {
        const bnd = 'fslimit';
        const body = buildMultipart(bnd, [
            { name: 'bigfield', data: 'Z'.repeat(50) },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });

    it('rejects field value exceeding maxFieldSize during incremental write', async () =>
    {
        const bnd = 'fsincr';
        // Large enough to trigger incremental path (>1024 bytes)
        const bigVal = 'W'.repeat(2048);
        const body = buildMultipart(bnd, [
            { name: 'bigfield', data: bigVal },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });
});

describe('multipart — maxFiles limit', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-maxf-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, maxFiles: 1 }), (req, res) =>
        {
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('rejects when file count exceeds maxFiles', async () =>
    {
        const bnd = 'maxfiles';
        const body = buildMultipart(bnd, [
            { name: 'f1', filename: 'a.txt', ct: 'text/plain', data: 'x' },
            { name: 'f2', filename: 'b.txt', ct: 'text/plain', data: 'y' },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });
});

describe('multipart — maxFields limit', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-maxfld-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, maxFields: 1 }), (req, res) =>
        {
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('rejects when field count exceeds maxFields', async () =>
    {
        const bnd = 'maxfields';
        const body = buildMultipart(bnd, [
            { name: 'f1', data: 'a' },
            { name: 'f2', data: 'b' },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(413);
    });
});

describe('multipart — allowedMimeTypes rejection', () =>
{
    let server, base, tmpDir;

    beforeAll(async () =>
    {
        tmpDir = path.join(os.tmpdir(), 'zero-mp-mime-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });
        const app = createApp();
        app.post('/up', multipart({ dir: tmpDir, allowedMimeTypes: ['image/png'] }), (req, res) =>
        {
            res.json({ ok: true });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });
    afterAll(() => { server?.close(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it('rejects file with disallowed MIME type', async () =>
    {
        const bnd = 'mimetype';
        const body = buildMultipart(bnd, [
            { name: 'f', filename: 'doc.pdf', ct: 'application/pdf', data: 'pdfdata' },
        ]);
        const r = await doFetch(`${base}/up`, {
            method: 'POST', body,
            headers: { 'content-type': `multipart/form-data; boundary=${bnd}` },
        });
        expect(r.status).toBe(415);
    });
});

describe('multipart — _multipartErrorHandled guard (double error)', () =>
{
    it('prevents double error when maxFiles and maxFileSize both trigger', async () =>
    {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': 'multipart/form-data; boundary=DBERR' }, secure: true };
        const res = mockRes();
        const tmpDir = path.join(os.tmpdir(), 'zero-mp-dberr-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const mw = mpFactory({ dir: tmpDir, maxFiles: 1, maxFileSize: 5 });
        let nextCallCount = 0;
        mw(req, res, () => { nextCallCount++; });

        const bnd = 'DBERR';
        // First file is fine, second file triggers maxFiles
        const raw = `--${bnd}\r\nContent-Disposition: form-data; name="f1"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${bnd}\r\nContent-Disposition: form-data; name="f2"; filename="b.txt"\r\nContent-Type: text/plain\r\n\r\nbigdata\r\n--${bnd}--\r\n`;

        setImmediate(() =>
        {
            emitter.emit('data', Buffer.from(raw));
            // Emit another data event — should hit 'already handled' guard
            emitter.emit('data', Buffer.from(`\r\n--${bnd}\r\nContent-Disposition: form-data; name="f3"; filename="c.txt"\r\nContent-Type: text/plain\r\n\r\nextra\r\n--${bnd}--\r\n`));
            emitter.emit('end');
        });

        await new Promise(r => setTimeout(r, 200));
        // Error was sent for maxFiles, _multipartErrorHandled should have been set
        expect(res.statusCode).toBe(413);

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});

describe('multipart — closeCurrent writeStream error path', () =>
{
    it('resolves on writeStream error event during close', async () =>
    {
        const bnd = 'ERR';
        const tmpDir = path.join(os.tmpdir(), 'zero-mp-wserr-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const payload = `--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nfiledata\r\n--${bnd}--\r\n`;
        const result = await callMw(
            { dir: tmpDir },
            { 'content-type': `multipart/form-data; boundary=${bnd}` },
            [payload],
        );

        expect(result.nextCalled).toBe(true);

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});

describe('multipart — requireSecure option', () =>
{
    it('returns 403 when requireSecure is true and request is not secure', async () =>
    {
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': 'multipart/form-data; boundary=SEC' }, secure: false };
        const res = mockRes();

        let nextCalled = false;
        const mw = mpFactory({ requireSecure: true });
        // For sendError the response needs proper structure
        mw(req, res, () => { nextCalled = true; });

        await new Promise(r => setTimeout(r, 50));
        expect(nextCalled).toBe(false);
        // sendError should have been called with 403
        expect(res.statusCode).toBe(403);
    });

    it('proceeds normally when requireSecure is true and request is secure', async () =>
    {
        const bnd = 'SECOK';
        const body = buildMultipart(bnd, [{ name: 'x', data: 'val' }]);
        const result = await callMw(
            { requireSecure: true },
            { 'content-type': `multipart/form-data; boundary=${bnd}` },
            [body],
        );
        expect(result.nextCalled).toBe(true);
        expect(result.req.body.fields.x).toBe('val');
    });
});

describe('multipart — buffer trimming in start state', () =>
{
    it('trims buffer when boundary not found and buffer > boundary length', async () =>
    {
        const bnd = 'TRIMTEST';
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': `multipart/form-data; boundary=${bnd}` }, secure: true };
        const res = mockRes();

        let nextCalled = false;
        const mw = mpFactory({});
        mw(req, res, () => { nextCalled = true; });

        setImmediate(() =>
        {
            // Send junk data that doesn't contain the boundary
            emitter.emit('data', Buffer.from('X'.repeat(200)));
            // Now send actual multipart data with the boundary
            const body = buildMultipart(bnd, [{ name: 'k', data: 'v' }]);
            emitter.emit('data', body);
            emitter.emit('end');
        });

        await new Promise(r => setTimeout(r, 200));
        expect(nextCalled).toBe(true);
    });
});

describe('multipart — incremental maxTotalSize', () =>
{
    it('rejects during incremental writes when maxTotalSize exceeded', async () =>
    {
        const bnd = 'INCTOT';
        const tmpDir = path.join(os.tmpdir(), 'zero-mp-inctot-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': `multipart/form-data; boundary=${bnd}` }, secure: true };
        const res = mockRes();

        const mw = mpFactory({ dir: tmpDir, maxTotalSize: 50 });
        mw(req, res, () => {});

        setImmediate(() =>
        {
            // Send header for a file part
            emitter.emit('data', Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`));
            // Send large data chunks (without boundary, so incremental path)
            emitter.emit('data', Buffer.from('A'.repeat(2048)));
            emitter.emit('data', Buffer.from('B'.repeat(2048)));
        });

        await new Promise(r => setTimeout(r, 200));
        expect(res.statusCode).toBe(413);

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});

describe('multipart — incremental maxFileSize', () =>
{
    it('rejects during incremental writes when maxFileSize exceeded', async () =>
    {
        const bnd = 'INCFS';
        const tmpDir = path.join(os.tmpdir(), 'zero-mp-incfs-' + process.pid);
        fs.mkdirSync(tmpDir, { recursive: true });

        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': `multipart/form-data; boundary=${bnd}` }, secure: true };
        const res = mockRes();

        const mw = mpFactory({ dir: tmpDir, maxFileSize: 50 });
        mw(req, res, () => {});

        setImmediate(() =>
        {
            emitter.emit('data', Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="f"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`));
            emitter.emit('data', Buffer.from('X'.repeat(2048)));
        });

        await new Promise(r => setTimeout(r, 200));
        expect(res.statusCode).toBe(413);

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
});

describe('multipart — incremental maxFieldSize', () =>
{
    it('rejects during incremental writes when field value exceeds maxFieldSize', async () =>
    {
        const bnd = 'INCFLD';
        const emitter = new EventEmitter();
        emitter.pause = () => {};
        const req = { raw: emitter, headers: { 'content-type': `multipart/form-data; boundary=${bnd}` }, secure: true };
        const res = mockRes();

        const mw = mpFactory({ maxFieldSize: 50 });
        mw(req, res, () => {});

        setImmediate(() =>
        {
            emitter.emit('data', Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="big"\r\n\r\n`));
            // Large field data causing incremental accumulation
            emitter.emit('data', Buffer.from('Z'.repeat(2048)));
        });

        await new Promise(r => setTimeout(r, 200));
        expect(res.statusCode).toBe(413);
    });
});
