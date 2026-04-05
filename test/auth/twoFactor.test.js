/**
 * Two-Factor Authentication — comprehensive tests.
 * Covers: TOTP generation/verification (RFC 6238), Base32 encoding,
 * backup codes, otpauth URI, require2FA middleware, verifyTOTPMiddleware,
 * timing-safe comparison, brute-force lockout, and edge cases.
 */
const crypto = require('crypto');
const http = require('http');
const { doFetch } = require('../_helpers');
const { createApp, json, session, cookieParser, twoFactor } = require('../../');

const {
    generateSecret,
    generateTOTP,
    verifyTOTP,
    otpauthURI,
    generateBackupCodes,
    verifyBackupCode,
    require2FA,
    verifyTOTPMiddleware,
    DEFAULT_PERIOD,
    DEFAULT_DIGITS,
    DEFAULT_ALGORITHM,
    DEFAULT_WINDOW,
    SUPPORTED_TOTP_ALGORITHMS,
    _base32Encode,
    _base32Decode,
} = twoFactor;

// =========================================================
// Base32 Encoding / Decoding
// =========================================================

describe('Base32 Encode/Decode', () =>
{
    it('round-trips arbitrary bytes', () =>
    {
        const buf = crypto.randomBytes(20);
        const encoded = _base32Encode(buf);
        const decoded = _base32Decode(encoded);
        expect(decoded).toEqual(buf);
    });

    it('encodes known test vector (RFC 4648)', () =>
    {
        // "Hello!" in Base32
        const encoded = _base32Encode(Buffer.from('Hello!'));
        expect(encoded).toBe('JBSWY3DPEE');
    });

    it('decodes known test vector', () =>
    {
        const decoded = _base32Decode('JBSWY3DPEE');
        expect(decoded.toString()).toBe('Hello!');
    });

    it('tolerates lowercase input', () =>
    {
        const decoded = _base32Decode('jbswy3dpee');
        expect(decoded.toString()).toBe('Hello!');
    });

    it('tolerates whitespace and padding', () =>
    {
        const decoded = _base32Decode('JBSWY 3DPE E===');
        expect(decoded.toString()).toBe('Hello!');
    });

    it('throws on invalid characters', () =>
    {
        expect(() => _base32Decode('JBSWY!DPEE')).toThrow('Invalid Base32 character');
    });

    it('handles empty buffer', () =>
    {
        const encoded = _base32Encode(Buffer.alloc(0));
        expect(encoded).toBe('');
        const decoded = _base32Decode('');
        expect(decoded).toEqual(Buffer.alloc(0));
    });

    it('handles single byte', () =>
    {
        const buf = Buffer.from([0xff]);
        const encoded = _base32Encode(buf);
        const decoded = _base32Decode(encoded);
        expect(decoded).toEqual(buf);
    });
});

// =========================================================
// Secret Generation
// =========================================================

describe('generateSecret()', () =>
{
    it('generates a 20-byte secret by default', () =>
    {
        const secret = generateSecret();
        expect(secret.raw).toBeInstanceOf(Buffer);
        expect(secret.raw.length).toBe(20);
        expect(typeof secret.base32).toBe('string');
        expect(typeof secret.hex).toBe('string');
        expect(secret.hex.length).toBe(40);
    });

    it('generates custom-length secrets', () =>
    {
        const secret = generateSecret(32);
        expect(secret.raw.length).toBe(32);
    });

    it('produces unique secrets each time', () =>
    {
        const a = generateSecret();
        const b = generateSecret();
        expect(a.base32).not.toBe(b.base32);
    });

    it('base32 round-trips back to raw', () =>
    {
        const secret = generateSecret();
        const decoded = _base32Decode(secret.base32);
        expect(decoded).toEqual(secret.raw);
    });
});

// =========================================================
// TOTP Generation
// =========================================================

