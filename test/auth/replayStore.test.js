const { InMemoryReplayStore } = require('../../lib/auth/twoFactor');

describe('InMemoryReplayStore', () =>
{
    let store;

    beforeEach(() =>
    {
        store = new InMemoryReplayStore();
    });

    afterEach(() =>
    {
        store.destroy();
    });

    // --- get / set basics ---

    it('should return null for unknown user', async () =>
    {
        const result = await store.get('user-1');
        expect(result).toBeNull();
    });

    it('should store and retrieve a counter', async () =>
    {
        await store.set('user-1', 42, 60000);
        const result = await store.get('user-1');
        expect(result).toBe(42);
    });

    it('should overwrite counter for same user', async () =>
    {
        await store.set('user-1', 10, 60000);
        await store.set('user-1', 20, 60000);
        const result = await store.get('user-1');
        expect(result).toBe(20);
    });

    it('should isolate counters per user', async () =>
    {
        await store.set('alice', 100, 60000);
        await store.set('bob', 200, 60000);
        expect(await store.get('alice')).toBe(100);
        expect(await store.get('bob')).toBe(200);
    });

    // --- TTL expiry ---

    it('should expire entries after TTL', async () =>
    {
        await store.set('user-1', 42, 1); // 1ms TTL
        // Wait for expiry
        await new Promise(r => setTimeout(r, 10));
        const result = await store.get('user-1');
        expect(result).toBeNull();
    });

    it('should not expire entries before TTL', async () =>
    {
        await store.set('user-1', 42, 60000);
        const result = await store.get('user-1');
        expect(result).toBe(42);
    });

    // --- clear ---

    it('should clear all entries', async () =>
    {
        await store.set('a', 1, 60000);
        await store.set('b', 2, 60000);
        store.clear();
        expect(await store.get('a')).toBeNull();
        expect(await store.get('b')).toBeNull();
    });

    // --- destroy ---

    it('should clear entries and stop prune timer on destroy', () =>
    {
        store.destroy();
        expect(store._store.size).toBe(0);
        // Calling destroy again should not throw
        store.destroy();
    });

    // --- edge cases ---

    it('should handle empty string user ID', async () =>
    {
        await store.set('', 5, 60000);
        expect(await store.get('')).toBe(5);
    });

    it('should handle counter value of 0', async () =>
    {
        await store.set('user-1', 0, 60000);
        const result = await store.get('user-1');
        expect(result).toBe(0);
    });

    it('should handle negative counter values', async () =>
    {
        await store.set('user-1', -1, 60000);
        expect(await store.get('user-1')).toBe(-1);
    });

    it('should handle very large counter values', async () =>
    {
        const large = Number.MAX_SAFE_INTEGER;
        await store.set('user-1', large, 60000);
        expect(await store.get('user-1')).toBe(large);
    });

    // --- concurrent operations ---

    it('should handle rapid concurrent sets', async () =>
    {
        const promises = [];
        for (let i = 0; i < 100; i++)
        {
            promises.push(store.set(`user-${i}`, i, 60000));
        }
        await Promise.all(promises);

        for (let i = 0; i < 100; i++)
        {
            expect(await store.get(`user-${i}`)).toBe(i);
        }
    });

    it('should handle concurrent get and set on same key', async () =>
    {
        await store.set('user-1', 10, 60000);

        const [getResult] = await Promise.all([
            store.get('user-1'),
            store.set('user-1', 20, 60000),
        ]);

        // get should return either 10 or 20
        expect([10, 20]).toContain(getResult);
        // final value should be 20
        expect(await store.get('user-1')).toBe(20);
    });
});
