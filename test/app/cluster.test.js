const cluster = require('cluster');
const { EventEmitter } = require('events');
const { ClusterManager, clusterize, _defaultIpHash } = require('../../lib/cluster');
const { createApp, LIFECYCLE_STATE } = require('../../');

describe('ClusterManager', () =>
{
    describe('Constructor and properties', () =>
    {
        it('creates with default options', () =>
        {
            const mgr = new ClusterManager();
            expect(mgr.workerCount).toBeGreaterThan(0);
            expect(mgr._opts.respawn).toBe(true);
            expect(mgr._opts.respawnDelay).toBe(1000);
            expect(mgr._opts.maxRespawnDelay).toBe(30000);
            expect(mgr._opts.backoffFactor).toBe(2);
        });

        it('accepts custom options', () =>
        {
            const mgr = new ClusterManager({
                workers: 2,
                respawn: false,
                respawnDelay: 500,
                maxRespawnDelay: 10000,
                backoffFactor: 3,
            });
            expect(mgr.workerCount).toBe(2);
            expect(mgr._opts.respawn).toBe(false);
            expect(mgr._opts.respawnDelay).toBe(500);
            expect(mgr._opts.maxRespawnDelay).toBe(10000);
            expect(mgr._opts.backoffFactor).toBe(3);
        });

        it('isPrimary reflects cluster state', () =>
        {
            const mgr = new ClusterManager();
            // In test context, we're always the primary
            expect(mgr.isPrimary).toBe(true);
        });

        it('isWorker reflects cluster state', () =>
        {
            const mgr = new ClusterManager();
            expect(mgr.isWorker).toBe(false);
        });

        it('workerIds is empty before fork', () =>
        {
            const mgr = new ClusterManager();
            expect(mgr.workerIds).toEqual([]);
        });

        it('activeWorkers is 0 before fork', () =>
        {
            const mgr = new ClusterManager();
            expect(mgr.activeWorkers).toBe(0);
        });

        it('_started is false initially', () =>
        {
            const mgr = new ClusterManager();
            expect(mgr._started).toBe(false);
        });

        it('_shuttingDown is false initially', () =>
        {
            const mgr = new ClusterManager();
            expect(mgr._shuttingDown).toBe(false);
        });
    });

    describe('IPC Message Handlers', () =>
    {
        it('onMessage registers a handler', () =>
        {
            const mgr = new ClusterManager();
            const fn = vi.fn();
            const result = mgr.onMessage('test', fn);
            expect(result).toBe(mgr);
            expect(mgr._messageHandlers['test']).toContain(fn);
        });

        it('onMessage supports multiple handlers per type', () =>
        {
            const mgr = new ClusterManager();
            const fn1 = vi.fn();
            const fn2 = vi.fn();
            mgr.onMessage('evt', fn1);
            mgr.onMessage('evt', fn2);
            expect(mgr._messageHandlers['evt']).toHaveLength(2);
        });

        it('_handleMessage calls registered handlers', () =>
        {
            const mgr = new ClusterManager();
            const fn = vi.fn();
            mgr.onMessage('update', fn);

            const fakeWorker = { id: 1 };
            mgr._handleMessage(fakeWorker, { type: 'update', data: { x: 1 } });

            expect(fn).toHaveBeenCalledWith({ x: 1 }, fakeWorker);
        });

        it('_handleMessage ignores unregistered types', () =>
        {
            const mgr = new ClusterManager();
            // Should not throw
            mgr._handleMessage({}, { type: 'unknown', data: {} });
        });

        it('_handleMessage catches handler errors', () =>
        {
            const mgr = new ClusterManager();
            const fn1 = vi.fn(() => { throw new Error('oops'); });
            const fn2 = vi.fn();
            mgr.onMessage('err', fn1);
            mgr.onMessage('err', fn2);

            mgr._handleMessage({}, { type: 'err', data: {} });
            // fn2 still called despite fn1 throwing
            expect(fn2).toHaveBeenCalled();
        });

        it('broadcast sends to all workers', () =>
        {
            const mgr = new ClusterManager();
            const sent = [];
            mgr._workers.set(1, { isDead: () => false, send: (msg) => sent.push({ id: 1, msg }) });
            mgr._workers.set(2, { isDead: () => false, send: (msg) => sent.push({ id: 2, msg }) });

            mgr.broadcast('ping', { ts: 123 });

            expect(sent).toHaveLength(2);
            expect(sent[0].msg).toEqual({ _zhttp: true, type: 'ping', data: { ts: 123 } });
            expect(sent[1].msg).toEqual({ _zhttp: true, type: 'ping', data: { ts: 123 } });
        });

        it('broadcast skips dead workers', () =>
        {
            const mgr = new ClusterManager();
            const sent = [];
            mgr._workers.set(1, { isDead: () => true, send: (msg) => sent.push(msg) });
            mgr._workers.set(2, { isDead: () => false, send: (msg) => sent.push(msg) });

            mgr.broadcast('test', {});
            expect(sent).toHaveLength(1);
        });

        it('sendTo sends to a specific worker', () =>
        {
            const mgr = new ClusterManager();
            const sent = [];
            mgr._workers.set(1, { isDead: () => false, send: (msg) => sent.push(msg) });
            mgr._workers.set(2, { isDead: () => false, send: (msg) => sent.push(msg) });

            mgr.sendTo(1, 'direct', { val: 42 });
            expect(sent).toHaveLength(1);
            expect(sent[0]).toEqual({ _zhttp: true, type: 'direct', data: { val: 42 } });
        });

        it('sendTo ignores nonexistent worker', () =>
        {
            const mgr = new ClusterManager();
            mgr.sendTo(999, 'test', {}); // no crash
        });

        it('sendTo ignores dead worker', () =>
        {
            const mgr = new ClusterManager();
            mgr._workers.set(1, { isDead: () => true, send: () => { throw new Error('boom'); } });
            mgr.sendTo(1, 'test', {}); // no crash, no send
        });

        it('sendToPrimary is a no-op on primary', () =>
        {
            const mgr = new ClusterManager();
            mgr.sendToPrimary('test', {}); // no crash, no effect
        });
    });

    describe('fork() guard', () =>
    {
        it('fork on non-primary is a no-op', () =>
        {
            const mgr = new ClusterManager();
            // Monkey-patch isPrimary to false
            Object.defineProperty(mgr, 'isPrimary', { get: () => false });
            const result = mgr.fork();
            expect(result).toBe(mgr);
            expect(mgr._started).toBe(false);
        });

        it('fork is idempotent', () =>
        {
            const mgr = new ClusterManager();
            // Mark as started to test guard
            mgr._started = true;
            const result = mgr.fork();
            expect(result).toBe(mgr);
        });
    });

    describe('Shutdown', () =>
    {
        it('shutdown sets shuttingDown flag', async () =>
        {
            const mgr = new ClusterManager();
            await mgr.shutdown({ timeout: 100 });
            expect(mgr._shuttingDown).toBe(true);
        });

        it('duplicate shutdown is a no-op', async () =>
        {
            const mgr = new ClusterManager();
            await mgr.shutdown({ timeout: 100 });
            await mgr.shutdown({ timeout: 100 }); // no crash
        });

        it('shutdown disconnects and kills remaining workers', async () =>
        {
            const mgr = new ClusterManager();
            const actions = [];
            mgr._workers.set(1, {
                isDead: () => false,
                disconnect: () => actions.push('disconnect'),
                kill: () => actions.push('kill'),
                send: () => actions.push('send'),
            });

            // _waitForAllWorkers resolves when workers map is empty
            // simulate timeout-based kill
            await mgr.shutdown({ timeout: 50 });

            expect(actions).toContain('disconnect');
            expect(actions).toContain('kill');
            expect(mgr._workers.size).toBe(0);
        });

        it('shutdown skips dead workers on disconnect', async () =>
        {
            const mgr = new ClusterManager();
            mgr._workers.set(1, {
                isDead: () => true,
                disconnect: () => { throw new Error('should not call'); },
                kill: () => {},
            });

            await mgr.shutdown({ timeout: 50 });
        });

        it('broadcasts shutdown message to workers', async () =>
        {
            const mgr = new ClusterManager();
            const sent = [];
            mgr._workers.set(1, {
                isDead: () => false,
                send: (msg) => sent.push(msg),
                disconnect: () => {},
                kill: () => {},
            });

            await mgr.shutdown({ timeout: 50 });

            expect(sent.some(m => m.type === 'shutdown')).toBe(true);
        });
    });

    describe('_waitForAllWorkers', () =>
    {
        it('resolves immediately when no workers', async () =>
        {
            const mgr = new ClusterManager();
            await mgr._waitForAllWorkers(); // no crash, instant resolve
        });
    });

    describe('reload() guard', () =>
    {
        it('reload on non-primary is a no-op', async () =>
        {
            const mgr = new ClusterManager();
            Object.defineProperty(mgr, 'isPrimary', { get: () => false });
            await mgr.reload(); // no crash
        });

        it('reload while shutting down is a no-op', async () =>
        {
            const mgr = new ClusterManager();
            mgr._shuttingDown = true;
            await mgr.reload(); // no crash
        });
    });
});

