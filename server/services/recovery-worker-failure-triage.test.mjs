import assert from 'node:assert/strict'
import test from 'node:test'

import {
  auditRecoverySourceInput,
  buildRecoveryFailureTriageReport,
  classifyRecoveryWorkerFailure,
} from './recovery-worker-failure-triage.mjs'

test('classifies a provider upload timeout as a retryable network failure', () => {
  assert.deepEqual(
    classifyRecoveryWorkerFailure({
      status: 'failed',
      attemptCount: 1,
      maxAttempts: 3,
      lastErrorCode: 'GENERATION_PROVIDER_ERROR',
      errorText: 'Video source image upload failed: ToAPI request failed (fetch failed, UND_ERR_CONNECT_TIMEOUT)',
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      sourceProbe: { readable: true, contentType: 'image/png', size: 1024 },
    }),
    {
      category: 'provider-network-timeout',
      retryable: true,
      nextAction: 'verify-provider-network-then-single-retry',
      sourceReady: true,
      attemptsRemaining: 2,
    },
  )
})

test('blocks retry when the recovery task has exhausted its attempts', () => {
  assert.deepEqual(
    classifyRecoveryWorkerFailure({
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 3,
      lastErrorCode: 'GENERATION_PROVIDER_ERROR',
      errorText: 'provider timeout',
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      sourceProbe: { readable: true, contentType: 'image/png', size: 1024 },
    }),
    {
      category: 'retry-exhausted',
      retryable: false,
      nextAction: 'manual-review-before-new-job',
      sourceReady: true,
      attemptsRemaining: 0,
    },
  )
})

test('blocks retry when the COS source image is unreadable', () => {
  assert.deepEqual(
    classifyRecoveryWorkerFailure({
      status: 'failed',
      attemptCount: 1,
      maxAttempts: 3,
      lastErrorCode: 'GENERATION_PROVIDER_ERROR',
      errorText: 'Video source image upload failed',
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      sourceProbe: { readable: false, error: 'object-not-found' },
    }),
    {
      category: 'source-image-blocked',
      retryable: false,
      nextAction: 'repair-or-replicate-source-image',
      sourceReady: false,
      attemptsRemaining: 2,
    },
  )
})

test('summarizes failure categories without changing database state', () => {
  const report = buildRecoveryFailureTriageReport([
    {
      id: 257,
      projectId: 12,
      status: 'failed',
      attemptCount: 1,
      maxAttempts: 3,
      lastErrorCode: 'GENERATION_PROVIDER_ERROR',
      errorText: 'UND_ERR_CONNECT_TIMEOUT',
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      sourceProbe: { readable: true, contentType: 'image/png', size: 1024 },
    },
    {
      id: 258,
      projectId: 12,
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 3,
      lastErrorCode: 'GENERATION_PROVIDER_ERROR',
      errorText: 'provider timeout',
      imageStorageKey: 'projects/12/frames/storyboards/188/v1/c179.png',
      sourceProbe: { readable: true, contentType: 'image/png', size: 1024 },
    },
  ])

  assert.deepEqual(report.summary, {
    total: 2,
    retryable: 1,
    blocked: 1,
    categories: {
      'provider-network-timeout': 1,
      'retry-exhausted': 1,
    },
  })
  assert.deepEqual(report.recommendedJobIds, [257])
})

test('audits a COS signed URL without exposing its signature', () => {
  assert.deepEqual(
    auditRecoverySourceInput({
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      sourceProbe: { readable: true, contentType: 'image/png', size: 1024 },
      signedUrl: 'https://bucket.cos.ap-guangzhou.myqcloud.com/projects/12/frames/a.png?q-sign-algorithm=redacted',
    }),
    {
      keyPresent: true,
      signedUrlGenerated: true,
      protocol: 'https:',
      hostname: 'bucket.cos.ap-guangzhou.myqcloud.com',
      hasQuery: true,
      providerInputReady: true,
    },
  )
})

test('classifies an unreadable provider input path separately from a missing source object', () => {
  assert.deepEqual(
    classifyRecoveryWorkerFailure({
      status: 'failed',
      attemptCount: 1,
      maxAttempts: 3,
      lastErrorCode: 'GENERATION_PROVIDER_ERROR',
      errorText: 'provider rejected image input',
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      sourceProbe: {
        readable: true,
        contentType: 'image/png',
        size: 1024,
        providerInputReady: false,
      },
    }),
    {
      category: 'provider-input-blocked',
      retryable: false,
      nextAction: 'repair-signed-source-url',
      sourceReady: true,
      attemptsRemaining: 2,
    },
  )
})
