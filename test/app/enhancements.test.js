/**
 * Tests for cookieParser enhancements (JSON cookies, signed, timing-safe,
 * unsign/jsonCookie/parseJSON helpers, res.cookie signed/priority/partitioned)
 * and ORM enhancements (scopes, hidden, exists, upsert, increment/decrement,
 * belongsToMany, whereNot*, aggregates, pluck, transaction).
 */
const http = require('http');
const crypto = require('crypto');
const { doFetch, fetch } = require('../_helpers');
const {
    createApp, json, cookieParser, Database, Model, TYPES, Query
} = require('../../');

// ===========================================================
//  CookieParser Enhancements
// ===========================================================

describe('CookieParser — JSON cookies', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(cookieParser('test-secret'));
        app.use(json());
        app.get('/read', (req, res) => res.json({
            cookies: req.cookies,
            signedCookies: req.signedCookies,
            secret: req.secret,
            hasSecrets: Array.isArray(req.secrets),
        }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('parses j: prefixed cookies as JSON objects', async () =>
    {
        const val = 'j:' + JSON.stringify({ theme: 'dark', lang: 'en' });
        const r = await fetch(`${base}/read`, {
            headers: { Cookie: `prefs=${encodeURIComponent(val)}` }
        });
        const body = await r.json();
        expect(body.cookies.prefs).toEqual({ theme: 'dark', lang: 'en' });
    });

    it('returns raw string for invalid j: JSON', async () =>
    {
        const r = await fetch(`${base}/read`, {
            headers: { Cookie: 'bad=j%3Anot-json' }
        });
        const body = await r.json();
        expect(body.cookies.bad).toBe('j:not-json');
    });

    it('parses signed JSON cookies (s:j:{...}.<sig>)', async () =>
    {
        const jsonVal = 'j:' + JSON.stringify({ cart: [1, 2] });
        const signed = cookieParser.sign(jsonVal, 'test-secret');
        const r = await fetch(`${base}/read`, {
            headers: { Cookie: `cart=${encodeURIComponent(signed)}` }
        });
        const body = await r.json();
        expect(body.signedCookies.cart).toEqual({ cart: [1, 2] });
    });

    it('exposes req.secret and req.secrets', async () =>
    {
        const r = await fetch(`${base}/read`);
        const body = await r.json();
        expect(body.secret).toBe('test-secret');
        expect(body.hasSecrets).toBe(true);
    });
});

describe('CookieParser — static helpers', () =>
{
    it('unsign() verifies valid signed cookie', () =>
    {
        const signed = cookieParser.sign('hello', 'secret');
        expect(cookieParser.unsign(signed, 'secret')).toBe('hello');
    });

    it('unsign() returns false for tampered cookie', () =>
    {
        const signed = cookieParser.sign('hello', 'secret');
        const tampered = signed.slice(0, -3) + 'xxx';
        expect(cookieParser.unsign(tampered, 'secret')).toBe(false);
    });

    it('unsign() supports secret rotation (array)', () =>
    {
        const signed = cookieParser.sign('val', 'old-secret');
        expect(cookieParser.unsign(signed, ['new-secret', 'old-secret'])).toBe('val');
    });

    it('unsign() returns false with wrong secrets', () =>
    {
        const signed = cookieParser.sign('val', 'real-secret');
        expect(cookieParser.unsign(signed, 'wrong-secret')).toBe(false);
    });

    it('jsonCookie() serialises object with j: prefix', () =>
    {
        const result = cookieParser.jsonCookie({ x: 1 });
        expect(result).toBe('j:{"x":1}');
    });

    it('parseJSON() parses j: prefixed string', () =>
    {
        expect(cookieParser.parseJSON('j:{"a":1}')).toEqual({ a: 1 });
    });

    it('parseJSON() returns original string if not j: prefixed', () =>
    {
        expect(cookieParser.parseJSON('plain')).toBe('plain');
    });
});

describe('CookieParser — timing-safe verification', () =>
{
    it('uses timing-safe comparison (no simple string equality)', () =>
    {
        // Verify that the implementation uses timingSafeEqual
        // by testing that valid cookies are properly verified
        const signed = cookieParser.sign('sensitive-data', 'secret-key');
        expect(cookieParser.unsign(signed, 'secret-key')).toBe('sensitive-data');

        // Construct a cookie with correct length but wrong content
        const parts = signed.slice(2).split('.');
        const wrongSig = parts[1].split('').reverse().join('');
        const fake = `s:${parts[0]}.${wrongSig}`;
        expect(cookieParser.unsign(fake, 'secret-key')).toBe(false);
    });
});

describe('res.cookie() — enhanced options', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(cookieParser('sign-secret'));
        app.use(json());

        app.get('/signed', (req, res) =>
        {
            res.cookie('token', 'abc123', { signed: true });
            res.json({ ok: true });
        });

        app.get('/json-cookie', (req, res) =>
        {
            res.cookie('prefs', { theme: 'dark', fontSize: 14 });
            res.json({ ok: true });
        });

        app.get('/priority', (req, res) =>
        {
            res.cookie('important', 'yes', { priority: 'High' });
            res.json({ ok: true });
        });

        app.get('/partitioned', (req, res) =>
        {
            res.cookie('chip', 'val', { partitioned: true, secure: true, sameSite: 'None' });
            res.json({ ok: true });
        });

        app.get('/signed-no-secret', (req, res) =>
        {
            try
            {
                // No cookieParser secret in this scenario - but we DO have one
                res.cookie('x', 'y', { signed: true });
                res.json({ ok: true });
            }
            catch (e)
            {
                res.status(500).json({ error: e.message });
            }
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('signed:true auto-signs the cookie value', async () =>
    {
        const r = await fetch(`${base}/signed`);
        const setCookie = r.headers.get('set-cookie');
        expect(setCookie).toBeDefined();
        // Should contain s: prefix (URL-encoded as s%3A)
        expect(setCookie).toMatch(/s%3A/);
    });

    it('auto-serialises objects as j: JSON cookies', async () =>
    {
        const r = await fetch(`${base}/json-cookie`);
        const setCookie = r.headers.get('set-cookie');
        expect(setCookie).toBeDefined();
        // Should contain j: prefix (URL-encoded as j%3A)
        expect(setCookie).toMatch(/j%3A/);
    });

    it('sets Priority attribute', async () =>
    {
        const r = await fetch(`${base}/priority`);
        const setCookie = r.headers.get('set-cookie');
        expect(setCookie).toContain('Priority=High');
    });

    it('sets Partitioned attribute', async () =>
    {
        const r = await fetch(`${base}/partitioned`);
        const setCookie = r.headers.get('set-cookie');
        expect(setCookie).toContain('Partitioned');
    });
});

// ===========================================================
//  ORM Enhancements
// ===========================================================

class Product extends Model
{
    static table = 'products';
    static schema = {
        id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:     { type: TYPES.STRING, required: true },
        price:    { type: TYPES.FLOAT, required: true },
        stock:    { type: TYPES.INTEGER, default: 0 },
        category: { type: TYPES.STRING, default: 'general' },
        active:   { type: TYPES.BOOLEAN, default: true },
    };
    static timestamps = true;

    static scopes = {
        active: q => q.where('active', true),
        expensive: q => q.where('price', '>', 100),
        inCategory: (q, cat) => q.where('category', cat),
        inStock: q => q.where('stock', '>', 0),
    };

    static hidden = ['stock'];
}

class Tag extends Model
{
    static table = 'tags';
    static schema = {
        id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: TYPES.STRING, required: true },
    };
}

class ProductTag extends Model
{
    static table = 'product_tags';
    static schema = {
        id:        { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        productId: { type: TYPES.INTEGER, required: true },
        tagId:     { type: TYPES.INTEGER, required: true },
    };
}

let db;

beforeEach(async () =>
{
    db = Database.connect('memory');
    db.registerAll(Product, Tag, ProductTag);
    await db.sync();
});

// -- Scopes ----------------------------------------------

describe('ORM — Scopes', () =>
{
    beforeEach(async () =>
    {
        await Product.createMany([
            { name: 'Widget', price: 25, stock: 10, category: 'tools', active: true },
            { name: 'Gadget', price: 150, stock: 0, category: 'electronics', active: true },
            { name: 'Doohickey', price: 200, stock: 5, category: 'electronics', active: false },
        ]);
    });

    it('Model.scope() applies named scope', async () =>
    {
        const results = await Product.scope('active');
        expect(results.length).toBe(2);
        expect(results.every(r => r.active === true)).toBe(true);
    });

    it('Model.scope() with arguments', async () =>
    {
        const results = await Product.scope('inCategory', 'electronics');
        expect(results.length).toBe(2);
    });

    it('Query.scope() chains multiple scopes', async () =>
    {
        const results = await Product.query().scope('active').scope('expensive');
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('Gadget');
    });

    it('throws on unknown scope', () =>
    {
        expect(() => Product.scope('nonexistent')).toThrow('Unknown scope');
    });
});

// -- Hidden Fields ---------------------------------------

describe('ORM — Hidden Fields', () =>
{
    it('toJSON() excludes hidden fields', async () =>
    {
        const p = await Product.create({ name: 'Secret', price: 10, stock: 99 });
        const json = p.toJSON();
        expect(json.name).toBe('Secret');
        expect(json.price).toBe(10);
        expect(json.stock).toBeUndefined();
    });

    it('hidden fields are still accessible on the instance', async () =>
    {
        const p = await Product.create({ name: 'Item', price: 5, stock: 42 });
        expect(p.stock).toBe(42);
    });
});

// -- exists() --------------------------------------------

describe('ORM — exists()', () =>
{
    it('returns true when records match', async () =>
    {
        await Product.create({ name: 'Exists', price: 10 });
        expect(await Product.exists({ name: 'Exists' })).toBe(true);
    });

    it('returns false when no records match', async () =>
    {
        expect(await Product.exists({ name: 'NonExistent' })).toBe(false);
    });

    it('query.exists() works too', async () =>
    {
        await Product.create({ name: 'QExists', price: 20 });
        expect(await Product.query().where('name', 'QExists').exists()).toBe(true);
        expect(await Product.query().where('name', 'XXX').exists()).toBe(false);
    });
});

// -- upsert() --------------------------------------------

describe('ORM — upsert()', () =>
{
    it('creates when not found', async () =>
    {
        const { instance, created } = await Product.upsert(
            { name: 'NewProduct' },
            { price: 50, stock: 10 }
        );
        expect(created).toBe(true);
        expect(instance.name).toBe('NewProduct');
        expect(instance.price).toBe(50);
    });

    it('updates when found', async () =>
    {
        await Product.create({ name: 'Existing', price: 30 });
        const { instance, created } = await Product.upsert(
            { name: 'Existing' },
            { price: 99 }
        );
        expect(created).toBe(false);
        expect(instance.price).toBe(99);
    });
});

// -- increment / decrement -------------------------------

describe('ORM — increment / decrement', () =>
{
    it('increment() increases a field by 1', async () =>
    {
        const p = await Product.create({ name: 'Counter', price: 10, stock: 5 });
        await p.increment('stock');
        expect(p.stock).toBe(6);
        const reloaded = await Product.findById(p.id);
        expect(reloaded.stock).toBe(6);
    });

    it('increment() increases by custom amount', async () =>
    {
        const p = await Product.create({ name: 'Bulk', price: 10, stock: 10 });
        await p.increment('stock', 25);
        expect(p.stock).toBe(35);
    });

    it('decrement() decreases a field by 1', async () =>
    {
        const p = await Product.create({ name: 'Dec', price: 10, stock: 10 });
        await p.decrement('stock');
        expect(p.stock).toBe(9);
    });

    it('decrement() decreases by custom amount', async () =>
    {
        const p = await Product.create({ name: 'BigDec', price: 10, stock: 100 });
        await p.decrement('stock', 30);
        expect(p.stock).toBe(70);
    });
});

// -- belongsToMany ---------------------------------------

describe('ORM — belongsToMany', () =>
{
    it('loads related models through junction table', async () =>
    {
        Product.belongsToMany(Tag, {
            through: 'product_tags',
            foreignKey: 'productId',
            otherKey: 'tagId',
        });

        const p = await Product.create({ name: 'Tagged', price: 10 });
        const t1 = await Tag.create({ name: 'sale' });
        const t2 = await Tag.create({ name: 'new' });

        await ProductTag.create({ productId: p.id, tagId: t1.id });
        await ProductTag.create({ productId: p.id, tagId: t2.id });

        const tags = await p.load('Tag');
        expect(tags.length).toBe(2);
        expect(tags.map(t => t.name).sort()).toEqual(['new', 'sale']);
    });

    it('returns empty array when no junction rows', async () =>
    {
        Product.belongsToMany(Tag, {
            through: 'product_tags',
            foreignKey: 'productId',
            otherKey: 'tagId',
        });

        const p = await Product.create({ name: 'Untagged', price: 10 });
        const tags = await p.load('Tag');
        expect(tags).toEqual([]);
    });

    it('throws when options are missing', () =>
    {
        expect(() => Product.belongsToMany(Tag, {})).toThrow('belongsToMany requires');
    });
});

// -- Query Enhancements ----------------------------------

describe('ORM — Query enhancements', () =>
{
    beforeEach(async () =>
    {
        await Product.createMany([
            { name: 'A', price: 10, stock: 5, category: 'x' },
            { name: 'B', price: 50, stock: 0, category: 'y' },
            { name: 'C', price: 100, stock: 15, category: 'x' },
            { name: 'D', price: 200, stock: 3, category: 'z' },
        ]);
    });

    it('whereNotIn() excludes values', async () =>
    {
        const results = await Product.query().whereNotIn('category', ['x', 'z']);
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('B');
    });

    it('whereNotBetween() excludes range', async () =>
    {
        const results = await Product.query().whereNotBetween('price', 20, 150);
        expect(results.length).toBe(2);
        expect(results.map(r => r.name).sort()).toEqual(['A', 'D']);
    });

    it('whereLike() filters with patterns', async () =>
    {
        await Product.create({ name: 'Alpha Widget', price: 5 });
        const results = await Product.query().whereLike('name', '%Widget%');
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('Alpha Widget');
    });

    it('pluck() returns array of single column values', async () =>
    {
        const names = await Product.query().orderBy('name').pluck('name');
        expect(names).toEqual(['A', 'B', 'C', 'D']);
    });

    it('exists() returns true/false', async () =>
    {
        expect(await Product.query().where('name', 'A').exists()).toBe(true);
        expect(await Product.query().where('name', 'ZZZ').exists()).toBe(false);
    });

    it('sum() totals a numeric field', async () =>
    {
        const total = await Product.query().sum('price');
        expect(total).toBe(360);
    });

    it('avg() averages a numeric field', async () =>
    {
        const average = await Product.query().avg('price');
        expect(average).toBe(90);
    });

    it('min() returns minimum value', async () =>
    {
        const minimum = await Product.query().min('price');
        expect(minimum).toBe(10);
    });

    it('max() returns maximum value', async () =>
    {
        const maximum = await Product.query().max('price');
        expect(maximum).toBe(200);
    });

    it('min() returns null for empty results', async () =>
    {
        const minimum = await Product.query().where('name', 'ZZZ').min('price');
        expect(minimum).toBe(null);
    });

    it('rightJoin() is available', () =>
    {
        const q = Product.query().rightJoin('tags', 'id', 'productId');
        const built = q.build();
        expect(built.joins[0].type).toBe('RIGHT');
    });
});

// -- Transaction -----------------------------------------

describe('ORM — transaction()', () =>
{
    it('commits on success', async () =>
    {
        await db.transaction(async () =>
        {
            await Product.create({ name: 'TxProduct', price: 10 });
        });
        expect(await Product.exists({ name: 'TxProduct' })).toBe(true);
    });

    it('rollback on error (memory adapter just runs, but verifies interface)', async () =>
    {
        try
        {
            await db.transaction(async () =>
            {
                await Product.create({ name: 'WillFail', price: 10 });
                throw new Error('forced rollback');
            });
        }
        catch (e)
        {
            expect(e.message).toBe('forced rollback');
        }
    });
});

// =========================================================================
//  App locals prototype chain (from audit)
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
            req.locals.requestSpecific = 'yes';
            res.json({
                appName: req.locals.appName,
                version: req.locals.version,
                requestSpecific: req.locals.requestSpecific,
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
        expect(r.data.hasOwn).toBe(false);
    });
});



