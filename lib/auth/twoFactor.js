/**
 * @module auth/twoFactor
 * @description Zero-dependency Two-Factor Authentication (2FA) module.
 *              Implements TOTP (RFC 6238 / RFC 4226), backup codes,
 *              and composable middleware for step-up verification.
 *
 *              Uses only Node.js built-in `crypto` — no external packages.
 *
 * @example | Setup 2FA for a user
 *   const { twoFactor } = require('zero-http');
 *
 *   app.post('/2fa/setup', async (req, res) => {
 *       const secret = twoFactor.generateSecret();
 *       const uri    = twoFactor.otpauthURI({ secret, issuer: 'MyApp', account: req.user.email });
 *       // Store secret.base32 in your database (encrypted)
 *       res.json({ secret: secret.base32, uri });
 *   });
 *
 * @example | Verify a TOTP code
 *   app.post('/2fa/verify', async (req, res) => {
 *       const user  = await db.users.findById(req.user.sub);
 *       const valid = twoFactor.verifyTOTP(req.body.code, user.totpSecret);
 *       if (!valid) return res.status(401).json({ error: 'Invalid code' });
 *       req.session.set('twoFactorVerified', true);
 *       res.json({ ok: true });
 *   });
 *
 * @example | Protect routes with 2FA middleware
 *   app.use('/admin', twoFactor.require2FA(), adminRouter);
 *
 * @example | Generate and redeem backup codes
 *   const { codes, hashes } = twoFactor.generateBackupCodes(10);
 *   // Store hashes in DB; give codes to user once
 *   const ok = await twoFactor.verifyBackupCode(inputCode, storedHashes);
 */
const crypto = require('crypto');
const log = require('../debug')('zero:2fa');

// -- Constants ---------------------------------------------------

/** Default TOTP period in seconds. */
const DEFAULT_PERIOD = 30;

/** Default TOTP code length in digits. */
const DEFAULT_DIGITS = 6;

/** Default HMAC algorithm. */
const DEFAULT_ALGORITHM = 'sha1';

/** Default time-step window for clock drift (±1 step). */
const DEFAULT_WINDOW = 1;

// -- TOTP Replay Prevention (RFC 6238 §5.2) ----------------------

/**
 * In-memory replay store for TOTP counter tracking.
 * Prevents code reuse within the validity window by storing the last-used
 * time-step counter per user. Implements TTL-based eviction.
 *
 * For distributed deployments, implement the same interface backed by Redis or a database.
 *
 * @class
 *
 * @example
 *   const store = new InMemoryReplayStore();
 *   app.post('/verify', verifyTOTPMiddleware({
 *       replayStore: store,
 *       getUserId: (req) => req.user.id,
 *       getSecret: (req) => req.user.totpSecret,
 *   }));
 */
class InMemoryReplayStore
{
    constructor()
    {
        /** @private @type {Map<string, { counter: number, expires: number }>} */
        this._store = new Map();

        /** @private - Periodic pruning every 60 seconds */
        this._pruneTimer = setInterval(() =>
        {
            const now = Date.now();
            for (const [key, entry] of this._store)
            {
                if (now >= entry.expires) this._store.delete(key);
            }
        }, 60000);
        if (this._pruneTimer.unref) this._pruneTimer.unref();
    }

    /**
     * Get the last-used counter for a user.
     *
     * @param {string} userId - User identifier.
     * @returns {Promise<number|null>} Last-used counter or null.
     */
    async get(userId)
    {
        const entry = this._store.get(userId);
        if (!entry) return null;
        if (Date.now() >= entry.expires)
        {
            this._store.delete(userId);
            return null;
        }
        return entry.counter;
    }

    /**
     * Store the last-used counter for a user with a TTL.
     *
     * @param {string} userId - User identifier.
     * @param {number} counter - The time-step counter that was used.
     * @param {number} ttlMs - Time-to-live in milliseconds.
     * @returns {Promise<void>}
     */
    async set(userId, counter, ttlMs)
    {
        this._store.set(userId, {
            counter,
            expires: Date.now() + ttlMs,
        });
    }

    /**
     * Clear all stored counters (for testing or user revocation).
     */
    clear()
    {
        this._store.clear();
    }

    /**
     * Destroy the store and stop periodic pruning.
     */
    destroy()
    {
        clearInterval(this._pruneTimer);
        this._store.clear();
    }
}

// -- Remaining Constants -----------------------------------------

/** Number of bytes for secret generation (20 bytes = 160-bit per RFC 4226). */
const SECRET_BYTES = 20;

/** Number of bytes for backup code entropy. */
const BACKUP_CODE_BYTES = 4;

/** Default backup code count. */
const DEFAULT_BACKUP_COUNT = 10;

/** Supported HMAC algorithms for TOTP. */
const SUPPORTED_TOTP_ALGORITHMS = ['sha1', 'sha256', 'sha512'];

