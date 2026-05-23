/**
 * Embedded TURN server (RFC 5766) end-to-end tests.
 *
 *   Drives a real {@link TurnServer} bound on 127.0.0.1:0 via raw `dgram`
 *   sockets and the codec helpers in `lib/webrtc/turn/codec.js`.  Covers
 *   constructor validation, auth challenge / replay, Allocate / Refresh /
 *   CreatePermission / Send / ChannelBind, Data indication round-trips,
 *   and per-user allocation quotas.
 */
'use strict';

const dgram  = require('node:dgram');
const crypto = require('node:crypto');
const path   = require('node:path');

const { TurnServer } = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc', 'turn', 'server'));
const codec          = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc', 'turn', 'codec'));
const { issueTurnCredentials } = require(path.resolve(__dirname, '..', '..', 'lib', 'webrtc', 'turn', 'credentials'));

const {
    STUN_CLASS, TURN_METHOD, ATTR, PROTO_UDP,
    encodeMessage, decodeMessage, getAttr,
    longTermKey, encodeUInt32, encodeRequestedTransport,
    encodeXorAddress, decodeXorAddress,
    encodeChannelNumber, encodeChannelData, decodeChannelData,
    decodeErrorCode,
} = codec;

// ---------------------------------------------------------------------------
//  Test helpers
// ---------------------------------------------------------------------------

const SECRET = 'super-secret-shared-key';
const REALM  = 'rtc.test';

function newTxid() { return crypto.randomBytes(12); }

