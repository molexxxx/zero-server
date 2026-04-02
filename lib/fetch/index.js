/**
 * @module fetch
 * @description Minimal, zero-dependency server-side `fetch()` replacement.
 *              Supports HTTP/HTTPS, JSON/URLSearchParams/Buffer/stream bodies,
 *              download & upload progress callbacks, timeouts, and AbortSignal.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const STATUS_CODES = http.STATUS_CODES;

/**
 * Perform an HTTP(S) request.
 *
 * @param {string} url  - Absolute URL to fetch.
 * @param {object} [opts] - Configuration options.
 * @param {string}   [opts.method='GET']           - HTTP method.
 * @param {object}   [opts.headers]                - Request headers.
 * @param {string|Buffer|object|ReadableStream} [opts.body] - Request body.
 * @param {number}   [opts.timeout]                - Request timeout in ms.
 * @param {AbortSignal} [opts.signal]              - Abort signal for cancellation.
 * @param {import('http').Agent} [opts.agent]      - Custom HTTP agent.
 * @param {Function} [opts.onDownloadProgress]     - `({ loaded, total }) => void` download progress callback.
 * @param {Function} [opts.onUploadProgress]       - `({ loaded, total }) => void` upload progress callback.
 * @param {boolean}  [opts.rejectUnauthorized]     - Reject connections with unverified certs (default: Node default `true`). TLS option — passed to `https.request()`.
 * @param {string|Buffer|Array} [opts.ca]          - Override default CA certificates.
 * @param {string|Buffer}       [opts.cert]        - Client certificate (PEM) for mutual TLS.
 * @param {string|Buffer}       [opts.key]         - Private key (PEM) for mutual TLS.
 * @param {string|Buffer}       [opts.pfx]         - PFX / PKCS12 bundle (alternative to cert+key).
 * @param {string}              [opts.passphrase]  - Passphrase for the key or PFX.
 * @param {string}              [opts.servername]   - SNI server name override.
 * @param {string}              [opts.ciphers]      - Colon-separated cipher list.
 * @param {string}              [opts.secureProtocol] - SSL/TLS protocol method name.
 * @param {string}              [opts.minVersion]   - Minimum TLS version (`'TLSv1.2'`, etc.).
 * @param {string}              [opts.maxVersion]   - Maximum TLS version.
 *
 * @returns {Promise<{ status: number, statusText: string, ok: boolean, secure: boolean, url: string, headers: object, arrayBuffer: Function, text: Function, json: Function }>} Resolves with a response object containing status info, headers, and body-reading helpers (`text()`, `json()`, `arrayBuffer()`).
 *
 * @example
 *   const res = await fetch('https://api.example.com/data');
 *   const body = await res.json();
 *
 *   // POST with JSON body & timeout
 *   const res2 = await fetch('https://api.example.com/items', {
 *       method: 'POST',
 *       body: { name: 'widget' },
 *       timeout: 5000,
 *   });
 */
