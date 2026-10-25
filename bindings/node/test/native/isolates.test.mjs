// worker_threads isolates: each loads the addon on its own (a Node-API addon is loaded
// once per environment) and attaches its own target; a terminated isolate's cleanup
// hook (napi_add_env_cleanup_hook) detaches it; deliveries left in Node's queue after a
// detach are skipped; and a delivery that cannot be handed to JavaScript is answered
// in Rust.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { METHOD, ROUTE, blockUntil, buildApp, json, native, request, serve, waitFor } from './_helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const isolateWorker = path.join(here, 'fixtures', 'isolate-worker.mjs')
const clientWorker = path.join(here, 'fixtures', 'client-worker.mjs')

/** Start a worker and collect its messages and its exit code. */
function spawn(file, workerData) {
  const worker = new Worker(file, { workerData })
  const messages = []
  worker.on('message', (message) => messages.push(message))
  worker.on('error', (error) => messages.push({ error: String(error && error.stack) }))
  const exited = new Promise((resolve) => worker.once('exit', resolve))
  return { worker, messages, exited }
}

test('the addon loads in each per-core isolate and registers its own target', { timeout: 120_000 }, async () => {
  const { app } = buildApp([{ method: METHOD.GET, pattern: '/who' }])
  const server = native.serverNew(app, '{"threads":2,"port":0}')
  const workers = native.serverWorkers(server)
  assert.equal(workers.length, 2)
  const isolates = workers.map((worker, core) =>
    spawn(isolateWorker, { server, worker, name: `isolate ${core}`, mode: 'answer' }))
  try {
    await waitFor(() => isolates.every((isolate) => isolate.messages.some((message) => message.ready)), 'both isolates to attach')
    const address = native.serverStart(server)
    const answered = new Map()
    for (let attempt = 0; attempt < 400 && answered.size < 2; attempt += 1) {
      const answer = await request(address, 'GET', '/who')
      assert.equal(answer.status, 200)
      answered.set(answer.body.toString(), Number(answer.header('x-worker')))
    }
    assert.deepEqual([...answered.keys()].sort(), ['isolate 0', 'isolate 1'], 'each isolate answered the requests of its core')
    assert.equal(answered.get('isolate 0'), workers[0])
    assert.equal(answered.get('isolate 1'), workers[1])
    for (const isolate of isolates) {
      assert.deepEqual(isolate.messages.filter((message) => message.error), [])
    }
  } finally {
    native.serverShutdown(server, 0)
    await native.serverWait(server)
  }
  assert.deepEqual(await Promise.all(isolates.map((isolate) => isolate.exited)), [0, 0],
    'each isolate ends once the stop released its dispatch function')
})

test('a terminated isolate detaches its target and tier 0 keeps serving', { timeout: 120_000 }, async () => {
  const { app } = buildApp([
    { kind: ROUTE.FIXED, method: METHOD.GET, pattern: '/tier0', options: '{"status":200,"contentType":"text/plain","body":"tier0"}' },
    { method: METHOD.GET, pattern: '/hold' },
  ])
  const server = native.serverNew(app, '{"threads":1,"port":0}')
  const [worker] = native.serverWorkers(server)
  const isolate = spawn(isolateWorker, { server, worker, name: 'held', mode: 'hold' })
  try {
    await waitFor(() => isolate.messages.some((message) => message.ready), 'the isolate to attach')
    const address = native.serverStart(server)
    const held = request(address, 'GET', '/hold')
    await waitFor(() => isolate.messages.some((message) => message.held !== undefined), 'the request to be leased to the isolate')
    assert.equal(native.serverStats(server).leased, 1)
    await isolate.worker.terminate()
    const answer = await held
    assert.equal(answer.status, 503, 'the leased request of the terminated isolate is answered')
    assert.equal(native.serverStats(server).teardown_detaches, 1, 'the cleanup hook detached the target')
    const fixed = await request(address, 'GET', '/tier0')
    assert.equal(fixed.status, 200)
    assert.equal(fixed.body.toString(), 'tier0')
    const orphan = await request(address, 'GET', '/hold')
    assert.equal(orphan.status, 503, 'a host route with no target is answered 503')
    assert.ok(orphan.header('retry-after'))
  } finally {
    native.serverShutdown(server, 0)
    await native.serverWait(server)
  }
})

