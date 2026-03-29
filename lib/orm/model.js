/**
 * @module orm/model
 * @description Base Model class for defining database-backed entities.
 *              Provides static CRUD methods, instance-level save/update/delete,
 *              lifecycle hooks, and relationship definitions.
 *
 * @example
 *   const { Model, Database } = require('zero-http');
 *
 *   class User extends Model {
 *       static table = 'users';
 *       static schema = {
 *           id:    { type: 'integer', primaryKey: true, autoIncrement: true },
 *           name:  { type: 'string',  required: true, maxLength: 100 },
 *           email: { type: 'string',  required: true, unique: true },
 *           role:  { type: 'string',  enum: ['user','admin'], default: 'user' },
 *       };
 *       static timestamps = true;   // auto createdAt/updatedAt
 *       static softDelete = true;   // deletedAt instead of real delete
 *   }
 *
 *   db.register(User);
 *
 *   const user = await User.create({ name: 'Alice', email: 'a@b.com' });
 *   const users = await User.find({ role: 'admin' });
 *   const u = await User.findById(1);
 *   await u.update({ name: 'Alice2' });
 *   await u.delete();
 */
const { validate } = require('./schema');
const Query = require('./query');
const crypto = require('crypto');
const log = require('../debug')('zero:orm');
const { ValidationError, DatabaseError } = require('../errors');

class Model
{
    /**
     * Table name — override in subclass.
     * @type {string}
     */
    static table = '';

    /**
     * Column schema — override in subclass.
     * @type {Object<string, object>}
     */
    static schema = {};

    /**
     * Enable auto timestamps (createdAt, updatedAt).
     * @type {boolean}
     */
    static timestamps = false;

    /**
     * Enable soft deletes (deletedAt instead of real deletion).
     * @type {boolean}
     */
    static softDelete = false;

    /**
     * Fields to hide from toJSON() serialization.
     * Useful for excluding passwords, tokens, internal fields.
     * @type {string[]}
     *
     * @example
     *   class User extends Model {
     *       static hidden = ['password', 'resetToken'];
     *   }
     */
    static hidden = [];

    /**
     * Named query scopes — reusable query conditions.
     * Each scope is a function that receives a Query and returns it.
     * @type {Object<string, Function>}
     *
     * @example
     *   class User extends Model {
     *       static scopes = {
     *           active: q => q.where('active', true),
     *           admins: q => q.where('role', 'admin'),
     *           olderThan: (q, age) => q.where('age', '>', age),
     *       };
     *   }
     *
     *   // Use:
     *   await User.scope('active').scope('admins').limit(5);
     *   await User.scope('olderThan', 30);
     */
    static scopes = {};

    /**
     * Lifecycle hooks.
     * Override these in subclasses: `static beforeCreate(data) { return data; }`
     * @type {object}
     */
    static hooks = {};

    /**
     * Relationship definitions.
     * @type {object}
     * @private
     */
    static _relations = {};

    /**
     * Database adapter reference — set by Database.register().
     * @type {object|null}
     * @private
     */
    static _adapter = null;

    // -- Constructor ------------------------------------

    /**
     * Create a model instance from a data row.
     * Generally you won't call this directly — use static methods.
     *
     * @param {object} data - Row data.
     */
    constructor(data = {})
    {
        /** @type {boolean} Whether this instance exists in the database. */
        this._persisted = false;

        /** @type {object} The original data snapshot for dirty tracking. */
        this._original = {};

        // Assign data to instance (filter prototype pollution keys)
        for (const key of Object.keys(data))
        {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            this[key] = data[key];
        }
    }

    // -- Instance Methods -------------------------------