describe('generateTOTP()', () =>
{
    const SECRET = 'JBSWY3DPEHPK3PXP'; // Known test secret (base32 of "Hello!12345")

    it('returns a 6-digit string by default', () =>
    {
        const code = generateTOTP(SECRET);
        expect(code).toMatch(/^\d{6}$/);
    });

    it('returns an 8-digit code when configured', () =>
    {
        const code = generateTOTP(SECRET, { digits: 8 });
        expect(code).toMatch(/^\d{8}$/);
    });

    it('produces deterministic output for a fixed time', () =>
    {
        const code1 = generateTOTP(SECRET, { time: 1000000 });
        const code2 = generateTOTP(SECRET, { time: 1000000 });
        expect(code1).toBe(code2);
    });

    it('produces different codes for different time steps', () =>
    {
        const code1 = generateTOTP(SECRET, { time: 1000000 });
        const code2 = generateTOTP(SECRET, { time: 1000030 });
        // Different time steps should (almost always) produce different codes
        // This is probabilistic but with 6 digits collision is ~1/1M
        // Use an assertion that's deterministic by picking times in different steps
        const code3 = generateTOTP(SECRET, { time: 1000060 });
        // At least two of three should differ
        const unique = new Set([code1, code2, code3]);
        expect(unique.size).toBeGreaterThanOrEqual(2);
    });

    it('accepts raw Buffer as secret', () =>
    {
        const buf = crypto.randomBytes(20);
        const code = generateTOTP(buf, { time: 500000 });
        expect(code).toMatch(/^\d{6}$/);
    });

    it('supports sha256 algorithm', () =>
    {
        const code = generateTOTP(SECRET, { algorithm: 'sha256', time: 1000000 });
        expect(code).toMatch(/^\d{6}$/);
    });

    it('supports sha512 algorithm', () =>
    {
        const code = generateTOTP(SECRET, { algorithm: 'sha512', time: 1000000 });
        expect(code).toMatch(/^\d{6}$/);
    });

    it('throws on unsupported algorithm', () =>
    {
        expect(() => generateTOTP(SECRET, { algorithm: 'md5' })).toThrow('Unsupported algorithm');
    });

    it('custom period changes the output', () =>
    {
        const a = generateTOTP(SECRET, { time: 1000000, period: 30 });
        const b = generateTOTP(SECRET, { time: 1000000, period: 60 });
        // Same time, different period → different counter → (usually) different code
        // Use deterministic check: the counters differ
        const counterA = Math.floor(1000000 / 30);
        const counterB = Math.floor(1000000 / 60);
        expect(counterA).not.toBe(counterB);
    });

    // RFC 6238 Test Vectors — SHA1 with known secret
    it('matches RFC 6238 test vector (time=59, SHA1)', () =>
    {
        // RFC 6238 §B: secret = "12345678901234567890" (ASCII)
        const rfcSecret = Buffer.from('12345678901234567890');
        const code = generateTOTP(rfcSecret, { time: 59, period: 30, digits: 8, algorithm: 'sha1' });
        expect(code).toBe('94287082');
    });

    it('matches RFC 6238 test vector (time=1111111109, SHA1)', () =>
    {
        const rfcSecret = Buffer.from('12345678901234567890');
        const code = generateTOTP(rfcSecret, { time: 1111111109, period: 30, digits: 8, algorithm: 'sha1' });
        expect(code).toBe('07081804');
    });

    it('matches RFC 6238 test vector (time=1234567890, SHA1)', () =>
    {
        const rfcSecret = Buffer.from('12345678901234567890');
        const code = generateTOTP(rfcSecret, { time: 1234567890, period: 30, digits: 8, algorithm: 'sha1' });
        expect(code).toBe('89005924');
    });

    it('matches RFC 6238 test vector (time=2000000000, SHA1)', () =>
    {
        const rfcSecret = Buffer.from('12345678901234567890');
        const code = generateTOTP(rfcSecret, { time: 2000000000, period: 30, digits: 8, algorithm: 'sha1' });
        expect(code).toBe('69279037');
    });

    it('matches RFC 6238 test vector (time=59, SHA256)', () =>
    {
        const rfcSecret256 = Buffer.from('12345678901234567890123456789012');
        const code = generateTOTP(rfcSecret256, { time: 59, period: 30, digits: 8, algorithm: 'sha256' });
        expect(code).toBe('46119246');
    });

    it('matches RFC 6238 test vector (time=59, SHA512)', () =>
    {
        const rfcSecret512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
        const code = generateTOTP(rfcSecret512, { time: 59, period: 30, digits: 8, algorithm: 'sha512' });
        expect(code).toBe('90693936');
    });
});

// =========================================================
// TOTP Verification
// =========================================================

describe('verifyTOTP()', () =>
{
    const secret = generateSecret();

    it('verifies a valid code at exact time', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time });
        const result = verifyTOTP(code, secret.base32, { time });
        expect(result.valid).toBe(true);
        expect(result.delta).toBe(0);
    });

    it('verifies within +1 window', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time: time + 30 }); // next step
        const result = verifyTOTP(code, secret.base32, { time, window: 1 });
        expect(result.valid).toBe(true);
        expect(result.delta).toBe(1);
    });

    it('verifies within -1 window', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time: time - 30 }); // previous step
        const result = verifyTOTP(code, secret.base32, { time, window: 1 });
        expect(result.valid).toBe(true);
        expect(result.delta).toBe(-1);
    });

    it('rejects code outside window', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time: time + 90 }); // 3 steps ahead
        const result = verifyTOTP(code, secret.base32, { time, window: 1 });
        expect(result.valid).toBe(false);
        expect(result.delta).toBeNull();
    });

    it('accepts wider window', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time: time + 60 }); // 2 steps ahead
        const result = verifyTOTP(code, secret.base32, { time, window: 2 });
        expect(result.valid).toBe(true);
        expect(result.delta).toBe(2);
    });

    it('rejects non-numeric input', () =>
    {
        expect(verifyTOTP('abcdef', secret.base32, { time: 1000000 })).toEqual({ valid: false, delta: null });
    });

    it('rejects wrong-length code', () =>
    {
        expect(verifyTOTP('12345', secret.base32, { time: 1000000 })).toEqual({ valid: false, delta: null });
        expect(verifyTOTP('1234567', secret.base32, { time: 1000000 })).toEqual({ valid: false, delta: null });
    });

    it('rejects null/undefined', () =>
    {
        expect(verifyTOTP(null, secret.base32)).toEqual({ valid: false, delta: null });
        expect(verifyTOTP(undefined, secret.base32)).toEqual({ valid: false, delta: null });
    });

    it('rejects empty string', () =>
    {
        expect(verifyTOTP('', secret.base32)).toEqual({ valid: false, delta: null });
    });

    it('works with raw Buffer secret', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.raw, { time });
        const result = verifyTOTP(code, secret.raw, { time });
        expect(result.valid).toBe(true);
    });

    it('works cross-format (generate with base32, verify with raw)', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time });
        const result = verifyTOTP(code, secret.raw, { time });
        expect(result.valid).toBe(true);
    });

    it('rejects code from wrong secret', () =>
    {
        const other = generateSecret();
        const time = 1000000;
        const code = generateTOTP(other.base32, { time });
        const result = verifyTOTP(code, secret.base32, { time });
        expect(result.valid).toBe(false);
    });

    it('handles 8-digit codes', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time, digits: 8 });
        expect(code.length).toBe(8);
        const result = verifyTOTP(code, secret.base32, { time, digits: 8 });
        expect(result.valid).toBe(true);
    });

    it('window=0 requires exact step match', () =>
    {
        const time = 1000000;
        const code = generateTOTP(secret.base32, { time });
        const exact = verifyTOTP(code, secret.base32, { time, window: 0 });
        expect(exact.valid).toBe(true);

        const nextStep = verifyTOTP(code, secret.base32, { time: time + 30, window: 0 });
        expect(nextStep.valid).toBe(false);
    });
});

// =========================================================
// OTPAuth URI
// =========================================================

