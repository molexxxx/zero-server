/**
 * JWT middleware — comprehensive tests.
 * Covers: sign/verify/decode, HMAC & RSA algorithms, claims validation,
 * middleware token extraction, JWKS, token pairs, and security edge cases.
 */
const crypto = require('crypto');
const http = require('http');
const { doFetch, fetch } = require('../_helpers');
const { createApp, jwt, jwtSign, jwtVerify, jwtDecode, jwks, tokenPair, createRefreshToken, SUPPORTED_ALGORITHMS, json } = require('../../');

// -- Test key material -------------------------------------------

const HMAC_SECRET = 'test-secret-at-least-32-bytes-long!';
const HMAC_SECRET_2 = 'another-secret-for-rotation-testing';

// Generate RSA key pair once for all tests
const { publicKey: RSA_PUBLIC, privateKey: RSA_PRIVATE } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// =========================================================
// sign / verify / decode — Core Functions
// =========================================================

describe('JWT Core: sign()', () =>
{
    it('produces a valid HS256 token by default', () =>
    {
        const token = jwtSign({ sub: '42' }, HMAC_SECRET);
        expect(typeof token).toBe('string');
        const parts = token.split('.');
        expect(parts).toHaveLength(3);

        const decoded = jwtDecode(token);
        expect(decoded.header.alg).toBe('HS256');
        expect(decoded.header.typ).toBe('JWT');
        expect(decoded.payload.sub).toBe('42');
        expect(decoded.payload.iat).toBeTypeOf('number');
    });

    it('sets expiresIn as exp claim', () =>
    {
        const now = Math.floor(Date.now() / 1000);
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { expiresIn: 3600 });
        const { payload } = jwtDecode(token);
        expect(payload.exp).toBeGreaterThanOrEqual(now + 3600);
        expect(payload.exp).toBeLessThanOrEqual(now + 3602);
    });

    it('sets issuer, audience, subject, jwtId claims', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, {
            issuer: 'test-issuer',
            audience: 'test-aud',
            subject: 'user-1',
            jwtId: 'unique-id',
        });
        const { payload } = jwtDecode(token);
        expect(payload.iss).toBe('test-issuer');
        expect(payload.aud).toBe('test-aud');
        expect(payload.sub).toBe('user-1');
        expect(payload.jti).toBe('unique-id');
    });

    it('sets notBefore as nbf claim', () =>
    {
        const now = Math.floor(Date.now() / 1000);
        const token = jwtSign({}, HMAC_SECRET, { notBefore: 60 });
        const { payload } = jwtDecode(token);
        expect(payload.nbf).toBeGreaterThanOrEqual(now + 60);
    });

    it('merges extra header fields', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, { header: { kid: 'key-1' } });
        const { header } = jwtDecode(token);
        expect(header.kid).toBe('key-1');
        expect(header.alg).toBe('HS256');
    });

    it('preserves explicit iat', () =>
    {
        const token = jwtSign({ iat: 1000000 }, HMAC_SECRET);
        const { payload } = jwtDecode(token);
        expect(payload.iat).toBe(1000000);
    });

    it('supports HS384', () =>
    {
        const token = jwtSign({ sub: 'x' }, HMAC_SECRET, { algorithm: 'HS384' });
        const { header } = jwtDecode(token);
        expect(header.alg).toBe('HS384');
        const result = jwtVerify(token, HMAC_SECRET, { algorithms: ['HS384'] });
        expect(result.payload.sub).toBe('x');
    });

    it('supports HS512', () =>
    {
        const token = jwtSign({ sub: 'x' }, HMAC_SECRET, { algorithm: 'HS512' });
        const result = jwtVerify(token, HMAC_SECRET, { algorithms: ['HS512'] });
        expect(result.payload.sub).toBe('x');
    });

    it('supports RS256 with RSA private key', () =>
    {
        const token = jwtSign({ sub: 'rsa' }, RSA_PRIVATE, { algorithm: 'RS256' });
        const result = jwtVerify(token, RSA_PUBLIC, { algorithms: ['RS256'] });
        expect(result.payload.sub).toBe('rsa');
    });

    it('supports RS384', () =>
    {
        const token = jwtSign({ sub: 'rsa' }, RSA_PRIVATE, { algorithm: 'RS384' });
        const result = jwtVerify(token, RSA_PUBLIC, { algorithms: ['RS384'] });
        expect(result.payload.sub).toBe('rsa');
    });

    it('supports RS512', () =>
    {
        const token = jwtSign({ sub: 'rsa' }, RSA_PRIVATE, { algorithm: 'RS512' });
        const result = jwtVerify(token, RSA_PUBLIC, { algorithms: ['RS512'] });
        expect(result.payload.sub).toBe('rsa');
    });

    it('rejects unsupported algorithm', () =>
    {
        expect(() => jwtSign({}, HMAC_SECRET, { algorithm: 'none' })).toThrow('Unsupported algorithm');
    });
});

