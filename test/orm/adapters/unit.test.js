/**
 * Unit tests for MySQL, PostgreSQL, and MongoDB adapter pure methods.
 * Tests _typeMap, _q, _safeIdent, _buildWherePg, _buildWhereFromChainPg,
 * _buildFilter, _buildFilterFromChain, _opToMongo, stmtCacheStats, etc.
 *
 * No real database connections required — constructor require() calls are mocked.
 */

// ============================================================
//  MySQL Adapter
// ============================================================
describe('MysqlAdapter pure methods', () =>
{
    let MysqlAdapter, adapter;

    beforeEach(() =>
    {
        // Mock mysql2/promise so the constructor doesn't throw
        vi.doMock('mysql2/promise', () => ({
            createPool: () => ({ execute: vi.fn(), query: vi.fn(), end: vi.fn() }),
        }));
        // Clear require cache to pick up mock
        delete require.cache[require.resolve('../../../lib/orm/adapters/mysql')];
        MysqlAdapter = require('../../../lib/orm/adapters/mysql');
        adapter = new MysqlAdapter({ database: 'test_db' });
    });

    // -- _typeMap -------------------------------------------
    describe('_typeMap', () =>
    {
        it('maps basic types correctly', () =>
        {
            expect(adapter._typeMap({ type: 'string' })).toBe('VARCHAR(255)');
            expect(adapter._typeMap({ type: 'string', maxLength: 100 })).toBe('VARCHAR(100)');
            expect(adapter._typeMap({ type: 'text' })).toBe('TEXT');
            expect(adapter._typeMap({ type: 'integer' })).toBe('INT');
            expect(adapter._typeMap({ type: 'float' })).toBe('DOUBLE');
            expect(adapter._typeMap({ type: 'boolean' })).toBe('TINYINT(1)');
            expect(adapter._typeMap({ type: 'date' })).toBe('DATE');
            expect(adapter._typeMap({ type: 'datetime' })).toBe('DATETIME');
            expect(adapter._typeMap({ type: 'json' })).toBe('JSON');
            expect(adapter._typeMap({ type: 'blob' })).toBe('BLOB');
            expect(adapter._typeMap({ type: 'uuid' })).toBe('CHAR(36)');
        });

        it('maps extended numeric types', () =>
        {
            expect(adapter._typeMap({ type: 'bigint' })).toBe('BIGINT');
            expect(adapter._typeMap({ type: 'smallint' })).toBe('SMALLINT');
            expect(adapter._typeMap({ type: 'tinyint' })).toBe('TINYINT');
            expect(adapter._typeMap({ type: 'decimal' })).toBe('DECIMAL(10,2)');
            expect(adapter._typeMap({ type: 'decimal', precision: 8, scale: 4 })).toBe('DECIMAL(8,4)');
            expect(adapter._typeMap({ type: 'double' })).toBe('DOUBLE');
            expect(adapter._typeMap({ type: 'real' })).toBe('REAL');
        });

        it('maps text/blob variants', () =>
        {
            expect(adapter._typeMap({ type: 'mediumtext' })).toBe('MEDIUMTEXT');
            expect(adapter._typeMap({ type: 'longtext' })).toBe('LONGTEXT');
            expect(adapter._typeMap({ type: 'mediumblob' })).toBe('MEDIUMBLOB');
            expect(adapter._typeMap({ type: 'longblob' })).toBe('LONGBLOB');
        });

        it('maps temporal types', () =>
        {
            expect(adapter._typeMap({ type: 'timestamp' })).toBe('TIMESTAMP');
            expect(adapter._typeMap({ type: 'time' })).toBe('TIME');
            expect(adapter._typeMap({ type: 'year' })).toBe('YEAR');
        });

        it('maps binary types with lengths', () =>
        {
            expect(adapter._typeMap({ type: 'binary' })).toBe('BINARY(255)');
            expect(adapter._typeMap({ type: 'binary', length: 16 })).toBe('BINARY(16)');
            expect(adapter._typeMap({ type: 'varbinary' })).toBe('VARBINARY(255)');
            expect(adapter._typeMap({ type: 'varbinary', length: 64 })).toBe('VARBINARY(64)');
        });

        it('maps ENUM with escaping', () =>
        {
            expect(adapter._typeMap({ type: 'enum', enum: ['a', 'b', 'c'] })).toBe("ENUM('a','b','c')");
            expect(adapter._typeMap({ type: 'enum', enum: ["it's", "they're"] })).toBe("ENUM('it''s','they''re')");
            expect(adapter._typeMap({ type: 'enum' })).toBe('VARCHAR(255)');
        });

        it('maps SET with escaping', () =>
        {
            expect(adapter._typeMap({ type: 'set', values: ['x', 'y'] })).toBe("SET('x','y')");
            expect(adapter._typeMap({ type: 'set' })).toBe('VARCHAR(255)');
        });

        it('falls back to TEXT for unknown types', () =>
        {
            expect(adapter._typeMap({ type: 'unknown_type' })).toBe('TEXT');
        });
    });

    // -- _q (backtick quoting) ------------------------------
    describe('_q', () =>
    {
        it('wraps name in backticks', () =>
        {
            expect(adapter._q('users')).toBe('`users`');
        });

        it('escapes backticks within name', () =>
        {
            expect(adapter._q('user`table')).toBe('`user``table`');
        });

        it('handles empty string', () =>
        {
            expect(adapter._q('')).toBe('``');
        });
    });

    // -- _safeIdent (SQL injection prevention) ---------------
    describe('_safeIdent', () =>
    {
        it('accepts valid identifiers', () =>
        {
            expect(adapter._safeIdent('InnoDB')).toBe('InnoDB');
            expect(adapter._safeIdent('utf8mb4')).toBe('utf8mb4');
            expect(adapter._safeIdent('utf8mb4_unicode_ci')).toBe('utf8mb4_unicode_ci');
            expect(adapter._safeIdent('some-engine')).toBe('some-engine');
        });

        it('rejects SQL injection attempts', () =>
        {
            expect(() => adapter._safeIdent('InnoDB; DROP TABLE users')).toThrow('Invalid identifier');
            expect(() => adapter._safeIdent('utf8mb4\'; --')).toThrow('Invalid identifier');
            expect(() => adapter._safeIdent('a b')).toThrow('Invalid identifier');
            expect(() => adapter._safeIdent('(SELECT 1)')).toThrow('Invalid identifier');
            expect(() => adapter._safeIdent('')).toThrow('Invalid identifier');
        });

        it('converts non-string values to string first', () =>
        {
            expect(adapter._safeIdent(42)).toBe('42');
        });
    });

    // -- Constructor error when mysql2 is missing -----------
    // Tested in adapters.test.js via structural checks
});


