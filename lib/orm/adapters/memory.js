/**
 * @module orm/adapters/memory
 * @description In-memory database adapter.
 *              Zero-dependency, perfect for testing, prototyping, and
 *              applications that don't need persistence beyond the process lifecycle.
 *
 *              All data is stored in plain JavaScript Maps and arrays.
 *              Supports full CRUD, filtering, ordering, pagination, and counting.
 */

/**
 * ReDoS-safe SQL LIKE matcher using iterative DP.
 * % = any sequence of chars, _ = any single char. Case-insensitive.
 * @private
 */
function _likeSafe(str, pattern)
{
    const s = str.toLowerCase();
    const p = pattern.toLowerCase();
    const sLen = s.length, pLen = p.length;
    let dp = new Array(pLen + 1).fill(false);
    dp[0] = true;
    for (let j = 0; j < pLen; j++) { if (p[j] === '%') dp[j + 1] = dp[j]; }
    for (let i = 1; i <= sLen; i++)
    {
        const next = new Array(pLen + 1).fill(false);
        for (let j = 1; j <= pLen; j++)
        {
            if (p[j - 1] === '%')       next[j] = dp[j] || next[j - 1];
            else if (p[j - 1] === '_')  next[j] = dp[j - 1];
            else                        next[j] = dp[j - 1] && s[i - 1] === p[j - 1];
        }
        dp = next;
    }
    return dp[pLen];
}

class MemoryAdapter
{
    constructor()
    {
        /** @private */ this._tables = new Map();
        /** @private */ this._autoIncrements = new Map();
        /** @private */ this._schemas = new Map();
        /** @private */ this._indexes = new Map();
    }

    /**
     * Create a table (register schema).
     * @param {string} table   - Table name.
     * @param {object} schema  - Column definitions.
     */
    async createTable(table, schema)
    {
        if (!this._tables.has(table))
        {
            this._tables.set(table, []);
            this._autoIncrements.set(table, 1);
        }
        if (schema) this._schemas.set(table, schema);
    }

    /**
     * Drop a table.
     * @param {string} table
     */
    async dropTable(table)
    {
        this._tables.delete(table);
        this._autoIncrements.delete(table);
    }

    /**
     * Insert a row.
     * @param {string} table - Table name.
     * @param {object} data  - Row data.
     * @returns {Promise<object>} Inserted row (with auto-increment ID if applicable).
     */
    async insert(table, data)
    {
        const rows = this._getTable(table);
        const row = { ...data };

        // Auto-increment: find any key not provided
        if (row.id === undefined || row.id === null)
        {
            row.id = this._autoIncrements.get(table) || 1;
            this._autoIncrements.set(table, row.id + 1);
        }

        // Serialize Date objects
        for (const [k, v] of Object.entries(row))
        {
            if (v instanceof Date) row[k] = v.toISOString();
        }

        // Enforce unique constraints from schema
        this._enforceUnique(table, row);

        rows.push(row);
        return row;
    }

    /**
     * Insert multiple rows at once.
     * @param {string}   table     - Table name.
     * @param {object[]} dataArray - Array of row data.
     * @returns {Promise<object[]>}
     */
    async insertMany(table, dataArray)
    {
        const results = [];
        for (const data of dataArray) results.push(await this.insert(table, data));
        return results;
    }

    /**
     * Update a row by primary key.
     * @param {string} table  - Table name.
     * @param {string} pk     - Primary key column name.
     * @param {*}      pkVal  - Primary key value.
     * @param {object} data   - Fields to update.
     */
    async update(table, pk, pkVal, data)
    {
        const rows = this._getTable(table);
        const row = rows.find(r => r[pk] === pkVal);
        if (row)
        {
            for (const [k, v] of Object.entries(data))
            {
                row[k] = v instanceof Date ? v.toISOString() : v;
            }
        }
    }

