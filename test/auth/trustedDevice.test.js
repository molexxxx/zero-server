const crypto = require('crypto');
const {
    trustedDevice,
    _encrypt,
    _decrypt,
    _deriveKey,
    _matchIPSubnet,
} = require('../../lib/auth/trustedDevice');

// =========================================================
// _deriveKey
// =========================================================

describe('_deriveKey', () =>
{
    it('should produce a 32-byte Buffer from a string secret', () =>
    {
        const key = _deriveKey('my-secret-key');
        expect(Buffer.isBuffer(key)).toBe(true);
        expect(key.length).toBe(32);
    });

    it('should produce deterministic output', () =>
    {
        const a = _deriveKey('same-secret');
        const b = _deriveKey('same-secret');
        expect(a.equals(b)).toBe(true);
    });

    it('should produce different keys for different secrets', () =>
    {
        const a = _deriveKey('secret-a');
        const b = _deriveKey('secret-b');
        expect(a.equals(b)).toBe(false);
    });
});

// =========================================================
// _encrypt / _decrypt roundtrip
// =========================================================

describe('_encrypt / _decrypt', () =>
{
    const secret = 'test-encryption-secret-32-chars!!';

    it('should roundtrip a simple object', () =>
    {
        const payload = { uid: 'user-1', fp: 'abc', iat: Date.now(), exp: Date.now() + 86400000 };
        const token = _encrypt(payload, secret);
        const result = _decrypt(token, secret);
        expect(result).toEqual(payload);
    });

    it('should produce different ciphertexts for same payload (random IV)', () =>
    {
        const payload = { uid: 'user-1', iat: 1 };
        const t1 = _encrypt(payload, secret);
        const t2 = _encrypt(payload, secret);
        expect(t1).not.toBe(t2);
    });

    it('should return null for wrong secret', () =>
    {
        const token = _encrypt({ uid: '1' }, secret);
        const result = _decrypt(token, 'wrong-secret-that-is-different!!');
        expect(result).toBeNull();
    });

    it('should return null for tampered token', () =>
    {
        const token = _encrypt({ uid: '1' }, secret);
        // Flip a byte in the middle
        const buf = Buffer.from(token, 'base64url');
        buf[20] ^= 0xff;
        const tampered = buf.toString('base64url');
        expect(_decrypt(tampered, secret)).toBeNull();
    });

    it('should return null for empty token', () =>
    {
        expect(_decrypt('', secret)).toBeNull();
    });

    it('should return null for token too short', () =>
    {
        const short = Buffer.alloc(10).toString('base64url');
        expect(_decrypt(short, secret)).toBeNull();
    });

    it('should handle complex nested payloads', () =>
    {
        const payload = { uid: 'u', nested: { a: [1, 2, 3] }, flag: true };
        const token = _encrypt(payload, secret);
        expect(_decrypt(token, secret)).toEqual(payload);
    });

    it('should handle unicode in payload', () =>
    {
        const payload = { uid: '日本語', fp: '→€' };
        const token = _encrypt(payload, secret);
        expect(_decrypt(token, secret)).toEqual(payload);
    });
});

// =========================================================
// trustedDevice.issue
// =========================================================

