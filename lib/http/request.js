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
     * @constructor
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

        /** URL path without query string. */
        this.path = this.url.split('?')[0];

        /** Cookies parsed by cookie-parser middleware (populated by middleware). */
        this.cookies = {};

        /** Request-scoped locals store, shared with response. */
        this.locals = {};

        /**
         * The original URL as received — never rewritten by middleware.
         * Set by `app.handle()`.
         * @type {string}
         */
        this.originalUrl = req.url;

        /**
         * The URL path on which the current router was mounted.
         * Empty string at the top level; set by nested routers.
         * @type {string}
         */
        this.baseUrl = '';

        /**
         * Reference to the parent App instance.
         * Set by `app.handle()`.
         * @type {import('../app')|null}
         */
        this.app = null;
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
        const query = Object.create(null);
        const raw = this.url.substring(idx + 1);
        const parts = raw.split('&');
        const limit = Math.min(parts.length, 100); // Max 100 query params to prevent DoS
        for (let i = 0; i < limit; i++)
        {
            const eqIdx = parts[i].indexOf('=');
            if (eqIdx === -1)
            {
                try {
                    const key = decodeURIComponent(parts[i]);
                    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
                    query[key] = '';
                } catch (e) { }
            }
            else
            {
                try
                {
                    const key = decodeURIComponent(parts[i].substring(0, eqIdx));
                    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
                    query[key] =
                        decodeURIComponent(parts[i].substring(eqIdx + 1));
                } catch (e) { }
            }
        }
        return query;
    }

    /**
     * Get a specific request header (case-insensitive).
     * @param {string} name - Header name to look up.
     * @returns {string|undefined} Header value, or `undefined` if not present.
     */
    get(name)
    {
        return this.headers[name.toLowerCase()];
    }

    /**
     * Check if the request Content-Type matches the given type.
     * @param {string} type - MIME type or shorthand (e.g. `'json'`, `'html'`, `'application/json'`).
     * @returns {boolean} `true` if the Content-Type matches.
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

    /**
     * Get the hostname from the Host header (without port).
     * Respects X-Forwarded-Host when behind a proxy.
     * @returns {string|undefined} Hostname string, or empty string if no Host header.
     */
    get hostname()
    {
        const host = this.headers['x-forwarded-host'] || this.headers['host'] || '';
        // Remove port if present
        const idx = host.indexOf(':');
        return idx !== -1 ? host.slice(0, idx) : host;
    }

    /**
     * Get the subdomains as an array (e.g. `['api', 'v2']` for `'v2.api.example.com'`).
     * @param {number} [offset=2] - Number of dot-separated parts to remove from the right as TLD.
     * @returns {string[]} Array of subdomain strings in reverse order.
     */
    subdomains(offset = 2)
    {
        const host = this.hostname || '';
        const parts = host.split('.');
        return parts.slice(0, Math.max(0, parts.length - offset)).reverse();
    }

    /**
     * Content negotiation — check if the client accepts the given type(s).
     * Returns the best match, or `false` if none match.
     *
     * @param {...string} types - MIME types to check (e.g. 'json', 'html', 'text/plain').
     * @returns {string|false} Best matching type, or `false`.
     *
     * @example
     *   req.accepts('json', 'html') // => 'json' or 'html' or false
     */
    accepts(...types)
    {
        const accept = this.headers['accept'] || '*/*';
        const mimeMap = {
            json: 'application/json',
            html: 'text/html',
            text: 'text/plain',
            xml: 'application/xml',
            css: 'text/css',
            js: 'application/javascript',
        };

        // Hoist wildcard check outside loop
        if (accept === '*/*' || accept.indexOf('*/*') !== -1) return types[0] || false;

        for (let i = 0; i < types.length; i++)
        {
            const t = types[i];
            const mime = mimeMap[t] || t;
            if (accept.indexOf(mime) !== -1) return t;
            const slashIdx = mime.indexOf('/');
            if (slashIdx !== -1 && accept.indexOf(mime.substring(0, slashIdx) + '/*') !== -1) return t;
        }
        return false;
    }

    /**
     * Check if the request is "fresh" (client cache is still valid).
     * Compares If-None-Match / If-Modified-Since with ETag / Last-Modified.
     * @returns {boolean} `true` if the client's cached copy is up to date.
     */
    get fresh()
    {
        const method = this.method;
        if (method !== 'GET' && method !== 'HEAD') return false;

        const noneMatch = this.headers['if-none-match'];
        const modifiedSince = this.headers['if-modified-since'];

        if (!noneMatch && !modifiedSince) return false;

        // Check against response ETag if available
        if (noneMatch && this._res)
        {
            const etag = this._res.get('ETag');
            if (etag && noneMatch === etag) return true;
        }

        // Check against response Last-Modified if available
        if (modifiedSince && this._res)
        {
            const lastMod = this._res.get('Last-Modified');
            if (lastMod)
            {
                const since = Date.parse(modifiedSince);
                const mod = Date.parse(lastMod);
                if (!isNaN(since) && !isNaN(mod) && mod <= since) return true;
            }
        }

        return false;
    }

    /**
     * Inverse of `fresh`.
     * @returns {boolean} `true` if the client's cache is outdated.
     */
    get stale()
    {
        return !this.fresh;
    }

    /**
     * Check whether this request was made with XMLHttpRequest.
     * @returns {boolean} `true` if the `X-Requested-With` header is `'XMLHttpRequest'`.
     */
    get xhr()
    {
        const val = this.headers['x-requested-with'] || '';
        return val.toLowerCase() === 'xmlhttprequest';
    }

    /**
     * Parse the Range header.
     * @param {number} size - Total size of the resource in bytes.
     * @returns {{ type: string, ranges: { start: number, end: number }[] } | -1 | -2}
     *   Returns the parsed ranges, -1 for unsatisfiable ranges, or -2 for malformed header.
     */
    range(size)
    {
        const header = this.headers['range'];
        if (!header) return -2;

        const match = /^(\w+)=(.+)$/.exec(header);
        if (!match) return -2;

        const type = match[1];
        const ranges = [];

        for (const part of match[2].split(','))
        {
            const trimmed = part.trim();
            const dashIdx = trimmed.indexOf('-');
            if (dashIdx === -1) return -2;

            const startStr = trimmed.slice(0, dashIdx).trim();
            const endStr = trimmed.slice(dashIdx + 1).trim();

            let start, end;
            if (startStr === '')
            {
                // Suffix range: -500 means last 500 bytes
                const suffix = parseInt(endStr, 10);
                if (isNaN(suffix)) return -2;
                start = Math.max(0, size - suffix);
                end = size - 1;
            }
            else
            {
                start = parseInt(startStr, 10);
                end = endStr === '' ? size - 1 : parseInt(endStr, 10);
                if (isNaN(start) || isNaN(end)) return -2;
            }

            if (start > end || start >= size) return -1;
            end = Math.min(end, size - 1);
            ranges.push({ start, end });
        }

        if (ranges.length === 0) return -1;
        return { type, ranges };
    }
}

module.exports = Request;
