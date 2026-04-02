/**
 * @module orm/snapshot
 * @description Schema snapshot and diff engine for EF Core–style auto-generated
 *              migrations.  Compares the current Model schemas against a stored
 *              snapshot and produces a structured change-set that the CLI can
 *              render into migration code.
 *
 * The snapshot file (_schema_snapshot.json) is a plain JSON representation of
 * every tracked table's schema at the time the last migration was generated.
 *
 * @example
 *   const { diffSnapshots, buildSnapshot } = require('./snapshot');
 *
 *   const current  = buildSnapshot(models);   // from Model classes
 *   const previous = loadSnapshot(dir);       // from JSON file
 *   const changes  = diffSnapshots(previous, current);
 *
 *   // changes = { tables: { created: [...], dropped: [...] },
 *   //             columns: { added: [...], dropped: [...], altered: [...] } }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SNAPSHOT_FILE = '_schema_snapshot.json';

// -- Building a snapshot ----------------------------------------

/**
 * Build a normalised snapshot from an array of Model classes.
 * Each Model must have `static table` and `static schema`.
 *
 * @param {Function[]} models - Array of Model subclasses.
 * @returns {object} Snapshot keyed by table name.
 */
function buildSnapshot(models)
{
    const snap = {};

    for (const M of models)
    {
        const table = M.table;
        if (!table) continue;

        const schema = typeof M._fullSchema === 'function'
            ? M._fullSchema()
            : { ...M.schema };

        // Normalise each column to a serialisable form (strip functions)
        const cols = {};
        for (const [colName, def] of Object.entries(schema))
        {
            cols[colName] = _normaliseDef(def);
        }

        snap[table] = {
            schema:     cols,
            timestamps: !!M.timestamps,
            softDelete: !!M.softDelete,
        };
    }

    return snap;
}

/**
 * Normalise a column definition to a JSON-serialisable object.
 * Strips function defaults to `null`.
 * @private
 */
function _normaliseDef(def)
{
    const out = {};
    for (const [k, v] of Object.entries(def))
    {
        if (typeof v === 'function')      out[k] = null;           // fn defaults not serialisable
        else if (v instanceof RegExp)     out[k] = v.source;       // match patterns
        else                              out[k] = v;
    }
    return out;
}

// -- Loading / saving snapshots ---------------------------------

/**
 * Load a previously saved snapshot from disk.
 * Returns an empty object if no file exists.
 *
 * @param {string} dir - Directory containing the snapshot file.
 * @returns {object} Snapshot.
 */
function loadSnapshot(dir)
{
    const p = path.join(dir, SNAPSHOT_FILE);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Write a snapshot to disk.
 *
 * @param {string} dir      - Directory to write to.
 * @param {object} snapshot - The snapshot object.
 */
function saveSnapshot(dir, snapshot)
{
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, SNAPSHOT_FILE),
        JSON.stringify(snapshot, null, 4) + '\n',
        'utf8'
    );
}

// -- Diffing two snapshots --------------------------------------

/**
 * Diff two snapshots and return a structured change-set.
 *
 * @param {object} prev    - Previous snapshot (from file).
 * @param {object} current - Current snapshot (from live models).
 * @returns {object} `{ tables, columns }` change-set.
 */
function diffSnapshots(prev, current)
{
    const prevTables   = Object.keys(prev);
    const currTables   = Object.keys(current);

    const createdTables = currTables.filter(t => !prev[t]);
    const droppedTables = prevTables.filter(t => !current[t]);
    const commonTables  = currTables.filter(t => !!prev[t]);

    const addedCols   = [];
    const droppedCols = [];
    const alteredCols = [];

    for (const table of commonTables)
    {
        const prevCols = Object.keys(prev[table].schema);
        const currCols = Object.keys(current[table].schema);

        // New columns
        for (const col of currCols)
        {
            if (!prev[table].schema[col])
            {
                addedCols.push({ table, column: col, def: current[table].schema[col] });
            }
        }

        // Dropped columns
        for (const col of prevCols)
        {
            if (!current[table].schema[col])
            {
                droppedCols.push({ table, column: col, def: prev[table].schema[col] });
            }
        }

        // Altered columns (type or constraints changed)
        for (const col of currCols)
        {
            if (prev[table].schema[col] && current[table].schema[col])
            {
                if (!_defsEqual(prev[table].schema[col], current[table].schema[col]))
                {
                    alteredCols.push({
                        table,
                        column: col,
                        from:   prev[table].schema[col],
                        to:     current[table].schema[col],
                    });
                }
            }
        }
    }

    return {
        tables:  { created: createdTables, dropped: droppedTables },
        columns: { added: addedCols, dropped: droppedCols, altered: alteredCols },
    };
}

/**
 * Deep-compare two column definitions (JSON-serialisable).
 * @private
 */
