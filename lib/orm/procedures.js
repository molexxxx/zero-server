/**
 * @module orm/procedures
 * @description Stored procedures, functions, and trigger management for the ORM.
 *              Provides a cross-adapter API for defining, creating, executing,
 *              and dropping stored procedures, functions, and triggers.
 *
 * @example
 *   const { StoredProcedure, StoredFunction, TriggerManager } = require('zero-http');
 *
 *   // Define a procedure
 *   const proc = new StoredProcedure('update_balance', {
 *       params: [
 *           { name: 'user_id', type: 'INTEGER' },
 *           { name: 'amount', type: 'DECIMAL' },
 *       ],
 *       body: `UPDATE accounts SET balance = balance + amount WHERE id = user_id;`,
 *   });
 *
 *   await proc.create(db);
 *   await proc.execute(db, [1, 50.00]);
 */

const log = require('../debug')('zero:orm:procedures');

// -- StoredProcedure -----------------------------------------

/**
 * Represents a stored procedure.
 * Generates adapter-appropriate DDL and executes the procedure.
 */
class StoredProcedure
{
    /**
     * @constructor
     * @param {string} name     - Procedure name.
     * @param {object} options  - Procedure definition.
     * @param {Array<{name: string, type: string, direction?: string}>} [options.params=[]] - Parameters.
     * @param {string} options.body    - Procedure body (SQL).
     * @param {string} [options.language='sql'] - Language (sql, plpgsql, javascript).
     * @param {object} [options.options]        - Adapter-specific options.
     *
     * @example
     *   const proc = new StoredProcedure('calculate_tax', {
     *       params: [{ name: 'subtotal', type: 'DECIMAL' }],
     *       body: 'UPDATE cart SET tax = subtotal * 0.08;',
     *   });
     */
    constructor(name, options = {})
    {
        if (!name || typeof name !== 'string')
        {
            throw new Error('StoredProcedure requires a non-empty string name');
        }
        if (!options.body || typeof options.body !== 'string')
        {
            throw new Error('StoredProcedure requires a "body" string');
        }

        // Sanitize name — only allow identifiers
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
        {
            throw new Error(`Invalid procedure name: "${name}"`);
        }

        /** @type {string} */
        this.name = name;

        /** @type {Array<{name: string, type: string, direction?: string}>} */
        this.params = options.params || [];

        /** @type {string} */
        this.body = options.body;

        /** @type {string} */
        this.language = options.language || 'sql';

        /** @type {object} */
        this.adapterOptions = options.options || {};

        // Validate param names
        for (const p of this.params)
        {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name))
            {
                throw new Error(`Invalid parameter name: "${p.name}"`);
            }
        }
    }

    /**
     * Create the stored procedure in the database.
     *
     * @param {import('./index').Database} db - Database instance.
     * @returns {Promise<void>}
     *
     * @example
     *   await proc.create(db);
     */
    async create(db)
    {
        const adapter = db.adapter;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.createProcedure === 'function')
        {
            return adapter.createProcedure(this.name, this.params, this.body, {
                language: this.language,
                ...this.adapterOptions,
            });
        }

        const sql = this._buildCreateSQL(adapterType);

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('StoredProcedure requires a SQL adapter');
        }

        await adapter.execute({ raw: sql });
        log('procedure created', this.name);
    }

    /**
     * Drop the stored procedure.
     *
     * @param {import('./index').Database} db - Database instance.
     * @param {object} [options] - Drop options.
     * @param {boolean} [options.ifExists=true] - Add IF EXISTS clause.
     * @returns {Promise<void>}
     *
     * @example
     *   await proc.drop(db);
     */
    async drop(db, options = {})
    {
        const adapter = db.adapter;
        const ifExists = options.ifExists !== false;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.dropProcedure === 'function')
        {
            return adapter.dropProcedure(this.name, options);
        }

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('StoredProcedure requires a SQL adapter');
        }

        let sql;
        if (adapterType === 'mysql')
        {
            sql = `DROP PROCEDURE ${ifExists ? 'IF EXISTS ' : ''}\`${this.name}\``;
        }
        else if (adapterType === 'postgres')
        {
            const paramTypes = this.params.map(p => p.type).join(', ');
            sql = `DROP PROCEDURE ${ifExists ? 'IF EXISTS ' : ''}"${this.name}"(${paramTypes})`;
        }
        else
        {
            sql = `DROP PROCEDURE ${ifExists ? 'IF EXISTS ' : ''}"${this.name}"`;
        }

        await adapter.execute({ raw: sql });
        log('procedure dropped', this.name);
    }

    /**
     * Execute the stored procedure with arguments.
     *
     * @param {import('./index').Database} db - Database instance.
     * @param {Array} [args=[]] - Procedure arguments (positional).
     * @returns {Promise<*>} Result from the database.
     *
     * @example
     *   const result = await proc.execute(db, [1, 50.00]);
     */
    async execute(db, args = [])
    {
        const adapter = db.adapter;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.callProcedure === 'function')
        {
            return adapter.callProcedure(this.name, args);
        }

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('StoredProcedure requires a SQL adapter');
        }

        let sql;
        const placeholders = args.map((_, i) =>
            adapterType === 'postgres' ? `$${i + 1}` : '?'
        ).join(', ');

        if (adapterType === 'mysql')
        {
            sql = `CALL \`${this.name}\`(${placeholders})`;
        }
        else if (adapterType === 'postgres')
        {
            sql = `CALL "${this.name}"(${placeholders})`;
        }
        else
        {
            // SQLite doesn't support stored procedures natively
            throw new Error('Stored procedures are not supported by this adapter');
        }

        return adapter.execute({ raw: sql, params: args });
    }

    /**
     * Check if the procedure exists.
     *
     * @param {import('./index').Database} db - Database instance.
     * @returns {Promise<boolean>}
     */
    async exists(db)
    {
        const adapter = db.adapter;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.execute !== 'function') return false;

        try
        {
            let sql, params;
            if (adapterType === 'mysql')
            {
                sql = `SELECT COUNT(*) as cnt FROM information_schema.ROUTINES WHERE ROUTINE_TYPE = 'PROCEDURE' AND ROUTINE_NAME = ?`;
                params = [this.name];
            }
            else if (adapterType === 'postgres')
            {
                sql = `SELECT COUNT(*) as cnt FROM information_schema.routines WHERE routine_type = 'PROCEDURE' AND routine_name = $1`;
                params = [this.name];
            }
            else
            {
                return false;
            }

            const result = await adapter.execute({ raw: sql, params });
            if (Array.isArray(result) && result[0])
            {
                return (result[0].cnt || 0) > 0;
            }
            return false;
        }
        catch (_)
        {
            return false;
        }
    }

    // -- Internal ----------------------------------------

    /**
     * @private
     */
    _detectAdapter(adapter)
    {
        const name = (adapter.constructor.name || '').toLowerCase();
        if (name.includes('mysql')) return 'mysql';
        if (name.includes('postgres') || name.includes('pg')) return 'postgres';
        if (name.includes('sqlite')) return 'sqlite';
        return 'unknown';
    }

    /**
     * @private
     */
    _buildCreateSQL(adapterType)
    {
        if (adapterType === 'mysql')
        {
            const params = this.params.map(p =>
            {
                const dir = (p.direction || 'IN').toUpperCase();
                return `${dir} \`${p.name}\` ${p.type}`;
            }).join(', ');

            return `CREATE PROCEDURE \`${this.name}\`(${params})\nBEGIN\n${this.body}\nEND`;
        }

        if (adapterType === 'postgres')
        {
            const params = this.params.map(p =>
            {
                const dir = (p.direction || 'IN').toUpperCase();
                return `${dir} "${p.name}" ${p.type}`;
            }).join(', ');

            const lang = this.language === 'sql' ? 'SQL' : this.language.toUpperCase();
            return `CREATE OR REPLACE PROCEDURE "${this.name}"(${params})\nLANGUAGE ${lang}\nAS $$\n${this.body}\n$$`;
        }

        throw new Error(`Stored procedures not supported for adapter: ${adapterType}`);
    }
}

