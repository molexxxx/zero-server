'use strict';

const dgram = require('node:dgram');
const {
    stunBinding,
    encodeBindingRequest,
    decodeMessage,
    encodeXorMappedAddress,
    decodeXorMappedAddress,
    STUN_MAGIC_COOKIE,
    STUN_METHOD,
    STUN_CLASS,
    STUN_ATTR,
} = require('../../lib/webrtc/stun');
const { TurnError } = require('../../lib/errors');

// --- Helpers ---

function startStubServer(handler)
{
    return new Promise((resolve) =>
    {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (msg, rinfo) => handler(sock, msg, rinfo));
        sock.bind(0, '127.0.0.1', () =>
        {
            resolve({ sock, port: sock.address().port });
        });
    });
}

// --- encodeBindingRequest ---

describe('encodeBindingRequest', () =>
{
    it('emits a 20-byte header with method=binding class=request and magic cookie', () =>
    {
        const { buffer, transactionId } = encodeBindingRequest();
        expect(buffer.length).toBe(20);
        // message type = method(0x001) | class(0x000) = 0x0001
        expect(buffer.readUInt16BE(0)).toBe(0x0001);
        // body length = 0 (no attributes)
        expect(buffer.readUInt16BE(2)).toBe(0);
        // magic cookie
        expect(buffer.readUInt32BE(4)).toBe(STUN_MAGIC_COOKIE);
        // 12-byte transaction ID exposed
        expect(transactionId.length).toBe(12);
        expect(buffer.subarray(8, 20).equals(transactionId)).toBe(true);
    });

    it('accepts a caller-supplied transaction ID', () =>
    {
        const txid = Buffer.alloc(12, 0xab);
        const { buffer } = encodeBindingRequest(txid);
        expect(buffer.subarray(8, 20).equals(txid)).toBe(true);
    });

    it('throws when transaction ID length is wrong', () =>
    {
        expect(() => encodeBindingRequest(Buffer.alloc(8))).toThrow(TurnError);
    });
});

// --- decodeMessage ---

describe('decodeMessage', () =>
{
    it('round-trips a binding request', () =>
    {
        const { buffer, transactionId } = encodeBindingRequest();
        const msg = decodeMessage(buffer);
        expect(msg.method).toBe(STUN_METHOD.BINDING);
        expect(msg.class).toBe(STUN_CLASS.REQUEST);
        expect(msg.transactionId.equals(transactionId)).toBe(true);
        expect(msg.attributes).toEqual([]);
    });

    it('throws TurnError on truncated header', () =>
    {
        expect(() => decodeMessage(Buffer.alloc(10))).toThrow(TurnError);
    });

    it('throws TurnError on bad magic cookie', () =>
    {
        const { buffer } = encodeBindingRequest();
        buffer.writeUInt32BE(0xdeadbeef, 4);
        expect(() => decodeMessage(buffer)).toThrow(TurnError);
    });

    it('throws TurnError when high two bits of type are non-zero', () =>
    {
        const { buffer } = encodeBindingRequest();
        buffer.writeUInt16BE(0xc001, 0);
        expect(() => decodeMessage(buffer)).toThrow(TurnError);
    });

    it('throws TurnError when message length exceeds buffer', () =>
    {
        const { buffer } = encodeBindingRequest();
        buffer.writeUInt16BE(100, 2);
        expect(() => decodeMessage(buffer)).toThrow(TurnError);
    });

    it('parses attribute TLVs and respects 4-byte padding', () =>
    {
        // Build a fake response with two attrs: one 3 bytes (padded to 4), one 4 bytes
        const txid = Buffer.alloc(12, 1);
        const a1Body = Buffer.from([1, 2, 3]);
        const a2Body = Buffer.from([9, 9, 9, 9]);
        const a1 = Buffer.concat([
            Buffer.from([0x80, 0x22, 0x00, 0x03]), a1Body, Buffer.alloc(1),
        ]);
        const a2 = Buffer.concat([
            Buffer.from([0x80, 0x23, 0x00, 0x04]), a2Body,
        ]);
        const body = Buffer.concat([a1, a2]);
        const header = Buffer.alloc(20);
        header.writeUInt16BE(0x0101, 0); // binding success
        header.writeUInt16BE(body.length, 2);
        header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
        txid.copy(header, 8);
        const msg = decodeMessage(Buffer.concat([header, body]));
        expect(msg.attributes).toHaveLength(2);
        expect(msg.attributes[0].type).toBe(0x8022);
        expect(msg.attributes[0].value.equals(a1Body)).toBe(true);
        expect(msg.attributes[1].type).toBe(0x8023);
        expect(msg.attributes[1].value.equals(a2Body)).toBe(true);
    });
});

// --- XOR-MAPPED-ADDRESS ---

