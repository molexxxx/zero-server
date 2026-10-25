// The request body a slot hands to JavaScript is a copy (Node-API
// napi_create_buffer_copy): changing it changes nothing in the core, and it keeps its
// bytes after the request completed and its slot served another request.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { METHOD, hostPort, native, parseResponse, serve } from './_helpers.mjs'

test('a request body buffer is a copy that survives completion unchanged', async () => {
  const kept = []
  const site = serve({
    routes: [{ method: METHOD.POST, pattern: '/echo' }],
    handler({ slot }) {
      const body = native.reqBody(slot)
      const original = Buffer.from(body)
      body[0] = 0x5a
      const again = native.reqBody(slot)
      kept.push({ body, original, again })
      native.resRespond(slot, 200, [], again)
    },
  })
  try {
    const { host, port } = hostPort(site.address)
    const replies = await new Promise((resolve, reject) => {
      const chunks = []
      const socket = net.connect({ host, port }, () => {
        socket.write('POST /echo HTTP/1.1\r\nHost: test\r\nContent-Length: 11\r\n\r\nalpha-bravo')
        socket.write('POST /echo HTTP/1.1\r\nHost: test\r\nContent-Length: 11\r\nConnection: close\r\n\r\ncharlie-del')
      })
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('error', reject)
      socket.on('close', () => {
        const raw = Buffer.concat(chunks)
        const split = raw.indexOf('HTTP/1.1', 1)
        resolve([parseResponse(raw.subarray(0, split)), parseResponse(raw.subarray(split))])
      })
    })
    assert.deepEqual(replies.map((reply) => [reply.status, reply.body.toString()]), [
      [200, 'alpha-bravo'],
      [200, 'charlie-del'],
    ], 'the wire carries the core bytes, not the changed copy')
    const [first, second] = kept
    assert.equal(first.original.toString(), 'alpha-bravo')
    assert.equal(first.again.toString(), 'alpha-bravo', 'a second read sees the core bytes, not the change')
    assert.equal(first.body.toString(), 'Zlpha-bravo', 'the copy keeps its own change')
    assert.equal(second.again.toString(), 'charlie-del')
    assert.equal(first.body.toString(), 'Zlpha-bravo', 'after the slot served another request the first copy is unchanged')
    assert.equal(first.again.toString(), 'alpha-bravo')
    assert.notEqual(first.body.buffer, second.body.buffer)
    assert.equal(native.serverStats(site.server).dispatched, 2)
  } finally {
    await site.close()
  }
})
