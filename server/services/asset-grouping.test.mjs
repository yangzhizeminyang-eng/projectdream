import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAssetGroups } from './asset-grouping.mjs'

test('asset groups keep each character stable and include single-node groups', () => {
  const groups = buildAssetGroups([
    {
      id: 11,
      nodeType: 'character',
      refId: 7,
      groupKey: '角色',
      label: '唐宁',
      x: 80,
      y: 80,
      width: 220,
      height: 260,
      state: 'confirmed',
    },
    {
      id: 12,
      nodeType: 'character',
      refId: 7,
      groupKey: '角色',
      label: '唐宁',
      appearanceLabel: '夜班状态',
      x: 340,
      y: 80,
      width: 220,
      height: 260,
      state: 'draft',
    },
    {
      id: 13,
      nodeType: 'character',
      refId: 8,
      groupKey: '角色',
      label: '赵衡',
      x: 80,
      y: 420,
      width: 220,
      height: 260,
      state: 'ready',
    },
  ])

  assert.equal(groups.length, 2)

  const tangNing = groups.find((group) => group.key === 'character:7')
  assert.ok(tangNing)
  assert.equal(tangNing.nodeType, 'character')
  assert.equal(tangNing.label, '唐宁')
  assert.deepEqual(tangNing.nodeIds, [11, 12])
  assert.equal(tangNing.nodeCount, 2)
  assert.deepEqual(tangNing.stateCounts, { draft: 1, ready: 0, confirmed: 1 })
  assert.ok(tangNing.bounds.width > 480)

  const zhaoHeng = groups.find((group) => group.key === 'character:8')
  assert.ok(zhaoHeng)
  assert.deepEqual(zhaoHeng.nodeIds, [13])
  assert.equal(zhaoHeng.nodeCount, 1)
  assert.deepEqual(zhaoHeng.stateCounts, { draft: 0, ready: 1, confirmed: 0 })
})

test('asset groups preserve explicit custom keys and classify scenes separately', () => {
  const groups = buildAssetGroups([
    {
      id: 21,
      nodeType: 'scene',
      refId: 31,
      groupKey: 'scene:31',
      label: '合规办公室',
      x: 900,
      y: 500,
      width: 260,
      height: 220,
      state: 'confirmed',
    },
    {
      id: 22,
      nodeType: 'prop',
      refId: null,
      groupKey: 'prop:alarm-clock',
      label: '旧手机',
      x: 1280,
      y: 500,
      width: 220,
      height: 260,
      state: 'draft',
    },
  ])

  assert.deepEqual(
    groups.map((group) => group.key),
    ['scene:31', 'prop:alarm-clock'],
  )
  assert.equal(groups[0].typeLabel, '场景')
  assert.equal(groups[0].bounds.x, 874)
  assert.equal(groups[1].typeLabel, '道具')
  assert.equal(groups[1].bounds.height, 400)
})

test('groups prompt-described temporal variants under one character execution board', () => {
  const groups = buildAssetGroups([
    { id: 31, nodeType: 'character', refId: 7, label: '唐宁', promptText: '当前职场状态；浅蓝衬衫' },
    { id: 32, nodeType: 'character', refId: 7, label: '唐宁', promptText: '五年前的学生时期；校服' },
  ])

  assert.deepEqual(groups.map((group) => group.key), ['character:7'])
  assert.deepEqual(groups.map((group) => group.nodeIds), [[31, 32]])
})
