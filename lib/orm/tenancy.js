/**
 * @module orm/tenancy
 * @description Multi-tenancy support for the ORM.
 *              Provides schema-based tenancy (PostgreSQL) and row-level tenancy
 *              with automatic scoping, tenant middleware, and tenant-aware migrations.
 *
 * @example
 *   const { TenantManager } = require('zero-http');
 *
 *   // Row-level tenancy
 *   const tenants = new TenantManager(db, {
 *       strategy: 'row',
 *       tenantColumn: 'tenant_id',
 *   });
 *
 *   tenants.setCurrentTenant('acme');
 *   const users = await User.find(); // auto-scoped to tenant_id = 'acme'
 */

const log = require('../debug')('zero:orm:tenancy');

// -- Tenant Context (async-local-like) -----------------------

/**
 * @private
 * Simple tenant context store.  Uses a stack so nested `withTenant` calls work.
 */
class TenantContext
{
    constructor()
    {
        /** @type {string|null} */
        this._current = null;
    }

    get()  { return this._current; }
    set(v) { this._current = v; }
    clear() { this._current = null; }
}

// -- TenantManager -------------------------------------------

/**
 * Multi-tenancy manager.
 * Supports two strategies:
 *   - `'row'`    — adds a tenant column to every query (row-level isolation)
 *   - `'schema'` — uses separate database schemas per tenant (PostgreSQL)
 */
class TenantManager
{
    /**
     * @constructor
     * @param {import('./index').Database} db - Database instance.
     * @param {object} options - Tenancy configuration.
     * @param {string} [options.strategy='row']       - Tenancy strategy: `'row'` or `'schema'`.
     * @param {string} [options.tenantColumn='tenant_id'] - Column name for row-level tenancy.
     * @param {string} [options.defaultSchema='public']   - Default schema name (schema strategy).
     * @param {string} [options.schemaPrefix='tenant_']   - Schema name prefix (schema strategy).
     *
     * @example
     *   const tenants = new TenantManager(db, {
     *       strategy: 'row',
     *       tenantColumn: 'tenant_id',
     *   });
     */
    constructor(db, options = {})
    {
        if (!db) throw new Error('TenantManager requires a Database instance');

        /** @type {import('./index').Database} */
        this.db = db;

        /** @type {string} */
        this.strategy = options.strategy || 'row';

        /** @type {string} */
        this.tenantColumn = options.tenantColumn || 'tenant_id';

        /** @type {string} */
        this.defaultSchema = options.defaultSchema || 'public';

        /** @type {string} */
        this.schemaPrefix = options.schemaPrefix || 'tenant_';

        /** @type {TenantContext} */
        this._context = new TenantContext();

        /** @type {Set<string>} Known tenant IDs (for validation). */
        this._knownTenants = new Set();

        /** @type {Set<typeof import('./model')>} Models registered for tenancy. */
        this._models = new Set();

        if (this.strategy !== 'row' && this.strategy !== 'schema')
        {
            throw new Error(`Unknown tenancy strategy "${this.strategy}". Use "row" or "schema".`);
        }

        log('TenantManager created', { strategy: this.strategy });
    }

    // -- Tenant Identity ---------------------------------

    /**
     * Set the current tenant for all subsequent queries.
     *
     * @param {string} tenantId - Tenant identifier.
     * @returns {TenantManager} this (for chaining)
     *
     * @example
     *   tenants.setCurrentTenant('acme');
     */
    setCurrentTenant(tenantId)
    {
        if (!tenantId || typeof tenantId !== 'string')
        {
            throw new Error('tenantId must be a non-empty string');
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || tenantId.length > 128)
        {
            throw new Error('tenantId must be alphanumeric (with _ or -), max 128 characters');
        }
        this._context.set(tenantId);
        log('tenant set', tenantId);
        return this;
    }

    /**
     * Get the current tenant ID.
     *
     * @returns {string|null} Current tenant ID, or null if none set.
     *
     * @example
     *   const id = tenants.getCurrentTenant(); // 'acme'
     */
    getCurrentTenant()
    {
        return this._context.get();
    }

