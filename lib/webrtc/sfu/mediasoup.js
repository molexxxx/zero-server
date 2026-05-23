/**
 * @module webrtc/sfu/mediasoup
 * @description mediasoup-backed SFU adapter (peerDependency on `mediasoup`).
 *
 *   Wraps a single mediasoup `Worker` and one `Router` per `createRouter()`
 *   call.  WebRTC transports are created with `router.createWebRtcTransport()`
 *   and produce / consume / pause / resume / close / stats all delegate to
 *   the native mediasoup objects.  Adapter-level events (`router-new`,
 *   `producer-new`, `consumer-new`, `producer-pause`, `producer-resume`,
 *   `transport-close`, `router-close`) are fanned out via
 *   {@link SfuAdapter#onEvent} so observability is uniform across adapters.
 *
 *   `mediasoup` is loaded lazily.  Tests inject a stub via `opts.mediasoup`;
 *   in production the constructor `require('mediasoup')`s the real package
 *   and throws `WEBRTC_SFU_NOT_INSTALLED` if it is missing.
 *
 * @example | Production setup with custom RTP port range and announced IP
 *   //   npm install mediasoup
 *   const { MediasoupSfuAdapter } = require('@zero-server/webrtc');
 *
 *   const sfu = new MediasoupSfuAdapter({
 *       workerSettings: {
 *           logLevel:   'warn',
 *           rtcMinPort: 40000,
 *           rtcMaxPort: 49999,
 *       },
 *       webRtcTransportOptions: {
 *           listenIps:  [{ ip: '0.0.0.0', announcedIp: process.env.PUBLIC_IP }],
 *           enableUdp:  true,
 *           enableTcp:  true,
 *           preferUdp:  true,
 *           initialAvailableOutgoingBitrate: 800_000,
 *       },
 *   });
 *
 * @example | One router per room, lazy on first join
 *   const routersByRoom = new Map();
 *
 *   async function getRouter(roomName) {
 *       let r = routersByRoom.get(roomName);
 *       if (!r) {
 *           r = await sfu.createRouter({ room: roomName });
 *           routersByRoom.set(roomName, r);
 *       }
 *       return r;
 *   }
 *
 *   hub.on('join', async ({ peer, room }) => {
 *       const router    = await getRouter(room.name);
 *       const transport = await sfu.createTransport(router, peer);
 *       peer.send('sfu-ready', { transportId: transport.id });
 *   });
 *
 * @example | Inject a stub for unit tests
 *   const stubMediasoup = {
 *       createWorker: async () => ({
 *           createRouter: async () => fakeRouter,
 *           close: () => {},
 *       }),
 *   };
 *   const sfu = new MediasoupSfuAdapter({ mediasoup: stubMediasoup });
 */
'use strict';

const { SfuAdapter } = require('./index');
const { WebRTCError } = require('../../errors');

const DEFAULT_MEDIA_CODECS = [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8',  clockRate: 90000 },
];

const DEFAULT_WEBRTC_TRANSPORT_OPTS = {
    listenIps:  [{ ip: '0.0.0.0', announcedIp: null }],
    enableUdp:  true,
    enableTcp:  true,
    preferUdp:  true,
};

class MediasoupSfuAdapter extends SfuAdapter
{
    /**
     * @param {object} [opts]
     * @param {object} [opts.mediasoup]              Injected mediasoup module (testing); defaults to `require('mediasoup')`.
     * @param {object} [opts.worker]                 Pre-created `mediasoup.Worker`; bypasses the lazy worker bootstrap.
     * @param {object} [opts.workerSettings]         Forwarded to `mediasoup.createWorker(...)`.
     * @param {Array}  [opts.mediaCodecs]            Default router media codecs.
     * @param {object} [opts.webRtcTransportOptions] Default `router.createWebRtcTransport(...)` options.
     */
    constructor(opts)
    {
        super();
        const o = opts || {};

        this._mediasoup = o.mediasoup || _tryRequireMediasoup();
        this._workerSettings    = o.workerSettings    || {};
        this._mediaCodecs       = o.mediaCodecs       || DEFAULT_MEDIA_CODECS;
        this._webRtcTransportOpts = o.webRtcTransportOptions || DEFAULT_WEBRTC_TRANSPORT_OPTS;
        this._worker            = o.worker || null;
        this._workerPromise     = null;

        this._routers    = new Map(); // routerId    -> native router
        this._transports = new Map(); // transportId -> native transport
        this._producers  = new Map(); // producerId  -> native producer
        this._consumers  = new Map(); // consumerId  -> native consumer
        this._routerOf   = new Map(); // transportId -> routerId
    }

