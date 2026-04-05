/**
 * Coverage-focused tests for lib/orm/adapters/postgres.js
 * Targets uncovered branches, functions, and edge paths.
 */

// ============================================================
//  Helpers
// ============================================================
function makePg()
{
    vi.doMock('pg', () => ({
        Pool: function () {
            this.query = vi.fn();
            this.connect = vi.fn();
            this.end = vi.fn();
        },
    }));
    delete require.cache[require.resolve('../../../lib/orm/adapters/postgres')];
    const PostgresAdapter = require('../../../lib/orm/adapters/postgres');
    const adapter = new PostgresAdapter({ database: 'cov_db' });
    adapter._pool = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockResolvedValue({ rows: [] }),
            release: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        }),
        end: vi.fn(),
        totalCount: 5,
        idleCount: 3,
        waitingCount: 1,
        options: { max: 10 },
    };
    return adapter;
}

function sql(adapter, callIndex = 0)
{
    return adapter._pool.query.mock.calls[callIndex][0];
}

// ============================================================
//  _typeMap branch coverage
// ============================================================
describe('PostgresAdapter _typeMap branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('string without maxLength defaults to VARCHAR(255)', () =>
    {
        const result = adapter._typeMap({ type: 'string' });
        expect(result).toBe('VARCHAR(255)');
    });

    it('string with maxLength', () =>
    {
        expect(adapter._typeMap({ type: 'string', maxLength: 50 })).toBe('VARCHAR(50)');
    });

    it('decimal defaults to NUMERIC(10,2)', () =>
    {
        expect(adapter._typeMap({ type: 'decimal' })).toBe('NUMERIC(10,2)');
    });

    it('decimal with precision and scale', () =>
    {
        expect(adapter._typeMap({ type: 'decimal', precision: 8, scale: 4 })).toBe('NUMERIC(8,4)');
    });

    it('array with arrayOf', () =>
    {
        expect(adapter._typeMap({ type: 'array', arrayOf: 'INTEGER' })).toBe('INTEGER[]');
    });

    it('array without arrayOf defaults to TEXT[]', () =>
    {
        expect(adapter._typeMap({ type: 'array' })).toBe('TEXT[]');
    });

    it('enum with values generates CHECK', () =>
    {
        const result = adapter._typeMap({ type: 'enum', enum: ['a', 'b'], _name: 'status' });
        expect(result).toContain('VARCHAR(255)');
        expect(result).toContain('CHECK');
        expect(result).toContain("'a'");
        expect(result).toContain("'b'");
    });

    it('enum without values defaults to VARCHAR(255)', () =>
    {
        expect(adapter._typeMap({ type: 'enum' })).toBe('VARCHAR(255)');
    });

    it('enum escapes single quotes in values', () =>
    {
        const result = adapter._typeMap({ type: 'enum', enum: ["it's"], _name: 'x' });
        expect(result).toContain("it''s");
    });

    it('enum escapes double quotes in column name', () =>
    {
        const result = adapter._typeMap({ type: 'enum', enum: ['a'], _name: 'col"name' });
        expect(result).toContain('col""name');
    });

    it('enum without _name uses col as fallback', () =>
    {
        const result = adapter._typeMap({ type: 'enum', enum: ['x'] });
        expect(result).toContain('"col"');
    });

    it('unknown type falls back to TEXT', () =>
    {
        expect(adapter._typeMap({ type: 'nonexistent' })).toBe('TEXT');
    });

    it('char defaults to CHAR(1)', () =>
    {
        expect(adapter._typeMap({ type: 'char' })).toBe('CHAR(1)');
    });

    it('char with length', () =>
    {
        expect(adapter._typeMap({ type: 'char', length: 5 })).toBe('CHAR(5)');
    });
});

