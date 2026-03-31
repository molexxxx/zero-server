/**
 * Tests for QueryCache — in-memory LRU cache with TTL.
 * Tests get/set, TTL expiry, LRU eviction, prune, remember, wrap, stats,
 * invalidate, has, flush, and keyFromDescriptor.
 */
const { QueryCache } = require('../../lib/orm/cache');

let cache;
beforeEach(() => { cache = new QueryCache({ maxEntries: 5, defaultTTL: 60 }); });

// ===========================================================
//  Constructor defaults
// ===========================================================
describe('QueryCache constructor', () =>
{
    it('uses sensible defaults', () =>
    {
        const c = new QueryCache();
        expect(c._maxEntries).toBe(1000);
        expect(c._defaultTTL).toBe(60);
        expect(c._prefix).toBe('qc:');
    });

    it('respects custom options', () =>
    {
        const c = new QueryCache({ maxEntries: 50, defaultTTL: 120, prefix: 'app:' });
        expect(c._maxEntries).toBe(50);
        expect(c._defaultTTL).toBe(120);
        expect(c._prefix).toBe('app:');
    });

    it('floors maxEntries to at least 1', () =>
    {
        expect(new QueryCache({ maxEntries: 0 })._maxEntries).toBe(1);
        expect(new QueryCache({ maxEntries: -5 })._maxEntries).toBe(1);
    });

    it('clamps defaultTTL to at least 0', () =>
    {
        expect(new QueryCache({ defaultTTL: -10 })._defaultTTL).toBe(0);
    });
});

// ===========================================================
//  get / set
// ===========================================================
describe('get / set', () =>
{
    it('returns undefined for missing key', () =>
    {
        expect(cache.get('nope')).toBeUndefined();
    });

    it('stores and retrieves values', () =>
    {
        cache.set('k1', { data: 42 });
        expect(cache.get('k1')).toEqual({ data: 42 });
    });

    it('stores different value types', () =>
    {
        cache.set('str', 'hello');
        cache.set('num', 123);
        cache.set('arr', [1, 2]);
        cache.set('bool', true);
        expect(cache.get('str')).toBe('hello');
        expect(cache.get('num')).toBe(123);
        expect(cache.get('arr')).toEqual([1, 2]);
        expect(cache.get('bool')).toBe(true);
    });
});

// ===========================================================
//  TTL Expiry
// ===========================================================
describe('TTL expiry', () =>
{
    it('expires entries after TTL', () =>
    {
        vi.useFakeTimers();
        cache.set('ephemeral', 'data', 2); // 2 seconds
        expect(cache.get('ephemeral')).toBe('data');
        vi.advanceTimersByTime(3000);
        expect(cache.get('ephemeral')).toBeUndefined();
        vi.useRealTimers();
    });

    it('does not expire when TTL=0', () =>
    {
        vi.useFakeTimers();
        cache.set('forever', 'data', 0);
        vi.advanceTimersByTime(999999);
        expect(cache.get('forever')).toBe('data');
        vi.useRealTimers();
    });
});

// ===========================================================
//  LRU Eviction
// ===========================================================
describe('LRU eviction', () =>
{
    it('evicts oldest entry when at capacity', () =>
    {
        // maxEntries = 5
        for (let i = 0; i < 5; i++) cache.set(`k${i}`, i);
        expect(cache.get('k0')).toBe(0); // still accessible, also marks it as recent
        cache.set('k5', 5); // should evict k1 (oldest untouched)
        expect(cache.get('k1')).toBeUndefined();
        expect(cache.get('k5')).toBe(5);
    });
});

// ===========================================================
//  delete
// ===========================================================
describe('delete', () =>
{
    it('removes an existing key', () =>
    {
        cache.set('k', 'v');
        expect(cache.delete('k')).toBe(true);
        expect(cache.get('k')).toBeUndefined();
    });

    it('returns false for non-existent key', () =>
    {
        expect(cache.delete('nope')).toBe(false);
    });
});

// ===========================================================
//  has
// ===========================================================
describe('has', () =>
{
    it('returns true for existing key', () =>
    {
        cache.set('k', 1);
        expect(cache.has('k')).toBe(true);
    });

    it('returns false for missing key', () =>
    {
        expect(cache.has('nope')).toBe(false);
    });

    it('returns false for expired key and removes it', () =>
    {
        vi.useFakeTimers();
        cache.set('exp', 'data', 1);
        vi.advanceTimersByTime(2000);
        expect(cache.has('exp')).toBe(false);
        vi.useRealTimers();
    });
});

