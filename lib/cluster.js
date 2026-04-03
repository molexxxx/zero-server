/**
 * @module cluster
 * @description Clustering support for zero-http applications.
 *              Forks worker processes, manages automatic restarts with backoff,
 *              and provides IPC messaging between the primary and workers.
 *
 * @example
 *   const { createApp, cluster } = require('zero-http');
 *
 *   cluster((worker) => {
 *       const app = createApp();
 *       app.get('/', (req, res) => res.json({ pid: process.pid }));
 *       app.listen(3000);
 *   });
 *
 * @example
 *   // With options
 *   cluster((worker) => {
 *       const app = createApp();
 *       app.listen(3000);
 *   }, {
 *       workers: 4,
 *       respawn: true,
 *       respawnDelay: 1000,
 *       maxRespawnDelay: 30000,
 *   });
 */
const cluster = require('cluster');
const os = require('os');
const log = require('./debug')('zero:cluster');

/**
 * Default cluster configuration.
 * @private
 */
const DEFAULTS = {
    workers: os.cpus().length,
    respawn: true,
    respawnDelay: 1000,
    maxRespawnDelay: 30000,
    backoffFactor: 2,
};

// -- Cluster Manager -------------------------------

/**
 * Manages a cluster of worker processes for a zero-http application.
 * Runs on the primary process only; each worker is a forked child process
 * sharing the same server port via the OS.
 */
class ClusterManager
{
    /**
     * @constructor
     * @param {object}   [opts] - Cluster configuration.
     * @param {number}   [opts.workers] - Number of worker processes (default: CPU count).
     * @param {boolean}  [opts.respawn=true] - Automatically respawn crashed workers.
     * @param {number}   [opts.respawnDelay=1000] - Initial delay (ms) before respawning.
     * @param {number}   [opts.maxRespawnDelay=30000] - Maximum respawn delay after backoff.
     * @param {number}   [opts.backoffFactor=2] - Multiplier for exponential backoff.
     */
    constructor(opts = {})
    {
        this._opts = { ...DEFAULTS, ...opts };

        /** @type {Map<number, import('cluster').Worker>} Worker ID → Worker */
        this._workers = new Map();

        /** @type {Map<number, number>} Worker ID → consecutive crash count */
        this._crashCounts = new Map();

        /** @type {Object<string, Function[]>} IPC message listeners keyed by type */
        this._messageHandlers = {};

        /** Whether the cluster is shutting down. @private */
        this._shuttingDown = false;

        /** Whether fork has been called. @private */
        this._started = false;
    }

    /**
     * Whether the current process is the primary (master) process.
     * @type {boolean}
     */
    get isPrimary()
    {
        return cluster.isPrimary !== undefined ? cluster.isPrimary : cluster.isMaster;
    }

    /**
     * Whether the current process is a worker process.
     * @type {boolean}
     */
    get isWorker()
    {
        return cluster.isWorker;
    }

    /**
     * Number of configured workers.
     * @type {number}
     */
    get workerCount()
    {
        return this._opts.workers;
    }

    /**
     * Get all active worker IDs.
     * @returns {number[]} Array of worker IDs.
     */
    get workerIds()
    {
        return Array.from(this._workers.keys());
    }

    /**
     * Number of currently alive workers.
     * @type {number}
     */
    get activeWorkers()
    {
        return this._workers.size;
    }

    /**
     * Fork all worker processes. Only call from the primary process.
     *
     * @returns {ClusterManager} this
     *
     * @example
     *   const mgr = new ClusterManager({ workers: 4 });
     *   if (mgr.isPrimary) {
     *       mgr.fork();
     *   }
     */
    fork()
    {
        if (!this.isPrimary) return this;
        if (this._started) return this;
        this._started = true;

        const count = this._opts.workers;
        log.info('forking %d workers', count);

        for (let i = 0; i < count; i++)
        {
            this._spawnWorker();
        }

        cluster.on('exit', (worker, code, signal) =>
        {
            this._workers.delete(worker.id);

            if (this._shuttingDown)
            {
                log.info('worker %d exited during shutdown', worker.id);
                return;
            }

            if (signal)
            {
                log.warn('worker %d killed by signal %s', worker.id, signal);
            }
            else if (code !== 0)
            {
                log.warn('worker %d exited with code %d', worker.id, code);
            }
            else
            {
                log.info('worker %d exited cleanly', worker.id);
            }

            // Respawn if enabled and not shutting down
            if (this._opts.respawn && code !== 0 && !this._shuttingDown)
            {
                const crashes = (this._crashCounts.get(worker.id) || 0) + 1;
                const delay = Math.min(
                    this._opts.respawnDelay * Math.pow(this._opts.backoffFactor, crashes - 1),
                    this._opts.maxRespawnDelay
                );
                log.info('respawning worker in %dms (crash #%d)', delay, crashes);
                setTimeout(() =>
                {
                    if (!this._shuttingDown) this._spawnWorker();
                }, delay);
            }
        });

        // Relay IPC messages from workers
        cluster.on('message', (worker, message) =>
        {
            if (message && typeof message === 'object' && message._zhttp)
            {
                this._handleMessage(worker, message);
            }
        });

        return this;
    }

