'use strict';

const crypto = require('node:crypto');
const { issueTurnCredentials } = require('../../lib/webrtc/turn/credentials');
const { TurnError } = require('../../lib/errors');

// --- Helpers ---

/** Mirror of the RFC 7635 derivation for cross-checking. */
function expectedCredential(secret, username)
{
    return crypto.createHmac('sha1', secret).update(username).digest('base64');
}

// --- Tests ---

describe('issueTurnCredentials', () =>
{
    it('returns an RTCIceServer-style payload with username, credential, ttl, and urls', () =>
    {
        const now = Math.floor(Date.now() / 1000);
        const creds = issueTurnCredentials({
            secret:  'shared-secret',
            userId:  'alice',
            ttl:     1200,
            servers: ['turn:turn.example.com:3478?transport=udp'],
        });

        expect(typeof creds.username).toBe('string');
        expect(typeof creds.credential).toBe('string');
        expect(creds.ttl).toBe(1200);
        expect(Array.isArray(creds.urls)).toBe(true);
        expect(creds.urls).toEqual(['turn:turn.example.com:3478?transport=udp']);

        // username is "<unixExpiry>:<userId>"
        const [expiryStr, userId] = creds.username.split(':');
        expect(userId).toBe('alice');
        const expiry = Number(expiryStr);
        expect(Number.isInteger(expiry)).toBe(true);
        // expiry must be ~now + ttl (allow 5s clock slack for slow CI)
        expect(expiry).toBeGreaterThanOrEqual(now + 1200 - 5);
        expect(expiry).toBeLessThanOrEqual(now + 1200 + 5);
    });

    it('produces a credential equal to base64(HMAC-SHA1(secret, username)) (RFC 7635)', () =>
    {
        const creds = issueTurnCredentials({
            secret:  'topsecret',
            userId:  'bob',
            ttl:     600,
            servers: ['turn:t.example.com:3478'],
        });
        expect(creds.credential).toBe(expectedCredential('topsecret', creds.username));
    });

    it('accepts ttl as a duration string ("20m", "2h", "1d", "30s")', () =>
    {
        const now = Math.floor(Date.now() / 1000);
        const cases = [
            ['30s', 30],
            ['20m', 20 * 60],
            ['2h',  2 * 3600],
            ['1d',  86400],
        ];
        for (const [str, seconds] of cases)
        {
            const c = issueTurnCredentials({
                secret: 'k', userId: 'u', ttl: str, servers: ['turn:x:3478'],
            });
            expect(c.ttl).toBe(seconds);
            const [expiry] = c.username.split(':').map(Number);
            expect(expiry).toBeGreaterThanOrEqual(now + seconds - 5);
            expect(expiry).toBeLessThanOrEqual(now + seconds + 5);
        }
    });

    it('defaults ttl to 86400 seconds (24h) when omitted', () =>
    {
        const c = issueTurnCredentials({
            secret: 'k', userId: 'u', servers: ['turn:x:3478'],
        });
        expect(c.ttl).toBe(86400);
    });

    it('coerces non-string userId via String() so numeric IDs work', () =>
    {
        const c = issueTurnCredentials({
            secret: 'k', userId: 42, ttl: 60, servers: ['turn:x:3478'],
        });
        const [, userId] = c.username.split(':');
        expect(userId).toBe('42');
    });

    it('accepts a single server string and normalizes to an array', () =>
    {
        const c = issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: 60, servers: 'turn:x.example:3478',
        });
        expect(c.urls).toEqual(['turn:x.example:3478']);
    });

    it('validates each server URL has a turn: / turns: / stun: / stuns: scheme', () =>
    {
        expect(() => issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: 60, servers: ['http://nope.example'],
        })).toThrow(TurnError);
    });

    it('rejects missing secret', () =>
    {
        expect(() => issueTurnCredentials({
            userId: 'u', ttl: 60, servers: ['turn:x:3478'],
        })).toThrow(/secret/);
    });

    it('rejects missing userId', () =>
    {
        expect(() => issueTurnCredentials({
            secret: 'k', ttl: 60, servers: ['turn:x:3478'],
        })).toThrow(/userId/);
    });

    it('rejects missing or empty servers', () =>
    {
        expect(() => issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: 60,
        })).toThrow(/servers/);
        expect(() => issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: 60, servers: [],
        })).toThrow(/servers/);
    });

    it('rejects non-positive ttl', () =>
    {
        expect(() => issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: 0, servers: ['turn:x:3478'],
        })).toThrow(TurnError);
        expect(() => issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: -5, servers: ['turn:x:3478'],
        })).toThrow(TurnError);
    });

    it('rejects malformed ttl strings', () =>
    {
        expect(() => issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: 'forever', servers: ['turn:x:3478'],
        })).toThrow(TurnError);
    });

    it('produces stable username/credential pairs for a fixed clock + secret + user', () =>
    {
        // Pin the clock so two calls in the same second match exactly.
        const realNow = Date.now;
        Date.now = () => 1700000000000;
        try
        {
            const a = issueTurnCredentials({
                secret: 'k', userId: 'alice', ttl: 60, servers: ['turn:x:3478'],
            });
            const b = issueTurnCredentials({
                secret: 'k', userId: 'alice', ttl: 60, servers: ['turn:x:3478'],
            });
            expect(a.username).toBe(b.username);
            expect(a.credential).toBe(b.credential);

            // And matches the explicit RFC 7635 derivation byte-for-byte.
            expect(a.username).toBe(`${1700000000 + 60}:alice`);
            expect(a.credential).toBe(expectedCredential('k', a.username));
        }
        finally { Date.now = realNow; }
    });

    it('passes through stun: scheme servers (no credentials needed but still allowed)', () =>
    {
        const c = issueTurnCredentials({
            secret: 'k', userId: 'u', ttl: 60,
            servers: ['stun:stun.l.google.com:19302', 'turn:t.example:3478'],
        });
        expect(c.urls).toEqual([
            'stun:stun.l.google.com:19302',
            'turn:t.example:3478',
        ]);
    });
});
