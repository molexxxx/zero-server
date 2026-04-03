/**
 * @module observe/metrics
 * @description Zero-dependency metrics registry with Prometheus-compatible
 *              text exposition format. Provides Counter, Gauge, and Histogram
 *              metric types with label support, automatic HTTP instrumentation
 *              middleware, and a handler for `/metrics` endpoints.
 *
 * @example
 *   const { MetricsRegistry, metricsMiddleware } = require('zero-http');
 *
 *   const registry = new MetricsRegistry();
 *   app.use(metricsMiddleware({ registry }));
 *   app.get('/metrics', (req, res) => {
 *       res.set('Content-Type', 'text/plain; version=0.04');
 *       res.send(registry.metrics());
 *   });
 *
 * @example
 *   // Custom metrics
 *   const registry = new MetricsRegistry();
 *   const loginCounter = registry.counter({
 *       name: 'user_logins_total',
 *       help: 'Total user login attempts',
 *       labels: ['provider', 'success'],
 *   });
 *   loginCounter.inc({ provider: 'github', success: 'true' });
 */

// -- Metric Types --------------------------------------------------

/**
 * Prometheus-compatible Counter. Monotonically increasing.
 * Thread-safe for single-threaded Node — no locking needed.
 */
class Counter
{
    /**
     * @constructor
     * @param {object} opts - Counter options.
     * @param {string} opts.name - Metric name (snake_case recommended).
     * @param {string} opts.help - Human-readable description.
     * @param {string[]} [opts.labels=[]] - Label names.
     */
    constructor(opts)
    {
        this.name = opts.name;
        this.help = opts.help || '';
        this.type = 'counter';
        this._labels = opts.labels || [];
        this._values = new Map(); // labelKey => number
        if (this._labels.length === 0) this._values.set('', 0);
    }

    /**
     * Increment the counter.
     *
     * @param {object} [labels] - Label values.
     * @param {number} [value=1] - Amount to increment (must be >= 0).
     *
     * @example
     *   counter.inc();                                    // no labels, +1
     *   counter.inc({ method: 'GET', status: '200' });   // with labels, +1
     *   counter.inc({ method: 'POST' }, 5);              // with labels, +5
     */
    inc(labels, value)
    {
        if (typeof labels === 'number') { value = labels; labels = undefined; }
        const v = value !== undefined ? value : 1;
        if (v < 0) return; // counters can only go up
        const key = _labelKey(this._labels, labels);
        this._values.set(key, (this._values.get(key) || 0) + v);
    }

    /**
     * Get the current value.
     *
     * @param {object} [labels] - Label values.
     * @returns {number} Current counter value.
     */
    get(labels)
    {
        return this._values.get(_labelKey(this._labels, labels)) || 0;
    }

    /**
     * Reset the counter (all label combinations).
     */
    reset()
    {
        this._values.clear();
        if (this._labels.length === 0) this._values.set('', 0);
    }

    /**
     * Serialize to Prometheus text format.
     * @returns {string}
     */
    collect()
    {
        return _serialize(this.name, this.help, 'counter', this._labels, this._values);
    }
}

// -- Gauge ---------------------------------------------------------

/**
 * Prometheus-compatible Gauge. Can go up and down.
 */
class Gauge
{
    /**
     * @constructor
     * @param {object} opts - Gauge options.
     * @param {string} opts.name - Metric name.
     * @param {string} opts.help - Description.
     * @param {string[]} [opts.labels=[]] - Label names.
     * @param {Function} [opts.collect] - Callback invoked before collection to set dynamic values.
     */
    constructor(opts)
    {
        this.name = opts.name;
        this.help = opts.help || '';
        this.type = 'gauge';
        this._labels = opts.labels || [];
        this._values = new Map();
        this._collectFn = typeof opts.collect === 'function' ? opts.collect : null;
        if (this._labels.length === 0) this._values.set('', 0);
    }

    /**
     * Set the gauge to a specific value.
     *
     * @param {object|number} labels - Label values or value (if no labels).
     * @param {number} [value] - Gauge value.
     *
     * @example
     *   gauge.set(42);
     *   gauge.set({ pool: 'primary' }, 10);
     */
    set(labels, value)
    {
        if (typeof labels === 'number') { value = labels; labels = undefined; }
        const key = _labelKey(this._labels, labels);
        this._values.set(key, value);
    }

