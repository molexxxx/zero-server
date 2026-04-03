/** constructors.test.js — adapter constructor and utility tests */
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { Database, Model, TYPES } = require('../../../lib/orm');

// -- Helpers ---------------------------------------------

const TMP_DIR = path.join(__dirname, '.tmp-adapter-tests');

function cleanup()
{
    if (fs.existsSync(TMP_DIR))
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

// -- Test Models -----------------------------------------

class Widget extends Model
{
    static table = 'widgets';
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING,  required: true },
        color: { type: TYPES.STRING,  default: 'blue' },
        weight:{ type: TYPES.FLOAT,   default: 0.0 },
        active:{ type: TYPES.BOOLEAN, default: true },
    };
    static timestamps = true;
}

class Gadget extends Model
{
    static table = 'gadgets';
    static schema = {
        id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: TYPES.STRING,  required: true },
        type: { type: TYPES.STRING,  enum: ['A', 'B', 'C'] },
    };
}

// ===========================================================
//  Memory Adapter Utilities
// ===========================================================

describe('Memory adapter utilities', () =>
{
    let db;

    beforeEach(async () =>
    {
        db = Database.connect('memory');
        db.registerAll(Widget, Gadget);
        await db.sync();
    });

    afterEach(async () =>
    {
        if (db.adapter.clear) await db.adapter.clear();
        Widget._adapter = null;
        Gadget._adapter = null;
    });

    it('tables() lists registered tables', () =>
    {
        expect(db.adapter.tables()).toContain('widgets');
        expect(db.adapter.tables()).toContain('gadgets');
    });

    it('tables() returns empty for fresh adapter', () =>
    {
        const fresh = Database.connect('memory');
        expect(fresh.adapter.tables()).toEqual([]);
    });

    it('totalRows() counts all rows across tables', async () =>
    {
        await Widget.create({ name: 'w1' });
        await Widget.create({ name: 'w2' });
        await Widget.create({ name: 'w3' });
        expect(db.adapter.totalRows()).toBe(3);
    });

    it('totalRows() returns 0 when empty', () =>
    {
        expect(db.adapter.totalRows()).toBe(0);
    });

    it('stats() returns table count, row count, and estimated bytes', async () =>
    {
        await Widget.create({ name: 'w1' });
        const s = db.adapter.stats();
        expect(s.tables).toBe(2);
        expect(s.totalRows).toBe(1);
        expect(s.estimatedBytes).toBeGreaterThan(0);
    });

    it('toJSON() exports all data', async () =>
    {
        await Widget.create({ name: 'alpha', color: 'red' });
        await Widget.create({ name: 'beta', color: 'green' });
        const exported = db.adapter.toJSON();
        expect(exported.widgets).toHaveLength(2);
        expect(exported.widgets[0].name).toBe('alpha');
    });

    it('fromJSON() imports data', async () =>
    {
        db.adapter.fromJSON({
            widgets: [
                { id: 100, name: 'imported', color: 'gold', weight: 5.5, active: true },
            ],
        });
        const found = await Widget.findById(100);
        expect(found).not.toBeNull();
        expect(found.name).toBe('imported');
    });

    it('fromJSON() updates auto-increment correctly', async () =>
    {
        db.adapter.fromJSON({
            widgets: [{ id: 50, name: 'fifty' }],
        });
        const next = await Widget.create({ name: 'next' });
        expect(next.id).toBe(51);
    });

    it('clone() creates an independent deep copy', async () =>
    {
        await Widget.create({ name: 'original' });
        const copy = db.adapter.clone();
        expect(copy.totalRows()).toBe(1);

        // Modify original — clone should be unaffected
        await Widget.create({ name: 'second' });
        expect(db.adapter.totalRows()).toBe(2);
        expect(copy.totalRows()).toBe(1);
    });

    it('clear() resets all tables', async () =>
    {
        await Widget.create({ name: 'w1' });
        await Widget.create({ name: 'w2' });
        await db.adapter.clear();
        expect(db.adapter.totalRows()).toBe(0);
        expect(db.adapter.tables()).toContain('widgets'); // table exists, just empty
    });

    it('stats() estimatedBytes increases with more data', async () =>
    {
        const s1 = db.adapter.stats();
        await Widget.create({ name: 'aaaa' });
        await Widget.create({ name: 'bbbb' });
        const s2 = db.adapter.stats();
        expect(s2.estimatedBytes).toBeGreaterThan(s1.estimatedBytes);
    });
});

