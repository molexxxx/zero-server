'use strict';

const { EventEmitter } = require('node:events');
const {
    SignalingHub, spawnBotPeer, WebRTCError,
} = require('../../lib/webrtc');

// Minimal valid SDP that satisfies the hub's structural validation
// (parse + UDP/TLS/RTP/SAVPF + ice-ufrag + ice-pwd + fingerprint).
const MIN_SDP = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdef0123456789',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass', 'a=mid:0', 'a=sendrecv', 'a=rtpmap:111 opus/48000/2',
].join('\r\n') + '\r\n';

// ---------------------------------------------------------------------------
//  Fake `wrtc` module.
//
//  RTCPeerConnection: minimal stub that records every operation so tests
//  can assert on the negotiation sequence.  createOffer/createAnswer
//  return synthetic SDP strings; setLocalDescription stores them; the
//  test driver can fire icecandidate / track / datachannel events
//  manually via the `_emit*` helpers.
// ---------------------------------------------------------------------------

function makeFakeWrtc()
{
    const created = []; // every PC that was constructed
    class RTCPeerConnection extends EventEmitter
    {
        constructor(config)
        {
            super();
            this.config           = config;
            this.localDescription = null;
            this.remoteDescription = null;
            this.ice              = [];
            this.closed           = false;
            this._n               = ++RTCPeerConnection._seq;
            this.onicecandidate   = null;
            this.ontrack          = null;
            this.ondatachannel    = null;
            created.push(this);
        }
        async createOffer()  { return { type: 'offer',  sdp: MIN_SDP + `a=zero-offer-tag:${this._n}\r\n` }; }
        async createAnswer() { return { type: 'answer', sdp: MIN_SDP + `a=zero-answer-tag:${this._n}\r\n` }; }
        async setLocalDescription(d)  { this.localDescription = d; }
        async setRemoteDescription(d) { this.remoteDescription = d; }
        async addIceCandidate(c)      { this.ice.push(c); }
        close() { this.closed = true; }

        _emitIce(candidate)
        {
            if (typeof this.onicecandidate === 'function')
            {
                this.onicecandidate({ candidate: { candidate } });
            }
        }
        _emitTrack(track, streams)
        {
            if (typeof this.ontrack === 'function') this.ontrack({ track, streams });
        }
        _emitDataChannel(channel)
        {
            if (typeof this.ondatachannel === 'function') this.ondatachannel({ channel });
        }
    }
    RTCPeerConnection._seq = 0;
    class RTCSessionDescription { constructor(init) { Object.assign(this, init); } }
    class RTCIceCandidate       { constructor(init) { Object.assign(this, init); } }
    return { wrtc: { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate }, created };
}

// ---------------------------------------------------------------------------
//  Tiny browser-style mock transport (so we can attach a second "remote"
//  peer to the hub and drive negotiations with the bot).
// ---------------------------------------------------------------------------

class MockTransport extends EventEmitter
{
    constructor() { super(); this.outbox = []; this.closed = false; }
    send(s) { if (!this.closed) this.outbox.push(s); }
    close(code, reason) { if (this.closed) return; this.closed = true; this.emit('close', code, reason); }
    inject(obj) { this.emit('message', typeof obj === 'string' ? obj : JSON.stringify(obj)); }
    last() { return this.outbox.length ? JSON.parse(this.outbox[this.outbox.length - 1]) : null; }
    drain() { const out = this.outbox.map((s) => JSON.parse(s)); this.outbox.length = 0; return out; }
}

describe('spawnBotPeer - input validation', () =>
{
    test('throws when hub is missing', () =>
    {
        expect(() => spawnBotPeer({ room: 'x' })).toThrow(/requires \{ hub \}/);
    });

    test('throws when room is missing', () =>
    {
        const hub = new SignalingHub();
        expect(() => spawnBotPeer({ hub })).toThrow(/requires \{ room \}/);
        hub.close();
    });

    test('throws WEBRTC_BOT_NOT_INSTALLED when wrtc is missing', () =>
    {
        const hub = new SignalingHub();
        try
        {
            spawnBotPeer({ hub, room: 'x' });
            throw new Error('expected spawnBotPeer to throw');
        }
        catch (err)
        {
            expect(err).toBeInstanceOf(WebRTCError);
            expect(err.code).toBe('WEBRTC_BOT_NOT_INSTALLED');
            expect(err.message).toMatch(/wrtc/);
        }
        finally { hub.close(); }
    });

    test('throws when injected wrtc is missing RTCPeerConnection', () =>
    {
        const hub = new SignalingHub();
        expect(() => spawnBotPeer({ hub, room: 'x', wrtc: {} })).toThrow(/RTCPeerConnection/);
        hub.close();
    });
});

