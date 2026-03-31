/**
 * MySQL adapter CRUD and utility method tests.
 * Mocks the mysql2/promise pool to capture generated SQL and verify correctness.
 */

// ============================================================
//  Helpers
// ============================================================
function makePool()
{
    return {
        execute: vi.fn().mockResolvedValue([[], []]),
        query: vi.fn().mockResolvedValue([[], []]),
        getConnection: vi.fn().mockResolvedValue({
            beginTransaction: vi.fn(),
            commit: vi.fn(),
            rollback: vi.fn(),
            ping: vi.fn(),
            release: vi.fn(),
        }),
        end: vi.fn(),
        pool: {
            _allConnections: { length: 5 },
            _freeConnections: { length: 3 },
            _connectionQueue: { length: 1 },
        },
    };
}

function makeMysql()
{
    // Use the existing adapter-unit mock pattern
    vi.doMock('mysql2/promise', () => ({
        createPool: () => ({ execute: vi.fn(), query: vi.fn(), end: vi.fn() }),
    }));
    delete require.cache[require.resolve('../../../lib/orm/adapters/mysql')];
    const MysqlAdapter = require('../../../lib/orm/adapters/mysql');
    const adapter = new MysqlAdapter({ database: 'test_db', connectionLimit: 10 });
    // Replace pool with a fully-mocked version
    adapter._pool = makePool();
    return adapter;
}