describe('Module exports', () =>
{
    it('exports ClusterManager class', () =>
    {
        const { ClusterManager } = require('../../');
        expect(typeof ClusterManager).toBe('function');
    });

    it('exports cluster function', () =>
    {
        const { cluster } = require('../../');
        expect(typeof cluster).toBe('function');
    });

    it('exports LIFECYCLE_STATE', () =>
    {
        const { LIFECYCLE_STATE } = require('../../');
        expect(LIFECYCLE_STATE).toEqual({
            RUNNING: 'running',
            DRAINING: 'draining',
            CLOSED: 'closed',
        });
    });

    it('exports LifecycleManager', () =>
    {
        const { LifecycleManager } = require('../../');
        expect(typeof LifecycleManager).toBe('function');
    });
});

// =========================================================
// _defaultIpHash
// =========================================================

describe('_defaultIpHash', () =>
{
    it('returns a number within range for IPv4', () =>
    {
        const idx = _defaultIpHash('192.168.1.100', 4);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(4);
    });

    it('returns a number within range for IPv6', () =>
    {
        const idx = _defaultIpHash('::ffff:127.0.0.1', 8);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(8);
    });

    it('returns 0 when count <= 0', () =>
    {
        expect(_defaultIpHash('1.2.3.4', 0)).toBe(0);
        expect(_defaultIpHash('1.2.3.4', -1)).toBe(0);
    });

    it('produces consistent results for the same IP', () =>
    {
        const a = _defaultIpHash('10.0.0.1', 4);
        const b = _defaultIpHash('10.0.0.1', 4);
        expect(a).toBe(b);
    });

    it('distributes different IPs across workers', () =>
    {
        const results = new Set();
        for (let i = 0; i < 100; i++)
        {
            results.add(_defaultIpHash(`192.168.${i}.${i}`, 4));
        }
        // Should hit at least 2 different workers (probabilistic, but virtually certain)
        expect(results.size).toBeGreaterThanOrEqual(2);
    });

    it('handles empty string IP', () =>
    {
        const idx = _defaultIpHash('', 4);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(4);
    });
});