// -- StoredFunction ------------------------------------------

/**
 * Represents a database function.
 * Similar to StoredProcedure but returns a value.
 */
class StoredFunction
{
    /**
     * @constructor
     * @param {string} name     - Function name.
     * @param {object} options  - Function definition.
     * @param {Array<{name: string, type: string}>} [options.params=[]] - Parameters.
     * @param {string} options.returns    - Return type (e.g. 'INTEGER', 'TEXT').
     * @param {string} options.body      - Function body (SQL).
     * @param {string} [options.language='sql'] - Language.
     * @param {boolean} [options.deterministic=false] - Whether function is deterministic (MySQL).
     * @param {string} [options.volatility]    - PostgreSQL volatility (STABLE, VOLATILE, IMMUTABLE).
     *
     * @example
     *   const fn = new StoredFunction('calculate_tax', {
     *       params: [{ name: 'amount', type: 'DECIMAL' }],
     *       returns: 'DECIMAL',
     *       body: 'RETURN amount * 0.08;',
     *   });
     */
    constructor(name, options = {})
    {
        if (!name || typeof name !== 'string')
        {
            throw new Error('StoredFunction requires a non-empty string name');
        }
        if (!options.body || typeof options.body !== 'string')
        {
            throw new Error('StoredFunction requires a "body" string');
        }
        if (!options.returns || typeof options.returns !== 'string')
        {
            throw new Error('StoredFunction requires a "returns" type string');
        }

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
        {
            throw new Error(`Invalid function name: "${name}"`);
        }

        /** @type {string} */
        this.name = name;

        /** @type {Array<{name: string, type: string}>} */
        this.params = options.params || [];

        /** @type {string} */
        this.returns = options.returns;

        /** @type {string} */
        this.body = options.body;

        /** @type {string} */
        this.language = options.language || 'sql';

        /** @type {boolean} */
        this.deterministic = options.deterministic === true;

        /** @type {string|null} */
        this.volatility = options.volatility || null;

        // Validate param names
        for (const p of this.params)
        {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name))
            {
                throw new Error(`Invalid parameter name: "${p.name}"`);
            }
        }
    }

    /**
     * Create the function in the database.
     *
     * @param {import('./index').Database} db - Database instance.
     * @returns {Promise<void>}
     *
     * @example
     *   await fn.create(db);
     */
    async create(db)
    {
        const adapter = db.adapter;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.createFunction === 'function')
        {
            return adapter.createFunction(this.name, this.params, this.returns, this.body, {
                language: this.language,
                deterministic: this.deterministic,
                volatility: this.volatility,
            });
        }

        const sql = this._buildCreateSQL(adapterType);

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('StoredFunction requires a SQL adapter');
        }

        await adapter.execute({ raw: sql });
        log('function created', this.name);
    }

    /**
     * Drop the function.
     *
     * @param {import('./index').Database} db - Database instance.
     * @param {object} [options] - Drop options.
     * @param {boolean} [options.ifExists=true] - Add IF EXISTS clause.
     * @returns {Promise<void>}
     */
    async drop(db, options = {})
    {
        const adapter = db.adapter;
        const ifExists = options.ifExists !== false;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.dropFunction === 'function')
        {
            return adapter.dropFunction(this.name, options);
        }

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('StoredFunction requires a SQL adapter');
        }

        let sql;
        if (adapterType === 'mysql')
        {
            sql = `DROP FUNCTION ${ifExists ? 'IF EXISTS ' : ''}\`${this.name}\``;
        }
        else if (adapterType === 'postgres')
        {
            const paramTypes = this.params.map(p => p.type).join(', ');
            sql = `DROP FUNCTION ${ifExists ? 'IF EXISTS ' : ''}"${this.name}"(${paramTypes})`;
        }
        else
        {
            sql = `DROP FUNCTION ${ifExists ? 'IF EXISTS ' : ''}"${this.name}"`;
        }

        await adapter.execute({ raw: sql });
        log('function dropped', this.name);
    }

    /**
     * Call the function and return its result.
     *
     * @param {import('./index').Database} db - Database instance.
     * @param {Array} [args=[]] - Function arguments.
     * @returns {Promise<*>} Function return value.
     *
     * @example
     *   const tax = await fn.call(db, [100.00]);
     */
    async call(db, args = [])
    {
        const adapter = db.adapter;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.callFunction === 'function')
        {
            return adapter.callFunction(this.name, args);
        }

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('StoredFunction requires a SQL adapter');
        }

        const placeholders = args.map((_, i) =>
            adapterType === 'postgres' ? `$${i + 1}` : '?'
        ).join(', ');

        const sql = adapterType === 'mysql'
            ? `SELECT \`${this.name}\`(${placeholders}) AS result`
            : `SELECT "${this.name}"(${placeholders}) AS result`;

        const result = await adapter.execute({ raw: sql, params: args });
        if (Array.isArray(result) && result[0])
        {
            return result[0].result;
        }
        return result;
    }

    /**
     * Check if the function exists.
     *
     * @param {import('./index').Database} db - Database instance.
     * @returns {Promise<boolean>}
     */
    async exists(db)
    {
        const adapter = db.adapter;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.execute !== 'function') return false;

        try
        {
            let sql, params;
            if (adapterType === 'mysql')
            {
                sql = `SELECT COUNT(*) as cnt FROM information_schema.ROUTINES WHERE ROUTINE_TYPE = 'FUNCTION' AND ROUTINE_NAME = ?`;
                params = [this.name];
            }
            else if (adapterType === 'postgres')
            {
                sql = `SELECT COUNT(*) as cnt FROM information_schema.routines WHERE routine_type = 'FUNCTION' AND routine_name = $1`;
                params = [this.name];
            }
            else
            {
                return false;
            }

            const result = await adapter.execute({ raw: sql, params });
            if (Array.isArray(result) && result[0])
            {
                return (result[0].cnt || 0) > 0;
            }
            return false;
        }
        catch (_)
        {
            return false;
        }
    }

    /**
     * @private
     */
    _detectAdapter(adapter)
    {
        const name = (adapter.constructor.name || '').toLowerCase();
        if (name.includes('mysql')) return 'mysql';
        if (name.includes('postgres') || name.includes('pg')) return 'postgres';
        if (name.includes('sqlite')) return 'sqlite';
        return 'unknown';
    }

    /**
     * @private
     */
    _buildCreateSQL(adapterType)
    {
        if (adapterType === 'mysql')
        {
            const params = this.params.map(p => `\`${p.name}\` ${p.type}`).join(', ');
            const det = this.deterministic ? '\nDETERMINISTIC' : '';
            return `CREATE FUNCTION \`${this.name}\`(${params})\nRETURNS ${this.returns}${det}\nBEGIN\n${this.body}\nEND`;
        }

        if (adapterType === 'postgres')
        {
            const params = this.params.map(p => `"${p.name}" ${p.type}`).join(', ');
            const lang = this.language === 'sql' ? 'SQL' : this.language.toUpperCase();
            const vol = this.volatility ? `\n${this.volatility.toUpperCase()}` : '';
            return `CREATE OR REPLACE FUNCTION "${this.name}"(${params})\nRETURNS ${this.returns}\nLANGUAGE ${lang}${vol}\nAS $$\n${this.body}\n$$`;
        }

        throw new Error(`Stored functions not supported for adapter: ${adapterType}`);
    }
}

