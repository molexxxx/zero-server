/**
 * @module orm/adapters/sqlite
 * @description SQLite adapter using the optional `better-sqlite3` driver.
 *              Requires: `npm install better-sqlite3`
 *
 * @example
 *   const { Database, Model, TYPES } = require('zero-http');
 *
 *   const db = Database.connect('sqlite', { filename: './app.db' });
 *
 *   class User extends Model {
 *       static table  = 'users';
 *       static schema = {
 *           id:    { type: TYPES.INTEGER, primaryKey: true, autoIncrement: true },
 *           name:  { type: TYPES.STRING,  required: true },
 *           email: { type: TYPES.STRING,  required: true, unique: true },
 *       };
 *       static timestamps = true;
 *   }
 *
 *   db.register(User);
 *   await db.sync();
 *
 *   const user = await User.create({ name: 'Alice', email: 'a@b.com' });
 *   const found = await User.findById(user.id);
 */
const path = require('path');
const fs   = require('fs');
const BaseSqlAdapter = require('./sql-base');
const { validateFKAction, validateCheck } = require('../schema');

class SqliteAdapter extends BaseSqlAdapter
{
    /**
     * @constructor
     * @param {object}  options - Configuration options.
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

        /** @private Prepared statement cache — avoids recompilation overhead */
        this._stmtCache = new Map();
        /** @private Maximum cached statements before LRU eviction */
        this._stmtCacheMax = options.stmtCacheSize || 256;
        /** @private Statement cache hit counter */
        this._stmtCacheHits = 0;
        /** @private Statement cache miss counter */
        this._stmtCacheMisses = 0;

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

    // -- Statement Caching --------------------------------

    /**
     * Get or compile a prepared statement from cache.
     * Uses LRU eviction when cache exceeds max size.
     * @param {string} sql - SQL query string.
     * @returns {Statement} Compiled prepared statement.
     * @private
     */
    _prepare(sql)
    {
        let stmt = this._stmtCache.get(sql);
        if (stmt)
        {
            this._stmtCacheHits++;
            // LRU: move to end (most recently used)
            this._stmtCache.delete(sql);
            this._stmtCache.set(sql, stmt);
            return stmt;
        }

        this._stmtCacheMisses++;
        stmt = this._db.prepare(sql);
        if (this._stmtCache.size >= this._stmtCacheMax)
        {
            const oldest = this._stmtCache.keys().next().value;
            this._stmtCache.delete(oldest);
        }
        this._stmtCache.set(sql, stmt);
        return stmt;
    }

    /**
     * Get prepared statement cache statistics.
     * @returns {{ size: number, maxSize: number, hits: number, misses: number, hitRate: number }}
     */
    stmtCacheStats()
    {
        const total = this._stmtCacheHits + this._stmtCacheMisses;
        return {
            size: this._stmtCache.size,
            maxSize: this._stmtCacheMax,
            hits: this._stmtCacheHits,
            misses: this._stmtCacheMisses,
            hitRate: total > 0 ? this._stmtCacheHits / total : 0,
        };
    }

    /**
     * Get the query execution plan (EXPLAIN QUERY PLAN).
     * @param {object} descriptor - Query descriptor from the Query builder.
     * @returns {Array<{ id: number, parent: number, notused: number, detail: string }>}
     */
    explain(descriptor)
    {
        const { table, fields, where, orderBy, limit, offset, distinct, joins, groupBy, having } = descriptor;

        const selectFields = fields && fields.length
            ? fields.map(f => `"${f}"`).join(', ')
            : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        const joinStr = this._buildJoins(joins, table);
        let sql = `SELECT ${distinctStr}${selectFields} FROM "${table}"${joinStr}`;

        const values = [];
        if (where && where.length > 0)
        {
            const { clause, values: wv } = this._buildWhereFromChain(where);
            sql += clause;
            values.push(...wv);
        }

        sql += this._buildGroupBy(groupBy);
        sql += this._buildHaving(having, values);

        if (orderBy && orderBy.length > 0)
            sql += ' ORDER BY ' + orderBy.map(o => `"${o.field}" ${o.dir}`).join(', ');
        if (limit !== null && limit !== undefined) { sql += ' LIMIT ?'; values.push(limit); }
        if (offset !== null && offset !== undefined) { sql += ' OFFSET ?'; values.push(offset); }

        return this._db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
    }