    /**
     * Increment the gauge.
     *
     * @param {object} [labels] - Label values.
     * @param {number} [value=1] - Amount.
     */
    inc(labels, value)
    {
        if (typeof labels === 'number') { value = labels; labels = undefined; }
        const v = value !== undefined ? value : 1;
        const key = _labelKey(this._labels, labels);
        this._values.set(key, (this._values.get(key) || 0) + v);
    }

    /**
     * Decrement the gauge.
     *
     * @param {object} [labels] - Label values.
     * @param {number} [value=1] - Amount.
     */
    dec(labels, value)
    {
        if (typeof labels === 'number') { value = labels; labels = undefined; }
        const v = value !== undefined ? value : 1;
        const key = _labelKey(this._labels, labels);
        this._values.set(key, (this._values.get(key) || 0) - v);
    }

    /**
     * Get the current value.
     *
     * @param {object} [labels] - Label values.
     * @returns {number} Current gauge value.
     */
    get(labels)
    {
        return this._values.get(_labelKey(this._labels, labels)) || 0;
    }

    /**
     * Reset the gauge (all label combinations).
     */
    reset()
    {
        this._values.clear();
        if (this._labels.length === 0) this._values.set('', 0);
    }

    /**
     * Serialize to Prometheus text format.
     * @returns {string}
     */
    collect()
    {
        if (this._collectFn) this._collectFn(this);
        return _serialize(this.name, this.help, 'gauge', this._labels, this._values);
    }
}

// -- Histogram -----------------------------------------------------

/**
 * Default histogram buckets (HTTP latency, in seconds).
 * @private
 */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Prometheus-compatible Histogram with configurable buckets.
 */
class Histogram
{
    /**
     * @constructor
     * @param {object} opts - Histogram options.
     * @param {string} opts.name - Metric name.
     * @param {string} opts.help - Description.
     * @param {string[]} [opts.labels=[]] - Label names (must not include 'le').
     * @param {number[]} [opts.buckets] - Upper bounds for buckets. Default: HTTP latency buckets.
     */
    constructor(opts)
    {
        this.name = opts.name;
        this.help = opts.help || '';
        this.type = 'histogram';
        this._labels = (opts.labels || []).filter(l => l !== 'le');
        this._buckets = (opts.buckets || DEFAULT_BUCKETS).slice().sort((a, b) => a - b);
        this._data = new Map(); // labelKey => { counts: number[], sum: number, count: number }
    }

    /**
     * Observe a value.
     *
     * @param {object|number} labels - Label values or value (if no labels).
     * @param {number} [value] - Observed value.
     *
     * @example
     *   histogram.observe(0.235);                         // no labels
     *   histogram.observe({ method: 'GET' }, 0.042);      // with labels
     */
    observe(labels, value)
    {
        if (typeof labels === 'number') { value = labels; labels = undefined; }
        const key = _labelKey(this._labels, labels);
        let data = this._data.get(key);
        if (!data)
        {
            data = { counts: new Array(this._buckets.length).fill(0), sum: 0, count: 0 };
            this._data.set(key, data);
        }
        data.sum += value;
        data.count += 1;
        for (let i = 0; i < this._buckets.length; i++)
        {
            if (value <= this._buckets[i]) data.counts[i]++;
        }
    }

    /**
     * Start a timer that, when stopped, observes the elapsed duration in seconds.
     *
     * @param {object} [labels] - Label values.
     * @returns {Function} Stop function — call it to record the duration.
     *
     * @example
     *   const end = histogram.startTimer({ method: 'GET' });
     *   await doWork();
     *   end(); // records duration
     */
    startTimer(labels)
    {
        const start = process.hrtime.bigint();
        return () =>
        {
            const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
            this.observe(labels, elapsed);
        };
    }

    /**
     * Get summary stats for a label combination.
     *
     * @param {object} [labels] - Label values.
     * @returns {{ sum: number, count: number }|null} Stats or null.
     */
    get(labels)
    {
        const data = this._data.get(_labelKey(this._labels, labels));
        return data ? { sum: data.sum, count: data.count } : null;
    }

    /**
     * Reset all observations.
     */
    reset()
    {
        this._data.clear();
    }

