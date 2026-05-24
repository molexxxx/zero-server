'use strict';

const { EventEmitter } = require('node:events');
const { SignalingHub, Room, Peer } = require('../../lib/webrtc/signaling');
const { SignalingError, SdpError, IceError } = require('../../lib/errors');

// --- Mock transport ---

/**
 * Minimal in-memory transport that mimics the surface SignalingHub expects
 * of a WebSocket connection: `.send(string)`, `.on('message', cb)`,
 * `.on('close', cb)`, `.close(code?, reason?)`, plus an `.id`/`.ip`.
 * Mirrors `lib/ws/connection.js` enough for the hub but stays sync-friendly.
 */
class MockTransport extends EventEmitter
{
    constructor(meta = {})
    {
        super();
        this.id = meta.id || ('mock_' + Math.random().toString(36).slice(2, 9));
        this.ip = meta.ip || '127.0.0.1';
        this.headers = meta.headers || {};
        this.url = meta.url || '/rtc';
        this.outbox = [];
        this.closed = false;
        this.closeCode = null;
        this.closeReason = null;
    }

    send(data)
    {
        if (this.closed) return;
        this.outbox.push(data);
    }

    close(code, reason)
    {
        if (this.closed) return;
        this.closed = true;
        this.closeCode = code ?? 1000;
        this.closeReason = reason ?? '';
        this.emit('close', this.closeCode, this.closeReason);
    }

    /** Simulate a message arriving from the remote peer. */
    inject(obj)
    {
        const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
        this.emit('message', data);
    }

    /** Last JSON message sent by the server to this transport. */
    lastSent() { return this.outbox.length ? JSON.parse(this.outbox[this.outbox.length - 1]) : null; }

    /** Number of messages of a given type sent to this transport. */
    countSent(type)
    {
        return this.outbox.reduce((n, raw) =>
        {
            try { return JSON.parse(raw).type === type ? n + 1 : n; }
            catch { return n; }
        }, 0);
    }
}

// --- Helpers ---

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
].join('\r\n') + '\r\n';

function attachPeer(hub, meta = {})
{
    const t = new MockTransport(meta);
    const peer = hub.attach(t, { user: meta.user || null, ip: t.ip });
    return { transport: t, peer };
}

// --- SignalingHub ---

describe('SignalingHub', () =>
{
    it('exports SignalingHub, Room, Peer as classes', () =>
    {
        expect(typeof SignalingHub).toBe('function');
        expect(typeof Room).toBe('function');
        expect(typeof Peer).toBe('function');
    });

    it('lazy-creates a room via .room(name) and returns the same instance on repeat calls', () =>
    {
        const hub = new SignalingHub();
        const a = hub.room('lobby');
        const b = hub.room('lobby');
        expect(a).toBe(b);
        expect(a).toBeInstanceOf(Room);
        expect(a.name).toBe('lobby');
        expect(hub.rooms()).toContain(a);
    });

    it('rejects room names that are not non-empty strings', () =>
    {
        const hub = new SignalingHub();
        expect(() => hub.room('')).toThrow(SignalingError);
        expect(() => hub.room(42)).toThrow(SignalingError);
        expect(() => hub.room(null)).toThrow(SignalingError);
    });

    it('attach() returns a Peer with a unique id and tracks it in hub.size', () =>
    {
        const hub = new SignalingHub();
        const { peer: p1 } = attachPeer(hub);
        const { peer: p2 } = attachPeer(hub);
        expect(p1).toBeInstanceOf(Peer);
        expect(p1.id).not.toBe(p2.id);
        expect(hub.size).toBe(2);
    });

    it('removes peer from hub.size when the underlying transport closes', () =>
    {
        const hub = new SignalingHub();
        const { transport } = attachPeer(hub);
        expect(hub.size).toBe(1);
        transport.close(1000, 'bye');
        expect(hub.size).toBe(0);
    });

    it('emits "join" when a peer successfully joins a room', () =>
    {
        const hub = new SignalingHub();
        hub.room('lobby').open();
        const joins = [];
        hub.on('join', ev => joins.push(ev));

        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'lobby' });

        expect(joins).toHaveLength(1);
        expect(joins[0].room.name).toBe('lobby');
        expect(joins[0].peer).toBeInstanceOf(Peer);
    });

    it('emits "leave" when a peer leaves or disconnects', () =>
    {
        const hub = new SignalingHub();
        hub.room('lobby').open();
        const leaves = [];
        hub.on('leave', ev => leaves.push(ev));

        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'lobby' });
        transport.close();

        expect(leaves).toHaveLength(1);
        expect(leaves[0].room.name).toBe('lobby');
    });

    it('sends an error frame and refuses join when the target room does not exist and policy=strict', () =>
    {
        const hub = new SignalingHub({ autoCreateRooms: false });
        const { transport, peer } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'ghost' });
        const last = transport.lastSent();
        expect(last.type).toBe('error');
        expect(last.code).toBe('UNKNOWN_ROOM');
        expect(peer.room).toBeNull();
    });

    it('auto-creates a room on join when autoCreateRooms is true (default)', () =>
    {
        const hub = new SignalingHub();
        const { transport, peer } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'spontaneous' });
        expect(peer.room).not.toBeNull();
        expect(peer.room.name).toBe('spontaneous');
    });

    it('hub.close() shuts every peer down and clears rooms', () =>
    {
        const hub = new SignalingHub();
        const { transport: t1 } = attachPeer(hub);
        const { transport: t2 } = attachPeer(hub);
        t1.inject({ type: 'join', room: 'r' });
        t2.inject({ type: 'join', room: 'r' });
        expect(hub.size).toBe(2);
        hub.close();
        expect(t1.closed).toBe(true);
        expect(t2.closed).toBe(true);
        expect(hub.size).toBe(0);
        expect(hub.rooms()).toHaveLength(0);
    });
});

