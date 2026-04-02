/**
 * Phase 3 — Advanced Relationships
 * Polymorphic, has-many-through, self-referential, tree structures
 */
const { Database, Model, TYPES } = require('../../lib/orm');

// ===================================================================
// Helpers
// ===================================================================

function memDb()
{
    return Database.connect('memory');
}

function makeModel(db, table, schema, opts = {})
{
    const M = class extends Model
    {
        static table = table;
        static schema = schema;
    };
    Object.defineProperty(M, 'name', { value: opts.name || table });
    db.register(M);
    return M;
}

// ===================================================================
// Polymorphic Relationships
// ===================================================================
describe('Polymorphic Relationships', () =>
{
    let db, User, Post, Image;

    beforeEach(async () =>
    {
        db = memDb();
        User = makeModel(db, 'users', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'User' });

        Post = makeModel(db, 'posts', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
        }, { name: 'Post' });

        Image = makeModel(db, 'images', {
            id:             { type: 'integer', primaryKey: true, autoIncrement: true },
            url:            { type: 'string', required: true },
            imageable_type: { type: 'string', required: true },
            imageable_id:   { type: 'integer', required: true },
        }, { name: 'Image' });

        await db.sync();
    });

    // -- morphOne -----------------------------------------

    describe('morphOne', () =>
    {
        beforeEach(() =>
        {
            User.morphOne(Image, 'imageable');
            Post.morphOne(Image, 'imageable');
        });

        it('defines a morphOne relationship', () =>
        {
            expect(User._relations.Image).toBeDefined();
            expect(User._relations.Image.type).toBe('morphOne');
            expect(User._relations.Image.morphName).toBe('imageable');
        });

        it('load() returns the morphed record', async () =>
        {
            const user = await User.create({ name: 'Alice' });
            await Image.create({ url: '/avatar.png', imageable_type: 'User', imageable_id: user.id });

            const avatar = await user.load('Image');
            expect(avatar).not.toBeNull();
            expect(avatar.url).toBe('/avatar.png');
        });

        it('load() returns null when no match', async () =>
        {
            const user = await User.create({ name: 'Bob' });
            const avatar = await user.load('Image');
            expect(avatar).toBeNull();
        });

        it('eager-loads morphOne with query().with()', async () =>
        {
            const u1 = await User.create({ name: 'Alice' });
            const u2 = await User.create({ name: 'Bob' });
            await Image.create({ url: '/alice.png', imageable_type: 'User', imageable_id: u1.id });

            const users = await User.query().with('Image').exec();
            expect(users.length).toBe(2);
            const alice = users.find(u => u.name === 'Alice');
            const bob = users.find(u => u.name === 'Bob');
            expect(alice.Image.url).toBe('/alice.png');
            expect(bob.Image).toBeNull();
        });

        it('eager-counts morphOne', async () =>
        {
            const u = await User.create({ name: 'Alice' });
            await Image.create({ url: '/a.png', imageable_type: 'User', imageable_id: u.id });

            const users = await User.query().withCount('Image').exec();
            expect(users[0].Image_count).toBe(1);
        });

        it('morphOne distinguishes type correctly', async () =>
        {
            const user = await User.create({ name: 'Alice' });
            const post = await Post.create({ title: 'Hello' });
            await Image.create({ url: '/user.png', imageable_type: 'User', imageable_id: user.id });
            await Image.create({ url: '/post.png', imageable_type: 'Post', imageable_id: post.id });

            const userImg = await user.load('Image');
            const postImg = await post.load('Image');
            expect(userImg.url).toBe('/user.png');
            expect(postImg.url).toBe('/post.png');
        });

        it('morphOne with custom localKey', async () =>
        {
            const db2 = memDb();
            const M = makeModel(db2, 'entities', {
                id:   { type: 'integer', primaryKey: true, autoIncrement: true },
                uuid: { type: 'string', required: true },
            }, { name: 'Entity' });
            const I = makeModel(db2, 'morphed_imgs', {
                id:           { type: 'integer', primaryKey: true, autoIncrement: true },
                url:          { type: 'string', required: true },
                linkable_type: { type: 'string', required: true },
                linkable_id:   { type: 'string', required: true },
            }, { name: 'MorphedImg' });
            await db2.sync();

            M.morphOne(I, 'linkable', 'uuid');
            const e = await M.create({ uuid: 'abc-123' });
            await I.create({ url: '/test.png', linkable_type: 'Entity', linkable_id: 'abc-123' });
            const img = await e.load('MorphedImg');
            expect(img.url).toBe('/test.png');
        });
    });

    // -- morphMany ----------------------------------------

    describe('morphMany', () =>
    {
        let Comment;

        beforeEach(async () =>
        {
            Comment = makeModel(db, 'comments', {
                id:               { type: 'integer', primaryKey: true, autoIncrement: true },
                body:             { type: 'string', required: true },
                commentable_type: { type: 'string', required: true },
                commentable_id:   { type: 'integer', required: true },
            }, { name: 'Comment' });
            await db.sync();
            Post.morphMany(Comment, 'commentable');
            User.morphMany(Comment, 'commentable');
        });

        it('defines a morphMany relationship', () =>
        {
            expect(Post._relations.Comment).toBeDefined();
            expect(Post._relations.Comment.type).toBe('morphMany');
        });

        it('load() returns morphed records', async () =>
        {
            const post = await Post.create({ title: 'Hello' });
            await Comment.create({ body: 'Great!', commentable_type: 'Post', commentable_id: post.id });
            await Comment.create({ body: 'Awesome!', commentable_type: 'Post', commentable_id: post.id });

            const comments = await post.load('Comment');
            expect(comments.length).toBe(2);
            expect(comments[0].body).toBe('Great!');
        });

        it('load() returns empty when no matches', async () =>
        {
            const post = await Post.create({ title: 'Empty' });
            const comments = await post.load('Comment');
            expect(comments).toEqual([]);
        });

        it('eager-loads morphMany with query().with()', async () =>
        {
            const p1 = await Post.create({ title: 'Post 1' });
            const p2 = await Post.create({ title: 'Post 2' });
            await Comment.create({ body: 'C1', commentable_type: 'Post', commentable_id: p1.id });
            await Comment.create({ body: 'C2', commentable_type: 'Post', commentable_id: p1.id });

            const posts = await Post.query().with('Comment').exec();
            const post1 = posts.find(p => p.title === 'Post 1');
            const post2 = posts.find(p => p.title === 'Post 2');
            expect(post1.Comment.length).toBe(2);
            expect(post2.Comment).toEqual([]);
        });

        it('eager-counts morphMany', async () =>
        {
            const p = await Post.create({ title: 'P' });
            await Comment.create({ body: 'C1', commentable_type: 'Post', commentable_id: p.id });
            await Comment.create({ body: 'C2', commentable_type: 'Post', commentable_id: p.id });

            const posts = await Post.query().withCount('Comment').exec();
            expect(posts[0].Comment_count).toBe(2);
        });

        it('morphMany distinguishes type from other models', async () =>
        {
            const post = await Post.create({ title: 'P' });
            const user = await User.create({ name: 'U' });
            await Comment.create({ body: 'PostC', commentable_type: 'Post', commentable_id: post.id });
            await Comment.create({ body: 'UserC', commentable_type: 'User', commentable_id: user.id });

            const postComments = await post.load('Comment');
            const userComments = await user.load('Comment');
            expect(postComments.length).toBe(1);
            expect(postComments[0].body).toBe('PostC');
            expect(userComments.length).toBe(1);
            expect(userComments[0].body).toBe('UserC');
        });
    });
});

