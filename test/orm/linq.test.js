/** linq.test.js — LINQ-inspired query builder and Model shortcuts */
const { Database, Model, TYPES } = require('../../lib/orm');

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

// -- New LINQ C# Parity Methods -------------------------

describe('Query: orderByDescending()', () =>
{
    it('is an alias for orderByDesc', async () =>
    {
        const users = await User.query().orderByDescending('score').take(3);
        expect(users[0].score).toBe(150);
        expect(users[2].score).toBe(130);
    });
});

describe('Query: firstOrDefault()', () =>
{
    it('returns the first record', async () =>
    {
        const user = await User.query().firstOrDefault();
        expect(user).not.toBeNull();
    });

    it('returns null when no results', async () =>
    {
        const user = await User.query().where('name', 'Ghost').firstOrDefault();
        expect(user).toBeNull();
    });
});

describe('Query: lastOrDefault()', () =>
{
    it('returns the last record', async () =>
    {
        const user = await User.query().lastOrDefault();
        expect(user.id).toBe(15);
    });

    it('returns null when no results', async () =>
    {
        const user = await User.query().where('name', 'Ghost').lastOrDefault();
        expect(user).toBeNull();
    });
});

describe('Query: average()', () =>
{
    it('is an alias for avg()', async () =>
    {
        const avgAge = await User.query().average('age');
        // ages 16-30, avg = (16+17+...+30)/15 = 345/15 = 23
        expect(avgAge).toBe(23);
    });
});

describe('Query: aggregate()', () =>
{
    it('is an alias for reduce()', async () =>
    {
        const total = await User.query()
            .where('role', 'admin')
            .aggregate((sum, u) => sum + u.score, 0);
        expect(total).toBe(150);
    });
});

describe('Query: single()', () =>
{
    it('returns the only matching element', async () =>
    {
        const user = await User.query().where('name', 'User1').single();
        expect(user.name).toBe('User1');
    });

    it('throws when no elements match', async () =>
    {
        await expect(
            User.query().where('name', 'Ghost').single()
        ).rejects.toThrow('Sequence contains no elements');
    });

    it('throws when more than one element matches', async () =>
    {
        await expect(
            User.query().where('role', 'admin').single()
        ).rejects.toThrow('Sequence contains more than one element');
    });
});

describe('Query: singleOrDefault()', () =>
{
    it('returns the only element', async () =>
    {
        const user = await User.query().where('name', 'User1').singleOrDefault();
        expect(user.name).toBe('User1');
    });

    it('returns null when empty', async () =>
    {
        const user = await User.query().where('name', 'Ghost').singleOrDefault();
        expect(user).toBeNull();
    });

    it('throws when more than one element', async () =>
    {
        await expect(
            User.query().where('role', 'admin').singleOrDefault()
        ).rejects.toThrow('Sequence contains more than one element');
    });
});

describe('Query: elementAt()', () =>
{
    it('returns element at index', async () =>
    {
        const user = await User.query().orderBy('id').elementAt(4);
        expect(user.id).toBe(5);
    });

    it('throws on out-of-range index', async () =>
    {
        await expect(
            User.query().elementAt(100)
        ).rejects.toThrow('Index out of range');
    });
});

describe('Query: elementAtOrDefault()', () =>
{
    it('returns element at index', async () =>
    {
        const user = await User.query().orderBy('id').elementAtOrDefault(0);
        expect(user.id).toBe(1);
    });

    it('returns null for out-of-range index', async () =>
    {
        const user = await User.query().elementAtOrDefault(100);
        expect(user).toBeNull();
    });
});

describe('Query: defaultIfEmpty()', () =>
{
    it('returns results when not empty', async () =>
    {
        const results = await User.query().where('role', 'admin').defaultIfEmpty({ name: 'N/A' });
        expect(results).toHaveLength(5);
        expect(results[0].name).not.toBe('N/A');
    });

    it('returns [defaultValue] when empty', async () =>
    {
        const results = await User.query().where('name', 'Ghost').defaultIfEmpty({ name: 'N/A' });
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('N/A');
    });
});

describe('Query: any()', () =>
{
    it('returns true when records exist (no predicate)', async () =>
    {
        const result = await User.query().where('role', 'admin').any();
        expect(result).toBe(true);
    });

    it('returns false when no records exist (no predicate)', async () =>
    {
        const result = await User.query().where('name', 'Ghost').any();
        expect(result).toBe(false);
    });

    it('returns true when predicate matches', async () =>
    {
        const result = await User.query().any(u => u.age > 25);
        expect(result).toBe(true);
    });

    it('returns false when predicate matches none', async () =>
    {
        const result = await User.query().any(u => u.age > 100);
        expect(result).toBe(false);
    });
});

describe('Query: all()', () =>
{
    it('returns true when all match', async () =>
    {
        const result = await User.query().where('role', 'admin').all(u => u.id <= 5);
        expect(result).toBe(true);
    });

    it('returns false when some do not match', async () =>
    {
        const result = await User.query().all(u => u.role === 'admin');
        expect(result).toBe(false);
    });

    it('returns false on empty results', async () =>
    {
        const result = await User.query().where('name', 'Ghost').all(u => true);
        expect(result).toBe(false);
    });
});

