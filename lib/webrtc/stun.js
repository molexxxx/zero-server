/**
 * @module webrtc/stun
 * @description Zero-dependency RFC 8489 STUN client. Sends a Binding Request
 *   over UDP, parses the Binding Response, and returns the server-reflexive
 *   address from XOR-MAPPED-ADDRESS (or legacy MAPPED-ADDRESS). NAT-discovery
 *   subset only; TURN allocations live in `lib/webrtc/turn/`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8489
 */

'use strict';

const dgram  = require('node:dgram');
const crypto = require('node:crypto');
const net    = require('node:net');

const { TurnError } = require('../errors');

// -- Protocol constants -------------------------------------------

/** STUN magic cookie (RFC 8489 §5). */
const STUN_MAGIC_COOKIE = 0x2112A442;

/** Length of the fixed STUN header. */
const HEADER_LEN = 20;

/** Length of the transaction ID. */
const TXID_LEN = 12;

/**
 * STUN methods.
 * @enum {number}
 */
const STUN_METHOD = Object.freeze({ BINDING: 0x001 });

/**
 * STUN classes (message type low bits 0x10 and 0x100).
 * @enum {number}
 */
const STUN_CLASS = Object.freeze({
    REQUEST:    0x0,
    INDICATION: 0x1,
    SUCCESS:    0x2,
    ERROR:      0x3,
});

/**
 * STUN attribute type registry (just the ones we touch).
 * @enum {number}
 */
const STUN_ATTR = Object.freeze({
    MAPPED_ADDRESS:     0x0001,
    XOR_MAPPED_ADDRESS: 0x0020,
    ERROR_CODE:         0x0009,
    SOFTWARE:           0x8022,
});

// =================================================================
// Header / attribute codec
// =================================================================

/**
 * Build a STUN Binding Request packet.
 *
 * @param {Buffer} [transactionId] - 12-byte ID; one is generated if omitted.
 * @returns {{buffer:Buffer, transactionId:Buffer}}
 * @throws {TurnError} If supplied transaction ID is the wrong length.
 *
 * @section ICE & TURN
 */
function encodeBindingRequest(transactionId)
{
    const txid = transactionId || crypto.randomBytes(TXID_LEN);
    if (!Buffer.isBuffer(txid) || txid.length !== TXID_LEN)
        throw new TurnError('encodeBindingRequest: transactionId must be a 12-byte Buffer');

    const buf = Buffer.alloc(HEADER_LEN);
    buf.writeUInt16BE(_makeType(STUN_METHOD.BINDING, STUN_CLASS.REQUEST), 0);
    buf.writeUInt16BE(0, 2);
    buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    txid.copy(buf, 8);
    return { buffer: buf, transactionId: txid };
}

/**
 * Parse a STUN message (header + attributes).
 *
 * @param {Buffer} buf - Raw datagram.
 * @returns {{method:number, class:number, transactionId:Buffer, attributes:Array<{type:number,value:Buffer}>}}
 * @throws {TurnError} On any structural problem.
 *
 * @section ICE & TURN
 */
function decodeMessage(buf)
{
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN)
        throw new TurnError('decodeMessage: buffer shorter than STUN header');

    const type = buf.readUInt16BE(0);
    if ((type & 0xC000) !== 0)
        throw new TurnError('decodeMessage: high two bits of message type must be zero');

    const length = buf.readUInt16BE(2);
    if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE)
        throw new TurnError('decodeMessage: bad magic cookie');
    if (HEADER_LEN + length > buf.length)
        throw new TurnError('decodeMessage: message length exceeds buffer');

    const txid = Buffer.from(buf.subarray(8, 20));
    const { method, cls } = _splitType(type);

    /** @type {Array<{type:number,value:Buffer}>} */
    const attributes = [];
    let off = HEADER_LEN;
    const end = HEADER_LEN + length;
    while (off + 4 <= end)
    {
        const aType = buf.readUInt16BE(off);
        const aLen  = buf.readUInt16BE(off + 2);
        const vEnd  = off + 4 + aLen;
        if (vEnd > end)
            throw new TurnError('decodeMessage: attribute length overruns message');
        attributes.push({ type: aType, value: Buffer.from(buf.subarray(off + 4, vEnd)) });
        // Attributes are padded to a 4-byte boundary.
        const pad = (4 - (aLen % 4)) % 4;
        off = vEnd + pad;
    }

    return { method, class: cls, transactionId: txid, attributes };
}

