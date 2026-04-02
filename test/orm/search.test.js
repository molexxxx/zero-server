/**
 * Phase 3 — FullTextSearch tests
 */
const { Database, Model, FullTextSearch } = require('../../lib/orm');

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
// Constructor Validation
// ===================================================================
describe('FullTextSearch — constructor', () =>
{
    it('throws without ModelClass', () =>
    {
        expect(() => new FullTextSearch(null, { fields: ['x'] })).toThrow('requires a Model class');
    });

    it('throws without fields', () =>
    {
        expect(() => new FullTextSearch(Model, {})).toThrow('requires at least one field');
    });

    it('throws with empty fields array', () =>
    {
        expect(() => new FullTextSearch(Model, { fields: [] })).toThrow('requires at least one field');
    });

    it('sets defaults', () =>
    {
        const fts = new FullTextSearch(Model, { fields: ['title'] });
        expect(fts._language).toBe('english');
        expect(fts._weights).toEqual({});
        expect(fts._fields).toEqual(['title']);
    });

    it('auto-generates indexName', () =>
    {
        const db = memDb();
        const M = makeModel(db, 'articles', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string' },
            body:  { type: 'string' },
        });
        const fts = new FullTextSearch(M, { fields: ['title', 'body'] });
        expect(fts._indexName).toBe('fts_articles_title_body');
    });

    it('accepts custom indexName', () =>
    {
        const fts = new FullTextSearch(Model, { fields: ['a'], indexName: 'my_idx' });
        expect(fts._indexName).toBe('my_idx');
    });
});

// ===================================================================
// createIndex / dropIndex
// ===================================================================
describe('FullTextSearch — createIndex & dropIndex', () =>
{
    let db, Article, fts;

    beforeEach(async () =>
    {
        db = memDb();
        Article = makeModel(db, 'fts_articles', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
            body:  { type: 'string', default: '' },
        }, { name: 'FtsArticle' });
        await db.sync();
        fts = new FullTextSearch(Article, { fields: ['title', 'body'] });
    });

    it('createIndex returns this for chaining', async () =>
    {
        const result = await fts.createIndex(db);
        expect(result).toBe(fts);
    });

    it('createIndex stores adapter', async () =>
    {
        await fts.createIndex(db);
        expect(fts._adapter).toBe(db.adapter);
    });

    it('createIndex detects adapter type', async () =>
    {
        await fts.createIndex(db);
        expect(typeof fts._adapterType).toBe('string');
    });

    it('dropIndex without adapter throws', async () =>
    {
        const fts2 = new FullTextSearch(Article, { fields: ['title'] });
        await expect(fts2.dropIndex()).rejects.toThrow('No database adapter');
    });

    it('dropIndex with db succeeds', async () =>
    {
        await fts.createIndex(db);
        // Memory adapter has no dropFullTextIndex, so it's a no-op
        await expect(fts.dropIndex(db)).resolves.not.toThrow();
    });
});

