const http = require('http');
const https = require('https');
const { URL } = require('url');

const STATUS_CODES = http.STATUS_CODES;

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
