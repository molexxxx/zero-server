/**
 * Phase 4 — StoredProcedure, StoredFunction, TriggerManager tests
 */
const { StoredProcedure, StoredFunction, TriggerManager } = require('../../lib/orm/procedures');

// ===================================================================
// StoredProcedure — constructor
// ===================================================================
describe('StoredProcedure — constructor', () =>
{
    it('creates with valid args', () =>
    {
        const proc = new StoredProcedure('update_balance', {
            params: [{ name: 'user_id', type: 'INTEGER' }],
            body: 'UPDATE users SET bal = bal + 1;',
        });
        expect(proc.name).toBe('update_balance');
        expect(proc.params.length).toBe(1);
        expect(proc.body).toBe('UPDATE users SET bal = bal + 1;');
        expect(proc.language).toBe('sql');
    });

    it('throws without name', () =>
    {
        expect(() => new StoredProcedure('', { body: 'x' }))
            .toThrow('non-empty string name');
    });

    it('throws without body', () =>
    {
        expect(() => new StoredProcedure('proc', {}))
            .toThrow('"body" string');
    });

    it('throws on invalid name characters', () =>
    {
        expect(() => new StoredProcedure('drop; --', { body: 'x' }))
            .toThrow('Invalid procedure name');
    });

    it('throws on invalid param name', () =>
    {
        expect(() => new StoredProcedure('proc', {
            body: 'x',
            params: [{ name: '1bad', type: 'INT' }],
        })).toThrow('Invalid parameter name');
    });

    it('defaults params to empty array', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        expect(proc.params).toEqual([]);
    });

    it('accepts language option', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x', language: 'plpgsql' });
        expect(proc.language).toBe('plpgsql');
    });
});

// ===================================================================
// StoredProcedure — SQL generation
// ===================================================================
describe('StoredProcedure — SQL generation', () =>
{
    it('builds MySQL CREATE', () =>
    {
        const proc = new StoredProcedure('update_bal', {
            params: [
                { name: 'uid', type: 'INT', direction: 'IN' },
                { name: 'amt', type: 'DECIMAL' },
            ],
            body: 'UPDATE accounts SET bal = bal + amt WHERE id = uid;',
        });
        const sql = proc._buildCreateSQL('mysql');
        expect(sql).toContain('CREATE PROCEDURE');
        expect(sql).toContain('`update_bal`');
        expect(sql).toContain('IN `uid` INT');
        expect(sql).toContain('IN `amt` DECIMAL');
        expect(sql).toContain('BEGIN');
        expect(sql).toContain('END');
    });

    it('builds PostgreSQL CREATE', () =>
    {
        const proc = new StoredProcedure('update_bal', {
            params: [{ name: 'uid', type: 'INT' }],
            body: 'UPDATE accounts SET bal = 0;',
        });
        const sql = proc._buildCreateSQL('postgres');
        expect(sql).toContain('CREATE OR REPLACE PROCEDURE');
        expect(sql).toContain('"update_bal"');
        expect(sql).toContain('LANGUAGE SQL');
        expect(sql).toContain('$$');
    });

    it('throws for unsupported adapter', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        expect(() => proc._buildCreateSQL('unknown'))
            .toThrow('not supported');
    });
});

// ===================================================================
// StoredProcedure — adapter detection
// ===================================================================
describe('StoredProcedure — adapter detection', () =>
{
    it('detects mysql', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        class MysqlAdapter {}
        expect(proc._detectAdapter(new MysqlAdapter())).toBe('mysql');
    });

    it('detects postgres', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        class PostgresAdapter {}
        expect(proc._detectAdapter(new PostgresAdapter())).toBe('postgres');
    });

    it('detects pg', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        class PgAdapter {}
        expect(proc._detectAdapter(new PgAdapter())).toBe('postgres');
    });

    it('detects sqlite', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        class SqliteAdapter {}
        expect(proc._detectAdapter(new SqliteAdapter())).toBe('sqlite');
    });

    it('returns unknown for others', () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        class FooAdapter {}
        expect(proc._detectAdapter(new FooAdapter())).toBe('unknown');
    });
});

