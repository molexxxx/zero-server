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
    createError,
    isHttpError,
};