describe('JWT Core: verify()', () =>
{
    it('verifies a valid HS256 token', () =>
    {
        const token = jwtSign({ sub: '100', role: 'admin' }, HMAC_SECRET);
        const result = jwtVerify(token, HMAC_SECRET);
        expect(result.payload.sub).toBe('100');
        expect(result.payload.role).toBe('admin');
        expect(result.header.alg).toBe('HS256');
    });

    it('rejects token with wrong secret (timing-safe)', () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET);
        expect(() => jwtVerify(token, 'wrong-secret')).toThrow('Invalid signature');
        try { jwtVerify(token, 'wrong-secret'); } catch (e) { expect(e.code).toBe('INVALID_SIGNATURE'); }
    });

    it('rejects tampered payload', () =>
    {
        const token = jwtSign({ sub: '1', role: 'user' }, HMAC_SECRET);
        const [header, , sig] = token.split('.');
        const tamperedPayload = Buffer.from(JSON.stringify({ sub: '1', role: 'admin', iat: 0 })).toString('base64url');
        expect(() => jwtVerify(`${header}.${tamperedPayload}.${sig}`, HMAC_SECRET)).toThrow('Invalid signature');
    });

    it('rejects expired token', () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { expiresIn: -10 });
        expect(() => jwtVerify(token, HMAC_SECRET)).toThrow('Token expired');
        try { jwtVerify(token, HMAC_SECRET); } catch (e) { expect(e.code).toBe('TOKEN_EXPIRED'); }
    });

    it('respects clockTolerance for expired token', () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { expiresIn: -2 });
        const result = jwtVerify(token, HMAC_SECRET, { clockTolerance: 5 });
        expect(result.payload.sub).toBe('1');
    });

    it('rejects not-yet-valid token (nbf)', () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { notBefore: 3600 });
        expect(() => jwtVerify(token, HMAC_SECRET)).toThrow('Token not yet valid');
        try { jwtVerify(token, HMAC_SECRET); } catch (e) { expect(e.code).toBe('TOKEN_NOT_ACTIVE'); }
    });

    it('respects clockTolerance for nbf', () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { notBefore: 2 });
        const result = jwtVerify(token, HMAC_SECRET, { clockTolerance: 5 });
        expect(result.payload.sub).toBe('1');
    });

    it('rejects token exceeding maxAge', () =>
    {
        const oldIat = Math.floor(Date.now() / 1000) - 3600;
        const token = jwtSign({ sub: '1', iat: oldIat }, HMAC_SECRET);
        expect(() => jwtVerify(token, HMAC_SECRET, { maxAge: 1800 })).toThrow('Token exceeds maximum age');
        try { jwtVerify(token, HMAC_SECRET, { maxAge: 1800 }); } catch (e) { expect(e.code).toBe('TOKEN_MAX_AGE'); }
    });

    it('validates audience claim (string)', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, { audience: 'api' });
        jwtVerify(token, HMAC_SECRET, { audience: 'api' }); // should not throw
        expect(() => jwtVerify(token, HMAC_SECRET, { audience: 'other' })).toThrow('aud mismatch');
    });

    it('validates audience claim (array)', () =>
    {
        const token = jwtSign({ aud: ['api', 'web'] }, HMAC_SECRET);
        jwtVerify(token, HMAC_SECRET, { audience: 'api' }); // should not throw
        jwtVerify(token, HMAC_SECRET, { audience: ['web', 'mobile'] }); // web matches
        expect(() => jwtVerify(token, HMAC_SECRET, { audience: 'mobile' })).toThrow('aud mismatch');
    });

    it('validates issuer claim (string)', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, { issuer: 'auth-server' });
        jwtVerify(token, HMAC_SECRET, { issuer: 'auth-server' });
        expect(() => jwtVerify(token, HMAC_SECRET, { issuer: 'other' })).toThrow('iss mismatch');
    });

    it('validates issuer claim (array)', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, { issuer: 'auth-server' });
        jwtVerify(token, HMAC_SECRET, { issuer: ['auth-server', 'backup'] });
        expect(() => jwtVerify(token, HMAC_SECRET, { issuer: ['other'] })).toThrow('iss mismatch');
    });

    it('validates subject claim', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, { subject: 'user-1' });
        jwtVerify(token, HMAC_SECRET, { subject: 'user-1' });
        expect(() => jwtVerify(token, HMAC_SECRET, { subject: 'user-2' })).toThrow('Subject mismatch');
    });

    it('rejects algorithm not in allowed list', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, { algorithm: 'HS256' });
        expect(() => jwtVerify(token, HMAC_SECRET, { algorithms: ['HS512'] })).toThrow('not allowed');
        try { jwtVerify(token, HMAC_SECRET, { algorithms: ['HS512'] }); } catch (e) { expect(e.code).toBe('ALGORITHM_NOT_ALLOWED'); }
    });

    it('allows ignoreExpiration', () =>
    {
        const token = jwtSign({}, HMAC_SECRET, { expiresIn: -3600 });
        const result = jwtVerify(token, HMAC_SECRET, { ignoreExpiration: true });
        expect(result.payload).toBeDefined();
    });

    it('rejects malformed token', () =>
    {
        expect(() => jwtVerify('not.a.token.at.all', HMAC_SECRET)).toThrow();
        expect(() => jwtVerify('', HMAC_SECRET)).toThrow('Malformed');
        expect(() => jwtVerify('two.parts', HMAC_SECRET)).toThrow('Malformed');
    });

    it('rejects unknown algorithm in header', () =>
    {
        // Craft a token with alg: "none"
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url');
        const fakeToken = `${header}.${payload}.`;
        expect(() => jwtVerify(fakeToken, HMAC_SECRET)).toThrow('Unsupported algorithm');
    });

    it('verifies RSA token with public key', () =>
    {
        const token = jwtSign({ sub: 'rsa-user' }, RSA_PRIVATE, { algorithm: 'RS256' });
        const result = jwtVerify(token, RSA_PUBLIC, { algorithms: ['RS256'] });
        expect(result.payload.sub).toBe('rsa-user');
    });

    it('rejects RSA token with wrong public key', () =>
    {
        const { publicKey: otherPublic } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        const token = jwtSign({ sub: 'x' }, RSA_PRIVATE, { algorithm: 'RS256' });
        expect(() => jwtVerify(token, otherPublic, { algorithms: ['RS256'] })).toThrow('Invalid signature');
    });
});

