/**
 * @module webrtc/recording
 * @description Adapter-agnostic recording / egress / ingress facade.
 *   {@link RecordingManager} auto-detects which pipeline the bound
 *   {@link SfuAdapter} supports (`livekit` egress, `ffmpeg` child, or
 *   `memory` bookkeeping) and exposes a uniform `startRecording` /
 *   `stopRecording` surface. {@link IngressManager} wraps the adapter's
 *   `createIngress` / `deleteIngress` calls for WHIP / RTMP / SIP /
 *   URL-pull sources.
 *
 * @example | Auto-pipeline recording on top of any adapter
 *   const rec = new RecordingManager({ adapter: hub.sfu });
 *   const { id, stop } = await rec.startRecording('lobby', {
 *       layout: 'grid',
 *       format: 'mp4',
 *       sink:   { file: '/var/recordings/lobby.mp4' },
 *   });
 *   // later
 *   await stop();
 *
 * @example | Force the ffmpeg pipeline
 *   const rec = new RecordingManager({ adapter: hub.sfu, ffmpegPath: '/usr/bin/ffmpeg' });
 *   await rec.startRecording('lobby', {
 *       pipeline: 'ffmpeg',
 *       inputs:   [{ sdp: '/tmp/in.sdp' }],
 *       sink:     { file: '/tmp/out.mp4' },
 *   });
 *
 * @example | Create a WHIP ingress and route it into a room
 *   const ing = new IngressManager({ adapter: hub.sfu });
 *   const stream = await ing.createIngress({ kind: 'whip', name: 'studio', roomName: 'lobby' });
 *   // publish using stream.native.url
 */

'use strict';

const { WebRTCError } = require('../errors');

/** @typedef {'mp4'|'webm'|'mka'|'ogg'|'hls'} RecordingFormat */
/** @typedef {'grid'|'presenter'|'presenter-strip'|'dominant'|'speaker'|'audio-only'} RecordingLayout */

// --- RecordingManager ---

/**
 * Adapter-agnostic recording facade. Pipeline auto-resolves from
 * `adapter.startRoomCompositeEgress` (LiveKit) → `livekit`; fall back is
 * `memory` (bookkeeping only). Pass `pipeline: 'ffmpeg'` to spawn ffmpeg
 * children.
 *
 * @class
 * @section Recording
 */
class RecordingManager
{
    /**
     * @constructor
     * @param {object} opts
     * @param {object} opts.adapter   - SfuAdapter (or anything exposing egress methods).
     * @param {Function} [opts.spawn] - For `pipeline: 'ffmpeg'` (defaults to `child_process.spawn`).
     * @param {string}   [opts.ffmpegPath]
     */
    constructor(opts)
    {
        const o = opts || {};
        if (!o.adapter) throw new WebRTCError('RecordingManager requires { adapter }', { code: 'WEBRTC_RECORDING_NO_ADAPTER' });
        this.adapter     = o.adapter;
        this._spawn      = o.spawn || null;
        this._ffmpegPath = o.ffmpegPath || null;
        this._next       = 0;
        /** @type {Map<string, {id:string, roomName:string, kind:string, backend:string, native:object|null, child:object|null, opts:object, status:string, startedAt:number, stoppedAt:number|null}>} */
        this._records    = new Map();
    }

    _id() { return `rec-${++this._next}-${Date.now().toString(36)}`; }