// ===================================================================
// StoredProcedure — create/drop/execute (mocked adapter)
// ===================================================================
describe('StoredProcedure — create / drop / execute', () =>
{
    it('create calls adapter.execute with raw sql', async () =>
    {
        const proc = new StoredProcedure('my_proc', {
            params: [{ name: 'x', type: 'INT' }],
            body: 'SELECT 1;',
        });
        class MysqlAdapter
        {
            execute = vi.fn();
        }
        const db = { adapter: new MysqlAdapter() };
        await proc.create(db);
        expect(db.adapter.execute).toHaveBeenCalledTimes(1);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('CREATE PROCEDURE');
    });

    it('create uses adapter.createProcedure if available', async () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        const db = { adapter: { createProcedure: vi.fn() } };
        await proc.create(db);
        expect(db.adapter.createProcedure).toHaveBeenCalled();
    });

    it('create throws without SQL adapter', async () =>
    {
        const proc = new StoredProcedure('proc', { body: 'x' });
        const db = { adapter: {} };
        await expect(proc.create(db)).rejects.toThrow('not supported');
    });

    it('drop calls adapter.execute', async () =>
    {
        const proc = new StoredProcedure('my_proc', { body: 'x' });
        class MysqlAdapter
        {
            execute = vi.fn();
        }
        const db = { adapter: new MysqlAdapter() };
        await proc.drop(db);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('DROP PROCEDURE');
        expect(arg.raw).toContain('IF EXISTS');
    });

    it('drop without ifExists', async () =>
    {
        const proc = new StoredProcedure('my_proc', { body: 'x' });
        class PostgresAdapter
        {
            execute = vi.fn();
        }
        const db = { adapter: new PostgresAdapter() };
        await proc.drop(db, { ifExists: false });
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).not.toContain('IF EXISTS');
    });

    it('execute calls CALL for mysql', async () =>
    {
        const proc = new StoredProcedure('my_proc', {
            params: [{ name: 'x', type: 'INT' }],
            body: 'SELECT 1;',
        });
        class MysqlAdapter
        {
            execute = vi.fn();
        }
        const db = { adapter: new MysqlAdapter() };
        await proc.execute(db, [42]);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('CALL');
        expect(arg.raw).toContain('`my_proc`');
        expect(arg.params).toEqual([42]);
    });

    it('execute uses $N placeholders for postgres', async () =>
    {
        const proc = new StoredProcedure('my_proc', {
            params: [{ name: 'a', type: 'INT' }, { name: 'b', type: 'TEXT' }],
            body: 'x',
        });
        class PostgresAdapter
        {
            execute = vi.fn();
        }
        const db = { adapter: new PostgresAdapter() };
        await proc.execute(db, [1, 'hello']);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('$1');
        expect(arg.raw).toContain('$2');
    });

    it('execute throws for sqlite', async () =>
    {
        const proc = new StoredProcedure('my_proc', { body: 'x' });
        class SqliteAdapter
        {
            execute = vi.fn();
        }
        const db = { adapter: new SqliteAdapter() };
        await expect(proc.execute(db, [])).rejects.toThrow('not supported');
    });

    it('exists returns false for non-SQL adapter', async () =>
    {
        const proc = new StoredProcedure('my_proc', { body: 'x' });
        const db = { adapter: {} };
        expect(await proc.exists(db)).toBe(false);
    });
});