// ============================================================
//  PostgreSQL Adapter
// ============================================================
describe('PostgresAdapter pure methods', () =>
{
    let PostgresAdapter, adapter;

    beforeEach(() =>
    {
        vi.doMock('pg', () => ({
            Pool: class MockPool {
                constructor() { this.options = { max: 10 }; }
                query() { return { rows: [] }; }
                connect() { return { release: vi.fn() }; }
                end() {}
            },
        }));
        delete require.cache[require.resolve('../../../lib/orm/adapters/postgres')];
        PostgresAdapter = require('../../../lib/orm/adapters/postgres');
        adapter = new PostgresAdapter({ database: 'test_db' });
    });

    // -- _typeMap -------------------------------------------
    describe('_typeMap', () =>
    {
        it('maps basic types', () =>
        {
            expect(adapter._typeMap({ type: 'string' })).toBe('VARCHAR(255)');
            expect(adapter._typeMap({ type: 'string', maxLength: 50 })).toBe('VARCHAR(50)');
            expect(adapter._typeMap({ type: 'text' })).toBe('TEXT');
            expect(adapter._typeMap({ type: 'integer' })).toBe('INTEGER');
            expect(adapter._typeMap({ type: 'float' })).toBe('DOUBLE PRECISION');
            expect(adapter._typeMap({ type: 'boolean' })).toBe('BOOLEAN');
            expect(adapter._typeMap({ type: 'date' })).toBe('DATE');
            expect(adapter._typeMap({ type: 'datetime' })).toBe('TIMESTAMPTZ');
            expect(adapter._typeMap({ type: 'json' })).toBe('JSONB');
            expect(adapter._typeMap({ type: 'blob' })).toBe('BYTEA');
            expect(adapter._typeMap({ type: 'uuid' })).toBe('UUID');
        });

        it('maps PG-specific types', () =>
        {
            expect(adapter._typeMap({ type: 'serial' })).toBe('SERIAL');
            expect(adapter._typeMap({ type: 'bigserial' })).toBe('BIGSERIAL');
            expect(adapter._typeMap({ type: 'jsonb' })).toBe('JSONB');
            expect(adapter._typeMap({ type: 'inet' })).toBe('INET');
            expect(adapter._typeMap({ type: 'cidr' })).toBe('CIDR');
            expect(adapter._typeMap({ type: 'macaddr' })).toBe('MACADDR');
            expect(adapter._typeMap({ type: 'money' })).toBe('MONEY');
            expect(adapter._typeMap({ type: 'xml' })).toBe('XML');
            expect(adapter._typeMap({ type: 'citext' })).toBe('CITEXT');
            expect(adapter._typeMap({ type: 'interval' })).toBe('INTERVAL');
        });

        it('maps array types', () =>
        {
            expect(adapter._typeMap({ type: 'array', arrayOf: 'INTEGER' })).toBe('INTEGER[]');
            expect(adapter._typeMap({ type: 'array' })).toBe('TEXT[]');
        });

        it('maps enum with CHECK constraint', () =>
        {
            const result = adapter._typeMap({ type: 'enum', enum: ['a', 'b'], _name: 'status' });
            expect(result).toContain('VARCHAR(255)');
            expect(result).toContain('CHECK');
            expect(result).toContain("'a'");
            expect(result).toContain("'b'");
        });

        it('escapes quotes in enum values', () =>
        {
            const result = adapter._typeMap({ type: 'enum', enum: ["it's"], _name: 'col' });
            expect(result).toContain("'it''s'");
        });

        it('maps char with length', () =>
        {
            expect(adapter._typeMap({ type: 'char', length: 5 })).toBe('CHAR(5)');
            expect(adapter._typeMap({ type: 'char' })).toBe('CHAR(1)');
        });

        it('maps numeric precision types', () =>
        {
            expect(adapter._typeMap({ type: 'decimal' })).toBe('NUMERIC(10,2)');
            expect(adapter._typeMap({ type: 'decimal', precision: 12, scale: 6 })).toBe('NUMERIC(12,6)');
        });

        it('falls back to TEXT for unknown', () =>
        {
            expect(adapter._typeMap({ type: 'nope' })).toBe('TEXT');
        });
    });

    // -- _buildWherePg --------------------------------------
    describe('_buildWherePg', () =>
    {
        it('returns empty for null/undefined/empty', () =>
        {
            expect(adapter._buildWherePg(null)).toEqual({ clause: '', values: [], nextIdx: 1 });
            expect(adapter._buildWherePg(undefined)).toEqual({ clause: '', values: [], nextIdx: 1 });
            expect(adapter._buildWherePg({})).toEqual({ clause: '', values: [], nextIdx: 1 });
        });

        it('builds single condition with $1', () =>
        {
            const r = adapter._buildWherePg({ name: 'Alice' });
            expect(r.clause).toBe(' WHERE "name" = $1');
            expect(r.values).toEqual(['Alice']);
            expect(r.nextIdx).toBe(2);
        });

        it('handles NULL values', () =>
        {
            const r = adapter._buildWherePg({ deleted: null, name: 'Bob' });
            expect(r.clause).toBe(' WHERE "deleted" IS NULL AND "name" = $1');
            expect(r.values).toEqual(['Bob']);
        });

        it('starts from custom index', () =>
        {
            const r = adapter._buildWherePg({ name: 'Alice' }, 5);
            expect(r.clause).toBe(' WHERE "name" = $5');
            expect(r.nextIdx).toBe(6);
        });

        it('handles multiple conditions', () =>
        {
            const r = adapter._buildWherePg({ a: 1, b: 2, c: null });
            expect(r.clause).toBe(' WHERE "a" = $1 AND "b" = $2 AND "c" IS NULL');
            expect(r.values).toEqual([1, 2]);
            expect(r.nextIdx).toBe(3);
        });
    });

    // -- _buildWhereFromChainPg ----------------------------
    describe('_buildWhereFromChainPg', () =>
    {
        it('returns empty for empty input', () =>
        {
            expect(adapter._buildWhereFromChainPg([])).toEqual({ clause: '', values: [], nextIdx: 1 });
            expect(adapter._buildWhereFromChainPg(null)).toEqual({ clause: '', values: [], nextIdx: 1 });
        });

        it('builds comparison with $N params', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'age', op: '>', value: 18, logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE "age" > $1');
            expect(r.values).toEqual([18]);
        });

        it('handles raw WHERE with ? → $N conversion', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { raw: 'score > ? AND score < ?', params: [10, 90], logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE score > $1 AND score < $2');
            expect(r.values).toEqual([10, 90]);
        });

        it('handles raw with mixed normal conditions', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'name', op: '=', value: 'Alice', logic: 'AND' },
                { raw: 'score > ?', params: [50], logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE "name" = $1 AND score > $2');
            expect(r.values).toEqual(['Alice', 50]);
        });

        it('builds IS NULL / IS NOT NULL', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'x', op: 'IS NULL', logic: 'AND' },
                { field: 'y', op: 'IS NOT NULL', logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE "x" IS NULL AND "y" IS NOT NULL');
            expect(r.values).toEqual([]);
        });

        it('builds IN with $N placeholders', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'role', op: 'IN', value: ['admin', 'mod', 'user'], logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE "role" IN ($1, $2, $3)');
            expect(r.values).toEqual(['admin', 'mod', 'user']);
        });

        it('IN with empty array → 0=1', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'role', op: 'IN', value: [], logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE 0=1');
        });

        it('NOT IN with empty array → 1=1', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'role', op: 'NOT IN', value: [], logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE 1=1');
        });

        it('builds BETWEEN with $N', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'age', op: 'BETWEEN', value: [18, 65], logic: 'AND' },
            ]);
            expect(r.clause).toBe(' WHERE "age" BETWEEN $1 AND $2');
            expect(r.values).toEqual([18, 65]);
        });

        it('handles OR logic', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'a', op: '=', value: 1, logic: 'AND' },
                { field: 'b', op: '=', value: 2, logic: 'OR' },
            ]);
            expect(r.clause).toBe(' WHERE "a" = $1 OR "b" = $2');
        });

        it('starts from custom index', () =>
        {
            const r = adapter._buildWhereFromChainPg([
                { field: 'x', op: '=', value: 'a', logic: 'AND' },
            ], 5);
            expect(r.clause).toBe(' WHERE "x" = $5');
            expect(r.nextIdx).toBe(6);
        });
    });

    // -- stmtCacheStats ------------------------------------
    describe('stmtCacheStats', () =>
    {
        it('returns initial stats', () =>
        {
            const stats = adapter.stmtCacheStats();
            expect(stats).toEqual({
                size: 0,
                maxSize: 256,
                hits: 0,
                misses: 0,
                hitRate: 0,
            });
        });

        it('reflects custom cache size', () =>
        {
            const a = new PostgresAdapter({ database: 'test', stmtCacheSize: 128 });
            expect(a.stmtCacheStats().maxSize).toBe(128);
        });

        it('computes hitRate correctly', () =>
        {
            adapter._stmtCacheHits = 3;
            adapter._stmtCacheMisses = 1;
            const stats = adapter.stmtCacheStats();
            expect(stats.hitRate).toBe(0.75);
            expect(stats.hits).toBe(3);
            expect(stats.misses).toBe(1);
        });
    });

    // -- Constructor error ----------------------------------
    // Tested in adapters.test.js via structural checks
});