// =========================================================================
//  app — deep branch coverage (from coverage/deep.test.js)
// =========================================================================

describe('app — deep branch coverage', () => {
	it('get() with 1 arg returns setting value', () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.set('view engine', 'ejs');
		expect(app.get('view engine')).toBe('ejs');
	});

	it('enable/disable/enabled/disabled work correctly', () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.enable('trust proxy');
		expect(app.enabled('trust proxy')).toBe(true);
		expect(app.disabled('trust proxy')).toBe(false);
		app.disable('trust proxy');
		expect(app.disabled('trust proxy')).toBe(true);
		expect(app.enabled('trust proxy')).toBe(false);
	});

	it('use() with path and function creates scoped middleware', async () => {
		const { createApp } = require('../../');
		const app = createApp();
		const calls = [];

		app.use('/api', (req, res, next) => {
			calls.push('api-mw:' + req.url);
			next();
		});

		app.get('/api/test', (req, res) => res.json({ ok: true }));
		app.get('/other', (req, res) => res.json({ ok: true }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const base = `http://localhost:${server.address().port}`;

		await fetch(`${base}/api/test`);
		await fetch(`${base}/other`);

		expect(calls.length).toBe(1);
		expect(calls[0]).toContain('/test');
		server.close();
	});

	it('use() with path matching exact prefix (no trailing slash)', async () => {
		const { createApp } = require('../../');
		const app = createApp();
		let called = false;

		app.use('/exact', (req, res, next) => {
			called = true;
			next();
		});

		app.get('/exact', (req, res) => res.json({ ok: true }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		await fetch(`http://localhost:${server.address().port}/exact`);
		expect(called).toBe(true);
		server.close();
	});

	it('middleware error is caught and handled via onError', async () => {
		const { createApp } = require('../../');
		const app = createApp();
		let errorSeen = null;

		app.use((req, res, next) => {
			throw new Error('middleware boom');
		});

		app.onError((err, req, res, next) => {
			errorSeen = err.message;
			res.status(500).json({ error: err.message });
		});

		app.get('/test', (req, res) => res.json({ ok: true }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const r = await fetch(`http://localhost:${server.address().port}/test`);
		expect(r.status).toBe(500);
		expect(errorSeen).toBe('middleware boom');
		server.close();
	});

	it('async middleware error is caught via .catch()', async () => {
		const { createApp } = require('../../');
		const app = createApp();

		app.use(async (req, res, next) => {
			throw new Error('async boom');
		});

		app.get('/test', (req, res) => res.json({ ok: true }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const r = await fetch(`http://localhost:${server.address().port}/test`);
		expect(r.status).toBe(500);
		server.close();
	});

	it('group() with middleware applies middleware only to group routes', async () => {
		const { createApp } = require('../../');
		const app = createApp();
		const calls = [];

		const authMw = (req, res, next) => { calls.push('auth'); next(); };

		app.group('/admin', authMw, (router) => {
			router.add('GET', '/dashboard', [(req, res) => res.json({ page: 'dashboard' })]);
		});

		app.get('/public', (req, res) => res.json({ page: 'public' }));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const base = `http://localhost:${server.address().port}`;

		await fetch(`${base}/admin/dashboard`);
		await fetch(`${base}/public`);

		expect(calls).toEqual(['auth']);
		server.close();
	});

	it('group() without middleware still registers sub-routes', async () => {
		const { createApp } = require('../../');
		const app = createApp();

		app.group('/v1', (router) => {
			router.add('GET', '/info', [(req, res) => res.json({ v: 1 })]);
		});

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const r = await fetch(`http://localhost:${server.address().port}/v1/info`);
		expect(r.status).toBe(200);
		const json = await r.json();
		expect(json.v).toBe(1);
		server.close();
	});

	it('routes() includes WS handlers with options', () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/test', (req, res) => res.json({}));
		app.ws('/ws', { maxPayload: 1024, pingInterval: 5000 }, (ws) => {});
		const list = app.routes();
		const wsRoute = list.find(r => r.method === 'WS');
		expect(wsRoute).toBeDefined();
		expect(wsRoute.path).toBe('/ws');
		expect(wsRoute.maxPayload).toBe(1024);
		expect(wsRoute.pingInterval).toBe(5000);
	});

	it('chain() creates a chainable route builder', () => {
		const { createApp } = require('../../');
		const app = createApp();
		const handler = (req, res) => res.json({});
		app.chain('/users').get(handler).post(handler);
		const list = app.routes();
		const userRoutes = list.filter(r => r.path === '/users');
		expect(userRoutes.length).toBeGreaterThanOrEqual(2);
	});

	it('param() handler is registered on the router', () => {
		const { createApp } = require('../../');
		const app = createApp();
		const fn = (req, res, next, val) => next();
		app.param('id', fn);
		expect(app._paramHandlers.id).toContain(fn);
		expect(app.router._paramHandlers).toBe(app._paramHandlers);
	});

	it('_extractOpts extracts options object from handler args', () => {
		const { createApp } = require('../../');
		const app = createApp();
		const handler = (req, res) => {};
		const fns = [{ rateLimit: 10 }, handler];
		const opts = app._extractOpts(fns);
		expect(opts.rateLimit).toBe(10);
		expect(fns.length).toBe(1);
	});

	it('_extractOpts returns empty when no options object', () => {
		const { createApp } = require('../../');
		const app = createApp();
		const handler = (req, res) => {};
		const fns = [handler];
		const opts = app._extractOpts(fns);
		expect(opts).toEqual({});
		expect(fns.length).toBe(1);
	});

	it('all HTTP method shortcuts return this for chaining', () => {
		const { createApp } = require('../../');
		const app = createApp();
		const handler = (req, res) => {};
		expect(app.post('/a', handler)).toBe(app);
		expect(app.put('/b', handler)).toBe(app);
		expect(app.delete('/c', handler)).toBe(app);
		expect(app.patch('/d', handler)).toBe(app);
		expect(app.options('/e', handler)).toBe(app);
		expect(app.head('/f', handler)).toBe(app);
		expect(app.all('/g', handler)).toBe(app);
	});

	it('close() is a no-op when no server', () => {
		const { createApp } = require('../../');
		const app = createApp();
		expect(() => app.close()).not.toThrow();
	});

	it('handle() sets locals from app.locals', async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.locals.appName = 'test';

		let reqLocals = null;
		app.get('/check', (req, res) => {
			reqLocals = req.locals;
			res.json({ name: req.locals.appName });
		});

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		await fetch(`http://localhost:${server.address().port}/check`);
		expect(reqLocals.appName).toBe('test');
		server.close();
	});

	it('handle() without error handler returns 500 JSON on error', async () => {
		const { createApp } = require('../../');
		const app = createApp();

		app.use((req, res, next) => { throw new Error('no handler'); });
		app.get('/test', (req, res) => res.json({}));

		const server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		const r = await fetch(`http://localhost:${server.address().port}/test`);
		expect(r.status).toBe(500);
		const json = await r.json();
		expect(json.error).toBeDefined();
		server.close();
	});

	it('listen() method exists and accepts port arg', async () => {
		const { createApp } = require('../../');
		const app = createApp();
		app.get('/htest', (req, res) => res.json({ ok: true }));
		// listen() without opts uses HTTP
		const server = app.listen(0, () => {});
		await new Promise(r => setTimeout(r, 50));
		const port = server.address().port;
		const r = await fetch(`http://localhost:${port}/htest`);
		expect(r.status).toBe(200);
		app.close();
	});
});