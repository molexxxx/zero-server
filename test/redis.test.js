/**
 * Tests for the Redis adapter (using memory mock when ioredis unavailable).
 * Tests all ORM CRUD operations, key-value operations, pub/sub,
 * pipelines, unique constraints, DDL/migration methods, and aggregates.
 */
const { Database, Model, TYPES } = require('../lib/orm');

// -- Mock ioredis for testing without a live Redis server --

/**
 * Minimal ioredis mock that stores data in memory.
 * Supports the subset of Redis commands used by the adapter.
 */
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
    RedisAdapter = require('../lib/orm/adapters/redis');

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
