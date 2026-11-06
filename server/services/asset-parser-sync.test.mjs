import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActiveAssetNodeDedupPlan,
  buildAssetParserSyncPlan,
  buildCharacterRecordSyncPlan,
} from './asset-parser-sync.mjs'

test('keeps one active node for a logical asset and preserves image history', () => {
  const plan = buildActiveAssetNodeDedupPlan([
    { id: 149, nodeType: 'scene', refId: 44, groupKey: 'scene:44:default', status: 'active', imageCount: 0 },
    { id: 150, nodeType: 'scene', refId: 44, groupKey: 'scene:44:default', status: 'active', imageCount: 2 },
    { id: 151, nodeType: 'scene', refId: 45, groupKey: 'scene:45:default', status: 'active', imageCount: 0 },
    { id: 152, nodeType: 'scene', refId: 45, groupKey: 'scene:45:default', status: 'active', imageCount: 0 },
    { id: 153, nodeType: 'scene', refId: 46, groupKey: 'scene:46:default', status: 'archived', imageCount: 9 },
  ])

  assert.deepEqual(plan.archiveIds, [149, 152])
})

test('archives stale character and scene nodes but keeps unrelated asset types', () => {
  const plan = buildAssetParserSyncPlan({
    existingNodes: [
      { id: 1, nodeType: 'character', refId: 10, groupKey: 'character-10-current', status: 'active' },
      { id: 2, nodeType: 'scene', refId: 20, groupKey: 'scene-20-old', status: 'active' },
      { id: 3, nodeType: 'prop', refId: 30, groupKey: 'prop-30', status: 'active' },
      { id: 4, nodeType: 'scene', refId: 21, groupKey: 'scene-21-old', status: 'archived' },
    ],
    characterNodes: [
      { refId: 10, groupKey: 'character-10-current' },
    ],
    sceneNodes: [
      { refId: 21, groupKey: 'scene-21-new' },
    ],
  })

  assert.deepEqual(plan.archiveIds, [2])
  assert.equal(plan.desired.has('character:10:character-10-current'), true)
  assert.equal(plan.desired.has('scene:21:scene-21-new'), true)
})

test('archives active character records that are absent from the current script', () => {
  const plan = buildCharacterRecordSyncPlan({
    existingCharacters: [
      { id: 29, name: '唐宁', status: 'finalized' },
      { id: 31, name: '赵启明', status: 'finalized' },
      { id: 37, name: '林默', status: 'draft' },
      { id: 40, name: '旧角色', status: 'archived' },
    ],
    currentCharacters: [
      { name: '林默' },
      { name: '陈志远' },
    ],
  })

  assert.deepEqual(plan.archiveIds, [29, 31])
  assert.equal(plan.desiredNames.has('林默'), true)
  assert.equal(plan.desiredNames.has('陈志远'), true)
})