// =========================================================
// enableMetrics / disableMetrics
// =========================================================

describe('ClusterManager: enableMetrics', () =>
{
    it('registers metrics:report handler on primary', () =>
    {
        const mgr = new ClusterManager();
        const registry = { merge: vi.fn() };
        mgr.enableMetrics(registry, { interval: 1000 });

        expect(mgr._messageHandlers['metrics:report']).toBeDefined();
        expect(mgr._messageHandlers['metrics:report']).toHaveLength(1);
    });

    it('metrics merge handler calls registry.merge', () =>
    {
        const mgr = new ClusterManager();
        const registry = { merge: vi.fn() };
        mgr.enableMetrics(registry);

        // Simulate incoming metrics message
        const handler = mgr._messageHandlers['metrics:report'][0];
        handler({ counter: 42 });
        expect(registry.merge).toHaveBeenCalledWith({ counter: 42 });
    });

    it('stores aggregateRegistry reference', () =>
    {
        const mgr = new ClusterManager();
        const registry = { merge: vi.fn() };
        mgr.enableMetrics(registry);
        expect(mgr._aggregateRegistry).toBe(registry);
    });

    it('returns this for chaining', () =>
    {
        const mgr = new ClusterManager();
        const result = mgr.enableMetrics({ merge: vi.fn() });
        expect(result).toBe(mgr);
    });
});

