import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCompletedRecoveryFinalEditConfig,
  buildFinalEditRenderConfig,
  buildRecoveryFinalEditIdempotencyKey,
  buildRecoveryFinalEditExecutionConfig,
  buildRecoveryFinalEditRollbackPatch,
  isDuplicateKeyError,
  normalizeRecoveryFinalEditConfirmation,
  normalizeRecoveryFinalEditRollbackConfirmation,
  isRecoveryFinalEditExport,
  shouldReuseRecoveryFinalEditExport,
} from './recovery-video-final-edit-execution.mjs'

test('requires an exact explicit confirmation token before executing a final edit', () => {
  assert.equal(
    normalizeRecoveryFinalEditConfirmation({
      confirm: true,
      confirmationToken: 'START_RECOVERY_FINAL_EDIT',
    }),
    true,
  )
  assert.throws(
    () => normalizeRecoveryFinalEditConfirmation({ confirm: true }),
    /明确确认/,
  )
  assert.throws(
    () => normalizeRecoveryFinalEditConfirmation({
      confirm: true,
      confirmationToken: 'start_recovery_final_edit',
    }),
    /明确确认/,
  )
})

test('requires an exact explicit confirmation token before rolling back a final edit', () => {
  assert.equal(
    normalizeRecoveryFinalEditRollbackConfirmation({
      confirm: true,
      confirmationToken: 'ROLLBACK_RECOVERY_FINAL_EDIT',
    }),
    true,
  )
  assert.throws(
    () => normalizeRecoveryFinalEditRollbackConfirmation({ confirm: true }),
    /回滚确认/,
  )
  assert.throws(
    () => normalizeRecoveryFinalEditRollbackConfirmation({
      confirm: true,
      confirmationToken: 'rollback_recovery_final_edit',
    }),
    /回滚确认/,
  )
})

test('builds a single-candidate final edit config with a rollback snapshot', () => {
  const config = buildRecoveryFinalEditExecutionConfig({
    videoId: 194,
    storyboardId: 180,
    sceneId: 901,
    planId: 'recovery-final-edit-video-194',
    previousStoryboardVideoUrl: 'https://example.com/original.mp4',
    previousConfirmedVideoAssetId: 177,
  })

  assert.deepEqual(config.recoveryFinalEdit, {
    version: 1,
    videoId: 194,
    storyboardId: 180,
    sceneId: 901,
    planId: 'recovery-final-edit-video-194',
    idempotencyKey: 'recovery-final-edit-video-194',
    sourceMode: 'single-recovery-candidate',
    rollback: {
      reversible: true,
      strategy: 'preserve-source-candidate',
      previousStoryboardVideoUrl: 'https://example.com/original.mp4',
      previousConfirmedVideoAssetId: 177,
    },
  })
  assert.equal(config.pipeline, 'recovery-final-edit-v1')
  assert.equal(config.executionMode, 'manual-confirmed-single')
  assert.equal(config.burnSubtitle, true)
  assert.equal(config.resolution, '1080x1920')
  assert.equal(config.frameRate, 24)
})

test('reuses an existing export for the same final edit plan without creating another task', () => {
  const config = buildRecoveryFinalEditExecutionConfig({
    videoId: 194,
    storyboardId: 180,
    planId: 'recovery-final-edit-video-194',
  })

  assert.equal(
    shouldReuseRecoveryFinalEditExport(
      { status: 'queued', config_json: JSON.stringify(config) },
      config.recoveryFinalEdit.planId,
    ),
    true,
  )
  assert.equal(
    shouldReuseRecoveryFinalEditExport(
      { status: 'completed', config_json: JSON.stringify(config) },
      config.recoveryFinalEdit.planId,
    ),
    true,
  )
  assert.equal(
    shouldReuseRecoveryFinalEditExport(
      { status: 'failed', config_json: JSON.stringify(config) },
      config.recoveryFinalEdit.planId,
    ),
    false,
  )
})

