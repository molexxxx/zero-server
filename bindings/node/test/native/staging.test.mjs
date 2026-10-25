// Large-body staging: a staged body is detached at send (Node-API
// napi_detach_arraybuffer), so no JavaScript view reads or writes it while the core
// sends it, and only the slot's own staged buffer is ever installed.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { METHOD, json, native, request, serve, waitFor } from './_helpers.mjs'

const LENGTH = 70_000

/** A recognizable body for a seed. */
function pattern(seed, length = LENGTH) {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 7 + seed) % 251
  return bytes
}

/** A server whose one route runs `handler` on each request. */
function stagingSite(handler) {
  return serve({ routes: [{ method: METHOD.GET, pattern: '/staged/:name' }], handler })
}

test('a staged body is detached at send and the wire bytes do not change', async () => {
  const observed = {}
  const site = stagingSite(({ slot }) => {
    const staged = native.resStage(slot, LENGTH)
    observed.zeroed = new Uint8Array(staged).every((byte) => byte === 0)
    new Uint8Array(staged).set(pattern(1))
    observed.result = native.resSendStaged(slot, 200, ['Content-Type', 'application/octet-stream'], staged)
    observed.byteLength = staged.byteLength
    observed.detached = staged.detached
  })
  try {
    const answer = await request(site.address, 'GET', '/staged/one')
    assert.equal(answer.status, 200)
    assert.equal(answer.header('content-type'), 'application/octet-stream')
    assert.equal(observed.zeroed, true, 'a staged body starts as zeros')
    assert.equal(observed.result, 0)
    assert.equal(observed.byteLength, 0, 'the buffer is detached once sent')
    assert.equal(observed.detached, true)
    assert.equal(answer.body.length, LENGTH)
    assert.deepEqual(new Uint8Array(answer.body), pattern(1))
  } finally {
    await site.close()
  }
})

test('detach-after-send: a retained Uint8Array over the staged buffer reads as empty after send and writes through it change no byte on the wire', async () => {
  const observed = {}
  const site = stagingSite(({ slot }) => {
    const staged = native.resStage(slot, LENGTH)
    const view = new Uint8Array(staged)
    view.set(pattern(2))
    native.resSendStaged(slot, 200, [], staged)
    observed.viewLength = view.byteLength
    for (let index = 0; index < 64; index += 1) view[index] = 0xff
    observed.afterWrite = view[0]
  })
  try {
    const answer = await request(site.address, 'GET', '/staged/two')
    assert.equal(answer.status, 200)
    assert.equal(observed.viewLength, 0, 'the retained view is empty after the send')
    assert.equal(observed.afterWrite, undefined, 'a write through a detached view stores nothing')
    assert.deepEqual(new Uint8Array(answer.body), pattern(2), 'the wire carries the bytes written before the send')
  } finally {
    await site.close()
  }
})

test('transfer-before-send: a staged buffer transferred before the send answers 500 and its bytes never reach the wire', async () => {
  const observed = {}
  const site = stagingSite(({ slot }) => {
    const staged = native.resStage(slot, LENGTH)
    new Uint8Array(staged).set(pattern(3))
    const moved = staged.transfer()
    observed.movedLength = moved.byteLength
    observed.result = native.resSendStaged(slot, 200, [], staged)
  })
  try {
    const answer = await request(site.address, 'GET', '/staged/three')
    assert.equal(observed.movedLength, LENGTH)
    assert.equal(observed.result, 0, 'the request is answered, with an error')
    assert.equal(answer.status, 500)
    assert.equal(json(answer).code, 'STAGING_DETACHED')
    assert.ok(answer.body.length < LENGTH, 'the staged bytes are not on the wire')
  } finally {
    await site.close()
  }
})

