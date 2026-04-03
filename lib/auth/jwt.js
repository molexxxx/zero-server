/**
 * @module auth/jwt
 * @description Zero-dependency JWT (JSON Web Token) middleware.
 *              Supports HMAC (HS256/384/512) and RSA (RS256/384/512)
 *              algorithms, JWKS endpoint auto-fetching, token extraction
 *              from header/cookie/query, and configurable validation rules.
 *
 *              Populates `req.user` with the decoded payload and `req.token`
 *              with the raw token string.
 *
 * @example
 *   const { createApp, jwt } = require('zero-http');
 *   const app = createApp();
 *
 *   app.use(jwt({ secret: process.env.JWT_SECRET }));
 *
 * @example
 *   // RSA with JWKS auto-fetch
 *   app.use(jwt({
 *       jwksUri: 'https://auth.example.com/.well-known/jwks.json',
 *       audience: 'my-api',
 *       issuer: 'https://auth.example.com',
 *   }));
 *
 * @example
 *   // Extract from cookie instead of Authorization header
 *   app.use(jwt({
 *       secret: 'my-secret',
 *       getToken: (req) => req.cookies?.access_token,
 *   }));
 */
const crypto = require('crypto');
const log = require('../debug')('zero:jwt');

// -- Constants -------------------------------------------------

/** @private */
const ALG_MAP = {
    HS256: { type: 'hmac', hash: 'sha256' },
    HS384: { type: 'hmac', hash: 'sha384' },
    HS512: { type: 'hmac', hash: 'sha512' },
    RS256: { type: 'rsa',  hash: 'sha256' },
    RS384: { type: 'rsa',  hash: 'sha384' },
    RS512: { type: 'rsa',  hash: 'sha512' },
};

const SUPPORTED_ALGORITHMS = Object.keys(ALG_MAP);

// -- Base64url helpers -----------------------------------------

/** @private */
function _base64urlEncode(data)
{
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    return buf.toString('base64url');
}

/** @private */
function _base64urlDecode(str)
{
    return Buffer.from(str, 'base64url');
}

// -- JWT Core Functions ----------------------------------------

/**
 * Decode a JWT without verifying the signature.
 * Returns `null` for malformed tokens — never throws.
 *
 * @param {string} token - Raw JWT string.
 * @returns {{ header: object, payload: object, signature: string }|null}
 *
 * @example
 *   const parts = decode(token);
 *   console.log(parts.payload.sub); // '1234'
 */
function decode(token)
{
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try
    {
        const header = JSON.parse(_base64urlDecode(parts[0]).toString());
        const payload = JSON.parse(_base64urlDecode(parts[1]).toString());
        return { header, payload, signature: parts[2] };
    }
    catch (_) { return null; }
}

/**
 * Sign a payload and produce a JWT string.
 *
 * @param {object} payload - Claims to encode.
 * @param {string|Buffer} secret - HMAC secret or RSA private key (PEM).
 * @param {object} [opts] - Signing options.
 * @param {string} [opts.algorithm='HS256'] - Signing algorithm.
 * @param {number} [opts.expiresIn] - Expiry in seconds from now.
 * @param {string} [opts.issuer] - `iss` claim.
 * @param {string} [opts.audience] - `aud` claim.
 * @param {string} [opts.subject] - `sub` claim.
 * @param {string} [opts.jwtId] - `jti` claim.
 * @param {object} [opts.header] - Extra header fields.
 * @returns {string} Signed JWT.
 *
 * @example
 *   const token = sign({ userId: 42 }, 'my-secret', { expiresIn: 3600 });
 *
 * @example
 *   // RSA — pass a PEM-encoded private key
 *   const rsaPrivateKey = fs.readFileSync('private.pem');
 *   const token = sign({ userId: 42 }, rsaPrivateKey, { algorithm: 'RS256' });
 */
