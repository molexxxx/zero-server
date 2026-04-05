/**
 * Coverage tests for lib/orm/adapters/sqlite.js
 * Targets uncovered branches: constructor options (readonly, fileMustExist, verbose),
 * explain (distinct, joins, groupBy, having, limit, offset), createTable (compositeKey,
 * check, enum, references with onDelete/onUpdate, compositeUnique named groups,
 * compositeIndex, individual index with string name), execute (count action, distinct,
 * joins, groupBy, having, limit, offset), aggregate (where, groupBy, having),
 * addColumn options, createIndex unique, stmt cache LRU eviction, overview formatting.
 */

const fs   = require('fs');
const path = require('path');
const { Database, Model, TYPES } = require('../../../lib/orm');

const TMP_DIR = path.join(__dirname, '.tmp-sqlite-cov');
function tmpFile(n) { return path.join(TMP_DIR, n); }
function cleanup() { if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true }); }

afterAll(cleanup);

let db;
afterEach(async () => {
    if (db) { try { await db.close(); } catch {} db = null; }
});

// --- constructor options --------------------------------------------------
describe('SQLite adapter — constructor options', () => {
    it('verbose option enables console logging', () => {
        db = Database.connect('sqlite', { verbose: true });
        expect(db.adapter).toBeDefined();
    });

    it('readonly option creates read-only connection', () => {
        cleanup();
        const file = tmpFile('ro.db');
        // Create file first
        const w = Database.connect('sqlite', { filename: file });
        w.close();
        db = Database.connect('sqlite', { filename: file, readonly: true });
        expect(db.adapter).toBeDefined();
    });

    it('fileMustExist option throws for missing file', () => {
        cleanup();
        expect(() => Database.connect('sqlite', {
            filename: tmpFile('noexist.db'),
            fileMustExist: true,
            createDir: false,
        })).toThrow();
    });
});

// --- stmt cache LRU eviction ----------------------------------------------
describe('SQLite adapter — stmt cache LRU', () => {
    it('evicts oldest entry when cache exceeds max', async () => {
        db = Database.connect('sqlite', { stmtCacheSize: 3 });
        const adapter = db.adapter;

        // Create a table to query
        adapter._db.exec('CREATE TABLE t (id INTEGER)');

        // Fill cache with 3 entries
        adapter._prepare('SELECT 1');
        adapter._prepare('SELECT 2');
        adapter._prepare('SELECT 3');
        expect(adapter._stmtCache.size).toBe(3);

        // Adding a 4th should evict the oldest (SELECT 1)
        adapter._prepare('SELECT 4');
        expect(adapter._stmtCache.size).toBe(3);
        expect(adapter._stmtCache.has('SELECT 1')).toBe(false);
        expect(adapter._stmtCache.has('SELECT 4')).toBe(true);
    });

    it('LRU reorder moves accessed entry to end', async () => {
        db = Database.connect('sqlite', { stmtCacheSize: 3 });
        const adapter = db.adapter;

        adapter._db.exec('CREATE TABLE t (id INTEGER)');
        adapter._prepare('SELECT 1');
        adapter._prepare('SELECT 2');
        adapter._prepare('SELECT 3');

        // Access SELECT 1 to make it most recently used
        adapter._prepare('SELECT 1');

        // Now adding SELECT 4 should evict SELECT 2 (oldest)
        adapter._prepare('SELECT 4');
        expect(adapter._stmtCache.has('SELECT 1')).toBe(true);
        expect(adapter._stmtCache.has('SELECT 2')).toBe(false);
    });
});

// --- explain with all optional clauses ------------------------------------
describe('SQLite adapter — explain()', () => {
    beforeEach(async () => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, category TEXT, value INTEGER)');
        db.adapter._db.exec("INSERT INTO items VALUES (1, 'a', 'x', 10)");
    });

    it('explain with distinct', () => {
        const plan = db.adapter.explain({
            table: 'items', fields: ['name'], distinct: true,
            where: [], orderBy: [], joins: [],
        });
        expect(Array.isArray(plan)).toBe(true);
    });

    it('explain with limit and offset', () => {
        const plan = db.adapter.explain({
            table: 'items', fields: [], where: [],
            orderBy: [], limit: 10, offset: 5, joins: [],
        });
        expect(Array.isArray(plan)).toBe(true);
    });

    it('explain with groupBy and having', () => {
        const plan = db.adapter.explain({
            table: 'items', fields: ['category'],
            where: [], orderBy: [], joins: [],
            groupBy: ['category'],
            having: [{ field: 'value', op: '>', value: 0 }],
        });
        expect(Array.isArray(plan)).toBe(true);
    });

    it('explain with orderBy', () => {
        const plan = db.adapter.explain({
            table: 'items', fields: [],
            where: [{ field: 'value', op: '>', value: 5 }],
            orderBy: [{ field: 'name', dir: 'ASC' }],
            joins: [],
        });
        expect(Array.isArray(plan)).toBe(true);
    });
});

