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
        const map = {
            string: `VARCHAR(${colDef.maxLength || 255})`, text: 'TEXT',
            integer: 'INT', float: 'DOUBLE', boolean: 'TINYINT(1)',
            date: 'DATE', datetime: 'DATETIME', json: 'JSON', blob: 'BLOB', uuid: 'CHAR(36)',
        };
        return map[colDef.type] || 'TEXT';
    }

    _q(name) { return '`' + name.replace(/`/g, '``') + '`'; }

    async createTable(table, schema)
    {
        const cols = [];
        for (const [name, def] of Object.entries(schema))
        {
            let line = `${this._q(name)} ${this._typeMap(def)}`;
            if (def.primaryKey) line += ' PRIMARY KEY';
            if (def.autoIncrement) line += ' AUTO_INCREMENT';
            if (def.required && !def.primaryKey) line += ' NOT NULL';
            if (def.unique) line += ' UNIQUE';
            if (def.default !== undefined && typeof def.default !== 'function')
                line += ` DEFAULT ${this._sqlDefault(def.default)}`;
            cols.push(line);
        }
        await this._pool.execute(`CREATE TABLE IF NOT EXISTS ${this._q(table)} (${cols.join(', ')})`);
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
        const { action, table, fields, where, orderBy, limit, offset, distinct } = descriptor;

        if (action === 'count')
        {
            const { clause, values } = this._buildWhereFromChain(where);
            const sql = `SELECT COUNT(*) as count FROM ${this._q(table)}${clause.replace(/"/g, '`')}`;
            const [rows] = await this._pool.execute(sql, values);
            return rows[0].count;
        }

        const selectFields = fields && fields.length ? fields.map(f => this._q(f)).join(', ') : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        let sql = `SELECT ${distinctStr}${selectFields} FROM ${this._q(table)}`;
        const values = [];

        if (where && where.length)
        {
            const { clause, values: wv } = this._buildWhereFromChain(where);
            sql += clause.replace(/"/g, '`');
            values.push(...wv);
        }

        if (orderBy && orderBy.length)
            sql += ' ORDER BY ' + orderBy.map(o => `${this._q(o.field)} ${o.dir}`).join(', ');
        if (limit !== null && limit !== undefined)  { sql += ' LIMIT ?'; values.push(limit); }
        if (offset !== null && offset !== undefined) { sql += ' OFFSET ?'; values.push(offset); }

        const [rows] = await this._pool.execute(sql, values);
        return rows;
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
}

module.exports = MysqlAdapter;
