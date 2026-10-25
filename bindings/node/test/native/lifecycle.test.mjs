// The lifecycle of a native server and its isolates: a referenced threadsafe function
// keeps an event loop alive until it is released (Node-API
// napi_release_threadsafe_function), the wait settles without a libuv pool thread, and
// a target's cleanup hook is removed when it is detached.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn as spawnProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { METHOD, buildApp, native, waitFor } from './_helpers.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => path.join(here, 'fixtures', name)

/** Run a fixture in its own process and collect its output and exit code. */
function run(script, env = process.env, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawnProcess(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** Start an isolate worker and collect its messages and its exit code. */
function isolate(workerData) {
  const worker = new Worker(fixture('isolate-worker.mjs'), { workerData })
  const messages = []
  worker.on('message', (message) => messages.push(message))
  worker.on('error', (error) => messages.push({ error: String(error && error.stack) }))
  const exited = new Promise((resolve) => worker.once('exit', resolve))
  return { worker, messages, exited }
}

test('closing the server releases the dispatch function so the isolate exits', { timeout: 120_000 }, async () => {
  const result = await run(fixture('serve-once.mjs'))
  assert.equal(result.signal, null, `the process ended by itself: ${result.stderr}`)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.trim(), '200 once')
})

test('serverWait settles without a libuv pool thread: two waits pend while dns.lookup completes', { timeout: 120_000 }, async () => {
  const result = await run(fixture('wait-pool.mjs'), { ...process.env, UV_THREADPOOL_SIZE: '1' })
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout.trim())
  assert.match(report.lookup, /^resolved [46]$/, 'the lookup completed on the one pool thread')
  assert.equal(report.pendingDuringLookup, 2, 'both waits were pending while the lookup ran')
  assert.equal(report.settled, 2)
})

test('the cleanup hook is removed by targetDetach, and runs for an isolate that exits attached', { timeout: 120_000 }, async () => {
  const { app } = buildApp([{ method: METHOD.GET, pattern: '/' }])
  const server = native.serverNew(app, '{"threads":1,"port":0}')
  const [worker] = native.serverWorkers(server)
  try {
    const detached = isolate({ server, worker, name: 'detached', mode: 'detach' })
    assert.equal(await detached.exited, 0, 'an isolate that detached ends once its event loop is empty')
    assert.ok(detached.messages.some((message) => message.detached))
    assert.equal(native.serverStats(server).teardown_detaches, 0, 'no hook ran for the detached target')

    const exiting = isolate({ server, worker, name: 'exiting', mode: 'exit' })
    assert.equal(await exiting.exited, 0)
    assert.ok(exiting.messages.some((message) => message.attached))
    await waitFor(() => native.serverStats(server).teardown_detaches === 1, 'the hook of the attached target')

    const replacement = isolate({ server, worker, name: 'replacement', mode: 'detach' })
    assert.equal(await replacement.exited, 0, 'the index takes a target again after the hook detached the last one')
    assert.deepEqual(replacement.messages.filter((message) => message.error), [])
    assert.equal(native.serverStats(server).teardown_detaches, 1)
  } finally {
    native.serverShutdown(server, 0)
    await native.serverWait(server)
  }
})

test('the wait of a stopped server settles at once and a never-started server stops on shutdown', async () => {
  const { app } = buildApp([{ method: METHOD.GET, pattern: '/' }])
  const server = native.serverNew(app, '{"threads":1,"port":0}')
  native.serverShutdown(server, 0)
  await native.serverWait(server)
  await native.serverWait(server)
  assert.throws(() => native.serverStart(server), { code: 'ZERO_CLOSED' })
  assert.throws(() => native.serverWait(4_242_424_242), { code: 'ZERO_CLOSED' })
})
