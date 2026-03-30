const { NotFoundError, BadRequestError, Fake, Factory, Seeder, SeederRunner } = require('../..');
const Author = require('../models/Author');
const Post = require('../models/Post');

/* ---- Authors ---- */

exports.listAuthors = async (req, res) =>
{
    let q = Author.query();
    if (req.query.role) q = q.scope(req.query.role);
    if (req.query.search) q = q.whereLike('name', `%${req.query.search}%`);
    q = q.orderBy(req.query.sort || 'createdAt', req.query.order || 'desc');
    const authors = await q.exec();
    res.json({ authors });
};

exports.createAuthor = async (req, res) =>
{
    const author = await Author.create(req.body);
    res.status(201).json({ author });
};

exports.deleteAuthor = async (req, res) =>
{
    const author = await Author.findById(Number(req.params.id));
    if (!author) throw new NotFoundError('Author not found');
    await Post.deleteWhere({ authorId: author.id });
    await Author.deleteWhere({ id: author.id });
    res.json({ deleted: true, id: author.id });
};

/* ---- Posts ---- */

exports.listPosts = async (req, res) =>
{
    let q = Post.query();
    if (req.query.authorId) q = q.where('authorId', Number(req.query.authorId));
    if (req.query.category) q = q.scope('byCategory', req.query.category);
    if (req.query.scope === 'published') q = q.scope('published');
    if (req.query.scope === 'drafts') q = q.scope('drafts');
    if (req.query.scope === 'popular') q = q.scope('popular');
    if (req.query.search) q = q.whereLike('title', `%${req.query.search}%`);
    q = q.orderBy(req.query.sort || 'createdAt', req.query.order || 'desc');

    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(50, Math.max(1, Number(req.query.perPage) || 10));
    q = q.page(page, perPage);

    const posts = await q.exec();
    const total = await Post.count();

    const authorIds = [...new Set(posts.map(p => p.authorId))];
    const authors = authorIds.length ? await Author.query().whereIn('id', authorIds).exec() : [];
    const authorMap = Object.fromEntries(authors.map(a => [a.id, a]));

    const enriched = posts.map(p => ({
        ...p.toJSON(),
        authorName: authorMap[p.authorId]?.name || 'Unknown',
    }));

    res.json({ posts: enriched, total, page, perPage, totalPages: Math.ceil(total / perPage) });
};

exports.createPost = async (req, res) =>
{
    const author = await Author.findById(Number(req.body.authorId));
    if (!author) throw new BadRequestError('Author not found');
    const post = await Post.create({ ...req.body, authorId: author.id, views: 0 });
    res.status(201).json({ post });
};

exports.updatePost = async (req, res) =>
{
    const post = await Post.findById(Number(req.params.id));
    if (!post) throw new NotFoundError('Post not found');
    const updates = {};
    if (req.body.title != null) updates.title = req.body.title;
    if (req.body.body != null) updates.body = req.body.body;
    if (req.body.category != null) updates.category = req.body.category;
    if (req.body.status != null) updates.status = req.body.status;
    await post.update(updates);
    res.json({ post });
};

exports.deletePost = async (req, res) =>
{
    const post = await Post.findById(Number(req.params.id));
    if (!post) throw new NotFoundError('Post not found');
    await post.delete();
    res.json({ deleted: true, id: Number(req.params.id) });
};

exports.restorePost = async (req, res) =>
{
    const rows = await Post.query().withDeleted().where('id', '=', Number(req.params.id)).exec();
    const post = rows[0];
    if (!post) throw new NotFoundError('Post not found');
    if (post.restore) await post.restore();
    res.json({ post });
};

exports.incrementViews = async (req, res) =>
{
    const post = await Post.findById(Number(req.params.id));
    if (!post) throw new NotFoundError('Post not found');
    await post.increment('views');
    res.json({ post });
};

/* ---- Aggregates / Stats ---- */

exports.blogStats = async (req, res) =>
{
    const [totalAuthors, totalPosts, published, drafts, archived, avgViews, maxViews, totalViews] = await Promise.all([
        Author.count(),
        Post.count(),
        Post.count({ status: 'published' }),
        Post.count({ status: 'draft' }),
        Post.count({ status: 'archived' }),
        Post.query().avg('views'),
        Post.query().max('views'),
        Post.query().sum('views'),
    ]);

    res.json({
        totalAuthors, totalPosts, published, drafts, archived,
        avgViews: Number(avgViews) || 0,
        maxViews: Number(maxViews) || 0,
        totalViews: Number(totalViews) || 0,
    });
};

/* ---- Seed with Factory + Fake ---- */

class BlogSeeder extends Seeder
{
    async run()
    {
        const authorFactory = new Factory(Author)
            .define({
                name:  () => Fake.fullName(),
                email: () => Fake.email(),
                bio:   () => Fake.sentence(8),
                role:  () => Fake.pick(['author', 'editor', 'admin']),
            });

        const authors = await authorFactory.count(4).create();

        const postFactory = new Factory(Post)
            .define({
                authorId: () => Fake.pick(authors).id,
                title:    () => Fake.sentence(5),
                body:     () => Fake.paragraph(3),
                category: () => Fake.pick(['general', 'tutorial', 'news', 'review']),
                status:   () => Fake.pick(['draft', 'published', 'published', 'published', 'archived']),
                views:    () => Fake.integer(0, 120),
            });

        await postFactory.count(12).create();
    }
}

exports.seed = async (req, res) =>
{
    const existing = await Author.count();
    if (existing > 0) return res.json({ seeded: false, message: 'Data already exists' });

    const runner = new SeederRunner();
    await runner.run(BlogSeeder);

    const [authors, posts] = await Promise.all([Author.count(), Post.count()]);
    res.json({ seeded: true, authors, posts });
};

/* ---- Reset ---- */

exports.reset = async (req, res) =>
{
    const allPosts = await Post.query().withDeleted().exec();
    for (const p of allPosts) { if (p.deletedAt && p.restore) await p.restore(); }
    if (Post._adapter) await Post._adapter.deleteWhere(Post.table, {});
    if (Author._adapter) await Author._adapter.deleteWhere(Author.table, {});
    res.json({ reset: true });
};
