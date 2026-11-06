import { buildRecoveryVideoFinalEditPlan } from './recovery-video-final-edit-plan.mjs'

const REVIEW_PRIORITY = {
  pending: 0,
  rework: 1,
  approved: 2,
}

const INSPECTION_READINESS_PRIORITY = {
  ready: 0,
  'pending-inspection': 1,
  blocked: 2,
}

const REQUIRED_CHECKS = [
  'visualReviewed',
  'characterConsistencyReviewed',
  'motionContinuityReviewed',
]

function normalizeExpectedCharacterIds(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .map((characterId) => Number(characterId))
      .filter((characterId) => Number.isSafeInteger(characterId) && characterId > 0),
  )]
}

function buildCharacterReviewSummary(row) {
  const expectedCharacterIds = normalizeExpectedCharacterIds(row.expectedCharacterIds)
  const expectedCharacterIdSet = new Set(expectedCharacterIds)
  const decisionsByCharacterId = new Map(
    (Array.isArray(row.reviewChecklist?.characterChecks) ? row.reviewChecklist.characterChecks : [])
      .map((check) => [Number(check?.characterId), String(check?.decision || '').trim()])
      .filter(([characterId, decision]) =>
        expectedCharacterIdSet.has(characterId) && ['matched', 'rework'].includes(decision),
      ),
  )
  let matchedCount = 0
  let reworkCount = 0
  for (const characterId of expectedCharacterIds) {
    const decision = decisionsByCharacterId.get(characterId)
    if (decision === 'matched') matchedCount += 1
    if (decision === 'rework') reworkCount += 1
  }
  return {
    expectedCount: expectedCharacterIds.length,
    matchedCount,
    reworkCount,
    pendingCount: expectedCharacterIds.length - matchedCount - reworkCount,
  }
}

function isApprovedReview(row, characterReviewSummary, inspectionReadiness) {
  return (
    inspectionReadiness === 'ready' &&
    row.reviewDecision === 'approved' &&
    REQUIRED_CHECKS.every((key) => row.reviewChecklist?.[key] === true) &&
    characterReviewSummary.pendingCount === 0 &&
    characterReviewSummary.reworkCount === 0
  )
}

function resolveReviewStatus(row, characterReviewSummary, inspectionReadiness) {
  if (isApprovedReview(row, characterReviewSummary, inspectionReadiness)) return 'approved'
  if (row.reviewDecision === 'rework') return 'rework'
  return 'pending'
}

function resolveInspectionReadiness(row) {
  if (row.inspectionStatus === 'ready') return 'ready'
  if (row.inspectionStatus === 'failed') return 'blocked'
  return 'pending-inspection'
}

function resolveInspectionGuidance(row, inspectionReadiness) {
  if (inspectionReadiness === 'ready') return null
  if (inspectionReadiness === 'pending-inspection') {
    return '等待技术检查完成后再进行人工复核。'
  }
  if (row.inspectionBlockingCode === 'recovery-video-metadata-missing') {
    return '查看候选详情，检查视频文件、编码与容器信息；无法恢复时重新生成候选视频。'
  }
  if (row.inspectionBlockingCode === 'recovery-review-samples-incomplete') {
    return '查看候选详情，检查视频对象和抽帧；证据无法补齐时重新生成候选视频。'
  }
  if (row.inspectionBlockingCode === 'recovery-video-inspection-failed') {
    return '查看候选详情，检查视频对象是否可读取；无法恢复时重新生成候选视频。'
  }
  return '查看候选详情，排查技术检查阻塞原因；无法恢复时重新生成候选视频。'
}

function buildReworkReasons(row) {
  const reasons = []
  const reviewNote = String(row.reviewNote || '').trim()
  if (row.reviewDecision === 'rework' && reviewNote) {
    reasons.push({
      scope: 'video',
      characterId: null,
      message: reviewNote,
    })
  }

  for (const check of Array.isArray(row.reviewChecklist?.characterChecks)
    ? row.reviewChecklist.characterChecks
    : []) {
    if (String(check?.decision || '').trim() !== 'rework') continue
    const message = String(check?.note || '').trim()
    if (!message) continue
    const characterId = Number(check?.characterId)
    reasons.push({
      scope: 'character',
      characterId: Number.isSafeInteger(characterId) && characterId > 0 ? characterId : null,
      message,
    })
  }

  return reasons
}

function resolveNextAction({ reviewStatus, inspectionReadiness, finalEditReadiness }) {
  if (inspectionReadiness === 'blocked') {
    return {
      code: 'resolve-technical-blocker',
      label: '处理技术阻塞',
      message: '先补齐视频对象、编码或抽帧证据，再重新进行人工复核。',
    }
  }
  if (reviewStatus === 'rework' || finalEditReadiness.status === 'blocked-by-rework') {
    return {
      code: 'regenerate-recovery-candidate',
      label: '重新生成候选',
      message: '当前候选已被人工标记返工；请回到视频生成页重新生成一条候选，完成后再重新复核。',
    }
  }
  if (finalEditReadiness.status === 'ready-for-final-edit') {
    return {
      code: 'start-recovery-final-edit',
      label: '进入竖屏终剪',
      message: '人工复核已通过，可以在明确确认后创建单条竖屏终剪任务。',
    }
  }
  if (reviewStatus === 'pending') {
    return {
      code: 'complete-recovery-review',
      label: '完成人工复核',
      message: '先完成画面、人物一致性和动作连续性复核，再决定是否进入终剪。',
    }
  }
  return {
    code: 'inspect-recovery-status',
    label: '查看处理详情',
    message: finalEditReadiness.message,
  }
}

