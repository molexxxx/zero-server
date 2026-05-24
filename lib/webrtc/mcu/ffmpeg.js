/**
 * @module webrtc/mcu/ffmpeg
 * @description Spawns one ffmpeg child process per mix and implements the
 *   {@link McuAdapter} contract. The integrator wires mediasoup
 *   `PlainTransport` RTP feeds into ffmpeg via `opts.inputs` and consumes
 *   ffmpeg's output via `opts.outputs`; the adapter only owns the child
 *   lifecycle.
 *
 *   Gated on `ffmpeg-static` (or an explicit `{ ffmpegPath }`) so missing
 *   binaries fail loudly. For a fully managed equivalent prefer LiveKit
 *   egress via {@link LiveKitSfuAdapter}.
 *
 * @example | Spawn an audio mix
 *   const mcu = new FfmpegMcuAdapter({ sfu });
 *   const mix = await mcu.mix('lobby', {
 *       producerIds: ['p1', 'p2'],
 *       inputs:      [{ sdp: '/tmp/in1.sdp' }, { sdp: '/tmp/in2.sdp' }],
 *       outputs:     [{ url: 'rtp://127.0.0.1:5004' }],
 *       kind:        'audio',
 *   });
 *   await mcu.unmix(mix.mixedProducerId);
 */

'use strict';

const { McuAdapter } = require('./index');
const { WebRTCError } = require('../../errors');

// --- FfmpegMcuAdapter ---

/**
 * ffmpeg-backed MCU adapter.
 *
 * @class
 * @section MCU
 */
class FfmpegMcuAdapter extends McuAdapter
{
    /**
     * @constructor
     * @param {object} [opts]
     * @param {object} [opts.sfu]
     * @param {string} [opts.ffmpegPath] - Overrides the `ffmpeg-static` lookup.
     * @param {Function} [opts.spawn]    - Injected for tests (defaults to `child_process.spawn`).
     */
    constructor(opts)
    {
        super(opts);
        const o = opts || {};
        this._ffmpegPath = o.ffmpegPath || null;
        if (!this._ffmpegPath)
        {
            try
            {
                // eslint-disable-next-line global-require
                this._ffmpegPath = require('ffmpeg-static');
            }
            catch
            {
                throw new WebRTCError(
                    'FfmpegMcuAdapter requires `ffmpeg-static` (npm i ffmpeg-static) or { ffmpegPath } in options',
                    { code: 'WEBRTC_MCU_NO_FFMPEG' },
                );
            }
        }
        this._spawn   = o.spawn || require('child_process').spawn;
        this._mixes   = new Map();
        this._nextId  = 0;
    }

    /**
     * Spawn an ffmpeg process to mix the given producers.  The caller is
     * responsible for wiring the SFU's PlainTransport RTP feeds into
     * ffmpeg via `opts.inputs` (an array of `{ producerId, sdp, host, port }`)
     * and consuming ffmpeg's output via `opts.outputs`.
     *
     * @param {string} roomId
     * @param {object} opts  - `{ producerIds, inputs, outputs, kind, layout, args? }`
     * @section Mixing
     */
    async mix(roomId, opts)
    {
        const o = opts || {};
        if (!roomId) throw new WebRTCError('mix: roomId required', { code: 'WEBRTC_MCU_BAD_ARGS' });
        const id = `mcu-ffmpeg:${roomId}:${++this._nextId}`;
        const args = this._buildArgs(o);
        const child = this._spawn(this._ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const entry = {
            id, room: roomId, kind: o.kind || 'audio', layout: o.layout || 'grid',
            sources: new Set(Array.isArray(o.producerIds) ? o.producerIds : []),
            child, exited: false,
        };
        child.once('exit', (code, signal) => { entry.exited = true; entry.exitCode = code; entry.exitSignal = signal; });
        this._mixes.set(id, entry);
        return { mixedProducerId: id, kind: entry.kind, layout: entry.layout, sources: [...entry.sources], pid: child.pid };
    }

    async unmix(mixedProducerId)
    {
        const m = this._mixes.get(mixedProducerId);
        if (!m) return false;
        this._mixes.delete(mixedProducerId);
        try { m.child.kill('SIGTERM'); } catch { /* swallow */ }
        return true;
    }

    async setLayout(mixedProducerId, layout)
    {
        const m = this._mixes.get(mixedProducerId);
        if (!m) throw new WebRTCError('setLayout: unknown mix', { code: 'WEBRTC_MCU_NO_MIX' });
        // ffmpeg can't change filter graph on the fly without restart.
        m.layout = typeof layout === 'string' ? layout : (layout && layout.name) || m.layout;
        return m.layout;
    }

    async addSource(mixedProducerId, producerId)
    {
        const m = this._mixes.get(mixedProducerId);
        if (!m) throw new WebRTCError('addSource: unknown mix', { code: 'WEBRTC_MCU_NO_MIX' });
        m.sources.add(producerId);
        return m.sources.size;
    }

    async removeSource(mixedProducerId, producerId)
    {
        const m = this._mixes.get(mixedProducerId);
        if (!m) throw new WebRTCError('removeSource: unknown mix', { code: 'WEBRTC_MCU_NO_MIX' });
        m.sources.delete(producerId);
        return m.sources.size;
    }

    stats()
    {
        const mixes = [];
        for (const m of this._mixes.values())
        {
            mixes.push({ id: m.id, room: m.room, sources: [...m.sources], layout: m.layout, kind: m.kind, pid: m.child && m.child.pid, exited: m.exited });
        }
        return { mixes };
    }

    async close()
    {
        for (const id of [...this._mixes.keys()]) await this.unmix(id);
    }

    _buildArgs(opts)
    {
        const o = opts || {};
        if (Array.isArray(o.args)) return o.args;
        const inputs = Array.isArray(o.inputs) ? o.inputs : [];
        const args = ['-y', '-loglevel', 'warning'];
        for (const inp of inputs)
        {
            if (inp.sdp)         args.push('-protocol_whitelist', 'pipe,udp,rtp', '-f', 'sdp', '-i', inp.sdp);
            else if (inp.url)    args.push('-i', inp.url);
        }
        if (o.kind === 'audio' || !o.kind)
            args.push('-filter_complex', `amix=inputs=${Math.max(inputs.length, 1)}`, '-c:a', 'libopus');
        else
            args.push('-filter_complex', `xstack=inputs=${Math.max(inputs.length, 1)}`, '-c:v', 'libvpx');
        const outputs = Array.isArray(o.outputs) ? o.outputs : [];
        for (const out of outputs)
        {
            if (out.url) args.push('-f', out.format || 'rtp', out.url);
            else if (out.file) args.push('-f', out.format || 'mp4', out.file);
        }
        return args;
    }
}

module.exports = { FfmpegMcuAdapter };