// --- createTable complex schema -------------------------------------------
describe('SQLite adapter — createTable branches', () => {
    beforeEach(() => { db = Database.connect('sqlite'); });

    it('creates table with composite primary key', async () => {
        await db.adapter.createTable('composite', {
            a: { type: 'integer', primaryKey: true, compositeKey: true },
            b: { type: 'integer', primaryKey: true, compositeKey: true },
            val: { type: 'text' },
        });
        expect(db.adapter.hasTable('composite')).toBe(true);
    });

    it('creates table with CHECK constraint', async () => {
        await db.adapter.createTable('checked', {
            id: { type: 'integer', primaryKey: true },
            age: { type: 'integer', check: '"age" >= 0 AND "age" <= 200' },
        });
        expect(db.adapter.hasTable('checked')).toBe(true);
        // Should enforce CHECK
        expect(() => db.adapter._db.exec('INSERT INTO checked VALUES (1, 300)')).toThrow();
    });

    it('creates table with enum as CHECK', async () => {
        await db.adapter.createTable('enumt', {
            id: { type: 'integer', primaryKey: true },
            status: { type: 'string', enum: ['active', 'inactive'] },
        });
        expect(db.adapter.hasTable('enumt')).toBe(true);
    });

    it('creates table with references and onDelete/onUpdate', async () => {
        await db.adapter.createTable('parents', {
            id: { type: 'integer', primaryKey: true },
        });
        await db.adapter.createTable('children', {
            id: { type: 'integer', primaryKey: true },
            parent_id: {
                type: 'integer',
                references: { table: 'parents', column: 'id', onDelete: 'CASCADE', onUpdate: 'SET NULL' },
            },
        });
        const fks = db.adapter.foreignKeys('children');
        expect(fks.length).toBe(1);
        expect(fks[0].onDelete).toBe('CASCADE');
        expect(fks[0].onUpdate).toBe('SET NULL');
    });

    it('creates table with named composite unique', async () => {
        await db.adapter.createTable('uniq', {
            id: { type: 'integer', primaryKey: true },
            a: { type: 'text', compositeUnique: 'grp1' },
            b: { type: 'text', compositeUnique: 'grp1' },
        });
        expect(db.adapter.hasTable('uniq')).toBe(true);
    });

    it('creates table with default composite unique', async () => {
        await db.adapter.createTable('uniqd', {
            id: { type: 'integer', primaryKey: true },
            a: { type: 'text', compositeUnique: true },
            b: { type: 'text', compositeUnique: true },
        });
        expect(db.adapter.hasTable('uniqd')).toBe(true);
    });

    it('creates table with named individual index', async () => {
        await db.adapter.createTable('indexed', {
            id: { type: 'integer', primaryKey: true },
            name: { type: 'text', index: 'my_custom_idx' },
        });
        const idxs = db.adapter.indexes('indexed');
        expect(idxs.some(i => i.name === 'my_custom_idx')).toBe(true);
    });

    it('creates table with auto-generated index name', async () => {
        await db.adapter.createTable('indexed2', {
            id: { type: 'integer', primaryKey: true },
            email: { type: 'text', index: true },
        });
        const idxs = db.adapter.indexes('indexed2');
        expect(idxs.some(i => i.name === 'idx_indexed2_email')).toBe(true);
    });

    it('creates table with composite index', async () => {
        await db.adapter.createTable('cidx', {
            id: { type: 'integer', primaryKey: true },
            a: { type: 'text', compositeIndex: 'gi' },
            b: { type: 'text', compositeIndex: 'gi' },
        });
        const idxs = db.adapter.indexes('cidx');
        expect(idxs.some(i => i.name === 'idx_cidx_gi')).toBe(true);
    });

    it('creates table with default composite index group', async () => {
        await db.adapter.createTable('cidxd', {
            id: { type: 'integer', primaryKey: true },
            x: { type: 'text', compositeIndex: true },
            y: { type: 'text', compositeIndex: true },
        });
        const idxs = db.adapter.indexes('cidxd');
        expect(idxs.some(i => i.name === 'idx_cidxd_default')).toBe(true);
    });

    it('creates table with autoIncrement on primary key', async () => {
        await db.adapter.createTable('autoinc', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'text' },
        });
        db.adapter._db.exec("INSERT INTO autoinc (name) VALUES ('hello')");
        const row = db.adapter._db.prepare('SELECT * FROM autoinc').get();
        expect(row.id).toBe(1);
    });

    it('creates table with default value', async () => {
        await db.adapter.createTable('defaults', {
            id: { type: 'integer', primaryKey: true },
            status: { type: 'text', default: 'active' },
            count: { type: 'integer', default: 0 },
        });
        db.adapter._db.exec('INSERT INTO defaults (id) VALUES (1)');
        const row = db.adapter._db.prepare('SELECT * FROM defaults WHERE id = 1').get();
        expect(row.status).toBe('active');
        expect(row.count).toBe(0);
    });
});

