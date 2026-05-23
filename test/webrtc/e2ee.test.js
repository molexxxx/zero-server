'use strict';

const { EventEmitter } = require('node:events');
const { SignalingHub } = require('../../lib/webrtc/signaling');
const {
    generateE2eeKeyPair,
    sealKey,
    openSealedKey,
    attachE2ee,
    E2eeChannel,
} = require('../../lib/webrtc/e2ee');

// --- Mock transport ---

class MockTransport extends EventEmitter
{
    constructor(meta = {}) { super(); this.ip = meta.ip || '127.0.0.1'; this.outbox = []; this.closed = false; }
    send(d) { if (!this.closed) this.outbox.push(JSON.parse(d)); }
    close(code, reason) { if (this.closed) return; this.closed = true; this.emit('close', code ?? 1000, reason ?? ''); }
    inject(o) { this.emit('message', typeof o === 'string' ? o : JSON.stringify(o)); }
    sent(t) { return this.outbox.filter(f => f.type === t); }
}

function attachJoinedPeer(hub, room = 'r')
{
    const t = new MockTransport();
    const peer = hub.attach(t);
    t.inject({ type: 'join', room });
    return { t, peer };
}

// --- Sealed-box helpers ---

describe('E2EE sealed-box helpers', () =>
{
    it('generateE2eeKeyPair returns two crypto KeyObjects of type x25519', () =>
    {
        const kp = generateE2eeKeyPair();
        expect(kp.publicKey.asymmetricKeyType).toBe('x25519');
        expect(kp.privateKey.asymmetricKeyType).toBe('x25519');
    });

    it('sealKey + openSealedKey round-trips an arbitrary buffer', () =>
    {
        const alice = generateE2eeKeyPair();
        const secret = Buffer.from('topsecret-sframe-key-256bits!!!!');
        const sealed = sealKey(secret, alice.publicKey);
        expect(Buffer.isBuffer(sealed)).toBe(true);
        expect(sealed.length).toBeGreaterThan(secret.length);

        const opened = openSealedKey(sealed, alice.privateKey);
        expect(Buffer.isBuffer(opened)).toBe(true);
        expect(opened.equals(secret)).toBe(true);
    });

    it('openSealedKey rejects ciphertext sealed for a different recipient', () =>
    {
        const alice = generateE2eeKeyPair();
        const bob   = generateE2eeKeyPair();
        const sealed = sealKey(Buffer.from('x'), alice.publicKey);
        expect(() => openSealedKey(sealed, bob.privateKey)).toThrow();
    });

    it('openSealedKey rejects a tampered envelope', () =>
    {
        const kp = generateE2eeKeyPair();
        const sealed = sealKey(Buffer.from('payload-here'), kp.publicKey);
        sealed[sealed.length - 1] ^= 0x01; // flip a tag bit
        expect(() => openSealedKey(sealed, kp.privateKey)).toThrow();
    });

    it('sealKey emits a versioned envelope (first byte = 0x01)', () =>
    {
        const kp = generateE2eeKeyPair();
        const sealed = sealKey(Buffer.from('hi'), kp.publicKey);
        expect(sealed[0]).toBe(0x01);
    });
});

// --- E2eeChannel + attachE2ee ---

describe('E2eeChannel - peer-level publish / subscribe', () =>
{
    function setup(roomName = 'r')
    {
        const hub = new SignalingHub();
        hub.room(roomName).open();
        return { hub };
    }

    it('attachE2ee installs peer.e2ee with publish / subscribe / epoch', () =>
    {
        const { hub } = setup();
        const { peer } = attachJoinedPeer(hub);
        attachE2ee(peer, hub);
        expect(peer.e2ee).toBeInstanceOf(E2eeChannel);
        expect(typeof peer.e2ee.publish).toBe('function');
        expect(typeof peer.e2ee.subscribe).toBe('function');
        expect(peer.e2ee.epoch).toBe(0);
    });

    it('publish broadcasts an e2ee-key frame to other peers in the room', () =>
    {
        const { hub } = setup();
        const a = attachJoinedPeer(hub);
        const b = attachJoinedPeer(hub);
        attachE2ee(a.peer, hub);

        a.peer.e2ee.publish(1, Buffer.from([0xab, 0xcd]));

        const got = b.t.sent('e2ee-key');
        expect(got.length).toBe(1);
        expect(got[0].epoch).toBe(1);
        expect(got[0].from).toBe(a.peer.id);
        expect(typeof got[0].key).toBe('string'); // base64 over the wire
    });

    it('publish auto-increments epoch when called without one', () =>
    {
        const { hub } = setup();
        const { peer } = attachJoinedPeer(hub);
        attachE2ee(peer, hub);
        const ep1 = peer.e2ee.publish(null, Buffer.from('k1'));
        const ep2 = peer.e2ee.publish(null, Buffer.from('k2'));
        expect(ep2).toBe(ep1 + 1);
        expect(peer.e2ee.epoch).toBe(ep2);
    });

    it('subscribe invokes the callback with {from, epoch, key} when another peer publishes', () =>
    {
        const { hub } = setup();
        const a = attachJoinedPeer(hub);
        const b = attachJoinedPeer(hub);
        attachE2ee(a.peer, hub);
        attachE2ee(b.peer, hub);

        const received = [];
        b.peer.e2ee.subscribe((ev) => received.push(ev));

        a.peer.e2ee.publish(5, Buffer.from('XYZ'));

        expect(received.length).toBe(1);
        expect(received[0].from).toBe(a.peer.id);
        expect(received[0].epoch).toBe(5);
        expect(Buffer.isBuffer(received[0].key)).toBe(true);
        expect(received[0].key.toString()).toBe('XYZ');
    });

    it('subscribe does NOT invoke the callback for the publisher itself', () =>
    {
        const { hub } = setup();
        const a = attachJoinedPeer(hub);
        attachE2ee(a.peer, hub);
        const seen = [];
        a.peer.e2ee.subscribe((ev) => seen.push(ev));
        a.peer.e2ee.publish(1, Buffer.from('only-self'));
        expect(seen.length).toBe(0);
    });

    it('subscribe is scoped to the publisher\'s room', () =>
    {
        const hub = new SignalingHub();
        hub.room('r1').open();
        hub.room('r2').open();
        const a = attachJoinedPeer(hub, 'r1');
        const b = attachJoinedPeer(hub, 'r2');
        attachE2ee(a.peer, hub);
        attachE2ee(b.peer, hub);
        const seen = [];
        b.peer.e2ee.subscribe((ev) => seen.push(ev));
        a.peer.e2ee.publish(1, Buffer.from('x'));
        expect(seen.length).toBe(0);
    });

    it('server never sees plaintext - the relayed payload equals the sealed bytes the publisher provided', () =>
    {
        const { hub } = setup();
        const alice = attachJoinedPeer(hub);
        const bob   = attachJoinedPeer(hub);
        attachE2ee(alice.peer, hub);
        attachE2ee(bob.peer, hub);

        const bobKp = generateE2eeKeyPair();
        const sframeKey = Buffer.from('32-byte-sframe-secret-XXXXXXXXXX');
        const sealed = sealKey(sframeKey, bobKp.publicKey);

        let received;
        bob.peer.e2ee.subscribe((ev) => { received = ev; });
        alice.peer.e2ee.publish(1, sealed);

        // Bob can open it; server only saw the ciphertext.
        const opened = openSealedKey(received.key, bobKp.privateKey);
        expect(opened.equals(sframeKey)).toBe(true);
    });
});