describe('Query: contains()', () =>
{
    it('returns true when value exists', async () =>
    {
        const result = await User.query().contains('name', 'User1');
        expect(result).toBe(true);
    });

    it('returns false when value does not exist', async () =>
    {
        const result = await User.query().contains('name', 'Ghost');
        expect(result).toBe(false);
    });
});

describe('Query: sequenceEqual()', () =>
{
    it('returns true for identical sequences', async () =>
    {
        const q1 = User.query().where('role', 'admin').orderBy('id');
        const q2 = User.query().where('role', 'admin').orderBy('id');
        const result = await q1.sequenceEqual(q2);
        expect(result).toBe(true);
    });

    it('returns false for different sequences', async () =>
    {
        const q1 = User.query().where('role', 'admin').orderBy('id');
        const q2 = User.query().where('role', 'user').orderBy('id');
        const result = await q1.sequenceEqual(q2);
        expect(result).toBe(false);
    });

    it('accepts arrays for comparison', async () =>
    {
        const admins = await User.query().where('role', 'admin').orderBy('id').exec();
        const result = await User.query().where('role', 'admin').orderBy('id').sequenceEqual(admins);
        expect(result).toBe(true);
    });

    it('returns false for different lengths', async () =>
    {
        const q1 = User.query().where('role', 'admin');
        const result = await q1.sequenceEqual([]);
        expect(result).toBe(false);
    });
});

describe('Query: thenBy() / thenByDescending()', () =>
{
    it('thenBy adds secondary ascending sort', async () =>
    {
        const users = await User.query().orderBy('role').thenBy('name').toArray();
        // admins first (sorted by name), then users (sorted by name)
        const admins = users.filter(u => u.role === 'admin');
        expect(admins[0].name).toBe('User1');
        expect(admins[4].name).toBe('User5');
    });

    it('thenByDescending adds secondary descending sort', async () =>
    {
        const users = await User.query().orderBy('role').thenByDescending('id').toArray();
        const admins = users.filter(u => u.role === 'admin');
        expect(admins[0].id).toBe(5);
        expect(admins[4].id).toBe(1);
    });
});

describe('Query: concat()', () =>
{
    it('concatenates two query results', async () =>
    {
        const admins = User.query().where('role', 'admin');
        const regularUsers = User.query().where('role', 'user');
        const all = await admins.concat(regularUsers);
        expect(all).toHaveLength(15);
    });

    it('concatenates with an array', async () =>
    {
        const users = await User.query().take(2).concat([{ id: 99, name: 'Extra' }]);
        expect(users).toHaveLength(3);
        expect(users[2].name).toBe('Extra');
    });
});

describe('Query: union()', () =>
{
    it('returns distinct union of two queries', async () =>
    {
        const q1 = User.query().where('role', 'admin');
        const q2 = User.query().take(3);
        // q1 = users 1-5(admin), q2 = first 3 users → union should be 5 unique
        const result = await q1.union(q2, u => u.id);
        expect(result).toHaveLength(5);
    });

    it('union with array', async () =>
    {
        const result = await User.query().take(2).union(
            [{ id: 1 }, { id: 99 }],
            u => u.id
        );
        // first 2 users (id 1,2) + external id 1 (dup) + id 99 (new) = 3
        expect(result).toHaveLength(3);
    });
});

describe('Query: intersect()', () =>
{
    it('returns common elements from two queries', async () =>
    {
        const q1 = User.query().where('role', 'admin');
        const q2 = User.query().take(3).orderBy('id');
        const result = await q1.intersect(q2, u => u.id);
        // admin = ids 1-5, take(3) = ids 1-3 → intersection = 3
        expect(result).toHaveLength(3);
    });

    it('returns empty when no overlap', async () =>
    {
        const q1 = User.query().where('role', 'admin');
        const result = await q1.intersect(
            [{ id: 99 }, { id: 100 }],
            u => u.id
        );
        expect(result).toHaveLength(0);
    });
});

describe('Query: except()', () =>
{
    it('returns elements not in other', async () =>
    {
        const q1 = User.query().where('role', 'admin');
        const q2 = User.query().take(3).orderBy('id');
        const result = await q1.except(q2, u => u.id);
        // admin = ids 1-5, take(3) = ids 1-3 → except = ids 4,5
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe(4);
    });

    it('returns all when no overlap', async () =>
    {
        const result = await User.query().where('role', 'admin').except(
            [{ id: 99 }],
            u => u.id
        );
        expect(result).toHaveLength(5);
    });
});

describe('Query: selectMany()', () =>
{
    it('flattens projected arrays', async () =>
    {
        const result = await User.query().take(3).orderBy('id')
            .selectMany(u => [u.name, u.role]);
        // 3 users × 2 items each = 6
        expect(result).toHaveLength(6);
        expect(result[0]).toBe('User1');
        expect(result[1]).toBe('admin');
    });

    it('handles empty projections', async () =>
    {
        const result = await User.query().take(2)
            .selectMany(() => []);
        expect(result).toHaveLength(0);
    });
});

