function pathToRegex(path)
{
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
    constructor() { this.routes = []; }

    add(method, path, handlers)
    {
        const { regex, keys } = pathToRegex(path);
        this.routes.push({ method: method.toUpperCase(), path, regex, keys, handlers });
    }

    handle(req, res)
    {
        const method = req.method.toUpperCase();
        const url = req.url.split('?')[0];
        for (const r of this.routes)
        {
            if (r.method !== method) continue;
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
        res.status(404).send({ error: 'Not Found' });
    }
}

module.exports = Router;
