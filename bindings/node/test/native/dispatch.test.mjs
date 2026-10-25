// An inline isolate serving through a minimal dispatch loop, and the native calls it
// uses: applications, request readers, response writers, the library utilities and
// the server lifecycle.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHOD, ROUTE, buildApp, hostPort, json, native, rawRequest, request, serve, waitFor } from './_helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repository = path.resolve(here, '..', '..', '..', '..')
const fixtures = path.join(repository, 'crates', 'zero-tls', 'tests', 'fixtures')

test('an inline isolate answers through a minimal dispatch loop', async () => {
  const seen = []
  const site = serve({
    routes: [
      { method: METHOD.GET, pattern: '/items/:id' },
      { method: METHOD.POST, pattern: '/echo' },
      { method: METHOD.ANY, pattern: '/any' },
    ],
    handler({ slot, route }) {
      const [method, token, target, version, flags, miss, allow] = native.reqHead(slot)
      seen.push({
        route, method, token, target, version, flags, miss, allow,
        params: native.reqParams(slot),
        headers: native.reqHeaders(slot),
        agent: native.reqHeader(slot, 'x-AGENT'),
        absent: native.reqHeader(slot, 'x-absent'),
        body: native.reqBody(slot).toString('utf8'),
        meta: native.reqMeta(slot),
        peer: native.reqPeer(slot),
        canceled: native.slotCanceled(slot),
      })
      native.resRespond(slot, 200, ['Content-Type', 'application/json', 'X-Route', String(route)], JSON.stringify({ route }))
    },
  })
  try {
    const item = await request(site.address, 'GET', '/items/42?full=1', { headers: { 'X-Agent': 'probe' } })
    assert.equal(item.status, 200)
    assert.deepEqual(json(item), { route: 0 })
    assert.equal(item.header('x-route'), '0')
    assert.equal(item.header('content-type'), 'application/json')
    const echo = await request(site.address, 'POST', '/echo', { body: 'hello' })
    assert.equal(echo.status, 200)
    const other = await request(site.address, 'DELETE', '/any')
    assert.equal(other.status, 200)

    const [get, post, removal] = seen
    assert.equal(get.method, METHOD.GET)
    assert.equal(get.token, 'GET')
    assert.equal(get.target, '/items/42?full=1')
    assert.equal(get.version, 11)
    assert.ok(get.flags & 32, 'the query flag is set')
    assert.equal(get.miss, 0)
    assert.deepEqual(get.params, ['42'])
    assert.deepEqual(get.headers, ['Host', 'test', 'Connection', 'close', 'X-Agent', 'probe'])
    assert.equal(get.agent, 'probe')
    assert.equal(get.absent, null)
    assert.equal(get.body, '')
    assert.equal(get.meta, get.method + get.version * 2 ** 8 + get.flags * 2 ** 16)
    assert.equal(get.peer.family, 4)
    assert.equal(get.peer.address, '127.0.0.1')
    assert.equal(get.peer.clientAddress, '127.0.0.1')
    assert.ok(get.peer.port > 0)
    assert.equal(get.peer.secure, false)
    assert.equal(get.canceled, false)
    assert.equal(post.method, METHOD.POST)
    assert.equal(post.body, 'hello')
    assert.equal(post.route, 1)
    assert.equal(removal.method, METHOD.DELETE)
    assert.equal(removal.token, 'DELETE')
    assert.equal(removal.route, 2, 'a route registered for every method')
    assert.deepEqual(site.state.errors, [])
    assert.equal(site.state.refusedAcks, 0)
  } finally {
    await site.close()
  }
})

