/**
 * @module webrtc/turn/server
 * @description Zero-dependency embedded TURN server (RFC 5766) backing the
 *              `TurnServer` public API.  Implements the long-term-credential
 *              auth flow paired with `issueTurnCredentials` ephemeral
 *              accounts, UDP allocations, permissions, Send / Data
 *              indications, channel bindings, lifetimes, and per-user
 *              quotas.
 *
 *   The hot path is intentionally compact: all framing lives in
 *   `lib/webrtc/turn/codec.js` and the server only owns state +
 *   relay-socket multiplexing.  TCP and TLS listeners are reserved in the
 *   constructor surface and will be implemented in a later PR; calling
 *   `start()` against either currently throws `TURN_TRANSPORT_UNSUPPORTED`.
 *
 * @example | Boot an embedded TURN server alongside Zero Server
 *   const { TurnServer, issueTurnCredentials } = require('@zero-server/webrtc');
 *
 *   const turn = new TurnServer({
 *       secret:    process.env.TURN_SECRET,
 *       realm:     'rtc.example.com',
 *       relayHost: process.env.PUBLIC_IP || '0.0.0.0',
 *       listeners: [{ proto: 'udp', port: 3478 }],
 *       quotas:    { maxAllocationsPerUser: 4, maxBytesPerMinute: 50_000_000 },
 *   });
 *   await turn.start();
 *
 *   turn.on('allocate',   ({ user, relay })   => log.info({ user, relay }, 'turn allocate'));
 *   turn.on('permission', ({ user, peer })    => log.debug({ user, peer }, 'turn permission'));
 *   turn.on('relay',      ({ user, bytes })   => metrics.turnBytes.inc(bytes));
 *
 *   process.on('SIGTERM', () => turn.close());
 *
 * @example | Issue creds + return them with the room join payload
 *   const { TurnServer, issueTurnCredentials } = require('@zero-server/webrtc');
 *   const creds = issueTurnCredentials({
 *       secret:  process.env.TURN_SECRET,
 *       userId:  req.user.id,
 *       servers: ['turn:rtc.example.com:3478'],
 *       ttl:     '20m',
 *   });
 *   res.json({ token, iceServers: [creds] });
 *
 * @example | Multi-listener (UDP + future TCP) with tight per-user quotas
 *   const turn = new TurnServer({
 *       secret:    process.env.TURN_SECRET,
 *       realm:     'rtc.example.com',
 *       listeners: [{ proto: 'udp', port: 3478, host: '0.0.0.0' }],
 *       quotas:    {
 *           maxAllocationsPerUser: 2,
 *           maxBytesPerMinute:     5_000_000, // 5 MB/min per user
 *       },
 *       defaultLifetime: 300,
 *       maxLifetime:     1800,
 *   });
 */

'use strict';

const dgram  = require('node:dgram');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { TurnError } = require('../../errors');
const codec = require('./codec');

const {
    STUN_CLASS, TURN_METHOD, ATTR, PROTO_UDP,
    CHANNEL_MIN, CHANNEL_MAX,
    encodeMessage, decodeMessage,
    getAttr, getAttrs,
    longTermKey, verifyIntegrity, findIntegrity,
    encodeErrorCode, encodeUInt32, decodeUInt32,
    encodeChannelNumber, decodeChannelNumber,
    encodeChannelData, decodeChannelData, looksLikeChannelData,
    encodeXorAddress, decodeXorAddress,
    endpointKey,
} = codec;

const DEFAULT_LIFETIME       = 600;   // 10 minutes
const MAX_LIFETIME           = 3600;
const PERMISSION_LIFETIME    = 300;   // 5 minutes
const CHANNEL_LIFETIME       = 600;
const NONCE_LIFETIME_MS      = 60_000;
const SOFTWARE_NAME          = 'zero-server-turn';

/**
 * Embedded TURN server backed by `dgram` sockets.
 *
 * @class TurnServer
 * @extends EventEmitter
 */
