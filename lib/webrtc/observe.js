/**
 * @module webrtc/observe
 * @description Optional metrics + tracing wiring for a `SignalingHub`.
 *   `bindObservability(hub, { metrics, tracer })` exports the standard
 *   `zs_webrtc_*` Prometheus series plus OTel-compatible spans. Both
 *   adapters are duck-typed and opt-in.
 */

'use strict';

// --- Helpers ---

/** Extract the first `a=ice-ufrag:` value from an SDP blob. */
function _extractUfrag(sdp)
{
    const m = /^a=ice-ufrag:([^\r\n]+)/m.exec(sdp);
    return m ? m[1].trim() : null;
}

// --- Metrics binder ---

function _registerMetrics(registry)
{
    return {
        peersActive: registry.gauge({
            name:   'zs_webrtc_peers_active',
            help:   'Number of WebRTC peers currently joined per room.',
            labels: ['room'],
        }),
        roomsActive: registry.gauge({
            name: 'zs_webrtc_rooms_active',
            help: 'Number of WebRTC rooms with at least one peer.',
        }),
        signalingMessages: registry.counter({
            name:   'zs_webrtc_signaling_messages_total',
            help:   'WebRTC signaling messages by type, direction, and outcome.',
            labels: ['type', 'direction', 'result'],
        }),
        offerDuration: registry.histogram({
            name:    'zs_webrtc_offer_duration_ms',
            help:    'End-to-end latency between an offer and its matching answer, in ms.',
            labels:  ['room'],
            buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
        }),
        joinFailures: registry.counter({
            name:   'zs_webrtc_join_failures_total',
            help:   'WebRTC room joins rejected by the hub.',
            labels: ['reason'],
        }),
        iceRestart: registry.counter({
            name:   'zs_webrtc_ice_restart_total',
            help:   'Detected ICE restarts (ufrag rotation) per room.',
            labels: ['room'],
        }),
        peersPerMeshRoom: registry.gauge({
            name:   'zs_webrtc_peers_per_mesh_room',
            help:   'Current peer count for rooms still in full-mesh topology.',
            labels: ['room'],
        }),
        meshOverflow: registry.counter({
            name:   'zs_webrtc_mesh_overflow_total',
            help:   'Rooms that exceeded `maxMeshPeers` while still in mesh topology (signals N² uplink risk).',
            labels: ['room'],
        }),
        topologyPromotions: registry.counter({
            name:   'zs_webrtc_topology_promotions_total',
            help:   'Auto-promotions from one topology to another (e.g. mesh→sfu).',
            labels: ['room', 'from', 'to'],
        }),
    };
}

function _bindMetrics(hub, m)
{
    /** Outstanding offer timestamps: `offererPeerId` -> ms epoch. */
    const offerStart = new Map();
    /** Last seen ufrag per peer.id (for ICE-restart detection). */
    const lastUfrag = new Map();

    hub.on('signal', ({ peer, type }) =>
    {
        m.signalingMessages.inc({ type, direction: 'in', result: 'ok' });
    });

    hub.on('join', ({ peer, room }) =>
    {
        const before = m.peersActive.get({ room: room.name });
        m.peersActive.inc({ room: room.name });
        // Room newly non-empty?
        if (before === 0) m.roomsActive.inc();
        if (room.topology === 'mesh')
            m.peersPerMeshRoom.set({ room: room.name }, room.size);
    });

    hub.on('leave', ({ peer, room }) =>
    {
        m.peersActive.dec({ room: room.name });
        if (m.peersActive.get({ room: room.name }) <= 0)
            m.roomsActive.dec();
        if (room.topology === 'mesh')
            m.peersPerMeshRoom.set({ room: room.name }, room.size);
    });

    hub.on('peer:limit:reached', ({ room }) =>
    {
        if (room.topology === 'mesh')
            m.meshOverflow.inc({ room: room.name });
    });

    hub.on('topology:promoted', ({ room, from, to }) =>
    {
        m.topologyPromotions.inc({ room: room.name, from, to });
        // Promotion drains the mesh gauge.
        m.peersPerMeshRoom.set({ room: room.name }, 0);
    });

    hub.on('topology:demoted', ({ room, from, to }) =>
    {
        m.topologyPromotions.inc({ room: room.name, from, to });
        m.peersPerMeshRoom.set({ room: room.name }, room.size);
    });

    hub.on('joinFailed', ({ reason }) =>
    {
        m.joinFailures.inc({ reason: reason || 'UNKNOWN' });
    });

    hub.on('offer', ({ peer, sdp, room }) =>
    {
        offerStart.set(peer.id, Date.now());

        // ICE-restart detection: compare ufrag against last-known for this peer.
        const ufrag = _extractUfrag(sdp);
        if (ufrag)
        {
            const prev = lastUfrag.get(peer.id);
            if (prev && prev !== ufrag)
                m.iceRestart.inc({ room: room.name });
            lastUfrag.set(peer.id, ufrag);
        }
    });

    hub.on('answer', ({ peer, target, room }) =>
    {
        // The offer was sent by the original target (now answering back to it).
        const startedAt = offerStart.get(target.id);
        if (startedAt !== undefined)
        {
            m.offerDuration.observe({ room: room.name }, Date.now() - startedAt);
            offerStart.delete(target.id);
        }
    });
}

// --- Tracing binder ---

