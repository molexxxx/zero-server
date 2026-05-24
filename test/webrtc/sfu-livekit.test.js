'use strict';

const { LiveKitSfuAdapter, loadSfuAdapter, WebRTCError } = require('../../lib/webrtc');

// ---------------------------------------------------------------------------
//  Stub for `livekit-server-sdk`.
//
//  Exposes a `RoomServiceClient` with the subset of methods our adapter
//  calls (createRoom, deleteRoom, listRooms, listParticipants,
//  mutePublishedTrack) and an `AccessToken` whose `.toJwt()` returns a
//  deterministic string built from the grant payload so tests can assert
//  on it without parsing JWTs.
// ---------------------------------------------------------------------------

function makeStub()
{
    const calls = [];
    const rooms = new Map();
    class RoomServiceClient
    {
        constructor(url, key, secret)
        {
            this.url    = url;
            this.key    = key;
            this.secret = secret;
        }
        async createRoom(opts)
        {
            calls.push({ method: 'createRoom', opts });
            const room = { name: opts.name, ...opts };
            rooms.set(room.name, room);
            return room;
        }
        async deleteRoom(name)
        {
            calls.push({ method: 'deleteRoom', name });
            rooms.delete(name);
        }
        async listRooms()
        {
            calls.push({ method: 'listRooms' });
            return Array.from(rooms.values());
        }
        async listParticipants(name)
        {
            calls.push({ method: 'listParticipants', name });
            return [];
        }
        async mutePublishedTrack(room, identity, trackSid, muted)
        {
            calls.push({ method: 'mutePublishedTrack', room, identity, trackSid, muted });
            return { sid: trackSid, muted };
        }
    }
    class AccessToken
    {
        constructor(key, secret, opts)
        {
            this.key     = key;
            this.secret  = secret;
            this.opts    = opts || {};
            this._grants = [];
        }
        addGrant(g) { this._grants.push(g); }
        async toJwt()
        {
            return `jwt:${this.opts.identity}:${JSON.stringify(this._grants)}`;
        }
    }
    return { livekit: { RoomServiceClient, AccessToken }, calls, rooms };
}

function makeAdapter(extra)
{
    const stub = makeStub();
    const adapter = new LiveKitSfuAdapter({
        url:       'wss://lk.example.test',
        apiKey:    'KEY',
        apiSecret: 'SECRET',
        livekit:   stub.livekit,
        ...(extra || {}),
    });
    return { adapter, ...stub };
}