// ===================================================================
// search (in-memory fallback)
// ===================================================================
describe('FullTextSearch — search', () =>
{
    let db, Article, fts;

    beforeEach(async () =>
    {
        db = memDb();
        Article = makeModel(db, 'search_art', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
            body:  { type: 'string', default: '' },
        }, { name: 'SearchArt' });
        await db.sync();

        await Article.create({ title: 'JavaScript Basics', body: 'Learn JS fundamentals' });
        await Article.create({ title: 'Node.js Guide', body: 'Server side javascript' });
        await Article.create({ title: 'Python Tutorial', body: 'Learn Python programming' });
        await Article.create({ title: 'CSS Mastery', body: 'Advanced styling techniques' });

        fts = new FullTextSearch(Article, { fields: ['title', 'body'] });
        await fts.createIndex(db);
    });

    it('returns empty for null/empty query', async () =>
    {
        expect(await fts.search(null)).toEqual([]);
        expect(await fts.search('')).toEqual([]);
        expect(await fts.search(42)).toEqual([]);
    });

    it('searches for matching records', async () =>
    {
        const results = await fts.search('javascript');
        expect(results.length).toBe(2);
    });

    it('search is case-insensitive', async () =>
    {
        const results = await fts.search('JAVASCRIPT');
        expect(results.length).toBe(2);
    });

    it('search with rank option', async () =>
    {
        const results = await fts.search('javascript', { rank: true });
        expect(results.length).toBe(2);
        expect(results[0]._rank).toBeDefined();
        expect(results[0]._rank).toBeGreaterThan(0);
    });

    it('results are ranked by score (descending)', async () =>
    {
        // "JavaScript" appears in title+body, "javascript" only in body for Node.js
        const results = await fts.search('javascript', { rank: true });
        expect(results[0]._rank).toBeGreaterThanOrEqual(results[1]._rank);
    });

    it('search with limit', async () =>
    {
        const results = await fts.search('learn', { limit: 1 });
        expect(results.length).toBe(1);
    });

    it('search with offset', async () =>
    {
        const results = await fts.search('learn', { offset: 1 });
        expect(results.length).toBe(1);
    });

    it('search with where conditions', async () =>
    {
        const results = await fts.search('learn', { where: { title: 'Python Tutorial' } });
        expect(results.length).toBe(1);
        expect(results[0].title).toBe('Python Tutorial');
    });

    it('search with no matches returns empty', async () =>
    {
        const results = await fts.search('rust blockchain');
        expect(results).toEqual([]);
    });

    it('search with special regex chars does not crash', async () =>
    {
        const results = await fts.search('node.js');
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('multi-word query matches tokens independently', async () =>
    {
        const results = await fts.search('learn fundamentals');
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('search throws without registered model', async () =>
    {
        const M = class extends Model { static table = 'ghost'; };
        const fts2 = new FullTextSearch(M, { fields: ['x'] });
        await expect(fts2.search('test')).rejects.toThrow();
    });
});

// ===================================================================
// searchModels
// ===================================================================
describe('FullTextSearch — searchModels', () =>
{
    let db, Article, fts;

    beforeEach(async () =>
    {
        db = memDb();
        Article = makeModel(db, 'sm_art', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
        }, { name: 'SmArt' });
        await db.sync();

        await Article.create({ title: 'JavaScript' });
        await Article.create({ title: 'TypeScript' });

        fts = new FullTextSearch(Article, { fields: ['title'] });
        await fts.createIndex(db);
    });

    it('returns model instances', async () =>
    {
        const results = await fts.searchModels('Script');
        expect(results.length).toBe(2);
        expect(results[0].id).toBeDefined();
    });

    it('includes _rank when rank=true', async () =>
    {
        const results = await fts.searchModels('Script', { rank: true });
        expect(results[0]._rank).toBeDefined();
    });
});

// ===================================================================
// count
// ===================================================================
describe('FullTextSearch — count', () =>
{
    let db, Article, fts;

    beforeEach(async () =>
    {
        db = memDb();
        Article = makeModel(db, 'cnt_art', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
            body:  { type: 'string', default: '' },
        }, { name: 'CntArt' });
        await db.sync();

        await Article.create({ title: 'JavaScript', body: 'JS stuff' });
        await Article.create({ title: 'Python', body: 'Py stuff' });

        fts = new FullTextSearch(Article, { fields: ['title', 'body'] });
        await fts.createIndex(db);
    });

    it('returns count of matching results', async () =>
    {
        const c = await fts.count('javascript');
        expect(c).toBe(1);
    });

    it('returns 0 for no matches', async () =>
    {
        const c = await fts.count('rust');
        expect(c).toBe(0);
    });
});

// ===================================================================
// suggest
// ===================================================================
describe('FullTextSearch — suggest', () =>
{
    let db, Article, fts;

    beforeEach(async () =>
    {
        db = memDb();
        Article = makeModel(db, 'sug_art', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
            body:  { type: 'string', default: '' },
        }, { name: 'SugArt' });
        await db.sync();

        await Article.create({ title: 'JavaScript Basics', body: 'Learn JS' });
        await Article.create({ title: 'Java Programming', body: 'Enterprise Java' });
        await Article.create({ title: 'Javelin Sports', body: 'Olympic event' });

        fts = new FullTextSearch(Article, { fields: ['title', 'body'] });
        await fts.createIndex(db);
    });

    it('returns empty for null/empty prefix', async () =>
    {
        expect(await fts.suggest(null)).toEqual([]);
        expect(await fts.suggest('')).toEqual([]);
        expect(await fts.suggest(42)).toEqual([]);
    });

    it('returns matching suggestions', async () =>
    {
        const results = await fts.suggest('jav');
        expect(results.length).toBeGreaterThanOrEqual(2);
        for (const s of results)
        {
            expect(s.toLowerCase().startsWith('jav')).toBe(true);
        }
    });

    it('respects limit', async () =>
    {
        const results = await fts.suggest('jav', { limit: 1 });
        expect(results.length).toBe(1);
    });

    it('suggests from specific field', async () =>
    {
        const results = await fts.suggest('learn', { field: 'body' });
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('deduplicates suggestions', async () =>
    {
        const results = await fts.suggest('jav');
        const lower = results.map(r => r.toLowerCase());
        const unique = [...new Set(lower)];
        expect(lower.length).toBe(unique.length);
    });

    it('suggest throws without registered model', async () =>
    {
        const M = class extends Model { static table = 'ghost2'; };
        const fts2 = new FullTextSearch(M, { fields: ['x'] });
        await expect(fts2.suggest('test')).rejects.toThrow();
    });
});

// ===================================================================
// _getWeight
// ===================================================================
describe('FullTextSearch — _getWeight', () =>
{
    it('returns 1 for unweighted field', () =>
    {
        const fts = new FullTextSearch(Model, { fields: ['a'] });
        expect(fts._getWeight('a')).toBe(1);
    });

    it('returns PostgreSQL-style numeric: A=4 B=3 C=2 D=1', () =>
    {
        const fts = new FullTextSearch(Model, {
            fields: ['a', 'b', 'c', 'd'],
            weights: { a: 'A', b: 'B', c: 'C', d: 'D' },
        });
        expect(fts._getWeight('a')).toBe(4);
        expect(fts._getWeight('b')).toBe(3);
        expect(fts._getWeight('c')).toBe(2);
        expect(fts._getWeight('d')).toBe(1);
    });

    it('handles lowercase weight letters', () =>
    {
        const fts = new FullTextSearch(Model, {
            fields: ['x'],
            weights: { x: 'a' },
        });
        expect(fts._getWeight('x')).toBe(4);
    });

    it('returns 1 for unknown weight letter', () =>
    {
        const fts = new FullTextSearch(Model, {
            fields: ['x'],
            weights: { x: 'Z' },
        });
        expect(fts._getWeight('x')).toBe(1);
    });

    it('returns numeric weight as-is', () =>
    {
        const fts = new FullTextSearch(Model, {
            fields: ['a'],
            weights: { a: 5 },
        });
        expect(fts._getWeight('a')).toBe(5);
    });

    it('returns 1 for NaN numeric weight', () =>
    {
        const fts = new FullTextSearch(Model, {
            fields: ['a'],
            weights: { a: NaN },
        });
        expect(fts._getWeight('a')).toBe(1);
    });
});

// ===================================================================
// _detectAdapterType
// ===================================================================
describe('FullTextSearch — _detectAdapterType', () =>
{
    it('returns memory when no adapter set', () =>
    {
        const fts = new FullTextSearch(Model, { fields: ['a'] });
        expect(fts._detectAdapterType()).toBe('memory');
    });

    it('detects memory adapter type', async () =>
    {
        const db = memDb();
        const M = makeModel(db, 'dt_art', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string' },
        }, { name: 'DtArt' });
        await db.sync();
        const fts = new FullTextSearch(M, { fields: ['title'] });
        await fts.createIndex(db);
        expect(typeof fts._adapterType).toBe('string');
    });
});

// ===================================================================
// Weighted search ranking
// ===================================================================
describe('FullTextSearch — weighted search', () =>
{
    let db, Article, fts;

    beforeEach(async () =>
    {
        db = memDb();
        Article = makeModel(db, 'w_art', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
            body:  { type: 'string', default: '' },
        }, { name: 'WArt' });
        await db.sync();

        // "search" appears in title for article 1, body for article 2
        await Article.create({ title: 'Search Engine', body: 'Build web apps' });
        await Article.create({ title: 'Web Development', body: 'Search optimization' });

        fts = new FullTextSearch(Article, {
            fields: ['title', 'body'],
            weights: { title: 'A', body: 'D' },
        });
        await fts.createIndex(db);
    });

    it('title-weighted match ranks higher than body-weighted', async () =>
    {
        const results = await fts.search('search', { rank: true });
        expect(results.length).toBe(2);
        // Title weight=A=4, body weight=D=1
        expect(results[0].title).toBe('Search Engine');
    });
});

// ===================================================================
// _memorySearch — empty tokens
// ===================================================================
describe('FullTextSearch — _memorySearch edge cases', () =>
{
    let db, Article, fts;

    beforeEach(async () =>
    {
        db = memDb();
        Article = makeModel(db, 'ms_art', {
            id:    { type: 'integer', primaryKey: true, autoIncrement: true },
            title: { type: 'string', required: true },
            body:  { type: 'string', nullable: true },
        }, { name: 'MsArt' });
        await db.sync();
        await Article.create({ title: 'Hello World', body: null });
        fts = new FullTextSearch(Article, { fields: ['title', 'body'] });
        await fts.createIndex(db);
    });

    it('handles null field values gracefully', async () =>
    {
        const results = await fts.search('hello');
        expect(results.length).toBe(1);
    });

    it('query of only whitespace returns empty', async () =>
    {
        const results = await fts.search('   ');
        expect(results).toEqual([]);
    });

    it('search with rank=false omits _rank', async () =>
    {
        const results = await fts.search('hello', { rank: false });
        expect(results[0]._rank).toBeUndefined();
    });
});
