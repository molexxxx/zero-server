/**
 * @module orm/adapters/postgres
 * @description PostgreSQL adapter using the optional `pg` driver.
 *              Requires: `npm install pg`
 *
 * @example
 *   const db = Database.connect('postgres', {
 *       host: '127.0.0.1', user: 'postgres', password: '', database: 'myapp',
 *   });
 */
const BaseSqlAdapter = require('./sql-base');

class PostgresAdapter extends BaseSqlAdapter
{
    /**
     * @param {object}  options
     * @param {string}  [options.host='localhost']       - Server hostname.
     * @param {number}  [options.port=5432]              - Server port.
     * @param {string}  [options.user]                   - Database user.
     * @param {string}  [options.password]               - Database password.
     * @param {string}  options.database                 - Database name.
     * @param {number}  [options.max=10]                 - Max pool size.
     * @param {number}  [options.idleTimeoutMillis=10000] - Idle client timeout.
     * @param {number}  [options.connectionTimeoutMillis=0] - Connection timeout (0 = no limit).
     * @param {boolean|object} [options.ssl]             - SSL mode or TLS options.
     * @param {string}  [options.connectionString]       - Full connection URI (overrides individual settings).
     * @param {string}  [options.application_name]       - Identify the app in pg_stat_activity.
     * @param {number}  [options.statement_timeout]      - Statement timeout in ms.
     */
    constructor(options = {})
    {
        super();
        let pg;
        try { pg = require('pg'); }
        catch (e)
        {
            throw new Error(
                'PostgreSQL adapter requires "pg" package.\n' +
                'Install it with: npm install pg'
            );
        }
        this._pool = new pg.Pool({ max: 10, ...options });
        this._options = options;
    }

    _typeMap(colDef)
    {
        const map = {
            string: `VARCHAR(${colDef.maxLength || 255})`, text: 'TEXT',
            integer: 'INTEGER', float: 'DOUBLE PRECISION', boolean: 'BOOLEAN',
            date: 'DATE', datetime: 'TIMESTAMPTZ', json: 'JSONB', blob: 'BYTEA',
            uuid: 'UUID',
        };
        return map[colDef.type] || 'TEXT';
    }

    /**
     * PostgreSQL uses $1, $2, ... style parameters.
     * Override the base class WHERE builders.
     */

    _buildWherePg(conditions, startIdx = 1)
    {
        if (!conditions || Object.keys(conditions).length === 0)
            return { clause: '', values: [], nextIdx: startIdx };
        const parts = [];
        const values = [];
        let idx = startIdx;
        for (const [k, v] of Object.entries(conditions))
        {
            if (v === null) { parts.push(`"${k}" IS NULL`); }
            else { parts.push(`"${k}" = $${idx++}`); values.push(this._toSqlValue(v)); }
        }
        return { clause: ' WHERE ' + parts.join(' AND '), values, nextIdx: idx };
    }

    _buildWhereFromChainPg(where, startIdx = 1)
    {
        if (!where || where.length === 0) return { clause: '', values: [], nextIdx: startIdx };
        const parts = [];
        const values = [];
        let idx = startIdx;

        for (let i = 0; i < where.length; i++)
        {
            const w = where[i];

            // Handle raw WHERE clauses (from whereRaw) — convert ? to $N
            if (w.raw)
            {
                let rawExpr = w.raw;
                if (w.params)
                {
                    for (const p of w.params)
                    {
                        rawExpr = rawExpr.replace('?', `$${idx++}`);
                        values.push(p);
                    }
                }
                if (i === 0) parts.push(rawExpr);
                else parts.push(`${w.logic} ${rawExpr}`);
                continue;
            }

            const { field, op, value, logic } = w;
            let expr;

            if (op === 'IS NULL') expr = `"${field}" IS NULL`;
            else if (op === 'IS NOT NULL') expr = `"${field}" IS NOT NULL`;
            else if (op === 'IN' || op === 'NOT IN')
            {
                if (!Array.isArray(value) || value.length === 0)
                    expr = op === 'IN' ? '0=1' : '1=1';
                else
                {
                    const placeholders = value.map(() => `$${idx++}`).join(', ');
                    expr = `"${field}" ${op} (${placeholders})`;
                    values.push(...value.map(v => this._toSqlValue(v)));
                }
            }
            else if (op === 'BETWEEN')
            {
                expr = `"${field}" BETWEEN $${idx++} AND $${idx++}`;
                values.push(this._toSqlValue(value[0]), this._toSqlValue(value[1]));
            }
            else
            {
                expr = `"${field}" ${op} $${idx++}`;
                values.push(this._toSqlValue(value));
            }

            if (i === 0) parts.push(expr);
            else parts.push(`${logic} ${expr}`);
        }

        return { clause: ' WHERE ' + parts.join(' '), values, nextIdx: idx };
    }

    async createTable(table, schema)
    {
        const cols = [];
        for (const [name, def] of Object.entries(schema))
        {
            let line = `"${name}" ${this._typeMap(def)}`;
            if (def.primaryKey && def.autoIncrement)
            {
                line = `"${name}" SERIAL PRIMARY KEY`;
            }
            else
            {
                if (def.primaryKey) line += ' PRIMARY KEY';
                if (def.required && !def.primaryKey) line += ' NOT NULL';
                if (def.unique) line += ' UNIQUE';
                if (def.default !== undefined && typeof def.default !== 'function')
                    line += ` DEFAULT ${this._sqlDefault(def.default)}`;
            }
            cols.push(line);
        }
        await this._pool.query(`CREATE TABLE IF NOT EXISTS "${table}" (${cols.join(', ')})`);
    }

    async dropTable(table)
    {
        await this._pool.query(`DROP TABLE IF EXISTS "${table}"`);
    }

