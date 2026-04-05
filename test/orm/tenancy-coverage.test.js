/**
 * Coverage tests for lib/orm/tenancy.js
 * Targets uncovered branches: schema strategy flows (createTenant/dropTenant with schema,
 * schema validation), findById _primaryKey array, row-level dropTenant delete,
 * schema-based migrate, and middleware edge cases.
 */

const { Database, Model, TYPES } = require('../../lib/orm');
const { TenantManager } = require('../../lib/orm/tenancy');

// --- mock model class ---------------------------------------------------------
function makeModel(name, overrides = {}) {
    const M = class extends Model {};
    M.table = name;
    M.schema = { id: { type: TYPES.INTEGER, primaryKey: true } };
    Object.assign(M, overrides);
    return M;
}

// --- schema strategy — createTenant / dropTenant --------------------------
describe('TenantManager — schema strategy flows', () => {
    let db;

    beforeEach(() => {
        db = Database.connect('memory');
    });
    afterEach(async () => {
        await db.close();
    });

    it('createTenant (schema) creates schema and syncs models', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);
        const Item = makeModel('items');
        Item.sync = vi.fn().mockResolvedValue();

        const tm = new TenantManager(db, { strategy: 'schema' });
        tm.addModel(Item);
        await tm.createTenant('acme');

        // Should have called CREATE SCHEMA
        const calls = adapter.execute.mock.calls.map(c => c[0].raw || '');
        expect(calls.some(s => s.includes('CREATE SCHEMA'))).toBe(true);
        // Should have called sync with modified table
        expect(Item.sync).toHaveBeenCalled();
        expect(tm.hasTenant('acme')).toBe(true);
    });

    it('createTenant (schema) throws on invalid schema name (dash in tenantId)', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);

        // tenant_acme-bad produces schema name "tenant_acme-bad" which has a dash
        const tm = new TenantManager(db, { strategy: 'schema' });
        await expect(tm.createTenant('acme-bad'))
            .rejects.toThrow('Invalid schema name');
    });

    it('createTenant (schema) throws without SQL adapter', async () => {
        const adapter = db.adapter;
        adapter.execute = null;
        const tm = new TenantManager(db, { strategy: 'schema' });
        await expect(tm.createTenant('test'))
            .rejects.toThrow('requires a SQL adapter');
    });

    it('dropTenant (schema) drops schema', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);

        const tm = new TenantManager(db, { strategy: 'schema' });
        tm._knownTenants.add('acme');
        await tm.dropTenant('acme');
        expect(tm.hasTenant('acme')).toBe(false);
        const calls = adapter.execute.mock.calls.map(c => c[0].raw || '');
        expect(calls.some(s => s.includes('DROP SCHEMA'))).toBe(true);
    });

    it('dropTenant (schema) with cascade', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);

        const tm = new TenantManager(db, { strategy: 'schema' });
        tm._knownTenants.add('old');
        await tm.dropTenant('old', { cascade: true });
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).toContain('CASCADE');
    });

    it('dropTenant (schema) throws on invalid schema name', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);

        const tm = new TenantManager(db, { strategy: 'schema' });
        tm._knownTenants.add('bad-name');
        await expect(tm.dropTenant('bad-name'))
            .rejects.toThrow('Invalid schema name');
    });

    it('dropTenant (schema) throws without SQL adapter', async () => {
        const adapter = db.adapter;
        adapter.execute = null;
        const tm = new TenantManager(db, { strategy: 'schema' });
        tm._knownTenants.add('test');
        await expect(tm.dropTenant('test'))
            .rejects.toThrow('requires a SQL adapter');
    });
});

// --- row-level dropTenant — delete rows -----------------------------------
describe('TenantManager — row-level dropTenant', () => {
    let db;

    beforeEach(() => {
        db = Database.connect('memory');
    });
    afterEach(async () => {
        await db.close();
    });

    it('dropTenant (row) deletes tenant rows from registered models', async () => {
        const tm = new TenantManager(db, { strategy: 'row' });
        const Item = makeModel('items');
        Item._adapter = {
            execute: vi.fn().mockResolvedValue([]),
        };
        tm.addModel(Item);
        tm._knownTenants.add('acme');
        await tm.dropTenant('acme');
        expect(Item._adapter.execute).toHaveBeenCalledWith(expect.objectContaining({
            action: 'delete',
            table: 'items',
        }));
        expect(tm.hasTenant('acme')).toBe(false);
    });

    it('dropTenant (row) skips models without _adapter', async () => {
        const tm = new TenantManager(db, { strategy: 'row' });
        const Item = makeModel('items');
        Item._adapter = null;
        tm.addModel(Item);
        tm._knownTenants.add('acme');
        // Should not throw
        await tm.dropTenant('acme');
    });
});

