const {
    Counter, Gauge, Histogram,
    MetricsRegistry, DEFAULT_BUCKETS,
    createDefaultMetrics, metricsMiddleware, metricsEndpoint,
} = require('../../lib/observe/metrics');

// ── Counter ─────────────────────────────────────────────────────

describe('Counter', () =>
{
    it('starts at 0 with no labels', () =>
    {
        const c = new Counter({ name: 'test_total', help: 'test' });
        expect(c.get()).toBe(0);
    });

    it('increments by 1 by default', () =>
    {
        const c = new Counter({ name: 'test_total', help: 'test' });
        c.inc();
        expect(c.get()).toBe(1);
    });

    it('increments by a custom value', () =>
    {
        const c = new Counter({ name: 'test_total', help: 'test' });
        c.inc(5);
        expect(c.get()).toBe(5);
    });

    it('refuses to decrement (ignores negative values)', () =>
    {
        const c = new Counter({ name: 'test_total', help: 'test' });
        c.inc(10);
        c.inc(-3);
        expect(c.get()).toBe(10);
    });

    it('supports labels', () =>
    {
        const c = new Counter({ name: 'req_total', help: 'test', labels: ['method', 'status'] });
        c.inc({ method: 'GET', status: '200' });
        c.inc({ method: 'GET', status: '200' });
        c.inc({ method: 'POST', status: '201' });
        expect(c.get({ method: 'GET', status: '200' })).toBe(2);
        expect(c.get({ method: 'POST', status: '201' })).toBe(1);
        expect(c.get({ method: 'DELETE', status: '204' })).toBe(0);
    });

    it('increments labeled counter with custom value', () =>
    {
        const c = new Counter({ name: 'req_total', help: 'test', labels: ['method'] });
        c.inc({ method: 'GET' }, 10);
        expect(c.get({ method: 'GET' })).toBe(10);
    });

    it('resets all values', () =>
    {
        const c = new Counter({ name: 'test_total', help: 'test', labels: ['a'] });
        c.inc({ a: '1' }, 5);
        c.inc({ a: '2' }, 3);
        c.reset();
        expect(c.get({ a: '1' })).toBe(0);
        expect(c.get({ a: '2' })).toBe(0);
    });

    it('resets unlabeled counter', () =>
    {
        const c = new Counter({ name: 'test_total', help: 'test' });
        c.inc(5);
        c.reset();
        expect(c.get()).toBe(0);
    });

    it('serializes to Prometheus text', () =>
    {
        const c = new Counter({ name: 'http_total', help: 'Total requests', labels: ['method'] });
        c.inc({ method: 'GET' }, 42);
        const text = c.collect();
        expect(text).toContain('# HELP http_total Total requests');
        expect(text).toContain('# TYPE http_total counter');
        expect(text).toContain('http_total{method="GET"} 42');
    });

    it('serializes unlabeled counter', () =>
    {
        const c = new Counter({ name: 'simple', help: 'Simple counter' });
        c.inc(7);
        const text = c.collect();
        expect(text).toContain('simple 7');
    });
});

// ── Gauge ────────────────────────────────────────────────────────

