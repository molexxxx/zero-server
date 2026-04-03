/**
 * @module observe/health
 * @description Health check middleware with liveness and readiness probes.
 *              Kubernetes-compatible `/healthz` and `/readyz` endpoints with
 *              composable checks (database ping, memory, event loop lag,
 *              disk space) and custom check registration.
 *
 *              Returns `200` when healthy, `503` when degraded or during
 *              shutdown drain phase, with a JSON body detailing each check.
 *
 * @example
 *   const { healthCheck } = require('zero-http');
 *
 *   app.get('/healthz', healthCheck());
 *   app.get('/readyz', healthCheck({
 *       checks: {
 *           database: () => db.ping(),
 *           cache: () => redis.ping(),
 *       },
 *   }));
 *
 * @example
 *   // Using the app integration
 *   app.health('/healthz');
 *   app.ready('/readyz', {
 *       database: () => db.ping(),
 *   });
 */
const os = require('os');

// -- Built-in Checks -----------------------------------------------

/**
 * Check memory usage against a threshold.
 *
 * @param {object} [opts] - Check options.
 * @param {number} [opts.maxHeapUsedPercent=90] - Max heap usage percentage.
 * @param {number} [opts.maxRssBytes] - Max RSS in bytes.
 * @returns {Function} Check function.
 *
 * @example
 *   app.get('/healthz', healthCheck({
 *       checks: { memory: memoryCheck({ maxHeapUsedPercent: 85 }) },
 *   }));
 */
function memoryCheck(opts = {})
{
    const maxPercent = typeof opts.maxHeapUsedPercent === 'number' ? opts.maxHeapUsedPercent : 90;
    const maxRss = opts.maxRssBytes || Infinity;

    return () =>
    {
        const mem = process.memoryUsage();
        const heapPercent = (mem.heapUsed / mem.heapTotal) * 100;
        const healthy = heapPercent < maxPercent && mem.rss < maxRss;

        return {
            healthy,
            details: {
                heapUsed: mem.heapUsed,
                heapTotal: mem.heapTotal,
                heapPercent: Math.round(heapPercent * 100) / 100,
                rss: mem.rss,
                external: mem.external,
            },
        };
    };
}

/**
 * Check event loop lag against a threshold.
 *
 * @param {object} [opts] - Check options.
 * @param {number} [opts.maxLagMs=500] - Max acceptable lag in ms.
 * @returns {Function} Check function.
 *
 * @example
 *   app.get('/healthz', healthCheck({
 *       checks: { eventLoop: eventLoopCheck({ maxLagMs: 200 }) },
 *   }));
 */
function eventLoopCheck(opts = {})
{
    const maxLag = opts.maxLagMs || 500;
    let _lastCheck = process.hrtime.bigint();
    let _lag = 0;

    // Sample event loop lag periodically
    const _check = () =>
    {
        const now = process.hrtime.bigint();
        const expected = 1_000_000_000n; // 1 second in nanoseconds
        const actual = now - _lastCheck;
        _lag = Math.max(0, Number(actual - expected) / 1e6); // ms
        _lastCheck = now;
    };

    const timer = setInterval(_check, 1000);
    if (timer.unref) timer.unref();

    const check = () => ({
        healthy: _lag < maxLag,
        details: { lagMs: Math.round(_lag * 100) / 100, maxLagMs: maxLag },
    });

    // Expose cleanup for testing
    check._cleanup = () => clearInterval(timer);
    return check;
}

/**
 * Check available disk space (simple heuristic using os.freemem).
 *
 * @param {object} [opts] - Check options.
 * @param {number} [opts.minFreeBytes=104857600] - Minimum free memory in bytes (default: 100MB).
 * @returns {Function} Check function.
 */
function diskSpaceCheck(opts = {})
{
    const minFree = opts.minFreeBytes || 104857600; // 100MB

    return () =>
    {
        const free = os.freemem();
        return {
            healthy: free > minFree,
            details: {
                freeMemory: free,
                totalMemory: os.totalmem(),
                minRequired: minFree,
            },
        };
    };
}

// -- Health Check Handler ------------------------------------------

