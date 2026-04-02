/**
 * @module middleware/logger
 * @description Simple request-logging middleware.
 *              Logs method, url, status code, and response time.
 *
 * @param {object}  [opts] - Configuration options.
 * @param {function} [opts.logger]   - Custom log function (default: console.log).
 * @param {boolean}  [opts.colors]   - Colorize output (default: true when TTY).
 * @param {string}   [opts.format]   - 'tiny' | 'short' | 'dev' (default: 'dev').
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(logger());                           // default 'dev' format
 *   app.use(logger({ format: 'tiny' }));          // minimal output
 *   app.use(logger({ colors: false, logger: msg => fs.appendFileSync('access.log', msg + '\n') }));
 */
function logger(opts = {})
{
    const log = typeof opts.logger === 'function' ? opts.logger : console.log;
    const useColors = opts.colors !== undefined ? opts.colors : (process.stdout.isTTY || false);
    const format = opts.format || 'dev';

    // ANSI color helpers
    const c = {
        reset: useColors ? '\x1b[0m' : '',
        green: useColors ? '\x1b[32m' : '',
        yellow: useColors ? '\x1b[33m' : '',
        red: useColors ? '\x1b[31m' : '',
        cyan: useColors ? '\x1b[36m' : '',
        dim: useColors ? '\x1b[2m' : '',
    };

    function statusColor(code)
    {
        if (code >= 500) return c.red;
        if (code >= 400) return c.yellow;
        if (code >= 300) return c.cyan;
        return c.green;
    }

    return (req, res, next) =>
    {
        const start = Date.now();

        // Hook into the raw response 'finish' event
        const raw = res.raw;
        const onFinish = () =>
        {
            raw.removeListener('finish', onFinish);
            const ms = Date.now() - start;
            const status = raw.statusCode || res._status;
            const sc = statusColor(status);

            if (format === 'tiny')
            {
                log(`${req.method} ${req.url} ${status} - ${ms}ms`);
            }
            else if (format === 'short')
            {
                log(`${req.ip || '-'} ${req.method} ${req.url} ${sc}${status}${c.reset} ${ms}ms`);
            }
            else
            {
                // dev format
                log(`  ${c.dim}${req.method}${c.reset} ${req.url} ${sc}${status}${c.reset} ${c.dim}${ms}ms${c.reset}`);
            }
        };
        raw.on('finish', onFinish);

        next();
    };
}

module.exports = logger;
