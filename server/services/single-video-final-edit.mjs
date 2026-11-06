import { resolveSpeechSyncOffsetSeconds } from './final-edit-render-policy.mjs'

const EXECUTION_TOKEN = 'START_SINGLE_VIDEO_FINAL_EDIT'
const ROLLBACK_TOKEN = 'ROLLBACK_SINGLE_VIDEO_FINAL_EDIT'
// The lip-sync provider already animates the mouth against the submitted
// speech clock. A default delay makes the final mix late to the mouth motion.
const DEFAULT_LIP_SYNC_SPEECH_OFFSET_SECONDS = 0

function positiveInteger(value, fieldName) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`)
  }
  return parsed
}

export function buildSingleVideoFinalEditIdempotencyKey(videoId) {
  return `single-video-final-edit-video-${positiveInteger(videoId, 'videoId')}`
}

export function normalizeSingleVideoFinalEditConfirmation(input = {}) {
  if (
    input.confirm !== true ||
    String(input.confirmationToken || '').trim() !== EXECUTION_TOKEN
  ) {
    throw new Error(
      `执行单条视频竖屏终剪需要明确确认：confirm=true 且 confirmationToken=${EXECUTION_TOKEN}`,
    )
  }
  return true
}

export function normalizeSingleVideoFinalEditRollbackConfirmation(input = {}) {
  if (
    input.confirm !== true ||
    String(input.confirmationToken || '').trim() !== ROLLBACK_TOKEN
  ) {
    throw new Error(
      `单条视频终剪回滚需要明确确认：confirm=true 且 confirmationToken=${ROLLBACK_TOKEN}`,
    )
  }
  return true
}

export function buildSingleVideoFinalEditConfig({
  projectId,
  videoId,
  storyboardId,
  sceneId = null,
  sourceType = '',
  speechSyncOffsetSeconds,
  previousConfirmedVideoAssetId = null,
  previousStoryboardVideoUrl = null,
} = {}) {
  const normalizedProjectId = positiveInteger(projectId, 'projectId')
  const normalizedVideoId = positiveInteger(videoId, 'videoId')
  const normalizedStoryboardId = positiveInteger(storyboardId, 'storyboardId')
  const normalizedSourceType = String(sourceType || '').trim().toLowerCase() || 'generated_video'
  const hasExplicitSpeechSyncOffset = Number.isFinite(Number(speechSyncOffsetSeconds))
  const resolvedSpeechSyncOffset = resolveSpeechSyncOffsetSeconds({
    sourceType: normalizedSourceType,
    configuredOffsetSeconds: hasExplicitSpeechSyncOffset
      ? speechSyncOffsetSeconds
      : normalizedSourceType === 'lip_sync'
        ? DEFAULT_LIP_SYNC_SPEECH_OFFSET_SECONDS
        : 0,
  })
  const idempotencyKey = buildSingleVideoFinalEditIdempotencyKey(normalizedVideoId)

  return {
    pipeline: 'single-video-final-edit-v1',
    executionMode: 'manual-confirmed-single',
    format: 'mp4',
    resolution: '1080x1920',
    frameRate: 24,
    speechSyncOffsetSeconds: resolvedSpeechSyncOffset,
    videoCodec: 'h264',
    audioCodec: 'aac',
    burnSubtitle: true,
    hybridVideoPerScene: 1,
    strictStoryboardAudio: true,
    singleVideoFinalEdit: {
      version: 1,
      projectId: normalizedProjectId,
      videoId: normalizedVideoId,
      storyboardId: normalizedStoryboardId,
      sceneId: Number.isSafeInteger(Number(sceneId)) && Number(sceneId) > 0
        ? Number(sceneId)
        : null,
      sourceType: normalizedSourceType,
      idempotencyKey,
      sourceMode: 'single-video-candidate',
      rollback: {
        reversible: true,
        strategy: 'preserve-source-candidate',
        previousStoryboardVideoUrl: String(previousStoryboardVideoUrl || '').trim() || null,
        previousConfirmedVideoAssetId:
          Number.isSafeInteger(Number(previousConfirmedVideoAssetId)) &&
          Number(previousConfirmedVideoAssetId) > 0
            ? Number(previousConfirmedVideoAssetId)
            : null,
      },
    },
  }
}

export function isSingleVideoFinalEditExport(record = {}) {
  const config = typeof record.config_json === 'string'
    ? parseJson(record.config_json)
    : record.config || record
  return (
    config?.pipeline === 'single-video-final-edit-v1' &&
    config?.singleVideoFinalEdit?.sourceMode === 'single-video-candidate'
  )
}

export function buildCompletedSingleVideoFinalEditConfig(config, resultPatch = {}) {
  const normalized = typeof config === 'string' ? parseJson(config) : config
  if (!isSingleVideoFinalEditExport(normalized)) {
    throw new Error('当前导出记录不是单条视频竖屏终剪任务')
  }
  return {
    ...normalized,
    ...resultPatch,
    pipeline: 'single-video-final-edit-v1',
  }
}

export function buildSingleVideoFinalEditRollbackPatch(config) {
  const normalized = typeof config === 'string' ? parseJson(config) : config
  if (!isSingleVideoFinalEditExport(normalized)) {
    throw new Error('当前导出记录不是单条视频竖屏终剪任务')
  }
  return {
    ...normalized,
    singleVideoFinalEdit: {
      ...normalized.singleVideoFinalEdit,
      rollback: {
        ...normalized.singleVideoFinalEdit.rollback,
        reversible: false,
        rolledBackAt: new Date().toISOString(),
      },
    },
  }
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
