/**
 * @module orm/cache
 * @description Query caching layer for the zero-http ORM.
 *              Provides an in-memory LRU cache with TTL support.
 *              Can also delegate to a Redis adapter for distributed caching.
 *
 * @example
 *   const { Database, QueryCache } = require('zero-http');
 *
 *   const db = Database.connect('sqlite', { filename: './app.db' });
 *   const cache = new QueryCache({ maxEntries: 500, defaultTTL: 60 });
 *
 *   // Attach cache to database
 *   db.cache = cache;
 *
 *   // Use in queries (via Model.query().cache(ttl))
 *   const users = await User.query().where('active', true).cache(30).exec();
 *
 *   // Manual cache operations
 *   cache.set('custom:key', { data: 'value' }, 120);
 *   const val = cache.get('custom:key');
 *   cache.invalidate('users');   // Clear all user-related caches
 *   cache.flush();               // Clear everything
 */

const log = require('../debug')('zero:cache');

class QueryCache
{
    /**
     * @constructor
     * @param {object} [options] - Configuration options.
     * @param {number} [options.maxEntries=1000] - Maximum cache entries (LRU eviction).
     * @param {number} [options.defaultTTL=60]   - Default TTL in seconds (0 = no expiry).
     * @param {string} [options.prefix='qc:']    - Key prefix for cache namespacing.
     * @param {object} [options.redis]           - Redis adapter instance for distributed caching.
     */
    constructor(options = {})
    {
        this._maxEntries = Math.max(1, Math.floor(options.maxEntries != null ? options.maxEntries : 1000) || 1);
        this._defaultTTL = Math.max(0, Number(options.defaultTTL != null ? options.defaultTTL : 60) || 0);
        this._prefix = options.prefix || 'qc:';
        this._redis = options.redis || null;

        // In-memory LRU storage
        /** @private Map of key → { value, expiresAt, accessedAt } */
        this._store = new Map();

        // Stats
        this._hits = 0;
        this._misses = 0;
    }

    /**
     * Generate a cache key from a query descriptor.
     * @param {object} descriptor - Query builder descriptor.
     * @returns {string} Deterministic cache key derived from the descriptor.
     */
    static keyFromDescriptor(descriptor)
    {
        const parts = [
            descriptor.table || '',
            descriptor.action || 'select',
            JSON.stringify(descriptor.where || []),
            JSON.stringify(descriptor.orderBy || []),
            JSON.stringify(descriptor.fields || []),
            descriptor.limit || '',
            descriptor.offset || '',
            descriptor.distinct ? 'd' : '',
            JSON.stringify(descriptor.groupBy || []),
            JSON.stringify(descriptor.having || []),
            JSON.stringify(descriptor.joins || []),
        ];
        return parts.join('|');
    }

    /**
     * Get a cached value.
     * @param {string} key - Cache key.
     * @returns {*|undefined} Cached value, or undefined if miss.
     */
    get(key)
    {
        const prefixedKey = this._prefix + key;

        // Redis mode
        if (this._redis) return this._getRedis(key);

        const entry = this._store.get(prefixedKey);
        if (!entry)
        {
            this._misses++;
            return undefined;
        }

        // Check TTL
        if (entry.expiresAt && Date.now() > entry.expiresAt)
        {
            this._store.delete(prefixedKey);
            this._misses++;
            return undefined;
        }

        // LRU: move to end (most recently used)
        this._store.delete(prefixedKey);
        entry.accessedAt = Date.now();
        this._store.set(prefixedKey, entry);

        this._hits++;
        return entry.value;
    }

    /**
     * Set a cached value.
     * @param {string} key - Cache key.
     * @param {*} value - Value to cache.
     * @param {number} [ttl] - TTL in seconds. Defaults to defaultTTL.
     */
    set(key, value, ttl)
    {
        const prefixedKey = this._prefix + key;
        const seconds = Math.max(0, Number(ttl !== undefined ? ttl : this._defaultTTL) || 0);

        // Redis mode
        if (this._redis) return this._setRedis(key, value, seconds);

        // Evict LRU entries if at capacity
        while (this._store.size >= this._maxEntries)
        {
            const firstKey = this._store.keys().next().value;
            this._store.delete(firstKey);
            log('LRU evict: %s', firstKey);
        }

        this._store.set(prefixedKey, {
            value,
            expiresAt: seconds > 0 ? Date.now() + (seconds * 1000) : null,
            accessedAt: Date.now(),
        });
    }

    /**
     * Delete a specific cache entry.
     * @param {string} key - Cache key.
     * @returns {boolean} True if the key existed.
     */
    delete(key)
    {
        if (this._redis) return this._deleteRedis(key);
        return this._store.delete(this._prefix + key);
    }

    /**
     * Check if a key exists in cache (and is not expired).
     * @param {string} key - Cache key.
     * @returns {boolean} True if the key exists and is not expired.
     */
    has(key)
    {
        if (this._redis) return this._hasRedis(key);

        const entry = this._store.get(this._prefix + key);
        if (!entry) return false;
        if (entry.expiresAt && Date.now() > entry.expiresAt)
        {
            this._store.delete(this._prefix + key);
            return false;
        }
        return true;
    }

