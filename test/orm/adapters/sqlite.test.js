/**
 * Tests for the SQLite adapter — pragmas, utility methods, credential
 * validation, directory auto-creation, and full Model CRUD through SQLite.
 */
const fs   = require('fs');
const path = require('path');
const { Database, Model, TYPES } = require('../../../lib/orm');

// -- Helpers ---------------------------------------------

const TMP_DIR = path.join(__dirname, '.tmp-sqlite-tests');

function tmpFile(name)
{
    return path.join(TMP_DIR, name);
}

function cleanup()
{
    if (fs.existsSync(TMP_DIR))
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

// -- Test Model ------------------------------------------

class Item extends Model
{
    static table = 'items';
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING,  required: true },
        value: { type: TYPES.INTEGER, default: 0 },
    };
    static timestamps = true;
}

// -- Suite ------------------------------------------------

let db;

afterAll(() =>
{
    cleanup();
});

describe('SQLite adapter', () =>
{
    afterEach(async () =>
    {
        if (db) { await db.close(); db = null; }
        Item._adapter = null;
    });

    // -- Connection & directory --------------------------

    describe('connection', () =>
    {
        it('connects with an in-memory database', () =>
        {
            db = Database.connect('sqlite');
            expect(db.adapter).toBeDefined();
            expect(db.adapter._filename).toBe(':memory:');
        });

        it('auto-creates parent directories for the db file', () =>
        {
            cleanup();
            const nested = path.join(TMP_DIR, 'sub', 'dir', 'test.db');
            db = Database.connect('sqlite', { filename: nested });
            expect(fs.existsSync(path.dirname(nested))).toBe(true);
        });

        it('respects createDir: false', () =>
        {
            cleanup();
            const nested = path.join(TMP_DIR, 'no-create', 'test.db');
            expect(() => Database.connect('sqlite', { filename: nested, createDir: false }))
                .toThrow();
        });

        it('opens a file-based database with persistence', async () =>
        {
            cleanup();
            const file = tmpFile('persist.db');
            db = Database.connect('sqlite', { filename: file });
            db.register(Item);
            await db.sync();
            await Item.create({ name: 'persisted' });
            await db.close(); db = null;

            // Re-open and verify data persists
            db = Database.connect('sqlite', { filename: file });
            db.register(Item);
            const row = db.adapter.raw('SELECT * FROM items WHERE name = ?', 'persisted');
            expect(row).toHaveLength(1);
        });
    });

    // -- Pragmas -----------------------------------------

    describe('pragmas', () =>
    {
        it('applies WAL journal_mode by default', () =>
        {
            db = Database.connect('sqlite');
            const mode = db.adapter.pragma('journal_mode');
            expect(mode).toBe('memory'); // in-memory DBs report 'memory' for journal_mode
        });

        it('applies WAL for file-based databases', () =>
        {
            cleanup();
            const file = tmpFile('wal.db');
            db = Database.connect('sqlite', { filename: file });
            const mode = db.adapter.pragma('journal_mode');
            expect(mode).toBe('wal');
        });

        it('applies foreign_keys ON by default', () =>
        {
            db = Database.connect('sqlite');
            expect(db.adapter.pragma('foreign_keys')).toBe(1);
        });

        it('applies cache_size default', () =>
        {
            db = Database.connect('sqlite');
            expect(db.adapter.pragma('cache_size')).toBe(-64000);
        });

        it('applies custom pragmas', () =>
        {
            db = Database.connect('sqlite', {
                pragmas: { cache_size: '-32000' },
            });
            expect(db.adapter.pragma('cache_size')).toBe(-32000);
        });

        it('applies temp_store MEMORY by default', () =>
        {
            db = Database.connect('sqlite');
            // temp_store: 0=DEFAULT, 1=FILE, 2=MEMORY
            expect(db.adapter.pragma('temp_store')).toBe(2);
        });
    });

    // -- Type Mapping ------------------------------------

    describe('expanded _typeMap', () =>
    {
        it('maps extended types correctly', () =>
        {
            db = Database.connect('sqlite');
            const adapter = db.adapter;
            expect(adapter._typeMap({ type: 'bigint' })).toBe('INTEGER');
            expect(adapter._typeMap({ type: 'smallint' })).toBe('INTEGER');
            expect(adapter._typeMap({ type: 'tinyint' })).toBe('INTEGER');
            expect(adapter._typeMap({ type: 'decimal' })).toBe('REAL');
            expect(adapter._typeMap({ type: 'double' })).toBe('REAL');
            expect(adapter._typeMap({ type: 'real' })).toBe('REAL');
            expect(adapter._typeMap({ type: 'timestamp' })).toBe('TEXT');
            expect(adapter._typeMap({ type: 'time' })).toBe('TEXT');
            expect(adapter._typeMap({ type: 'binary' })).toBe('BLOB');
            expect(adapter._typeMap({ type: 'varbinary' })).toBe('BLOB');
            expect(adapter._typeMap({ type: 'char' })).toBe('TEXT');
            expect(adapter._typeMap({ type: 'varchar' })).toBe('TEXT');
            expect(adapter._typeMap({ type: 'numeric' })).toBe('NUMERIC');
        });
    });

    // -- Utilities ---------------------------------------

    describe('utility methods', () =>
    {
        it('checkpoint() runs without error (file db)', () =>
        {
            cleanup();
            const file = tmpFile('cp.db');
            db = Database.connect('sqlite', { filename: file });
            const result = db.adapter.checkpoint('PASSIVE');
            expect(result).toBeDefined();
        });

        it('checkpoint() rejects invalid mode', () =>
        {
            db = Database.connect('sqlite');
            expect(() => db.adapter.checkpoint('DROP')).toThrow(/Invalid checkpoint mode/);
        });

        it('integrity() returns ok', () =>
        {
            db = Database.connect('sqlite');
            expect(db.adapter.integrity()).toBe('ok');
        });

        it('vacuum() runs without error', () =>
        {
            db = Database.connect('sqlite');
            expect(() => db.adapter.vacuum()).not.toThrow();
        });

        it('fileSize() returns 0 for memory db', () =>
        {
            db = Database.connect('sqlite');
            expect(db.adapter.fileSize()).toBe(0);
        });

        it('fileSize() returns positive for file db', async () =>
        {
            cleanup();
            const file = tmpFile('size.db');
            db = Database.connect('sqlite', { filename: file });
            db.register(Item);
            await db.sync();
            await Item.create({ name: 'test' });
            expect(db.adapter.fileSize()).toBeGreaterThan(0);
        });

        it('tables() lists created tables', async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
            expect(db.adapter.tables()).toContain('items');
        });

        it('tables() returns empty array on fresh db', () =>
        {
            db = Database.connect('sqlite');
            expect(db.adapter.tables()).toEqual([]);
        });

        it('columns() returns column info', async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
            const cols = db.adapter.columns('items');
            expect(cols.length).toBeGreaterThan(0);
            const idCol = cols.find(c => c.name === 'id');
            expect(idCol).toBeDefined();
            expect(idCol.pk).toBe(true);
        });

        it('indexes() returns index info', async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
            // SQLite may or may not have indexes; just verifying the method works
            const idxs = db.adapter.indexes('items');
            expect(Array.isArray(idxs)).toBe(true);
        });

        it('foreignKeys() returns an array', async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
            const fks = db.adapter.foreignKeys('items');
            expect(Array.isArray(fks)).toBe(true);
        });

        it('tableStatus() returns row counts', async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
            await Item.create({ name: 'one' });
            await Item.create({ name: 'two' });
            const status = db.adapter.tableStatus('items');
            expect(status).toHaveLength(1);
            expect(status[0].name).toBe('items');
            expect(status[0].rows).toBe(2);
        });

        it('tableStatus() without argument returns all tables', async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
            const status = db.adapter.tableStatus();
            expect(status.length).toBeGreaterThanOrEqual(1);
        });

        it('overview() summarises the database', async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
            await Item.create({ name: 'x' });
            const ov = db.adapter.overview();
            expect(ov.tables).toBeDefined();
            expect(ov.totalRows).toBeGreaterThanOrEqual(1);
            expect(typeof ov.fileSize).toBe('string');
        });

        it('pageInfo() returns page statistics', () =>
        {
            db = Database.connect('sqlite');
            const info = db.adapter.pageInfo();
            expect(info.pageSize).toBeGreaterThan(0);
            expect(typeof info.pageCount).toBe('number');
            expect(typeof info.totalBytes).toBe('number');
        });

        it('compileOptions() returns an array of strings', () =>
        {
            db = Database.connect('sqlite');
            const opts = db.adapter.compileOptions();
            expect(Array.isArray(opts)).toBe(true);
            expect(opts.length).toBeGreaterThan(0);
        });

        it('cacheStatus() returns cached/max counts', () =>
        {
            db = Database.connect('sqlite');
            const status = db.adapter.cacheStatus();
            expect(typeof status.cached).toBe('number');
            expect(status.max).toBe(256);
        });
    });

    // -- Full Model CRUD through SQLite --------------------

    describe('Model CRUD', () =>
    {
        beforeEach(async () =>
        {
            db = Database.connect('sqlite');
            db.register(Item);
            await db.sync();
        });

        it('create() inserts and returns with id', async () =>
        {
            const item = await Item.create({ name: 'alpha', value: 10 });
            expect(item.id).toBeDefined();
            expect(item.name).toBe('alpha');
        });

        it('findById() retrieves a record', async () =>
        {
            const created = await Item.create({ name: 'beta' });
            const found = await Item.findById(created.id);
            expect(found.name).toBe('beta');
        });

        it('find() returns multiple records', async () =>
        {
            await Item.create({ name: 'a' });
            await Item.create({ name: 'b' });
            const all = await Item.find();
            expect(all.length).toBe(2);
        });

        it('update via save()', async () =>
        {
            const item = await Item.create({ name: 'old' });
            item.name = 'new';
            await item.save();
            const found = await Item.findById(item.id);
            expect(found.name).toBe('new');
        });

        it('delete()', async () =>
        {
            const item = await Item.create({ name: 'del' });
            await item.delete();
            const found = await Item.findById(item.id);
            expect(found).toBeNull();
        });

        it('count()', async () =>
        {
            await Item.create({ name: 'a' });
            await Item.create({ name: 'b' });
            expect(await Item.count()).toBe(2);
        });

        it('updateWhere()', async () =>
        {
            await Item.create({ name: 'x', value: 1 });
            await Item.create({ name: 'y', value: 1 });
            const changed = await Item.updateWhere({ value: 1 }, { value: 99 });
            expect(changed).toBe(2);
        });

        it('deleteWhere()', async () =>
        {
            await Item.create({ name: 'a', value: 5 });
            await Item.create({ name: 'b', value: 5 });
            const removed = await Item.deleteWhere({ value: 5 });
            expect(removed).toBe(2);
            expect(await Item.count()).toBe(0);
        });

        it('raw() SQL works', async () =>
        {
            await Item.create({ name: 'raw', value: 42 });
            const rows = db.adapter.raw('SELECT * FROM items WHERE name = ?', 'raw');
            expect(rows[0].value).toBe(42);
        });

        it('transaction commits on success', async () =>
        {
            db.adapter.transaction(() =>
            {
                db.adapter._db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('tx1', 1);
                db.adapter._db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('tx2', 2);
            });
            const all = await Item.find();
            expect(all.length).toBe(2);
        });

        it('transaction rolls back on error', async () =>
        {
            expect(() =>
            {
                db.adapter.transaction(() =>
                {
                    db.adapter._db.prepare('INSERT INTO items (name, value) VALUES (?, ?)').run('tx1', 1);
                    throw new Error('rollback');
                });
            }).toThrow('rollback');
            expect(await Item.count()).toBe(0);
        });
    });

    // -- Read-only mode ----------------------------------

    describe('readonly mode', () =>
    {
        it('readonly db cannot write', async () =>
        {
            cleanup();
            const file = tmpFile('readonly.db');
            // Create and populate first
            let writable = Database.connect('sqlite', { filename: file });
            writable.register(Item);
            await Item.sync();
            await Item.create({ name: 'seed' });
            writable.close();
            Item._adapter = null;

            // Open readonly
            db = Database.connect('sqlite', { filename: file, readonly: true });
            const rows = db.adapter.raw('SELECT * FROM items');
            expect(rows.length).toBe(1);

            expect(() => db.adapter.raw('INSERT INTO items (name) VALUES (?)', 'fail'))
                .toThrow();
        });
    });
});

