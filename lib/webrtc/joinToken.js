/**
 * @module webrtc/joinToken
 * @description Signed, short-TTL join tokens that authenticate a peer's
 *              right to join a specific WebRTC room.
 *
 *   The token is a standard JWT (HS256 by default, RS256 with a PEM key
 *   supported via `algorithm`) that is **audience-scoped** to `room:<name>`,
 *   so a token leaked from one channel cannot be replayed against another
 *   room.  Verification is constant-time and surfaces every failure mode
 *   (bad signature, expired, audience mismatch, malformed) as a
 *   `WebRTCError({ code: 'INVALID_TOKEN' })`.
 *
 *   The hub will refuse `join` messages when constructed with
 *   `joinTokenSecret` and the token is missing / invalid — no application
 *   wiring required.
 *
 *   Reuses the canonical sign / verify primitives from `lib/auth/jwt.js`,
 *   so any claim (`iss`, `kid`, custom keys via `opts.claims`) flows through
 *   unchanged.
 *
 * @example | Browser receives a token from a regular HTTP route
 *   // server.js
 *   const { signJoinToken } = require('@zero-server/webrtc');
 *   app.get('/rtc/token/:room', (req, res) => {
 *       const token = signJoinToken({
 *           secret: process.env.WEBRTC_JWT_SECRET,
 *           user:   req.user,          // { id, name, role }
 *           room:   req.params.room,
 *           ttl:    300,               // 5 minute window
 *           claims: { publish: req.user.isHost === true },
 *       });
 *       res.json({ wsUrl: '/rtc', token });
 *   });
 *
 *   // client.js (pseudo)
 *   const { wsUrl, token } = await fetch(`/rtc/token/${room}`).then(r => r.json());
 *   ws = new WebSocket(wsUrl);
 *   ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room, token }));
 */

'use strict';

const { sign, verify } = require('../auth');
const { SignalingError, WebRTCError } = require('../errors');

/**
 * Issue a join token for `user` to enter `room`.
 *
 * @param {object} opts
 * @param {string|Buffer} opts.secret    - HMAC secret (HS256) or PEM key (RS256).
 * @param {string|object} opts.user      - User identifier (string) or object containing `id`.
 * @param {string}        opts.room      - Target room name.
 * @param {number}        [opts.ttl=300] - Seconds until expiry.  Negative values are accepted
 *                                         (used by tests to mint already-expired tokens).
 * @param {string}        [opts.algorithm='HS256']
 * @param {string|string[]} [opts.audience] - Override the default `room:<name>` audience.
 * @param {object}        [opts.claims]    - Additional claims merged into the payload.
 * @returns {string} Compact JWT.
 *
 * @example | Simple HS256 token with a user object
 *   const token = signJoinToken({
 *       secret: process.env.JOIN_SECRET,
 *       user:   req.user,           // { id: 'u_42', name: 'Ada', role: 'host' }
 *       room:   'boardroom',
 *       ttl:    300,
 *   });
 *   res.json({ wsUrl: '/rtc', token });
 *
 * @example | Embed publish / subscribe permissions as custom claims
 *   const token = signJoinToken({
 *       secret: process.env.JOIN_SECRET,
 *       user:   { id: 'guest_' + crypto.randomUUID() },
 *       room:   'webinar-42',
 *       ttl:    60 * 30,            // 30 minute viewer session
 *       claims: { publish: false, subscribe: true, tier: 'free' },
 *   });
 *
 * @example | RS256 with a per-tenant key id
 *   const token = signJoinToken({
 *       secret:    fs.readFileSync('./keys/tenant-A.private.pem'),
 *       algorithm: 'RS256',
 *       user:      req.user,
 *       room:      'tenantA:lobby',
 *       ttl:       300,
 *       claims:    { kid: 'tenantA-2025-01' },
 *   });
 *
 * @section Signaling
 */
