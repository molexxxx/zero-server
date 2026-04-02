/**
 * Phase 3 — DatabaseView tests
 */
const { Database, Model, DatabaseView } = require('../../lib/orm');

// ===================================================================
// Helpers
// ===================================================================

function memDb()
{
    return Database.connect('memory');
}

function makeModel(db, table, schema, opts = {})
{
    const M = class extends Model
    {
        static table = table;
        static schema = schema;
    };
    Object.defineProperty(M, 'name', { value: opts.name || table });
    db.register(M);
    return M;
}

// ===================================================================
// Constructor Validation
// ===================================================================
describe('DatabaseView — constructor', () =>
{
    it('throws if name is empty', () =>
    {
        expect(() => new DatabaseView('')).toThrow('non-empty string name');
    });

    it('throws if name is not a string', () =>
    {
        expect(() => new DatabaseView(42)).toThrow('non-empty string name');
    });

    it('throws if neither query nor sql provided', () =>
    {
        expect(() => new DatabaseView('v')).toThrow('query or sql');
    });

    it('accepts sql option', () =>
    {
        const v = new DatabaseView('v1', { sql: 'SELECT 1' });
        expect(v.name).toBe('v1');
        expect(v._sql).toBe('SELECT 1');
    });

    it('accepts query option', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'items', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        const q = M.query();
        const v = new DatabaseView('v2', { query: q });
        expect(v._query).toBe(q);
    });

    it('materialized defaults to false', () =>
    {
        const v = new DatabaseView('v3', { sql: 'SELECT 1' });
        expect(v._materialized).toBe(false);
    });

    it('materialized can be set to true', () =>
    {
        const v = new DatabaseView('v4', { sql: 'SELECT 1', materialized: true });
        expect(v._materialized).toBe(true);
    });
});

// ===================================================================
// create / drop / refresh / exists
// ===================================================================
describe('DatabaseView — lifecycle', () =>
{
    let db, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            name:   { type: 'string', required: true },
            active: { type: 'boolean', default: true },
        }, { name: 'User' });
        await db.sync();
    });

    it('create() returns this for chaining', async () =>
    {
        const view = new DatabaseView('active_users', {
            query: User.query().where('active', true),
            model: User,
        });
        const result = await view.create(db);
        expect(result).toBe(view);
    });

    it('create() sets up viewModel', async () =>
    {
        const view = new DatabaseView('active_users2', {
            query: User.query().where('active', true),
            model: User,
        });
        await view.create(db);
        expect(view._viewModel).not.toBeNull();
    });

    it('drop() resets viewModel', async () =>
    {
        const view = new DatabaseView('to_drop', {
            query: User.query(),
            model: User,
        });
        await view.create(db);
        await view.drop(db);
        expect(view._viewModel).toBeNull();
    });

    it('drop() throws without adapter', async () =>
    {
        const view = new DatabaseView('orphan', { sql: 'SELECT 1' });
        await expect(view.drop()).rejects.toThrow('No database adapter');
    });

    it('refresh() throws for non-materialized view', async () =>
    {
        const view = new DatabaseView('no_mat', {
            query: User.query(),
            model: User,
        });
        await view.create(db);
        await expect(view.refresh(db)).rejects.toThrow('materialized');
    });

    it('refresh() succeeds for materialized view (no-op on memory)', async () =>
    {
        const view = new DatabaseView('mat_view', {
            query: User.query(),
            model: User,
            materialized: true,
        });
        await view.create(db);
        // Should not throw
        await view.refresh(db);
    });

    it('refresh() throws without adapter', async () =>
    {
        const view = new DatabaseView('orphan2', { sql: 'SELECT 1', materialized: true });
        await expect(view.refresh()).rejects.toThrow('No database adapter');
    });

    it('exists() checks via adapter', async () =>
    {
        const view = new DatabaseView('exist_check', {
            query: User.query(),
            model: User,
        });
        await view.create(db);
        // Memory adapter: hasTable should work for the view model table
        const result = await view.exists(db);
        expect(typeof result).toBe('boolean');
    });

    it('exists() throws without adapter', async () =>
    {
        const view = new DatabaseView('orphan3', { sql: 'SELECT 1' });
        await expect(view.exists()).rejects.toThrow('No database adapter');
    });
});