// --- findById with _primaryKey as array -----------------------------------
describe('TenantManager — findById with array primary key', () => {
    let db;

    beforeEach(() => {
        db = Database.connect('memory');
    });
    afterEach(async () => {
        await db.close();
    });

    it('findById uses first element of array _primaryKey', async () => {
        const tm = new TenantManager(db, { strategy: 'row' });
        const Item = makeModel('items');

        Item.query = () => ({ where: () => ({ exec: async () => [] }) });
        Item.create = async (d) => d;
        Item.createMany = async (d) => d;
        Item.find = async () => [];
        Item.findOne = async () => null;
        Item.findById = async (id) => ({ id });
        Item.count = async () => 0;
        Item.exists = async () => false;
        Item._primaryKey = () => ['uuid', 'version'];

        tm.addModel(Item);
        // Spy AFTER addModel so it's not wrapped
        Item.findOne = vi.fn().mockResolvedValue({ id: 1 });
        tm.setCurrentTenant('tenant1');

        await Item.findById('abc-123');
        expect(Item.findOne).toHaveBeenCalledWith(
            expect.objectContaining({ uuid: 'abc-123', tenant_id: 'tenant1' })
        );
    });

    it('findById uses string _primaryKey directly', async () => {
        const tm = new TenantManager(db, { strategy: 'row' });
        const Item = makeModel('items');

        Item.query = () => ({ where: () => ({ exec: async () => [] }) });
        Item.create = async (d) => d;
        Item.createMany = async (d) => d;
        Item.find = async () => [];
        Item.findOne = async () => null;
        Item.findById = async (id) => ({ id });
        Item.count = async () => 0;
        Item.exists = async () => false;
        Item._primaryKey = () => 'custom_id';

        tm.addModel(Item);
        Item.findOne = vi.fn().mockResolvedValue({ id: 1 });
        tm.setCurrentTenant('t1');

        await Item.findById(42);
        expect(Item.findOne).toHaveBeenCalledWith(
            expect.objectContaining({ custom_id: 42, tenant_id: 't1' })
        );
    });

    it('findById without _primaryKey defaults to "id"', async () => {
        const tm = new TenantManager(db, { strategy: 'row' });
        const Item = makeModel('items');

        Item.query = () => ({ where: () => ({ exec: async () => [] }) });
        Item.create = async (d) => d;
        Item.createMany = async (d) => d;
        Item.find = async () => [];
        Item.findOne = async () => null;
        Item.findById = async (id) => ({ id });
        Item.count = async () => 0;
        Item.exists = async () => false;
        // No _primaryKey method

        tm.addModel(Item);
        Item.findOne = vi.fn().mockResolvedValue(null);
        tm.setCurrentTenant('t1');

        await Item.findById(10);
        expect(Item.findOne).toHaveBeenCalledWith(
            expect.objectContaining({ id: 10, tenant_id: 't1' })
        );
    });
});

// --- schema-based migrate / migrateAll ------------------------------------
describe('TenantManager — schema-based migrations', () => {
    let db;

    beforeEach(() => {
        db = Database.connect('memory');
    });
    afterEach(async () => {
        await db.close();
    });

    it('migrate (schema) sets and restores search_path', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);
        const migrator = { migrate: vi.fn().mockResolvedValue({ migrated: 1 }) };

        const tm = new TenantManager(db, { strategy: 'schema' });
        const result = await tm.migrate(migrator, 'acme');

        const calls = adapter.execute.mock.calls.map(c => c[0].raw);
        expect(calls[0]).toContain('SET search_path TO "tenant_acme"');
        expect(calls[1]).toContain('SET search_path TO "public"');
        expect(result).toEqual({ migrated: 1 });
    });

    it('migrate (schema) restores search_path on error', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);
        const migrator = { migrate: vi.fn().mockRejectedValue(new Error('migration failed')) };

        const tm = new TenantManager(db, { strategy: 'schema' });
        await expect(tm.migrate(migrator, 'fail')).rejects.toThrow('migration failed');

        const calls = adapter.execute.mock.calls.map(c => c[0].raw);
        // Should still restore search_path in finally block
        expect(calls[1]).toContain('SET search_path TO "public"');
    });

    it('migrate (schema) throws without SQL adapter', async () => {
        const adapter = db.adapter;
        adapter.execute = null;
        const migrator = { migrate: vi.fn() };

        const tm = new TenantManager(db, { strategy: 'schema' });
        await expect(tm.migrate(migrator, 'x')).rejects.toThrow('requires a SQL adapter');
    });

    it('migrateAll iterates all known tenants', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);
        const migrator = { migrate: vi.fn().mockResolvedValue({ migrated: 0 }) };

        const tm = new TenantManager(db, { strategy: 'schema' });
        tm._knownTenants.add('a');
        tm._knownTenants.add('b');
        const results = await tm.migrateAll(migrator);
        expect(results.size).toBe(2);
        expect(results.get('a')).toEqual({ migrated: 0 });
    });
});

