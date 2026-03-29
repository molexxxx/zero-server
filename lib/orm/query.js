/**
 * @module orm/query
 * @description Fluent query builder that produces adapter-agnostic query objects.
 *              Each method returns `this` for chaining.  Call `.exec()` or
 *              `await` the query to execute it against the adapter.
 *
 * @example
 *   const users = await User.query()
 *       .where('age', '>', 18)
 *       .where('role', 'admin')
 *       .orderBy('name', 'asc')
 *       .limit(10)
 *       .offset(20)
 *       .select('name', 'email');
 */

/**
 * Fluent query builder.
 * Builds an abstract query descriptor that adapters can translate to their
 * native query language (SQL, MongoDB filter, in-memory filter, etc.).
 */
const log = require('../debug')('zero:orm:query');

// -- Security whitelists ---------------------------------

const VALID_OPERATORS = new Set([
    '=', '!=', '<>', '>', '<', '>=', '<=',
    'LIKE', 'NOT LIKE', 'IN', 'NOT IN',
    'BETWEEN', 'NOT BETWEEN', 'IS NULL', 'IS NOT NULL',
]);

const VALID_DIRECTIONS = new Set(['ASC', 'DESC']);

class Query
{
    /**
     * @param {object} model   - The Model class to query.
     * @param {object} adapter - The database adapter instance.
     */
    constructor(model, adapter)
    {
        /** @private */ this._model = model;
        /** @private */ this._adapter = adapter;
        /** @private */ this._action = 'select';
        /** @private */ this._fields = null; // null = all
        /** @private */ this._where = [];
        /** @private */ this._orderBy = [];
        /** @private */ this._limitVal = null;
        /** @private */ this._offsetVal = null;
        /** @private */ this._data = null;
        /** @private */ this._joins = [];
        /** @private */ this._groupBy = [];
        /** @private */ this._having = [];
        /** @private */ this._distinct = false;
        /** @private */ this._includeDeleted = false;
        /** @private */ this._eagerLoad = [];
    }

    // -- Selection --------------------------------------

    /**
     * Select specific columns.
     *
     * @param {...string} fields - Column names to select.
     * @returns {Query} `this` for chaining.
     */
    select(...fields)
    {
        this._fields = fields.flat();
        return this;
    }

    /**
     * Select distinct rows.
     * @returns {Query} `this` for chaining.
     */
    distinct()
    {
        this._distinct = true;
        return this;
    }

    // -- Filtering --------------------------------------

    /**
     * Add a WHERE condition.
     *
     * Accepts multiple forms:
     * - `where('age', 18)` → `age = 18`
     * - `where('age', '>', 18)` → `age > 18`
     * - `where({ role: 'admin', active: true })` → `role = 'admin' AND active = true`
     *
     * @param {string|object} field    - Column name or condition object.
     * @param {string}        [op]     - Operator (=, !=, >, <, >=, <=, LIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL).
     * @param {*}             [value]  - Value to compare against.
     * @returns {Query} `this` for chaining.
     */
    where(field, op, value)
    {
        if (typeof field === 'object' && field !== null)
        {
            for (const [k, v] of Object.entries(field))
            {
                this._where.push({ field: k, op: '=', value: v, logic: 'AND' });
            }
            return this;
        }

        if (value === undefined) { value = op; op = '='; }
        const upper = op.toUpperCase();
        if (!VALID_OPERATORS.has(upper)) throw new Error(`Invalid query operator: ${op}`);
        this._where.push({ field, op: upper, value, logic: 'AND' });
        return this;
    }

    /**
     * Add an OR WHERE condition.
     *
     * @param {string} field - Column name.
     * @param {string} [op]  - Operator.
     * @param {*}      [value] - Value.
     * @returns {Query} `this` for chaining.
     */
    orWhere(field, op, value)
    {
        if (value === undefined) { value = op; op = '='; }
        const upper = op.toUpperCase();
        if (!VALID_OPERATORS.has(upper)) throw new Error(`Invalid query operator: ${op}`);
        this._where.push({ field, op: upper, value, logic: 'OR' });
        return this;
    }

    /**
     * WHERE column IS NULL.
     * @param {string} field
     * @returns {Query}
     */
    whereNull(field)
    {
        this._where.push({ field, op: 'IS NULL', value: null, logic: 'AND' });
        return this;
    }

    /**
     * WHERE column IS NOT NULL.
     * @param {string} field
     * @returns {Query}
     */
    whereNotNull(field)
    {
        this._where.push({ field, op: 'IS NOT NULL', value: null, logic: 'AND' });
        return this;
    }

    /**
     * WHERE column IN (...values).
     * @param {string} field
     * @param {Array}  values
     * @returns {Query}
     */
    whereIn(field, values)
    {
        this._where.push({ field, op: 'IN', value: values, logic: 'AND' });
        return this;
    }

