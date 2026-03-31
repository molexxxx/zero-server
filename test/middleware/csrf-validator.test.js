/**
 * Tests for CSRF and Validator middleware.
 */
const http = require('http');
const { doFetch, fetch } = require('../_helpers');
const { createApp, csrf, validate, cookieParser, json } = require('../../');

// -- CSRF Middleware -------------------------------------

describe('CSRF Middleware', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(cookieParser());
        app.use(json());
        app.use(csrf({ cookie: '_csrf' }));
        app.get('/token', (req, res) => res.json({ token: req.csrfToken }));
        app.post('/submit', (req, res) => res.json({ ok: true, token: req.csrfToken }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('GET sets csrf cookie and returns token', async () =>
    {
        const r = await fetch(`${base}/token`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.token).toBeDefined();
        expect(typeof body.token).toBe('string');
        expect(body.token).toContain('.');
    });

    it('POST without token returns 403', async () =>
    {
        const r = await fetch(`${base}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: 'test' }),
        });
        expect(r.status).toBe(403);
    });

    it('POST with valid token succeeds', async () =>
    {
        // Step 1: Get token
        const getRes = await fetch(`${base}/token`);
        const { token } = await getRes.json();
        const cookies = getRes.headers.get('set-cookie');

        // Step 2: POST with token in header and cookie
        const r = await fetch(`${base}/submit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
                'Cookie': cookies,
            },
            body: JSON.stringify({ data: 'test' }),
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.ok).toBe(true);
    });

    it('POST with wrong token returns 403', async () =>
    {
        // Get a real cookie
        const getRes = await fetch(`${base}/token`);
        const cookies = getRes.headers.get('set-cookie');

        const r = await fetch(`${base}/submit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': 'bad.token',
                'Cookie': cookies,
            },
            body: JSON.stringify({}),
        });
        expect(r.status).toBe(403);
    });
});

describe('CSRF — ignorePaths', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(cookieParser());
        app.use(json());
        app.use(csrf({ ignorePaths: ['/api/webhooks'] }));
        app.post('/api/webhooks/stripe', (req, res) => res.json({ ok: true }));
        app.post('/protected', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('ignored path bypasses CSRF', async () =>
    {
        const r = await fetch(`${base}/api/webhooks/stripe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'test' }),
        });
        expect(r.status).toBe(200);
    });

    it('non-ignored path still requires CSRF', async () =>
    {
        const r = await fetch(`${base}/protected`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(r.status).toBe(403);
    });
});

// -- Validator Middleware ---------------------------------

describe('Validator Middleware', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());
        app.post('/users', validate({
            body: {
                name:  { type: 'string', required: true, minLength: 1, maxLength: 100 },
                email: { type: 'email', required: true },
                age:   { type: 'integer', min: 0, max: 150 },
            },
        }), (req, res) => res.json({ user: req.body }));

        app.get('/search', validate({
            query: {
                q:     { type: 'string', required: true },
                page:  { type: 'integer', default: 1, min: 1 },
                limit: { type: 'integer', default: 20, min: 1, max: 100 },
            },
        }), (req, res) => res.json(req.query));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('valid body passes through', async () =>
    {
        const r = await fetch(`${base}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Alice', email: 'alice@x.com', age: 30 }),
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.user.name).toBe('Alice');
        expect(body.user.age).toBe(30);
    });

    it('missing required field returns 422', async () =>
    {
        const r = await fetch(`${base}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'alice@x.com' }),
        });
        expect(r.status).toBe(422);
        const body = await r.json();
        expect(body.errors).toBeDefined();
        expect(body.errors.some(e => e.includes('name'))).toBe(true);
    });

    it('invalid email returns 422', async () =>
    {
        const r = await fetch(`${base}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Alice', email: 'not-an-email' }),
        });
        expect(r.status).toBe(422);
        const body = await r.json();
        expect(body.errors.some(e => e.includes('email'))).toBe(true);
    });

    it('integer out of range returns 422', async () =>
    {
        const r = await fetch(`${base}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Alice', email: 'a@b.com', age: -5 }),
        });
        expect(r.status).toBe(422);
        const body = await r.json();
        expect(body.errors.some(e => e.includes('age'))).toBe(true);
    });

    it('query validation with defaults', async () =>
    {
        const r = await fetch(`${base}/search?q=hello`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.q).toBe('hello');
        expect(body.page).toBe(1);
        expect(body.limit).toBe(20);
    });

    it('query validation fails on missing required', async () =>
    {
        const r = await fetch(`${base}/search`);
        expect(r.status).toBe(422);
    });

    it('coerces string query params to integer', async () =>
    {
        const r = await fetch(`${base}/search?q=test&page=3&limit=50`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.page).toBe(3);
        expect(body.limit).toBe(50);
    });
});

