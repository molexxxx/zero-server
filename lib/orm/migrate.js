/**
 * @module orm/migrate
 * @description Versioned migration framework for the zero-http ORM.
 *              Supports up/down migrations, batch tracking, rollback,
 *              status reporting, and full reset/fresh operations.
 *
 * @example
 *   const { Database, Migrator } = require('zero-http');
 *
 *   const db = Database.connect('sqlite', { filename: './app.db' });
 *
 *   const migrator = new Migrator(db);
 *
 *   // Define migrations
 *   migrator.add({
 *       name: '001_create_users',
 *       async up(db) {
 *           await db.adapter.execute({
 *               action: 'raw',
 *               sql: `CREATE TABLE users (
 *                   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *                   name TEXT NOT NULL,
 *                   email TEXT UNIQUE
 *               )`
 *           });
 *       },
 *       async down(db) {
 *           await db.adapter.dropTable('users');
 *       }
 *   });
 *
 *   // Run pending migrations
 *   const result = await migrator.migrate();
 *
 *   // Rollback last batch
 *   await migrator.rollback();
 *
 *   // Check status
 *   const status = await migrator.status();
 */

const log = require('../debug')('zero:migrate');

/**
 * Internal model for tracking migration state.
 * Stored in a `_migrations` table within the same database.
 */
const MIGRATION_TABLE = '_migrations';
const MIGRATION_SCHEMA = {
    id:        { type: 'integer', primaryKey: true, autoIncrement: true },
    name:      { type: 'string',  required: true, unique: true },
    batch:     { type: 'integer', required: true },
    executed:  { type: 'datetime' },
};

class Migrator
{
    /**
     * @constructor
     * @param {import('./index').Database} db - Database instance.
     * @param {object} [options] - Configuration options.
     * @param {string} [options.table='_migrations'] - Migration tracking table name.
     */
    constructor(db, options = {})
    {
        this._db = db;
        this._adapter = db.adapter;
        this._table = options.table || MIGRATION_TABLE;
        this._migrations = [];
        this._initialized = false;
    }

    /**
     * Add a migration definition.
     * @param {object} migration - Migration definition.
     * @param {string} migration.name  - Unique migration name (e.g., '001_create_users').
     * @param {Function} migration.up  - Forward migration: `async (db) => {}`.
     * @param {Function} migration.down - Reverse migration: `async (db) => {}`.
     * @returns {Migrator} this (for chaining)
     */
    add(migration)
    {
        if (!migration.name || typeof migration.name !== 'string')
            throw new Error('Migration must have a name');
        if (!/^[\w\-.]+$/.test(migration.name))
            throw new Error(`Migration name "${migration.name}" contains invalid characters (only letters, digits, underscore, hyphen, dot allowed)`);
        if (typeof migration.up !== 'function') throw new Error(`Migration "${migration.name}": up() must be a function`);
        if (typeof migration.down !== 'function') throw new Error(`Migration "${migration.name}": down() must be a function`);

        // Prevent duplicate names
        if (this._migrations.some(m => m.name === migration.name))
        {
            throw new Error(`Migration "${migration.name}" is already registered`);
        }

        this._migrations.push(migration);
        return this;
    }

    /**
     * Add multiple migrations at once.
     * @param {object[]} migrations - Array of migration definitions.
     * @returns {Migrator} this (for chaining)
     */
    addAll(migrations)
    {
        for (const m of migrations) this.add(m);
        return this;
    }

    /**
     * Ensure the migration tracking table exists.
     * @private
     */
    async _init()
    {
        if (this._initialized) return;

        await this._adapter.createTable(this._table, MIGRATION_SCHEMA);
        this._initialized = true;
    }

    /**
     * Get all previously executed migrations from the tracking table.
     * @private
     * @returns {Promise<object[]>} Executed migration records.
     */
    async _getExecuted()
    {
        await this._init();
        try
        {
            const rows = await this._adapter.execute({
                action: 'select',
                table: this._table,
                where: [],
                orderBy: [{ field: 'id', dir: 'ASC' }],
            });
            return Array.isArray(rows) ? rows : [];
        }
        catch (_)
        {
            return [];
        }
    }

    /**
     * Record a migration as executed.
     * @private
     */
    async _record(name, batch)
    {
        await this._adapter.insert(this._table, {
            name,
            batch,
            executed: new Date().toISOString(),
        });
    }

    /**
     * Remove a migration record.
     * @private
     */
    async _unrecord(name)
    {
        await this._adapter.deleteWhere(this._table, { name });
    }

    /**
     * Get the next batch number.
     * @private
     * @returns {Promise<number>} Next batch number.
     */
    async _nextBatch()
    {
        const executed = await this._getExecuted();
        if (executed.length === 0) return 1;
        return Math.max(...executed.map(m => m.batch)) + 1;
    }

    /**
     * Run all pending migrations.
     *
     * @returns {Promise<{ migrated: string[], batch: number }>}
     *          List of migration names that were executed and the batch number.
     *
     * @example
     *   const { migrated, batch } = await migrator.migrate();
     *   console.log(`Ran ${migrated.length} migrations in batch ${batch}`);
     */
    async migrate()
    {
        await this._init();

        const executed = await this._getExecuted();
        const executedNames = new Set(executed.map(m => m.name));
        const pending = this._migrations.filter(m => !executedNames.has(m.name));

        if (pending.length === 0)
        {
            log('No pending migrations');
            return { migrated: [], batch: 0 };
        }

        const batch = await this._nextBatch();
        const migrated = [];

        for (const migration of pending)
        {
            log(`Migrating: ${migration.name}`);
            try
            {
                await migration.up(this._db);
                await this._record(migration.name, batch);
                migrated.push(migration.name);
                log(`Migrated:  ${migration.name}`);
            }
            catch (err)
            {
                const error = new Error(
                    `Migration "${migration.name}" failed: ${err.message}`
                );
                error.migration = migration.name;
                error.batch = batch;
                error.cause = err;
                throw error;
            }
        }

        return { migrated, batch };
    }