    /**
     * Start a new recording for `roomName`.  The `pipeline` field selects
     * the backend:
     *
     *   - `'livekit'` — call `adapter.startRoomCompositeEgress`.
     *   - `'livekit-track'` — call `adapter.startTrackEgress`.
     *   - `'ffmpeg'` — spawn an ffmpeg child process (requires
     *     `{ ffmpegPath }` or `ffmpeg-static`; caller wires RTP).
     *   - `'memory'` — bookkeeping only (default when no other backend
     *     can be inferred).
     *
     * @param {string} roomName
     * @param {object} [opts]
     * @returns {Promise<{id:string, status:string, stop:Function, info():object}>}
     * @section Recording
     */
    async startRecording(roomName, opts)
    {
        if (!roomName) throw new WebRTCError('startRecording: roomName required', { code: 'WEBRTC_RECORDING_BAD_ARGS' });
        const o = opts || {};
        const pipeline = o.pipeline || this._inferPipeline();
        const id = this._id();
        const entry = {
            id, roomName,
            kind:      o.kind || 'composite',
            backend:   pipeline,
            native:    null,
            child:     null,
            opts:      o,
            status:    'starting',
            startedAt: Date.now(),
            stoppedAt: null,
        };
        this._records.set(id, entry);

        try
        {
            if (pipeline === 'livekit')
            {
                if (typeof this.adapter.startRoomCompositeEgress !== 'function')
                    throw new WebRTCError('adapter does not implement startRoomCompositeEgress', { code: 'WEBRTC_RECORDING_NO_BACKEND' });
                entry.native = await this.adapter.startRoomCompositeEgress(roomName, o);
            }
            else if (pipeline === 'livekit-track')
            {
                if (typeof this.adapter.startTrackEgress !== 'function')
                    throw new WebRTCError('adapter does not implement startTrackEgress', { code: 'WEBRTC_RECORDING_NO_BACKEND' });
                entry.native = await this.adapter.startTrackEgress(roomName, o);
            }
            else if (pipeline === 'ffmpeg')
            {
                entry.child = this._spawnFfmpeg(o);
            }
            else if (pipeline === 'memory')
            {
                /* nothing to do — caller models the cost */
            }
            else
            {
                throw new WebRTCError(`unknown recording pipeline: ${pipeline}`, { code: 'WEBRTC_RECORDING_BAD_PIPELINE' });
            }
            entry.status = 'recording';
        }
        catch (err)
        {
            entry.status = 'failed';
            entry.error  = err && err.message;
            entry.stoppedAt = Date.now();
            throw err;
        }

        return {
            id,
            status: entry.status,
            stop:   () => this.stopRecording(id),
            info:   () => this._snapshot(entry),
        };
    }

    /**
     * Stop an active recording by id.  Idempotent.
     *
     * @param {string} id
     * @returns {Promise<boolean>} true if the recording was stopped here.
     * @section Recording
     */
    async stopRecording(id)
    {
        const entry = this._records.get(id);
        if (!entry) return false;
        if (entry.status === 'stopped' || entry.status === 'failed') return false;
        entry.status = 'stopping';
        try
        {
            if (entry.backend === 'livekit' || entry.backend === 'livekit-track')
            {
                const egressId = entry.native && (entry.native.egressId || entry.native.egress_id || entry.native.id);
                if (egressId && typeof this.adapter.stopEgress === 'function')
                    await this.adapter.stopEgress(egressId);
            }
            else if (entry.backend === 'ffmpeg')
            {
                if (entry.child && typeof entry.child.kill === 'function')
                {
                    try { entry.child.kill('SIGTERM'); } catch { /* swallow */ }
                }
            }
            entry.status    = 'stopped';
            entry.stoppedAt = Date.now();
            return true;
        }
        catch (err)
        {
            entry.status    = 'failed';
            entry.error     = err && err.message;
            entry.stoppedAt = Date.now();
            throw err;
        }
    }

    /**
     * List every recording the manager knows about.
     * @returns {Array<object>}
     * @section Inspection
     */
    list()
    {
        const out = [];
        for (const entry of this._records.values()) out.push(this._snapshot(entry));
        return out;
    }

    /**
     * Aggregate counts for observability.
     * @returns {{recording:number, stopped:number, failed:number, total:number}}
     * @section Inspection
     */
    stats()
    {
        let recording = 0, stopped = 0, failed = 0;
        for (const e of this._records.values())
        {
            if (e.status === 'recording' || e.status === 'starting' || e.status === 'stopping') recording++;
            else if (e.status === 'stopped') stopped++;
            else if (e.status === 'failed')  failed++;
        }
        return { recording, stopped, failed, total: this._records.size };
    }

    /**
     * Stop every active recording.  Safe to call during shutdown.
     * @section Lifecycle
     */
    async close()
    {
        const active = [...this._records.values()].filter((e) => e.status === 'recording' || e.status === 'starting');
        for (const e of active)
        {
            try { await this.stopRecording(e.id); } catch { /* swallow */ }
        }
    }

    /** @private */
    _snapshot(e)
    {
        return {
            id:        e.id,
            roomName:  e.roomName,
            kind:      e.kind,
            backend:   e.backend,
            status:    e.status,
            startedAt: e.startedAt,
            stoppedAt: e.stoppedAt,
            pid:       e.child && e.child.pid,
            native:    e.native ? { id: e.native.egressId || e.native.id || null } : null,
            error:     e.error || null,
        };
    }

    /** @private */
    _inferPipeline()
    {
        if (typeof this.adapter.startRoomCompositeEgress === 'function') return 'livekit';
        return 'memory';
    }

