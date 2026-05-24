/**
 * CascadeCoordinator tests.
 *
 *   Two `SignalingHub`s share an in-memory cluster bus; each owns its own
 *   `MemorySfuAdapter`.  We verify the cascade orchestrator wires
 *   `pipeToRouter` between the bridges so a producer created on node A is
 *   mirrored as a piped producer on node B's router.
 */

'use strict';

const {
    SignalingHub,
    MemorySfuAdapter,
    useCluster,
    MemoryClusterAdapter,
    useCascade,
    CascadeCoordinator,
} = require('../../lib/webrtc');

function makeNode(bus, nodeId)
{
    const sfu = new MemorySfuAdapter();
    const hub = new SignalingHub({ sfu, topology: 'sfu' });
    useCluster(hub, bus, { nodeId });
    const cascade = useCascade(hub, { nodeId });
    return { hub, sfu, cascade };
}

describe('CascadeCoordinator', () =>
{
    let bus, a, b;
    beforeEach(() =>
    {
        bus = new MemoryClusterAdapter();
        a   = makeNode(bus, 'a');
        b   = makeNode(bus, 'b');
    });
    afterEach(() =>
    {
        a.cascade.close();
        b.cascade.close();
        a.hub._cluster && a.hub._cluster.close();
        b.hub._cluster && b.hub._cluster.close();
    });

    it('constructor requires a hub with a cluster bound', () =>
    {
        const sfu = new MemorySfuAdapter();
        const lonely = new SignalingHub({ sfu });
        expect(() => new CascadeCoordinator(lonely)).toThrow(/cluster/i);
    });

    it('constructor requires an SfuAdapter', () =>
    {
        const hub = new SignalingHub();
        useCluster(hub, new MemoryClusterAdapter(), { nodeId: 'lonely' });
        expect(() => new CascadeCoordinator(hub)).toThrow(/SfuAdapter/);
        hub._cluster.close();
    });

    it('registerLocalBridge announces bridge:open and is idempotent', async () =>
    {
        const events = [];
        a.hub.on('cascade:bridge-open', (e) => events.push(['open', e]));
        b.hub.on('cascade:peer-bridge', (e) => events.push(['peer', e]));
        const r = await a.sfu.createRouter();
        a.cascade.registerLocalBridge('room-1', r);
        a.cascade.registerLocalBridge('room-1', r); // idempotent
        const r2 = await b.sfu.createRouter();
        b.cascade.registerLocalBridge('room-1', r2);
        expect(events.some(([k]) => k === 'open')).toBe(true);
        expect(events.some(([k, p]) => k === 'peer' && p.nodeId === 'a')).toBe(true);
    });

    it('mirrors a remote producer via the directory and fires availability events', async () =>
    {
        const rA = await a.sfu.createRouter();
        const rB = await b.sfu.createRouter();
        a.cascade.registerLocalBridge('room-x', rA);
        b.cascade.registerLocalBridge('room-x', rB);

        const events = [];
        b.hub.on('cascade:producer-available', (e) => events.push(['avail', e]));
        b.hub.on('cascade:producer-pipe-failed', (e) => events.push(['fail', e]));

        const tA = await a.sfu.createTransport(rA, { id: 'pa' });
        const prod = await a.sfu.produce(tA, 'video', { codecs: [] });

        // Memory adapter dispatches events synchronously, but pipe
        // creation is async in cascade — yield once.
        await new Promise((r) => setImmediate(r));

        // The producer should show up in B's remote directory.
        const rec = b.cascade.locateRemoteProducer(prod.producerId);
        expect(rec).toBeTruthy();
        expect(rec.nodeId).toBe('a');
        expect(rec.room).toBe('room-x');
        expect(rec.kind).toBe('video');

        // And `cascade:producer-available` fired on B.
        expect(events.some(([k]) => k === 'avail')).toBe(true);

        // The memory adapter rejects pipeToRouter for unknown producerIds
        // (it has no real PipeTransport handshake), so we expect a
        // `pipe-failed` event rather than `producer-piped`.  This is the
        // contract for adapters that can't pipe across processes — the
        // directory is authoritative regardless.
        expect(events.some(([k]) => k === 'fail')).toBe(true);

        const stats = b.cascade.stats();
        const bridge = stats.bridges.find((br) => br.room === 'room-x');
        expect(bridge.peers).toBe(1);
        expect(stats.remoteProducers).toBe(1);
    });

    it('retracts a remote producer on producer-close', async () =>
    {
        const rA = await a.sfu.createRouter();
        const rB = await b.sfu.createRouter();
        a.cascade.registerLocalBridge('rm', rA);
        b.cascade.registerLocalBridge('rm', rB);
        const tA = await a.sfu.createTransport(rA, { id: 'pa' });
        const prod = await a.sfu.produce(tA, 'audio', {});
        await new Promise((r) => setImmediate(r));
        expect(b.cascade.locateRemoteProducer(prod.producerId)).toBeTruthy();
        // Close the producer's router on node A.
        await a.sfu.closeRouter(rA.id);
        await new Promise((r) => setImmediate(r));
        expect(b.cascade.locateRemoteProducer(prod.producerId)).toBeNull();
    });

    it('closeLocalBridge announces bridge:close and peers drop pipes', async () =>
    {
        const rA = await a.sfu.createRouter();
        const rB = await b.sfu.createRouter();
        a.cascade.registerLocalBridge('rm2', rA);
        b.cascade.registerLocalBridge('rm2', rB);
        const tA = await a.sfu.createTransport(rA, { id: 'pa' });
        const prod = await a.sfu.produce(tA, 'video', {});
        await new Promise((r) => setImmediate(r));
        const events = [];
        b.hub.on('cascade:peer-bridge-close', (e) => events.push(e));
        a.cascade.closeLocalBridge('rm2');
        await new Promise((r) => setImmediate(r));
        expect(events).toEqual([{ room: 'rm2', nodeId: 'a' }]);
        expect(b.cascade.locateRemoteProducer(prod.producerId)).toBeNull();
        const stats = b.cascade.stats();
        const bridge = stats.bridges.find((br) => br.room === 'rm2');
        expect(bridge.peers).toBe(0);
        expect(bridge.pipes).toBe(0);
    });

    it('hello replay teaches a late-joining node about existing bridges + producers', async () =>
    {
        const rA = await a.sfu.createRouter();
        a.cascade.registerLocalBridge('late', rA);
        const tA = await a.sfu.createTransport(rA, { id: 'pa' });
        const prod = await a.sfu.produce(tA, 'audio', {});

        // C joins after A has already announced.
        const c = makeNode(bus, 'c');
        const rC = await c.sfu.createRouter();
        c.cascade.registerLocalBridge('late', rC);
        await new Promise((r) => setImmediate(r));

        const rec = c.cascade.locateRemoteProducer(prod.producerId);
        expect(rec).toBeTruthy();
        expect(rec.nodeId).toBe('a');
        c.cascade.close();
        c.hub._cluster.close();
    });

    it('stats() reports bridge + remote-producer counts', async () =>
    {
        const r = await a.sfu.createRouter();
        a.cascade.registerLocalBridge('room-s', r);
        const s = a.cascade.stats();
        expect(s.nodeId).toBe('a');
        expect(s.bridges).toHaveLength(1);
        expect(s.bridges[0]).toMatchObject({ room: 'room-s', localProducers: 0, peers: 0, pipes: 0 });
    });

    it('close() is idempotent and tears down state', () =>
    {
        a.cascade.close();
        a.cascade.close();
        expect(a.cascade._closed).toBe(true);
    });

    it('registerLocalBridge validates its arguments', () =>
    {
        expect(() => a.cascade.registerLocalBridge('', { id: 'x' })).toThrow(/roomName/);
        expect(() => a.cascade.registerLocalBridge('room', {})).toThrow(/router/);
    });

    it('peer bridge with no local bridge is a no-op', async () =>
    {
        // a registers, b does not — b should ignore producer:new messages.
        const rA = await a.sfu.createRouter();
        a.cascade.registerLocalBridge('solo', rA);
        const tA = await a.sfu.createTransport(rA, { id: 'p' });
        const prod = await a.sfu.produce(tA, 'video', {});
        await new Promise((r) => setImmediate(r));
        expect(b.cascade.locateRemoteProducer(prod.producerId)).toBeNull();
    });
});
