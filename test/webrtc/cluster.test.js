'use strict';

const { EventEmitter } = require('node:events');

const { SignalingHub } = require('../../lib/webrtc/signaling');
const {
    useCluster, ClusterCoordinator, MemoryClusterAdapter,
} = require('../../lib/webrtc/cluster');

// --- Minimal mock transport (same shape as signaling.test.js) ---

class MockTransport extends EventEmitter
{
    constructor()
    {
        super();
        this.outbox = [];
        this.closed = false;
    }
    send(d)
    {
        if (!this.closed) this.outbox.push(d);
    }
    close()
    {
        this.closed = true;
        this.emit('close', 1000, '');
    }
    inject(obj)
    {
        this.emit('message', typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
    sent(type)
    {
        return this.outbox
            .map(s => { try { return JSON.parse(s); } catch { return null; } })
            .filter(m => m && m.type === type);
    }
}

const MIN_SDP = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:0123456789abcdef0123456789',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    '',
].join('\r\n');

function join(hub, name = 'room')
{
    const t = new MockTransport();
    const p = hub.attach(t, { ip: '127.0.0.1' });
    hub.room(name).open();
    t.inject({ type: 'join', room: name });
    return { peer: p, transport: t };
}

// --- Tests ---

describe('webrtc cluster adapter', () =>
{
    describe('useCluster()', () =>
    {
        it('rejects an adapter without publish/subscribe', () =>
        {
            const hub = new SignalingHub();
            expect(() => useCluster(hub, {})).toThrow(/adapter/);
            expect(() => useCluster(hub, { publish: () => {} })).toThrow(/adapter/);
            expect(() => useCluster(hub, { subscribe: () => {} })).toThrow(/adapter/);
        });

        it('returns a coordinator with a stable nodeId', () =>
        {
            const hub = new SignalingHub();
            const a = new MemoryClusterAdapter();
            const c = useCluster(hub, a);
            expect(c).toBeInstanceOf(ClusterCoordinator);
            expect(typeof c.nodeId).toBe('string');
            expect(c.nodeId.length).toBeGreaterThan(0);
            expect(hub._cluster).toBe(c);
        });

        it('accepts an explicit nodeId', () =>
        {
            const hub = new SignalingHub();
            const c = useCluster(hub, new MemoryClusterAdapter(), { nodeId: 'node-A' });
            expect(c.nodeId).toBe('node-A');
        });
    });

    describe('peer directory across nodes', () =>
    {
        let adapter, hubA, hubB;

        beforeEach(() =>
        {
            adapter = new MemoryClusterAdapter();
            hubA = new SignalingHub();
            hubB = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });
            useCluster(hubB, adapter, { nodeId: 'B' });
        });

        it('announces local joins so peers on other nodes become visible', () =>
        {
            const { peer: p1 } = join(hubA, 'lobby');
            expect(hubB._cluster._remotePeers.has(p1.id)).toBe(true);
            const entry = hubB._cluster._remotePeers.get(p1.id);
            expect(entry.nodeId).toBe('A');
            expect(entry.room).toBe('lobby');
        });

        it('removes the directory entry on leave', () =>
        {
            const { peer: p1, transport: t1 } = join(hubA, 'lobby');
            expect(hubB._cluster._remotePeers.has(p1.id)).toBe(true);
            t1.inject({ type: 'leave' });
            expect(hubB._cluster._remotePeers.has(p1.id)).toBe(false);
        });

        it('removes the directory entry on transport close', () =>
        {
            const { peer: p1, transport: t1 } = join(hubA, 'lobby');
            expect(hubB._cluster._remotePeers.has(p1.id)).toBe(true);
            t1.close();
            expect(hubB._cluster._remotePeers.has(p1.id)).toBe(false);
        });

        it('late-joining node receives directory dump via hello', () =>
        {
            // hubA has a peer already attached.
            const { peer: p1 } = join(hubA, 'lobby');
            // hubC joins the cluster later.
            const hubC = new SignalingHub();
            useCluster(hubC, adapter, { nodeId: 'C' });
            expect(hubC._cluster._remotePeers.has(p1.id)).toBe(true);
        });
    });