// ===================================================================
// Query Methods (all, find, findOne, count, query)
// ===================================================================
describe('DatabaseView — querying', () =>
{
    let db, User, view;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'qv_users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
            age:  { type: 'integer', default: 25 },
        }, { name: 'QvUser' });
        await db.sync();

        await User.create({ name: 'Alice', age: 30 });
        await User.create({ name: 'Bob', age: 20 });
        await User.create({ name: 'Charlie', age: 35 });

        // Don't call create() — use fallback path with source query for memory adapter
        view = new DatabaseView('qv_all', {
            query: User.query(),
            model: User,
        });
    });

    it('all() returns all records via fallback', async () =>
    {
        const results = await view.all();
        expect(results.length).toBe(3);
    });

    it('find() filters by conditions via fallback', async () =>
    {
        const results = await view.find({ name: 'Alice' });
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('Alice');
    });

    it('find() with no matches returns empty array', async () =>
    {
        const results = await view.find({ name: 'Nobody' });
        expect(results).toEqual([]);
    });

    it('findOne() returns first match', async () =>
    {
        const result = await view.findOne({ name: 'Bob' });
        expect(result).not.toBeNull();
        expect(result.name).toBe('Bob');
    });

    it('findOne() returns null when no match', async () =>
    {
        const result = await view.findOne({ name: 'Nobody' });
        expect(result).toBeNull();
    });

    it('count() returns record count via fallback', async () =>
    {
        const c = await view.count();
        expect(c).toBe(3);
    });

    it('count() with conditions', async () =>
    {
        const c = await view.count({ name: 'Alice' });
        expect(c).toBe(1);
    });

    it('query() returns fluent query builder after create()', async () =>
    {
        // Create the view to set up _viewModel, then insert into view table
        const view2 = new DatabaseView('qv_users', {
            query: User.query(),
            model: User,
        });
        await view2.create(db);
        // Data was inserted into qv_users which is now also the view table name
        const results = await view2.query().where('name', 'Alice').exec();
        expect(results.length).toBe(1);
    });

    it('query() throws before create()', () =>
    {
        const v = new DatabaseView('not_created', { sql: 'SELECT 1' });
        expect(() => v.query()).toThrow('create()');
    });
});

// ===================================================================
// _executeQuery fallback (no viewModel, uses source query)
// ===================================================================
describe('DatabaseView — _executeQuery fallback', () =>
{
    let db, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'eq_users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'EqUser' });
        await db.sync();
        await User.create({ name: 'A' });
        await User.create({ name: 'B' });
    });

    it('_executeQuery with viewModel delegates to model query', async () =>
    {
        // Use same table name for view so it shares data
        const view = new DatabaseView('eq_users', {
            query: User.query(),
            model: User,
        });
        await view.create(db);
        const results = await view._executeQuery({}, 1);
        expect(results.length).toBe(1);
    });

    it('_executeQuery without viewModel falls back to source query', async () =>
    {
        const view = new DatabaseView('eq_fallback', {
            query: User.query(),
            model: User,
        });
        // Do NOT call create() — _viewModel is null, but _query exists
        const results = await view._executeQuery();
        expect(results.length).toBe(2);
    });

    it('_executeQuery without viewModel or query returns empty', async () =>
    {
        const view = new DatabaseView('eq_empty', { sql: 'SELECT 1' });
        const results = await view._executeQuery();
        expect(results).toEqual([]);
    });

    it('_executeQuery fallback applies conditions', async () =>
    {
        const view = new DatabaseView('eq_cond', {
            query: User.query(),
            model: User,
        });
        const results = await view._executeQuery({ name: 'A' });
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('A');
    });
});