// --- Room ---

describe('Room', () =>
{
    it('.open() marks the room as public and returns this for chaining', () =>
    {
        const hub = new SignalingHub();
        const room = hub.room('lobby').open();
        expect(room).toBeInstanceOf(Room);
        expect(room.isOpen).toBe(true);
    });

    it('.require(fn) gates join; rejection sends an error frame and prevents membership', () =>
    {
        const hub = new SignalingHub();
        hub.room('vault').require(peer => peer.user && peer.user.role === 'exec');

        const { transport: t1, peer: p1 } = attachPeer(hub, { user: { role: 'guest' } });
        t1.inject({ type: 'join', room: 'vault' });
        expect(p1.room).toBeNull();
        expect(t1.lastSent().code).toBe('FORBIDDEN');

        const { transport: t2, peer: p2 } = attachPeer(hub, { user: { role: 'exec' } });
        t2.inject({ type: 'join', room: 'vault' });
        expect(p2.room && p2.room.name).toBe('vault');
    });

    it('chains multiple .require() gates (all must pass)', () =>
    {
        const hub = new SignalingHub();
        hub.room('strict')
            .require(p => p.user && p.user.role === 'exec')
            .require(p => p.user && p.user.mfa === true);

        const { transport, peer } = attachPeer(hub, { user: { role: 'exec', mfa: false } });
        transport.inject({ type: 'join', room: 'strict' });
        expect(peer.room).toBeNull();
        expect(transport.lastSent().code).toBe('FORBIDDEN');
    });

    it('.broadcast(type, payload) fans out to every other peer in the room', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta } = attachPeer(hub);
        const { transport: tb } = attachPeer(hub);
        const { transport: tc } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });
        tc.inject({ type: 'join', room: 'r' });

        // Reset outboxes after the join handshake noise
        ta.outbox.length = 0; tb.outbox.length = 0; tc.outbox.length = 0;

        hub.room('r').broadcast('announce', { msg: 'hi' });
        expect(ta.countSent('announce')).toBe(1);
        expect(tb.countSent('announce')).toBe(1);
        expect(tc.countSent('announce')).toBe(1);
    });

    it('.broadcast with exceptPeerId skips the excluded peer', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta, peer: pa } = attachPeer(hub);
        const { transport: tb } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });
        ta.outbox.length = 0; tb.outbox.length = 0;

        hub.room('r').broadcast('announce', { msg: 'hi' }, pa.id);
        expect(ta.countSent('announce')).toBe(0);
        expect(tb.countSent('announce')).toBe(1);
    });

    it('.peers() lists current members and .size reflects count; both update on leave', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta } = attachPeer(hub);
        const { transport: tb } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });
        const room = hub.room('r');
        expect(room.size).toBe(2);
        expect(room.peers()).toHaveLength(2);

        tb.close();
        expect(room.size).toBe(1);
    });

    it('.close(reason) kicks every peer and removes the room from the hub', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta } = attachPeer(hub);
        const { transport: tb } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });

        hub.room('r').close('drain');
        expect(ta.closed).toBe(true);
        expect(tb.closed).toBe(true);
        expect(hub.rooms().find(r => r.name === 'r')).toBeUndefined();
    });
});

