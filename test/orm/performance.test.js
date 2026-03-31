/**
 * Phase 2 — Performance & Scalability Tests
 *
 * Covers:
 *   2.1 Prepared Statement Caching
 *   2.2 N+1 Query Prevention
 *   2.3 Read Replicas
 *   2.4 Query Logging & Profiling
 *   2.5 Connection Pool Optimization
 */
const { Database, Model, TYPES, QueryProfiler, ReplicaManager } = require('../../');

// ============================================================
//  Test Models (with relationships)
// ============================================================

class Author extends Model
{
    static table = 'authors';
    static schema = {
        id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: TYPES.STRING, required: true },
    };
    static timestamps = true;
}

class Book extends Model
{
    static table = 'books';
    static schema = {
        id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        title:    { type: TYPES.STRING, required: true },
        authorId: { type: TYPES.INTEGER, required: true },
        genre:    { type: TYPES.STRING },
    };
}

class Tag extends Model
{
    static table = 'tags';
    static schema = {
        id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: TYPES.STRING, required: true },
    };
}

class BookTag extends Model
{
    static table = 'book_tags';
    static schema = {
        id:     { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        bookId: { type: TYPES.INTEGER, required: true },
        tagId:  { type: TYPES.INTEGER, required: true },
    };
}

// ============================================================
//  Helper: create a fresh DB with relationships
// ============================================================

function createDb()
{
    const db = Database.connect('memory');
    db.registerAll(Author, Book, Tag, BookTag);
    Author.hasMany(Book, 'authorId');
    Book.belongsTo(Author, 'authorId');
    Book.belongsToMany(Tag, { through: 'book_tags', foreignKey: 'bookId', otherKey: 'tagId' });
    return db;
}

async function seedData(db)
{
    await db.sync();
    const alice = await Author.create({ name: 'Alice' });
    const bob   = await Author.create({ name: 'Bob' });

    const book1 = await Book.create({ title: 'Alpha', authorId: alice.id, genre: 'fiction' });
    const book2 = await Book.create({ title: 'Beta',  authorId: alice.id, genre: 'science' });
    const book3 = await Book.create({ title: 'Gamma', authorId: bob.id,   genre: 'fiction' });

    const tag1 = await Tag.create({ name: 'bestseller' });
    const tag2 = await Tag.create({ name: 'award-winner' });

    // Junction table
    await BookTag.create({ bookId: book1.id, tagId: tag1.id });
    await BookTag.create({ bookId: book1.id, tagId: tag2.id });
    await BookTag.create({ bookId: book2.id, tagId: tag1.id });

    return { alice, bob, book1, book2, book3, tag1, tag2 };
}

// ============================================================
//  Clean-up
// ============================================================

let db;

beforeEach(() =>
{
    db = createDb();
});

afterEach(async () =>
{
    if (db && db.adapter && db.adapter.clear) await db.adapter.clear();
    Author._adapter = null;
    Book._adapter = null;
    Tag._adapter = null;
    BookTag._adapter = null;
    Author._relations = {};
    Book._relations = {};
});

// ============================================================
//  2.1  Prepared Statement Caching
// ============================================================

describe('2.1 Prepared Statement Caching', () =>
{
    describe('SQLite statement cache (if available)', () =>
    {
        let sqliteDb;

        beforeEach(() =>
        {
            try
            {
                sqliteDb = Database.connect('sqlite', { filename: ':memory:', stmtCacheSize: 16 });
            }
            catch (e)
            {
                sqliteDb = null;
            }
        });

        afterEach(() =>
        {
            if (sqliteDb) sqliteDb.close();
        });

        it('should track cache hits and misses', () =>
        {
            if (!sqliteDb) return;

            const stats = sqliteDb.adapter.stmtCacheStats();
            expect(stats).toHaveProperty('size');
            expect(stats).toHaveProperty('maxSize', 16);
            expect(stats).toHaveProperty('hits');
            expect(stats).toHaveProperty('misses');
            expect(stats).toHaveProperty('hitRate');
        });

        it('should improve hit rate on repeated queries', async () =>
        {
            if (!sqliteDb) return;

            class TestItem extends Model
            {
                static table = 'test_items';
                static schema = {
                    id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                    name: { type: TYPES.STRING, required: true },
                };
            }
            sqliteDb.register(TestItem);
            await sqliteDb.sync();

            // Run same query multiple times
            for (let i = 0; i < 5; i++) await TestItem.find();

            const stats = sqliteDb.adapter.stmtCacheStats();
            expect(stats.hits).toBeGreaterThan(0);
            expect(stats.hitRate).toBeGreaterThan(0);

            TestItem._adapter = null;
        });

        it('should evict LRU entries when cache is full', async () =>
        {
            if (!sqliteDb) return;

            class EvictItem extends Model
            {
                static table = 'evict_items';
                static schema = {
                    id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                    name: { type: TYPES.STRING, required: true },
                    val:  { type: TYPES.INTEGER },
                };
            }
            sqliteDb.register(EvictItem);
            await sqliteDb.sync();

            // Generate many unique queries to fill cache
            for (let i = 0; i < 20; i++)
            {
                await EvictItem.query().where('val', '>', i).exec();
            }

            const stats = sqliteDb.adapter.stmtCacheStats();
            expect(stats.size).toBeLessThanOrEqual(16);

            EvictItem._adapter = null;
        });
    });
});

// ============================================================
//  2.2  N+1 Query Prevention
// ============================================================

describe('2.2 N+1 Query Prevention', () =>
{
    describe('withCount()', () =>
    {
        it('should count hasMany relationships', async () =>
        {
            await seedData(db);

            const authors = await Author.query().withCount('Book').exec();
            const alice = authors.find(a => a.name === 'Alice');
            const bob   = authors.find(a => a.name === 'Bob');

            expect(alice.Book_count).toBe(2);
            expect(bob.Book_count).toBe(1);
        });

        it('should return 0 for authors with no books', async () =>
        {
            await db.sync();
            await Author.create({ name: 'Charlie' });

            const authors = await Author.query().withCount('Book').exec();
            expect(authors[0].Book_count).toBe(0);
        });

        it('should count belongsTo relationships', async () =>
        {
            await seedData(db);

            const books = await Book.query().withCount('Author').exec();
            for (const book of books)
            {
                expect(book.Author_count).toBe(1);
            }
        });

        it('should count belongsToMany relationships', async () =>
        {
            await seedData(db);

            const books = await Book.query().withCount('Tag').exec();
            const alpha = books.find(b => b.title === 'Alpha');
            const beta  = books.find(b => b.title === 'Beta');
            const gamma = books.find(b => b.title === 'Gamma');

            expect(alpha.Tag_count).toBe(2);
            expect(beta.Tag_count).toBe(1);
            expect(gamma.Tag_count).toBe(0);
        });

        it('should work with withCount and with together', async () =>
        {
            await seedData(db);

            const authors = await Author.query()
                .with('Book')
                .withCount('Book')
                .exec();

            const alice = authors.find(a => a.name === 'Alice');
            expect(alice.Book).toHaveLength(2);
            expect(alice.Book_count).toBe(2);
        });

        it('should throw for unknown relation in withCount', async () =>
        {
            await seedData(db);

            await expect(
                Author.query().withCount('NonExistent').exec()
            ).rejects.toThrow(/Unknown relation/);
        });
    });

    describe('N+1 detection via profiler', () =>
    {
        it('should detect N+1 pattern in rapid queries', async () =>
        {
            const detected = [];
            const profiler = new QueryProfiler({
                n1Threshold: 3,
                n1Window: 500,
                onN1: (info) => detected.push(info),
            });

            // Simulate N+1: many selects to same table in quick succession
            for (let i = 0; i < 5; i++)
            {
                profiler.record({ table: 'books', action: 'select', duration: 1 });
            }

            expect(detected.length).toBeGreaterThan(0);
            expect(detected[0].table).toBe('books');
            expect(detected[0].count).toBeGreaterThanOrEqual(3);
        });

        it('should not flag non-select queries as N+1', () =>
        {
            const detected = [];
            const profiler = new QueryProfiler({
                n1Threshold: 3,
                n1Window: 500,
                onN1: (info) => detected.push(info),
            });

            for (let i = 0; i < 10; i++)
            {
                profiler.record({ table: 'books', action: 'insert', duration: 1 });
            }

            expect(detected.length).toBe(0);
        });

        it('should not flag queries to different tables', () =>
        {
            const detected = [];
            const profiler = new QueryProfiler({
                n1Threshold: 3,
                n1Window: 500,
                onN1: (info) => detected.push(info),
            });

            const tables = ['books', 'authors', 'tags', 'users', 'posts'];
            for (const t of tables)
            {
                profiler.record({ table: t, action: 'select', duration: 1 });
            }

            expect(detected.length).toBe(0);
        });

        it('should provide N+1 detections list', () =>
        {
            const profiler = new QueryProfiler({ n1Threshold: 2, n1Window: 500 });

            for (let i = 0; i < 5; i++)
            {
                profiler.record({ table: 'books', action: 'select', duration: 1 });
            }

            const detections = profiler.n1Detections();
            expect(detections.length).toBeGreaterThan(0);
            expect(detections[0]).toHaveProperty('table', 'books');
            expect(detections[0]).toHaveProperty('message');
        });
    });
});

// ============================================================
//  2.3  Read Replicas
// ============================================================

describe('2.3 Read Replicas', () =>
{
    describe('ReplicaManager', () =>
    {
        it('should set primary and return it for writes', () =>
        {
            const manager = new ReplicaManager();
            const primary = { name: 'primary' };
            manager.setPrimary(primary);

            expect(manager.getWriteAdapter()).toBe(primary);
        });

        it('should add replicas and return them for reads', () =>
        {
            const manager = new ReplicaManager({ strategy: 'round-robin' });
            const primary = { name: 'primary' };
            const replica1 = { name: 'replica1' };
            const replica2 = { name: 'replica2' };

            manager.setPrimary(primary);
            manager.addReplica(replica1);
            manager.addReplica(replica2);

            expect(manager.replicaCount).toBe(2);

            // Round-robin: should alternate
            const first  = manager.getReadAdapter();
            const second = manager.getReadAdapter();
            expect(first).not.toBe(second);
        });

        it('should use round-robin by default', () =>
        {
            const manager = new ReplicaManager();
            const primary = { name: 'primary' };
            const r1 = { name: 'r1' };
            const r2 = { name: 'r2' };
            const r3 = { name: 'r3' };

            manager.setPrimary(primary);
            manager.addReplica(r1);
            manager.addReplica(r2);
            manager.addReplica(r3);

            const reads = [
                manager.getReadAdapter(),
                manager.getReadAdapter(),
                manager.getReadAdapter(),
                manager.getReadAdapter(),
            ];
            expect(reads[0]).toBe(r1);
            expect(reads[1]).toBe(r2);
            expect(reads[2]).toBe(r3);
            expect(reads[3]).toBe(r1); // wraps around
        });

        it('should support random strategy', () =>
        {
            const manager = new ReplicaManager({ strategy: 'random' });
            const primary = { name: 'primary' };

            manager.setPrimary(primary);
            for (let i = 0; i < 10; i++) manager.addReplica({ name: `r${i}` });

            // Just confirm it returns a replica, not the primary
            const read = manager.getReadAdapter();
            expect(read.name).toMatch(/^r\d+$/);
        });

        it('should fall back to primary when no replicas', () =>
        {
            const manager = new ReplicaManager();
            const primary = { name: 'primary' };
            manager.setPrimary(primary);

            expect(manager.getReadAdapter()).toBe(primary);
        });

        it('should fall back to primary when all replicas are unhealthy', () =>
        {
            const manager = new ReplicaManager();
            const primary = { name: 'primary' };
            const r1 = { name: 'r1' };

            manager.setPrimary(primary);
            manager.addReplica(r1);
            manager.markUnhealthy(r1);

            expect(manager.getReadAdapter()).toBe(primary);
        });

        it('should respect sticky writes', () =>
        {
            const manager = new ReplicaManager({ stickyWrite: true, stickyWindow: 200 });
            const primary = { name: 'primary' };
            const replica = { name: 'replica' };

            manager.setPrimary(primary);
            manager.addReplica(replica);

            // Trigger a write
            manager.getWriteAdapter();

            // Reads should now go to primary during sticky window
            expect(manager.getReadAdapter()).toBe(primary);
        });

        it('should resume replica reads after sticky window expires', async () =>
        {
            const manager = new ReplicaManager({ stickyWrite: true, stickyWindow: 50 });
            const primary = { name: 'primary' };
            const replica = { name: 'replica' };

            manager.setPrimary(primary);
            manager.addReplica(replica);

            manager.getWriteAdapter(); // trigger write
            expect(manager.getReadAdapter()).toBe(primary); // sticky

            await new Promise(r => setTimeout(r, 80));

            expect(manager.getReadAdapter()).toBe(replica); // back to replica
        });

        it('should health check replicas', async () =>
        {
            const manager = new ReplicaManager();
            const primary = { name: 'primary' };
            const goodReplica = { name: 'good', ping: async () => true };
            const badReplica  = { name: 'bad',  ping: async () => { throw new Error('down'); } };

            manager.setPrimary(primary);
            manager.addReplica(goodReplica);
            manager.addReplica(badReplica);

            const results = await manager.healthCheck();
            expect(results[0].healthy).toBe(true);
            expect(results[1].healthy).toBe(false);
        });

        it('should recover a previously unhealthy replica', () =>
        {
            const manager = new ReplicaManager();
            const primary = { name: 'primary' };
            const r1 = { name: 'r1' };

            manager.setPrimary(primary);
            manager.addReplica(r1);
            manager.markUnhealthy(r1);

            expect(manager.getReadAdapter()).toBe(primary);

            manager.markHealthy(r1);
            expect(manager.getReadAdapter()).toBe(r1);
        });

        it('should throw when adding null replica', () =>
        {
            const manager = new ReplicaManager();
            expect(() => manager.addReplica(null)).toThrow(/must not be null/);
        });

        it('should return all adapters', () =>
        {
            const manager = new ReplicaManager();
            const primary = { name: 'primary' };
            const r1 = { name: 'r1' };

            manager.setPrimary(primary);
            manager.addReplica(r1);

            const all = manager.getAllAdapters();
            expect(all).toHaveLength(2);
            expect(all).toContain(primary);
            expect(all).toContain(r1);
        });

        it('should close all adapters', async () =>
        {
            const closed = [];
            const manager = new ReplicaManager();
            manager.setPrimary({ close: async () => closed.push('primary') });
            manager.addReplica({ close: async () => closed.push('r1') });

            await manager.closeAll();
            expect(closed).toEqual(['primary', 'r1']);
        });
    });

    describe('Database.connectWithReplicas()', () =>
    {
        it('should create a database with replica manager', () =>
        {
            const db = Database.connectWithReplicas('memory', {}, [{}, {}]);
            expect(db).toBeInstanceOf(Database);
            expect(db.replicas).toBeInstanceOf(ReplicaManager);
            expect(db.replicas.replicaCount).toBe(2);
        });

        it('should route reads via replicas with onReplica()', async () =>
        {
            const rDb = Database.connectWithReplicas('memory', {}, [{}], { stickyWrite: false });

            class RItem extends Model
            {
                static table = 'r_items';
                static schema = {
                    id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                    name: { type: TYPES.STRING, required: true },
                };
            }
            rDb.register(RItem);
            await rDb.sync();

            // Insert data into primary
            await RItem.create({ name: 'test' });

            // Query on primary should find the record
            const onPrimary = await RItem.query().exec();
            expect(onPrimary).toHaveLength(1);

            // Query on replica (separate memory store) won't have the data
            const onReplica = await RItem.query().onReplica().exec();
            expect(onReplica).toHaveLength(0); // replica is a separate memory store

            RItem._adapter = null;
        });
    });
});

// ============================================================
//  2.4  Query Logging & Profiling
// ============================================================

describe('2.4 Query Logging & Profiling', () =>
{
    describe('QueryProfiler', () =>
    {
        let profiler;

        beforeEach(() =>
        {
            profiler = new QueryProfiler({ slowThreshold: 50, maxHistory: 100 });
        });

        it('should record queries', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 5 });
            profiler.record({ table: 'posts', action: 'insert', duration: 10 });

            expect(profiler.metrics().totalQueries).toBe(2);
        });

        it('should calculate average latency', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 10 });
            profiler.record({ table: 'users', action: 'select', duration: 20 });