// -- TriggerManager ------------------------------------------

/**
 * Database trigger management.
 * Define, create, drop, and list triggers.
 */
class TriggerManager
{
    /**
     * @constructor
     * @param {import('./index').Database} db - Database instance.
     *
     * @example
     *   const triggers = new TriggerManager(db);
     */
    constructor(db)
    {
        if (!db) throw new Error('TriggerManager requires a Database instance');

        /** @type {import('./index').Database} */
        this.db = db;

        /** @type {Map<string, object>} Registered trigger definitions. */
        this._triggers = new Map();
    }

    /**
     * Define a trigger.
     *
     * @param {string} name     - Trigger name.
     * @param {object} options  - Trigger definition.
     * @param {string} options.table   - Table the trigger is on.
     * @param {string} options.timing  - 'BEFORE' or 'AFTER'.
     * @param {string} options.event   - 'INSERT', 'UPDATE', or 'DELETE'.
     * @param {string} options.body    - Trigger body (SQL).
     * @param {string} [options.forEach='ROW'] - 'ROW' or 'STATEMENT'.
     * @param {string} [options.when]  - Optional WHEN condition.
     * @returns {TriggerManager} this (for chaining)
     *
     * @example
     *   triggers.define('trg_audit_users', {
     *       table: 'users',
     *       timing: 'AFTER',
     *       event: 'UPDATE',
     *       body: 'INSERT INTO audit_log(table_name, record_id, action) VALUES ("users", NEW.id, "update");',
     *   });
     */
    define(name, options = {})
    {
        if (!name || typeof name !== 'string')
        {
            throw new Error('Trigger name must be a non-empty string');
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
        {
            throw new Error(`Invalid trigger name: "${name}"`);
        }
        if (!options.table || typeof options.table !== 'string')
        {
            throw new Error('Trigger requires a "table" string');
        }
        if (!options.timing || !['BEFORE', 'AFTER', 'INSTEAD OF'].includes(options.timing.toUpperCase()))
        {
            throw new Error('Trigger timing must be BEFORE, AFTER, or INSTEAD OF');
        }
        if (!options.event || !['INSERT', 'UPDATE', 'DELETE'].includes(options.event.toUpperCase()))
        {
            throw new Error('Trigger event must be INSERT, UPDATE, or DELETE');
        }
        if (!options.body || typeof options.body !== 'string')
        {
            throw new Error('Trigger requires a "body" string');
        }

        this._triggers.set(name, {
            name,
            table: options.table,
            timing: options.timing.toUpperCase(),
            event: options.event.toUpperCase(),
            body: options.body,
            forEach: (options.forEach || 'ROW').toUpperCase(),
            when: options.when || null,
        });

        log('trigger defined', name);
        return this;
    }

    /**
     * Create a trigger in the database.
     *
     * @param {string} name - Trigger name (must be previously defined).
     * @returns {Promise<void>}
     *
     * @example
     *   await triggers.create('trg_audit_users');
     */
    async create(name)
    {
        const def = this._triggers.get(name);
        if (!def)
        {
            throw new Error(`Trigger "${name}" is not defined. Call define() first.`);
        }

        const adapter = this.db.adapter;
        const adapterType = this._detectAdapter(adapter);

        if (typeof adapter.createTrigger === 'function')
        {
            return adapter.createTrigger(def);
        }

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('TriggerManager requires a SQL adapter');
        }

        const sql = this._buildCreateSQL(def, adapterType);
        await adapter.execute({ raw: sql });
        log('trigger created', name);
    }

