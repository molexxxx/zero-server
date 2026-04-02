/**
 * @module orm
 * @description ORM entry point.  Provides the `Database` factory that creates
 *              a connection to a backing store, the base `Model` class, the
 *              `TYPES` enum, and schema helpers.
 *
 * Supported adapters (all optional "bring your own driver"):
 *   - `memory`  — in-process (no driver needed)
 *   - `json`    — JSON file persistence (no driver needed)
 *   - `sqlite`  — requires `better-sqlite3`
 *   - `mysql`   — requires `mysql2`
 *   - `postgres` — requires `pg`
 *   - `mongo`   — requires `mongodb`
 *
 * @example
 *   const { Database, Model, TYPES } = require('zero-http');
 *
 *   const db = Database.connect('memory');
 *
 *   class User extends Model {
 *       static table = 'users';
 *       static schema = {
 *           id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
 *           name:  { type: TYPES.STRING, required: true },
 *           email: { type: TYPES.STRING, required: true, unique: true },
 *       };
 *       static timestamps = true;
 *   }
 *
 *   db.register(User);
 *   await db.sync();
 *
 *   const user = await User.create({ name: 'Alice', email: 'a@b.com' });
 */
const Model = require('./model');
const { TYPES, validate, validateValue, validateFKAction, validateCheck } = require('./schema');
const Query = require('./query');

// -- Adapter loaders (lazy) ------------------------------

const ADAPTERS = {
    memory:   () => require('./adapters/memory'),
    json:     () => require('./adapters/json'),
    sqlite:   () => require('./adapters/sqlite'),
    mysql:    () => require('./adapters/mysql'),
    postgres: () => require('./adapters/postgres'),
    mongo:    () => require('./adapters/mongo'),
    redis:    () => require('./adapters/redis'),
};

// -- Database class --------------------------------------

/**
 * Validate adapter connection options and sanitize credentials.
 * @private
 * @param {string} type - Adapter type identifier.
 * @param {object} options - Configuration options.
 * @returns {object} sanitised options
 */
function _validateOptions(type, options)
{
    const opts = { ...options };

    // Adapters that take network credentials
    if (type === 'mysql' || type === 'postgres')
    {
        if (opts.host !== undefined)
        {
            if (typeof opts.host !== 'string' || !opts.host.trim())
                throw new Error(`${type}: "host" must be a non-empty string`);
            opts.host = opts.host.trim();
        }
        if (opts.port !== undefined)
        {
            opts.port = Number(opts.port);
            if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
                throw new Error(`${type}: "port" must be an integer 1-65535`);
        }
        if (opts.user !== undefined)
        {
            if (typeof opts.user !== 'string')
                throw new Error(`${type}: "user" must be a string`);
        }
        if (opts.password !== undefined)
        {
            if (typeof opts.password !== 'string')
                throw new Error(`${type}: "password" must be a string`);
        }
        if (opts.database !== undefined)
        {
            if (typeof opts.database !== 'string' || !opts.database.trim())
                throw new Error(`${type}: "database" must be a non-empty string`);
            opts.database = opts.database.trim();
        }
    }

    // Mongo connection string
    if (type === 'mongo')
    {
        if (opts.url !== undefined)
        {
            if (typeof opts.url !== 'string' || !opts.url.trim())
                throw new Error('mongo: "url" must be a non-empty string');
            opts.url = opts.url.trim();
        }
        if (opts.database !== undefined)
        {
            if (typeof opts.database !== 'string' || !opts.database.trim())
                throw new Error('mongo: "database" must be a non-empty string');
            opts.database = opts.database.trim();
        }
    }

    // SQLite validation
    if (type === 'sqlite')
    {
        if (opts.filename !== undefined && typeof opts.filename !== 'string')
            throw new Error('sqlite: "filename" must be a string');
    }

    // Redis validation
    if (type === 'redis')
    {
        if (opts.url !== undefined)
        {
            if (typeof opts.url !== 'string' || !opts.url.trim())
                throw new Error('redis: "url" must be a non-empty string');
            opts.url = opts.url.trim();
        }
        if (opts.host !== undefined)
        {
            if (typeof opts.host !== 'string' || !opts.host.trim())
                throw new Error('redis: "host" must be a non-empty string');
            opts.host = opts.host.trim();
        }
        if (opts.port !== undefined)
        {
            opts.port = Number(opts.port);
            if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
                throw new Error('redis: "port" must be an integer 1-65535');
        }
        if (opts.password !== undefined)
        {
            if (typeof opts.password !== 'string')
                throw new Error('redis: "password" must be a string');
        }
        if (opts.db !== undefined)
        {
            opts.db = Number(opts.db);
            if (!Number.isInteger(opts.db) || opts.db < 0)
                throw new Error('redis: "db" must be a non-negative integer');
        }
    }

    return opts;
}