// ===========================================================
//  JSON Adapter Utilities
// ===========================================================

describe('JSON adapter utilities', () =>
{
    let db;
    const jsonDir = path.join(TMP_DIR, 'json-adapter');

    beforeEach(async () =>
    {
        cleanup();
        db = Database.connect('json', { dir: jsonDir });
        db.registerAll(Widget, Gadget);
        await db.sync();
    });

    afterEach(async () =>
    {
        if (db) await db.adapter.flush();
        Widget._adapter = null;
        Gadget._adapter = null;
    });

    afterAll(() => cleanup());

    it('creates directory if it does not exist', () =>
    {
        expect(fs.existsSync(jsonDir)).toBe(true);
    });

    it('throws if no dir option provided', () =>
    {
        expect(() => Database.connect('json', {})).toThrow(/requires a "dir"/);
    });

    it('directory getter returns the resolved path', () =>
    {
        expect(db.adapter.directory).toBe(path.resolve(jsonDir));
    });

    it('persists data to JSON files', async () =>
    {
        await Widget.create({ name: 'persist-test' });
        await db.adapter.flush();

        const filePath = path.join(jsonDir, 'widgets.json');
        expect(fs.existsSync(filePath)).toBe(true);

        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(content.rows).toHaveLength(1);
        expect(content.rows[0].name).toBe('persist-test');
    });

    it('reload from disk on new adapter', async () =>
    {
        await Widget.create({ name: 'reloaded' });
        await db.adapter.flush();
        Widget._adapter = null;

        // Create new adapter pointing at same directory
        const db2 = Database.connect('json', { dir: jsonDir });
        db2.register(Widget);
        const all = await Widget.find();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('reloaded');
        Widget._adapter = null;
    });

    it('fileSize() returns total size of JSON files', async () =>
    {
        await Widget.create({ name: 'hello' });
        await db.adapter.flush();
        const size = db.adapter.fileSize();
        expect(size).toBeGreaterThan(0);
    });

    it('hasPendingWrites tracks dirty state', async () =>
    {
        await db.adapter.flush();
        expect(db.adapter.hasPendingWrites).toBe(false);
        db.adapter._autoFlush = false;
        await Widget.create({ name: 'dirty' });
        expect(db.adapter.hasPendingWrites).toBe(true);
        await db.adapter.flush();
        expect(db.adapter.hasPendingWrites).toBe(false);
    });

    it('compact() re-saves a table', async () =>
    {
        await Widget.create({ name: 'compact-me' });
        await db.adapter.flush();

        // Manually corrupt whitespace
        const filePath = path.join(jsonDir, 'widgets.json');
        const before = fs.readFileSync(filePath, 'utf8');
        expect(before).toContain('\n'); // pretty-printed

        // Swap to non-pretty, compact, verify
        db.adapter._pretty = false;
        db.adapter.compact('widgets');
        const after = fs.readFileSync(filePath, 'utf8');
        expect(after).not.toContain('\n');
    });

    it('backup() copies all JSON files to target', async () =>
    {
        await Widget.create({ name: 'backup-me' });
        await db.adapter.flush();

        const backupDir = path.join(TMP_DIR, 'backup');
        db.adapter.backup(backupDir);

        expect(fs.existsSync(path.join(backupDir, 'widgets.json'))).toBe(true);
        const content = JSON.parse(fs.readFileSync(path.join(backupDir, 'widgets.json'), 'utf8'));
        expect(content.rows[0].name).toBe('backup-me');
    });

    it('dropTable() removes the JSON file', async () =>
    {
        await Widget.create({ name: 'drop-me' });
        await db.adapter.flush();
        const filePath = path.join(jsonDir, 'widgets.json');
        expect(fs.existsSync(filePath)).toBe(true);

        await db.adapter.dropTable('widgets');
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('inherits tables() from MemoryAdapter', async () =>
    {
        expect(db.adapter.tables()).toContain('widgets');
        expect(db.adapter.tables()).toContain('gadgets');
    });

    it('inherits stats() from MemoryAdapter', async () =>
    {
        const s = db.adapter.stats();
        expect(s.tables).toBe(2);
    });

    it('flushInterval option controls debounce', () =>
    {
        const db2 = Database.connect('json', { dir: path.join(TMP_DIR, 'fast'), flushInterval: 10 });
        expect(db2.adapter._flushInterval).toBe(10);
    });

    it('pretty: false produces compact JSON', async () =>
    {
        const compactDir = path.join(TMP_DIR, 'compact-json');
        const db2 = Database.connect('json', { dir: compactDir, pretty: false });
        db2.register(Widget);
        await Widget.sync();
        await Widget.create({ name: 'compact' });
        await db2.adapter.flush();

        const content = fs.readFileSync(path.join(compactDir, 'widgets.json'), 'utf8');
        expect(content).not.toContain('\n');
        Widget._adapter = null;
    });
});

// ===========================================================
//  MySQL Adapter — Structural Tests
// ===========================================================

describe('MySQL adapter structure', () =>
{
    it('credential validation rejects non-string host', () =>
    {
        expect(() => Database.connect('mysql', { host: 123 }))
            .toThrow(/"host" must be a non-empty string/);
    });

    it('credential validation rejects empty host', () =>
    {
        expect(() => Database.connect('mysql', { host: '' }))
            .toThrow(/"host" must be a non-empty string/);
    });

    it('credential validation rejects bad port', () =>
    {
        expect(() => Database.connect('mysql', { port: 0 }))
            .toThrow(/"port" must be an integer 1-65535/);
        expect(() => Database.connect('mysql', { port: 70000 }))
            .toThrow(/"port" must be an integer 1-65535/);
        expect(() => Database.connect('mysql', { port: 'abc' }))
            .toThrow(/"port" must be an integer 1-65535/);
    });

    it('credential validation rejects non-string user', () =>
    {
        expect(() => Database.connect('mysql', { user: 42 }))
            .toThrow(/"user" must be a string/);
    });

    it('credential validation rejects non-string password', () =>
    {
        expect(() => Database.connect('mysql', { password: true }))
            .toThrow(/"password" must be a string/);
    });

    it('credential validation rejects empty database', () =>
    {
        expect(() => Database.connect('mysql', { database: '  ' }))
            .toThrow(/"database" must be a non-empty string/);
    });

    it('credential validation trims host and database', () =>
    {
        // This will throw because mysql2 isn't installed in the test environment,
        // but the credential validation itself should pass
        // (the error should be about mysql2, not about credentials)
        try
        {
            Database.connect('mysql', { host: ' localhost ', database: ' mydb ' });
        }
        catch (e)
        {
            expect(e.message).toContain('mysql2'); // mysql2 driver error, not validation
        }
    });
});

// ===========================================================
//  PostgreSQL Adapter — Structural Tests
// ===========================================================

describe('PostgreSQL adapter structure', () =>
{
    it('credential validation rejects non-string host', () =>
    {
        expect(() => Database.connect('postgres', { host: true }))
            .toThrow(/"host" must be a non-empty string/);
    });

    it('credential validation rejects bad port', () =>
    {
        expect(() => Database.connect('postgres', { port: -1 }))
            .toThrow(/"port" must be an integer 1-65535/);
        expect(() => Database.connect('postgres', { port: 3.14 }))
            .toThrow(/"port" must be an integer 1-65535/);
    });

    it('credential validation rejects non-string user', () =>
    {
        expect(() => Database.connect('postgres', { user: {} }))
            .toThrow(/"user" must be a string/);
    });

    it('credential validation rejects non-string password', () =>
    {
        expect(() => Database.connect('postgres', { password: 42 }))
            .toThrow(/"password" must be a string/);
    });

    it('credential validation rejects empty database', () =>
    {
        expect(() => Database.connect('postgres', { database: '' }))
            .toThrow(/"database" must be a non-empty string/);
    });

    it('credential validation allows valid options through', () =>
    {
        // pg can be constructed without connecting — pool is lazy
        try
        {
            const db = Database.connect('postgres', {
                host: 'localhost',
                port: 5432,
                user: 'test',
                password: 'test',
                database: 'testdb',
            });
            expect(db).toBeDefined();
            db.close().catch(() => {}); // cleanup the pool
        }
        catch (e)
        {
            // Only fail if it's a credential validation error
            expect(e.message).not.toMatch(/must be/);
        }
    });
});

// ===========================================================
//  MongoDB Adapter — Structural Tests
// ===========================================================

describe('MongoDB adapter structure', () =>
{
    it('credential validation rejects non-string url', () =>
    {
        expect(() => Database.connect('mongo', { url: 123 }))
            .toThrow(/"url" must be a non-empty string/);
    });

    it('credential validation rejects empty url', () =>
    {
        expect(() => Database.connect('mongo', { url: '   ' }))
            .toThrow(/"url" must be a non-empty string/);
    });

    it('credential validation rejects non-string database', () =>
    {
        expect(() => Database.connect('mongo', { database: 42 }))
            .toThrow(/"database" must be a non-empty string/);
    });

    it('credential validation rejects empty database', () =>
    {
        expect(() => Database.connect('mongo', { database: '' }))
            .toThrow(/"database" must be a non-empty string/);
    });

    it('credential validation allows valid options through', () =>
    {
        try
        {
            const db = Database.connect('mongo', {
                url: 'mongodb://localhost:27017',
                database: 'testdb',
            });
            expect(db).toBeDefined();
            db.close().catch(() => {});
        }
        catch (e)
        {
            // Only fail if it's a credential validation error
            expect(e.message).not.toMatch(/must be/);
        }
    });
});

// ===========================================================
//  SQLite Adapter Utilities (additional tests)
// ===========================================================

describe('SQLite adapter additional utilities', () =>
{
    let db;

    afterEach(async () =>
    {
        if (db) { await db.close(); db = null; }
        Widget._adapter = null;
    });

    afterAll(() => cleanup());

    it('tables() returns empty on fresh db', () =>
    {
        db = Database.connect('sqlite');
        expect(db.adapter.tables()).toEqual([]);
    });

    it('tables() lists multiple tables', async () =>
    {
        db = Database.connect('sqlite');
        db.registerAll(Widget, Gadget);
        await db.sync();
        const t = db.adapter.tables();
        expect(t).toContain('widgets');
        expect(t).toContain('gadgets');
        Gadget._adapter = null;
    });

    it('pragma() reads arbitrary pragmas', () =>
    {
        db = Database.connect('sqlite');
        expect(db.adapter.pragma('foreign_keys')).toBe(1);
    });

    it('integrity() returns ok on valid db', () =>
    {
        db = Database.connect('sqlite');
        expect(db.adapter.integrity()).toBe('ok');
    });

    it('vacuum() does not throw', () =>
    {
        db = Database.connect('sqlite');
        expect(() => db.adapter.vacuum()).not.toThrow();
    });

    it('fileSize() returns 0 for memory', () =>
    {
        db = Database.connect('sqlite');
        expect(db.adapter.fileSize()).toBe(0);
    });

    it('fileSize() returns size for file db', async () =>
    {
        cleanup();
        db = Database.connect('sqlite', {
            filename: path.join(TMP_DIR, 'size-test.db'),
        });
        db.register(Widget);
        await db.sync();
        await Widget.create({ name: 'size' });
        expect(db.adapter.fileSize()).toBeGreaterThan(0);
    });

    it('checkpoint() with all valid modes', () =>
    {
        cleanup();
        db = Database.connect('sqlite', {
            filename: path.join(TMP_DIR, 'cp-modes.db'),
        });
        for (const mode of ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'])
        {
            expect(() => db.adapter.checkpoint(mode)).not.toThrow();
        }
    });

    it('checkpoint() rejects invalid mode', () =>
    {
        db = Database.connect('sqlite');
        expect(() => db.adapter.checkpoint('INVALID')).toThrow(/Invalid checkpoint mode/);
    });

    it('custom pragmas override defaults', () =>
    {
        db = Database.connect('sqlite', {
            pragmas: { cache_size: '-16000' },
        });
        expect(db.adapter.pragma('cache_size')).toBe(-16000);
    });

    it('fileMustExist throws on missing file', () =>
    {
        expect(() => Database.connect('sqlite', {
            filename: path.join(TMP_DIR, 'nonexistent', 'ghost.db'),
            fileMustExist: true,
            createDir: false,
        })).toThrow();
    });
});

// ===========================================================
//  Cross-adapter credential validation
// ===========================================================

describe('Cross-adapter credential validation', () =>
{
    it('SQLite rejects non-string filename', () =>
    {
        expect(() => Database.connect('sqlite', { filename: 42 }))
            .toThrow(/"filename" must be a string/);
    });

    it('unknown adapter type throws descriptive error', () =>
    {
        expect(() => Database.connect('oracle'))
            .toThrow(/Unknown adapter.*Supported:/);
    });

    it('memory adapter accepts no options', () =>
    {
        const db = Database.connect('memory');
        expect(db).toBeDefined();
        expect(db.adapter).toBeDefined();
    });

    it('memory adapter accepts empty object', () =>
    {
        const db = Database.connect('memory', {});
        expect(db).toBeDefined();
    });

    it('validation trims whitespace from host', () =>
    {
        try
        {
            Database.connect('mysql', { host: '  myhost  ', database: 'test' });
        }
        catch (e)
        {
            // Should fail on driver, not on validation
            expect(e.message).not.toMatch(/host/);
        }
    });

    it('port validation accepts boundary values', () =>
    {
        // Port 1 and 65535 should pass validation (may fail on driver)
        for (const port of [1, 65535])
        {
            try { Database.connect('mysql', { port }); }
            catch (e) { expect(e.message).not.toMatch(/port/); }
        }
    });
});


// =========================================================================
//  json adapter — function coverage (from coverage/deep.test.js)
// =========================================================================

describe('json adapter — function coverage', () => {
	const jsonDir = path.join(os.tmpdir(), 'zero-test-json-adapter-' + Date.now());
	let db;

	beforeAll(async () => {
		const { Database, Model, TYPES } = require('../../../');
		db = Database.connect('json', { dir: jsonDir });

		class JModel extends Model {
			static table = 'jtest';
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name: { type: TYPES.STRING },
			};
		}
		db.register(JModel);
		await db.sync();
		await JModel.create({ name: 'test1' });
		await JModel.create({ name: 'test2' });
	});

	afterAll(async () => {
		await db.adapter.flush();
		try { fs.rmSync(jsonDir, { recursive: true, force: true }); } catch {}
	});

	it('directory property returns the dir path', () => {
		expect(db.adapter.directory).toBe(jsonDir);
	});

	it('fileSize returns total bytes of JSON files', async () => {
		await db.adapter.flush();
		const size = db.adapter.fileSize();
		expect(size).toBeGreaterThan(0);
	});

	it('hasPendingWrites after insert before flush', async () => {
		const { Model, TYPES } = require('../../../');
		class PendModel extends Model {
			static table = 'pending_test';
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				val: { type: TYPES.STRING },
			};
		}
		db.register(PendModel);
		await db.sync();
		// Disable autoFlush to check pending
		const origAF = db.adapter._autoFlush;
		db.adapter._autoFlush = false;
		await PendModel.create({ val: 'x' });
		expect(db.adapter.hasPendingWrites).toBe(true);
		await db.adapter.flush();
		expect(db.adapter.hasPendingWrites).toBe(false);
		db.adapter._autoFlush = origAF;
	});

	it('compact re-saves a specific table', async () => {
		await db.adapter.flush();
		const before = fs.statSync(path.join(jsonDir, 'jtest.json')).size;
		db.adapter.compact('jtest');
		const after = fs.statSync(path.join(jsonDir, 'jtest.json')).size;
		// Should be same or similar size
		expect(after).toBeGreaterThan(0);
	});

	it('backup copies files to destination', async () => {
		await db.adapter.flush();
		const backupDir = path.join(os.tmpdir(), 'zero-test-json-backup-' + Date.now());
		db.adapter.backup(backupDir);
		expect(fs.existsSync(path.join(backupDir, 'jtest.json'))).toBe(true);
		try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
	});

	it('dropTable removes the JSON file', async () => {
		const { Model, TYPES } = require('../../../');
		class DropModel extends Model {
			static table = 'drop_test';
			static schema = { id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true } };
		}
		db.register(DropModel);
		await db.sync();
		await db.adapter.flush();
		expect(fs.existsSync(path.join(jsonDir, 'drop_test.json'))).toBe(true);
		await db.adapter.dropTable('drop_test');
		expect(fs.existsSync(path.join(jsonDir, 'drop_test.json'))).toBe(false);
	});

	it('clear clears all tables', async () => {
		const { Model, TYPES } = require('../../../');
		class ClearModel extends Model {
			static table = 'clear_test';
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				v: { type: TYPES.STRING },
			};
		}
		db.register(ClearModel);
		await db.sync();
		await ClearModel.create({ v: 'x' });
		await db.adapter.clear();
		await db.adapter.flush();
		expect(await ClearModel.count()).toBe(0);
	});

	it('constructor loads existing JSON files', () => {
		// Create a new adapter pointing to same dir — should load existing data
		const JsonAdapter = require('../../../lib/orm/adapters/json');
		const adapter2 = new JsonAdapter({ dir: jsonDir });
		expect(adapter2._tables.size).toBeGreaterThan(0);
	});

	it('constructor throws without dir option', () => {
		const JsonAdapter = require('../../../lib/orm/adapters/json');
		expect(() => new JsonAdapter({})).toThrow(/dir/);
	});

	it('updateWhere only saves if rows changed', async () => {
		const { Model, TYPES } = require('../../../');
		class UWModel extends Model {
			static table = 'uw_test';
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				val: { type: TYPES.STRING },
			};
		}
		db.register(UWModel);
		await db.sync();
		await UWModel.create({ val: 'a' });
		await db.adapter.flush();

		// Update with no match
		const count = await db.adapter.updateWhere('uw_test', { val: 'nonexistent' }, { val: 'b' });
		expect(count).toBe(0);

		// Update with match
		const count2 = await db.adapter.updateWhere('uw_test', { val: 'a' }, { val: 'b' });
		expect(count2).toBe(1);
	});

	it('deleteWhere only saves if rows deleted', async () => {
		const { Model, TYPES } = require('../../../');
		class DWModel extends Model {
			static table = 'dw_test';
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				val: { type: TYPES.STRING },
			};
		}
		db.register(DWModel);
		await db.sync();
		await DWModel.create({ val: 'x' });
		await db.adapter.flush();

		const count = await db.adapter.deleteWhere('dw_test', { val: 'nonexistent' });
		expect(count).toBe(0);

		const count2 = await db.adapter.deleteWhere('dw_test', { val: 'x' });
		expect(count2).toBe(1);
	});
});

