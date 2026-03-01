const assert = require('assert')
const http = require('http')
const fs = require('fs')
const path = require('path')

const pkg = require('../package.json')

console.log(`Running zero-http v${pkg.version} integration tests\n`)

let passed = 0
let failed = 0

function ok(condition, label)
{
    if (condition)
    {
        passed++
        console.log(`  \x1b[32m✓\x1b[0m ${label}`)
    }
    else
    {
        failed++
        console.log(`  \x1b[31m✗\x1b[0m ${label}`)
    }
}

async function run()
{
    const { createApp, json, urlencoded, text, raw, multipart, static: staticMid, cors, fetch, rateLimit, logger } = require('../')

    const uploadsDir = path.join(__dirname, 'tmp-uploads')
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

    const app = createApp()

    // Register middleware
    app.use(json({ limit: '1mb' }))
    app.use(urlencoded({ extended: false }))
    app.use(text({ type: 'text/*' }))
    app.use(raw({ type: 'application/octet-stream' }))

    // small static folder for test
    const staticFolder = path.join(__dirname, 'static')
    if (!fs.existsSync(staticFolder)) fs.mkdirSync(staticFolder, { recursive: true })
    fs.writeFileSync(path.join(staticFolder, 'hello.txt'), 'hello world')
    app.use('/static', staticMid(staticFolder))

    // Routes
    app.post('/echo-json', (req, res) => res.json({ body: req.body }))
    app.post('/echo-form', (req, res) => res.json({ body: req.body }))
    app.post('/echo-text', (req, res) => res.type('text').send(req.body))
    app.post('/echo-raw', (req, res) => res.send(Buffer.from(req.body || '')))
    app.get('/redirect-test', (req, res) => res.redirect('/destination'))
    app.get('/redirect-301', (req, res) => res.redirect(301, '/permanent'))
    app.get('/html-test', (req, res) => res.html('<h1>Hello</h1>'))
    app.patch('/patch-test', (req, res) => res.json({ method: 'PATCH', body: req.body }))
    app.all('/any-method', (req, res) => res.json({ method: req.method }))
    app.get('/error-test', () => { throw new Error('test error') })
    app.get('/req-helpers', (req, res) => res.json({ ip: req.ip, isJson: req.is('json'), query: req.query }))

    app.post('/upload', multipart({ dir: uploadsDir, maxFileSize: 5 * 1024 * 1024 }), (req, res) =>
    {
        res.json({ files: req.body.files || [], fields: req.body.fields || {} })
    })

    const server = http.createServer(app.handler)
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const base = `http://localhost:${port}`

    // Helper
    async function doFetch(url, opts)
    {
        const r = await fetch(url, opts)
        const ct = r.headers.get('content-type') || ''
        if (ct.includes('application/json')) return { data: await r.json(), status: r.status, headers: r.headers }
        return { data: await r.text(), status: r.status, headers: r.headers }
    }

    // ── Body Parsers ──────────────────────────────────
    console.log('\nBody Parsers:')

    let r = await doFetch(base + '/echo-json', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
    ok(r.data && r.data.body && r.data.body.a === 1, 'json parser')

    r = await doFetch(base + '/echo-form', { method: 'POST', body: 'a=1&b=two', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    ok(r.data && r.data.body && r.data.body.a === '1', 'urlencoded parser')

    r = await doFetch(base + '/echo-text', { method: 'POST', body: 'hello text', headers: { 'content-type': 'text/plain' } })
    ok(typeof r.data === 'string' && r.data.includes('hello text'), 'text parser')

    r = await doFetch(base + '/echo-raw', { method: 'POST', body: Buffer.from('raw-data'), headers: { 'content-type': 'application/octet-stream' } })
    ok(r.data !== undefined, 'raw parser')

    // ── Static Serving ────────────────────────────────
    console.log('\nStatic Serving:')

    r = await doFetch(base + '/static/hello.txt', { method: 'GET' })
    ok(typeof r.data === 'string' && r.data.includes('hello world'), 'static file serve')

    // ── Response Helpers ──────────────────────────────
    console.log('\nResponse Helpers:')

    r = await doFetch(base + '/html-test', { method: 'GET' })
    ok(typeof r.data === 'string' && r.data.includes('<h1>Hello</h1>'), 'res.html()')
    ok(r.headers.get('content-type').includes('text/html'), 'res.html() content-type')

    r = await fetch(base + '/redirect-test', { method: 'GET' })
    ok(r.status === 302, 'res.redirect() status 302')
    ok(r.headers.get('location') === '/destination', 'res.redirect() location header')

    r = await fetch(base + '/redirect-301', { method: 'GET' })
    ok(r.status === 301, 'res.redirect(301) status')

    // ── HTTP Methods ──────────────────────────────────
    console.log('\nHTTP Methods:')

    r = await doFetch(base + '/patch-test', { method: 'PATCH', body: JSON.stringify({ x: 1 }), headers: { 'content-type': 'application/json' } })
    ok(r.data && r.data.method === 'PATCH', 'PATCH method')

    r = await doFetch(base + '/any-method', { method: 'GET' })
    ok(r.data && r.data.method === 'GET', 'all() matches GET')

    r = await doFetch(base + '/any-method', { method: 'POST' })
    ok(r.data && r.data.method === 'POST', 'all() matches POST')

    r = await doFetch(base + '/any-method', { method: 'DELETE' })
    ok(r.data && r.data.method === 'DELETE', 'all() matches DELETE')

    // ── Error Handling ────────────────────────────────
    console.log('\nError Handling:')

    r = await doFetch(base + '/error-test', { method: 'GET' })
    ok(r.status === 500, 'thrown error returns 500')
    ok(r.data && r.data.error, 'thrown error returns error body')

    r = await doFetch(base + '/nonexistent', { method: 'GET' })
    ok(r.status === 404, '404 for unknown route')

    // ── Request Helpers ───────────────────────────────
    console.log('\nRequest Helpers:')

    r = await doFetch(base + '/req-helpers?foo=bar', { method: 'GET', headers: { 'content-type': 'application/json' } })
    ok(r.data && r.data.query && r.data.query.foo === 'bar', 'req.query parsing')
    ok(r.data && r.data.isJson === true, 'req.is() type check')
    ok(r.data && typeof r.data.ip === 'string', 'req.ip populated')

    // ── Multipart Upload ──────────────────────────────
    console.log('\nMultipart:')

    const boundary = '----zero-test-' + Date.now()
    const mparts = []
    mparts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="desc"\r\n\r\nmydesc\r\n`))
    mparts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello multipart\r\n`))
    mparts.push(Buffer.from(`--${boundary}--\r\n`))
    const mbody = Buffer.concat(mparts)

    r = await doFetch(base + '/upload', { method: 'POST', body: mbody, headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } })
    ok(r.data && r.data.files, 'multipart upload parses files')
    ok(r.data && r.data.fields && r.data.fields.desc === 'mydesc', 'multipart upload parses fields')

    // ── Rate Limiting ─────────────────────────────────
    console.log('\nRate Limiting:')
    ok(typeof rateLimit === 'function', 'rateLimit export exists')

    // ── Logger ────────────────────────────────────────
    console.log('\nLogger:')
    ok(typeof logger === 'function', 'logger export exists')

    // ── Cleanup ──
    server.close()
    try { fs.rmSync(uploadsDir, { recursive: true, force: true }) } catch (e) { }
    try { fs.rmSync(staticFolder, { recursive: true, force: true }) } catch (e) { }

    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 2
}

run().catch(err =>
{
    console.error('Tests crashed:', err)
    process.exitCode = 2
})
