/**
 * @module lifecycle
 * @description Graceful shutdown manager for zero-http applications.
 *              Tracks active connections, drains in-flight requests, closes
 *              WebSocket and SSE connections, and shuts down ORM databases
 *              before exiting.
 *
 * @example
 *   const app = createApp();
 *   app.listen(3000);
 *
 *   // Automatic — SIGTERM/SIGINT handlers registered by listen()
 *   // Manual trigger:
 *   await app.shutdown();
 */
const log = require('./debug')('zero:lifecycle');

/**
 * Lifecycle states.
 * @enum {string}
 */
const LIFECYCLE_STATE = {
    RUNNING: 'running',
    DRAINING: 'draining',
    CLOSED: 'closed',
};

// -- Lifecycle Manager -------------------------

/**
 * Manages graceful shutdown for an App instance.
 * Tracks active HTTP connections and coordinates shutdown
 * across the server, WebSocket pools, SSE streams, and ORM databases.
 */
class LifecycleManager
{
    /**
     * @constructor
     * @param {import('./app')} app - The App instance to manage.
     */
    constructor(app)
    {
        /** @type {import('./app')} */
        this._app = app;

        /** @type {string} */
        this.state = LIFECYCLE_STATE.RUNNING;

        /** Active HTTP requests being processed. @type {Set<import('http').ServerResponse>} */
        this._activeRequests = new Set();

        /** Registered WebSocket pools for shutdown. @type {Set<import('./ws/room')>} */
        this._wsPools = new Set();

        /** Active SSE streams for shutdown. @type {Set<import('./sse/stream')>} */
        this._sseStreams = new Set();

        /** ORM Database instances for shutdown. @type {Set<import('./orm')>} */
        this._databases = new Set();

        /** Lifecycle event listeners. @type {Object<string, Function[]>} */
        this._listeners = {};

        /** Signal handler references for cleanup. @private */
        this._signalHandlers = {};

        /** Whether signal handlers have been installed. @private */
        this._signalsInstalled = false;

        /** @type {number} Default shutdown timeout in ms. */
        this._shutdownTimeout = 30000;

        /** Prevents duplicate shutdown calls. @private */
        this._shutdownPromise = null;
    }

    // -- Event Emitter ---------------------------------

