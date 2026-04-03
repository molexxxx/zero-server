/**
 * @module observe/logger
 * @description Structured, enterprise-grade request logger.
 *              Outputs JSON or pretty-text with consistent fields:
 *              `requestId`, `method`, `url`, `status`, `duration`, `ip`, `userAgent`.
 *
 *              Correlates with the `requestId` middleware (`req.id`),
 *              supports child loggers with bound context, custom transports,
 *              and environment-aware log level defaults.
 *
 * @example
 *   const { structuredLogger } = require('zero-http');
 *   app.use(structuredLogger());
 *
 * @example
 *   // JSON output with custom transport
 *   app.use(structuredLogger({
 *       format: 'json',
 *       transport: (entry) => myLogService.send(entry),
 *   }));
 *
 * @example
 *   // Child loggers with bound context
 *   app.get('/users/:id', (req, res) => {
 *       const log = req.log.child({ userId: req.params.id });
 *       log.info('fetching user');
 *       log.warn('user has legacy data');
 *   });
 */
const crypto = require('crypto');

// -- Constants -----------------------------------------------------

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5, silent: 6 };
const LEVEL_NAMES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_COLORS = ['\x1b[2m', '\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[31m', '\x1b[35;1m'];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/**
 * Default log-level per NODE_ENV.
 * @private
 */
function _defaultLevel()
{
    const env = process.env.NODE_ENV || 'development';
    if (env === 'test') return LEVELS.silent;
    if (env === 'production') return LEVELS.info;
    return LEVELS.debug;
}

// -- Logger Core ---------------------------------------------------

/**
 * Lightweight structured logger instance (not middleware).
 * Used internally by child loggers and the request logger.
 */
class Logger
{
    /**
     * @constructor
     * @param {object} [opts] - Logger options.
     * @param {string|number} [opts.level] - Minimum log level.
     * @param {object} [opts.context] - Bound context fields merged into every entry.
     * @param {Function} [opts.transport] - Custom transport `(entry) => void`.
     * @param {boolean} [opts.json=false] - Force JSON output.
     * @param {boolean} [opts.colors] - Enable ANSI colors (default: TTY detection).
     * @param {boolean} [opts.timestamps=true] - Include timestamps.
     * @param {WritableStream} [opts.stream] - Output stream (default: stdout/stderr).
     */
    constructor(opts = {})
    {
        this._level = typeof opts.level === 'string'
            ? (LEVELS[opts.level] ?? _defaultLevel())
            : (typeof opts.level === 'number' ? opts.level : _defaultLevel());
        this._context = opts.context || {};
        this._transport = typeof opts.transport === 'function' ? opts.transport : null;
        this._json = !!opts.json;
        this._colors = opts.colors !== undefined ? opts.colors : (process.stdout.isTTY || false);
        this._timestamps = opts.timestamps !== undefined ? opts.timestamps : true;
        this._stream = opts.stream || null;
        this._parent = opts._parent || null;
    }

    /**
     * Create a child logger with additional bound context.
     * Child inherits all parent settings but merges extra fields
     * into every log entry.
     *
     * @param {object} context - Extra key-value pairs for the child.
     * @returns {Logger} New child logger instance.
     *
     * @example
     *   const child = logger.child({ userId: 42, action: 'checkout' });
     *   child.info('processing payment');
     *   // => { ..., userId: 42, action: 'checkout', message: 'processing payment' }
     */
    child(context)
    {
        return new Logger({
            level: this._level,
            context: { ...this._context, ...context },
            transport: this._transport,
            json: this._json,
            colors: this._colors,
            timestamps: this._timestamps,
            stream: this._stream,
            _parent: this,
        });
    }

    /**
     * Set the minimum log level.
     *
     * @param {string|number} level - Level name or number.
     * @returns {Logger} this
     */
    setLevel(level)
    {
        this._level = typeof level === 'string' ? (LEVELS[level] ?? this._level) : level;
        return this;
    }

    /**
     * Log at trace level.
     * @param {string} message - Log message.
     * @param {object} [fields] - Additional fields.
     */
    trace(message, fields) { this._log(LEVELS.trace, message, fields); }

    /**
     * Log at debug level.
     * @param {string} message - Log message.
     * @param {object} [fields] - Additional fields.
     */
    debug(message, fields) { this._log(LEVELS.debug, message, fields); }

    /**
     * Log at info level.
     * @param {string} message - Log message.
     * @param {object} [fields] - Additional fields.
     */
    info(message, fields) { this._log(LEVELS.info, message, fields); }

    /**
     * Log at warn level.
     * @param {string} message - Log message.
     * @param {object} [fields] - Additional fields.
     */
    warn(message, fields) { this._log(LEVELS.warn, message, fields); }

    /**
     * Log at error level.
     * @param {string} message - Log message.
     * @param {object} [fields] - Additional fields.
     */
    error(message, fields) { this._log(LEVELS.error, message, fields); }

    /**
     * Log at fatal level.
     * @param {string} message - Log message.
     * @param {object} [fields] - Additional fields.
     */
    fatal(message, fields) { this._log(LEVELS.fatal, message, fields); }

    /**
     * Write a log entry.
     * @private
     * @param {number} level - Numeric level.
     * @param {string} message - Message text.
     * @param {object} [fields] - Extra fields.
     */
    _log(level, message, fields)
    {
        if (level < this._level) return;

        const entry = {
            timestamp: new Date().toISOString(),
            level: LEVEL_NAMES[level],
            ...this._context,
            message,
        };

        if (fields)
        {
            // Flatten error objects
            if (fields instanceof Error)
            {
                entry.error = { message: fields.message, stack: fields.stack, code: fields.code };
            }
            else if (typeof fields === 'object')
            {
                Object.assign(entry, fields);
            }
        }

        if (this._transport)
        {
            this._transport(entry);
            return;
        }

        this._write(level, entry);
    }