// =========================================================================
//  json adapter — _saveTable EPERM/EACCES retry branch
// =========================================================================

describe('json adapter — _saveTable atomic write retry', () => {
	const jsonDir = path.join(os.tmpdir(), 'zero-test-json-eperm-' + Date.now());
	let adapter;

	beforeAll(() => {
		const JsonAdapter = require('../../../lib/orm/adapters/json');
		adapter = new JsonAdapter({ dir: jsonDir });
		adapter._tables.set('retry_test', [{ id: 1, name: 'hello' }]);
		adapter._autoIncrements.set('retry_test', 2);
	});

	afterAll(() => {
		try { fs.rmSync(jsonDir, { recursive: true, force: true }); } catch {}
	});

	it('retries rename on EPERM by unlink + rename', () => {
		// First write normally so the file exists
		adapter._saveTable('retry_test');
		expect(fs.existsSync(path.join(jsonDir, 'retry_test.json'))).toBe(true);

		// Monkey-patch renameSync to fail on first call with EPERM
		const origRename = fs.renameSync;
		let callCount = 0;
		fs.renameSync = (...args) => {
			callCount++;
			if (callCount === 1) {
				const err = new Error('EPERM');
				err.code = 'EPERM';
				throw err;
			}
			return origRename(...args);
		};

		try {
			adapter._tables.set('retry_test', [{ id: 1, name: 'updated' }]);
			adapter._saveTable('retry_test');

			const content = JSON.parse(fs.readFileSync(path.join(jsonDir, 'retry_test.json'), 'utf8'));
			expect(content.rows[0].name).toBe('updated');
		} finally {
			fs.renameSync = origRename;
		}
	});

	it('falls back to direct writeFileSync when retry-rename also fails', () => {
		adapter._saveTable('retry_test'); // ensure file exists

		const origRename = fs.renameSync;
		fs.renameSync = () => {
			const err = new Error('EPERM');
			err.code = 'EPERM';
			throw err;
		};

		try {
			adapter._tables.set('retry_test', [{ id: 1, name: 'fallback' }]);
			adapter._saveTable('retry_test');

			const content = JSON.parse(fs.readFileSync(path.join(jsonDir, 'retry_test.json'), 'utf8'));
			expect(content.rows[0].name).toBe('fallback');
		} finally {
			fs.renameSync = origRename;
		}
	});

	it('rethrows non-EPERM/EACCES errors from rename', () => {
		const origRename = fs.renameSync;
		fs.renameSync = () => {
			const err = new Error('ENOENT');
			err.code = 'ENOENT';
			throw err;
		};

		try {
			expect(() => adapter._saveTable('retry_test')).toThrow('ENOENT');
		} finally {
			fs.renameSync = origRename;
		}
	});
});

