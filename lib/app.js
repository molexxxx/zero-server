/**
 * @module app
 * @description HTTP application with middleware pipeline,
 *              method-based routing, HTTPS support, built-in WebSocket
 *              upgrade handling, and route introspection.
 *              Created via `createApp()` in the public API.
 *
 * @example
 *   const { createApp } = require('zero-http');
 *   const app = createApp();
 *
 *   app.use(logger());
 *   app.get('/hello', (req, res) => res.json({ hello: 'world' }));
 *   app.listen(3000);
 */
const http = require('http');
const https = require('https');
const Router = require('./router');
const { Request, Response } = require('./http');
const { handleUpgrade } = require('./ws');
const log = require('./debug')('zero:app');

class App
{
    /**
     * Create a new App instance.
     * Initialises an empty middleware stack, a `Router`, and binds
     * `this.handler` for direct use with `http.createServer()`.
     *
     * @constructor
     */
    constructor()
    {
        /** @type {Router} */
        this.router = new Router();
        /** @type {Function[]} */
        this.middlewares = [];
        /** @type {Function|null} */
        this._errorHandler = null;
        /** @type {Map<string, { handler: Function, opts: object }>} WebSocket upgrade handlers keyed by path */
        this._wsHandlers = new Map();
        /** @type {import('http').Server|import('https').Server|null} */
        this._server = null;

        /**
         * Application-level settings store.
         * @type {Object<string, *>}
         * @private
         */
        this._settings = {};

        /**
         * Application-level locals — persistent across the app lifecycle.
         * Merged into every `req.locals` and `res.locals` on every request.
         * @type {Object<string, *>}
         */
        this.locals = {};

        /**
         * Parameter pre-processing handlers.
         * @type {Object<string, Function[]>}
         * @private
         */
        this._paramHandlers = {};

        // Bind for use as `http.createServer(app.handler)`
        this.handler = (req, res) => this.handle(req, res);
    }

    // -- Settings ------------------------------------

    /**
     * Set an application setting, or retrieve one when called with a single argument.
     *
     * When called with two arguments, sets the value and returns `this` for chaining.
     * When called with one argument, returns the stored value.
     *
     * Common settings: `'trust proxy'`, `'env'`, `'json spaces'`, `'etag'`,
     *                  `'view engine'`, `'views'`, `'case sensitive routing'`.
     *
     * @param {string} key   - Setting name.
     * @param {*}      [val] - Setting value.
     * @returns {*|App}       The stored value (getter) or `this` (setter).
     *
     * @example
     *   app.set('trust proxy', true);
     *   app.set('json spaces', 2);
     *   app.set('env');             // => undefined (or previously set value)
     */
    set(key, val)
    {
        if (arguments.length === 1) return this._settings[key];
        this._settings[key] = val;
        return this;
    }

    /**
     * Set a boolean setting to `true`.
     *
     * @param {string} key - Setting name.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.enable('trust proxy');
     */
    enable(key)  { this._settings[key] = true;  return this; }

    /**
     * Set a boolean setting to `false`.
     *
     * @param {string} key - Setting name.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.disable('etag');
     */
    disable(key) { this._settings[key] = false; return this; }

    /**
     * Check if a setting is truthy.
     *
     * @param {string} key - Setting name.
     * @returns {boolean} `true` if the setting is truthy.
     */
    enabled(key)  { return !!this._settings[key]; }

    /**
     * Check if a setting is falsy.
     *
     * @param {string} key - Setting name.
     * @returns {boolean} `true` if the setting is falsy.
     */
    disabled(key) { return !this._settings[key]; }

    // -- Middleware -------------------------------------

