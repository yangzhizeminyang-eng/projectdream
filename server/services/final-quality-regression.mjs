import { hasCompleteAudioHumanEvidence } from './final-quality-review.mjs'

const DEFAULT_REQUIRED_SAMPLE_COUNT = 10
const REGRESSION_INCLUDED_STATUSES = ['completed', 'failed']
const REGRESSION_EXCLUDED_STATUSES = ['canceled', 'queued', 'running']
const FINAL_QUALITY_REGRESSION_TAG_CONFIRMATION_TOKEN =
  'CONFIRM_FINAL_QUALITY_REGRESSION_TAGS'
const REQUIRED_COVERAGE_BUCKETS = [
  { key: 'empty-scene', label: '空镜头' },
  { key: 'single-character', label: '单人镜头' },
  { key: 'two-character', label: '双人镜头' },
  { key: 'dialogue', label: '对白镜头' },
  { key: 'narration', label: '旁白镜头' },
  { key: 'action', label: '动作镜头' },
]
const COVERAGE_TAG_ALIASES = new Map([
  ['empty', 'empty-scene'],
  ['empty_scene', 'empty-scene'],
  ['empty-scene', 'empty-scene'],
  ['no-character', 'empty-scene'],
  ['single', 'single-character'],
  ['single_character', 'single-character'],
  ['single-character', 'single-character'],
  ['one-character', 'single-character'],
  ['double', 'two-character'],
  ['two_character', 'two-character'],
  ['two-character', 'two-character'],
  ['dialogue', 'dialogue'],
  ['speech', 'dialogue'],
  ['narration', 'narration'],
  ['voiceover', 'narration'],
  ['action', 'action'],
  ['motion', 'action'],
])
const REVIEW_EVIDENCE_GAP_BUCKETS = [
  {
    code: 'human-review-decision-missing',
    label: '人工结论缺失',
    message: '还没有记录人工批准或返工结论。',
  },
  {
    code: 'visual-evidence-missing',
    label: '画面证据缺失',
    message: '缺少画面拉伸、黑边、跳帧、构图或人物表现的人工证据备注。',
  },
  {
    code: 'subtitle-evidence-missing',
    label: '字幕证据缺失',
    message: '缺少字幕准确性、错别字、时间轴或安全区的人工证据备注。',
  },
  {
    code: 'audio-evidence-missing',
    label: '音频证据缺失',
    message: '缺少对白清晰度、响度、爆音、对嘴或混音的人工证据备注。',
  },
  {
    code: 'character-consistency-evidence-missing',
    label: '人物一致性证据缺失',
    message: '缺少人物外貌、发型、服装、体型和同屏角色数量的一致性复核证据。',
  },
]
const REVIEW_EVIDENCE_GAP_BY_CODE = new Map(
  REVIEW_EVIDENCE_GAP_BUCKETS.map((bucket) => [bucket.code, bucket]),
)

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function roundMetric(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100
}

function parseDateMs(value) {
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? time : null
}

function normalizeExportId(value) {
  return Number(value?.id ?? value?.exportId ?? value?.export_id) || 0
}

function normalizeReportExportId(value) {
  return Number(value?.exportId ?? value?.export_id) || 0
}

function normalizeCostExportId(value) {
  return Number(value?.exportId ?? value?.export_id) || 0
}

function normalizeCoverageTag(value) {
  const key = String(value || '').trim().toLowerCase()
  return COVERAGE_TAG_ALIASES.get(key) || null
}

function resolveRegressionTags(exportRecord = {}) {
  const config = exportRecord.config || {}
  const rawTags = [
    ...(Array.isArray(config.regressionTags) ? config.regressionTags : []),
    ...(Array.isArray(config.finalQualityRegression?.tags)
      ? config.finalQualityRegression.tags
      : []),
  ]
  return [...new Set(rawTags.map(normalizeCoverageTag).filter(Boolean))]
}

export function normalizeFinalQualityRegressionTagUpdate(raw = {}) {
  if (
    raw.confirm !== true ||
    String(raw.confirmationToken || '').trim() !==
      FINAL_QUALITY_REGRESSION_TAG_CONFIRMATION_TOKEN
  ) {
    throw new Error('保存终剪回归标签前必须输入精确终剪回归标签确认口令')
  }
  const tags = [
    ...new Set(
      (Array.isArray(raw.tags) ? raw.tags : [])
        .map(normalizeCoverageTag)
        .filter(Boolean),
    ),
  ]
  if (tags.length === 0) {
    throw new Error('至少选择一个有效终剪回归覆盖类型')
  }
  return {
    tags,
    note: String(raw.note || '').trim() || null,
  }
}

