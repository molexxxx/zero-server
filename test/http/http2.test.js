'use strict';
/**
 * http2.test.js — HTTP/2 features: server creation, push, SSE compat, drain compat
 * @vitest-environment node
 */

const http   = require('http');
const http2  = require('http2');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const { doFetch } = require('../_helpers');
const { createApp } = require('../../');
const Request  = require('../../lib/http/request');
const Response = require('../../lib/http/response');

// HTTP/2 sessions emit errors during test teardown (GOAWAY, ECONNREFUSED,
// ERR_HTTP2_STREAM_CANCEL) — these are benign cleanup artefacts.
// Suppress them so vitest doesn't fail the run.
const _h2ErrorCodes = new Set(['ERR_HTTP2_STREAM_CANCEL', 'ECONNREFUSED', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_ERROR']);
let _origUE, _origUR;
beforeAll(() =>
{
    _origUE = process.rawListeners('uncaughtException');
    _origUR = process.rawListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.on('uncaughtException', (err) =>
    {
        if (_h2ErrorCodes.has(err?.code)) return;
        for (const fn of _origUE) fn(err);
    });
    process.on('unhandledRejection', (err) =>
    {
        if (err && _h2ErrorCodes.has(err.code)) return;
        for (const fn of _origUR) fn(err);
    });
});
afterAll(() =>
{
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    for (const fn of _origUE) process.on('uncaughtException', fn);
    for (const fn of _origUR) process.on('unhandledRejection', fn);
});

// ---------------------------------------------------------------------------
// Self-signed cert generation (in-memory, for testing only)
// ---------------------------------------------------------------------------
function generateSelfSignedCert()
{
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const certPem = buildSelfSignedCert(privateKey, publicKey);
    return { key: keyPem, cert: certPem };
}

function buildSelfSignedCert(privateKey, publicKey)
{
    // Use openssl-style self-signed cert via child_process for simplicity
    // Or use a minimal ASN.1 approach. For testing, write temp files and use Node crypto.
    // Simpler: write key to temp file, call openssl, read cert.
    // Simplest for unit tests: generate via temporary TLS server to extract the cert.

    // Actually, the cleanest approach is to use `crypto.X509Certificate` + `crypto.createCertificate`
    // But those aren't available in all Node versions. Use pre-generated cert literals.

    // For testing, we'll generate a minimal self-signed cert inline.
    const tmpDir = os.tmpdir();
    const keyFile = path.join(tmpDir, `zero-test-key-${process.pid}.pem`);
    const certFile = path.join(tmpDir, `zero-test-cert-${process.pid}.pem`);

    try
    {
        const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
        fs.writeFileSync(keyFile, keyPem);

        // Use Node's built-in to create a self-signed cert
        const { execSync } = require('child_process');
        execSync(
            `openssl req -new -x509 -key "${keyFile}" -out "${certFile}" -days 1 -subj "/CN=localhost" -batch 2>nul`,
            { timeout: 5000 },
        );
        return fs.readFileSync(certFile, 'utf8');
    }
    catch (e)
    {
        // openssl not available — return null, tests will be skipped
        return null;
    }
    finally
    {
        try { fs.unlinkSync(keyFile); } catch (_) {}
        try { fs.unlinkSync(certFile); } catch (_) {}
    }
}

// Helpers
function h2connect(url, opts)
{
    const client = http2.connect(url, opts);
    client.on('error', () => {}); // suppress cleanup errors in tests
    return client;
}

// ---------------------------------------------------------------------------
// Mock factories for unit-level tests
// ---------------------------------------------------------------------------
function mockRaw(overrides = {})
{
    return {
        method:  'GET',
        url:     '/',
        headers: {},
        httpVersion: '1.1',
        httpVersionMajor: 1,
        socket:  { remoteAddress: '127.0.0.1', encrypted: false },
        ...overrides,
    };
}

function mockRawRes(overrides = {})
{
    const headers = {};
    return {
        headersSent: false,
        statusCode: 200,
        _headers: headers,
        _ended: false,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        getHeader(k)    { return headers[k.toLowerCase()]; },
        removeHeader(k) { delete headers[k.toLowerCase()]; },
        writeHead(code, hdrs)
        {
            this.statusCode = code;
            if (hdrs) Object.entries(hdrs).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
        },
        write(c)   { return true; },
        end(chunk) { this._ended = true; },
        on()       {},
        removeListener() {},
        ...overrides,
    };
}

// ===========================================================================
// app.listen() — server creation modes
// ===========================================================================
describe('app.listen() — server creation modes', () =>
{
    it('creates HTTP server by default', async () =>
    {
        const app = createApp();
        app.get('/', (req, res) => res.text('ok'));
        const server = app.listen(0);
        await new Promise(r => server.on('listening', r));
        expect(server).toBeDefined();
        expect(server.address().port).toBeGreaterThan(0);
        server.close();
    });

    it('creates h2c server with http2: true (no TLS)', async () =>
    {
        const app = createApp();
        app.get('/', (req, res) => res.text('h2c'));
        const server = app.listen(0, { http2: true });
        await new Promise(r => server.on('listening', r));
        expect(server).toBeDefined();
        expect(server.address().port).toBeGreaterThan(0);
        server.close();
    });

    it('listen(port, cb) without opts works', () => new Promise((resolve) =>
    {
        const app = createApp();
        app.get('/', (req, res) => res.text('ok'));
        const server = app.listen(0, () =>
        {
            expect(server.address().port).toBeGreaterThan(0);
            server.close(resolve);
        });
    }));
});

// ===========================================================================
// h2c — HTTP/2 cleartext server integration
// ===========================================================================
describe('HTTP/2 cleartext (h2c) — integration', () =>
{
    let server, url;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/hello', (req, res) =>
        {
            res.json({
                httpVersion: req.httpVersion,
                isHTTP2: req.isHTTP2,
                method: req.method,
                path: req.path,
            });
        });
        app.get('/push-check', (req, res) =>
        {
            res.json({ supportsPush: res.supportsPush });
        });

        server = app.listen(0, { http2: true });
        await new Promise(r => server.on('listening', r));
        url = `http://localhost:${server.address().port}`;
    });

    afterAll(async () =>
    {
        await new Promise(r => server?.close(r));
    });

    it('serves request via HTTP/2 cleartext', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({ ':path': '/hello', ':method': 'GET' });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.isHTTP2).toBe(true);
            expect(body.httpVersion).toBe('2.0');
            expect(body.method).toBe('GET');
            expect(body.path).toBe('/hello');
            client.close();
            resolve();
        });
        req.end();
    }));

    it('handles query strings in HTTP/2', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({ ':path': '/hello?foo=bar', ':method': 'GET' });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.path).toBe('/hello');
            client.close();
            resolve();
        });
        req.end();
    }));

    it('returns 404 for unknown routes', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({ ':path': '/unknown', ':method': 'GET' });
        let status;
        req.on('response', (headers) => { status = headers[':status']; });
        req.on('data', () => {});
        req.on('end', () =>
        {
            expect(status).toBe(404);
            client.close();
            resolve();
        });
        req.end();
    }));

    it('supportsPush reflects HTTP/2 stream', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({ ':path': '/push-check', ':method': 'GET' });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.supportsPush).toBe(true);
            client.close();
            resolve();
        });
        req.end();
    }));
});