// ============================================================
//  _buildWherePg branch coverage
// ============================================================
describe('PostgresAdapter _buildWherePg', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('empty conditions returns empty clause', () =>
    {
        const r = adapter._buildWherePg({});
        expect(r.clause).toBe('');
        expect(r.values).toEqual([]);
    });

    it('null conditions returns empty clause', () =>
    {
        const r = adapter._buildWherePg(null);
        expect(r.clause).toBe('');
    });

    it('null value generates IS NULL', () =>
    {
        const r = adapter._buildWherePg({ status: null });
        expect(r.clause).toContain('IS NULL');
        expect(r.values).toEqual([]);
    });

    it('non-null value generates parameterised $N', () =>
    {
        const r = adapter._buildWherePg({ age: 25 }, 3);
        expect(r.clause).toContain('"age" = $3');
        expect(r.values).toEqual([25]);
        expect(r.nextIdx).toBe(4);
    });

    it('multiple conditions with mixed null/non-null', () =>
    {
        const r = adapter._buildWherePg({ a: null, b: 10, c: null, d: 'x' });
        expect(r.clause).toContain('IS NULL');
        expect(r.clause).toContain('$1');
        expect(r.clause).toContain('$2');
    });
});

// ============================================================
//  _buildWhereFromChainPg branch coverage
// ============================================================
describe('PostgresAdapter _buildWhereFromChainPg', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('empty/null where returns empty', () =>
    {
        expect(adapter._buildWhereFromChainPg(null).clause).toBe('');
        expect(adapter._buildWhereFromChainPg([]).clause).toBe('');
    });

    it('raw clause with params, ? → $N conversion', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { raw: 'x > ? AND y < ?', params: [1, 2] },
        ]);
        expect(r.clause).toContain('x > $1 AND y < $2');
        expect(r.values).toEqual([1, 2]);
    });

    it('raw clause without params', () =>
    {
        const r = adapter._buildWhereFromChainPg([{ raw: '1=1' }]);
        expect(r.clause).toContain('1=1');
    });

    it('raw clause with logic combiner (non-first position)', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'a', op: '=', value: 1, logic: 'AND' },
            { raw: 'b IS NOT NULL', logic: 'OR' },
        ]);
        expect(r.clause).toContain('OR b IS NOT NULL');
    });

    it('IS NULL operator', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'x', op: 'IS NULL', logic: 'AND' },
        ]);
        expect(r.clause).toContain('"x" IS NULL');
    });

    it('IS NOT NULL operator', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'x', op: 'IS NOT NULL', logic: 'AND' },
        ]);
        expect(r.clause).toContain('"x" IS NOT NULL');
    });

    it('IN with values generates placeholders', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'id', op: 'IN', value: [1, 2, 3], logic: 'AND' },
        ]);
        expect(r.clause).toContain('"id" IN ($1, $2, $3)');
        expect(r.values).toEqual([1, 2, 3]);
    });

    it('IN with empty array generates 0=1', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'id', op: 'IN', value: [], logic: 'AND' },
        ]);
        expect(r.clause).toContain('0=1');
    });

    it('NOT IN with empty array generates 1=1', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'id', op: 'NOT IN', value: [], logic: 'AND' },
        ]);
        expect(r.clause).toContain('1=1');
    });

    it('NOT IN with values', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'id', op: 'NOT IN', value: [5, 6], logic: 'AND' },
        ]);
        expect(r.clause).toContain('"id" NOT IN ($1, $2)');
    });

    it('BETWEEN generates two params', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'age', op: 'BETWEEN', value: [18, 65], logic: 'AND' },
        ]);
        expect(r.clause).toContain('"age" BETWEEN $1 AND $2');
        expect(r.values).toEqual([18, 65]);
    });

    it('generic operator with logic combiner', () =>
    {
        const r = adapter._buildWhereFromChainPg([
            { field: 'a', op: '=', value: 1, logic: 'AND' },
            { field: 'b', op: '>=', value: 5, logic: 'OR' },
        ]);
        expect(r.clause).toContain('"a" = $1');
        expect(r.clause).toContain('OR "b" >= $2');
    });
});

