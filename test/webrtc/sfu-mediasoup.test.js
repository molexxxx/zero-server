/**
 * MediasoupSfuAdapter tests.
 *
 *   Verifies the public adapter contract using an injected mediasoup stub
 *   that mirrors the parts of the real mediasoup module the adapter uses.
 *   A second suite asserts that omitting the stub surfaces a clean
 *   `WEBRTC_SFU_NOT_INSTALLED` error when the real package isn't present.
 */
'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
    SfuAdapter, MediasoupSfuAdapter, loadSfuAdapter, WebRTCError,
} = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc'));

// ---------------------------------------------------------------------------
//  mediasoup stub
// ---------------------------------------------------------------------------

let _idSeq = 0;
const nextId = (p) => `${p}-${++_idSeq}`;

function makeProducer({ kind, rtpParameters })
{
    const id = nextId('producer');
    const ee = new EventEmitter();
    const p = {
        id, kind, rtpParameters,
        paused:  false,
        closed:  false,
        async pause()  { p.paused = true; },
        async resume() { p.paused = false; },
        async getStats() { return [{ id, type: 'producer-stats' }]; },
        async enableTraceEvent(_types) { p._traceTypes = _types; },
        on:      ee.on.bind(ee),
        emit:    ee.emit.bind(ee),
    };
    return p;
}

function makeConsumer({ producerId, rtpCapabilities, producer })
{
    const id = nextId('consumer');
    const ee = new EventEmitter();
    const c = {
        id,
        producerId,
        rtpCapabilities,
        kind:          producer.kind,
        rtpParameters: producer.rtpParameters,
        closed:        false,
        paused:        false,
        priority:      1,
        preferredLayers: null,
        keyFrames:     0,
        async setPreferredLayers(layers)  { c.preferredLayers = layers; },
        async setPriority(p)              { c.priority = p; },
        async requestKeyFrame()           { c.keyFrames += 1; },
        async pause()                     { c.paused = true; },
        async resume()                    { c.paused = false; },
        async getStats()                  { return [{ id, type: 'consumer-stats' }]; },
        async enableTraceEvent(types)     { c._traceTypes = types; },
        on:    ee.on.bind(ee),
        emit:  ee.emit.bind(ee),
    };
    return c;
}

function makeDataProducer({ label, protocol, ordered })
{
    const id = nextId('dataProducer');
    const ee = new EventEmitter();
    return {
        id, label: label || '', protocol: protocol || '',
        sctpStreamParameters: { ordered: ordered !== false },
        on: ee.on.bind(ee), emit: ee.emit.bind(ee),
    };
}

function makeDataConsumer({ dataProducerId, ordered })
{
    const id = nextId('dataConsumer');
    const ee = new EventEmitter();
    return {
        id, dataProducerId, label: '', protocol: '',
        sctpStreamParameters: { ordered: ordered !== false },
        on: ee.on.bind(ee), emit: ee.emit.bind(ee),
    };
}

function makeAudioLevelObserver()
{
    const ee = new EventEmitter();
    return {
        on: ee.on.bind(ee), emit: ee.emit.bind(ee),
        async close() { /* noop */ },
    };
}

function makeActiveSpeakerObserver()
{
    const ee = new EventEmitter();
    return {
        on: ee.on.bind(ee), emit: ee.emit.bind(ee),
        async close() { /* noop */ },
    };
}

function makeTransport()
{
    const id = nextId('transport');
    const observerEE = new EventEmitter();
    const producers = new Map();
    const consumers = new Map();
    const t = {
        id,
        iceParameters:  { usernameFragment: id },
        iceCandidates:  [],
        dtlsParameters: { role: 'auto', fingerprints: [] },
        sctpParameters: null,
        observer:       { on: observerEE.on.bind(observerEE), emit: observerEE.emit.bind(observerEE) },
        async produce(opts)
        {
            const p = makeProducer(opts);
            producers.set(p.id, p);
            return p;
        },
        async consume(opts)
        {
            const c = makeConsumer({ ...opts, producer: opts._producer });
            consumers.set(c.id, c);
            return c;
        },
        async getStats() { return [{ id, type: 'transport-stats' }]; },
        async setMaxIncomingBitrate(v) { t.maxIncoming = v; },
        async setMaxOutgoingBitrate(v) { t.maxOutgoing = v; },
        async setMinOutgoingBitrate(v) { t.minOutgoing = v; },
        async produceData(opts)
        {
            const dp = makeDataProducer(opts || {});
            return dp;
        },
        async consumeData(opts)
        {
            const dc = makeDataConsumer(opts || {});
            return dc;
        },
        async enableTraceEvent(types) { t._traceTypes = types; },
        close()
        {
            t.closed = true;
            observerEE.emit('close');
        },
        closed: false,
    };
    return t;
}

