/**
 * @module orm/adapters/redis
 * @description Redis database adapter for the zero-http ORM.
 *              Uses `ioredis` as the driver. Stores table data as Redis hashes
 *              with sorted-set indexes for ordering and filtering.
 *
 *              Bring-your-own-driver: `npm install ioredis`
 *
 *              Supports full ORM CRUD, key-value operations, pub/sub,
 *              pipelines, TTL, and all DDL/migration methods.
 *
 * @example
 *   const db = Database.connect('redis', { host: '127.0.0.1', port: 6379 });
 *   const db = Database.connect('redis', { url: 'redis://user:pass@host:6379/0' });
 *   const db = Database.connect('redis', { url: 'redis://host:6379', prefix: 'myapp:' });
 */

let Redis;
try { Redis = require('ioredis'); } catch (_) { /* loaded lazily */ }

/**
 * ReDoS-safe SQL LIKE matcher using iterative DP.
 * % = any sequence of chars, _ = any single char. Case-insensitive.
 * @private
 */
function _likeSafe(str, pattern)
{
    const s = str.toLowerCase();
    const p = pattern.toLowerCase();
    const sLen = s.length, pLen = p.length;
    let dp = new Array(pLen + 1).fill(false);
    dp[0] = true;
    for (let j = 0; j < pLen; j++) { if (p[j] === '%') dp[j + 1] = dp[j]; }
    for (let i = 1; i <= sLen; i++)
    {
        const next = new Array(pLen + 1).fill(false);
        for (let j = 1; j <= pLen; j++)
        {
            if (p[j - 1] === '%')       next[j] = dp[j] || next[j - 1];
            else if (p[j - 1] === '_')  next[j] = dp[j - 1];
            else                        next[j] = dp[j - 1] && s[i - 1] === p[j - 1];
        }
        dp = next;
    }
    return dp[pLen];
}

class RedisAdapter
{
    /**
     * @param {object} [options]
     * @param {string} [options.url]             - Redis connection URL.
     * @param {string} [options.host='127.0.0.1'] - Redis host.
     * @param {number} [options.port=6379]       - Redis port.
     * @param {string} [options.password]        - Redis password.
     * @param {number} [options.db=0]            - Redis database index.
     * @param {string} [options.prefix='zh:']    - Key prefix for namespacing.
     * @param {number} [options.maxRetries=3]    - Max connection retries.
     * @param {boolean} [options.lazyConnect=false] - If true, defer connection until first operation.
     * @param {object} [options.tls]             - TLS options for secure connections.
     * @param {string} [options.keyPrefix]       - Alias for prefix (ioredis compat).
     * @param {number} [options.connectTimeout=10000] - Connection timeout in ms.
     */
    constructor(options = {})
    {
        if (!Redis)
        {
            throw new Error(
                'Redis adapter requires the "ioredis" package.\n' +
                'Install it with: npm install ioredis'
            );
        }

        // Validate options at the boundary
        if (options.host !== undefined && (typeof options.host !== 'string' || !options.host.length))
            throw new Error('Redis: host must be a non-empty string');
        if (options.port !== undefined)
        {
            const p = Number(options.port);
            if (!Number.isInteger(p) || p < 1 || p > 65535)
                throw new Error('Redis: port must be an integer between 1 and 65535');
        }
        if (options.db !== undefined)
        {
            const d = Number(options.db);
            if (!Number.isInteger(d) || d < 0 || d > 15)
                throw new Error('Redis: db must be an integer between 0 and 15');
        }
        if (options.password !== undefined && typeof options.password !== 'string')
            throw new Error('Redis: password must be a string');
        if (options.url !== undefined && typeof options.url !== 'string')
            throw new Error('Redis: url must be a string');
        if (options.prefix !== undefined && typeof options.prefix !== 'string')
            throw new Error('Redis: prefix must be a string');
        if (options.connectTimeout !== undefined)
        {
            const ct = Number(options.connectTimeout);
            if (!Number.isFinite(ct) || ct < 0)
                throw new Error('Redis: connectTimeout must be a non-negative number');
        }

        this._prefix = options.prefix || options.keyPrefix || 'zh:';
        this._schemas = new Map();
        this._indexes = new Map();
        this._subscribers = new Map();

        // Build ioredis config
        const config = {};
        if (options.url)
        {
            this._client = new Redis(options.url, {
                maxRetriesPerRequest: options.maxRetries || 3,
                lazyConnect: options.lazyConnect || false,
                connectTimeout: options.connectTimeout || 10000,
                tls: options.tls,
                keyPrefix: undefined, // we manage prefix ourselves
            });
        }
        else
        {
            config.host = options.host || '127.0.0.1';
            config.port = options.port || 6379;
            if (options.password) config.password = options.password;
            if (options.db !== undefined) config.db = options.db;
            config.maxRetriesPerRequest = options.maxRetries || 3;
            config.lazyConnect = options.lazyConnect || false;
            config.connectTimeout = options.connectTimeout || 10000;
            if (options.tls) config.tls = options.tls;

            this._client = new Redis(config);
        }

        // Separate client for pub/sub (subscribers block the connection)
        this._subClient = null;
    }

