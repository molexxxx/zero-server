/**
 * molex-http full-server example
 * Organized with controllers and JSDoc comments for clarity and maintainability.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createApp, cors, json, urlencoded, text, raw, multipart, static: serveStatic, fetch } = require('..');

// --- App Initialization ---
const app = createApp();
app.use(cors());
app.use(json());
app.use(urlencoded());
app.use(text());
app.use(serveStatic(path.join(__dirname, 'public')));

// --- Controllers ---
const rootController = require('./controllers/root');
const headersController = require('./controllers/headers');
const echoController = require('./controllers/echo');
const uploadController = require('./controllers/upload');
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
/** @type {string} Directory for uploads */
const uploadsDir = path.join(__dirname, 'uploads');
uploadsController.ensureUploadsDir(uploadsDir);

/**
 * Serves uploaded files and thumbnails from /uploads path.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Function} next
 */
app.use((req, res, next) =>
{
    if (!req.url || !req.url.startsWith('/uploads')) return next();
    const orig = req.url;
    req.url = req.url.slice('/uploads'.length) || '/';
    const mw = serveStatic(uploadsDir);
    return mw(req, res, (err) => { req.url = orig; next(err); });
});

/**
 * Handles multipart file uploads.
 */
app.post('/upload', multipart({ maxFileSize: 5 * 1024 * 1024, dir: uploadsDir }), uploadController.upload(uploadsDir));

/**
 * Deletes a single uploaded file (moves to trash).
 */
app.delete('/uploads/:name', uploadsController.deleteUpload(uploadsDir));

/**
 * Deletes all uploads (optionally keeps the first file).
 */
app.delete('/uploads', uploadsController.deleteAllUploads(uploadsDir));

/**
 * Restores a trashed file back into uploads.
 */
app.post('/uploads/:name/restore', uploadsController.restoreUpload(uploadsDir));

/**
 * Lists trashed files.
 */
app.get('/uploads-trash-list', uploadsController.listTrash(uploadsDir));

/**
 * Permanently deletes a trash item.
 */
app.delete('/uploads-trash/:name', uploadsController.deleteTrashItem(uploadsDir));

/**
 * Empties the trash.
 */
app.delete('/uploads-trash', uploadsController.emptyTrash(uploadsDir));

// --- Trash Retention ---
/**
 * Number of days to retain trashed files before auto-deletion.
 * @type {number}
 */
const TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS || 7);

/**
 * Automatically deletes trashed files older than TRASH_RETENTION_DAYS.
 */
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
                if (now - st.mtimeMs > TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
                {
                    fs.unlinkSync(p);
                    removed.push(f);
                    // also remove thumbnail if present
                    try
                    {
                        const tthumb = path.join(trash, '.thumbs', f + '-thumb.svg');
                        if (fs.existsSync(tthumb)) fs.unlinkSync(tthumb);
                    } catch (e) { }
                }
            } catch (e) { }
        }
        if (removed.length) console.log('autoEmptyTrash removed', removed.length, 'files');
    } catch (e) { console.error('autoEmptyTrash error', e); }
}
try { autoEmptyTrash(); setInterval(autoEmptyTrash, 24 * 60 * 60 * 1000); } catch (e) { }

// --- Uploads List ---
/**
 * Lists uploaded files with pagination and sorting.
 */
const uploadsListController = require('./controllers/uploadsList');
app.get('/uploads-list', uploadsListController.listUploads(uploadsDir));

// --- Temp Uploads Cleanup ---
/**
 * Cleans up uploaded temp files older than a threshold (seconds).
 */
const cleanupController = require('./controllers/cleanup');
const tmpDirPath = path.join(os.tmpdir(), 'molex-http-uploads');
app.post('/cleanup', cleanupController.cleanup(tmpDirPath));

// --- Proxy Example ---
/**
 * Example proxy endpoint using built-in fetch. Pass ?url=https://example.com to proxy an external resource.
 */
const proxyController = require('./controllers/proxy');
app.get('/proxy', proxyController.proxy(fetch));

// --- Server Startup ---
/**
 * Starts the server and runs optional tests.
 */
const port = process.env.PORT || 3000;
const server = app.listen(port, () =>
{
    console.log(`molex-http full-server listening on http://localhost:${port}`);
    if (process.argv.includes('--test')) runTests(port).catch(e => console.error(e));
});

/**
 * Optional test runner using built-in fetch.
 * @param {number|string} port
 */
async function runTests(port)
{
    const base = `http://localhost:${port}`;
    const meFetch = fetch;
    console.log('running built-in quick tests against', base);
    const doReq = async (label, p) =>
    {
        try
        {
            const res = await p;
            const ct = res.headers['content-type'] || res.headers['Content-Type'] || '';
            const body = ct.includes('application/json') ? await res.json() : await res.text();
            console.log(label, res.status, JSON.stringify(body));
        } catch (e) { console.error(label, 'error', e); }
    };
    await doReq('GET /', meFetch(base + '/'));
    await doReq('POST /echo-json', meFetch(base + '/echo-json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }) }));
    await doReq('POST /echo-urlencoded', meFetch(base + '/echo-urlencoded', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'foo=bar' }));
    await doReq('POST /echo-text', meFetch(base + '/echo-text', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' }));
    await doReq('GET /headers', meFetch(base + '/headers'));
    console.log('quick tests complete');

}