/** @private */
function _makeType(method, cls)
{
    // RFC 8489 §5: M11..M7 C1 M6..M4 C0 M3..M0
    const m = method & 0xfff;
    const c = cls & 0x3;
    return ((m & 0xf80) << 2)
         | ((c & 0x2) << 7)
         | ((m & 0x70) << 1)
         | ((c & 0x1) << 4)
         | (m & 0xf);
}

/** @private */
function _splitType(type)
{
    const method = ((type & 0x3e00) >> 2)
                 | ((type & 0xe0) >> 1)
                 | (type & 0xf);
    const cls = ((type & 0x100) >> 7) | ((type & 0x10) >> 4);
    return { method, cls };
}

// =================================================================
// XOR-MAPPED-ADDRESS / MAPPED-ADDRESS
// =================================================================

/**
 * Encode an XOR-MAPPED-ADDRESS attribute body (no TLV header).
 *
 * @param {string} address - IPv4 or IPv6 string.
 * @param {number} port - 0-65535.
 * @param {Buffer} transactionId - 12-byte transaction ID (needed for IPv6).
 * @returns {Buffer}
 *
 * @section ICE & TURN
 */
function encodeXorMappedAddress(address, port, transactionId)
{
    const family = net.isIPv4(address) ? 4 : net.isIPv6(address) ? 6 : 0;
    if (!family) throw new TurnError(`encodeXorMappedAddress: not an IP address: ${address}`);

    const xport = port ^ (STUN_MAGIC_COOKIE >>> 16);
    if (family === 4)
    {
        const out = Buffer.alloc(8);
        out.writeUInt8(0, 0);
        out.writeUInt8(0x01, 1);
        out.writeUInt16BE(xport & 0xffff, 2);
        const addr = _ipv4ToBuffer(address);
        for (let i = 0; i < 4; i++)
            out.writeUInt8(addr[i] ^ _cookieByte(i), 4 + i);
        return out;
    }

    // IPv6: xaddr = addr XOR (cookie || transactionId)
    const out = Buffer.alloc(20);
    out.writeUInt8(0, 0);
    out.writeUInt8(0x02, 1);
    out.writeUInt16BE(xport & 0xffff, 2);
    const addr = _ipv6ToBuffer(address);
    for (let i = 0; i < 16; i++)
    {
        const mask = i < 4 ? _cookieByte(i) : transactionId[i - 4];
        out.writeUInt8(addr[i] ^ mask, 4 + i);
    }
    return out;
}

/**
 * Decode an XOR-MAPPED-ADDRESS attribute body to `{family, address, port}`.
 *
 * @param {Buffer} buf - Attribute value bytes.
 * @param {Buffer} transactionId - 12-byte ID from the response header.
 * @returns {{family:number, address:string, port:number}}
 *
 * @section ICE & TURN
 */
function decodeXorMappedAddress(buf, transactionId)
{
    if (!Buffer.isBuffer(buf) || buf.length < 8)
        throw new TurnError('decodeXorMappedAddress: attribute too short');
    const family = buf.readUInt8(1);
    const xport  = buf.readUInt16BE(2);
    const port   = xport ^ (STUN_MAGIC_COOKIE >>> 16);

    if (family === 0x01)
    {
        if (buf.length < 8) throw new TurnError('decodeXorMappedAddress: IPv4 too short');
        const addr = Buffer.alloc(4);
        for (let i = 0; i < 4; i++) addr[i] = buf[4 + i] ^ _cookieByte(i);
        return { family: 4, address: _bufferToIPv4(addr), port: port & 0xffff };
    }
    if (family === 0x02)
    {
        if (buf.length < 20) throw new TurnError('decodeXorMappedAddress: IPv6 too short');
        const addr = Buffer.alloc(16);
        for (let i = 0; i < 16; i++)
        {
            const mask = i < 4 ? _cookieByte(i) : transactionId[i - 4];
            addr[i] = buf[4 + i] ^ mask;
        }
        return { family: 6, address: _bufferToIPv6(addr), port: port & 0xffff };
    }
    throw new TurnError(`decodeXorMappedAddress: unknown family 0x${family.toString(16)}`);
}