describe('Query: zip()', () =>
{
    it('combines two sequences element-wise', async () =>
    {
        const q1 = User.query().where('role', 'admin').orderBy('id');
        const q2 = User.query().where('role', 'user').orderBy('id');
        const result = await q1.zip(q2, (a, b) => ({
            admin: a.name,
            user: b.name,
        }));
        // min(5 admins, 10 users) = 5
        expect(result).toHaveLength(5);
        expect(result[0].admin).toBe('User1');
        expect(result[0].user).toBe('User6');
    });

    it('zip with array', async () =>
    {
        const labels = ['Gold', 'Silver', 'Bronze'];
        const result = await User.query().orderByDesc('score').take(3)
            .zip(labels, (user, label) => `${label}: ${user.name}`);
        expect(result).toHaveLength(3);
        expect(result[0]).toBe('Gold: User15');
    });
});

describe('Query: toDictionary()', () =>
{
    it('converts results to a Map', async () =>
    {
        const map = await User.query().take(3).orderBy('id')
            .toDictionary(u => u.id);
        expect(map).toBeInstanceOf(Map);
        expect(map.size).toBe(3);
        expect(map.get(1).name).toBe('User1');
    });

    it('supports value selector', async () =>
    {
        const map = await User.query().take(3).orderBy('id')
            .toDictionary(u => u.id, u => u.name);
        expect(map.get(1)).toBe('User1');
    });

    it('throws on duplicate keys', async () =>
    {
        await expect(
            User.query().toDictionary(u => u.role)
        ).rejects.toThrow('Duplicate key');
    });
});

describe('Query: toLookup()', () =>
{
    it('groups results into a Map of arrays', async () =>
    {
        const map = await User.query().toLookup(u => u.role);
        expect(map).toBeInstanceOf(Map);
        expect(map.get('admin')).toHaveLength(5);
        expect(map.get('user')).toHaveLength(10);
    });

    it('handles single-element groups', async () =>
    {
        const map = await User.query().toLookup(u => u.id);
        expect(map.size).toBe(15);
        map.forEach(group => expect(group).toHaveLength(1));
    });
});

describe('Query: takeWhile()', () =>
{
    it('takes while predicate is true', async () =>
    {
        const result = await User.query().orderBy('age').takeWhile(u => u.age < 20);
        // ages: 16,17,18,19 → 4 users
        expect(result).toHaveLength(4);
        expect(result[3].age).toBe(19);
    });

    it('returns empty if first element fails', async () =>
    {
        const result = await User.query().orderByDesc('age').takeWhile(u => u.age < 16);
        expect(result).toHaveLength(0);
    });

    it('returns all if predicate always true', async () =>
    {
        const result = await User.query().takeWhile(u => u.id > 0);
        expect(result).toHaveLength(15);
    });
});

describe('Query: skipWhile()', () =>
{
    it('skips while predicate is true', async () =>
    {
        const result = await User.query().orderBy('age').skipWhile(u => u.age < 20);
        // skip ages 16,17,18,19 → remaining 11 users (ages 20-30)
        expect(result).toHaveLength(11);
        expect(result[0].age).toBe(20);
    });

    it('returns all if first element fails predicate', async () =>
    {
        const result = await User.query().orderBy('age').skipWhile(u => u.age > 100);
        expect(result).toHaveLength(15);
    });

    it('returns empty if predicate always true', async () =>
    {
        const result = await User.query().skipWhile(u => u.id > 0);
        expect(result).toHaveLength(0);
    });
});

describe('Query: reverse()', () =>
{
    it('reverses the result order', async () =>
    {
        const result = await User.query().orderBy('id').take(5).reverse();
        expect(result[0].id).toBe(5);
        expect(result[4].id).toBe(1);
    });
});

describe('Query: append()', () =>
{
    it('appends items to the end', async () =>
    {
        const result = await User.query().take(2).append({ id: 99, name: 'Extra' });
        expect(result).toHaveLength(3);
        expect(result[2].name).toBe('Extra');
    });

    it('appends multiple items', async () =>
    {
        const result = await User.query().take(1).append(
            { id: 98, name: 'A' },
            { id: 99, name: 'B' }
        );
        expect(result).toHaveLength(3);
    });
});

describe('Query: prepend()', () =>
{
    it('prepends items to the beginning', async () =>
    {
        const result = await User.query().take(2).prepend({ id: 0, name: 'First' });
        expect(result).toHaveLength(3);
        expect(result[0].name).toBe('First');
    });

    it('prepends multiple items', async () =>
    {
        const result = await User.query().take(1).prepend(
            { id: -1, name: 'A' },
            { id: 0, name: 'B' }
        );
        expect(result).toHaveLength(3);
        expect(result[0].name).toBe('A');
    });
});

describe('Query: distinctBy()', () =>
{
    it('returns distinct elements by key', async () =>
    {
        const result = await User.query().distinctBy(u => u.role);
        expect(result).toHaveLength(2);
        const roles = result.map(u => u.role).sort();
        expect(roles).toEqual(['admin', 'user']);
    });

    it('preserves first occurrence', async () =>
    {
        const result = await User.query().orderBy('id').distinctBy(u => u.role);
        expect(result[0].id).toBe(1); // first admin
    });
});

