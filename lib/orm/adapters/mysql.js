/**
 * @module orm/adapters/mysql
 * @description MySQL / MariaDB adapter using the optional `mysql2` driver.
 *              Requires: `npm install mysql2`
 *
 * @example
 *   const db = Database.connect('mysql', {
 *       host: '127.0.0.1', user: 'root', password: '', database: 'myapp',
 *   });
 */
const BaseSqlAdapter = require('./sql-base');
const { validateFKAction, validateCheck } = require('../schema');

class MysqlAdapter extends BaseSqlAdapter
{
    /**
     * @param {object}  options
     * @param {string}  [options.host='localhost']       - Server hostname.
     * @param {number}  [options.port=3306]              - Server port.
     * @param {string}  [options.user='root']            - Database user.
     * @param {string}  [options.password='']            - Database password.
     * @param {string}  options.database                 - Database name.
     * @param {number}  [options.connectionLimit=10]     - Max pool connections.
     * @param {boolean} [options.waitForConnections=true] - Queue when pool is full.
     * @param {number}  [options.queueLimit=0]           - Max queued requests (0 = unlimited).
     * @param {number}  [options.connectTimeout=10000]   - Connection timeout in ms.
     * @param {string}  [options.charset='utf8mb4']      - Default character set.
     * @param {string}  [options.timezone='Z']           - Session timezone.
     * @param {boolean} [options.multipleStatements=false] - Allow multi-statement queries.
     * @param {boolean} [options.decimalNumbers=false]   - Return DECIMAL as numbers instead of strings.
     * @param {string}  [options.ssl]                    - SSL profile or options object.
     */
    constructor(options = {})
    {
        super();
        let mysql;
        try { mysql = require('mysql2/promise'); }
        catch (e)
        {
            throw new Error(
                'MySQL adapter requires "mysql2" package.\n' +
                'Install it with: npm install mysql2'
            );
        }
        this._pool = mysql.createPool({
            connectionLimit: 10,
            waitForConnections: true,
            ...options,
        });
        this._options = options;
    }