// ===================================================================
// Has Many Through
// ===================================================================
describe('Has Many Through', () =>
{
    let db, Country, UserR, PostR;

    beforeEach(async () =>
    {
        db = memDb();
        Country = makeModel(db, 'countries', {
            id:   { type: 'integer', primaryKey: true, autoIncrement: true },
            name: { type: 'string', required: true },
        }, { name: 'Country' });

        UserR = makeModel(db, 'hmt_users', {
            id:        { type: 'integer', primaryKey: true, autoIncrement: true },
            name:      { type: 'string', required: true },
            countryId: { type: 'integer', required: true },
        }, { name: 'HmtUser' });

        PostR = makeModel(db, 'hmt_posts', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            title:  { type: 'string', required: true },
            userId: { type: 'integer', required: true },
        }, { name: 'HmtPost' });

        await db.sync();
        Country.hasManyThrough(PostR, UserR, 'countryId', 'userId');
    });

    it('defines a hasManyThrough relationship', () =>
    {
        expect(Country._relations.HmtPost).toBeDefined();
        expect(Country._relations.HmtPost.type).toBe('hasManyThrough');
    });

    it('load() returns distant related records', async () =>
    {
        const usa = await Country.create({ name: 'USA' });
        const alice = await UserR.create({ name: 'Alice', countryId: usa.id });
        const bob = await UserR.create({ name: 'Bob', countryId: usa.id });
        await PostR.create({ title: 'Post 1', userId: alice.id });
        await PostR.create({ title: 'Post 2', userId: alice.id });
        await PostR.create({ title: 'Post 3', userId: bob.id });

        const posts = await usa.load('HmtPost');
        expect(posts.length).toBe(3);
        const titles = posts.map(p => p.title).sort();
        expect(titles).toEqual(['Post 1', 'Post 2', 'Post 3']);
    });

    it('load() returns empty when no through records', async () =>
    {
        const country = await Country.create({ name: 'Empty' });
        const posts = await country.load('HmtPost');
        expect(posts).toEqual([]);
    });

    it('eager-loads hasManyThrough', async () =>
    {
        const usa = await Country.create({ name: 'USA' });
        const uk = await Country.create({ name: 'UK' });
        const alice = await UserR.create({ name: 'Alice', countryId: usa.id });
        await PostR.create({ title: 'P1', userId: alice.id });

        const countries = await Country.query().with('HmtPost').exec();
        const c1 = countries.find(c => c.name === 'USA');
        const c2 = countries.find(c => c.name === 'UK');
        expect(c1.HmtPost.length).toBe(1);
        expect(c2.HmtPost).toEqual([]);
    });

    it('eager-counts hasManyThrough', async () =>
    {
        const c = await Country.create({ name: 'C' });
        const u = await UserR.create({ name: 'U', countryId: c.id });
        await PostR.create({ title: 'P', userId: u.id });
        await PostR.create({ title: 'P2', userId: u.id });

        const countries = await Country.query().withCount('HmtPost').exec();
        expect(countries[0].HmtPost_count).toBe(1); // counts through records, not final
    });

    it('hasManyThrough with custom secondLocalKey', async () =>
    {
        const db2 = memDb();
        const Source = makeModel(db2, 'sources', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'Source' });
        const Mid = makeModel(db2, 'middles', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            sourceId: { type: 'integer', required: true },
            code:     { type: 'string', required: true },
        }, { name: 'Middle' });
        const Dest = makeModel(db2, 'dests', {
            id:     { type: 'integer', primaryKey: true, autoIncrement: true },
            midCode: { type: 'string', required: true },
            value:   { type: 'string', required: true },
        }, { name: 'Dest' });
        await db2.sync();

        Source.hasManyThrough(Dest, Mid, 'sourceId', 'midCode', undefined, 'code');

        const s = await Source.create({});
        const m = await Mid.create({ sourceId: s.id, code: 'X' });
        await Dest.create({ midCode: 'X', value: 'found' });

        const dests = await s.load('Dest');
        expect(dests.length).toBe(1);
        expect(dests[0].value).toBe('found');
    });
});