    // -- Key Helpers --------------------------------------

    /** @private Validate a table name or key to prevent internal key collision. */
    _validateKey(key, label = 'key')
    {
        if (typeof key !== 'string' || key.length === 0)
            throw new Error(`Redis: ${label} must be a non-empty string`);
        if (/[\x00-\x1f]/.test(key))
            throw new Error(`Redis: ${label} must not contain control characters`);
    }

    /** @private Build a prefixed key for a table's metadata. */
    _key(table, ...parts)
    {
        return this._prefix + table + (parts.length ? ':' + parts.join(':') : '');
    }

    /** @private Key for a table's row hash: zh:users:row:42 */
    _rowKey(table, id)
    {
        return this._key(table, 'row', String(id));
    }

    /** @private Key for a table's ID index sorted set: zh:users:_ids */
    _idsKey(table)
    {
        return this._key(table, '_ids');
    }

    /** @private Key for a table's auto-increment counter: zh:users:_seq */
    _seqKey(table)
    {
        return this._key(table, '_seq');
    }

    /** @private Key for a table's schema definition: zh:users:_schema */
    _schemaKey(table)
    {
        return this._key(table, '_schema');
    }

    /** @private Serialize a row for storage. */
    _serialize(row)
    {
        return JSON.stringify(row);
    }

    /** @private Deserialize a stored row. */
    _deserialize(data)
    {
        if (data === null || data === undefined) return null;
        try { return JSON.parse(data); }
        catch (_) { return null; }
    }

    // -- Table Management ---------------------------------

    /**
     * Create a table (register schema + initialize index).
     * @param {string} table
     * @param {object} [schema]
     */
    async createTable(table, schema)
    {
        this._validateKey(table, 'table name');
        if (schema)
        {
            this._schemas.set(table, schema);
            await this._client.set(this._schemaKey(table), JSON.stringify(schema));
        }
        // Ensure the sequence key exists
        const exists = await this._client.exists(this._seqKey(table));
        if (!exists) await this._client.set(this._seqKey(table), '0');
    }

    /**
     * Drop a table (delete all keys).
     * @param {string} table
     */
    async dropTable(table)
    {
        // Get all row IDs
        const ids = await this._client.zrange(this._idsKey(table), 0, -1);
        const pipeline = this._client.pipeline();

        for (const id of ids)
        {
            pipeline.del(this._rowKey(table, id));
        }
        pipeline.del(this._idsKey(table));
        pipeline.del(this._seqKey(table));
        pipeline.del(this._schemaKey(table));

        // Delete any field index keys
        const schema = this._schemas.get(table);
        if (schema)
        {
            for (const col of Object.keys(schema))
            {
                pipeline.del(this._key(table, 'idx', col));
            }
        }

        await pipeline.exec();
        this._schemas.delete(table);
        this._indexes.delete(table);
    }

    // -- CRUD Operations ----------------------------------

    /**
     * Insert a row.
     * @param {string} table
     * @param {object} data
     * @returns {Promise<object>} Inserted row with ID.
     */
    async insert(table, data)
    {
        const row = { ...data };

        // Auto-increment if no ID provided
        if (row.id === undefined || row.id === null)
        {
            row.id = await this._client.incr(this._seqKey(table));
        }
        else
        {
            // Ensure sequence is ahead of manual IDs
            const current = parseInt(await this._client.get(this._seqKey(table)) || '0', 10);
            if (typeof row.id === 'number' && row.id >= current)
            {
                await this._client.set(this._seqKey(table), String(row.id + 1));
            }
        }

        // Serialize dates
        for (const [k, v] of Object.entries(row))
        {
            if (v instanceof Date) row[k] = v.toISOString();
        }

        // Enforce unique constraints
        await this._enforceUnique(table, row);

        // Store the row as a JSON string
        const pipeline = this._client.pipeline();
        pipeline.set(this._rowKey(table, row.id), this._serialize(row));
        // Add to sorted set index (score = numeric id for ordering)
        pipeline.zadd(this._idsKey(table), Number(row.id) || 0, String(row.id));

        await pipeline.exec();

        return row;
    }

    /**
     * Insert multiple rows.
     * @param {string} table
     * @param {object[]} dataArray
     * @returns {Promise<object[]>}
     */
    async insertMany(table, dataArray)
    {
        const results = [];
        for (const data of dataArray) results.push(await this.insert(table, data));
        return results;
    }

    /**
     * Update a row by primary key.
     * @param {string} table
     * @param {string} pk
     * @param {*} pkVal
     * @param {object} data
     */
    async update(table, pk, pkVal, data)
    {
        const key = this._rowKey(table, pkVal);
        const existing = this._deserialize(await this._client.get(key));
        if (!existing) return;

        for (const [k, v] of Object.entries(data))
        {
            existing[k] = v instanceof Date ? v.toISOString() : v;
        }

        await this._client.set(key, this._serialize(existing));
    }

