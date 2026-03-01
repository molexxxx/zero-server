/**
 * @module app
 * @description Express-like HTTP application with middleware pipeline and
 *              method-based routing.  Created via `createApp()` in the public API.
 */
const http = require('http');
const Router = require('./router');
const Request = require('./request');
const Response = require('./response');

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

        // Bind for use as `http.createServer(app.handler)`
        this.handler = (req, res) => this.handle(req, res);
    }

    /**
     * Register middleware.
     * - `use(fn)` — global middleware applied to every request.
     * - `use('/prefix', fn)` — path-scoped middleware (strips the prefix
     *   before calling `fn` so downstream sees relative paths).
     *
     * @param {string|Function} pathOrFn - A path prefix string, or middleware function.
     * @param {Function}        [fn]     - Middleware function when first arg is a path.
     */
    use(pathOrFn, fn)
    {
        if (typeof pathOrFn === 'function')
        {
            this.middlewares.push(pathOrFn);
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

    /**
     * Start listening for HTTP connections.
     *
     * @param {number}   [port=3000] - Port number to bind.
     * @param {Function} [cb]        - Callback invoked once the server is listening.
     * @returns {import('http').Server} The underlying Node HTTP server.
     */
    listen(port = 3000, cb)
    {
        const server = http.createServer(this.handler);
        return server.listen(port, cb);
    }

    /**
     * Register one or more handler functions for a specific HTTP method and path.
     *
     * @param {string}      method - HTTP method (GET, POST, etc.) or 'ALL'.
     * @param {string}      path   - Route pattern (e.g. '/users/:id').
     * @param {...Function} fns    - Handler functions `(req, res, next) => void`.
     */
    route(method, path, ...fns) { this.router.add(method, path, fns); }

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