test('keeps a completed recovery final edit export recognizable and rollback-ready', () => {
  const queuedConfig = buildRecoveryFinalEditExecutionConfig({
    videoId: 194,
    storyboardId: 180,
    planId: 'recovery-final-edit-video-194',
  })

  const completedConfig = buildCompletedRecoveryFinalEditConfig(queuedConfig, {
    sourceClipCount: 1,
    realVideoCount: 1,
    subtitleStorageKey: 'projects/12/exports/99/subtitles.srt',
  })

  assert.equal(completedConfig.pipeline, 'recovery-final-edit-v1')
  assert.equal(completedConfig.sourceClipCount, 1)
  assert.equal(completedConfig.recoveryFinalEdit.planId, 'recovery-final-edit-video-194')
  assert.equal(isRecoveryFinalEditExport({ config_json: JSON.stringify(completedConfig) }), true)
  assert.doesNotThrow(() => buildRecoveryFinalEditRollbackPatch(completedConfig))
})

test('recovers the recovery-final-edit marker if a generic pipeline overwrote it', () => {
  const queuedConfig = buildRecoveryFinalEditExecutionConfig({
    videoId: 193,
    storyboardId: 180,
    planId: 'recovery-final-edit-video-193',
  })
  const corruptedConfig = {
    ...queuedConfig,
    pipeline: 'hybrid-mvp',
    sourceClipCount: 57,
    realVideoCount: 6,
  }

  assert.equal(isRecoveryFinalEditExport({ config_json: JSON.stringify(corruptedConfig) }), true)

  const repairedConfig = buildCompletedRecoveryFinalEditConfig(corruptedConfig, {
    sourceClipCount: 1,
    realVideoCount: 1,
  })
  assert.equal(repairedConfig.pipeline, 'recovery-final-edit-v1')
  assert.equal(repairedConfig.sourceClipCount, 1)
  assert.doesNotThrow(() => buildRecoveryFinalEditRollbackPatch(corruptedConfig))
})

test('builds a stable database idempotency key for one recovery final edit plan', () => {
  assert.equal(
    buildRecoveryFinalEditIdempotencyKey({
      videoId: 194,
      planId: 'recovery-final-edit-video-194',
    }),
    'recovery-final-edit-video-194',
  )
  assert.throws(
    () => buildRecoveryFinalEditIdempotencyKey({
      videoId: 194,
      planId: 'recovery-final-edit-video-195',
    }),
    /幂等键/,
  )
})

test('recognizes a database duplicate-key error for concurrent confirmation recovery', () => {
  assert.equal(isDuplicateKeyError({ errno: 1062 }), true)
  assert.equal(isDuplicateKeyError({ code: 'ER_DUP_ENTRY' }), true)
  assert.equal(isDuplicateKeyError({ code: 'ER_LOCK_DEADLOCK' }), false)
})

test('uses the freshly rebuilt recovery draft when rendering instead of stale persisted cues', () => {
  const persistedConfig = {
    pipeline: 'recovery-final-edit-v1',
    finalEditDraft: {
      subtitleCues: [
        {
          cueId: 'stale',
          storyboardId: 186,
          startOffsetSeconds: 0,
          durationSeconds: 5,
          text: '林夏：……妈？苏岚（广播）：五。',
        },
      ],
      audioMix: {
        dialogue: { enabled: true, volume: 100 },
      },
    },
  }
  const rebuiltDraft = {
    subtitleCues: [
      {
        cueId: 'audio-170',
        storyboardId: 186,
        startOffsetSeconds: 0,
        durationSeconds: 0.56,
        text: '林夏：……妈？',
      },
      {
        cueId: 'audio-171',
        storyboardId: 186,
        startOffsetSeconds: 1.1,
        durationSeconds: 0.56,
        text: '苏岚（广播）：五。',
      },
    ],
    audioMix: {
      dialogue: { enabled: true, volume: 100 },
      narration: { enabled: true, volume: 100 },
    },
  }

  const renderConfig = buildFinalEditRenderConfig(persistedConfig, rebuiltDraft)

  assert.deepEqual(renderConfig.finalEditDraft, rebuiltDraft)
  assert.equal(renderConfig.pipeline, 'recovery-final-edit-v1')
})