// -- Base32 Encoder/Decoder (RFC 4648) ---------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a Buffer to Base32 (RFC 4648) without padding.
 *
 * @param {Buffer} buf - Data to encode.
 * @returns {string} Base32-encoded string (uppercase, no padding).
 * @private
 */
function _base32Encode(buf)
{
    let bits = 0;
    let value = 0;
    let out = '';

    for (let i = 0; i < buf.length; i++)
    {
        value = (value << 8) | buf[i];
        bits += 8;

        while (bits >= 5)
        {
            bits -= 5;
            out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
        }
    }

    if (bits > 0)
    {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }

    return out;
}

/**
 * Decode a Base32 string (RFC 4648) to a Buffer.
 * Tolerates lowercase, whitespace, and missing padding.
 *
 * @param {string} str - Base32-encoded string.
 * @returns {Buffer} Decoded bytes.
 * @private
 */
function _base32Decode(str)
{
    const cleaned = str.replace(/[\s=]/g, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const bytes = [];

    for (let i = 0; i < cleaned.length; i++)
    {
        const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
        if (idx === -1) throw new Error(`Invalid Base32 character: ${cleaned[i]}`);

        value = (value << 5) | idx;
        bits += 5;

        if (bits >= 8)
        {
            bits -= 8;
            bytes.push((value >>> bits) & 0xff);
        }
    }

    return Buffer.from(bytes);
}

// -- HOTP (RFC 4226) Core ----------------------------------------

/**
 * Generate an HOTP code for a given counter value.
 * Implements RFC 4226 §5 — HMAC-based One-Time Password.
 *
 * @param {Buffer} secret - Shared secret key.
 * @param {number} counter - 8-byte counter value.
 * @param {object} [opts] - Options.
 * @param {number} [opts.digits=6] - Code length (6 or 8).
 * @param {string} [opts.algorithm='sha1'] - HMAC algorithm.
 * @returns {string} Zero-padded OTP code.
 * @private
 */
function _generateHOTP(secret, counter, opts = {})
{
    const digits = opts.digits || DEFAULT_DIGITS;
    const algorithm = opts.algorithm || DEFAULT_ALGORITHM;

    // Counter as 8-byte big-endian buffer
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter));

    // HMAC
    const hmac = crypto.createHmac(algorithm, secret);
    hmac.update(counterBuf);
    const digest = hmac.digest();

    // Dynamic truncation (RFC 4226 §5.4)
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff);

    const otp = binary % Math.pow(10, digits);
    return otp.toString().padStart(digits, '0');
}

// -- TOTP (RFC 6238) Functions -----------------------------------

/**
 * Generate a cryptographically random TOTP secret.
 *
 * @param {number} [bytes=20] - Number of random bytes (default 20 = 160-bit, per RFC 4226).
 * @returns {{ raw: Buffer, base32: string, hex: string }} Secret in multiple formats.
 *
 * @example
 *   const secret = generateSecret();
 *   console.log(secret.base32); // "JBSWY3DPEHPK3PXP..."
 *   // Store secret.base32 in database (encrypted at rest)
 */
function generateSecret(bytes)
{
    const len = bytes || SECRET_BYTES;
    const raw = crypto.randomBytes(len);

    return {
        raw,
        base32: _base32Encode(raw),
        hex: raw.toString('hex'),
    };
}

/**
 * Generate a TOTP code for the current (or given) time.
 *
 * @param {string|Buffer} secret - Base32-encoded string or raw Buffer.
 * @param {object} [opts] - Options.
 * @param {number} [opts.period=30] - Time step in seconds.
 * @param {number} [opts.digits=6] - Code length.
 * @param {string} [opts.algorithm='sha1'] - HMAC algorithm (sha1, sha256, sha512).
 * @param {number} [opts.time] - Unix timestamp in seconds (defaults to now).
 * @returns {string} TOTP code string.
 *
 * @example
 *   const code = generateTOTP('JBSWY3DPEHPK3PXP');
 *   // '482913'
 *
 * @example | Custom period and algorithm
 *   const code = generateTOTP(secret, { period: 60, algorithm: 'sha256', digits: 8 });
 */
function generateTOTP(secret, opts = {})
{
    const period = opts.period || DEFAULT_PERIOD;
    const algorithm = opts.algorithm || DEFAULT_ALGORITHM;
    const digits = opts.digits || DEFAULT_DIGITS;
    const time = opts.time != null ? opts.time : Math.floor(Date.now() / 1000);

    if (!SUPPORTED_TOTP_ALGORITHMS.includes(algorithm))
        throw new Error(`Unsupported algorithm: ${algorithm}. Use: ${SUPPORTED_TOTP_ALGORITHMS.join(', ')}`);

    const secretBuf = Buffer.isBuffer(secret) ? secret : _base32Decode(secret);
    const counter = Math.floor(time / period);

    return _generateHOTP(secretBuf, counter, { digits, algorithm });
}