// --- execute with all clauses ---------------------------------------------
describe('SQLite adapter — execute() branches', () => {
    beforeEach(async () => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, cat TEXT, val INTEGER)');
        db.adapter._db.exec("INSERT INTO items VALUES (1, 'a', 'x', 10), (2, 'b', 'x', 20), (3, 'c', 'y', 30)");
    });

    it('execute count action', async () => {
        const count = await db.adapter.execute({
            action: 'count',
            table: 'items',
            where: [],
            joins: [],
        });
        expect(count).toBe(3);
    });

    it('execute with distinct', async () => {
        const rows = await db.adapter.execute({
            table: 'items', fields: ['cat'], distinct: true,
            where: [], orderBy: [], joins: [],
        });
        expect(rows.length).toBe(2);
    });

    it('execute with groupBy and having', async () => {
        const rows = await db.adapter.execute({
            table: 'items', fields: ['cat'],
            where: [], orderBy: [], joins: [],
            groupBy: ['cat'],
            having: [{ field: 'val', op: '>', value: 0 }],
        });
        expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('execute with limit and offset', async () => {
        const rows = await db.adapter.execute({
            table: 'items', fields: [],
            where: [], orderBy: [{ field: 'id', dir: 'ASC' }],
            joins: [], limit: 1, offset: 1,
        });
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(2);
    });
});

// --- aggregate with where/groupBy/having ----------------------------------
describe('SQLite adapter — aggregate() branches', () => {
    beforeEach(() => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, cat TEXT, val INTEGER)');
        db.adapter._db.exec("INSERT INTO items VALUES (1, 'a', 10), (2, 'a', 20), (3, 'b', 30)");
    });

    it('aggregate with where clause', async () => {
        const sum = await db.adapter.aggregate({
            table: 'items', aggregateFn: 'sum', aggregateField: 'val',
            where: [{ field: 'cat', op: '=', value: 'a' }],
            joins: [],
        });
        expect(sum).toBe(30);
    });

    it('aggregate with groupBy and having', async () => {
        const result = await db.adapter.aggregate({
            table: 'items', aggregateFn: 'count', aggregateField: 'id',
            where: [], joins: [],
            groupBy: ['cat'],
            having: [{ field: 'val', op: '>', value: 0 }],
        });
        // Returns first result from group
        expect(result).toBeGreaterThanOrEqual(1);
    });

    it('aggregate returns null for empty table', async () => {
        db.adapter._db.exec('CREATE TABLE empty (id INTEGER, val INTEGER)');
        const result = await db.adapter.aggregate({
            table: 'empty', aggregateFn: 'max', aggregateField: 'val',
            where: [], joins: [],
        });
        expect(result).toBeNull();
    });
});

// --- addColumn with various options ---------------------------------------
describe('SQLite adapter — addColumn() branches', () => {
    beforeEach(async () => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    });

    it('addColumn with required', () => {
        db.adapter.addColumn('t', 'name', { type: 'text', required: true, default: 'anon' });
        const cols = db.adapter.columns('t');
        expect(cols.some(c => c.name === 'name' && c.notnull)).toBe(true);
    });

    it('addColumn with unique throws (SQLite limitation)', () => {
        expect(() => db.adapter.addColumn('t', 'email', { type: 'text', unique: true })).toThrow();
    });

    it('addColumn with check constraint', () => {
        db.adapter.addColumn('t', 'age', { type: 'integer', check: '"age" >= 0' });
        const cols = db.adapter.columns('t');
        expect(cols.some(c => c.name === 'age')).toBe(true);
    });

    it('addColumn with references and onDelete/onUpdate', () => {
        db.adapter._db.exec('CREATE TABLE refs (id INTEGER PRIMARY KEY)');
        db.adapter.addColumn('t', 'ref_id', {
            type: 'integer',
            references: { table: 'refs', column: 'id', onDelete: 'CASCADE', onUpdate: 'SET NULL' },
        });
        const cols = db.adapter.columns('t');
        expect(cols.some(c => c.name === 'ref_id')).toBe(true);
    });
});

