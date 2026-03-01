/**
 * @module molex-http
 * @description Public entry point for the molex-http package.
 *              Re-exports every middleware, the app factory, and the fetch helper.
 */
const App = require('./lib/app');
const cors = require('./lib/cors');
const fetch = require('./lib/fetch');
const body = require('./lib/body');
const serveStatic = require('./lib/static');
const rateLimit = require('./lib/rateLimit');
const logger = require('./lib/logger');

module.exports = {
    /**
     * Create a new application instance.
     * @returns {import('./lib/app')} Fresh App with an empty middleware stack.
     */
    createApp: () => new App(),
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
};
