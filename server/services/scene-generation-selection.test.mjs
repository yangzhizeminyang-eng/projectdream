import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasCompleteSceneNineGridBatch,
  selectLatestPassedScenePanorama,
} from './scene-generation-selection.mjs'

test('a passed newer panorama candidate wins over the old confirmed panorama', () => {
  const panorama = selectLatestPassedScenePanorama([
    { id: 137, viewSetType: 'single', status: 'confirmed', visionStatus: 'passed' },
    { id: 458, viewSetType: 'single', status: 'candidate', visionStatus: 'passed' },
  ])
  assert.equal(panorama?.id, 458)
})

test('a complete nine-grid is scoped to the selected panorama source', () => {
  const keys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right']
  const images = keys.map((viewKey, index) => ({
    id: 500 + index,
    viewSetType: 'scene-nine-grid',
    sourceImageId: 458,
    viewSetVersion: 7,
    viewKey,
    status: 'confirmed',
    visionStatus: 'passed',
  }))
  assert.equal(hasCompleteSceneNineGridBatch(images, 458), true)
  assert.equal(hasCompleteSceneNineGridBatch(images, 137), false)
})

test('scene generation selection treats explicitly skipped vision as generated, not as passed', () => {
  const keys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right']
  const panorama = selectLatestPassedScenePanorama([
    { id: 42, viewSetType: 'single', status: 'confirmed', visionStatus: 'skipped' },
  ])
  const images = keys.map((viewKey, index) => ({
    id: index + 100,
    viewSetType: 'scene-nine-grid',
    sourceImageId: 42,
    viewSetVersion: 3,
    viewKey,
    status: 'candidate',
    visionStatus: 'skipped',
  }))

  assert.equal(panorama?.id, 42)
  assert.equal(hasCompleteSceneNineGridBatch(images, 42), true)
})
