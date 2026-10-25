// A worker_threads isolate that loads the addon itself and attaches its own target
// to one worker index of a server the main isolate created.
//
// workerData: { server, worker, name, mode }
//   mode 'answer'      answers every request with its name;
//   mode 'hold'        reports every request to the main isolate and never answers it;
//   mode 'detach'      attaches, detaches and lets its event loop end;
//   mode 'exit'        attaches and ends with process.exit, its target still attached.

import { parentPort, workerData } from 'node:worker_threads'

import { native } from '../_helpers.mjs'

const { server, worker, name, mode } = workerData
const completions = new Float64Array(4096)

function dispatch(index, epoch, kind, records) {
  try {
    if (records == null) return
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength)
    let count = 0
    for (let offset = 0; offset < records.byteLength; offset += 16) {
      const slot = view.getFloat64(offset, true)
      if (mode === 'hold') {
        parentPort.postMessage({ held: slot })
        continue
      }
      native.resRespond(slot, 200, ['X-Worker', String(index)], name)
      completions[count++] = slot
    }
    native.batchComplete(index, completions, count, epoch)
  } catch (error) {
    parentPort.postMessage({ error: String(error && error.stack) })
  }
}

const target = native.targetAttach(server, [worker], dispatch)
if (mode === 'detach') {
  native.targetDetach(target)
  parentPort.postMessage({ detached: true })
} else if (mode === 'exit') {
  parentPort.postMessage({ attached: true })
  process.exit(0)
} else {
  parentPort.postMessage({ ready: true, worker })
}
