// Shared helpers of the native tests: the addon, a raw HTTP/1.1 client, an inline
// isolate that serves a server through a minimal dispatch loop, and polling.

import { createRequire } from 'node:module'
import net from 'node:net'

const require = createRequire(import.meta.url)

/** The native addon, as `@zero-server/native` loads it. */
export const native = require('@zero-server/native')

/** Route kinds and method codes of `appRoute`. */
export const ROUTE = { HOST: 0, STATIC: 1, REDIRECT: 2, FIXED: 3, WEBSOCKET: 4, HEALTH: 5 }
export const METHOD = { GET: 0, HEAD: 1, POST: 2, PUT: 3, DELETE: 4, OPTIONS: 6, PATCH: 8, ANY: 254 }

/** Batch kinds and event kinds of the dispatch function. */
export const BATCH = { REQUESTS: 1, EVENTS: 2 }
export const EVENT = { WS_OPEN: 1, WS_MESSAGE: 2, WS_PONG: 3, WS_CLOSE: 4, WS_DRAINED: 5, SSE_CLOSED: 6, SSE_DRAINED: 7 }

/**
 * Poll `check` until it returns a truthy value, yielding to the event loop between
 * tries, for up to `timeoutMs`.
 *
 * @param {() => unknown} check - the condition.
 * @param {string} what - what is awaited, for the failure message.
 * @param {number} [timeoutMs] - the deadline.
 * @returns {Promise<unknown>} the truthy value.
 */
export async function waitFor(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/**
 * Block this isolate's thread until `check` holds, without yielding to the event loop,
 * so deliveries pile up in Node's queue meanwhile.
 *
 * @param {() => unknown} check - the condition, evaluated with synchronous calls only.
 * @param {string} what - what is awaited, for the failure message.
 * @param {number} [timeoutMs] - the deadline.
 */
export function blockUntil(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
  }
}

/** Split `host:port` or `[host]:port`. */
export function hostPort(address) {
  const at = address.lastIndexOf(':')
  return { host: address.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(address.slice(at + 1)) }
}

/**
 * Decode a chunked body.
 *
 * @param {Buffer} body - the chunked octets.
 * @returns {Buffer} the content.
 */
function unchunk(body) {
  const parts = []
  let offset = 0
  for (;;) {
    const lineEnd = body.indexOf('\r\n', offset)
    if (lineEnd < 0) break
    const size = parseInt(body.subarray(offset, lineEnd).toString('latin1'), 16)
    if (!Number.isFinite(size) || size === 0) break
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size))
    offset = lineEnd + 2 + size + 2
  }
  return Buffer.concat(parts)
}

/**
 * Parse one complete response.
 *
 * @param {Buffer} raw - the octets the server sent.
 * @returns {{ status: number, headers: Array<[string, string]>, body: Buffer, raw: Buffer, header: (name: string) => string | undefined }}
 */
export function parseResponse(raw) {
  const end = raw.indexOf('\r\n\r\n')
  if (end < 0) throw new Error(`no complete head in ${JSON.stringify(raw.toString('latin1'))}`)
  const lines = raw.subarray(0, end).toString('latin1').split('\r\n')
  const status = Number(lines[0].split(' ')[1])
  const headers = lines.slice(1).map((line) => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
  })
  const header = (name) => headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  let body = raw.subarray(end + 4)
  if ((header('transfer-encoding') ?? '').toLowerCase() === 'chunked') {
    body = unchunk(body)
  } else if (header('content-length') !== undefined) {
    body = body.subarray(0, Number(header('content-length')))
  }
  return { status, headers, body, raw, header }
}

/**
 * Send one request on a new connection with `Connection: close` and read the
 * response until the server closes the connection.
 *
 * @param {string} address - the server's address.
 * @param {string} method - the method token.
 * @param {string} path - the request target.
 * @param {{ headers?: Record<string, string>, body?: Buffer | string }} [options]
 * @returns {Promise<ReturnType<typeof parseResponse>>}
 */