    /**
     * Serialize to Prometheus text format.
     * @returns {string}
     */
    collect()
    {
        const lines = [];
        lines.push(`# HELP ${this.name} ${this.help}`);
        lines.push(`# TYPE ${this.name} histogram`);

        for (const [key, data] of this._data)
        {
            const labelObj = _parseLabelKey(this._labels, key);

            // Bucket counts (already cumulative from observe())
            for (let i = 0; i < this._buckets.length; i++)
            {
                const bucketLabels = { ...labelObj, le: String(this._buckets[i]) };
                lines.push(`${this.name}_bucket${_formatLabels(bucketLabels)} ${data.counts[i]}`);
            }
            // +Inf bucket
            const infLabels = { ...labelObj, le: '+Inf' };
            lines.push(`${this.name}_bucket${_formatLabels(infLabels)} ${data.count}`);

            // Sum and count
            const baseLabels = Object.keys(labelObj).length > 0 ? _formatLabels(labelObj) : '';
            lines.push(`${this.name}_sum${baseLabels} ${data.sum}`);
            lines.push(`${this.name}_count${baseLabels} ${data.count}`);
        }

        return lines.join('\n');
    }
}

// -- Metrics Registry ----------------------------------------------

/**
 * Central metrics registry. Manages all metric instances and
 * serialises them to Prometheus text exposition format.
 *
 * @example
 *   const registry = new MetricsRegistry({ prefix: 'myapp_' });
 *   const counter = registry.counter({ name: 'requests_total', help: 'Total requests' });
 *   counter.inc();
 *   console.log(registry.metrics());
 */
class MetricsRegistry
{
    /**
     * @constructor
     * @param {object} [opts] - Registry options.
     * @param {string} [opts.prefix=''] - Global prefix for all metric names.
     */
    constructor(opts = {})
    {
        this._prefix = opts.prefix || '';
        /** @type {Map<string, Counter|Gauge|Histogram>} */
        this._metrics = new Map();
    }

    /**
     * Create and register a Counter.
     *
     * @param {object} opts - Counter options.
     * @param {string} opts.name - Metric name.
     * @param {string} opts.help - Description.
     * @param {string[]} [opts.labels] - Label names.
     * @returns {Counter} The registered counter.
     *
     * @example
     *   const c = registry.counter({ name: 'http_requests_total', help: 'Total HTTP requests', labels: ['method', 'status'] });
     */
    counter(opts)
    {
        const name = this._prefix + opts.name;
        if (this._metrics.has(name)) return this._metrics.get(name);
        const c = new Counter({ ...opts, name });
        this._metrics.set(name, c);
        return c;
    }

    /**
     * Create and register a Gauge.
     *
     * @param {object} opts - Gauge options.
     * @param {string} opts.name - Metric name.
     * @param {string} opts.help - Description.
     * @param {string[]} [opts.labels] - Label names.
     * @param {Function} [opts.collect] - Dynamic collection callback.
     * @returns {Gauge} The registered gauge.
     *
     * @example
     *   const g = registry.gauge({ name: 'process_memory_bytes', help: 'Memory usage',
     *       collect: (gauge) => gauge.set(process.memoryUsage().heapUsed) });
     */
    gauge(opts)
    {
        const name = this._prefix + opts.name;
        if (this._metrics.has(name)) return this._metrics.get(name);
        const g = new Gauge({ ...opts, name });
        this._metrics.set(name, g);
        return g;
    }

    /**
     * Create and register a Histogram.
     *
     * @param {object} opts - Histogram options.
     * @param {string} opts.name - Metric name.
     * @param {string} opts.help - Description.
     * @param {string[]} [opts.labels] - Label names.
     * @param {number[]} [opts.buckets] - Bucket boundaries.
     * @returns {Histogram} The registered histogram.
     *
     * @example
     *   const h = registry.histogram({ name: 'http_request_duration_seconds', help: 'Request duration', labels: ['method', 'route'] });
     */
    histogram(opts)
    {
        const name = this._prefix + opts.name;
        if (this._metrics.has(name)) return this._metrics.get(name);
        const h = new Histogram({ ...opts, name });
        this._metrics.set(name, h);
        return h;
    }

    /**
     * Get a registered metric by name.
     *
     * @param {string} name - Full metric name (including prefix).
     * @returns {Counter|Gauge|Histogram|undefined}
     */
    getMetric(name)
    {
        return this._metrics.get(this._prefix + name) || this._metrics.get(name);
    }

    /**
     * Remove a registered metric.
     *
     * @param {string} name - Metric name.
     * @returns {boolean} True if removed.
     */
    removeMetric(name)
    {
        return this._metrics.delete(this._prefix + name) || this._metrics.delete(name);
    }

    /**
     * Remove all registered metrics.
     */
    clear()
    {
        this._metrics.clear();
    }