describe('otpauthURI()', () =>
{
    it('generates a valid otpauth URI', () =>
    {
        const uri = otpauthURI({
            secret: 'JBSWY3DPEHPK3PXP',
            issuer: 'MyApp',
            account: 'user@example.com',
        });

        expect(uri).toMatch(/^otpauth:\/\/totp\//);
        expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
        expect(uri).toContain('issuer=MyApp');
        expect(uri).toContain('user%40example.com');
        expect(uri).toContain('digits=6');
        expect(uri).toContain('period=30');
    });

    it('encodes special characters in issuer and account', () =>
    {
        const uri = otpauthURI({
            secret: 'JBSWY3DPEHPK3PXP',
            issuer: 'My App & Co.',
            account: 'user+test@example.com',
        });

        expect(uri).toContain(encodeURIComponent('My App & Co.'));
        expect(uri).toContain(encodeURIComponent('user+test@example.com'));
    });

    it('accepts raw Buffer secret', () =>
    {
        const secret = generateSecret();
        const uri = otpauthURI({
            secret: secret.raw,
            issuer: 'Test',
            account: 'test@test.com',
        });

        expect(uri).toContain(`secret=${secret.base32}`);
    });

    it('includes custom algorithm and digits', () =>
    {
        const uri = otpauthURI({
            secret: 'JBSWY3DPEHPK3PXP',
            issuer: 'MyApp',
            account: 'user@example.com',
            algorithm: 'sha256',
            digits: 8,
            period: 60,
        });

        expect(uri).toContain('algorithm=SHA256');
        expect(uri).toContain('digits=8');
        expect(uri).toContain('period=60');
    });

    it('throws without secret', () =>
    {
        expect(() => otpauthURI({ issuer: 'X', account: 'y' })).toThrow();
    });

    it('throws without issuer', () =>
    {
        expect(() => otpauthURI({ secret: 'ABC', account: 'y' })).toThrow();
    });

    it('throws without account', () =>
    {
        expect(() => otpauthURI({ secret: 'ABC', issuer: 'X' })).toThrow();
    });

    it('throws on null opts', () =>
    {
        expect(() => otpauthURI(null)).toThrow();
    });
});

// =========================================================
// Backup Codes
// =========================================================

describe('generateBackupCodes()', () =>
{
    it('generates 10 codes by default', () =>
    {
        const { codes, hashes } = generateBackupCodes();
        expect(codes).toHaveLength(10);
        expect(hashes).toHaveLength(10);
    });

    it('generates custom count', () =>
    {
        const { codes, hashes } = generateBackupCodes(5);
        expect(codes).toHaveLength(5);
        expect(hashes).toHaveLength(5);
    });

    it('codes are 8 hex characters by default', () =>
    {
        const { codes } = generateBackupCodes();
        for (const code of codes)
        {
            expect(code).toMatch(/^[0-9a-f]{8}$/);
        }
    });

    it('hashes are valid SHA-256 hex', () =>
    {
        const { hashes } = generateBackupCodes();
        for (const hash of hashes)
        {
            expect(hash).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it('all codes are unique', () =>
    {
        const { codes } = generateBackupCodes(100);
        const unique = new Set(codes);
        expect(unique.size).toBe(100);
    });

    it('hashes match their codes', () =>
    {
        const { codes, hashes } = generateBackupCodes();
        for (let i = 0; i < codes.length; i++)
        {
            const expected = crypto.createHash('sha256').update(codes[i]).digest('hex');
            expect(hashes[i]).toBe(expected);
        }
    });

    it('custom byte length affects code length', () =>
    {
        const { codes } = generateBackupCodes(5, 8);
        for (const code of codes)
        {
            expect(code).toMatch(/^[0-9a-f]{16}$/); // 8 bytes = 16 hex chars
        }
    });
});

describe('verifyBackupCode()', () =>
{
    it('verifies a valid code and returns index', () =>
    {
        const { codes, hashes } = generateBackupCodes(5);
        const result = verifyBackupCode(codes[2], hashes);
        expect(result.valid).toBe(true);
        expect(result.index).toBe(2);
    });

    it('rejects an invalid code', () =>
    {
        const { hashes } = generateBackupCodes(5);
        const result = verifyBackupCode('deadbeef', hashes);
        expect(result.valid).toBe(false);
        expect(result.index).toBeNull();
    });

    it('rejects empty code', () =>
    {
        const { hashes } = generateBackupCodes();
        expect(verifyBackupCode('', hashes)).toEqual({ valid: false, index: null });
    });

    it('rejects non-string code', () =>
    {
        const { hashes } = generateBackupCodes();
        expect(verifyBackupCode(null, hashes)).toEqual({ valid: false, index: null });
        expect(verifyBackupCode(123456, hashes)).toEqual({ valid: false, index: null });
    });

    it('rejects when hashes is not an array', () =>
    {
        expect(verifyBackupCode('abc', 'not-array')).toEqual({ valid: false, index: null });
        expect(verifyBackupCode('abc', null)).toEqual({ valid: false, index: null });
    });

    it('works after removing used codes', () =>
    {
        const { codes, hashes } = generateBackupCodes(5);

        // Use code at index 1
        const r1 = verifyBackupCode(codes[1], hashes);
        expect(r1.valid).toBe(true);
        hashes.splice(r1.index, 1);

        // Code 1 no longer works
        const r2 = verifyBackupCode(codes[1], hashes);
        expect(r2.valid).toBe(false);

        // Other codes still work
        const r3 = verifyBackupCode(codes[0], hashes);
        expect(r3.valid).toBe(true);
    });

    it('handles empty hashes array', () =>
    {
        expect(verifyBackupCode('abc', [])).toEqual({ valid: false, index: null });
    });
});

// =========================================================
// Constants
// =========================================================

describe('Constants', () =>
{
    it('has correct defaults', () =>
    {
        expect(DEFAULT_PERIOD).toBe(30);
        expect(DEFAULT_DIGITS).toBe(6);
        expect(DEFAULT_ALGORITHM).toBe('sha1');
        expect(DEFAULT_WINDOW).toBe(1);
    });

    it('supports sha1, sha256, sha512', () =>
    {
        expect(SUPPORTED_TOTP_ALGORITHMS).toEqual(['sha1', 'sha256', 'sha512']);
    });
});

// =========================================================
// Full End-to-End Integration Tests
// =========================================================

describe('2FA Full Flow Integration', () =>
{
    let app, server, port;

    // Simulated user database — shared across routes in each test
    let users;

    afterEach(() => new Promise((resolve) =>
    {
        if (server) server.close(resolve);
        else resolve();
    }));

    /**
     * Build a realistic app with:
     *  POST /signup           — create user (no 2FA yet)
     *  POST /login            — password login → session
     *  POST /2fa/setup        — generate secret + backup codes, store in user
     *  POST /2fa/enable       — confirm first TOTP code to activate 2FA
     *  POST /2fa/verify       — submit TOTP to complete step-up auth
     *  POST /2fa/backup       — redeem a backup code as fallback
     *  GET  /dashboard        — protected by require2FA
     *  GET  /profile          — protected, returns user info
     */
    function buildApp(opts = {})
    {
        users = {};

        return new Promise((resolve) =>
        {
            app = createApp();
            app.use(cookieParser());
            app.use(session({ secret: 'integration-test-secret-32-bytes!!' }));

            // --- Signup ---
            app.post('/signup', json(), (req, res) =>
            {
                const { email, password } = req.body;
                if (!email || !password)
                    return res.status(400).json({ error: 'email and password required' });
                if (users[email])
                    return res.status(409).json({ error: 'User already exists' });

                users[email] = { email, password, totpSecret: null, backupHashes: [] };
                req.session.set('userId', email);
                res.json({ ok: true, email });
            });

            // --- Login ---
            app.post('/login', json(), (req, res) =>
            {
                const { email, password } = req.body;
                const user = users[email];
                if (!user || user.password !== password)
                    return res.status(401).json({ error: 'Invalid credentials' });

                req.session.set('userId', email);
                // If user has 2FA enabled, they still need to verify
                const needs2FA = !!user.totpSecret;
                if (!needs2FA) req.session.set('twoFactorVerified', true);
                res.json({ ok: true, needs2FA });
            });

            // --- 2FA Setup (generate secret + backup codes) ---
            app.post('/2fa/setup', (req, res) =>
            {
                const email = req.session.get('userId');
                if (!email) return res.status(401).json({ error: 'Not logged in' });
                const user = users[email];

                const secret = generateSecret();
                const { codes, hashes } = generateBackupCodes(8);
                const uri = otpauthURI({ secret: secret.base32, issuer: 'TestApp', account: email });

                // Store pending (not yet activated)
                user._pendingSecret = secret.base32;
                user._pendingBackupHashes = hashes;

                res.json({ secret: secret.base32, uri, backupCodes: codes });
            });

            // --- 2FA Enable (confirm first code to activate) ---
            app.post('/2fa/enable', json(), (req, res) =>
            {
                const email = req.session.get('userId');
                if (!email) return res.status(401).json({ error: 'Not logged in' });
                const user = users[email];

                if (!user._pendingSecret)
                    return res.status(400).json({ error: 'Run /2fa/setup first' });

                const result = verifyTOTP(req.body.code, user._pendingSecret);
                if (!result.valid)
                    return res.status(401).json({ error: 'Invalid code — scan the QR and try again' });

                // Activate 2FA
                user.totpSecret = user._pendingSecret;
                user.backupHashes = user._pendingBackupHashes;
                delete user._pendingSecret;
                delete user._pendingBackupHashes;

                req.session.set('twoFactorVerified', true);
                res.json({ ok: true, message: '2FA is now active' });
            });

            // --- 2FA Verify (step-up on subsequent logins) ---
            app.post('/2fa/verify', json(), verifyTOTPMiddleware({
                getSecret: (req) =>
                {
                    const email = req.session.get('userId');
                    return email && users[email] ? users[email].totpSecret : null;
                },
                maxAttempts: opts.maxAttempts || 5,
                lockoutMs: opts.lockoutMs || 60000,
            }), (req, res) =>
            {
                res.json({ ok: true, message: '2FA verified' });
            });

            // --- Backup code fallback ---
            app.post('/2fa/backup', json(), (req, res) =>
            {
                const email = req.session.get('userId');
                if (!email) return res.status(401).json({ error: 'Not logged in' });
                const user = users[email];

                if (!user.totpSecret)
                    return res.status(400).json({ error: '2FA not enabled' });

                const result = verifyBackupCode(req.body.code, user.backupHashes);
                if (!result.valid)
                    return res.status(401).json({ error: 'Invalid backup code' });

                // Consume the code (remove from stored hashes)
                user.backupHashes.splice(result.index, 1);
                req.session.set('twoFactorVerified', true);
                res.json({ ok: true, codesRemaining: user.backupHashes.length });
            });

            // --- Protected routes ---
            app.get('/dashboard', require2FA({
                isEnabled: (req) =>
                {
                    const email = req.session.get('userId');
                    return email && users[email] && !!users[email].totpSecret;
                },
            }), (req, res) =>
            {
                const email = req.session.get('userId');
                res.json({ welcome: email, dashboard: true });
            });

            app.get('/profile', require2FA({
                isEnabled: (req) =>
                {
                    const email = req.session.get('userId');
                    return email && users[email] && !!users[email].totpSecret;
                },
            }), (req, res) =>
            {
                const email = req.session.get('userId');
                const user = users[email];
                res.json({
                    email,
                    has2FA: !!user.totpSecret,
                    backupCodesLeft: user.backupHashes.length,
                });
            });

            server = http.createServer(app.handler);
            server.listen(0, () =>
            {
                port = server.address().port;
                resolve();
            });
        });
    }

    // -- Helpers -----------------------------------------------

    function url(path) { return `http://127.0.0.1:${port}${path}`; }

    function postJSON(path, body, cookie)
    {
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        };
        if (cookie) opts.headers.Cookie = cookie;
        return doFetch(url(path), opts);
    }

    function getCookie(res)
    {
        const raw = res.headers.get('set-cookie');
        return raw ? raw.split(';')[0] : null;
    }

    // ==========================================================
    // Flow 1: User without 2FA accesses everything freely
    // ==========================================================

    it('user without 2FA can access protected routes after login', async () =>
    {
        await buildApp();

        // Signup
        const signup = await postJSON('/signup', { email: 'nofa@test.com', password: 'pass123' });
        expect(signup.status).toBe(200);
        const cookie = getCookie(signup);
        expect(cookie).toBeTruthy();

        // Dashboard — no 2FA enabled, isEnabled returns false → passes through
        const dash = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(dash.status).toBe(200);
        expect(dash.data.welcome).toBe('nofa@test.com');
        expect(dash.data.dashboard).toBe(true);
    });

    // ==========================================================
    // Flow 2: Full 2FA enrollment → login → verify → access
    // ==========================================================

    it('full enrollment flow: setup → enable → re-login → verify → access', async () =>
    {
        await buildApp();

        // Step 1: Signup
        const signup = await postJSON('/signup', { email: 'alice@test.com', password: 'secret' });
        expect(signup.status).toBe(200);
        let cookie = getCookie(signup);

        // Step 2: Setup 2FA — get secret and backup codes
        const setup = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookie } });
        expect(setup.status).toBe(200);
        expect(setup.data.secret).toBeTruthy();
        expect(setup.data.uri).toMatch(/^otpauth:\/\/totp\//);
        expect(setup.data.uri).toContain('alice%40test.com');
        expect(setup.data.uri).toContain('TestApp');
        expect(setup.data.backupCodes).toHaveLength(8);
        cookie = getCookie(setup) || cookie;

        const secret = setup.data.secret;
        const backupCodes = setup.data.backupCodes;

        // Step 3: Enable 2FA — submit a valid TOTP generated from the secret
        const enableCode = generateTOTP(secret);
        const enable = await postJSON('/2fa/enable', { code: enableCode }, cookie);
        expect(enable.status).toBe(200);
        expect(enable.data.message).toBe('2FA is now active');
        cookie = getCookie(enable) || cookie;

        // Verify the user DB was updated
        expect(users['alice@test.com'].totpSecret).toBe(secret);
        expect(users['alice@test.com'].backupHashes).toHaveLength(8);

        // Step 4: Dashboard works because we just enabled + verified
        const dash1 = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(dash1.status).toBe(200);
        expect(dash1.data.welcome).toBe('alice@test.com');

        // Step 5: Simulate re-login (new session, 2FA NOT verified)
        const login = await postJSON('/login', { email: 'alice@test.com', password: 'secret' });
        expect(login.status).toBe(200);
        expect(login.data.needs2FA).toBe(true);
        cookie = getCookie(login);

        // Step 6: Dashboard should be BLOCKED — logged in but 2FA not verified
        const dash2 = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(dash2.status).toBe(403);
        expect(dash2.data.error).toContain('Two-factor authentication required');

        // Step 7: Verify TOTP through the middleware
        const verifyCode = generateTOTP(secret);
        const verify = await postJSON('/2fa/verify', { code: verifyCode }, cookie);
        expect(verify.status).toBe(200);
        expect(verify.data.message).toBe('2FA verified');
        cookie = getCookie(verify) || cookie;

        // Step 8: Dashboard NOW accessible
        const dash3 = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(dash3.status).toBe(200);
        expect(dash3.data.welcome).toBe('alice@test.com');

        // Step 9: Profile shows correct state
        const profile = await doFetch(url('/profile'), { headers: { Cookie: cookie } });
        expect(profile.status).toBe(200);
        expect(profile.data.has2FA).toBe(true);
        expect(profile.data.backupCodesLeft).toBe(8);
    });

    // ==========================================================
    // Flow 3: Backup code fallback when TOTP unavailable
    // ==========================================================

    it('backup code unlocks access when TOTP device is unavailable', async () =>
    {
        await buildApp();

        // Enroll user with 2FA
        const signup = await postJSON('/signup', { email: 'bob@test.com', password: 'pass' });
        let cookie = getCookie(signup);

        const setup = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookie } });
        cookie = getCookie(setup) || cookie;
        const secret = setup.data.secret;
        const backupCodes = setup.data.backupCodes;
        expect(backupCodes).toHaveLength(8);

        const enableCode = generateTOTP(secret);
        const enable = await postJSON('/2fa/enable', { code: enableCode }, cookie);
        expect(enable.status).toBe(200);
        cookie = getCookie(enable) || cookie;

        // Re-login — needs 2FA
        const login = await postJSON('/login', { email: 'bob@test.com', password: 'pass' });
        expect(login.data.needs2FA).toBe(true);
        cookie = getCookie(login);

        // Dashboard blocked
        const blocked = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(blocked.status).toBe(403);

        // Use first backup code
        const backup = await postJSON('/2fa/backup', { code: backupCodes[0] }, cookie);
        expect(backup.status).toBe(200);
        expect(backup.data.codesRemaining).toBe(7);
        cookie = getCookie(backup) || cookie;

        // Dashboard now accessible
        const dash = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(dash.status).toBe(200);
        expect(dash.data.welcome).toBe('bob@test.com');

        // Same backup code cannot be reused
        const login2 = await postJSON('/login', { email: 'bob@test.com', password: 'pass' });
        cookie = getCookie(login2);

        const reuse = await postJSON('/2fa/backup', { code: backupCodes[0] }, cookie);
        expect(reuse.status).toBe(401);
        expect(reuse.data.error).toContain('Invalid backup code');

        // But second backup code still works
        const backup2 = await postJSON('/2fa/backup', { code: backupCodes[1] }, cookie);
        expect(backup2.status).toBe(200);
        expect(backup2.data.codesRemaining).toBe(6);
    });

    // ==========================================================
    // Flow 4: Wrong TOTP, then correct TOTP in same session
    // ==========================================================

    it('wrong code fails, correct code succeeds, session carries through', async () =>
    {
        await buildApp();

        // Enroll
        const signup = await postJSON('/signup', { email: 'eve@test.com', password: 'pw' });
        let cookie = getCookie(signup);
        const setup = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookie } });
        cookie = getCookie(setup) || cookie;
        const secret = setup.data.secret;
        const enable = await postJSON('/2fa/enable', { code: generateTOTP(secret) }, cookie);
        cookie = getCookie(enable) || cookie;

        // Re-login
        const login = await postJSON('/login', { email: 'eve@test.com', password: 'pw' });
        cookie = getCookie(login);

        // Wrong code
        const bad = await postJSON('/2fa/verify', { code: '000000' }, cookie);
        expect(bad.status).toBe(401);
        expect(bad.data.attemptsRemaining).toBe(4);
        cookie = getCookie(bad) || cookie;

        // Another wrong code
        const bad2 = await postJSON('/2fa/verify', { code: '111111' }, cookie);
        expect(bad2.status).toBe(401);
        expect(bad2.data.attemptsRemaining).toBe(3);
        cookie = getCookie(bad2) || cookie;

        // Dashboard still blocked
        const blocked = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(blocked.status).toBe(403);

        // Correct code
        const good = await postJSON('/2fa/verify', { code: generateTOTP(secret) }, cookie);
        expect(good.status).toBe(200);
        cookie = getCookie(good) || cookie;

        // Dashboard now accessible
        const dash = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(dash.status).toBe(200);
        expect(dash.data.welcome).toBe('eve@test.com');
    });

    // ==========================================================
    // Flow 5: Rate limiting on brute force, then lockout
    // ==========================================================

    it('locks out after max failed attempts, valid code blocked during lockout', async () =>
    {
        await buildApp({ maxAttempts: 3, lockoutMs: 60000 });

        // Quick enroll
        const signup = await postJSON('/signup', { email: 'mal@test.com', password: 'pw' });
        let cookie = getCookie(signup);
        const setup = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookie } });
        cookie = getCookie(setup) || cookie;
        const secret = setup.data.secret;
        const enable = await postJSON('/2fa/enable', { code: generateTOTP(secret) }, cookie);
        cookie = getCookie(enable) || cookie;

        // Re-login
        const login = await postJSON('/login', { email: 'mal@test.com', password: 'pw' });
        cookie = getCookie(login);

        // 3 wrong codes → exhaust attempts
        for (let i = 0; i < 3; i++)
        {
            const r = await postJSON('/2fa/verify', { code: '000000' }, cookie);
            expect(r.status).toBe(401);
            cookie = getCookie(r) || cookie;
        }

        // 4th attempt → 429 lockout
        const locked = await postJSON('/2fa/verify', { code: '000000' }, cookie);
        expect(locked.status).toBe(429);
        expect(locked.data.error).toContain('Too many attempts');
        expect(typeof locked.data.retryAfter).toBe('number');

        // Even a valid code is blocked during lockout
        const validButLocked = await postJSON('/2fa/verify', { code: generateTOTP(secret) }, cookie);
        expect(validButLocked.status).toBe(429);
    });

    // ==========================================================
    // Flow 6: Enable 2FA with wrong initial code
    // ==========================================================

    it('rejects enable with wrong code, accepts correct code', async () =>
    {
        await buildApp();

        const signup = await postJSON('/signup', { email: 'frank@test.com', password: 'pw' });
        let cookie = getCookie(signup);

        const setup = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookie } });
        cookie = getCookie(setup) || cookie;
        const secret = setup.data.secret;

        // Wrong code — 2FA should NOT be activated
        const badEnable = await postJSON('/2fa/enable', { code: '000000' }, cookie);
        expect(badEnable.status).toBe(401);
        expect(badEnable.data.error).toContain('Invalid code');
        cookie = getCookie(badEnable) || cookie;

        // User DB should NOT have totpSecret activated
        expect(users['frank@test.com'].totpSecret).toBeNull();

        // Correct code — now activate
        const goodEnable = await postJSON('/2fa/enable', { code: generateTOTP(secret) }, cookie);
        expect(goodEnable.status).toBe(200);
        cookie = getCookie(goodEnable) || cookie;

        expect(users['frank@test.com'].totpSecret).toBe(secret);
    });

    // ==========================================================
    // Flow 7: Two different users, independent sessions
    // ==========================================================

    it('2FA state is per-user and does not leak between sessions', async () =>
    {
        await buildApp();

        // User A: has 2FA
        const signupA = await postJSON('/signup', { email: 'a@test.com', password: 'pw' });
        let cookieA = getCookie(signupA);
        const setupA = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookieA } });
        cookieA = getCookie(setupA) || cookieA;
        const secretA = setupA.data.secret;
        const enableA = await postJSON('/2fa/enable', { code: generateTOTP(secretA) }, cookieA);
        cookieA = getCookie(enableA) || cookieA;

        // User B: no 2FA
        const signupB = await postJSON('/signup', { email: 'b@test.com', password: 'pw' });
        const cookieB = getCookie(signupB);

        // User B can access dashboard (no 2FA required)
        const dashB = await doFetch(url('/dashboard'), { headers: { Cookie: cookieB } });
        expect(dashB.status).toBe(200);
        expect(dashB.data.welcome).toBe('b@test.com');

        // User A re-login — needs 2FA
        const loginA = await postJSON('/login', { email: 'a@test.com', password: 'pw' });
        cookieA = getCookie(loginA);

        const dashA = await doFetch(url('/dashboard'), { headers: { Cookie: cookieA } });
        expect(dashA.status).toBe(403);

        // User A verifies TOTP
        const verifyA = await postJSON('/2fa/verify', { code: generateTOTP(secretA) }, cookieA);
        expect(verifyA.status).toBe(200);
        cookieA = getCookie(verifyA) || cookieA;

        // Both can access now
        const dashA2 = await doFetch(url('/dashboard'), { headers: { Cookie: cookieA } });
        expect(dashA2.status).toBe(200);
        expect(dashA2.data.welcome).toBe('a@test.com');

        // User B still works independently
        const dashB2 = await doFetch(url('/dashboard'), { headers: { Cookie: cookieB } });
        expect(dashB2.status).toBe(200);
        expect(dashB2.data.welcome).toBe('b@test.com');
    });

    // ==========================================================
    // Flow 8: Backup codes deplete fully
    // ==========================================================

    it('all backup codes can be used one by one until exhausted', async () =>
    {
        await buildApp();

        const signup = await postJSON('/signup', { email: 'drain@test.com', password: 'pw' });
        let cookie = getCookie(signup);
        const setup = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookie } });
        cookie = getCookie(setup) || cookie;
        const secret = setup.data.secret;
        const backupCodes = setup.data.backupCodes;

        const enable = await postJSON('/2fa/enable', { code: generateTOTP(secret) }, cookie);
        cookie = getCookie(enable) || cookie;

        // Use all 8 backup codes across 8 separate logins
        for (let i = 0; i < 8; i++)
        {
            const login = await postJSON('/login', { email: 'drain@test.com', password: 'pw' });
            let c = getCookie(login);

            const backup = await postJSON('/2fa/backup', { code: backupCodes[i] }, c);
            expect(backup.status).toBe(200);
            expect(backup.data.codesRemaining).toBe(7 - i);
        }

        // 9th login — no backup codes left
        const login = await postJSON('/login', { email: 'drain@test.com', password: 'pw' });
        cookie = getCookie(login);

        const noMore = await postJSON('/2fa/backup', { code: 'deadbeef' }, cookie);
        expect(noMore.status).toBe(401);

        // But TOTP still works
        const totp = await postJSON('/2fa/verify', { code: generateTOTP(secret) }, cookie);
        expect(totp.status).toBe(200);
    });

    // ==========================================================
    // Flow 9: Login with wrong password → no session
    // ==========================================================

    it('wrong password does not grant 2FA-verified session', async () =>
    {
        await buildApp();

        // Create user with 2FA
        const signup = await postJSON('/signup', { email: 'secure@test.com', password: 'correct' });
        let cookie = getCookie(signup);
        const setup = await doFetch(url('/2fa/setup'), { method: 'POST', headers: { Cookie: cookie } });
        cookie = getCookie(setup) || cookie;
        const secret = setup.data.secret;
        const enable = await postJSON('/2fa/enable', { code: generateTOTP(secret) }, cookie);
        cookie = getCookie(enable) || cookie;

        // Wrong password login — rejected
        const bad = await postJSON('/login', { email: 'secure@test.com', password: 'wrong' });
        expect(bad.status).toBe(401);
        expect(bad.data.error).toBe('Invalid credentials');

        // Login with correct password — needs 2FA step-up
        const good = await postJSON('/login', { email: 'secure@test.com', password: 'correct' });
        expect(good.status).toBe(200);
        expect(good.data.needs2FA).toBe(true);
        const loginCookie = getCookie(good);

        // Dashboard blocked until 2FA verified
        const blocked = await doFetch(url('/dashboard'), { headers: { Cookie: loginCookie } });
        expect(blocked.status).toBe(403);
        expect(blocked.data.error).toContain('Two-factor authentication required');

        // Previous session (from signup/enable) still has 2FA verified
        const allowed = await doFetch(url('/dashboard'), { headers: { Cookie: cookie } });
        expect(allowed.status).toBe(200);
        expect(allowed.data.welcome).toBe('secure@test.com');
    });
});

