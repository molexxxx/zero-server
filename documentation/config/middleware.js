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
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                baseUri: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                scriptSrcAttr: ["'none'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                connectSrc: ["'self'", 'wss:', 'ws:'],
                imgSrc: ["'self'", 'data:', 'blob:'],
                fontSrc: ["'self'", 'https:', 'data:'],
                mediaSrc: ["'self'", 'blob:'],
                frameSrc: ["'self'", 'blob:'],
                formAction: ["'self'"],
                frameAncestors: ["'self'"],
                objectSrc: ["'none'"],
                upgradeInsecureRequests: []
            }
        }
    }));
    app.use(cors());
    app.use(compress());
    app.use(timeout(30000));
    app.use(cookieParser());
    app.use(json());
    app.use(urlencoded());
    app.use(text());
    app.use(serveStatic(path.join(__dirname, '..', 'public'), {
        setHeaders(res, filePath)
        {
            const rel = filePath.replace(/\\/g, '/');
            if (/\/modules\//.test(rel) || /\/data\//.test(rel))
            {
                res.raw.setHeader('Cache-Control', 'no-cache');
            }
        }
    }));
}

module.exports = { applyMiddleware };
