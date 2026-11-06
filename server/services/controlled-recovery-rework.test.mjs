import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildControlledRecoveryReworkJobKey,
  buildControlledRecoveryReworkRequest,
  planControlledRecoveryRework,
} from './controlled-recovery-rework.mjs'

const baseVideo = {
  id: 195,
  project_id: 12,
  storyboard_id: 186,
  status: 'candidate',
  recovery_review_decision: 'rework',
}

const baseJob = {
  id: 270,
  status: 'success',
  job_type: 'video_image',
  job_key: 'recover-video-controlled-retry-original-257-project-12-storyboard-186-retry-1',
}

test('builds a stable single rework generation job key', () => {
  assert.equal(
    buildControlledRecoveryReworkJobKey({
      sourceVideoId: 195,
      projectId: 12,
      storyboardId: 186,
    }),
    'recover-video-controlled-rework-video-195-project-12-storyboard-186-attempt-1',
  )
})

test('builds a single-candidate rework request without reusing provider tasks', () => {
  const request = buildControlledRecoveryReworkRequest({
    sourceRequest: {
      projectId: 12,
      storyboardId: 186,
      imageStorageKey: 'projects/12/frames/storyboards/186/v1/c178.png',
      candidateCount: 3,
      providerTasks: [{ videoId: 'stale-provider-task' }],
    },
    sourceVideoId: 195,
    sourceJobId: 270,
    sourceJobKey: baseJob.job_key,
    reviewNote: '重新生成候选后再复核。',
    versionNo: 3,
  })

  assert.equal(request.candidateCount, 1)
  assert.deepEqual(request.providerTasks, [])
  assert.equal(request.autoConfirm, false)
  assert.deepEqual(request.controlledRework, {
    mode: 'single',
    sourceVideoId: 195,
    sourceJobId: 270,
    sourceJobKey: baseJob.job_key,
    reviewNote: '重新生成候选后再复核。',
  })
})

test('queues only a confirmed rework candidate when the source image is readable', () => {
  const plan = planControlledRecoveryRework({
    video: baseVideo,
    sourceJob: baseJob,
    sourceImageReadable: true,
    confirmed: true,
  })

  assert.equal(plan.action, 'queue')
  assert.equal(plan.sourceVideoId, 195)
  assert.equal(plan.maxAttempts, 1)
  assert.equal(plan.confirmation, 'CONFIRM_RECOVERY_REWORK_SINGLE_GENERATION')
})

test('blocks non-rework candidates and existing active rework tasks', () => {
  assert.equal(
    planControlledRecoveryRework({
      video: { ...baseVideo, recovery_review_decision: 'approved' },
      sourceJob: baseJob,
      sourceImageReadable: true,
      confirmed: true,
    }).reason,
    'source-video-not-a-rework-candidate',
  )
  assert.equal(
    planControlledRecoveryRework({
      video: baseVideo,
      sourceJob: baseJob,
      existingJobs: [{ status: 'queued' }],
      sourceImageReadable: true,
      confirmed: true,
    }).reason,
    'controlled-rework-already-exists',
  )
})
