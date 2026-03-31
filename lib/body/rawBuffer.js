/**
 * @module body/rawBuffer
 * @description Low-level helper that collects the raw request body into a
 *              single Buffer, enforcing an optional byte-size limit.
 *              Supports Content-Encoding decompression (gzip, deflate, br)
 *              and Content-Length pre-checking for early rejection.
 */
const zlib = require('zlib');

/**
 * Parse a human-readable size string (e.g. `'10kb'`, `'2mb'`) into bytes.
 *
 * @param {string|number|null} limit - Size limit value.
 * @returns {number|null} Byte limit, or `null` for unlimited.
 */
function parseLimit(limit)
{
    if (!limit && limit !== 0) return null;
    if (typeof limit === 'number') return limit;
    if (typeof limit === 'string')
    {
        const v = limit.trim().toLowerCase();
        const num = Number(v.replace(/[^0-9.]/g, ''));
        if (v.endsWith('kb')) return Math.floor(num * 1024);
        if (v.endsWith('mb')) return Math.floor(num * 1024 * 1024);
        if (v.endsWith('gb')) return Math.floor(num * 1024 * 1024 * 1024);
        return Math.floor(num);
    }
    return null;
}

/**
 * Extract and normalise the charset from a Content-Type header value
 * into a Node.js-compatible `BufferEncoding` name.
 *
 * @param {string} contentType - Full Content-Type header value.
 * @returns {string|null} Normalised encoding or `null` when not specified.
 */
function charsetFromContentType(contentType)
{
    if (!contentType) return null;
    const m = contentType.match(/charset=["']?([^\s;"']+)/i);
    if (!m) return null;
    const raw = m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (raw === 'utf8') return 'utf8';
    if (raw === 'utf16le' || raw === 'utf16' || raw === 'ucs2') return 'utf16le';
    if (raw === 'latin1' || raw === 'iso88591') return 'latin1';
    if (raw === 'ascii' || raw === 'usascii') return 'ascii';
    return 'utf8'; // safe fallback for unknown charsets
}

/**
 * Collect the raw request body into a Buffer.
 *
 * - Rejects with `{ status: 413 }` when `opts.limit` is exceeded.
 * - Rejects with `{ status: 415 }` for unsupported Content-Encoding or
 *   when `opts.inflate` is `false` and the body is compressed.
 * - Automatically decompresses gzip / deflate / br when `opts.inflate`
 *   is `true` (the default).
 *
 * @param {import('../http/request')} req        - Wrapped request (`.raw` stream, `.headers`).
 * @param {object}                    [opts]
 * @param {string|number|null}        [opts.limit]         - Max body size (post-decompression).
 * @param {boolean}                   [opts.inflate=true]  - Decompress gzip/deflate/br bodies.
 * @returns {Promise<Buffer>} Resolved with the full body buffer.
 */
function rawBuffer(req, opts = {})
{
    const limit = parseLimit(opts.limit);
    const inflate = opts.inflate !== false;

    return new Promise((resolve, reject) =>
    {
        const headers = req.headers || (req.raw && req.raw.headers) || {};

        // Content-Encoding handling
        const encoding = (headers['content-encoding'] || '').toLowerCase().trim();
        const isCompressed = encoding && encoding !== 'identity';

        // Content-Length pre-check (skip for compressed bodies — CL is the compressed size)
        if (!isCompressed)
        {
            const cl = parseInt(headers['content-length'], 10);
            if (limit && cl && cl > limit)
            {
                const err = new Error('payload too large');
                err.status = 413;
                return reject(err);
            }
        }

        // Select stream source (possibly a decompression transform)
        let stream = req.raw;
        if (isCompressed)
        {
            if (!inflate)
            {
                const err = new Error('compressed bodies not accepted');
                err.status = 415;
                return reject(err);
            }
            if (encoding === 'gzip' || encoding === 'x-gzip')
            {
                stream = req.raw.pipe(zlib.createGunzip());
            }
            else if (encoding === 'deflate')
            {
                stream = req.raw.pipe(zlib.createInflate());
            }
            else if (encoding === 'br')
            {
                stream = req.raw.pipe(zlib.createBrotliDecompress());
            }
            else
            {
                const err = new Error('unsupported Content-Encoding: ' + encoding);
                err.status = 415;
                return reject(err);
            }
        }

        const chunks = [];
        let total = 0;

        function cleanup()
        {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
        }
        function onData(c)
        {
            total += c.length;
            if (limit && total > limit)
            {
                cleanup();
                const err = new Error('payload too large');
                err.status = 413;
                return reject(err);
            }
            chunks.push(c);
        }
        function onEnd()
        {
            cleanup();
            resolve(Buffer.concat(chunks));
        }
        function onError(e)
        {
            cleanup();
            reject(e);
        }
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
    });
}

module.exports = rawBuffer;
module.exports.charsetFromContentType = charsetFromContentType;
