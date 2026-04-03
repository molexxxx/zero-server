/**
 * @module auth/oauth
 * @description Zero-dependency OAuth 2.0 client with PKCE support.
 *              Built-in provider presets for Google, GitHub, Microsoft, and Apple.
 *              Uses the Authorization Code flow with PKCE for maximum security.
 *
 * @example
 *   const { oauth } = require('zero-http');
 *   const github = oauth({
 *       provider: 'github',
 *       clientId: process.env.GITHUB_CLIENT_ID,
 *       clientSecret: process.env.GITHUB_CLIENT_SECRET,
 *       callbackUrl: 'https://myapp.com/auth/github/callback',
 *   });
 *
 *   app.get('/auth/github', (req, res) => {
 *       const { url, state, codeVerifier } = github.authorize({ scope: 'user:email' });
 *       req.session.set('oauth_state', state);
 *       req.session.set('oauth_verifier', codeVerifier);
 *       res.redirect(url);
 *   });
 *
 *   app.get('/auth/github/callback', async (req, res) => {
 *       const tokens = await github.callback(req.query, {
 *           state: req.session.get('oauth_state'),
 *           codeVerifier: req.session.get('oauth_verifier'),
 *       });
 *       const user = await github.userInfo(tokens.access_token);
 *       res.json(user);
 *   });
 */
const crypto = require('crypto');
const log = require('../debug')('zero:oauth');

// -- Built-in Provider Presets -----------------------------------

/** @private */
const PROVIDERS = {
    google: {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
        scope: 'openid profile email',
        pkce: true,
    },
    github: {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        scope: 'read:user user:email',
        pkce: false, // GitHub doesn't support PKCE
    },
    microsoft: {
        authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
        scope: 'openid profile email',
        pkce: true,
    },
    apple: {
        authorizeUrl: 'https://appleid.apple.com/auth/authorize',
        tokenUrl: 'https://appleid.apple.com/auth/token',
        userInfoUrl: null,  // Apple returns user info in the id_token
        scope: 'name email',
        pkce: true,
        responseMode: 'form_post',
    },
};

// -- PKCE Helpers ------------------------------------------------

/**
 * Generate a PKCE code verifier and challenge.
 *
 * @param {number} [length=64] - Verifier length (43–128 per RFC 7636).
 * @returns {{ codeVerifier: string, codeChallenge: string }}
 *
 * @example
 *   const { codeVerifier, codeChallenge } = generatePKCE();
 */
function generatePKCE(length = 64)
{
    const verifier = crypto.randomBytes(length).toString('base64url').slice(0, Math.max(43, Math.min(length, 128)));
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { codeVerifier: verifier, codeChallenge: challenge };
}

/**
 * Generate a cryptographically random state parameter.
 *
 * @param {number} [bytes=32] - Entropy bytes.
 * @returns {string} URL-safe random string.
 */
function generateState(bytes = 32)
{
    return crypto.randomBytes(bytes).toString('base64url');
}

// -- OAuth2 Client -----------------------------------------------

/**
 * Create an OAuth 2.0 client for Authorization Code flow (+ PKCE).
 *
 * @param {object} opts - Configuration.
 * @param {string} [opts.provider] - Built-in provider name (`'google'`, `'github'`, `'microsoft'`, `'apple'`).
 * @param {string} opts.clientId - OAuth client ID.
 * @param {string} opts.clientSecret - OAuth client secret.
 * @param {string} opts.callbackUrl - Redirect URI.
 * @param {string} [opts.authorizeUrl] - Authorization endpoint URL (overrides provider).
 * @param {string} [opts.tokenUrl] - Token endpoint URL (overrides provider).
 * @param {string} [opts.userInfoUrl] - UserInfo endpoint URL (overrides provider).
 * @param {string} [opts.scope] - Default scopes (space-separated).
 * @param {boolean} [opts.pkce=true] - Enable PKCE (default: true if provider supports it).
 * @param {string} [opts.responseMode] - Response mode override (e.g. `'form_post'` for Apple).
 * @param {Function} [opts.fetcher] - Custom HTTP fetch function (default: built-in fetch).
 * @param {number} [opts.timeout=10000] - HTTP request timeout in ms.
 * @returns {{ authorize: Function, callback: Function, refresh: Function, userInfo: Function }}
 *
 * @example
 *   const client = oauth({
 *       provider: 'google',
 *       clientId: 'xxx',
 *       clientSecret: 'yyy',
 *       callbackUrl: 'https://app.com/callback',
 *   });
 *
 *   // Build auth URL
 *   const { url, state, codeVerifier } = client.authorize();
 *
 *   // Exchange code for tokens
 *   const tokens = await client.callback(req.query, { state: savedState, codeVerifier });
 */