test('routes answered in Rust never reach the isolate', async () => {
  const site = serve({
    routes: [
      { kind: ROUTE.FIXED, method: METHOD.GET, pattern: '/fixed', options: '{"status":200,"contentType":"text/plain","body":"tier0"}' },
      { kind: ROUTE.REDIRECT, method: METHOD.GET, pattern: '/old', options: '{"status":308,"location":"/new"}' },
      { kind: ROUTE.HEALTH, method: METHOD.GET, pattern: '/health', options: '{"status":200,"body":"ok"}' },
    ],
    handler() {
      throw new Error('no request should reach the isolate')
    },
  })
  try {
    const fixed = await request(site.address, 'GET', '/fixed')
    assert.equal(fixed.status, 200)
    assert.equal(fixed.body.toString(), 'tier0')
    const moved = await request(site.address, 'GET', '/old')
    assert.equal(moved.status, 308)
    assert.equal(moved.header('location'), '/new')
    const health = await request(site.address, 'GET', '/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.toString(), 'ok')
    assert.equal(site.state.handled, 0)
  } finally {
    await site.close()
  }
})

test('a slot completed without a response is answered 500 NO_RESPONSE', async () => {
  const site = serve({ routes: [{ method: METHOD.GET, pattern: '/silent' }], handler() {} })
  try {
    const answer = await request(site.address, 'GET', '/silent')
    assert.equal(answer.status, 500)
    assert.equal(json(answer).code, 'NO_RESPONSE')
  } finally {
    await site.close()
  }
})

test('an error is written in the server shape, problem details by default and the 1.x shape on request', async () => {
  const handler = ({ slot }) => {
    native.resError(slot, 422, 'VALIDATION_FAILED', 'age is required', '[{"field":"age"}]')
  }
  const problem = serve({ routes: [{ pattern: '/e' }], handler })
  const legacy = serve({ routes: [{ pattern: '/e' }], handler, options: { errorShape: 'legacy' } })
  const plain = serve({
    routes: [{ pattern: '/e' }],
    handler: ({ slot }) => {
      native.resError(slot, 200, 'NOT_AN_ERROR_STATUS', null, 'not json')
    },
  })
  try {
    const first = await request(problem.address, 'GET', '/e')
    assert.equal(first.status, 422)
    assert.equal(first.header('content-type'), 'application/problem+json')
    assert.deepEqual(json(first), {
      type: 'about:blank', title: 'Unprocessable Content', status: 422, code: 'VALIDATION_FAILED',
      detail: 'age is required', details: [{ field: 'age' }],
    })
    const second = await request(legacy.address, 'GET', '/e')
    assert.equal(second.status, 422)
    assert.equal(second.header('content-type'), 'application/json')
    assert.deepEqual(json(second), { error: 'age is required', code: 'VALIDATION_FAILED', statusCode: 422, details: [{ field: 'age' }] })
    const third = await request(plain.address, 'GET', '/e')
    assert.equal(third.status, 500, 'a status outside 400 to 599 is answered 500')
    assert.deepEqual(json(third), { type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'NOT_AN_ERROR_STATUS' })
  } finally {
    await Promise.all([problem.close(), legacy.close(), plain.close()])
  }
})

test('response writes refuse what the core would not send and an id outside its range', async () => {
  const outcomes = []
  let answered
  const site = serve({
    routes: [{ pattern: '/w' }],
    handler({ slot }) {
      answered = slot
      const refused = (call) => {
        try {
          call()
          outcomes.push('accepted')
        } catch (error) {
          outcomes.push(error.code)
        }
      }
      refused(() => native.resRespond(slot, 99, [], null))
      refused(() => native.resRespond(slot, 600, [], null))
      refused(() => native.resRespond(slot, 101, [], null))
      refused(() => native.resRespond(slot, 200.5, [], null))
      refused(() => native.resRespond(slot, 200, ['X-A', 'a\r\nInjected: yes'], null))
      refused(() => native.resRespond(slot, 200, ['X-A', 'a\u0000b'], null))
      refused(() => native.resRespond(slot, 200, ['X-A', 'ĊB'], null))
      refused(() => native.resRespond(slot, 200, ['Content-Length', '5'], null))
      refused(() => native.resRespond(slot, 200, ['Bad Name', 'x'], null))
      refused(() => native.resRespond(slot, 200, ['X-A'], null))
      refused(() => native.resError(slot, 500, 'lower_case', null, null))
      refused(() => native.reqHead(1.5))
      refused(() => native.reqHead(-1))
      refused(() => native.reqHead(2 ** 53))
      refused(() => native.reqHead(Number.NaN))
      native.resRespond(slot, 201, ['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'X-Latin', 'café'], Buffer.from('made'))
      refused(() => native.resRespond(slot, 200, [], 'again'))
    },
  })
  try {
    const answer = await request(site.address, 'GET', '/w')
    assert.deepEqual(outcomes, [
      ...Array(11).fill('ZERO_INVALID_ARGUMENT'),
      ...Array(4).fill('ZERO_INVALID_ARGUMENT'),
      'ZERO_CLOSED',
    ])
    assert.equal(answer.status, 201)
    assert.equal(answer.body.toString(), 'made')
    assert.deepEqual(
      answer.headers.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value),
      ['a=1', 'b=2'],
      'every Set-Cookie leaves as its own field line',
    )
    assert.ok(answer.raw.includes(Buffer.from('X-Latin: caf\xe9', 'latin1')), 'a latin1 value leaves as one octet per character')
    assert.throws(() => native.reqHead(answered), { code: 'ZERO_CLOSED' }, 'a completed slot reads as closed')
  } finally {
    await site.close()
  }
})

test('a refused acknowledgment still completes its ids and the next one is accepted', async () => {
  const app = native.appNew()
  native.appRoute(app, ROUTE.HOST, METHOD.GET, '/ack', '')
  const server = native.serverNew(app, '{"threads":1,"port":0}')
  const workers = native.serverWorkers(server)
  const results = []
  const ids = new Float64Array(256)
  const target = native.targetAttach(server, workers, (worker, epoch, kind, records) => {
    try {
      if (records == null) return
      const view = new DataView(records.buffer, records.byteOffset, records.byteLength)
      let count = 0
      for (let offset = 0; offset < records.byteLength; offset += 16) {
        const slot = view.getFloat64(offset, true)
        native.resRespond(slot, 200, [], 'acked')
        ids[count++] = slot
      }
      results.push(native.batchComplete(worker, ids, count, epoch + 7))
      results.push(native.batchComplete(worker, ids, 0, epoch))
    } catch (error) {
      results.push(error)
    }
  })
  try {
    const address = native.serverStart(server)
    const first = await request(address, 'GET', '/ack')
    assert.equal(first.status, 200)
    assert.equal(first.body.toString(), 'acked')
    const second = await request(address, 'GET', '/ack')
    assert.equal(second.status, 200)
    assert.deepEqual(results, [9, 0, 9, 0])
    assert.equal(native.serverStats(server).refused_acks, 2)
    assert.throws(() => native.batchComplete(128, ids, 0, 0), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.batchComplete(workers[0], ids, 257 * 16, 0), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.batchComplete(workers[0], ids, 0, 0.5), { code: 'ZERO_INVALID_ARGUMENT' })
    native.targetDetach(target)
    assert.throws(() => native.targetDetach(target), { code: 'ZERO_CLOSED' })
  } finally {
    native.serverShutdown(server, 0)
    await native.serverWait(server)
  }
})

test('the library utilities answer without a server', () => {
  assert.equal(typeof native.coreVersion(), 'string')
  assert.ok(native.coreVersion().length > 0)
  assert.equal(native.version(), native.coreVersion())
  assert.equal(native.abiVersion(), 1)
  assert.equal(native.headerName(0), 'accept')
  assert.equal(native.headerName(16), 'content-type')
  assert.equal(native.headerName(48), 'www-authenticate')
  assert.throws(() => native.headerName(49), { code: 'ZERO_INVALID_ARGUMENT' })
  assert.equal(native.fieldValidate('X-Request-Id', 'abc'), 0)
  assert.equal(native.fieldValidate('X-A', 'café'), 0)
  assert.equal(native.fieldValidate('X-A', 'a\rb'), 9)
  assert.equal(native.fieldValidate('X-A', 'a\nb'), 9)
  assert.equal(native.fieldValidate('X-A', 'a\u0000b'), 9)
  assert.equal(native.fieldValidate('X-A', ' padded'), 9)
  assert.equal(native.fieldValidate('X-A', 'č'), 9, 'a character above U+00FF is refused, not truncated to CR')
  assert.equal(native.fieldValidate('Date', 'now'), 9)
  assert.equal(native.fieldValidate('Transfer-Encoding', 'chunked'), 9)
  assert.equal(native.fieldValidate('two words', 'x'), 9)
})

test('the conformance entry recomputes every shared vector section', () => {
  const vectors = JSON.parse(readFileSync(path.join(repository, 'conformance', 'vectors.json'), 'utf8'))
  const sections = ['http1Parser', 'responseSplitting', 'router', 'ws', 'sse', 'qpack', 'h3Frames']
  let checked = 0
  for (const section of sections) {
    if (vectors[section] === undefined) continue
    const result = JSON.parse(native.conformanceCase(section, JSON.stringify(vectors[section])))
    assert.deepEqual(result, vectors[section], `the ${section} section`)
    checked += 1
  }
  assert.ok(checked >= 5, 'the vectors file holds the sections')
  assert.throws(() => native.conformanceCase('noSuchSection', '{}'), { code: 'ZERO_UNSUPPORTED' })
  assert.throws(() => native.conformanceCase('router', '{not json'), { code: 'ZERO_CODEC' })
})

test('applications mount, route misses and apply policies in the core', async () => {
  const app = native.appNew()
  const own = native.appRoute(app, ROUTE.HOST, METHOD.GET, '/a', '')
  const child = native.appNew()
  native.appRoute(child, ROUTE.HOST, METHOD.GET, '/b', '')
  assert.throws(() => native.appMount(app, '/api', app), { code: 'ZERO_INVALID_ARGUMENT' })
  assert.throws(() => native.appMount(app, '/api', 4242), { code: 'ZERO_CLOSED' })
  const base = native.appMount(app, '/api', child)
  assert.equal(base, own + 1)
  assert.throws(() => native.appRoute(child, ROUTE.HOST, METHOD.GET, '/c', ''), { code: 'ZERO_CLOSED' }, 'a mounted child is consumed')
  const miss = native.appMiss(app)
  assert.equal(native.appMiss(app), miss)
  native.appPolicy(app, 1, '/', '{"fields":[["X-Frame-Options","DENY"]]}')
  assert.throws(() => native.appPolicy(app, 9, '/', '{}'), { code: 'ZERO_INVALID_ARGUMENT' })
  assert.throws(() => native.appRoute(app, 7, METHOD.GET, '/x', ''), { code: 'ZERO_INVALID_ARGUMENT' })
  assert.throws(() => native.appRoute(app, ROUTE.HOST, 9, '/x', ''), { code: 'ZERO_INVALID_ARGUMENT' })
  assert.throws(() => native.appRoute(app, ROUTE.HOST, METHOD.GET, '/a', ''), { code: 'ZERO_INVALID_ARGUMENT' }, 'a duplicate route')
  assert.throws(() => native.appRoute(app, ROUTE.FIXED, METHOD.GET, '/f', '{"status":"x"}'), { code: 'ZERO_CODEC' })
  const table = native.appTable(app)
  assert.ok(Buffer.isBuffer(table))
  assert.match(table.toString('utf8'), /route host GET \/a /)
  assert.match(table.toString('utf8'), /mount \/api /)

  const seen = []
  const site = serve({
    app,
    handler({ slot, route }) {
      const [method, token, , , , missStatus, allow] = native.reqHead(slot)
      seen.push({ route, method, token, missStatus, allow })
      native.resRespond(slot, 200, [], `route ${route}`)
    },
  })
  try {
    const mounted = await request(site.address, 'GET', '/api/b')
    assert.equal(mounted.body.toString(), `route ${base}`)
    assert.equal(mounted.header('x-frame-options'), 'DENY')
    const missing = await request(site.address, 'GET', '/nowhere')
    assert.equal(missing.body.toString(), `route ${miss}`)
    const wrongMethod = await request(site.address, 'DELETE', '/a')
    assert.equal(wrongMethod.body.toString(), `route ${miss}`)
    const unknownMethod = await request(site.address, 'PROPFIND', '/a')
    assert.equal(unknownMethod.status, 501, 'the driver answers a method outside the registry itself')
    assert.equal(seen.length, 3, 'without reaching the miss route')
    assert.equal(seen[1].missStatus, 404)
    assert.equal(seen[2].missStatus, 405)
    assert.equal(seen[2].allow, (1 << METHOD.GET) | (1 << METHOD.HEAD) | (1 << METHOD.OPTIONS), 'the Allow set of /a')
    assert.equal(seen[2].token, 'DELETE')

    const other = buildApp([{ method: METHOD.GET, pattern: '/a' }])
    assert.throws(() => native.serverCheckTable(site.server, other.app), (error) => {
      assert.equal(error.code, 'ZERO_INVALID_ARGUMENT')
      assert.match(error.message, /differ/)
      return true
    })
    native.serverCheckTable(site.server, app)
  } finally {
    await site.close()
  }
})

test('a file action serves a file under its root with the fields set before it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'zero-native-'))
  writeFileSync(path.join(root, 'hello.txt'), 'hello from disk')
  const site = serve({
    routes: [{ method: METHOD.GET, pattern: '/files/*path' }],
    handler({ slot }) {
      const [name] = native.reqParams(slot)
      native.resFile(slot, 0, ['X-Served', 'native'], root, name)
    },
  })
  try {
    const found = await request(site.address, 'GET', '/files/hello.txt')
    assert.equal(found.status, 200)
    assert.equal(found.body.toString(), 'hello from disk')
    assert.equal(found.header('x-served'), 'native')
    const missing = await request(site.address, 'GET', '/files/absent.txt')
    assert.equal(missing.status, 404)
  } finally {
    await site.close()
  }
})

test('a server serves over TLS with the material set before it starts', async () => {
  const cert = readFileSync(path.join(fixtures, 'localhost.pem'))
  const key = readFileSync(path.join(fixtures, 'localhost.key'))
  const ca = readFileSync(path.join(fixtures, 'ca.pem'))
  let secure
  const site = serve({
    routes: [{ method: METHOD.GET, pattern: '/tls' }],
    beforeStart(server) {
      assert.throws(() => native.serverTls(server, cert, key, '{"unknown":1}'), { code: 'ZERO_CODEC' })
      native.serverTls(server, cert, key, '{"names":["localhost"]}')
    },
    handler({ slot }) {
      secure = native.reqPeer(slot).secure
      native.resRespond(slot, 200, [], 'over tls')
    },
  })
  try {
    assert.throws(() => native.serverTls(site.server, cert, key, '{"names":["localhost"]}'), { code: 'ZERO_INVALID_ARGUMENT' }, 'TLS is set before the start')
    const { port } = hostPort(site.address)
    const body = await new Promise((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, path: '/tls', ca, servername: 'localhost', headers: { Host: `localhost:${port}` }, agent: false }, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }))
        })
        .on('error', reject)
    })
    assert.deepEqual(body, { status: 200, text: 'over tls' })
    assert.equal(secure, true)
  } finally {
    await site.close()
  }
})

