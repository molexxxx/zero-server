/**
 * @module orm/adapters/mongo
 * @description MongoDB adapter using the optional `mongodb` driver.
 *              Requires: `npm install mongodb`
 *
 * @example
 *   const db = Database.connect('mongo', {
 *       url: 'mongodb://localhost:27017',
 *       database: 'myapp',
 *   });
 */

class MongoAdapter
{
    /**
     * @param {object}  options
     * @param {string}  [options.url='mongodb://127.0.0.1:27017'] - Connection string.
     * @param {string}  options.database                         - Database name.
     * @param {number}  [options.maxPoolSize=10]                 - Max connection pool size.
     * @param {number}  [options.minPoolSize=0]                  - Min connection pool size.
     * @param {number}  [options.connectTimeoutMS=10000]         - Connection timeout.
     * @param {number}  [options.socketTimeoutMS=0]              - Socket timeout (0 = no limit).
     * @param {number}  [options.serverSelectionTimeoutMS=30000] - Server selection timeout.
     * @param {boolean} [options.retryWrites=true]               - Retry writes on network errors.
     * @param {boolean} [options.retryReads=true]                - Retry reads on network errors.
     * @param {string}  [options.authSource]                     - Auth database name.
     * @param {string}  [options.replicaSet]                     - Replica set name.
     * @param {object}  [options.clientOptions]                  - Extra MongoClient options (passed directly).
     */
    constructor(options = {})
    {
        let mongodb;
        try { mongodb = require('mongodb'); }
        catch (e)
        {
            throw new Error(
                'MongoDB adapter requires "mongodb" package.\n' +
                'Install it with: npm install mongodb'
            );
        }

        const url = options.url || 'mongodb://127.0.0.1:27017';
        this._client = new mongodb.MongoClient(url, {
            maxPoolSize: options.maxPoolSize || 10,
            ...options.clientOptions,
        });
        this._dbName = options.database;
        this._db = null;
        this._connected = false;
    }

    /**
     * Ensure client is connected and return the database handle.
     * @returns {Promise<import('mongodb').Db>}
     * @private
     */
    async _getDb()
    {
        if (!this._connected)
        {
            await this._client.connect();
            this._connected = true;
            this._db = this._client.db(this._dbName);
        }
        return this._db;
    }

    /** @private */
    _col(table) { return this._getDb().then(db => db.collection(table)); }

    // -- DDL ---------------------------------------------

    async createTable(table /*, schema */)
    {
        const db = await this._getDb();
        const existing = await db.listCollections({ name: table }).toArray();
        if (existing.length === 0) await db.createCollection(table);
    }

    async dropTable(table)
    {
        const db = await this._getDb();
        try { await db.collection(table).drop(); } catch (e) { /* ignore if not exists */ }
    }

    // -- CRUD --------------------------------------------

    async insert(table, data)
    {
        const col = await this._col(table);
        // Handle auto-increment for numeric id columns
        if (data.id === undefined || data.id === null)
        {
            const last = await col.find().sort({ id: -1 }).limit(1).toArray();
            data.id = last.length > 0 ? (last[0].id || 0) + 1 : 1;
        }
        const doc = { ...data };
        await col.insertOne(doc);
        // Remove internal _id, return clean object
        delete doc._id;
        return doc;
    }

    async update(table, pk, pkVal, data)
    {
        const col = await this._col(table);
        await col.updateOne({ [pk]: pkVal }, { $set: data });
    }

    async updateWhere(table, conditions, data)
    {
        const col = await this._col(table);
        const filter = this._buildFilter(conditions);
        const result = await col.updateMany(filter, { $set: data });
        return result.modifiedCount;
    }

    async remove(table, pk, pkVal)
    {
        const col = await this._col(table);
        await col.deleteOne({ [pk]: pkVal });
    }

    async deleteWhere(table, conditions)
    {
        const col = await this._col(table);
        const filter = this._buildFilter(conditions);
        const result = await col.deleteMany(filter);
        return result.deletedCount;
    }