describe('Validator — standalone helpers', () =>
{
    it('validate.field() validates a single field', () =>
    {
        const { value, error } = validate.field('hello', { type: 'string', minLength: 1 }, 'name');
        expect(value).toBe('hello');
        expect(error).toBeNull();
    });

    it('validate.field() returns error on required missing', () =>
    {
        const { error } = validate.field(undefined, { type: 'string', required: true }, 'name');
        expect(error).toContain('required');
    });

    it('validate.object() validates an entire object', () =>
    {
        const schema = {
            name: { type: 'string', required: true },
            age:  { type: 'integer', min: 0 },
        };
        const { sanitized, errors } = validate.object({ name: 'Test', age: '25', extra: 'x' }, schema);
        expect(errors).toHaveLength(0);
        expect(sanitized.name).toBe('Test');
        expect(sanitized.age).toBe(25);
        expect(sanitized.extra).toBeUndefined(); // stripped
    });

    it('validate.field() applies custom validator', () =>
    {
        const rule = {
            type: 'string',
            validate: v => v.startsWith('X') ? null : 'must start with X',
        };
        const { error } = validate.field('ABC', rule, 'code');
        expect(error).toBe('must start with X');
    });

    it('validate.field() supports enum validation', () =>
    {
        const { error } = validate.field('red', { type: 'string', enum: ['blue', 'green'] }, 'color');
        expect(error).toContain('one of');
    });

    it('validate.field() supports url type', () =>
    {
        const { error } = validate.field('not-url', { type: 'url' }, 'site');
        expect(error).toContain('URL');
    });

    it('validate.field() supports uuid type', () =>
    {
        const { error } = validate.field('not-a-uuid', { type: 'uuid' }, 'uid');
        expect(error).toContain('UUID');
    });

    it('validate.field() validates boolean type', () =>
    {
        const { value, error } = validate.field('yes', { type: 'boolean' }, 'active');
        expect(error).toBeNull();
        expect(value).toBe(true);
    });

    it('validate.field() coerces array from string', () =>
    {
        const { value } = validate.field('a,b,c', { type: 'array' }, 'tags');
        expect(value).toEqual(['a', 'b', 'c']);
    });
});



// =========================================================================
//  csrf — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  7. CSRF — BODY/QUERY TOKEN, IGNOREMETHODS, ONERROR
// ============================================================
describe('csrf — token from body._csrf', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, csrf, json, cookieParser } = require('../../');
		const app = createApp();
		app.use(cookieParser('secret'));
		app.use(json());
		app.use(csrf());
		app.get('/token', (req, res) => res.json({ token: req.csrfToken }));
		app.post('/check', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('accepts token from body._csrf field', async () => {
		// Get token
		const r1 = await new Promise((resolve, reject) => {
			http.get(`${base}/token`, (resp) => {
				let body = '';
				resp.on('data', c => body += c);
				resp.on('end', () => resolve({
					body: JSON.parse(body),
					cookies: resp.headers['set-cookie'],
				}));
			}).on('error', reject);
		});
		const token = r1.body.token;
		const cookie = r1.cookies[0].split(';')[0];

		// POST with token in body
		const r2 = await new Promise((resolve, reject) => {
			const data = JSON.stringify({ _csrf: token });
			const req = http.request(`${base}/check`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'cookie': cookie,
				},
			}, (resp) => {
				let body = '';
				resp.on('data', c => body += c);
				resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(body) }));
			});
			req.on('error', reject);
			req.write(data);
			req.end();
		});
		expect(r2.status).toBe(200);
		expect(r2.body.ok).toBe(true);
	});
});