    /**
     * Spawn a single worker process.
     * @private
     * @returns {import('cluster').Worker}
     */
    _spawnWorker()
    {
        const worker = cluster.fork();
        this._workers.set(worker.id, worker);
        this._crashCounts.set(worker.id, 0);
        log.info('worker %d spawned (pid %d)', worker.id, worker.process.pid);
        return worker;
    }

    // -- IPC Messaging ---------------------------------

    /**
     * Send a typed message from the primary to all workers.
     *
     * @param {string} type - Message type identifier.
     * @param {*}      data - Message payload (must be serialisable).
     *
     * @example
     *   // Primary
     *   mgr.broadcast('config:update', { maxConn: 100 });
     *
     *   // Worker
     *   mgr.onMessage('config:update', (data) => {
     *       console.log('new config:', data);
     *   });
     */
    broadcast(type, data)
    {
        const msg = { _zhttp: true, type, data };
        for (const worker of this._workers.values())
        {
            if (!worker.isDead()) worker.send(msg);
        }
    }

    /**
     * Send a typed message to a specific worker.
     *
     * @param {number} workerId - Target worker ID.
     * @param {string} type     - Message type identifier.
     * @param {*}      data     - Message payload.
     */
    sendTo(workerId, type, data)
    {
        const worker = this._workers.get(workerId);
        if (worker && !worker.isDead())
        {
            worker.send({ _zhttp: true, type, data });
        }
    }

    /**
     * Send a typed message from a worker to the primary process.
     * Call this from within a worker process.
     *
     * @param {string} type - Message type identifier.
     * @param {*}      data - Message payload.
     *
     * @example
     *   // In a worker
     *   mgr.sendToPrimary('metrics', { reqCount: 150 });
     */
    sendToPrimary(type, data)
    {
        if (!this.isWorker) return;
        process.send({ _zhttp: true, type, data });
    }

    /**
     * Register a handler for a typed IPC message.
     * On the primary, receives messages from workers.
     * On workers, receives messages from the primary.
     *
     * @param {string}   type - Message type to listen for.
     * @param {Function} fn   - Handler `(data, worker?) => void`. `worker` is only present on the primary.
     * @returns {ClusterManager} this
     *
     * @example
     *   mgr.onMessage('metrics', (data, worker) => {
     *       console.log('worker', worker.id, 'reports:', data);
     *   });
     */
    onMessage(type, fn)
    {
        if (!this._messageHandlers[type]) this._messageHandlers[type] = [];
        this._messageHandlers[type].push(fn);

        // If this is a worker, also listen on process for primary → worker messages
        if (this.isWorker && !this._workerListenerInstalled)
        {
            this._workerListenerInstalled = true;
            process.on('message', (message) =>
            {
                if (message && typeof message === 'object' && message._zhttp)
                {
                    const fns = this._messageHandlers[message.type];
                    if (fns)
                    {
                        for (const handler of fns.slice())
                        {
                            try { handler(message.data); }
                            catch (err) { log.error('message handler error: %s', err.message); }
                        }
                    }
                }
            });
        }

        return this;
    }

    /**
     * Handle an incoming IPC message from a worker.
     * @private
     * @param {import('cluster').Worker} worker
     * @param {{ type: string, data: * }} message
     */
    _handleMessage(worker, message)
    {
        const fns = this._messageHandlers[message.type];
        if (!fns) return;
        for (const fn of fns.slice())
        {
            try { fn(message.data, worker); }
            catch (err) { log.error('message handler error: %s', err.message); }
        }
    }

    // -- Per-Worker Metrics Aggregation ----------------