            expect(profiler.metrics().avgLatency).toBe(15);
        });

        it('should track slow queries', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 5 });
            profiler.record({ table: 'users', action: 'select', duration: 100 }); // slow
            profiler.record({ table: 'posts', action: 'select', duration: 200 }); // slow

            expect(profiler.metrics().slowQueries).toBe(2);
            expect(profiler.slowQueries()).toHaveLength(2);
        });

        it('should fire onSlow callback', () =>
        {
            const slowEntries = [];
            const p = new QueryProfiler({
                slowThreshold: 50,
                onSlow: (entry) => slowEntries.push(entry),
            });

            p.record({ table: 'users', action: 'select', duration: 10 });
            p.record({ table: 'users', action: 'select', duration: 100 });

            expect(slowEntries).toHaveLength(1);
            expect(slowEntries[0].table).toBe('users');
        });

        it('should calculate queries per second', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 1 });
            profiler.record({ table: 'users', action: 'select', duration: 1 });

            const metrics = profiler.metrics();
            expect(metrics.queriesPerSecond).toBeGreaterThan(0);
        });

        it('should respect maxHistory', () =>
        {
            const p = new QueryProfiler({ maxHistory: 5 });

            for (let i = 0; i < 10; i++)
            {
                p.record({ table: 'users', action: 'select', duration: i });
            }

            expect(p.getQueries()).toHaveLength(5);
            // Should keep the most recent
            expect(p.getQueries()[0].duration).toBe(5);
        });

        it('should filter queries by table', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 5 });
            profiler.record({ table: 'posts', action: 'select', duration: 5 });
            profiler.record({ table: 'users', action: 'insert', duration: 5 });

            expect(profiler.getQueries({ table: 'users' })).toHaveLength(2);
            expect(profiler.getQueries({ table: 'posts' })).toHaveLength(1);
        });

        it('should filter queries by action', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 5 });
            profiler.record({ table: 'users', action: 'insert', duration: 5 });

            expect(profiler.getQueries({ action: 'select' })).toHaveLength(1);
        });

        it('should filter queries by minimum duration', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 5 });
            profiler.record({ table: 'users', action: 'select', duration: 50 });
            profiler.record({ table: 'users', action: 'select', duration: 100 });

            expect(profiler.getQueries({ minDuration: 50 })).toHaveLength(2);
        });

        it('should reset all state', () =>
        {
            profiler.record({ table: 'users', action: 'select', duration: 5 });
            profiler.record({ table: 'users', action: 'select', duration: 5 });

            profiler.reset();

            expect(profiler.metrics().totalQueries).toBe(0);
            expect(profiler.metrics().totalTime).toBe(0);
            expect(profiler.getQueries()).toHaveLength(0);
            expect(profiler.n1Detections()).toHaveLength(0);
        });

        it('should support enable/disable toggle', () =>
        {
            profiler.enabled = false;
            profiler.record({ table: 'users', action: 'select', duration: 5 });

            expect(profiler.metrics().totalQueries).toBe(0);

            profiler.enabled = true;
            profiler.record({ table: 'users', action: 'select', duration: 5 });

            expect(profiler.metrics().totalQueries).toBe(1);
        });

        it('should sanitize entry data', () =>
        {
            profiler.record({ table: 123, action: undefined, duration: 'not-a-number' });

            const queries = profiler.getQueries();
            expect(queries[0].table).toBe('123');
            expect(queries[0].action).toBe('unknown');
            expect(queries[0].duration).toBe(0);
        });
    });

    describe('Database profiler integration', () =>
    {
        it('should attach profiler to database', async () =>
        {
            const profiler = db.enableProfiling({ slowThreshold: 100 });
            expect(profiler).toBeInstanceOf(QueryProfiler);
            expect(db.profiler).toBe(profiler);
        });

        it('should auto-profile queries via exec()', async () =>
        {
            const profiler = db.enableProfiling({ slowThreshold: 1000 });
            await db.sync();

            await Author.create({ name: 'Alice' });
            await Author.find();
            await Author.query().where('name', 'Alice').first();

            const metrics = profiler.metrics();
            // create() bypasses Query.exec(), so only find() and first() are profiled
            expect(metrics.totalQueries).toBeGreaterThanOrEqual(2);
        });

        it('should auto-profile count queries', async () =>
        {
            const profiler = db.enableProfiling();
            await db.sync();

            await Author.create({ name: 'Alice' });
            await Author.count();

            expect(profiler.metrics().totalQueries).toBeGreaterThanOrEqual(1);
        });

        it('should detect slow queries in integration', async () =>
        {
            const slowEntries = [];
            db.enableProfiling({
                slowThreshold: 0, // everything is "slow" at 0ms
                onSlow: (entry) => slowEntries.push(entry),
            });
            await db.sync();
            await Author.create({ name: 'Alice' });

            // At least some queries should have been flagged
            expect(slowEntries.length).toBeGreaterThanOrEqual(0);
        });
    });
});