// ===================================================================
// StoredFunction — constructor
// ===================================================================
describe('StoredFunction — constructor', () =>
{
    it('creates with valid args', () =>
    {
        const fn = new StoredFunction('calc_tax', {
            params: [{ name: 'amount', type: 'DECIMAL' }],
            returns: 'DECIMAL',
            body: 'RETURN amount * 0.08;',
        });
        expect(fn.name).toBe('calc_tax');
        expect(fn.returns).toBe('DECIMAL');
        expect(fn.deterministic).toBe(false);
    });

    it('throws without name', () =>
    {
        expect(() => new StoredFunction('', { returns: 'INT', body: 'x' }))
            .toThrow('non-empty string name');
    });

    it('throws without body', () =>
    {
        expect(() => new StoredFunction('fn', { returns: 'INT' }))
            .toThrow('"body" string');
    });

    it('throws without returns', () =>
    {
        expect(() => new StoredFunction('fn', { body: 'x' }))
            .toThrow('"returns" type string');
    });

    it('throws on invalid name', () =>
    {
        expect(() => new StoredFunction('bad name!', { returns: 'INT', body: 'x' }))
            .toThrow('Invalid function name');
    });

    it('throws on invalid param name', () =>
    {
        expect(() => new StoredFunction('fn', {
            returns: 'INT',
            body: 'x',
            params: [{ name: '1bad', type: 'INT' }],
        })).toThrow('Invalid parameter name');
    });

    it('accepts deterministic option', () =>
    {
        const fn = new StoredFunction('fn', {
            returns: 'INT', body: 'x', deterministic: true,
        });
        expect(fn.deterministic).toBe(true);
    });

    it('accepts volatility option', () =>
    {
        const fn = new StoredFunction('fn', {
            returns: 'INT', body: 'x', volatility: 'IMMUTABLE',
        });
        expect(fn.volatility).toBe('IMMUTABLE');
    });
});

// ===================================================================
// StoredFunction — SQL generation
// ===================================================================
describe('StoredFunction — SQL generation', () =>
{
    it('builds MySQL CREATE', () =>
    {
        const fn = new StoredFunction('calc', {
            params: [{ name: 'n', type: 'INT' }],
            returns: 'INT',
            body: 'RETURN n * 2;',
            deterministic: true,
        });
        const sql = fn._buildCreateSQL('mysql');
        expect(sql).toContain('CREATE FUNCTION');
        expect(sql).toContain('RETURNS INT');
        expect(sql).toContain('DETERMINISTIC');
        expect(sql).toContain('`calc`');
    });

    it('builds PostgreSQL CREATE', () =>
    {
        const fn = new StoredFunction('calc', {
            params: [{ name: 'n', type: 'INT' }],
            returns: 'INT',
            body: 'RETURN n * 2;',
            volatility: 'IMMUTABLE',
        });
        const sql = fn._buildCreateSQL('postgres');
        expect(sql).toContain('CREATE OR REPLACE FUNCTION');
        expect(sql).toContain('RETURNS INT');
        expect(sql).toContain('IMMUTABLE');
        expect(sql).toContain('"calc"');
    });

    it('throws for unsupported adapter', () =>
    {
        const fn = new StoredFunction('fn', { returns: 'INT', body: 'x' });
        expect(() => fn._buildCreateSQL('unknown')).toThrow('not supported');
    });

    it('omits DETERMINISTIC when false', () =>
    {
        const fn = new StoredFunction('fn', {
            params: [],
            returns: 'INT',
            body: 'RETURN 1;',
        });
        const sql = fn._buildCreateSQL('mysql');
        expect(sql).not.toContain('DETERMINISTIC');
    });
});

