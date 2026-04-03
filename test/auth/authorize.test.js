/**
 * Authorization helpers — comprehensive tests.
 * Covers: authorize (RBAC), can/canAny (permissions), Policy class,
 * gate middleware, attachUserHelpers, edge cases and security.
 */
const http = require('http');
const { doFetch, fetch } = require('../_helpers');
const { createApp, authorize, can, canAny, Policy, gate, attachUserHelpers, jwt, jwtSign, json } = require('../../');

const SECRET = 'authorize-test-secret-32-bytes-min!';

// Helper to create a test app with JWT + given middleware
function createTestApp(authMiddleware, handler)
{
    const app = createApp();
    app.use(json());
    app.use(jwt({ secret: SECRET, credentialsRequired: false }));
    app.get('/test', authMiddleware, handler || ((req, res) => res.json({ ok: true })));
    return app;
}

// =========================================================
// authorize() — Role-Based Access Control
// =========================================================

describe('Authorization: authorize()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: SECRET, credentialsRequired: false }));
        app.get('/admin', authorize('admin'), (req, res) => res.json({ role: req.user.role }));
        app.get('/multi', authorize('admin', 'editor'), (req, res) => res.json({ ok: true }));
        app.get('/flat-array', authorize(['admin', 'editor']), (req, res) => res.json({ ok: true }));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns 401 when not authenticated', async () =>
    {
        const r = await fetch(`${base}/admin`);
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 403 when user lacks required role', async () =>
    {
        const token = jwtSign({ sub: '1', role: 'user' }, SECRET);
        const r = await fetch(`${base}/admin`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
        const body = await r.json();
        expect(body.code).toBe('FORBIDDEN');
    });

    it('allows user with correct role', async () =>
    {
        const token = jwtSign({ sub: '1', role: 'admin' }, SECRET);
        const r = await fetch(`${base}/admin`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.role).toBe('admin');
    });

    it('allows any of the listed roles', async () =>
    {
        const editor = jwtSign({ sub: '2', role: 'editor' }, SECRET);
        const r = await fetch(`${base}/multi`, {
            headers: { 'Authorization': `Bearer ${editor}` },
        });
        expect(r.status).toBe(200);
    });

    it('supports roles as array on user object', async () =>
    {
        const token = jwtSign({ sub: '3', roles: ['viewer', 'editor'] }, SECRET);
        const r = await fetch(`${base}/multi`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('supports flat array argument', async () =>
    {
        const token = jwtSign({ sub: '4', role: 'editor' }, SECRET);
        const r = await fetch(`${base}/flat-array`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('denies when user has no role field', async () =>
    {
        const token = jwtSign({ sub: '5' }, SECRET); // no role
        const r = await fetch(`${base}/admin`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
    });
});

// =========================================================
// can() — Permission-Based Access Control
// =========================================================

describe('Authorization: can()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: SECRET, credentialsRequired: false }));
        app.get('/write', can('posts:write'), (req, res) => res.json({ ok: true }));
        app.get('/multi', can('posts:read', 'posts:write'), (req, res) => res.json({ ok: true }));
        app.get('/wildcard', can('anything'), (req, res) => res.json({ ok: true }));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns 401 when not authenticated', async () =>
    {
        const r = await fetch(`${base}/write`);
        expect(r.status).toBe(401);
    });

    it('returns 403 when permission is missing', async () =>
    {
        const token = jwtSign({ sub: '1', permissions: ['posts:read'] }, SECRET);
        const r = await fetch(`${base}/write`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
    });

    it('allows user with the required permission', async () =>
    {
        const token = jwtSign({ sub: '1', permissions: ['posts:write'] }, SECRET);
        const r = await fetch(`${base}/write`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('requires ALL listed permissions', async () =>
    {
        // Has only one of two required
        const token = jwtSign({ sub: '1', permissions: ['posts:read'] }, SECRET);
        const r = await fetch(`${base}/multi`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);

        // Has both
        const token2 = jwtSign({ sub: '1', permissions: ['posts:read', 'posts:write'] }, SECRET);
        const r2 = await fetch(`${base}/multi`, {
            headers: { 'Authorization': `Bearer ${token2}` },
        });
        expect(r2.status).toBe(200);
    });

    it('wildcard * grants all permissions', async () =>
    {
        const token = jwtSign({ sub: '1', permissions: ['*'] }, SECRET);
        const r = await fetch(`${base}/wildcard`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('supports scopes field as permissions source', async () =>
    {
        const token = jwtSign({ sub: '1', scopes: ['posts:write'] }, SECRET);
        const r = await fetch(`${base}/write`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });
});

// =========================================================
// canAny()
// =========================================================

describe('Authorization: canAny()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: SECRET, credentialsRequired: false }));
        app.get('/any', canAny('admin:read', 'reports:read'), (req, res) => res.json({ ok: true }));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('allows if user has any of the permissions', async () =>
    {
        const token = jwtSign({ sub: '1', permissions: ['reports:read'] }, SECRET);
        const r = await fetch(`${base}/any`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('denies if user has none of the permissions', async () =>
    {
        const token = jwtSign({ sub: '1', permissions: ['other:perm'] }, SECRET);
        const r = await fetch(`${base}/any`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
    });
});

// =========================================================
// Policy class
// =========================================================

describe('Authorization: Policy class', () =>
{
    class TestPolicy extends Policy
    {
        view() { return true; }
        update(user, resource) { return user.id === resource.authorId; }
        delete(user) { return user.role === 'admin'; }
    }

    const policy = new TestPolicy();

    it('check() calls the action method', () =>
    {
        expect(policy.check('view', { id: 1 })).toBe(true);
        expect(policy.check('update', { id: 1 }, { authorId: 1 })).toBe(true);
        expect(policy.check('update', { id: 1 }, { authorId: 2 })).toBe(false);
    });

    it('check() returns false for undefined actions', () =>
    {
        expect(policy.check('create', { id: 1 })).toBe(false);
    });

    it('supports before() hook for superuser override', () =>
    {
        class AdminPolicy extends Policy
        {
            before(user) { if (user.role === 'superadmin') return true; }
            update(user, resource) { return user.id === resource.authorId; }
        }
        const p = new AdminPolicy();
        expect(p.check('update', { role: 'superadmin', id: 99 }, { authorId: 1 })).toBe(true);
        expect(p.check('update', { role: 'user', id: 1 }, { authorId: 1 })).toBe(true);
        expect(p.check('update', { role: 'user', id: 2 }, { authorId: 1 })).toBe(false);
    });

    it('before() returning false blocks the action', () =>
    {
        class BlockPolicy extends Policy
        {
            before(user) { if (user.banned) return false; }
            view() { return true; }
        }
        const p = new BlockPolicy();
        expect(p.check('view', { banned: true })).toBe(false);
        expect(p.check('view', { banned: false })).toBe(true);
    });

    it('before() returning undefined falls through to action', () =>
    {
        class PassthroughPolicy extends Policy
        {
            before() { /* returns undefined */ }
            view() { return true; }
        }
        const p = new PassthroughPolicy();
        expect(p.check('view', {})).toBe(true);
    });
});

// =========================================================
// gate() middleware
// =========================================================

describe('Authorization: gate()', () =>
{
    class PostPolicy extends Policy
    {
        update(user, post) { return user.sub === post.authorId; }
        create(user) { return user.role === 'editor' || user.role === 'admin'; }
    }
    const postPolicy = new PostPolicy();

    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: SECRET, credentialsRequired: false }));

        // Gate with resource loader
        app.get('/posts/:id/edit', gate(postPolicy, 'update', async (req) =>
        {
            // Simulate database lookup
            return { id: req.params.id, authorId: 'user-42' };
        }), (req, res) =>
        {
            res.json({ ok: true, resource: req.resource });
        });

        // Gate without resource (create action)
        app.get('/posts/new', gate(postPolicy, 'create'), (req, res) =>
        {
            res.json({ ok: true });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns 401 when not authenticated', async () =>
    {
        const r = await fetch(`${base}/posts/1/edit`);
        expect(r.status).toBe(401);
    });

    it('returns 403 when policy denies', async () =>
    {
        const token = jwtSign({ sub: 'user-99' }, SECRET);
        const r = await fetch(`${base}/posts/1/edit`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
        const body = await r.json();
        expect(body.code).toBe('POLICY_DENIED');
    });

    it('allows when policy grants access', async () =>
    {
        const token = jwtSign({ sub: 'user-42' }, SECRET);
        const r = await fetch(`${base}/posts/1/edit`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.resource.authorId).toBe('user-42');
    });

    it('attaches loaded resource to req.resource', async () =>
    {
        const token = jwtSign({ sub: 'user-42' }, SECRET);
        const r = await fetch(`${base}/posts/1/edit`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const body = await r.json();
        expect(body.resource.id).toBe('1');
    });

    it('gate without getResource passes null', async () =>
    {
        const token = jwtSign({ sub: '1', role: 'editor' }, SECRET);
        const r = await fetch(`${base}/posts/new`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('denies create when role is wrong', async () =>
    {
        const token = jwtSign({ sub: '1', role: 'viewer' }, SECRET);
        const r = await fetch(`${base}/posts/new`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
    });
});

// =========================================================
// attachUserHelpers() middleware
// =========================================================

describe('Authorization: attachUserHelpers()', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: SECRET, credentialsRequired: false }));
        app.use(attachUserHelpers());

        app.get('/helpers', (req, res) =>
        {
            if (!req.user) return res.json({ noUser: true });
            res.json({
                isAdmin: req.user.is('admin'),
                isEditor: req.user.is('editor'),
                canWrite: req.user.can('posts:write'),
                canRead: req.user.can('posts:read'),
            });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('skips when no req.user', async () =>
    {
        const r = await fetch(`${base}/helpers`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.noUser).toBe(true);
    });

    it('adds is() helper to req.user', async () =>
    {
        const token = jwtSign({ sub: '1', role: 'admin' }, SECRET);
        const r = await fetch(`${base}/helpers`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const body = await r.json();
        expect(body.isAdmin).toBe(true);
        expect(body.isEditor).toBe(false);
    });

    it('adds can() helper to req.user', async () =>
    {
        const token = jwtSign({ sub: '1', permissions: ['posts:write'] }, SECRET);
        const r = await fetch(`${base}/helpers`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const body = await r.json();
        expect(body.canWrite).toBe(true);
        expect(body.canRead).toBe(false);
    });
});