describe('Query: minBy()', () =>
{
    it('returns element with minimum value', async () =>
    {
        const user = await User.query().minBy(u => u.age);
        expect(user.age).toBe(16);
    });

    it('returns null on empty results', async () =>
    {
        const user = await User.query().where('name', 'Ghost').minBy(u => u.age);
        expect(user).toBeNull();
    });
});

describe('Query: maxBy()', () =>
{
    it('returns element with maximum value', async () =>
    {
        const user = await User.query().maxBy(u => u.score);
        expect(user.score).toBe(150);
        expect(user.name).toBe('User15');
    });

    it('returns null on empty results', async () =>
    {
        const user = await User.query().where('name', 'Ghost').maxBy(u => u.score);
        expect(user).toBeNull();
    });
});

describe('Query: sumBy()', () =>
{
    it('sums using a selector', async () =>
    {
        const total = await User.query().where('role', 'admin').sumBy(u => u.score);
        expect(total).toBe(150); // 10+20+30+40+50
    });

    it('returns 0 for empty results', async () =>
    {
        const total = await User.query().where('name', 'Ghost').sumBy(u => u.score);
        expect(total).toBe(0);
    });
});

describe('Query: averageBy()', () =>
{
    it('averages using a selector', async () =>
    {
        const avg = await User.query().where('role', 'admin').averageBy(u => u.score);
        expect(avg).toBe(30); // 150/5
    });

    it('returns 0 for empty results', async () =>
    {
        const avg = await User.query().where('name', 'Ghost').averageBy(u => u.score);
        expect(avg).toBe(0);
    });
});

describe('Query: countBy()', () =>
{
    it('counts elements per group', async () =>
    {
        const counts = await User.query().countBy(u => u.role);
        expect(counts).toBeInstanceOf(Map);
        expect(counts.get('admin')).toBe(5);
        expect(counts.get('user')).toBe(10);
    });

    it('handles single group', async () =>
    {
        const counts = await User.query().where('role', 'admin').countBy(u => u.role);
        expect(counts.size).toBe(1);
        expect(counts.get('admin')).toBe(5);
    });
});



// =========================================================================
//  query — deep branch coverage (from coverage/deep.test.js)
// =========================================================================

