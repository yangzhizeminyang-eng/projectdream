export const CONTROLLED_RECOVERY_RETRY_CONFIRMATION =
  'CONFIRM_RECOVERY_SINGLE_RETRY'

const ACTIVE_OR_COMPLETED_STATUSES = new Set(['queued', 'running', 'success'])

function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function isRecoveryVideoJob(job) {
  return (
    String(job?.status || '').trim().toLowerCase() === 'failed' &&
    String(job?.job_type || '').trim() === 'video_image' &&
    String(job?.job_key || '').startsWith('recover-video-')
  )
}

export function buildControlledRecoveryRetryJobKey({
  originalJobId,
  projectId,
  storyboardId,
  retryIndex = 1,
} = {}) {
  const jobId = positiveInteger(originalJobId)
  const project = positiveInteger(projectId)
  const storyboard = positiveInteger(storyboardId)
  const index = positiveInteger(retryIndex)
  if (!jobId || !project || !storyboard || !index) {
    throw new TypeError(
      'originalJobId, projectId, storyboardId and retryIndex must be positive integers',
    )
  }
  return [
    'recover-video-controlled-retry',
    `original-${jobId}`,
    `project-${project}`,
    `storyboard-${storyboard}`,
    `retry-${index}`,
  ].join('-')
}

export function buildControlledRecoveryRetryRequest(
  request,
  { originalJobId, originalJobKey } = {},
) {
  const source = request && typeof request === 'object' ? request : {}
  const jobId = positiveInteger(originalJobId)
  if (!jobId) throw new TypeError('originalJobId must be a positive integer')

  return {
    ...source,
    controlledRetry: {
      mode: 'single',
      originalJobId: jobId,
      originalJobKey: String(originalJobKey || '').trim() || null,
    },
  }
}

export function planControlledRecoveryRetry({
  job,
  triage,
  existingRetries = [],
  confirmed = false,
} = {}) {
  if (confirmed !== true) {
    return {
      action: 'blocked',
      reason: 'confirmation-required',
    }
  }

  if (!isRecoveryVideoJob(job)) {
    return {
      action: 'blocked',
      reason: 'source-job-not-a-failed-recovery-video',
    }
  }

  if (triage?.retryable !== true || triage?.sourceReady !== true) {
    return {
      action: 'blocked',
      reason: 'triage-not-retryable',
    }
  }

  const attemptCount = Math.max(0, Number(job.attempt_count) || 0)
  const maxAttempts = Math.max(1, Number(job.max_attempts) || 1)
  if (attemptCount >= maxAttempts) {
    return {
      action: 'blocked',
      reason: 'source-job-attempts-exhausted',
    }
  }

  const retries = Array.isArray(existingRetries) ? existingRetries : []
  if (
    retries.some((retry) =>
      ACTIVE_OR_COMPLETED_STATUSES.has(
        String(retry?.status || '').trim().toLowerCase(),
      ),
    )
  ) {
    return {
      action: 'skip',
      reason: 'controlled-retry-already-exists',
    }
  }

  const retryIndex = retries.length + 1
  const projectId = positiveInteger(job.project_id)
  const storyboardId = positiveInteger(job.source_id)
  const originalJobId = positiveInteger(job.id)
  if (!projectId || !storyboardId || !originalJobId) {
    return {
      action: 'blocked',
      reason: 'source-job-identifiers-invalid',
    }
  }

  return {
    action: 'queue',
    originalJobId,
    projectId,
    storyboardId,
    retryIndex,
    jobKey: buildControlledRecoveryRetryJobKey({
      originalJobId,
      projectId,
      storyboardId,
      retryIndex,
    }),
    maxAttempts: 1,
    confirmation: CONTROLLED_RECOVERY_RETRY_CONFIRMATION,
  }
}