describe('spawnBotPeer - joining the hub', () =>
{
    test('joins the room after hub sends hello', async () =>
    {
        const hub = new SignalingHub();
        const { wrtc } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'lobby', wrtc });
        const { peerId } = await bot.ready;
        expect(typeof peerId).toBe('string');
        expect(hub.room('lobby').peers().some((p) => p.id === peerId)).toBe(true);
        bot.close();
        hub.close();
    });

    test('forwards joinToken in the join message when provided', async () =>
    {
        const hub = new SignalingHub({ joinTokenSecret: 'shh', autoCreateRooms: true });
        const { signJoinToken } = require('../../lib/webrtc');
        const token = signJoinToken({ secret: 'shh', user: { id: 'bot' }, room: 'gated' });
        const { wrtc } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'gated', wrtc, joinToken: token, user: { id: 'bot' } });
        await bot.ready;
        expect(hub.room('gated').peers().some((p) => p.id === bot.peer.id)).toBe(true);
        bot.close();
        hub.close();
    });

    test('ready rejects when hub responds with an error', async () =>
    {
        // Hub with no joinTokenSecret will reject any token-bearing join, but a
        // simpler way to force an error is to point at a room that fails
        // validation. The hub emits {type:'error'} for malformed joins.
        const hub = new SignalingHub({ autoCreateRooms: false });
        const { wrtc } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'no-such-room', wrtc });
        await expect(bot.ready).rejects.toMatchObject({ code: expect.any(String) });
        bot.close();
        hub.close();
    });
});