    async insert(table, data)
    {
        const keys = Object.keys(data);
        const values = keys.map(k => this._toSqlValue(data[k]));
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`;
        const { rows } = await this._pool.query(sql, values);
        return rows[0] || { ...data };
    }

    async update(table, pk, pkVal, data)
    {
        const keys = Object.keys(data);
        const values = keys.map(k => this._toSqlValue(data[k]));
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        values.push(pkVal);
        await this._pool.query(`UPDATE "${table}" SET ${sets} WHERE "${pk}" = $${values.length}`, values);
    }

    async updateWhere(table, conditions, data)
    {
        const keys = Object.keys(data);
        const values = keys.map(k => this._toSqlValue(data[k]));
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const { clause, values: whereVals } = this._buildWherePg(conditions, keys.length + 1);
        values.push(...whereVals);
        const { rowCount } = await this._pool.query(`UPDATE "${table}" SET ${sets}${clause}`, values);
        return rowCount;
    }

    async remove(table, pk, pkVal)
    {
        await this._pool.query(`DELETE FROM "${table}" WHERE "${pk}" = $1`, [pkVal]);
    }

    async deleteWhere(table, conditions)
    {
        const { clause, values } = this._buildWherePg(conditions);
        const { rowCount } = await this._pool.query(`DELETE FROM "${table}"${clause}`, values);
        return rowCount;
    }

    async execute(descriptor)
    {
        const { action, table, fields, where, orderBy, limit, offset, distinct } = descriptor;

        if (action === 'count')
        {
            const { clause, values } = this._buildWhereFromChainPg(where);
            const { rows } = await this._pool.query(`SELECT COUNT(*) as count FROM "${table}"${clause}`, values);
            return parseInt(rows[0].count, 10);
        }

        const selectFields = fields && fields.length ? fields.map(f => `"${f}"`).join(', ') : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        let sql = `SELECT ${distinctStr}${selectFields} FROM "${table}"`;
        const values = [];
        let paramIdx = 1;

        if (where && where.length)
        {
            const { clause, values: wv, nextIdx } = this._buildWhereFromChainPg(where, paramIdx);
            sql += clause;
            values.push(...wv);
            paramIdx = nextIdx;
        }

        if (orderBy && orderBy.length)
            sql += ' ORDER BY ' + orderBy.map(o => `"${o.field}" ${o.dir}`).join(', ');
        if (limit !== null && limit !== undefined)
        {
            sql += ` LIMIT $${paramIdx++}`;
            values.push(limit);
        }
        if (offset !== null && offset !== undefined)
        {
            sql += ` OFFSET $${paramIdx++}`;
            values.push(offset);
        }

        const { rows } = await this._pool.query(sql, values);
        return rows;
    }

    async close() { await this._pool.end(); }
    async raw(sql, ...params) { const { rows } = await this._pool.query(sql, params); return rows; }

    async transaction(fn)
    {
        const client = await this._pool.connect();
        try
        {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        }
        catch (e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
    }

    // -- PostgreSQL Utilities ----------------------------

    /**
     * List all user-created tables in the current schema.
     * @param {string} [schema='public'] - Schema name.
     * @returns {Promise<string[]>}
     */
    async tables(schema = 'public')
    {
        const { rows } = await this._pool.query(
            `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename`,
            [schema]
        );
        return rows.map(r => r.tablename);
    }

    /**
     * Get column information for a table.
     * @param {string} table
     * @param {string} [schema='public']
     * @returns {Promise<Array<{ column_name: string, data_type: string, is_nullable: string, column_default: string }>>}
     */
    async columns(table, schema = 'public')
    {
        const { rows } = await this._pool.query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [schema, table]
        );
        return rows;
    }

    /**
     * Get the current database size in bytes.
     * @returns {Promise<number>}
     */
    async databaseSize()
    {
        const { rows } = await this._pool.query('SELECT pg_database_size(current_database()) AS size');
        return Number(rows[0].size) || 0;
    }

    /**
     * Get the row count for a table (estimated for large tables, exact for small ones).
     * @param {string} table
     * @returns {Promise<number>}
     */
    async tableSize(table)
    {
        const { rows } = await this._pool.query(
            `SELECT pg_total_relation_size($1) AS size`, [table]
        );
        return Number(rows[0].size) || 0;
    }

    /**
     * Get connection pool status.
     * @returns {{ total: number, idle: number, waiting: number }}
     */
    poolStatus()
    {
        return {
            total:   this._pool.totalCount,
            idle:    this._pool.idleCount,
            waiting: this._pool.waitingCount,
        };
    }

    /**
     * Get the PostgreSQL server version string.
     * @returns {Promise<string>}
     */
    async version()
    {
        const { rows } = await this._pool.query('SELECT version() AS ver');
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
            await this._pool.query('SELECT 1');
            return true;
        }
        catch { return false; }
    }

    /**
     * Execute a raw statement that doesn't return rows (INSERT, UPDATE, DDL).
     * @param {string} sql
     * @param {...*}   params
     * @returns {Promise<{ rowCount: number }>}
     */
    async exec(sql, ...params)
    {
        const { rowCount } = await this._pool.query(sql, params);
        return { rowCount: rowCount || 0 };
    }

    /**
     * Run a LISTEN/NOTIFY style query. Useful for subscribing to PG notifications.
     * @param {string} channel
     * @param {Function} callback - Receives { channel, payload }.
     * @returns {Promise<Function>} Unlisten function.
     */
    async listen(channel, callback)
    {
        const client = await this._pool.connect();
        await client.query(`LISTEN ${channel}`);
        client.on('notification', callback);
        return async () =>
        {
            await client.query(`UNLISTEN ${channel}`);
            client.removeListener('notification', callback);
            client.release();
        };
    }
}

module.exports = PostgresAdapter;
