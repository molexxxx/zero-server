/**
 * @module orm/search
 * @description Full-text search integration for the ORM.
 *              Provides a unified API across PostgreSQL (tsvector/tsquery),
 *              MySQL (FULLTEXT), SQLite (FTS5), and in-memory (regex-based).
 *
 * @section Full-Text Search
 *
 * @example
 *   const { FullTextSearch } = require('@zero-server/sdk');
 *
 *   // Create a search index
 *   const search = new FullTextSearch(Article, {
 *       fields: ['title', 'body'],
 *       weights: { title: 'A', body: 'B' },
 *   });
 *
 *   // Create the index in the database
 *   await search.createIndex(db);
 *
 *   // Search
 *   const results = await search.search('javascript framework');
 *   const ranked = await search.search('node.js', { rank: true, limit: 10 });
 */

const log = require('../debug')('zero:orm:search');

// -- FullTextSearch class ---------------------------------

/**
 * Full-text search engine for ORM models.
 * Provides a unified search API that adapts to the underlying database engine.
 *
 * @param {typeof Model} ModelClass - Model class to search.
 * @param {object}       options    - Search configuration.
 * @param {string[]}     options.fields  - Column names to include in the search index.
 * @param {Object<string, string>} [options.weights] - Weight map for fields. PostgreSQL: 'A'–'D'. Others: numeric multiplier.
 * @param {string}       [options.language='english'] - Language for stemming/tokenisation.
 * @param {string}       [options.indexName]          - Custom index name.
 */
class FullTextSearch
{
    /**
     * @constructor
     * @param {typeof Model} ModelClass - Model class to search.
     * @param {object}       options    - Configuration options.
     * @param {string[]}     options.fields       - Column names to include in the search index.
     * @param {Object<string, string>} [options.weights] - Weight map for fields (e.g. `{ title: 'A', body: 'B' }`).
     * @param {string}       [options.language='english'] - Language for stemming.
     * @param {string}       [options.indexName]   - Custom index name.
     */
    constructor(ModelClass, options = {})
    {
        if (!ModelClass) throw new Error('FullTextSearch requires a Model class');
        if (!options.fields || !options.fields.length) throw new Error('FullTextSearch requires at least one field');

        /** @type {typeof Model} */
        this._model = ModelClass;

        /** @type {string[]} Fields to index. */
        this._fields = options.fields;

        /** @type {Object<string, string>} Field weight configuration. */
        this._weights = options.weights || {};

        /** @type {string} Language for stemming. */
        this._language = options.language || 'english';

        /** @type {string} Index name. */
        this._indexName = options.indexName || `fts_${ModelClass.table}_${this._fields.join('_')}`;

        /** @type {object|null} Database adapter. */
        this._adapter = null;

        /** @type {string|null} Detected adapter type. */
        this._adapterType = null;
    }

    /**
     * Create the full-text search index.
     * Adapts to the underlying database:
     * - PostgreSQL: creates a GIN index on tsvector columns
     * - MySQL: creates a FULLTEXT index
     * - SQLite: creates an FTS5 virtual table
     * - Memory/JSON: no-op (search operates with in-memory regex)
     *
     * @param {object} db - Database instance.
     * @returns {Promise<FullTextSearch>} `this` for chaining.
     *
     * @example
     *   await search.createIndex(db);
     */
    async createIndex(db)
    {
        this._adapter = db.adapter;
        this._adapterType = this._detectAdapterType();

        if (typeof this._adapter.createFullTextIndex === 'function')
        {
            await this._adapter.createFullTextIndex(this._model.table, this._fields, {
                name: this._indexName,
                weights: this._weights,
                language: this._language,
            });
        }

        log.debug('fts index %s created on %s', this._indexName, this._model.table);
        return this;
    }

    /**
     * Drop the full-text search index.
     *
     * @param {object} db - Database instance.
     * @returns {Promise<void>}
     */
    async dropIndex(db)
    {
        const adapter = db ? db.adapter : this._adapter;
        if (!adapter) throw new Error('No database adapter available');

        if (typeof adapter.dropFullTextIndex === 'function')
        {
            await adapter.dropFullTextIndex(this._model.table, this._indexName);
        }

        log.debug('fts index %s dropped', this._indexName);
    }

    /**
     * Perform a full-text search.
     *
     * @param {string} query           - Search query string.
     * @param {object} [options]       - Search options.
     * @param {boolean} [options.rank=false]  - Include relevance ranking in results.
     * @param {number}  [options.limit]       - Maximum number of results.
     * @param {number}  [options.offset]      - Offset for pagination.
     * @param {object}  [options.where]       - Additional WHERE conditions.
     * @param {string}  [options.orderBy]     - Custom order ('rank' for relevance, or a column name).
     * @returns {Promise<Array<object>>} Search results, optionally with `_rank` scores.
     *
     * @example
     *   // Simple search
     *   const results = await search.search('javascript');
     *
     *   // Ranked search with filters
     *   const results = await search.search('node.js framework', {
     *       rank: true,
     *       limit: 10,
     *       where: { published: true },
     *   });
     *   // results[0]._rank => 0.95 (relevance score)
     */
    async search(query, options = {})
    {
        if (!query || typeof query !== 'string') return [];

        const adapter = this._adapter || this._model._adapter;
        if (!adapter) throw new Error('Model is not registered with a database');

        // Use adapter native FTS if available
        if (typeof adapter.fullTextSearch === 'function')
        {
            return adapter.fullTextSearch(this._model.table, this._fields, query, {
                ...options,
                language: this._language,
                weights: this._weights,
                model: this._model,
            });
        }

        // Fallback: in-memory search
        return this._memorySearch(query, options);
    }

