/**
 * QueryCache Redis-backed method tests.
 * Mocks a Redis adapter to test _getRedis, _setRedis, _deleteRedis,
 * _hasRedis, _invalidateRedis, _flushRedis, and remember/wrap with Redis.
 */

function makeRedis()
{
    const store = new Map();
    return {
        get: vi.fn((key) => Promise.resolve(store.get(key) || null)),
        set: vi.fn((key, val, ttl) => { store.set(key, val); return Promise.resolve('OK'); }),
        del: vi.fn((...keys) => { let c = 0; for (const k of keys) { if (store.delete(k)) c++; } return Promise.resolve(c); }),
        exists: vi.fn((key) => Promise.resolve(store.has(key))),
        scan: vi.fn().mockResolvedValue(['0', []]),
        _client: null, // will set below to self
    };
}

describe('QueryCache Redis-backed methods', () =>
{
    let cache, redis;

    beforeEach(() =>
    {
        redis = makeRedis();
        redis._client = redis; // _invalidateRedis uses redis._client || redis
        const { QueryCache } = require('../../lib/orm/cache');
        cache = new QueryCache({ redis, prefix: 'test:' });
    });

    // -- _getRedis (via get) -----------------------------------
    describe('get (Redis mode)', () =>
    {
        it('returns undefined on cache miss', async () =>
        {
            const val = await cache.get('missing');
            expect(val).toBeUndefined();
            expect(cache._misses).toBe(1);
        });

        it('returns parsed JSON on cache hit', async () =>
        {
            redis.get.mockResolvedValueOnce(JSON.stringify({ name: 'Alice' }));
            const val = await cache.get('user:1');
            expect(val).toEqual({ name: 'Alice' });
            expect(cache._hits).toBe(1);
        });

        it('returns raw string when JSON parse fails', async () =>
        {
            redis.get.mockResolvedValueOnce('not-json');
            const val = await cache.get('raw');
            expect(val).toBe('not-json');
            expect(cache._hits).toBe(1);
        });

        it('returns undefined and increments misses on Redis error', async () =>
        {
            redis.get.mockRejectedValueOnce(new Error('connection lost'));
            const val = await cache.get('error');
            expect(val).toBeUndefined();
            expect(cache._misses).toBe(1);
        });
    });

    // -- _setRedis (via set) -----------------------------------
    describe('set (Redis mode)', () =>
    {
        it('sets value with TTL', async () =>
        {
            await cache.set('key', { data: 1 }, 30);
            expect(redis.set).toHaveBeenCalledWith('test:key', JSON.stringify({ data: 1 }), 30);
        });

        it('sets value without TTL when 0', async () =>
        {
            await cache.set('key', 'val', 0);
            expect(redis.set).toHaveBeenCalledWith('test:key', '"val"');
        });
    });

    // -- _deleteRedis (via delete) -----------------------------
    describe('delete (Redis mode)', () =>
    {
        it('returns true when key was deleted', async () =>
        {
            redis.del.mockResolvedValueOnce(1);
            const result = await cache.delete('existing');
            expect(result).toBe(true);
        });

        it('returns false when key did not exist', async () =>
        {
            redis.del.mockResolvedValueOnce(0);
            const result = await cache.delete('missing');
            expect(result).toBe(false);
        });
    });

    // -- _hasRedis (via has) -----------------------------------
    describe('has (Redis mode)', () =>
    {
        it('returns true when key exists', async () =>
        {
            redis.exists.mockResolvedValueOnce(true);
            expect(await cache.has('key')).toBe(true);
        });

        it('returns false when key missing', async () =>
        {
            redis.exists.mockResolvedValueOnce(false);
            expect(await cache.has('missing')).toBe(false);
        });
    });

    // -- _invalidateRedis (via invalidate) ---------------------
    describe('invalidate (Redis mode)', () =>
    {
        it('scans and deletes matching keys', async () =>
        {
            // First scan returns keys, second returns cursor 0 (done)
            redis.scan
                .mockResolvedValueOnce(['5', ['test:users|select|1', 'test:users|select|2']])
                .mockResolvedValueOnce(['0', ['test:users|count|3']]);
            redis.del.mockResolvedValue(0); // don't care about return
            const count = await cache.invalidate('users');
            expect(count).toBe(3);
            expect(redis.del).toHaveBeenCalledTimes(2);
        });

        it('returns 0 when no matching keys', async () =>
        {
            redis.scan.mockResolvedValueOnce(['0', []]);
            expect(await cache.invalidate('nonexistent')).toBe(0);
        });
    });

    // -- _flushRedis (via flush) -------------------------------
    describe('flush (Redis mode)', () =>
    {
        it('scans and deletes all prefixed keys', async () =>
        {
            redis.scan
                .mockResolvedValueOnce(['1', ['test:a', 'test:b']])
                .mockResolvedValueOnce(['0', []]);
            redis.del.mockResolvedValue(0);
            const count = await cache.flush();
            expect(count).toBe(2);
            expect(cache._hits).toBe(0);
            expect(cache._misses).toBe(0);
        });
    });

    // -- remember (Redis mode) --------------------------------
    describe('remember (Redis mode)', () =>
    {
        it('returns cached value without calling fn', async () =>
        {
            redis.get.mockResolvedValueOnce(JSON.stringify([1, 2, 3]));
            const fn = vi.fn();
            const result = await cache.remember('key', fn, 60);
            expect(result).toEqual([1, 2, 3]);
            expect(fn).not.toHaveBeenCalled();
        });

        it('calls fn and caches result on miss', async () =>
        {
            redis.get.mockResolvedValueOnce(null);
            const fn = vi.fn().mockResolvedValue({ fresh: true });
            const result = await cache.remember('key', fn, 60);
            expect(result).toEqual({ fresh: true });
            expect(fn).toHaveBeenCalled();
            expect(redis.set).toHaveBeenCalled();
        });
    });

    // -- wrap (Redis mode) ------------------------------------
    describe('wrap (Redis mode)', () =>
    {
        it('caches query result by descriptor', async () =>
        {
            redis.get.mockResolvedValueOnce(null); // miss
            const executor = vi.fn().mockResolvedValue([{ id: 1 }]);
            const result = await cache.wrap({ table: 'users', action: 'select' }, executor, 30);
            expect(result).toEqual([{ id: 1 }]);
            expect(executor).toHaveBeenCalled();
            expect(redis.set).toHaveBeenCalled();
        });

        it('returns cached result on hit', async () =>
        {
            redis.get.mockResolvedValueOnce(JSON.stringify([{ id: 1 }]));
            const executor = vi.fn();
            const result = await cache.wrap({ table: 'users', action: 'select' }, executor, 30);
            expect(result).toEqual([{ id: 1 }]);
            expect(executor).not.toHaveBeenCalled();
        });
    });
});
