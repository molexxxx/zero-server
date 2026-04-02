/**
 * Phase 4 — TenantManager tests
 */
const { Database, Model, TenantManager } = require('../../lib/orm');

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
describe('TenantManager — constructor', () =>
{
    it('throws without db', () =>
    {
        expect(() => new TenantManager()).toThrow('requires a Database instance');
    });

    it('defaults to row strategy', () =>
    {
        const db = memDb();
        const tm = new TenantManager(db);
        expect(tm.strategy).toBe('row');
        expect(tm.tenantColumn).toBe('tenant_id');
    });

    it('accepts schema strategy', () =>
    {
        const db = memDb();
        const tm = new TenantManager(db, { strategy: 'schema' });
        expect(tm.strategy).toBe('schema');
    });

    it('throws on invalid strategy', () =>
    {
        const db = memDb();
        expect(() => new TenantManager(db, { strategy: 'invalid' }))
            .toThrow('Unknown tenancy strategy');
    });

    it('accepts custom tenantColumn', () =>
    {
        const db = memDb();
        const tm = new TenantManager(db, { tenantColumn: 'org_id' });
        expect(tm.tenantColumn).toBe('org_id');
    });

    it('accepts custom schemaPrefix', () =>
    {
        const db = memDb();
        const tm = new TenantManager(db, { strategy: 'schema', schemaPrefix: 'org_' });
        expect(tm.schemaPrefix).toBe('org_');
    });
});

// ===================================================================
// Tenant context
// ===================================================================
describe('TenantManager — tenant context', () =>
{
    let db, tm;

    beforeEach(() =>
    {
        db = memDb();
        tm = new TenantManager(db);
    });

    it('getCurrentTenant returns null initially', () =>
    {
        expect(tm.getCurrentTenant()).toBeNull();
    });

    it('setCurrentTenant sets and returns chainable', () =>
    {
        const result = tm.setCurrentTenant('acme');
        expect(result).toBe(tm);
        expect(tm.getCurrentTenant()).toBe('acme');
    });

    it('setCurrentTenant throws on empty string', () =>
    {
        expect(() => tm.setCurrentTenant('')).toThrow('non-empty string');
    });

    it('setCurrentTenant throws on non-string', () =>
    {
        expect(() => tm.setCurrentTenant(123)).toThrow('non-empty string');
    });

    it('clearTenant clears the context', () =>
    {
        tm.setCurrentTenant('acme');
        tm.clearTenant();
        expect(tm.getCurrentTenant()).toBeNull();
    });

    it('withTenant scopes and restores', async () =>
    {
        tm.setCurrentTenant('globex');
        let inner;
        await tm.withTenant('acme', async () =>
        {
            inner = tm.getCurrentTenant();
        });
        expect(inner).toBe('acme');
        expect(tm.getCurrentTenant()).toBe('globex');
    });

    it('withTenant restores null', async () =>
    {
        await tm.withTenant('acme', async () =>
        {
            expect(tm.getCurrentTenant()).toBe('acme');
        });
        expect(tm.getCurrentTenant()).toBeNull();
    });

    it('withTenant restores even on error', async () =>
    {
        tm.setCurrentTenant('original');
        try
        {
            await tm.withTenant('temp', async () => { throw new Error('fail'); });
        }
        catch (_) {}
        expect(tm.getCurrentTenant()).toBe('original');
    });
});