class Database
{
    /**
     * @constructor
     * @param {object} adapter - Instantiated adapter.
     */
    constructor(adapter)
    {
        /** @type {object} The underlying adapter instance. */
        this.adapter = adapter;

        /** @type {Map<string, typeof Model>} Registered model classes. */
        this._models = new Map();
    }

    /**
     * Create a Database connection.
     *
     * @param {string} type    - Adapter type: memory, json, sqlite, mysql, postgres, mongo.
     * @param {object} [options] - Adapter-specific connection options.
     * @param {string} [options.host]       - Database host (mysql, postgres).
     * @param {number} [options.port]       - Database port (mysql, postgres).
     * @param {string} [options.user]       - Database user (mysql, postgres).
     * @param {string} [options.password]   - Database password (mysql, postgres).
     * @param {string} [options.database]   - Database name (mysql, postgres, mongo).
     * @param {string} [options.url]        - Connection URL (mongo, redis).
     * @param {string} [options.filename]   - Database file path (sqlite).
     * @param {string} [options.directory]  - Storage directory (json).
     * @returns {Database} Connected database instance.
     *
     * @example
     *   const db = Database.connect('sqlite', { filename: './app.db' });
     *   const db = Database.connect('mysql', { host: '127.0.0.1', user: 'root', database: 'app' });
     *   const db = Database.connect('postgres', { host: '127.0.0.1', user: 'postgres', database: 'app' });
     *   const db = Database.connect('mongo', { url: 'mongodb://localhost:27017', database: 'app' });
     *   const db = Database.connect('json', { directory: './data' });
     *   const db = Database.connect('memory');
     */
    static connect(type, options = {})
    {
        const loader = ADAPTERS[type];
        if (!loader) throw new Error(`Unknown adapter "${type}". Supported: ${Object.keys(ADAPTERS).join(', ')}`);

        const opts = _validateOptions(type, options);
        const AdapterClass = loader();
        const adapter = new AdapterClass(opts);
        return new Database(adapter);
    }

    /**
     * Register a Model class with this database.
     * Binds the adapter to the model so all CRUD operations go through it.
     *
     * @param {typeof Model} ModelClass - Model class.
     * @returns {Database} this (for chaining)
     */
    register(ModelClass)
    {
        ModelClass._adapter = this.adapter;
        this._models.set(ModelClass.table || ModelClass.name, ModelClass);
        return this;
    }

    /**
     * Register multiple Model classes at once.
     *
     * @param {...typeof Model} models - Array of Model classes.
     * @returns {Database} this (for chaining)
     */
    registerAll(...models)
    {
        for (const m of models) this.register(m);
        return this;
    }

    /**
     * Synchronise all registered models — create tables if they don't exist.
     * Tables are ordered so referenced tables are created first (topological sort).
     * @returns {Promise<void>}
     */
    async sync()
    {
        const models = [...this._models.values()];

        // Build dependency graph from schema references
        const tableMap = new Map();
        for (const M of models) tableMap.set(M.table || M.name, M);

        const ordered = this._topoSort(models);
        for (const ModelClass of ordered)
        {
            await ModelClass.sync();
        }
    }

    /**
     * Topological sort of models by FK dependencies.
     * Models that reference other models come after them.
     * @param {Array<typeof Model>} models - Array of Model classes.
     * @returns {Array<typeof Model>} Models ordered by foreign key dependencies.
     * @private
     */
    _topoSort(models)
    {
        const nameToModel = new Map();
        for (const M of models) nameToModel.set(M.table || M.name, M);

        const deps = new Map();
        for (const M of models)
        {
            const tableName = M.table || M.name;
            const references = new Set();
            if (M.schema)
            {
                for (const def of Object.values(M.schema))
                {
                    if (def.references && def.references.table && nameToModel.has(def.references.table))
                    {
                        references.add(def.references.table);
                    }
                }
            }
            deps.set(tableName, references);
        }

        const sorted = [];
        const visited = new Set();
        const visiting = new Set();

        const visit = (tableName) =>
        {
            if (visited.has(tableName)) return;
            if (visiting.has(tableName)) return; // circular ref, break cycle
            visiting.add(tableName);
            const references = deps.get(tableName) || new Set();
            for (const ref of references) visit(ref);
            visiting.delete(tableName);
            visited.add(tableName);
            sorted.push(nameToModel.get(tableName));
        };

        for (const M of models) visit(M.table || M.name);
        return sorted;
    }

