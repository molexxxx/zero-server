/**
 * @module router
 * @description Full-featured pattern-matching router with named parameters,
 *              wildcard catch-alls, sequential handler chains, sub-router
 *              mounting, and route introspection.
 */

/**
 * Convert a route path pattern into a RegExp and extract named parameter keys.
 * Supports `:param` segments and trailing `*` wildcards.
 *
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
 * @param {string} base
 * @param {string} child
 * @returns {string}
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
    }

    /**
     * Register a route.
     *
     * @param {string}     method   - HTTP method (e.g. 'GET') or 'ALL' to match any.
     * @param {string}     path     - Route pattern.
     * @param {Function[]} handlers - One or more handler functions `(req, res, next) => void`.
     * @param {object}     [options]
     * @param {boolean}    [options.secure] - When `true`, route matches only HTTPS requests;
     *                                       when `false`, only HTTP. Omit to match both.
     */
    add(method, path, handlers, options = {})
    {
        const { regex, keys } = pathToRegex(path);
        const entry = { method: method.toUpperCase(), path, regex, keys, handlers };
        if (options.secure !== undefined) entry.secure = !!options.secure;
        this.routes.push(entry);
    }

    /**
     * Mount a child Router under a path prefix.
     * Requests matching the prefix are delegated to the child router with
     * the prefix stripped from `req.url`.
     *
     * @param {string} prefix - Path prefix (e.g. '/api').
     * @param {Router} router - Child router instance.
     */
    use(prefix, router)
    {
        if (typeof prefix === 'string' && router instanceof Router)
        {
            const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
            this._children.push({ prefix: cleanPrefix, router });
        }
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
        const method = req.method.toUpperCase();
        const url = req.url.split('?')[0];

        // Try own routes first
        for (const r of this.routes)
        {
            if (r.method !== 'ALL' && r.method !== method) continue;
            // Protocol-aware matching: skip if secure flag doesn't match
            if (r.secure === true && !req.secure) continue;
            if (r.secure === false && req.secure) continue;
            const m = url.match(r.regex);
            if (!m) continue;
            req.params = {};
            r.keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1] || ''));
            let idx = 0;
            const next = () =>
            {
                if (idx < r.handlers.length)
                {
                    const h = r.handlers[idx++];
                    return h(req, res, next);
                }
            };
            return next();
        }

        // Try child routers
        for (const child of this._children)
        {
            if (url === child.prefix || url.startsWith(child.prefix + '/'))
            {
                const origUrl = req.url;
                req.url = req.url.slice(child.prefix.length) || '/';
                const found = child.router._tryHandle(req, res);
                if (found) return;
                req.url = origUrl; // restore if child didn't match
            }
        }

        res.status(404).json({ error: 'Not Found' });
    }

    /**
     * Try to handle a request without sending 404 on miss.
     * Used internally by parent routers to probe child routers.
     *
     * @param {import('./request')}  req
     * @param {import('./response')} res
     * @returns {boolean} `true` if a route matched.
     * @private
     */
    _tryHandle(req, res)
    {
        const method = req.method.toUpperCase();
        const url = req.url.split('?')[0];

        for (const r of this.routes)
        {
            if (r.method !== 'ALL' && r.method !== method) continue;
            // Protocol-aware matching: skip if secure flag doesn't match
            if (r.secure === true && !req.secure) continue;
            if (r.secure === false && req.secure) continue;
            const m = url.match(r.regex);
            if (!m) continue;
            req.params = {};
            r.keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1] || ''));
            let idx = 0;
            const next = () =>
            {
                if (idx < r.handlers.length)
                {
                    const h = r.handlers[idx++];
                    return h(req, res, next);
                }
            };
            next();
            return true;
        }

        for (const child of this._children)
        {
            if (url === child.prefix || url.startsWith(child.prefix + '/'))
            {
                const origUrl = req.url;
                req.url = req.url.slice(child.prefix.length) || '/';
                const found = child.router._tryHandle(req, res);
                if (found) return true;
                req.url = origUrl;
            }
        }

        return false;
    }

    // -- Convenience route methods (mirror App API) ----------

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

    /** @see Router#add */ get(path, ...fns) { const o = this._extractOpts(fns); this.add('GET', path, fns, o); return this; }
    /** @see Router#add */ post(path, ...fns) { const o = this._extractOpts(fns); this.add('POST', path, fns, o); return this; }
    /** @see Router#add */ put(path, ...fns) { const o = this._extractOpts(fns); this.add('PUT', path, fns, o); return this; }
    /** @see Router#add */ delete(path, ...fns) { const o = this._extractOpts(fns); this.add('DELETE', path, fns, o); return this; }
    /** @see Router#add */ patch(path, ...fns) { const o = this._extractOpts(fns); this.add('PATCH', path, fns, o); return this; }
    /** @see Router#add */ options(path, ...fns) { const o = this._extractOpts(fns); this.add('OPTIONS', path, fns, o); return this; }
    /** @see Router#add */ head(path, ...fns) { const o = this._extractOpts(fns); this.add('HEAD', path, fns, o); return this; }
    /** @see Router#add */ all(path, ...fns) { const o = this._extractOpts(fns); this.add('ALL', path, fns, o); return this; }

    /**
     * Chainable route builder — register multiple methods on the same path.
     *
     * @example
     *   router.route('/users')
     *     .get((req, res) => { ... })
     *     .post((req, res) => { ... });
     *
     * @param {string} path - Route pattern.
     * @returns {object} Chain object with HTTP verb methods.
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
     * Return a flat list of all registered routes, including those in
     * mounted child routers.  Useful for debugging or auto-documentation.
     *
     * @param {string} [prefix=''] - Internal: accumulated prefix from parent routers.
     * @returns {{ method: string, path: string }[]}
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