    /**
     * Enable automatic per-worker metrics aggregation.
     * Workers periodically send their metrics snapshot to the primary,
     * which merges them into a single registry for exposition.
     *
     * @param {import('./observe/metrics').MetricsRegistry} registry - Registry to aggregate into (on primary) or report from (on worker).
     * @param {object} [opts] - Options.
     * @param {number} [opts.interval=5000] - Reporting interval in ms.
     * @returns {ClusterManager} this
     *
     * @example
     *   const { MetricsRegistry, cluster } = require('zero-http');
     *   const registry = new MetricsRegistry();
     *
     *   cluster((mgr) => {
     *       const app = createApp();
     *       app.use(metricsMiddleware({ registry }));
     *       mgr.enableMetrics(registry, { interval: 3000 });
     *       app.listen(3000);
     *   });
     */
    enableMetrics(registry, opts = {})
    {
        const interval = opts.interval || 5000;

        if (this.isWorker)
        {
            // Worker: periodically send metrics to primary
            this._metricsTimer = setInterval(() =>
            {
                this.sendToPrimary('metrics:report', registry.toJSON());
            }, interval);
            if (this._metricsTimer.unref) this._metricsTimer.unref();
        }
        else if (this.isPrimary)
        {
            // Primary: aggregate incoming metrics
            this._aggregateRegistry = registry;
            this.onMessage('metrics:report', (data) =>
            {
                registry.merge(data);
            });
        }

        return this;
    }

    /**
     * Stop the per-worker metrics reporting timer.
     */
    disableMetrics()
    {
        if (this._metricsTimer)
        {
            clearInterval(this._metricsTimer);
            this._metricsTimer = null;
        }
    }

    // -- Sticky Sessions --------------------------------

    /**
     * Enable sticky sessions by hashing client IP addresses to specific workers.
     * Ensures WebSocket and SSE connections from the same client always
     * land on the same worker for proper room/state management.
     *
     * Must be called on the primary BEFORE listen(). Replaces the
     * default round-robin OS scheduling with a custom `connection`
     * listener that distributes sockets to workers based on IP hash.
     *
     * @param {import('http').Server|import('https').Server} server - The HTTP server to attach to.
     * @param {object} [opts] - Options.
     * @param {Function} [opts.hash] - Custom hash function `(ip, workerCount) => workerIndex`.
     * @returns {ClusterManager} this
     *
     * @example
     *   if (mgr.isPrimary) {
     *       const server = http.createServer();
     *       mgr.enableSticky(server);
     *       server.listen(3000);
     *   }
     */
    enableSticky(server, opts = {})
    {
        if (!this.isPrimary || !server) return this;

        const hashFn = typeof opts.hash === 'function'
            ? opts.hash
            : _defaultIpHash;

        // Pause the default round-robin by taking over the connection event
        server.on('connection', (socket) =>
        {
            // Don't distribute if no workers or shutting down
            if (this._workers.size === 0 || this._shuttingDown)
            {
                socket.destroy();
                return;
            }

            const ip = socket.remoteAddress || '';
            const workerIds = Array.from(this._workers.keys());
            const idx = hashFn(ip, workerIds.length);
            const workerId = workerIds[idx % workerIds.length];
            const worker = this._workers.get(workerId);

            if (worker && !worker.isDead())
            {
                worker.send({ _zhttp: true, type: 'sticky:connection' }, socket);
            }
            else
            {
                socket.destroy();
            }
        });

        return this;
    }

    // -- Graceful Restart & Shutdown -------------------

    /**
     * Perform a rolling restart of all workers (zero-downtime).
     * Workers are restarted one at a time — a new worker is spawned and
     * confirmed listening before the old one is disconnected.
     *
     * @returns {Promise<void>} Resolves when all workers have been replaced.
     *
     * @example
     *   process.on('SIGHUP', () => mgr.reload());
     */
    async reload()
    {
        if (!this.isPrimary || this._shuttingDown) return;

        const workerIds = Array.from(this._workers.keys());
        log.info('rolling restart of %d workers', workerIds.length);

        for (const id of workerIds)
        {
            const old = this._workers.get(id);
            if (!old || old.isDead()) continue;

            // Spawn replacement
            const replacement = this._spawnWorker();

            // Wait for replacement to come online
            await new Promise((resolve) =>
            {
                replacement.once('listening', resolve);
                // Safety timeout — don't wait forever
                const timer = setTimeout(resolve, 10000);
                if (timer.unref) timer.unref();
            });

            // Disconnect old worker gracefully
            old.disconnect();
            await new Promise((resolve) =>
            {
                old.once('exit', resolve);
                const timer = setTimeout(() =>
                {
                    if (!old.isDead()) old.kill();
                    resolve();
                }, 10000);
                if (timer.unref) timer.unref();
            });

            this._workers.delete(id);
            log.info('replaced worker %d → %d', id, replacement.id);
        }

        log.info('rolling restart complete');
    }

