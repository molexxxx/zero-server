'use strict';

const { EventEmitter } = require('node:events');
const { SignalingHub } = require('../../lib/webrtc/signaling');
const { bindObservability } = require('../../lib/webrtc/observe');
const { MetricsRegistry } = require('../../lib/observe/metrics');
const { Tracer } = require('../../lib/observe/tracing');

// --- Mock transport ---

class MockTransport extends EventEmitter
{
    constructor(meta = {}) { super(); this.ip = meta.ip || '127.0.0.1'; this.outbox = []; this.closed = false; }
    send(d) { if (!this.closed) this.outbox.push(d); }
    close(code, reason) { if (this.closed) return; this.closed = true; this.emit('close', code ?? 1000, reason ?? ''); }
    inject(o) { this.emit('message', typeof o === 'string' ? o : JSON.stringify(o)); }
}

const MIN_SDP = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdef0123456789',
    'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    'a=setup:actpass', 'a=mid:0', 'a=sendrecv', 'a=rtpmap:111 opus/48000/2',
].join('\r\n') + '\r\n';

// --- Tests ---

describe('webrtc observability - metrics', () =>
{
    function setup()
    {
        const registry = new MetricsRegistry();
        const hub = new SignalingHub();
        bindObservability(hub, { metrics: registry });
        return { registry, hub };
    }

    it('registers all six standard WebRTC metrics on the registry', () =>
    {
        const { registry } = setup();
        for (const name of [
            'zs_webrtc_peers_active',
            'zs_webrtc_rooms_active',
            'zs_webrtc_signaling_messages_total',
            'zs_webrtc_offer_duration_ms',
            'zs_webrtc_join_failures_total',
            'zs_webrtc_ice_restart_total',
        ])
        {
            expect(registry.getMetric(name)).toBeTruthy();
        }
    });

    it('increments zs_webrtc_peers_active on join and decrements on leave', () =>
    {
        const { registry, hub } = setup();
        hub.room('lobby').open();

        const gauge = registry.getMetric('zs_webrtc_peers_active');
        expect(gauge.get({ room: 'lobby' })).toBe(0);

        const t = new MockTransport();
        hub.attach(t);
        t.inject({ type: 'join', room: 'lobby' });
        expect(gauge.get({ room: 'lobby' })).toBe(1);

        t.close();
        expect(gauge.get({ room: 'lobby' })).toBe(0);
    });

    it('tracks zs_webrtc_rooms_active as rooms acquire and lose their last peer', () =>
    {
        const { registry, hub } = setup();
        const gauge = registry.getMetric('zs_webrtc_rooms_active');
        expect(gauge.get()).toBe(0);

        const t1 = new MockTransport();
        const t2 = new MockTransport();
        hub.attach(t1);
        hub.attach(t2);
        t1.inject({ type: 'join', room: 'r' });
        t2.inject({ type: 'join', room: 'r' });
        expect(gauge.get()).toBe(1);

        t1.close();
        expect(gauge.get()).toBe(1); // still one peer left
        t2.close();
        expect(gauge.get()).toBe(0);
    });

    it('increments zs_webrtc_signaling_messages_total per accepted message with type+direction+result labels', () =>
    {
        const { registry, hub } = setup();
        hub.room('lobby').open();
        const counter = registry.getMetric('zs_webrtc_signaling_messages_total');

        const t = new MockTransport();
        hub.attach(t);
        t.inject({ type: 'join', room: 'lobby' });

        expect(counter.get({ type: 'join', direction: 'in', result: 'ok' })).toBe(1);
    });

    it('records zs_webrtc_offer_duration_ms when an answer arrives after an offer', () =>
    {
        const { registry, hub } = setup();
        hub.room('r').open();
        const hist = registry.getMetric('zs_webrtc_offer_duration_ms');

        const ta = new MockTransport(); const tb = new MockTransport();
        const pa = hub.attach(ta); const pb = hub.attach(tb);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });

        ta.inject({ type: 'offer', sdp: MIN_SDP, target: pb.id });
        tb.inject({ type: 'answer', sdp: MIN_SDP, target: pa.id });

        const obs = hist.get({ room: 'r' });
        expect(obs).toBeTruthy();
        expect(obs.count).toBe(1);
        expect(obs.sum).toBeGreaterThanOrEqual(0);
    });

    it('increments zs_webrtc_join_failures_total with a "reason" label on every rejected join', () =>
    {
        const { registry, hub } = setup();
        hub.room('vault').require(() => false);
        const counter = registry.getMetric('zs_webrtc_join_failures_total');

        const t = new MockTransport();
        hub.attach(t);
        t.inject({ type: 'join', room: 'vault' });

        expect(counter.get({ reason: 'FORBIDDEN' })).toBe(1);
    });

    it('counts zs_webrtc_ice_restart_total when an offer changes ufrag for the sending peer', () =>
    {
        const { registry, hub } = setup();
        hub.room('r').open();
        const counter = registry.getMetric('zs_webrtc_ice_restart_total');

        const ta = new MockTransport(); const tb = new MockTransport();
        const pb = hub.attach(tb); hub.attach(ta);
        // need pb attached first so pa.attach order matters? No, both attached now.
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });

        // First offer - establishes the baseline ufrag for the sending peer
        ta.inject({ type: 'offer', sdp: MIN_SDP, target: pb.id });
        expect(counter.get({ room: 'r' })).toBe(0);

        // Second offer with a different ufrag - counted as an ICE restart
        const restartSdp = MIN_SDP.replace('a=ice-ufrag:abcd', 'a=ice-ufrag:ZZZZ');
        ta.inject({ type: 'offer', sdp: restartSdp, target: pb.id });
        expect(counter.get({ room: 'r' })).toBe(1);
    });

    it('tracks peers-per-mesh-room and counts mesh overflow on promotion', () =>
    {
        const registry = new MetricsRegistry();
        const hub = new SignalingHub({ topology: 'auto', maxMeshPeers: 2 });
        bindObservability(hub, { metrics: registry });
        hub.room('r').open();

        const gauge = registry.getMetric('zs_webrtc_peers_per_mesh_room');
        const overflow = registry.getMetric('zs_webrtc_mesh_overflow_total');
        const promo = registry.getMetric('zs_webrtc_topology_promotions_total');

        const txs = [];
        for (let i = 0; i < 2; i++)
        {
            const t = new MockTransport(); hub.attach(t);
            t.inject({ type: 'join', room: 'r' });
            txs.push(t);
        }
        expect(gauge.get({ room: 'r' })).toBe(2);

        const t3 = new MockTransport(); hub.attach(t3);
        t3.inject({ type: 'join', room: 'r' });
        // 3rd join trips the limit and promotes the room.
        expect(overflow.get({ room: 'r' })).toBeGreaterThanOrEqual(1);
        expect(promo.get({ room: 'r', from: 'mesh', to: 'sfu' })).toBeGreaterThanOrEqual(1);
        // After promotion the mesh gauge is drained.
        expect(gauge.get({ room: 'r' })).toBe(0);
    });
});

