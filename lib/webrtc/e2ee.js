/**
 * @module webrtc/e2ee
 * @description End-to-end-encrypted key relay channel for WebRTC.
 *
 *   The hub never sees plaintext SFrame / Insertable-Streams keys.
 *   Publishers wrap each rotation in a sealed envelope (X25519 ECDH +
 *   HKDF-SHA-256 + AES-256-GCM) and broadcast it via the `e2ee-key`
 *   wire message; subscribers in the same room receive the sealed
 *   payload and decrypt locally with their private key.
 *
 *   For deployments that use a different sealing primitive (NaCl
 *   `crypto_box_seal`, libsignal, etc.) the {@link E2eeChannel} works
 *   with any opaque `Buffer` - the {@link sealKey} / {@link openSealedKey}
 *   helpers are provided as a zero-dependency default that satisfies the
 *   HIPAA / FINRA "server is opaque" requirement.
 *
 * @section E2EE
 */

'use strict';

const {
    createPublicKey, createPrivateKey,
    generateKeyPairSync,
    diffieHellman,
    hkdfSync,
    createCipheriv, createDecipheriv,
    randomBytes,
} = require('node:crypto');

const { WebRTCError } = require('../errors');

// --- Envelope constants ---

/** Envelope version byte. */
const ENVELOPE_VERSION = 0x01;

/** Raw X25519 key length, bytes. */
const X25519_RAW_LEN = 32;

/** AES-256-GCM nonce length, bytes. */
const GCM_NONCE_LEN = 12;

/** AES-256-GCM auth tag length, bytes. */
const GCM_TAG_LEN = 16;

/** HKDF salt - a short constant tying the envelope to this project. */
const HKDF_INFO = Buffer.from('zs-webrtc/e2ee/v1');

// --- Raw <-> KeyObject helpers ---

function _rawFromPublicKey(pub)
{
    if (Buffer.isBuffer(pub) && pub.length === X25519_RAW_LEN) return pub;
    const jwk = pub.export({ format: 'jwk' });
    return Buffer.from(jwk.x, 'base64url');
}

function _publicKeyFromRaw(raw)
{
    return createPublicKey({
        key:    { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
        format: 'jwk',
    });
}

// --- Public crypto helpers ---

/**
 * Generate a fresh X25519 keypair suitable for {@link sealKey} /
 * {@link openSealedKey}.
 *
 * @returns {{publicKey: KeyObject, privateKey: KeyObject}}
 *
 * @example
 *   const { publicKey, privateKey } = generateE2eeKeyPair();
 *   const wireKey = publicKey.export({ format: 'jwk' }).x; // base64url
 */
function generateE2eeKeyPair()
{
    return generateKeyPairSync('x25519');
}

/**
 * Seal an opaque byte string for a single recipient using the project's
 * default envelope (X25519 ECDH + HKDF-SHA-256 + AES-256-GCM).
 *
 * Envelope layout:
 *
 *   `[ver:1] [ephPubRaw:32] [nonce:12] [ciphertext:N] [tag:16]`
 *
 * @param {Buffer|Uint8Array} plaintext        - The bytes to encrypt.
 * @param {KeyObject|Buffer}  recipientPubKey  - Recipient's X25519 public
 *                                                key (KeyObject or 32-byte raw).
 * @returns {Buffer} The sealed envelope.
 *
 * @example
 *   const sealed = sealKey(Buffer.from(sframeKey), bob.publicKey);
 *   peer.e2ee.publish(epoch, sealed);
 */
function sealKey(plaintext, recipientPubKey)
{
    const pt    = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
    const pubKO = Buffer.isBuffer(recipientPubKey) ? _publicKeyFromRaw(recipientPubKey) : recipientPubKey;

    const eph    = generateKeyPairSync('x25519');
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pubKO });
    const ephRaw = _rawFromPublicKey(eph.publicKey);
    const recRaw = _rawFromPublicKey(pubKO);

    const salt = Buffer.concat([ephRaw, recRaw]);
    const aesKey = Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, 32));

    const nonce  = randomBytes(GCM_NONCE_LEN);
    const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
    const ct     = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag    = cipher.getAuthTag();

    return Buffer.concat([Buffer.from([ENVELOPE_VERSION]), ephRaw, nonce, ct, tag]);
}

/**
 * Open an envelope produced by {@link sealKey} with the recipient's private
 * key.  Throws if the envelope is malformed, was sealed for a different
 * recipient, or was tampered with in flight.
 *
 * @param {Buffer|Uint8Array} sealed     - Sealed envelope.
 * @param {KeyObject|Buffer} recipientPrivKey - Recipient's X25519 private key.
 * @returns {Buffer} Decrypted plaintext.
 * @throws {WebRTCError} `code='E2EE_OPEN_FAILED'` on any failure.
 *
 * @example
 *   const sframeKey = openSealedKey(received.key, bob.privateKey);
 */