test('a trailer on the allow list reaches the isolate and the others do not', async () => {
  const seen = []
  const site = serve({
    routes: [{ method: METHOD.POST, pattern: '/t' }],
    options: { trailers: ['x-checksum'] },
    handler({ slot }) {
      seen.push([native.reqTrailer(slot, 'X-CHECKSUM'), native.reqTrailer(slot, 'x-other'), native.reqBody(slot).toString()])
      native.resRespond(slot, 204, [], null)
    },
  })
  try {
    const answer = await rawRequest(
      site.address,
      'POST /t HTTP/1.1\r\nHost: test\r\nConnection: close\r\nTransfer-Encoding: chunked\r\nTrailer: X-Checksum\r\n\r\n' +
        '5\r\nhello\r\n0\r\nX-Checksum: abc\r\nX-Other: no\r\n\r\n',
    )
    assert.equal(answer.status, 204)
    assert.deepEqual(seen, [['abc', null, 'hello']])
  } finally {
    await site.close()
  }
})

test('a request whose client went away reads as canceled and refuses writes', async () => {
  let held
  const site = serve({
    routes: [{ method: METHOD.GET, pattern: '/slow' }],
    handler(request) {
      held = request
      return 'later'
    },
  })
  try {
    const { host, port } = hostPort(site.address)
    const socket = net.connect({ host, port }, () => socket.write('GET /slow HTTP/1.1\r\nHost: test\r\n\r\n'))
    socket.on('error', () => {})
    await waitFor(() => held, 'the request to reach the isolate')
    assert.equal(native.slotCanceled(held.slot), false)
    socket.resetAndDestroy()
    await waitFor(() => {
      try {
        return native.slotCanceled(held.slot)
      } catch (error) {
        return error.code === 'ZERO_CLOSED'
      }
    }, 'the reset to close the lease')
    assert.throws(() => native.resRespond(held.slot, 200, [], 'late'), { code: 'ZERO_CLOSED' })
    held.done()
  } finally {
    await site.close()
  }
})

