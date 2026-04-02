/**
 * @module orm/audit
 * @description Automatic audit logging for the ORM.
 *              Tracks who changed what and when, with diff-based change logs.
 *              Supports storing audit trails in the same database or a separate one
 *              and provides querying capabilities for the audit trail.
 *
 * @example
 *   const { AuditLog } = require('zero-http');
 *
 *   const audit = new AuditLog(db, {
 *       actorField: 'userId',       // field on req/context identifying the actor
 *       include: [User, Post],      // models to audit
 *   });
 *
 *   // Automatically tracks creates, updates, and deletes
 *   await User.create({ name: 'Alice' }); // audit entry logged
 *
 *   // Query audit trail
 *   const trail = await audit.trail({ table: 'users', recordId: 1 });
 */

const log = require('../debug')('zero:orm:audit');

// -- AuditLog class ------------------------------------------

/**
 * Automatic change tracking for ORM models.
 * Records who changed what and when, with diff-based change logs.
 */
class AuditLog
{
    /**
     * @constructor
     * @param {import('./index').Database} db - Database instance for storing audit entries.
     * @param {object} options - Audit configuration.
     * @param {string} [options.table='_audit_log']     - Table name for audit entries.
     * @param {Array<typeof import('./model')>} [options.include]  - Models to audit (all registered if omitted).
     * @param {Array<typeof import('./model')>} [options.exclude]  - Models to exclude from auditing.
     * @param {string[]} [options.excludeFields]        - Fields to never log (e.g. passwords).
     * @param {string} [options.actorField]             - Context property for the actor identifier.
     * @param {import('./index').Database} [options.storage] - Separate database for audit storage.
     * @param {boolean} [options.timestamps=true]       - Include timestamps in audit entries.
     * @param {boolean} [options.diffs=true]            - Store field-level diffs for updates.
     *
     * @example
     *   const audit = new AuditLog(db, {
     *       table: '_audit_log',
     *       include: [User, Post],
     *       excludeFields: ['password', 'token'],
     *       diffs: true,
     *   });
     */
    constructor(db, options = {})
    {
        if (!db) throw new Error('AuditLog requires a Database instance');

        /** @type {import('./index').Database} */
        this.db = db;

        /** @type {string} */
        this.tableName = options.table || '_audit_log';

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.tableName))
        {
            throw new Error(`Invalid audit table name: "${this.tableName}"`);
        }

        /** @type {Set<typeof import('./model')>|null} */
        this._include = options.include ? new Set(options.include) : null;

        /** @type {Set<typeof import('./model')>} */
        this._exclude = new Set(options.exclude || []);

        /** @type {Set<string>} */
        this._excludeFields = new Set(options.excludeFields || []);

        /** @type {string|null} */
        this._actorField = options.actorField || null;

        /** @type {import('./index').Database} */
        this._storage = options.storage || db;

        /** @type {boolean} */
        this._timestamps = options.timestamps !== false;

        /** @type {boolean} */
        this._diffs = options.diffs !== false;

        /** @type {string|null} Current actor for audit entries. */
        this._currentActor = null;

        /** @type {boolean} */
        this._initialized = false;

        /** @type {Set<typeof import('./model')>} Models currently being audited. */
        this._auditedModels = new Set();

        log('AuditLog created', { table: this.tableName });
    }

    // -- Setup -------------------------------------------

    /**
     * Initialize the audit log table and attach hooks to models.
     * Must be called after models are registered and synced.
     *
     * @returns {Promise<AuditLog>} this (for chaining)
     *
     * @example
     *   await audit.install();
     */
    async install()
    {
        // Create the audit log table
        const adapter = this._storage.adapter;

        if (typeof adapter.execute === 'function')
        {
            // SQL adapter
            const sql =
                `CREATE TABLE IF NOT EXISTS "${this.tableName}" (` +
                `"id" INTEGER PRIMARY KEY ${adapter.constructor.name === 'PostgresAdapter' ? 'GENERATED ALWAYS AS IDENTITY' : 'AUTOINCREMENT'},` +
                `"action" TEXT NOT NULL,` +
                `"table_name" TEXT NOT NULL,` +
                `"record_id" TEXT,` +
                `"actor" TEXT,` +
                `"old_values" TEXT,` +
                `"new_values" TEXT,` +
                `"diff" TEXT,` +
                `"timestamp" TEXT NOT NULL DEFAULT (datetime('now'))` +
                `)`;
            await adapter.execute({ raw: sql });
        }
        else
        {
            // Memory/JSON adapter — ensure table structure
            if (typeof adapter.createTable === 'function')
            {
                const schema = {
                    id:         { type: 'integer', primaryKey: true, autoIncrement: true },
                    action:     { type: 'string', required: true },
                    table_name: { type: 'string', required: true },
                    record_id:  { type: 'string' },
                    actor:      { type: 'string' },
                    old_values: { type: 'text' },
                    new_values: { type: 'text' },
                    diff:       { type: 'text' },
                    timestamp:  { type: 'string' },
                };
                await adapter.createTable(this.tableName, schema);
            }
        }

        // Attach hooks to models
        const models = this._include
            ? [...this._include]
            : [...this.db._models.values()];

        for (const ModelClass of models)
        {
            if (this._exclude.has(ModelClass)) continue;
            this._attachHooks(ModelClass);
        }

        this._initialized = true;
        log('AuditLog installed', { models: this._auditedModels.size });
        return this;
    }

    // -- Actor Management --------------------------------

    /**
     * Set the current actor (user) performing operations.
     *
     * @param {string} actor - Actor identifier (user ID, email, etc.).
     * @returns {AuditLog} this (for chaining)
     *
     * @example
     *   audit.setActor('user-123');
     */
    setActor(actor)
    {
        this._currentActor = actor != null ? String(actor) : null;
        return this;
    }

    /**
     * Get the current actor.
     *
     * @returns {string|null} Current actor identifier.
     */
    getActor()
    {
        return this._currentActor;
    }

    /**
     * Execute a function within a specific actor context.
     *
     * @param {string}   actor - Actor identifier.
     * @param {Function} fn    - Async callback.
     * @returns {Promise<*>} Result of fn().
     *
     * @example
     *   await audit.withActor('admin', async () => {
     *       await User.create({ name: 'New User' });
     *   });
     */
    async withActor(actor, fn)
    {
        const prev = this._currentActor;
        this.setActor(actor);
        try
        {
            return await fn();
        }
        finally
        {
            this._currentActor = prev;
        }
    }

    // -- Hook Attachment ---------------------------------

    /**
     * @private
     * Attach lifecycle hooks to a model for audit logging.
     */
    _attachHooks(ModelClass)
    {
        if (this._auditedModels.has(ModelClass)) return;
        this._auditedModels.add(ModelClass);

        const audit = this;
        const table = ModelClass.table || ModelClass.name;

        // Use model events if available
        if (typeof ModelClass.on === 'function')
        {
            ModelClass.on('created', (instance) =>
            {
                audit._logEntry('create', table, instance).catch(() => {});
            });

            ModelClass.on('updated', (instance) =>
            {
                audit._logEntry('update', table, instance).catch(() => {});
            });

            ModelClass.on('deleted', (instance) =>
            {
                audit._logEntry('delete', table, instance).catch(() => {});
            });
        }
        else
        {
            // Fallback: patch static methods
            const origCreate = ModelClass.create.bind(ModelClass);
            ModelClass.create = async function (data)
            {
                const result = await origCreate(data);
                await audit._logEntry('create', table, result);
                return result;
            };
        }

        log('hooks attached', table);
    }

    // -- Entry Logging -----------------------------------

    /**
     * @private
     * Log a single audit entry.
     */
    async _logEntry(action, tableName, instance)
    {
        try
        {
            const pk = this._extractPK(instance);
            const filtered = this._filterFields(instance);

            const entry = {
                action,
                table_name: tableName,
                record_id:  pk != null ? String(pk) : null,
                actor:      this._currentActor,
                timestamp:  new Date().toISOString(),
            };

            if (action === 'create')
            {
                entry.old_values = null;
                entry.new_values = JSON.stringify(filtered);
                entry.diff = null;
            }
            else if (action === 'update')
            {
                const original = instance._original || {};
                const oldFiltered = this._filterFields(original);
                entry.old_values = JSON.stringify(oldFiltered);
                entry.new_values = JSON.stringify(filtered);

                if (this._diffs)
                {
                    entry.diff = JSON.stringify(this._computeDiff(oldFiltered, filtered));
                }
            }
            else if (action === 'delete')
            {
                entry.old_values = JSON.stringify(filtered);
                entry.new_values = null;
                entry.diff = null;
            }

            await this._writeEntry(entry);
        }
        catch (err)
        {
            log('audit entry failed', err.message);
        }
    }

    /**
     * @private
     * Write an audit entry to storage.
     */
    async _writeEntry(entry)
    {
        const adapter = this._storage.adapter;

        if (typeof adapter.execute === 'function')
        {
            // SQL adapter
            await adapter.execute({
                action: 'insert',
                table: this.tableName,
                data: entry,
            });
        }
        else if (typeof adapter.insert === 'function')
        {
            await adapter.insert(this.tableName, entry);
        }
    }

    /**
     * @private
     * Extract primary key value from an instance.
     */
    _extractPK(instance)
    {
        if (!instance) return null;

        // Handle plain objects and model instances
        const data = typeof instance.toJSON === 'function' ? instance.toJSON() : instance;
        return data.id || data._id || null;
    }

    /**
     * @private
     * Filter out excluded fields from data.
     */
    _filterFields(data)
    {
        if (!data || typeof data !== 'object') return {};

        const source = typeof data.toJSON === 'function' ? data.toJSON() : { ...data };
        const result = {};

        for (const [key, value] of Object.entries(source))
        {
            if (key.startsWith('_')) continue;
            if (this._excludeFields.has(key)) continue;
            result[key] = value;
        }

        return result;
    }

    // -- Diff Computation --------------------------------

    /**
     * Compute a diff between old and new values.
     * Returns an array of `{ field, from, to }` objects.
     *
     * @param {object} oldValues - Previous data.
     * @param {object} newValues - Current data.
     * @returns {Array<{field: string, from: *, to: *}>}
     *
     * @example
     *   const diff = audit.diff({ name: 'Alice' }, { name: 'Bob' });
     *   // [{ field: 'name', from: 'Alice', to: 'Bob' }]
     */
    diff(oldValues, newValues)
    {
        return this._computeDiff(oldValues, newValues);
    }

    /**
     * @private
     */
    _computeDiff(oldValues, newValues)
    {
        const changes = [];
        const allKeys = new Set([
            ...Object.keys(oldValues || {}),
            ...Object.keys(newValues || {}),
        ]);

        for (const key of allKeys)
        {
            const oldVal = oldValues ? oldValues[key] : undefined;
            const newVal = newValues ? newValues[key] : undefined;

            // Deep equality via JSON comparison for objects/arrays
            const oldStr = JSON.stringify(oldVal);
            const newStr = JSON.stringify(newVal);

            if (oldStr !== newStr)
            {
                changes.push({ field: key, from: oldVal, to: newVal });
            }
        }

        return changes;
    }

    // -- Querying Audit Trail ----------------------------

    /**
     * Query the audit trail.
     *
     * @param {object}  [options] - Filter options.
     * @param {string}  [options.table]    - Filter by table name.
     * @param {string}  [options.action]   - Filter by action (create, update, delete).
     * @param {string}  [options.recordId] - Filter by record ID.
     * @param {string}  [options.actor]    - Filter by actor.
     * @param {string}  [options.since]    - ISO timestamp lower bound.
     * @param {string}  [options.until]    - ISO timestamp upper bound.
     * @param {number}  [options.limit=100] - Maximum entries.
     * @param {number}  [options.offset=0]  - Skip entries.
     * @param {string}  [options.order='desc'] - Sort order by timestamp.
     * @returns {Promise<Array>} Audit entries.
     *
     * @example
     *   const entries = await audit.trail({ table: 'users', recordId: '1' });
     *   const updates = await audit.trail({ action: 'update', limit: 50 });
     */
    async trail(options = {})
    {
        const { table, action, recordId, actor, since, until, limit = 100, offset = 0, order = 'desc' } = options;
        const adapter = this._storage.adapter;

        const where = [];
        if (table)    where.push({ field: 'table_name', op: '=', value: table });
        if (action)   where.push({ field: 'action', op: '=', value: action });
        if (recordId) where.push({ field: 'record_id', op: '=', value: String(recordId) });
        if (actor)    where.push({ field: 'actor', op: '=', value: actor });
        if (since)    where.push({ field: 'timestamp', op: '>=', value: since });
        if (until)    where.push({ field: 'timestamp', op: '<=', value: until });

        const descriptor = {
            action: 'find',
            table: this.tableName,
            where,
            orderBy: [{ field: 'timestamp', direction: order }],
            limit,
            offset,
        };

        let rows;
        if (typeof adapter.execute === 'function')
        {
            rows = await adapter.execute(descriptor);
        }
        else if (typeof adapter.find === 'function')
        {
            rows = await adapter.find(this.tableName, descriptor);
        }
        else
        {
            rows = [];
        }

        // Parse JSON fields
        return (rows || []).map(row => ({
            ...row,
            old_values: row.old_values ? JSON.parse(row.old_values) : null,
            new_values: row.new_values ? JSON.parse(row.new_values) : null,
            diff: row.diff ? JSON.parse(row.diff) : null,
        }));
    }

    /**
     * Get the audit history for a specific record.
     *
     * @param {string}        table    - Table name.
     * @param {string|number} recordId - Record ID.
     * @param {object}        [options] - Additional filter options.
     * @returns {Promise<Array>} Audit entries for the record.
     *
     * @example
     *   const history = await audit.history('users', 1);
     */
    async history(table, recordId, options = {})
    {
        return this.trail({ ...options, table, recordId: String(recordId) });
    }

    /**
     * Get audit entries grouped by actor.
     *
     * @param {object} [options] - Filter options.
     * @returns {Promise<Map<string, Array>>} Map of actor → entries.
     */
    async byActor(options = {})
    {
        const entries = await this.trail({ ...options, limit: options.limit || 1000 });
        const grouped = new Map();

        for (const entry of entries)
        {
            const actor = entry.actor || '__unknown__';
            if (!grouped.has(actor)) grouped.set(actor, []);
            grouped.get(actor).push(entry);
        }

        return grouped;
    }

    /**
     * Count audit entries matching the given filters.
     *
     * @param {object} [options] - Same filter options as trail().
     * @returns {Promise<number>}
     *
     * @example
     *   const count = await audit.count({ table: 'users', action: 'update' });
     */
    async count(options = {})
    {
        const { table, action, recordId, actor, since, until } = options;
        const adapter = this._storage.adapter;

        const where = [];
        if (table)    where.push({ field: 'table_name', op: '=', value: table });
        if (action)   where.push({ field: 'action', op: '=', value: action });
        if (recordId) where.push({ field: 'record_id', op: '=', value: String(recordId) });
        if (actor)    where.push({ field: 'actor', op: '=', value: actor });
        if (since)    where.push({ field: 'timestamp', op: '>=', value: since });
        if (until)    where.push({ field: 'timestamp', op: '<=', value: until });

        if (typeof adapter.execute === 'function')
        {
            const result = await adapter.execute({
                action: 'count',
                table: this.tableName,
                where,
            });
            return typeof result === 'number' ? result : (result && result[0] ? result[0].count || 0 : 0);
        }

        // Fallback: fetch all and count
        const entries = await this.trail(options);
        return entries.length;
    }

    /**
     * Purge old audit entries.
     *
     * @param {object} options - Purge options.
     * @param {string} [options.before]    - ISO timestamp; delete entries older than this.
     * @param {string} [options.table]     - Only purge entries for this table.
     * @param {number} [options.keepLast]  - Keep at least this many entries per record.
     * @returns {Promise<number>} Number of entries purged.
     *
     * @example
     *   const purged = await audit.purge({ before: '2025-01-01T00:00:00Z' });
     */
    async purge(options = {})
    {
        const { before, table } = options;
        const adapter = this._storage.adapter;

        const where = [];
        if (before) where.push({ field: 'timestamp', op: '<', value: before });
        if (table)  where.push({ field: 'table_name', op: '=', value: table });

        if (where.length === 0)
        {
            throw new Error('purge() requires at least one filter (before or table)');
        }

        if (typeof adapter.execute === 'function')
        {
            const result = await adapter.execute({
                action: 'delete',
                table: this.tableName,
                where,
            });
            const count = typeof result === 'number' ? result : (result && result.changes ? result.changes : 0);
            log('purged entries', count);
            return count;
        }

        return 0;
    }

    /**
     * Returns an HTTP middleware that sets the actor from the request.
     *
     * @param {object}   [options] - Options.
     * @param {Function} [options.extract] - Custom `(req) => actorId` function.
     * @param {string}   [options.header='x-user-id'] - Header to read actor from.
     * @returns {Function} Middleware `(req, res, next) => {}`.
     *
     * @example
     *   app.use(audit.middleware({ extract: (req) => req.user?.id }));
     */
    middleware(options = {})
    {
        const { extract, header = 'x-user-id' } = options;
        const auditLog = this;

        return function auditMiddleware(req, res, next)
        {
            let actor;
            if (typeof extract === 'function')
            {
                actor = extract(req);
            }
            else if (header && req.headers)
            {
                actor = req.headers[header.toLowerCase()];
            }

            if (actor)
            {
                auditLog.setActor(String(actor));
            }

            next();
        };
    }
}

module.exports = { AuditLog };