    /**
     * Register a lifecycle event listener.
     *
     * @param {'beforeShutdown'|'shutdown'|'close'} event - Event name.
     * @param {Function} fn - Callback function.
     * @returns {LifecycleManager} this
     *
     * @example
     *   app.on('beforeShutdown', async () => {
     *       await flushMetrics();
     *   });
     *
     *   app.on('shutdown', () => {
     *       console.log('server shut down');
     *   });
     */
    on(event, fn)
    {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    /**
     * Remove a lifecycle event listener.
     *
     * @param {'beforeShutdown'|'shutdown'|'close'} event - Event name.
     * @param {Function} fn - Callback to remove.
     * @returns {LifecycleManager} this
     */
    off(event, fn)
    {
        const list = this._listeners[event];
        if (!list) return this;
        this._listeners[event] = list.filter(f => f !== fn);
        return this;
    }

    /**
     * Emit a lifecycle event, calling all registered listeners.
     * Awaits async listeners sequentially.
     * @private
     * @param {string} event - Event name.
     */
    async _emit(event)
    {
        const fns = this._listeners[event];
        if (!fns || fns.length === 0) return;
        for (const fn of fns.slice())
        {
            try { await fn(); }
            catch (err) { log.error('lifecycle %s listener error: %s', event, err.message); }
        }
    }

    // -- Connection Tracking ---------------------------

    /**
     * Track an active HTTP request. Called automatically by the App
     * request handler when lifecycle management is enabled.
     *
     * @param {import('http').ServerResponse} res - The raw response object.
     */
    trackRequest(res)
    {
        this._activeRequests.add(res);
        res.on('close', () => this._activeRequests.delete(res));
    }

    /**
     * Number of currently active HTTP requests.
     * @type {number}
     */
    get activeRequests()
    {
        return this._activeRequests.size;
    }

    /**
     * Register a WebSocket pool for graceful shutdown.
     * All connections in registered pools are closed with code `1001`
     * during shutdown.
     *
     * @param {import('./ws/room')} pool - WebSocket pool instance.
     * @returns {LifecycleManager} this
     *
     * @example
     *   const pool = new WebSocketPool();
     *   app.registerPool(pool);
     */
    registerPool(pool)
    {
        this._wsPools.add(pool);
        return this;
    }

    /**
     * Unregister a WebSocket pool.
     *
     * @param {import('./ws/room')} pool - WebSocket pool instance.
     * @returns {LifecycleManager} this
     */
    unregisterPool(pool)
    {
        this._wsPools.delete(pool);
        return this;
    }

    /**
     * Track an active SSE stream for graceful shutdown.
     *
     * @param {import('./sse/stream')} stream - SSE stream instance.
     * @returns {LifecycleManager} this
     */
    trackSSE(stream)
    {
        this._sseStreams.add(stream);
        stream.on('close', () => this._sseStreams.delete(stream));
        return this;
    }

    /**
     * Register an ORM Database instance for graceful shutdown.
     * The database connection is closed during shutdown.
     *
     * @param {import('./orm')} db - Database instance.
     * @returns {LifecycleManager} this
     *
     * @example
     *   const db = new Database({ adapter: 'sqlite', file: ':memory:' });
     *   app.registerDatabase(db);
     */
    registerDatabase(db)
    {
        this._databases.add(db);
        return this;
    }

    /**
     * Unregister an ORM Database instance.
     *
     * @param {import('./orm')} db - Database instance.
     * @returns {LifecycleManager} this
     */
    unregisterDatabase(db)
    {
        this._databases.delete(db);
        return this;
    }

    // -- Signal Handling -------------------------------

    /**
     * Install `SIGTERM` and `SIGINT` process signal handlers that trigger
     * graceful shutdown. Called automatically by `app.listen()`.
     * Safe to call multiple times — handlers are only installed once.
     */
    installSignalHandlers()
    {
        if (this._signalsInstalled) return;
        this._signalsInstalled = true;

        const handler = (signal) =>
        {
            log.info('received %s, starting graceful shutdown', signal);
            this.shutdown().then(() =>
            {
                process.exit(0);
            }).catch((err) =>
            {
                log.error('shutdown error: %s', err.message);
                process.exit(1);
            });
        };

        this._signalHandlers.SIGTERM = () => handler('SIGTERM');
        this._signalHandlers.SIGINT = () => handler('SIGINT');

        process.on('SIGTERM', this._signalHandlers.SIGTERM);
        process.on('SIGINT', this._signalHandlers.SIGINT);
    }

    /**
     * Remove previously installed signal handlers.
     * Called automatically during shutdown cleanup.
     */
    removeSignalHandlers()
    {
        if (!this._signalsInstalled) return;
        if (this._signalHandlers.SIGTERM)
        {
            process.removeListener('SIGTERM', this._signalHandlers.SIGTERM);
        }
        if (this._signalHandlers.SIGINT)
        {
            process.removeListener('SIGINT', this._signalHandlers.SIGINT);
        }
        this._signalHandlers = {};
        this._signalsInstalled = false;
    }

    // -- Shutdown Sequence -----------------------------

    /**
     * Perform a full graceful shutdown.
     *
     * Shutdown sequence:
     * 1. Emit `'beforeShutdown'` — run pre-shutdown hooks (flush metrics, etc.)
     * 2. Stop accepting new connections (server.close)
     * 3. Close all WebSocket connections with code `1001` (Going Away)
     * 4. Close all SSE streams
     * 5. Wait for in-flight HTTP requests to complete (with timeout)
     * 6. Close all registered ORM database connections
     * 7. Emit `'shutdown'` — final cleanup complete
     *
     * If in-flight requests do not complete within the configured
     * timeout (default 30s), they are forcefully terminated.
     *
     * @param {object} [opts] - Shutdown options.
     * @param {number} [opts.timeout] - Maximum ms to wait for in-flight requests. Overrides the configured default.
     * @returns {Promise<void>} Resolves when shutdown is complete.
     *
     * @example
     *   // With default timeout
     *   await app.shutdown();
     *
     *   // With custom timeout
     *   await app.shutdown({ timeout: 5000 });
     */
    async shutdown(opts = {})
    {
        // Deduplicate concurrent shutdown calls
        if (this._shutdownPromise) return this._shutdownPromise;
        if (this.state === LIFECYCLE_STATE.CLOSED) return;

        this._shutdownPromise = this._doShutdown(opts);
        return this._shutdownPromise;
    }

    /**
     * Internal shutdown implementation.
     * @private
     */
    async _doShutdown(opts)
    {
        const timeout = opts.timeout !== undefined ? opts.timeout : this._shutdownTimeout;
        log.info('graceful shutdown initiated (timeout=%dms)', timeout);

        // 1. beforeShutdown hooks
        this.state = LIFECYCLE_STATE.DRAINING;
        await this._emit('beforeShutdown');

        // 2. Stop accepting new connections (non-blocking — server.close
        //    only resolves after all existing connections end, so we don't
        //    await it here; it will resolve after the drain step finishes).
        const serverClosePromise = this._closeServer();

        // 3. Close WebSocket connections
        this._closeWebSockets();

        // 4. Close SSE streams
        this._closeSSEStreams();

        // 5. Drain in-flight requests (with timeout + force-close)
        await this._drainRequests(timeout);

        // 6. Wait for server to fully close (should be instant now that
        //    all connections are gone)
        await serverClosePromise;

        // 7. Close databases
        await this._closeDatabases();

        // 8. Cleanup signals
        this.removeSignalHandlers();

        this.state = LIFECYCLE_STATE.CLOSED;
        log.info('graceful shutdown complete');

        // 9. Final event
        await this._emit('shutdown');
    }

    /**
     * Stop the HTTP server from accepting new connections.
     * @private
     * @returns {Promise<void>}
     */
    _closeServer()
    {
        return new Promise((resolve) =>
        {
            const server = this._app._server;
            if (!server) { resolve(); return; }

            server.close((err) =>
            {
                if (err) log.warn('server close error: %s', err.message);
                resolve();
            });
        });
    }

    /**
     * Close all WebSocket connections across registered pools.
     * @private
     */
    _closeWebSockets()
    {
        let closed = 0;
        for (const pool of this._wsPools)
        {
            closed += pool.size;
            pool.closeAll(1001, 'Server shutdown');
        }
        if (closed > 0) log.info('closed %d WebSocket connections', closed);
    }

    /**
     * Close all tracked SSE streams.
     * @private
     */
    _closeSSEStreams()
    {
        let closed = 0;
        for (const stream of this._sseStreams)
        {
            if (stream.connected)
            {
                stream.close();
                closed++;
            }
        }
        this._sseStreams.clear();
        if (closed > 0) log.info('closed %d SSE streams', closed);
    }

    /**
     * Wait for all in-flight HTTP requests to complete, or force-close
     * after the timeout.
     * @private
     * @param {number} timeout - Max wait time in ms.
     * @returns {Promise<void>}
     */
    _drainRequests(timeout)
    {
        return new Promise((resolve) =>
        {
            if (this._activeRequests.size === 0)
            {
                log.debug('no active requests to drain');
                resolve();
                return;
            }

            log.info('draining %d active requests', this._activeRequests.size);

            let resolved = false;
            const done = () =>
            {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                resolve();
            };

            // Check periodically if all requests have completed
            const check = () =>
            {
                if (this._activeRequests.size === 0) done();
            };

            // Listen for request completions
            const interval = setInterval(() =>
            {
                check();
            }, 50);

            // Force-close after timeout
            const timer = setTimeout(() =>
            {
                clearInterval(interval);
                if (this._activeRequests.size > 0)
                {
                    log.warn('force-closing %d requests after %dms timeout', this._activeRequests.size, timeout);
                    for (const res of this._activeRequests)
                    {
                        try
                        {
                            if (!res.writableEnded) res.end();
                            if (res.socket && !res.socket.destroyed) res.socket.destroy();
                        }
                        catch (_) { /* socket may already be destroyed */ }
                    }
                    this._activeRequests.clear();
                }
                done();
            }, timeout);

            // Don't let timer/interval keep the process alive
            if (timer.unref) timer.unref();
            if (interval.unref) interval.unref();

            // Immediate check in case requests finished already
            check();
        });
    }

    /**
     * Close all registered ORM database connections.
     * @private
     */
    async _closeDatabases()
    {
        for (const db of this._databases)
        {
            try
            {
                if (typeof db.close === 'function') await db.close();
            }
            catch (err)
            {
                log.error('database close error: %s', err.message);
            }
        }
    }

    /**
     * Whether the server is currently draining (rejecting new requests).
     * @type {boolean}
     */
    get isDraining()
    {
        return this.state === LIFECYCLE_STATE.DRAINING;
    }

    /**
     * Whether the server has fully shut down.
     * @type {boolean}
     */
    get isClosed()
    {
        return this.state === LIFECYCLE_STATE.CLOSED;
    }
}

module.exports = { LifecycleManager, LIFECYCLE_STATE };