describe('JWT Core: decode()', () =>
{
    it('decodes a valid token without verification', () =>
    {
        const token = jwtSign({ sub: '42', admin: true }, HMAC_SECRET);
        const result = jwtDecode(token);
        expect(result.header.alg).toBe('HS256');
        expect(result.payload.sub).toBe('42');
        expect(result.payload.admin).toBe(true);
        expect(result.signature).toBeTypeOf('string');
    });

    it('returns null for malformed tokens', () =>
    {
        expect(jwtDecode('')).toBeNull();
        expect(jwtDecode(null)).toBeNull();
        expect(jwtDecode(undefined)).toBeNull();
        expect(jwtDecode(123)).toBeNull();
        expect(jwtDecode('not-a-jwt')).toBeNull();
        expect(jwtDecode('two.parts')).toBeNull();
    });

    it('returns null for invalid base64', () =>
    {
        expect(jwtDecode('!!!.@@@.###')).toBeNull();
    });
});

describe('JWT Core: SUPPORTED_ALGORITHMS', () =>
{
    it('exports all supported algorithms', () =>
    {
        expect(SUPPORTED_ALGORITHMS).toContain('HS256');
        expect(SUPPORTED_ALGORITHMS).toContain('HS384');
        expect(SUPPORTED_ALGORITHMS).toContain('HS512');
        expect(SUPPORTED_ALGORITHMS).toContain('RS256');
        expect(SUPPORTED_ALGORITHMS).toContain('RS384');
        expect(SUPPORTED_ALGORITHMS).toContain('RS512');
        expect(SUPPORTED_ALGORITHMS).toHaveLength(6);
    });
});

