/**
 * @module middleware/csrf
 * @description CSRF (Cross-Site Request Forgery) protection middleware.
 *              Uses the double-submit cookie + header/body token pattern.
 *
 *              Safe methods (GET, HEAD, OPTIONS) are skipped automatically.
 *              For state-changing requests (POST, PUT, PATCH, DELETE), the
 *              middleware checks for a matching token in:
 *                1. `req.headers['x-csrf-token']`
 *                2. `req.body._csrf` (if body parsed)
 *                3. `req.query._csrf`
 *
 * @example
 *   const { createApp, csrf } = require('zero-http');
 *   const app = createApp();
 *
 *   app.use(csrf());                   // default options
 *   app.use(csrf({ cookie: 'tok' }));  // custom cookie name
 *
 *   // In a route, read the token for forms / SPA:
 *   app.get('/form', (req, res) => {
 *       res.json({ csrfToken: req.csrfToken });
 *   });
 */
const crypto = require('crypto');
const log = require('../debug')('zero:csrf');

/**
 * @param {object} [options] - Configuration options.
 * @param {string} [options.cookie='_csrf']       - Name of the double-submit cookie.
 * @param {string} [options.header='x-csrf-token'] - Request header that carries the token.
 * @param {number} [options.saltLength=18]        - Bytes of randomness for token generation.
 * @param {string} [options.secret]               - HMAC secret. Auto-generated per process if omitted.
 * @param {string[]} [options.ignoreMethods]      - HTTP methods to skip. Default: GET, HEAD, OPTIONS.
 * @param {string[]} [options.ignorePaths]        - Path prefixes to skip (e.g. ['/api/webhooks']).
 * @param {Function} [options.onError]            - Custom error handler `(req, res) => {}`.
 * @returns {Function} Middleware function.
 */
function csrf(options = {})
{
    const cookieName    = options.cookie || '_csrf';
    const headerName    = (options.header || 'x-csrf-token').toLowerCase();
    const saltLen       = options.saltLength || 18;
    const secret        = options.secret || crypto.randomBytes(32).toString('hex');
    const ignoreMethods = new Set((options.ignoreMethods || ['GET', 'HEAD', 'OPTIONS']).map(m => m.toUpperCase()));
    const ignorePaths   = options.ignorePaths || [];

    /** @private */
    function generateToken()
    {
        try
        {
            const salt = crypto.randomBytes(saltLen).toString('hex');
            const hash = crypto.createHmac('sha256', secret).update(salt).digest('hex');
            return `${salt}.${hash}`;
        }
        catch (e) { return null; }
    }

    /** @private */
    function verifyToken(token)
    {
        if (!token || typeof token !== 'string') return false;
        const parts = token.split('.');
        if (parts.length !== 2) return false;
        const [salt, hash] = parts;
        try
        {
            const expected = crypto.createHmac('sha256', secret).update(salt).digest('hex');
            // Constant-time comparison
            if (expected.length !== hash.length) return false;
            return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
        }
        catch (e) { return false; }
    }

    return function csrfMiddleware(req, res, next)
    {
        // Skip safe methods
        if (ignoreMethods.has(req.method))
        {
            // Ensure a token exists in the cookie for the client to read
            const existing = req.cookies && req.cookies[cookieName];
            if (!existing || !verifyToken(existing))
            {
                const token = generateToken();
                const secure = req.secure ? '; Secure' : '';
                res.set('Set-Cookie',
                    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`
                );
                req.csrfToken = token;
            }
            else
            {
                req.csrfToken = existing;
            }
            return next();
        }

        // Skip ignored paths
        const pathname = req.url.split('?')[0];
        for (const prefix of ignorePaths)
        {
            if (pathname.startsWith(prefix)) return next();
        }

        // Extract the token the client sent
        const clientToken =
            req.headers[headerName] ||
            (req.body && req.body._csrf) ||
            (req.query && req.query._csrf) ||
            null;

        // Extract the cookie token
        const cookieToken = req.cookies && req.cookies[cookieName];

        // Both must exist and be valid, and must match
        if (!clientToken || !cookieToken || clientToken !== cookieToken || !verifyToken(clientToken))
        {
            log.warn('CSRF validation failed for %s %s', req.method, pathname);
            if (options.onError) return options.onError(req, res);
            res.status(403).json({ error: 'CSRF token missing or invalid' });
            return;
        }

        // Rotate token on each state-changing request
        const newToken = generateToken();
        const secure = req.secure ? '; Secure' : '';
        res.set('Set-Cookie',
            `${cookieName}=${newToken}; Path=/; HttpOnly; SameSite=Strict${secure}`
        );
        req.csrfToken = newToken;
        next();
    };
}

module.exports = csrf;