function makeRouter()
{
    const id = nextId('router');
    const observerEE = new EventEmitter();
    const transports = new Map();
    const producers  = new Map();
    let canConsumeReturn = true;
    const r = {
        id,
        rtpCapabilities: { codecs: [], headerExtensions: [] },
        observer:        { on: observerEE.on.bind(observerEE), emit: observerEE.emit.bind(observerEE) },
        async createWebRtcTransport(_opts)
        {
            const t = makeTransport();
            const origConsume  = t.consume;
            transports.set(t.id, t);
            t.consume = (opts) =>
            {
                const prod = producers.get(opts.producerId);
                return origConsume.call(t, { ...opts, _producer: prod });
            };
            const origProduce  = t.produce;
            t.produce = async (opts) =>
            {
                const p = await origProduce.call(t, opts);
                producers.set(p.id, p);
                return p;
            };
            return t;
        },
        canConsume({ producerId }) { return canConsumeReturn && producers.has(producerId); },
        async getStats() { return [{ id, type: 'router-stats' }]; },
        async createAudioLevelObserver(_opts) { return makeAudioLevelObserver(); },
        async createActiveSpeakerObserver(_opts) { return makeActiveSpeakerObserver(); },
        async pipeToRouter(opts)
        {
            const pp = { id: nextId('pipeProducer') };
            const pc = { id: nextId('pipeConsumer') };
            return { pipeProducer: pp, pipeConsumer: pc, opts };
        },
        async close()
        {
            for (const t of transports.values())
            {
                if (!t.closed) t.close();
            }
            r.closed = true;
            observerEE.emit('close');
        },
        closed: false,
        // test hook
        _setCanConsume(v) { canConsumeReturn = v; },
    };
    return r;
}

function makeWorker()
{
    const ee = new EventEmitter();
    const routers = [];
    return {
        pid: 1234,
        async createRouter()
        {
            const r = makeRouter();
            routers.push(r);
            return r;
        },
        on:   ee.on.bind(ee),
        emit: ee.emit.bind(ee),
        async close() { /* noop */ },
    };
}

function makeMediasoupStub()
{
    const workers = [];
    return {
        async createWorker(_settings)
        {
            const w = makeWorker();
            workers.push(w);
            return w;
        },
        _workers: workers,
    };
}

// ---------------------------------------------------------------------------
//  Suite
// ---------------------------------------------------------------------------