    /**
     * Drop all registered model tables (in reverse order to respect FK deps).
     * @returns {Promise<void>}
     */
    async drop()
    {
        const models = [...this._models.values()].reverse();
        for (const ModelClass of models)
        {
            await ModelClass.drop();
        }
    }

    /**
     * Close the underlying connection / pool.
     * @returns {Promise<void>}
     */
    async close()
    {
        if (typeof this.adapter.close === 'function')
        {
            await this.adapter.close();
        }
    }

    /**
     * Get a registered model by table name.
     * @param {string} name - Name identifier.
     * @returns {typeof Model|undefined} The registered Model class, or undefined.
     */
    model(name)
    {
        return this._models.get(name);
    }

    /**
     * Execute a callback within a database transaction.
     * If the callback throws, the transaction is rolled back.
     * If the callback returns normally, the transaction is committed.
     *
     * Note: Transaction support depends on the adapter.
     * Memory and JSON adapters run the callback directly (no real transaction).
     *
     * @param {Function} fn - Async callback to execute within the transaction.
     * @returns {Promise<*>} The return value of the callback.
     *
     * @example
     *   await db.transaction(async () => {
     *       await User.create({ name: 'Alice', email: 'a@b.com' });
     *       await Account.create({ userId: 1, balance: 100 });
     *   });
     */
    async transaction(fn)
    {
        if (typeof this.adapter.beginTransaction === 'function')
        {
            await this.adapter.beginTransaction();
            try
            {
                const result = await fn();
                await this.adapter.commit();
                return result;
            }
            catch (err)
            {
                await this.adapter.rollback();
                throw err;
            }
        }
        // Adapters without transaction support run directly
        return fn();
    }

    // -- Migration / DDL Convenience ---------------------

    /**
     * Add a column to an existing table.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @param {object} definition - Column definition.
     * @returns {Promise<void>}
     */
    async addColumn(table, column, definition)
    {
        if (typeof this.adapter.addColumn !== 'function')
            throw new Error(`Adapter does not support addColumn`);
        return this.adapter.addColumn(table, column, definition);
    }

    /**
     * Drop a column from a table.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @returns {Promise<void>}
     */
    async dropColumn(table, column)
    {
        if (typeof this.adapter.dropColumn !== 'function')
            throw new Error(`Adapter does not support dropColumn`);
        return this.adapter.dropColumn(table, column);
    }

    /**
     * Rename a column.
     * @param {string} table - Table name.
     * @param {string} oldName - Current name.
     * @param {string} newName - New name.
     * @returns {Promise<void>}
     */
    async renameColumn(table, oldName, newName)
    {
        if (typeof this.adapter.renameColumn !== 'function')
            throw new Error(`Adapter does not support renameColumn`);
        return this.adapter.renameColumn(table, oldName, newName);
    }

    /**
     * Rename a table.
     * @param {string} oldName - Current name.
     * @param {string} newName - New name.
     * @returns {Promise<void>}
     */
    async renameTable(oldName, newName)
    {
        if (typeof this.adapter.renameTable !== 'function')
            throw new Error(`Adapter does not support renameTable`);
        return this.adapter.renameTable(oldName, newName);
    }

    /**
     * Create an index on a table.
     * @param {string} table - Table name.
     * @param {string|string[]} columns - Column name(s).
     * @param {object}  [options={}] - Index configuration.
     * @param {string}  [options.name]   - Custom index name.
     * @param {boolean} [options.unique] - Create a unique index.
     * @returns {Promise<void>}
     */
    async createIndex(table, columns, options = {})
    {
        if (typeof this.adapter.createIndex !== 'function')
            throw new Error(`Adapter does not support createIndex`);
        return this.adapter.createIndex(table, columns, options);
    }

    /**
     * Drop an index.
     * @param {string} table - Table name.
     * @param {string} name  - Index name.
     * @returns {Promise<void>}
     */
    async dropIndex(table, name)
    {
        if (typeof this.adapter.dropIndex !== 'function')
            throw new Error(`Adapter does not support dropIndex`);
        return this.adapter.dropIndex(table, name);
    }

