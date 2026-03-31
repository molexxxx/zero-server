const http = require('http');
const fs = require('fs');
const path = require('path');
const { doFetch, fetch } = require('../_helpers');
const { createApp, static: staticMid } = require('../../');

describe('Static File Security', () => {
    let server, base;
    const staticDir = path.join(__dirname, 'static-sec');

    beforeAll(async () => {
        fs.mkdirSync(staticDir, { recursive: true });
        fs.writeFileSync(path.join(staticDir, 'hello.txt'), 'hello world');
        fs.writeFileSync(path.join(staticDir, '.hidden'), 'secret');

        const app = createApp();
        app.use('/files', staticMid(staticDir));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(staticDir, { recursive: true, force: true }); } catch {}
    });

    it('serves normal files', async () => {
        const r = await doFetch(`${base}/files/hello.txt`);
        expect(r.data).toBe('hello world');
    });

    it('blocks path traversal ../', async () => {
        const r = await doFetch(`${base}/files/../package.json`);
        expect([403, 404]).toContain(r.status);
    });

    it('blocks encoded ../', async () => {
        const r = await doFetch(`${base}/files/%2e%2e/package.json`);
        expect([403, 404]).toContain(r.status);
    });

    it('null byte returns 400', async () => {
        const r = await doFetch(`${base}/files/hello.txt%00.jpg`);
        expect(r.status).toBe(400);
    });

    it('dotfiles ignored by default', async () => {
        const r = await doFetch(`${base}/files/.hidden`);
        expect(r.status).toBe(404);
    });

    it('404 for missing file', async () => {
        const r = await doFetch(`${base}/files/doesnotexist.txt`);
        expect(r.status).toBe(404);
    });
});

// ===========================================================
//  Directory index.html
// ===========================================================
describe('Static — directory index', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-index');

    beforeAll(async () => {
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), '<h1>root</h1>');
        fs.writeFileSync(path.join(dir, 'sub', 'index.html'), '<h1>sub</h1>');

        const app = createApp();
        app.use('/site', staticMid(dir));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('serves index.html for root directory', async () => {
        const r = await doFetch(`${base}/site/`);
        expect(r.data).toContain('<h1>root</h1>');
    });

    it('serves index.html for subdirectory', async () => {
        const r = await doFetch(`${base}/site/sub/`);
        expect(r.data).toContain('<h1>sub</h1>');
    });
});

// ===========================================================
//  index: false disables directory index
// ===========================================================
describe('Static — index: false', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-noindex');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), '<h1>no</h1>');

        const app = createApp();
        app.use('/site', staticMid(dir, { index: false }));
        app.get('/site', (req, res) => res.json({ fallthrough: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('does not serve index.html when disabled', async () => {
        const r = await doFetch(`${base}/site/`);
        // Should fall through to the next handler
        expect(r.data.fallthrough).toBe(true);
    });
});

// ===========================================================
//  Extension fallbacks
// ===========================================================
describe('Static — extension fallbacks', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-ext');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'page.html'), '<h1>page</h1>');
        fs.writeFileSync(path.join(dir, 'data.json'), '{"k":1}');

        const app = createApp();
        app.use('/s', staticMid(dir, { extensions: ['html', 'json'] }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('serves file without extension using .html fallback', async () => {
        const r = await doFetch(`${base}/s/page`);
        expect(r.data).toContain('<h1>page</h1>');
    });

    it('serves file without extension using .json fallback', async () => {
        const r = await doFetch(`${base}/s/data`);
        expect(r.data).toEqual({ k: 1 });
    });

    it('404 when no extension matches', async () => {
        const r = await doFetch(`${base}/s/missing`);
        expect(r.status).toBe(404);
    });
});

// ===========================================================
//  maxAge Cache-Control header
// ===========================================================
describe('Static — maxAge', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-cache');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'cached.txt'), 'data');

        const app = createApp();
        app.use('/c', staticMid(dir, { maxAge: 86400000 })); // 1 day in ms
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('sets Cache-Control with max-age in seconds', async () => {
        const r = await fetch(`${base}/c/cached.txt`);
        expect(r.headers.get('cache-control')).toBe('max-age=86400');
    });
});

// ===========================================================
//  setHeaders hook
// ===========================================================
describe('Static — setHeaders hook', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-headers');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'file.txt'), 'hello');

        const app = createApp();
        app.use('/h', staticMid(dir, {
            setHeaders: (res, filePath) => {
                res.raw.setHeader('X-Custom-Static', 'yes');
                res.raw.setHeader('X-File', path.basename(filePath));
            }
        }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('custom headers set via hook', async () => {
        const r = await fetch(`${base}/h/file.txt`);
        expect(r.headers.get('x-custom-static')).toBe('yes');
        expect(r.headers.get('x-file')).toBe('file.txt');
    });
});

// ===========================================================
//  Dotfiles: deny returns 403
// ===========================================================
describe('Static — dotfiles: deny', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-dotdeny');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.env'), 'SECRET=value');
        fs.writeFileSync(path.join(dir, 'ok.txt'), 'public');

        const app = createApp();
        app.use('/d', staticMid(dir, { dotfiles: 'deny' }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('returns 403 for dotfiles', async () => {
        const r = await doFetch(`${base}/d/.env`);
        expect(r.status).toBe(403);
    });

    it('normal files still served', async () => {
        const r = await doFetch(`${base}/d/ok.txt`);
        expect(r.data).toBe('public');
    });
});

// ===========================================================
//  Dotfiles: allow serves dotfiles
// ===========================================================
describe('Static — dotfiles: allow', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-dotallow');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.config'), 'visible');

        const app = createApp();
        app.use('/a', staticMid(dir, { dotfiles: 'allow' }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('serves dotfiles when allowed', async () => {
        const r = await doFetch(`${base}/a/.config`);
        expect(r.data).toBe('visible');
    });
});

// ===========================================================
//  MIME type detection
// ===========================================================
describe('Static — MIME types', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-mime');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'style.css'), 'body{}');
        fs.writeFileSync(path.join(dir, 'app.js'), 'var x;');
        fs.writeFileSync(path.join(dir, 'data.json'), '{}');
        fs.writeFileSync(path.join(dir, 'page.html'), '<p>html</p>');

        const app = createApp();
        app.use('/m', staticMid(dir));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('CSS gets text/css', async () => {
        const r = await fetch(`${base}/m/style.css`);
        expect(r.headers.get('content-type')).toContain('text/css');
    });

    it('JS gets application/javascript', async () => {
        const r = await fetch(`${base}/m/app.js`);
        expect(r.headers.get('content-type')).toContain('application/javascript');
    });

    it('JSON gets application/json', async () => {
        const r = await fetch(`${base}/m/data.json`);
        expect(r.headers.get('content-type')).toContain('application/json');
    });

    it('HTML gets text/html', async () => {
        const r = await fetch(`${base}/m/page.html`);
        expect(r.headers.get('content-type')).toContain('text/html');
    });
});