describe('MediasoupSfuAdapter', () =>
{
    let stub, sfu;
    beforeEach(() =>
    {
        stub = makeMediasoupStub();
        sfu  = new MediasoupSfuAdapter({ mediasoup: stub });
    });
    afterEach(async () => { try { await sfu.close(); } catch (_) { /* */ } });

    it('extends SfuAdapter', () =>
    {
        expect(sfu).toBeInstanceOf(SfuAdapter);
    });

    it('createRouter boots a worker once and reuses it across routers', async () =>
    {
        const events = [];
        sfu.onEvent((e) => events.push(e));
        const r1 = await sfu.createRouter();
        const r2 = await sfu.createRouter();
        expect(stub._workers).toHaveLength(1);
        expect(r1.routerId).toMatch(/^router-/);
        expect(r2.routerId).not.toBe(r1.routerId);
        expect(r1.rtpCapabilities).toBeTruthy();
        expect(events.filter((e) => e === 'router-new')).toHaveLength(2);
    });

    it('createTransport rejects unknown routers', async () =>
    {
        await expect(sfu.createTransport({ id: 'nope' }, { id: 'p' }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_ROUTER' });
    });

    it('createTransport returns ICE / DTLS handshake parameters', async () =>
    {
        const r = await sfu.createRouter();
        const t = await sfu.createTransport(r, { id: 'peer-1' });
        expect(t.transportId).toMatch(/^transport-/);
        expect(t.iceParameters).toBeTruthy();
        expect(t.dtlsParameters).toBeTruthy();
        expect(Array.isArray(t.iceCandidates)).toBe(true);
        expect(t.routerId).toBe(r.id);
    });

    it('produce validates kind and rejects unknown transports', async () =>
    {
        const r = await sfu.createRouter();
        const t = await sfu.createTransport(r, { id: 'p' });
        await expect(sfu.produce(t, 'midi', {})).rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_KIND' });
        await expect(sfu.produce({ id: 'nope' }, 'audio', {})).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
    });

    it('produce / consume cycle emits events and exposes ids', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));
        const r = await sfu.createRouter();
        const tPub = await sfu.createTransport(r, { id: 'pub' });
        const tSub = await sfu.createTransport(r, { id: 'sub' });
        const prod = await sfu.produce(tPub, 'audio', { codecs: [] });
        const cons = await sfu.consume(tSub, prod.producerId, { codecs: [] });
        expect(prod.kind).toBe('audio');
        expect(cons.producerId).toBe(prod.producerId);
        expect(events.some((e) => e[0] === 'producer-new')).toBe(true);
        expect(events.some((e) => e[0] === 'consumer-new')).toBe(true);
    });

    it('consume throws WEBRTC_SFU_CANNOT_CONSUME when router.canConsume() is false', async () =>
    {
        const r = await sfu.createRouter();
        const tPub = await sfu.createTransport(r, { id: 'pub' });
        const tSub = await sfu.createTransport(r, { id: 'sub' });
        const prod = await sfu.produce(tPub, 'video', {});

        // Flip canConsume on the underlying native router.
        const native = sfu._routers.get(r.id);
        native._setCanConsume(false);

        await expect(sfu.consume(tSub, prod.producerId, {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_CANNOT_CONSUME' });
    });

    it('pauseProducer / resumeProducer call into the native producer and emit events', async () =>
    {
        const events = [];
        sfu.onEvent((e) => events.push(e));
        const r = await sfu.createRouter();
        const t = await sfu.createTransport(r, { id: 'p' });
        const prod = await sfu.produce(t, 'audio', {});
        await sfu.pauseProducer(prod.producerId);
        await sfu.resumeProducer(prod.producerId);
        const native = sfu._producers.get(prod.producerId);
        expect(native.paused).toBe(false);
        expect(events).toContain('producer-pause');
        expect(events).toContain('producer-resume');
    });

    it('pause / resume reject unknown producers', async () =>
    {
        await expect(sfu.pauseProducer('producer-x')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
        await expect(sfu.resumeProducer('producer-x')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
    });

    it('closeRouter cascades transport-close, then router-close', async () =>
    {
        const events = [];
        sfu.onEvent((e) => events.push(e));
        const r = await sfu.createRouter();
        await sfu.createTransport(r, { id: 'a' });
        await sfu.createTransport(r, { id: 'b' });
        await sfu.closeRouter(r.id);
        expect(events.filter((e) => e === 'transport-close')).toHaveLength(2);
        expect(events).toContain('router-close');
        const s = await sfu.stats();
        expect(s).toEqual({ kind: 'global', routers: 0, transports: 0, producers: 0, consumers: 0 });
    });

    it('closeRouter is a no-op for unknown router ids', async () =>
    {
        await expect(sfu.closeRouter('router-bogus')).resolves.toBeUndefined();
    });

    it('stats reports global / per-router / per-transport scopes', async () =>
    {
        const r = await sfu.createRouter();
        const t = await sfu.createTransport(r, { id: 'p' });
        await sfu.produce(t, 'audio', {});

        const global = await sfu.stats();
        expect(global.kind).toBe('global');
        expect(global.routers).toBe(1);
        expect(global.transports).toBe(1);
        expect(global.producers).toBe(1);

        const rs = await sfu.stats(r.id);
        expect(rs.kind).toBe('router');
        expect(rs.routerId).toBe(r.id);
        expect(Array.isArray(rs.native)).toBe(true);

        const ts = await sfu.stats(t.id);
        expect(ts.kind).toBe('transport');
        expect(ts.transportId).toBe(t.id);
        expect(ts.routerId).toBe(r.id);
    });

    it('uses a pre-supplied worker without calling createWorker', async () =>
    {
        const stub2 = makeMediasoupStub();
        const worker = await makeWorker();
        const adapter = new MediasoupSfuAdapter({ mediasoup: stub2, worker });
        await adapter.createRouter();
        expect(stub2._workers).toHaveLength(0);
        await adapter.close();
    });

    it('emits "worker-died" when the worker dies', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));
        await sfu.createRouter();
        stub._workers[0].emit('died', new Error('rip'));
        expect(events.find((e) => e[0] === 'worker-died')).toEqual(['worker-died', { error: 'rip' }]);
    });
});

describe('MediasoupSfuAdapter - extended controls', () =>
{
    let stub, sfu, r, t, prod, cons;
    beforeEach(async () =>
    {
        stub = makeMediasoupStub();
        sfu  = new MediasoupSfuAdapter({ mediasoup: stub });
        r    = await sfu.createRouter();
        t    = await sfu.createTransport(r, { id: 'p' });
        prod = await sfu.produce(t, 'video', { codecs: [] });
        cons = await sfu.consume(t, prod.producerId, { codecs: [] });
    });
    afterEach(async () => { try { await sfu.close(); } catch (_) { /* */ } });

    it('produce forwards simulcast encodings to the native transport', async () =>
    {
        const t2 = await sfu.createTransport(r, { id: 'p2' });
        const p2 = await sfu.produce(t2, 'video', { codecs: [] }, {
            encodings: [
                { rid: 'q', maxBitrate: 100000, scalabilityMode: 'L1T3' },
                { rid: 'h', maxBitrate: 300000, scalabilityMode: 'L1T3' },
                { rid: 'f', maxBitrate: 900000, scalabilityMode: 'L1T3' },
            ],
        });
        expect(p2.rtpParameters.encodings).toHaveLength(3);
        expect(p2.rtpParameters.encodings[2].rid).toBe('f');
    });

    it('setConsumerPreferredLayers calls native and validates', async () =>
    {
        await sfu.setConsumerPreferredLayers(cons.consumerId, { spatialLayer: 1, temporalLayer: 2 });
        const c = sfu._consumers.get(cons.consumerId);
        expect(c.preferredLayers).toEqual({ spatialLayer: 1, temporalLayer: 2 });
        await expect(sfu.setConsumerPreferredLayers('nope', { spatialLayer: 0 }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_CONSUMER' });
        await expect(sfu.setConsumerPreferredLayers(cons.consumerId, {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_LAYERS' });
    });

    it('setConsumerPriority validates the range', async () =>
    {
        await sfu.setConsumerPriority(cons.consumerId, 7);
        expect(sfu._consumers.get(cons.consumerId).priority).toBe(7);
        await expect(sfu.setConsumerPriority(cons.consumerId, 0))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_PRIORITY' });
        await expect(sfu.setConsumerPriority(cons.consumerId, 999))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_PRIORITY' });
    });

    it('requestKeyFrame, pauseConsumer, resumeConsumer drive the native consumer', async () =>
    {
        const events = [];
        sfu.onEvent((e) => events.push(e));
        await sfu.requestKeyFrame(cons.consumerId);
        await sfu.pauseConsumer(cons.consumerId);
        await sfu.resumeConsumer(cons.consumerId);
        const native = sfu._consumers.get(cons.consumerId);
        expect(native.keyFrames).toBe(1);
        expect(native.paused).toBe(false);
        expect(events).toContain('consumer-pause');
        expect(events).toContain('consumer-resume');
    });

    it('setTransportBitrates passes through every clamp', async () =>
    {
        await sfu.setTransportBitrates(t.transportId, { maxIncoming: 1, maxOutgoing: 2, min: 3 });
        const native = sfu._transports.get(t.transportId);
        expect(native.maxIncoming).toBe(1);
        expect(native.maxOutgoing).toBe(2);
        expect(native.minOutgoing).toBe(3);
        await expect(sfu.setTransportBitrates('nope', {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
    });

    it('produceData / consumeData wire SCTP data channels', async () =>
    {
        const dp = await sfu.produceData(t, { label: 'chat', ordered: true });
        expect(dp.dataProducerId).toMatch(/^dataProducer-/);
        expect(dp.label).toBe('chat');
        const dc = await sfu.consumeData(t, dp.dataProducerId, {});
        expect(dc.dataConsumerId).toMatch(/^dataConsumer-/);
        expect(dc.dataProducerId).toBe(dp.dataProducerId);
        await expect(sfu.produceData({ id: 'nope' }, {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
    });

    it('observeAudioLevels exposes a closable handle that emits audio-level events', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));
        const handle = await sfu.observeAudioLevels(r.id, { interval: 500 });
        expect(handle.id).toMatch(/^audioObserver-/);
        handle.emit([{ producerId: 'x', volume: -40 }]);
        expect(events).toContainEqual(['audio-level', expect.objectContaining({ observerId: handle.id })]);
        await handle.close();
        expect(handle.closed).toBe(true);
    });

    it('observeActiveSpeaker exposes a closable handle that emits active-speaker events', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));
        const handle = await sfu.observeActiveSpeaker(r.id, {});
        handle.emit('producer-x');
        expect(events).toContainEqual(['active-speaker', expect.objectContaining({ producerId: 'producer-x' })]);
        await handle.close();
    });

    it('pipeToRouter delegates to the native router and tracks the pipe', async () =>
    {
        const r2 = await sfu.createRouter();
        const pipe = await sfu.pipeToRouter({
            producerId:    prod.producerId,
            localRouterId: r.id,
            remoteRouter:  r2,
        });
        expect(pipe.pipeId).toMatch(/^pipe-/);
        expect(pipe.pipeProducerId).toMatch(/^pipeProducer-/);
        expect(pipe.pipeConsumerId).toMatch(/^pipeConsumer-/);
        await expect(sfu.pipeToRouter({ producerId: 'x', localRouterId: r.id, remoteRouter: r2 }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
        await expect(sfu.pipeToRouter({ producerId: prod.producerId, localRouterId: 'x', remoteRouter: r2 }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_ROUTER' });
        await expect(sfu.pipeToRouter({ producerId: prod.producerId, localRouterId: r.id }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_PIPE' });
    });

    it('getProducerStats / getConsumerStats / getTransportStats hit the native objects', async () =>
    {
        await expect(sfu.getProducerStats(prod.producerId)).resolves.toEqual([{ id: expect.any(String), type: 'producer-stats' }]);
        await expect(sfu.getConsumerStats(cons.consumerId)).resolves.toEqual([{ id: expect.any(String), type: 'consumer-stats' }]);
        await expect(sfu.getTransportStats(t.transportId)).resolves.toEqual([{ id: expect.any(String), type: 'transport-stats' }]);
        await expect(sfu.getProducerStats('nope')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
        await expect(sfu.getConsumerStats('nope')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_CONSUMER' });
        await expect(sfu.getTransportStats('nope')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
    });

    it('enableTraceEvent fans out to every entity attached to the router', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));
        await sfu.enableTraceEvent(r.id, ['probation', 'bwe']);
        const native = sfu._transports.get(t.transportId);
        expect(native._traceTypes).toEqual(['probation', 'bwe']);
        expect(events).toContainEqual(['trace-enabled', { routerId: r.id, types: ['probation', 'bwe'] }]);
    });

    it('default media codecs include VP9, H264, and AV1 with standard rtcpFeedback', () =>
    {
        const codecs = sfu._mediaCodecs;
        const names = codecs.map((c) => c.mimeType);
        expect(names).toEqual(expect.arrayContaining(['audio/opus', 'video/VP8', 'video/VP9', 'video/H264', 'video/AV1']));
        const vp9 = codecs.find((c) => c.mimeType === 'video/VP9');
        expect(vp9.rtcpFeedback.map((f) => f.type)).toEqual(expect.arrayContaining(['nack', 'goog-remb', 'transport-cc']));
    });
});

describe('MediasoupSfuAdapter without the peerDependency', () =>
{
    it('throws WEBRTC_SFU_NOT_INSTALLED when the real package is missing', () =>
    {
        try
        {
            new MediasoupSfuAdapter();
            throw new Error('expected MediasoupSfuAdapter to throw');
        }
        catch (err)
        {
            expect(err).toBeInstanceOf(WebRTCError);
            expect(err.code).toBe('WEBRTC_SFU_NOT_INSTALLED');
        }
    });

    it('loadSfuAdapter("mediasoup") surfaces the same WEBRTC_SFU_NOT_INSTALLED', () =>
    {
        try
        {
            loadSfuAdapter('mediasoup');
            throw new Error('expected loadSfuAdapter to throw');
        }
        catch (err)
        {
            expect(err).toBeInstanceOf(WebRTCError);
            expect(err.code).toBe('WEBRTC_SFU_NOT_INSTALLED');
        }
    });
});