class TurnServer extends EventEmitter
{
    /**
     * @param {object} opts
     * @param {string} opts.secret
     *   Shared HMAC secret for ephemeral credentials produced by
     *   {@link module:webrtc/turn/credentials.issueTurnCredentials}.
     * @param {string} [opts.realm='zero-server']
     * @param {Array<{proto:'udp'|'tcp'|'tls',port:number,host?:string,tls?:object}>} opts.listeners
     * @param {object} [opts.quotas]
     * @param {number} [opts.quotas.maxAllocationsPerUser=Infinity]
     * @param {number} [opts.quotas.maxBytesPerMinute=Infinity]
     * @param {number} [opts.defaultLifetime=600]
     * @param {number} [opts.maxLifetime=3600]
     * @param {string} [opts.relayHost='127.0.0.1']
     *   Address bound by each per-allocation relay socket.  Production
     *   deployments should pass the server's public IP.
     */
    constructor(opts)
    {
        super();
        const o = opts || {};
        if (typeof o.secret !== 'string' || o.secret.length === 0)
            throw new TurnError('TurnServer: opts.secret is required', { code: 'TURN_CONFIG' });
        if (!Array.isArray(o.listeners) || o.listeners.length === 0)
            throw new TurnError('TurnServer: opts.listeners must be a non-empty array', { code: 'TURN_CONFIG' });

        this._secret    = o.secret;
        this.realm      = typeof o.realm === 'string' && o.realm.length ? o.realm : 'zero-server';
        this._listeners = o.listeners.map((l) => Object.assign({}, l));
        this._quotas    = Object.assign(
            { maxAllocationsPerUser: Infinity, maxBytesPerMinute: Infinity },
            o.quotas || {},
        );
        this._defaultLifetime = Number.isFinite(o.defaultLifetime) ? o.defaultLifetime : DEFAULT_LIFETIME;
        this._maxLifetime     = Number.isFinite(o.maxLifetime)     ? o.maxLifetime     : MAX_LIFETIME;
        this._relayHost       = typeof o.relayHost === 'string' ? o.relayHost : '127.0.0.1';

        /** @type {Map<string, _Allocation>} */
        this._allocations = new Map();
        /** @type {Map<string, Set<string>>} */
        this._userAllocs  = new Map();
        /** @type {Map<string, {windowStart:number, bytes:number}>} */
        this._userBytes   = new Map();
        /** @type {Map<string, {value:string, expiresAt:number}>} */
        this._nonces      = new Map();
        /** @type {Array<{proto:string, socket:any, address:string, port:number}>} */
        this._bound       = [];

        this._closed = false;
    }

    // ------------------------------------------------------------------
    //  Lifecycle
    // ------------------------------------------------------------------

    /**
     * Bind all configured listeners.  Resolves once every listener is
     * listening; rejects on the first bind error.
     *
     * @returns {Promise<void>}
     */
    async start()
    {
        if (this._closed) throw new TurnError('TurnServer: already stopped', { code: 'TURN_STOPPED' });
        for (const l of this._listeners)
        {
            if (l.proto !== 'udp')
                throw new TurnError(
                    `TurnServer: ${l.proto} listeners are not implemented yet`,
                    { code: 'TURN_TRANSPORT_UNSUPPORTED' },
                );
            const sock = dgram.createSocket(l.family === 6 ? 'udp6' : 'udp4');
            await new Promise((resolve, reject) =>
            {
                sock.once('error', reject);
                sock.bind(l.port, l.host || '127.0.0.1', () =>
                {
                    sock.removeListener('error', reject);
                    resolve();
                });
            });
            const addr = sock.address();
            sock.on('message', (msg, rinfo) => this._onClientMessage(sock, msg, rinfo));
            sock.on('error',   (err) => this.emit('error', err));
            this._bound.push({ proto: 'udp', socket: sock, address: addr.address, port: addr.port });
        }
        this._sweepInterval = setInterval(() => this._sweep(), 1000);
        if (this._sweepInterval.unref) this._sweepInterval.unref();
    }

    /**
     * Close all listeners and free every allocation's relay socket.
     *
     * @returns {Promise<void>}
     */
    async stop()
    {
        this._closed = true;
        if (this._sweepInterval) { clearInterval(this._sweepInterval); this._sweepInterval = null; }
        for (const alloc of this._allocations.values()) this._freeAllocation(alloc);
        this._allocations.clear();
        this._userAllocs.clear();
        const closes = this._bound.map((b) => new Promise((r) => b.socket.close(r)));
        this._bound = [];
        await Promise.all(closes);
    }