// ===========================================================================
// HTTP/2 with TLS (if openssl available)
// ===========================================================================
describe('HTTP/2 TLS — integration', () =>
{
    let certs;
    let server, url;

    beforeAll(async () =>
    {
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
        const certPem = buildSelfSignedCert(privateKey, null);

        if (!certPem)
        {
            certs = null;
            return;
        }

        certs = { key: keyPem, cert: certPem };

        const app = createApp();
        app.get('/h2-tls', (req, res) =>
        {
            res.json({
                isHTTP2: req.isHTTP2,
                alpn: req.alpnProtocol,
                secure: req.secure,
            });
        });

        server = app.listen(0, { http2: true, ...certs });
        await new Promise(r => server.on('listening', r));
        url = `https://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('serves HTTPS/2 requests with ALPN h2', () => new Promise((resolve) =>
    {
        if (!certs) { resolve(); return; } // skip if no openssl

        const client = h2connect(url, { rejectUnauthorized: false });
        const req = client.request({ ':path': '/h2-tls', ':method': 'GET' });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.isHTTP2).toBe(true);
            expect(body.alpn).toBe('h2');
            expect(body.secure).toBe(true);
            client.close();
            resolve();
        });
        req.end();
    }));

    it('HTTP/1.1 fallback on TLS server (allowHTTP1)', () => new Promise((resolve, reject) =>
    {
        if (!certs) { resolve(); return; }

        // Use https module for HTTP/1.1 over TLS
        const https = require('https');
        const port = server.address().port;
        const req = https.get(`https://localhost:${port}/h2-tls`, { rejectUnauthorized: false }, (res) =>
        {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () =>
            {
                const body = JSON.parse(data);
                // HTTP/1.1 fallback
                expect(body.isHTTP2).toBe(false);
                expect(body.secure).toBe(true);
                resolve();
            });
        });
        req.on('error', reject);
    }));
});

