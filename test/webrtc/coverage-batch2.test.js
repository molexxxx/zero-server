/**
 * Branch-coverage filler tests for: signaling, bot, cluster, sfu adapters,
 * sfu/index loader, cli default deps, turn codec + turn server sweep.
 */
'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');

const {
    SignalingHub, spawnBotPeer,
    MemorySfuAdapter, LiveKitSfuAdapter,
    loadSfuAdapter,
    WebRTCError,
} = require('../../lib/webrtc');
const cluster = require('../../lib/webrtc/cluster');
const codec   = require('../../lib/webrtc/turn/codec');
const { TurnServer } = require('../../lib/webrtc/turn/server');
const { runWebRTCCommand } = require('../../lib/webrtc/cli');

// --- helpers -----------------------------------------------------------------

class MockTransport extends EventEmitter
{
    constructor() { super(); this.outbox = []; this.closed = false; }
    send(s) { if (!this.closed) this.outbox.push(s); }
    close(c, r) { if (this.closed) return; this.closed = true; this.emit('close', c, r); }
    inject(o) { this.emit('message', typeof o === 'string' ? o : JSON.stringify(o)); }
    drain() { const out = this.outbox.map(JSON.parse); this.outbox.length = 0; return out; }
}

// =============================================================================
// signaling — _handleE2eeKey and stats / media facade error paths
// =============================================================================

describe('signaling._handleE2eeKey + stats + media facade error paths', () =>
{
    it('e2ee-key without joining a room sends NOT_IN_ROOM error', () =>
    {
        const hub = new SignalingHub();
        const t = new MockTransport();
        hub.attach(t);
        t.drain();
        t.inject({ type: 'e2ee-key', epoch: 1, key: 'YQ==' });
        const last = t.drain().pop();
        expect(last.type).toBe('error');
        expect(last.code).toBe('NOT_IN_ROOM');
        hub.close();
    });

    it('e2ee-key with non-number epoch sends BAD_FRAME', () =>
    {
        const hub = new SignalingHub();
        const t = new MockTransport();
        hub.attach(t);
        t.drain();
        t.inject({ type: 'join', room: 'r' });
        t.drain();
        t.inject({ type: 'e2ee-key', epoch: 'no', key: 'YQ==' });
        const last = t.drain().pop();
        expect(last.type).toBe('error');
        expect(last.code).toBe('BAD_FRAME');
        hub.close();
    });

    it('hub.stats() surfaces an SFU adapter stats() failure as mediaPlane.error', async () =>
    {
        const sfu = new MemorySfuAdapter();
        sfu.stats = async () => { throw new Error('boom'); };
        const hub = new SignalingHub({ sfu, topology: 'sfu' });
        const s = await hub.stats();
        expect(s.mediaPlane).toEqual({ error: 'boom' });
        hub.close();
    });

    it('hub.media.onEvent throws WEBRTC_SFU_NOT_CONFIGURED without an adapter', () =>
    {
        const hub = new SignalingHub();
        expect(() => hub.media.onEvent(() => {}))
            .toThrow(/WEBRTC_SFU_NOT_CONFIGURED|hub\.media is not configured/);
        hub.close();
    });
});

// =============================================================================
// bot — onPeerJoin / onPeerLeave callbacks
// =============================================================================

