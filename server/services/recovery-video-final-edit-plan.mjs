import {
  buildDefaultVerticalProductionTemplate,
  resolveVerticalSubtitleBurnIn,
} from './vertical-production-template.mjs'

function toPositiveInteger(value, fieldName) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`)
  }
  return parsed
}

function toNullablePositiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function toNullableText(value) {
  const normalized = String(value || '').trim()
  return normalized || null
}

function resolvePlanBlocker(finalEditReadiness = {}) {
  const status = String(finalEditReadiness.status || '').trim()
  if (status === 'waiting-manual-review') {
    return {
      code: 'manual-review-incomplete',
      message: '先完成人工画面、人物一致性和动作连续性复核，再进入竖屏终剪。',
    }
  }
  if (status === 'blocked-by-rework') {
    return {
      code: 'manual-review-rework',
      message: '人工复核要求返工，完成返工并重新复核后才能进入竖屏终剪。',
    }
  }
  if (status === 'needs-technical-check') {
    return {
      code: 'technical-check-incomplete',
      message: '先完成自动技术检查和抽帧证据，再进入竖屏终剪。',
    }
  }
  if (status === 'not-required') {
    return {
      code: 'final-edit-not-required',
      message: '候选视频已经满足发布技术规格，不需要再进入竖屏终剪。',
    }
  }
  return {
    code: 'final-edit-gate-incomplete',
    message: String(finalEditReadiness.message || '').trim()
      || '终剪前置门禁尚未通过，不能进入竖屏终剪。',
  }
}

export function buildRecoveryVideoFinalEditPlan(input = {}) {
  const videoId = toPositiveInteger(input.videoId, 'videoId')
  const template = buildDefaultVerticalProductionTemplate()
  const readiness = input.finalEditReadiness || {}
  const canStart = readiness.status === 'ready-for-final-edit' && readiness.canStartFinalEdit === true

  return {
    planId: `recovery-final-edit-video-${videoId}`,
    videoId,
    storyboardId: toNullablePositiveInteger(input.storyboardId),
    sceneId: toNullablePositiveInteger(input.sceneId),
    sceneNo: toNullablePositiveInteger(input.sceneNo),
    shotNo: toNullableText(input.shotNo),
    durationSeconds: Number(input.durationSeconds) > 0 ? Number(input.durationSeconds) : null,
    status: canStart ? 'ready' : 'blocked',
    canStart,
    executionMode: 'manual-gate',
    target: {
      templateId: template.id,
      aspectRatio: template.aspectRatio,
      width: template.resolution.width,
      height: template.resolution.height,
      frameRate: template.frameRate,
      videoCodec: template.videoCodec,
      audioCodec: template.audioCodec,
      container: 'mp4',
      burnSubtitle: resolveVerticalSubtitleBurnIn(),
    },
    blockers: canStart ? [] : [resolvePlanBlocker(readiness)],
  }
}
