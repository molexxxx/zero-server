const App = require('./lib/app');
const cors = require('./lib/cors');
const fetch = require('./lib/fetch');
const body = require('./lib/body');
const serveStatic = require('./lib/static');
const rateLimit = require('./lib/rateLimit');
const logger = require('./lib/logger');

module.exports = {
    createApp: () => new App(),
    cors,
    fetch,
    // body parsers
    json: body.json,
    urlencoded: body.urlencoded,
    text: body.text,
    raw: body.raw,
    multipart: body.multipart,
    // serving
    static: serveStatic,
    // middleware
    rateLimit,
    logger,
};
