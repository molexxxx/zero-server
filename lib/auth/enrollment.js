/**
 * @module auth/enrollment
 * @description 2FA Enrollment Flow Helper.
 *              Provides a session-scoped, multi-step enrollment workflow
 *              for TOTP-based two-factor authentication.
 *
 *              Steps:
 *              1. `start()` — Generate secret + backup codes, store in session
 *              2. `verify()` — Confirm user can produce a valid TOTP code
 *              3. `complete()` — Persist the verified secret to the database
 *              4. `disable()` — Remove 2FA from the account
 *
 * @example | Full enrollment flow
 *   const { enrollment } = require('zero-http');
 *   const flow = enrollment({
 *       saveSecret: async (req, secret, backupHashes) => {
 *           await db.users.update(req.user.id, { totpSecret: secret, backupHashes });
 *       },
 *       removeSecret: async (req) => {
 *           await db.users.update(req.user.id, { totpSecret: null, backupHashes: [] });
 *       },
 *   });
 *
 *   app.post('/2fa/start',    json(), flow.start());
 *   app.post('/2fa/verify',   json(), flow.verify());
 *   app.post('/2fa/complete', json(), flow.complete());
 *   app.post('/2fa/disable',  json(), flow.disable());
 */

const log = require('../debug')('zero:enrollment');

// Lazy-load twoFactor to avoid circular deps at module level
let _twoFactor = null;
function _getTwoFactor()
{
    if (!_twoFactor) _twoFactor = require('./twoFactor');
    return _twoFactor;
}

// -- Constants ---------------------------------------------------

const DEFAULT_SESSION_KEY = '_2faEnrollment';
const DEFAULT_ENROLLMENT_TTL = 10 * 60 * 1000; // 10 minutes

// -- Enrollment Factory ------------------------------------------

/**
 * Create a 2FA enrollment flow bound to your persistence callbacks.
 *
 * @param {object} opts - Options.
 * @param {Function} opts.saveSecret - `(req, base32Secret, backupHashes) => Promise<void>`.
 *        Persist the verified TOTP secret and backup hashes.
 * @param {Function} opts.removeSecret - `(req) => Promise<void>`.
 *        Remove TOTP secret on disable.
 * @param {string} [opts.issuer='App'] - Issuer name for the otpauth URI.
 * @param {Function} [opts.getAccount] - `(req) => string`. User label for QR code.
 *        Defaults to `req.user.email || req.user.id`.
 * @param {string} [opts.sessionKey='_2faEnrollment'] - Session key for pending enrollment.
 * @param {number} [opts.ttl=600000] - Enrollment session TTL in ms (default 10 min).
 * @param {number} [opts.backupCount=10] - Number of backup codes to generate.
 * @param {number} [opts.window=1] - TOTP verification window.
 * @param {number} [opts.period=30] - TOTP period in seconds.
 * @param {string} [opts.algorithm='sha1'] - HMAC algorithm.
 * @param {number} [opts.digits=6] - Code length.
 * @param {Function} [opts.isEnabled] - `(req) => boolean|Promise<boolean>`.
 *        Check if 2FA is already enabled (for guarding start/disable).
 * @returns {{ start: Function, verify: Function, complete: Function, disable: Function }}
 */