function sign(payload, secret, opts = {})
{
    const alg = opts.algorithm || 'HS256';
    const algInfo = ALG_MAP[alg];
    if (!algInfo) throw new Error(`Unsupported algorithm: ${alg}`);

    const now = Math.floor(Date.now() / 1000);
    const claims = { ...payload, iat: payload.iat ?? now };
    if (opts.expiresIn) claims.exp = now + opts.expiresIn;
    if (opts.issuer) claims.iss = opts.issuer;
    if (opts.audience) claims.aud = opts.audience;
    if (opts.subject) claims.sub = opts.subject;
    if (opts.jwtId) claims.jti = opts.jwtId;
    if (opts.notBefore) claims.nbf = now + opts.notBefore;

    const header = { alg, typ: 'JWT', ...(opts.header || {}) };
    const segments = [
        _base64urlEncode(JSON.stringify(header)),
        _base64urlEncode(JSON.stringify(claims)),
    ];
    const signingInput = segments.join('.');

    let sig;
    if (algInfo.type === 'hmac')
    {
        sig = crypto.createHmac(algInfo.hash, secret).update(signingInput).digest();
    }
    else
    {
        sig = crypto.sign(algInfo.hash, Buffer.from(signingInput), secret);
    }

    segments.push(_base64urlEncode(sig));
    return segments.join('.');
}

/**
 * Verify a JWT signature and validate claims.
 *
 * @param {string} token - Raw JWT string.
 * @param {string|Buffer} secretOrKey - HMAC secret or RSA public key (PEM).
 * @param {object} [opts] - Verification options.
 * @param {string|string[]} [opts.algorithms] - Allowed algorithms. Default: inferred from key type.
 * @param {string|string[]} [opts.audience] - Required `aud` claim.
 * @param {string|string[]} [opts.issuer] - Required `iss` claim.
 * @param {string} [opts.subject] - Required `sub` claim.
 * @param {number} [opts.clockTolerance=0] - Seconds of clock skew tolerance for `exp`/`nbf`.
 * @param {number} [opts.maxAge] - Maximum token age in seconds (from `iat`).
 * @param {boolean} [opts.ignoreExpiration=false] - Skip expiry validation.
 * @returns {{ header: object, payload: object }} Decoded and verified token.
 * @throws {Error} If the token is invalid, expired, or fails any claim check.
 *
 * @example
 *   try {
 *       const { payload } = verify(token, secret);
 *       console.log(payload.userId);
 *   } catch (err) {
 *       console.error(err.code); // 'TOKEN_EXPIRED', 'INVALID_SIGNATURE', etc.
 *   }
 */
function verify(token, secretOrKey, opts = {})
{
    const decoded = decode(token);
    if (!decoded) throw _jwtError('Malformed token', 'MALFORMED_TOKEN');

    const { header, payload } = decoded;
    const alg = header.alg;
    const algInfo = ALG_MAP[alg];
    if (!algInfo) throw _jwtError(`Unsupported algorithm: ${alg}`, 'UNSUPPORTED_ALGORITHM');

    // Check allowed algorithms
    const allowed = opts.algorithms
        ? (Array.isArray(opts.algorithms) ? opts.algorithms : [opts.algorithms])
        : (algInfo.type === 'hmac' ? ['HS256', 'HS384', 'HS512'] : ['RS256', 'RS384', 'RS512']);
    if (!allowed.includes(alg)) throw _jwtError(`Algorithm ${alg} not allowed`, 'ALGORITHM_NOT_ALLOWED');

    // Verify signature
    const parts = token.split('.');
    const signingInput = parts[0] + '.' + parts[1];
    const sigBuf = _base64urlDecode(parts[2]);

    if (algInfo.type === 'hmac')
    {
        const expected = crypto.createHmac(algInfo.hash, secretOrKey).update(signingInput).digest();
        if (expected.length !== sigBuf.length || !crypto.timingSafeEqual(expected, sigBuf))
        {
            throw _jwtError('Invalid signature', 'INVALID_SIGNATURE');
        }
    }
    else
    {
        const valid = crypto.verify(algInfo.hash, Buffer.from(signingInput), secretOrKey, sigBuf);
        if (!valid) throw _jwtError('Invalid signature', 'INVALID_SIGNATURE');
    }

    // Validate claims
    const now = Math.floor(Date.now() / 1000);
    const clockTolerance = opts.clockTolerance || 0;

    if (payload.exp !== undefined && !opts.ignoreExpiration)
    {
        if (now > payload.exp + clockTolerance)
        {
            throw _jwtError('Token expired', 'TOKEN_EXPIRED');
        }
    }

    if (payload.nbf !== undefined)
    {
        if (now < payload.nbf - clockTolerance)
        {
            throw _jwtError('Token not yet valid', 'TOKEN_NOT_ACTIVE');
        }
    }

    if (opts.maxAge !== undefined && payload.iat !== undefined)
    {
        if (now - payload.iat > opts.maxAge + clockTolerance)
        {
            throw _jwtError('Token exceeds maximum age', 'TOKEN_MAX_AGE');
        }
    }

    if (opts.audience) _validateClaim('aud', payload.aud, opts.audience);
    if (opts.issuer) _validateClaim('iss', payload.iss, opts.issuer);
    if (opts.subject && payload.sub !== opts.subject)
    {
        throw _jwtError(`Subject mismatch: expected ${opts.subject}`, 'INVALID_SUBJECT');
    }

    return { header, payload };
}

