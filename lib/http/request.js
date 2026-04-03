/**
 * @module http/request
 * @description Lightweight wrapper around Node's `IncomingMessage`.
 *              Provides parsed query string, params, body, and convenience helpers.
 *
 *              Supports trust-proxy configuration via `app.set('trust proxy', value)`
 *              to correctly resolve `req.ip`, `req.ips`, `req.protocol`, `req.secure`,
 *              and `req.hostname` when behind reverse proxies.
 *
 *              HTTP/2 compatible — detects pseudo-headers (`:method`, `:path`,
 *              `:authority`) from HTTP/2 requests automatically.
 */
const net = require('net');

// -- Trust Proxy Helpers ------------------------------------------

/**
 * Parse a CIDR notation string into address and prefix length.
 *
 * @param {string} cidr - CIDR string (e.g. `'10.0.0.0/8'`, `'::1/128'`).
 * @returns {{ ip: string, prefixLen: number, isIPv6: boolean }|null}
 * @private
 */
function _parseCIDR(cidr)
{
    const slash = cidr.indexOf('/');
    if (slash === -1) return null;
    const ip = cidr.substring(0, slash);
    const prefixLen = parseInt(cidr.substring(slash + 1), 10);
    if (!net.isIP(ip) || isNaN(prefixLen)) return null;
    const isIPv6 = net.isIPv6(ip);
    const maxBits = isIPv6 ? 128 : 32;
    if (prefixLen < 0 || prefixLen > maxBits) return null;
    return { ip, prefixLen, isIPv6 };
}

/**
 * Convert an IPv4 address string to a 32-bit integer.
 *
 * @param {string} ip - IPv4 address.
 * @returns {number}
 * @private
 */