// ===========================================================
//  invalidate
// ===========================================================
describe('invalidate', () =>
{
    it('removes entries matching table name', () =>
    {
        cache.set('users|select|[]', []);
        cache.set('users|count|[]', 5);
        cache.set('posts|select|[]', []);
        const count = cache.invalidate('users');
        expect(count).toBe(2);
        expect(cache.get('users|select|[]')).toBeUndefined();
        expect(cache.get('posts|select|[]')).toEqual([]);
    });

    it('returns 0 when no matches', () =>
    {
        cache.set('posts|select|[]', []);
        expect(cache.invalidate('users')).toBe(0);
    });
});

// ===========================================================
//  flush
// ===========================================================
describe('flush', () =>
{
    it('clears all entries and resets stats', () =>
    {
        cache.set('a', 1);
        cache.set('b', 2);
        cache.get('a'); // hit
        cache.get('nope'); // miss
        const count = cache.flush();
        expect(count).toBe(2);
        expect(cache.stats().size).toBe(0);
        expect(cache.stats().hits).toBe(0);
        expect(cache.stats().misses).toBe(0);
    });
});

// ===========================================================
//  stats
// ===========================================================
describe('stats', () =>
{
    it('tracks hits and misses', () =>
    {
        cache.set('k', 1);
        cache.get('k');    // hit
        cache.get('k');    // hit
        cache.get('miss'); // miss
        const s = cache.stats();
        expect(s.hits).toBe(2);
        expect(s.misses).toBe(1);
        expect(s.hitRate).toBeCloseTo(2 / 3);
        expect(s.size).toBe(1);
        expect(s.maxEntries).toBe(5);
    });

    it('hitRate is 0 when no operations', () =>
    {
        expect(cache.stats().hitRate).toBe(0);
    });
});

// ===========================================================
//  prune
// ===========================================================
describe('prune', () =>
{
    it('removes expired entries', () =>
    {
        vi.useFakeTimers();
        cache.set('a', 1, 1);
        cache.set('b', 2, 1);
        cache.set('c', 3, 100);
        vi.advanceTimersByTime(2000);
        const count = cache.prune();
        expect(count).toBe(2);
        expect(cache.get('c')).toBe(3);
        vi.useRealTimers();
    });

    it('returns 0 when nothing expired', () =>
    {
        cache.set('a', 1, 300);
        expect(cache.prune()).toBe(0);
    });
});

// ===========================================================
//  remember
// ===========================================================
describe('remember', () =>
{
    it('calls fn on cache miss and stores result', async () =>
    {
        const fn = vi.fn().mockResolvedValue({ users: ['Alice'] });
        const result = await cache.remember('users', fn, 30);
        expect(result).toEqual({ users: ['Alice'] });
        expect(fn).toHaveBeenCalledOnce();
        // Second call should use cache
        const result2 = await cache.remember('users', fn, 30);
        expect(result2).toEqual({ users: ['Alice'] });
        expect(fn).toHaveBeenCalledOnce(); // not called again
    });

    it('returns cached value on hit', async () =>
    {
        cache.set('key', 42);
        const fn = vi.fn();
        const result = await cache.remember('key', fn);
        expect(result).toBe(42);
        expect(fn).not.toHaveBeenCalled();
    });
});

// ===========================================================
//  wrap
// ===========================================================
describe('wrap', () =>
{
    it('caches query execution by descriptor', async () =>
    {
        const executor = vi.fn().mockResolvedValue([{ id: 1 }]);
        const descriptor = { table: 'users', action: 'select', where: [] };
        const r1 = await cache.wrap(descriptor, executor, 60);
        const r2 = await cache.wrap(descriptor, executor, 60);
        expect(r1).toEqual([{ id: 1 }]);
        expect(r2).toEqual([{ id: 1 }]);
        expect(executor).toHaveBeenCalledOnce();
    });

    it('different descriptors produce different cache keys', async () =>
    {
        const ex1 = vi.fn().mockResolvedValue('A');
        const ex2 = vi.fn().mockResolvedValue('B');
        await cache.wrap({ table: 'users', action: 'select', where: [] }, ex1);
        await cache.wrap({ table: 'posts', action: 'select', where: [] }, ex2);
        expect(ex1).toHaveBeenCalledOnce();
        expect(ex2).toHaveBeenCalledOnce();
    });
});

// ===========================================================
//  keyFromDescriptor
// ===========================================================
describe('keyFromDescriptor', () =>
{
    it('generates a stable key from descriptor', () =>
    {
        const desc = { table: 'users', action: 'select', where: [{ field: 'active', op: '=', value: true }], orderBy: [{ field: 'name', dir: 'asc' }] };
        const key = QueryCache.keyFromDescriptor(desc);
        expect(typeof key).toBe('string');
        expect(key).toContain('users');
        expect(key).toContain('select');
    });

    it('includes all descriptor fields', () =>
    {
        const key = QueryCache.keyFromDescriptor({
            table: 'users', action: 'select', where: [], orderBy: [], fields: ['name'],
            limit: 10, offset: 5, distinct: true, groupBy: ['role'], having: [], joins: [],
        });
        expect(key).toContain('users');
        expect(key).toContain('10');
        expect(key).toContain('5');
        expect(key).toContain('d'); // distinct flag
    });

    it('handles empty descriptor', () =>
    {
        const key = QueryCache.keyFromDescriptor({});
        expect(typeof key).toBe('string');
    });
});



