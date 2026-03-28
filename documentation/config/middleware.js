const path = require('path');
const {
    cors, json, urlencoded, text,
    static: serveStatic, logger, compress,
    helmet, timeout, requestId, cookieParser
} = require('../..');

/**
 * Register the standard middleware stack on the app.
 * Order matters — security & utility first, then parsers, then static.
 */
function applyMiddleware(app)
{
    app.use(logger({ format: 'dev' }));
    app.use(requestId());
    app.use(helmet());
    app.use(cors());
    app.use(compress());
    app.use(timeout(30000));
    app.use(cookieParser());
    app.use(json());
    app.use(urlencoded());
    app.use(text());
    app.use(serveStatic(path.join(__dirname, '..', 'public')));
}

module.exports = { applyMiddleware };