    /**
     * Reset all metric values without removing registrations.
     */
    resetAll()
    {
        for (const m of this._metrics.values()) m.reset();
    }

    /**
     * Serialize all metrics to Prometheus text exposition format.
     *
     * @returns {string} Multi-line Prometheus-compatible text.
     *
     * @example
     *   const text = registry.metrics();
     *   // # HELP http_requests_total Total HTTP requests
     *   // # TYPE http_requests_total counter
     *   // http_requests_total{method="GET",status="200"} 42
     */
    metrics()
    {
        const parts = [];
        for (const m of this._metrics.values())
        {
            const text = m.collect();
            if (text) parts.push(text);
        }
        return parts.join('\n\n') + '\n';
    }

    /**
     * Return all metrics as a plain object (for JSON export or IPC transfer).
     *
     * @returns {object} Serialisable snapshot of all metrics.
     */
    toJSON()
    {
        const result = {};
        for (const [name, m] of this._metrics)
        {
            if (m.type === 'histogram')
            {
                const entries = {};
                for (const [key, data] of m._data)
                {
                    entries[key || '_'] = { sum: data.sum, count: data.count, counts: data.counts.slice() };
                }
                result[name] = { type: m.type, entries };
            }
            else
            {
                const entries = {};
                for (const [key, val] of m._values) entries[key || '_'] = val;
                result[name] = { type: m.type, entries };
            }
        }
        return result;
    }

    /**
     * Merge a metrics snapshot (from `toJSON()`) into this registry.
     * Used for aggregating worker metrics on the primary process.
     *
     * @param {object} snapshot - Object from `toJSON()`.
     *
     * @example
     *   // On primary
     *   mgr.onMessage('metrics:report', (data) => {
     *       primaryRegistry.merge(data);
     *   });
     */
    merge(snapshot)
    {
        for (const [name, data] of Object.entries(snapshot))
        {
            const metric = this._metrics.get(name);
            if (!metric) continue;

            if (data.type === 'histogram' && metric.type === 'histogram')
            {
                for (const [key, entry] of Object.entries(data.entries))
                {
                    const resolvedKey = key === '_' ? '' : key;
                    let existing = metric._data.get(resolvedKey);
                    if (!existing)
                    {
                        existing = { counts: new Array(metric._buckets.length).fill(0), sum: 0, count: 0 };
                        metric._data.set(resolvedKey, existing);
                    }
                    existing.sum += entry.sum;
                    existing.count += entry.count;
                    for (let i = 0; i < existing.counts.length && i < entry.counts.length; i++)
                    {
                        existing.counts[i] += entry.counts[i];
                    }
                }
            }
            else if (data.type === 'counter' && metric.type === 'counter')
            {
                for (const [key, val] of Object.entries(data.entries))
                {
                    const resolvedKey = key === '_' ? '' : key;
                    metric._values.set(resolvedKey, (metric._values.get(resolvedKey) || 0) + val);
                }
            }
            else if (data.type === 'gauge' && metric.type === 'gauge')
            {
                // For gauges from workers, we sum them (active connections across workers)
                for (const [key, val] of Object.entries(data.entries))
                {
                    const resolvedKey = key === '_' ? '' : key;
                    metric._values.set(resolvedKey, (metric._values.get(resolvedKey) || 0) + val);
                }
            }
        }
    }
}

// -- Default HTTP Metrics ------------------------------------------

/**
 * Create the standard set of HTTP metrics on a registry.
 *
 * @param {MetricsRegistry} registry - Target registry.
 * @returns {object} Object with all default metric instances.
 */
function createDefaultMetrics(registry)
{
    return {
        httpRequestsTotal: registry.counter({
            name: 'http_requests_total',
            help: 'Total HTTP requests processed',
            labels: ['method', 'route', 'status'],
        }),
        httpRequestDuration: registry.histogram({
            name: 'http_request_duration_seconds',
            help: 'HTTP request duration in seconds',
            labels: ['method', 'route'],
        }),
        httpActiveConnections: registry.gauge({
            name: 'http_active_connections',
            help: 'Number of active HTTP connections',
        }),
        wsConnectionsActive: registry.gauge({
            name: 'ws_connections_active',
            help: 'Number of active WebSocket connections',
        }),
        sseStreamsActive: registry.gauge({
            name: 'sse_streams_active',
            help: 'Number of active SSE streams',
        }),
        dbQueryDuration: registry.histogram({
            name: 'db_query_duration_seconds',
            help: 'Database query duration in seconds',
            labels: ['adapter', 'operation'],
        }),
        dbPoolActive: registry.gauge({
            name: 'db_pool_active',
            help: 'Active database pool connections',
        }),
        dbPoolIdle: registry.gauge({
            name: 'db_pool_idle',
            help: 'Idle database pool connections',
        }),
    };
}