// ============================================================
//  createTable branch coverage (uncovered paths)
// ============================================================
describe('PostgresAdapter createTable extra branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('compositeKey cols get NOT NULL but not PRIMARY KEY inline', async () =>
    {
        const schema = {
            a: { type: 'integer', primaryKey: true, compositeKey: true, required: true },
            b: { type: 'integer', primaryKey: true, compositeKey: true, required: true },
            c: { type: 'string' },
        };
        await adapter.createTable('t', schema);
        const s = sql(adapter);
        expect(s).toContain('"a" INTEGER NOT NULL');
        expect(s).toContain('PRIMARY KEY ("a", "b")');
        // c is a plain column
        expect(s).toContain('"c" VARCHAR(255)');
    });

    it('autoIncrement converts to SERIAL PRIMARY KEY', async () =>
    {
        await adapter.createTable('t', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        });
        expect(sql(adapter)).toContain('"id" SERIAL PRIMARY KEY');
    });

    it('required without primaryKey adds NOT NULL', async () =>
    {
        await adapter.createTable('t', {
            name: { type: 'string', required: true },
        });
        expect(sql(adapter)).toContain('NOT NULL');
    });

    it('unique without compositeUnique adds UNIQUE', async () =>
    {
        await adapter.createTable('t', {
            email: { type: 'string', unique: true },
        });
        expect(sql(adapter)).toContain('UNIQUE');
    });

    it('compositeUnique suppresses inline UNIQUE', async () =>
    {
        await adapter.createTable('t', {
            a: { type: 'string', unique: true, compositeUnique: 'grp' },
            b: { type: 'string', unique: true, compositeUnique: 'grp' },
        });
        const s = sql(adapter);
        // Should NOT have inline UNIQUE on individual columns
        expect(s).not.toMatch(/"a" VARCHAR\(255\) UNIQUE/);
        // Should have constraint
        expect(s).toContain('CONSTRAINT "uq_t_grp" UNIQUE');
    });

    it('check constraint added inline', async () =>
    {
        await adapter.createTable('t', {
            age: { type: 'integer', check: 'age >= 0' },
        });
        expect(sql(adapter)).toContain('CHECK(age >= 0)');
    });

    it('references with default column id', async () =>
    {
        await adapter.createTable('t', {
            ref: { type: 'integer', references: { table: 'other' } },
        });
        expect(sql(adapter)).toContain('REFERENCES "other"("id")');
    });

    it('references onDelete without onUpdate', async () =>
    {
        await adapter.createTable('t', {
            ref: { type: 'integer', references: { table: 'x', column: 'xid', onDelete: 'SET NULL' } },
        });
        const s = sql(adapter);
        expect(s).toContain('ON DELETE SET NULL');
        expect(s).not.toContain('ON UPDATE');
    });

    it('references onUpdate without onDelete', async () =>
    {
        await adapter.createTable('t', {
            ref: { type: 'integer', references: { table: 'x', column: 'xid', onUpdate: 'CASCADE' } },
        });
        const s = sql(adapter);
        expect(s).not.toContain('ON DELETE');
        expect(s).toContain('ON UPDATE CASCADE');
    });

    it('default value (non-function) adds DEFAULT', async () =>
    {
        await adapter.createTable('t', {
            status: { type: 'string', default: 'active' },
        });
        expect(sql(adapter)).toContain("DEFAULT 'active'");
    });

    it('function default is skipped', async () =>
    {
        await adapter.createTable('t', {
            ts: { type: 'string', default: () => 'now()' },
        });
        expect(sql(adapter)).not.toContain('DEFAULT');
    });

    it('compositeUnique with boolean true uses default group', async () =>
    {
        await adapter.createTable('t', {
            x: { type: 'string', compositeUnique: true },
            y: { type: 'string', compositeUnique: true },
        });
        expect(sql(adapter)).toContain('CONSTRAINT "uq_t_default" UNIQUE');
    });

    it('index with custom name', async () =>
    {
        await adapter.createTable('t', {
            email: { type: 'string', index: 'my_idx' },
        });
        const calls = adapter._pool.query.mock.calls;
        const idxCall = calls.find(c => String(c[0]).includes('CREATE INDEX'));
        expect(idxCall[0]).toContain('"my_idx"');
    });

    it('compositeIndex with boolean true uses default group', async () =>
    {
        await adapter.createTable('t', {
            a: { type: 'string', compositeIndex: true },
            b: { type: 'string', compositeIndex: true },
        });
        const calls = adapter._pool.query.mock.calls;
        const idxCall = calls.find(c => String(c[0]).includes('idx_t_default'));
        expect(idxCall).toBeDefined();
    });
});