    /**
     * Clear the current tenant context.
     *
     * @returns {TenantManager} this (for chaining)
     */
    clearTenant()
    {
        this._context.clear();
        return this;
    }

    /**
     * Execute a function within a specific tenant context.
     * Restores the previous tenant after the callback completes.
     *
     * @param {string}   tenantId - Tenant ID.
     * @param {Function} fn       - Async callback.
     * @returns {Promise<*>} Result of fn().
     *
     * @example
     *   await tenants.withTenant('acme', async () => {
     *       const users = await User.find();
     *       // users are scoped to acme
     *   });
     */
    async withTenant(tenantId, fn)
    {
        const prev = this._context.get();
        this.setCurrentTenant(tenantId);
        try
        {
            return await fn();
        }
        finally
        {
            if (prev) this._context.set(prev);
            else      this._context.clear();
        }
    }

    // -- Model Registration ------------------------------

    /**
     * Register a Model class for tenant scoping.
     * For row-level tenancy, this patches the model's query methods to auto-filter.
     *
     * @param {typeof import('./model')} ModelClass - Model class to scope.
     * @returns {TenantManager} this (for chaining)
     *
     * @example
     *   tenants.addModel(User);
     *   tenants.addModel(Post);
     */
    addModel(ModelClass)
    {
        if (this._models.has(ModelClass)) return this;
        this._models.add(ModelClass);

        if (this.strategy === 'row')
        {
            this._patchModelForRowTenancy(ModelClass);
        }

        log('model registered for tenancy', ModelClass.table || ModelClass.name);
        return this;
    }

    /**
     * Register multiple Model classes for tenant scoping.
     *
     * @param {...typeof import('./model')} models - Model classes.
     * @returns {TenantManager} this (for chaining)
     *
     * @example
     *   tenants.addModels(User, Post, Comment);
     */
    addModels(...models)
    {
        for (const M of models) this.addModel(M);
        return this;
    }

    // -- Row-Level Tenancy Patching ----------------------

    /**
     * @private
     * Patch a Model for row-level tenancy.
     * Wraps query(), create(), createMany() to inject tenant filtering.
     */
    _patchModelForRowTenancy(ModelClass)
    {
        const manager = this;
        const col = this.tenantColumn;

        // Store originals
        const origQuery      = ModelClass.query.bind(ModelClass);
        const origCreate     = ModelClass.create.bind(ModelClass);
        const origCreateMany = ModelClass.createMany.bind(ModelClass);
        const origFind       = ModelClass.find.bind(ModelClass);
        const origFindOne    = ModelClass.findOne.bind(ModelClass);
        const origFindById   = ModelClass.findById.bind(ModelClass);
        const origCount      = ModelClass.count.bind(ModelClass);
        const origExists     = ModelClass.exists.bind(ModelClass);

        // Patch query() — all query builder paths
        ModelClass.query = function ()
        {
            const q = origQuery();
            const tid = manager.getCurrentTenant();
            if (tid) q.where(col, tid);
            return q;
        };

        // Patch create() — inject tenant column
        ModelClass.create = async function (data)
        {
            const tid = manager.getCurrentTenant();
            if (tid) data = { ...data, [col]: tid };
            return origCreate(data);
        };

        // Patch createMany()
        ModelClass.createMany = async function (dataArray)
        {
            const tid = manager.getCurrentTenant();
            if (tid) dataArray = dataArray.map(d => ({ ...d, [col]: tid }));
            return origCreateMany(dataArray);
        };

        // Patch find()
        ModelClass.find = async function (conditions)
        {
            const tid = manager.getCurrentTenant();
            if (tid) conditions = { ...conditions, [col]: tid };
            return origFind(conditions);
        };

        // Patch findOne()
        ModelClass.findOne = async function (conditions)
        {
            const tid = manager.getCurrentTenant();
            if (tid) conditions = { ...conditions, [col]: tid };
            return origFindOne(conditions);
        };

        // Patch findById() — still applies tenant scope
        ModelClass.findById = async function (id)
        {
            const tid = manager.getCurrentTenant();
            if (!tid) return origFindById(id);
            const pk = ModelClass._primaryKey ? ModelClass._primaryKey() : 'id';
            const key = Array.isArray(pk) ? pk[0] : pk;
            return ModelClass.findOne({ [key]: id, [col]: tid });
        };

        // Patch count()
        ModelClass.count = async function (conditions)
        {
            const tid = manager.getCurrentTenant();
            if (tid) conditions = { ...conditions, [col]: tid };
            return origCount(conditions);
        };

        // Patch exists()
        ModelClass.exists = async function (conditions)
        {
            const tid = manager.getCurrentTenant();
            if (tid) conditions = { ...conditions, [col]: tid };
            return origExists(conditions);
        };
    }