    /**
     * Write formatted output to stdout/stderr.
     * @private
     */
    _write(level, entry)
    {
        const out = this._stream || (level >= LEVELS.warn ? process.stderr : process.stdout);

        if (this._json)
        {
            out.write(JSON.stringify(entry) + '\n');
            return;
        }

        // Pretty output
        const c = this._colors;
        const parts = [];

        if (this._timestamps)
        {
            const ts = entry.timestamp.slice(11, 23); // HH:mm:ss.SSS
            parts.push(c ? `${DIM}${ts}${RESET}` : ts);
        }

        const lvl = entry.level.toUpperCase().padEnd(5);
        parts.push(c ? `${LEVEL_COLORS[level]}${lvl}${RESET}` : lvl);
        parts.push(entry.message);

        // Append extra context fields
        const skip = new Set(['timestamp', 'level', 'message']);
        const extras = {};
        let hasExtras = false;
        for (const k of Object.keys(entry))
        {
            if (!skip.has(k)) { extras[k] = entry[k]; hasExtras = true; }
        }
        if (hasExtras)
        {
            const str = JSON.stringify(extras);
            parts.push(c ? `${DIM}${str}${RESET}` : str);
        }

        out.write(parts.join(' ') + '\n');
    }
}

// -- Structured Logger Middleware ----------------------------------

/**
 * Create structured request-logging middleware.
 *
 * Automatically logs every completed request with:
 * `requestId`, `method`, `url`, `status`, `duration`, `ip`, `userAgent`,
 * and `contentLength`.
 *
 * Also attaches `req.log` — a child logger with bound request context
 * so handlers can log with full correlation.
 *
 * @param {object} [opts] - Configuration options.
 * @param {string|number} [opts.level='info'] - Minimum log level. Default follows NODE_ENV.
 * @param {'json'|'pretty'} [opts.format] - Output format. `'json'` for production, `'pretty'` for dev. Default: `'json'` in production, `'pretty'` otherwise.
 * @param {Function} [opts.transport] - Custom transport `(entry) => void` for each log entry.
 * @param {boolean} [opts.colors] - ANSI colors (default: TTY detection). Only applies to pretty format.
 * @param {boolean} [opts.timestamps=true] - Include timestamps.
 * @param {WritableStream} [opts.stream] - Output stream override.
 * @param {Function} [opts.skip] - `(req, res) => boolean` — skip logging for certain requests.
 * @param {Function} [opts.customFields] - `(req, res) => object` — extra fields to merge into each request log entry.
 * @param {string} [opts.msg] - Custom message template. Supports placeholders: `:method`, `:url`, `:status`, `:duration`.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   // Auto-detect format based on NODE_ENV
 *   app.use(structuredLogger());
 *
 * @example
 *   // JSON to file transport
 *   const fs = require('fs');
 *   const logStream = fs.createWriteStream('access.log', { flags: 'a' });
 *   app.use(structuredLogger({ format: 'json', stream: logStream }));
 *
 * @example
 *   // Skip health checks
 *   app.use(structuredLogger({ skip: (req) => req.url === '/healthz' }));
 */
function structuredLogger(opts = {})
{
    const isProduction = (process.env.NODE_ENV || 'development') === 'production';
    const useJson = opts.format === 'json' || (!opts.format && isProduction);

    const logger = new Logger({
        level: opts.level,
        json: useJson,
        colors: opts.colors,
        timestamps: opts.timestamps,
        stream: opts.stream,
        transport: opts.transport,
    });

    const skip = typeof opts.skip === 'function' ? opts.skip : null;
    const customFields = typeof opts.customFields === 'function' ? opts.customFields : null;
    const msgTemplate = opts.msg || ':method :url :status :duration\ms';

    return (req, res, next) =>
    {
        const start = process.hrtime.bigint();

        // Attach child logger with request context to req
        const reqContext = {};
        if (req.id) reqContext.requestId = req.id;
        req.log = logger.child(reqContext);

        const raw = res.raw || res;
        const onFinish = () =>
        {
            raw.removeListener('finish', onFinish);

            if (skip && skip(req, res)) return;

            const diff = process.hrtime.bigint() - start;
            const durationMs = Number(diff / 1_000_000n);
            const durationUs = Number(diff / 1_000n);
            const status = raw.statusCode || 200;

            const fields = {
                requestId: req.id || undefined,
                method: req.method,
                url: req.originalUrl || req.url,
                status,
                duration: durationMs,
                durationUs,
                ip: req.ip || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress,
                userAgent: req.headers?.['user-agent'],
                contentLength: parseInt(raw.getHeader?.('content-length') || '0', 10) || undefined,
            };

            if (customFields)
            {
                try { Object.assign(fields, customFields(req, res)); }
                catch (_) { /* ignore custom field errors */ }
            }

            // Build message
            const msg = msgTemplate
                .replace(':method', fields.method)
                .replace(':url', fields.url)
                .replace(':status', String(fields.status))
                .replace(':duration', String(fields.duration));

            // Choose level based on status code
            const lvl = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
            logger[lvl](msg, fields);
        };

        raw.on('finish', onFinish);
        next();
    };
}

module.exports = { Logger, structuredLogger, LEVELS, LEVEL_NAMES };
