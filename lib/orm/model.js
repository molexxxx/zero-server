/**
 * @module orm/model
 * @description Base Model class for defining database-backed entities.
 *              Provides static CRUD methods, instance-level save/update/delete,
 *              lifecycle hooks, relationship definitions, computed/virtual columns,
 *              attribute casting, model events & observers, and advanced relationships.
 *
 * @example
 *   const { Model, Database } = require('@zero-server/sdk');
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
const { EventEmitter } = require('events');

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

    // -- Computed & Virtual Columns ---------------------

    /**
     * Computed column definitions — virtual columns derived from other fields.
     * Not stored in the database; calculated on the fly.
     * Each entry maps a column name to a getter function `(instance) => value`.
     * @type {Object<string, Function>}
     *
     * @example
     *   class User extends Model {
     *       static computed = {
     *           fullName: (user) => `${user.firstName} ${user.lastName}`,
     *           isAdmin:  (user) => user.role === 'admin',
     *       };
     *   }
     *
     *   const user = await User.findById(1);
     *   user.fullName // => 'Alice Smith'
     */
    static computed = {};

    /**
     * Attribute casts — automatic type transformations on get/set.
     * Maps column names to cast types or custom cast objects.
     *
     * Built-in cast types:
     * - `'json'`     — JSON.parse on get, JSON.stringify on set
     * - `'boolean'`  — Cast to true/false
     * - `'integer'`  — parseInt
     * - `'float'`    — parseFloat
     * - `'date'`     — Cast to Date object
     * - `'string'`   — Cast to String
     * - `'array'`    — JSON parse/stringify for array data
     *
     * Custom casts:
     * - `{ get: (v) => transformed, set: (v) => transformed }`
     *
     * @type {Object<string, string|{ get: Function, set: Function }>}
     *
     * @example
     *   class Settings extends Model {
     *       static casts = {
     *           preferences: 'json',
     *           isActive:    'boolean',
     *           loginCount:  'integer',
     *           tags:        'array',
     *           metadata:    {
     *               get: (v) => v ? JSON.parse(v) : {},
     *               set: (v) => JSON.stringify(v),
     *           },
     *       };
     *   }
     */
    static casts = {};

    /**
     * Custom attribute accessors (getters).
     * These transform values when reading from the model instance.
     * Each entry maps a column name to a function `(value, instance) => transformedValue`.
     * @type {Object<string, Function>}
     *
     * @example
     *   class User extends Model {
     *       static accessors = {
     *           email: (val) => val ? val.toLowerCase() : val,
     *           name:  (val) => val ? val.trim() : val,
     *       };
     *   }
     */
    static accessors = {};

    /**
     * Custom attribute mutators (setters).
     * These transform values before writing to the model instance.
     * Each entry maps a column name to a function `(value, instance) => transformedValue`.
     * @type {Object<string, Function>}
     *
     * @example
     *   class User extends Model {
     *       static mutators = {
     *           email: (val) => val ? val.toLowerCase().trim() : val,
     *           password: (val) => hashSync(val),
     *       };
     *   }
     */
    static mutators = {};

    // -- Model Events -----------------------------------

    /**
     * Internal event emitter for model-level events.
     * @type {EventEmitter|null}
     * @private
     */
    static _emitter = null;

    /**
     * Registered observers for this model.
     * @type {object[]}
     * @private
     */
    static _observers = [];

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
     * @constructor
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
        const mutators = this.constructor.mutators || {};
        const casts = this.constructor.casts || {};
        for (const key of Object.keys(data))
        {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            let val = data[key];
            // Apply mutator if defined
            if (typeof mutators[key] === 'function')
            {
                val = mutators[key](val, this);
            }
            // Apply cast set if defined
            else if (casts[key])
            {
                val = Model._applyCastSet(val, casts[key]);
            }
            this[key] = val;
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
     * Includes computed columns and applies accessor transformations.
     * @returns {object} Plain data object with hidden fields excluded.
     */
    toJSON()
    {
        const data = {};
        const ctor = this.constructor;
        const schema = ctor._fullSchema();
        const hidden = ctor.hidden || [];
        const accessors = ctor.accessors || {};
        const casts = ctor.casts || {};
        for (const key of Object.keys(schema))
        {
            if (this[key] !== undefined && !hidden.includes(key))
            {
                let val = this[key];
                // Apply accessor if defined
                if (typeof accessors[key] === 'function')
                {
                    val = accessors[key](val, this);
                }
                // Apply cast get if defined (and no accessor)
                else if (casts[key])
                {
                    val = Model._applyCastGet(val, casts[key]);
                }
                data[key] = val;
            }
        }
        // Include computed columns
        const computed = ctor.computed || {};
        for (const [name, fn] of Object.entries(computed))
        {
            if (!hidden.includes(name) && typeof fn === 'function')
            {
                data[name] = fn(this);
            }
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
     * @returns {Promise<Model[]>} Created model instances.
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
     * @returns {Promise<Model[]>} Matching records.
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
     * @returns {Promise<Model|null>} First matching record, or null.
     */
    static async findOne(conditions)
    {
        return this.query().where(conditions).first();
    }

    /**
     * Find a record by primary key.
     *
     * @param {*} id - Primary key value.
     * @returns {Promise<Model|null>} Matching record, or null.
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
     * @returns {Promise<number>} Number of matching records.
     */
    static async count(conditions = {})
    {
        return this.query().where(conditions).count();
    }

    /**
     * Check whether any records matching conditions exist.
     *
     * @param {object} [conditions={}] - WHERE conditions.
     * @returns {Promise<boolean>} True if any matching records exist.
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
     * @returns {Query} Scoped query builder.
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
     * @returns {Query} New fluent query builder.
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
     * @returns {Promise<Model|null>} First matching record, or null.
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
     * @returns {Promise<Model|null>} Last matching record, or null.
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
     * @returns {Promise<object>} Pagination result with data, total, page, perPage, pages, hasNext, hasPrev.
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
     * @returns {Promise<Model[]>} All matching records.
     */
    static async all(conditions = {})
    {
        return this.find(conditions);
    }

    /**
     * Get a random record.
     *
     * @param {object} [conditions={}] - Optional WHERE conditions.
     * @returns {Promise<Model|null>} Random matching record, or null.
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
     * @returns {Promise<Array>} Values for the specified column.
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
     * @param {Function} RelatedModel - The related Model class.
     * @param {string}   foreignKey   - Foreign key column on the related table.
     * @param {string}   [localKey]   - Local key (default: primary key).
     */
    static hasOne(RelatedModel, foreignKey, localKey)
    {
        const pk = localKey || this._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = { type: 'hasOne', model: RelatedModel, foreignKey, localKey: pk };
    }

    /**
     * Define a belongsTo relationship.
     * @param {Function} RelatedModel - The related Model class.
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
     * @param {string} relationName - Name of the related Model class or relation alias.
     * @returns {Promise<Model|Model[]|null>} The related model(s) or null.
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
            case 'morphOne':
            {
                const typeCol = `${rel.morphName}_type`;
                const idCol = `${rel.morphName}_id`;
                return rel.model.findOne({ [typeCol]: ctor.name, [idCol]: this[rel.localKey] });
            }
            case 'morphMany':
            {
                const typeCol = `${rel.morphName}_type`;
                const idCol = `${rel.morphName}_id`;
                return rel.model.find({ [typeCol]: ctor.name, [idCol]: this[rel.localKey] });
            }
            case 'hasManyThrough':
            {
                // Get intermediate records
                const throughRecords = await rel.through.find({ [rel.firstKey]: this[rel.localKey] });
                if (!throughRecords.length) return [];
                const throughIds = throughRecords.map(r => r[rel.secondLocalKey]);
                return rel.model.query().whereIn(rel.secondKey, throughIds).exec();
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
     * @returns {object} Schema with auto-generated timestamp and soft-delete columns.
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
     * @returns {string|string[]} Primary key column name(s).
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
     * @param {object} row - Data row object.
     * @returns {Model} Hydrated model instance.
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
     * Also emits model events and notifies observers.
     * @param {string} hookName - Lifecycle hook name.
     * @param {*} data - Record data object.
     * @returns {Promise<*>} Resolved value.
     * @private
     */
    static async _runHook(hookName, data)
    {
        // Check for static hook on class
        if (typeof this[hookName] === 'function')
        {
            await this[hookName](data);
        }
        // Check hooks object
        else if (this.hooks && typeof this.hooks[hookName] === 'function')
        {
            await this.hooks[hookName](data);
        }

        // Emit model event
        this._emit(hookName, data);

        // Notify observers
        this._notifyObservers(hookName, data);

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

    // -- Attribute Casting Helpers ----------------------

    /**
     * Apply a cast transformation on get (reading from model).
     * @param {*} value - Raw stored value.
     * @param {string|object} cast - Cast type or custom cast object.
     * @returns {*} Transformed value.
     * @private
     */
    static _applyCastGet(value, cast)
    {
        if (value === null || value === undefined) return value;
        if (typeof cast === 'object' && typeof cast.get === 'function')
        {
            return cast.get(value);
        }
        switch (cast)
        {
            case 'json':
            case 'array':
                return typeof value === 'string' ? JSON.parse(value) : value;
            case 'boolean':
                if (typeof value === 'boolean') return value;
                if (typeof value === 'number') return value !== 0;
                if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
                return Boolean(value);
            case 'integer':
                return parseInt(value, 10) || 0;
            case 'float':
                return parseFloat(value) || 0;
            case 'date':
                return value instanceof Date ? value : new Date(value);
            case 'string':
                return String(value);
            default:
                return value;
        }
    }

    /**
     * Apply a cast transformation on set (writing to model).
     * @param {*} value - Input value.
     * @param {string|object} cast - Cast type or custom cast object.
     * @returns {*} Transformed value for storage.
     * @private
     */
    static _applyCastSet(value, cast)
    {
        if (value === null || value === undefined) return value;
        if (typeof cast === 'object' && typeof cast.set === 'function')
        {
            return cast.set(value);
        }
        switch (cast)
        {
            case 'json':
            case 'array':
                return typeof value === 'string' ? value : JSON.stringify(value);
            case 'boolean':
                if (typeof value === 'boolean') return value;
                if (typeof value === 'number') return value !== 0;
                if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
                return Boolean(value);
            case 'integer':
                return parseInt(value, 10) || 0;
            case 'float':
                return parseFloat(value) || 0;
            case 'date':
                return value instanceof Date ? value : new Date(value);
            case 'string':
                return String(value);
            default:
                return value;
        }
    }

    /**
     * Get an attribute value with accessor/cast applied.
     *
     * @param {string} key - Attribute name.
     * @returns {*} Transformed value.
     *
     * @example
     *   const email = user.getAttribute('email');
     */
    getAttribute(key)
    {
        const ctor = this.constructor;
        const accessors = ctor.accessors || {};
        const casts = ctor.casts || {};
        const computed = ctor.computed || {};

        // Check computed first
        if (typeof computed[key] === 'function')
        {
            return computed[key](this);
        }

        let val = this[key];

        // Apply accessor
        if (typeof accessors[key] === 'function')
        {
            return accessors[key](val, this);
        }

        // Apply cast get
        if (casts[key])
        {
            return Model._applyCastGet(val, casts[key]);
        }

        return val;
    }

    /**
     * Set an attribute value with mutator/cast applied.
     *
     * @param {string} key   - Attribute name.
     * @param {*}      value - Value to set.
     * @returns {Model} `this` for chaining.
     *
     * @example
     *   user.setAttribute('email', 'ALICE@EXAMPLE.COM');
     *   // If mutator lowercases: user.email => 'alice@example.com'
     */
    setAttribute(key, value)
    {
        const ctor = this.constructor;
        const mutators = ctor.mutators || {};
        const casts = ctor.casts || {};

        if (typeof mutators[key] === 'function')
        {
            this[key] = mutators[key](value, this);
        }
        else if (casts[key])
        {
            this[key] = Model._applyCastSet(value, casts[key]);
        }
        else
        {
            this[key] = value;
        }
        return this;
    }

    // -- Model Events -----------------------------------

    /**
     * Get or create the EventEmitter for this model class.
     * @returns {EventEmitter} The model's event emitter.
     * @private
     */
    static _getEmitter()
    {
        if (!this.hasOwnProperty('_emitter') || !this._emitter)
        {
            this._emitter = new EventEmitter();
        }
        return this._emitter;
    }

    /**
     * Register an event listener on this model.
     * Supported events: `creating`, `created`, `updating`, `updated`,
     * `deleting`, `deleted`, `saving`, `saved`.
     *
     * @param {string}   event    - Event name.
     * @param {Function} listener - Callback `(data) => {}`.
     * @returns {typeof Model} The model class (for chaining).
     *
     * @example
     *   User.on('created', (user) => {
     *       console.log('New user:', user.name);
     *   });
     *
     *   User.on('updating', (changes) => {
     *       console.log('Updating fields:', Object.keys(changes));
     *   });
     */
    static on(event, listener)
    {
        this._getEmitter().on(event, listener);
        return this;
    }

    /**
     * Register a one-time event listener.
     *
     * @param {string}   event    - Event name.
     * @param {Function} listener - Callback function.
     * @returns {typeof Model} The model class (for chaining).
     */
    static once(event, listener)
    {
        this._getEmitter().once(event, listener);
        return this;
    }

    /**
     * Remove an event listener.
     *
     * @param {string}   event    - Event name.
     * @param {Function} listener - Callback to remove.
     * @returns {typeof Model} The model class (for chaining).
     */
    static off(event, listener)
    {
        this._getEmitter().off(event, listener);
        return this;
    }

    /**
     * Remove all listeners for an event, or all listeners entirely.
     *
     * @param {string} [event] - Event name. If omitted, removes all listeners.
     * @returns {typeof Model} The model class (for chaining).
     */
    static removeAllListeners(event)
    {
        if (event !== undefined)
        {
            this._getEmitter().removeAllListeners(event);
        }
        else
        {
            this._getEmitter().removeAllListeners();
        }
        return this;
    }

    /**
     * Emit a model event.
     * @param {string} event - Event name.
     * @param {*} data - Event data.
     * @private
     */
    static _emit(event, data)
    {
        // Map hook names to event names
        const eventMap = {
            beforeCreate: 'creating',
            afterCreate:  'created',
            beforeUpdate: 'updating',
            afterUpdate:  'updated',
            beforeDelete: 'deleting',
            afterDelete:  'deleted',
        };
        const eventName = eventMap[event];
        if (eventName && this.hasOwnProperty('_emitter') && this._emitter)
        {
            this._emitter.emit(eventName, data);
        }
    }

    // -- Observers --------------------------------------

    /**
     * Register an observer for this model.
     * An observer is an object with methods named after lifecycle events:
     * `creating`, `created`, `updating`, `updated`, `deleting`, `deleted`.
     *
     * @param {object} observer - Observer object with event handler methods.
     * @returns {typeof Model} The model class (for chaining).
     *
     * @example
     *   const UserObserver = {
     *       created(user) { console.log('New user:', user.name); },
     *       updating(changes) { console.log('Updating:', changes); },
     *       deleted(user) { console.log('Deleted user:', user.id); },
     *   };
     *
     *   User.observe(UserObserver);
     */
    static observe(observer)
    {
        if (!this.hasOwnProperty('_observers'))
        {
            this._observers = [];
        }
        this._observers.push(observer);
        return this;
    }

    /**
     * Remove an observer from this model.
     *
     * @param {object} observer - Observer to remove.
     * @returns {typeof Model} The model class (for chaining).
     */
    static unobserve(observer)
    {
        if (this.hasOwnProperty('_observers'))
        {
            this._observers = this._observers.filter(o => o !== observer);
        }
        return this;
    }

    /**
     * Notify all registered observers of a lifecycle event.
     * @param {string} hookName - Hook name (e.g. 'beforeCreate').
     * @param {*} data - Event data.
     * @private
     */
    static _notifyObservers(hookName, data)
    {
        const eventMap = {
            beforeCreate: 'creating',
            afterCreate:  'created',
            beforeUpdate: 'updating',
            afterUpdate:  'updated',
            beforeDelete: 'deleting',
            afterDelete:  'deleted',
        };
        const eventName = eventMap[hookName];
        if (!eventName) return;

        const observers = this.hasOwnProperty('_observers') ? this._observers : [];
        for (const observer of observers)
        {
            if (typeof observer[eventName] === 'function')
            {
                observer[eventName](data);
            }
        }
    }

    // -- Advanced Relationships -------------------------

    /**
     * Define a polymorphic one-to-one relationship (morphOne).
     * The related table uses two columns: a type column and an ID column.
     *
     * @param {Function} RelatedModel - The related Model class.
     * @param {string}   morphName    - Base name for the polymorphic columns (e.g. 'commentable').
     * @param {string}   [localKey]   - Local key (default: primary key).
     *
     * @example
     *   // Image can belong to either User or Post
     *   User.morphOne(Image, 'imageable');
     *   // Related table has: imageable_type, imageable_id columns
     *   const avatar = await user.load('Image'); // Image where imageable_type='User', imageable_id=user.id
     */
    static morphOne(RelatedModel, morphName, localKey)
    {
        const pk = localKey || this._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = {
            type: 'morphOne',
            model: RelatedModel,
            morphName,
            localKey: pk,
        };
    }

    /**
     * Define a polymorphic one-to-many relationship (morphMany).
     * The related table uses two columns: a type column and an ID column.
     *
     * @param {Function} RelatedModel - The related Model class.
     * @param {string}   morphName    - Base name for the polymorphic columns (e.g. 'commentable').
     * @param {string}   [localKey]   - Local key (default: primary key).
     *
     * @example
     *   // Comments can belong to either Post or Video
     *   Post.morphMany(Comment, 'commentable');
     *   const comments = await post.load('Comment');
     */
    static morphMany(RelatedModel, morphName, localKey)
    {
        const pk = localKey || this._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = {
            type: 'morphMany',
            model: RelatedModel,
            morphName,
            localKey: pk,
        };
    }

    /**
     * Define a has-many-through relationship.
     * Accesses distant relations through an intermediate table.
     *
     * @param {Function} RelatedModel      - The distant related Model class.
     * @param {Function} ThroughModel      - The intermediate Model class.
     * @param {string}   firstKey          - FK on the through table referencing this model.
     * @param {string}   secondKey         - FK on the related table referencing the through table.
     * @param {string}   [localKey]        - Local key (default: primary key).
     * @param {string}   [secondLocalKey]  - Key on the through table matched by secondKey (default: through model PK).
     *
     * @example
     *   // Country → User → Post
     *   // A country has many posts through users
     *   Country.hasManyThrough(Post, User, 'countryId', 'userId');
     *   const posts = await country.load('Post');
     */
    static hasManyThrough(RelatedModel, ThroughModel, firstKey, secondKey, localKey, secondLocalKey)
    {
        const pk = localKey || this._primaryKey();
        const throughPk = secondLocalKey || ThroughModel._primaryKey();
        if (!this._relations) this._relations = {};
        this._relations[RelatedModel.name] = {
            type: 'hasManyThrough',
            model: RelatedModel,
            through: ThroughModel,
            firstKey,
            secondKey,
            localKey: pk,
            secondLocalKey: throughPk,
        };
    }

    /**
     * Define a self-referential relationship for tree/graph structures.
     * Sets up both parent and children relationships.
     *
     * @param {object}   opts              - Relationship options.
     * @param {string}   opts.foreignKey   - FK column referencing self (e.g. 'parentId').
     * @param {string}   [opts.localKey]   - Local key (default: primary key).
     * @param {string}   [opts.parentName='parent']     - Name for the parent relationship.
     * @param {string}   [opts.childrenName='children']  - Name for the children relationship.
     *
     * @example
     *   Category.selfReferential({
     *       foreignKey: 'parentId',
     *       parentName: 'parent',
     *       childrenName: 'children',
     *   });
     *
     *   const parent = await category.load('parent');
     *   const children = await category.load('children');
     *   const tree = await Category.tree(); // full tree structure
     */
    static selfReferential(opts = {})
    {
        if (!opts.foreignKey) throw new Error('selfReferential requires foreignKey');
        const pk = opts.localKey || this._primaryKey();
        const parentName = opts.parentName || 'parent';
        const childrenName = opts.childrenName || 'children';

        if (!this._relations) this._relations = {};

        // Parent relationship (belongsTo self)
        this._relations[parentName] = {
            type: 'belongsTo',
            model: this,
            foreignKey: opts.foreignKey,
            localKey: pk,
        };

        // Children relationship (hasMany self)
        this._relations[childrenName] = {
            type: 'hasMany',
            model: this,
            foreignKey: opts.foreignKey,
            localKey: pk,
        };
    }

    /**
     * Build a full tree structure from self-referential records.
     * Returns nested objects with a `children` array property.
     *
     * @param {object}   [options]           - Configuration options.
     * @param {string}   [options.foreignKey='parentId'] - FK column for the parent reference.
     * @param {string}   [options.childrenKey='children'] - Property name for nested children.
     * @param {*}        [options.rootValue=null]         - Value of foreignKey that indicates a root node.
     * @returns {Promise<object[]>} Array of root nodes with nested children.
     *
     * @example
     *   const tree = await Category.tree({ foreignKey: 'parentId' });
     *   // [{ id: 1, name: 'Root', children: [{ id: 2, name: 'Child', children: [] }] }]
     */
    static async tree(options = {})
    {
        const { foreignKey = 'parentId', childrenKey = 'children', rootValue = null } = options;
        const all = await this.find();
        const pk = this._primaryKey();
        const map = new Map();
        const roots = [];

        for (const node of all) { node[childrenKey] = []; map.set(node[pk], node); }

        for (const node of all)
        {
            const parentId = node[foreignKey];
            if (parentId === rootValue || parentId === null || parentId === undefined)
            {
                roots.push(node);
            }
            else
            {
                const parent = map.get(parentId);
                if (parent) parent[childrenKey].push(node);
                else roots.push(node); // orphan → treat as root
            }
        }

        return roots;
    }

    /**
     * Get all ancestors of this instance in a self-referential tree.
     *
     * @param {string} [foreignKey='parentId'] - FK column for the parent reference.
     * @returns {Promise<Model[]>} Array of ancestors from immediate parent to root.
     *
     * @example
     *   const ancestors = await category.ancestors('parentId');
     *   // [parentCategory, grandparentCategory, rootCategory]
     */
    async ancestors(foreignKey = 'parentId')
    {
        const ctor = this.constructor;
        const pk = ctor._primaryKey();
        const result = [];
        let currentId = this[foreignKey];
        const seen = new Set();

        while (currentId !== null && currentId !== undefined)
        {
            if (seen.has(currentId)) break; // circular reference guard
            seen.add(currentId);
            const parent = await ctor.findById(currentId);
            if (!parent) break;
            result.push(parent);
            currentId = parent[foreignKey];
        }

        return result;
    }

    /**
     * Get all descendants of this instance in a self-referential tree.
     *
     * @param {string} [foreignKey='parentId'] - FK column for the parent reference.
     * @returns {Promise<Model[]>} Flat array of all descendants (breadth-first).
     *
     * @example
     *   const descendants = await category.descendants('parentId');
     */
    async descendants(foreignKey = 'parentId')
    {
        const ctor = this.constructor;
        const pk = ctor._primaryKey();
        const result = [];
        const queue = [this[pk]];
        const seen = new Set([this[pk]]);

        while (queue.length)
        {
            const parentId = queue.shift();
            const children = await ctor.find({ [foreignKey]: parentId });
            for (const child of children)
            {
                if (seen.has(child[pk])) continue; // circular reference guard
                seen.add(child[pk]);
                result.push(child);
                queue.push(child[pk]);
            }
        }

        return result;
    }
}

module.exports = Model;
