/**
 * Coverage tests for lib/cluster.js — targets uncovered statements,
 * branches, and functions in fork() exit handler, reload(), clusterize(),
 * and _waitForAllWorkers().
 */
const cluster = require('cluster');
const { EventEmitter } = require('events');
const { ClusterManager, clusterize, _defaultIpHash } = require('../../lib/cluster');

// =========================================================
// fork() — cluster.on('exit') handler branches
// =========================================================

describe('ClusterManager: fork() exit handler', () =>
{
    let origFork, origOn, exitHandlers, messageHandlers;

    beforeEach(() =>
    {
        origFork = cluster.fork;
        origOn = cluster.on;
        exitHandlers = [];
        messageHandlers = [];

        let workerId = 0;
        cluster.fork = () =>
        {
            workerId++;
            const w = {
                id: workerId,
                process: { pid: 10000 + workerId },
                isDead: () => false,
                send: vi.fn(),
                disconnect: vi.fn(),
                kill: vi.fn(),
                once: vi.fn(),
            };
            return w;
        };

        cluster.on = (event, fn) =>
        {
            if (event === 'exit') exitHandlers.push(fn);
            if (event === 'message') messageHandlers.push(fn);
        };
    });

    afterEach(() =>
    {
        cluster.fork = origFork;
        cluster.on = origOn;
    });

    it('fork() spawns workers and registers exit + message listeners', () =>
    {
        const mgr = new ClusterManager({ workers: 2 });
        mgr.fork();

        expect(mgr._workers.size).toBe(2);
        expect(mgr._started).toBe(true);
        expect(exitHandlers.length).toBe(1);
        expect(messageHandlers.length).toBe(1);
    });

    it('exit handler removes worker and logs during shutdown', () =>
    {
        const mgr = new ClusterManager({ workers: 1 });
        mgr.fork();

        const worker = mgr._workers.get(1);
        mgr._shuttingDown = true;

        // Simulate worker exit during shutdown
        exitHandlers[0](worker, 0, null);
        expect(mgr._workers.has(1)).toBe(false);
    });

    it('exit handler logs signal kill', () =>
    {
        const mgr = new ClusterManager({ workers: 1 });
        mgr.fork();

        const worker = mgr._workers.get(1);

        // Simulate worker killed by signal (not shutdown, no respawn since signal)
        mgr._opts.respawn = false;
        exitHandlers[0](worker, 0, 'SIGKILL');
        expect(mgr._workers.has(1)).toBe(false);
    });

    it('exit handler logs non-zero exit code', () =>
    {
        const mgr = new ClusterManager({ workers: 1, respawn: false });
        mgr.fork();

        const worker = mgr._workers.get(1);
        exitHandlers[0](worker, 1, null);
        expect(mgr._workers.has(1)).toBe(false);
    });

    it('exit handler logs clean exit', () =>
    {
        const mgr = new ClusterManager({ workers: 1, respawn: false });
        mgr.fork();

        const worker = mgr._workers.get(1);
        exitHandlers[0](worker, 0, null);
        expect(mgr._workers.has(1)).toBe(false);
    });

    it('exit handler respawns on crash with backoff', () =>
    {
        vi.useFakeTimers();
        const mgr = new ClusterManager({ workers: 1, respawn: true, respawnDelay: 100, backoffFactor: 2, maxRespawnDelay: 5000 });
        mgr.fork();

        const worker = mgr._workers.get(1);
        const originalSize = mgr._workers.size;

        // Simulate crash (non-zero exit)
        exitHandlers[0](worker, 1, null);

        // Worker removed, respawn scheduled
        expect(mgr._workers.size).toBe(originalSize - 1);

        // Advance timer to trigger respawn
        vi.advanceTimersByTime(200);

        // New worker should be spawned
        expect(mgr._workers.size).toBe(1);

        vi.useRealTimers();
    });

    it('exit handler does not respawn if shuttingDown becomes true before timer', () =>
    {
        vi.useFakeTimers();
        const mgr = new ClusterManager({ workers: 1, respawn: true, respawnDelay: 100 });
        mgr.fork();

        const worker = mgr._workers.get(1);
        exitHandlers[0](worker, 1, null);

        // Set shuttingDown before timer fires
        mgr._shuttingDown = true;
        vi.advanceTimersByTime(200);

        // No respawn
        expect(mgr._workers.size).toBe(0);

        vi.useRealTimers();
    });

    it('exit handler does not respawn when exit code is 0', () =>
    {
        vi.useFakeTimers();
        const mgr = new ClusterManager({ workers: 1, respawn: true, respawnDelay: 100 });
        mgr.fork();

        const worker = mgr._workers.get(1);
        exitHandlers[0](worker, 0, null);

        vi.advanceTimersByTime(200);
        // No respawn for clean exit
        expect(mgr._workers.size).toBe(0);

        vi.useRealTimers();
    });

    it('exit handler respawns with increasing backoff', () =>
    {
        vi.useFakeTimers();
        const mgr = new ClusterManager({ workers: 1, respawn: true, respawnDelay: 100, backoffFactor: 2, maxRespawnDelay: 1000 });
        mgr.fork();

        const worker = mgr._workers.get(1);

        // Set crash count for worker
        mgr._crashCounts.set(worker.id, 3);
        exitHandlers[0](worker, 1, null);

        // Delay = min(100 * 2^3, 1000) = min(800, 1000) = 800
        vi.advanceTimersByTime(100);
        expect(mgr._workers.size).toBe(0); // not yet

        vi.advanceTimersByTime(700);
        expect(mgr._workers.size).toBe(1); // spawned after 800ms

        vi.useRealTimers();
    });

    it('exit handler caps backoff at maxRespawnDelay', () =>
    {
        vi.useFakeTimers();
        const mgr = new ClusterManager({ workers: 1, respawn: true, respawnDelay: 100, backoffFactor: 2, maxRespawnDelay: 500 });
        mgr.fork();

        const worker = mgr._workers.get(1);
        mgr._crashCounts.set(worker.id, 10); // very high crash count
        exitHandlers[0](worker, 1, null);

        // delay capped at 500
        vi.advanceTimersByTime(500);
        expect(mgr._workers.size).toBe(1);

        vi.useRealTimers();
    });

    it('message handler relays _zhttp messages to _handleMessage', () =>
    {
        const mgr = new ClusterManager({ workers: 1 });
        const fn = vi.fn();
        mgr.onMessage('test-relay', fn);
        mgr.fork();

        const worker = mgr._workers.get(1);
        // Simulate IPC message from worker
        messageHandlers[0](worker, { _zhttp: true, type: 'test-relay', data: { x: 1 } });
        expect(fn).toHaveBeenCalledWith({ x: 1 }, worker);
    });

    it('message handler ignores non-_zhttp messages', () =>
    {
        const mgr = new ClusterManager({ workers: 1 });
        const fn = vi.fn();
        mgr.onMessage('test', fn);
        mgr.fork();

        const worker = mgr._workers.get(1);
        messageHandlers[0](worker, { type: 'test', data: {} });
        messageHandlers[0](worker, 'string message');
        messageHandlers[0](worker, null);
        expect(fn).not.toHaveBeenCalled();
    });
});

