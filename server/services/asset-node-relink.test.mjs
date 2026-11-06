import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseSceneForRelink } from './asset-node-relink.mjs'

const scenes = [
  { id: 33, title: '丧服与挂钟', location: '深夜公寓客厅' },
  { id: 34, title: '花丛中的遗照', location: '悼念厅遗照花丛（回忆闪回画面）' },
]

test('relinks by explicit scene id', () => {
  assert.equal(chooseSceneForRelink({ requestedSceneId: 33, scenes }).title, '丧服与挂钟')
})

test('relinks by concrete scene label', () => {
  assert.equal(chooseSceneForRelink({ requestedLabel: '深夜公寓客厅', scenes }).id, 33)
})

test('does not guess unrelated scenes', () => {
  assert.equal(chooseSceneForRelink({ requestedLabel: '不存在的场景', scenes }), null)
})
