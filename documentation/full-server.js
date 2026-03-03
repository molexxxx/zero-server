/**
 * zero-http full-server example
 * Organized with controllers and JSDoc comments for clarity and maintainability.
 */

// --- Crash protection ---
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT]', err); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED]', err); });

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createApp, cors, json, urlencoded, text, raw, multipart, static: serveStatic, fetch, logger, compress, Router } = require('..');

// --- App Initialization ---
const app = createApp();
app.use(logger({ format: 'dev' }));
app.use(cors());
app.use(compress());
app.use(json());
app.use(urlencoded());
app.use(text());
app.use(serveStatic(path.join(__dirname, 'public')));

// --- Controllers ---
const rootController = require('./controllers/root');
const headersController = require('./controllers/headers');
const echoController = require('./controllers/echo');
const uploadsController = require('./controllers/uploads');

// --- Core Routes ---
app.get('/', rootController.getRoot);
app.get('/headers', headersController.getHeaders);
app.post('/echo-json', echoController.echoJson);
app.post('/echo', echoController.echo);
app.post('/echo-urlencoded', echoController.echoUrlencoded);
app.post('/echo-text', echoController.echoText);
app.post('/echo-raw', raw(), echoController.echoRaw);

// --- Uploads and Trash ---
const uploadsDir = path.join(__dirname, 'uploads');
uploadsController.ensureUploadsDir(uploadsDir);

// Serve uploaded files from /uploads path using built-in path-prefix middleware
app.use('/uploads', serveStatic(uploadsDir));

// Upload, delete, restore, and trash routes
app.post('/upload', multipart({ maxFileSize: 5 * 1024 * 1024, dir: uploadsDir }), uploadsController.upload(uploadsDir));
app.delete('/uploads/:name', uploadsController.deleteUpload(uploadsDir));
app.delete('/uploads', uploadsController.deleteAllUploads(uploadsDir));
app.post('/uploads/:name/restore', uploadsController.restoreUpload(uploadsDir));
app.get('/uploads-trash-list', uploadsController.listTrash(uploadsDir));
app.delete('/uploads-trash/:name', uploadsController.deleteTrashItem(uploadsDir));
app.delete('/uploads-trash', uploadsController.emptyTrash(uploadsDir));

// --- Trash Retention ---
const TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS || 7);
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function autoEmptyTrash()
{
    try
    {
        const trash = path.join(uploadsDir, '.trash');
        if (!fs.existsSync(trash)) return;
        const now = Date.now();
        const removed = [];
        for (const f of fs.readdirSync(trash))
        {
            try
            {
                const p = path.join(trash, f);
                const st = fs.statSync(p);
                if (now - st.mtimeMs > TRASH_RETENTION_MS)
                {
                    fs.unlinkSync(p);
                    removed.push(f);
                    try { fs.unlinkSync(path.join(trash, '.thumbs', f + '-thumb.svg')); } catch (e) { }
                }
            } catch (e) { }
        }
        if (removed.length) console.log(`autoEmptyTrash: removed ${removed.length} file(s)`);
    } catch (e) { console.error('autoEmptyTrash error:', e); }
}

autoEmptyTrash();
setInterval(autoEmptyTrash, 24 * 60 * 60 * 1000).unref();

// --- Uploads Listings ---
app.get('/uploads-list', uploadsController.listUploads(uploadsDir));
app.get('/uploads-all', uploadsController.listAll(uploadsDir));

// --- Temp Cleanup ---
const cleanupController = require('./controllers/cleanup');
app.post('/cleanup', cleanupController.cleanup(path.join(os.tmpdir(), 'zero-http-uploads')));

// --- Proxy ---
const proxyController = require('./controllers/proxy');
const proxyFetch = (typeof globalThis !== 'undefined' && globalThis.fetch) || fetch;
app.get('/proxy', proxyController.proxy(proxyFetch));

// --- WebSocket Chat ---
const wsClients = new Set();

app.ws('/ws/chat', { maxPayload: 64 * 1024, pingInterval: 25000 }, (ws, req) =>
{
    ws.data.name = ws.query.name || 'anon';
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'system', text: 'Welcome, ' + ws.data.name + '!' }));

    // Broadcast join
    for (const c of wsClients)
    {
        if (c !== ws && c.readyState === 1)
            c.send(JSON.stringify({ type: 'system', text: ws.data.name + ' joined' }));
    }

    ws.on('message', (msg) =>
    {
        // Broadcast to all clients including sender
        const payload = JSON.stringify({ type: 'message', name: ws.data.name, text: String(msg) });
        for (const c of wsClients)
        {
            if (c.readyState === 1) c.send(payload);
        }
    });

    ws.on('close', () =>
    {
        wsClients.delete(ws);
        for (const c of wsClients)
        {
            if (c.readyState === 1)
                c.send(JSON.stringify({ type: 'system', text: ws.data.name + ' left' }));
        }
    });
});

// --- Server-Sent Events ---
const sseClients = new Set();

app.get('/sse/events', (req, res) =>
{
    const sse = res.sse({ retry: 5000, autoId: true, keepAlive: 30000 });
    sseClients.add(sse);
    sse.send({ type: 'connected', clients: sseClients.size });

    sse.on('close', () => sseClients.delete(sse));
});

app.post('/sse/broadcast', (req, res) =>
{
    const data = req.body || {};
    for (const sse of sseClients)
    {
        sse.event('broadcast', data);
    }
    res.json({ sent: sseClients.size });
});

// --- Router Demo (API sub-app) ---
const apiRouter = Router();

apiRouter.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
apiRouter.get('/info', (req, res) => res.json({
    secure: req.secure,
    protocol: req.protocol,
    ip: req.ip,
    method: req.method,
    url: req.url
}));

app.use('/api', apiRouter);

// --- Route introspection ---
app.get('/debug/routes', (req, res) =>
{
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify(app.routes(), null, 2));
});

// --- TLS Certificates (HTTPS + WSS) ---
const certPath = '/www/server/panel/vhost/cert/z-http.com/fullchain.pem';
const keyPath = '/www/server/panel/vhost/cert/z-http.com/privkey.pem';
const hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

const tlsOpts = hasCerts
    ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }
    : undefined;

// --- Server Startup ---
const port = process.env.PORT || 7273;
const server = app.listen(port, tlsOpts, () =>
{
    const proto = hasCerts ? 'https' : 'http';
    console.log(`zero-http full-server listening on ${proto}://localhost:${port}`);
    if (process.argv.includes('--test')) runTests(port).catch(console.error);
});


/** Quick smoke tests using built-in fetch */
async function runTests(port)
{
    const proto = hasCerts ? 'https' : 'http';
    const base = `${proto}://localhost:${port}`;
    console.log('running smoke tests against', base);

    const doReq = async (label, promise) =>
    {
        try
        {
            const r = await promise;
            const ct = r.headers.get('content-type') || '';
            const body = ct.includes('json') ? await r.json() : await r.text();
            console.log(` ${label}`, r.status, JSON.stringify(body));
        }
        catch (e) { console.error(` ${label} error:`, e.message); }
    };

    await doReq('GET /', fetch(base + '/'));
    await doReq('POST /echo-json', fetch(base + '/echo-json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }) }));
    await doReq('POST /echo-urlencoded', fetch(base + '/echo-urlencoded', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'foo=bar' }));
    await doReq('POST /echo-text', fetch(base + '/echo-text', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' }));
    await doReq('GET /headers', fetch(base + '/headers'));
    console.log('smoke tests complete');
}