// ============================================================
//  execute branch coverage
// ============================================================
describe('PostgresAdapter execute extra branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('count action with joins and where', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{ count: '7' }] });
        const result = await adapter.execute({
            action: 'count', table: 't',
            joins: [{ type: 'INNER', table: 'j', localKey: 'jid', foreignKey: 'id' }],
            where: [{ field: 'x', op: '=', value: 1, logic: 'AND' }],
        });
        expect(result).toBe(7);
        const s = sql(adapter);
        expect(s).toContain('COUNT(*)');
        expect(s).toContain('INNER JOIN');
    });

    it('execute with having clause', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        await adapter.execute({
            table: 't',
            fields: ['status', 'cnt'],
            groupBy: ['status'],
            having: [{ field: 'cnt', op: '>', value: 5 }],
        });
        const s = sql(adapter);
        expect(s).toContain('GROUP BY');
        expect(s).toContain('HAVING');
    });

    it('execute with limit and no offset', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        await adapter.execute({ table: 't', limit: 10 });
        expect(sql(adapter)).toContain('LIMIT');
        expect(sql(adapter)).not.toContain('OFFSET');
    });

    it('execute with offset and no limit', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        await adapter.execute({ table: 't', offset: 20 });
        expect(sql(adapter)).toContain('OFFSET');
    });

    it('execute with 0 limit is treated as valid', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        await adapter.execute({ table: 't', limit: 0 });
        expect(sql(adapter)).toContain('LIMIT');
    });
});

// ============================================================
//  aggregate branch coverage
// ============================================================
describe('PostgresAdapter aggregate extra branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('aggregate with where and groupBy and having', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{ result: 42 }] });
        const result = await adapter.aggregate({
            table: 't', aggregateFn: 'sum', aggregateField: 'amount',
            where: [{ field: 'active', op: '=', value: true, logic: 'AND' }],
            groupBy: ['category'],
            having: [{ field: 'amount', op: '>', value: 10 }],
        });
        expect(result).toBe(42);
        const s = sql(adapter);
        expect(s).toContain('WHERE');
        expect(s).toContain('GROUP BY');
        expect(s).toContain('HAVING');
    });

    it('aggregate returns null for empty result', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        const result = await adapter.aggregate({
            table: 't', aggregateFn: 'avg', aggregateField: 'x',
        });
        expect(result).toBeNull();
    });

    it('aggregate with joins', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{ result: 100 }] });
        const result = await adapter.aggregate({
            table: 't', aggregateFn: 'max', aggregateField: 'val',
            joins: [{ type: 'LEFT', table: 'j', localKey: 'jid', foreignKey: 'id' }],
        });
        expect(result).toBe(100);
        expect(sql(adapter)).toContain('LEFT JOIN');
    });
});

// ============================================================
//  explain branch coverage
// ============================================================
describe('PostgresAdapter explain extra branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('explain with where, groupBy, having, orderBy, limit, offset', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{ plan: 'seq' }] });
        await adapter.explain({
            table: 't',
            where: [{ field: 'x', op: '>', value: 5, logic: 'AND' }],
            groupBy: ['x'],
            having: [{ field: 'x', op: '>', value: 1 }],
            orderBy: [{ field: 'x', dir: 'ASC' }],
            limit: 10, offset: 5,
            distinct: true,
            fields: ['x', 'y'],
            joins: [{ type: 'LEFT', table: 'j', localKey: 'jid', foreignKey: 'id' }],
        }, { analyze: true, buffers: true, format: 'YAML' });
        const s = sql(adapter);
        expect(s).toContain('EXPLAIN ANALYZE BUFFERS FORMAT YAML');
        expect(s).toContain('DISTINCT');
        expect(s).toContain('LEFT JOIN');
        expect(s).toContain('GROUP BY');
        expect(s).toContain('HAVING');
        expect(s).toContain('ORDER BY');
        expect(s).toContain('LIMIT');
        expect(s).toContain('OFFSET');
    });

    it('explain with format TEXT', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        await adapter.explain({ table: 't' }, { format: 'TEXT' });
        expect(sql(adapter)).toContain('FORMAT TEXT');
    });

    it('explain with format XML', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        await adapter.explain({ table: 't' }, { format: 'XML' });
        expect(sql(adapter)).toContain('FORMAT XML');
    });

    it('explain without analyze or buffers', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        await adapter.explain({ table: 't' });
        const s = sql(adapter);
        expect(s).toMatch(/^EXPLAIN SELECT/);
        expect(s).not.toContain('ANALYZE');
        expect(s).not.toContain('BUFFERS');
    });
});

