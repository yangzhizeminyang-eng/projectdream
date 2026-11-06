import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
const functionStart = serverSource.indexOf('async function prepareVideoReferenceImages')
const functionEnd = serverSource.indexOf('async function processCharacterImageGenerationJob', functionStart)
const functionSource = serverSource.slice(functionStart, functionEnd)
const enqueueVideoStart = serverSource.indexOf('async function enqueueStoryboardVideoJob')
const enqueueVideoEnd = serverSource.indexOf('async function buildFramePromptRewriteContext', enqueueVideoStart)
const enqueueVideoSource = serverSource.slice(enqueueVideoStart, enqueueVideoEnd)

test('video references prefer the public storage proxy when storage keys are available', () => {
  assert.notEqual(functionStart, -1)
  assert.notEqual(functionEnd, -1)
  assert.match(functionSource, /if \(canUsePublicStorageProxy\) \{[\s\S]+\/storage\//)
  assert.match(functionSource, /if \(storageKeys\.length\) return \[\.\.\.new Set\(uploaded\)\]/)
})

test('raw object-storage URLs are only used when no storage keys are available', () => {
  const fallbackIndex = functionSource.indexOf('const fallbackUrls')
  const storageReturnIndex = functionSource.indexOf('if (storageKeys.length) return')
  assert.ok(storageReturnIndex >= 0 && storageReturnIndex < fallbackIndex)
  assert.match(functionSource, /return \[\.\.\.new Set\(fallbackUrls\)\]/)
})

test('video reference storage keys prioritize locked assets before continuity frames', () => {
  const assetIndex = enqueueVideoSource.indexOf('characterBaseRows.map((asset) => asset.storage_key)')
  const transitionIndex = enqueueVideoSource.indexOf('frameReference.startFrameStorageKey')
  assert.ok(assetIndex >= 0, '未找到角色基础资产参考键')
  assert.ok(transitionIndex > assetIndex, '片段衔接帧不能排在锁定资产之前')
})