    /**
     * Update all rows matching conditions.
     * @param {string} table      - Table name.
     * @param {object} conditions - WHERE conditions.
     * @param {object} data       - Fields to update.
     * @returns {Promise<number>} Number of updated rows.
     */
    async updateWhere(table, conditions, data)
    {
        const rows = this._getTable(table);
        let count = 0;
        for (const row of rows)
        {
            if (this._matchConditions(row, conditions))
            {
                for (const [k, v] of Object.entries(data))
                {
                    row[k] = v instanceof Date ? v.toISOString() : v;
                }
                count++;
            }
        }
        return count;
    }

    /**
     * Remove a row by primary key.
     * @param {string} table
     * @param {string} pk
     * @param {*}      pkVal
     */
    async remove(table, pk, pkVal)
    {
        const rows = this._getTable(table);
        const idx = rows.findIndex(r => r[pk] === pkVal);
        if (idx !== -1) rows.splice(idx, 1);
    }

    /**
     * Delete all rows matching conditions.
     * @param {string} table
     * @param {object} conditions
     * @returns {Promise<number>}
     */
    async deleteWhere(table, conditions)
    {
        const rows = this._getTable(table);
        let count = 0;
        for (let i = rows.length - 1; i >= 0; i--)
        {
            if (this._matchConditions(rows[i], conditions))
            {
                rows.splice(i, 1);
                count++;
            }
        }
        return count;
    }

