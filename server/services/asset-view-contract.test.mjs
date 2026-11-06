import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAssetViewItems,
  buildStoryboardAssetReference,
  normalizeAssetViewItems,
  selectLatestAssetViewItems,
  validateAssetViewSet,
  validateStoryboardAssetReference,
} from './asset-view-contract.mjs'

test('character turnaround requires independently addressable front, side, and back views', () => {
  const items = buildAssetViewItems({
    imageId: 10,
    assetNodeId: 20,
    versionNo: 3,
    viewSetType: 'character-turnaround',
    status: 'confirmed',
  })

  assert.deepEqual(items.map((item) => item.viewKey), ['front', 'side', 'back'])
  assert.equal(validateAssetViewSet({
    viewSetType: 'character-turnaround',
    items,
    requireConfirmed: true,
  }).ready, true)
})

test('character angle contract includes an explicit generation prompt for each independent image', () => {
  const items = buildAssetViewItems({
    imageId: 100,
    assetNodeId: 20,
    viewSetType: 'character-turnaround',
  })

  assert.deepEqual(items.map((item) => item.viewLabel), ['正面', '严格侧面', '背面'])
  assert.deepEqual(items.map((item) => item.viewIndex), [1, 2, 3])
})

test('scene nine-grid reports a missing cell and an unconfirmed cell', () => {
  const items = buildAssetViewItems({
    imageId: 10,
    assetNodeId: 20,
    versionNo: 2,
    viewSetType: 'scene-nine-grid',
    status: 'confirmed',
  }).filter((item) => item.viewIndex !== 9)
  items[4].status = 'candidate'

  const result = validateAssetViewSet({
    viewSetType: 'scene-nine-grid',
    items,
    requireConfirmed: true,
  })

  assert.equal(result.ready, false)
  assert.deepEqual(result.missing, ['back-right'])
  assert.match(result.blockers.join(' '), /正中视角尚未确认/)
})

test('scene nine-grid items preserve mother-image and crop evidence', () => {
  const items = normalizeAssetViewItems([{
    image_id: 21,
    asset_node_id: 2,
    view_set_type: 'scene-nine-grid',
    view_set_version: 4,
    view_index: 3,
    view_key: 'front-right',
    view_label: '右前',
    source_image_id: 20,
    source_image_url: 'https://cdn.test/mother.png',
    crop_json: JSON.stringify({ x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 3 }),
    status: 'candidate',
  }])

  assert.equal(items[0].sourceImageId, 20)
  assert.equal(items[0].sourceImageUrl, 'https://cdn.test/mother.png')
  assert.deepEqual(items[0].crop, { x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 3 })
})

test('latest failed retry cannot be hidden by an older confirmed angle', () => {
  const result = validateAssetViewSet({
    viewSetType: 'character-turnaround',
    items: [
      { image_id: 1, view_set_type: 'character-turnaround', view_set_version: 1, view_index: 1, view_key: 'front', status: 'confirmed' },
      { image_id: 2, view_set_type: 'character-turnaround', view_set_version: 1, view_index: 2, view_key: 'side', status: 'confirmed' },
      { image_id: 3, view_set_type: 'character-turnaround', view_set_version: 1, view_index: 3, view_key: 'back', status: 'confirmed' },
      { image_id: 4, view_set_type: 'character-turnaround', view_set_version: 2, view_index: 2, view_key: 'side', status: 'candidate' },
    ],
    requireConfirmed: true,
  })

  assert.equal(result.ready, false)
  assert.deepEqual(selectLatestAssetViewItems(result.items).map((item) => item.imageId), [1, 4, 3])
  assert.match(result.blockers.join(' '), /side视角尚未确认/)
})

test('storyboard references retain exact scene angle and production versions', () => {
  const reference = buildStoryboardAssetReference({
    storyboardId: 7,
    characterId: 11,
    characterVersionNo: 4,
    characterViewSetVersion: 2,
    characterViewKeys: ['front'],
    sceneAssetId: 22,
    scenePanoramaVersion: 3,
    sceneViewSetVersion: 2,
    sceneViewKey: 'front-right',
    sceneViewIndex: 3,
    promptVersion: 'douyin-v1',
    agentVersion: 'scene-agent-v2',
  })

  const result = validateStoryboardAssetReference(reference, {
    requireCharacter: true,
    requireScene: true,
  })

  assert.equal(result.ready, true)
  assert.equal(result.reference.sceneViewKey, 'front-right')
  assert.equal(result.reference.scenePanoramaVersion, 3)
  assert.equal(result.reference.agentVersion, 'scene-agent-v2')
})

test('storyboard reference validation blocks missing hard references', () => {
  const result = validateStoryboardAssetReference({}, {
    requireCharacter: true,
    requireScene: true,
  })

  assert.equal(result.ready, false)
  assert.equal(result.blockers.length, 5)
})

test('storyboard reference validation accepts a confirmed panorama without a nine-grid angle', () => {
  const result = validateStoryboardAssetReference({
    sceneAssetId: 22,
    scenePanoramaVersion: 3,
  }, { requireScene: true })

  assert.equal(result.ready, true)
  assert.equal(result.reference.sceneViewKey, null)
})