/** Derive (username, password, key) for `userId` using REST-API ephemeral creds. */
function makeCredentials(userId, ttl = 300, secret = SECRET, realm = REALM)
{
    const expiry   = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:${userId}`;
    const password = crypto.createHmac('sha1', secret).update(username).digest('base64');
    return { username, password, key: longTermKey(username, realm, password) };
}

/** Send a datagram and wait for the next reply on `client`. */
function sendAndWait(client, buf, port, address, timeout = 1500)
{
    return new Promise((resolve, reject) =>
    {
        const t = setTimeout(() =>
        {
            client.removeListener('message', onMsg);
            reject(new Error('timeout waiting for TURN reply'));
        }, timeout);
        const onMsg = (data, rinfo) =>
        {
            clearTimeout(t);
            client.removeListener('message', onMsg);
            resolve({ data, rinfo });
        };
        client.on('message', onMsg);
        client.send(buf, port, address);
    });
}

/** Wait for the next inbound datagram on `sock`. */
function waitMessage(sock, timeout = 1500)
{
    return new Promise((resolve, reject) =>
    {
        const t = setTimeout(() =>
        {
            sock.removeListener('message', onMsg);
            reject(new Error('timeout waiting for datagram'));
        }, timeout);
        const onMsg = (data, rinfo) =>
        {
            clearTimeout(t);
            sock.removeListener('message', onMsg);
            resolve({ data, rinfo });
        };
        sock.on('message', onMsg);
    });
}

/** Bind a fresh udp4 socket on 127.0.0.1:0. */
function bindClient()
{
    return new Promise((resolve) =>
    {
        const s = dgram.createSocket('udp4');
        s.bind(0, '127.0.0.1', () => resolve(s));
    });
}

/** Build an authenticated TURN request. */
function buildAuthedRequest(method, txid, extraAttrs, creds, nonce, realm)
{
    const attrs = [
        ...extraAttrs,
        { type: ATTR.USERNAME, value: Buffer.from(creds.username, 'utf8') },
        { type: ATTR.REALM,    value: Buffer.from(realm,          'utf8') },
        { type: ATTR.NONCE,    value: Buffer.from(nonce,          'utf8') },
    ];
    return encodeMessage(method, STUN_CLASS.REQUEST, txid, attrs, creds.key);
}

/** Two-step Allocate: send unauthed, capture NONCE+REALM, send authed. */
async function allocate(client, server, creds, extraAttrs = [])
{
    const txid1 = newTxid();
    const probe = encodeMessage(TURN_METHOD.ALLOCATE, STUN_CLASS.REQUEST, txid1, [
        { type: ATTR.REQUESTED_TRANSPORT, value: encodeRequestedTransport(PROTO_UDP) },
    ]);
    const first = await sendAndWait(client, probe, server.port, server.address);
    const firstMsg = decodeMessage(first.data);
    const nonceBuf = getAttr(firstMsg, ATTR.NONCE);
    const realmBuf = getAttr(firstMsg, ATTR.REALM);
    if (!nonceBuf || !realmBuf) throw new Error('expected 401 challenge with NONCE+REALM');
    const nonce = nonceBuf.toString('utf8');
    const realm = realmBuf.toString('utf8');

    const txid2 = newTxid();
    const req = buildAuthedRequest(
        TURN_METHOD.ALLOCATE, txid2,
        [{ type: ATTR.REQUESTED_TRANSPORT, value: encodeRequestedTransport(PROTO_UDP) }, ...extraAttrs],
        creds, nonce, realm,
    );
    const second = await sendAndWait(client, req, server.port, server.address);
    const secondMsg = decodeMessage(second.data);
    return { firstMsg, secondMsg, nonce, realm, txid: txid2 };
}

// ---------------------------------------------------------------------------
//  Suite
// ---------------------------------------------------------------------------

describe('TurnServer', () =>
{
    let server, addr, client;

    afterEach(async () =>
    {
        try { if (client) await new Promise((r) => client.close(r)); } catch (_) { /* */ }
        client = null;
        if (server) await server.stop();
        server = null;
    });

    describe('constructor', () =>
    {
        it('requires opts.secret', () =>
        {
            expect(() => new TurnServer({ listeners: [{ proto: 'udp', port: 0 }] })).toThrow(/secret is required/);
        });

        it('requires non-empty opts.listeners', () =>
        {
            expect(() => new TurnServer({ secret: 's', listeners: [] })).toThrow(/listeners/);
            expect(() => new TurnServer({ secret: 's' })).toThrow(/listeners/);
        });

        it('defaults realm to "zero-server"', () =>
        {
            const s = new TurnServer({ secret: 's', listeners: [{ proto: 'udp', port: 0 }] });
            expect(s.realm).toBe('zero-server');
        });

        it('honours custom realm', () =>
        {
            const s = new TurnServer({ secret: 's', realm: 'x', listeners: [{ proto: 'udp', port: 0 }] });
            expect(s.realm).toBe('x');
        });
    });

    describe('start/stop', () =>
    {
        it('binds an ephemeral UDP port and exposes address()', async () =>
        {
            server = new TurnServer({ secret: SECRET, realm: REALM, listeners: [{ proto: 'udp', port: 0 }] });
            await server.start();
            const a = server.address();
            expect(a).toBeTruthy();
            expect(a.port).toBeGreaterThan(0);
        });

        it('throws TURN_TRANSPORT_UNSUPPORTED for tcp listeners', async () =>
        {
            server = new TurnServer({ secret: SECRET, listeners: [{ proto: 'tcp', port: 0 }] });
            await expect(server.start()).rejects.toThrow(/tcp listeners are not implemented/);
            server = null; // already failed; nothing to stop
        });
    });

    describe('Allocate', () =>
    {
        beforeEach(async () =>
        {
            server = new TurnServer({ secret: SECRET, realm: REALM, listeners: [{ proto: 'udp', port: 0 }] });
            await server.start();
            addr = server.address();
            client = await bindClient();
        });

        it('responds 401 + REALM + NONCE to an unauthenticated request', async () =>
        {
            const txid = newTxid();
            const buf = encodeMessage(TURN_METHOD.ALLOCATE, STUN_CLASS.REQUEST, txid, [
                { type: ATTR.REQUESTED_TRANSPORT, value: encodeRequestedTransport(PROTO_UDP) },
            ]);
            const { data } = await sendAndWait(client, buf, addr.port, addr.address);
            const msg = decodeMessage(data);
            expect(msg.method).toBe(TURN_METHOD.ALLOCATE);
            expect(msg.class).toBe(STUN_CLASS.ERROR);
            const errBuf = getAttr(msg, ATTR.ERROR_CODE);
            const err = decodeErrorCode(errBuf);
            expect(err.code).toBe(401);
            expect(getAttr(msg, ATTR.REALM).toString('utf8')).toBe(REALM);
            expect(getAttr(msg, ATTR.NONCE)).toBeTruthy();
        });

        it('completes allocation when authenticated and returns relay + mapped + lifetime', async () =>
        {
            const creds = makeCredentials('alice');
            const { secondMsg, txid } = await allocate(client, addr, creds);
            expect(secondMsg.class).toBe(STUN_CLASS.SUCCESS);
            const relayBuf  = getAttr(secondMsg, ATTR.XOR_RELAYED_ADDRESS);
            const mappedBuf = getAttr(secondMsg, ATTR.XOR_MAPPED_ADDRESS);
            const lifetimeBuf = getAttr(secondMsg, ATTR.LIFETIME);
            expect(relayBuf).toBeTruthy();
            expect(mappedBuf).toBeTruthy();
            expect(lifetimeBuf).toBeTruthy();
            const relay  = decodeXorAddress(relayBuf,  txid);
            const mapped = decodeXorAddress(mappedBuf, txid);
            expect(relay.port).toBeGreaterThan(0);
            expect(mapped.port).toBe(client.address().port);
            expect(lifetimeBuf.readUInt32BE(0)).toBeGreaterThanOrEqual(60);
        });

        it('rejects unsupported REQUESTED-TRANSPORT with 442', async () =>
        {
            // First, get a nonce via 401.
            const txid1 = newTxid();
            const probe = encodeMessage(TURN_METHOD.ALLOCATE, STUN_CLASS.REQUEST, txid1, [
                { type: ATTR.REQUESTED_TRANSPORT, value: encodeRequestedTransport(PROTO_UDP) },
            ]);
            const first = await sendAndWait(client, probe, addr.port, addr.address);
            const m1    = decodeMessage(first.data);
            const nonce = getAttr(m1, ATTR.NONCE).toString('utf8');

            const creds = makeCredentials('bob');
            const txid2 = newTxid();
            const req = buildAuthedRequest(
                TURN_METHOD.ALLOCATE, txid2,
                [{ type: ATTR.REQUESTED_TRANSPORT, value: encodeRequestedTransport(6 /* TCP */) }],
                creds, nonce, REALM,
            );
            const { data } = await sendAndWait(client, req, addr.port, addr.address);
            const msg = decodeMessage(data);
            expect(msg.class).toBe(STUN_CLASS.ERROR);
            expect(decodeErrorCode(getAttr(msg, ATTR.ERROR_CODE)).code).toBe(442);
        });

        it('rejects expired ephemeral usernames', async () =>
        {
            const expired = `${Math.floor(Date.now() / 1000) - 60}:carol`;
            const password = crypto.createHmac('sha1', SECRET).update(expired).digest('base64');
            const creds = { username: expired, password, key: longTermKey(expired, REALM, password) };
            const { secondMsg } = await allocate(client, addr, creds);
            expect(secondMsg.class).toBe(STUN_CLASS.ERROR);
            expect(decodeErrorCode(getAttr(secondMsg, ATTR.ERROR_CODE)).code).toBe(401);
        });
    });

    describe('Quotas', () =>
    {
        it('returns 486 when maxAllocationsPerUser is exceeded', async () =>
        {
            server = new TurnServer({
                secret: SECRET, realm: REALM,
                listeners: [{ proto: 'udp', port: 0 }],
                quotas: { maxAllocationsPerUser: 1 },
            });
            await server.start();
            addr = server.address();
            const c1 = await bindClient();
            const c2 = await bindClient();
            try
            {
                const creds = makeCredentials('alice');
                const r1 = await allocate(c1, addr, creds);
                expect(r1.secondMsg.class).toBe(STUN_CLASS.SUCCESS);
                const r2 = await allocate(c2, addr, creds);
                expect(r2.secondMsg.class).toBe(STUN_CLASS.ERROR);
                expect(decodeErrorCode(getAttr(r2.secondMsg, ATTR.ERROR_CODE)).code).toBe(486);
            }
            finally
            {
                await new Promise((r) => c1.close(r));
                await new Promise((r) => c2.close(r));
            }
        });
    });

    describe('Refresh', () =>
    {
        beforeEach(async () =>
        {
            server = new TurnServer({ secret: SECRET, realm: REALM, listeners: [{ proto: 'udp', port: 0 }] });
            await server.start();
            addr = server.address();
            client = await bindClient();
        });

        it('extends the lifetime and frees the allocation when lifetime=0', async () =>
        {
            const creds = makeCredentials('alice');
            const { nonce } = await allocate(client, addr, creds);

            // Refresh with explicit lifetime=120.
            const txid = newTxid();
            const req = buildAuthedRequest(
                TURN_METHOD.REFRESH, txid,
                [{ type: ATTR.LIFETIME, value: encodeUInt32(120) }],
                creds, nonce, REALM,
            );
            const { data } = await sendAndWait(client, req, addr.port, addr.address);
            const m = decodeMessage(data);
            expect(m.class).toBe(STUN_CLASS.SUCCESS);
            expect(getAttr(m, ATTR.LIFETIME).readUInt32BE(0)).toBe(120);

            // Refresh with lifetime=0 frees.
            const txid2 = newTxid();
            const free = buildAuthedRequest(
                TURN_METHOD.REFRESH, txid2,
                [{ type: ATTR.LIFETIME, value: encodeUInt32(0) }],
                creds, nonce, REALM,
            );
            const evt = new Promise((r) => server.once('deallocation', r));
            const { data: data2 } = await sendAndWait(client, free, addr.port, addr.address);
            const m2 = decodeMessage(data2);
            expect(m2.class).toBe(STUN_CLASS.SUCCESS);
            expect(getAttr(m2, ATTR.LIFETIME).readUInt32BE(0)).toBe(0);
            const evPayload = await evt;
            expect(evPayload.userId).toBe('alice');
        });
    });

    describe('Send / Data round trip', () =>
    {
        let peer, peerAddr;
        beforeEach(async () =>
        {
            server = new TurnServer({ secret: SECRET, realm: REALM, listeners: [{ proto: 'udp', port: 0 }] });
            await server.start();
            addr = server.address();
            client = await bindClient();
            peer = await bindClient();
            peerAddr = peer.address();
        });
        afterEach(async () =>
        {
            try { await new Promise((r) => peer.close(r)); } catch (_) { /* */ }
        });

        it('relays Send Indication to the peer after CreatePermission', async () =>
        {
            const creds = makeCredentials('alice');
            const { secondMsg, nonce, txid: allocTxid } = await allocate(client, addr, creds);
            const relay = decodeXorAddress(getAttr(secondMsg, ATTR.XOR_RELAYED_ADDRESS), allocTxid);

            // CreatePermission for 127.0.0.1
            const permTxid = newTxid();
            const permReq = buildAuthedRequest(
                TURN_METHOD.CREATE_PERMISSION, permTxid,
                [{ type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress(peerAddr.address, peerAddr.port, permTxid) }],
                creds, nonce, REALM,
            );
            const permResp = await sendAndWait(client, permReq, addr.port, addr.address);
            expect(decodeMessage(permResp.data).class).toBe(STUN_CLASS.SUCCESS);

            // Send Indication carrying "hello"
            const sendTxid = newTxid();
            const payload  = Buffer.from('hello-turn');
            const ind = encodeMessage(TURN_METHOD.SEND, STUN_CLASS.INDICATION, sendTxid, [
                { type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress(peerAddr.address, peerAddr.port, sendTxid) },
                { type: ATTR.DATA,             value: payload },
            ]);
            const peerRecv = waitMessage(peer);
            client.send(ind, addr.port, addr.address);
            const got = await peerRecv;
            expect(got.data.toString()).toBe('hello-turn');
            expect(got.rinfo.address).toBe(relay.address);
            expect(got.rinfo.port).toBe(relay.port);
        });

        it('drops Send Indication when no permission exists', async () =>
        {
            const creds = makeCredentials('alice');
            await allocate(client, addr, creds);

            const sendTxid = newTxid();
            const ind = encodeMessage(TURN_METHOD.SEND, STUN_CLASS.INDICATION, sendTxid, [
                { type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress(peerAddr.address, peerAddr.port, sendTxid) },
                { type: ATTR.DATA,             value: Buffer.from('nope') },
            ]);
            let received = null;
            const onMsg = (data) => { received = data; };
            peer.on('message', onMsg);
            client.send(ind, addr.port, addr.address);
            await new Promise((r) => setTimeout(r, 120));
            peer.removeListener('message', onMsg);
            expect(received).toBeNull();
        });

        it('wraps peer datagrams in a DATA indication back to the client', async () =>
        {
            const creds = makeCredentials('alice');
            const { secondMsg, nonce, txid: allocTxid } = await allocate(client, addr, creds);
            const relay = decodeXorAddress(getAttr(secondMsg, ATTR.XOR_RELAYED_ADDRESS), allocTxid);

            // Permission first.
            const permTxid = newTxid();
            const permReq = buildAuthedRequest(
                TURN_METHOD.CREATE_PERMISSION, permTxid,
                [{ type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress(peerAddr.address, peerAddr.port, permTxid) }],
                creds, nonce, REALM,
            );
            await sendAndWait(client, permReq, addr.port, addr.address);

            const incoming = waitMessage(client);
            peer.send(Buffer.from('peer-says-hi'), relay.port, relay.address);
            const got = await incoming;
            const m = decodeMessage(got.data);
            expect(m.method).toBe(TURN_METHOD.DATA);
            expect(m.class).toBe(STUN_CLASS.INDICATION);
            const fromBuf = getAttr(m, ATTR.XOR_PEER_ADDRESS);
            const peerFrom = decodeXorAddress(fromBuf, m.transactionId);
            expect(peerFrom.address).toBe(peerAddr.address);
            expect(peerFrom.port).toBe(peerAddr.port);
            expect(getAttr(m, ATTR.DATA).toString()).toBe('peer-says-hi');
        });
    });

    describe('ChannelBind / ChannelData', () =>
    {
        let peer, peerAddr;
        beforeEach(async () =>
        {
            server = new TurnServer({ secret: SECRET, realm: REALM, listeners: [{ proto: 'udp', port: 0 }] });
            await server.start();
            addr = server.address();
            client = await bindClient();
            peer = await bindClient();
            peerAddr = peer.address();
        });
        afterEach(async () =>
        {
            try { await new Promise((r) => peer.close(r)); } catch (_) { /* */ }
        });

        it('binds a channel and relays ChannelData in both directions', async () =>
        {
            const creds = makeCredentials('alice');
            const { secondMsg, nonce, txid: allocTxid } = await allocate(client, addr, creds);
            const relay = decodeXorAddress(getAttr(secondMsg, ATTR.XOR_RELAYED_ADDRESS), allocTxid);

            const channel  = 0x4001;
            const bindTxid = newTxid();
            const bindReq = buildAuthedRequest(
                TURN_METHOD.CHANNEL_BIND, bindTxid,
                [
                    { type: ATTR.CHANNEL_NUMBER,   value: encodeChannelNumber(channel) },
                    { type: ATTR.XOR_PEER_ADDRESS, value: encodeXorAddress(peerAddr.address, peerAddr.port, bindTxid) },
                ],
                creds, nonce, REALM,
            );
            const bindResp = await sendAndWait(client, bindReq, addr.port, addr.address);
            expect(decodeMessage(bindResp.data).class).toBe(STUN_CLASS.SUCCESS);

            // Client -> peer via ChannelData
            const peerRecv = waitMessage(peer);
            client.send(encodeChannelData(channel, Buffer.from('cd-out')), addr.port, addr.address);
            const fromClient = await peerRecv;
            expect(fromClient.data.toString()).toBe('cd-out');

            // Peer -> client wrapped in ChannelData (since channel is bound)
            const clientRecv = waitMessage(client);
            peer.send(Buffer.from('cd-in'), relay.port, relay.address);
            const fromPeer = await clientRecv;
            const cd = decodeChannelData(fromPeer.data);
            expect(cd).toBeTruthy();
            expect(cd.channel).toBe(channel);
            expect(cd.payload.toString()).toBe('cd-in');
        });
    });

    it('issueTurnCredentials produces credentials that authenticate against the live server', async () =>
    {
        server = new TurnServer({ secret: SECRET, realm: REALM, listeners: [{ proto: 'udp', port: 0 }] });
        await server.start();
        addr = server.address();
        client = await bindClient();

        const creds = issueTurnCredentials({
            secret:  SECRET,
            userId:  'bob',
            servers: [`turn:${addr.address}:${addr.port}`],
            ttl:     300,
        });
        const key = longTermKey(creds.username, REALM, creds.credential);

        const { secondMsg } = await allocate(client, addr, { username: creds.username, password: creds.credential, key });
        expect(secondMsg.class).toBe(STUN_CLASS.SUCCESS);
    });
});
