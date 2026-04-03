/**
 * @module observe/tracing
 * @description Zero-dependency distributed tracing with W3C Trace Context
 *              propagation. Provides span creation, context propagation via
 *              `traceparent`/`tracestate` headers, and auto-instrumentation
 *              middleware for HTTP, ORM queries, WebSocket, SSE, and
 *              outbound fetch calls.
 *
 *              Compatible with OpenTelemetry: spans export in OTLP-like
 *              format and support configurable exporters for Jaeger, Zipkin,
 *              or any custom backend.
 *
 * @example
 *   const { tracingMiddleware, Tracer } = require('zero-http');
 *
 *   const tracer = new Tracer({ serviceName: 'my-api' });
 *   app.use(tracingMiddleware({ tracer }));
 *
 * @example
 *   // With exporter
 *   const tracer = new Tracer({
 *       serviceName: 'my-api',
 *       exporter: (spans) => fetch('http://jaeger:4318/v1/traces', {
 *           method: 'POST',
 *           body: JSON.stringify(spans),
 *       }),
 *   });
 */
const crypto = require('crypto');

// -- Span & Context -----------------------------------------------

/**
 * Immutable identifier for a trace.
 * @param {string} [id] - 32-char lowercase hex, or auto-generated.
 * @returns {string}
 * @private
 */
function _traceId(id)
{
    if (id && /^[0-9a-f]{32}$/.test(id)) return id;
    return crypto.randomBytes(16).toString('hex');
}

/**
 * 16-char hex span ID.
 * @returns {string}
 * @private
 */