function _ipv4ToInt(ip)
{
    const parts = ip.split('.');
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Convert an IPv6 address to a 16-byte Uint8Array.
 *
 * @param {string} ip - IPv6 address (full or abbreviated).
 * @returns {Uint8Array}
 * @private
 */
function _ipv6ToBytes(ip)
{
    // Handle IPv4-mapped IPv6
    if (ip.startsWith('::ffff:') && net.isIPv4(ip.substring(7)))
    {
        const v4 = _ipv4ToInt(ip.substring(7));
        const bytes = new Uint8Array(16);
        bytes[10] = 0xff; bytes[11] = 0xff;
        bytes[12] = (v4 >>> 24) & 0xff;
        bytes[13] = (v4 >>> 16) & 0xff;
        bytes[14] = (v4 >>> 8) & 0xff;
        bytes[15] = v4 & 0xff;
        return bytes;
    }

    const bytes = new Uint8Array(16);
    const parts = ip.split('::');
    let groups;

    if (parts.length === 2)
    {
        const left = parts[0] ? parts[0].split(':') : [];
        const right = parts[1] ? parts[1].split(':') : [];
        const missing = 8 - left.length - right.length;
        groups = [...left, ...Array(missing).fill('0'), ...right];
    }
    else
    {
        groups = ip.split(':');
    }

    for (let i = 0; i < 8; i++)
    {
        const val = parseInt(groups[i] || '0', 16);
        bytes[i * 2] = (val >>> 8) & 0xff;
        bytes[i * 2 + 1] = val & 0xff;
    }
    return bytes;
}

/**
 * Check if an IP address is within a CIDR range.
 *
 * @param {string} addr - IP address to check.
 * @param {object} cidr - Parsed CIDR from `_parseCIDR()`.
 * @returns {boolean}
 * @private
 */
function _inCIDR(addr, cidr)
{
    const addrIsV6 = net.isIPv6(addr);
    const addrIsV4 = net.isIPv4(addr);

    // Normalise IPv4-mapped IPv6 to plain IPv4 for comparison
    let normAddr = addr;
    if (addrIsV6 && addr.startsWith('::ffff:'))
    {
        const v4Part = addr.substring(7);
        if (net.isIPv4(v4Part)) normAddr = v4Part;
    }

    if (cidr.isIPv6)
    {
        // Both must be IPv6 (or IPv4-mapped)
        const addrBytes = addrIsV6 ? _ipv6ToBytes(addr) : _ipv6ToBytes('::ffff:' + addr);
        const cidrBytes = _ipv6ToBytes(cidr.ip);
        const fullBytes = Math.floor(cidr.prefixLen / 8);
        const remainBits = cidr.prefixLen % 8;

        for (let i = 0; i < fullBytes; i++)
        {
            if (addrBytes[i] !== cidrBytes[i]) return false;
        }
        if (remainBits > 0)
        {
            const mask = (0xff << (8 - remainBits)) & 0xff;
            if ((addrBytes[fullBytes] & mask) !== (cidrBytes[fullBytes] & mask)) return false;
        }
        return true;
    }

    // IPv4 CIDR
    if (!net.isIPv4(normAddr)) return false;
    const addrInt = _ipv4ToInt(normAddr);
    const cidrInt = _ipv4ToInt(cidr.ip);
    const mask = cidr.prefixLen === 0 ? 0 : (~0 << (32 - cidr.prefixLen)) >>> 0;
    return (addrInt & mask) === (cidrInt & mask);
}

/**
 * Compile a `trust proxy` setting into a function `(addr, index) => boolean`.
 *
 * Supported values:
 * - `true` / `'loopback'` — trust loopback IPs (127.0.0.0/8, ::1)
 * - `false` — trust nothing
 * - `number` — trust the first N hops (proxies)
 * - `string` — comma-separated IPs or CIDR ranges
 * - `string[]` — array of IPs or CIDR ranges
 * - `function` — custom `(addr, index) => boolean`
 *
 * @param {*} val - The `trust proxy` setting value.
 * @returns {Function} `(addr: string, hopIndex: number) => boolean`
 * @private
 */
function compileTrust(val)
{
    if (typeof val === 'function') return val;
    if (val === true || val === 'loopback')
    {
        return (addr) =>
        {
            // Trust loopback addresses
            if (addr === '127.0.0.1' || addr === '::1') return true;
            // IPv4-mapped IPv6 loopback
            if (addr === '::ffff:127.0.0.1') return true;
            // Full 127.0.0.0/8 range
            if (net.isIPv4(addr) && addr.startsWith('127.')) return true;
            return false;
        };
    }
    if (val === false || val === undefined || val === null || val === 0) return () => false;
    if (typeof val === 'number' && val > 0)
    {
        // Trust all addresses — the hop count is handled by _resolveProxyChain
        return () => true;
    }

    // String or array of IPs / CIDRs
    const entries = Array.isArray(val)
        ? val
        : typeof val === 'string' ? val.split(',').map(s => s.trim()) : [];

    const cidrs = [];
    const exact = new Set();

    for (const entry of entries)
    {
        if (entry.indexOf('/') !== -1)
        {
            const parsed = _parseCIDR(entry);
            if (parsed) cidrs.push(parsed);
        }
        else if (entry === 'loopback')
        {
            exact.add('127.0.0.1');
            exact.add('::1');
            exact.add('::ffff:127.0.0.1');
            cidrs.push({ ip: '127.0.0.0', prefixLen: 8, isIPv6: false });
        }
        else if (entry === 'linklocal')
        {
            cidrs.push({ ip: '169.254.0.0', prefixLen: 16, isIPv6: false });
            cidrs.push(_parseCIDR('fe80::/10'));
        }
        else if (entry === 'uniquelocal')
        {
            cidrs.push({ ip: '10.0.0.0', prefixLen: 8, isIPv6: false });
            cidrs.push({ ip: '172.16.0.0', prefixLen: 12, isIPv6: false });
            cidrs.push({ ip: '192.168.0.0', prefixLen: 16, isIPv6: false });
            cidrs.push(_parseCIDR('fc00::/7'));
        }
        else
        {
            exact.add(entry);
        }
    }

    return (addr) =>
    {
        if (exact.has(addr)) return true;
        for (let i = 0; i < cidrs.length; i++)
        {
            if (cidrs[i] && _inCIDR(addr, cidrs[i])) return true;
        }
        return false;
    };
}

/**
 * Walk the X-Forwarded-For chain from right to left, stopping at the
 * first untrusted address. Returns the client IP and the full chain.
 *
 * @param {string}   socketAddr   - Socket remote address.
 * @param {string}   [xffHeader]  - X-Forwarded-For header value.
 * @param {Function} trustFn      - Compiled trust function.
 * @param {*}        trustSetting - Original trust proxy setting (for hop-count mode).
 * @returns {{ ip: string, ips: string[] }}
 * @private
 */
function _resolveProxyChain(socketAddr, xffHeader, trustFn, trustSetting)
{
    if (!xffHeader) return { ip: socketAddr, ips: [] };

    const addrs = xffHeader.split(',').map(s => s.trim()).filter(Boolean);
    // Full chain from client → proxy1 → proxy2 → socket
    const chain = [...addrs, socketAddr];

    // Hop-count mode: trust exactly N proxies from the right
    if (typeof trustSetting === 'number' && trustSetting > 0)
    {
        const hops = Math.min(trustSetting, addrs.length);
        const clientIdx = addrs.length - hops;
        return {
            ip: addrs[clientIdx] || socketAddr,
            ips: chain,
        };
    }

    // Walk from the rightmost (closest proxy) to left
    // The socket address is the last proxy
    if (!trustFn(socketAddr, 0)) return { ip: socketAddr, ips: [] };

    for (let i = addrs.length - 1; i >= 0; i--)
    {
        if (!trustFn(addrs[i], addrs.length - i))
        {
            // This address is not trusted — it's the client
            return { ip: addrs[i], ips: chain };
        }
    }

    // All addresses are trusted — leftmost is the client
    return { ip: addrs[0] || socketAddr, ips: chain };
}

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

        // HTTP/2 pseudo-headers take priority
        this.method = req.headers?.[':method'] || req.method;
        this.url = req.headers?.[':path'] || req.url;

        this.headers = req.headers;
        this.query = this._parseQuery();
        this.params = {};
        this.body = null;

        /** Raw socket IP (before trust proxy resolution). @private */
        this._socketIp = req.socket ? req.socket.remoteAddress : null;

        /** HTTP version (e.g. '2.0' for HTTP/2). @type {string} */
        this.httpVersion = req.httpVersion;

        /** `true` when the connection is over TLS (HTTPS) — raw socket check. @private */
        this._socketSecure = !!(req.socket && req.socket.encrypted);

        /** ALPN protocol negotiated (e.g. 'h2', 'http/1.1'). @type {string|null} */
        this.alpnProtocol = req.socket?.alpnProtocol || null;

        /** `true` when the request was received over HTTP/2. @type {boolean} */
        this.isHTTP2 = req.httpVersionMajor === 2 || this.httpVersion === '2.0';

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

        /** @private Cached compiled trust function. */
        this._trustFn = null;
        /** @private Cached trust proxy resolution. */
        this._proxyResolved = null;
    }

    // -- Trust Proxy Resolution --------------------------------

    /**
     * Get or compile the trust function from `app.set('trust proxy')`.
     * @private
     * @returns {Function}
     */
    _getTrustFn()
    {
        if (this._trustFn) return this._trustFn;
        if (!this.app) return () => false;
        const setting = this.app.set('trust proxy');
        this._trustFn = compileTrust(setting);
        return this._trustFn;
    }

    /**
     * Resolve proxy chain once (cached).
     * @private
     * @returns {{ ip: string, ips: string[] }}
     */
    _resolveProxy()
    {
        if (this._proxyResolved) return this._proxyResolved;
        const trustFn = this._getTrustFn();
        const setting = this.app ? this.app.set('trust proxy') : false;
        // Only parse X-Forwarded-For when trust proxy is enabled
        const xff = (setting !== false && setting !== undefined && setting !== null && setting !== 0)
            ? this.headers['x-forwarded-for']
            : undefined;
        this._proxyResolved = _resolveProxyChain(this._socketIp, xff, trustFn, setting);
        return this._proxyResolved;
    }

    /**
     * Client IP address.
     * When `trust proxy` is enabled, resolves through the X-Forwarded-For chain.
     * @type {string|null}
     */
    get ip()
    {
        if (!this.app) return this._socketIp;
        const setting = this.app.set('trust proxy');
        if (!setting && setting !== 0) return this._socketIp;
        return this._resolveProxy().ip;
    }

    /**
     * Full proxy chain from X-Forwarded-For (client → proxy1 → proxy2 → socket).
     * Empty array when `trust proxy` is not enabled.
     * @type {string[]}
     */
    get ips()
    {
        if (!this.app) return [];
        const setting = this.app.set('trust proxy');
        if (!setting && setting !== 0) return [];
        return this._resolveProxy().ips;
    }

    /**
     * Request protocol (`'https'` or `'http'`).
     * Reads `X-Forwarded-Proto` when behind a trusted proxy.
     * @type {string}
     */
    get protocol()
    {
        if (this._socketSecure) return 'https';
        if (!this.app) return 'http';
        const setting = this.app.set('trust proxy');
        if (!setting && setting !== 0) return 'http';

        const trustFn = this._getTrustFn();
        const trusted = typeof setting === 'number'
            ? setting > 0
            : trustFn(this._socketIp, 0);

        if (trusted)
        {
            const proto = this.headers['x-forwarded-proto'];
            if (proto)
            {
                // X-Forwarded-Proto may be comma-separated; take the first (client's)
                const first = proto.split(',')[0].trim().toLowerCase();
                if (first === 'https' || first === 'http') return first;
            }
        }
        return 'http';
    }

    /**
     * `true` when the connection is over HTTPS.
     * Respects `X-Forwarded-Proto` when trust proxy is enabled.
     * @type {boolean}
     */
    get secure()
    {
        return this.protocol === 'https';
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
     * Only reads `X-Forwarded-Host` when `trust proxy` is enabled.
     * On HTTP/2, falls back to the `:authority` pseudo-header.
     * @returns {string} Hostname string, or empty string if no Host header.
     */
    get hostname()
    {
        let host;

        // Only trust X-Forwarded-Host when proxy is trusted
        if (this.app)
        {
            const setting = this.app.set('trust proxy');
            if (setting && setting !== 0)
            {
                const trustFn = this._getTrustFn();
                const trusted = typeof setting === 'number'
                    ? setting > 0
                    : trustFn(this._socketIp, 0);
                if (trusted)
                {
                    host = this.headers['x-forwarded-host'];
                }
            }
        }

        // Fallback chain: Host header → :authority (HTTP/2)
        if (!host) host = this.headers['host'] || this.headers[':authority'] || '';

        // Remove port if present (handle IPv6 bracket notation)
        if (host.charAt(0) === '[')
        {
            // IPv6: [::1]:3000
            const closeBracket = host.indexOf(']');
            return closeBracket !== -1 ? host.slice(0, closeBracket + 1) : host;
        }
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
module.exports.compileTrust = compileTrust;