/**
 * Decode the unauthenticated, pre-RFC-5389 MAPPED-ADDRESS attribute.  Some
 * very old STUN servers still emit this instead of XOR-MAPPED-ADDRESS; we
 * accept it as a fallback.
 * @private
 */
function _decodeMappedAddress(buf)
{
    if (!Buffer.isBuffer(buf) || buf.length < 8)
        throw new TurnError('MAPPED-ADDRESS too short');
    const family = buf.readUInt8(1);
    const port   = buf.readUInt16BE(2);
    if (family === 0x01)
        return { family: 4, address: _bufferToIPv4(buf.subarray(4, 8)), port };
    if (family === 0x02 && buf.length >= 20)
        return { family: 6, address: _bufferToIPv6(buf.subarray(4, 20)), port };
    throw new TurnError(`MAPPED-ADDRESS: unknown family 0x${family.toString(16)}`);
}

/** @private */
function _cookieByte(i)
{
    return (STUN_MAGIC_COOKIE >>> (24 - i * 8)) & 0xff;
}

// =================================================================
// IP <-> Buffer
// =================================================================

/** @private */
function _ipv4ToBuffer(addr)
{
    const parts = addr.split('.');
    const out = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) out[i] = Number(parts[i]) & 0xff;
    return out;
}

/** @private */
function _bufferToIPv4(buf)
{
    return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

/** @private */
function _ipv6ToBuffer(addr)
{
    const dbl  = addr.indexOf('::');
    let head, tail;
    if (dbl === -1)
    {
        head = addr.split(':'); tail = [];
    }
    else
    {
        head = addr.slice(0, dbl).split(':').filter(Boolean);
        tail = addr.slice(dbl + 2).split(':').filter(Boolean);
    }
    const fill = 8 - head.length - tail.length;
    const groups = [...head, ...Array(fill).fill('0'), ...tail];
    if (groups.length !== 8)
        throw new TurnError(`_ipv6ToBuffer: cannot parse "${addr}"`);
    const out = Buffer.alloc(16);
    for (let i = 0; i < 8; i++)
    {
        const v = parseInt(groups[i], 16) & 0xffff;
        out.writeUInt16BE(v, i * 2);
    }
    return out;
}

/** @private */
function _bufferToIPv6(buf)
{
    const groups = [];
    for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(i * 2).toString(16));

    // Compress the longest run of zero groups (length >= 2).
    let bestStart = -1, bestLen = 0;
    let curStart = -1, curLen = 0;
    for (let i = 0; i < 8; i++)
    {
        if (groups[i] === '0')
        {
            if (curStart === -1) { curStart = i; curLen = 1; }
            else curLen++;
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        }
        else { curStart = -1; curLen = 0; }
    }
    if (bestLen < 2) return groups.join(':');
    const left  = groups.slice(0, bestStart).join(':');
    const right = groups.slice(bestStart + bestLen).join(':');
    return `${left}::${right}`;
}

// =================================================================
// Client
// =================================================================

/**
 * @typedef {object} StunBindingOptions
 * @property {string} host          - STUN server hostname or IP.
 * @property {number} [port=3478]   - STUN server port.
 * @property {number} [timeoutMs=500] - Per-attempt timeout.
 * @property {number} [retries=7]   - Max attempts (RFC 5389 default is 7).
 * @property {'udp4'|'udp6'} [socketType='udp4']
 */

/**
 * @typedef {object} StunBindingResult
 * @property {number} family   - 4 or 6.
 * @property {string} address  - Server-reflexive address.
 * @property {number} port     - Server-reflexive port.
 */

