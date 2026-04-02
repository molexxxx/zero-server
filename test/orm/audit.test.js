/**
 * Phase 4 — AuditLog tests
 */
const { Database, Model, AuditLog } = require('../../lib/orm');

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
    if (opts.timestamps) M.timestamps = true;
    Object.defineProperty(M, 'name', { value: opts.name || table });
    db.register(M);
    return M;
}

// ===================================================================
// Constructor
// ===================================================================
describe('AuditLog — constructor', () =>
{
    it('throws without db', () =>
    {
        expect(() => new AuditLog()).toThrow('requires a Database instance');
    });

    it('defaults', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        expect(audit.tableName).toBe('_audit_log');
        expect(audit._diffs).toBe(true);
        expect(audit._timestamps).toBe(true);
        expect(audit._initialized).toBe(false);
    });

    it('accepts custom table name', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db, { table: 'my_audit' });
        expect(audit.tableName).toBe('my_audit');
    });

    it('accepts excludeFields', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db, { excludeFields: ['password', 'token'] });
        expect(audit._excludeFields.has('password')).toBe(true);
        expect(audit._excludeFields.has('token')).toBe(true);
    });

    it('can disable diffs', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db, { diffs: false });
        expect(audit._diffs).toBe(false);
    });

    it('can disable timestamps', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db, { timestamps: false });
        expect(audit._timestamps).toBe(false);
    });

    it('accepts include list', () =>
    {
        const db = memDb();
        const User = makeModel(db, 'users', { id: { type: 'integer', primaryKey: true } });
        const audit = new AuditLog(db, { include: [User] });
        expect(audit._include.has(User)).toBe(true);
    });

    it('accepts exclude list', () =>
    {
        const db = memDb();
        const User = makeModel(db, 'users', { id: { type: 'integer', primaryKey: true } });
        const audit = new AuditLog(db, { exclude: [User] });
        expect(audit._exclude.has(User)).toBe(true);
    });
});

// ===================================================================
// Actor management
// ===================================================================
describe('AuditLog — actor management', () =>
{
    let audit;

    beforeEach(() =>
    {
        audit = new AuditLog(memDb());
    });

    it('getActor returns null initially', () =>
    {
        expect(audit.getActor()).toBeNull();
    });

    it('setActor sets actor', () =>
    {
        expect(audit.setActor('user-1')).toBe(audit);
        expect(audit.getActor()).toBe('user-1');
    });

    it('setActor coerces to string', () =>
    {
        audit.setActor(42);
        expect(audit.getActor()).toBe('42');
    });

    it('setActor(null) clears actor', () =>
    {
        audit.setActor('user-1');
        audit.setActor(null);
        expect(audit.getActor()).toBeNull();
    });

    it('withActor scopes and restores', async () =>
    {
        audit.setActor('original');
        let inner;
        await audit.withActor('temp', async () =>
        {
            inner = audit.getActor();
        });
        expect(inner).toBe('temp');
        expect(audit.getActor()).toBe('original');
    });

    it('withActor restores null', async () =>
    {
        await audit.withActor('temp', async () =>
        {
            expect(audit.getActor()).toBe('temp');
        });
        expect(audit.getActor()).toBeNull();
    });

    it('withActor restores on error', async () =>
    {
        audit.setActor('original');
        try { await audit.withActor('temp', async () => { throw new Error('fail'); }); }
        catch (_) {}
        expect(audit.getActor()).toBe('original');
    });
});