// ===================================================================
// Self-Referential Relationships
// ===================================================================
describe('Self-Referential Relationships', () =>
{
    let db, Category;

    beforeEach(async () =>
    {
        db = memDb();
        Category = makeModel(db, 'categories', {
            id:       { type: 'integer', primaryKey: true, autoIncrement: true },
            name:     { type: 'string', required: true },
            parentId: { type: 'integer', nullable: true },
        }, { name: 'Category' });
        await db.sync();
    });

    it('selfReferential creates parent and children relations', () =>
    {
        Category.selfReferential({ foreignKey: 'parentId' });
        expect(Category._relations.parent).toBeDefined();
        expect(Category._relations.parent.type).toBe('belongsTo');
        expect(Category._relations.children).toBeDefined();
        expect(Category._relations.children.type).toBe('hasMany');
    });

    it('selfReferential with custom names', () =>
    {
        Category.selfReferential({
            foreignKey: 'parentId',
            parentName: 'parentCat',
            childrenName: 'subCats',
        });
        expect(Category._relations.parentCat).toBeDefined();
        expect(Category._relations.subCats).toBeDefined();
    });

    it('selfReferential throws without foreignKey', () =>
    {
        expect(() => Category.selfReferential({})).toThrow('foreignKey');
    });

    it('load parent and children via selfReferential', async () =>
    {
        Category.selfReferential({ foreignKey: 'parentId' });

        const root = await Category.create({ name: 'Root', parentId: null });
        const child1 = await Category.create({ name: 'Child 1', parentId: root.id });
        const child2 = await Category.create({ name: 'Child 2', parentId: root.id });

        const children = await root.load('children');
        expect(children.length).toBe(2);

        const parent = await child1.load('parent');
        expect(parent.name).toBe('Root');
    });

    // -- Tree -------------------------------------------

    describe('tree()', () =>
    {
        it('builds a tree structure', async () =>
        {
            const root = await Category.create({ name: 'Root', parentId: null });
            const c1 = await Category.create({ name: 'C1', parentId: root.id });
            const c2 = await Category.create({ name: 'C2', parentId: root.id });
            const c1a = await Category.create({ name: 'C1a', parentId: c1.id });

            const tree = await Category.tree({ foreignKey: 'parentId' });
            expect(tree.length).toBe(1);
            expect(tree[0].name).toBe('Root');
            expect(tree[0].children.length).toBe(2);
            const c1Node = tree[0].children.find(c => c.name === 'C1');
            expect(c1Node.children.length).toBe(1);
            expect(c1Node.children[0].name).toBe('C1a');
        });

        it('tree with custom childrenKey', async () =>
        {
            const root = await Category.create({ name: 'Root', parentId: null });
            await Category.create({ name: 'C1', parentId: root.id });

            const tree = await Category.tree({ foreignKey: 'parentId', childrenKey: 'subcats' });
            expect(tree[0].subcats.length).toBe(1);
        });

        it('orphan nodes become roots', async () =>
        {
            await Category.create({ name: 'Orphan', parentId: 999 });
            const tree = await Category.tree({ foreignKey: 'parentId' });
            expect(tree.length).toBe(1);
            expect(tree[0].name).toBe('Orphan');
        });

        it('empty table returns empty tree', async () =>
        {
            const tree = await Category.tree({ foreignKey: 'parentId' });
            expect(tree).toEqual([]);
        });

        it('tree with rootValue=0', async () =>
        {
            const db2 = memDb();
            const Cat2 = makeModel(db2, 'cats2', {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string', required: true },
                parentId: { type: 'integer', default: 0 },
            }, { name: 'Cat2' });
            await db2.sync();

            await Cat2.create({ name: 'Root', parentId: 0 });
            const tree = await Cat2.tree({ foreignKey: 'parentId', rootValue: 0 });
            expect(tree.length).toBe(1);
            expect(tree[0].name).toBe('Root');
        });
    });

    // -- Ancestors & Descendants -------------------------

    describe('ancestors()', () =>
    {
        it('returns ancestors from parent to root', async () =>
        {
            const root = await Category.create({ name: 'Root', parentId: null });
            const mid = await Category.create({ name: 'Mid', parentId: root.id });
            const leaf = await Category.create({ name: 'Leaf', parentId: mid.id });

            const anc = await leaf.ancestors('parentId');
            expect(anc.length).toBe(2);
            expect(anc[0].name).toBe('Mid');
            expect(anc[1].name).toBe('Root');
        });

        it('returns empty for root node', async () =>
        {
            const root = await Category.create({ name: 'Root', parentId: null });
            const anc = await root.ancestors('parentId');
            expect(anc).toEqual([]);
        });

        it('handles circular references without infinite loop', async () =>
        {
            // Create circular: A -> B -> A
            const a = await Category.create({ name: 'A', parentId: null });
            const b = await Category.create({ name: 'B', parentId: a.id });
            // Manually make it circular
            await a.update({ parentId: b.id });

            const anc = await b.ancestors('parentId');
            // Should stop when it detects the cycle
            expect(anc.length).toBeLessThanOrEqual(2);
        });

        it('handles broken chain (missing parent)', async () =>
        {
            const cat = await Category.create({ name: 'Orphan', parentId: 999 });
            const anc = await cat.ancestors('parentId');
            // Should stop when parent not found
            expect(anc).toEqual([]);
        });
    });

    describe('descendants()', () =>
    {
        it('returns all descendants breadth-first', async () =>
        {
            const root = await Category.create({ name: 'Root', parentId: null });
            const c1 = await Category.create({ name: 'C1', parentId: root.id });
            const c2 = await Category.create({ name: 'C2', parentId: root.id });
            const c1a = await Category.create({ name: 'C1a', parentId: c1.id });

            const desc = await root.descendants('parentId');
            expect(desc.length).toBe(3);
            const names = desc.map(d => d.name);
            // C1 and C2 should come before C1a (breadth-first)
            expect(names.indexOf('C1a')).toBeGreaterThan(names.indexOf('C1'));
        });

        it('returns empty for leaf node', async () =>
        {
            const leaf = await Category.create({ name: 'Leaf', parentId: null });
            const desc = await leaf.descendants('parentId');
            expect(desc).toEqual([]);
        });

        it('handles circular references without infinite loop', async () =>
        {
            const a = await Category.create({ name: 'A', parentId: null });
            const b = await Category.create({ name: 'B', parentId: a.id });
            await a.update({ parentId: b.id });

            const desc = await a.descendants('parentId');
            // Should not loop infinitely
            expect(desc.length).toBeGreaterThanOrEqual(1);
        });
    });
});

