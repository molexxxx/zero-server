/**
 * createWebRTC() factory tests.
 *   Exercises the top-level wiring helper that builds a SignalingHub,
 *   binds observability, and attaches the WS route to a host app.
 */

'use strict';

const { createWebRTC, SignalingHub } = require('../../lib/webrtc');
const { EventEmitter } = require('node:events');

/** Minimal app handle that records ws() registrations. */
function fakeApp()
{
    const app = {
        _routes: [],
        ws(path, handler) { this._routes.push({ path, handler }); },
    };
    return app;
}

/** WebSocket-shaped transport stub. */
function fakeWs()
{
    const ws = new EventEmitter();
    ws.send = () => {};
    ws.readyState = 1;
    ws.close = () => { ws.emit('close'); };
    return ws;
}

describe('createWebRTC', () =>
{
    it('throws WEBRTC_INVALID_APP when app missing or app.ws not a function', () =>
    {
        expect(() => createWebRTC(null)).toThrow(/createWebRTC requires/);
        expect(() => createWebRTC({})).toThrow(/createWebRTC requires/);
        expect(() => createWebRTC({ ws: 'not-a-fn' })).toThrow(/createWebRTC requires/);
        try { createWebRTC({}); }
        catch (err) { expect(err.code).toBe('WEBRTC_INVALID_APP'); }
    });

    it('returns a SignalingHub and registers WS route at default /rtc', () =>
    {
        const app = fakeApp();
        const hub = createWebRTC(app);
        expect(hub).toBeInstanceOf(SignalingHub);
        expect(app._routes).toHaveLength(1);
        expect(app._routes[0].path).toBe('/rtc');
    });

    it('honors a custom opts.path', () =>
    {
        const app = fakeApp();
        createWebRTC(app, { path: '/signal' });
        expect(app._routes[0].path).toBe('/signal');
    });

    it('binds observability when metrics is provided', () =>
    {
        const app = fakeApp();
        const tally = {};
        const counter = (def) =>
        {
            const name = def.name || def;
            return { inc: (labels, n = 1) => { tally[name] = (tally[name] || 0) + n; } };
        };
        const gauge = () => ({ inc: () => {}, dec: () => {}, set: () => {} });
        const metrics = { counter, gauge, histogram: () => ({ observe: () => {} }) };
        const hub = createWebRTC(app, { metrics });
        expect(hub).toBeInstanceOf(SignalingHub);
    });

    it('binds observability when tracer is provided (no metrics)', () =>
    {
        const app = fakeApp();
        const spans = [];
        const tracer = {
            startSpan: (name, opts) =>
            {
                const span = {
                    name, opts,
                    setOk() { this.ok = true; },
                    setError(e) { this.err = e; },
                    end() { spans.push(this); },
                };
                return span;
            },
        };
        const hub = createWebRTC(app, { tracer });
        hub.emit('offer', { peer: { id: 'p1' }, target: { id: 'p2' }, room: { name: 'r' } });
        expect(spans.some((s) => s.name === 'webrtc.publish')).toBe(true);
    });

    it('attaches a peer when the WS handler fires and closes it on ws close', async () =>
    {
        const app = fakeApp();
        const hub = createWebRTC(app);
        const ws  = fakeWs();
        const req = { user: { id: 'u1' }, ip: '1.2.3.4', headers: { origin: 'https://x' } };
        app._routes[0].handler(ws, req);
        let s = await hub.stats();
        expect(s.peers).toBe(1);
        ws.emit('close');
        s = await hub.stats();
        expect(s.peers).toBe(0);
    });

    it('handler tolerates a missing req', () =>
    {
        const app = fakeApp();
        createWebRTC(app);
        expect(() => app._routes[0].handler(fakeWs(), null)).not.toThrow();
    });

    it('handler tolerates a req without headers', async () =>
    {
        const app = fakeApp();
        const hub = createWebRTC(app);
        app._routes[0].handler(fakeWs(), { user: { id: 'u' }, ip: '1.1.1.1' });
        const s = await hub.stats();
        expect(s.peers).toBe(1);
    });
});