function signJoinToken(opts = {})
{
    if (!opts || typeof opts !== 'object')
        throw new SignalingError('signJoinToken: opts must be an object');
    if (!opts.secret) throw new SignalingError('signJoinToken: secret is required');
    if (opts.user === undefined || opts.user === null)
        throw new SignalingError('signJoinToken: user is required');
    if (typeof opts.room !== 'string' || opts.room.length === 0)
        throw new SignalingError('signJoinToken: room is required');

    const ttl   = Number.isFinite(opts.ttl) ? opts.ttl : 300;
    const sub   = typeof opts.user === 'string' ? opts.user
                : (opts.user && (opts.user.id || opts.user.userId || opts.user.sub));
    if (!sub)   throw new SignalingError('signJoinToken: user.id is required');

    const payload = Object.assign({}, opts.claims || {}, {
        room: opts.room,
        user: typeof opts.user === 'object' ? opts.user : { id: sub },
    });

    return sign(payload, opts.secret, {
        algorithm: opts.algorithm || 'HS256',
        expiresIn: ttl,
        subject:   String(sub),
        audience:  opts.audience || ('room:' + opts.room),
    });
}

/**
 * Verify a join token and return its payload.  Throws a `WebRTCError` with
 * `code: 'INVALID_TOKEN'` on any failure - bad signature, expired, audience
 * mismatch, malformed, etc.
 *
 * @param {string} token
 * @param {object} opts
 * @param {string|Buffer} opts.secret
 * @param {string} [opts.room]              - If supplied, audience must be `room:<room>`.
 * @param {string|string[]} [opts.audience] - Explicit audience override.
 * @param {string|string[]} [opts.algorithms=['HS256']]
 * @param {number} [opts.clockTolerance=0]
 * @returns {object} Verified payload.
 *
 * @example | Manually verify a token (most apps never need this — the hub does it)
 *   try {
 *       const payload = verifyJoinToken(req.body.token, {
 *           secret: process.env.WEBRTC_JWT_SECRET,
 *           room:   'boardroom',
 *       });
 *       console.log('peer is', payload.user.id, 'publish =', payload.publish);
 *   } catch (err) {
 *       // err.code === 'INVALID_TOKEN'
 *       res.status(401).json({ error: err.message });
 *   }
 *
 * @example | Allow a 30-second clock skew between issuer and verifier
 *   const payload = verifyJoinToken(token, {
 *       secret:         sharedSecret,
 *       room:           'lobby',
 *       clockTolerance: 30,
 *   });
 *
 * @section Signaling
 */
function verifyJoinToken(token, opts = {})
{
    if (!opts || typeof opts !== 'object')
        throw new WebRTCError('verifyJoinToken: opts must be an object', { code: 'INVALID_TOKEN' });
    if (!opts.secret)
        throw new WebRTCError('verifyJoinToken: secret is required', { code: 'INVALID_TOKEN' });
    if (typeof token !== 'string' || token.length === 0)
        throw new WebRTCError('verifyJoinToken: token must be a non-empty string', { code: 'INVALID_TOKEN' });

    const audience = opts.audience || (opts.room ? 'room:' + opts.room : undefined);
    try
    {
        const { payload } = verify(token, opts.secret, {
            algorithms:      opts.algorithms || ['HS256'],
            audience,
            clockTolerance:  opts.clockTolerance || 0,
        });
        if (opts.room && payload.room && payload.room !== opts.room)
            throw new WebRTCError('verifyJoinToken: room claim mismatch', { code: 'INVALID_TOKEN' });
        return payload;
    }
    catch (err)
    {
        if (err instanceof WebRTCError) throw err;
        throw new WebRTCError(
            'verifyJoinToken: ' + (err && err.message ? err.message : 'invalid token'),
            { code: 'INVALID_TOKEN', cause: err && err.code ? err.code : undefined },
        );
    }
}

module.exports = { signJoinToken, verifyJoinToken };