    /**
     * Search and return model instances instead of plain objects.
     *
     * @param {string} query       - Search query string.
     * @param {object} [options]   - Search options (same as search()).
     * @returns {Promise<Array<Model>>} Model instances matching the search query.
     *
     * @example
     *   const articles = await search.searchModels('javascript');
     *   articles[0].title // => 'Learning JavaScript'
     */
    async searchModels(query, options = {})
    {
        const rows = await this.search(query, options);
        return rows.map(row =>
        {
            const inst = this._model._fromRow(row);
            if (row._rank !== undefined) inst._rank = row._rank;
            return inst;
        });
    }

    /**
     * Count matching search results.
     *
     * @param {string} query - Search query string.
     * @param {object} [options] - Additional WHERE conditions in `options.where`.
     * @returns {Promise<number>} Number of matching records.
     */
    async count(query, options = {})
    {
        const results = await this.search(query, { ...options, rank: false });
        return results.length;
    }

    /**
     * Build search suggestions (autocomplete) from indexed fields.
     *
     * @param {string} prefix      - Partial search term.
     * @param {object} [options]   - Configuration options.
     * @param {number} [options.limit=10]    - Max suggestions.
     * @param {string} [options.field]       - Specific field to suggest from.
     * @returns {Promise<string[]>} Matching suggestions.
     *
     * @example
     *   const suggestions = await search.suggest('jav', { limit: 5 });
     *   // => ['JavaScript', 'Java', 'Javelin']
     */
    async suggest(prefix, options = {})
    {
        const { limit = 10, field } = options;
        if (!prefix || typeof prefix !== 'string') return [];

        const searchFields = field ? [field] : this._fields;
        const adapter = this._adapter || this._model._adapter;
        if (!adapter) throw new Error('Model is not registered with a database');

        // Use adapter-native suggest if available
        if (typeof adapter.fullTextSuggest === 'function')
        {
            return adapter.fullTextSuggest(this._model.table, searchFields, prefix, { limit });
        }

        // Fallback: in-memory suggestion
        const q = this._model.query();
        const results = await q.exec();
        const seen = new Set();
        const suggestions = [];
        const lowerPrefix = prefix.toLowerCase();

        for (const row of results)
        {
            for (const f of searchFields)
            {
                const val = row[f];
                if (!val) continue;
                const words = String(val).split(/\s+/);
                for (const word of words)
                {
                    const lower = word.toLowerCase();
                    if (lower.startsWith(lowerPrefix) && !seen.has(lower))
                    {
                        seen.add(lower);
                        suggestions.push(word);
                        if (suggestions.length >= limit) return suggestions;
                    }
                }
            }
        }

        return suggestions;
    }

    /**
     * In-memory full-text search using regex matching and scoring.
     * Used as fallback for memory/json adapters.
     * @param {string} query - Search query.
     * @param {object} options - Search options.
     * @returns {Promise<Array>} Matching rows with optional _rank.
     * @private
     */
    async _memorySearch(query, options = {})
    {
        const { rank = false, limit, offset = 0, where = {} } = options;

        // Tokenise query into words
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) return [];

        // Build regex for each token (escape special chars)
        const patterns = tokens.map(t =>
        {
            const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(escaped, 'i');
        });

        // Get all records, with optional WHERE conditions
        let q = this._model.query();
        if (Object.keys(where).length) q = q.where(where);
        const allRows = await q.exec();

        // Score each row
        const scored = [];
        for (const row of allRows)
        {
            let score = 0;
            let matched = false;

            for (const field of this._fields)
            {
                const val = row[field];
                if (!val) continue;
                const text = String(val).toLowerCase();
                const weight = this._getWeight(field);

                for (const pattern of patterns)
                {
                    const matches = text.match(new RegExp(pattern.source, 'gi'));
                    if (matches)
                    {
                        matched = true;
                        score += matches.length * weight;
                    }
                }
            }

            if (matched)
            {
                const data = row.toJSON ? row.toJSON() : { ...row };
                if (rank) data._rank = score;
                scored.push({ data, score });
            }
        }

        // Sort by score (descending)
        scored.sort((a, b) => b.score - a.score);

        // Apply pagination
        let results = scored.map(s => s.data);
        if (offset) results = results.slice(offset);
        if (limit) results = results.slice(0, limit);

        return results;
    }

    /**
     * Get numeric weight for a field.
     * @param {string} field - Field name.
     * @returns {number} Numeric weight multiplier.
     * @private
     */
    _getWeight(field)
    {
        const w = this._weights[field];
        if (!w) return 1;
        // PostgreSQL-style weights: A=4, B=3, C=2, D=1
        if (typeof w === 'string')
        {
            const map = { A: 4, B: 3, C: 2, D: 1 };
            return map[w.toUpperCase()] || 1;
        }
        return Number(w) || 1;
    }

    /**
     * Detect the adapter type from its constructor or methods.
     * @returns {string} Adapter type identifier.
     * @private
     */
    _detectAdapterType()
    {
        const adapter = this._adapter;
        if (!adapter) return 'memory';
        const name = adapter.constructor.name.toLowerCase();
        if (name.includes('postgres')) return 'postgres';
        if (name.includes('mysql')) return 'mysql';
        if (name.includes('sqlite')) return 'sqlite';
        if (name.includes('mongo')) return 'mongo';
        if (name.includes('redis')) return 'redis';
        if (name.includes('json')) return 'json';
        return 'memory';
    }
}

module.exports = { FullTextSearch };