    /**
     * Save this instance to the database. Insert if new, update if persisted.
     * @returns {Promise<Model>} `this`
     */
    async save()
    {
        const ctor = this.constructor;
        if (this._persisted)
        {
            const pk = ctor._primaryKey();
            const changes = this._dirtyFields();
            if (Object.keys(changes).length === 0) return this;

            if (ctor.timestamps && ctor._fullSchema().updatedAt)
            {
                changes.updatedAt = new Date();
            }

            await ctor._runHook('beforeUpdate', changes);
            const { valid, errors, sanitized } = validate(changes, ctor._fullSchema(), { partial: true });
            if (!valid) throw new ValidationError('Validation failed: ' + errors.join(', '), errors);

            try { await ctor._adapter.update(ctor.table, pk, this[pk], sanitized); }
            catch (e) { log.error('%s update failed: %s', ctor.table, e.message); throw e; }
            log.debug('%s update id=%s', ctor.table, this[pk]);
            Object.assign(this, sanitized);
            await ctor._runHook('afterUpdate', this);
            this._snapshot();
        }
        else
        {
            const data = this._toData();

            if (ctor.timestamps)
            {
                const now = new Date();
                if (ctor._fullSchema().createdAt && !data.createdAt) data.createdAt = now;
                if (ctor._fullSchema().updatedAt && !data.updatedAt) data.updatedAt = now;
            }

            await ctor._runHook('beforeCreate', data);
            const { valid, errors, sanitized } = validate(data, ctor._fullSchema());
            if (!valid) throw new ValidationError('Validation failed: ' + errors.join(', '), errors);

            let result;
            try { result = await ctor._adapter.insert(ctor.table, sanitized); }
            catch (e) { log.error('%s insert failed: %s', ctor.table, e.message); throw e; }
            log.debug('%s insert', ctor.table);
            const pk = ctor._primaryKey();
            if (result && result[pk] !== undefined) this[pk] = result[pk];
            Object.assign(this, sanitized);
            this._persisted = true;
            await ctor._runHook('afterCreate', this);
            this._snapshot();
        }
        return this;
    }

    /**
     * Update specific fields on this instance.
     * @param {object} data - Fields to update.
     * @returns {Promise<Model>} `this`
     */
    async update(data)
    {
        Object.assign(this, this.constructor._stripGuarded(data));
        return this.save();
    }

    /**
     * Delete this instance from the database.
     * If softDelete is enabled, sets deletedAt instead.
     * @returns {Promise<void>}
     */
    async delete()
    {
        const ctor = this.constructor;
        const pk = ctor._primaryKey();

        await ctor._runHook('beforeDelete', this);

        if (ctor.softDelete)
        {
            this.deletedAt = new Date();
            try { await ctor._adapter.update(ctor.table, pk, this[pk], { deletedAt: this.deletedAt }); }
            catch (e) { log.error('%s soft-delete failed: %s', ctor.table, e.message); throw e; }
        }
        else
        {
            try { await ctor._adapter.remove(ctor.table, pk, this[pk]); }
            catch (e) { log.error('%s delete failed: %s', ctor.table, e.message); throw e; }
        }

        log.debug('%s delete id=%s', ctor.table, this[pk]);

        await ctor._runHook('afterDelete', this);
        this._persisted = false;
    }

    /**
     * Restore a soft-deleted record.
     * @returns {Promise<Model>} `this`
     */
    async restore()
    {
        const ctor = this.constructor;
        if (!ctor.softDelete) throw new Error('Model does not use soft deletes');
        const pk = ctor._primaryKey();
        this.deletedAt = null;
        try { await ctor._adapter.update(ctor.table, pk, this[pk], { deletedAt: null }); }
        catch (e) { log.error('%s restore failed: %s', ctor.table, e.message); throw e; }
        return this;
    }

    /**
     * Increment a numeric field atomically.
     *
     * @param {string} field  - Column name to increment.
     * @param {number} [by=1] - Amount to increment by.
     * @returns {Promise<Model>} `this`
     *
     * @example
     *   await post.increment('views');
     *   await product.increment('stock', 10);
     */
    async increment(field, by = 1)
    {
        const ctor = this.constructor;
        const pk = ctor._primaryKey();
        this[field] = (Number(this[field]) || 0) + by;
        const update = { [field]: this[field] };
        if (ctor.timestamps && ctor._fullSchema().updatedAt)
        {
            update.updatedAt = new Date();
            this.updatedAt = update.updatedAt;
        }
        await ctor._adapter.update(ctor.table, pk, this[pk], update);
        log.debug('%s increment %s by %d', ctor.table, field, by);
        this._snapshot();
        return this;
    }