// =========================================================
// reload() — rolling restart
// =========================================================

describe('ClusterManager: reload()', () =>
{
    let origFork, origOn;

    beforeEach(() =>
    {
        origFork = cluster.fork;
        origOn = cluster.on;
        cluster.on = vi.fn();
    });

    afterEach(() =>
    {
        cluster.fork = origFork;
        cluster.on = origOn;
    });

    it('reload replaces each worker sequentially', async () =>
    {
        const mgr = new ClusterManager({ workers: 2 });
        let workerId = 10;

        cluster.fork = () =>
        {
            workerId++;
            const w = {
                id: workerId,
                process: { pid: 20000 + workerId },
                isDead: () => false,
                send: vi.fn(),
                disconnect: vi.fn(),
                kill: vi.fn(),
                once: vi.fn((event, cb) =>
                {
                    // Auto-resolve listening / exit
                    if (event === 'listening') setTimeout(cb, 5);
                    if (event === 'exit') setTimeout(cb, 5);
                }),
            };
            return w;
        };

        // Manually set up workers (skip actual fork)
        const old1 = { id: 1, isDead: () => false, disconnect: vi.fn(), once: vi.fn((e, cb) => { if (e === 'exit') setTimeout(cb, 5); }), send: vi.fn() };
        const old2 = { id: 2, isDead: () => false, disconnect: vi.fn(), once: vi.fn((e, cb) => { if (e === 'exit') setTimeout(cb, 5); }), send: vi.fn() };
        mgr._workers.set(1, old1);
        mgr._workers.set(2, old2);

        await mgr.reload();

        // Old workers should have been disconnected
        expect(old1.disconnect).toHaveBeenCalled();
        expect(old2.disconnect).toHaveBeenCalled();
    });

    it('reload skips dead workers', async () =>
    {
        const mgr = new ClusterManager({ workers: 1 });
        cluster.fork = vi.fn();

        const dead = { id: 1, isDead: () => true };
        mgr._workers.set(1, dead);

        await mgr.reload();
        expect(cluster.fork).not.toHaveBeenCalled();
    });

    it('reload kills old worker if it does not exit in time', async () =>
    {
        vi.useFakeTimers();
        const mgr = new ClusterManager({ workers: 1 });

        let workerId = 100;
        cluster.fork = () =>
        {
            workerId++;
            return {
                id: workerId,
                process: { pid: 30000 + workerId },
                isDead: () => false,
                send: vi.fn(),
                disconnect: vi.fn(),
                kill: vi.fn(),
                once: vi.fn((event, cb) =>
                {
                    if (event === 'listening') setTimeout(cb, 1);
                }),
            };
        };

        const oldWorker = {
            id: 1,
            isDead: () => false,
            disconnect: vi.fn(),
            kill: vi.fn(),
            once: vi.fn(), // never calls exit callback
            send: vi.fn(),
        };
        mgr._workers.set(1, oldWorker);

        const reloadPromise = mgr.reload();

        // Advance timers to resolve listening event and kill timeout
        await vi.advanceTimersByTimeAsync(11000);
        await reloadPromise;

        expect(oldWorker.disconnect).toHaveBeenCalled();
        expect(oldWorker.kill).toHaveBeenCalled();

        vi.useRealTimers();
    });
});

