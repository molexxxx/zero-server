/**
 * Tests for the ORM: Database, Model, Schema, Query, Memory adapter.
 */
const { Database, Model, TYPES } = require('../../lib/orm');

// -- Test Models -----------------------------------------

class User extends Model
{
    static table = 'users';
    static schema = {
        id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name:  { type: TYPES.STRING,  required: true, maxLength: 100 },
        email: { type: TYPES.STRING,  required: true },
        age:   { type: TYPES.INTEGER },
        role:  { type: TYPES.STRING,  enum: ['user', 'admin'], default: 'user' },
    };
    static timestamps = true;
}

class Post extends Model
{
    static table = 'posts';
    static schema = {
        id:     { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        title:  { type: TYPES.STRING,  required: true },
        body:   { type: TYPES.TEXT },
        userId: { type: TYPES.INTEGER, required: true },
    };
}

class SoftModel extends Model
{
    static table = 'soft_items';
    static schema = {
        id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: TYPES.STRING, required: true },
    };
    static softDelete = true;
}

// -- Database & Adapter ----------------------------------

let db;

beforeEach(() =>
{
    db = Database.connect('memory');
    db.registerAll(User, Post, SoftModel);
});

afterEach(async () =>
{
    // Clear adapter between tests
    if (db.adapter.clear) db.adapter.clear();
    // Disconnect model refs
    User._adapter = null;
    Post._adapter = null;
    SoftModel._adapter = null;
});

describe('Database', () =>
{
    it('connect() creates a Database instance', () =>
    {
        expect(db).toBeDefined();
        expect(db.adapter).toBeDefined();
    });

    it('throws on unknown adapter type', () =>
    {
        expect(() => Database.connect('oracle')).toThrow(/Unknown adapter/);
    });

    it('register() binds adapter to model', () =>
    {
        expect(User._adapter).toBe(db.adapter);
    });

    it('model() retrieves registered model', () =>
    {
        expect(db.model('users')).toBe(User);
    });

    it('sync() creates tables for all models', async () =>
    {
        await db.sync();
        // Tables should exist — inserting should work
        const user = await User.create({ name: 'Alice', email: 'a@b.com' });
        expect(user.id).toBeDefined();
    });

    it('drop() drops all tables', async () =>
    {
        await db.sync();
        await User.create({ name: 'Alice', email: 'a@b.com' });
        await db.drop();
        // After drop, table is gone — sync and insert again
        await db.sync();
        const users = await User.find();
        expect(users).toHaveLength(0);
    });
});

