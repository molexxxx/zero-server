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
const { WebSocketConnection } = require('./lib/ws');
const { SSEStream } = require('./lib/sse');

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
    // classes (for advanced / direct usage)
    /** @see module:ws/connection */
    WebSocketConnection,
    /** @see module:sse/stream */
    SSEStream,
};