/**
 * Create a health check route handler.
 *
 * Returns a JSON response with the status of all registered checks.
 * Returns `200` when all checks pass, `503` when any check fails
 * or when the application is in drain/shutdown state.
 *
 * Response format:
 * ```json
 * {
 *   "status": "healthy",
 *   "uptime": 12345,
 *   "timestamp": "2026-01-01T00:00:00.000Z",
 *   "checks": {
 *     "database": { "healthy": true, "duration": 5, "details": {} }
 *   }
 * }
 * ```
 *
 * @param {object} [opts] - Options.
 * @param {Object<string, Function>} [opts.checks] - Named check functions. Each returns `{ healthy, details }` or a boolean/Promise.
 * @param {number} [opts.timeout=5000] - Max time to wait for all checks in ms.
 * @param {boolean} [opts.verbose=true] - Include check details in response.
 * @param {Function} [opts.onFailure] - `(results) => void` — called when any check fails.
 * @returns {Function} Route handler `(req, res) => void`.
 *
 * @example
 *   app.get('/healthz', healthCheck());
 *
 * @example
 *   app.get('/readyz', healthCheck({
 *       checks: {
 *           database: async () => {
 *               await db.ping();
 *               return { healthy: true };
 *           },
 *           cache: () => ({ healthy: cacheClient.isConnected }),
 *       },
 *   }));
 *
 * @example
 *   // Auto-deregister from load balancer during shutdown
 *   app.get('/readyz', healthCheck({
 *       checks: {
 *           lifecycle: () => ({ healthy: app.lifecycleState === 'running' }),
 *       },
 *   }));
 */
function healthCheck(opts = {})
{
    const checks = opts.checks || {};
    const timeout = opts.timeout || 5000;
    const verbose = opts.verbose !== false;
    const onFailure = typeof opts.onFailure === 'function' ? opts.onFailure : null;

    return async (req, res) =>
    {
        const start = Date.now();

        // Check lifecycle state (auto-deregister during shutdown)
        const app = req.app;
        if (app && app.lifecycleState && app.lifecycleState !== 'running')
        {
            res.status(503).json({
                status: 'unavailable',
                reason: 'shutdown',
                lifecycleState: app.lifecycleState,
                timestamp: new Date().toISOString(),
            });
            return;
        }

        const checkNames = Object.keys(checks);
        const results = {};
        let allHealthy = true;

        if (checkNames.length > 0)
        {
            // Run all checks concurrently with timeout
            const promises = checkNames.map(async (name) =>
            {
                const checkStart = Date.now();
                try
                {
                    const result = await Promise.race([
                        Promise.resolve(checks[name]()),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Check timed out')), timeout)
                        ),
                    ]);

                    const duration = Date.now() - checkStart;

                    if (typeof result === 'boolean')
                    {
                        results[name] = { healthy: result, duration };
                    }
                    else if (result && typeof result === 'object')
                    {
                        results[name] = { healthy: !!result.healthy, duration };
                        if (verbose && result.details) results[name].details = result.details;
                    }
                    else
                    {
                        results[name] = { healthy: true, duration };
                    }
                }
                catch (err)
                {
                    results[name] = {
                        healthy: false,
                        duration: Date.now() - checkStart,
                        error: err.message,
                    };
                }

                if (!results[name].healthy) allHealthy = false;
            });

            await Promise.all(promises);
        }

        const body = {
            status: allHealthy ? 'healthy' : 'unhealthy',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            duration: Date.now() - start,
        };

        if (checkNames.length > 0) body.checks = results;

        if (!allHealthy && onFailure)
        {
            try { onFailure(results); }
            catch (_) { /* ignore callback errors */ }
        }

        res.status(allHealthy ? 200 : 503).json(body);
    };
}

// -- Convenience Health & Ready Factory ----------------------------

/**
 * Create paired liveness and readiness handlers for an app.
 * Liveness includes basic process checks; readiness includes
 * all registered dependency checks.
 *
 * @param {object} [opts] - Options.
 * @param {Object<string, Function>} [opts.checks] - Named readiness checks.
 * @param {boolean} [opts.includeMemory=false] - Include memory check in liveness.
 * @param {boolean} [opts.includeEventLoop=false] - Include event loop lag check.
 * @param {number} [opts.timeout=5000] - Check timeout.
 * @returns {{ health: Function, ready: Function }} Route handlers.
 *
 * @example
 *   const { health, ready } = createHealthHandlers({
 *       checks: { database: () => db.ping() },
 *       includeMemory: true,
 *   });
 *   app.get('/healthz', health);
 *   app.get('/readyz', ready);
 */
function createHealthHandlers(opts = {})
{
    const livenessChecks = {};
    if (opts.includeMemory) livenessChecks.memory = memoryCheck(opts.memoryOpts);
    if (opts.includeEventLoop) livenessChecks.eventLoop = eventLoopCheck(opts.eventLoopOpts);

    const readinessChecks = { ...livenessChecks };
    if (opts.checks)
    {
        for (const [name, fn] of Object.entries(opts.checks))
        {
            readinessChecks[name] = fn;
        }
    }

    return {
        health: healthCheck({ checks: livenessChecks, timeout: opts.timeout }),
        ready: healthCheck({ checks: readinessChecks, timeout: opts.timeout, onFailure: opts.onFailure }),
    };
}

module.exports = {
    healthCheck,
    createHealthHandlers,
    memoryCheck,
    eventLoopCheck,
    diskSpaceCheck,
};
