/**
 * @module orm/views
 * @description Database view management for the ORM.
 *              Supports creating, dropping, and querying database views.
 *              View-backed models are read-only by default.
 *
 * @section Views
 *
 * @example
 *   const { DatabaseView } = require('zero-http');
 *
 *   // Define a view
 *   const activeUsers = new DatabaseView('active_users', {
 *       query: User.query().where('active', true).select('id', 'name', 'email'),
 *       model: User,
 *   });
 *
 *   // Create the view in the database
 *   await activeUsers.create(db);
 *
 *   // Query the view
 *   const users = await activeUsers.all();
 *   const user = await activeUsers.findOne({ name: 'Alice' });
 */

const Model = require('./model');
const Query = require('./query');
const log = require('../debug')('zero:orm:views');

// -- DatabaseView class -----------------------------------

/**
 * Represents a database view.
 * Wraps a query definition and provides read-only access through a model-like API.
 */
class DatabaseView
{
    /**
     * @constructor
     * @param {string} name     - View name.
     * @param {object} options  - View configuration.
     * @param {Query}  [options.query]      - Query builder instance defining the view's SELECT.
     * @param {string} [options.sql]        - Raw SQL for the view definition (SQL adapters only).
     * @param {typeof Model} [options.model] - Model class the view is based on.
     * @param {object} [options.schema]     - Column schema for the view (optional; inferred from model if omitted).
     * @param {boolean} [options.materialized=false] - Whether to create a materialized view (PostgreSQL only).
     */
    constructor(name, options = {})
    {
        if (!name || typeof name !== 'string')
        {
            throw new Error('DatabaseView requires a non-empty string name');
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
        {
            throw new Error(`Invalid view name: "${name}"`);
        }

        /** @type {string} View name. */
        this.name = name;

        /** @type {Query|null} Query builder defining the view. */
        this._query = options.query || null;

        /** @type {string|null} Raw SQL for view definition. */
        this._sql = options.sql || null;

        /** @type {typeof Model|null} Base model class. */
        this._model = options.model || null;

        /** @type {object|null} Column schema for the view. */
        this._schema = options.schema || null;

        /** @type {boolean} Whether this is a materialized view. */
        this._materialized = options.materialized === true;

        /** @type {object|null} The database adapter. */
        this._adapter = null;

        /** @type {typeof Model|null} The generated view model. */
        this._viewModel = null;

        if (!this._query && !this._sql)
        {
            throw new Error('DatabaseView requires either a query or sql option');
        }
    }

    /**
     * Create the view in the database.
     * For SQL adapters, issues CREATE VIEW (or CREATE MATERIALIZED VIEW).
     * For memory/JSON adapters, stores the query definition for execution.
     *
     * @param {object} db - Database instance.
     * @returns {Promise<DatabaseView>} `this` for chaining.
     *
     * @example
     *   await activeUsers.create(db);
     */
    async create(db)
    {
        this._adapter = db.adapter;

        if (typeof this._adapter.createView === 'function')
        {
            const sql = this._sql || this._buildSQL();
            await this._adapter.createView(this.name, sql, { materialized: this._materialized });
        }

        // Create the view-backed model
        this._viewModel = this._createViewModel(db);

        log.debug('view %s created', this.name);
        return this;
    }

    /**
     * Drop the view from the database.
     *
     * @param {object} db - Database instance.
     * @returns {Promise<void>}
     */
    async drop(db)
    {
        const adapter = db ? db.adapter : this._adapter;
        if (!adapter) throw new Error('No database adapter available');

        if (typeof adapter.dropView === 'function')
        {
            await adapter.dropView(this.name, { materialized: this._materialized });
        }

        this._viewModel = null;
        log.debug('view %s dropped', this.name);
    }

    /**
     * Refresh a materialized view (PostgreSQL only).
     *
     * @param {object} [db] - Database instance.
     * @returns {Promise<void>}
     */
    async refresh(db)
    {
        const adapter = db ? db.adapter : this._adapter;
        if (!adapter) throw new Error('No database adapter available');

        if (!this._materialized)
        {
            throw new Error('Only materialized views can be refreshed');
        }

        if (typeof adapter.refreshView === 'function')
        {
            await adapter.refreshView(this.name);
        }

        log.debug('view %s refreshed', this.name);
    }

    /**
     * Check whether the view exists.
     *
     * @param {object} [db] - Database instance.
     * @returns {Promise<boolean>} True if the view exists.
     */
    async exists(db)
    {
        const adapter = db ? db.adapter : this._adapter;
        if (!adapter) throw new Error('No database adapter available');

        if (typeof adapter.hasTable === 'function')
        {
            return adapter.hasTable(this.name);
        }
        return false;
    }

    /**
     * Query all records from the view.
     *
     * @returns {Promise<Array>} All rows from the view.
     */
    async all()
    {
        return this._executeQuery();
    }

    /**
     * Find records from the view matching conditions.
     *
     * @param {object} conditions - WHERE conditions.
     * @returns {Promise<Array>} Matching rows.
     */
    async find(conditions = {})
    {
        return this._executeQuery(conditions);
    }

    /**
     * Find a single record from the view.
     *
     * @param {object} conditions - WHERE conditions.
     * @returns {Promise<object|null>} First matching row or null.
     */
    async findOne(conditions = {})
    {
        const results = await this._executeQuery(conditions, 1);
        return results[0] || null;
    }

    /**
     * Count records in the view.
     *
     * @param {object} [conditions={}] - Optional WHERE conditions.
     * @returns {Promise<number>} Number of matching records.
     */
    async count(conditions = {})
    {
        if (this._viewModel)
        {
            return this._viewModel.count(conditions);
        }
        const results = await this._executeQuery(conditions);
        return results.length;
    }

    /**
     * Start a fluent query against the view.
     *
     * @returns {Query} Query builder targeting the view.
     */
    query()
    {
        if (this._viewModel)
        {
            return this._viewModel.query();
        }
        throw new Error('View model not created. Call create() first.');
    }

    /**
     * Execute the view query with optional conditions.
     * @param {object} [conditions={}] - WHERE conditions.
     * @param {number} [limit] - Optional limit.
     * @returns {Promise<Array>} Results.
     * @private
     */
    async _executeQuery(conditions = {}, limit)
    {
        if (this._viewModel)
        {
            let q = this._viewModel.query().where(conditions);
            if (limit) q = q.limit(limit);
            return q.exec();
        }

        // Fallback: re-execute the source query with additional filters
        if (this._query)
        {
            // Clone the query state
            const src = this._query;
            const model = src._model;
            const q = model.query();
            q._fields = src._fields;
            q._where = [...src._where];
            q._orderBy = [...src._orderBy];
            q._limitVal = limit || src._limitVal;
            q._offsetVal = src._offsetVal;

            // Add additional conditions
            if (Object.keys(conditions).length)
            {
                q.where(conditions);
            }

            return q.exec();
        }

        return [];
    }

    /**
     * Build SQL from a Query descriptor.
     * @returns {string} SQL SELECT statement.
     * @private
     */
    _buildSQL()
    {
        if (this._sql) return this._sql;
        if (!this._query) throw new Error('No query or SQL defined for view');

        const descriptor = this._query.build();
        const table = descriptor.table;

        // Validate field names and table — identifier-safe only
        const idRe = /^[a-zA-Z_][a-zA-Z0-9_.*]*$/;
        const fields = descriptor.fields
            ? descriptor.fields.filter(f => idRe.test(f)).join(', ') || '*'
            : '*';
        if (!idRe.test(table)) throw new Error(`Invalid table name in view query: "${table}"`);

        let sql = `SELECT ${fields} FROM ${table}`;

        if (descriptor.where && descriptor.where.length)
        {
            const clauses = descriptor.where.map(w =>
            {
                if (w.raw) return w.raw;
                if (w.op === 'IS NULL') return `${w.field} IS NULL`;
                if (w.op === 'IS NOT NULL') return `${w.field} IS NOT NULL`;
                if (w.op === 'IN') return `${w.field} IN (${w.value.map(() => '?').join(',')})`;
                // Escape single quotes in values for DDL safety
                const escaped = String(w.value).replace(/'/g, "''");
                return `${w.field} ${w.op} '${escaped}'`;
            });
            sql += ` WHERE ${clauses.join(' AND ')}`;
        }

        if (descriptor.orderBy && descriptor.orderBy.length)
        {
            const orders = descriptor.orderBy.map(o => `${o.field} ${o.dir}`);
            sql += ` ORDER BY ${orders.join(', ')}`;
        }

        return sql;
    }

    /**
     * Create an internal view-backed Model class.
     * @param {object} db - Database instance.
     * @returns {typeof Model} View model class.
     * @private
     */
    _createViewModel(db)
    {
        const viewName = this.name;
        const schema = this._schema || (this._model ? this._model.schema : {});
        const ViewM = class extends Model
        {
            static table = viewName;
            static schema = { ...schema };
        };
        Object.defineProperty(ViewM, 'name', { value: `${viewName}_view` });
        db.register(ViewM);
        return ViewM;
    }
}

module.exports = { DatabaseView };
