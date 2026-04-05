/**
 * Coverage tests for lib/orm/procedures.js
 * Targets uncovered branches in drop(), execute(), exists(),
 * _buildCreateSQL(), and TriggerManager operations with various adapter types.
 */

const { StoredProcedure, StoredFunction, TriggerManager } = require('../../lib/orm/procedures');

// --- Mock adapters -----------------------------------------------------------
function makeAdapter(name, overrides = {}) {
    class Adapter { constructor() {} }
    Object.defineProperty(Adapter, 'name', { value: name });
    const a = new Adapter();
    a.execute = vi.fn().mockResolvedValue([]);
    Object.assign(a, overrides);
    return a;
}

const mysqlAdapter    = () => makeAdapter('MysqlAdapter');
const postgresAdapter = () => makeAdapter('PostgresAdapter');
const sqliteAdapter   = () => makeAdapter('SqliteAdapter');
const unknownAdapter  = () => makeAdapter('MongoAdapter');
const noExecAdapter   = () => {
    const a = makeAdapter('SomeAdapter');
    delete a.execute;
    return a;
};

function proc(name = 'test_proc', opts = {}) {
    return new StoredProcedure(name, {
        body: 'SELECT 1;',
        params: [{ name: 'p1', type: 'INTEGER' }],
        ...opts,
    });
}

function fn(name = 'test_fn', opts = {}) {
    return new StoredFunction(name, {
        body: 'RETURN 1;',
        returns: 'INTEGER',
        params: [{ name: 'a', type: 'INTEGER' }],
        ...opts,
    });
}

// --- StoredProcedure — drop() branches -------------------------------------
describe('StoredProcedure — drop()', () => {
    it('drop with mysql adapter uses backticks', async () => {
        const adapter = mysqlAdapter();
        const p = proc();
        await p.drop({ adapter });
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringContaining('`test_proc`'),
        });
    });

    it('drop with postgres adapter includes param types', async () => {
        const adapter = postgresAdapter();
        const p = proc();
        await p.drop({ adapter });
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringMatching(/"test_proc"\(INTEGER\)/),
        });
    });

    it('drop with ifExists=false omits IF EXISTS', async () => {
        const adapter = mysqlAdapter();
        const p = proc();
        await p.drop({ adapter }, { ifExists: false });
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).not.toContain('IF EXISTS');
    });

    it('drop with unknown adapter uses generic SQL', async () => {
        const adapter = unknownAdapter();
        const p = proc();
        await p.drop({ adapter });
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringContaining('"test_proc"'),
        });
    });

    it('drop delegates to adapter.dropProcedure if available', async () => {
        const adapter = mysqlAdapter();
        adapter.dropProcedure = vi.fn().mockResolvedValue();
        const p = proc();
        await p.drop({ adapter }, { ifExists: true });
        expect(adapter.dropProcedure).toHaveBeenCalledWith('test_proc', { ifExists: true });
        expect(adapter.execute).not.toHaveBeenCalled();
    });

    it('drop throws without SQL adapter', async () => {
        const p = proc();
        await expect(p.drop({ adapter: noExecAdapter() }))
            .rejects.toThrow('requires a SQL adapter');
    });
});

// --- StoredProcedure — execute() branches ----------------------------------
describe('StoredProcedure — execute()', () => {
    it('execute calls CALL for mysql', async () => {
        const adapter = mysqlAdapter();
        const p = proc();
        await p.execute({ adapter }, [42]);
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: 'CALL `test_proc`(?)',
            params: [42],
        });
    });

    it('execute calls CALL with $N for postgres', async () => {
        const adapter = postgresAdapter();
        const p = proc();
        await p.execute({ adapter }, [1, 2]);
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: 'CALL "test_proc"($1, $2)',
            params: [1, 2],
        });
    });

    it('execute delegates to adapter.callProcedure if available', async () => {
        const adapter = mysqlAdapter();
        adapter.callProcedure = vi.fn().mockResolvedValue('result');
        const p = proc();
        const result = await p.execute({ adapter }, [99]);
        expect(adapter.callProcedure).toHaveBeenCalledWith('test_proc', [99]);
        expect(result).toBe('result');
    });

    it('execute throws for sqlite adapter', async () => {
        const adapter = sqliteAdapter();
        const p = proc();
        await expect(p.execute({ adapter }))
            .rejects.toThrow('not supported');
    });

    it('execute throws without SQL adapter', async () => {
        const p = proc();
        await expect(p.execute({ adapter: noExecAdapter() }))
            .rejects.toThrow('requires a SQL adapter');
    });
});

