'use strict';

const { EventEmitter } = require('node:events');
const {
    RecordingManager,
    IngressManager,
    MemorySfuAdapter,
} = require('../../lib/webrtc');

function fakeLiveKitAdapter()
{
    const calls = [];
    return {
        calls,
        async startRoomCompositeEgress(room, opts)
        {
            calls.push({ kind: 'composite', room, opts });
            return { egressId: 'eg-' + room, room };
        },
        async startTrackEgress(room, opts)
        {
            calls.push({ kind: 'track', room, opts });
            return { egressId: 'tr-' + room, trackId: opts && opts.trackId };
        },
        async stopEgress(id)
        {
            calls.push({ kind: 'stop', id });
            return { ok: true };
        },
        async createIngress(opts)
        {
            calls.push({ kind: 'ingress:create', opts });
            return { ingressId: 'ing-' + (opts.name || 'x'), url: 'rtmp://example/' + opts.name, streamKey: 'sk-' + opts.name };
        },
        async deleteIngress(id)
        {
            calls.push({ kind: 'ingress:delete', id });
            return { ok: true };
        },
    };
}

class FakeChild extends EventEmitter
{
    constructor() { super(); this.pid = 4242; this.killed = false; }
    kill() { this.killed = true; this.emit('exit', 0, 'SIGTERM'); }
}

describe('RecordingManager', () =>
{
    it('throws without adapter', () =>
    {
        expect(() => new RecordingManager({})).toThrow(/adapter/i);
    });

    it('infers livekit pipeline when adapter exposes startRoomCompositeEgress', async () =>
    {
        const adapter = fakeLiveKitAdapter();
        const rec = new RecordingManager({ adapter });
        const handle = await rec.startRecording('lobby', { layout: 'grid' });
        expect(handle.status).toBe('recording');
        expect(adapter.calls[0]).toMatchObject({ kind: 'composite', room: 'lobby' });
        const info = handle.info();
        expect(info.backend).toBe('livekit');
        expect(info.native.id).toBe('eg-lobby');
        await handle.stop();
        expect(adapter.calls.at(-1)).toMatchObject({ kind: 'stop', id: 'eg-lobby' });
        expect(handle.info().status).toBe('stopped');
    });

    it('supports livekit-track pipeline', async () =>
    {
        const adapter = fakeLiveKitAdapter();
        const rec = new RecordingManager({ adapter });
        const handle = await rec.startRecording('lobby', { pipeline: 'livekit-track', trackId: 't1' });
        expect(handle.info().backend).toBe('livekit-track');
        await handle.stop();
        expect(adapter.calls.filter((c) => c.kind === 'stop')).toHaveLength(1);
    });

    it('falls back to memory pipeline when adapter has no egress methods', async () =>
    {
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter() });
        const handle = await rec.startRecording('lobby');
        expect(handle.info().backend).toBe('memory');
        expect(handle.status).toBe('recording');
        await handle.stop();
        expect(handle.info().status).toBe('stopped');
    });

    it('rejects unknown pipeline', async () =>
    {
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter() });
        await expect(rec.startRecording('lobby', { pipeline: 'magic' })).rejects.toThrow(/pipeline/i);
    });

    it('throws when livekit pipeline requested but adapter missing method', async () =>
    {
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter() });
        await expect(rec.startRecording('lobby', { pipeline: 'livekit' })).rejects.toThrow(/startRoomCompositeEgress/);
    });

    it('spawns ffmpeg child for ffmpeg pipeline', async () =>
    {
        const spawned = [];
        const spawn = (path, args) => { spawned.push({ path, args }); return new FakeChild(); };
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter(), spawn, ffmpegPath: '/usr/bin/ffmpeg' });
        const handle = await rec.startRecording('lobby', {
            pipeline: 'ffmpeg',
            inputs: [{ sdp: '/tmp/in.sdp' }, { url: 'rtp://127.0.0.1:5004' }],
            sink:   { file: '/tmp/out.mp4' },
        });
        expect(spawned).toHaveLength(1);
        expect(spawned[0].path).toBe('/usr/bin/ffmpeg');
        expect(spawned[0].args).toContain('/tmp/in.sdp');
        expect(spawned[0].args).toContain('/tmp/out.mp4');
        expect(handle.info().pid).toBe(4242);
        await handle.stop();
    });

    it('ffmpeg pipeline without ffmpeg-static and no path throws', async () =>
    {
        const rec = new RecordingManager({ adapter: new MemorySfuAdapter(), spawn: () => new FakeChild() });
        await expect(rec.startRecording('lobby', { pipeline: 'ffmpeg' })).rejects.toThrow(/ffmpeg/i);
    });

    it('list() and stats() track recordings', async () =>
    {
        const adapter = fakeLiveKitAdapter();
        const rec = new RecordingManager({ adapter });
        const a = await rec.startRecording('r1');
        const b = await rec.startRecording('r2');
        expect(rec.list()).toHaveLength(2);
        expect(rec.stats()).toMatchObject({ recording: 2, stopped: 0, failed: 0, total: 2 });
        await a.stop();
        expect(rec.stats()).toMatchObject({ recording: 1, stopped: 1 });
        await b.stop();
        expect(rec.stats().stopped).toBe(2);
    });

    it('stopRecording is idempotent and returns false for unknown id', async () =>
    {
        const adapter = fakeLiveKitAdapter();
        const rec = new RecordingManager({ adapter });
        const handle = await rec.startRecording('r1');
        expect(await rec.stopRecording(handle.id)).toBe(true);
        expect(await rec.stopRecording(handle.id)).toBe(false);
        expect(await rec.stopRecording('nope')).toBe(false);
    });

    it('close() stops all active recordings', async () =>
    {
        const adapter = fakeLiveKitAdapter();
        const rec = new RecordingManager({ adapter });
        await rec.startRecording('r1');
        await rec.startRecording('r2');
        await rec.close();
        expect(rec.stats().recording).toBe(0);
        expect(rec.stats().stopped).toBe(2);
    });

    it('marks recording as failed when adapter throws', async () =>
    {
        const adapter = {
            async startRoomCompositeEgress() { throw new Error('boom'); },
        };
        const rec = new RecordingManager({ adapter });
        await expect(rec.startRecording('r1', { pipeline: 'livekit' })).rejects.toThrow('boom');
        const list = rec.list();
        expect(list).toHaveLength(1);
        expect(list[0].status).toBe('failed');
    });
});