describe('spawnBotPeer onPeerJoin/onPeerLeave callbacks', () =>
{
    function makeFakeWrtc()
    {
        const MIN_SDP = [
            'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdef0123456789',
            'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
            'a=setup:actpass', 'a=mid:0', 'a=sendrecv', 'a=rtpmap:111 opus/48000/2',
        ].join('\r\n') + '\r\n';
        class RTCPeerConnection extends EventEmitter
        {
            constructor() { super(); this.closed = false; this.ice = []; }
            async createOffer()  { return { type: 'offer',  sdp: MIN_SDP }; }
            async createAnswer() { return { type: 'answer', sdp: MIN_SDP }; }
            async setLocalDescription()  {}
            async setRemoteDescription() {}
            async addIceCandidate(c)      { this.ice.push(c); }
            close() { this.closed = true; }
        }
        return { RTCPeerConnection, RTCSessionDescription: class {}, RTCIceCandidate: class {} };
    }

    it('invokes onPeerJoin when a remote peer joins the room', async () =>
    {
        const hub = new SignalingHub();
        const joined = [];
        const bot = spawnBotPeer({
            hub, room: 'rm', wrtc: makeFakeWrtc(),
            onPeerJoin: (id) => joined.push(id),
        });
        await bot.ready;

        // Now a second "browser" peer joins -> bot should observe peer-joined.
        const t2 = new MockTransport();
        hub.attach(t2);
        t2.inject({ type: 'join', room: 'rm' });
        await new Promise((r) => setImmediate(r));

        expect(joined.length).toBe(1);
        bot.close();
        hub.close();
    });

    it('invokes onPeerLeave when a remote peer disconnects', async () =>
    {
        const hub = new SignalingHub();
        // Pre-attach a browser peer first
        const t2 = new MockTransport();
        const browser = hub.attach(t2);
        t2.inject({ type: 'join', room: 'rm' });

        const left = [];
        const bot = spawnBotPeer({
            hub, room: 'rm', wrtc: makeFakeWrtc(),
            onPeerLeave: (id) => left.push(id),
        });
        await bot.ready;
        await new Promise((r) => setImmediate(r));

        browser.close(1000, 'gone');
        await new Promise((r) => setImmediate(r));
        expect(left.length).toBe(1);
        bot.close();
        hub.close();
    });

    it('onPeerJoin/onPeerLeave errors are routed through onError without crashing', async () =>
    {
        const hub = new SignalingHub();
        const errors = [];
        const bot = spawnBotPeer({
            hub, room: 'rm', wrtc: makeFakeWrtc(),
            onPeerJoin: () => { throw new Error('join handler boom'); },
            onPeerLeave: () => { throw new Error('leave handler boom'); },
            onError: (e) => errors.push(e),
        });
        await bot.ready;

        const t2 = new MockTransport();
        const browser = hub.attach(t2);
        t2.inject({ type: 'join', room: 'rm' });
        await new Promise((r) => setImmediate(r));
        browser.close(1000, 'gone');
        await new Promise((r) => setImmediate(r));

        expect(errors.length).toBeGreaterThanOrEqual(1);
        bot.close();
        hub.close();
    });

    it('close() iterates active pcs and tears them down', async () =>
    {
        const hub = new SignalingHub();
        // Pre-attach two browsers so that on bot.ready, the bot opens two PCs.
        const t1 = new MockTransport();
        hub.attach(t1); t1.inject({ type: 'join', room: 'rm' });
        const t2 = new MockTransport();
        hub.attach(t2); t2.inject({ type: 'join', room: 'rm' });

        const bot = spawnBotPeer({ hub, room: 'rm', wrtc: makeFakeWrtc() });
        await bot.ready;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(bot.peerConnections.size).toBeGreaterThan(0);
        bot.close();
        bot.close(); // idempotent
        hub.close();
    });
});

// =============================================================================
// cluster — region-aware-least-loaded comparator branches
// =============================================================================

describe('cluster region-aware-least-loaded selector', () =>
{
    it('breaks ties by load when both nodes are in the preferred region', () =>
    {
        const bus = new cluster.MemoryClusterAdapter();
        const hub = new SignalingHub();
        cluster.useCluster(hub, bus, { nodeId: 'self', region: 'us-east' });
        const dir = hub._cluster;
        dir._touchNode('a', { region: 'us-east', load: { cpu: 0.9 } });
        dir._touchNode('b', { region: 'us-east', load: { cpu: 0.1 } });
        dir._touchNode('c', { region: 'us-west', load: { cpu: 0.0 } });
        const pick = dir.selectBridge();
        expect(['self', 'b']).toContain(pick); // self has no load; b is least-loaded same region
        hub.close();
    });

    it('least-loaded strategy ignores region', () =>
    {
        const bus = new cluster.MemoryClusterAdapter();
        const hub = new SignalingHub();
        cluster.useCluster(hub, bus, { nodeId: 'self', region: 'us-east' });
        const dir = hub._cluster;
        dir._touchNode('lonely', { region: 'eu', load: { cpu: 0.05 } });
        dir._touchNode('busy',   { region: 'us-east', load: { cpu: 0.95 } });
        expect(dir.selectBridge({ strategy: 'least-loaded' })).toBe('lonely');
        hub.close();
    });

    it('local-only strategy short-circuits to self', () =>
    {
        const bus = new cluster.MemoryClusterAdapter();
        const hub = new SignalingHub();
        cluster.useCluster(hub, bus, { nodeId: 'self' });
        const dir = hub._cluster;
        dir._touchNode('a', { load: { cpu: 0 } });
        expect(dir.selectBridge({ strategy: 'local-only' })).toBe('self');
        hub.close();
    });

    it('custom compare overrides the strategy', () =>
    {
        const bus = new cluster.MemoryClusterAdapter();
        const hub = new SignalingHub();
        cluster.useCluster(hub, bus, { nodeId: 'self' });
        const dir = hub._cluster;
        dir._touchNode('self', { load: { cpu: 0.5 } });
        dir._touchNode('a', { load: { cpu: 0.1 } });
        dir._touchNode('b', { load: { cpu: 0.9 } });
        const pick = dir.selectBridge({
            compare: (x, y) => ((y.load && y.load.cpu) || 0) - ((x.load && x.load.cpu) || 0),
        });
        expect(pick).toBe('b');
        hub.close();
    });
});

