const http = require('http');
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Raw WebSocket client helper
function wsConnect(portNum, wsPath, extraHeaders) {
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(portNum, '127.0.0.1', () => {
            let h = `GET ${wsPath} HTTP/1.1\r\nHost: localhost:${portNum}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
            if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) h += `${k}: ${v}\r\n`;
            h += '\r\n';
            socket.write(h);
        });
        let upgraded = false, headerBuf = '', responseHeaders = '';
        const messages = [];
        socket.on('data', (chunk) => {
            if (!upgraded) {
                headerBuf += chunk.toString();
                if (headerBuf.includes('\r\n\r\n')) {
                    upgraded = true;
                    responseHeaders = headerBuf.split('\r\n\r\n')[0];
                    const remaining = chunk.slice(chunk.indexOf(Buffer.from('\r\n\r\n')) + 4);
                    if (remaining.length > 0) parseFrames(remaining);
                }
                return;
            }
            parseFrames(chunk);
        });
        function parseFrames(buf) {
            while (buf.length >= 2) {
                const opcode = buf[0] & 0x0F;
                let payloadLen = buf[1] & 0x7F, offset = 2;
                if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
                else if (payloadLen === 127) { payloadLen = buf.readUInt32BE(6); offset = 10; }
                if (buf.length < offset + payloadLen) break;
                const payload = buf.slice(offset, offset + payloadLen);
                if (opcode === 0x01) messages.push(payload.toString('utf8'));
                else if (opcode === 0x08) { socket.end(); return; }
                buf = buf.slice(offset + payloadLen);
            }
        }
        function sendWSFrame(text) {
            const payload = Buffer.from(text, 'utf8');
            const mask = crypto.randomBytes(4);
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
            let header;
            if (payload.length < 126) {
                header = Buffer.alloc(2);
                header[0] = 0x81; header[1] = 0x80 | payload.length;
            } else {
                header = Buffer.alloc(4);
                header[0] = 0x81; header[1] = 0x80 | 126;
                header.writeUInt16BE(payload.length, 2);
            }
            socket.write(Buffer.concat([header, mask, masked]));
        }
        socket.on('error', reject);
        setTimeout(() => resolve({ socket, messages, sendWSFrame, responseHeaders }), 100);
    });
}

function wsRawConnect(portNum, wsPath, extraHeaders) {
    return new Promise((resolve) => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(portNum, '127.0.0.1', () => {
            let h = `GET ${wsPath} HTTP/1.1\r\nHost: localhost:${portNum}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
            if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) h += `${k}: ${v}\r\n`;
            h += '\r\n';
            socket.write(h);
        });
        let data = '';
        socket.on('data', c => data += c.toString());
        socket.on('end', () => resolve(data));
        socket.on('close', () => resolve(data));
        setTimeout(() => { socket.end(); resolve(data); }, 200);
    });
}