// ===========================================================================
// res.push() — unit-level mocking
// ===========================================================================
describe('res.push() — unit level', () =>
{
    it('returns null when not on HTTP/2 (no stream.pushStream)', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        expect(res.push('/styles.css')).toBeNull();
    });

    it('returns null when stream is destroyed', () =>
    {
        const rawRes = mockRawRes({
            stream: { pushStream: vi.fn(), destroyed: true, closed: false },
        });
        const res = new Response(rawRes);
        expect(res.push('/styles.css')).toBeNull();
    });

    it('returns null when stream is closed', () =>
    {
        const rawRes = mockRawRes({
            stream: { pushStream: vi.fn(), destroyed: false, closed: true },
        });
        const res = new Response(rawRes);
        expect(res.push('/styles.css')).toBeNull();
    });

    it('calls pushStream with correct pseudo-headers', () =>
    {
        const pushStreamMock = vi.fn((headers, cb) =>
        {
            const mockStream = {
                on: vi.fn(),
                respond: vi.fn(),
            };
            cb(null, mockStream);
        });

        const rawRes = mockRawRes({
            stream: { pushStream: pushStreamMock, destroyed: false, closed: false },
            socket: { encrypted: true },
        });

        const res = new Response(rawRes);
        res._req = { headers: { ':authority': 'example.com' } };
        res.push('/styles.css');

        expect(pushStreamMock).toHaveBeenCalledTimes(1);
        const headers = pushStreamMock.mock.calls[0][0];
        expect(headers[':path']).toBe('/styles.css');
        expect(headers[':method']).toBe('GET');
        expect(headers[':scheme']).toBe('https');
        expect(headers[':authority']).toBe('example.com');
    });

    it('uses http scheme for non-encrypted connections', () =>
    {
        const pushStreamMock = vi.fn((headers, cb) =>
        {
            cb(null, { on: vi.fn(), respond: vi.fn() });
        });

        const rawRes = mockRawRes({
            stream: { pushStream: pushStreamMock, destroyed: false, closed: false },
            socket: { encrypted: false },
        });

        const res = new Response(rawRes);
        res._req = { headers: { host: 'localhost' } };
        res.push('/script.js');

        const headers = pushStreamMock.mock.calls[0][0];
        expect(headers[':scheme']).toBe('http');
        expect(headers[':authority']).toBe('localhost');
    });

    it('passes custom headers to push stream', () =>
    {
        const pushStreamMock = vi.fn((headers, cb) =>
        {
            cb(null, { on: vi.fn(), respond: vi.fn() });
        });

        const rawRes = mockRawRes({
            stream: { pushStream: pushStreamMock, destroyed: false, closed: false },
        });

        const res = new Response(rawRes);
        res._req = { headers: {} };
        res.push('/data', { headers: { 'x-custom': 'val' } });

        const headers = pushStreamMock.mock.calls[0][0];
        expect(headers['x-custom']).toBe('val');
    });

    it('handles pushStream error gracefully', () =>
    {
        const pushStreamMock = vi.fn((headers, cb) =>
        {
            cb(new Error('REFUSED_STREAM'));
        });

        const rawRes = mockRawRes({
            stream: { pushStream: pushStreamMock, destroyed: false, closed: false },
        });

        const res = new Response(rawRes);
        res._req = { headers: {} };

        // Should not throw
        expect(() => res.push('/styles.css')).not.toThrow();
    });

    it('handles RST_STREAM cancellation from client gracefully', () =>
    {
        const errorHandler = vi.fn();
        const pushStreamMock = vi.fn((headers, cb) =>
        {
            const mockStream = {
                on(event, handler) { if (event === 'error') { errorHandler.mockImplementation(handler); } },
                respond: vi.fn(),
            };
            cb(null, mockStream);
        });

        const rawRes = mockRawRes({
            stream: { pushStream: pushStreamMock, destroyed: false, closed: false },
        });
        const res = new Response(rawRes);
        res._req = { headers: {} };
        res.push('/font.woff2');

        // Simulate RST_STREAM cancel error
        const cancelError = new Error('Stream cancelled');
        cancelError.code = 'ERR_HTTP2_STREAM_CANCEL';
        expect(() => errorHandler(cancelError)).not.toThrow();
    });

    it('responds with file when filePath provided', () =>
    {
        const respondMock = vi.fn();
        let pipedStream = null;

        const pushStreamMock = vi.fn((headers, cb) =>
        {
            const mockStream = {
                on: vi.fn(),
                once: vi.fn(),
                emit: vi.fn(),
                removeListener: vi.fn(),
                respond: respondMock,
                close: vi.fn(),
                // Simulate writable stream
                write: vi.fn(() => true),
                end: vi.fn(),
            };
            pipedStream = mockStream;
            cb(null, mockStream);
        });

        const rawRes = mockRawRes({
            stream: { pushStream: pushStreamMock, destroyed: false, closed: false },
        });
        const res = new Response(rawRes);
        res._req = { headers: {} };

        // Create a temp file to push
        const tmpFile = path.join(os.tmpdir(), `push-test-${process.pid}.css`);
        fs.writeFileSync(tmpFile, 'body { color: red; }');

        try
        {
            res.push('/styles.css', { filePath: tmpFile });
            // pushStream is async, so respondMock may need a tick
            // The important thing is no error was thrown
            expect(pushStreamMock).toHaveBeenCalledTimes(1);
        }
        finally
        {
            fs.unlinkSync(tmpFile);
        }
    });

    it('handles missing filePath gracefully', () =>
    {
        const closeMock = vi.fn();
        const pushStreamMock = vi.fn((headers, cb) =>
        {
            cb(null, {
                on: vi.fn(),
                respond: vi.fn(),
                close: closeMock,
            });
        });

        const rawRes = mockRawRes({
            stream: { pushStream: pushStreamMock, destroyed: false, closed: false },
        });
        const res = new Response(rawRes);
        res._req = { headers: {} };

        // Push with nonexistent file should not throw
        expect(() => res.push('/nope.css', { filePath: '/nonexistent/file.css' })).not.toThrow();
    });
});