// =========================================================================
//  cache — deep coverage (from coverage/deep.test.js)
// =========================================================================

describe('cache — deep coverage', () => {
	it('prune removes expired entries', async () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 0.01 }); // 10ms TTL
		cache.set('a', 1);
		cache.set('b', 2);
		await new Promise(r => setTimeout(r, 50));
		const pruned = cache.prune();
		expect(pruned).toBe(2);
		expect(cache.get('a')).toBeUndefined();
	});

	it('stats tracks hits and misses', () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 60 });
		cache.set('x', 'val');
		cache.get('x'); // hit
		cache.get('y'); // miss

		const stats = cache.stats();
		expect(stats.hits).toBe(1);
		expect(stats.misses).toBe(1);
		expect(stats.hitRate).toBeCloseTo(0.5);
		expect(stats.size).toBe(1);
	});

	it('remember caches function result', async () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 60 });
		let calls = 0;
		const val = await cache.remember('key', async () => { calls++; return 'computed'; });
		expect(val).toBe('computed');
		expect(calls).toBe(1);

		const val2 = await cache.remember('key', async () => { calls++; return 'again'; });
		expect(val2).toBe('computed');
		expect(calls).toBe(1); // cached, not called again
	});

	it('wrap caches query results', async () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 60 });
		let calls = 0;
		const descriptor = { table: 'users', action: 'select', where: [{ field: 'active', value: true }] };

		const result = await cache.wrap(descriptor, async () => { calls++; return [{ id: 1 }]; });
		expect(result).toEqual([{ id: 1 }]);

		const result2 = await cache.wrap(descriptor, async () => { calls++; return [{ id: 2 }]; });
		expect(result2).toEqual([{ id: 1 }]); // cached
		expect(calls).toBe(1);
	});

	it('keyFromDescriptor generates deterministic keys', () => {
		const { QueryCache } = require('../../');
		const d1 = { table: 'users', action: 'select', where: [], orderBy: [] };
		const d2 = { table: 'users', action: 'select', where: [], orderBy: [] };
		expect(QueryCache.keyFromDescriptor(d1)).toBe(QueryCache.keyFromDescriptor(d2));
	});

	it('LRU eviction when maxEntries reached', () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ maxEntries: 3, defaultTTL: 60 });
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3);
		cache.set('d', 4); // evicts 'a'
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('d')).toBe(4);
	});

	it('has checks expiry', async () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 0.01 });
		cache.set('exp', 'val');
		expect(cache.has('exp')).toBe(true);
		await new Promise(r => setTimeout(r, 50));
		expect(cache.has('exp')).toBe(false);
	});

	it('delete removes a key', () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 60 });
		cache.set('del', 'val');
		expect(cache.delete('del')).toBe(true);
		expect(cache.get('del')).toBeUndefined();
	});

	it('invalidate removes table-related entries', () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 60 });
		cache.set('users|select|[]', []);
		cache.set('users|count|[]', 5);
		cache.set('posts|select|[]', []);
		const count = cache.invalidate('users');
		expect(count).toBe(2);
		expect(cache.get('posts|select|[]')).toEqual([]);
	});

	it('flush clears everything and resets stats', () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 60 });
		cache.set('a', 1);
		cache.get('a');
		cache.get('b');
		const flushed = cache.flush();
		expect(flushed).toBe(1);
		const stats = cache.stats();
		expect(stats.hits).toBe(0);
		expect(stats.misses).toBe(0);
		expect(stats.size).toBe(0);
	});

	it('get returns undefined for expired entries', async () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 0.01 });
		cache.set('x', 'val');
		await new Promise(r => setTimeout(r, 50));
		expect(cache.get('x')).toBeUndefined();
	});

	it('set with explicit TTL overrides default', async () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 60 });
		cache.set('shortlived', 'val', 0.01);
		await new Promise(r => setTimeout(r, 50));
		expect(cache.get('shortlived')).toBeUndefined();
	});

	it('set with TTL 0 means no expiry', async () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ defaultTTL: 0 });
		cache.set('forever', 'val');
		await new Promise(r => setTimeout(r, 50));
		expect(cache.get('forever')).toBe('val');
	});

	it('constructor with edge values', () => {
		const { QueryCache } = require('../../');
		const cache = new QueryCache({ maxEntries: 0, defaultTTL: -5 });
		expect(cache._maxEntries).toBe(1); // Should be at least 1
		expect(cache._defaultTTL).toBe(0); // Should be at least 0
	});
});