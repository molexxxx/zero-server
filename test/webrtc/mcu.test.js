/**
 * MCU adapter tests.
 *   Covers MemoryMcuAdapter (full bookkeeping) and FfmpegMcuAdapter
 *   construction + arg-build / mix-stats with a stub spawn.
 */

'use strict';

const {
    McuAdapter,
    MemoryMcuAdapter,
    FfmpegMcuAdapter,
} = require('../../lib/webrtc');
const { EventEmitter } = require('node:events');

describe('McuAdapter (abstract)', () =>
{
    it('throws NOT_IMPLEMENTED for every override hook', async () =>
    {
        const a = new McuAdapter();
        await expect(a.mix('r', {})).rejects.toThrow(/not implemented/);
        await expect(a.unmix('x')).rejects.toThrow(/not implemented/);
        await expect(a.setLayout('x', 'grid')).rejects.toThrow(/not implemented/);
        await expect(a.addSource('x', 'p')).rejects.toThrow(/not implemented/);
        await expect(a.removeSource('x', 'p')).rejects.toThrow(/not implemented/);
        expect(a.stats()).toEqual({ mixes: [] });
    });
});

describe('MemoryMcuAdapter', () =>
{
    let mcu;
    beforeEach(() => { mcu = new MemoryMcuAdapter(); });

    it('mix() returns a synthetic mixedProducerId and records sources', async () =>
    {
        const r = await mcu.mix('lobby', { producerIds: ['p1', 'p2'], kind: 'audio' });
        expect(r.mixedProducerId).toMatch(/^mcu:lobby:\d+$/);
        expect(r.kind).toBe('audio');
        expect(r.layout).toBe('audio-only');
        expect(r.sources).toEqual(['p1', 'p2']);
    });

    it('mix() defaults to grid layout for video kind', async () =>
    {
        const r = await mcu.mix('grid-room', { producerIds: [], kind: 'video' });
        expect(r.layout).toBe('grid');
    });

    it('mix() requires roomId', async () =>
    {
        await expect(mcu.mix('', {})).rejects.toThrow(/roomId/);
    });

    it('addSource / removeSource update the mix', async () =>
    {
        const r = await mcu.mix('rm', { producerIds: ['a'] });
        await mcu.addSource(r.mixedProducerId, 'b');
        await mcu.addSource(r.mixedProducerId, 'c');
        let s = mcu.stats();
        expect(s.mixes[0].sources.sort()).toEqual(['a', 'b', 'c']);
        await mcu.removeSource(r.mixedProducerId, 'a');
        s = mcu.stats();
        expect(s.mixes[0].sources.sort()).toEqual(['b', 'c']);
    });

    it('setLayout() updates the layout', async () =>
    {
        const r = await mcu.mix('rm', { kind: 'video' });
        const next = await mcu.setLayout(r.mixedProducerId, 'presenter');
        expect(next).toBe('presenter');
        expect(mcu.stats().mixes[0].layout).toBe('presenter');
    });

    it('setLayout accepts a layout object with .name', async () =>
    {
        const r = await mcu.mix('rm', { kind: 'video' });
        await mcu.setLayout(r.mixedProducerId, { name: 'dominant' });
        expect(mcu.stats().mixes[0].layout).toBe('dominant');
    });

    it('addSource / removeSource / setLayout throw on unknown mix', async () =>
    {
        await expect(mcu.addSource('nope', 'p')).rejects.toThrow(/unknown mix/);
        await expect(mcu.removeSource('nope', 'p')).rejects.toThrow(/unknown mix/);
        await expect(mcu.setLayout('nope', 'grid')).rejects.toThrow(/unknown mix/);
    });

    it('unmix() removes the entry and is idempotent', async () =>
    {
        const r = await mcu.mix('rm', {});
        expect(await mcu.unmix(r.mixedProducerId)).toBe(true);
        expect(await mcu.unmix(r.mixedProducerId)).toBe(false);
        expect(mcu.stats().mixes).toHaveLength(0);
    });

    it('close() clears every mix', async () =>
    {
        await mcu.mix('a', {});
        await mcu.mix('b', {});
        await mcu.close();
        expect(mcu.stats().mixes).toHaveLength(0);
    });
});

describe('FfmpegMcuAdapter', () =>
{
    function stubSpawn()
    {
        const calls = [];
        const fn = (path, args) =>
        {
            const proc = new EventEmitter();
            proc.pid = 12345;
            proc.kill = (sig) => { proc._killed = sig; };
            calls.push({ path, args, proc });
            return proc;
        };
        fn.calls = calls;
        return fn;
    }

    it('throws WEBRTC_MCU_NO_FFMPEG when ffmpeg-static missing and no ffmpegPath', () =>
    {
        // ffmpeg-static likely not installed in the test env; surface the gate.
        let threw = false;
        try { new FfmpegMcuAdapter(); }
        catch (err)
        {
            threw = true;
            expect(err.code).toBe('WEBRTC_MCU_NO_FFMPEG');
        }
        // If ffmpeg-static IS installed locally, the constructor succeeds —
        // accept either outcome to keep the test portable.
        if (!threw)
        {
            const ok = new FfmpegMcuAdapter();
            expect(typeof ok._ffmpegPath).toBe('string');
        }
    });

    it('accepts an explicit ffmpegPath + stub spawn and records the mix', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        const r = await mcu.mix('rm', {
            producerIds: ['p1', 'p2'],
            kind:        'audio',
            inputs:      [{ sdp: 'in1.sdp' }, { sdp: 'in2.sdp' }],
            outputs:     [{ url: 'rtp://127.0.0.1:5004' }],
        });
        expect(r.mixedProducerId).toMatch(/^mcu-ffmpeg:rm:\d+$/);
        expect(r.pid).toBe(12345);
        expect(spawn.calls).toHaveLength(1);
        const args = spawn.calls[0].args;
        expect(args).toContain('-i');
        expect(args.join(' ')).toMatch(/amix=inputs=2/);
        expect(args.join(' ')).toContain('rtp://127.0.0.1:5004');

        const s = mcu.stats();
        expect(s.mixes[0].pid).toBe(12345);

        await mcu.unmix(r.mixedProducerId);
        expect(spawn.calls[0].proc._killed).toBe('SIGTERM');
    });

    it('uses xstack filter for video kind', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('v', { kind: 'video', inputs: [{ url: 'a' }, { url: 'b' }] });
        expect(spawn.calls[0].args.join(' ')).toMatch(/xstack=inputs=2/);
    });

    it('honors a pre-built args array', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('v', { args: ['-f', 'lavfi', '-i', 'anullsrc'] });
        expect(spawn.calls[0].args).toEqual(['-f', 'lavfi', '-i', 'anullsrc']);
    });

    it('close() unmixes everything', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('a', {});
        await mcu.mix('b', {});
        await mcu.close();
        expect(mcu.stats().mixes).toHaveLength(0);
    });
});