// ============================================================
//  warmup branch coverage
// ============================================================
describe('PostgresAdapter warmup edge cases', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('warmup clamps NaN to default 5', async () =>
    {
        const client = { release: vi.fn() };
        adapter._pool.connect.mockResolvedValue(client);
        const n = await adapter.warmup('abc');
        expect(n).toBe(5);
    });

    it('warmup clamps negative to minimum 1', async () =>
    {
        const client = { release: vi.fn() };
        adapter._pool.connect.mockResolvedValue(client);
        const n = await adapter.warmup(-10);
        expect(n).toBe(1);
    });

    it('warmup uses pool.options.max fallback of 10 when max is 0', async () =>
    {
        adapter._pool.options.max = 0;
        const client = { release: vi.fn() };
        adapter._pool.connect.mockResolvedValue(client);
        const n = await adapter.warmup(999);
        expect(n).toBe(10);
    });
});

// ============================================================
//  stmtCacheStats
// ============================================================
describe('PostgresAdapter stmtCacheStats', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('returns hitRate > 0 when there are hits', () =>
    {
        adapter._stmtCacheHits = 3;
        adapter._stmtCacheMisses = 7;
        adapter._stmtCache.set('q1', true);
        const stats = adapter.stmtCacheStats();
        expect(stats.hitRate).toBeCloseTo(0.3);
        expect(stats.size).toBe(1);
    });
});

// ============================================================
//  tableSizeFormatted — formatter branches
// ============================================================
describe('PostgresAdapter tableSizeFormatted formatter', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('formats GB when size >= 1073741824', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 't', total_size: 2147483648, data_size: 2147483648,
            index_size: 1073741824, live_tuples: 1, dead_tuples: 0,
            seq_scans: 0, idx_scans: 0, last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const r = await adapter.tableSizeFormatted('t');
        expect(r.dataSize).toContain('GB');
        expect(r.totalSize).toContain('GB');
        expect(r.indexSize).toContain('GB');
    });

    it('formats KB when size >= 1024', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 't', total_size: 2048, data_size: 2048,
            index_size: 1024, live_tuples: 0, dead_tuples: 0,
            seq_scans: 0, idx_scans: 0, last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const r = await adapter.tableSizeFormatted('t');
        expect(r.dataSize).toContain('KB');
        expect(r.indexSize).toContain('KB');
    });

    it('formats B when size < 1024', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 't', total_size: 100, data_size: 50,
            index_size: 50, live_tuples: 0, dead_tuples: 0,
            seq_scans: 0, idx_scans: 0, last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const r = await adapter.tableSizeFormatted('t');
        expect(r.dataSize).toBe('50 B');
        expect(r.totalSize).toBe('100 B');
    });
});

// ============================================================
//  overview — formatter branches
// ============================================================
describe('PostgresAdapter overview formatter', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('overview formats GB total', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 't', total_size: 2147483648, data_size: 1048576, index_size: 1024,
            live_tuples: 100, dead_tuples: 0, seq_scans: 0, idx_scans: 0,
            last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const ov = await adapter.overview();
        expect(ov.totalSize).toContain('GB');
        expect(ov.totalRows).toBe(100);
        expect(ov.tables[0].formattedSize).toContain('GB');
    });

    it('overview formats MB total', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 't', total_size: 1048576, data_size: 1024, index_size: 100,
            live_tuples: 50, dead_tuples: 0, seq_scans: 0, idx_scans: 0,
            last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const ov = await adapter.overview();
        expect(ov.totalSize).toContain('MB');
    });

    it('overview formats KB total', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 't', total_size: 2048, data_size: 0, index_size: 0,
            live_tuples: 0, dead_tuples: 0, seq_scans: 0, idx_scans: 0,
            last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const ov = await adapter.overview();
        expect(ov.totalSize).toContain('KB');
    });

    it('overview formats B total', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 't', total_size: 100, data_size: 0, index_size: 0,
            live_tuples: 0, dead_tuples: 0, seq_scans: 0, idx_scans: 0,
            last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const ov = await adapter.overview();
        expect(ov.totalSize).toBe('100 B');
    });
});

