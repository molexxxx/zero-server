const http = require('http');
const zlib = require('zlib');
const { doFetch, fetch } = require('../_helpers');
const { createApp, cors, rateLimit, compress, helmet, timeout, requestId, cookieParser } = require('../../');

describe('Helmet Security Headers', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(helmet());
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('X-Content-Type-Options', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('X-Frame-Options', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-frame-options')).toBe('DENY');
    });

    it('X-DNS-Prefetch-Control', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-dns-prefetch-control')).toBe('off');
    });

    it('X-Download-Options', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-download-options')).toBe('noopen');
    });

    it('Referrer-Policy', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('HSTS present', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('strict-transport-security')).not.toBeNull();
    });

    it('CSP present', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('content-security-policy')).not.toBeNull();
    });

    it('X-XSS-Protection disabled by default', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-xss-protection')).toBe('0');
    });
});

describe('Helmet Custom Options', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(helmet({
            frameguard: 'sameorigin', hsts: false, xssFilter: true,
            contentSecurityPolicy: false, referrerPolicy: 'same-origin'
        }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('frameguard=sameorigin', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });

    it('HSTS disabled', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('strict-transport-security')).toBeFalsy();
    });

    it('XSS filter enabled', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-xss-protection')).toBe('1; mode=block');
    });

    it('CSP disabled', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('content-security-policy')).toBeFalsy();
    });

    it('referrer-policy=same-origin', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('referrer-policy')).toBe('same-origin');
    });
});

describe('Timeout Middleware', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(timeout(200));
        app.get('/fast', (req, res) => res.json({ ok: true }));
        app.get('/slow', (req, res) => {
            setTimeout(() => { if (!req.timedOut) res.json({ ok: true }); }, 500);
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('fast request succeeds', async () => {
        const r = await doFetch(`${base}/fast`);
        expect(r.status).toBe(200);
    });

    it('slow request returns 408', async () => {
        const r = await doFetch(`${base}/slow`);
        expect(r.status).toBe(408);
        expect(r.data.error).toBe('Request Timeout');
    });
});

describe('Request ID Middleware', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(requestId());
        app.get('/test', (req, res) => res.json({ id: req.id }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('header set on response', async () => {
        const r = await doFetch(`${base}/test`);
        expect(r.headers.get('x-request-id')).not.toBeNull();
    });

    it('req.id populated', async () => {
        const r = await doFetch(`${base}/test`);
        expect(typeof r.data.id).toBe('string');
        expect(r.data.id.length).toBeGreaterThan(0);
    });

    it('unique per request', async () => {
        const r1 = await doFetch(`${base}/test`);
        const r2 = await doFetch(`${base}/test`);
        expect(r1.data.id).not.toBe(r2.data.id);
    });
});

describe('Request ID trustProxy', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(requestId({ trustProxy: true }));
        app.get('/test', (req, res) => res.json({ id: req.id }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('respects incoming header', async () => {
        const r = await doFetch(`${base}/test`, {
            headers: { 'X-Request-Id': 'my-custom-id-123' }
        });
        expect(r.data.id).toBe('my-custom-id-123');
    });
});

describe('Cookie Parser', () => {
    let server, base;
    const secret = 'test-secret-key';

    beforeAll(async () => {
        const app = createApp();
        app.use(cookieParser(secret));
        app.get('/cookies', (req, res) => {
            res.json({ cookies: req.cookies, signedCookies: req.signedCookies });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses regular cookies', async () => {
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': 'name=alice; theme=dark' }
        });
        expect(r.data.cookies.name).toBe('alice');
        expect(r.data.cookies.theme).toBe('dark');
    });

    it('verifies signed cookie', async () => {
        const signedVal = cookieParser.sign('bob', secret);
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': `user=${encodeURIComponent(signedVal)}; plain=yes` }
        });
        expect(r.data.signedCookies.user).toBe('bob');
        expect(r.data.cookies.plain).toBe('yes');
    });

    it('rejects tampered signed cookie', async () => {
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': `token=${encodeURIComponent('s:secret.invalidsignature')}` }
        });
        expect(r.data.signedCookies?.token).toBeFalsy();
    });

    it('empty when no Cookie header', async () => {
        const r = await doFetch(`${base}/cookies`);
        expect(Object.keys(r.data.cookies).length).toBe(0);
    });
});

