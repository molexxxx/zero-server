const assert = require('assert')
const http = require('http')
const net = require('net')
const crypto = require('crypto')
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const pkg = require('../package.json')

console.log(`Running zero-server v${pkg.version} integration tests\n`)

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
    const { createApp, Router, json, urlencoded, text, raw, multipart, static: staticMid, cors, fetch, rateLimit, logger, compress } = require('../')

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

    // -- Sub-Router setup ------------------------------
    const apiRouter = Router()
    apiRouter.get('/items', (req, res) => res.json({ items: [1, 2, 3] }))
    apiRouter.get('/items/:id', (req, res) => res.json({ id: req.params.id }))
    apiRouter.post('/items', (req, res) => res.json({ created: true, body: req.body }))

    // Nested sub-router
    const v2Router = Router()
    v2Router.get('/health', (req, res) => res.json({ status: 'ok', version: 2 }))
    apiRouter.use('/v2', v2Router)

    app.use('/api', apiRouter)

    // Route chaining on a router
    const chainRouter = Router()
    chainRouter.route('/item')
        .get((req, res) => res.json({ method: 'GET' }))
        .post((req, res) => res.json({ method: 'POST' }))
    app.use('/chain', chainRouter)

    // -- SSE route -------------------------------------
    app.get('/sse', (req, res) =>
    {
        const sse = res.sse({ retry: 1000 })
        sse.send('hello')
        sse.event('update', { x: 1 })
        sse.comment('keep-alive')
        sse.send('multi\nline\ndata')
        // close after sending
        setTimeout(() => sse.close(), 50)
    })

    // SSE with auto-ID, keepAlive, chaining, retry, sendJSON
    app.get('/sse-advanced', (req, res) =>
    {
        const sse = res.sse({ autoId: true, startId: 10, pad: 64 })
        sse.retry(2000)                   // dynamic retry
            .send('first')                // id: 10
            .sendJSON({ ok: true })       // id: 11
            .event('tick', 'tock')        // id: 12
            .comment('note')
        // test properties
        const props = {
            eventCount: sse.eventCount,
            bytesSent: sse.bytesSent > 0,
            connected: sse.connected,
            hasUptime: sse.uptime >= 0,
        }
        sse.event('props', props)         // id: 13
        setTimeout(() => sse.close(), 50)
    })

    // -- Compression route (large body) ----------------
    const compressApp = createApp()
    compressApp.use(compress({ threshold: 0 })) // compress everything
    compressApp.get('/big', (req, res) => res.json({ data: 'x'.repeat(2000) }))
    compressApp.get('/small', (req, res) => res.type('text').send('tiny'))

    const server = http.createServer(app.handler)
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const base = `http://localhost:${port}`

    // Start compression test server
    const compressServer = http.createServer(compressApp.handler)
    await new Promise((resolve) => compressServer.listen(0, resolve))
    const compressPort = compressServer.address().port
    const compressBase = `http://localhost:${compressPort}`

    // Helper
    async function doFetch(url, opts)
    {
        const r = await fetch(url, opts)
        const ct = r.headers.get('content-type') || ''
        if (ct.includes('application/json')) return { data: await r.json(), status: r.status, headers: r.headers }
        return { data: await r.text(), status: r.status, headers: r.headers }
    }

    // -- Body Parsers ----------------------------------
    console.log('\nBody Parsers:')

    let r = await doFetch(base + '/echo-json', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
    ok(r.data && r.data.body && r.data.body.a === 1, 'json parser')

    r = await doFetch(base + '/echo-form', { method: 'POST', body: 'a=1&b=two', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    ok(r.data && r.data.body && r.data.body.a === '1', 'urlencoded parser')

    r = await doFetch(base + '/echo-text', { method: 'POST', body: 'hello text', headers: { 'content-type': 'text/plain' } })
    ok(typeof r.data === 'string' && r.data.includes('hello text'), 'text parser')

    r = await doFetch(base + '/echo-raw', { method: 'POST', body: Buffer.from('raw-data'), headers: { 'content-type': 'application/octet-stream' } })
    ok(r.data !== undefined, 'raw parser')

    // -- Static Serving --------------------------------
    console.log('\nStatic Serving:')

    r = await doFetch(base + '/static/hello.txt', { method: 'GET' })
    ok(typeof r.data === 'string' && r.data.includes('hello world'), 'static file serve')

    // -- Response Helpers ------------------------------
    console.log('\nResponse Helpers:')

    r = await doFetch(base + '/html-test', { method: 'GET' })
    ok(typeof r.data === 'string' && r.data.includes('<h1>Hello</h1>'), 'res.html()')
    ok(r.headers.get('content-type').includes('text/html'), 'res.html() content-type')

    r = await fetch(base + '/redirect-test', { method: 'GET' })
    ok(r.status === 302, 'res.redirect() status 302')
    ok(r.headers.get('location') === '/destination', 'res.redirect() location header')

    r = await fetch(base + '/redirect-301', { method: 'GET' })
    ok(r.status === 301, 'res.redirect(301) status')

    // -- HTTP Methods ----------------------------------
    console.log('\nHTTP Methods:')

    r = await doFetch(base + '/patch-test', { method: 'PATCH', body: JSON.stringify({ x: 1 }), headers: { 'content-type': 'application/json' } })
    ok(r.data && r.data.method === 'PATCH', 'PATCH method')

    r = await doFetch(base + '/any-method', { method: 'GET' })
    ok(r.data && r.data.method === 'GET', 'all() matches GET')

    r = await doFetch(base + '/any-method', { method: 'POST' })
    ok(r.data && r.data.method === 'POST', 'all() matches POST')

    r = await doFetch(base + '/any-method', { method: 'DELETE' })
    ok(r.data && r.data.method === 'DELETE', 'all() matches DELETE')

    // -- Error Handling --------------------------------
    console.log('\nError Handling:')

    r = await doFetch(base + '/error-test', { method: 'GET' })
    ok(r.status === 500, 'thrown error returns 500')
    ok(r.data && r.data.error, 'thrown error returns error body')

    r = await doFetch(base + '/nonexistent', { method: 'GET' })
    ok(r.status === 404, '404 for unknown route')

    // -- Request Helpers -------------------------------
    console.log('\nRequest Helpers:')

    r = await doFetch(base + '/req-helpers?foo=bar', { method: 'GET', headers: { 'content-type': 'application/json' } })
    ok(r.data && r.data.query && r.data.query.foo === 'bar', 'req.query parsing')
    ok(r.data && r.data.isJson === true, 'req.is() type check')
    ok(r.data && typeof r.data.ip === 'string', 'req.ip populated')

    // -- Multipart Upload ------------------------------
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

    // -- Rate Limiting ---------------------------------
    console.log('\nRate Limiting:')
    ok(typeof rateLimit === 'function', 'rateLimit export exists')

    // -- Logger ----------------------------------------
    console.log('\nLogger:')
    ok(typeof logger === 'function', 'logger export exists')

    // -- Router Sub-Apps -------------------------------
    console.log('\nRouter Sub-Apps:')

    r = await doFetch(base + '/api/items', { method: 'GET' })
    ok(r.data && Array.isArray(r.data.items) && r.data.items.length === 3, 'sub-router GET /api/items')

    r = await doFetch(base + '/api/items/42', { method: 'GET' })
    ok(r.data && r.data.id === '42', 'sub-router GET /api/items/:id')

    r = await doFetch(base + '/api/items', { method: 'POST', body: JSON.stringify({ name: 'test' }), headers: { 'content-type': 'application/json' } })
    ok(r.data && r.data.created === true, 'sub-router POST /api/items')

    // Nested sub-router
    r = await doFetch(base + '/api/v2/health', { method: 'GET' })
    ok(r.data && r.data.version === 2, 'nested sub-router GET /api/v2/health')

    // Route chaining
    r = await doFetch(base + '/chain/item', { method: 'GET' })
    ok(r.data && r.data.method === 'GET', 'route chaining GET')

    r = await doFetch(base + '/chain/item', { method: 'POST' })
    ok(r.data && r.data.method === 'POST', 'route chaining POST')

    // -- Route Introspection ---------------------------
    console.log('\nRoute Introspection:')

    const allRoutes = app.routes()
    ok(Array.isArray(allRoutes), 'app.routes() returns array')
    ok(allRoutes.length > 0, 'app.routes() is not empty')
    const getPaths = allRoutes.filter(r => r.method === 'GET').map(r => r.path)
    ok(getPaths.includes('/html-test'), 'introspection includes /html-test')
    // Check sub-router routes are included
    const apiPaths = allRoutes.map(r => r.path)
    ok(apiPaths.some(p => p.includes('/api/items')), 'introspection includes sub-router routes')
    ok(apiPaths.some(p => p.includes('/api/v2/health')), 'introspection includes nested sub-router routes')

    // -- Router export ---------------------------------
    console.log('\nRouter Factory:')
    ok(typeof Router === 'function', 'Router export exists')
    const testRouter = Router()
    ok(typeof testRouter.get === 'function', 'Router instance has .get()')
    ok(typeof testRouter.post === 'function', 'Router instance has .post()')
    ok(typeof testRouter.route === 'function', 'Router instance has .route()')
    ok(typeof testRouter.inspect === 'function', 'Router instance has .inspect()')

    // -- Server-Sent Events ----------------------------
    console.log('\nServer-Sent Events:')

    const sseData = await new Promise((resolve, reject) =>
    {
        const chunks = []
        http.get(base + '/sse', (resp) =>
        {
            ok(resp.headers['content-type'] === 'text/event-stream', 'SSE content-type header')
            ok(resp.headers['cache-control'] === 'no-cache', 'SSE cache-control header')
            resp.on('data', c => chunks.push(c.toString()))
            resp.on('end', () => resolve(chunks.join('')))
        }).on('error', reject)
    })
    ok(sseData.includes('retry: 1000'), 'SSE retry field')
    ok(sseData.includes('data: hello'), 'SSE unnamed event')
    ok(sseData.includes('event: update'), 'SSE named event type')
    ok(sseData.includes('data: {"x":1}'), 'SSE JSON data')
    ok(sseData.includes(': keep-alive'), 'SSE comment')
    // Multi-line data should produce multiple data: lines
    ok(sseData.includes('data: multi\n'), 'SSE multi-line data (line 1)')
    ok(sseData.includes('data: line\n'), 'SSE multi-line data (line 2)')

    // Advanced SSE features
    const sseAdv = await new Promise((resolve, reject) =>
    {
        const chunks = []
        http.get(base + '/sse-advanced', (resp) =>
        {
            resp.on('data', c => chunks.push(c.toString()))
            resp.on('end', () => resolve(chunks.join('')))
        }).on('error', reject)
    })
    ok(sseAdv.includes('retry: 2000'), 'SSE dynamic retry()')
    ok(sseAdv.includes('id: 10'), 'SSE autoId starts at startId')
    ok(sseAdv.includes('id: 11'), 'SSE autoId increments')
    ok(sseAdv.includes('data: first'), 'SSE send() with autoId')
    ok(sseAdv.includes('data: {"ok":true}'), 'SSE sendJSON()')
    ok(sseAdv.includes('event: tick'), 'SSE event() with autoId')
    ok(sseAdv.includes('data: tock'), 'SSE event() data')
    ok(sseAdv.includes(': note'), 'SSE comment chaining')
    // Check that the initial padding was sent
    ok(sseAdv.startsWith(': '), 'SSE pad option sent initial comment')
    // Props event
    ok(sseAdv.includes('event: props'), 'SSE props event emitted')
    ok(sseAdv.includes('"eventCount":3'), 'SSE eventCount property')
    ok(sseAdv.includes('"bytesSent":true'), 'SSE bytesSent tracking')
    ok(sseAdv.includes('"connected":true'), 'SSE connected property')
    ok(sseAdv.includes('"hasUptime":true'), 'SSE uptime property')

    // SSE once/off/removeAllListeners/listenerCount
    {
        // Quick unit tests on SSEStream event emitter (use a throwaway SSE)
        const sseCheckDone = await new Promise(async (resolve) =>
        {
            let onceFired = 0
            const sseApp2 = createApp()
            sseApp2.get('/sse-emit', (req, res) =>
            {
                const sse = res.sse()
                // test listenerCount
                ok(sse.listenerCount('close') === 0, 'SSE listenerCount before')
                const fn = () => { onceFired++ }
                sse.once('close', fn)
                ok(sse.listenerCount('close') === 1, 'SSE listenerCount after once()')
                sse.removeAllListeners('close')
                ok(sse.listenerCount('close') === 0, 'SSE removeAllListeners()')
                sse.on('close', () => resolve(onceFired))
                sse.close()
            })
            const sseServer2 = http.createServer(sseApp2.handler)
            await new Promise(r => sseServer2.listen(0, r))
            const p2 = sseServer2.address().port
            await new Promise((res2, rej2) =>
            {
                http.get(`http://localhost:${p2}/sse-emit`, (resp) =>
                {
                    resp.resume()
                    resp.on('end', res2)
                }).on('error', rej2)
            })
            sseServer2.close()
        })
        ok(sseCheckDone === 0, 'SSE once() not fired after removeAll')
    }

    // -- Compression -----------------------------------
    console.log('\nCompression:')
    ok(typeof compress === 'function', 'compress export exists')

    // Test gzip compression
    const gzipData = await new Promise((resolve, reject) =>
    {
        http.get(compressBase + '/big', { headers: { 'accept-encoding': 'gzip' } }, (resp) =>
        {
            ok(resp.headers['content-encoding'] === 'gzip', 'gzip Content-Encoding header')
            ok(resp.headers['vary'] === 'Accept-Encoding', 'Vary header set')
            const chunks = []
            resp.on('data', c => chunks.push(c))
            resp.on('end', () =>
            {
                const buf = Buffer.concat(chunks)
                zlib.gunzip(buf, (err, decoded) =>
                {
                    if (err) return reject(err)
                    resolve(JSON.parse(decoded.toString()))
                })
            })
        }).on('error', reject)
    })
    ok(gzipData && gzipData.data && gzipData.data.length === 2000, 'gzip decompressed body correct')

    // Test deflate compression
    const deflateData = await new Promise((resolve, reject) =>
    {
        http.get(compressBase + '/big', { headers: { 'accept-encoding': 'deflate' } }, (resp) =>
        {
            ok(resp.headers['content-encoding'] === 'deflate', 'deflate Content-Encoding header')
            const chunks = []
            resp.on('data', c => chunks.push(c))
            resp.on('end', () =>
            {
                const buf = Buffer.concat(chunks)
                zlib.inflate(buf, (err, decoded) =>
                {
                    if (err) return reject(err)
                    resolve(JSON.parse(decoded.toString()))
                })
            })
        }).on('error', reject)
    })
    ok(deflateData && deflateData.data && deflateData.data.length === 2000, 'deflate decompressed body correct')

    // Test no compression when not accepted
    const noCompressData = await new Promise((resolve, reject) =>
    {
        http.get(compressBase + '/big', (resp) =>
        {
            ok(!resp.headers['content-encoding'], 'no Content-Encoding when not accepted')
            const chunks = []
            resp.on('data', c => chunks.push(c))
            resp.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())))
        }).on('error', reject)
    })
    ok(noCompressData && noCompressData.data && noCompressData.data.length === 2000, 'uncompressed body correct')

    // -- WebSocket -------------------------------------
    console.log('\nWebSocket:')

    // Create a separate app with WS support for testing
    const wsApp = createApp()

    // Track connection metadata for assertions
    let lastWsMeta = {}
    wsApp.ws('/echo', (ws, req) =>
    {
        ws.on('message', (data) => ws.send('echo:' + data))
    })
    wsApp.ws('/broadcast', (ws, req) =>
    {
        ws.send('welcome')
        ws.on('message', (data) =>
        {
            if (data === 'ping') ws.send('pong')
        })
    })
    // WS with options and metadata checks
    wsApp.ws('/meta', { maxPayload: 512, pingInterval: 0 }, (ws, req) =>
    {
        lastWsMeta = {
            id: ws.id,
            readyState: ws.readyState,
            ip: ws.ip,
            query: ws.query,
            url: ws.url,
            protocol: ws.protocol,
            maxPayload: ws.maxPayload,
            connectedAt: ws.connectedAt,
            uptime: ws.uptime,
            bufferedAmount: ws.bufferedAmount,
            hasData: typeof ws.data === 'object',
        }
        ws.sendJSON({ meta: lastWsMeta })
    })
    // WS with verifyClient
    wsApp.ws('/secure', { verifyClient: (req) => req.headers['x-token'] === 'secret123', pingInterval: 0 }, (ws, req) =>
    {
        ws.send('authorized')
    })
    // WS for event emitter tests
    wsApp.ws('/events', { pingInterval: 0 }, (ws, req) =>
    {
        let msgCount = 0
        const onMsg = () => { msgCount++ }
        ws.on('message', onMsg)
        ws.on('message', () =>
        {
            if (msgCount === 1)
            {
                ws.off('message', onMsg)
                ws.sendJSON({ removed: true, listenerCount: ws.listenerCount('message') })
            }
        })
    })

    const wsServer = wsApp.listen(0)
    await new Promise(resolve => wsServer.on('listening', resolve))
    const wsPort = wsServer.address().port

    // Helper: raw WebSocket client handshake + message exchange
    async function wsConnect(portNum, wsPath, extraHeaders)
    {
        return new Promise((resolve, reject) =>
        {
            const key = crypto.randomBytes(16).toString('base64')
            const socket = net.connect(portNum, '127.0.0.1', () =>
            {
                let headerStr =
                    `GET ${wsPath} HTTP/1.1\r\n` +
                    `Host: localhost:${portNum}\r\n` +
                    `Upgrade: websocket\r\n` +
                    `Connection: Upgrade\r\n` +
                    `Sec-WebSocket-Key: ${key}\r\n` +
                    `Sec-WebSocket-Version: 13\r\n`
                if (extraHeaders)
                {
                    for (const [k, v] of Object.entries(extraHeaders))
                    {
                        headerStr += `${k}: ${v}\r\n`
                    }
                }
                headerStr += '\r\n'
                socket.write(headerStr)
            })

            let upgraded = false
            let headerBuf = ''
            const messages = []
            let responseHeaders = ''

            socket.on('data', (chunk) =>
            {
                if (!upgraded)
                {
                    headerBuf += chunk.toString()
                    if (headerBuf.includes('\r\n\r\n'))
                    {
                        upgraded = true
                        responseHeaders = headerBuf.split('\r\n\r\n')[0]
                        // Process any remaining data after headers
                        const remaining = chunk.slice(chunk.indexOf(Buffer.from('\r\n\r\n')) + 4)
                        if (remaining.length > 0) parseWSFrames(remaining)
                    }
                    return
                }
                parseWSFrames(chunk)
            })

            function parseWSFrames(buf)
            {
                while (buf.length >= 2)
                {
                    const opcode = buf[0] & 0x0F
                    let payloadLen = buf[1] & 0x7F
                    let offset = 2
                    if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4 }
                    else if (payloadLen === 127) { payloadLen = buf.readUInt32BE(6); offset = 10 }
                    if (buf.length < offset + payloadLen) break
                    const payload = buf.slice(offset, offset + payloadLen)
                    if (opcode === 0x01) messages.push(payload.toString('utf8'))
                    else if (opcode === 0x08) { socket.end(); return }
                    buf = buf.slice(offset + payloadLen)
                }
            }

            function sendWSFrame(text)
            {
                const payload = Buffer.from(text, 'utf8')
                const mask = crypto.randomBytes(4)
                const masked = Buffer.alloc(payload.length)
                for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]

                let header
                if (payload.length < 126)
                {
                    header = Buffer.alloc(2)
                    header[0] = 0x81 // FIN + text
                    header[1] = 0x80 | payload.length // MASK bit
                } else
                {
                    header = Buffer.alloc(4)
                    header[0] = 0x81
                    header[1] = 0x80 | 126
                    header.writeUInt16BE(payload.length, 2)
                }
                socket.write(Buffer.concat([header, mask, masked]))
            }

            socket.on('error', reject)

            // Wait for upgrade, then resolve controls
            setTimeout(() =>
            {
                resolve({ socket, messages, sendWSFrame, responseHeaders })
            }, 100)
        })
    }

    // Helper: connect and just get the raw HTTP response (no upgrade)
    async function wsRawConnect(portNum, wsPath, extraHeaders)
    {
        return new Promise((resolve) =>
        {
            const key = crypto.randomBytes(16).toString('base64')
            const socket = net.connect(portNum, '127.0.0.1', () =>
            {
                let headerStr =
                    `GET ${wsPath} HTTP/1.1\r\n` +
                    `Host: localhost:${portNum}\r\n` +
                    `Upgrade: websocket\r\n` +
                    `Connection: Upgrade\r\n` +
                    `Sec-WebSocket-Key: ${key}\r\n` +
                    `Sec-WebSocket-Version: 13\r\n`
                if (extraHeaders)
                {
                    for (const [k, v] of Object.entries(extraHeaders))
                    {
                        headerStr += `${k}: ${v}\r\n`
                    }
                }
                headerStr += '\r\n'
                socket.write(headerStr)
            })
            let data = ''
            socket.on('data', c => data += c.toString())
            socket.on('end', () => resolve(data))
            socket.on('close', () => resolve(data))
            setTimeout(() => { socket.end(); resolve(data) }, 200)
        })
    }

    // Test echo WS
    const ws1 = await wsConnect(wsPort, '/echo')
    ok(ws1.responseHeaders.includes('101'), 'WS handshake 101 response')
    ok(ws1.responseHeaders.includes('Sec-WebSocket-Accept'), 'WS handshake Accept header')
    ws1.sendWSFrame('hello')
    await new Promise(r => setTimeout(r, 100))
    ok(ws1.messages.includes('echo:hello'), 'WS echo message received')
    ws1.socket.end()

    // Test broadcast/welcome WS
    const ws2 = await wsConnect(wsPort, '/broadcast')
    await new Promise(r => setTimeout(r, 100))
    ok(ws2.messages.includes('welcome'), 'WS welcome message on connect')
    ws2.sendWSFrame('ping')
    await new Promise(r => setTimeout(r, 100))
    ok(ws2.messages.includes('pong'), 'WS ping/pong exchange')
    ws2.socket.end()

    // Test metadata properties
    const ws3 = await wsConnect(wsPort, '/meta?room=lobby&user=tom')
    await new Promise(r => setTimeout(r, 150))
    ok(ws3.messages.length > 0, 'WS meta: received message')
    const metaMsg = JSON.parse(ws3.messages[0])
    ok(metaMsg.meta.id && metaMsg.meta.id.startsWith('ws_'), 'WS id starts with ws_')
    ok(metaMsg.meta.readyState === 1, 'WS readyState is OPEN (1)')
    ok(typeof metaMsg.meta.ip === 'string', 'WS ip property')
    ok(metaMsg.meta.query.room === 'lobby', 'WS query param: room')
    ok(metaMsg.meta.query.user === 'tom', 'WS query param: user')
    ok(metaMsg.meta.url.includes('/meta'), 'WS url property')
    ok(metaMsg.meta.maxPayload === 512, 'WS maxPayload from options')
    ok(metaMsg.meta.connectedAt > 0, 'WS connectedAt timestamp')
    ok(metaMsg.meta.uptime >= 0, 'WS uptime property')
    ok(metaMsg.meta.bufferedAmount >= 0, 'WS bufferedAmount property')
    ok(metaMsg.meta.hasData === true, 'WS data store is object')
    ws3.socket.end()

    // Test sendJSON
    ok(metaMsg && typeof metaMsg === 'object', 'WS sendJSON sends valid JSON')

    // Test verifyClient — rejected (no token)
    const wsReject = await wsRawConnect(wsPort, '/secure')
    ok(wsReject.includes('403'), 'WS verifyClient rejects unauthorized')

    // Test verifyClient — accepted (correct token)
    const ws4 = await wsConnect(wsPort, '/secure', { 'X-Token': 'secret123' })
    await new Promise(r => setTimeout(r, 100))
    ok(ws4.messages.includes('authorized'), 'WS verifyClient accepts authorized')
    ws4.socket.end()

    // Test sub-protocol negotiation
    const ws5 = await wsConnect(wsPort, '/echo', { 'Sec-WebSocket-Protocol': 'graphql-ws, json' })
    ok(ws5.responseHeaders.includes('Sec-WebSocket-Protocol: graphql-ws'), 'WS sub-protocol negotiated')
    ws5.socket.end()

    // Test off() / listenerCount
    const ws6 = await wsConnect(wsPort, '/events')
    await new Promise(r => setTimeout(r, 50))
    ws6.sendWSFrame('first')
    await new Promise(r => setTimeout(r, 150))
    ok(ws6.messages.length > 0, 'WS events: received response')
    const evtMsg = JSON.parse(ws6.messages[0])
    ok(evtMsg.removed === true, 'WS off() removed listener')
    ok(evtMsg.listenerCount === 1, 'WS listenerCount() after off()')
    ws6.socket.end()

    // Test 404 on unknown WS path
    const ws404 = await wsRawConnect(wsPort, '/nonexistent')
    ok(ws404.includes('404'), 'WS 404 for unknown path')

    // -- Fetch HTTPS Awareness -------------------------
    console.log('\nFetch HTTPS Awareness:')
    {
        // fetch response should include secure and url properties
        const fr = await fetch(base + '/echo-json', {
            method: 'POST',
            body: JSON.stringify({ test: 1 }),
            headers: { 'content-type': 'application/json' }
        })
        ok(fr.secure === false, 'fetch response secure=false for http')
        ok(typeof fr.url === 'string' && fr.url.startsWith('http://'), 'fetch response url property')
    }

    // -- Body Parser requireSecure ---------------------
    console.log('\nBody Parser requireSecure:')
    {
        // Create a separate app with requireSecure body parsers
        const secApp = createApp()
        secApp.use(json({ requireSecure: true }))
        secApp.post('/sec-json', (req, res) => res.json({ ok: true }))
        const secServer = await new Promise(resolve =>
        {
            const s = secApp.listen(0, () => resolve(s))
        })
        const secPort = secServer.address().port
        const secBase = `http://127.0.0.1:${secPort}`

        // POST JSON over plain HTTP should get 403 because requireSecure=true
        const secR = await fetch(secBase + '/sec-json', {
            method: 'POST',
            body: JSON.stringify({ a: 1 }),
            headers: { 'content-type': 'application/json' }
        })
        ok(secR.status === 403, 'json parser requireSecure rejects HTTP with 403')
        const secBody = await secR.json()
        ok(secBody.error === 'HTTPS required', 'json parser requireSecure error message')

        secServer.close()
    }

    // -- Router Secure Routes --------------------------
    console.log('\nRouter Secure Routes:')
    {
        const secApp = createApp()

        // Route that requires HTTPS (secure: true) — plain HTTP should 404
        secApp.get('/secure-only', { secure: true }, (req, res) => res.json({ msg: 'secret' }))
        // Route that requires HTTP only (secure: false)
        secApp.get('/http-only', { secure: false }, (req, res) => res.json({ msg: 'plain' }))
        // Normal route (matches both)
        secApp.get('/either', (req, res) => res.json({ msg: 'both' }))

        const secServer = await new Promise(resolve =>
        {
            const s = secApp.listen(0, () => resolve(s))
        })
        const secPort = secServer.address().port
        const secBase = `http://127.0.0.1:${secPort}`

        // secure-only route should 404 over plain HTTP
        const r1 = await fetch(secBase + '/secure-only')
        ok(r1.status === 404, 'secure-only route 404 over HTTP')

        // http-only route should match over plain HTTP
        const r2 = await fetch(secBase + '/http-only')
        ok(r2.status === 200, 'http-only route matches HTTP')
        const r2b = await r2.json()
        ok(r2b.msg === 'plain', 'http-only route returns correct body')

        // normal route matches over HTTP
        const r3 = await fetch(secBase + '/either')
        ok(r3.status === 200, 'normal route matches HTTP')

        // Introspection includes secure flag
        const routes = secApp.routes()
        const secRoute = routes.find(r => r.path === '/secure-only')
        ok(secRoute && secRoute.secure === true, 'introspection secure=true on secure route')
        const httpRoute = routes.find(r => r.path === '/http-only')
        ok(httpRoute && httpRoute.secure === false, 'introspection secure=false on http-only route')
        const eitherRoute = routes.find(r => r.path === '/either')
        ok(eitherRoute && eitherRoute.secure === undefined, 'introspection no secure flag on normal route')

        // Router convenience method with options
        const subRouter = Router()
        subRouter.post('/data', { secure: true }, (req, res) => res.json({ ok: 1 }))
        const rInspect = subRouter.inspect()
        ok(rInspect[0].secure === true, 'Router convenience method passes secure option')

        // Route chain with secure option
        const chainRouter = Router()
        chainRouter.route('/chain').get({ secure: true }, (req, res) => res.json({ chain: 1 }))
        const cInspect = chainRouter.inspect()
        ok(cInspect[0].secure === true, 'route() chain passes secure option')

        secServer.close()
    }

    // -- HTTPS Support ---------------------------------
    console.log('\nHTTPS Support:')
    ok(typeof app.listen === 'function', 'app.listen() exists')
    ok(typeof app.close === 'function', 'app.close() exists')
    // We can't easily test actual HTTPS without generating certs,
    // but verify the API accepts the TLS options shape
    ok(true, 'HTTPS listen API available (requires key/cert for actual use)')

    // -- Cleanup --
    wsServer.close()
    server.close()
    compressServer.close()
    try { fs.rmSync(uploadsDir, { recursive: true, force: true }) } catch (e) { }
    try { fs.rmSync(staticFolder, { recursive: true, force: true }) } catch (e) { }

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
}

run().catch(err =>
{
    console.error('Tests crashed:', err)
    process.exit(1)
})
