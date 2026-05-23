'use strict';

const { signJoinToken, verifyJoinToken } = require('../../lib/webrtc/joinToken');
const { SignalingHub } = require('../../lib/webrtc/signaling');
const { SignalingError, WebRTCError } = require('../../lib/errors');
const { EventEmitter } = require('node:events');

// --- Mock transport (copy from signaling tests; intentionally local) ---

class MockTransport extends EventEmitter
{
    constructor(meta = {})
    {
        super();
        this.id = meta.id || ('mock_' + Math.random().toString(36).slice(2, 9));
        this.ip = meta.ip || '127.0.0.1';
        this.headers = meta.headers || {};
        this.origin = meta.origin || null;
        this.outbox = [];
        this.closed = false;
        this.closeCode = null;
    }
    send(data) { if (!this.closed) this.outbox.push(data); }
    close(code, reason)
    {
        if (this.closed) return;
        this.closed = true;
        this.closeCode = code ?? 1000;
        this.emit('close', this.closeCode, reason ?? '');
    }
    inject(obj)
    {
        this.emit('message', typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
    sent(type)
    {
        return this.outbox.map(JSON.parse).filter(m => m.type === type);
    }
}

// --- signJoinToken / verifyJoinToken ---

describe('signJoinToken / verifyJoinToken', () =>
{
    it('signs a token that verifies cleanly against the same secret + room', () =>
    {
        const tok = signJoinToken({
            secret: 's3cret', user: { id: 'alice' }, room: 'lobby', ttl: 600,
        });
        expect(typeof tok).toBe('string');
        expect(tok.split('.')).toHaveLength(3);
        const payload = verifyJoinToken(tok, { secret: 's3cret', room: 'lobby' });
        expect(payload.room).toBe('lobby');
        expect(payload.sub).toBe('alice');
        expect(payload.aud).toBe('room:lobby');
        expect(typeof payload.exp).toBe('number');
    });

    it('accepts a string userId as well as a user object', () =>
    {
        const tok = signJoinToken({ secret: 'k', user: 'bob', room: 'r', ttl: 60 });
        const payload = verifyJoinToken(tok, { secret: 'k', room: 'r' });
        expect(payload.sub).toBe('bob');
    });

    it('throws WebRTCError on a wrong-secret token', () =>
    {
        const tok = signJoinToken({ secret: 'one', user: 'a', room: 'r', ttl: 60 });
        expect(() => verifyJoinToken(tok, { secret: 'two', room: 'r' })).toThrow(WebRTCError);
    });

    it('throws on audience mismatch when verifying against a different room', () =>
    {
        const tok = signJoinToken({ secret: 'k', user: 'a', room: 'lobby', ttl: 60 });
        expect(() => verifyJoinToken(tok, { secret: 'k', room: 'vault' })).toThrow(WebRTCError);
    });

    it('throws on an expired token', () =>
    {
        const tok = signJoinToken({ secret: 'k', user: 'a', room: 'r', ttl: -10 });
        expect(() => verifyJoinToken(tok, { secret: 'k', room: 'r' })).toThrow(WebRTCError);
    });

    it('throws SignalingError when required options are missing', () =>
    {
        expect(() => signJoinToken({})).toThrow(SignalingError);
        expect(() => signJoinToken({ secret: 'k' })).toThrow(SignalingError);
        expect(() => signJoinToken({ secret: 'k', user: 'a' })).toThrow(SignalingError);
        expect(() => verifyJoinToken('not.a.jwt', { secret: 'k', room: 'r' })).toThrow(WebRTCError);
    });
});

// --- Origin allowlist ---

describe('SignalingHub origin allowlist', () =>
{
    it('attaches normally when no allowlist is configured', () =>
    {
        const hub = new SignalingHub();
        const t = new MockTransport({ origin: 'https://evil.com' });
        const peer = hub.attach(t, { origin: t.origin });
        expect(peer.closed).toBe(false);
    });

    it('rejects a transport whose origin is not on the allowlist', () =>
    {
        const hub = new SignalingHub({ originAllowlist: ['https://app.example.com'] });
        const t = new MockTransport({ origin: 'https://evil.com' });
        hub.attach(t, { origin: t.origin });
        expect(t.closed).toBe(true);
        expect(t.closeCode).toBe(1008);
        const err = t.sent('error')[0];
        expect(err && err.code).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('accepts a transport whose origin is on the allowlist', () =>
    {
        const hub = new SignalingHub({ originAllowlist: ['https://app.example.com'] });
        const t = new MockTransport({ origin: 'https://app.example.com' });
        const peer = hub.attach(t, { origin: t.origin });
        expect(peer.closed).toBe(false);
        expect(t.closed).toBe(false);
    });
});

// --- Protocol error backoff ---

describe('SignalingHub protocol-error backoff', () =>
{
    it('disconnects a peer after maxProtocolErrors malformed frames', () =>
    {
        const hub = new SignalingHub({ maxProtocolErrors: 3 });
        const t = new MockTransport();
        const peer = hub.attach(t);

        for (let i = 0; i < 10; i++)
        {
            t.inject('not-json-' + i);
            if (t.closed) break;
        }
        expect(t.closed).toBe(true);
        expect(t.closeCode).toBe(1008);
        expect(peer.errors).toBeGreaterThanOrEqual(3);
    });
});

// --- Join token enforcement ---

describe('SignalingHub join-token enforcement', () =>
{
    it('rejects join without a token when joinTokenSecret is configured', () =>
    {
        const hub = new SignalingHub({ joinTokenSecret: 'sec' });
        hub.room('lobby').open();
        const t = new MockTransport();
        hub.attach(t);
        t.inject({ type: 'join', room: 'lobby' });
        const err = t.sent('error')[0];
        expect(err && err.code).toBe('TOKEN_REQUIRED');
    });

    it('rejects join with an invalid token', () =>
    {
        const hub = new SignalingHub({ joinTokenSecret: 'sec' });
        hub.room('lobby').open();
        const t = new MockTransport();
        hub.attach(t);
        const bad = signJoinToken({ secret: 'wrong', user: 'a', room: 'lobby', ttl: 60 });
        t.inject({ type: 'join', room: 'lobby', token: bad });
        const err = t.sent('error')[0];
        expect(err && err.code).toBe('INVALID_TOKEN');
    });

    it('rejects a token whose audience targets a different room', () =>
    {
        const hub = new SignalingHub({ joinTokenSecret: 'sec' });
        hub.room('lobby').open();
        hub.room('vault').open();
        const t = new MockTransport();
        hub.attach(t);
        const tok = signJoinToken({ secret: 'sec', user: 'a', room: 'vault', ttl: 60 });
        t.inject({ type: 'join', room: 'lobby', token: tok });
        const err = t.sent('error')[0];
        expect(err && err.code).toBe('INVALID_TOKEN');
    });

    it('accepts a valid token and joins the room', () =>
    {
        const hub = new SignalingHub({ joinTokenSecret: 'sec' });
        hub.room('lobby').open();
        const t = new MockTransport();
        const peer = hub.attach(t);
        const tok = signJoinToken({ secret: 'sec', user: { id: 'alice', role: 'guest' }, room: 'lobby', ttl: 60 });
        t.inject({ type: 'join', room: 'lobby', token: tok });
        expect(peer.room && peer.room.name).toBe('lobby');
        // Token-derived user identity overrides null peer.user
        expect(peer.user && peer.user.id).toBe('alice');
    });
});

// --- Per-IP attach rate limit ---

describe('SignalingHub per-IP attach rate limit', () =>
{
    it('rejects attaches from the same IP beyond the threshold and closes the transport', () =>
    {
        const hub = new SignalingHub({ ipAttachRate: 3 });
        const transports = [];
        for (let i = 0; i < 6; i++)
        {
            const t = new MockTransport({ ip: '10.0.0.1' });
            hub.attach(t, { ip: '10.0.0.1' });
            transports.push(t);
        }
        const accepted = transports.filter(t => !t.closed).length;
        const rejected = transports.filter(t =>
            t.closed && t.sent('error').some(e => e.code === 'IP_RATE_LIMITED'),
        ).length;
        expect(accepted).toBe(3);
        expect(rejected).toBe(3);
    });

    it('counts attaches per-IP independently', () =>
    {
        const hub = new SignalingHub({ ipAttachRate: 2 });
        const tA1 = new MockTransport({ ip: '10.0.0.1' });
        const tA2 = new MockTransport({ ip: '10.0.0.1' });
        const tA3 = new MockTransport({ ip: '10.0.0.1' });
        const tB1 = new MockTransport({ ip: '10.0.0.2' });
        hub.attach(tA1, { ip: '10.0.0.1' });
        hub.attach(tA2, { ip: '10.0.0.1' });
        hub.attach(tA3, { ip: '10.0.0.1' });
        hub.attach(tB1, { ip: '10.0.0.2' });
        expect(tA1.closed).toBe(false);
        expect(tA2.closed).toBe(false);
        expect(tA3.closed).toBe(true);
        expect(tB1.closed).toBe(false);
    });
});
