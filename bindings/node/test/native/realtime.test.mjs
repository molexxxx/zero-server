// WebSocket connections, rooms and server-sent event streams opened from an isolate,
// with their events delivered in event batches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { EVENT, METHOD, ROUTE, hostPort, native, serve, waitFor } from './_helpers.mjs'

/** Open a WebSocket client and collect what it receives. */
function client(address, path) {
  const socket = new WebSocket(`ws://${address}${path}`)
  socket.binaryType = 'arraybuffer'
  const received = []
  const state = { open: false, closed: null }
  socket.addEventListener('open', () => {
    state.open = true
  })
  socket.addEventListener('message', (event) => {
    received.push(typeof event.data === 'string' ? event.data : Buffer.from(event.data))
  })
  socket.addEventListener('close', (event) => {
    state.closed = { code: event.code, reason: event.reason }
  })
  socket.addEventListener('error', () => {})
  return { socket, received, state }
}

/** A server with a WebSocket route whose upgrades the isolate accepts. */
function websocketSite() {
  const conns = []
  const events = []
  const site = serve({
    routes: [{ kind: ROUTE.WEBSOCKET, method: METHOD.GET, pattern: '/ws' }],
    handler({ slot }) {
      conns.push(native.resWsAccept(slot, null))
    },
    onEvents(batch) {
      events.push(...batch)
    },
  })
  return { site, conns, events }
}

test('a WebSocket upgrade is accepted from the isolate and its events arrive in event batches', async () => {
  const { site, conns, events } = websocketSite()
  const peer = client(site.address, '/ws')
  try {
    await waitFor(() => peer.state.open, 'the handshake')
    const [conn] = conns
    await waitFor(() => events.some((event) => event.kind === EVENT.WS_OPEN), 'the open event')
    const opened = events.find((event) => event.kind === EVENT.WS_OPEN)
    assert.equal(opened.conn, conn)
    assert.equal(opened.route, site.ids[0])
    assert.equal(opened.data, null)

    native.wsSend(conn, 1, 'hello')
    native.wsSend(conn, 2, Buffer.from([1, 2, 3]))
    await waitFor(() => peer.received.length === 2, 'two messages')
    assert.equal(peer.received[0], 'hello')
    assert.deepEqual([...peer.received[1]], [1, 2, 3])

    peer.socket.send('from the client')
    peer.socket.send(Uint8Array.of(9, 8))
    await waitFor(() => events.filter((event) => event.kind === EVENT.WS_MESSAGE).length === 2, 'two messages from the client')
    const [text, binary] = events.filter((event) => event.kind === EVENT.WS_MESSAGE)
    assert.equal(text.opcode, 1)
    assert.equal(text.data, 'from the client')
    assert.equal(binary.opcode, 2)
    assert.ok(Buffer.isBuffer(binary.data))
    assert.deepEqual([...binary.data], [9, 8])

    native.wsPing(conn, Buffer.from('pp'))
    await waitFor(() => events.some((event) => event.kind === EVENT.WS_PONG), 'the pong')
    const pong = events.find((event) => event.kind === EVENT.WS_PONG)
    assert.deepEqual(pong.data, Buffer.from('pp'))
    assert.equal(typeof native.wsBuffered(conn), 'number')

    assert.throws(() => native.wsSend(conn, 3, 'x'), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.wsPing(conn, Buffer.alloc(126)), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.wsClose(conn, 1005, ''), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.wsClose(conn, 1000, 'r'.repeat(124)), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.sseSend(conn, null, null, 'x'), { code: 'ZERO_INVALID_ARGUMENT' }, 'a WebSocket id is not an event stream')

    native.wsClose(conn, 1000, 'done')
    await waitFor(() => peer.state.closed, 'the close')
    assert.equal(peer.state.closed.code, 1000)
    assert.equal(peer.state.closed.reason, 'done')
    await waitFor(() => events.some((event) => event.kind === EVENT.WS_CLOSE), 'the close event')
    const closed = events.find((event) => event.kind === EVENT.WS_CLOSE)
    assert.equal(closed.conn, conn)
    assert.equal(closed.code, 1000)
    assert.throws(() => native.wsSend(conn, 1, 'late'), { code: 'ZERO_CLOSED' })
    assert.deepEqual(site.state.errors, [])
  } finally {
    peer.socket.close()
    await site.close()
  }
})

