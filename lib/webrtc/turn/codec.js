/**
 * @module webrtc/turn/codec
 * @description Zero-dependency TURN (RFC 5766 / 8656) message + attribute
 *              codec used by the embedded {@link TurnServer}.  Re-uses the
 *              core STUN framing helpers in `lib/webrtc/stun.js`.
 *
 *   Implements the subset of attributes the server actually exchanges:
 *   USERNAME, REALM, NONCE, MESSAGE-INTEGRITY, ERROR-CODE,
 *   XOR-MAPPED-ADDRESS, XOR-PEER-ADDRESS, XOR-RELAYED-ADDRESS,
 *   LIFETIME, REQUESTED-TRANSPORT, DATA, CHANNEL-NUMBER, plus
 *   ChannelData framing (RFC 5766 §11).
 */

'use strict';

const crypto = require('node:crypto');
const net    = require('node:net');

const { TurnError } = require('../../errors');
const {
    STUN_MAGIC_COOKIE, STUN_CLASS,
    encodeXorMappedAddress, decodeXorMappedAddress,
    decodeMessage,
} = require('../stun');

// -- Constants --------------------------------------------------------------

const HEADER_LEN = 20;
const TXID_LEN   = 12;

/** TURN method codes (RFC 5766 §13). */
const TURN_METHOD = Object.freeze({
    ALLOCATE:          0x003,
    REFRESH:           0x004,
    SEND:              0x006,
    DATA:              0x007,
    CREATE_PERMISSION: 0x008,
    CHANNEL_BIND:      0x009,
});

/** STUN + TURN attribute type codes. */
const ATTR = Object.freeze({
    MAPPED_ADDRESS:      0x0001,
    USERNAME:            0x0006,
    MESSAGE_INTEGRITY:   0x0008,
    ERROR_CODE:          0x0009,
    REALM:               0x0014,
    NONCE:               0x0015,
    XOR_MAPPED_ADDRESS:  0x0020,
    CHANNEL_NUMBER:      0x000C,
    LIFETIME:            0x000D,
    XOR_PEER_ADDRESS:    0x0012,
    DATA:                0x0013,
    XOR_RELAYED_ADDRESS: 0x0016,
    REQUESTED_TRANSPORT: 0x0019,
    SOFTWARE:            0x8022,
});

/** RFC 5766 §15: protocol IDs for REQUESTED-TRANSPORT. */
const PROTO_UDP = 17;

/** Channel numbers occupy 0x4000-0x4FFF per RFC 5766 §11. */
const CHANNEL_MIN = 0x4000;
const CHANNEL_MAX = 0x7FFE;

// -- Type bits --------------------------------------------------------------

/** @private */
function makeType(method, cls)
{
    const m = method & 0xfff;
    const c = cls & 0x3;
    return ((m & 0xf80) << 2)
         | ((c & 0x2) << 7)
         | ((m & 0x70) << 1)
         | ((c & 0x1) << 4)
         | (m & 0xf);
}

// -- Padding ---------------------------------------------------------------

/** @private */
function pad4(n) { return (4 - (n % 4)) % 4; }

// -- Attribute serialization ----------------------------------------------

/**
 * Serialize a list of attributes (without MESSAGE-INTEGRITY).
 *
 * @param {Array<{type:number, value:Buffer}>} attrs
 * @returns {Buffer}
 */
function serializeAttributes(attrs)
{
    const parts = [];
    let total = 0;
    for (const a of attrs)
    {
        const v = a.value || Buffer.alloc(0);
        const head = Buffer.alloc(4);
        head.writeUInt16BE(a.type, 0);
        head.writeUInt16BE(v.length, 2);
        parts.push(head, v);
        const p = pad4(v.length);
        if (p > 0) parts.push(Buffer.alloc(p));
        total += 4 + v.length + p;
    }
    const out = Buffer.concat(parts, total);
    return out;
}

/**
 * Encode a full TURN message, optionally signed with MESSAGE-INTEGRITY.
 *
 * @param {number} method
 * @param {number} cls          STUN_CLASS.*
 * @param {Buffer} txid         12-byte transaction id
 * @param {Array<{type:number,value:Buffer}>} attrs
 * @param {Buffer} [integrityKey] If present, appends MESSAGE-INTEGRITY using
 *                                HMAC-SHA1 over the message with the length
 *                                field set to include the integrity attr.
 * @returns {Buffer}
 */