    /** @private */
    _spawnFfmpeg(opts)
    {
        const spawn = this._spawn || require('child_process').spawn;
        let path = this._ffmpegPath;
        if (!path)
        {
            try { path = require('ffmpeg-static'); }
            catch
            {
                throw new WebRTCError(
                    'ffmpeg pipeline requires `ffmpeg-static` (npm i ffmpeg-static) or { ffmpegPath }',
                    { code: 'WEBRTC_RECORDING_NO_FFMPEG' },
                );
            }
        }
        const args = Array.isArray(opts.args) ? opts.args : this._buildFfmpegArgs(opts);
        return spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    }

    /** @private */
    _buildFfmpegArgs(opts)
    {
        const o = opts || {};
        const inputs  = Array.isArray(o.inputs)  ? o.inputs  : [];
        const sink    = o.sink || {};
        const format  = o.format || (sink.file && sink.file.endsWith('.webm') ? 'webm' : 'mp4');
        const args    = ['-y', '-loglevel', 'warning'];
        for (const inp of inputs)
        {
            if (inp.sdp)      args.push('-protocol_whitelist', 'pipe,udp,rtp', '-f', 'sdp', '-i', inp.sdp);
            else if (inp.url) args.push('-i', inp.url);
        }
        if (sink.file)      args.push('-f', format, sink.file);
        else if (sink.url)  args.push('-f', sink.format || 'rtp', sink.url);
        return args;
    }
}

// --- IngressManager ---

/**
 * Tracks ingresses created via the adapter (WHIP / RTMP / URL pull / SIP)
 * so callers don't need their own bookkeeping. Delegates the actual
 * lifecycle to `adapter.createIngress` / `adapter.deleteIngress`.
 *
 * @class
 * @section Recording
 */
class IngressManager
{
    /**
     * @constructor
     * @param {object} opts
     * @param {object} opts.adapter
     */
    constructor(opts)
    {
        const o = opts || {};
        if (!o.adapter) throw new WebRTCError('IngressManager requires { adapter }', { code: 'WEBRTC_INGRESS_NO_ADAPTER' });
        this.adapter = o.adapter;
        this._next   = 0;
        /** @type {Map<string, {id:string, kind:string, roomName:string|null, native:object, opts:object, createdAt:number}>} */
        this._ingresses = new Map();
    }

    _id() { return `ing-${++this._next}-${Date.now().toString(36)}`; }

    /**
     * Create an ingress (WHIP / RTMP / URL pull / SIP).
     * @param {object} opts - `{ kind, roomName, name, ... }`
     * @section Recording
     */
    async createIngress(opts)
    {
        const o = opts || {};
        if (typeof this.adapter.createIngress !== 'function')
            throw new WebRTCError('adapter does not implement createIngress', { code: 'WEBRTC_INGRESS_NO_BACKEND' });
        const native = await this.adapter.createIngress(o);
        const id = this._id();
        const entry = {
            id,
            kind:      o.kind || o.inputType || 'rtmp',
            roomName:  o.roomName || o.room || null,
            native,
            opts:      o,
            createdAt: Date.now(),
        };
        this._ingresses.set(id, entry);
        return { id, native, info: () => this._snapshot(entry) };
    }

    /**
     * Tear down an ingress by id.  Idempotent.
     * @param {string} id
     * @returns {Promise<boolean>}
     * @section Recording
     */
    async deleteIngress(id)
    {
        const entry = this._ingresses.get(id);
        if (!entry) return false;
        this._ingresses.delete(id);
        if (typeof this.adapter.deleteIngress === 'function')
        {
            const ingressId = entry.native && (entry.native.ingressId || entry.native.id);
            if (ingressId) await this.adapter.deleteIngress(ingressId);
        }
        return true;
    }

    /**
     * List every known ingress.
     * @returns {Array<object>}
     * @section Inspection
     */
    list()
    {
        const out = [];
        for (const entry of this._ingresses.values()) out.push(this._snapshot(entry));
        return out;
    }

    /**
     * Tear down every active ingress.  Safe to call during shutdown.
     * @section Lifecycle
     */
    async close()
    {
        for (const id of [...this._ingresses.keys()])
        {
            try { await this.deleteIngress(id); } catch { /* swallow */ }
        }
    }

    /** @private */
    _snapshot(e)
    {
        return {
            id:        e.id,
            kind:      e.kind,
            roomName:  e.roomName,
            createdAt: e.createdAt,
            native:    e.native ? { id: e.native.ingressId || e.native.id || null, url: e.native.url || e.native.streamKey || null } : null,
        };
    }
}

module.exports = { RecordingManager, IngressManager };