// ===================================================================
// StoredFunction — create/drop/call (mocked adapter)
// ===================================================================
describe('StoredFunction — create / drop / call', () =>
{
    it('create calls adapter.execute', async () =>
    {
        const fn = new StoredFunction('calc', { returns: 'INT', body: 'RETURN 1;' });
        class MysqlAdapter { execute = vi.fn(); }
        const db = { adapter: new MysqlAdapter() };
        await fn.create(db);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('CREATE FUNCTION');
    });

    it('create uses adapter.createFunction if available', async () =>
    {
        const fn = new StoredFunction('fn', { returns: 'INT', body: 'x' });
        const db = { adapter: { createFunction: vi.fn() } };
        await fn.create(db);
        expect(db.adapter.createFunction).toHaveBeenCalled();
    });

    it('drop calls adapter.execute', async () =>
    {
        const fn = new StoredFunction('calc', { returns: 'INT', body: 'x' });
        class MysqlAdapter { execute = vi.fn(); }
        const db = { adapter: new MysqlAdapter() };
        await fn.drop(db);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('DROP FUNCTION');
    });

    it('call generates SELECT for mysql', async () =>
    {
        const fn = new StoredFunction('calc', {
            params: [{ name: 'n', type: 'INT' }],
            returns: 'INT',
            body: 'RETURN n;',
        });
        class MysqlAdapter { execute = vi.fn().mockResolvedValue([{ result: 42 }]); }
        const db = { adapter: new MysqlAdapter() };
        const result = await fn.call(db, [42]);
        expect(result).toBe(42);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('SELECT');
        expect(arg.raw).toContain('`calc`');
    });

    it('call generates $N placeholders for postgres', async () =>
    {
        const fn = new StoredFunction('calc', {
            params: [{ name: 'a', type: 'INT' }, { name: 'b', type: 'INT' }],
            returns: 'INT',
            body: 'RETURN a + b;',
        });
        class PostgresAdapter { execute = vi.fn().mockResolvedValue([{ result: 3 }]); }
        const db = { adapter: new PostgresAdapter() };
        await fn.call(db, [1, 2]);
        const arg = db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('$1');
        expect(arg.raw).toContain('$2');
    });

    it('exists returns false for non-SQL adapter', async () =>
    {
        const fn = new StoredFunction('fn', { returns: 'INT', body: 'x' });
        const db = { adapter: {} };
        expect(await fn.exists(db)).toBe(false);
    });
});

// ===================================================================
// TriggerManager — constructor
// ===================================================================
describe('TriggerManager — constructor', () =>
{
    it('throws without db', () =>
    {
        expect(() => new TriggerManager()).toThrow('requires a Database');
    });

    it('creates with db', () =>
    {
        const db = { adapter: {} };
        const tm = new TriggerManager(db);
        expect(tm.db).toBe(db);
        expect(tm.list()).toEqual([]);
    });
});

