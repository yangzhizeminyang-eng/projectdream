import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getAssetNodeGenerationPlan,
  nodesIntersectingSelection,
} from './asset-canvas-selection.mjs'

test('selects intersecting nodes using stable world bounds', () => {
  assert.deepEqual(nodesIntersectingSelection([
    { id: 1, x: 0, y: 0, width: 100, height: 100 },
    { id: 2, x: 300, y: 300, width: 100, height: 100 },
  ], { left: 90, top: 90, right: 120, bottom: 120 }), [1])
})

test('batch plan replaces old split character images with the single asset-board workflow', () => {
  assert.deepEqual(getAssetNodeGenerationPlan({
    nodeType: 'character',
    images: [
      { viewSetType: 'single', status: 'confirmed', visionStatus: 'passed' },
      { viewSetType: 'character-turnaround', viewKey: 'front', status: 'confirmed', visionStatus: 'passed' },
      { viewSetType: 'character-turnaround', viewKey: 'side', status: 'candidate', visionStatus: 'passed' },
    ],
  }), { kind: 'base' })
})

test('batch plan does not duplicate unconfirmed base candidates or complete scene sets', () => {
  assert.deepEqual(getAssetNodeGenerationPlan({
    nodeType: 'character',
    images: [{ viewSetType: 'single', status: 'candidate' }],
  }), { kind: 'base' })
  const keys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right']
  assert.equal(getAssetNodeGenerationPlan({
    nodeType: 'scene',
    images: [
      { viewSetType: 'single', status: 'confirmed', visionStatus: 'passed' },
      ...keys.map((viewKey) => ({ viewSetType: 'scene-nine-grid', viewKey, status: 'candidate' })),
    ],
  }).kind, 'skip')
})

test('batch plan generates a single prop image and supports replacing the adopted one', () => {
  assert.deepEqual(getAssetNodeGenerationPlan({ nodeType: 'prop', images: [] }), { kind: 'prop-base' })
  assert.deepEqual(getAssetNodeGenerationPlan({
    nodeType: 'prop',
    images: [{ viewSetType: 'single', status: 'confirmed', visionStatus: 'passed' }],
  }), { kind: 'prop-base' })
})

test('batch plan waits for an asset board candidate instead of creating split views', () => {
  assert.deepEqual(getAssetNodeGenerationPlan({
    nodeType: 'character',
    images: [{ viewSetType: 'character-asset-pack', status: 'candidate', visionStatus: 'pending' }],
  }), { kind: 'skip', reason: '角色资产板检查中' })
})

test('scene batches recognize a manually adopted panorama with an explicitly skipped vision check', () => {
  assert.deepEqual(getAssetNodeGenerationPlan({
    nodeType: 'scene',
    images: [{ viewSetType: 'single', status: 'confirmed', visionStatus: 'skipped' }],
  }), { kind: 'scene-views', views: ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right'] })
})

test('skipped scene checks do not satisfy the character base gate', () => {
  assert.deepEqual(getAssetNodeGenerationPlan({
    nodeType: 'character',
    images: [{ viewSetType: 'single', status: 'confirmed', visionStatus: 'skipped' }],
  }), { kind: 'base' })
})