test('second-stage-refused: a second stage of the same slot throws and the first buffer still sends its own bytes', async () => {
  const observed = {}
  const site = stagingSite(({ slot }) => {
    const first = native.resStage(slot, LENGTH)
    new Uint8Array(first).set(pattern(4))
    try {
      native.resStage(slot, LENGTH)
      observed.second = 'accepted'
    } catch (error) {
      observed.second = error.code
    }
    native.resSendStaged(slot, 200, [], first)
  })
  try {
    const answer = await request(site.address, 'GET', '/staged/four')
    assert.equal(observed.second, 'ZERO_INVALID_ARGUMENT')
    assert.equal(answer.status, 200)
    assert.deepEqual(new Uint8Array(answer.body), pattern(4))
  } finally {
    await site.close()
  }
})

test('foreign-buffer-refused: sending through another slot\'s staged buffer or a plain ArrayBuffer throws and the wire carries neither', async () => {
  const pending = []
  const observed = []
  const site = stagingSite((request) => {
    const staged = native.resStage(request.slot, LENGTH)
    const name = native.reqParams(request.slot)[0]
    new Uint8Array(staged).set(pattern(name === 'a' ? 5 : 6))
    pending.push({ ...request, staged, name })
    if (pending.length < 2) return 'later'
    const [a, b] = pending
    const refused = (call) => {
      try {
        call()
        observed.push('accepted')
      } catch (error) {
        observed.push(error.code)
      }
    }
    refused(() => native.resSendStaged(b.slot, 200, [], a.staged))
    refused(() => native.resSendStaged(a.slot, 200, [], b.staged))
    const plain = new ArrayBuffer(LENGTH)
    new Uint8Array(plain).set(pattern(9))
    refused(() => native.resSendStaged(b.slot, 200, [], plain))
    refused(() => native.resSendStaged(b.slot, 200, [], new ArrayBuffer(0)))
    observed.push(a.staged.byteLength, b.staged.byteLength)
    native.resSendStaged(a.slot, 200, [], a.staged)
    native.resSendStaged(b.slot, 200, [], b.staged)
    a.done()
    return undefined
  })
  try {
    const first = request(site.address, 'GET', '/staged/a')
    await waitFor(() => pending.length === 1, 'the first request')
    const second = request(site.address, 'GET', '/staged/b')
    const [answerA, answerB] = await Promise.all([first, second])
    assert.deepEqual(observed, [
      'ZERO_INVALID_ARGUMENT',
      'ZERO_INVALID_ARGUMENT',
      'ZERO_INVALID_ARGUMENT',
      'ZERO_INVALID_ARGUMENT',
      LENGTH,
      LENGTH,
    ], 'a refused send detaches nothing')
    assert.deepEqual(new Uint8Array(answerA.body), pattern(5), 'each slot sends its own staged bytes')
    assert.deepEqual(new Uint8Array(answerB.body), pattern(6))
  } finally {
    await site.close()
  }
})

test('a staged length of zero, a slot with no staged body and a completed slot are refused', async () => {
  const observed = []
  let completed
  const site = stagingSite(({ slot }) => {
    completed = slot
    for (const call of [
      () => native.resStage(slot, 0),
      () => native.resStage(slot, 1.5),
      () => native.resSendStaged(slot, 200, [], new ArrayBuffer(8)),
    ]) {
      try {
        call()
        observed.push('accepted')
      } catch (error) {
        observed.push(error.code)
      }
    }
    const staged = native.resStage(slot, 16)
    try {
      native.resSendStaged(slot, 200, ['X-A', 'a\r\nb'], staged)
    } catch (error) {
      observed.push(error.code, staged.byteLength)
    }
    native.resSendStaged(slot, 0, [], staged)
  })
  try {
    const answer = await request(site.address, 'GET', '/staged/edge')
    assert.equal(answer.status, 200)
    assert.equal(answer.body.length, 16)
    assert.deepEqual(observed, [
      'ZERO_INVALID_ARGUMENT',
      'ZERO_INVALID_ARGUMENT',
      'ZERO_INVALID_ARGUMENT',
      'ZERO_INVALID_ARGUMENT',
      16,
    ], 'a refused field line leaves the buffer attached')
    assert.throws(() => native.resStage(completed, 16), { code: 'ZERO_CLOSED' })
  } finally {
    await site.close()
  }
})
