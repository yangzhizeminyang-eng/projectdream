import assert from 'node:assert/strict'
import test from 'node:test'

import { startExportQueueSweep } from './export-queue.mjs'

test('export queue sweep starts, triggers scans, and releases its timer', async () => {
  const calls = []
  let tick
  let unrefCalled = false
  let cleared = false
  const timer = {
    unref() { unrefCalled = true },
  }
  const stop = startExportQueueSweep({
    sweep: async () => { calls.push('sweep') },
    onError: (error) => calls.push(error.message),
    intervalMs: 15000,
    setIntervalFn(callback, interval) {
      calls.push(['interval', interval])
      tick = callback
      return timer
    },
    clearIntervalFn(value) {
      assert.equal(value, timer)
      cleared = true
    },
  })

  await tick()
  stop()

  assert.deepEqual(calls, [['interval', 15000], 'sweep'])
  assert.equal(unrefCalled, true)
  assert.equal(cleared, true)
})

test('export queue sweep reports failures without creating unhandled rejections', async () => {
  const errors = []
  let tick
  startExportQueueSweep({
    sweep: async () => { throw new Error('database unavailable') },
    onError: (error) => errors.push(error.message),
    intervalMs: 15000,
    setIntervalFn(callback) {
      tick = callback
      return { unref() {} }
    },
    clearIntervalFn() {},
  })

  await tick()

  assert.deepEqual(errors, ['database unavailable'])
})
