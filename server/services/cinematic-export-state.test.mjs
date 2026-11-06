import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCinematicExportStatus } from './cinematic-export-state.mjs'

test('does not mark an export completed when the cinematic gate fails', () => {
  assert.equal(resolveCinematicExportStatus({ passed: false }), 'blocked')
})

test('marks an export completed only after the cinematic gate passes', () => {
  assert.equal(resolveCinematicExportStatus({ passed: true }), 'completed')
})