test('server statistics report the core and the binding counters, before and after the stop', async () => {
  const site = serve({
    routes: [{ method: METHOD.GET, pattern: '/s' }],
    options: { drainMs: 5000 },
    handler({ slot }) {
      native.resRespond(slot, 200, [], 'counted')
    },
  })
  const answer = await request(site.address, 'GET', '/s')
  assert.equal(answer.status, 200)
  const stats = native.serverStats(site.server)
  for (const key of [
    'dispatched', 'batches', 'acks', 'late_readers', 'queue_full', 'refused_503', 'closed_leases', 'panics',
    'pinned', 'quarantined_peak', 'in_flight', 'leased', 'refused_acks', 'abandoned_batches', 'retained',
    'stale_deliveries', 'status_events', 'status_dropped', 'teardown_detaches',
  ]) {
    assert.equal(typeof stats[key], 'number', key)
  }
  assert.equal(stats.dispatched, 1)
  assert.ok(stats.acks >= 1)
  assert.equal(stats.teardown_detaches, 0)
  assert.throws(() => native.serverShutdown(site.server, 1234), { code: 'ZERO_INVALID_ARGUMENT' })
  native.serverShutdown(site.server, 5000)
  await native.serverWait(site.server)
  assert.equal(native.serverStats(site.server).dispatched, 1, 'a stopped server keeps its statistics')
  assert.deepEqual(native.serverWorkers(site.server), site.workers)
  assert.throws(() => native.serverStart(site.server), { code: 'ZERO_CLOSED' })
  native.serverShutdown(site.server, 0)
  await native.serverWait(site.server)
  assert.throws(() => native.serverStats(9_007_199_254_740_991), { code: 'ZERO_CLOSED' })
  assert.throws(() => native.serverStats(-3), { code: 'ZERO_INVALID_ARGUMENT' })
})