describe('Gauge', () =>
{
    it('starts at 0', () =>
    {
        const g = new Gauge({ name: 'temp', help: 'test' });
        expect(g.get()).toBe(0);
    });

    it('sets value', () =>
    {
        const g = new Gauge({ name: 'temp', help: 'test' });
        g.set(42);
        expect(g.get()).toBe(42);
    });

    it('increments', () =>
    {
        const g = new Gauge({ name: 'active', help: 'test' });
        g.inc();
        g.inc();
        expect(g.get()).toBe(2);
    });

    it('decrements', () =>
    {
        const g = new Gauge({ name: 'active', help: 'test' });
        g.set(10);
        g.dec();
        g.dec(3);
        expect(g.get()).toBe(6);
    });

    it('supports labels for set/inc/dec', () =>
    {
        const g = new Gauge({ name: 'conns', help: 'test', labels: ['pool'] });
        g.set({ pool: 'primary' }, 10);
        g.inc({ pool: 'primary' }, 5);
        g.dec({ pool: 'primary' }, 3);
        expect(g.get({ pool: 'primary' })).toBe(12);
    });

    it('resets all values', () =>
    {
        const g = new Gauge({ name: 'active', help: 'test', labels: ['type'] });
        g.set({ type: 'ws' }, 5);
        g.set({ type: 'sse' }, 3);
        g.reset();
        expect(g.get({ type: 'ws' })).toBe(0);
    });

    it('calls collect function before serializing', () =>
    {
        const g = new Gauge({
            name: 'memory',
            help: 'test',
            collect: (gauge) => gauge.set(99),
        });
        const text = g.collect();
        expect(text).toContain('memory 99');
    });

    it('serializes to Prometheus text', () =>
    {
        const g = new Gauge({ name: 'pool_active', help: 'Active pool connections', labels: ['pool'] });
        g.set({ pool: 'main' }, 7);
        const text = g.collect();
        expect(text).toContain('# TYPE pool_active gauge');
        expect(text).toContain('pool_active{pool="main"} 7');
    });

    it('increments with number as first arg (no labels)', () =>
    {
        const g = new Gauge({ name: 'x', help: 'test' });
        g.inc(5);
        expect(g.get()).toBe(5);
    });

    it('decrements with number as first arg (no labels)', () =>
    {
        const g = new Gauge({ name: 'x', help: 'test' });
        g.set(10);
        g.dec(3);
        expect(g.get()).toBe(7);
    });
});

// ── Histogram ────────────────────────────────────────────────────

describe('Histogram', () =>
{
    it('observes values into buckets', () =>
    {
        const h = new Histogram({ name: 'duration', help: 'test', buckets: [0.1, 0.5, 1.0] });
        h.observe(0.05);
        h.observe(0.3);
        h.observe(0.7);
        const stats = h.get();
        expect(stats.count).toBe(3);
        expect(stats.sum).toBeCloseTo(1.05);
    });

    it('uses default buckets', () =>
    {
        const h = new Histogram({ name: 'duration', help: 'test' });
        expect(h._buckets).toEqual(DEFAULT_BUCKETS);
    });

    it('supports labels', () =>
    {
        const h = new Histogram({ name: 'duration', help: 'test', labels: ['method'], buckets: [0.5, 1.0] });
        h.observe({ method: 'GET' }, 0.3);
        h.observe({ method: 'POST' }, 0.8);
        expect(h.get({ method: 'GET' }).count).toBe(1);
        expect(h.get({ method: 'POST' }).count).toBe(1);
    });

    it('returns null for unobserved labels', () =>
    {
        const h = new Histogram({ name: 'duration', help: 'test', labels: ['method'] });
        expect(h.get({ method: 'DELETE' })).toBeNull();
    });

    it('startTimer records duration', async () =>
    {
        const h = new Histogram({ name: 'duration', help: 'test', buckets: [0.01, 0.1, 1.0] });
        const end = h.startTimer();
        // Small delay
        await new Promise(r => setTimeout(r, 10));
        end();
        const stats = h.get();
        expect(stats.count).toBe(1);
        expect(stats.sum).toBeGreaterThan(0);
    });

    it('startTimer with labels', () =>
    {
        const h = new Histogram({ name: 'duration', help: 'test', labels: ['op'], buckets: [1] });
        const end = h.startTimer({ op: 'query' });
        end();
        expect(h.get({ op: 'query' }).count).toBe(1);
    });

    it('resets all data', () =>
    {
        const h = new Histogram({ name: 'duration', help: 'test', buckets: [1] });
        h.observe(0.5);
        h.reset();
        expect(h.get()).toBeNull();
    });

    it('serializes to Prometheus text with cumulative buckets', () =>
    {
        const h = new Histogram({ name: 'http_duration', help: 'Latency', buckets: [0.1, 0.5, 1.0] });
        h.observe(0.05);
        h.observe(0.3);
        h.observe(0.7);
        const text = h.collect();
        expect(text).toContain('# TYPE http_duration histogram');
        expect(text).toContain('http_duration_bucket{le="0.1"} 1');
        expect(text).toContain('http_duration_bucket{le="0.5"} 2');
        expect(text).toContain('http_duration_bucket{le="1"} 3');
        expect(text).toContain('http_duration_bucket{le="+Inf"} 3');
        expect(text).toContain('http_duration_sum');
        expect(text).toContain('http_duration_count 3');
    });

    it('serializes with labels', () =>
    {
        const h = new Histogram({ name: 'dur', help: 'test', labels: ['method'], buckets: [1] });
        h.observe({ method: 'GET' }, 0.5);
        const text = h.collect();
        expect(text).toContain('dur_bucket{method="GET",le="1"}');
        expect(text).toContain('dur_sum{method="GET"}');
    });

    it('filters out "le" from user labels', () =>
    {
        const h = new Histogram({ name: 'dur', help: 'test', labels: ['le', 'method'], buckets: [1] });
        expect(h._labels).toEqual(['method']);
    });
});