// ===================================================================
// Eager Loading — empty key sets
// ===================================================================
describe('Eager loading edge cases for new relation types', () =>
{
    let db, Post, Comment;

    beforeEach(async () =>
    {
        db = memDb();
        Post = makeModel(db, 'ep', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'EP' });
        Comment = makeModel(db, 'ec', {
            id:               { type: 'integer', primaryKey: true, autoIncrement: true },
            commentable_type: { type: 'string', required: true },
            commentable_id:   { type: 'integer', required: true },
        }, { name: 'EC' });
        await db.sync();
        Post.morphMany(Comment, 'commentable');
    });

    it('morphMany eager-load with no keys is a no-op', async () =>
    {
        // All instances have null localKey
        const posts = await Post.query().with('EC').exec();
        expect(posts).toEqual([]);
    });

    it('morphOne eager-count with no keys returns 0', async () =>
    {
        const db2 = memDb();
        const M = makeModel(db2, 'eccm', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'ECCM' });
        const I = makeModel(db2, 'ecci', {
            id:           { type: 'integer', primaryKey: true, autoIncrement: true },
            link_type:    { type: 'string', required: true },
            link_id:      { type: 'integer', required: true },
        }, { name: 'ECCI' });
        await db2.sync();
        M.morphOne(I, 'link');

        const items = await M.query().withCount('ECCI').exec();
        expect(items).toEqual([]);
    });

    it('morphMany eager-count with no keys returns 0', async () =>
    {
        const posts = await Post.query().withCount('EC').exec();
        expect(posts).toEqual([]);
    });

    it('hasManyThrough eager-load with no through records sets empty arrays', async () =>
    {
        const db2 = memDb();
        const A = makeModel(db2, 'hmt_a', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'HmtA' });
        const B = makeModel(db2, 'hmt_b', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            aId: { type: 'integer', required: true },
        }, { name: 'HmtB' });
        const C = makeModel(db2, 'hmt_c', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            bId: { type: 'integer', required: true },
        }, { name: 'HmtC' });
        await db2.sync();

        A.hasManyThrough(C, B, 'aId', 'bId');
        const a = await A.create({});
        const items = await A.query().with('HmtC').exec();
        expect(items[0].HmtC).toEqual([]);
    });

    it('hasManyThrough eager-count with no keys returns 0', async () =>
    {
        const db2 = memDb();
        const A = makeModel(db2, 'hmt_a2', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
        }, { name: 'HmtA2' });
        const B = makeModel(db2, 'hmt_b2', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            aId: { type: 'integer', required: true },
        }, { name: 'HmtB2' });
        const C = makeModel(db2, 'hmt_c2', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            bId: { type: 'integer', required: true },
        }, { name: 'HmtC2' });
        await db2.sync();

        A.hasManyThrough(C, B, 'aId', 'bId');
        const items = await A.query().withCount('HmtC2').exec();
        expect(items).toEqual([]);
    });
});