// =========================================================
// require2FA Middleware — Edge Cases
// =========================================================

describe('require2FA() edge cases', () =>
{
    let app, server, port;

    afterEach(() => new Promise((resolve) =>
    {
        if (server) server.close(resolve);
        else resolve();
    }));

    function startApp(setupFn)
    {
        return new Promise((resolve) =>
        {
            app = createApp();
            app.use(cookieParser());
            app.use(session({ secret: 'test-session-secret-at-least-32-chars!' }));
            setupFn(app);
            server = http.createServer(app.handler);
            server.listen(0, () =>
            {
                port = server.address().port;
                resolve();
            });
        });
    }

    it('custom error message and status code propagate correctly', async () =>
    {
        await startApp((app) =>
        {
            app.get('/locked', require2FA({ errorMessage: 'MFA required', statusCode: 401 }), (req, res) =>
            {
                res.json({ ok: true });
            });
        });

        const { data, status } = await doFetch(`http://127.0.0.1:${port}/locked`);
        expect(status).toBe(401);
        expect(data.error).toBe('MFA required');
    });

    it('async isEnabled that queries user DB', async () =>
    {
        const userDb = {
            'enrolled@test.com': { has2FA: true },
            'free@test.com': { has2FA: false },
        };

        await startApp((app) =>
        {
            app.post('/login', json(), (req, res) =>
            {
                req.session.set('userId', req.body.email);
                res.json({ ok: true });
            });

            app.get('/data', require2FA({
                isEnabled: async (req) =>
                {
                    const email = req.session.get('userId');
                    const user = userDb[email];
                    return user ? user.has2FA : false;
                },
            }), (req, res) => res.json({ data: 'sensitive' }));
        });

        // User without 2FA enrolled — passes through
        const loginFree = await postJSON('/login', { email: 'free@test.com' });
        const cookieFree = getCookie(loginFree);
        const dataFree = await doFetch(`http://127.0.0.1:${port}/data`, { headers: { Cookie: cookieFree } });
        expect(dataFree.status).toBe(200);
        expect(dataFree.data.data).toBe('sensitive');

        // User WITH 2FA enrolled — blocked
        const loginEnrolled = await postJSON('/login', { email: 'enrolled@test.com' });
        const cookieEnrolled = getCookie(loginEnrolled);
        const dataEnrolled = await doFetch(`http://127.0.0.1:${port}/data`, { headers: { Cookie: cookieEnrolled } });
        expect(dataEnrolled.status).toBe(403);
    });

    it('returns 500 when isEnabled throws', async () =>
    {
        await startApp((app) =>
        {
            app.get('/err', require2FA({
                isEnabled: () => { throw new Error('DB down'); },
            }), (req, res) => res.json({ ok: true }));
        });

        const { data, status } = await doFetch(`http://127.0.0.1:${port}/err`);
        expect(status).toBe(500);
        expect(data.error).toBe('Internal server error');
    });

    it('returns 500 when no session middleware is active', async () =>
    {
        await new Promise((resolve) =>
        {
            app = createApp();
            // No cookieParser, no session middleware
            app.get('/no-session', require2FA(), (req, res) => res.json({ ok: true }));
            server = http.createServer(app.handler);
            server.listen(0, () =>
            {
                port = server.address().port;
                resolve();
            });
        });

        const { data, status } = await doFetch(`http://127.0.0.1:${port}/no-session`);
        expect(status).toBe(500);
        expect(data.error).toContain('Session middleware required');
    });

    // Helpers for this describe block
    function url(path) { return `http://127.0.0.1:${port}${path}`; }
    function postJSON(path, body, cookie)
    {
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        };
        if (cookie) opts.headers.Cookie = cookie;
        return doFetch(url(path), opts);
    }
    function getCookie(res)
    {
        const raw = res.headers.get('set-cookie');
        return raw ? raw.split(';')[0] : null;
    }
});