// ── MetricsRegistry ──────────────────────────────────────────────

describe('MetricsRegistry', () =>
{
    it('creates and registers a counter', () =>
    {
        const reg = new MetricsRegistry();
        const c = reg.counter({ name: 'test_total', help: 'test' });
        expect(c).toBeInstanceOf(Counter);
        expect(reg.getMetric('test_total')).toBe(c);
    });

    it('creates and registers a gauge', () =>
    {
        const reg = new MetricsRegistry();
        const g = reg.gauge({ name: 'test_gauge', help: 'test' });
        expect(g).toBeInstanceOf(Gauge);
    });

    it('creates and registers a histogram', () =>
    {
        const reg = new MetricsRegistry();
        const h = reg.histogram({ name: 'test_hist', help: 'test' });
        expect(h).toBeInstanceOf(Histogram);
    });

    it('returns existing metric if name already registered', () =>
    {
        const reg = new MetricsRegistry();
        const c1 = reg.counter({ name: 'dup', help: 'test' });
        const c2 = reg.counter({ name: 'dup', help: 'test' });
        expect(c1).toBe(c2);
    });

    it('applies prefix', () =>
    {
        const reg = new MetricsRegistry({ prefix: 'myapp_' });
        const c = reg.counter({ name: 'requests', help: 'test' });
        expect(c.name).toBe('myapp_requests');
        expect(reg.getMetric('requests')).toBe(c);
    });

    it('removes a metric', () =>
    {
        const reg = new MetricsRegistry();
        reg.counter({ name: 'removeme', help: 'test' });
        expect(reg.removeMetric('removeme')).toBe(true);
        expect(reg.getMetric('removeme')).toBeUndefined();
    });

    it('clears all metrics', () =>
    {
        const reg = new MetricsRegistry();
        reg.counter({ name: 'a', help: 'test' });
        reg.gauge({ name: 'b', help: 'test' });
        reg.clear();
        expect(reg.getMetric('a')).toBeUndefined();
    });

    it('resets all metric values', () =>
    {
        const reg = new MetricsRegistry();
        const c = reg.counter({ name: 'r', help: 'test' });
        c.inc(10);
        reg.resetAll();
        expect(c.get()).toBe(0);
    });

    it('serializes all metrics to Prometheus text', () =>
    {
        const reg = new MetricsRegistry();
        const c = reg.counter({ name: 'requests_total', help: 'Total requests' });
        const g = reg.gauge({ name: 'active', help: 'Active connections' });
        c.inc(42);
        g.set(7);
        const text = reg.metrics();
        expect(text).toContain('requests_total 42');
        expect(text).toContain('active 7');
        expect(text).toContain('# HELP requests_total Total requests');
    });

    it('toJSON serializes all metrics', () =>
    {
        const reg = new MetricsRegistry();
        const c = reg.counter({ name: 'c', help: 'test' });
        c.inc(5);
        const g = reg.gauge({ name: 'g', help: 'test' });
        g.set(3);
        const h = reg.histogram({ name: 'h', help: 'test', buckets: [1] });
        h.observe(0.5);

        const json = reg.toJSON();
        expect(json.c.type).toBe('counter');
        expect(json.c.entries._).toBe(5);
        expect(json.g.type).toBe('gauge');
        expect(json.g.entries._).toBe(3);
        expect(json.h.type).toBe('histogram');
        expect(json.h.entries._.count).toBe(1);
    });

    it('merge adds counter values', () =>
    {
        const reg = new MetricsRegistry();
        const c = reg.counter({ name: 'c', help: 'test' });
        c.inc(10);

        const snapshot = { c: { type: 'counter', entries: { _: 5 } } };
        reg.merge(snapshot);
        expect(c.get()).toBe(15);
    });

    it('merge adds gauge values', () =>
    {
        const reg = new MetricsRegistry();
        const g = reg.gauge({ name: 'g', help: 'test' });
        g.set(3);

        reg.merge({ g: { type: 'gauge', entries: { _: 7 } } });
        expect(g.get()).toBe(10);
    });

    it('merge adds histogram data', () =>
    {
        const reg = new MetricsRegistry();
        const h = reg.histogram({ name: 'h', help: 'test', buckets: [1, 5] });
        h.observe(0.5);

        const snapshot = {
            h: {
                type: 'histogram',
                entries: { _: { sum: 2.0, count: 3, counts: [2, 1] } },
            },
        };
        reg.merge(snapshot);
        const stats = h.get();
        expect(stats.count).toBe(4);
        expect(stats.sum).toBeCloseTo(2.5);
    });

    it('merge ignores unknown metrics', () =>
    {
        const reg = new MetricsRegistry();
        // Should not throw
        reg.merge({ unknown: { type: 'counter', entries: { _: 5 } } });
    });

    it('merge with labeled metrics', () =>
    {
        const reg = new MetricsRegistry();
        const c = reg.counter({ name: 'c', help: 'test', labels: ['method'] });
        c.inc({ method: 'GET' }, 3);

        // Label key format: values joined by \x00
        reg.merge({ c: { type: 'counter', entries: { 'GET': 2 } } });
        expect(c.get({ method: 'GET' })).toBe(5);
    });
});

