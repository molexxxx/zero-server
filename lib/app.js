/**
 * @module app
 * @description Express-like HTTP application with middleware pipeline,
 *              method-based routing, HTTPS support, built-in WebSocket
 *              upgrade handling, and route introspection.
 *              Created via `createApp()` in the public API.
 */
const http = require('http');
const https = require('https');
const Router = require('./router');
const { Request, Response } = require('./http');
const { handleUpgrade } = require('./ws');

class App
{
    /**
     * Create a new App instance.
     * Initialises an empty middleware stack, a {@link Router}, and binds
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

        // Bind for use as `http.createServer(app.handler)`
        this.handler = (req, res) => this.handle(req, res);
    }

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

    // -- Request Handling ------------------------------

    /**
     * Core request handler.  Wraps the raw Node `req`/`res` in
     * {@link Request}/{@link Response} wrappers, runs the middleware
     * pipeline, then falls through to the router.
     *
     * @param {import('http').IncomingMessage} req - Raw Node request.
     * @param {import('http').ServerResponse}  res - Raw Node response.
     */
    handle(req, res)
    {
        const request = new Request(req);
        const response = new Response(res);

        let idx = 0;
        const run = (err) =>
        {
            if (err)
            {
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
     * @param {object|Function} [opts] - TLS options `{ key, cert, ... }` for HTTPS, or a callback.
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
     * The handler receives `(ws, req)` where `ws` is a rich WebSocket
     * connection object.  See {@link WebSocketConnection} for the full API.
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
     * @returns {{ method: string, path: string }[]}
     *
     * @example
     *   app.routes().forEach(r => console.log(r.method, r.path));
     *   // GET  /users
     *   // POST /users
     *   // GET  /api/v1/items/:id
     */
    routes()
    {
        return this.router.inspect();
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

    /** @see App#route — shortcut for GET requests.    */ get(path, ...fns) { this.route('GET', path, ...fns); }
    /** @see App#route — shortcut for POST requests.   */ post(path, ...fns) { this.route('POST', path, ...fns); }
    /** @see App#route — shortcut for PUT requests.    */ put(path, ...fns) { this.route('PUT', path, ...fns); }
    /** @see App#route — shortcut for DELETE requests. */ delete(path, ...fns) { this.route('DELETE', path, ...fns); }
    /** @see App#route — shortcut for PATCH requests.  */ patch(path, ...fns) { this.route('PATCH', path, ...fns); }
    /** @see App#route — shortcut for OPTIONS requests.*/ options(path, ...fns) { this.route('OPTIONS', path, ...fns); }
    /** @see App#route — shortcut for HEAD requests.   */ head(path, ...fns) { this.route('HEAD', path, ...fns); }
    /** @see App#route — matches every HTTP method.    */ all(path, ...fns) { this.route('ALL', path, ...fns); }
}

module.exports = App;
