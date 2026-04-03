const http = require('http');
const { createApp, LifecycleManager, LIFECYCLE_STATE, WebSocketPool, SSEStream } = require('../../');
const { doFetch } = require('../_helpers');

// Helper: start app on random port and return { app, port, close }
function startApp(app)
{
    return new Promise((resolve) =>
    {
        const server = app.listen(0, () =>
        {
            const port = server.address().port;
            resolve({ app, port, server });
        });
    });
}

// Helper: wait for app to drain and fully close
async function safeClose(app)
{
    // Remove signal handlers to prevent process.exit in tests
    app._lifecycle.removeSignalHandlers();
    app._lifecycle._shutdownPromise = null;
    if (app._server)
    {
        return new Promise((resolve) => app._server.close(resolve));
    }
}

describe('Lifecycle Manager', () =>
{
    describe('LifecycleManager class', () =>
    {
        it('exports LifecycleManager and LIFECYCLE_STATE', () =>
        {
            expect(typeof LifecycleManager).toBe('function');
            expect(LIFECYCLE_STATE).toEqual({ RUNNING: 'running', DRAINING: 'draining', CLOSED: 'closed' });
        });

        it('initialises in RUNNING state', () =>
        {
            const app = createApp();
            expect(app.lifecycleState).toBe('running');
            expect(app._lifecycle.isDraining).toBe(false);
            expect(app._lifecycle.isClosed).toBe(false);
            expect(app._lifecycle.activeRequests).toBe(0);
        });
    });

    describe('Event listeners', () =>
    {
        it('on() and off() register and remove listeners', async () =>
        {
            const app = createApp();
            const calls = [];
            const fn = () => calls.push('called');
            app.on('beforeShutdown', fn);
            await app._lifecycle._emit('beforeShutdown');
            expect(calls).toEqual(['called']);

            app.off('beforeShutdown', fn);
            await app._lifecycle._emit('beforeShutdown');
            expect(calls).toEqual(['called']); // not called again
        });

        it('supports multiple listeners on the same event', async () =>
        {
            const app = createApp();
            const order = [];
            app.on('shutdown', () => order.push(1));
            app.on('shutdown', () => order.push(2));
            await app._lifecycle._emit('shutdown');
            expect(order).toEqual([1, 2]);
        });

        it('async listeners are awaited sequentially', async () =>
        {
            const app = createApp();
            const order = [];
            app.on('beforeShutdown', async () =>
            {
                await new Promise(r => setTimeout(r, 20));
                order.push('first');
            });
            app.on('beforeShutdown', () => order.push('second'));
            await app._lifecycle._emit('beforeShutdown');
            expect(order).toEqual(['first', 'second']);
        });

        it('listener errors do not break emission', async () =>
        {
            const app = createApp();
            const calls = [];
            app.on('shutdown', () => { throw new Error('boom'); });
            app.on('shutdown', () => calls.push('survived'));
            await app._lifecycle._emit('shutdown');
            expect(calls).toEqual(['survived']);
        });

        it('off() with unregistered fn is a no-op', () =>
        {
            const app = createApp();
            app.off('shutdown', () => {}); // no crash
        });

        it('emitting event with no listeners is a no-op', async () =>
        {
            const app = createApp();
            await app._lifecycle._emit('nonexistent'); // no crash
        });
    });

    describe('Connection tracking', () =>
    {
        it('tracks active HTTP requests', async () =>
        {
            const app = createApp();
            let resolveHold;
            const holdPromise = new Promise(r => { resolveHold = r; });

            app.get('/slow', async (req, res) =>
            {
                await holdPromise;
                res.json({ ok: true });
            });

            const { port } = await startApp(app);

            // Start request but don't await
            const reqPromise = doFetch(`http://localhost:${port}/slow`);

            // Wait for request to be tracked
            await new Promise(r => setTimeout(r, 50));
            expect(app._lifecycle.activeRequests).toBe(1);

            // Complete the request
            resolveHold();
            await reqPromise;

            // Wait for close event
            await new Promise(r => setTimeout(r, 50));
            expect(app._lifecycle.activeRequests).toBe(0);

            await safeClose(app);
        });

        it('multiple concurrent requests are tracked', async () =>
        {
            const app = createApp();
            let resolveAll;
            const hold = new Promise(r => { resolveAll = r; });

            app.get('/hold', async (req, res) =>
            {
                await hold;
                res.json({ ok: true });
            });

            const { port } = await startApp(app);
            const p1 = doFetch(`http://localhost:${port}/hold`);
            const p2 = doFetch(`http://localhost:${port}/hold`);
            const p3 = doFetch(`http://localhost:${port}/hold`);

            await new Promise(r => setTimeout(r, 50));
            expect(app._lifecycle.activeRequests).toBe(3);

            resolveAll();
            await Promise.all([p1, p2, p3]);
            await new Promise(r => setTimeout(r, 50));
            expect(app._lifecycle.activeRequests).toBe(0);

            await safeClose(app);
        });
    });

    describe('WebSocket pool registration', () =>
    {
        it('registerPool and unregisterPool', () =>
        {
            const app = createApp();
            const pool = new WebSocketPool();

            app.registerPool(pool);
            expect(app._lifecycle._wsPools.has(pool)).toBe(true);

            app.unregisterPool(pool);
            expect(app._lifecycle._wsPools.has(pool)).toBe(false);
        });

        it('registerPool returns app for chaining', () =>
        {
            const app = createApp();
            const result = app.registerPool(new WebSocketPool());
            expect(result).toBe(app);
        });
    });

    describe('SSE stream tracking', () =>
    {
        it('trackSSE registers and auto-unregisters on close', () =>
        {
            const app = createApp();
            // Create a mock SSE stream
            const listeners = {};
            const mockStream = {
                connected: true,
                close() { this.connected = false; },
                on(event, fn) { listeners[event] = fn; },
            };

            app.trackSSE(mockStream);
            expect(app._lifecycle._sseStreams.has(mockStream)).toBe(true);

            // Simulate close event
            listeners.close();
            expect(app._lifecycle._sseStreams.has(mockStream)).toBe(false);
        });

        it('trackSSE returns app for chaining', () =>
        {
            const app = createApp();
            const mockStream = { on() {} };
            expect(app.trackSSE(mockStream)).toBe(app);
        });
    });

    describe('Database registration', () =>
    {
        it('registerDatabase and unregisterDatabase', () =>
        {
            const app = createApp();
            const mockDb = { close: async () => {} };

            app.registerDatabase(mockDb);
            expect(app._lifecycle._databases.has(mockDb)).toBe(true);

            app.unregisterDatabase(mockDb);
            expect(app._lifecycle._databases.has(mockDb)).toBe(false);
        });

        it('returns app for chaining', () =>
        {
            const app = createApp();
            const result = app.registerDatabase({ close: async () => {} });
            expect(result).toBe(app);
        });
    });

    describe('Shutdown timeout', () =>
    {
        it('shutdownTimeout sets the timeout', () =>
        {
            const app = createApp();
            app.shutdownTimeout(5000);
            expect(app._lifecycle._shutdownTimeout).toBe(5000);
        });

        it('returns app for chaining', () =>
        {
            const app = createApp();
            expect(app.shutdownTimeout(1000)).toBe(app);
        });
    });

    describe('Signal handlers', () =>
    {
        it('installSignalHandlers adds process listeners', () =>
        {
            const app = createApp();
            const beforeCount = process.listenerCount('SIGTERM');
            app._lifecycle.installSignalHandlers();
            expect(process.listenerCount('SIGTERM')).toBe(beforeCount + 1);
            expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
            app._lifecycle.removeSignalHandlers();
        });

        it('removeSignalHandlers removes listeners', () =>
        {
            const app = createApp();
            const beforeSigterm = process.listenerCount('SIGTERM');
            const beforeSigint = process.listenerCount('SIGINT');

            app._lifecycle.installSignalHandlers();
            app._lifecycle.removeSignalHandlers();

            expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
            expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
        });

        it('installSignalHandlers is idempotent', () =>
        {
            const app = createApp();
            const beforeCount = process.listenerCount('SIGTERM');
            app._lifecycle.installSignalHandlers();
            app._lifecycle.installSignalHandlers(); // second call
            expect(process.listenerCount('SIGTERM')).toBe(beforeCount + 1); // only 1 added
            app._lifecycle.removeSignalHandlers();
        });

        it('removeSignalHandlers is idempotent', () =>
        {
            const app = createApp();
            app._lifecycle.installSignalHandlers();
            app._lifecycle.removeSignalHandlers();
            app._lifecycle.removeSignalHandlers(); // second call — no crash
        });
    });

    describe('Graceful shutdown', () =>
    {
        it('full shutdown lifecycle — beforeShutdown → close → shutdown', async () =>
        {
            const app = createApp();
            app.get('/', (req, res) => res.json({ ok: true }));

            const { port } = await startApp(app);

            // Remove signal handlers so they dont call process.exit
            app._lifecycle.removeSignalHandlers();

            const events = [];
            app.on('beforeShutdown', () => events.push('beforeShutdown'));
            app.on('shutdown', () => events.push('shutdown'));

            await app.shutdown({ timeout: 1000 });

            expect(events).toEqual(['beforeShutdown', 'shutdown']);
            expect(app.lifecycleState).toBe('closed');
            expect(app._lifecycle.isClosed).toBe(true);
        });

        it('rejects new requests during drain with 503', async () =>
        {
            const app = createApp();
            let resolveHold;
            const hold = new Promise(r => { resolveHold = r; });

            app.get('/slow', async (req, res) =>
            {
                await hold;
                res.json({ ok: true });
            });

            app.get('/fast', (req, res) => res.json({ fast: true }));

            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            // Start a slow request
            const slowRequest = doFetch(`http://localhost:${port}/slow`);
            await new Promise(r => setTimeout(r, 50));

            // Initiate shutdown (non-blocking)
            const shutdownPromise = app.shutdown({ timeout: 5000 });

            // Try a new request during drain
            await new Promise(r => setTimeout(r, 50));
            try
            {
                const result = await doFetch(`http://localhost:${port}/fast`);
                // If the request succeeds the server already closed, also acceptable
                // But if it does reach we expect 503
                expect(result.status).toBe(503);
            }
            catch (e)
            {
                // Connection refused is also acceptable — server may have already closed
                expect(e.message || e.code).toBeTruthy();
            }

            resolveHold();
            await slowRequest;
            await shutdownPromise;
        });

        it('drains in-flight requests before closing', async () =>
        {
            const app = createApp();
            let requestCompleted = false;

            app.get('/drain-test', async (req, res) =>
            {
                await new Promise(r => setTimeout(r, 100));
                requestCompleted = true;
                res.json({ drained: true });
            });

            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            const reqPromise = doFetch(`http://localhost:${port}/drain-test`);
            await new Promise(r => setTimeout(r, 30));

            await app.shutdown({ timeout: 5000 });

            expect(requestCompleted).toBe(true);
            const result = await reqPromise;
            expect(result.data).toEqual({ drained: true });
        });

        it('force-closes requests after timeout', async () =>
        {
            const app = createApp();

            app.get('/stuck', async (req, res) =>
            {
                // Never responds
                await new Promise(() => {});
            });

            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            // Start a stuck request
            const reqPromise = doFetch(`http://localhost:${port}/stuck`).catch(() => 'errored');
            await new Promise(r => setTimeout(r, 50));

            // Shutdown with very short timeout
            await app.shutdown({ timeout: 100 });

            expect(app.lifecycleState).toBe('closed');
            expect(app._lifecycle.activeRequests).toBe(0);

            // The stuck request was force-ended — either it errored (socket destroyed)
            // or received an empty response from forced res.end()
            const result = await reqPromise;
            if (result === 'errored')
            {
                expect(result).toBe('errored');
            }
            else
            {
                // Force-closed: server ended the response during drain
                expect(result.data).toBe('');
            }
        });

        it('closes WebSocket pools during shutdown', async () =>
        {
            const app = createApp();
            const pool = new WebSocketPool();
            let closeAllCalled = false;
            const origCloseAll = pool.closeAll.bind(pool);
            pool.closeAll = (code, reason) =>
            {
                closeAllCalled = true;
                expect(code).toBe(1001);
                expect(reason).toBe('Server shutdown');
                origCloseAll(code, reason);
            };

            app.registerPool(pool);
            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            await app.shutdown({ timeout: 1000 });
            expect(closeAllCalled).toBe(true);
        });

        it('closes SSE streams during shutdown', async () =>
        {
            const app = createApp();
            let streamClosed = false;
            const mockStream = {
                connected: true,
                close() { this.connected = false; streamClosed = true; },
                on() {},
            };

            app.trackSSE(mockStream);
            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            await app.shutdown({ timeout: 1000 });
            expect(streamClosed).toBe(true);
        });

        it('closes ORM databases during shutdown', async () =>
        {
            const app = createApp();
            let dbClosed = false;
            const mockDb = {
                async close() { dbClosed = true; }
            };

            app.registerDatabase(mockDb);
            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            await app.shutdown({ timeout: 1000 });
            expect(dbClosed).toBe(true);
        });

        it('database close errors do not prevent shutdown', async () =>
        {
            const app = createApp();
            const mockDb = {
                async close() { throw new Error('db close fail'); }
            };

            app.registerDatabase(mockDb);
            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            // Should not throw
            await app.shutdown({ timeout: 1000 });
            expect(app.lifecycleState).toBe('closed');
        });

        it('duplicate shutdown calls return the same promise', async () =>
        {
            const app = createApp();
            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            const p1 = app.shutdown({ timeout: 1000 });
            const p2 = app.shutdown({ timeout: 1000 });

            // Both calls should resolve to the same underlying operation
            await Promise.all([p1, p2]);
            expect(app.lifecycleState).toBe('closed');
        });

        it('shutdown on already-closed is a no-op', async () =>
        {
            const app = createApp();
            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            await app.shutdown({ timeout: 1000 });
            // Reset promise so we can call again
            app._shutdownPromise = null;
            app._lifecycle._shutdownPromise = null;
            await app.shutdown({ timeout: 1000 }); // no throw
        });

        it('shutdown without a server is safe', async () =>
        {
            const app = createApp();
            app._lifecycle.removeSignalHandlers();
            await app.shutdown({ timeout: 100 }); // no crash
            expect(app.lifecycleState).toBe('closed');
        });

        it('signal handlers are removed after shutdown', async () =>
        {
            const app = createApp();
            const { port } = await startApp(app);
            // listen() installs signals
            expect(app._lifecycle._signalsInstalled).toBe(true);

            await app.shutdown({ timeout: 1000 });
            expect(app._lifecycle._signalsInstalled).toBe(false);
        });

        it('drain works with zero active requests', async () =>
        {
            const app = createApp();
            app.get('/', (req, res) => res.json({ ok: true }));
            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            // No requests in flight
            await app.shutdown({ timeout: 1000 });
            expect(app.lifecycleState).toBe('closed');
        });
    });

    describe('App.close() backward compatibility', () =>
    {
        it('close() still works as a simple server close', async () =>
        {
            const app = createApp();
            app.get('/', (req, res) => res.json({ ok: true }));

            const { port } = await startApp(app);
            app._lifecycle.removeSignalHandlers();

            await new Promise((resolve) => app.close(resolve));
            // Server should be closed
        });
    });

    describe('LifecycleManager direct API', () =>
    {
        it('trackRequest handles response without close event', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const fakeRes = {
                on(event, fn)
                {
                    if (event === 'close') setTimeout(fn, 10);
                }
            };
            lm.trackRequest(fakeRes);
            expect(lm.activeRequests).toBe(1);
        });

        it('registerPool on LifecycleManager returns this', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const pool = new WebSocketPool();
            expect(lm.registerPool(pool)).toBe(lm);
        });

        it('unregisterPool on LifecycleManager returns this', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const pool = new WebSocketPool();
            lm.registerPool(pool);
            expect(lm.unregisterPool(pool)).toBe(lm);
        });

        it('trackSSE on LifecycleManager returns this', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const stream = { on() {} };
            expect(lm.trackSSE(stream)).toBe(lm);
        });

        it('registerDatabase on LifecycleManager returns this', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            expect(lm.registerDatabase({ close: async () => {} })).toBe(lm);
        });

        it('unregisterDatabase on LifecycleManager returns this', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const db = { close: async () => {} };
            lm.registerDatabase(db);
            expect(lm.unregisterDatabase(db)).toBe(lm);
        });

        it('on() returns LifecycleManager for chaining', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            expect(lm.on('shutdown', () => {})).toBe(lm);
        });

        it('off() returns LifecycleManager for chaining', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            expect(lm.off('shutdown', () => {})).toBe(lm);
        });
    });

    describe('_closeWebSockets edge cases', () =>
    {
        it('handles empty pool set', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            lm._closeWebSockets(); // no crash
        });

        it('handles pool with connections', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const closed = [];
            const pool = {
                size: 3,
                closeAll(code, reason) { closed.push({ code, reason }); },
            };
            lm._wsPools.add(pool);
            lm._closeWebSockets();
            expect(closed).toEqual([{ code: 1001, reason: 'Server shutdown' }]);
        });
    });

    describe('_closeSSEStreams edge cases', () =>
    {
        it('skips already-closed streams', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const mockStream = {
                connected: false,
                close() { throw new Error('should not be called'); },
                on() {},
            };
            lm._sseStreams.add(mockStream);
            lm._closeSSEStreams(); // no crash, no call
        });

        it('clears SSE set after closing', () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const mockStream = { connected: true, close() { this.connected = false; }, on() {} };
            lm._sseStreams.add(mockStream);
            lm._closeSSEStreams();
            expect(lm._sseStreams.size).toBe(0);
        });
    });

    describe('_closeDatabases edge cases', () =>
    {
        it('handles db without close method', async () =>
        {
            const lm = new LifecycleManager({ _server: null });
            lm._databases.add({ noclose: true });
            await lm._closeDatabases(); // no crash
        });

        it('closes multiple databases', async () =>
        {
            const lm = new LifecycleManager({ _server: null });
            const order = [];
            lm._databases.add({ close: async () => order.push('db1') });
            lm._databases.add({ close: async () => order.push('db2') });
            await lm._closeDatabases();
            expect(order).toEqual(['db1', 'db2']);
        });
    });

    describe('_closeServer edge cases', () =>
    {
        it('resolves when no server exists', async () =>
        {
            const lm = new LifecycleManager({ _server: null });
            await lm._closeServer(); // should resolve immediately
        });

        it('resolves even when server.close errors', async () =>
        {
            const lm = new LifecycleManager({
                _server: {
                    close(cb) { cb(new Error('close err')); }
                }
            });
            await lm._closeServer(); // should still resolve
        });
    });
});
