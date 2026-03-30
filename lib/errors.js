/**
 * @module errors
 * @description HTTP error classes with status codes, error codes, and structured details.
 *              Every error extends HttpError which carries a statusCode, code, and optional details.
 */

// --- Status Text Map ---------------------------------------------

const STATUS_TEXT = {
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    418: "I'm a Teapot",
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
};

// --- Base HttpError ----------------------------------------------

class HttpError extends Error
{
    /**
     * @param {number} statusCode - HTTP status code.
     * @param {string} [message]  - Human-readable message.
     * @param {object} [opts]
     * @param {string} [opts.code]    - Machine-readable error code (e.g. 'VALIDATION_FAILED').
     * @param {*}      [opts.details] - Extra data (field errors, debug info, etc.).
     */
    constructor(statusCode, message, opts = {})
    {
        super(message || STATUS_TEXT[statusCode] || 'Error');
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.code = opts.code || this._defaultCode();
        if (opts.details !== undefined) this.details = opts.details;
        Error.captureStackTrace(this, this.constructor);
    }

    /** @private */
    _defaultCode()
    {
        return (STATUS_TEXT[this.statusCode] || 'ERROR')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/(^_|_$)/g, '');
    }

    /**
     * Serialize for JSON responses.
     * @returns {{ error: string, code: string, statusCode: number, details?: * }}
     */
    toJSON()
    {
        const obj = { error: this.message, code: this.code, statusCode: this.statusCode };
        if (this.details !== undefined) obj.details = this.details;
        return obj;
    }
}

// --- Specific Error Classes --------------------------------------

class BadRequestError extends HttpError
{
    constructor(message, opts) { super(400, message, opts); }
}

class UnauthorizedError extends HttpError
{
    constructor(message, opts) { super(401, message, opts); }
}

class ForbiddenError extends HttpError
{
    constructor(message, opts) { super(403, message, opts); }
}

class NotFoundError extends HttpError
{
    constructor(message, opts) { super(404, message, opts); }
}

class MethodNotAllowedError extends HttpError
{
    constructor(message, opts) { super(405, message, opts); }
}

class ConflictError extends HttpError
{
    constructor(message, opts) { super(409, message, opts); }
}

class GoneError extends HttpError
{
    constructor(message, opts) { super(410, message, opts); }
}

class PayloadTooLargeError extends HttpError
{
    constructor(message, opts) { super(413, message, opts); }
}

class UnprocessableEntityError extends HttpError
{
    constructor(message, opts) { super(422, message, opts); }
}

/**
 * Validation error with field-level details.
 */
class ValidationError extends HttpError
{
    /**
     * @param {string}         [message]  - Summary message.
     * @param {object|Array}   [errors]   - Field errors, e.g. { email: 'required', age: 'must be >= 18' }.
     * @param {object}         [opts]
     */
    constructor(message, errors, opts = {})
    {
        super(422, message || 'Validation Failed', { code: 'VALIDATION_FAILED', ...opts, details: errors });
        this.errors = errors || {};
    }
}

class TooManyRequestsError extends HttpError
{
    constructor(message, opts) { super(429, message, opts); }
}

class InternalError extends HttpError
{
    constructor(message, opts) { super(500, message, opts); }
}

class NotImplementedError extends HttpError
{
    constructor(message, opts) { super(501, message, opts); }
}

class BadGatewayError extends HttpError
{
    constructor(message, opts) { super(502, message, opts); }
}

class ServiceUnavailableError extends HttpError
{
    constructor(message, opts) { super(503, message, opts); }
}

// --- Framework Error Classes -------------------------------------

/**
 * Database / ORM error — wraps adapter-level failures.
 */
class DatabaseError extends HttpError
{
    /**
     * @param {string}  [message]  - Description of the DB failure.
     * @param {object}  [opts]
     * @param {string}  [opts.query]   - The query or operation that failed.
     * @param {string}  [opts.adapter] - Adapter name (sqlite, mysql, etc.).
     */
    constructor(message, opts = {})
    {
        super(500, message || 'Database Error', { code: 'DATABASE_ERROR', ...opts });
        if (opts.query) this.query = opts.query;
        if (opts.adapter) this.adapter = opts.adapter;
    }
}

