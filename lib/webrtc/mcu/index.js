/**
 * @module webrtc/mcu
 * @description Optional **MCU (multipoint control unit)** layer that sits on
 *   top of an {@link SfuAdapter}.  Where an SFU forwards each publisher's
 *   stream untouched, an MCU **mixes** them down to a smaller number of
 *   composite tracks (e.g. one audio mix + one tiled video) so receivers
 *   only have to decode O(1) streams instead of O(N).  This is the right
 *   topology for SIP gateways, low-end clients, regulated recording, and
 *   ultra-large rooms where consumer decode cost is the bottleneck.
 *
 * @section Why
 *
 *   zero-server ships **no native mixer** — JS-side Opus/H264 transcoding
 *   is CPU-prohibitive.  Instead the MCU layer is a *contract*: pluggable
 *   adapters can spawn an ffmpeg child process (the included
 *   {@link FfmpegMcuAdapter}), shell out to a GPU-backed mixer, or call
 *   into a managed service.  The {@link MemoryMcuAdapter} is bookkeeping
 *   only — it's used by the test suite and by apps that want to model the
 *   topology decision without actually mixing.
 *
 * @section Surface
 *
 *   | Method                     | Purpose                                              |
 *   |----------------------------|------------------------------------------------------|
 *   | `mix(roomId, opts)`        | Start a new composite, return `{ mixedProducerId }`. |
 *   | `unmix(mixedProducerId)`   | Tear down a composite.                               |
 *   | `setLayout(id, layout)`    | Change video layout on the fly.                      |
 *   | `addSource(id, prodId)`    | Add a producer to an existing mix.                   |
 *   | `removeSource(id, prodId)` | Remove a producer.                                   |
 *   | `stats()`                  | `{ mixes:[{id, sources, layout, kind}] }`            |
 *
 * @example | Bookkeeping-only mixer (tests, capacity planning)
 *   const mcu = new MemoryMcuAdapter({ sfu });
 *   const { mixedProducerId } = await mcu.mix('lobby', {
 *       producerIds: ['p1', 'p2', 'p3'],
 *       kind:        'audio',
 *   });
 */

'use strict';

const { WebRTCError } = require('../../errors');

/** @typedef {'grid'|'presenter'|'presenter-strip'|'dominant'|'pip'} McuLayout */

/**
 * Abstract base class.  Adapter authors override `mix` / `unmix` /
 * `setLayout` to back the composite with a real mixer (ffmpeg, GPU,
 * managed service, ...).  All methods default to throwing
 * `WEBRTC_MCU_NOT_IMPLEMENTED` so missing capability is surfaced
 * immediately rather than silently no-oping.
 */
class McuAdapter
{
    constructor(opts)
    {
        const o = opts || {};
        this.sfu = o.sfu || null;
        this.name = o.name || this.constructor.name;
    }

    /**
     * Start a new composite.
     * @param {string} _roomId
     * @param {object} _opts  - `{ producerIds, kind:'audio'|'video'|'av', layout?, output? }`
     * @returns {Promise<{mixedProducerId:string, kind:string, layout:McuLayout, sources:string[]}>}
     */
    // eslint-disable-next-line no-unused-vars
    async mix(_roomId, _opts) { throw new WebRTCError(`${this.name}.mix not implemented`, { code: 'WEBRTC_MCU_NOT_IMPLEMENTED' }); }

    /** @param {string} _mixedProducerId */
    // eslint-disable-next-line no-unused-vars
    async unmix(_mixedProducerId) { throw new WebRTCError(`${this.name}.unmix not implemented`, { code: 'WEBRTC_MCU_NOT_IMPLEMENTED' }); }

    /**
     * @param {string} _mixedProducerId
     * @param {McuLayout|object} _layout
     */
    // eslint-disable-next-line no-unused-vars
    async setLayout(_mixedProducerId, _layout) { throw new WebRTCError(`${this.name}.setLayout not implemented`, { code: 'WEBRTC_MCU_NOT_IMPLEMENTED' }); }

    /** @param {string} _mixedProducerId @param {string} _producerId */
    // eslint-disable-next-line no-unused-vars
    async addSource(_mixedProducerId, _producerId) { throw new WebRTCError(`${this.name}.addSource not implemented`, { code: 'WEBRTC_MCU_NOT_IMPLEMENTED' }); }

    /** @param {string} _mixedProducerId @param {string} _producerId */
    // eslint-disable-next-line no-unused-vars
    async removeSource(_mixedProducerId, _producerId) { throw new WebRTCError(`${this.name}.removeSource not implemented`, { code: 'WEBRTC_MCU_NOT_IMPLEMENTED' }); }

    /** @returns {{mixes: Array<{id:string, sources:string[], layout:McuLayout, kind:string}>}} */
    stats() { return { mixes: [] }; }

    /** Tear down every active mix. */
    async close() { /* override in subclasses */ }
}

/**
 * Bookkeeping-only MCU.  Doesn't touch media — useful for tests and for
 * apps that want to model the MCU topology cost without paying for real
 * mixing.  Produces synthetic mixed-producer ids of the form
 * `mcu:<roomId>:<n>`.
 */
class MemoryMcuAdapter extends McuAdapter
{
    constructor(opts)
    {
        super(opts);
        this._next  = 0;
        /** @type {Map<string, {id:string, room:string, kind:string, layout:McuLayout, sources:Set<string>, output:object|null}>} */
        this._mixes = new Map();
    }

    _id(roomId) { return `mcu:${roomId}:${++this._next}`; }

    async mix(roomId, opts)
    {
        const o = opts || {};
        if (!roomId) throw new WebRTCError('mix: roomId required', { code: 'WEBRTC_MCU_BAD_ARGS' });
        const kind   = o.kind || 'audio';
        const layout = o.layout || (kind === 'audio' ? 'audio-only' : 'grid');
        const sources = new Set(Array.isArray(o.producerIds) ? o.producerIds : []);
        const id = this._id(roomId);
        this._mixes.set(id, { id, room: roomId, kind, layout, sources, output: o.output || null });
        return { mixedProducerId: id, kind, layout, sources: [...sources] };
    }

    async unmix(mixedProducerId)
    {
        const m = this._mixes.get(mixedProducerId);
        if (!m) return false;
        this._mixes.delete(mixedProducerId);
        return true;
    }

    async setLayout(mixedProducerId, layout)
    {
        const m = this._mixes.get(mixedProducerId);
        if (!m) throw new WebRTCError('setLayout: unknown mix', { code: 'WEBRTC_MCU_NO_MIX' });
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
            mixes.push({ id: m.id, room: m.room, sources: [...m.sources], layout: m.layout, kind: m.kind });
        }
        return { mixes };
    }

    async close() { this._mixes.clear(); }
}

module.exports = { McuAdapter, MemoryMcuAdapter };