// --- StoredProcedure — exists() branches -----------------------------------
describe('StoredProcedure — exists()', () => {
    it('exists returns true when cnt > 0 for mysql', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue([{ cnt: 1 }]);
        const p = proc();
        expect(await p.exists({ adapter })).toBe(true);
    });

    it('exists returns false when cnt is 0 for postgres', async () => {
        const adapter = postgresAdapter();
        adapter.execute.mockResolvedValue([{ cnt: 0 }]);
        const p = proc();
        expect(await p.exists({ adapter })).toBe(false);
    });

    it('exists returns false for non-array result', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue(null);
        const p = proc();
        expect(await p.exists({ adapter })).toBe(false);
    });

    it('exists returns false for empty array result', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue([]);
        const p = proc();
        expect(await p.exists({ adapter })).toBe(false);
    });

    it('exists returns false for sqlite (unsupported)', async () => {
        const adapter = sqliteAdapter();
        const p = proc();
        expect(await p.exists({ adapter })).toBe(false);
    });

    it('exists returns false on adapter.execute error', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockRejectedValue(new Error('DB error'));
        const p = proc();
        expect(await p.exists({ adapter })).toBe(false);
    });
});

// --- StoredProcedure — _buildCreateSQL branches ----------------------------
describe('StoredProcedure — _buildCreateSQL()', () => {
    it('mysql build includes direction defaults to IN', () => {
        const p = proc('calc', {
            body: 'SET @x = 1;',
            params: [{ name: 'amt', type: 'DECIMAL' }],
        });
        const sql = p._buildCreateSQL('mysql');
        expect(sql).toContain('IN `amt` DECIMAL');
    });

    it('mysql build uses specified direction', () => {
        const p = proc('calc', {
            body: 'SET @x = 1;',
            params: [{ name: 'result', type: 'INTEGER', direction: 'OUT' }],
        });
        const sql = p._buildCreateSQL('mysql');
        expect(sql).toContain('OUT `result` INTEGER');
    });

    it('postgres build uses direction and language', () => {
        const p = proc('calc', {
            body: 'UPDATE t SET x = 1;',
            params: [{ name: 'val', type: 'INTEGER', direction: 'INOUT' }],
            language: 'plpgsql',
        });
        const sql = p._buildCreateSQL('postgres');
        expect(sql).toContain('INOUT "val" INTEGER');
        expect(sql).toContain('LANGUAGE PLPGSQL');
    });

    it('postgres build defaults language sql to SQL', () => {
        const p = proc('simple', { body: 'SELECT 1;' });
        const sql = p._buildCreateSQL('postgres');
        expect(sql).toContain('LANGUAGE SQL');
    });
});

// --- StoredFunction — drop() branches --------------------------------------
describe('StoredFunction — drop()', () => {
    it('drop with mysql adapter', async () => {
        const adapter = mysqlAdapter();
        const f = fn();
        await f.drop({ adapter });
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringContaining('`test_fn`'),
        });
    });

    it('drop with postgres adapter includes param types', async () => {
        const adapter = postgresAdapter();
        const f = fn();
        await f.drop({ adapter });
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringMatching(/"test_fn"\(INTEGER\)/),
        });
    });

    it('drop with ifExists=false', async () => {
        const adapter = mysqlAdapter();
        const f = fn();
        await f.drop({ adapter }, { ifExists: false });
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).not.toContain('IF EXISTS');
    });

    it('drop with unknown adapter uses generic SQL', async () => {
        const adapter = unknownAdapter();
        const f = fn();
        await f.drop({ adapter });
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringContaining('"test_fn"'),
        });
    });

    it('drop delegates to adapter.dropFunction if available', async () => {
        const adapter = mysqlAdapter();
        adapter.dropFunction = vi.fn().mockResolvedValue();
        const f = fn();
        await f.drop({ adapter });
        expect(adapter.dropFunction).toHaveBeenCalledWith('test_fn', {});
    });

    it('drop throws without SQL adapter', async () => {
        const f = fn();
        await expect(f.drop({ adapter: noExecAdapter() }))
            .rejects.toThrow('requires a SQL adapter');
    });
});