// =========================================================
// _waitForAllWorkers with workers
// =========================================================

describe('ClusterManager: _waitForAllWorkers with workers', () =>
{
    let origOn;

    beforeEach(() =>
    {
        origOn = cluster.on;
    });

    afterEach(() =>
    {
        cluster.on = origOn;
    });

    it('resolves when workers map becomes empty via cluster exit event', async () =>
    {
        const mgr = new ClusterManager();
        mgr._workers.set(1, { isDead: () => false });

        let exitCb;
        cluster.on = (event, cb) =>
        {
            if (event === 'exit') exitCb = cb;
        };

        const promise = mgr._waitForAllWorkers();

        // Simulate worker exiting
        mgr._workers.delete(1);
        exitCb();

        await promise; // should resolve
    });
});

// =========================================================
// clusterize() — full function
// =========================================================

describe('clusterize: primary path', () =>
{
    let origFork, origOn, origIsPrimary, origPlatform;
    let signalHandlers;

    beforeEach(() =>
    {
        origFork = cluster.fork;
        origOn = cluster.on;
        origIsPrimary = cluster.isPrimary;
        origPlatform = process.platform;
        signalHandlers = {};

        let workerId = 0;
        cluster.fork = () =>
        {
            workerId++;
            return {
                id: workerId,
                process: { pid: 50000 + workerId },
                isDead: () => false,
                send: vi.fn(),
            };
        };
        cluster.on = vi.fn();
        cluster.isPrimary = true;

        // Intercept signal handlers
        const origProcessOn = process.on.bind(process);
        vi.spyOn(process, 'on').mockImplementation((event, fn) =>
        {
            signalHandlers[event] = fn;
            return process;
        });
    });

    afterEach(() =>
    {
        cluster.fork = origFork;
        cluster.on = origOn;
        cluster.isPrimary = origIsPrimary;
        Object.defineProperty(process, 'platform', { value: origPlatform });
        vi.restoreAllMocks();
    });

    it('clusterize on primary forks and installs SIGTERM/SIGINT handlers', () =>
    {
        const workerFn = vi.fn();
        const mgr = clusterize(workerFn, { workers: 1 });

        expect(mgr._started).toBe(true);
        expect(signalHandlers['SIGTERM']).toBeDefined();
        expect(signalHandlers['SIGINT']).toBeDefined();
        expect(workerFn).not.toHaveBeenCalled();

        mgr._shuttingDown = true;
    });

    it('clusterize SIGTERM handler calls shutdown then process.exit(0)', async () =>
    {
        const mgr = clusterize(() => {}, { workers: 0 });

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        signalHandlers['SIGTERM']();
        // Signal handler uses .then()/.catch() — flush microtasks
        await new Promise(r => setTimeout(r, 10));
        expect(exitSpy).toHaveBeenCalledWith(0);

        mgr._shuttingDown = true;
        exitSpy.mockRestore();
    });

    it('clusterize SIGINT handler calls shutdown then process.exit(0)', async () =>
    {
        const mgr = clusterize(() => {}, { workers: 0 });

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        signalHandlers['SIGINT']();
        await new Promise(r => setTimeout(r, 10));
        expect(exitSpy).toHaveBeenCalledWith(0);

        mgr._shuttingDown = true;
        exitSpy.mockRestore();
    });

    it('clusterize SIGTERM handler exits with 1 on shutdown error', async () =>
    {
        const mgr = clusterize(() => {}, { workers: 0 });

        // Force shutdown to reject
        mgr.shutdown = vi.fn().mockRejectedValue(new Error('shutdown failed'));

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        signalHandlers['SIGTERM']();
        await new Promise(r => setTimeout(r, 10));
        expect(exitSpy).toHaveBeenCalledWith(1);

        exitSpy.mockRestore();
    });

    it('clusterize installs SIGHUP on non-win32', () =>
    {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        const mgr = clusterize(() => {}, { workers: 0 });

        expect(signalHandlers['SIGHUP']).toBeDefined();
        mgr._shuttingDown = true;
    });

    it('clusterize does not install SIGHUP on win32', () =>
    {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const mgr = clusterize(() => {}, { workers: 0 });

        expect(signalHandlers['SIGHUP']).toBeUndefined();
        mgr._shuttingDown = true;
    });
});

