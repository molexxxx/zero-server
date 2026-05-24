/**
 * MemorySfuAdapter — branch coverage for stats lookups that throw
 * when called with unknown ids (consumer / transport).
 */

'use strict';

const { MemorySfuAdapter } = require('../../lib/webrtc');

describe('MemorySfuAdapter unknown-id branches', () =>
{
    it('getConsumerStats throws WEBRTC_SFU_NO_CONSUMER for unknown id', async () =>
    {
        const sfu = new MemorySfuAdapter();
        try { await sfu.getConsumerStats('nope'); throw new Error('should have thrown'); }
        catch (err) { expect(err.code).toBe('WEBRTC_SFU_NO_CONSUMER'); }
    });

    it('getTransportStats throws WEBRTC_SFU_NO_TRANSPORT for unknown id', async () =>
    {
        const sfu = new MemorySfuAdapter();
        try { await sfu.getTransportStats('nope'); throw new Error('should have thrown'); }
        catch (err) { expect(err.code).toBe('WEBRTC_SFU_NO_TRANSPORT'); }
    });

    it('enableTraceEvent throws for closed/unknown router', async () =>
    {
        const sfu = new MemorySfuAdapter();
        await expect(sfu.enableTraceEvent('nope', ['ice'])).rejects.toThrow(/unknown router/);
        const router = await sfu.createRouter();
        await sfu.closeRouter(router.id);
        await expect(sfu.enableTraceEvent(router.id, ['ice'])).rejects.toThrow(/unknown router/);
    });

    it('enableTraceEvent does not throw on a live router', async () =>
    {
        const sfu = new MemorySfuAdapter();
        const router = await sfu.createRouter();
        await expect(sfu.enableTraceEvent(router.id, ['ice', 'dtls'])).resolves.toBeUndefined();
        await expect(sfu.enableTraceEvent(router.id, null)).resolves.toBeUndefined();
    });
});
