/**
 * @module webrtc/sfu/livekit
 * @description LiveKit-backed SFU adapter (peerDependency on `livekit-server-sdk`).
 *
 *   LiveKit's media plane is controlled remotely: rooms live on the
 *   LiveKit server, participants connect directly with a signed JWT, and
 *   the server SDK exposes a control-plane REST API.  This adapter maps
 *   the {@link SfuAdapter} contract onto that model:
 *
 *     - createRouter(opts)          -> RoomServiceClient.createRoom(...)
 *     - createTransport(router,peer) -> mints an AccessToken (the "transport"
 *                                       handle is the URL + JWT the peer
 *                                       uses to connect to LiveKit directly)
 *     - produce / consume           -> local bookkeeping; LiveKit handles
 *                                       the actual media plane client-side
 *     - pauseProducer / resume      -> RoomServiceClient.mutePublishedTrack()
 *                                       when the producer was registered
 *                                       with a `{room, identity, trackSid}`
 *                                       hint; otherwise emits the event
 *                                       without touching the server
 *     - closeRouter(routerId)       -> RoomServiceClient.deleteRoom(...)
 *     - stats()                     -> RoomServiceClient.listRooms() /
 *                                       listParticipants(...) plus local
 *                                       counters
 *
 *   `livekit-server-sdk` is loaded lazily.  Tests inject a stub via
 *   `opts.livekit`; in production the constructor `require`s the package
 *   and throws `WEBRTC_SFU_NOT_INSTALLED` if it is missing.
 *
 * @example | Cloud LiveKit project
 *   //   npm install livekit-server-sdk
 *   const { LiveKitSfuAdapter } = require('@zero-server/webrtc');
 *   const sfu = new LiveKitSfuAdapter({
 *       host:      'https://my-project.livekit.cloud',
 *       apiKey:    process.env.LIVEKIT_API_KEY,
 *       apiSecret: process.env.LIVEKIT_API_SECRET,
 *       tokenTtl:  '30m',
 *   });
 *
 * @example | Self-hosted LiveKit + handing the JWT to a browser
 *   const router    = await sfu.createRouter({ room: 'standup' });
 *   const transport = await sfu.createTransport(router, {
 *       id:   peer.id,
 *       user: { id: peer.user.id, name: peer.user.name },
 *   });
 *   peer.send('livekit', { url: transport.url, token: transport.token });
 *
 * @example | Mute a noisy publisher (REST passthrough)
 *   await sfu.pauseProducer(producer.id);
 *   // adapter records the producerId; if it was registered with a
 *   // { room, identity, trackSid } hint it issues
 *   // RoomServiceClient.mutePublishedTrack() against LiveKit.
 */
'use strict';

const { SfuAdapter } = require('./index');
const { WebRTCError } = require('../../errors');

const DEFAULT_TOKEN_TTL = '1h';

class LiveKitSfuAdapter extends SfuAdapter
{
    /**
     * @param {object} opts
     * @param {string} opts.url        LiveKit server URL (wss://...).
     * @param {string} opts.apiKey     LiveKit API key.
     * @param {string} opts.apiSecret  LiveKit API secret.
     * @param {object} [opts.livekit]  Injected `livekit-server-sdk` module (testing).
     * @param {object} [opts.client]   Pre-built `RoomServiceClient` (testing).
     * @param {object} [opts.defaultRoomOpts]    Forwarded to `createRoom()` when fields are missing.
     * @param {object} [opts.defaultGrants]      Default `{canPublish, canSubscribe, ...}` for minted tokens.
     * @param {string} [opts.tokenTtl='1h']      AccessToken TTL.
     */
    constructor(opts)
    {
        super();
        const o = opts || {};
        if (!o.url || !o.apiKey || !o.apiSecret)
        {
            throw new WebRTCError(
                'LiveKitSfuAdapter requires { url, apiKey, apiSecret }',
                { code: 'WEBRTC_SFU_INVALID_CONFIG' },
            );
        }
        this._livekit          = o.livekit || _tryRequireLivekit();
        this._url              = o.url;
        this._apiKey           = o.apiKey;
        this._apiSecret        = o.apiSecret;
        this._defaultRoomOpts  = o.defaultRoomOpts || {};
        this._defaultGrants    = o.defaultGrants || { canPublish: true, canSubscribe: true };
        this._tokenTtl         = o.tokenTtl || DEFAULT_TOKEN_TTL;

        this._client = o.client || new this._livekit.RoomServiceClient(this._url, this._apiKey, this._apiSecret);

        this._rooms      = new Map(); // routerId    -> { name, opts }
        this._transports = new Map(); // transportId -> { identity, room, token }
        this._producers  = new Map(); // producerId  -> { kind, transportId, room, identity, trackSid? }
        this._consumers  = new Map(); // consumerId  -> { producerId, transportId }

        this._idSeq = 0;
    }

    _nextId(prefix)
    {
        this._idSeq += 1;
        return `${prefix}-${this._idSeq}`;
    }

    /**
     * Create a LiveKit room.  `opts.name` overrides the auto-generated name.
     * Returns a router handle whose `id` is the room name.
     */
    async createRouter(opts)
    {
        const o = { ...this._defaultRoomOpts, ...(opts || {}) };
        const name = o.name || this._nextId('room');
        const room = await this._client.createRoom({ ...o, name });
        const id = room && room.name ? room.name : name;
        this._rooms.set(id, { name: id, opts: o, native: room });
        this._emit('router-new', { routerId: id });
        return { id, routerId: id, name: id, _native: room };
    }

