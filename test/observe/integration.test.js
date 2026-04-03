const { ClusterManager, _defaultIpHash } = require('../../lib/cluster');
const { MetricsRegistry } = require('../../lib/observe/metrics');

// ── _defaultIpHash ───────────────────────────────────────────────

describe('_defaultIpHash', () =>
{
    it('returns a number within range', () =>
    {
        const idx = _defaultIpHash('192.168.1.1', 4);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(4);
    });

    it('returns consistent result for same IP', () =>
    {
        const a = _defaultIpHash('10.0.0.1', 8);
        const b = _defaultIpHash('10.0.0.1', 8);
        expect(a).toBe(b);
    });

    it('distributes different IPs', () =>
    {
        const results = new Set();
        for (let i = 0; i < 100; i++)
        {
            results.add(_defaultIpHash(`192.168.${i}.${i}`, 4));
        }
        // Should hit more than 1 worker (probabilistic)
        expect(results.size).toBeGreaterThan(1);
    });

    it('handles empty IP', () =>
    {
        const idx = _defaultIpHash('', 4);
        expect(typeof idx).toBe('number');
        expect(idx).toBeGreaterThanOrEqual(0);
    });

    it('handles single worker', () =>
    {
        const idx = _defaultIpHash('127.0.0.1', 1);
        expect(idx).toBe(0);
    });
});

// ── ClusterManager.enableMetrics ─────────────────────────────────

describe('ClusterManager metrics integration', () =>
{
    it('enableMetrics returns this for chaining', () =>
    {
        const mgr = new ClusterManager();
        // In non-worker, non-primary test env, it will be primary-like
        const result = mgr.enableMetrics(new MetricsRegistry());
        expect(result).toBe(mgr);
    });

    it('disableMetrics clears timer', () =>
    {
        const mgr = new ClusterManager();
        // Simulate having a timer
        mgr._metricsTimer = setInterval(() => {}, 60000);
        mgr.disableMetrics();
        expect(mgr._metricsTimer).toBeNull();
    });

    it('disableMetrics is safe without timer', () =>
    {
        const mgr = new ClusterManager();
        expect(() => mgr.disableMetrics()).not.toThrow();
    });
});

// ── ClusterManager.enableSticky ──────────────────────────────────

describe('ClusterManager.enableSticky', () =>
{
    it('returns this for chaining', () =>
    {
        const mgr = new ClusterManager();
        const EventEmitter = require('events').EventEmitter;
        const fakeServer = new EventEmitter();
        const result = mgr.enableSticky(fakeServer);
        expect(result).toBe(mgr);
    });

    it('does nothing without server', () =>
    {
        const mgr = new ClusterManager();
        expect(() => mgr.enableSticky(null)).not.toThrow();
    });

    it('destroys socket when no workers available', () =>
    {
        const mgr = new ClusterManager();
        // Ensure _started is false so no cluster.on('exit') etc
        const EventEmitter = require('events').EventEmitter;
        const fakeServer = new EventEmitter();
        mgr.enableSticky(fakeServer);

        let destroyed = false;
        const fakeSocket = {
            remoteAddress: '127.0.0.1',
            destroy: () => { destroyed = true; },
        };
        fakeServer.emit('connection', fakeSocket);
        expect(destroyed).toBe(true);
    });

    it('destroys socket during shutdown', () =>
    {
        const mgr = new ClusterManager();
        mgr._shuttingDown = true;
        // Add a fake worker so it's not the "no workers" path
        mgr._workers.set(1, { isDead: () => false, send: () => {} });

        const EventEmitter = require('events').EventEmitter;
        const fakeServer = new EventEmitter();
        mgr.enableSticky(fakeServer);

        let destroyed = false;
        const fakeSocket = {
            remoteAddress: '10.0.0.1',
            destroy: () => { destroyed = true; },
        };
        fakeServer.emit('connection', fakeSocket);
        expect(destroyed).toBe(true);
    });

    it('sends socket to worker based on IP hash', () =>
    {
        const mgr = new ClusterManager();
        const sentMessages = [];
        const fakeWorker = {
            isDead: () => false,
            send: (msg, socket) => sentMessages.push({ msg, socket }),
        };
        mgr._workers.set(1, fakeWorker);

        const EventEmitter = require('events').EventEmitter;
        const fakeServer = new EventEmitter();
        mgr.enableSticky(fakeServer);

        const fakeSocket = { remoteAddress: '192.168.1.1', destroy: () => {} };
        fakeServer.emit('connection', fakeSocket);

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].msg._zhttp).toBe(true);
        expect(sentMessages[0].msg.type).toBe('sticky:connection');
        expect(sentMessages[0].socket).toBe(fakeSocket);
    });

    it('destroys socket when target worker is dead', () =>
    {
        const mgr = new ClusterManager();
        mgr._workers.set(1, { isDead: () => true, send: () => {} });

        const EventEmitter = require('events').EventEmitter;
        const fakeServer = new EventEmitter();
        mgr.enableSticky(fakeServer);

        let destroyed = false;
        const fakeSocket = { remoteAddress: '10.0.0.1', destroy: () => { destroyed = true; } };
        fakeServer.emit('connection', fakeSocket);
        expect(destroyed).toBe(true);
    });

    it('supports custom hash function', () =>
    {
        const mgr = new ClusterManager();
        const fakeWorkerA = { isDead: () => false, send: vi.fn() };
        const fakeWorkerB = { isDead: () => false, send: vi.fn() };
        mgr._workers.set(1, fakeWorkerA);
        mgr._workers.set(2, fakeWorkerB);

        const EventEmitter = require('events').EventEmitter;
        const fakeServer = new EventEmitter();
        // Always route to second worker
        mgr.enableSticky(fakeServer, { hash: () => 1 });

        const fakeSocket = { remoteAddress: '1.2.3.4', destroy: () => {} };
        fakeServer.emit('connection', fakeSocket);
        expect(fakeWorkerB.send).toHaveBeenCalled();
    });
});

