/**
 * @module webrtc/sfu
 * @description Pluggable Selective Forwarding Unit (SFU) adapter interface.
 *   The signaling hub stays media-agnostic; the adapter owns routers,
 *   transports, producers, and consumers. Ships with `MemorySfuAdapter`,
 *   `MediasoupSfuAdapter`, and `LiveKitSfuAdapter`. Subclass `SfuAdapter`
 *   for custom backends.
 *
 * @example | Select an adapter at boot via env
 *   const { loadSfuAdapter } = require('@zero-server/webrtc');
 *   const sfu = loadSfuAdapter(process.env.SFU_BACKEND || 'memory', {
 *       // adapter-specific options forwarded verbatim
 *       workerSettings: { logLevel: 'warn' },
 *   });
 *
 *   sfu.onEvent((event, payload) => log.debug({ event, payload }, 'sfu'));
 *
 * @example | Wire an SFU into the signaling hub per room
 *   const router = await sfu.createRouter({ room: 'lobby' });
 *
 *   hub.on('join', async ({ peer, room }) => {
 *       if (room.name !== 'lobby') return;
 *       const transport = await sfu.createTransport(router, peer);
 *       peer.send('sfu-transport', { iceParameters: transport.iceParameters });
 *   });
 */
'use strict';

const { WebRTCError } = require('../../errors');

/**
 * Base class every SFU adapter inherits from.  Subclasses MUST override
 * every async method; the default implementations throw
 * `WEBRTC_SFU_NOT_IMPLEMENTED` so partial adapters fail loudly.
 *
 *   The interface is intentionally tiny so a backend can be written in a
 *   single file:
 *
 * @example | Skeleton adapter
 *   class MyAdapter extends SfuAdapter {
 *       async createRouter(opts)            { return { id: cuid(), opts }; }
 *       async createTransport(router, peer) { return { id: cuid(), router, peer }; }
 *       async produce(transport, kind, rtp) {
 *           const id = cuid();
 *           this._emit('producer-new', { id, kind, transportId: transport.id });
 *           return { id, kind };
 *       }
 *       async consume(transport, producerId, _rtpCaps) {
 *           return { id: cuid(), producerId, transportId: transport.id };
 *       }
 *       async pauseProducer(id)  { this._emit('producer-pause', { id }); }
 *       async resumeProducer(id) { this._emit('producer-resume', { id }); }
 *       async closeRouter(id)    { this._emit('router-close', { id }); }
 *       async stats(_scope)      { return { ts: Date.now() }; }
 *   }
 *
 * @example | Subscribe to adapter events
 *   const off = sfu.onEvent((event, payload) => {
 *       if (event === 'producer-new')   metrics.producers.inc();
 *       if (event === 'producer-pause') log.info({ id: payload.id }, 'paused');
 *   });
 *   // later: off();
 */
class SfuAdapter
{
    constructor()
    {
        this._handlers = new Set();
    }