/**
 * Verify a user-supplied TOTP code against a shared secret.
 * Checks within a configurable time-step window to handle clock drift.
 *
 * @param {string} token - The 6/8-digit code submitted by the user.
 * @param {string|Buffer} secret - Base32-encoded string or raw Buffer.
 * @param {object} [opts] - Options.
 * @param {number} [opts.period=30] - Time step in seconds.
 * @param {number} [opts.digits=6] - Expected code length.
 * @param {string} [opts.algorithm='sha1'] - HMAC algorithm.
 * @param {number} [opts.window=1] - Number of periods to check before/after current.
 * @param {number} [opts.time] - Unix timestamp override (seconds).
 * @returns {{ valid: boolean, delta: number|null }} Result with timing delta.
 *
 * @example
 *   const result = verifyTOTP('482913', userSecret);
 *   if (result.valid) console.log('Authenticated!', result.delta);
 *
 * @example | Wider window for unreliable clocks
 *   const result = verifyTOTP(code, secret, { window: 2 });
 */
function verifyTOTP(token, secret, opts = {})
{
    const period = opts.period || DEFAULT_PERIOD;
    const algorithm = opts.algorithm || DEFAULT_ALGORITHM;
    const digits = opts.digits || DEFAULT_DIGITS;
    const window = opts.window != null ? opts.window : DEFAULT_WINDOW;
    const time = opts.time != null ? opts.time : Math.floor(Date.now() / 1000);

    if (typeof token !== 'string' || token.length !== digits || !/^\d+$/.test(token))
        return { valid: false, delta: null };

    const secretBuf = Buffer.isBuffer(secret) ? secret : _base32Decode(secret);
    const currentCounter = Math.floor(time / period);

    for (let i = -window; i <= window; i++)
    {
        const candidate = _generateHOTP(secretBuf, currentCounter + i, { digits, algorithm });

        // Constant-time comparison to prevent timing attacks
        if (candidate.length === token.length &&
            crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token)))
        {
            log.info('TOTP verified (delta=%d)', i);
            return { valid: true, delta: i };
        }
    }

    log.warn('TOTP verification failed');
    return { valid: false, delta: null };
}

// -- OTPAuth URI --------------------------------------------------

/**
 * Generate an `otpauth://` URI for QR code enrollment.
 * Compatible with Google Authenticator, Authy, 1Password, etc.
 *
 * @param {object} opts - URI options.
 * @param {string|Buffer} opts.secret - Base32-encoded secret or raw Buffer.
 * @param {string} opts.issuer - Application/company name (e.g. "MyApp").
 * @param {string} opts.account - User identifier (e.g. email).
 * @param {number} [opts.period=30] - Time step in seconds.
 * @param {number} [opts.digits=6] - Code length.
 * @param {string} [opts.algorithm='sha1'] - HMAC algorithm.
 * @returns {string} `otpauth://totp/...` URI string.
 *
 * @example
 *   const uri = otpauthURI({
 *       secret: 'JBSWY3DPEHPK3PXP',
 *       issuer: 'MyApp',
 *       account: 'user@example.com',
 *   });
 *   // "otpauth://totp/MyApp:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=MyApp&algorithm=SHA1&digits=6&period=30"
 */
function otpauthURI(opts)
{
    if (!opts || !opts.secret || !opts.issuer || !opts.account)
        throw new Error('otpauthURI requires secret, issuer, and account');

    const secret = Buffer.isBuffer(opts.secret) ? _base32Encode(opts.secret) : opts.secret;
    const algorithm = (opts.algorithm || DEFAULT_ALGORITHM).toUpperCase();
    const digits = opts.digits || DEFAULT_DIGITS;
    const period = opts.period || DEFAULT_PERIOD;

    const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
    const params = new URLSearchParams({
        secret,
        issuer: opts.issuer,
        algorithm: algorithm === 'SHA1' ? 'SHA1' : algorithm,
        digits: String(digits),
        period: String(period),
    });

    return `otpauth://totp/${label}?${params.toString()}`;
}

// -- Backup Codes ------------------------------------------------

/**
 * Generate a set of single-use backup/recovery codes.
 * Returns both the plaintext codes (show once to user) and
 * SHA-256 hashes (store in database).
 *
 * @param {number} [count=10] - Number of codes to generate.
 * @param {number} [bytes=4] - Random bytes per code (4 bytes → 8 hex chars).
 * @returns {{ codes: string[], hashes: string[] }} Plaintext and hashed codes.
 *
 * @example
 *   const { codes, hashes } = generateBackupCodes(10);
 *   // Show codes to user once: ['a1b2c3d4', 'e5f6a7b8', ...]
 *   // Store hashes in DB:      ['sha256hex...', ...]
 */