// =========================================================
// Token Pair & Refresh
// =========================================================

describe('JWT: tokenPair()', () =>
{
    it('generates access and refresh token pair', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET });
        const { accessToken, refreshToken } = tp.generateTokens({ sub: '42' });
        expect(typeof accessToken).toBe('string');
        expect(typeof refreshToken).toBe('string');
        expect(accessToken).not.toBe(refreshToken);
    });

    it('access token has short default expiry (15 min)', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET });
        const { accessToken } = tp.generateTokens({ sub: '1' });
        const now = Math.floor(Date.now() / 1000);
        const { payload } = jwtDecode(accessToken);
        expect(payload.exp).toBeGreaterThanOrEqual(now + 899);
        expect(payload.exp).toBeLessThanOrEqual(now + 901);
    });

    it('refresh token has long default expiry (7 days)', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET });
        const { refreshToken } = tp.generateTokens({ sub: '1' });
        const now = Math.floor(Date.now() / 1000);
        const { payload } = jwtDecode(refreshToken);
        expect(payload.exp).toBeGreaterThanOrEqual(now + 604799);
    });

    it('refresh token has a jti (unique ID)', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET });
        const { refreshToken } = tp.generateTokens({ sub: '1' });
        const { payload } = jwtDecode(refreshToken);
        expect(payload.jti).toBeTypeOf('string');
        expect(payload.jti.length).toBeGreaterThan(0);
    });

    it('verifyAccessToken succeeds for valid access token', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET });
        const { accessToken } = tp.generateTokens({ sub: '42' });
        const { payload } = tp.verifyAccessToken(accessToken);
        expect(payload.sub).toBe('42');
    });

    it('verifyRefreshToken succeeds for valid refresh token', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET });
        const { refreshToken } = tp.generateTokens({ sub: '42' });
        const { payload } = tp.verifyRefreshToken(refreshToken);
        expect(payload.sub).toBe('42');
    });

    it('uses separate refresh secret when configured', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET, refreshSecret: HMAC_SECRET_2 });
        const { accessToken, refreshToken } = tp.generateTokens({ sub: '1' });
        // Access token should fail with refresh secret
        expect(() => jwtVerify(accessToken, HMAC_SECRET_2)).toThrow('Invalid signature');
        // Refresh token should fail with access secret
        expect(() => jwtVerify(refreshToken, HMAC_SECRET)).toThrow('Invalid signature');
    });

    it('respects custom expiry times', () =>
    {
        const tp = tokenPair({ accessSecret: HMAC_SECRET, accessExpiresIn: 60, refreshExpiresIn: 120 });
        const { accessToken, refreshToken } = tp.generateTokens({ sub: '1' });
        const now = Math.floor(Date.now() / 1000);
        expect(jwtDecode(accessToken).payload.exp).toBeLessThanOrEqual(now + 62);
        expect(jwtDecode(refreshToken).payload.exp).toBeLessThanOrEqual(now + 122);
    });
});

