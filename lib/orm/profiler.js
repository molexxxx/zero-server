/**
 * @module orm/profiler
 * @description Query profiling, slow query detection, and automatic N+1 detection.
 *              Attach to a Database instance via `db.enableProfiling()`.
 *
 * @example
 *   const { Database, QueryProfiler } = require('zero-http');
 *
 *   const db = Database.connect('memory');
 *   const profiler = db.enableProfiling({ slowThreshold: 100 });
 *
 *   // ... run queries ...
 *
 *   console.log(profiler.metrics());
 *   console.log(profiler.slowQueries());
 *   console.log(profiler.n1Detections());
 */

const log = require('../debug')('zero:profiler');

class QueryProfiler
{
    /**
     * @constructor
     * @param {object}   [options] - Configuration options.
     * @param {boolean}  [options.enabled=true]       - Enable/disable profiling.
     * @param {number}   [options.slowThreshold=100]  - Duration (ms) above which a query is "slow".
     * @param {number}   [options.maxHistory=1000]    - Maximum recorded query entries.
     * @param {Function} [options.onSlow]             - Callback on slow query: (entry) => {}.
     * @param {number}   [options.n1Threshold=5]      - Minimum rapid same-table SELECTs to flag N+1.
     * @param {number}   [options.n1Window=100]       - Time window (ms) for N+1 detection.
     * @param {Function} [options.onN1]               - Callback on N+1 detection: (info) => {}.
     */
    constructor(options = {})
    {
        this._enabled = options.enabled !== false;
        this._slowThreshold = Math.max(0, options.slowThreshold != null ? Number(options.slowThreshold) : 100);
        this._maxHistory = Math.max(1, Math.floor(Number(options.maxHistory) || 1000));
        this._onSlow = typeof options.onSlow === 'function' ? options.onSlow : null;

        // N+1 detection
        this._n1Threshold = Math.max(2, Math.floor(Number(options.n1Threshold) || 5));
        this._n1Window = Math.max(10, Number(options.n1Window) || 100);
        this._onN1 = typeof options.onN1 === 'function' ? options.onN1 : null;
        this._maxN1History = Math.max(1, Math.floor(Number(options.maxN1History) || 100));
        this._n1Detected = [];

        // Query history
        this._queries = [];

        // Aggregate stats
        this._totalQueries = 0;
        this._totalTime = 0;
        this._slowCount = 0;
        this._startTime = Date.now();
    }

    /**
     * Record a query execution.
     *
     * @param {object} entry - Profiler entry object.
     * @param {string} entry.table    - Table name.
     * @param {string} entry.action   - Query action (select, insert, update, delete, count).
     * @param {number} entry.duration - Execution time in milliseconds.
     */
    record(entry)
    {
        if (!this._enabled) return;

        // Sanitize
        const record = {
            table: String(entry.table || ''),
            action: String(entry.action || 'unknown'),
            duration: Number(entry.duration) || 0,
            timestamp: Date.now(),
        };

        this._totalQueries++;
        this._totalTime += record.duration;

        // Enforce history limit (evict oldest)
        if (this._queries.length >= this._maxHistory)
        {
            this._queries.shift();
        }
        this._queries.push(record);

        // Slow query detection
        if (record.duration > this._slowThreshold)
        {
            this._slowCount++;
            log.warn('Slow query: %s %s (%dms)', record.action, record.table, Math.round(record.duration));
            if (this._onSlow) this._onSlow(record);
        }

        // N+1 detection (only for SELECTs)
        this._detectN1(record.table, record.action);
    }

    /**
     * Detect potential N+1 query patterns.
     * Flags when the same table receives >= threshold SELECT queries within a time window.
     * @param {string} table - Table involved.
     * @param {string} action - CRUD action performed.
     * @private
     */
    _detectN1(table, action)
    {
        if (action !== 'select') return;

        const now = Date.now();
        const recentSameTable = this._queries.filter(
            q => q.table === table && q.action === 'select' && (now - q.timestamp) < this._n1Window
        );

        if (recentSameTable.length >= this._n1Threshold)
        {
            // Prevent duplicate detection for same burst
            const last = this._n1Detected.find(d => d.table === table);
            if (last && (now - last.timestamp) < this._n1Window) return;

            const detection = {
                table,
                count: recentSameTable.length,
                timestamp: now,
                message: `Potential N+1: ${recentSameTable.length} SELECT queries to "${table}" in ${this._n1Window}ms`,
            };
            // Cap N+1 detection history to prevent memory exhaustion
            if (this._n1Detected.length >= this._maxN1History)
            {
                this._n1Detected.shift();
            }
            this._n1Detected.push(detection);
            log.warn(detection.message);
            if (this._onN1) this._onN1(detection);
        }
    }

    /**
     * Get aggregate profiling metrics.
     *
     * @returns {{
     *   totalQueries: number,
     *   totalTime: number,
     *   avgLatency: number,
     *   queriesPerSecond: number,
     *   slowQueries: number,
     *   n1Detections: number,
     * }}
     */
    metrics()
    {
        const elapsed = (Date.now() - this._startTime) / 1000 || 1;
        return {
            totalQueries: this._totalQueries,
            totalTime: Math.round(this._totalTime * 100) / 100,
            avgLatency: this._totalQueries > 0
                ? Math.round((this._totalTime / this._totalQueries) * 100) / 100
                : 0,
            queriesPerSecond: Math.round((this._totalQueries / elapsed) * 100) / 100,
            slowQueries: this._slowCount,
            n1Detections: this._n1Detected.length,
        };
    }

    /**
     * Get all slow queries from history.
     * @returns {Array<{ table: string, action: string, duration: number, timestamp: number }>}
     */
    slowQueries()
    {
        return this._queries.filter(q => q.duration > this._slowThreshold);
    }

    /**
     * Get all N+1 detections.
     * @returns {Array<{ table: string, count: number, timestamp: number, message: string }>}
     */
    n1Detections()
    {
        return [...this._n1Detected];
    }

    /**
     * Get filtered query history.
     *
     * @param {object}  [options] - Configuration options.
     * @param {string}  [options.table]       - Filter by table name.
     * @param {string}  [options.action]      - Filter by action type.
     * @param {number}  [options.minDuration] - Minimum duration filter.
     * @returns {Array<{ table: string, action: string, duration: number, timestamp: number }>} Filtered query history entries.
     */
    getQueries(options = {})
    {
        let results = [...this._queries];
        if (options.table) results = results.filter(q => q.table === options.table);
        if (options.action) results = results.filter(q => q.action === options.action);
        if (options.minDuration !== undefined) results = results.filter(q => q.duration >= options.minDuration);
        return results;
    }

    /**
     * Reset all profiling state.
     */
    reset()
    {
        this._queries = [];
        this._totalQueries = 0;
        this._totalTime = 0;
        this._slowCount = 0;
        this._startTime = Date.now();
        this._n1Detected = [];
    }

    /** @type {boolean} */
    get enabled() { return this._enabled; }
    set enabled(val) { this._enabled = !!val; }
}

module.exports = { QueryProfiler };