// --- StoredFunction — call() branches --------------------------------------
describe('StoredFunction — call()', () => {
    it('call with mysql uses backtick SELECT', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue([{ result: 42 }]);
        const f = fn();
        const res = await f.call({ adapter }, [10]);
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: 'SELECT `test_fn`(?) AS result',
            params: [10],
        });
        expect(res).toBe(42);
    });

    it('call with postgres uses $N placeholders', async () => {
        const adapter = postgresAdapter();
        adapter.execute.mockResolvedValue([{ result: 99 }]);
        const f = fn();
        const res = await f.call({ adapter }, [5, 6]);
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: 'SELECT "test_fn"($1, $2) AS result',
            params: [5, 6],
        });
    });

    it('call delegates to adapter.callFunction if available', async () => {
        const adapter = mysqlAdapter();
        adapter.callFunction = vi.fn().mockResolvedValue(100);
        const f = fn();
        const res = await f.call({ adapter }, [7]);
        expect(adapter.callFunction).toHaveBeenCalledWith('test_fn', [7]);
        expect(res).toBe(100);
    });

    it('call returns raw result when not array', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue('raw-value');
        const f = fn();
        const res = await f.call({ adapter }, []);
        expect(res).toBe('raw-value');
    });

    it('call returns raw result when array but empty', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue([]);
        const f = fn();
        const res = await f.call({ adapter }, []);
        expect(res).toEqual([]);
    });

    it('call throws without SQL adapter', async () => {
        const f = fn();
        await expect(f.call({ adapter: noExecAdapter() }))
            .rejects.toThrow('requires a SQL adapter');
    });
});

// --- StoredFunction — exists() branches ------------------------------------
describe('StoredFunction — exists()', () => {
    it('exists returns true for mysql when cnt > 0', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue([{ cnt: 3 }]);
        const f = fn();
        expect(await f.exists({ adapter })).toBe(true);
    });

    it('exists returns false for postgres when cnt is 0', async () => {
        const adapter = postgresAdapter();
        adapter.execute.mockResolvedValue([{ cnt: 0 }]);
        const f = fn();
        expect(await f.exists({ adapter })).toBe(false);
    });

    it('exists returns false for empty result array', async () => {
        const adapter = mysqlAdapter();
        adapter.execute.mockResolvedValue([]);
        const f = fn();
        expect(await f.exists({ adapter })).toBe(false);
    });

    it('exists returns false on error', async () => {
        const adapter = postgresAdapter();
        adapter.execute.mockRejectedValue(new Error('fail'));
        const f = fn();
        expect(await f.exists({ adapter })).toBe(false);
    });
});

// --- StoredFunction — _buildCreateSQL branches -----------------------------
describe('StoredFunction — _buildCreateSQL()', () => {
    it('mysql build includes DETERMINISTIC when true', () => {
        const f = fn('calc', {
            body: 'RETURN a * 2;',
            returns: 'INTEGER',
            params: [{ name: 'a', type: 'INTEGER' }],
            deterministic: true,
        });
        const sql = f._buildCreateSQL('mysql');
        expect(sql).toContain('DETERMINISTIC');
    });

    it('postgres build includes volatility', () => {
        const f = fn('get_val', {
            body: 'RETURN 1;',
            returns: 'INTEGER',
            volatility: 'IMMUTABLE',
        });
        const sql = f._buildCreateSQL('postgres');
        expect(sql).toContain('IMMUTABLE');
    });

    it('postgres build omits volatility when not set', () => {
        const f = fn('get_val', {
            body: 'RETURN 1;',
            returns: 'INTEGER',
        });
        const sql = f._buildCreateSQL('postgres');
        expect(sql).not.toContain('VOLATILE');
        expect(sql).not.toContain('IMMUTABLE');
    });
});