// -- Metrics Middleware --------------------------------------------

/**
 * Create HTTP metrics collection middleware.
 * Automatically tracks `http_requests_total`, `http_request_duration_seconds`,
 * and `http_active_connections`.
 *
 * @param {object} [opts] - Options.
 * @param {MetricsRegistry} [opts.registry] - Metrics registry. Creates a new one if not provided.
 * @param {Function} [opts.routeLabel] - `(req) => string` — extract route label for metrics. Default: `req.route || req.url`.
 * @param {Function} [opts.skip] - `(req) => boolean` — skip metrics for certain requests.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   const registry = new MetricsRegistry();
 *   app.use(metricsMiddleware({ registry }));
 *   app.get('/metrics', (req, res) => {
 *       res.set('Content-Type', 'text/plain; version=0.04');
 *       res.send(registry.metrics());
 *   });
 */
function metricsMiddleware(opts = {})
{
    const registry = opts.registry || new MetricsRegistry();
    const defaults = createDefaultMetrics(registry);
    const routeLabel = typeof opts.routeLabel === 'function' ? opts.routeLabel : null;
    const skip = typeof opts.skip === 'function' ? opts.skip : null;

    return (req, res, next) =>
    {
        if (skip && skip(req)) return next();

        const start = process.hrtime.bigint();
        defaults.httpActiveConnections.inc();

        const raw = res.raw || res;
        const onFinish = () =>
        {
            raw.removeListener('finish', onFinish);
            defaults.httpActiveConnections.dec();

            const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
            const status = String(raw.statusCode || 200);
            const method = req.method;
            const route = routeLabel ? routeLabel(req) : (req.route || req.url?.split('?')[0] || '/');

            defaults.httpRequestsTotal.inc({ method, route, status });
            defaults.httpRequestDuration.observe({ method, route }, elapsed);
        };

        raw.on('finish', onFinish);
        next();
    };
}

/**
 * Create a metrics endpoint handler.
 * Returns Prometheus text exposition format.
 *
 * @param {MetricsRegistry} registry - The registry to expose.
 * @returns {Function} Route handler `(req, res) => void`.
 *
 * @example
 *   app.get('/metrics', metricsEndpoint(registry));
 */
function metricsEndpoint(registry)
{
    return (req, res) =>
    {
        const body = registry.metrics();
        res.set('Content-Type', 'text/plain; version=0.04; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.send(body);
    };
}

// -- Helpers -------------------------------------------------------

/**
 * Create a label key string from label names and values.
 * @private
 */
function _labelKey(labelNames, labels)
{
    if (!labelNames || labelNames.length === 0 || !labels) return '';
    return labelNames.map(n => String(labels[n] ?? '')).join('\x00');
}

/**
 * Parse a label key back to an object.
 * @private
 */
function _parseLabelKey(labelNames, key)
{
    if (!key || labelNames.length === 0) return {};
    const parts = key.split('\x00');
    const obj = {};
    for (let i = 0; i < labelNames.length; i++)
    {
        if (parts[i]) obj[labelNames[i]] = parts[i];
    }
    return obj;
}

/**
 * Format a labels object as Prometheus label string.
 * @private
 */
function _formatLabels(obj)
{
    const keys = Object.keys(obj);
    if (keys.length === 0) return '';
    const pairs = keys.map(k =>
    {
        const v = String(obj[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        return `${k}="${v}"`;
    });
    return `{${pairs.join(',')}}`;
}

/**
 * Serialize a counter/gauge metric to Prometheus text.
 * @private
 */
function _serialize(name, help, type, labelNames, values)
{
    const lines = [];
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const [key, val] of values)
    {
        const labelObj = _parseLabelKey(labelNames, key);
        const labels = _formatLabels(labelObj);
        lines.push(`${name}${labels} ${val}`);
    }
    return lines.join('\n');
}

module.exports = {
    Counter,
    Gauge,
    Histogram,
    MetricsRegistry,
    DEFAULT_BUCKETS,
    createDefaultMetrics,
    metricsMiddleware,
    metricsEndpoint,
};