describe('Model — CRUD', () =>
{
    beforeEach(async () => { await db.sync(); });

    it('create() inserts a record', async () =>
    {
        const user = await User.create({ name: 'Alice', email: 'a@b.com' });
        expect(user.id).toBe(1);
        expect(user.name).toBe('Alice');
        expect(user.role).toBe('user');
    });

    it('create() applies defaults', async () =>
    {
        const user = await User.create({ name: 'Bob', email: 'b@c.com' });
        expect(user.role).toBe('user');
    });

    it('create() adds timestamps when enabled', async () =>
    {
        const user = await User.create({ name: 'Carol', email: 'c@d.com' });
        expect(user.createdAt).toBeInstanceOf(Date);
        expect(user.updatedAt).toBeInstanceOf(Date);
    });

    it('create() validates required fields', async () =>
    {
        await expect(User.create({ email: 'no-name@x.com' })).rejects.toThrow(/Validation/);
    });

    it('create() validates enum fields', async () =>
    {
        await expect(User.create({ name: 'Bad', email: 'b@b.com', role: 'superadmin' }))
            .rejects.toThrow(/Validation/);
    });

    it('createMany() inserts multiple records', async () =>
    {
        const users = await User.createMany([
            { name: 'A', email: 'a@a.com' },
            { name: 'B', email: 'b@b.com' },
            { name: 'C', email: 'c@c.com' },
        ]);
        expect(users).toHaveLength(3);
        expect(users[2].id).toBe(3);
    });

    it('findById() retrieves a record', async () =>
    {
        await User.create({ name: 'Alice', email: 'a@b.com' });
        const user = await User.findById(1);
        expect(user).not.toBeNull();
        expect(user.name).toBe('Alice');
    });

    it('findById() returns null for missing', async () =>
    {
        const user = await User.findById(999);
        expect(user).toBeNull();
    });

    it('find() returns matching records', async () =>
    {
        await User.createMany([
            { name: 'A', email: 'a@a.com', role: 'admin' },
            { name: 'B', email: 'b@b.com', role: 'user' },
            { name: 'C', email: 'c@c.com', role: 'admin' },
        ]);
        const admins = await User.find({ role: 'admin' });
        expect(admins).toHaveLength(2);
    });

    it('findOne() returns single record', async () =>
    {
        await User.create({ name: 'Solo', email: 'solo@x.com' });
        const user = await User.findOne({ name: 'Solo' });
        expect(user).not.toBeNull();
        expect(user.email).toBe('solo@x.com');
    });

    it('findOrCreate() finds existing', async () =>
    {
        await User.create({ name: 'Exist', email: 'e@e.com' });
        const { instance, created } = await User.findOrCreate({ name: 'Exist' }, { email: 'new@e.com' });
        expect(created).toBe(false);
        expect(instance.email).toBe('e@e.com');
    });

    it('findOrCreate() creates when not found', async () =>
    {
        const { instance, created } = await User.findOrCreate({ name: 'New' }, { email: 'new@x.com' });
        expect(created).toBe(true);
        expect(instance.id).toBeDefined();
    });

    it('instance update() persists changes', async () =>
    {
        const user = await User.create({ name: 'Before', email: 'u@u.com' });
        await user.update({ name: 'After' });
        const reloaded = await User.findById(user.id);
        expect(reloaded.name).toBe('After');
    });

    it('instance save() detects dirty fields', async () =>
    {
        const user = await User.create({ name: 'Dirty', email: 'd@d.com' });
        user.name = 'Clean';
        await user.save();
        const reloaded = await User.findById(user.id);
        expect(reloaded.name).toBe('Clean');
    });

    it('instance delete() removes record', async () =>
    {
        const user = await User.create({ name: 'Gone', email: 'g@g.com' });
        await user.delete();
        const result = await User.findById(user.id);
        expect(result).toBeNull();
    });

    it('updateWhere() updates matching records', async () =>
    {
        await User.createMany([
            { name: 'A', email: 'a@a.com', role: 'user' },
            { name: 'B', email: 'b@b.com', role: 'user' },
        ]);
        const count = await User.updateWhere({ role: 'user' }, { role: 'admin' });
        expect(count).toBe(2);
    });

    it('deleteWhere() removes matching records', async () =>
    {
        await User.createMany([
            { name: 'A', email: 'a@a.com' },
            { name: 'B', email: 'b@b.com' },
        ]);
        const count = await User.deleteWhere({ name: 'A' });
        expect(count).toBe(1);
        const remaining = await User.find();
        expect(remaining).toHaveLength(1);
    });

    it('count() returns record count', async () =>
    {
        await User.createMany([
            { name: 'A', email: 'a@a.com' },
            { name: 'B', email: 'b@b.com' },
            { name: 'C', email: 'c@c.com' },
        ]);
        const c = await User.count();
        expect(c).toBe(3);
    });

    it('toJSON() returns clean data', async () =>
    {
        const user = await User.create({ name: 'Json', email: 'j@j.com' });
        const json = user.toJSON();
        expect(json.name).toBe('Json');
        expect(json._persisted).toBeUndefined();
        expect(json._original).toBeUndefined();
    });
});

describe('Model — Soft Deletes', () =>
{
    beforeEach(async () => { await db.sync(); });

    it('soft delete sets deletedAt', async () =>
    {
        const item = await SoftModel.create({ name: 'Soft' });
        await item.delete();
        // Should not appear in normal find
        const items = await SoftModel.find();
        expect(items).toHaveLength(0);
    });

    it('withDeleted() includes soft-deleted records', async () =>
    {
        const item = await SoftModel.create({ name: 'Soft' });
        await item.delete();
        const all = await SoftModel.query().withDeleted().exec();
        expect(all).toHaveLength(1);
        expect(all[0].deletedAt).toBeDefined();
    });

    it('restore() removes deletedAt', async () =>
    {
        const item = await SoftModel.create({ name: 'Restore' });
        await item.delete();
        await item.restore();
        const items = await SoftModel.find();
        expect(items).toHaveLength(1);
    });
});

describe('Model — Relationships', () =>
{
    beforeEach(async () =>
    {
        await db.sync();
        User.hasMany(Post, 'userId');
        Post.belongsTo(User, 'userId');
    });

    it('hasMany loads related records', async () =>
    {
        const user = await User.create({ name: 'Author', email: 'auth@x.com' });
        await Post.createMany([
            { title: 'Post 1', userId: user.id },
            { title: 'Post 2', userId: user.id },
        ]);
        const posts = await user.load('Post');
        expect(posts).toHaveLength(2);
    });

    it('belongsTo loads parent record', async () =>
    {
        const user = await User.create({ name: 'Parent', email: 'p@x.com' });
        const post = await Post.create({ title: 'Child', userId: user.id });
        const author = await post.load('User');
        expect(author).not.toBeNull();
        expect(author.name).toBe('Parent');
    });
});

