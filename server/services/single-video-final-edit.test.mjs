import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSingleVideoFinalEditConfig,
  buildCompletedSingleVideoFinalEditConfig,
  buildSingleVideoFinalEditIdempotencyKey,
  buildSingleVideoFinalEditRollbackPatch,
  isSingleVideoFinalEditExport,
  normalizeSingleVideoFinalEditConfirmation,
  normalizeSingleVideoFinalEditRollbackConfirmation,
} from './single-video-final-edit.mjs'

test('builds a single-video vertical final-edit config with rollback metadata', () => {
  const config = buildSingleVideoFinalEditConfig({
    projectId: 12,
    videoId: 197,
    storyboardId: 186,
    sceneId: 883,
    previousConfirmedVideoAssetId: 69,
    previousStoryboardVideoUrl: 'https://example.test/old.mp4',
  })

  assert.equal(config.pipeline, 'single-video-final-edit-v1')
  assert.equal(config.resolution, '1080x1920')
  assert.equal(config.frameRate, 24)
  assert.equal(config.speechSyncOffsetSeconds, 0)
  assert.equal(config.singleVideoFinalEdit.videoId, 197)
  assert.equal(config.singleVideoFinalEdit.idempotencyKey, 'single-video-final-edit-video-197')
  assert.equal(config.singleVideoFinalEdit.rollback.reversible, true)
  assert.equal(isSingleVideoFinalEditExport({ config_json: JSON.stringify(config) }), true)
})

test('keeps lip-sync candidates source-locked without delaying ordinary video candidates', () => {
  const lipSyncConfig = buildSingleVideoFinalEditConfig({
    projectId: 12,
    videoId: 198,
    storyboardId: 186,
    sourceType: 'lip_sync',
  })
  const ordinaryConfig = buildSingleVideoFinalEditConfig({
    projectId: 12,
    videoId: 197,
    storyboardId: 186,
    sourceType: 'generated_video',
  })

  assert.equal(lipSyncConfig.speechSyncOffsetSeconds, 0)
  assert.equal(lipSyncConfig.singleVideoFinalEdit.sourceType, 'lip_sync')
  assert.equal(ordinaryConfig.speechSyncOffsetSeconds, 0)
  assert.equal(ordinaryConfig.singleVideoFinalEdit.sourceType, 'generated_video')
})

test('allows an explicit single-video lip-sync calibration override', () => {
  const config = buildSingleVideoFinalEditConfig({
    projectId: 12,
    videoId: 198,
    storyboardId: 186,
    sourceType: 'lip_sync',
    speechSyncOffsetSeconds: 0.18,
  })

  assert.equal(config.speechSyncOffsetSeconds, 0.18)
})

test('requires exact execution and rollback confirmation tokens', () => {
  assert.equal(
    normalizeSingleVideoFinalEditConfirmation({
      confirm: true,
      confirmationToken: 'START_SINGLE_VIDEO_FINAL_EDIT',
    }),
    true,
  )
  assert.equal(
    normalizeSingleVideoFinalEditRollbackConfirmation({
      confirm: true,
      confirmationToken: 'ROLLBACK_SINGLE_VIDEO_FINAL_EDIT',
    }),
    true,
  )
  assert.throws(
    () => normalizeSingleVideoFinalEditConfirmation({ confirm: true }),
    /明确确认/,
  )
  assert.throws(
    () => normalizeSingleVideoFinalEditRollbackConfirmation({ confirm: true }),
    /回滚需要明确确认/,
  )
})

test('builds a non-destructive rollback patch for a single-video export', () => {
  const config = buildSingleVideoFinalEditConfig({
    projectId: 12,
    videoId: 197,
    storyboardId: 186,
  })
  const patch = buildSingleVideoFinalEditRollbackPatch(config)

  assert.equal(patch.pipeline, 'single-video-final-edit-v1')
  assert.equal(patch.singleVideoFinalEdit.rollback.reversible, false)
  assert.equal(patch.singleVideoFinalEdit.rollback.strategy, 'preserve-source-candidate')
  assert.equal(buildSingleVideoFinalEditIdempotencyKey(197), 'single-video-final-edit-video-197')
})

test('preserves the single-video pipeline when a completed export receives result metadata', () => {
  const config = buildSingleVideoFinalEditConfig({
    projectId: 12,
    videoId: 197,
    storyboardId: 186,
  })

  const completed = buildCompletedSingleVideoFinalEditConfig(config, {
    sourceClipCount: 1,
    realVideoCount: 1,
    technicalQuality: { status: 'passed' },
  })

  assert.equal(completed.pipeline, 'single-video-final-edit-v1')
  assert.equal(completed.sourceClipCount, 1)
  assert.equal(completed.technicalQuality.status, 'passed')
})