function generateBackupCodes(count, bytes)
{
    const n = count || DEFAULT_BACKUP_COUNT;
    const b = bytes || BACKUP_CODE_BYTES;
    const codes = [];
    const hashes = [];

    for (let i = 0; i < n; i++)
    {
        const code = crypto.randomBytes(b).toString('hex');
        codes.push(code);
        hashes.push(crypto.createHash('sha256').update(code).digest('hex'));
    }

    log.info('generated %d backup codes', n);
    return { codes, hashes };
}

/**
 * Verify a backup code against stored hashes.
 * On match, returns the index so the caller can remove/mark it as used.
 *
 * @param {string} code - User-supplied backup code.
 * @param {string[]} hashes - Array of SHA-256 hex hashes stored in DB.
 * @returns {{ valid: boolean, index: number|null }} Match result with index.
 *
 * @example
 *   const result = verifyBackupCode('a1b2c3d4', storedHashes);
 *   if (result.valid) {
 *       storedHashes.splice(result.index, 1); // Remove used code
 *       await user.save();
 *   }
 */
function verifyBackupCode(code, hashes)
{
    if (typeof code !== 'string' || !code.length || !Array.isArray(hashes))
        return { valid: false, index: null };

    const inputHash = crypto.createHash('sha256').update(code).digest('hex');
    const inputBuf = Buffer.from(inputHash, 'hex');

    for (let i = 0; i < hashes.length; i++)
    {
        const storedBuf = Buffer.from(hashes[i], 'hex');

        // Constant-time comparison
        if (inputBuf.length === storedBuf.length &&
            crypto.timingSafeEqual(inputBuf, storedBuf))
        {
            log.info('backup code redeemed (index=%d)', i);
            return { valid: true, index: i };
        }
    }

    log.warn('backup code verification failed');
    return { valid: false, index: null };
}

// -- Middleware ---------------------------------------------------

/**
 * Middleware that requires completed 2FA verification on the session.
 * Checks `req.session.get('twoFactorVerified')` — returns 403 if not set.
 *
 * Designed to compose with `jwt()` or `session()` middleware:
 *
 *     app.use(jwt({ secret }));
 *     app.use(require2FA());
 *     // — or —
 *     app.use(session({ secret }));
 *     app.use(require2FA());
 *
 * @param {object} [opts] - Options.
 * @param {string} [opts.sessionKey='twoFactorVerified'] - Session key to check.
 * @param {string} [opts.errorMessage='Two-factor authentication required'] - Error body.
 * @param {number} [opts.statusCode=403] - HTTP status code on failure.
 * @param {Function} [opts.isEnabled] - `(req) => boolean|Promise<boolean>`.
 *        Return `false` to skip the 2FA check for users who haven't enrolled.
 *        Defaults to always requiring 2FA.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example | Basic — all authenticated users must complete 2FA
 *   app.use(require2FA());
 *
 * @example | Only enforce for users who have enrolled
 *   app.use(require2FA({
 *       isEnabled: async (req) => {
 *           const user = await db.users.findById(req.user.sub);
 *           return !!user.totpSecret;
 *       },
 *   }));
 *
 * @example | Custom session key
 *   app.use(require2FA({ sessionKey: 'mfaComplete' }));
 */
function require2FA(opts = {})
{
    const sessionKey = opts.sessionKey || 'twoFactorVerified';
    const errorMessage = opts.errorMessage || 'Two-factor authentication required';
    const statusCode = opts.statusCode || 403;
    const isEnabled = opts.isEnabled || null;

    return async function _require2FA(req, res, next)
    {
        // If user chose to only enforce for enrolled users
        if (typeof isEnabled === 'function')
        {
            try
            {
                const enabled = await isEnabled(req);
                if (!enabled)
                {
                    log('2FA not enabled for user — skipping');
                    return next();
                }
            }
            catch (err)
            {
                log.error('isEnabled callback error: %s', err.message);
                const raw = res.raw || res;
                if (raw.headersSent) return;
                raw.statusCode = 500;
                raw.setHeader('Content-Type', 'application/json');
                raw.end(JSON.stringify({ error: 'Internal server error' }));
                return;
            }
        }

        // Check session for 2FA completion
        const session = req.session;
        if (!session || typeof session.get !== 'function')
        {
            log.warn('require2FA: no session found — is session() middleware active?');
            const raw = res.raw || res;
            if (raw.headersSent) return;
            raw.statusCode = 500;
            raw.setHeader('Content-Type', 'application/json');
            raw.end(JSON.stringify({ error: 'Session middleware required for 2FA' }));
            return;
        }

        if (session.get(sessionKey))
        {
            log('2FA already verified for session %s', session.id);
            return next();
        }

        log.warn('2FA not completed — blocking request');
        const raw = res.raw || res;
        if (raw.headersSent) return;
        raw.statusCode = statusCode;
        raw.setHeader('Content-Type', 'application/json');
        raw.end(JSON.stringify({ error: errorMessage }));
    };
}