describe('Query Builder', () =>
{
    beforeEach(async () =>
    {
        await db.sync();
        await User.createMany([
            { name: 'Alice',   email: 'alice@x.com',   age: 30, role: 'admin' },
            { name: 'Bob',     email: 'bob@x.com',     age: 25, role: 'user' },
            { name: 'Charlie', email: 'charlie@x.com', age: 35, role: 'user' },
            { name: 'Diana',   email: 'diana@x.com',   age: 28, role: 'admin' },
            { name: 'Eve',     email: 'eve@x.com',     age: 22, role: 'user' },
        ]);
    });

    it('where(field, value) equality', async () =>
    {
        const result = await User.query().where('role', 'admin').exec();
        expect(result).toHaveLength(2);
    });

    it('where(field, op, value) comparison', async () =>
    {
        const result = await User.query().where('age', '>', 28).exec();
        expect(result).toHaveLength(2); // Alice (30) and Charlie (35)
    });

    it('where(object) multiple conditions', async () =>
    {
        const result = await User.query().where({ role: 'admin', name: 'Alice' }).exec();
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Alice');
    });

    it('whereIn()', async () =>
    {
        const result = await User.query().whereIn('name', ['Alice', 'Eve']).exec();
        expect(result).toHaveLength(2);
    });

    it('whereBetween()', async () =>
    {
        const result = await User.query().whereBetween('age', 25, 30).exec();
        expect(result).toHaveLength(3); // Bob(25), Diana(28), Alice(30)
    });

    it('orderBy()', async () =>
    {
        const result = await User.query().orderBy('age', 'asc').exec();
        expect(result[0].name).toBe('Eve');
        expect(result[4].name).toBe('Charlie');
    });

    it('limit()', async () =>
    {
        const result = await User.query().limit(2).exec();
        expect(result).toHaveLength(2);
    });

    it('offset()', async () =>
    {
        const result = await User.query().orderBy('id', 'asc').limit(2).offset(2).exec();
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('Charlie');
    });

    it('page()', async () =>
    {
        const page1 = await User.query().orderBy('id', 'asc').page(1, 2).exec();
        const page2 = await User.query().orderBy('id', 'asc').page(2, 2).exec();
        expect(page1).toHaveLength(2);
        expect(page2).toHaveLength(2);
        expect(page1[0].name).toBe('Alice');
        expect(page2[0].name).toBe('Charlie');
    });

    it('select() limits returned fields', async () =>
    {
        const result = await User.query().select('name', 'email').exec();
        expect(result[0].name).toBeDefined();
        expect(result[0].email).toBeDefined();
    });

    it('count()', async () =>
    {
        const total = await User.query().count();
        expect(total).toBe(5);
        const admins = await User.query().where('role', 'admin').count();
        expect(admins).toBe(2);
    });

    it('first()', async () =>
    {
        const user = await User.query().orderBy('age', 'asc').first();
        expect(user.name).toBe('Eve');
    });

    it('await query directly (thenable)', async () =>
    {
        const users = await User.query().where('role', 'user');
        expect(users).toHaveLength(3);
    });

    it('throws when model is not registered', () =>
    {
        class Orphan extends Model { static table = 'orphans'; static schema = {}; }
        expect(() => Orphan.query()).toThrow(/not registered/);
    });
});

describe('Schema — TYPES', () =>
{
    it('TYPES contains all expected types', () =>
    {
        expect(TYPES.STRING).toBe('string');
        expect(TYPES.INTEGER).toBe('integer');
        expect(TYPES.FLOAT).toBe('float');
        expect(TYPES.BOOLEAN).toBe('boolean');
        expect(TYPES.DATE).toBe('date');
        expect(TYPES.DATETIME).toBe('datetime');
        expect(TYPES.JSON).toBe('json');
        expect(TYPES.TEXT).toBe('text');
        expect(TYPES.BLOB).toBe('blob');
        expect(TYPES.UUID).toBe('uuid');
    });
});

