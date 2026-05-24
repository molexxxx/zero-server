/**
 * @module webrtc/sfu/mediasoup
 * @description mediasoup-backed SFU adapter (peerDependency on
 *   `mediasoup`). Wraps a `Worker` plus one `Router` per `createRouter()`
 *   call and delegates produce/consume/pause/resume/close/stats to the
 *   native objects. Adapter events are uniform via `onEvent`.
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

const DEFAULT_VIDEO_RTCP_FB = [
    { type: 'nack' },
    { type: 'nack', parameter: 'pli' },
    { type: 'ccm',  parameter: 'fir' },
    { type: 'goog-remb' },
    { type: 'transport-cc' },
];

const DEFAULT_MEDIA_CODECS = [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    {
        kind:                 'video',
        mimeType:             'video/VP8',
        clockRate:            90000,
        rtcpFeedback:         DEFAULT_VIDEO_RTCP_FB,
        parameters:           { 'x-google-start-bitrate': 1000 },
    },
    {
        kind:                 'video',
        mimeType:             'video/VP9',
        clockRate:            90000,
        rtcpFeedback:         DEFAULT_VIDEO_RTCP_FB,
        parameters:           { 'profile-id': 2, 'x-google-start-bitrate': 1000 },
    },
    {
        kind:                 'video',
        mimeType:             'video/H264',
        clockRate:            90000,
        rtcpFeedback:         DEFAULT_VIDEO_RTCP_FB,
        parameters:           {
            'packetization-mode':      1,
            'profile-level-id':        '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate':  1000,
        },
    },
    {
        kind:                 'video',
        mimeType:             'video/AV1',
        clockRate:            90000,
        rtcpFeedback:         DEFAULT_VIDEO_RTCP_FB,
        parameters:           { 'profile': 0, 'level-idx': 5, 'tier': 0 },
    },
];

const DEFAULT_WEBRTC_TRANSPORT_OPTS = {
    listenIps:  [{ ip: '0.0.0.0', announcedIp: null }],
    enableUdp:  true,
    enableTcp:  true,
    preferUdp:  true,
    initialAvailableOutgoingBitrate: 1000000,
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
     * @param {object} [opts.webRtcServer]           Pre-created `WebRtcServer` to share a single UDP/TCP port across workers (k8s / single-IP).
     * @param {object} [opts.webRtcServerOptions]    `{ listenInfos: [...] }` forwarded to `worker.createWebRtcServer(...)` on first use.
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
        this._webRtcServer      = o.webRtcServer || null;
        this._webRtcServerOpts  = o.webRtcServerOptions || null;
        this._webRtcServerPromise = null;

        this._routers      = new Map(); // routerId    -> native router
        this._transports   = new Map(); // transportId -> native transport
        this._producers    = new Map(); // producerId  -> native producer
        this._consumers    = new Map(); // consumerId  -> native consumer
        this._dataProducers = new Map(); // dataProducerId -> native dataProducer
        this._dataConsumers = new Map(); // dataConsumerId -> native dataConsumer
        this._observers    = new Map(); // observerId  -> { id, kind, native, routerId }
        this._pipes        = new Map(); // pipeId      -> { producerId, pipeProducerId, pipeConsumerId, localRouterId, remoteRouterId }
        this._routerOf     = new Map(); // transportId -> routerId
        this._idSeq        = 0;
    }

    _nextId(prefix)
    {
        this._idSeq += 1;
        return `${prefix}-${this._idSeq}`;
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

    async _ensureWebRtcServer(worker)
    {
        if (this._webRtcServer) return this._webRtcServer;
        if (!this._webRtcServerOpts) return null;
        if (typeof worker.createWebRtcServer !== 'function') return null;
        if (!this._webRtcServerPromise)
        {
            this._webRtcServerPromise = Promise.resolve(worker.createWebRtcServer(this._webRtcServerOpts))
                .then((s) => { this._webRtcServer = s; return s; });
        }
        return this._webRtcServerPromise;
    }

    async createRouter(opts)
    {
        const worker = await this._ensureWorker();
        await this._ensureWebRtcServer(worker);
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
        const baseOpts = { ...this._webRtcTransportOpts, appData: { peer: peer || null } };
        // If a WebRtcServer is mounted, route the transport through it so
        // every peer shares one UDP/TCP port (single-IP/k8s deployments).
        if (this._webRtcServer && !baseOpts.webRtcServer)
        {
            baseOpts.webRtcServer = this._webRtcServer;
            delete baseOpts.listenIps;
            delete baseOpts.listenInfos;
        }
        const transport = await native.createWebRtcTransport(baseOpts);
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
        if (typeof transport.on === 'function')
        {
            transport.on('icestatechange', (state) =>
                this._emit('transport-ice-state', { transportId: transport.id, state }));
            transport.on('dtlsstatechange', (state) =>
                this._emit('transport-dtls-state', { transportId: transport.id, state }));
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

    async produce(transport, kind, rtpParameters, produceOpts)
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
        // Honor caller-supplied simulcast / SVC config.  Either pass a
        // 4th arg `{ encodings, keyFrameRequestDelay, paused }` or stash
        // it on `rtpParameters.encodings` directly.
        const o = produceOpts || {};
        const params = { ...rtpParameters };
        if (Array.isArray(o.encodings) && !params.encodings)
            params.encodings = o.encodings;
        const produceArgs = { kind, rtpParameters: params };
        if (o.keyFrameRequestDelay) produceArgs.keyFrameRequestDelay = o.keyFrameRequestDelay;
        if (typeof o.paused === 'boolean') produceArgs.paused = o.paused;
        if (o.appData) produceArgs.appData = o.appData;
        const producer = await native.produce(produceArgs);
        this._producers.set(producer.id, producer);
        if (typeof producer.on === 'function')
        {
            producer.on('transportclose', () =>
            {
                this._producers.delete(producer.id);
                this._emit('producer-close', { producerId: producer.id, reason: 'transport-close' });
            });
            producer.on('score', (score) =>
                this._emit('producer-score', { producerId: producer.id, score }));
            producer.on('videoorientationchange', (orientation) =>
                this._emit('producer-orientation', { producerId: producer.id, orientation }));
            producer.on('trace', (trace) =>
                this._emit('producer-trace', { producerId: producer.id, trace }));
        }
        this._emit('producer-new', { producerId: producer.id, transportId: transport.id, kind });
        return {
            id:           producer.id,
            producerId:   producer.id,
            transportId:  transport.id,
            kind,
            rtpParameters: params,
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
            consumer.on('producerpause',  () => this._emit('consumer-producer-pause',  { consumerId: consumer.id }));
            consumer.on('producerresume', () => this._emit('consumer-producer-resume', { consumerId: consumer.id }));
            consumer.on('score',          (score) => this._emit('consumer-score',  { consumerId: consumer.id, score }));
            consumer.on('layerschange',   (layers) => this._emit('consumer-layers-change', { consumerId: consumer.id, layers }));
            consumer.on('trace',          (trace) => this._emit('consumer-trace',  { consumerId: consumer.id, trace }));
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
        if (this._webRtcServer && typeof this._webRtcServer.close === 'function')
        {
            try { await this._webRtcServer.close(); } catch (_) { /* swallow */ }
        }
        if (this._worker && typeof this._worker.close === 'function')
        {
            try { await this._worker.close(); } catch (_) { /* swallow */ }
        }
        this._worker = null;
        this._workerPromise = null;
        this._webRtcServer = null;
        this._webRtcServerPromise = null;
    }

    // ----- Consumer-side BWE / quality controls -----

    async setConsumerPreferredLayers(consumerId, layers)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
        {
            throw new WebRTCError('setConsumerPreferredLayers: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        if (!layers || typeof layers.spatialLayer !== 'number')
        {
            throw new WebRTCError('setConsumerPreferredLayers: layers.spatialLayer must be a number', { code: 'WEBRTC_SFU_INVALID_LAYERS' });
        }
        await c.setPreferredLayers({
            spatialLayer:  layers.spatialLayer,
            temporalLayer: typeof layers.temporalLayer === 'number' ? layers.temporalLayer : undefined,
        });
    }

    async setConsumerPriority(consumerId, priority)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
        {
            throw new WebRTCError('setConsumerPriority: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        const p = Number(priority);
        if (!Number.isFinite(p) || p < 1 || p > 255)
        {
            throw new WebRTCError('setConsumerPriority: priority must be 1..255', { code: 'WEBRTC_SFU_INVALID_PRIORITY' });
        }
        await c.setPriority(p);
    }

    async requestKeyFrame(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
        {
            throw new WebRTCError('requestKeyFrame: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        if (typeof c.requestKeyFrame === 'function') await c.requestKeyFrame();
    }

    async pauseConsumer(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
        {
            throw new WebRTCError('pauseConsumer: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        await c.pause();
        this._emit('consumer-pause', { consumerId });
    }

    async resumeConsumer(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
        {
            throw new WebRTCError('resumeConsumer: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        await c.resume();
        this._emit('consumer-resume', { consumerId });
    }

    // ----- Transport bitrate clamps -----

    async setTransportBitrates(transportId, opts)
    {
        const t = this._transports.get(transportId);
        if (!t)
        {
            throw new WebRTCError('setTransportBitrates: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const o = opts || {};
        if (Number.isFinite(o.maxIncoming) && typeof t.setMaxIncomingBitrate === 'function')
            await t.setMaxIncomingBitrate(o.maxIncoming);
        if (Number.isFinite(o.maxOutgoing) && typeof t.setMaxOutgoingBitrate === 'function')
            await t.setMaxOutgoingBitrate(o.maxOutgoing);
        if (Number.isFinite(o.min) && typeof t.setMinOutgoingBitrate === 'function')
            await t.setMinOutgoingBitrate(o.min);
        this._emit('transport-bitrates', { transportId, bitrates: o });
    }

    // ----- SCTP data channels -----

    async produceData(transport, opts)
    {
        const native = transport && this._transports.get(transport.id);
        if (!native)
        {
            throw new WebRTCError('produceData: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const o = opts || {};
        const dp = await native.produceData({
            label:    o.label    || '',
            protocol: o.protocol || '',
            ordered:  o.ordered !== false,
            sctpStreamParameters: o.sctpStreamParameters,
        });
        this._dataProducers.set(dp.id, dp);
        if (typeof dp.on === 'function')
        {
            dp.on('transportclose', () =>
            {
                this._dataProducers.delete(dp.id);
                this._emit('data-producer-close', { dataProducerId: dp.id });
            });
        }
        this._emit('data-producer-new', { dataProducerId: dp.id, transportId: transport.id, label: o.label || '' });
        return {
            id:               dp.id,
            dataProducerId:   dp.id,
            transportId:      transport.id,
            label:            dp.label || o.label || '',
            protocol:         dp.protocol || o.protocol || '',
            ordered:          dp.sctpStreamParameters ? !!dp.sctpStreamParameters.ordered : (o.ordered !== false),
            _native:          dp,
        };
    }

    async consumeData(transport, dataProducerId, opts)
    {
        const native = transport && this._transports.get(transport.id);
        if (!native)
        {
            throw new WebRTCError('consumeData: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        const o = opts || {};
        const dc = await native.consumeData({
            dataProducerId,
            ordered: o.ordered,
        });
        this._dataConsumers.set(dc.id, dc);
        if (typeof dc.on === 'function')
        {
            dc.on('transportclose', () =>
            {
                this._dataConsumers.delete(dc.id);
                this._emit('data-consumer-close', { dataConsumerId: dc.id });
            });
            dc.on('dataproducerclose', () =>
            {
                this._dataConsumers.delete(dc.id);
                this._emit('data-consumer-close', { dataConsumerId: dc.id, reason: 'data-producer-close' });
            });
        }
        this._emit('data-consumer-new', { dataConsumerId: dc.id, transportId: transport.id, dataProducerId });
        return {
            id:               dc.id,
            dataConsumerId:   dc.id,
            transportId:      transport.id,
            dataProducerId,
            label:            dc.label || '',
            protocol:         dc.protocol || '',
            ordered:          dc.sctpStreamParameters ? !!dc.sctpStreamParameters.ordered : true,
            _native:          dc,
        };
    }

    // ----- Observers -----

    async observeAudioLevels(routerId, opts)
    {
        const r = this._routers.get(routerId);
        if (!r)
        {
            throw new WebRTCError('observeAudioLevels: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const o = opts || {};
        const native = await r.createAudioLevelObserver({
            interval:   o.interval   || 1000,
            threshold:  o.threshold  || -80,
            maxEntries: o.maxEntries || 1,
        });
        const id = this._nextId('audioObserver');
        const handle = {
            id,
            kind:     'audio-level',
            routerId,
            _native:  native,
            close:    async () =>
            {
                if (handle.closed) return;
                handle.closed = true;
                if (typeof native.close === 'function') try { await native.close(); } catch (_) { /* swallow */ }
                this._observers.delete(id);
                this._emit('observer-close', { observerId: id, kind: 'audio-level' });
            },
            emit:     (levels) =>
            {
                if (handle.closed) return;
                this._emit('audio-level', { observerId: id, routerId, levels });
            },
            closed:   false,
        };
        if (typeof native.on === 'function')
        {
            native.on('volumes', (volumes) =>
                this._emit('audio-level', { observerId: id, routerId, levels: volumes }));
            native.on('silence', () =>
                this._emit('audio-silence', { observerId: id, routerId }));
        }
        this._observers.set(id, handle);
        this._emit('observer-new', { observerId: id, kind: 'audio-level', routerId });
        return handle;
    }

    async observeActiveSpeaker(routerId, opts)
    {
        const r = this._routers.get(routerId);
        if (!r)
        {
            throw new WebRTCError('observeActiveSpeaker: unknown router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        const o = opts || {};
        const native = await r.createActiveSpeakerObserver({
            interval: o.interval || 300,
        });
        const id = this._nextId('speakerObserver');
        const handle = {
            id,
            kind:    'active-speaker',
            routerId,
            _native: native,
            close:   async () =>
            {
                if (handle.closed) return;
                handle.closed = true;
                if (typeof native.close === 'function') try { await native.close(); } catch (_) { /* swallow */ }
                this._observers.delete(id);
                this._emit('observer-close', { observerId: id, kind: 'active-speaker' });
            },
            emit:    (producerId) =>
            {
                if (handle.closed) return;
                this._emit('active-speaker', { observerId: id, routerId, producerId });
            },
            closed:  false,
        };
        if (typeof native.on === 'function')
        {
            native.on('dominantspeaker', (ev) =>
                this._emit('active-speaker', { observerId: id, routerId, producerId: ev && ev.producer && ev.producer.id }));
        }
        this._observers.set(id, handle);
        this._emit('observer-new', { observerId: id, kind: 'active-speaker', routerId });
        return handle;
    }

    // ----- Cross-router pipe (cascade hop / same-host fanout) -----

    async pipeToRouter(opts)
    {
        const o = opts || {};
        const prod = this._producers.get(o.producerId);
        if (!prod)
        {
            throw new WebRTCError('pipeToRouter: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        const local = this._routers.get(o.localRouterId);
        if (!local)
        {
            throw new WebRTCError('pipeToRouter: unknown local router', { code: 'WEBRTC_SFU_NO_ROUTER' });
        }
        if (!o.remoteRouter)
        {
            throw new WebRTCError('pipeToRouter: opts.remoteRouter is required', { code: 'WEBRTC_SFU_INVALID_PIPE' });
        }
        // mediasoup supports both `router.pipeToRouter()` (native, in-process) and the
        // manual PipeTransport handshake for cross-process / cross-host pipes.
        const remoteNative = o.remoteRouter._native || o.remoteRouter;
        const result = await local.pipeToRouter({
            producerId: o.producerId,
            router:     remoteNative,
            listenInfo: o.listenInfo,
            enableSrtp: o.enableSrtp,
        });
        const id = this._nextId('pipe');
        const handle = {
            id,
            pipeId:          id,
            producerId:      o.producerId,
            localRouterId:   o.localRouterId,
            remoteRouterId:  o.remoteRouter.id || o.remoteRouter.routerId,
            pipeProducerId:  result && result.pipeProducer && result.pipeProducer.id,
            pipeConsumerId:  result && result.pipeConsumer && result.pipeConsumer.id,
            _native:         result,
        };
        this._pipes.set(id, handle);
        this._emit('pipe-open', handle);
        return handle;
    }

    // ----- Per-entity stats -----

    async getProducerStats(producerId)
    {
        const p = this._producers.get(producerId);
        if (!p)
        {
            throw new WebRTCError('getProducerStats: unknown producer', { code: 'WEBRTC_SFU_NO_PRODUCER' });
        }
        return typeof p.getStats === 'function' ? p.getStats() : [];
    }

    async getConsumerStats(consumerId)
    {
        const c = this._consumers.get(consumerId);
        if (!c)
        {
            throw new WebRTCError('getConsumerStats: unknown consumer', { code: 'WEBRTC_SFU_NO_CONSUMER' });
        }
        return typeof c.getStats === 'function' ? c.getStats() : [];
    }

    async getTransportStats(transportId)
    {
        const t = this._transports.get(transportId);
        if (!t)
        {
            throw new WebRTCError('getTransportStats: unknown transport', { code: 'WEBRTC_SFU_NO_TRANSPORT' });
        }
        return typeof t.getStats === 'function' ? t.getStats() : [];
    }

    // ----- RTP/RTCP trace -----

    async enableTraceEvent(routerId, types)
    {
        const list = Array.isArray(types) ? types : [];
        // mediasoup trace events live on transport/producer/consumer, not router.
        // Apply to every entity bound to the given router so a caller can
        // flip trace at a coarse "this room please" granularity.
        const targets = [];
        for (const [tid, t] of this._transports)
        {
            if (this._routerOf.get(tid) === routerId && typeof t.enableTraceEvent === 'function')
                targets.push(t);
        }
        for (const p of this._producers.values())
        {
            if (typeof p.enableTraceEvent === 'function'
                && this._routerOf.get(p.transportId || (p._appData && p._appData.transportId)) === routerId)
                targets.push(p);
        }
        for (const c of this._consumers.values())
        {
            if (typeof c.enableTraceEvent === 'function'
                && this._routerOf.get(c.transportId || (c._appData && c._appData.transportId)) === routerId)
                targets.push(c);
        }
        await Promise.all(targets.map((x) => x.enableTraceEvent(list)));
        this._emit('trace-enabled', { routerId, types: list });
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
