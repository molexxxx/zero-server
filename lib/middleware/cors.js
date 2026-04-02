/**
 * @module cors
 * @description CORS middleware.  Supports exact origins, wildcard `'*'`,
 *              arrays of allowed origins, and suffix matching with a leading dot
 *              (e.g. `'.example.com'` matches `sub.example.com`).
 */

/**
 * Create a CORS middleware.
 *
 * @param {object}           [options] - Configuration options.
 * @param {string|string[]}  [options.origin='*']          - Allowed origin(s).  Use `'*'` for any,
 *                                                           an array for a whitelist, or a string
 *                                                           starting with `'.'` for suffix matching.
 * @param {string}           [options.methods='GET,POST,PUT,DELETE,OPTIONS'] - Allowed HTTP methods.
 * @param {string}           [options.allowedHeaders='Content-Type,Authorization'] - Allowed request headers.
 * @param {string}           [options.exposedHeaders]       - Headers the browser is allowed to read.
 * @param {boolean}          [options.credentials=false]    - Whether to set `Access-Control-Allow-Credentials`.
 * @param {number}           [options.maxAge]               - Preflight cache duration in seconds.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(cors());                                  // allow all origins
 *   app.use(cors({ origin: 'https://example.com' })); // single origin
 *   app.use(cors({                                     // fine-grained
 *       origin: ['https://my.example.com', '.example.com'],
 *       credentials: true,
 *       maxAge: 86400,
 *   }));
 */
function cors(options = {})
{
    const allowOrigin = (options.hasOwnProperty('origin')) ? options.origin : '*';
    const allowMethods = (options.methods || 'GET,POST,PUT,DELETE,OPTIONS');
    const allowHeaders = (options.allowedHeaders || 'Content-Type,Authorization');

    // RFC 6454: credentials cannot be used with wildcard origin
    if (options.credentials && allowOrigin === '*')
    {
        throw new Error('CORS credentials cannot be used with wildcard origin "*". Specify explicit origins instead.');
    }

    /**
     * Resolve the Origin header value to echo back based on the configured
     * allow-list.  Returns `null` when the origin should not be allowed.
     *
     * @private
     * @param {string|undefined} reqOrigin - The request's `Origin` header.
     * @returns {string|null} Origin value to set, or `null`.
     */
    function matchOrigin(reqOrigin)
    {
        if (!allowOrigin) return null; // origin explicitly disabled
        if (typeof allowOrigin === 'string') return allowOrigin === '*' ? '*' : allowOrigin;
        if (Array.isArray(allowOrigin))
        {
            if (!reqOrigin) return null;
            for (const o of allowOrigin)
            {
                if (!o) continue;
                if (o === reqOrigin) return reqOrigin;
                // allow suffix match with leading dot (e.g. .example.com)
                if (o[0] === '.' && reqOrigin.endsWith(o)) return reqOrigin;
            }
            return null;
        }
        return null;
    }

    return (req, res, next) =>
    {
        const reqOrigin = req.headers && (req.headers.origin || req.headers.Origin);
        const originValue = matchOrigin(reqOrigin);

        if (originValue)
        {
            res.set('Access-Control-Allow-Origin', originValue);
            // Set Vary: Origin when not using wildcard (important for caching proxies)
            if (originValue !== '*') res.vary('Origin');
            if (options.credentials) res.set('Access-Control-Allow-Credentials', 'true');
        }

        if (allowMethods) res.set('Access-Control-Allow-Methods', allowMethods);
        if (allowHeaders) res.set('Access-Control-Allow-Headers', allowHeaders);
        if (options.exposedHeaders) res.set('Access-Control-Expose-Headers', options.exposedHeaders);
        if (options.maxAge !== undefined) res.set('Access-Control-Max-Age', String(options.maxAge));

        if (req.method === 'OPTIONS') return res.status(204).send();
        next();
    };
}

module.exports = cors;
