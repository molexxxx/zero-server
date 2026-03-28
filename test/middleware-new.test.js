/**
 * Tests for CSRF and Validator middleware.
 */
const http = require('http');
const { doFetch, fetch } = require('./_helpers');
const { createApp, csrf, validate, cookieParser, json } = require('../');

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