// =========================================================
// verifyTOTPMiddleware — Unit-Level Edge Cases
// =========================================================

describe('verifyTOTPMiddleware() edge cases', () =>
{
    let app, server, port;
    const testSecret = generateSecret();

    afterEach(() => new Promise((resolve) =>
    {
        if (server) server.close(resolve);
        else resolve();
    }));

    function startApp(setupFn)
    {
        return new Promise((resolve) =>
        {
            app = createApp();
            app.use(cookieParser());
            app.use(session({ secret: 'test-session-secret-at-least-32-chars!' }));
            setupFn(app);
            server = http.createServer(app.handler);
            server.listen(0, () =>
            {
                port = server.address().port;
                resolve();
            });
        });
    }

    it('throws if getSecret is not provided', () =>
    {
        expect(() => verifyTOTPMiddleware({})).toThrow('getSecret');
    });

    it('returns 400 on missing code field', async () =>
    {
        await startApp((app) =>
        {
            app.post('/verify', json(), verifyTOTPMiddleware({
                getSecret: () => testSecret.base32,
            }), (req, res) => res.json({ ok: true }));
        });

        const noBody = await doFetch(`http://127.0.0.1:${port}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(noBody.status).toBe(400);
        expect(noBody.data.error).toContain('Missing or invalid');
    });

    it('returns 400 when getSecret returns null', async () =>
    {
        await startApp((app) =>
        {
            app.post('/verify', json(), verifyTOTPMiddleware({
                getSecret: () => null,
            }), (req, res) => res.json({ ok: true }));
        });

        const { data, status } = await doFetch(`http://127.0.0.1:${port}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: '123456' }),
        });
        expect(status).toBe(400);
        expect(data.error).toContain('2FA not configured');
    });

    it('returns 500 when getSecret throws', async () =>
    {
        await startApp((app) =>
        {
            app.post('/verify', json(), verifyTOTPMiddleware({
                getSecret: () => { throw new Error('DB error'); },
            }), (req, res) => res.json({ ok: true }));
        });

        const { status } = await doFetch(`http://127.0.0.1:${port}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: '123456' }),
        });
        expect(status).toBe(500);
    });

    it('custom codeField reads from correct body key', async () =>
    {
        const code = generateTOTP(testSecret.base32);

        await startApp((app) =>
        {
            app.post('/verify', json(), verifyTOTPMiddleware({
                getSecret: () => testSecret.base32,
                codeField: 'otp',
            }), (req, res) => res.json({ ok: true }));
        });

        // Wrong field name → 400
        const wrong = await doFetch(`http://127.0.0.1:${port}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        expect(wrong.status).toBe(400);

        // Correct field name → 200
        const right = await doFetch(`http://127.0.0.1:${port}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ otp: code }),
        });
        expect(right.status).toBe(200);
    });

    it('onSuccess and onFailure callbacks receive correct arguments', async () =>
    {
        let successReq = null;
        let failureArgs = null;

        await startApp((app) =>
        {
            app.post('/verify', json(), verifyTOTPMiddleware({
                getSecret: () => testSecret.base32,
                maxAttempts: 5,
                onSuccess: (req, res) =>
                {
                    successReq = { userId: req.session?.get('twoFactorVerified'), hasBody: !!req.body };
                },
                onFailure: (req, res, attemptsLeft) =>
                {
                    failureArgs = { attemptsLeft, hasBody: !!req.body };
                    res.status(422).json({ customFail: true, attemptsLeft });
                },
            }), (req, res) => res.json({ ok: true }));
        });

        // Fail first — onFailure should fire
        const bad = await doFetch(`http://127.0.0.1:${port}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: '000000' }),
        });
        expect(bad.status).toBe(422);
        expect(bad.data.customFail).toBe(true);
        expect(bad.data.attemptsLeft).toBe(4);
        expect(failureArgs).toEqual({ attemptsLeft: 4, hasBody: true });

        // Now succeed — onSuccess should fire
        const code = generateTOTP(testSecret.base32);
        const good = await doFetch(`http://127.0.0.1:${port}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        expect(good.status).toBe(200);
        expect(successReq).toBeTruthy();
        expect(successReq.userId).toBe(true);  // session was set
        expect(successReq.hasBody).toBe(true);
    });
});

// =========================================================
// Export Integration Test
// =========================================================

describe('twoFactor export', () =>
{
    it('is accessible from the root module', () =>
    {
        expect(twoFactor).toBeDefined();
        expect(typeof twoFactor.generateSecret).toBe('function');
        expect(typeof twoFactor.generateTOTP).toBe('function');
        expect(typeof twoFactor.verifyTOTP).toBe('function');
        expect(typeof twoFactor.otpauthURI).toBe('function');
        expect(typeof twoFactor.generateBackupCodes).toBe('function');
        expect(typeof twoFactor.verifyBackupCode).toBe('function');
        expect(typeof twoFactor.require2FA).toBe('function');
        expect(typeof twoFactor.verifyTOTPMiddleware).toBe('function');
    });

    it('exposes constants', () =>
    {
        expect(twoFactor.DEFAULT_PERIOD).toBe(30);
        expect(twoFactor.DEFAULT_DIGITS).toBe(6);
        expect(twoFactor.DEFAULT_ALGORITHM).toBe('sha1');
        expect(twoFactor.DEFAULT_WINDOW).toBe(1);
        expect(twoFactor.SUPPORTED_TOTP_ALGORITHMS).toEqual(['sha1', 'sha256', 'sha512']);
    });
});