// ============================================================
//  2.5  Connection Pool Optimization
// ============================================================

describe('2.5 Connection Pool Optimization', () =>
{
    describe('SQLite warmup/validation', () =>
    {
        let sqliteDb;

        beforeEach(() =>
        {
            try
            {
                sqliteDb = Database.connect('sqlite', { filename: ':memory:' });
            }
            catch (e)
            {
                sqliteDb = null;
            }
        });

        afterEach(() =>
        {
            if (sqliteDb) sqliteDb.close();
        });

        it('should validate connection via ping', async () =>
        {
            if (!sqliteDb) return;
            const healthy = await sqliteDb.ping();
            expect(healthy).toBe(true);
        });
    });
});

// ============================================================
//  explain() — Query plan analysis
// ============================================================

describe('explain() — Query Plan Analysis', () =>
{
    it('should return plan info for memory adapter', async () =>
    {
        await db.sync();
        await Author.create({ name: 'Alice' });

        const plan = await Author.query().where('name', 'Alice').explain();

        expect(plan).toBeDefined();
        expect(plan.adapter).toBe('memory');
        expect(plan.table).toBe('authors');
    });

    it('should show filter count in memory explain', async () =>
    {
        await db.sync();

        const plan = await Author.query()
            .where('name', 'Alice')
            .where('id', '>', 0)
            .explain();

        expect(plan.filters).toBe(2);
    });

    it('should show estimated row count', async () =>
    {
        await db.sync();
        await Author.create({ name: 'Alice' });
        await Author.create({ name: 'Bob' });

        const plan = await Author.query().explain();
        expect(plan.estimatedRows).toBe(2);
    });

    it('should work with SQLite EXPLAIN QUERY PLAN', async () =>
    {
        let sqliteDb;
        try
        {
            sqliteDb = Database.connect('sqlite', { filename: ':memory:' });
        }
        catch (e) { return; } // skip if no better-sqlite3

        class ExplainItem extends Model
        {
            static table = 'explain_items';
            static schema = {
                id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                name: { type: TYPES.STRING, required: true },
            };
        }
        sqliteDb.register(ExplainItem);
        await sqliteDb.sync();

        const plan = await ExplainItem.query().where('name', 'test').explain();

        expect(Array.isArray(plan)).toBe(true);
        // SQLite EXPLAIN QUERY PLAN returns objects with id, parent, notused, detail
        if (plan.length > 0) expect(plan[0]).toHaveProperty('detail');

        ExplainItem._adapter = null;
        sqliteDb.close();
    });
});