function _bindTracing(hub, tracer)
{
    hub.on('signal', ({ peer, type }) =>
    {
        const span = tracer.startSpan('webrtc.signal', {
            kind:       'server',
            attributes: { 'peer.id': peer.id, 'rtc.type': type },
        });
        span.setOk();
        span.end();
    });

    hub.on('join', ({ peer, room }) =>
    {
        const span = tracer.startSpan('webrtc.join', {
            kind:       'server',
            attributes: { 'peer.id': peer.id, 'room.id': room.name },
        });
        span.setOk();
        span.end();
    });

    hub.on('joinFailed', ({ peer, reason, room }) =>
    {
        const span = tracer.startSpan('webrtc.join', {
            kind:       'server',
            attributes: { 'peer.id': peer.id, 'room.id': room || '', 'rtc.error': reason },
        });
        span.setError(reason);
        span.end();
    });

    hub.on('offer', ({ peer, target, room }) =>
    {
        const span = tracer.startSpan('webrtc.publish', {
            kind:       'producer',
            attributes: { 'peer.id': peer.id, 'room.id': room.name, 'rtc.target': target.id },
        });
        span.setOk();
        span.end();
    });

    hub.on('publishFailed', ({ peer, reason, room }) =>
    {
        const span = tracer.startSpan('webrtc.publish', {
            kind:       'producer',
            attributes: { 'peer.id': peer.id, 'room.id': room || '', 'rtc.error': reason },
        });
        span.setError(reason);
        span.end();
    });

    hub.on('answer', ({ peer, target, room }) =>
    {
        const span = tracer.startSpan('webrtc.subscribe', {
            kind:       'consumer',
            attributes: { 'peer.id': peer.id, 'room.id': room.name, 'rtc.target': target.id },
        });
        span.setOk();
        span.end();
    });

    hub.on('subscribeFailed', ({ peer, reason, room }) =>
    {
        const span = tracer.startSpan('webrtc.subscribe', {
            kind:       'consumer',
            attributes: { 'peer.id': peer.id, 'room.id': room || '', 'rtc.error': reason },
        });
        span.setError(reason);
        span.end();
    });
}

// --- Public API ---

/**
 * Wire a {@link SignalingHub} to a metrics registry and / or a tracer.
 *
 * Registers six standard Prometheus series under the `zs_webrtc_` prefix:
 *
 * - `zs_webrtc_peers_active{room}`            (gauge)
 * - `zs_webrtc_rooms_active`                  (gauge)
 * - `zs_webrtc_signaling_messages_total{type,direction,result}` (counter)
 * - `zs_webrtc_offer_duration_ms{room}`       (histogram)
 * - `zs_webrtc_join_failures_total{reason}`   (counter)
 * - `zs_webrtc_ice_restart_total{room}`       (counter)
 *
 * Emits spans named `webrtc.join`, `webrtc.signal`, `webrtc.publish`, and
 * `webrtc.subscribe`, each annotated with `peer.id` and `room.id`.
 *
 * @section Observability
 *
 * @param {SignalingHub} hub - The hub to instrument.
 * @param {object} opts
 * @param {MetricsRegistry} [opts.metrics] - Prometheus-compatible registry.
 * @param {Tracer}          [opts.tracer]  - Tracer for span emission.
 * @returns {SignalingHub} The same hub, for chaining.
 *
 * @example | Wire metrics + tracing from Zero Server's observe scope
 *   const { createApp } = require('@zero-server/sdk');
 *   const { Tracer } = require('@zero-server/sdk/observe');
 *   const { SignalingHub, bindObservability } = require('@zero-server/webrtc');
 *
 *   const app = createApp();
 *   const hub = new SignalingHub({ joinTokenSecret: process.env.JWT });
 *
 *   bindObservability(hub, {
 *       metrics: app.metrics,        // exposes /metrics for Prometheus scraping
 *       tracer:  new Tracer(),       // OTel-shaped tracer
 *   });
 *
 *   app.ws('/rtc', (ws, req) => hub.attach(ws, { user: req.user, ip: req.ip }));
 *
 * @example | Metrics only (no tracer)
 *   const hub = new SignalingHub();
 *   bindObservability(hub, { metrics: app.metrics });
 *   // Scrape /metrics:
 *   //   zs_webrtc_peers_active{room="lobby"}              3
 *   //   zs_webrtc_rooms_active                            1
 *   //   zs_webrtc_signaling_messages_total{type="offer",direction="in",result="ok"} 17
 *   //   zs_webrtc_offer_duration_ms_bucket{room="lobby",le="250"} 5
 *
 * @example | Custom prom-client registry adapter
 *   const client = require('prom-client');
 *   const reg = new client.Registry();
 *   const adapter = {
 *       counter:   ({ name, help, labels }) => new client.Counter({ name, help, labelNames: labels, registers: [reg] }),
 *       gauge:     ({ name, help, labels }) => new client.Gauge  ({ name, help, labelNames: labels, registers: [reg] }),
 *       histogram: ({ name, help, labels, buckets }) =>
 *                  new client.Histogram({ name, help, labelNames: labels, buckets, registers: [reg] }),
 *   };
 *   bindObservability(hub, { metrics: adapter });
 *   app.get('/metrics', async (_req, res) => res.type(reg.contentType).send(await reg.metrics()));
 */
function bindObservability(hub, opts = {})
{
    if (opts.metrics) _bindMetrics(hub, _registerMetrics(opts.metrics));
    if (opts.tracer)  _bindTracing(hub, opts.tracer);
    return hub;
}

module.exports = { bindObservability };
