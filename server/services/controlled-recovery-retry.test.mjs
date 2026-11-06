import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTROLLED_RECOVERY_RETRY_CONFIRMATION,
  buildControlledRecoveryRetryJobKey,
  buildControlledRecoveryRetryRequest,
  planControlledRecoveryRetry,
} from './controlled-recovery-retry.mjs'

const failedJob = {
  id: 257,
  project_id: 12,
  source_id: 186,
  status: 'failed',
  job_type: 'video_image',
  job_key: 'recover-video-project-12-storyboard-186-retry-3',
  attempt_count: 1,
  max_attempts: 3,
  request_json: JSON.stringify({
    projectId: 12,
    storyboardId: 186,
    imageAssetId: 178,
    imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
    imageUrl: 'https://example.invalid/source.png',
    promptSnapshot: '保持人物外貌和服装一致。',
    modelName: 'agnes-video-v2.0',
    autoConfirm: false,
  }),
}

test('plans exactly one controlled retry without mutating the failed source job', () => {
  const plan = planControlledRecoveryRetry({
    job: failedJob,
    triage: {
      category: 'provider-network-timeout',
      retryable: true,
      sourceReady: true,
      attemptsRemaining: 2,
    },
    existingRetries: [],
    confirmed: true,
  })

  assert.deepEqual(plan, {
    action: 'queue',
    originalJobId: 257,
    projectId: 12,
    storyboardId: 186,
    retryIndex: 1,
    jobKey: buildControlledRecoveryRetryJobKey({
      originalJobId: 257,
      projectId: 12,
      storyboardId: 186,
    }),
    maxAttempts: 1,
    confirmation: CONTROLLED_RECOVERY_RETRY_CONFIRMATION,
  })
})

test('requires the exact confirmation before planning a controlled retry', () => {
  const plan = planControlledRecoveryRetry({
    job: failedJob,
    triage: {
      category: 'provider-network-timeout',
      retryable: true,
      sourceReady: true,
      attemptsRemaining: 2,
    },
    existingRetries: [],
    confirmed: false,
  })

  assert.deepEqual(plan, {
    action: 'blocked',
    reason: 'confirmation-required',
  })
})

test('does not create a duplicate controlled retry when one already exists', () => {
  const plan = planControlledRecoveryRetry({
    job: failedJob,
    triage: {
      category: 'provider-network-timeout',
      retryable: true,
      sourceReady: true,
      attemptsRemaining: 2,
    },
    existingRetries: [{ id: 300, status: 'queued' }],
    confirmed: true,
  })

  assert.deepEqual(plan, {
    action: 'skip',
    reason: 'controlled-retry-already-exists',
  })
})

test('blocks a retry when source readiness or failure classification is unsafe', () => {
  assert.deepEqual(
    planControlledRecoveryRetry({
      job: failedJob,
      triage: {
        category: 'source-image-blocked',
        retryable: false,
        sourceReady: false,
        attemptsRemaining: 2,
      },
      existingRetries: [],
      confirmed: true,
    }),
    {
      action: 'blocked',
      reason: 'triage-not-retryable',
    },
  )
})

test('copies the request snapshot and records the original failed job', () => {
  assert.deepEqual(
    buildControlledRecoveryRetryRequest(
      JSON.parse(failedJob.request_json),
      { originalJobId: 257, originalJobKey: failedJob.job_key },
    ),
    {
      projectId: 12,
      storyboardId: 186,
      imageAssetId: 178,
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      imageUrl: 'https://example.invalid/source.png',
      promptSnapshot: '保持人物外貌和服装一致。',
      modelName: 'agnes-video-v2.0',
      autoConfirm: false,
      controlledRetry: {
        mode: 'single',
        originalJobId: 257,
        originalJobKey: 'recover-video-project-12-storyboard-186-retry-3',
      },
    },
  )
})
