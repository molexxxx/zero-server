class Request
{
    constructor(req)
    {
        this.raw = req;
        this.method = req.method;
        this.url = req.url;
        this.headers = req.headers;
        this.query = this._parseQuery();
        this.params = {};
        this.body = null;
        this.ip = req.socket ? req.socket.remoteAddress : null;
    }

    _parseQuery()
    {
        const idx = this.url.indexOf('?');
        if (idx === -1) return {};
        return Object.fromEntries(new URLSearchParams(this.url.slice(idx + 1)));
    }

    /**
     * Get a specific request header (case-insensitive).
     * @param {string} name
     * @returns {string|undefined}
     */
    get(name)
    {
        return this.headers[name.toLowerCase()];
    }

    /**
     * Check if the request Content-Type matches the given type.
     * @param {string} type - e.g. 'json', 'html', 'application/json'
     * @returns {boolean}
     */
    is(type)
    {
        const ct = this.headers['content-type'] || '';
        if (type.indexOf('/') === -1)
        {
            // shorthand: 'json' → 'application/json', 'html' → 'text/html'
            return ct.indexOf(type) !== -1;
        }
        return ct.indexOf(type) !== -1;
    }
}

module.exports = Request;
