/**
 * Coverage tests for lib/orm/views.js
 * Targets uncovered branches: create() with createView adapter method,
 * drop/refresh with db argument, _buildSQL where clause operators (IS NULL,
 * IS NOT NULL, IN, raw), _executeQuery fallback with conditions, count()
 * via fallback, and adapter.hasTable true path.
 */

const { Database, Model, TYPES } = require('../../lib/orm');
const { DatabaseView } = require('../../lib/orm/views');

// --- helpers ------------------------------------------------------------------
function makeDb(overrides = {}) {
    const db = Database.connect('memory');
    Object.assign(db.adapter, overrides);
    return db;
}

class TestModel extends Model {
    static table = 'test_items';
    static schema = {
        id:     { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:   { type: TYPES.STRING },
        active: { type: TYPES.BOOLEAN },
    };
}

// --- create() with adapter.createView -------------------------------------
describe('DatabaseView — create() with createView adapter', () => {
    let db;
    afterEach(async () => { await db?.close(); });

    it('calls adapter.createView when available', async () => {
        db = makeDb({ createView: vi.fn().mockResolvedValue() });
        const view = new DatabaseView('v_test', { sql: 'SELECT 1 as id' });
        await view.create(db);
        expect(db.adapter.createView).toHaveBeenCalledWith(
            'v_test', 'SELECT 1 as id', { materialized: false }
        );
    });

    it('calls adapter.createView with materialized=true', async () => {
        db = makeDb({ createView: vi.fn().mockResolvedValue() });
        const view = new DatabaseView('v_mat', { sql: 'SELECT 1', materialized: true });
        await view.create(db);
        expect(db.adapter.createView).toHaveBeenCalledWith(
            'v_mat', 'SELECT 1', { materialized: true }
        );
    });

    it('calls _buildSQL when no raw sql provided', async () => {
        db = makeDb({ createView: vi.fn().mockResolvedValue() });
        db.register(TestModel);
        await db.sync();

        const q = TestModel.query().where('active', true);
        const view = new DatabaseView('v_active', { query: q, model: TestModel });
        await view.create(db);

        expect(db.adapter.createView).toHaveBeenCalledWith(
            'v_active',
            expect.stringContaining('SELECT'),
            expect.any(Object)
        );
    });
});

// --- drop() / refresh() with db argument ----------------------------------
describe('DatabaseView — drop/refresh with db arg', () => {
    let db;
    afterEach(async () => { await db?.close(); });

    it('drop() uses db argument adapter over stored adapter', async () => {
        db = makeDb({ dropView: vi.fn().mockResolvedValue() });
        const view = new DatabaseView('v_drop', { sql: 'SELECT 1' });
        // Don't call create() — _adapter is null
        await view.drop(db);
        expect(db.adapter.dropView).toHaveBeenCalledWith('v_drop', { materialized: false });
    });

    it('refresh() with adapter.refreshView calls it', async () => {
        db = makeDb({ refreshView: vi.fn().mockResolvedValue() });
        const view = new DatabaseView('v_ref', { sql: 'SELECT 1', materialized: true });
        await view.refresh(db);
        expect(db.adapter.refreshView).toHaveBeenCalledWith('v_ref');
    });

    it('refresh() without adapter.refreshView succeeds silently', async () => {
        db = makeDb();
        const view = new DatabaseView('v_ref2', { sql: 'SELECT 1', materialized: true });
        // Should not throw
        await view.refresh(db);
    });
});

// --- exists() -------------------------------------------------------------
describe('DatabaseView — exists()', () => {
    let db;
    afterEach(async () => { await db?.close(); });

    it('exists returns true when adapter.hasTable returns true', async () => {
        db = makeDb({ hasTable: vi.fn().mockReturnValue(true) });
        const view = new DatabaseView('v_exists', { sql: 'SELECT 1' });
        view._adapter = db.adapter;
        expect(await view.exists()).toBe(true);
    });

    it('exists returns false when no hasTable method', async () => {
        db = makeDb();
        const view = new DatabaseView('v_no', { sql: 'SELECT 1' });
        view._adapter = db.adapter;
        delete view._adapter.hasTable;
        expect(await view.exists()).toBe(false);
    });
});

// --- _buildSQL where clause operators -------------------------------------
describe('DatabaseView — _buildSQL() where operators', () => {
    let db;
    afterEach(async () => { await db?.close(); });

    it('builds IS NULL where clause', async () => {
        db = makeDb();
        db.register(TestModel);
        await db.sync();

        const q = TestModel.query();
        q._where.push({ field: 'name', op: 'IS NULL' });
        const view = new DatabaseView('v_null', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('name IS NULL');
    });

    it('builds IS NOT NULL where clause', async () => {
        db = makeDb();
        db.register(TestModel);
        await db.sync();

        const q = TestModel.query();
        q._where.push({ field: 'active', op: 'IS NOT NULL' });
        const view = new DatabaseView('v_notnull', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('active IS NOT NULL');
    });

    it('builds IN where clause with placeholders', async () => {
        db = makeDb();
        db.register(TestModel);
        await db.sync();

        const q = TestModel.query();
        q._where.push({ field: 'id', op: 'IN', value: [1, 2, 3] });
        const view = new DatabaseView('v_in', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('id IN (?,?,?)');
    });

    it('builds raw where clause', async () => {
        db = makeDb();
        db.register(TestModel);
        await db.sync();

        const q = TestModel.query();
        q._where.push({ raw: 'custom_expr = 1' });
        const view = new DatabaseView('v_raw', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('custom_expr = 1');
    });

    it('escapes single quotes in standard where values', async () => {
        db = makeDb();
        db.register(TestModel);
        await db.sync();

        const q = TestModel.query();
        q._where.push({ field: 'name', op: '=', value: "O'Brien" });
        const view = new DatabaseView('v_esc', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain("O''Brien");
    });

    it('includes ORDER BY clause', async () => {
        db = makeDb();
        db.register(TestModel);
        await db.sync();

        const q = TestModel.query().orderBy('name', 'ASC');
        const view = new DatabaseView('v_order', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('ORDER BY');
    });
});

// --- _executeQuery fallback with conditions -------------------------------
describe('DatabaseView — _executeQuery fallback paths', () => {
    let db;
    afterEach(async () => { await db?.close(); });

    it('_executeQuery with viewModel delegates to model query', async () => {
        db = Database.connect('sqlite');
        db.register(TestModel);
        await db.sync();

        // Insert test data
        await TestModel.create({ name: 'a', active: 1 });
        await TestModel.create({ name: 'b', active: 0 });

        // Create actual SQLite view so viewModel can read from it
        db.adapter._db.exec('CREATE VIEW IF NOT EXISTS v_all AS SELECT * FROM test_items');

        const view = new DatabaseView('v_all', { sql: 'SELECT * FROM test_items' });
        await view.create(db);

        const all = await view.all();
        expect(all.length).toBe(2);
    });

    it('count() via viewModel uses model count', async () => {
        db = Database.connect('sqlite');
        db.register(TestModel);
        await db.sync();

        await TestModel.create({ name: 'c', active: 1 });

        db.adapter._db.exec('CREATE VIEW IF NOT EXISTS v_count AS SELECT * FROM test_items');

        const view = new DatabaseView('v_count', { sql: 'SELECT * FROM test_items' });
        await view.create(db);

        const cnt = await view.count();
        expect(cnt).toBe(1);
    });

    it('count() without viewModel falls back to executeQuery length', async () => {
        db = makeDb();
        db.register(TestModel);
        await db.sync();
        await TestModel.create({ name: 'x' });

        const q = TestModel.query();
        const view = new DatabaseView('v_ct2', { query: q });
        // Don't call create() — no viewModel
        const cnt = await view.count();
        expect(cnt).toBe(1);
    });

    it('_executeQuery without viewModel or query returns empty array', async () => {
        const view = new DatabaseView('v_empty', { sql: 'SELECT 1' });
        // _viewModel is null, _query is null
        const results = await view._executeQuery();
        expect(results).toEqual([]);
    });
});
