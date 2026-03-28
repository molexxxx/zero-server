/**
 * Tests for LINQ-inspired Query builder features and Model static shortcuts.
 *
 * Covers: when/unless, tap, chunk, each, map, filter, reduce, paginate,
 *         take/skip, toArray, orderByDesc, last, whereRaw, and
 *         Model.first/last/paginate/chunk/all/random/pluck.
 */
const { Database, Model, TYPES } = require('../lib/orm');

// -- Test Models -----------------------------------------

class User extends Model
{
    static table = 'users';
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING,  required: true },
        age:   { type: TYPES.INTEGER },
        role:  { type: TYPES.STRING, default: 'user' },
        score: { type: TYPES.INTEGER, default: 0 },
    };
    static scopes = {
        adults: q => q.where('age', '>=', 18),
        admins: q => q.where('role', 'admin'),
    };
}

let db;

beforeAll(async () =>
{
    db = Database.connect('memory');
    db.register(User);
    await db.sync();
});

beforeEach(async () =>
{
    db.adapter.clear();
    // Seed 15 users directly into the memory adapter
    const table = db.adapter._getTable('users');
    db.adapter._autoIncrements.set('users', 1);

    for (let i = 1; i <= 15; i++)
    {
        table.push({
            id: i,
            name: `User${i}`,
            age: 15 + i,           // 16..30
            role: i <= 5 ? 'admin' : 'user',
            score: i * 10,         // 10..150
        });
    }
    db.adapter._autoIncrements.set('users', 16);
});

// -- Query Builder LINQ Features -------------------------

describe('Query: take() / skip()', () =>
{
    it('take(n) is an alias for limit(n)', async () =>
    {
        const users = await User.query().take(3);
        expect(users).toHaveLength(3);
    });

    it('skip(n) is an alias for offset(n)', async () =>
    {
        const users = await User.query().skip(10).take(5);
        expect(users).toHaveLength(5);
        expect(users[0].id).toBe(11);
    });

    it('chained take + skip produces correct page', async () =>
    {
        const page2 = await User.query().orderBy('id').skip(5).take(5);
        expect(page2[0].name).toBe('User6');
        expect(page2[4].name).toBe('User10');
    });
});

describe('Query: toArray()', () =>
{
    it('toArray() returns same result as exec()', async () =>
    {
        const fromExec = await User.query().exec();
        const fromArray = await User.query().toArray();
        expect(fromExec).toHaveLength(fromArray.length);
    });
});

describe('Query: orderByDesc()', () =>
{
    it('orderByDesc sorts descending', async () =>
    {
        const users = await User.query().orderByDesc('score').take(3);
        expect(users[0].score).toBe(150);
        expect(users[1].score).toBe(140);
        expect(users[2].score).toBe(130);
    });
});

describe('Query: last()', () =>
{
    it('returns the last record by primary key', async () =>
    {
        const user = await User.query().last();
        expect(user.id).toBe(15);
        expect(user.name).toBe('User15');
    });

    it('returns last with existing order (reverses it)', async () =>
    {
        const user = await User.query().orderBy('score', 'asc').last();
        // Reverses ASC → DESC, so last = highest score
        expect(user.score).toBe(150);
    });

    it('returns null when no results match', async () =>
    {
        const user = await User.query().where('name', 'NonExistent').last();
        expect(user).toBeNull();
    });
});

describe('Query: when() / unless()', () =>
{
    it('when(true) applies the callback', async () =>
    {
        const users = await User.query()
            .when(true, q => q.where('role', 'admin'));
        expect(users).toHaveLength(5);
    });

    it('when(false) skips the callback', async () =>
    {
        const users = await User.query()
            .when(false, q => q.where('role', 'admin'));
        expect(users).toHaveLength(15);
    });

    it('when() with truthy non-boolean value', async () =>
    {
        const roleFilter = 'admin';
        const users = await User.query()
            .when(roleFilter, q => q.where('role', roleFilter));
        expect(users).toHaveLength(5);
    });

    it('when() with falsy value (empty string)', async () =>
    {
        const roleFilter = '';
        const users = await User.query()
            .when(roleFilter, q => q.where('role', 'admin'));
        expect(users).toHaveLength(15);
    });

    it('unless(true) skips the callback', async () =>
    {
        const users = await User.query()
            .unless(true, q => q.where('role', 'admin'));
        expect(users).toHaveLength(15);
    });

    it('unless(false) applies the callback', async () =>
    {
        const users = await User.query()
            .unless(false, q => q.where('role', 'admin'));
        expect(users).toHaveLength(5);
    });

    it('when + unless chained for complex conditional logic', async () =>
    {
        const showAdmins = true;
        const showAll = false;

        const users = await User.query()
            .when(showAdmins, q => q.where('role', 'admin'))
            .unless(showAll, q => q.limit(3));
        expect(users).toHaveLength(3);
    });
});