// ── Default Metrics ──────────────────────────────────────────────

describe('createDefaultMetrics', () =>
{
    it('creates all standard HTTP metrics', () =>
    {
        const reg = new MetricsRegistry();
        const defaults = createDefaultMetrics(reg);
        expect(defaults.httpRequestsTotal).toBeInstanceOf(Counter);
        expect(defaults.httpRequestDuration).toBeInstanceOf(Histogram);
        expect(defaults.httpActiveConnections).toBeInstanceOf(Gauge);
        expect(defaults.wsConnectionsActive).toBeInstanceOf(Gauge);
        expect(defaults.sseStreamsActive).toBeInstanceOf(Gauge);
        expect(defaults.dbQueryDuration).toBeInstanceOf(Histogram);
        expect(defaults.dbPoolActive).toBeInstanceOf(Gauge);
        expect(defaults.dbPoolIdle).toBeInstanceOf(Gauge);
    });

    it('registers metrics in the registry', () =>
    {
        const reg = new MetricsRegistry();
        createDefaultMetrics(reg);
        expect(reg.getMetric('http_requests_total')).toBeInstanceOf(Counter);
        expect(reg.getMetric('http_request_duration_seconds')).toBeInstanceOf(Histogram);
    });
});

// ── Metrics Middleware ───────────────────────────────────────────