function enrollment(opts = {})
{
    if (typeof opts.saveSecret !== 'function')
        throw new Error('enrollment() requires a saveSecret(req, secret, backupHashes) function');
    if (typeof opts.removeSecret !== 'function')
        throw new Error('enrollment() requires a removeSecret(req) function');

    const issuer = opts.issuer || 'App';
    const getAccount = opts.getAccount || _defaultGetAccount;
    const sessionKey = opts.sessionKey || DEFAULT_SESSION_KEY;
    const ttl = opts.ttl || DEFAULT_ENROLLMENT_TTL;
    const backupCount = opts.backupCount || 10;
    const window = opts.window != null ? opts.window : 1;
    const period = opts.period || 30;
    const algorithm = opts.algorithm || 'sha1';
    const digits = opts.digits || 6;
    const isEnabled = opts.isEnabled || null;

    function _sendJson(res, status, body)
    {
        const raw = res.raw || res;
        if (raw.headersSent) return;
        raw.statusCode = status;
        raw.setHeader('Content-Type', 'application/json');
        raw.end(JSON.stringify(body));
    }

    function _requireSession(req, res)
    {
        if (!req.session || typeof req.session.set !== 'function')
        {
            _sendJson(res, 500, { error: 'Session middleware required for 2FA enrollment' });
            return false;
        }
        return true;
    }

    // ---- start() ----

    /**
     * Start the enrollment process.
     * Generates a TOTP secret and backup codes, stores them in the session,
     * and returns the otpauth URI (for QR code) plus backup codes to the client.
     *
     * @returns {Function} Middleware `(req, res) => void`.
     */
    function start()
    {
        return async function _enrollmentStart(req, res)
        {
            if (!_requireSession(req, res)) return;

            // Guard: if 2FA is already enabled
            if (typeof isEnabled === 'function')
            {
                try
                {
                    const enabled = await isEnabled(req);
                    if (enabled)
                    {
                        _sendJson(res, 409, { error: '2FA is already enabled. Disable it first.' });
                        return;
                    }
                }
                catch (err)
                {
                    log.error('isEnabled check error: %s', err.message);
                    _sendJson(res, 500, { error: 'Internal server error' });
                    return;
                }
            }

            const tf = _getTwoFactor();

            const secret = tf.generateSecret();
            let account;
            try
            {
                account = await getAccount(req);
            }
            catch (err)
            {
                log.error('getAccount error: %s', err.message);
                _sendJson(res, 500, { error: 'Internal server error' });
                return;
            }

            const uri = tf.otpauthURI({ secret: secret.base32, issuer, account });
            const { codes, hashes } = tf.generateBackupCodes(backupCount);

            // Store pending enrollment in session
            req.session.set(sessionKey, {
                secret: secret.base32,
                backupHashes: hashes,
                createdAt: Date.now(),
            });

            log.info('enrollment started for %s', account);

            _sendJson(res, 200, {
                secret: secret.base32,
                uri,
                backupCodes: codes,
                expiresIn: Math.floor(ttl / 1000),
            });
        };
    }

    // ---- verify() ----

    /**
     * Verify that the user can produce a valid TOTP code with the pending secret.
     * This confirms their authenticator app is configured correctly.
     *
     * @param {object} [verifyOpts] - Options.
     * @param {string} [verifyOpts.codeField='code'] - Body field for the TOTP code.
     * @returns {Function} Middleware `(req, res) => void`.
     */
    function verify(verifyOpts = {})
    {
        const codeField = verifyOpts.codeField || 'code';

        return async function _enrollmentVerify(req, res)
        {
            if (!_requireSession(req, res)) return;

            const pending = req.session.get(sessionKey);
            if (!pending || !pending.secret)
            {
                _sendJson(res, 400, { error: 'No pending enrollment. Call start() first.' });
                return;
            }

            // Check TTL
            if (Date.now() - pending.createdAt > ttl)
            {
                req.session.set(sessionKey, null);
                _sendJson(res, 410, { error: 'Enrollment expired. Please start again.' });
                return;
            }

            const code = req.body?.[codeField];
            if (!code || typeof code !== 'string')
            {
                _sendJson(res, 400, { error: `Missing ${codeField} field` });
                return;
            }

            const tf = _getTwoFactor();
            const result = tf.verifyTOTP(code, pending.secret, { window, period, algorithm, digits });

            if (!result.valid)
            {
                _sendJson(res, 401, { error: 'Invalid code. Check your authenticator app and try again.' });
                return;
            }

            // Mark as verified in session
            pending.verified = true;
            req.session.set(sessionKey, pending);

            log.info('enrollment code verified (delta=%d)', result.delta);

            _sendJson(res, 200, { verified: true });
        };
    }

    // ---- complete() ----

    /**
     * Complete the enrollment by persisting the verified secret.
     * Only succeeds if `verify()` was called first.
     *
     * @returns {Function} Middleware `(req, res) => void`.
     */
    function complete()
    {
        return async function _enrollmentComplete(req, res)
        {
            if (!_requireSession(req, res)) return;

            const pending = req.session.get(sessionKey);
            if (!pending || !pending.secret)
            {
                _sendJson(res, 400, { error: 'No pending enrollment.' });
                return;
            }

            if (!pending.verified)
            {
                _sendJson(res, 400, { error: 'Enrollment not yet verified. Call verify() first.' });
                return;
            }

            // Check TTL
            if (Date.now() - pending.createdAt > ttl)
            {
                req.session.set(sessionKey, null);
                _sendJson(res, 410, { error: 'Enrollment expired. Please start again.' });
                return;
            }

            try
            {
                await opts.saveSecret(req, pending.secret, pending.backupHashes);
            }
            catch (err)
            {
                log.error('saveSecret error: %s', err.message);
                _sendJson(res, 500, { error: 'Failed to save 2FA configuration' });
                return;
            }

            // Clear pending enrollment
            req.session.set(sessionKey, null);

            // Mark 2FA as verified in session so require2FA() passes
            req.session.set('twoFactorVerified', true);

            log.info('enrollment completed successfully');

            _sendJson(res, 200, { enabled: true });
        };
    }

    // ---- disable() ----

    /**
     * Disable 2FA for the user.
     * Optionally requires current TOTP code or password confirmation.
     *
     * @param {object} [disableOpts] - Options.
     * @param {Function} [disableOpts.confirm] - `(req) => boolean|Promise<boolean>`.
     *        If provided, must return `true` to allow disable (e.g. validate password).
     * @returns {Function} Middleware `(req, res) => void`.
     */
    function disable(disableOpts = {})
    {
        return async function _enrollmentDisable(req, res)
        {
            if (!_requireSession(req, res)) return;

            // Confirmation check
            if (typeof disableOpts.confirm === 'function')
            {
                try
                {
                    const ok = await disableOpts.confirm(req);
                    if (!ok)
                    {
                        _sendJson(res, 403, { error: 'Confirmation failed' });
                        return;
                    }
                }
                catch (err)
                {
                    log.error('disable confirm error: %s', err.message);
                    _sendJson(res, 500, { error: 'Internal server error' });
                    return;
                }
            }

            try
            {
                await opts.removeSecret(req);
            }
            catch (err)
            {
                log.error('removeSecret error: %s', err.message);
                _sendJson(res, 500, { error: 'Failed to remove 2FA configuration' });
                return;
            }

            // Clear enrollment and 2FA session state
            req.session.set(sessionKey, null);
            req.session.set('twoFactorVerified', false);

            log.info('2FA disabled');

            _sendJson(res, 200, { disabled: true });
        };
    }

    return { start, verify, complete, disable };
}

// -- Helpers -------------------------------------------------

function _defaultGetAccount(req)
{
    if (!req.user) throw new Error('No user on request — authentication middleware required');
    return req.user.email || req.user.id || req.user.sub;
}

// -- Exports -------------------------------------------------

module.exports = {
    enrollment,
};
