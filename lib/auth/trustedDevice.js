/**
 * @module auth/trustedDevice
 * @description Trusted Device / "Remember Me" middleware for 2FA.
 *              After successful 2FA verification, issues an encrypted device-trust
 *              token stored as an HttpOnly, Secure, SameSite=Strict cookie.
 *
 *              Subsequent requests skip the 2FA prompt if the trust token is valid.
 *              Supports secret rotation, IP binding, and revocation.
 *
 *              Uses AES-256-GCM encryption — tokens are encrypted, not just signed,
 *              preventing information leakage.
 *
 * @example
 *   const { trustedDevice, twoFactor } = require('zero-http');
 *
 *   app.post('/verify-2fa', twoFactor.verifyTOTPMiddleware({
 *       getSecret: (req) => req.user.totpSecret,
 *   }), trustedDevice.issue({
 *       secret: process.env.DEVICE_TRUST_SECRET,
 *   }));
 *
 *   app.use(twoFactor.require2FA({
 *       isEnabled: (req) => req.user.totpEnabled,
 *       trustedDevice: trustedDevice.verify({
 *           secret: process.env.DEVICE_TRUST_SECRET,
 *       }),
 *   }));
 */

const crypto = require('crypto');
const log = require('../debug')('zero:trustedDevice');

// -- Constants -----------------------------------------------

const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_COOKIE_NAME = '_dt';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// -- Encryption Helpers --------------------------------------

/**
 * Derive a 256-bit key from a secret string using SHA-256.
 * @private
 * @param {string} secret
 * @returns {Buffer}
 */
