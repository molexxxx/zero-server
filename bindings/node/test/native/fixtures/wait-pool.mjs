// Run with UV_THREADPOOL_SIZE=1: two servers' waits are pending while dns.lookup, which
// needs the one libuv pool thread, still completes, and then both waits resolve.

import dns from 'node:dns'

import { METHOD, buildApp, native } from '../_helpers.mjs'

const servers = [0, 1].map(() => {
  const { app } = buildApp([{ method: METHOD.GET, pattern: '/' }])
  const server = native.serverNew(app, '{"threads":1,"port":0}')
  native.serverStart(server)
  return server
})
let settled = 0
const waits = servers.map((server) => native.serverWait(server).then(() => {
  settled += 1
}))
let timer
const lookup = await Promise.race([
  dns.promises.lookup('localhost').then((result) => `resolved ${result.family}`),
  new Promise((resolve) => {
    timer = setTimeout(() => resolve('the lookup did not complete'), 15_000)
  }),
])
clearTimeout(timer)
const pendingDuringLookup = 2 - settled
for (const server of servers) native.serverShutdown(server, 0)
await Promise.all(waits)
process.stdout.write(`${JSON.stringify({ lookup, pendingDuringLookup, settled })}\n`)
