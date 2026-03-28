/**
 * @module zero-http
 * @description Public entry point for the zero-http package.
 *              Re-exports every middleware, the app factory, and the fetch helper.
 */
const App = require('./lib/app');
const Router = require('./lib/router');
const cors = require('./lib/middleware/cors');
const fetch = require('./lib/fetch');
const body = require('./lib/body');
const serveStatic = require('./lib/middleware/static');
const rateLimit = require('./lib/middleware/rateLimit');
const logger = require('./lib/middleware/logger');
const compress = require('./lib/middleware/compress');
const helmet = require('./lib/middleware/helmet');
const timeout = require('./lib/middleware/timeout');
const requestId = require('./lib/middleware/requestId');
const cookieParser = require('./lib/middleware/cookieParser');
const csrf = require('./lib/middleware/csrf');
const validate = require('./lib/middleware/validator');
const errorHandler = require('./lib/middleware/errorHandler');
const { WebSocketConnection, WebSocketPool } = require('./lib/ws');
const { SSEStream } = require('./lib/sse');
const env = require('./lib/env');
const { Database, Model, TYPES, Query } = require('./lib/orm');
const errors = require('./lib/errors');
const debug = require('./lib/debug');
const { version } = require('./package.json');

module.exports = {
    /**
     * Create a new application instance.
     * @returns {import('./lib/app')} Fresh App with an empty middleware stack.
     */
    createApp: () => new App(),
    /**
     * Create a standalone Router for modular route grouping.
     * Mount on an App with `app.use('/prefix', router)`.
     * @returns {import('./lib/router')} Fresh Router instance.
     */
    Router: () => new Router(),
    /** @see module:cors */
    cors,
    /** @see module:fetch */
    fetch,
    // body parsers
    /** @see module:body/json */
    json: body.json,
    /** @see module:body/urlencoded */
    urlencoded: body.urlencoded,
    /** @see module:body/text */
    text: body.text,
    /** @see module:body/raw */
    raw: body.raw,
    /** @see module:body/multipart */
    multipart: body.multipart,
    // serving
    /** @see module:static */
    static: serveStatic,
    // middleware
    /** @see module:rateLimit */
    rateLimit,
    /** @see module:logger */
    logger,
    /** @see module:compress */
    compress,
    /** @see module:helmet */
    helmet,
    /** @see module:timeout */
    timeout,
    /** @see module:requestId */
    requestId,
    /** @see module:cookieParser */
    cookieParser,
    /** @see module:csrf */
    csrf,
    /** @see module:validator */
    validate,
    /** @see module:middleware/errorHandler */
    errorHandler,
    // env
    /** @see module:env */
    env,
    // ORM
    /** @see module:orm */
    Database,
    /** @see module:orm/model */
    Model,
    /** @see module:orm/schema */
    TYPES,
    /** @see module:orm/query */
    Query,
    // Error handling & debugging
    /** @see module:errors */
    HttpError: errors.HttpError,
    BadRequestError: errors.BadRequestError,
    UnauthorizedError: errors.UnauthorizedError,
    ForbiddenError: errors.ForbiddenError,
    NotFoundError: errors.NotFoundError,
    MethodNotAllowedError: errors.MethodNotAllowedError,
    ConflictError: errors.ConflictError,
    GoneError: errors.GoneError,
    PayloadTooLargeError: errors.PayloadTooLargeError,
    UnprocessableEntityError: errors.UnprocessableEntityError,
    ValidationError: errors.ValidationError,
    TooManyRequestsError: errors.TooManyRequestsError,
    InternalError: errors.InternalError,
    NotImplementedError: errors.NotImplementedError,
    BadGatewayError: errors.BadGatewayError,
    ServiceUnavailableError: errors.ServiceUnavailableError,
    // Framework-specific errors
    DatabaseError: errors.DatabaseError,
    ConfigurationError: errors.ConfigurationError,
    MiddlewareError: errors.MiddlewareError,
    RoutingError: errors.RoutingError,
    TimeoutError: errors.TimeoutError,
    createError: errors.createError,
    isHttpError: errors.isHttpError,
    /** @see module:debug */
    debug,
    // classes (for advanced / direct usage)
    /** @see module:ws/connection */
    WebSocketConnection,
    /** @see module:ws/room */
    WebSocketPool,
    /** @see module:sse/stream */
    SSEStream,
    /** Package version */
    version,
};