// ===================================================================
// Diff computation
// ===================================================================
describe('AuditLog — diff', () =>
{
    let audit;

    beforeEach(() =>
    {
        audit = new AuditLog(memDb());
    });

    it('detects changed field', () =>
    {
        const result = audit.diff({ name: 'Alice' }, { name: 'Bob' });
        expect(result).toEqual([{ field: 'name', from: 'Alice', to: 'Bob' }]);
    });

    it('detects added field', () =>
    {
        const result = audit.diff({}, { name: 'Bob' });
        expect(result).toEqual([{ field: 'name', from: undefined, to: 'Bob' }]);
    });

    it('detects removed field', () =>
    {
        const result = audit.diff({ name: 'Alice' }, {});
        expect(result).toEqual([{ field: 'name', from: 'Alice', to: undefined }]);
    });

    it('returns empty array for identical', () =>
    {
        const result = audit.diff({ name: 'Alice' }, { name: 'Alice' });
        expect(result).toEqual([]);
    });

    it('handles nested objects', () =>
    {
        const result = audit.diff({ meta: { a: 1 } }, { meta: { a: 2 } });
        expect(result.length).toBe(1);
        expect(result[0].field).toBe('meta');
    });
});

// ===================================================================
// Field filtering
// ===================================================================
describe('AuditLog — field filtering', () =>
{
    it('excludes underscore-prefixed fields', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        const result = audit._filterFields({ name: 'Alice', _secret: 'x', _internal: 'y' });
        expect(result).toEqual({ name: 'Alice' });
    });

    it('excludes configured fields', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db, { excludeFields: ['password'] });
        const result = audit._filterFields({ name: 'Alice', password: 'secret' });
        expect(result).toEqual({ name: 'Alice' });
    });

    it('handles null/undefined', () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        expect(audit._filterFields(null)).toEqual({});
        expect(audit._filterFields(undefined)).toEqual({});
    });
});

// ===================================================================
// PK extraction
// ===================================================================
describe('AuditLog — PK extraction', () =>
{
    let audit;

    beforeEach(() =>
    {
        audit = new AuditLog(memDb());
    });

    it('extracts id', () =>
    {
        expect(audit._extractPK({ id: 42, name: 'Alice' })).toBe(42);
    });

    it('extracts _id', () =>
    {
        expect(audit._extractPK({ _id: 'abc', name: 'Alice' })).toBe('abc');
    });

    it('returns null for no PK', () =>
    {
        expect(audit._extractPK({ name: 'Alice' })).toBeNull();
    });

    it('returns null for null instance', () =>
    {
        expect(audit._extractPK(null)).toBeNull();
    });
});

// ===================================================================
// Install
// ===================================================================
describe('AuditLog — install', () =>
{
    it('creates audit table on memory adapter', async () =>
    {
        const db = memDb();
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        });
        await db.sync();

        const audit = new AuditLog(db, { include: [User] });
        const result = await audit.install();

        expect(result).toBe(audit);
        expect(audit._initialized).toBe(true);
        expect(audit._auditedModels.has(User)).toBe(true);
    });

    it('excludes models in exclude list', async () =>
    {
        const db = memDb();
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        const Post = makeModel(db, 'posts', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string' },
        });
        await db.sync();

        const audit = new AuditLog(db, { include: [User, Post], exclude: [Post] });
        await audit.install();

        expect(audit._auditedModels.has(User)).toBe(true);
        expect(audit._auditedModels.has(Post)).toBe(false);
    });

    it('does not double-attach hooks', async () =>
    {
        const db = memDb();
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();

        const audit = new AuditLog(db, { include: [User] });
        await audit.install();

        const sizeBefore = audit._auditedModels.size;
        audit._attachHooks(User);
        expect(audit._auditedModels.size).toBe(sizeBefore);
    });
});

// ===================================================================
// Middleware
// ===================================================================
describe('AuditLog — middleware', () =>
{
    let audit;

    beforeEach(() =>
    {
        audit = new AuditLog(memDb());
    });

    it('extracts actor from header', () =>
    {
        const mw = audit.middleware({ header: 'x-user-id' });
        const req = { headers: { 'x-user-id': 'user-1' } };
        let called = false;
        mw(req, {}, () => { called = true; });
        expect(called).toBe(true);
        expect(audit.getActor()).toBe('user-1');
    });

    it('extracts via custom function', () =>
    {
        const mw = audit.middleware({ extract: (req) => req.userId });
        const req = { headers: {}, userId: 'admin' };
        let called = false;
        mw(req, {}, () => { called = true; });
        expect(called).toBe(true);
        expect(audit.getActor()).toBe('admin');
    });

    it('calls next even with no actor', () =>
    {
        const mw = audit.middleware();
        const req = { headers: {} };
        let called = false;
        mw(req, {}, () => { called = true; });
        expect(called).toBe(true);
    });
});

