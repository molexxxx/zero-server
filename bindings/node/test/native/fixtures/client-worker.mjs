// A client on its own thread: it waits until the main isolate sets the start flag,
// then sends `count` requests on separate connections and reports their statuses, so
// the requests reach the server while the main isolate's thread is blocked.
//
// workerData: { address, path, count, flag } with flag an Int32Array over a
// SharedArrayBuffer.

import { parentPort, workerData } from 'node:worker_threads'

import { request } from '../_helpers.mjs'

const { address, path, count, flag } = workerData
parentPort.postMessage({ waiting: true })
Atomics.wait(flag, 0, 0)
const answers = await Promise.all(Array.from({ length: count }, () => request(address, 'GET', path)))
parentPort.postMessage({ statuses: answers.map((answer) => answer.status) })
