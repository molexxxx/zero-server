/**
 * @module http/request
 * @description Lightweight wrapper around Node's `IncomingMessage`.
 *              Provides parsed query string, params, body, and convenience helpers.
 */

/**
 * Wrapped HTTP request.
 *
 * @property {import('http').IncomingMessage} raw     - Original Node request.
 * @property {string}  method  - HTTP method (e.g. 'GET').
 * @property {string}  url     - Full request URL including query string.
 * @property {object}  headers - Lower-cased request headers.
 * @property {object}  query   - Parsed query-string key/value pairs.
 * @property {object}  params  - Route parameters populated by the router.
 * @property {*}       body    - Request body (set by body-parsing middleware).
 * @property {string|null} ip  - Remote IP address.
 */
class Request
{
    /**
     * @param {import('http').IncomingMessage} req - Raw Node incoming message.
     */
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

        /** `true` when the connection is over TLS (HTTPS). */
        this.secure = !!(req.socket && req.socket.encrypted);

        /** Protocol string — `'https'` or `'http'`. */
        this.protocol = this.secure ? 'https' : 'http';
    }

    /**
     * Parse the query string from `this.url` into a plain object.
     *
     * @private
     * @returns {Object<string, string>} Parsed key-value pairs.
     */
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
