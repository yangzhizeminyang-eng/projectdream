import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const backend = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
const canvas = await readFile(new URL('../../src/views/AssetCanvas.vue', import.meta.url), 'utf8')

test('scene nine-grid batch creates independent angles and records an explicit skipped inspection state', () => {
  assert.match(backend, /const maxAttempts = isSceneVisionCheckEnabled\(\)[\s\S]*?sceneNineGridQualityAttempts\(request\.qualityAttempts, 5\)/)
  assert.match(backend, /inspectSceneGeneratedCandidate\(/)
  assert.match(backend, /passed: true,\s+skipped: true/)
  assert.match(backend, /prechecked\.skipped \? 'skipped'/)
  assert.match(backend, /precheckedVision: vision/)
  assert.match(backend, /candidates\.length !== buildSceneNineGridViewDescriptors\(\{\}\)\.length/)
  assert.match(backend, /场景九宫格未完成 9\/9/)
})

test('scene nine-grid retry guard recognizes complete batches whether inspection ran or not', () => {
  assert.match(backend, /MAX\(view_count\) AS view_count/)
  assert.match(backend, /GROUP BY view_set_version/)
  assert.match(backend, /source_image_id = \?/)
  assert.match(backend, /vision_status IN \('passed', 'skipped'\)/)
})

test('scene group execution requires nine returned independent view records', () => {
  assert.match(canvas, /async function generateSceneNineGridBatch\(/)
  assert.match(canvas, /viewType: 'scene-nine-grid'/)
  assert.match(canvas, /const views = items\.filter\(\(item\) => item\.viewSetType === 'scene-nine-grid' && item\.viewKey\)/)
  assert.match(canvas, /views\.length !== SCENE_NINE_GRID_KEYS\.length/)
  assert.match(canvas, /sourceMismatch\.length/)
  assert.match(canvas, /versions\.size !== 1/)
  assert.match(canvas, /批量任务失败时仍刷新一次/)
})

test('scene nine-grid generation accepts and validates the explicitly selected panorama', () => {
  assert.match(backend, /body\.referenceImageId/)
  assert.match(backend, /explicitPanoramaId = parseId\(body\.referenceImageId\)/)
  assert.match(backend, /status IN \('candidate', 'confirmed'\)/)
  assert.match(backend, /source_image_id = \?/)
  assert.match(canvas, /referenceImageId: panorama\.id/)
})