function encodeMessage(method, cls, txid, attrs, integrityKey)
{
    if (!Buffer.isBuffer(txid) || txid.length !== TXID_LEN)
        throw new TurnError('encodeMessage: txid must be 12 bytes');

    const body = serializeAttributes(attrs);
    const includesMI = !!integrityKey;
    const miLen = includesMI ? 24 : 0; // 4 header + 20 SHA1

    const header = Buffer.alloc(HEADER_LEN);
    header.writeUInt16BE(makeType(method, cls), 0);
    header.writeUInt16BE(body.length + miLen, 2);
    header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    txid.copy(header, 8);

    if (!includesMI)
        return Buffer.concat([header, body]);

    const preMI = Buffer.concat([header, body]);
    const mac = crypto.createHmac('sha1', integrityKey).update(preMI).digest();
    const miAttr = Buffer.alloc(4 + 20);
    miAttr.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, 0);
    miAttr.writeUInt16BE(20, 2);
    mac.copy(miAttr, 4);
    return Buffer.concat([preMI, miAttr]);
}

// -- Attribute helpers (extract from a decoded message) -------------------

/**
 * @param {{attributes:Array<{type:number,value:Buffer}>}} msg
 * @param {number} type
 * @returns {Buffer|null}
 */
function getAttr(msg, type)
{
    for (const a of msg.attributes) if (a.type === type) return a.value;
    return null;
}

/**
 * @param {{attributes:Array<{type:number,value:Buffer}>}} msg
 * @param {number} type
 * @returns {Buffer[]}
 */
function getAttrs(msg, type)
{
    const out = [];
    for (const a of msg.attributes) if (a.type === type) out.push(a.value);
    return out;
}

// -- Integrity validation -------------------------------------------------

/**
 * Compute the long-term-credential key per RFC 5766 §15.4:
 * `MD5(username ":" realm ":" password)`.
 */
function longTermKey(username, realm, password)
{
    return crypto.createHash('md5')
        .update(`${username}:${realm}:${password}`)
        .digest();
}

/**
 * Validate MESSAGE-INTEGRITY on a freshly received buffer.  Recomputes the
 * HMAC over the prefix up to (but not including) the integrity attribute
 * header, with the STUN length field rewritten to terminate after the
 * integrity attribute.
 *
 * @param {Buffer} raw          - The full datagram as received.
 * @param {Buffer} key          - Long-term key.
 * @param {Buffer} integrityVal - The 20-byte MAC from the message.
 * @param {number} integrityAttrStart - Offset where the MI TLV begins.
 * @returns {boolean}
 */
function verifyIntegrity(raw, key, integrityVal, integrityAttrStart)
{
    if (!Buffer.isBuffer(integrityVal) || integrityVal.length !== 20) return false;
    // Build the buffer the sender HMAC'd: header (with length set to MI end)
    // + body up to MI attribute header.
    const lenField = (integrityAttrStart - HEADER_LEN) + 24;
    const tmp = Buffer.from(raw.subarray(0, integrityAttrStart));
    tmp.writeUInt16BE(lenField, 2);
    const mac = crypto.createHmac('sha1', key).update(tmp).digest();
    return crypto.timingSafeEqual(mac, integrityVal);
}

/**
 * Locate the MESSAGE-INTEGRITY attribute inside a raw STUN message and
 * return `{ value, offset }` where `offset` is the start of the TLV.
 *
 * @param {Buffer} raw
 * @returns {{value:Buffer, offset:number}|null}
 */
function findIntegrity(raw)
{
    if (raw.length < HEADER_LEN) return null;
    const declaredLen = raw.readUInt16BE(2);
    if (HEADER_LEN + declaredLen > raw.length) return null;
    let off = HEADER_LEN;
    const end = HEADER_LEN + declaredLen;
    while (off + 4 <= end)
    {
        const t = raw.readUInt16BE(off);
        const l = raw.readUInt16BE(off + 2);
        const vEnd = off + 4 + l;
        if (vEnd > end) return null;
        if (t === ATTR.MESSAGE_INTEGRITY)
            return { value: Buffer.from(raw.subarray(off + 4, vEnd)), offset: off };
        off = vEnd + pad4(l);
    }
    return null;
}

// -- Specific attribute encoders ------------------------------------------

