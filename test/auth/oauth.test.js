/**
 * OAuth2 client — comprehensive tests.
 * Covers: provider presets, PKCE generation, state generation,
 * authorize URL building, callback token exchange, refresh, userInfo,
 * custom providers, error handling, and security (state validation).
 */
const crypto = require('crypto');
const { oauth, generatePKCE, generateState, OAUTH_PROVIDERS } = require('../../');

// =========================================================
// PKCE helpers
// =========================================================

describe('OAuth2: generatePKCE()', () =>
{
    it('generates a code verifier and challenge', () =>
    {
        const { codeVerifier, codeChallenge } = generatePKCE();
        expect(typeof codeVerifier).toBe('string');
        expect(typeof codeChallenge).toBe('string');
        expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
        expect(codeVerifier.length).toBeLessThanOrEqual(128);
    });

    it('challenge is SHA-256 of verifier in base64url', () =>
    {
        const { codeVerifier, codeChallenge } = generatePKCE();
        const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        expect(codeChallenge).toBe(expected);
    });

    it('each call produces unique values', () =>
    {
        const a = generatePKCE();
        const b = generatePKCE();
        expect(a.codeVerifier).not.toBe(b.codeVerifier);
        expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });

    it('respects custom length', () =>
    {
        const { codeVerifier } = generatePKCE(43);
        expect(codeVerifier.length).toBe(43);
    });
});

describe('OAuth2: generateState()', () =>
{
    it('generates a random state string', () =>
    {
        const state = generateState();
        expect(typeof state).toBe('string');
        expect(state.length).toBeGreaterThan(0);
    });

    it('each call produces unique values', () =>
    {
        const a = generateState();
        const b = generateState();
        expect(a).not.toBe(b);
    });

    it('respects custom byte count', () =>
    {
        const state = generateState(8);
        // 8 bytes → 11-12 base64url chars
        expect(state.length).toBeGreaterThanOrEqual(8);
    });
});

// =========================================================
// Provider Presets
// =========================================================

describe('OAuth2: PROVIDERS', () =>
{
    it('exports Google preset', () =>
    {
        const g = OAUTH_PROVIDERS.google;
        expect(g.authorizeUrl).toContain('google');
        expect(g.tokenUrl).toContain('google');
        expect(g.userInfoUrl).toContain('google');
        expect(g.pkce).toBe(true);
    });

    it('exports GitHub preset', () =>
    {
        const g = OAUTH_PROVIDERS.github;
        expect(g.authorizeUrl).toContain('github');
        expect(g.tokenUrl).toContain('github');
        expect(g.pkce).toBe(false);
    });

    it('exports Microsoft preset', () =>
    {
        const m = OAUTH_PROVIDERS.microsoft;
        expect(m.authorizeUrl).toContain('microsoft');
        expect(m.pkce).toBe(true);
    });

    it('exports Apple preset', () =>
    {
        const a = OAUTH_PROVIDERS.apple;
        expect(a.authorizeUrl).toContain('apple');
        expect(a.userInfoUrl).toBeNull();
        expect(a.responseMode).toBe('form_post');
    });
});

// =========================================================
// OAuth Client Factory
// =========================================================

