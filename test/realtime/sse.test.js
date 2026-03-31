const http = require('http');
const { createApp } = require('../../');
const SSEStream = require('../../lib/sse/stream');

// -- Helper: collect full SSE body from a URL ---------------
function collectSSE(url) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        http.get(url, (resp) => {
            resp.on('data', c => chunks.push(c.toString()));
            resp.on('end', () => resolve({ body: chunks.join(''), headers: resp.headers, status: resp.statusCode }));
        }).on('error', reject);
    });
}

// ===========================================================
//  Integration tests against a live HTTP server
// ===========================================================
describe('SSE Integration', () => {
    let server, base;

    beforeAll(async () => {
        const app = createApp();

        app.get('/sse-basic', (req, res) => {
            const sse = res.sse({ retry: 1000, autoId: true });
            sse.send('hello');
            sse.event('update', { count: 1 });
            sse.comment('keep-alive');
            setTimeout(() => sse.close(), 50);
        });

        app.get('/sse-pad', (req, res) => {
            const sse = res.sse({ pad: 64 });
            sse.send('after-pad');
            setTimeout(() => sse.close(), 30);
        });

        app.get('/sse-custom-status', (req, res) => {
            const sse = res.sse({ status: 201 });
            sse.send('created');
            setTimeout(() => sse.close(), 30);
        });

        app.get('/sse-headers', (req, res) => {
            const sse = res.sse({ headers: { 'X-SSE-Custom': 'yes' } });
            sse.send('hi');
            setTimeout(() => sse.close(), 30);
        });

        app.get('/sse-startid', (req, res) => {
            const sse = res.sse({ autoId: true, startId: 100 });
            sse.send('a');
            sse.send('b');
            setTimeout(() => sse.close(), 30);
        });

        app.get('/sse-manual-id', (req, res) => {
            const sse = res.sse();
            sse.send('data1', 'custom-id-1');
            sse.event('ev', 'data2', 'custom-id-2');
            setTimeout(() => sse.close(), 30);
        });

        app.get('/sse-json', (req, res) => {
            const sse = res.sse();
            sse.sendJSON({ msg: 'hello' });
            setTimeout(() => sse.close(), 30);
        });

        app.get('/sse-multiline', (req, res) => {
            const sse = res.sse();
            sse.send('line1\nline2\nline3');
            setTimeout(() => sse.close(), 30);
        });

        app.get('/sse-props', (req, res) => {
            const sse = res.sse({ autoId: true });
            sse.send('one');
            sse.send('two');
            sse.event('e', 'three');
            setTimeout(() => {
                // Collect properties BEFORE closing
                const props = {
                    connected: sse.connected,
                    eventCount: sse.eventCount,
                    bytesSent: sse.bytesSent,
                    hasConnectedAt: typeof sse.connectedAt === 'number',
                    uptimePositive: sse.uptime >= 0,
                    secure: sse.secure,
                };
                sse.data._props = props;
                sse.close();
            }, 30);
        });

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;
    });

    afterAll(() => server?.close());

    it('sends correct headers and events', async () => {
        const { body, headers } = await collectSSE(`${base}/sse-basic`);
        expect(headers['content-type']).toBe('text/event-stream');
        expect(headers['cache-control']).toBe('no-cache');
        expect(headers['connection']).toBe('keep-alive');
        expect(headers['x-accel-buffering']).toBe('no');
        expect(body).toContain('retry: 1000');
        expect(body).toContain('data: hello');
        expect(body).toContain('event: update');
        expect(body).toContain('data: {"count":1}');
        expect(body).toContain(': keep-alive');
        expect(body).toContain('id: 1');
    });

    it('auto-increments IDs across send and event', async () => {
        const { body } = await collectSSE(`${base}/sse-basic`);
        expect(body).toContain('id: 1');
        expect(body).toContain('id: 2');
    });

    it('pad option emits initial padding', async () => {
        const { body } = await collectSSE(`${base}/sse-pad`);
        // padding is ": " + spaces + "\n\n"
        expect(body.startsWith(': ')).toBe(true);
        expect(body).toContain('data: after-pad');
    });

    it('custom status code', async () => {
        const { status } = await collectSSE(`${base}/sse-custom-status`);
        expect(status).toBe(201);
    });

    it('custom response headers', async () => {
        const { headers } = await collectSSE(`${base}/sse-headers`);
        expect(headers['x-sse-custom']).toBe('yes');
    });

    it('startId offsets auto-increment', async () => {
        const { body } = await collectSSE(`${base}/sse-startid`);
        expect(body).toContain('id: 100');
        expect(body).toContain('id: 101');
    });

    it('manual IDs override auto-ID', async () => {
        const { body } = await collectSSE(`${base}/sse-manual-id`);
        expect(body).toContain('id: custom-id-1');
        expect(body).toContain('id: custom-id-2');
    });

    it('sendJSON serializes objects', async () => {
        const { body } = await collectSSE(`${base}/sse-json`);
        expect(body).toContain('data: {"msg":"hello"}');
    });

    it('multi-line data uses separate data: lines', async () => {
        const { body } = await collectSSE(`${base}/sse-multiline`);
        expect(body).toContain('data: line1\ndata: line2\ndata: line3');
    });
});

