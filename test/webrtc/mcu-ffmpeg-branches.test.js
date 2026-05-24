/**
 * FfmpegMcuAdapter — branch coverage for paths not exercised by
 * `mcu.test.js` (file outputs, removeSource, layout obj, exit event,
 * unknown-mix throws on every setter).
 */

'use strict';

const { FfmpegMcuAdapter } = require('../../lib/webrtc');
const { EventEmitter } = require('node:events');

function stubSpawn()
{
    const calls = [];
    const fn = (path, args) =>
    {
        const proc = new EventEmitter();
        proc.pid = 9999;
        proc.kill = (sig) => { proc._killed = sig; };
        calls.push({ path, args, proc });
        return proc;
    };
    fn.calls = calls;
    return fn;
}

describe('FfmpegMcuAdapter branch coverage', () =>
{
    it('mix() requires roomId', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await expect(mcu.mix('', {})).rejects.toThrow(/roomId/);
        await expect(mcu.mix(null)).rejects.toThrow(/roomId/);
    });

    it('emits a file output when sink.file is provided', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('rm', {
            kind:    'audio',
            inputs:  [{ url: 'rtp://0.0.0.0:5000' }],
            outputs: [{ file: '/tmp/mix.mp4' }],
        });
        const args = spawn.calls[0].args;
        expect(args).toContain('/tmp/mix.mp4');
        expect(args.join(' ')).toContain('-f mp4');
    });

    it('honors an explicit output format', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('rm', { outputs: [{ file: '/tmp/x.webm', format: 'webm' }] });
        expect(spawn.calls[0].args.join(' ')).toContain('-f webm');
    });

    it('default kind treated as audio (amix filter)', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('rm', { inputs: [] });
        expect(spawn.calls[0].args.join(' ')).toMatch(/amix=inputs=1/);
    });

    it('addSource / removeSource / setLayout throw on unknown mix', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await expect(mcu.setLayout('nope', 'grid')).rejects.toThrow(/unknown mix/);
        await expect(mcu.addSource('nope', 'p')).rejects.toThrow(/unknown mix/);
        await expect(mcu.removeSource('nope', 'p')).rejects.toThrow(/unknown mix/);
    });

    it('addSource / removeSource adjust the live source set', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        const r = await mcu.mix('rm', { producerIds: ['a'] });
        expect(await mcu.addSource(r.mixedProducerId, 'b')).toBe(2);
        expect(await mcu.removeSource(r.mixedProducerId, 'a')).toBe(1);
        const s = mcu.stats();
        expect(s.mixes[0].sources.sort()).toEqual(['b']);
    });

    it('setLayout accepts a string or an object with .name', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        const r = await mcu.mix('rm', { kind: 'video' });
        expect(await mcu.setLayout(r.mixedProducerId, 'presenter')).toBe('presenter');
        expect(await mcu.setLayout(r.mixedProducerId, { name: 'dominant' })).toBe('dominant');
        // unsupported value falls back to current layout
        expect(await mcu.setLayout(r.mixedProducerId, 42)).toBe('dominant');
    });

    it('child exit event flips entry.exited and records signal', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        const r = await mcu.mix('rm', {});
        spawn.calls[0].proc.emit('exit', 0, 'SIGTERM');
        const stats = mcu.stats();
        expect(stats.mixes[0].id).toBe(r.mixedProducerId);
        expect(stats.mixes[0].exited).toBe(true);
    });

    it('unmix returns false for unknown id and tolerates kill errors', async () =>
    {
        const spawn = (path, args) =>
        {
            const proc = new EventEmitter();
            proc.pid = 1;
            proc.kill = () => { throw new Error('eperm'); };
            return proc;
        };
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        expect(await mcu.unmix('nope')).toBe(false);
        const r = await mcu.mix('rm', {});
        expect(await mcu.unmix(r.mixedProducerId)).toBe(true);
        // second time it's gone
        expect(await mcu.unmix(r.mixedProducerId)).toBe(false);
    });

    it('_buildArgs handles SDP inputs with protocol allowlist', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('rm', { inputs: [{ sdp: '/tmp/in.sdp' }] });
        expect(spawn.calls[0].args).toContain('-protocol_whitelist');
        expect(spawn.calls[0].args.join(' ')).toContain('pipe,udp,rtp');
    });

    it('close() kills every active mix', async () =>
    {
        const spawn = stubSpawn();
        const mcu = new FfmpegMcuAdapter({ ffmpegPath: '/bin/false', spawn });
        await mcu.mix('a', {});
        await mcu.mix('b', {});
        await mcu.close();
        expect(mcu.stats().mixes).toHaveLength(0);
        expect(spawn.calls.every((c) => c.proc._killed === 'SIGTERM')).toBe(true);
    });
});