// ===================================================================
// Table name validation (security)
// ===================================================================
describe('AuditLog — table name validation', () =>
{
    it('rejects SQL injection in table name', () =>
    {
        expect(() => new AuditLog(memDb(), { table: 'audit; DROP TABLE' })).toThrow('Invalid audit table name');
    });

    it('rejects special characters', () =>
    {
        expect(() => new AuditLog(memDb(), { table: 'my@table' })).toThrow('Invalid audit table name');
        expect(() => new AuditLog(memDb(), { table: 'a b' })).toThrow('Invalid audit table name');
    });

    it('rejects name starting with digit', () =>
    {
        expect(() => new AuditLog(memDb(), { table: '1table' })).toThrow('Invalid audit table name');
    });

    it('accepts valid table names', () =>
    {
        expect(() => new AuditLog(memDb(), { table: '_audit_log' })).not.toThrow();
        expect(() => new AuditLog(memDb(), { table: 'MyAudit' })).not.toThrow();
        expect(() => new AuditLog(memDb(), { table: 'audit_v2' })).not.toThrow();
    });
});

// ===================================================================
// Trail / History / byActor / count
// ===================================================================
describe('AuditLog — trail querying', () =>
{
    let db, audit, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        audit = new AuditLog(db, { include: [User] });
        await audit.install();
    });

    it('trail returns empty array when no entries', async () =>
    {
        const entries = await audit.trail({ table: 'users' });
        expect(Array.isArray(entries)).toBe(true);
    });

    it('trail builds correct where clauses', async () =>
    {
        // Verify trail does not throw for various filter combos
        await expect(audit.trail({ table: 'users', action: 'create' })).resolves.toBeDefined();
        await expect(audit.trail({ recordId: '1', actor: 'admin' })).resolves.toBeDefined();
        await expect(audit.trail({ since: '2020-01-01', until: '2099-01-01' })).resolves.toBeDefined();
        await expect(audit.trail({ limit: 5, offset: 10, order: 'asc' })).resolves.toBeDefined();
    });

    it('history delegates to trail', async () =>
    {
        const hist = await audit.history('users', 1);
        expect(Array.isArray(hist)).toBe(true);
    });

    it('byActor returns a Map', async () =>
    {
        const grouped = await audit.byActor();
        expect(grouped instanceof Map).toBe(true);
    });

    it('count returns a number', async () =>
    {
        const c = await audit.count({ table: 'users' });
        expect(typeof c).toBe('number');
    });

    it('count falls back to trail length for adapters without execute', async () =>
    {
        // Mock: remove execute so it falls back
        const origEx = audit._storage.adapter.execute;
        delete audit._storage.adapter.execute;
        const c = await audit.count({ table: 'users' });
        expect(typeof c).toBe('number');
        if (origEx) audit._storage.adapter.execute = origEx;
    });
});

// ===================================================================
// Purge
// ===================================================================
describe('AuditLog — purge', () =>
{
    it('throws without filters', async () =>
    {
        const audit = new AuditLog(memDb());
        await expect(audit.purge({})).rejects.toThrow('requires at least one filter');
    });

    it('purge by table', async () =>
    {
        const db = memDb();
        const User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string' },
        });
        await db.sync();
        const audit = new AuditLog(db, { include: [User] });
        await audit.install();

        await User.create({ name: 'Test' });
        await new Promise(r => setTimeout(r, 50));

        // Purge by table — should not throw
        const count = await audit.purge({ table: 'users' });
        expect(typeof count).toBe('number');
    });

    it('purge by before timestamp', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();

        const count = await audit.purge({ before: '2099-01-01T00:00:00Z' });
        expect(typeof count).toBe('number');
    });
});

