/**
 * @module cookieParser
 * @description Cookie parsing middleware.
 *              Parses the `Cookie` header and populates `req.cookies`.
 *              Supports signed cookies, JSON cookies, secret rotation,
 *              and timing-safe signature verification.
 */
const crypto = require('crypto');

// -- Internal helpers ------------------------------------

/**
 * Timing-safe HMAC-SHA256 signature comparison.
 * Prevents timing-based side-channel attacks on cookie signatures.
 *
 * @param {string} data    - The cookie payload.
 * @param {string} sig     - The provided signature (base64, no padding).
 * @param {string} secret  - Secret to verify against.
 * @returns {boolean} `true` if the signature is valid.
 * @private
 */
function _timingSafeVerify(data, sig, secret)
{
    try
    {
        const expected = crypto
            .createHmac('sha256', secret)
            .update(data)
            .digest('base64')
            .replace(/=+$/, '');
        if (expected.length !== sig.length) return false;
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    }
    catch (e) { return false; }
}

/**
 * Verify and unsign a signed cookie value.
 * Signed cookies have the format: `s:<value>.<signature>`.
 * All secret(s) are attempted to support key rotation.
 *
 * @param {string}   val     - Raw cookie value.
 * @param {string[]} secrets - Array of secrets to try.
 * @returns {string|false} Unsigned value on success, `false` on failure.
 * @private
 */
function _unsign(val, secrets)
{
    if (typeof val !== 'string' || !val.startsWith('s:')) return val;
    const payload = val.slice(2);
    const dotIdx = payload.lastIndexOf('.');
    if (dotIdx === -1) return false;

    const data = payload.slice(0, dotIdx);
    const sig = payload.slice(dotIdx + 1);

    for (const s of secrets)
    {
        if (_timingSafeVerify(data, sig, s)) return data;
    }
    return false;
}

/**
 * Try to parse a value as a JSON cookie (prefixed with `j:`).
 *
 * @param {string} val - Cookie value.
 * @returns {*} Parsed value or original string.
 * @private
 */
function _parseJSONCookie(val)
{
    if (typeof val !== 'string' || !val.startsWith('j:')) return val;
    try { return JSON.parse(val.slice(2)); }
    catch (e) { return val; }
}

// -- Middleware factory ----------------------------------

/**
 * Create a cookie parsing middleware.
 *
 * Features:
 *   - Signed cookies with HMAC-SHA256 and timing-safe verification
 *   - Secret rotation (array of secrets, newest first)
 *   - JSON cookies (`j:` prefix, auto-parsed)
 *   - `req.secret` / `req.secrets` exposed for downstream middleware
 *   - URI-decode toggle
 *
 * @param {string|string[]} [secret] - Secret(s) for signing / verifying cookies.
 * @param {object}          [opts] - Configuration options.
 * @param {boolean}         [opts.decode=true] - URI-decode cookie values.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(cookieParser());
 *   app.use(cookieParser('my-secret'));
 *   app.use(cookieParser(['new-secret', 'old-secret'])); // key rotation
 */
function cookieParser(secret, opts = {})
{
    const secrets = secret
        ? (Array.isArray(secret) ? secret : [secret])
        : [];
    const decode = opts.decode !== false;

    return (req, res, next) =>
    {
        const header = req.headers.cookie;
        req.cookies = {};
        req.signedCookies = {};

        // Expose secret(s) for downstream use (res.cookie signed:true, csrf, etc.)
        if (secrets.length)
        {
            req.secret = secrets[0];
            req.secrets = secrets;
        }

        if (!header)
        {
            return next();
        }

        const pairs = header.split(';');
        for (const pair of pairs)
        {
            const eqIdx = pair.indexOf('=');
            if (eqIdx === -1) continue;

            const name = pair.slice(0, eqIdx).trim();
            let val = pair.slice(eqIdx + 1).trim();

            // Remove surrounding quotes if any
            if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"')
            {
                val = val.slice(1, -1);
            }

            // URI decode
            if (decode)
            {
                try { val = decodeURIComponent(val); } catch (e) { /* keep raw */ }
            }

            // Signed cookies → verify, then JSON-parse if j: prefixed
            if (secrets.length > 0 && val.startsWith('s:'))
            {
                const unsigned = _unsign(val, secrets);
                if (unsigned !== false)
                {
                    req.signedCookies[name] = _parseJSONCookie(unsigned);
                }
                // Failed-verification signed cookies are silently dropped
            }
            // JSON cookies → auto-parse
            else if (val.startsWith('j:'))
            {
                req.cookies[name] = _parseJSONCookie(val);
            }
            else
            {
                req.cookies[name] = val;
            }
        }

        next();
    };
}

// -- Static helpers --------------------------------------

/**
 * Sign a cookie value with the given secret.
 *
 * @param {string} val    - Cookie value to sign.
 * @param {string} secret - Signing secret.
 * @returns {string} Signed value in format `s:<value>.<signature>`.
 *
 * @example
 *   const signed = cookieParser.sign('hello', 'my-secret');
 *   // => 's:hello.DGDyS...'
 */
cookieParser.sign = function sign(val, secret)
{
    const sig = crypto
        .createHmac('sha256', secret)
        .update(String(val))
        .digest('base64')
        .replace(/=+$/, '');
    return `s:${val}.${sig}`;
};

/**
 * Verify and unsign a signed cookie value.
 *
 * @param {string}          val    - Signed cookie value (`s:data.sig`).
 * @param {string|string[]} secret - Secret or array of secrets (for rotation).
 * @returns {string|false} Unsigned value on success, `false` on failure.
 *
 * @example
 *   const value = cookieParser.unsign('s:hello.DGDyS...', 'my-secret');
 *   // => 'hello' or false
 */
cookieParser.unsign = function unsign(val, secret)
{
    const secrets = Array.isArray(secret) ? secret : [secret];
    return _unsign(val, secrets);
};

/**
 * Serialize a value as a JSON cookie string (prefixed with `j:`).
 *
 * @param {*} val - Value to serialize (object, array, etc.).
 * @returns {string} JSON cookie string.
 *
 * @example
 *   const jcookie = cookieParser.jsonCookie({ cart: [1,2,3] });
 *   // => 'j:{"cart":[1,2,3]}'
 */
cookieParser.jsonCookie = function jsonCookie(val)
{
    return 'j:' + JSON.stringify(val);
};

/**
 * Parse a JSON cookie string (must start with `j:`).
 *
 * @param {string} str - JSON cookie string.
 * @returns {*} Parsed value, or the original string if not a valid JSON cookie.
 */
cookieParser.parseJSON = function parseJSON(str)
{
    return _parseJSONCookie(str);
};

module.exports = cookieParser;