// ============================================================
//  Tests
// ============================================================
describe('MysqlAdapter CRUD methods', () =>
{
    let adapter;

    beforeEach(() => { adapter = makeMysql(); });

    // -- createTable ---------------------------------------
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
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS `users`');
            expect(sql).toContain('`id` INT PRIMARY KEY AUTO_INCREMENT');
            expect(sql).toContain('`name` VARCHAR(100) NOT NULL');
            expect(sql).toContain('`active` TINYINT(1) DEFAULT 1');
            expect(sql).toContain('ENGINE=InnoDB');
            expect(sql).toContain('DEFAULT CHARSET=utf8mb4');
        });

        it('handles composite primary key', async () =>
        {
            const schema = {
                user_id: { type: 'integer', primaryKey: true, compositeKey: true },
                post_id: { type: 'integer', primaryKey: true, compositeKey: true },
            };
            await adapter.createTable('user_posts', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('PRIMARY KEY (`user_id`, `post_id`)');
        });

        it('handles composite unique constraints', async () =>
        {
            const schema = {
                email: { type: 'string', compositeUnique: 'email_org' },
                org: { type: 'string', compositeUnique: 'email_org' },
            };
            await adapter.createTable('accounts', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('UNIQUE KEY `uq_accounts_email_org`');
        });

        it('handles foreign key references', async () =>
        {
            const schema = {
                id: { type: 'integer', primaryKey: true },
                author_id: {
                    type: 'integer',
                    references: { table: 'users', column: 'id', onDelete: 'CASCADE', onUpdate: 'SET NULL' },
                },
            };
            await adapter.createTable('posts', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('CONSTRAINT `fk_posts_author_id` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`)');
            expect(sql).toContain('ON DELETE CASCADE');
            expect(sql).toContain('ON UPDATE SET NULL');
        });

        it('handles CHECK constraints', async () =>
        {
            const schema = {
                age: { type: 'integer', check: 'age >= 0' },
            };
            await adapter.createTable('people', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('CHECK(age >= 0)');
        });

        it('handles column charset, collation, and comment', async () =>
        {
            const schema = {
                bio: { type: 'text', charset: 'utf8mb4', collation: 'utf8mb4_bin', comment: "User's bio" },
            };
            await adapter.createTable('profiles', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('CHARACTER SET utf8mb4');
            expect(sql).toContain('COLLATE utf8mb4_bin');
            expect(sql).toContain("COMMENT 'User''s bio'");
        });

        it('handles unsigned columns', async () =>
        {
            const schema = {
                count: { type: 'integer', unsigned: true },
            };
            await adapter.createTable('counters', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('INT UNSIGNED');
        });

        it('creates indexes from schema', async () =>
        {
            const schema = {
                id: { type: 'integer', primaryKey: true },
                email: { type: 'string', index: true },
                slug: { type: 'string', index: 'idx_custom_slug' },
            };
            await adapter.createTable('posts', schema);
            // First call: CREATE TABLE, second+third calls: CREATE INDEX
            const calls = adapter._pool.execute.mock.calls;
            expect(calls.length).toBeGreaterThanOrEqual(3);
            expect(calls[1][0]).toContain('CREATE INDEX `idx_posts_email`');
            expect(calls[2][0]).toContain('CREATE INDEX `idx_custom_slug`');
        });

        it('creates composite indexes', async () =>
        {
            const schema = {
                a: { type: 'string', compositeIndex: 'ab' },
                b: { type: 'string', compositeIndex: 'ab' },
            };
            await adapter.createTable('t1', schema);
            const calls = adapter._pool.execute.mock.calls;
            const idxCall = calls.find(c => c[0].includes('idx_t1_ab'));
            expect(idxCall).toBeDefined();
            expect(idxCall[0]).toContain('`a`');
            expect(idxCall[0]).toContain('`b`');
        });

        it('applies table options (engine, charset, collation, comment)', async () =>
        {
            const schema = { id: { type: 'integer', primaryKey: true } };
            await adapter.createTable('t', schema, { engine: 'MyISAM', charset: 'latin1', collation: 'latin1_general_ci', comment: 'Test' });
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('ENGINE=MyISAM');
            expect(sql).toContain('DEFAULT CHARSET=latin1');
            expect(sql).toContain('COLLATE=latin1_general_ci');
            expect(sql).toContain("COMMENT='Test'");
        });

        it('handles column default with string that needs escaping', async () =>
        {
            const schema = {
                status: { type: 'string', default: "it's ok" },
            };
            await adapter.createTable('items', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain("DEFAULT 'it''s ok'");
        });

        it('handles unique columns', async () =>
        {
            const schema = {
                email: { type: 'string', unique: true },
            };
            await adapter.createTable('u', schema);
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('UNIQUE');
        });
    });

    // -- dropTable -----------------------------------------
    describe('dropTable', () =>
    {
        it('generates DROP TABLE IF EXISTS', async () =>
        {
            await adapter.dropTable('users');
            expect(adapter._pool.execute).toHaveBeenCalledWith('DROP TABLE IF EXISTS `users`');
        });
    });

    // -- insert --------------------------------------------
    describe('insert', () =>
    {
        it('generates INSERT with placeholders', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([{ insertId: 42 }]);
            const result = await adapter.insert('users', { name: 'Alice', age: 30 });
            const [sql, values] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('INSERT INTO `users`');
            expect(sql).toContain('`name`, `age`');
            expect(sql).toContain('?, ?');
            expect(values).toEqual(['Alice', 30]);
            expect(result.id).toBe(42);
        });

        it('preserves existing id if provided', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([{ insertId: 0 }]);
            const result = await adapter.insert('users', { id: 7, name: 'Bob' });
            expect(result.id).toBe(7);
        });
    });

    // -- insertMany ----------------------------------------
    describe('insertMany', () =>
    {
        it('generates bulk INSERT with multiple placeholders', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([{ insertId: 10 }]);
            const result = await adapter.insertMany('users', [
                { name: 'Alice', age: 25 },
                { name: 'Bob', age: 30 },
            ]);
            const [sql, values] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('INSERT INTO `users` (`name`, `age`) VALUES (?, ?), (?, ?)');
            expect(values).toEqual(['Alice', 25, 'Bob', 30]);
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe(10);
            expect(result[1].id).toBe(11);
        });

        it('returns empty array for empty input', async () =>
        {
            const result = await adapter.insertMany('users', []);
            expect(result).toEqual([]);
        });
    });

    // -- update --------------------------------------------
    describe('update', () =>
    {
        it('generates UPDATE with SET and WHERE', async () =>
        {
            await adapter.update('users', 'id', 5, { name: 'Charlie', age: 35 });
            const [sql, values] = adapter._pool.execute.mock.calls[0];
            expect(sql).toBe('UPDATE `users` SET `name` = ?, `age` = ? WHERE `id` = ?');
            expect(values).toEqual(['Charlie', 35, 5]);
        });
    });

    // -- updateWhere ---------------------------------------
    describe('updateWhere', () =>
    {
        it('generates UPDATE with WHERE from conditions', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([{ affectedRows: 3 }]);
            const count = await adapter.updateWhere('users', { active: true }, { verified: true });
            const [sql, values] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('UPDATE `users` SET `verified` = ?');
            expect(sql).toContain('WHERE');
            expect(count).toBe(3);
        });
    });

    // -- remove --------------------------------------------
    describe('remove', () =>
    {
        it('generates DELETE with PK condition', async () =>
        {
            await adapter.remove('users', 'id', 7);
            const [sql, values] = adapter._pool.execute.mock.calls[0];
            expect(sql).toBe('DELETE FROM `users` WHERE `id` = ?');
            expect(values).toEqual([7]);
        });
    });

    // -- deleteWhere ---------------------------------------
    describe('deleteWhere', () =>
    {
        it('generates DELETE with conditions', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([{ affectedRows: 2 }]);
            const count = await adapter.deleteWhere('users', { active: false });
            expect(count).toBe(2);
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('DELETE FROM `users`');
        });
    });

    // -- execute (SELECT) ----------------------------------
    describe('execute', () =>
    {
        it('generates basic SELECT', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]]);
            const rows = await adapter.execute({ table: 'users', fields: ['id', 'name'] });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('SELECT `id`, `name` FROM `users`');
            expect(rows).toEqual([{ id: 1, name: 'Alice' }]);
        });

        it('generates SELECT * when no fields', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.execute({ table: 'users' });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('SELECT * FROM `users`');
        });

        it('handles DISTINCT', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.execute({ table: 'users', fields: ['name'], distinct: true });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('SELECT DISTINCT `name`');
        });

        it('handles ORDER BY', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.execute({ table: 'users', orderBy: [{ field: 'name', dir: 'asc' }, { field: 'id', dir: 'desc' }] });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('ORDER BY `name` asc, `id` desc');
        });

        it('handles LIMIT and OFFSET', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.execute({ table: 'users', limit: 10, offset: 20 });
            const [sql, values] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('LIMIT ?');
            expect(sql).toContain('OFFSET ?');
            expect(values).toContain(10);
            expect(values).toContain(20);
        });

        it('handles WHERE chain', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.execute({
                table: 'users',
                where: [{ field: 'age', op: '>', value: 18, logic: 'AND' }],
            });
            const [sql, values] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('WHERE');
            expect(values).toContain(18);
        });

        it('handles count action', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ count: 42 }]]);
            const count = await adapter.execute({ action: 'count', table: 'users' });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('SELECT COUNT(*) as count FROM `users`');
            expect(count).toBe(42);
        });

        it('handles JOINs', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.execute({
                table: 'posts',
                joins: [{ type: 'LEFT', table: 'users', localKey: 'author_id', foreignKey: 'id' }],
            });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('LEFT JOIN');
        });

        it('handles GROUP BY', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.execute({
                table: 'orders',
                fields: ['status'],
                groupBy: ['status'],
            });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('GROUP BY');
        });
    });

    // -- aggregate -----------------------------------------
    describe('aggregate', () =>
    {
        it('generates SUM aggregate', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ result: 1500 }]]);
            const result = await adapter.aggregate({
                table: 'orders',
                aggregateFn: 'SUM',
                aggregateField: 'total',
            });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('SELECT SUM(`total`) as result FROM `orders`');
            expect(result).toBe(1500);
        });

        it('returns null when no rows', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{}]]);
            const result = await adapter.aggregate({
                table: 'orders',
                aggregateFn: 'AVG',
                aggregateField: 'total',
            });
            // rows[0].result is undefined
            expect(result).toBeUndefined();
        });

        it('handles where + joins in aggregate', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ result: 100 }]]);
            await adapter.aggregate({
                table: 'orders',
                aggregateFn: 'COUNT',
                aggregateField: 'id',
                where: [{ field: 'status', op: '=', value: 'shipped', logic: 'AND' }],
                joins: [{ type: 'INNER', table: 'users', localKey: 'user_id', foreignKey: 'id' }],
            });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('COUNT(`id`)');
            expect(sql).toContain('INNER JOIN');
            expect(sql).toContain('WHERE');
        });
    });

    // -- explain -------------------------------------------
    describe('explain', () =>
    {
        it('generates EXPLAIN SELECT', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ id: 1, select_type: 'SIMPLE' }]]);
            await adapter.explain({ table: 'users', fields: ['id'] });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toMatch(/^EXPLAIN SELECT/);
        });

        it('generates EXPLAIN ANALYZE when option set', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.explain({ table: 'users' }, { analyze: true });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toMatch(/^EXPLAIN ANALYZE/);
        });
    });

    // -- stmtCacheStats ------------------------------------
    describe('stmtCacheStats', () =>
    {
        it('returns stats object', () =>
        {
            const stats = adapter.stmtCacheStats();
            expect(stats).toHaveProperty('uniqueQueries', 0);
            expect(stats).toHaveProperty('totalQueries', 0);
            expect(stats).toHaveProperty('driver');
        });
    });

    // -- warmup --------------------------------------------
    describe('warmup', () =>
    {
        it('warms up connections and releases them', async () =>
        {
            const conn = { release: vi.fn() };
            adapter._pool.getConnection.mockResolvedValue(conn);
            const count = await adapter.warmup(3);
            expect(count).toBe(3);
            expect(conn.release).toHaveBeenCalledTimes(3);
        });

        it('handles failed connections gracefully', async () =>
        {
            let callNum = 0;
            adapter._pool.getConnection.mockImplementation(() =>
            {
                callNum++;
                if (callNum > 2) return Promise.reject(new Error('No connection'));
                return Promise.resolve({ release: vi.fn() });
            });
            const count = await adapter.warmup(5);
            expect(count).toBe(2);
        });

        it('defaults to 5 when no count specified', async () =>
        {
            const conn = { release: vi.fn() };
            adapter._pool.getConnection.mockResolvedValue(conn);
            const count = await adapter.warmup();
            expect(count).toBe(5);
        });

        it('clamps to connectionLimit', async () =>
        {
            const conn = { release: vi.fn() };
            adapter._pool.getConnection.mockResolvedValue(conn);
            // adapter._options.connectionLimit = 10
            const count = await adapter.warmup(999);
            expect(count).toBe(10);
        });
    });

    // -- close ---------------------------------------------
    describe('close', () =>
    {
        it('ends the pool', async () =>
        {
            await adapter.close();
            expect(adapter._pool.end).toHaveBeenCalled();
        });
    });

    // -- raw -----------------------------------------------
    describe('raw', () =>
    {
        it('executes raw SQL and returns rows', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ id: 1 }]]);
            const rows = await adapter.raw('SELECT 1 AS id');
            expect(rows).toEqual([{ id: 1 }]);
        });

        it('passes parameters', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.raw('SELECT * FROM t WHERE id = ?', 5);
            expect(adapter._pool.execute.mock.calls[0][1]).toEqual([5]);
        });
    });

    // -- transaction ---------------------------------------
    describe('transaction', () =>
    {
        it('begins, executes fn, commits, and releases', async () =>
        {
            const conn = adapter._pool.getConnection.mock.results[0]
                ? await adapter._pool.getConnection()
                : { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
            adapter._pool.getConnection.mockResolvedValue(conn);

            const result = await adapter.transaction(async (c) =>
            {
                expect(c).toBe(conn);
                return 'ok';
            });
            expect(result).toBe('ok');
            expect(conn.beginTransaction).toHaveBeenCalled();
            expect(conn.commit).toHaveBeenCalled();
            expect(conn.release).toHaveBeenCalled();
        });

        it('rolls back on error', async () =>
        {
            const conn = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
            adapter._pool.getConnection.mockResolvedValue(conn);

            await expect(adapter.transaction(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
            expect(conn.rollback).toHaveBeenCalled();
            expect(conn.release).toHaveBeenCalled();
        });
    });

    // -- tables / columns / databaseSize -------------------
    describe('utility queries', () =>
    {
        it('tables() returns table names', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ Tables_in_test: 'users' }, { Tables_in_test: 'posts' }]]);
            const tables = await adapter.tables();
            expect(tables).toEqual(['users', 'posts']);
        });

        it('columns() returns column info', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ Field: 'id', Type: 'int' }]]);
            const cols = await adapter.columns('users');
            expect(cols[0].Field).toBe('id');
        });

        it('databaseSize() returns number', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ size: '1048576' }]]);
            const size = await adapter.databaseSize();
            expect(size).toBe(1048576);
        });

        it('databaseSize() returns 0 when no database', async () =>
        {
            adapter._options.database = undefined;
            const size = await adapter.databaseSize();
            expect(size).toBe(0);
        });
    });

    // -- poolStatus ----------------------------------------
    describe('poolStatus', () =>
    {
        it('returns pool status from internal pool', () =>
        {
            const status = adapter.poolStatus();
            expect(status).toEqual({ total: 5, idle: 3, used: 2, queued: 1 });
        });

        it('returns zeros when pool.pool is undefined', () =>
        {
            adapter._pool.pool = undefined;
            expect(adapter.poolStatus()).toEqual({ total: 0, idle: 0, used: 0, queued: 0 });
        });
    });

    // -- version / ping ------------------------------------
    describe('version & ping', () =>
    {
        it('version() returns server version', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ ver: '8.0.36' }]]);
            expect(await adapter.version()).toBe('8.0.36');
        });

        it('ping() returns true on success', async () =>
        {
            const conn = { ping: vi.fn(), release: vi.fn() };
            adapter._pool.getConnection.mockResolvedValue(conn);
            expect(await adapter.ping()).toBe(true);
            expect(conn.release).toHaveBeenCalled();
        });

        it('ping() returns false on failure', async () =>
        {
            adapter._pool.getConnection.mockRejectedValueOnce(new Error('no'));
            expect(await adapter.ping()).toBe(false);
        });
    });

    // -- exec ----------------------------------------------
    describe('exec', () =>
    {
        it('returns affectedRows and insertId', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([{ affectedRows: 5, insertId: 10 }]);
            const result = await adapter.exec('UPDATE t SET x = ?', 1);
            expect(result).toEqual({ affectedRows: 5, insertId: 10 });
        });

        it('defaults to 0 when missing', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([{}]);
            const result = await adapter.exec('DELETE FROM t');
            expect(result).toEqual({ affectedRows: 0, insertId: 0 });
        });
    });

    // -- tableStatus / tableSize ---------------------------
    describe('tableStatus & tableSize', () =>
    {
        it('tableStatus() maps rows correctly', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{
                Name: 'users', Engine: 'InnoDB', Rows: 100,
                Data_length: 16384, Index_length: 8192,
                Auto_increment: 101, Collation: 'utf8mb4_unicode_ci',
                Create_time: '2024-01-01', Update_time: '2024-06-01',
                Comment: 'User table',
            }]]);
            const status = await adapter.tableStatus('users');
            expect(status[0].name).toBe('users');
            expect(status[0].totalSize).toBe(24576);
            expect(status[0].comment).toBe('User table');
        });

        it('tableStatus() without table arg shows all', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.tableStatus();
            const [sql, params] = adapter._pool.execute.mock.calls[0];
            expect(sql).toBe('SHOW TABLE STATUS');
            expect(params).toEqual([]);
        });

        it('tableSize() returns formatted sizes', async () =>
        {
            // Mock tableStatus via execute
            adapter._pool.execute.mockResolvedValueOnce([[{
                Name: 't', Engine: 'InnoDB', Rows: 5000,
                Data_length: 2097152, Index_length: 1048576,
                Auto_increment: null, Collation: 'utf8mb4_unicode_ci',
                Create_time: null, Update_time: null, Comment: '',
            }]]);
            const size = await adapter.tableSize('t');
            expect(size.rows).toBe(5000);
            expect(size.dataSize).toBe('2.00 MB');
            expect(size.indexSize).toBe('1.00 MB');
            expect(size.totalSize).toBe('3.00 MB');
        });

        it('tableSize() returns 0 B for nonexistent table', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            const size = await adapter.tableSize('missing');
            expect(size.totalSize).toBe('0 B');
        });
    });

    // -- indexes -------------------------------------------
    describe('indexes', () =>
    {
        it('returns mapped index info', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{
                Key_name: 'PRIMARY', Column_name: 'id', Non_unique: 0,
                Index_type: 'BTREE', Cardinality: 100,
            }]]);
            const idx = await adapter.indexes('users');
            expect(idx[0]).toEqual({ name: 'PRIMARY', column: 'id', unique: true, type: 'BTREE', cardinality: 100 });
        });
    });

    // -- tableCharset / foreignKeys ------------------------
    describe('tableCharset & foreignKeys', () =>
    {
        it('tableCharset() extracts charset from collation', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ TABLE_COLLATION: 'utf8mb4_unicode_ci' }]]);
            const { charset, collation } = await adapter.tableCharset('users');
            expect(charset).toBe('utf8mb4');
            expect(collation).toBe('utf8mb4_unicode_ci');
        });

        it('tableCharset() returns empty for missing table', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            const { charset, collation } = await adapter.tableCharset('missing');
            expect(charset).toBe('');
            expect(collation).toBe('');
        });

        it('foreignKeys() returns mapped FK info', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{
                CONSTRAINT_NAME: 'fk_posts_user', COLUMN_NAME: 'user_id',
                REFERENCED_TABLE_NAME: 'users', REFERENCED_COLUMN_NAME: 'id',
                DELETE_RULE: 'CASCADE', UPDATE_RULE: 'RESTRICT',
            }]]);
            const fks = await adapter.foreignKeys('posts');
            expect(fks[0].constraintName).toBe('fk_posts_user');
            expect(fks[0].referencedTable).toBe('users');
        });
    });

    // -- overview ------------------------------------------
    describe('overview', () =>
    {
        it('returns aggregated database overview', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[
                { Name: 'a', Engine: 'InnoDB', Rows: 10, Data_length: 1024, Index_length: 512, Auto_increment: null, Collation: 'utf8mb4_unicode_ci', Create_time: null, Update_time: null, Comment: '' },
                { Name: 'b', Engine: 'InnoDB', Rows: 20, Data_length: 2048, Index_length: 1024, Auto_increment: null, Collation: 'utf8mb4_unicode_ci', Create_time: null, Update_time: null, Comment: '' },
            ]]);
            const ov = await adapter.overview();
            expect(ov.totalRows).toBe(30);
            expect(ov.tables).toHaveLength(2);
            expect(ov.totalSize).toBe('4.50 KB');
        });
    });

    // -- variables / processlist ---------------------------
    describe('variables & processlist', () =>
    {
        it('variables() returns key/value map', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[
                { Variable_name: 'max_connections', Value: '100' },
                { Variable_name: 'wait_timeout', Value: '28800' },
            ]]);
            const vars = await adapter.variables();
            expect(vars.max_connections).toBe('100');
        });

        it('variables() with filter adds LIKE', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            await adapter.variables('max%');
            const [sql, params] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('LIKE ?');
            expect(params).toEqual(['max%']);
        });

        it('processlist() returns mapped processes', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{
                Id: 1, User: 'root', Host: 'localhost', db: 'test',
                Command: 'Query', Time: 0, State: 'executing', Info: 'SELECT 1',
            }]]);
            const pl = await adapter.processlist();
            expect(pl[0].user).toBe('root');
            expect(pl[0].info).toBe('SELECT 1');
        });
    });

    // -- alterTable ----------------------------------------
    describe('alterTable', () =>
    {
        it('alters engine, charset, and collation', async () =>
        {
            await adapter.alterTable('users', { engine: 'MyISAM', charset: 'utf8', collation: 'utf8_general_ci' });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('ALTER TABLE `users`');
            expect(sql).toContain('ENGINE=MyISAM');
            expect(sql).toContain('DEFAULT CHARSET=utf8');
            expect(sql).toContain('COLLATE=utf8_general_ci');
        });

        it('does nothing when no options', async () =>
        {
            await adapter.alterTable('users', {});
            expect(adapter._pool.execute).not.toHaveBeenCalled();
        });
    });

    // -- DDL: addColumn, dropColumn, renameColumn, renameTable
    describe('schema migration DDL', () =>
    {
        it('addColumn generates ALTER TABLE ADD COLUMN', async () =>
        {
            await adapter.addColumn('users', 'bio', { type: 'text', required: true });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('ALTER TABLE `users` ADD COLUMN `bio` TEXT NOT NULL');
        });

        it('addColumn with AFTER option', async () =>
        {
            await adapter.addColumn('users', 'bio', { type: 'text' }, { after: 'name' });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('AFTER `name`');
        });

        it('addColumn with FK reference', async () =>
        {
            await adapter.addColumn('posts', 'author_id', {
                type: 'integer',
                references: { table: 'users', column: 'id', onDelete: 'CASCADE' },
            });
            // First call: ADD COLUMN, second call: ADD CONSTRAINT
            expect(adapter._pool.execute.mock.calls.length).toBe(2);
            expect(adapter._pool.execute.mock.calls[1][0]).toContain('ADD CONSTRAINT `fk_posts_author_id`');
        });

        it('addColumn with check, unique, default, unsigned, comment', async () =>
        {
            await adapter.addColumn('t', 'score', {
                type: 'integer', unsigned: true, unique: true,
                default: 0, check: 'score >= 0', comment: 'test',
            });
            const sql = adapter._pool.execute.mock.calls[0][0];
            expect(sql).toContain('UNSIGNED');
            expect(sql).toContain('UNIQUE');
            expect(sql).toContain('DEFAULT 0');
            expect(sql).toContain('CHECK(score >= 0)');
            expect(sql).toContain("COMMENT 'test'");
        });

        it('dropColumn generates ALTER TABLE DROP COLUMN', async () =>
        {
            await adapter.dropColumn('users', 'bio');
            expect(adapter._pool.execute).toHaveBeenCalledWith('ALTER TABLE `users` DROP COLUMN `bio`');
        });

        it('renameColumn generates ALTER TABLE RENAME COLUMN', async () =>
        {
            await adapter.renameColumn('users', 'bio', 'biography');
            expect(adapter._pool.execute).toHaveBeenCalledWith('ALTER TABLE `users` RENAME COLUMN `bio` TO `biography`');
        });

        it('renameTable generates RENAME TABLE', async () =>
        {
            await adapter.renameTable('users', 'people');
            expect(adapter._pool.execute).toHaveBeenCalledWith('RENAME TABLE `users` TO `people`');
        });
    });

    // -- createIndex / dropIndex ---------------------------
    describe('createIndex & dropIndex', () =>
    {
        it('createIndex with default name', async () =>
        {
            await adapter.createIndex('users', ['email', 'name']);
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('CREATE INDEX `idx_users_email_name`');
            expect(sql).toContain('`email`, `name`');
        });

        it('createIndex with unique + custom name', async () =>
        {
            await adapter.createIndex('users', ['email'], { name: 'uq_email', unique: true });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('CREATE UNIQUE INDEX `uq_email`');
        });

        it('dropIndex generates DROP INDEX', async () =>
        {
            await adapter.dropIndex('users', 'idx_email');
            expect(adapter._pool.execute).toHaveBeenCalledWith('DROP INDEX `idx_email` ON `users`');
        });
    });

    // -- addForeignKey / dropForeignKey --------------------
    describe('addForeignKey & dropForeignKey', () =>
    {
        it('addForeignKey with cascade', async () =>
        {
            await adapter.addForeignKey('posts', 'user_id', 'users', 'id', { onDelete: 'CASCADE', onUpdate: 'SET NULL' });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('ADD CONSTRAINT `fk_posts_user_id` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)');
            expect(sql).toContain('ON DELETE CASCADE');
            expect(sql).toContain('ON UPDATE SET NULL');
        });

        it('addForeignKey with custom name', async () =>
        {
            await adapter.addForeignKey('posts', 'user_id', 'users', 'id', { name: 'my_fk' });
            const [sql] = adapter._pool.execute.mock.calls[0];
            expect(sql).toContain('`my_fk`');
        });

        it('dropForeignKey generates DROP FOREIGN KEY', async () =>
        {
            await adapter.dropForeignKey('posts', 'fk_posts_user_id');
            expect(adapter._pool.execute).toHaveBeenCalledWith('ALTER TABLE `posts` DROP FOREIGN KEY `fk_posts_user_id`');
        });
    });

    // -- hasTable / hasColumn / describeTable --------------
    describe('hasTable, hasColumn, describeTable', () =>
    {
        it('hasTable returns true when found', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ 1: 1 }]]);
            expect(await adapter.hasTable('users')).toBe(true);
        });

        it('hasTable returns false when not found', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            expect(await adapter.hasTable('missing')).toBe(false);
        });

        it('hasColumn returns true when found', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[{ 1: 1 }]]);
            expect(await adapter.hasColumn('users', 'email')).toBe(true);
        });

        it('hasColumn returns false when not found', async () =>
        {
            adapter._pool.execute.mockResolvedValueOnce([[]]);
            expect(await adapter.hasColumn('users', 'missing')).toBe(false);
        });

        it('describeTable returns columns + indexes + foreignKeys', async () =>
        {
            adapter._pool.execute
                .mockResolvedValueOnce([[{ Field: 'id' }]]) // columns
                .mockResolvedValueOnce([[{ Key_name: 'PRIMARY', Column_name: 'id', Non_unique: 0, Index_type: 'BTREE', Cardinality: 10 }]]) // indexes
                .mockResolvedValueOnce([[]]); // foreignKeys
            const desc = await adapter.describeTable('users');
            expect(desc.columns).toHaveLength(1);
            expect(desc.indexes).toHaveLength(1);
            expect(desc.foreignKeys).toHaveLength(0);
        });
    });
});