/**
 * Rate-limited TOTP verification middleware.
 * Wraps `verifyTOTP` with attempt tracking to prevent brute-force attacks.
 * Tracks attempts per-IP in memory with automatic expiry.
 *
 * Supports optional replay prevention (RFC 6238 §5.2) via a `replayStore`.
 * When configured, each successfully verified TOTP counter is recorded
 * and rejected on subsequent use within the validity window.
 *
 * @param {object} opts - Options.
 * @param {Function} opts.getSecret - `(req) => string|Buffer|Promise<string|Buffer>`.
 *        Retrieves the user's TOTP secret from your database.
 * @param {string} [opts.codeField='code'] - Request body field containing the code.
 * @param {string} [opts.sessionKey='twoFactorVerified'] - Session key to set on success.
 * @param {number} [opts.maxAttempts=5] - Max failed attempts before lockout.
 * @param {number} [opts.lockoutMs=900000] - Lockout duration in ms (default 15 min).
 * @param {number} [opts.window=1] - TOTP verification window.
 * @param {number} [opts.period=30] - TOTP period in seconds.
 * @param {string} [opts.algorithm='sha1'] - HMAC algorithm.
 * @param {number} [opts.digits=6] - Expected code length.
 * @param {object} [opts.replayStore] - Store for TOTP replay prevention.
 *        Must implement `get(userId): Promise<number|null>` and
 *        `set(userId, counter, ttlMs): Promise<void>`.
 * @param {Function} [opts.getUserId] - `(req) => string|Promise<string>`.
 *        Required when `replayStore` is set. Returns a unique user identifier.
 * @param {Function} [opts.onSuccess] - `(req, res) => void` called after verification.
 * @param {Function} [opts.onFailure] - `(req, res, attemptsLeft) => void` called on failure.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.post('/2fa/verify', json(), verifyTOTPMiddleware({
 *       getSecret: async (req) => {
 *           const user = await db.users.findById(req.user.sub);
 *           return user.totpSecret;
 *       },
 *   }));
 *
 * @example | With replay prevention
 *   app.post('/2fa/verify', json(), verifyTOTPMiddleware({
 *       getSecret: async (req) => req.user.totpSecret,
 *       getUserId: (req) => req.user.id,
 *       replayStore: new InMemoryReplayStore(),
 *   }));
 */