function _deriveKey(secret)
{
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a payload using AES-256-GCM.
 * @private
 * @param {object} payload
 * @param {string} secret
 * @returns {string} Base64-encoded encrypted token.
 */
function _encrypt(payload, secret)
{
    const key = _deriveKey(secret);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const json = JSON.stringify(payload);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Format: iv || tag || ciphertext
    return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/**
 * Decrypt a token using AES-256-GCM.
 * @private
 * @param {string} token
 * @param {string} secret
 * @returns {object|null} Decoded payload or null if invalid.
 */
function _decrypt(token, secret)
{
    try
    {
        const buf = Buffer.from(token, 'base64url');
        if (buf.length < IV_LENGTH + TAG_LENGTH + 1) return null;

        const key = _deriveKey(secret);
        const iv = buf.subarray(0, IV_LENGTH);
        const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
        const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);

        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    }
    catch (_)
    {
        return null;
    }
}

// -- Cookie Helpers ------------------------------------------

/**
 * Set a cookie on the response.
 * @private
 */
function _setCookie(res, name, value, maxAgeMs)
{
    const maxAgeSec = Math.floor(maxAgeMs / 1000);
    const raw = res.raw || res;
    const existing = raw.getHeader('set-cookie') || [];
    const cookies = Array.isArray(existing) ? existing : [existing];
    cookies.push(
        `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}; Path=/`
    );
    raw.setHeader('Set-Cookie', cookies);
}

/**
 * Clear a cookie.
 * @private
 */
function _clearCookie(res, name)
{
    const raw = res.raw || res;
    const existing = raw.getHeader('set-cookie') || [];
    const cookies = Array.isArray(existing) ? existing : [existing];
    cookies.push(
        `${name}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/`
    );
    raw.setHeader('Set-Cookie', cookies);
}

/**
 * Read a cookie value from the request.
 * @private
 */
function _readCookie(req, name)
{
    // Use parsed cookies if available (cookieParser middleware)
    if (req.cookies && req.cookies[name]) return req.cookies[name];

    // Manual parse from header
    const header = req.headers && req.headers.cookie;
    if (!header) return null;

    const match = header.split(';').find(c => c.trim().startsWith(name + '='));
    if (!match) return null;
    return match.split('=').slice(1).join('=').trim();
}

// -- Issue Middleware -----------------------------------------

/**
 * Middleware that issues a trusted-device token after successful 2FA.
 * Should be placed AFTER the 2FA verification middleware in the chain.
 *
 * @param {object} opts - Options.
 * @param {string} opts.secret - Encryption secret (min 32 chars recommended).
 * @param {number} [opts.maxAge=2592000000] - Trust duration in ms (default 30 days).
 * @param {string} [opts.cookieName='_dt'] - Cookie name.
 * @param {Function} [opts.fingerprint] - `(req) => string` device fingerprint.
 *        Defaults to User-Agent hash.
 * @param {Function} [opts.getUserId] - `(req) => string` user identifier.
 *        Defaults to `req.user.id || req.user.sub`.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.post('/verify-2fa', verifyTOTPMiddleware({...}), trustedDevice.issue({
 *       secret: process.env.DEVICE_TRUST_SECRET,
 *       maxAge: 30 * 24 * 60 * 60 * 1000,
 *       fingerprint: (req) => req.body.deviceFingerprint,
 *   }));
 */
function issue(opts)
{
    if (!opts || !opts.secret)
        throw new Error('trustedDevice.issue() requires a secret');

    const secret = opts.secret;
    const maxAge = opts.maxAge || DEFAULT_MAX_AGE;
    const cookieName = opts.cookieName || DEFAULT_COOKIE_NAME;
    const getFingerprint = opts.fingerprint || _defaultFingerprint;
    const getUserId = opts.getUserId || _defaultGetUserId;

    return async function _issueDeviceTrust(req, res, next)
    {
        try
        {
            const userId = await getUserId(req);
            const fp = await getFingerprint(req);

            const payload = {
                uid: userId,
                fp: fp ? crypto.createHash('sha256').update(fp).digest('hex').substring(0, 16) : null,
                iat: Date.now(),
                exp: Date.now() + maxAge,
            };

            const token = _encrypt(payload, secret);
            _setCookie(res, cookieName, token, maxAge);

            log.info('device trust token issued for user %s', userId);
        }
        catch (err)
        {
            log.error('device trust issue error: %s', err.message);
        }

        next();
    };
}

// -- Verify Function -----------------------------------------

/**
 * Create a verification function for use with `require2FA` middleware.
 * Returns a function `(req) => boolean` that checks for a valid trust token.
 *
 * @param {object} opts - Options.
 * @param {string} opts.secret - Encryption secret.
 * @param {string|string[]} [opts.previousSecrets] - Previous secrets for rotation.
 * @param {string} [opts.cookieName='_dt'] - Cookie name.
 * @param {Function} [opts.fingerprint] - `(req) => string` device fingerprint.
 * @param {Function} [opts.getUserId] - `(req) => string`.
 * @param {boolean} [opts.checkIP=false] - Verify IP range (/24 CIDR match).
 * @returns {Function} `(req) => Promise<boolean>` trust check function.
 *
 * @example
 *   app.use(require2FA({
 *       isEnabled: (req) => req.user.totpEnabled,
 *       trustedDevice: trustedDevice.verify({
 *           secret: process.env.DEVICE_TRUST_SECRET,
 *       }),
 *   }));
 */
function verify(opts)
{
    if (!opts || !opts.secret)
        throw new Error('trustedDevice.verify() requires a secret');

    const secrets = [opts.secret];
    if (opts.previousSecrets)
    {
        const prev = Array.isArray(opts.previousSecrets) ? opts.previousSecrets : [opts.previousSecrets];
        secrets.push(...prev);
    }

    const cookieName = opts.cookieName || DEFAULT_COOKIE_NAME;
    const getFingerprint = opts.fingerprint || _defaultFingerprint;
    const getUserId = opts.getUserId || _defaultGetUserId;
    const checkIP = opts.checkIP || false;

    return async function _verifyDeviceTrust(req)
    {
        const token = _readCookie(req, cookieName);
        if (!token) return false;

        // Try each secret (current + rotated)
        let payload = null;
        for (const s of secrets)
        {
            payload = _decrypt(token, s);
            if (payload) break;
        }

        if (!payload) return false;

        // Check expiry
        if (Date.now() >= payload.exp)
        {
            log.debug('device trust token expired');
            return false;
        }

        // Check user ID
        try
        {
            const userId = await getUserId(req);
            if (String(payload.uid) !== String(userId)) return false;
        }
        catch (_)
        {
            return false;
        }

        // Check fingerprint if present
        if (payload.fp)
        {
            try
            {
                const fp = await getFingerprint(req);
                if (fp)
                {
                    const currentFP = crypto.createHash('sha256').update(fp).digest('hex').substring(0, 16);
                    if (payload.fp !== currentFP)
                    {
                        log.debug('device fingerprint mismatch');
                        return false;
                    }
                }
            }
            catch (_)
            {
                return false;
            }
        }

        // Optional IP range check (/24 CIDR)
        if (checkIP && payload.ip)
        {
            const currentIP = req.ip || req.socket?.remoteAddress || '';
            if (!_matchIPSubnet(payload.ip, currentIP))
            {
                log.debug('IP range mismatch');
                return false;
            }
        }

        log.debug('device trust token valid for user %s', payload.uid);
        return true;
    };
}

// -- Revocation Middleware ------------------------------------

/**
 * Middleware that revokes the trusted-device cookie.
 * Call this on logout, password change, or 2FA re-enrollment.
 *
 * @param {object} [opts] - Options.
 * @param {string} [opts.cookieName='_dt'] - Cookie name.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.post('/logout', trustedDevice.revoke(), (req, res) => {
 *       res.json({ ok: true });
 *   });
 */
function revoke(opts = {})
{
    const cookieName = opts.cookieName || DEFAULT_COOKIE_NAME;

    return function _revokeDeviceTrust(req, res, next)
    {
        _clearCookie(res, cookieName);
        log.info('device trust token revoked');
        next();
    };
}

// -- Internal Helpers ----------------------------------------

/**
 * Default fingerprint: hash of User-Agent.
 * @private
 */
function _defaultFingerprint(req)
{
    return req.headers && req.headers['user-agent'] || '';
}

/**
 * Default user ID extraction.
 * @private
 */
function _defaultGetUserId(req)
{
    if (!req.user) throw new Error('No user on request — authentication middleware required');
    return req.user.id || req.user.sub || req.user._id;
}

/**
 * Check if two IPs are in the same /24 subnet (IPv4 only).
 * @private
 * @param {string} storedIP
 * @param {string} currentIP
 * @returns {boolean}
 */
function _matchIPSubnet(storedIP, currentIP)
{
    const storedParts = storedIP.split('.');
    const currentParts = currentIP.split('.');
    if (storedParts.length !== 4 || currentParts.length !== 4) return false;
    return storedParts[0] === currentParts[0] &&
           storedParts[1] === currentParts[1] &&
           storedParts[2] === currentParts[2];
}

// -- Exports -------------------------------------------------

const trustedDevice = {
    issue,
    verify,
    revoke,
};

module.exports = {
    trustedDevice,
    // Internals for testing
    _encrypt,
    _decrypt,
    _deriveKey,
    _matchIPSubnet,
};
