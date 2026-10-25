// A process that serves one request inline, shuts the server down without detaching
// its target, and then has nothing left to do: it exits only when the server's stop
// released the dispatch function that kept its event loop alive.

import { METHOD, native, request, serve } from '../_helpers.mjs'

const site = serve({
  routes: [{ method: METHOD.GET, pattern: '/once' }],
  handler({ slot }) {
    native.resRespond(slot, 200, [], 'once')
  },
})
const answer = await request(site.address, 'GET', '/once')
process.stdout.write(`${answer.status} ${answer.body.toString()}\n`)
native.serverShutdown(site.server, 0)
