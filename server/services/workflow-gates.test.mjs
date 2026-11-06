import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateCreativeWorkflowGates, createScriptFingerprint } from './workflow-gates.mjs'

const completeScenes = [
  { id: 1, title: '场景一', content: '完整剧本正文' },
  { id: 2, title: '场景二', content: '另一段剧本正文' },
]
const assets = [
  { nodeType: 'character', refId: 7, state: 'confirmed' },
  { nodeType: 'scene', refId: 1, state: 'confirmed' },
]

test('script gate stays locked until every scene has non-empty script content', () => {
  const gates = evaluateCreativeWorkflowGates({
    scenes: [{ ...completeScenes[0] }, { ...completeScenes[1], content: ' ' }],
    parsedFingerprint: createScriptFingerprint(completeScenes),
    requiredAssets: assets,
  })

  assert.equal(gates.assets.allowed, false)
  assert.equal(gates.assets.code, 'script_incomplete')
  assert.equal(gates.storyboard.allowed, false)
})

test('script edits invalidate an earlier successful parse fingerprint', () => {
  const gates = evaluateCreativeWorkflowGates({
    scenes: completeScenes,
    parsedFingerprint: createScriptFingerprint([{ ...completeScenes[0], content: '旧正文' }, completeScenes[1]]),
    requiredAssets: assets,
  })

  assert.equal(gates.assets.allowed, false)
  assert.equal(gates.assets.code, 'script_parse_stale')
})

test('empty asset requirements never unlock storyboard generation', () => {
  const fingerprint = createScriptFingerprint(completeScenes)
  const gates = evaluateCreativeWorkflowGates({
    scenes: completeScenes,
    parsedFingerprint: fingerprint,
    requiredAssets: [],
  })

  assert.equal(gates.assets.allowed, true)
  assert.equal(gates.storyboard.allowed, false)
  assert.equal(gates.storyboard.code, 'assets_missing')
})

test('storyboard remains locked until every required asset is confirmed', () => {
  const gates = evaluateCreativeWorkflowGates({
    scenes: completeScenes,
    parsedFingerprint: createScriptFingerprint(completeScenes),
    requiredAssets: [{ nodeType: 'character', refId: 7, state: 'confirmed' }, { nodeType: 'scene', refId: 1, state: 'ready' }],
  })

  assert.equal(gates.assets.allowed, true)
  assert.equal(gates.storyboard.allowed, false)
  assert.equal(gates.storyboard.pendingCount, 1)
})

test('tools and materials remain part of the required confirmation set', () => {
  const gates = evaluateCreativeWorkflowGates({
    scenes: completeScenes,
    parsedFingerprint: createScriptFingerprint(completeScenes),
    requiredAssets: [
      ...assets,
      { nodeType: 'tool', refId: 9, state: 'ready' },
    ],
  })

  assert.equal(gates.storyboard.allowed, false)
  assert.equal(gates.storyboard.pendingCount, 1)
})

test('storyboard unlocks only when the current parsed script and all assets are confirmed', () => {
  const gates = evaluateCreativeWorkflowGates({
    scenes: completeScenes,
    parsedFingerprint: createScriptFingerprint(completeScenes),
    requiredAssets: assets,
  })

  assert.equal(gates.assets.allowed, true)
  assert.equal(gates.storyboard.allowed, true)
})