    /**
     * Create all defined triggers.
     *
     * @returns {Promise<string[]>} Names of created triggers.
     */
    async createAll()
    {
        const names = [];
        for (const name of this._triggers.keys())
        {
            await this.create(name);
            names.push(name);
        }
        return names;
    }

    /**
     * Drop a trigger.
     *
     * @param {string}  name    - Trigger name.
     * @param {object}  [options] - Drop options.
     * @param {string}  [options.table]     - Table name (required for MySQL).
     * @param {boolean} [options.ifExists=true] - Add IF EXISTS clause.
     * @returns {Promise<void>}
     */
    async drop(name, options = {})
    {
        const adapter = this.db.adapter;
        const ifExists = options.ifExists !== false;
        const adapterType = this._detectAdapter(adapter);
        const def = this._triggers.get(name);
        const table = options.table || (def && def.table);

        if (typeof adapter.dropTrigger === 'function')
        {
            return adapter.dropTrigger(name, options);
        }

        if (typeof adapter.execute !== 'function')
        {
            throw new Error('TriggerManager requires a SQL adapter');
        }

        let sql;
        if (adapterType === 'mysql')
        {
            sql = `DROP TRIGGER ${ifExists ? 'IF EXISTS ' : ''}\`${name}\``;
        }
        else if (adapterType === 'postgres')
        {
            if (!table) throw new Error('PostgreSQL requires table name to drop trigger');
            sql = `DROP TRIGGER ${ifExists ? 'IF EXISTS ' : ''}"${name}" ON "${table}"`;
        }
        else if (adapterType === 'sqlite')
        {
            sql = `DROP TRIGGER ${ifExists ? 'IF EXISTS ' : ''}"${name}"`;
        }
        else
        {
            sql = `DROP TRIGGER ${ifExists ? 'IF EXISTS ' : ''}"${name}"`;
        }

        await adapter.execute({ raw: sql });
        this._triggers.delete(name);
        log('trigger dropped', name);
    }

