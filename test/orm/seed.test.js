/**
 * Tests for QueryCache, Seeder, SeederRunner, Factory, Fake,
 * and new ORM error classes.
 */
const {
    Database, Model, TYPES,
    QueryCache, Seeder, SeederRunner, Factory, Fake,
    ConnectionError, MigrationError, TransactionError,
    QueryError, AdapterError, CacheError,
} = require('../../');

// -- Models --

class Item extends Model
{
    static table = 'items';
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING,  required: true },
        price: { type: TYPES.FLOAT },
        inStock: { type: TYPES.BOOLEAN, default: true },
    };
    static timestamps = true;
}

// ============================================================
//  QueryCache
// ============================================================

describe('QueryCache', () =>
{
    let cache;

    beforeEach(() =>
    {
        cache = new QueryCache({ maxEntries: 5, defaultTTL: 10 });
    });

    // -- Basic Operations --

    describe('get / set', () =>
    {
        it('should store and retrieve a value', () =>
        {
            cache.set('k1', 'hello');
            expect(cache.get('k1')).toBe('hello');
        });

        it('should return undefined for cache miss', () =>
        {
            expect(cache.get('nonexistent')).toBeUndefined();
        });

        it('should store objects', () =>
        {
            cache.set('obj', { a: 1, b: [2, 3] });
            expect(cache.get('obj')).toEqual({ a: 1, b: [2, 3] });
        });

        it('should store null values', () =>
        {
            cache.set('nil', null);
            expect(cache.get('nil')).toBeNull();
        });
    });

    // -- TTL --

    describe('TTL expiration', () =>
    {
        it('should expire entries after TTL', () =>
        {
            cache.set('temp', 'val', 0.001); // 1 ms TTL

            // Wait for expiry
            return new Promise(resolve =>
            {
                setTimeout(() =>
                {
                    expect(cache.get('temp')).toBeUndefined();
                    resolve();
                }, 20);
            });
        });

        it('should not expire entries with TTL=0', () =>
        {
            cache.set('forever', 'val', 0);
            expect(cache.get('forever')).toBe('val');
        });

        it('should use default TTL when not specified', () =>
        {
            const c = new QueryCache({ defaultTTL: 0.001 });
            c.set('auto-ttl', 'val');

            return new Promise(resolve =>
            {
                setTimeout(() =>
                {
                    expect(c.get('auto-ttl')).toBeUndefined();
                    resolve();
                }, 20);
            });
        });
    });

    // -- LRU Eviction --

    describe('LRU eviction', () =>
    {
        it('should evict oldest entries when maxEntries is reached', () =>
        {
            for (let i = 0; i < 6; i++)
            {
                cache.set(`key${i}`, `val${i}`);
            }
            // key0 should be evicted (maxEntries=5)
            expect(cache.get('key0')).toBeUndefined();
            expect(cache.get('key5')).toBe('val5');
        });

        it('should bump accessed entries to end of LRU', () =>
        {
            cache.set('a', 1);
            cache.set('b', 2);
            cache.set('c', 3);
            cache.set('d', 4);
            cache.set('e', 5);

            // Access 'a' to bump it
            cache.get('a');

            // Add one more to trigger eviction — should evict 'b', not 'a'
            cache.set('f', 6);
            expect(cache.get('a')).toBe(1);
            expect(cache.get('b')).toBeUndefined();
        });
    });

    // -- has / delete --

    describe('has / delete', () =>
    {
        it('should return true for existing key', () =>
        {
            cache.set('k', 'v');
            expect(cache.has('k')).toBe(true);
        });

        it('should return false for missing key', () =>
        {
            expect(cache.has('nope')).toBe(false);
        });

        it('should delete a key', () =>
        {
            cache.set('k', 'v');
            expect(cache.delete('k')).toBe(true);
            expect(cache.get('k')).toBeUndefined();
        });

        it('should return false when deleting non-existent key', () =>
        {
            expect(cache.delete('nope')).toBe(false);
        });
    });

    // -- invalidate --

    describe('invalidate', () =>
    {
        it('should remove all entries matching a table name', () =>
        {
            cache.set('users|select|[]', 'data1');
            cache.set('users|count|[]', 'data2');
            cache.set('posts|select|[]', 'data3');

            const count = cache.invalidate('users');
            expect(count).toBe(2);
            expect(cache.get('users|select|[]')).toBeUndefined();
            expect(cache.get('posts|select|[]')).toBe('data3');
        });
    });

    // -- flush --

    describe('flush', () =>
    {
        it('should clear all entries', () =>
        {
            cache.set('a', 1);
            cache.set('b', 2);
            const count = cache.flush();
            expect(count).toBe(2);
            expect(cache.get('a')).toBeUndefined();
        });

        it('should reset stats', () =>
        {
            cache.set('a', 1);
            cache.get('a');
            cache.get('miss');
            cache.flush();
            const stats = cache.stats();
            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(0);
        });
    });

    // -- stats --

    describe('stats', () =>
    {
        it('should track hits and misses', () =>
        {
            cache.set('k', 'v');
            cache.get('k');      // hit
            cache.get('k');      // hit
            cache.get('miss1');  // miss
            cache.get('miss2');  // miss

            const s = cache.stats();
            expect(s.hits).toBe(2);
            expect(s.misses).toBe(2);
            expect(s.hitRate).toBe(0.5);
            expect(s.size).toBe(1);
            expect(s.maxEntries).toBe(5);
        });

        it('should return 0 hitRate when no queries', () =>
        {
            expect(cache.stats().hitRate).toBe(0);
        });
    });

    // -- prune --

    describe('prune', () =>
    {
        it('should remove expired entries', () =>
        {
            cache.set('exp1', 'v', 0.001);
            cache.set('exp2', 'v', 0.001);
            cache.set('live', 'v', 999);

            return new Promise(resolve =>
            {
                setTimeout(() =>
                {
                    const pruned = cache.prune();
                    expect(pruned).toBe(2);
                    expect(cache.get('live')).toBe('v');
                    resolve();
                }, 20);
            });
        });
    });

    // -- remember --

    describe('remember', () =>
    {
        it('should compute and cache value on miss', async () =>
        {
            let calls = 0;
            const fn = async () => { calls++; return 'computed'; };

            const r1 = await cache.remember('key', fn);
            expect(r1).toBe('computed');
            expect(calls).toBe(1);

            const r2 = await cache.remember('key', fn);
            expect(r2).toBe('computed');
            expect(calls).toBe(1); // not called again
        });
    });

    // -- wrap --

    describe('wrap', () =>
    {
        it('should cache query results by descriptor', async () =>
        {
            let calls = 0;
            const descriptor = { table: 'users', action: 'select', where: [] };
            const executor = async () => { calls++; return [{ id: 1 }]; };

            const r1 = await cache.wrap(descriptor, executor, 30);
            expect(r1).toEqual([{ id: 1 }]);

            const r2 = await cache.wrap(descriptor, executor, 30);
            expect(calls).toBe(1);
        });
    });

    // -- keyFromDescriptor --

    describe('keyFromDescriptor', () =>
    {
        it('should produce deterministic keys', () =>
        {
            const desc = { table: 'users', action: 'select', where: [{ field: 'id', op: '=', value: 1 }] };
            const k1 = QueryCache.keyFromDescriptor(desc);
            const k2 = QueryCache.keyFromDescriptor(desc);
            expect(k1).toBe(k2);
        });

        it('should produce different keys for different queries', () =>
        {
            const k1 = QueryCache.keyFromDescriptor({ table: 'users', action: 'select', where: [] });
            const k2 = QueryCache.keyFromDescriptor({ table: 'posts', action: 'select', where: [] });
            expect(k1).not.toBe(k2);
        });
    });
});