describe('query — deep branch coverage', () => {
	let Model, db;
	const tableName = 'query_deep_' + Date.now();

	beforeAll(async () => {
		const orm = require('../../');
		db = orm.Database.connect('memory');

		class QModel extends orm.Model {
			static table = tableName;
			static schema = {
				id: { type: orm.TYPES.INTEGER, primaryKey: true, autoIncrement: true },
				name: { type: orm.TYPES.STRING },
				age: { type: orm.TYPES.INTEGER },
				category: { type: orm.TYPES.STRING },
				active: { type: orm.TYPES.BOOLEAN },
			};
			static timestamps = true;
			static softDelete = true;
		}

		db.register(QModel);
		await db.sync();
		Model = QModel;

		// Seed data
		await Model.createMany([
			{ name: 'Alice', age: 30, category: 'A', active: true },
			{ name: 'Bob', age: 25, category: 'B', active: true },
			{ name: 'Charlie', age: 35, category: 'A', active: false },
			{ name: 'Diana', age: 28, category: 'C', active: true },
			{ name: 'Eve', age: 22, category: 'B', active: true },
		]);
	});

	it('where with object conditions', async () => {
		const results = await Model.query().where({ category: 'A' }).exec();
		expect(results.length).toBe(2);
	});

	it('orWhere builds OR conditions', async () => {
		const results = await Model.query().where('category', 'A').orWhere('category', 'B').exec();
		expect(results.length).toBe(4);
	});

	it('whereNull and whereNotNull', async () => {
		const notNull = await Model.query().whereNotNull('name').exec();
		expect(notNull.length).toBe(5);
	});

	it('whereIn and whereNotIn', async () => {
		const inResults = await Model.query().whereIn('category', ['A', 'B']).exec();
		expect(inResults.length).toBe(4);

		const notIn = await Model.query().whereNotIn('category', ['A']).exec();
		expect(notIn.length).toBe(3);
	});

	it('whereBetween and whereNotBetween', async () => {
		const between = await Model.query().whereBetween('age', 25, 30).exec();
		expect(between.length).toBe(3);

		const notBetween = await Model.query().whereNotBetween('age', 25, 30).exec();
		expect(notBetween.length).toBe(2);
	});

	it('whereLike for pattern matching', async () => {
		const results = await Model.query().whereLike('name', 'Al%').exec();
		expect(results.length).toBe(1);
		expect(results[0].name).toBe('Alice');
	});

	it('orderBy ascending and descending', async () => {
		const asc = await Model.query().orderBy('age', 'asc').exec();
		expect(asc[0].name).toBe('Eve');

		const desc = await Model.query().orderBy('age', 'desc').exec();
		expect(desc[0].name).toBe('Charlie');
	});

	it('limit and offset', async () => {
		const limited = await Model.query().orderBy('age').limit(2).exec();
		expect(limited.length).toBe(2);

		const offsetted = await Model.query().orderBy('age').limit(2).offset(2).exec();
		expect(offsetted.length).toBe(2);
	});

	it('page shorthand', async () => {
		const page1 = await Model.query().orderBy('age').page(1, 2).exec();
		expect(page1.length).toBe(2);
	});

	it('groupBy', async () => {
		const grouped = await Model.query().groupBy('category').exec();
		expect(grouped.length).toBeGreaterThanOrEqual(3);
	});

	it('distinct', async () => {
		const distinct = await Model.query().select('category').distinct().exec();
		const cats = distinct.map(d => d.category);
		expect(new Set(cats).size).toBe(cats.length);
	});

	it('count', async () => {
		const c = await Model.query().count();
		expect(c).toBe(5);
	});

	it('exists', async () => {
		expect(await Model.query().where('name', 'Alice').exists()).toBe(true);
		expect(await Model.query().where('name', 'ZZZ').exists()).toBe(false);
	});

	it('pluck', async () => {
		const names = await Model.query().orderBy('name').pluck('name');
		expect(names[0]).toBe('Alice');
	});

	it('sum, avg, min, max', async () => {
		const total = await Model.query().sum('age');
		expect(total).toBe(140);

		const average = await Model.query().avg('age');
		expect(average).toBe(28);

		const youngest = await Model.query().min('age');
		expect(youngest).toBe(22);

		const oldest = await Model.query().max('age');
		expect(oldest).toBe(35);
	});

	it('first and last', async () => {
		const first = await Model.query().orderBy('age').first();
		expect(first.name).toBe('Eve');

		const last = await Model.query().orderBy('age').last();
		expect(last.name).toBe('Charlie');
	});

	it('withDeleted includes soft-deleted records', async () => {
		const item = await Model.query().where('name', 'Charlie').first();
		await item.delete();

		const without = await Model.query().exec();
		const withDel = await Model.query().withDeleted().exec();
		expect(withDel.length).toBeGreaterThanOrEqual(without.length);

		// restore
		await item.restore();
	});

	it('select specific fields', async () => {
		const results = await Model.query().select('name', 'age').exec();
		expect(results[0].name).toBeDefined();
	});

	it('when applies conditionally', async () => {
		const results = await Model.query()
			.when(true, q => q.where('active', true))
			.exec();
		expect(results.every(r => r.active === true)).toBe(true);
	});

	it('unless applies on falsy', async () => {
		const results = await Model.query()
			.unless(false, q => q.where('active', true))
			.exec();
		expect(results.every(r => r.active === true)).toBe(true);
	});

	it('tap for debugging', async () => {
		let tapped = false;
		await Model.query().tap(q => { tapped = true; }).exec();
		expect(tapped).toBe(true);
	});

	it('chunk processes in batches', async () => {
		const batches = [];
		await Model.query().orderBy('id').chunk(2, (batch, idx) => {
			batches.push({ size: batch.length, idx });
		});
		expect(batches.length).toBeGreaterThanOrEqual(2);
		expect(batches[0].size).toBe(2);
	});

	it('each iterates all results', async () => {
		const items = [];
		await Model.query().each((item) => { items.push(item.name); });
		expect(items.length).toBe(5);
	});

	it('map transforms results', async () => {
		const names = await Model.query().map(item => item.name);
		expect(names.length).toBe(5);
		expect(typeof names[0]).toBe('string');
	});

	it('filter filters results', async () => {
		const old = await Model.query().filter(item => item.age > 28);
		expect(old.every(r => r.age > 28)).toBe(true);
	});

	it('reduce aggregates results', async () => {
		const totalAge = await Model.query().reduce((sum, item) => sum + item.age, 0);
		expect(totalAge).toBe(140);
	});

	it('paginate returns metadata', async () => {
		const result = await Model.query().paginate(1, 2);
		expect(result.data.length).toBe(2);
		expect(result.total).toBe(5);
		expect(result.page).toBe(1);
		expect(result.perPage).toBe(2);
		expect(result.pages).toBe(3);
		expect(result.hasNext).toBe(true);
		expect(result.hasPrev).toBe(false);
	});

	it('paginate last page', async () => {
		const result = await Model.query().paginate(3, 2);
		expect(result.data.length).toBe(1);
		expect(result.hasNext).toBe(false);
		expect(result.hasPrev).toBe(true);
	});

	it('thenable/await support', async () => {
		const results = await Model.query().where('active', true);
		expect(Array.isArray(results)).toBe(true);
	});

	it('LINQ: take/skip aliases', async () => {
		const taken = await Model.query().orderBy('age').take(2).toArray();
		expect(taken.length).toBe(2);

		const skipped = await Model.query().orderBy('age').skip(3).toArray();
		expect(skipped.length).toBe(2);
	});

	it('LINQ: orderByDesc', async () => {
		const results = await Model.query().orderByDesc('age').toArray();
		expect(results[0].age).toBe(35);
	});

	it('LINQ: aggregate (reduce alias), average', async () => {
		const sum = await Model.query().aggregate((total, item) => total + item.age, 0);
		expect(sum).toBe(140);

		const avg = await Model.query().average('age');
		expect(avg).toBe(28);
	});

	it('LINQ: any/all/contains', async () => {
		const hasAlice = await Model.query().any(r => r.name === 'Alice');
		expect(hasAlice).toBe(true);

		const allActive = await Model.query().all(r => r.active === true);
		expect(allActive).toBe(false);
	});

	it('LINQ: defaultIfEmpty', async () => {
		const empty = await Model.query().where('name', 'NONEXISTENT').defaultIfEmpty({ name: 'default' });
		expect(empty.length).toBe(1);
		expect(empty[0].name).toBe('default');
	});

	it('LINQ: distinctBy', async () => {
		const distinct = await Model.query().distinctBy(r => r.category);
		expect(distinct.length).toBe(3);
	});

	it('LINQ: minBy/maxBy', async () => {
		const youngest = await Model.query().minBy(r => r.age);
		expect(youngest.name).toBe('Eve');

		const oldest = await Model.query().maxBy(r => r.age);
		expect(oldest.name).toBe('Charlie');
	});

	it('LINQ: sumBy/averageBy/countBy', async () => {
		const sum = await Model.query().sumBy(r => r.age);
		expect(sum).toBe(140);

		const avg = await Model.query().averageBy(r => r.age);
		expect(avg).toBe(28);

		const counts = await Model.query().countBy(r => r.category);
		// countBy returns a Map
		expect(counts.get('A')).toBe(2);
		expect(counts.get('B')).toBe(2);
		expect(counts.get('C')).toBe(1);
	});

	it('LINQ: reverse', async () => {
		const rev = await Model.query().orderBy('age').reverse();
		expect(rev[0].age).toBe(35);
	});

	it('LINQ: append/prepend', async () => {
		const appended = await Model.query().where('name', 'Alice').append({ name: 'Extra' });
		expect(appended[appended.length - 1].name).toBe('Extra');

		const prepended = await Model.query().where('name', 'Alice').prepend({ name: 'First' });
		expect(prepended[0].name).toBe('First');
	});

	it('LINQ: toDictionary/toLookup', async () => {
		const dict = await Model.query().toDictionary(r => r.name);
		// toDictionary returns a Map
		expect(dict.get('Alice')).toBeDefined();
		expect(dict.get('Bob')).toBeDefined();

		const lookup = await Model.query().toLookup(r => r.category);
		// toLookup returns a Map
		expect(lookup.get('A').length).toBe(2);
	});

	it('LINQ: takeWhile/skipWhile', async () => {
		const taken = await Model.query().orderBy('age').takeWhile(r => r.age < 30);
		expect(taken.every(r => r.age < 30)).toBe(true);

		const skipped = await Model.query().orderBy('age').skipWhile(r => r.age < 28);
		expect(skipped[0].age).toBeGreaterThanOrEqual(28);
	});
});

