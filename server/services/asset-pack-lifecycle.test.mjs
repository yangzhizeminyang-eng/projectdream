import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isCharacterAssetPackRow,
  planAssetPackAdoption,
  planSingleAssetAdoption,
} from './asset-pack-lifecycle.mjs'

test('legacy single images are treated as asset boards only with an explicit board marker', () => {
  assert.equal(isCharacterAssetPackRow({ view_set_type: 'single', view_label: '角色资产板' }), true)
  assert.equal(isCharacterAssetPackRow({ view_set_type: 'single', view_label: '基础正面全身图' }), false)
  assert.equal(isCharacterAssetPackRow({ view_set_type: 'character-asset-pack' }), true)
})

const packRows = (overrides = {}) => [
  { id: 11, view_set_type: 'character-asset-pack', view_key: null, status: 'candidate', vision_status: 'passed' },
].map((row) => ({ ...row, ...overrides[row.view_key || row.view_set_type] }))

test('a character pack is adopted atomically only when all five required views pass', () => {
  const result = planAssetPackAdoption(packRows(), [
    { id: 1, view_set_type: 'single', view_key: null, status: 'confirmed' },
    { id: 2, view_set_type: 'character-face-closeup', view_key: 'face', status: 'confirmed' },
  ])

  assert.equal(result.ready, true)
  assert.deepEqual(result.adoptIds, [11])
  assert.deepEqual(result.replaceIds, [1, 2])
})

test('a failed or missing pack view leaves the currently adopted pack untouched', () => {
  const failed = planAssetPackAdoption(packRows({ 'character-asset-pack': { vision_status: 'failed' } }), [
    { id: 1, view_set_type: 'single', view_key: null, status: 'confirmed' },
  ])
  const missing = planAssetPackAdoption([], [])

  assert.equal(failed.ready, false)
  assert.deepEqual(failed.adoptIds, [])
  assert.deepEqual(failed.replaceIds, [])
  assert.equal(missing.ready, false)
  assert.match(missing.blockers.join(' '), /资产板缺失/)
})

test('a passed prop base image becomes the sole adopted version after vision review', () => {
  const result = planSingleAssetAdoption(
    { id: 20, status: 'candidate', vision_status: 'passed' },
    [{ id: 19, status: 'confirmed' }],
  )

  assert.deepEqual(result, { ready: true, adoptId: 20, replaceIds: [19] })
})

test('a prop image with pending or failed review cannot replace the adopted image', () => {
  for (const vision_status of ['pending', 'failed']) {
    const result = planSingleAssetAdoption(
      { id: 20, status: 'candidate', vision_status },
      [{ id: 19, status: 'confirmed' }],
    )
    assert.equal(result.ready, false)
    assert.equal(result.adoptId, null)
    assert.deepEqual(result.replaceIds, [])
  }
})
