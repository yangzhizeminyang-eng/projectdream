import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enforceAssetContentVision,
  enforceEmptySceneVision,
  isSceneVisionCheckEnabled,
  shouldStopAssetRetry,
} from './scene-vision-policy.mjs'

test('scene generation uses prompt and panorama constraints without a vision gate', () => {
  assert.equal(isSceneVisionCheckEnabled(), false)
})

test('scene vision rejects a passed result that describes a visible person', () => {
  const result = enforceEmptySceneVision({ passed: true, reason: '空间布局正确，但右侧有一名黑衣男性坐着' })
  assert.equal(result.passed, false)
  assert.match(result.reason, /人物污染/)
})

test('scene vision keeps a passed result whose reason explicitly says there is no person', () => {
  const result = enforceEmptySceneVision({ passed: true, reason: '空间布局正确，画面中没有人物和人影' })
  assert.equal(result.passed, true)
})

test('asset vision rejects a passed result that describes a provider watermark', () => {
  const result = enforceAssetContentVision({
    passed: true,
    reason: '场景结构正确，但右下角存在AI生成水印',
  }, { nodeType: 'scene', scene: true })
  assert.equal(result.passed, false)
  assert.match(result.reason, /水印/)
})

test('asset vision rejects readable prop screen text but keeps an explicitly blank screen', () => {
  const withText = enforceAssetContentVision({
    passed: true,
    reason: '道具完整，屏幕上出现了清晰的中文文字和按钮标签',
  }, { nodeType: 'prop' })
  assert.equal(withText.passed, false)
  assert.match(withText.reason, /文字/)

  const blank = enforceAssetContentVision({
    passed: true,
    reason: '道具完整，屏幕为无文字的暗色空白界面，没有水印',
  }, { nodeType: 'prop' })
  assert.equal(blank.passed, true)
})

test('prop vision allows an explicitly narrative label but still rejects random text', () => {
  const narrativeLabel = enforceAssetContentVision({
    passed: true,
    reason: '道具完整，剧情指定标签“2019-事故档案”清晰可见，没有乱码或水印',
  }, { nodeType: 'prop' })
  assert.equal(narrativeLabel.passed, true)

  const randomText = enforceAssetContentVision({
    passed: true,
    reason: '道具完整，但出现随机文字和数字乱码',
  }, { nodeType: 'prop' })
  assert.equal(randomText.passed, false)
})

test('asset retries stop immediately for deterministic content failures', () => {
  assert.equal(shouldStopAssetRetry({ contentIssue: 'watermark' }), true)
  assert.equal(shouldStopAssetRetry({ contentIssue: 'readable-text' }), true)
  assert.equal(shouldStopAssetRetry({ reason: '透视关系不正确' }), false)
})
