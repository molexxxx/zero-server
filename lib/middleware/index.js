/**
 * @module middleware
 * @description Built-in middleware for zero-http.
 *              Re-exports cors, logger, rateLimit, compress, and static file serving.
 */
const cors = require('./cors');
const logger = require('./logger');
const rateLimit = require('./rateLimit');
const compress = require('./compress');
const serveStatic = require('./static');

module.exports = { cors, logger, rateLimit, compress, static: serveStatic };