    /**
     * Check if a table exists.
     * @param {string} table - Table name.
     * @returns {Promise<boolean>} True if the table exists.
     */
    async hasTable(table)
    {
        if (typeof this.adapter.hasTable !== 'function')
            throw new Error(`Adapter does not support hasTable`);
        return this.adapter.hasTable(table);
    }

    /**
     * Check if a column exists on a table.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @returns {Promise<boolean>} True if the column exists.
     */
    async hasColumn(table, column)
    {
        if (typeof this.adapter.hasColumn !== 'function')
            throw new Error(`Adapter does not support hasColumn`);
        return this.adapter.hasColumn(table, column);
    }

    /**
     * Get detailed column info for a table.
     * @param {string} table - Table name.
     * @returns {Promise<Array>} Column definition objects for the table.
     */
    async describeTable(table)
    {
        if (typeof this.adapter.describeTable !== 'function')
            throw new Error(`Adapter does not support describeTable`);
        return this.adapter.describeTable(table);
    }

    /**
     * Add a foreign key constraint (MySQL / PostgreSQL only).
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @param {string} refTable - Referenced table name.
     * @param {string} refColumn - Referenced column name.
     * @param {object} [options={}] - Foreign key constraint options.
     * @param {string} [options.onDelete] - Referential action on delete (CASCADE, SET NULL, RESTRICT, etc.).
     * @param {string} [options.onUpdate] - Referential action on update (CASCADE, SET NULL, RESTRICT, etc.).
     * @param {string} [options.name]     - Custom constraint name.
     * @returns {Promise<void>}
     */
    async addForeignKey(table, column, refTable, refColumn, options = {})
    {
        if (typeof this.adapter.addForeignKey !== 'function')
            throw new Error(`Adapter does not support addForeignKey`);
        return this.adapter.addForeignKey(table, column, refTable, refColumn, options);
    }

    /**
     * Drop a foreign key constraint (MySQL / PostgreSQL only).
     * @param {string} table - Table name.
     * @param {string} constraintName - Constraint name.
     * @returns {Promise<void>}
     */
    async dropForeignKey(table, constraintName)
    {
        if (typeof this.adapter.dropForeignKey !== 'function')
            throw new Error(`Adapter does not support dropForeignKey`);
        return this.adapter.dropForeignKey(table, constraintName);
    }

    // -- Health Check & Retry ----------------------------

    /**
     * Ping the database to check connectivity.
     * Works across all adapters.
     *
     * @returns {Promise<boolean>} True if healthy.
     *
     * @example
     *   const healthy = await db.ping();
     *   if (!healthy) console.error('Database is unreachable');
     */
    async ping()
    {
        try
        {
            // Adapter-specific ping
            if (typeof this.adapter.ping === 'function')
            {
                return await this.adapter.ping();
            }

            // Memory/JSON adapters are always healthy
            if (typeof this.adapter._tables !== 'undefined' ||
                typeof this.adapter._getTable === 'function')
            {
                return true;
            }

            // Fallback: try a trivial query
            if (typeof this.adapter.execute === 'function')
            {
                await this.adapter.execute({ action: 'count', table: '_ping_test', where: [] });
                return true;
            }

            return true;
        }
        catch (_)
        {
            return false;
        }
    }