// -- JWKS Support -----------------------------------------------

/**
 * Create a JWKS key provider that fetches and caches public keys.
 * Auto-refreshes keys when a `kid` is not found.
 *
 * @param {string} jwksUri - URL of the JWKS endpoint.
 * @param {object} [opts] - Options.
 * @param {Function} [opts.fetcher] - Custom fetch function (default: built-in fetch).
 * @param {number} [opts.cacheTtl=600000] - Cache TTL in ms (default 10 minutes).
 * @param {number} [opts.requestTimeout=5000] - Request timeout in ms.
 * @returns {Function} `async (header) => publicKey` — resolves the signing key for a JWT header.
 *
 * @example
 *   const getKey = jwks('https://auth.example.com/.well-known/jwks.json');
 *   app.use(jwt({ getKey }));
 */
function jwks(jwksUri, opts = {})
{
    const fetchFn = opts.fetcher || require('../fetch');
    const cacheTtl = opts.cacheTtl || 600000;
    const requestTimeout = opts.requestTimeout || 5000;
    let _cache = null;
    let _lastFetch = 0;

    async function _fetchKeys()
    {
        const now = Date.now();
        if (_cache && (now - _lastFetch) < cacheTtl) return _cache;

        log.debug('fetching JWKS from %s', jwksUri);
        const res = await fetchFn(jwksUri, { timeout: requestTimeout });
        if (!res.ok) throw _jwtError(`JWKS fetch failed: ${res.status}`, 'JWKS_FETCH_FAILED');

        const body = await res.json();
        if (!body.keys || !Array.isArray(body.keys)) throw _jwtError('Invalid JWKS response', 'JWKS_INVALID');

        _cache = new Map();
        for (const key of body.keys)
        {
            if (key.kty === 'RSA' && key.use !== 'enc')
            {
                _cache.set(key.kid, _rsaJwkToPem(key));
            }
        }
        _lastFetch = now;
        return _cache;
    }

    /**
     * Resolve a signing key from the JWKS based on the JWT header.
     *
     * @param {{ kid?: string, alg?: string }} header - JWT header.
     * @returns {Promise<string>} PEM-encoded public key.
     */
    async function getKey(header)
    {
        let keys = await _fetchKeys();

        if (header.kid)
        {
            let pem = keys.get(header.kid);
            if (!pem)
            {
                // Force refresh and retry once
                _cache = null;
                keys = await _fetchKeys();
                pem = keys.get(header.kid);
            }
            if (!pem) throw _jwtError(`Key ${header.kid} not found in JWKS`, 'JWKS_KID_NOT_FOUND');
            return pem;
        }

        // No kid — return the first RSA key
        const first = keys.values().next().value;
        if (!first) throw _jwtError('No suitable key in JWKS', 'JWKS_NO_KEY');
        return first;
    }

    // Expose for testing
    getKey._clearCache = () => { _cache = null; _lastFetch = 0; };
    return getKey;
}

// -- JWT Middleware -----------------------------------------------