// =============================================================================
// sfu/index — loadSfuAdapter loader paths
// =============================================================================

describe('loadSfuAdapter loader branches', () =>
{
    it('returns the spec as-is when it already implements createRouter', () =>
    {
        const stub = { createRouter: () => {} };
        expect(loadSfuAdapter(stub)).toBe(stub);
    });

    it('throws WEBRTC_SFU_INVALID_SPEC for non-string non-adapter', () =>
    {
        expect(() => loadSfuAdapter(42)).toThrow(/INVALID_SPEC|adapter instance or a name/);
        expect(() => loadSfuAdapter('')).toThrow(/INVALID_SPEC|adapter instance or a name/);
    });

    it('throws WEBRTC_SFU_NOT_INSTALLED for an external package that does not exist', () =>
    {
        expect(() => loadSfuAdapter('@nonexistent/zero-sfu-fake-xyz-123'))
            .toThrow(/not installed|NOT_INSTALLED/);
    });

    it('routes the built-in mediasoup name through _tryRequireAdapter', () =>
    {
        // The adapter constructor will throw because mediasoup peerDep is absent;
        // we don't care which specific code it returns, only that the loader
        // dispatch path executed.
        expect(() => loadSfuAdapter('mediasoup')).toThrow();
    });

    it('routes the built-in livekit name through _tryRequireAdapter', () =>
    {
        expect(() => loadSfuAdapter('livekit')).toThrow();
    });
});

// =============================================================================
// MemorySfuAdapter — pipeToRouter error branches + stats success
// =============================================================================