    /**
     * WHERE column NOT IN (...values).
     * @param {string} field
     * @param {Array}  values
     * @returns {Query}
     */
    whereNotIn(field, values)
    {
        this._where.push({ field, op: 'NOT IN', value: values, logic: 'AND' });
        return this;
    }

    /**
     * WHERE column BETWEEN low AND high.
     * @param {string} field
     * @param {*}      low
     * @param {*}      high
     * @returns {Query}
     */
    whereBetween(field, low, high)
    {
        this._where.push({ field, op: 'BETWEEN', value: [low, high], logic: 'AND' });
        return this;
    }

    /**
     * WHERE column NOT BETWEEN low AND high.
     * @param {string} field
     * @param {*}      low
     * @param {*}      high
     * @returns {Query}
     */
    whereNotBetween(field, low, high)
    {
        this._where.push({ field, op: 'NOT BETWEEN', value: [low, high], logic: 'AND' });
        return this;
    }

    /**
     * WHERE column LIKE pattern.
     * @param {string} field
     * @param {string} pattern - SQL LIKE pattern (% and _ wildcards).
     * @returns {Query}
     */
    whereLike(field, pattern)
    {
        this._where.push({ field, op: 'LIKE', value: pattern, logic: 'AND' });
        return this;
    }

    // -- Ordering ---------------------------------------

    /**
     * ORDER BY a column.
     * @param {string} field       - Column name.
     * @param {string} [dir='asc'] - Direction: 'asc' or 'desc'.
     * @returns {Query}
     */
    orderBy(field, dir = 'asc')
    {
        const upper = dir.toUpperCase();
        if (!VALID_DIRECTIONS.has(upper)) throw new Error(`Invalid orderBy direction: ${dir}`);
        this._orderBy.push({ field, dir: upper });
        return this;
    }

    // -- Pagination -------------------------------------

    /**
     * LIMIT results.
     * @param {number} n
     * @returns {Query}
     */
    limit(n)
    {
        this._limitVal = n;
        return this;
    }

    /**
     * OFFSET results.
     * @param {number} n
     * @returns {Query}
     */
    offset(n)
    {
        this._offsetVal = n;
        return this;
    }

    /**
     * Convenience: page(pageNum, perPage).
     * @param {number} page    - 1-indexed page number.
     * @param {number} perPage - Items per page.
     * @returns {Query}
     */
    page(page, perPage = 20)
    {
        this._limitVal = perPage;
        this._offsetVal = (Math.max(1, page) - 1) * perPage;
        return this;
    }

    // -- Grouping ---------------------------------------

    /**
     * GROUP BY column(s).
     * @param {...string} fields
     * @returns {Query}
     */
    groupBy(...fields)
    {
        this._groupBy.push(...fields.flat());
        return this;
    }

    /**
     * HAVING (used with GROUP BY).
     * @param {string} field
     * @param {string} [op]
     * @param {*}      [value]
     * @returns {Query}
     */
    having(field, op, value)
    {
        if (value === undefined) { value = op; op = '='; }
        this._having.push({ field, op: op.toUpperCase(), value });
        return this;
    }

    // -- Joins ------------------------------------------

    /**
     * INNER JOIN.
     * @param {string} table    - Table to join.
     * @param {string} localKey - Local column.
     * @param {string} foreignKey - Foreign column.
     * @returns {Query}
     */
    join(table, localKey, foreignKey)
    {
        this._joins.push({ type: 'INNER', table, localKey, foreignKey });
        return this;
    }

    /**
     * LEFT JOIN.
     * @param {string} table
     * @param {string} localKey
     * @param {string} foreignKey
     * @returns {Query}
     */
    leftJoin(table, localKey, foreignKey)
    {
        this._joins.push({ type: 'LEFT', table, localKey, foreignKey });
        return this;
    }

    /**
     * RIGHT JOIN.
     * @param {string} table
     * @param {string} localKey
     * @param {string} foreignKey
     * @returns {Query}
     */
    rightJoin(table, localKey, foreignKey)
    {
        this._joins.push({ type: 'RIGHT', table, localKey, foreignKey });
        return this;
    }

    // -- Soft Delete ------------------------------------

    /**
     * Include soft-deleted records in results.
     * @returns {Query}
     */
    withDeleted()
    {
        this._includeDeleted = true;
        return this;
    }

    // -- Eager Loading ----------------------------------

