const http = require('http');
const Router = require('./router');
const Request = require('./request');
const Response = require('./response');

class App
{
    constructor()
    {
        this.router = new Router();
        this.middlewares = [];
        this._errorHandler = null;

        // Bind for use as `http.createServer(app.handler)`
        this.handler = (req, res) => this.handle(req, res);
    }

    /**
     * Register middleware. Supports:
     *   use(fn)            — global middleware
     *   use('/prefix', fn) — path-scoped middleware (strips prefix before calling fn)
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
     * Register a global error handler: fn(err, req, res, next)
     */
    onError(fn)
    {
        this._errorHandler = fn;
    }

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

    listen(port = 3000, cb)
    {
        const server = http.createServer(this.handler);
        return server.listen(port, cb);
    }

    route(method, path, ...fns) { this.router.add(method, path, fns); }

    // HTTP method shortcuts
    get(path, ...fns) { this.route('GET', path, ...fns); }
    post(path, ...fns) { this.route('POST', path, ...fns); }
    put(path, ...fns) { this.route('PUT', path, ...fns); }
    delete(path, ...fns) { this.route('DELETE', path, ...fns); }
    patch(path, ...fns) { this.route('PATCH', path, ...fns); }
    options(path, ...fns) { this.route('OPTIONS', path, ...fns); }
    head(path, ...fns) { this.route('HEAD', path, ...fns); }
    all(path, ...fns) { this.route('ALL', path, ...fns); }
}

module.exports = App;