/**
 * Create JWT authentication middleware.
 *
 * On success, populates:
 *   - `req.user` — decoded payload
 *   - `req.auth` — `{ header, payload, token }` full decode info
 *   - `req.token` — raw JWT string
 *
 * @param {object} opts - Configuration.
 * @param {string|Buffer} [opts.secret] - HMAC secret for HS* algorithms.
 * @param {string|Buffer} [opts.publicKey] - RSA public key (PEM) for RS* algorithms.
 * @param {Function} [opts.getKey] - Dynamic key resolver `async (header, payload) => key`. Overrides `secret`/`publicKey`.
 * @param {string} [opts.jwksUri] - JWKS endpoint URL (creates a `getKey` automatically).
 * @param {string|string[]} [opts.algorithms] - Allowed algorithms. Default: auto-detect.
 * @param {Function} [opts.getToken] - Custom token extractor `(req) => string|null`.
 * @param {string} [opts.tokenLocation='header'] - Where to look: `'header'`, `'cookie'`, `'query'`.
 * @param {string} [opts.cookieName='token'] - Cookie name when `tokenLocation='cookie'`.
 * @param {string} [opts.queryParam='token'] - Query param name when `tokenLocation='query'`.
 * @param {string|string[]} [opts.audience] - Required `aud` claim.
 * @param {string|string[]} [opts.issuer] - Required `iss` claim.
 * @param {string} [opts.subject] - Required `sub` claim.
 * @param {number} [opts.clockTolerance=0] - Clock skew tolerance in seconds.
 * @param {number} [opts.maxAge] - Maximum token age in seconds.
 * @param {boolean} [opts.credentialsRequired=true] - Return 401 if no token found (false = optional auth).
 * @param {Function} [opts.isRevoked] - `async (payload) => boolean` — check token revocation.
 * @param {Function} [opts.onError] - Custom error handler `(err, req, res) => void`.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   // Simple HMAC
 *   app.use(jwt({ secret: 'my-secret' }));
 *
 * @example
 *   // Optional auth — don't reject missing tokens
 *   app.use(jwt({ secret: 'my-secret', credentialsRequired: false }));
 *
 * @example
 *   // Custom token location
 *   app.use(jwt({
 *       secret: 'my-secret',
 *       getToken: (req) => req.cookies?.access_token || req.get('x-auth-token'),
 *   }));
 *
 * @example
 *   // With revocation check (e.g. a Set or Redis-backed store)
 *   const revokedTokens = new Set();
 *   app.use(jwt({
 *       secret: 'my-secret',
 *       isRevoked: async (payload) => {
 *           return revokedTokens.has(payload.jti);
 *       },
 *   }));
 */
function jwt(opts = {})
{
    if (!opts.secret && !opts.publicKey && !opts.getKey && !opts.jwksUri)
    {
        throw new Error('jwt() requires secret, publicKey, getKey, or jwksUri');
    }

    const algorithms = opts.algorithms
        ? (Array.isArray(opts.algorithms) ? opts.algorithms : [opts.algorithms])
        : null;
    const credentialsRequired = opts.credentialsRequired !== false;
    const getToken = _buildTokenExtractor(opts);
    const isRevoked = typeof opts.isRevoked === 'function' ? opts.isRevoked : null;
    const onError = typeof opts.onError === 'function' ? opts.onError : null;
    const clockTolerance = opts.clockTolerance || 0;
    const verifyOpts = {
        audience: opts.audience,
        issuer: opts.issuer,
        subject: opts.subject,
        clockTolerance,
        maxAge: opts.maxAge,
    };

    // Build key resolver
    let getKey = opts.getKey;
    if (!getKey && opts.jwksUri)
    {
        getKey = jwks(opts.jwksUri, { fetcher: opts.fetcher, cacheTtl: opts.cacheTtl });
    }

    return async function jwtMiddleware(req, res, next)
    {
        try
        {
            const token = getToken(req);
            if (!token)
            {
                if (!credentialsRequired) return next();
                return _sendError(res, 401, 'No token provided', 'CREDENTIALS_REQUIRED', onError, req);
            }

            // Decode to get header (for kid/alg-based key lookup)
            const decoded = decode(token);
            if (!decoded)
            {
                return _sendError(res, 401, 'Malformed token', 'MALFORMED_TOKEN', onError, req);
            }

            // Resolve key
            let key;
            if (getKey)
            {
                key = await getKey(decoded.header, decoded.payload);
            }
            else if (opts.publicKey)
            {
                key = opts.publicKey;
            }
            else
            {
                key = opts.secret;
            }

            // Verify
            const algsOpt = algorithms || verifyOpts.algorithms;
            const result = verify(token, key, { ...verifyOpts, algorithms: algsOpt });

            // Revocation check
            if (isRevoked)
            {
                const revoked = await isRevoked(result.payload);
                if (revoked)
                {
                    return _sendError(res, 401, 'Token has been revoked', 'TOKEN_REVOKED', onError, req);
                }
            }

            // Populate request
            req.user = result.payload;
            req.auth = { header: result.header, payload: result.payload, token };
            req.token = token;

            log.debug('JWT authenticated: sub=%s', result.payload.sub || 'n/a');
            next();
        }
        catch (err)
        {
            const code = err.code || 'INVALID_TOKEN';
            const status = code === 'TOKEN_EXPIRED' ? 401 : 401;
            return _sendError(res, status, err.message, code, onError, req);
        }
    };
}