    /**
     * Eager-load one or more relationships.
     * Batches related queries to avoid the N+1 problem.
     * Accepts either relation names or a relation name + a scope function to
     * constrain the sub-query.
     *
     * @param {...string|object} relations - Relation names or `{ RelationName: q => q.where(...) }`.
     * @returns {Query}
     *
     * @example
     *   // Load all posts with their comments and author:
     *   const posts = await Post.query().with('Comment', 'Author');
     *
     *   // Constrain the eager load:
     *   const posts = await Post.query().with({ Comment: q => q.where('approved', true).limit(5) });
     */
    with(...relations)
    {
        for (const rel of relations)
        {
            if (typeof rel === 'string')
            {
                this._eagerLoad.push({ name: rel, scope: null });
            }
            else if (typeof rel === 'object' && rel !== null)
            {
                for (const [name, scope] of Object.entries(rel))
                {
                    this._eagerLoad.push({ name, scope: typeof scope === 'function' ? scope : null });
                }
            }
        }
        return this;
    }

    /**
     * Alias for with() — mirrors Entity Framework include syntax.
     * @param {...string|object} relations
     * @returns {Query}
     */
    include(...relations)
    {
        return this.with(...relations);
    }

    /**
     * Apply a named scope from the model.
     * Allows chaining multiple scopes on a single query.
     *
     * @param {string} name   - Scope name.
     * @param {...*}   [args] - Additional arguments for the scope function.
     * @returns {Query}
     *
     * @example
     *   await User.query().scope('active').scope('olderThan', 21).limit(5);
     */
    scope(name, ...args)
    {
        const scopes = this._model.scopes;
        if (!scopes || typeof scopes[name] !== 'function')
        {
            throw new Error(`Unknown scope "${name}" on ${this._model.name}`);
        }
        scopes[name](this, ...args);
        return this;
    }

    // -- Execution --------------------------------------

    /**
     * Build the abstract query descriptor.
     * @returns {object} Adapter-agnostic query object.
     */
    build()
    {
        // If withDeleted() was called, remove soft-delete filters
        let where = this._where;
        if (this._includeDeleted)
        {
            where = where.filter(w => !(w.field === 'deletedAt' && w.op === 'IS NULL'));
        }

        return {
            action: this._action,
            table: this._model.table,
            fields: this._fields,
            where,
            orderBy: this._orderBy,
            limit: this._limitVal,
            offset: this._offsetVal,
            data: this._data,
            joins: this._joins,
            groupBy: this._groupBy,
            having: this._having,
            distinct: this._distinct,
            includeDeleted: this._includeDeleted,
            schema: this._model.schema,
        };
    }

    /**
     * Execute the query and return results.
     * @returns {Promise<Array<object>>}
     */
    async exec()
    {
        const descriptor = this.build();
        log.debug('%s %s', descriptor.action, descriptor.table);
        let rows;
        try { rows = await this._adapter.execute(descriptor); }
        catch (e) { log.error('%s %s failed: %s', descriptor.action, descriptor.table, e.message); throw e; }

        // Wrap results in model instances
        if (this._action === 'select')
        {
            const instances = rows.map(row => this._model._fromRow(row));

            // Batch eager-load relationships (avoids N+1)
            if (this._eagerLoad.length > 0 && instances.length > 0)
            {
                await this._loadEager(instances);
            }

            return instances;
        }
        return rows;
    }