describe('Query: tap()', () =>
{
    it('tap calls fn without modifying the chain', async () =>
    {
        let captured = null;
        const users = await User.query()
            .where('role', 'admin')
            .tap(q => { captured = q.build(); })
            .limit(2);

        expect(captured).not.toBeNull();
        expect(captured.where[0].value).toBe('admin');
        expect(users).toHaveLength(2);
    });

    it('tap can be used for logging', async () =>
    {
        const logs = [];
        await User.query()
            .tap(q => logs.push('before where'))
            .where('age', '>', 20)
            .tap(q => logs.push('after where'));

        expect(logs).toEqual(['before where', 'after where']);
    });
});

describe('Query: chunk()', () =>
{
    it('processes all records in batches', async () =>
    {
        const batches = [];
        await User.query().orderBy('id').chunk(5, (batch, idx) =>
        {
            batches.push({ count: batch.length, index: idx });
        });

        expect(batches).toHaveLength(3);
        expect(batches[0]).toEqual({ count: 5, index: 0 });
        expect(batches[1]).toEqual({ count: 5, index: 1 });
        expect(batches[2]).toEqual({ count: 5, index: 2 });
    });

    it('chunk of 10 over 15 records = 2 batches', async () =>
    {
        const counts = [];
        await User.query().chunk(10, (batch) => counts.push(batch.length));
        expect(counts).toEqual([10, 5]);
    });

    it('chunk with filter applies WHERE', async () =>
    {
        const batches = [];
        await User.query()
            .where('role', 'admin')
            .chunk(2, (batch, idx) => batches.push({ count: batch.length, idx }));

        expect(batches[0].count).toBe(2);
        // 5 admins → 3 batches (2, 2, 1)
        expect(batches).toHaveLength(3);
    });

    it('chunk handles empty results', async () =>
    {
        let called = false;
        await User.query()
            .where('name', 'Nonexistent')
            .chunk(10, () => { called = true; });
        expect(called).toBe(false);
    });

    it('chunk supports async callbacks', async () =>
    {
        let totalProcessed = 0;
        await User.query().chunk(5, async (batch) =>
        {
            await new Promise(r => setTimeout(r, 1));
            totalProcessed += batch.length;
        });
        expect(totalProcessed).toBe(15);
    });
});

describe('Query: each()', () =>
{
    it('iterates all results with index', async () =>
    {
        const items = [];
        await User.query().where('role', 'admin').orderBy('id').each((user, i) =>
        {
            items.push({ id: user.id, index: i });
        });
        expect(items).toHaveLength(5);
        expect(items[0]).toEqual({ id: 1, index: 0 });
        expect(items[4]).toEqual({ id: 5, index: 4 });
    });

    it('each supports async callbacks', async () =>
    {
        let sum = 0;
        await User.query().where('role', 'admin').each(async (user) =>
        {
            await new Promise(r => setTimeout(r, 1));
            sum += user.score;
        });
        expect(sum).toBe(10 + 20 + 30 + 40 + 50);
    });
});

describe('Query: map()', () =>
{
    it('transforms results with a mapper', async () =>
    {
        const names = await User.query()
            .where('role', 'admin')
            .orderBy('id')
            .map(u => u.name);
        expect(names).toEqual(['User1', 'User2', 'User3', 'User4', 'User5']);
    });

    it('map can return objects', async () =>
    {
        const summaries = await User.query().take(2).orderBy('id').map(u => ({
            label: `${u.name} (${u.age})`,
            isAdmin: u.role === 'admin',
        }));
        expect(summaries[0].label).toBe('User1 (16)');
        expect(summaries[0].isAdmin).toBe(true);
    });
});