// --- TriggerManager — create flow with SQL adapter -------------------------
describe('TriggerManager — create/drop SQL paths', () => {
    const trigDef = {
        table: 'users',
        timing: 'AFTER',
        event: 'INSERT',
        body: 'INSERT INTO log VALUES(NEW.id);',
    };

    it('create with mysql adapter executes raw SQL', async () => {
        const adapter = mysqlAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_test', trigDef);
        await tm.create('trg_test');
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringContaining('CREATE TRIGGER'),
        });
    });

    it('create with postgres adapter builds function + trigger', async () => {
        const adapter = postgresAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_pg', trigDef);
        await tm.create('trg_pg');
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).toContain('CREATE OR REPLACE FUNCTION');
        expect(sql).toContain('EXECUTE FUNCTION');
    });

    it('create with sqlite adapter builds trigger SQL', async () => {
        const adapter = sqliteAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_lite', trigDef);
        await tm.create('trg_lite');
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).toContain('CREATE TRIGGER IF NOT EXISTS');
    });

    it('create throws for undefined trigger', async () => {
        const adapter = mysqlAdapter();
        const tm = new TriggerManager({ adapter });
        await expect(tm.create('missing'))
            .rejects.toThrow('not defined');
    });

    it('create throws without SQL adapter', async () => {
        const tm = new TriggerManager({ adapter: noExecAdapter() });
        tm.define('trg_no', trigDef);
        await expect(tm.create('trg_no'))
            .rejects.toThrow('requires a SQL adapter');
    });

    it('drop with mysql adapter', async () => {
        const adapter = mysqlAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_drop', trigDef);
        await tm.drop('trg_drop');
        expect(adapter.execute).toHaveBeenCalledWith({
            raw: expect.stringContaining('DROP TRIGGER'),
        });
    });

    it('drop with postgres adapter includes table', async () => {
        const adapter = postgresAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_pg_drop', trigDef);
        await tm.drop('trg_pg_drop');
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).toContain('ON "users"');
    });

    it('drop with postgres requires table name', async () => {
        const adapter = postgresAdapter();
        const tm = new TriggerManager({ adapter });
        // Not defined, no table available
        await expect(tm.drop('trg_no_table'))
            .rejects.toThrow('requires table name');
    });

    it('drop with sqlite adapter', async () => {
        const adapter = sqliteAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_lite_drop', trigDef);
        await tm.drop('trg_lite_drop');
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).toContain('DROP TRIGGER');
    });

    it('drop with unknown adapter uses generic SQL', async () => {
        const adapter = unknownAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_unk', trigDef);
        await tm.drop('trg_unk');
        expect(adapter.execute).toHaveBeenCalled();
    });

    it('drop with ifExists=false', async () => {
        const adapter = mysqlAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_no_ie', trigDef);
        await tm.drop('trg_no_ie', { ifExists: false });
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).not.toContain('IF EXISTS');
    });

    it('drop throws without SQL adapter', async () => {
        const tm = new TriggerManager({ adapter: noExecAdapter() });
        tm.define('trg_no2', trigDef);
        await expect(tm.drop('trg_no2'))
            .rejects.toThrow('requires a SQL adapter');
    });

    it('drop delegates to adapter.dropTrigger if available', async () => {
        const adapter = mysqlAdapter();
        adapter.dropTrigger = vi.fn().mockResolvedValue();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_del', trigDef);
        await tm.drop('trg_del');
        expect(adapter.dropTrigger).toHaveBeenCalled();
    });

    it('create delegates to adapter.createTrigger if available', async () => {
        const adapter = mysqlAdapter();
        adapter.createTrigger = vi.fn().mockResolvedValue();
        const tm = new TriggerManager({ adapter });
        tm.define('trg_ct', trigDef);
        await tm.create('trg_ct');
        expect(adapter.createTrigger).toHaveBeenCalled();
    });

    it('_buildCreateSQL throws for unknown adapter', () => {
        const adapter = unknownAdapter();
        const tm = new TriggerManager({ adapter });
        const def = { name: 'x', table: 't', timing: 'AFTER', event: 'INSERT', body: 'B', forEach: 'ROW', when: null };
        expect(() => tm._buildCreateSQL(def, 'unknown'))
            .toThrow('not supported');
    });

    it('_buildCreateSQL includes WHEN clause for mysql', () => {
        const adapter = mysqlAdapter();
        const tm = new TriggerManager({ adapter });
        const def = { name: 'x', table: 't', timing: 'BEFORE', event: 'UPDATE', body: 'B', forEach: 'ROW', when: 'NEW.active = 1' };
        const sql = tm._buildCreateSQL(def, 'mysql');
        expect(sql).toContain('WHEN (NEW.active = 1)');
    });

    it('_buildCreateSQL includes WHEN clause for postgres', () => {
        const adapter = postgresAdapter();
        const tm = new TriggerManager({ adapter });
        const def = { name: 'x', table: 't', timing: 'BEFORE', event: 'UPDATE', body: 'B', forEach: 'ROW', when: 'NEW.x > 0' };
        const sql = tm._buildCreateSQL(def, 'postgres');
        expect(sql).toContain('WHEN (NEW.x > 0)');
    });

    it('_buildCreateSQL includes WHEN for sqlite', () => {
        const adapter = sqliteAdapter();
        const tm = new TriggerManager({ adapter });
        const def = { name: 'x', table: 't', timing: 'AFTER', event: 'DELETE', body: 'B', forEach: 'ROW', when: 'OLD.active = 1' };
        const sql = tm._buildCreateSQL(def, 'sqlite');
        expect(sql).toContain('WHEN OLD.active = 1');
    });
});