function verifyTOTPMiddleware(opts = {})
{
    if (typeof opts.getSecret !== 'function')
        throw new Error('verifyTOTPMiddleware requires a getSecret(req) function');

    if (opts.replayStore && typeof opts.getUserId !== 'function')
        throw new Error('verifyTOTPMiddleware requires getUserId(req) when replayStore is set');

    const codeField = opts.codeField || 'code';
    const sessionKey = opts.sessionKey || 'twoFactorVerified';
    const maxAttempts = opts.maxAttempts || 5;
    const lockoutMs = opts.lockoutMs || 900000;  // 15 min
    const window = opts.window != null ? opts.window : DEFAULT_WINDOW;
    const period = opts.period || DEFAULT_PERIOD;
    const algorithm = opts.algorithm || DEFAULT_ALGORITHM;
    const digits = opts.digits || DEFAULT_DIGITS;
    const onSuccess = opts.onSuccess || null;
    const onFailure = opts.onFailure || null;

    // In-memory attempt tracker (per-IP)
    const attempts = new Map();

    // Periodic cleanup of expired entries every 5 minutes
    const pruneTimer = setInterval(() =>
    {
        const now = Date.now();
        for (const [key, entry] of attempts)
        {
            if (now - entry.firstAttempt > lockoutMs) attempts.delete(key);
        }
    }, 300000);
    if (pruneTimer.unref) pruneTimer.unref();

    return async function _verifyTOTPMiddleware(req, res, next)
    {
        const raw = res.raw || res;
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';

        // Check lockout
        const record = attempts.get(ip);
        if (record && record.count >= maxAttempts)
        {
            const elapsed = Date.now() - record.firstAttempt;
            if (elapsed < lockoutMs)
            {
                const retryAfter = Math.ceil((lockoutMs - elapsed) / 1000);
                log.warn('2FA locked out for IP %s (%d seconds remaining)', ip, retryAfter);
                if (raw.headersSent) return;
                raw.statusCode = 429;
                raw.setHeader('Content-Type', 'application/json');
                raw.setHeader('Retry-After', String(retryAfter));
                raw.end(JSON.stringify({ error: 'Too many attempts. Try again later.', retryAfter }));
                return;
            }
            // Lockout expired — reset
            attempts.delete(ip);
        }

        // Extract code from body
        const code = req.body?.[codeField];
        if (!code || typeof code !== 'string')
        {
            if (raw.headersSent) return;
            raw.statusCode = 400;
            raw.setHeader('Content-Type', 'application/json');
            raw.end(JSON.stringify({ error: `Missing or invalid ${codeField} field` }));
            return;
        }

        // Retrieve user secret
        let secret;
        try
        {
            secret = await opts.getSecret(req);
        }
        catch (err)
        {
            log.error('getSecret error: %s', err.message);
            if (raw.headersSent) return;
            raw.statusCode = 500;
            raw.setHeader('Content-Type', 'application/json');
            raw.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }

        if (!secret)
        {
            if (raw.headersSent) return;
            raw.statusCode = 400;
            raw.setHeader('Content-Type', 'application/json');
            raw.end(JSON.stringify({ error: '2FA not configured for this account' }));
            return;
        }

        // Verify TOTP
        const result = verifyTOTP(code, secret, { window, period, algorithm, digits });

        if (result.valid)
        {
            // Replay prevention (RFC 6238 §5.2) — check AFTER signature
            // verification to avoid leaking timing information about whether
            // a code was previously used.
            if (opts.replayStore)
            {
                try
                {
                    const userId = await opts.getUserId(req);
                    const currentTime = Math.floor(Date.now() / 1000);
                    const usedCounter = Math.floor(currentTime / period) + result.delta;
                    const lastCounter = await opts.replayStore.get(userId);

                    if (lastCounter !== null && usedCounter <= lastCounter)
                    {
                        log.warn('TOTP replay detected for user %s (counter=%d, last=%d)', userId, usedCounter, lastCounter);

                        // Track as a failed attempt
                        const current = attempts.get(ip) || { count: 0, firstAttempt: Date.now() };
                        current.count++;
                        attempts.set(ip, current);

                        const remaining = maxAttempts - current.count;
                        if (typeof onFailure === 'function') { onFailure(req, res, remaining); return; }
                        if (raw.headersSent) return;
                        raw.statusCode = 401;
                        raw.setHeader('Content-Type', 'application/json');
                        raw.end(JSON.stringify({
                            error: 'Invalid verification code',
                            attemptsRemaining: Math.max(0, remaining),
                        }));
                        return;
                    }

                    // Store the used counter with TTL = period * (window + 1)
                    const ttl = period * (window + 1) * 1000;
                    await opts.replayStore.set(userId, usedCounter, ttl);
                }
                catch (err)
                {
                    log.error('replay store error: %s', err.message);
                    // Fail open for store errors — don't block legitimate users
                }
            }

            // Clear attempt counter on success
            attempts.delete(ip);

            // Mark session
            if (req.session && typeof req.session.set === 'function')
            {
                req.session.set(sessionKey, true);
            }

            log.info('2FA TOTP verified for IP %s (delta=%d)', ip, result.delta);

            if (typeof onSuccess === 'function') onSuccess(req, res);
            return next();
        }

        // Track failed attempt
        const current = attempts.get(ip) || { count: 0, firstAttempt: Date.now() };
        current.count++;
        attempts.set(ip, current);

        const remaining = maxAttempts - current.count;
        log.warn('2FA TOTP failed for IP %s (%d attempts remaining)', ip, remaining);

        if (typeof onFailure === 'function')
        {
            onFailure(req, res, remaining);
            return;
        }

        if (raw.headersSent) return;
        raw.statusCode = 401;
        raw.setHeader('Content-Type', 'application/json');
        raw.end(JSON.stringify({
            error: 'Invalid verification code',
            attemptsRemaining: Math.max(0, remaining),
        }));
    };
}

// -- Combined 2FA Verification Middleware -------------------------

