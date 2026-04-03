const {
    Span, Tracer,
    parseTraceparent, formatTraceparent,
    tracingMiddleware, instrumentFetch,
} = require('../../lib/observe/tracing');

// ── parseTraceparent ─────────────────────────────────────────────

describe('parseTraceparent', () =>
{
    it('parses a valid traceparent header', () =>
    {
        const result = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
        expect(result).toEqual({
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            parentSpanId: '00f067aa0ba902b7',
            traceFlags: 1,
        });
    });

    it('returns null for null/undefined', () =>
    {
        expect(parseTraceparent(null)).toBeNull();
        expect(parseTraceparent(undefined)).toBeNull();
    });

    it('returns null for empty string', () =>
    {
        expect(parseTraceparent('')).toBeNull();
    });

    it('returns null for non-string', () =>
    {
        expect(parseTraceparent(123)).toBeNull();
    });

    it('returns null for malformed header (too few parts)', () =>
    {
        expect(parseTraceparent('00-abc-def')).toBeNull();
    });

    it('returns null for wrong-length traceId', () =>
    {
        expect(parseTraceparent('00-shortid-00f067aa0ba902b7-01')).toBeNull();
    });

    it('returns null for wrong-length spanId', () =>
    {
        expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-short-01')).toBeNull();
    });

    it('returns null for all-zero traceId', () =>
    {
        expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    });

    it('returns null for all-zero spanId', () =>
    {
        expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
    });

    it('returns null for non-hex traceId', () =>
    {
        expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0eXXXX-00f067aa0ba902b7-01')).toBeNull();
    });

    it('handles flags = 00 (not sampled)', () =>
    {
        const result = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
        expect(result.traceFlags).toBe(0);
    });

    it('trims whitespace', () =>
    {
        const result = parseTraceparent('  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  ');
        expect(result.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    });
});

// ── formatTraceparent ────────────────────────────────────────────

describe('formatTraceparent', () =>
{
    it('formats a valid traceparent string', () =>
    {
        const result = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
        expect(result).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    });

    it('zero-pads flags', () =>
    {
        const result = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', 0);
        expect(result).toMatch(/-00$/);
    });

    it('supports custom flags', () =>
    {
        const result = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', 1);
        expect(result).toMatch(/-01$/);
    });
});

// ── Span ─────────────────────────────────────────────────────────

describe('Span', () =>
{
    it('creates with name, traceId, spanId', () =>
    {
        const span = new Span({ name: 'test-op', traceId: 'a'.repeat(32) });
        expect(span.name).toBe('test-op');
        expect(span.traceId).toBe('a'.repeat(32));
        expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
        expect(span.parentSpanId).toBeNull();
        expect(span.kind).toBe('server');
    });

    it('accepts parentSpanId and kind', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16), kind: 'client' });
        expect(span.parentSpanId).toBe('b'.repeat(16));
        expect(span.kind).toBe('client');
    });

    it('accepts initial attributes', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32), attributes: { foo: 'bar' } });
        expect(span.attributes.foo).toBe('bar');
    });

    it('setAttribute returns this', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        const result = span.setAttribute('key', 'val');
        expect(result).toBe(span);
        expect(span.attributes.key).toBe('val');
    });

    it('setAttributes merges object', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32), attributes: { a: 1 } });
        span.setAttributes({ b: 2, c: 3 });
        expect(span.attributes).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('addEvent records timestamped event', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        span.addEvent('cache.miss', { key: 'user:1' });
        expect(span.events).toHaveLength(1);
        expect(span.events[0].name).toBe('cache.miss');
        expect(span.events[0].attributes.key).toBe('user:1');
        expect(typeof span.events[0].timestamp).toBe('number');
    });

    it('addEvent without attributes', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        span.addEvent('checkpoint');
        expect(span.events[0].attributes).toEqual({});
    });

    it('setOk sets status code 1', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        span.setOk();
        expect(span.status.code).toBe(1);
    });

    it('setError sets status code 2 with message', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        span.setError('boom');
        expect(span.status.code).toBe(2);
        expect(span.status.message).toBe('boom');
    });

    it('recordException creates event and sets error status', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        const err = new TypeError('type issue');
        span.recordException(err);
        expect(span.status.code).toBe(2);
        expect(span.events).toHaveLength(1);
        expect(span.events[0].name).toBe('exception');
        expect(span.events[0].attributes['exception.type']).toBe('TypeError');
        expect(span.events[0].attributes['exception.message']).toBe('type issue');
        expect(span.events[0].attributes['exception.stacktrace']).toContain('TypeError');
    });

    it('end sets endTime', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        expect(span.endTime).toBeNull();
        span.end();
        expect(span.endTime).toBeGreaterThan(0);
    });

    it('end is idempotent', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        span.end();
        const t = span.endTime;
        span.end();
        expect(span.endTime).toBe(t);
    });

    it('duration is null before end', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        expect(span.duration).toBeNull();
    });

    it('duration is computed after end', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        span.end();
        expect(typeof span.duration).toBe('number');
        expect(span.duration).toBeGreaterThanOrEqual(0);
    });

    it('traceparent returns W3C header', () =>
    {
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32) });
        const tp = span.traceparent;
        expect(tp).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
    });

    it('toJSON serializes all fields', () =>
    {
        const span = new Span({ name: 'test', traceId: 'a'.repeat(32), kind: 'client' });
        span.setAttribute('http.method', 'GET');
        span.addEvent('start');
        span.setOk();
        span.end();

        const json = span.toJSON();
        expect(json.name).toBe('test');
        expect(json.traceId).toBe('a'.repeat(32));
        expect(json.spanId).toMatch(/^[0-9a-f]{16}$/);
        expect(json.kind).toBe('client');
        expect(json.attributes['http.method']).toBe('GET');
        expect(json.events).toHaveLength(1);
        expect(json.status.code).toBe(1);
        expect(json.startTime).toBeLessThanOrEqual(json.endTime);
        expect(typeof json.duration).toBe('number');
    });

    it('end reports to tracer', () =>
    {
        const reported = [];
        const fakeTracer = { _report: (s) => reported.push(s) };
        const span = new Span({ name: 'op', traceId: 'a'.repeat(32), tracer: fakeTracer });
        span.end();
        expect(reported).toHaveLength(1);
        expect(reported[0]).toBe(span);
    });
});