describe('LiveKitSfuAdapter', () =>
{
    test('throws when url/apiKey/apiSecret missing', () =>
    {
        const stub = makeStub();
        expect(() => new LiveKitSfuAdapter({ livekit: stub.livekit })).toThrow(WebRTCError);
        expect(() => new LiveKitSfuAdapter({ livekit: stub.livekit, url: 'x' })).toThrow(/url, apiKey, apiSecret/);
    });

    test('createRouter calls RoomServiceClient.createRoom and emits router-new', async () =>
    {
        const { adapter, calls } = makeAdapter();
        const events = [];
        adapter.onEvent((e) => events.push(e));
        const r = await adapter.createRouter({ name: 'demo', emptyTimeout: 30 });
        expect(r.id).toBe('demo');
        expect(r.routerId).toBe('demo');
        expect(calls[0]).toMatchObject({ method: 'createRoom', opts: { name: 'demo', emptyTimeout: 30 } });
        expect(events).toContain('router-new');
    });

    test('createRouter auto-generates a name when not supplied', async () =>
    {
        const { adapter, calls } = makeAdapter();
        const r = await adapter.createRouter();
        expect(r.id).toMatch(/^room-\d+$/);
        expect(calls[0].opts.name).toBe(r.id);
    });

    test('createTransport mints an AccessToken and returns {url, token}', async () =>
    {
        const { adapter, calls } = makeAdapter({ defaultGrants: { canPublish: true, canSubscribe: false } });
        const events = [];
        adapter.onEvent((e, p) => events.push([e, p]));
        const r = await adapter.createRouter({ name: 'room-a' });
        const t = await adapter.createTransport(r, { id: 'alice', name: 'Alice' });
        expect(t.url).toBe('wss://lk.example.test');
        expect(t.identity).toBe('alice');
        expect(t.token).toMatch(/^jwt:alice:/);
        expect(t.token).toContain('"roomJoin":true');
        expect(t.token).toContain('"room":"room-a"');
        expect(t.token).toContain('"canPublish":true');
        expect(t.token).toContain('"canSubscribe":false');
        // no server-side createTransport call - it's purely a token mint
        expect(calls.find((c) => c.method === 'createTransport')).toBeUndefined();
        expect(events.find(([e]) => e === 'transport-new')).toBeTruthy();
    });

    test('createTransport throws for unknown router', async () =>
    {
        const { adapter } = makeAdapter();
        await expect(adapter.createTransport({ id: 'ghost' }, { id: 'p' })).rejects.toMatchObject({
            code: 'WEBRTC_SFU_NO_ROUTER',
        });
    });

    test('produce / consume bookkeeping with synthetic IDs', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter({ name: 'room-b' });
        const t = await adapter.createTransport(r, { id: 'bob' });
        const p = await adapter.produce(t, 'video', { codecs: ['vp8'], trackSid: 'TR_1' });
        expect(p.kind).toBe('video');
        expect(p.trackSid).toBe('TR_1');
        const c = await adapter.consume(t, p.id, { codecs: ['vp8'] });
        expect(c.producerId).toBe(p.id);
        expect(c.kind).toBe('video');
    });

    test('produce validates kind', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const t = await adapter.createTransport(r);
        await expect(adapter.produce(t, 'data', {})).rejects.toMatchObject({ code: 'WEBRTC_SFU_INVALID_KIND' });
    });

    test('produce / consume reject unknown transport', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const t = await adapter.createTransport(r);
        const p = await adapter.produce(t, 'audio', {});
        await expect(adapter.produce({ id: 'ghost' }, 'audio', {})).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
        await expect(adapter.consume({ id: 'ghost' }, p.id, {})).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_TRANSPORT' });
        await expect(adapter.consume(t, 'ghost', {})).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
    });

    test('pauseProducer / resumeProducer call mutePublishedTrack when trackSid is set', async () =>
    {
        const { adapter, calls } = makeAdapter();
        const r = await adapter.createRouter({ name: 'room-c' });
        const t = await adapter.createTransport(r, { id: 'carol' });
        const p = await adapter.produce(t, 'audio', { trackSid: 'SID_X' });
        const events = [];
        adapter.onEvent((e) => events.push(e));
        await adapter.pauseProducer(p.id);
        await adapter.resumeProducer(p.id);
        const mutes = calls.filter((c) => c.method === 'mutePublishedTrack');
        expect(mutes).toHaveLength(2);
        expect(mutes[0]).toMatchObject({ room: 'room-c', identity: 'carol', trackSid: 'SID_X', muted: true });
        expect(mutes[1]).toMatchObject({ muted: false });
        expect(events).toContain('producer-pause');
        expect(events).toContain('producer-resume');
    });

    test('pause / resume skip mutePublishedTrack when no trackSid', async () =>
    {
        const { adapter, calls } = makeAdapter();
        const r = await adapter.createRouter();
        const t = await adapter.createTransport(r);
        const p = await adapter.produce(t, 'audio', {});
        await adapter.pauseProducer(p.id);
        expect(calls.find((c) => c.method === 'mutePublishedTrack')).toBeUndefined();
    });

    test('pause / resume unknown producer throws', async () =>
    {
        const { adapter } = makeAdapter();
        await expect(adapter.pauseProducer('ghost')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
        await expect(adapter.resumeProducer('ghost')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
    });

    test('closeRouter calls deleteRoom and cascades close events', async () =>
    {
        const { adapter, calls } = makeAdapter();
        const r = await adapter.createRouter({ name: 'room-d' });
        const t1 = await adapter.createTransport(r, { id: 'p1' });
        const t2 = await adapter.createTransport(r, { id: 'p2' });
        const p = await adapter.produce(t1, 'video', {});
        await adapter.consume(t2, p.id, {});
        const events = [];
        adapter.onEvent((e) => events.push(e));
        await adapter.closeRouter('room-d');
        expect(calls.find((c) => c.method === 'deleteRoom' && c.name === 'room-d')).toBeTruthy();
        expect(events.filter((e) => e === 'transport-close')).toHaveLength(2);
        expect(events).toContain('producer-close');
        expect(events).toContain('consumer-close');
        expect(events).toContain('router-close');
    });

    test('closeRouter is a no-op when router is unknown', async () =>
    {
        const { adapter, calls } = makeAdapter();
        await adapter.closeRouter('nope');
        expect(calls.find((c) => c.method === 'deleteRoom')).toBeUndefined();
    });

    test('closeRouter emits router-close-error when deleteRoom rejects', async () =>
    {
        const { adapter, livekit } = makeAdapter();
        const r = await adapter.createRouter({ name: 'room-e' });
        // monkey-patch the client to simulate a server error
        adapter._client.deleteRoom = async () => { throw new Error('boom'); };
        const events = [];
        adapter.onEvent((e, p) => events.push([e, p]));
        await adapter.closeRouter(r.id);
        const errEv = events.find(([e]) => e === 'router-close-error');
        expect(errEv).toBeTruthy();
        expect(errEv[1].error).toBe('boom');
        // and still emits the final router-close so the hub can drop state
        expect(events.find(([e]) => e === 'router-close')).toBeTruthy();
        expect(livekit).toBeTruthy();
    });

    test('stats() returns global, router, and transport scopes', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter({ name: 'room-f' });
        const t = await adapter.createTransport(r, { id: 'pp' });
        await adapter.produce(t, 'audio', {});
        const g = await adapter.stats();
        expect(g.kind).toBe('global');
        expect(g.routers).toBe(1);
        expect(g.transports).toBe(1);
        expect(g.producers).toBe(1);
        expect(Array.isArray(g.rooms)).toBe(true);
        const rs = await adapter.stats(r.id);
        expect(rs.kind).toBe('router');
        expect(rs.routerId).toBe(r.id);
        expect(Array.isArray(rs.participants)).toBe(true);
        const ts = await adapter.stats(t.id);
        expect(ts.kind).toBe('transport');
        expect(ts.identity).toBe('pp');
    });

    test('stats swallows REST errors and returns nulls', async () =>
    {
        const { adapter } = makeAdapter();
        adapter._client.listRooms        = async () => { throw new Error('down'); };
        adapter._client.listParticipants = async () => { throw new Error('down'); };
        const r = await adapter.createRouter();
        const g = await adapter.stats();
        expect(g.rooms).toBeNull();
        const rs = await adapter.stats(r.id);
        expect(rs.participants).toBeNull();
    });
});