// =========================================================================
//  ORM Query — coverage gaps (from coverage/gaps.test.js)
// =========================================================================

// ============================================================
//  18. ORM QUERY BUILDER — ADVANCED OPERATIONS
// ============================================================
describe('ORM Query — orWhere, whereNull, whereNotNull, whereNotIn, whereNotBetween', () => {
	const { Database, Model, TYPES } = require('../../lib/orm');
	let db;

	class QUser extends Model {
		static table = 'qusers';
		static schema = {
			id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			name:  { type: TYPES.STRING },
			age:   { type: TYPES.INTEGER },
			email: { type: TYPES.STRING },
			role:  { type: TYPES.STRING },
		};
	}

	beforeAll(async () => {
		db = Database.connect('memory');
		db.register(QUser);
		await db.sync();

		await QUser.create({ name: 'Alice', age: 30, email: 'alice@a.com', role: 'admin' });
		await QUser.create({ name: 'Bob', age: 25, email: 'bob@b.com', role: 'user' });
		await QUser.create({ name: 'Charlie', age: 35, email: null, role: 'admin' });
		await QUser.create({ name: 'Diana', age: 20, email: 'diana@d.com', role: 'user' });
		await QUser.create({ name: 'Eve', age: 40, email: 'eve@e.com', role: 'mod' });
	});

	afterAll(() => { QUser._adapter = null; });

	it('orWhere combines conditions with OR', async () => {
		const results = await QUser.query()
			.where('role', 'admin')
			.orWhere('role', 'mod')
			.exec();
		const names = results.map(r => r.name).sort();
		expect(names).toContain('Alice');
		expect(names).toContain('Charlie');
		expect(names).toContain('Eve');
	});

	it('whereNull finds null values', async () => {
		const results = await QUser.query().whereNull('email').exec();
		expect(results.length).toBe(1);
		expect(results[0].name).toBe('Charlie');
	});

	it('whereNotNull excludes null values', async () => {
		const results = await QUser.query().whereNotNull('email').exec();
		expect(results.length).toBe(4);
		expect(results.every(r => r.email != null)).toBe(true);
	});

	it('whereNotIn excludes listed values', async () => {
		const results = await QUser.query().whereNotIn('role', ['admin', 'mod']).exec();
		expect(results.every(r => r.role === 'user')).toBe(true);
		expect(results.length).toBe(2);
	});

	it('whereNotBetween excludes range', async () => {
		const results = await QUser.query().whereNotBetween('age', 25, 35).exec();
		const ages = results.map(r => r.age);
		expect(ages).toContain(20);
		expect(ages).toContain(40);
		expect(ages).not.toContain(25);
		expect(ages).not.toContain(30);
		expect(ages).not.toContain(35);
	});

	it('whereLike filters with pattern matching', async () => {
		const results = await QUser.query().whereLike('name', '%li%').exec();
		const names = results.map(r => r.name);
		expect(names).toContain('Alice');
		expect(names).toContain('Charlie');
	});
});

