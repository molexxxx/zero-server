/**
 * @module orm/adapters/sqlite
 * @description SQLite adapter using the optional `better-sqlite3` driver.
 *              Requires: `npm install better-sqlite3`
 *
 * @example
 *   const db = Database.connect('sqlite', { filename: './data.db' });
 *   // or ':memory:' for in-memory database
 */
const path = require('path');
const fs   = require('fs');
const BaseSqlAdapter = require('./sql-base');

class SqliteAdapter extends BaseSqlAdapter
{
    /**
     * @param {object}  options
     * @param {string}  [options.filename=':memory:']  - Path to SQLite file, or ':memory:'.
     * @param {boolean} [options.readonly=false]        - Open database in read-only mode.
     * @param {boolean} [options.fileMustExist=false]   - Throw if the database file does not exist.
     * @param {boolean} [options.verbose]               - Log every SQL statement (debug).
     * @param {boolean} [options.createDir=true]         - Automatically create parent directories for the file.
     * @param {object}  [options.pragmas]               - PRAGMA settings to apply on open.
     * @param {string}  [options.pragmas.journal_mode='WAL']       - Journal mode (WAL, DELETE, TRUNCATE, MEMORY, OFF).
     * @param {string}  [options.pragmas.foreign_keys='ON']        - Enforce foreign-key constraints.
     * @param {string}  [options.pragmas.busy_timeout='5000']      - Milliseconds to wait on a locked database.
     * @param {string}  [options.pragmas.synchronous='NORMAL']     - Sync mode (OFF, NORMAL, FULL, EXTRA).
     * @param {string}  [options.pragmas.cache_size='-64000']      - Page cache size (negative = KiB, e.g. -64000 = 64 MB).
     * @param {string}  [options.pragmas.temp_store='MEMORY']      - Temp tables in memory for speed.
     * @param {string}  [options.pragmas.mmap_size='268435456']    - Memory-mapped I/O size (256 MB).
     * @param {string}  [options.pragmas.page_size]                - Page size in bytes (must be set before WAL).
     * @param {string}  [options.pragmas.auto_vacuum]              - Auto-vacuum mode (NONE, FULL, INCREMENTAL).
     * @param {string}  [options.pragmas.secure_delete]            - Overwrite deleted content with zeros.
     * @param {string}  [options.pragmas.wal_autocheckpoint]       - Pages before auto-checkpoint (default 1000).
     * @param {string}  [options.pragmas.locking_mode]             - NORMAL or EXCLUSIVE.
     */
    constructor(options = {})
    {
        super();
        let Database;
        try { Database = require('better-sqlite3'); }
        catch (e)
        {
            throw new Error(
                'SQLite adapter requires "better-sqlite3" package.\n' +
                'Install it with: npm install better-sqlite3'
            );
        }

        const filename = options.filename || ':memory:';

        // Auto-create parent directories for file-based databases
        if (filename !== ':memory:' && options.createDir !== false)
        {
            const dir = path.dirname(path.resolve(filename));
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }

        // Build better-sqlite3 constructor options
        const dbOpts = {};
        if (options.readonly)     dbOpts.readonly = true;
        if (options.fileMustExist) dbOpts.fileMustExist = true;
        if (options.verbose)      dbOpts.verbose = console.log;

        this._db = new Database(filename, dbOpts);
        this._filename = filename;

        // Apply pragmas (with production-ready defaults)
        const pragmas = {
            journal_mode: 'WAL',
            foreign_keys: 'ON',
            busy_timeout: '5000',
            synchronous:  'NORMAL',
            cache_size:   '-64000',
            temp_store:   'MEMORY',
            mmap_size:    '268435456',
            ...options.pragmas,
        };
        for (const [key, val] of Object.entries(pragmas))
            this._db.pragma(`${key} = ${val}`);
    }

    /** @override */
    _typeMap(colDef)
    {
        const map = {
            string: 'TEXT', text: 'TEXT', integer: 'INTEGER', float: 'REAL',
            boolean: 'INTEGER', date: 'TEXT', datetime: 'TEXT',
            json: 'TEXT', blob: 'BLOB', uuid: 'TEXT',
        };
        return map[colDef.type] || 'TEXT';
    }