describe('CORS Middleware', () => {
    describe('wildcard', () => {
        let server, base;

        beforeAll(async () => {
            const app = createApp();
            app.use(cors());
            app.get('/test', (req, res) => res.json({ ok: true }));
            server = http.createServer(app.handler);
            await new Promise(r => server.listen(0, r));
            base = `http://localhost:${server.address().port}`;
        });

        afterAll(() => server?.close());

        it('wildcard origin', async () => {
            const r = await fetch(`${base}/test`);
            expect(r.headers.get('access-control-allow-origin')).toBe('*');
        });

        it('OPTIONS returns 204', async () => {
            const r = await fetch(`${base}/test`, { method: 'OPTIONS' });
            expect(r.status).toBe(204);
        });
    });

    describe('specific origin with credentials', () => {
        let server, base;

        beforeAll(async () => {
            const app = createApp();
            app.use(cors({ origin: 'http://example.com', credentials: true, exposedHeaders: 'X-Custom', maxAge: 3600 }));
            app.get('/test', (req, res) => res.json({ ok: true }));
            server = http.createServer(app.handler);
            await new Promise(r => server.listen(0, r));
            base = `http://localhost:${server.address().port}`;
        });

        afterAll(() => server?.close());

        it('specific origin set', async () => {
            const r = await fetch(`${base}/test`);
            expect(r.headers.get('access-control-allow-origin')).toBe('http://example.com');
        });

        it('credentials header', async () => {
            const r = await fetch(`${base}/test`);
            expect(r.headers.get('access-control-allow-credentials')).toBe('true');
        });

        it('exposed headers', async () => {
            const r = await fetch(`${base}/test`);
            expect(r.headers.get('access-control-expose-headers')).toBe('X-Custom');
        });

        it('max-age', async () => {
            const r = await fetch(`${base}/test`);
            expect(r.headers.get('access-control-max-age')).toBe('3600');
        });
    });

    describe('array of origins', () => {
        let server, base;

        beforeAll(async () => {
            const app = createApp();
            app.use(cors({ origin: ['http://a.com', 'http://b.com'] }));
            app.get('/test', (req, res) => res.json({ ok: true }));
            server = http.createServer(app.handler);
            await new Promise(r => server.listen(0, r));
            base = `http://localhost:${server.address().port}`;
        });

        afterAll(() => server?.close());

        it('matching origin allowed', async () => {
            const r = await doFetch(`${base}/test`, { headers: { 'Origin': 'http://a.com' } });
            expect(r.headers.get('access-control-allow-origin')).toBe('http://a.com');
        });

        it('non-matching origin rejected', async () => {
            const r = await doFetch(`${base}/test`, { headers: { 'Origin': 'http://evil.com' } });
            expect(r.headers.get('access-control-allow-origin')).toBeFalsy();
        });
    });
});

describe('Rate Limiter', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(rateLimit({ windowMs: 10000, max: 3 }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('first 3 requests succeed', async () => {
        for (let i = 0; i < 3; i++) {
            const r = await fetch(`${base}/test`);
            expect(r.status).toBe(200);
        }
    });

    it('4th request returns 429', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.status).toBe(429);
    });
});

