/**
 * @module webrtc/observe
 * @description Optional metrics + tracing wiring for a {@link SignalingHub}.
 *              Pass a `MetricsRegistry`, a `Tracer`, or both; the binder
 *              subscribes to the hub's lifecycle events and exports the six
 *              standard `zs_webrtc_*` Prometheus series plus per-operation
 *              OpenTelemetry-compatible spans.
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
    });

    hub.on('leave', ({ peer, room }) =>
    {
        m.peersActive.dec({ room: room.name });
        if (m.peersActive.get({ room: room.name }) <= 0)
            m.roomsActive.dec();
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
 * @example | Plug into an existing app
 *   const hub = new SignalingHub();
 *   bindObservability(hub, { metrics: app.metrics() });
 */
function bindObservability(hub, opts = {})
{
    if (opts.metrics) _bindMetrics(hub, _registerMetrics(opts.metrics));
    if (opts.tracer)  _bindTracing(hub, opts.tracer);
    return hub;
}

module.exports = { bindObservability };
