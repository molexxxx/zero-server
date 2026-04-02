/**
 * @module timeout
 * @description Request timeout middleware.
 *              Automatically sends a 408 response if the handler doesn't
 *              respond within the configured time limit.
 *              Helps prevent Slowloris-style attacks and hung requests.
 */

/**
 * Create a request timeout middleware.
 *
 * @param {number}  [ms=30000]        - Timeout in milliseconds (default 30s).
 * @param {object}  [opts] - Configuration options.
 * @param {number}  [opts.status=408] - HTTP status code for timeout responses.
 * @param {string}  [opts.message='Request Timeout'] - Error message body.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(timeout(5000)); // 5 second timeout
 *   app.use(timeout(10000, { message: 'Too slow' }));
 */
const log = require('../debug')('zero:timeout');

function timeout(ms = 30000, opts = {})
{
    if (typeof ms === 'object') { opts = ms; ms = 30000; }

    const statusCode = opts.status || 408;
    const message = opts.message || 'Request Timeout';

    return (req, res, next) =>
    {
        let timedOut = false;

        const timer = setTimeout(() =>
        {
            timedOut = true;
            req._timedOut = true;
            log.warn('request timed out after %dms: %s %s', ms, req.method, req.url);

            // Only send response if headers haven't been sent yet
            if (!res.headersSent && !res._sent)
            {
                res.status(statusCode).json({ error: message });
            }
        }, ms);

        // Unref so the timer doesn't keep the process alive
        if (timer.unref) timer.unref();

        // Clear timeout when response finishes
        const raw = res.raw;
        const onFinish = () =>
        {
            clearTimeout(timer);
            raw.removeListener('finish', onFinish);
            raw.removeListener('close', onFinish);
        };
        raw.on('finish', onFinish);
        raw.on('close', onFinish);

        // Expose timedOut check on request
        Object.defineProperty(req, 'timedOut', {
            get() { return timedOut; },
            configurable: true,
        });

        next();
    };
}

module.exports = timeout;