describe('Middleware Chaining & Locals', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use((req, res, next) => {
            req.locals.startTime = Date.now();
            res.locals.fromMiddleware = true;
            next();
        });
        app.get('/locals', (req, res) => {
            res.json({
                hasStartTime: typeof req.locals.startTime === 'number',
                fromMiddleware: res.locals.fromMiddleware
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('req.locals persists through middleware', async () => {
        const r = await doFetch(`${base}/locals`);
        expect(r.data.hasStartTime).toBe(true);
    });

    it('res.locals persists through middleware', async () => {
        const r = await doFetch(`${base}/locals`);
        expect(r.data.fromMiddleware).toBe(true);
    });
});

describe('Compression Edge Cases', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(compress({ threshold: 0 }));
        app.get('/big', (req, res) => res.json({ data: 'x'.repeat(2000) }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('gzip encoding works', async () => {
        const result = await new Promise((resolve, reject) => {
            http.get(`${base}/big`, { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => {
                    zlib.gunzip(Buffer.concat(chunks), (err, decoded) => {
                        if (err) return reject(err);
                        resolve({ body: JSON.parse(decoded.toString()), encoding: resp.headers['content-encoding'] });
                    });
                });
            }).on('error', reject);
        });
        expect(result.encoding).toBe('gzip');
        expect(result.body.data.length).toBe(2000);
    });

    it('no encoding without Accept-Encoding', async () => {
        const result = await new Promise((resolve, reject) => {
            http.get(`${base}/big`, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => resolve({ encoding: resp.headers['content-encoding'] }));
            }).on('error', reject);
        });
        expect(result.encoding).toBeUndefined();
    });
});

// ===========================================================
//  Compression — deflate
// ===========================================================
describe('Compression — deflate', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(compress({ threshold: 0 }));
        app.get('/big', (req, res) => res.json({ data: 'y'.repeat(2000) }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('deflate encoding works', async () => {
        const result = await new Promise((resolve, reject) => {
            http.get(`${base}/big`, { headers: { 'accept-encoding': 'deflate' } }, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => {
                    zlib.inflate(Buffer.concat(chunks), (err, decoded) => {
                        if (err) return reject(err);
                        resolve({ body: JSON.parse(decoded.toString()), encoding: resp.headers['content-encoding'] });
                    });
                });
            }).on('error', reject);
        });
        expect(result.encoding).toBe('deflate');
        expect(result.body.data.length).toBe(2000);
    });
});

// ===========================================================
//  Compression — threshold enforcement
// ===========================================================
describe('Compression — threshold', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(compress({ threshold: 10000 })); // 10KB threshold
        app.get('/small', (req, res) => res.json({ data: 'small' }));
        app.get('/large', (req, res) => res.json({ data: 'x'.repeat(20000) }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('small response is NOT compressed', async () => {
        const result = await new Promise((resolve, reject) => {
            http.get(`${base}/small`, { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => resolve({ encoding: resp.headers['content-encoding'] }));
            }).on('error', reject);
        });
        expect(result.encoding).toBeUndefined();
    });

    it('large response IS compressed', async () => {
        const result = await new Promise((resolve, reject) => {
            http.get(`${base}/large`, { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => resolve({ encoding: resp.headers['content-encoding'] }));
            }).on('error', reject);
        });
        expect(result.encoding).toBe('gzip');
    });
});

// ===========================================================
//  Helmet — COEP, COOP, CORP
// ===========================================================
describe('Helmet — COEP, COOP, CORP', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(helmet({ crossOriginEmbedderPolicy: 'require-corp' }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets COEP when enabled', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    });

    it('COOP defaults to same-origin', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    });

    it('CORP defaults to same-origin', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    });
});

// ===========================================================
//  Helmet — custom CSP
// ===========================================================
describe('Helmet — custom CSP', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'nonce-abc'"] } } }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets custom CSP directives', async () => {
        const r = await fetch(`${base}/test`);
        const csp = r.headers.get('content-security-policy');
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'nonce-abc'");
    });
});

// ===========================================================
//  Helmet — HSTS preload & maxAge
// ===========================================================
describe('Helmet — HSTS options', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(helmet({ hstsPreload: true, hstsMaxAge: 63072000 }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('includes preload directive', async () => {
        const r = await fetch(`${base}/test`);
        const hsts = r.headers.get('strict-transport-security');
        expect(hsts).toContain('preload');
    });

    it('uses custom maxAge', async () => {
        const r = await fetch(`${base}/test`);
        const hsts = r.headers.get('strict-transport-security');
        expect(hsts).toContain('max-age=63072000');
    });
});

// ===========================================================
//  Timeout — custom status and message
// ===========================================================
describe('Timeout — custom status and message', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(timeout(200, { status: 504, message: 'Gateway Timeout' }));
        app.get('/slow', (req, res) => {
            setTimeout(() => { if (!req.timedOut) res.json({ ok: true }); }, 500);
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns custom status on timeout', async () => {
        const r = await doFetch(`${base}/slow`);
        expect(r.status).toBe(504);
    });
});