// ===================================================================
// _logEntry branches
// ===================================================================
describe('AuditLog — _logEntry', () =>
{
    it('logs create action without throwing', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();

        await expect(audit._logEntry('create', 'users', { id: 1, name: 'Alice' })).resolves.not.toThrow();
    });

    it('logs delete action without throwing', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();

        await expect(audit._logEntry('delete', 'users', { id: 1, name: 'Alice' })).resolves.not.toThrow();
    });

    it('logs update action with diffs enabled', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db, { diffs: true });
        await audit.install();

        const instance = { id: 1, name: 'Bob', _original: { id: 1, name: 'Alice' } };
        // Should not throw - exercises the update + diffs code path
        await expect(audit._logEntry('update', 'users', instance)).resolves.not.toThrow();
    });

    it('logs update action with diffs disabled', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db, { diffs: false });
        await audit.install();

        const instance = { id: 1, name: 'Bob', _original: { id: 1, name: 'Alice' } };
        await expect(audit._logEntry('update', 'users', instance)).resolves.not.toThrow();
    });

    it('handles _logEntry errors gracefully', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        // Don't install — writing will fail but shouldn't throw
        await expect(audit._logEntry('create', 'users', { id: 1 })).resolves.not.toThrow();
    });

    it('records actor when set', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();
        audit.setActor('admin');
        await expect(audit._logEntry('create', 'users', { id: 1 })).resolves.not.toThrow();
    });
});

// ===================================================================
// _attachHooks fallback (patching static create)
// ===================================================================
describe('AuditLog — _attachHooks fallback', () =>
{
    it('patches static create when model has no .on()', async () =>
    {
        const db = memDb();
        let origCalled = false;
        const FakeModel = {
            table: 'fakes',
            create: async (data) => { origCalled = true; return { id: 1, ...data }; },
        };

        const audit = new AuditLog(db);
        await audit.install();

        audit._attachHooks(FakeModel);
        expect(audit._auditedModels.has(FakeModel)).toBe(true);

        // The wrapped create should still call the original
        const result = await FakeModel.create({ name: 'Test' });
        expect(origCalled).toBe(true);
        expect(result.name).toBe('Test');
    });
});

// ===================================================================
// _extractPK with toJSON
// ===================================================================
describe('AuditLog — _extractPK with toJSON', () =>
{
    it('uses toJSON() if available', () =>
    {
        const audit = new AuditLog(memDb());
        const instance = { toJSON: () => ({ id: 42, name: 'Alice' }) };
        expect(audit._extractPK(instance)).toBe(42);
    });

    it('falls back to _id', () =>
    {
        const audit = new AuditLog(memDb());
        expect(audit._extractPK({ _id: 'mongo-id' })).toBe('mongo-id');
    });
});