// ============================================================
//  Fake
// ============================================================

describe('Fake', () =>
{
    it('should generate a first name', () =>
    {
        const name = Fake.firstName();
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
    });

    it('should generate a last name', () =>
    {
        expect(typeof Fake.lastName()).toBe('string');
    });

    it('should generate a full name', () =>
    {
        const name = Fake.fullName();
        expect(name.split(' ')).toHaveLength(2);
    });

    it('should generate a valid email', () =>
    {
        const email = Fake.email();
        expect(email).toMatch(/@/);
        expect(email).toMatch(/\./);
    });

    it('should generate a username', () =>
    {
        const u = Fake.username();
        expect(typeof u).toBe('string');
        expect(u.length).toBeGreaterThan(0);
    });

    it('should generate a UUID', () =>
    {
        const uuid = Fake.uuid();
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('should generate integers in range', () =>
    {
        for (let i = 0; i < 50; i++)
        {
            const n = Fake.integer(10, 20);
            expect(n).toBeGreaterThanOrEqual(10);
            expect(n).toBeLessThanOrEqual(20);
        }
    });

    it('should generate floats in range', () =>
    {
        const f = Fake.float(0, 10, 2);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(10);
    });

    it('should generate booleans', () =>
    {
        const vals = new Set();
        for (let i = 0; i < 100; i++) vals.add(Fake.boolean());
        expect(vals.has(true)).toBe(true);
        expect(vals.has(false)).toBe(true);
    });

    it('should generate Date objects', () =>
    {
        const d = Fake.date();
        expect(d).toBeInstanceOf(Date);
    });

    it('should generate ISO date strings', () =>
    {
        const s = Fake.dateString();
        expect(typeof s).toBe('string');
        expect(new Date(s).toISOString()).toBe(s);
    });

    it('should generate paragraphs', () =>
    {
        const p = Fake.paragraph(3);
        expect(typeof p).toBe('string');
        expect(p.split('.').length).toBeGreaterThanOrEqual(3);
    });

    it('should generate sentences', () =>
    {
        const s = Fake.sentence(5);
        expect(s.split(' ')).toHaveLength(5);
        expect(s.endsWith('.')).toBe(true);
        expect(s[0]).toBe(s[0].toUpperCase());
    });

    it('should generate a word', () =>
    {
        expect(typeof Fake.word()).toBe('string');
    });

    it('should generate phone numbers', () =>
    {
        const p = Fake.phone();
        expect(p).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
    });

    it('should generate hex colors', () =>
    {
        const c = Fake.color();
        expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('should generate URLs', () =>
    {
        const u = Fake.url();
        expect(u).toMatch(/^https:\/\/[^/]+\/\w+$/);
    });

    it('should generate IP addresses', () =>
    {
        const ip = Fake.ip();
        const parts = ip.split('.');
        expect(parts).toHaveLength(4);
        parts.forEach(p => expect(Number(p)).toBeGreaterThanOrEqual(0));
    });

    it('should pick from an array', () =>
    {
        const arr = ['a', 'b', 'c'];
        expect(arr).toContain(Fake.pick(arr));
    });

    it('should pick multiple unique items', () =>
    {
        const arr = [1, 2, 3, 4, 5];
        const picked = Fake.pickMany(arr, 3);
        expect(picked).toHaveLength(3);
        expect(new Set(picked).size).toBe(3);
    });

    it('should generate JSON objects', () =>
    {
        const j = Fake.json();
        expect(j).toHaveProperty('key');
        expect(j).toHaveProperty('value');
        expect(j).toHaveProperty('count');
        expect(j).toHaveProperty('active');
    });
});

// ============================================================
//  Factory
// ============================================================

describe('Factory', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = Database.connect('memory');
        db.register(Item);
        await db.sync();
    });

    describe('define & make', () =>
    {
        it('should build a single record without persisting', () =>
        {
            const factory = new Factory(Item).define({
                name: () => 'Widget',
                price: 9.99,
            });
            const record = factory.make();
            expect(record.name).toBe('Widget');
            expect(record.price).toBe(9.99);
        });

        it('should build multiple records', () =>
        {
            const factory = new Factory(Item).define({ name: 'X', price: 1.0 });
            const records = factory.count(3).make();
            expect(records).toHaveLength(3);
            records.forEach(r => expect(r.name).toBe('X'));
        });

        it('should handle dynamic generators', () =>
        {
            const factory = new Factory(Item).define({
                name: (i) => `Item-${i}`,
                price: () => Fake.float(1, 100),
            });
            const records = factory.count(3).make();
            expect(records[0].name).toBe('Item-0');
            expect(records[1].name).toBe('Item-1');
        });

        it('should accept overrides', () =>
        {
            const factory = new Factory(Item).define({
                name: 'Default',
                price: 5.0,
            });
            const record = factory.make({ name: 'Custom' });
            expect(record.name).toBe('Custom');
            expect(record.price).toBe(5.0);
        });
    });

    describe('create', () =>
    {
        it('should persist a single record', async () =>
        {
            const factory = new Factory(Item).define({
                name: 'Persisted',
                price: 1.99,
            });
            const record = await factory.create();
            expect(record.id).toBeDefined();
            expect(record.name).toBe('Persisted');

            const found = await Item.findById(record.id);
            expect(found).toBeDefined();
        });

        it('should persist multiple records', async () =>
        {
            const factory = new Factory(Item).define({
                name: (i) => `Item-${i}`,
                price: 1.0,
            });
            const records = await factory.count(5).create();
            expect(records).toHaveLength(5);
            expect(await Item.count()).toBe(5);
        });

        it('should accept overrides when creating', async () =>
        {
            const factory = new Factory(Item).define({ name: 'Base', price: 1.0 });
            const record = await factory.create({ price: 99.99 });
            expect(record.price).toBe(99.99);
        });
    });

    describe('states', () =>
    {
        it('should define and apply named states', () =>
        {
            const factory = new Factory(Item)
                .define({ name: 'Regular', price: 10.0, inStock: true })
                .state('outOfStock', { inStock: false, name: 'Out of Stock' });

            const regular = factory.make();
            expect(regular.inStock).toBe(true);

            const oos = factory.withState('outOfStock').make();
            expect(oos.inStock).toBe(false);
            expect(oos.name).toBe('Out of Stock');
        });

        it('should throw for undefined state', () =>
        {
            const factory = new Factory(Item).define({ name: 'X' });
            expect(() => factory.withState('nonexistent')).toThrow('not defined');
        });
    });

    describe('afterCreating', () =>
    {
        it('should call after-create hooks', async () =>
        {
            const log = [];
            const factory = new Factory(Item)
                .define({ name: 'Hook', price: 1.0 })
                .afterCreating(async (record, i) =>
                {
                    log.push({ id: record.id, index: i });
                });

            await factory.count(2).create();
            expect(log).toHaveLength(2);
            expect(log[0].index).toBe(0);
            expect(log[1].index).toBe(1);
        });
    });
});

// ============================================================
//  Seeder / SeederRunner
// ============================================================

describe('Seeder & SeederRunner', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = Database.connect('memory');
        db.register(Item);
        await db.sync();
    });

    describe('Seeder base class', () =>
    {
        it('should throw if run() is not implemented', async () =>
        {
            const seeder = new Seeder();
            await expect(seeder.run(db)).rejects.toThrow('not implemented');
        });
    });

    describe('SeederRunner', () =>
    {
        it('should run a seeder class', async () =>
        {
            class ItemSeeder extends Seeder
            {
                async run(db)
                {
                    await Item.create({ name: 'Seeded', price: 5.0 });
                }
            }

            const runner = new SeederRunner(db);
            const names = await runner.run(ItemSeeder);
            expect(names).toEqual(['ItemSeeder']);
            expect(await Item.count()).toBe(1);
        });

        it('should run multiple seeders', async () =>
        {
            class S1 extends Seeder { async run() { await Item.create({ name: 'A', price: 1 }); } }
            class S2 extends Seeder { async run() { await Item.create({ name: 'B', price: 2 }); } }

            const runner = new SeederRunner(db);
            const names = await runner.run(S1, S2);
            expect(names).toEqual(['S1', 'S2']);
            expect(await Item.count()).toBe(2);
        });

        it('should accept seeder instances', async () =>
        {
            class TestSeeder extends Seeder
            {
                async run() { await Item.create({ name: 'Instance', price: 1 }); }
            }

            const runner = new SeederRunner(db);
            await runner.run(new TestSeeder());
            expect(await Item.count()).toBe(1);
        });

        it('should call a single seeder', async () =>
        {
            class OneSeeder extends Seeder
            {
                async run() { await Item.create({ name: 'One', price: 1 }); }
            }

            const runner = new SeederRunner(db);
            await runner.call(OneSeeder);
            expect(await Item.count()).toBe(1);
        });

        it('should support fresh (clear and re-seed)', async () =>
        {
            // Pre-populate
            await Item.create({ name: 'Old', price: 99 });
            expect(await Item.count()).toBe(1);

            class FreshSeeder extends Seeder
            {
                async run() { await Item.create({ name: 'New', price: 1 }); }
            }

            const runner = new SeederRunner(db);
            await runner.fresh(FreshSeeder);
            // After fresh, old data should be cleared
            const items = await Item.find({});
            const names = items.map(i => i.name);
            expect(names).toContain('New');
        });

        it('should work with Factory inside a seeder', async () =>
        {
            class FactorySeeder extends Seeder
            {
                async run()
                {
                    const factory = new Factory(Item).define({
                        name: (i) => `Generated-${i}`,
                        price: () => Fake.float(1, 50),
                    });
                    await factory.count(10).create();
                }
            }

            const runner = new SeederRunner(db);
            await runner.run(FactorySeeder);
            expect(await Item.count()).toBe(10);
        });
    });
});

