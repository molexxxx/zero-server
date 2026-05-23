/**
 * @module webrtc/sfu/memory
 * @description In-process "memory" SFU adapter.
 *
 *   A passthrough router that never touches the network: every `produce()`
 *   call records a logical producer, every `consume()` call records a
 *   logical consumer, and events are emitted via {@link SfuAdapter#onEvent}.
 *   Perfect for unit tests, ≤ 4-peer audio-only rooms, and local dev
 *   where the cost of running mediasoup or LiveKit is unjustified.
 *
 *   The adapter does NOT decode or forward media packets — it models
 *   bookkeeping only.  Real packet forwarding lives in native adapters
 *   (mediasoup, LiveKit).  Treat it as a CI-grade stub.
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
        this._transports = new Map(); // transportId -> { id, routerId, peer, producers:Set, consumers:Set, closed }
        this._producers  = new Map(); // producerId  -> { id, transportId, kind, rtpParams, paused, closed }
        this._consumers  = new Map(); // consumerId  -> { id, transportId, producerId, rtpCaps, closed }
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
            return { kind: 'router', routerId: scope, transports: r.transports.size };
        }
        if (scope && this._transports.has(scope))
        {
            const t = this._transports.get(scope);
            return {
                kind: 'transport', transportId: scope, routerId: t.routerId,
                producers: t.producers.size, consumers: t.consumers.size,
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
}

module.exports = { MemorySfuAdapter };