test('a peer close carries its code and reason into the close event, and a host closes with 1014', async () => {
  const { site, conns, events } = websocketSite()
  const leaving = client(site.address, '/ws')
  let turned = null
  try {
    await waitFor(() => leaving.state.open && conns.length === 1, 'the first connection')
    turned = client(site.address, '/ws')
    await waitFor(() => turned.state.open && conns.length === 2, 'the second connection')
    const [leavingConn, turnedConn] = conns

    leaving.socket.close(4001, 'bye')
    await waitFor(() => events.some((event) => event.kind === EVENT.WS_CLOSE && event.conn === leavingConn), 'the peer close event')
    const peerClose = events.find((event) => event.kind === EVENT.WS_CLOSE && event.conn === leavingConn)
    assert.equal(peerClose.code, 4001)
    assert.equal(peerClose.data, 'bye')

    native.wsClose(turnedConn, 1014, 'upstream')
    await waitFor(() => turned.state.closed, 'the host close')
    assert.equal(turned.state.closed.code, 1014)
    assert.equal(turned.state.closed.reason, 'upstream')
    assert.deepEqual(site.state.errors, [])
  } finally {
    leaving.socket.close()
    turned?.socket.close()
    await site.close()
  }
})

test('rooms reach every member but the one left out', async () => {
  const { site, conns } = websocketSite()
  const first = client(site.address, '/ws')
  const second = client(site.address, '/ws')
  try {
    await waitFor(() => first.state.open && second.state.open && conns.length === 2, 'two connections')
    const [one, two] = conns
    native.roomJoin(one, 'lobby')
    native.roomJoin(two, 'lobby')
    await waitFor(() => native.roomSize(site.server, 'lobby') === 2, 'two members')
    assert.equal(native.roomBroadcast(site.server, 'lobby', 1, 'everyone', null), 2)
    await waitFor(() => first.received.includes('everyone') && second.received.includes('everyone'), 'the broadcast')
    assert.equal(native.roomBroadcast(site.server, 'lobby', 2, Buffer.from('not one'), one), 1)
    await waitFor(() => second.received.some((item) => Buffer.isBuffer(item) && item.toString() === 'not one'), 'the second broadcast')
    assert.ok(!first.received.some((item) => Buffer.isBuffer(item)), 'the connection left out received nothing')
    native.roomLeave(two, 'lobby')
    await waitFor(() => native.roomSize(site.server, 'lobby') === 1, 'one member')
    assert.equal(native.roomSize(site.server, 'empty'), 0)
    assert.throws(() => native.roomBroadcast(site.server, 'lobby', 7, 'x', null), { code: 'ZERO_INVALID_ARGUMENT' })
  } finally {
    first.socket.close()
    second.socket.close()
    await site.close()
  }
})

test('an event stream sends events, comments and a retry, and reports its end', async () => {
  const conns = []
  const events = []
  const site = serve({
    routes: [{ method: METHOD.GET, pattern: '/events' }],
    handler({ slot }) {
      conns.push(native.resSseOpen(slot, 0, ['X-Stream', 'yes'], 0))
    },
    onEvents(batch) {
      events.push(...batch)
    },
  })
  try {
    const { host, port } = hostPort(site.address)
    const stream = await new Promise((resolve, reject) => {
      http.get({ host, port, path: '/events', agent: false }, resolve).on('error', reject)
    })
    assert.equal(stream.statusCode, 200)
    assert.match(stream.headers['content-type'], /^text\/event-stream/)
    assert.equal(stream.headers['x-stream'], 'yes')
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      text += chunk
    })
    const ended = new Promise((resolve) => stream.on('end', resolve))
    const [conn] = conns
    assert.throws(() => native.sseSend(conn, 'bad\nevent', null, 'x'), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.sseSend(conn, null, 'bad\u0000id', 'x'), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.wsSend(conn, 1, 'x'), { code: 'ZERO_INVALID_ARGUMENT' }, 'an event stream id is not a WebSocket')
    native.sseSend(conn, 'tick', '7', 'a\nb')
    native.sseComment(conn, 'note')
    native.sseRetry(conn, 1500)
    native.sseSend(conn, null, null, 'plain')
    assert.equal(typeof native.sseBuffered(conn), 'number')
    await waitFor(() => text.includes('data: plain'), 'the events')
    native.sseClose(conn)
    await ended
    for (const line of ['event: tick', 'id: 7', 'data: a', 'data: b', ':note', 'retry: 1500', 'data: plain']) {
      assert.ok(text.split(/\r?\n/).includes(line), `the stream holds ${JSON.stringify(line)}: ${JSON.stringify(text)}`)
    }
    await waitFor(() => events.some((event) => event.kind === EVENT.SSE_CLOSED), 'the stream closed event')
    assert.equal(events.find((event) => event.kind === EVENT.SSE_CLOSED).conn, conn)
    assert.throws(() => native.sseSend(conn, null, null, 'late'), { code: 'ZERO_CLOSED' })
  } finally {
    await site.close()
  }
})