    // -- Query execution ---------------------------------

    async execute(descriptor)
    {
        const { action, table, fields, where, orderBy, limit, offset, distinct } = descriptor;
        const col = await this._col(table);

        const filter = this._buildFilterFromChain(where);

        if (action === 'count')
        {
            return col.countDocuments(filter);
        }

        // Projection
        const projection = { _id: 0 };
        if (fields && fields.length > 0)
        {
            for (const f of fields) projection[f] = 1;
        }

        let cursor = col.find(filter, { projection });

        // Sort
        if (orderBy && orderBy.length > 0)
        {
            const sort = {};
            for (const o of orderBy) sort[o.field] = o.dir === 'desc' ? -1 : 1;
            cursor = cursor.sort(sort);
        }

        if (offset) cursor = cursor.skip(offset);
        if (limit) cursor = cursor.limit(limit);

        let results = await cursor.toArray();

        // Distinct — in-memory since MongoDB distinct() only returns values for a single field
        if (distinct && fields && fields.length > 0)
        {
            const seen = new Set();
            results = results.filter(row =>
            {
                const key = JSON.stringify(fields.map(f => row[f]));
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        return results;
    }

    // -- Filter builders ---------------------------------

    /**
     * Build a MongoDB filter from simple { key: value } conditions.
     * @param {object} conditions
     * @returns {object}
     * @private
     */
    _buildFilter(conditions)
    {
        if (!conditions || Object.keys(conditions).length === 0) return {};
        const filter = {};
        for (const [k, v] of Object.entries(conditions))
        {
            filter[k] = v === null ? null : v;
        }
        return filter;
    }

    /**
     * Build a MongoDB filter from Query builder where chain.
     * @param {Array} where
     * @returns {object}
     * @private
     */
    _buildFilterFromChain(where)
    {
        if (!where || where.length === 0) return {};

        const andParts = [];
        let currentOr = [];

        for (let i = 0; i < where.length; i++)
        {
            const w = where[i];
            // Skip raw SQL clauses — not applicable to MongoDB
            if (w.raw) continue;
            const { field, op, value, logic } = w;
            const clause = this._opToMongo(field, op, value);

            if (i === 0 || logic === 'AND')
            {
                if (currentOr.length > 1)
                {
                    andParts.push({ $or: currentOr });
                    currentOr = [];
                }
                else if (currentOr.length === 1)
                {
                    andParts.push(currentOr[0]);
                    currentOr = [];
                }
                currentOr.push(clause);
            }
            else // OR
            {
                currentOr.push(clause);
            }
        }

        // Flush remaining or group
        if (currentOr.length > 1) andParts.push({ $or: currentOr });
        else if (currentOr.length === 1) andParts.push(currentOr[0]);

        if (andParts.length === 0) return {};
        if (andParts.length === 1) return andParts[0];
        return { $and: andParts };
    }

    /**
     * Convert a single operator clause to a MongoDB filter expression.
     * @private
     */
    _opToMongo(field, op, value)
    {
        switch (op)
        {
            case '=':          return { [field]: value };
            case '!=':
            case '<>':         return { [field]: { $ne: value } };
            case '>':          return { [field]: { $gt: value } };
            case '<':          return { [field]: { $lt: value } };
            case '>=':         return { [field]: { $gte: value } };
            case '<=':         return { [field]: { $lte: value } };
            case 'IN':         return { [field]: { $in: value } };
            case 'NOT IN':     return { [field]: { $nin: value } };
            case 'BETWEEN':    return { [field]: { $gte: value[0], $lte: value[1] } };
            case 'IS NULL':    return { [field]: null };
            case 'IS NOT NULL': return { [field]: { $ne: null } };
            case 'LIKE':
            {
                // Convert SQL LIKE to regex: % → .*, _ → .
                const pattern = value
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/%/g, '.*')
                    .replace(/_/g, '.');
                return { [field]: { $regex: new RegExp(`^${pattern}$`, 'i') } };
            }
            default: return { [field]: value };
        }
    }

    // -- Utility -----------------------------------------

    async close() { await this._client.close(); this._connected = false; }

    /**
     * Run a raw MongoDB command.
     * @param {object} command - MongoDB command document.
     * @returns {Promise<*>}
     */
    async raw(command)
    {
        const db = await this._getDb();
        return db.command(command);
    }

    /**
     * Run multiple operations in a transaction (requires replica set).
     * @param {Function} fn - Receives a session object.
     * @returns {Promise<*>}
     */
    async transaction(fn)
    {
        const session = this._client.startSession();
        try
        {
            session.startTransaction();
            const result = await fn(session);
            await session.commitTransaction();
            return result;
        }
        catch (e)
        {
            await session.abortTransaction();
            throw e;
        }
        finally
        {
            await session.endSession();
        }
    }

    // -- MongoDB Utilities -------------------------------

    /**
     * List all collections in the database.
     * @returns {Promise<string[]>}
     */
    async collections()
    {
        const db = await this._getDb();
        const list = await db.listCollections().toArray();
        return list.map(c => c.name);
    }

    /**
     * Get database stats (document count, storage size, indexes, etc.).
     * @returns {Promise<{ collections: number, objects: number, dataSize: number, storageSize: number, indexes: number, indexSize: number }>}
     */
    async stats()
    {
        const db = await this._getDb();
        const s = await db.command({ dbStats: 1 });
        return {
            collections: s.collections || 0,
            objects:      s.objects || 0,
            dataSize:     s.dataSize || 0,
            storageSize:  s.storageSize || 0,
            indexes:      s.indexes || 0,
            indexSize:    s.indexSize || 0,
        };
    }

    /**
     * Get collection stats.
     * @param {string} name - Collection name.
     * @returns {Promise<{ count: number, size: number, avgObjSize: number, storageSize: number, nindexes: number }>}
     */
    async collectionStats(name)
    {
        const db = await this._getDb();
        const s = await db.command({ collStats: name });
        return {
            count:       s.count || 0,
            size:        s.size || 0,
            avgObjSize:  s.avgObjSize || 0,
            storageSize: s.storageSize || 0,
            nindexes:    s.nindexes || 0,
        };
    }

    /**
     * Create an index on a collection.
     * @param {string} collection - Collection name.
     * @param {object} keys       - Index specification, e.g. { email: 1 } or { name: 1, age: -1 }.
     * @param {object} [options]  - Index options (unique, sparse, expireAfterSeconds, etc.).
     * @returns {Promise<string>} Index name.
     */
    async createIndex(collection, keys, options = {})
    {
        const col = await this._col(collection);
        return col.createIndex(keys, options);
    }

    /**
     * List indexes on a collection.
     * @param {string} collection
     * @returns {Promise<Array>}
     */
    async indexes(collection)
    {
        const col = await this._col(collection);
        return col.indexes();
    }

    /**
     * Drop an index from a collection.
     * @param {string} collection
     * @param {string} indexName
     */
    async dropIndex(collection, indexName)
    {
        const col = await this._col(collection);
        return col.dropIndex(indexName);
    }

    /**
     * Ping the MongoDB server.
     * @returns {Promise<boolean>}
     */
    async ping()
    {
        try
        {
            const db = await this._getDb();
            const result = await db.command({ ping: 1 });
            return result.ok === 1;
        }
        catch { return false; }
    }

    /**
     * Get MongoDB server version and build info.
     * @returns {Promise<string>}
     */
    async version()
    {
        const db = await this._getDb();
        const info = await db.command({ buildInfo: 1 });
        return info.version;
    }

    /**
     * Check if connected.
     * @returns {boolean}
     */
    get isConnected() { return this._connected; }
}

module.exports = MongoAdapter;
