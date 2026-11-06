import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAssetCanvasRelations,
  buildStoryboardCanvasNodes,
  buildStoryboardCanvasRelations,
} from './asset-canvas-relations.mjs'

test('canvas relations only use real referenced node ids', () => {
  const relations = buildAssetCanvasRelations({
    nodeIds: [1, 2, 3, 99],
    storyboards: [{
      id: 8,
      shot_no: '02',
      asset_reference_json: JSON.stringify({
        characterAssetNodeId: 1,
        sceneAssetNodeId: 2,
        propAssetRefs: [{ assetNodeId: 3 }],
      }),
    }],
  })
  assert.equal(relations.length, 2)
  assert.deepEqual(relations.map((item) => [item.fromNodeId, item.toNodeId]), [[1, 2], [1, 3]])
  assert.deepEqual(relations[0].storyboardIds, [8])
})

test('canvas relations ignore names without persisted ids', () => {
  assert.deepEqual(buildAssetCanvasRelations({
    nodeIds: [1, 2],
    storyboards: [{ asset_reference_json: JSON.stringify({ characterName: '唐宁', sceneAssetNames: ['办公室'] }) }],
  }), [])
})

test('canvas relations accept the persisted storyboard reference field names', () => {
  const relations = buildAssetCanvasRelations({
    nodeIds: [11, 12, 13],
    storyboards: [{
      id: 19,
      shot_no: '03',
      asset_reference_json: JSON.stringify({
        characterId: 11,
        sceneAssetId: 12,
        propAssetRefs: [{ assetNodeId: 13, name: '离职协议' }],
      }),
    }],
  })

  assert.deepEqual(relations.map((item) => [item.fromNodeId, item.toNodeId]), [[11, 12], [11, 13]])
  assert.deepEqual(relations[0].storyboardIds, [19])
})

test('canvas exposes storyboard nodes and real continuity relations', () => {
  const storyboards = [
    {
      id: 21,
      scene_id: 7,
      shot_no: '01',
      asset_reference_json: JSON.stringify({ characterId: 11, sceneAssetId: 12 }),
    },
    {
      id: 22,
      scene_id: 7,
      shot_no: '02',
      asset_reference_json: JSON.stringify({
        characterId: 11,
        sceneAssetId: 12,
        continuityFromShot: '01',
        propAssetRefs: [{ assetNodeId: 13 }],
      }),
    },
  ]
  const nodes = buildStoryboardCanvasNodes({
    assetNodes: [{ id: 11, x: 48, y: 48, height: 260 }],
    storyboards,
  })
  const relations = buildStoryboardCanvasRelations({
    assetNodes: [{ id: 11 }, { id: 12 }, { id: 13 }],
    storyboards,
    storyboardNodes: nodes,
  })

  assert.deepEqual(nodes.map((node) => node.id), [-21, -22])
  assert.ok(relations.some((item) => item.kind === 'storyboard-asset' && item.fromNodeId === 13 && item.toNodeId === -22))
  assert.ok(relations.some((item) => item.kind === 'storyboard-continuity' && item.fromNodeId === -21 && item.toNodeId === -22))
})