    /**
     * Batch-load eager relationships for a set of instances.
     * Uses a single query per relationship instead of one per instance.
     * @param {Array} instances
     * @private
     */
    async _loadEager(instances)
    {
        const ctor = this._model;
        for (const { name, scope } of this._eagerLoad)
        {
            const rel = ctor._relations && ctor._relations[name];
            if (!rel) throw new Error(`Unknown relation "${name}" on ${ctor.name}`);

            switch (rel.type)
            {
                case 'hasMany':
                {
                    const keys = [...new Set(instances.map(i => i[rel.localKey]).filter(v => v != null))];
                    if (!keys.length) break;
                    let q = rel.model.query().whereIn(rel.foreignKey, keys);
                    if (scope) scope(q);
                    const related = await q.exec();
                    const grouped = new Map();
                    for (const r of related)
                    {
                        const fk = r[rel.foreignKey];
                        if (!grouped.has(fk)) grouped.set(fk, []);
                        grouped.get(fk).push(r);
                    }
                    for (const inst of instances)
                        inst[name] = grouped.get(inst[rel.localKey]) || [];
                    break;
                }
                case 'hasOne':
                {
                    const keys = [...new Set(instances.map(i => i[rel.localKey]).filter(v => v != null))];
                    if (!keys.length) break;
                    let q = rel.model.query().whereIn(rel.foreignKey, keys);
                    if (scope) scope(q);
                    const related = await q.exec();
                    const byFk = new Map();
                    for (const r of related) byFk.set(r[rel.foreignKey], r);
                    for (const inst of instances)
                        inst[name] = byFk.get(inst[rel.localKey]) || null;
                    break;
                }
                case 'belongsTo':
                {
                    const keys = [...new Set(instances.map(i => i[rel.foreignKey]).filter(v => v != null))];
                    if (!keys.length) break;
                    let q = rel.model.query().whereIn(rel.localKey, keys);
                    if (scope) scope(q);
                    const related = await q.exec();
                    const byPk = new Map();
                    for (const r of related) byPk.set(r[rel.localKey], r);
                    for (const inst of instances)
                        inst[name] = byPk.get(inst[rel.foreignKey]) || null;
                    break;
                }
                case 'belongsToMany':
                {
                    const keys = [...new Set(instances.map(i => i[rel.localKey]).filter(v => v != null))];
                    if (!keys.length) break;
                    // Batch query junction table
                    const junctionRows = await ctor._adapter.execute({
                        action: 'select', table: rel.through,
                        fields: [rel.foreignKey, rel.otherKey],
                        where: [{ field: rel.foreignKey, op: 'IN', value: keys, logic: 'AND' }],
                        orderBy: [], joins: [], groupBy: [], having: [],
                        limit: null, offset: null, distinct: false,
                    });
                    const relatedIds = [...new Set(junctionRows.map(r => r[rel.otherKey]))];
                    if (!relatedIds.length) { for (const inst of instances) inst[name] = []; break; }
                    let q = rel.model.query().whereIn(rel.relatedKey, relatedIds);
                    if (scope) scope(q);
                    const related = await q.exec();
                    const byPk = new Map();
                    for (const r of related) byPk.set(r[rel.relatedKey], r);
                    // Group by parent
                    const jMap = new Map();
                    for (const jr of junctionRows)
                    {
                        const fk = jr[rel.foreignKey];
                        if (!jMap.has(fk)) jMap.set(fk, []);
                        const r = byPk.get(jr[rel.otherKey]);
                        if (r) jMap.get(fk).push(r);
                    }
                    for (const inst of instances)
                        inst[name] = jMap.get(inst[rel.localKey]) || [];
                    break;
                }
            }
        }
    }

    /**
     * Execute and return the first result.
     * @returns {Promise<object|null>}
     */
    async first()
    {
        this._limitVal = 1;
        const results = await this.exec();
        return results[0] || null;
    }

    /**
     * Count matching records.
     * @returns {Promise<number>}
     */
    async count()
    {
        const descriptor = this.build();
        descriptor.action = 'count';
        try { return await this._adapter.execute(descriptor); }
        catch (e) { log.error('count %s failed: %s', descriptor.table, e.message); throw e; }
    }

    /**
     * Check whether any matching records exist.
     * @returns {Promise<boolean>}
     */
    async exists()
    {
        const c = await this.count();
        return c > 0;
    }

    /**
     * Get an array of values for a single column.
     *
     * @param {string} field - Column name to extract.
     * @returns {Promise<Array<*>>}
     *
     * @example
     *   const emails = await User.query().pluck('email');
     *   // => ['alice@a.com', 'bob@b.com']
     */
    async pluck(field)
    {
        this._fields = [field];
        const rows = await this.exec();
        return rows.map(r => r[field]);
    }

    /**
     * SUM of a numeric column.
     * @param {string} field - Column name.
     * @returns {Promise<number>}
     */
    async sum(field)
    {
        const descriptor = this.build();
        descriptor.action = 'aggregate';
        descriptor.aggregateFn = 'sum';
        descriptor.aggregateField = field;
        // Fallback for adapters without native aggregate
        if (typeof this._adapter.aggregate === 'function')
        {
            return this._adapter.aggregate(descriptor);
        }
        const rows = await this.exec();
        return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
    }

