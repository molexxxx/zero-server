/**
 * Coverage tests for lib/lifecycle.js — targets installSignalHandlers
 * callback branches (successful shutdown → exit(0), failed shutdown → exit(1)),
 * and shutdown error/edge paths.
 */
const { createApp, LifecycleManager, LIFECYCLE_STATE } = require('../../');

describe('LifecycleManager: installSignalHandlers coverage', () =>
{
    let app, lm;
    let signalHandlers;
    let origProcessOn, origProcessRemoveListener;

    beforeEach(() =>
    {
        app = createApp();
        lm = app._lifecycle;

        // Remove any auto-installed handlers
        lm.removeSignalHandlers();

        signalHandlers = {};
        origProcessOn = process.on.bind(process);
        origProcessRemoveListener = process.removeListener.bind(process);

        // Intercept signal registrations
        vi.spyOn(process, 'on').mockImplementation((event, fn) =>
        {
            signalHandlers[event] = fn;
            return process;
        });
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        lm.removeSignalHandlers();
    });

    it('installs SIGTERM and SIGINT handlers', () =>
    {
        lm.installSignalHandlers();

        expect(signalHandlers['SIGTERM']).toBeDefined();
        expect(signalHandlers['SIGINT']).toBeDefined();
        expect(lm._signalsInstalled).toBe(true);
    });

    it('does not install handlers twice', () =>
    {
        lm.installSignalHandlers();
        const first = signalHandlers['SIGTERM'];

        lm.installSignalHandlers();
        expect(signalHandlers['SIGTERM']).toBe(first);
    });

    it('SIGTERM handler triggers shutdown then exit(0)', async () =>
    {
        lm.shutdown = vi.fn().mockResolvedValue(undefined);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

        lm.installSignalHandlers();
        signalHandlers['SIGTERM']();
        await new Promise(r => setTimeout(r, 10));

        expect(lm.shutdown).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('SIGINT handler triggers shutdown then exit(0)', async () =>
    {
        lm.shutdown = vi.fn().mockResolvedValue(undefined);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

        lm.installSignalHandlers();
        signalHandlers['SIGINT']();
        await new Promise(r => setTimeout(r, 10));

        expect(lm.shutdown).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('signal handler exits with 1 when shutdown rejects', async () =>
    {
        lm.shutdown = vi.fn().mockRejectedValue(new Error('shutdown failed'));
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

        lm.installSignalHandlers();
        signalHandlers['SIGTERM']();
        // Handler uses .then()/.catch() — flush microtasks
        await new Promise(r => setTimeout(r, 10));

        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe('LifecycleManager: shutdown edge paths', () =>
{
    it('shutdown is deduplicated (concurrent calls resolve together)', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const p1 = lm.shutdown({ timeout: 50 });
        const p2 = lm.shutdown({ timeout: 50 });

        // Both should resolve without error
        await Promise.all([p1, p2]);
        expect(lm.state).toBe(LIFECYCLE_STATE.CLOSED);
    });

    it('shutdown returns immediately if already CLOSED', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        lm.state = LIFECYCLE_STATE.CLOSED;
        const result = await lm.shutdown();
        expect(result).toBeUndefined();
    });

    it('removeSignalHandlers is safe to call when not installed', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        lm.removeSignalHandlers();
        // No crash
    });

    it('registerPool and unregisterPool work', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        const pool = { size: 0, closeAll: vi.fn() };

        lm.registerPool(pool);
        expect(lm._wsPools.has(pool)).toBe(true);

        lm.unregisterPool(pool);
        expect(lm._wsPools.has(pool)).toBe(false);
    });

    it('registerDatabase and unregisterDatabase work', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        const db = { close: vi.fn() };

        lm.registerDatabase(db);
        expect(lm._databases.has(db)).toBe(true);

        lm.unregisterDatabase(db);
        expect(lm._databases.has(db)).toBe(false);
    });

    it('registerGrpc stores registry', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        const reg = { drain: vi.fn() };

        lm.registerGrpc(reg);
        expect(lm._grpcRegistry).toBe(reg);
    });

    it('_closeDatabases handles close() errors gracefully', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        const db = { close: vi.fn().mockRejectedValue(new Error('db close fail')) };

        lm.registerDatabase(db);
        // Should not throw
        await lm._closeDatabases();
        expect(db.close).toHaveBeenCalled();
    });

    it('_closeServer resolves when no server', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        lm._app._server = null;

        await lm._closeServer();
        // No error
    });

    it('_closeServer resolves with server close error', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        lm._app._server = {
            close: (cb) => cb(new Error('close err')),
        };

        await lm._closeServer();
        // Should not throw
    });

    it('_drainGrpc does nothing when no registry', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        lm._grpcRegistry = null;

        await lm._drainGrpc(1000);
        // No error
    });

    it('_drainGrpc calls registry.drain', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        const reg = { drain: vi.fn().mockResolvedValue(undefined) };
        lm._grpcRegistry = reg;

        await lm._drainGrpc(5000);
        expect(reg.drain).toHaveBeenCalledWith(5000);
    });
});

