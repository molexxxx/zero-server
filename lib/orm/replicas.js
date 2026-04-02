/**
 * @module orm/replicas
 * @description Read replica management with automatic read/write splitting,
 *              round-robin and random selection strategies, sticky writes,
 *              and health checking.
 *
 * @example
 *   const { Database, ReplicaManager } = require('zero-http');
 *
 *   const db = Database.connectWithReplicas('postgres',
 *       { host: 'primary.db', database: 'app' },
 *       [
 *           { host: 'replica1.db', database: 'app' },
 *           { host: 'replica2.db', database: 'app' },
 *       ],
 *       { strategy: 'round-robin', stickyWindow: 2000 }
 *   );
 */

const log = require('../debug')('zero:replicas');

class ReplicaManager
{
    /**
     * @constructor
     * @param {object}  [options] - Configuration options.
     * @param {string}  [options.strategy='round-robin'] - Selection strategy: 'round-robin' | 'random'.
     * @param {boolean} [options.stickyWrite=true]       - Read from primary after a write for stickyWindow ms.
     * @param {number}  [options.stickyWindow=1000]      - Duration (ms) to read from primary after a write.
     */
    constructor(options = {})
    {
        /** @private */ this._primary = null;
        /** @private */ this._replicas = [];

        // Validate strategy against whitelist
        const allowed = ['round-robin', 'random'];
        const strategy = options.strategy || 'round-robin';
        if (!allowed.includes(strategy))
        {
            throw new Error(`Invalid replica strategy: "${strategy}". Must be one of: ${allowed.join(', ')}`);
        }
        /** @private */ this._strategy = strategy;
        /** @private */ this._idx = 0;

        // Sticky writes: read from primary after a write to avoid stale reads
        /** @private */ this._stickyWrite = options.stickyWrite !== false;
        /** @private */ this._stickyWindow = Math.max(0, Number(options.stickyWindow) || 1000);
        /** @private */ this._lastWriteAt = 0;
    }

    /**
     * Set the primary (read-write) adapter.
     * @param {object} adapter - Database adapter instance.
     * @throws {Error} If adapter is null or undefined.
     */
    setPrimary(adapter)
    {
        if (!adapter) throw new Error('Primary adapter must not be null');
        this._primary = adapter;
    }

    /**
     * Add a read replica adapter.
     * @param {object} adapter - Database adapter instance.
     */
    addReplica(adapter)
    {
        if (!adapter) throw new Error('Replica adapter must not be null');
        this._replicas.push({ adapter, healthy: true, lastChecked: 0 });
    }

    /**
     * Number of registered replicas.
     * @type {number}
     */
    get replicaCount()
    {
        return this._replicas.length;
    }

    /**
     * Get an adapter for read operations.
     * Respects strategy, health status, and sticky writes.
     *
     * @returns {object} Adapter instance.
     */
    getReadAdapter()
    {
        // Sticky writes: use primary during the sticky window
        if (this._stickyWrite && (Date.now() - this._lastWriteAt) < this._stickyWindow)
        {
            log('Sticky write window active, using primary for read');
            return this._primary;
        }

        const healthy = this._replicas.filter(r => r.healthy);
        if (!healthy.length)
        {
            log('No healthy replicas, falling back to primary');
            return this._primary;
        }

        let replica;
        if (this._strategy === 'random')
        {
            replica = healthy[Math.floor(Math.random() * healthy.length)];
        }
        else
        {
            // round-robin (reset index to prevent unbounded growth)
            replica = healthy[this._idx % healthy.length];
            this._idx = (this._idx + 1) % Number.MAX_SAFE_INTEGER;
        }

        return replica.adapter;
    }

    /**
     * Get the primary adapter for write operations.
     * Also updates the last write timestamp for sticky window tracking.
     *
     * @returns {object} Primary adapter instance.
     */
    getWriteAdapter()
    {
        this._lastWriteAt = Date.now();
        return this._primary;
    }

    /**
     * Mark a replica as unhealthy (excluded from read routing).
     * @param {object} adapter - Database adapter instance.
     */
    markUnhealthy(adapter)
    {
        const replica = this._replicas.find(r => r.adapter === adapter);
        if (replica)
        {
            replica.healthy = false;
            log('Replica marked unhealthy');
        }
    }

    /**
     * Mark a replica as healthy (re-included in read routing).
     * @param {object} adapter - Database adapter instance.
     */
    markHealthy(adapter)
    {
        const replica = this._replicas.find(r => r.adapter === adapter);
        if (replica)
        {
            replica.healthy = true;
        }
    }

    /**
     * Run a health check on all replicas.
     * Calls adapter.ping() if available.
     *
     * @returns {Promise<Array<{ healthy: boolean, lastChecked: number }>>}
     */
    async healthCheck()
    {
        const results = [];
        for (const replica of this._replicas)
        {
            try
            {
                if (typeof replica.adapter.ping === 'function')
                {
                    replica.healthy = await replica.adapter.ping();
                }
                else
                {
                    // Adapters without ping are assumed healthy
                    replica.healthy = true;
                }
            }
            catch
            {
                replica.healthy = false;
            }
            replica.lastChecked = Date.now();
            results.push({ healthy: replica.healthy, lastChecked: replica.lastChecked });
        }
        return results;
    }

    /**
     * Get all adapters (primary + replicas).
     * @returns {object[]} Primary and all replica adapters.
     */
    getAllAdapters()
    {
        return [this._primary, ...this._replicas.map(r => r.adapter)].filter(Boolean);
    }

    /**
     * Remove a replica adapter from the pool.
     * @param {object} adapter - Database adapter instance.
     */
    removeReplica(adapter)
    {
        this._replicas = this._replicas.filter(r => r.adapter !== adapter);
    }

    /**
     * Get pool status summary.
     * @returns {{ primary: boolean, total: number, healthy: number, unhealthy: number, strategy: string }}
     */
    status()
    {
        const healthy = this._replicas.filter(r => r.healthy).length;
        return {
            primary: !!this._primary,
            total: this._replicas.length,
            healthy,
            unhealthy: this._replicas.length - healthy,
            strategy: this._strategy,
        };
    }

    /**
     * Close all adapters (primary + replicas).
     * @returns {Promise<void>}
     */
    async closeAll()
    {
        for (const adapter of this.getAllAdapters())
        {
            if (typeof adapter.close === 'function')
            {
                await adapter.close();
            }
        }
    }
}

module.exports = { ReplicaManager };