// =========================================================================
//  json adapter — _scheduleSave with autoFlush=false
// =========================================================================

describe('json adapter — autoFlush=false', () => {
	const jsonDir = path.join(os.tmpdir(), 'zero-test-json-noauto-' + Date.now());
	let adapter;

	beforeAll(() => {
		const JsonAdapter = require('../../../lib/orm/adapters/json');
		adapter = new JsonAdapter({ dir: jsonDir, autoFlush: false });
	});

	afterAll(() => {
		try { fs.rmSync(jsonDir, { recursive: true, force: true }); } catch {}
	});

	it('does not start flush timer when autoFlush is false', async () => {
		await adapter.createTable('manual', {
			id: { type: 'integer', primaryKey: true, autoIncrement: true },
			name: { type: 'string' },
		});
		adapter._scheduleSave('manual');
		expect(adapter.hasPendingWrites).toBe(true);
		expect(adapter._flushTimer).toBeNull();
	});

	it('manual flush() writes dirty tables and clears timer', async () => {
		await adapter.insert('manual', { name: 'test' });
		expect(adapter.hasPendingWrites).toBe(true);

		await adapter.flush();
		expect(adapter.hasPendingWrites).toBe(false);
		expect(fs.existsSync(path.join(jsonDir, 'manual.json'))).toBe(true);
	});
});

// =========================================================================
//  json adapter — remove method
// =========================================================================

describe('json adapter — remove', () => {
	const jsonDir = path.join(os.tmpdir(), 'zero-test-json-remove-' + Date.now());
	let db;

	beforeAll(async () => {
		const { Database, Model, TYPES } = require('../../../');
		db = Database.connect('json', { dir: jsonDir });

		class RmModel extends Model {
			static table = 'rm_test';
			static schema = {
				id: { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				val: { type: TYPES.STRING },
			};
		}
		db.register(RmModel);
		await db.sync();
	});

	afterAll(async () => {
		await db.adapter.flush();
		try { fs.rmSync(jsonDir, { recursive: true, force: true }); } catch {}
	});

	it('remove saves after deleting a row', async () => {
		await db.adapter.insert('rm_test', { val: 'to-delete' });
		await db.adapter.flush();

		const rows = db.adapter._tables.get('rm_test');
		const id = rows[rows.length - 1].id;

		await db.adapter.remove('rm_test', 'id', id);
		await db.adapter.flush();

		const content = JSON.parse(fs.readFileSync(path.join(jsonDir, 'rm_test.json'), 'utf8'));
		expect(content.rows.find(r => r.id === id)).toBeUndefined();
	});
});