    /**
     * Register middleware or mount a sub-router.
     * - `use(fn)` — global middleware applied to every request.
     * - `use('/prefix', fn)` — path-scoped middleware (strips the prefix
     *   before calling `fn` so downstream sees relative paths).
     * - `use('/prefix', router)` — mount a Router sub-app at the given prefix.
     *
     * @param {string|Function}       pathOrFn - A path prefix string, or middleware function.
     * @param {Function|Router}       [fn]     - Middleware function or Router when first arg is a path.
     */
    use(pathOrFn, fn)
    {
        if (typeof pathOrFn === 'function')
        {
            this.middlewares.push(pathOrFn);
        }
        else if (typeof pathOrFn === 'string' && fn instanceof Router)
        {
            // Mount a sub-router
            this.router.use(pathOrFn, fn);
        }
        else if (typeof pathOrFn === 'string' && typeof fn === 'function')
        {
            const prefix = pathOrFn.endsWith('/') ? pathOrFn.slice(0, -1) : pathOrFn;
            this.middlewares.push((req, res, next) =>
            {
                const urlPath = req.url.split('?')[0];
                if (urlPath === prefix || urlPath.startsWith(prefix + '/'))
                {
                    // strip prefix from url so downstream sees relative paths
                    const origUrl = req.url;
                    req.url = req.url.slice(prefix.length) || '/';
                    fn(req, res, () => { req.url = origUrl; next(); });
                }
                else
                {
                    next();
                }
            });
        }
    }

    /**
     * Register a global error handler.
     * The handler receives `(err, req, res, next)` and is invoked whenever
     * a middleware or route handler throws or passes an error to `next(err)`.
     *
     * @param {Function} fn - Error-handling function `(err, req, res, next) => void`.
     */
    onError(fn)
    {
        this._errorHandler = fn;
    }

    /**
     * Register a parameter pre-processing handler.
     * Runs before route handlers for any route containing a `:name` parameter.
     *
     * @param {string}   name - Parameter name.
     * @param {Function} fn   - `(req, res, next, value) => void`.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.param('userId', async (req, res, next, id) => {
     *       req.locals.user = await db.users.findById(id);
     *       if (!req.locals.user) return res.status(404).json({ error: 'User not found' });
     *       next();
     *   });
     */
    param(name, fn)
    {
        if (!this._paramHandlers[name]) this._paramHandlers[name] = [];
        this._paramHandlers[name].push(fn);
        this.router._paramHandlers = this._paramHandlers;
        return this;
    }

    // -- Request Handling ------------------------------

    /**
     * Core request handler.  Wraps the raw Node `req`/`res` in
     * `Request`/`Response` wrappers, runs the middleware
     * pipeline, then falls through to the router.
     *
     * @param {import('http').IncomingMessage} req - Raw Node request.
     * @param {import('http').ServerResponse}  res - Raw Node response.
     */
    handle(req, res)
    {
        const request = new Request(req);
        const response = new Response(res);

        // Inject app reference into request and response
        request.app = this;
        response.app = this;
        response._req = request;
        request._res = response;

        // Preserve original URL before any middleware rewrites
        request.originalUrl = request.url;

        // Merge app.locals into request/response locals via prototype chain (avoids copy per request)
        request.locals = Object.create(this.locals);
        response.locals = Object.create(this.locals);

        let idx = 0;
        const run = (err) =>
        {
            if (err)
            {
                log.error('middleware error: %s', err.message || err);
                if (this._errorHandler) return this._errorHandler(err, request, response, run);
                response.status(500).json({ error: err.message || 'Internal Server Error' });
                return;
            }
            if (idx < this.middlewares.length)
            {
                const mw = this.middlewares[idx++];
                try
                {
                    const result = mw(request, response, run);
                    // Handle promise-returning middleware
                    if (result && typeof result.catch === 'function')
                    {
                        result.catch(run);
                    }
                }
                catch (e)
                {
                    run(e);
                }
                return;
            }
            this.router.handle(request, response);
        };

        run();
    }

    // -- Server Lifecycle ------------------------------

