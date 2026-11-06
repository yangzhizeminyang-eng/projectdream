import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveAssetImageVersionUpdates } from './asset-node-image-state.mjs'

test('adopts the newest passed retry and hides the previous angle version', () => {
  const updates = resolveAssetImageVersionUpdates([
    { id: 10, view_set_type: 'single', view_key: null, status: 'confirmed', vision_status: 'passed' },
    { id: 11, view_set_type: 'single', view_key: null, status: 'candidate', vision_status: 'passed' },
    { id: 12, view_set_type: 'single', view_key: null, status: 'candidate', vision_status: 'failed' },
  ])

  assert.deepEqual(updates, [
    { id: 11, status: 'confirmed' },
    { id: 10, status: 'superseded' },
  ])
})

test('does not replace a usable image with a failed retry', () => {
  const updates = resolveAssetImageVersionUpdates([
    { id: 20, view_set_type: 'character-turnaround', view_key: 'side', status: 'confirmed', vision_status: 'passed' },
    { id: 21, view_set_type: 'character-turnaround', view_key: 'side', status: 'failed', vision_status: 'failed' },
  ])

  assert.deepEqual(updates, [{ id: 20, status: 'confirmed' }])
})