function oauth(opts = {})
{
    const preset = opts.provider ? PROVIDERS[opts.provider] : {};
    if (opts.provider && !preset) throw new Error(`Unknown OAuth provider: ${opts.provider}`);

    const config = {
        authorizeUrl: opts.authorizeUrl || preset.authorizeUrl,
        tokenUrl: opts.tokenUrl || preset.tokenUrl,
        userInfoUrl: opts.userInfoUrl || preset.userInfoUrl || null,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        callbackUrl: opts.callbackUrl,
        scope: opts.scope || preset.scope || '',
        pkce: opts.pkce !== undefined ? opts.pkce : (preset.pkce !== false),
        responseMode: opts.responseMode || preset.responseMode || null,
        timeout: opts.timeout || 10000,
    };

    if (!config.clientId) throw new Error('oauth() requires clientId');
    if (!config.callbackUrl) throw new Error('oauth() requires callbackUrl');
    if (!config.authorizeUrl) throw new Error('oauth() requires authorizeUrl');
    if (!config.tokenUrl) throw new Error('oauth() requires tokenUrl');

    const fetchFn = opts.fetcher || require('../fetch');

    return {
        /**
         * Build the authorization URL the user should be redirected to.
         *
         * @param {object} [params] - Extra parameters.
         * @param {string} [params.scope] - Override scopes.
         * @param {string} [params.state] - Override state (auto-generated if omitted).
         * @param {object} [params.extra] - Additional query params to include.
         * @returns {{ url: string, state: string, codeVerifier?: string }}
         */
        authorize(params = {})
        {
            const state = params.state || generateState();
            const scope = params.scope || config.scope;

            const query = new URLSearchParams({
                response_type: 'code',
                client_id: config.clientId,
                redirect_uri: config.callbackUrl,
                state,
            });

            if (scope) query.set('scope', scope);
            if (config.responseMode) query.set('response_mode', config.responseMode);

            let codeVerifier;
            if (config.pkce)
            {
                const pkce = generatePKCE();
                codeVerifier = pkce.codeVerifier;
                query.set('code_challenge', pkce.codeChallenge);
                query.set('code_challenge_method', 'S256');
            }

            // Merge extra params
            if (params.extra)
            {
                for (const [k, v] of Object.entries(params.extra)) query.set(k, v);
            }

            const sep = config.authorizeUrl.includes('?') ? '&' : '?';
            const url = `${config.authorizeUrl}${sep}${query.toString()}`;

            log.debug('authorize URL built for %s', config.clientId);
            return { url, state, codeVerifier };
        },

        /**
         * Exchange an authorization code for tokens.
         * Validates the state parameter to prevent CSRF.
         *
         * @param {object} query - Callback query/body params (`{ code, state }`).
         * @param {object} [verify] - Verification context.
         * @param {string} [verify.state] - Expected state (must match `query.state`).
         * @param {string} [verify.codeVerifier] - PKCE code verifier.
         * @returns {Promise<{ access_token: string, token_type: string, expires_in?: number, refresh_token?: string, id_token?: string, scope?: string }>}
         * @throws {Error} If state mismatches, code is missing, or token exchange fails.
         */
        async callback(query, verify = {})
        {
            if (!query || !query.code)
            {
                const errMsg = query?.error_description || query?.error || 'No authorization code received';
                throw _oauthError(errMsg, 'OAUTH_NO_CODE');
            }

            // Validate state (CSRF prevention)
            if (verify.state && query.state !== verify.state)
            {
                throw _oauthError('State mismatch — possible CSRF attack', 'OAUTH_STATE_MISMATCH');
            }

            const body = {
                grant_type: 'authorization_code',
                code: query.code,
                redirect_uri: config.callbackUrl,
                client_id: config.clientId,
            };

            if (config.clientSecret) body.client_secret = config.clientSecret;

            if (verify.codeVerifier)
            {
                body.code_verifier = verify.codeVerifier;
            }

            log.debug('exchanging code for tokens at %s', config.tokenUrl);
            const res = await fetchFn(config.tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: new URLSearchParams(body).toString(),
                timeout: config.timeout,
            });

            const text = await res.text();
            let tokens;
            try
            {
                tokens = JSON.parse(text);
            }
            catch (_)
            {
                // Some providers (GitHub) return url-encoded responses
                tokens = Object.fromEntries(new URLSearchParams(text));
            }

            if (tokens.error)
            {
                throw _oauthError(tokens.error_description || tokens.error, 'OAUTH_TOKEN_ERROR');
            }

            log.debug('tokens received: type=%s', tokens.token_type);
            return tokens;
        },

        /**
         * Refresh an access token using a refresh token.
         *
         * @param {string} refreshToken - The refresh token.
         * @returns {Promise<object>} New token set.
         * @throws {Error} If the refresh fails.
         */
        async refresh(refreshToken)
        {
            const body = {
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: config.clientId,
            };
            if (config.clientSecret) body.client_secret = config.clientSecret;

            log.debug('refreshing token at %s', config.tokenUrl);
            const res = await fetchFn(config.tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: new URLSearchParams(body).toString(),
                timeout: config.timeout,
            });

            const tokens = await res.json();
            if (tokens.error)
            {
                throw _oauthError(tokens.error_description || tokens.error, 'OAUTH_REFRESH_ERROR');
            }

            return tokens;
        },

        /**
         * Fetch user profile from the provider's userInfo endpoint.
         *
         * @param {string} accessToken - OAuth access token.
         * @returns {Promise<object>} User profile object (provider-specific schema).
         * @throws {Error} If no userInfoUrl is configured or the request fails.
         */
        async userInfo(accessToken)
        {
            if (!config.userInfoUrl)
            {
                throw _oauthError('No userInfo endpoint configured for this provider', 'OAUTH_NO_USERINFO');
            }

            const res = await fetchFn(config.userInfoUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json',
                },
                timeout: config.timeout,
            });

            if (!res.ok)
            {
                throw _oauthError(`UserInfo request failed: ${res.status}`, 'OAUTH_USERINFO_FAILED');
            }

            return res.json();
        },

        /** The resolved configuration (read-only). */
        config: Object.freeze({ ...config }),
    };
}

// -- Helpers ---------------------------------------------------------

/** @private */
function _oauthError(message, code)
{
    const err = new Error(message);
    err.code = code;
    return err;
}

module.exports = {
    oauth,
    generatePKCE,
    generateState,
    PROVIDERS,
};
