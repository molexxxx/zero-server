const http = require('http');
const { doFetch, fetch } = require('../_helpers');
const { createApp, Router } = require('../../');

describe('Router Edge Cases', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/files/*', (req, res) => res.json({ wildcard: req.params[0] }));
        app.get('/users/:userId/posts/:postId', (req, res) => {
            res.json({ userId: req.params.userId, postId: req.params.postId });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('wildcard captures path', async () => {
        const r = await doFetch(`${base}/files/deep/path/file.txt`);
        expect(r.data.wildcard).toBe('deep/path/file.txt');
    });

    it('multiple params captured', async () => {
        const r = await doFetch(`${base}/users/42/posts/99`);
        expect(r.data.userId).toBe('42');
        expect(r.data.postId).toBe('99');
    });

    it('unregistered method returns 404', async () => {
        const r = await doFetch(`${base}/files/anything`, { method: 'TRACE' });
        expect(r.status).toBe(404);
    });
});

describe('Error Handling Edge Cases', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.onError((err, req, res) => {
            res.status(500).json({ custom: true, message: err.message });
        });
        app.use((req, res, next) => {
            if (req.url.startsWith('/mw-error')) throw new Error('middleware boom');
            next();
        });
        app.get('/mw-error', (req, res) => res.json({ ok: true }));
        app.get('/ok-route', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('500 on middleware error with custom handler', async () => {
        const r = await doFetch(`${base}/mw-error`);
        expect(r.status).toBe(500);
        expect(r.data.custom).toBe(true);
        expect(r.data.message).toBe('middleware boom');
    });

    it('normal route still works', async () => {
        const r = await doFetch(`${base}/ok-route`);
        expect(r.status).toBe(200);
    });
});

// ===========================================================
//  route() chaining
// ===========================================================
describe('Router - route() chaining', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        const router = Router();
        router.route('/items')
            .get((req, res) => res.json({ method: 'GET' }))
            .post((req, res) => res.json({ method: 'POST' }))
            .delete((req, res) => res.json({ method: 'DELETE' }));
        app.use('/api', router);
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('GET via route chain', async () => {
        const r = await doFetch(`${base}/api/items`);
        expect(r.data.method).toBe('GET');
    });

    it('POST via route chain', async () => {
        const r = await doFetch(`${base}/api/items`, { method: 'POST' });
        expect(r.data.method).toBe('POST');
    });

    it('DELETE via route chain', async () => {
        const r = await doFetch(`${base}/api/items`, { method: 'DELETE' });
        expect(r.data.method).toBe('DELETE');
    });

    it('unregistered method on chained route returns 404', async () => {
        const r = await doFetch(`${base}/api/items`, { method: 'PATCH' });
        expect(r.status).toBe(404);
    });
});

// ===========================================================
//  inspect() - route introspection
// ===========================================================
describe('Router - inspect()', () => {
    it('lists all routes in flat format', () => {
        const router = Router();
        router.get('/a', () => {});
        router.post('/b', () => {});
        const list = router.inspect();
        expect(list).toEqual([
            { method: 'GET', path: '/a' },
            { method: 'POST', path: '/b' },
        ]);
    });

    it('includes child router routes with prefix', () => {
        const parent = Router();
        const child = Router();
        child.get('/items', () => {});
        child.post('/items', () => {});
        parent.use('/api', child);
        const list = parent.inspect();
        expect(list).toEqual([
            { method: 'GET', path: '/api/items' },
            { method: 'POST', path: '/api/items' },
        ]);
    });

    it('accumulates prefixes for deeply nested routers', () => {
        const root = Router();
        const v1 = Router();
        const users = Router();
        users.get('/:id', () => {});
        v1.use('/users', users);
        root.use('/api/v1', v1);
        const list = root.inspect();
        expect(list[0].path).toBe('/api/v1/users/:id');
    });

    it('includes secure flag on routes', () => {
        const router = Router();
        router.get('/sec', { secure: true }, () => {});
        router.get('/any', () => {});
        const list = router.inspect();
        expect(list[0].secure).toBe(true);
        expect(list[1].secure).toBeUndefined();
    });
});

// ===========================================================
//  Nested sub-routers
// ===========================================================
describe('Router - nested sub-routers', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        const api = Router();
        const v1 = Router();
        const users = Router();
        users.get('/', (req, res) => res.json({ route: 'user-list' }));
        users.get('/:id', (req, res) => res.json({ route: 'user-detail', id: req.params.id }));
        v1.use('/users', users);
        api.use('/v1', v1);
        app.use('/api', api);
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('3-level nested route works', async () => {
        const r = await doFetch(`${base}/api/v1/users`);
        expect(r.data.route).toBe('user-list');
    });

    it('3-level nested param works', async () => {
        const r = await doFetch(`${base}/api/v1/users/42`);
        expect(r.data.route).toBe('user-detail');
        expect(r.data.id).toBe('42');
    });

    it('wrong prefix returns 404', async () => {
        const r = await doFetch(`${base}/api/v2/users`);
        expect(r.status).toBe(404);
    });
});

// ===========================================================
//  Child mount + query string on the mount root
// ===========================================================
describe('Router - query string on mounted root', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        const child = Router();
        child.get('/', (req, res) => res.json({ route: 'root', y: req.query.y }));
        child.get('/sub', (req, res) => res.json({ route: 'sub', x: req.query.x }));
        app.use('/api/x', child);
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('matches the root route when a query string rides the mount prefix', async () => {
        const r = await doFetch(`${base}/api/x?y=1`);
        expect(r.status).toBe(200);
        expect(r.data.route).toBe('root');
        expect(r.data.y).toBe('1');
    });

    it('still matches subpaths with a query string', async () => {
        const r = await doFetch(`${base}/api/x/sub?x=9`);
        expect(r.status).toBe(200);
        expect(r.data.route).toBe('sub');
        expect(r.data.x).toBe('9');
    });
});

// ===========================================================
//  all() method - matches every HTTP verb
// ===========================================================
describe('Router - all() catches all methods', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.all('/catch-all', (req, res) => res.json({ method: req.method }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        it(`all() matches ${method}`, async () => {
            const r = await doFetch(`${base}/catch-all`, { method });
            expect(r.data.method).toBe(method);
        });
    }
});

// ===========================================================
//  HEAD method support
// ===========================================================
describe('Router - HEAD method', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.head('/head-test', (req, res) => {
            res.set('X-Custom', 'present');
            res.status(200).send('');
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('HEAD route responds with headers but no body', async () => {
        const r = await fetch(`${base}/head-test`, { method: 'HEAD' });
        expect(r.status).toBe(200);
        expect(r.headers.get('x-custom')).toBe('present');
    });
});

// ===========================================================
//  Multiple handlers per route (middleware chain)
// ===========================================================
describe('Router - multiple handlers per route', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        const auth = (req, res, next) => {
            if (req.get('Authorization') === 'Bearer secret') {
                req.locals.user = 'admin';
                next();
            } else {
                res.status(401).json({ error: 'Unauthorized' });
            }
        };
        app.get('/protected', auth, (req, res) => {
            res.json({ user: req.locals.user });
        });
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('chain passes through on auth success', async () => {
        const r = await doFetch(`${base}/protected`, { headers: { 'Authorization': 'Bearer secret' } });
        expect(r.data.user).toBe('admin');
    });

    it('chain halts on auth failure', async () => {
        const r = await doFetch(`${base}/protected`);
        expect(r.status).toBe(401);
    });
});

// ===========================================================
//  URL param decoding
// ===========================================================
describe('Router - URL param decoding', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/item/:name', (req, res) => res.json({ name: req.params.name }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('decodes URI-encoded param', async () => {
        const r = await doFetch(`${base}/item/${encodeURIComponent('hello world')}`);
        expect(r.data.name).toBe('hello world');
    });

    it('decodes special characters', async () => {
        const r = await doFetch(`${base}/item/${encodeURIComponent('a&b=c')}`);
        expect(r.data.name).toBe('a&b=c');
    });
});

// ===========================================================
//  Trailing slash tolerance
// ===========================================================
describe('Router - trailing slash', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();
        app.get('/path', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('matches with trailing slash', async () => {
        const r = await doFetch(`${base}/path/`);
        expect(r.data.ok).toBe(true);
    });

    it('matches without trailing slash', async () => {
        const r = await doFetch(`${base}/path`);
        expect(r.data.ok).toBe(true);
    });
});

// ===========================================================
//  Router method chainability
// ===========================================================
describe('Router - method chainability', () => {
    it('methods return router for chaining', () => {
        const router = Router();
        const result = router
            .get('/a', () => {})
            .post('/b', () => {})
            .put('/c', () => {})
            .delete('/d', () => {})
            .patch('/e', () => {})
            .head('/f', () => {})
            .options('/g', () => {});
        expect(result).toBe(router);
        expect(router.routes.length).toBe(7);
    });
});

// ===========================================================
//  App routes() introspection
// ===========================================================
describe('App - routes() introspection', () => {
    it('lists all routes including sub-routers', () => {
        const app = createApp();
        app.get('/root', () => {});
        const api = Router();
        api.get('/items', () => {});
        app.use('/api', api);
        const list = app.routes();
        expect(list.find(r => r.path === '/root' && r.method === 'GET')).toBeTruthy();
        expect(list.find(r => r.path === '/api/items' && r.method === 'GET')).toBeTruthy();
    });
});

// =========================================================================
//  Router - refactored matching (from audit)
// =========================================================================

describe('Router refactored matching', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
        app.get('/files/*', (req, res) => res.json({ path: req.params['0'] }));

        const api = Router();
        api.get('/items', (req, res) => res.json({ items: true }));
        api.get('/items/:id', (req, res) => res.json({ itemId: req.params.id }));
        app.use('/api', api);

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('extracts named params correctly', async () =>
    {
        const r = await doFetch(`${base}/users/42`);
        expect(r.data.id).toBe('42');
    });

    it('extracts wildcard params correctly', async () =>
    {
        const r = await doFetch(`${base}/files/a/b/c.txt`);
        expect(r.data.path).toBe('a/b/c.txt');
    });

    it('routes to child router correctly', async () =>
    {
        const r = await doFetch(`${base}/api/items`);
        expect(r.data.items).toBe(true);
    });

    it('extracts child router params correctly', async () =>
    {
        const r = await doFetch(`${base}/api/items/99`);
        expect(r.data.itemId).toBe('99');
    });

    it('returns 404 for unmatched routes', async () =>
    {
        const r = await doFetch(`${base}/nonexistent`);
        expect(r.status).toBe(404);
    });
});

// ===========================================================
//  Router-level middleware - use(fn) / use(prefix, fn)
// ===========================================================
describe('Router - router-level middleware', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();

        const api = Router();
        // global router middleware - runs before every matched route
        api.use((req, res, next) => { req.locals.hitGlobal = true; next(); });
        // prefix-scoped middleware - only for /admin/*
        api.use('/admin', (req, res, next) => {
            if (req.get('Authorization') !== 'Bearer secret')
                return res.status(401).json({ error: 'Unauthorized' });
            req.locals.admin = true;
            next();
        });
        // async middleware
        api.use('/slow', async (req, res, next) => {
            await new Promise(r => setTimeout(r, 5));
            req.locals.slow = true;
            next();
        });

        api.get('/public', (req, res) => res.json({ hitGlobal: !!req.locals.hitGlobal, admin: !!req.locals.admin }));
        api.get('/admin/panel', (req, res) => res.json({ admin: !!req.locals.admin, hitGlobal: !!req.locals.hitGlobal }));
        api.get('/slow/thing', (req, res) => res.json({ slow: !!req.locals.slow }));

        // nested child under the middleware-bearing router
        const nested = Router();
        nested.get('/deep', (req, res) => res.json({ hitGlobal: !!req.locals.hitGlobal, admin: !!req.locals.admin }));
        api.use('/admin/nested', nested);

        app.use('/api', api);
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('global middleware runs before matched route handler', async () => {
        const r = await doFetch(`${base}/api/public`);
        expect(r.status).toBe(200);
        expect(r.data.hitGlobal).toBe(true);
        expect(r.data.admin).toBe(false);
    });

    it('prefix-scoped middleware guards its subtree (reject)', async () => {
        const r = await doFetch(`${base}/api/admin/panel`);
        expect(r.status).toBe(401);
    });

    it('prefix-scoped middleware guards its subtree (allow)', async () => {
        const r = await doFetch(`${base}/api/admin/panel`, { headers: { Authorization: 'Bearer secret' } });
        expect(r.status).toBe(200);
        expect(r.data.admin).toBe(true);
        expect(r.data.hitGlobal).toBe(true);
    });

    it('prefix-scoped middleware does not run outside its prefix', async () => {
        const r = await doFetch(`${base}/api/public`);
        expect(r.status).toBe(200); // /admin guard never fired
    });

    it('async middleware resolves before the handler', async () => {
        const r = await doFetch(`${base}/api/slow/thing`);
        expect(r.data.slow).toBe(true);
    });

    it('middleware propagates to mounted child routers', async () => {
        const denied = await doFetch(`${base}/api/admin/nested/deep`);
        expect(denied.status).toBe(401);
        const ok = await doFetch(`${base}/api/admin/nested/deep`, { headers: { Authorization: 'Bearer secret' } });
        expect(ok.status).toBe(200);
        expect(ok.data.hitGlobal).toBe(true);
        expect(ok.data.admin).toBe(true);
    });
});

describe('Router - use() argument validation', () => {
    it('accepts a single middleware function', () => {
        const r = Router();
        expect(() => r.use((req, res, next) => next())).not.toThrow();
    });

    it('accepts prefix + middleware function(s)', () => {
        const r = Router();
        expect(() => r.use('/x', (req, res, next) => next(), (req, res, next) => next())).not.toThrow();
    });

    it('accepts prefix + child router (mount)', () => {
        const parent = Router();
        const child = Router();
        expect(() => parent.use('/x', child)).not.toThrow();
    });

    it('throws TypeError on a non-function, non-router second argument', () => {
        const r = Router();
        expect(() => r.use('/x', 123)).toThrow(TypeError);
    });

    it('throws TypeError on an unsupported first argument', () => {
        const r = Router();
        expect(() => r.use(123)).toThrow(TypeError);
    });

    it('throws TypeError when a later middleware argument is not a function', () => {
        const r = Router();
        expect(() => r.use((req, res, next) => next(), 'nope')).toThrow(TypeError);
    });
});