    /**
     * AVG of a numeric column.
     * @param {string} field - Column name.
     * @returns {Promise<number>}
     */
    async avg(field)
    {
        const descriptor = this.build();
        descriptor.action = 'aggregate';
        descriptor.aggregateFn = 'avg';
        descriptor.aggregateField = field;
        if (typeof this._adapter.aggregate === 'function')
        {
            return this._adapter.aggregate(descriptor);
        }
        const rows = await this.exec();
        if (!rows.length) return 0;
        return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0) / rows.length;
    }

    /**
     * MIN of a column.
     * @param {string} field - Column name.
     * @returns {Promise<*>}
     */
    async min(field)
    {
        const descriptor = this.build();
        descriptor.action = 'aggregate';
        descriptor.aggregateFn = 'min';
        descriptor.aggregateField = field;
        if (typeof this._adapter.aggregate === 'function')
        {
            return this._adapter.aggregate(descriptor);
        }
        const rows = await this.exec();
        if (!rows.length) return null;
        return rows.reduce((m, r) => (r[field] < m ? r[field] : m), rows[0][field]);
    }

    /**
     * MAX of a column.
     * @param {string} field - Column name.
     * @returns {Promise<*>}
     */
    async max(field)
    {
        const descriptor = this.build();
        descriptor.action = 'aggregate';
        descriptor.aggregateFn = 'max';
        descriptor.aggregateField = field;
        if (typeof this._adapter.aggregate === 'function')
        {
            return this._adapter.aggregate(descriptor);
        }
        const rows = await this.exec();
        if (!rows.length) return null;
        return rows.reduce((m, r) => (r[field] > m ? r[field] : m), rows[0][field]);
    }

    /**
     * Make Query thenable — allows `await query`.
     */
    then(resolve, reject)
    {
        return this.exec().then(resolve, reject);
    }

    catch(reject)
    {
        return this.exec().catch(reject);
    }

    // -- LINQ-Inspired Utilities ------------------------

    // -- Aliases --

    /**
     * Alias for limit (LINQ naming).
     * @param {number} n
     * @returns {Query}
     */
    take(n)
    {
        return this.limit(n);
    }

    /**
     * Alias for offset (LINQ naming).
     * @param {number} n
     * @returns {Query}
     */
    skip(n)
    {
        return this.offset(n);
    }

    /**
     * Alias for exec — explicitly convert to array.
     * @returns {Promise<Array>}
     */
    toArray()
    {
        return this.exec();
    }

    /**
     * Shorthand for orderBy(field, 'desc').
     * @param {string} field
     * @returns {Query}
     */
    orderByDesc(field)
    {
        return this.orderBy(field, 'desc');
    }

    /**
     * C# alias: OrderByDescending.
     * @param {string} field
     * @returns {Query}
     */
    orderByDescending(field)
    {
        return this.orderBy(field, 'desc');
    }

    /**
     * Alias for first() — C# FirstOrDefault returns null on empty.
     * @returns {Promise<object|null>}
     */
    firstOrDefault()
    {
        return this.first();
    }

    /**
     * Alias for avg() — C# naming.
     * @param {string} field
     * @returns {Promise<number>}
     */
    average(field)
    {
        return this.avg(field);
    }

    /**
     * Alias for reduce() — C# Aggregate naming.
     * @param {Function} fn
     * @param {*} seed
     * @returns {Promise<*>}
     */
    aggregate(fn, seed)
    {
        return this.reduce(fn, seed);
    }

    // -- Element Operators --

    /**
     * Execute and return the last result.
     * Reverses the first orderBy or defaults to primary key DESC.
     * @returns {Promise<object|null>}
     */
    async last()
    {
        if (this._orderBy.length)
        {
            const first = this._orderBy[0];
            first.dir = first.dir === 'ASC' ? 'DESC' : 'ASC';
        }
        else
        {
            const pk = this._model._primaryKey ? this._model._primaryKey() : 'id';
            this._orderBy.push({ field: pk, dir: 'DESC' });
        }
        this._limitVal = 1;
        const results = await this.exec();
        return results[0] || null;
    }

    /**
     * Alias for last() — C# naming.
     * @returns {Promise<object|null>}
     */
    lastOrDefault()
    {
        return this.last();
    }

    /**
     * Returns the only element. Throws if count !== 1.
     * @returns {Promise<object>}
     */
    async single()
    {
        this._limitVal = 2;
        const results = await this.exec();
        if (results.length === 0) throw new Error('Sequence contains no elements');
        if (results.length > 1) throw new Error('Sequence contains more than one element');
        return results[0];
    }

    /**
     * Returns the only element, or null if empty. Throws if more than one.
     * @returns {Promise<object|null>}
     */
    async singleOrDefault()
    {
        this._limitVal = 2;
        const results = await this.exec();
        if (results.length > 1) throw new Error('Sequence contains more than one element');
        return results[0] || null;
    }

    /**
     * Get element at a specific index.
     * @param {number} index - 0-based index.
     * @returns {Promise<object>}
     */
    async elementAt(index)
    {
        this._offsetVal = index;
        this._limitVal = 1;
        const results = await this.exec();
        if (results.length === 0) throw new Error('Index out of range');
        return results[0];
    }

    /**
     * Get element at index, or null if out of range.
     * @param {number} index - 0-based index.
     * @returns {Promise<object|null>}
     */
    async elementAtOrDefault(index)
    {
        this._offsetVal = index;
        this._limitVal = 1;
        const results = await this.exec();
        return results[0] || null;
    }

    /**
     * Returns results, or an array with defaultValue if empty.
     * @param {*} defaultValue
     * @returns {Promise<Array>}
     */
    async defaultIfEmpty(defaultValue)
    {
        const results = await this.exec();
        return results.length ? results : [defaultValue];
    }

    // -- Quantifiers --

    /**
     * Returns true if any elements match. With a predicate, filters post-execution.
     * Without a predicate, equivalent to exists().
     * @param {Function} [predicate]
     * @returns {Promise<boolean>}
     */
    async any(predicate)
    {
        if (!predicate) return this.exists();
        const results = await this.exec();
        return results.some(predicate);
    }

    /**
     * Returns true if all elements match the predicate.
     * @param {Function} predicate
     * @returns {Promise<boolean>}
     */
    async all(predicate)
    {
        const results = await this.exec();
        return results.length > 0 && results.every(predicate);
    }

    /**
     * Returns true if any record has the given value for a column.
     * @param {string} field
     * @param {*} value
     * @returns {Promise<boolean>}
     */
    async contains(field, value)
    {
        this._where.push({ field, op: '=', value, logic: 'AND' });
        return this.exists();
    }

    /**
     * Compares results of this query with another for equality.
     * @param {Query|Array} other - Another query or array.
     * @param {Function} [compareFn] - Custom equality function (a, b) => boolean.
     * @returns {Promise<boolean>}
     */
    async sequenceEqual(other, compareFn)
    {
        const a = await this.exec();
        const b = Array.isArray(other) ? other : await other.exec();
        if (a.length !== b.length) return false;
        const cmp = compareFn || ((x, y) => JSON.stringify(x) === JSON.stringify(y));
        for (let i = 0; i < a.length; i++)
        {
            if (!cmp(a[i], b[i])) return false;
        }
        return true;
    }

    // -- Ordering --

    /**
     * Add secondary sort ascending (use after orderBy).
     * @param {string} field
     * @returns {Query}
     */
    thenBy(field)
    {
        this._orderBy.push({ field, dir: 'ASC' });
        return this;
    }

    /**
     * Add secondary sort descending (use after orderBy).
     * @param {string} field
     * @returns {Query}
     */
    thenByDescending(field)
    {
        this._orderBy.push({ field, dir: 'DESC' });
        return this;
    }

    // -- Set Operations --

    /**
     * Append results from another query or array.
     * @param {Query|Array} other
     * @returns {Promise<Array>}
     */
    async concat(other)
    {
        const a = await this.exec();
        const b = Array.isArray(other) ? other : await other.exec();
        return a.concat(b);
    }

    /**
     * Distinct union of this query's results with another.
     * @param {Query|Array} other
     * @param {Function} [keyFn] - Key selector for equality (default: JSON.stringify).
     * @returns {Promise<Array>}
     */
    async union(other, keyFn)
    {
        const a = await this.exec();
        const b = Array.isArray(other) ? other : await other.exec();
        const key = keyFn || (item => JSON.stringify(item));
        const seen = new Set(a.map(key));
        const result = [...a];
        for (const item of b)
        {
            const k = key(item);
            if (!seen.has(k)) { seen.add(k); result.push(item); }
        }
        return result;
    }

    /**
     * Elements common to both this query and another.
     * @param {Query|Array} other
     * @param {Function} [keyFn] - Key selector for equality.
     * @returns {Promise<Array>}
     */
    async intersect(other, keyFn)
    {
        const a = await this.exec();
        const b = Array.isArray(other) ? other : await other.exec();
        const key = keyFn || (item => JSON.stringify(item));
        const bKeys = new Set(b.map(key));
        return a.filter(item => bKeys.has(key(item)));
    }

    /**
     * Elements in this query but not in other.
     * @param {Query|Array} other
     * @param {Function} [keyFn] - Key selector for equality.
     * @returns {Promise<Array>}
     */
    async except(other, keyFn)
    {
        const a = await this.exec();
        const b = Array.isArray(other) ? other : await other.exec();
        const key = keyFn || (item => JSON.stringify(item));
        const bKeys = new Set(b.map(key));
        return a.filter(item => !bKeys.has(key(item)));
    }

    // -- Projection --

    /**
     * FlatMap — project each element to an array and flatten.
     * @param {Function} fn - (item, index) => Array
     * @returns {Promise<Array>}
     */
    async selectMany(fn)
    {
        const results = await this.exec();
        return results.flatMap(fn);
    }

    /**
     * Combine two result sets element-wise.
     * @param {Query|Array} other
     * @param {Function} fn - (a, b) => result
     * @returns {Promise<Array>}
     */
    async zip(other, fn)
    {
        const a = await this.exec();
        const b = Array.isArray(other) ? other : await other.exec();
        const len = Math.min(a.length, b.length);
        const result = new Array(len);
        for (let i = 0; i < len; i++) result[i] = fn(a[i], b[i]);
        return result;
    }

    /**
     * Convert results to a Map keyed by a selector.
     * @param {Function} keyFn - (item) => key
     * @param {Function} [valueFn] - (item) => value. Defaults to the item itself.
     * @returns {Promise<Map>}
     */
    async toDictionary(keyFn, valueFn)
    {
        const results = await this.exec();
        const map = new Map();
        const val = valueFn || (item => item);
        for (const item of results)
        {
            const k = keyFn(item);
            if (map.has(k)) throw new Error(`Duplicate key: ${k}`);
            map.set(k, val(item));
        }
        return map;
    }

    /**
     * Group results into a Map of arrays keyed by a selector.
     * @param {Function} keyFn - (item) => groupKey
     * @returns {Promise<Map>}
     */
    async toLookup(keyFn)
    {
        const results = await this.exec();
        const map = new Map();
        for (const item of results)
        {
            const k = keyFn(item);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(item);
        }
        return map;
    }

    // -- Partitioning --

    /**
     * Take elements while predicate returns true (post-execution).
     * @param {Function} predicate - (item, index) => boolean
     * @returns {Promise<Array>}
     */
    async takeWhile(predicate)
    {
        const results = await this.exec();
        const out = [];
        for (let i = 0; i < results.length; i++)
        {
            if (!predicate(results[i], i)) break;
            out.push(results[i]);
        }
        return out;
    }

    /**
     * Skip elements while predicate returns true, then return the rest.
     * @param {Function} predicate - (item, index) => boolean
     * @returns {Promise<Array>}
     */
    async skipWhile(predicate)
    {
        const results = await this.exec();
        let i = 0;
        while (i < results.length && predicate(results[i], i)) i++;
        return results.slice(i);
    }

    // -- Post-Execution Transforms --

    /**
     * Reverse the result order.
     * @returns {Promise<Array>}
     */
    async reverse()
    {
        const results = await this.exec();
        return results.reverse();
    }

    /**
     * Append items to the end of results.
     * @param {...*} items
     * @returns {Promise<Array>}
     */
    async append(...items)
    {
        const results = await this.exec();
        return results.concat(items);
    }

    /**
     * Prepend items to the beginning of results.
     * @param {...*} items
     * @returns {Promise<Array>}
     */
    async prepend(...items)
    {
        const results = await this.exec();
        return [...items, ...results];
    }

    /**
     * Distinct by a key selector (post-execution).
     * @param {Function} keyFn - (item) => key
     * @returns {Promise<Array>}
     */
    async distinctBy(keyFn)
    {
        const results = await this.exec();
        const seen = new Set();
        const out = [];
        for (const item of results)
        {
            const k = keyFn(item);
            if (!seen.has(k)) { seen.add(k); out.push(item); }
        }
        return out;
    }

    // -- Aggregate with Selectors --

    /**
     * Element with the minimum value from a selector.
     * @param {Function} fn - (item) => number
     * @returns {Promise<object|null>}
     */
    async minBy(fn)
    {
        const results = await this.exec();
        if (!results.length) return null;
        let min = results[0], minVal = fn(results[0]);
        for (let i = 1; i < results.length; i++)
        {
            const v = fn(results[i]);
            if (v < minVal) { minVal = v; min = results[i]; }
        }
        return min;
    }

    /**
     * Element with the maximum value from a selector.
     * @param {Function} fn - (item) => number
     * @returns {Promise<object|null>}
     */
    async maxBy(fn)
    {
        const results = await this.exec();
        if (!results.length) return null;
        let max = results[0], maxVal = fn(results[0]);
        for (let i = 1; i < results.length; i++)
        {
            const v = fn(results[i]);
            if (v > maxVal) { maxVal = v; max = results[i]; }
        }
        return max;
    }

    /**
     * Sum using a value selector.
     * @param {Function} fn - (item) => number
     * @returns {Promise<number>}
     */
    async sumBy(fn)
    {
        const results = await this.exec();
        let total = 0;
        for (const item of results) total += fn(item);
        return total;
    }

    /**
     * Average using a value selector.
     * @param {Function} fn - (item) => number
     * @returns {Promise<number>}
     */
    async averageBy(fn)
    {
        const results = await this.exec();
        if (!results.length) return 0;
        let total = 0;
        for (const item of results) total += fn(item);
        return total / results.length;
    }

    /**
     * Count elements per group using a key selector.
     * @param {Function} keyFn - (item) => groupKey
     * @returns {Promise<Map>}
     */
    async countBy(keyFn)
    {
        const results = await this.exec();
        const map = new Map();
        for (const item of results)
        {
            const k = keyFn(item);
            map.set(k, (map.get(k) || 0) + 1);
        }
        return map;
    }

    // -- Conditional & Debugging --

    /**
     * Conditionally apply query logic.
     * If `condition` is truthy, calls `fn(query)`.
     * Perfect for optional filters.
     *
     * @param {*}        condition - Evaluated for truthiness.
     * @param {Function} fn       - Called with `this` when truthy.
     * @returns {Query}
     *
     * @example
     *   User.query()
     *       .when(req.query.role, (q) => q.where('role', req.query.role))
     *       .when(req.query.minAge, (q) => q.where('age', '>=', req.query.minAge))
     */
    when(condition, fn)
    {
        if (condition) fn(this);
        return this;
    }

    /**
     * Inverse of when — apply query logic when condition is falsy.
     *
     * @param {*}        condition
     * @param {Function} fn
     * @returns {Query}
     */
    unless(condition, fn)
    {
        if (!condition) fn(this);
        return this;
    }

    /**
     * Inspect the query without breaking the chain.
     * Calls `fn(this)` for side effects (logging, debugging).
     *
     * @param {Function} fn - Receives the query instance.
     * @returns {Query}
     *
     * @example
     *   User.query()
     *       .where('role', 'admin')
     *       .tap(q => console.log('Query:', q.build()))
     *       .limit(10)
     */
    tap(fn)
    {
        fn(this);
        return this;
    }

    /**
     * Process results in batches. Calls `fn(batch, batchIndex)` for each chunk.
     * Useful for processing large datasets without loading everything into memory.
     *
     * @param {number}   size - Number of records per batch.
     * @param {Function} fn   - Called with (batch: Model[], index: number).
     * @returns {Promise<void>}
     *
     * @example
     *   await User.query().where('active', true).chunk(100, async (users, i) => {
     *       console.log(`Processing batch ${i} (${users.length} users)`);
     *       for (const user of users) await user.update({ migrated: true });
     *   });
     */
    async chunk(size, fn)
    {
        let page = 0;
        while (true)
        {
            const saved = { limit: this._limitVal, offset: this._offsetVal };
            this._limitVal = size;
            this._offsetVal = page * size;
            const batch = await this.exec();
            this._limitVal = saved.limit;
            this._offsetVal = saved.offset;
            if (batch.length === 0) break;
            await fn(batch, page);
            if (batch.length < size) break;
            page++;
        }
    }

    /**
     * Execute and iterate each result with a callback.
     *
     * @param {Function} fn - Called with (item, index).
     * @returns {Promise<void>}
     */
    async each(fn)
    {
        const results = await this.exec();
        for (let i = 0; i < results.length; i++)
        {
            await fn(results[i], i);
        }
    }

    /**
     * Execute, transform results with a mapper, and return the mapped array.
     *
     * @param {Function} fn - Called with (item, index). Return the mapped value.
     * @returns {Promise<Array>}
     *
     * @example
     *   const names = await User.query().map(u => u.name);
     */
    async map(fn)
    {
        const results = await this.exec();
        return results.map(fn);
    }

    /**
     * Execute, filter results with a predicate, and return matches.
     *
     * @param {Function} fn - Called with (item, index). Return truthy to keep.
     * @returns {Promise<Array>}
     */
    async filter(fn)
    {
        const results = await this.exec();
        return results.filter(fn);
    }

    /**
     * Execute and reduce results to a single value.
     *
     * @param {Function} fn      - Reducer: (acc, item, index).
     * @param {*}        initial - Initial accumulator value.
     * @returns {Promise<*>}
     */
    async reduce(fn, initial)
    {
        const results = await this.exec();
        return results.reduce(fn, initial);
    }

    /**
     * Rich pagination with metadata.
     * Returns `{ data, total, page, perPage, pages, hasNext, hasPrev }`.
     *
     * @param {number} pg       - 1-indexed page number.
     * @param {number} [perPage=20] - Items per page.
     * @returns {Promise<object>}
     *
     * @example
     *   const result = await User.query()
     *       .where('active', true)
     *       .paginate(2, 10);
     *   // { data: [...], total: 53, page: 2, perPage: 10,
     *   //   pages: 6, hasNext: true, hasPrev: true }
     */
    async paginate(pg, perPage = 20)
    {
        pg = Math.max(1, pg);
        const total = await this.count();
        const pages = Math.ceil(total / perPage);
        this._limitVal = perPage;
        this._offsetVal = (pg - 1) * perPage;
        const data = await this.exec();
        return {
            data,
            total,
            page: pg,
            perPage,
            pages,
            hasNext: pg < pages,
            hasPrev: pg > 1,
        };
    }

    /**
     * Inject a raw WHERE clause for SQL adapters.
     * Ignored by non-SQL adapters (memory, json, mongo).
     *
     * @param {string} sql       - Raw SQL expression (e.g. 'age > ? AND role = ?').
     * @param {...*}   [params]  - Parameter values.
     * @returns {Query}
     *
     * @example
     *   User.query().whereRaw('LOWER(email) = ?', 'alice@example.com')
     */
    whereRaw(sql, ...params)
    {
        this._where.push({ raw: sql, params, logic: 'AND' });
        return this;
    }
}

module.exports = Query;
