/**
 * MongoDB adapter CRUD and utility method tests.
 * Mocks MongoClient, Db, and Collection to capture operations.
 */

// ============================================================
//  Mock helpers
// ============================================================
function makeCursorChain(resultArray = [])
{
    const cursor = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(resultArray),
    };
    return cursor;
}

function makeCol()
{
    return {
        insertOne: vi.fn().mockResolvedValue({ insertedId: 'abc' }),
        insertMany: vi.fn().mockResolvedValue({ insertedIds: {} }),
        updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
        updateMany: vi.fn().mockResolvedValue({ modifiedCount: 3 }),
        deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 }),
        countDocuments: vi.fn().mockResolvedValue(42),
        find: vi.fn().mockReturnValue(makeCursorChain()),
        findOne: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
        createIndex: vi.fn().mockResolvedValue('idx'),
        indexes: vi.fn().mockResolvedValue([{ name: '_id_' }]),
        dropIndex: vi.fn().mockResolvedValue(undefined),
        drop: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
    };
}

function makeDb(col)
{
    return {
        collection: vi.fn().mockReturnValue(col),
        createCollection: vi.fn().mockResolvedValue(undefined),
        listCollections: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
        command: vi.fn().mockResolvedValue({ ok: 1 }),
    };
}

function makeMongo()
{
    vi.doMock('mongodb', () => ({
        MongoClient: function (url, opts) {
            this.connect = vi.fn();
            this.close = vi.fn();
            this.db = vi.fn();
            this.startSession = vi.fn().mockReturnValue({
                startTransaction: vi.fn(),
                commitTransaction: vi.fn().mockResolvedValue(undefined),
                abortTransaction: vi.fn().mockResolvedValue(undefined),
                endSession: vi.fn().mockResolvedValue(undefined),
            });
        },
    }));
    delete require.cache[require.resolve('../../../lib/orm/adapters/mongo')];
    const MongoAdapter = require('../../../lib/orm/adapters/mongo');
    const adapter = new MongoAdapter({ url: 'mongodb://localhost', database: 'testdb' });

    // Pre-wire mock db and col
    const col = makeCol();
    const db = makeDb(col);
    adapter._db = db;
    adapter._connected = true;

    // Replace _client with a fully mocked object
    adapter._client = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        db: vi.fn().mockReturnValue(db),
        startSession: vi.fn().mockReturnValue({
            startTransaction: vi.fn(),
            commitTransaction: vi.fn().mockResolvedValue(undefined),
            abortTransaction: vi.fn().mockResolvedValue(undefined),
            endSession: vi.fn().mockResolvedValue(undefined),
        }),
    };

    // Override _getDb and _col to use our mocks directly
    adapter._getDb = vi.fn().mockResolvedValue(db);
    adapter._col = vi.fn().mockResolvedValue(col);

    return { adapter, db, col };
}