describe('Model — Hooks', () =>
{
    let hookLog;

    class HookModel extends Model
    {
        static table = 'hook_items';
        static schema = {
            id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: TYPES.STRING, required: true },
        };
        static hooks = {
            beforeCreate(data) { hookLog.push('beforeCreate'); return data; },
            afterCreate(instance) { hookLog.push('afterCreate'); },
            beforeUpdate(data) { hookLog.push('beforeUpdate'); return data; },
            afterUpdate(instance) { hookLog.push('afterUpdate'); },
            beforeDelete(instance) { hookLog.push('beforeDelete'); },
            afterDelete(instance) { hookLog.push('afterDelete'); },
        };
    }

    beforeEach(async () =>
    {
        hookLog = [];
        db.register(HookModel);
        await db.sync();
    });

    afterEach(() => { HookModel._adapter = null; });

    it('fires beforeCreate and afterCreate on create()', async () =>
    {
        await HookModel.create({ name: 'Hooked' });
        expect(hookLog).toContain('beforeCreate');
        expect(hookLog).toContain('afterCreate');
    });

    it('fires beforeUpdate and afterUpdate on update()', async () =>
    {
        const item = await HookModel.create({ name: 'Before' });
        hookLog = [];
        await item.update({ name: 'After' });
        expect(hookLog).toContain('beforeUpdate');
        expect(hookLog).toContain('afterUpdate');
    });

    it('fires beforeDelete and afterDelete on delete()', async () =>
    {
        const item = await HookModel.create({ name: 'Deletable' });
        hookLog = [];
        await item.delete();
        expect(hookLog).toContain('beforeDelete');
        expect(hookLog).toContain('afterDelete');
    });
});