function miniFetch(url, opts = {})
{
    return new Promise((resolve, reject) =>
    {
        try
        {
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? https : http;
            const method = (opts.method || 'GET').toUpperCase();
            const headers = Object.assign({}, opts.headers || {});

            // Normalize body
            let body = opts.body;
            if (body && typeof body === 'object' && typeof body.toString === 'function' && body.constructor && body.constructor.name === 'URLSearchParams')
            {
                if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
                body = body.toString();
            }
            else if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && !(body && typeof body.pipe === 'function'))
            {
                if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
                body = Buffer.from(JSON.stringify(body), 'utf8');
            }
            else if (body instanceof ArrayBuffer)
            {
                body = Buffer.from(body);
            }
            else if (body instanceof Uint8Array && !Buffer.isBuffer(body))
            {
                body = Buffer.from(body);
            }

            // Set Content-Length for known-size bodies
            if ((Buffer.isBuffer(body) || typeof body === 'string') && !headers['Content-Length'] && !headers['content-length'])
            {
                headers['Content-Length'] = String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body));
            }

            const options = { method, headers };
            if (opts.agent) options.agent = opts.agent;

            // Pass through TLS options for HTTPS requests
            if (lib === https)
            {
                const tlsKeys = [
                    'rejectUnauthorized', 'ca', 'cert', 'key', 'pfx', 'passphrase',
                    'servername', 'ciphers', 'secureProtocol', 'minVersion', 'maxVersion'
                ];
                for (const k of tlsKeys)
                {
                    if (opts[k] !== undefined) options[k] = opts[k];
                }
            }

            const req = lib.request(u, options, (res) =>
            {
                const chunks = [];
                let downloaded = 0;
                const total = parseInt(res.headers['content-length'] || '0', 10) || null;

                res.on('data', (c) =>
                {
                    chunks.push(c);
                    downloaded += c.length;
                    if (typeof opts.onDownloadProgress === 'function')
                    {
                        try { opts.onDownloadProgress({ loaded: downloaded, total }); } catch (e) { }
                    }
                });

                res.on('end', () =>
                {
                    const buf = Buffer.concat(chunks);
                    const status = res.statusCode;
                    const rawHeaders = res.headers || {};
                    const responseHeaders = {
                        get(name)
                        {
                            if (!name) return undefined;
                            const v = rawHeaders[name.toLowerCase()];
                            return Array.isArray(v) ? v.join(', ') : v;
                        },
                        raw: rawHeaders,
                    };

                    resolve({
                        status,
                        statusText: STATUS_CODES[status] || '',
                        ok: status >= 200 && status < 300,
                        secure: u.protocol === 'https:',
                        url: u.href,
                        headers: responseHeaders,
                        arrayBuffer: () => Promise.resolve(buf),
                        text: () => Promise.resolve(buf.toString('utf8')),
                        json: () =>
                        {
                            try { return Promise.resolve(JSON.parse(buf.toString('utf8'))); }
                            catch (e) { return Promise.reject(e); }
                        },
                    });
                });
            });

            req.on('error', reject);

            // Timeout
            if (typeof opts.timeout === 'number' && opts.timeout > 0)
            {
                req.setTimeout(opts.timeout, () =>
                {
                    const err = new Error('Request timed out');
                    err.code = 'ETIMEOUT';
                    req.destroy(err);
                });
            }

            // AbortSignal support
            let abortHandler;
            if (opts.signal)
            {
                if (opts.signal.aborted)
                {
                    const err = new Error('Request aborted');
                    err.name = 'AbortError';
                    req.destroy(err);
                    return;
                }
                abortHandler = () =>
                {
                    const err = new Error('Request aborted');
                    err.name = 'AbortError';
                    req.destroy(err);
                };
                if (typeof opts.signal.addEventListener === 'function') opts.signal.addEventListener('abort', abortHandler);
                else if (typeof opts.signal.on === 'function') opts.signal.on('abort', abortHandler);
            }

            // Cleanup signal listener
            const cleanup = () =>
            {
                if (opts.signal && abortHandler)
                {
                    try
                    {
                        if (typeof opts.signal.removeEventListener === 'function') opts.signal.removeEventListener('abort', abortHandler);
                        else if (typeof opts.signal.off === 'function') opts.signal.off('abort', abortHandler);
                    }
                    catch (e) { }
                }
            };
            req.on('close', cleanup);

            // Write body
            if (body && typeof body.pipe === 'function')
            {
                let uploaded = 0;
                body.on('data', (chunk) =>
                {
                    uploaded += chunk.length;
                    if (typeof opts.onUploadProgress === 'function')
                    {
                        try { opts.onUploadProgress({ loaded: uploaded, total: headers['Content-Length'] ? Number(headers['Content-Length']) : null }); } catch (e) { }
                    }
                });
                body.on('error', (err) => req.destroy(err));
                body.pipe(req);
            }
            else if (Buffer.isBuffer(body) || typeof body === 'string')
            {
                const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
                const total = buf.length;
                const CHUNK = 64 * 1024;
                let sent = 0;

                function writeNext()
                {
                    if (sent >= total) { req.end(); return; }
                    const slice = buf.slice(sent, Math.min(sent + CHUNK, total));
                    const ok = req.write(slice, () =>
                    {
                        sent += slice.length;
                        if (typeof opts.onUploadProgress === 'function')
                        {
                            try { opts.onUploadProgress({ loaded: sent, total }); } catch (e) { }
                        }
                        writeNext();
                    });
                    if (!ok) req.once('drain', writeNext);
                }
                writeNext();
            }
            else if (body == null)
            {
                req.end();
            }
            else
            {
                req.write(String(body));
                req.end();
            }
        }
        catch (e) { reject(e); }
    });
}

module.exports = miniFetch;
