/** redis.test.js — Redis adapter tests (memory mock) */
const path = require('path');
const { Database, Model, TYPES } = require('../../../lib/orm');

// -- Mock ioredis for testing without a live Redis server --

class MockRedis
{
    constructor()
    {
        this._data = new Map();
        this._zsets = new Map();
        this._listeners = [];
        this.status = 'ready';
    }

    async get(key) { return this._data.get(key) ?? null; }

    async set(key, value) { this._data.set(key, String(value)); return 'OK'; }

    async setex(key, ttl, value) { this._data.set(key, String(value)); return 'OK'; }

    async del(...keys)
    {
        let count = 0;
        for (const k of keys)
        {
            if (this._data.has(k) || this._zsets.has(k)) count++;
            this._data.delete(k);
            this._zsets.delete(k);
        }
        return count;
    }

    async exists(key)
    {
        return (this._data.has(key) || this._zsets.has(key)) ? 1 : 0;
    }

    async incr(key)
    {
        const val = parseInt(this._data.get(key) || '0', 10) + 1;
        this._data.set(key, String(val));
        return val;
    }

    async incrby(key, by)
    {
        const val = parseInt(this._data.get(key) || '0', 10) + by;
        this._data.set(key, String(val));
        return val;
    }

    async decr(key)
    {
        const val = parseInt(this._data.get(key) || '0', 10) - 1;
        this._data.set(key, String(val));
        return val;
    }

    async decrby(key, by)
    {
        const val = parseInt(this._data.get(key) || '0', 10) - by;
        this._data.set(key, String(val));
        return val;
    }

    async expire() { return 1; }

    async ttl(key) { return this._data.has(key) ? -1 : -2; }

    async ping() { return 'PONG'; }

    async info() { return 'redis_version:7.0.0\r\n'; }

    async dbsize() { return this._data.size; }

    async zadd(key, score, member)
    {
        if (!this._zsets.has(key)) this._zsets.set(key, []);
        const set = this._zsets.get(key);
        const idx = set.findIndex(e => e.member === String(member));
        if (idx !== -1) set[idx].score = score;
        else set.push({ score, member: String(member) });
        set.sort((a, b) => a.score - b.score);
        return idx === -1 ? 1 : 0;
    }

    async zrange(key, start, stop)
    {
        const set = this._zsets.get(key) || [];
        const end = stop === -1 ? set.length : stop + 1;
        return set.slice(start, end).map(e => e.member);
    }

    async zrangebyscore(key, min, max)
    {
        const set = this._zsets.get(key) || [];
        return set.filter(e => e.score >= min && e.score <= max).map(e => e.member);
    }

    async zrem(key, member)
    {
        const set = this._zsets.get(key) || [];
        const idx = set.findIndex(e => e.member === String(member));
        if (idx !== -1) { set.splice(idx, 1); return 1; }
        return 0;
    }

    async zcard(key) { return (this._zsets.get(key) || []).length; }

    // Hash operations
    async hset(key, field, value)
    {
        if (!this._data.has(key)) this._data.set(key, {});
        const h = this._data.get(key);
        if (typeof h === 'object' && h !== null) { h[field] = String(value); return 1; }
        return 0;
    }

    async hget(key, field)
    {
        const h = this._data.get(key);
        if (typeof h === 'object' && h !== null) return h[field] ?? null;
        return null;
    }

    async hgetall(key)
    {
        const h = this._data.get(key);
        return (typeof h === 'object' && h !== null) ? { ...h } : {};
    }

    async hdel(key, field)
    {
        const h = this._data.get(key);
        if (typeof h === 'object' && h !== null && field in h) { delete h[field]; return 1; }
        return 0;
    }

    // List operations
    async rpush(key, ...values)
    {
        if (!this._data.has(key)) this._data.set(key, []);
        const list = this._data.get(key);
        list.push(...values);
        return list.length;
    }

    async lpush(key, ...values)
    {
        if (!this._data.has(key)) this._data.set(key, []);
        const list = this._data.get(key);
        list.unshift(...values);
        return list.length;
    }

    async lrange(key, start, stop)
    {
        const list = this._data.get(key) || [];
        const end = stop === -1 ? list.length : stop + 1;
        return list.slice(start, end);
    }

    async rpop(key)
    {
        const list = this._data.get(key);
        return (Array.isArray(list) && list.length > 0) ? list.pop() : null;
    }

    async lpop(key)
    {
        const list = this._data.get(key);
        return (Array.isArray(list) && list.length > 0) ? list.shift() : null;
    }

    async llen(key) { const l = this._data.get(key); return Array.isArray(l) ? l.length : 0; }

    // Set operations
    async sadd(key, ...members)
    {
        if (!this._data.has(key)) this._data.set(key, new Set());
        const s = this._data.get(key);
        let count = 0;
        for (const m of members) { if (!s.has(m)) { s.add(m); count++; } }
        return count;
    }

    async smembers(key)
    {
        const s = this._data.get(key);
        return s instanceof Set ? [...s] : [];
    }

    async sismember(key, member)
    {
        const s = this._data.get(key);
        return (s instanceof Set && s.has(String(member))) ? 1 : 0;
    }

    async srem(key, member)
    {
        const s = this._data.get(key);
        if (s instanceof Set && s.has(String(member))) { s.delete(String(member)); return 1; }
        return 0;
    }

    async scard(key)
    {
        const s = this._data.get(key);
        return s instanceof Set ? s.size : 0;
    }

    // Pub/Sub
    async subscribe() { return 1; }
    async unsubscribe() { return 1; }
    on(event, fn) { this._listeners.push({ event, fn }); }
    removeListener(event, fn) { this._listeners = this._listeners.filter(l => !(l.event === event && l.fn === fn)); }
    async publish(channel, message) { return 0; }

    // SCAN
    async scan(cursor, ...args)
    {
        const matchIdx = args.indexOf('MATCH');
        const pattern = matchIdx !== -1 ? args[matchIdx + 1] : '*';
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        const allKeys = [...this._data.keys(), ...this._zsets.keys()];
        const matched = allKeys.filter(k => regex.test(k));
        return ['0', matched];
    }

    // Pipeline
    pipeline()
    {
        const mock = this;
        const ops = [];
        const p = new Proxy({}, {
            get(target, prop)
            {
                if (prop === 'exec')
                {
                    return async () =>
                    {
                        const results = [];
                        for (const { method, args } of ops)
                        {
                            try { results.push([null, await mock[method](...args)]); }
                            catch (e) { results.push([e, null]); }
                        }
                        return results;
                    };
                }
                return (...args) => { ops.push({ method: prop, args }); return p; };
            }
        });
        return p;
    }

    // Multi (transaction)
    multi()
    {
        const mock = this;
        const ops = [];
        return new Proxy({}, {
            get(target, prop)
            {
                if (prop === 'exec') return async () => { for (const { m, a } of ops) await mock[m](...a); };
                if (prop === 'discard') return () => { ops.length = 0; };
                return (...args) => { ops.push({ m: prop, a: args }); return target; };
            }
        });
    }

    duplicate() { return new MockRedis(); }

    async call(command, ...args) { if (this[command]) return this[command](...args); return null; }

    async quit() { this.status = 'end'; }
}

