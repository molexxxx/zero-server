/**
 * @module router
 * @description Full-featured pattern-matching router with named parameters,
 *              wildcard catch-alls, sequential handler chains, sub-router
 *              mounting, and route introspection.
 *
 * @example
 *   const { Router } = require('@zero-server/sdk');
 *
 *   const api = new Router();
 *
 *   api.get('/users/:id', (req, res) => {
 *       res.json({ id: req.params.id });
 *   });
 *
 *   api.route('/posts')
 *       .get((req, res) => res.json([]))
 *       .post((req, res) => res.json({ created: true }));
 *
 *   app.use('/api', api);
 */

const log = require('../debug')('zero:router');

/**
 * Convert a route path pattern into a RegExp and extract named parameter keys.
 * Supports `:param` segments and trailing `*` wildcards.
 *
 * @private
 * @param   {string} path - Route pattern (e.g. '/users/:id', '/api/*').
 * @returns {{ regex: RegExp, keys: string[] }} Compiled regex and ordered parameter names.
 */
function pathToRegex(path)
{
    // Wildcard catch-all: /api/*
    if (path.endsWith('*'))
    {
        const prefix = path.slice(0, -1); // e.g. "/api/"
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { regex: new RegExp('^' + escaped + '(.*)$'), keys: ['0'] };
    }

    const parts = path.split('/').filter(Boolean);
    const keys = [];
    const pattern = parts.map(p =>
    {
        if (p.startsWith(':')) { keys.push(p.slice(1)); return '([^/]+)'; }
        return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return { regex: new RegExp('^/' + pattern + '/?$'), keys };
}

/**
 * Join two path segments, avoiding double slashes.
 * @private
 * @param {string} base - Base path prefix.
 * @param {string} child - Child path segment.
 * @returns {string} Formatted string.
 */
function joinPath(base, child)
{
    if (base === '/') return child;
    if (child === '/') return base;
    return base.replace(/\/$/, '') + '/' + child.replace(/^\//, '');
}

class Router
{
    /**
     * Create a new Router with an empty route table.
     * Can be used standalone as a sub-router or internally by App.
     */
    constructor()
    {
        this.routes = [];
        /** @type {{ prefix: string, router: Router }[]} */
        this._children = [];
        /**
         * Router-level middleware. Each entry runs before the handlers of any
         * matching route in this router (and in mounted child routers), in
         * registration order.
         * @type {{ prefix: string|null, handler: Function }[]}
         */
        this._middleware = [];
        /**
         * Parameter pre-processing handlers (set by parent App).
         * @type {Object<string, Function[]>}
         */
        this._paramHandlers = {};
    }

    // -- Core ------------------------------------------------

    /**
     * Register a route.
     *
     * @param {string}     method   - HTTP method (e.g. 'GET') or 'ALL' to match any.
     * @param {string}     path     - Route pattern.
     * @param {Function[]} handlers - One or more handler functions `(req, res, next) => void`.
     * @param {object}     [options] - Configuration options.
     * @param {boolean}    [options.secure] - When `true`, route matches only HTTPS requests;
     *                                       when `false`, only HTTP. Omit to match both.
     */
    add(method, path, handlers, options = {})
    {
        const { regex, keys } = pathToRegex(path);
        const entry = { method: method.toUpperCase(), path, regex, keys, handlers };
        if (options.secure !== undefined) entry.secure = !!options.secure;
        this.routes.push(entry);
        log.debug('route added %s %s', method.toUpperCase(), path);
    }

    /**
     * Register router-level middleware or mount a child Router.
     *
     * Three forms are supported:
     * - `use(fn, ...fns)` - middleware that runs before the handlers of every
     *   matching route in this router (and its mounted children).
     * - `use(prefix, fn, ...fns)` - middleware scoped to routes whose path is at
     *   or below `prefix`.
     * - `use(prefix, router)` - mount a child Router under a path prefix.
     *   Requests matching the prefix are delegated to the child router with the
     *   prefix stripped from `req.url`.
     *
     * Middleware runs as part of the matched route's handler chain, so it only
     * executes when a route actually matches (a 404 runs no middleware). This
     * makes it a natural fit for auth/feature guards. Unlike the earlier
     * releases, passing a function is no longer silently ignored - an
     * unsupported argument shape throws a `TypeError`.
     *
     * @param {string|Function} prefixOrFn - Path prefix, or a middleware function.
     * @param {...(Function|Router)} rest  - A child `Router`, or one or more middleware functions.
     * @returns {Router} `this` for chaining.
     * @throws {TypeError} When the argument shape is not one of the supported forms.
     */
    use(prefixOrFn, ...rest)
    {
        // use(prefix, router) - mount a child router
        if (typeof prefixOrFn === 'string' && rest.length === 1 && rest[0] instanceof Router)
        {
            const cleanPrefix = prefixOrFn.endsWith('/') ? prefixOrFn.slice(0, -1) : prefixOrFn;
            this._children.push({ prefix: cleanPrefix, router: rest[0] });
            log.debug('mounted child router at %s', cleanPrefix);
            return this;
        }

        // use(fn, ...fns) - global router middleware
        if (typeof prefixOrFn === 'function')
        {
            for (const fn of [prefixOrFn, ...rest])
            {
                if (typeof fn !== 'function')
                    throw new TypeError('Router.use(): every middleware argument must be a function');
                this._middleware.push({ prefix: null, handler: fn });
            }
            log.debug('registered %d router middleware', 1 + rest.length);
            return this;
        }

        // use(prefix, fn, ...fns) - prefix-scoped router middleware
        if (typeof prefixOrFn === 'string' && rest.length > 0 && rest.every(f => typeof f === 'function'))
        {
            const cleanPrefix = prefixOrFn.endsWith('/') ? prefixOrFn.slice(0, -1) : prefixOrFn;
            for (const fn of rest) this._middleware.push({ prefix: cleanPrefix, handler: fn });
            log.debug('registered %d router middleware at %s', rest.length, cleanPrefix);
            return this;
        }

        throw new TypeError(
            'Router.use() expects use(fn), use(prefix, fn), or use(prefix, router)'
        );
    }

    /**
     * Collect the router-level middleware whose scope matches a path.
     * @param {string} url - Router-local request path (query already stripped).
     * @returns {Function[]} Applicable middleware handlers in registration order.
     * @private
     */
    _applicableMiddleware(url)
    {
        if (this._middleware.length === 0) return [];
        const out = [];
        for (const m of this._middleware)
        {
            if (m.prefix === null || url === m.prefix || url.startsWith(m.prefix + '/'))
                out.push(m.handler);
        }
        return out;
    }

    /**
     * Match an incoming request against the route table and execute the first
     * matching handler chain.  Delegates to child routers when mounted.
     * Sends a 404 JSON response when no route matches.
     *
     * @param {import('./request')}  req - Wrapped request.
     * @param {import('./response')} res - Wrapped response.
     */
    handle(req, res)
    {
        if (!this._matchAndExecute(req, res))
        {
            res.status(404).json({ error: 'Not Found' });
        }
    }

    /**
     * Try to handle a request without sending 404 on miss.
     * Used internally by parent routers to probe child routers.
     *
     * @param {import('./request')}  req - HTTP request object.
     * @param {import('./response')} res - HTTP response object.
     * @returns {boolean} `true` if a route matched.
     * @private
     */
    _tryHandle(req, res)
    {
        return this._matchAndExecute(req, res);
    }

    /**
     * Shared route matching and handler execution.
     * Returns `true` if a route matched (handler invoked), `false` otherwise.
     *
     * @param {import('./request')}  req - HTTP request object.
     * @param {import('./response')} res - HTTP response object.
     * @param {Function[]} [inherited] - Middleware inherited from parent routers,
     *        already resolved as applicable to this request.
     * @returns {boolean} Boolean result.
     * @private
     */
    _matchAndExecute(req, res, inherited = [])
    {
        const method = req.method.toUpperCase();
        const url = req.url.split('?')[0];
        log.debug('%s %s', method, url);

        // Middleware applicable at this router for the current path
        const ownMiddleware = this._applicableMiddleware(url);

        // Try own routes first
        for (let ri = 0; ri < this.routes.length; ri++)
        {
            const r = this.routes[ri];
            if (r.method !== 'ALL' && r.method !== method) continue;
            if (r.secure === true && !req.secure) continue;
            if (r.secure === false && req.secure) continue;
            const m = url.match(r.regex);
            if (!m) continue;
            req.params = {};
            for (let i = 0; i < r.keys.length; i++)
            {
                req.params[r.keys[i]] = decodeURIComponent(m[i + 1] || '');
            }

            // Run param pre-processing handlers
            const paramHandlers = this._paramHandlers || {};
            let paramKeys;
            let paramCount = 0;
            for (let i = 0; i < r.keys.length; i++)
            {
                if (paramHandlers[r.keys[i]])
                {
                    if (!paramKeys) paramKeys = [];
                    paramKeys.push(r.keys[i]);
                    paramCount++;
                }
            }

            let pIdx = 0;
            const runParams = () =>
            {
                if (pIdx < paramCount)
                {
                    const pk = paramKeys[pIdx++];
                    const fns = paramHandlers[pk];
                    let fIdx = 0;
                    const nextParam = () =>
                    {
                        if (fIdx < fns.length)
                        {
                            const fn = fns[fIdx++];
                            try
                            {
                                const result = fn(req, res, nextParam, req.params[pk]);
                                if (result && typeof result.catch === 'function')
                                {
                                    result.catch(e => this._handleRouteError(e, req, res));
                                }
                            }
                            catch (e) { this._handleRouteError(e, req, res); }
                        }
                        else { runParams(); }
                    };
                    nextParam();
                }
                else { runHandlers(); }
            };

            let idx = 0;
            const runHandlers = () =>
            {
                if (idx < r.handlers.length)
                {
                    const h = r.handlers[idx++];
                    try
                    {
                        const result = h(req, res, runHandlers);
                        if (result && typeof result.catch === 'function')
                        {
                            result.catch(e => this._handleRouteError(e, req, res));
                        }
                    }
                    catch (e)
                    {
                        this._handleRouteError(e, req, res);
                    }
                }
            };

            // Middleware (inherited from parents, then this router's own) runs
            // ahead of param handlers and route handlers. A middleware that
            // sends a response without calling next() short-circuits the chain.
            const middleware = inherited.length || ownMiddleware.length
                ? [...inherited, ...ownMiddleware]
                : null;
            const startChain = () => (paramCount > 0 ? runParams() : runHandlers());

            if (middleware)
            {
                let mIdx = 0;
                const runMiddleware = () =>
                {
                    if (mIdx < middleware.length)
                    {
                        const fn = middleware[mIdx++];
                        try
                        {
                            const result = fn(req, res, runMiddleware);
                            if (result && typeof result.catch === 'function')
                            {
                                result.catch(e => this._handleRouteError(e, req, res));
                            }
                        }
                        catch (e) { this._handleRouteError(e, req, res); }
                    }
                    else { startChain(); }
                };
                runMiddleware();
            }
            else { startChain(); }
            return true;
        }

        // Try child routers
        for (let ci = 0; ci < this._children.length; ci++)
        {
            const child = this._children[ci];
            if (url === child.prefix || url.startsWith(child.prefix + '/'))
            {
                const origUrl = req.url;
                const origBaseUrl = req.baseUrl || '';
                req.baseUrl = origBaseUrl + child.prefix;
                // Keep the query string attached to a normalized path: a
                // request for exactly the mount prefix plus a query
                // ('/api/files?x=1') must delegate as '/?x=1', not '?x=1'.
                const rest = req.url.slice(child.prefix.length);
                req.url = rest === '' || rest.startsWith('?') ? '/' + rest : rest;
                child.router._paramHandlers = this._paramHandlers;
                // Carry this router's applicable middleware down so mounted
                // routes are guarded too. Applicability is resolved here, against
                // the parent-relative URL, before the prefix is stripped.
                const childInherited = inherited.length || ownMiddleware.length
                    ? [...inherited, ...ownMiddleware]
                    : inherited;
                try
                {
                    const found = child.router._matchAndExecute(req, res, childInherited);
                    if (found) return true;
                }
                catch (e) { this._handleRouteError(e, req, res); return true; }
                req.url = origUrl;
                req.baseUrl = origBaseUrl;
            }
        }

        return false;
    }

    // -- Route Shortcuts ----------------------------------------

    /**
     * @private
     * Extract an options object from the head of the handlers array when
     * the first argument is a plain object (not a function).
     *
     * Allows: `router.get('/path', { secure: true }, handler)`
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
     * @see Router#add - shortcut for GET requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    get(path, ...fns) { const o = this._extractOpts(fns); this.add('GET', path, fns, o); return this; }
    /**
     * @see Router#add - shortcut for POST requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    post(path, ...fns) { const o = this._extractOpts(fns); this.add('POST', path, fns, o); return this; }
    /**
     * @see Router#add - shortcut for PUT requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    put(path, ...fns) { const o = this._extractOpts(fns); this.add('PUT', path, fns, o); return this; }
    /**
     * @see Router#add - shortcut for DELETE requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    delete(path, ...fns) { const o = this._extractOpts(fns); this.add('DELETE', path, fns, o); return this; }
    /**
     * @see Router#add - shortcut for PATCH requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    patch(path, ...fns) { const o = this._extractOpts(fns); this.add('PATCH', path, fns, o); return this; }
    /**
     * @see Router#add - shortcut for OPTIONS requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    options(path, ...fns) { const o = this._extractOpts(fns); this.add('OPTIONS', path, fns, o); return this; }
    /**
     * @see Router#add - shortcut for HEAD requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    head(path, ...fns) { const o = this._extractOpts(fns); this.add('HEAD', path, fns, o); return this; }
    /**
     * @see Router#add - matches every HTTP method.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    all(path, ...fns) { const o = this._extractOpts(fns); this.add('ALL', path, fns, o); return this; }

    /**
     * Chainable route builder - register multiple methods on the same path.
     *
     * @example
     *   router.route('/users')
     *     .get((req, res) => { ... })
     *     .post((req, res) => { ... });
     *
     * @param {string} path - Route pattern.
     * @returns {{ get, post, put, delete, patch, options, head, all: Function }} Chain object with HTTP verb methods.
     */
    route(path)
    {
        const self = this;
        const chain = {};
        for (const m of ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all'])
        {
            chain[m] = (...fns) => { const o = self._extractOpts(fns); self.add(m.toUpperCase(), path, fns, o); return chain; };
        }
        return chain;
    }

    // -- Introspection -----------------------------------

    /**
     * Handle an error thrown by a route handler.
     * Delegates to the app-level error handler if available, otherwise
     * sends a generic 500 JSON response.
     *
     * @param {Error} err - Error object.
     * @param {import('../http/request')} req - HTTP request object.
     * @param {import('../http/response')} res - HTTP response object.
     * @private
     */
    _handleRouteError(err, req, res)
    {
        log.error('route error: %s', err.message || err);
        // Check if the app has an error handler (set via app.onError())
        if (req.app && req.app._errorHandler)
        {
            return req.app._errorHandler(err, req, res, () => {});
        }
        const statusCode = err.statusCode || err.status || 500;
        if (!res.headersSent && !(res.raw && res.raw.headersSent))
        {
            res.status(statusCode).json(
                typeof err.toJSON === 'function'
                    ? err.toJSON()
                    : { error: err.message || 'Internal Server Error' }
            );
        }
    }

    /**
     * Return a flat list of all registered routes, including those in
     * mounted child routers.  Useful for debugging or auto-documentation.
     *
     * @param {string} [prefix=''] - Internal: accumulated prefix from parent routers.
     * @returns {{ method: string, path: string, secure?: boolean }[]} Registered routes.
     */
    inspect(prefix = '')
    {
        const list = [];
        for (const r of this.routes)
        {
            const entry = { method: r.method, path: joinPath(prefix, r.path) };
            if (r.secure === true) entry.secure = true;
            else if (r.secure === false) entry.secure = false;
            list.push(entry);
        }
        for (const child of this._children)
        {
            const childPrefix = prefix ? joinPath(prefix, child.prefix) : child.prefix;
            list.push(...child.router.inspect(childPrefix));
        }
        return list;
    }
}

module.exports = Router;
