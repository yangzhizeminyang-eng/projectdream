import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canArchiveProjectAsset,
  normalizeProjectAssetType,
} from './project-assets.mjs'

test('project asset archive policy allows disposable candidate and draft assets', () => {
  assert.deepEqual(canArchiveProjectAsset({ assetType: 'image', status: 'candidate' }), {
    allowed: true,
  })
  assert.deepEqual(canArchiveProjectAsset({ assetType: 'audio', status: 'draft' }), {
    allowed: true,
  })
  assert.deepEqual(canArchiveProjectAsset({ assetType: 'character', status: 'draft' }), {
    allowed: true,
  })
})

test('project asset archive policy protects confirmed and finalized assets', () => {
  assert.deepEqual(canArchiveProjectAsset({ assetType: 'video', status: 'confirmed' }), {
    allowed: false,
    reason: 'confirmed',
  })
  assert.deepEqual(canArchiveProjectAsset({ assetType: 'character', status: 'finalized' }), {
    allowed: false,
    reason: 'finalized',
  })
})

test('project asset archive policy rejects invalid or already archived assets', () => {
  assert.equal(normalizeProjectAssetType('still'), null)
  assert.deepEqual(canArchiveProjectAsset({ assetType: 'still', status: 'candidate' }), {
    allowed: false,
    reason: 'unsupported_type',
  })
  assert.deepEqual(canArchiveProjectAsset({ assetType: 'audio', status: 'archived' }), {
    allowed: false,
    reason: 'already_archived',
  })
})
