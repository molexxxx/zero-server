/**
 * @module webrtc/cascade
 * @description Cross-node SFU cascade orchestrator ("zero-server Octo").
 *   Sits on top of a {@link useCluster}-backed {@link SignalingHub} and
 *   a local {@link SfuAdapter}.  A room can now span multiple hub nodes'
 *   media planes: each node owns a local Router (a "bridge") for the
 *   subset of peers it serves, and each producer is piped to every peer
 *   bridge so consumers on any node see every publisher.
 *
 * @section Cluster
 *
 *   Wire protocol (carried over the cluster bus, channel `zs:rtc:cascade`):
 *
 *     | kind            | fields                                                          |
 *     |-----------------|-----------------------------------------------------------------|
 *     | bridge:open     | room, nodeId, routerId, listenInfo                              |
 *     | bridge:accept   | room, nodeId, routerId, listenInfo, replyTo                     |
 *     | bridge:close    | room, nodeId                                                    |
 *     | producer:new    | room, nodeId, routerId, producerId, kind, rtpParameters         |
 *     | producer:close  | room, nodeId, producerId                                        |
 *     | hello           | nodeId                                                          |
 *
 *   On producer:new from a remote bridge, the local node calls
 *   `sfu.pipeToRouter({ producerId, localRouterId, remoteRouter })` so
 *   subsequent `sfu.consume()` calls on the local router see the piped
 *   producer.  Failure of a remote bridge triggers `bridge:close`, after
 *   which the local node drops every pipe it had opened to that bridge.
 *
 * @example | Two nodes, one virtual room
 *   const a = new SignalingHub({ sfu: new MemorySfuAdapter() });
 *   const b = new SignalingHub({ sfu: new MemorySfuAdapter() });
 *   const bus = new MemoryClusterAdapter();
 *   useCluster(a, bus, { nodeId: 'a' });
 *   useCluster(b, bus, { nodeId: 'b' });
 *   useCascade(a, { nodeId: 'a' });
 *   useCascade(b, { nodeId: 'b' });
 *   // peers on either node will see each other's producers automatically.
 */

'use strict';

const { WebRTCError } = require('../errors');

const CH_CASCADE = 'zs:rtc:cascade';

class CascadeCoordinator
{
    /**
     * @param {import('./signaling').SignalingHub} hub
     * @param {object} [opts]
     * @param {string} [opts.nodeId]   - Falls back to the cluster nodeId or a random id.
     * @param {object} [opts.sfu]      - SfuAdapter; defaults to `hub.sfu` (the one the hub was built with).
     * @param {object} [opts.listenInfo] - PipeTransport listen info advertised to peer bridges.
     * @param {boolean} [opts.enableSrtp=true]
     */
    constructor(hub, opts)
    {
        const o = opts || {};
        if (!hub || !hub._cluster)
        {
            throw new WebRTCError(
                'useCascade requires a SignalingHub that has been wired to a cluster via useCluster()',
                { code: 'WEBRTC_CASCADE_NO_CLUSTER' },
            );
        }
        this.hub      = hub;
        this.sfu      = o.sfu || hub.sfu;
        if (!this.sfu)
        {
            throw new WebRTCError(
                'useCascade requires an SfuAdapter (pass opts.sfu or build the hub with { sfu })',
                { code: 'WEBRTC_CASCADE_NO_SFU' },
            );
        }
        this.nodeId      = o.nodeId || hub._cluster.nodeId;
        this.listenInfo  = o.listenInfo || { protocol: 'udp', ip: '0.0.0.0' };
        this.enableSrtp  = o.enableSrtp !== false;
        this._closed     = false;

        /**
         * Local bridges, keyed by room name.  Each entry caches the local
         * router we created for that room plus the set of producers that
         * have been announced over the bus.
         * @type {Map<string, {routerId:string, router:object, producers:Map<string, object>, remoteBridges:Map<string, {nodeId:string, routerId:string, listenInfo:object}>, pipes:Map<string, object>}>}
         */
        this._bridges = new Map();

        /**
         * Remote producer directory, keyed by producerId.
         * `{ producerId, room, nodeId, routerId, kind, rtpParameters, localConsumeCount }`
         * @type {Map<string, object>}
         */
        this._remoteProducers = new Map();

        this._wireBus();
        this._wireSfu();

        // Announce ourselves so peer nodes replay their bridge state.
        this._publish({ kind: 'hello', nodeId: this.nodeId });
    }