function isTechnicalPassed(exportRecord = {}, report = null) {
  if (String(exportRecord.status || '').trim() !== 'completed') return false
  const technicalQuality = exportRecord.config?.technicalQuality || {}
  const technicalPassed =
    technicalQuality.status === 'passed' &&
    Array.isArray(technicalQuality.blockingIssues) &&
    technicalQuality.blockingIssues.length === 0
  return report?.automaticPassed === true || technicalPassed
}

function resolveTurnaroundSeconds(exportRecord = {}) {
  const startedAt = parseDateMs(exportRecord.createdAt ?? exportRecord.created_at)
  const finishedAt = parseDateMs(exportRecord.updatedAt ?? exportRecord.updated_at)
  if (startedAt === null || finishedAt === null || finishedAt < startedAt) return null
  return Math.round((finishedAt - startedAt) / 1000)
}

function collectReworkReasons({ exportRecord, report }) {
  const reasons = []
  if (report?.reviewDecision === 'rework' && report.reviewNote) {
    reasons.push({
      exportId: normalizeExportId(exportRecord),
      code: 'human-rework',
      message: String(report.reviewNote).trim(),
    })
  }

  const blockingIssues = Array.isArray(report?.automaticReport?.blockingIssues)
    ? report.automaticReport.blockingIssues
    : Array.isArray(exportRecord.config?.technicalQuality?.blockingIssues)
      ? exportRecord.config.technicalQuality.blockingIssues
      : []
  for (const issue of blockingIssues) {
    const message = String(issue?.message || '').trim()
    if (!message) continue
    reasons.push({
      exportId: normalizeExportId(exportRecord),
      code: String(issue?.code || 'automatic-quality-blocker'),
      message,
    })
  }
  return reasons
}

function resolveNextAction({ technicalPassed, reviewDecision, coverageTags }) {
  if (!technicalPassed) {
    return {
      code: 'resolve-technical-blocker',
      label: '先处理技术阻塞',
      message: '自动技术质检未通过，先排查规格、音频、黑边、对象可读性或导出失败原因。',
    }
  }
  if (reviewDecision === 'rework') {
    return {
      code: 'resolve-human-rework',
      label: '处理人工返工',
      message: '人工终审已要求返工，先修复备注中的画面、字幕、音频或节奏问题。',
    }
  }
  if (!reviewDecision) {
    return {
      code: 'complete-human-review',
      label: '完成人工复核',
      message: '技术检查已可用，但还缺画面、字幕、音频和人物一致性的人工判断。',
    }
  }
  if (!coverageTags.length) {
    return {
      code: 'add-coverage-tags',
      label: '补覆盖标签',
      message: '样本已通过人工结论，但还没有标记空镜、单人、双人、对白、旁白或动作覆盖类型。',
    }
  }
  return {
    code: 'regression-sample-ready',
    label: '样本已就绪',
    message: '技术、人工复核和覆盖标签均已具备，可用于 10 条终剪回归统计。',
  }
}

function hasReviewEvidence(
  checklist = {},
  evidenceKey,
  reviewedKey,
  legacyNoteKey,
  allowNotApplicable = false,
) {
  const evidence =
    checklist[evidenceKey] && typeof checklist[evidenceKey] === 'object'
      ? checklist[evidenceKey]
      : {}
  const reviewed = evidence.reviewed === true || checklist[reviewedKey] === true
  const notApplicable =
    allowNotApplicable &&
    (evidence.notApplicable === true ||
      checklist[`${reviewedKey.replace(/Reviewed$/, '')}NotApplicable`] === true)
  const note = String(evidence.note ?? checklist[legacyNoteKey] ?? '').trim()
  if (evidenceKey === 'audioEvidence' && !hasCompleteAudioHumanEvidence(checklist)) {
    return false
  }
  return (reviewed || notApplicable) && note.length > 0
}