// -- Credential Validation -------------------------------

describe('Database credential validation', () =>
{
    it('rejects non-string host for mysql', () =>
    {
        expect(() => Database.connect('mysql', { host: 123 })).toThrow(/"host" must be a non-empty string/);
    });

    it('rejects empty host for postgres', () =>
    {
        expect(() => Database.connect('postgres', { host: '  ' })).toThrow(/"host" must be a non-empty string/);
    });

    it('rejects out-of-range port', () =>
    {
        expect(() => Database.connect('mysql', { port: 99999 })).toThrow(/"port" must be an integer 1-65535/);
    });

    it('rejects non-integer port', () =>
    {
        expect(() => Database.connect('postgres', { port: 'abc' })).toThrow(/"port" must be an integer 1-65535/);
    });

    it('rejects non-string user', () =>
    {
        expect(() => Database.connect('mysql', { user: 42 })).toThrow(/"user" must be a string/);
    });

    it('rejects non-string password', () =>
    {
        expect(() => Database.connect('postgres', { password: 42 })).toThrow(/"password" must be a string/);
    });

    it('rejects empty database name', () =>
    {
        expect(() => Database.connect('mysql', { database: '' })).toThrow(/"database" must be a non-empty string/);
    });

    it('rejects non-string mongo url', () =>
    {
        expect(() => Database.connect('mongo', { url: 123 })).toThrow(/"url" must be a non-empty string/);
    });

    it('rejects non-string sqlite filename', () =>
    {
        expect(() => Database.connect('sqlite', { filename: 123 })).toThrow(/"filename" must be a string/);
    });

    it('allows valid options to pass through (sqlite)', () =>
    {
        const db = Database.connect('sqlite', { filename: ':memory:' });
        expect(db).toBeDefined();
        db.close();
    });
});