// ===================================================================
// TriggerManager — define
// ===================================================================
describe('TriggerManager — define', () =>
{
    let tm;

    beforeEach(() =>
    {
        tm = new TriggerManager({ adapter: {} });
    });

    it('defines a valid trigger', () =>
    {
        tm.define('trg_audit', {
            table: 'users',
            timing: 'AFTER',
            event: 'INSERT',
            body: 'INSERT INTO log VALUES(1);',
        });
        expect(tm.list()).toEqual(['trg_audit']);
    });

    it('returns this for chaining', () =>
    {
        expect(tm.define('trg', {
            table: 'users', timing: 'AFTER', event: 'INSERT', body: 'x',
        })).toBe(tm);
    });

    it('throws on empty name', () =>
    {
        expect(() => tm.define('', { table: 'x', timing: 'AFTER', event: 'INSERT', body: 'x' }))
            .toThrow('non-empty string');
    });

    it('throws on invalid name', () =>
    {
        expect(() => tm.define('bad name!', { table: 'x', timing: 'AFTER', event: 'INSERT', body: 'x' }))
            .toThrow('Invalid trigger name');
    });

    it('throws without table', () =>
    {
        expect(() => tm.define('trg', { timing: 'AFTER', event: 'INSERT', body: 'x' }))
            .toThrow('"table" string');
    });

    it('throws on invalid timing', () =>
    {
        expect(() => tm.define('trg', { table: 'x', timing: 'DURING', event: 'INSERT', body: 'x' }))
            .toThrow('timing must be');
    });

    it('throws on invalid event', () =>
    {
        expect(() => tm.define('trg', { table: 'x', timing: 'AFTER', event: 'MERGE', body: 'x' }))
            .toThrow('event must be');
    });

    it('throws without body', () =>
    {
        expect(() => tm.define('trg', { table: 'x', timing: 'AFTER', event: 'INSERT' }))
            .toThrow('"body" string');
    });

    it('normalizes timing and event to uppercase', () =>
    {
        tm.define('trg', {
            table: 'users', timing: 'after', event: 'insert', body: 'x',
        });
        const def = tm.get('trg');
        expect(def.timing).toBe('AFTER');
        expect(def.event).toBe('INSERT');
    });

    it('accepts INSTEAD OF timing', () =>
    {
        tm.define('trg', {
            table: 'users', timing: 'INSTEAD OF', event: 'INSERT', body: 'x',
        });
        expect(tm.get('trg').timing).toBe('INSTEAD OF');
    });

    it('defaults forEach to ROW', () =>
    {
        tm.define('trg', {
            table: 'users', timing: 'AFTER', event: 'INSERT', body: 'x',
        });
        expect(tm.get('trg').forEach).toBe('ROW');
    });

    it('accepts when condition', () =>
    {
        tm.define('trg', {
            table: 'users', timing: 'AFTER', event: 'UPDATE', body: 'x', when: 'OLD.name != NEW.name',
        });
        expect(tm.get('trg').when).toBe('OLD.name != NEW.name');
    });
});

// ===================================================================
// TriggerManager — SQL generation
// ===================================================================
describe('TriggerManager — SQL generation', () =>
{
    let tm;

    beforeEach(() =>
    {
        tm = new TriggerManager({ adapter: {} });
        tm.define('trg_audit', {
            table: 'users',
            timing: 'AFTER',
            event: 'INSERT',
            body: 'INSERT INTO log VALUES(1);',
        });
    });

    it('builds MySQL DDL', () =>
    {
        const def = tm.get('trg_audit');
        const sql = tm._buildCreateSQL(def, 'mysql');
        expect(sql).toContain('CREATE TRIGGER');
        expect(sql).toContain('`trg_audit`');
        expect(sql).toContain('AFTER INSERT');
        expect(sql).toContain('`users`');
        expect(sql).toContain('FOR EACH ROW');
        expect(sql).toContain('BEGIN');
    });

    it('builds PostgreSQL DDL (with function)', () =>
    {
        const def = tm.get('trg_audit');
        const sql = tm._buildCreateSQL(def, 'postgres');
        expect(sql).toContain('CREATE OR REPLACE FUNCTION');
        expect(sql).toContain('trg_audit_fn');
        expect(sql).toContain('RETURNS TRIGGER');
        expect(sql).toContain('CREATE TRIGGER');
        expect(sql).toContain('"trg_audit"');
        expect(sql).toContain('EXECUTE FUNCTION');
    });

    it('builds SQLite DDL', () =>
    {
        const def = tm.get('trg_audit');
        const sql = tm._buildCreateSQL(def, 'sqlite');
        expect(sql).toContain('CREATE TRIGGER IF NOT EXISTS');
        expect(sql).toContain('"trg_audit"');
        expect(sql).toContain('AFTER INSERT');
    });

    it('includes WHEN clause if set', () =>
    {
        tm.define('trg_when', {
            table: 'users',
            timing: 'AFTER',
            event: 'UPDATE',
            body: 'x',
            when: 'OLD.name != NEW.name',
        });
        const def = tm.get('trg_when');
        const sql = tm._buildCreateSQL(def, 'sqlite');
        expect(sql).toContain('WHEN');
        expect(sql).toContain('OLD.name != NEW.name');
    });

    it('throws for unsupported adapter', () =>
    {
        const def = tm.get('trg_audit');
        expect(() => tm._buildCreateSQL(def, 'unknown')).toThrow('not supported');
    });
});

