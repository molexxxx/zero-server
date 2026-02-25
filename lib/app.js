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
    }

    use(fn) { this.middlewares.push(fn); }

    handle(req, res)
    {
        const request = new Request(req);
        const response = new Response(res);

        let idx = 0;
        const run = () =>
        {
            if (idx < this.middlewares.length)
            {
                const mw = this.middlewares[idx++];
                return mw(request, response, run);
            }
            this.router.handle(request, response);
        };

        run();
    }

    listen(port = 3000, cb)
    {
        const server = http.createServer((req, res) => this.handle(req, res));
        return server.listen(port, cb);
    }

    route(method, path, ...fns) { this.router.add(method, path, fns); }

    get(path, ...fns) { this.route('GET', path, ...fns); }
    post(path, ...fns) { this.route('POST', path, ...fns); }
    put(path, ...fns) { this.route('PUT', path, ...fns); }
    delete(path, ...fns) { this.route('DELETE', path, ...fns); }
}

module.exports = App;