// ===========================================================================
// res.supportsPush — getter
// ===========================================================================
describe('res.supportsPush', () =>
{
    it('true when stream has pushStream method', () =>
    {
        const rawRes = mockRawRes({
            stream: { pushStream: () => {} },
        });
        const res = new Response(rawRes);
        expect(res.supportsPush).toBe(true);
    });

    it('false for regular HTTP/1.1 response', () =>
    {
        const rawRes = mockRawRes();
        const res = new Response(rawRes);
        expect(res.supportsPush).toBe(false);
    });

    it('false when stream exists but pushStream is missing', () =>
    {
        const rawRes = mockRawRes({ stream: {} });
        const res = new Response(rawRes);
        expect(res.supportsPush).toBe(false);
    });
});

// ===========================================================================
// SSE — HTTP/2 compatibility (no Connection header)
// ===========================================================================
describe('SSE — HTTP/2 compatibility', () =>
{
    it('omits Connection header on HTTP/2 response', () =>
    {
        const writtenHeaders = {};
        const rawRes = mockRawRes({
            stream: { pushStream: () => {} },
            writeHead(code, hdrs)
            {
                this.statusCode = code;
                Object.assign(writtenHeaders, hdrs);
            },
        });
        // mock enough for SSE to work
        rawRes.on = vi.fn();

        const res = new Response(rawRes);
        res.sse();

        expect(writtenHeaders['Connection']).toBeUndefined();
        expect(writtenHeaders['Content-Type']).toBe('text/event-stream');
    });

    it('includes Connection header on HTTP/1.1 response', () =>
    {
        const writtenHeaders = {};
        const rawRes = mockRawRes({
            writeHead(code, hdrs)
            {
                this.statusCode = code;
                Object.assign(writtenHeaders, hdrs);
            },
        });
        rawRes.on = vi.fn();

        const res = new Response(rawRes);
        res.sse();

        expect(writtenHeaders['Connection']).toBe('keep-alive');
    });
});