// -- Monkey-patch the Redis adapter to use mock --

let RedisAdapter;
function createMockAdapter(options = {})
{
    // Load the adapter module
    RedisAdapter = require('../../../lib/orm/adapters/redis');

    // Create adapter with mocked ioredis
    const adapter = Object.create(RedisAdapter.prototype);
    adapter._prefix = options.prefix || 'test:';
    adapter._schemas = new Map();
    adapter._indexes = new Map();
    adapter._subscribers = new Map();
    adapter._client = new MockRedis();
    adapter._subClient = null;
    return adapter;
}

// -- Test Models --

class User extends Model
{
    static table = 'users';
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING,  required: true },
        email: { type: TYPES.STRING,  required: true, unique: true },
        age:   { type: TYPES.INTEGER },
        role:  { type: TYPES.STRING,  enum: ['user', 'admin'], default: 'user' },
    };
    static timestamps = true;
}

class Post extends Model
{
    static table = 'posts';
    static schema = {
        id:     { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        title:  { type: TYPES.STRING,  required: true },
        body:   { type: TYPES.TEXT },
        userId: { type: TYPES.INTEGER, required: true },
    };
}

// -- Tests --

describe('Redis Adapter', () =>
{
    let adapter;

    beforeEach(async () =>
    {
        adapter = createMockAdapter({ prefix: 'test:' });
    });

    afterEach(async () =>
    {
        try { await adapter.close(); } catch (_) { }
    });

    // -- Table Management --

    describe('Table Management', () =>
    {
        it('should create and drop a table', async () =>
        {
            await adapter.createTable('users', User.schema);
            expect(await adapter.hasTable('users')).toBe(true);

            await adapter.dropTable('users');
            expect(await adapter.hasTable('users')).toBe(false);
        });

        it('should track schemas', async () =>
        {
            await adapter.createTable('users', User.schema);
            const desc = await adapter.describeTable('users');
            expect(desc.length).toBeGreaterThan(0);
            expect(desc.find(c => c.name === 'name')).toBeDefined();
        });

        it('should list tables', async () =>
        {
            await adapter.createTable('users', User.schema);
            await adapter.createTable('posts', Post.schema);
            const tables = await adapter.tables();
            expect(tables).toContain('users');
            expect(tables).toContain('posts');
        });
    });

    // -- CRUD Operations --

    describe('CRUD Operations', () =>
    {
        beforeEach(async () =>
        {
            await adapter.createTable('users', User.schema);
        });

        it('should insert a row with auto-increment', async () =>
        {
            const row = await adapter.insert('users', { name: 'Alice', email: 'alice@test.com' });
            expect(row.id).toBe(1);
            expect(row.name).toBe('Alice');
            expect(row.email).toBe('alice@test.com');
        });

        it('should insert multiple rows', async () =>
        {
            const rows = await adapter.insertMany('users', [
                { name: 'Alice', email: 'alice@test.com' },
                { name: 'Bob', email: 'bob@test.com' },
            ]);
            expect(rows).toHaveLength(2);
            expect(rows[0].id).toBe(1);
            expect(rows[1].id).toBe(2);
        });

        it('should update a row by primary key', async () =>
        {
            await adapter.insert('users', { name: 'Alice', email: 'alice@test.com' });
            await adapter.update('users', 'id', 1, { name: 'Alice Updated' });

            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [{ field: 'id', op: '=', value: 1, logic: 'AND' }]
            });
            expect(rows[0].name).toBe('Alice Updated');
        });

        it('should update rows by conditions', async () =>
        {
            await adapter.insertMany('users', [
                { name: 'Alice', email: 'a@t.com', role: 'user' },
                { name: 'Bob', email: 'b@t.com', role: 'user' },
                { name: 'Admin', email: 'admin@t.com', role: 'admin' },
            ]);
            const count = await adapter.updateWhere('users', { role: 'user' }, { role: 'member' });
            expect(count).toBe(2);
        });

        it('should delete a row by primary key', async () =>
        {
            await adapter.insert('users', { name: 'Alice', email: 'alice@test.com' });
            await adapter.remove('users', 'id', 1);

            const rows = await adapter.execute({
                action: 'select', table: 'users', where: []
            });
            expect(rows).toHaveLength(0);
        });

        it('should delete rows by conditions', async () =>
        {
            await adapter.insertMany('users', [
                { name: 'Alice', email: 'a@t.com', age: 25 },
                { name: 'Bob', email: 'b@t.com', age: 30 },
                { name: 'Charlie', email: 'c@t.com', age: 25 },
            ]);
            const count = await adapter.deleteWhere('users', { age: 25 });
            expect(count).toBe(2);
        });

        it('should serialize Date objects', async () =>
        {
            const now = new Date();
            const row = await adapter.insert('users', { name: 'Alice', email: 'a@t.com', createdAt: now });
            expect(typeof row.createdAt).toBe('string');
            expect(row.createdAt).toBe(now.toISOString());
        });
    });

    // -- Query Execution --