describe('clusterize: worker path', () =>
{
    let origIsPrimary, origIsWorker, origDisconnect;

    beforeEach(() =>
    {
        origIsPrimary = cluster.isPrimary;
        origIsWorker = cluster.isWorker;
        origDisconnect = process.disconnect;
    });

    afterEach(() =>
    {
        cluster.isPrimary = origIsPrimary;
        cluster.isWorker = origIsWorker;
        process.disconnect = origDisconnect;
        vi.restoreAllMocks();
    });

    it('clusterize on worker calls workerFn and installs shutdown handler', () =>
    {
        cluster.isPrimary = false;
        cluster.isWorker = true;
        process.disconnect = vi.fn();

        const workerFn = vi.fn();
        const mgr = clusterize(workerFn, { workers: 1 });

        expect(workerFn).toHaveBeenCalledWith(mgr);
        expect(mgr._messageHandlers['shutdown']).toBeDefined();
    });

    it('worker shutdown handler calls process.disconnect', () =>
    {
        cluster.isPrimary = false;
        cluster.isWorker = true;
        process.disconnect = vi.fn();

        const mgr = clusterize(() => {}, { workers: 1 });

        // Trigger shutdown message handler
        const handler = mgr._messageHandlers['shutdown'][0];
        handler({});
        expect(process.disconnect).toHaveBeenCalled();
    });
});

// =========================================================
// enableSticky — remoteAddress fallback
// =========================================================

describe('ClusterManager: enableSticky edge cases', () =>
{
    it('handles missing remoteAddress (empty string fallback)', () =>
    {
        const mgr = new ClusterManager();
        const mockSend = vi.fn();
        mgr._workers.set(1, { isDead: () => false, send: mockSend });
        const server = new EventEmitter();
        mgr.enableSticky(server);

        const socket = {}; // no remoteAddress
        server.emit('connection', socket);
        expect(mockSend).toHaveBeenCalled();
    });
});