// -- Token Refresh Helpers ----------------------------------------

/**
 * Generate a signed refresh token.
 * Refresh tokens are long-lived and should be stored securely.
 *
 * @param {object} payload - Claims (typically `{ sub, jti }`).
 * @param {string|Buffer} secret - Signing secret.
 * @param {object} [opts] - Options.
 * @param {number} [opts.expiresIn=604800] - Expiry in seconds (default: 7 days).
 * @param {string} [opts.algorithm='HS256'] - Signing algorithm.
 * @returns {string} Signed refresh token (JWT).
 *
 * @example
 *   const refreshToken = createRefreshToken(
 *       { sub: user.id, jti: crypto.randomUUID() },
 *       process.env.REFRESH_SECRET,
 *       { expiresIn: 30 * 86400 }, // 30 days
 *   );
 */
function createRefreshToken(payload, secret, opts = {})
{
    return sign(payload, secret, {
        algorithm: opts.algorithm || 'HS256',
        expiresIn: opts.expiresIn || 604800,
        ...opts,
    });
}

/**
 * Create a token-pair factory for convenient access + refresh token generation.
 *
 * @param {object} config - Configuration.
 * @param {string|Buffer} config.accessSecret - Secret for access tokens.
 * @param {string|Buffer} [config.refreshSecret] - Secret for refresh tokens (defaults to accessSecret).
 * @param {number} [config.accessExpiresIn=900] - Access token expiry in seconds (default: 15 min).
 * @param {number} [config.refreshExpiresIn=604800] - Refresh token expiry (default: 7 days).
 * @param {string} [config.algorithm='HS256'] - Signing algorithm.
 * @returns {{ generateTokens: Function, verifyRefreshToken: Function, verifyAccessToken: Function }}
 *
 * @example
 *   const tokens = tokenPair({
 *       accessSecret: process.env.JWT_SECRET,
 *       refreshSecret: process.env.REFRESH_SECRET,
 *       accessExpiresIn: 900,
 *       refreshExpiresIn: 86400 * 30,
 *   });
 *
 *   // Login route
 *   app.post('/login', async (req, res) => {
 *       const user = await authenticate(req.body);
 *       const { accessToken, refreshToken } = tokens.generateTokens({ sub: user.id });
 *       res.json({ accessToken, refreshToken });
 *   });
 *
 *   // Refresh route
 *   app.post('/refresh', async (req, res) => {
 *       const { payload } = tokens.verifyRefreshToken(req.body.refreshToken);
 *       const { accessToken, refreshToken } = tokens.generateTokens({ sub: payload.sub });
 *       res.json({ accessToken, refreshToken });
 *   });
 */
function tokenPair(config)
{
    const accessSecret = config.accessSecret;
    const refreshSecret = config.refreshSecret || accessSecret;
    const accessExp = config.accessExpiresIn || 900;
    const refreshExp = config.refreshExpiresIn || 604800;
    const alg = config.algorithm || 'HS256';

    return {
        /**
         * Generate an access + refresh token pair.
         * @param {object} payload - Claims to include.
         * @returns {{ accessToken: string, refreshToken: string }}
         */
        generateTokens(payload)
        {
            const jti = crypto.randomUUID();
            return {
                accessToken: sign(payload, accessSecret, { algorithm: alg, expiresIn: accessExp }),
                refreshToken: sign({ ...payload, jti }, refreshSecret, { algorithm: alg, expiresIn: refreshExp }),
            };
        },

        /**
         * Verify a refresh token.
         * @param {string} token - Raw refresh token.
         * @returns {{ header: object, payload: object }}
         */
        verifyRefreshToken(token)
        {
            return verify(token, refreshSecret, { algorithms: [alg] });
        },

        /**
         * Verify an access token.
         * @param {string} token - Raw access token.
         * @returns {{ header: object, payload: object }}
         */
        verifyAccessToken(token)
        {
            return verify(token, accessSecret, { algorithms: [alg] });
        },
    };
}

