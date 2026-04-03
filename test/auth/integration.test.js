/**
 * Auth integration tests — end-to-end flows combining JWT, Session, and Authorization.
 */
const crypto = require('crypto');
const http = require('http');
const { doFetch, fetch } = require('../_helpers');
const {
    createApp, jwt, jwtSign, jwtVerify, jwtDecode,
    session, MemoryStore, cookieParser, json,
    authorize, can, gate, Policy, attachUserHelpers, tokenPair,
} = require('../../');

const SECRET = 'integration-test-secret-32-bytes!';

// =========================================================
// Full Auth Flow: JWT + RBAC
// =========================================================

describe('Integration: JWT + RBAC', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());
        app.use(jwt({ secret: SECRET }));

        app.get('/public', (req, res) => res.json({ public: true }));
        app.get('/user', authorize('user', 'admin'), (req, res) => res.json({ user: req.user.sub }));
        app.get('/admin', authorize('admin'), (req, res) => res.json({ admin: true }));
        app.delete('/danger', can('system:destroy'), (req, res) => res.json({ destroyed: true }));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('rejects unauthenticated request', async () =>
    {
        const r = await fetch(`${base}/user`);
        expect(r.status).toBe(401);
    });

    it('allows user with correct role', async () =>
    {
        const token = jwtSign({ sub: 'alice', role: 'user' }, SECRET);
        const r = await fetch(`${base}/user`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.user).toBe('alice');
    });

    it('denies user from admin route', async () =>
    {
        const token = jwtSign({ sub: 'alice', role: 'user' }, SECRET);
        const r = await fetch(`${base}/admin`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
    });

    it('allows admin everywhere', async () =>
    {
        const token = jwtSign({ sub: 'bob', role: 'admin', permissions: ['system:destroy'] }, SECRET);

        const r1 = await fetch(`${base}/user`, { headers: { 'Authorization': `Bearer ${token}` } });
        expect(r1.status).toBe(200);

        const r2 = await fetch(`${base}/admin`, { headers: { 'Authorization': `Bearer ${token}` } });
        expect(r2.status).toBe(200);

        const r3 = await fetch(`${base}/danger`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        expect(r3.status).toBe(200);
    });
});

// =========================================================
// Full Auth Flow: Session + Authorization
// =========================================================