    /** @private @override */
    _typeMap(colDef)
    {
        const map = {
            string: 'TEXT', text: 'TEXT', integer: 'INTEGER', float: 'REAL',
            boolean: 'INTEGER', date: 'TEXT', datetime: 'TEXT',
            json: 'TEXT', blob: 'BLOB', uuid: 'TEXT',
            bigint: 'INTEGER', smallint: 'INTEGER', tinyint: 'INTEGER',
            decimal: 'REAL', double: 'REAL', real: 'REAL',
            timestamp: 'TEXT', time: 'TEXT',
            binary: 'BLOB', varbinary: 'BLOB',
            char: 'TEXT', varchar: 'TEXT',
            numeric: 'NUMERIC',
        };
        return map[colDef.type] || 'TEXT';
    }

    /**
     * Create a table with the given schema.
     * @param {string} table - Table name.
     * @param {object} schema - Column definitions keyed by column name.
     * @returns {Promise<void>}
     */
    async createTable(table, schema)
    {
        const cols = [];
        const tableConstraints = [];
        const compositePKs = [];

        for (const [name, def] of Object.entries(schema))
        {
            let line = `"${name}" ${this._typeMap(def)}`;

            // Collect composite PK candidates
            if (def.primaryKey && def.compositeKey) { compositePKs.push(name); }
            else if (def.primaryKey)
            {
                line += ' PRIMARY KEY';
                if (def.autoIncrement) line += ' AUTOINCREMENT';
            }

            if (def.required && !def.primaryKey) line += ' NOT NULL';
            if (def.unique && !def.compositeUnique) line += ' UNIQUE';
            if (def.default !== undefined && typeof def.default !== 'function')
            {
                line += ` DEFAULT ${this._sqlDefault(def.default)}`;
            }

            // CHECK constraint
            if (def.check)
            {
                line += ` CHECK(${validateCheck(def.check)})`;
            }
            else if (def.enum && def.type !== 'enum')
            {
                const vals = def.enum.map(v => `'${String(v).replace(/'/g, "''")}'`).join(', ');
                line += ` CHECK("${name}" IN (${vals}))`;
            }

            // Foreign key (inline reference)
            if (def.references)
            {
                line += ` REFERENCES "${def.references.table}"("${def.references.column || 'id'}")`;
                if (def.references.onDelete) line += ` ON DELETE ${validateFKAction(def.references.onDelete)}`;
                if (def.references.onUpdate) line += ` ON UPDATE ${validateFKAction(def.references.onUpdate)}`;
            }

            cols.push(line);
        }

        // Composite primary key
        if (compositePKs.length > 0)
        {
            tableConstraints.push(`PRIMARY KEY (${compositePKs.map(k => `"${k}"`).join(', ')})`);
        }

        // Composite unique constraints
        const compositeUniques = {};
        for (const [name, def] of Object.entries(schema))
        {
            if (def.compositeUnique)
            {
                const group = typeof def.compositeUnique === 'string' ? def.compositeUnique : 'default';
                if (!compositeUniques[group]) compositeUniques[group] = [];
                compositeUniques[group].push(name);
            }
        }
        for (const [, columns] of Object.entries(compositeUniques))
        {
            tableConstraints.push(`UNIQUE (${columns.map(c => `"${c}"`).join(', ')})`);
        }

        const allParts = [...cols, ...tableConstraints];
        this._db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${allParts.join(', ')})`);

        // Create indexes defined in schema
        for (const [name, def] of Object.entries(schema))
        {
            if (def.index)
            {
                const idxName = typeof def.index === 'string' ? def.index : `idx_${table}_${name}`;
                this._db.exec(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${table}" ("${name}")`);
            }
        }

        // Composite indexes
        const compositeIndexes = {};
        for (const [name, def] of Object.entries(schema))
        {
            if (def.compositeIndex)
            {
                const group = typeof def.compositeIndex === 'string' ? def.compositeIndex : 'default';
                if (!compositeIndexes[group]) compositeIndexes[group] = [];
                compositeIndexes[group].push(name);
            }
        }
        for (const [group, columns] of Object.entries(compositeIndexes))
        {
            const idxName = `idx_${table}_${group}`;
            this._db.exec(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${table}" (${columns.map(c => `"${c}"`).join(', ')})`);
        }
    }

    /**
     * Drop a table if it exists.
     * @param {string} table - Table name.
     * @returns {Promise<void>}
     */
    async dropTable(table)
    {
        this._db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }

    /**
     * Insert a single row.
     * @param {string} table - Table name.
     * @param {object} data - Row data as key-value pairs.
     * @returns {Promise<object>} The inserted row.
     */
    async insert(table, data)
    {
        const keys = Object.keys(data);
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map(k => this._toSqlValue(data[k]));
        const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders})`;
        const result = this._prepare(sql).run(...values);
        return { ...data, id: result.lastInsertRowid };
    }

    /**
     * Insert multiple rows in a batch.
     * @param {string} table - Table name.
     * @param {Array<object>} dataArray - Array of row objects.
     * @returns {Promise<Array<object>>} The inserted rows.
     */
    async insertMany(table, dataArray)
    {
        if (!dataArray.length) return [];
        const keys = Object.keys(dataArray[0]);
        const placeholders = keys.map(() => '?').join(', ');
        const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders})`;
        const stmt = this._prepare(sql);
        const results = [];
        const runAll = this._db.transaction((items) => {
            for (const data of items)
            {
                const values = keys.map(k => this._toSqlValue(data[k]));
                const result = stmt.run(...values);
                results.push({ ...data, id: result.lastInsertRowid });
            }
        });
        runAll(dataArray);
        return results;
    }

    /**
     * Update a single row by primary key.
     * @param {string} table - Table name.
     * @param {string} pk - Primary key column.
     * @param {*} pkVal - Primary key value.
     * @param {object} data - Fields to update.
     * @returns {Promise<void>}
     */
    async update(table, pk, pkVal, data)
    {
        const sets = Object.keys(data).map(k => `"${k}" = ?`).join(', ');
        const values = [...Object.values(data).map(v => this._toSqlValue(v)), pkVal];
        this._prepare(`UPDATE "${table}" SET ${sets} WHERE "${pk}" = ?`).run(...values);
    }

    /**
     * Update rows matching the given conditions.
     * @param {string} table - Table name.
     * @param {object} conditions - Filter conditions.
     * @param {object} data - Fields to update.
     * @returns {Promise<number>} Number of affected rows.
     */
    async updateWhere(table, conditions, data)
    {
        const { clause, values: whereVals } = this._buildWhere(conditions);
        const sets = Object.keys(data).map(k => `"${k}" = ?`).join(', ');
        const values = [...Object.values(data).map(v => this._toSqlValue(v)), ...whereVals];
        const result = this._prepare(`UPDATE "${table}" SET ${sets}${clause}`).run(...values);
        return result.changes;
    }

    /**
     * Delete a single row by primary key.
     * @param {string} table - Table name.
     * @param {string} pk - Primary key column.
     * @param {*} pkVal - Primary key value.
     * @returns {Promise<void>}
     */
    async remove(table, pk, pkVal)
    {
        this._prepare(`DELETE FROM "${table}" WHERE "${pk}" = ?`).run(pkVal);
    }

    /**
     * Delete rows matching the given conditions.
     * @param {string} table - Table name.
     * @param {object} conditions - Filter conditions.
     * @returns {Promise<number>} Number of deleted rows.
     */
    async deleteWhere(table, conditions)
    {
        const { clause, values } = this._buildWhere(conditions);
        const result = this._prepare(`DELETE FROM "${table}"${clause}`).run(...values);
        return result.changes;
    }

    /**
     * Execute a query descriptor built by the Query builder.
     * @param {object} descriptor - Query descriptor with table, fields, where, orderBy, limit, offset.
     * @returns {Promise<Array<object>>} Result rows.
     */
    async execute(descriptor)
    {
        const { action, table, fields, where, orderBy, limit, offset, distinct, joins, groupBy, having } = descriptor;

        if (action === 'count')
        {
            const { clause, values } = this._buildWhereFromChain(where);
            const joinStr = this._buildJoins(joins, table);
            const row = this._prepare(`SELECT COUNT(*) as count FROM "${table}"${joinStr}${clause}`).get(...values);
            return row.count;
        }

        const selectFields = fields && fields.length
            ? fields.map(f => `"${f}"`).join(', ')
            : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        const joinStr = this._buildJoins(joins, table);
        let sql = `SELECT ${distinctStr}${selectFields} FROM "${table}"${joinStr}`;

        const values = [];
        if (where && where.length > 0)
        {
            const { clause, values: wv } = this._buildWhereFromChain(where);
            sql += clause;
            values.push(...wv);
        }

        sql += this._buildGroupBy(groupBy);
        sql += this._buildHaving(having, values);

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

        return this._prepare(sql).all(...values);
    }

    /**
     * Execute an aggregate function (count, sum, avg, min, max).
     * @param {object} descriptor - Aggregate descriptor with table, function, field, where.
     * @returns {Promise<number|null>} Aggregate result.
     */
    async aggregate(descriptor)
    {
        const { table, where, aggregateFn, aggregateField, joins, groupBy, having } = descriptor;
        const fn = aggregateFn.toUpperCase();
        const joinStr = this._buildJoins(joins, table);
        const values = [];

        let sql = `SELECT ${fn}("${aggregateField}") as result FROM "${table}"${joinStr}`;

        if (where && where.length > 0)
        {
            const { clause, values: wv } = this._buildWhereFromChain(where);
            sql += clause;
            values.push(...wv);
        }

        sql += this._buildGroupBy(groupBy);
        sql += this._buildHaving(having, values);

        const row = this._prepare(sql).get(...values);
        return row ? row.result : null;
    }

    // -- SQLite Utilities -----------------------------------------------

    /**
     * Ping the database to check connectivity.
     * @returns {boolean} true if healthy.
     */
    ping()
    {
        try
        {
            this._db.prepare('SELECT 1').get();
            return true;
        }
        catch
        {
            return false;
        }
    }

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
     * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode='PASSIVE'] - Operation mode.
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
     * @returns {number} File size in bytes.
     */
    fileSize()
    {
        if (this._filename === ':memory:') return 0;
        try { return fs.statSync(path.resolve(this._filename)).size; }
        catch { return 0; }
    }

    /**
     * List all user-created tables.
     * @returns {string[]} Array of table names.
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
     * @param {string} sql - SQL query string.
     * @param {...*}   params - Bound parameter values.
     * @returns {*} Query result rows.
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

    // -- Table Info & Debug (Schema Introspection) -----------

    /**
     * Get column information for a table.
     * @param {string} table - Table name.
     * @returns {Array<{ cid: number, name: string, type: string, notnull: boolean, defaultValue: *, pk: boolean }>}
     */
    columns(table)
    {
        const rows = this._db.pragma(`table_info("${table.replace(/"/g, '""')}")`); 
        return rows.map(r => ({
            cid: r.cid, name: r.name, type: r.type,
            notnull: !!r.notnull, defaultValue: r.dflt_value, pk: !!r.pk,
        }));
    }

    /**
     * Get indexes for a table.
     * @param {string} table - Table name.
     * @returns {Array<{ name: string, unique: boolean, columns: string[] }>}
     */
    indexes(table)
    {
        const idxList = this._db.pragma(`index_list("${table.replace(/"/g, '""')}")`); 
        return idxList.map(idx => {
            const cols = this._db.pragma(`index_info("${idx.name.replace(/"/g, '""')}")`); 
            return {
                name: idx.name, unique: !!idx.unique,
                columns: cols.map(c => c.name),
            };
        });
    }

    /**
     * Get foreign keys for a table.
     * @param {string} table - Table name.
     * @returns {Array<{ id: number, table: string, from: string, to: string, onUpdate: string, onDelete: string }>}
     */
    foreignKeys(table)
    {
        const rows = this._db.pragma(`foreign_key_list("${table.replace(/"/g, '""')}")`); 
        return rows.map(r => ({
            id: r.id, table: r.table, from: r.from, to: r.to,
            onUpdate: r.on_update, onDelete: r.on_delete,
        }));
    }

    /**
     * Get detailed table status (size estimates, row counts).
     * @param {string} [table] - If omitted, returns all tables.
     * @returns {Array<{ name: string, rows: number, pageCount: number }>}
     */
    tableStatus(table)
    {
        const names = table ? [table] : this.tables();
        return names.map(name => {
            const count = this._db.prepare(`SELECT COUNT(*) as count FROM "${name.replace(/"/g, '""')}"`).get();
            return { name, rows: count.count };
        });
    }

    /**
     * Get counts for all tables — structured database overview.
     * @returns {{ tables: Array<{ name: string, rows: number }>, totalRows: number, fileSize: string }}
     */
    overview()
    {
        const tables = this.tableStatus();
        let totalRows = 0;
        for (const t of tables) totalRows += t.rows;
        const bytes = this.fileSize();
        const fmt = (b) => {
            if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
            if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
            if (b >= 1024) return (b / 1024).toFixed(2) + ' KB';
            return b + ' B';
        };
        return { tables, totalRows, fileSize: fmt(bytes) };
    }

    /**
     * Get the page size and page count (helps estimate table overhead).
     * @returns {{ pageSize: number, pageCount: number, totalBytes: number }}
     */
    pageInfo()
    {
        const pageSize = this.pragma('page_size');
        const pageCount = this.pragma('page_count');
        return { pageSize, pageCount, totalBytes: pageSize * pageCount };
    }

    /**
     * Get compile-time options that SQLite was built with.
     * @returns {string[]} Array of compile option strings.
     */
    compileOptions()
    {
        return this._db.pragma('compile_options').map(r => Object.values(r)[0]);
    }

    /**
     * Get the number of cached prepared statements.
     * @returns {{ cached: number, max: number }}
     */
    cacheStatus()
    {
        return { cached: this._stmtCache.size, max: this._stmtCacheMax };
    }

    // -- Schema Migrations -----------------------------------------------

    /**
     * Add a column to an existing table.
     * @param {string} table   - Table name.
     * @param {string} column  - Column name.
     * @param {object} colDef  - Column definition (same format as schema entries).
     */
    addColumn(table, column, colDef)
    {
        let line = `"${column}" ${this._typeMap(colDef)}`;
        if (colDef.required) line += ' NOT NULL';
        if (colDef.unique) line += ' UNIQUE';
        if (colDef.default !== undefined && typeof colDef.default !== 'function')
            line += ` DEFAULT ${this._sqlDefault(colDef.default)}`;
        if (colDef.check) line += ` CHECK(${validateCheck(colDef.check)})`;
        if (colDef.references)
        {
            line += ` REFERENCES "${colDef.references.table}"("${colDef.references.column || 'id'}")`;
            if (colDef.references.onDelete) line += ` ON DELETE ${validateFKAction(colDef.references.onDelete)}`;
            if (colDef.references.onUpdate) line += ` ON UPDATE ${validateFKAction(colDef.references.onUpdate)}`;
        }
        this._db.exec(`ALTER TABLE "${table}" ADD COLUMN ${line}`);
    }

    /**
     * Drop a column from an existing table.
     * Requires SQLite 3.35.0+ (2021-03-12).
     * @param {string} table  - Table name.
     * @param {string} column - Column name.
     */
    dropColumn(table, column)
    {
        this._db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    }

    /**
     * Rename a column in an existing table.
     * Requires SQLite 3.25.0+ (2018-09-15).
     * @param {string} table   - Table name.
     * @param {string} oldName - Current column name.
     * @param {string} newName - New column name.
     */
    renameColumn(table, oldName, newName)
    {
        this._db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${oldName}" TO "${newName}"`);
    }

    /**
     * Rename a table.
     * @param {string} oldName - Current table name.
     * @param {string} newName - New table name.
     */
    renameTable(oldName, newName)
    {
        this._db.exec(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
    }

    /**
     * Create an index.
     * @param {string}   table   - Table name.
     * @param {string[]} columns - Column names.
     * @param {object}   [opts]  - Options.
     * @param {string}   [opts.name]   - Index name (auto-generated if omitted).
     * @param {boolean}  [opts.unique] - Create a UNIQUE index.
     */
    createIndex(table, columns, opts = {})
    {
        const name = opts.name || `idx_${table}_${columns.join('_')}`;
        const unique = opts.unique ? 'UNIQUE ' : '';
        this._db.exec(`CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${table}" (${columns.map(c => `"${c}"`).join(', ')})`);
    }

    /**
     * Drop an index.
     * @param {string} _table - Table name (unused — SQLite indexes are schema-scoped).
     * @param {string} name   - Index name.
     */
    dropIndex(_table, name)
    {
        this._db.exec(`DROP INDEX IF EXISTS "${name}"`);
    }

    /**
     * Check if a table exists.
     * @param {string} table - Table name.
     * @returns {boolean} `true` if the table exists.
     */
    hasTable(table)
    {
        const row = this._db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table);
        return !!row;
    }

    /**
     * Check if a column exists in a table.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @returns {boolean} `true` if the column exists.
     */
    hasColumn(table, column)
    {
        const cols = this.columns(table);
        return cols.some(c => c.name === column);
    }

    /**
     * Get a unified table description.
     * @param {string} table - Table name.
     * @returns {{ columns: Array, indexes: Array, foreignKeys: Array }}
     */
    describeTable(table)
    {
        return {
            columns: this.columns(table),
            indexes: this.indexes(table),
            foreignKeys: this.foreignKeys(table),
        };
    }
}

module.exports = SqliteAdapter;