    /**
     * Mint an AccessToken for `peer` to join the LiveKit room.  Returns
     * a transport handle containing the JWT and URL the peer hands to
     * the LiveKit client SDK.
     */
    async createTransport(router, peer)
    {
        const routerId = router && router.id;
        const room = routerId && this._rooms.get(routerId);
        if (!room)
        {
            throw new WebRTCError('createTransport: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const identity = (peer && peer.id) || this._nextId('peer');
        const at = new this._livekit.AccessToken(this._apiKey, this._apiSecret, {
            identity,
            ttl:  this._tokenTtl,
            name: (peer && peer.name) || identity,
        });
        at.addGrant({ roomJoin: true, room: routerId, ...this._defaultGrants });
        const token = await at.toJwt();
        const id = this._nextId('transport');
        const handle = {
            id,
            transportId: id,
            routerId,
            peer:        peer || null,
            identity,
            url:         this._url,
            token,
        };
        this._transports.set(id, handle);
        this._emit('transport-new', { transportId: id, routerId, peerId: identity });
        return handle;
    }

    async produce(transport, kind, rtpParameters)
    {
        if (kind !== 'audio' && kind !== 'video')
        {
            throw new WebRTCError('produce: kind must be "audio" or "video"', { code: 'WEBRTC_SFU_INVALID_KIND' });
        }
        const t = transport && this._transports.get(transport.id);
        if (!t)
        {
            throw new WebRTCError('produce: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const id = this._nextId('producer');
        const trackSid = (rtpParameters && rtpParameters.trackSid) || null;
        const p = {
            id, producerId: id, transportId: t.id, kind,
            room: t.routerId, identity: t.identity, trackSid,
            rtpParameters: rtpParameters || {}, paused: false,
        };
        this._producers.set(id, p);
        this._emit('producer-new', { producerId: id, transportId: t.id, kind });
        return p;
    }

    async consume(transport, producerId, rtpCapabilities)
    {
        const t = transport && this._transports.get(transport.id);
        if (!t)
        {
            throw new WebRTCError('consume: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const prod = this._producers.get(producerId);
        if (!prod)
        {
            throw new WebRTCError('consume: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        const id = this._nextId('consumer');
        const c = {
            id, consumerId: id, transportId: t.id, producerId,
            kind: prod.kind, rtpParameters: prod.rtpParameters,
            rtpCapabilities: rtpCapabilities || {},
        };
        this._consumers.set(id, c);
        this._emit('consumer-new', { consumerId: id, transportId: t.id, producerId });
        return c;
    }

    async pauseProducer(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p)
        {
            throw new WebRTCError('pauseProducer: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        if (p.trackSid && typeof this._client.mutePublishedTrack === 'function')
        {
            await this._client.mutePublishedTrack(p.room, p.identity, p.trackSid, true);
        }
        p.paused = true;
        this._emit('producer-pause', { producerId });
    }

    async resumeProducer(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p)
        {
            throw new WebRTCError('resumeProducer: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        if (p.trackSid && typeof this._client.mutePublishedTrack === 'function')
        {
            await this._client.mutePublishedTrack(p.room, p.identity, p.trackSid, false);
        }
        p.paused = false;
        this._emit('producer-resume', { producerId });
    }

    async closeRouter(routerId)
    {
        const room = this._rooms.get(routerId);
        if (!room) return;
        try { await this._client.deleteRoom(routerId); }
        catch (err)
        {
            this._emit('router-close-error', { routerId, error: err && err.message });
        }
        // Drop every producer / consumer / transport that belonged to this room.
        for (const [pid, p] of this._producers)
        {
            if (p.room === routerId)
            {
                this._producers.delete(pid);
                this._emit('producer-close', { producerId: pid, reason: 'router-close' });
            }
        }
        for (const [cid, c] of this._consumers)
        {
            const t = this._transports.get(c.transportId);
            if (t && t.routerId === routerId)
            {
                this._consumers.delete(cid);
                this._emit('consumer-close', { consumerId: cid, reason: 'router-close' });
            }
        }
        for (const [tid, t] of this._transports)
        {
            if (t.routerId === routerId)
            {
                this._transports.delete(tid);
                this._emit('transport-close', { transportId: tid, reason: 'router-close' });
            }
        }
        this._rooms.delete(routerId);
        this._emit('router-close', { routerId });
    }

    async stats(scope)
    {
        if (scope && this._rooms.has(scope))
        {
            let participants = null;
            if (typeof this._client.listParticipants === 'function')
            {
                try { participants = await this._client.listParticipants(scope); }
                catch (_) { participants = null; }
            }
            return { kind: 'router', routerId: scope, participants };
        }
        if (scope && this._transports.has(scope))
        {
            const t = this._transports.get(scope);
            return { kind: 'transport', transportId: scope, routerId: t.routerId, identity: t.identity };
        }
        let rooms = null;
        if (typeof this._client.listRooms === 'function')
        {
            try { rooms = await this._client.listRooms(); }
            catch (_) { rooms = null; }
        }
        return {
            kind:       'global',
            routers:    this._rooms.size,
            transports: this._transports.size,
            producers:  this._producers.size,
            consumers:  this._consumers.size,
            rooms,
        };
    }
}

/**
 * @private
 * Try to `require('livekit-server-sdk')`; throw a clean install hint when missing.
 */
function _tryRequireLivekit()
{
    try { return require('livekit-server-sdk'); }
    catch (err)
    {
        throw new WebRTCError(
            "SFU adapter 'livekit' requires the 'livekit-server-sdk' peerDependency: npm install livekit-server-sdk",
            { code: 'WEBRTC_SFU_NOT_INSTALLED', cause: err },
        );
    }
}

module.exports = { LiveKitSfuAdapter };
