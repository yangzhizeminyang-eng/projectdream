export const CONTROLLED_RECOVERY_REWORK_CONFIRMATION =
  'CONFIRM_RECOVERY_REWORK_SINGLE_GENERATION'

function positiveInteger(value, fieldName) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`)
  }
  return parsed
}

export function buildControlledRecoveryReworkJobKey({
  sourceVideoId,
  projectId,
  storyboardId,
  attemptNo = 1,
} = {}) {
  return [
    'recover-video-controlled-rework',
    `video-${positiveInteger(sourceVideoId, 'sourceVideoId')}`,
    `project-${positiveInteger(projectId, 'projectId')}`,
    `storyboard-${positiveInteger(storyboardId, 'storyboardId')}`,
    `attempt-${positiveInteger(attemptNo, 'attemptNo')}`,
  ].join('-')
}

export function buildControlledRecoveryReworkRequest({
  sourceRequest,
  sourceVideoId,
  sourceJobId,
  sourceJobKey,
  reviewNote,
  versionNo,
} = {}) {
  const source = sourceRequest && typeof sourceRequest === 'object' ? sourceRequest : {}
  return {
    ...source,
    versionNo: positiveInteger(versionNo, 'versionNo'),
    candidateCount: 1,
    autoConfirm: false,
    providerTasks: [],
    controlledRework: {
      mode: 'single',
      sourceVideoId: positiveInteger(sourceVideoId, 'sourceVideoId'),
      sourceJobId: positiveInteger(sourceJobId, 'sourceJobId'),
      sourceJobKey: String(sourceJobKey || '').trim() || null,
      reviewNote: String(reviewNote || '').trim() || null,
    },
  }
}

export function planControlledRecoveryRework({
  video,
  sourceJob,
  existingJobs = [],
  sourceImageReadable = false,
  confirmed = false,
} = {}) {
  if (confirmed !== true) {
    return { action: 'blocked', reason: 'confirmation-required' }
  }
  if (
    !video ||
    String(video.status || '').trim() !== 'candidate' ||
    String(video.recovery_review_decision || '').trim() !== 'rework'
  ) {
    return { action: 'blocked', reason: 'source-video-not-a-rework-candidate' }
  }
  if (
    !sourceJob ||
    String(sourceJob.status || '').trim() !== 'success' ||
    String(sourceJob.job_type || '').trim() !== 'video_image' ||
    !String(sourceJob.job_key || '').startsWith('recover-video-')
  ) {
    return { action: 'blocked', reason: 'source-job-not-a-successful-recovery-video' }
  }
  if (sourceImageReadable !== true) {
    return { action: 'blocked', reason: 'source-image-not-readable' }
  }

  const jobs = Array.isArray(existingJobs) ? existingJobs : []
  if (
    jobs.some((job) =>
      ['queued', 'running', 'success'].includes(String(job?.status || '').trim()),
    )
  ) {
    return { action: 'skip', reason: 'controlled-rework-already-exists' }
  }

  const projectId = positiveInteger(video.project_id, 'projectId')
  const storyboardId = positiveInteger(video.storyboard_id, 'storyboardId')
  const sourceVideoId = positiveInteger(video.id, 'sourceVideoId')
  const sourceJobId = positiveInteger(sourceJob.id, 'sourceJobId')
  const attemptNo = jobs.length + 1

  return {
    action: 'queue',
    projectId,
    storyboardId,
    sourceVideoId,
    sourceJobId,
    attemptNo,
    jobKey: buildControlledRecoveryReworkJobKey({
      sourceVideoId,
      projectId,
      storyboardId,
      attemptNo,
    }),
    maxAttempts: 1,
    confirmation: CONTROLLED_RECOVERY_REWORK_CONFIRMATION,
  }
}