// ============================================================
//  MongoDB Adapter
// ============================================================
describe('MongoAdapter pure methods', () =>
{
    let MongoAdapter, adapter;

    beforeEach(() =>
    {
        vi.doMock('mongodb', () => ({
            MongoClient: class MockMongoClient {
                constructor() {}
                connect() { return Promise.resolve(); }
                close() { return Promise.resolve(); }
                db() { return {}; }
                startSession() { return { startTransaction: vi.fn(), commitTransaction: vi.fn(), abortTransaction: vi.fn(), endSession: vi.fn() }; }
            },
        }));
        delete require.cache[require.resolve('../../../lib/orm/adapters/mongo')];
        MongoAdapter = require('../../../lib/orm/adapters/mongo');
        adapter = new MongoAdapter({ database: 'test_db' });
    });

    // -- _buildFilter ---------------------------------------
    describe('_buildFilter', () =>
    {
        it('returns empty object for null/undefined/empty', () =>
        {
            expect(adapter._buildFilter(null)).toEqual({});
            expect(adapter._buildFilter(undefined)).toEqual({});
            expect(adapter._buildFilter({})).toEqual({});
        });

        it('builds simple key:value filter', () =>
        {
            expect(adapter._buildFilter({ name: 'Alice', age: 30 }))
                .toEqual({ name: 'Alice', age: 30 });
        });

        it('handles null values', () =>
        {
            expect(adapter._buildFilter({ deleted: null }))
                .toEqual({ deleted: null });
        });
    });

    // -- _buildFilterFromChain ------------------------------
    describe('_buildFilterFromChain', () =>
    {
        it('returns empty for null/empty', () =>
        {
            expect(adapter._buildFilterFromChain(null)).toEqual({});
            expect(adapter._buildFilterFromChain([])).toEqual({});
        });

        it('builds single AND condition', () =>
        {
            const result = adapter._buildFilterFromChain([
                { field: 'name', op: '=', value: 'Alice', logic: 'AND' },
            ]);
            expect(result).toEqual({ name: 'Alice' });
        });

        it('builds multiple AND conditions with $and', () =>
        {
            const result = adapter._buildFilterFromChain([
                { field: 'name', op: '=', value: 'Alice', logic: 'AND' },
                { field: 'age', op: '>', value: 18, logic: 'AND' },
            ]);
            expect(result).toEqual({ $and: [{ name: 'Alice' }, { age: { $gt: 18 } }] });
        });

        it('builds OR conditions with $or', () =>
        {
            const result = adapter._buildFilterFromChain([
                { field: 'role', op: '=', value: 'admin', logic: 'AND' },
                { field: 'role', op: '=', value: 'mod', logic: 'OR' },
            ]);
            expect(result).toEqual({ $or: [{ role: 'admin' }, { role: 'mod' }] });
        });

        it('handles mixed AND/OR groups', () =>
        {
            const result = adapter._buildFilterFromChain([
                { field: 'active', op: '=', value: true, logic: 'AND' },
                { field: 'role', op: '=', value: 'admin', logic: 'AND' },
                { field: 'role', op: '=', value: 'mod', logic: 'OR' },
            ]);
            expect(result.$and).toBeDefined();
            // Should have active=true and {$or: [admin, mod]}
            expect(result.$and).toHaveLength(2);
        });

        it('skips raw clauses (SQL-only)', () =>
        {
            const result = adapter._buildFilterFromChain([
                { raw: 'score > 10', params: [10], logic: 'AND' },
                { field: 'name', op: '=', value: 'Alice', logic: 'AND' },
            ]);
            expect(result).toEqual({ name: 'Alice' });
        });
    });

    // -- _opToMongo ----------------------------------------
    describe('_opToMongo', () =>
    {
        it('maps = to direct value', () =>
        {
            expect(adapter._opToMongo('name', '=', 'Alice')).toEqual({ name: 'Alice' });
        });

        it('maps != to $ne', () =>
        {
            expect(adapter._opToMongo('status', '!=', 'banned')).toEqual({ status: { $ne: 'banned' } });
        });

        it('maps <> to $ne', () =>
        {
            expect(adapter._opToMongo('status', '<>', 'banned')).toEqual({ status: { $ne: 'banned' } });
        });

        it('maps > to $gt', () =>
        {
            expect(adapter._opToMongo('age', '>', 18)).toEqual({ age: { $gt: 18 } });
        });

        it('maps < to $lt', () =>
        {
            expect(adapter._opToMongo('age', '<', 65)).toEqual({ age: { $lt: 65 } });
        });

        it('maps >= to $gte', () =>
        {
            expect(adapter._opToMongo('score', '>=', 90)).toEqual({ score: { $gte: 90 } });
        });

        it('maps <= to $lte', () =>
        {
            expect(adapter._opToMongo('score', '<=', 10)).toEqual({ score: { $lte: 10 } });
        });

        it('maps IN to $in', () =>
        {
            expect(adapter._opToMongo('role', 'IN', ['admin', 'mod']))
                .toEqual({ role: { $in: ['admin', 'mod'] } });
        });

        it('maps NOT IN to $nin', () =>
        {
            expect(adapter._opToMongo('role', 'NOT IN', ['banned']))
                .toEqual({ role: { $nin: ['banned'] } });
        });

        it('maps BETWEEN to $gte/$lte', () =>
        {
            expect(adapter._opToMongo('age', 'BETWEEN', [18, 65]))
                .toEqual({ age: { $gte: 18, $lte: 65 } });
        });

        it('maps IS NULL to null', () =>
        {
            expect(adapter._opToMongo('deleted', 'IS NULL')).toEqual({ deleted: null });
        });

        it('maps IS NOT NULL to $ne: null', () =>
        {
            expect(adapter._opToMongo('email', 'IS NOT NULL')).toEqual({ email: { $ne: null } });
        });

        it('maps LIKE to regex', () =>
        {
            const result = adapter._opToMongo('name', 'LIKE', '%alice%');
            expect(result.name.$regex).toBeInstanceOf(RegExp);
            expect(result.name.$regex.test('Alice')).toBe(true);
            expect(result.name.$regex.test('ALICE SMITH')).toBe(true);
            expect(result.name.$regex.test('bob')).toBe(false);
        });

        it('maps LIKE with _ wildcard', () =>
        {
            const result = adapter._opToMongo('code', 'LIKE', 'A_C');
            expect(result.code.$regex.test('ABC')).toBe(true);
            expect(result.code.$regex.test('AXC')).toBe(true);
            expect(result.code.$regex.test('ABBC')).toBe(false);
        });

        it('maps LIKE with special regex chars', () =>
        {
            const result = adapter._opToMongo('name', 'LIKE', '%.com');
            expect(result.name.$regex.test('test.com')).toBe(true);
        });

        it('returns direct value for unknown operator', () =>
        {
            expect(adapter._opToMongo('x', 'WEIRD', 42)).toEqual({ x: 42 });
        });
    });

    // -- Constructor error ----------------------------------
    // Tested in adapters.test.js via structural checks
});