describe('Memory Adapter — edge cases', () =>
{
    beforeEach(async () => { await db.sync(); });

    it('handles whereNull()', async () =>
    {
        await User.create({ name: 'NoAge', email: 'n@n.com' });
        const result = await User.query().whereNull('age').exec();
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('handles whereNotNull()', async () =>
    {
        await User.create({ name: 'HasAge', email: 'h@h.com', age: 25 });
        const result = await User.query().whereNotNull('age').exec();
        expect(result.length).toBeGreaterThanOrEqual(1);
        for (const r of result) expect(r.age).not.toBeNull();
    });

    it('handles distinct()', async () =>
    {
        await User.createMany([
            { name: 'A', email: 'a1@x.com', role: 'admin' },
            { name: 'B', email: 'a2@x.com', role: 'admin' },
            { name: 'C', email: 'a3@x.com', role: 'user' },
        ]);
        const result = await User.query().select('role').distinct().exec();
        const roles = result.map(r => r.role);
        expect(new Set(roles).size).toBe(roles.length);
    });
});

// --- Pagination --------------------------------------------------

describe('ORM Pagination', () =>
{
    beforeEach(async () =>
    {
        await db.sync();
        const users = [];
        for (let i = 1; i <= 25; i++)
        {
            users.push({ name: `User${i}`, email: `user${i}@test.com`, age: 20 + i, role: i <= 10 ? 'admin' : 'user' });
        }
        await User.createMany(users);
    });

    describe('Query.paginate()', () =>
    {
        it('returns first page with correct metadata', async () =>
        {
            const result = await User.query().paginate(1, 10);
            expect(result.data).toHaveLength(10);
            expect(result.total).toBe(25);
            expect(result.page).toBe(1);
            expect(result.perPage).toBe(10);
            expect(result.pages).toBe(3);
            expect(result.hasNext).toBe(true);
            expect(result.hasPrev).toBe(false);
        });

        it('returns middle page with hasNext and hasPrev both true', async () =>
        {
            const result = await User.query().paginate(2, 10);
            expect(result.data).toHaveLength(10);
            expect(result.page).toBe(2);
            expect(result.hasNext).toBe(true);
            expect(result.hasPrev).toBe(true);
        });

        it('returns last page with remaining items', async () =>
        {
            const result = await User.query().paginate(3, 10);
            expect(result.data).toHaveLength(5);
            expect(result.page).toBe(3);
            expect(result.pages).toBe(3);
            expect(result.hasNext).toBe(false);
            expect(result.hasPrev).toBe(true);
        });

        it('defaults to 20 perPage', async () =>
        {
            const result = await User.query().paginate(1);
            expect(result.perPage).toBe(20);
            expect(result.data).toHaveLength(20);
            expect(result.pages).toBe(2);
        });

        it('clamps page to minimum of 1', async () =>
        {
            const result = await User.query().paginate(0, 10);
            expect(result.page).toBe(1);
            expect(result.data).toHaveLength(10);
        });

        it('works with where conditions', async () =>
        {
            const result = await User.query().where('role', 'admin').paginate(1, 5);
            expect(result.total).toBe(10);
            expect(result.data).toHaveLength(5);
            expect(result.pages).toBe(2);
        });

        it('returns empty data for page beyond total', async () =>
        {
            const result = await User.query().paginate(100, 10);
            expect(result.data).toHaveLength(0);
            expect(result.total).toBe(25);
            expect(result.hasNext).toBe(false);
            expect(result.hasPrev).toBe(true);
        });
    });

    describe('Model.paginate()', () =>
    {
        it('returns paginated results with conditions', async () =>
        {
            const result = await User.paginate(1, 5, { role: 'admin' });
            expect(result.data).toHaveLength(5);
            expect(result.total).toBe(10);
            expect(result.pages).toBe(2);
            expect(result.hasNext).toBe(true);
        });

        it('works without conditions', async () =>
        {
            const result = await User.paginate(2, 10);
            expect(result.data).toHaveLength(10);
            expect(result.page).toBe(2);
            expect(result.total).toBe(25);
        });

        it('returns correct metadata for single-page result', async () =>
        {
            const result = await User.paginate(1, 100);
            expect(result.data).toHaveLength(25);
            expect(result.pages).toBe(1);
            expect(result.hasNext).toBe(false);
            expect(result.hasPrev).toBe(false);
        });
    });
});
// --- Aggregate Functions (Native) ----------------------------

describe('ORM Aggregate — native adapter', () =>
{
    beforeEach(async () =>
    {
        await db.sync();
        await User.createMany([
            { name: 'A', email: 'a@a.com', age: 20 },
            { name: 'B', email: 'b@b.com', age: 30 },
            { name: 'C', email: 'c@c.com', age: 40 },
            { name: 'D', email: 'd@d.com', age: 50 },
        ]);
    });

    it('sum() returns correct total', async () =>
    {
        const total = await User.query().sum('age');
        expect(total).toBe(140);
    });

    it('avg() returns correct average', async () =>
    {
        const average = await User.query().avg('age');
        expect(average).toBe(35);
    });

    it('min() returns correct minimum', async () =>
    {
        const minimum = await User.query().min('age');
        expect(minimum).toBe(20);
    });

    it('max() returns correct maximum', async () =>
    {
        const maximum = await User.query().max('age');
        expect(maximum).toBe(50);
    });

    it('sum() with where filter', async () =>
    {
        const total = await User.query().where('age', '>', 25).sum('age');
        expect(total).toBe(120);
    });

    it('avg() returns 0 for empty set', async () =>
    {
        const average = await User.query().where('age', '>', 100).avg('age');
        expect(average).toBe(0);
    });

    it('min() returns null for empty set', async () =>
    {
        const result = await User.query().where('age', '>', 100).min('age');
        expect(result).toBeNull();
    });
});

// --- Batch Insert -----------------------------------------------

describe('ORM Batch Insert', () =>
{
    beforeEach(async () => { await db.sync(); });

    it('createMany() batch inserts with correct IDs', async () =>
    {
        const users = await User.createMany([
            { name: 'A', email: 'a@a.com' },
            { name: 'B', email: 'b@b.com' },
            { name: 'C', email: 'c@c.com' },
        ]);
        expect(users).toHaveLength(3);
        expect(users[0].id).toBeDefined();
        expect(users[1].id).toBeDefined();
        expect(users[2].id).toBeDefined();
    });

    it('createMany() applies timestamps', async () =>
    {
        const users = await User.createMany([
            { name: 'X', email: 'x@x.com' },
            { name: 'Y', email: 'y@y.com' },
        ]);
        for (const u of users) expect(u.createdAt).toBeDefined();
    });

    it('createMany() validates each record', async () =>
    {
        await expect(User.createMany([
            { name: 'Good', email: 'good@g.com' },
            { email: 'no-name@x.com' },
        ])).rejects.toThrow(/Validation/);
    });

    it('createMany() returns empty for empty input', async () =>
    {
        const result = await User.createMany([]);
        expect(result).toHaveLength(0);
    });

    it('createMany() batch is retrievable after insert', async () =>
    {
        await User.createMany([
            { name: 'A', email: 'a@a.com' },
            { name: 'B', email: 'b@b.com' },
        ]);
        const all = await User.find();
        expect(all).toHaveLength(2);
    });
});

// --- Eager Loading -----------------------------------------------

describe('ORM Eager Loading (.with)', () =>
{
    class Author extends Model
    {
        static table = 'authors';
        static schema = {
            id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: TYPES.STRING, required: true },
        };
    }

    class Article extends Model
    {
        static table = 'articles';
        static schema = {
            id:       { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            title:    { type: TYPES.STRING, required: true },
            authorId: { type: TYPES.INTEGER, required: true },
        };
    }

    class Comment extends Model
    {
        static table = 'comments';
        static schema = {
            id:        { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            text:      { type: TYPES.STRING, required: true },
            articleId: { type: TYPES.INTEGER, required: true },
        };
    }

    let eagerDb;

    beforeEach(async () =>
    {
        eagerDb = Database.connect('memory');
        eagerDb.registerAll(Author, Article, Comment);
        await eagerDb.sync();

        // Setup relationships
        Author.hasMany(Article, 'authorId');
        Article.belongsTo(Author, 'authorId');
        Article.hasMany(Comment, 'articleId');

        // Seed data
        await Author.createMany([
            { name: 'Alice' },
            { name: 'Bob' },
        ]);
        await Article.createMany([
            { title: 'Article 1', authorId: 1 },
            { title: 'Article 2', authorId: 1 },
            { title: 'Article 3', authorId: 2 },
        ]);
        await Comment.createMany([
            { text: 'Comment 1', articleId: 1 },
            { text: 'Comment 2', articleId: 1 },
            { text: 'Comment 3', articleId: 2 },
        ]);
    });

    afterEach(() =>
    {
        Author._adapter = null;
        Article._adapter = null;
        Comment._adapter = null;
        Author._relations = {};
        Article._relations = {};
        Comment._relations = {};
    });

    it('with() loads hasMany relation in batch', async () =>
    {
        const authors = await Author.query().with('Article').exec();
        expect(authors).toHaveLength(2);
        const alice = authors.find(a => a.name === 'Alice');
        expect(alice.Article).toHaveLength(2);
        const bob = authors.find(a => a.name === 'Bob');
        expect(bob.Article).toHaveLength(1);
    });

    it('with() loads belongsTo relation in batch', async () =>
    {
        const articles = await Article.query().with('Author').exec();
        expect(articles).toHaveLength(3);
        expect(articles[0].Author).toBeDefined();
        expect(articles[0].Author.name).toBe('Alice');
        expect(articles[2].Author.name).toBe('Bob');
    });

    it('with() loads multiple relations', async () =>
    {
        const articles = await Article.query().with('Author', 'Comment').exec();
        expect(articles[0].Author).toBeDefined();
        expect(articles[0].Comment).toBeDefined();
        expect(articles[0].Comment).toHaveLength(2);
    });

    it('include() is alias for with()', async () =>
    {
        const authors = await Author.query().include('Article').exec();
        expect(authors[0].Article).toBeDefined();
    });

    it('with() scope constrains eager load', async () =>
    {
        const authors = await Author.query().with({
            Article: q => q.where('title', 'Article 1')
        }).exec();
        const alice = authors.find(a => a.name === 'Alice');
        expect(alice.Article).toHaveLength(1);
        expect(alice.Article[0].title).toBe('Article 1');
    });

    it('with() returns empty array for hasMany with no matches', async () =>
    {
        const bob = await Author.query().where('name', 'Bob').with({
            Article: q => q.where('title', 'Nonexistent')
        }).first();
        expect(bob.Article).toEqual([]);
    });

    it('with() throws for unknown relation', async () =>
    {
        await expect(Author.query().with('Unknown').exec()).rejects.toThrow(/Unknown relation/);
    });
});

// --- GROUP BY / HAVING -------------------------------------------

describe('ORM GROUP BY / HAVING', () =>
{
    beforeEach(async () =>
    {
        await db.sync();
        await User.createMany([
            { name: 'A1', email: 'a1@a.com', role: 'admin', age: 25 },
            { name: 'A2', email: 'a2@a.com', role: 'admin', age: 35 },
            { name: 'U1', email: 'u1@u.com', role: 'user',  age: 20 },
            { name: 'U2', email: 'u2@u.com', role: 'user',  age: 30 },
            { name: 'U3', email: 'u3@u.com', role: 'user',  age: 40 },
        ]);
    });

    it('groupBy() groups results', async () =>
    {
        const results = await User.query().select('role').groupBy('role').exec();
        expect(results).toHaveLength(2);
    });

    it('groupBy() + having() filters groups', async () =>
    {
        // Count by role, only groups with count >= 3
        const results = await User.query()
            .select('role')
            .groupBy('role')
            .having('COUNT(*)', '>=', 3)
            .exec();
        // Only 'user' has 3 members, 'admin' has 2
        expect(results.length).toBeGreaterThanOrEqual(1);
        // The 'user' group should be present
        const userGroup = results.find(r => r.role === 'user');
        expect(userGroup).toBeDefined();
    });
});

// --- JOIN support ------------------------------------------------

describe('ORM JOINs', () =>
{
    class Product extends Model
    {
        static table = 'products';
        static schema = {
            id:         { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            name:       { type: TYPES.STRING, required: true },
            categoryId: { type: TYPES.INTEGER },
        };
    }

    class Category extends Model
    {
        static table = 'categories';
        static schema = {
            id:   { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: TYPES.STRING, required: true },
        };
    }

    let joinDb;

    beforeEach(async () =>
    {
        joinDb = Database.connect('memory');
        joinDb.registerAll(Product, Category);
        await joinDb.sync();

        await Category.createMany([
            { name: 'Electronics' },
            { name: 'Books' },
        ]);
        await Product.createMany([
            { name: 'Laptop', categoryId: 1 },
            { name: 'Phone', categoryId: 1 },
            { name: 'Novel', categoryId: 2 },
        ]);
    });

    afterEach(() =>
    {
        Product._adapter = null;
        Category._adapter = null;
    });

    it('join() method adds to query descriptor', () =>
    {
        const desc = Product.query().join('categories', 'categoryId', 'id').build();
        expect(desc.joins).toHaveLength(1);
        expect(desc.joins[0].type).toBe('INNER');
    });

    it('leftJoin() adds LEFT join to descriptor', () =>
    {
        const desc = Product.query().leftJoin('categories', 'categoryId', 'id').build();
        expect(desc.joins[0].type).toBe('LEFT');
    });

    it('rightJoin() adds RIGHT join to descriptor', () =>
    {
        const desc = Product.query().rightJoin('categories', 'categoryId', 'id').build();
        expect(desc.joins[0].type).toBe('RIGHT');
    });
});

// -- Extended Schema Types (Phase 9) --------------------------------

describe('Extended TYPES enum', () =>
{
    it('includes all base types', () =>
    {
        expect(TYPES.STRING).toBe('string');
        expect(TYPES.INTEGER).toBe('integer');
        expect(TYPES.FLOAT).toBe('float');
        expect(TYPES.BOOLEAN).toBe('boolean');
        expect(TYPES.DATE).toBe('date');
        expect(TYPES.DATETIME).toBe('datetime');
        expect(TYPES.JSON).toBe('json');
        expect(TYPES.TEXT).toBe('text');
        expect(TYPES.BLOB).toBe('blob');
        expect(TYPES.UUID).toBe('uuid');
    });

    it('includes extended numeric types', () =>
    {
        expect(TYPES.BIGINT).toBe('bigint');
        expect(TYPES.SMALLINT).toBe('smallint');
        expect(TYPES.TINYINT).toBe('tinyint');
        expect(TYPES.DECIMAL).toBe('decimal');
        expect(TYPES.DOUBLE).toBe('double');
        expect(TYPES.REAL).toBe('real');
    });

    it('includes extended string/binary types', () =>
    {
        expect(TYPES.CHAR).toBe('char');
        expect(TYPES.BINARY).toBe('binary');
        expect(TYPES.VARBINARY).toBe('varbinary');
    });

    it('includes temporal types', () =>
    {
        expect(TYPES.TIMESTAMP).toBe('timestamp');
        expect(TYPES.TIME).toBe('time');
    });

    it('includes MySQL-specific types', () =>
    {
        expect(TYPES.ENUM).toBe('enum');
        expect(TYPES.SET).toBe('set');
        expect(TYPES.MEDIUMTEXT).toBe('mediumtext');
        expect(TYPES.LONGTEXT).toBe('longtext');
        expect(TYPES.MEDIUMBLOB).toBe('mediumblob');
        expect(TYPES.LONGBLOB).toBe('longblob');
        expect(TYPES.YEAR).toBe('year');
    });

    it('includes PostgreSQL-specific types', () =>
    {
        expect(TYPES.SERIAL).toBe('serial');
        expect(TYPES.BIGSERIAL).toBe('bigserial');
        expect(TYPES.JSONB).toBe('jsonb');
        expect(TYPES.INTERVAL).toBe('interval');
        expect(TYPES.INET).toBe('inet');
        expect(TYPES.CIDR).toBe('cidr');
        expect(TYPES.MACADDR).toBe('macaddr');
        expect(TYPES.MONEY).toBe('money');
        expect(TYPES.XML).toBe('xml');
        expect(TYPES.CITEXT).toBe('citext');
        expect(TYPES.ARRAY).toBe('array');
    });

    it('includes SQLite numeric type', () =>
    {
        expect(TYPES.NUMERIC).toBe('numeric');
    });
});

describe('Extended schema validation', () =>
{
    const { validateValue } = require('../../lib/orm/schema');

    it('validates bigint/smallint/tinyint as integers', () =>
    {
        expect(validateValue(42, { type: 'bigint' }, 'col')).toBe(42);
        expect(validateValue('99', { type: 'smallint' }, 'col')).toBe(99);
        expect(validateValue(1, { type: 'tinyint' }, 'col')).toBe(1);
    });

    it('validates decimal/double/real/numeric as numbers', () =>
    {
        expect(validateValue(3.14, { type: 'decimal' }, 'col')).toBe(3.14);
        expect(validateValue('2.5', { type: 'double' }, 'col')).toBe(2.5);
        expect(validateValue(1.0, { type: 'real' }, 'col')).toBe(1.0);
        expect(validateValue(9.99, { type: 'numeric' }, 'col')).toBe(9.99);
        expect(validateValue(100, { type: 'money' }, 'col')).toBe(100);
    });

    it('validates timestamp/time/interval as dates', () =>
    {
        const d = new Date('2024-01-01');
        expect(validateValue(d, { type: 'timestamp' }, 'col')).toEqual(d);
        expect(validateValue('2024-06-15', { type: 'time' }, 'col')).toBeInstanceOf(Date);
        expect(validateValue('2024-01-01', { type: 'interval' }, 'col')).toBeInstanceOf(Date);
    });

    it('validates mediumtext/longtext/char/citext/xml as strings', () =>
    {
        expect(validateValue('hello', { type: 'mediumtext' }, 'col')).toBe('hello');
        expect(validateValue('world', { type: 'longtext' }, 'col')).toBe('world');
        expect(validateValue('X', { type: 'char' }, 'col')).toBe('X');
        expect(validateValue('case', { type: 'citext' }, 'col')).toBe('case');
        expect(validateValue('<x/>', { type: 'xml' }, 'col')).toBe('<x/>');
    });

    it('validates jsonb identically to json', () =>
    {
        expect(validateValue('{"a":1}', { type: 'jsonb' }, 'col')).toEqual({ a: 1 });
        expect(validateValue({ b: 2 }, { type: 'jsonb' }, 'col')).toEqual({ b: 2 });
    });

    it('validates blob variants as buffers', () =>
    {
        expect(validateValue('data', { type: 'mediumblob' }, 'col')).toBeInstanceOf(Buffer);
        expect(validateValue('data', { type: 'longblob' }, 'col')).toBeInstanceOf(Buffer);
        expect(validateValue('data', { type: 'binary' }, 'col')).toBeInstanceOf(Buffer);
        expect(validateValue('data', { type: 'varbinary' }, 'col')).toBeInstanceOf(Buffer);
    });

    it('validates enum with allowed values', () =>
    {
        expect(validateValue('a', { type: 'enum', enum: ['a', 'b', 'c'] }, 'col')).toBe('a');
        expect(() => validateValue('z', { type: 'enum', enum: ['a', 'b'] }, 'col')).toThrow(/must be one of/);
    });

    it('validates set with allowed values', () =>
    {
        expect(validateValue('a,b', { type: 'set', values: ['a', 'b', 'c'] }, 'col')).toBe('a,b');
        expect(validateValue(['a', 'c'], { type: 'set', values: ['a', 'b', 'c'] }, 'col')).toBe('a,c');
        expect(() => validateValue('z', { type: 'set', values: ['a', 'b'] }, 'col')).toThrow(/invalid value/);
    });

    it('validates inet/cidr/macaddr as strings', () =>
    {
        expect(validateValue('192.168.1.1', { type: 'inet' }, 'col')).toBe('192.168.1.1');
        expect(validateValue('10.0.0.0/8', { type: 'cidr' }, 'col')).toBe('10.0.0.0/8');
        expect(validateValue('AA:BB:CC:DD:EE:FF', { type: 'macaddr' }, 'col')).toBe('AA:BB:CC:DD:EE:FF');
    });

    it('validates array type', () =>
    {
        expect(validateValue([1, 2, 3], { type: 'array' }, 'col')).toEqual([1, 2, 3]);
        expect(validateValue('single', { type: 'array' }, 'col')).toEqual(['single']);
    });

    it('validates year as integer', () =>
    {
        expect(validateValue(2024, { type: 'year' }, 'col')).toBe(2024);
        expect(validateValue('2023', { type: 'year' }, 'col')).toBe(2023);
    });

    it('validates serial/bigserial as integers', () =>
    {
        expect(validateValue(1, { type: 'serial' }, 'col')).toBe(1);
        expect(validateValue(999999999, { type: 'bigserial' }, 'col')).toBe(999999999);
    });
});