    describe('Query Execution', () =>
    {
        beforeEach(async () =>
        {
            await adapter.createTable('users', User.schema);
            await adapter.insertMany('users', [
                { name: 'Alice', email: 'a@t.com', age: 25, role: 'admin' },
                { name: 'Bob', email: 'b@t.com', age: 30, role: 'user' },
                { name: 'Charlie', email: 'c@t.com', age: 35, role: 'user' },
                { name: 'Diana', email: 'd@t.com', age: 28, role: 'admin' },
            ]);
        });

        it('should select all rows', async () =>
        {
            const rows = await adapter.execute({ action: 'select', table: 'users', where: [] });
            expect(rows).toHaveLength(4);
        });

        it('should filter with WHERE =', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users',
                where: [{ field: 'role', op: '=', value: 'admin', logic: 'AND' }]
            });
            expect(rows).toHaveLength(2);
        });

        it('should filter with WHERE >', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users',
                where: [{ field: 'age', op: '>', value: 28, logic: 'AND' }]
            });
            expect(rows).toHaveLength(2);
        });

        it('should filter with WHERE IN', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users',
                where: [{ field: 'name', op: 'IN', value: ['Alice', 'Bob'], logic: 'AND' }]
            });
            expect(rows).toHaveLength(2);
        });

        it('should filter with WHERE BETWEEN', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users',
                where: [{ field: 'age', op: 'BETWEEN', value: [26, 31], logic: 'AND' }]
            });
            expect(rows).toHaveLength(2);
        });

        it('should filter with WHERE LIKE', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users',
                where: [{ field: 'name', op: 'LIKE', value: '%li%', logic: 'AND' }]
            });
            expect(rows).toHaveLength(2); // Alice, Charlie
        });

        it('should filter with WHERE IS NULL', async () =>
        {
            await adapter.insert('users', { name: 'NoAge', email: 'no@t.com', age: null });
            const rows = await adapter.execute({
                action: 'select', table: 'users',
                where: [{ field: 'age', op: 'IS NULL', logic: 'AND' }]
            });
            expect(rows.length).toBeGreaterThanOrEqual(1);
        });

        it('should handle OR logic', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users',
                where: [
                    { field: 'name', op: '=', value: 'Alice', logic: 'AND' },
                    { field: 'name', op: '=', value: 'Bob', logic: 'OR' },
                ]
            });
            expect(rows).toHaveLength(2);
        });

        it('should count rows', async () =>
        {
            const count = await adapter.execute({ action: 'count', table: 'users', where: [] });
            expect(count).toBe(4);
        });

        it('should order by field ASC', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [],
                orderBy: [{ field: 'age', dir: 'ASC' }]
            });
            expect(rows[0].age).toBe(25);
            expect(rows[3].age).toBe(35);
        });

        it('should order by field DESC', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [],
                orderBy: [{ field: 'age', dir: 'DESC' }]
            });
            expect(rows[0].age).toBe(35);
        });

        it('should limit results', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [],
                limit: 2
            });
            expect(rows).toHaveLength(2);
        });

        it('should offset results', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [],
                orderBy: [{ field: 'id', dir: 'ASC' }],
                offset: 2
            });
            expect(rows).toHaveLength(2);
            expect(rows[0].name).toBe('Charlie');
        });

        it('should select specific fields', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [],
                fields: ['name', 'email']
            });
            expect(rows[0]).toHaveProperty('name');
            expect(rows[0]).toHaveProperty('email');
            expect(rows[0]).not.toHaveProperty('age');
        });

        it('should support DISTINCT', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [],
                fields: ['role'], distinct: true
            });
            expect(rows).toHaveLength(2); // admin, user
        });

        it('should support GROUP BY', async () =>
        {
            const rows = await adapter.execute({
                action: 'select', table: 'users', where: [],
                groupBy: ['role']
            });
            expect(rows).toHaveLength(2);
        });
    });

    // -- Aggregates --

    describe('Aggregates', () =>
    {
        beforeEach(async () =>
        {
            await adapter.createTable('users', User.schema);
            await adapter.insertMany('users', [
                { name: 'Alice', email: 'a@t.com', age: 20 },
                { name: 'Bob', email: 'b@t.com', age: 30 },
                { name: 'Charlie', email: 'c@t.com', age: 40 },
            ]);
        });

        it('should compute SUM', async () =>
        {
            const result = await adapter.aggregate({ table: 'users', where: [], aggregateFn: 'sum', aggregateField: 'age' });
            expect(result).toBe(90);
        });

        it('should compute AVG', async () =>
        {
            const result = await adapter.aggregate({ table: 'users', where: [], aggregateFn: 'avg', aggregateField: 'age' });
            expect(result).toBe(30);
        });

        it('should compute MIN', async () =>
        {
            const result = await adapter.aggregate({ table: 'users', where: [], aggregateFn: 'min', aggregateField: 'age' });
            expect(result).toBe(20);
        });

        it('should compute MAX', async () =>
        {
            const result = await adapter.aggregate({ table: 'users', where: [], aggregateFn: 'max', aggregateField: 'age' });
            expect(result).toBe(40);
        });

        it('should compute COUNT', async () =>
        {
            const result = await adapter.aggregate({ table: 'users', where: [], aggregateFn: 'count', aggregateField: 'id' });
            expect(result).toBe(3);
        });

        it('should return 0 for empty table aggregates', async () =>
        {
            await adapter.createTable('empty', {});
            const result = await adapter.aggregate({ table: 'empty', where: [], aggregateFn: 'sum', aggregateField: 'x' });
            expect(result).toBe(0);
        });

        it('should return null for MIN/MAX on empty', async () =>
        {
            await adapter.createTable('empty', {});
            expect(await adapter.aggregate({ table: 'empty', where: [], aggregateFn: 'min', aggregateField: 'x' })).toBeNull();
            expect(await adapter.aggregate({ table: 'empty', where: [], aggregateFn: 'max', aggregateField: 'x' })).toBeNull();
        });
    });

    // -- Unique Constraints --

    describe('Unique Constraints', () =>
    {
        beforeEach(async () =>
        {
            await adapter.createTable('users', User.schema);
        });

        it('should enforce unique constraint', async () =>
        {
            await adapter.insert('users', { name: 'Alice', email: 'alice@test.com' });
            await expect(
                adapter.insert('users', { name: 'Bob', email: 'alice@test.com' })
            ).rejects.toThrow(/UNIQUE constraint/);
        });
    });

    // -- DDL / Migration Methods --

    describe('DDL Methods', () =>
    {
        beforeEach(async () =>
        {
            await adapter.createTable('users', { ...User.schema });
            await adapter.insert('users', { name: 'Alice', email: 'a@t.com', age: 25 });
        });

        it('should add a column with default value', async () =>
        {
            await adapter.addColumn('users', 'status', { type: 'string', default: 'active' });
            const rows = await adapter.execute({ action: 'select', table: 'users', where: [] });
            expect(rows[0].status).toBe('active');
        });

        it('should drop a column', async () =>
        {
            await adapter.dropColumn('users', 'age');
            const rows = await adapter.execute({ action: 'select', table: 'users', where: [] });
            expect(rows[0]).not.toHaveProperty('age');
        });

        it('should rename a column', async () =>
        {
            await adapter.renameColumn('users', 'age', 'years');
            const rows = await adapter.execute({ action: 'select', table: 'users', where: [] });
            expect(rows[0]).toHaveProperty('years');
            expect(rows[0]).not.toHaveProperty('age');
        });

        it('should rename a table', async () =>
        {
            await adapter.renameTable('users', 'accounts');
            expect(await adapter.hasTable('accounts')).toBe(true);
            const rows = await adapter.execute({ action: 'select', table: 'accounts', where: [] });
            expect(rows[0].name).toBe('Alice');
        });

        it('should check if a column exists', async () =>
        {
            expect(await adapter.hasColumn('users', 'name')).toBe(true);
            expect(await adapter.hasColumn('users', 'nonexistent')).toBe(false);
        });

        it('should create and drop indexes', async () =>
        {
            await adapter.createIndex('users', ['email'], { unique: true });
            const indexes = await adapter.indexes('users');
            expect(indexes).toHaveLength(1);
            expect(indexes[0].unique).toBe(true);

            await adapter.dropIndex('users', indexes[0].name);
            const after = await adapter.indexes('users');
            expect(after).toHaveLength(0);
        });
    });

    // -- Key-Value Operations --

    describe('Key-Value Operations', () =>
    {
        it('should get/set string values', async () =>
        {
            await adapter.set('greeting', 'hello');
            expect(await adapter.get('greeting')).toBe('hello');
        });

        it('should get/set with TTL', async () =>
        {
            await adapter.set('temp', 'value', 60);
            expect(await adapter.get('temp')).toBe('value');
        });

        it('should serialize objects', async () =>
        {
            await adapter.set('obj', { key: 'val' });
            const val = await adapter.get('obj');
            expect(val).toBe('{"key":"val"}');
        });

        it('should delete keys', async () =>
        {
            await adapter.set('key', 'val');
            expect(await adapter.del('key')).toBe(1);
            expect(await adapter.get('key')).toBeNull();
        });

        it('should check key existence', async () =>
        {
            expect(await adapter.exists('missing')).toBe(false);
            await adapter.set('present', '1');
            expect(await adapter.exists('present')).toBe(true);
        });

        it('should increment and decrement', async () =>
        {
            expect(await adapter.incr('counter')).toBe(1);
            expect(await adapter.incr('counter')).toBe(2);
            expect(await adapter.incr('counter', 5)).toBe(7);
            expect(await adapter.decr('counter')).toBe(6);
            expect(await adapter.decr('counter', 3)).toBe(3);
        });

        it('should get TTL', async () =>
        {
            await adapter.set('key', 'val');
            const t = await adapter.ttl('key');
            expect(t).toBe(-1); // no expiry
            expect(await adapter.ttl('missing')).toBe(-2);
        });
    });

    // -- Hash Operations --

    describe('Hash Operations', () =>
    {
        it('should set and get hash fields', async () =>
        {
            await adapter.hset('user:1', 'name', 'Alice');
            expect(await adapter.hget('user:1', 'name')).toBe('Alice');
        });

        it('should get all hash fields', async () =>
        {
            await adapter.hset('user:1', 'name', 'Alice');
            await adapter.hset('user:1', 'age', '30');
            const all = await adapter.hgetall('user:1');
            expect(all.name).toBe('Alice');
            expect(all.age).toBe('30');
        });

        it('should delete a hash field', async () =>
        {
            await adapter.hset('user:1', 'name', 'Alice');
            await adapter.hdel('user:1', 'name');
            expect(await adapter.hget('user:1', 'name')).toBeNull();
        });
    });

    // -- List Operations --

    describe('List Operations', () =>
    {
        it('should push and range list items', async () =>
        {
            await adapter.rpush('queue', 'a', 'b', 'c');
            const items = await adapter.lrange('queue');
            expect(items).toEqual(['a', 'b', 'c']);
        });

        it('should lpush to front', async () =>
        {
            await adapter.rpush('queue', 'b');
            await adapter.lpush('queue', 'a');
            expect(await adapter.lrange('queue')).toEqual(['a', 'b']);
        });

        it('should pop from both ends', async () =>
        {
            await adapter.rpush('queue', 'a', 'b', 'c');
            expect(await adapter.rpop('queue')).toBe('c');
            expect(await adapter.lpop('queue')).toBe('a');
        });

        it('should get list length', async () =>
        {
            await adapter.rpush('queue', 'a', 'b');
            expect(await adapter.llen('queue')).toBe(2);
        });
    });

    // -- Set Operations --

    describe('Set Operations', () =>
    {
        it('should add and get set members', async () =>
        {
            await adapter.sadd('tags', 'js', 'node', 'redis');
            const members = await adapter.smembers('tags');
            expect(members).toContain('js');
            expect(members).toContain('node');
            expect(members).toContain('redis');
        });

        it('should check membership', async () =>
        {
            await adapter.sadd('tags', 'js');
            expect(await adapter.sismember('tags', 'js')).toBe(true);
            expect(await adapter.sismember('tags', 'python')).toBe(false);
        });

        it('should remove members', async () =>
        {
            await adapter.sadd('tags', 'js', 'node');
            await adapter.srem('tags', 'js');
            expect(await adapter.sismember('tags', 'js')).toBe(false);
        });

        it('should get cardinality', async () =>
        {
            await adapter.sadd('tags', 'a', 'b', 'c');
            expect(await adapter.scard('tags')).toBe(3);
        });
    });

    // -- Sorted Set Operations --

    describe('Sorted Set Operations', () =>
    {
        it('should add and range by rank', async () =>
        {
            await adapter.zadd('scores', 100, 'alice');
            await adapter.zadd('scores', 200, 'bob');
            await adapter.zadd('scores', 50, 'charlie');
            const members = await adapter.zrange('scores', 0, -1);
            expect(members[0]).toBe('charlie');
            expect(members[2]).toBe('bob');
        });

        it('should range by score', async () =>
        {
            await adapter.zadd('scores', 10, 'a');
            await adapter.zadd('scores', 20, 'b');
            await adapter.zadd('scores', 30, 'c');
            const result = await adapter.zrangebyscore('scores', 15, 35);
            expect(result).toEqual(['b', 'c']);
        });

        it('should remove members', async () =>
        {
            await adapter.zadd('scores', 10, 'a');
            await adapter.zrem('scores', 'a');
            expect(await adapter.zcard('scores')).toBe(0);
        });
    });

    // -- Pipeline --

    describe('Pipeline', () =>
    {
        it('should batch operations', async () =>
        {
            const pipe = adapter.pipeline();
            pipe.set('k1', 'v1');
            pipe.set('k2', 'v2');
            pipe.get('k1');
            const results = await pipe.exec();
            expect(results).toHaveLength(3);
        });
    });

    // -- Transactions --

    describe('Transactions', () =>
    {
        it('should support begin/commit', async () =>
        {
            await adapter.beginTransaction();
            await adapter.commit();
        });

        it('should support begin/rollback', async () =>
        {
            await adapter.beginTransaction();
            await adapter.rollback();
        });
    });

    // -- Utility Methods --

    describe('Utility Methods', () =>
    {
        it('should ping successfully', async () =>
        {
            expect(await adapter.ping()).toBe(true);
        });

        it('should get info', async () =>
        {
            const info = await adapter.info();
            expect(info).toContain('redis_version');
        });

        it('should get dbsize', async () =>
        {
            const size = await adapter.dbsize();
            expect(typeof size).toBe('number');
        });

        it('should get stats', async () =>
        {
            await adapter.createTable('t1', {});
            const stats = await adapter.stats();
            expect(stats).toHaveProperty('tables');
            expect(stats).toHaveProperty('totalRows');
            expect(stats).toHaveProperty('prefix', 'test:');
        });

        it('should get pool status', () =>
        {
            const status = adapter.poolStatus();
            expect(status).toHaveProperty('status', 'ready');
        });

        it('should execute raw commands', async () =>
        {
            await adapter.set('raw-test', 'val');
            const result = await adapter.raw('get', 'test:raw-test');
            expect(result).toBe('val');
        });

        it('should clear all prefixed keys', async () =>
        {
            await adapter.set('k1', 'v1');
            await adapter.set('k2', 'v2');
            await adapter.clear();
            expect(await adapter.get('k1')).toBeNull();
        });
    });

    // -- Model Integration --

    describe('Model Integration via ORM', () =>
    {
        let db;

        beforeEach(async () =>
        {
            // Create a Database with mock adapter
            db = new Database(createMockAdapter({ prefix: 'model:' }));
            db.register(User);
            await db.sync();
        });

        afterEach(async () =>
        {
            await db.close();
        });

        it('should create and find records', async () =>
        {
            const user = await User.create({ name: 'Alice', email: 'alice@test.com', age: 25 });
            expect(user.id).toBe(1);
            expect(user.name).toBe('Alice');

            const found = await User.findById(1);
            expect(found.name).toBe('Alice');
        });

        it('should find records with conditions', async () =>
        {
            await User.create({ name: 'Alice', email: 'a@t.com', role: 'admin', age: 25 });
            await User.create({ name: 'Bob', email: 'b@t.com', role: 'user', age: 30 });

            const admins = await User.find({ role: 'admin' });
            expect(admins).toHaveLength(1);
            expect(admins[0].name).toBe('Alice');
        });

        it('should update records', async () =>
        {
            const user = await User.create({ name: 'Alice', email: 'a@t.com', age: 25 });
            await user.update({ name: 'Alice Updated' });

            const found = await User.findById(user.id);
            expect(found.name).toBe('Alice Updated');
        });

        it('should delete records', async () =>
        {
            const user = await User.create({ name: 'Alice', email: 'a@t.com', age: 25 });
            await user.delete();

            const count = await User.count();
            expect(count).toBe(0);
        });

        it('should count records', async () =>
        {
            await User.create({ name: 'A', email: 'a@t.com' });
            await User.create({ name: 'B', email: 'b@t.com' });
            expect(await User.count()).toBe(2);
        });

        it('should use query builder', async () =>
        {
            await User.create({ name: 'Alice', email: 'a@t.com', age: 25 });
            await User.create({ name: 'Bob', email: 'b@t.com', age: 35 });
            await User.create({ name: 'Charlie', email: 'c@t.com', age: 30 });

            const results = await User.query()
                .where('age', '>', 24)
                .orderBy('age', 'asc')
                .limit(2)
                .exec();
            expect(results).toHaveLength(2);
            expect(results[0].name).toBe('Alice');
        });
    });
});

