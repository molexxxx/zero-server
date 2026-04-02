/**
 * @module body/raw
 * @description Raw-buffer body-parsing middleware.
 *              Stores the full request body as a Buffer on `req.body`.
 *              Also sets `req.rawBody` for signature verification workflows.
 */
const rawBuffer = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

/**
 * Create a raw-buffer body-parsing middleware.
 *
 * @param {object}          [options] - Configuration options.
 * @param {string|number}   [options.limit]                           - Max body size. Default `'1mb'`.
 * @param {string|string[]|Function} [options.type='application/octet-stream'] - Content-Type(s) to match.
 * @param {boolean}         [options.requireSecure=false]             - When true, reject non-HTTPS requests with 403.
 * @param {Function}        [options.verify]   - `verify(req, res, buf)` — called before setting body. Throw to reject with 403.
 * @param {boolean}         [options.inflate=true] - Decompress gzip/deflate/br bodies. When false, compressed bodies return 415.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 *
 * @example
 *   const { raw } = require('zero-http');
 *
 *   app.use(raw({ type: 'application/octet-stream', limit: '5mb' }));
 *
 *   app.post('/upload', (req, res) => {
 *       console.log(req.body); // Buffer
 *       res.send('received ' + req.body.length + ' bytes');
 *   });
 */
function raw(options = {})
{
    const opts = options || {};
    const limit = opts.limit !== undefined ? opts.limit : '1mb';
    const typeOpt = opts.type || 'application/octet-stream';
    const requireSecure = !!opts.requireSecure;
    const verify = opts.verify;
    const inflate = opts.inflate !== undefined ? opts.inflate : true;

    return async (req, res, next) =>
    {
        if (requireSecure && !req.secure) return sendError(res, 403, 'HTTPS required');
        const ct = (req.headers['content-type'] || '');
        if (!isTypeMatch(ct, typeOpt)) return next();
        try
        {
            const buf = await rawBuffer(req, { limit, inflate });

            // Store raw body for signature verification
            req.rawBody = buf;

            // Optional verification callback
            if (verify)
            {
                try { verify(req, res, buf); }
                catch (e) { return sendError(res, 403, e.message || 'verification failed'); }
            }

            req.body = buf;
        } catch (err)
        {
            if (err && err.status === 413) return sendError(res, 413, 'payload too large');
            if (err && err.status === 415) return sendError(res, 415, err.message || 'unsupported encoding');
            req.body = Buffer.alloc(0);
        }
        next();
    };
}

module.exports = raw;