/**
 * Discover the public (server-reflexive) address by sending a STUN Binding
 * Request to `opts.host:opts.port`.
 *
 * Retries with the same transaction ID until a matching Binding Success is
 * received or `retries` attempts elapse.  Closes the socket on resolve/reject.
 *
 * @param {StunBindingOptions} opts
 * @returns {Promise<StunBindingResult>}
 * @throws {TurnError} On timeout, malformed response, or transaction-ID mismatch.
 *
 * @example
 *   const { address, port } = await stunBinding({ host: 'stun.l.google.com', port: 19302 });
 *
 * @section ICE & TURN
 */
function stunBinding(opts)
{
    return new Promise((resolve, reject) =>
    {
        const o = opts || {};
        if (typeof o.host !== 'string' || o.host.length === 0)
            return reject(new TurnError('stunBinding: opts.host is required'));
        const port       = o.port ?? 3478;
        const timeoutMs  = o.timeoutMs ?? 500;
        const retries    = o.retries ?? 7;
        const socketType = o.socketType ?? 'udp4';
        if (!Number.isInteger(port) || port <= 0 || port > 65535)
            return reject(new TurnError('stunBinding: invalid port'));

        const { buffer, transactionId } = encodeBindingRequest();
        const sock = dgram.createSocket(socketType);
        let attempt = 0;
        let timer = null;
        let done = false;

        const cleanup = () =>
        {
            done = true;
            if (timer) { clearTimeout(timer); timer = null; }
            try { sock.close(); } catch { /* ignore */ }
        };

        sock.on('error', (err) =>
        {
            if (done) return;
            cleanup();
            reject(new TurnError(`stunBinding: socket error: ${err.message}`));
        });

        sock.on('message', (msg) =>
        {
            if (done) return;
            let parsed;
            try { parsed = decodeMessage(msg); }
            catch (err) { return reject(_failWith(cleanup, err)); }

            if (!parsed.transactionId.equals(transactionId))
                return reject(_failWith(cleanup, new TurnError('stunBinding: transaction ID mismatch')));
            if (parsed.method !== STUN_METHOD.BINDING)
                return; // ignore unrelated method
            if (parsed.class === STUN_CLASS.ERROR)
                return reject(_failWith(cleanup, new TurnError('stunBinding: server returned ERROR class')));
            if (parsed.class !== STUN_CLASS.SUCCESS) return;

            const xor    = parsed.attributes.find(a => a.type === STUN_ATTR.XOR_MAPPED_ADDRESS);
            const mapped = parsed.attributes.find(a => a.type === STUN_ATTR.MAPPED_ADDRESS);

            try
            {
                let result;
                if (xor) result = decodeXorMappedAddress(xor.value, parsed.transactionId);
                else if (mapped) result = _decodeMappedAddress(mapped.value);
                else throw new TurnError('stunBinding: response missing XOR-MAPPED-ADDRESS / MAPPED-ADDRESS');
                cleanup();
                resolve(result);
            }
            catch (err)
            {
                reject(_failWith(cleanup, err));
            }
        });

        const send = () =>
        {
            if (done) return;
            attempt++;
            sock.send(buffer, 0, buffer.length, port, o.host, (err) =>
            {
                if (err && !done)
                {
                    cleanup();
                    return reject(new TurnError(`stunBinding: send failed: ${err.message}`));
                }
            });
            timer = setTimeout(() =>
            {
                if (done) return;
                if (attempt >= retries)
                {
                    cleanup();
                    return reject(new TurnError(`stunBinding: timed out after ${attempt} attempts`));
                }
                send();
            }, timeoutMs);
        };

        sock.bind(0, () => send());
    });
}

/** @private */
function _failWith(cleanup, err)
{
    cleanup();
    return err instanceof TurnError ? err : new TurnError(err.message || String(err));
}

module.exports = {
    stunBinding,
    encodeBindingRequest,
    decodeMessage,
    encodeXorMappedAddress,
    decodeXorMappedAddress,
    STUN_MAGIC_COOKIE,
    STUN_METHOD,
    STUN_CLASS,
    STUN_ATTR,
    TurnError,
};