    /**
     * Decrement a numeric field atomically.
     *
     * @param {string} field  - Column name to decrement.
     * @param {number} [by=1] - Amount to decrement by.
     * @returns {Promise<Model>} `this`
     *
     * @example
     *   await product.decrement('stock');
     *   await account.decrement('balance', 50);
     */
    async decrement(field, by = 1)
    {
        return this.increment(field, -by);
    }

    /**
     * Reload this instance from the database.
     * @returns {Promise<Model>} `this`
     */
    async reload()
    {
        const ctor = this.constructor;
        const pk = ctor._primaryKey();
        const fresh = await ctor.findById(this[pk]);
        if (!fresh) throw new Error('Record not found');
        Object.assign(this, fresh);
        this._snapshot();
        return this;
    }

    /**
     * Convert to plain object (for JSON serialization).
     * Respects `static hidden = [...]` to exclude sensitive fields.
     * @returns {object}
     */
    toJSON()
    {
        const data = {};
        const schema = this.constructor._fullSchema();
        const hidden = this.constructor.hidden || [];
        for (const key of Object.keys(schema))
        {
            if (this[key] !== undefined && !hidden.includes(key)) data[key] = this[key];
        }
        return data;
    }

    // -- Internal Instance Helpers ----------------------

    /** @private Snapshot current data for dirty tracking. */
    _snapshot()
    {
        this._original = { ...this._toData() };
    }

    /** @private Get only data columns (exclude internal props). */
    _toData()
    {
        const data = {};
        const schema = this.constructor._fullSchema();
        for (const key of Object.keys(schema))
        {
            if (this[key] !== undefined) data[key] = this[key];
        }
        return data;
    }

    /** @private Get fields that changed since last snapshot. */
    _dirtyFields()
    {
        const data = this._toData();
        const changes = {};
        for (const [k, v] of Object.entries(data))
        {
            if (v !== this._original[k]) changes[k] = v;
        }
        return changes;
    }

    // -- Static CRUD ------------------------------------

    /**
     * Create and persist a new record.
     *
     * @param {object} data - Record data.
     * @returns {Promise<Model>} The created instance.
     */
    static async create(data)
    {
        const instance = new this(this._stripGuarded(data));
        return instance.save();
    }

    /**
     * Create multiple records at once.
     * Uses batch INSERT when the adapter supports it (much faster for SQL databases).
     *
     * @param {object[]} dataArray - Array of record data.
     * @returns {Promise<Model[]>}
     */
    static async createMany(dataArray)
    {
        if (!dataArray.length) return [];

        // Validate, apply hooks & timestamps for each row
        const fullSchema = this._fullSchema();
        const sanitizedRows = [];
        for (const data of dataArray)
        {
            const row = this._stripGuarded({ ...data });
            if (this.timestamps)
            {
                const now = new Date();
                if (fullSchema.createdAt && !row.createdAt) row.createdAt = now;
                if (fullSchema.updatedAt && !row.updatedAt) row.updatedAt = now;
            }
            await this._runHook('beforeCreate', row);
            const { valid, errors, sanitized } = validate(row, fullSchema);
            if (!valid) throw new ValidationError('Validation failed: ' + errors.join(', '), errors);
            sanitizedRows.push(sanitized);
        }

        // Use batch insertMany if adapter supports it
        if (typeof this._adapter.insertMany === 'function')
        {
            let results;
            try { results = await this._adapter.insertMany(this.table, sanitizedRows); }
            catch (e) { log.error('%s insertMany failed: %s', this.table, e.message); throw e; }

            const instances = results.map(row => {
                const inst = this._fromRow(row);
                return inst;
            });

            for (const inst of instances) await this._runHook('afterCreate', inst);
            return instances;
        }

        // Fallback: individual inserts
        return Promise.all(dataArray.map(d => this.create(d)));
    }