describe('MemorySfuAdapter pipeToRouter error branches', () =>
{
    it('throws when producerId is unknown', async () =>
    {
        const sfu = new MemorySfuAdapter();
        await expect(sfu.pipeToRouter({ producerId: 'nope', localRouterId: 'x', remoteRouter: { id: 'r2' } }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
    });

    it('throws when localRouterId is unknown', async () =>
    {
        const sfu = new MemorySfuAdapter();
        const r = await sfu.createRouter();
        const tp = await sfu.createTransport(r, { id: 'p' });
        const prod = await sfu.produce(tp, 'audio', { codecs: [] });
        await expect(sfu.pipeToRouter({ producerId: prod.producerId, localRouterId: 'nope', remoteRouter: { id: 'r2' } }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_ROUTER' });
    });

    it('throws WEBRTC_SFU_INVALID_PIPE when remoteRouter is missing or empty', async () =>
    {
        const sfu = new MemorySfuAdapter();
        const r = await sfu.createRouter();
        const tp = await sfu.createTransport(r, { id: 'p' });
        const prod = await sfu.produce(tp, 'audio', { codecs: [] });
        await expect(sfu.pipeToRouter({ producerId: prod.producerId, localRouterId: r.id }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_PIPE' });
        await expect(sfu.pipeToRouter({ producerId: prod.producerId, localRouterId: r.id, remoteRouter: {} }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_PIPE' });
    });

    it('returns producer/consumer/transport stats on the happy path', async () =>
    {
        const sfu = new MemorySfuAdapter();
        const r = await sfu.createRouter();
        const tp = await sfu.createTransport(r, { id: 'p' });
        const prod = await sfu.produce(tp, 'audio', { codecs: [] });
        const cons = await sfu.consume(tp, prod.producerId, {});
        const pStats = await sfu.getProducerStats(prod.producerId);
        expect(pStats[0]).toMatchObject({ type: 'inbound-rtp', producerId: prod.producerId, kind: 'audio' });
        const cStats = await sfu.getConsumerStats(cons.id);
        expect(cStats[0]).toMatchObject({ type: 'outbound-rtp', consumerId: cons.id });
        const tStats = await sfu.getTransportStats(tp.id);
        expect(tStats[0]).toMatchObject({ type: 'transport', transportId: tp.id, routerId: r.id });
    });
});

// =============================================================================
// LiveKitSfuAdapter — error-path branches that the existing tests miss
// =============================================================================

describe('LiveKitSfuAdapter error-path branches', () =>
{
    function makeAdapter()
    {
        const livekitStub = {
            AccessToken: class { constructor() {} addGrant() {} toJwt() { return 'jwt'; } },
            RoomServiceClient: class {},
        };
        return new LiveKitSfuAdapter({
            url: 'wss://example', apiKey: 'k', apiSecret: 's',
            livekit: livekitStub,
            client: {
                createRoom:       async (opts) => ({ name: opts.name, sid: 'sid-' + opts.name }),
                deleteRoom:       async () => undefined,
                listRooms:        async () => [],
                listParticipants: async () => [],
            },
        });
    }

    it('observeActiveSpeaker throws for an unknown router', async () =>
    {
        const adapter = makeAdapter();
        await expect(adapter.observeActiveSpeaker('nope', {})).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_ROUTER' });
    });

    it('getConsumerStats throws WEBRTC_SFU_NO_CONSUMER for unknown id', async () =>
    {
        const adapter = makeAdapter();
        await expect(adapter.getConsumerStats('nope')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_CONSUMER' });
    });

    it('getTransportStats throws WEBRTC_SFU_NO_TRANSPORT for unknown id', async () =>
    {
        const adapter = makeAdapter();
        await expect(adapter.getTransportStats('nope')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
    });

    it('enableTraceEvent throws for an unknown router', async () =>
    {
        const adapter = makeAdapter();
        await expect(adapter.enableTraceEvent('nope', ['ice'])).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_ROUTER' });
    });
});

// =============================================================================
// cli — default deps (no `deps` arg)
// =============================================================================

describe('runWebRTCCommand default deps fallback', () =>
{
    it('falls back to console.log / process.exitCode when deps is omitted', async () =>
    {
        const origLog = console.log;
        const origErr = console.error;
        const origExit = process.exitCode;
        const lines = [];
        console.log   = (s) => lines.push(['out', String(s)]);
        console.error = (s) => lines.push(['err', String(s)]);
        try
        {
            // Help path -> defaults to console.log
            const helpCode = await runWebRTCCommand('help');
            expect(helpCode).toBe(0);
            expect(lines.some(([k, s]) => k === 'out' && s.includes('webrtc:stun'))).toBe(true);

            // Unknown path -> defaults err + sets process.exitCode
            process.exitCode = 0;
            const code = await runWebRTCCommand('zzz');
            expect(code).toBe(1);
            expect(process.exitCode).toBe(1);
            expect(lines.some(([k, s]) => k === 'err' && s.includes('Unknown webrtc subcommand'))).toBe(true);
        }
        finally
        {
            console.log = origLog;
            console.error = origErr;
            process.exitCode = origExit;
        }
    });
});

// =============================================================================
// turn/codec — small utility branches
// =============================================================================

describe('turn/codec helpers', () =>
{
    it('encode/decode ERROR-CODE round-trip', () =>
    {
        const buf = codec.encodeErrorCode(441, 'Wrong Credentials');
        const out = codec.decodeErrorCode(buf);
        expect(out.code).toBe(441);
        expect(out.reason).toBe('Wrong Credentials');
    });

    it('decodeErrorCode rejects short buffers', () =>
    {
        expect(() => codec.decodeErrorCode(Buffer.alloc(2))).toThrow(/too short/);
        expect(() => codec.decodeErrorCode(null)).toThrow(/too short/);
    });

    it('encode/decode UInt32 round-trip', () =>
    {
        const b = codec.encodeUInt32(0xCAFEBABE);
        expect(codec.decodeUInt32(b)).toBe(0xCAFEBABE);
        expect(() => codec.decodeUInt32(Buffer.alloc(1))).toThrow(/too short/);
    });

    it('encode/decode CHANNEL-NUMBER round-trip', () =>
    {
        const b = codec.encodeChannelNumber(0x4001);
        expect(codec.decodeChannelNumber(b)).toBe(0x4001);
        expect(() => codec.decodeChannelNumber(Buffer.alloc(1))).toThrow(/too short/);
    });

    it('decodeChannelData rejects non-channel frames and truncated payloads', () =>
    {
        // High bits zero => not channel data
        const stunish = Buffer.alloc(20); stunish.writeUInt16BE(0x0001, 0);
        expect(codec.decodeChannelData(stunish)).toBeNull();
        expect(codec.decodeChannelData(Buffer.alloc(3))).toBeNull();
        expect(codec.decodeChannelData(null)).toBeNull();
        // Length larger than buffer
        const cd = Buffer.alloc(8);
        cd.writeUInt16BE(0x4002, 0);
        cd.writeUInt16BE(100, 2);   // claim 100 bytes of payload in 4 byte buffer
        expect(codec.decodeChannelData(cd)).toBeNull();
    });

    it('looksLikeChannelData differentiates STUN from ChannelData', () =>
    {
        const stun = Buffer.alloc(4); stun.writeUInt16BE(0x0001, 0);
        expect(codec.looksLikeChannelData(stun)).toBe(false);
        const cd = Buffer.alloc(4); cd.writeUInt16BE(0x4001, 0);
        expect(codec.looksLikeChannelData(cd)).toBe(true);
        expect(codec.looksLikeChannelData(null)).toBe(false);
    });
});

// =============================================================================
// turn/server — _sweep and _chargeBytes branches
// =============================================================================

describe('TurnServer internal sweep + quota branches', () =>
{
    it('_chargeBytes returns true when no cap is configured', () =>
    {
        const srv = new TurnServer({ secret: 's', listeners: [{ proto: 'udp', port: 0 }] });
        // Infinite cap by default
        expect(srv._chargeBytes('u1', 1000)).toBe(true);
        expect(srv._chargeBytes('u1', 1000)).toBe(true);
    });

    it('_chargeBytes enforces a finite per-minute cap and resets after the window', () =>
    {
        const srv = new TurnServer({
            secret: 's',
            listeners: [{ proto: 'udp', port: 0 }],
            quotas: { maxBytesPerMinute: 1024 },
        });
        expect(srv._chargeBytes('u1', 512)).toBe(true);
        expect(srv._chargeBytes('u1', 512)).toBe(true);
        expect(srv._chargeBytes('u1', 1)).toBe(false);
        // Force a window reset
        const q = srv._userBytes.get('u1');
        q.windowStart = Date.now() - 70_000;
        expect(srv._chargeBytes('u1', 512)).toBe(true);
    });

    it('_sweep deletes expired allocations, permissions, channels, and nonces', () =>
    {
        const srv = new TurnServer({ secret: 's', listeners: [{ proto: 'udp', port: 0 }] });
        const now = Date.now();
        const past = now - 1000;

        // Expired allocation
        const dgram = require('node:dgram');
        const relay = dgram.createSocket('udp4');
        const alloc = {
            userId:      'alice',
            sock:        { send: () => {} },
            rinfo:       { address: '127.0.0.1', port: 12345 },
            relay,
            permissions: new Map([['1.2.3.4', past], ['5.6.7.8', now + 60_000]]),
            channels:    new Map([
                [0x4001, { peerIp: '1.2.3.4', peerPort: 1000, expiresAt: past }],
                [0x4002, { peerIp: '5.6.7.8', peerPort: 2000, expiresAt: now + 60_000 }],
            ]),
            channelByPeer: new Map([
                ['1.2.3.4:1000', 0x4001],
                ['5.6.7.8:2000', 0x4002],
            ]),
            expiresAt: past,
        };
        srv._allocations.set('127.0.0.1:1', alloc);
        srv._userAllocs.set('alice', new Set(['127.0.0.1:1']));

        // Live allocation with one expired permission + channel
        const relay2 = dgram.createSocket('udp4');
        const alive = {
            userId:      'bob',
            sock:        { send: () => {} },
            rinfo:       { address: '127.0.0.1', port: 12346 },
            relay:       relay2,
            permissions: new Map([['9.9.9.9', past]]),
            channels:    new Map([[0x4010, { peerIp: '9.9.9.9', peerPort: 99, expiresAt: past }]]),
            channelByPeer: new Map([['9.9.9.9:99', 0x4010]]),
            expiresAt: now + 60_000,
        };
        srv._allocations.set('127.0.0.1:2', alive);

        // Expired nonce
        srv._nonces.set('n1', { value: 'old', expiresAt: past });
        srv._nonces.set('n2', { value: 'fresh', expiresAt: now + 60_000 });

        const events = [];
        srv.on('deallocation', (e) => events.push(e));

        srv._sweep();

        expect(srv._allocations.has('127.0.0.1:1')).toBe(false);
        expect(srv._userAllocs.has('alice')).toBe(false);
        expect(events.length).toBe(1);
        expect(events[0].reason).toBe('expired');

        expect(alive.permissions.has('9.9.9.9')).toBe(false);
        expect(alive.channels.has(0x4010)).toBe(false);
        expect(srv._nonces.has('n1')).toBe(false);
        expect(srv._nonces.has('n2')).toBe(true);

        try { relay.close();  } catch (_) { /* already closed by _sweep */ }
        try { relay2.close(); } catch (_) { /* not started */ }
    });
});
