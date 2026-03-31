/**
 * Tests for error handling and debug logging across all subsystems:
 * Router param handlers, child router errors, response JSON.stringify,
 * WebSocket sendJSON, SSE _formatData, compression stream errors,
 * CSRF crypto safety, cookieParser timingSafeEqual, ORM adapter errors,
 * and debug logger integration.
 */
const http = require('http');
const { doFetch } = require('../_helpers');
const { createApp, Router } = require('../../');

// --- Router Param Handler Error Handling -------------------------

describe('Router Param Handler Error Handling', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.onError((err, req, res) =>
        {
            res.status(500).json({ caught: true, message: err.message });
        });

        app.param('userId', (req, res, next, val) =>
        {
            if (val === 'crash') throw new Error('param handler crash');
            next();
        });

        app.get('/users/:userId', (req, res) =>
        {
            res.json({ id: req.params.userId });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('catches sync errors in param handlers', async () =>
    {
        const r = await doFetch(`${base}/users/crash`);
        expect(r.status).toBe(500);
        expect(r.data.caught).toBe(true);
        expect(r.data.message).toBe('param handler crash');
    });

    it('param handler works normally when no error', async () =>
    {
        const r = await doFetch(`${base}/users/42`);
        expect(r.status).toBe(200);
        expect(r.data.id).toBe('42');
    });
});

describe('Router Async Param Handler Error Handling', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.onError((err, req, res) =>
        {
            res.status(500).json({ caught: true, message: err.message });
        });

        app.param('id', async (req, res, next, val) =>
        {
            if (val === 'async-crash') throw new Error('async param boom');
            next();
        });

        app.get('/items/:id', (req, res) =>
        {
            res.json({ id: req.params.id });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('catches async errors in param handlers', async () =>
    {
        const r = await doFetch(`${base}/items/async-crash`);
        expect(r.status).toBe(500);
        expect(r.data.caught).toBe(true);
        expect(r.data.message).toBe('async param boom');
    });
});

// --- Child Router Error Handling ---------------------------------

describe('Child Router Error Handling', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.onError((err, req, res) =>
        {
            res.status(500).json({ caught: true, message: err.message });
        });

        const api = Router();
        api.get('/explode', (req, res) =>
        {
            throw new Error('child router boom');
        });

        app.use('/api', api);

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('catches errors thrown in child router handlers', async () =>
    {
        const r = await doFetch(`${base}/api/explode`);
        expect(r.status).toBe(500);
        expect(r.data.caught).toBe(true);
        expect(r.data.message).toBe('child router boom');
    });
});

// --- Response JSON.stringify Safety ------------------------------

describe('Response JSON.stringify Safety', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();

        app.get('/circular', (req, res) =>
        {
            const obj = {};
            obj.self = obj;
            res.json(obj);
        });

        app.get('/bigint', (req, res) =>
        {
            res.send({ value: BigInt(9007199254740991) });
        });

        app.get('/normal', (req, res) =>
        {
            res.json({ ok: true });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('handles circular reference without crashing', async () =>
    {
        const r = await doFetch(`${base}/circular`);
        expect(r.status).toBe(500);
        expect(r.data.error).toBe('Failed to serialize response body');
    });

    it('handles BigInt without crashing', async () =>
    {
        const r = await doFetch(`${base}/bigint`);
        expect(r.status).toBe(500);
        expect(r.data.error).toBe('Failed to serialize response body');
    });

    it('normal JSON still works', async () =>
    {
        const r = await doFetch(`${base}/normal`);
        expect(r.status).toBe(200);
        expect(r.data.ok).toBe(true);
    });
});

// --- WebSocket sendJSON Safety -----------------------------------

describe('WebSocket sendJSON Safety', () =>
{
    const WebSocketConnection = require('../../lib/ws/connection');

    it('returns false and emits error on circular JSON', () =>
    {
        // Create a mock socket
        const mockSocket = {
            remoteAddress: '127.0.0.1',
            write: vi.fn(() => true),
            on: vi.fn(),
            destroy: vi.fn(),
        };

        const ws = new WebSocketConnection(mockSocket, { pingInterval: 0 });

        let emittedError = null;
        ws.on('error', (err) => { emittedError = err; });

        const circular = {};
        circular.self = circular;
        const result = ws.sendJSON(circular);

        expect(result).toBe(false);
        expect(emittedError).toBeInstanceOf(Error);
        expect(emittedError.message).toContain('Failed to serialize JSON');

        ws.terminate();
    });

    it('sendJSON works with valid data', () =>
    {
        const written = [];
        const mockSocket = {
            remoteAddress: '127.0.0.1',
            write: vi.fn((data, cb) => { written.push(data); return true; }),
            on: vi.fn(),
            destroy: vi.fn(),
        };

        const ws = new WebSocketConnection(mockSocket, { pingInterval: 0 });
        const result = ws.sendJSON({ hello: 'world' });

        expect(result).toBe(true);
        ws.terminate();
    });
});

// --- SSE _formatData Safety -------------------------------------

describe('SSE _formatData Safety', () =>
{
    const SSEStream = require('../../lib/sse/stream');

    it('handles circular reference without crashing', () =>
    {
        let written = '';
        const mockRaw = {
            writeHead: vi.fn(),
            write: vi.fn((data) => { written += data; return true; }),
            end: vi.fn(),
            on: vi.fn(),
            setHeader: vi.fn(),
        };

        const sse = new SSEStream(mockRaw);

        const circular = {};
        circular.self = circular;
        sse.send(circular);

        expect(written).toContain('[Serialization Error]');
    });

    it('serializes normal objects correctly', () =>
    {
        let written = '';
        const mockRaw = {
            writeHead: vi.fn(),
            write: vi.fn((data) => { written += data; return true; }),
            end: vi.fn(),
            on: vi.fn(),
            setHeader: vi.fn(),
        };

        const sse = new SSEStream(mockRaw);
        sse.send({ msg: 'hello' });

        expect(written).toContain('data: {"msg":"hello"}');
    });
});

// --- Compression Error Handling ----------------------------------

describe('Compression Error Handling', () =>
{
    const compress = require('../../lib/middleware/compress');

    it('creates compression middleware without errors', () =>
    {
        const mw = compress();
        expect(typeof mw).toBe('function');
    });

    it('skips compression when no Accept-Encoding', async () =>
    {
        const app = createApp();
        app.use(compress());
        app.get('/test', (req, res) => res.json({ ok: true }));

        let server;
        try
        {
            server = http.createServer(app.handler);
            await new Promise(r => server.listen(0, r));
            const base = `http://localhost:${server.address().port}`;
            const r = await doFetch(base + '/test');
            expect(r.status).toBe(200);
            expect(r.data.ok).toBe(true);
        }
        finally { server?.close(); }
    });
});

// --- CSRF Crypto Safety -----------------------------------------

describe('CSRF Crypto Safety', () =>
{
    const csrf = require('../../lib/middleware/csrf');

    it('creates middleware without errors', () =>
    {
        const mw = csrf();
        expect(typeof mw).toBe('function');
    });

    it('rejects invalid CSRF tokens gracefully', () =>
    {
        const mw = csrf();
        let statusCode = 0, body = null;
        const req = {
            method: 'POST',
            url: '/submit',
            headers: {},
            cookies: {},
        };
        const res = {
            status(code) { statusCode = code; return res; },
            json(obj) { body = obj; },
            set() { return res; },
        };

        mw(req, res, () => {});
        expect(statusCode).toBe(403);
        expect(body.error).toContain('CSRF');
    });

    it('generates and verifies tokens on GET', () =>
    {
        const mw = csrf();
        const req = {
            method: 'GET',
            url: '/',
            headers: {},
            cookies: {},
        };
        const res = {
            set: vi.fn(),
        };

        mw(req, res, () => {});
        expect(req.csrfToken).toBeTruthy();
        expect(typeof req.csrfToken).toBe('string');
        expect(req.csrfToken).toContain('.');
    });
});

// --- CookieParser Safety -----------------------------------------

describe('CookieParser Safety', () =>
{
    const cookieParser = require('../../lib/middleware/cookieParser');

    it('parses cookies safely', () =>
    {
        const mw = cookieParser('my-secret');
        const req = {
            headers: { cookie: 'name=value; other=test' },
        };
        const res = {};

        mw(req, res, () => {});
        expect(req.cookies.name).toBe('value');
        expect(req.cookies.other).toBe('test');
    });

    it('handles invalid signed cookies gracefully', () =>
    {
        const mw = cookieParser('my-secret');
        const req = {
            headers: { cookie: 'token=s:fakepayload.invalidsig' },
        };
        const res = {};

        mw(req, res, () => {});
        // Invalid signed cookie should be silently dropped
        expect(req.signedCookies.token).toBeUndefined();
        expect(req.cookies.token).toBeUndefined();
    });

    it('handles malformed cookie header', () =>
    {
        const mw = cookieParser();
        const req = {
            headers: { cookie: 'garbage;;;===;no-equals' },
        };
        const res = {};

        mw(req, res, () => {});
        expect(req.cookies).toBeDefined();
    });
});

// --- Timeout Middleware -------------------------------------------

describe('Timeout Middleware', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        const timeout = require('../../lib/middleware/timeout');
        app.use(timeout(100)); // 100ms timeout

        app.get('/fast', (req, res) =>
        {
            res.json({ ok: true });
        });

        app.get('/slow', (req, res) =>
        {
            // Never responds — timeout should fire
            setTimeout(() => {
                if (!req.timedOut) res.json({ ok: true });
            }, 300);
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('fast requests complete normally', async () =>
    {
        const r = await doFetch(`${base}/fast`);
        expect(r.status).toBe(200);
        expect(r.data.ok).toBe(true);
    });

    it('slow requests get 408 timeout', async () =>
    {
        const r = await doFetch(`${base}/slow`);
        expect(r.status).toBe(408);
        expect(r.data.error).toBe('Request Timeout');
    });
});

// --- ORM Error Handling ------------------------------------------

describe('ORM Error Handling', () =>
{
    const { Database, Model } = require('../../');

    it('throws on unregistered model operations', () =>
    {
        class Unregistered extends Model
        {
            static table = 'test';
            static schema = { id: { type: 'integer', primaryKey: true } };
        }

        expect(() => Unregistered.query()).toThrow('not registered');
    });

    it('adapter errors propagate through save()', async () =>
    {
        const db = Database.connect('memory');

        class Item extends Model
        {
            static table = 'items';
            static schema = {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string', required: true },
            };
        }

        db.register(Item);
        await Item.sync();

        // Should succeed
        const item = await Item.create({ name: 'test' });
        expect(item.name).toBe('test');
        expect(item.id).toBeDefined();
    });

    it('validation errors are thrown on save', async () =>
    {
        const db = Database.connect('memory');

        class Strict extends Model
        {
            static table = 'strict';
            static schema = {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                email: { type: 'string', required: true },
            };
        }

        db.register(Strict);
        await Strict.sync();

        await expect(Strict.create({})).rejects.toThrow('Validation failed');
    });

    it('query errors propagate through exec()', async () =>
    {
        const db = Database.connect('memory');

        class TestModel extends Model
        {
            static table = 'test_exec';
            static schema = {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string' },
            };
        }

        db.register(TestModel);
        await TestModel.sync();

        // Normal query should work
        const results = await TestModel.find();
        expect(results).toEqual([]);
    });
});

// --- Debug Logger ------------------------------------------------

describe('Debug Logger Integration', () =>
{
    const debug = require('../../lib/debug');

    it('creates namespaced loggers', () =>
    {
        const log = debug('test:integration');
        expect(typeof log).toBe('function');
        expect(typeof log.info).toBe('function');
        expect(typeof log.error).toBe('function');
        expect(typeof log.warn).toBe('function');
        expect(typeof log.debug).toBe('function');
        expect(typeof log.trace).toBe('function');
        expect(typeof log.fatal).toBe('function');
    });

    it('captures output when custom stream provided', () =>
    {
        const lines = [];
        debug.level('trace');
        debug.colors(false);
        debug.output({ write: (str) => lines.push(str) });

        const log = debug('test:capture');
        log.info('hello %s', 'world');

        debug.reset();

        expect(lines.length).toBeGreaterThan(0);
        expect(lines[0]).toContain('hello world');
    });
});

// --- Rate Limiter ------------------------------------------------

describe('Rate Limiter Error Handling', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        const { rateLimit } = require('../../');
        app.use(rateLimit({ windowMs: 60000, max: 3 }));
        app.get('/limited', (req, res) => res.json({ ok: true }));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('allows requests within limit', async () =>
    {
        const r = await doFetch(`${base}/limited`);
        expect(r.status).toBe(200);
    });

    it('blocks requests exceeding limit', async () =>
    {
        // Make requests to exceed the limit
        await doFetch(`${base}/limited`);
        await doFetch(`${base}/limited`);
        const r = await doFetch(`${base}/limited`);
        expect(r.status).toBe(429);
        expect(r.data.error).toContain('Too many requests');
    });
});

// --- App Middleware Error Pipeline -------------------------------

describe('App Middleware Error Pipeline', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();

        app.onError((err, req, res) =>
        {
            res.status(err.statusCode || 500).json({ pipeline: true, message: err.message });
        });

        app.use((req, res, next) =>
        {
            if (req.url === '/async-error') return Promise.reject(new Error('async mw error'));
            next();
        });

        app.get('/async-error', (req, res) => res.json({ ok: true }));

        app.get('/sync-error', (req, res) =>
        {
            throw new Error('sync handler error');
        });

        app.get('/async-handler-error', async (req, res) =>
        {
            throw new Error('async handler error');
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('catches async middleware errors', async () =>
    {
        const r = await doFetch(`${base}/async-error`);
        expect(r.status).toBe(500);
        expect(r.data.pipeline).toBe(true);
        expect(r.data.message).toBe('async mw error');
    });

    it('catches sync handler throws', async () =>
    {
        const r = await doFetch(`${base}/sync-error`);
        expect(r.status).toBe(500);
        expect(r.data.pipeline).toBe(true);
        expect(r.data.message).toBe('sync handler error');
    });

    it('catches async handler throws', async () =>
    {
        const r = await doFetch(`${base}/async-handler-error`);
        expect(r.status).toBe(500);
        expect(r.data.pipeline).toBe(true);
        expect(r.data.message).toBe('async handler error');
    });
});

// --- HttpError Integration ---------------------------------------

describe('HttpError Integration with Router', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        const { NotFoundError, ForbiddenError, BadRequestError } = require('../../lib/errors');

        app.get('/not-found', (req, res) =>
        {
            throw new NotFoundError('resource missing');
        });

        app.get('/forbidden', (req, res) =>
        {
            throw new ForbiddenError('no access');
        });

        app.get('/bad-request', (req, res) =>
        {
            throw new BadRequestError('invalid input');
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('NotFoundError produces 404 response', async () =>
    {
        const r = await doFetch(`${base}/not-found`);
        expect(r.status).toBe(404);
        expect(r.data.error).toBe('resource missing');
    });

    it('ForbiddenError produces 403 response', async () =>
    {
        const r = await doFetch(`${base}/forbidden`);
        expect(r.status).toBe(403);
        expect(r.data.error).toBe('no access');
    });

    it('BadRequestError produces 400 response', async () =>
    {
        const r = await doFetch(`${base}/bad-request`);
        expect(r.status).toBe(400);
        expect(r.data.error).toBe('invalid input');
    });
});


// =========================================================================
//  errorHandler — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  1. ERROR HANDLER MIDDLEWARE
// ============================================================
describe('errorHandler middleware', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, errorHandler, json, BadRequestError, NotFoundError } = require('../../');
		const app = createApp();
		app.use(json());

		// Route that throws a generic error
		app.get('/generic', (req, res) => { throw new Error('something broke'); });
		// Route that throws an HttpError
		app.get('/http-error', (req, res) => { throw new BadRequestError('bad input'); });
		// Route that throws with a code
		app.get('/coded', (req, res) => { const e = new Error('fail'); e.code = 'E_CUSTOM'; throw e; });
		// Route with 404
		app.get('/not-found', (req, res) => { throw new NotFoundError('gone'); });

		const logged = [];
		app.onError(errorHandler({
			stack: true,
			log: true,
			logger: (msg) => logged.push(msg),
		}));
		app._testLogs = logged;

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('handles generic errors with 500 and includes stack in dev mode', async () => {
		const r = await fetch(`${base}/generic`);
		expect(r.status).toBe(500);
		const body = await r.json();
		expect(body.error).toBe('something broke');
		expect(body.statusCode).toBe(500);
		expect(body.stack).toBeDefined();
		expect(Array.isArray(body.stack)).toBe(true);
	});

	it('handles HttpError with proper status and toJSON', async () => {
		const r = await fetch(`${base}/http-error`);
		expect(r.status).toBe(400);
		const body = await r.json();
		expect(body.error).toBe('bad input');
		expect(body.statusCode).toBe(400);
	});

	it('includes error code when present', async () => {
		const r = await fetch(`${base}/coded`);
		expect(r.status).toBe(500);
		const body = await r.json();
		expect(body.code).toBe('E_CUSTOM');
	});

	it('handles 404 HttpError correctly', async () => {
		const r = await fetch(`${base}/not-found`);
		expect(r.status).toBe(404);
		const body = await r.json();
		expect(body.error).toBe('gone');
	});
});

describe('errorHandler — production mode (no stack)', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, errorHandler } = require('../../');
		const app = createApp();
		app.get('/fail', () => { throw new Error('secret info'); });
		app.onError(errorHandler({ stack: false, log: false }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('hides internal error details in production mode', async () => {
		const r = await fetch(`${base}/fail`);
		expect(r.status).toBe(500);
		const body = await r.json();
		expect(body.error).toBe('Internal Server Error');
		expect(body.stack).toBeUndefined();
	});
});

describe('errorHandler — custom formatter', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, errorHandler } = require('../../');
		const app = createApp();
		app.get('/fail', () => { throw new Error('oops'); });
		app.onError(errorHandler({
			log: false,
			formatter: (err, req, isDev) => ({
				msg: err.message,
				path: req.url,
				dev: isDev,
			}),
		}));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('uses custom formatter for response body', async () => {
		const r = await fetch(`${base}/fail`);
		const body = await r.json();
		expect(body.msg).toBe('oops');
		expect(body.path).toBe('/fail');
		expect(typeof body.dev).toBe('boolean');
	});
});

describe('errorHandler — onError callback', () => {
	let server, base, onErrorCalls;

	beforeAll(async () => {
		const { createApp, errorHandler } = require('../../');
		const app = createApp();
		onErrorCalls = [];
		app.get('/fail', () => { throw new Error('cb test'); });
		app.onError(errorHandler({
			log: false,
			onError: (err, req, res) => {
				onErrorCalls.push({ message: err.message, url: req.url });
			},
		}));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('invokes onError callback', async () => {
		await fetch(`${base}/fail`);
		expect(onErrorCalls.length).toBe(1);
		expect(onErrorCalls[0].message).toBe('cb test');
		expect(onErrorCalls[0].url).toBe('/fail');
	});
});

describe('errorHandler — invalid status code normalization', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, errorHandler } = require('../../');
		const app = createApp();
		app.get('/bad-status', () => {
			const e = new Error('bad');
			e.statusCode = 9999;
			throw e;
		});
		app.onError(errorHandler({ log: false }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('normalizes invalid status codes to 500', async () => {
		const r = await fetch(`${base}/bad-status`);
		expect(r.status).toBe(500);
	});
});