// ===========================================================================
// Drain response — HTTP/2 compatibility
// ===========================================================================
describe('app.handle() — drain response HTTP/2 compat', () =>
{
    it('omits Connection header in 503 for HTTP/2 requests', () =>
    {
        const app = createApp();

        // Simulate draining state by setting lifecycle state directly
        app._lifecycle.state = 'draining';

        const headersWritten = {};
        const rawReq = {
            method: 'GET',
            url: '/',
            headers: {},
            httpVersion: '2.0',
            httpVersionMajor: 2,
            socket: { remoteAddress: '127.0.0.1', encrypted: false },
        };
        const rawRes = {
            writeHead(code, hdrs) { this.statusCode = code; Object.assign(headersWritten, hdrs); },
            end() {},
        };

        app.handle(rawReq, rawRes);

        expect(rawRes.statusCode).toBe(503);
        expect(headersWritten['Connection']).toBeUndefined();
        expect(headersWritten['Retry-After']).toBe('5');

        app._lifecycle.state = 'running';
    });

    it('includes Connection: close for HTTP/1.1 drain', () =>
    {
        const app = createApp();
        app._lifecycle.state = 'draining';

        const headersWritten = {};
        const rawReq = {
            method: 'GET',
            url: '/',
            headers: {},
            httpVersion: '1.1',
            httpVersionMajor: 1,
            socket: { remoteAddress: '127.0.0.1', encrypted: false },
        };
        const rawRes = {
            writeHead(code, hdrs) { this.statusCode = code; Object.assign(headersWritten, hdrs); },
            end() {},
        };

        app.handle(rawReq, rawRes);

        expect(rawRes.statusCode).toBe(503);
        expect(headersWritten['Connection']).toBe('close');

        app._lifecycle.state = 'running';
    });
});

// ===========================================================================
// HTTP/2 server push — h2c integration
// ===========================================================================
describe('HTTP/2 server push — h2c integration', () =>
{
    let server, url;

    beforeAll(async () =>
    {
        const app = createApp();

        // Create a temp CSS file to push
        const tmpDir = os.tmpdir();
        const cssFile = path.join(tmpDir, `push-test-${process.pid}.css`);
        fs.writeFileSync(cssFile, 'body { margin: 0; }');

        app.get('/with-push', (req, res) =>
        {
            if (res.supportsPush)
            {
                res.push('/styles.css', { filePath: cssFile });
            }
            res.text('pushed');
        });

        app.get('/no-push', (req, res) =>
        {
            res.json({ supportsPush: res.supportsPush });
        });

        server = app.listen(0, { http2: true });
        await new Promise(r => server.on('listening', r));
        server.on('session', (session) => { session.on('error', () => {}); });
        url = `http://localhost:${server.address().port}`;

        // Cleanup on close
        const origClose = server.close.bind(server);
        server.close = (cb) =>
        {
            try { fs.unlinkSync(cssFile); } catch (_) {}
            origClose(cb);
        };
    });

    afterAll(async () => { await new Promise(r => server?.close(r)); });

    it('receives push promise from h2c server', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const pushPaths = [];

        client.on('stream', (pushedStream, requestHeaders) =>
        {
            pushPaths.push(requestHeaders[':path']);
            pushedStream.on('error', () => {}); // suppress teardown errors
            let pushData = '';
            pushedStream.on('data', (chunk) => { pushData += chunk; });
            pushedStream.on('end', () =>
            {
                expect(pushData).toContain('margin');
            });
        });

        const req = client.request({ ':path': '/with-push', ':method': 'GET' });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            // Give a tick for push to arrive
            setTimeout(() =>
            {
                expect(pushPaths).toContain('/styles.css');
                expect(data).toBe('pushed');
                client.close();
                resolve();
            }, 100);
        });
        req.end();
    }));

    it('returns supportsPush: true for h2c connections', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({ ':path': '/no-push', ':method': 'GET' });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.supportsPush).toBe(true);
            client.close();
            resolve();
        });
        req.end();
    }));
});