describe('spawnBotPeer - negotiation', () =>
{
    test('offers to every existing peer in the joined list', async () =>
    {
        const hub = new SignalingHub();
        // Pre-attach two "browser" peers to the lobby.
        const t1 = new MockTransport();
        const p1 = hub.attach(t1);
        t1.drain();
        t1.inject({ type: 'join', room: 'lobby' });
        t1.drain();
        const t2 = new MockTransport();
        const p2 = hub.attach(t2);
        t2.drain();
        t2.inject({ type: 'join', room: 'lobby' });
        t2.drain();

        const { wrtc, created } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'lobby', wrtc });
        await bot.ready;
        // tick so async offer chain settles
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        // One PC per remote peer in the room when we joined.
        expect(created.length).toBe(2);
        // p1 and p2 should each have received an 'offer' from the bot.
        const offers1 = t1.outbox.map((s) => JSON.parse(s)).filter((m) => m.type === 'offer');
        const offers2 = t2.outbox.map((s) => JSON.parse(s)).filter((m) => m.type === 'offer');
        expect(offers1).toHaveLength(1);
        expect(offers2).toHaveLength(1);
        expect(offers1[0].from).toBe(bot.peer.id);
        expect(offers1[0].sdp).toMatch(/zero-offer-tag/);
        bot.close();
        hub.close();
        // suppress unused-var lints
        expect(p1.id).toBeDefined();
        expect(p2.id).toBeDefined();
    });

    test('answers an inbound offer from another peer', async () =>
    {
        const hub = new SignalingHub();
        const { wrtc, created } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'lobby', wrtc });
        await bot.ready;

        // Now a remote peer joins and sends us an offer.
        const tr = new MockTransport();
        const remote = hub.attach(tr);
        tr.drain();
        tr.inject({ type: 'join', room: 'lobby' });
        tr.drain();
        tr.inject({ type: 'offer', target: bot.peer.id, sdp: MIN_SDP + 'a=zero-remote-offer:1\r\n' });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const fromBot = tr.outbox.map((s) => JSON.parse(s));
        const answer  = fromBot.find((m) => m.type === 'answer' && m.from === bot.peer.id);
        expect(answer).toBeTruthy();
        expect(answer.sdp).toMatch(/zero-answer-tag/);
        // The bot's PC for `remote` saw the remote offer applied.
        const pc = bot.getPeerConnection(remote.id);
        expect(pc).toBeDefined();
        expect(pc.remoteDescription.sdp).toMatch(/zero-remote-offer/);

        bot.close();
        hub.close();
    });

    test('applies inbound answer and ICE candidates', async () =>
    {
        const hub = new SignalingHub();
        const tr  = new MockTransport();
        const remote = hub.attach(tr);
        tr.drain();
        tr.inject({ type: 'join', room: 'lobby' });
        tr.drain();

        const { wrtc } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'lobby', wrtc });
        await bot.ready;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        // Bot offered remote.  Remote replies with answer + ICE.
        tr.inject({ type: 'answer', target: bot.peer.id, sdp: MIN_SDP + 'a=zero-remote-answer:1\r\n' });
        tr.inject({ type: 'ice',    target: bot.peer.id, candidate: 'candidate:1 1 udp 1 1.2.3.4 1234 typ host' });
        await new Promise((r) => setImmediate(r));

        const pc = bot.getPeerConnection(remote.id);
        expect(pc.remoteDescription.sdp).toMatch(/zero-remote-answer/);
        expect(pc.ice).toHaveLength(1);
        expect(pc.ice[0].candidate).toMatch(/^candidate:1/);

        bot.close();
        hub.close();
    });

    test('forwards local ICE candidates to the targeted peer', async () =>
    {
        const hub = new SignalingHub();
        const tr  = new MockTransport();
        const remote = hub.attach(tr);
        tr.drain();
        tr.inject({ type: 'join', room: 'lobby' });
        tr.drain();

        const { wrtc } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'lobby', wrtc });
        await bot.ready;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const pc = bot.getPeerConnection(remote.id);
        tr.drain();
        pc._emitIce('candidate:9 1 udp 9 5.6.7.8 9000 typ host');

        // Hub relays the ice frame to `remote` with `from = bot.peer.id`.
        const got = tr.outbox.map((s) => JSON.parse(s)).find((m) => m.type === 'ice');
        expect(got).toBeTruthy();
        expect(got.from).toBe(bot.peer.id);
        expect(got.candidate).toMatch(/^candidate:9/);

        bot.close();
        hub.close();
    });

    test('onTrack / onDataChannel callbacks fire with the source peer id', async () =>
    {
        const hub = new SignalingHub();
        const tr  = new MockTransport();
        const remote = hub.attach(tr);
        tr.drain();
        tr.inject({ type: 'join', room: 'lobby' });
        tr.drain();

        const tracks   = [];
        const channels = [];
        const { wrtc } = makeFakeWrtc();
        const bot = spawnBotPeer({
            hub,    room: 'lobby', wrtc,
            onTrack:       (track, streams, from) => tracks.push({ track, streams, from }),
            onDataChannel: (ch, from)             => channels.push({ ch, from }),
        });
        await bot.ready;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const pc = bot.getPeerConnection(remote.id);
        pc._emitTrack({ id: 'audio-1', kind: 'audio' }, [{ id: 'stream-1' }]);
        pc._emitDataChannel({ label: 'chat' });

        expect(tracks).toHaveLength(1);
        expect(tracks[0].from).toBe(remote.id);
        expect(tracks[0].track.kind).toBe('audio');
        expect(channels).toHaveLength(1);
        expect(channels[0].from).toBe(remote.id);
        expect(channels[0].ch.label).toBe('chat');

        bot.close();
        hub.close();
    });

    test('peer-leave drops the PC and fires onPeerLeave', async () =>
    {
        const hub = new SignalingHub();
        const tr  = new MockTransport();
        hub.attach(tr);
        tr.drain();
        tr.inject({ type: 'join', room: 'lobby' });
        tr.drain();

        const left = [];
        const { wrtc } = makeFakeWrtc();
        const bot = spawnBotPeer({
            hub, room: 'lobby', wrtc,
            onPeerLeave: (id) => left.push(id),
        });
        await bot.ready;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const remoteIds = Array.from(bot.peerConnections.keys());
        expect(remoteIds).toHaveLength(1);
        const pc = bot.getPeerConnection(remoteIds[0]);
        tr.close();
        await new Promise((r) => setImmediate(r));
        expect(pc.closed).toBe(true);
        expect(bot.peerConnections.has(remoteIds[0])).toBe(false);
        expect(left).toEqual(remoteIds);

        bot.close();
        hub.close();
    });

    test('peer-joined fires onPeerJoin and waits for the newcomer to offer', async () =>
    {
        const hub = new SignalingHub();
        const { wrtc, created } = makeFakeWrtc();
        const joined = [];
        const bot = spawnBotPeer({
            hub, room: 'lobby', wrtc,
            onPeerJoin: (id) => joined.push(id),
        });
        await bot.ready;

        // Newcomer joins after the bot.
        const tr = new MockTransport();
        const remote = hub.attach(tr);
        tr.drain();
        tr.inject({ type: 'join', room: 'lobby' });
        await new Promise((r) => setImmediate(r));

        expect(joined).toEqual([remote.id]);
        // Bot does NOT offer first when another peer joins after it.
        expect(created).toHaveLength(0);

        bot.close();
        hub.close();
    });

    test('close() closes every RTCPeerConnection and the transport', async () =>
    {
        const hub = new SignalingHub();
        const tr  = new MockTransport();
        hub.attach(tr);
        tr.drain();
        tr.inject({ type: 'join', room: 'lobby' });
        tr.drain();

        const { wrtc, created } = makeFakeWrtc();
        const bot = spawnBotPeer({ hub, room: 'lobby', wrtc });
        await bot.ready;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(created.length).toBe(1);
        bot.close();
        expect(created[0].closed).toBe(true);
        expect(bot.peerConnections.size).toBe(0);
        // double close is a no-op
        expect(() => bot.close()).not.toThrow();
        hub.close();
    });
});