// =========================================================================
//  Redis adapter — coverage boost (from coverage/boost.test.js)
// =========================================================================

describe('Redis adapter — coverage boost', () =>
{
	let adapter;

	beforeEach(() => { adapter = createMockAdapter({ prefix: 'cb:' }); });
	afterEach(async () => { try { await adapter.close(); } catch (_) {} });

	// -- Validation errors --

	describe('input validation', () =>
	{
		it('_validateKey rejects empty strings', () =>
		{
			expect(() => adapter._validateKey('')).toThrow('non-empty string');
		});

		it('_validateKey rejects control characters', () =>
		{
			expect(() => adapter._validateKey('bad\x01key')).toThrow('control characters');
		});

		it('set rejects negative TTL', async () =>
		{
			await expect(adapter.set('x', 'v', -1)).rejects.toThrow('non-negative');
		});

		it('set rejects Infinity TTL', async () =>
		{
			await expect(adapter.set('x', 'v', Infinity)).rejects.toThrow('non-negative');
		});

		it('expire rejects negative seconds', async () =>
		{
			await expect(adapter.expire('x', -5)).rejects.toThrow('non-negative');
		});

		it('subscribe rejects non-function callback', async () =>
		{
			await expect(adapter.subscribe('ch', 'not-a-fn')).rejects.toThrow('function');
		});

		it('raw rejects empty command', async () =>
		{
			await expect(adapter.raw('')).rejects.toThrow('non-empty string');
		});

		it('raw rejects non-string command', async () =>
		{
			await expect(adapter.raw(42)).rejects.toThrow('non-empty string');
		});
	});

	// -- WHERE clause operators --

	describe('WHERE operators coverage', () =>
	{
		beforeEach(async () =>
		{
			await adapter.createTable('items', {});
			await adapter.insertMany('items', [
				{ name: 'alpha', score: 10, tag: null },
				{ name: 'beta', score: 20, tag: 'hot' },
				{ name: 'gamma', score: 30, tag: 'cold' },
			]);
		});

		it('!= / <> operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'name', op: '!=', value: 'alpha', logic: 'AND' }]
			});
			expect(rows.length).toBe(2);

			const rows2 = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'name', op: '<>', value: 'alpha', logic: 'AND' }]
			});
			expect(rows2.length).toBe(2);
		});

		it('< operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'score', op: '<', value: 20, logic: 'AND' }]
			});
			expect(rows.length).toBe(1);
		});

		it('>= operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'score', op: '>=', value: 20, logic: 'AND' }]
			});
			expect(rows.length).toBe(2);
		});

		it('<= operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'score', op: '<=', value: 20, logic: 'AND' }]
			});
			expect(rows.length).toBe(2);
		});

		it('NOT IN operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'name', op: 'NOT IN', value: ['alpha', 'gamma'], logic: 'AND' }]
			});
			expect(rows.length).toBe(1);
			expect(rows[0].name).toBe('beta');
		});

		it('NOT BETWEEN operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'score', op: 'NOT BETWEEN', value: [15, 25], logic: 'AND' }]
			});
			expect(rows.length).toBe(2);
		});

		it('IS NULL operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'tag', op: 'IS NULL', logic: 'AND' }]
			});
			expect(rows.length).toBe(1);
			expect(rows[0].name).toBe('alpha');
		});

		it('IS NOT NULL operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ field: 'tag', op: 'IS NOT NULL', logic: 'AND' }]
			});
			expect(rows.length).toBe(2);
		});

		it('raw clause is skipped', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'items',
				where: [{ raw: true, sql: '1=1' }]
			});
			expect(rows.length).toBe(3);
		});
	});

	// -- GROUP BY with HAVING --

	describe('GROUP BY with HAVING', () =>
	{
		beforeEach(async () =>
		{
			await adapter.createTable('orders', {});
			await adapter.insertMany('orders', [
				{ category: 'A', amount: 10 },
				{ category: 'A', amount: 20 },
				{ category: 'B', amount: 5 },
				{ category: 'A', amount: 15 },
				{ category: 'B', amount: 8 },
			]);
		});

		it('HAVING with COUNT(*) filters groups', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'orders', where: [],
				groupBy: ['category'],
				having: [{ field: 'COUNT(*)', op: '>', value: 2 }]
			});
			expect(rows.length).toBe(1);
			expect(rows[0].category).toBe('A');
		});

		it('HAVING with != operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'orders', where: [],
				groupBy: ['category'],
				having: [{ field: 'COUNT(*)', op: '!=', value: 3 }]
			});
			expect(rows.length).toBe(1);
			expect(rows[0].category).toBe('B');
		});

		it('HAVING with < operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'orders', where: [],
				groupBy: ['category'],
				having: [{ field: 'COUNT(*)', op: '<', value: 3 }]
			});
			expect(rows.length).toBe(1);
		});

		it('HAVING with >= operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'orders', where: [],
				groupBy: ['category'],
				having: [{ field: 'COUNT(*)', op: '>=', value: 2 }]
			});
			expect(rows.length).toBe(2);
		});

		it('HAVING with <= operator', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'orders', where: [],
				groupBy: ['category'],
				having: [{ field: 'COUNT(*)', op: '<=', value: 2 }]
			});
			expect(rows.length).toBe(1);
		});

		it('HAVING with <> (alias for !=)', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'orders', where: [],
				groupBy: ['category'],
				having: [{ field: 'COUNT(*)', op: '<>', value: 2 }]
			});
			expect(rows.length).toBe(1);
		});

		it('HAVING with non-count field', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'orders', where: [],
				groupBy: ['category'],
				having: [{ field: 'category', op: '=', value: 'A' }]
			});
			expect(rows.length).toBe(1);
		});
	});

	// -- Pub/Sub --

	describe('Pub/Sub full coverage', () =>
	{
		it('subscribe and receive messages, then unsubscribe', async () =>
		{
			const messages = [];
			const unsub = await adapter.subscribe('events', (msg, ch) =>
			{
				messages.push({ msg, ch });
			});

			// Trigger the message by emitting to the sub client's listeners array
			const subClient = adapter._subClient;
			const prefixedChannel = adapter._prefix + 'events';
			// The sub client listeners are stored in _listeners
			const msgListeners = subClient._listeners.filter(l => l.event === 'message');
			msgListeners.forEach(l => l.fn(prefixedChannel, 'hello'));

			expect(messages.length).toBe(1);
			expect(messages[0].msg).toBe('hello');
			expect(messages[0].ch).toBe('events');

			await unsub();
		});

		it('unsubscribe removes from subscriber list', async () =>
		{
			const unsub1 = await adapter.subscribe('ch1', () => {});
			const unsub2 = await adapter.subscribe('ch1', () => {});

			// Two subscribers on same channel
			expect(adapter._subscribers.get(adapter._prefix + 'ch1').length).toBe(2);

			await unsub1();
			expect(adapter._subscribers.get(adapter._prefix + 'ch1').length).toBe(1);

			await unsub2();
			// Should clean up fully
			expect(adapter._subscribers.has(adapter._prefix + 'ch1')).toBe(false);
		});

		it('publish serializes objects', async () =>
		{
			// publish returns 0 in the mock (no actual pub/sub forwarding)
			const count = await adapter.publish('data', { key: 'val' });
			expect(typeof count).toBe('number');
		});
	});

	// -- Pipeline extended operations --

	describe('Pipeline extended ops', () =>
	{
		it('pipeline del, hset, hget, incr, decr, expire, sadd, rpush', async () =>
		{
			await adapter.set('k', 'v');
			const pipe = adapter.pipeline();
			pipe.del('k');
			pipe.hset('h', 'f', 'v');
			pipe.hget('h', 'f');
			pipe.incr('ctr');
			pipe.decr('ctr');
			pipe.expire('h', 60);
			pipe.sadd('s', 'a', 'b');
			pipe.rpush('l', 'x', 'y');
			const results = await pipe.exec();
			expect(results.length).toBe(8);
		});

		it('pipeline set serializes objects', async () =>
		{
			const pipe = adapter.pipeline();
			pipe.set('obj', { a: 1 });
			const results = await pipe.exec();
			expect(results.length).toBe(1);
		});
	});

	// -- Deserialization edge cases --

	describe('deserialization edge cases', () =>
	{
		it('_deserialize returns null for null/undefined', () =>
		{
			expect(adapter._deserialize(null)).toBeNull();
			expect(adapter._deserialize(undefined)).toBeNull();
		});

		it('_deserialize returns null for invalid JSON', () =>
		{
			expect(adapter._deserialize('not json {')).toBeNull();
		});
	});

	// -- Manual ID + update non-existent --

	describe('edge cases', () =>
	{
		beforeEach(async () => { await adapter.createTable('items', {}); });

		it('insert with manual ID advances sequence', async () =>
		{
			const row = await adapter.insert('items', { id: 100, name: 'manual' });
			expect(row.id).toBe(100);
			const row2 = await adapter.insert('items', { name: 'auto' });
			expect(row2.id).toBeGreaterThan(100);
		});

		it('update non-existent row does nothing', async () =>
		{
			await adapter.update('items', 'id', 999, { name: 'ghost' });
			const rows = await adapter.execute({ action: 'select', table: 'items', where: [] });
			expect(rows.length).toBe(0);
		});

		it('deleteWhere with no matches returns 0', async () =>
		{
			expect(await adapter.deleteWhere('items', { name: 'none' })).toBe(0);
		});

		it('updateWhere with no matches returns 0', async () =>
		{
			expect(await adapter.updateWhere('items', { name: 'none' }, { name: 'x' })).toBe(0);
		});

		it('hasColumn returns false for empty table without schema', async () =>
		{
			await adapter.createTable('bare', undefined);
			expect(await adapter.hasColumn('bare', 'col')).toBe(false);
		});

		it('describeTable returns empty array when no schema', async () =>
		{
			await adapter.createTable('bare', undefined);
			expect(await adapter.describeTable('bare')).toEqual([]);
		});

		it('_matchConditions returns true for null/non-object conditions', () =>
		{
			expect(adapter._matchConditions({}, null)).toBe(true);
			expect(adapter._matchConditions({}, 'string')).toBe(true);
		});

		it('aggregate with unknown function returns null', async () =>
		{
			await adapter.insert('items', { val: 5 });
			const result = await adapter.aggregate({
				table: 'items', where: [], aggregateFn: 'median', aggregateField: 'val'
			});
			expect(result).toBeNull();
		});

		it('aggregate avg on empty returns 0', async () =>
		{
			const result = await adapter.aggregate({
				table: 'items', where: [], aggregateFn: 'avg', aggregateField: 'val'
			});
			expect(result).toBe(0);
		});

		it('info with section parameter', async () =>
		{
			const info = await adapter.info('memory');
			expect(typeof info).toBe('string');
		});
	});

	// -- DDL edge cases --

	describe('DDL edge cases', () =>
	{
		it('addColumn with function default', async () =>
		{
			await adapter.createTable('items', { name: { type: 'string' } });
			await adapter.insert('items', { name: 'test' });
			await adapter.addColumn('items', 'uuid', { type: 'string', default: () => 'gen-id' });
			const rows = await adapter.execute({ action: 'select', table: 'items', where: [] });
			expect(rows[0].uuid).toBe('gen-id');
		});

		it('renameColumn where column does not exist in schema', async () =>
		{
			await adapter.createTable('items', { name: { type: 'string' } });
			await adapter.insert('items', { name: 'a', extra: 'val' });
			await adapter.renameColumn('items', 'extra', 'bonus');
			const rows = await adapter.execute({ action: 'select', table: 'items', where: [] });
			expect(rows[0].bonus).toBe('val');
			expect(rows[0]).not.toHaveProperty('extra');
		});

		it('renameTable copies schema and rows', async () =>
		{
			await adapter.createTable('old', { name: { type: 'string' } });
			await adapter.insert('old', { name: 'item1' });
			await adapter.renameTable('old', 'new');
			expect(await adapter.hasTable('new')).toBe(true);
			const rows = await adapter.execute({ action: 'select', table: 'new', where: [] });
			expect(rows[0].name).toBe('item1');
		});

		it('dropTable cleans up field indexes from schema', async () =>
		{
			const schema = { name: { type: 'string' }, age: { type: 'integer' } };
			await adapter.createTable('users', schema);
			await adapter.insert('users', { name: 'a', age: 10 });
			await adapter.dropTable('users');
			expect(await adapter.hasTable('users')).toBe(false);
		});

		it('hasColumn falls back to first row when no schema', async () =>
		{
			// Create table without schema, then insert a row
			await adapter.createTable('dyn', undefined);
			await adapter.insert('dyn', { name: 'x', age: 10 });
			expect(await adapter.hasColumn('dyn', 'name')).toBe(true);
			expect(await adapter.hasColumn('dyn', 'missing')).toBe(false);
		});
	});

	// -- _enforceUnique edge --

	describe('unique constraint edge', () =>
	{
		it('allows null values in unique columns', async () =>
		{
			const schema = { name: { type: 'string', unique: true } };
			await adapter.createTable('items', schema);
			await adapter.insert('items', { name: null });
			await adapter.insert('items', { name: null });
			const rows = await adapter.execute({ action: 'select', table: 'items', where: [] });
			expect(rows.length).toBe(2);
		});
	});

	// -- Sorted set operations --

	describe('sorted set ops', () =>
	{
		it('zadd updates existing member score', async () =>
		{
			await adapter.zadd('zs', 10, 'a');
			await adapter.zadd('zs', 50, 'a');
			const members = await adapter.zrange('zs', 0, -1);
			expect(members.length).toBe(1);
		});
	});

	// -- Transactions coverage --

	describe('transactions', () =>
	{
		it('rollback clears queued operations', async () =>
		{
			await adapter.beginTransaction();
			expect(adapter._multi).toBeDefined();
			await adapter.rollback();
			expect(adapter._multi).toBeNull();
		});

		it('commit without beginTransaction is no-op', async () =>
		{
			await adapter.commit(); // should not throw
		});

		it('rollback without beginTransaction is no-op', async () =>
		{
			await adapter.rollback(); // should not throw
		});
	});

	// -- Date serialization in update/updateWhere --

	describe('Date serialization', () =>
	{
		beforeEach(async () => { await adapter.createTable('events', {}); });

		it('update serializes Date to ISO string', async () =>
		{
			const row = await adapter.insert('events', { title: 'launch' });
			const date = new Date('2025-01-15T12:00:00Z');
			await adapter.update('events', 'id', row.id, { date });
			const rows = await adapter.execute({ action: 'select', table: 'events', where: [] });
			expect(rows[0].date).toBe('2025-01-15T12:00:00.000Z');
		});

		it('updateWhere serializes Date to ISO string', async () =>
		{
			await adapter.insert('events', { title: 'launch', date: 'old' });
			const date = new Date('2025-06-01T00:00:00Z');
			await adapter.updateWhere('events', { title: 'launch' }, { date });
			const rows = await adapter.execute({ action: 'select', table: 'events', where: [] });
			expect(rows[0].date).toBe('2025-06-01T00:00:00.000Z');
		});
	});

	// -- Composite unique constraints --

	describe('composite unique constraints', () =>
	{
		it('enforces compositeUnique violation', async () =>
		{
			const schema = {
				firstName: { type: 'string', compositeUnique: 'name' },
				lastName: { type: 'string', compositeUnique: 'name' },
			};
			await adapter.createTable('people', schema);
			await adapter.insert('people', { firstName: 'John', lastName: 'Doe' });
			await expect(
				adapter.insert('people', { firstName: 'John', lastName: 'Doe' })
			).rejects.toThrow('UNIQUE constraint failed');
		});

		it('allows different values for compositeUnique', async () =>
		{
			const schema = {
				firstName: { type: 'string', compositeUnique: 'name' },
				lastName: { type: 'string', compositeUnique: 'name' },
			};
			await adapter.createTable('people', schema);
			await adapter.insert('people', { firstName: 'John', lastName: 'Doe' });
			const row = await adapter.insert('people', { firstName: 'John', lastName: 'Smith' });
			expect(row.firstName).toBe('John');
		});

		it('compositeUnique with boolean truthy value uses default group', async () =>
		{
			const schema = {
				a: { type: 'string', compositeUnique: true },
				b: { type: 'string', compositeUnique: true },
			};
			await adapter.createTable('combos', schema);
			await adapter.insert('combos', { a: 'x', b: 'y' });
			await expect(
				adapter.insert('combos', { a: 'x', b: 'y' })
			).rejects.toThrow('UNIQUE constraint failed');
		});
	});

	// -- Manual ID edge cases --

	describe('manual ID edge cases', () =>
	{
		beforeEach(async () => { await adapter.createTable('items', {}); });

		it('insert with string ID does not advance sequence', async () =>
		{
			const row = await adapter.insert('items', { id: 'custom-id', name: 'test' });
			expect(row.id).toBe('custom-id');
			const row2 = await adapter.insert('items', { name: 'auto' });
			expect(typeof row2.id).toBe('number');
		});

		it('insert with numeric ID less than current sequence does not decrease it', async () =>
		{
			await adapter.insert('items', { id: 100, name: 'high' });
			const row = await adapter.insert('items', { id: 2, name: 'low' });
			expect(row.id).toBe(2);
			const row3 = await adapter.insert('items', { name: 'auto' });
			expect(row3.id).toBeGreaterThan(100);
		});
	});

	// -- LIKE with underscore wildcard --

	describe('LIKE edge cases', () =>
	{
		beforeEach(async () =>
		{
			await adapter.createTable('words', {});
			await adapter.insertMany('words', [
				{ text: 'cat' },
				{ text: 'car' },
				{ text: 'cart' },
				{ text: '' },
			]);
		});

		it('LIKE with _ single-char wildcard', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'words',
				where: [{ field: 'text', op: 'LIKE', value: 'ca_', logic: 'AND' }]
			});
			expect(rows.length).toBe(2); // cat, car
		});

		it('LIKE with % matches empty string', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'words',
				where: [{ field: 'text', op: 'LIKE', value: '%', logic: 'AND' }]
			});
			expect(rows.length).toBe(4);
		});

		it('LIKE with no wildcards is exact match', async () =>
		{
			const rows = await adapter.execute({
				action: 'select', table: 'words',
				where: [{ field: 'text', op: 'LIKE', value: 'cat', logic: 'AND' }]
			});
			expect(rows.length).toBe(1);
		});
	});

	// -- ping failure --

	describe('ping failure', () =>
	{
		it('ping returns false when client throws', async () =>
		{
			adapter._client.ping = async () => { throw new Error('fail'); };
			const result = await adapter.ping();
			expect(result).toBe(false);
		});
	});

	// -- set with TTL=0 --

	describe('set with TTL edge cases', () =>
	{
		it('set with TTL=0 uses plain set', async () =>
		{
			await adapter.set('k', 'v', 0);
			const val = await adapter.get('k');
			expect(val).toBe('v');
		});

		it('set with TTL > 0 uses setex', async () =>
		{
			await adapter.set('k', 'v', 60);
			const val = await adapter.get('k');
			expect(val).toBe('v');
		});
	});

	// -- renameTable without schema --

	describe('renameTable without schema', () =>
	{
		it('renameTable works even without schema', async () =>
		{
			await adapter.createTable('noschema', undefined);
			await adapter.insert('noschema', { x: 1 });
			await adapter.renameTable('noschema', 'renamed');
			expect(await adapter.hasTable('renamed')).toBe(true);
		});
	});

	// -- addColumn on empty table --

	describe('addColumn edge cases', () =>
	{
		it('addColumn on empty table is fine', async () =>
		{
			await adapter.createTable('empty', { name: { type: 'string' } });
			await adapter.addColumn('empty', 'age', { type: 'integer', default: 0 });
			const desc = await adapter.describeTable('empty');
			expect(desc.find(c => c.name === 'age')).toBeDefined();
		});

		it('addColumn doesnt overwrite existing values', async () =>
		{
			await adapter.createTable('items', { name: { type: 'string' } });
			await adapter.insert('items', { name: 'test', extra: 'val' });
			await adapter.addColumn('items', 'extra', { type: 'string', default: 'def' });
			const rows = await adapter.execute({ action: 'select', table: 'items', where: [] });
			expect(rows[0].extra).toBe('val');
		});
	});

	// -- aggregate with WHERE filter --

	describe('aggregate with WHERE filter', () =>
	{
		beforeEach(async () =>
		{
			await adapter.createTable('scores', {});
			await adapter.insertMany('scores', [
				{ team: 'A', pts: 10 },
				{ team: 'A', pts: 20 },
				{ team: 'B', pts: 5 },
			]);
		});

		it('sum with WHERE filter', async () =>
		{
			const result = await adapter.aggregate({
				table: 'scores',
				where: [{ field: 'team', op: '=', value: 'A', logic: 'AND' }],
				aggregateFn: 'sum', aggregateField: 'pts'
			});
			expect(result).toBe(30);
		});

		it('min with WHERE filter', async () =>
		{
			const result = await adapter.aggregate({
				table: 'scores', where: [],
				aggregateFn: 'min', aggregateField: 'pts'
			});
			expect(result).toBe(5);
		});

		it('max with WHERE filter', async () =>
		{
			const result = await adapter.aggregate({
				table: 'scores', where: [],
				aggregateFn: 'max', aggregateField: 'pts'
			});
			expect(result).toBe(20);
		});

		it('count with WHERE filter', async () =>
		{
			const result = await adapter.aggregate({
				table: 'scores',
				where: [{ field: 'team', op: '=', value: 'A', logic: 'AND' }],
				aggregateFn: 'count', aggregateField: 'pts'
			});
			expect(result).toBe(2);
		});
	});

	// -- createIndex as string --

	describe('createIndex edge', () =>
	{
		it('createIndex with string column arg', async () =>
		{
			await adapter.createTable('items', { email: { type: 'string' } });
			await adapter.createIndex('items', 'email', { name: 'idx_email' });
			const indexes = await adapter.indexes('items');
			expect(indexes.some(i => i.name === 'idx_email')).toBe(true);
		});
	});

	// -- pipeline get --

	describe('pipeline get', () =>
	{
		it('pipeline get wraps key with prefix', async () =>
		{
			await adapter.set('pkey', 'pval');
			const pipe = adapter.pipeline();
			pipe.get('pkey');
			const results = await pipe.exec();
			expect(results.length).toBe(1);
		});
	});
});