    /**
     * Lazily create (or return) the single shared mediasoup Worker.
     * Returns the native Worker handle.
     */
    async _ensureWorker()
    {
        if (this._worker) return this._worker;
        if (!this._workerPromise)
        {
            this._workerPromise = Promise.resolve(this._mediasoup.createWorker(this._workerSettings))
                .then((w) =>
                {
                    this._worker = w;
                    if (typeof w.on === 'function')
                    {
                        w.on('died', (err) => this._emit('worker-died', { error: err && err.message }));
                    }
                    return w;
                });
        }
        return this._workerPromise;
    }

    async createRouter(opts)
    {
        const worker = await this._ensureWorker();
        const mediaCodecs = (opts && opts.mediaCodecs) || this._mediaCodecs;
        const router = await worker.createRouter({ mediaCodecs });
        this._routers.set(router.id, router);
        if (typeof router.observer === 'object' && router.observer && typeof router.observer.on === 'function')
        {
            router.observer.on('close', () =>
            {
                this._routers.delete(router.id);
                this._emit('router-close', { routerId: router.id });
            });
        }
        this._emit('router-new', { routerId: router.id });
        return {
            id:                 router.id,
            routerId:           router.id,
            rtpCapabilities:    router.rtpCapabilities,
            _native:            router,
        };
    }

    async createTransport(router, peer)
    {
        const routerId = router && router.id;
        const native = routerId && this._routers.get(routerId);
        if (!native)
        {
            throw new WebRTCError('createTransport: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const transport = await native.createWebRtcTransport({
            ...this._webRtcTransportOpts,
            appData: { peer: peer || null },
        });
        this._transports.set(transport.id, transport);
        this._routerOf.set(transport.id, routerId);
        if (typeof transport.observer === 'object' && transport.observer && typeof transport.observer.on === 'function')
        {
            transport.observer.on('close', () =>
            {
                this._transports.delete(transport.id);
                this._routerOf.delete(transport.id);
                this._emit('transport-close', { transportId: transport.id });
            });
        }
        this._emit('transport-new', { transportId: transport.id, routerId, peerId: peer && peer.id });
        return {
            id:              transport.id,
            transportId:     transport.id,
            routerId,
            peer:            peer || null,
            iceParameters:   transport.iceParameters,
            iceCandidates:   transport.iceCandidates,
            dtlsParameters:  transport.dtlsParameters,
            sctpParameters:  transport.sctpParameters || null,
            _native:         transport,
        };
    }

