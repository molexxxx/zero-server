/**
 * Branch-coverage filler tests for small webrtc modules.
 * Targets: e2ee, peer, mcu/index, cluster, observe, room, joinToken, sdp, stun, mcu/index.
 */
'use strict';

const { EventEmitter } = require('node:events');

const { SignalingHub } = require('../../lib/webrtc/signaling');
const { Peer }         = require('../../lib/webrtc/peer');
const { Room }         = require('../../lib/webrtc/room');
const e2ee             = require('../../lib/webrtc/e2ee');
const { MemoryMcuAdapter } = require('../../lib/webrtc/mcu');
const cluster          = require('../../lib/webrtc/cluster');
const { bindObservability } = require('../../lib/webrtc/observe');
const { signJoinToken, verifyJoinToken } = require('../../lib/webrtc/joinToken');
const sdp              = require('../../lib/webrtc/sdp');
const { stunBinding }  = require('../../lib/webrtc/stun');
const dgram            = require('node:dgram');

class T extends EventEmitter
{
    constructor() { super(); this.outbox = []; this.closed = false; }
    send(s)    { if (!this.closed) this.outbox.push(s); }
    close(c, r){ if (this.closed) return; this.closed = true; this.emit('close', c, r); }
    inject(o)  { this.emit('message', typeof o === 'string' ? o : JSON.stringify(o)); }
}

// =====================================================================
// e2ee branches
// =====================================================================

describe('e2ee.openSealedKey branches', () =>
{
    it('rejects an envelope with the wrong version byte', () =>
    {
        const kp = e2ee.generateE2eeKeyPair();
        const sealed = e2ee.sealKey(Buffer.from('hello'), kp.publicKey);
        const bad = Buffer.from(sealed);
        bad[0] = 0x7e; // intentionally not ENVELOPE_VERSION
        expect(() => e2ee.openSealedKey(bad, kp.privateKey))
            .toThrow(/unsupported envelope version/i);
    });

    it('opens an envelope when the private key arrives as raw pkcs8 DER buffer', () =>
    {
        const kp = e2ee.generateE2eeKeyPair();
        // export raw pkcs8 DER and round-trip through openSealedKey
        const der = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
        const sealed = e2ee.sealKey(Buffer.from('a-secret'), kp.publicKey);
        const opened = e2ee.openSealedKey(sealed, der);
        expect(opened.toString('utf8')).toBe('a-secret');
    });
});

// =====================================================================
// peer.send / peer.close
// =====================================================================

describe('Peer send/close happy paths', () =>
{
    it('send writes a JSON frame through the transport', () =>
    {
        const hub = new SignalingHub();
        const t = new T();
        const peer = hub.attach(t);
        t.outbox.length = 0;
        peer.send('ping', { x: 1 });
        const last = JSON.parse(t.outbox[t.outbox.length - 1]);
        expect(last).toEqual({ type: 'ping', x: 1 });
        hub.close();
    });

    it('close marks peer closed and calls transport.close once', () =>
    {
        const hub = new SignalingHub();
        const t = new T();
        const peer = hub.attach(t);
        const spy = [];
        const origClose = t.close.bind(t);
        t.close = (c, r) => { spy.push([c, r]); origClose(c, r); };
        peer.close(1000, 'bye');
        peer.close(1000, 'bye'); // second call must no-op
        expect(spy.length).toBe(1);
        hub.close();
    });

    it('send is a no-op after close', () =>
    {
        const hub = new SignalingHub();
        const t = new T();
        const peer = hub.attach(t);
        peer.close();
        t.outbox.length = 0;
        peer.send('after-close');
        expect(t.outbox).toHaveLength(0);
        hub.close();
    });

    it('send swallows transport errors silently', () =>
    {
        const hub = new SignalingHub();
        const t = new T();
        const peer = hub.attach(t);
        t.send = () => { throw new Error('socket gone'); };
        expect(() => peer.send('hi')).not.toThrow();
        hub.close();
    });
});

// =====================================================================
// Room constructor + fluent
// =====================================================================

