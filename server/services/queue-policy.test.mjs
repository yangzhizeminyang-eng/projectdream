import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDueExportJobsQuery,
  buildRecoverRunningGenerationJobsQuery,
  buildDueGenerationJobsQuery,
  decideGenerationJobFailure,
  resolveGenerationQueueConfig,
  selectReusableGenerationJob,
  shouldContinueExportJobAfterClaim,
  shouldRunGenerationJobs,
  shouldRunExportJobs,
} from './queue-policy.mjs'

test('uses conservative generation worker defaults and normalizes invalid environment values', () => {
  assert.deepEqual(
    resolveGenerationQueueConfig({
      GENERATION_WORKER_CONCURRENCY: '0',
      GENERATION_JOB_MAX_ATTEMPTS: '-2',
      GENERATION_RETRY_BASE_DELAY_MS: 'invalid',
      GENERATION_RETRY_MAX_DELAY_MS: '2000',
    }),
    {
      workerConcurrency: 2,
      defaultMaxAttempts: 3,
      retryBaseDelayMs: 5000,
      retryMaxDelayMs: 5000,
      workerMaxJobs: null,
      workerOnlyJobId: null,
      workerOnlyExportId: null,
    },
  )
})

test('reads an optional maximum job count for a bounded worker validation run', () => {
  assert.equal(
    resolveGenerationQueueConfig({
      GENERATION_WORKER_CONCURRENCY: '2',
      GENERATION_WORKER_MAX_JOBS: '1',
    }).workerMaxJobs,
    1,
  )
})

test('reads an optional worker target job id for a controlled validation run', () => {
  assert.equal(
    resolveGenerationQueueConfig({
      GENERATION_WORKER_ONLY_JOB_ID: '254',
    }).workerOnlyJobId,
    254,
  )
  assert.equal(
    resolveGenerationQueueConfig({
      GENERATION_WORKER_ONLY_JOB_ID: 'not-a-job',
    }).workerOnlyJobId,
    null,
  )
})

test('reads an optional worker target export id for a controlled final-edit run', () => {
  assert.equal(
    resolveGenerationQueueConfig({
      EXPORT_WORKER_ONLY_EXPORT_ID: '31',
    }).workerOnlyExportId,
    31,
  )
  assert.equal(
    resolveGenerationQueueConfig({
      EXPORT_WORKER_ONLY_EXPORT_ID: 'invalid',
    }).workerOnlyExportId,
    null,
  )
})

test('does not reuse a primary frame job when the requested frame role is end', () => {
  const activeJob = {
    id: 281,
    job_type: 'frame_image',
    status: 'queued',
    request_json: JSON.stringify({ frameRole: 'primary' }),
  }

  assert.equal(
    selectReusableGenerationJob([activeJob], {
      jobType: 'frame_image',
      request: { frameRole: 'end' },
    }),
    null,
  )
})

test('reuses an active frame job only when its frame role matches', () => {
  const activeJob = {
    id: 289,
    job_type: 'frame_image',
    status: 'running',
    request_json: JSON.stringify({ frameRole: 'end' }),
  }

  assert.equal(
    selectReusableGenerationJob([activeJob], {
      jobType: 'frame_image',
      request: { frameRole: 'end' },
    }),
    activeJob,
  )
})

test('keeps active-job reuse behavior unchanged for non-frame generation jobs', () => {
  const activeJob = {
    id: 290,
    job_type: 'video_image',
    status: 'queued',
    request_json: JSON.stringify({ frameRole: 'primary' }),
  }

  assert.equal(
    selectReusableGenerationJob([activeJob], {
      jobType: 'video_image',
      request: { frameRole: 'end' },
    }),
    activeJob,
  )
})

test('queues a retryable generation failure with provider retry-after delay', () => {
  const decision = decideGenerationJobFailure({
    attemptCount: 1,
    maxAttempts: 3,
    error: {
      code: 'PROVIDER_RATE_LIMIT',
      retryable: true,
      retryAfterMs: 12_000,
    },
    now: new Date('2026-09-15T08:00:00.000Z'),
    config: resolveGenerationQueueConfig({}),
  })

  assert.deepEqual(decision, {
    status: 'queued',
    progressPercent: 0,
    delayMs: 12_000,
    nextRunAt: '2026-09-15 08:00:12',
    lastErrorCode: 'PROVIDER_RATE_LIMIT',
  })
})

test('fails a retryable generation job after its final attempt', () => {
  const decision = decideGenerationJobFailure({
    attemptCount: 3,
    maxAttempts: 3,
    error: { code: 'PROVIDER_TIMEOUT', retryable: true },
    now: new Date('2026-09-15T08:00:00.000Z'),
    config: resolveGenerationQueueConfig({}),
  })

  assert.deepEqual(decision, {
    status: 'failed',
    progressPercent: 100,
    delayMs: 0,
    nextRunAt: null,
    lastErrorCode: 'PROVIDER_TIMEOUT',
  })
})

test('does not retry a generation failure that the provider marked as non-retryable', () => {
  const decision = decideGenerationJobFailure({
    attemptCount: 1,
    maxAttempts: 3,
    error: { code: 'INVALID_PROMPT', retryable: false },
    now: new Date('2026-09-15T08:00:00.000Z'),
    config: resolveGenerationQueueConfig({}),
  })

  assert.deepEqual(decision, {
    status: 'failed',
    progressPercent: 100,
    delayMs: 0,
    nextRunAt: null,
    lastErrorCode: 'INVALID_PROMPT',
  })
})

