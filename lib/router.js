/**
 * @module router
 * @description Simple pattern-matching router with named parameters,
 *              wildcard catch-alls, and sequential handler chains.
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

class Router
{
    /** Create a new Router with an empty route table. */
    constructor() { this.routes = []; }

    /**
     * Register a route.
     *
     * @param {string}     method   - HTTP method (e.g. 'GET') or 'ALL' to match any.
     * @param {string}     path     - Route pattern.
     * @param {Function[]} handlers - One or more handler functions `(req, res, next) => void`.
     */
    add(method, path, handlers)
    {
        const { regex, keys } = pathToRegex(path);
        this.routes.push({ method: method.toUpperCase(), path, regex, keys, handlers });
    }

    /**
     * Match an incoming request against the route table and execute the first
     * matching handler chain.  Sends a 404 JSON response when no route matches.
     *
     * @param {import('./request')}  req - Wrapped request.
     * @param {import('./response')} res - Wrapped response.
     */
    handle(req, res)
    {
        const method = req.method.toUpperCase();
        const url = req.url.split('?')[0];
        for (const r of this.routes)
        {
            // ALL matches any method
            if (r.method !== 'ALL' && r.method !== method) continue;
            const m = url.match(r.regex);
            if (!m) continue;
            req.params = {};
            r.keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1] || ''));
            // run handlers sequentially
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
        res.status(404).json({ error: 'Not Found' });
    }
}

module.exports = Router;
