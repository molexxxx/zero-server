/**
 * CascadeCoordinator — branch coverage for the successful pipe path
 * (producer-piped emit + pipe cleanup on bridge close).
 *
 * The default Memory SFU rejects pipeToRouter (no PipeTransport), so the
 * existing cascade test only exercises the pipe-failed branch.  Here we
 * inject a tiny SFU stub that always succeeds.
 */

'use strict';

const {
    SignalingHub,
    MemorySfuAdapter,
    useCluster,
    MemoryClusterAdapter,
    useCascade,
} = require('../../lib/webrtc');

/**
 * Wrap a MemorySfuAdapter so pipeToRouter resolves with a fake handle
 * (good enough to exercise the success branches in cascade.js).
 */
function pipingSfu()
{
    const sfu = new MemorySfuAdapter();
    sfu.pipeToRouter = async ({ producerId }) =>
    {
        return { id: `pipe-${producerId}`, producerId };
    };
    return sfu;
}

function makeNode(bus, nodeId, sfu)
{
    const hub = new SignalingHub({ sfu, topology: 'sfu' });
    useCluster(hub, bus, { nodeId });
    const cascade = useCascade(hub, { nodeId });
    return { hub, sfu, cascade };
}

describe('CascadeCoordinator pipe success branches', () =>
{
    let bus, a, b;
    beforeEach(() =>
    {
        bus = new MemoryClusterAdapter();
        a   = makeNode(bus, 'a', pipingSfu());
        b   = makeNode(bus, 'b', pipingSfu());
    });
    afterEach(() =>
    {
        a.cascade.close();
        b.cascade.close();
        a.hub._cluster && a.hub._cluster.close();
        b.hub._cluster && b.hub._cluster.close();
    });

    it('emits cascade:producer-piped on the consuming node', async () =>
    {
        const rA = await a.sfu.createRouter();
        const rB = await b.sfu.createRouter();
        a.cascade.registerLocalBridge('rm', rA);
        b.cascade.registerLocalBridge('rm', rB);

        const piped = [];
        b.hub.on('cascade:producer-piped', (e) => piped.push(e));

        const tA = await a.sfu.createTransport(rA, { id: 'pa' });
        const prod = await a.sfu.produce(tA, 'video', { codecs: [] });
        await new Promise((r) => setImmediate(r));

        expect(piped).toHaveLength(1);
        expect(piped[0]).toMatchObject({ room: 'rm', producerId: prod.producerId, fromNode: 'a' });

        const stats = b.cascade.stats();
        const bridge = stats.bridges.find((br) => br.room === 'rm');
        expect(bridge.pipes).toBe(1);
    });

    it('drops piped handles when the remote bridge closes', async () =>
    {
        const rA = await a.sfu.createRouter();
        const rB = await b.sfu.createRouter();
        a.cascade.registerLocalBridge('rm', rA);
        b.cascade.registerLocalBridge('rm', rB);
        const tA = await a.sfu.createTransport(rA, { id: 'pa' });
        await a.sfu.produce(tA, 'audio', {});
        await new Promise((r) => setImmediate(r));
        // Confirm a pipe was opened.
        const before = b.cascade.stats().bridges.find((br) => br.room === 'rm');
        expect(before.pipes).toBe(1);

        a.cascade.closeLocalBridge('rm');
        await new Promise((r) => setImmediate(r));

        const after = b.cascade.stats().bridges.find((br) => br.room === 'rm');
        expect(after.pipes).toBe(0);
    });

});