/** Encode ERROR-CODE attribute body (RFC 8489 §14.8). */
function encodeErrorCode(code, reason)
{
    const reasonBuf = Buffer.from(String(reason || ''), 'utf8');
    const out = Buffer.alloc(4 + reasonBuf.length);
    out.writeUInt8(0, 0);
    out.writeUInt8(0, 1);
    out.writeUInt8(Math.floor(code / 100) & 0x7, 2);
    out.writeUInt8(code % 100, 3);
    reasonBuf.copy(out, 4);
    return out;
}

/** Decode ERROR-CODE attribute body. */
function decodeErrorCode(buf)
{
    if (!Buffer.isBuffer(buf) || buf.length < 4)
        throw new TurnError('decodeErrorCode: too short');
    const cls = buf.readUInt8(2) & 0x7;
    const num = buf.readUInt8(3);
    const reason = buf.slice(4).toString('utf8');
    return { code: cls * 100 + num, reason };
}

/** Encode 4-byte unsigned integer attribute (LIFETIME / CHANNEL-NUMBER). */
function encodeUInt32(n)
{
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
}

function decodeUInt32(buf)
{
    if (!Buffer.isBuffer(buf) || buf.length < 4)
        throw new TurnError('decodeUInt32: too short');
    return buf.readUInt32BE(0);
}

/** Encode REQUESTED-TRANSPORT (1 byte proto + 3 bytes RFFU). */
function encodeRequestedTransport(proto)
{
    const b = Buffer.alloc(4);
    b.writeUInt8(proto & 0xff, 0);
    return b;
}

/** Encode CHANNEL-NUMBER (2 bytes + 2 RFFU). */
function encodeChannelNumber(num)
{
    const b = Buffer.alloc(4);
    b.writeUInt16BE(num & 0xffff, 0);
    return b;
}

function decodeChannelNumber(buf)
{
    if (!Buffer.isBuffer(buf) || buf.length < 2)
        throw new TurnError('decodeChannelNumber: too short');
    return buf.readUInt16BE(0);
}

// -- ChannelData framing --------------------------------------------------

/**
 * Wrap a payload in a ChannelData frame (RFC 5766 §11.4).
 * Layout: `[ channel:2 ][ length:2 ][ payload ][ pad to 4 ]`.
 */
function encodeChannelData(channel, payload)
{
    const len = payload.length;
    const padLen = pad4(len);
    const buf = Buffer.alloc(4 + len + padLen);
    buf.writeUInt16BE(channel & 0xffff, 0);
    buf.writeUInt16BE(len, 2);
    payload.copy(buf, 4);
    return buf;
}

/**
 * Decode a ChannelData frame.  Returns null when the buffer does not look
 * like ChannelData (high two bits non-zero, or too short).
 */
function decodeChannelData(buf)
{
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    const first = buf.readUInt16BE(0);
    if (first < CHANNEL_MIN || first > CHANNEL_MAX) return null;
    const len = buf.readUInt16BE(2);
    if (4 + len > buf.length) return null;
    return { channel: first, payload: Buffer.from(buf.subarray(4, 4 + len)) };
}

/**
 * Detect message kind from the first 2 bytes.  STUN messages begin with
 * `00`, ChannelData messages with `01`.
 */
function looksLikeChannelData(buf)
{
    if (!Buffer.isBuffer(buf) || buf.length < 1) return false;
    return (buf[0] & 0xc0) !== 0;
}

// -- XOR address helpers (re-exported from stun.js for convenience) ------

function encodeXorAddress(address, port, txid) { return encodeXorMappedAddress(address, port, txid); }
function decodeXorAddress(buf, txid)           { return decodeXorMappedAddress(buf, txid); }

/** Quick textual key for an `{address,port}` pair. */
function endpointKey(address, port) { return `${address}:${port}`; }

/** True iff `s` looks like an IPv4 or IPv6 literal. */
function isIp(s) { return net.isIP(s) > 0; }

module.exports = {
    HEADER_LEN, TXID_LEN, STUN_CLASS,
    TURN_METHOD, ATTR, PROTO_UDP,
    CHANNEL_MIN, CHANNEL_MAX,
    serializeAttributes, encodeMessage, decodeMessage,
    getAttr, getAttrs,
    longTermKey, verifyIntegrity, findIntegrity,
    encodeErrorCode, decodeErrorCode,
    encodeUInt32, decodeUInt32,
    encodeRequestedTransport,
    encodeChannelNumber, decodeChannelNumber,
    encodeChannelData, decodeChannelData, looksLikeChannelData,
    encodeXorAddress, decodeXorAddress,
    endpointKey, isIp,
};