    describe('room broadcast fanout', () =>
    {
        it('mirrors room broadcasts to peers on other nodes', () =>
        {
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            const hubB = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });
            useCluster(hubB, adapter, { nodeId: 'B' });

            const a1 = join(hubA, 'lobby');
            const b1 = join(hubB, 'lobby');
            // Clear the "peer-joined" noise from the inbox.
            a1.transport.outbox.length = 0;
            b1.transport.outbox.length = 0;

            // hubA peer mutes -> hubB peer should see a 'mute' broadcast.
            a1.transport.inject({ type: 'mute', kind: 'audio' });
            const muteEvents = b1.transport.sent('mute');
            expect(muteEvents.length).toBe(1);
            expect(muteEvents[0].from).toBe(a1.peer.id);
            expect(muteEvents[0].kind).toBe('audio');
        });

        it('does not echo a node\'s own broadcast back to itself', () =>
        {
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });

            const a1 = join(hubA, 'lobby');
            const a2 = join(hubA, 'lobby');
            a1.transport.outbox.length = 0;
            a2.transport.outbox.length = 0;

            a1.transport.inject({ type: 'mute', kind: 'audio' });
            // a2 sees the local broadcast once.
            expect(a2.transport.sent('mute').length).toBe(1);
            // a1 (originator) sees nothing.
            expect(a1.transport.sent('mute').length).toBe(0);
        });

        it('excludes the originator on the receiving node', () =>
        {
            // peer-joined broadcasts include exclude=joiner; if the joiner is
            // on the local node it must not get its own peer-joined.
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            const hubB = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });
            useCluster(hubB, adapter, { nodeId: 'B' });

            // Pre-existing peer on hubB.
            const b1 = join(hubB, 'lobby');
            b1.transport.outbox.length = 0;

            // New peer joins on hubA.
            const a1 = join(hubA, 'lobby');

            // b1 should be told peer-joined for a1.
            const joined = b1.transport.sent('peer-joined');
            expect(joined.length).toBeGreaterThanOrEqual(1);
            expect(joined[joined.length - 1].id).toBe(a1.peer.id);
        });
    });

    describe('direct routing across nodes', () =>
    {
        it('routes an offer from a peer on hubA to a peer on hubB', () =>
        {
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            const hubB = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });
            useCluster(hubB, adapter, { nodeId: 'B' });

            const a1 = join(hubA, 'lobby');
            const b1 = join(hubB, 'lobby');
            b1.transport.outbox.length = 0;

            a1.transport.inject({
                type: 'offer', target: b1.peer.id, sdp: MIN_SDP,
            });
            const offers = b1.transport.sent('offer');
            expect(offers.length).toBe(1);
            expect(offers[0].from).toBe(a1.peer.id);
            expect(offers[0].sdp).toBe(MIN_SDP);
        });

        it('routes an ICE candidate from hubA to a peer on hubB', () =>
        {
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            const hubB = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });
            useCluster(hubB, adapter, { nodeId: 'B' });

            const a1 = join(hubA, 'lobby');
            const b1 = join(hubB, 'lobby');
            b1.transport.outbox.length = 0;

            const cand = 'candidate:1 1 udp 2113937151 192.0.2.1 54321 typ host';
            a1.transport.inject({
                type: 'ice', target: b1.peer.id, candidate: cand,
            });
            const ices = b1.transport.sent('ice');
            expect(ices.length).toBe(1);
            expect(ices[0].candidate).toBe(cand);
            expect(ices[0].from).toBe(a1.peer.id);
        });

        it('rejects with TARGET_NOT_IN_ROOM if the remote peer is in a different room', () =>
        {
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            const hubB = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });
            useCluster(hubB, adapter, { nodeId: 'B' });

            const a1 = join(hubA, 'lobby');
            const b1 = join(hubB, 'boardroom');
            a1.transport.outbox.length = 0;

            a1.transport.inject({
                type: 'offer', target: b1.peer.id, sdp: MIN_SDP,
            });
            const errs = a1.transport.sent('error');
            expect(errs.length).toBe(1);
            expect(errs[0].code).toBe('TARGET_NOT_IN_ROOM');
        });

        it('does not send to a remote peer when the target id is unknown anywhere', () =>
        {
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            useCluster(hubA, adapter, { nodeId: 'A' });
            const a1 = join(hubA, 'lobby');
            a1.transport.outbox.length = 0;

            a1.transport.inject({
                type: 'offer', target: 'phantom', sdp: MIN_SDP,
            });
            const errs = a1.transport.sent('error');
            expect(errs.length).toBe(1);
            expect(errs[0].code).toBe('TARGET_NOT_IN_ROOM');
        });
    });

    describe('coordinator lifecycle', () =>
    {
        it('close() unsubscribes the coordinator and clears remote state', () =>
        {
            const adapter = new MemoryClusterAdapter();
            const hubA = new SignalingHub();
            const hubB = new SignalingHub();
            const ca = useCluster(hubA, adapter, { nodeId: 'A' });
            useCluster(hubB, adapter, { nodeId: 'B' });

            const a1 = join(hubA, 'lobby');
            expect(hubB._cluster._remotePeers.has(a1.peer.id)).toBe(true);

            ca.close();
            // After close, further hubA joins must not reach hubB.
            const a2 = join(hubA, 'lobby');
            expect(hubB._cluster._remotePeers.has(a2.peer.id)).toBe(false);
        });

        it('emits clusterError when the adapter throws synchronously', () =>
        {
            const errs = [];
            const hub = new SignalingHub();
            hub.on('clusterError', (e) => errs.push(e));
            const adapter = {
                publish() { throw new Error('boom'); },
                subscribe() { return () => {}; },
            };
            useCluster(hub, adapter, { nodeId: 'X' });
            // Trigger a publish via hello / join path.
            const t = new MockTransport();
            const p = hub.attach(t, {});
            hub.room('r').open();
            t.inject({ type: 'join', room: 'r' });
            expect(errs.length).toBeGreaterThan(0);
            expect(errs[0].message).toBe('boom');
            // Hub itself is still healthy.
            expect(hub._peers.has(p.id)).toBe(true);
        });

        it('emits clusterError when the adapter rejects asynchronously', async () =>
        {
            const errs = [];
            const hub = new SignalingHub();
            hub.on('clusterError', (e) => errs.push(e));
            const adapter = {
                publish() { return Promise.reject(new Error('async boom')); },
                subscribe() { return () => {}; },
            };
            useCluster(hub, adapter, { nodeId: 'Y' });
            // Wait a microtask for the rejection to surface.
            await new Promise((r) => setImmediate(r));
            expect(errs.length).toBeGreaterThan(0);
            expect(errs.some(e => e.message === 'async boom')).toBe(true);
        });
    });

    describe('MemoryClusterAdapter', () =>
    {
        it('delivers published messages to all subscribers on the same channel', () =>
        {
            const a = new MemoryClusterAdapter();
            const got1 = []; const got2 = [];
            a.subscribe('x', (m) => got1.push(m));
            a.subscribe('x', (m) => got2.push(m));
            a.publish('x', { v: 1 });
            expect(got1).toEqual([{ v: 1 }]);
            expect(got2).toEqual([{ v: 1 }]);
        });

        it('unsubscribe stops further delivery', () =>
        {
            const a = new MemoryClusterAdapter();
            const got = [];
            const off = a.subscribe('x', (m) => got.push(m));
            a.publish('x', 1);
            off();
            a.publish('x', 2);
            expect(got).toEqual([1]);
        });

        it('isolates channels', () =>
        {
            const a = new MemoryClusterAdapter();
            const got = [];
            a.subscribe('x', (m) => got.push(m));
            a.publish('y', 'nope');
            expect(got).toEqual([]);
        });
    });
});
