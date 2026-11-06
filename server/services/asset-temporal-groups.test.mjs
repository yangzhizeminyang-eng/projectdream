import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPropAssetGroupKey,
  buildTemporalAssetGroupKey,
  buildTemporalAssetGroups,
  normalizeAssetGroupKey,
  resolveTemporalState,
} from './asset-temporal-groups.mjs'

test('keeps generated asset group keys bounded and deterministic', () => {
  const raw = `prop:agent:4:${'非常长的道具名称'.repeat(80)}`
  const first = normalizeAssetGroupKey(raw)
  assert.equal(first, normalizeAssetGroupKey(raw))
  assert.ok(first.length <= 240)
  assert.match(first, /-[0-9a-f]{12}$/)
  assert.equal(buildPropAssetGroupKey({ projectId: 4, name: '手机' }), 'prop:agent:4:手机')
})

test('normalizes temporal labels and group keys for persistence and canvas DTOs', () => {
  assert.deepEqual(resolveTemporalState('五年前的学生时期；校服'), {
    key: 'past-5-years',
    label: '五年前的学生时期',
  })
  assert.equal(
    buildTemporalAssetGroupKey({
      nodeType: 'character',
      refId: 7,
      promptText: '五年前的学生时期；校服',
    }),
    'character:7:past-5-years',
  )
})

test('groups character nodes by agent-provided temporal state instead of a manual label', () => {
  const groups = buildTemporalAssetGroups([
    { id: 1, nodeType: 'character', refId: 7, label: '唐宁', promptText: '当前职场状态；浅蓝衬衫' },
    { id: 2, nodeType: 'character', refId: 7, label: '唐宁', promptText: '五年前的学生时期；校服' },
  ])

  assert.deepEqual(groups.map((group) => group.key), ['character:7:current', 'character:7:past-5-years'])
  assert.equal(groups[0].label, '唐宁 · 当前职场状态')
  assert.equal(groups[1].label, '唐宁 · 五年前的学生时期')
})

test('groups scene nodes by the same temporal-space identity', () => {
  const groups = buildTemporalAssetGroups([
    { id: 10, nodeType: 'scene', refId: 20, label: '合规办公室', promptText: '现在，白天，办公室' },
    { id: 11, nodeType: 'scene', refId: 20, label: '合规办公室', promptText: '五年前，夜晚，旧办公室' },
  ])

  assert.equal(groups.length, 2)
  assert.match(groups[0].label, /合规办公室/)
  assert.match(groups[1].label, /五年前/)
})

test('does not derive an asset state from a historical fact in the full prompt', () => {
  const prompt = [
    '剧本出场场景：邮件提到父亲五年前的事故。',
    '本资产时空状态：当前状态',
  ].join('\n')

  assert.deepEqual(resolveTemporalState(prompt), {
    key: 'current',
    label: '当前状态',
  })
  assert.equal(
    buildTemporalAssetGroupKey({ nodeType: 'character', refId: 7, promptText: prompt }),
    'character:7:current',
  )
})