describe('trustedDevice.issue', () =>
{
    it('should throw without secret', () =>
    {
        expect(() => trustedDevice.issue({})).toThrow('secret');
    });

    it('should throw with no opts', () =>
    {
        expect(() => trustedDevice.issue()).toThrow();
    });

    it('should set a cookie and call next', async () =>
    {
        const mw = trustedDevice.issue({
            secret: 'test-secret-32-characters-long!!',
            getUserId: () => 'user-1',
        });

        const req = {
            user: { id: 'user-1' },
            headers: { 'user-agent': 'test-agent' },
        };
        const res = {
            _headers: {},
            headersSent: false,
            getHeader(k) { return this._headers[k.toLowerCase()]; },
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            raw: null,
        };
        res.raw = res;

        let nextCalled = false;
        await mw(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);

        const cookies = res._headers['set-cookie'];
        expect(cookies).toBeDefined();
        expect(Array.isArray(cookies)).toBe(true);
        const dtCookie = cookies.find(c => c.startsWith('_dt='));
        expect(dtCookie).toBeDefined();
        expect(dtCookie).toContain('HttpOnly');
        expect(dtCookie).toContain('Secure');
        expect(dtCookie).toContain('SameSite=Strict');
    });

    it('should use custom cookie name', async () =>
    {
        const mw = trustedDevice.issue({
            secret: 'test-secret-32-characters-long!!',
            cookieName: 'trust',
        });

        const req = { user: { id: '1' }, headers: { 'user-agent': 'test' } };
        const res = {
            _headers: {},
            headersSent: false,
            getHeader(k) { return this._headers[k.toLowerCase()]; },
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            raw: null,
        };
        res.raw = res;

        await mw(req, res, () => {});
        const cookies = res._headers['set-cookie'];
        const cookie = cookies.find(c => c.startsWith('trust='));
        expect(cookie).toBeDefined();
    });

    it('should call next even if user extraction fails', async () =>
    {
        const mw = trustedDevice.issue({
            secret: 'test-secret-32-characters-long!!',
            getUserId: () => { throw new Error('no user'); },
        });

        const req = { headers: {} };
        const res = {
            _headers: {},
            headersSent: false,
            getHeader(k) { return this._headers[k.toLowerCase()]; },
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            raw: null,
        };
        res.raw = res;

        let nextCalled = false;
        await mw(req, res, () => { nextCalled = true; });
        // Should still call next — error is logged but not thrown
        expect(nextCalled).toBe(true);
    });
});

// =========================================================
// trustedDevice.verify
// =========================================================

describe('trustedDevice.verify', () =>
{
    const secret = 'test-secret-32-characters-long!!';

    it('should throw without secret', () =>
    {
        expect(() => trustedDevice.verify({})).toThrow('secret');
    });

    it('should return false when no cookie present', async () =>
    {
        const check = trustedDevice.verify({ secret });
        const req = { headers: {}, user: { id: '1' } };
        const result = await check(req);
        expect(result).toBe(false);
    });

    it('should return true for valid token', async () =>
    {
        const payload = {
            uid: 'user-1',
            fp: crypto.createHash('sha256').update('test-agent').digest('hex').substring(0, 16),
            iat: Date.now(),
            exp: Date.now() + 86400000,
        };
        const token = _encrypt(payload, secret);

        const check = trustedDevice.verify({
            secret,
            getUserId: () => 'user-1',
        });

        const req = {
            user: { id: 'user-1' },
            headers: { cookie: `_dt=${token}`, 'user-agent': 'test-agent' },
        };
        const result = await check(req);
        expect(result).toBe(true);
    });

    it('should return false for expired token', async () =>
    {
        const payload = {
            uid: 'user-1',
            fp: null,
            iat: Date.now() - 200000,
            exp: Date.now() - 100000, // already expired
        };
        const token = _encrypt(payload, secret);

        const check = trustedDevice.verify({
            secret,
            getUserId: () => 'user-1',
        });

        const req = {
            user: { id: 'user-1' },
            headers: { cookie: `_dt=${token}` },
        };
        const result = await check(req);
        expect(result).toBe(false);
    });

    it('should return false for wrong user', async () =>
    {
        const payload = { uid: 'user-2', fp: null, iat: Date.now(), exp: Date.now() + 86400000 };
        const token = _encrypt(payload, secret);

        const check = trustedDevice.verify({
            secret,
            getUserId: () => 'user-1', // mismatch
        });

        const req = {
            user: { id: 'user-1' },
            headers: { cookie: `_dt=${token}` },
        };
        const result = await check(req);
        expect(result).toBe(false);
    });

    it('should support secret rotation with previousSecrets', async () =>
    {
        const oldSecret = 'old-secret-32-characters-long!!!';
        const newSecret = 'new-secret-32-characters-long!!!';

        const payload = { uid: 'user-1', fp: null, iat: Date.now(), exp: Date.now() + 86400000 };
        const token = _encrypt(payload, oldSecret); // encrypted with old secret

        const check = trustedDevice.verify({
            secret: newSecret,
            previousSecrets: [oldSecret],
            getUserId: () => 'user-1',
        });

        const req = {
            user: { id: 'user-1' },
            headers: { cookie: `_dt=${token}` },
        };
        const result = await check(req);
        expect(result).toBe(true);
    });

    it('should return false for fingerprint mismatch', async () =>
    {
        const fpHash = crypto.createHash('sha256').update('agent-a').digest('hex').substring(0, 16);
        const payload = { uid: 'user-1', fp: fpHash, iat: Date.now(), exp: Date.now() + 86400000 };
        const token = _encrypt(payload, secret);

        const check = trustedDevice.verify({
            secret,
            getUserId: () => 'user-1',
        });

        const req = {
            user: { id: 'user-1' },
            headers: { cookie: `_dt=${token}`, 'user-agent': 'agent-b' }, // different agent
        };
        const result = await check(req);
        expect(result).toBe(false);
    });

    it('should read from parsed cookies if available', async () =>
    {
        const payload = { uid: 'user-1', fp: null, iat: Date.now(), exp: Date.now() + 86400000 };
        const token = _encrypt(payload, secret);

        const check = trustedDevice.verify({
            secret,
            getUserId: () => 'user-1',
        });

        const req = {
            user: { id: 'user-1' },
            headers: {},
            cookies: { _dt: token },
        };
        const result = await check(req);
        expect(result).toBe(true);
    });

    it('should handle getUserId throwing gracefully', async () =>
    {
        const payload = { uid: 'user-1', fp: null, iat: Date.now(), exp: Date.now() + 86400000 };
        const token = _encrypt(payload, secret);

        const check = trustedDevice.verify({
            secret,
            getUserId: () => { throw new Error('no user'); },
        });

        const req = {
            headers: { cookie: `_dt=${token}` },
        };
        const result = await check(req);
        expect(result).toBe(false);
    });

    it('should accept previousSecrets as a single string', async () =>
    {
        const oldSecret = 'old-secret-32-characters-long!!!';
        const newSecret = 'new-secret-32-characters-long!!!';

        const payload = { uid: 'user-1', fp: null, iat: Date.now(), exp: Date.now() + 86400000 };
        const token = _encrypt(payload, oldSecret);

        const check = trustedDevice.verify({
            secret: newSecret,
            previousSecrets: oldSecret, // string, not array
            getUserId: () => 'user-1',
        });

        const req = {
            user: { id: 'user-1' },
            headers: { cookie: `_dt=${token}` },
        };
        expect(await check(req)).toBe(true);
    });
});