// ===========================================================
//  HEAD requests — static files
// ===========================================================
describe('Static — HEAD requests', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-head');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'data.txt'), 'some content');

        const app = createApp();
        app.use('/h', staticMid(dir));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('HEAD returns headers with content-length', async () => {
        const r = await fetch(`${base}/h/data.txt`, { method: 'HEAD' });
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toContain('text/plain');
        expect(parseInt(r.headers.get('content-length'))).toBeGreaterThan(0);
    });
});

// ===========================================================
//  POST/PUT passthrough (non-GET/HEAD)
// ===========================================================
describe('Static — non-GET/HEAD passthrough', () => {
    let server, base;
    const dir = path.join(__dirname, 'static-methods');

    beforeAll(async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'file.txt'), 'data');

        const app = createApp();
        app.use('/s', staticMid(dir));
        app.post('/s/file.txt', (req, res) => res.json({ posted: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => {
        server?.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('POST passes through to next handler', async () => {
        const r = await doFetch(`${base}/s/file.txt`, { method: 'POST' });
        expect(r.data.posted).toBe(true);
    });
});

// =========================================================================
//  Static — ETag, Last-Modified, 304, Range (from audit)
// =========================================================================

describe('Static file serving — ETag, Last-Modified, Range', () =>
{
    let server, base;
    const testDir = path.join(__dirname, '_static_test');
    const testFile = path.join(testDir, 'test.txt');

    beforeAll(async () =>
    {
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(testFile, 'Hello, World! This is a test file for range requests.');

        const serveStatic = require('../../lib/middleware/static');
        const app = createApp();
        app.use(serveStatic(testDir));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() =>
    {
        server?.close();
        try { fs.rmSync(testDir, { recursive: true }); } catch (e) { }
    });

    it('responds with ETag header', async () =>
    {
        const r = await doFetch(`${base}/test.txt`);
        expect(r.status).toBe(200);
        expect(r.headers.get('etag')).toBeTruthy();
        expect(r.headers.get('etag')).toMatch(/^W\//);
    });

    it('responds with Last-Modified header', async () =>
    {
        const r = await doFetch(`${base}/test.txt`);
        expect(r.headers.get('last-modified')).toBeTruthy();
    });

    it('responds with Accept-Ranges header', async () =>
    {
        const r = await doFetch(`${base}/test.txt`);
        expect(r.headers.get('accept-ranges')).toBe('bytes');
    });

    it('returns 304 for matching If-None-Match', async () =>
    {
        const r1 = await doFetch(`${base}/test.txt`);
        const etag = r1.headers.get('etag');
        expect(etag).toBeTruthy();

        const r2 = await doFetch(`${base}/test.txt`, {
            headers: { 'if-none-match': etag },
        });
        expect(r2.status).toBe(304);
    });

    it('returns 304 for matching If-Modified-Since', async () =>
    {
        const r1 = await doFetch(`${base}/test.txt`);
        const lastMod = r1.headers.get('last-modified');
        expect(lastMod).toBeTruthy();

        const futureDate = new Date(Date.now() + 86400000).toUTCString();
        const r2 = await doFetch(`${base}/test.txt`, {
            headers: { 'if-modified-since': futureDate },
        });
        expect(r2.status).toBe(304);
    });

    it('handles Range request with byte range', async () =>
    {
        const r = await doFetch(`${base}/test.txt`, {
            headers: { 'range': 'bytes=0-4' },
        });
        expect(r.status).toBe(206);
        expect(r.data).toBe('Hello');
        expect(r.headers.get('content-range')).toMatch(/^bytes 0-4\//);
    });

    it('handles Range request with suffix range', async () =>
    {
        const r = await doFetch(`${base}/test.txt`, {
            headers: { 'range': 'bytes=-5' },
        });
        expect(r.status).toBe(206);
        expect(r.data).toBe('ests.');
    });

    it('returns 416 for invalid range', async () =>
    {
        const r = await doFetch(`${base}/test.txt`, {
            headers: { 'range': 'bytes=9999-99999' },
        });
        expect(r.status).toBe(416);
    });
});
