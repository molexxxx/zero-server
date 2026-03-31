/**
 * PostgreSQL adapter CRUD and utility method tests.
 * Mocks the pg Pool to capture generated SQL and verify correctness.
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
    const adapter = new PostgresAdapter({ database: 'test_db' });
    // Replace pool with fully-mocked version
    adapter._pool = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockResolvedValue({ rows: [] }),
            release: vi.fn(),
        }),
        end: vi.fn(),
        totalCount: 5,
        idleCount: 3,
        waitingCount: 1,
        options: { max: 10 },
    };
    return adapter;
}

// ============================================================
//  Tests
// ============================================================
describe('PostgresAdapter CRUD methods', () =>
{
    let adapter;

    beforeEach(() => { adapter = makePg(); });

    // -- createTable ------------------------------------------
    describe('createTable', () =>
    {
        it('generates DDL with basic columns', async () =>
        {
            const schema = {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string', maxLength: 100, required: true },
                active: { type: 'boolean', default: true },
            };
            await adapter.createTable('users', schema);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS "users"');
            expect(sql).toContain('"id" SERIAL PRIMARY KEY');
            expect(sql).toContain('"name" VARCHAR(100) NOT NULL');
            expect(sql).toContain('"active" BOOLEAN DEFAULT 1');
        });

        it('handles composite primary key', async () =>
        {
            const schema = {
                user_id: { type: 'integer', primaryKey: true, compositeKey: true, required: true },
                post_id: { type: 'integer', primaryKey: true, compositeKey: true, required: true },
            };
            await adapter.createTable('user_posts', schema);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('PRIMARY KEY ("user_id", "post_id")');
        });

        it('handles composite unique constraints', async () =>
        {
            const schema = {
                email: { type: 'string', compositeUnique: 'email_org' },
                org: { type: 'string', compositeUnique: 'email_org' },
            };
            await adapter.createTable('accounts', schema);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('CONSTRAINT "uq_accounts_email_org" UNIQUE');
        });

        it('handles inline foreign key references', async () =>
        {
            const schema = {
                id: { type: 'integer', primaryKey: true },
                author_id: {
                    type: 'integer',
                    references: { table: 'users', column: 'id', onDelete: 'CASCADE', onUpdate: 'SET NULL' },
                },
            };
            await adapter.createTable('posts', schema);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('REFERENCES "users"("id")');
            expect(sql).toContain('ON DELETE CASCADE');
            expect(sql).toContain('ON UPDATE SET NULL');
        });

        it('handles CHECK constraints', async () =>
        {
            const schema = { age: { type: 'integer', check: 'age >= 0' } };
            await adapter.createTable('people', schema);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('CHECK(age >= 0)');
        });

        it('handles unique columns', async () =>
        {
            const schema = { email: { type: 'string', unique: true } };
            await adapter.createTable('u', schema);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('UNIQUE');
        });

        it('handles tablespace option', async () =>
        {
            const schema = { id: { type: 'integer', primaryKey: true } };
            await adapter.createTable('t', schema, { tablespace: 'fast_ssd' });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('TABLESPACE fast_ssd');
        });

        it('rejects invalid tablespace name', async () =>
        {
            const schema = { id: { type: 'integer', primaryKey: true } };
            await expect(adapter.createTable('t', schema, { tablespace: 'DROP TABLE x' }))
                .rejects.toThrow('Invalid tablespace');
        });

        it('handles unlogged tables', async () =>
        {
            const schema = { id: { type: 'integer', primaryKey: true } };
            await adapter.createTable('t', schema, { unlogged: true });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('CREATE UNLOGGED TABLE');
        });

        it('handles table comment', async () =>
        {
            const schema = { id: { type: 'integer', primaryKey: true } };
            await adapter.createTable('t', schema, { comment: 'My table' });
            const calls = adapter._pool.query.mock.calls;
            const commentCall = calls.find(c => typeof c[0] === 'string' && c[0].includes('COMMENT ON TABLE'));
            expect(commentCall).toBeDefined();
            expect(commentCall[1]).toEqual(['My table']);
        });

        it('creates indexes from schema', async () =>
        {
            const schema = {
                id: { type: 'integer', primaryKey: true },
                email: { type: 'string', index: true },
            };
            await adapter.createTable('users', schema);
            const calls = adapter._pool.query.mock.calls;
            const idxCall = calls.find(c => typeof c[0] === 'string' && c[0].includes('CREATE INDEX'));
            expect(idxCall).toBeDefined();
            expect(idxCall[0]).toContain('"idx_users_email"');
        });

        it('creates composite indexes', async () =>
        {
            const schema = {
                a: { type: 'string', compositeIndex: 'ab' },
                b: { type: 'string', compositeIndex: 'ab' },
            };
            await adapter.createTable('t1', schema);
            const calls = adapter._pool.query.mock.calls;
            const idxCall = calls.find(c => typeof c[0] === 'string' && c[0].includes('idx_t1_ab'));
            expect(idxCall).toBeDefined();
        });

        it('handles column defaults and required', async () =>
        {
            const schema = {
                status: { type: 'string', required: true, default: 'active' },
            };
            await adapter.createTable('items', schema);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('NOT NULL');
            expect(sql).toContain("DEFAULT 'active'");
        });
    });

    // -- dropTable -------------------------------------------
    describe('dropTable', () =>
    {
        it('generates DROP TABLE IF EXISTS', async () =>
        {
            await adapter.dropTable('users');
            expect(adapter._pool.query).toHaveBeenCalledWith('DROP TABLE IF EXISTS "users"');
        });
    });

    // -- insert -----------------------------------------------
    describe('insert', () =>
    {
        it('generates INSERT with $N placeholders and RETURNING *', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Alice' }] });
            const result = await adapter.insert('users', { name: 'Alice', age: 30 });
            const [sql, values] = adapter._pool.query.mock.calls[0];
            expect(sql).toContain('INSERT INTO "users"');
            expect(sql).toContain('$1, $2');
            expect(sql).toContain('RETURNING *');
            expect(values).toEqual(['Alice', 30]);
            expect(result.id).toBe(1);
        });

        it('returns spread data when RETURNING returns nothing', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            const result = await adapter.insert('users', { name: 'Bob' });
            expect(result.name).toBe('Bob');
        });
    });

    // -- insertMany -------------------------------------------
    describe('insertMany', () =>
    {
        it('generates bulk INSERT with $N placeholders', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
            const result = await adapter.insertMany('users', [{ name: 'A' }, { name: 'B' }]);
            const [sql, values] = adapter._pool.query.mock.calls[0];
            expect(sql).toContain('INSERT INTO "users" ("name") VALUES ($1), ($2) RETURNING *');
            expect(values).toEqual(['A', 'B']);
            expect(result).toHaveLength(2);
        });

        it('returns empty for empty input', async () =>
        {
            expect(await adapter.insertMany('t', [])).toEqual([]);
        });
    });

    // -- update -----------------------------------------------
    describe('update', () =>
    {
        it('generates UPDATE with $N params', async () =>
        {
            await adapter.update('users', 'id', 5, { name: 'Charlie' });
            const [sql, values] = adapter._pool.query.mock.calls[0];
            expect(sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2');
            expect(values).toEqual(['Charlie', 5]);
        });
    });

    // -- updateWhere ------------------------------------------
    describe('updateWhere', () =>
    {
        it('generates UPDATE with WHERE conditions', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rowCount: 3 });
            const count = await adapter.updateWhere('users', { active: true }, { verified: true });
            expect(count).toBe(3);
            const [sql] = adapter._pool.query.mock.calls[0];
            expect(sql).toContain('UPDATE "users" SET');
            expect(sql).toContain('WHERE');
        });
    });

    // -- remove -----------------------------------------------
    describe('remove', () =>
    {
        it('generates DELETE with $1 param', async () =>
        {
            await adapter.remove('users', 'id', 7);
            expect(adapter._pool.query).toHaveBeenCalledWith('DELETE FROM "users" WHERE "id" = $1', [7]);
        });
    });

    // -- deleteWhere ------------------------------------------
    describe('deleteWhere', () =>
    {
        it('returns rowCount', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rowCount: 2 });
            const count = await adapter.deleteWhere('users', { active: false });
            expect(count).toBe(2);
        });
    });

    // -- execute (SELECT) -------------------------------------
    describe('execute', () =>
    {
        it('generates basic SELECT', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
            const rows = await adapter.execute({ table: 'users', fields: ['id', 'name'] });
            const [sql] = adapter._pool.query.mock.calls[0];
            expect(sql).toContain('SELECT "id", "name" FROM "users"');
            expect(rows).toEqual([{ id: 1 }]);
        });

        it('generates SELECT * when no fields', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.execute({ table: 'users' });
            expect(adapter._pool.query.mock.calls[0][0]).toContain('SELECT * FROM "users"');
        });

        it('handles DISTINCT', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.execute({ table: 'users', distinct: true });
            expect(adapter._pool.query.mock.calls[0][0]).toContain('SELECT DISTINCT');
        });

        it('handles WHERE, ORDER BY, LIMIT, OFFSET', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.execute({
                table: 'users',
                where: [{ field: 'age', op: '>', value: 18, logic: 'AND' }],
                orderBy: [{ field: 'name', dir: 'asc' }],
                limit: 10, offset: 5,
            });
            const [sql, values] = adapter._pool.query.mock.calls[0];
            expect(sql).toContain('WHERE');
            expect(sql).toContain('ORDER BY "name" asc');
            expect(sql).toContain('LIMIT');
            expect(sql).toContain('OFFSET');
        });

        it('handles count action', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ count: '42' }] });
            const count = await adapter.execute({ action: 'count', table: 'users' });
            expect(count).toBe(42);
        });

        it('handles JOINs', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.execute({
                table: 'posts',
                joins: [{ type: 'LEFT', table: 'users', localKey: 'author_id', foreignKey: 'id' }],
            });
            expect(adapter._pool.query.mock.calls[0][0]).toContain('LEFT JOIN');
        });

        it('handles GROUP BY', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.execute({ table: 'orders', fields: ['status'], groupBy: ['status'] });
            expect(adapter._pool.query.mock.calls[0][0]).toContain('GROUP BY');
        });
    });

    // -- aggregate -------------------------------------------
    describe('aggregate', () =>
    {
        it('generates SUM aggregate', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ result: 1500 }] });
            const result = await adapter.aggregate({
                table: 'orders', aggregateFn: 'SUM', aggregateField: 'total',
            });
            const [sql] = adapter._pool.query.mock.calls[0];
            expect(sql).toContain('SELECT SUM("total") as result FROM "orders"');
            expect(result).toBe(1500);
        });

        it('returns null when no rows', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{}] });
            const result = await adapter.aggregate({
                table: 'orders', aggregateFn: 'AVG', aggregateField: 'total',
            });
            expect(result).toBeUndefined();
        });
    });

    // -- explain ---------------------------------------------
    describe('explain', () =>
    {
        it('generates EXPLAIN SELECT', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ 'QUERY PLAN': 'Seq Scan' }] });
            await adapter.explain({ table: 'users' });
            expect(adapter._pool.query.mock.calls[0][0]).toMatch(/^EXPLAIN SELECT/);
        });

        it('generates EXPLAIN ANALYZE BUFFERS FORMAT JSON', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.explain({ table: 'users' }, { analyze: true, buffers: true, format: 'JSON' });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('EXPLAIN ANALYZE BUFFERS FORMAT JSON');
        });

        it('rejects invalid format', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.explain({ table: 'users' }, { format: 'INVALID' });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).not.toContain('FORMAT');
        });
    });

    // -- stmtCacheStats / warmup / close -------------------
    describe('stmtCacheStats, warmup, close', () =>
    {
        it('stmtCacheStats returns initial stats', () =>
        {
            const stats = adapter.stmtCacheStats();
            expect(stats.size).toBe(0);
            expect(stats.maxSize).toBe(256);
            expect(stats.hitRate).toBe(0);
        });

        it('warmup connects and releases clients', async () =>
        {
            const client = { release: vi.fn() };
            adapter._pool.connect.mockResolvedValue(client);
            const count = await adapter.warmup(3);
            expect(count).toBe(3);
            expect(client.release).toHaveBeenCalledTimes(3);
        });

        it('warmup clamps to pool max', async () =>
        {
            const client = { release: vi.fn() };
            adapter._pool.connect.mockResolvedValue(client);
            const count = await adapter.warmup(999);
            expect(count).toBe(10);
        });

        it('warmup handles connection errors', async () =>
        {
            let n = 0;
            adapter._pool.connect.mockImplementation(() =>
            {
                n++;
                if (n > 2) return Promise.reject(new Error('x'));
                return Promise.resolve({ release: vi.fn() });
            });
            expect(await adapter.warmup(5)).toBe(2);
        });

        it('close() ends the pool', async () =>
        {
            await adapter.close();
            expect(adapter._pool.end).toHaveBeenCalled();
        });
    });

    // -- raw / transaction ---------------------------------
    describe('raw & transaction', () =>
    {
        it('raw() returns query rows', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ x: 1 }] });
            const rows = await adapter.raw('SELECT 1 as x');
            expect(rows).toEqual([{ x: 1 }]);
        });

        it('raw() passes params', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.raw('SELECT $1', 42);
            expect(adapter._pool.query.mock.calls[0][1]).toEqual([42]);
        });

        it('transaction commits on success', async () =>
        {
            const client = {
                query: vi.fn().mockResolvedValue({ rows: [] }),
                release: vi.fn(),
            };
            adapter._pool.connect.mockResolvedValue(client);
            const result = await adapter.transaction(async (c) => { expect(c).toBe(client); return 'ok'; });
            expect(result).toBe('ok');
            expect(client.query).toHaveBeenCalledWith('BEGIN');
            expect(client.query).toHaveBeenCalledWith('COMMIT');
        });

        it('transaction rolls back on error', async () =>
        {
            const client = {
                query: vi.fn().mockResolvedValue({ rows: [] }),
                release: vi.fn(),
            };
            adapter._pool.connect.mockResolvedValue(client);
            await expect(adapter.transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
            expect(client.query).toHaveBeenCalledWith('ROLLBACK');
            expect(client.release).toHaveBeenCalled();
        });
    });

    // -- utility queries: tables, columns, databaseSize, poolStatus, version, ping, exec
    describe('utility queries', () =>
    {
        it('tables() returns table names', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ tablename: 'users' }, { tablename: 'posts' }] });
            expect(await adapter.tables()).toEqual(['users', 'posts']);
        });

        it('tables() uses custom schema', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.tables('custom');
            expect(adapter._pool.query.mock.calls[0][1]).toEqual(['custom']);
        });

        it('columns() returns column info', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ column_name: 'id', data_type: 'integer' }] });
            const cols = await adapter.columns('users');
            expect(cols[0].column_name).toBe('id');
        });

        it('databaseSize() returns number', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ size: '1048576' }] });
            expect(await adapter.databaseSize()).toBe(1048576);
        });

        it('tableSize() returns number', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ size: '32768' }] });
            expect(await adapter.tableSize('users')).toBe(32768);
        });

        it('poolStatus() returns counts', () =>
        {
            expect(adapter.poolStatus()).toEqual({ total: 5, idle: 3, waiting: 1 });
        });

        it('version() returns server version', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ ver: 'PostgreSQL 16.2' }] });
            expect(await adapter.version()).toBe('PostgreSQL 16.2');
        });

        it('ping() returns true on success', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
            expect(await adapter.ping()).toBe(true);
        });

        it('ping() returns false on failure', async () =>
        {
            adapter._pool.query.mockRejectedValueOnce(new Error('down'));
            expect(await adapter.ping()).toBe(false);
        });

        it('exec() returns rowCount', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rowCount: 5 });
            expect(await adapter.exec('UPDATE t SET x = $1', 1)).toEqual({ rowCount: 5 });
        });
    });

    // -- tableStatus / overview ----------------------------
    describe('tableStatus & overview', () =>
    {
        it('tableStatus() maps rows correctly', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{
                name: 'users', total_size: 32768, data_size: 16384, index_size: 8192,
                live_tuples: 100, dead_tuples: 5, seq_scans: 50, idx_scans: 200,
                last_vacuum: null, last_autovacuum: null, last_analyze: null, last_autoanalyze: null,
            }] });
            const status = await adapter.tableStatus('users');
            expect(status[0].name).toBe('users');
            expect(status[0].totalSize).toBe(32768);
            expect(status[0].rows).toBe(100);
        });

        it('tableStatus() without table shows all', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.tableStatus();
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).not.toContain('WHERE');
        });

        it('tableSizeFormatted() returns formatted strings', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{
                name: 't', total_size: 2097152, data_size: 1048576, index_size: 524288,
                live_tuples: 5000, dead_tuples: 0, seq_scans: 0, idx_scans: 0,
                last_vacuum: null, last_autovacuum: null, last_analyze: null,
            }] });
            const size = await adapter.tableSizeFormatted('t');
            expect(size.dataSize).toBe('1.00 MB');
        });

        it('tableSizeFormatted() returns 0 B for missing', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            expect((await adapter.tableSizeFormatted('x')).totalSize).toBe('0 B');
        });

        it('overview() aggregates all tables', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [
                { name: 'a', total_size: 1024, data_size: 512, index_size: 512, live_tuples: 10, dead_tuples: 0, seq_scans: 0, idx_scans: 0, last_vacuum: null, last_autovacuum: null, last_analyze: null },
                { name: 'b', total_size: 2048, data_size: 1024, index_size: 1024, live_tuples: 20, dead_tuples: 0, seq_scans: 0, idx_scans: 0, last_vacuum: null, last_autovacuum: null, last_analyze: null },
            ] });
            const ov = await adapter.overview();
            expect(ov.totalRows).toBe(30);
            expect(ov.tables).toHaveLength(2);
        });
    });

    // -- indexes / foreignKeys / constraints / comments ----
    describe('indexes, foreignKeys, constraints, comments', () =>
    {
        it('indexes() returns mapped data', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{
                name: 'users_pkey', columns: 'id', unique: true, type: 'btree', size: 8192,
            }] });
            const idx = await adapter.indexes('users');
            expect(idx[0].name).toBe('users_pkey');
            expect(idx[0].unique).toBe(true);
        });

        it('foreignKeys() returns mapped FK info', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{
                constraint_name: 'fk_posts_user', column_name: 'user_id',
                referenced_table: 'users', referenced_column: 'id',
                delete_rule: 'CASCADE', update_rule: 'RESTRICT',
            }] });
            const fks = await adapter.foreignKeys('posts');
            expect(fks[0].constraintName).toBe('fk_posts_user');
        });

        it('constraints() maps PostgreSQL constraint types', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [
                { name: 'users_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
                { name: 'users_email_key', type: 'u', definition: 'UNIQUE (email)' },
                { name: 'users_age_check', type: 'c', definition: 'CHECK (age >= 0)' },
            ] });
            const cons = await adapter.constraints('users');
            expect(cons[0].type).toBe('PRIMARY KEY');
            expect(cons[1].type).toBe('UNIQUE');
            expect(cons[2].type).toBe('CHECK');
        });

        it('comments() returns table and column comments', async () =>
        {
            adapter._pool.query
                .mockResolvedValueOnce({ rows: [{ comment: 'User accounts' }] })
                .mockResolvedValueOnce({ rows: [{ name: 'id', comment: 'Primary key' }] });
            const c = await adapter.comments('users');
            expect(c.tableComment).toBe('User accounts');
            expect(c.columns[0].comment).toBe('Primary key');
        });

        it('comments() handles missing table comment', async () =>
        {
            adapter._pool.query
                .mockResolvedValueOnce({ rows: [{}] })
                .mockResolvedValueOnce({ rows: [] });
            const c = await adapter.comments('users');
            expect(c.tableComment).toBe('');
        });
    });

    // -- variables / processlist ---------------------------
    describe('variables & processlist', () =>
    {
        it('variables() returns key/value map', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [
                { name: 'max_connections', setting: '100' },
            ] });
            expect((await adapter.variables()).max_connections).toBe('100');
        });

        it('variables() with filter uses LIKE $1', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            await adapter.variables('max%');
            expect(adapter._pool.query.mock.calls[0][1]).toEqual(['max%']);
        });

        it('processlist() returns mapped backends', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{
                pid: 1, user: 'pg', database: 'test', state: 'active', query: 'SELECT 1', duration: '0:01',
            }] });
            const pl = await adapter.processlist();
            expect(pl[0].pid).toBe(1);
        });
    });

    // -- listen -------------------------------------------
    describe('listen', () =>
    {
        it('subscribes and returns unlisten function', async () =>
        {
            const client = {
                query: vi.fn().mockResolvedValue({ rows: [] }),
                on: vi.fn(),
                removeListener: vi.fn(),
                release: vi.fn(),
            };
            adapter._pool.connect.mockResolvedValue(client);
            const cb = vi.fn();
            const unlisten = await adapter.listen('my_channel', cb);
            expect(client.query).toHaveBeenCalledWith('LISTEN my_channel');
            expect(client.on).toHaveBeenCalledWith('notification', cb);
            // Unlisten
            await unlisten();
            expect(client.query).toHaveBeenCalledWith('UNLISTEN my_channel');
            expect(client.release).toHaveBeenCalled();
        });

        it('rejects invalid channel name', async () =>
        {
            await expect(adapter.listen('DROP TABLE x', vi.fn())).rejects.toThrow('Invalid channel');
        });
    });

    // -- DDL: addColumn, dropColumn, renameColumn, renameTable
    describe('schema migration DDL', () =>
    {
        it('addColumn generates ALTER TABLE ADD COLUMN', async () =>
        {
            await adapter.addColumn('users', 'bio', { type: 'text', required: true });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "bio"');
            expect(sql).toContain('NOT NULL');
        });

        it('addColumn with check, unique, default, reference', async () =>
        {
            await adapter.addColumn('t', 'score', {
                type: 'integer', unique: true, default: 0, check: 'score >= 0',
                references: { table: 'r', column: 'id', onDelete: 'CASCADE', onUpdate: 'SET NULL' },
            });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('UNIQUE');
            expect(sql).toContain('DEFAULT 0');
            expect(sql).toContain('CHECK(score >= 0)');
            expect(sql).toContain('REFERENCES "r"("id")');
            expect(sql).toContain('ON DELETE CASCADE');
        });

        it('dropColumn', async () =>
        {
            await adapter.dropColumn('users', 'bio');
            expect(adapter._pool.query).toHaveBeenCalledWith('ALTER TABLE "users" DROP COLUMN "bio"');
        });

        it('renameColumn', async () =>
        {
            await adapter.renameColumn('users', 'bio', 'biography');
            expect(adapter._pool.query).toHaveBeenCalledWith('ALTER TABLE "users" RENAME COLUMN "bio" TO "biography"');
        });

        it('renameTable', async () =>
        {
            await adapter.renameTable('users', 'people');
            expect(adapter._pool.query).toHaveBeenCalledWith('ALTER TABLE "users" RENAME TO "people"');
        });
    });

    // -- createIndex / dropIndex --------------------------
    describe('createIndex & dropIndex', () =>
    {
        it('createIndex with array of columns', async () =>
        {
            await adapter.createIndex('users', ['email', 'name']);
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_users_email_name"');
        });

        it('createIndex with string column', async () =>
        {
            await adapter.createIndex('users', 'email');
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('"idx_users_email"');
        });

        it('createIndex unique + custom name', async () =>
        {
            await adapter.createIndex('users', ['email'], { name: 'uq_email', unique: true });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('CREATE UNIQUE INDEX');
            expect(sql).toContain('"uq_email"');
        });

        it('dropIndex', async () =>
        {
            await adapter.dropIndex('users', 'idx_name');
            expect(adapter._pool.query).toHaveBeenCalledWith('DROP INDEX IF EXISTS "idx_name"');
        });
    });

    // -- FK / hasTable / hasColumn / describeTable ---------
    describe('addForeignKey, dropForeignKey, hasTable, hasColumn, describeTable', () =>
    {
        it('addForeignKey with options', async () =>
        {
            await adapter.addForeignKey('posts', 'user_id', 'users', 'id', { onDelete: 'CASCADE', name: 'my_fk' });
            const sql = adapter._pool.query.mock.calls[0][0];
            expect(sql).toContain('"my_fk"');
            expect(sql).toContain('ON DELETE CASCADE');
        });

        it('dropForeignKey', async () =>
        {
            await adapter.dropForeignKey('posts', 'fk_posts_user');
            expect(adapter._pool.query).toHaveBeenCalledWith('ALTER TABLE "posts" DROP CONSTRAINT "fk_posts_user"');
        });

        it('hasTable returns true', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
            expect(await adapter.hasTable('users')).toBe(true);
        });

        it('hasTable returns false', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            expect(await adapter.hasTable('missing')).toBe(false);
        });

        it('hasColumn returns true/false', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [{}] });
            expect(await adapter.hasColumn('users', 'email')).toBe(true);
            adapter._pool.query.mockResolvedValueOnce({ rows: [] });
            expect(await adapter.hasColumn('users', 'xxx')).toBe(false);
        });

        it('describeTable returns column detail', async () =>
        {
            adapter._pool.query.mockResolvedValueOnce({ rows: [
                { name: 'id', type: 'integer', nullable: false, default_value: null, pk: true },
            ] });
            const desc = await adapter.describeTable('users');
            expect(desc[0].primaryKey).toBe(true);
        });
    });
});