/**
 * Combined verification middleware that auto-detects and handles TOTP codes,
 * backup codes, or WebAuthn/passkey assertions from a single endpoint.
 *
 * Detection logic (based on request body shape):
 * - `{ code: "123456" }` → TOTP verification
 * - `{ backupCode: "a1b2c3d4" }` → Backup code redemption
 * - `{ id, response: { authenticatorData, clientDataJSON, signature } }` → WebAuthn assertion
 *
 * Rate-limits across all methods using a shared per-IP attempt tracker.
 *
 * @param {object} opts - Options.
 * @param {Function} opts.getSecret - `(req) => string|Buffer|Promise<string|Buffer>`. TOTP secret.
 * @param {Function} opts.getBackupHashes - `(req) => string[]|Promise<string[]>`. Stored backup hashes.
 * @param {Function} [opts.onBackupUsed] - `(req, index) => void|Promise<void>`.
 *        Called when a backup code is redeemed so the caller can remove it.
 * @param {Function} [opts.getCredential] - `(req, credId) => object|Promise<object>`.
 *        Retrieves a stored WebAuthn credential by ID. Return `{ publicKey, counter, ... }`.
 * @param {Function} [opts.updateCredentialCounter] - `(req, credId, newCounter) => void|Promise<void>`.
 *        Persist the updated signature counter after WebAuthn verification.
 * @param {string} [opts.expectedOrigin] - Expected origin for WebAuthn (e.g. `'https://myapp.com'`).
 * @param {string} [opts.expectedRPID] - Expected relying party ID for WebAuthn.
 * @param {string} [opts.codeField='code'] - Body field for TOTP code.
 * @param {string} [opts.backupField='backupCode'] - Body field for backup code.
 * @param {string} [opts.sessionKey='twoFactorVerified'] - Session key to set on success.
 * @param {number} [opts.maxAttempts=5] - Max failed attempts before lockout.
 * @param {number} [opts.lockoutMs=900000] - Lockout duration in ms (default 15 min).
 * @param {number} [opts.window=1] - TOTP window.
 * @param {number} [opts.period=30] - TOTP period.
 * @param {string} [opts.algorithm='sha1'] - TOTP HMAC algorithm.
 * @param {number} [opts.digits=6] - TOTP code length.
 * @param {object} [opts.replayStore] - TOTP replay store.
 * @param {Function} [opts.getUserId] - `(req) => string`. Required with replayStore.
 * @param {Function} [opts.onSuccess] - `(req, res, method) => void`. Called on success with the method used.
 * @param {Function} [opts.onFailure] - `(req, res, attemptsLeft) => void`. Called on failure.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.post('/verify-2fa', json(), verify2FA({
 *       getSecret: (req) => req.user.totpSecret,
 *       getBackupHashes: (req) => req.user.backupHashes,
 *       onBackupUsed: async (req, index) => {
 *           req.user.backupHashes.splice(index, 1);
 *           await req.user.save();
 *       },
 *   }));
 */
