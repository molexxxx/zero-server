/**
 * Tests for the full codebase audit fixes.
 * Covers security, performance, and feature improvements.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { doFetch } = require('./_helpers');
const { createApp, json, urlencoded, cors, csrf, rateLimit, Router } = require('../');

// =========================================================================
//  CORS — credentials + wildcard validation
// =========================================================================

describe('CORS credentials + wildcard validation', () =>
{
    it('throws when credentials used with wildcard origin', () =>
    {
        expect(() => cors({ origin: '*', credentials: true }))
            .toThrow('CORS credentials cannot be used with wildcard origin');
    });

    it('allows credentials with explicit origin', () =>
    {
        expect(() => cors({ origin: 'https://example.com', credentials: true }))
            .not.toThrow();
    });

    it('allows credentials with array of origins', () =>
    {
        expect(() => cors({ origin: ['https://a.com', 'https://b.com'], credentials: true }))
            .not.toThrow();
    });

    it('allows wildcard without credentials', () =>
    {
        expect(() => cors({ origin: '*' })).not.toThrow();
    });
});

// =========================================================================
//  JSON Parser — prototype pollution protection
// =========================================================================

describe('JSON Parser prototype pollution protection', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());
        app.post('/json', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('strips __proto__ from parsed JSON', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: '{"__proto__": {"admin": true}, "safe": 1}',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.safe).toBe(1);
        // __proto__ key should have been removed during sanitization
        expect(Object.keys(r.data.body)).not.toContain('__proto__');
        // Verify Object.prototype not polluted
        expect({}.admin).toBeUndefined();
    });

    it('strips constructor from parsed JSON', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: '{"constructor": {"prototype": {"pwned": true}}, "ok": 1}',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.ok).toBe(1);
    });

    it('strips nested __proto__ keys', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: '{"data": {"nested": {"__proto__": {"x": 1}}, "ok": true}}',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.data.nested).toBeDefined();
        expect(r.data.body.data.ok).toBe(true);
    });

    it('strict mode rejects primitives with 400', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: '"hello"',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(400);
    });

    it('strict mode rejects null with 400', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: 'null',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(400);
    });

    it('strict mode allows arrays', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: '[1, 2, 3]',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body).toEqual([1, 2, 3]);
    });

    it('strict mode allows objects', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: '{"key": "value"}',
            headers: { 'content-type': 'application/json' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.key).toBe('value');
    });
});

// =========================================================================
//  typeMatch — charset stripping
// =========================================================================

describe('typeMatch charset handling', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());
        app.post('/json', (req, res) => res.json({ body: req.body }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('matches content-type with charset parameter', async () =>
    {
        const r = await doFetch(`${base}/json`, {
            method: 'POST',
            body: '{"ok": true}',
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
        expect(r.status).toBe(200);
        expect(r.data.body.ok).toBe(true);
    });
});

// =========================================================================
//  Query parameter limit
// =========================================================================

describe('Query parameter limit', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/q', (req, res) => res.json({ count: Object.keys(req.query).length, query: req.query }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses normal query parameters', async () =>
    {
        const r = await doFetch(`${base}/q?a=1&b=2&c=3`);
        expect(r.data.count).toBe(3);
        expect(r.data.query.a).toBe('1');
    });

    it('limits query parameters to 100', async () =>
    {
        const params = Array.from({ length: 150 }, (_, i) => `p${i}=${i}`).join('&');
        const r = await doFetch(`${base}/q?${params}`);
        expect(r.data.count).toBe(100);
    });

    it('handles malformed URI components gracefully', async () =>
    {
        const r = await doFetch(`${base}/q?ok=1&bad=%zz&good=2`);
        expect(r.data.query.ok).toBe('1');
        expect(r.data.query.good).toBe('2');
    });
});

// =========================================================================
//  Static — ETag, Last-Modified, 304, Range
// =========================================================================

describe('Static file serving — ETag, Last-Modified, Range', () =>
{
    let server, base;
    const testDir = path.join(__dirname, '_static_test');
    const testFile = path.join(testDir, 'test.txt');

    beforeAll(async () =>
    {
        // Create test directory and file
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(testFile, 'Hello, World! This is a test file for range requests.');

        const serveStatic = require('../lib/middleware/static');
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
        // First request to get ETag
        const r1 = await doFetch(`${base}/test.txt`);
        const etag = r1.headers.get('etag');
        expect(etag).toBeTruthy();

        // Second request with ETag
        const r2 = await doFetch(`${base}/test.txt`, {
            headers: { 'if-none-match': etag },
        });
        expect(r2.status).toBe(304);
    });

    it('returns 304 for matching If-Modified-Since', async () =>
    {
        // Get Last-Modified
        const r1 = await doFetch(`${base}/test.txt`);
        const lastMod = r1.headers.get('last-modified');
        expect(lastMod).toBeTruthy();

        // Request with future date
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

// =========================================================================
//  Rate Limiter — skip and handler options
// =========================================================================

describe('Rate Limiter — skip and handler options', () =>
{
    it('skip function bypasses rate limiting', async () =>
    {
        const app = createApp();
        app.use(rateLimit({
            windowMs: 5000,
            max: 1,
            skip: (req) => req.url.includes('/health'),
        }));
        app.get('/health', (req, res) => res.json({ ok: true }));
        app.get('/api', (req, res) => res.json({ ok: true }));

        const server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        const base = `http://localhost:${server.address().port}`;

        // First /api call should pass
        const r1 = await doFetch(`${base}/api`);
        expect(r1.status).toBe(200);

        // Second /api call should fail
        const r2 = await doFetch(`${base}/api`);
        expect(r2.status).toBe(429);

        // /health should always pass (skipped)
        const r3 = await doFetch(`${base}/health`);
        expect(r3.status).toBe(200);
        const r4 = await doFetch(`${base}/health`);
        expect(r4.status).toBe(200);

        server.close();
    });

    it('custom handler overrides default response', async () =>
    {
        const app = createApp();
        app.use(rateLimit({
            windowMs: 5000,
            max: 1,
            handler: (req, res) => res.status(503).json({ custom: 'overloaded' }),
        }));
        app.get('/api', (req, res) => res.json({ ok: true }));

        const server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        const base = `http://localhost:${server.address().port}`;

        await doFetch(`${base}/api`);
        const r2 = await doFetch(`${base}/api`);
        expect(r2.status).toBe(503);
        expect(r2.data.custom).toBe('overloaded');

        server.close();
    });
});

// =========================================================================
//  CSRF — Secure flag on HTTPS cookies
// =========================================================================

describe('CSRF Secure flag', () =>
{
    it('includes Secure flag in Set-Cookie for HTTPS requests', async () =>
    {
        const csrfMiddleware = csrf();
        const req = {
            method: 'GET',
            secure: true,
            url: '/page',
            headers: {},
            cookies: {},
            query: {},
        };
        const headers = {};
        const res = {
            set: (name, value) => { headers[name] = value; },
        };
        let nextCalled = false;
        csrfMiddleware(req, res, () => { nextCalled = true; });

        expect(nextCalled).toBe(true);
        expect(headers['Set-Cookie']).toContain('Secure');
    });

    it('omits Secure flag for HTTP requests', async () =>
    {
        const csrfMiddleware = csrf();
        const req = {
            method: 'GET',
            secure: false,
            url: '/page',
            headers: {},
            cookies: {},
            query: {},
        };
        const headers = {};
        const res = {
            set: (name, value) => { headers[name] = value; },
        };
        csrfMiddleware(req, res, () => {});
        expect(headers['Set-Cookie']).not.toContain('Secure');
    });
});

// =========================================================================
//  Router — refactored _matchAndExecute works correctly
// =========================================================================

describe('Router refactored matching', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();

        // Test param extraction with indexed for loop
        app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
        app.get('/files/*', (req, res) => res.json({ path: req.params['0'] }));

        // Test child router mounting
        const api = Router();
        api.get('/items', (req, res) => res.json({ items: true }));
        api.get('/items/:id', (req, res) => res.json({ itemId: req.params.id }));
        app.use('/api', api);

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('extracts named params correctly', async () =>
    {
        const r = await doFetch(`${base}/users/42`);
        expect(r.data.id).toBe('42');
    });

    it('extracts wildcard params correctly', async () =>
    {
        const r = await doFetch(`${base}/files/a/b/c.txt`);
        expect(r.data.path).toBe('a/b/c.txt');
    });

    it('routes to child router correctly', async () =>
    {
        const r = await doFetch(`${base}/api/items`);
        expect(r.data.items).toBe(true);
    });

    it('extracts child router params correctly', async () =>
    {
        const r = await doFetch(`${base}/api/items/99`);
        expect(r.data.itemId).toBe('99');
    });

    it('returns 404 for unmatched routes', async () =>
    {
        const r = await doFetch(`${base}/nonexistent`);
        expect(r.status).toBe(404);
    });
});

// =========================================================================
//  Response — performance-optimized send
// =========================================================================

describe('Response send optimizations', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/html', (req, res) => res.send('<h1>Hello</h1>'));
        app.get('/text', (req, res) => res.send('plain text'));
        app.get('/whitespace-html', (req, res) => res.send('  \n  <div>indented</div>'));
        app.get('/json', (req, res) => res.send({ key: 'value' }));
        app.get('/buffer', (req, res) => res.send(Buffer.from('binary')));
        app.get('/null', (req, res) => res.send(null));
        app.get('/download', (req, res) => res.download(__filename));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('auto-detects HTML content type', async () =>
    {
        const r = await doFetch(`${base}/html`);
        expect(r.headers.get('content-type')).toBe('text/html');
    });

    it('auto-detects plain text content type', async () =>
    {
        const r = await doFetch(`${base}/text`);
        expect(r.headers.get('content-type')).toBe('text/plain');
    });

    it('detects HTML even with leading whitespace', async () =>
    {
        const r = await doFetch(`${base}/whitespace-html`);
        expect(r.headers.get('content-type')).toBe('text/html');
    });

    it('sends JSON with correct Content-Type', async () =>
    {
        const r = await doFetch(`${base}/json`);
        expect(r.headers.get('content-type')).toBe('application/json');
        expect(r.data.key).toBe('value');
    });

    it('sends Buffer with octet-stream', async () =>
    {
        const r = await doFetch(`${base}/buffer`);
        expect(r.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('sends null/empty response', async () =>
    {
        const r = await doFetch(`${base}/null`);
        expect(r.status).toBe(200);
    });

    it('download sets Content-Disposition', async () =>
    {
        const r = await doFetch(`${base}/download`);
        expect(r.headers.get('content-disposition')).toContain('attachment');
        expect(r.headers.get('content-disposition')).toContain('audit-fixes.test.js');
    });
});

// =========================================================================
//  Request.accepts optimization
// =========================================================================

describe('Request.accepts', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/accept', (req, res) =>
        {
            const best = req.accepts('json', 'html', 'text');
            res.json({ best });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns first type for wildcard accept', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': '*/*' },
        });
        expect(r.data.best).toBe('json');
    });

    it('matches specific MIME types', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': 'text/html' },
        });
        expect(r.data.best).toBe('html');
    });

    it('matches type/* wildcards', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': 'text/*' },
        });
        // 'html' resolves to 'text/html', 'text' to 'text/plain'
        // accept text/* should match 'html' first
        expect(r.data.best).toBe('html');
    });

    it('returns false for no match', async () =>
    {
        const r = await doFetch(`${base}/accept`, {
            headers: { 'accept': 'image/png' },
        });
        expect(r.data.best).toBe(false);
    });
});

// =========================================================================
//  Compress — quality value negotiation
// =========================================================================

describe('Compress quality negotiation', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const compress = require('../lib/middleware/compress');
        const app = createApp();
        app.use(compress({ threshold: 0 }));
        app.get('/data', (req, res) =>
        {
            res.json({ data: 'a'.repeat(2000) });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    function rawGet(url, headers)
    {
        return new Promise((resolve) =>
        {
            const u = new URL(url);
            http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) =>
            {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
            });
        });
    }

    it('prefers br when quality is higher', async () =>
    {
        const r = await rawGet(`${base}/data`, { 'accept-encoding': 'gzip;q=0.5, br;q=1.0' });
        expect(r.headers['content-encoding']).toBe('br');
    });

    it('prefers gzip when br has q=0', async () =>
    {
        const r = await rawGet(`${base}/data`, { 'accept-encoding': 'br;q=0, gzip;q=1.0' });
        expect(r.headers['content-encoding']).toBe('gzip');
    });

    it('skips compression when all q=0', async () =>
    {
        const r = await rawGet(`${base}/data`, { 'accept-encoding': 'gzip;q=0, br;q=0, deflate;q=0' });
        expect(r.headers['content-encoding']).toBeUndefined();
    });
});

// =========================================================================
//  SSE comment newline escaping
// =========================================================================

describe('SSE comment newline safety', () =>
{
    it('escapes newlines in comments to prevent injection', (done) =>
    {
        const app = createApp();
        app.get('/sse', (req, res) =>
        {
            const stream = res.sse();
            stream.comment('line1\ndata: injected');
            stream.send('real data');
            setTimeout(() => stream.close(), 50);
        });

        const server = http.createServer(app.handler);
        server.listen(0, () =>
        {
            const port = server.address().port;
            http.get(`http://localhost:${port}/sse`, (res) =>
            {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () =>
                {
                    // The comment should have escaped newlines
                    // Should be ": line1\n: data: injected\n\n" not ": line1\ndata: injected\n\n"
                    expect(body).toContain(': line1\n: data: injected');
                    expect(body).toContain('data: real data');
                    server.close();
                    done();
                });
            });
        });
    });
});

// =========================================================================
//  Locals prototype chain optimization
// =========================================================================

describe('App locals prototype chain', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.locals.appName = 'TestApp';
        app.locals.version = '1.0';

        app.get('/locals', (req, res) =>
        {
            // Request locals should inherit from app.locals via prototype chain
            req.locals.requestSpecific = 'yes';
            res.json({
                appName: req.locals.appName,
                version: req.locals.version,
                requestSpecific: req.locals.requestSpecific,
                // Verify mutation doesn't affect parent
                hasOwn: Object.prototype.hasOwnProperty.call(req.locals, 'appName'),
            });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('inherits app.locals via prototype chain', async () =>
    {
        const r = await doFetch(`${base}/locals`);
        expect(r.data.appName).toBe('TestApp');
        expect(r.data.version).toBe('1.0');
        expect(r.data.requestSpecific).toBe('yes');
        // appName comes from prototype, not own property
        expect(r.data.hasOwn).toBe(false);
    });
});

// =========================================================================
//  sendError — headersSent check
// =========================================================================

describe('sendError headersSent safety', () =>
{
    it('does not throw when headers already sent', () =>
    {
        const sendError = require('../lib/body/sendError');
        const mockRes = {
            headersSent: true,
            statusCode: 200,
            setHeader: () => { throw new Error('should not be called'); },
            end: () => { throw new Error('should not be called'); },
        };

        // Should not throw
        expect(() => sendError(mockRes, 400, 'test')).not.toThrow();
    });
});