/**
 * Configuration error — thrown when app/adapter configuration is invalid.
 */
class ConfigurationError extends HttpError
{
    /**
     * @param {string} [message] - What misconfiguration was detected.
     * @param {object} [opts]
     * @param {string} [opts.setting] - The setting key that's invalid.
     */
    constructor(message, opts = {})
    {
        super(500, message || 'Configuration Error', { code: 'CONFIGURATION_ERROR', ...opts });
        if (opts.setting) this.setting = opts.setting;
    }
}

/**
 * Middleware error — a middleware function failed unexpectedly.
 */
class MiddlewareError extends HttpError
{
    /**
     * @param {string} [message]     - Description.
     * @param {object} [opts]
     * @param {string} [opts.middleware] - Middleware name.
     */
    constructor(message, opts = {})
    {
        super(500, message || 'Middleware Error', { code: 'MIDDLEWARE_ERROR', ...opts });
        if (opts.middleware) this.middleware = opts.middleware;
    }
}

/**
 * Routing error — thrown when route resolution fails.
 */
class RoutingError extends HttpError
{
    /**
     * @param {string} [message] - Description.
     * @param {object} [opts]
     * @param {string} [opts.path]   - The route path.
     * @param {string} [opts.method] - The HTTP method.
     */
    constructor(message, opts = {})
    {
        super(500, message || 'Routing Error', { code: 'ROUTING_ERROR', ...opts });
        if (opts.path) this.path = opts.path;
        if (opts.method) this.method = opts.method;
    }
}

/**
 * Timeout error — operation exceeded allowed time.
 */
class TimeoutError extends HttpError
{
    /**
     * @param {string} [message]  - Description.
     * @param {object} [opts]
     * @param {number} [opts.timeout] - The timeout limit in ms.
     */
    constructor(message, opts = {})
    {
        super(408, message || 'Request Timeout', { code: 'TIMEOUT', ...opts });
        if (opts.timeout) this.timeout = opts.timeout;
    }
}

// --- ORM-Specific Error Classes ----------------------------------

/**
 * Connection error — database connection failures with retry context.
 */
class ConnectionError extends DatabaseError
{
    /**
     * @param {string}  [message]     - Description.
     * @param {object}  [opts]
     * @param {string}  [opts.adapter]    - Adapter name.
     * @param {number}  [opts.attempt]    - Retry attempt number.
     * @param {number}  [opts.maxRetries] - Maximum retries configured.
     * @param {string}  [opts.host]       - Target host.
     * @param {number}  [opts.port]       - Target port.
     */
    constructor(message, opts = {})
    {
        super(message || 'Connection Failed', { code: 'CONNECTION_ERROR', ...opts });
        if (opts.attempt !== undefined) this.attempt = opts.attempt;
        if (opts.maxRetries !== undefined) this.maxRetries = opts.maxRetries;
        if (opts.host) this.host = opts.host;
        if (opts.port) this.port = opts.port;
    }
}

/**
 * Migration error — migration execution failures.
 */
class MigrationError extends DatabaseError
{
    /**
     * @param {string}  [message]         - Description.
     * @param {object}  [opts]
     * @param {string}  [opts.migration]  - Migration name that failed.
     * @param {string}  [opts.direction]  - 'up' or 'down'.
     * @param {number}  [opts.batch]      - Batch number.
     */
    constructor(message, opts = {})
    {
        super(message || 'Migration Failed', { code: 'MIGRATION_ERROR', ...opts });
        if (opts.migration) this.migration = opts.migration;
        if (opts.direction) this.direction = opts.direction;
        if (opts.batch !== undefined) this.batch = opts.batch;
    }
}

/**
 * Transaction error — transaction commit/rollback failures.
 */
