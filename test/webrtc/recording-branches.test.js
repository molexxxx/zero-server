/**
 * RecordingManager — branch coverage for ffmpeg stop, error paths,
 * and the sink.url RTP output branch.
 */

'use strict';

const { RecordingManager, MemorySfuAdapter } = require('../../lib/webrtc');
const { EventEmitter } = require('node:events');

class FakeChild extends EventEmitter
{
    constructor() { super(); this.pid = 4242; this.killed = false; }
    kill(sig) { this.killed = sig; this.emit('exit', 0, sig); }
}

describe('RecordingManager branch coverage', () =>
{
    it('startRecording rejects when roomName missing', async () =>
    {
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter() });
        await expect(rec.startRecording('')).rejects.toThrow(/roomName/);
    });

    it('ffmpeg pipeline stop kills the child process', async () =>
    {
        const child = new FakeChild();
        const spawn = () => child;
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter(), spawn, ffmpegPath: '/usr/bin/ffmpeg' });
        const handle = await rec.startRecording('lobby', { pipeline: 'ffmpeg', sink: { file: '/tmp/x.mp4' } });
        expect(handle.info().status).toBe('recording');
        expect(await handle.stop()).toBe(true);
        expect(child.killed).toBe('SIGTERM');
        const snap = handle.info();
        expect(snap.status).toBe('stopped');
    });

    it('ffmpeg pipeline tolerates kill() throwing', async () =>
    {
        const child = new EventEmitter();
        child.pid = 1;
        child.kill = () => { throw new Error('eperm'); };
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter(), spawn: () => child, ffmpegPath: '/x' });
        const handle = await rec.startRecording('lobby', { pipeline: 'ffmpeg' });
        expect(await handle.stop()).toBe(true);
    });

    it('stopRecording marks failed when adapter.stopEgress throws', async () =>
    {
        const adapter = {
            calls: [],
            async startRoomCompositeEgress(name)
            {
                this.calls.push({ kind: 'start', name });
                return { egressId: 'eg-1' };
            },
            async stopEgress() { throw new Error('egress-boom'); },
        };
        const rec = new RecordingManager({ adapter });
        const handle = await rec.startRecording('lobby');
        await expect(handle.stop()).rejects.toThrow(/egress-boom/);
        const list = rec.list();
        expect(list[0].status).toBe('failed');
        expect(list[0].error).toMatch(/egress-boom/);
    });

    it('_buildFfmpegArgs handles sink.url (RTP output)', async () =>
    {
        const args = [];
        const spawn = (p, a) => { args.push(a); return new FakeChild(); };
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter(), spawn, ffmpegPath: '/x' });
        await rec.startRecording('rm', { pipeline: 'ffmpeg', inputs: [{ url: 'rtp://0.0.0.0:5000' }], sink: { url: 'rtp://1.1.1.1:6000' } });
        expect(args[0].join(' ')).toContain('rtp://1.1.1.1:6000');
        expect(args[0].join(' ')).toContain('-f rtp');
    });

    it('_buildFfmpegArgs infers webm format from .webm extension', async () =>
    {
        const args = [];
        const spawn = (p, a) => { args.push(a); return new FakeChild(); };
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter(), spawn, ffmpegPath: '/x' });
        await rec.startRecording('rm', { pipeline: 'ffmpeg', sink: { file: '/tmp/x.webm' } });
        expect(args[0].join(' ')).toContain('-f webm');
        expect(args[0].join(' ')).toContain('/tmp/x.webm');
    });

    it('snapshot includes pid when ffmpeg child is present', async () =>
    {
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter(), spawn: () => new FakeChild(), ffmpegPath: '/x' });
        const h = await rec.startRecording('rm', { pipeline: 'ffmpeg' });
        expect(h.info().pid).toBe(4242);
    });

    it('close() swallows errors from stopRecording', async () =>
    {
        const adapter = {
            async startRoomCompositeEgress() { return { egressId: 'eg-1' }; },
            async stopEgress() { throw new Error('boom'); },
        };
        const rec = new RecordingManager({ adapter });
        await rec.startRecording('rm');
        // close must NOT reject even though stopEgress throws.
        await expect(rec.close()).resolves.toBeUndefined();
    });
});