export function request(address, method, path, options = {}) {
  const { host, port } = hostPort(address)
  const body = options.body === undefined ? undefined : Buffer.from(options.body)
  const headers = { Host: 'test', Connection: 'close', ...(options.headers ?? {}) }
  if (body !== undefined) headers['Content-Length'] = String(body.length)
  const head = `${method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`
  return new Promise((resolve, reject) => {
    const chunks = []
    const socket = net.connect({ host, port }, () => {
      socket.write(head)
      if (body !== undefined) socket.write(body)
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      try {
        resolve(parseResponse(Buffer.concat(chunks)))
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * Send octets as they are on a new connection and read the response until the
 * server closes the connection; the octets should ask for `Connection: close`.
 *
 * @param {string} address - the server's address.
 * @param {Buffer | string} bytes - the whole request.
 * @returns {Promise<ReturnType<typeof parseResponse>>}
 */
export function rawRequest(address, bytes) {
  const { host, port } = hostPort(address)
  return new Promise((resolve, reject) => {
    const chunks = []
    const socket = net.connect({ host, port }, () => socket.write(bytes))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      try {
        resolve(parseResponse(Buffer.concat(chunks)))
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * Register routes on a new application.
 *
 * @param {Array<{ kind?: number, method?: number, pattern: string, options?: string }>} routes
 * @returns {{ app: number, ids: number[] }}
 */
export function buildApp(routes) {
  const app = native.appNew()
  const ids = routes.map((route) =>
    native.appRoute(app, route.kind ?? ROUTE.HOST, route.method ?? METHOD.ANY, route.pattern, route.options ?? ''))
  return { app, ids }
}

/**
 * Serve an application in this isolate (inline mode): one target over every worker of
 * the server, and a dispatch loop that hands each request to `handler` and completes
 * the batch's answered slots and acknowledges it in one call. A handler that returns
 * `'later'` answers afterwards and completes the slot with `done()`.
 *
 * @param {object} config
 * @param {Array<{ kind?: number, method?: number, pattern: string, options?: string }>} config.routes
 * @param {(request: { slot: number, route: number, worker: number, done: () => void }) => unknown} [config.handler]
 * @param {(events: Array<object>, worker: number) => void} [config.onEvents]
 * @param {object} [config.options] - the server option document.
 * @param {(server: number) => void} [config.beforeStart]
 * @returns {object} the application, server, target, address and counters.
 */
export function serve(config) {
  const { app, ids } = config.app !== undefined ? { app: config.app, ids: [] } : buildApp(config.routes)
  const server = native.serverNew(app, JSON.stringify({ threads: 1, port: 0, ...(config.options ?? {}) }))
  const workers = native.serverWorkers(server)
  const state = { handled: 0, skipped: 0, batches: 0, errors: [], refusedAcks: 0 }
  const completions = new Float64Array(4096)
  const dispatch = (worker, epoch, kind, records, events) => {
    try {
      if (records == null && events == null) {
        state.skipped += 1
        return
      }
      state.batches += 1
      let count = 0
      if (records != null) {
        const view = new DataView(records.buffer, records.byteOffset, records.byteLength)
        for (let offset = 0; offset < records.byteLength; offset += 16) {
          const slot = view.getFloat64(offset, true)
          const route = view.getUint32(offset + 8, true)
          state.handled += 1
          const done = () => {
            try {
              native.batchComplete(worker, Float64Array.of(slot), 1, 0)
            } catch (error) {
              state.errors.push(error)
            }
          }
          let answer
          try {
            answer = config.handler ? config.handler({ slot, route, worker, done }) : undefined
          } catch (error) {
            state.errors.push(error)
          }
          if (answer !== 'later') completions[count++] = slot
        }
      } else if (config.onEvents) {
        config.onEvents(events, worker)
      }
      if (native.batchComplete(worker, completions, count, epoch) !== 0) state.refusedAcks += 1
    } catch (error) {
      state.errors.push(error)
    }
  }
  const target = native.targetAttach(server, workers, dispatch)
  config.beforeStart?.(server)
  const address = native.serverStart(server)
  return {
    app,
    ids,
    server,
    workers,
    target,
    address,
    state,
    async close() {
      native.serverShutdown(server, 0)
      await native.serverWait(server)
    },
  }
}

/** A JSON body of a response. */
export function json(response) {
  return JSON.parse(response.body.toString('utf8'))
}