describe('Query: filter()', () =>
{
    it('filters results with a predicate', async () =>
    {
        const highScorers = await User.query()
            .filter(u => u.score > 100);
        expect(highScorers).toHaveLength(5); // scores 110-150
    });

    it('filter can combine with where for hybrid queries', async () =>
    {
        // WHERE role='admin' in adapter, then post-filter in JS
        const oldAdmins = await User.query()
            .where('role', 'admin')
            .filter(u => u.age > 18);
        // admins: ids 1-5, ages 16-20, so age > 18 = ids 4,5 (ages 19,20)
        expect(oldAdmins).toHaveLength(2);
    });
});

describe('Query: reduce()', () =>
{
    it('reduces results to a single value', async () =>
    {
        const totalScore = await User.query()
            .where('role', 'admin')
            .reduce((sum, u) => sum + u.score, 0);
        expect(totalScore).toBe(150); // 10+20+30+40+50
    });

    it('reduce can build an object', async () =>
    {
        const byRole = await User.query().reduce((acc, u) =>
        {
            acc[u.role] = (acc[u.role] || 0) + 1;
            return acc;
        }, {});
        expect(byRole).toEqual({ admin: 5, user: 10 });
    });
});

describe('Query: paginate()', () =>
{
    it('returns rich pagination metadata', async () =>
    {
        const result = await User.query().paginate(1, 5);
        expect(result.data).toHaveLength(5);
        expect(result.total).toBe(15);
        expect(result.page).toBe(1);
        expect(result.perPage).toBe(5);
        expect(result.pages).toBe(3);
        expect(result.hasNext).toBe(true);
        expect(result.hasPrev).toBe(false);
    });

    it('page 2 has hasPrev and hasNext', async () =>
    {
        const result = await User.query().paginate(2, 5);
        expect(result.hasPrev).toBe(true);
        expect(result.hasNext).toBe(true);
        expect(result.data).toHaveLength(5);
    });

    it('last page has hasPrev but not hasNext', async () =>
    {
        const result = await User.query().paginate(3, 5);
        expect(result.hasNext).toBe(false);
        expect(result.hasPrev).toBe(true);
        expect(result.data).toHaveLength(5);
    });

    it('paginate respects filters', async () =>
    {
        const result = await User.query().where('role', 'admin').paginate(1, 3);
        expect(result.total).toBe(5);
        expect(result.pages).toBe(2);
        expect(result.data).toHaveLength(3);
        expect(result.hasNext).toBe(true);
    });

    it('page beyond range returns empty data', async () =>
    {
        const result = await User.query().paginate(100, 5);
        expect(result.data).toHaveLength(0);
        expect(result.hasNext).toBe(false);
        expect(result.hasPrev).toBe(true);
    });

    it('defaults to perPage=20', async () =>
    {
        const result = await User.query().paginate(1);
        expect(result.perPage).toBe(20);
        expect(result.data).toHaveLength(15); // only 15 users
        expect(result.pages).toBe(1);
    });

    it('page 0 or negative clamps to 1', async () =>
    {
        const result = await User.query().paginate(0, 5);
        expect(result.page).toBe(1);
        expect(result.data).toHaveLength(5);
    });
});

describe('Query: whereRaw()', () =>
{
    it('whereRaw is skipped by memory adapter (no crash)', async () =>
    {
        // Memory adapter ignores raw clauses — should return all rows
        const users = await User.query()
            .whereRaw('age > ?', 20)
            .toArray();
        // raw is skipped by memory adapter, so all 15 returned
        expect(users).toHaveLength(15);
    });
});

// -- Model Static Shortcuts ------------------------------

describe('Model.first()', () =>
{
    it('returns first record', async () =>
    {
        const user = await User.first();
        expect(user).not.toBeNull();
        expect(user.id).toBe(1);
    });

    it('returns first matching condition', async () =>
    {
        const admin = await User.first({ role: 'admin' });
        expect(admin.role).toBe('admin');
    });

    it('returns null when no match', async () =>
    {
        const user = await User.first({ name: 'Ghost' });
        expect(user).toBeNull();
    });
});

