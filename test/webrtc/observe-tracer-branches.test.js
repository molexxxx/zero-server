/**
 * observe.js — branch coverage for the answer / subscribe / publishFailed
 * / subscribeFailed tracer spans (lines 211-226).
 */

'use strict';

const { SignalingHub, bindObservability } = require('../../lib/webrtc');

function makeTracer()
{
    const spans = [];
    const tracer = {
        startSpan(name, opts)
        {
            const span = {
                name,
                attributes: { ...(opts && opts.attributes) },
                status:     { code: 0 },
                setOk()   { this.status.code = 1; },
                setError(msg) { this.status.code = 2; this.status.message = msg; },
                end()     { spans.push(this); },
            };
            return span;
        },
    };
    return { tracer, spans };
}

describe('observe.js tracer branch coverage', () =>
{
    it('emits webrtc.subscribe span when an answer event fires', () =>
    {
        const { tracer, spans } = makeTracer();
        const hub = new SignalingHub();
        bindObservability(hub, { tracer });
        hub.emit('answer', { peer: { id: 'p1' }, target: { id: 'p2' }, room: { name: 'r1' } });
        const sub = spans.find((s) => s.name === 'webrtc.subscribe');
        expect(sub).toBeTruthy();
        expect(sub.status.code).toBe(1);
        expect(sub.attributes['peer.id']).toBe('p1');
        expect(sub.attributes['rtc.target']).toBe('p2');
        expect(sub.attributes['room.id']).toBe('r1');
    });

    it('emits webrtc.subscribe error span on subscribeFailed', () =>
    {
        const { tracer, spans } = makeTracer();
        const hub = new SignalingHub();
        bindObservability(hub, { tracer });
        hub.emit('subscribeFailed', { peer: { id: 'p1' }, reason: 'FORBIDDEN', room: 'r1' });
        const sub = spans.find((s) => s.name === 'webrtc.subscribe' && s.status.code === 2);
        expect(sub).toBeTruthy();
        expect(sub.attributes['rtc.error']).toBe('FORBIDDEN');
        expect(sub.attributes['room.id']).toBe('r1');
    });

    it('emits webrtc.publish error span on publishFailed', () =>
    {
        const { tracer, spans } = makeTracer();
        const hub = new SignalingHub();
        bindObservability(hub, { tracer });
        hub.emit('publishFailed', { peer: { id: 'p1' }, reason: 'RATE_LIMIT' });
        const pub = spans.find((s) => s.name === 'webrtc.publish' && s.status.code === 2);
        expect(pub).toBeTruthy();
        expect(pub.attributes['rtc.error']).toBe('RATE_LIMIT');
    });

    it('emits webrtc.join error span on joinFailed', () =>
    {
        const { tracer, spans } = makeTracer();
        const hub = new SignalingHub();
        bindObservability(hub, { tracer });
        hub.emit('joinFailed', { peer: { id: 'p1' }, reason: 'NO_ROOM' });
        const join = spans.find((s) => s.name === 'webrtc.join' && s.status.code === 2);
        expect(join).toBeTruthy();
        expect(join.attributes['rtc.error']).toBe('NO_ROOM');
    });
});