test('a target detached with batches still in Node\'s queue skips each of them and the isolate survives', { timeout: 120_000 }, async () => {
  const site = serve({
    routes: [{ method: METHOD.GET, pattern: '/queued' }],
    handler({ slot }) {
      native.resRespond(slot, 200, [], 'ran')
    },
  })
  const flag = new Int32Array(new SharedArrayBuffer(4))
  const client = spawn(clientWorker, { address: site.address, path: '/queued', count: 3, flag })
  try {
    await waitFor(() => client.messages.some((message) => message.waiting), 'the client')
    Atomics.store(flag, 0, 1)
    Atomics.notify(flag, 0)
    blockUntil(() => native.serverStats(site.server).dispatched === 3, 'three requests posted while this thread is blocked')
    const batches = native.serverStats(site.server).batches
    assert.ok(batches >= 1 && batches <= 3)
    native.targetDetach(site.target)
    blockUntil(() => {
      const stats = native.serverStats(site.server)
      return stats.closed_leases === 3 && stats.in_flight === 0
    }, 'the worker to apply the detach')
    await waitFor(() => site.state.skipped === batches, 'every queued delivery')
    assert.equal(site.state.handled, 0, 'no queued request ran')
    assert.equal(native.serverStats(site.server).stale_deliveries, batches)
    const result = await waitFor(() => client.messages.find((message) => message.statuses), 'the client\'s answers')
    assert.deepEqual(result.statuses, [503, 503, 503])
    assert.deepEqual(site.state.errors, [])
  } finally {
    await site.close()
  }
  const next = serve({
    routes: [{ method: METHOD.GET, pattern: '/next' }],
    handler({ slot }) {
      native.resRespond(slot, 200, [], 'served')
    },
  })
  try {
    const answer = await request(next.address, 'GET', '/next')
    assert.equal(answer.status, 200, 'the next server in the same isolate serves')
    assert.equal(answer.body.toString(), 'served')
  } finally {
    await next.close()
  }
})

test('a delivery that cannot be handed to JavaScript is answered 500 and the next batch arrives', async () => {
  const site = serve({
    routes: [{ method: METHOD.GET, pattern: '/fragile' }],
    handler({ slot }) {
      native.resRespond(slot, 200, [], 'delivered')
    },
  })
  try {
    assert.equal(typeof native.__failNextDelivery, 'function')
    native.__failNextDelivery(site.target)
    const failed = await request(site.address, 'GET', '/fragile')
    assert.equal(failed.status, 500)
    assert.equal(json(failed).code, 'DISPATCH_FAILED')
    const next = await request(site.address, 'GET', '/fragile')
    assert.equal(next.status, 200)
    assert.equal(next.body.toString(), 'delivered')
    assert.equal(site.state.handled, 1)
    assert.equal(native.serverStats(site.server).abandoned_batches, 1)
    assert.throws(() => native.__failNextDelivery(424242), { code: 'ZERO_CLOSED' })
  } finally {
    await site.close()
  }
})

test('an attach is refused for an index of another server, a duplicate index, and an empty list', async () => {
  const first = buildApp([{ method: METHOD.GET, pattern: '/' }])
  const second = buildApp([{ method: METHOD.GET, pattern: '/' }])
  const one = native.serverNew(first.app, '{"threads":1,"port":0}')
  const two = native.serverNew(second.app, '{"threads":1,"port":0}')
  const noop = () => {}
  try {
    const [worker] = native.serverWorkers(one)
    const [other] = native.serverWorkers(two)
    assert.throws(() => native.targetAttach(one, [other], noop), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.targetAttach(one, [worker, worker], noop), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.targetAttach(one, [], noop), { code: 'ZERO_INVALID_ARGUMENT' })
    assert.throws(() => native.targetAttach(one, [128], noop), { code: 'ZERO_INVALID_ARGUMENT' })
    const target = native.targetAttach(one, [worker], noop)
    assert.throws(() => native.targetAttach(one, [worker], noop), { code: 'ZERO_LIMIT' }, 'a worker index holds one target')
    native.targetDetach(target)
    native.targetDetach(native.targetAttach(one, [worker], noop))
  } finally {
    native.serverShutdown(one, 0)
    native.serverShutdown(two, 0)
    await Promise.all([native.serverWait(one), native.serverWait(two)])
  }
  assert.throws(() => native.targetAttach(one, [0], noop), { code: 'ZERO_CLOSED' }, 'a stopped server takes no target')
})