describe('csrf — token from query._csrf', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, csrf, json, cookieParser } = require('../../');
		const app = createApp();
		app.use(cookieParser('secret'));
		app.use(json());
		app.use(csrf());
		app.get('/token', (req, res) => res.json({ token: req.csrfToken }));
		app.post('/check', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('accepts token from query string', async () => {
		const r1 = await new Promise((resolve, reject) => {
			http.get(`${base}/token`, (resp) => {
				let body = '';
				resp.on('data', c => body += c);
				resp.on('end', () => resolve({
					body: JSON.parse(body),
					cookies: resp.headers['set-cookie'],
				}));
			}).on('error', reject);
		});
		const token = r1.body.token;
		const cookie = r1.cookies[0].split(';')[0];

		const r2 = await new Promise((resolve, reject) => {
			const req = http.request(`${base}/check?_csrf=${encodeURIComponent(token)}`, {
				method: 'POST',
				headers: { 'cookie': cookie },
			}, (resp) => {
				let body = '';
				resp.on('data', c => body += c);
				resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(body) }));
			});
			req.on('error', reject);
			req.end();
		});
		expect(r2.status).toBe(200);
	});
});

describe('csrf — ignoreMethods', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, csrf, cookieParser } = require('../../');
		const app = createApp();
		app.use(cookieParser('secret'));
		app.use(csrf({ ignoreMethods: ['GET', 'HEAD', 'OPTIONS', 'POST'] }));
		app.post('/free', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('skips CSRF check for ignored methods', async () => {
		const r = await fetch(`${base}/free`, { method: 'POST' });
		expect(r.status).toBe(200);
	});
});

describe('csrf — custom onError', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, csrf, cookieParser } = require('../../');
		const app = createApp();
		app.use(cookieParser('secret'));
		app.use(csrf({
			onError: (req, res) => {
				res.status(418).json({ custom: 'csrf failed' });
			},
		}));
		app.post('/check', (req, res) => res.json({ ok: true }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('uses custom onError handler', async () => {
		const r = await fetch(`${base}/check`, { method: 'POST' });
		expect(r.status).toBe(418);
		const body = await r.json();
		expect(body.custom).toBe('csrf failed');
	});
});

// =========================================================================
//  validator — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  9. VALIDATOR — PARAMS, DATE/FLOAT/JSON, ITEMS, STRIPUNKNOWN, ONERROR
// ============================================================
describe('validator — params validation', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate } = require('../../');
		const app = createApp();
		app.get('/users/:id', validate({
			params: {
				id: { type: 'integer', required: true, min: 1 },
			},
		}), (req, res) => res.json({ id: req.params.id }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('validates and coerces params', async () => {
		const r = await fetch(`${base}/users/42`);
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.id).toBe(42);
	});

	it('rejects invalid params', async () => {
		const r = await fetch(`${base}/users/0`);
		expect(r.status).toBe(422);
	});
});

describe('validator — date type', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate, json } = require('../../');
		const app = createApp();
		app.use(json());
		app.post('/check', validate({
			body: {
				date: { type: 'date', required: true },
			},
		}), (req, res) => {
			res.json({ isDate: req.body.date instanceof Date, iso: req.body.date.toISOString() });
		});

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('coerces valid date string', async () => {
		const { data } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ date: '2024-01-15T00:00:00Z' }),
		});
		expect(data.isDate).toBe(true);
		expect(data.iso).toContain('2024-01-15');
	});

	it('rejects invalid date', async () => {
		const { status } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ date: 'not-a-date' }),
		});
		expect(status).toBe(422);
	});
});

describe('validator — float type', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate, json } = require('../../');
		const app = createApp();
		app.use(json());
		app.post('/check', validate({
			body: {
				price: { type: 'float', required: true, min: 0 },
			},
		}), (req, res) => res.json({ price: req.body.price }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('coerces float value from string', async () => {
		const { data } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ price: '19.99' }),
		});
		expect(data.price).toBeCloseTo(19.99);
	});
});