function verify2FA(opts = {})
{
    if (typeof opts.getSecret !== 'function')
        throw new Error('verify2FA requires a getSecret(req) function');

    if (opts.replayStore && typeof opts.getUserId !== 'function')
        throw new Error('verify2FA requires getUserId(req) when replayStore is set');

    const codeField = opts.codeField || 'code';
    const backupField = opts.backupField || 'backupCode';
    const sessionKey = opts.sessionKey || 'twoFactorVerified';
    const maxAttempts = opts.maxAttempts || 5;
    const lockoutMs = opts.lockoutMs || 900000;
    const window = opts.window != null ? opts.window : DEFAULT_WINDOW;
    const period = opts.period || DEFAULT_PERIOD;
    const algorithm = opts.algorithm || DEFAULT_ALGORITHM;
    const digits = opts.digits || DEFAULT_DIGITS;
    const onSuccess = opts.onSuccess || null;
    const onFailure = opts.onFailure || null;

    // Shared per-IP attempt tracker
    const attempts = new Map();
    const pruneTimer = setInterval(() =>
    {
        const now = Date.now();
        for (const [key, entry] of attempts)
        {
            if (now - entry.firstAttempt > lockoutMs) attempts.delete(key);
        }
    }, 300000);
    if (pruneTimer.unref) pruneTimer.unref();

    function _sendJson(res, status, body)
    {
        const raw = res.raw || res;
        if (raw.headersSent) return;
        raw.statusCode = status;
        raw.setHeader('Content-Type', 'application/json');
        raw.end(JSON.stringify(body));
    }

    function _trackFailure(ip, res, onFail, req)
    {
        const current = attempts.get(ip) || { count: 0, firstAttempt: Date.now() };
        current.count++;
        attempts.set(ip, current);
        const remaining = maxAttempts - current.count;
        if (typeof onFail === 'function') { onFail(req, res, remaining); return true; }
        _sendJson(res, 401, { error: 'Invalid verification', attemptsRemaining: Math.max(0, remaining) });
        return true;
    }

    function _markSession(req)
    {
        if (req.session && typeof req.session.set === 'function')
        {
            req.session.set(sessionKey, true);
        }
    }

    return async function _verify2FA(req, res, next)
    {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';

        // Check lockout
        const record = attempts.get(ip);
        if (record && record.count >= maxAttempts)
        {
            const elapsed = Date.now() - record.firstAttempt;
            if (elapsed < lockoutMs)
            {
                const retryAfter = Math.ceil((lockoutMs - elapsed) / 1000);
                log.warn('verify2FA locked out IP %s (%ds remaining)', ip, retryAfter);
                const raw = res.raw || res;
                if (raw.headersSent) return;
                raw.statusCode = 429;
                raw.setHeader('Content-Type', 'application/json');
                raw.setHeader('Retry-After', String(retryAfter));
                raw.end(JSON.stringify({ error: 'Too many attempts. Try again later.', retryAfter }));
                return;
            }
            attempts.delete(ip);
        }

        const body = req.body || {};

        // --- Detect method ---

        // WebAuthn assertion: { id, response: { authenticatorData, clientDataJSON, signature } }
        if (body.id && body.response && body.response.authenticatorData && body.response.signature)
        {
            if (typeof opts.getCredential !== 'function')
            {
                _sendJson(res, 400, { error: 'WebAuthn not configured' });
                return;
            }

            try
            {
                const credential = await opts.getCredential(req, body.id);
                if (!credential)
                {
                    _trackFailure(ip, res, onFailure, req);
                    return;
                }

                const { webauthn } = require('./webauthn');
                const result = await webauthn.verifyAuthentication({
                    response: body,
                    expectedChallenge: body.challenge || req.session?.get?.('webauthnChallenge'),
                    expectedOrigin: opts.expectedOrigin,
                    expectedRPID: opts.expectedRPID,
                    credential,
                });

                if (!result.verified)
                {
                    _trackFailure(ip, res, onFailure, req);
                    return;
                }

                // Update counter
                if (typeof opts.updateCredentialCounter === 'function')
                {
                    await opts.updateCredentialCounter(req, body.id, result.authData.signCount);
                }

                attempts.delete(ip);
                _markSession(req);
                log.info('verify2FA: WebAuthn verified for IP %s', ip);
                if (typeof onSuccess === 'function') onSuccess(req, res, 'webauthn');
                return next();
            }
            catch (err)
            {
                log.error('verify2FA WebAuthn error: %s', err.message);
                _trackFailure(ip, res, onFailure, req);
                return;
            }
        }

        // Backup code: { backupCode: "a1b2c3d4" }
        if (typeof body[backupField] === 'string' && body[backupField].length > 0)
        {
            if (typeof opts.getBackupHashes !== 'function')
            {
                _sendJson(res, 400, { error: 'Backup codes not configured' });
                return;
            }

            try
            {
                const hashes = await opts.getBackupHashes(req);
                const result = verifyBackupCode(body[backupField], hashes);

                if (!result.valid)
                {
                    _trackFailure(ip, res, onFailure, req);
                    return;
                }

                // Notify caller to remove used code
                if (typeof opts.onBackupUsed === 'function')
                {
                    await opts.onBackupUsed(req, result.index);
                }

                attempts.delete(ip);
                _markSession(req);
                log.info('verify2FA: backup code redeemed for IP %s (index=%d)', ip, result.index);
                if (typeof onSuccess === 'function') onSuccess(req, res, 'backup');
                return next();
            }
            catch (err)
            {
                log.error('verify2FA backup code error: %s', err.message);
                _sendJson(res, 500, { error: 'Internal server error' });
                return;
            }
        }

        // TOTP code: { code: "123456" }
        const code = body[codeField];
        if (!code || typeof code !== 'string')
        {
            _sendJson(res, 400, { error: 'Missing verification data. Send code, backupCode, or WebAuthn assertion.' });
            return;
        }

        let secret;
        try
        {
            secret = await opts.getSecret(req);
        }
        catch (err)
        {
            log.error('verify2FA getSecret error: %s', err.message);
            _sendJson(res, 500, { error: 'Internal server error' });
            return;
        }

        if (!secret)
        {
            _sendJson(res, 400, { error: '2FA not configured for this account' });
            return;
        }

        const result = verifyTOTP(code, secret, { window, period, algorithm, digits });

        if (result.valid)
        {
            // Replay prevention
            if (opts.replayStore)
            {
                try
                {
                    const userId = await opts.getUserId(req);
                    const currentTime = Math.floor(Date.now() / 1000);
                    const usedCounter = Math.floor(currentTime / period) + result.delta;
                    const lastCounter = await opts.replayStore.get(userId);

                    if (lastCounter !== null && usedCounter <= lastCounter)
                    {
                        log.warn('verify2FA: TOTP replay detected for user %s', userId);
                        _trackFailure(ip, res, onFailure, req);
                        return;
                    }

                    const ttl = period * (window + 1) * 1000;
                    await opts.replayStore.set(userId, usedCounter, ttl);
                }
                catch (err)
                {
                    log.error('verify2FA replay store error: %s', err.message);
                }
            }

            attempts.delete(ip);
            _markSession(req);
            log.info('verify2FA: TOTP verified for IP %s (delta=%d)', ip, result.delta);
            if (typeof onSuccess === 'function') onSuccess(req, res, 'totp');
            return next();
        }

        _trackFailure(ip, res, onFailure, req);
    };
}

// -- Exports -----------------------------------------------------

module.exports = {
    // Core TOTP
    generateSecret,
    generateTOTP,
    verifyTOTP,
    otpauthURI,

    // Backup codes
    generateBackupCodes,
    verifyBackupCode,

    // Middleware
    require2FA,
    verifyTOTPMiddleware,
    verify2FA,

    // Replay prevention
    InMemoryReplayStore,

    // Constants (for advanced usage / testing)
    DEFAULT_PERIOD,
    DEFAULT_DIGITS,
    DEFAULT_ALGORITHM,
    DEFAULT_WINDOW,
    SUPPORTED_TOTP_ALGORITHMS,

    // Internal helpers (exported for testing)
    _base32Encode,
    _base32Decode,
    _generateHOTP,
};
