/**
 * Tests for BaseSqlAdapter pure utility methods.
 * All methods are testable without a real database connection.
 */
const BaseSqlAdapter = require('../../../lib/orm/adapters/sql-base');

let adapter;
beforeEach(() => { adapter = new BaseSqlAdapter(); });

// ===========================================================
//  _buildWhere
// ===========================================================
describe('BaseSqlAdapter._buildWhere', () =>
{
    it('returns empty for null/undefined/empty conditions', () =>
    {
        expect(adapter._buildWhere(null)).toEqual({ clause: '', values: [] });
        expect(adapter._buildWhere(undefined)).toEqual({ clause: '', values: [] });
        expect(adapter._buildWhere({})).toEqual({ clause: '', values: [] });
    });

    it('builds a single condition', () =>
    {
        const r = adapter._buildWhere({ name: 'Alice' });
        expect(r.clause).toBe(' WHERE "name" = ?');
        expect(r.values).toEqual(['Alice']);
    });

    it('builds multiple conditions with AND', () =>
    {
        const r = adapter._buildWhere({ name: 'Alice', age: 30 });
        expect(r.clause).toBe(' WHERE "name" = ? AND "age" = ?');
        expect(r.values).toEqual(['Alice', 30]);
    });

    it('handles NULL values with IS NULL', () =>
    {
        const r = adapter._buildWhere({ deleted_at: null, name: 'Bob' });
        expect(r.clause).toBe(' WHERE "deleted_at" IS NULL AND "name" = ?');
        expect(r.values).toEqual(['Bob']);
    });

    it('converts booleans via _toSqlValue', () =>
    {
        const r = adapter._buildWhere({ active: true });
        expect(r.values).toEqual([1]);
    });

    it('converts dates via _toSqlValue', () =>
    {
        const d = new Date('2024-01-15T12:00:00Z');
        const r = adapter._buildWhere({ created: d });
        expect(r.values).toEqual([d.toISOString()]);
    });

    it('converts objects via _toSqlValue', () =>
    {
        const obj = { foo: 'bar' };
        const r = adapter._buildWhere({ meta: obj });
        expect(r.values).toEqual([JSON.stringify(obj)]);
    });
});

// ===========================================================
//  _buildWhereFromChain
// ===========================================================
describe('BaseSqlAdapter._buildWhereFromChain', () =>
{
    it('returns empty for null/undefined/empty', () =>
    {
        expect(adapter._buildWhereFromChain(null)).toEqual({ clause: '', values: [] });
        expect(adapter._buildWhereFromChain(undefined)).toEqual({ clause: '', values: [] });
        expect(adapter._buildWhereFromChain([])).toEqual({ clause: '', values: [] });
    });

    it('handles raw WHERE clauses', () =>
    {
        const r = adapter._buildWhereFromChain([
            { raw: 'score > ? AND score < ?', params: [10, 90], logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE score > ? AND score < ?');
        expect(r.values).toEqual([10, 90]);
    });

    it('handles raw WHERE with AND logic on non-first position', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'name', op: '=', value: 'Alice', logic: 'AND' },
            { raw: 'age > ?', params: [18], logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE "name" = ? AND age > ?');
        expect(r.values).toEqual(['Alice', 18]);
    });

    it('handles raw where with no params', () =>
    {
        const r = adapter._buildWhereFromChain([
            { raw: '1=1', logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE 1=1');
        expect(r.values).toEqual([]);
    });

    it('builds IS NULL', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'deleted_at', op: 'IS NULL', logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE "deleted_at" IS NULL');
        expect(r.values).toEqual([]);
    });

    it('builds IS NOT NULL', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'email', op: 'IS NOT NULL', logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE "email" IS NOT NULL');
        expect(r.values).toEqual([]);
    });

    it('builds IN with values', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'role', op: 'IN', value: ['admin', 'mod'], logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE "role" IN (?, ?)');
        expect(r.values).toEqual(['admin', 'mod']);
    });

    it('builds IN with empty array → false', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'role', op: 'IN', value: [], logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE 0');
    });

    it('builds NOT IN with empty array → true', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'role', op: 'NOT IN', value: [], logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE 1');
    });

    it('builds NOT IN with values', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'status', op: 'NOT IN', value: ['banned', 'inactive'], logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE "status" NOT IN (?, ?)');
        expect(r.values).toEqual(['banned', 'inactive']);
    });

    it('builds BETWEEN', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'age', op: 'BETWEEN', value: [18, 65], logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE "age" BETWEEN ? AND ?');
        expect(r.values).toEqual([18, 65]);
    });

    it('builds comparison operators (>, <, >=, <=, !=)', () =>
    {
        for (const op of ['>', '<', '>=', '<=', '!='])
        {
            const r = adapter._buildWhereFromChain([
                { field: 'score', op, value: 50, logic: 'AND' },
            ]);
            expect(r.clause).toBe(` WHERE "score" ${op} ?`);
            expect(r.values).toEqual([50]);
        }
    });

    it('builds LIKE', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'name', op: 'LIKE', value: '%alice%', logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE "name" LIKE ?');
        expect(r.values).toEqual(['%alice%']);
    });

    it('handles OR logic', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'name', op: '=', value: 'Alice', logic: 'AND' },
            { field: 'name', op: '=', value: 'Bob', logic: 'OR' },
        ]);
        expect(r.clause).toBe(' WHERE "name" = ? OR "name" = ?');
        expect(r.values).toEqual(['Alice', 'Bob']);
    });

    it('handles mixed AND + OR', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'active', op: '=', value: true, logic: 'AND' },
            { field: 'role', op: '=', value: 'admin', logic: 'AND' },
            { field: 'role', op: '=', value: 'mod', logic: 'OR' },
        ]);
        expect(r.clause).toBe(' WHERE "active" = ? AND "role" = ? OR "role" = ?');
        expect(r.values).toEqual([1, 'admin', 'mod']);
    });

    it('handles IN with non-array value → falls through to false', () =>
    {
        const r = adapter._buildWhereFromChain([
            { field: 'role', op: 'IN', value: null, logic: 'AND' },
        ]);
        expect(r.clause).toBe(' WHERE 0');
    });
});