// ===================================================================
// _buildSQL
// ===================================================================
describe('DatabaseView — _buildSQL', () =>
{
    let db, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'bs_users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'BsUser' });
        await db.sync();
    });

    it('uses raw sql if provided', () =>
    {
        const view = new DatabaseView('raw', { sql: 'SELECT * FROM users' });
        expect(view._buildSQL()).toBe('SELECT * FROM users');
    });

    it('builds SQL from query with select', () =>
    {
        const q = User.query().select('id', 'name');
        const view = new DatabaseView('built', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('SELECT');
        expect(sql).toContain('id');
        expect(sql).toContain('name');
    });

    it('builds SQL from query with where clause', () =>
    {
        const q = User.query().where('name', 'Alice');
        const view = new DatabaseView('where', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('WHERE');
    });

    it('builds SQL from query with orderBy', () =>
    {
        const q = User.query().orderBy('name', 'DESC');
        const view = new DatabaseView('ordered', { query: q });
        const sql = view._buildSQL();
        expect(sql).toContain('ORDER BY');
        expect(sql).toContain('DESC');
    });

    it('throws without query or sql', () =>
    {
        const view = new DatabaseView('err', { sql: 'x' });
        view._sql = null;
        view._query = null;
        expect(() => view._buildSQL()).toThrow('No query or SQL');
    });
});

// ===================================================================
// _createViewModel
// ===================================================================
describe('DatabaseView — _createViewModel', () =>
{
    it('creates a model registered with the database', async () =>
    {
        const db = memDb();
        const User = makeModel(db, 'vm_users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'VmUser' });
        await db.sync();

        const view = new DatabaseView('my_view', {
            query: User.query(),
            model: User,
        });
        const VM = view._createViewModel(db);
        expect(VM.table).toBe('my_view');
    });

    it('inherits schema from base model', async () =>
    {
        const db = memDb();
        const schema = {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        };
        const User = makeModel(db, 'vm_users2', schema, { name: 'VmUser2' });
        await db.sync();

        const view = new DatabaseView('v_inherit', {
            query: User.query(),
            model: User,
        });
        const VM = view._createViewModel(db);
        expect(VM.schema.name).toBeDefined();
    });

    it('uses custom schema if provided', async () =>
    {
        const db = memDb();
        const User = makeModel(db, 'vm_users3', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'VmUser3' });
        await db.sync();

        const customSchema = { myField: { type: 'string' } };
        const view = new DatabaseView('v_custom', {
            query: User.query(),
            schema: customSchema,
        });
        const VM = view._createViewModel(db);
        expect(VM.schema.myField).toBeDefined();
    });

    it('uses empty schema when no model or schema provided', async () =>
    {
        const db = memDb();
        const User = makeModel(db, 'vm_users4', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'VmUser4' });
        await db.sync();

        const view = new DatabaseView('v_no_schema', { sql: 'SELECT 1' });
        const VM = view._createViewModel(db);
        expect(VM.schema).toEqual({});
    });
});

// ===================================================================
// Name validation (security)
// ===================================================================
describe('DatabaseView — name validation (security)', () =>
{
    it('rejects SQL injection in view name', () =>
    {
        expect(() => new DatabaseView('my_view; DROP TABLE', {})).toThrow('Invalid view name');
    });

    it('rejects special characters in view name', () =>
    {
        expect(() => new DatabaseView('view@evil', {})).toThrow('Invalid view name');
        expect(() => new DatabaseView('view/path', {})).toThrow('Invalid view name');
        expect(() => new DatabaseView('view name', {})).toThrow('Invalid view name');
    });

    it('rejects names starting with a number', () =>
    {
        expect(() => new DatabaseView('123view', {})).toThrow('Invalid view name');
    });

    it('accepts valid identifier names', () =>
    {
        expect(() => new DatabaseView('valid_view', { sql: 'SELECT 1' })).not.toThrow();
        expect(() => new DatabaseView('_private', { sql: 'SELECT 1' })).not.toThrow();
        expect(() => new DatabaseView('ViewName', { sql: 'SELECT 1' })).not.toThrow();
    });
});