    /**
     * Rollback the last batch of migrations.
     *
     * @returns {Promise<{ rolledBack: string[], batch: number }>}
     *
     * @example
     *   const { rolledBack } = await migrator.rollback();
     *   console.log(`Rolled back: ${rolledBack.join(', ')}`);
     */
    async rollback()
    {
        await this._init();

        const executed = await this._getExecuted();
        if (executed.length === 0)
        {
            return { rolledBack: [], batch: 0 };
        }

        const lastBatch = Math.max(...executed.map(m => m.batch));
        const toRollback = executed
            .filter(m => m.batch === lastBatch)
            .reverse(); // Roll back in reverse order

        const rolledBack = [];

        for (const record of toRollback)
        {
            const migration = this._migrations.find(m => m.name === record.name);
            if (!migration)
            {
                throw new Error(
                    `Cannot rollback "${record.name}": migration definition not found. ` +
                    `Ensure all migrations are registered before rolling back.`
                );
            }

            log(`Rolling back: ${record.name}`);
            try
            {
                await migration.down(this._db);
                await this._unrecord(record.name);
                rolledBack.push(record.name);
                log(`Rolled back:  ${record.name}`);
            }
            catch (err)
            {
                const error = new Error(
                    `Rollback of "${record.name}" failed: ${err.message}`
                );
                error.migration = record.name;
                error.cause = err;
                throw error;
            }
        }

        return { rolledBack, batch: lastBatch };
    }

    /**
     * Rollback all migrations (in reverse order, batch by batch).
     *
     * @returns {Promise<{ rolledBack: string[] }>}
     */
    async rollbackAll()
    {
        const allRolledBack = [];
        let result;
        do
        {
            result = await this.rollback();
            allRolledBack.push(...result.rolledBack);
        }
        while (result.rolledBack.length > 0);

        return { rolledBack: allRolledBack };
    }

    /**
     * Reset the database: rollback all migrations, then re-run all.
     *
     * @returns {Promise<{ rolledBack: string[], migrated: string[], batch: number }>}
     */
    async reset()
    {
        const { rolledBack } = await this.rollbackAll();
        const { migrated, batch } = await this.migrate();
        return { rolledBack, migrated, batch };
    }

    /**
     * Fresh start: drop ALL tables (not just migrated ones) then re-migrate.
     * ⚠️  DESTRUCTIVE — use with caution.
     *
     * @returns {Promise<{ migrated: string[], batch: number }>}
     */
    async fresh()
    {
        // Drop all registered model tables via db.drop()
        try { await this._db.drop(); } catch (_) { /* ignore if no models registered */ }

        // Also drop the migration tracking table
        try { await this._adapter.dropTable(this._table); } catch (_) { /* ignore */ }

        this._initialized = false;

        // Re-run all migrations
        return this.migrate();
    }

    /**
     * Get the current migration status.
     *
     * @returns {Promise<{ executed: object[], pending: string[], lastBatch: number }>}
     *
     * @example
     *   const { executed, pending, lastBatch } = await migrator.status();
     *   console.log(`Executed: ${executed.length}, Pending: ${pending.length}`);
     */
    async status()
    {
        await this._init();

        const executed = await this._getExecuted();
        const executedNames = new Set(executed.map(m => m.name));
        const pending = this._migrations
            .filter(m => !executedNames.has(m.name))
            .map(m => m.name);

        const lastBatch = executed.length > 0
            ? Math.max(...executed.map(m => m.batch))
            : 0;

        return {
            executed: executed.map(m => ({
                name: m.name,
                batch: m.batch,
                executedAt: m.executed,
            })),
            pending,
            lastBatch,
        };
    }

    /**
     * Check if there are any pending migrations.
     * @returns {Promise<boolean>} True if there are pending migrations.
     */
    async hasPending()
    {
        const { pending } = await this.status();
        return pending.length > 0;
    }

    /**
     * Get the list of registered migration names.
     * @returns {string[]} Registered migration names in order.
     */
    list()
    {
        return this._migrations.map(m => m.name);
    }
}

/**
 * Helper to create a migration definition object.
 *
 * @param {string} name - Name identifier.
 * @param {Function} up   - `async (db) => { ... }`
 * @param {Function} down - `async (db) => { ... }`
 * @returns {{ name: string, up: Function, down: Function }}
 *
 * @example
 *   const { defineMigration } = require('zero-http');
 *
 *   module.exports = defineMigration('001_create_users',
 *       async (db) => {
 *           // up
 *           await db.addColumn('users', 'avatar', { type: TYPES.STRING });
 *       },
 *       async (db) => {
 *           // down
 *           await db.dropColumn('users', 'avatar');
 *       }
 *   );
 */
function defineMigration(name, up, down)
{
    if (!name || typeof name !== 'string')
        throw new Error('defineMigration: name is required');
    if (!/^[\w\-.]+$/.test(name))
        throw new Error(`defineMigration: name "${name}" contains invalid characters`);
    if (typeof up !== 'function')
        throw new Error(`defineMigration "${name}": up must be a function`);
    if (typeof down !== 'function')
        throw new Error(`defineMigration "${name}": down must be a function`);
    return { name, up, down };
}

module.exports = { Migrator, defineMigration };