    // -- Schema-Based Tenancy ----------------------------

    /**
     * Create a new tenant schema (PostgreSQL schema-based tenancy).
     * Runs all registered model syncs within the new schema.
     *
     * @param {string} tenantId - Tenant identifier (used as schema suffix).
     * @returns {Promise<void>}
     *
     * @example
     *   await tenants.createTenant('acme');
     *   // Creates schema "tenant_acme" with all model tables
     */
    async createTenant(tenantId)
    {
        if (!tenantId || typeof tenantId !== 'string')
        {
            throw new Error('tenantId must be a non-empty string');
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || tenantId.length > 128)
        {
            throw new Error('tenantId must be alphanumeric (with _ or -), max 128 characters');
        }

        if (this.strategy === 'schema')
        {
            const schema = this.schemaPrefix + tenantId;
            const adapter = this.db.adapter;

            if (typeof adapter.execute !== 'function')
            {
                throw new Error('Schema-based tenancy requires a SQL adapter');
            }

            // Sanitize schema name — only allow alphanumerics and underscores
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
            {
                throw new Error(`Invalid schema name: "${schema}"`);
            }

            await adapter.execute({ raw: `CREATE SCHEMA IF NOT EXISTS "${schema}"` });

            // Sync model tables into the new schema
            for (const ModelClass of this._models)
            {
                const table = ModelClass.table || ModelClass.name;
                const fullTable = `${schema}.${table}`;
                // Temporarily override table to include schema prefix
                const origTable = ModelClass.table;
                ModelClass.table = fullTable;
                try
                {
                    await ModelClass.sync();
                }
                finally
                {
                    ModelClass.table = origTable;
                }
            }

            this._knownTenants.add(tenantId);
            log('tenant schema created', schema);
        }
        else
        {
            // Row-level: just register the tenant
            this._knownTenants.add(tenantId);
            log('tenant registered', tenantId);
        }
    }

    /**
     * Drop a tenant schema (schema-based) or delete tenant rows (row-level).
     *
     * @param {string}  tenantId - Tenant identifier.
     * @param {object}  [options] - Drop options.
     * @param {boolean} [options.cascade=false] - CASCADE drop (schema strategy).
     * @returns {Promise<void>}
     *
     * @example
     *   await tenants.dropTenant('acme', { cascade: true });
     */
    async dropTenant(tenantId, options = {})
    {
        if (!tenantId || typeof tenantId !== 'string')
        {
            throw new Error('tenantId must be a non-empty string');
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || tenantId.length > 128)
        {
            throw new Error('tenantId must be alphanumeric (with _ or -), max 128 characters');
        }

        if (this.strategy === 'schema')
        {
            const schema = this.schemaPrefix + tenantId;
            const adapter = this.db.adapter;

            if (typeof adapter.execute !== 'function')
            {
                throw new Error('Schema-based tenancy requires a SQL adapter');
            }

            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
            {
                throw new Error(`Invalid schema name: "${schema}"`);
            }

            const cascade = options.cascade ? ' CASCADE' : '';
            await adapter.execute({ raw: `DROP SCHEMA IF EXISTS "${schema}"${cascade}` });
            log('tenant schema dropped', schema);
        }
        else
        {
            // Row-level: delete all rows belonging to this tenant
            for (const ModelClass of this._models)
            {
                const adapter = ModelClass._adapter;
                if (adapter)
                {
                    const table = ModelClass.table || ModelClass.name;
                    await adapter.execute({
                        action: 'delete',
                        table,
                        where: [{ field: this.tenantColumn, op: '=', value: tenantId }],
                    });
                }
            }
            log('tenant rows deleted', tenantId);
        }

        this._knownTenants.delete(tenantId);
    }