    /**
     * Update all rows matching conditions.
     * @param {string} table
     * @param {object} conditions
     * @param {object} data
     * @returns {Promise<number>}
     */
    async updateWhere(table, conditions, data)
    {
        const rows = await this._getAllRows(table);
        let count = 0;

        const pipeline = this._client.pipeline();
        for (const row of rows)
        {
            if (this._matchConditions(row, conditions))
            {
                for (const [k, v] of Object.entries(data))
                {
                    row[k] = v instanceof Date ? v.toISOString() : v;
                }
                pipeline.set(this._rowKey(table, row.id), this._serialize(row));
                count++;
            }
        }
        if (count > 0) await pipeline.exec();
        return count;
    }

    /**
     * Remove a row by primary key.
     * @param {string} table
     * @param {string} pk
     * @param {*} pkVal
     */
    async remove(table, pk, pkVal)
    {
        const pipeline = this._client.pipeline();
        pipeline.del(this._rowKey(table, pkVal));
        pipeline.zrem(this._idsKey(table), String(pkVal));
        await pipeline.exec();
    }

    /**
     * Delete all rows matching conditions.
     * @param {string} table
     * @param {object} conditions
     * @returns {Promise<number>}
     */
    async deleteWhere(table, conditions)
    {
        const rows = await this._getAllRows(table);
        let count = 0;

        const pipeline = this._client.pipeline();
        for (const row of rows)
        {
            if (this._matchConditions(row, conditions))
            {
                pipeline.del(this._rowKey(table, row.id));
                pipeline.zrem(this._idsKey(table), String(row.id));
                count++;
            }
        }
        if (count > 0) await pipeline.exec();
        return count;
    }

    // -- Query Execution ----------------------------------