    /**
     * The bound address of the first listener (handy for tests that ask
     * the kernel for an ephemeral port via `port: 0`).
     *
     * @returns {{address:string, port:number}|null}
     */
    address()
    {
        return this._bound.length ? { address: this._bound[0].address, port: this._bound[0].port } : null;
    }

    // ------------------------------------------------------------------
    //  Dispatch
    // ------------------------------------------------------------------

    /** @private */
    _onClientMessage(sock, raw, rinfo)
    {
        try
        {
            if (looksLikeChannelData(raw))
            {
                this._handleChannelData(sock, raw, rinfo);
                return;
            }
            const msg = decodeMessage(raw);
            switch (msg.method)
            {
                case TURN_METHOD.ALLOCATE:          this._handleAllocate(sock, raw, msg, rinfo); break;
                case TURN_METHOD.REFRESH:           this._handleRefresh(sock, raw, msg, rinfo); break;
                case TURN_METHOD.CREATE_PERMISSION: this._handleCreatePermission(sock, raw, msg, rinfo); break;
                case TURN_METHOD.CHANNEL_BIND:      this._handleChannelBind(sock, raw, msg, rinfo); break;
                case TURN_METHOD.SEND:              this._handleSend(sock, raw, msg, rinfo); break;
                default:
                    this._sendError(sock, msg.method, msg.transactionId, rinfo, 400, 'Bad Request');
            }
        }
        catch (err)
        {
            this.emit('error', err);
        }
    }

    // ------------------------------------------------------------------
    //  Auth
    // ------------------------------------------------------------------