describe('ClusterManager: disableMetrics', () =>
{
    it('clears metrics timer if set', () =>
    {
        const mgr = new ClusterManager();
        mgr._metricsTimer = setInterval(() => {}, 99999);
        mgr.disableMetrics();
        expect(mgr._metricsTimer).toBeNull();
    });

    it('is safe to call when no timer is set', () =>
    {
        const mgr = new ClusterManager();
        mgr.disableMetrics(); // no crash
    });
});

// =========================================================
// enableSticky
// =========================================================

describe('ClusterManager: enableSticky', () =>
{
    it('returns this when not primary', () =>
    {
        const mgr = new ClusterManager();
        Object.defineProperty(mgr, 'isPrimary', { get: () => false });
        const result = mgr.enableSticky({});
        expect(result).toBe(mgr);
    });

    it('returns this when server is null', () =>
    {
        const mgr = new ClusterManager();
        const result = mgr.enableSticky(null);
        expect(result).toBe(mgr);
    });

    it('installs connection handler on server', () =>
    {
        const mgr = new ClusterManager();
        const server = new EventEmitter();
        mgr.enableSticky(server);
        expect(server.listenerCount('connection')).toBe(1);
    });

    it('destroys socket when no workers', () =>
    {
        const mgr = new ClusterManager();
        const server = new EventEmitter();
        mgr.enableSticky(server);

        const socket = { remoteAddress: '1.2.3.4', destroy: vi.fn() };
        server.emit('connection', socket);
        expect(socket.destroy).toHaveBeenCalled();
    });

    it('destroys socket when shutting down', () =>
    {
        const mgr = new ClusterManager();
        mgr._workers.set(1, { isDead: () => false, send: vi.fn() });
        mgr._shuttingDown = true;
        const server = new EventEmitter();
        mgr.enableSticky(server);

        const socket = { remoteAddress: '1.2.3.4', destroy: vi.fn() };
        server.emit('connection', socket);
        expect(socket.destroy).toHaveBeenCalled();
    });

    it('sends socket to worker based on IP hash', () =>
    {
        const mgr = new ClusterManager();
        const mockSend = vi.fn();
        mgr._workers.set(1, { isDead: () => false, send: mockSend });
        const server = new EventEmitter();
        mgr.enableSticky(server);

        const socket = { remoteAddress: '10.0.0.1' };
        server.emit('connection', socket);
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ _zhttp: true, type: 'sticky:connection' }),
            socket
        );
    });

    it('uses custom hash function when provided', () =>
    {
        const mgr = new ClusterManager();
        const mockSend = vi.fn();
        mgr._workers.set(1, { isDead: () => false, send: vi.fn() });
        mgr._workers.set(2, { isDead: () => false, send: mockSend });
        const server = new EventEmitter();
        // Custom hash always returns 1 (second worker)
        mgr.enableSticky(server, { hash: () => 1 });

        const socket = { remoteAddress: '10.0.0.1' };
        server.emit('connection', socket);
        expect(mockSend).toHaveBeenCalled();
    });

    it('destroys socket when target worker is dead', () =>
    {
        const mgr = new ClusterManager();
        mgr._workers.set(1, { isDead: () => true, send: vi.fn() });
        const server = new EventEmitter();
        mgr.enableSticky(server);

        const socket = { remoteAddress: '1.2.3.4', destroy: vi.fn() };
        server.emit('connection', socket);
        expect(socket.destroy).toHaveBeenCalled();
    });
});

// =========================================================
// clusterize
// =========================================================

describe('clusterize', () =>
{
    it('returns a ClusterManager instance', () =>
    {
        // We are in primary during test
        const mgr = clusterize(() => {}, { workers: 0 });
        expect(mgr).toBeInstanceOf(ClusterManager);
        // Clean up
        mgr._shuttingDown = true;
    });
});