// ===========================================================
//  _toSqlValue
// ===========================================================
describe('BaseSqlAdapter._toSqlValue', () =>
{
    it('converts Date to ISO string', () =>
    {
        const d = new Date('2024-06-15T10:30:00Z');
        expect(adapter._toSqlValue(d)).toBe('2024-06-15T10:30:00.000Z');
    });

    it('converts true → 1, false → 0', () =>
    {
        expect(adapter._toSqlValue(true)).toBe(1);
        expect(adapter._toSqlValue(false)).toBe(0);
    });

    it('converts objects to JSON string', () =>
    {
        expect(adapter._toSqlValue({ a: 1 })).toBe('{"a":1}');
        expect(adapter._toSqlValue([1, 2])).toBe('[1,2]');
    });

    it('passes through strings and numbers', () =>
    {
        expect(adapter._toSqlValue('hello')).toBe('hello');
        expect(adapter._toSqlValue(42)).toBe(42);
    });

    it('passes through null and undefined', () =>
    {
        expect(adapter._toSqlValue(null)).toBeNull();
        expect(adapter._toSqlValue(undefined)).toBeUndefined();
    });
});

// ===========================================================
//  _sqlDefault
// ===========================================================
describe('BaseSqlAdapter._sqlDefault', () =>
{
    it('returns NULL for null', () =>
    {
        expect(adapter._sqlDefault(null)).toBe('NULL');
    });

    it('returns number as string', () =>
    {
        expect(adapter._sqlDefault(42)).toBe('42');
        expect(adapter._sqlDefault(0)).toBe('0');
        expect(adapter._sqlDefault(-3.14)).toBe('-3.14');
    });

    it('returns boolean as 1 or 0', () =>
    {
        expect(adapter._sqlDefault(true)).toBe('1');
        expect(adapter._sqlDefault(false)).toBe('0');
    });

    it('returns string with single-quote escaping', () =>
    {
        expect(adapter._sqlDefault('hello')).toBe("'hello'");
        expect(adapter._sqlDefault("it's")).toBe("'it''s'");
    });

    it('returns NULL for other types (undefined, object)', () =>
    {
        expect(adapter._sqlDefault(undefined)).toBe('NULL');
        expect(adapter._sqlDefault({ a: 1 })).toBe('NULL');
    });
});

// ===========================================================
//  _buildJoins
// ===========================================================
describe('BaseSqlAdapter._buildJoins', () =>
{
    it('returns empty for null/undefined/empty', () =>
    {
        expect(adapter._buildJoins(null, 'users')).toBe('');
        expect(adapter._buildJoins(undefined, 'users')).toBe('');
        expect(adapter._buildJoins([], 'users')).toBe('');
    });

    it('builds a single JOIN', () =>
    {
        const joins = [{ type: 'INNER', table: 'posts', localKey: 'id', foreignKey: 'userId' }];
        expect(adapter._buildJoins(joins, 'users')).toBe(
            ' INNER JOIN "posts" ON "users"."id" = "posts"."userId"'
        );
    });

    it('builds multiple JOINs', () =>
    {
        const joins = [
            { type: 'LEFT', table: 'posts', localKey: 'id', foreignKey: 'userId' },
            { type: 'RIGHT', table: 'roles', localKey: 'roleId', foreignKey: 'id' },
        ];
        const result = adapter._buildJoins(joins, 'users');
        expect(result).toContain('LEFT JOIN "posts"');
        expect(result).toContain('RIGHT JOIN "roles"');
    });

    it('uses custom quote function', () =>
    {
        const joins = [{ type: 'INNER', table: 'posts', localKey: 'id', foreignKey: 'userId' }];
        const q = name => `\`${name}\``;
        expect(adapter._buildJoins(joins, 'users', q)).toBe(
            ' INNER JOIN `posts` ON `users`.`id` = `posts`.`userId`'
        );
    });
});