    /**
     * Validate a request that carries a USERNAME / REALM / NONCE / MI set.
     * Returns `{ ok:true, key, username, userId }` on success or
     * `{ ok:false, code, reason, withNonce }` on failure.
     *
     * @private
     */
    _checkAuth(raw, msg, rinfo)
    {
        const usernameBuf = getAttr(msg, ATTR.USERNAME);
        const realmBuf    = getAttr(msg, ATTR.REALM);
        const nonceBuf    = getAttr(msg, ATTR.NONCE);
        const miSpec      = findIntegrity(raw);
        if (!usernameBuf || !realmBuf || !nonceBuf || !miSpec)
            return { ok: false, code: 401, reason: 'Unauthorized', withNonce: true };

        const username = usernameBuf.toString('utf8');
        const realm    = realmBuf.toString('utf8');
        const nonce    = nonceBuf.toString('utf8');

        if (realm !== this.realm)
            return { ok: false, code: 441, reason: 'Wrong Credentials' };

        const stored = this._nonces.get(`${rinfo.address}:${rinfo.port}`);
        if (!stored || stored.value !== nonce || stored.expiresAt <= Date.now())
            return { ok: false, code: 438, reason: 'Stale Nonce', withNonce: true };

        // ephemeral credentials: username = "<expiry>:<userId>"
        const colon = username.indexOf(':');
        if (colon <= 0)
            return { ok: false, code: 441, reason: 'Wrong Credentials' };
        const expiry = Number(username.slice(0, colon));
        const userId = username.slice(colon + 1);
        if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000))
            return { ok: false, code: 401, reason: 'Expired Credentials', withNonce: true };

        const password = crypto.createHmac('sha1', this._secret).update(username).digest('base64');
        const key      = longTermKey(username, this.realm, password);

        if (!verifyIntegrity(raw, key, miSpec.value, miSpec.offset))
            return { ok: false, code: 401, reason: 'Bad MAC', withNonce: true };

        return { ok: true, key, username, userId };
    }

    /** @private */
    _issueNonce(rinfo)
    {
        const value = crypto.randomBytes(12).toString('hex');
        this._nonces.set(`${rinfo.address}:${rinfo.port}`, {
            value, expiresAt: Date.now() + NONCE_LIFETIME_MS,
        });
        return value;
    }

    /** @private */
    _sendError(sock, method, txid, rinfo, code, reason, opts)
    {
        const attrs = [
            { type: ATTR.ERROR_CODE, value: encodeErrorCode(code, reason) },
        ];
        if (opts && opts.withNonce)
        {
            attrs.push({ type: ATTR.NONCE, value: Buffer.from(this._issueNonce(rinfo), 'utf8') });
            attrs.push({ type: ATTR.REALM, value: Buffer.from(this.realm, 'utf8') });
        }
        attrs.push({ type: ATTR.SOFTWARE, value: Buffer.from(SOFTWARE_NAME, 'utf8') });
        const buf = encodeMessage(method, STUN_CLASS.ERROR, txid, attrs);
        sock.send(buf, rinfo.port, rinfo.address);
    }

    // ------------------------------------------------------------------
    //  ALLOCATE
    // ------------------------------------------------------------------

    /** @private */
    _handleAllocate(sock, raw, msg, rinfo)
    {
        const clientKey = endpointKey(rinfo.address, rinfo.port);
        if (this._allocations.has(clientKey))
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 437, 'Allocation Mismatch');
            return;
        }

        const auth = this._checkAuth(raw, msg, rinfo);
        if (!auth.ok)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo,
                auth.code, auth.reason, { withNonce: auth.withNonce });
            return;
        }

        const rt = getAttr(msg, ATTR.REQUESTED_TRANSPORT);
        if (!rt || rt.length < 1 || rt[0] !== PROTO_UDP)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 442, 'Unsupported Transport Protocol');
            return;
        }

        const userSet = this._userAllocs.get(auth.userId) || new Set();
        if (userSet.size >= this._quotas.maxAllocationsPerUser)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 486, 'Allocation Quota Reached');
            return;
        }

        const lifetimeAttr = getAttr(msg, ATTR.LIFETIME);
        const requested    = lifetimeAttr ? decodeUInt32(lifetimeAttr) : this._defaultLifetime;
        const lifetime     = Math.max(60, Math.min(this._maxLifetime, requested || this._defaultLifetime));

        const relay = dgram.createSocket('udp4');
        relay.bind({ address: this._relayHost, port: 0 }, () =>
        {
            const ra = relay.address();
            const alloc = {
                clientKey, sock, rinfo: { address: rinfo.address, port: rinfo.port },
                userId: auth.userId, key: auth.key,
                relay, relayAddress: ra.address, relayPort: ra.port,
                permissions: new Map(),     // peerIp -> expiresAt
                channels: new Map(),        // channel# -> { peerIp, peerPort, expiresAt }
                channelByPeer: new Map(),   // "ip:port" -> channel#
                expiresAt: Date.now() + lifetime * 1000,
            };
            this._allocations.set(clientKey, alloc);
            userSet.add(clientKey);
            this._userAllocs.set(auth.userId, userSet);

            relay.on('message', (data, peerRinfo) => this._onRelayMessage(alloc, data, peerRinfo));
            relay.on('error',   (err) => this.emit('error', err));

            const attrs = [
                { type: ATTR.XOR_RELAYED_ADDRESS, value: encodeXorAddress(ra.address, ra.port, msg.transactionId) },
                { type: ATTR.XOR_MAPPED_ADDRESS,  value: encodeXorAddress(rinfo.address, rinfo.port, msg.transactionId) },
                { type: ATTR.LIFETIME,            value: encodeUInt32(lifetime) },
                { type: ATTR.SOFTWARE,            value: Buffer.from(SOFTWARE_NAME, 'utf8') },
            ];
            const reply = encodeMessage(msg.method, STUN_CLASS.SUCCESS, msg.transactionId, attrs, auth.key);
            sock.send(reply, rinfo.port, rinfo.address);
            this.emit('allocation', { userId: auth.userId, relay: ra, client: rinfo });
        });
        relay.on('error', (err) => this.emit('error', err));
    }

    // ------------------------------------------------------------------
    //  REFRESH
    // ------------------------------------------------------------------

    /** @private */
    _handleRefresh(sock, raw, msg, rinfo)
    {
        const alloc = this._allocations.get(endpointKey(rinfo.address, rinfo.port));
        if (!alloc)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 437, 'Allocation Mismatch');
            return;
        }
        const auth = this._checkAuth(raw, msg, rinfo);
        if (!auth.ok)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo,
                auth.code, auth.reason, { withNonce: auth.withNonce });
            return;
        }

        const lifetimeAttr = getAttr(msg, ATTR.LIFETIME);
        const requested    = lifetimeAttr ? decodeUInt32(lifetimeAttr) : this._defaultLifetime;
        let lifetime;
        if (requested === 0)
        {
            this._freeAllocation(alloc);
            this._allocations.delete(alloc.clientKey);
            const set = this._userAllocs.get(alloc.userId);
            if (set) { set.delete(alloc.clientKey); if (!set.size) this._userAllocs.delete(alloc.userId); }
            lifetime = 0;
            this.emit('deallocation', { userId: alloc.userId, client: rinfo });
        }
        else
        {
            lifetime = Math.max(60, Math.min(this._maxLifetime, requested));
            alloc.expiresAt = Date.now() + lifetime * 1000;
        }
        const reply = encodeMessage(msg.method, STUN_CLASS.SUCCESS, msg.transactionId, [
            { type: ATTR.LIFETIME, value: encodeUInt32(lifetime) },
            { type: ATTR.SOFTWARE, value: Buffer.from(SOFTWARE_NAME, 'utf8') },
        ], auth.key);
        sock.send(reply, rinfo.port, rinfo.address);
    }

    // ------------------------------------------------------------------
    //  CREATE-PERMISSION
    // ------------------------------------------------------------------

    /** @private */
    _handleCreatePermission(sock, raw, msg, rinfo)
    {
        const alloc = this._allocations.get(endpointKey(rinfo.address, rinfo.port));
        if (!alloc)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 437, 'Allocation Mismatch');
            return;
        }
        const auth = this._checkAuth(raw, msg, rinfo);
        if (!auth.ok)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo,
                auth.code, auth.reason, { withNonce: auth.withNonce });
            return;
        }
        const peerAttrs = getAttrs(msg, ATTR.XOR_PEER_ADDRESS);
        if (peerAttrs.length === 0)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 400, 'Bad Request');
            return;
        }
        const now = Date.now();
        for (const av of peerAttrs)
        {
            const peer = decodeXorAddress(av, msg.transactionId);
            alloc.permissions.set(peer.address, now + PERMISSION_LIFETIME * 1000);
        }
        const reply = encodeMessage(msg.method, STUN_CLASS.SUCCESS, msg.transactionId, [
            { type: ATTR.SOFTWARE, value: Buffer.from(SOFTWARE_NAME, 'utf8') },
        ], auth.key);
        sock.send(reply, rinfo.port, rinfo.address);
    }

    // ------------------------------------------------------------------
    //  CHANNEL-BIND
    // ------------------------------------------------------------------

    /** @private */
    _handleChannelBind(sock, raw, msg, rinfo)
    {
        const alloc = this._allocations.get(endpointKey(rinfo.address, rinfo.port));
        if (!alloc)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 437, 'Allocation Mismatch');
            return;
        }
        const auth = this._checkAuth(raw, msg, rinfo);
        if (!auth.ok)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo,
                auth.code, auth.reason, { withNonce: auth.withNonce });
            return;
        }
        const chAttr   = getAttr(msg, ATTR.CHANNEL_NUMBER);
        const peerAttr = getAttr(msg, ATTR.XOR_PEER_ADDRESS);
        if (!chAttr || !peerAttr)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 400, 'Bad Request');
            return;
        }
        const channel = decodeChannelNumber(chAttr);
        if (channel < CHANNEL_MIN || channel > CHANNEL_MAX)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 400, 'Bad Channel Number');
            return;
        }
        const peer = decodeXorAddress(peerAttr, msg.transactionId);
        const peerKey = endpointKey(peer.address, peer.port);
        const existing = alloc.channels.get(channel);
        if (existing && (existing.peerIp !== peer.address || existing.peerPort !== peer.port))
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 400, 'Channel In Use');
            return;
        }
        const otherChan = alloc.channelByPeer.get(peerKey);
        if (otherChan && otherChan !== channel)
        {
            this._sendError(sock, msg.method, msg.transactionId, rinfo, 400, 'Peer Already Bound');
            return;
        }
        alloc.channels.set(channel, {
            peerIp: peer.address, peerPort: peer.port,
            expiresAt: Date.now() + CHANNEL_LIFETIME * 1000,
        });
        alloc.channelByPeer.set(peerKey, channel);
        alloc.permissions.set(peer.address, Date.now() + PERMISSION_LIFETIME * 1000);

        const reply = encodeMessage(msg.method, STUN_CLASS.SUCCESS, msg.transactionId, [
            { type: ATTR.SOFTWARE, value: Buffer.from(SOFTWARE_NAME, 'utf8') },
        ], auth.key);
        sock.send(reply, rinfo.port, rinfo.address);
    }

    // ------------------------------------------------------------------
    //  SEND (indication)
    // ------------------------------------------------------------------

    /** @private */
    _handleSend(sock, raw, msg, rinfo)
    {
        const alloc = this._allocations.get(endpointKey(rinfo.address, rinfo.port));
        if (!alloc) return; // indications are unauthenticated, silent drop
        const peerAttr = getAttr(msg, ATTR.XOR_PEER_ADDRESS);
        const data     = getAttr(msg, ATTR.DATA);
        if (!peerAttr || !data) return;
        const peer = decodeXorAddress(peerAttr, msg.transactionId);
        const exp  = alloc.permissions.get(peer.address);
        if (!exp || exp <= Date.now()) return;
        if (!this._chargeBytes(alloc.userId, data.length)) return;
        alloc.relay.send(data, peer.port, peer.address);
    }

    // ------------------------------------------------------------------
    //  ChannelData (no STUN header)
    // ------------------------------------------------------------------

    /** @private */
    _handleChannelData(sock, raw, rinfo)
    {
        const alloc = this._allocations.get(endpointKey(rinfo.address, rinfo.port));
        if (!alloc) return;
        const cd = decodeChannelData(raw);
        if (!cd) return;
        const bind = alloc.channels.get(cd.channel);
        if (!bind || bind.expiresAt <= Date.now()) return;
        if (!this._chargeBytes(alloc.userId, cd.payload.length)) return;
        alloc.relay.send(cd.payload, bind.peerPort, bind.peerIp);
    }

    // ------------------------------------------------------------------
    //  Relay -> client
    // ------------------------------------------------------------------

    /** @private */
    _onRelayMessage(alloc, data, peerRinfo)
    {
        const exp = alloc.permissions.get(peerRinfo.address);
        if (!exp || exp <= Date.now()) return;
        if (!this._chargeBytes(alloc.userId, data.length)) return;

        const channel = alloc.channelByPeer.get(endpointKey(peerRinfo.address, peerRinfo.port));
        if (channel)
        {
            const frame = encodeChannelData(channel, data);
            alloc.sock.send(frame, alloc.rinfo.port, alloc.rinfo.address);
            return;
        }
        const txid = crypto.randomBytes(12);
        const attrs = [
            { type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress(peerRinfo.address, peerRinfo.port, txid) },
            { type: ATTR.DATA,             value: data },
        ];
        const ind = encodeMessage(TURN_METHOD.DATA, STUN_CLASS.INDICATION, txid, attrs);
        alloc.sock.send(ind, alloc.rinfo.port, alloc.rinfo.address);
    }

    // ------------------------------------------------------------------
    //  Quotas + sweep
    // ------------------------------------------------------------------

    /** @private */
    _chargeBytes(userId, n)
    {
        const cap = this._quotas.maxBytesPerMinute;
        if (!Number.isFinite(cap)) return true;
        const now = Date.now();
        let q = this._userBytes.get(userId);
        if (!q || now - q.windowStart >= 60_000)
        {
            q = { windowStart: now, bytes: 0 };
            this._userBytes.set(userId, q);
        }
        if (q.bytes + n > cap) return false;
        q.bytes += n;
        return true;
    }

    /** @private */
    _freeAllocation(alloc)
    {
        try { alloc.relay.close(); } catch (_) { /* ignore */ }
    }

    /** @private */
    _sweep()
    {
        const now = Date.now();
        for (const [k, alloc] of this._allocations)
        {
            if (alloc.expiresAt <= now)
            {
                this._freeAllocation(alloc);
                this._allocations.delete(k);
                const set = this._userAllocs.get(alloc.userId);
                if (set) { set.delete(k); if (!set.size) this._userAllocs.delete(alloc.userId); }
                this.emit('deallocation', { userId: alloc.userId, client: alloc.rinfo, reason: 'expired' });
                continue;
            }
            for (const [ip, exp] of alloc.permissions)
                if (exp <= now) alloc.permissions.delete(ip);
            for (const [chan, b] of alloc.channels)
            {
                if (b.expiresAt <= now)
                {
                    alloc.channels.delete(chan);
                    alloc.channelByPeer.delete(endpointKey(b.peerIp, b.peerPort));
                }
            }
        }
        for (const [k, n] of this._nonces) if (n.expiresAt <= now) this._nonces.delete(k);
    }
}

module.exports = { TurnServer };