// =========================================================================
//  Redis adapter — constructor validation (from coverage/boost.test.js)
// =========================================================================

// ===================================================================
//  REDIS CONSTRUCTOR — validation branches (mocked ioredis)
// ===================================================================

describe('Redis adapter — constructor validation', () =>
{
	// We need to inject a mock ioredis into require cache
	const adapterPath = path.resolve(__dirname, '../../../lib/orm/adapters/redis.js');
	// Synthetic ioredis module path
	const ioredisKey = path.resolve(__dirname, '../../../node_modules/ioredis/index.js');

	function makeRedisAdapter(opts)
	{
		// Clear adapter cache so it re-evaluates the try { Redis = require('ioredis') }
		delete require.cache[adapterPath];

		// Intercept require('ioredis') by hooking Module._resolveFilename
		const Module = require('module');
		const origResolve = Module._resolveFilename;
		Module._resolveFilename = function (request, ...args) {
			if (request === 'ioredis') return ioredisKey;
			return origResolve.call(this, request, ...args);
		};

		// Put our mock in the cache at that key
		const originalCache = require.cache[ioredisKey];
		require.cache[ioredisKey] = {
			id: ioredisKey, filename: ioredisKey, loaded: true,
			exports: class FakeRedis { constructor() { this.status = 'ready'; } }
		};

		try
		{
			const RedisAdapter = require(adapterPath);
			return new RedisAdapter(opts);
		}
		finally
		{
			Module._resolveFilename = origResolve;
			if (originalCache) require.cache[ioredisKey] = originalCache;
			else delete require.cache[ioredisKey];
			delete require.cache[adapterPath];
		}
	}

	it('rejects invalid host (empty string)', () =>
	{
		expect(() => makeRedisAdapter({ host: '' })).toThrow('non-empty string');
	});

	it('rejects invalid host (non-string)', () =>
	{
		expect(() => makeRedisAdapter({ host: 123 })).toThrow('non-empty string');
	});

	it('rejects invalid port (float)', () =>
	{
		expect(() => makeRedisAdapter({ port: 3.5 })).toThrow('between 1 and 65535');
	});

	it('rejects invalid port (0)', () =>
	{
		expect(() => makeRedisAdapter({ port: 0 })).toThrow('between 1 and 65535');
	});

	it('rejects invalid port (70000)', () =>
	{
		expect(() => makeRedisAdapter({ port: 70000 })).toThrow('between 1 and 65535');
	});

	it('rejects invalid db (-1)', () =>
	{
		expect(() => makeRedisAdapter({ db: -1 })).toThrow('between 0 and 15');
	});

	it('rejects invalid db (16)', () =>
	{
		expect(() => makeRedisAdapter({ db: 16 })).toThrow('between 0 and 15');
	});

	it('rejects invalid db (float)', () =>
	{
		expect(() => makeRedisAdapter({ db: 1.5 })).toThrow('between 0 and 15');
	});

	it('rejects non-string password', () =>
	{
		expect(() => makeRedisAdapter({ password: 123 })).toThrow('password must be a string');
	});

	it('rejects non-string url', () =>
	{
		expect(() => makeRedisAdapter({ url: 123 })).toThrow('url must be a string');
	});

	it('rejects non-string prefix', () =>
	{
		expect(() => makeRedisAdapter({ prefix: 123 })).toThrow('prefix must be a string');
	});

	it('rejects negative connectTimeout', () =>
	{
		expect(() => makeRedisAdapter({ connectTimeout: -1 })).toThrow('non-negative number');
	});

	it('rejects Infinity connectTimeout', () =>
	{
		expect(() => makeRedisAdapter({ connectTimeout: Infinity })).toThrow('non-negative number');
	});

	it('accepts valid url-based config', () =>
	{
		const adapter = makeRedisAdapter({ url: 'redis://localhost:6379' });
		expect(adapter._prefix).toBe('zh:');
		adapter._client.quit?.();
	});

	it('accepts valid host/port config', () =>
	{
		const adapter = makeRedisAdapter({ host: '127.0.0.1', port: 6379, db: 0, password: 'secret', prefix: 'app:', connectTimeout: 5000 });
		expect(adapter._prefix).toBe('app:');
		adapter._client.quit?.();
	});

	it('uses keyPrefix as prefix fallback', () =>
	{
		const adapter = makeRedisAdapter({ keyPrefix: 'kp:' });
		expect(adapter._prefix).toBe('kp:');
		adapter._client.quit?.();
	});

	it('accepts tls option in url mode', () =>
	{
		const adapter = makeRedisAdapter({ url: 'rediss://localhost', tls: {} });
		expect(adapter._prefix).toBe('zh:');
		adapter._client.quit?.();
	});

	it('accepts tls option in host mode', () =>
	{
		const adapter = makeRedisAdapter({ tls: { rejectUnauthorized: false } });
		expect(adapter._prefix).toBe('zh:');
		adapter._client.quit?.();
	});
});

// ===================================================================
//  URLENCODED PARSER — branch coverage boost
// ===================================================================