function normalizeReleaseReadiness(row, inspectionReadiness) {
  const readiness = row.releaseReadiness && typeof row.releaseReadiness === 'object'
    ? row.releaseReadiness
    : null
  if (!readiness || inspectionReadiness !== 'ready') {
    return {
      status: 'needs-technical-check',
      canPublishDirectly: false,
      message: '先完成技术检查，再判断是否满足平台发布规格。',
      blockingIssues: [],
    }
  }
  const status = String(readiness.status || '').trim()
  const normalizedStatus = ['release-format-ready', 'needs-vertical-final-edit'].includes(status)
    ? status
    : 'needs-vertical-final-edit'
  return {
    status: normalizedStatus,
    canPublishDirectly: readiness.canPublishDirectly === true && normalizedStatus === 'release-format-ready',
    message: String(readiness.message || '').trim() || null,
    blockingIssues: Array.isArray(readiness.blockingIssues) ? readiness.blockingIssues : [],
  }
}

function resolveFinalEditReadiness(item) {
  const releaseStatus = item.releaseReadiness?.status

  if (releaseStatus === 'release-format-ready') {
    return {
      status: 'not-required',
      canStartFinalEdit: false,
      message: '候选视频已经满足平台发布技术规格，不需要再进入竖屏终剪计划。',
    }
  }

  if (releaseStatus === 'needs-technical-check') {
    return {
      status: 'needs-technical-check',
      canStartFinalEdit: false,
      message: '先完成自动技术检查和抽帧证据，再判断是否进入竖屏终剪。',
    }
  }

  if (item.reviewStatus === 'approved') {
    return {
      status: 'ready-for-final-edit',
      canStartFinalEdit: true,
      message: '已通过自动技术检查和人工复核，可进入 1080x1920 / 24fps 竖屏终剪计划。',
    }
  }

  if (item.reviewStatus === 'rework') {
    return {
      status: 'blocked-by-rework',
      canStartFinalEdit: false,
      message: '人工复核要求返工，不能进入竖屏终剪。',
    }
  }

  return {
    status: 'waiting-manual-review',
    canStartFinalEdit: false,
    message: '先完成人工画面、人物一致性和动作连续性复核，再进入竖屏终剪。',
  }
}

function toTimestamp(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function buildRecoveryVideoReviewQueue(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('recovery review queue rows must be an array')

  const items = rows
    .map((row) => {
      const characterReviewSummary = buildCharacterReviewSummary(row)
      const inspectionReadiness = resolveInspectionReadiness(row)
      const reviewStatus = resolveReviewStatus(row, characterReviewSummary, inspectionReadiness)
      const releaseReadiness = normalizeReleaseReadiness(row, inspectionReadiness)
      const finalEditReadiness = resolveFinalEditReadiness({
        ...row,
        reviewStatus,
        releaseReadiness,
      })
      const reworkReasons = buildReworkReasons(row)
      const item = {
        ...row,
        characterReviewSummary,
        reviewStatus,
        inspectionReadiness,
        releaseReadiness,
        canPublishDirectly: releaseReadiness.canPublishDirectly,
        inspectionGuidance: resolveInspectionGuidance(row, inspectionReadiness),
        canStartManualReview: inspectionReadiness === 'ready',
        requiresReview: reviewStatus !== 'approved',
        reworkReasons,
      }
      return {
        ...item,
        finalEditReadiness,
        nextAction: resolveNextAction({
          reviewStatus,
          inspectionReadiness,
          finalEditReadiness,
        }),
        finalEditPlan: buildRecoveryVideoFinalEditPlan({
          videoId: item.id,
          storyboardId: item.storyboardId,
          sceneId: item.sceneId,
          sceneNo: item.sceneNo,
          shotNo: item.shotNo,
          durationSeconds: item.durationSeconds,
          finalEditReadiness,
        }),
      }
    })
    .sort((left, right) => {
      const priorityDifference = REVIEW_PRIORITY[left.reviewStatus] - REVIEW_PRIORITY[right.reviewStatus]
      if (priorityDifference !== 0) return priorityDifference

      const readinessDifference =
        INSPECTION_READINESS_PRIORITY[left.inspectionReadiness] -
        INSPECTION_READINESS_PRIORITY[right.inspectionReadiness]
      if (readinessDifference !== 0) return readinessDifference

      const leftTime = toTimestamp(
        left.reviewStatus === 'pending' ? left.createdAt : left.reviewedAt || left.createdAt,
      )
      const rightTime = toTimestamp(
        right.reviewStatus === 'pending' ? right.createdAt : right.reviewedAt || right.createdAt,
      )
      return leftTime - rightTime || Number(left.id || 0) - Number(right.id || 0)
    })

  return {
    summary: {
      total: items.length,
      pendingCount: items.filter((item) => item.reviewStatus === 'pending').length,
      reworkCount: items.filter((item) => item.reviewStatus === 'rework').length,
      approvedCount: items.filter((item) => item.reviewStatus === 'approved').length,
      finalEditRequiredCount: items.filter(
        (item) => item.releaseReadiness.status === 'needs-vertical-final-edit',
      ).length,
      publishFormatReadyCount: items.filter((item) => item.canPublishDirectly).length,
      readyForFinalEditCount: items.filter(
        (item) => item.finalEditReadiness.status === 'ready-for-final-edit',
      ).length,
      waitingManualReviewBeforeFinalEditCount: items.filter(
        (item) => item.finalEditReadiness.status === 'waiting-manual-review',
      ).length,
      finalEditBlockedCount: items.filter((item) =>
        ['needs-technical-check', 'blocked-by-rework'].includes(item.finalEditReadiness.status),
      ).length,
    },
    items,
  }
}