function openSealedKey(sealed, recipientPrivKey)
{
    const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
    const minLen = 1 + X25519_RAW_LEN + GCM_NONCE_LEN + GCM_TAG_LEN;
    if (buf.length < minLen)
        throw new WebRTCError('sealed envelope too short', { code: 'E2EE_OPEN_FAILED' });
    if (buf[0] !== ENVELOPE_VERSION)
        throw new WebRTCError(`unsupported envelope version 0x${buf[0].toString(16)}`, { code: 'E2EE_OPEN_FAILED' });

    const ephRaw = buf.subarray(1, 1 + X25519_RAW_LEN);
    const nonce  = buf.subarray(1 + X25519_RAW_LEN, 1 + X25519_RAW_LEN + GCM_NONCE_LEN);
    const tag    = buf.subarray(buf.length - GCM_TAG_LEN);
    const ct     = buf.subarray(1 + X25519_RAW_LEN + GCM_NONCE_LEN, buf.length - GCM_TAG_LEN);

    try
    {
        const privKO = Buffer.isBuffer(recipientPrivKey) ? createPrivateKey({ key: recipientPrivKey, format: 'der', type: 'pkcs8' }) : recipientPrivKey;
        const ephPub = _publicKeyFromRaw(ephRaw);
        const shared = diffieHellman({ privateKey: privKO, publicKey: ephPub });

        const recPubRaw = _rawFromPublicKey(createPublicKey(privKO));
        const salt = Buffer.concat([ephRaw, recPubRaw]);
        const aesKey = Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, 32));

        const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    }
    catch (err)
    {
        throw new WebRTCError(`failed to open sealed envelope: ${err.message}`, { code: 'E2EE_OPEN_FAILED' });
    }
}

// --- E2eeChannel ---

/**
 * Per-peer view of the room's E2EE key channel.  Created by
 * {@link attachE2ee} and parked on `peer.e2ee`.
 *
 * Maintains a monotonically increasing `epoch` that callers may either
 * supply explicitly or let the channel allocate.  Every `publish()` is
 * relayed by the hub to all other peers in the same room as an opaque
 * `e2ee-key` frame - the hub never inspects or decrypts the payload.
 *
 * @class
 * @section E2EE
 */
class E2eeChannel
{
    /**
     * @constructor
     * @param {Peer} peer
     * @param {SignalingHub} hub
     */
    constructor(peer, hub)
    {
        /** @type {Peer} */
        this.peer = peer;
        /** @type {SignalingHub} */
        this.hub  = hub;
        /** @type {number} Last published or observed epoch. */
        this.epoch = 0;
    }

    /**
     * Broadcast a sealed key to the rest of the peer's room.
     *
     * @param {number|null} epoch - Explicit epoch, or `null` to auto-increment.
     * @param {Buffer|Uint8Array|string} key - Sealed bytes (or wire-ready string).
     * @returns {number} The epoch the key was published under.
     *
     * @example
     *   const sealed = sealKey(sframeKey, bob.publicKey);
     *   const epoch  = peer.e2ee.publish(null, sealed);
     */
    publish(epoch, key)
    {
        const ep = (typeof epoch === 'number') ? epoch : (this.epoch + 1);
        if (ep > this.epoch) this.epoch = ep;

        let wire;
        if (typeof key === 'string') wire = key;
        else if (Buffer.isBuffer(key)) wire = key.toString('base64');
        else wire = Buffer.from(key).toString('base64');

        // Route through the hub's authoritative handler so all the usual
        // validation, broadcast, and observability hooks fire.
        this.hub._handleE2eeKey(this.peer, { type: 'e2ee-key', epoch: ep, key: wire });
        return ep;
    }

    /**
     * Receive sealed keys published by *other* peers in the same room.
     *
     * @param {(ev: {from: string, epoch: number, key: Buffer}) => void} fn
     * @returns {() => void} Unsubscribe function.
     *
     * @example
     *   peer.e2ee.subscribe(({ from, epoch, key }) => {
     *       const sframeKey = openSealedKey(key, myPrivKey);
     *       sframeContext.setKey(epoch, sframeKey);
     *   });
     */
    subscribe(fn)
    {
        const listener = (ev) =>
        {
            if (!ev || ev.peer === this.peer) return;
            if (this.peer.room && ev.peer.room !== this.peer.room) return;
            if (ev.epoch > this.epoch) this.epoch = ev.epoch;
            const keyBuf = Buffer.isBuffer(ev.key) ? ev.key : Buffer.from(ev.key, 'base64');
            try { fn({ from: ev.peer.id, epoch: ev.epoch, key: keyBuf }); }
            catch { /* don't let subscriber errors break the hub */ }
        };
        this.hub.on('e2eeKey', listener);
        return () => this.hub.off('e2eeKey', listener);
    }
}

/**
 * Install an {@link E2eeChannel} on a peer as `peer.e2ee`.  Idempotent: a
 * second call returns the existing channel.
 *
 * @param {Peer} peer
 * @param {SignalingHub} hub
 * @returns {E2eeChannel}
 *
 * @section E2EE
 *
 * @example | Attach E2EE on every join
 *   hub.on('join', ({ peer }) => attachE2ee(peer, hub));
 */
function attachE2ee(peer, hub)
{
    if (peer.e2ee instanceof E2eeChannel) return peer.e2ee;
    peer.e2ee = new E2eeChannel(peer, hub);
    return peer.e2ee;
}

module.exports = {
    ENVELOPE_VERSION,
    E2eeChannel,
    attachE2ee,
    generateE2eeKeyPair,
    sealKey,
    openSealedKey,
};