// =========================================================
// trustedDevice.revoke
// =========================================================

describe('trustedDevice.revoke', () =>
{
    it('should clear cookie and call next', () =>
    {
        const mw = trustedDevice.revoke();
        const res = {
            _headers: {},
            headersSent: false,
            getHeader(k) { return this._headers[k.toLowerCase()]; },
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            raw: null,
        };
        res.raw = res;

        let nextCalled = false;
        mw({}, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);

        const cookies = res._headers['set-cookie'];
        expect(cookies).toBeDefined();
        const clearCookie = cookies.find(c => c.startsWith('_dt='));
        expect(clearCookie).toContain('Max-Age=0');
    });

    it('should use custom cookie name', () =>
    {
        const mw = trustedDevice.revoke({ cookieName: 'trust' });
        const res = {
            _headers: {},
            headersSent: false,
            getHeader(k) { return this._headers[k.toLowerCase()]; },
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            raw: null,
        };
        res.raw = res;

        mw({}, res, () => {});
        const cookies = res._headers['set-cookie'];
        const clearCookie = cookies.find(c => c.startsWith('trust='));
        expect(clearCookie).toBeDefined();
        expect(clearCookie).toContain('Max-Age=0');
    });
});

// =========================================================
// _matchIPSubnet
// =========================================================

describe('_matchIPSubnet', () =>
{
    it('should return true for same /24 subnet', () =>
    {
        expect(_matchIPSubnet('192.168.1.100', '192.168.1.200')).toBe(true);
    });

    it('should return false for different /24 subnet', () =>
    {
        expect(_matchIPSubnet('192.168.1.100', '192.168.2.100')).toBe(false);
    });

    it('should return false for completely different IPs', () =>
    {
        expect(_matchIPSubnet('10.0.0.1', '192.168.1.1')).toBe(false);
    });

    it('should return false when stored IP is not valid IPv4', () =>
    {
        expect(_matchIPSubnet('not-an-ip', '192.168.1.1')).toBe(false);
    });

    it('should return false when current IP is not valid IPv4', () =>
    {
        expect(_matchIPSubnet('192.168.1.1', '::1')).toBe(false);
    });

    it('should return false for IPv6', () =>
    {
        expect(_matchIPSubnet('::1', '::1')).toBe(false);
    });

    it('should return false for partial IP', () =>
    {
        expect(_matchIPSubnet('192.168.1', '192.168.1.1')).toBe(false);
    });

    it('should handle IPs at subnet boundary', () =>
    {
        expect(_matchIPSubnet('10.0.0.0', '10.0.0.255')).toBe(true);
    });
});

