/**
 * zero-http full-server example
 * Clean entry point — config, middleware, and routes are in separate modules.
 */

// --- Crash protection ---
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT]', err); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED]', err); });

const path = require('path');
const { createApp, env, fetch } = require('..');

// --- Environment ---
env.load(path.join(__dirname, '..', '.env'));

// --- App ---
const app = createApp();

// --- Middleware ---
const { applyMiddleware } = require('./config/middleware');
applyMiddleware(app);

// --- Routes ---
require('./routes/core')(app);
require('./routes/uploads')(app);
require('./routes/realtime')(app);
require('./routes/playground')(app);
require('./routes/api')(app);

// --- TLS ---
const { hasCerts, tlsOpts } = require('./config/tls');

// --- Start ---
const port = process.env.PORT || 7273;
app.listen(port, tlsOpts, () =>
{
    const proto = hasCerts ? 'https' : 'http';
    console.log(`zero-http full-server listening on ${proto}://localhost:${port}`);
    if (process.argv.includes('--test')) runTests(port).catch(console.error);
});

/** Quick smoke tests using built-in fetch */
async function runTests(port)
{
    const proto = hasCerts ? 'https' : 'http';
    const base  = `${proto}://localhost:${port}`;
    console.log('running smoke tests against', base);

    const doReq = async (label, promise) =>
    {
        try
        {
            const r  = await promise;
            const ct = r.headers.get('content-type') || '';
            const body = ct.includes('json') ? await r.json() : await r.text();
            console.log(` ${label}`, r.status, JSON.stringify(body));
        }
        catch (e) { console.error(` ${label} error:`, e.message); }
    };

    await doReq('GET /',               fetch(base + '/'));
    await doReq('POST /echo-json',     fetch(base + '/echo-json',     { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }) }));
    await doReq('POST /echo-urlencoded', fetch(base + '/echo-urlencoded', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'foo=bar' }));
    await doReq('POST /echo-text',     fetch(base + '/echo-text',     { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' }));
    await doReq('GET /headers',        fetch(base + '/headers'));
    console.log('smoke tests complete');
}