class Response
{
    constructor(res)
    {
        this.raw = res;
        this._status = 200;
        this._headers = {};
        this._sent = false;
    }

    /** Set HTTP status code. Chainable. */
    status(code) { this._status = code; return this; }

    /** Set a response header. Chainable. */
    set(name, value) { this._headers[name] = value; return this; }

    /** Get a previously-set response header (case-insensitive). */
    get(name)
    {
        const key = Object.keys(this._headers).find(k => k.toLowerCase() === name.toLowerCase());
        return key ? this._headers[key] : undefined;
    }

    /** Set Content-Type header. Chainable. */
    type(ct)
    {
        const map = {
            json: 'application/json',
            html: 'text/html',
            text: 'text/plain',
            xml: 'application/xml',
            form: 'application/x-www-form-urlencoded',
            bin: 'application/octet-stream',
        };
        this._headers['Content-Type'] = map[ct] || ct;
        return this;
    }

    /** Send a response body. Auto-detects Content-Type when not explicitly set. */
    send(body)
    {
        if (this._sent) return;
        const res = this.raw;

        Object.entries(this._headers).forEach(([k, v]) => res.setHeader(k, v));
        res.statusCode = this._status;

        if (body === undefined || body === null)
        {
            res.end();
            this._sent = true;
            return;
        }

        // Auto-detect Content-Type if not already set
        const hasContentType = Object.keys(this._headers).some(k => k.toLowerCase() === 'content-type');

        if (Buffer.isBuffer(body))
        {
            if (!hasContentType) res.setHeader('Content-Type', 'application/octet-stream');
            res.end(body);
        }
        else if (typeof body === 'string')
        {
            if (!hasContentType)
            {
                // Heuristic: if it looks like HTML, set text/html
                res.setHeader('Content-Type', body.trimStart().startsWith('<') ? 'text/html' : 'text/plain');
            }
            res.end(body);
        }
        else
        {
            // Object / array → JSON
            if (!hasContentType) res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body));
        }
        this._sent = true;
    }

    /** Send JSON response. */
    json(obj) { this.set('Content-Type', 'application/json'); return this.send(obj); }

    /** Send plain-text response. */
    text(str) { this.set('Content-Type', 'text/plain'); return this.send(String(str)); }

    /** Send HTML response. */
    html(str) { this.set('Content-Type', 'text/html'); return this.send(String(str)); }

    /**
     * Redirect to the given URL with an optional status code (default 302).
     * @param {number|string} statusOrUrl - Status code or URL.
     * @param {string} [url] - URL if first arg was status code.
     */
    redirect(statusOrUrl, url)
    {
        if (this._sent) return;
        let code = 302;
        let target = statusOrUrl;
        if (typeof statusOrUrl === 'number') { code = statusOrUrl; target = url; }
        this._status = code;
        this.set('Location', target);
        this.send('');
    }
}

module.exports = Response;