    /**
     * List all known tenant IDs.
     *
     * @returns {string[]} Array of tenant identifiers.
     *
     * @example
     *   const ids = tenants.listTenants(); // ['acme', 'globex']
     */
    listTenants()
    {
        return [...this._knownTenants];
    }

    /**
     * Check if a tenant exists.
     *
     * @param {string} tenantId - Tenant identifier.
     * @returns {boolean}
     */
    hasTenant(tenantId)
    {
        return this._knownTenants.has(tenantId);
    }

    // -- Tenant Middleware --------------------------------

    /**
     * Returns an HTTP middleware function that extracts the tenant ID
     * from the request and sets it on the TenantManager.
     *
     * @param {object}   [options] - Middleware options.
     * @param {string}   [options.header='x-tenant-id']     - Header to read tenant from.
     * @param {string}   [options.queryParam]                - Query parameter name (optional).
     * @param {Function} [options.extract]                   - Custom `(req) => tenantId` function.
     * @param {boolean}  [options.required=true]             - Reject requests without tenant.
     * @returns {Function} Middleware `(req, res, next) => {}`.
     *
     * @example
     *   app.use(tenants.middleware({ header: 'x-tenant-id' }));
     *
     * @example
     *   app.use(tenants.middleware({
     *       extract: (req) => req.params.tenant,
     *   }));
     */
    middleware(options = {})
    {
        const {
            header = 'x-tenant-id',
            queryParam,
            extract,
            required = true,
        } = options;

        const manager = this;

        return function tenantMiddleware(req, res, next)
        {
            let tenantId;

            if (typeof extract === 'function')
            {
                tenantId = extract(req);
            }
            else if (queryParam && req.query && req.query[queryParam])
            {
                tenantId = String(req.query[queryParam]);
            }
            else if (header && req.headers)
            {
                tenantId = req.headers[header.toLowerCase()];
            }

            if (!tenantId)
            {
                if (required)
                {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'Tenant ID required' }));
                    return;
                }
                return next();
            }

            manager.setCurrentTenant(String(tenantId));
            req.tenantId = String(tenantId);
            next();
        };
    }

    // -- Tenant-Aware Migrations -------------------------

    /**
     * Run migrations for a specific tenant.
     * For schema strategy, switches to the tenant's schema before migrating.
     * For row strategy, runs normal migrations (tables are shared).
     *
     * @param {import('./migrate').Migrator} migrator - Migrator instance.
     * @param {string} tenantId - Tenant identifier.
     * @returns {Promise<object>} Migration result.
     *
     * @example
     *   await tenants.migrate(migrator, 'acme');
     */
    async migrate(migrator, tenantId)
    {
        if (this.strategy === 'schema')
        {
            const schema = this.schemaPrefix + tenantId;
            const adapter = this.db.adapter;

            if (typeof adapter.execute !== 'function')
            {
                throw new Error('Schema-based tenancy requires a SQL adapter');
            }

            // Set search path
            await adapter.execute({ raw: `SET search_path TO "${schema}"` });
            try
            {
                return await migrator.migrate();
            }
            finally
            {
                // Restore default search path
                await adapter.execute({ raw: `SET search_path TO "${this.defaultSchema}"` });
            }
        }
        else
        {
            return migrator.migrate();
        }
    }

    /**
     * Run migrations for all known tenants.
     *
     * @param {import('./migrate').Migrator} migrator - Migrator instance.
     * @returns {Promise<Map<string, object>>} Map of tenantId → migration result.
     *
     * @example
     *   const results = await tenants.migrateAll(migrator);
     *   for (const [id, result] of results) {
     *       console.log(id, result.migrated);
     *   }
     */
    async migrateAll(migrator)
    {
        const results = new Map();
        for (const tenantId of this._knownTenants)
        {
            results.set(tenantId, await this.migrate(migrator, tenantId));
        }
        return results;
    }
}

module.exports = { TenantManager };