    /**
     * Execute a query descriptor (from the Query builder).
     * @param {object} descriptor - Abstract query descriptor.
     * @returns {Promise<Array|number>}
     */
    async execute(descriptor)
    {
        const { action, table, fields, where, orderBy, limit, offset, distinct, includeDeleted, groupBy, having } = descriptor;
        let rows = [...this._getTable(table)];

        // Apply WHERE filters
        if (where && where.length > 0)
        {
            rows = rows.filter(row => this._applyWhereChain(row, where));
        }

        // Count action
        if (action === 'count') return rows.length;

        // GROUP BY
        if (groupBy && groupBy.length > 0)
        {
            const groups = new Map();
            for (const row of rows)
            {
                const key = groupBy.map(f => row[f]).join('\0');
                if (!groups.has(key)) groups.set(key, { _key: {}, _rows: [] });
                const g = groups.get(key);
                for (const f of groupBy) g._key[f] = row[f];
                g._rows.push(row);
            }
            // Produce one row per group with GROUP BY fields + any selected fields
            rows = [];
            for (const g of groups.values())
            {
                const row = { ...g._key };
                // Support aggregate expressions in select fields (COUNT(*), etc.) later
                row._groupRows = g._rows;
                rows.push(row);
            }

            // HAVING filter
            if (having && having.length > 0)
            {
                rows = rows.filter(row =>
                {
                    for (const h of having)
                    {
                        const field = h.field;
                        let actual;
                        // Handle COUNT(*) etc.
                        if (field === 'COUNT(*)' || field.startsWith('COUNT'))
                        {
                            actual = row._groupRows.length;
                        }
                        else
                        {
                            actual = row[field];
                        }
                        const comp = this._compareOp(actual, h.op, h.value);
                        if (!comp) return false;
                    }
                    return true;
                });
            }

            // Clean up internal _groupRows
            for (const row of rows) delete row._groupRows;
        }

        // ORDER BY
        if (orderBy && orderBy.length > 0)
        {
            rows.sort((a, b) =>
            {
                for (const { field, dir } of orderBy)
                {
                    const av = a[field], bv = b[field];
                    if (av < bv) return dir === 'ASC' ? -1 : 1;
                    if (av > bv) return dir === 'ASC' ? 1 : -1;
                }
                return 0;
            });
        }

        // OFFSET
        if (offset) rows = rows.slice(offset);

        // LIMIT
        if (limit) rows = rows.slice(0, limit);

        // SELECT specific fields
        if (fields && fields.length > 0)
        {
            rows = rows.map(row =>
            {
                const filtered = {};
                for (const f of fields) filtered[f] = row[f];
                return filtered;
            });
        }

        // DISTINCT
        if (distinct)
        {
            const seen = new Set();
            rows = rows.filter(row =>
            {
                const key = JSON.stringify(row);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        return rows;
    }

    /**
     * Compute an aggregate value in memory.
     * @param {object} descriptor
     * @returns {Promise<number|null>}
     */
    async aggregate(descriptor)
    {
        const { table, where, aggregateFn, aggregateField } = descriptor;
        let rows = [...this._getTable(table)];
        if (where && where.length > 0) rows = rows.filter(row => this._applyWhereChain(row, where));
        const fn = aggregateFn.toLowerCase();
        if (!rows.length) return (fn === 'count' || fn === 'avg' || fn === 'sum') ? 0 : null;
        switch (fn)
        {
            case 'sum':  return rows.reduce((acc, r) => acc + (Number(r[aggregateField]) || 0), 0);
            case 'avg':  return rows.reduce((acc, r) => acc + (Number(r[aggregateField]) || 0), 0) / rows.length;
            case 'min':  return rows.reduce((m, r) => (r[aggregateField] < m ? r[aggregateField] : m), rows[0][aggregateField]);
            case 'max':  return rows.reduce((m, r) => (r[aggregateField] > m ? r[aggregateField] : m), rows[0][aggregateField]);
            case 'count': return rows.length;
            default:     return null;
        }
    }

    /**
     * Clear all data (for testing).
     */
    async clear()
    {
        for (const key of this._tables.keys())
        {
            this._tables.set(key, []);
            this._autoIncrements.set(key, 1);
        }
    }

    // -- Internal Helpers -------------------------------

    /** @private Get or create table array. */
    _getTable(table)
    {
        if (!this._tables.has(table)) this._tables.set(table, []);
        return this._tables.get(table);
    }

    /** @private Match simple object conditions { key: value }. */
    _matchConditions(row, conditions)
    {
        if (!conditions || typeof conditions !== 'object') return true;
        for (const [k, v] of Object.entries(conditions))
        {
            if (row[k] !== v) return false;
        }
        return true;
    }

    /** @private Apply the where chain from query builder. */
    _applyWhereChain(row, where)
    {
        let result = true;
        for (let i = 0; i < where.length; i++)
        {
            const clause = where[i];
            // Skip raw SQL clauses — not supported in memory adapter
            if (clause.raw) continue;
            const matches = this._matchClause(row, clause);

            if (i === 0 || clause.logic === 'AND')
            {
                result = i === 0 ? matches : (result && matches);
            }
            else if (clause.logic === 'OR')
            {
                result = result || matches;
            }
        }
        return result;
    }

    /** @private Match a single WHERE clause. */
    _matchClause(row, clause)
    {
        const val = row[clause.field];
        const { op, value } = clause;

        switch (op)
        {
            case '=':               return val === value;
            case '!=':
            case '<>':              return val !== value;
            case '>':               return val > value;
            case '<':               return val < value;
            case '>=':              return val >= value;
            case '<=':              return val <= value;
            case 'LIKE':            return _likeSafe(String(val), String(value));
            case 'IN':              return Array.isArray(value) && value.includes(val);
            case 'NOT IN':          return Array.isArray(value) && !value.includes(val);
            case 'BETWEEN':         return Array.isArray(value) && val >= value[0] && val <= value[1];
            case 'NOT BETWEEN':     return Array.isArray(value) && (val < value[0] || val > value[1]);
            case 'IS NULL':         return val === null || val === undefined;
            case 'IS NOT NULL':     return val !== null && val !== undefined;
            default:                return val === value;
        }
    }

    /** @private Compare a value using an operator. */
    _compareOp(actual, op, value)
    {
        switch (op.toUpperCase())
        {
            case '=':  return actual === value;
            case '!=':
            case '<>': return actual !== value;
            case '>':  return actual > value;
            case '<':  return actual < value;
            case '>=': return actual >= value;
            case '<=': return actual <= value;
            default:   return actual === value;
        }
    }

    // -- Memory Adapter Utilities ------------------------

    /**
     * List all registered table names.
     * @returns {string[]}
     */
    tables()
    {
        return [...this._tables.keys()];
    }

    /**
     * Get the total number of rows across all tables.
     * @returns {number}
     */
    totalRows()
    {
        let total = 0;
        for (const rows of this._tables.values()) total += rows.length;
        return total;
    }

    /**
     * Get memory usage stats.
     * @returns {{ tables: number, totalRows: number, estimatedBytes: number }}
     */
    stats()
    {
        const tables = this._tables.size;
        let totalRows = 0;
        let estimatedBytes = 0;
        for (const rows of this._tables.values())
        {
            totalRows += rows.length;
            estimatedBytes += JSON.stringify(rows).length * 2; // rough UTF-16 estimate
        }
        return { tables, totalRows, estimatedBytes };
    }

    /**
     * Export all data as a plain object.
     * @returns {object} { tableName: rows[], ... }
     */
    toJSON()
    {
        const out = {};
        for (const [table, rows] of this._tables) out[table] = [...rows];
        return out;
    }

    /**
     * Import data from a plain object, merging with existing data.
     * @param {object} data - { tableName: rows[], ... }
     */
    fromJSON(data)
    {
        for (const [table, rows] of Object.entries(data))
        {
            if (!this._tables.has(table)) this._tables.set(table, []);
            const existing = this._tables.get(table);
            for (const row of rows) existing.push({ ...row });
            // Update auto-increment
            const maxId = rows.reduce((max, r) => Math.max(max, r.id || 0), 0);
            const currentAi = this._autoIncrements.get(table) || 1;
            if (maxId >= currentAi) this._autoIncrements.set(table, maxId + 1);
        }
    }

    /**
     * Clone the entire database state (deep copy).
     * @returns {MemoryAdapter}
     */
    clone()
    {
        const copy = new MemoryAdapter();
        copy.fromJSON(this.toJSON());
        for (const [t, s] of this._schemas) copy._schemas.set(t, { ...s });
        return copy;
    }

    // -- Unique constraint enforcement -------------------

    /** @private Enforce unique constraints defined in schema. */
    _enforceUnique(table, row, excludeRow)
    {
        const schema = this._schemas.get(table);
        if (!schema) return;
        const rows = this._getTable(table);

        for (const [col, def] of Object.entries(schema))
        {
            if (def.unique && row[col] !== undefined && row[col] !== null)
            {
                const duplicate = rows.find(r => r !== excludeRow && r[col] === row[col]);
                if (duplicate)
                {
                    throw new Error(`UNIQUE constraint failed: ${table}.${col}`);
                }
            }
        }

        // Composite unique constraints
        const groups = {};
        for (const [col, def] of Object.entries(schema))
        {
            if (def.compositeUnique)
            {
                const g = typeof def.compositeUnique === 'string' ? def.compositeUnique : 'default';
                if (!groups[g]) groups[g] = [];
                groups[g].push(col);
            }
        }
        for (const cols of Object.values(groups))
        {
            const duplicate = rows.find(r =>
                r !== excludeRow && cols.every(c => r[c] === row[c])
            );
            if (duplicate)
            {
                throw new Error(`UNIQUE constraint failed: ${table}.(${cols.join(', ')})`);
            }
        }
    }

    // -- Migration / DDL Methods -------------------------

    /**
     * Add a column to an existing table (sets default for existing rows).
     * @param {string} table
     * @param {string} column
     * @param {object} def - Column definition.
     * @returns {Promise<void>}
     */
    async addColumn(table, column, def)
    {
        const schema = this._schemas.get(table);
        if (schema) schema[column] = def;
        const defaultVal = def.default !== undefined ? (typeof def.default === 'function' ? def.default() : def.default) : null;
        const rows = this._getTable(table);
        for (const row of rows)
        {
            if (row[column] === undefined) row[column] = defaultVal;
        }
    }

    /**
     * Drop a column from a table.
     * @param {string} table
     * @param {string} column
     * @returns {Promise<void>}
     */
    async dropColumn(table, column)
    {
        const schema = this._schemas.get(table);
        if (schema) delete schema[column];
        const rows = this._getTable(table);
        for (const row of rows) delete row[column];
    }

    /**
     * Rename a column.
     * @param {string} table
     * @param {string} oldName
     * @param {string} newName
     * @returns {Promise<void>}
     */
    async renameColumn(table, oldName, newName)
    {
        const schema = this._schemas.get(table);
        if (schema && schema[oldName])
        {
            schema[newName] = schema[oldName];
            delete schema[oldName];
        }
        const rows = this._getTable(table);
        for (const row of rows)
        {
            if (oldName in row)
            {
                row[newName] = row[oldName];
                delete row[oldName];
            }
        }
    }

    /**
     * Rename a table.
     * @param {string} oldName
     * @param {string} newName
     * @returns {Promise<void>}
     */
    async renameTable(oldName, newName)
    {
        if (this._tables.has(oldName))
        {
            this._tables.set(newName, this._tables.get(oldName));
            this._tables.delete(oldName);
            this._autoIncrements.set(newName, this._autoIncrements.get(oldName) || 1);
            this._autoIncrements.delete(oldName);
            if (this._schemas.has(oldName))
            {
                this._schemas.set(newName, this._schemas.get(oldName));
                this._schemas.delete(oldName);
            }
        }
    }

    /**
     * Create an index (tracked in metadata, no-op for queries).
     * @param {string} table
     * @param {string|string[]} columns
     * @param {{ name?: string, unique?: boolean }} [options={}]
     * @returns {Promise<void>}
     */
    async createIndex(table, columns, options = {})
    {
        const cols = Array.isArray(columns) ? columns : [columns];
        const name = options.name || `idx_${table}_${cols.join('_')}`;
        if (!this._indexes.has(table)) this._indexes.set(table, []);
        this._indexes.get(table).push({ name, columns: cols, unique: !!options.unique });
    }

    /**
     * Drop an index.
     * @param {string} _table - Table name (unused — searches all tables).
     * @param {string} name   - Index name.
     * @returns {Promise<void>}
     */
    async dropIndex(_table, name)
    {
        for (const [table, indexes] of this._indexes)
        {
            const idx = indexes.findIndex(i => i.name === name);
            if (idx !== -1) { indexes.splice(idx, 1); return; }
        }
    }

    /**
     * Check if a table exists.
     * @param {string} table
     * @returns {Promise<boolean>}
     */
    async hasTable(table)
    {
        return this._tables.has(table);
    }

    /**
     * Check if a column exists on a table.
     * @param {string} table
     * @param {string} column
     * @returns {Promise<boolean>}
     */
    async hasColumn(table, column)
    {
        const schema = this._schemas.get(table);
        if (schema) return column in schema;
        const rows = this._getTable(table);
        return rows.length > 0 && column in rows[0];
    }

    /**
     * Get column info for a table.
     * @param {string} table
     * @returns {Promise<Array<{ name: string, type: string, nullable: boolean, defaultValue: *, primaryKey: boolean }>>}
     */
    async describeTable(table)
    {
        const schema = this._schemas.get(table);
        if (!schema) return [];
        return Object.entries(schema).map(([name, def]) => ({
            name,
            type: def.type || 'TEXT',
            nullable: !def.required,
            defaultValue: def.default !== undefined ? def.default : null,
            primaryKey: !!def.primaryKey,
        }));
    }

    /**
     * Get indexes for a table.
     * @param {string} table
     * @returns {Promise<Array<{ name: string, columns: string[], unique: boolean }>>}
     */
    async indexes(table)
    {
        return this._indexes.get(table) || [];
    }
}

module.exports = MemoryAdapter;
