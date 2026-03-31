/**
 * Tests for QoL improvements: App, Request, Response, Router enhancements.
 */
const http = require('http');
const { doFetch, fetch } = require('../_helpers');
const { createApp, Router, json } = require('../../');

// -- App QoL ---------------------------------------------

describe('App — set/get/enable/disable', () =>
{
    it('set() and get() store and retrieve settings', () =>
    {
        const app = createApp();
        app.set('view engine', 'pug');
        expect(app.get('view engine')).toBe('pug');
    });

    it('enable() and enabled()', () =>
    {
        const app = createApp();
        app.enable('trust proxy');
        expect(app.enabled('trust proxy')).toBe(true);
    });

    it('disable() and disabled()', () =>
    {
        const app = createApp();
        app.enable('x-powered-by');
        app.disable('x-powered-by');
        expect(app.disabled('x-powered-by')).toBe(true);
    });

    it('get() with 1 arg returns setting', () =>
    {
        const app = createApp();
        app.set('foo', 'bar');
        // 1-arg call = settings getter
        expect(app.get('foo')).toBe('bar');
    });

    it('locals is a shared object', () =>
    {
        const app = createApp();
        app.locals.appName = 'MyApp';
        expect(app.locals.appName).toBe('MyApp');
    });
});

describe('App — route chaining', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app
            .get('/a', (req, res) => res.json({ route: 'a' }))
            .post('/b', (req, res) => res.json({ route: 'b' }))
            .get('/c', (req, res) => res.json({ route: 'c' }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('chained routes work', async () =>
    {
        const a = await (await fetch(`${base}/a`)).json();
        expect(a.route).toBe('a');
        const c = await (await fetch(`${base}/c`)).json();
        expect(c.route).toBe('c');
    });
});

describe('App — group()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.group('/api', (router) =>
        {
            router.get('/users', (req, res) => res.json({ path: 'users' }));
            router.get('/posts', (req, res) => res.json({ path: 'posts' }));
        });
        app.get('/root', (req, res) => res.json({ path: 'root' }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('group routes are accessible under prefix', async () =>
    {
        const r = await (await fetch(`${base}/api/users`)).json();
        expect(r.path).toBe('users');
    });

    it('group does not affect root routes', async () =>
    {
        const r = await (await fetch(`${base}/root`)).json();
        expect(r.path).toBe('root');
    });
});

describe('App — param()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        let paramCalled = false;
        app.param('id', (req, res, next, val) =>
        {
            req.paramProcessed = true;
            req.paramId = val;
            next();
        });
        app.get('/items/:id', (req, res) =>
        {
            res.json({ processed: req.paramProcessed, id: req.params.id });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('param handler runs before route handler', async () =>
    {
        const r = await (await fetch(`${base}/items/42`)).json();
        expect(r.processed).toBe(true);
        expect(r.id).toBe('42');
    });
});

// -- Request QoL -----------------------------------------

describe('Request — app, originalUrl', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.locals.appName = 'TestApp';
        app.get('/check', (req, res) =>
        {
            res.json({
                hasApp: req.app !== null,
                originalUrl: req.originalUrl,
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('req.app is set by handler', async () =>
    {
        const r = await (await fetch(`${base}/check`)).json();
        expect(r.hasApp).toBe(true);
    });

    it('req.originalUrl is set', async () =>
    {
        const r = await (await fetch(`${base}/check?foo=bar`)).json();
        expect(r.originalUrl).toContain('/check');
    });
});

// -- Response QoL ----------------------------------------

describe('Response — location()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/redir', (req, res) =>
        {
            res.location('/new-url').status(302).send('');
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets Location header', async () =>
    {
        const r = await fetch(`${base}/redir`, { redirect: 'manual' });
        expect(r.status).toBe(302);
        expect(r.headers.get('location')).toBe('/new-url');
    });
});

describe('Response — links()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/paginated', (req, res) =>
        {
            res.links({ next: '/page/2', last: '/page/5' });
            res.json({ page: 1 });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets Link header', async () =>
    {
        const r = await fetch(`${base}/paginated`);
        expect(r.status).toBe(200);
        const link = r.headers.get('link');
        expect(link).toContain('</page/2>; rel="next"');
        expect(link).toContain('</page/5>; rel="last"');
    });
});

describe('Response — format()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/content', (req, res) =>
        {
            res.format({
                'text/plain': () => res.text('plain text'),
                'application/json': () => res.json({ type: 'json' }),
                default: () => res.status(406).send('Not Acceptable'),
            });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('negotiates JSON for Accept: application/json', async () =>
    {
        const r = await fetch(`${base}/content`, {
            headers: { 'Accept': 'application/json' },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.type).toBe('json');
    });

    it('negotiates plain text for Accept: text/plain', async () =>
    {
        const r = await fetch(`${base}/content`, {
            headers: { 'Accept': 'text/plain' },
        });
        expect(r.status).toBe(200);
        const body = await r.text();
        expect(body).toBe('plain text');
    });

    it('falls back to default for unknown Accept', async () =>
    {
        const r = await fetch(`${base}/content`, {
            headers: { 'Accept': 'image/webp' },
        });
        expect(r.status).toBe(406);
    });
});

// -- Router QoL ------------------------------------------

describe('Router — baseUrl on sub-routers', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        const api = Router();
        api.get('/hello', (req, res) =>
        {
            res.json({ baseUrl: req.baseUrl, url: req.url });
        });
        app.use('/api', api);
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sets req.baseUrl on sub-router', async () =>
    {
        const r = await (await fetch(`${base}/api/hello`)).json();
        expect(r.baseUrl).toBe('/api');
    });
});


// =========================================================================
//  app chain/close — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  15. APP — CHAIN, CLOSE
// ============================================================
describe('app.chain() method', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.chain('/resource')
			.get((req, res) => res.json({ method: 'GET' }))
			.post((req, res) => res.json({ method: 'POST' }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('chain GET works', async () => {
		const { data } = await doFetch(`${base}/resource`);
		expect(data.method).toBe('GET');
	});

	it('chain POST works', async () => {
		const { data } = await doFetch(`${base}/resource`, { method: 'POST' });
		expect(data.method).toBe('POST');
	});
});

describe('app.close()', () => {
	it('closes the server', async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/', (req, res) => res.json({ ok: true }));
		const server = app.listen(0);
		await new Promise(r => server.on('listening', r));

		// Should be able to make requests
		const port = server.address().port;
		const { data } = await doFetch(`http://localhost:${port}/`);
		expect(data.ok).toBe(true);

		// Close
		await new Promise(r => app.close(r));
	});
});

// =========================================================================
//  debug — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  17. DEBUG — PATTERNS, OUTPUT CAPTURE
// ============================================================
describe('debug — pattern matching', () => {
	it('enable/disable patterns work', () => {
		const debug = require('../../lib/debug');
		debug.enable('app:*');
		const log1 = debug('app:routes');
		expect(log1.enabled).toBe(true);
		const log2 = debug('db:queries');
		expect(log2.enabled).toBe(false);
		debug.reset();
	});

	it('negation patterns exclude namespaces', () => {
		const debug = require('../../lib/debug');
		debug.enable('*,-db:*');
		const log1 = debug('app:routes');
		expect(log1.enabled).toBe(true);
		const log2 = debug('db:queries');
		expect(log2.enabled).toBe(false);
		debug.reset();
	});

	it('disable disables everything', () => {
		const debug = require('../../lib/debug');
		debug.disable();
		const log = debug('anything');
		expect(log.enabled).toBe(false);
		debug.reset();
	});
});

describe('debug — output capture', () => {
	it('writes to custom output stream', () => {
		const debug = require('../../lib/debug');
		const lines = [];
		debug.output({ write: (s) => lines.push(s) });
		debug.enable('test:*');
		debug.colors(false);
		debug.level('trace');
		const log = debug('test:cap');
		log.info('hello %s', 'world');
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain('hello world');
		expect(lines[0]).toContain('INFO');
		expect(lines[0]).toContain('test:cap');
		debug.reset();
	});

	it('JSON mode outputs valid JSON', () => {
		const debug = require('../../lib/debug');
		const lines = [];
		debug.output({ write: (s) => lines.push(s) });
		debug.enable('test:*');
		debug.json(true);
		debug.level('trace');
		const log = debug('test:json');
		log.warn('uh oh');
		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.level).toBe('WARN');
		expect(parsed.namespace).toBe('test:json');
		expect(parsed.message).toBe('uh oh');
		expect(parsed.timestamp).toBeDefined();
		debug.reset();
	});

	it('all log levels produce output', () => {
		const debug = require('../../lib/debug');
		const lines = [];
		debug.output({ write: (s) => lines.push(s) });
		debug.enable('test:*');
		debug.colors(false);
		debug.level('trace');
		const log = debug('test:levels');
		log.trace('t');
		log.debug('d');
		log.info('i');
		log.warn('w');
		log.error('e');
		log.fatal('f');
		expect(lines.length).toBe(6);
		expect(lines[0]).toContain('TRACE');
		expect(lines[1]).toContain('DEBUG');
		expect(lines[2]).toContain('INFO');
		expect(lines[3]).toContain('WARN');
		expect(lines[4]).toContain('ERROR');
		expect(lines[5]).toContain('FATAL');
		debug.reset();
	});

	it('timestamp can be disabled', () => {
		const debug = require('../../lib/debug');
		const lines = [];
		debug.output({ write: (s) => lines.push(s) });
		debug.enable('test:*');
		debug.colors(false);
		debug.timestamps(false);
		const log = debug('test:nots');
		log.info('no time');
		// Timestamp format is HH:MM:SS.mmm - should not appear
		expect(lines[0]).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
		debug.reset();
	});

	it('format specifiers work (%s, %d, %j)', () => {
		const debug = require('../../lib/debug');
		const lines = [];
		debug.output({ write: (s) => lines.push(s) });
		debug.enable('test:*');
		debug.colors(false);
		const log = debug('test:fmt');
		log.info('str=%s num=%d obj=%j', 'hello', 42, { a: 1 });
		expect(lines[0]).toContain('str=hello');
		expect(lines[0]).toContain('num=42');
		expect(lines[0]).toContain('obj={"a":1}');
		debug.reset();
	});
});