// ============================================================
//  variables branch coverage
// ============================================================
describe('PostgresAdapter variables branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('variables without filter passes empty params array', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{ name: 'a', setting: '1' }] });
        const r = await adapter.variables();
        expect(r.a).toBe('1');
        expect(adapter._pool.query.mock.calls[0][1]).toEqual([]);
    });
});

// ============================================================
//  addColumn branch coverage
// ============================================================
describe('PostgresAdapter addColumn extra branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('addColumn with default only (no required/unique/check/ref)', async () =>
    {
        await adapter.addColumn('t', 'score', { type: 'integer', default: 0 });
        const s = sql(adapter);
        expect(s).toContain('DEFAULT 0');
        expect(s).not.toContain('NOT NULL');
        expect(s).not.toContain('UNIQUE');
    });

    it('addColumn with references missing column defaults to id', async () =>
    {
        await adapter.addColumn('t', 'uid', { type: 'integer', references: { table: 'users' } });
        expect(sql(adapter)).toContain('REFERENCES "users"("id")');
    });

    it('addColumn with references onUpdate only', async () =>
    {
        await adapter.addColumn('t', 'uid', {
            type: 'integer',
            references: { table: 'users', column: 'uid', onUpdate: 'RESTRICT' },
        });
        const s = sql(adapter);
        expect(s).toContain('ON UPDATE RESTRICT');
        expect(s).not.toContain('ON DELETE');
    });

    it('addColumn skips function default', async () =>
    {
        await adapter.addColumn('t', 'ts', { type: 'string', default: () => 'now()' });
        expect(sql(adapter)).not.toContain('DEFAULT');
    });
});

// ============================================================
//  addForeignKey branch coverage
// ============================================================
describe('PostgresAdapter addForeignKey branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('addForeignKey default constraint name', async () =>
    {
        await adapter.addForeignKey('posts', 'user_id', 'users', 'id');
        const s = sql(adapter);
        expect(s).toContain('CONSTRAINT "fk_posts_user_id"');
        expect(s).not.toContain('ON DELETE');
        expect(s).not.toContain('ON UPDATE');
    });

    it('addForeignKey with custom name and onDelete', async () =>
    {
        await adapter.addForeignKey('posts', 'uid', 'users', 'id', {
            name: 'my_fk', onDelete: 'CASCADE',
        });
        const s = sql(adapter);
        expect(s).toContain('CONSTRAINT "my_fk"');
        expect(s).toContain('ON DELETE CASCADE');
    });

    it('addForeignKey with onUpdate', async () =>
    {
        await adapter.addForeignKey('t', 'c', 'r', 'id', { onUpdate: 'SET NULL' });
        expect(sql(adapter)).toContain('ON UPDATE SET NULL');
    });
});

// ============================================================
//  createIndex branch coverage
// ============================================================
describe('PostgresAdapter createIndex branches', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('createIndex with default name', async () =>
    {
        await adapter.createIndex('t', 'email');
        expect(sql(adapter)).toContain('"idx_t_email"');
    });

    it('createIndex unique with custom name and multiple cols', async () =>
    {
        await adapter.createIndex('t', ['a', 'b'], { name: 'my_idx', unique: true });
        const s = sql(adapter);
        expect(s).toContain('CREATE UNIQUE INDEX');
        expect(s).toContain('"my_idx"');
        expect(s).toContain('"a", "b"');
    });
});

// ============================================================
//  hasTable / hasColumn / describeTable
// ============================================================
describe('PostgresAdapter hasTable, hasColumn, describeTable', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('hasTable returns true when rows exist', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        expect(await adapter.hasTable('users')).toBe(true);
    });

    it('hasTable returns false when no rows', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        expect(await adapter.hasTable('users')).toBe(false);
    });

    it('hasColumn returns true', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
        expect(await adapter.hasColumn('users', 'email')).toBe(true);
    });

    it('hasColumn returns false', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [] });
        expect(await adapter.hasColumn('users', 'nope')).toBe(false);
    });

    it('describeTable maps columns', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [
            { name: 'id', type: 'integer', nullable: false, default_value: null, pk: true },
            { name: 'email', type: 'varchar', nullable: true, default_value: null, pk: false },
        ] });
        const cols = await adapter.describeTable('users');
        expect(cols[0].primaryKey).toBe(true);
        expect(cols[1].nullable).toBe(true);
    });
});