    _typeMap(colDef)
    {
        const esc = v => v.replace(/'/g, "''");
        const map = {
            string: `VARCHAR(${colDef.maxLength || 255})`, text: 'TEXT',
            integer: 'INT', float: 'DOUBLE', boolean: 'TINYINT(1)',
            date: 'DATE', datetime: 'DATETIME', json: 'JSON', blob: 'BLOB', uuid: 'CHAR(36)',
            bigint: 'BIGINT', smallint: 'SMALLINT', tinyint: 'TINYINT',
            decimal: `DECIMAL(${colDef.precision || 10},${colDef.scale || 2})`,
            mediumtext: 'MEDIUMTEXT', longtext: 'LONGTEXT',
            mediumblob: 'MEDIUMBLOB', longblob: 'LONGBLOB',
            enum: colDef.enum ? `ENUM(${colDef.enum.map(v => `'${esc(String(v))}'`).join(',')})` : 'VARCHAR(255)',
            set: colDef.values ? `SET(${colDef.values.map(v => `'${esc(String(v))}'`).join(',')})` : 'VARCHAR(255)',
            timestamp: 'TIMESTAMP',
            time: 'TIME',
            year: 'YEAR',
            binary: `BINARY(${colDef.length || 255})`,
            varbinary: `VARBINARY(${colDef.length || 255})`,
            double: 'DOUBLE',
            real: 'REAL',
        };
        return map[colDef.type] || 'TEXT';
    }

    _q(name) { return '`' + name.replace(/`/g, '``') + '`'; }

    async createTable(table, schema, tableOptions = {})
    {
        const cols = [];
        const tableConstraints = [];
        const compositePKs = [];

        for (const [name, def] of Object.entries(schema))
        {
            let line = `${this._q(name)} ${this._typeMap(def)}`;

            // Collect composite PK candidates
            if (def.primaryKey && def.compositeKey) { compositePKs.push(name); }
            else if (def.primaryKey)
            {
                line += ' PRIMARY KEY';
                if (def.autoIncrement) line += ' AUTO_INCREMENT';
            }

            if (def.unsigned) line += ' UNSIGNED';
            if (def.required && !def.primaryKey) line += ' NOT NULL';
            if (def.unique && !def.compositeUnique) line += ' UNIQUE';
            if (def.default !== undefined && typeof def.default !== 'function')
                line += ` DEFAULT ${this._sqlDefault(def.default)}`;

            // CHECK constraint
            if (def.check)
            {
                line += ` CHECK(${validateCheck(def.check)})`;
            }

            if (def.charset) line += ` CHARACTER SET ${this._safeIdent(def.charset)}`;
            if (def.collation) line += ` COLLATE ${this._safeIdent(def.collation)}`;
            if (def.comment) line += ` COMMENT '${def.comment.replace(/'/g, "''")}'`;
            cols.push(line);

            // Foreign key constraint (table-level)
            if (def.references)
            {
                const fkName = `fk_${table}_${name}`;
                let fk = `CONSTRAINT ${this._q(fkName)} FOREIGN KEY (${this._q(name)}) REFERENCES ${this._q(def.references.table)}(${this._q(def.references.column || 'id')})`;
                if (def.references.onDelete) fk += ` ON DELETE ${validateFKAction(def.references.onDelete)}`;
                if (def.references.onUpdate) fk += ` ON UPDATE ${validateFKAction(def.references.onUpdate)}`;
                tableConstraints.push(fk);
            }
        }

        // Composite primary key
        if (compositePKs.length > 0)
        {
            tableConstraints.push(`PRIMARY KEY (${compositePKs.map(k => this._q(k)).join(', ')})`);
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
        for (const [group, columns] of Object.entries(compositeUniques))
        {
            tableConstraints.push(`UNIQUE KEY ${this._q(`uq_${table}_${group}`)} (${columns.map(c => this._q(c)).join(', ')})`);
        }

        const allParts = [...cols, ...tableConstraints];
        let sql = `CREATE TABLE IF NOT EXISTS ${this._q(table)} (${allParts.join(', ')})`;
        const engine = tableOptions.engine || this._options.engine || 'InnoDB';
        const charset = tableOptions.charset || this._options.charset || 'utf8mb4';
        const collation = tableOptions.collation || this._options.collation || 'utf8mb4_unicode_ci';
        sql += ` ENGINE=${this._safeIdent(engine)}`;
        sql += ` DEFAULT CHARSET=${this._safeIdent(charset)}`;
        sql += ` COLLATE=${this._safeIdent(collation)}`;
        if (tableOptions.comment) sql += ` COMMENT='${tableOptions.comment.replace(/'/g, "''")}'`;
        await this._pool.execute(sql);

        // Create indexes defined in schema
        for (const [name, def] of Object.entries(schema))
        {
            if (def.index)
            {
                const idxName = typeof def.index === 'string' ? def.index : `idx_${table}_${name}`;
                await this._pool.execute(`CREATE INDEX ${this._q(idxName)} ON ${this._q(table)} (${this._q(name)})`);
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
            await this._pool.execute(`CREATE INDEX ${this._q(idxName)} ON ${this._q(table)} (${columns.map(c => this._q(c)).join(', ')})`);
        }
    }

    async dropTable(table)
    {
        await this._pool.execute(`DROP TABLE IF EXISTS ${this._q(table)}`);
    }

    async insert(table, data)
    {
        const keys = Object.keys(data);
        const placeholders = keys.map(() => '?').join(', ');
        const values = keys.map(k => this._toSqlValue(data[k]));
        const [result] = await this._pool.execute(
            `INSERT INTO ${this._q(table)} (${keys.map(k => this._q(k)).join(', ')}) VALUES (${placeholders})`,
            values
        );
        return { ...data, id: result.insertId || data.id };
    }

    async insertMany(table, dataArray)
    {
        if (!dataArray.length) return [];
        const keys = Object.keys(dataArray[0]);
        const singlePlaceholders = `(${keys.map(() => '?').join(', ')})`;
        const allPlaceholders = dataArray.map(() => singlePlaceholders).join(', ');
        const values = [];
        for (const data of dataArray)
        {
            for (const k of keys) values.push(this._toSqlValue(data[k]));
        }
        const sql = `INSERT INTO ${this._q(table)} (${keys.map(k => this._q(k)).join(', ')}) VALUES ${allPlaceholders}`;
        const [result] = await this._pool.execute(sql, values);
        return dataArray.map((data, i) => ({ ...data, id: (result.insertId || 0) + i }));
    }

    async update(table, pk, pkVal, data)
    {
        const sets = Object.keys(data).map(k => `${this._q(k)} = ?`).join(', ');
        const values = [...Object.values(data).map(v => this._toSqlValue(v)), pkVal];
        await this._pool.execute(`UPDATE ${this._q(table)} SET ${sets} WHERE ${this._q(pk)} = ?`, values);
    }

    async updateWhere(table, conditions, data)
    {
        const { clause, values: whereVals } = this._buildWhere(conditions);
        const sets = Object.keys(data).map(k => `${this._q(k)} = ?`).join(', ');
        const values = [...Object.values(data).map(v => this._toSqlValue(v)), ...whereVals];
        const sql = `UPDATE ${this._q(table)} SET ${sets}${clause.replace(/"/g, '`')}`;
        const [result] = await this._pool.execute(sql, values);
        return result.affectedRows;
    }

    async remove(table, pk, pkVal)
    {
        await this._pool.execute(`DELETE FROM ${this._q(table)} WHERE ${this._q(pk)} = ?`, [pkVal]);
    }

    async deleteWhere(table, conditions)
    {
        const { clause, values } = this._buildWhere(conditions);
        const sql = `DELETE FROM ${this._q(table)}${clause.replace(/"/g, '`')}`;
        const [result] = await this._pool.execute(sql, values);
        return result.affectedRows;
    }

    async execute(descriptor)
    {
        const { action, table, fields, where, orderBy, limit, offset, distinct, joins, groupBy, having } = descriptor;
        const q = this._q.bind(this);

        if (action === 'count')
        {
            const { clause, values } = this._buildWhereFromChain(where);
            const joinStr = this._buildJoins(joins, table, q);
            const sql = `SELECT COUNT(*) as count FROM ${q(table)}${joinStr}${clause.replace(/"/g, '`')}`;
            const [rows] = await this._pool.execute(sql, values);
            return rows[0].count;
        }

        const selectFields = fields && fields.length ? fields.map(f => q(f)).join(', ') : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        const joinStr = this._buildJoins(joins, table, q);
        let sql = `SELECT ${distinctStr}${selectFields} FROM ${q(table)}${joinStr}`;
        const values = [];

        if (where && where.length)
        {
            const { clause, values: wv } = this._buildWhereFromChain(where);
            sql += clause.replace(/"/g, '`');
            values.push(...wv);
        }

        sql += this._buildGroupBy(groupBy, q);
        sql += this._buildHaving(having, values, q);

        if (orderBy && orderBy.length)
            sql += ' ORDER BY ' + orderBy.map(o => `${q(o.field)} ${o.dir}`).join(', ');
        if (limit !== null && limit !== undefined)  { sql += ' LIMIT ?'; values.push(limit); }
        if (offset !== null && offset !== undefined) { sql += ' OFFSET ?'; values.push(offset); }

        const [rows] = await this._pool.execute(sql, values);
        return rows;
    }

    async aggregate(descriptor)
    {
        const { table, where, aggregateFn, aggregateField, joins, groupBy, having } = descriptor;
        const q = this._q.bind(this);
        const fn = aggregateFn.toUpperCase();
        const joinStr = this._buildJoins(joins, table, q);
        const values = [];

        let sql = `SELECT ${fn}(${q(aggregateField)}) as result FROM ${q(table)}${joinStr}`;

        if (where && where.length)
        {
            const { clause, values: wv } = this._buildWhereFromChain(where);
            sql += clause.replace(/"/g, '`');
            values.push(...wv);
        }

        sql += this._buildGroupBy(groupBy, q);
        sql += this._buildHaving(having, values, q);

        const [rows] = await this._pool.execute(sql, values);
        return rows[0] ? rows[0].result : null;
    }

    async close() { await this._pool.end(); }

    async raw(sql, ...params) { const [rows] = await this._pool.execute(sql, params); return rows; }

    async transaction(fn)
    {
        const conn = await this._pool.getConnection();
        try
        {
            await conn.beginTransaction();
            const result = await fn(conn);
            await conn.commit();
            return result;
        }
        catch (e) { await conn.rollback(); throw e; }
        finally { conn.release(); }
    }

    // -- MySQL Utilities ---------------------------------

    /**
     * List all user-created tables in the current database.
     * @returns {Promise<string[]>}
     */
    async tables()
    {
        const [rows] = await this._pool.execute('SHOW TABLES');
        return rows.map(r => Object.values(r)[0]);
    }

    /**
     * Get the columns of a table.
     * @param {string} table - Table name.
     * @returns {Promise<Array<{ Field: string, Type: string, Null: string, Key: string, Default: *, Extra: string }>>}
     */
    async columns(table)
    {
        const [rows] = await this._pool.execute(`SHOW COLUMNS FROM ${this._q(table)}`);
        return rows;
    }

    /**
     * Get the current database size in bytes.
     * @returns {Promise<number>}
     */
    async databaseSize()
    {
        const db = this._options.database;
        if (!db) return 0;
        const [rows] = await this._pool.execute(
            `SELECT SUM(data_length + index_length) AS size
             FROM information_schema.tables WHERE table_schema = ?`, [db]
        );
        return Number(rows[0].size) || 0;
    }

    /**
     * Get connection pool status.
     * @returns {{ total: number, idle: number, used: number, queued: number }}
     */
    poolStatus()
    {
        const pool = this._pool.pool;
        if (!pool) return { total: 0, idle: 0, used: 0, queued: 0 };
        return {
            total: pool._allConnections?.length || 0,
            idle:  pool._freeConnections?.length || 0,
            used:  (pool._allConnections?.length || 0) - (pool._freeConnections?.length || 0),
            queued: pool._connectionQueue?.length || 0,
        };
    }

    /**
     * Get the MySQL/MariaDB server version string.
     * @returns {Promise<string>}
     */
    async version()
    {
        const [rows] = await this._pool.execute('SELECT VERSION() AS ver');
        return rows[0].ver;
    }

    /**
     * Ping the database to check connectivity.
     * @returns {Promise<boolean>}
     */
    async ping()
    {
        try
        {
            const conn = await this._pool.getConnection();
            await conn.ping();
            conn.release();
            return true;
        }
        catch { return false; }
    }

    /**
     * Execute a raw statement that doesn't return rows (INSERT, UPDATE, DDL).
     * @param {string} sql
     * @param {...*}   params
     * @returns {Promise<{ affectedRows: number, insertId: number }>}
     */
    async exec(sql, ...params)
    {
        const [result] = await this._pool.execute(sql, params);
        return { affectedRows: result.affectedRows || 0, insertId: result.insertId || 0 };
    }

    // -- Table Info & Debug (Schema Introspection) -----------

    /**
     * Get detailed table status (rows, size, engine, collation, etc.).
     * Returns a structured database overview.
     * @param {string} [table] - Table name. If omitted, returns all tables.
     * @returns {Promise<Array<{ name: string, engine: string, rows: number, dataLength: number, indexLength: number, totalSize: number, autoIncrement: number, collation: string, createTime: string, updateTime: string, comment: string }>>}
     */
    async tableStatus(table)
    {
        let sql = 'SHOW TABLE STATUS';
        const params = [];
        if (table){ sql += ` LIKE ?`; params.push(table); }
        const [rows] = await this._pool.execute(sql, params);
        return rows.map(r => ({
            name: r.Name, engine: r.Engine, rows: Number(r.Rows) || 0,
            dataLength: Number(r.Data_length) || 0, indexLength: Number(r.Index_length) || 0,
            totalSize: (Number(r.Data_length) || 0) + (Number(r.Index_length) || 0),
            autoIncrement: r.Auto_increment, collation: r.Collation,
            createTime: r.Create_time, updateTime: r.Update_time,
            comment: r.Comment || '',
        }));
    }

    /**
     * Get table size in a human-readable format.
     * @param {string} table
     * @returns {Promise<{ rows: number, dataSize: string, indexSize: string, totalSize: string }>}
     */
    async tableSize(table)
    {
        const status = await this.tableStatus(table);
        if (!status.length) return { rows: 0, dataSize: '0 B', indexSize: '0 B', totalSize: '0 B' };
        const s = status[0];
        const fmt = (b) => {
            if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
            if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
            if (b >= 1024) return (b / 1024).toFixed(2) + ' KB';
            return b + ' B';
        };
        return { rows: s.rows, dataSize: fmt(s.dataLength), indexSize: fmt(s.indexLength), totalSize: fmt(s.totalSize) };
    }

    /**
     * Get indexes for a table.
     * @param {string} table
     * @returns {Promise<Array<{ name: string, column: string, unique: boolean, type: string, cardinality: number }>>}
     */
    async indexes(table)
    {
        const [rows] = await this._pool.execute(`SHOW INDEX FROM ${this._q(table)}`);
        return rows.map(r => ({
            name: r.Key_name, column: r.Column_name, unique: !r.Non_unique,
            type: r.Index_type, cardinality: Number(r.Cardinality) || 0,
        }));
    }

    /**
     * Get the charset and collation of a table.
     * @param {string} table
     * @returns {Promise<{ charset: string, collation: string }>}
     */
    async tableCharset(table)
    {
        const [rows] = await this._pool.execute(
            `SELECT TABLE_COLLATION FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
            [this._options.database, table]
        );
        if (!rows.length) return { charset: '', collation: '' };
        const collation = rows[0].TABLE_COLLATION || '';
        const charset = collation.split('_')[0] || '';
        return { charset, collation };
    }

    /**
     * Get foreign keys for a table.
     * @param {string} table
     * @returns {Promise<Array<{ constraintName: string, column: string, referencedTable: string, referencedColumn: string, onDelete: string, onUpdate: string }>>}
     */
    async foreignKeys(table)
    {
        const [rows] = await this._pool.execute(
            `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME,
                    DELETE_RULE, UPDATE_RULE
             FROM information_schema.KEY_COLUMN_USAGE kcu
             JOIN information_schema.REFERENTIAL_CONSTRAINTS rc USING (CONSTRAINT_NAME, CONSTRAINT_SCHEMA)
             WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
            [this._options.database, table]
        );
        return rows.map(r => ({
            constraintName: r.CONSTRAINT_NAME, column: r.COLUMN_NAME,
            referencedTable: r.REFERENCED_TABLE_NAME, referencedColumn: r.REFERENCED_COLUMN_NAME,
            onDelete: r.DELETE_RULE, onUpdate: r.UPDATE_RULE,
        }));
    }

    /**
     * Get full database overview — all tables with size and row counts.
     * Returns a structured database summary.
     * @returns {Promise<{ tables: Array, totalSize: string, totalRows: number }>}
     */
    async overview()
    {
        const status = await this.tableStatus();
        let totalBytes = 0;
        let totalRows = 0;
        const fmt = (b) => {
            if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
            if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
            if (b >= 1024) return (b / 1024).toFixed(2) + ' KB';
            return b + ' B';
        };
        const tables = status.map(s => {
            totalBytes += s.totalSize;
            totalRows += s.rows;
            return { ...s, formattedSize: fmt(s.totalSize) };
        });
        return { tables, totalSize: fmt(totalBytes), totalRows };
    }

    /**
     * Get the server variables (global settings).
     * @param {string} [filter] - LIKE pattern to filter variables.
     * @returns {Promise<Object<string, string>>}
     */
    async variables(filter)
    {
        const sql = filter ? `SHOW VARIABLES LIKE ?` : 'SHOW VARIABLES';
        const params = filter ? [filter] : [];
        const [rows] = await this._pool.execute(sql, params);
        const out = {};
        for (const r of rows) out[r.Variable_name] = r.Value;
        return out;
    }

    /**
     * Get processlist — active connections/queries.
     * @returns {Promise<Array<{ id: number, user: string, host: string, db: string, command: string, time: number, state: string, info: string }>>}
     */
    async processlist()
    {
        const [rows] = await this._pool.execute('SHOW PROCESSLIST');
        return rows.map(r => ({
            id: r.Id, user: r.User, host: r.Host, db: r.db,
            command: r.Command, time: r.Time, state: r.State, info: r.Info,
        }));
    }

    /**
     * Alter a table's engine, charset, or collation.
     * @param {string} table
     * @param {object} opts
     * @param {string} [opts.engine]    - e.g. 'InnoDB', 'MyISAM'
     * @param {string} [opts.charset]   - e.g. 'utf8mb4', 'latin1'
     * @param {string} [opts.collation] - e.g. 'utf8mb4_unicode_ci'
     */
    async alterTable(table, opts = {})
    {
        const parts = [];
        if (opts.engine) parts.push(`ENGINE=${this._safeIdent(opts.engine)}`);
        if (opts.charset) parts.push(`DEFAULT CHARSET=${this._safeIdent(opts.charset)}`);
        if (opts.collation) parts.push(`COLLATE=${this._safeIdent(opts.collation)}`);
        if (parts.length === 0) return;
        await this._pool.execute(`ALTER TABLE ${this._q(table)} ${parts.join(', ')}`);
    }

    /**
     * Validate an identifier (engine, charset, collation) to prevent SQL injection.
     * Only allows alphanumeric characters, underscores, and hyphens.
     * @private
     * @param {string} value
     * @returns {string}
     */
    _safeIdent(value)
    {
        const s = String(value);
        if (!/^[a-zA-Z0-9_\-]+$/.test(s)) throw new Error(`Invalid identifier: ${s}`);
        return s;
    }

    // -- Schema Migrations -----------------------------------------------

    /**
     * Add a column to an existing table.
     * @param {string} table   - Table name.
     * @param {string} column  - Column name.
     * @param {object} colDef  - Column definition.
     * @param {object} [opts]  - Options.
     * @param {string} [opts.after] - Place column after this column.
     */
    async addColumn(table, column, colDef, opts = {})
    {
        let line = `${this._q(column)} ${this._typeMap(colDef)}`;
        if (colDef.unsigned) line += ' UNSIGNED';
        if (colDef.required) line += ' NOT NULL';
        if (colDef.unique) line += ' UNIQUE';
        if (colDef.default !== undefined && typeof colDef.default !== 'function')
            line += ` DEFAULT ${this._sqlDefault(colDef.default)}`;
        if (colDef.check) line += ` CHECK(${validateCheck(colDef.check)})`;
        if (colDef.comment) line += ` COMMENT '${colDef.comment.replace(/'/g, "''")}'`;
        let sql = `ALTER TABLE ${this._q(table)} ADD COLUMN ${line}`;
        if (opts.after) sql += ` AFTER ${this._q(opts.after)}`;
        await this._pool.execute(sql);

        // Add FK if specified
        if (colDef.references)
        {
            const fkName = `fk_${table}_${column}`;
            let fk = `ALTER TABLE ${this._q(table)} ADD CONSTRAINT ${this._q(fkName)} FOREIGN KEY (${this._q(column)}) REFERENCES ${this._q(colDef.references.table)}(${this._q(colDef.references.column || 'id')})`;
            if (colDef.references.onDelete) fk += ` ON DELETE ${validateFKAction(colDef.references.onDelete)}`;
            if (colDef.references.onUpdate) fk += ` ON UPDATE ${validateFKAction(colDef.references.onUpdate)}`;
            await this._pool.execute(fk);
        }
    }

    /**
     * Drop a column from an existing table.
     * @param {string} table  - Table name.
     * @param {string} column - Column name.
     */
    async dropColumn(table, column)
    {
        await this._pool.execute(`ALTER TABLE ${this._q(table)} DROP COLUMN ${this._q(column)}`);
    }

    /**
     * Rename a column.
     * @param {string} table   - Table name.
     * @param {string} oldName - Current column name.
     * @param {string} newName - New column name.
     */
    async renameColumn(table, oldName, newName)
    {
        await this._pool.execute(`ALTER TABLE ${this._q(table)} RENAME COLUMN ${this._q(oldName)} TO ${this._q(newName)}`);
    }

    /**
     * Rename a table.
     * @param {string} oldName - Current table name.
     * @param {string} newName - New table name.
     */
    async renameTable(oldName, newName)
    {
        await this._pool.execute(`RENAME TABLE ${this._q(oldName)} TO ${this._q(newName)}`);
    }

    /**
     * Create an index.
     * @param {string}   table   - Table name.
     * @param {string[]} columns - Column names.
     * @param {object}   [opts]  - Options.
     * @param {string}   [opts.name]   - Index name.
     * @param {boolean}  [opts.unique] - Create a UNIQUE index.
     */
    async createIndex(table, columns, opts = {})
    {
        const name = opts.name || `idx_${table}_${columns.join('_')}`;
        const unique = opts.unique ? 'UNIQUE ' : '';
        await this._pool.execute(`CREATE ${unique}INDEX ${this._q(name)} ON ${this._q(table)} (${columns.map(c => this._q(c)).join(', ')})`);
    }

    /**
     * Drop an index.
     * @param {string} table - Table name.
     * @param {string} name  - Index name.
     */
    async dropIndex(table, name)
    {
        await this._pool.execute(`DROP INDEX ${this._q(name)} ON ${this._q(table)}`);
    }

    /**
     * Add a foreign key constraint.
     * @param {string} table       - Table name.
     * @param {string} column      - Column name.
     * @param {string} refTable    - Referenced table.
     * @param {string} refColumn   - Referenced column.
     * @param {{ onDelete?: string, onUpdate?: string, name?: string }} [options={}]
     */
    async addForeignKey(table, column, refTable, refColumn, options = {})
    {
        const fkName = options.name || `fk_${table}_${column}`;
        let sql = `ALTER TABLE ${this._q(table)} ADD CONSTRAINT ${this._q(fkName)} FOREIGN KEY (${this._q(column)}) REFERENCES ${this._q(refTable)}(${this._q(refColumn)})`;
        if (options.onDelete) sql += ` ON DELETE ${validateFKAction(options.onDelete)}`;
        if (options.onUpdate) sql += ` ON UPDATE ${validateFKAction(options.onUpdate)}`;
        await this._pool.execute(sql);
    }

    /**
     * Drop a foreign key constraint.
     * @param {string} table  - Table name.
     * @param {string} fkName - Constraint name.
     */
    async dropForeignKey(table, fkName)
    {
        await this._pool.execute(`ALTER TABLE ${this._q(table)} DROP FOREIGN KEY ${this._q(fkName)}`);
    }

    /**
     * Check if a table exists.
     * @param {string} table
     * @returns {Promise<boolean>}
     */
    async hasTable(table)
    {
        const [rows] = await this._pool.execute(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1`,
            [this._options.database, table]
        );
        return rows.length > 0;
    }

    /**
     * Check if a column exists in a table.
     * @param {string} table
     * @param {string} column
     * @returns {Promise<boolean>}
     */
    async hasColumn(table, column)
    {
        const [rows] = await this._pool.execute(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ? LIMIT 1`,
            [this._options.database, table, column]
        );
        return rows.length > 0;
    }

    /**
     * Get a unified table description.
     * @param {string} table
     * @returns {Promise<{ columns: Array, indexes: Array, foreignKeys: Array }>}
     */
    async describeTable(table)
    {
        return {
            columns: await this.columns(table),
            indexes: await this.indexes(table),
            foreignKeys: await this.foreignKeys(table),
        };
    }
}

module.exports = MysqlAdapter;