describe('Room construction and fluent setters', () =>
{
    it('throws SignalingError for empty/non-string names', () =>
    {
        expect(() => new Room('')).toThrow(/non-empty string/);
        expect(() => new Room(null)).toThrow(/non-empty string/);
        expect(() => new Room(42)).toThrow(/non-empty string/);
    });

    it('initializes empty membership and gates', () =>
    {
        const r = new Room('foo');
        expect(r.name).toBe('foo');
        expect(r.size).toBe(0);
        expect(r.isOpen).toBe(false);
        expect(r.topology).toBe('mesh');
    });

    it('canPublish() and canSubscribe() return this for chaining', () =>
    {
        const r = new Room('foo');
        const f1 = () => true, f2 = () => true;
        const chained = r.canPublish(f1).canSubscribe(f2).open();
        expect(chained).toBe(r);
        expect(r._canPublish).toBe(f1);
        expect(r._canSubscribe).toBe(f2);
        expect(r.isOpen).toBe(true);
    });

    it('require() rejects non-function', () =>
    {
        const r = new Room('foo');
        expect(() => r.require('nope')).toThrow(/function/);
    });

    it('require() gates can throw and are treated as false', () =>
    {
        const r = new Room('foo');
        r.require(() => { throw new Error('boom'); });
        expect(r.canJoin({})).toBe(false);
    });

    it('setTopology throws on invalid value', () =>
    {
        const r = new Room('foo');
        expect(() => r.setTopology('peer-to-peer')).toThrow(/mesh\|sfu\|mcu/);
    });

    it('setTopology is a no-op when unchanged and returns this', () =>
    {
        const r = new Room('foo');
        expect(r.setTopology('mesh')).toBe(r);
    });
});

// =====================================================================
// MCU controller — setLayout + mix branches
// =====================================================================

describe('MemoryMcuAdapter branches', () =>
{
    it('mix() stores a mix and unmix() returns true/false correctly', async () =>
    {
        const mcu = new MemoryMcuAdapter();
        const m = await mcu.mix('room-1', { kind: 'audio', producerIds: ['p1', 'p2'] });
        expect(m.layout).toBe('audio-only');
        expect(m.kind).toBe('audio');
        expect(m.sources.sort()).toEqual(['p1', 'p2']);
        expect(await mcu.unmix(m.mixedProducerId)).toBe(true);
        expect(await mcu.unmix(m.mixedProducerId)).toBe(false);
    });

    it('mix() defaults to grid layout for non-audio kinds', async () =>
    {
        const mcu = new MemoryMcuAdapter();
        const m = await mcu.mix('rm', { kind: 'video' });
        expect(m.layout).toBe('grid');
    });

    it('setLayout() accepts a string layout', async () =>
    {
        const mcu = new MemoryMcuAdapter();
        const m = await mcu.mix('rm');
        const out = await mcu.setLayout(m.mixedProducerId, 'speaker-focus');
        expect(out).toBe('speaker-focus');
    });

    it('setLayout() accepts an object with .name', async () =>
    {
        const mcu = new MemoryMcuAdapter();
        const m = await mcu.mix('rm');
        const out = await mcu.setLayout(m.mixedProducerId, { name: 'pip' });
        expect(out).toBe('pip');
    });
});

// =====================================================================
// cluster — region-aware strategy + load probe branches
// =====================================================================

describe('cluster directory branches', () =>
{
    it('selectBridge with region-aware strategy prefers preferred region', async () =>
    {
        const bus = new cluster.MemoryClusterAdapter();
        const hub = new SignalingHub();
        cluster.useCluster(hub, bus, { nodeId: 'n1', region: 'us-west' });
        const dir = hub._cluster;

        dir._touchNode('n2', { region: 'us-west', load: { cpu: 0.9 } });
        dir._touchNode('n3', { region: 'us-east', load: { cpu: 0.1 } });

        const pick = dir.selectBridge({ strategy: 'region-aware', preferRegion: 'us-east' });
        expect(pick).toBe('n3');
        hub.close();
    });

    it('publishLoad with a probe broadcasts a load update and starts the periodic timer', async () =>
    {
        const bus = new cluster.MemoryClusterAdapter();
        const hub = new SignalingHub();
        const loadProbe = () => ({ cpu: 0.42, producers: 1 });
        cluster.useCluster(hub, bus, {
            nodeId: 'pr',
            loadProbe,
            loadIntervalMs: 60_000,  // long enough not to fire during the test
        });
        // The _wire() path should have created an unref'd timer
        expect(hub._cluster._loadTimer).toBeTruthy();
        const snap = await hub._cluster.publishLoad();
        expect(snap.cpu).toBe(0.42);
        hub.close();
    });
});

