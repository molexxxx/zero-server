/**
 * @module webrtc/sfu/memory
 * @description In-process "memory" SFU adapter. Bookkeeping-only
 *   passthrough that records producers/consumers and emits adapter events
 *   without forwarding media packets. Ideal for unit tests, CI, and local
 *   dev — use a native adapter for real media plane work.
 *
 * @example | Use the memory adapter inside a vitest suite
 *   const { MemorySfuAdapter } = require('@zero-server/webrtc');
 *   const sfu = new MemorySfuAdapter();
 *
 *   const events = [];
 *   sfu.onEvent((event, payload) => events.push({ event, payload }));
 *
 *   const router    = await sfu.createRouter({ room: 'lobby' });
 *   const transport = await sfu.createTransport(router, { id: 'peer-1' });
 *   const producer  = await sfu.produce(transport, 'audio', { codec: 'opus' });
 *   const consumer  = await sfu.consume(transport, producer.id, {});
 *
 *   expect(events).toEqual([
 *       { event: 'router-new',   payload: { routerId: router.id } },
 *       { event: 'transport-new', payload: expect.any(Object) },
 *       { event: 'producer-new',  payload: expect.objectContaining({ kind: 'audio' }) },
 *       { event: 'consumer-new',  payload: expect.objectContaining({ producerId: producer.id }) },
 *   ]);
 *
 * @example | Drive it through `loadSfuAdapter`
 *   const sfu = loadSfuAdapter('memory');
 *   const stats = await sfu.stats();
 *   console.log(stats); // { routers, transports, producers, consumers }
 */
'use strict';

const { SfuAdapter } = require('./index');
const { WebRTCError } = require('../../errors');

class MemorySfuAdapter extends SfuAdapter
{
    constructor(opts)
    {
        super();
        this._opts = opts || {};
        this._counter = 0;
        this._routers    = new Map(); // routerId    -> { id, opts, transports:Set, closed }
        this._transports = new Map(); // transportId -> { id, routerId, peer, producers:Set, consumers:Set, closed, bitrates }
        this._producers  = new Map(); // producerId  -> { id, transportId, kind, rtpParams, paused, closed }
        this._consumers  = new Map(); // consumerId  -> { id, transportId, producerId, rtpCaps, closed, paused, priority, preferredLayers, keyFrameRequests }
        this._dataProducers = new Map(); // dataProducerId -> { id, transportId, label, ordered, closed }
        this._dataConsumers = new Map(); // dataConsumerId -> { id, transportId, dataProducerId, closed }
        this._observers     = new Map(); // observerId -> { id, kind, routerId, closed }
        this._pipes         = new Map(); // pipeId     -> { id, producerId, localRouterId, remoteRouterId, pipeProducerId, pipeConsumerId }
        this._traceTypes    = new Map(); // routerId -> Set<string>
    }

    _nextId(prefix)
    {
        this._counter += 1;
        return `${prefix}-${this._counter}`;
    }

    async createRouter(opts)
    {
        const id = this._nextId('router');
        const router = { id, opts: opts || {}, transports: new Set(), closed: false };
        this._routers.set(id, router);
        this._emit('router-new', { routerId: id });
        return { id, routerId: id };
    }