    /** @private */
    _wireBus()
    {
        const off = this.hub._cluster.adapter.subscribe(CH_CASCADE, (m) => this._onBus(m));
        this._unsub = typeof off === 'function' ? off : null;
    }

    /** @private */
    _wireSfu()
    {
        this._sfuOff = this.sfu.onEvent((event, payload) =>
        {
            if (this._closed) return;
            if (event === 'producer-new')
                this._onLocalProducerNew(payload);
            else if (event === 'producer-close')
                this._onLocalProducerClose(payload);
        });
    }

    /** @private */
    _publish(msg)
    {
        try
        {
            const res = this.hub._cluster.adapter.publish(CH_CASCADE, msg);
            if (res && typeof res.catch === 'function')
                res.catch((err) => this.hub.emit('cascadeError', err));
        }
        catch (err) { this.hub.emit('cascadeError', err); }
    }

    /**
     * Register the local bridge for `room`.  Idempotent: subsequent calls
     * return the cached entry.  `router` is the handle returned by
     * `sfu.createRouter()`; producers created on that router will be
     * fanned out to every peer bridge.
     *
     * @param {string} roomName
     * @param {object} router
     * @returns {object} bridge state
     */
    registerLocalBridge(roomName, router)
    {
        if (this._closed) throw new WebRTCError('CascadeCoordinator is closed', { code: 'WEBRTC_CASCADE_CLOSED' });
        if (!roomName) throw new WebRTCError('registerLocalBridge: roomName required', { code: 'WEBRTC_CASCADE_BAD_ARGS' });
        if (!router || !(router.id || router.routerId))
            throw new WebRTCError('registerLocalBridge: router with .id required', { code: 'WEBRTC_CASCADE_BAD_ARGS' });
        const routerId = router.id || router.routerId;
        const existing = this._bridges.get(roomName);
        if (existing && existing.routerId === routerId) return existing;
        const entry = {
            routerId,
            router,
            producers:      new Map(),
            remoteBridges:  new Map(),
            pipes:          new Map(),
        };
        this._bridges.set(roomName, entry);
        this._publish({
            kind:       'bridge:open',
            room:       roomName,
            nodeId:     this.nodeId,
            routerId,
            listenInfo: this.listenInfo,
        });
        this.hub.emit('cascade:bridge-open', { room: roomName, nodeId: this.nodeId, routerId });
        return entry;
    }

    /**
     * Tear down the local bridge for `room`.  Closes every pipe opened to
     * peer bridges and announces `bridge:close` so peer nodes drop their
     * mirrored state.
     *
     * @param {string} roomName
     */
    closeLocalBridge(roomName)
    {
        const entry = this._bridges.get(roomName);
        if (!entry) return;
        this._bridges.delete(roomName);
        this._publish({ kind: 'bridge:close', room: roomName, nodeId: this.nodeId });
        this.hub.emit('cascade:bridge-close', { room: roomName, nodeId: this.nodeId });
    }

    /**
     * Announce that a local producer has been created on the bridge for
     * `room` so peer bridges open a `pipeToRouter` consuming it.  Called
     * automatically when the SFU emits `producer-new` and the producer's
     * transport belongs to a known bridge router.
     *
     * @param {string} roomName
     * @param {object} producer  - `{ id|producerId, kind, rtpParameters }`
     */
    announceProducer(roomName, producer)
    {
        const entry = this._bridges.get(roomName);
        if (!entry) return;
        const producerId = producer.id || producer.producerId;
        if (!producerId || entry.producers.has(producerId)) return;
        entry.producers.set(producerId, producer);
        this._publish({
            kind:          'producer:new',
            room:          roomName,
            nodeId:        this.nodeId,
            routerId:      entry.routerId,
            producerId,
            kind_:         producer.kind,
            rtpParameters: producer.rtpParameters || null,
        });
    }

