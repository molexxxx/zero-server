/**
 * @module middleware/errorHandler
 * @description Configurable error-handling middleware that formats error responses
 *              based on environment (dev vs production), supports custom formatters,
 *              and integrates with HttpError classes.
 */
const { HttpError, isHttpError } = require('../errors');

/**
 * Create an error-handling middleware.
 *
 * @param {object}   [opts] - Configuration options.
 * @param {boolean}  [opts.stack]      - Include stack traces in responses (default: true when NODE_ENV !== 'production').
 * @param {boolean}  [opts.log]        - Log errors to console (default: true).
 * @param {function} [opts.logger]     - Custom log function (default: console.error).
 * @param {function} [opts.formatter]  - Custom response formatter: (err, req, isDev) => object.
 * @param {function} [opts.onError]    - Callback on every error: (err, req, res) => void.
 * @returns {Function} Error-handling middleware `(err, req, res, next) => void`.
 *
 * @example
 *   app.use(errorHandler());                       // dev-friendly by default
 *   app.use(errorHandler({ stack: false }));        // hide stack traces
 *   app.use(errorHandler({
 *       formatter: (err, req, isDev) => ({ message: err.message }),
 *       onError: (err) => metrics.increment('errors'),
 *   }));
 */
function errorHandler(opts = {})
{
    const isDev = opts.stack !== undefined
        ? opts.stack
        : (process.env.NODE_ENV !== 'production');

    const shouldLog = opts.log !== undefined ? opts.log : true;
    const logFn = typeof opts.logger === 'function' ? opts.logger : console.error;
    const formatter = typeof opts.formatter === 'function' ? opts.formatter : null;
    const onError = typeof opts.onError === 'function' ? opts.onError : null;

    return (err, req, res, next) =>
    {
        // Resolve status code
        let statusCode = err.statusCode || err.status || 500;
        if (typeof statusCode !== 'number' || statusCode < 100 || statusCode > 599) statusCode = 500;

        // Log the error
        if (shouldLog)
        {
            const method = req.method || 'UNKNOWN';
            const url = req.url || req.originalUrl || '/';
            const prefix = `[${method} ${url}]`;

            if (statusCode >= 500)
            {
                logFn(`${prefix} ${statusCode} - ${err.message}`);
                if (err.stack) logFn(err.stack);
            }
            else
            {
                logFn(`${prefix} ${statusCode} - ${err.message}`);
            }
        }

        // Callback hook
        if (onError) onError(err, req, res);

        // Don't send if headers already sent
        if (res.headersSent || (res.raw && res.raw.headersSent))
        {
            return;
        }

        // Build response body
        let body;

        if (formatter)
        {
            body = formatter(err, req, isDev);
        }
        else if (isHttpError(err))
        {
            body = err.toJSON ? err.toJSON() : { error: err.message, code: err.code, statusCode };
            if (isDev && err.stack) body.stack = err.stack.split('\n');
        }
        else
        {
            // Generic error
            body = {
                error: statusCode >= 500 && !isDev
                    ? 'Internal Server Error'  // Hide internal details in production
                    : (err.message || 'Internal Server Error'),
                statusCode,
            };
            if (err.code) body.code = err.code;
            if (isDev && err.stack) body.stack = err.stack.split('\n');
        }

        res.status(statusCode).json(body);
    };
}

module.exports = errorHandler;
