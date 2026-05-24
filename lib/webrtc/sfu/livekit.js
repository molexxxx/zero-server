/**
 * @module webrtc/sfu/livekit
 * @description LiveKit-backed SFU adapter (peerDependency on
 *   `livekit-server-sdk`). Maps the `SfuAdapter` contract onto LiveKit's
 *   remote media plane: `createTransport` mints an AccessToken, mute/close
 *   delegate to `RoomServiceClient`, and produce/consume are local
 *   bookkeeping while LiveKit handles media client-side.
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

    // ----- Room / participant REST passthroughs -----

    /**
     * Fetch one room from LiveKit by name.  Returns the matching entry
     * from `client.listRooms([name])` or `null`.
     */
    async getRoomInfo(routerId)
    {
        if (typeof this._client.listRooms !== 'function') return null;
        try
        {
            const list = await this._client.listRooms([routerId]);
            if (Array.isArray(list) && list.length) return list[0];
            return null;
        }
        catch (_) { return null; }
    }

    async listParticipants(routerId)
    {
        if (typeof this._client.listParticipants !== 'function') return [];
        return this._client.listParticipants(routerId);
    }

    async removeParticipant(routerId, identity)
    {
        if (typeof this._client.removeParticipant !== 'function')
        {
            throw new WebRTCError('removeParticipant: LiveKit client missing removeParticipant()', { code: 'WEBRTC_SFU_NOT_SUPPORTED' });
        }
        await this._client.removeParticipant(routerId, identity);
        this._emit('peer-removed', { routerId, identity });
    }

    async updateRoomMetadata(routerId, metadata)
    {
        if (typeof this._client.updateRoomMetadata !== 'function')
        {
            throw new WebRTCError('updateRoomMetadata: LiveKit client missing updateRoomMetadata()', { code: 'WEBRTC_SFU_NOT_SUPPORTED' });
        }
        await this._client.updateRoomMetadata(routerId, typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
        this._emit('router-metadata', { routerId, metadata });
    }

    async sendData(routerId, payload, opts)
    {
        if (typeof this._client.sendData !== 'function')
        {
            throw new WebRTCError('sendData: LiveKit client missing sendData()', { code: 'WEBRTC_SFU_NOT_SUPPORTED' });
        }
        const o = opts || {};
        const data = Buffer.isBuffer(payload) ? payload
            : (payload instanceof Uint8Array ? Buffer.from(payload)
                : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)));
        await this._client.sendData(routerId, data, o.kind || 0, o.destinationIdentities || o.destinations || undefined);
    }

    // ----- Egress (recording / RTMP / HLS) -----

    _egressClient()
    {
        if (this._egress) return this._egress;
        if (!this._livekit.EgressClient)
        {
            try { this._livekit = { ...this._livekit, ...require('livekit-server-sdk') }; }
            catch (_) { /* fall through */ }
        }
        const C = this._livekit.EgressClient;
        if (!C)
        {
            throw new WebRTCError(
                "egress requires 'livekit-server-sdk' with EgressClient support",
                { code: 'WEBRTC_SFU_NOT_INSTALLED' },
            );
        }
        this._egress = new C(this._url, this._apiKey, this._apiSecret);
        return this._egress;
    }

    async startRoomCompositeEgress(routerId, opts)
    {
        const e = this._egressClient();
        const o = opts || {};
        const res = await e.startRoomCompositeEgress(routerId, o.output || o, o.options);
        this._emit('egress-start', { kind: 'room-composite', routerId, egressId: res && res.egressId });
        return res;
    }

    async startTrackEgress(routerId, trackId, opts)
    {
        const e = this._egressClient();
        const o = opts || {};
        const res = await e.startTrackEgress(routerId, o.output || o, trackId);
        this._emit('egress-start', { kind: 'track', routerId, trackId, egressId: res && res.egressId });
        return res;
    }

    async stopEgress(egressId)
    {
        const e = this._egressClient();
        const res = await e.stopEgress(egressId);
        this._emit('egress-stop', { egressId });
        return res;
    }

    async listEgress(opts)
    {
        const e = this._egressClient();
        if (typeof e.listEgress !== 'function') return [];
        return e.listEgress(opts || {});
    }

    // ----- Ingress (WHIP / RTMP / URL pull) -----

    _ingressClient()
    {
        if (this._ingress) return this._ingress;
        const C = this._livekit.IngressClient;
        if (!C)
        {
            throw new WebRTCError(
                "ingress requires 'livekit-server-sdk' with IngressClient support",
                { code: 'WEBRTC_SFU_NOT_INSTALLED' },
            );
        }
        this._ingress = new C(this._url, this._apiKey, this._apiSecret);
        return this._ingress;
    }

    async createIngress(opts)
    {
        const i = this._ingressClient();
        const o = opts || {};
        const inputType = o.inputType || o.type || 'RTMP_INPUT';
        const res = await i.createIngress(inputType, o);
        this._emit('ingress-start', { ingressId: res && res.ingressId, inputType, room: o.roomName });
        return res;
    }

    async deleteIngress(ingressId)
    {
        const i = this._ingressClient();
        const res = await i.deleteIngress(ingressId);
        this._emit('ingress-stop', { ingressId });
        return res;
    }

    // ----- SfuAdapter Phase-2 surface (LiveKit owns media, so most are
    //       client-side and surface as cooperative no-ops or REST mute hints) -----

    async setConsumerPreferredLayers(consumerId, _layers)
    {
        if (!this._consumers.has(consumerId))
            throw new WebRTCError('setConsumerPreferredLayers: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        // LiveKit drives layer selection client-side (UpdateSubscription
        // / SetSubscriptionPermissions); no server REST call is required.
        this._emit('consumer-layers-change', { consumerId, layers: _layers || null });
    }

    async setConsumerPriority(consumerId, priority)
    {
        if (!this._consumers.has(consumerId))
            throw new WebRTCError('setConsumerPriority: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        this._emit('consumer-priority', { consumerId, priority });
    }

    async requestKeyFrame(consumerId)
    {
        if (!this._consumers.has(consumerId))
            throw new WebRTCError('requestKeyFrame: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        // LiveKit clients PLI through their own RTCP; no-op here.
    }

    async pauseConsumer(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
            throw new WebRTCError('pauseConsumer: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        c.paused = true;
        this._emit('consumer-pause', { consumerId });
    }

    async resumeConsumer(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
            throw new WebRTCError('resumeConsumer: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        c.paused = false;
        this._emit('consumer-resume', { consumerId });
    }

    async setTransportBitrates(transportId, bitrates)
    {
        if (!this._transports.has(transportId))
            throw new WebRTCError('setTransportBitrates: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        // LiveKit BWE is end-to-end inside its own client; we record the
        // request so callers can read it back and emit so observers can
        // count clamps.
        const t = this._transports.get(transportId);
        t.bitrates = bitrates || {};
        this._emit('transport-bitrates', { transportId, bitrates: t.bitrates });
    }

    async produceData(transport, opts)
    {
        if (!transport || !this._transports.has(transport.id))
            throw new WebRTCError('produceData: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        const id = this._nextId('dataProducer');
        const o  = opts || {};
        const dp = {
            id, dataProducerId: id, transportId: transport.id,
            label: o.label || '', protocol: o.protocol || '',
            ordered: o.ordered !== false,
        };
        this._dataProducers = this._dataProducers || new Map();
        this._dataProducers.set(id, dp);
        this._emit('data-producer-new', { dataProducerId: id, transportId: transport.id, label: dp.label });
        return dp;
    }

    async consumeData(transport, dataProducerId, opts)
    {
        if (!transport || !this._transports.has(transport.id))
            throw new WebRTCError('consumeData: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        const id = this._nextId('dataConsumer');
        const o  = opts || {};
        const dc = {
            id, dataConsumerId: id, transportId: transport.id, dataProducerId,
            label: '', protocol: '', ordered: o.ordered !== false,
        };
        this._dataConsumers = this._dataConsumers || new Map();
        this._dataConsumers.set(id, dc);
        this._emit('data-consumer-new', { dataConsumerId: id, transportId: transport.id, dataProducerId });
        return dc;
    }

    async observeAudioLevels(routerId, _opts)
    {
        if (!this._rooms.has(routerId))
            throw new WebRTCError('observeAudioLevels: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        // LiveKit emits "active_speakers_changed" via the room webhook /
        // server-events channel; expose a tiny handle that pushes those
        // through our adapter `_emit` once the caller wires them.
        const id = this._nextId('audioObserver');
        const self = this;
        const handle = {
            id, kind: 'audio-level', routerId, closed: false,
            close: async () => { handle.closed = true; self._emit('observer-close', { observerId: id, kind: 'audio-level' }); },
            emit:  (levels) => { if (!handle.closed) self._emit('audio-level', { observerId: id, routerId, levels }); },
        };
        this._emit('observer-new', { observerId: id, kind: 'audio-level', routerId });
        return handle;
    }

    async observeActiveSpeaker(routerId, _opts)
    {
        if (!this._rooms.has(routerId))
            throw new WebRTCError('observeActiveSpeaker: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        const id = this._nextId('speakerObserver');
        const self = this;
        const handle = {
            id, kind: 'active-speaker', routerId, closed: false,
            close: async () => { handle.closed = true; self._emit('observer-close', { observerId: id, kind: 'active-speaker' }); },
            emit:  (producerId) => { if (!handle.closed) self._emit('active-speaker', { observerId: id, routerId, producerId }); },
        };
        this._emit('observer-new', { observerId: id, kind: 'active-speaker', routerId });
        return handle;
    }

    async pipeToRouter(_opts)
    {
        // LiveKit handles cross-node fanout itself across its cluster;
        // application-level pipe is not part of the public REST surface.
        throw new WebRTCError('pipeToRouter: not supported by LiveKit provider', { code: 'WEBRTC_SFU_NOT_SUPPORTED' });
    }

    async getProducerStats(producerId)
    {
        if (!this._producers.has(producerId))
            throw new WebRTCError('getProducerStats: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        return [];
    }

    async getConsumerStats(consumerId)
    {
        if (!this._consumers.has(consumerId))
            throw new WebRTCError('getConsumerStats: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        return [];
    }

    async getTransportStats(transportId)
    {
        if (!this._transports.has(transportId))
            throw new WebRTCError('getTransportStats: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        return [];
    }

    async enableTraceEvent(routerId, types)
    {
        if (!this._rooms.has(routerId))
            throw new WebRTCError('enableTraceEvent: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        this._emit('trace-enabled', { routerId, types: Array.isArray(types) ? types : [] });
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