    /**
     * Tear down fanout for a local producer.
     */
    retractProducer(roomName, producerId)
    {
        const entry = this._bridges.get(roomName);
        if (!entry || !entry.producers.delete(producerId)) return;
        this._publish({
            kind:       'producer:close',
            room:       roomName,
            nodeId:     this.nodeId,
            producerId,
        });
    }

    /**
     * Resolve a producer id to its remote origin, if any.  Returns null
     * when the producer is local or unknown.
     *
     * @param {string} producerId
     * @returns {{producerId:string, room:string, nodeId:string, routerId:string, kind:string}|null}
     */
    locateRemoteProducer(producerId)
    {
        return this._remoteProducers.get(producerId) || null;
    }

    /**
     * Snapshot of the cascade state for observability.
     */
    stats()
    {
        const bridges = [];
        for (const [room, entry] of this._bridges)
        {
            bridges.push({
                room,
                routerId:       entry.routerId,
                localProducers: entry.producers.size,
                peers:          entry.remoteBridges.size,
                pipes:          entry.pipes.size,
            });
        }
        return {
            nodeId:          this.nodeId,
            bridges,
            remoteProducers: this._remoteProducers.size,
        };
    }

    /**
     * Tear down every bridge and stop processing bus messages.
     */
    close()
    {
        if (this._closed) return;
        this._closed = true;
        for (const room of [...this._bridges.keys()])
        {
            try { this.closeLocalBridge(room); } catch { /* swallow */ }
        }
        if (typeof this._unsub === 'function') { try { this._unsub(); } catch { /* swallow */ } }
        if (typeof this._sfuOff === 'function') { try { this._sfuOff(); } catch { /* swallow */ } }
        this._unsub = null;
        this._sfuOff = null;
        this._remoteProducers.clear();
        if (this.hub._cascade === this) this.hub._cascade = null;
    }

    // ----- SFU event handlers -----

    /** @private */
    _onLocalProducerNew(payload)
    {
        if (!payload || !payload.producerId) return;
        // We need to know which room this producer's transport/router belongs to.
        // Walk the registered bridges looking for the producer's routerId.
        for (const [room, entry] of this._bridges)
        {
            if (this._routerOwnsProducer(entry, payload.producerId))
            {
                this.announceProducer(room, {
                    id:            payload.producerId,
                    kind:          payload.kind,
                    rtpParameters: payload.rtpParameters || null,
                });
                return;
            }
            // Fallback: producer-new on this bridge's transport (memory/mediasoup expose transportId on the event)
            if (payload.transportId && this._isTransportOnRouter(entry.routerId, payload.transportId))
            {
                this.announceProducer(room, {
                    id:            payload.producerId,
                    kind:          payload.kind,
                    rtpParameters: payload.rtpParameters || null,
                });
                return;
            }
        }
    }

    /** @private */
    _onLocalProducerClose(payload)
    {
        if (!payload || !payload.producerId) return;
        for (const [room, entry] of this._bridges)
        {
            if (entry.producers.has(payload.producerId))
            {
                this.retractProducer(room, payload.producerId);
                return;
            }
        }
    }

    /** @private */
    _routerOwnsProducer(entry, producerId)
    {
        // memory + mediasoup adapters both keep a `_producers` map keyed by id.
        const p = this.sfu._producers && this.sfu._producers.get && this.sfu._producers.get(producerId);
        if (!p) return false;
        // memory adapter stores routerId on the producer record; mediasoup uses transportId.
        if (p.routerId && p.routerId === entry.routerId) return true;
        if (p.transportId) return this._isTransportOnRouter(entry.routerId, p.transportId);
        return false;
    }