describe('zero-http integration', () => {
    let server, base, compressServer, compressBase, wsServer, wsPort;
    let doFetch, fetch;
    let staticFolder, uploadsDir;
    let lastWsMeta = {};

    beforeAll(async () => {
        const mod = require('../../');
        const { createApp, Router, json, urlencoded, text, raw, multipart, static: staticMid, cors, rateLimit, logger, compress } = mod;
        fetch = mod.fetch;

        uploadsDir = path.join(__dirname, 'tmp-uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

        const app = createApp();
        app.use(json({ limit: '1mb' }));
        app.use(urlencoded({ extended: false }));
        app.use(text({ type: 'text/*' }));
        app.use(raw({ type: 'application/octet-stream' }));

        staticFolder = path.join(__dirname, 'static');
        if (!fs.existsSync(staticFolder)) fs.mkdirSync(staticFolder, { recursive: true });
        fs.writeFileSync(path.join(staticFolder, 'hello.txt'), 'hello world');
        app.use('/static', staticMid(staticFolder));

        app.post('/echo-json', (req, res) => res.json({ body: req.body }));
        app.post('/echo-form', (req, res) => res.json({ body: req.body }));
        app.post('/echo-text', (req, res) => res.type('text').send(req.body));
        app.post('/echo-raw', (req, res) => res.send(Buffer.from(req.body || '')));
        app.get('/redirect-test', (req, res) => res.redirect('/destination'));
        app.get('/redirect-301', (req, res) => res.redirect(301, '/permanent'));
        app.get('/html-test', (req, res) => res.html('<h1>Hello</h1>'));
        app.patch('/patch-test', (req, res) => res.json({ method: 'PATCH', body: req.body }));
        app.all('/any-method', (req, res) => res.json({ method: req.method }));
        app.get('/error-test', () => { throw new Error('test error'); });
        app.get('/req-helpers', (req, res) => res.json({ ip: req.ip, isJson: req.is('json'), query: req.query }));

        app.post('/upload', multipart({ dir: uploadsDir, maxFileSize: 5 * 1024 * 1024 }), (req, res) => {
            res.json({ files: req.body.files || [], fields: req.body.fields || {} });
        });

        // Sub-Router
        const apiRouter = Router();
        apiRouter.get('/items', (req, res) => res.json({ items: [1, 2, 3] }));
        apiRouter.get('/items/:id', (req, res) => res.json({ id: req.params.id }));
        apiRouter.post('/items', (req, res) => res.json({ created: true, body: req.body }));
        const v2Router = Router();
        v2Router.get('/health', (req, res) => res.json({ status: 'ok', version: 2 }));
        apiRouter.use('/v2', v2Router);
        app.use('/api', apiRouter);

        // Route chaining
        const chainRouter = Router();
        chainRouter.route('/item')
            .get((req, res) => res.json({ method: 'GET' }))
            .post((req, res) => res.json({ method: 'POST' }));
        app.use('/chain', chainRouter);

        // SSE routes
        app.get('/sse', (req, res) => {
            const sse = res.sse({ retry: 1000 });
            sse.send('hello');
            sse.event('update', { x: 1 });
            sse.comment('keep-alive');
            sse.send('multi\nline\ndata');
            setTimeout(() => sse.close(), 50);
        });
        app.get('/sse-advanced', (req, res) => {
            const sse = res.sse({ autoId: true, startId: 10, pad: 64 });
            sse.retry(2000).send('first').sendJSON({ ok: true }).event('tick', 'tock').comment('note');
            const props = {
                eventCount: sse.eventCount,
                bytesSent: sse.bytesSent > 0,
                connected: sse.connected,
                hasUptime: sse.uptime >= 0,
            };
            sse.event('props', props);
            setTimeout(() => sse.close(), 50);
        });

        // Compression app
        const compressApp = createApp();
        compressApp.use(compress({ threshold: 0 }));
        compressApp.get('/big', (req, res) => res.json({ data: 'x'.repeat(2000) }));
        compressApp.get('/small', (req, res) => res.type('text').send('tiny'));

        server = http.createServer(app.handler);
        await new Promise(r => server.listen(0, r));
        base = `http://localhost:${server.address().port}`;

        compressServer = http.createServer(compressApp.handler);
        await new Promise(r => compressServer.listen(0, r));
        compressBase = `http://localhost:${compressServer.address().port}`;

        // WS app
        const wsApp = createApp();
        wsApp.ws('/echo', (ws) => { ws.on('message', d => ws.send('echo:' + d)); });
        wsApp.ws('/broadcast', (ws) => {
            ws.send('welcome');
            ws.on('message', d => { if (d === 'ping') ws.send('pong'); });
        });
        wsApp.ws('/meta', { maxPayload: 512, pingInterval: 0 }, (ws) => {
            lastWsMeta = {
                id: ws.id, readyState: ws.readyState, ip: ws.ip, query: ws.query,
                url: ws.url, protocol: ws.protocol, maxPayload: ws.maxPayload,
                connectedAt: ws.connectedAt, uptime: ws.uptime,
                bufferedAmount: ws.bufferedAmount, hasData: typeof ws.data === 'object',
            };
            ws.sendJSON({ meta: lastWsMeta });
        });
        wsApp.ws('/secure', { verifyClient: req => req.headers['x-token'] === 'secret123', pingInterval: 0 }, (ws) => { ws.send('authorized'); });
        wsApp.ws('/events', { pingInterval: 0 }, (ws) => {
            let msgCount = 0;
            const onMsg = () => { msgCount++; };
            ws.on('message', onMsg);
            ws.on('message', () => {
                if (msgCount === 1) {
                    ws.off('message', onMsg);
                    ws.sendJSON({ removed: true, listenerCount: ws.listenerCount('message') });
                }
            });
        });
        wsServer = wsApp.listen(0);
        await new Promise(r => wsServer.on('listening', r));
        wsPort = wsServer.address().port;

        // Expose helpers
        doFetch = async (url, opts) => {
            const r = await fetch(url, opts);
            const ct = r.headers.get('content-type') || '';
            if (ct.includes('application/json')) return { data: await r.json(), status: r.status, headers: r.headers };
            return { data: await r.text(), status: r.status, headers: r.headers };
        };

        // Store refs for introspection tests
        integration._app = app;
        integration._Router = Router;
        integration._rateLimit = rateLimit;
        integration._logger = logger;
        integration._compress = compress;
    });

    // Store shared refs
    const integration = {};

    afterAll(() => {
        server?.close();
        compressServer?.close();
        wsServer?.close();
        try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(staticFolder, { recursive: true, force: true }); } catch {}
    });

    // -- Body Parsers --
    describe('Body Parsers', () => {
        it('json parser', async () => {
            const r = await doFetch(base + '/echo-json', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
            expect(r.data.body.a).toBe(1);
        });
        it('urlencoded parser', async () => {
            const r = await doFetch(base + '/echo-form', { method: 'POST', body: 'a=1&b=two', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
            expect(r.data.body.a).toBe('1');
        });
        it('text parser', async () => {
            const r = await doFetch(base + '/echo-text', { method: 'POST', body: 'hello text', headers: { 'content-type': 'text/plain' } });
            expect(r.data).toContain('hello text');
        });
        it('raw parser', async () => {
            const r = await doFetch(base + '/echo-raw', { method: 'POST', body: Buffer.from('raw-data'), headers: { 'content-type': 'application/octet-stream' } });
            expect(r.data).toBeDefined();
        });
    });

    // -- Static Serving --
    describe('Static Serving', () => {
        it('serves static files', async () => {
            const r = await doFetch(base + '/static/hello.txt');
            expect(r.data).toContain('hello world');
        });
    });

    // -- Response Helpers --
    describe('Response Helpers', () => {
        it('res.html() body', async () => {
            const r = await doFetch(base + '/html-test');
            expect(r.data).toContain('<h1>Hello</h1>');
        });
        it('res.html() content-type', async () => {
            const r = await doFetch(base + '/html-test');
            expect(r.headers.get('content-type')).toContain('text/html');
        });
        it('res.redirect() 302', async () => {
            const r = await fetch(base + '/redirect-test');
            expect(r.status).toBe(302);
            expect(r.headers.get('location')).toBe('/destination');
        });
        it('res.redirect(301)', async () => {
            const r = await fetch(base + '/redirect-301');
            expect(r.status).toBe(301);
        });
    });

    // -- HTTP Methods --
    describe('HTTP Methods', () => {
        it('PATCH method', async () => {
            const r = await doFetch(base + '/patch-test', { method: 'PATCH', body: JSON.stringify({ x: 1 }), headers: { 'content-type': 'application/json' } });
            expect(r.data.method).toBe('PATCH');
        });
        it('all() matches GET', async () => {
            const r = await doFetch(base + '/any-method');
            expect(r.data.method).toBe('GET');
        });
        it('all() matches POST', async () => {
            const r = await doFetch(base + '/any-method', { method: 'POST' });
            expect(r.data.method).toBe('POST');
        });
        it('all() matches DELETE', async () => {
            const r = await doFetch(base + '/any-method', { method: 'DELETE' });
            expect(r.data.method).toBe('DELETE');
        });
    });

    // -- Error Handling --
    describe('Error Handling', () => {
        it('thrown error returns 500', async () => {
            const r = await doFetch(base + '/error-test');
            expect(r.status).toBe(500);
            expect(r.data.error).toBeTruthy();
        });
        it('404 for unknown route', async () => {
            const r = await doFetch(base + '/nonexistent');
            expect(r.status).toBe(404);
        });
    });

    // -- Request Helpers --
    describe('Request Helpers', () => {
        it('req.query parsing', async () => {
            const r = await doFetch(base + '/req-helpers?foo=bar', { headers: { 'content-type': 'application/json' } });
            expect(r.data.query.foo).toBe('bar');
        });
        it('req.is() type check', async () => {
            const r = await doFetch(base + '/req-helpers?foo=bar', { headers: { 'content-type': 'application/json' } });
            expect(r.data.isJson).toBe(true);
        });
        it('req.ip populated', async () => {
            const r = await doFetch(base + '/req-helpers?foo=bar');
            expect(typeof r.data.ip).toBe('string');
        });
    });

    // -- Multipart Upload --
    describe('Multipart Upload', () => {
        it('parses files and fields', async () => {
            const boundary = '----zero-test-' + Date.now();
            const parts = [];
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="desc"\r\n\r\nmydesc\r\n`));
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello multipart\r\n`));
            parts.push(Buffer.from(`--${boundary}--\r\n`));
            const r = await doFetch(base + '/upload', { method: 'POST', body: Buffer.concat(parts), headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } });
            expect(r.data.files).toBeTruthy();
            expect(r.data.fields.desc).toBe('mydesc');
        });
    });

    // -- Export Checks --
    describe('Export Checks', () => {
        it('rateLimit export', () => expect(typeof integration._rateLimit).toBe('function'));
        it('logger export', () => expect(typeof integration._logger).toBe('function'));
        it('compress export', () => expect(typeof integration._compress).toBe('function'));
        it('Router export', () => expect(typeof integration._Router).toBe('function'));
    });

    // -- Router Sub-Apps --
    describe('Router Sub-Apps', () => {
        it('GET /api/items', async () => {
            const r = await doFetch(base + '/api/items');
            expect(r.data.items).toEqual([1, 2, 3]);
        });
        it('GET /api/items/:id', async () => {
            const r = await doFetch(base + '/api/items/42');
            expect(r.data.id).toBe('42');
        });
        it('POST /api/items', async () => {
            const r = await doFetch(base + '/api/items', { method: 'POST', body: JSON.stringify({ name: 'test' }), headers: { 'content-type': 'application/json' } });
            expect(r.data.created).toBe(true);
        });
        it('nested GET /api/v2/health', async () => {
            const r = await doFetch(base + '/api/v2/health');
            expect(r.data.version).toBe(2);
        });
        it('route chaining GET', async () => {
            const r = await doFetch(base + '/chain/item');
            expect(r.data.method).toBe('GET');
        });
        it('route chaining POST', async () => {
            const r = await doFetch(base + '/chain/item', { method: 'POST' });
            expect(r.data.method).toBe('POST');
        });
    });

    // -- Route Introspection --
    describe('Route Introspection', () => {
        it('app.routes() returns array', () => {
            const routes = integration._app.routes();
            expect(Array.isArray(routes)).toBe(true);
            expect(routes.length).toBeGreaterThan(0);
        });
        it('includes /html-test', () => {
            const getPaths = integration._app.routes().filter(r => r.method === 'GET').map(r => r.path);
            expect(getPaths).toContain('/html-test');
        });
        it('includes sub-router routes', () => {
            const paths = integration._app.routes().map(r => r.path);
            expect(paths.some(p => p.includes('/api/items'))).toBe(true);
            expect(paths.some(p => p.includes('/api/v2/health'))).toBe(true);
        });
    });

    // -- Router Factory --
    describe('Router Factory', () => {
        it('Router instance has methods', () => {
            const r = integration._Router();
            expect(typeof r.get).toBe('function');
            expect(typeof r.post).toBe('function');
            expect(typeof r.route).toBe('function');
            expect(typeof r.inspect).toBe('function');
        });
    });

    // -- SSE --
    describe('Server-Sent Events', () => {
        it('basic SSE stream', async () => {
            const data = await new Promise((resolve, reject) => {
                const chunks = [];
                http.get(base + '/sse', (resp) => {
                    expect(resp.headers['content-type']).toBe('text/event-stream');
                    expect(resp.headers['cache-control']).toBe('no-cache');
                    resp.on('data', c => chunks.push(c.toString()));
                    resp.on('end', () => resolve(chunks.join('')));
                }).on('error', reject);
            });
            expect(data).toContain('retry: 1000');
            expect(data).toContain('data: hello');
            expect(data).toContain('event: update');
            expect(data).toContain('data: {"x":1}');
            expect(data).toContain(': keep-alive');
            expect(data).toContain('data: multi\n');
            expect(data).toContain('data: line\n');
        });

        it('advanced SSE features', async () => {
            const data = await new Promise((resolve, reject) => {
                const chunks = [];
                http.get(base + '/sse-advanced', (resp) => {
                    resp.on('data', c => chunks.push(c.toString()));
                    resp.on('end', () => resolve(chunks.join('')));
                }).on('error', reject);
            });
            expect(data).toContain('retry: 2000');
            expect(data).toContain('id: 10');
            expect(data).toContain('id: 11');
            expect(data).toContain('data: first');
            expect(data).toContain('data: {"ok":true}');
            expect(data).toContain('event: tick');
            expect(data).toContain('data: tock');
            expect(data).toContain(': note');
            expect(data.startsWith(': ')).toBe(true);
            expect(data).toContain('event: props');
            expect(data).toContain('"eventCount":3');
            expect(data).toContain('"bytesSent":true');
            expect(data).toContain('"connected":true');
            expect(data).toContain('"hasUptime":true');
        });

        it('SSE event emitter (once/off/removeAllListeners)', async () => {
            const { createApp } = require('../../');
            const onceFired = await new Promise(async (resolve) => {
                let count = 0;
                const sseApp = createApp();
                sseApp.get('/sse-emit', (req, res) => {
                    const sse = res.sse();
                    expect(sse.listenerCount('close')).toBe(0);
                    const fn = () => { count++; };
                    sse.once('close', fn);
                    expect(sse.listenerCount('close')).toBe(1);
                    sse.removeAllListeners('close');
                    expect(sse.listenerCount('close')).toBe(0);
                    sse.on('close', () => resolve(count));
                    sse.close();
                });
                const sseServer = http.createServer(sseApp.handler);
                await new Promise(r => sseServer.listen(0, r));
                const p = sseServer.address().port;
                await new Promise((res2, rej2) => {
                    http.get(`http://localhost:${p}/sse-emit`, (resp) => {
                        resp.resume();
                        resp.on('end', res2);
                    }).on('error', rej2);
                });
                sseServer.close();
            });
            expect(onceFired).toBe(0);
        });
    });

    // -- Compression --
    describe('Compression', () => {
        it('gzip compression', async () => {
            const result = await new Promise((resolve, reject) => {
                http.get(compressBase + '/big', { headers: { 'accept-encoding': 'gzip' } }, (resp) => {
                    expect(resp.headers['content-encoding']).toBe('gzip');
                    expect(resp.headers['vary']).toBe('Accept-Encoding');
                    const chunks = [];
                    resp.on('data', c => chunks.push(c));
                    resp.on('end', () => {
                        zlib.gunzip(Buffer.concat(chunks), (err, decoded) => {
                            if (err) return reject(err);
                            resolve(JSON.parse(decoded.toString()));
                        });
                    });
                }).on('error', reject);
            });
            expect(result.data.length).toBe(2000);
        });

        it('deflate compression', async () => {
            const result = await new Promise((resolve, reject) => {
                http.get(compressBase + '/big', { headers: { 'accept-encoding': 'deflate' } }, (resp) => {
                    expect(resp.headers['content-encoding']).toBe('deflate');
                    const chunks = [];
                    resp.on('data', c => chunks.push(c));
                    resp.on('end', () => {
                        zlib.inflate(Buffer.concat(chunks), (err, decoded) => {
                            if (err) return reject(err);
                            resolve(JSON.parse(decoded.toString()));
                        });
                    });
                }).on('error', reject);
            });
            expect(result.data.length).toBe(2000);
        });

        it('no compression without Accept-Encoding', async () => {
            const result = await new Promise((resolve, reject) => {
                http.get(compressBase + '/big', (resp) => {
                    expect(resp.headers['content-encoding']).toBeUndefined();
                    const chunks = [];
                    resp.on('data', c => chunks.push(c));
                    resp.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
                }).on('error', reject);
            });
            expect(result.data.length).toBe(2000);
        });
    });

    // -- WebSocket --
    describe('WebSocket', () => {
        it('echo handshake + message', async () => {
            const ws = await wsConnect(wsPort, '/echo');
            expect(ws.responseHeaders).toContain('101');
            expect(ws.responseHeaders).toContain('Sec-WebSocket-Accept');
            ws.sendWSFrame('hello');
            await new Promise(r => setTimeout(r, 100));
            expect(ws.messages).toContain('echo:hello');
            ws.socket.end();
        });

        it('welcome + ping/pong', async () => {
            const ws = await wsConnect(wsPort, '/broadcast');
            await new Promise(r => setTimeout(r, 100));
            expect(ws.messages).toContain('welcome');
            ws.sendWSFrame('ping');
            await new Promise(r => setTimeout(r, 100));
            expect(ws.messages).toContain('pong');
            ws.socket.end();
        });

        it('metadata properties', async () => {
            const ws = await wsConnect(wsPort, '/meta?room=lobby&user=tom');
            await new Promise(r => setTimeout(r, 150));
            expect(ws.messages.length).toBeGreaterThan(0);
            const meta = JSON.parse(ws.messages[0]).meta;
            expect(meta.id).toMatch(/^ws_/);
            expect(meta.readyState).toBe(1);
            expect(typeof meta.ip).toBe('string');
            expect(meta.query.room).toBe('lobby');
            expect(meta.query.user).toBe('tom');
            expect(meta.url).toContain('/meta');
            expect(meta.maxPayload).toBe(512);
            expect(meta.connectedAt).toBeGreaterThan(0);
            expect(meta.uptime).toBeGreaterThanOrEqual(0);
            expect(meta.bufferedAmount).toBeGreaterThanOrEqual(0);
            expect(meta.hasData).toBe(true);
            ws.socket.end();
        });

        it('sendJSON produces valid JSON', async () => {
            const ws = await wsConnect(wsPort, '/meta');
            await new Promise(r => setTimeout(r, 150));
            const parsed = JSON.parse(ws.messages[0]);
            expect(typeof parsed).toBe('object');
            ws.socket.end();
        });

        it('verifyClient rejects unauthorized', async () => {
            const data = await wsRawConnect(wsPort, '/secure');
            expect(data).toContain('403');
        });

        it('verifyClient accepts authorized', async () => {
            const ws = await wsConnect(wsPort, '/secure', { 'X-Token': 'secret123' });
            await new Promise(r => setTimeout(r, 100));
            expect(ws.messages).toContain('authorized');
            ws.socket.end();
        });

        it('sub-protocol negotiation', async () => {
            const ws = await wsConnect(wsPort, '/echo', { 'Sec-WebSocket-Protocol': 'graphql-ws, json' });
            expect(ws.responseHeaders).toContain('Sec-WebSocket-Protocol: graphql-ws');
            ws.socket.end();
        });

        it('off() / listenerCount', async () => {
            const ws = await wsConnect(wsPort, '/events');
            await new Promise(r => setTimeout(r, 50));
            ws.sendWSFrame('first');
            await new Promise(r => setTimeout(r, 150));
            expect(ws.messages.length).toBeGreaterThan(0);
            const msg = JSON.parse(ws.messages[0]);
            expect(msg.removed).toBe(true);
            expect(msg.listenerCount).toBe(1);
            ws.socket.end();
        });

        it('404 for unknown WS path', async () => {
            const data = await wsRawConnect(wsPort, '/nonexistent');
            expect(data).toContain('404');
        });
    });

    // -- Fetch HTTPS Awareness --
    describe('Fetch HTTPS Awareness', () => {
        it('secure=false for http', async () => {
            const r = await fetch(base + '/echo-json', {
                method: 'POST', body: JSON.stringify({ test: 1 }),
                headers: { 'content-type': 'application/json' }
            });
            expect(r.secure).toBe(false);
            expect(r.url).toMatch(/^http:\/\//);
        });
    });

    // -- Body Parser requireSecure --
    describe('Body Parser requireSecure', () => {
        let secServer, secBase;

        beforeAll(async () => {
            const { createApp, json } = require('../../');
            const app = createApp();
            app.use(json({ requireSecure: true }));
            app.post('/sec-json', (req, res) => res.json({ ok: true }));
            secServer = await new Promise(resolve => {
                const s = app.listen(0, () => resolve(s));
            });
            secBase = `http://127.0.0.1:${secServer.address().port}`;
        });

        afterAll(() => secServer?.close());

        it('rejects HTTP with 403', async () => {
            const r = await fetch(secBase + '/sec-json', {
                method: 'POST', body: JSON.stringify({ a: 1 }),
                headers: { 'content-type': 'application/json' }
            });
            expect(r.status).toBe(403);
            const body = await r.json();
            expect(body.error).toBe('HTTPS required');
        });
    });

    // -- Router Secure Routes --
    describe('Router Secure Routes', () => {
        let secServer, secBase, secApp;

        beforeAll(async () => {
            const { createApp, Router } = require('../../');
            secApp = createApp();
            secApp.get('/secure-only', { secure: true }, (req, res) => res.json({ msg: 'secret' }));
            secApp.get('/http-only', { secure: false }, (req, res) => res.json({ msg: 'plain' }));
            secApp.get('/either', (req, res) => res.json({ msg: 'both' }));
            secServer = await new Promise(resolve => {
                const s = secApp.listen(0, () => resolve(s));
            });
            secBase = `http://127.0.0.1:${secServer.address().port}`;
        });

        afterAll(() => secServer?.close());

        it('secure-only 404 over HTTP', async () => {
            const r = await fetch(secBase + '/secure-only');
            expect(r.status).toBe(404);
        });
        it('http-only matches HTTP', async () => {
            const r = await fetch(secBase + '/http-only');
            expect(r.status).toBe(200);
            expect((await r.json()).msg).toBe('plain');
        });
        it('normal route matches HTTP', async () => {
            const r = await fetch(secBase + '/either');
            expect(r.status).toBe(200);
        });
        it('introspection secure flags', () => {
            const routes = secApp.routes();
            expect(routes.find(r => r.path === '/secure-only').secure).toBe(true);
            expect(routes.find(r => r.path === '/http-only').secure).toBe(false);
            expect(routes.find(r => r.path === '/either').secure).toBeUndefined();
        });
        it('Router convenience method passes secure option', () => {
            const { Router } = require('../../');
            const sub = Router();
            sub.post('/data', { secure: true }, (req, res) => res.json({ ok: 1 }));
            expect(sub.inspect()[0].secure).toBe(true);
        });
        it('route() chain passes secure option', () => {
            const { Router } = require('../../');
            const chain = Router();
            chain.route('/chain').get({ secure: true }, (req, res) => res.json({ chain: 1 }));
            expect(chain.inspect()[0].secure).toBe(true);
        });
    });

    // -- HTTPS Support --
    describe('HTTPS Support', () => {
        it('app.listen() exists', () => expect(typeof integration._app.listen).toBe('function'));
        it('app.close() exists', () => expect(typeof integration._app.close).toBe('function'));
    });
});