// --- TriggerManager — createAll / list / get -------------------------------
describe('TriggerManager — utility methods', () => {
    it('createAll creates all defined triggers', async () => {
        const adapter = mysqlAdapter();
        const tm = new TriggerManager({ adapter });
        tm.define('a', { table: 't', timing: 'AFTER', event: 'INSERT', body: 'B' });
        tm.define('b', { table: 't', timing: 'BEFORE', event: 'DELETE', body: 'B' });
        const names = await tm.createAll();
        expect(names).toEqual(['a', 'b']);
        expect(adapter.execute).toHaveBeenCalledTimes(2);
    });

    it('get() returns undefined for non-existent trigger', () => {
        const tm = new TriggerManager({ adapter: mysqlAdapter() });
        expect(tm.get('nope')).toBeUndefined();
    });
});

// --- StoredProcedure — create flow -----------------------------------------
describe('StoredProcedure — create()', () => {
    it('create throws without SQL adapter (no execute)', async () => {
        const a = makeAdapter('MysqlAdapter');
        delete a.execute;
        const p = proc();
        await expect(p.create({ adapter: a }))
            .rejects.toThrow('requires a SQL adapter');
    });

    it('create with mysql adapter executes raw SQL', async () => {
        const adapter = mysqlAdapter();
        const p = proc('my_proc', {
            body: 'SELECT 1;',
            params: [{ name: 'x', type: 'INT' }],
        });
        await p.create({ adapter });
        const sql = adapter.execute.mock.calls[0][0].raw;
        expect(sql).toContain('CREATE PROCEDURE');
        expect(sql).toContain('`my_proc`');
    });
});

// --- StoredFunction — create flow ------------------------------------------
describe('StoredFunction — create()', () => {
    it('create throws without SQL adapter', async () => {
        const a = makeAdapter('MysqlAdapter');
        delete a.execute;
        const f = fn();
        await expect(f.create({ adapter: a }))
            .rejects.toThrow('requires a SQL adapter');
    });
});