    /** @private */
    _isTransportOnRouter(routerId, transportId)
    {
        // mediasoup adapter exposes `_routerOf:Map<transportId, routerId>`; memory adapter
        // stores routerId on the transport entry of `_transports`.
        if (this.sfu._routerOf && this.sfu._routerOf.get)
            return this.sfu._routerOf.get(transportId) === routerId;
        const t = this.sfu._transports && this.sfu._transports.get && this.sfu._transports.get(transportId);
        return !!(t && (t.routerId === routerId || (t.router && t.router.id === routerId)));
    }

    // ----- Bus handlers -----

    /** @private */
    _onBus(msg)
    {
        if (!msg || this._closed) return;
        if (msg.nodeId === this.nodeId) return;
        switch (msg.kind)
        {
        case 'hello':              return this._onHello(msg);
        case 'bridge:open':        return this._onBridgeOpen(msg);
        case 'bridge:accept':      return this._onBridgeAccept(msg);
        case 'bridge:close':       return this._onBridgeClose(msg);
        case 'producer:new':       return this._onRemoteProducerNew(msg);
        case 'producer:close':     return this._onRemoteProducerClose(msg);
        default: /* unknown — ignore */
        }
    }

    /** @private */
    _onHello(_msg)
    {
        // Replay every bridge we own so the newcomer learns about us.
        for (const [room, entry] of this._bridges)
        {
            this._publish({
                kind:       'bridge:open',
                room,
                nodeId:     this.nodeId,
                routerId:   entry.routerId,
                listenInfo: this.listenInfo,
            });
            for (const [producerId, prod] of entry.producers)
            {
                this._publish({
                    kind:          'producer:new',
                    room,
                    nodeId:        this.nodeId,
                    routerId:      entry.routerId,
                    producerId,
                    kind_:         prod.kind,
                    rtpParameters: prod.rtpParameters || null,
                });
            }
        }
    }

    /** @private */
    _onBridgeOpen(msg)
    {
        const local = this._bridges.get(msg.room);
        if (!local) return; // we don't host this room
        local.remoteBridges.set(msg.nodeId, {
            nodeId:     msg.nodeId,
            routerId:   msg.routerId,
            listenInfo: msg.listenInfo,
        });
        this._publish({
            kind:       'bridge:accept',
            room:       msg.room,
            nodeId:     this.nodeId,
            routerId:   local.routerId,
            listenInfo: this.listenInfo,
            replyTo:    msg.nodeId,
        });
        // Replay our local producers for this room so the peer's directory
        // catches up immediately rather than waiting for the next produce.
        for (const [producerId, prod] of local.producers)
        {
            this._publish({
                kind:          'producer:new',
                room:          msg.room,
                nodeId:        this.nodeId,
                routerId:      local.routerId,
                producerId,
                kind_:         prod.kind,
                rtpParameters: prod.rtpParameters || null,
            });
        }
        this.hub.emit('cascade:peer-bridge', { room: msg.room, nodeId: msg.nodeId, routerId: msg.routerId });
    }

    /** @private */
    _onBridgeAccept(msg)
    {
        if (msg.replyTo && msg.replyTo !== this.nodeId) return;
        const local = this._bridges.get(msg.room);
        if (!local) return;
        local.remoteBridges.set(msg.nodeId, {
            nodeId:     msg.nodeId,
            routerId:   msg.routerId,
            listenInfo: msg.listenInfo,
        });
        this.hub.emit('cascade:peer-bridge', { room: msg.room, nodeId: msg.nodeId, routerId: msg.routerId });
    }

