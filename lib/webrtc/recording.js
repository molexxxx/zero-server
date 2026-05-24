/**
 * @module webrtc/recording
 * @description Adapter-agnostic recording / egress / ingress facade.
 *
 *   {@link RecordingManager} provides a single `startRecording` /
 *   `stopRecording` surface that dispatches to whichever capability
 *   the bound {@link SfuAdapter} actually exposes:
 *
 *   - **LiveKit** — delegates to `startRoomCompositeEgress` /
 *     `startTrackEgress` / `stopEgress`.
 *   - **mediasoup** — caller passes `{ pipeline:'ffmpeg' }` and the
 *     adapter is expected to provide `PlainTransport` plumbing; this
 *     module spawns ffmpeg and tracks the child process.
 *   - **Custom / memory** — bookkeeping only.  Useful for tests and for
 *     applications that want to model recording cost without paying for
 *     real media.
 *
 *   {@link IngressManager} is a thin wrapper around
 *   `adapter.createIngress` / `adapter.deleteIngress` (Phase-3 LiveKit
 *   surface) that adds a per-stream registry so callers can list /
 *   teardown active ingresses without keeping their own bookkeeping.
 *
 * @example | Adapter-agnostic recording
 *   const rec = new RecordingManager({ adapter: hub.sfu });
 *   const { id, stop } = await rec.startRecording('lobby', {
 *       layout: 'grid',
 *       format: 'mp4',
 *       sink:   { file: '/var/recordings/lobby.mp4' },
 *   });
 *   // ...later
 *   await stop();
 */

'use strict';

const { WebRTCError } = require('../errors');

/** @typedef {'mp4'|'webm'|'mka'|'ogg'|'hls'} RecordingFormat */
/** @typedef {'grid'|'presenter'|'presenter-strip'|'dominant'|'speaker'|'audio-only'} RecordingLayout */

class RecordingManager
{
    /**
     * @param {object} opts
     * @param {object} opts.adapter   - SfuAdapter (or anything exposing egress methods).
     * @param {Function} [opts.spawn] - For pipeline:'ffmpeg' (defaults to child_process.spawn).
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

    /** @returns {Array<object>} */
    list()
    {
        const out = [];
        for (const entry of this._records.values()) out.push(this._snapshot(entry));
        return out;
    }

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

class IngressManager
{
    /**
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

    list()
    {
        const out = [];
        for (const entry of this._ingresses.values()) out.push(this._snapshot(entry));
        return out;
    }

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