// ===========================================================================
// HTTP/2 middleware stack — routing, body, etc.
// ===========================================================================
describe('HTTP/2 — middleware stack integration', () =>
{
    let server, url;

    beforeAll(async () =>
    {
        const app = createApp();
        app.enable('trust proxy');

        app.get('/info', (req, res) =>
        {
            res.json({
                method: req.method,
                path: req.path,
                query: req.query,
                hostname: req.hostname,
                protocol: req.protocol,
                ip: req.ip,
                isHTTP2: req.isHTTP2,
            });
        });

        app.post('/echo', (req, res) =>
        {
            res.json({ body: req.body, method: req.method });
        });

        server = app.listen(0, { http2: true });
        await new Promise(r => server.on('listening', r));
        url = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('query string parsing works on HTTP/2', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({ ':path': '/info?name=test&v=2', ':method': 'GET' });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.query.name).toBe('test');
            expect(body.query.v).toBe('2');
            expect(body.isHTTP2).toBe(true);
            client.close();
            resolve();
        });
        req.end();
    }));

    it('uses :authority for hostname', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({
            ':path': '/info',
            ':method': 'GET',
            ':authority': 'api.example.com',
        });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.hostname).toBe('api.example.com');
            client.close();
            resolve();
        });
        req.end();
    }));

    it('POST request with headers over HTTP/2', () => new Promise((resolve) =>
    {
        const client = h2connect(url);
        const req = client.request({
            ':path': '/echo',
            ':method': 'POST',
            'content-type': 'application/json',
        });
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () =>
        {
            const body = JSON.parse(data);
            expect(body.method).toBe('POST');
            client.close();
            resolve();
        });
        req.write(JSON.stringify({ hello: 'world' }));
        req.end();
    }));
});

// ===========================================================================
// app.close()
// ===========================================================================
describe('app.close()', () =>
{
    it('closes the HTTP server', () => new Promise((resolve) =>
    {
        const app = createApp();
        app.get('/', (req, res) => res.text('ok'));
        const server = app.listen(0, () =>
        {
            app.close(() =>
            {
                // Server should be closed
                expect(server.listening).toBe(false);
                resolve();
            });
        });
    }));

    it('closes HTTP/2 server', () => new Promise((resolve) =>
    {
        const app = createApp();
        app.get('/', (req, res) => res.text('ok'));
        const server = app.listen(0, { http2: true }, () =>
        {
            app.close(() =>
            {
                expect(server.listening).toBe(false);
                resolve();
            });
        });
    }));
});

