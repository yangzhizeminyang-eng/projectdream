const DEFAULT_WORKER_CONCURRENCY = 2
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 5000
const DEFAULT_RETRY_MAX_DELAY_MS = 300000

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseOptionalPositiveInteger(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  const parsed = Number.parseInt(normalized, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function formatMysqlDateTime(value) {
  return value.toISOString().slice(0, 19).replace('T', ' ')
}

function normalizeFrameRole(value) {
  return value === 'start' || value === 'end' ? value : 'primary'
}

function parseRequestJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function selectReusableGenerationJob(rows, { jobType, request } = {}) {
  const candidates = Array.isArray(rows) ? rows : []
  const requestedJobType = String(jobType || '').trim()
  const requestedFrameRole = normalizeFrameRole(request?.frameRole)

  return candidates.find((row) => {
    if (String(row?.job_type || '').trim() !== requestedJobType) return false
    if (requestedJobType !== 'frame_image') return true

    const activeRequest = parseRequestJson(row.request_json)
    return normalizeFrameRole(activeRequest.frameRole) === requestedFrameRole
  }) || null
}

export function resolveGenerationQueueConfig(env = process.env) {
  const retryBaseDelayMs = parsePositiveInteger(
    env.GENERATION_RETRY_BASE_DELAY_MS,
    DEFAULT_RETRY_BASE_DELAY_MS,
  )
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    parsePositiveInteger(env.GENERATION_RETRY_MAX_DELAY_MS, DEFAULT_RETRY_MAX_DELAY_MS),
  )

  return {
    workerConcurrency: parsePositiveInteger(
      env.GENERATION_WORKER_CONCURRENCY,
      DEFAULT_WORKER_CONCURRENCY,
    ),
    workerMaxJobs: parseOptionalPositiveInteger(env.GENERATION_WORKER_MAX_JOBS),
    workerOnlyJobId: parseOptionalPositiveInteger(env.GENERATION_WORKER_ONLY_JOB_ID),
    workerOnlyExportId: parseOptionalPositiveInteger(env.EXPORT_WORKER_ONLY_EXPORT_ID),
    defaultMaxAttempts: parsePositiveInteger(
      env.GENERATION_JOB_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
    ),
    retryBaseDelayMs,
    retryMaxDelayMs,
  }
}

export function decideGenerationJobFailure({
  attemptCount,
  maxAttempts,
  error,
  now = new Date(),
  config = resolveGenerationQueueConfig(),
}) {
  const normalizedAttemptCount = Math.max(0, Number(attemptCount) || 0)
  const normalizedMaxAttempts = Math.max(1, Number(maxAttempts) || config.defaultMaxAttempts)
  const lastErrorCode = String(error?.code || 'GENERATION_PROVIDER_ERROR').slice(0, 80)
  const shouldRetry = Boolean(error?.retryable) && normalizedAttemptCount < normalizedMaxAttempts

  if (!shouldRetry) {
    return {
      status: 'failed',
      progressPercent: 100,
      delayMs: 0,
      nextRunAt: null,
      lastErrorCode,
    }
  }

  const exponentialDelayMs = config.retryBaseDelayMs * 2 ** Math.max(0, normalizedAttemptCount - 1)
  const delayMs = Math.min(
    config.retryMaxDelayMs,
    Math.max(exponentialDelayMs, Number(error?.retryAfterMs) || 0),
  )

  return {
    status: 'queued',
    progressPercent: 0,
    delayMs,
    nextRunAt: formatMysqlDateTime(new Date(now.getTime() + delayMs)),
    lastErrorCode,
  }
}

function targetJobClause(onlyJobId) {
  const target = parseOptionalPositiveInteger(onlyJobId)
  return target ? `\n         AND id = ${target}` : ''
}

function recoveryJobProtectionClause(onlyJobId) {
  return parseOptionalPositiveInteger(onlyJobId)
    ? ''
    : `\n         AND job_key NOT LIKE 'recover-video-%'`
}

export function buildDueGenerationJobsQuery(availableSlots, { onlyJobId } = {}) {
  const limit = Math.max(1, Number.parseInt(String(availableSlots || ''), 10) || 1)
  return {
    sql: `SELECT id
       FROM generation_jobs
       WHERE status = 'queued'
         AND attempt_count < max_attempts
         AND (next_run_at IS NULL OR next_run_at <= UTC_TIMESTAMP())${recoveryJobProtectionClause(onlyJobId)}${targetJobClause(onlyJobId)}
       ORDER BY COALESCE(next_run_at, created_at) ASC, id ASC
       LIMIT ${limit}`,
  }
}

export function buildRecoverRunningGenerationJobsQuery(onlyJobId) {
  return {
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
     WHERE status = 'running'${recoveryJobProtectionClause(onlyJobId).replace(/\n         /, '\n       ')}${targetJobClause(onlyJobId).replace(/\n         /, '\n       ')}`,
  }
}

export function shouldRunExportJobs(config = resolveGenerationQueueConfig()) {
  return !config.workerOnlyJobId
}

export function shouldRunGenerationJobs(config = resolveGenerationQueueConfig()) {
  return !config.workerOnlyExportId
}

export function buildDueExportJobsQuery({ onlyExportId } = {}) {
  const target = parseOptionalPositiveInteger(onlyExportId)
  return {
    sql: `SELECT id FROM export_records WHERE status IN ('queued', 'running')${target ? ` AND id = ${target}` : ''} ORDER BY id ASC`,
  }
}

export function shouldContinueExportJobAfterClaim({ affectedRows, currentStatus } = {}) {
  if (Number(affectedRows) === 1) return true
  return String(currentStatus || '').trim() === 'running'
}
