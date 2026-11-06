function readOption(args, name) {
  const prefix = `--${name}=`
  const option = args.find((item) => String(item).startsWith(prefix))
  return option ? String(option).slice(prefix.length) : null
}

function parsePositiveJobId(value) {
  const jobId = Number(value)
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error('--job-id must be a positive integer')
  }
  return jobId
}

export function parseControlledRecoveryWorkerArgs(args = []) {
  const jobId = parsePositiveJobId(readOption(args, 'job-id'))
  const apply = args.includes('--apply')
  const dryRun = args.includes('--dry-run')
  if (apply && dryRun) {
    throw new Error('--apply and --dry-run are mutually exclusive')
  }
  if (!apply && !dryRun) {
    throw new Error('controlled recovery worker requires --apply or --dry-run')
  }
  return { jobId, apply, dryRun }
}

export function isQueuedRecoveryVideoJob(job = {}) {
  return (
    Number.isSafeInteger(Number(job.id)) &&
    Number(job.id) > 0 &&
    String(job.status || '').trim().toLowerCase() === 'queued' &&
    String(job.job_type || '').trim() === 'video_image' &&
    String(job.job_key || '').startsWith('recover-video-')
  )
}

export function buildControlledRecoveryWorkerEnv(baseEnv = {}, jobId) {
  const normalizedJobId = parsePositiveJobId(jobId)
  return {
    ...baseEnv,
    APP_RUNTIME_ROLE: 'worker',
    GENERATION_WORKER_CONCURRENCY: '1',
    GENERATION_WORKER_MAX_JOBS: '1',
    GENERATION_WORKER_ONLY_JOB_ID: String(normalizedJobId),
  }
}

export function buildRecoveryQueueSnapshot(rows = [], targetJobId) {
  const normalizedTargetJobId = parsePositiveJobId(targetJobId)
  const recoveryJobs = rows
    .filter((row) => String(row?.job_key || '').startsWith('recover-video-'))
    .map((row) => ({
      id: Number(row.id),
      status: String(row.status || '').trim().toLowerCase(),
    }))
    .filter((row) => Number.isSafeInteger(row.id) && row.id > 0)
  const activeJobs = recoveryJobs.filter((row) => row.status === 'queued' || row.status === 'running')
  const target = recoveryJobs.find((row) => row.id === normalizedTargetJobId) || null
  return {
    targetJobId: normalizedTargetJobId,
    totalRecoveryJobs: recoveryJobs.length,
    activeRecoveryJobs: activeJobs.length,
    queuedRecoveryJobs: activeJobs.filter((row) => row.status === 'queued').length,
    runningRecoveryJobs: activeJobs.filter((row) => row.status === 'running').length,
    neighborActiveJobIds: activeJobs
      .filter((row) => row.id !== normalizedTargetJobId)
      .map((row) => row.id),
    targetPresent: Boolean(target),
    targetStatus: target?.status || null,
    onlyTargetWillRun: target?.status === 'queued',
  }
}

function normalizeRecoveryQueueRows(rows = []) {
  return rows
    .filter((row) => String(row?.job_key || '').startsWith('recover-video-'))
    .map((row) => ({
      id: Number(row.id),
      status: String(row.status || '').trim().toLowerCase(),
    }))
    .filter((row) => Number.isSafeInteger(row.id) && row.id > 0)
}

export function evaluateControlledRecoveryBoundary(
  beforeRows = [],
  afterRows = [],
  targetJobId,
) {
  const normalizedTargetJobId = parsePositiveJobId(targetJobId)
  const before = new Map(
    normalizeRecoveryQueueRows(beforeRows).map((row) => [row.id, row.status]),
  )
  const after = new Map(
    normalizeRecoveryQueueRows(afterRows).map((row) => [row.id, row.status]),
  )
  const targetStatusBefore = before.get(normalizedTargetJobId) || null
  const targetStatusAfter = after.get(normalizedTargetJobId) || null
  const changedNeighborJobIds = []
  const addedNeighborJobIds = []
  const removedNeighborJobIds = []

  for (const [id, status] of before) {
    if (id === normalizedTargetJobId) continue
    if (!after.has(id)) {
      removedNeighborJobIds.push(id)
      continue
    }
    if (after.get(id) !== status) changedNeighborJobIds.push(id)
  }
  for (const id of after.keys()) {
    if (id !== normalizedTargetJobId && !before.has(id)) {
      addedNeighborJobIds.push(id)
    }
  }

  changedNeighborJobIds.sort((a, b) => a - b)
  addedNeighborJobIds.sort((a, b) => a - b)
  removedNeighborJobIds.sort((a, b) => a - b)

  const violationCodes = []
  if (targetStatusBefore !== 'queued') violationCodes.push('target-not-queued-before')
  if (!targetStatusAfter) violationCodes.push('target-missing-after')
  if (changedNeighborJobIds.length > 0) violationCodes.push('neighbor-status-changed')
  if (addedNeighborJobIds.length > 0) violationCodes.push('neighbor-job-added')
  if (removedNeighborJobIds.length > 0) violationCodes.push('neighbor-job-removed')

  return {
    boundarySafe: violationCodes.length === 0,
    targetStatusBefore,
    targetStatusAfter,
    targetStatusChanged: targetStatusBefore !== targetStatusAfter,
    changedNeighborJobIds,
    addedNeighborJobIds,
    removedNeighborJobIds,
    violationCodes,
  }
}