describe('LiveKitSfuAdapter - extended REST + Phase-2 surface', () =>
{
    test('listParticipants / removeParticipant / updateRoomMetadata pass through', async () =>
    {
        const { adapter } = makeAdapter();
        const removed = [];
        const meta    = [];
        adapter._client.removeParticipant   = async (room, id) => { removed.push([room, id]); };
        adapter._client.updateRoomMetadata  = async (room, m)  => { meta.push([room, m]); };
        const r = await adapter.createRouter({ name: 'rrr' });
        await expect(adapter.listParticipants(r.id)).resolves.toEqual([]);
        await adapter.removeParticipant(r.id, 'kicked');
        await adapter.updateRoomMetadata(r.id, { foo: 1 });
        expect(removed).toEqual([['rrr', 'kicked']]);
        expect(meta).toEqual([['rrr', '{"foo":1}']]);
    });

    test('removeParticipant throws NOT_SUPPORTED when client lacks the method', async () =>
    {
        const { adapter } = makeAdapter();
        adapter._client.removeParticipant = undefined;
        await expect(adapter.removeParticipant('r', 'i'))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NOT_SUPPORTED' });
    });

    test('sendData forwards a binary payload to RoomServiceClient.sendData', async () =>
    {
        const { adapter } = makeAdapter();
        const sent = [];
        adapter._client.sendData = async (room, data, kind, dests) => { sent.push({ room, data, kind, dests }); };
        const r = await adapter.createRouter({ name: 'rd' });
        await adapter.sendData(r.id, { hello: 'world' });
        expect(sent).toHaveLength(1);
        expect(sent[0].room).toBe('rd');
        expect(Buffer.isBuffer(sent[0].data)).toBe(true);
        expect(sent[0].data.toString()).toBe('{"hello":"world"}');
    });

    test('egress methods delegate to EgressClient', async () =>
    {
        const { adapter, livekit } = makeAdapter();
        const log = [];
        class EgressClient
        {
            constructor(url, key, secret) { this.url = url; this.key = key; this.secret = secret; }
            async startRoomCompositeEgress(room, output, opts) { log.push(['rc', room, output, opts]); return { egressId: 'EG_1' }; }
            async startTrackEgress(room, output, trackId)      { log.push(['tr', room, output, trackId]); return { egressId: 'EG_2' }; }
            async stopEgress(egressId)                          { log.push(['stop', egressId]); return { egressId }; }
            async listEgress(opts)                              { log.push(['list', opts]); return [{ egressId: 'EG_1' }]; }
        }
        livekit.EgressClient = EgressClient;
        const r = await adapter.createRouter({ name: 'eg' });
        const a = await adapter.startRoomCompositeEgress(r.id, { fileOutput: 'x.mp4' });
        const b = await adapter.startTrackEgress(r.id, 'TR_42', { fileOutput: 'y.mp4' });
        const c = await adapter.stopEgress('EG_1');
        const d = await adapter.listEgress({ roomName: r.id });
        expect(a.egressId).toBe('EG_1');
        expect(b.egressId).toBe('EG_2');
        expect(c.egressId).toBe('EG_1');
        expect(d).toHaveLength(1);
        expect(log[0][0]).toBe('rc');
        expect(log[1][3]).toBe('TR_42');
    });

    test('egress without an EgressClient surfaces WEBRTC_SFU_NOT_INSTALLED', async () =>
    {
        const { adapter } = makeAdapter();
        await expect(adapter.startRoomCompositeEgress('r', {}))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NOT_INSTALLED' });
    });

    test('ingress delegates to IngressClient', async () =>
    {
        const { adapter, livekit } = makeAdapter();
        const log = [];
        class IngressClient
        {
            constructor() {}
            async createIngress(type, opts) { log.push(['create', type, opts]); return { ingressId: 'IN_1' }; }
            async deleteIngress(id)         { log.push(['delete', id]); return { ingressId: id }; }
        }
        livekit.IngressClient = IngressClient;
        const a = await adapter.createIngress({ inputType: 'WHIP_INPUT', roomName: 'r', name: 'whip' });
        const b = await adapter.deleteIngress('IN_1');
        expect(a.ingressId).toBe('IN_1');
        expect(b.ingressId).toBe('IN_1');
        expect(log[0][1]).toBe('WHIP_INPUT');
    });

    test('Phase-2 consumer controls behave as cooperative no-ops with validation', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const t = await adapter.createTransport(r);
        const p = await adapter.produce(t, 'video', {});
        const c = await adapter.consume(t, p.id, {});
        const events = [];
        adapter.onEvent((e) => events.push(e));
        await adapter.setConsumerPreferredLayers(c.id, { spatialLayer: 0 });
        await adapter.setConsumerPriority(c.id, 5);
        await adapter.requestKeyFrame(c.id);
        await adapter.pauseConsumer(c.id);
        await adapter.resumeConsumer(c.id);
        expect(events).toContain('consumer-layers-change');
        expect(events).toContain('consumer-priority');
        expect(events).toContain('consumer-pause');
        expect(events).toContain('consumer-resume');
        await expect(adapter.setConsumerPreferredLayers('nope', { spatialLayer: 0 }))
            .rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_CONSUMER' });
    });

    test('setTransportBitrates records the clamps', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const t = await adapter.createTransport(r);
        await adapter.setTransportBitrates(t.id, { maxIncoming: 1, maxOutgoing: 2 });
        expect(adapter._transports.get(t.id).bitrates).toEqual({ maxIncoming: 1, maxOutgoing: 2 });
    });

    test('produceData / consumeData manufacture synthetic data channels', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const t = await adapter.createTransport(r);
        const dp = await adapter.produceData(t, { label: 'chat' });
        const dc = await adapter.consumeData(t, dp.id, {});
        expect(dp.dataProducerId).toMatch(/^dataProducer-/);
        expect(dc.dataConsumerId).toMatch(/^dataConsumer-/);
        expect(dc.dataProducerId).toBe(dp.id);
    });

    test('observers return closable handles that emit through _emit', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const events = [];
        adapter.onEvent((e, p) => events.push([e, p]));
        const al = await adapter.observeAudioLevels(r.id, {});
        const as = await adapter.observeActiveSpeaker(r.id, {});
        al.emit([{ producerId: 'x', volume: -20 }]);
        as.emit('px');
        expect(events.some(([e]) => e === 'audio-level')).toBe(true);
        expect(events.some(([e]) => e === 'active-speaker')).toBe(true);
        await al.close();
        await as.close();
    });

    test('pipeToRouter is not supported by LiveKit', async () =>
    {
        const { adapter } = makeAdapter();
        await expect(adapter.pipeToRouter({})).rejects.toMatchObject({ code: 'WEBRTC_SFU_NOT_SUPPORTED' });
    });

    test('per-entity stats return empty arrays and validate ids', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const t = await adapter.createTransport(r);
        const p = await adapter.produce(t, 'audio', {});
        const c = await adapter.consume(t, p.id, {});
        await expect(adapter.getProducerStats(p.id)).resolves.toEqual([]);
        await expect(adapter.getConsumerStats(c.id)).resolves.toEqual([]);
        await expect(adapter.getTransportStats(t.id)).resolves.toEqual([]);
        await expect(adapter.getProducerStats('nope')).rejects.toMatchObject({ code: 'WEBRTC_SFU_NO_PRODUCER' });
    });

    test('enableTraceEvent emits trace-enabled', async () =>
    {
        const { adapter } = makeAdapter();
        const r = await adapter.createRouter();
        const events = [];
        adapter.onEvent((e, p) => events.push([e, p]));
        await adapter.enableTraceEvent(r.id, ['probation']);
        expect(events).toContainEqual(['trace-enabled', { routerId: r.id, types: ['probation'] }]);
    });
});

describe('loadSfuAdapter("livekit") without peerDep', () =>
{
    test('throws WEBRTC_SFU_NOT_INSTALLED with install hint', () =>
    {
        try
        {
            loadSfuAdapter('livekit', { url: 'wss://x', apiKey: 'K', apiSecret: 'S' });
            throw new Error('expected loadSfuAdapter to throw');
        }
        catch (err)
        {
            expect(err).toBeInstanceOf(WebRTCError);
            expect(err.code).toBe('WEBRTC_SFU_NOT_INSTALLED');
            expect(err.message).toMatch(/livekit-server-sdk/);
        }
    });
});