// ===================================================================
// Trail adapter fallback branches
// ===================================================================
describe('AuditLog — trail adapter branches', () =>
{
    it('trail returns [] when adapter has no execute or find', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        // Remove both methods to hit the fallback
        const origExec = audit._storage.adapter.execute;
        const origFind = audit._storage.adapter.find;
        delete audit._storage.adapter.execute;
        delete audit._storage.adapter.find;

        const entries = await audit.trail();
        expect(entries).toEqual([]);

        if (origExec) audit._storage.adapter.execute = origExec;
        if (origFind) audit._storage.adapter.find = origFind;
    });

    it('trail uses adapter.find when execute is absent', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        // Override execute to undefined and add a mock find
        const origExec = audit._storage.adapter.execute.bind(audit._storage.adapter);
        Object.defineProperty(audit._storage.adapter, 'execute', { value: undefined, configurable: true, writable: true });
        audit._storage.adapter.find = vi.fn().mockResolvedValue([]);

        const entries = await audit.trail({ table: 'test' });
        expect(entries).toEqual([]);
        expect(audit._storage.adapter.find).toHaveBeenCalled();

        Object.defineProperty(audit._storage.adapter, 'execute', { value: origExec, configurable: true, writable: true });
        delete audit._storage.adapter.find;
    });

    it('trail parses JSON fields correctly', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute;
        audit._storage.adapter.execute = vi.fn().mockResolvedValue([
            { action: 'create', table_name: 'users', old_values: null, new_values: '{"name":"Alice"}', diff: null },
        ]);

        const entries = await audit.trail();
        expect(entries[0].new_values).toEqual({ name: 'Alice' });
        expect(entries[0].old_values).toBeNull();

        audit._storage.adapter.execute = origExec;
    });
});

// ===================================================================
// Count adapter branches
// ===================================================================
describe('AuditLog — count branches', () =>
{
    it('count handles numeric result from execute', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute;
        audit._storage.adapter.execute = vi.fn().mockResolvedValue(5);
        const c = await audit.count();
        expect(c).toBe(5);
        audit._storage.adapter.execute = origExec;
    });

    it('count handles array result with count field', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute;
        audit._storage.adapter.execute = vi.fn().mockResolvedValue([{ count: 42 }]);
        const c = await audit.count();
        expect(c).toBe(42);
        audit._storage.adapter.execute = origExec;
    });

    it('count returns 0 for empty array result', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute;
        audit._storage.adapter.execute = vi.fn().mockResolvedValue([]);
        const c = await audit.count();
        expect(c).toBe(0);
        audit._storage.adapter.execute = origExec;
    });

    it('count with all filter options', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await expect(audit.count({
            table: 'users',
            action: 'create',
            recordId: '1',
            actor: 'admin',
            since: '2020-01-01',
            until: '2099-01-01',
        })).resolves.toBeDefined();
    });
});

// ===================================================================
// _writeEntry branches
// ===================================================================
describe('AuditLog — _writeEntry branches', () =>
{
    it('uses adapter.insert when execute is absent', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute.bind(audit._storage.adapter);
        Object.defineProperty(audit._storage.adapter, 'execute', { value: undefined, configurable: true, writable: true });
        audit._storage.adapter.insert = vi.fn().mockResolvedValue({});

        await audit._writeEntry({ action: 'create', table_name: 'users', timestamp: new Date().toISOString() });
        expect(audit._storage.adapter.insert).toHaveBeenCalled();

        Object.defineProperty(audit._storage.adapter, 'execute', { value: origExec, configurable: true, writable: true });
    });
});

// ===================================================================
// _filterFields with toJSON
// ===================================================================
describe('AuditLog — _filterFields with toJSON', () =>
{
    it('uses toJSON when available', () =>
    {
        const audit = new AuditLog(memDb());
        const obj = { toJSON: () => ({ name: 'Alice', _internal: 'x' }) };
        const result = audit._filterFields(obj);
        expect(result).toEqual({ name: 'Alice' });
    });
});

// ===================================================================
// byActor with unknown actors
// ===================================================================
describe('AuditLog — byActor grouping', () =>
{
    it('groups entries with null actor under __unknown__', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute;
        audit._storage.adapter.execute = vi.fn().mockResolvedValue([
            { action: 'create', table_name: 'users', actor: null, old_values: null, new_values: null, diff: null },
            { action: 'create', table_name: 'users', actor: 'admin', old_values: null, new_values: null, diff: null },
        ]);

        const grouped = await audit.byActor();
        expect(grouped.has('__unknown__')).toBe(true);
        expect(grouped.has('admin')).toBe(true);

        audit._storage.adapter.execute = origExec;
    });
});