class TransactionError extends DatabaseError
{
    /**
     * @param {string}  [message]       - Description.
     * @param {object}  [opts]
     * @param {string}  [opts.phase]    - 'begin', 'commit', or 'rollback'.
     */
    constructor(message, opts = {})
    {
        super(message || 'Transaction Failed', { code: 'TRANSACTION_ERROR', ...opts });
        if (opts.phase) this.phase = opts.phase;
    }
}

/**
 * Query error — query execution failures with SQL context.
 */
class QueryError extends DatabaseError
{
    /**
     * @param {string}  [message]      - Description.
     * @param {object}  [opts]
     * @param {string}  [opts.sql]     - The SQL that failed (if applicable).
     * @param {Array}   [opts.params]  - Query parameters.
     * @param {string}  [opts.table]   - Target table.
     */
    constructor(message, opts = {})
    {
        super(message || 'Query Failed', { code: 'QUERY_ERROR', ...opts });
        if (opts.sql) this.sql = opts.sql;
        if (opts.params) this.params = opts.params;
        if (opts.table) this.table = opts.table;
    }
}

/**
 * Adapter error — adapter-level issues (driver not found, unsupported operation).
 */
class AdapterError extends DatabaseError
{
    /**
     * @param {string}  [message]        - Description.
     * @param {object}  [opts]
     * @param {string}  [opts.adapter]   - Adapter name.
     * @param {string}  [opts.operation] - The operation that failed.
     */
    constructor(message, opts = {})
    {
        super(message || 'Adapter Error', { code: 'ADAPTER_ERROR', ...opts });
        if (opts.operation) this.operation = opts.operation;
    }
}

/**
 * Cache error — caching layer failures.
 */
class CacheError extends HttpError
{
    /**
     * @param {string}  [message]        - Description.
     * @param {object}  [opts]
     * @param {string}  [opts.operation] - Cache operation that failed.
     * @param {string}  [opts.key]       - Cache key involved.
     */
    constructor(message, opts = {})
    {
        super(500, message || 'Cache Error', { code: 'CACHE_ERROR', ...opts });
        if (opts.operation) this.operation = opts.operation;
        if (opts.key) this.key = opts.key;
    }
}

// --- Factory -----------------------------------------------------

/**
 * Create an HttpError by status code.
 *
 * @param {number} statusCode
 * @param {string} [message]
 * @param {object} [opts]
 * @returns {HttpError}
 *
 * @example
 *   throw createError(404, 'User not found');
 *   throw createError(422, 'Invalid input', { details: { email: 'required' } });
 */
function createError(statusCode, message, opts)
{
    const map = {
        400: BadRequestError,
        401: UnauthorizedError,
        403: ForbiddenError,
        404: NotFoundError,
        405: MethodNotAllowedError,
        408: TimeoutError,
        409: ConflictError,
        410: GoneError,
        413: PayloadTooLargeError,
        422: UnprocessableEntityError,
        429: TooManyRequestsError,
        500: InternalError,
        501: NotImplementedError,
        502: BadGatewayError,
        503: ServiceUnavailableError,
    };

    const Cls = map[statusCode];
    if (Cls) return new Cls(message, opts);
    return new HttpError(statusCode, message, opts);
}

/**
 * Check if a value is an HttpError (or duck-typed equivalent).
 * @param {*} err
 * @returns {boolean}
 */
function isHttpError(err)
{
    if (!err || !(err instanceof Error)) return false;
    return err instanceof HttpError || typeof err.statusCode === 'number';
}

module.exports = {
    HttpError,
    BadRequestError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    MethodNotAllowedError,
    ConflictError,
    GoneError,
    PayloadTooLargeError,
    UnprocessableEntityError,
    ValidationError,
    TooManyRequestsError,
    InternalError,
    NotImplementedError,
    BadGatewayError,
    ServiceUnavailableError,
    // Framework-specific errors
    DatabaseError,
    ConfigurationError,
    MiddlewareError,
    RoutingError,
    TimeoutError,
    // ORM-specific errors
    ConnectionError,
    MigrationError,
    TransactionError,
    QueryError,
    AdapterError,
    CacheError,
    createError,
    isHttpError,
};
