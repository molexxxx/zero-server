/**
 * @module http/response
 * @description Lightweight wrapper around Node's `ServerResponse`.
 *              Provides chainable helpers for status, headers, and body output.
 */
const SSEStream = require('../sse/stream');

/**
 * Wrapped HTTP response.
 *
 * @property {import('http').ServerResponse} raw - Original Node response.
 */
class Response
{
    /**
     * @param {import('http').ServerResponse} res - Raw Node server response.
     */
    constructor(res)
    {
        this.raw = res;
        /** @type {number} */
        this._status = 200;
        /** @type {Object<string, string>} */
        this._headers = {};
        /** @type {boolean} */
        this._sent = false;
    }

    /**
     * Set HTTP status code. Chainable.
     *
     * @param {number} code - HTTP status code (e.g. 200, 404).
     * @returns {Response} `this` for chaining.
     */
    status(code) { this._status = code; return this; }

    /**
     * Set a response header. Chainable.
     *
     * @param {string} name  - Header name.
     * @param {string} value - Header value.
     * @returns {Response} `this` for chaining.
     */
    set(name, value) { this._headers[name] = value; return this; }

    /**
     * Get a previously-set response header (case-insensitive).
     *
     * @param {string} name - Header name.
     * @returns {string|undefined}
     */
    get(name)
    {
        const key = Object.keys(this._headers).find(k => k.toLowerCase() === name.toLowerCase());
        return key ? this._headers[key] : undefined;
    }

    /**
     * Set the Content-Type header.
     * Accepts a shorthand alias (`'json'`, `'html'`, `'text'`, etc.) or
     * a full MIME string. Chainable.
     *
     * @param {string} ct - MIME type or shorthand alias.
     * @returns {Response} `this` for chaining.
     */
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

    /**
     * Send a response body and finalise the response.
     * Auto-detects Content-Type (Buffer → octet-stream, string → text or
     * HTML, object → JSON) when not explicitly set.
     *
     * @param {string|Buffer|object|null} body - Response payload.
     */
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

    /**
     * Send a JSON response.  Sets `Content-Type: application/json`.
     *
     * @param {*} obj - Value to serialise as JSON.
     */
    json(obj) { this.set('Content-Type', 'application/json'); return this.send(obj); }

    /**
     * Send a plain-text response.  Sets `Content-Type: text/plain`.
     *
     * @param {string} str - Text payload.
     */
    text(str) { this.set('Content-Type', 'text/plain'); return this.send(String(str)); }

    /**
     * Send an HTML response.  Sets `Content-Type: text/html`.
     *
     * @param {string} str - HTML payload.
     */
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

    // -- Server-Sent Events (SSE) ---------------------

    /**
     * Open a Server-Sent Events stream.  Sets the correct headers and
     * returns an SSE controller object with methods for pushing events.
     *
     * The connection stays open until the client disconnects or you call
     * `sse.close()`.
     *
     * @param {object} [opts]
     * @param {number}  [opts.retry]          - Reconnection interval hint (ms) sent to client.
     * @param {object}  [opts.headers]        - Additional headers to set on the response.
     * @param {number}  [opts.keepAlive=0]    - Auto keep-alive interval in ms. `0` to disable.
     * @param {string}  [opts.keepAliveComment='ping'] - Comment text for keep-alive messages.
     * @param {boolean} [opts.autoId=false]   - Auto-increment event IDs on every `.send()` / `.event()`.
     * @param {number}  [opts.startId=1]      - Starting value for auto-IDs.
     * @param {number}  [opts.pad=0]          - Bytes of initial padding (helps flush proxy buffers).
     * @param {number}  [opts.status=200]     - HTTP status code for the SSE response.
     * @returns {SSEStream} SSE controller.
     *
     * @example
     *   app.get('/events', (req, res) => {
     *       const sse = res.sse({ retry: 5000, keepAlive: 30000, autoId: true });
     *       sse.send('hello');                         // id: 1, data: hello
     *       sse.event('update', { x: 1 });             // id: 2, event: update
     *       sse.comment('debug note');                  // : debug note
     *       sse.on('close', () => console.log('gone'));
     *   });
     */
    sse(opts = {})
    {
        if (this._sent) return null;
        this._sent = true;

        const raw = this.raw;
        const statusCode = opts.status || 200;
        raw.writeHead(statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...(opts.headers || {}),
        });

        // Initial padding to push past proxy buffers (e.g. 2 KB)
        if (opts.pad && opts.pad > 0)
        {
            raw.write(': ' + ' '.repeat(opts.pad) + '\n\n');
        }

        if (opts.retry)
        {
            raw.write(`retry: ${opts.retry}\n\n`);
        }

        // Capture the Last-Event-ID header from the request if available
        const lastEventId = this._headers['_sse_last_event_id'] || null;

        return new SSEStream(raw, {
            keepAlive: opts.keepAlive || 0,
            keepAliveComment: opts.keepAliveComment || 'ping',
            autoId: !!opts.autoId,
            startId: opts.startId || 1,
            lastEventId,
            secure: !!(raw.socket && raw.socket.encrypted),
        });
    }
}

module.exports = Response;