// =====================================================================
// joinToken branches
// =====================================================================

describe('joinToken branches', () =>
{
    const SECRET = 'jt-secret';

    it('throws when user is provided but no extractable id', () =>
    {
        expect(() => signJoinToken({ secret: SECRET, user: {}, room: 'lobby' }))
            .toThrow(/user\.id is required/);
    });

    it('verifyJoinToken honors opts.audience override', () =>
    {
        const tok = signJoinToken({ secret: SECRET, user: 'u1', room: 'rm', audience: 'custom-aud' });
        const p = verifyJoinToken(tok, { secret: SECRET, audience: 'custom-aud' });
        expect(p.aud).toBe('custom-aud');
    });

    it('verifyJoinToken accepts a custom clockTolerance', () =>
    {
        const tok = signJoinToken({ secret: SECRET, user: 'u1', room: 'rm' });
        const p = verifyJoinToken(tok, { secret: SECRET, room: 'rm', clockTolerance: 5 });
        expect(p.user.id).toBe('u1');
    });

    it('verifyJoinToken rejects payload whose room claim does not match', () =>
    {
        // Force a token whose `aud` is room:roomB but whose `room` claim is roomA.
        const tok = signJoinToken({ secret: SECRET, user: 'u1', room: 'roomA', audience: 'room:roomB' });
        expect(() => verifyJoinToken(tok, { secret: SECRET, room: 'roomB' }))
            .toThrow(/room claim mismatch/);
    });

    it('verifyJoinToken honors opts.algorithms', () =>
    {
        const tok = signJoinToken({ secret: SECRET, user: 'u1', room: 'rm' });
        const p = verifyJoinToken(tok, { secret: SECRET, room: 'rm', algorithms: ['HS256'] });
        expect(p.user.id).toBe('u1');
    });
});

// =====================================================================
// sdp — attribute parser branches
// =====================================================================

describe('sdp parser/serializer branches', () =>
{
    it('stringifySdp emits c=, t=, and bare a= lines', () =>
    {
        const session = {
            version: 0,
            origin: { username: '-', sessionId: '1', sessionVersion: '2', netType: 'IN', addrType: 'IP4', address: '127.0.0.1' },
            sessionName: '-',
            connection: { netType: 'IN', addrType: 'IP4', address: '127.0.0.1' },
            timing: [{ start: 0, stop: 0 }],
            attributes: [
                { key: 'group', value: 'BUNDLE 0' },
                { key: 'sendrecv', value: '' },
            ],
            media: [],
        };
        const txt = sdp.stringifySdp(session);
        expect(txt).toMatch(/c=IN IP4 127\.0\.0\.1/);
        expect(txt).toMatch(/t=0 0/);
        expect(txt).toMatch(/a=group:BUNDLE 0/);
        expect(txt).toMatch(/a=sendrecv\b/);
    });

    it('parseSdp handles fmtp, rid, simulcast, extmap, ssrc on a media line', () =>
    {
        const text = [
            'v=0',
            'o=- 1 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            'm=video 9 UDP/TLS/RTP/SAVPF 96',
            'a=rtpmap:96 VP8/90000',
            'a=fmtp:96 max-fs=12288;max-fr=30',
            'a=rid:0 send max-width=1280',
            'a=simulcast:send 0;1 recv 2',
            'a=extmap:1/sendonly urn:ietf:params:rtp-hdrext:toffset extra-cfg',
            'a=ssrc:11223344 cname:hello',
            'a=ssrc:11223344 msid',
            '',
        ].join('\r\n');
        const out = sdp.parseSdp(text);
        const m = out.media[0];
        expect(m.fmtps[0]).toEqual({ payload: 96, config: 'max-fs=12288;max-fr=30' });
        expect(m.rids[0].id).toBe('0');
        expect(m.simulcast.send).toBe('0;1');
        expect(m.simulcast.recv).toBe('2');
        expect(m.extmaps[0]).toMatchObject({ id: 1, direction: 'sendonly', uri: 'urn:ietf:params:rtp-hdrext:toffset' });
        expect(m.ssrcs.find(s => s.attribute === 'cname').value).toBe('hello');
        expect(m.ssrcs.find(s => s.attribute === 'msid').value).toBe('');
    });

    it('parseSdp m= line with port count "9/2" populates numPorts', () =>
    {
        const text = [
            'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
            'm=audio 9/2 UDP/TLS/RTP/SAVPF 111',
            '',
        ].join('\r\n');
        const out = sdp.parseSdp(text);
        expect(out.media[0].port).toBe(9);
        expect(out.media[0].numPorts).toBe(2);
    });
});

