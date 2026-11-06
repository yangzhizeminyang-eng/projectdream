const EXPLICIT_CONFIRMATION_TOKEN = 'START_RECOVERY_FINAL_EDIT'
const ROLLBACK_CONFIRMATION_TOKEN = 'ROLLBACK_RECOVERY_FINAL_EDIT'
const REUSABLE_EXPORT_STATUSES = new Set(['queued', 'running', 'completed'])

function positiveInteger(value, fieldName) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`)
  }
  return parsed
}

function normalizeOptionalPositiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function buildRecoveryFinalEditIdempotencyKey({ videoId, planId } = {}) {
  const normalizedVideoId = positiveInteger(videoId, 'videoId')
  const normalizedPlanId = String(planId || '').trim()
  if (normalizedPlanId !== `recovery-final-edit-video-${normalizedVideoId}`) {
    throw new Error('终剪幂等键与当前视频计划不一致')
  }
  return normalizedPlanId
}

export function isDuplicateKeyError(error) {
  return Number(error?.errno) === 1062 || String(error?.code || '').trim() === 'ER_DUP_ENTRY'
}

export function normalizeRecoveryFinalEditConfirmation(input = {}) {
  if (
    input.confirm !== true ||
    String(input.confirmationToken || '').trim() !== EXPLICIT_CONFIRMATION_TOKEN
  ) {
    throw new Error(
      `执行竖屏终剪需要明确确认：confirm=true 且 confirmationToken=${EXPLICIT_CONFIRMATION_TOKEN}`,
    )
  }
  return true
}

export function normalizeRecoveryFinalEditRollbackConfirmation(input = {}) {
  if (
    input.confirm !== true ||
    String(input.confirmationToken || '').trim() !== ROLLBACK_CONFIRMATION_TOKEN
  ) {
    throw new Error(
      `回滚确认需要明确确认：confirm=true 且 confirmationToken=${ROLLBACK_CONFIRMATION_TOKEN}`,
    )
  }
  return true
}

export function buildRecoveryFinalEditExecutionConfig(input = {}) {
  const videoId = positiveInteger(input.videoId, 'videoId')
  const storyboardId = positiveInteger(input.storyboardId, 'storyboardId')
  const planId = String(input.planId || '').trim()
  const idempotencyKey = buildRecoveryFinalEditIdempotencyKey({ videoId, planId })

  return {
    pipeline: 'recovery-final-edit-v1',
    executionMode: 'manual-confirmed-single',
    format: 'mp4',
    resolution: '1080x1920',
    frameRate: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    burnSubtitle: true,
    hybridVideoPerScene: 1,
    strictStoryboardAudio: true,
    recoveryFinalEdit: {
      version: 1,
      videoId,
      storyboardId,
      sceneId: normalizeOptionalPositiveInteger(input.sceneId),
      planId,
      idempotencyKey,
      sourceMode: 'single-recovery-candidate',
      rollback: {
        reversible: true,
        strategy: 'preserve-source-candidate',
        previousStoryboardVideoUrl: String(input.previousStoryboardVideoUrl || '').trim() || null,
        previousConfirmedVideoAssetId: normalizeOptionalPositiveInteger(
          input.previousConfirmedVideoAssetId,
        ),
      },
    },
  }
}

function parseConfig(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function hasRecoveryFinalEditIntent(config) {
  const recoveryFinalEdit = config?.recoveryFinalEdit
  const videoId = normalizeOptionalPositiveInteger(recoveryFinalEdit?.videoId)
  const planId = String(recoveryFinalEdit?.planId || '').trim()

  return (
    recoveryFinalEdit?.version === 1 &&
    recoveryFinalEdit?.sourceMode === 'single-recovery-candidate' &&
    Boolean(videoId) &&
    planId === `recovery-final-edit-video-${videoId}`
  )
}

export function shouldReuseRecoveryFinalEditExport(record, planId) {
  if (!record || !REUSABLE_EXPORT_STATUSES.has(String(record.status || '').trim())) {
    return false
  }
  const config = parseConfig(record.config_json ?? record.config)
  return (
    hasRecoveryFinalEditIntent(config) &&
    config?.recoveryFinalEdit?.planId === String(planId || '').trim()
  )
}

export function isRecoveryFinalEditExport(record) {
  const config = parseConfig(record?.config_json ?? record?.config ?? record)
  return config?.pipeline === 'recovery-final-edit-v1' || hasRecoveryFinalEditIntent(config)
}

export function buildCompletedRecoveryFinalEditConfig(config, patch = {}) {
  const normalized = parseConfig(config) || {}
  if (!isRecoveryFinalEditExport(normalized)) {
    throw new Error('当前导出配置不是恢复视频竖屏终剪任务')
  }
  return {
    ...normalized,
    ...patch,
    pipeline: 'recovery-final-edit-v1',
    recoveryFinalEdit: normalized.recoveryFinalEdit,
  }
}

export function buildFinalEditRenderConfig(config, draft = {}) {
  const normalized = parseConfig(config) || {}
  const normalizedDraft =
    draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {}
  const persistedDraft =
    normalized.finalEditDraft &&
    typeof normalized.finalEditDraft === 'object' &&
    !Array.isArray(normalized.finalEditDraft)
      ? normalized.finalEditDraft
      : {}

  return {
    ...normalized,
    finalEditDraft: {
      ...persistedDraft,
      ...normalizedDraft,
    },
  }
}

export function buildRecoveryFinalEditRollbackPatch(config, rolledBackAt = new Date().toISOString()) {
  const normalized = parseConfig(config) || {}
  if (!isRecoveryFinalEditExport(normalized)) {
    throw new Error('当前导出记录不是恢复视频竖屏终剪任务')
  }
  return {
    ...normalized,
    pipeline: 'recovery-final-edit-v1',
    recoveryFinalEdit: {
      ...normalized.recoveryFinalEdit,
      rollback: {
        ...normalized.recoveryFinalEdit?.rollback,
        reversible: false,
        rolledBackAt,
      },
    },
  }
}
