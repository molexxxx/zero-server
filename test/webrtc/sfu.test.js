/**
 * SfuAdapter base interface + Memory passthrough adapter + loader tests.
 */
'use strict';

const path = require('node:path');

const {
    SfuAdapter, MemorySfuAdapter, loadSfuAdapter, WebRTCError,
} = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc'));

describe('SfuAdapter base class', () =>
{
    it('every async method throws WEBRTC_SFU_NOT_IMPLEMENTED', async () =>
    {
        const a = new SfuAdapter();
        for (const m of ['createRouter', 'createTransport', 'produce', 'consume',
            'pauseProducer', 'resumeProducer', 'closeRouter', 'stats',
            'setConsumerPreferredLayers', 'setConsumerPriority', 'requestKeyFrame',
            'pauseConsumer', 'resumeConsumer', 'setTransportBitrates',
            'produceData', 'consumeData', 'observeAudioLevels', 'observeActiveSpeaker',
            'pipeToRouter', 'getProducerStats', 'getConsumerStats', 'getTransportStats',
            'enableTraceEvent'])
        {
            await expect(a[m]()).rejects.toMatchObject({
                name: 'WebRTCError', code: 'WEBRTC_SFU_NOT_IMPLEMENTED',
            });
        }
    });

    it('onEvent registers a handler and returns an unsubscribe function', () =>
    {
        const a = new SfuAdapter();
        const seen = [];
        const off = a.onEvent((event, payload) => seen.push([event, payload]));
        a._emit('x', { n: 1 });
        a._emit('y', { n: 2 });
        off();
        a._emit('z', { n: 3 });
        expect(seen).toEqual([['x', { n: 1 }], ['y', { n: 2 }]]);
    });

    it('onEvent rejects non-function handlers', () =>
    {
        const a = new SfuAdapter();
        expect(() => a.onEvent(null)).toThrow(/handler must be a function/);
    });

    it('_emit swallows handler exceptions', () =>
    {
        const a = new SfuAdapter();
        const seen = [];
        a.onEvent(() => { throw new Error('boom'); });
        a.onEvent((e) => seen.push(e));
        expect(() => a._emit('ok', {})).not.toThrow();
        expect(seen).toEqual(['ok']);
    });
});

