/**
 * @module middleware
 * @description Built-in middleware for zero-http.
 *              Re-exports all middleware.
 */
const cors = require('./cors');
const logger = require('./logger');
const rateLimit = require('./rateLimit');
const compress = require('./compress');
const serveStatic = require('./static');
const helmet = require('./helmet');
const timeout = require('./timeout');
const requestId = require('./requestId');
const cookieParser = require('./cookieParser');
const errorHandler = require('./errorHandler');

module.exports = { cors, logger, rateLimit, compress, static: serveStatic, helmet, timeout, requestId, cookieParser, errorHandler };