    /**
     * Shut down the entire cluster gracefully.
     * Sends `'shutdown'` IPC message to all workers, then waits for them
     * to exit. Workers that don't exit within the timeout are killed.
     *
     * @param {object} [opts] - Shutdown options.
     * @param {number} [opts.timeout=30000] - Maximum ms to wait for workers to exit.
     * @returns {Promise<void>} Resolves when all workers have exited.
     *
     * @example
     *   process.on('SIGTERM', async () => {
     *       await mgr.shutdown({ timeout: 10000 });
     *       process.exit(0);
     *   });
     */
    async shutdown(opts = {})
    {
        if (this._shuttingDown) return;
        this._shuttingDown = true;

        const timeout = opts.timeout || 30000;
        log.info('cluster shutdown initiated (timeout=%dms)', timeout);

        // Signal all workers to shut down
        this.broadcast('shutdown', {});

        // Disconnect workers gracefully
        for (const worker of this._workers.values())
        {
            if (!worker.isDead()) worker.disconnect();
        }

        // Wait for all workers to exit
        await Promise.race([
            this._waitForAllWorkers(),
            new Promise((resolve) =>
            {
                const t = setTimeout(resolve, timeout);
                if (t.unref) t.unref();
            }),
        ]);

        // Kill any remaining workers
        for (const worker of this._workers.values())
        {
            if (!worker.isDead())
            {
                log.warn('force-killing worker %d', worker.id);
                worker.kill();
            }
        }

        this._workers.clear();
        log.info('cluster shutdown complete');
    }

    /**
     * Wait for all tracked workers to exit.
     * @private
     * @returns {Promise<void>}
     */
    _waitForAllWorkers()
    {
        if (this._workers.size === 0) return Promise.resolve();

        return new Promise((resolve) =>
        {
            const check = () =>
            {
                if (this._workers.size === 0) resolve();
            };
            cluster.on('exit', check);
            check();
        });
    }
}

// -- Convenience Function --------------------------

/**
 * High-level clustering helper. Forks workers on the primary process and
 * runs the provided setup function on each worker.
 *
 * @param {Function} workerFn - Function to execute on each worker process.
 *                               Receives the ClusterManager instance as argument.
 * @param {object}   [opts]   - Cluster options (see ClusterManager constructor).
 * @returns {ClusterManager}  The cluster manager instance (on both primary and workers).
 *
 * @example
 *   const { cluster } = require('zero-http');
 *
 *   cluster((mgr) => {
 *       const app = createApp();
 *       app.get('/', (req, res) => res.json({ pid: process.pid }));
 *       app.listen(3000);
 *   }, { workers: 4 });
 */
function clusterize(workerFn, opts = {})
{
    const mgr = new ClusterManager(opts);

    if (mgr.isPrimary)
    {
        mgr.fork();

        // Install signal handlers on primary
        const shutdownHandler = (signal) =>
        {
            log.info('primary received %s', signal);
            mgr.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
        };

        process.on('SIGTERM', shutdownHandler);
        process.on('SIGINT', shutdownHandler);

        // SIGHUP triggers rolling restart (Unix only)
        if (process.platform !== 'win32')
        {
            process.on('SIGHUP', () => mgr.reload());
        }
    }
    else
    {
        // Worker process — listen for shutdown IPC from primary
        mgr.onMessage('shutdown', () =>
        {
            log.info('worker received shutdown message');
            // App-level shutdown is handled by the lifecycle manager via SIGTERM fallback
            process.disconnect();
        });

        workerFn(mgr);
    }

    return mgr;
}

/**
 * Default IP hash for sticky sessions.
 * Uses DJB2 hash for fast integer distribution.
 * @private
 * @param {string} ip - Client IP address.
 * @param {number} count - Number of workers.
 * @returns {number} Worker index.
 */
function _defaultIpHash(ip, count)
{
    if (count <= 0) return 0;
    let hash = 5381;
    for (let i = 0; i < ip.length; i++)
    {
        hash = ((hash << 5) + hash + ip.charCodeAt(i)) & 0x7fffffff;
    }
    return hash % count;
}

module.exports = { ClusterManager, clusterize, _defaultIpHash };