describe('MemorySfuAdapter', () =>
{
    let sfu;
    beforeEach(() => { sfu = new MemorySfuAdapter(); });

    it('extends SfuAdapter', () =>
    {
        expect(sfu).toBeInstanceOf(SfuAdapter);
    });

    it('createRouter assigns a unique id and emits "router-new"', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));
        const r1 = await sfu.createRouter({ codecs: ['opus'] });
        const r2 = await sfu.createRouter();
        expect(r1.id).not.toBe(r2.id);
        expect(events.filter((e) => e[0] === 'router-new')).toHaveLength(2);
    });

    it('createTransport requires a known router', async () =>
    {
        await expect(sfu.createTransport({ id: 'nope' }, { id: 'peer-1' }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_ROUTER' });
    });

    it('createTransport returns ice + dtls handshake placeholders', async () =>
    {
        const router = await sfu.createRouter();
        const peer = { id: 'peer-1', room: 'lobby', joinedAt: Date.now() };
        const t = await sfu.createTransport(router, peer);
        expect(t.transportId).toMatch(/^transport-/);
        expect(t.routerId).toBe(router.id);
        expect(t.peer).toEqual(peer);
        expect(t.iceParameters).toBeTruthy();
        expect(t.dtlsParameters).toBeTruthy();
    });

    it('produce validates the kind argument', async () =>
    {
        const router = await sfu.createRouter();
        const t = await sfu.createTransport(router, { id: 'p1' });
        await expect(sfu.produce(t, 'midi', {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_KIND' });
    });

    it('produce / consume bind producers and consumers and emit events', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));

        const router = await sfu.createRouter();
        const t1 = await sfu.createTransport(router, { id: 'pub' });
        const t2 = await sfu.createTransport(router, { id: 'sub' });
        const prod = await sfu.produce(t1, 'audio', { codec: 'opus' });
        const cons = await sfu.consume(t2, prod.producerId, { codec: 'opus' });

        expect(prod.kind).toBe('audio');
        expect(cons.producerId).toBe(prod.producerId);
        expect(cons.kind).toBe('audio');

        expect(events.some((e) => e[0] === 'producer-new' && e[1].producerId === prod.producerId)).toBe(true);
        expect(events.some((e) => e[0] === 'consumer-new' && e[1].consumerId === cons.consumerId)).toBe(true);
    });

    it('consume rejects unknown producers / transports', async () =>
    {
        const router = await sfu.createRouter();
        const t = await sfu.createTransport(router, { id: 'sub' });
        await expect(sfu.consume(t, 'producer-bogus', {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
        await expect(sfu.consume({ id: 'nope' }, 'producer-bogus', {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
    });

    it('pauseProducer / resumeProducer flip state and emit lifecycle events', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => events.push([e, p]));

        const router = await sfu.createRouter();
        const t = await sfu.createTransport(router, { id: 'pub' });
        const prod = await sfu.produce(t, 'video', {});
        await sfu.pauseProducer(prod.producerId);
        await sfu.pauseProducer(prod.producerId); // idempotent
        await sfu.resumeProducer(prod.producerId);
        await sfu.resumeProducer(prod.producerId); // idempotent

        const pauseCount = events.filter((e) => e[0] === 'producer-pause').length;
        const resumeCount = events.filter((e) => e[0] === 'producer-resume').length;
        expect(pauseCount).toBe(1);
        expect(resumeCount).toBe(1);
    });

    it('pauseProducer / resumeProducer reject unknown producers', async () =>
    {
        await expect(sfu.pauseProducer('producer-x'))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
        await expect(sfu.resumeProducer('producer-x'))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
    });

    it('closeRouter cascade-closes transports / producers / consumers and emits events', async () =>
    {
        const events = [];
        sfu.onEvent((e) => events.push(e));

        const router = await sfu.createRouter();
        const t1 = await sfu.createTransport(router, { id: 'a' });
        const t2 = await sfu.createTransport(router, { id: 'b' });
        const prod = await sfu.produce(t1, 'audio', {});
        await sfu.consume(t2, prod.producerId, {});

        await sfu.closeRouter(router.id);
        expect(events).toContain('producer-close');
        expect(events).toContain('consumer-close');
        expect(events.filter((e) => e === 'transport-close')).toHaveLength(2);
        expect(events).toContain('router-close');

        const s = await sfu.stats();
        expect(s).toEqual({ kind: 'global', routers: 0, transports: 0, producers: 0, consumers: 0 });
    });

    it('closeRouter is a no-op for unknown router ids', async () =>
    {
        await expect(sfu.closeRouter('router-xyz')).resolves.toBeUndefined();
    });

    it('stats reports global / per-router / per-transport scopes', async () =>
    {
        const router = await sfu.createRouter();
        const t = await sfu.createTransport(router, { id: 'p' });
        await sfu.produce(t, 'audio', {});

        const global = await sfu.stats();
        expect(global.kind).toBe('global');
        expect(global.routers).toBe(1);
        expect(global.transports).toBe(1);
        expect(global.producers).toBe(1);

        const rs = await sfu.stats(router.id);
        expect(rs.kind).toBe('router');
        expect(rs.transports).toBe(1);

        const ts = await sfu.stats(t.id);
        expect(ts.kind).toBe('transport');
        expect(ts.producers).toBe(1);
        expect(ts.consumers).toBe(0);
    });
});

describe('loadSfuAdapter', () =>
{
    it('returns instances that already look like an SfuAdapter unchanged', () =>
    {
        const custom = { createRouter() {}, createTransport() {}, produce() {}, consume() {} };
        expect(loadSfuAdapter(custom)).toBe(custom);
    });

    it('builds a MemorySfuAdapter for the "memory" spec', () =>
    {
        const a = loadSfuAdapter('memory');
        expect(a).toBeInstanceOf(MemorySfuAdapter);
    });

    it('rejects empty / invalid specs', () =>
    {
        expect(() => loadSfuAdapter()).toThrow(/requires an adapter instance/);
        expect(() => loadSfuAdapter('')).toThrow(/requires an adapter instance/);
        expect(() => loadSfuAdapter(123)).toThrow(/requires an adapter instance/);
    });

    it('surfaces WEBRTC_SFU_NOT_INSTALLED when a peerDep is missing', () =>
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

    it('reports clean errors for unknown external packages', () =>
    {
        try
        {
            loadSfuAdapter('does-not-exist-sfu-package');
            throw new Error('expected loadSfuAdapter to throw');
        }
        catch (err)
        {
            expect(err).toBeInstanceOf(WebRTCError);
            expect(err.code).toBe('WEBRTC_SFU_NOT_INSTALLED');
        }
    });
});

describe('MemorySfuAdapter - extended controls', () =>
{
    let sfu, router, tProd, tSub, prod, cons;
    beforeEach(async () =>
    {
        sfu = new MemorySfuAdapter();
        router = await sfu.createRouter();
        tProd = await sfu.createTransport(router, { id: 'pub' });
        tSub = await sfu.createTransport(router, { id: 'sub' });
        prod = await sfu.produce(tProd, 'video', {});
        cons = await sfu.consume(tSub, prod.producerId, {});
    });

    it('setConsumerPreferredLayers persists layers and emits an event', async () =>
    {
        const seen = [];
        sfu.onEvent((e, p) => e === 'consumer-layers-change' && seen.push(p));
        await sfu.setConsumerPreferredLayers(cons.consumerId, { spatialLayer: 1, temporalLayer: 2 });
        expect(seen[0]).toMatchObject({ consumerId: cons.consumerId, layers: { spatialLayer: 1, temporalLayer: 2 } });
    });

    it('setConsumerPreferredLayers validates layers', async () =>
    {
        await expect(sfu.setConsumerPreferredLayers(cons.consumerId, null))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_LAYERS' });
        await expect(sfu.setConsumerPreferredLayers(cons.consumerId, { spatialLayer: 'low' }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_LAYERS' });
    });

    it('setConsumerPriority clamps to a positive integer', async () =>
    {
        await sfu.setConsumerPriority(cons.consumerId, 5);
        await expect(sfu.setConsumerPriority(cons.consumerId, 0))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_PRIORITY' });
    });

    it('requestKeyFrame increments a counter and emits an event', async () =>
    {
        const events = [];
        sfu.onEvent((e, p) => e === 'consumer-keyframe' && events.push(p));
        await sfu.requestKeyFrame(cons.consumerId);
        await sfu.requestKeyFrame(cons.consumerId);
        expect(events).toHaveLength(2);
    });

    it('pauseConsumer / resumeConsumer flip state and are idempotent', async () =>
    {
        const events = [];
        sfu.onEvent((e) => events.push(e));
        await sfu.pauseConsumer(cons.consumerId);
        await sfu.pauseConsumer(cons.consumerId);
        await sfu.resumeConsumer(cons.consumerId);
        await sfu.resumeConsumer(cons.consumerId);
        expect(events.filter((e) => e === 'consumer-pause')).toHaveLength(1);
        expect(events.filter((e) => e === 'consumer-resume')).toHaveLength(1);
    });

    it('pause/resume reject unknown consumers', async () =>
    {
        await expect(sfu.pauseConsumer('c-bogus'))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_CONSUMER' });
    });

    it('setTransportBitrates stores caller bitrates', async () =>
    {
        await sfu.setTransportBitrates(tProd.transportId, { initial: 600000, max: 1500000 });
        const ts = await sfu.stats(tProd.id);
        expect(ts.bitrates).toMatchObject({ initial: 600000, max: 1500000 });
    });

    it('produceData / consumeData wire a DC pair and emit events', async () =>
    {
        const evs = [];
        sfu.onEvent((e, p) => evs.push([e, p]));
        const dp = await sfu.produceData(tProd, { label: 'chat', ordered: true });
        const dc = await sfu.consumeData(tSub, dp.dataProducerId);
        expect(dp.label).toBe('chat');
        expect(dc.dataProducerId).toBe(dp.dataProducerId);
        expect(evs.some((e) => e[0] === 'data-producer-new')).toBe(true);
        expect(evs.some((e) => e[0] === 'data-consumer-new')).toBe(true);
    });

    it('consumeData rejects unknown data producers', async () =>
    {
        await expect(sfu.consumeData(tSub, 'dp-bogus'))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_DATA_PRODUCER' });
    });

    it('observeAudioLevels emits via the .emit() seam', async () =>
    {
        const seen = [];
        sfu.onEvent((e, p) => e === 'audio-level' && seen.push(p));
        const obs = await sfu.observeAudioLevels(router.id, { interval: 250 });
        obs.emit([{ peerId: 'pub', level: -42 }]);
        obs.close();
        expect(seen[0]).toMatchObject({ observerId: obs.id, routerId: router.id });
        expect(seen[0].levels).toEqual([{ peerId: 'pub', level: -42 }]);
    });

    it('observeActiveSpeaker emits via the .emit() seam', async () =>
    {
        const seen = [];
        sfu.onEvent((e, p) => e === 'active-speaker' && seen.push(p));
        const obs = await sfu.observeActiveSpeaker(router.id);
        obs.emit(prod.producerId);
        expect(seen[0]).toMatchObject({ observerId: obs.id, routerId: router.id, producerId: prod.producerId });
    });

    it('pipeToRouter returns handle and emits pipe-open', async () =>
    {
        const remote = await sfu.createRouter();
        const seen = [];
        sfu.onEvent((e, p) => e === 'pipe-open' && seen.push(p));
        const handle = await sfu.pipeToRouter({
            producerId: prod.producerId, localRouterId: router.id, remoteRouter: remote,
        });
        expect(handle).toMatchObject({
            producerId:     prod.producerId,
            localRouterId:  router.id,
            remoteRouterId: remote.id,
        });
        expect(handle.pipeProducerId).toBeTruthy();
        expect(handle.pipeConsumerId).toBeTruthy();
        expect(seen).toHaveLength(1);
    });

    it('pipeToRouter rejects when remoteRouter is missing', async () =>
    {
        await expect(sfu.pipeToRouter({ producerId: prod.producerId, localRouterId: router.id }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_PIPE' });
    });

    it('getProducerStats / getConsumerStats / getTransportStats return arrays', async () =>
    {
        await expect(sfu.getProducerStats(prod.producerId)).resolves.toBeInstanceOf(Array);
        await expect(sfu.getConsumerStats(cons.consumerId)).resolves.toBeInstanceOf(Array);
        await expect(sfu.getTransportStats(tProd.transportId)).resolves.toBeInstanceOf(Array);
    });

    it('enableTraceEvent persists requested trace types', async () =>
    {
        await sfu.enableTraceEvent(router.id, ['rtp', 'pli']);
        const s = await sfu.stats(router.id);
        expect(s.traceTypes).toEqual(['rtp', 'pli']);
    });
});
