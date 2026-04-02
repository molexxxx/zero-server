/**
 * @module orm/adapters/sql-base
 * @description Base class for SQL adapters. Provides shared query-building
 *              utilities, parameterised queries (SQL injection safe), and
 *              type mapping helpers.
 */

class BaseSqlAdapter
{
    /**
     * Build a WHERE clause from simple { key: value } conditions.
     * Uses parameterised queries to prevent SQL injection.
     *
     * @param {object} conditions - Filter conditions.
     * @returns {{ clause: string, values: Array }}
     * @protected
     */
    _buildWhere(conditions)
    {
        if (!conditions || Object.keys(conditions).length === 0)
        {
            return { clause: '', values: [] };
        }
        const parts = [];
        const values = [];
        for (const [k, v] of Object.entries(conditions))
        {
            if (v === null)
            {
                parts.push(`"${k}" IS NULL`);
            }
            else
            {
                parts.push(`"${k}" = ?`);
                values.push(this._toSqlValue(v));
            }
        }
        return { clause: ' WHERE ' + parts.join(' AND '), values };
    }

    /**
     * Build a WHERE clause from the Query builder's where chain.
     * Supports operators: =, !=, >, <, >=, <=, LIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL.
     *
     * @param {Array} where - Array of { field, op, value, logic } objects.
     * @returns {{ clause: string, values: Array }}
     * @protected
     */
    _buildWhereFromChain(where)
    {
        if (!where || where.length === 0) return { clause: '', values: [] };

        const parts = [];
        const values = [];

        for (let i = 0; i < where.length; i++)
        {
            const w = where[i];

            // Handle raw WHERE clauses (from whereRaw)
            if (w.raw)
            {
                const expr = w.raw;
                if (w.params) values.push(...w.params);
                if (i === 0) parts.push(expr);
                else parts.push(`${w.logic} ${expr}`);
                continue;
            }

            const { field, op, value, logic } = w;

            let expr;
            if (op === 'IS NULL')
            {
                expr = `"${field}" IS NULL`;
            }
            else if (op === 'IS NOT NULL')
            {
                expr = `"${field}" IS NOT NULL`;
            }
            else if (op === 'IN' || op === 'NOT IN')
            {
                if (!Array.isArray(value) || value.length === 0)
                {
                    expr = op === 'IN' ? '0' : '1'; // IN () → false, NOT IN () → true
                }
                else
                {
                    const placeholders = value.map(() => '?').join(', ');
                    expr = `"${field}" ${op} (${placeholders})`;
                    values.push(...value.map(v => this._toSqlValue(v)));
                }
            }
            else if (op === 'BETWEEN')
            {
                expr = `"${field}" BETWEEN ? AND ?`;
                values.push(this._toSqlValue(value[0]), this._toSqlValue(value[1]));
            }
            else
            {
                expr = `"${field}" ${op} ?`;
                values.push(this._toSqlValue(value));
            }

            if (i === 0) parts.push(expr);
            else parts.push(`${logic} ${expr}`);
        }

        return { clause: ' WHERE ' + parts.join(' '), values };
    }

    /**
     * Convert a JS value to a SQL-safe value.
     * @param {*} value - Value to set.
     * @returns {*} SQL-compatible representation of the input.
     * @protected
     */
    _toSqlValue(value)
    {
        if (value instanceof Date) return value.toISOString();
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'object' && value !== null) return JSON.stringify(value);
        return value;
    }

    /**
     * Format a default value for SQL DDL.
     * @param {*} val - Value to check.
     * @returns {string} SQL DEFAULT literal.
     * @protected
     */
    _sqlDefault(val)
    {
        if (val === null) return 'NULL';
        if (typeof val === 'number') return String(val);
        if (typeof val === 'boolean') return val ? '1' : '0';
        if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
        return 'NULL';
    }

    /**
     * Build JOIN clauses from the descriptor's joins array.
     * @param {Array} joins - Array of { type, table, localKey, foreignKey }.
     * @param {string} baseTable - The primary table name.
     * @param {Function} [q] - Quote function (default: double-quote).
     * @returns {string} SQL JOIN clause, or empty string if none.
     * @protected
     */
    _buildJoins(joins, baseTable, q)
    {
        if (!joins || joins.length === 0) return '';
        const quote = q || (name => `"${name}"`);
        return ' ' + joins.map(j =>
            `${j.type} JOIN ${quote(j.table)} ON ${quote(baseTable)}.${quote(j.localKey)} = ${quote(j.table)}.${quote(j.foreignKey)}`
        ).join(' ');
    }

    /**
     * Build GROUP BY clause.
     * @param {Array} groupBy - Array of column names.
     * @param {Function} [q] - Quote function.
     * @returns {string} SQL GROUP BY clause, or empty string if none.
     * @protected
     */
    _buildGroupBy(groupBy, q)
    {
        if (!groupBy || groupBy.length === 0) return '';
        const quote = q || (name => `"${name}"`);
        return ' GROUP BY ' + groupBy.map(f => quote(f)).join(', ');
    }

    /**
     * Build HAVING clause from having array.
     * Uses ? parameter placeholders.
     * @param {Array} having - Array of { field, op, value }.
     * @param {Array} values - Values array to push params into.
     * @param {Function} [q] - Quote function.
     * @returns {string} SQL HAVING clause, or empty string if none.
     * @protected
     */
    _buildHaving(having, values, q)
    {
        if (!having || having.length === 0) return '';
        const quote = q || (name => `"${name}"`);
        const parts = having.map(h => {
            values.push(this._toSqlValue(h.value));
            return `${quote(h.field)} ${h.op} ?`;
        });
        return ' HAVING ' + parts.join(' AND ');
    }

    /**
     * Build HAVING clause with PostgreSQL $N placeholders.
     * @param {Array} having - HAVING clause.
     * @param {Array} values - Array of values.
     * @param {number} startIdx - Current parameter index.
     * @returns {{ clause: string, nextIdx: number }}
     * @protected
     */
    _buildHavingPg(having, values, startIdx)
    {
        if (!having || having.length === 0) return { clause: '', nextIdx: startIdx };
        let idx = startIdx;
        const parts = having.map(h => {
            values.push(this._toSqlValue(h.value));
            return `"${h.field}" ${h.op} $${idx++}`;
        });
        return { clause: ' HAVING ' + parts.join(' AND '), nextIdx: idx };
    }
}

module.exports = BaseSqlAdapter;
