/**
 * @module router
 * @description Full-featured pattern-matching router with named parameters,
 *              wildcard catch-alls, sequential handler chains, sub-router
 *              mounting, and route introspection.
 *
 * @example
 *   const { Router } = require('zero-http');
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
     * Mount a child Router under a path prefix.
     * Requests matching the prefix are delegated to the child router with
     * the prefix stripped from `req.url`.
     *
     * @param {string} prefix - Path prefix (e.g. '/api').
     * @param {Router} router - Child router instance.
     * @returns {Router} `this` for chaining.
     */
    use(prefix, router)
    {
        if (typeof prefix === 'string' && router instanceof Router)
        {
            const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
            this._children.push({ prefix: cleanPrefix, router });
            log.debug('mounted child router at %s', cleanPrefix);
        }
        return this;
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
     * @returns {boolean} Boolean result.
     * @private
     */
    _matchAndExecute(req, res)
    {
        const method = req.method.toUpperCase();
        const url = req.url.split('?')[0];
        log.debug('%s %s', method, url);

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

            if (paramCount > 0) runParams();
            else runHandlers();
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
                req.url = req.url.slice(child.prefix.length) || '/';
                child.router._paramHandlers = this._paramHandlers;
                try
                {
                    const found = child.router._matchAndExecute(req, res);
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
     * @see Router#add — shortcut for GET requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    get(path, ...fns) { const o = this._extractOpts(fns); this.add('GET', path, fns, o); return this; }
    /**
     * @see Router#add — shortcut for POST requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    post(path, ...fns) { const o = this._extractOpts(fns); this.add('POST', path, fns, o); return this; }
    /**
     * @see Router#add — shortcut for PUT requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    put(path, ...fns) { const o = this._extractOpts(fns); this.add('PUT', path, fns, o); return this; }
    /**
     * @see Router#add — shortcut for DELETE requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    delete(path, ...fns) { const o = this._extractOpts(fns); this.add('DELETE', path, fns, o); return this; }
    /**
     * @see Router#add — shortcut for PATCH requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    patch(path, ...fns) { const o = this._extractOpts(fns); this.add('PATCH', path, fns, o); return this; }
    /**
     * @see Router#add — shortcut for OPTIONS requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    options(path, ...fns) { const o = this._extractOpts(fns); this.add('OPTIONS', path, fns, o); return this; }
    /**
     * @see Router#add — shortcut for HEAD requests.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    head(path, ...fns) { const o = this._extractOpts(fns); this.add('HEAD', path, fns, o); return this; }
    /**
     * @see Router#add — matches every HTTP method.
     * @param {string} path - Route pattern.
     * @param {...Function} fns - Handler functions.
     * @returns {Router} `this` for chaining.
     */
    all(path, ...fns) { const o = this._extractOpts(fns); this.add('ALL', path, fns, o); return this; }

    /**
     * Chainable route builder — register multiple methods on the same path.
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