describe('OAuth2: oauth() factory', () =>
{
    it('creates a client with built-in provider', () =>
    {
        const client = oauth({
            provider: 'github',
            clientId: 'test-id',
            clientSecret: 'test-secret',
            callbackUrl: 'http://localhost/callback',
        });
        expect(client.authorize).toBeTypeOf('function');
        expect(client.callback).toBeTypeOf('function');
        expect(client.refresh).toBeTypeOf('function');
        expect(client.userInfo).toBeTypeOf('function');
        expect(client.config).toBeDefined();
        expect(client.config.clientId).toBe('test-id');
    });

    it('creates a client with custom provider URLs', () =>
    {
        const client = oauth({
            clientId: 'custom-id',
            clientSecret: 'custom-secret',
            callbackUrl: 'http://localhost/callback',
            authorizeUrl: 'https://custom-auth.com/authorize',
            tokenUrl: 'https://custom-auth.com/token',
        });
        expect(client.config.authorizeUrl).toBe('https://custom-auth.com/authorize');
        expect(client.config.tokenUrl).toBe('https://custom-auth.com/token');
    });

    it('freezes the config object', () =>
    {
        const client = oauth({
            provider: 'github',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
        });
        expect(() => { client.config.clientId = 'hacked'; }).toThrow();
    });

    it('throws for unknown provider', () =>
    {
        expect(() => oauth({ provider: 'myspace', clientId: 'x', clientSecret: 'y', callbackUrl: 'z' }))
            .toThrow('Unknown OAuth provider');
    });

    it('throws if clientId is missing', () =>
    {
        expect(() => oauth({ clientSecret: 's', callbackUrl: 'c', authorizeUrl: 'a', tokenUrl: 't' }))
            .toThrow('clientId');
    });

    it('throws if callbackUrl is missing', () =>
    {
        expect(() => oauth({ clientId: 'id', clientSecret: 's', authorizeUrl: 'a', tokenUrl: 't' }))
            .toThrow('callbackUrl');
    });

    it('throws if authorizeUrl is missing (no provider)', () =>
    {
        expect(() => oauth({ clientId: 'id', clientSecret: 's', callbackUrl: 'c', tokenUrl: 't' }))
            .toThrow('authorizeUrl');
    });

    it('throws if tokenUrl is missing (no provider)', () =>
    {
        expect(() => oauth({ clientId: 'id', clientSecret: 's', callbackUrl: 'c', authorizeUrl: 'a' }))
            .toThrow('tokenUrl');
    });
});

// =========================================================
// authorize() — URL Building
// =========================================================

describe('OAuth2: authorize()', () =>
{
    const client = oauth({
        provider: 'google',
        clientId: 'test-client',
        clientSecret: 'test-secret',
        callbackUrl: 'http://localhost:3000/callback',
    });

    it('builds authorization URL with required params', () =>
    {
        const { url, state } = client.authorize();
        expect(url).toContain('accounts.google.com');
        expect(url).toContain('response_type=code');
        expect(url).toContain('client_id=test-client');
        expect(url).toContain(encodeURIComponent('http://localhost:3000/callback'));
        expect(url).toContain(`state=${state}`);
        expect(typeof state).toBe('string');
    });

    it('includes PKCE parameters for Google', () =>
    {
        const { url, codeVerifier } = client.authorize();
        expect(url).toContain('code_challenge=');
        expect(url).toContain('code_challenge_method=S256');
        expect(typeof codeVerifier).toBe('string');
    });

    it('does NOT include PKCE for GitHub', () =>
    {
        const ghClient = oauth({
            provider: 'github',
            clientId: 'gh-id',
            clientSecret: 'gh-secret',
            callbackUrl: 'http://localhost/cb',
        });
        const { url, codeVerifier } = ghClient.authorize();
        expect(url).not.toContain('code_challenge');
        expect(codeVerifier).toBeUndefined();
    });

    it('uses custom scope override', () =>
    {
        const { url } = client.authorize({ scope: 'profile' });
        expect(url).toContain('scope=profile');
    });

    it('uses custom state when provided', () =>
    {
        const { url, state } = client.authorize({ state: 'my-custom-state' });
        expect(state).toBe('my-custom-state');
        expect(url).toContain('state=my-custom-state');
    });

    it('merges extra params', () =>
    {
        const { url } = client.authorize({ extra: { prompt: 'consent', hd: 'example.com' } });
        expect(url).toContain('prompt=consent');
        expect(url).toContain('hd=example.com');
    });
});

// =========================================================
// callback() — Token Exchange (mock)
// =========================================================

