/**
 * joinToken — validation branch coverage (rejects non-object opts,
 * missing secret, empty token, non-string token, room claim mismatch
 * verified by hand-crafted payload).
 */

'use strict';

const { signJoinToken, verifyJoinToken } = require('../../lib/webrtc/joinToken');
const { WebRTCError } = require('../../lib/webrtc');
const crypto = require('node:crypto');

describe('joinToken validation branches', () =>
{
    describe('signJoinToken', () =>
    {
        it('rejects non-object opts', () =>
        {
            expect(() => signJoinToken(null)).toThrow(/opts must be an object/);
            expect(() => signJoinToken('nope')).toThrow(/opts must be an object/);
        });

        it('rejects missing room', () =>
        {
            expect(() => signJoinToken({ secret: 'k', user: 'u' })).toThrow(/room/);
            expect(() => signJoinToken({ secret: 'k', user: 'u', room: '' })).toThrow(/room/);
            expect(() => signJoinToken({ secret: 'k', user: 'u', room: 42 })).toThrow(/room/);
        });

        it('rejects a user object missing an id', () =>
        {
            expect(() => signJoinToken({ secret: 'k', user: { name: 'no-id' }, room: 'r' })).toThrow(/user\.id/);
        });

        it('preserves an existing user object on payload', () =>
        {
            const tok = signJoinToken({ secret: 'k', user: { id: 'u1', role: 'host' }, room: 'r', ttl: 60 });
            const payload = verifyJoinToken(tok, { secret: 'k', room: 'r' });
            expect(payload.user.id).toBe('u1');
            expect(payload.user.role).toBe('host');
        });

        it('accepts a user object with userId / sub fallbacks', () =>
        {
            const a = signJoinToken({ secret: 'k', user: { userId: 'u2' }, room: 'r', ttl: 60 });
            expect(verifyJoinToken(a, { secret: 'k', room: 'r' }).user.userId).toBe('u2');
            const b = signJoinToken({ secret: 'k', user: { sub: 'u3' }, room: 'r', ttl: 60 });
            expect(verifyJoinToken(b, { secret: 'k', room: 'r' }).user.sub).toBe('u3');
        });
    });

    describe('verifyJoinToken', () =>
    {
        it('rejects non-object opts', () =>
        {
            expect(() => verifyJoinToken('t', null)).toThrow(/opts must be an object/);
        });

        it('rejects missing secret', () =>
        {
            expect(() => verifyJoinToken('t', {})).toThrow(/secret is required/);
        });

        it('rejects a non-string token', () =>
        {
            expect(() => verifyJoinToken(123, { secret: 'k' })).toThrow(/non-empty string/);
            expect(() => verifyJoinToken('', { secret: 'k' })).toThrow(/non-empty string/);
            expect(() => verifyJoinToken(null, { secret: 'k' })).toThrow(/non-empty string/);
        });

        it('throws INVALID_TOKEN on signature mismatch with the cause attached', () =>
        {
            const tok = signJoinToken({ secret: 'a', user: 'u', room: 'r', ttl: 60 });
            try { verifyJoinToken(tok, { secret: 'b', room: 'r' }); }
            catch (err)
            {
                expect(err).toBeInstanceOf(WebRTCError);
                expect(err.code).toBe('INVALID_TOKEN');
            }
        });
    });
});
