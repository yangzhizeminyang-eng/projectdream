import assert from 'node:assert/strict'
import test from 'node:test'

import { buildStoryboardAssetCatalog } from './storyboard-asset-catalog.mjs'

test('catalog keeps confirmed image identity and versions while grouping image rows by asset node', () => {
  const catalog = buildStoryboardAssetCatalog([
    {
      asset_node_id: 12,
      node_type: 'scene',
      ref_id: 7,
      label: '夜班值班台',
      asset_prompt: '固定空间与传送窗口',
      image_id: 101,
      version_no: 2,
      view_set_version: 3,
      view_key: 'left-front',
      view_set_type: 'scene-nine-grid',
      status: 'confirmed',
      vision_status: 'skipped',
    },
    {
      asset_node_id: 12,
      node_type: 'scene',
      ref_id: 7,
      label: '夜班值班台',
      image_id: 102,
      version_no: 2,
      view_set_version: 3,
      view_key: 'center',
      view_set_type: 'scene-nine-grid',
      status: 'confirmed',
      vision_status: 'skipped',
    },
  ], 7)

  assert.equal(catalog.scenes.length, 1)
  assert.equal(catalog.scenes[0].assetNodeId, 12)
  assert.equal(catalog.scenes[0].versionNo, 2)
  assert.equal(catalog.scenes[0].viewSetVersion, 3)
  assert.deepEqual(catalog.scenes[0].sceneViewKeys, ['left-front', 'center'])
  assert.deepEqual(catalog.scenes[0].confirmedImages.map((item) => item.imageId), [101, 102])
})

test('catalog excludes unconfirmed or failed vision images and unrelated scenes', () => {
  const catalog = buildStoryboardAssetCatalog([
    { asset_node_id: 1, node_type: 'scene', ref_id: 9, label: '其他场景', image_id: 11, status: 'confirmed', vision_status: 'skipped' },
    { asset_node_id: 2, node_type: 'scene', ref_id: 7, label: '待确认场景', image_id: 12, status: 'candidate', vision_status: 'passed' },
    { asset_node_id: 3, node_type: 'prop', label: '失败道具', image_id: 13, status: 'confirmed', vision_status: 'failed' },
    { asset_node_id: 4, node_type: 'prop', label: '未检查道具', image_id: 14, status: 'confirmed', vision_status: null },
  ], 7)

  assert.deepEqual(catalog.scenes, [])
  assert.deepEqual(catalog.props, [])
})