describe('LifecycleManager: trackSSE', () =>
{
    it('tracks and auto-removes SSE stream on close', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        let closeHandler;
        const stream = {
            on: (event, fn) => { if (event === 'close') closeHandler = fn; },
            connected: true,
            close: vi.fn(),
        };

        lm.trackSSE(stream);
        expect(lm._sseStreams.has(stream)).toBe(true);

        closeHandler();
        expect(lm._sseStreams.has(stream)).toBe(false);
    });
});

describe('LifecycleManager: _closeSSEStreams branches', () =>
{
    it('closes connected streams and skips disconnected', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const connected = { connected: true, close: vi.fn(), on: vi.fn() };
        const disconnected = { connected: false, close: vi.fn(), on: vi.fn() };
        lm._sseStreams.add(connected);
        lm._sseStreams.add(disconnected);

        lm._closeSSEStreams();

        expect(connected.close).toHaveBeenCalled();
        expect(disconnected.close).not.toHaveBeenCalled();
        expect(lm._sseStreams.size).toBe(0);
    });
});

describe('LifecycleManager: _closeWebSockets', () =>
{
    it('closes all pools and logs count', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const pool = { size: 3, closeAll: vi.fn() };
        lm._wsPools.add(pool);

        lm._closeWebSockets();

        expect(pool.closeAll).toHaveBeenCalledWith(1001, 'Server shutdown');
    });
});

describe('LifecycleManager: removeSignalHandlers edge cases', () =>
{
    it('removeSignalHandlers with only SIGTERM handler', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        lm._signalsInstalled = true;
        lm._signalHandlers = { SIGTERM: () => {} };

        // Should not throw — SIGINT is undefined
        lm.removeSignalHandlers();
        expect(lm._signalsInstalled).toBe(false);
    });

    it('removeSignalHandlers with only SIGINT handler', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        lm._signalsInstalled = true;
        lm._signalHandlers = { SIGINT: () => {} };

        lm.removeSignalHandlers();
        expect(lm._signalsInstalled).toBe(false);
    });

    it('removeSignalHandlers with no handlers object', () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        lm._signalsInstalled = true;
        lm._signalHandlers = {};

        lm.removeSignalHandlers();
        expect(lm._signalsInstalled).toBe(false);
    });
});

describe('LifecycleManager: _doShutdown opts.timeout', () =>
{
    it('uses default _shutdownTimeout when opts.timeout is undefined', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        lm._shutdownTimeout = 100;

        await lm.shutdown({}); // no timeout in opts → uses _shutdownTimeout
        expect(lm.state).toBe(LIFECYCLE_STATE.CLOSED);
    });

    it('uses opts.timeout=0 when provided (falsy but defined)', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;
        lm._shutdownTimeout = 30000;

        await lm.shutdown({ timeout: 0 }); // timeout=0 is defined
        expect(lm.state).toBe(LIFECYCLE_STATE.CLOSED);
    });
});

describe('LifecycleManager: _drainRequests force-close branches', () =>
{
    it('force-closes requests when timeout elapses', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const mockRes = {
            writableEnded: false,
            end: vi.fn(),
            socket: { destroyed: false, destroy: vi.fn() },
            on: vi.fn(),
        };
        lm._activeRequests.add(mockRes);

        await lm._drainRequests(10); // 10ms timeout

        expect(mockRes.end).toHaveBeenCalled();
        expect(mockRes.socket.destroy).toHaveBeenCalled();
    });

    it('skips .end() when writableEnded is true', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const mockRes = {
            writableEnded: true,
            end: vi.fn(),
            socket: { destroyed: false, destroy: vi.fn() },
            on: vi.fn(),
        };
        lm._activeRequests.add(mockRes);

        await lm._drainRequests(10);

        expect(mockRes.end).not.toHaveBeenCalled();
        expect(mockRes.socket.destroy).toHaveBeenCalled();
    });

    it('skips socket.destroy when socket is already destroyed', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const mockRes = {
            writableEnded: false,
            end: vi.fn(),
            socket: { destroyed: true, destroy: vi.fn() },
            on: vi.fn(),
        };
        lm._activeRequests.add(mockRes);

        await lm._drainRequests(10);

        expect(mockRes.end).toHaveBeenCalled();
        expect(mockRes.socket.destroy).not.toHaveBeenCalled();
    });

    it('handles res with no socket', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const mockRes = {
            writableEnded: false,
            end: vi.fn(),
            socket: null,
            on: vi.fn(),
        };
        lm._activeRequests.add(mockRes);

        await lm._drainRequests(10);

        expect(mockRes.end).toHaveBeenCalled();
    });

    it('handles errors in force-close gracefully', async () =>
    {
        const app = createApp();
        const lm = app._lifecycle;

        const mockRes = {
            writableEnded: false,
            end: vi.fn(() => { throw new Error('already destroyed'); }),
            socket: null,
            on: vi.fn(),
        };
        lm._activeRequests.add(mockRes);

        // Should not throw
        await lm._drainRequests(10);
    });
});