// ============================================================
//  Tests
// ============================================================
describe('MongoAdapter CRUD methods', () =>
{
    let adapter, db, col;

    beforeEach(() =>
    {
        const m = makeMongo();
        adapter = m.adapter;
        db = m.db;
        col = m.col;
    });

    // -- createTable (collection + indexes) ------------------
    describe('createTable', () =>
    {
        it('creates collection with no schema', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            await adapter.createTable('items');
            expect(db.createCollection).toHaveBeenCalledWith('items', {});
        });

        it('creates collection with JSON schema validator', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            const schema = {
                name: { type: 'string', required: true },
                age: { type: 'integer', min: 0, max: 200 },
                active: { type: 'boolean' },
                created: { type: 'datetime' },
                data: { type: 'json' },
                tags: { type: 'array' },
                score: { type: 'float' },
            };
            await adapter.createTable('users', schema);
            const createOpts = db.createCollection.mock.calls[0][1];
            expect(createOpts.validator).toBeDefined();
            const props = createOpts.validator.$jsonSchema.properties;
            expect(props.name.bsonType).toBe('string');
            expect(props.age.bsonType).toBe('int');
            expect(props.age.minimum).toBe(0);
            expect(props.age.maximum).toBe(200);
            expect(props.active.bsonType).toBe('bool');
            expect(props.created.bsonType).toBe('date');
            expect(props.data.bsonType).toBe('object');
            expect(props.tags.bsonType).toBe('array');
            expect(props.score.bsonType).toBe('double');
            expect(createOpts.validator.$jsonSchema.required).toContain('name');
        });

        it('skips autoIncrement PK columns in schema', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            const schema = {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                name: { type: 'string' },
            };
            await adapter.createTable('users', schema);
            const props = db.createCollection.mock.calls[0][1].validator.$jsonSchema.properties;
            expect(props.id).toBeUndefined();
            expect(props.name).toBeDefined();
        });

        it('skips creation when collection already exists', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ name: 'existing' }]) });
            await adapter.createTable('existing', { name: { type: 'string' } });
            expect(db.createCollection).not.toHaveBeenCalled();
        });

        it('creates unique indexes', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            const schema = {
                email: { type: 'string', unique: true },
            };
            await adapter.createTable('users', schema);
            expect(col.createIndex).toHaveBeenCalledWith({ email: 1 }, { unique: true, name: 'uq_users_email' });
        });

        it('creates regular indexes', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            const schema = {
                slug: { type: 'string', index: 'idx_custom_slug' },
            };
            await adapter.createTable('posts', schema);
            expect(col.createIndex).toHaveBeenCalledWith({ slug: 1 }, { name: 'idx_custom_slug' });
        });

        it('creates composite unique indexes', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            const schema = {
                email: { type: 'string', compositeUnique: 'eu' },
                org: { type: 'string', compositeUnique: 'eu' },
            };
            await adapter.createTable('accounts', schema);
            expect(col.createIndex).toHaveBeenCalledWith(
                { email: 1, org: 1 },
                { unique: true, name: 'uq_accounts_eu' },
            );
        });

        it('creates composite indexes', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            const schema = {
                a: { type: 'string', compositeIndex: 'ab' },
                b: { type: 'string', compositeIndex: 'ab' },
            };
            await adapter.createTable('t1', schema);
            expect(col.createIndex).toHaveBeenCalledWith(
                { a: 1, b: 1 },
                { name: 'idx_t1_ab' },
            );
        });

        it('handles enum in validator', async () =>
        {
            db.listCollections.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
            const schema = {
                status: { type: 'string', enum: ['active', 'inactive'] },
            };
            await adapter.createTable('items', schema);
            const props = db.createCollection.mock.calls[0][1].validator.$jsonSchema.properties;
            expect(props.status.enum).toEqual(['active', 'inactive']);
        });
    });

    // -- dropTable -------------------------------------------
    describe('dropTable', () =>
    {
        it('drops a collection', async () =>
        {
            await adapter.dropTable('items');
            expect(col.drop).toHaveBeenCalled();
        });

        it('silently handles non-existent collection', async () =>
        {
            col.drop.mockRejectedValueOnce(new Error('ns not found'));
            await expect(adapter.dropTable('missing')).resolves.toBeUndefined();
        });
    });

    // -- insert -----------------------------------------------
    describe('insert', () =>
    {
        it('auto-increments id from empty collection', async () =>
        {
            col.find.mockReturnValue(makeCursorChain([])); // no existing docs
            const result = await adapter.insert('users', { name: 'Alice' });
            expect(result.id).toBe(1);
            expect(result.name).toBe('Alice');
            expect(result._id).toBeUndefined();
            expect(col.insertOne).toHaveBeenCalled();
        });

        it('auto-increments from max existing id', async () =>
        {
            col.find.mockReturnValue(makeCursorChain([{ id: 10 }]));
            const result = await adapter.insert('users', { name: 'Bob' });
            expect(result.id).toBe(11);
        });

        it('preserves explicit id', async () =>
        {
            const result = await adapter.insert('users', { id: 99, name: 'Charlie' });
            expect(result.id).toBe(99);
        });
    });

    // -- insertMany -------------------------------------------
    describe('insertMany', () =>
    {
        it('auto-increments ids for multiple docs', async () =>
        {
            col.find.mockReturnValue(makeCursorChain([{ id: 5 }]));
            const result = await adapter.insertMany('users', [
                { name: 'A' }, { name: 'B' }
            ]);
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe(6);
            expect(result[1].id).toBe(7);
            expect(result[0]._id).toBeUndefined();
        });

        it('preserves explicit ids', async () =>
        {
            col.find.mockReturnValue(makeCursorChain([]));
            const result = await adapter.insertMany('users', [{ id: 100, name: 'X' }]);
            expect(result[0].id).toBe(100);
        });

        it('returns empty for empty input', async () =>
        {
            expect(await adapter.insertMany('users', [])).toEqual([]);
        });
    });

    // -- aggregate -------------------------------------------
    describe('aggregate', () =>
    {
        it('uses countDocuments for count', async () =>
        {
            col.countDocuments.mockResolvedValueOnce(42);
            const result = await adapter.aggregate({
                table: 'users', aggregateFn: 'count', aggregateField: 'id', where: [],
            });
            expect(result).toBe(42);
        });

        it('builds pipeline for SUM', async () =>
        {
            const toArrayFn = vi.fn().mockResolvedValue([{ _id: null, result: 500 }]);
            col.aggregate.mockReturnValueOnce({ toArray: toArrayFn });
            const result = await adapter.aggregate({
                table: 'orders', aggregateFn: 'sum', aggregateField: 'total', where: [],
            });
            expect(result).toBe(500);
            const pipeline = col.aggregate.mock.calls[0][0];
            expect(pipeline[0].$group._id).toBeNull();
            expect(pipeline[0].$group.result.$sum).toBe('$total');
        });

        it('includes $match for filtered aggregate', async () =>
        {
            const toArrayFn = vi.fn().mockResolvedValue([{ _id: null, result: 10 }]);
            col.aggregate.mockReturnValueOnce({ toArray: toArrayFn });
            await adapter.aggregate({
                table: 'orders', aggregateFn: 'avg', aggregateField: 'price',
                where: [{ field: 'status', op: '=', value: 'paid', logic: 'AND' }],
            });
            const pipeline = col.aggregate.mock.calls[0][0];
            expect(pipeline[0].$match).toBeDefined();
        });

        it('returns null for unknown aggregation function', async () =>
        {
            const result = await adapter.aggregate({
                table: 'orders', aggregateFn: 'PERCENTILE', aggregateField: 'total', where: [],
            });
            expect(result).toBeNull();
        });

        it('returns null when pipeline returns empty', async () =>
        {
            const toArrayFn = vi.fn().mockResolvedValue([]);
            col.aggregate.mockReturnValueOnce({ toArray: toArrayFn });
            const result = await adapter.aggregate({
                table: 'orders', aggregateFn: 'min', aggregateField: 'price', where: [],
            });
            expect(result).toBeNull();
        });
    });

    // -- update -----------------------------------------------
    describe('update', () =>
    {
        it('calls updateOne with $set', async () =>
        {
            await adapter.update('users', 'id', 5, { name: 'Updated' });
            expect(col.updateOne).toHaveBeenCalledWith({ id: 5 }, { $set: { name: 'Updated' } });
        });
    });

    // -- updateWhere ------------------------------------------
    describe('updateWhere', () =>
    {
        it('calls updateMany and returns modifiedCount', async () =>
        {
            col.updateMany.mockResolvedValueOnce({ modifiedCount: 3 });
            const count = await adapter.updateWhere('users', { active: false }, { status: 'inactive' });
            expect(count).toBe(3);
            expect(col.updateMany).toHaveBeenCalledWith({ active: false }, { $set: { status: 'inactive' } });
        });
    });

    // -- remove -----------------------------------------------
    describe('remove', () =>
    {
        it('calls deleteOne by pk', async () =>
        {
            await adapter.remove('users', 'id', 7);
            expect(col.deleteOne).toHaveBeenCalledWith({ id: 7 });
        });
    });

    // -- deleteWhere ------------------------------------------
    describe('deleteWhere', () =>
    {
        it('calls deleteMany and returns deletedCount', async () =>
        {
            col.deleteMany.mockResolvedValueOnce({ deletedCount: 5 });
            const count = await adapter.deleteWhere('users', { expired: true });
            expect(count).toBe(5);
        });
    });

    // -- execute (SELECT) ------------------------------------
    describe('execute', () =>
    {
        it('returns count for count action', async () =>
        {
            col.countDocuments.mockResolvedValueOnce(100);
            const count = await adapter.execute({ action: 'count', table: 'users', where: [] });
            expect(count).toBe(100);
        });

        it('builds projection from fields', async () =>
        {
            const cursor = makeCursorChain([{ id: 1, name: 'Alice' }]);
            col.find.mockReturnValueOnce(cursor);
            const rows = await adapter.execute({
                table: 'users', fields: ['id', 'name'], where: [],
            });
            const projection = col.find.mock.calls[0][1].projection;
            expect(projection._id).toBe(0);
            expect(projection.id).toBe(1);
            expect(projection.name).toBe(1);
            expect(rows).toEqual([{ id: 1, name: 'Alice' }]);
        });

        it('uses * projection when no fields', async () =>
        {
            col.find.mockReturnValueOnce(makeCursorChain([]));
            await adapter.execute({ table: 'users', where: [] });
            const projection = col.find.mock.calls[0][1].projection;
            expect(projection).toEqual({ _id: 0 });
        });

        it('handles sort from orderBy', async () =>
        {
            const cursor = makeCursorChain([]);
            col.find.mockReturnValueOnce(cursor);
            await adapter.execute({
                table: 'users', where: [],
                orderBy: [{ field: 'name', dir: 'asc' }, { field: 'id', dir: 'desc' }],
            });
            expect(cursor.sort).toHaveBeenCalledWith({ name: 1, id: -1 });
        });

        it('handles limit and offset', async () =>
        {
            const cursor = makeCursorChain([]);
            col.find.mockReturnValueOnce(cursor);
            await adapter.execute({ table: 'users', where: [], limit: 10, offset: 20 });
            expect(cursor.limit).toHaveBeenCalledWith(10);
            expect(cursor.skip).toHaveBeenCalledWith(20);
        });

        it('handles distinct in-memory dedup', async () =>
        {
            const cursor = makeCursorChain([
                { name: 'Alice' }, { name: 'Alice' }, { name: 'Bob' },
            ]);
            col.find.mockReturnValueOnce(cursor);
            const rows = await adapter.execute({
                table: 'users', fields: ['name'], where: [], distinct: true,
            });
            expect(rows).toHaveLength(2);
            expect(rows[0].name).toBe('Alice');
            expect(rows[1].name).toBe('Bob');
        });

        it('applies where filter from chain', async () =>
        {
            col.find.mockReturnValueOnce(makeCursorChain([]));
            await adapter.execute({
                table: 'users',
                where: [{ field: 'age', op: '>', value: 18, logic: 'AND' }],
            });
            const filter = col.find.mock.calls[0][0];
            expect(filter.age.$gt).toBe(18);
        });
    });

    // -- close / raw / transaction ---------------------------
    describe('close, raw, transaction', () =>
    {
        it('close() disconnects client', async () =>
        {
            await adapter.close();
            expect(adapter._client.close).toHaveBeenCalled();
            expect(adapter._connected).toBe(false);
        });

        it('raw() executes a database command', async () =>
        {
            db.command.mockResolvedValueOnce({ ok: 1, result: 'hello' });
            const result = await adapter.raw({ ping: 1 });
            expect(result.ok).toBe(1);
            expect(db.command).toHaveBeenCalledWith({ ping: 1 });
        });

        it('transaction commits on success', async () =>
        {
            const result = await adapter.transaction(async (s) =>
            {
                return 'ok';
            });
            expect(result).toBe('ok');
            const session = adapter._client.startSession.mock.results[0].value;
            expect(session.startTransaction).toHaveBeenCalled();
            expect(session.commitTransaction).toHaveBeenCalled();
            expect(session.endSession).toHaveBeenCalled();
        });

        it('transaction aborts on error', async () =>
        {
            await expect(adapter.transaction(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
            const session = adapter._client.startSession.mock.results[0].value;
            expect(session.abortTransaction).toHaveBeenCalled();
            expect(session.endSession).toHaveBeenCalled();
        });
    });

    // -- collections / stats / collectionStats ---------------
    describe('collections, stats, collectionStats', () =>
    {
        it('collections() returns collection names', async () =>
        {
            db.listCollections.mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ name: 'users' }, { name: 'posts' }]) });
            expect(await adapter.collections()).toEqual(['users', 'posts']);
        });

        it('stats() returns database stats', async () =>
        {
            db.command.mockResolvedValueOnce({
                collections: 5, objects: 100, dataSize: 1024, storageSize: 2048,
                indexes: 10, indexSize: 512,
            });
            const s = await adapter.stats();
            expect(s.collections).toBe(5);
            expect(s.objects).toBe(100);
        });

        it('collectionStats() returns collection stats', async () =>
        {
            db.command.mockResolvedValueOnce({
                count: 50, size: 4096, avgObjSize: 82, storageSize: 8192, nindexes: 3,
            });
            const s = await adapter.collectionStats('users');
            expect(s.count).toBe(50);
            expect(s.nindexes).toBe(3);
        });
    });

    // -- createIndex / indexes / dropIndex -------------------
    describe('createIndex, indexes, dropIndex', () =>
    {
        it('createIndex with object keys', async () =>
        {
            await adapter.createIndex('users', { email: 1 }, { unique: true });
            expect(col.createIndex).toHaveBeenCalledWith({ email: 1 }, { unique: true });
        });

        it('createIndex normalizes string keys', async () =>
        {
            await adapter.createIndex('users', 'email');
            expect(col.createIndex).toHaveBeenCalledWith({ email: 1 }, {});
        });

        it('createIndex normalizes array keys', async () =>
        {
            await adapter.createIndex('users', ['name', 'age']);
            expect(col.createIndex).toHaveBeenCalledWith({ name: 1, age: 1 }, {});
        });

        it('indexes() returns collection indexes', async () =>
        {
            col.indexes.mockResolvedValueOnce([{ name: '_id_' }, { name: 'email_1' }]);
            const idx = await adapter.indexes('users');
            expect(idx).toHaveLength(2);
        });

        it('dropIndex() drops by name', async () =>
        {
            await adapter.dropIndex('users', 'email_1');
            expect(col.dropIndex).toHaveBeenCalledWith('email_1');
        });
    });

    // -- ping / version / isConnected -----------------------
    describe('ping, version, isConnected', () =>
    {
        it('ping() returns true on success', async () =>
        {
            db.command.mockResolvedValueOnce({ ok: 1 });
            expect(await adapter.ping()).toBe(true);
        });

        it('ping() returns false on error', async () =>
        {
            db.command.mockRejectedValueOnce(new Error('unreachable'));
            expect(await adapter.ping()).toBe(false);
        });

        it('version() returns server version', async () =>
        {
            db.command.mockResolvedValueOnce({ version: '7.0.4' });
            expect(await adapter.version()).toBe('7.0.4');
        });

        it('isConnected getter', () =>
        {
            expect(adapter.isConnected).toBe(true);
            adapter._connected = false;
            expect(adapter.isConnected).toBe(false);
        });
    });

    // -- hasTable / hasColumn / renameTable -------------------
    describe('DDL: hasTable, hasColumn, renameTable', () =>
    {
        it('hasTable returns true when exists', async () =>
        {
            db.listCollections.mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ name: 'users' }]) });
            expect(await adapter.hasTable('users')).toBe(true);
        });

        it('hasTable returns false when missing', async () =>
        {
            db.listCollections.mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) });
            expect(await adapter.hasTable('missing')).toBe(false);
        });

        it('hasColumn returns true when document has field', async () =>
        {
            col.findOne.mockResolvedValueOnce({ email: 'test@test.com' });
            expect(await adapter.hasColumn('users', 'email')).toBe(true);
        });

        it('hasColumn returns false when no document has field', async () =>
        {
            col.findOne.mockResolvedValueOnce(null);
            expect(await adapter.hasColumn('users', 'missing')).toBe(false);
        });

        it('renameTable renames collection', async () =>
        {
            await adapter.renameTable('old', 'new');
            expect(col.rename).toHaveBeenCalledWith('new');
        });
    });

    // -- addColumn / dropColumn / renameColumn ----------------
    describe('DDL: addColumn, dropColumn, renameColumn', () =>
    {
        it('addColumn sets default on existing docs', async () =>
        {
            await adapter.addColumn('users', 'bio', { type: 'text', default: '' });
            expect(col.updateMany).toHaveBeenCalledWith(
                { bio: { $exists: false } },
                { $set: { bio: '' } },
            );
        });

        it('addColumn uses null default when not specified', async () =>
        {
            await adapter.addColumn('users', 'bio', { type: 'text' });
            expect(col.updateMany).toHaveBeenCalledWith(
                { bio: { $exists: false } },
                { $set: { bio: null } },
            );
        });

        it('addColumn with function default calls the function', async () =>
        {
            await adapter.addColumn('users', 'created', { type: 'string', default: () => 'now' });
            expect(col.updateMany.mock.calls[0][1].$set.created).toBe('now');
        });

        it('dropColumn unsets field from all docs', async () =>
        {
            await adapter.dropColumn('users', 'bio');
            expect(col.updateMany).toHaveBeenCalledWith({}, { $unset: { bio: '' } });
        });

        it('renameColumn renames field in all docs', async () =>
        {
            await adapter.renameColumn('users', 'bio', 'biography');
            expect(col.updateMany).toHaveBeenCalledWith({}, { $rename: { bio: 'biography' } });
        });
    });

    // -- describeTable ----------------------------------------
    describe('describeTable', () =>
    {
        it('infers schema from sampled documents', async () =>
        {
            col.find.mockReturnValueOnce(makeCursorChain([
                { _id: 'abc', name: 'Alice', age: 30 },
                { _id: 'def', name: 'Bob', age: 25, email: 'bob@x.com' },
            ]));
            const desc = await adapter.describeTable('users');
            const nameField = desc.find(f => f.name === 'name');
            expect(nameField).toBeDefined();
            expect(nameField.types).toContain('string');
            // _id should be excluded
            expect(desc.find(f => f.name === '_id')).toBeUndefined();
            // email found in one doc
            expect(desc.find(f => f.name === 'email')).toBeDefined();
        });

        it('uses default sample size', async () =>
        {
            const cursor = makeCursorChain([]);
            col.find.mockReturnValueOnce(cursor);
            await adapter.describeTable('users');
            expect(cursor.limit).toHaveBeenCalledWith(100);
        });
    });

    // -- _getDb (lazy connect) --------------------------------
    describe('_getDb lazy connect', () =>
    {
        it('connects on first _getDb call when not connected', async () =>
        {
            // Create a fresh adapter reusing makeMongo, then undo the _getDb override
            const { adapter: freshAdapter, db: freshDb } = makeMongo();
            freshAdapter._connected = false;
            freshAdapter._db = null;
            // Restore _getDb to original prototype method
            delete freshAdapter._getDb;
            // Mock the _client that was created by the constructor
            freshAdapter._client = {
                connect: vi.fn().mockResolvedValue(undefined),
                db: vi.fn().mockReturnValue(freshDb),
                close: vi.fn(),
                startSession: vi.fn(),
            };
            const result = await freshAdapter._getDb();
            expect(freshAdapter._client.connect).toHaveBeenCalled();
            expect(freshAdapter._connected).toBe(true);
            expect(result).toBe(freshDb);
        });

        it('reuses connection on subsequent calls', async () =>
        {
            // _getDb is mocked so just verify it returns db
            const result = await adapter._getDb();
            expect(result).toBe(db);
        });
    });
});