// ===================================================================
// _attachHooks — updated/deleted event handlers
// ===================================================================
describe('AuditLog — _attachHooks event handlers', () =>
{
    it('fires updated event handler', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();

        const handlers = {};
        const FakeModel = {
            table: 'evusers',
            on: (event, cb) => { handlers[event] = cb; },
        };

        audit._attachHooks(FakeModel);

        // Fire the updated event
        const spy = vi.spyOn(audit, '_logEntry').mockResolvedValue();
        handlers.updated({ id: 1, name: 'Updated' });
        expect(spy).toHaveBeenCalledWith('update', 'evusers', { id: 1, name: 'Updated' });
        spy.mockRestore();
    });

    it('fires deleted event handler', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();

        const handlers = {};
        const FakeModel = {
            table: 'evusers',
            on: (event, cb) => { handlers[event] = cb; },
        };

        audit._attachHooks(FakeModel);

        const spy = vi.spyOn(audit, '_logEntry').mockResolvedValue();
        handlers.deleted({ id: 1, name: 'Deleted' });
        expect(spy).toHaveBeenCalledWith('delete', 'evusers', { id: 1, name: 'Deleted' });
        spy.mockRestore();
    });

    it('catch callbacks swallow _logEntry rejections', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();

        const handlers = {};
        const FakeModel = {
            table: 'evusers',
            on: (event, cb) => { handlers[event] = cb; },
        };

        audit._attachHooks(FakeModel);

        // Make _logEntry reject — the .catch(() => {}) in each handler should swallow
        vi.spyOn(audit, '_logEntry').mockRejectedValue(new Error('fail'));

        // Call all three handlers — none should throw
        await handlers.created({ id: 1 });
        await handlers.updated({ id: 2 });
        await handlers.deleted({ id: 3 });

        audit._logEntry.mockRestore();
    });

    it('uses ModelClass.name when .table is undefined', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);
        await audit.install();

        const handlers = {};
        function FakeNamedModel() {}
        FakeNamedModel.on = (event, cb) => { handlers[event] = cb; };
        // No .table property, should fallback to .name

        audit._attachHooks(FakeNamedModel);

        const spy = vi.spyOn(audit, '_logEntry').mockResolvedValue();
        handlers.created({ id: 1 });
        expect(spy).toHaveBeenCalledWith('create', 'FakeNamedModel', { id: 1 });
        spy.mockRestore();
    });
});

// ===================================================================
// _computeDiff — null oldValues / newValues branches
// ===================================================================
describe('AuditLog — _computeDiff null branches', () =>
{
    it('handles null oldValues', () =>
    {
        const audit = new AuditLog(memDb());
        const diff = audit._computeDiff(null, { name: 'Alice' });
        expect(diff).toEqual([{ field: 'name', from: undefined, to: 'Alice' }]);
    });

    it('handles null newValues', () =>
    {
        const audit = new AuditLog(memDb());
        const diff = audit._computeDiff({ name: 'Alice' }, null);
        expect(diff).toEqual([{ field: 'name', from: 'Alice', to: undefined }]);
    });
});

// ===================================================================
// install() — non-SQL adapter branches
// ===================================================================
describe('AuditLog — install non-SQL branches', () =>
{
    it('install() else branch — adapter without execute but with createTable', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        // Remove execute, keep createTable
        const origExec = audit._storage.adapter.execute.bind(audit._storage.adapter);
        Object.defineProperty(audit._storage.adapter, 'execute', { value: undefined, configurable: true, writable: true });

        const createSpy = vi.fn().mockResolvedValue();
        audit._storage.adapter.createTable = createSpy;

        await audit.install();
        expect(createSpy).toHaveBeenCalledWith('_audit_log', expect.any(Object));

        Object.defineProperty(audit._storage.adapter, 'execute', { value: origExec, configurable: true, writable: true });
        delete audit._storage.adapter.createTable;
    });

    it('install() else branch — adapter without execute or createTable', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute.bind(audit._storage.adapter);
        Object.defineProperty(audit._storage.adapter, 'execute', { value: undefined, configurable: true, writable: true });
        // Also ensure no createTable
        const origCreateTable = audit._storage.adapter.createTable;
        if (origCreateTable) {
            Object.defineProperty(audit._storage.adapter, 'createTable', { value: undefined, configurable: true, writable: true });
        }

        // Should not throw
        await audit.install();

        Object.defineProperty(audit._storage.adapter, 'execute', { value: origExec, configurable: true, writable: true });
        if (origCreateTable) {
            Object.defineProperty(audit._storage.adapter, 'createTable', { value: origCreateTable, configurable: true, writable: true });
        }
    });
});

