/**
 * Region/load awareness tests for ClusterCoordinator.
 */

'use strict';

const { SignalingHub } = require('../../lib/webrtc/signaling');
const {
    useCluster, MemoryClusterAdapter,
} = require('../../lib/webrtc/cluster');

function makeNode(adapter, nodeId, opts)
{
    const hub = new SignalingHub();
    const coord = useCluster(hub, adapter, { nodeId, loadIntervalMs: 0, ...opts });
    return { hub, coord };
}

describe('ClusterCoordinator (region + load)', () =>
{
    let bus;
    beforeEach(() => { bus = new MemoryClusterAdapter(); });

    it('records region on hello and shows it in nodes()', () =>
    {
        const a = makeNode(bus, 'a', { region: 'us-east' });
        const b = makeNode(bus, 'b', { region: 'eu-west' });
        const nodes = a.coord.nodes().reduce((acc, n) => (acc[n.nodeId] = n, acc), {});
        expect(nodes.a.region).toBe('us-east');
        expect(nodes.b.region).toBe('eu-west');
        a.coord.close(); b.coord.close();
    });

    it('publishLoad() broadcasts the snapshot and peers store it', async () =>
    {
        const a = makeNode(bus, 'a', { region: 'us-east', loadProbe: () => ({ cpu: 0.42, producers: 5 }) });
        const b = makeNode(bus, 'b', { region: 'us-east' });
        const snap = await a.coord.publishLoad();
        expect(snap).toEqual({ cpu: 0.42, producers: 5 });
        const bNodes = b.coord.nodes().reduce((acc, n) => (acc[n.nodeId] = n, acc), {});
        expect(bNodes.a.load).toEqual({ cpu: 0.42, producers: 5 });
        expect(bNodes.a.region).toBe('us-east');
        a.coord.close(); b.coord.close();
    });

    it('publishLoad() is a no-op without a loadProbe', async () =>
    {
        const a = makeNode(bus, 'a');
        expect(await a.coord.publishLoad()).toBeNull();
        a.coord.close();
    });

    it('publishLoad() emits clusterError when the probe throws', async () =>
    {
        const a = makeNode(bus, 'a', { loadProbe: () => { throw new Error('boom'); } });
        const errs = [];
        a.hub.on('clusterError', (e) => errs.push(e));
        expect(await a.coord.publishLoad()).toBeNull();
        expect(errs).toHaveLength(1);
        expect(errs[0].message).toBe('boom');
        a.coord.close();
    });

    it('selectBridge local-only always returns own nodeId', () =>
    {
        const a = makeNode(bus, 'a');
        const b = makeNode(bus, 'b');
        expect(a.coord.selectBridge({ strategy: 'local-only' })).toBe('a');
        a.coord.close(); b.coord.close();
    });

    it('selectBridge least-loaded prefers the node with lowest cpu', async () =>
    {
        const a = makeNode(bus, 'a', { loadProbe: () => ({ cpu: 0.9 }) });
        const b = makeNode(bus, 'b', { loadProbe: () => ({ cpu: 0.1 }) });
        const c = makeNode(bus, 'c', { loadProbe: () => ({ cpu: 0.5 }) });
        await a.coord.publishLoad();
        await b.coord.publishLoad();
        await c.coord.publishLoad();
        expect(a.coord.selectBridge({ strategy: 'least-loaded' })).toBe('b');
        a.coord.close(); b.coord.close(); c.coord.close();
    });

    it('selectBridge region-aware prefers same-region peers', async () =>
    {
        const a = makeNode(bus, 'a', { region: 'us-east', loadProbe: () => ({ cpu: 0.8 }) });
        const b = makeNode(bus, 'b', { region: 'eu-west', loadProbe: () => ({ cpu: 0.1 }) });
        const c = makeNode(bus, 'c', { region: 'us-east', loadProbe: () => ({ cpu: 0.5 }) });
        await a.coord.publishLoad();
        await b.coord.publishLoad();
        await c.coord.publishLoad();
        // From a's perspective (us-east), prefer us-east peers (a or c).
        const pick = a.coord.selectBridge({ strategy: 'region-aware' });
        expect(['a', 'c']).toContain(pick);
        a.coord.close(); b.coord.close(); c.coord.close();
    });

    it('selectBridge region-aware-least-loaded breaks ties by load', async () =>
    {
        const a = makeNode(bus, 'a', { region: 'us-east', loadProbe: () => ({ cpu: 0.9 }) });
        const b = makeNode(bus, 'b', { region: 'eu-west', loadProbe: () => ({ cpu: 0.05 }) });
        const c = makeNode(bus, 'c', { region: 'us-east', loadProbe: () => ({ cpu: 0.2 }) });
        await a.coord.publishLoad();
        await b.coord.publishLoad();
        await c.coord.publishLoad();
        // a sees: us-east candidates {a:0.9, c:0.2}, eu-west {b:0.05}.
        // region-aware-least-loaded → pick c (us-east, lowest load).
        expect(a.coord.selectBridge()).toBe('c');
        a.coord.close(); b.coord.close(); c.coord.close();
    });

    it('selectBridge accepts a custom compare function', async () =>
    {
        const a = makeNode(bus, 'a', { loadProbe: () => ({ producers: 10 }) });
        const b = makeNode(bus, 'b', { loadProbe: () => ({ producers: 2 }) });
        await a.coord.publishLoad();
        await b.coord.publishLoad();
        const pick = a.coord.selectBridge({
            compare: (x, y) => (x.load && x.load.producers || 0) - (y.load && y.load.producers || 0),
        });
        expect(pick).toBe('b');
        a.coord.close(); b.coord.close();
    });

    it('selectBridge accepts a preferRegion override', async () =>
    {
        const a = makeNode(bus, 'a', { region: 'us-east' });
        const b = makeNode(bus, 'b', { region: 'eu-west', loadProbe: () => ({ cpu: 0.1 }) });
        await b.coord.publishLoad();
        const pick = a.coord.selectBridge({ strategy: 'region-aware', preferRegion: 'eu-west' });
        expect(pick).toBe('b');
        a.coord.close(); b.coord.close();
    });

    it('hello replay teaches a late-joining node the existing load snapshots', async () =>
    {
        const a = makeNode(bus, 'a', { region: 'us-east', loadProbe: () => ({ cpu: 0.3 }) });
        await a.coord.publishLoad();
        const c = makeNode(bus, 'c', { region: 'us-east' });
        // Wait one microtask — MemoryClusterAdapter publish is synchronous.
        await new Promise((r) => setImmediate(r));
        const cNodes = c.coord.nodes().reduce((acc, n) => (acc[n.nodeId] = n, acc), {});
        expect(cNodes.a).toBeTruthy();
        expect(cNodes.a.load).toEqual({ cpu: 0.3 });
        a.coord.close(); c.coord.close();
    });
});