    /** @override */
    async createTable(table, schema)
    {
        const cols = [];
        for (const [name, def] of Object.entries(schema))
        {
            let line = `"${name}" ${this._typeMap(def)}`;
            if (def.primaryKey) line += ' PRIMARY KEY';
            if (def.autoIncrement) line += ' AUTOINCREMENT';
            if (def.required && !def.primaryKey) line += ' NOT NULL';
            if (def.unique) line += ' UNIQUE';
            if (def.default !== undefined && typeof def.default !== 'function')
            {
                line += ` DEFAULT ${this._sqlDefault(def.default)}`;
            }
            cols.push(line);
        }
        this._db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${cols.join(', ')})`);
    }

    /** @override */
    async dropTable(table)
    {
        this._db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }

    /** @override */
    async insert(table, data)
    {
        const keys = Object.keys(data);
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map(k => this._toSqlValue(data[k]));
        const stmt = this._db.prepare(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders})`);
        const result = stmt.run(...values);
        return { ...data, id: result.lastInsertRowid };
    }

    /** @override */
    async update(table, pk, pkVal, data)
    {
        const sets = Object.keys(data).map(k => `"${k}" = ?`).join(', ');
        const values = [...Object.values(data).map(v => this._toSqlValue(v)), pkVal];
        this._db.prepare(`UPDATE "${table}" SET ${sets} WHERE "${pk}" = ?`).run(...values);
    }

    /** @override */
    async updateWhere(table, conditions, data)
    {
        const { clause, values: whereVals } = this._buildWhere(conditions);
        const sets = Object.keys(data).map(k => `"${k}" = ?`).join(', ');
        const values = [...Object.values(data).map(v => this._toSqlValue(v)), ...whereVals];
        const result = this._db.prepare(`UPDATE "${table}" SET ${sets}${clause}`).run(...values);
        return result.changes;
    }

    /** @override */
    async remove(table, pk, pkVal)
    {
        this._db.prepare(`DELETE FROM "${table}" WHERE "${pk}" = ?`).run(pkVal);
    }

    /** @override */
    async deleteWhere(table, conditions)
    {
        const { clause, values } = this._buildWhere(conditions);
        const result = this._db.prepare(`DELETE FROM "${table}"${clause}`).run(...values);
        return result.changes;
    }

    /** @override */
    async execute(descriptor)
    {
        const { action, table, fields, where, orderBy, limit, offset, distinct } = descriptor;

        if (action === 'count')
        {
            const { clause, values } = this._buildWhereFromChain(where);
            const row = this._db.prepare(`SELECT COUNT(*) as count FROM "${table}"${clause}`).get(...values);
            return row.count;
        }

        const selectFields = fields && fields.length
            ? fields.map(f => `"${f}"`).join(', ')
            : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        let sql = `SELECT ${distinctStr}${selectFields} FROM "${table}"`;

        const values = [];
        if (where && where.length > 0)
        {
            const { clause, values: wv } = this._buildWhereFromChain(where);
            sql += clause;
            values.push(...wv);
        }

        if (orderBy && orderBy.length > 0)
        {
            sql += ' ORDER BY ' + orderBy.map(o => `"${o.field}" ${o.dir}`).join(', ');
        }

        if (limit !== null && limit !== undefined)
        {
            sql += ' LIMIT ?';
            values.push(limit);
        }

        if (offset !== null && offset !== undefined)
        {
            sql += ' OFFSET ?';
            values.push(offset);
        }

        return this._db.prepare(sql).all(...values);
    }

    // -- SQLite Utilities -----------------------------------------------

    /**
     * Read a single PRAGMA value.
     * @param {string} key - PRAGMA name (e.g. 'journal_mode').
     * @returns {*} Current value.
     */
    pragma(key)
    {
        const rows = this._db.pragma(key);
        if (Array.isArray(rows) && rows.length === 1) return Object.values(rows[0])[0];
        return rows;
    }

    /**
     * Force a WAL checkpoint (only useful in WAL mode).
     * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode='PASSIVE']
     * @returns {{ busy: number, log: number, checkpointed: number }}
     */
    checkpoint(mode = 'PASSIVE')
    {
        const allowed = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'];
        const m = String(mode).toUpperCase();
        if (!allowed.includes(m)) throw new Error(`Invalid checkpoint mode: ${mode}`);
        const row = this._db.pragma(`wal_checkpoint(${m})`);
        return Array.isArray(row) ? row[0] : row;
    }

    /**
     * Run `PRAGMA integrity_check`.
     * @returns {string} 'ok' if healthy, or a description of the problem.
     */
    integrity()
    {
        const rows = this._db.pragma('integrity_check');
        const val = Array.isArray(rows) ? rows[0] : rows;
        return (val && typeof val === 'object') ? Object.values(val)[0] : val;
    }

    /**
     * Rebuild the database file, reclaiming free pages.
     */
    vacuum()
    {
        this._db.exec('VACUUM');
    }

    /**
     * Get the size of the database file in bytes.
     * Returns 0 for in-memory databases.
     * @returns {number}
     */
    fileSize()
    {
        if (this._filename === ':memory:') return 0;
        try { return fs.statSync(path.resolve(this._filename)).size; }
        catch { return 0; }
    }

    /**
     * List all user-created tables.
     * @returns {string[]}
     */
    tables()
    {
        const rows = this._db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).all();
        return rows.map(r => r.name);
    }

    /**
     * Close the database connection.
     */
    close()
    {
        this._db.close();
    }

    /**
     * Run a raw SQL query.
     * @param {string} sql
     * @param {...*}   params
     * @returns {*}
     */
    raw(sql, ...params)
    {
        const stmt = this._db.prepare(sql);
        return stmt.all(...params);
    }

    /**
     * Begin a transaction.
     * @param {Function} fn - Function to run inside the transaction.
     * @returns {*} Return value of fn.
     */
    transaction(fn)
    {
        return this._db.transaction(fn)();
    }
}

module.exports = SqliteAdapter;