function buildReviewEvidenceGaps(report = null) {
  const checklist = report?.reviewChecklist || {}
  const gaps = []
  if (!report?.reviewDecision) {
    gaps.push(REVIEW_EVIDENCE_GAP_BY_CODE.get('human-review-decision-missing'))
  }
  if (!hasReviewEvidence(checklist, 'visualEvidence', 'visualReviewed', 'visualNote')) {
    gaps.push(REVIEW_EVIDENCE_GAP_BY_CODE.get('visual-evidence-missing'))
  }
  if (!hasReviewEvidence(checklist, 'subtitleEvidence', 'subtitleReviewed', 'subtitleNote')) {
    gaps.push(REVIEW_EVIDENCE_GAP_BY_CODE.get('subtitle-evidence-missing'))
  }
  if (!hasReviewEvidence(checklist, 'audioEvidence', 'audioReviewed', 'audioNote')) {
    gaps.push(REVIEW_EVIDENCE_GAP_BY_CODE.get('audio-evidence-missing'))
  }
  if (
    !hasReviewEvidence(
      checklist,
      'characterConsistencyEvidence',
      'characterConsistencyReviewed',
      'characterConsistencyNote',
      true,
    )
  ) {
    gaps.push(REVIEW_EVIDENCE_GAP_BY_CODE.get('character-consistency-evidence-missing'))
  }
  return gaps.filter(Boolean)
}

function buildProductionReadiness({
  sampleCount,
  requiredSampleCount,
  missingSampleCount,
  missingCoverageBuckets,
  automaticPassedCount,
  approvedCount,
  reworkCount,
  missingReviewCount,
  reviewEvidenceGapCount,
}) {
  const blockers = []
  if (missingSampleCount > 0) {
    blockers.push({
      code: 'insufficient-regression-samples',
      message: `稳定生产验证样本不足：需要 ${requiredSampleCount} 条，当前只有 ${sampleCount} 条。`,
      count: missingSampleCount,
    })
  }
  if (missingCoverageBuckets.length > 0) {
    blockers.push({
      code: 'coverage-incomplete',
      message: `稳定生产验证覆盖不足：还缺 ${missingCoverageBuckets.map((item) => item.label).join('、')}。`,
      count: missingCoverageBuckets.length,
    })
  }
  if (automaticPassedCount < requiredSampleCount) {
    blockers.push({
      code: 'technical-pass-incomplete',
      message: `技术通过样本不足：需要 ${requiredSampleCount} 条，当前 ${automaticPassedCount} 条。`,
      count: Math.max(0, requiredSampleCount - automaticPassedCount),
    })
  }
  if (approvedCount < requiredSampleCount) {
    blockers.push({
      code: 'human-approval-incomplete',
      message: `人工批准样本不足：需要 ${requiredSampleCount} 条，当前 ${approvedCount} 条。`,
      count: Math.max(0, requiredSampleCount - approvedCount),
    })
  }
  if (reworkCount > 0) {
    blockers.push({
      code: 'human-rework-present',
      message: `仍有 ${reworkCount} 条样本要求返工，不能证明稳定生产。`,
      count: reworkCount,
    })
  }
  if (missingReviewCount > 0) {
    blockers.push({
      code: 'human-review-missing',
      message: `仍有 ${missingReviewCount} 条样本缺少人工复核。`,
      count: missingReviewCount,
    })
  }
  if (reviewEvidenceGapCount > 0) {
    blockers.push({
      code: 'human-review-evidence-incomplete',
      message: `仍有 ${reviewEvidenceGapCount} 项人工复核证据缺口，不能证明稳定生产。`,
      count: reviewEvidenceGapCount,
    })
  }

  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    ready: blockers.length === 0,
    requiredPassedSampleCount: requiredSampleCount,
    passedSampleCount: Math.min(automaticPassedCount, approvedCount),
    blockers,
  }
}

function buildCostSummary(costEntries, sampleCount) {
  const totalEstimatedCostByCurrency = {}
  let pricedEntryCount = 0
  let unpricedEntryCount = 0

  for (const entry of costEntries) {
    if (entry?.pricingStatus === 'unpriced' || entry?.estimatedCost === null) {
      unpricedEntryCount += 1
      continue
    }
    const amount = Number(entry?.estimatedCost)
    if (!Number.isFinite(amount)) {
      unpricedEntryCount += 1
      continue
    }
    pricedEntryCount += 1
    const currency = String(entry?.currency || 'CNY').trim() || 'CNY'
    totalEstimatedCostByCurrency[currency] =
      roundMetric((totalEstimatedCostByCurrency[currency] || 0) + amount)
  }

  const averageEstimatedCostByCurrency = {}
  for (const [currency, amount] of Object.entries(totalEstimatedCostByCurrency)) {
    averageEstimatedCostByCurrency[currency] =
      sampleCount > 0 ? roundMetric(amount / sampleCount) : 0
  }

  return {
    pricedEntryCount,
    unpricedEntryCount,
    totalEstimatedCostByCurrency,
    averageEstimatedCostByCurrency,
  }
}

