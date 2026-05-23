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
            'pauseProducer', 'resumeProducer', 'closeRouter', 'stats'])
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