// ===========================================================
//  Request ID — custom generator
// ===========================================================
describe('Request ID — custom generator', () => {
    let server, base;
    let counter = 0;

    beforeAll(async () => {
        const app = createApp();
        app.use(requestId({ generator: () => `custom-${++counter}` }));
        app.get('/test', (req, res) => res.json({ id: req.id }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('uses custom generator', async () => {
        const r = await doFetch(`${base}/test`);
        expect(r.data.id).toMatch(/^custom-\d+$/);
    });
});

// ===========================================================
//  Request ID — custom header name
// ===========================================================
describe('Request ID — custom header', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(requestId({ header: 'X-Trace-Id' }));
        app.get('/test', (req, res) => res.json({ id: req.id }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('uses custom header name', async () => {
        const r = await doFetch(`${base}/test`);
        expect(r.headers.get('x-trace-id')).toBeTruthy();
    });
});

// ===========================================================
//  Rate Limiter — header values
// ===========================================================
describe('Rate Limiter — headers', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(rateLimit({ windowMs: 60000, max: 5 }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets X-RateLimit-Limit header', async () => {
        const r = await fetch(`${base}/test`);
        expect(r.headers.get('x-ratelimit-limit')).toBe('5');
    });

    it('sets X-RateLimit-Remaining header', async () => {
        const r = await fetch(`${base}/test`);
        const remaining = parseInt(r.headers.get('x-ratelimit-remaining'));
        expect(remaining).toBeLessThanOrEqual(5);
        expect(remaining).toBeGreaterThanOrEqual(0);
    });

    it('sets X-RateLimit-Reset header', async () => {
        const r = await fetch(`${base}/test`);
        const reset = parseInt(r.headers.get('x-ratelimit-reset'));
        expect(reset).toBeGreaterThan(0);
    });

    it('429 response includes Retry-After', async () => {
        // Exhaust remaining requests
        for (let i = 0; i < 10; i++) await fetch(`${base}/test`);
        const r = await fetch(`${base}/test`);
        if (r.status === 429) {
            expect(r.headers.get('retry-after')).toBeTruthy();
        }
    });
});

// ===========================================================
//  CORS — suffix matching
// ===========================================================
describe('CORS — suffix matching', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(cors({ origin: ['.example.com'] }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('allows matching suffix origin', async () => {
        const r = await doFetch(`${base}/test`, { headers: { 'Origin': 'http://app.example.com' } });
        expect(r.headers.get('access-control-allow-origin')).toBe('http://app.example.com');
    });

    it('rejects non-matching suffix', async () => {
        const r = await doFetch(`${base}/test`, { headers: { 'Origin': 'http://evil.com' } });
        expect(r.headers.get('access-control-allow-origin')).toBeFalsy();
    });
});

// ===========================================================
//  CORS — preflight headers
// ===========================================================
describe('CORS — preflight', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(cors({ origin: '*', methods: 'GET,POST,PUT,DELETE' }));
        app.get('/test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('OPTIONS returns allowed methods', async () => {
        const r = await fetch(`${base}/test`, {
            method: 'OPTIONS',
            headers: {
                'Origin': 'http://test.com',
                'Access-Control-Request-Method': 'PUT',
            },
        });
        expect(r.status).toBe(204);
        const methods = r.headers.get('access-control-allow-methods') || '';
        expect(methods).toContain('PUT');
    });
});

// ===========================================================
//  Cookie Parser — decode option
// ===========================================================
describe('Cookie Parser — decode disabled', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use(cookieParser(null, { decode: false }));
        app.get('/cookies', (req, res) => res.json({ cookies: req.cookies }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('skips URI decoding when decode is false', async () => {
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': 'name=hello%20world' }
        });
        expect(r.data.cookies.name).toBe('hello%20world');
    });
});

// ===========================================================
//  Cookie Parser — multiple secrets
// ===========================================================
describe('Cookie Parser — multiple secrets', () => {
    let server, base;
    const secrets = ['new-secret', 'old-secret'];

    beforeAll(async () => {
        const app = createApp();
        app.use(cookieParser(secrets));
        app.get('/cookies', (req, res) => res.json({ signed: req.signedCookies }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('verifies cookie signed with first secret', async () => {
        const signed = cookieParser.sign('val1', secrets[0]);
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': `a=${encodeURIComponent(signed)}` }
        });
        expect(r.data.signed.a).toBe('val1');
    });

    it('verifies cookie signed with second secret (rotation)', async () => {
        const signed = cookieParser.sign('val2', secrets[1]);
        const r = await doFetch(`${base}/cookies`, {
            headers: { 'Cookie': `b=${encodeURIComponent(signed)}` }
        });
        expect(r.data.signed.b).toBe('val2');
    });
});

// ===========================================================
//  Promise-returning middleware error handling
// ===========================================================
describe('Middleware — async error handling', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.onError((err, req, res) => {
            res.status(500).json({ asyncError: err.message });
        });
        app.use(async (req, res, next) => {
            if (req.url.includes('/async-fail')) throw new Error('async boom');
            next();
        });
        app.get('/async-fail', (req, res) => res.json({ ok: true }));
        app.get('/async-ok', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('catches async middleware errors', async () => {
        const r = await doFetch(`${base}/async-fail`);
        expect(r.status).toBe(500);
        expect(r.data.asyncError).toBe('async boom');
    });

    it('async middleware passes normally', async () => {
        const r = await doFetch(`${base}/async-ok`);
        expect(r.data.ok).toBe(true);
    });
});

// ===========================================================
//  Path-scoped middleware
// ===========================================================
describe('Middleware — path-scoped', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.use('/api', (req, res, next) => {
            res.locals.scoped = true;
            res.locals.scopedUrl = req.url; // should have prefix stripped
            next();
        });
        app.get('/api/data', (req, res) => {
            res.json({ scoped: res.locals.scoped, url: res.locals.scopedUrl });
        });
        app.get('/other', (req, res) => {
            res.json({ scoped: res.locals.scoped || false });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('runs for matching path', async () => {
        const r = await doFetch(`${base}/api/data`);
        expect(r.data.scoped).toBe(true);
    });

    it('strips prefix from url', async () => {
        const r = await doFetch(`${base}/api/data`);
        expect(r.data.url).toBe('/data');
    });

    it('does not run for non-matching path', async () => {
        const r = await doFetch(`${base}/other`);
        expect(r.data.scoped).toBe(false);
    });
});


// =========================================================================
//  logger — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  2. LOGGER MIDDLEWARE
// ============================================================
describe('logger middleware', () => {
	it('logs in dev format by default', async () => {
		const { createApp, logger } = require('../../');
		const app = createApp();
		const logged = [];
		app.use(logger({ logger: (msg) => logged.push(msg), colors: false }));
		app.get('/test', (req, res) => res.json({ ok: true }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const base = `http://localhost:${server.address().port}`;

		await fetch(`${base}/test`);
		// Wait for finish event
		await new Promise(r => setTimeout(r, 50));

		expect(logged.length).toBeGreaterThanOrEqual(1);
		const line = logged[0];
		expect(line).toContain('GET');
		expect(line).toContain('/test');
		expect(line).toContain('200');
		expect(line).toMatch(/\d+ms/);
		server.close();
	});

	it('logs in tiny format', async () => {
		const { createApp, logger } = require('../../');
		const app = createApp();
		const logged = [];
		app.use(logger({ logger: (msg) => logged.push(msg), format: 'tiny', colors: false }));
		app.get('/t', (req, res) => res.json({ ok: 1 }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		await fetch(`http://localhost:${server.address().port}/t`);
		await new Promise(r => setTimeout(r, 50));
		expect(logged.length).toBeGreaterThanOrEqual(1);
		// tiny: METHOD URL STATUS - Xms
		expect(logged[0]).toMatch(/^GET \/t 200 - \d+ms$/);
		server.close();
	});

	it('logs in short format with ip', async () => {
		const { createApp, logger } = require('../../');
		const app = createApp();
		const logged = [];
		app.use(logger({ logger: (msg) => logged.push(msg), format: 'short', colors: false }));
		app.get('/s', (req, res) => res.json({ ok: 1 }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		await fetch(`http://localhost:${server.address().port}/s`);
		await new Promise(r => setTimeout(r, 50));
		expect(logged.length).toBeGreaterThanOrEqual(1);
		// short: IP METHOD URL STATUS Xms
		expect(logged[0]).toContain('GET');
		expect(logged[0]).toContain('/s');
		expect(logged[0]).toContain('200');
		server.close();
	});

	it('applies colors for different status ranges', async () => {
		const { createApp, logger } = require('../../');
		const app = createApp();
		const logged = [];
		app.use(logger({ logger: (msg) => logged.push(msg), colors: true, format: 'short' }));
		app.get('/ok', (req, res) => res.json({ ok: 1 }));
		app.get('/redir', (req, res) => res.redirect('/ok'));
		app.get('/fail', (req, res) => res.status(500).json({ e: 1 }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const base = `http://localhost:${server.address().port}`;
		await fetch(`${base}/ok`);
		await fetch(`${base}/fail`);
		await new Promise(r => setTimeout(r, 50));
		// Should have ANSI codes
		expect(logged.some(l => l.includes('\x1b['))).toBe(true);
		server.close();
	});
});

// =========================================================================
//  requestId — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  10. REQUEST ID — GENERATOR, 128-CHAR LIMIT
// ============================================================
describe('requestId — custom generator', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, requestId } = require('../../');
		const app = createApp();
		let counter = 0;
		app.use(requestId({ generator: () => `custom-${++counter}` }));
		app.get('/id', (req, res) => res.json({ id: req.id }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('uses custom generator function', async () => {
		const { data } = await doFetch(`${base}/id`);
		expect(data.id).toMatch(/^custom-\d+$/);
	});
});

describe('requestId — trustProxy and 128-char limit', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, requestId } = require('../../');
		const app = createApp();
		app.use(requestId({ trustProxy: true }));
		app.get('/id', (req, res) => res.json({ id: req.id }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('trusts incoming X-Request-Id header', async () => {
		const { data } = await doFetch(`${base}/id`, {
			headers: { 'x-request-id': 'from-proxy-123' },
		});
		expect(data.id).toBe('from-proxy-123');
	});

	it('rejects X-Request-Id longer than 128 chars', async () => {
		const longId = 'x'.repeat(200);
		const { data } = await doFetch(`${base}/id`, {
			headers: { 'x-request-id': longId },
		});
		expect(data.id).not.toBe(longId);
		expect(data.id.length).toBeLessThanOrEqual(128);
	});
});

// =========================================================================
//  timeout — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  11. TIMEOUT — CUSTOM STATUS
// ============================================================
describe('timeout — custom status code', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, timeout } = require('../../');
		const app = createApp();
		app.use(timeout(100, { status: 504, message: 'Gateway Timeout' }));
		app.get('/slow', async (req, res) => {
			await new Promise(r => setTimeout(r, 500));
			if (!req.timedOut) res.json({ ok: true });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('uses custom status and message', async () => {
		const r = await fetch(`${base}/slow`);
		expect(r.status).toBe(504);
		const body = await r.json();
		expect(body.error).toBe('Gateway Timeout');
	});
});

describe('timeout — timedOut property', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, timeout } = require('../../');
		const app = createApp();
		app.use(timeout(50));
		app.get('/check', async (req, res) => {
			await new Promise(r => setTimeout(r, 200));
			// After timeout, req.timedOut should be true
			res.json({ timedOut: req.timedOut });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('req.timedOut is accessible', async () => {
		const r = await fetch(`${base}/check`);
		expect(r.status).toBe(408);
	});
});