// ===================================================================
// count() — fallback without execute
// ===================================================================
describe('AuditLog — count fallback', () =>
{
    it('count falls back to trail().length when no execute', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute.bind(audit._storage.adapter);
        Object.defineProperty(audit._storage.adapter, 'execute', { value: undefined, configurable: true, writable: true });

        // trail() will also have no execute — stub it to return items
        vi.spyOn(audit, 'trail').mockResolvedValue([{ action: 'create' }, { action: 'update' }]);

        const count = await audit.count();
        expect(count).toBe(2);

        audit.trail.mockRestore();
        Object.defineProperty(audit._storage.adapter, 'execute', { value: origExec, configurable: true, writable: true });
    });
});

// ===================================================================
// purge() — non-SQL adapter fallback
// ===================================================================
describe('AuditLog — purge non-SQL fallback', () =>
{
    it('returns 0 when adapter has no execute', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const origExec = audit._storage.adapter.execute.bind(audit._storage.adapter);
        Object.defineProperty(audit._storage.adapter, 'execute', { value: undefined, configurable: true, writable: true });

        const count = await audit.purge({ table: 'users' });
        expect(count).toBe(0);

        Object.defineProperty(audit._storage.adapter, 'execute', { value: origExec, configurable: true, writable: true });
    });

    it('purge returns result.changes count', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        audit._storage.adapter.execute = vi.fn().mockResolvedValue({ changes: 5 });

        const count = await audit.purge({ before: '2025-01-01T00:00:00Z' });
        expect(count).toBe(5);
    });
});

// ===================================================================
// trail() — null rows and JSON field branches
// ===================================================================
describe('AuditLog — trail edge cases', () =>
{
    it('trail handles null rows from execute', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        audit._storage.adapter.execute = vi.fn().mockResolvedValue(null);

        const entries = await audit.trail();
        expect(entries).toEqual([]);
    });

    it('trail parses old_values and diff when present', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        audit._storage.adapter.execute = vi.fn().mockResolvedValue([{
            action: 'update',
            table_name: 'users',
            old_values: '{"name":"Old"}',
            new_values: '{"name":"New"}',
            diff: '[{"field":"name","from":"Old","to":"New"}]',
        }]);

        const entries = await audit.trail();
        expect(entries[0].old_values).toEqual({ name: 'Old' });
        expect(entries[0].diff).toEqual([{ field: 'name', from: 'Old', to: 'New' }]);
    });

    it('_logEntry catch branch logs error', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        // Make _writeEntry throw
        vi.spyOn(audit, '_writeEntry').mockRejectedValue(new Error('write fail'));

        // Should not throw — caught internally
        await audit._logEntry('create', 'users', { id: 1, name: 'Test' });

        audit._writeEntry.mockRestore();
    });

    it('_logEntry with null pk', async () =>
    {
        const db = memDb();
        const audit = new AuditLog(db);

        const writeSpy = vi.spyOn(audit, '_writeEntry').mockResolvedValue();
        // Pass instance without id, _id — pk will be null
        await audit._logEntry('create', 'users', { name: 'NoPK' });

        expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({ record_id: null }));
        writeSpy.mockRestore();
    });
});