    async produce(transport, kind, rtpParameters)
    {
        if (kind !== 'audio' && kind !== 'video')
        {
            throw new WebRTCError('produce: kind must be "audio" or "video"', { code: 'WEBRTC_SFU_INVALID_KIND' });
        }
        const native = transport && this._transports.get(transport.id);
        if (!native)
        {
            throw new WebRTCError('produce: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const producer = await native.produce({ kind, rtpParameters });
        this._producers.set(producer.id, producer);
        if (typeof producer.on === 'function')
        {
            producer.on('transportclose', () =>
            {
                this._producers.delete(producer.id);
                this._emit('producer-close', { producerId: producer.id, reason: 'transport-close' });
            });
        }
        this._emit('producer-new', { producerId: producer.id, transportId: transport.id, kind });
        return {
            id:           producer.id,
            producerId:   producer.id,
            transportId:  transport.id,
            kind,
            rtpParameters,
            paused:       !!producer.paused,
            _native:      producer,
        };
    }

    async consume(transport, producerId, rtpCapabilities)
    {
        const native = transport && this._transports.get(transport.id);
        if (!native)
        {
            throw new WebRTCError('consume: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const routerId = this._routerOf.get(transport.id);
        const router   = routerId && this._routers.get(routerId);
        if (router && typeof router.canConsume === 'function'
            && !router.canConsume({ producerId, rtpCapabilities }))
        {
            throw new WebRTCError('consume: router cannot consume producer with given rtpCapabilities',
                { code: 'WEBRTC_SFU_CANNOT_CONSUME' });
        }
        let consumer;
        try
        {
            consumer = await native.consume({ producerId, rtpCapabilities });
        }
        catch (err)
        {
            throw new WebRTCError(`consume failed: ${err.message}`, { code: 'WEBRTC_SFU_CONSUME_FAILED', cause: err });
        }
        this._consumers.set(consumer.id, consumer);
        if (typeof consumer.on === 'function')
        {
            consumer.on('transportclose', () =>
            {
                this._consumers.delete(consumer.id);
                this._emit('consumer-close', { consumerId: consumer.id, reason: 'transport-close' });
            });
            consumer.on('producerclose', () =>
            {
                this._consumers.delete(consumer.id);
                this._emit('consumer-close', { consumerId: consumer.id, reason: 'producer-close' });
            });
        }
        this._emit('consumer-new', { consumerId: consumer.id, transportId: transport.id, producerId });
        return {
            id:            consumer.id,
            consumerId:    consumer.id,
            transportId:   transport.id,
            producerId,
            kind:          consumer.kind,
            rtpParameters: consumer.rtpParameters,
            rtpCapabilities,
            _native:       consumer,
        };
    }

    async pauseProducer(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p)
        {
            throw new WebRTCError('pauseProducer: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        await p.pause();
        this._emit('producer-pause', { producerId });
    }

    async resumeProducer(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p)
        {
            throw new WebRTCError('resumeProducer: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        await p.resume();
        this._emit('producer-resume', { producerId });
    }

    async closeRouter(routerId)
    {
        const r = this._routers.get(routerId);
        if (!r) return;
        // Native router.close() cascades to its transports; the observer
        // 'close' handlers we registered in createTransport/createRouter
        // emit transport-close / router-close events for us.  Avoid
        // emitting here to prevent duplicates.
        await r.close();
    }

    async stats(scope)
    {
        if (scope && this._routers.has(scope))
        {
            const r = this._routers.get(scope);
            const native = typeof r.getStats === 'function' ? await r.getStats() : null;
            return { kind: 'router', routerId: scope, native };
        }
        if (scope && this._transports.has(scope))
        {
            const t = this._transports.get(scope);
            const native = typeof t.getStats === 'function' ? await t.getStats() : null;
            return { kind: 'transport', transportId: scope, routerId: this._routerOf.get(scope), native };
        }
        return {
            kind:       'global',
            routers:    this._routers.size,
            transports: this._transports.size,
            producers:  this._producers.size,
            consumers:  this._consumers.size,
        };
    }

    /**
     * Best-effort shutdown: closes every router, then the worker if we own it.
     */
    async close()
    {
        for (const id of [...this._routers.keys()])
        {
            try { await this.closeRouter(id); } catch (_) { /* swallow */ }
        }
        if (this._worker && typeof this._worker.close === 'function')
        {
            try { await this._worker.close(); } catch (_) { /* swallow */ }
        }
        this._worker = null;
        this._workerPromise = null;
    }
}

/**
 * @private
 * Try to `require('mediasoup')`; throw a clean install hint when missing.
 */
function _tryRequireMediasoup()
{
    try { return require('mediasoup'); }
    catch (err)
    {
        throw new WebRTCError(
            "SFU adapter 'mediasoup' requires the 'mediasoup' peerDependency: npm install mediasoup",
            { code: 'WEBRTC_SFU_NOT_INSTALLED', cause: err },
        );
    }
}

module.exports = { MediasoupSfuAdapter };
