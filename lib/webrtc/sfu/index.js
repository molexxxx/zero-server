/**
 * @module webrtc/sfu
 * @description Pluggable Selective Forwarding Unit (SFU) adapter interface.
 *
 *   The signaling hub knows nothing about media — the SFU adapter does.
 *   Application code asks for a router per room, allocates a transport per
 *   peer, then drives `produce()` / `consume()` calls in response to the
 *   JSEP traffic flowing through the hub.
 *
 *   Three first-party adapters ship in this repo:
 *
 *   - {@link MemorySfuAdapter} — zero-deps in-process fake, useful for unit
 *     tests and CI.  Forwards `produce` notifications synchronously.
 *   - {@link MediasoupSfuAdapter} — wraps `mediasoup` (peerDep).
 *   - {@link LiveKitSfuAdapter}  — wraps `livekit-server-sdk` (peerDep).
 *
 *   Custom adapters: implement `createRouter`, `createTransport`,
 *   `produce`, `consume`, `pauseProducer`, `resumeProducer`,
 *   `closeRouter`, and `stats`.  Subclass {@link SfuAdapter} for safe
 *   defaults that throw `WEBRTC_SFU_NOT_IMPLEMENTED`.
 *
 * @example | Select an adapter at boot via env
 *   const { loadSfuAdapter } = require('@zero-server/webrtc');
 *   const sfu = loadSfuAdapter(process.env.SFU_BACKEND || 'memory', {
 *       // adapter-specific options forwarded verbatim
 *       workerSettings: { logLevel: 'warn' },
 *   });
 *
 *   sfu.onEvent((event, payload) => log.debug({ event, payload }, 'sfu'));
 *
 * @example | Wire an SFU into the signaling hub per room
 *   const router = await sfu.createRouter({ room: 'lobby' });
 *
 *   hub.on('join', async ({ peer, room }) => {
 *       if (room.name !== 'lobby') return;
 *       const transport = await sfu.createTransport(router, peer);
 *       peer.send('sfu-transport', { iceParameters: transport.iceParameters });
 *   });
 */
'use strict';

const { WebRTCError } = require('../../errors');

/**
 * Base class every SFU adapter inherits from.  Subclasses MUST override
 * every async method; the default implementations throw
 * `WEBRTC_SFU_NOT_IMPLEMENTED` so partial adapters fail loudly.
 *
 *   The interface is intentionally tiny so a backend can be written in a
 *   single file:
 *
 * @example | Skeleton adapter
 *   class MyAdapter extends SfuAdapter {
 *       async createRouter(opts)            { return { id: cuid(), opts }; }
 *       async createTransport(router, peer) { return { id: cuid(), router, peer }; }
 *       async produce(transport, kind, rtp) {
 *           const id = cuid();
 *           this._emit('producer-new', { id, kind, transportId: transport.id });
 *           return { id, kind };
 *       }
 *       async consume(transport, producerId, _rtpCaps) {
 *           return { id: cuid(), producerId, transportId: transport.id };
 *       }
 *       async pauseProducer(id)  { this._emit('producer-pause', { id }); }
 *       async resumeProducer(id) { this._emit('producer-resume', { id }); }
 *       async closeRouter(id)    { this._emit('router-close', { id }); }
 *       async stats(_scope)      { return { ts: Date.now() }; }
 *   }
 *
 * @example | Subscribe to adapter events
 *   const off = sfu.onEvent((event, payload) => {
 *       if (event === 'producer-new')   metrics.producers.inc();
 *       if (event === 'producer-pause') log.info({ id: payload.id }, 'paused');
 *   });
 *   // later: off();
 */
class SfuAdapter
{
    constructor()
    {
        this._handlers = new Set();
    }