    /**
     * Invalidate all cache entries for a specific table/model.
     * Removes any cache key that contains the table name.
     * @param {string} table - Table name to invalidate.
     * @returns {number} Number of entries removed.
     */
    invalidate(table)
    {
        if (this._redis) return this._invalidateRedis(table);

        let count = 0;
        for (const key of this._store.keys())
        {
            // Check if the key's descriptor contains this table
            if (key.includes(table))
            {
                this._store.delete(key);
                count++;
            }
        }
        log('Invalidated %d entries for "%s"', count, table);
        return count;
    }

    /**
     * Clear the entire cache.
     * @returns {number} Number of entries flushed.
     */
    flush()
    {
        if (this._redis) return this._flushRedis();

        const count = this._store.size;
        this._store.clear();
        this._hits = 0;
        this._misses = 0;
        log('Flushed %d entries', count);
        return count;
    }

    /**
     * Get cache statistics.
     * @returns {{ size: number, hits: number, misses: number, hitRate: number, maxEntries: number }}
     */
    stats()
    {
        const total = this._hits + this._misses;
        return {
            size: this._store.size,
            hits: this._hits,
            misses: this._misses,
            hitRate: total > 0 ? (this._hits / total) : 0,
            maxEntries: this._maxEntries,
        };
    }

    /**
     * Remove expired entries (garbage collection).
     * Called automatically but can be triggered manually.
     * @returns {number} Number of expired entries removed.
     */
    prune()
    {
        let count = 0;
        const now = Date.now();
        for (const [key, entry] of this._store)
        {
            if (entry.expiresAt && now > entry.expiresAt)
            {
                this._store.delete(key);
                count++;
            }
        }
        if (count > 0) log('Pruned %d expired entries', count);
        return count;
    }

    /**
     * Get or set: return cached value if available, otherwise call fn() and cache the result.
     * @param {string} key - Cache key.
     * @param {Function} fn - Async function to compute the value.
     * @param {number} [ttl] - TTL in seconds.
     * @returns {Promise<*>} Resolved value.
     *
     * @example
     *   const users = await cache.remember('active-users', async () => {
     *       return User.find({ active: true });
     *   }, 60);
     */
    async remember(key, fn, ttl)
    {
        const cached = this._redis ? await this.get(key) : this.get(key);
        if (cached !== undefined) return cached;

        const value = await fn();
        if (this._redis) await this.set(key, value, ttl);
        else this.set(key, value, ttl);
        return value;
    }

    /**
     * Wrap a query execution with caching.
     * Used internally by the Query builder's `.cache()` method.
     *
     * @param {object} descriptor - Query descriptor.
     * @param {Function} executor - Function that executes the query.
     * @param {number} [ttl]     - TTL in seconds.
     * @returns {Promise<*>} Resolved value.
     */
    async wrap(descriptor, executor, ttl)
    {
        const key = QueryCache.keyFromDescriptor(descriptor);
        return this.remember(key, executor, ttl);
    }

    // -- Redis-Backed Methods -----------------------------

    /** @private */
    async _getRedis(key)
    {
        try
        {
            const val = await this._redis.get(this._prefix + key);
            if (val === null)
            {
                this._misses++;
                return undefined;
            }
            this._hits++;
            try { return JSON.parse(val); }
            catch (_) { return val; }
        }
        catch (_)
        {
            this._misses++;
            return undefined;
        }
    }

    /** @private */
    async _setRedis(key, value, ttl)
    {
        const v = JSON.stringify(value);
        if (ttl > 0) await this._redis.set(this._prefix + key, v, ttl);
        else await this._redis.set(this._prefix + key, v);
    }

    /** @private */
    async _deleteRedis(key)
    {
        const result = await this._redis.del(this._prefix + key);
        return result > 0;
    }

    /** @private */
    async _hasRedis(key)
    {
        return await this._redis.exists(this._prefix + key);
    }

    /** @private */
    async _invalidateRedis(table)
    {
        // Use SCAN to find matching keys
        let count = 0;
        let cursor = '0';
        const pattern = this._prefix + '*' + table + '*';
        const client = this._redis._client || this._redis;
        do
        {
            const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            if (keys.length > 0)
            {
                await client.del(...keys);
                count += keys.length;
            }
        } while (cursor !== '0');
        return count;
    }

    /** @private */
    async _flushRedis()
    {
        let count = 0;
        let cursor = '0';
        const pattern = this._prefix + '*';
        const client = this._redis._client || this._redis;
        do
        {
            const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            if (keys.length > 0)
            {
                await client.del(...keys);
                count += keys.length;
            }
        } while (cursor !== '0');
        this._hits = 0;
        this._misses = 0;
        return count;
    }
}

module.exports = { QueryCache };