    /** Override to create a routing context for a single room. */
    async createRouter(_opts)
    {
        throw new WebRTCError('SfuAdapter.createRouter() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to allocate a WebRTC transport for a peer in a router. */
    async createTransport(_router, _peer)
    {
        throw new WebRTCError('SfuAdapter.createTransport() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to bind a producer ('audio' | 'video') to a transport. */
    async produce(_transport, _kind, _rtpParams)
    {
        throw new WebRTCError('SfuAdapter.produce() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to bind a consumer of `producerId` to a transport. */
    async consume(_transport, _producerId, _rtpCaps)
    {
        throw new WebRTCError('SfuAdapter.consume() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to pause a producer (mute upstream forwarding). */
    async pauseProducer(_producerId)
    {
        throw new WebRTCError('SfuAdapter.pauseProducer() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to resume a previously paused producer. */
    async resumeProducer(_producerId)
    {
        throw new WebRTCError('SfuAdapter.resumeProducer() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to close a router and cascade-close its transports. */
    async closeRouter(_routerId)
    {
        throw new WebRTCError('SfuAdapter.closeRouter() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to return adapter stats; `scope` may be a routerId/transportId. */
    async stats(_scope)
    {
        throw new WebRTCError('SfuAdapter.stats() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    // -- Consumer-side BWE / quality knobs --

    /**
     * Switch a consumer to the given simulcast spatial / temporal layer.
     * @param {string} consumerId
     * @param {{spatialLayer:number, temporalLayer?:number}} layers
     */
    async setConsumerPreferredLayers(_consumerId, _layers)
    {
        throw new WebRTCError('SfuAdapter.setConsumerPreferredLayers() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /**
     * Set consumer priority (1-255, higher = more bandwidth budget under
     * congestion).
     */
    async setConsumerPriority(_consumerId, _priority)
    {
        throw new WebRTCError('SfuAdapter.setConsumerPriority() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Ask the SFU to forward a PLI/FIR to the producer the consumer is bound to. */
    async requestKeyFrame(_consumerId)
    {
        throw new WebRTCError('SfuAdapter.requestKeyFrame() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Pause an individual consumer (stop forwarding to a single subscriber). */
    async pauseConsumer(_consumerId)
    {
        throw new WebRTCError('SfuAdapter.pauseConsumer() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Resume a previously paused consumer. */
    async resumeConsumer(_consumerId)
    {
        throw new WebRTCError('SfuAdapter.resumeConsumer() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    // -- Transport-level BWE caps --

    /**
     * Apply incoming/outgoing bitrate hints to a transport.
     * @param {string} transportId
     * @param {{initial?:number, min?:number, max?:number, maxIncoming?:number, maxOutgoing?:number}} opts
     */
    async setTransportBitrates(_transportId, _opts)
    {
        throw new WebRTCError('SfuAdapter.setTransportBitrates() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    // -- Data channels --

    /** Create an SCTP data producer on a transport. */
    async produceData(_transport, _opts)
    {
        throw new WebRTCError('SfuAdapter.produceData() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Create an SCTP data consumer bound to `dataProducerId`. */
    async consumeData(_transport, _dataProducerId, _opts)
    {
        throw new WebRTCError('SfuAdapter.consumeData() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    // -- Observers --

    /**
     * Start an audio-level observer on a router. Emits `audio-level` adapter
     * events. Returns `{ id, close() }`.
     * @param {string} routerId
     * @param {{interval?:number, threshold?:number, maxEntries?:number}} [opts]
     */
    async observeAudioLevels(_routerId, _opts)
    {
        throw new WebRTCError('SfuAdapter.observeAudioLevels() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /**
     * Start an active-speaker observer. Emits `active-speaker` adapter
     * events. Returns `{ id, close() }`.
     */
    async observeActiveSpeaker(_routerId, _opts)
    {
        throw new WebRTCError('SfuAdapter.observeActiveSpeaker() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    // -- Cross-router cascade (SFU mesh) --

    /**
     * Pipe a producer from this adapter's local router into another router
     * (possibly on a remote SFU node). Returns
     * `{ pipeProducerId, pipeConsumerId, localRouterId, remoteRouterId }`.
     * @param {{producerId:string, localRouterId:string, remoteRouter:object}} opts
     */
    async pipeToRouter(_opts)
    {
        throw new WebRTCError('SfuAdapter.pipeToRouter() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    // -- Targeted stats (Phase 2 surface; coarse stats() remains for back-compat) --

    /** Return native stats for a single producer. */
    async getProducerStats(_producerId)
    {
        throw new WebRTCError('SfuAdapter.getProducerStats() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Return native stats for a single consumer. */
    async getConsumerStats(_consumerId)
    {
        throw new WebRTCError('SfuAdapter.getConsumerStats() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Return native stats for a single transport. */
    async getTransportStats(_transportId)
    {
        throw new WebRTCError('SfuAdapter.getTransportStats() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /**
     * Toggle low-level trace event emission on a router (mediasoup `trace`
     * events: 'probation', 'bwe', 'rtp', 'keyframe', etc.).
     */
    async enableTraceEvent(_routerId, _types)
    {
        throw new WebRTCError('SfuAdapter.enableTraceEvent() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /**
     * Register a handler invoked as `(event, payload)` for adapter-level
     * events ('producer-new', 'producer-pause', 'consumer-new',
     * 'transport-close', 'router-close', etc.).
     *
     * Returns an unsubscribe function.
     */
    onEvent(handler)
    {
        if (typeof handler !== 'function')
        {
            throw new WebRTCError('onEvent() handler must be a function', { code: 'WEBRTC_SFU_INVALID_HANDLER' });
        }
        this._handlers.add(handler);
        return () => this._handlers.delete(handler);
    }

    /** Emit `event` with `payload` to every registered handler. */
    _emit(event, payload)
    {
        for (const fn of this._handlers)
        {
            try { fn(event, payload); }
            catch (_) { /* swallow handler errors so adapters keep running */ }
        }
    }
}

/**
 * Lazy-load and instantiate an SFU adapter.
 *
 * @param {object|string} spec - one of:
 *   - an object exposing the SfuAdapter contract (returned as-is),
 *   - 'memory' | 'mediasoup' | 'livekit' | adapter package id.
 * @param {object} [opts] - constructor options forwarded to the adapter.
 * @returns {SfuAdapter}
 *
 * @example | Built-in adapter by name
 *   const sfu = loadSfuAdapter('mediasoup', {
 *       numWorkers: 4,
 *       workerSettings: { rtcMinPort: 40000, rtcMaxPort: 49999 },
 *   });
 *
 * @example | Pre-constructed instance (e.g. shared singleton in tests)
 *   const fake = new MemorySfuAdapter();
 *   const sfu  = loadSfuAdapter(fake);
 *   expect(sfu).toBe(fake);
 *
 * @example | Third-party adapter package
 *   //   npm i @acme/zero-server-sfu-janus
 *   const sfu = loadSfuAdapter('@acme/zero-server-sfu-janus', { wsUrl: 'ws://janus/ws' });
 */
function loadSfuAdapter(spec, opts)
{
    if (spec && typeof spec === 'object' && typeof spec.createRouter === 'function')
    {
        return spec;
    }
    if (typeof spec !== 'string' || spec.length === 0)
    {
        throw new WebRTCError(
            'loadSfuAdapter() requires an adapter instance or a name (memory|mediasoup|livekit|<package>)',
            { code: 'WEBRTC_SFU_INVALID_SPEC' },
        );
    }

    if (spec === 'memory')
    {
        const { MemorySfuAdapter } = require('./memory');
        return new MemorySfuAdapter(opts);
    }
    if (spec === 'mediasoup')
    {
        const Ctor = _tryRequireAdapter('./mediasoup', 'mediasoup');
        return new Ctor(opts);
    }
    if (spec === 'livekit')
    {
        const Ctor = _tryRequireAdapter('./livekit', 'livekit-server-sdk');
        return new Ctor(opts);
    }

    // External adapter package - must export `default` or a class.
    let mod;
    try { mod = require(spec); }
    catch (err)
    {
        throw new WebRTCError(
            `SFU adapter package '${spec}' is not installed: ${err.message}`,
            { code: 'WEBRTC_SFU_NOT_INSTALLED', cause: err },
        );
    }
    const Ctor = mod && (mod.default || mod);
    if (typeof Ctor !== 'function')
    {
        throw new WebRTCError(
            `SFU adapter package '${spec}' does not export a class or default constructor`,
            { code: 'WEBRTC_SFU_INVALID_PACKAGE' },
        );
    }
    return new Ctor(opts);
}

/**
 * @private
 * Try to load a built-in adapter module; surface a clean install message
 * when the wrapped peerDependency is missing.
 */
function _tryRequireAdapter(localPath, peerPkg)
{
    let mod;
    try { mod = require(localPath); }
    catch (err)
    {
        throw new WebRTCError(
            `SFU adapter '${peerPkg}' requires the '${peerPkg}' peerDependency: npm install ${peerPkg}`,
            { code: 'WEBRTC_SFU_NOT_INSTALLED', cause: err },
        );
    }
    // The wrapper itself tries `require(peerPkg)`; rethrow with the install
    // hint if construction fails for that reason.
    const Ctor = mod && (mod.default || Object.values(mod).find((v) => typeof v === 'function'));
    if (typeof Ctor !== 'function')
    {
        throw new WebRTCError(
            `SFU adapter module '${localPath}' did not export a constructor`,
            { code: 'WEBRTC_SFU_INVALID_ADAPTER' },
        );
    }
    return Ctor;
}

module.exports = { SfuAdapter, loadSfuAdapter };