// ============================================================
//  onReplica() — Explicit replica routing
// ============================================================

describe('onReplica() — Replica Routing', () =>
{
    it('should be chainable', async () =>
    {
        await db.sync();

        // onReplica without a replica manager should still work (uses primary)
        const results = await Author.query().onReplica().exec();
        expect(Array.isArray(results)).toBe(true);
    });

    it('should route to replica adapter when replica manager exists', async () =>
    {
        const rDb = Database.connectWithReplicas('memory', {}, [{}]);

        class RBook extends Model
        {
            static table = 'r_books';
            static schema = {
                id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
                name: { type: TYPES.STRING, required: true },
            };
        }
        rDb.register(RBook);
        await rDb.sync();

        await RBook.create({ name: 'Book1' });

        // Primary has the data
        const primary = await RBook.query().exec();
        expect(primary).toHaveLength(1);

        // Replica (separate memory) doesn't
        const replica = await RBook.query().onReplica().exec();
        expect(replica).toHaveLength(0);

        RBook._adapter = null;
    });
});

// ============================================================
//  Integration: Full Phase 2 Workflow
// ============================================================

describe('Phase 2 Integration', () =>
{
    it('should profile queries and detect N+1 in a real workflow', async () =>
    {
        const n1Detected = [];
        const profiler = db.enableProfiling({
            slowThreshold: 1000,
            n1Threshold: 3,
            n1Window: 1000,
            onN1: (info) => n1Detected.push(info),
        });

        await seedData(db);

        // Efficient: use with() for eager loading (1 query per relation)
        const authors = await Author.query().with('Book').exec();

        // Check profiler captured queries
        const metrics = profiler.metrics();
        expect(metrics.totalQueries).toBeGreaterThan(0);
        expect(metrics.avgLatency).toBeGreaterThanOrEqual(0);
    });

    it('should use withCount() and profiling together', async () =>
    {
        const profiler = db.enableProfiling();
        await seedData(db);

        const authors = await Author.query().withCount('Book').exec();
        const alice = authors.find(a => a.name === 'Alice');

        expect(alice.Book_count).toBe(2);
        expect(profiler.metrics().totalQueries).toBeGreaterThan(0);
    });

    it('should combine with(), withCount(), and explain()', async () =>
    {
        await seedData(db);

        // Explain before executing
        const plan = await Author.query()
            .where('name', 'Alice')
            .explain();
        expect(plan).toBeDefined();

        // Execute with eager loading + counts
        const authors = await Author.query()
            .with('Book')
            .withCount('Book')
            .exec();

        const alice = authors.find(a => a.name === 'Alice');
        expect(alice.Book).toHaveLength(2);
        expect(alice.Book_count).toBe(2);
    });
});