    /**
     * Find records matching conditions.
     *
     * @param {object} [conditions={}] - WHERE conditions `{ key: value }`.
     * @returns {Promise<Model[]>}
     */
    static async find(conditions = {})
    {
        const q = this.query().where(conditions);
        return q.exec();
    }

    /**
     * Find a single record matching conditions.
     *
     * @param {object} conditions - WHERE conditions.
     * @returns {Promise<Model|null>}
     */
    static async findOne(conditions)
    {
        return this.query().where(conditions).first();
    }

    /**
     * Find a record by primary key.
     *
     * @param {*} id - Primary key value.
     * @returns {Promise<Model|null>}
     */
    static async findById(id)
    {
        const pk = this._primaryKey();
        return this.query().where(pk, id).first();
    }

    /**
     * Find one or create if not found.
     *
     * @param {object} conditions - Search conditions.
     * @param {object} [defaults={}] - Additional data for creation.
     * @returns {Promise<{ instance: Model, created: boolean }>}
     */
    static async findOrCreate(conditions, defaults = {})
    {
        const existing = await this.findOne(conditions);
        if (existing) return { instance: existing, created: false };
        const instance = await this.create({ ...conditions, ...defaults });
        return { instance, created: true };
    }

    /**
     * Update records matching conditions.
     *
     * @param {object} conditions - WHERE conditions.
     * @param {object} data       - Fields to update.
     * @returns {Promise<number>} Number of updated records.
     */
    static async updateWhere(conditions, data)
    {
        data = this._stripGuarded(data);
        if (this.timestamps && this._fullSchema().updatedAt)
        {
            data.updatedAt = new Date();
        }
        await this._runHook('beforeUpdate', data);
        try { return await this._adapter.updateWhere(this.table, conditions, data); }
        catch (e) { log.error('%s updateWhere failed: %s', this.table, e.message); throw e; }
    }

    /**
     * Delete records matching conditions.
     *
     * @param {object} conditions - WHERE conditions.
     * @returns {Promise<number>} Number of deleted records.
     */
    static async deleteWhere(conditions)
    {
        if (this.softDelete)
        {
            try { return await this._adapter.updateWhere(this.table, conditions, { deletedAt: new Date() }); }
            catch (e) { log.error('%s deleteWhere (soft) failed: %s', this.table, e.message); throw e; }
        }
        try { return await this._adapter.deleteWhere(this.table, conditions); }
        catch (e) { log.error('%s deleteWhere failed: %s', this.table, e.message); throw e; }
    }

    /**
     * Count records matching conditions.
     *
     * @param {object} [conditions={}] - WHERE conditions.
     * @returns {Promise<number>}
     */
    static async count(conditions = {})
    {
        return this.query().where(conditions).count();
    }

    /**
     * Check whether any records matching conditions exist.
     *
     * @param {object} [conditions={}] - WHERE conditions.
     * @returns {Promise<boolean>}
     *
     * @example
     *   if (await User.exists({ email: 'a@b.com' })) { ... }
     */
    static async exists(conditions = {})
    {
        return this.query().where(conditions).exists();
    }

    /**
     * Insert or update a record matching conditions.
     * If a matching record exists, update it. Otherwise, create a new one.
     *
     * @param {object} conditions - Search conditions (unique fields).
     * @param {object} data       - Data to set (merged with conditions on create).
     * @returns {Promise<{ instance: Model, created: boolean }>}
     *
     * @example
     *   const { instance, created } = await User.upsert(
     *       { email: 'a@b.com' },
     *       { name: 'Alice', role: 'admin' }
     *   );
     */
    static async upsert(conditions, data = {})
    {
        const existing = await this.findOne(conditions);
        if (existing)
        {
            await existing.update(data);
            return { instance: existing, created: false };
        }
        const instance = await this.create({ ...conditions, ...data });
        return { instance, created: true };
    }