    /**
     * List all defined trigger names.
     *
     * @returns {string[]}
     */
    list()
    {
        return [...this._triggers.keys()];
    }

    /**
     * Get a trigger definition by name.
     *
     * @param {string} name - Trigger name.
     * @returns {object|undefined}
     */
    get(name)
    {
        return this._triggers.get(name);
    }

    /**
     * @private
     */
    _detectAdapter(adapter)
    {
        const name = (adapter.constructor.name || '').toLowerCase();
        if (name.includes('mysql')) return 'mysql';
        if (name.includes('postgres') || name.includes('pg')) return 'postgres';
        if (name.includes('sqlite')) return 'sqlite';
        return 'unknown';
    }

    /**
     * @private
     */
    _buildCreateSQL(def, adapterType)
    {
        if (adapterType === 'mysql')
        {
            const when = def.when ? `\n  WHEN (${def.when})` : '';
            return `CREATE TRIGGER \`${def.name}\` ${def.timing} ${def.event}\nON \`${def.table}\` FOR EACH ${def.forEach}${when}\nBEGIN\n${def.body}\nEND`;
        }

        if (adapterType === 'postgres')
        {
            // PostgreSQL triggers need a function
            const funcName = `${def.name}_fn`;
            const when = def.when ? `\n  WHEN (${def.when})` : '';
            return (
                `CREATE OR REPLACE FUNCTION "${funcName}"() RETURNS TRIGGER AS $$\nBEGIN\n${def.body}\nRETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;\n\n` +
                `CREATE TRIGGER "${def.name}" ${def.timing} ${def.event}\nON "${def.table}" FOR EACH ${def.forEach}${when}\nEXECUTE FUNCTION "${funcName}"()`
            );
        }

        if (adapterType === 'sqlite')
        {
            const when = def.when ? `\n  WHEN ${def.when}` : '';
            return `CREATE TRIGGER IF NOT EXISTS "${def.name}" ${def.timing} ${def.event}\nON "${def.table}" FOR EACH ${def.forEach}${when}\nBEGIN\n${def.body}\nEND`;
        }

        throw new Error(`Triggers not supported for adapter: ${adapterType}`);
    }
}

module.exports = { StoredProcedure, StoredFunction, TriggerManager };