describe('Model.last()', () =>
{
    it('returns last record by PK', async () =>
    {
        const user = await User.last();
        expect(user.id).toBe(15);
    });

    it('returns last matching condition', async () =>
    {
        const admin = await User.last({ role: 'admin' });
        expect(admin.id).toBe(5);
    });
});

describe('Model.all()', () =>
{
    it('returns all records', async () =>
    {
        const users = await User.all();
        expect(users).toHaveLength(15);
    });

    it('returns filtered records', async () =>
    {
        const admins = await User.all({ role: 'admin' });
        expect(admins).toHaveLength(5);
    });
});

describe('Model.paginate()', () =>
{
    it('returns paginated results with metadata', async () =>
    {
        const result = await User.paginate(1, 5);
        expect(result.total).toBe(15);
        expect(result.pages).toBe(3);
        expect(result.data).toHaveLength(5);
    });

    it('paginate with conditions', async () =>
    {
        const result = await User.paginate(1, 3, { role: 'admin' });
        expect(result.total).toBe(5);
        expect(result.data).toHaveLength(3);
    });
});

describe('Model.chunk()', () =>
{
    it('processes all records in batches', async () =>
    {
        const sizes = [];
        await User.chunk(5, batch => sizes.push(batch.length));
        expect(sizes).toEqual([5, 5, 5]);
    });

    it('chunk with conditions', async () =>
    {
        const sizes = [];
        await User.chunk(3, batch => sizes.push(batch.length), { role: 'admin' });
        expect(sizes).toEqual([3, 2]);
    });
});

describe('Model.random()', () =>
{
    it('returns a random record', async () =>
    {
        const user = await User.random();
        expect(user).not.toBeNull();
        expect(user.id).toBeGreaterThanOrEqual(1);
        expect(user.id).toBeLessThanOrEqual(15);
    });

    it('returns null when no matches', async () =>
    {
        const user = await User.random({ name: 'Ghost' });
        expect(user).toBeNull();
    });

    it('respects conditions', async () =>
    {
        const admin = await User.random({ role: 'admin' });
        expect(admin.role).toBe('admin');
    });
});

describe('Model.pluck()', () =>
{
    it('plucks a single column', async () =>
    {
        const names = await User.pluck('name');
        expect(names).toHaveLength(15);
        expect(names).toContain('User1');
        expect(names).toContain('User15');
    });

    it('plucks with conditions', async () =>
    {
        const adminNames = await User.pluck('name', { role: 'admin' });
        expect(adminNames).toHaveLength(5);
    });
});

// -- Combined LINQ chains --------------------------------

describe('LINQ chain combinations', () =>
{
    it('scope + when + paginate', async () =>
    {
        const showAdmins = true;
        const result = await User.query()
            .when(showAdmins, q => q.scope('admins'))
            .paginate(1, 2);
        expect(result.total).toBe(5);
        expect(result.data).toHaveLength(2);
    });

    it('orderByDesc + take + map', async () =>
    {
        const topScores = await User.query()
            .orderByDesc('score')
            .take(3)
            .map(u => u.score);
        expect(topScores).toEqual([150, 140, 130]);
    });

    it('filter + reduce for complex aggregation', async () =>
    {
        const avgAdminScore = await User.query()
            .filter(u => u.role === 'admin')
            .then(admins =>
            {
                const sum = admins.reduce((s, u) => s + u.score, 0);
                return sum / admins.length;
            });
        expect(avgAdminScore).toBe(30); // (10+20+30+40+50)/5
    });

    it('tap + when + unless full pipeline', async () =>
    {
        const debugLog = [];
        const isAdmin = false;
        const minAge = 20;

        const users = await User.query()
            .tap(q => debugLog.push('start'))
            .when(isAdmin, q => q.where('role', 'admin'))
            .unless(isAdmin, q => q.where('role', 'user'))
            .when(minAge, q => q.where('age', '>=', minAge))
            .tap(q => debugLog.push(`filters: ${q.build().where.length}`))
            .orderBy('name');

        expect(debugLog).toEqual(['start', 'filters: 2']);
        expect(users.every(u => u.role === 'user')).toBe(true);
        expect(users.every(u => u.age >= minAge)).toBe(true);
    });
});