// ── Tracer ───────────────────────────────────────────────────────

describe('Tracer', () =>
{
    it('creates with default options', () =>
    {
        const tracer = new Tracer();
        expect(tracer.serviceName).toBe('unknown');
        tracer.shutdown();
    });

    it('creates spans with service resource', () =>
    {
        const tracer = new Tracer({ serviceName: 'my-api', flushInterval: 0 });
        const span = tracer.startSpan('GET /foo');
        expect(span.attributes['service.name']).toBe('my-api');
        tracer.shutdown();
    });

    it('merges resource attributes', () =>
    {
        const tracer = new Tracer({
            serviceName: 'api',
            resource: { 'deployment.environment': 'test' },
            flushInterval: 0,
        });
        const span = tracer.startSpan('op');
        expect(span.attributes['deployment.environment']).toBe('test');
        tracer.shutdown();
    });

    it('startSpan creates with custom traceId and parentSpanId', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const span = tracer.startSpan('op', {
            traceId: 'b'.repeat(32),
            parentSpanId: 'c'.repeat(16),
        });
        expect(span.traceId).toBe('b'.repeat(32));
        expect(span.parentSpanId).toBe('c'.repeat(16));
        tracer.shutdown();
    });

    it('shouldSample returns true at rate 1.0', () =>
    {
        const tracer = new Tracer({ sampleRate: 1.0, flushInterval: 0 });
        for (let i = 0; i < 10; i++) expect(tracer.shouldSample()).toBe(true);
        tracer.shutdown();
    });

    it('shouldSample returns false at rate 0', () =>
    {
        const tracer = new Tracer({ sampleRate: 0, flushInterval: 0 });
        for (let i = 0; i < 10; i++) expect(tracer.shouldSample()).toBe(false);
        tracer.shutdown();
    });

    it('shouldSample clamps rate to [0, 1]', () =>
    {
        const high = new Tracer({ sampleRate: 5, flushInterval: 0 });
        expect(high.shouldSample()).toBe(true);
        high.shutdown();

        const low = new Tracer({ sampleRate: -1, flushInterval: 0 });
        expect(low.shouldSample()).toBe(false);
        low.shutdown();
    });

    it('onSpanEnd registers listener', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const spans = [];
        tracer.onSpanEnd((s) => spans.push(s));
        const span = tracer.startSpan('op');
        span.end();
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe('op');
        tracer.shutdown();
    });

    it('onSpanEnd listener errors do not break tracing', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        tracer.onSpanEnd(() => { throw new Error('listener fail'); });
        const span = tracer.startSpan('op');
        expect(() => span.end()).not.toThrow();
        tracer.shutdown();
    });

    it('batches spans and flushes to exporter', async () =>
    {
        const exported = [];
        const tracer = new Tracer({
            exporter: (batch) => exported.push(...batch),
            batchSize: 2,
            flushInterval: 0,
        });

        tracer.startSpan('s1').end();
        expect(exported).toHaveLength(0);

        tracer.startSpan('s2').end();
        expect(exported).toHaveLength(2);

        tracer.shutdown();
    });

    it('flush sends remaining buffer', async () =>
    {
        const exported = [];
        const tracer = new Tracer({
            exporter: (batch) => exported.push(...batch),
            batchSize: 100,
            flushInterval: 0,
        });
        tracer.startSpan('s1').end();
        expect(exported).toHaveLength(0);

        await tracer.flush();
        expect(exported).toHaveLength(1);
        tracer.shutdown();
    });

    it('flush is no-op without exporter', async () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        tracer.startSpan('s1').end();
        await tracer.flush();
        tracer.shutdown();
    });

    it('flush swallows exporter errors', async () =>
    {
        const tracer = new Tracer({
            exporter: () => { throw new Error('export fail'); },
            flushInterval: 0,
        });
        tracer.startSpan('s1').end();
        await expect(tracer.flush()).resolves.not.toThrow();
        tracer.shutdown();
    });

    it('shutdown flushes and clears timer', async () =>
    {
        const exported = [];
        const tracer = new Tracer({
            exporter: (batch) => exported.push(...batch),
            flushInterval: 60000,
        });
        tracer.startSpan('s1').end();
        await tracer.shutdown();
        expect(exported).toHaveLength(1);
        expect(tracer._flushTimer).toBeNull();
    });

    it('double shutdown is safe', async () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        await tracer.shutdown();
        await tracer.shutdown();
    });
});

