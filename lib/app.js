/**
 * @module app
 * @description HTTP application with middleware pipeline,
 *              method-based routing, HTTP/2, HTTPS, and HTTP/1.1 support,
 *              built-in WebSocket upgrade handling, trust proxy resolution,
 *              and route introspection.
 *              Created via `createApp()` in the public API.
 *
 * @example
 *   const { createApp } = require('zero-http');
 *   const app = createApp();
 *
 *   app.use(logger());
 *   app.get('/hello', (req, res) => res.json({ hello: 'world' }));
 *   app.listen(3000);
 *
 * @example
 *   // HTTP/2 with TLS
 *   const fs = require('fs');
 *   app.listen(443, {
 *       http2: true,
 *       key: fs.readFileSync('key.pem'),
 *       cert: fs.readFileSync('cert.pem'),
 *   });
 *
 * @example
 *   // HTTP/2 cleartext (h2c) for internal services
 *   app.listen(3000, { http2: true });
 */
const http = require('http');
const https = require('https');
const http2 = require('http2');
const Router = require('./router');
const { Request, Response } = require('./http');
const { handleUpgrade } = require('./ws');
const { LifecycleManager, LIFECYCLE_STATE } = require('./lifecycle');
const { healthCheck, createHealthHandlers, memoryCheck, eventLoopCheck, diskSpaceCheck } = require('./observe/health');
const { MetricsRegistry, createDefaultMetrics, metricsMiddleware, metricsEndpoint } = require('./observe/metrics');
const { Tracer, tracingMiddleware, instrumentFetch } = require('./observe/tracing');
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

        /**
         * Lifecycle manager for graceful shutdown and connection tracking.
         * @type {LifecycleManager}
         * @private
         */
        this._lifecycle = new LifecycleManager(this);

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
        // Reject new requests during shutdown drain
        if (this._lifecycle.isDraining)
        {
            // HTTP/2 doesn't use Connection header
            const headers = {
                'Content-Type': 'application/json',
                'Retry-After': '5',
            };
            if (req.httpVersionMajor < 2) headers['Connection'] = 'close';
            res.writeHead(503, headers);
            res.end(JSON.stringify({ error: 'Service Unavailable', message: 'Server is shutting down' }));
            return;
        }

        // Track active request for graceful shutdown
        this._lifecycle.trackRequest(res);

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
     * Start listening for HTTP, HTTPS, or HTTP/2 connections.
     *
     * @param {number}   [port=3000]   - Port number to bind.
     * @param {object|Function} [opts] - Server options or callback.
     * @param {boolean}       [opts.http2]    - Create an HTTP/2 server.
     * @param {Buffer|string} [opts.key]      - Private key for TLS (HTTPS or HTTP/2 with TLS).
     * @param {Buffer|string} [opts.cert]     - Certificate for TLS.
     * @param {Buffer|string} [opts.pfx]      - PFX/PKCS12 bundle (alternative to key+cert).
     * @param {Buffer|string} [opts.ca]       - CA certificate(s) for client verification.
     * @param {boolean}       [opts.allowHTTP1=true] - Allow HTTP/1.1 fallback on HTTP/2 secure servers (ALPN).
     * @param {object}        [opts.settings] - HTTP/2 settings (SETTINGS frame values).
     * @param {Function} [cb]          - Callback invoked once the server is listening.
     * @returns {import('http').Server|import('https').Server|import('http2').Http2SecureServer|import('http2').Http2Server}
     *
     * @example
     *   // Plain HTTP
     *   app.listen(3000, () => console.log('HTTP on 3000'));
     *
     * @example
     *   // HTTPS
     *   app.listen(443, { key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') });
     *
     * @example
     *   // HTTP/2 with TLS and ALPN (h2 + HTTP/1.1 fallback)
     *   app.listen(443, { http2: true, key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') });
     *
     * @example
     *   // HTTP/2 cleartext (h2c) — for internal services behind a TLS-terminating proxy
     *   app.listen(3000, { http2: true });
     */
    listen(port = 3000, opts, cb)
    {
        // Normalise arguments — allow `listen(port, cb)` without opts
        if (typeof opts === 'function') { cb = opts; opts = undefined; }

        const isH2 = opts && opts.http2;
        const hasTLS = opts && (opts.key || opts.pfx || opts.cert);
        let server;

        if (isH2 && hasTLS)
        {
            // HTTP/2 over TLS with ALPN negotiation (h2 + HTTP/1.1 fallback)
            const h2Opts = {
                ...opts,
                allowHTTP1: opts.allowHTTP1 !== false, // default true for graceful fallback
            };
            delete h2Opts.http2;
            server = http2.createSecureServer(h2Opts, this.handler);
            log.info('starting HTTP/2 (TLS) server on port %d', port);
        }
        else if (isH2)
        {
            // HTTP/2 cleartext (h2c) — no TLS, for internal services
            const h2Opts = opts ? { ...opts } : {};
            delete h2Opts.http2;
            server = http2.createServer(h2Opts, this.handler);
            log.info('starting HTTP/2 (h2c) server on port %d', port);
        }
        else if (hasTLS)
        {
            server = https.createServer(opts, this.handler);
            log.info('starting HTTPS server on port %d', port);
        }
        else
        {
            server = http.createServer(this.handler);
            log.info('starting HTTP server on port %d', port);
        }

        this._server = server;

        // Always attach WebSocket upgrade handling so ws() works
        // regardless of registration order (before or after listen).
        server.on('upgrade', (req, socket, head) =>
        {
            if (this._wsHandlers.size > 0)
                handleUpgrade(req, socket, head, this._wsHandlers);
            else
                socket.destroy();
        });

        // Install graceful shutdown signal handlers
        this._lifecycle.installSignalHandlers();

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

    /**
     * Perform a full graceful shutdown.
     * Stops accepting new connections, drains in-flight requests, closes
     * WebSocket and SSE connections, and shuts down registered databases.
     *
     * @param {object} [opts] - Shutdown options.
     * @param {number} [opts.timeout] - Maximum ms to wait for in-flight requests (default 30000).
     * @returns {Promise<void>} Resolves when shutdown is complete.
     *
     * @example
     *   await app.shutdown();
     *   // or with custom timeout
     *   await app.shutdown({ timeout: 5000 });
     */
    shutdown(opts)
    {
        if (!this._shutdownPromise)
        {
            this._shutdownPromise = this._lifecycle.shutdown(opts);
        }
        return this._shutdownPromise;
    }

    // -- Lifecycle Events ------------------------------

    /**
     * Register a lifecycle event listener.
     *
     * Supported events:
     * - `'beforeShutdown'` — fires before shutdown begins (flush caches, finish writes)
     * - `'shutdown'`       — fires after shutdown is complete
     *
     * @param {'beforeShutdown'|'shutdown'} event - Lifecycle event name.
     * @param {Function} fn - Async or sync callback.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.on('beforeShutdown', async () => {
     *       await saveMetrics();
     *   });
     *
     *   app.on('shutdown', () => {
     *       console.log('goodbye');
     *   });
     */
    on(event, fn)
    {
        this._lifecycle.on(event, fn);
        return this;
    }

    /**
     * Remove a lifecycle event listener.
     *
     * @param {'beforeShutdown'|'shutdown'} event - Event name.
     * @param {Function} fn - Callback to remove.
     * @returns {App} `this` for chaining.
     */
    off(event, fn)
    {
        this._lifecycle.off(event, fn);
        return this;
    }

    // -- Lifecycle Resource Registration ---------------

    /**
     * Register a WebSocket pool for graceful shutdown. All connections
     * in the pool are closed with code `1001` when the server shuts down.
     *
     * @param {import('./ws/room')} pool - WebSocket pool instance.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   const pool = new WebSocketPool();
     *   app.registerPool(pool);
     */
    registerPool(pool)
    {
        this._lifecycle.registerPool(pool);
        return this;
    }

    /**
     * Unregister a WebSocket pool from lifecycle management.
     *
     * @param {import('./ws/room')} pool - WebSocket pool instance.
     * @returns {App} `this` for chaining.
     */
    unregisterPool(pool)
    {
        this._lifecycle.unregisterPool(pool);
        return this;
    }

    /**
     * Track an SSE stream for graceful shutdown. The stream
     * is automatically untracked when it closes.
     *
     * @param {import('./sse/stream')} stream - SSE stream instance.
     * @returns {App} `this` for chaining.
     */
    trackSSE(stream)
    {
        this._lifecycle.trackSSE(stream);
        return this;
    }

    /**
     * Register an ORM Database instance for graceful shutdown.
     * The database connection is closed during shutdown.
     *
     * @param {import('./orm')} db - Database instance.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   const db = new Database({ adapter: 'memory' });
     *   app.registerDatabase(db);
     */
    registerDatabase(db)
    {
        this._lifecycle.registerDatabase(db);
        return this;
    }

    /**
     * Unregister an ORM Database instance from lifecycle management.
     *
     * @param {import('./orm')} db - Database instance.
     * @returns {App} `this` for chaining.
     */
    unregisterDatabase(db)
    {
        this._lifecycle.unregisterDatabase(db);
        return this;
    }

    /**
     * Configure the shutdown timeout—the maximum time (ms) to wait for
     * in-flight requests to finish before forcefully terminating them.
     *
     * @param {number} ms - Timeout in milliseconds.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.shutdownTimeout(10000); // 10s
     */
    shutdownTimeout(ms)
    {
        this._lifecycle._shutdownTimeout = ms;
        return this;
    }

    /**
     * Current lifecycle state.
     *
     * @type {'running'|'draining'|'closed'}
     */
    get lifecycleState()
    {
        return this._lifecycle.state;
    }

    // -- Observability ---------------------------------

    /**
     * Register a liveness health check endpoint.
     * Returns `200` when healthy, `503` during shutdown.
     *
     * @param {string} [path='/healthz'] - Endpoint path.
     * @param {Object<string, Function>} [checks] - Named health check functions.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.health();                                    // GET /healthz
     *   app.health('/alive');                             // GET /alive
     *   app.health('/healthz', { memory: memoryCheck() });
     */
    health(path, checks)
    {
        if (typeof path === 'object') { checks = path; path = '/healthz'; }
        if (!path) path = '/healthz';
        this.get(path, healthCheck({ checks: checks || {} }));
        return this;
    }

    /**
     * Register a readiness health check endpoint.
     * Returns `200` when all checks pass, `503` otherwise.
     *
     * @param {string} [path='/readyz'] - Endpoint path.
     * @param {Object<string, Function>} [checks] - Named readiness check functions.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.ready('/readyz', {
     *       database: () => db.ping(),
     *       cache: () => ({ healthy: redis.isConnected }),
     *   });
     */
    ready(path, checks)
    {
        if (typeof path === 'object') { checks = path; path = '/readyz'; }
        if (!path) path = '/readyz';
        this.get(path, healthCheck({ checks: checks || {} }));
        return this;
    }

    /**
     * Register a custom health check.
     *
     * @param {string} name - Check name.
     * @param {Function} fn - Check function `() => { healthy, details }`.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.addHealthCheck('redis', async () => {
     *       await redis.ping();
     *       return { healthy: true };
     *   });
     */
    addHealthCheck(name, fn)
    {
        if (!this._healthChecks) this._healthChecks = {};
        this._healthChecks[name] = fn;
        return this;
    }

    /**
     * Get the application metrics registry. Lazily created on first access.
     * Returns a `MetricsRegistry` instance for registering custom metrics.
     *
     * @returns {import('./observe/metrics').MetricsRegistry} The metrics registry.
     *
     * @example
     *   const counter = app.metrics().counter({
     *       name: 'custom_events_total',
     *       help: 'Custom events',
     *   });
     *   counter.inc();
     */
    metrics()
    {
        if (!this._metricsRegistry)
        {
            this._metricsRegistry = new MetricsRegistry();
        }
        return this._metricsRegistry;
    }

    /**
     * Mount a Prometheus metrics endpoint.
     *
     * @param {string} [path='/metrics'] - Endpoint path.
     * @param {object} [opts] - Options.
     * @param {import('./observe/metrics').MetricsRegistry} [opts.registry] - Registry. Uses `app.metrics()` if not provided.
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.metricsEndpoint();
     *   app.metricsEndpoint('/prometheus');
     */
    metricsEndpoint(path, opts = {})
    {
        if (typeof path === 'object') { opts = path; path = '/metrics'; }
        if (!path) path = '/metrics';
        const registry = opts.registry || this.metrics();
        this.get(path, metricsEndpoint(registry));
        return this;
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

    // -- Authentication & Sessions ---------------------

    /**
     * Mount JWT authentication middleware.
     * Shorthand for `app.use(jwt(opts))`.
     *
     * @param {object} opts - JWT options (see `jwt()` for full documentation).
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.jwt({ secret: process.env.JWT_SECRET });
     *   app.jwt({ jwksUri: 'https://auth.example.com/.well-known/jwks.json' });
     */
    jwtAuth(opts)
    {
        const { jwt } = require('./auth/jwt');
        this.use(jwt(opts));
        return this;
    }

    /**
     * Mount session middleware.
     * Shorthand for `app.use(session(opts))`.
     *
     * @param {object} opts - Session options (see `session()` for full documentation).
     * @returns {App} `this` for chaining.
     *
     * @example
     *   app.sessions({ secret: process.env.SESSION_SECRET });
     */
    sessions(opts)
    {
        const { session } = require('./auth/session');
        this.use(session(opts));
        return this;
    }

    /**
     * Create an OAuth2 client bound to this app.
     * Returns the client — does NOT mount any middleware automatically.
     *
     * @param {object} opts - OAuth options (see `oauth()` for full documentation).
     * @returns {{ authorize: Function, callback: Function, refresh: Function, userInfo: Function }}
     *
     * @example
     *   const github = app.oauth({
     *       provider: 'github',
     *       clientId: process.env.GITHUB_CLIENT_ID,
     *       clientSecret: process.env.GITHUB_CLIENT_SECRET,
     *       callbackUrl: '/auth/github/callback',
     *   });
     */
    oauth(opts)
    {
        const { oauth } = require('./auth/oauth');
        return oauth(opts);
    }
}

module.exports = App;