describe('ORM Query — distinct, pluck, aggregates', () => {
	const { Database, Model, TYPES } = require('../../lib/orm');
	let db;

	class Sale extends Model {
		static table = 'sales';
		static schema = {
			id:      { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			product: { type: TYPES.STRING },
			amount:  { type: TYPES.INTEGER },
			region:  { type: TYPES.STRING },
		};
	}

	beforeAll(async () => {
		db = Database.connect('memory');
		db.register(Sale);
		await db.sync();

		await Sale.create({ product: 'Widget', amount: 100, region: 'East' });
		await Sale.create({ product: 'Widget', amount: 150, region: 'West' });
		await Sale.create({ product: 'Gadget', amount: 200, region: 'East' });
		await Sale.create({ product: 'Gadget', amount: 50, region: 'West' });
		await Sale.create({ product: 'Widget', amount: 75, region: 'East' });
	});

	afterAll(() => { Sale._adapter = null; });

	it('pluck returns array of single field values', async () => {
		const products = await Sale.query().pluck('product');
		expect(products).toContain('Widget');
		expect(products).toContain('Gadget');
	});

	it('sum computes total', async () => {
		const total = await Sale.query().sum('amount');
		expect(total).toBe(575);
	});

	it('avg computes average', async () => {
		const average = await Sale.query().avg('amount');
		expect(average).toBe(115);
	});

	it('min finds minimum', async () => {
		const minimum = await Sale.query().min('amount');
		expect(minimum).toBe(50);
	});

	it('max finds maximum', async () => {
		const maximum = await Sale.query().max('amount');
		expect(maximum).toBe(200);
	});

	it('exists returns true when records exist', async () => {
		const ex = await Sale.query().where('product', 'Widget').exists();
		expect(ex).toBe(true);
	});

	it('exists returns false when no records match', async () => {
		const ex = await Sale.query().where('product', 'Nothing').exists();
		expect(ex).toBe(false);
	});

	it('count returns correct number', async () => {
		const c = await Sale.query().where('region', 'East').count();
		expect(c).toBe(3);
	});
});

describe('ORM Query — scopes', () => {
	const { Database, Model, TYPES } = require('../../lib/orm');
	let db;

	class ScopedItem extends Model {
		static table = 'scoped_items';
		static schema = {
			id:     { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			name:   { type: TYPES.STRING },
			price:  { type: TYPES.INTEGER },
			active: { type: TYPES.BOOLEAN, default: true },
		};
		static scopes = {
			active: (q) => q.where('active', true),
			expensive: (q, minPrice) => q.where('price', '>=', minPrice),
		};
	}

	beforeAll(async () => {
		db = Database.connect('memory');
		db.register(ScopedItem);
		await db.sync();

		await ScopedItem.create({ name: 'Cheap', price: 10, active: true });
		await ScopedItem.create({ name: 'Mid', price: 50, active: true });
		await ScopedItem.create({ name: 'Pricey', price: 100, active: false });
		await ScopedItem.create({ name: 'Premium', price: 200, active: true });
	});

	afterAll(() => { ScopedItem._adapter = null; });

	it('named scope filters results', async () => {
		const results = await ScopedItem.query().scope('active').exec();
		expect(results.every(r => r.active === true)).toBe(true);
	});

	it('scope with arguments works', async () => {
		const results = await ScopedItem.query().scope('expensive', 50).exec();
		expect(results.every(r => r.price >= 50)).toBe(true);
	});

	it('chaining multiple scopes works', async () => {
		const results = await ScopedItem.query().scope('active').scope('expensive', 100).exec();
		expect(results.length).toBe(1);
		expect(results[0].name).toBe('Premium');
	});

	it('unknown scope throws', () => {
		expect(() => ScopedItem.query().scope('nonexistent')).toThrow(/unknown scope/i);
	});
});

describe('ORM Query — eager loading (with/include)', () => {
	const { Database, Model, TYPES } = require('../../lib/orm');
	let db;

	class Author extends Model {
		static table = 'authors';
		static schema = {
			id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			name: { type: TYPES.STRING },
		};
	}

	class EagerPost extends Model {
		static table = 'eager_posts';
		static schema = {
			id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			title:    { type: TYPES.STRING },
			authorId: { type: TYPES.INTEGER },
		};
	}

	beforeAll(async () => {
		db = Database.connect('memory');
		Author.hasMany(EagerPost, 'authorId');
		EagerPost.belongsTo(Author, 'authorId');
		db.registerAll(Author, EagerPost);
		await db.sync();

		const a1 = await Author.create({ name: 'Writer A' });
		const a2 = await Author.create({ name: 'Writer B' });
		await EagerPost.create({ title: 'Post 1', authorId: a1.id });
		await EagerPost.create({ title: 'Post 2', authorId: a1.id });
		await EagerPost.create({ title: 'Post 3', authorId: a2.id });
	});

	afterAll(() => { Author._adapter = null; EagerPost._adapter = null; });

	it('with() eager-loads hasMany', async () => {
		const authors = await Author.query().with('EagerPost').exec();
		const writerA = authors.find(a => a.name === 'Writer A');
		expect(writerA.EagerPost).toBeDefined();
		expect(writerA.EagerPost.length).toBe(2);
		const writerB = authors.find(a => a.name === 'Writer B');
		expect(writerB.EagerPost.length).toBe(1);
	});

	it('with() eager-loads belongsTo', async () => {
		const posts = await EagerPost.query().with('Author').exec();
		expect(posts.length).toBe(3);
		const post1 = posts.find(p => p.title === 'Post 1');
		expect(post1.Author).toBeDefined();
		expect(post1.Author.name).toBe('Writer A');
	});

	it('include() is alias for with()', async () => {
		const authors = await Author.query().include('EagerPost').exec();
		expect(authors[0].EagerPost).toBeDefined();
	});
});

describe('ORM Query — hasOne relationship', () => {
	const { Database, Model, TYPES } = require('../../lib/orm');
	let db;

	class SingleUser extends Model {
		static table = 'single_users';
		static schema = {
			id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			name: { type: TYPES.STRING },
		};
	}

	class Profile extends Model {
		static table = 'profiles';
		static schema = {
			id:           { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			bio:          { type: TYPES.STRING },
			single_userId: { type: TYPES.INTEGER },
		};
	}

	beforeAll(async () => {
		db = Database.connect('memory');
		SingleUser.hasOne(Profile, 'single_userId');
		db.registerAll(SingleUser, Profile);
		await db.sync();

		const u = await SingleUser.create({ name: 'Solo' });
		await Profile.create({ bio: 'test bio', single_userId: u.id });
	});

	afterAll(() => { SingleUser._adapter = null; Profile._adapter = null; });

	it('hasOne eager-loads single related record', async () => {
		const users = await SingleUser.query().with('Profile').exec();
		expect(users.length).toBe(1);
		expect(users[0].Profile).toBeDefined();
		expect(users[0].Profile.bio).toBe('test bio');
	});
});

describe('ORM Query — build() method and operator validation', () => {
	const { Database, Model, TYPES } = require('../../lib/orm');

	class BuildModel extends Model {
		static table = 'build_test';
		static schema = {
			id:  { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			val: { type: TYPES.STRING },
		};
	}

	let db;

	beforeAll(async () => {
		db = Database.connect('memory');
		db.register(BuildModel);
		await db.sync();
	});

	afterAll(() => { BuildModel._adapter = null; });

	it('rejects invalid operator', () => {
		expect(() => BuildModel.query().where('val', 'DROP TABLE', 'x')).toThrow(/invalid query operator/i);
	});

	it('rejects invalid orderBy direction', () => {
		expect(() => BuildModel.query().orderBy('val', 'SIDEWAYS')).toThrow(/invalid orderBy direction/i);
	});

	it('build() returns correct descriptor', () => {
		const desc = BuildModel.query()
			.where('val', '>', 5)
			.orderBy('val', 'desc')
			.limit(10)
			.offset(5)
			.build();
		expect(desc.action).toBe('select');
		expect(desc.where[0].op).toBe('>');
		expect(desc.orderBy[0].dir).toBe('DESC');
		expect(desc.limit).toBe(10);
		expect(desc.offset).toBe(5);
	});

	it('where with object shorthand works', async () => {
		await BuildModel.create({ val: 'Test' });
		const results = await BuildModel.query().where({ val: 'Test' }).exec();
		expect(results.length).toBe(1);
	});
});

describe('ORM Query — page helper', () => {
	const { Database, Model, TYPES } = require('../../lib/orm');
	let db;

	class PagedItem extends Model {
		static table = 'paged_items';
		static schema = {
			id:  { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
			num: { type: TYPES.INTEGER },
		};
	}

	beforeAll(async () => {
		db = Database.connect('memory');
		db.register(PagedItem);
		await db.sync();
		for (let i = 1; i <= 50; i++) await PagedItem.create({ num: i });
	});

	afterAll(() => { PagedItem._adapter = null; });

	it('page(1, 10) returns first 10', async () => {
		const results = await PagedItem.query().orderBy('num').page(1, 10).exec();
		expect(results.length).toBe(10);
		expect(results[0].num).toBe(1);
		expect(results[9].num).toBe(10);
	});

	it('page(3, 10) returns 21-30', async () => {
		const results = await PagedItem.query().orderBy('num').page(3, 10).exec();
		expect(results.length).toBe(10);
		expect(results[0].num).toBe(21);
	});
});