describe('OAuth2: callback()', () =>
{
    it('rejects when no code is present', async () =>
    {
        const client = oauth({
            provider: 'github',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
        });
        await expect(client.callback({})).rejects.toThrow('No authorization code');
    });

    it('passes through provider error messages', async () =>
    {
        const client = oauth({
            provider: 'github',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
        });
        await expect(client.callback({ error: 'access_denied', error_description: 'User denied' }))
            .rejects.toThrow('User denied');
    });

    it('rejects state mismatch', async () =>
    {
        const client = oauth({
            provider: 'github',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
        });
        await expect(client.callback(
            { code: 'abc', state: 'wrong' },
            { state: 'expected' }
        )).rejects.toThrow('State mismatch');
    });

    it('exchanges code for tokens with mock fetcher', async () =>
    {
        const mockFetcher = async (url, opts) => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                access_token: 'mock-access',
                token_type: 'bearer',
                refresh_token: 'mock-refresh',
                expires_in: 3600,
            }),
            json: async () => ({
                access_token: 'mock-access',
                token_type: 'bearer',
                refresh_token: 'mock-refresh',
                expires_in: 3600,
            }),
        });

        const client = oauth({
            provider: 'github',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        const tokens = await client.callback(
            { code: 'auth-code', state: 'my-state' },
            { state: 'my-state' }
        );
        expect(tokens.access_token).toBe('mock-access');
        expect(tokens.refresh_token).toBe('mock-refresh');
    });

    it('handles URL-encoded token response (GitHub style)', async () =>
    {
        const mockFetcher = async () => ({
            ok: true,
            status: 200,
            text: async () => 'access_token=ghp_12345&token_type=bearer&scope=read%3Auser',
        });

        const client = oauth({
            provider: 'github',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        const tokens = await client.callback({ code: 'code', state: 's' }, { state: 's' });
        expect(tokens.access_token).toBe('ghp_12345');
        expect(tokens.token_type).toBe('bearer');
    });

    it('throws on token error response', async () =>
    {
        const mockFetcher = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired' }),
        });

        const client = oauth({
            provider: 'github',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        await expect(client.callback({ code: 'expired' })).rejects.toThrow('Code expired');
    });
});

// =========================================================
// refresh() — Token Refresh (mock)
// =========================================================

describe('OAuth2: refresh()', () =>
{
    it('refreshes token with mock fetcher', async () =>
    {
        const mockFetcher = async (url, opts) =>
        {
            const body = new URLSearchParams(opts.body);
            expect(body.get('grant_type')).toBe('refresh_token');
            expect(body.get('refresh_token')).toBe('rt-123');
            return {
                ok: true,
                json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
            };
        };

        const client = oauth({
            provider: 'google',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        const tokens = await client.refresh('rt-123');
        expect(tokens.access_token).toBe('new-access');
    });

    it('throws on refresh error', async () =>
    {
        const mockFetcher = async () => ({
            ok: true,
            json: async () => ({ error: 'invalid_grant' }),
        });

        const client = oauth({
            provider: 'google',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        await expect(client.refresh('bad-token')).rejects.toThrow();
    });
});

// =========================================================
// userInfo() (mock)
// =========================================================

describe('OAuth2: userInfo()', () =>
{
    it('fetches user profile', async () =>
    {
        const mockFetcher = async (url, opts) =>
        {
            expect(opts.headers.Authorization).toBe('Bearer at-123');
            return {
                ok: true,
                status: 200,
                json: async () => ({ id: '42', name: 'Alice', email: 'alice@example.com' }),
            };
        };

        const client = oauth({
            provider: 'google',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        const user = await client.userInfo('at-123');
        expect(user.name).toBe('Alice');
        expect(user.email).toBe('alice@example.com');
    });

    it('throws when no userInfoUrl is configured', async () =>
    {
        const client = oauth({
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            authorizeUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            // No userInfoUrl
        });

        await expect(client.userInfo('token')).rejects.toThrow('No userInfo endpoint');
    });

    it('throws on non-ok response', async () =>
    {
        const mockFetcher = async () => ({
            ok: false,
            status: 401,
        });

        const client = oauth({
            provider: 'google',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        await expect(client.userInfo('bad-token')).rejects.toThrow('UserInfo request failed');
    });
});

// =========================================================
// PKCE with callback (integration)
// =========================================================

describe('OAuth2: PKCE flow integration', () =>
{
    it('authorize produces PKCE params that can be used in callback', async () =>
    {
        let capturedBody;
        const mockFetcher = async (url, opts) =>
        {
            capturedBody = new URLSearchParams(opts.body);
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ access_token: 'at', token_type: 'bearer' }),
            };
        };

        const client = oauth({
            provider: 'google',
            clientId: 'id',
            clientSecret: 'secret',
            callbackUrl: 'http://localhost/cb',
            fetcher: mockFetcher,
        });

        const { state, codeVerifier } = client.authorize();

        await client.callback({ code: 'abc', state }, { state, codeVerifier });

        expect(capturedBody.get('code_verifier')).toBe(codeVerifier);
        expect(capturedBody.get('grant_type')).toBe('authorization_code');
        expect(capturedBody.get('code')).toBe('abc');
    });
});