    /** Override to create a routing context for a single room. */
    async createRouter(_opts)
    {
        throw new WebRTCError('SfuAdapter.createRouter() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to allocate a WebRTC transport for a peer in a router. */
    async createTransport(_router, _peer)
    {
        throw new WebRTCError('SfuAdapter.createTransport() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to bind a producer ('audio' | 'video') to a transport. */
    async produce(_transport, _kind, _rtpParams)
    {
        throw new WebRTCError('SfuAdapter.produce() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to bind a consumer of `producerId` to a transport. */
    async consume(_transport, _producerId, _rtpCaps)
    {
        throw new WebRTCError('SfuAdapter.consume() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to pause a producer (mute upstream forwarding). */
    async pauseProducer(_producerId)
    {
        throw new WebRTCError('SfuAdapter.pauseProducer() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to resume a previously paused producer. */
    async resumeProducer(_producerId)
    {
        throw new WebRTCError('SfuAdapter.resumeProducer() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to close a router and cascade-close its transports. */
    async closeRouter(_routerId)
    {
        throw new WebRTCError('SfuAdapter.closeRouter() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /** Override to return adapter stats; `scope` may be a routerId/transportId. */
    async stats(_scope)
    {
        throw new WebRTCError('SfuAdapter.stats() not implemented', { code: 'WEBRTC_SFU_NOT_IMPLEMENTED' });
    }

    /**
     * Register a handler invoked as `(event, payload)` for adapter-level
     * events ('producer-new', 'producer-pause', 'consumer-new',
     * 'transport-close', 'router-close', etc.).
     *
     * Returns an unsubscribe function.
     */
    onEvent(handler)
    {
        if (typeof handler !== 'function')
        {
            throw new WebRTCError('onEvent() handler must be a function', { code: 'WEBRTC_SFU_INVALID_HANDLER' });
        }
        this._handlers.add(handler);
        return () => this._handlers.delete(handler);
    }

    /** Emit `event` with `payload` to every registered handler. */
    _emit(event, payload)
    {
        for (const fn of this._handlers)
        {
            try { fn(event, payload); }
            catch (_) { /* swallow handler errors so adapters keep running */ }
        }
    }
}

/**
 * Lazy-load and instantiate an SFU adapter.
 *
 * @param {object|string} spec - one of:
 *   - an object exposing the SfuAdapter contract (returned as-is),
 *   - 'memory' | 'mediasoup' | 'livekit' | adapter package id.
 * @param {object} [opts] - constructor options forwarded to the adapter.
 * @returns {SfuAdapter}
 *
 * @example | Built-in adapter by name
 *   const sfu = loadSfuAdapter('mediasoup', {
 *       numWorkers: 4,
 *       workerSettings: { rtcMinPort: 40000, rtcMaxPort: 49999 },
 *   });
 *
 * @example | Pre-constructed instance (e.g. shared singleton in tests)
 *   const fake = new MemorySfuAdapter();
 *   const sfu  = loadSfuAdapter(fake);
 *   expect(sfu).toBe(fake);
 *
 * @example | Third-party adapter package
 *   //   npm i @acme/zero-server-sfu-janus
 *   const sfu = loadSfuAdapter('@acme/zero-server-sfu-janus', { wsUrl: 'ws://janus/ws' });
 */
function loadSfuAdapter(spec, opts)
{
    if (spec && typeof spec === 'object' && typeof spec.createRouter === 'function')
    {
        return spec;
    }
    if (typeof spec !== 'string' || spec.length === 0)
    {
        throw new WebRTCError(
            'loadSfuAdapter() requires an adapter instance or a name (memory|mediasoup|livekit|<package>)',
            { code: 'WEBRTC_SFU_INVALID_SPEC' },
        );
    }

    if (spec === 'memory')
    {
        const { MemorySfuAdapter } = require('./memory');
        return new MemorySfuAdapter(opts);
    }
    if (spec === 'mediasoup')
    {
        const Ctor = _tryRequireAdapter('./mediasoup', 'mediasoup');
        return new Ctor(opts);
    }
    if (spec === 'livekit')
    {
        const Ctor = _tryRequireAdapter('./livekit', 'livekit-server-sdk');
        return new Ctor(opts);
    }

    // External adapter package - must export `default` or a class.
    let mod;
    try { mod = require(spec); }
    catch (err)
    {
        throw new WebRTCError(
            `SFU adapter package '${spec}' is not installed: ${err.message}`,
            { code: 'WEBRTC_SFU_NOT_INSTALLED', cause: err },
        );
    }
    const Ctor = mod && (mod.default || mod);
    if (typeof Ctor !== 'function')
    {
        throw new WebRTCError(
            `SFU adapter package '${spec}' does not export a class or default constructor`,
            { code: 'WEBRTC_SFU_INVALID_PACKAGE' },
        );
    }
    return new Ctor(opts);
}

/**
 * @private
 * Try to load a built-in adapter module; surface a clean install message
 * when the wrapped peerDependency is missing.
 */
function _tryRequireAdapter(localPath, peerPkg)
{
    let mod;
    try { mod = require(localPath); }
    catch (err)
    {
        throw new WebRTCError(
            `SFU adapter '${peerPkg}' requires the '${peerPkg}' peerDependency: npm install ${peerPkg}`,
            { code: 'WEBRTC_SFU_NOT_INSTALLED', cause: err },
        );
    }
    // The wrapper itself tries `require(peerPkg)`; rethrow with the install
    // hint if construction fails for that reason.
    const Ctor = mod && (mod.default || Object.values(mod).find((v) => typeof v === 'function'));
    if (typeof Ctor !== 'function')
    {
        throw new WebRTCError(
            `SFU adapter module '${localPath}' did not export a constructor`,
            { code: 'WEBRTC_SFU_INVALID_ADAPTER' },
        );
    }
    return Ctor;
}

module.exports = { SfuAdapter, loadSfuAdapter };