// =====================================================================
// stun — XOR vs MAPPED-ADDRESS and decode error paths
// =====================================================================

describe('stunBinding response paths', () =>
{
    /** Build a STUN Binding Success response containing an XOR-MAPPED-ADDRESS IPv4 attr. */
    function buildXorResp(txid, port, ip)
    {
        const MAGIC = 0x2112A442;
        const attrType = 0x0020; // XOR-MAPPED-ADDRESS
        const xport = port ^ (MAGIC >>> 16);
        const ipParts = ip.split('.').map(Number);
        const addrBuf = Buffer.alloc(4);
        for (let i = 0; i < 4; i++)
            addrBuf[i] = ipParts[i] ^ ((MAGIC >>> (24 - i * 8)) & 0xff);

        const attrVal = Buffer.alloc(8);
        attrVal.writeUInt8(0, 0);
        attrVal.writeUInt8(0x01, 1);
        attrVal.writeUInt16BE(xport & 0xffff, 2);
        addrBuf.copy(attrVal, 4);

        const hdr = Buffer.alloc(20);
        hdr.writeUInt16BE(0x0101, 0); // BINDING SUCCESS
        hdr.writeUInt16BE(8 + 4, 2);  // attr length (4 attr-hdr + 8 val)
        hdr.writeUInt32BE(MAGIC, 4);
        txid.copy(hdr, 8);
        const attrHdr = Buffer.alloc(4);
        attrHdr.writeUInt16BE(attrType, 0);
        attrHdr.writeUInt16BE(attrVal.length, 2);
        return Buffer.concat([hdr, attrHdr, attrVal]);
    }

    function buildMappedResp(txid, port, ip)
    {
        const attrType = 0x0001; // MAPPED-ADDRESS
        const ipParts = ip.split('.').map(Number);
        const addrBuf = Buffer.from(ipParts);
        const attrVal = Buffer.alloc(8);
        attrVal.writeUInt8(0, 0);
        attrVal.writeUInt8(0x01, 1);
        attrVal.writeUInt16BE(port, 2);
        addrBuf.copy(attrVal, 4);

        const hdr = Buffer.alloc(20);
        hdr.writeUInt16BE(0x0101, 0);
        hdr.writeUInt16BE(8 + 4, 2);
        hdr.writeUInt32BE(0x2112A442, 4);
        txid.copy(hdr, 8);
        const attrHdr = Buffer.alloc(4);
        attrHdr.writeUInt16BE(attrType, 0);
        attrHdr.writeUInt16BE(attrVal.length, 2);
        return Buffer.concat([hdr, attrHdr, attrVal]);
    }

    function runFakeServer(buildAttr)
    {
        return new Promise((resolve, reject) =>
        {
            const s = dgram.createSocket('udp4');
            s.once('error', reject);
            s.on('message', (msg, rinfo) =>
            {
                const txid = msg.subarray(8, 20);
                const reply = buildAttr(txid);
                s.send(reply, rinfo.port, rinfo.address);
            });
            s.bind(0, '127.0.0.1', () => resolve(s));
        });
    }

    it('resolves with XOR-MAPPED-ADDRESS result', async () =>
    {
        const s = await runFakeServer((txid) => buildXorResp(txid, 54321, '203.0.113.7'));
        const { port } = s.address();
        const r = await stunBinding({ host: '127.0.0.1', port, timeoutMs: 500, retries: 1 });
        expect(r.address).toBe('203.0.113.7');
        expect(r.port).toBe(54321);
        s.close();
    });

    it('falls back to MAPPED-ADDRESS when XOR is absent', async () =>
    {
        const s = await runFakeServer((txid) => buildMappedResp(txid, 33333, '198.51.100.9'));
        const { port } = s.address();
        const r = await stunBinding({ host: '127.0.0.1', port, timeoutMs: 500, retries: 1 });
        expect(r.address).toBe('198.51.100.9');
        expect(r.port).toBe(33333);
        s.close();
    });
});

