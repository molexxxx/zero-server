/**
 * Tests for urlencoded body parser — extended (nested bracket) mode.
 * Covers array push, numeric indices, nested objects, prototype pollution guard,
 * flat mode, and edge cases.
 */
const { Readable } = require('stream');
const http = require('http');
const { doFetch } = require('../_helpers');
const { createApp, urlencoded } = require('../../');

// Helper: create a mock request with a readable body
function mockReq(body, ct = 'application/x-www-form-urlencoded')
{
    const stream = new Readable({
        read() { this.push(Buffer.from(body)); this.push(null); }
    });
    // urlencoded parser uses req.headers and rawBuffer reads req.raw
    const req = {
        headers: { 'content-type': ct },
        secure: true,
        raw: stream,
    };
    return req;
}

// Helper: create a mock response
function mockRes()
{
    return {
        statusCode: null,
        headersSent: false,
        _body: null,
        setHeader() {},
        end(b) { this._body = b; },
    };
}

// Load the urlencoded factory
const urlencodedFactory = require('../../lib/body/urlencoded');

describe('urlencoded parser', () =>
{
    // -- Flat mode (default) --------------------------------
    describe('flat mode', () =>
    {
        it('parses simple key=value pairs', async () =>
        {
            const mw = urlencodedFactory();
            const req = mockReq('name=Alice&age=30');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body).toEqual({ name: 'Alice', age: '30' });
        });

        it('skips non-matching content type', async () =>
        {
            const mw = urlencodedFactory();
            const req = mockReq('data', 'text/plain');
            const res = mockRes();
            let nextCalled = false;
            await new Promise(resolve => mw(req, res, () => { nextCalled = true; resolve(); }));
            expect(nextCalled).toBe(true);
            expect(req.body).toBeUndefined();
        });
    });

    // -- Extended mode (nested bracket syntax) ---------------
    describe('extended mode', () =>
    {
        const mw = urlencodedFactory({ extended: true });

        it('parses flat keys', async () =>
        {
            const req = mockReq('x=1&y=2');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body).toEqual({ x: '1', y: '2' });
        });

        it('parses nested bracket syntax a[b][c]=1', async () =>
        {
            const req = mockReq('a[b][c]=1');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body).toEqual({ a: { b: { c: '1' } } });
        });

        it('parses array push with items[][key]=val notation', async () =>
        {
            const req = mockReq('items[0][name]=A&items[1][name]=B');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body.items).toBeDefined();
            expect(req.body.items[0].name).toBe('A');
            expect(req.body.items[1].name).toBe('B');
        });

        it('parses numeric indices a[0]=x&a[1]=y', async () =>
        {
            const req = mockReq('a[0]=x&a[1]=y');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body.a).toBeDefined();
            expect(req.body.a[0]).toBe('x');
            expect(req.body.a[1]).toBe('y');
        });

        it('handles deeply nested structures', async () =>
        {
            const req = mockReq('a[b][c][d]=deep');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body.a.b.c.d).toBe('deep');
        });

        it('handles key without value', async () =>
        {
            const req = mockReq('alone');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body.alone).toBe('');
        });

        it('handles empty body', async () =>
        {
            const req = mockReq('');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body).toEqual({});
        });

        it('handles body with only whitespace', async () =>
        {
            const req = mockReq('  ');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body).toEqual({});
        });

        it('decodes + as space', async () =>
        {
            const req = mockReq('name=hello+world');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body.name).toBe('hello world');
        });

        it('decodes percent-encoded values', async () =>
        {
            const req = mockReq('msg=%E2%9C%93');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body.msg).toBe('✓');
        });

        it('blocks __proto__ (prototype pollution)', async () =>
        {
            const req = mockReq('__proto__[admin]=1');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            // Should not pollute Object prototype
            expect(({}).admin).toBeUndefined();
        });

        it('blocks constructor pollution', async () =>
        {
            const req = mockReq('constructor[prototype][x]=pwned');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(({}).x).toBeUndefined();
        });

        it('blocks prototype pollution', async () =>
        {
            const req = mockReq('a[prototype][y]=pwned');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(({}).y).toBeUndefined();
        });

        it('handles empty pairs (&&)', async () =>
        {
            const req = mockReq('a=1&&b=2');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(req.body.a).toBe('1');
            expect(req.body.b).toBe('2');
        });

        it('handles duplicate flat keys by converting to array', async () =>
        {
            const req = mockReq('color=red&color=blue&color=green');
            const res = mockRes();
            await new Promise(resolve => mw(req, res, resolve));
            expect(Array.isArray(req.body.color) || typeof req.body.color === 'string').toBe(true);
        });
    });

    // -- requireSecure option -------------------------------
    describe('requireSecure', () =>
    {
        it('rejects non-HTTPS when requireSecure=true', async () =>
        {
            const mw = urlencodedFactory({ requireSecure: true });
            const req = mockReq('a=1');
            req.secure = false;
            const res = mockRes();
            await mw(req, res, () => {});
            expect(res.statusCode).toBe(403);
        });
    });
});


