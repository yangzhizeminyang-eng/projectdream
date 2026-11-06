import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStoryboardContinuityPrompt,
  buildStoryboardFrameReference,
  resolveContinuitySourceShotNo,
  shouldUseStoryboardContinuity,
} from './storyboard-continuity.mjs'

test('continuity selection resolves a previous confirmed video tail frame as the next start frame', () => {
  const reference = buildStoryboardFrameReference({
    continuityEnabled: true,
    previousShot: { id: 17, shot_no: '02' },
    previousVideo: {
      end_frame_url: 'https://cdn.test/shot-02-tail.jpg',
      end_frame_storage_key: 'projects/1/videos/storyboards/17/v1/c1-end.jpg',
    },
    currentShot: { end_image_url: 'https://cdn.test/shot-03-end.jpg' },
  })

  assert.equal(reference.enabled, true)
  assert.equal(reference.sourceShotNo, '02')
  assert.equal(reference.startFrameUrl, 'https://cdn.test/shot-02-tail.jpg')
  assert.equal(reference.startFrameStorageKey, 'projects/1/videos/storyboards/17/v1/c1-end.jpg')
  assert.match(buildStoryboardContinuityPrompt(reference), /本镜首帧必须直接使用上一镜确认尾帧/)
})

test('continuity is not silently enabled without an explicit tool or transition marker', () => {
  assert.equal(shouldUseStoryboardContinuity({ prompt: '唐宁拿起手机。' }), false)
  assert.equal(shouldUseStoryboardContinuity({ tools: ['首尾帧参考'] }), true)
  assert.equal(shouldUseStoryboardContinuity({ prompt: '动作承接 @片段衔接' }), true)
})

test('continuity honors an explicitly selected source shot', () => {
  assert.equal(resolveContinuitySourceShotNo({ prompt: '@片段衔接[镜头07]' }), '07')
  assert.equal(resolveContinuitySourceShotNo({ prompt: '@片段衔接(镜头03)' }), '03')
})

test('selected continuity without a usable previous tail reports a blocking condition', () => {
  const reference = buildStoryboardFrameReference({ continuityEnabled: true, previousShot: { id: 1 } })
  assert.equal(reference.enabled, false)
  assert.equal(reference.missingStartFrame, true)
  assert.match(buildStoryboardContinuityPrompt(reference), /必须先补齐上一镜尾帧/)
})