    /**
     * Start a query with a named scope applied.
     *
     * @param {string} name   - Scope name (from `static scopes`).
     * @param {...*}   [args] - Additional arguments passed to the scope function.
     * @returns {Query}
     *
     * @example
     *   await User.scope('active').where('role', 'admin');
     *   await User.scope('olderThan', 21).limit(10);
     */
    static scope(name, ...args)
    {
        if (!this.scopes || typeof this.scopes[name] !== 'function')
        {
            throw new Error(`Unknown scope "${name}" on ${this.name}`);
        }
        const q = this.query();
        this.scopes[name](q, ...args);
        return q;
    }

    /**
     * Start a fluent query builder.
     *
     * @returns {Query}
     *
     * @example
     *   const results = await User.query()
     *       .where('age', '>', 18)
     *       .orderBy('name')
     *       .limit(10);
     */
    static query()
    {
        if (!this._adapter) throw new Error(`Model "${this.name}" is not registered with a database`);
        const q = new Query(this, this._adapter);

        // Auto-exclude soft-deleted records
        if (this.softDelete)
        {
            q.whereNull('deletedAt');
        }

        return q;
    }

    // -- LINQ-Inspired Static Shortcuts -----------------

    /**
     * Find the first record matching optional conditions.
     *
     * @param {object} [conditions={}] - WHERE conditions.
     * @returns {Promise<Model|null>}
     *
     * @example
     *   const admin = await User.first({ role: 'admin' });
     *   const oldest = await User.first(); // first by PK
     */
    static async first(conditions = {})
    {
        return this.query().where(conditions).first();
    }

    /**
     * Find the last record matching optional conditions.
     *
     * @param {object} [conditions={}] - WHERE conditions.
     * @returns {Promise<Model|null>}
     *
     * @example
     *   const newest = await User.last();
     *   const lastAdmin = await User.last({ role: 'admin' });
     */
    static async last(conditions = {})
    {
        return this.query().where(conditions).last();
    }

    /**
     * Rich pagination with metadata.
     * Returns `{ data, total, page, perPage, pages, hasNext, hasPrev }`.
     *
     * @param {number} page           - 1-indexed page number.
     * @param {number} [perPage=20]   - Items per page.
     * @param {object} [conditions={}] - Optional WHERE conditions.
     * @returns {Promise<object>}
     *
     * @example
     *   const result = await User.paginate(2, 10, { role: 'admin' });
     *   // { data: [...], total: 53, page: 2, perPage: 10,
     *   //   pages: 6, hasNext: true, hasPrev: true }
     */
    static async paginate(page, perPage = 20, conditions = {})
    {
        return this.query().where(conditions).paginate(page, perPage);
    }

    /**
     * Process all matching records in batches.
     * Calls `fn(batch, batchIndex)` for each chunk.
     *
     * @param {number}   size            - Batch size.
     * @param {Function} fn              - Called with (batch: Model[], index: number).
     * @param {object}   [conditions={}] - Optional WHERE conditions.
     * @returns {Promise<void>}
     *
     * @example
     *   await User.chunk(100, async (users, i) => {
     *       for (const u of users) await u.update({ migrated: true });
     *   }, { active: true });
     */
    static async chunk(size, fn, conditions = {})
    {
        return this.query().where(conditions).chunk(size, fn);
    }

    /**
     * Get all records, optionally filtered.
     * Alias for find() — for LINQ-familiarity.
     *
     * @param {object} [conditions={}] - WHERE conditions.
     * @returns {Promise<Model[]>}
     */
    static async all(conditions = {})
    {
        return this.find(conditions);
    }