describe('Integration: Session + Authorization', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(cookieParser());
        app.use(json());
        app.use(session({ secret: SECRET }));

        // Login route — set user in session
        app.post('/login', (req, res) =>
        {
            req.session.set('user', { id: req.body.id, role: req.body.role });
            res.json({ ok: true });
        });

        // Middleware to populate req.user from session
        app.use((req, res, next) =>
        {
            const user = req.session.get('user');
            if (user) req.user = user;
            next();
        });

        app.get('/profile', authorize('user', 'admin'), (req, res) =>
        {
            res.json({ id: req.user.id, role: req.user.role });
        });

        app.post('/logout', (req, res) =>
        {
            req.session.destroy();
            res.json({ ok: true });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('full login → profile → logout flow', async () =>
    {
        // Login
        const loginR = await fetch(`${base}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: '42', role: 'user' }),
        });
        expect(loginR.status).toBe(200);
        const cookies = loginR.headers.get('set-cookie').split(';')[0];

        // Access protected route
        const profileR = await fetch(`${base}/profile`, {
            headers: { Cookie: cookies },
        });
        expect(profileR.status).toBe(200);
        const profile = await profileR.json();
        expect(profile.id).toBe('42');
        expect(profile.role).toBe('user');

        // Logout
        const logoutR = await fetch(`${base}/logout`, {
            method: 'POST',
            headers: { Cookie: cookies },
        });
        expect(logoutR.status).toBe(200);

        // Profile should now fail (no session)
        const afterR = await fetch(`${base}/profile`);
        expect(afterR.status).toBe(401);
    });
});

// =========================================================
// Token Pair Refresh Flow
// =========================================================

describe('Integration: Token Pair Refresh', () =>
{
    let server, base;
    const tp = tokenPair({ accessSecret: SECRET, refreshSecret: SECRET + '-refresh', accessExpiresIn: 2 });

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());

        // Login
        app.post('/login', (req, res) =>
        {
            const { accessToken, refreshToken } = tp.generateTokens({ sub: req.body.userId });
            res.json({ accessToken, refreshToken });
        });

        // Protected
        app.use(jwt({ secret: SECRET, credentialsRequired: false }));
        app.get('/data', (req, res) =>
        {
            if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
            res.json({ data: 'secret', sub: req.user.sub });
        });

        // Refresh
        app.post('/refresh', (req, res) =>
        {
            try
            {
                const { payload } = tp.verifyRefreshToken(req.body.refreshToken);
                const { accessToken, refreshToken } = tp.generateTokens({ sub: payload.sub });
                res.json({ accessToken, refreshToken });
            }
            catch (err)
            {
                res.status(401).json({ error: 'Invalid refresh token' });
            }
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('login → access → refresh → access flow', async () =>
    {
        // Login
        const loginR = await fetch(`${base}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'user-1' }),
        });
        const { accessToken, refreshToken } = await loginR.json();
        expect(accessToken).toBeTruthy();
        expect(refreshToken).toBeTruthy();

        // Access with token
        const dataR = await fetch(`${base}/data`, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        expect(dataR.status).toBe(200);
        const data = await dataR.json();
        expect(data.sub).toBe('user-1');

        // Refresh
        const refreshR = await fetch(`${base}/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
        });
        const newTokens = await refreshR.json();
        expect(newTokens.accessToken).toBeTruthy();
        // Tokens generated at the same second with same payload may match
        // (no random jti by default), so just verify it's a valid token
        expect(typeof newTokens.accessToken).toBe('string');

        // Access with new token
        const dataR2 = await fetch(`${base}/data`, {
            headers: { 'Authorization': `Bearer ${newTokens.accessToken}` },
        });
        expect(dataR2.status).toBe(200);
    });
});

// =========================================================
// Policy + Gate Integration
// =========================================================

describe('Integration: Policy + Gate', () =>
{
    class ArticlePolicy extends Policy
    {
        before(user) { if (user.role === 'superadmin') return true; }
        view() { return true; }
        edit(user, article) { return user.sub === article.authorId || user.role === 'editor'; }
        delete(user) { return user.role === 'admin' || user.role === 'superadmin'; }
    }

    const articlePolicy = new ArticlePolicy();
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: SECRET, credentialsRequired: false }));

        app.get('/articles/:id', gate(articlePolicy, 'view'), (req, res) =>
        {
            res.json({ article: { id: req.params.id } });
        });

        app.put('/articles/:id', gate(articlePolicy, 'edit', async (req) =>
        {
            return { id: req.params.id, authorId: 'author-1' };
        }), (req, res) =>
        {
            res.json({ updated: true, resource: req.resource });
        });

        app.delete('/articles/:id', gate(articlePolicy, 'delete'), (req, res) =>
        {
            res.json({ deleted: true });
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('anyone can view (view returns true)', async () =>
    {
        const token = jwtSign({ sub: 'anyone' }, SECRET);
        const r = await fetch(`${base}/articles/1`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('author can edit their article', async () =>
    {
        const token = jwtSign({ sub: 'author-1' }, SECRET);
        const r = await fetch(`${base}/articles/1`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('editor can edit any article', async () =>
    {
        const token = jwtSign({ sub: 'editor-1', role: 'editor' }, SECRET);
        const r = await fetch(`${base}/articles/1`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('non-author non-editor cannot edit', async () =>
    {
        const token = jwtSign({ sub: 'random-user', role: 'viewer' }, SECRET);
        const r = await fetch(`${base}/articles/1`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
    });

    it('superadmin bypasses all checks (before hook)', async () =>
    {
        const token = jwtSign({ sub: 'super', role: 'superadmin' }, SECRET);
        
        const r1 = await fetch(`${base}/articles/1`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r1.status).toBe(200);

        const r2 = await fetch(`${base}/articles/1`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r2.status).toBe(200);
    });

    it('admin can delete', async () =>
    {
        const token = jwtSign({ sub: 'admin-1', role: 'admin' }, SECRET);
        const r = await fetch(`${base}/articles/1`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('non-admin cannot delete', async () =>
    {
        const token = jwtSign({ sub: 'user-1', role: 'user' }, SECRET);
        const r = await fetch(`${base}/articles/1`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(403);
    });
});

// =========================================================
// App convenience methods
// =========================================================

describe('Integration: App convenience methods', () =>
{
    it('app.jwtAuth() mounts JWT middleware', async () =>
    {
        const app = createApp();
        app.jwtAuth({ secret: SECRET });
        app.get('/test', (req, res) => res.json({ sub: req.user.sub }));

        const server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        const base = `http://localhost:${server.address().port}`;

        const token = jwtSign({ sub: 'conv' }, SECRET);
        const r = await fetch(`${base}/test`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.sub).toBe('conv');

        server.close();
    });

    it('app.sessions() mounts session middleware', async () =>
    {
        const app = createApp();
        app.use(cookieParser());
        app.sessions({ secret: SECRET });
        app.get('/test', (req, res) =>
        {
            req.session.set('x', 42);
            res.json({ ok: true });
        });

        const server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        const base = `http://localhost:${server.address().port}`;

        const r = await fetch(`${base}/test`);
        expect(r.status).toBe(200);
        expect(r.headers.get('set-cookie')).toContain('sid=');

        server.close();
    });

    it('app.oauth() creates an OAuth client', () =>
    {
        const app = createApp();
        const client = app.oauth({
            provider: 'github',
            clientId: 'test-id',
            clientSecret: 'test-secret',
            callbackUrl: 'http://localhost/cb',
        });
        expect(client.authorize).toBeTypeOf('function');
        expect(client.callback).toBeTypeOf('function');
    });
});

// =========================================================
// Exports test
// =========================================================

describe('Integration: Module exports', () =>
{
    it('all auth exports are available from root', () =>
    {
        const z = require('../../');
        // JWT
        expect(z.jwt).toBeTypeOf('function');
        expect(z.jwtSign).toBeTypeOf('function');
        expect(z.jwtVerify).toBeTypeOf('function');
        expect(z.jwtDecode).toBeTypeOf('function');
        expect(z.jwks).toBeTypeOf('function');
        expect(z.tokenPair).toBeTypeOf('function');
        expect(z.createRefreshToken).toBeTypeOf('function');
        expect(z.SUPPORTED_ALGORITHMS).toBeInstanceOf(Array);
        // Session
        expect(z.session).toBeTypeOf('function');
        expect(z.Session).toBeTypeOf('function');
        expect(z.MemoryStore).toBeTypeOf('function');
        // OAuth
        expect(z.oauth).toBeTypeOf('function');
        expect(z.generatePKCE).toBeTypeOf('function');
        expect(z.generateState).toBeTypeOf('function');
        expect(z.OAUTH_PROVIDERS).toBeTypeOf('object');
        // Authorization
        expect(z.authorize).toBeTypeOf('function');
        expect(z.can).toBeTypeOf('function');
        expect(z.canAny).toBeTypeOf('function');
        expect(z.Policy).toBeTypeOf('function');
        expect(z.gate).toBeTypeOf('function');
        expect(z.attachUserHelpers).toBeTypeOf('function');
    });
});
