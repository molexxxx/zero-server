/**
 * @module http/response
 * @description Lightweight wrapper around Node's `ServerResponse`.
 *              Provides chainable helpers for status, headers, body output,
 *              and HTTP/2 server push.
 */
const fs = require('fs');
const nodePath = require('path');
const SSEStream = require('../sse/stream');
const log = require('../debug')('zero:http');

/** HTTP status code reason phrases. */
const STATUS_CODES = {
    200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
    302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
    403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
    408: 'Request Timeout', 409: 'Conflict', 413: 'Payload Too Large',
    415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
    429: 'Too Many Requests', 500: 'Internal Server Error',
    502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** Extension → MIME-type for sendFile/download. */
const MIME_MAP = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/**
 * Wrapped HTTP response.
 *
 * @property {import('http').ServerResponse} raw - Original Node response.
 */
class Response
{
    /**
     * @constructor
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
        /** Request-scoped locals store. */
        this.locals = {};
        /**
         * Reference to the parent App instance.
         * Set by `app.handle()`.
         * @type {import('../app')|null}
         */
        this.app = null;
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
    set(name, value)
    {
        // Prevent CRLF header injection
        const sName = String(name);
        const sValue = String(value);
        if (/[\r\n]/.test(sName) || /[\r\n]/.test(sValue))
        {
            throw new Error('Header values must not contain CR or LF characters');
        }
        this._headers[sName] = sValue;
        return this;
    }

    /**
     * Get a previously-set response header (case-insensitive).
     *
     * @param {string} name - Header name.
     * @returns {string|undefined} Header value, or `undefined` if not set.
     */
    get(name)
    {
        const lower = name.toLowerCase();
        const keys = Object.keys(this._headers);
        for (let i = 0; i < keys.length; i++)
        {
            if (keys[i].toLowerCase() === lower) return this._headers[keys[i]];
        }
        return undefined;
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
     * @returns {void}
     */
    send(body)
    {
        if (this._sent) return;
        log.debug('send %d', this._status);
        const res = this.raw;

        const hdrKeys = Object.keys(this._headers);
        for (let i = 0; i < hdrKeys.length; i++) res.setHeader(hdrKeys[i], this._headers[hdrKeys[i]]);
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
                // Avoid trimStart() allocation — scan for first non-whitespace char
                let isHTML = false;
                for (let i = 0; i < body.length; i++)
                {
                    const c = body.charCodeAt(i);
                    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
                    isHTML = c === 60; // '<'
                    break;
                }
                res.setHeader('Content-Type', isHTML ? 'text/html' : 'text/plain');
            }
            res.end(body);
        }
        else
        {
            // Object / array → JSON
            if (!hasContentType) res.setHeader('Content-Type', 'application/json');
            let json;
            try { json = JSON.stringify(body); }
            catch (e)
            {
                log.error('JSON.stringify failed: %s', e.message);
                res.setHeader('Content-Type', 'application/json');
                this._status = 500;
                res.statusCode = 500;
                json = JSON.stringify({ error: 'Failed to serialize response body' });
            }
            res.end(json);
        }
        this._sent = true;
    }

    /**
     * Send a JSON response.  Sets `Content-Type: application/json`.
     *
     * @param {*} obj - Value to serialise as JSON.
     * @returns {void}
     */
    json(obj) { this.set('Content-Type', 'application/json'); return this.send(obj); }

    /**
     * Send a plain-text response.  Sets `Content-Type: text/plain`.
     *
     * @param {string} str - Text payload.
     * @returns {void}
     */
    text(str) { this.set('Content-Type', 'text/plain'); return this.send(String(str)); }

    /**
     * Send an HTML response.  Sets `Content-Type: text/html`.
     *
     * @param {string} str - HTML payload.
     * @returns {void}
     */
    html(str) { this.set('Content-Type', 'text/html'); return this.send(String(str)); }

    /**
     * Send only the status code with the standard reason phrase as body.
     * @param {number} code - HTTP status code.
     * @returns {void}
     */
    sendStatus(code)
    {
        this._status = code;
        const body = STATUS_CODES[code] || String(code);
        this.type('text').send(body);
    }

    /**
     * Append a value to a header. If the header already exists,
     * creates a comma-separated list.
     * @param {string} name  - Header name.
     * @param {string} value - Header value to append.
     * @returns {Response} `this` for chaining.
     */
    append(name, value)
    {
        const sValue = String(value);
        if (/[\r\n]/.test(sValue))
        {
            throw new Error('Header values must not contain CR or LF characters');
        }
        const existing = this.get(name);
        if (existing)
        {
            this._headers[name] = existing + ', ' + sValue;
        }
        else
        {
            this._headers[name] = sValue;
        }
        return this;
    }

    /**
     * Add the given field to the Vary response header.
     * @param {string} field - Header field name to add to Vary.
     * @returns {Response} `this` for chaining.
     */
    vary(field)
    {
        const existing = this.get('Vary') || '';
        if (existing === '*') return this;
        if (field === '*') { this.set('Vary', '*'); return this; }
        const fields = existing ? existing.split(/\s*,\s*/) : [];
        if (!fields.some(f => f.toLowerCase() === field.toLowerCase()))
        {
            fields.push(field);
        }
        this.set('Vary', fields.join(', '));
        return this;
    }

    /**
     * Whether headers have been sent to the client.
     * @type {boolean}
     */
    get headersSent()
    {
        return this.raw.headersSent;
    }

    /**
     * Send a file as the response. Streams the file with proper Content-Type.
     * @param {string}   filePath - Path to the file.
     * @param {object}   [opts] - Configuration options.
     * @param {object}   [opts.headers]   - Additional headers to set.
     * @param {string}   [opts.root]      - Root directory for relative paths.
     * @param {Function} [cb]             - Callback `(err) => void`.
     * @returns {void}
     */
    sendFile(filePath, opts, cb)
    {
        if (this._sent) return;
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (!opts) opts = {};

        let fullPath = opts.root ? nodePath.resolve(opts.root, filePath) : nodePath.resolve(filePath);

        // Prevent path traversal
        if (opts.root)
        {
            const resolvedRoot = nodePath.resolve(opts.root);
            if (!fullPath.startsWith(resolvedRoot + nodePath.sep) && fullPath !== resolvedRoot)
            {
                const err = new Error('Forbidden');
                err.status = 403;
                if (cb) return cb(err);
                return this.status(403).json({ error: 'Forbidden' });
            }
        }

        if (fullPath.indexOf('\0') !== -1)
        {
            const err = new Error('Bad Request');
            err.status = 400;
            if (cb) return cb(err);
            return this.status(400).json({ error: 'Bad Request' });
        }

        fs.stat(fullPath, (err, stat) =>
        {
            if (err || !stat.isFile())
            {
                const e = err || new Error('Not Found');
                e.status = 404;
                if (cb) return cb(e);
                return this.status(404).json({ error: 'Not Found' });
            }

            const ext = nodePath.extname(fullPath).toLowerCase();
            const ct = MIME_MAP[ext] || 'application/octet-stream';

            const raw = this.raw;
            const hk = Object.keys(this._headers);
            for (let i = 0; i < hk.length; i++) raw.setHeader(hk[i], this._headers[hk[i]]);
            if (opts.headers)
            {
                const ok = Object.keys(opts.headers);
                for (let i = 0; i < ok.length; i++) raw.setHeader(ok[i], opts.headers[ok[i]]);
            }
            raw.setHeader('Content-Type', ct);
            raw.setHeader('Content-Length', stat.size);
            raw.statusCode = this._status;

            const stream = fs.createReadStream(fullPath);
            stream.on('error', (e) =>
            {
                if (cb) return cb(e);
                try { raw.statusCode = 500; raw.end(); } catch (ex) { }
            });
            stream.on('end', () =>
            {
                this._sent = true;
                if (cb) cb(null);
            });
            stream.pipe(raw);
        });
    }

    /**
     * Prompt a file download. Sets Content-Disposition: attachment.
     * @param {string}   filePath  - Path to the file.
     * @param {string}   [filename] - Override the download filename.
     * @param {Function} [cb]       - Callback on complete/error.
     * @returns {void}
     */
    download(filePath, filename, cb)
    {
        if (typeof filename === 'function') { cb = filename; filename = undefined; }
        const name = filename || nodePath.basename(filePath);
        this.set('Content-Disposition', `attachment; filename="${name.replace(/"/g, '\\"')}"`);
        this.sendFile(filePath, {}, cb);
    }

    /**
     * Set a cookie on the response.
     *
     * @param {string}      name    - Cookie name.
     * @param {*}           value   - Cookie value (strings, objects/arrays auto-serialise as JSON cookies).
     * @param {object}      [opts] - Configuration options.
     * @param {string}       [opts.domain]         - Cookie domain.
     * @param {string}       [opts.path='/']       - Cookie path.
     * @param {Date|number}  [opts.expires]        - Expiration date.
     * @param {number}       [opts.maxAge]         - Max-Age in seconds.
     * @param {boolean}      [opts.httpOnly=true]  - HTTP-only flag (default: true for security).
     * @param {boolean}      [opts.secure]         - Secure flag.
     * @param {string}       [opts.sameSite='Lax'] - SameSite attribute (Strict, Lax, None).
     * @param {boolean}      [opts.signed]         - Sign the cookie value using req.secret.
     * @param {string}       [opts.priority]       - Priority attribute (Low, Medium, High).
     * @param {boolean}      [opts.partitioned]    - Partitioned/CHIPS attribute.
     * @returns {Response} `this` for chaining.
     *
     * @example
     *   res.cookie('name', 'value');
     *   res.cookie('prefs', { theme: 'dark' });           // auto JSON cookie
     *   res.cookie('token', 'abc', { signed: true });     // auto-signed
     *   res.cookie('sid', 'xyz', { secure: true, sameSite: 'Strict' });
     */
    cookie(name, value, opts = {})
    {
        if (/[=;,\s]/.test(name))
        {
            throw new Error('Cookie name must not contain =, ;, comma, or whitespace');
        }

        // Auto-serialize objects/arrays as JSON cookies (j: prefix)
        let val = value;
        if (typeof val === 'object' && val !== null && !(val instanceof Date))
        {
            val = 'j:' + JSON.stringify(val);
        }
        else
        {
            val = String(val);
        }

        // Auto-sign when opts.signed is true
        if (opts.signed)
        {
            const secret = (this._req && this._req.secret) || (opts.secret);
            if (!secret) throw new Error('cookieParser(secret) required for signed cookies');
            const crypto = require('crypto');
            const sig = crypto
                .createHmac('sha256', secret)
                .update(val)
                .digest('base64')
                .replace(/=+$/, '');
            val = `s:${val}.${sig}`;
        }

        let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(val)}`;

        if (opts.domain) cookie += `; Domain=${opts.domain}`;
        cookie += `; Path=${opts.path || '/'}`;

        if (opts.maxAge !== undefined)
        {
            cookie += `; Max-Age=${Math.floor(opts.maxAge)}`;
        }
        else if (opts.expires)
        {
            const expires = opts.expires instanceof Date ? opts.expires : new Date(opts.expires);
            cookie += `; Expires=${expires.toUTCString()}`;
        }

        if (opts.httpOnly !== false) cookie += '; HttpOnly';
        if (opts.secure) cookie += '; Secure';
        cookie += `; SameSite=${opts.sameSite || 'Lax'}`;
        if (opts.priority) cookie += `; Priority=${opts.priority}`;
        if (opts.partitioned) cookie += '; Partitioned';

        const raw = this.raw;
        const existing = raw.getHeader('Set-Cookie');
        if (existing)
        {
            const arr = Array.isArray(existing) ? existing : [existing];
            arr.push(cookie);
            raw.setHeader('Set-Cookie', arr);
        }
        else
        {
            raw.setHeader('Set-Cookie', cookie);
        }

        return this;
    }

    /**
     * Clear a cookie by setting it to expire in the past.
     * @param {string} name  - Cookie name.
     * @param {object} [opts] - Must match path/domain of the original cookie.
     * @param {string} [opts.path='/']  - Cookie path (must match the original).
     * @param {string} [opts.domain]    - Cookie domain (must match the original).
     * @param {boolean} [opts.secure]   - Secure flag.
     * @param {string} [opts.sameSite]  - SameSite attribute.
     * @returns {Response} `this` for chaining.
     */
    clearCookie(name, opts = {})
    {
        return this.cookie(name, '', { ...opts, expires: new Date(0), maxAge: 0 });
    }

    /**
     * Respond with content-negotiated output based on the request Accept header.
     * Calls the handler matching the best accepted type.
     *
     * @param {Object<string, Function>} types - Map of MIME types to handler functions.
     *
     * @example
     *   res.format({
     *       'text/html': () => res.html('<h1>Hello</h1>'),
     *       'application/json': () => res.json({ hello: 'world' }),
     *       default: () => res.status(406).send('Not Acceptable'),
     *   });
     */
    format(types)
    {
        const req = this._req;
        const accept = (req && req.headers && req.headers['accept']) || '*/*';

        for (const [type, handler] of Object.entries(types))
        {
            if (type === 'default') continue;
            if (accept === '*/*' || accept.indexOf('*/*') !== -1 || accept.indexOf(type) !== -1)
            {
                this.type(type);
                return handler();
            }
            // Check main-type wildcard (e.g. text/*)
            const mainType = type.split('/')[0];
            if (accept.indexOf(mainType + '/*') !== -1)
            {
                this.type(type);
                return handler();
            }
        }

        if (types.default) return types.default();
        this.status(406).json({ error: 'Not Acceptable' });
    }

    /**
     * Set the Link response header with the given links.
     *
     * @param {Object<string, string>} links - Map of rel → URL.
     * @returns {Response} `this` for chaining.
     *
     * @example
     *   res.links({
     *       next: '/api/users?page=2',
     *       last: '/api/users?page=5',
     *   });
     *   // Link: </api/users?page=2>; rel="next", </api/users?page=5>; rel="last"
     */
    links(links)
    {
        const parts = Object.entries(links).map(([rel, url]) => `<${url}>; rel="${rel}"`);
        const existing = this.get('Link');
        const value = existing ? existing + ', ' + parts.join(', ') : parts.join(', ');
        this.set('Link', value);
        return this;
    }

    /**
     * Set the Location response header.
     *
     * @param {string} url - The URL to set.
     * @returns {Response} `this` for chaining.
     */
    location(url)
    {
        this.set('Location', url);
        return this;
    }

    /**
     * Redirect to the given URL with an optional status code (default 302).
     * @param {number|string} statusOrUrl - Status code or URL.
     * @param {string} [url] - URL if first arg was status code.
     * @returns {void}
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

    // -- HTTP/2 Server Push -------------------------

    /**
     * Push a resource to the client via HTTP/2 server push.
     * No-op on HTTP/1.x connections (returns `null`).
     *
     * Server push pre-loads assets (CSS, JS, images) before the client
     * requests them, eliminating one round trip for critical resources.
     *
     * @param {string}       path    - Path of the resource to push (e.g. `'/styles.css'`).
     * @param {object}       [opts]  - Push options.
     * @param {string}       [opts.filePath]   - Absolute file path to stream. If omitted, returns the push stream for manual writing.
     * @param {object}       [opts.headers]    - Extra response headers for the pushed resource.
     * @param {string}       [opts.contentType] - Content-Type override (auto-detected from file extension if `filePath` is given).
     * @param {number}       [opts.status=200] - Status code for the pushed response.
     * @returns {import('http2').ServerHttp2Stream|null} The push stream, or `null` if push is not supported.
     *
     * @example
     *   // Push a CSS file alongside an HTML response
     *   app.get('/', (req, res) => {
     *       res.push('/styles.css', { filePath: path.join(__dirname, 'public/styles.css') });
     *       res.html('<link rel="stylesheet" href="/styles.css"><h1>Hello</h1>');
     *   });
     *
     * @example
     *   // Manual push stream
     *   app.get('/', (req, res) => {
     *       const pushStream = res.push('/api/data', {
     *           contentType: 'application/json',
     *       });
     *       if (pushStream) {
     *           pushStream.end(JSON.stringify({ preloaded: true }));
     *       }
     *       res.html('<h1>Data preloaded</h1>');
     *   });
     */
    push(path, opts = {})
    {
        const raw = this.raw;

        // HTTP/2 responses have a .stream property with pushStream
        if (!raw.stream || typeof raw.stream.pushStream !== 'function')
        {
            log.debug('push skipped: not an HTTP/2 connection');
            return null;
        }

        // Check if client accepts pushes (RST_STREAM protection)
        if (raw.stream.destroyed || raw.stream.closed)
        {
            log.debug('push skipped: stream already closed');
            return null;
        }

        const pushHeaders = {
            ':path': path,
            ':method': 'GET',
            ':scheme': raw.socket?.encrypted ? 'https' : 'http',
            ':authority': this._req?.headers?.[':authority'] || this._req?.headers?.['host'] || 'localhost',
            ...(opts.headers || {}),
        };

        let pushStream = null;

        raw.stream.pushStream(pushHeaders, (err, stream) =>
        {
            if (err)
            {
                log.debug('push failed for %s: %s', path, err.message);
                return;
            }

            pushStream = stream;

            // Handle RST_STREAM from client (browser doesn't want the push)
            stream.on('error', (e) =>
            {
                if (e.code === 'ERR_HTTP2_STREAM_CANCEL') return; // Normal — client cancelled
                log.debug('push stream error for %s: %s', path, e.message);
            });

            const ext = nodePath.extname(path).toLowerCase();
            const ct = opts.contentType || MIME_MAP[ext] || 'application/octet-stream';
            const status = opts.status || 200;

            if (opts.filePath)
            {
                // Stream from file
                fs.stat(opts.filePath, (statErr, stat) =>
                {
                    if (statErr)
                    {
                        log.debug('push file not found: %s', opts.filePath);
                        try { stream.close(); } catch (_) {}
                        return;
                    }

                    if (stream.destroyed || stream.closed)
                    {
                        log.debug('push stream closed before file send for %s', path);
                        return;
                    }

                    try
                    {
                        stream.respond({
                            ':status': status,
                            'content-type': ct,
                            'content-length': stat.size,
                        });
                    }
                    catch (_)
                    {
                        return;
                    }

                    const fileStream = fs.createReadStream(opts.filePath);
                    fileStream.on('error', () => { try { stream.close(); } catch (_) {} });
                    fileStream.pipe(stream);
                });
            }
            else
            {
                // Return stream for manual writing
                stream.respond({
                    ':status': status,
                    'content-type': ct,
                });
            }
        });

        return pushStream;
    }

    /**
     * Check if the current connection supports HTTP/2 server push.
     * @type {boolean}
     */
    get supportsPush()
    {
        const raw = this.raw;
        return !!(raw.stream && typeof raw.stream.pushStream === 'function');
    }

    // -- Server-Sent Events (SSE) ---------------------

    /**
     * Open a Server-Sent Events stream.  Sets the correct headers and
     * returns an SSE controller object with methods for pushing events.
     *
     * The connection stays open until the client disconnects or you call
     * `sse.close()`.
     *
     * @param {object} [opts] - Configuration options.
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
        const sseHeaders = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            ...(opts.headers || {}),
        };
        // HTTP/2 doesn't use hop-by-hop Connection header
        if (!(raw.stream && typeof raw.stream.pushStream === 'function'))
        {
            sseHeaders['Connection'] = 'keep-alive';
        }
        raw.writeHead(statusCode, sseHeaders);

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