test('builds a due-job query with an integer limit instead of a prepared LIMIT placeholder', () => {
  assert.deepEqual(buildDueGenerationJobsQuery(2), {
    sql: `SELECT id
       FROM generation_jobs
       WHERE status = 'queued'
         AND attempt_count < max_attempts
         AND (next_run_at IS NULL OR next_run_at <= UTC_TIMESTAMP())
         AND job_key NOT LIKE 'recover-video-%'
       ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC
       LIMIT 2`,
  })
})

test('keeps recovery video jobs out of an ordinary worker fetch', () => {
  assert.deepEqual(buildDueGenerationJobsQuery(2), {
    sql: `SELECT id
       FROM generation_jobs
       WHERE status = 'queued'
         AND attempt_count < max_attempts
         AND (next_run_at IS NULL OR next_run_at <= UTC_TIMESTAMP())
         AND job_key NOT LIKE 'recover-video-%'
       ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC
       LIMIT 2`,
  })
})

test('limits a controlled worker to the requested queued job', () => {
  assert.deepEqual(buildDueGenerationJobsQuery(1, { onlyJobId: 254 }), {
    sql: `SELECT id
       FROM generation_jobs
       WHERE status = 'queued'
         AND attempt_count < max_attempts
         AND (next_run_at IS NULL OR next_run_at <= UTC_TIMESTAMP())
         AND id = 254
       ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC
       LIMIT 1`,
  })
})

test('keeps recovery video jobs out of an ordinary worker restart recovery', () => {
  assert.deepEqual(buildRecoverRunningGenerationJobsQuery(), {
    sql: `UPDATE generation_jobs
     SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
         progress_percent = CASE WHEN attempt_count < max_attempts THEN 0 ELSE 100 END,
         next_run_at = CASE WHEN attempt_count < max_attempts THEN UTC_TIMESTAMP() ELSE NULL END,
         last_error_code = CASE WHEN attempt_count < max_attempts THEN last_error_code ELSE 'WORKER_RESTART_EXHAUSTED' END,
         error_text = CASE
           WHEN attempt_count < max_attempts THEN error_text
           ELSE COALESCE(error_text, '服务重启后任务已耗尽最大执行次数')
         END,
         updated_at = NOW()
     WHERE status = 'running'
       AND job_key NOT LIKE 'recover-video-%'`,
  })
})

test('limits worker restart recovery to the requested job', () => {
  assert.deepEqual(buildRecoverRunningGenerationJobsQuery(254), {
    sql: `UPDATE generation_jobs
     SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
         progress_percent = CASE WHEN attempt_count < max_attempts THEN 0 ELSE 100 END,
         next_run_at = CASE WHEN attempt_count < max_attempts THEN UTC_TIMESTAMP() ELSE NULL END,
         last_error_code = CASE WHEN attempt_count < max_attempts THEN last_error_code ELSE 'WORKER_RESTART_EXHAUSTED' END,
         error_text = CASE
           WHEN attempt_count < max_attempts THEN error_text
           ELSE COALESCE(error_text, '服务重启后任务已耗尽最大执行次数')
         END,
         updated_at = NOW()
     WHERE status = 'running'
       AND id = 254`,
  })
})

test('does not resume export jobs while a worker is pinned to one generation job', () => {
  assert.equal(
    shouldRunExportJobs(resolveGenerationQueueConfig({
      GENERATION_WORKER_ONLY_JOB_ID: '254',
    })),
    false,
  )
  assert.equal(shouldRunExportJobs(resolveGenerationQueueConfig({})), true)
})

test('does not resume generation jobs while a worker is pinned to one export', () => {
  assert.equal(
    shouldRunGenerationJobs(resolveGenerationQueueConfig({
      EXPORT_WORKER_ONLY_EXPORT_ID: '31',
    })),
    false,
  )
  assert.equal(shouldRunGenerationJobs(resolveGenerationQueueConfig({})), true)
})

test('limits export worker recovery to the requested export id', () => {
  assert.deepEqual(buildDueExportJobsQuery({ onlyExportId: 31 }), {
    sql: `SELECT id FROM export_records WHERE status IN ('queued', 'running') AND id = 31 ORDER BY id ASC`,
  })
  assert.deepEqual(buildDueExportJobsQuery(), {
    sql: `SELECT id FROM export_records WHERE status IN ('queued', 'running') ORDER BY id ASC`,
  })
})

test('continues an export that was already running when a worker restarted', () => {
  assert.equal(
    shouldContinueExportJobAfterClaim({
      affectedRows: 0,
      currentStatus: 'running',
    }),
    true,
  )
})

test('does not continue an export claim after it was canceled or removed', () => {
  assert.equal(
    shouldContinueExportJobAfterClaim({
      affectedRows: 0,
      currentStatus: 'canceled',
    }),
    false,
  )
  assert.equal(
    shouldContinueExportJobAfterClaim({
      affectedRows: 0,
      currentStatus: null,
    }),
    false,
  )
})