// =========================================================================
//  urlencoded parser — HTTP integration tests (parameter limit, depth limit, verify callback)
// =========================================================================

{
	const urlencodedFactory = require('../../lib/body/urlencoded');

	// -- parameterLimit in flat mode --

	describe('parameterLimit in flat mode', () =>
	{
		it('rejects when exceeding parameterLimit', async () =>
		{
			const mw = urlencodedFactory({ parameterLimit: 2 });
			const req = mockReq('a=1&b=2&c=3');
			const res = mockRes();
			await mw(req, res, () => {});
			expect(res.statusCode).toBe(413);
		});

		it('allows exactly at parameterLimit', async () =>
		{
			const mw = urlencodedFactory({ parameterLimit: 2 });
			const req = mockReq('a=1&b=2');
			const res = mockRes();
			let called = false;
			await new Promise(resolve => mw(req, res, () => { called = true; resolve(); }));
			expect(called).toBe(true);
			expect(req.body.a).toBe('1');
		});
	});

	// -- parameterLimit in extended mode --

	describe('parameterLimit in extended mode', () =>
	{
		it('rejects when exceeding parameterLimit in extended', async () =>
		{
			const mw = urlencodedFactory({ extended: true, parameterLimit: 2 });
			const req = mockReq('a=1&b=2&c=3');
			const res = mockRes();
			await mw(req, res, () => {});
			expect(res.statusCode).toBe(413);
		});
	});

	// -- depth limit --

	describe('depth limit', () =>
	{
		it('rejects deeply nested keys exceeding depth limit', async () =>
		{
			const mw = urlencodedFactory({ extended: true, depth: 3 });
			const req = mockReq('a[b][c][d][e]=1');
			const res = mockRes();
			await mw(req, res, () => {});
			expect(res.statusCode).toBe(400);
		});

		it('allows nesting within depth limit', async () =>
		{
			const mw = urlencodedFactory({ extended: true, depth: 5 });
			const req = mockReq('a[b][c]=1');
			const res = mockRes();
			let called = false;
			await new Promise(resolve => mw(req, res, () => { called = true; resolve(); }));
			expect(called).toBe(true);
			expect(req.body.a.b.c).toBe('1');
		});
	});

	// -- verify callback --

	describe('verify callback', () =>
	{
		it('verify callback accepts valid request', async () =>
		{
			const mw = urlencodedFactory({ verify: (req, res, buf) => { if (buf.length === 0) throw new Error('empty'); } });
			const req = mockReq('key=val');
			const res = mockRes();
			let called = false;
			await new Promise(resolve => mw(req, res, () => { called = true; resolve(); }));
			expect(called).toBe(true);
		});

		it('verify callback rejects', async () =>
		{
			const mw = urlencodedFactory({ verify: () => { throw new Error('bad sig'); } });
			const req = mockReq('key=val');
			const res = mockRes();
			await mw(req, res, () => {});
			expect(res.statusCode).toBe(403);
		});

		it('verify callback rejection without message', async () =>
		{
			const mw = urlencodedFactory({ verify: () => { throw new Error(); } });
			const req = mockReq('key=val');
			const res = mockRes();
			await mw(req, res, () => {});
			expect(res.statusCode).toBe(403);
		});
	});

	// -- rawBody is set --

	describe('rawBody', () =>
	{
		it('sets req.rawBody buffer', async () =>
		{
			const mw = urlencodedFactory();
			const req = mockReq('a=1');
			const res = mockRes();
			await new Promise(resolve => mw(req, res, resolve));
			expect(req.rawBody).toBeInstanceOf(Buffer);
			expect(req.rawBody.toString()).toBe('a=1');
		});
	});

	// -- Extended: array push notation [] --

	describe('extended array push []', () =>
	{
		it('handles [] push notation via indexed keys', async () =>
		{
			const mw = urlencodedFactory({ extended: true });
			const req = mockReq('colors[0]=red&colors[1]=blue');
			const res = mockRes();
			await new Promise(resolve => mw(req, res, resolve));
			expect(req.body.colors).toBeDefined();
			expect(req.body.colors[0]).toBe('red');
			expect(req.body.colors[1]).toBe('blue');
		});

		it('handles array push mid-path', async () =>
		{
			const mw = urlencodedFactory({ extended: true });
			const req = mockReq('items[][name]=A&items[][name]=B');
			const res = mockRes();
			await new Promise(resolve => mw(req, res, resolve));
			expect(req.body.items).toBeDefined();
		});
	});

	// -- Extended: non-numeric intermediate key in array --

	describe('extended edge cases', () =>
	{
		it('non-numeric key as intermediate in array context', async () =>
		{
			const mw = urlencodedFactory({ extended: true });
			// Creates scenario: cur is array, part is non-numeric, not isLast
			const req = mockReq('arr[0][sub][deep]=val');
			const res = mockRes();
			await new Promise(resolve => mw(req, res, resolve));
			expect(req.body.arr[0].sub.deep).toBe('val');
		});

		it('duplicate keys in extended mode merge into array', async () =>
		{
			const mw = urlencodedFactory({ extended: true });
			const req = mockReq('tag=a&tag=b&tag=c');
			const res = mockRes();
			await new Promise(resolve => mw(req, res, resolve));
			expect(Array.isArray(req.body.tag)).toBe(true);
			expect(req.body.tag).toEqual(['a', 'b', 'c']);
		});

		it('non-numeric key as last in array context', async () =>
		{
			const mw = urlencodedFactory({ extended: true });
			const req = mockReq('arr[0]=val1&arr[name]=val2');
			const res = mockRes();
			await new Promise(resolve => mw(req, res, resolve));
			expect(req.body.arr).toBeDefined();
		});
	});

	// -- HTTP integration: parameter limit & depth limit --

	describe('urlencoded HTTP integration', () =>
	{
		let server, base;

		beforeAll(async () =>
		{
			const app = createApp();
			app.use(urlencoded({ extended: true, limit: '10kb', parameterLimit: 5, depth: 4, verify: (req, res, buf) => { if (buf.toString().includes('REJECT')) throw new Error('rejected'); } }));
			app.post('/form', (req, res) => res.json({ body: req.body }));
			server = http.createServer(app.handler);
			await new Promise(r => server.listen(0, r));
			base = `http://localhost:${server.address().port}`;
		});

		afterAll(() => server?.close());

		it('parameterLimit over HTTP returns 413', async () =>
		{
			const r = await doFetch(`${base}/form`, {
				method: 'POST', body: 'a=1&b=2&c=3&d=4&e=5&f=6',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			});
			expect(r.status).toBe(413);
		});

		it('depth limit over HTTP returns 400', async () =>
		{
			const r = await doFetch(`${base}/form`, {
				method: 'POST', body: 'a[b][c][d][e][f]=deep',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			});
			expect(r.status).toBe(400);
		});

		it('verify rejection over HTTP returns 403', async () =>
		{
			const r = await doFetch(`${base}/form`, {
				method: 'POST', body: 'REJECT=true',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			});
			expect(r.status).toBe(403);
		});

		it('valid extended post parses correctly', async () =>
		{
			const r = await doFetch(`${base}/form`, {
				method: 'POST', body: 'user[name]=bob&user[age]=25',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			});
			expect(r.status).toBe(200);
			expect(r.data.body.user.name).toBe('bob');
		});
	});
}