describe('JWT: createRefreshToken()', () =>
{
    it('creates a refresh token with default 7-day expiry', () =>
    {
        const token = createRefreshToken({ sub: '42' }, HMAC_SECRET);
        const now = Math.floor(Date.now() / 1000);
        const { payload } = jwtDecode(token);
        expect(payload.sub).toBe('42');
        expect(payload.exp).toBeGreaterThanOrEqual(now + 604799);
    });

    it('respects custom expiry', () =>
    {
        const token = createRefreshToken({ sub: '1' }, HMAC_SECRET, { expiresIn: 300 });
        const now = Math.floor(Date.now() / 1000);
        const { payload } = jwtDecode(token);
        expect(payload.exp).toBeLessThanOrEqual(now + 302);
    });
});

// =========================================================
// JWT Middleware
// =========================================================

describe('JWT Middleware', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(json());
        app.use(jwt({ secret: HMAC_SECRET }));
        app.get('/protected', (req, res) => res.json({
            user: req.user,
            token: req.token,
            hasAuth: !!req.auth,
        }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns 401 when no token is provided', async () =>
    {
        const r = await fetch(`${base}/protected`);
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.code).toBe('CREDENTIALS_REQUIRED');
    });

    it('returns 401 for malformed token', async () =>
    {
        const r = await fetch(`${base}/protected`, {
            headers: { 'Authorization': 'Bearer not-a-jwt' },
        });
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.code).toBe('MALFORMED_TOKEN');
    });

    it('returns 401 for invalid signature', async () =>
    {
        const fakeToken = jwtSign({ sub: '1' }, 'wrong-secret');
        const r = await fetch(`${base}/protected`, {
            headers: { 'Authorization': `Bearer ${fakeToken}` },
        });
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.code).toBe('INVALID_SIGNATURE');
    });

    it('returns 401 for expired token', async () =>
    {
        const expired = jwtSign({ sub: '1' }, HMAC_SECRET, { expiresIn: -10 });
        const r = await fetch(`${base}/protected`, {
            headers: { 'Authorization': `Bearer ${expired}` },
        });
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.code).toBe('TOKEN_EXPIRED');
    });

    it('populates req.user, req.token, req.auth for valid token', async () =>
    {
        const token = jwtSign({ sub: '42', role: 'admin' }, HMAC_SECRET, { expiresIn: 3600 });
        const r = await fetch(`${base}/protected`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.user.sub).toBe('42');
        expect(body.user.role).toBe('admin');
        expect(body.token).toBe(token);
        expect(body.hasAuth).toBe(true);
    });

    it('ignores non-Bearer authorization header', async () =>
    {
        const r = await fetch(`${base}/protected`, {
            headers: { 'Authorization': 'Basic dXNlcjpwYXNz' },
        });
        expect(r.status).toBe(401);
    });
});

describe('JWT Middleware: credentialsRequired=false', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: HMAC_SECRET, credentialsRequired: false }));
        app.get('/optional', (req, res) => res.json({ user: req.user || null }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('passes through when no token (optional auth)', async () =>
    {
        const r = await fetch(`${base}/optional`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.user).toBeNull();
    });

    it('populates req.user when token is present', async () =>
    {
        const token = jwtSign({ sub: '5' }, HMAC_SECRET);
        const r = await fetch(`${base}/optional`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.user.sub).toBe('5');
    });
});