    /**
     * Get a random record.
     *
     * @param {object} [conditions={}] - Optional WHERE conditions.
     * @returns {Promise<Model|null>}
     *
     * @example
     *   const luckyUser = await User.random();
     *   const randomAdmin = await User.random({ role: 'admin' });
     */
    static async random(conditions = {})
    {
        const total = await this.count(conditions);
        if (total === 0) return null;
        const idx = Math.floor(Math.random() * total);
        return this.query().where(conditions).offset(idx).first();
    }

    /**
     * Pluck values for a single column across all matching records.
     *
     * @param {string} field            - Column name to extract.
     * @param {object} [conditions={}]  - Optional WHERE conditions.
     * @returns {Promise<Array>}
     *
     * @example
     *   const emails = await User.pluck('email');
     *   const adminNames = await User.pluck('name', { role: 'admin' });
     */
    static async pluck(field, conditions = {})
    {
        return this.query().where(conditions).pluck(field);
    }

    // -- Relationships ----------------------------------

    /**
     * Define a hasMany relationship.
     * @param {Function} RelatedModel - The related Model class.
     * @param {string}   foreignKey   - Foreign key column on the related table.
     * @param {string}   [localKey]   - Local key (default: primary key).
     */
    static hasMany(RelatedModel, foreignKey, localKey)
    {
        const pk = localKey || this._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = { type: 'hasMany', model: RelatedModel, foreignKey, localKey: pk };
    }

    /**
     * Define a hasOne relationship.
     * @param {Function} RelatedModel
     * @param {string}   foreignKey
     * @param {string}   [localKey]
     */
    static hasOne(RelatedModel, foreignKey, localKey)
    {
        const pk = localKey || this._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = { type: 'hasOne', model: RelatedModel, foreignKey, localKey: pk };
    }

    /**
     * Define a belongsTo relationship.
     * @param {Function} RelatedModel
     * @param {string}   foreignKey   - Foreign key column on THIS table.
     * @param {string}   [otherKey]   - Key on the related table (default: its primary key).
     */
    static belongsTo(RelatedModel, foreignKey, otherKey)
    {
        const ok = otherKey || RelatedModel._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = { type: 'belongsTo', model: RelatedModel, foreignKey, localKey: ok };
    }

    /**
     * Define a many-to-many relationship through a junction/pivot table.
     *
     * @param {Function} RelatedModel   - The related Model class.
     * @param {object}   opts           - Relationship options.
     * @param {string}   opts.through   - Junction table name (e.g. 'user_roles').
     * @param {string}   opts.foreignKey   - Column on the junction table referencing THIS model.
     * @param {string}   opts.otherKey     - Column on the junction table referencing the related model.
     * @param {string}   [opts.localKey]   - Local key (default: primary key).
     * @param {string}   [opts.relatedKey] - Related model key (default: its primary key).
     *
     * @example
     *   User.belongsToMany(Role, {
     *       through: 'user_roles',
     *       foreignKey: 'userId',
     *       otherKey: 'roleId'
     *   });
     *   const roles = await user.load('Role'); // returns Role[]
     */
    static belongsToMany(RelatedModel, opts = {})
    {
        if (!opts.through || !opts.foreignKey || !opts.otherKey)
        {
            throw new Error('belongsToMany requires through, foreignKey, and otherKey');
        }
        const pk = opts.localKey || this._primaryKey();
        const rpk = opts.relatedKey || RelatedModel._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = {
            type: 'belongsToMany',
            model: RelatedModel,
            through: opts.through,
            foreignKey: opts.foreignKey,
            otherKey: opts.otherKey,
            localKey: pk,
            relatedKey: rpk,
        };
    }