// =====================================================================
// observe — promotion / failure / ice-restart spans + metrics
// =====================================================================

describe('observe bindObservability extra branches', () =>
{
    function makeMetricsAdapter()
    {
        const counters = new Map();
        const gauges = new Map();
        const histograms = new Map();
        const create = (kind, defaults) => ({ name, help, labels, buckets }) =>
        {
            const m = {
                kind, name,
                inc: (lbls, n = 1) =>
                {
                    const k = JSON.stringify(lbls || {});
                    const map = kind === 'counter' ? counters : gauges;
                    map.set(name + ':' + k, (map.get(name + ':' + k) || 0) + n);
                },
                set: (lbls, v) =>
                {
                    const k = JSON.stringify(lbls || {});
                    gauges.set(name + ':' + k, v);
                },
                observe: (lbls, v) =>
                {
                    const k = JSON.stringify(lbls || {});
                    histograms.set(name + ':' + k, v);
                },
            };
            return m;
        };
        return {
            _counters: counters, _gauges: gauges, _histograms: histograms,
            counter:   create('counter'),
            gauge:     create('gauge'),
            histogram: create('histogram'),
        };
    }

    function makeTracer()
    {
        const spans = [];
        return {
            spans,
            startSpan(name, attrs)
            {
                const span = {
                    name, attrs,
                    setOk:    () => { span.ok = true; },
                    setError: (e) => { span.err = e; },
                    end:      () => { spans.push(span); },
                };
                return span;
            },
        };
    }

    it('topology promotion increments counter and zeroes the mesh gauge', () =>
    {
        const hub = new SignalingHub();
        const m = makeMetricsAdapter();
        bindObservability(hub, { metrics: m });
        const room = hub.room('rm');
        hub.emit('topology:promoted', { room, from: 'mesh', to: 'sfu' });
        const promKeys = [...m._counters.keys()].filter(k => k.startsWith('zs_webrtc_topology_promotions_total'));
        expect(promKeys.length).toBeGreaterThan(0);
        hub.close();
    });

    it('joinFailed + offer + answer + publishFailed + subscribeFailed all emit tracing spans', () =>
    {
        const hub = new SignalingHub();
        const tracer = makeTracer();
        bindObservability(hub, { tracer });
        const fakeRoom = { name: 'rm', size: 1, topology: 'mesh' };

        // a peer-shaped object that has an `id`
        const p1 = { id: 'p1' }, p2 = { id: 'p2' };

        hub.emit('joinFailed', { peer: p1, reason: 'no-token' });
        hub.emit('offer',  { peer: p1, target: p2, sdp: '', room: fakeRoom });
        hub.emit('answer', { peer: p2, target: p1, sdp: '', room: fakeRoom });
        hub.emit('publishFailed',   { peer: p1, reason: 'noperms' });
        hub.emit('subscribeFailed', { peer: p1, reason: 'noperms' });

        const names = tracer.spans.map(s => s.name);
        expect(names).toEqual(expect.arrayContaining([
            'webrtc.join', 'webrtc.publish', 'webrtc.subscribe',
        ]));
        hub.close();
    });

    it('ICE-restart counter ticks when ufrag changes across offers', () =>
    {
        const hub = new SignalingHub();
        const m = makeMetricsAdapter();
        bindObservability(hub, { metrics: m });

        const room = hub.room('rm');
        const sdp1 = [
            'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
            'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdef0123456789',
            'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0',
            '',
        ].join('\r\n');
        const sdp2 = sdp1.replace('abcd', 'wxyz');

        const peer = { id: 'p1' };
        hub.emit('offer', { peer, target: { id: 't' }, sdp: sdp1, room });
        hub.emit('offer', { peer, target: { id: 't' }, sdp: sdp2, room });
        // answering peer should resolve offer duration
        hub.emit('answer', { peer: { id: 't' }, target: peer, sdp: '', room });

        const iceKeys = [...m._counters.keys()].filter(k => k.startsWith('zs_webrtc_ice_restart_total'));
        expect(iceKeys.length).toBeGreaterThan(0);
        hub.close();
    });
});