// =========================================================
// verify — checkIP option
// =========================================================

describe('verify — IP subnet check', () =>
{
    const secret = 'x'.repeat(32);

    it('should pass when checkIP=true and IPs match /24', async () =>
    {
        const payload = {
            uid: 'u1',
            fp: null,
            iat: Date.now(),
            exp: Date.now() + 3600000,
            ip: '10.0.0.50',
        };
        const token = _encrypt(payload, secret);

        const checker = trustedDevice.verify({
            secret,
            checkIP: true,
            getUserId: () => 'u1',
        });

        const req = {
            headers: { cookie: '_dt=' + token },
            ip: '10.0.0.99',
            user: { id: 'u1' },
        };

        expect(await checker(req)).toBe(true);
    });

    it('should fail when checkIP=true and IPs differ /24', async () =>
    {
        const payload = {
            uid: 'u1',
            fp: null,
            iat: Date.now(),
            exp: Date.now() + 3600000,
            ip: '10.0.0.50',
        };
        const token = _encrypt(payload, secret);

        const checker = trustedDevice.verify({
            secret,
            checkIP: true,
            getUserId: () => 'u1',
        });

        const req = {
            headers: { cookie: '_dt=' + token },
            ip: '10.0.1.50',
            user: { id: 'u1' },
        };

        expect(await checker(req)).toBe(false);
    });

    it('should skip IP check when payload has no ip field', async () =>
    {
        const payload = {
            uid: 'u1',
            fp: null,
            iat: Date.now(),
            exp: Date.now() + 3600000,
        };
        const token = _encrypt(payload, secret);

        const checker = trustedDevice.verify({
            secret,
            checkIP: true,
            getUserId: () => 'u1',
        });

        const req = {
            headers: { cookie: '_dt=' + token },
            ip: '10.0.1.50',
            user: { id: 'u1' },
        };

        expect(await checker(req)).toBe(true);
    });

    it('should use socket.remoteAddress as fallback', async () =>
    {
        const payload = {
            uid: 'u1',
            fp: null,
            iat: Date.now(),
            exp: Date.now() + 3600000,
            ip: '10.0.0.50',
        };
        const token = _encrypt(payload, secret);

        const checker = trustedDevice.verify({
            secret,
            checkIP: true,
            getUserId: () => 'u1',
        });

        const req = {
            headers: { cookie: '_dt=' + token },
            socket: { remoteAddress: '10.0.0.200' },
            user: { id: 'u1' },
        };

        expect(await checker(req)).toBe(true);
    });
});

// =========================================================
// verify — fingerprint error path
// =========================================================

describe('verify — fingerprint error catch', () =>
{
    const secret = 'a'.repeat(32);

    it('should return false when getFingerprint throws', async () =>
    {
        const payload = {
            uid: 'u1',
            fp: 'deadbeef01234567',
            iat: Date.now(),
            exp: Date.now() + 3600000,
        };
        const token = _encrypt(payload, secret);

        const checker = trustedDevice.verify({
            secret,
            fingerprint: () => { throw new Error('hw error'); },
            getUserId: () => 'u1',
        });

        const req = {
            headers: { cookie: '_dt=' + token },
            user: { id: 'u1' },
        };

        expect(await checker(req)).toBe(false);
    });

    it('should pass when fingerprint returns falsy and payload has fp', async () =>
    {
        const payload = {
            uid: 'u1',
            fp: 'deadbeef01234567',
            iat: Date.now(),
            exp: Date.now() + 3600000,
        };
        const token = _encrypt(payload, secret);

        const checker = trustedDevice.verify({
            secret,
            fingerprint: () => '',
            getUserId: () => 'u1',
        });

        const req = {
            headers: { cookie: '_dt=' + token },
            user: { id: 'u1' },
        };

        // When getFingerprint returns falsy, fp check is skipped
        expect(await checker(req)).toBe(true);
    });
});
