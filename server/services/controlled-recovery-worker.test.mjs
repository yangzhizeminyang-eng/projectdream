import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildControlledRecoveryWorkerEnv,
  evaluateControlledRecoveryBoundary,
  buildRecoveryQueueSnapshot,
  isQueuedRecoveryVideoJob,
  parseControlledRecoveryWorkerArgs,
} from './controlled-recovery-worker.mjs'

test('requires one positive job id and explicit apply for a controlled recovery worker', () => {
  assert.deepEqual(
    parseControlledRecoveryWorkerArgs(['--job-id=254', '--apply']),
    { jobId: 254, apply: true, dryRun: false },
  )
  assert.deepEqual(
    parseControlledRecoveryWorkerArgs(['--job-id=254', '--dry-run']),
    { jobId: 254, apply: false, dryRun: true },
  )
  assert.throws(
    () => parseControlledRecoveryWorkerArgs(['--job-id=254']),
    /--apply/,
  )
  assert.throws(
    () => parseControlledRecoveryWorkerArgs(['--job-id=254', '--apply', '--dry-run']),
    /mutually exclusive/,
  )
  assert.throws(
    () => parseControlledRecoveryWorkerArgs(['--job-id=0', '--apply']),
    /positive integer/,
  )
})

test('only recognizes queued video recovery jobs as runnable targets', () => {
  assert.equal(
    isQueuedRecoveryVideoJob({
      id: 254,
      status: 'queued',
      job_type: 'video_image',
      job_key: 'recover-video-project-12-storyboard-180-retry-3',
    }),
    true,
  )
  assert.equal(
    isQueuedRecoveryVideoJob({
      id: 254,
      status: 'queued',
      job_type: 'video_image',
      job_key: 'video-image-180-random',
    }),
    false,
  )
})

test('pins a controlled recovery worker to one job and one execution', () => {
  assert.deepEqual(
    buildControlledRecoveryWorkerEnv({ EXISTING_VALUE: 'kept' }, 254),
    {
      EXISTING_VALUE: 'kept',
      APP_RUNTIME_ROLE: 'worker',
      GENERATION_WORKER_CONCURRENCY: '1',
      GENERATION_WORKER_MAX_JOBS: '1',
      GENERATION_WORKER_ONLY_JOB_ID: '254',
    },
  )
})

test('summarizes the recovery queue around the pinned job for audit reports', () => {
  assert.deepEqual(
    buildRecoveryQueueSnapshot(
      [
        { id: 254, status: 'completed', job_key: 'recover-video-project-12-storyboard-179-retry-3' },
        { id: 256, status: 'queued', job_key: 'recover-video-project-12-storyboard-180-retry-3' },
        { id: 257, status: 'queued', job_key: 'recover-video-project-12-storyboard-181-retry-3' },
        { id: 258, status: 'running', job_key: 'recover-video-project-12-storyboard-182-retry-3' },
        { id: 259, status: 'failed', job_key: 'recover-video-project-12-storyboard-183-retry-3' },
      ],
      256,
    ),
    {
      targetJobId: 256,
      totalRecoveryJobs: 5,
      activeRecoveryJobs: 3,
      queuedRecoveryJobs: 2,
      runningRecoveryJobs: 1,
      neighborActiveJobIds: [257, 258],
      targetPresent: true,
      targetStatus: 'queued',
      onlyTargetWillRun: true,
    },
  )
})

test('accepts a queue transition when only the pinned job changes status', () => {
  assert.deepEqual(
    evaluateControlledRecoveryBoundary(
      [
        { id: 256, status: 'queued', job_key: 'recover-video-project-12-storyboard-180-retry-3' },
        { id: 257, status: 'queued', job_key: 'recover-video-project-12-storyboard-181-retry-3' },
      ],
      [
        { id: 256, status: 'completed', job_key: 'recover-video-project-12-storyboard-180-retry-3' },
        { id: 257, status: 'queued', job_key: 'recover-video-project-12-storyboard-181-retry-3' },
      ],
      256,
    ),
    {
      boundarySafe: true,
      targetStatusBefore: 'queued',
      targetStatusAfter: 'completed',
      targetStatusChanged: true,
      changedNeighborJobIds: [],
      addedNeighborJobIds: [],
      removedNeighborJobIds: [],
      violationCodes: [],
    },
  )
})

test('flags any neighbor queue change as a controlled-worker boundary violation', () => {
  const result = evaluateControlledRecoveryBoundary(
    [
      { id: 256, status: 'queued', job_key: 'recover-video-project-12-storyboard-180-retry-3' },
      { id: 257, status: 'queued', job_key: 'recover-video-project-12-storyboard-181-retry-3' },
    ],
    [
      { id: 256, status: 'completed', job_key: 'recover-video-project-12-storyboard-180-retry-3' },
      { id: 257, status: 'running', job_key: 'recover-video-project-12-storyboard-181-retry-3' },
      { id: 258, status: 'queued', job_key: 'recover-video-project-12-storyboard-182-retry-3' },
    ],
    256,
  )

  assert.equal(result.boundarySafe, false)
  assert.deepEqual(result.changedNeighborJobIds, [257])
  assert.deepEqual(result.addedNeighborJobIds, [258])
  assert.deepEqual(result.removedNeighborJobIds, [])
  assert.deepEqual(result.violationCodes, [
    'neighbor-status-changed',
    'neighbor-job-added',
  ])
})