// ===========================================================
//  _buildGroupBy
// ===========================================================
describe('BaseSqlAdapter._buildGroupBy', () =>
{
    it('returns empty for null/undefined/empty', () =>
    {
        expect(adapter._buildGroupBy(null)).toBe('');
        expect(adapter._buildGroupBy(undefined)).toBe('');
        expect(adapter._buildGroupBy([])).toBe('');
    });

    it('builds single GROUP BY', () =>
    {
        expect(adapter._buildGroupBy(['role'])).toBe(' GROUP BY "role"');
    });

    it('builds multiple GROUP BY', () =>
    {
        expect(adapter._buildGroupBy(['role', 'status'])).toBe(' GROUP BY "role", "status"');
    });

    it('uses custom quote function', () =>
    {
        const q = name => `\`${name}\``;
        expect(adapter._buildGroupBy(['role'], q)).toBe(' GROUP BY `role`');
    });
});

// ===========================================================
//  _buildHaving
// ===========================================================
describe('BaseSqlAdapter._buildHaving', () =>
{
    it('returns empty for null/undefined/empty', () =>
    {
        const v = [];
        expect(adapter._buildHaving(null, v)).toBe('');
        expect(adapter._buildHaving(undefined, v)).toBe('');
        expect(adapter._buildHaving([], v)).toBe('');
    });

    it('builds a single HAVING clause', () =>
    {
        const values = [];
        const result = adapter._buildHaving(
            [{ field: 'count', op: '>', value: 5 }],
            values
        );
        expect(result).toBe(' HAVING "count" > ?');
        expect(values).toEqual([5]);
    });

    it('builds multiple HAVING clauses with AND', () =>
    {
        const values = [];
        const result = adapter._buildHaving(
            [
                { field: 'count', op: '>', value: 5 },
                { field: 'total', op: '<', value: 1000 },
            ],
            values
        );
        expect(result).toBe(' HAVING "count" > ? AND "total" < ?');
        expect(values).toEqual([5, 1000]);
    });

    it('converts Date values through _toSqlValue', () =>
    {
        const d = new Date('2024-01-01');
        const values = [];
        adapter._buildHaving([{ field: 'created', op: '>=', value: d }], values);
        expect(values).toEqual([d.toISOString()]);
    });

    it('uses custom quote function', () =>
    {
        const values = [];
        const q = name => `\`${name}\``;
        const result = adapter._buildHaving(
            [{ field: 'count', op: '>', value: 5 }],
            values, q
        );
        expect(result).toBe(' HAVING `count` > ?');
    });
});

// ===========================================================
//  _buildHavingPg
// ===========================================================
describe('BaseSqlAdapter._buildHavingPg', () =>
{
    it('returns empty clause for null/undefined/empty', () =>
    {
        expect(adapter._buildHavingPg(null, [], 1)).toEqual({ clause: '', nextIdx: 1 });
        expect(adapter._buildHavingPg(undefined, [], 3)).toEqual({ clause: '', nextIdx: 3 });
        expect(adapter._buildHavingPg([], [], 5)).toEqual({ clause: '', nextIdx: 5 });
    });

    it('builds HAVING with $N parameter placeholders', () =>
    {
        const values = [];
        const result = adapter._buildHavingPg(
            [{ field: 'count', op: '>', value: 5 }],
            values, 1
        );
        expect(result.clause).toBe(' HAVING "count" > $1');
        expect(result.nextIdx).toBe(2);
        expect(values).toEqual([5]);
    });

    it('builds multiple HAVING with sequential $N', () =>
    {
        const values = [];
        const result = adapter._buildHavingPg(
            [
                { field: 'count', op: '>', value: 5 },
                { field: 'total', op: '<', value: 1000 },
            ],
            values, 3
        );
        expect(result.clause).toBe(' HAVING "count" > $3 AND "total" < $4');
        expect(result.nextIdx).toBe(5);
        expect(values).toEqual([5, 1000]);
    });
});