// ===========================================================
//  Unit tests on the SSEStream class directly (no HTTP)
// ===========================================================
describe('SSEStream Unit', () => {
    /** Create a fake raw response with a writable buffer */
    function fakeRaw() {
        const written = [];
        return {
            _listeners: {},
            write(str) { written.push(str); },
            end() { this._emit('close'); },
            on(evt, fn) { if (!this._listeners[evt]) this._listeners[evt] = []; this._listeners[evt].push(fn); },
            _emit(evt, ...args) { (this._listeners[evt] || []).forEach(fn => fn(...args)); },
            flushHeaders() {},
            _written: written,
        };
    }

    it('connected is true initially, false after close', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        expect(sse.connected).toBe(true);
        sse.close();
        expect(sse.connected).toBe(false);
    });

    it('eventCount increments on send and event', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        expect(sse.eventCount).toBe(0);
        sse.send('a');
        expect(sse.eventCount).toBe(1);
        sse.event('x', 'b');
        expect(sse.eventCount).toBe(2);
        sse.comment('c'); // comments don't count
        expect(sse.eventCount).toBe(2);
        sse.close();
    });

    it('bytesSent tracks cumulative output', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        expect(sse.bytesSent).toBe(0);
        sse.send('hi');
        expect(sse.bytesSent).toBeGreaterThan(0);
        const first = sse.bytesSent;
        sse.send('more');
        expect(sse.bytesSent).toBeGreaterThan(first);
        sse.close();
    });

    it('uptime increases over time', async () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        const t0 = sse.uptime;
        await new Promise(r => setTimeout(r, 20));
        expect(sse.uptime).toBeGreaterThanOrEqual(t0);
        sse.close();
    });

    it('data is an empty object by default', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        expect(sse.data).toEqual({});
        sse.data.foo = 'bar';
        expect(sse.data.foo).toBe('bar');
        sse.close();
    });

    it('lastEventId captures option', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw, { lastEventId: '42' });
        expect(sse.lastEventId).toBe('42');
        sse.close();
    });

    it('secure flag from options', () => {
        const rawPlain = fakeRaw();
        expect(new SSEStream(rawPlain).secure).toBe(false);
        const rawSecure = fakeRaw();
        const sse = new SSEStream(rawSecure, { secure: true });
        expect(sse.secure).toBe(true);
        sse.close();
    });

    it('send after close is a no-op', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.close();
        const before = sse.eventCount;
        sse.send('nope');
        expect(sse.eventCount).toBe(before);
    });

    it('event after close is a no-op', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.close();
        sse.event('name', 'data');
        expect(sse.eventCount).toBe(0);
    });

    it('comment after close is a no-op', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.close();
        const len = raw._written.length;
        sse.comment('nope');
        expect(raw._written.length).toBe(len);
    });

    it('retry after close is a no-op', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.close();
        const len = raw._written.length;
        sse.retry(5000);
        expect(raw._written.length).toBe(len);
    });

    it('retry writes retry: line', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.retry(3000);
        expect(raw._written.some(s => s.includes('retry: 3000'))).toBe(true);
        sse.close();
    });

    it('flush calls flushHeaders', () => {
        const raw = fakeRaw();
        let flushed = false;
        raw.flushHeaders = () => { flushed = true; };
        const sse = new SSEStream(raw);
        sse.flush();
        expect(flushed).toBe(true);
        sse.close();
    });

    it('flush after close is a no-op', () => {
        const raw = fakeRaw();
        let flushed = false;
        raw.flushHeaders = () => { flushed = true; };
        const sse = new SSEStream(raw);
        sse.close();
        sse.flush();
        expect(flushed).toBe(false);
    });

    it('all send methods are chainable', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        const result = sse.send('a').event('e', 'b').comment('c').retry(1000).flush().keepAlive(0);
        expect(result).toBe(sse);
        sse.close();
    });

    // -- Event emitter ----------------------------------
    it('on/emit close event', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        let closed = false;
        sse.on('close', () => { closed = true; });
        sse.close();
        expect(closed).toBe(true);
    });

    it('once fires only once', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        let count = 0;
        sse.once('close', () => { count++; });
        raw._emit('close');
        raw._emit('close');
        expect(count).toBe(1);
    });

    it('off removes a listener', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        let called = false;
        const fn = () => { called = true; };
        sse.on('close', fn);
        sse.off('close', fn);
        raw._emit('close');
        expect(called).toBe(false);
    });

    it('off removes a once listener by original fn', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        let called = false;
        const fn = () => { called = true; };
        sse.once('close', fn);
        sse.off('close', fn);
        raw._emit('close');
        expect(called).toBe(false);
    });

    it('removeAllListeners for specific event', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.on('close', () => {});
        sse.on('close', () => {});
        sse.on('error', () => {});
        expect(sse.listenerCount('close')).toBe(2);
        sse.removeAllListeners('close');
        expect(sse.listenerCount('close')).toBe(0);
        expect(sse.listenerCount('error')).toBe(1);
        sse.close();
    });

    it('removeAllListeners with no arg clears everything', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.on('close', () => {});
        sse.on('error', () => {});
        sse.removeAllListeners();
        expect(sse.listenerCount('close')).toBe(0);
        expect(sse.listenerCount('error')).toBe(0);
        sse.close();
    });

    it('listenerCount returns correct count', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        expect(sse.listenerCount('close')).toBe(0);
        sse.on('close', () => {});
        sse.on('close', () => {});
        expect(sse.listenerCount('close')).toBe(2);
        sse.close();
    });

    it('error event fires on raw error', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        let caught = null;
        sse.on('error', (err) => { caught = err; });
        raw._emit('error', new Error('write fail'));
        expect(caught).toBeInstanceOf(Error);
        expect(caught.message).toBe('write fail');
        sse.close();
    });

    // -- Keep-alive timer -------------------------------
    it('keepAlive starts timer that sends comments', async () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.keepAlive(30, 'heartbeat');
        await new Promise(r => setTimeout(r, 80));
        const pings = raw._written.filter(s => s.includes(': heartbeat'));
        expect(pings.length).toBeGreaterThanOrEqual(2);
        sse.close();
    });

    it('keepAlive(0) stops the timer', async () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.keepAlive(20, 'tick');
        await new Promise(r => setTimeout(r, 50));
        sse.keepAlive(0);
        const countAfterStop = raw._written.filter(s => s.includes(': tick')).length;
        await new Promise(r => setTimeout(r, 50));
        const countLater = raw._written.filter(s => s.includes(': tick')).length;
        expect(countLater).toBe(countAfterStop);
        sse.close();
    });

    it('constructor keepAlive option starts timer', async () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw, { keepAlive: 20, keepAliveComment: 'ka' });
        await new Promise(r => setTimeout(r, 60));
        const pings = raw._written.filter(s => s.includes(': ka'));
        expect(pings.length).toBeGreaterThanOrEqual(1);
        sse.close();
    });

    it('close clears keepAlive timer', async () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw, { keepAlive: 20 });
        sse.close();
        const count = raw._written.length;
        await new Promise(r => setTimeout(r, 60));
        expect(raw._written.length).toBe(count);
    });

    it('auto-ID with custom startId', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw, { autoId: true, startId: 50 });
        sse.send('x');
        sse.send('y');
        const output = raw._written.join('');
        expect(output).toContain('id: 50');
        expect(output).toContain('id: 51');
        sse.close();
    });

    it('auto-ID on event()', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw, { autoId: true });
        sse.event('tick', 'payload');
        const output = raw._written.join('');
        expect(output).toContain('id: 1');
        expect(output).toContain('event: tick');
        sse.close();
    });

    it('manual ID overrides auto-ID', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw, { autoId: true });
        sse.send('x', 'manual-id');
        const output = raw._written.join('');
        expect(output).toContain('id: manual-id');
        expect(output).not.toContain('id: 1');
        sse.close();
    });

    it('formats object data as JSON', () => {
        const raw = fakeRaw();
        const sse = new SSEStream(raw);
        sse.send({ key: 'value' });
        expect(raw._written.join('')).toContain('data: {"key":"value"}');
        sse.close();
    });
});

// =========================================================================
//  SSE comment newline safety (from audit)
// =========================================================================

describe('SSE comment newline safety', () =>
{
    it('escapes newlines in comments to prevent injection', (done) =>
    {
        const app = createApp();
        app.get('/sse', (req, res) =>
        {
            const stream = res.sse();
            stream.comment('line1\ndata: injected');
            stream.send('real data');
            setTimeout(() => stream.close(), 50);
        });

        const server = http.createServer(app.handler);
        server.listen(0, () =>
        {
            const port = server.address().port;
            http.get(`http://localhost:${port}/sse`, (res) =>
            {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () =>
                {
                    expect(body).toContain(': line1\n: data: injected');
                    expect(body).toContain('data: real data');
                    server.close();
                    done();
                });
            });
        });
    });
});
