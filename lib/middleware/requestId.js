/**
 * @module requestId
 * @description Request ID middleware.
 *              Assigns a unique identifier to each incoming request for
 *              tracing and debugging. Sets the ID on both the request
 *              object and as a response header.
 */
const crypto = require('crypto');

/**
 * Create a request ID middleware.
 *
 * @param {object}   [opts] - Configuration options.
 * @param {string}   [opts.header='X-Request-Id']   - Response header name.
 * @param {Function} [opts.generator]               - Custom ID generator `() => string`.
 * @param {boolean}  [opts.trustProxy=false]         - Trust incoming X-Request-Id header from proxy.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(requestId());
 *   app.get('/', (req, res) => {
 *       console.log(req.id); // e.g. '7f3a2b1c-...'
 *   });
 */
function requestId(opts = {})
{
    const headerName = opts.header || 'X-Request-Id';
    const trustProxy = !!opts.trustProxy;
    const generator = typeof opts.generator === 'function'
        ? opts.generator
        : () => crypto.randomUUID();

    return (req, res, next) =>
    {
        let id;

        if (trustProxy)
        {
            const existing = req.headers[headerName.toLowerCase()];
            if (existing && typeof existing === 'string' && existing.length <= 128)
            {
                id = existing;
            }
        }

        if (!id) id = generator();

        req.id = id;
        res.set(headerName, id);
        next();
    };
}

module.exports = requestId;
