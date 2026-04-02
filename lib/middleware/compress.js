/**
 * @module compress
 * @description Response compression middleware using Node's built-in `zlib`.
 *              Supports gzip, deflate, and brotli (Node >= 11.7).
 *              Zero external dependencies.
 */
const zlib = require('zlib');
const log = require('../debug')('zero:compress');

/**
 * Default minimum response size (in bytes) to bother compressing.
 * Responses smaller than this are sent uncompressed.
 * @type {number}
 */
const DEFAULT_THRESHOLD = 1024;

/**
 * MIME types that are worth compressing.
 * Binary formats (images, video, zip) are already compressed and gain little.
 * @type {RegExp}
 */
const COMPRESSIBLE = /^text\/|^application\/(json|javascript|xml|x-www-form-urlencoded|ld\+json|graphql|wasm)|^image\/svg\+xml/;

/**
 * Create a compression middleware.
 *
 * @param {object}  [opts] - Configuration options.
 * @param {number}  [opts.threshold=1024]  - Minimum body size in bytes to compress.
 * @param {number}  [opts.level]           - Compression level (zlib.constants.Z_DEFAULT_COMPRESSION).
 * @param {string|string[]} [opts.encoding] - Force specific encoding(s). Default: auto-negotiate.
 * @param {Function} [opts.filter]         - `(req, res) => boolean` — return false to skip compression.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   const { createApp, compress } = require('zero-http');
 *   const app = createApp();
 *   app.use(compress());                // gzip/deflate/br auto-negotiated
 *   app.use(compress({ threshold: 0 })) // compress everything
 */
function compress(opts = {})
{
    const threshold = opts.threshold !== undefined ? opts.threshold : DEFAULT_THRESHOLD;
    const level = opts.level !== undefined ? opts.level : undefined;
    const filterFn = typeof opts.filter === 'function' ? opts.filter : null;
    const hasBrotli = typeof zlib.createBrotliCompress === 'function';

    /**
     * Choose the best encoding from the Accept-Encoding header.
     * Parses quality values (RFC 7231) and picks the highest-priority match.
     * Priority when equal quality: br > gzip > deflate.
     * @private
     * @param {string} header - HTTP header value.
     * @returns {string|null} Best encoding name, or `null` if none acceptable.
     */
    function negotiate(header)
    {
        if (!header) return null;
        const encodings = { br: 0, gzip: 0, deflate: 0 };
        const parts = header.toLowerCase().split(',');
        for (let i = 0; i < parts.length; i++)
        {
            const part = parts[i].trim();
            const semi = part.indexOf(';');
            const name = (semi !== -1 ? part.substring(0, semi).trim() : part);
            let q = 1;
            if (semi !== -1)
            {
                const qMatch = /q\s*=\s*([0-9.]+)/.exec(part.substring(semi));
                if (qMatch) q = parseFloat(qMatch[1]);
            }
            if (name in encodings) encodings[name] = q;
        }
        // Filter available encodings
        if (!hasBrotli) encodings.br = 0;
        // Pick highest quality; break ties with priority order
        let best = null;
        let bestQ = 0;
        const order = hasBrotli ? ['br', 'gzip', 'deflate'] : ['gzip', 'deflate'];
        for (let i = 0; i < order.length; i++)
        {
            if (encodings[order[i]] > bestQ)
            {
                bestQ = encodings[order[i]];
                best = order[i];
            }
        }
        return best;
    }

    /**
     * Create a compression stream for the chosen encoding.
     * @private
     * @param {string} encoding - Content encoding.
     * @returns {import('stream').Transform} Compression transform stream.
     */
    function createStream(encoding)
    {
        const zlibOpts = {};
        if (level !== undefined) zlibOpts.level = level;
        switch (encoding)
        {
            case 'br':
                return zlib.createBrotliCompress(level !== undefined
                    ? { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: level } }
                    : undefined);
            case 'gzip':
                return zlib.createGzip(zlibOpts);
            case 'deflate':
                return zlib.createDeflate(zlibOpts);
            default:
                return null;
        }
    }

    return (req, res, next) =>
    {
        // Skip if client doesn't accept encoding
        const acceptEncoding = req.headers['accept-encoding'] || '';
        const encoding = negotiate(acceptEncoding);
        if (!encoding) return next();

        // Allow user to skip compression
        if (filterFn && !filterFn(req, res)) return next();

        // Monkey-patch the raw response's write/end to pipe through compression
        const raw = res.raw;
        const origWrite = raw.write.bind(raw);
        const origEnd = raw.end.bind(raw);
        let compressStream = null;
        let headersWritten = false;
        const chunks = [];

        /** @private */
        function initCompress()
        {
            if (compressStream) return true;

            // If headers were already committed (e.g. res.sse() calls
            // writeHead before write), we can no longer modify them.
            if (raw.headersSent) return false;

            // Check Content-Type — skip non-compressible types
            const ct = raw.getHeader('content-type') || '';
            if (ct && !COMPRESSIBLE.test(ct))
            {
                return false;
            }

            // Never compress SSE streams — compression buffers
            // the small frames and prevents real-time delivery.
            if (ct.includes('text/event-stream'))
            {
                return false;
            }

            compressStream = createStream(encoding);
            if (!compressStream) return false;

            // Remove Content-Length (we don't know compressed size ahead of time)
            raw.removeHeader('content-length');
            raw.removeHeader('Content-Length');
            raw.setHeader('Content-Encoding', encoding);
            raw.setHeader('Vary', 'Accept-Encoding');
            log.debug('compressing with %s', encoding);

            compressStream.on('data', (chunk) => origWrite(chunk));
            compressStream.on('end', () => origEnd());
            compressStream.on('error', (err) =>
            {                log.error('compression error: %s', err.message);                // On compression error, remove encoding header and end raw stream
                try { raw.removeHeader('Content-Encoding'); } catch (e) { }
                try { origEnd(); } catch (e) { }
            });
            return true;
        }

        raw.write = function (chunk, enc, callback)
        {
            if (!headersWritten)
            {
                headersWritten = true;
                const ct = raw.getHeader('content-type') || '';
                initCompress();
                if (compressStream)
                {
                    compressStream.write(chunk, enc, callback);
                    return true;
                }
            }
            if (compressStream)
            {
                compressStream.write(chunk, enc, callback);
                return true;
            }
            return origWrite(chunk, enc, callback);
        };

        raw.end = function (chunk, encoding, callback)
        {
            if (!headersWritten)
            {
                headersWritten = true;

                // Check threshold — if the total body is small, skip compression
                const totalChunk = chunk ? (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) : null;
                if (totalChunk && totalChunk.length < threshold)
                {
                    return origEnd(chunk, encoding, callback);
                }

                if (initCompress())
                {
                    if (chunk) compressStream.end(chunk, encoding, callback);
                    else compressStream.end(callback);
                    return;
                }
            }
            if (compressStream)
            {
                if (chunk) compressStream.end(chunk, encoding, callback);
                else compressStream.end(callback);
                return;
            }
            return origEnd(chunk, encoding, callback);
        };

        next();
    };
}

module.exports = compress;