function _spanId()
{
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Parse W3C `traceparent` header.
 * Format: `{version}-{traceId}-{parentSpanId}-{traceFlags}`
 *
 * @param {string} header - traceparent header value.
 * @returns {{ traceId: string, parentSpanId: string, traceFlags: number }|null}
 * @private
 */
function parseTraceparent(header)
{
    if (!header || typeof header !== 'string') return null;
    const parts = header.trim().split('-');
    if (parts.length < 4) return null;
    const [version, traceId, parentSpanId, flags] = parts;
    if (version.length !== 2 || traceId.length !== 32 || parentSpanId.length !== 16) return null;
    if (!/^[0-9a-f]+$/.test(traceId) || !/^[0-9a-f]+$/.test(parentSpanId)) return null;
    // All-zero traceId or spanId is invalid per spec
    if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
    return {
        traceId,
        parentSpanId,
        traceFlags: parseInt(flags, 16) || 0,
    };
}

/**
 * Format a traceparent header value.
 *
 * @param {string} traceId - 32-char trace ID.
 * @param {string} spanId - 16-char span ID.
 * @param {number} [flags=1] - Trace flags (1 = sampled).
 * @returns {string} W3C traceparent header value.
 * @private
 */
function formatTraceparent(traceId, spanId, flags = 1)
{
    return `00-${traceId}-${spanId}-${String(flags).padStart(2, '0')}`;
}

// -- Span ----------------------------------------------------------

/**
 * Represents a unit of work in a distributed trace.
 * Tracks timing, status, attributes, and events.
 */
class Span
{
    /**
     * @constructor
     * @param {object} opts - Span options.
     * @param {string} opts.name - Operation name.
     * @param {string} opts.traceId - Trace ID.
     * @param {string} [opts.parentSpanId] - Parent span ID.
     * @param {string} [opts.kind='server'] - Span kind: 'server', 'client', 'producer', 'consumer', 'internal'.
     * @param {object} [opts.attributes] - Initial attributes.
     * @param {Tracer} [opts.tracer] - Tracer instance for export.
     */
    constructor(opts)
    {
        this.name = opts.name;
        this.traceId = opts.traceId;
        this.spanId = _spanId();
        this.parentSpanId = opts.parentSpanId || null;
        this.kind = opts.kind || 'server';
        this.attributes = opts.attributes ? { ...opts.attributes } : {};
        this.events = [];
        this.status = { code: 0 }; // 0=UNSET, 1=OK, 2=ERROR
        this.startTime = Date.now();
        this.endTime = null;
        this._tracer = opts.tracer || null;
    }

    /**
     * Set a span attribute.
     *
     * @param {string} key - Attribute name (OpenTelemetry semantic convention recommended).
     * @param {string|number|boolean} value - Attribute value.
     * @returns {Span} this
     *
     * @example
     *   span.setAttribute('http.method', 'GET');
     *   span.setAttribute('http.status_code', 200);
     */
    setAttribute(key, value)
    {
        this.attributes[key] = value;
        return this;
    }

    /**
     * Set multiple attributes at once.
     *
     * @param {object} attrs - Key-value pairs.
     * @returns {Span} this
     */
    setAttributes(attrs)
    {
        Object.assign(this.attributes, attrs);
        return this;
    }

    /**
     * Add a timestamped event to the span.
     *
     * @param {string} name - Event name.
     * @param {object} [attributes] - Event attributes.
     * @returns {Span} this
     *
     * @example
     *   span.addEvent('cache.miss', { key: 'user:123' });
     */
    addEvent(name, attributes)
    {
        this.events.push({
            name,
            timestamp: Date.now(),
            attributes: attributes || {},
        });
        return this;
    }

    /**
     * Set status to OK.
     * @returns {Span} this
     */
    setOk()
    {
        this.status = { code: 1 };
        return this;
    }

    /**
     * Set status to ERROR.
     *
     * @param {string} [message] - Error description.
     * @returns {Span} this
     */
    setError(message)
    {
        this.status = { code: 2, message };
        return this;
    }

    /**
     * Record an exception as a span event and set error status.
     *
     * @param {Error} err - The exception.
     * @returns {Span} this
     */
    recordException(err)
    {
        this.addEvent('exception', {
            'exception.type': err.constructor?.name || 'Error',
            'exception.message': err.message,
            'exception.stacktrace': err.stack,
        });
        return this.setError(err.message);
    }

    /**
     * End the span and report to the tracer.
     * @returns {Span} this
     */
    end()
    {
        if (this.endTime) return this; // already ended
        this.endTime = Date.now();
        if (this._tracer) this._tracer._report(this);
        return this;
    }

    /**
     * Duration in milliseconds (or null if not ended).
     * @type {number|null}
     */
    get duration()
    {
        if (!this.endTime) return null;
        return this.endTime - this.startTime;
    }

    /**
     * The traceparent header value for this span.
     * @type {string}
     */
    get traceparent()
    {
        return formatTraceparent(this.traceId, this.spanId);
    }

    /**
     * Serialize span for export.
     * @returns {object} OTLP-compatible span object.
     */
    toJSON()
    {
        return {
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId,
            name: this.name,
            kind: this.kind,
            startTime: this.startTime,
            endTime: this.endTime,
            duration: this.duration,
            status: this.status,
            attributes: this.attributes,
            events: this.events,
        };
    }
}

// -- Tracer --------------------------------------------------------

/**
 * Creates and manages spans for distributed tracing.
 * Batches completed spans and flushes them to the configured exporter.
 *
 * @example
 *   const tracer = new Tracer({
 *       serviceName: 'payments-api',
 *       exporter: (spans) => fetch('http://jaeger:4318/v1/traces', {
 *           method: 'POST',
 *           headers: { 'Content-Type': 'application/json' },
 *           body: JSON.stringify(spans),
 *       }),
 *       batchSize: 50,
 *       flushInterval: 5000,
 *   });
 */
class Tracer
{
    /**
     * @constructor
     * @param {object} [opts] - Tracer options.
     * @param {string} [opts.serviceName='unknown'] - Service name for all spans.
     * @param {Function} [opts.exporter] - `(spans: object[]) => void | Promise<void>` — called with batches of serialised spans.
     * @param {number} [opts.batchSize=100] - Max spans per export batch.
     * @param {number} [opts.flushInterval=5000] - Auto-flush interval in ms.
     * @param {number} [opts.sampleRate=1.0] - Sampling rate (0.0 to 1.0). 1.0 = sample everything.
     * @param {object} [opts.resource] - Extra resource attributes (e.g. `{ 'deployment.environment': 'prod' }`).
     */
    constructor(opts = {})
    {
        this.serviceName = opts.serviceName || 'unknown';
        this._exporter = typeof opts.exporter === 'function' ? opts.exporter : null;
        this._batchSize = opts.batchSize || 100;
        this._sampleRate = typeof opts.sampleRate === 'number' ? Math.max(0, Math.min(1, opts.sampleRate)) : 1.0;
        this._resource = {
            'service.name': this.serviceName,
            ...(opts.resource || {}),
        };
        this._buffer = [];
        this._listeners = [];

        // Auto-flush timer
        this._flushTimer = null;
        if (opts.flushInterval !== 0)
        {
            const interval = opts.flushInterval || 5000;
            this._flushTimer = setInterval(() => this.flush(), interval);
            if (this._flushTimer.unref) this._flushTimer.unref();
        }
    }

    /**
     * Create a new span.
     *
     * @param {string} name - Span/operation name.
     * @param {object} [opts] - Span options.
     * @param {string} [opts.traceId] - Trace ID (inherits from parent context or generates new).
     * @param {string} [opts.parentSpanId] - Parent span ID.
     * @param {string} [opts.kind='server'] - Span kind.
     * @param {object} [opts.attributes] - Initial attributes.
     * @returns {Span} The new span.
     *
     * @example
     *   const span = tracer.startSpan('GET /users', {
     *       attributes: { 'http.method': 'GET', 'http.url': '/users' },
     *   });
     *   try {
     *       await handleRequest();
     *       span.setOk();
     *   } catch (err) {
     *       span.recordException(err);
     *   } finally {
     *       span.end();
     *   }
     */
    startSpan(name, opts = {})
    {
        return new Span({
            name,
            traceId: opts.traceId || _traceId(),
            parentSpanId: opts.parentSpanId,
            kind: opts.kind || 'server',
            attributes: {
                ...this._resource,
                ...(opts.attributes || {}),
            },
            tracer: this,
        });
    }

    /**
     * Whether a new trace should be sampled.
     * @returns {boolean}
     */
    shouldSample()
    {
        if (this._sampleRate >= 1.0) return true;
        if (this._sampleRate <= 0) return false;
        return Math.random() < this._sampleRate;
    }

    /**
     * Register a listener for completed spans.
     *
     * @param {Function} fn - `(span: Span) => void`.
     * @returns {Tracer} this
     */
    onSpanEnd(fn)
    {
        if (typeof fn === 'function') this._listeners.push(fn);
        return this;
    }

    /**
     * Receive a completed span.
     * @private
     * @param {Span} span
     */
    _report(span)
    {
        // Notify listeners
        for (const fn of this._listeners)
        {
            try { fn(span); }
            catch (_) { /* don't let listener errors break tracing */ }
        }

        if (!this._exporter) return;

        this._buffer.push(span.toJSON());
        if (this._buffer.length >= this._batchSize) this.flush();
    }

    /**
     * Flush buffered spans to the exporter.
     *
     * @returns {Promise<void>}
     */
    async flush()
    {
        if (this._buffer.length === 0 || !this._exporter) return;
        const batch = this._buffer.splice(0, this._buffer.length);
        try
        {
            await this._exporter(batch);
        }
        catch (_)
        {
            // Silently drop export errors — tracing should never break the app
        }
    }

    /**
     * Shut down the tracer, flushing remaining spans.
     *
     * @returns {Promise<void>}
     */
    async shutdown()
    {
        if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
        await this.flush();
    }
}

// -- Tracing Middleware --------------------------------------------

/**
 * Create HTTP tracing middleware.
 * Automatically creates a span for each request, extracts incoming
 * `traceparent`/`tracestate` headers, and sets outgoing `traceparent`.
 *
 * @param {object} [opts] - Options.
 * @param {Tracer} [opts.tracer] - Tracer instance. Creates a default if not provided.
 * @param {Function} [opts.routeLabel] - `(req) => string` — extract route label for span name.
 * @param {Function} [opts.skip] - `(req) => boolean` — skip tracing for certain requests.
 * @param {boolean} [opts.propagate=true] - Propagate W3C trace context via response headers.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(tracingMiddleware({ tracer }));
 *
 * @example
 *   // With sampling
 *   const tracer = new Tracer({ serviceName: 'api', sampleRate: 0.1 });
 *   app.use(tracingMiddleware({ tracer }));
 */
function tracingMiddleware(opts = {})
{
    const tracer = opts.tracer || new Tracer(opts);
    const getRoute = typeof opts.routeLabel === 'function' ? opts.routeLabel : null;
    const skip = typeof opts.skip === 'function' ? opts.skip : null;
    const propagate = opts.propagate !== false;

    return (req, res, next) =>
    {
        if (skip && skip(req)) return next();

        // Parse incoming trace context
        const incoming = parseTraceparent(req.headers?.traceparent || req.headers?.['traceparent']);
        const traceId = incoming?.traceId;
        const parentSpanId = incoming?.parentSpanId;

        // Sampling decision
        if (!tracer.shouldSample() && !incoming) return next();

        const spanName = `${req.method} ${getRoute ? getRoute(req) : (req.url?.split('?')[0] || '/')}`;
        const span = tracer.startSpan(spanName, {
            traceId,
            parentSpanId,
            kind: 'server',
            attributes: {
                'http.method': req.method,
                'http.url': req.originalUrl || req.url,
                'http.target': req.url?.split('?')[0],
                'http.host': req.headers?.host,
                'http.scheme': req.secure ? 'https' : 'http',
                'http.user_agent': req.headers?.['user-agent'],
                'net.peer.ip': req.ip || req.socket?.remoteAddress,
            },
        });

        // Attach to request for downstream use
        req.span = span;
        req.traceId = span.traceId;

        // Propagate tracestate if present
        const tracestate = req.headers?.tracestate || req.headers?.['tracestate'];
        if (tracestate) span.setAttribute('tracestate', tracestate);

        // Set response headers for propagation
        if (propagate)
        {
            res.set('traceparent', span.traceparent);
            if (tracestate) res.set('tracestate', tracestate);
        }

        // Hook into response finish
        const raw = res.raw || res;
        const onFinish = () =>
        {
            raw.removeListener('finish', onFinish);
            const status = raw.statusCode || 200;
            span.setAttribute('http.status_code', status);
            span.setAttribute('http.response_content_length', parseInt(raw.getHeader?.('content-length') || '0', 10) || 0);

            if (req.route) span.setAttribute('http.route', req.route);
            if (req.id) span.setAttribute('http.request_id', req.id);

            if (status >= 500) span.setError(`HTTP ${status}`);
            else span.setOk();

            span.end();
        };

        raw.on('finish', onFinish);
        next();
    };
}

/**
 * Instrument outbound fetch calls with tracing.
 * Wraps the zero-http fetch to inject `traceparent` headers
 * and create client spans.
 *
 * @param {Function} fetchFn - The original fetch function.
 * @param {Tracer} tracer - Tracer instance.
 * @returns {Function} Instrumented fetch with same signature.
 *
 * @example
 *   const { fetch, Tracer, instrumentFetch } = require('zero-http');
 *   const tracer = new Tracer({ serviceName: 'my-api' });
 *   const tracedFetch = instrumentFetch(fetch, tracer);
 *
 *   const res = await tracedFetch('https://api.example.com/data');
 */
function instrumentFetch(fetchFn, tracer)
{
    return function tracedFetch(url, opts = {})
    {
        if (!tracer) return fetchFn(url, opts);

        const parsedUrl = typeof url === 'string' ? url : String(url);
        let host = '';
        try { host = new URL(parsedUrl).host; } catch (_) { /* ignore */ }

        const span = tracer.startSpan(`HTTP ${(opts.method || 'GET').toUpperCase()} ${host}`, {
            kind: 'client',
            attributes: {
                'http.method': (opts.method || 'GET').toUpperCase(),
                'http.url': parsedUrl,
                'net.peer.name': host,
            },
        });

        // Inject traceparent
        const headers = Object.assign({}, opts.headers || {});
        headers.traceparent = span.traceparent;

        return fetchFn(url, { ...opts, headers })
            .then(res =>
            {
                span.setAttribute('http.status_code', res.status);
                if (res.status >= 400) span.setError(`HTTP ${res.status}`);
                else span.setOk();
                span.end();
                return res;
            })
            .catch(err =>
            {
                span.recordException(err);
                span.end();
                throw err;
            });
    };
}

module.exports = {
    Span,
    Tracer,
    parseTraceparent,
    formatTraceparent,
    tracingMiddleware,
    instrumentFetch,
};