// ── App Observability Integration ────────────────────────────────

describe('App observability methods', () =>
{
    let App;
    beforeAll(() =>
    {
        // Load the App class directly
        App = require('../../lib/app');
    });

    it('health() registers GET /healthz', () =>
    {
        const app = new App();
        const result = app.health();
        expect(result).toBe(app);
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/healthz')).toBe(true);
    });

    it('health(path) uses custom path', () =>
    {
        const app = new App();
        app.health('/alive');
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/alive')).toBe(true);
    });

    it('health(checks) with object as first arg', () =>
    {
        const app = new App();
        app.health({ memory: () => ({ healthy: true }) });
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/healthz')).toBe(true);
    });

    it('ready() registers GET /readyz', () =>
    {
        const app = new App();
        app.ready();
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/readyz')).toBe(true);
    });

    it('ready(path) uses custom path', () =>
    {
        const app = new App();
        app.ready('/ready-check');
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/ready-check')).toBe(true);
    });

    it('addHealthCheck stores checks', () =>
    {
        const app = new App();
        const fn = () => true;
        const result = app.addHealthCheck('db', fn);
        expect(result).toBe(app);
        expect(app._healthChecks.db).toBe(fn);
    });

    it('addHealthCheck accumulates multiple checks', () =>
    {
        const app = new App();
        app.addHealthCheck('a', () => true);
        app.addHealthCheck('b', () => true);
        expect(Object.keys(app._healthChecks)).toEqual(['a', 'b']);
    });

    it('metrics() returns MetricsRegistry', () =>
    {
        const app = new App();
        const reg = app.metrics();
        expect(reg).toBeInstanceOf(MetricsRegistry);
    });

    it('metrics() returns same registry on repeated calls', () =>
    {
        const app = new App();
        const a = app.metrics();
        const b = app.metrics();
        expect(a).toBe(b);
    });

    it('metricsEndpoint() registers GET /metrics', () =>
    {
        const app = new App();
        const result = app.metricsEndpoint();
        expect(result).toBe(app);
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/metrics')).toBe(true);
    });

    it('metricsEndpoint(path) uses custom path', () =>
    {
        const app = new App();
        app.metricsEndpoint('/prometheus');
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/prometheus')).toBe(true);
    });

    it('metricsEndpoint with object as first arg', () =>
    {
        const app = new App();
        const reg = new MetricsRegistry();
        app.metricsEndpoint({ registry: reg });
        const routes = app.routes();
        expect(routes.some(r => r.method === 'GET' && r.path === '/metrics')).toBe(true);
    });
});