// ============================================================
//  Constructor pg require failure
// ============================================================
// NOTE: Constructor "pg not installed" branch is not testable with vi.doMock
// because vitest CJS mocking does not intercept require('pg') inside constructor
// when pg is already resolved. The branch is a simple try/catch + throw.

// ============================================================
//  exec rowCount fallback
// ============================================================
describe('PostgresAdapter exec', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('exec returns rowCount 0 when null', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rowCount: null });
        const r = await adapter.exec('UPDATE t SET x = 1');
        expect(r.rowCount).toBe(0);
    });
});

// ============================================================
//  tableStatus with table filter
// ============================================================
describe('PostgresAdapter tableStatus filter branch', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('tableStatus with table adds WHERE filter', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            name: 'users', total_size: 0, data_size: 0, index_size: 0,
            live_tuples: 0, dead_tuples: 0, seq_scans: 0, idx_scans: 0,
            last_vacuum: null, last_autovacuum: null, last_analyze: null,
        }] });
        const status = await adapter.tableStatus('users');
        const call = adapter._pool.query.mock.calls[0];
        expect(call[0]).toContain('WHERE');
        expect(call[1]).toEqual(['users']);
        expect(status[0].name).toBe('users');
    });
});

// ============================================================
//  transaction client release in finally
// ============================================================
describe('PostgresAdapter transaction', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('releases client even on COMMIT success', async () =>
    {
        const client = {
            query: vi.fn().mockResolvedValue({ rows: [] }),
            release: vi.fn(),
        };
        adapter._pool.connect.mockResolvedValue(client);
        await adapter.transaction(async () => 'done');
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});

// ============================================================
//  listen unlisten
// ============================================================
describe('PostgresAdapter listen/unlisten', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('unlisten removes listener and releases client', async () =>
    {
        const client = {
            query: vi.fn().mockResolvedValue({ rows: [] }),
            on: vi.fn(),
            removeListener: vi.fn(),
            release: vi.fn(),
        };
        adapter._pool.connect.mockResolvedValue(client);
        const cb = vi.fn();
        const unlisten = await adapter.listen('events', cb);
        await unlisten();
        expect(client.removeListener).toHaveBeenCalledWith('notification', cb);
        expect(client.release).toHaveBeenCalled();
    });
});

// ============================================================
//  comments edge cases
// ============================================================
describe('PostgresAdapter comments edge cases', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('comments returns empty string when tcRows[0] is null', async () =>
    {
        adapter._pool.query
            .mockResolvedValueOnce({ rows: [] })    // no table comment row
            .mockResolvedValueOnce({ rows: [] });
        const c = await adapter.comments('t');
        expect(c.tableComment).toBe('');
    });

    it('column without comment returns empty string', async () =>
    {
        adapter._pool.query
            .mockResolvedValueOnce({ rows: [{ comment: 'tbl' }] })
            .mockResolvedValueOnce({ rows: [{ name: 'id', comment: null }] });
        const c = await adapter.comments('t');
        expect(c.columns[0].comment).toBe('');
    });
});

// ============================================================
//  constraints typeMap fallback
// ============================================================
describe('PostgresAdapter constraints fallback', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('maps FK and EXCLUSION types', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [
            { name: 'fk1', type: 'f', definition: 'FK def' },
            { name: 'excl', type: 'x', definition: 'EXCL def' },
        ] });
        const cons = await adapter.constraints('t');
        expect(cons[0].type).toBe('FOREIGN KEY');
        expect(cons[1].type).toBe('EXCLUSION');
    });

    it('unknown constraint type returns raw type char', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [
            { name: 'unk', type: 'z', definition: 'unknown' },
        ] });
        const cons = await adapter.constraints('t');
        expect(cons[0].type).toBe('z');
    });
});

// ============================================================
//  processlist duration fallback
// ============================================================
describe('PostgresAdapter processlist', () =>
{
    let adapter;
    beforeEach(() => { adapter = makePg(); });

    it('duration defaults to empty string when null', async () =>
    {
        adapter._pool.query.mockResolvedValueOnce({ rows: [{
            pid: 1, user: 'pg', database: 'test', state: 'idle', query: '', duration: null,
        }] });
        const pl = await adapter.processlist();
        expect(pl[0].duration).toBe('');
    });
});