// -- Internal Helpers ---------------------------------------------

/** @private */
function _buildTokenExtractor(opts)
{
    if (typeof opts.getToken === 'function') return opts.getToken;

    const location = opts.tokenLocation || 'header';
    const cookieName = opts.cookieName || 'token';
    const queryParam = opts.queryParam || 'token';

    return (req) =>
    {
        // Always try Authorization header first
        const authHeader = req.headers?.authorization || req.get?.('authorization');
        if (authHeader)
        {
            const parts = authHeader.split(' ');
            if (parts.length === 2 && parts[0].toLowerCase() === 'bearer')
            {
                return parts[1];
            }
        }

        if (location === 'cookie' || location !== 'header')
        {
            const cookieVal = req.cookies?.[cookieName] || req.signedCookies?.[cookieName];
            if (cookieVal) return cookieVal;
        }

        if (location === 'query' || location !== 'header')
        {
            const queryVal = req.query?.[queryParam];
            if (queryVal) return queryVal;
        }

        return null;
    };
}

/** @private */
function _validateClaim(name, actual, expected)
{
    const expectedArr = Array.isArray(expected) ? expected : [expected];
    const actualArr = Array.isArray(actual) ? actual : [actual];
    const match = actualArr.some(a => expectedArr.includes(a));
    if (!match)
    {
        throw _jwtError(
            `${name} mismatch: expected ${expectedArr.join(' or ')}`,
            `INVALID_${name.toUpperCase()}`
        );
    }
}

/** @private */
function _jwtError(message, code)
{
    const err = new Error(message);
    err.code = code;
    return err;
}

/** @private */
function _sendError(res, status, message, code, onError, req)
{
    if (onError) return onError({ message, code, statusCode: status }, req, res);
    res.status(status).json({ error: message, code, statusCode: status });
}

/**
 * Convert an RSA JWK (JSON Web Key) to PEM format.
 * Handles the DER encoding of RSA public keys per RFC 3447.
 *
 * @param {object} jwk - JWK with `n` and `e` fields.
 * @returns {string} PEM-encoded RSA public key.
 * @private
 */
function _rsaJwkToPem(jwk)
{
    const n = _base64urlDecode(jwk.n);
    const e = _base64urlDecode(jwk.e);

    // DER-encode RSA public key
    const nBytes = _derUint(n);
    const eBytes = _derUint(e);
    const seq = _derSequence(Buffer.concat([nBytes, eBytes]));

    // Wrap in SubjectPublicKeyInfo
    const algId = Buffer.from([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
        0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ]);
    const bitString = Buffer.concat([Buffer.from([0x03, ...(_derLength(seq.length + 1)), 0x00]), seq]);
    const spki = _derSequence(Buffer.concat([algId, bitString]));

    const b64 = spki.toString('base64');
    const lines = b64.match(/.{1,64}/g) || [];
    return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

/** @private */
function _derUint(buf)
{
    // Ensure positive integer (prepend 0x00 if high bit set)
    let b = buf;
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return Buffer.concat([Buffer.from([0x02, ..._derLength(b.length)]), b]);
}

/** @private */
function _derLength(len)
{
    if (len < 0x80) return [len];
    const bytes = [];
    let tmp = len;
    while (tmp > 0) { bytes.unshift(tmp & 0xff); tmp >>= 8; }
    return [0x80 | bytes.length, ...bytes];
}

/** @private */
function _derSequence(buf)
{
    return Buffer.concat([Buffer.from([0x30, ..._derLength(buf.length)]), buf]);
}

module.exports = {
    jwt,
    sign,
    verify,
    decode,
    jwks,
    tokenPair,
    createRefreshToken,
    SUPPORTED_ALGORITHMS,
};