// --- Peer state machine and relays ---

describe('Peer', () =>
{
    it('starts in the "stable" JSEP state with no room', () =>
    {
        const hub = new SignalingHub();
        const { peer } = attachPeer(hub);
        expect(peer.state).toBe('stable');
        expect(peer.room).toBeNull();
    });

    it('moves to "have-local-offer" after sending an offer, back to "stable" after answer', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta, peer: pa } = attachPeer(hub);
        const { transport: tb, peer: pb } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });

        ta.inject({ type: 'offer', sdp: MIN_SDP, target: pb.id });
        expect(pa.state).toBe('have-local-offer');
        expect(pb.state).toBe('have-remote-offer');

        tb.inject({ type: 'answer', sdp: MIN_SDP, target: pa.id });
        expect(pa.state).toBe('stable');
        expect(pb.state).toBe('stable');
    });

    it('relays offer to a specific target peer in the same room', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta, peer: pa } = attachPeer(hub);
        const { transport: tb, peer: pb } = attachPeer(hub);
        const { transport: tc } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });
        tc.inject({ type: 'join', room: 'r' });
        ta.outbox.length = 0; tb.outbox.length = 0; tc.outbox.length = 0;

        ta.inject({ type: 'offer', sdp: MIN_SDP, target: pb.id });
        expect(tb.countSent('offer')).toBe(1);
        expect(tc.countSent('offer')).toBe(0);
        const relayed = tb.outbox.map(JSON.parse).find(m => m.type === 'offer');
        expect(relayed.from).toBe(pa.id);
        expect(relayed.sdp).toBe(MIN_SDP);
    });

    it('rejects an SDP larger than maxSdpSize with an error frame', () =>
    {
        const hub = new SignalingHub({ maxSdpSize: 256 });
        hub.room('r').open();
        const { transport, peer } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'r' });
        transport.outbox.length = 0;

        const fat = 'x'.repeat(1024);
        transport.inject({ type: 'offer', sdp: fat, target: 'noone' });

        const err = transport.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeTruthy();
        expect(err.code).toBe('SDP_TOO_LARGE');
        expect(peer.state).toBe('stable');
    });

    it('rejects an SDP missing required attrs (no a=fingerprint)', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'r' });
        transport.outbox.length = 0;

        const bad = MIN_SDP.replace(/a=fingerprint:[^\r\n]+\r\n/, '');
        transport.inject({ type: 'offer', sdp: bad, target: 'x' });
        const err = transport.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeTruthy();
        expect(err.code).toBe('INVALID_SDP');
    });

    it('accepts an SCTP data-channel-only offer (m=application UDP/DTLS/SCTP)', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: a, peer: pa } = attachPeer(hub);
        const { transport: b, peer: pb } = attachPeer(hub);
        a.inject({ type: 'join', room: 'r' });
        b.inject({ type: 'join', room: 'r' });
        a.outbox.length = 0;
        b.outbox.length = 0;

        // Real-world Chrome data-channel-only offer: one m=application section
        // using UDP/DTLS/SCTP. Carries iceUfrag/icePwd/fingerprint just like
        // RTP sections - the only difference is the proto.
        const sctp = [
            'v=0',
            'o=- 1 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            'a=group:BUNDLE 0',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
            'c=IN IP4 0.0.0.0',
            'a=ice-ufrag:abcd',
            'a=ice-pwd:0123456789abcdef0123456789',
            'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
            'a=setup:actpass',
            'a=mid:0',
            'a=sctp-port:5000',
            'a=max-message-size:262144',
        ].join('\r\n') + '\r\n';

        a.inject({ type: 'offer', sdp: sctp, target: pb.id });
        const err = a.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeFalsy();
        const relayed = b.outbox.map(JSON.parse).find(m => m.type === 'offer');
        expect(relayed).toBeTruthy();
        expect(relayed.from).toBe(pa.id);
        expect(relayed.sdp).toContain('UDP/DTLS/SCTP');
    });

    it('accepts a mixed BUNDLE offer (audio + data channel) inheriting ice credentials', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: a, peer: pa } = attachPeer(hub);
        const { transport: b, peer: pb } = attachPeer(hub);
        a.inject({ type: 'join', room: 'r' });
        b.inject({ type: 'join', room: 'r' });
        a.outbox.length = 0;
        b.outbox.length = 0;

        // Real-world Chrome mixed offer under max-bundle: audio carries the
        // ice credentials and the SCTP section inherits them per RFC 8843.
        const mixed = [
            'v=0',
            'o=- 1 2 IN IP4 127.0.0.1',
            's=-',
            't=0 0',
            'a=group:BUNDLE 0 1',
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'c=IN IP4 0.0.0.0',
            'a=ice-ufrag:abcd',
            'a=ice-pwd:0123456789abcdef0123456789',
            'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
            'a=setup:actpass',
            'a=mid:0',
            'a=sendrecv',
            'a=rtcp-mux',
            'a=rtpmap:111 opus/48000/2',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
            'c=IN IP4 0.0.0.0',
            'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
            'a=setup:actpass',
            'a=mid:1',
            'a=sctp-port:5000',
        ].join('\r\n') + '\r\n';

        a.inject({ type: 'offer', sdp: mixed, target: pb.id });
        const err = a.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeFalsy();
        const relayed = b.outbox.map(JSON.parse).find(m => m.type === 'offer');
        expect(relayed).toBeTruthy();
        expect(relayed.from).toBe(pa.id);
    });

    it('accepts a Firefox-style offer with session-level a=fingerprint (RFC 8839 §5.4)', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: a, peer: pa } = attachPeer(hub);
        const { transport: b, peer: pb } = attachPeer(hub);
        a.inject({ type: 'join', room: 'r' });
        b.inject({ type: 'join', room: 'r' });
        a.outbox.length = 0;
        b.outbox.length = 0;

        // Firefox emits a=fingerprint only at session level; per RFC 8839 §5.4
        // and RFC 8122 §5 it applies to every media section that omits its own.
        const ff = [
            'v=0',
            'o=mozilla...THIS_IS_SDPARTA-99.0 9217916099293327795 0 IN IP4 0.0.0.0',
            's=-',
            't=0 0',
            'a=sendrecv',
            'a=fingerprint:sha-256 20:30:A4:45:B5:17:FF:CC:7A:EC:9E:F2:15:A0:C8:78:BC:C8:C8:F6:57:E1:B0:6A:6A:3D:9D:D3:7D:92:C6:93',
            'a=group:BUNDLE 0',
            'a=ice-options:trickle',
            'a=msid-semantic:WMS *',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
            'c=IN IP4 0.0.0.0',
            'a=sendrecv',
            'a=ice-pwd:12d8a8eb721d8f776af17848d3c7cd18',
            'a=ice-ufrag:27a3a95f',
            'a=mid:0',
            'a=setup:actpass',
            'a=sctp-port:5000',
            'a=max-message-size:1073741823',
        ].join('\r\n') + '\r\n';

        a.inject({ type: 'offer', sdp: ff, target: pb.id });
        const err = a.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeFalsy();
        const relayed = b.outbox.map(JSON.parse).find(m => m.type === 'offer');
        expect(relayed).toBeTruthy();
        expect(relayed.from).toBe(pa.id);
    });

    it('still rejects an unknown proto (TCP/RTP/AVP)', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'r' });
        transport.outbox.length = 0;

        const bad = MIN_SDP.replace('UDP/TLS/RTP/SAVPF', 'TCP/RTP/AVP');
        transport.inject({ type: 'offer', sdp: bad, target: 'x' });
        const err = transport.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeTruthy();
        expect(err.code).toBe('INVALID_SDP');
    });

    it('rejects an offer with too many candidates', () =>
    {
        const hub = new SignalingHub({ maxCandidatesPerOffer: 2 });
        hub.room('r').open();
        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'r' });
        transport.outbox.length = 0;

        const cand = 'a=candidate:1 1 udp 2113937151 192.0.2.1 12345 typ host';
        const sdpWith = MIN_SDP.trim() + '\r\n' + [cand, cand, cand].join('\r\n') + '\r\n';
        transport.inject({ type: 'offer', sdp: sdpWith, target: 'x' });
        const err = transport.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeTruthy();
        expect(err.code).toBe('TOO_MANY_CANDIDATES');
    });

    it('relays an ICE candidate to the target peer', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta, peer: pa } = attachPeer(hub);
        const { transport: tb, peer: pb } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });
        ta.outbox.length = 0; tb.outbox.length = 0;

        const cand = 'candidate:1 1 udp 2113937151 192.0.2.1 12345 typ host';
        ta.inject({ type: 'ice', candidate: cand, target: pb.id });
        const got = tb.outbox.map(JSON.parse).find(m => m.type === 'ice');
        expect(got).toBeTruthy();
        expect(got.from).toBe(pa.id);
        expect(got.candidate).toBe(cand);
    });

    it('rejects a malformed ICE candidate', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'r' });
        transport.outbox.length = 0;

        transport.inject({ type: 'ice', candidate: 'not a candidate', target: 'x' });
        const err = transport.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeTruthy();
        expect(err.code).toBe('INVALID_ICE');
    });

    it('relays mute/unmute to the room', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport: ta, peer: pa } = attachPeer(hub);
        const { transport: tb } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });
        ta.outbox.length = 0; tb.outbox.length = 0;

        ta.inject({ type: 'mute', kind: 'audio' });
        const got = tb.outbox.map(JSON.parse).find(m => m.type === 'mute');
        expect(got).toBeTruthy();
        expect(got.kind).toBe('audio');
        expect(got.from).toBe(pa.id);
    });

    it('enforces a per-peer message rate limit and closes the offender', () =>
    {
        const hub = new SignalingHub({ peerMessageRate: 3 });
        hub.room('r').open();
        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'r' });

        for (let i = 0; i < 10; i++)
        {
            transport.inject({ type: 'mute', kind: 'audio' });
            if (transport.closed) break;
        }
        expect(transport.closed).toBe(true);
        expect(transport.closeCode).toBe(1008); // policy violation
    });

    it('drops invalid JSON and increments an error counter without throwing', () =>
    {
        const hub = new SignalingHub();
        const { transport, peer } = attachPeer(hub);
        transport.inject('this-is-not-json');
        const err = transport.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeTruthy();
        expect(err.code).toBe('BAD_FRAME');
        expect(peer.errors).toBe(1);
    });

    it('handles a bye message by closing the peer cleanly', () =>
    {
        const hub = new SignalingHub();
        hub.room('r').open();
        const { transport } = attachPeer(hub);
        transport.inject({ type: 'join', room: 'r' });
        transport.inject({ type: 'bye' });
        expect(transport.closed).toBe(true);
        expect(transport.closeCode).toBe(1000);
    });

    it('ignores messages that target a peer not in the same room', () =>
    {
        const hub = new SignalingHub();
        hub.room('a').open();
        hub.room('b').open();
        const { transport: ta, peer: pa } = attachPeer(hub);
        const { transport: tb, peer: pb } = attachPeer(hub);
        ta.inject({ type: 'join', room: 'a' });
        tb.inject({ type: 'join', room: 'b' });
        ta.outbox.length = 0; tb.outbox.length = 0;

        ta.inject({ type: 'offer', sdp: MIN_SDP, target: pb.id });
        expect(tb.countSent('offer')).toBe(0);
        const err = ta.outbox.map(JSON.parse).find(m => m.type === 'error');
        expect(err).toBeTruthy();
        expect(err.code).toBe('TARGET_NOT_IN_ROOM');
        // sender does NOT advance state on rejection
        expect(pa.state).toBe('stable');
        void pb;
    });

    it('peer.send writes a JSON envelope containing the type', () =>
    {
        const hub = new SignalingHub();
        const { transport, peer } = attachPeer(hub);
        peer.send('hello', { who: 'world' });
        const frame = transport.lastSent();
        expect(frame.type).toBe('hello');
        expect(frame.who).toBe('world');
    });

    it('SignalingError, SdpError, IceError are exposed for instanceof checks (via lib/errors)', () =>
    {
        // Sanity: this PR depends on the existing error class wiring.
        expect(new SignalingError('x')).toBeInstanceOf(Error);
        expect(new SdpError('x')).toBeInstanceOf(Error);
        expect(new IceError('x')).toBeInstanceOf(Error);
    });
});