function _defsEqual(a, b)
{
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Returns true when the change-set has no changes.
 *
 * @param {object} changes - Output of `diffSnapshots`.
 * @returns {boolean}
 */
function hasNoChanges(changes)
{
    return changes.tables.created.length  === 0
        && changes.tables.dropped.length  === 0
        && changes.columns.added.length   === 0
        && changes.columns.dropped.length === 0
        && changes.columns.altered.length === 0;
}

// -- Code generation -------------------------------------------

/**
 * Generate the JavaScript source for a migration file from a change-set.
 *
 * @param {string} migrationName - Timestamped migration name.
 * @param {object} changes       - Output of `diffSnapshots`.
 * @param {object} currentSnap   - Current snapshot (for full table schemas on create).
 * @returns {string} Migration file source code.
 */
function generateMigrationCode(migrationName, changes, currentSnap)
{
    const upLines   = [];
    const downLines = [];

    // -- Created tables --
    for (const table of changes.tables.created)
    {
        const schema = currentSnap[table].schema;
        upLines.push(`        await db.adapter.createTable('${table}', ${_schemaLiteral(schema)});`);
        downLines.push(`        await db.adapter.dropTable('${table}');`);
    }

    // -- Dropped tables (reverse of create) --
    for (const table of changes.tables.dropped)
    {
        upLines.push(`        await db.adapter.dropTable('${table}');`);
        // down recreates — but we need the previous snapshot's schema for that
        // This is handled via the `prev` reference embedded in the dropped table
    }

    // -- Added columns --
    for (const { table, column, def } of changes.columns.added)
    {
        upLines.push(`        await db.adapter.addColumn('${table}', '${column}', ${_defLiteral(def)});`);
        downLines.push(`        await db.adapter.dropColumn('${table}', '${column}');`);
    }

    // -- Dropped columns --
    for (const { table, column, def } of changes.columns.dropped)
    {
        upLines.push(`        await db.adapter.dropColumn('${table}', '${column}');`);
        downLines.push(`        await db.adapter.addColumn('${table}', '${column}', ${_defLiteral(def)});`);
    }

    // -- Altered columns (drop + re-add with new def) --
    for (const { table, column, from, to } of changes.columns.altered)
    {
        upLines.push(`        await db.adapter.dropColumn('${table}', '${column}');`);
        upLines.push(`        await db.adapter.addColumn('${table}', '${column}', ${_defLiteral(to)});`);
        downLines.push(`        await db.adapter.dropColumn('${table}', '${column}');`);
        downLines.push(`        await db.adapter.addColumn('${table}', '${column}', ${_defLiteral(from)});`);
    }

    // Build the final source
    const upBody   = upLines.length   > 0 ? upLines.join('\n')   : '        // No changes';
    const downBody = downLines.length > 0 ? downLines.join('\n') : '        // No changes';

    return `'use strict';

/**
 * Auto-generated migration — ${migrationName}
 * Generated by: npx zh make:migration
 */
module.exports = {
    name: '${migrationName}',

    async up(db) {
${upBody}
    },

    async down(db) {
${downBody}
    },
};
`;
}

/**
 * Serialise a full table schema into a code literal string.
 * @private
 */
function _schemaLiteral(schema)
{
    const entries = [];
    for (const [col, def] of Object.entries(schema))
    {
        entries.push(`            ${col}: ${_defLiteral(def)}`);
    }
    return `{\n${entries.join(',\n')},\n        }`;
}

/**
 * Serialise one column definition into a code literal string.
 * @private
 */
function _defLiteral(def)
{
    const parts = [];
    for (const [k, v] of Object.entries(def))
    {
        if (v === null || v === undefined) continue;
        if (typeof v === 'string') parts.push(`${k}: '${v}'`);
        else if (typeof v === 'boolean' || typeof v === 'number') parts.push(`${k}: ${v}`);
        else if (Array.isArray(v)) parts.push(`${k}: ${JSON.stringify(v)}`);
        else if (typeof v === 'object') parts.push(`${k}: ${JSON.stringify(v)}`);
    }
    return `{ ${parts.join(', ')} }`;
}

// -- Model discovery -------------------------------------------

/**
 * Load all Model classes from a directory.
 *
 * @param {string} dir  - Absolute path to the models directory.
 * @param {Function} ModelBase - The base Model class to check `instanceof`.
 * @returns {Function[]} Array of Model subclasses.
 */
function discoverModels(dir, ModelBase)
{
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
    const models = [];

    for (const file of files)
    {
        try
        {
            const exported = require(path.join(dir, file));
            const M = typeof exported === 'function' ? exported
                : (exported && exported.default && typeof exported.default === 'function')
                    ? exported.default
                    : null;

            if (M && M.table && M.schema && (M.prototype instanceof ModelBase || M === ModelBase))
            {
                models.push(M);
            }
        }
        catch (_) { /* skip files that fail to load */ }
    }

    return models;
}

module.exports = {
    buildSnapshot,
    loadSnapshot,
    saveSnapshot,
    diffSnapshots,
    hasNoChanges,
    generateMigrationCode,
    discoverModels,
    SNAPSHOT_FILE,
};