export function buildFinalQualityRegressionReport({
  projectId,
  exports = [],
  qualityReports = [],
  costEntries = [],
  requiredSampleCount = DEFAULT_REQUIRED_SAMPLE_COUNT,
  excludedExportCount = null,
} = {}) {
  const normalizedExportInput = (Array.isArray(exports) ? exports : [])
    .filter((item) => normalizeExportId(item) > 0)
  const excludedExports = normalizedExportInput.filter(
    (item) => !REGRESSION_INCLUDED_STATUSES.includes(String(item.status || '').trim()),
  )
  const normalizedExports = normalizedExportInput
    .filter((item) => REGRESSION_INCLUDED_STATUSES.includes(String(item.status || '').trim()))
    .slice(0, Math.max(0, Number(requiredSampleCount) || DEFAULT_REQUIRED_SAMPLE_COUNT))
  const reportByExportId = new Map(
    (Array.isArray(qualityReports) ? qualityReports : [])
      .filter((item) => normalizeReportExportId(item) > 0)
      .map((item) => [normalizeReportExportId(item), item]),
  )
  const costsByExportId = new Map()
  for (const entry of Array.isArray(costEntries) ? costEntries : []) {
    const exportId = normalizeCostExportId(entry)
    if (!exportId) continue
    const list = costsByExportId.get(exportId) || []
    list.push(entry)
    costsByExportId.set(exportId, list)
  }

  let completedCount = 0
  let failedCount = 0
  let automaticPassedCount = 0
  let approvedCount = 0
  let reworkCount = 0
  let missingReviewCount = 0
  let characterConsistencyGapCount = 0
  let reviewEvidenceGapCount = 0
  const reviewEvidenceGapCounts = Object.fromEntries(
    REVIEW_EVIDENCE_GAP_BUCKETS.map((bucket) => [bucket.code, 0]),
  )
  const turnaroundSeconds = []
  const reworkReasons = []
  const sampledCostEntries = []
  const coverageCounts = Object.fromEntries(
    REQUIRED_COVERAGE_BUCKETS.map((bucket) => [bucket.key, 0]),
  )

  const items = normalizedExports.map((exportRecord) => {
    const exportId = normalizeExportId(exportRecord)
    const report = reportByExportId.get(exportId) || null
    const status = String(exportRecord.status || '').trim()
    const qualityGapCodes = []
    const technicalPassed = isTechnicalPassed(exportRecord, report)
    const reviewDecision = report?.reviewDecision || null
    const reviewEvidenceGaps = buildReviewEvidenceGaps(report)
    const sampleCosts = costsByExportId.get(exportId) || []
    const coverageTags = resolveRegressionTags(exportRecord)
    sampledCostEntries.push(...sampleCosts)
    for (const tag of coverageTags) {
      coverageCounts[tag] = (coverageCounts[tag] || 0) + 1
    }

    if (status === 'completed') completedCount += 1
    if (status === 'failed') failedCount += 1
    if (technicalPassed) automaticPassedCount += 1
    if (reviewDecision === 'approved') approvedCount += 1
    if (reviewDecision === 'rework') reworkCount += 1
    if (!report || !reviewDecision) missingReviewCount += 1

    if (!technicalPassed) qualityGapCodes.push('automatic-quality-blocked')
    if (reviewDecision === 'rework') qualityGapCodes.push('human-rework')
    if (!report || !reviewDecision) qualityGapCodes.push('human-review-missing')
    if (reviewEvidenceGaps.length > 0) {
      qualityGapCodes.push('human-review-evidence-incomplete')
      reviewEvidenceGapCount += reviewEvidenceGaps.length
      for (const gap of reviewEvidenceGaps) {
        reviewEvidenceGapCounts[gap.code] = (reviewEvidenceGapCounts[gap.code] || 0) + 1
      }
    }

    const checklist = report?.reviewChecklist || {}
    if (
      !hasReviewEvidence(
        checklist,
        'characterConsistencyEvidence',
        'characterConsistencyReviewed',
        'characterConsistencyNote',
        true,
      )
    ) {
      qualityGapCodes.push('character-consistency-unreviewed')
      characterConsistencyGapCount += 1
    }

    const turnaround = resolveTurnaroundSeconds(exportRecord)
    if (turnaround !== null) turnaroundSeconds.push(turnaround)

    reworkReasons.push(...collectReworkReasons({ exportRecord, report }))

    return {
      exportId,
      status,
      technicalPassed,
      reviewDecision,
      releaseStatus: report?.releaseStatus || null,
      turnaroundSeconds: turnaround,
      estimatedCostByCurrency: buildCostSummary(sampleCosts, 1).totalEstimatedCostByCurrency,
      qualityGapCodes,
      reviewEvidenceGaps,
      coverageTags,
      nextAction: resolveNextAction({ technicalPassed, reviewDecision, coverageTags }),
    }
  })

  const sampleCount = items.length
  const missingSampleCount = Math.max(0, requiredSampleCount - sampleCount)
  const hasExternalExcludedCount =
    excludedExportCount !== null &&
    excludedExportCount !== undefined &&
    excludedExportCount !== ''
  const normalizedExcludedExportCount = Number(excludedExportCount)
  const excludedCount = hasExternalExcludedCount &&
    Number.isFinite(normalizedExcludedExportCount)
    ? Math.max(0, Math.floor(normalizedExcludedExportCount))
    : excludedExports.length
  const coverageBuckets = REQUIRED_COVERAGE_BUCKETS.map((bucket) => ({
    ...bucket,
    count: coverageCounts[bucket.key] || 0,
    covered: (coverageCounts[bucket.key] || 0) > 0,
  }))
  const missingCoverageBuckets = coverageBuckets.filter((bucket) => !bucket.covered)
  const status =
    missingSampleCount > 0
      ? 'insufficient-samples'
      : missingCoverageBuckets.length > 0
        ? 'coverage-incomplete'
        : 'ready'
  const blockers = []
  if (missingSampleCount > 0) {
    blockers.push({
      code: 'insufficient-regression-samples',
      message: `终剪回归样本不足：需要 ${requiredSampleCount} 条，当前只有 ${sampleCount} 条。`,
      missingSampleCount,
    })
  } else if (missingCoverageBuckets.length > 0) {
    blockers.push({
      code: 'regression-coverage-incomplete',
      message: `终剪回归覆盖不足：还缺 ${missingCoverageBuckets.map((item) => item.label).join('、')}。`,
      missingBuckets: missingCoverageBuckets.map((item) => item.key),
    })
  }

  const averageTurnaroundSeconds =
    turnaroundSeconds.length > 0
      ? Math.round(turnaroundSeconds.reduce((sum, item) => sum + item, 0) / turnaroundSeconds.length)
      : null
  const productionReadiness = buildProductionReadiness({
    sampleCount,
    requiredSampleCount,
    missingSampleCount,
    missingCoverageBuckets,
    automaticPassedCount,
    approvedCount,
    reworkCount,
    missingReviewCount,
    reviewEvidenceGapCount,
  })

  return {
    projectId: Number(projectId) || 0,
    status,
    ready: status === 'ready',
    productionReadiness,
    summary: {
      requiredSampleCount,
      sampleCount,
      missingSampleCount,
      completedCount,
      failedCount,
      automaticPassedCount,
      approvedCount,
      reworkCount,
      missingReviewCount,
      characterConsistencyGapCount,
      reviewEvidenceGapCount,
      approvalRate: sampleCount > 0 ? roundMetric(approvedCount / sampleCount) : 0,
      automaticPassRate: sampleCount > 0 ? roundMetric(automaticPassedCount / sampleCount) : 0,
      averageTurnaroundSeconds,
    },
    sampleScope: {
      includedStatuses: [...REGRESSION_INCLUDED_STATUSES],
      excludedStatuses: [...REGRESSION_EXCLUDED_STATUSES],
      excludedCount,
    },
    cost: buildCostSummary(sampledCostEntries, sampleCount),
    coverage: {
      requiredCount: REQUIRED_COVERAGE_BUCKETS.length,
      coveredCount: coverageBuckets.filter((bucket) => bucket.covered).length,
      buckets: coverageBuckets,
      missingBuckets: missingCoverageBuckets,
    },
    reviewEvidence: {
      totalGapCount: reviewEvidenceGapCount,
      buckets: REVIEW_EVIDENCE_GAP_BUCKETS.map((bucket) => ({
        ...bucket,
        count: reviewEvidenceGapCounts[bucket.code] || 0,
        missing: (reviewEvidenceGapCounts[bucket.code] || 0) > 0,
      })),
    },
    reworkReasons: reworkReasons.sort((left, right) => {
      if (left.code === right.code) return left.exportId - right.exportId
      if (left.code === 'human-rework') return -1
      if (right.code === 'human-rework') return 1
      return left.exportId - right.exportId
    }),
    blockers,
    items,
  }
}