describe('webrtc observability - tracing', () =>
{
    function setup()
    {
        const spans = [];
        const tracer = new Tracer({
            serviceName: 'webrtc-test',
            exporter:    (batch) => spans.push(...batch),
            batchSize:   1,
            flushInterval: 0,
        });
        const hub = new SignalingHub();
        bindObservability(hub, { tracer });
        return { hub, spans, tracer };
    }

    it('emits a webrtc.join span with peer.id and room.id attributes when a peer joins', async () =>
    {
        const { hub, spans, tracer } = setup();
        hub.room('lobby').open();
        const t = new MockTransport();
        const peer = hub.attach(t);
        t.inject({ type: 'join', room: 'lobby' });
        await tracer.flush();

        const joinSpan = spans.find(s => s.name === 'webrtc.join');
        expect(joinSpan).toBeTruthy();
        expect(joinSpan.attributes['peer.id']).toBe(peer.id);
        expect(joinSpan.attributes['room.id']).toBe('lobby');
        expect(joinSpan.status.code).toBe(1); // OK
    });

    it('emits a webrtc.publish span with error status when a publish gate rejects', async () =>
    {
        const { hub, spans, tracer } = setup();
        hub.room('r').open().canPublish(() => false);
        const ta = new MockTransport(); const tb = new MockTransport();
        hub.attach(ta); const pb = hub.attach(tb);
        ta.inject({ type: 'join', room: 'r' });
        tb.inject({ type: 'join', room: 'r' });
        ta.inject({ type: 'offer', sdp: MIN_SDP, target: pb.id });
        await tracer.flush();

        const pub = spans.find(s => s.name === 'webrtc.publish');
        expect(pub).toBeTruthy();
        expect(pub.status.code).toBe(2); // ERROR
        expect(pub.attributes['rtc.error']).toBe('FORBIDDEN');
    });

    it('emits a webrtc.signal span for every dispatched message', async () =>
    {
        const { hub, spans, tracer } = setup();
        hub.room('r').open();
        const t = new MockTransport();
        hub.attach(t);
        t.inject({ type: 'join', room: 'r' });
        await tracer.flush();
        const sig = spans.find(s => s.name === 'webrtc.signal' && s.attributes['rtc.type'] === 'join');
        expect(sig).toBeTruthy();
    });
});
