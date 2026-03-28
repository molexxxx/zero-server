/**
 * @module orm/adapters/json
 * @description JSON file-backed database adapter.
 *              Persists data to JSON files on disk — one file per table.
 *              Zero-dependency, suitable for prototyping, small apps, and
 *              embedded scenarios. Uses atomic writes for safety.
 */
const fs = require('fs');
const path = require('path');
const MemoryAdapter = require('./memory');

class JsonAdapter extends MemoryAdapter
{
    /**
     * @param {object}  options
     * @param {string}  options.dir                 - Directory to store JSON files. Created if needed.
     * @param {boolean} [options.pretty=true]        - Pretty-print JSON files.
     * @param {number}  [options.flushInterval=50]   - Debounce interval in ms for writes.
     * @param {boolean} [options.autoFlush=true]     - Automatically flush writes (set false for manual flush()).
     */
    constructor(options = {})
    {
        super();
        if (!options.dir) throw new Error('JsonAdapter requires a "dir" option');

        /** @private */ this._dir = path.resolve(options.dir);
        /** @private */ this._pretty = options.pretty !== false;
        /** @private */ this._dirty = new Set();
        /** @private */ this._flushTimer = null;
        /** @private */ this._flushInterval = options.flushInterval || 50;
        /** @private */ this._autoFlush = options.autoFlush !== false;

        // Ensure directory exists
        if (!fs.existsSync(this._dir))
        {
            fs.mkdirSync(this._dir, { recursive: true });
        }

        // Load any existing tables
        try
        {
            const files = fs.readdirSync(this._dir).filter(f => f.endsWith('.json'));
            for (const file of files)
            {
                const table = path.basename(file, '.json');
                const content = fs.readFileSync(path.join(this._dir, file), 'utf8');
                const parsed = JSON.parse(content);
                this._tables.set(table, parsed.rows || []);
                this._autoIncrements.set(table, parsed.autoIncrement || 1);
            }
        }
        catch (e) { /* fresh start */ }
    }

    /** @override */
    async createTable(table, schema)
    {
        await super.createTable(table, schema);
        this._scheduleSave(table);
    }

    /** @override */
    async dropTable(table)
    {
        await super.dropTable(table);
        const filePath = path.join(this._dir, `${table}.json`);
        try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }

    /** @override */
    async insert(table, data)
    {
        const result = await super.insert(table, data);
        this._scheduleSave(table);
        return result;
    }

    /** @override */
    async update(table, pk, pkVal, data)
    {
        await super.update(table, pk, pkVal, data);
        this._scheduleSave(table);
    }

    /** @override */
    async updateWhere(table, conditions, data)
    {
        const count = await super.updateWhere(table, conditions, data);
        if (count > 0) this._scheduleSave(table);
        return count;
    }

    /** @override */
    async remove(table, pk, pkVal)
    {
        await super.remove(table, pk, pkVal);
        this._scheduleSave(table);
    }

    /** @override */
    async deleteWhere(table, conditions)
    {
        const count = await super.deleteWhere(table, conditions);
        if (count > 0) this._scheduleSave(table);
        return count;
    }

    /** @override */
    async clear()
    {
        await super.clear();
        for (const table of this._tables.keys()) this._scheduleSave(table);
    }

    /**
     * Immediately flush all pending writes.
     */
    async flush()
    {
        for (const table of this._dirty) this._saveTable(table);
        this._dirty.clear();
        if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    }

    /** @private Schedule a debounced save for the given table. */
    _scheduleSave(table)
    {
        this._dirty.add(table);
        if (this._autoFlush && !this._flushTimer)
        {
            this._flushTimer = setTimeout(() =>
            {
                this.flush();
            }, this._flushInterval);
        }
    }

    /** @private Write table data to JSON file. */
    _saveTable(table)
    {
        const filePath = path.join(this._dir, `${table}.json`);
        const data = {
            autoIncrement: this._autoIncrements.get(table) || 1,
            rows: this._tables.get(table) || [],
        };
        const json = this._pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);

        // Atomic write: write to temp file then rename
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, json, 'utf8');
        fs.renameSync(tmpPath, filePath);
    }

    // -- JSON Adapter Utilities --------------------------

    /**
     * Get the directory where JSON files are stored.
     * @returns {string}
     */
    get directory() { return this._dir; }

    /**
     * Get the total size of all JSON files in bytes.
     * @returns {number}
     */
    fileSize()
    {
        let total = 0;
        try
        {
            const files = fs.readdirSync(this._dir).filter(f => f.endsWith('.json'));
            for (const file of files)
            {
                total += fs.statSync(path.join(this._dir, file)).size;
            }
        }
        catch { /* empty dir, no files */ }
        return total;
    }

    /**
     * Check if there are pending writes that haven't been flushed.
     * @returns {boolean}
     */
    get hasPendingWrites() { return this._dirty.size > 0; }

    /**
     * Compact a specific table's JSON file (re-serialize, removes whitespace bloat).
     * @param {string} table
     */
    compact(table)
    {
        if (this._tables.has(table)) this._saveTable(table);
    }

    /**
     * Back up the entire data directory to a target path.
     * @param {string} destDir - Destination directory (will be created).
     */
    backup(destDir)
    {
        const dest = path.resolve(destDir);
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        const files = fs.readdirSync(this._dir).filter(f => f.endsWith('.json'));
        for (const file of files)
        {
            fs.copyFileSync(
                path.join(this._dir, file),
                path.join(dest, file)
            );
        }
    }
}

module.exports = JsonAdapter;