// --- middleware edge branches ---------------------------------------------
describe('TenantManager — middleware edges', () => {
    let db;

    beforeEach(() => {
        db = Database.connect('memory');
    });
    afterEach(async () => {
        await db.close();
    });

    it('middleware extracts from queryParam when no extract fn', () => {
        const tm = new TenantManager(db);
        const mw = tm.middleware({ queryParam: 'tid', required: false });
        const req = { headers: {}, query: { tid: 'q_tenant' } };
        const res = {};
        const next = vi.fn();
        mw(req, res, next);
        expect(tm.getCurrentTenant()).toBe('q_tenant');
        expect(req.tenantId).toBe('q_tenant');
        expect(next).toHaveBeenCalled();
    });

    it('middleware coerces numeric queryParam to string', () => {
        const tm = new TenantManager(db);
        const mw = tm.middleware({ queryParam: 'tid' });
        const req = { headers: {}, query: { tid: 123 } };
        const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
        const next = vi.fn();
        mw(req, res, next);
        expect(tm.getCurrentTenant()).toBe('123');
    });

    it('middleware falls through to header when queryParam absent', () => {
        const tm = new TenantManager(db);
        const mw = tm.middleware({ queryParam: 'tid', header: 'x-tenant-id' });
        const req = { headers: { 'x-tenant-id': 'from_header' }, query: {} };
        const res = {};
        const next = vi.fn();
        mw(req, res, next);
        expect(tm.getCurrentTenant()).toBe('from_header');
    });
});

// --- uncovered branches: setCurrentTenant non-string, model name fallback -----
describe('TenantManager — remaining branch coverage', () => {
    let db;

    beforeEach(() => {
        db = Database.connect('memory');
    });
    afterEach(async () => {
        await db.close();
    });

    it('setCurrentTenant throws on non-string truthy value', () => {
        const tm = new TenantManager(db, { strategy: 'row' });
        expect(() => tm.setCurrentTenant(42)).toThrow('non-empty string');
    });

    it('createTenant (schema) uses ModelClass.name when table is falsy', async () => {
        const adapter = db.adapter;
        adapter.execute = vi.fn().mockResolvedValue([]);

        // Model with no table set — falls back to class name
        const NoTable = makeModel(undefined);
        NoTable.table = undefined;
        NoTable.sync = vi.fn().mockResolvedValue();

        const tm = new TenantManager(db, { strategy: 'schema' });
        tm.addModel(NoTable);
        await tm.createTenant('acme');
        expect(NoTable.sync).toHaveBeenCalled();
    });

    it('dropTenant (row) uses ModelClass.name fallback for table', async () => {
        const tm = new TenantManager(db, { strategy: 'row' });
        const NoTable = makeModel(undefined);
        NoTable.table = undefined;
        NoTable._adapter = {
            execute: vi.fn().mockResolvedValue([]),
        };
        tm.addModel(NoTable);
        tm._knownTenants.add('acme');
        await tm.dropTenant('acme');
        // Should have used the class name
        expect(NoTable._adapter.execute).toHaveBeenCalledWith(expect.objectContaining({
            action: 'delete',
        }));
    });

    it('middleware without queryParam or header returns 400 when required', () => {
        const tm = new TenantManager(db);
        const mw = tm.middleware({ required: true });
        const req = { headers: {}, query: {} };
        const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
        const next = vi.fn();
        mw(req, res, next);
        expect(res.statusCode).toBe(400);
        expect(next).not.toHaveBeenCalled();
    });

    it('middleware without queryParam or header calls next when not required', () => {
        const tm = new TenantManager(db);
        const mw = tm.middleware({ required: false });
        const req = { headers: {}, query: {} };
        const res = {};
        const next = vi.fn();
        mw(req, res, next);
        expect(next).toHaveBeenCalled();
    });
});