// ── tracingMiddleware ────────────────────────────────────────────

describe('tracingMiddleware', () =>
{
    const EventEmitter = require('events').EventEmitter;

    function mockReqRes(opts = {})
    {
        const req = {
            method: opts.method || 'GET',
            url: opts.url || '/test',
            originalUrl: opts.originalUrl || opts.url || '/test',
            headers: opts.headers || {},
            route: opts.route,
            id: opts.id,
            ip: opts.ip || '127.0.0.1',
            secure: false,
            socket: { remoteAddress: '127.0.0.1' },
        };
        const raw = Object.assign(new EventEmitter(), {
            statusCode: opts.status || 200,
            getHeader: (h) => opts.resHeaders?.[h] || null,
        });
        const resHeaders = {};
        const res = {
            raw,
            set: (k, v) => { resHeaders[k] = v; },
        };
        return { req, res, raw, resHeaders };
    }

    it('creates middleware function', () =>
    {
        const mw = tracingMiddleware({ tracer: new Tracer({ flushInterval: 0 }) });
        expect(typeof mw).toBe('function');
    });

    it('creates a server span and attaches to req', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer });
        const { req, res } = mockReqRes();

        mw(req, res, () => {});
        expect(req.span).toBeInstanceOf(Span);
        expect(req.traceId).toMatch(/^[0-9a-f]{32}$/);
        tracer.shutdown();
    });

    it('extracts incoming traceparent and uses its traceId', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer });
        const traceId = 'abcdef1234567890abcdef1234567890';
        const { req, res } = mockReqRes({
            headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
        });

        mw(req, res, () => {});
        expect(req.traceId).toBe(traceId);
        expect(req.span.parentSpanId).toBe('00f067aa0ba902b7');
        tracer.shutdown();
    });

    it('sets response traceparent header (propagate=true)', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer, propagate: true });
        const { req, res, resHeaders } = mockReqRes();

        mw(req, res, () => {});
        expect(resHeaders.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        tracer.shutdown();
    });

    it('skips propagation when propagate=false', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer, propagate: false });
        const { req, res, resHeaders } = mockReqRes();

        mw(req, res, () => {});
        expect(resHeaders.traceparent).toBeUndefined();
        tracer.shutdown();
    });

    it('ends span with OK on successful response', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer });
        const { req, res, raw } = mockReqRes({ status: 200 });

        mw(req, res, () => {});
        raw.emit('finish');

        expect(req.span.status.code).toBe(1); // OK
        expect(req.span.endTime).not.toBeNull();
        expect(req.span.attributes['http.status_code']).toBe(200);
        tracer.shutdown();
    });

    it('ends span with ERROR on 5xx', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer });
        const { req, res, raw } = mockReqRes({ status: 502 });

        mw(req, res, () => {});
        raw.emit('finish');

        expect(req.span.status.code).toBe(2); // ERROR
        tracer.shutdown();
    });

    it('skip option bypasses tracing', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({
            tracer,
            skip: (req) => req.url === '/health',
        });
        const { req, res } = mockReqRes({ url: '/health' });
        let nextCalled = false;
        mw(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(req.span).toBeUndefined();
        tracer.shutdown();
    });

    it('uses routeLabel for span name', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({
            tracer,
            routeLabel: () => '/users/:id',
        });
        const { req, res } = mockReqRes({ url: '/users/42' });
        mw(req, res, () => {});
        expect(req.span.name).toBe('GET /users/:id');
        tracer.shutdown();
    });

    it('attaches req.route and req.id when available', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer });
        const { req, res, raw } = mockReqRes({ route: '/api/v1', id: 'req-123' });

        mw(req, res, () => {});
        raw.emit('finish');

        expect(req.span.attributes['http.route']).toBe('/api/v1');
        expect(req.span.attributes['http.request_id']).toBe('req-123');
        tracer.shutdown();
    });

    it('propagates tracestate header', () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const mw = tracingMiddleware({ tracer });
        const { req, res, resHeaders } = mockReqRes({
            headers: {
                traceparent: '00-abcdef1234567890abcdef1234567890-00f067aa0ba902b7-01',
                tracestate: 'congo=t61rcWkgMzE',
            },
        });

        mw(req, res, () => {});
        expect(req.span.attributes.tracestate).toBe('congo=t61rcWkgMzE');
        expect(resHeaders.tracestate).toBe('congo=t61rcWkgMzE');
        tracer.shutdown();
    });

    it('unsampled request without incoming context is skipped', () =>
    {
        const tracer = new Tracer({ sampleRate: 0, flushInterval: 0 });
        const mw = tracingMiddleware({ tracer });
        const { req, res } = mockReqRes();
        let nextCalled = false;
        mw(req, res, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);
        expect(req.span).toBeUndefined();
        tracer.shutdown();
    });
});