// ===================================================================
// Row-level tenancy
// ===================================================================
describe('TenantManager — row-level tenancy', () =>
{
    let db, tm, User;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            name:      { type: 'string', required: true },
            tenant_id: { type: 'string' },
        });
        await db.sync();

        tm = new TenantManager(db, { strategy: 'row' });
        tm.addModel(User);
    });

    it('addModel returns chainable', () =>
    {
        const db2 = memDb();
        const M = makeModel(db2, 'items', { id: { type: 'integer', primaryKey: true } });
        const tm2 = new TenantManager(db2, { strategy: 'row' });
        expect(tm2.addModel(M)).toBe(tm2);
    });

    it('addModels registers multiple', () =>
    {
        const db2 = memDb();
        const A = makeModel(db2, 'a', { id: { type: 'integer', primaryKey: true } });
        const B = makeModel(db2, 'b', { id: { type: 'integer', primaryKey: true } });
        const tm2 = new TenantManager(db2, { strategy: 'row' });
        tm2.addModels(A, B);
        expect(tm2._models.size).toBe(2);
    });

    it('create() injects tenant column', async () =>
    {
        tm.setCurrentTenant('acme');
        const user = await User.create({ name: 'Alice' });
        expect(user.tenant_id).toBe('acme');
    });

    it('create() works without tenant set', async () =>
    {
        const user = await User.create({ name: 'Bob' });
        expect(user.tenant_id).toBeNull();
    });

    it('createMany() injects tenant column', async () =>
    {
        tm.setCurrentTenant('acme');
        await User.createMany([{ name: 'A' }, { name: 'B' }]);
        const all = await User.find({});
        expect(all.every(u => u.tenant_id === 'acme')).toBe(true);
    });

    it('find() scopes to tenant', async () =>
    {
        await User.create({ name: 'Global', tenant_id: 'globex' });
        tm.setCurrentTenant('acme');
        await User.create({ name: 'Acme User' });

        const users = await User.find({});
        expect(users.length).toBe(1);
        expect(users[0].name).toBe('Acme User');
    });

    it('findOne() scopes to tenant', async () =>
    {
        await User.create({ name: 'G', tenant_id: 'globex' });
        tm.setCurrentTenant('acme');
        await User.create({ name: 'Alice' });

        const user = await User.findOne({});
        expect(user.name).toBe('Alice');
    });

    it('findById() scopes to tenant', async () =>
    {
        const g = await User.create({ name: 'G', tenant_id: 'globex' });
        tm.setCurrentTenant('acme');
        const a = await User.create({ name: 'Alice' });

        const found = await User.findById(a.id);
        expect(found).not.toBeNull();
        expect(found.name).toBe('Alice');
    });

    it('count() scopes to tenant', async () =>
    {
        await User.create({ name: 'G', tenant_id: 'globex' });
        tm.setCurrentTenant('acme');
        await User.create({ name: 'A1' });
        await User.create({ name: 'A2' });

        const count = await User.count({});
        expect(count).toBe(2);
    });

    it('exists() scopes to tenant', async () =>
    {
        await User.create({ name: 'G', tenant_id: 'globex' });
        tm.setCurrentTenant('acme');

        const exists = await User.exists({ name: 'G' });
        expect(exists).toBe(false);
    });

    it('query() scopes to tenant', async () =>
    {
        await User.create({ name: 'G', tenant_id: 'globex' });
        tm.setCurrentTenant('acme');
        await User.create({ name: 'Alice' });

        const results = await User.query().exec();
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('Alice');
    });

    it('does not double-register models', () =>
    {
        const sizeBefore = tm._models.size;
        tm.addModel(User);
        expect(tm._models.size).toBe(sizeBefore);
    });
});

// ===================================================================
// Tenant CRUD (row strategy)
// ===================================================================
describe('TenantManager — tenant CRUD', () =>
{
    let db, tm;

    beforeEach(() =>
    {
        db = memDb();
        tm = new TenantManager(db, { strategy: 'row' });
    });

    it('createTenant registers tenant', async () =>
    {
        await tm.createTenant('acme');
        expect(tm.hasTenant('acme')).toBe(true);
    });

    it('createTenant throws on empty id', async () =>
    {
        await expect(tm.createTenant('')).rejects.toThrow('non-empty string');
    });

    it('listTenants returns all known', async () =>
    {
        await tm.createTenant('acme');
        await tm.createTenant('globex');
        expect(tm.listTenants()).toEqual(expect.arrayContaining(['acme', 'globex']));
    });

    it('dropTenant removes from known list', async () =>
    {
        const User = makeModel(db, 'users', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            tenant_id: { type: 'string' },
        });
        await db.sync();
        tm.addModel(User);

        await tm.createTenant('acme');
        await tm.dropTenant('acme');
        expect(tm.hasTenant('acme')).toBe(false);
    });

    it('dropTenant throws on empty id', async () =>
    {
        await expect(tm.dropTenant('')).rejects.toThrow('non-empty string');
    });
});

// ===================================================================
// Middleware
// ===================================================================
describe('TenantManager — middleware', () =>
{
    let db, tm;

    beforeEach(() =>
    {
        db = memDb();
        tm = new TenantManager(db);
    });

    it('extracts tenant from header', () =>
    {
        const mw = tm.middleware({ header: 'x-tenant-id' });
        const req = { headers: { 'x-tenant-id': 'acme' }, query: {} };
        const res = {};
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called).toBe(true);
        expect(tm.getCurrentTenant()).toBe('acme');
        expect(req.tenantId).toBe('acme');
    });

    it('extracts from query param', () =>
    {
        const mw = tm.middleware({ queryParam: 'tenant' });
        const req = { headers: {}, query: { tenant: 'globex' } };
        const res = {};
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called).toBe(true);
        expect(tm.getCurrentTenant()).toBe('globex');
    });

    it('uses custom extract function', () =>
    {
        const mw = tm.middleware({ extract: (req) => req.custom });
        const req = { headers: {}, query: {}, custom: 'custom-tenant' };
        const res = {};
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called).toBe(true);
        expect(tm.getCurrentTenant()).toBe('custom-tenant');
    });

    it('rejects when required and no tenant', () =>
    {
        const mw = tm.middleware({ required: true });
        const req = { headers: {}, query: {} };
        let status, body;
        const res = {
            statusCode: 200,
            setHeader() {},
            end(d) { body = d; },
            set statusCode(v) { status = v; },
            get statusCode() { return status; },
        };
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called).toBe(false);
        expect(status).toBe(400);
    });

    it('passes when not required and no tenant', () =>
    {
        const mw = tm.middleware({ required: false });
        const req = { headers: {}, query: {} };
        const res = {};
        let called = false;
        mw(req, res, () => { called = true; });
        expect(called).toBe(true);
    });
});