// --- createIndex with unique ----------------------------------------------
describe('SQLite adapter — createIndex()', () => {
    beforeEach(() => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT, name TEXT)');
    });

    it('createIndex with unique option', () => {
        db.adapter.createIndex('t', ['email'], { unique: true });
        const idxs = db.adapter.indexes('t');
        const idx = idxs.find(i => i.columns.includes('email'));
        expect(idx).toBeDefined();
        expect(idx.unique).toBe(true);
    });

    it('createIndex with custom name', () => {
        db.adapter.createIndex('t', ['name'], { name: 'my_idx' });
        const idxs = db.adapter.indexes('t');
        expect(idxs.some(i => i.name === 'my_idx')).toBe(true);
    });
});

// --- Schema migration methods ---------------------------------------------
describe('SQLite adapter — schema migration methods', () => {
    beforeEach(() => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, old_name TEXT)');
    });

    it('renameColumn renames a column', () => {
        db.adapter.renameColumn('t', 'old_name', 'new_name');
        const cols = db.adapter.columns('t');
        expect(cols.some(c => c.name === 'new_name')).toBe(true);
    });

    it('renameTable renames a table', () => {
        db.adapter.renameTable('t', 'new_t');
        expect(db.adapter.hasTable('new_t')).toBe(true);
        expect(db.adapter.hasTable('t')).toBe(false);
    });

    it('dropColumn drops a column', () => {
        db.adapter.dropColumn('t', 'old_name');
        const cols = db.adapter.columns('t');
        expect(cols.some(c => c.name === 'old_name')).toBe(false);
    });

    it('dropIndex drops an index', () => {
        db.adapter._db.exec('CREATE INDEX idx_test ON t (old_name)');
        db.adapter.dropIndex('t', 'idx_test');
        const idxs = db.adapter.indexes('t');
        expect(idxs.some(i => i.name === 'idx_test')).toBe(false);
    });

    it('describeTable returns columns, indexes, foreignKeys', () => {
        const desc = db.adapter.describeTable('t');
        expect(desc.columns).toBeDefined();
        expect(desc.indexes).toBeDefined();
        expect(desc.foreignKeys).toBeDefined();
    });

    it('hasColumn returns true for existing column', () => {
        expect(db.adapter.hasColumn('t', 'old_name')).toBe(true);
    });

    it('hasColumn returns false for missing column', () => {
        expect(db.adapter.hasColumn('t', 'nothing')).toBe(false);
    });
});

// --- ping false path -----------------------------------------------------
describe('SQLite adapter — ping', () => {
    it('ping returns false after close', () => {
        db = Database.connect('sqlite');
        const adapter = db.adapter;
        adapter.close();
        expect(adapter.ping()).toBe(false);
        db = null; // already closed
    });
});

// --- insertMany empty array ----------------------------------------------
describe('SQLite adapter — insertMany', () => {
    it('returns empty array for empty input', async () => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
        const result = await db.adapter.insertMany('t', []);
        expect(result).toEqual([]);
    });
});

// --- overview formatting branches -----------------------------------------
describe('SQLite adapter — overview formatting', () => {
    it('formats size in GB', () => {
        db = Database.connect('sqlite');
        // Override fileSize to return large value
        const orig = db.adapter.fileSize.bind(db.adapter);
        db.adapter.fileSize = () => 2 * 1073741824; // 2 GB
        const ov = db.adapter.overview();
        expect(ov.fileSize).toContain('GB');
        db.adapter.fileSize = orig;
    });

    it('formats size in MB', () => {
        db = Database.connect('sqlite');
        db.adapter.fileSize = () => 5 * 1048576;
        const ov = db.adapter.overview();
        expect(ov.fileSize).toContain('MB');
    });

    it('formats size in KB', () => {
        db = Database.connect('sqlite');
        db.adapter.fileSize = () => 3 * 1024;
        const ov = db.adapter.overview();
        expect(ov.fileSize).toContain('KB');
    });

    it('formats size in B (default for memory)', () => {
        db = Database.connect('sqlite');
        const ov = db.adapter.overview();
        expect(ov.fileSize).toContain('B');
    });
});

// --- dropTable ------------------------------------------------------------
describe('SQLite adapter — dropTable', () => {
    it('drops an existing table', async () => {
        db = Database.connect('sqlite');
        db.adapter._db.exec('CREATE TABLE todrop (id INTEGER)');
        expect(db.adapter.hasTable('todrop')).toBe(true);
        await db.adapter.dropTable('todrop');
        expect(db.adapter.hasTable('todrop')).toBe(false);
    });
});