describe('XOR-MAPPED-ADDRESS', () =>
{
    it('round-trips an IPv4 mapping', () =>
    {
        const txid = Buffer.alloc(12, 0);
        const enc = encodeXorMappedAddress('192.0.2.55', 32853, txid);
        const dec = decodeXorMappedAddress(enc, txid);
        expect(dec.family).toBe(4);
        expect(dec.address).toBe('192.0.2.55');
        expect(dec.port).toBe(32853);
    });

    it('round-trips an IPv6 mapping', () =>
    {
        const txid = Buffer.from('0102030405060708090a0b0c', 'hex');
        const enc = encodeXorMappedAddress('2001:db8::1', 54321, txid);
        const dec = decodeXorMappedAddress(enc, txid);
        expect(dec.family).toBe(6);
        expect(dec.address).toBe('2001:db8::1');
        expect(dec.port).toBe(54321);
    });

    it('matches the RFC 8489 §14.3 IPv4 test vector', () =>
    {
        // RFC 5769 §2.1: response to a binding request from 192.0.2.1:32853
        // x-port = 0xA147, x-address = 0xE112A443
        const txid = Buffer.from('b7e7a701bc34d686fa87dfae', 'hex');
        const buf = Buffer.from([
            0x00, 0x01, // family=IPv4
            0xa1, 0x47, // x-port
            0xe1, 0x12, 0xa6, 0x43, // x-address
        ]);
        const dec = decodeXorMappedAddress(buf, txid);
        expect(dec.family).toBe(4);
        expect(dec.address).toBe('192.0.2.1');
        expect(dec.port).toBe(32853);
    });

    it('throws on unknown family', () =>
    {
        const buf = Buffer.from([0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        expect(() => decodeXorMappedAddress(buf, Buffer.alloc(12))).toThrow(TurnError);
    });

    it('throws on truncated buffer', () =>
    {
        expect(() => decodeXorMappedAddress(Buffer.alloc(3), Buffer.alloc(12))).toThrow(TurnError);
    });
});

// --- stunBinding (live UDP) ---

describe('stunBinding', () =>
{
    it('resolves with the address/port returned by the server', async () =>
    {
        const { sock, port } = await startStubServer((sock, msg, rinfo) =>
        {
            const req = decodeMessage(msg);
            const attrBody = encodeXorMappedAddress('203.0.113.42', 50007, req.transactionId);
            const attr = Buffer.concat([
                Buffer.from([
                    (STUN_ATTR.XOR_MAPPED_ADDRESS >> 8) & 0xff,
                    STUN_ATTR.XOR_MAPPED_ADDRESS & 0xff,
                    0x00, attrBody.length,
                ]),
                attrBody,
            ]);
            const header = Buffer.alloc(20);
            header.writeUInt16BE(0x0101, 0);
            header.writeUInt16BE(attr.length, 2);
            header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
            req.transactionId.copy(header, 8);
            sock.send(Buffer.concat([header, attr]), rinfo.port, rinfo.address);
        });
        try
        {
            const result = await stunBinding({ host: '127.0.0.1', port, timeoutMs: 500, retries: 2 });
            expect(result).toEqual({ family: 4, address: '203.0.113.42', port: 50007 });
        }
        finally { sock.close(); }
    });

    it('rejects responses with a mismatched transaction ID', async () =>
    {
        const { sock, port } = await startStubServer((sock, msg, rinfo) =>
        {
            const attrBody = encodeXorMappedAddress('1.2.3.4', 1234, Buffer.alloc(12, 0xff));
            const attr = Buffer.concat([
                Buffer.from([
                    (STUN_ATTR.XOR_MAPPED_ADDRESS >> 8) & 0xff,
                    STUN_ATTR.XOR_MAPPED_ADDRESS & 0xff,
                    0x00, attrBody.length,
                ]),
                attrBody,
            ]);
            const header = Buffer.alloc(20);
            header.writeUInt16BE(0x0101, 0);
            header.writeUInt16BE(attr.length, 2);
            header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
            Buffer.alloc(12, 0x55).copy(header, 8); // wrong txid
            sock.send(Buffer.concat([header, attr]), rinfo.port, rinfo.address);
        });
        try
        {
            await expect(stunBinding({ host: '127.0.0.1', port, timeoutMs: 250, retries: 1 }))
                .rejects.toThrow(TurnError);
        }
        finally { sock.close(); }
    });

    it('rejects with TurnError on timeout', async () =>
    {
        // No-op server: never responds
        const { sock, port } = await startStubServer(() => {});
        try
        {
            await expect(stunBinding({ host: '127.0.0.1', port, timeoutMs: 100, retries: 2 }))
                .rejects.toThrow(TurnError);
        }
        finally { sock.close(); }
    });

    it('falls back to MAPPED-ADDRESS when XOR-MAPPED-ADDRESS is absent', async () =>
    {
        const { sock, port } = await startStubServer((sock, msg, rinfo) =>
        {
            const req = decodeMessage(msg);
            // Plain MAPPED-ADDRESS (0x0001): reserved, family=IPv4, port, addr
            const body = Buffer.from([
                0x00, 0x01, // family
                (1234 >> 8) & 0xff, 1234 & 0xff,
                10, 0, 0, 7,
            ]);
            const attr = Buffer.concat([
                Buffer.from([0x00, 0x01, 0x00, body.length]),
                body,
            ]);
            const header = Buffer.alloc(20);
            header.writeUInt16BE(0x0101, 0);
            header.writeUInt16BE(attr.length, 2);
            header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
            req.transactionId.copy(header, 8);
            sock.send(Buffer.concat([header, attr]), rinfo.port, rinfo.address);
        });
        try
        {
            const r = await stunBinding({ host: '127.0.0.1', port, timeoutMs: 500, retries: 1 });
            expect(r).toEqual({ family: 4, address: '10.0.0.7', port: 1234 });
        }
        finally { sock.close(); }
    });

    it('validates required options', async () =>
    {
        await expect(stunBinding({})).rejects.toThrow(TurnError);
        await expect(stunBinding({ host: 'x' })).rejects.toThrow(TurnError);
    });
});