// ── instrumentFetch ──────────────────────────────────────────────

describe('instrumentFetch', () =>
{
    it('injects traceparent into outbound request', async () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        let capturedHeaders;
        const fakeFetch = (url, opts) =>
        {
            capturedHeaders = opts.headers;
            return Promise.resolve({ status: 200 });
        };

        const traced = instrumentFetch(fakeFetch, tracer);
        await traced('https://api.example.com/data', { method: 'GET' });
        expect(capturedHeaders.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        tracer.shutdown();
    });

    it('creates a client span', async () =>
    {
        const spans = [];
        const tracer = new Tracer({
            exporter: (batch) => spans.push(...batch),
            flushInterval: 0,
        });
        const fakeFetch = () => Promise.resolve({ status: 200 });

        const traced = instrumentFetch(fakeFetch, tracer);
        await traced('https://api.example.com/users');
        await tracer.flush();

        expect(spans).toHaveLength(1);
        expect(spans[0].kind).toBe('client');
        expect(spans[0].attributes['http.url']).toBe('https://api.example.com/users');
        expect(spans[0].attributes['http.method']).toBe('GET');
        expect(spans[0].status.code).toBe(1); // OK
        tracer.shutdown();
    });

    it('records error status for 4xx/5xx responses', async () =>
    {
        const spans = [];
        const tracer = new Tracer({
            exporter: (batch) => spans.push(...batch),
            flushInterval: 0,
        });
        const fakeFetch = () => Promise.resolve({ status: 500 });
        const traced = instrumentFetch(fakeFetch, tracer);
        await traced('https://api.example.com/fail');
        await tracer.flush();

        expect(spans[0].status.code).toBe(2); // ERROR
        tracer.shutdown();
    });

    it('records exception on fetch failure', async () =>
    {
        const spans = [];
        const tracer = new Tracer({
            exporter: (batch) => spans.push(...batch),
            flushInterval: 0,
        });
        const fakeFetch = () => Promise.reject(new Error('network error'));
        const traced = instrumentFetch(fakeFetch, tracer);

        await expect(traced('https://api.example.com/fail')).rejects.toThrow('network error');
        await tracer.flush();

        expect(spans).toHaveLength(1);
        expect(spans[0].status.code).toBe(2);
        expect(spans[0].events[0].name).toBe('exception');
        tracer.shutdown();
    });

    it('passes through without tracer', async () =>
    {
        const fakeFetch = (url) => Promise.resolve({ status: 200, url });
        const traced = instrumentFetch(fakeFetch, null);
        const res = await traced('https://example.com');
        expect(res.status).toBe(200);
    });

    it('uses method from opts', async () =>
    {
        const spans = [];
        const tracer = new Tracer({
            exporter: (batch) => spans.push(...batch),
            flushInterval: 0,
        });
        const fakeFetch = () => Promise.resolve({ status: 201 });
        const traced = instrumentFetch(fakeFetch, tracer);
        await traced('https://api.example.com/resource', { method: 'POST' });
        await tracer.flush();

        expect(spans[0].attributes['http.method']).toBe('POST');
        expect(spans[0].name).toContain('POST');
        tracer.shutdown();
    });

    it('handles non-URL strings gracefully', async () =>
    {
        const tracer = new Tracer({ flushInterval: 0 });
        const fakeFetch = () => Promise.resolve({ status: 200 });
        const traced = instrumentFetch(fakeFetch, tracer);
        await traced('not-a-url');
        tracer.shutdown();
    });
});