// =========================================================
// broadcast error handling
// =========================================================

describe('ClusterManager: broadcast send errors', () =>
{
    it('propagates error when worker.send throws', () =>
    {
        const mgr = new ClusterManager();
        mgr._workers.set(1, {
            isDead: () => false,
            send: () => { throw new Error('IPC channel closed'); },
        });

        expect(() => mgr.broadcast('test', {})).toThrow('IPC channel closed');
    });
});

// =========================================================
// enableMetrics — worker side
// =========================================================

describe('ClusterManager: enableMetrics (worker side)', () =>
{
    it('sets up interval timer on worker', () =>
    {
        const mgr = new ClusterManager();
        Object.defineProperty(mgr, 'isWorker', { get: () => true });
        Object.defineProperty(mgr, 'isPrimary', { get: () => false });

        // Stub sendToPrimary since process.send doesn't exist in test
        mgr.sendToPrimary = vi.fn();
        const registry = { toJSON: () => ({ c: 1 }) };

        mgr.enableMetrics(registry, { interval: 100 });
        expect(mgr._metricsTimer).not.toBeNull();
        mgr.disableMetrics();
        expect(mgr._metricsTimer).toBeNull();
    });
});

// =========================================================
// onMessage — worker listener installation
// =========================================================

describe('ClusterManager: onMessage (worker side)', () =>
{
    it('installs process message listener on worker', () =>
    {
        const mgr = new ClusterManager();
        Object.defineProperty(mgr, 'isWorker', { get: () => true });

        const origOn = process.on.bind(process);
        const addedTypes = [];
        const spy = vi.fn((...args) =>
        {
            addedTypes.push(args[0]);
            return origOn(...args);
        });
        process.on = spy;

        try
        {
            mgr.onMessage('worker-evt', vi.fn());
            expect(addedTypes).toContain('message');
            expect(mgr._workerListenerInstalled).toBe(true);

            // Second call should not install again
            const countBefore = spy.mock.calls.filter(c => c[0] === 'message').length;
            mgr.onMessage('another', vi.fn());
            const countAfter = spy.mock.calls.filter(c => c[0] === 'message').length;
            expect(countAfter).toBe(countBefore);
        }
        finally
        {
            process.on = origOn;
        }
    });

    it('worker message listener dispatches _zhttp messages', () =>
    {
        const mgr = new ClusterManager();
        Object.defineProperty(mgr, 'isWorker', { get: () => true });

        let messageHandler;
        const origOn = process.on.bind(process);
        process.on = (event, fn) =>
        {
            if (event === 'message') messageHandler = fn;
            return origOn(event, fn);
        };

        const fn = vi.fn();
        try
        {
            mgr.onMessage('dispatch-test', fn);

            // Simulate receiving a _zhttp message
            messageHandler({ _zhttp: true, type: 'dispatch-test', data: { val: 42 } });
            expect(fn).toHaveBeenCalledWith({ val: 42 });

            // Non-_zhttp messages should be ignored
            messageHandler({ type: 'dispatch-test', data: {} });
            expect(fn).toHaveBeenCalledTimes(1);

            // Unknown types should be ignored
            messageHandler({ _zhttp: true, type: 'unknown', data: {} });
            expect(fn).toHaveBeenCalledTimes(1);
        }
        finally
        {
            process.on = origOn;
        }
    });

    it('worker message listener catches handler errors', () =>
    {
        const mgr = new ClusterManager();
        Object.defineProperty(mgr, 'isWorker', { get: () => true });

        let messageHandler;
        const origOn = process.on.bind(process);
        process.on = (event, fn) =>
        {
            if (event === 'message') messageHandler = fn;
            return origOn(event, fn);
        };

        const throwing = vi.fn(() => { throw new Error('handler error'); });
        const good = vi.fn();

        try
        {
            mgr.onMessage('err-test', throwing);
            mgr.onMessage('err-test', good);

            messageHandler({ _zhttp: true, type: 'err-test', data: {} });
            expect(throwing).toHaveBeenCalled();
            expect(good).toHaveBeenCalled(); // should still run despite first throwing
        }
        finally
        {
            process.on = origOn;
        }
    });
});