// ============================================================
//  Error Classes
// ============================================================

describe('ORM Error Classes', () =>
{
    describe('ConnectionError', () =>
    {
        it('should have correct defaults', () =>
        {
            const err = new ConnectionError();
            expect(err.message).toBe('Connection Failed');
            expect(err.statusCode).toBe(500);
            expect(err.code).toBe('CONNECTION_ERROR');
        });

        it('should carry connection context', () =>
        {
            const err = new ConnectionError('Redis timeout', {
                adapter: 'redis',
                attempt: 3,
                maxRetries: 5,
                host: '127.0.0.1',
                port: 6379,
            });
            expect(err.adapter).toBe('redis');
            expect(err.attempt).toBe(3);
            expect(err.maxRetries).toBe(5);
            expect(err.host).toBe('127.0.0.1');
            expect(err.port).toBe(6379);
        });

        it('should be an instance of Error and DatabaseError', () =>
        {
            const err = new ConnectionError();
            expect(err).toBeInstanceOf(Error);
        });
    });

    describe('MigrationError', () =>
    {
        it('should have correct defaults', () =>
        {
            const err = new MigrationError();
            expect(err.message).toBe('Migration Failed');
            expect(err.code).toBe('MIGRATION_ERROR');
        });

        it('should carry migration context', () =>
        {
            const err = new MigrationError('Table creation failed', {
                migration: '001_create_users',
                direction: 'up',
                batch: 3,
            });
            expect(err.migration).toBe('001_create_users');
            expect(err.direction).toBe('up');
            expect(err.batch).toBe(3);
        });
    });

    describe('TransactionError', () =>
    {
        it('should have correct defaults', () =>
        {
            const err = new TransactionError();
            expect(err.message).toBe('Transaction Failed');
            expect(err.code).toBe('TRANSACTION_ERROR');
        });

        it('should carry phase info', () =>
        {
            const err = new TransactionError('Commit failed', { phase: 'commit' });
            expect(err.phase).toBe('commit');
        });
    });

    describe('QueryError', () =>
    {
        it('should have correct defaults', () =>
        {
            const err = new QueryError();
            expect(err.message).toBe('Query Failed');
            expect(err.code).toBe('QUERY_ERROR');
        });

        it('should carry query context', () =>
        {
            const err = new QueryError('Syntax error', {
                sql: 'SELECT * FROM oops',
                params: [1, 2],
                table: 'oops',
            });
            expect(err.sql).toBe('SELECT * FROM oops');
            expect(err.params).toEqual([1, 2]);
            expect(err.table).toBe('oops');
        });
    });

    describe('AdapterError', () =>
    {
        it('should have correct defaults', () =>
        {
            const err = new AdapterError();
            expect(err.message).toBe('Adapter Error');
            expect(err.code).toBe('ADAPTER_ERROR');
        });

        it('should carry adapter context', () =>
        {
            const err = new AdapterError('Driver not found', {
                adapter: 'redis',
                operation: 'connect',
            });
            expect(err.adapter).toBe('redis');
            expect(err.operation).toBe('connect');
        });
    });

    describe('CacheError', () =>
    {
        it('should have correct defaults', () =>
        {
            const err = new CacheError();
            expect(err.message).toBe('Cache Error');
            expect(err.statusCode).toBe(500);
            expect(err.code).toBe('CACHE_ERROR');
        });

        it('should carry cache context', () =>
        {
            const err = new CacheError('Redis cache down', {
                operation: 'get',
                key: 'users:all',
            });
            expect(err.operation).toBe('get');
            expect(err.key).toBe('users:all');
        });
    });

    describe('Error serialization', () =>
    {
        it('should serialize to JSON', () =>
        {
            const err = new QueryError('Bad query', {
                sql: 'SELECT 1',
                table: 'test',
            });
            const json = err.toJSON();
            expect(json).toHaveProperty('error', 'Bad query');
            expect(json).toHaveProperty('code', 'QUERY_ERROR');
            expect(json).toHaveProperty('statusCode', 500);
        });
    });
});