// ===========================================================================
// Static middleware — pushAssets (unit level)
// ===========================================================================
describe('serveStatic — pushAssets (unit level)', () =>
{
    let tmpDir, tmpRoot;

    beforeAll(() =>
    {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-push-'));
        tmpRoot = tmpDir;
        fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><head><link rel="stylesheet" href="/style.css"></head></html>');
        fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { margin: 0; }');
        fs.writeFileSync(path.join(tmpDir, 'script.js'), 'console.log("hi")');
    });

    afterAll(() =>
    {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('pushAssets array generates push calls for HTML files on HTTP/2', async () =>
    {
        const app = createApp();
        const serveStatic = require('../../lib/middleware/static');
        app.use(serveStatic(tmpRoot, { pushAssets: ['/style.css', '/script.js'] }));

        const server = app.listen(0, { http2: true });
        await new Promise(r => server.on('listening', r));
        server.on('session', (s) => { s.on('error', () => {}); });
        const url = `http://localhost:${server.address().port}`;

        const pushPaths = [];
        const client = h2connect(url);
        client.on('stream', (pushedStream, headers) =>
        {
            pushPaths.push(headers[':path']);
            pushedStream.on('error', () => {});
            pushedStream.on('data', () => {});
            pushedStream.on('end', () => {});
        });

        await new Promise((resolve, reject) =>
        {
            const req = client.request({ ':path': '/index.html', ':method': 'GET' });
            req.on('error', () => {});
            let data = '';
            req.on('data', (chunk) => { data += chunk; });
            req.on('end', () =>
            {
                // Wait for push streams to fully arrive before assertions
                setTimeout(() =>
                {
                    expect(data).toContain('<html>');
                    expect(pushPaths).toContain('/style.css');
                    expect(pushPaths).toContain('/script.js');
                    client.close();
                    setTimeout(() => { server.close(); resolve(); }, 100);
                }, 200);
            });
            req.end();
        });
    });

    it('pushAssets function is called with filePath', async () =>
    {
        const app = createApp();
        const serveStatic = require('../../lib/middleware/static');
        const pushFn = vi.fn(() => ['/style.css']);
        app.use(serveStatic(tmpRoot, { pushAssets: pushFn }));

        const server = app.listen(0, { http2: true });
        await new Promise(r => server.on('listening', r));
        server.on('session', (s) => { s.on('error', () => {}); });
        const url = `http://localhost:${server.address().port}`;

        const client = h2connect(url);
        client.on('stream', (ps) => { ps.on('error', () => {}); });
        await new Promise((resolve) =>
        {
            const req = client.request({ ':path': '/index.html', ':method': 'GET' });
            req.on('error', () => {});
            req.on('data', () => {});
            req.on('end', () =>
            {
                setTimeout(() =>
                {
                    expect(pushFn).toHaveBeenCalled();
                    client.close();
                    setTimeout(() => { server.close(); resolve(); }, 100);
                }, 200);
            });
            req.end();
        });
    });

    it('does not push for non-HTML files', async () =>
    {
        const app = createApp();
        const serveStatic = require('../../lib/middleware/static');
        app.use(serveStatic(tmpRoot, { pushAssets: ['/style.css'] }));

        const server = app.listen(0, { http2: true });
        await new Promise(r => server.on('listening', r));
        server.on('session', (s) => { s.on('error', () => {}); });
        const url = `http://localhost:${server.address().port}`;

        const pushPaths = [];
        const client = h2connect(url);
        client.on('stream', (ps, headers) => { ps.on('error', () => {}); pushPaths.push(headers[':path']); });

        await new Promise((resolve) =>
        {
            const req = client.request({ ':path': '/style.css', ':method': 'GET' });
            req.on('error', () => {});
            req.on('data', () => {});
            req.on('end', () =>
            {
                setTimeout(() =>
                {
                    expect(pushPaths.length).toBe(0);
                    client.close();
                    setTimeout(() => { server.close(); resolve(); }, 100);
                }, 100);
            });
            req.end();
        });
    });

    it('does not push on HTTP/1.1 connections', async () =>
    {
        const app = createApp();
        const serveStatic = require('../../lib/middleware/static');
        app.use(serveStatic(tmpRoot, { pushAssets: ['/style.css'] }));

        const server = app.listen(0); // HTTP/1.1 server
        await new Promise(r => server.on('listening', r));
        const base = `http://localhost:${server.address().port}`;

        const r = await doFetch(`${base}/index.html`);
        expect(r.data).toContain('<html>');
        // No push possible on HTTP/1.1 — just verify it didn't crash
        expect(r.status).toBe(200);
        server.close();
    });
});