// ===================================================================
// Schema-based tenancy (row fallback for memory adapter)
// ===================================================================
describe('TenantManager — schema strategy edge cases', () =>
{
    it('createTenant with schema strategy registers tenant when adapter has createTable', async () =>
    {
        const db = memDb();
        const tm = new TenantManager(db, { strategy: 'schema' });

        // Memory adapter has createTable, so this goes through the non-execute path
        // but the code checks for execute() specifically for schema strategy
        // If adapter lacks execute, createTenant still adds to known set for schema strategy
        await tm.createTenant('acme');
        expect(tm.hasTenant('acme')).toBe(true);
    });

    it('dropTenant with schema strategy removes tenant when adapter lacks execute', async () =>
    {
        const db = memDb();
        const tm = new TenantManager(db, { strategy: 'schema' });
        tm._knownTenants.add('acme');

        // Memory adapter doesn't have execute(), so this will throw
        // unless the code silently succeeds for non-SQL adapters
        await tm.dropTenant('acme');
        expect(tm.hasTenant('acme')).toBe(false);
    });
});

// ===================================================================
// Tenant-aware migrations
// ===================================================================
describe('TenantManager — migrations (row strategy)', () =>
{
    it('migrate delegates to migrator', async () =>
    {
        const db = memDb();
        const tm = new TenantManager(db, { strategy: 'row' });

        const mockMigrator = {
            migrate: vi.fn().mockResolvedValue({ migrated: ['m1'], batch: 1 }),
        };

        const result = await tm.migrate(mockMigrator, 'acme');
        expect(result.migrated).toEqual(['m1']);
        expect(mockMigrator.migrate).toHaveBeenCalled();
    });

    it('migrateAll runs for all known tenants', async () =>
    {
        const db = memDb();
        const tm = new TenantManager(db, { strategy: 'row' });
        tm._knownTenants.add('acme');
        tm._knownTenants.add('globex');

        const mockMigrator = {
            migrate: vi.fn().mockResolvedValue({ migrated: [], batch: 1 }),
        };

        const results = await tm.migrateAll(mockMigrator);
        expect(results.size).toBe(2);
        expect(mockMigrator.migrate).toHaveBeenCalledTimes(2);
    });
});

// ===================================================================
// TenantId format validation (security)
// ===================================================================
describe('TenantManager — tenantId format validation', () =>
{
    let db, tm;

    beforeEach(() =>
    {
        db = memDb();
        tm = new TenantManager(db, { strategy: 'row' });
    });

    it('setCurrentTenant rejects SQL injection characters', () =>
    {
        expect(() => tm.setCurrentTenant('acme; DROP TABLE')).toThrow('alphanumeric');
    });

    it('setCurrentTenant rejects special characters', () =>
    {
        expect(() => tm.setCurrentTenant('tenant@evil')).toThrow('alphanumeric');
        expect(() => tm.setCurrentTenant('tenant/path')).toThrow('alphanumeric');
        expect(() => tm.setCurrentTenant('name with spaces')).toThrow('alphanumeric');
    });

    it('setCurrentTenant rejects >128 characters', () =>
    {
        const longId = 'a'.repeat(129);
        expect(() => tm.setCurrentTenant(longId)).toThrow('max 128');
    });

    it('setCurrentTenant accepts valid tenant IDs', () =>
    {
        expect(() => tm.setCurrentTenant('acme')).not.toThrow();
        expect(() => tm.setCurrentTenant('tenant_1')).not.toThrow();
        expect(() => tm.setCurrentTenant('my-tenant')).not.toThrow();
        expect(() => tm.setCurrentTenant('ABC123')).not.toThrow();
        expect(() => tm.setCurrentTenant('a'.repeat(128))).not.toThrow();
    });

    it('createTenant rejects invalid format', async () =>
    {
        await db.sync();
        await expect(tm.createTenant('bad id!')).rejects.toThrow('alphanumeric');
        await expect(tm.createTenant('a'.repeat(200))).rejects.toThrow('max 128');
    });

    it('dropTenant rejects invalid format', async () =>
    {
        await db.sync();
        await expect(tm.dropTenant('bad id!')).rejects.toThrow('alphanumeric');
        await expect(tm.dropTenant('a'.repeat(200))).rejects.toThrow('max 128');
    });
});