    async createTransport(router, peer)
    {
        const routerId = router && router.id;
        const r = routerId && this._routers.get(routerId);
        if (!r || r.closed)
        {
            throw new WebRTCError('createTransport: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const id = this._nextId('transport');
        const t = {
            id,
            transportId: id,
            routerId,
            peer:        peer || null,
            producers:   new Set(),
            consumers:   new Set(),
            closed:      false,
            iceParameters:  { usernameFragment: id, password: id },
            dtlsParameters: { role: 'auto', fingerprints: [] },
        };
        this._transports.set(id, t);
        r.transports.add(id);
        this._emit('transport-new', { transportId: id, routerId, peerId: peer && peer.id });
        return t;
    }

    async produce(transport, kind, rtpParams)
    {
        if (kind !== 'audio' && kind !== 'video')
        {
            throw new WebRTCError('produce: kind must be "audio" or "video"', { code: 'WEBRTC_SFU_INVALID_KIND' });
        }
        const t = transport && this._transports.get(transport.id);
        if (!t || t.closed)
        {
            throw new WebRTCError('produce: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const id = this._nextId('producer');
        const p = { id, producerId: id, transportId: t.id, kind, rtpParams: rtpParams || {}, paused: false, closed: false };
        this._producers.set(id, p);
        t.producers.add(id);
        this._emit('producer-new', { producerId: id, transportId: t.id, kind });
        return p;
    }

    async consume(transport, producerId, rtpCaps)
    {
        const t = transport && this._transports.get(transport.id);
        if (!t || t.closed)
        {
            throw new WebRTCError('consume: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const prod = this._producers.get(producerId);
        if (!prod || prod.closed)
        {
            throw new WebRTCError('consume: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        const id = this._nextId('consumer');
        const c = {
            id,
            consumerId:  id,
            transportId: t.id,
            producerId,
            kind:        prod.kind,
            rtpParams:   prod.rtpParams,
            rtpCaps:     rtpCaps || {},
            closed:      false,
            paused:      false,
            priority:    1,
            preferredLayers: null,
            keyFrameRequests: 0,
        };
        this._consumers.set(id, c);
        t.consumers.add(id);
        this._emit('consumer-new', { consumerId: id, transportId: t.id, producerId });
        return c;
    }

    async pauseProducer(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p || p.closed)
        {
            throw new WebRTCError('pauseProducer: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        if (!p.paused)
        {
            p.paused = true;
            this._emit('producer-pause', { producerId });
        }
    }

    async resumeProducer(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p || p.closed)
        {
            throw new WebRTCError('resumeProducer: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        if (p.paused)
        {
            p.paused = false;
            this._emit('producer-resume', { producerId });
        }
    }

    async closeRouter(routerId)
    {
        const r = this._routers.get(routerId);
        if (!r) return;
        for (const tid of r.transports)
        {
            const t = this._transports.get(tid);
            if (!t) continue;
            for (const pid of t.producers)
            {
                const p = this._producers.get(pid);
                if (p) { p.closed = true; this._emit('producer-close', { producerId: pid }); }
                this._producers.delete(pid);
            }
            for (const cid of t.consumers)
            {
                const c = this._consumers.get(cid);
                if (c) { c.closed = true; this._emit('consumer-close', { consumerId: cid }); }
                this._consumers.delete(cid);
            }
            t.closed = true;
            this._emit('transport-close', { transportId: tid });
            this._transports.delete(tid);
        }
        r.closed = true;
        this._emit('router-close', { routerId });
        this._routers.delete(routerId);
    }

    async stats(scope)
    {
        if (scope && this._routers.has(scope))
        {
            const r = this._routers.get(scope);
            const trace = this._traceTypes.get(scope);
            return {
                kind:       'router',
                routerId:   scope,
                transports: r.transports.size,
                traceTypes: trace ? [...trace] : [],
            };
        }
        if (scope && this._transports.has(scope))
        {
            const t = this._transports.get(scope);
            return {
                kind: 'transport', transportId: scope, routerId: t.routerId,
                producers: t.producers.size, consumers: t.consumers.size,
                bitrates:  t.bitrates || null,
            };
        }
        return {
            kind:       'global',
            routers:    this._routers.size,
            transports: this._transports.size,
            producers:  this._producers.size,
            consumers:  this._consumers.size,
        };
    }

    // -- Consumer-side BWE / quality knobs --

    async setConsumerPreferredLayers(consumerId, layers)
    {
        const c = this._consumers.get(consumerId);
        if (!c || c.closed)
        {
            throw new WebRTCError('setConsumerPreferredLayers: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        if (!layers || typeof layers.spatialLayer !== 'number')
        {
            throw new WebRTCError('setConsumerPreferredLayers: layers.spatialLayer must be a number', { code: 'WEBRTC_SFU_INVALID_LAYERS' });
        }
        c.preferredLayers = {
            spatialLayer:  layers.spatialLayer,
            temporalLayer: typeof layers.temporalLayer === 'number' ? layers.temporalLayer : null,
        };
        this._emit('consumer-layers-change', { consumerId, layers: c.preferredLayers });
    }

    async setConsumerPriority(consumerId, priority)
    {
        const c = this._consumers.get(consumerId);
        if (!c || c.closed)
        {
            throw new WebRTCError('setConsumerPriority: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        const p = Number(priority);
        if (!Number.isFinite(p) || p < 1 || p > 255)
        {
            throw new WebRTCError('setConsumerPriority: priority must be 1..255', { code: 'WEBRTC_SFU_INVALID_PRIORITY' });
        }
        c.priority = p;
        this._emit('consumer-priority-change', { consumerId, priority: p });
    }

    async requestKeyFrame(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c || c.closed)
        {
            throw new WebRTCError('requestKeyFrame: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        c.keyFrameRequests += 1;
        this._emit('consumer-keyframe', { consumerId, producerId: c.producerId, count: c.keyFrameRequests });
    }

    async pauseConsumer(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c || c.closed)
        {
            throw new WebRTCError('pauseConsumer: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        if (!c.paused)
        {
            c.paused = true;
            this._emit('consumer-pause', { consumerId });
        }
    }

    async resumeConsumer(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c || c.closed)
        {
            throw new WebRTCError('resumeConsumer: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        if (c.paused)
        {
            c.paused = false;
            this._emit('consumer-resume', { consumerId });
        }
    }

    // -- Transport bitrates --

    async setTransportBitrates(transportId, opts)
    {
        const t = this._transports.get(transportId);
        if (!t || t.closed)
        {
            throw new WebRTCError('setTransportBitrates: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        t.bitrates = { ...(t.bitrates || {}), ...(opts || {}) };
        this._emit('transport-bitrates', { transportId, bitrates: t.bitrates });
    }

    // -- Data channels --

    async produceData(transport, opts)
    {
        const t = transport && this._transports.get(transport.id);
        if (!t || t.closed)
        {
            throw new WebRTCError('produceData: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const id = this._nextId('dataProducer');
        const dp = {
            id,
            dataProducerId: id,
            transportId:    t.id,
            label:          (opts && opts.label) || '',
            protocol:       (opts && opts.protocol) || '',
            ordered:        opts && opts.ordered !== undefined ? !!opts.ordered : true,
            closed:         false,
        };
        this._dataProducers.set(id, dp);
        this._emit('data-producer-new', { dataProducerId: id, transportId: t.id, label: dp.label });
        return dp;
    }

    async consumeData(transport, dataProducerId, opts)
    {
        const t = transport && this._transports.get(transport.id);
        if (!t || t.closed)
        {
            throw new WebRTCError('consumeData: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const dp = this._dataProducers.get(dataProducerId);
        if (!dp || dp.closed)
        {
            throw new WebRTCError('consumeData: unknown data producer', { code: 'WEBRTC_SFU_NO_DATA_PRODUCER' });
        }
        const id = this._nextId('dataConsumer');
        const dc = {
            id,
            dataConsumerId: id,
            transportId:    t.id,
            dataProducerId,
            label:          dp.label,
            protocol:       dp.protocol,
            ordered:        opts && opts.ordered !== undefined ? !!opts.ordered : dp.ordered,
            closed:         false,
        };
        this._dataConsumers.set(id, dc);
        this._emit('data-consumer-new', { dataConsumerId: id, transportId: t.id, dataProducerId });
        return dc;
    }

    // -- Observers --

    async observeAudioLevels(routerId, opts)
    {
        const r = this._routers.get(routerId);
        if (!r || r.closed)
        {
            throw new WebRTCError('observeAudioLevels: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const id = this._nextId('audioObserver');
        const handle = {
            id,
            kind:    'audio-level',
            routerId,
            opts:    opts || {},
            closed:  false,
            close: async () =>
            {
                if (handle.closed) return;
                handle.closed = true;
                this._observers.delete(id);
                this._emit('observer-close', { observerId: id, kind: 'audio-level' });
            },
            // Test seam: feed synthetic samples through the adapter's event bus.
            emit: (levels) =>
            {
                if (handle.closed) return;
                this._emit('audio-level', { observerId: id, routerId, levels });
            },
        };
        this._observers.set(id, handle);
        this._emit('observer-new', { observerId: id, kind: 'audio-level', routerId });
        return handle;
    }

    async observeActiveSpeaker(routerId, opts)
    {
        const r = this._routers.get(routerId);
        if (!r || r.closed)
        {
            throw new WebRTCError('observeActiveSpeaker: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const id = this._nextId('speakerObserver');
        const handle = {
            id,
            kind:    'active-speaker',
            routerId,
            opts:    opts || {},
            closed:  false,
            close: async () =>
            {
                if (handle.closed) return;
                handle.closed = true;
                this._observers.delete(id);
                this._emit('observer-close', { observerId: id, kind: 'active-speaker' });
            },
            // Test seam: announce a synthetic dominant speaker.
            emit: (producerId) =>
            {
                if (handle.closed) return;
                this._emit('active-speaker', { observerId: id, routerId, producerId });
            },
        };
        this._observers.set(id, handle);
        this._emit('observer-new', { observerId: id, kind: 'active-speaker', routerId });
        return handle;
    }

    // -- Cascade --

    async pipeToRouter(opts)
    {
        const o = opts || {};
        const prod = o.producerId && this._producers.get(o.producerId);
        if (!prod || prod.closed)
        {
            throw new WebRTCError('pipeToRouter: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        const local = o.localRouterId && this._routers.get(o.localRouterId);
        if (!local)
        {
            throw new WebRTCError('pipeToRouter: unknown local router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        if (!o.remoteRouter || (!o.remoteRouter.id && !o.remoteRouter.routerId))
        {
            throw new WebRTCError('pipeToRouter: opts.remoteRouter is required', { code: 'WEBRTC_SFU_INVALID_PIPE' });
        }
        const remoteRouterId = o.remoteRouter.id || o.remoteRouter.routerId;
        const id = this._nextId('pipe');
        const pipeProducerId = this._nextId('pipeProducer');
        const pipeConsumerId = this._nextId('pipeConsumer');
        const handle = {
            id,
            pipeId:           id,
            producerId:       o.producerId,
            localRouterId:    o.localRouterId,
            remoteRouterId,
            pipeProducerId,
            pipeConsumerId,
        };
        this._pipes.set(id, handle);
        this._emit('pipe-open', handle);
        return handle;
    }

    // -- Targeted stats --

    async getProducerStats(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p)
        {
            throw new WebRTCError('getProducerStats: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        return [{ type: 'inbound-rtp', producerId, kind: p.kind, paused: p.paused, timestamp: Date.now() }];
    }

    async getConsumerStats(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
        {
            throw new WebRTCError('getConsumerStats: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        return [{
            type: 'outbound-rtp', consumerId, producerId: c.producerId,
            kind: c.kind, paused: c.paused, priority: c.priority,
            preferredLayers: c.preferredLayers, timestamp: Date.now(),
        }];
    }

    async getTransportStats(transportId)
    {
        const t = this._transports.get(transportId);
        if (!t)
        {
            throw new WebRTCError('getTransportStats: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        return [{
            type: 'transport', transportId, routerId: t.routerId,
            producers: t.producers.size, consumers: t.consumers.size,
            bitrates: t.bitrates || null, timestamp: Date.now(),
        }];
    }

    async enableTraceEvent(routerId, types)
    {
        const r = this._routers.get(routerId);
        if (!r || r.closed)
        {
            throw new WebRTCError('enableTraceEvent: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const set = new Set(Array.isArray(types) ? types : []);
        this._traceTypes.set(routerId, set);
        this._emit('trace-enabled', { routerId, types: [...set] });
    }
}

module.exports = { MemorySfuAdapter };