    /**
     * Start listening for HTTP or HTTPS connections.
     *
     * @param {number}   [port=3000]   - Port number to bind.
     * @param {object|Function} [opts] - TLS options for HTTPS, or a callback.
     * @param {Buffer|string} [opts.key]  - Private key for TLS.
     * @param {Buffer|string} [opts.cert] - Certificate for TLS.
     * @param {Buffer|string} [opts.pfx]  - PFX/PKCS12 bundle (alternative to key+cert).
     * @param {Function} [cb]          - Callback invoked once the server is listening.
     * @returns {import('http').Server|import('https').Server} The underlying server.
     *
     * @example
     *   // Plain HTTP
     *   app.listen(3000, () => console.log('HTTP on 3000'));
     *
     *   // HTTPS
     *   app.listen(443, { key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') },
     *              () => console.log('HTTPS on 443'));
     */
    listen(port = 3000, opts, cb)
    {
        // Normalise arguments — allow `listen(port, cb)` without opts
        if (typeof opts === 'function') { cb = opts; opts = undefined; }

        const isHTTPS = opts && (opts.key || opts.pfx || opts.cert);
        const server = isHTTPS
            ? https.createServer(opts, this.handler)
            : http.createServer(this.handler);

        this._server = server;
        log.info('starting %s server on port %d', isHTTPS ? 'HTTPS' : 'HTTP', port);

        // Always attach WebSocket upgrade handling so ws() works
        // regardless of registration order (before or after listen).
        server.on('upgrade', (req, socket, head) =>
        {
            if (this._wsHandlers.size > 0)
                handleUpgrade(req, socket, head, this._wsHandlers);
            else
                socket.destroy();
        });

        return server.listen(port, cb);
    }

    /**
     * Gracefully close the server, stopping new connections.
     *
     * @param {Function} [cb] - Callback invoked once the server has closed.
     */
    close(cb)
    {
        if (this._server) this._server.close(cb);
    }

    // -- WebSocket Support -----------------------------

    /**
     * Register a WebSocket upgrade handler for a path.
     *
     * The handler receives `(ws, req)` where `ws` is a `WebSocketConnection`
     * instance with methods like `send()`, `sendJSON()`, `on()`, and `close()`.
     *
     * @param {string}   path        - URL path to listen for upgrade requests.
     * @param {object|Function} [opts] - Options object, or the handler function directly.
     * @param {number}   [opts.maxPayload=1048576]  - Maximum incoming frame size in bytes (default 1 MB).
     * @param {number}   [opts.pingInterval=30000]  - Auto-ping interval in ms. Set `0` to disable.
     * @param {Function} [opts.verifyClient]        - `(req) => boolean` — return false to reject the upgrade.
     * @param {Function} handler     - `(ws, req) => void`.
     *
     * @example
     *   // Simple
     *   app.ws('/chat', (ws, req) => {
     *       ws.on('message', data => ws.send('echo: ' + data));
     *   });
     *
     *   // With options
     *   app.ws('/feed', { maxPayload: 64 * 1024, pingInterval: 15000 }, (ws, req) => {
     *       console.log('client', ws.id, 'from', ws.ip);
     *       ws.sendJSON({ hello: 'world' });
     *   });
     */
    ws(path, opts, handler)
    {
        // Normalise arguments: ws(path, handler) or ws(path, opts, handler)
        if (typeof opts === 'function') { handler = opts; opts = {}; }
        if (!opts) opts = {};

        this._wsHandlers.set(path, { handler, opts });
    }

    // -- Route Introspection ---------------------------

    /**
     * Return a flat list of all registered routes across the router tree,
     * including mounted sub-routers.  Useful for debugging, auto-generated
     * docs, or CLI tooling.
     *
     * @returns {{ method: string, path: string }[]} Flat array of route entries including WebSocket handlers.
     *
     * @example
     *   app.routes().forEach(r => console.log(r.method, r.path));
     *   // GET  /users
     *   // POST /users
     *   // GET  /api/v1/items/:id
     */
    routes()
    {
        const list = this.router.inspect();

        /* Include WebSocket upgrade handlers */
        for (const [wsPath, { opts }] of this._wsHandlers)
        {
            const entry = { method: 'WS', path: wsPath };
            if (opts && opts.maxPayload !== undefined) entry.maxPayload = opts.maxPayload;
            if (opts && opts.pingInterval !== undefined) entry.pingInterval = opts.pingInterval;
            list.push(entry);
        }

        return list;
    }