    /** @private */
    _onBridgeClose(msg)
    {
        const local = this._bridges.get(msg.room);
        if (!local) return;
        local.remoteBridges.delete(msg.nodeId);
        // Drop every pipe that was opened against this remote node.
        for (const [pipeKey, handle] of local.pipes)
        {
            if (handle._remoteNodeId === msg.nodeId)
                local.pipes.delete(pipeKey);
        }
        // Forget remote producers that originated on the dead node.
        for (const [pid, rec] of this._remoteProducers)
        {
            if (rec.nodeId === msg.nodeId && rec.room === msg.room)
                this._remoteProducers.delete(pid);
        }
        this.hub.emit('cascade:peer-bridge-close', { room: msg.room, nodeId: msg.nodeId });
    }

    /** @private */
    async _onRemoteProducerNew(msg)
    {
        const local = this._bridges.get(msg.room);
        if (!local) return;
        const remoteBridge = local.remoteBridges.get(msg.nodeId);
        if (!remoteBridge) return;
        if (this._remoteProducers.has(msg.producerId)) return;

        const record = {
            producerId:    msg.producerId,
            room:          msg.room,
            nodeId:        msg.nodeId,
            routerId:      msg.routerId,
            kind:          msg.kind_,
            rtpParameters: msg.rtpParameters || null,
        };
        this._remoteProducers.set(msg.producerId, record);
        this.hub.emit('cascade:producer-available', {
            room:       msg.room,
            producerId: msg.producerId,
            fromNode:   msg.nodeId,
            kind:       msg.kind_,
        });

        // Best-effort pipeToRouter.  In real adapters this is the place
        // where the underlying SFU opens its PipeTransport handshake.
        // For adapters that can't pipe a remote producer (e.g. the
        // memory adapter — it validates the producer exists locally),
        // the directory entry still records the remote producer so apps
        // can react to availability and the next pipe attempt (e.g.
        // when both bridges live on the same host) will succeed.
        try
        {
            const handle = await this.sfu.pipeToRouter({
                producerId:    msg.producerId,
                localRouterId: local.routerId,
                remoteRouter:  { id: msg.routerId },
                listenInfo:    remoteBridge.listenInfo,
                enableSrtp:    this.enableSrtp,
            });
            handle._remoteNodeId = msg.nodeId;
            local.pipes.set(msg.producerId, handle);
            this.hub.emit('cascade:producer-piped', { room: msg.room, producerId: msg.producerId, fromNode: msg.nodeId });
        }
        catch (err)
        {
            this.hub.emit('cascade:producer-pipe-failed', {
                room:       msg.room,
                producerId: msg.producerId,
                fromNode:   msg.nodeId,
                error:      err && err.message,
                code:       err && err.code,
            });
        }
    }

    /** @private */
    _onRemoteProducerClose(msg)
    {
        const local = this._bridges.get(msg.room);
        this._remoteProducers.delete(msg.producerId);
        if (!local) return;
        const handle = local.pipes.get(msg.producerId);
        if (handle) local.pipes.delete(msg.producerId);
        this.hub.emit('cascade:producer-piped-close', { room: msg.room, producerId: msg.producerId });
    }
}

/**
 * Attach a {@link CascadeCoordinator} to a hub that already has a cluster
 * adapter bound via {@link useCluster}.  Stores it at `hub._cascade` and
 * returns the coordinator so callers can `registerLocalBridge(room, router)`
 * as rooms get created.
 *
 * @param {import('./signaling').SignalingHub} hub
 * @param {object} [opts]
 * @returns {CascadeCoordinator}
 *
 * @section Cluster
 *
 * @example | Manual bridge registration as rooms grow
 *   const cascade = useCascade(hub);
 *   hub.on('room-created', async ({ name }) => {
 *       const router = await hub.sfu.createRouter();
 *       cascade.registerLocalBridge(name, router);
 *   });
 */
function useCascade(hub, opts)
{
    const coord = new CascadeCoordinator(hub, opts);
    hub._cascade = coord;
    return coord;
}

module.exports = {
    useCascade,
    CascadeCoordinator,
    CH_CASCADE,
};
