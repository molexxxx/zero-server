/**
 * @module orm/adapters/postgres
 * @description PostgreSQL adapter using the optional `pg` driver.
 *              Requires: `npm install pg`
 *
 * @example
 *   const { Database, Model, TYPES } = require('zero-http');
 *
 *   const db = Database.connect('postgres', {
 *       host: '127.0.0.1',
 *       user: 'postgres',
 *       password: '',
 *       database: 'myapp',
 *   });
 *
 *   class Article extends Model {
 *       static table  = 'articles';
 *       static schema = {
 *           id:      { type: TYPES.SERIAL, primaryKey: true },
 *           title:   { type: TYPES.STRING,  required: true },
 *           content: { type: TYPES.TEXT },
 *           tags:    { type: TYPES.JSONB, default: [] },
 *       };
 *       static timestamps = true;
 *   }
 *
 *   db.register(Article);
 *   await db.sync();
 *
 *   await Article.create({ title: 'Hello', content: 'World', tags: ['intro'] });
 *   const recent = await Article.query().orderBy('createdAt', 'desc').limit(10).exec();
 */
const BaseSqlAdapter = require('./sql-base');
const { validateFKAction, validateCheck } = require('../schema');

class PostgresAdapter extends BaseSqlAdapter
{
    /**
     * @constructor
     * @param {object}  options - Configuration options.
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

        /** @private Prepared statement name cache for pg named queries */
        this._stmtCache = new Map();
        this._stmtCacheHits = 0;
        this._stmtCacheMisses = 0;
        this._stmtCacheMax = options.stmtCacheSize || 256;
    }

    /** @private */
    _typeMap(colDef)
    {
        const map = {
            string: `VARCHAR(${colDef.maxLength || 255})`, text: 'TEXT',
            integer: 'INTEGER', float: 'DOUBLE PRECISION', boolean: 'BOOLEAN',
            date: 'DATE', datetime: 'TIMESTAMPTZ', json: 'JSONB', blob: 'BYTEA',
            uuid: 'UUID',
            bigint: 'BIGINT', smallint: 'SMALLINT', tinyint: 'SMALLINT',
            decimal: `NUMERIC(${colDef.precision || 10},${colDef.scale || 2})`,
            serial: 'SERIAL', bigserial: 'BIGSERIAL',
            timestamp: 'TIMESTAMP', time: 'TIME', interval: 'INTERVAL',
            inet: 'INET', cidr: 'CIDR', macaddr: 'MACADDR',
            money: 'MONEY', real: 'REAL', double: 'DOUBLE PRECISION',
            jsonb: 'JSONB', xml: 'XML', citext: 'CITEXT',
            array: colDef.arrayOf ? `${colDef.arrayOf}[]` : 'TEXT[]',
            binary: 'BYTEA', varbinary: 'BYTEA',
            char: `CHAR(${colDef.length || 1})`,
            enum: colDef.enum
                ? `VARCHAR(255) CHECK ("${(colDef._name || 'col').replace(/"/g, '""')}" IN (${colDef.enum.map(v => `'${String(v).replace(/'/g, "''")}'`).join(',')}))`
                : 'VARCHAR(255)',
        };
        return map[colDef.type] || 'TEXT';
    }

    /**
     * @private
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

    /** @private */
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

    /**
     * Create a table with the given schema.
     * @param {string} table - Table name.
     * @param {object} schema - Column definitions keyed by column name.
     * @returns {Promise<void>}
     */
    async createTable(table, schema, tableOptions = {})
    {
        const cols = [];
        const tableConstraints = [];
        const compositePKs = [];

        for (const [name, def] of Object.entries(schema))
        {
            // Pass column name for enum CHECK constraints
            const defWithName = { ...def, _name: name };

            // Collect composite PK candidates
            if (def.primaryKey && def.compositeKey)
            {
                compositePKs.push(name);
                let line = `"${name}" ${this._typeMap(defWithName)}`;
                if (def.required) line += ' NOT NULL';
                cols.push(line);
                continue;
            }

            let line = `"${name}" ${this._typeMap(defWithName)}`;
            if (def.primaryKey && def.autoIncrement)
            {
                line = `"${name}" SERIAL PRIMARY KEY`;
            }
            else
            {
                if (def.primaryKey) line += ' PRIMARY KEY';
                if (def.required && !def.primaryKey) line += ' NOT NULL';
                if (def.unique && !def.compositeUnique) line += ' UNIQUE';
                if (def.default !== undefined && typeof def.default !== 'function')
                    line += ` DEFAULT ${this._sqlDefault(def.default)}`;

                // CHECK constraint
                if (def.check) line += ` CHECK(${validateCheck(def.check)})`;

                if (def.references)
                {
                    line += ` REFERENCES "${def.references.table}"("${def.references.column || 'id'}")`;
                    if (def.references.onDelete) line += ` ON DELETE ${validateFKAction(def.references.onDelete)}`;
                    if (def.references.onUpdate) line += ` ON UPDATE ${validateFKAction(def.references.onUpdate)}`;
                }
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
        for (const [group, columns] of Object.entries(compositeUniques))
        {
            tableConstraints.push(`CONSTRAINT "uq_${table}_${group}" UNIQUE (${columns.map(c => `"${c}"`).join(', ')})`);
        }

        const allParts = [...cols, ...tableConstraints];
        let sql = `CREATE TABLE IF NOT EXISTS "${table}" (${allParts.join(', ')})`;
        if (tableOptions.tablespace)
        {
            const ts = String(tableOptions.tablespace);
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ts)) throw new Error(`Invalid tablespace name: ${ts}`);
            sql += ` TABLESPACE ${ts}`;
        }
        if (tableOptions.unlogged) sql = sql.replace('CREATE TABLE', 'CREATE UNLOGGED TABLE');
        await this._pool.query(sql);
        if (tableOptions.comment)
        {
            await this._pool.query(`COMMENT ON TABLE "${table}" IS $1`, [tableOptions.comment]);
        }

        // Create indexes defined in schema
        for (const [name, def] of Object.entries(schema))
        {
            if (def.index)
            {
                const idxName = typeof def.index === 'string' ? def.index : `idx_${table}_${name}`;
                await this._pool.query(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${table}" ("${name}")`);
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
            await this._pool.query(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${table}" (${columns.map(c => `"${c}"`).join(', ')})`);
        }
    }

    /**
     * Drop a table if it exists.
     * @param {string} table - Table name.
     * @returns {Promise<void>}
     */
    async dropTable(table)
    {
        await this._pool.query(`DROP TABLE IF EXISTS "${table}"`);
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
        const values = keys.map(k => this._toSqlValue(data[k]));
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`;
        const { rows } = await this._pool.query(sql, values);
        return rows[0] || { ...data };
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
        const values = [];
        let idx = 1;
        const rowPlaceholders = dataArray.map(data => {
            const ph = keys.map(() => `$${idx++}`).join(', ');
            for (const k of keys) values.push(this._toSqlValue(data[k]));
            return `(${ph})`;
        }).join(', ');
        const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES ${rowPlaceholders} RETURNING *`;
        const { rows } = await this._pool.query(sql, values);
        return rows;
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
        const keys = Object.keys(data);
        const values = keys.map(k => this._toSqlValue(data[k]));
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        values.push(pkVal);
        await this._pool.query(`UPDATE "${table}" SET ${sets} WHERE "${pk}" = $${values.length}`, values);
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
        const keys = Object.keys(data);
        const values = keys.map(k => this._toSqlValue(data[k]));
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const { clause, values: whereVals } = this._buildWherePg(conditions, keys.length + 1);
        values.push(...whereVals);
        const { rowCount } = await this._pool.query(`UPDATE "${table}" SET ${sets}${clause}`, values);
        return rowCount;
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
        await this._pool.query(`DELETE FROM "${table}" WHERE "${pk}" = $1`, [pkVal]);
    }

    /**
     * Delete rows matching the given conditions.
     * @param {string} table - Table name.
     * @param {object} conditions - Filter conditions.
     * @returns {Promise<number>} Number of deleted rows.
     */
    async deleteWhere(table, conditions)
    {
        const { clause, values } = this._buildWherePg(conditions);
        const { rowCount } = await this._pool.query(`DELETE FROM "${table}"${clause}`, values);
        return rowCount;
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
            const joinStr = this._buildJoins(joins, table);
            const { clause, values } = this._buildWhereFromChainPg(where);
            const { rows } = await this._pool.query(`SELECT COUNT(*) as count FROM "${table}"${joinStr}${clause}`, values);
            return parseInt(rows[0].count, 10);
        }

        const selectFields = fields && fields.length ? fields.map(f => `"${f}"`).join(', ') : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        const joinStr = this._buildJoins(joins, table);
        let sql = `SELECT ${distinctStr}${selectFields} FROM "${table}"${joinStr}`;
        const values = [];
        let paramIdx = 1;

        if (where && where.length)
        {
            const { clause, values: wv, nextIdx } = this._buildWhereFromChainPg(where, paramIdx);
            sql += clause;
            values.push(...wv);
            paramIdx = nextIdx;
        }

        sql += this._buildGroupBy(groupBy);

        if (having && having.length)
        {
            const { clause: hClause, nextIdx: hIdx } = this._buildHavingPg(having, values, paramIdx);
            sql += hClause;
            paramIdx = hIdx;
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
        let paramIdx = 1;

        let sql = `SELECT ${fn}("${aggregateField}") as result FROM "${table}"${joinStr}`;

        if (where && where.length)
        {
            const { clause, values: wv, nextIdx } = this._buildWhereFromChainPg(where, paramIdx);
            sql += clause;
            values.push(...wv);
            paramIdx = nextIdx;
        }

        sql += this._buildGroupBy(groupBy);

        if (having && having.length)
        {
            const { clause: hClause } = this._buildHavingPg(having, values, paramIdx);
            sql += hClause;
        }

        const { rows } = await this._pool.query(sql, values);
        return rows[0] ? rows[0].result : null;
    }

    /**
     * Get the query execution plan (EXPLAIN).
     * @param {object} descriptor - Query descriptor.
     * @param {object} [options] - Configuration options.
     * @param {boolean} [options.analyze]  - Include ANALYZE.
     * @param {boolean} [options.buffers]  - Include BUFFERS.
     * @param {string}  [options.format]   - Output format (TEXT, JSON, XML, YAML).
     * @returns {Promise<Array>} Array of execution plan rows.
     */
    async explain(descriptor, options = {})
    {
        const { table, fields, where, orderBy, limit, offset, distinct, joins, groupBy, having } = descriptor;

        const selectFields = fields && fields.length ? fields.map(f => `"${f}"`).join(', ') : '*';
        const distinctStr = distinct ? 'DISTINCT ' : '';
        const joinStr = this._buildJoins(joins, table);
        let sql = `SELECT ${distinctStr}${selectFields} FROM "${table}"${joinStr}`;
        const values = [];
        let paramIdx = 1;

        if (where && where.length)
        {
            const { clause, values: wv, nextIdx } = this._buildWhereFromChainPg(where, paramIdx);
            sql += clause;
            values.push(...wv);
            paramIdx = nextIdx;
        }

        sql += this._buildGroupBy(groupBy);

        if (having && having.length)
        {
            const { clause: hClause, nextIdx: hIdx } = this._buildHavingPg(having, values, paramIdx);
            sql += hClause;
            paramIdx = hIdx;
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

        const parts = ['EXPLAIN'];
        if (options.analyze) parts.push('ANALYZE');
        if (options.buffers) parts.push('BUFFERS');
        if (options.format)
        {
            const fmt = String(options.format).toUpperCase();
            const allowed = ['TEXT', 'JSON', 'XML', 'YAML'];
            if (allowed.includes(fmt)) parts.push(`FORMAT ${fmt}`);
        }

        const { rows } = await this._pool.query(`${parts.join(' ')} ${sql}`, values);
        return rows;
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
     * Pre-warm the connection pool by creating idle connections.
     * @param {number} [count=5] - Number of connections to warm up.
     * @returns {Promise<number>} Number of connections successfully warmed.
     */
    async warmup(count)
    {
        const n = Math.min(Math.max(1, Math.floor(Number(count) || 5)), this._pool.options.max || 10);
        const clients = [];
        for (let i = 0; i < n; i++)
        {
            try
            {
                const client = await this._pool.connect();
                clients.push(client);
            }
            catch (e) { break; }
        }
        for (const client of clients) client.release();
        return clients.length;
    }

    /**
     * Close the database connection.
     * @returns {Promise<void>}
     */
    async close() { await this._pool.end(); }
    /** @override */
    async raw(sql, ...params) { const { rows } = await this._pool.query(sql, params); return rows; }

    /** @override */
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
     * @returns {Promise<string[]>} Array of table names.
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
     * @param {string} table - Table name.
     * @param {string} [schema='public'] - Schema definition.
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
     * @returns {Promise<number>} Database size in bytes.
     */
    async databaseSize()
    {
        const { rows } = await this._pool.query('SELECT pg_database_size(current_database()) AS size');
        return Number(rows[0].size) || 0;
    }

    /**
     * Get the row count for a table (estimated for large tables, exact for small ones).
     * @param {string} table - Table name.
     * @returns {Promise<number>} Total relation size in bytes.
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
     * @returns {Promise<string>} Full server version string.
     */
    async version()
    {
        const { rows } = await this._pool.query('SELECT version() AS ver');
        return rows[0].ver;
    }

    /**
     * Ping the database to check connectivity.
     * @returns {Promise<boolean>} `true` if the server is reachable.
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
     * @param {string} sql - SQL query string.
     * @param {...*}   params - Bound parameter values.
     * @returns {Promise<{ rowCount: number }>}
     */
    async exec(sql, ...params)
    {
        const { rowCount } = await this._pool.query(sql, params);
        return { rowCount: rowCount || 0 };
    }

    // -- Table Info & Debug (Schema Introspection) -----------

    /**
     * Get detailed table status (rows, sizes, etc.) from pg_stat_user_tables.
     * @param {string} [table] - Table name. If omitted, returns all tables.
     * @returns {Promise<Array<{ name: string, rows: number, totalSize: number, dataSize: number, indexSize: number, sequentialScans: number, indexScans: number, liveTuples: number, deadTuples: number, lastVacuum: string, lastAutoVacuum: string, lastAnalyze: string }>>}
     */
    async tableStatus(table)
    {
        let sql = `SELECT
            s.relname AS name,
            pg_total_relation_size(s.relid) AS total_size,
            pg_relation_size(s.relid) AS data_size,
            pg_indexes_size(s.relid) AS index_size,
            s.n_live_tup AS live_tuples,
            s.n_dead_tup AS dead_tuples,
            s.seq_scan AS seq_scans,
            s.idx_scan AS idx_scans,
            s.last_vacuum, s.last_autovacuum,
            s.last_analyze, s.last_autoanalyze
            FROM pg_stat_user_tables s`;
        const params = [];
        if (table)
        {
            sql += ` WHERE s.relname = $1`;
            params.push(table);
        }
        sql += ' ORDER BY s.relname';
        const { rows } = await this._pool.query(sql, params);
        return rows.map(r => ({
            name: r.name,
            rows: Number(r.live_tuples) || 0,
            totalSize: Number(r.total_size) || 0,
            dataSize: Number(r.data_size) || 0,
            indexSize: Number(r.index_size) || 0,
            sequentialScans: Number(r.seq_scans) || 0,
            indexScans: Number(r.idx_scans) || 0,
            liveTuples: Number(r.live_tuples) || 0,
            deadTuples: Number(r.dead_tuples) || 0,
            lastVacuum: r.last_vacuum, lastAutoVacuum: r.last_autovacuum,
            lastAnalyze: r.last_analyze,
        }));
    }

    /**
     * Get table size in human-readable format.
     * @param {string} table - Table name.
     * @returns {Promise<{ rows: number, dataSize: string, indexSize: string, totalSize: string }>}
     */
    async tableSizeFormatted(table)
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
        return { rows: s.rows, dataSize: fmt(s.dataSize), indexSize: fmt(s.indexSize), totalSize: fmt(s.totalSize) };
    }

    /**
     * Get indexes for a table.
     * @param {string} table - Table name.
     * @returns {Promise<Array<{ name: string, columns: string, unique: boolean, type: string, size: number }>>}
     */
    async indexes(table)
    {
        const { rows } = await this._pool.query(
            `SELECT i.relname AS name, ix.indisunique AS unique, am.amname AS type,
                    pg_relation_size(i.oid) AS size,
                    array_to_string(array_agg(a.attname ORDER BY k.n), ', ') AS columns
             FROM pg_index ix
             JOIN pg_class t ON t.oid = ix.indrelid
             JOIN pg_class i ON i.oid = ix.indexrelid
             JOIN pg_am am ON am.oid = i.relam
             CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
             WHERE t.relname = $1
             GROUP BY i.relname, ix.indisunique, am.amname, i.oid`,
            [table]
        );
        return rows.map(r => ({
            name: r.name, columns: r.columns, unique: r.unique,
            type: r.type, size: Number(r.size) || 0,
        }));
    }

    /**
     * Get foreign keys for a table.
     * @param {string} table - Table name.
     * @returns {Promise<Array<{ constraintName: string, column: string, referencedTable: string, referencedColumn: string, onDelete: string, onUpdate: string }>>}
     */
    async foreignKeys(table)
    {
        const { rows } = await this._pool.query(
            `SELECT tc.constraint_name, kcu.column_name,
                    ccu.table_name AS referenced_table,
                    ccu.column_name AS referenced_column,
                    rc.delete_rule, rc.update_rule
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
             JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
             JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
            [table]
        );
        return rows.map(r => ({
            constraintName: r.constraint_name, column: r.column_name,
            referencedTable: r.referenced_table, referencedColumn: r.referenced_column,
            onDelete: r.delete_rule, onUpdate: r.update_rule,
        }));
    }

    /**
     * Get full database overview — all tables with size and row counts.
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
     * Get server settings/variables.
     * @param {string} [filter] - LIKE pattern to filter settings.
     * @returns {Promise<Object<string, string>>} Key-value map of server settings.
     */
    async variables(filter)
    {
        const sql = filter
            ? `SELECT name, setting FROM pg_settings WHERE name LIKE $1`
            : 'SELECT name, setting FROM pg_settings';
        const params = filter ? [filter] : [];
        const { rows } = await this._pool.query(sql, params);
        const out = {};
        for (const r of rows) out[r.name] = r.setting;
        return out;
    }

    /**
     * Get active backends (like MySQL SHOW PROCESSLIST).
     * @returns {Promise<Array<{ pid: number, user: string, database: string, state: string, query: string, duration: string }>>}
     */
    async processlist()
    {
        const { rows } = await this._pool.query(
            `SELECT pid, usename AS user, datname AS database, state, query,
                    now() - query_start AS duration
             FROM pg_stat_activity WHERE datname = current_database()`
        );
        return rows.map(r => ({
            pid: r.pid, user: r.user, database: r.database,
            state: r.state, query: r.query, duration: String(r.duration || ''),
        }));
    }

    /**
     * Get table constraints (PRIMARY KEY, UNIQUE, CHECK, FK).
     * @param {string} table - Table name.
     * @returns {Promise<Array<{ name: string, type: string, definition: string }>>}
     */
    async constraints(table)
    {
        const { rows } = await this._pool.query(
            `SELECT conname AS name, contype AS type,
                    pg_get_constraintdef(c.oid) AS definition
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             WHERE t.relname = $1`,
            [table]
        );
        const typeMap = { p: 'PRIMARY KEY', u: 'UNIQUE', c: 'CHECK', f: 'FOREIGN KEY', x: 'EXCLUSION' };
        return rows.map(r => ({
            name: r.name, type: typeMap[r.type] || r.type, definition: r.definition,
        }));
    }

    /**
     * Get table and column comments for schema documentation.
     * @param {string} table - Table name.
     * @returns {Promise<{ tableComment: string, columns: Array<{ name: string, comment: string }> }>}
     */
    async comments(table)
    {
        const { rows: tcRows } = await this._pool.query(
            `SELECT obj_description(c.oid) AS comment FROM pg_class c WHERE c.relname = $1`, [table]
        );
        const { rows: colRows } = await this._pool.query(
            `SELECT a.attname AS name, col_description(c.oid, a.attnum) AS comment
             FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
             WHERE c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`, [table]
        );
        return {
            tableComment: (tcRows[0] && tcRows[0].comment) || '',
            columns: colRows.map(r => ({ name: r.name, comment: r.comment || '' })),
        };
    }

    /**
     * Run a LISTEN/NOTIFY style query. Useful for subscribing to PG notifications.
     * @param {string} channel - Channel name.
     * @param {Function} callback - Receives { channel, payload }.
     * @returns {Promise<Function>} Unlisten function.
     */
    async listen(channel, callback)
    {
        const ch = String(channel);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ch)) throw new Error(`Invalid channel name: ${ch}`);
        const client = await this._pool.connect();
        await client.query(`LISTEN ${ch}`);
        client.on('notification', callback);
        return async () =>
        {
            await client.query(`UNLISTEN ${ch}`);
            client.removeListener('notification', callback);
            client.release();
        };
    }

    // -- Migration / DDL Methods ----------------------------

    /**
     * Add a column to an existing table.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @param {object} def - Column definition (type, required, default, etc.)
     * @returns {Promise<void>}
     */
    async addColumn(table, column, def)
    {
        const defWithName = { ...def, _name: column };
        let colDef = this._typeMap(defWithName);
        if (def.required) colDef += ' NOT NULL';
        if (def.unique) colDef += ' UNIQUE';
        if (def.default !== undefined && typeof def.default !== 'function')
            colDef += ` DEFAULT ${this._sqlDefault(def.default)}`;
        if (def.check) colDef += ` CHECK(${validateCheck(def.check)})`;
        if (def.references)
        {
            colDef += ` REFERENCES "${def.references.table}"("${def.references.column || 'id'}")`;
            if (def.references.onDelete) colDef += ` ON DELETE ${validateFKAction(def.references.onDelete)}`;
            if (def.references.onUpdate) colDef += ` ON UPDATE ${validateFKAction(def.references.onUpdate)}`;
        }
        await this._pool.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${colDef}`);
    }

    /**
     * Drop a column from a table.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @returns {Promise<void>}
     */
    async dropColumn(table, column)
    {
        await this._pool.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
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
        await this._pool.query(`ALTER TABLE "${table}" RENAME COLUMN "${oldName}" TO "${newName}"`);
    }

    /**
     * Rename a table.
     * @param {string} oldName - Current name.
     * @param {string} newName - New name.
     * @returns {Promise<void>}
     */
    async renameTable(oldName, newName)
    {
        await this._pool.query(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
    }

    /**
     * Create an index on a table.
     * @param {string} table - Table name.
     * @param {string|string[]} columns - Column name(s).
     * @param {{ name?: string, unique?: boolean }} [options={}]
     * @returns {Promise<void>}
     */
    async createIndex(table, columns, options = {})
    {
        const cols = Array.isArray(columns) ? columns : [columns];
        const name = options.name || `idx_${table}_${cols.join('_')}`;
        const unique = options.unique ? 'UNIQUE ' : '';
        await this._pool.query(`CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${table}" (${cols.map(c => `"${c}"`).join(', ')})`);
    }

    /**
     * Drop an index.
     * @param {string} name - Index name.
     * @returns {Promise<void>}
     */
    async dropIndex(_table, name)
    {
        await this._pool.query(`DROP INDEX IF EXISTS "${name}"`);
    }

    /**
     * Add a foreign key constraint.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @param {string} refTable - Referenced table name.
     * @param {string} refColumn - Referenced column name.
     * @param {{ onDelete?: string, onUpdate?: string, name?: string }} [options={}]
     * @returns {Promise<void>}
     */
    async addForeignKey(table, column, refTable, refColumn, options = {})
    {
        const name = options.name || `fk_${table}_${column}`;
        let sql = `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES "${refTable}"("${refColumn}")`;
        if (options.onDelete) sql += ` ON DELETE ${validateFKAction(options.onDelete)}`;
        if (options.onUpdate) sql += ` ON UPDATE ${validateFKAction(options.onUpdate)}`;
        await this._pool.query(sql);
    }

    /**
     * Drop a foreign key constraint.
     * @param {string} table - Table name.
     * @param {string} constraintName - Constraint name.
     * @returns {Promise<void>}
     */
    async dropForeignKey(table, constraintName)
    {
        await this._pool.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraintName}"`);
    }

    /**
     * Check if a table exists.
     * @param {string} table - Table name.
     * @returns {Promise<boolean>} `true` if the table exists.
     */
    async hasTable(table)
    {
        const { rows } = await this._pool.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
            [table]
        );
        return rows.length > 0;
    }

    /**
     * Check if a column exists on a table.
     * @param {string} table - Table name.
     * @param {string} column - Column name.
     * @returns {Promise<boolean>} `true` if the column exists.
     */
    async hasColumn(table, column)
    {
        const { rows } = await this._pool.query(
            `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table, column]
        );
        return rows.length > 0;
    }

    /**
     * Get detailed column info for a table (migration-friendly format).
     * @param {string} table - Table name.
     * @returns {Promise<Array<{ name: string, type: string, nullable: boolean, defaultValue: string|null, primaryKey: boolean }>>}
     */
    async describeTable(table)
    {
        const { rows } = await this._pool.query(
            `SELECT c.column_name AS name, c.data_type AS type,
                    c.is_nullable = 'YES' AS nullable, c.column_default AS default_value,
                    COALESCE(tc.constraint_type = 'PRIMARY KEY', false) AS pk
             FROM information_schema.columns c
             LEFT JOIN information_schema.key_column_usage kcu
                ON c.column_name = kcu.column_name AND c.table_name = kcu.table_name AND c.table_schema = kcu.table_schema
             LEFT JOIN information_schema.table_constraints tc
                ON kcu.constraint_name = tc.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
             WHERE c.table_schema = 'public' AND c.table_name = $1
             ORDER BY c.ordinal_position`,
            [table]
        );
        return rows.map(r => ({
            name: r.name,
            type: r.type,
            nullable: r.nullable,
            defaultValue: r.default_value,
            primaryKey: r.pk,
        }));
    }
}

module.exports = PostgresAdapter;