describe('JWT Middleware: custom getToken', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({
            secret: HMAC_SECRET,
            getToken: (req) => req.headers?.['x-auth-token'],
        }));
        app.get('/custom', (req, res) => res.json({ sub: req.user.sub }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('extracts token from custom header', async () =>
    {
        const token = jwtSign({ sub: 'custom' }, HMAC_SECRET);
        const r = await fetch(`${base}/custom`, {
            headers: { 'x-auth-token': token },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.sub).toBe('custom');
    });
});

describe('JWT Middleware: cookie token extraction', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        const { cookieParser } = require('../../');
        app.use(cookieParser());
        app.use(jwt({ secret: HMAC_SECRET, tokenLocation: 'cookie', cookieName: 'access_token' }));
        app.get('/cookie-auth', (req, res) => res.json({ sub: req.user.sub }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('extracts token from cookie', async () =>
    {
        const token = jwtSign({ sub: 'cookie-user' }, HMAC_SECRET);
        const r = await fetch(`${base}/cookie-auth`, {
            headers: { 'Cookie': `access_token=${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.sub).toBe('cookie-user');
    });

    it('prefers Authorization header over cookie', async () =>
    {
        const headerToken = jwtSign({ sub: 'header-user' }, HMAC_SECRET);
        const cookieToken = jwtSign({ sub: 'cookie-user' }, HMAC_SECRET);
        const r = await fetch(`${base}/cookie-auth`, {
            headers: {
                'Authorization': `Bearer ${headerToken}`,
                'Cookie': `access_token=${cookieToken}`,
            },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.sub).toBe('header-user');
    });
});

describe('JWT Middleware: query token extraction', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: HMAC_SECRET, tokenLocation: 'query', queryParam: 'jwt' }));
        app.get('/query-auth', (req, res) => res.json({ sub: req.user.sub }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('extracts token from query parameter', async () =>
    {
        const token = jwtSign({ sub: 'query-user' }, HMAC_SECRET);
        const r = await fetch(`${base}/query-auth?jwt=${token}`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.sub).toBe('query-user');
    });
});

describe('JWT Middleware: isRevoked', () =>
{
    const revokedIds = new Set();
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({
            secret: HMAC_SECRET,
            isRevoked: async (payload) => revokedIds.has(payload.jti),
        }));
        app.get('/revoke-test', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('passes for non-revoked token', async () =>
    {
        const token = jwtSign({ sub: '1', jti: 'valid-id' }, HMAC_SECRET);
        const r = await fetch(`${base}/revoke-test`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('returns 401 for revoked token', async () =>
    {
        revokedIds.add('revoked-id');
        const token = jwtSign({ sub: '1', jti: 'revoked-id' }, HMAC_SECRET);
        const r = await fetch(`${base}/revoke-test`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.code).toBe('TOKEN_REVOKED');
    });
});

describe('JWT Middleware: custom onError', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({
            secret: HMAC_SECRET,
            onError: (err, req, res) =>
            {
                res.status(err.statusCode).json({ custom: true, msg: err.message });
            },
        }));
        app.get('/custom-error', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('calls custom onError handler', async () =>
    {
        const r = await fetch(`${base}/custom-error`);
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.custom).toBe(true);
    });
});

describe('JWT Middleware: audience/issuer validation', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ secret: HMAC_SECRET, audience: 'my-api', issuer: 'auth-server' }));
        app.get('/claims', (req, res) => res.json({ sub: req.user.sub }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('rejects token with wrong audience', async () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { audience: 'other-api', issuer: 'auth-server' });
        const r = await fetch(`${base}/claims`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(401);
    });

    it('rejects token with wrong issuer', async () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { audience: 'my-api', issuer: 'other-server' });
        const r = await fetch(`${base}/claims`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(401);
    });

    it('accepts token with correct audience and issuer', async () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET, { audience: 'my-api', issuer: 'auth-server' });
        const r = await fetch(`${base}/claims`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });
});

describe('JWT Middleware: RSA with publicKey', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({ publicKey: RSA_PUBLIC, algorithms: ['RS256'] }));
        app.get('/rsa', (req, res) => res.json({ sub: req.user.sub }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('verifies RSA-signed token', async () =>
    {
        const token = jwtSign({ sub: 'rsa-user' }, RSA_PRIVATE, { algorithm: 'RS256' });
        const r = await fetch(`${base}/rsa`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.sub).toBe('rsa-user');
    });
});

describe('JWT Middleware: dynamic getKey', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({
            getKey: async (header, payload) =>
            {
                if (header.kid === 'rsa-1') return RSA_PUBLIC;
                if (header.kid === 'hmac-1') return HMAC_SECRET;
                throw new Error('Unknown kid');
            },
        }));
        app.get('/dynamic', (req, res) => res.json({ sub: req.user.sub }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('resolves RSA key by kid', async () =>
    {
        const token = jwtSign({ sub: 'rsa' }, RSA_PRIVATE, { algorithm: 'RS256', header: { kid: 'rsa-1' } });
        const r = await fetch(`${base}/dynamic`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });

    it('resolves HMAC key by kid', async () =>
    {
        const token = jwtSign({ sub: 'hmac' }, HMAC_SECRET, { header: { kid: 'hmac-1' } });
        const r = await fetch(`${base}/dynamic`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
    });
});

describe('JWT factory: validation', () =>
{
    it('throws if no secret/publicKey/getKey/jwksUri provided', () =>
    {
        expect(() => jwt({})).toThrow('jwt() requires');
    });
});

// =========================================================
// JWKS Key Provider
// =========================================================

describe('JWT: jwks()', () =>
{
    // Build a real RSA JWK from our test key pair
    const jwkObj = crypto.createPublicKey(RSA_PUBLIC).export({ format: 'jwk' });
    jwkObj.kid = 'test-kid-1';
    jwkObj.use = 'sig';

    function mockFetcher(body, status = 200)
    {
        return async () => ({
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
        });
    }

    it('fetches keys and resolves by kid', async () =>
    {
        const getKey = jwks('https://example.com/.well-known/jwks.json', {
            fetcher: mockFetcher({ keys: [jwkObj] }),
        });
        const pem = await getKey({ kid: 'test-kid-1', alg: 'RS256' });
        expect(pem).toContain('-----BEGIN PUBLIC KEY-----');

        // Verify the returned PEM actually works
        const token = jwtSign({ sub: 'jwks-user' }, RSA_PRIVATE, { algorithm: 'RS256', header: { kid: 'test-kid-1' } });
        const result = jwtVerify(token, pem, { algorithms: ['RS256'] });
        expect(result.payload.sub).toBe('jwks-user');
    });

    it('caches keys and does not re-fetch within TTL', async () =>
    {
        let fetchCount = 0;
        const fetcher = async () =>
        {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ keys: [jwkObj] }) };
        };
        const getKey = jwks('https://example.com/jwks', { fetcher, cacheTtl: 60000 });

        await getKey({ kid: 'test-kid-1' });
        await getKey({ kid: 'test-kid-1' });
        expect(fetchCount).toBe(1);
    });

    it('force-refreshes cache when kid is not found', async () =>
    {
        let fetchCount = 0;
        const jwk2 = { ...jwkObj, kid: 'new-kid' };
        const fetcher = async () =>
        {
            fetchCount++;
            const keys = fetchCount === 1 ? [jwkObj] : [jwkObj, jwk2];
            return { ok: true, status: 200, json: async () => ({ keys }) };
        };
        const getKey = jwks('https://example.com/jwks', { fetcher, cacheTtl: 60000 });

        await getKey({ kid: 'test-kid-1' });
        expect(fetchCount).toBe(1);

        // Request unknown kid — triggers refresh
        const pem = await getKey({ kid: 'new-kid' });
        expect(fetchCount).toBe(2);
        expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    });

    it('throws JWKS_KID_NOT_FOUND when kid is missing after refresh', async () =>
    {
        const getKey = jwks('https://example.com/jwks', {
            fetcher: mockFetcher({ keys: [jwkObj] }),
        });
        await expect(getKey({ kid: 'nonexistent' })).rejects.toThrow('not found in JWKS');
    });

    it('returns first key when no kid in header', async () =>
    {
        const getKey = jwks('https://example.com/jwks', {
            fetcher: mockFetcher({ keys: [jwkObj] }),
        });
        const pem = await getKey({ alg: 'RS256' });
        expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    });

    it('throws JWKS_NO_KEY when keystore is empty', async () =>
    {
        const getKey = jwks('https://example.com/jwks', {
            fetcher: mockFetcher({ keys: [] }),
        });
        await expect(getKey({ alg: 'RS256' })).rejects.toThrow('No suitable key');
    });

    it('throws JWKS_FETCH_FAILED on non-200 response', async () =>
    {
        const getKey = jwks('https://example.com/jwks', {
            fetcher: mockFetcher({}, 500),
        });
        await expect(getKey({ kid: 'x' })).rejects.toThrow('JWKS fetch failed');
    });

    it('throws JWKS_INVALID when response has no keys array', async () =>
    {
        const getKey = jwks('https://example.com/jwks', {
            fetcher: mockFetcher({ something: 'else' }),
        });
        await expect(getKey({ kid: 'x' })).rejects.toThrow('Invalid JWKS response');
    });

    it('skips JWK with use=enc', async () =>
    {
        const encKey = { ...jwkObj, kid: 'enc-key', use: 'enc' };
        const getKey = jwks('https://example.com/jwks', {
            fetcher: mockFetcher({ keys: [encKey] }),
        });
        await expect(getKey({ alg: 'RS256' })).rejects.toThrow('No suitable key');
    });

    it('_clearCache resets internal state', async () =>
    {
        let fetchCount = 0;
        const fetcher = async () =>
        {
            fetchCount++;
            return { ok: true, status: 200, json: async () => ({ keys: [jwkObj] }) };
        };
        const getKey = jwks('https://example.com/jwks', { fetcher, cacheTtl: 60000 });

        await getKey({ kid: 'test-kid-1' });
        expect(fetchCount).toBe(1);

        getKey._clearCache();
        await getKey({ kid: 'test-kid-1' });
        expect(fetchCount).toBe(2);
    });
});

// =========================================================
// JWT Middleware: jwksUri integration
// =========================================================

describe('JWT Middleware: jwksUri option', () =>
{
    let server, base;
    const jwkObj = crypto.createPublicKey(RSA_PUBLIC).export({ format: 'jwk' });
    jwkObj.kid = 'mw-kid';
    jwkObj.use = 'sig';

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({
            jwksUri: 'https://auth.example.com/.well-known/jwks.json',
            fetcher: async () => ({
                ok: true,
                status: 200,
                json: async () => ({ keys: [jwkObj] }),
            }),
            algorithms: ['RS256'],
        }));
        app.get('/jwks-protected', (req, res) => res.json({ sub: req.user.sub }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('verifies token via JWKS-resolved key', async () =>
    {
        const token = jwtSign({ sub: 'jwks-mw' }, RSA_PRIVATE, { algorithm: 'RS256', header: { kid: 'mw-kid' } });
        const r = await fetch(`${base}/jwks-protected`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.sub).toBe('jwks-mw');
    });
});

// =========================================================
// Middleware catch-all error path
// =========================================================

describe('JWT Middleware: getKey error propagation', () =>
{
    let server, base;

    beforeAll(async () =>
    {
        const app = createApp();
        app.use(jwt({
            getKey: async () => { throw new Error('key resolution failed'); },
        }));
        app.get('/err', (req, res) => res.json({ ok: true }));
        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('returns 401 with error code when getKey throws', async () =>
    {
        const token = jwtSign({ sub: '1' }, HMAC_SECRET);
        const r = await fetch(`${base}/err`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.code).toBe('INVALID_TOKEN');
    });
});