    /**
     * Execute a query descriptor (from the Query builder).
     * @param {object} descriptor
     * @returns {Promise<Array|number>}
     */
    async execute(descriptor)
    {
        const { action, table, fields, where, orderBy, limit, offset, distinct, groupBy, having } = descriptor;
        let rows = await this._getAllRows(table);

        // Apply WHERE filters
        if (where && where.length > 0)
        {
            rows = rows.filter(row => this._applyWhereChain(row, where));
        }

        // Count action
        if (action === 'count') return rows.length;

        // GROUP BY
        if (groupBy && groupBy.length > 0)
        {
            const groups = new Map();
            for (const row of rows)
            {
                const key = groupBy.map(f => row[f]).join('\0');
                if (!groups.has(key)) groups.set(key, { _key: {}, _rows: [] });
                const g = groups.get(key);
                for (const f of groupBy) g._key[f] = row[f];
                g._rows.push(row);
            }
            rows = [];
            for (const g of groups.values())
            {
                const row = { ...g._key };
                row._groupRows = g._rows;
                rows.push(row);
            }

            // HAVING
            if (having && having.length > 0)
            {
                rows = rows.filter(row =>
                {
                    for (const h of having)
                    {
                        let actual;
                        if (h.field === 'COUNT(*)' || h.field.startsWith('COUNT'))
                        {
                            actual = row._groupRows.length;
                        }
                        else
                        {
                            actual = row[h.field];
                        }
                        if (!this._compareOp(actual, h.op, h.value)) return false;
                    }
                    return true;
                });
            }

            for (const row of rows) delete row._groupRows;
        }

        // ORDER BY
        if (orderBy && orderBy.length > 0)
        {
            rows.sort((a, b) =>
            {
                for (const { field, dir } of orderBy)
                {
                    const av = a[field], bv = b[field];
                    if (av < bv) return dir === 'ASC' ? -1 : 1;
                    if (av > bv) return dir === 'ASC' ? 1 : -1;
                }
                return 0;
            });
        }

        // OFFSET
        if (offset) rows = rows.slice(offset);

        // LIMIT
        if (limit) rows = rows.slice(0, limit);

        // SELECT specific fields
        if (fields && fields.length > 0)
        {
            rows = rows.map(row =>
            {
                const filtered = {};
                for (const f of fields) filtered[f] = row[f];
                return filtered;
            });
        }

        // DISTINCT
        if (distinct)
        {
            const seen = new Set();
            rows = rows.filter(row =>
            {
                const key = JSON.stringify(row);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        return rows;
    }

    /**
     * Compute an aggregate value.
     * @param {object} descriptor
     * @returns {Promise<number|null>}
     */
    async aggregate(descriptor)
    {
        const { table, where, aggregateFn, aggregateField } = descriptor;
        let rows = await this._getAllRows(table);
        if (where && where.length > 0)
        {
            rows = rows.filter(row => this._applyWhereChain(row, where));
        }
        const fn = aggregateFn.toLowerCase();
        if (!rows.length) return (fn === 'count' || fn === 'avg' || fn === 'sum') ? 0 : null;
        switch (fn)
        {
            case 'sum':   return rows.reduce((acc, r) => acc + (Number(r[aggregateField]) || 0), 0);
            case 'avg':   return rows.reduce((acc, r) => acc + (Number(r[aggregateField]) || 0), 0) / rows.length;
            case 'min':   return rows.reduce((m, r) => (r[aggregateField] < m ? r[aggregateField] : m), rows[0][aggregateField]);
            case 'max':   return rows.reduce((m, r) => (r[aggregateField] > m ? r[aggregateField] : m), rows[0][aggregateField]);
            case 'count': return rows.length;
            default:      return null;
        }
    }

    // -- Redis-Specific Operations ------------------------

    /**
     * Get a value by key (raw Redis GET).
     * @param {string} key
     * @returns {Promise<string|null>}
     */
    async get(key)
    {
        this._validateKey(key);
        return this._client.get(this._prefix + key);
    }

    /**
     * Set a key-value pair (raw Redis SET).
     * @param {string} key
     * @param {*} value
     * @param {number} [ttl] - Optional TTL in seconds.
     * @returns {Promise<string>}
     */
    async set(key, value, ttl)
    {
        this._validateKey(key);
        if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0))
            throw new Error('Redis: TTL must be a non-negative number');
        const k = this._prefix + key;
        const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (ttl) return this._client.setex(k, ttl, v);
        return this._client.set(k, v);
    }

    /**
     * Delete a key.
     * @param {string} key
     * @returns {Promise<number>} Number of keys deleted (0 or 1).
     */
    async del(key)
    {
        this._validateKey(key);
        return this._client.del(this._prefix + key);
    }

    /**
     * Check if a key exists.
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async exists(key)
    {
        this._validateKey(key);
        return (await this._client.exists(this._prefix + key)) === 1;
    }

    /**
     * Set expiration on a key.
     * @param {string} key
     * @param {number} seconds
     * @returns {Promise<number>}
     */
    async expire(key, seconds)
    {
        this._validateKey(key);
        if (!Number.isFinite(seconds) || seconds < 0)
            throw new Error('Redis: TTL must be a non-negative number');
        return this._client.expire(this._prefix + key, seconds);
    }

    /**
     * Get TTL of a key in seconds.
     * @param {string} key
     * @returns {Promise<number>} -1 if no expiry, -2 if key doesn't exist.
     */
    async ttl(key)
    {
        this._validateKey(key);
        return this._client.ttl(this._prefix + key);
    }

    /**
     * Increment a numeric key.
     * @param {string} key
     * @param {number} [by=1]
     * @returns {Promise<number>}
     */
    async incr(key, by = 1)
    {
        this._validateKey(key);
        if (by === 1) return this._client.incr(this._prefix + key);
        return this._client.incrby(this._prefix + key, by);
    }

    /**
     * Decrement a numeric key.
     * @param {string} key
     * @param {number} [by=1]
     * @returns {Promise<number>}
     */
    async decr(key, by = 1)
    {
        this._validateKey(key);
        if (by === 1) return this._client.decr(this._prefix + key);
        return this._client.decrby(this._prefix + key, by);
    }

    // -- Hash Operations ----------------------------------

    /**
     * Set a hash field.
     * @param {string} key
     * @param {string} field
     * @param {*} value
     * @returns {Promise<number>}
     */
    async hset(key, field, value)
    {
        this._validateKey(key);
        return this._client.hset(this._prefix + key, field, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }

    /**
     * Get a hash field.
     * @param {string} key
     * @param {string} field
     * @returns {Promise<string|null>}
     */
    async hget(key, field)
    {
        this._validateKey(key);
        return this._client.hget(this._prefix + key, field);
    }

    /**
     * Get all fields in a hash.
     * @param {string} key
     * @returns {Promise<object>}
     */
    async hgetall(key)
    {
        this._validateKey(key);
        return this._client.hgetall(this._prefix + key);
    }

    /**
     * Delete a hash field.
     * @param {string} key
     * @param {string} field
     * @returns {Promise<number>}
     */
    async hdel(key, field)
    {
        this._validateKey(key);
        return this._client.hdel(this._prefix + key, field);
    }

    // -- List Operations ----------------------------------

    /**
     * Push values to the end of a list.
     * @param {string} key
     * @param {...*} values
     * @returns {Promise<number>} Length of list after push.
     */
    async rpush(key, ...values)
    {
        this._validateKey(key);
        return this._client.rpush(this._prefix + key, ...values.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }

    /**
     * Push values to the beginning of a list.
     * @param {string} key
     * @param {...*} values
     * @returns {Promise<number>}
     */
    async lpush(key, ...values)
    {
        this._validateKey(key);
        return this._client.lpush(this._prefix + key, ...values.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }

    /**
     * Get a range of list elements.
     * @param {string} key
     * @param {number} [start=0]
     * @param {number} [stop=-1]
     * @returns {Promise<string[]>}
     */
    async lrange(key, start = 0, stop = -1)
    {
        this._validateKey(key);
        return this._client.lrange(this._prefix + key, start, stop);
    }

    /**
     * Pop from the end of a list.
     * @param {string} key
     * @returns {Promise<string|null>}
     */
    async rpop(key)
    {
        this._validateKey(key);
        return this._client.rpop(this._prefix + key);
    }

    /**
     * Pop from the beginning of a list.
     * @param {string} key
     * @returns {Promise<string|null>}
     */
    async lpop(key)
    {
        this._validateKey(key);
        return this._client.lpop(this._prefix + key);
    }

    /**
     * Get list length.
     * @param {string} key
     * @returns {Promise<number>}
     */
    async llen(key)
    {
        this._validateKey(key);
        return this._client.llen(this._prefix + key);
    }

    // -- Set Operations -----------------------------------

    /**
     * Add members to a set.
     * @param {string} key
     * @param {...*} members
     * @returns {Promise<number>}
     */
    async sadd(key, ...members)
    {
        this._validateKey(key);
        return this._client.sadd(this._prefix + key, ...members.map(String));
    }

    /**
     * Get all members of a set.
     * @param {string} key
     * @returns {Promise<string[]>}
     */
    async smembers(key)
    {
        this._validateKey(key);
        return this._client.smembers(this._prefix + key);
    }

    /**
     * Check if a value is a member of a set.
     * @param {string} key
     * @param {*} member
     * @returns {Promise<boolean>}
     */
    async sismember(key, member)
    {
        this._validateKey(key);
        return (await this._client.sismember(this._prefix + key, String(member))) === 1;
    }

    /**
     * Remove a member from a set.
     * @param {string} key
     * @param {*} member
     * @returns {Promise<number>}
     */
    async srem(key, member)
    {
        this._validateKey(key);
        return this._client.srem(this._prefix + key, String(member));
    }

    /**
     * Get the number of members in a set.
     * @param {string} key
     * @returns {Promise<number>}
     */
    async scard(key)
    {
        this._validateKey(key);
        return this._client.scard(this._prefix + key);
    }

    // -- Sorted Set Operations ----------------------------

    /**
     * Add a member to a sorted set.
     * @param {string} key
     * @param {number} score
     * @param {*} member
     * @returns {Promise<number>}
     */
    async zadd(key, score, member)
    {
        this._validateKey(key);
        return this._client.zadd(this._prefix + key, score, String(member));
    }

    /**
     * Get members from a sorted set by score range.
     * @param {string} key
     * @param {number|string} min
     * @param {number|string} max
     * @returns {Promise<string[]>}
     */
    async zrangebyscore(key, min, max)
    {
        this._validateKey(key);
        return this._client.zrangebyscore(this._prefix + key, min, max);
    }

    /**
     * Get members from a sorted set by rank range.
     * @param {string} key
     * @param {number} start
     * @param {number} stop
     * @returns {Promise<string[]>}
     */
    async zrange(key, start, stop)
    {
        this._validateKey(key);
        return this._client.zrange(this._prefix + key, start, stop);
    }

    /**
     * Remove a member from a sorted set.
     * @param {string} key
     * @param {*} member
     * @returns {Promise<number>}
     */
    async zrem(key, member)
    {
        this._validateKey(key);
        return this._client.zrem(this._prefix + key, String(member));
    }

    /**
     * Get sorted set cardinality.
     * @param {string} key
     * @returns {Promise<number>}
     */
    async zcard(key)
    {
        this._validateKey(key);
        return this._client.zcard(this._prefix + key);
    }

    // -- Pub/Sub ------------------------------------------

    /**
     * Subscribe to a channel.
     * @param {string} channel
     * @param {Function} callback - Called with (message, channel).
     * @returns {Promise<Function>} Unsubscribe function.
     */
    async subscribe(channel, callback)
    {
        this._validateKey(channel, 'channel');
        if (typeof callback !== 'function')
            throw new Error('Redis: subscribe callback must be a function');
        if (!this._subClient)
        {
            this._subClient = this._client.duplicate();
        }

        const prefixedChannel = this._prefix + channel;
        await this._subClient.subscribe(prefixedChannel);

        const handler = (ch, message) =>
        {
            if (ch === prefixedChannel) callback(message, channel);
        };
        this._subClient.on('message', handler);

        if (!this._subscribers.has(prefixedChannel))
        {
            this._subscribers.set(prefixedChannel, []);
        }
        this._subscribers.get(prefixedChannel).push({ callback, handler });

        // Return unsubscribe function
        return async () =>
        {
            this._subClient.removeListener('message', handler);
            const subs = this._subscribers.get(prefixedChannel) || [];
            const idx = subs.findIndex(s => s.callback === callback);
            if (idx !== -1) subs.splice(idx, 1);
            if (subs.length === 0)
            {
                await this._subClient.unsubscribe(prefixedChannel);
                this._subscribers.delete(prefixedChannel);
            }
        };
    }

    /**
     * Publish a message to a channel.
     * @param {string} channel
     * @param {*} message
     * @returns {Promise<number>} Number of subscribers that received the message.
     */
    async publish(channel, message)
    {
        this._validateKey(channel, 'channel');
        const msg = typeof message === 'object' ? JSON.stringify(message) : String(message);
        return this._client.publish(this._prefix + channel, msg);
    }

    // -- Pipeline / Batch ---------------------------------

    /**
     * Create a pipeline for batching commands.
     * @returns {Pipeline}
     *
     * @example
     *   const pipe = adapter.pipeline();
     *   pipe.set('key1', 'val1');
     *   pipe.set('key2', 'val2');
     *   const results = await pipe.exec();
     */
    pipeline()
    {
        const pipe = this._client.pipeline();
        const adapter = this;

        // Wrap to add prefix
        return {
            set(key, value, ...args)
            {
                pipe.set(adapter._prefix + key, typeof value === 'object' ? JSON.stringify(value) : String(value), ...args);
                return this;
            },
            get(key) { pipe.get(adapter._prefix + key); return this; },
            del(key) { pipe.del(adapter._prefix + key); return this; },
            hset(key, field, value)
            {
                pipe.hset(adapter._prefix + key, field, typeof value === 'object' ? JSON.stringify(value) : String(value));
                return this;
            },
            hget(key, field) { pipe.hget(adapter._prefix + key, field); return this; },
            incr(key) { pipe.incr(adapter._prefix + key); return this; },
            decr(key) { pipe.decr(adapter._prefix + key); return this; },
            expire(key, seconds) { pipe.expire(adapter._prefix + key, seconds); return this; },
            sadd(key, ...members) { pipe.sadd(adapter._prefix + key, ...members.map(String)); return this; },
            rpush(key, ...values) { pipe.rpush(adapter._prefix + key, ...values.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v))); return this; },
            async exec() { return pipe.exec(); },
        };
    }

    // -- Transaction Support ------------------------------

    /**
     * Begin a Redis MULTI transaction.
     */
    async beginTransaction()
    {
        this._multi = this._client.multi();
    }

    /**
     * Commit a MULTI transaction.
     */
    async commit()
    {
        if (this._multi)
        {
            await this._multi.exec();
            this._multi = null;
        }
    }

    /**
     * Discard a MULTI transaction.
     */
    async rollback()
    {
        if (this._multi)
        {
            this._multi.discard();
            this._multi = null;
        }
    }

    // -- Utility & Admin ----------------------------------

    /**
     * Clear all data (flush matched prefix keys).
     * Uses SCAN for safety in production (no KEYS *).
     */
    async clear()
    {
        let cursor = '0';
        do
        {
            const [nextCursor, keys] = await this._client.scan(cursor, 'MATCH', this._prefix + '*', 'COUNT', 100);
            cursor = nextCursor;
            if (keys.length > 0)
            {
                await this._client.del(...keys);
            }
        } while (cursor !== '0');
    }

    /**
     * Ping the Redis server.
     * @returns {Promise<boolean>}
     */
    async ping()
    {
        try
        {
            const result = await this._client.ping();
            return result === 'PONG';
        }
        catch (_)
        {
            return false;
        }
    }

    /**
     * Get Redis server info.
     * @param {string} [section] - Optional section (e.g., 'memory', 'clients', 'stats').
     * @returns {Promise<string>}
     */
    async info(section)
    {
        return section ? this._client.info(section) : this._client.info();
    }

    /**
     * Get database size (number of keys).
     * @returns {Promise<number>}
     */
    async dbsize()
    {
        return this._client.dbsize();
    }

    /**
     * List all table names (by scanning for schema keys).
     * @returns {Promise<string[]>}
     */
    async tables()
    {
        const tables = [];
        let cursor = '0';
        const pattern = this._prefix + '*:_schema';
        do
        {
            const [nextCursor, keys] = await this._client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            for (const key of keys)
            {
                // Extract table name: zh:users:_schema → users
                const stripped = key.slice(this._prefix.length);
                const table = stripped.replace(/:_schema$/, '');
                tables.push(table);
            }
        } while (cursor !== '0');
        return tables;
    }

    /**
     * Get stats for the adapter.
     * @returns {Promise<object>}
     */
    async stats()
    {
        const tableNames = await this.tables();
        let totalRows = 0;
        for (const t of tableNames)
        {
            totalRows += await this._client.zcard(this._idsKey(t));
        }
        return {
            tables: tableNames.length,
            totalRows,
            dbsize: await this._client.dbsize(),
            prefix: this._prefix,
        };
    }

    /**
     * Get pool/connection status.
     * @returns {{ status: string, prefix: string }}
     */
    poolStatus()
    {
        return {
            status: this._client.status,
            prefix: this._prefix,
        };
    }

    /**
     * Get the underlying ioredis client.
     * @returns {object}
     */
    get client()
    {
        return this._client;
    }

    /**
     * Execute a raw Redis command.
     * @param {string} command
     * @param {...*} args
     * @returns {Promise<*>}
     */
    async raw(command, ...args)
    {
        if (typeof command !== 'string' || command.length === 0)
            throw new Error('Redis: command must be a non-empty string');
        return this._client.call(command, ...args);
    }

    /**
     * Close the connection.
     */
    async close()
    {
        if (this._subClient)
        {
            await this._subClient.quit();
            this._subClient = null;
        }
        await this._client.quit();
    }

    // -- Migration / DDL Methods --------------------------

    /**
     * Add a column to an existing table.
     * @param {string} table
     * @param {string} column
     * @param {object} def
     */
    async addColumn(table, column, def)
    {
        const schema = this._schemas.get(table);
        if (schema) schema[column] = def;

        const defaultVal = def.default !== undefined
            ? (typeof def.default === 'function' ? def.default() : def.default)
            : null;

        // Update all existing rows
        const rows = await this._getAllRows(table);
        const pipeline = this._client.pipeline();
        for (const row of rows)
        {
            if (row[column] === undefined)
            {
                row[column] = defaultVal;
                pipeline.set(this._rowKey(table, row.id), this._serialize(row));
            }
        }
        if (rows.length > 0) await pipeline.exec();

        // Update stored schema
        await this._client.set(this._schemaKey(table), JSON.stringify(this._schemas.get(table) || {}));
    }

    /**
     * Drop a column from a table.
     * @param {string} table
     * @param {string} column
     */
    async dropColumn(table, column)
    {
        const schema = this._schemas.get(table);
        if (schema) delete schema[column];

        const rows = await this._getAllRows(table);
        const pipeline = this._client.pipeline();
        for (const row of rows)
        {
            delete row[column];
            pipeline.set(this._rowKey(table, row.id), this._serialize(row));
        }
        if (rows.length > 0) await pipeline.exec();
    }

    /**
     * Rename a column.
     * @param {string} table
     * @param {string} oldName
     * @param {string} newName
     */
    async renameColumn(table, oldName, newName)
    {
        const schema = this._schemas.get(table);
        if (schema && schema[oldName])
        {
            schema[newName] = schema[oldName];
            delete schema[oldName];
        }

        const rows = await this._getAllRows(table);
        const pipeline = this._client.pipeline();
        for (const row of rows)
        {
            if (oldName in row)
            {
                row[newName] = row[oldName];
                delete row[oldName];
                pipeline.set(this._rowKey(table, row.id), this._serialize(row));
            }
        }
        if (rows.length > 0) await pipeline.exec();
    }

    /**
     * Rename a table.
     * @param {string} oldName
     * @param {string} newName
     */
    async renameTable(oldName, newName)
    {
        const rows = await this._getAllRows(oldName);

        // Create new table with all rows
        const schema = this._schemas.get(oldName);
        if (schema)
        {
            this._schemas.set(newName, schema);
            this._schemas.delete(oldName);
        }

        const pipeline = this._client.pipeline();

        // Copy sequence
        const seq = await this._client.get(this._seqKey(oldName));
        pipeline.set(this._seqKey(newName), seq || '0');

        // Copy rows to new keys
        for (const row of rows)
        {
            pipeline.set(this._rowKey(newName, row.id), this._serialize(row));
            pipeline.zadd(this._idsKey(newName), Number(row.id) || 0, String(row.id));
        }

        // Store new schema
        if (schema)
        {
            pipeline.set(this._schemaKey(newName), JSON.stringify(schema));
        }

        await pipeline.exec();

        // Drop old table
        await this.dropTable(oldName);
    }

    /**
     * Create an index (tracked in metadata).
     * @param {string} table
     * @param {string|string[]} columns
     * @param {{ name?: string, unique?: boolean }} [options={}]
     */
    async createIndex(table, columns, options = {})
    {
        const cols = Array.isArray(columns) ? columns : [columns];
        const name = options.name || `idx_${table}_${cols.join('_')}`;
        if (!this._indexes.has(table)) this._indexes.set(table, []);
        this._indexes.get(table).push({ name, columns: cols, unique: !!options.unique });
    }

    /**
     * Drop an index.
     * @param {string} _table
     * @param {string} name
     */
    async dropIndex(_table, name)
    {
        for (const [, indexes] of this._indexes)
        {
            const idx = indexes.findIndex(i => i.name === name);
            if (idx !== -1) { indexes.splice(idx, 1); return; }
        }
    }

    /**
     * Check if a table exists.
     * @param {string} table
     * @returns {Promise<boolean>}
     */
    async hasTable(table)
    {
        return (await this._client.exists(this._seqKey(table))) === 1 ||
               (await this._client.exists(this._schemaKey(table))) === 1;
    }

    /**
     * Check if a column exists on a table.
     * @param {string} table
     * @param {string} column
     * @returns {Promise<boolean>}
     */
    async hasColumn(table, column)
    {
        const schema = this._schemas.get(table);
        if (schema) return column in schema;
        // Check first row
        const ids = await this._client.zrange(this._idsKey(table), 0, 0);
        if (ids.length === 0) return false;
        const row = this._deserialize(await this._client.get(this._rowKey(table, ids[0])));
        return row ? column in row : false;
    }

    /**
     * Describe a table's columns.
     * @param {string} table
     * @returns {Promise<Array>}
     */
    async describeTable(table)
    {
        const schema = this._schemas.get(table);
        if (!schema) return [];
        return Object.entries(schema).map(([name, def]) => ({
            name,
            type: def.type || 'TEXT',
            nullable: !def.required,
            defaultValue: def.default !== undefined ? def.default : null,
            primaryKey: !!def.primaryKey,
        }));
    }

    /**
     * Get indexes for a table.
     * @param {string} table
     * @returns {Promise<Array>}
     */
    async indexes(table)
    {
        return this._indexes.get(table) || [];
    }

    // -- Internal Helpers ---------------------------------

    /**
     * Get all rows for a table.
     * @private
     * @param {string} table
     * @returns {Promise<object[]>}
     */
    async _getAllRows(table)
    {
        const ids = await this._client.zrange(this._idsKey(table), 0, -1);
        if (ids.length === 0) return [];

        const pipeline = this._client.pipeline();
        for (const id of ids)
        {
            pipeline.get(this._rowKey(table, id));
        }
        const results = await pipeline.exec();
        const rows = [];
        for (const [err, val] of results)
        {
            if (!err && val)
            {
                const row = this._deserialize(val);
                if (row) rows.push(row);
            }
        }
        return rows;
    }

    /** @private Match simple conditions. */
    _matchConditions(row, conditions)
    {
        if (!conditions || typeof conditions !== 'object') return true;
        for (const [k, v] of Object.entries(conditions))
        {
            if (row[k] !== v) return false;
        }
        return true;
    }

    /** @private Apply the where chain from query builder. */
    _applyWhereChain(row, where)
    {
        let result = true;
        for (let i = 0; i < where.length; i++)
        {
            const clause = where[i];
            if (clause.raw) continue;
            const matches = this._matchClause(row, clause);

            if (i === 0 || clause.logic === 'AND')
            {
                result = i === 0 ? matches : (result && matches);
            }
            else if (clause.logic === 'OR')
            {
                result = result || matches;
            }
        }
        return result;
    }

    /** @private Match a single WHERE clause. */
    _matchClause(row, clause)
    {
        const val = row[clause.field];
        const { op, value } = clause;

        switch (op)
        {
            case '=':           return val === value;
            case '!=':
            case '<>':          return val !== value;
            case '>':           return val > value;
            case '<':           return val < value;
            case '>=':          return val >= value;
            case '<=':          return val <= value;
            case 'LIKE':        return _likeSafe(String(val), String(value));
            case 'IN':          return Array.isArray(value) && value.includes(val);
            case 'NOT IN':      return Array.isArray(value) && !value.includes(val);
            case 'BETWEEN':     return Array.isArray(value) && val >= value[0] && val <= value[1];
            case 'NOT BETWEEN': return Array.isArray(value) && (val < value[0] || val > value[1]);
            case 'IS NULL':     return val === null || val === undefined;
            case 'IS NOT NULL':  return val !== null && val !== undefined;
            default:            return val === value;
        }
    }

    /** @private Compare for HAVING. */
    _compareOp(actual, op, value)
    {
        switch (op.toUpperCase())
        {
            case '=':  return actual === value;
            case '!=':
            case '<>': return actual !== value;
            case '>':  return actual > value;
            case '<':  return actual < value;
            case '>=': return actual >= value;
            case '<=': return actual <= value;
            default:   return actual === value;
        }
    }

    /** @private Enforce unique constraints. */
    async _enforceUnique(table, row, excludeRow)
    {
        const schema = this._schemas.get(table);
        if (!schema) return;

        const rows = await this._getAllRows(table);

        for (const [col, def] of Object.entries(schema))
        {
            if (def.unique && row[col] !== undefined && row[col] !== null)
            {
                const duplicate = rows.find(r =>
                    r !== excludeRow && r.id !== (excludeRow && excludeRow.id) && r[col] === row[col]
                );
                if (duplicate)
                {
                    throw new Error(`UNIQUE constraint failed: ${table}.${col}`);
                }
            }
        }

        // Composite unique
        const groups = {};
        for (const [col, def] of Object.entries(schema))
        {
            if (def.compositeUnique)
            {
                const g = typeof def.compositeUnique === 'string' ? def.compositeUnique : 'default';
                if (!groups[g]) groups[g] = [];
                groups[g].push(col);
            }
        }
        for (const cols of Object.values(groups))
        {
            const duplicate = rows.find(r =>
                r !== excludeRow && r.id !== (excludeRow && excludeRow.id) && cols.every(c => r[c] === row[c])
            );
            if (duplicate)
            {
                throw new Error(`UNIQUE constraint failed: ${table}.(${cols.join(', ')})`);
            }
        }
    }
}

module.exports = RedisAdapter;