// ===================================================================
// TriggerManager — create/drop (mocked adapter)
// ===================================================================
describe('TriggerManager — create / drop', () =>
{
    it('create calls adapter.execute', async () =>
    {
        class MysqlAdapter { execute = vi.fn(); }
        const tm = new TriggerManager({ adapter: new MysqlAdapter() });
        tm.define('trg', {
            table: 'users', timing: 'AFTER', event: 'INSERT', body: 'x',
        });
        await tm.create('trg');
        expect(tm.db.adapter.execute).toHaveBeenCalledTimes(1);
    });

    it('create throws for undefined trigger', async () =>
    {
        const tm = new TriggerManager({ adapter: {} });
        await expect(tm.create('nope')).rejects.toThrow('not defined');
    });

    it('create uses adapter.createTrigger if available', async () =>
    {
        const adapter = { createTrigger: vi.fn() };
        const tm = new TriggerManager({ adapter });
        tm.define('trg', {
            table: 'users', timing: 'AFTER', event: 'INSERT', body: 'x',
        });
        await tm.create('trg');
        expect(adapter.createTrigger).toHaveBeenCalled();
    });

    it('createAll creates all triggers', async () =>
    {
        class MysqlAdapter { execute = vi.fn(); }
        const tm = new TriggerManager({ adapter: new MysqlAdapter() });
        tm.define('a', { table: 'x', timing: 'AFTER', event: 'INSERT', body: 'x' });
        tm.define('b', { table: 'x', timing: 'BEFORE', event: 'DELETE', body: 'x' });
        const names = await tm.createAll();
        expect(names).toEqual(['a', 'b']);
        expect(tm.db.adapter.execute).toHaveBeenCalledTimes(2);
    });

    it('drop calls adapter.execute', async () =>
    {
        class MysqlAdapter { execute = vi.fn(); }
        const tm = new TriggerManager({ adapter: new MysqlAdapter() });
        tm.define('trg', {
            table: 'users', timing: 'AFTER', event: 'INSERT', body: 'x',
        });
        await tm.drop('trg');
        const arg = tm.db.adapter.execute.mock.calls[0][0];
        expect(arg.raw).toContain('DROP TRIGGER');
    });

    it('drop removes from internal map', async () =>
    {
        class MysqlAdapter { execute = vi.fn(); }
        const tm = new TriggerManager({ adapter: new MysqlAdapter() });
        tm.define('trg', {
            table: 'users', timing: 'AFTER', event: 'INSERT', body: 'x',
        });
        await tm.drop('trg');
        expect(tm.list()).toEqual([]);
    });

    it('drop for postgres requires table', async () =>
    {
        class PostgresAdapter { execute = vi.fn(); }
        const tm = new TriggerManager({ adapter: new PostgresAdapter() });
        // No define, no table in options
        await expect(tm.drop('trg', { table: undefined })).rejects.toThrow('table name');
    });

    it('list returns trigger names', () =>
    {
        const tm = new TriggerManager({ adapter: {} });
        tm.define('a', { table: 'x', timing: 'AFTER', event: 'INSERT', body: 'x' });
        tm.define('b', { table: 'y', timing: 'BEFORE', event: 'UPDATE', body: 'x' });
        expect(tm.list()).toEqual(['a', 'b']);
    });

    it('get returns trigger def', () =>
    {
        const tm = new TriggerManager({ adapter: {} });
        tm.define('trg', { table: 'users', timing: 'AFTER', event: 'DELETE', body: 'x' });
        const def = tm.get('trg');
        expect(def.table).toBe('users');
        expect(def.event).toBe('DELETE');
    });

    it('get returns undefined for missing', () =>
    {
        const tm = new TriggerManager({ adapter: {} });
        expect(tm.get('nope')).toBeUndefined();
    });
});