describe('validator — json type', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate, json } = require('../../');
		const app = createApp();
		app.use(json());
		app.post('/check', validate({
			body: {
				config: { type: 'json' },
			},
		}), (req, res) => res.json({ config: req.body.config }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('coerces JSON string to object', async () => {
		const { data } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ config: '{"key":"val"}' }),
		});
		expect(data.config).toEqual({ key: 'val' });
	});
});

describe('validator — array minItems/maxItems', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate, json } = require('../../');
		const app = createApp();
		app.use(json());
		app.post('/check', validate({
			body: {
				tags: { type: 'array', minItems: 1, maxItems: 3 },
			},
		}), (req, res) => res.json({ tags: req.body.tags }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('rejects array below minItems', async () => {
		const { status } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tags: [] }),
		});
		expect(status).toBe(422);
	});

	it('rejects array above maxItems', async () => {
		const { status } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tags: ['a', 'b', 'c', 'd'] }),
		});
		expect(status).toBe(422);
	});

	it('accepts valid array', async () => {
		const { status, data } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tags: ['a', 'b'] }),
		});
		expect(status).toBe(200);
		expect(data.tags).toEqual(['a', 'b']);
	});
});

describe('validator — stripUnknown via middleware', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate, json } = require('../../');
		const app = createApp();
		app.use(json());
		app.post('/strict', validate({
			body: { name: { type: 'string', required: true } },
		}, { stripUnknown: true }), (req, res) => res.json(req.body));

		app.post('/loose', validate({
			body: { name: { type: 'string', required: true } },
		}, { stripUnknown: false }), (req, res) => res.json(req.body));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('strips unknown fields by default', async () => {
		const { data } = await doFetch(`${base}/strict`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Alice', extra: 'ignored' }),
		});
		expect(data.name).toBe('Alice');
		expect(data.extra).toBeUndefined();
	});

	it('preserves unknown fields when stripUnknown is false', async () => {
		const { data } = await doFetch(`${base}/loose`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Alice', extra: 'kept' }),
		});
		expect(data.name).toBe('Alice');
		expect(data.extra).toBe('kept');
	});
});

describe('validator — custom onError', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate, json } = require('../../');
		const app = createApp();
		app.use(json());
		app.post('/check', validate({
			body: { name: { type: 'string', required: true } },
		}, {
			onError: (errors, req, res) => {
				res.status(400).json({ custom: true, errors });
			},
		}), (req, res) => res.json(req.body));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('uses custom onError handler', async () => {
		const { status, data } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(status).toBe(400);
		expect(data.custom).toBe(true);
		expect(data.errors.length).toBeGreaterThan(0);
	});
});

describe('validator — custom validate function', () => {
	it('validate.field supports custom validator', () => {
		const { validate } = require('../../');
		const { value, error } = validate.field('abc', {
			type: 'string',
			validate: (v) => v.length < 5 ? 'too short' : undefined,
		}, 'field');
		expect(error).toBe('too short');
	});
});

describe('validator — url type', () => {
	let server, base;

	beforeAll(async () => {
		const { createApp, validate, json } = require('../../');
		const app = createApp();
		app.use(json());
		app.post('/check', validate({
			body: { website: { type: 'url', required: true } },
		}), (req, res) => res.json({ website: req.body.website }));

		server = http.createServer(app.handler);
		await new Promise(r => server.listen(0, r));
		base = `http://localhost:${server.address().port}`;
	});

	afterAll(() => server?.close());

	it('accepts valid URL', async () => {
		const { status } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ website: 'https://example.com' }),
		});
		expect(status).toBe(200);
	});

	it('rejects invalid URL', async () => {
		const { status } = await doFetch(`${base}/check`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ website: 'not a url' }),
		});
		expect(status).toBe(422);
	});
});

describe('validator — uuid type', () => {
	it('validates UUID format', () => {
		const { validate } = require('../../');
		const good = validate.field('550e8400-e29b-41d4-a716-446655440000', { type: 'uuid' }, 'id');
		expect(good.error).toBeNull();
		const bad = validate.field('not-a-uuid', { type: 'uuid' }, 'id');
		expect(bad.error).toBeTruthy();
	});
});