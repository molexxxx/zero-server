const assert = require('assert')
const http = require('http')
const fs = require('fs')
const path = require('path')

// Try to require the local package entry points
const pkg = require('../package.json')
const root = path.join(__dirname, '..')

console.log('Running molex-http integration tests')

async function run()
{
    const { createApp, json, urlencoded, text, raw, multipart, static: staticMid, cors, fetch } = require('../')

    const uploadsDir = path.join(__dirname, 'tmp-uploads')
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

    const app = createApp()

    app.use(json({ limit: '1mb' }))
    app.use(urlencoded({ extended: false }))
    app.use(text({ type: 'text/*' }))
    app.use(raw({ type: 'application/octet-stream' }))

    // small static folder for test
    const staticFolder = path.join(__dirname, 'static')
    if (!fs.existsSync(staticFolder)) fs.mkdirSync(staticFolder, { recursive: true })
    fs.writeFileSync(path.join(staticFolder, 'hello.txt'), 'hello world')
    app.use('/static', staticMid(staticFolder))

    app.post('/echo-json', (req, res) => res.json({ body: req.body }))
    app.post('/echo-form', (req, res) => res.json({ body: req.body }))
    app.post('/echo-text', (req, res) => res.type('text').send(req.body))
    app.post('/echo-raw', (req, res) => res.send(Buffer.from(req.body || '')))

    app.post('/upload', multipart({ dir: uploadsDir, maxFileSize: 5 * 1024 * 1024 }), (req, res) =>
    {
        res.json({ files: req.body.files || [], fields: req.body.fields || {} })
    })

    const server = http.createServer(app.handler)
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const base = `http://localhost:${port}`

    // helper to do fetch
    async function doFetch(url, opts)
    {
        const r = await fetch(url, opts)
        const ct = (r.headers && r.headers['content-type']) || ''
        if (ct.includes('application/json')) return r.json()
        return r.text()
    }

    // JSON
    let r = await doFetch(base + '/echo-json', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
    assert(r && r.body && r.body.a === 1, 'json parser failed')

    // urlencoded
    r = await doFetch(base + '/echo-form', { method: 'POST', body: 'a=1&b=two', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert(r && r.body && r.body.a === '1', 'urlencoded parser failed')

    // text
    r = await doFetch(base + '/echo-text', { method: 'POST', body: 'hello text', headers: { 'content-type': 'text/plain' } })
    assert(typeof r === 'string' && r.includes('hello text'), 'text parser failed')

    // raw
    r = await doFetch(base + '/echo-raw', { method: 'POST', body: Buffer.from('raw-data'), headers: { 'content-type': 'application/octet-stream' } })
    assert(Buffer.isBuffer(r) || (typeof r === 'string'), 'raw parser failed')

    // static
    r = await doFetch(base + '/static/hello.txt', { method: 'GET' })
    assert(typeof r === 'string' && r.includes('hello world'), 'static serve failed')

    // multipart upload (construct a simple multipart body)
    const boundary = '----molex-http-test-' + Date.now()
    const parts = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="desc"\r\n\r\nmydesc\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello multipart\r\n`))
    parts.push(Buffer.from(`--${boundary}--\r\n`))
    const body = Buffer.concat(parts)

    const multipartResp = await doFetch(base + '/upload', { method: 'POST', body, headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } })
    assert(multipartResp && multipartResp.files && multipartResp.files.length >= 1, 'multipart upload failed')

    // cleanup
    server.close()
    // remove tmp files
    try { fs.rmSync(uploadsDir, { recursive: true, force: true }) } catch (e) { }
    try { fs.rmSync(staticFolder, { recursive: true, force: true }) } catch (e) { }

    console.log('All tests passed')
}

run().catch(err =>
{
    console.error('Tests failed:', err)
    process.exitCode = 2
})
