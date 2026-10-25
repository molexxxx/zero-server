// `node --test test/native` resolves this directory to this module: it runs every
// *.test.mjs file beside it in a process of its own, as the test runner does for a
// list of files, and reports each file as one test with the file's own report.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()

/** Run one test file under the runner and collect its report and exit code. */
function run(file) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', path.join(here, file)], {
      cwd: path.resolve(here, '..', '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.once('exit', (code, signal) => resolve({ code, signal, output }))
  })
}

for (const file of files) {
  test(file, { timeout: 600_000 }, async () => {
    const result = await run(file)
    process.stdout.write(result.output)
    assert.equal(result.signal, null, `${file} was killed by ${result.signal}`)
    assert.equal(result.code, 0, `${file} failed:\n${result.output}`)
  })
}
