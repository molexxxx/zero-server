/**
 * @file lib/webrtc/turn/credentials.js
 * @module @zero-server/webrtc/turn/credentials
 * @description RFC 7635 ephemeral TURN credentials.
 *
 *   Generates time-limited username / credential pairs that any
 *   RFC 7635-compatible TURN server (notably `coturn` with
 *   `use-auth-secret` + `static-auth-secret=<S>`) will accept.
 *
 *   Wire format (RFC 7635 §6.2):
 *     username   = "<unix-expiry>:<userId>"
 *     credential = base64( HMAC-SHA1( <secret>, username ) )
 *
 *   The returned object is shaped like an `RTCIceServer` entry so it can
 *   be embedded straight into the ICE-server list a signaling endpoint
 *   serves to browsers.
 */

'use strict';

const crypto = require('node:crypto');
const { TurnError } = require('../../errors');

// --- Constants ---

const DEFAULT_TTL_SECONDS = 86400; // 24h

/** Schemes the W3C `RTCIceServer.urls` field is allowed to contain. */
const VALID_SCHEMES = ['turn:', 'turns:', 'stun:', 'stuns:'];

// --- Public API ---

/**
 * @typedef {object} IssueTurnCredentialsOptions
 * @property {string}            secret    - Shared secret matching the TURN server's `static-auth-secret`.
 * @property {string|number}     userId    - Identifier embedded in the username (audited by coturn).
 * @property {number|string}     [ttl]     - Lifetime: seconds (number) or duration string ("30s", "20m", "2h", "1d"). Default 24h.
 * @property {string|string[]}   servers   - TURN/STUN URL(s) to embed in the returned `urls` field.
 */

/**
 * @typedef {object} TurnCredentials
 * @property {string[]} urls       - The TURN/STUN URLs the browser should try.
 * @property {string}   username   - `<expiryUnix>:<userId>`.
 * @property {string}   credential - base64(HMAC-SHA1(secret, username)).
 * @property {number}   ttl        - Lifetime in seconds (mirrors `ttl` input, for caching hints).
 */

/**
 * Mint an ephemeral TURN credential per RFC 7635.
 *
 * @param {IssueTurnCredentialsOptions} opts
 * @returns {TurnCredentials}
 * @throws {TurnError} On missing / invalid input.
 *
 * @example | Hand a fresh credential to a browser before it joins a room
 *   //   coturn.conf:
 *   //     use-auth-secret
 *   //     static-auth-secret=<TURN_SHARED_SECRET>
 *   //     realm=turn.example.com
 *   app.get('/rtc/turn', (req, res) => {
 *       const creds = issueTurnCredentials({
 *           secret:  process.env.TURN_SHARED_SECRET,
 *           userId:  req.user.id,
 *           ttl:     '20m',
 *           servers: ['turn:turn.example.com:3478?transport=udp'],
 *       });
 *       res.json(creds); // { urls, username, credential, ttl }
 *   });
 *
 * @example | Multiple URLs (UDP, TCP, TLS) for failover
 *   const creds = issueTurnCredentials({
 *       secret:  process.env.TURN_SHARED_SECRET,
 *       userId:  'bot-42',
 *       ttl:     3600,
 *       servers: [
 *           'turn:turn.example.com:3478?transport=udp',
 *           'turn:turn.example.com:3478?transport=tcp',
 *           'turns:turn.example.com:5349',
 *           'stun:turn.example.com:3478',
 *       ],
 *   });
 *
 * @example | Use directly in an RTCPeerConnection (browser side)
 *   const pc = new RTCPeerConnection({
 *       iceServers: [creds], // { urls, username, credential } is RTCIceServer-shaped
 *   });
 *
 * @section ICE & TURN
 */
function issueTurnCredentials(opts)
{
    const o = opts || {};

    if (typeof o.secret !== 'string' || o.secret.length === 0)
        throw new TurnError('issueTurnCredentials: opts.secret is required');
    if (o.userId === undefined || o.userId === null || o.userId === '')
        throw new TurnError('issueTurnCredentials: opts.userId is required');

    const servers = _normalizeServers(o.servers);
    const ttl     = _normalizeTtl(o.ttl);
    const expiry  = Math.floor(Date.now() / 1000) + ttl;

    const username   = `${expiry}:${String(o.userId)}`;
    const credential = crypto.createHmac('sha1', o.secret).update(username).digest('base64');

    return { urls: servers, username, credential, ttl };
}

// --- Helpers ---

/** @private */
function _normalizeServers(servers)
{
    if (servers === undefined || servers === null)
        throw new TurnError('issueTurnCredentials: opts.servers is required');

    const list = Array.isArray(servers) ? servers : [servers];
    if (list.length === 0)
        throw new TurnError('issueTurnCredentials: opts.servers must not be empty');

    for (const url of list)
    {
        if (typeof url !== 'string' || url.length === 0)
            throw new TurnError('issueTurnCredentials: server URL must be a non-empty string');
        if (!VALID_SCHEMES.some(s => url.toLowerCase().startsWith(s)))
        {
            throw new TurnError(
                `issueTurnCredentials: server URL must use turn:/turns:/stun:/stuns: scheme (got "${url}")`,
            );
        }
    }
    return list.slice();
}

/** @private */
function _normalizeTtl(ttl)
{
    if (ttl === undefined || ttl === null) return DEFAULT_TTL_SECONDS;

    if (typeof ttl === 'number')
    {
        if (!Number.isFinite(ttl) || ttl <= 0)
            throw new TurnError(`issueTurnCredentials: ttl must be > 0 (got ${ttl})`);
        return Math.floor(ttl);
    }

    if (typeof ttl === 'string')
    {
        const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(ttl.trim());
        if (!m) throw new TurnError(`issueTurnCredentials: invalid ttl string "${ttl}"`);
        const n = Number(m[1]);
        const unit = (m[2] || 's').toLowerCase();
        const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
        const secs = n * mult;
        if (secs <= 0) throw new TurnError(`issueTurnCredentials: ttl must be > 0 (got "${ttl}")`);
        return secs;
    }

    throw new TurnError(`issueTurnCredentials: ttl must be a number or duration string (got ${typeof ttl})`);
}

module.exports = {
    issueTurnCredentials,
};