    /**
     * Load a related model for this instance.
     *
     * @param {string} relationName - Name of the related Model class.
     * @returns {Promise<Model|Model[]|null>}
     */
    async load(relationName)
    {
        const ctor = this.constructor;
        const rel = ctor._relations && ctor._relations[relationName];
        if (!rel) throw new Error(`Unknown relation "${relationName}" on ${ctor.name}`);

        switch (rel.type)
        {
            case 'hasMany':
                return rel.model.find({ [rel.foreignKey]: this[rel.localKey] });
            case 'hasOne':
                return rel.model.findOne({ [rel.foreignKey]: this[rel.localKey] });
            case 'belongsTo':
                return rel.model.findOne({ [rel.localKey]: this[rel.foreignKey] });
            case 'belongsToMany':
            {
                // Query the junction table to find related IDs
                const junctionRows = await ctor._adapter.execute({
                    action: 'select',
                    table: rel.through,
                    fields: [rel.otherKey],
                    where: [{ field: rel.foreignKey, op: '=', value: this[rel.localKey], logic: 'AND' }],
                    orderBy: [], joins: [], groupBy: [], having: [],
                    limit: null, offset: null, distinct: false,
                });
                if (!junctionRows.length) return [];
                const relatedIds = junctionRows.map(r => r[rel.otherKey]);
                return rel.model.query().whereIn(rel.relatedKey, relatedIds).exec();
            }
            default:
                throw new Error(`Unknown relation type "${rel.type}"`);
        }
    }

    // -- Internal Static Helpers ------------------------

    /**
     * Strip guarded fields from a data object.
     * Guarded fields are defined in the schema with `guarded: true`.
     * They cannot be set via mass-assignment (create / update with object).
     *
     * @param {object} data - The input data.
     * @returns {object} A copy of data without guarded fields.
     * @private
     */
    static _stripGuarded(data)
    {
        const schema = this.schema;
        const guardedKeys = Object.entries(schema)
            .filter(([, def]) => def.guarded)
            .map(([name]) => name);
        if (guardedKeys.length === 0) return data;
        const cleaned = { ...data };
        for (const key of guardedKeys) delete cleaned[key];
        return cleaned;
    }

    /**
     * Get the full schema including auto-fields.
     * @returns {object}
     * @private
     */
    static _fullSchema()
    {
        const s = { ...this.schema };
        if (this.timestamps)
        {
            if (!s.createdAt) s.createdAt = { type: 'datetime', default: () => new Date() };
            if (!s.updatedAt) s.updatedAt = { type: 'datetime', default: () => new Date() };
        }
        if (this.softDelete)
        {
            if (!s.deletedAt) s.deletedAt = { type: 'datetime', nullable: true };
        }
        return s;
    }

    /**
     * Get the primary key column name(s).
     * Returns a single string for simple PKs, or an array for composite PKs.
     * @returns {string|string[]}
     * @private
     */
    static _primaryKey()
    {
        const pks = [];
        for (const [name, def] of Object.entries(this.schema))
        {
            if (def.primaryKey) pks.push(name);
        }
        if (pks.length === 0) return 'id'; // convention
        if (pks.length === 1) return pks[0];
        return pks; // composite PK
    }

    /**
     * Create a model instance from a raw database row.
     * @param {object} row
     * @returns {Model}
     * @private
     */
    static _fromRow(row)
    {
        const instance = new this(row);
        instance._persisted = true;
        instance._snapshot();
        return instance;
    }

    /**
     * Run a lifecycle hook if defined.
     * @param {string} hookName
     * @param {*} data
     * @returns {Promise<*>}
     * @private
     */
    static async _runHook(hookName, data)
    {
        // Check for static hook on class
        if (typeof this[hookName] === 'function')
        {
            return this[hookName](data);
        }
        // Check hooks object
        if (this.hooks && typeof this.hooks[hookName] === 'function')
        {
            return this.hooks[hookName](data);
        }
        return data;
    }

    /**
     * Sync the table schema with the database (create table if not exists).
     * @returns {Promise<void>}
     */
    static async sync()
    {
        if (!this._adapter) throw new Error(`Model "${this.name}" is not registered with a database`);
        return this._adapter.createTable(this.table, this._fullSchema());
    }

    /**
     * Drop the table.
     * @returns {Promise<void>}
     */
    static async drop()
    {
        if (!this._adapter) throw new Error(`Model "${this.name}" is not registered with a database`);
        return this._adapter.dropTable(this.table);
    }
}

module.exports = Model;