    // -- Route Registration ----------------------------

    /**
     * Extract an options object from the head of the handlers array when
     * the first argument is a plain object (not a function).
     * @private
     */
    _extractOpts(fns)
    {
        let opts = {};
        if (fns.length > 0 && typeof fns[0] === 'object' && typeof fns[0] !== 'function')
        {
            opts = fns.shift();
        }
        return opts;
    }

    /**
     * Register one or more handler functions for a specific HTTP method and path.
     *
     * @param {string}      method - HTTP method (GET, POST, etc.) or 'ALL'.
     * @param {string}      path   - Route pattern (e.g. '/users/:id').
     * @param {...Function|object} fns - Optional options object `{ secure }` followed by handler functions.
     */
    route(method, path, ...fns) { const o = this._extractOpts(fns); this.router.add(method, path, fns, o); }

    /**
     * @see App#route — shortcut for GET requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    get(path, ...fns) { if (arguments.length === 1 && typeof path === 'string' && fns.length === 0) return this.set(path); this.route('GET', path, ...fns); return this; }
    /**
     * @see App#route — shortcut for POST requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    post(path, ...fns) { this.route('POST', path, ...fns); return this; }
    /**
     * @see App#route — shortcut for PUT requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    put(path, ...fns) { this.route('PUT', path, ...fns); return this; }
    /**
     * @see App#route — shortcut for DELETE requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    delete(path, ...fns) { this.route('DELETE', path, ...fns); return this; }
    /**
     * @see App#route — shortcut for PATCH requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    patch(path, ...fns) { this.route('PATCH', path, ...fns); return this; }
    /**
     * @see App#route — shortcut for OPTIONS requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    options(path, ...fns) { this.route('OPTIONS', path, ...fns); return this; }
    /**
     * @see App#route — shortcut for HEAD requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    head(path, ...fns) { this.route('HEAD', path, ...fns); return this; }
    /**
     * @see App#route — matches every HTTP method.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {App} `this` for chaining.
     */
    all(path, ...fns) { this.route('ALL', path, ...fns); return this; }

    /**
     * Chainable route builder — register multiple methods on the same path.
     *
     * @param {string} path - Route pattern.
     * @returns {object} Chain object with HTTP verb methods.
     *
     * @example
     *   app.chain('/users')
     *     .get((req, res) => res.json(users))
     *     .post((req, res) => res.json({ created: true }));
     */
    chain(path) { return this.router.route(path); }

    /**
     * Define a route group with shared middleware prefix.
     * All routes registered inside the callback share the given path prefix
     * and middleware stack.
     *
     * @param {string}      prefix      - URL prefix for the group.
     * @param {...Function}  middleware  - Shared middleware, last argument is the callback.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.group('/api/v1', authMiddleware, (router) => {
     *       router.get('/users', listUsers);
     *       router.post('/users', createUser);
     *       router.get('/users/:id', getUser);
     *   });
     */
    group(prefix, ...args)
    {
        const cb = args.pop();
        const middlewareStack = args;
        const router = new Router();
        cb(router);
        if (middlewareStack.length > 0)
        {
            this.middlewares.push((req, res, next) =>
            {
                const urlPath = req.url.split('?')[0];
                const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
                if (urlPath === cleanPrefix || urlPath.startsWith(cleanPrefix + '/'))
                {
                    let i = 0;
                    const runMw = () =>
                    {
                        if (i < middlewareStack.length)
                        {
                            const mw = middlewareStack[i++];
                            try
                            {
                                const result = mw(req, res, runMw);
                                if (result && typeof result.catch === 'function') result.catch(next);
                            }
                            catch (e) { next(e); }
                        }
                        else { next(); }
                    };
                    runMw();
                }
                else { next(); }
            });
        }
        this.router.use(prefix, router);
        return this;
    }
}

module.exports = App;
