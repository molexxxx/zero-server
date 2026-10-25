// The status callback: a weak threadsafe function that holds at most 16 calls in
// Node's queue, so a burst while the isolate is blocked drops the rest before any
// call (Node-API queues a value only when napi_call_threadsafe_function returns
// napi_ok) and counts them.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { METHOD, blockUntil, buildApp, native, waitFor } from './_helpers.mjs'

test('a burst of 100 status events while the isolate is blocked makes no call past 16 queued and counts the rest in status_dropped', { timeout: 120_000 }, async () => {
  const { app } = buildApp([{ method: METHOD.GET, pattern: '/' }])
  const server = native.serverNew(app, '{"threads":50,"port":0}')
  const calls = []
  native.serverOnStatus(server, (event, core, detail) => {
    calls.push({ event, core, detail })
  })
  native.serverStart(server)
  assert.throws(() => native.serverOnStatus(server, () => {}), { code: 'ZERO_INVALID_ARGUMENT' }, 'the callback is set before the start')
  blockUntil(() => native.serverStats(server).status_events >= 50, 'every core to report its start')
  native.serverShutdown(server, 0)
  blockUntil(() => native.serverStats(server).status_events >= 100, 'every core to report its stop')
  assert.equal(calls.length, 0, 'no call ran while the isolate was blocked')
  await native.serverWait(server)
  await waitFor(() => calls.length >= 16, 'the queued calls')
  await new Promise((resolve) => setImmediate(resolve))
  const stats = native.serverStats(server)
  assert.equal(stats.status_events, 100)
  assert.equal(calls.length, 16, 'no call past the 16 queued')
  assert.equal(stats.status_dropped, 84)
  assert.ok(calls.every(({ event }) => event === 'started'), 'the first 16 events were starts')
  assert.ok(calls.every(({ core, detail }) => Number.isInteger(core) && core >= 0 && core < 50 && detail === ''))
})

test('status events reach the callback with their core while the isolate runs', { timeout: 60_000 }, async () => {
  const { app } = buildApp([{ method: METHOD.GET, pattern: '/' }])
  const server = native.serverNew(app, '{"threads":2,"port":0}')
  const calls = []
  native.serverOnStatus(server, (event, core) => {
    calls.push(`${event} ${core}`)
  })
  native.serverStart(server)
  await waitFor(() => calls.filter((call) => call.startsWith('started')).length === 2, 'both starts')
  native.serverShutdown(server, 0)
  await native.serverWait(server)
  await waitFor(() => calls.length === 4, 'both stops')
  assert.deepEqual(calls.slice().sort(), ['started 0', 'started 1', 'stopped 0', 'stopped 1'])
  assert.equal(native.serverStats(server).status_dropped, 0)
})
