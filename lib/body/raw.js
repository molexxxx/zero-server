/**
 * @module body/raw
 * @description Raw-buffer body-parsing middleware.
 *              Stores the full request body as a Buffer on `req.body`.
 */
const rawBuffer = require('./rawBuffer');
const isTypeMatch = require('./typeMatch');
const sendError = require('./sendError');

/**
 * Create a raw-buffer body-parsing middleware.
 *
 * @param {object}          [options]
 * @param {string|number}   [options.limit]                           - Max body size.
 * @param {string|Function} [options.type='application/octet-stream'] - Content-Type to match.
 * @param {boolean}         [options.requireSecure=false]             - When true, reject non-HTTPS requests with 403.
 * @returns {Function} Async middleware `(req, res, next) => void`.
 */
function raw(options = {})
{
    const opts = options || {};
    const limit = opts.limit || null;
    const typeOpt = opts.type || 'application/octet-stream';
    const requireSecure = !!opts.requireSecure;

    return async (req, res, next) =>
    {
        if (requireSecure && !req.secure) return sendError(res, 403, 'HTTPS required');
        const ct = (req.headers['content-type'] || '');
        if (!isTypeMatch(ct, typeOpt)) return next();
        try
        {
            req.body = await rawBuffer(req, { limit });
        } catch (err)
        {
            if (err && err.status === 413) return sendError(res, 413, 'payload too large');
            req.body = Buffer.alloc(0);
        }
        next();
    };
}

module.exports = raw;