    /**
     * Execute a function with automatic retry on failure.
     * Uses exponential backoff with jitter.
     *
     * @param {Function} fn - Async function to execute.
     * @param {object}   [options] - Configuration options.
     * @param {number}   [options.retries=3]     - Maximum retry attempts.
     * @param {number}   [options.delay=100]     - Initial delay in ms.
     * @param {number}   [options.maxDelay=5000] - Maximum delay in ms.
     * @param {number}   [options.factor=2]      - Backoff multiplier.
     * @param {Function} [options.onRetry]       - Callback on each retry: (err, attempt) => {}.
     * @returns {Promise<*>} Result of fn().
     *
     * @example
     *   const users = await db.retry(async () => {
     *       return User.find({ active: true });
     *   }, { retries: 5, delay: 200 });
     */
    async retry(fn, options = {})
    {
        const {
            retries = 3,
            delay = 100,
            maxDelay = 5000,
            factor = 2,
            onRetry,
        } = options;

        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++)
        {
            try
            {
                return await fn();
            }
            catch (err)
            {
                lastError = err;
                if (attempt >= retries) break;

                const wait = Math.min(delay * Math.pow(factor, attempt), maxDelay);
                // Add jitter (±25%)
                const jitter = wait * (0.75 + Math.random() * 0.5);

                if (typeof onRetry === 'function')
                {
                    onRetry(err, attempt + 1);
                }

                await new Promise(resolve => setTimeout(resolve, jitter));
            }
        }
        throw lastError;
    }

    // -- Profiling ---------------------------------------

    /**
     * Enable query profiling on this database.
     * Attaches a QueryProfiler that tracks every query execution, detects
     * slow queries, and flags potential N+1 patterns.
     *
     * @param {object}   [options] - Configuration options.
     * @param {number}   [options.slowThreshold=100] - Duration (ms) above which a query is considered slow.
     * @param {number}   [options.maxHistory=1000]   - Maximum recorded query entries.
     * @param {Function} [options.onSlow]            - Callback on slow query: (entry) => {}.
     * @param {number}   [options.n1Threshold=5]     - Minimum rapid SELECTs to flag N+1.
     * @param {number}   [options.n1Window=100]      - Time window (ms) for N+1 detection.
     * @param {Function} [options.onN1]              - Callback on N+1 detection.
     * @returns {QueryProfiler} The attached profiler instance.
     *
     * @example
     *   const profiler = db.enableProfiling({ slowThreshold: 50 });
     *   // ... run queries ...
     *   console.log(profiler.metrics());
     */
    enableProfiling(options = {})
    {
        const { QueryProfiler } = require('./profiler');
        this._profiler = new QueryProfiler(options);
        this.adapter._profiler = this._profiler;
        return this._profiler;
    }

    /**
     * The attached profiler (if profiling is enabled).
     * @type {QueryProfiler|null}
     */
    get profiler() { return this._profiler || null; }

    /**
     * The attached replica manager (if configured).
     * @type {ReplicaManager|null}
     */
    get replicas() { return this._replicaManager || null; }

    // -- Read Replicas -----------------------------------

    /**
     * Create a Database with read replica support.
     * Automatically sets up a ReplicaManager with the primary and replica adapters.
     *
     * @param {string}   type            - Adapter type.
     * @param {object}   primaryOpts     - Options for the primary adapter.
     * @param {object[]} [replicaConfigs=[]] - Array of options for each replica adapter.
     * @param {object}   [options]        - ReplicaManager options.
     * @param {string}   [options.strategy='round-robin'] - Selection strategy.
     * @param {boolean}  [options.stickyWrite=true]       - Read from primary after a write.
     * @param {number}   [options.stickyWindow=1000]      - Duration of sticky window (ms).
     * @returns {Database} Connected database with replica routing.
     *
     * @example
     *   const db = Database.connectWithReplicas('postgres',
     *       { host: 'primary.db', database: 'app' },
     *       [
     *           { host: 'replica1.db', database: 'app' },
     *           { host: 'replica2.db', database: 'app' },
     *       ],
     *       { strategy: 'round-robin', stickyWindow: 2000 }
     *   );
     */
    static connectWithReplicas(type, primaryOpts, replicaConfigs = [], options = {})
    {
        if (!Array.isArray(replicaConfigs))
        {
            throw new Error('replicaConfigs must be an array');
        }
        const { ReplicaManager } = require('./replicas');
        const db = Database.connect(type, primaryOpts);
        const manager = new ReplicaManager(options);
        manager.setPrimary(db.adapter);

        for (const opts of replicaConfigs)
        {
            const replicaDb = Database.connect(type, opts);
            manager.addReplica(replicaDb.adapter);
        }

        db._replicaManager = manager;
        db.adapter._replicaManager = manager;
        return db;
    }
}

// -- Lazy module loaders ---------------------------------

const { Migrator, defineMigration } = require('./migrate');
const { QueryCache } = require('./cache');
const { Seeder, SeederRunner, Factory, Fake } = require('./seed');
const { QueryProfiler } = require('./profiler');
const { ReplicaManager } = require('./replicas');

// -- Exports ---------------------------------------------

module.exports = {
    Database,
    Model,
    TYPES,
    Query,
    validate,
    validateValue,
    validateFKAction,
    validateCheck,
    // Migration framework
    Migrator,
    defineMigration,
    // Query caching
    QueryCache,
    // Seeder framework
    Seeder,
    SeederRunner,
    Factory,
    Fake,
    // Performance & Scalability (Phase 2)
    QueryProfiler,
    ReplicaManager,
};