describe('metricsMiddleware', () =>
{
    function mockReqRes(method = 'GET', url = '/test', status = 200)
    {
        const EventEmitter = require('events').EventEmitter;
        const req = { method, url, route: url.split('?')[0], headers: {} };
        const raw = Object.assign(new EventEmitter(), {
            statusCode: status,
            getHeader: () => null,
        });
        return { req, res: { raw }, raw };
    }

    it('creates middleware function', () =>
    {
        const mw = metricsMiddleware();
        expect(typeof mw).toBe('function');
        expect(mw.length).toBe(3);
    });

    it('tracks request count and duration', () =>
    {
        const reg = new MetricsRegistry();
        const mw = metricsMiddleware({ registry: reg });
        const { req, res, raw } = mockReqRes('GET', '/api', 200);

        mw(req, res, () => {});
        raw.emit('finish');

        const total = reg.getMetric('http_requests_total');
        expect(total.get({ method: 'GET', route: '/api', status: '200' })).toBe(1);

        const duration = reg.getMetric('http_request_duration_seconds');
        expect(duration.get({ method: 'GET', route: '/api' }).count).toBe(1);
    });

    it('tracks active connections', () =>
    {
        const reg = new MetricsRegistry();
        const mw = metricsMiddleware({ registry: reg });
        const { req, res, raw } = mockReqRes();
        const active = reg.getMetric('http_active_connections');

        mw(req, res, () => {});
        expect(active.get()).toBe(1);

        raw.emit('finish');
        expect(active.get()).toBe(0);
    });

    it('respects skip option', () =>
    {
        const reg = new MetricsRegistry();
        const mw = metricsMiddleware({
            registry: reg,
            skip: (req) => req.url === '/metrics',
        });
        const { req, res, raw } = mockReqRes('GET', '/metrics');
        let nextCalled = false;
        mw(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        // No finish listener attached due to skip
    });

    it('uses custom routeLabel', () =>
    {
        const reg = new MetricsRegistry();
        const mw = metricsMiddleware({
            registry: reg,
            routeLabel: (req) => req.url.replace(/\/\d+/g, '/:id'),
        });
        const { req, res, raw } = mockReqRes('GET', '/users/123', 200);
        mw(req, res, () => {});
        raw.emit('finish');

        const total = reg.getMetric('http_requests_total');
        expect(total.get({ method: 'GET', route: '/users/:id', status: '200' })).toBe(1);
    });
});

// ── Metrics Endpoint ─────────────────────────────────────────────

describe('metricsEndpoint', () =>
{
    it('returns Prometheus text format', () =>
    {
        const reg = new MetricsRegistry();
        const c = reg.counter({ name: 'test_total', help: 'test' });
        c.inc(42);

        const handler = metricsEndpoint(reg);
        let sentBody;
        const headers = {};
        const res = {
            set: (k, v) => { headers[k] = v; },
            send: (body) => { sentBody = body; },
        };

        handler({}, res);
        expect(headers['Content-Type']).toContain('text/plain');
        expect(headers['Cache-Control']).toBe('no-store');
        expect(sentBody).toContain('test_total 42');
    });
});

// ── Prometheus Text Escaping ─────────────────────────────────────

describe('Prometheus text format', () =>
{
    it('escapes label values with quotes', () =>
    {
        const c = new Counter({ name: 'test', help: 'test', labels: ['msg'] });
        c.inc({ msg: 'hello "world"' });
        const text = c.collect();
        expect(text).toContain('msg="hello \\"world\\""');
    });

    it('escapes backslashes in label values', () =>
    {
        const c = new Counter({ name: 'test', help: 'test', labels: ['path'] });
        c.inc({ path: 'C:\\Users\\test' });
        const text = c.collect();
        expect(text).toContain('path="C:\\\\Users\\\\test"');
    });

    it('escapes newlines in label values', () =>
    {
        const c = new Counter({ name: 'test', help: 'test', labels: ['msg'] });
        c.inc({ msg: 'line1\nline2' });
        const text = c.collect();
        expect(text).toContain('msg="line1\\nline2"');
    });
});

// ── DEFAULT_BUCKETS ──────────────────────────────────────────────

describe('DEFAULT_BUCKETS', () =>
{
    it('is an array of standard HTTP latency buckets', () =>
    {
        expect(Array.isArray(DEFAULT_BUCKETS)).toBe(true);
        expect(DEFAULT_BUCKETS.length).toBeGreaterThan(5);
        expect(DEFAULT_BUCKETS[0]).toBeLessThan(DEFAULT_BUCKETS[DEFAULT_BUCKETS.length - 1]);
    });
});