describe('IngressManager', () =>
{
    it('throws without adapter', () =>
    {
        expect(() => new IngressManager({})).toThrow(/adapter/i);
    });

    it('throws when adapter lacks createIngress', async () =>
    {
        const mgr = new IngressManager({ adapter: new MemorySfuAdapter() });
        await expect(mgr.createIngress({ kind: 'rtmp', name: 'x' })).rejects.toThrow(/createIngress/);
    });

    it('creates and deletes ingress entries', async () =>
    {
        const adapter = fakeLiveKitAdapter();
        const mgr = new IngressManager({ adapter });
        const a = await mgr.createIngress({ kind: 'rtmp', name: 'studio' });
        expect(a.native.ingressId).toBe('ing-studio');
        expect(mgr.list()).toHaveLength(1);
        const snap = mgr.list()[0];
        expect(snap.kind).toBe('rtmp');
        expect(snap.native.url).toContain('studio');

        const b = await mgr.createIngress({ kind: 'whip', name: 'web' });
        expect(mgr.list()).toHaveLength(2);

        expect(await mgr.deleteIngress(a.id)).toBe(true);
        expect(mgr.list()).toHaveLength(1);
        expect(await mgr.deleteIngress('nope')).toBe(false);

        await mgr.close();
        expect(mgr.list()).toHaveLength(0);
        // close called deleteIngress on b
        expect(adapter.calls.some((c) => c.kind === 'ingress:delete' && c.id === 'ing-web')).toBe(true);
    });
});
